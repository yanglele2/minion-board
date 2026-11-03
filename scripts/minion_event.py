#!/usr/bin/env python3
"""追加一条手下事件。不要手写 JSON。

例子：
  python3 scripts/minion_event.py start --minion pi --bot t06 --title "写 5 条文案"
  python3 scripts/minion_event.py end --task-id tsk-... --minion pi --status success --exit-code 0
  python3 scripts/minion_event.py quota --state quota_exhausted --bot t06 --raw "usage limit"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import minion_lib as lib


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="往 minion-events 追加一条事件")
    parser.add_argument("--events-dir", default=str(lib.DEFAULT_EVENTS_DIR))
    parser.add_argument("--no-build", action="store_true", help="只追加，不立刻构建")
    sub = parser.add_subparsers(dest="cmd", required=True)

    start = sub.add_parser("start")
    start.add_argument("--minion", required=True, choices=lib.MINIONS)
    start.add_argument("--bot", required=True)
    start.add_argument("--title", required=True)
    start.add_argument("--writer", default="")
    start.add_argument("--task-id", default="")
    start.add_argument("--task-type", default="")
    start.add_argument("--route-ref", default="")
    start.add_argument("--model", default="")
    start.add_argument("--host", default="")
    start.add_argument("--attempt", type=int, default=1)
    start.add_argument("--parent-task-id", default="")
    start.add_argument("--expect-minutes", type=int, default=None)
    start.add_argument("--smoke", action="store_true")

    end = sub.add_parser("end")
    end.add_argument("--task-id", required=True)
    end.add_argument("--minion", required=True, choices=lib.MINIONS)
    end.add_argument("--status", required=True, choices=lib.END_STATUSES)
    end.add_argument("--writer", default="")
    end.add_argument("--bot", default="")
    end.add_argument("--degraded-to", default="")
    end.add_argument("--fail-kind", default="", choices=("", *lib.FAIL_KINDS))
    end.add_argument("--fail-text", default="")
    end.add_argument("--exit-code", type=int, default=None)

    quota = sub.add_parser("quota")
    quota.add_argument("--state", required=True, choices=lib.QUOTA_STATES)
    quota.add_argument("--bot", default="")
    quota.add_argument("--writer", default="")
    quota.add_argument("--reset-at", default="")
    quota.add_argument("--raw", default="")

    burst = sub.add_parser("burst", help="测试用：连续追加若干条冒烟事件")
    burst.add_argument("--count", type=int, required=True)
    burst.add_argument("--bot", default="t06")
    burst.add_argument("--minion", default="pi", choices=lib.MINIONS)
    burst.add_argument("--prefix", default="burst")

    args = parser.parse_args(argv)
    events_dir = Path(args.events_dir)
    try:
        event = _build(args)
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    if isinstance(event, list):
        for item in event:
            lib.append_event(item, events_dir)
        written = event
    else:
        lib.append_event(event, events_dir)
        written = [event]
    if not args.no_build:
        lib.trigger_build(events_dir)
    if len(written) == 1:
        print(json.dumps({"ok": True, "event": written[0]}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, "count": len(written)}, ensure_ascii=False))
    return 0


def _build(args):
    if args.cmd == "start":
        return lib.make_start(
            minion=args.minion,
            bot=args.bot.lower(),
            title=args.title,
            writer=(args.writer or args.bot).lower(),
            task_id_value=args.task_id or None,
            task_type=args.task_type,
            route_ref=args.route_ref,
            model=args.model,
            host=args.host,
            attempt=args.attempt,
            parent_task_id=args.parent_task_id,
            expect_minutes=args.expect_minutes,
            smoke=args.smoke,
        )
    if args.cmd == "end":
        writer = (args.writer or args.bot or "box").lower()
        return lib.make_end(
            task_id_value=args.task_id,
            minion=args.minion,
            status=args.status,
            writer=writer,
            degraded_to=args.degraded_to or None,
            fail_kind=args.fail_kind or None,
            fail_text=args.fail_text or None,
            exit_code=args.exit_code,
        )
    if args.cmd == "quota":
        writer = (args.writer or args.bot or "box").lower()
        reset = args.reset_at
        if reset:
            parsed = lib.parse_time(reset)
            reset = lib.iso_bj(parsed) if parsed else ""
        return lib.make_quota(
            state=args.state,
            writer=writer,
            reset_at=reset or None,
            raw=args.raw or None,
        )
    events = []
    for index in range(args.count):
        title = f"{args.prefix}-{index}"
        start = lib.make_start(
            minion=args.minion,
            bot=args.bot.lower(),
            title=title,
            smoke=True,
        )
        events.append(start)
    return events


if __name__ == "__main__":
    sys.exit(main())
