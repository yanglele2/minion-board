#!/usr/bin/env python3
"""推送脚本：令牌不能出现在输出里，内容没变就不要再 POST，失败要非零退出。"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUSH = ROOT / "scripts" / "push_vercel.sh"
PY = "python3"
TOKEN = "push-token-should-stay-hidden"


class Box:
    def __init__(self) -> None:
        self.posts: list[tuple[str, bytes]] = []
        self.status = 200

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or "0")
                body = self.rfile.read(length)
                auth = self.headers.get("Authorization") or ""
                outer.posts.append((auth, body))
                raw = json.dumps({"ok": outer.status == 200}).encode()
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, fmt: str, *args) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}/api/ingest"

    def close(self) -> None:
        self.httpd.shutdown()
        self.thread.join(timeout=3)


def run_push(tmp: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    # 别把调用者自己的推送地址带进来。
    for key in ("MINION_INGEST_URL", "MINION_INGEST_TOKEN", "MINION_INGEST_TOKEN_FILE", "MINION_PUSH_MIN_INTERVAL", "MINION_BOARD_JSON"):
        merged.pop(key, None)
    merged.update(env)
    return subprocess.run(["bash", str(PUSH)], cwd=tmp, text=True, capture_output=True, env=merged)


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(("过 " if ok else "没过 ") + name + ((" — " + detail) if detail and not ok else ""))
    return ok


def main() -> int:
    ok = True
    box = Box()
    try:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            data = tmp / "data"
            data.mkdir()
            board = data / "board-data.json"
            board.write_text(json.dumps({"schema": 1, "title": "【假】第一次"}, ensure_ascii=False) + "\n", encoding="utf-8")
            secret = tmp / "token.txt"
            secret.write_text(TOKEN + "\n", encoding="utf-8")
            os.chmod(secret, 0o600)

            missing = run_push(tmp, {})
            blob = missing.stdout + missing.stderr
            ok &= check("没设地址时失败，并且不提令牌", missing.returncode != 0 and "MINION_INGEST_URL" in blob and TOKEN not in blob, blob)

            no_token = run_push(tmp, {"MINION_INGEST_URL": box.url, "MINION_INGEST_TOKEN_FILE": str(tmp / "missing-token")})
            blob = no_token.stdout + no_token.stderr
            ok &= check("没读到令牌时失败", no_token.returncode != 0 and "没有读到令牌" in blob and TOKEN not in blob, blob)

            first = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN_FILE": str(secret),
                    "MINION_BOARD_JSON": str(board),
                    "MINION_PUSH_MIN_INTERVAL": "0",
                },
            )
            blob = first.stdout + first.stderr
            ok &= check(
                "用令牌文件推送成功，输出里没有令牌",
                first.returncode == 0 and len(box.posts) == 1 and box.posts[0][0] == f"Bearer {TOKEN}" and TOKEN not in blob and "已推送" in blob,
                blob,
            )
            ok &= check("推上去的是看板 JSON", json.loads(box.posts[0][1])["title"] == "【假】第一次")

            second = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_BOARD_JSON": str(board),
                },
            )
            blob = second.stdout + second.stderr
            ok &= check("内容没变就不再 POST", second.returncode == 0 and len(box.posts) == 1 and "一样" in blob and TOKEN not in blob, blob)

            board.write_text(json.dumps({"schema": 1, "title": "【假】第二次"}, ensure_ascii=False) + "\n", encoding="utf-8")
            third = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_BOARD_JSON": str(board),
                    "MINION_PUSH_MIN_INTERVAL": "60",
                },
            )
            blob = third.stdout + third.stderr
            ok &= check("内容变了会再推一次", third.returncode == 0 and len(box.posts) == 2 and "已推送" in blob and TOKEN not in blob, blob)

            board.write_text(json.dumps({"schema": 1, "title": "【假】第三次"}, ensure_ascii=False) + "\n", encoding="utf-8")
            fourth = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_BOARD_JSON": str(board),
                    "MINION_PUSH_MIN_INTERVAL": "60",
                },
            )
            blob = fourth.stdout + fourth.stderr
            ok &= check("60 秒内即使内容变了也先跳过", fourth.returncode == 0 and len(box.posts) == 2 and "间隔" in blob and TOKEN not in blob, blob)

            stamp = data / "push-vercel.stamp"
            stamp.write_text("1\n", encoding="utf-8")
            fifth = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_BOARD_JSON": str(board),
                    "MINION_PUSH_MIN_INTERVAL": "60",
                },
            )
            ok &= check("间隔过了之后会把新内容推上去", fifth.returncode == 0 and len(box.posts) == 3 and json.loads(box.posts[-1][1])["title"] == "【假】第三次")

            box.status = 500
            board.write_text(json.dumps({"schema": 1, "title": "【假】会失败"}, ensure_ascii=False) + "\n", encoding="utf-8")
            (data / "push-vercel.stamp").write_text("1\n", encoding="utf-8")
            failed = run_push(
                tmp,
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_BOARD_JSON": str(board),
                    "MINION_PUSH_MIN_INTERVAL": "0",
                },
            )
            blob = failed.stdout + failed.stderr
            ok &= check("对方返回 500 时非零退出，日志很短也不含令牌", failed.returncode != 0 and "HTTP 500" in blob and TOKEN not in blob and "【假】" not in blob, blob)

            # 心跳：地址设了就会调用推送；推送失败不能把心跳弄停。
            hb = tmp / "hb"
            (hb / "scripts").mkdir(parents=True)
            (hb / "data").mkdir()
            shutil.copy(ROOT / "scripts" / "heartbeat.sh", hb / "scripts" / "heartbeat.sh")
            shutil.copy(ROOT / "scripts" / "build_snapshot.py", hb / "scripts" / "build_snapshot.py")
            shutil.copy(ROOT / "scripts" / "minion_lib.py", hb / "scripts" / "minion_lib.py")
            shutil.copy(PUSH, hb / "scripts" / "push_vercel.sh")
            env = os.environ.copy()
            for key in ("MINION_INGEST_URL", "MINION_INGEST_TOKEN", "MINION_INGEST_TOKEN_FILE"):
                env.pop(key, None)
            env.update(
                {
                    "MINION_INGEST_URL": box.url,
                    "MINION_INGEST_TOKEN": TOKEN,
                    "MINION_HEARTBEAT_ONCE": "1",
                    "MINION_PUSH_MIN_INTERVAL": "60",
                }
            )
            beat = subprocess.run(
                ["bash", str(hb / "scripts" / "heartbeat.sh")],
                text=True,
                capture_output=True,
                env=env,
                timeout=20,
            )
            blob = beat.stdout + beat.stderr
            ok &= check(
                "心跳在推送失败时仍然退出 0，并且不打印令牌",
                beat.returncode == 0 and "心跳继续" in blob and TOKEN not in blob,
                blob,
            )
    finally:
        box.close()

    print("结果：" + ("全部通过" if ok else "有项目没过"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
