"""后台任务排队：QC、导出、爬取各自同一时间只跑一个，后来的排队等（状态一直是 queued）。

这台服务器首先是给标注员用的：几个大任务同时跑会把 CPU、内存和磁盘带宽吃满，标注员那边翻片、落笔跟着卡。
排队的任务照样能取消（取消标记在它开始跑之后第一时间生效）。
"""
from __future__ import annotations

import threading

_SLOTS = {kind: threading.BoundedSemaphore(1) for kind in ("qc", "export", "crawl")}


def slot(kind: str) -> threading.BoundedSemaphore:
    return _SLOTS[kind]
