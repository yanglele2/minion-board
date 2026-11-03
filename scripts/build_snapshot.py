#!/usr/bin/env python3
"""把事件流、旧路由日志和 Codex 状态折成看板快照。

写出两份内容相同的文件：
- data/board-data.js    页面只读这个，里面是 window.__MINION_BOARD__ = {...}
- data/board-data.json  给人看，页面不读

先写临时文件再 rename，避免页面读到写了一半的内容。
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import minion_lib as lib

STUCK_MINUTES = {"codex": 45, "hermes": 30, "pi": 20}
NO_END_HOURS = 6
KEEP_DAYS = 30
QUOTA_HISTORY = 50

# catalog id / harness → 手下。不是手下的执行者映射成 None。
FALLBACK_MINION = {
    "codex": "codex",
    "hermes": "hermes",
    "hermes-default": "hermes",
    "pi": "pi",
    "pi-deepseek-flash": "pi",
    "hr-pi-deepseek-v41-flash": "pi",
    "grok_only": None,
    "grok": None,
    "higgsfield": None,
    "ask_human": None,
    "human": None,
}

LABELS = {
    "codex": "Codex",
    "hermes": "Hermes",
    "pi": "pi",
    "grok_only": "Grok Bot",
    "grok": "Grok Bot",
    "higgsfield": "Higgsfield",
    "ask_human": "老板",
    "human": "老板",
    "pi-deepseek-flash": "pi",
    "hr-pi-deepseek-v41-flash": "pi",
    "hermes-default": "Hermes",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建手下看板快照")
    parser.add_argument("--events-dir", default=str(lib.DEFAULT_EVENTS_DIR))
    parser.add_argument("--route-log", default=str(lib.DEFAULT_ROUTE_LOG))
    parser.add_argument("--codex-status", default=str(lib.DEFAULT_CODEX_STATUS))
    parser.add_argument("--catalog", default=str(lib.DEFAULT_CATALOG))
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--refresh-mode", choices=("watch", "on_write", "auto"), default="auto")
    parser.add_argument("--watch", type=int, default=0, help="每 N 秒构建一次，0 表示只构建一次")
    parser.add_argument("--now", default="", help="测试用的当前时间，ISO，需带时区")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir) if args.out_dir else lib.board_root() / "data"
    if args.watch:
        _run_watch(args, out_dir)
        return 0
    when = lib.parse_time(args.now) if args.now else lib.now_bj()
    if args.now and when is None:
        print("打不开 --now，需要带时区的时间", file=sys.stderr)
        return 2
    build_once(
        events_dir=Path(args.events_dir),
        route_log=Path(args.route_log),
        codex_status=Path(args.codex_status),
        catalog=Path(args.catalog),
        out_dir=out_dir,
        refresh_mode=args.refresh_mode,
        when=when or lib.now_bj(),
    )
    return 0


def _run_watch(args, out_dir: Path) -> None:
    """常驻构建。和 heartbeat.sh 用同一把锁，避免开两份。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = out_dir / "heartbeat.lock"
    handle = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("心跳已在运行，这次不再另开。", file=sys.stderr)
        return
    try:
        while True:
            stamp = out_dir / "heartbeat.stamp"
            stamp.write_text(lib.iso_bj(lib.now_bj()) + "\n", encoding="utf-8")
            build_once(
                events_dir=Path(args.events_dir),
                route_log=Path(args.route_log),
                codex_status=Path(args.codex_status),
                catalog=Path(args.catalog),
                out_dir=out_dir,
                refresh_mode="watch",
                when=lib.now_bj(),
            )
            time.sleep(max(1, args.watch))
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def build_once(
    *,
    events_dir: Path,
    route_log: Path,
    codex_status: Path,
    catalog: Path,
    out_dir: Path,
    refresh_mode: str,
    when: datetime,
) -> dict:
    lock = lib.acquire_build_lock(out_dir)
    try:
        mode = _resolve_mode(refresh_mode, out_dir)
        payload = assemble(
            events_dir=events_dir,
            route_log=route_log,
            codex_status=codex_status,
            catalog=catalog,
            out_dir=out_dir,
            refresh_mode=mode,
            when=when,
        )
        _write_outputs(out_dir, payload)
        return payload
    finally:
        lib.release_build_lock(lock)


def _resolve_mode(refresh_mode: str, out_dir: Path) -> str:
    if refresh_mode in ("watch", "on_write"):
        return refresh_mode
    stamp = out_dir / "heartbeat.stamp"
    if stamp.exists():
        age = time.time() - stamp.stat().st_mtime
        if age < 45:
            return "watch"
    return "on_write"


def assemble(
    *,
    events_dir: Path,
    route_log: Path,
    codex_status: Path,
    catalog: Path,
    out_dir: Path,
    refresh_mode: str,
    when: datetime,
) -> dict:
    built_at = lib.iso_bj(when)
    catalog_index = _load_catalog(catalog)
    health = {
        "bad_lines": 0,
        "dup_events": 0,
        "conflicts": 0,
        "clock_skew": 0,
        "legacy_rows": 0,
        "unmatched_routes": 0,
        "log_mark_inconsistent": 0,
        "missing_why": 0,
        "mismatch": 0,
    }
    sources = []
    events, event_sources = _load_events(events_dir, when, health)
    sources.extend(event_sources)
    legacy, legacy_source = _load_route_log(route_log, catalog_index, health)
    sources.append(legacy_source)
    status, status_source = _load_codex_status(codex_status)
    sources.append(status_source)
    sources.append(_source_row(catalog, kind="catalog"))

    tasks, quotas = _fold_events(events, when, health)
    _link_routes(tasks, legacy, health)
    tasks = _keep_recent(tasks, when)
    quotas = quotas[-QUOTA_HISTORY:]
    current = _pick_quota(quotas, status)

    seq = _next_seq(out_dir)
    minions = []
    for name in ("codex", "hermes", "pi"):
        minions.append(_minion_summary(name, tasks, when))
    longest = _today_longest(tasks, when)

    return {
        "schema": 1,
        "built_at": built_at,
        "refresh_mode": refresh_mode,
        "watch_interval_s": 30,
        "sources": sources,
        "minions": minions,
        "tasks": tasks,
        "today_longest": longest,
        "codex_quota": {"current": current, "history": quotas[-QUOTA_HISTORY:]},
        "legacy_routes": legacy,
        "health": health,
        "seq": seq,
    }


def _load_catalog(path: Path) -> dict:
    index = dict(FALLBACK_MINION)
    if not path.exists():
        return index
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return index
    for opt in data.get("options") or []:
        ident = opt.get("id")
        harness = (opt.get("harness") or "").lower()
        if not ident:
            continue
        if harness in ("codex", "hermes", "pi"):
            index[ident] = harness
            index[harness] = harness
        else:
            index[ident] = None
    return index


def _source_row(path: Path, kind: str, lines: int | None = None) -> dict:
    exists = path.exists()
    return {
        "kind": kind,
        "path": str(path),
        "exists": exists,
        "mtime": lib.file_mtime_iso(path) if exists else None,
        "lines": lines if lines is not None else (0 if not exists else None),
    }


def _month_names(when: datetime) -> list[str]:
    local = when.astimezone(lib.BEIJING)
    prev = (local.replace(day=1) - timedelta(days=1))
    names = [local.strftime("%Y-%m"), prev.strftime("%Y-%m")]
    # 去重（理论上不会重复）
    out = []
    for name in names:
        if name not in out:
            out.append(name)
    return out


def _load_events(events_dir: Path, when: datetime, health: dict) -> tuple[list[dict], list[dict]]:
    sources = []
    found: list[tuple[datetime, int, dict]] = []
    seen_ids: set[str] = set()
    if not events_dir.exists():
        sources.append(
            {
                "kind": "events",
                "path": str(events_dir),
                "exists": False,
                "mtime": None,
                "lines": 0,
            }
        )
        return [], sources
    order = 0
    for name in _month_names(when):
        path = events_dir / f"{name}.jsonl"
        lines, incomplete = lib.read_text_lines(path)
        health["bad_lines"] += incomplete
        parsed = 0
        for line in lines:
            if not line.strip():
                continue
            parsed += 1
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                health["bad_lines"] += 1
                continue
            if not _valid_event(obj):
                health["bad_lines"] += 1
                continue
            eid = obj["event_id"]
            if eid in seen_ids:
                health["dup_events"] += 1
                continue
            seen_ids.add(eid)
            ts = lib.parse_time(obj["ts"])
            assert ts is not None
            if ts > when + timedelta(minutes=5):
                health["clock_skew"] += 1
            order += 1
            found.append((ts, order, obj))
        sources.append(_source_row(path, "events", parsed if path.exists() else 0))
    found.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in found], sources


def _valid_event(obj: dict) -> bool:
    if not isinstance(obj, dict):
        return False
    if obj.get("v") != 1:
        return False
    if obj.get("kind") not in ("start", "end", "quota"):
        return False
    if not obj.get("event_id") or not obj.get("writer"):
        return False
    if lib.parse_time(obj.get("ts")) is None:
        return False
    kind = obj["kind"]
    minion = obj.get("minion")
    if kind == "quota":
        return minion == "codex" and obj.get("state") in lib.QUOTA_STATES
    if minion not in lib.MINIONS:
        return False
    if kind == "start":
        return bool(obj.get("task_id") and obj.get("bot") and obj.get("title"))
    status = obj.get("status")
    # 读到旧稿里的 ok 时当成 success，但自己不写 ok。
    if status == "ok":
        obj["status"] = "success"
        status = "success"
    if not obj.get("task_id") or status not in lib.END_STATUSES:
        return False
    if status in ("failed", "degraded") and obj.get("fail_kind") not in lib.FAIL_KINDS:
        return False
    if status == "degraded" and obj.get("degraded_to") not in lib.DEGRADED_TO:
        return False
    return True


def _fold_events(events: list[dict], when: datetime, health: dict) -> tuple[list[dict], list[dict]]:
    tasks: dict[str, dict] = {}
    order: list[str] = []
    quotas: list[dict] = []
    for event in events:
        if event["kind"] == "quota":
            quotas.append(_quota_view(event))
            continue
        tid = event["task_id"]
        if event["kind"] == "start":
            if tid in tasks:
                health["conflicts"] += 1
                if tasks[tid].get("missing_start"):
                    _apply_start(tasks[tid], event)
                continue
            tasks[tid] = _new_task_from_start(event)
            order.append(tid)
            continue
        # end
        if tid not in tasks:
            tasks[tid] = _new_task_from_end_only(event)
            order.append(tid)
            _apply_end(tasks[tid], event, health, missing_start=True)
            continue
        _apply_end(tasks[tid], event, health, missing_start=False)
    views = [tasks[tid] for tid in order]
    for view in views:
        view["threshold_s"] = _threshold_s(view)
    return views, quotas


def _new_task_from_start(event: dict) -> dict:
    task = _blank_task(event["task_id"], event["minion"])
    _apply_start(task, event)
    return task


def _apply_start(task: dict, event: dict) -> None:
    task["minion"] = event["minion"]
    task["bot"] = str(event.get("bot") or "").lower()
    task["title"] = event.get("title") or task["title"]
    task["task_type"] = event.get("task_type") or ""
    task["route_ref"] = event.get("route_ref") or ""
    task["model"] = event.get("model") or ""
    task["host"] = event.get("host") or ""
    task["attempt"] = int(event.get("attempt") or 1)
    task["parent_task_id"] = event.get("parent_task_id") or ""
    task["expect_minutes"] = event.get("expect_minutes")
    task["smoke"] = bool(event.get("smoke")) or _is_smoke(task["bot"], task["task_type"])
    task["started_at"] = event["ts"]
    task["start_event_id"] = event["event_id"]
    task["writer"] = event.get("writer") or ""
    task["missing_start"] = False


def _new_task_from_end_only(event: dict) -> dict:
    task = _blank_task(event["task_id"], event["minion"])
    task["title"] = "（没有开始记录）"
    task["bot"] = ""
    task["missing_start"] = True
    task["smoke"] = False
    return task


def _blank_task(tid: str, minion: str) -> dict:
    return {
        "task_id": tid,
        "minion": minion,
        "bot": "",
        "title": "",
        "task_type": "",
        "route_ref": "",
        "model": "",
        "host": "",
        "attempt": 1,
        "parent_task_id": "",
        "expect_minutes": None,
        "smoke": False,
        "started_at": None,
        "ended_at": None,
        "status": "running",
        "fail_kind": None,
        "fail_text": None,
        "exit_code": None,
        "degraded_to": None,
        "start_event_id": None,
        "end_event_id": None,
        "end_count": 0,
        "conflict": False,
        "missing_start": False,
        "writer": "",
        "route_match": {"kind": "none", "count": 0, "note": "没找到对应路由", "route": None},
        "threshold_s": STUCK_MINUTES.get(minion, 30) * 60,
    }


def _apply_end(task: dict, event: dict, health: dict, missing_start: bool) -> None:
    task["end_count"] = int(task.get("end_count") or 0) + 1
    if task["end_count"] > 1:
        health["conflicts"] += 1
        task["conflict"] = True
        previous = lib.parse_time(task.get("ended_at"))
        incoming = lib.parse_time(event["ts"])
        # 同一任务有多条结束时，只认最早的那条。
        if previous and incoming and incoming >= previous:
            return
    if not task.get("minion"):
        task["minion"] = event["minion"]
    task["ended_at"] = event["ts"]
    task["status"] = event["status"]
    task["fail_kind"] = event.get("fail_kind")
    task["fail_text"] = event.get("fail_text")
    task["exit_code"] = event.get("exit_code")
    task["degraded_to"] = event.get("degraded_to")
    task["end_event_id"] = event["event_id"]
    start = lib.parse_time(task.get("started_at"))
    end = lib.parse_time(event["ts"])
    if start and end and end < start:
        health["conflicts"] += 1
        task["conflict"] = True
    if missing_start:
        task["missing_start"] = True
        task["title"] = "（没有开始记录）"


def _threshold_s(task: dict) -> int:
    expect = task.get("expect_minutes")
    if isinstance(expect, int) and expect > 0:
        return int(expect * 1.5 * 60)
    return STUCK_MINUTES.get(task["minion"], 30) * 60


def _quota_view(event: dict) -> dict:
    return {
        "event_id": event["event_id"],
        "ts": event["ts"],
        "state": event["state"],
        "reset_at": event.get("reset_at"),
        "raw": event.get("raw") or "",
        "bot": event.get("writer") or "",
    }


def _keep_recent(tasks: list[dict], when: datetime) -> list[dict]:
    cutoff = when - timedelta(days=KEEP_DAYS)
    kept = []
    for task in tasks:
        stamp = lib.parse_time(task.get("ended_at") or task.get("started_at"))
        if stamp is None or stamp >= cutoff:
            kept.append(task)
    return kept


def _pick_quota(quotas: list[dict], status: dict | None) -> dict:
    latest = quotas[-1] if quotas else None
    status_at = lib.parse_time(status.get("updated_at")) if status else None
    if latest and status and status_at:
        latest_at = lib.parse_time(latest["ts"])
        if latest_at and status_at > latest_at:
            return _status_as_current(status)
        return _event_as_current(latest)
    if latest:
        return _event_as_current(latest)
    if status:
        return _status_as_current(status)
    return {
        "state": None,
        "reset_at": None,
        "source": "unknown",
        "updated_at": None,
        "time_unknown": True,
        "raw": "",
        "bot": "",
    }


def _event_as_current(event: dict) -> dict:
    return {
        "state": event["state"],
        "reset_at": event.get("reset_at"),
        "source": "quota_event",
        "updated_at": event["ts"],
        "time_unknown": False,
        "raw": event.get("raw") or "",
        "bot": event.get("bot") or "",
    }


def _status_as_current(status: dict) -> dict:
    unknown = status.get("updated_at") in (None, "")
    return {
        "state": status.get("state") or "ok",
        "reset_at": status.get("reset_at"),
        "source": "codex_status",
        "updated_at": status.get("updated_at"),
        "time_unknown": unknown,
        "raw": status.get("raw") or "",
        "bot": status.get("bot") or "",
    }


def _load_codex_status(path: Path) -> tuple[dict | None, dict]:
    source = _source_row(path, "codex_status", 0)
    if not path.exists():
        return None, source
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        source["lines"] = 0
        return None, source
    source["lines"] = 1
    updated = data.get("updated_at")
    parsed = lib.parse_time(updated) if updated else None
    reset = lib.parse_time(data.get("reset_at_beijing")) if data.get("reset_at_beijing") else None
    return (
        {
            "state": data.get("state") or "ok",
            "reset_at": lib.iso_bj(reset) if reset else None,
            "updated_at": lib.iso_bj(parsed) if parsed else None,
            "raw": data.get("raw_error") or "",
            "bot": data.get("source_bot") or "",
        },
        source,
    )


def _load_route_log(path: Path, catalog_index: dict, health: dict) -> tuple[list[dict], dict]:
    lines, incomplete = lib.read_text_lines(path)
    health["legacy_rows"] += incomplete
    source = _source_row(path, "route_log", 0)
    if not path.exists():
        return [], source
    rows = []
    data_lines = 0
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        if index == 0 and line.startswith("beijing_time"):
            continue
        data_lines += 1
        cols = line.split("\t")
        if len(cols) < 7:
            health["legacy_rows"] += 1
            continue
        parsed = _parse_route_row(cols, catalog_index)
        if parsed is None:
            health["legacy_rows"] += 1
            continue
        rows.append(parsed)
        if parsed["inconsistent_mark"]:
            health["log_mark_inconsistent"] += 1
        if parsed["why_missing"]:
            health["missing_why"] += 1
        if parsed["mismatch"]:
            health["mismatch"] += 1
    source["lines"] = data_lines
    return rows, source


def _parse_route_row(cols: list[str], catalog_index: dict) -> dict | None:
    ts = lib.parse_time(cols[0])
    if ts is None:
        return None
    notes = cols[6]
    actual = _token(notes, "actual")
    why = _why(notes)
    route = _token(notes, "route_id")
    choice_id = cols[3]
    confidence = _confidence(cols[4])
    flag = _has_token(notes, "mismatch")
    choice_minion = _to_minion(choice_id, catalog_index)
    actual_minion = _to_minion(actual, catalog_index) if actual else None
    raw_differ = bool(actual) and actual != choice_id
    minion_differ = bool(choice_minion and actual_minion and choice_minion != actual_minion)
    mismatch = raw_differ or minion_differ
    inconsistent = (flag and not raw_differ) or (raw_differ and not flag)
    bot = cols[1].strip()
    task_type = cols[2].strip()
    return {
        "ts": lib.iso_bj(ts),
        "beijing_time": cols[0].strip(),
        "bot": bot,
        "task_type": task_type,
        "choice_id": choice_id,
        "choice_minion": choice_minion,
        "choice_label": _label(choice_id, choice_minion),
        "actual": actual,
        "actual_minion": actual_minion,
        "actual_label": _label(actual, actual_minion) if actual else "",
        "confidence": confidence,
        "why": "" if why == "MISSING" else why,
        "why_missing": why == "MISSING",
        "route_id": route,
        "mismatch": mismatch,
        "log_mismatch_flag": flag,
        "inconsistent_mark": inconsistent,
        "smoke": _is_smoke(bot, task_type),
        "mode": "shadow" if notes.startswith("shadow") else "route",
    }


def _token(notes: str, key: str) -> str:
    match = re.search(rf"(?:^|\s){key}=(\S+)", notes)
    return match.group(1) if match else ""


def _why(notes: str) -> str:
    match = re.search(r"(?:^|\s)why=(.*)$", notes)
    return match.group(1).strip() if match else ""


def _has_token(notes: str, token: str) -> bool:
    return token in notes.split()


def _confidence(text: str):
    text = (text or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _to_minion(ident: str, catalog_index: dict):
    if not ident:
        return None
    if ident in catalog_index:
        return catalog_index[ident]
    return FALLBACK_MINION.get(ident, None)


def _label(ident: str, minion) -> str:
    if minion in LABELS:
        return LABELS[minion]
    if ident in LABELS:
        return LABELS[ident]
    return ident or ""


def _is_smoke(bot: str, task_type: str) -> bool:
    bot_l = (bot or "").lower()
    type_l = (task_type or "").lower()
    return bot_l in {"test", "eggbot"} or type_l.startswith("smoke")


def _link_routes(tasks: list[dict], routes: list[dict], health: dict) -> None:
    by_id = {}
    for route in routes:
        if route.get("route_id"):
            by_id.setdefault(route["route_id"], route)
    for task in tasks:
        ref = task.get("route_ref") or ""
        if ref:
            found = by_id.get(ref)
            if found:
                task["route_match"] = {
                    "kind": "ref",
                    "count": 1,
                    "note": "",
                    "route": found,
                }
                continue
            task["route_match"] = {
                "kind": "none",
                "count": 0,
                "note": "没找到对应路由",
                "route": None,
            }
            health["unmatched_routes"] += 1
            continue
        start = lib.parse_time(task.get("started_at"))
        if start is None or not task.get("bot"):
            task["route_match"] = {
                "kind": "none",
                "count": 0,
                "note": "没找到对应路由",
                "route": None,
            }
            # 没有 bot 或没有开始时间时，不算「对不上」，避免只有结束记录的任务被误计。
            if task.get("bot") and task.get("started_at"):
                health["unmatched_routes"] += 1
            continue
        window_start = start - timedelta(minutes=10)
        hits = []
        for route in routes:
            if route["bot"] != task["bot"]:
                continue
            if (route.get("task_type") or "") != (task.get("task_type") or ""):
                continue
            rts = lib.parse_time(route["ts"])
            if rts is None:
                continue
            if window_start <= rts <= start:
                hits.append(route)
        if len(hits) == 1:
            task["route_match"] = {
                "kind": "guess",
                "count": 1,
                "note": "按时间推测对应这条路由，不一定准",
                "route": hits[0],
            }
        elif len(hits) == 0:
            task["route_match"] = {
                "kind": "none",
                "count": 0,
                "note": "没找到对应路由",
                "route": None,
            }
            health["unmatched_routes"] += 1
        else:
            task["route_match"] = {
                "kind": "ambiguous",
                "count": len(hits),
                "note": f"有 {len(hits)} 条可能的路由，没法确定",
                "route": None,
            }
            health["unmatched_routes"] += 1


def _minion_summary(name: str, tasks: list[dict], when: datetime) -> dict:
    own = [task for task in tasks if task["minion"] == name and not task["smoke"]]
    today = _count_today(own, when)
    return {
        "id": name,
        "name": LABELS[name],
        "nickname": {"codex": "扣扣", "hermes": "赫米", "pi": "派派"}[name],
        "today": today,
        "median_7d_s": _median_7d(own, when),
        "ever": any(True for _task in own),
    }


def _count_today(tasks: list[dict], when: datetime) -> dict:
    start = _day_start(when)
    counts = Counter()
    for task in tasks:
        end = lib.parse_time(task.get("ended_at"))
        if end is None or end < start or end > when + timedelta(minutes=5):
            continue
        if task["status"] in ("success", "failed", "degraded"):
            counts[task["status"]] += 1
    return {
        "success": counts["success"],
        "failed": counts["failed"],
        "degraded": counts["degraded"],
    }


def _median_7d(tasks: list[dict], when: datetime) -> int | None:
    cutoff = when - timedelta(days=7)
    durations = []
    for task in tasks:
        if task["status"] != "success":
            continue
        start = lib.parse_time(task.get("started_at"))
        end = lib.parse_time(task.get("ended_at"))
        if not start or not end or end < start or end < cutoff:
            continue
        durations.append(int((end - start).total_seconds()))
    if len(durations) < 5:
        return None
    durations.sort()
    mid = len(durations) // 2
    if len(durations) % 2:
        return durations[mid]
    return int((durations[mid - 1] + durations[mid]) / 2)


def _today_longest(tasks: list[dict], when: datetime) -> dict | None:
    start = _day_start(when)
    best = None
    best_s = -1
    for task in tasks:
        if task.get("smoke"):
            continue
        if task.get("conflict") and task.get("started_at") and task.get("ended_at"):
            s = lib.parse_time(task["started_at"])
            e = lib.parse_time(task["ended_at"])
            if s and e and e < s:
                continue
        end = lib.parse_time(task.get("ended_at"))
        begin = lib.parse_time(task.get("started_at"))
        if not end or not begin or end < begin or end < start:
            continue
        seconds = int((end - begin).total_seconds())
        if seconds > best_s:
            best_s = seconds
            best = {
                "task_id": task["task_id"],
                "title": task["title"],
                "minion": task["minion"],
                "duration_s": seconds,
            }
    return best


def _day_start(when: datetime) -> datetime:
    local = when.astimezone(lib.BEIJING)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def _next_seq(out_dir: Path) -> int:
    path = out_dir / "seq.txt"
    current = 0
    if path.exists():
        try:
            current = int(path.read_text(encoding="utf-8").strip() or "0")
        except ValueError:
            current = 0
    nxt = current + 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(nxt) + "\n", encoding="utf-8")
    return nxt


def _write_outputs(out_dir: Path, payload: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    text = text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    js = "window.__MINION_BOARD__ = " + text + ";\n"
    _atomic(out_dir / "board-data.json", text + "\n")
    _atomic(out_dir / "board-data.js", js)


def _atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


if __name__ == "__main__":
    sys.exit(main())
