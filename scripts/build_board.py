#!/usr/bin/env python3
"""build_snapshot.py 的别名。

页面上的报错文案写的是 python3 scripts/build_board.py，所以保留这个入口。
"""
from __future__ import annotations

import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().with_name("build_snapshot.py")), run_name="__main__")
