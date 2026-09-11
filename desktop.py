import os
import socket
import subprocess
import sys
import time
import urllib.request

import webview


def app_root():
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def writable_root():
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    path = os.path.join(base, 'RomMTranslator')
    os.makedirs(path, exist_ok=True)
    return path


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_until_ready(url, process, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'Node 后端启动失败，退出码 {process.returncode}')
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                if response.status < 500:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError('等待 Node 后端启动超时')


def main():
    root = app_root()
    node = os.path.join(root, 'node', 'node.exe')
    server = os.path.join(root, 'server.js')
    if not os.path.isfile(node):
        raise RuntimeError(f'未找到内置 Node.js: {node}')
    if not os.path.isfile(server):
        raise RuntimeError(f'未找到 server.js: {server}')

    port = free_port()
    env = os.environ.copy()
    env['PORT'] = str(port)
    env['HOST'] = '127.0.0.1'
    env['ROMM_TRANSLATOR_DATA_DIR'] = writable_root()

    # 开发模式继续从项目根目录读取 .env；打包后从 EXE 所在目录读取外置 .env。
    # server.js 顶部的 require('dotenv').config() 会基于 Node 进程的 cwd 自动加载它。
    config_root = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else root
    process = subprocess.Popen([node, server], cwd=config_root, env=env)
    url = f'http://127.0.0.1:{port}'
    try:
        wait_until_ready(url, process)
        webview.create_window('RomM 汉化工作台', url, width=1400, height=900, min_size=(900, 600))
        webview.start(gui='edgechromium')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(exc), 'RomM Translator 启动失败', 0x10)
        except Exception:
            print(exc, file=sys.stderr)
        sys.exit(1)
