#!/usr/bin/env python
"""守护脚本：服务进程退出（崩溃、被系统因内存不够杀掉、被 kill -9）就记一笔、推告警、过几秒自动拉起来。

    python scripts/supervise.py -- ./run.sh 8791
    setsid nohup .venv/bin/python scripts/supervise.py -- ./run.sh 8791 >> var/serve.log 2>&1 < /dev/null &

- 部署新代码：只杀服务进程（pkill -f "serve[.]py 8791"），它会正常退出（lifecycle 里记 stop），守护脚本看到是正常退出，
  不告警、马上用新代码重启。
- 彻底停掉：杀守护脚本本身（kill <守护脚本 pid>），它把信号转给服务进程、等它退出，然后自己也退出，不再重启。
- 异常退出记在 var/log/lifecycle.jsonl（event=exit，带退出码或信号）；10 分钟内重启超过 5 次就改成每分钟试一次，免得刷屏。
- 告警地址读 EMQC_ALERT_WEBHOOK（环境变量或项目根目录的 .env；写在 run.sh 里的这里看不到）。
- 转发停止信号后服务 30 秒还没退出（卡在某个请求里），就 SIGKILL 它。
- 磁盘写满时记日志会失败：守护脚本照样守护，只是少记几笔，不能因此自己先退出。
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from emqc import logs  # noqa: E402

STOP_GRACE_S = float(os.environ.get("EMQC_SUPERVISE_GRACE_S", "30"))


def _say(msg: str) -> None:
    try:
        print(msg, flush=True)
    except OSError:
        pass


def _event(event: str, **fields) -> None:
    try:
        logs.lifecycle_event(event, **fields)
    except OSError as e:
        _say(f"[supervise] 进程启停记录没写成（{e}），继续守护")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--max-restarts", type=int, default=0, help="最多重启几次后放弃（0 = 不限；测试用）")
    ap.add_argument("--delay", type=float, default=3.0, help="异常退出后等几秒再拉起")
    ap.add_argument("cmd", nargs=argparse.REMAINDER, help="-- 之后是启动服务的命令")
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        ap.error("要给出启动命令，例如：-- ./run.sh 8791")

    stopping = False
    stop_at = 0.0
    child: subprocess.Popen | None = None

    def forward(signum, _frame):
        nonlocal stopping, stop_at
        stopping = True
        stop_at = stop_at or time.time()
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    def wait_child() -> int:
        """等服务退出；收到停止信号后 STOP_GRACE_S 秒还没退出就 SIGKILL。"""
        while True:
            try:
                return child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if stopping and time.time() - stop_at > STOP_GRACE_S:
                    _say(f"[supervise] 服务 {STOP_GRACE_S:.0f} 秒内没有退出，强制结束")
                    child.kill()

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)

    env = dict(os.environ, EMQC_SUPERVISED="1")
    restarts: list[float] = []
    n = 0
    _say(f"[supervise] pid {os.getpid()} 守护：{' '.join(cmd)}")
    while True:
        try:
            child = subprocess.Popen(cmd, env=env, cwd=os.getcwd())
        except OSError as e:
            child = None
            _say(f"[supervise] 启动服务失败（{e}），60 秒后再试")
            try:
                logs.alert("launch", f"守护脚本启动服务失败（{e}），每分钟重试一次", wait=True)
            except Exception:
                pass
            deadline = time.time() + 60
            while time.time() < deadline and not stopping:
                time.sleep(0.2)
            if stopping:
                _event("supervisor_stop", child_pid=None, code=None)
                return 0
            continue
        if stopping and child.poll() is None:
            child.send_signal(signal.SIGTERM)        # 停止信号正好落在检查和启动之间：刚拉起的也要转告
        rc = wait_child()
        if stopping:
            _event("supervisor_stop", child_pid=child.pid, code=rc)
            _say(f"[supervise] 收到停止信号，服务已退出（code {rc}），守护结束")
            return 0
        try:
            last = next(iter(logs.read_lifecycle(1)), None)
        except OSError:
            last = None
        planned = bool(last and last.get("event") == "stop" and last.get("pid") == child.pid)
        if planned:
            _say("[supervise] 服务正常退出（部署重启），马上拉起")
            delay = 0.5
        else:
            sig = -rc if rc < 0 else None
            why = f"被信号 {signal.Signals(sig).name} 杀掉" if sig else f"退出码 {rc}"
            _event("exit", child_pid=child.pid, code=rc, signal=sig,
                   note=f"服务进程异常退出（{why}）" + ("；SIGKILL 多半是内存不够被系统杀掉，或被人 kill -9" if sig == 9 else ""))
            now = time.time()
            restarts = [t for t in restarts if now - t < 600] + [now]
            delay = 60.0 if len(restarts) > 5 else a.delay
            try:
                logs.alert("crash", f"服务进程异常退出（{why}），{int(delay)} 秒后自动重启；10 分钟内第 {len(restarts)} 次", wait=True)
            except Exception as e:  # 告警失败不能让守护脚本退出
                _say(f"[supervise] 告警没发出去：{e}")
            _say(f"[supervise] 服务异常退出（{why}），{delay:.0f} 秒后重启")
        n += 1
        if a.max_restarts and n > a.max_restarts:
            _say("[supervise] 达到重启次数上限，守护结束")
            return 1
        deadline = time.time() + delay
        while time.time() < deadline and not stopping:
            time.sleep(0.2)
        if stopping:
            _event("supervisor_stop", child_pid=child.pid, code=rc)
            return 0


if __name__ == "__main__":
    sys.exit(main())
