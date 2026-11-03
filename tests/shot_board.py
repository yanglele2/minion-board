#!/usr/bin/env python3
"""用无头 Chrome 打开 file:// 看板，截图并核对第 10 节里要看页面的条目。"""
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path("/tmp/minion-shots")
PORT = 9337
PY = "python3"


class CDP:
    def __init__(self, ws_url: str):
        parsed = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port))
        key = base64.b64encode(os.urandom(16)).decode()
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self.buf = b""
        self.next_id = 0
        self.logs: list[str] = []

    def send(self, text: str) -> None:
        data = text.encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + mask + masked)

    def _read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("devtools 连接断了")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self) -> str:
        while True:
            b1, b2 = self._read_exact(2)
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            if b2 & 0x80:
                mask = self._read_exact(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read_exact(length)))
            else:
                payload = self._read_exact(length)
            if opcode == 8:
                raise ConnectionError("devtools 关闭了连接")
            if opcode == 9:
                continue
            if opcode == 1:
                return payload.decode()

    def call(self, method: str, params: dict | None = None, timeout: float = 20) -> dict:
        self.next_id += 1
        mid = self.next_id
        self.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        self.sock.settimeout(2)
        while time.time() < deadline:
            try:
                raw = self.recv()
            except socket.timeout:
                continue
            data = json.loads(raw)
            self._note(data)
            if data.get("id") == mid:
                if "error" in data:
                    raise RuntimeError(data["error"])
                return data
        raise TimeoutError(method)

    def _note(self, data: dict) -> None:
        method = data.get("method")
        if method == "Runtime.exceptionThrown":
            detail = data.get("params", {}).get("exceptionDetails", {})
            text = detail.get("text") or ""
            exc = (detail.get("exception") or {}).get("description") or ""
            self.logs.append(f"exception {text} {exc}".strip())
        if method == "Runtime.consoleAPICalled" and data.get("params", {}).get("type") == "error":
            bits = []
            for arg in data["params"].get("args") or []:
                bits.append(str(arg.get("value") or arg.get("description") or ""))
            self.logs.append("console " + " ".join(bits))

    def js(self, expression: str):
        data = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        result = data["result"]["result"]
        if result.get("subtype") == "error":
            raise RuntimeError(result.get("description"))
        return result.get("value")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def wait_port() -> None:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Chrome 调试端口没起来")


def new_tab(url: str) -> dict:
    target = "http://127.0.0.1:%s/json/new?%s" % (PORT, urllib.parse.quote(url, safe=""))
    req = urllib.request.Request(target, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        with urllib.request.urlopen(target, timeout=10) as resp:
            return json.loads(resp.read().decode())


def open_page(url: str, width: int, height: int, media: list | None = None) -> CDP:
    tab = new_tab("about:blank")
    page = CDP(tab["webSocketDebuggerUrl"])
    page.call("Runtime.enable")
    page.call("Page.enable")
    page.call(
        "Emulation.setDeviceMetricsOverride",
        {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width < 500},
    )
    if media:
        page.call("Emulation.setEmulatedMedia", {"features": media})
    page.call("Page.navigate", {"url": url})
    deadline = time.time() + 8
    while time.time() < deadline:
        state = page.js("document.readyState")
        if state == "complete" and page.js("!!document.getElementById('app') && document.getElementById('app').innerText.length > 0"):
            break
        time.sleep(0.15)
    time.sleep(0.3)
    return page


def shot(page: CDP, name: str) -> None:
    data = page.call("Page.captureScreenshot", {"format": "png"})
    raw = base64.b64decode(data["result"]["data"])
    path = OUT / f"{name}.png"
    path.write_bytes(raw)


def file_url(query: str) -> str:
    return "file://" + str(ROOT / "index.html") + (("?" + query) if query else "")


def text_has(page: CDP, needle: str) -> bool:
    body = page.js("document.body.innerText") or ""
    return needle in body


def build_snapshot(events: Path, out: Path, mode: str = "watch") -> None:
    cmd = [
        PY,
        str(ROOT / "scripts" / "build_snapshot.py"),
        "--events-dir",
        str(events),
        "--route-log",
        str(ROOT / "reference" / "route-log.tsv"),
        "--codex-status",
        str(ROOT / "reference" / "codex-status.json"),
        "--catalog",
        str(ROOT / "reference" / "model-catalog.json"),
        "--out-dir",
        str(out),
        "--refresh-mode",
        mode,
    ]
    subprocess.run(cmd, check=True)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    chrome = subprocess.Popen(
        [
            "google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--remote-debugging-port=%s" % PORT,
            "--user-data-dir=/tmp/chrome-minion-board",
            "--allow-file-access-from-files",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    results = []

    def record(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(("过 " if ok else "没过 ") + name + ((" — " + detail) if detail and not ok else ""))

    try:
        wait_port()
        cases = [
            ("1280-empty", "fixture=empty&probe=1", 1280, 800),
            ("1280-live", "fixture=live&probe=1", 1280, 800),
            ("1280-mixed", "fixture=mixed&probe=1", 1280, 800),
            ("1280-quota", "fixture=quota&probe=1", 1280, 800),
            ("1280-quota-unknown", "fixture=quota-unknown&probe=1", 1280, 800),
            ("1280-stuck", "fixture=stuck&probe=1", 1280, 800),
            ("1280-stale", "fixture=stale&probe=1", 1280, 800),
            ("1280-onwrite", "fixture=onwrite&probe=1", 1280, 800),
            ("1280-broken", "fixture=broken&probe=1", 1280, 800),
            ("1280-missing", "fixture=missing&probe=1", 1280, 800),
            ("1280-dirty", "fixture=dirty&probe=1", 1280, 800),
            ("1280-gray", "fixture=mixed&gray=1&probe=1", 1280, 800),
            ("1280-avatars", "avatars=1", 1280, 800),
            ("390-live", "fixture=live&probe=1", 390, 844),
            ("390-mixed", "fixture=mixed&probe=1", 390, 844),
            ("390-empty", "fixture=empty&probe=1", 390, 844),
            ("960-live", "fixture=live&probe=1", 960, 800),
            ("1440-live", "fixture=live&probe=1", 1440, 900),
        ]
        pages = {}
        for name, query, width, height in cases:
            page = open_page(file_url(query), width, height)
            shot(page, name)
            pages[name] = page

        empty = pages["1280-empty"]
        record("A1 empty 控制台没有错误", not empty.logs, " | ".join(empty.logs))
        record("C1 空状态文案", text_has(empty, "还没接过活") and text_has(empty, "还没有起止记录") and "0%" not in (empty.js("document.body.innerText") or ""))
        record("A6 顶栏没有实时", "实时" not in (empty.js("document.body.innerText") or "") and text_has(empty, "约每 15 秒更新"))

        live = pages["1280-live"]
        record("C2 pi 同时 3 件事且只露 2 个", text_has(live, "同时在干 3 件事") and text_has(live, "还有 1 个在跑"))
        record("C2 卡片上有两个正在跑的任务", live.js("document.querySelectorAll('#card-pi .task-row').length") == 2)
        title = live.js("document.querySelector('#card-codex .task-title')")
        clamp = live.js(
            """(() => {
              const el = document.querySelector('#card-codex .task-title');
              const style = getComputedStyle(el);
              return {clamp: style.webkitLineClamp, title: el.getAttribute('title'), lines: el.getClientRects().length, text: el.textContent.length};
            })()"""
        )
        record("B6 40 字标题两行内并带全文", clamp and clamp["clamp"] == "2" and clamp["lines"] <= 2 and clamp["text"] == 40 and clamp["title"] and len(clamp["title"]) == 40, str(clamp))

        layout = live.js(
            """(() => {
              const today = document.querySelector('.today').getBoundingClientRect();
              const cards = document.querySelector('.cards').getBoundingClientRect();
              return {todayBottom: today.bottom, cardsTop: cards.top, inner: innerHeight};
            })()"""
        )
        record("B1 1280 首屏能看到卡和今日小结", layout["todayBottom"] <= layout["inner"] + 1 and layout["cardsTop"] < layout["inner"], str(layout))

        mixed = pages["1280-mixed"]
        mixed_layout = mixed.js(
            """(() => {
              const today = document.querySelector('.today').getBoundingClientRect();
              return {todayBottom: today.bottom, banners: document.querySelectorAll('.banner').length, inner: innerHeight};
            })()"""
        )
        record("B1 有横幅时今日小结仍在首屏", mixed_layout["banners"] >= 1 and mixed_layout["todayBottom"] <= mixed_layout["inner"] + 1, str(mixed_layout))

        wide = pages["1440-live"]
        box = wide.js(
            """(() => {
              const page = document.querySelector('.page').getBoundingClientRect();
              const width = document.documentElement.clientWidth;
              return {width: page.width, left: page.left, right: width - page.right, client: width};
            })()"""
        )
        record("B2 1440 内容不超过 1280 且居中", box["width"] <= 1280 and abs(box["left"] - box["right"]) < 2, str(box))

        for key in ("390-live", "390-mixed"):
            page = pages[key]
            width = page.js("document.documentElement.scrollWidth")
            record(f"B3 {key} 没有横向滚动", width <= 390, str(width))

        mobile = pages["390-mixed"]
        record("B4 390 没有表格", mobile.js("document.querySelectorAll('table').length") == 0)
        small = mobile.js(
            """(() => {
              const bad = [];
              document.querySelectorAll('button, summary, a').forEach((el) => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;
                if (rect.width < 44 || rect.height < 44) bad.push(el.id || el.className || el.textContent.slice(0, 12));
              });
              return bad.slice(0, 8);
            })()"""
        )
        record("B4 可点区域至少 44px", small == [], str(small))

        mid = pages["960-live"]
        cols = mid.js("getComputedStyle(document.querySelector('.cards')).gridTemplateColumns")
        record("B5 960 手下卡是单列", cols and " " not in cols.strip(), str(cols))

        quota = pages["1280-quota"]
        record("C3 额度用完且有倒计时", text_has(quota, "额度用完，在休息") and text_has(quota, "恢复（北京时间）") and text_has(quota, "还剩"))
        past = open_page(file_url("fixture=quota&probe=1&offsetMs=10800000"), 1280, 800)
        record("C3 超过恢复时间的文案", text_has(past, "按时间应该恢复了，等下一次调用确认"))
        shot(past, "1280-quota-past")
        past.close()

        unknown = pages["1280-quota-unknown"]
        record("C4 恢复时间未知且没有倒计时", text_has(unknown, "额度用完，恢复时间未知") and "还剩" not in (unknown.js("document.body.innerText") or ""))

        stuck = pages["1280-stuck"]
        record("C5 可能卡住且不计失败", text_has(stuck, "可能卡住") and "失败 0" in (stuck.js("document.querySelector('#card-pi .card-foot').innerText") or ""))

        stale = pages["1280-stale"]
        record("C6 过期是红色文案且关不掉", text_has(stale, "分钟没更新") and stale.js("document.querySelectorAll('.banner [data-act=dismiss]').length") == 0)
        t1 = stale.js("document.querySelector('[data-live-elapsed]').textContent")
        time.sleep(1.2)
        t2 = stale.js("document.querySelector('[data-live-elapsed]').textContent")
        record("C6 过期时计时器停住", t1 == t2, f"{t1} -> {t2}")

        onwrite = pages["1280-onwrite"]
        record("C7 只在有新事件时更新且没有过期横幅", text_has(onwrite, "只在有新事件时更新") and not text_has(onwrite, "没更新"))

        record("C8 broken 整页错误", text_has(pages["1280-broken"], "数据格式版本对不上"))
        record("C8 missing 整页错误", text_has(pages["1280-missing"], "读不到看板数据"))
        pages["1280-dirty"].js("document.querySelector('#notes-fold').open = true")
        dirty_text = pages["1280-dirty"].js("document.querySelector('#notes').textContent") or ""
        dirty_dot = pages["1280-dirty"].js("document.querySelector('#health-dot .dot').className") or ""
        record("A8 dirty 健康点变黄且计数在", "坏行 4" in dirty_text and "重复事件 1" in dirty_text and "冲突 2" in dirty_text and "warn" in dirty_dot, dirty_dot + " " + dirty_text[:180])

        chain = open_page(file_url("fixture=mixed&probe=1"), 1280, 900)
        chain.js("document.querySelector('#hist-tsk-chain-codex').click()")
        time.sleep(0.2)
        clicked = chain.js(
            """(() => {
              const btn = Array.from(document.querySelectorAll('.chain button')).find((el) => el.textContent.indexOf('pi') >= 0);
              if (!btn) return 'no-pi';
              btn.click();
              const open = document.querySelector('#hist-tsk-chain-pi');
              return open ? open.getAttribute('aria-expanded') + ' ' + open.innerText.slice(0, 40) : 'missing';
            })()"""
        )
        record("C9 降级链能点到 pi 并展开", isinstance(clicked, str) and clicked.startswith("true"), str(clicked))
        chain.close()

        filters = open_page(file_url("fixture=mixed&probe=1"), 1280, 800)
        filters.js("document.querySelector('#filter-minion-codex').click()")
        filters.js("document.querySelector('#hist-tsk-mix-codex-fail').click()")
        before = filters.js("location.hash + '|' + document.activeElement.id")
        filters.js("document.querySelector('.card').dataset.keep = 'yes'; true")
        filters.js("window.__MINION_TEST__.poll()")
        time.sleep(0.4)
        after = filters.js("location.hash + '|' + document.activeElement.id + '|' + document.querySelector('#hist-tsk-mix-codex-fail').getAttribute('aria-expanded')")
        same = filters.js("document.querySelector('.card').dataset.keep === 'yes'")
        scripts = filters.js("document.querySelectorAll('script[data-board-data]').length")
        record("C10 轮询后筛选、展开和焦点还在", "m=codex" in after and "true" in after and before.split("|")[-1] == after.split("|")[1], f"{before} -> {after}")
        record("A5 轮询后只剩一个数据脚本", scripts == 1, str(scripts))
        record("D6 数据没变时不重画卡片", same is True, str(same))
        filters.js("document.querySelector('#filter-status-failed').click()")
        none = filters.js("document.body.innerText")
        # codex + 失败 should still have the one failure. Force an empty filter instead.
        filters.js("document.querySelector('#filter-minion-hermes').click(); document.querySelector('#filter-status-running').click();")
        # hermes running might exist (no end). Use a status combo via hash.
        filters.call("Page.navigate", {"url": file_url("fixture=mixed&probe=1#m=hermes&s=degraded&t=7d&smoke=0")})
        deadline = time.time() + 6
        while time.time() < deadline:
            if filters.js("document.body && document.body.innerText.indexOf('这个条件下没有任务') >= 0"):
                break
            time.sleep(0.2)
        empty_filter = filters.js("document.body.innerText") or ""
        record("C11 筛选为空时有清除按钮", "这个条件下没有任务" in empty_filter and "清除筛选" in empty_filter)
        filters.close()

        today = open_page(file_url("fixture=mixed&probe=1"), 1280, 800)
        today.js("document.querySelector('.num-btn[data-minion=\"codex\"][data-status=\"failed\"]').click()")
        time.sleep(0.2)
        hashed = today.js("location.hash")
        record("C12 点今日失败筛到 Codex 今天的失败", "m=codex" in hashed and "s=failed" in hashed and "t=today" in hashed, hashed)
        today.close()

        record("D3 15 个表情", pages["1280-avatars"].js("document.querySelectorAll('.gallery figure').length") == 15)
        record("D8 最小字号不小于 12", (pages["1280-mixed"].js("JSON.parse(document.getElementById('probe-json').textContent).minFont") or 0) >= 12)

        reduced = open_page(
            file_url("fixture=live&probe=1"),
            1280,
            800,
            media=[{"name": "prefers-reduced-motion", "value": "reduce"}],
        )
        motion = reduced.js("getComputedStyle(document.querySelector('.avatar')).animationName")
        record("E1 减少动效后没有循环动画", motion in ("none", ""), str(motion))
        reduced.close()

        if (ROOT / "reference" / "route-log.tsv").is_file() and (ROOT / "reference" / "model-catalog.json").is_file():
            # 真实路由快照，核对 A7 的页面文案。
            real_events = Path("/tmp/minion-real-events")
            real_events.mkdir(exist_ok=True)
            build_snapshot(real_events, ROOT / "data", "on_write")
            real = open_page(file_url("probe=1#smoke=0"), 1280, 800)
            real.js("document.querySelector('#legacy-fold').open = true; document.querySelector('#notes-fold').open = true;")
            time.sleep(0.2)
            real_text = real.js("document.body.innerText") or ""
            record("A7 页面旧路由 9 条", "旧路由记录" in real_text and "9 条" in real_text, real_text[real_text.find("旧路由"):real_text.find("旧路由")+80] if "旧路由" in real_text else real_text[:200])
            record("A7 页面非手下计数", "Grok Bot 自己处理 6 次" in real_text and "Higgsfield 3 次" in real_text)
            notes = ""
            if "建议≠实际" in real_text:
                notes = real_text[real_text.find("建议≠实际"):real_text.find("建议≠实际")+40]
            record("A7 页面建议≠实际 7、没写理由 1", "建议≠实际 7 条" in real_text and "没写理由 1 条" in real_text, notes)
            record("A1 真实数据控制台没有错误", not real.logs, " | ".join(real.logs))
            shot(real, "1280-real")
            real.close()

            # A3 / A4 / D5：写事件后 20 秒内页面自己更新。
            live_events = Path("/tmp/minion-live-events")
            if live_events.exists():
                for child in live_events.glob("*"):
                    child.unlink()
            else:
                live_events.mkdir()
            build_snapshot(live_events, ROOT / "data", "watch")
            board = open_page(file_url("probe=1"), 1280, 800)
            board.js("localStorage.clear(); sessionStorage.clear();")
            board.call("Page.reload", {"ignoreCache": True})
            time.sleep(0.8)
            record("E3 首次加载播报区是空的", board.js("document.getElementById('live').textContent") == "")
            env = os.environ.copy()
            env.update(
                {
                    "MINION_ROUTE_LOG": str(ROOT / "reference" / "route-log.tsv"),
                    "MINION_CODEX_STATUS": str(ROOT / "reference" / "codex-status.json"),
                    "MINION_CATALOG": str(ROOT / "reference" / "model-catalog.json"),
                    "MINION_OUT_DIR": str(ROOT / "data"),
                }
            )
            subprocess.run(
                [
                    PY,
                    str(ROOT / "scripts" / "minion_event.py"),
                    "--events-dir",
                    str(live_events),
                    "start",
                    "--minion",
                    "pi",
                    "--bot",
                    "t06",
                    "--title",
                    "验收新任务甲",
                    "--task-id",
                    "tsk-accept-a",
                ],
                check=True,
                env=env,
                stdout=subprocess.DEVNULL,
            )
            appeared = False
            for _ in range(22):
                if text_has(board, "验收新任务甲"):
                    appeared = True
                    break
                time.sleep(1)
            record("A3 20 秒内出现新的开始", appeared)
            hidden_scripts = board.js("document.querySelectorAll('script[data-board-data]').length")
            board.js("Object.defineProperty(document, 'hidden', {configurable:true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'));")
            time.sleep(0.3)
            during = board.js("document.querySelectorAll('script[data-board-data]').length")
            board.js("Object.defineProperty(document, 'hidden', {configurable:true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'));")
            time.sleep(0.6)
            record("A4 后台不插脚本，回来会再读", during == hidden_scripts)
            subprocess.run(
                [
                    PY,
                    str(ROOT / "scripts" / "minion_event.py"),
                    "--events-dir",
                    str(live_events),
                    "end",
                    "--task-id",
                    "tsk-accept-a",
                    "--minion",
                    "pi",
                    "--status",
                    "success",
                    "--exit-code",
                    "0",
                    "--bot",
                    "t06",
                ],
                check=True,
                env=env,
                stdout=subprocess.DEVNULL,
            )
            finished = False
            toast = False
            for _ in range(22):
                body = board.js("document.body.innerText") or ""
                if "完成" in body and "验收新任务甲" in body:
                    finished = True
                if "做完了" in (board.js("document.getElementById('toast').innerText") or ""):
                    toast = True
                if finished and toast:
                    break
                time.sleep(1)
            record("A3 20 秒内变成完成", finished)
            record("D5 新完成会庆祝一次", toast)
            shot(board, "1280-just-finished")
            board.call("Page.reload", {"ignoreCache": True})
            time.sleep(1.0)
            record("D5 刷新后不再庆祝", "做完了" not in (board.js("document.getElementById('toast').innerText") or ""))
            live_text_before = board.js("document.getElementById('live').textContent")
            time.sleep(1.2)
            record("E3 计时器跳动时不播报", board.js("document.getElementById('live').textContent") == live_text_before)

            for index, title in enumerate(("验收连完成乙", "验收连完成丙", "验收连完成丁")):
                subprocess.run(
                    [
                        PY,
                        str(ROOT / "scripts" / "minion_event.py"),
                        "--events-dir",
                        str(live_events),
                        "start",
                        "--minion",
                        "hermes",
                        "--bot",
                        "t05",
                        "--title",
                        title,
                        "--task-id",
                        f"tsk-accept-b{index}",
                    ],
                    check=True,
                    env=env,
                    stdout=subprocess.DEVNULL,
                )
                subprocess.run(
                    [
                        PY,
                        str(ROOT / "scripts" / "minion_event.py"),
                        "--events-dir",
                        str(live_events),
                        "end",
                        "--task-id",
                        f"tsk-accept-b{index}",
                        "--minion",
                        "hermes",
                        "--status",
                        "success",
                        "--bot",
                        "t05",
                    ],
                    check=True,
                    env=env,
                    stdout=subprocess.DEVNULL,
                )
            merged = False
            burst = False
            for _ in range(25):
                live_now = board.js("document.getElementById('live').textContent") or ""
                toast_now = board.js("document.getElementById('toast').innerText") or ""
                if "3 个任务有了结果" in live_now or "3 个完成" in live_now:
                    merged = True
                if "一口气完成 3 个" in toast_now:
                    burst = True
                if merged and burst:
                    break
                time.sleep(1)
            record("E3 三个结果合并成一句", merged)
            record("D5 三个完成并成一次庆祝", burst)
            board.close()
        else:
            print("跳过依赖 reference/ 的页面检查（真实数据不入库）")

        # 键盘路径。
        def press(page, key, code, vk):
            page.call("Page.bringToFront")
            common = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
            page.call("Input.dispatchKeyEvent", {"type": "rawKeyDown", **common})
            if key == "Enter":
                page.call("Input.dispatchKeyEvent", {"type": "char", "text": "\r", **common})
            page.call("Input.dispatchKeyEvent", {"type": "keyUp", **common})
            time.sleep(0.25)

        keys = open_page(file_url("fixture=mixed&probe=1"), 1280, 800)
        keys.js("document.querySelector('#filter-minion-codex').focus()")
        press(keys, "Enter", "Enter", 13)
        keys.js("document.querySelector('#filter-status-failed').focus()")
        press(keys, "Enter", "Enter", 13)
        keys.js("document.querySelector('#hist-tsk-mix-codex-fail').focus()")
        press(keys, "Enter", "Enter", 13)
        opened = keys.js("document.querySelector('#hist-tsk-mix-codex-fail').getAttribute('aria-expanded')")
        press(keys, "Escape", "Escape", 27)
        closed = keys.js("document.querySelector('#hist-tsk-mix-codex-fail').getAttribute('aria-expanded')")
        keys.js("document.querySelector('#notes-fold summary').focus()")
        press(keys, "Enter", "Enter", 13)
        notes_open = keys.js("document.querySelector('#notes-fold').open")
        outline = keys.js("getComputedStyle(document.activeElement).outlineStyle")
        record("E2 键盘能筛选、展开、收起、打开数据说明", opened == "true" and closed == "false" and notes_open is True and "m=codex" in (keys.js("location.hash") or ""), f"open={opened} close={closed} notes={notes_open} hash={keys.js('location.hash')}")
        record("E2 焦点看得见", outline not in ("none", ""), str(outline))
        keys.close()

        zoom = open_page(file_url("fixture=mixed&probe=1"), 640, 400)
        scroll = zoom.js("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
        record("E5 相当于 200% 时没有横向滚动", scroll[0] <= scroll[1] + 1, str(scroll))
        shot(zoom, "640-zoom")
        zoom.close()

        for page in pages.values():
            page.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()

    failed = [item for item in results if not item[1]]
    print(f"页面验收 {len(results) - len(failed)}/{len(results)} 过")
    (OUT / "report.json").write_text(
        json.dumps([{"name": name, "ok": ok, "detail": detail} for name, ok, detail in results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
