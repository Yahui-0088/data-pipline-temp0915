"""外部传进来的名字（数据集 id、客户端名）的格式校验。

这些名字会被拼进目录路径、写进页面：带 "/" 或 ".." 能写到数据目录外面，带引号、尖括号能在别人打开页面时跑脚本。
通过接口新建的一律按严格格式；从磁盘扫描出来的旧数据集只拦真正危险的字符，免得已有的数据集突然注册不上。
"""
from __future__ import annotations

import re

DATASET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CLIENT_RE = re.compile(r"^[\w.@:+-]{1,64}$")
_UNSAFE = re.compile(r"[<>\"'`&\\/\x00-\x1f\x7f]")


def check_dataset_id(v: str) -> str:
    v = (v or "").strip()
    if not DATASET_ID_RE.match(v):
        raise ValueError("数据集 id 只能用英文字母、数字和 _ . -，以字母或数字开头，最长 128 个字符")
    return v


def check_client(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    if not CLIENT_RE.match(v):
        raise ValueError("客户端名只能用字母、数字和 _ . @ : + -，最长 64 个字符")
    return v


def check_scanned_id(v: str) -> str:
    """磁盘上扫出来的数据集 id（目录名或 dataset.json 里写的）：不能带路径分隔符、引号、尖括号和控制字符，也不能是 . 或 ..。"""
    if not v or v in (".", "..") or len(v) > 128 or _UNSAFE.search(v):
        raise ValueError(f"数据集 id {v!r} 含有不允许的字符（路径分隔符、引号、尖括号或控制字符），已跳过；请改目录名或 dataset.json 里的 dataset_id")
    return v
