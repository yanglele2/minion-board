#!/usr/bin/env python3
"""用无头 Chrome 打开本机页面，确认空状态、推送之后的内容和过期提示。"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

import shot_board

ROOT = Path(__file__).resolve().parent.parent
PORT = 9343
WEB = 4177
TOKEN = "dev-token"


def post(board: dict) -> None:
    raw = json.dumps(board, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{WEB}/api/ingest",
        data=raw,
        method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        if resp.status != 200:
            raise RuntimeError(resp.status)


def wait_text(page, needle: str, seconds: float = 6) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        text = page.js("document.body.innerText") or ""
        if needle in text:
            return True
        time.sleep(0.2)
    return False


def main() -> int:
    env = os.environ.copy()
    for key in ("KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"):
        env.pop(key, None)
    env["PORT"] = str(WEB)
    env["INGEST_TOKEN"] = TOKEN
    server = subprocess.Popen(
        ["node", str(ROOT / "tests" / "dev-server.js")],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    chrome = None
    try:
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{WEB}/api/board", timeout=1).read()
                break
            except Exception:
                if server.poll() is not None:
                    raise RuntimeError(server.stderr.read() if server.stderr else "dev server exited")
                time.sleep(0.1)
        else:
            raise RuntimeError("dev server did not start")

        shot_board.PORT = PORT
        chrome = subprocess.Popen(
            [
                "google-chrome",
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                f"--remote-debugging-port={PORT}",
                "--user-data-dir=/tmp/chrome-minion-hosted",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        shot_board.wait_port()
        page = shot_board.open_page(f"http://127.0.0.1:{WEB}/?probe=1", 1280, 800)
        empty_ok = wait_text(page, "还没有数据")
        print(("过 " if empty_ok else "没过 ") + "还没推送时有空状态")
        if not empty_ok:
            print(page.js("document.body.innerText"))
            return 1

        now = time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime(time.time() + 8 * 3600))
        post(
            {
                "schema": 1,
                "built_at": now,
                "refresh_mode": "watch",
                "watch_interval_s": 30,
                "sources": [],
                "tasks": [
                    {
                        "task_id": "tsk-hosted",
                        "minion": "pi",
                        "bot": "t00",
                        "title": "【假】数三只橡皮鸭",
                        "task_type": "copy",
                        "status": "running",
                        "started_at": now,
                        "ended_at": None,
                        "fail_kind": None,
                        "fail_text": None,
                        "smoke": False,
                        "threshold_s": 1200,
                    }
                ],
                "codex_quota": {"current": {"state": "ok", "reset_at": None, "time_unknown": False, "raw": ""}, "history": []},
                "legacy_routes": [],
                "health": {},
                "seq": 1,
            }
        )
        page.js("window.__MINION_TEST__.poll()")
        fresh_ok = wait_text(page, "【假】数三只橡皮鸭")
        top = page.js("document.getElementById('top-status') ? document.getElementById('top-status').textContent : ''") or ""
        age_ok = "推送于" in top and "约每 20 秒更新" in top and "实时" not in (page.js("document.body.innerText") or "")
        print(("过 " if fresh_ok else "没过 ") + "推送后页面出现假任务")
        print(("过 " if age_ok else "没过 ") + "顶栏写出推送时间", top)
        if not (fresh_ok and age_ok):
            print(page.js("document.body.innerText"))
            return 1

        post(
            {
                "schema": 1,
                "built_at": "2020-01-01T00:00:00+08:00",
                "refresh_mode": "watch",
                "watch_interval_s": 30,
                "sources": [],
                "tasks": [],
                "codex_quota": {"current": {"state": "ok", "reset_at": None, "time_unknown": False, "raw": ""}, "history": []},
                "legacy_routes": [],
                "health": {},
                "seq": 2,
            }
        )
        page.js("window.__MINION_TEST__.poll()")
        stale_ok = wait_text(page, "分钟没更新")
        print(("过 " if stale_ok else "没过 ") + "很旧的快照会显示过期")
        page.close()
        return 0 if stale_ok else 1
    finally:
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    raise SystemExit(main())
