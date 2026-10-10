"""标注审核（QA sign-off）的核心逻辑：内容哈希、参与人（四眼原则）、状态推算、动作规则、入库版本。

接口在 emqc/api/routers/review.py，表在 emqc/db/models.py（SliceReview / ReviewEvent / ReviewEventMark / AnnotRelease），
设计说明在 docs/REVIEW.md。

审核的单位是一张切片（数据块 + z）。库里只存人做的决定（stored status）：

    open               没标记完成（从没标过，或撤回了）
    completed          标注员标记完成 = 待审核
    approved           审核员通过；绑定通过时这一片标签平面的内容哈希
    changes_requested  审核员退回修改

页面上看到的状态（display status）由决定 + 编辑历史 + 当前像素推算，所以不会有「卡住、没有下一步」的状态：

    not_started   open，这一片没有任何有效改动
    in_progress   open，有改动
    pending       completed（进审核队列）
    approved      approved，当前内容哈希 == 通过时的哈希
    changed       approved，但之后内容变了（通过后被修改）→ 自动回到审核队列
    returned      changes_requested，退回之后还没改
    fixed         changes_requested，退回之后改过了 → 等标注员重新标记完成

为什么用内容哈希而不只用版本号（slice_rev）：版本号是审计流水号，整块合并 / 整块撤销会让每一片的版本号都前进，
哪怕这一片的像素没变；反过来撤销后流水没记上（磁盘满）时像素变了版本号却没动。审核员通过的是「他看到的那些像素」，
所以以哈希为准，版本号只用来记录和做快速判断。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from emqc.annotate.store import CREATED_LABELS, Actor, Block, _check_free

STORED = ("open", "completed", "approved", "changes_requested")
DISPLAY_NAMES = {
    "not_started": "未开始", "in_progress": "标注中", "pending": "待审核", "approved": "已通过",
    "changed": "通过后被修改", "returned": "退回修改", "fixed": "已修改待重新提交",
}
ACTION_NAMES = {"complete": "标记完成", "uncomplete": "撤回完成", "approve": "通过", "request_changes": "退回修改",
                "revoke": "撤销通过"}
QUEUE = ("pending", "changed")                       # 审核员要处理的
DECISIONS = ("approve", "request_changes", "revoke")  # 只有审核员 / 管理员能做，且要密码登录

# 每个动作允许从哪些显示状态出发、落到哪个存库状态
TRANSITIONS = {
    "complete": ({"not_started", "in_progress", "returned", "fixed"}, "completed"),
    "uncomplete": ({"pending"}, "open"),
    "approve": ({"pending", "changed"}, "approved"),
    "request_changes": ({"pending", "approved", "changed"}, "changes_requested"),
    "revoke": ({"approved", "changed"}, "completed"),
}
RELEASE_SCHEMA = 1
RELEASES_DIR = "_releases"


# ------------------------------------------------------------------ 内容哈希
def plane_sha(plane: np.ndarray) -> str:
    """一张标签平面（显示方向：行 = Y，列 = X）的内容哈希：按小端 uint64、C 顺序的字节算 sha256。

    显示方向 C 顺序的字节，恰好等于磁盘上 (X, Y, Z) 数组第 z 片按 F 顺序取出的字节——和 blockledger 的切片哈希
    （sha256(a[:, :, k].tobytes(order='F'))）是同一个数，以后登记到 blockledger 时可以直接对上。"""
    return hashlib.sha256(np.ascontiguousarray(plane, dtype="<u8").tobytes()).hexdigest()


def current_plane(block: Block, z: int) -> np.ndarray:
    """第 z 片当前的标签（显示方向）：和对比页画出来的是同一份读法（直接读工作副本文件，不走缓存）。调用方持有 block.lock。"""
    from emqc.annotate.provenance import _read_arrays

    block._check_z(z)
    return _read_arrays(block, z)[1]


def current_sha(block: Block, z: int) -> str:
    with block.lock:
        return plane_sha(current_plane(block, z))


# ------------------------------------------------------------------ 参与人（四眼原则）
def _key(e: dict):
    if e.get("by_id") is not None:
        return ("id", e["by_id"])
    if isinstance(e.get("by_user"), str) and e["by_user"]:
        return ("user", e["by_user"])
    if isinstance(e.get("by"), str) and e["by"]:
        return ("name", e["by"])
    return None


def contributors(block: Block, z: int) -> tuple[list[dict], int]:
    """谁动过第 z 片：(参与人列表, 没署名的笔数)。

    算进来的有：这一片上仍然有效的改动的作者；所有落在这一片上的写入流水（包括后来被撤销掉的——做过就是参与过）；
    以及在这一片上做过撤销的人（撤掉别人的改动同样改变了这一片的内容，不能撤完别人的再自己通过）。
    3-D 操作（流水里 z 为空）：有效的按像素记录精确判断是否落在这一片；整块撤销保守地算在每一片上。"""
    people: dict = {}
    unattributed = 0

    def add(e: dict, count_unattributed: bool = True) -> None:
        nonlocal unattributed
        k = _key(e)
        if k is None:
            # 没署名的只按「仍然有效的改动」和「撤销」各算一次；写入流水里的同一笔不重复计
            unattributed += 1 if count_unattributed else 0
            return
        p = people.setdefault(k, {"by": e.get("by"), "by_user": e.get("by_user"), "by_id": e.get("by_id"), "n": 0})
        p["n"] += 1
        for f in ("by", "by_user", "by_id"):
            if p.get(f) is None and e.get(f) is not None:
                p[f] = e[f]

    with block.lock:
        for rec in block.edits(z):
            add(rec)
        for e in block.audit_entries():
            if e.get("action") == "undo" and (e.get("z") is None or e.get("z") == z):
                add(e)
            elif e.get("action") == "edit" and e.get("z") == z:
                add(e, count_unattributed=False)
    # 同一个人在有效改动和流水里各算了一次：n 只是给人看的笔数，按流水为准大致即可，不用精确去重
    return list(people.values()), unattributed


def is_contributor(actor: Actor, people: list[dict]) -> bool:
    """actor 是不是参与人之一。先比用户 id，其次账号名；旧记录只有名字的，名字等于他的显示名或账号名都算（宁严勿宽）。"""
    for p in people:
        if p.get("by_id") is not None and actor.id is not None:
            if p["by_id"] == actor.id:
                return True
            continue
        if p.get("by_user") and actor.user is not None:
            if p["by_user"] == actor.user:
                return True
            continue
        if p.get("by") and p["by"] in {actor.name, actor.user}:
            return True
    return False


# ------------------------------------------------------------------ 每片的版本号、改动人（一次扫完整块）
def slice_revs(block: Block) -> list[int]:
    """每一片的版本号（同 Block.slice_rev，但一次扫完整块流水，给进度页用）。"""
    nz = block.nz
    last = [0] * nz
    last_none = 0
    for e in block.audit_entries():
        z = e.get("z")
        if z is None:
            last_none = int(e["seq"])
        elif isinstance(z, int) and 0 <= z < nz:
            last[z] = int(e["seq"])
    return [max(a, last_none) for a in last]


def slice_editors(block: Block) -> dict[int, dict]:
    """每一片上仍然有效的改动：{z: {"editors": {显示名: 笔数}, "n": 笔数, "last_ts": 最后一笔时间, "keys": 参与人键}}。
    3-D 改动读一次它的像素记录，分到它真正落到的那几片。"""
    out: dict[int, dict] = defaultdict(lambda: {"editors": defaultdict(int), "n": 0, "last_ts": None, "keys": set(),
                                                "unattributed": 0})

    def add(z: int, rec: dict) -> None:
        d = out[z]
        d["editors"][rec.get("by") or "未署名"] += 1
        d["n"] += 1
        k = _key(rec)
        if k is None:
            d["unattributed"] += 1
        else:
            d["keys"].add(k)
        ts = rec.get("ts")
        if isinstance(ts, str) and (d["last_ts"] is None or ts > d["last_ts"]):
            d["last_ts"] = ts

    for rec in block.edits():
        if rec.get("z") is not None:
            add(int(rec["z"]), rec)
            continue
        try:
            data = block._load_edit(rec["n"], ("zs", "z", "xs"))
        except ValueError:
            continue
        zs = data["zs"] if "zs" in data else np.full(np.shape(data.get("xs", [])), int(data.get("z", -1)))
        for z in np.unique(zs):
            if 0 <= int(z) < block.nz:
                add(int(z), rec)
    return {z: {**d, "editors": dict(d["editors"])} for z, d in out.items()}


def slice_contributor_keys(block: Block, editors: dict[int, dict]) -> dict[int, set]:
    """每一片的参与人键（同 contributors 的口径，但一次扫完整块）：有效改动的作者 + 这一片上的写入流水 + 撤销流水。"""
    keys: dict[int, set] = defaultdict(set)
    for z, d in editors.items():
        keys[z] |= d["keys"]
    every: set = set()
    for e in block.audit_entries():
        k = _key(e)
        if k is None:
            continue
        z = e.get("z")
        if e.get("action") == "undo" and z is None:
            every.add(k)
        elif e.get("action") in ("edit", "undo") and isinstance(z, int):
            keys[z].add(k)
    if every:
        for z in range(block.nz):
            keys[z] |= every
    return keys


def actor_matches(actor: Actor, keys: set) -> bool:
    """参与人键里有没有 actor（口径同 is_contributor）。"""
    return (("id", actor.id) in keys if actor.id is not None else False) or \
        (actor.user is not None and ("user", actor.user) in keys) or \
        any(("name", n) in keys for n in {actor.name, actor.user} if n)


# ------------------------------------------------------------------ 状态推算
def display_status(stored: str, has_edits: bool, *, approved_fresh: bool | None = None, edited_since_decision: bool = False) -> str:
    if stored == "completed":
        return "pending"
    if stored == "approved":
        return "approved" if approved_fresh else "changed"
    if stored == "changes_requested":
        return "fixed" if edited_since_decision else "returned"
    return "in_progress" if has_edits else "not_started"


def ts_iso(ts: str | None) -> str | None:
    """编辑记录里的时间是服务器本地时间、不带时区；转成带时区的 ISO，和库里的 UTC 时间放在一起比较、显示不会差几个小时。"""
    if not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts).astimezone().isoformat(timespec="seconds")
    except ValueError:
        return None


def db_iso(dt: datetime | None) -> str | None:
    return dt.replace(tzinfo=timezone.utc).isoformat(timespec="seconds") if dt else None


# ------------------------------------------------------------------ 入库版本
_release_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)


def releases_root(workdir: Path) -> Path:
    return Path(workdir) / RELEASES_DIR


def _fsync_dir(p: Path) -> None:
    try:
        fd = os.open(p, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write(path: Path, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def _sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def plan_release(block: Block, approved: dict[int, dict]) -> dict:
    """看一眼这次入库会收哪些片、不收哪些片（不写任何东西）。approved: {z: {"sha": 通过时的哈希, ...}}。
    读盘一次（整块拷到内存）在块锁里做，保证所有片是同一时刻的内容。"""
    with block.lock:
        vol = np.array(block._seg())                 # (X, Y, Z)，整块一次读出：同一时刻的快照
        audit = block.audit_entries()
        seq = int(audit[-1]["seq"]) if audit else 0
    included, excluded = [], []
    for z in range(block.nz):
        a = approved.get(z)
        if a is None:
            continue
        sha = plane_sha(vol[:, :, z].T)
        if sha == a["sha"]:
            included.append(z)
        else:
            excluded.append({"z": z, "reason": "changed", "message": "通过后被修改，重新通过后才能入库"})
    return {"vol": vol, "audit_seq": seq, "included": included, "excluded": excluded}


def write_release(block: Block, workdir: Path, plan: dict, approved: dict[int, dict], *, created_by: dict, note: str | None,
                  code_commit: str | None) -> dict:
    """把计划好的片冻结成一个只读版本：<工作目录>/_releases/<块>/v<N>/。

    seg.npy 与原始 seg.npy 形状、类型、轴顺序（含是否 F 顺序）完全一致；没收的片全是 0，reviewed_z.npy 标出哪些片有效。
    先写进临时目录、逐个文件落盘，最后原子改名成 v<N>——要么整个版本出现，要么什么都没有。"""
    vol = plan["vol"]
    included = plan["included"]
    if not included:
        raise ValueError("没有可以入库的切片：需要至少一片「已通过」且通过后没再改过")
    root = releases_root(workdir) / block.id
    root.mkdir(parents=True, exist_ok=True)
    rel = np.zeros_like(vol)
    for z in included:
        rel[:, :, z] = vol[:, :, z]
    if block._seg_ro is not None and block._seg_ro.flags.f_contiguous and not block._seg_ro.flags.c_contiguous:
        rel = np.asfortranarray(rel)
    mask = np.zeros(block.nz, dtype=bool)
    mask[included] = True
    _check_free(root, int(rel.nbytes) + (64 << 20))
    created = set()
    try:
        created = {str(i) for i in json.loads((block.work_path(CREATED_LABELS)).read_text())}
    except (OSError, ValueError):
        pass
    created_present = sorted(i for i in {str(int(v)) for z in included for v in np.unique(vol[:, :, z])} if i in created)

    with _release_locks[block.id]:
        existing = [int(p.name[1:]) for p in root.iterdir() if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit()]
        version = max(existing, default=0) + 1
        tmp = root / f".tmp-{uuid.uuid4().hex[:8]}"
        tmp.mkdir()
        try:
            with open(tmp / "seg.npy", "wb") as fh:
                np.save(fh, rel)
                fh.flush()
                os.fsync(fh.fileno())
            with open(tmp / "reviewed_z.npy", "wb") as fh:
                np.save(fh, mask)
                fh.flush()
                os.fsync(fh.fileno())
            slices = []
            for z in included:
                a = approved[z]
                slices.append({"z": z, "sha256": a["sha"], "approved_rev": a.get("rev"), "approved_by": a.get("by"),
                               "approved_at": a.get("at"), "decision_event_id": a.get("event_id"),
                               "contributors": a.get("contributors") or []})
            seg_src = block.path / "seg.npy"
            manifest = {
                "schema_version": RELEASE_SCHEMA, "kind": "annotation_release", "block_id": block.id, "version": version,
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "created_by": created_by, "note": note,
                "approval_scope": "whole_slice",          # 「通过」= 整张切片都正确，可以当训练真值（用户 2026-10-10 定）
                "label_semantics": "原始分割的标签 id；标注中新建的 id 列在 created_label_ids（只在本数据块内唯一，跨块合并前要重新映射）",
                "array": {"file": "seg.npy", "shape": list(rel.shape), "dtype": str(rel.dtype), "axes": "XYZ",
                          "fortran_order": bool(rel.flags.f_contiguous and not rel.flags.c_contiguous),
                          "display_plane": "seg[:, :, z].T（行 = Y，列 = X）",
                          "unreviewed_slices": "全为 0；以 reviewed_z.npy 为准"},
                "reviewed_z_file": "reviewed_z.npy", "n_reviewed": len(included), "z_list": included,
                "excluded": plan["excluded"],
                "source": {"block_path": str(block.path), "seg": str(seg_src), "em": str(block.path / "em.npy"),
                           "em_shape": list(block.em.shape), "meta": block.meta, "workdir_audit_seq": plan["audit_seq"]},
                "slice_hash": "sha256(seg[:, :, z].tobytes(order='F')) 按小端 uint64，等于显示方向平面按 C 顺序的字节",
                "slices": slices, "created_label_ids": created_present, "platform_commit": code_commit,
            }
            _write(tmp / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1).encode())
            sums = "".join(f"{_sha_file(tmp / f)}  {f}\n" for f in ("seg.npy", "reviewed_z.npy", "manifest.json"))
            _write(tmp / "checksums.sha256", sums.encode())
            _fsync_dir(tmp)
            final = root / f"v{version}"
            os.rename(tmp, final)                    # ← 提交点：之前失败什么都不留，之后就是一个完整版本
            _fsync_dir(root)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        # 文件设为只读（防手滑改写）；目录不设只读，否则按天数清理旧备份时删不掉里面的文件
        for f in final.iterdir():
            try:
                f.chmod(0o444)
            except OSError:
                pass
        return {"version": version, "path": str(final.relative_to(Path(workdir))), "manifest_sha256": _sha_file(final / "manifest.json"),
                "n_slices": len(included), "z_list": included, "audit_seq": plan["audit_seq"], "excluded": plan["excluded"]}
