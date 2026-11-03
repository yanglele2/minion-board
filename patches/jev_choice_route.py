#!/usr/bin/env python3
"""Filter model-catalog + codex-status, optionally ask Jev Choice, print JSON.

Usage:
  python3 /home/box/shared/helpers/jev_choice_route.py --task "..." [--tags code,copy] [--shadow] [--no-jev]
  python3 ... --record-codex-error "You've hit..." --reset-at-beijing "..." --bot T06
Env: AI_GATEWAY_API_KEY and/or TYPESAFE_API_KEY
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / "model-catalog.json"
CODEX = ROOT / "codex-status.json"
LOG = ROOT / "route-log.tsv"
BEIJING = ZoneInfo("Asia/Shanghai")


def now_beijing() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M:%S %z")


def load_json(path: Path):
    return json.loads(path.read_text())


def parse_exhausted(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BEIJING)
        return dt
    except Exception:
        return datetime.now(timezone.utc)


def available_options(tags):
    catalog = load_json(CATALOG)
    status = load_json(CODEX) if CODEX.exists() else {"state": "ok"}
    now = datetime.now(timezone.utc)
    out = []
    for opt in catalog.get("options", []):
        if not opt.get("ok", True):
            continue
        until = parse_exhausted(opt.get("exhausted_until"))
        if until and until > now:
            continue
        if opt.get("id") == "codex" and status.get("state") == "quota_exhausted":
            continue
        if tags:
            ot = set(opt.get("tags") or [])
            if ot and not (ot & tags):
                continue
        out.append(opt)
    return out, status


def detect_codex_error(text: str):
    t = text.lower()
    if "at capacity" in t or "turn_rate_limit_exceeded" in t:
        return {"state": "capacity", "kind": "capacity"}
    if (
        "you've hit your usage limit" in t
        or "you've hit your codex usage limit" in t
        or "openai rate/usage limit" in t
    ):
        return {"state": "quota_exhausted", "kind": "quota"}
    return None


def write_codex_status(state, raw, source_bot, reset_at_beijing):
    payload = {
        "state": state,
        "reset_at_beijing": reset_at_beijing,
        "raw_error": (raw or "")[:2000],
        "updated_at": now_beijing(),
        "source_bot": source_bot,
    }
    CODEX.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    return payload


def jev_choice(task: str, options):
    """Match hermes-jev client shapes (System One / Gateway evaluation-model)."""
    typesafe = os.environ.get("TYPESAFE_API_KEY", "").strip()
    gateway = os.environ.get("AI_GATEWAY_API_KEY", "").strip()
    # TypeSafe keys often get pasted into AI_GATEWAY_*; prefer System One when
    # TYPESAFE is empty and the gateway key is not a Vercel vck_ key.
    if not typesafe and gateway and not gateway.startswith("vck_"):
        typesafe = gateway
    labels = [o["id"] for o in options]
    criteria = {o["id"]: (o.get("description") or o["id"]) for o in options}
    questions = {
        "route": {
            "type": "choice",
            "instructions": (
                "Pick the single best harness+model option for this task. "
                "Prefer cheaper/faster when quality would be similar."
            ),
            "criteria": criteria,
        }
    }

    if typesafe:
        # TypeSafe uses noul not boolean; choice passes through
        body = {
            "model": "jev-latest",
            "state": task[:8000],
            "questions": questions,
        }
        req = urllib.request.Request(
            "https://api.typesafe.ai/v1/systemone",
            data=json.dumps(body, ensure_ascii=False).encode(),
            headers={
                "Authorization": f"Bearer {typesafe}",
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode())
            return {"backend": "typesafe", "raw": data}
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:1000]
            return {"backend": "typesafe", "error": f"http_{e.code}", "detail": err}

    if gateway:
        body = {"state": task[:8000], "questions": questions}
        req = urllib.request.Request(
            "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
            data=json.dumps(body, ensure_ascii=False).encode(),
            headers={
                "Authorization": f"Bearer {gateway}",
                "ai-gateway-protocol-version": "0.0.1",
                "ai-evaluation-model-specification-version": "4",
                "ai-model-id": "typesafe-ai/jev",
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode())
            return {"backend": "gateway", "raw": data}
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:1000]
            return {"backend": "gateway", "error": f"http_{e.code}", "detail": err}

    return {"backend": "none", "error": "no_key"}


def pick_from_raw(raw, labels):
    answers = raw.get("answers") if isinstance(raw, dict) else None
    if isinstance(answers, dict):
        route = answers.get("route") or answers.get("which") or {}
        if isinstance(route, dict):
            choice = route.get("choice") or route.get("id") or route.get("answer")
            probs = route.get("probabilities") or {}
            if choice in labels:
                conf = probs.get(choice) if isinstance(probs, dict) else None
                conf = conf if conf is not None else route.get("confidence") or route.get("probability")
                return choice, conf
            if isinstance(probs, dict) and probs:
                best = max(((n, float(p)) for n, p in probs.items() if n in labels), default=None, key=lambda kv: kv[1])
                if best:
                    return best[0], best[1]
    # confidence map from providerMetadata
    conf_map = (
        ((raw.get("providerMetadata") or {}).get("typesafe") or {}).get("confidence")
        if isinstance(raw, dict)
        else None
    )
    blob = json.dumps(raw)
    for lab in labels:
        if lab in blob:
            c = None
            if isinstance(conf_map, dict):
                c = conf_map.get("route") or conf_map.get(lab)
            return lab, c
    return None, None


def append_log(bot, task_type, choice_id, confidence, ok, notes):
    with LOG.open("a") as f:
        f.write(
            f"{now_beijing()}\t{bot or ''}\t{task_type or ''}\t{choice_id or ''}\t"
            f"{confidence if confidence is not None else ''}\t{int(bool(ok))}\t"
            f"{(notes or '').replace(chr(9), ' ')}\n"
        )


def make_route_id(bot: str) -> str:
    """每次路由一个 id：rt-年月日时分秒-bot-两位十六进制。"""
    when = datetime.now(BEIJING)
    safe = (bot or "na").lower()
    return f"rt-{when.strftime('%Y%m%d%H%M%S')}-{safe}-{secrets.token_hex(1)}"


def _events_dir() -> Path:
    raw = os.environ.get("MINION_EVENTS_DIR", "").strip()
    if raw:
        return Path(raw)
    return ROOT / "minion-events"


def _missing_why(notes: str) -> bool:
    return re.search(r"(?:^|\s)why=MISSING(?:\s|$)", notes or "") is not None


def _replace_missing_why(notes: str, reason: str) -> str:
    clean = reason.replace("\t", " ").replace("\n", " ").strip()
    replaced, count = re.subn(
        r"(^|\s)why=MISSING(?=\s|$)",
        lambda match: f"{match.group(1)}why={clean}",
        notes,
        count=1,
    )
    if count != 1:
        raise ValueError("why=MISSING")
    return replaced


def write_quota_event(state: str, raw: str, bot: str, reset_at: str) -> dict:
    """额度变化写进事件流，避免 codex-status.json 被覆盖后没有历史。"""
    scripts = ROOT / "minion-board" / "scripts"
    if scripts.is_dir() and str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import minion_lib as mlib

    event = mlib.make_quota(
        state=state,
        writer=(bot or "jev").lower() or "jev",
        reset_at=reset_at or None,
        raw=raw,
    )
    mlib.append_event(event, _events_dir())
    return {"event_id": event["event_id"], "state": event["state"], "reset_at": event.get("reset_at")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="")
    ap.add_argument("--tags", default="")
    ap.add_argument("--bot", default="")
    ap.add_argument("--task-type", default="")
    ap.add_argument("--no-jev", action="store_true")
    ap.add_argument("--shadow", action="store_true")
    ap.add_argument("--record-codex-error", default="")
    ap.add_argument("--reset-at-beijing", default="")
    ap.add_argument("--actual", default="", help="catalog id actually used (e.g. higgsfield, grok_only, pi-deepseek-flash); logged in notes")
    ap.add_argument("--why", default="", help="one-line reason when --actual differs from Jev's choice")
    ap.add_argument("--amend-why", default="", help="append a why= reason to this bot's latest log row (use after a mismatch)")
    args = ap.parse_args()

    if args.amend_why:
        if not args.bot:
            print(json.dumps({"ok": False, "error": "bot_required"}))
            return 1
        if not LOG.exists():
            print(json.dumps({"ok": False, "error": "no_missing_why"}))
            return 1
        fd = os.open(LOG, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 10_000_000).decode("utf-8")
            lines = raw.splitlines(True)
            target = None
            want = args.bot.casefold()
            for i in range(len(lines) - 1, -1, -1):
                cols = lines[i].rstrip("\n").split("\t")
                if len(cols) >= 7 and cols[1].casefold() == want and _missing_why(cols[6]):
                    target = i
                    break
            if target is None:
                print(json.dumps({"ok": False, "error": "no_missing_why"}))
                return 1
            cols = lines[target].rstrip("\n").split("\t")
            cols[6] = _replace_missing_why(cols[6], args.amend_why)
            lines[target] = "\t".join(cols) + "\n"
            payload = "".join(lines).encode("utf-8")
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            os.write(fd, payload)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        print(json.dumps({"ok": True, "amended": cols}, ensure_ascii=False))
        return 0

    if args.record_codex_error:
        det = detect_codex_error(args.record_codex_error)
        if not det:
            print(json.dumps({"ok": False, "error": "not_a_codex_limit"}))
            return 1
        state = "quota_exhausted" if det["kind"] == "quota" else "capacity"
        st = write_codex_status(
            state, args.record_codex_error, args.bot or None, args.reset_at_beijing or None
        )
        try:
            quota = write_quota_event(state, args.record_codex_error, args.bot, args.reset_at_beijing)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": "quota_write_failed", "detail": str(exc), "codex_status": st}, ensure_ascii=False))
            return 1
        print(json.dumps({"ok": True, "codex_status": st, "quota_event": quota}, ensure_ascii=False))
        return 0

    if not args.task:
        print(json.dumps({"ok": False, "error": "task_required"}))
        return 1

    tags = {t.strip() for t in args.tags.split(",") if t.strip()} or None
    options, status = available_options(tags)
    result = {
        "ok": True,
        "shadow": bool(args.shadow),
        "beijing_time": now_beijing(),
        "codex_status": status.get("state"),
        "candidates": [o["id"] for o in options],
        "choice_id": None,
        "confidence": None,
        "option": None,
        "jev": None,
    }
    if not options:
        result["ok"] = False
        result["error"] = "no_candidates"
        print(json.dumps(result, ensure_ascii=False))
        return 2

    if args.no_jev:
        choice_id = options[0]["id"]
        conf = None
        result["jev"] = {"backend": "skipped"}
    else:
        jev = jev_choice(args.task, options)
        result["jev"] = {k: v for k, v in jev.items() if k != "raw"}
        if jev.get("error") and jev.get("backend") in ("none", "gateway") and "raw" not in jev:
            choice_id = options[0]["id"]
            conf = None
            result["jev"]["fallback"] = "first_candidate"
        elif "raw" in jev:
            choice_id, conf = pick_from_raw(jev["raw"], [o["id"] for o in options])
            result["jev"]["raw_keys"] = (
                list(jev["raw"].keys()) if isinstance(jev["raw"], dict) else type(jev["raw"]).__name__
            )
            if not choice_id:
                choice_id = options[0]["id"]
                result["jev"]["fallback"] = "first_candidate"
        else:
            choice_id = options[0]["id"]
            conf = None
            result["jev"]["fallback"] = "first_candidate"

    opt = next(o for o in options if o["id"] == choice_id)
    rid = make_route_id(args.bot)
    result["choice_id"] = choice_id
    result["confidence"] = conf
    result["option"] = opt
    result["route_id"] = rid
    notes = ("shadow" if args.shadow else "route") + (f" actual={args.actual}" if args.actual else "")
    notes += f" route_id={rid}"
    mismatch = bool(args.actual) and args.actual != choice_id
    if mismatch:
        notes += " mismatch why=" + (args.why.replace(chr(9), " ") if args.why else "MISSING")
        result["mismatch"] = True
        if not args.why:
            result["action_required"] = (
                f"Jev 建议 {choice_id}，你实际用 {args.actual}。补一句理由："
                f"python3 {os.path.abspath(__file__)} --bot {args.bot} --amend-why \"<理由>\""
            )
    append_log(
        args.bot,
        args.task_type,
        choice_id,
        conf,
        True,
        notes,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
