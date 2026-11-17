#!/usr/bin/env python3
"""Start Changqu and open the local browser page."""
from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

APP = Path(__file__).resolve().parent
ROOT = APP.parent


def free_port(start=8765, end=8785):
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("8765–8785 端口都被占用，请关闭其他服务后重试。")


def main():
    if sys.version_info < (3, 9):
        print("需要 Python 3.9 或更高版本。")
        return 1
    port = free_port()
    import os
    os.environ["CHANGQU_PORT"] = str(port)
    sys.path.insert(0, str(APP))
    import server
    server.PORT = port

    def open_browser():
        time.sleep(0.9)
        webbrowser.open(f"http://127.0.0.1:{port}/")

    threading.Thread(target=open_browser, daemon=True).start()
    print(f"昌衢 Changqu 启动：http://127.0.0.1:{port}/")
    print("离线可用。刷新真实数据会请求中央气象台与 Valhalla；无网络时保留旧快照。")
    print("按 Ctrl+C 停止。")
    server.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
