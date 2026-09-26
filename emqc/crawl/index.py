"""Pick where to crawl from a volume's segment_properties table (a few MB, the cheapest step there is)."""
from __future__ import annotations

import gzip
import json
import urllib.request

H01_PROPS_URL = "https://storage.googleapis.com/h01-release/data/20210601/c3/segment_properties/info"


MAX_PROPS_BYTES = 64 * 1024 * 1024       # H01 的表压缩后几 MB；再大就不是它了，别把内存读爆


def load_properties(url: str = H01_PROPS_URL, timeout: float = 120, allow_local: bool = False) -> dict:
    """读 segment_properties 表。接口调用（allow_local=False）只允许 https；命令行可以读本地文件或 http。"""
    if not allow_local and not url.startswith("https://"):
        raise ValueError("segment_properties 只能从 https 地址读")
    with urllib.request.urlopen(url, timeout=timeout) as r:
        raw = r.read(MAX_PROPS_BYTES + 1)
    if len(raw) > MAX_PROPS_BYTES:
        raise ValueError(f"segment_properties 超过 {MAX_PROPS_BYTES // 2**20} MB，拒绝读取")
    if raw[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=__import__("io").BytesIO(raw)) as g:
            raw = g.read(MAX_PROPS_BYTES * 4 + 1)
        if len(raw) > MAX_PROPS_BYTES * 4:
            raise ValueError("segment_properties 解压后太大，拒绝读取")
    return json.loads(raw.decode("utf-8"))


def parse(props: dict) -> tuple[list[dict], list[str]]:
    """-> ([{id, features..., tags: [...]}, ...], all_tag_names)"""
    inline = props.get("inline", {})
    plist = inline.get("properties", [])
    ids = inline.get("ids") or []
    tag_prop = next((p for p in plist if p.get("type") == "tags"), None)
    tag_names = list(tag_prop.get("tags", [])) if tag_prop else []
    num = [p for p in plist if p.get("type") == "number"]
    out = []
    for i, sid in enumerate(ids):
        row = {"id": int(sid)}
        for p in num:
            try:
                row[p.get("id") or p.get("description") or "value"] = float(p["values"][i])
            except (IndexError, KeyError, TypeError, ValueError):
                pass
        if tag_prop:
            try:
                row["tags"] = [tag_names[t] for t in tag_prop["values"][i] if 0 <= t < len(tag_names)]
            except (IndexError, KeyError, TypeError):
                row["tags"] = []
        out.append(row)
    return out, tag_names


def select(rows: list[dict], tag: str | None = None, min_voxels: float = 0.0, size_key: str = "num_voxels", top: int = 20) -> list[dict]:
    sel = [r for r in rows if (tag is None or tag in (r.get("tags") or []))]
    if min_voxels:
        sel = [r for r in sel if float(r.get(size_key, 0)) >= min_voxels]
    sel.sort(key=lambda r: -float(r.get(size_key, 0)))
    return sel[:top]
