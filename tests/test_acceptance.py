#!/usr/bin/env python3
"""验收规格第 10 节里可以用标准库核对的部分。

跑法：python3 tests/test_acceptance.py
失败时退出码是 1，并打印哪一条没过。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
REF = ROOT / "reference"
UPLOAD_LOG = ROOT / "uploads" / "route-log_c30c.tsv"


def run(cmd, **kwargs):
    return subprocess.run(cmd, text=True, capture_output=True, **kwargs)


def check(name, ok, detail=""):
    mark = "过" if ok else "没过"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))
    return bool(ok)


def load_snapshot(out):
    return json.loads((out / "board-data.json").read_text(encoding="utf-8"))


def materialize_inputs(tmp: Path):
    """有 reference/ 就用它。没有就造一份假的，这样真数据不必入库。"""
    catalog = REF / "model-catalog.json"
    status = REF / "codex-status.json"
    route = REF / "route-log.tsv"
    if catalog.is_file() and status.is_file() and route.is_file():
        return route, status, catalog, True
    catalog = tmp / "model-catalog.json"
    status = tmp / "codex-status.json"
    route = tmp / "route-log.tsv"
    catalog.write_text(
        json.dumps(
            {
                "options": [
                    {"id": "codex", "ok": True, "harness": "codex", "description": "假的 Codex"},
                    {"id": "pi-deepseek-flash", "ok": True, "harness": "pi", "description": "假的 pi"},
                    {"id": "hermes-default", "ok": True, "harness": "hermes", "description": "假的 Hermes"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    status.write_text(
        json.dumps(
            {
                "state": "ok",
                "reset_at_beijing": None,
                "raw_error": None,
                "updated_at": "2026-11-03 08:00:00 +0800",
                "source_bot": "t00",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    route.write_text("", encoding="utf-8")
    return route, status, catalog, False


def build(events, route, status, out, catalog=None, mode="on_write", now=""):
    cmd = [
        PY,
        str(ROOT / "scripts" / "build_snapshot.py"),
        "--events-dir",
        str(events),
        "--route-log",
        str(route),
        "--codex-status",
        str(status),
        "--catalog",
        str(catalog or REF / "model-catalog.json"),
        "--out-dir",
        str(out),
        "--refresh-mode",
        mode,
    ]
    if now:
        cmd.extend(["--now", now])
    result = run(cmd)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return load_snapshot(out)


def main() -> int:
    ok = True
    front = (ROOT / "assets" / "board.js").read_text(encoding="utf-8")
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "assets" / "board.css").read_text(encoding="utf-8")
    blob = front + html + css
    ok &= check("A2 前端不用 XMLHttpRequest", "XMLHttpRequest" not in blob)
    ok &= check(
        "A2 公开页面只向 /api/board 拉数据",
        front.count("fetch(") == 1 and "/api/board" in front and "fetch(" not in html and "fetch(" not in css,
    )
    ok &= check("A6 页面上没有「实时」", "实时" not in blob)
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    ok &= check(
        "gitignore 挡住真数据",
        all(bit in ignore for bit in ("data/", "reference/", "*.jsonl", ".env", ".vercel")),
        ignore,
    )
    fixtures = "".join(path.read_text(encoding="utf-8") for path in (ROOT / "assets" / "fixtures").glob("*.js"))
    ok &= check("夹具任务是假的", "Etsy" not in fixtures and "TikTok" not in fixtures and "海报" not in fixtures and "商品" not in fixtures)
    ok &= check("A6 顶栏文案是约每 15 秒更新", "约每 15 秒更新" in front)
    ok &= check("D2 没有品牌绿和品牌蓝", "#58CC02" not in css and "#1CB0F6" not in css and "#58cc02" not in css.lower())
    builders = (ROOT / "scripts" / "build_snapshot.py").read_text(encoding="utf-8")
    ok &= check("A10 构建不读 ok 列来判断成败", 'cols[5]' not in builders and '["ok"]' not in builders)

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        events = tmp / "events"
        events.mkdir()
        out = tmp / "out"
        route, status, catalog, has_ref = materialize_inputs(tmp)
        if not has_ref:
            print("[跳过] A7 真实路由计数：reference/ 不在仓库里")
            sample = tmp / "route-sample.tsv"
            sample.write_text(
                "2026-11-03 08:00:00 +0800\tt06\tcopy\tcodex\t0.5\t1\troute actual=codex why=假的理由\n",
                encoding="utf-8",
            )
            before = build(events, sample, status, tmp / "ok1", catalog=catalog)
            sample.write_text(
                "2026-11-03 08:00:00 +0800\tt06\tcopy\tcodex\t0.5\t0\troute actual=codex why=假的理由\n",
                encoding="utf-8",
            )
            after = build(events, sample, status, tmp / "ok0", catalog=catalog)
            ok &= check("A10 把 ok 改成 0 后路由结果不变", before["legacy_routes"] == after["legacy_routes"])
        else:
            snap = build(events, route, status, out, catalog=catalog)
            rows = snap["legacy_routes"]
            shown = [row for row in rows if not row["smoke"] and row["actual_minion"]]
            pool = [row for row in rows if not row["smoke"]]
            grok = sum(1 for row in pool if row["actual"] == "grok_only")
            higgs = sum(1 for row in pool if row["actual"] == "higgsfield")
            mismatch = sum(1 for row in pool if row["mismatch"])
            missing = sum(1 for row in pool if row["why_missing"])
            codex_only = all(row["actual_minion"] == "codex" for row in shown)
            ok &= check(
                "A7 隐藏冒烟后旧路由 9 条且都是 Codex",
                len(shown) == 9 and codex_only,
                f"实际 {len(shown)} 条",
            )
            ok &= check("A7 非手下计数", grok == 6 and higgs == 3, f"grok={grok} higgs={higgs}")
            ok &= check("A7 建议≠实际 7 条、没写理由 1 条", mismatch == 7 and missing == 1, f"mismatch={mismatch} missing={missing}")
            ok &= check("A7 打开冒烟后共 28 条", len(rows) == 28, f"实际 {len(rows)}")

            changed = tmp / "route-ok0.tsv"
            text = route.read_text(encoding="utf-8")
            changed.write_text(text.replace("\t1\t", "\t0\t"), encoding="utf-8")
            out2 = tmp / "out2"
            snap2 = build(events, changed, status, out2, catalog=catalog)
            left = [{k: v for k, v in row.items()} for row in snap["legacy_routes"]]
            right = [{k: v for k, v in row.items()} for row in snap2["legacy_routes"]]
            ok &= check("A10 把 ok 改成 0 后路由结果不变", left == right)

        # A11：quota 事件留在历史里，即使后来覆盖 codex-status.json。
        ev = (
            '{"v":1,"event_id":"evt-20261103091431-aa0011","kind":"quota","ts":"2026-11-03T09:14:31+08:00",'
            '"writer":"t06","minion":"codex","state":"quota_exhausted","reset_at":"2026-11-03T13:00:00+08:00","raw":"usage limit"}\n'
        )
        (events / "2026-11.jsonl").write_text(ev, encoding="utf-8")
        fresh_status = tmp / "status.json"
        fresh_status.write_text(
            json.dumps(
                {
                    "state": "ok",
                    "reset_at_beijing": None,
                    "raw_error": None,
                    "updated_at": "2026-11-03 18:00:00 +0800",
                    "source_bot": "t05",
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        snap3 = build(events, route, fresh_status, tmp / "out3", catalog=catalog, now="2026-11-03T20:00:00+08:00")
        history_ids = [item["event_id"] for item in snap3["codex_quota"]["history"]]
        ok &= check("A11 覆盖状态文件后额度历史还在", "evt-20261103091431-aa0011" in history_ids, str(history_ids))

        # 脏数据：坏行、重复、两条 end、只有 end、结束早于开始、未来时间、对不上的路由、坏日志。
        dirty = tmp / "dirty-events"
        dirty.mkdir()
        lines = [
            "{not json",
            '{"v":1,"event_id":"evt-20261103100000-aaaa01","kind":"start","ts":"2026-11-03T10:00:00","writer":"t06","task_id":"tsk-bad-tz","minion":"pi","bot":"t06","title":"没时区"}',
            '{"v":1,"event_id":"evt-20261103100001-aaaa02","kind":"start","ts":"2026-11-03T10:00:01+08:00","writer":"t06","task_id":"tsk-bad-minion","minion":"grok","bot":"t06","title":"不是手下"}',
            '{"v":1,"event_id":"evt-20261103100100-bbbb01","kind":"start","ts":"2026-11-03T10:01:00+08:00","writer":"t05","task_id":"tsk-dup","minion":"codex","bot":"t05","title":"重复的开始"}',
            '{"v":1,"event_id":"evt-20261103100100-bbbb01","kind":"start","ts":"2026-11-03T10:01:05+08:00","writer":"t05","task_id":"tsk-dup","minion":"codex","bot":"t05","title":"同一事件编号"}',
            '{"v":1,"event_id":"evt-20261103100200-cccc01","kind":"start","ts":"2026-11-03T10:02:00+08:00","writer":"t06","task_id":"tsk-two","minion":"pi","bot":"t06","title":"两条结束"}',
            '{"v":1,"event_id":"evt-20261103100300-cccc02","kind":"end","ts":"2026-11-03T10:03:00+08:00","writer":"t06","task_id":"tsk-two","minion":"pi","status":"failed","fail_kind":"error","fail_text":"第一次"}',
            '{"v":1,"event_id":"evt-20261103100400-cccc03","kind":"end","ts":"2026-11-03T10:04:00+08:00","writer":"t06","task_id":"tsk-two","minion":"pi","status":"failed","fail_kind":"error","fail_text":"第二次"}',
            '{"v":1,"event_id":"evt-20261103100500-dddd01","kind":"end","ts":"2026-11-03T10:05:00+08:00","writer":"t05","task_id":"tsk-endonly","minion":"hermes","status":"success"}',
            '{"v":1,"event_id":"evt-20261103100600-eeee01","kind":"start","ts":"2026-11-03T10:06:00+08:00","writer":"t06","task_id":"tsk-back","minion":"codex","bot":"t06","title":"结束更早","route_ref":"rt-missing"}',
            '{"v":1,"event_id":"evt-20261103100400-eeee02","kind":"end","ts":"2026-11-03T10:04:00+08:00","writer":"t06","task_id":"tsk-back","minion":"codex","status":"failed","fail_kind":"unknown"}',
            '{"v":1,"event_id":"evt-20261103123000-ffff01","kind":"start","ts":"2026-11-03T12:30:00+08:00","writer":"t05","task_id":"tsk-future","minion":"pi","bot":"t05","title":"未来的任务"}',
            "这一行没有换行所以不完整",
        ]
        (dirty / "2026-11.jsonl").write_bytes(("\n".join(lines[:-1]) + "\n" + lines[-1]).encode("utf-8"))
        bad_route = tmp / "bad-route.tsv"
        bad_route.write_text("只有三列\t太短\t坏了\n", encoding="utf-8")
        dirty_snap = build(dirty, bad_route, status, tmp / "dirty-out", catalog=catalog, now="2026-11-03T12:00:00+08:00")
        health = dirty_snap["health"]
        ok &= check(
            "脏数据计数",
            health["bad_lines"] == 4 and health["dup_events"] == 1 and health["conflicts"] == 2 and health["clock_skew"] == 1 and health["legacy_rows"] == 1 and health["unmatched_routes"] >= 1,
            str(health),
        )
        end_only = next(task for task in dirty_snap["tasks"] if task["task_id"] == "tsk-endonly")
        ok &= check("只有 end 时标题是没有开始记录", end_only["title"] == "（没有开始记录）" and end_only["missing_start"] is True)

        # A9 两个进程各写 100 条。
        burst_dir = tmp / "burst"
        burst_dir.mkdir()
        procs = []
        for prefix in ("a", "b"):
            procs.append(
                subprocess.Popen(
                    [
                        PY,
                        str(ROOT / "scripts" / "minion_event.py"),
                        "--events-dir",
                        str(burst_dir),
                        "--no-build",
                        "burst",
                        "--count",
                        "100",
                        "--prefix",
                        prefix,
                    ]
                )
            )
        codes = [proc.wait(timeout=60) for proc in procs]
        month = next(burst_dir.glob("*.jsonl"))
        raw_lines = month.read_text(encoding="utf-8").splitlines()
        parsed = 0
        for line in raw_lines:
            json.loads(line)
            parsed += 1
        ok &= check("A9 并发 200 条都能解析", codes == [0, 0] and len(raw_lines) == 200 and parsed == 200, f"codes={codes} lines={len(raw_lines)}")

        # minion_run：透传输出和退出码，并写 start/end。
        run_dir = tmp / "run-events"
        env = os.environ.copy()
        env["MINION_EVENTS_DIR"] = str(run_dir)
        wrapped = run(
            [
                PY,
                str(ROOT / "scripts" / "minion_run"),
                "--helper",
                "pi",
                "--bot",
                "t06",
                "--task",
                "透传测试",
                "--route-id",
                "rt-test",
                "--events-dir",
                str(run_dir),
                "--no-build",
                "--",
                PY,
                "-c",
                "import sys; sys.stdout.write('HELLO\\n'); sys.stderr.write('ERR\\n'); raise SystemExit(3)",
            ],
            env=env,
        )
        ok &= check("minion_run 退出码原样返回", wrapped.returncode == 3, f"code={wrapped.returncode} err={wrapped.stderr}")
        ok &= check("minion_run 标准输出原样透传", wrapped.stdout == "HELLO\n", repr(wrapped.stdout))
        ok &= check("minion_run 标准错误原样透传", "ERR\n" in wrapped.stderr, repr(wrapped.stderr))
        run_lines = [json.loads(line) for line in next(run_dir.glob("*.jsonl")).read_text(encoding="utf-8").splitlines()]
        kinds = [line["kind"] for line in run_lines]
        end = next(line for line in run_lines if line["kind"] == "end")
        start = next(line for line in run_lines if line["kind"] == "start")
        ok &= check("minion_run 先 start 再 end，状态是 failed", kinds == ["start", "end"] and end["status"] == "failed" and start["route_ref"] == "rt-test")
        ok &= check("结束事件不写 ok 字段", "ok" not in end and end["status"] in ("success", "failed", "degraded"))

        # SIGTERM 也要写 end。
        term_dir = tmp / "term-events"
        proc = subprocess.Popen(
            [
                PY,
                str(ROOT / "scripts" / "minion_run"),
                "--helper",
                "hermes",
                "--bot",
                "t05",
                "--task",
                "等信号",
                "--events-dir",
                str(term_dir),
                "--no-build",
                "--",
                PY,
                "-c",
                "import time; time.sleep(30)",
            ]
        )
        time.sleep(0.4)
        proc.send_signal(15)
        term_code = proc.wait(timeout=10)
        term_lines = [json.loads(line) for line in next(term_dir.glob("*.jsonl")).read_text(encoding="utf-8").splitlines()]
        term_end = next(line for line in term_lines if line["kind"] == "end")
        ok &= check(
            "SIGTERM 仍写 failed/cancelled 的 end",
            term_end["status"] == "failed" and term_end["fail_kind"] == "cancelled" and term_code != 0,
            f"code={term_code} end={term_end}",
        )

        # Codex 额度文案额外写 quota。
        quota_dir = tmp / "quota-events"
        quota_run = run(
            [
                PY,
                str(ROOT / "scripts" / "minion_run"),
                "--helper",
                "codex",
                "--bot",
                "t06",
                "--task",
                "撞上额度",
                "--events-dir",
                str(quota_dir),
                "--no-build",
                "--",
                PY,
                "-c",
                "print(\"You've hit your usage limit. Try again at 1:00 PM.\"); raise SystemExit(1)",
            ]
        )
        q_lines = [json.loads(line) for line in next(quota_dir.glob("*.jsonl")).read_text(encoding="utf-8").splitlines()]
        q_end = next(line for line in q_lines if line["kind"] == "end")
        q_quota = next(line for line in q_lines if line["kind"] == "quota")
        ok &= check(
            "Codex 额度用完写 quota，end 是 failed/quota",
            quota_run.returncode == 1 and q_end["status"] == "failed" and q_end["fail_kind"] == "quota" and q_quota["state"] == "quota_exhausted" and q_quota["reset_at"],
            str(q_quota),
        )

        # jev 补丁。
        helpers = tmp / "helpers"
        scripts = helpers / "minion-board" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy(ROOT / "patches" / "jev_choice_route.py", helpers / "jev_choice_route.py")
        shutil.copy(ROOT / "scripts" / "minion_lib.py", scripts / "minion_lib.py")
        shutil.copy(catalog, helpers / "model-catalog.json")
        shutil.copy(status, helpers / "codex-status.json")
        log = helpers / "route-log.tsv"
        log.write_text(
            "2026-11-02 09:07:42 +0800\tt06\tmg\tpi-deepseek-flash\t0.5\t1\troute actual=codex mismatch why=MISSING\n"
            "2026-11-02 09:07:42 +0800\tt06\tmg\tgrok_only\t0.4\t1\troute actual=grok_only why=这句不该被改\n",
            encoding="utf-8",
        )
        jev_env = os.environ.copy()
        jev_env["MINION_EVENTS_DIR"] = str(helpers / "minion-events")
        amended = run([PY, str(helpers / "jev_choice_route.py"), "--bot", "t06", "--amend-why", "合成要多文件"], env=jev_env)
        amended_rows = log.read_text(encoding="utf-8").splitlines()
        ok &= check("amend-why 改的是 why=MISSING 那一行", amended.returncode == 0 and "why=合成要多文件" in amended_rows[0] and "why=MISSING" not in amended_rows[0], amended.stdout)
        ok &= check("amend-why 不改别的行", amended_rows[1].endswith("why=这句不该被改"), amended_rows[1])
        missing_again = run([PY, str(helpers / "jev_choice_route.py"), "--bot", "t06", "--amend-why", "再补一次"], env=jev_env)
        after = log.read_text(encoding="utf-8")
        ok &= check("找不到 MISSING 就报错，文件不动", missing_again.returncode == 1 and "no_missing_why" in missing_again.stdout and after == "\n".join(amended_rows) + "\n")

        recorded = run(
            [
                PY,
                str(helpers / "jev_choice_route.py"),
                "--bot",
                "t06",
                "--record-codex-error",
                "You've hit your usage limit",
                "--reset-at-beijing",
                "2026-11-03T13:00:00+08:00",
            ],
            env=jev_env,
        )
        recorded_json = json.loads(recorded.stdout)
        qfile = next((helpers / "minion-events").glob("*.jsonl"))
        qobj = json.loads(qfile.read_text(encoding="utf-8").splitlines()[-1])
        status_now = json.loads((helpers / "codex-status.json").read_text(encoding="utf-8"))
        ok &= check(
            "record-codex-error 仍写状态文件，并追加 quota",
            recorded.returncode == 0 and recorded_json["ok"] is True and "codex_status" in recorded_json and status_now["state"] == "quota_exhausted" and qobj["kind"] == "quota" and qobj["state"] == "quota_exhausted",
            recorded.stdout,
        )

        routed = run(
            [PY, str(helpers / "jev_choice_route.py"), "--bot", "t06", "--task", "画三只橡皮鸭", "--task-type", "mg", "--no-jev", "--actual", "codex"],
            env=jev_env,
        )
        routed_json = json.loads(routed.stdout)
        last_log = log.read_text(encoding="utf-8").splitlines()[-1]
        ok &= check(
            "路由输出 route_id，并写进 notes",
            routed.returncode == 0 and str(routed_json.get("route_id", "")).startswith("rt-") and f"route_id={routed_json['route_id']}" in last_log and "choice_id" in routed_json,
            routed.stdout,
        )

        # 心跳不能开第二份。
        hb_root = tmp / "hb"
        (hb_root / "scripts").mkdir(parents=True)
        (hb_root / "data").mkdir()
        shutil.copy(ROOT / "scripts" / "heartbeat.sh", hb_root / "scripts" / "heartbeat.sh")
        shutil.copy(ROOT / "scripts" / "build_snapshot.py", hb_root / "scripts" / "build_snapshot.py")
        shutil.copy(ROOT / "scripts" / "minion_lib.py", hb_root / "scripts" / "minion_lib.py")
        first = subprocess.Popen(["bash", str(hb_root / "scripts" / "heartbeat.sh")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        second = run(["bash", str(hb_root / "scripts" / "heartbeat.sh")])
        first.send_signal(15)
        try:
            first.wait(timeout=5)
        except subprocess.TimeoutExpired:
            first.kill()
        ok &= check("心跳已在跑时第二次直接退出", second.returncode == 0 and "不再另开" in second.stderr, second.stderr)

    print("结果：" + ("全部通过" if ok else "有项目没过"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
