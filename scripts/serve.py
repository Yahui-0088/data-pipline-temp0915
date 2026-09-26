#!/usr/bin/env python
"""Start the API + dashboard (used by .claude/launch.json and scripts/supervise.py; `python -m emqc serve` runs uvicorn with the same options)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402

from emqc.config import settings  # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else settings.api_port
    settings.api_port = port            # 日志、告警里写的是实际端口
    # 逐条访问日志关掉：切片图一翻就是几十条，控制台会被刷满；请求记录改由应用写 var/log/access.log（只记写操作、出错和慢的）
    # proxy_headers=False：前面没有反向代理（大家经 SSH 隧道从 127.0.0.1 进来），开着的话 uvicorn 会相信任何人自己填的
    #   X-Forwarded-For，登录限流和日志里的 IP 就能随便伪造
    # timeout_graceful_shutdown：部署重启时最多等进行中的请求 20 秒，不会卡在一个很慢的请求上一直不退
    uvicorn.run("emqc.api.app:app", host=settings.api_host, port=port, log_level="info", access_log=False,
                proxy_headers=False, timeout_graceful_shutdown=20)
