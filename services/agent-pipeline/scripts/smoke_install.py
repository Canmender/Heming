"""不依赖 docker 的「容器形态」冒烟：打 wheel → 干净 venv 装 → 起 serve → 探活。

Dockerfile 干的事就是「把 wheel 装进基础镜像，然后跑 ``agent-pipeline serve``」。
本机没有 docker（Windows 上没有可用的守护进程，WSL 发行版也坏了）时，
这条路能把「装包 → 起进程 → 入站鉴权 → 知识库写入/查询/删除」验证到，
剩下没法本地验证的只有镜像层：基础镜像来源、卷挂载、非 root 用户。

用法::

    python scripts/smoke_install.py           # 跑一遍，成功返回 0
    python scripts/smoke_install.py --keep    # 保留临时目录（排查用）
    python scripts/smoke_install.py --timeout 90

依赖：``uv``（建 venv 与打 wheel；uv 建的 venv 里没有 pip，所以不能退回 ``python -m pip``）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "smoke-token-" + str(os.getpid())


def _run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    """跑一条命令，失败就带上输出抛错（这些步骤失败没有「重试一下就好」的空间）。"""
    completed = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise SystemExit(f"命令失败（{completed.returncode}）：{' '.join(cmd)}\n{completed.stdout}")
    return completed.stdout


def _venv_python(venv_dir: Path) -> Path:
    candidates = (venv_dir / "Scripts" / "python.exe", venv_dir / "bin" / "python")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit(f"找不到虚拟环境里的 python：{venv_dir}")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(
    method: str,
    url: str,
    *,
    payload: dict | None = None,
    token: str | None = TOKEN,
    timeout: float = 10.0,
) -> tuple[int, str]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def _wait_health(base: str, process: subprocess.Popen[str], timeout: float) -> dict:
    """等 ``/health`` 起来；进程中途死掉要立刻报错，而不是干等到超时。"""
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise SystemExit(f"serve 进程提前退出（{process.returncode}）：\n{output}")
        try:
            status, body = _request("GET", f"{base}/health", token=None, timeout=2.0)
            if status == 200:
                return json.loads(body)
            last_error = f"HTTP {status}: {body[:200]}"
        except (urllib.error.URLError, TimeoutError, OSError) as exc:  # 还没监听
            last_error = str(exc)
        time.sleep(0.2)
    raise SystemExit(f"/health 在 {timeout:.0f}s 内没起来（最后一次：{last_error}）")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="容器形态冒烟（不需要 docker）")
    parser.add_argument("--keep", action="store_true", help="保留临时目录")
    parser.add_argument("--timeout", type=float, default=60.0, help="等 /health 的上限秒数")
    args = parser.parse_args(argv)

    # 临时目录放在仓库内而不是系统 %TEMP%：某些受限环境里子进程对 %TEMP% 没有写权限
    # （uv 打 wheel、SQLite 建库都会因此报「拒绝访问」）。仓库内的目录一定会被清理。
    workdir = Path(tempfile.mkdtemp(prefix=".tmp-smoke-", dir=ROOT))
    # uv 的默认缓存在 %LOCALAPPDATA%、解包临时目录在 %TEMP%：受限环境里子进程都写不进去，
    # 统一改到工作目录内（否则 uv 会在建 venv / 装构建依赖时报「拒绝访问」）。
    tmp_dir = workdir / "tmp"
    tmp_dir.mkdir()
    uv_env = {
        **os.environ,
        "UV_CACHE_DIR": str(workdir / "cache"),
        "UV_LINK_MODE": "copy",
        "TMPDIR": str(tmp_dir),
        "TEMP": str(tmp_dir),
        "TMP": str(tmp_dir),
    }
    process: subprocess.Popen[str] | None = None
    try:
        print(f"[1/5] 打 wheel：{ROOT}")
        _run(["uv", "build", "--wheel", "--out-dir", str(workdir / "dist")], env=uv_env)
        wheel = next((workdir / "dist").glob("*.whl"))

        print(f"[2/5] 建干净 venv 并装入 {wheel.name}")
        _run(["uv", "venv", "--python", sys.version.split()[0], str(workdir / "venv")], env=uv_env)
        python = _venv_python(workdir / "venv")
        _run(["uv", "pip", "install", "--python", str(python), str(wheel)], env=uv_env)

        print("[3/5] 按 Dockerfile 的 CMD 起 serve（带入站令牌）")
        data_dir = workdir / "data"
        data_dir.mkdir()
        port = _free_port()
        env = os.environ.copy()
        env.update(
            {
                "AGENT_SERVICE_TOKEN": TOKEN,
                "AGENT_LOG_PATH": str(data_dir / "runs.jsonl"),
                "AGENT_PIPELINE_DB": str(data_dir / "pipeline.db"),
                # 冒烟不调真模型：只验证进程能起、鉴权与知识库通路。
                "AGENT_PIPELINE_API_KEY": "smoke-not-used",
                "AGENT_TUNE_ENABLED": "0",
            }
        )
        process = subprocess.Popen(
            [str(python), "-m", "agent_pipeline.runner", "serve", "--host", "127.0.0.1", "--port", str(port)],
            cwd=str(workdir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        base = f"http://127.0.0.1:{port}"
        health = _wait_health(base, process, args.timeout)
        print(f"      /health ok={health.get('ok')} auth={health.get('auth')} tools={health.get('tools')}")
        if health.get("auth") != "on":
            raise SystemExit("入站鉴权没开：AGENT_SERVICE_TOKEN 没生效")
        if "knowledge_search" not in (health.get("tools") or []):
            raise SystemExit("知识库工具没注册：memory 没接进注册表")

        print("[4/5] 入站鉴权：无令牌必须 401、带令牌必须 200")
        status, _ = _request("GET", f"{base}/v1/tools", token=None)
        if status != 401:
            raise SystemExit(f"无令牌访问 /v1/tools 返回 {status}，应当是 401")
        status, _ = _request("GET", f"{base}/v1/tools")
        if status != 200:
            raise SystemExit(f"带令牌访问 /v1/tools 返回 {status}，应当是 200")

        print("[5/5] 知识库：写入 → 规模 → 查询 → 删除")
        status, body = _request("POST", f"{base}/v1/knowledge", payload={"doc_id": "smoke-1", "text": "和鸣安装器支持通用外壳，跨版本复用。", "title": "冒烟"})
        if status != 200 or json.loads(body)["chunks"] < 1:
            raise SystemExit(f"写入知识库失败：{status} {body[:200]}")
        status, body = _request("GET", f"{base}/v1/knowledge")
        stats = json.loads(body)
        if status != 200 or stats["documents"] != 1:
            raise SystemExit(f"知识库规模不对：{status} {stats}")
        status, _ = _request("DELETE", f"{base}/v1/knowledge/smoke-1")
        if status != 200:
            raise SystemExit(f"删除知识库文档失败：{status}")
        status, body = _request("GET", f"{base}/metrics", token=None)
        if status != 200 or "pipeline_runs_total" not in body:
            raise SystemExit(f"/metrics 不可用或缺少指标：{status}")

        print("冒烟通过：装包 → 起进程 → 鉴权 → 知识库 → /metrics 全部正常")
        return 0
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        if args.keep:
            print(f"保留临时目录：{workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())