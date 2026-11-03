#!/usr/bin/env python3
"""手下看板共用的小工具：北京时间、加锁追加事件、触发构建。

页面和构建脚本都只认规格 3.2 里的字段。结束状态用 success / failed / degraded，
不写 ok。
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")
HELPERS = Path("/home/box/shared/helpers")
MINIONS = ("codex", "hermes", "pi")
END_STATUSES = ("success", "failed", "degraded")
FAIL_KINDS = ("quota", "capacity", "timeout", "error", "cancelled", "unknown")
DEGRADED_TO = ("codex", "hermes", "pi", "grok_only", "higgsfield", "ask_human")
QUOTA_STATES = ("ok", "capacity", "quota_exhausted")

# 默认路径都可以用环境变量或命令行参数盖掉。
DEFAULT_EVENTS_DIR = Path(os.environ.get("MINION_EVENTS_DIR", str(HELPERS / "minion-events")))
DEFAULT_ROUTE_LOG = Path(os.environ.get("MINION_ROUTE_LOG", str(HELPERS / "route-log.tsv")))
DEFAULT_CODEX_STATUS = Path(os.environ.get("MINION_CODEX_STATUS", str(HELPERS / "codex-status.json")))
DEFAULT_CATALOG = Path(os.environ.get("MINION_CATALOG", str(HELPERS / "model-catalog.json")))


def board_root() -> Path:
    env = os.environ.get("MINION_BOARD_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent


def now_bj() -> datetime:
    """当前时刻，时区固定为北京。"""
    return datetime.now(BEIJING)


def iso_bj(dt: datetime) -> str:
    """格式化成 2026-11-03T08:42:10+08:00。先换算到北京时间。"""
    local = dt.astimezone(BEIJING)
    return local.strftime("%Y-%m-%dT%H:%M:%S") + "+08:00"


def parse_time(value) -> datetime | None:
    """解析两种时间：事件流的 ISO（带冒号时区），以及 route-log 的「空格 +0800」。

    没有时区就返回 None，调用方把这一行当成坏数据。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else None
    text = str(value).strip()
    if not text or text.lower() in {"null", "none"}:
        return None
    if text.endswith("Z") or _has_colon_tz(text):
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo is not None else None
    # 2026-10-31 09:34:36 +0800
    if len(text) >= 25 and text[-5] in "+-" and text[-5:-3].isdigit() and text[-3:].isdigit():
        # 时区四位数字，补上冒号再交给 fromisoformat
        head = text[:-5].strip().replace(" ", "T", 1)
        tz = text[-5:-2] + ":" + text[-2:]
        try:
            return datetime.fromisoformat(head + tz)
        except ValueError:
            return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _has_colon_tz(text: str) -> bool:
    return len(text) >= 6 and text[-3] == ":" and text[-6] in "+-"


def event_id(when: datetime | None = None) -> str:
    when = when or now_bj()
    return f"evt-{when.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"


def task_id(bot: str, when: datetime | None = None) -> str:
    when = when or now_bj()
    safe_bot = (bot or "na").lower()
    return f"tsk-{when.strftime('%Y%m%d')}-{when.strftime('%H%M%S')}-{safe_bot}-{secrets.token_hex(2)}"


def route_id(bot: str, when: datetime | None = None) -> str:
    when = when or now_bj()
    safe_bot = (bot or "na").lower()
    return f"rt-{when.strftime('%Y%m%d%H%M%S')}-{safe_bot}-{secrets.token_hex(1)}"


def clip_text(text: str, limit: int) -> str:
    """按字数截断，并去掉换行和制表符，避免把一行 JSON 撑破。"""
    cleaned = " ".join((text or "").replace("\t", " ").split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit]


def month_file(events_dir: Path, when: datetime) -> Path:
    local = when.astimezone(BEIJING)
    return events_dir / f"{local.strftime('%Y-%m')}.jsonl"


def append_event(event: dict, events_dir: Path | None = None) -> Path:
    """用 flock 锁住月文件，O_APPEND 追加一整行。不改旧行。"""
    events_dir = Path(events_dir or DEFAULT_EVENTS_DIR)
    events_dir.mkdir(parents=True, exist_ok=True)
    when = parse_time(event.get("ts"))
    if when is None:
        raise ValueError("事件缺少带时区的 ts")
    path = month_file(events_dir, when)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    # 控制单行体积。超长时先砍掉可缩短的说明字段。
    for key, limit in (("raw", 80), ("fail_text", 40), ("title", 20)):
        encoded = line.encode("utf-8")
        if len(encoded) + 1 <= 4000:
            break
        if key in event and isinstance(event[key], str):
            event[key] = event[key][:limit]
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    data = (line + "\n").encode("utf-8")
    if len(data) > 4000:
        raise ValueError("事件行超过 4000 字节")
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, data)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    return path


def base_event(kind: str, writer: str, when: datetime | None = None) -> dict:
    when = when or now_bj()
    return {
        "v": 1,
        "event_id": event_id(when),
        "kind": kind,
        "ts": iso_bj(when),
        "writer": (writer or "").lower(),
    }


def make_start(
    *,
    minion: str,
    bot: str,
    title: str,
    writer: str | None = None,
    task_id_value: str | None = None,
    when: datetime | None = None,
    task_type: str | None = None,
    route_ref: str | None = None,
    model: str | None = None,
    host: str | None = None,
    attempt: int | None = None,
    parent_task_id: str | None = None,
    expect_minutes: int | None = None,
    smoke: bool = False,
) -> dict:
    when = when or now_bj()
    event = base_event("start", writer or bot, when)
    event.update(
        {
            "task_id": task_id_value or task_id(bot, when),
            "minion": minion,
            "bot": bot.lower(),
            "title": clip_text(title, 40),
        }
    )
    _put_optional(event, "task_type", task_type)
    _put_optional(event, "route_ref", route_ref)
    _put_optional(event, "model", model)
    _put_optional(event, "host", host)
    if attempt not in (None, 1):
        event["attempt"] = int(attempt)
    _put_optional(event, "parent_task_id", parent_task_id)
    if expect_minutes is not None:
        event["expect_minutes"] = int(expect_minutes)
    if smoke:
        event["smoke"] = True
    return event


def make_end(
    *,
    task_id_value: str,
    minion: str,
    status: str,
    writer: str,
    when: datetime | None = None,
    degraded_to: str | None = None,
    fail_kind: str | None = None,
    fail_text: str | None = None,
    exit_code: int | None = None,
) -> dict:
    if status not in END_STATUSES:
        raise ValueError(f"不认识的结束状态：{status}")
    event = base_event("end", writer, when)
    event.update(
        {
            "task_id": task_id_value,
            "minion": minion,
            "status": status,
        }
    )
    if status == "degraded":
        if not degraded_to:
            raise ValueError("降级结束必须带 degraded_to")
        event["degraded_to"] = degraded_to
    if status in ("failed", "degraded"):
        event["fail_kind"] = fail_kind or "unknown"
    if fail_text:
        event["fail_text"] = clip_text(fail_text, 120)
    if exit_code is not None:
        event["exit_code"] = int(exit_code)
    return event


def make_quota(
    *,
    state: str,
    writer: str,
    when: datetime | None = None,
    reset_at: str | None = None,
    raw: str | None = None,
) -> dict:
    if state not in QUOTA_STATES:
        raise ValueError(f"不认识的额度状态：{state}")
    event = base_event("quota", writer, when)
    event["minion"] = "codex"
    event["state"] = state
    if reset_at:
        parsed = parse_time(reset_at)
        event["reset_at"] = iso_bj(parsed) if parsed else None
    else:
        event["reset_at"] = None
    if raw:
        event["raw"] = clip_text(raw, 200)
    return event


def _put_optional(event: dict, key: str, value) -> None:
    if value is None:
        return
    text = str(value).strip()
    if text:
        event[key] = text


def detect_codex_issue(text: str) -> str | None:
    """从手下输出里认出 Codex 的额度用完或容量满。

    返回 quota_exhausted、capacity，或者 None。
    """
    lowered = (text or "").lower()
    if "at capacity" in lowered or "turn_rate_limit_exceeded" in lowered:
        return "capacity"
    quota_bits = (
        "you've hit your usage limit",
        "you've hit your codex usage limit",
        "openai rate/usage limit",
        "usage limit",
        "rate limit",
        "quota exceeded",
        "quota_exhausted",
    )
    if any(bit in lowered for bit in quota_bits):
        return "quota_exhausted"
    # 「try again」单独出现太宽，必须同时能看出是额度/限制。
    if "try again" in lowered and any(bit in lowered for bit in ("limit", "quota", "codex")):
        return "quota_exhausted"
    return None


def guess_reset_at(text: str, when: datetime | None = None) -> str | None:
    """尽量从「Try again at 1:00 PM」或正文里的 ISO 时间猜恢复时刻。"""
    when = when or now_bj()
    iso_match = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})", text or "")
    if iso_match:
        parsed = parse_time(iso_match.group(0))
        if parsed:
            return iso_bj(parsed)
    clock = re.search(
        r"try again at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(a\.?m\.?|p\.?m\.?)?",
        text or "",
        flags=re.IGNORECASE,
    )
    if not clock:
        return None
    hour = int(clock.group(1))
    minute = int(clock.group(2) or 0)
    ampm = (clock.group(3) or "").lower().replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if not ampm and hour <= 12:
        # 没有上午/下午时，不猜，避免把普通数字当成恢复时间。
        return None
    candidate = when.astimezone(BEIJING).replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= when.astimezone(BEIJING):
        candidate = candidate + timedelta(days=1)
    return iso_bj(candidate)


def trigger_build(events_dir: Path | None = None, refresh_mode: str | None = None) -> None:
    """写完事件马上构建一次。构建脚本自己会排队，所以这里不跳过。"""
    script = Path(__file__).resolve().with_name("build_snapshot.py")
    if not script.exists():
        return
    cmd = [sys.executable, str(script)]
    if events_dir:
        cmd.extend(["--events-dir", str(events_dir)])
    if os.environ.get("MINION_ROUTE_LOG"):
        cmd.extend(["--route-log", os.environ["MINION_ROUTE_LOG"]])
    if os.environ.get("MINION_CODEX_STATUS"):
        cmd.extend(["--codex-status", os.environ["MINION_CODEX_STATUS"]])
    if os.environ.get("MINION_CATALOG"):
        cmd.extend(["--catalog", os.environ["MINION_CATALOG"]])
    out = os.environ.get("MINION_OUT_DIR")
    if out:
        cmd.extend(["--out-dir", out])
    if refresh_mode:
        cmd.extend(["--refresh-mode", refresh_mode])
    subprocess.run(cmd, check=False)


def read_text_lines(path: Path) -> tuple[list[str], int]:
    """读文本。最后一行如果没有换行，算不完整，不返回它。"""
    if not path.exists():
        return [], 0
    raw = path.read_bytes()
    if not raw:
        return [], 0
    text = raw.decode("utf-8", errors="replace")
    incomplete = 0
    if not text.endswith("\n"):
        text, sep, _tail = text.rpartition("\n")
        incomplete = 1
        if not sep:
            return [], incomplete
    lines = text.split("\n")
    # split 在末尾换行时会多一个空字符串
    if lines and lines[-1] == "":
        lines.pop()
    return lines, incomplete


def file_mtime_iso(path: Path) -> str | None:
    if not path.exists():
        return None
    return iso_bj(datetime.fromtimestamp(path.stat().st_mtime, timezone.utc))


def acquire_build_lock(out_dir: Path):
    """拿到构建锁。别的构建正在跑时就排队等，不丢这次。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = out_dir / ".build.lock"
    handle = open(lock_path, "a+", encoding="utf-8")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    return handle


def release_build_lock(handle) -> None:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()
