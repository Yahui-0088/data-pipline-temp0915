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
import weakref
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from emqc.annotate.store import CREATED_LABELS, SEG_EDIT, Actor, Block, _check_free

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
RELEASE_SCHEMA = 2                                   # 2：按批次入库（v1 是按单个数据块，从没上线过）
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


# 每个块（按共享状态对象）每一片的哈希缓存：{z: ((像素版本, 有没有工作副本), sha)}。像素一写版本就加一（工作台、对比页共享），
# 缓存自然失效；整块合并之类让版本号前进但没动这一片像素的操作不会让它失效——这一片的像素版本没变。
_SHA_CACHE: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _sha_key(block: Block, z: int):
    # 带上源目录：还没有工作副本时内容来自源 seg.npy，换了源目录（改名、同名块）就不能沿用旧的哈希
    return (block._gen(z), block.work_path(SEG_EDIT).exists(), str(block.path))


def remember_sha(block: Block, z: int, plane: np.ndarray) -> str:
    """调用方持有 block.lock、手里正好有这一片当前的平面（例如对比页刚读出来的）：算哈希并记进缓存。"""
    sha = plane_sha(plane)
    _SHA_CACHE.setdefault(block._shared, {})[z] = (_sha_key(block, z), sha)
    return sha


def current_sha(block: Block, z: int) -> str:
    """第 z 片当前内容的哈希。在块锁里取（写像素也都在块锁里，读到的就是某一个完整的版本）；缓存命中就不读像素。
    没命中时优先用已经缓存的标签索引图还原平面（ids[idx] 与原平面逐位相同），否则读一次工作副本。"""
    with block.lock:
        key = _sha_key(block, z)
        memo = _SHA_CACHE.setdefault(block._shared, {})
        hit = memo.get(z)
        if hit is not None and hit[0] == key:
            return hit[1]
        try:
            idx, ids = block.labels(z)
            plane = ids[idx]
        except ValueError:                       # 一片里标签太多，索引图放不下：直接读平面
            plane = block.seg_slice(z)
        sha = plane_sha(plane)
        memo[z] = (key, sha)
        return sha


# ------------------------------------------------------------------ 参与人（四眼原则）
def _key(e: dict):
    if e.get("by_id") is not None:
        return ("id", e["by_id"])
    if isinstance(e.get("by_user"), str) and e["by_user"]:
        return ("user", e["by_user"])
    if isinstance(e.get("by"), str) and e["by"]:
        return ("name", e["by"])
    return None


def contributors(block: Block, z: int, records: list[dict] | None = None) -> tuple[list[dict], int]:
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

    # records：调用方已经在块锁里取好的这一片有效改动（省得再解压一遍 3-D 改动的像素记录）；
    # 审计流水是只追加、按文件状态缓存的列表，扫它不用占锁
    recs = block.edits(z) if records is None else records
    active = {r.get("n") for r in recs}
    for rec in recs:
        add(rec)
    for e in block.audit_entries():
        if e.get("action") == "undo" and (e.get("z") is None or e.get("z") == z):
            add(e)
        elif e.get("action") == "edit" and e.get("z") == z:
            add(e, count_unattributed=False)
        elif e.get("action") == "edit" and e.get("z") is None and e.get("n") not in active:
            # 已经不在本片有效改动里的 3-D 改动（被撤销或裁掉了）：流水里记了落到哪几片就按它判断；
            # 旧流水没记，就保守地算它动过每一片（宁严勿宽）
            zs = e.get("zs")
            if zs is None or z in zs:
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
    """每一片上仍然有效的改动：{z: {"editors": {显示名: 笔数}, "n": 笔数, "last_ts": 最后一笔时间, "keys": 参与人键,
    "unreadable": 读不出像素记录的 3-D 改动笔数}}。3-D 改动读一次它的像素记录，分到它真正落到的那几片；
    像素记录丢了或坏了就不知道它落在哪几片——保守地算它动过每一片，并标出来（这些片不能审，要先找管理员修记录）。"""
    out: dict[int, dict] = defaultdict(lambda: {"editors": defaultdict(int), "n": 0, "last_ts": None, "keys": set(),
                                                "unattributed": 0, "unreadable": 0})

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
            data = block._load_edit(rec["n"], ("zs",))            # 只解压 zs；没有 zs 的旧记录才去读 xs
            if "zs" not in data:
                data = block._load_edit(rec["n"], ("z", "xs"))
        except ValueError:
            for z in range(block.nz):
                add(z, rec)
                out[z]["unreadable"] += 1
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
    active = {r.get("n") for r in block.edits()}
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
        elif e.get("action") == "edit" and z is None and e.get("n") not in active:
            zs = e.get("zs")                           # 同 contributors：撤掉了的 3-D 改动按流水里记的切片，旧流水没记就算每一片
            if zs is None:
                every.add(k)
            else:
                for k2 in zs:
                    if 0 <= int(k2) < block.nz:
                        keys[int(k2)].add(k)
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


def batch_of(block_path) -> str:
    """数据块属于哪个批次：它所在的导入目录（数据块目录的上一级）的名字。
    例如 EMQC_ANNOTATE_ROOT=var/annotation/h01-demo-v2 下的块都属于批次 h01-demo-v2；交付目录 blocks/<数据集>/<块>
    按数据集分批。批次不另外登记，从目录结构直接得出：导入一批新数据 = 多一个导入目录。"""
    return Path(block_path).parent.name


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


class ReleaseStale(ValueError):
    """入库途中有人改了某一片的审核结论（退回、撤销通过、重新通过）：这次入库作废，要重新预览。"""


def preview_release(block: Block, approved: dict[int, dict]) -> dict:
    """这次入库会收哪些片、不收哪些片（不写任何东西、不整块读盘）：已通过且当前内容哈希 = 通过时哈希的才收。"""
    included, excluded = [], []
    for z in sorted(approved):
        if current_sha(block, z) == approved[z]["sha"]:
            included.append(z)
        else:
            excluded.append({"z": z, "reason": "changed", "message": "通过后被修改，重新通过后才能入库"})
    return {"included": included, "excluded": excluded}


def snapshot_release(block: Block, approved: dict[int, dict]) -> dict:
    """在块锁里把整块拷进内存（同一时刻的快照），并按同一时刻的内容决定收哪些片。只给真正入库用（要占一份整块大小的内存）。"""
    def stamp():                                 # 这一刻的（流水号, 各片像素版本）：任何写像素都会改变其中之一
        audit = block.audit_entries()
        return (int(audit[-1]["seq"]) if audit else 0), dict(block._shared.gen)

    # 大块整块拷一遍要好几秒：不占着块锁拷（别人照常落笔），拷完在锁里核对这段时间没人写过；写过就重来
    for _ in range(3):
        with block.lock:
            before = stamp()
        vol = np.array(block._seg())             # (X, Y, Z) 私有拷贝；保持源文件的 C / F 顺序
        with block.lock:
            if stamp() == before:
                plan = preview_release(block, approved)   # 锁在手里、期间没人写：哈希和 vol 是同一时刻的内容
                return {**plan, "vol": vol, "audit_seq": before[0]}
        del vol
    with block.lock:                              # 一直有人在写：最后一次在锁里拷，保证一致
        vol = np.array(block._seg())
        plan = preview_release(block, approved)
        return {**plan, "vol": vol, "audit_seq": stamp()[0]}


def _write_npy(path: Path, arr: np.ndarray) -> None:
    with open(path, "wb") as fh:
        np.save(fh, arr)
        fh.flush()
        os.fsync(fh.fileno())


def _write_block(tmp: Path, block: Block, plan: dict, approved: dict[int, dict]) -> dict:
    """把一块的快照写进 tmp/<块>/：seg.npy（没收的片清零）+ reviewed_z.npy。返回 manifest 里这一块的说明。"""
    rel = plan["vol"]                             # 快照是私有拷贝，直接在上面把不收的片清零，不再多占一份内存
    included = plan["included"]
    keep = np.zeros(block.nz, dtype=bool)
    keep[included] = True
    for z in np.flatnonzero(~keep):
        rel[:, :, z] = 0
    src = block._seg_ro
    if src is not None and src.flags.f_contiguous and not src.flags.c_contiguous and not rel.flags.f_contiguous:
        rel = np.asfortranarray(rel)
    d = tmp / block.id
    d.mkdir()
    _check_free(d, int(rel.nbytes) + (64 << 20))
    _write_npy(d / "seg.npy", rel)
    _write_npy(d / "reviewed_z.npy", keep)
    _fsync_dir(d)
    created = set()
    try:
        created = {str(i) for i in json.loads((block.work_path(CREATED_LABELS)).read_text())}
    except (OSError, ValueError):
        pass
    created_present = sorted(i for i in {str(int(v)) for z in included for v in np.unique(rel[:, :, z])} if i in created)
    slices = []
    for z in included:
        a = approved[z]
        slices.append({"z": z, "sha256": a["sha"], "approved_rev": a.get("rev"), "review_version": a.get("version"),
                       "approved_by": a.get("by"), "approved_at": a.get("at"), "decision_event_id": a.get("event_id"),
                       "contributors": a.get("contributors") or []})
    return {
        "block_id": block.id, "dir": block.id,
        "array": {"file": f"{block.id}/seg.npy", "shape": list(rel.shape), "dtype": str(rel.dtype), "axes": "XYZ",
                  "fortran_order": bool(rel.flags.f_contiguous and not rel.flags.c_contiguous),
                  "display_plane": "seg[:, :, z].T（行 = Y，列 = X）",
                  "unreviewed_slices": "全为 0；以 reviewed_z.npy 为准"},
        "reviewed_z_file": f"{block.id}/reviewed_z.npy", "n_reviewed": len(included), "z_list": included,
        "excluded": plan["excluded"],
        "source": {"block_path": str(block.path), "seg": str(block.path / "seg.npy"), "em": str(block.path / "em.npy"),
                   "em_shape": list(block.em.shape), "meta": block.meta, "workdir_audit_seq": plan["audit_seq"]},
        "slices": slices, "created_label_ids": created_present,
    }


def write_release(batch: str, workdir: Path, members: list[tuple[Block, dict[int, dict]]], expect: dict[str, list[int]], *,
                  skipped: list[dict], created_by: dict, note: str | None, code_commit: str | None,
                  db_max_version: int = 0, precommit=None) -> dict:
    """把一个批次里各块要收的片冻结成一个只读版本：<工作目录>/_releases/<批次>/v<N>/<块>/{seg.npy, reviewed_z.npy}，
    外加整批的 manifest.json 和 checksums.sha256。

    members 是要收切片的块和各自的通过记录；expect 是预览时看到的「每块收哪些片」。一块一块地取快照、写文件，
    同一时间只占一块的内存；取快照时某块要收的片和预览不一样 → ReleaseStale。每块的 seg.npy 与它原始的 seg.npy
    形状、类型、轴顺序（含是否 F 顺序）完全一致；没收的片全是 0，reviewed_z.npy 标出哪些片有效。
    先写进临时目录、逐个文件落盘；原子改名成 v<N> 之前调用 precommit()（入库接口在这里再核对一遍库里的审核结论，
    途中有人退回或撤销就抛 ReleaseStale）——要么整个版本出现，要么什么都没有。
    版本号取「已有目录」和「库里记录」两者的最大值加一：有人删了旧版本目录腾空间，也不会造出一个和库里记录对不上的同号版本。"""
    if not members:
        raise ValueError("没有可以入库的切片：需要至少一片「已通过」且通过后没再改过")
    root = releases_root(workdir) / batch
    root.mkdir(parents=True, exist_ok=True)
    _check_free(root, sum(int(b._seg().nbytes) for b, _ in members) + (64 << 20))

    with _release_locks[batch]:
        for old in root.glob(".tmp-*"):          # 上次入库写到一半崩了留下的临时目录（同一时间只有本进程在写这个工作目录）
            shutil.rmtree(old, ignore_errors=True)
        existing = [int(p.name[1:]) for p in root.iterdir() if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit()]
        version = max(max(existing, default=0), int(db_max_version)) + 1
        final = root / f"v{version}"
        if final.exists():
            raise ValueError(f"版本目录 {final} 已存在，请联系管理员检查入库目录")
        tmp = root / f".tmp-{uuid.uuid4().hex[:8]}"
        tmp.mkdir()
        try:
            entries, seqs = [], {}
            for block, approved in members:
                plan = snapshot_release(block, approved)
                try:
                    if plan["included"] != sorted(set(expect.get(block.id, []))):
                        raise ReleaseStale(f"数据块 {block.id} 可入库的切片和你预览时不一样了（有人又通过或修改了），请重新预览后再入库")
                    entries.append(_write_block(tmp, block, plan, approved))
                    seqs[block.id] = plan["audit_seq"]
                finally:
                    plan.pop("vol", None)                # 这一块的拷贝写完就放掉，再取下一块
            n_slices = sum(e["n_reviewed"] for e in entries)
            manifest = {
                "schema_version": RELEASE_SCHEMA, "kind": "annotation_batch_release", "batch_id": batch, "version": version,
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "created_by": created_by, "note": note,
                "approval_scope": "whole_slice",          # 「通过」= 整张切片都正确，可以当训练真值（用户 2026-10-10 定）
                "label_semantics": "原始分割的标签 id；标注中新建的 id 列在各块的 created_label_ids（只在本数据块内唯一，跨块合并前要重新映射）",
                "slice_hash": "sha256(seg[:, :, z].tobytes(order='F')) 按小端 uint64，等于显示方向平面按 C 顺序的字节",
                "n_blocks": len(entries), "n_slices": n_slices,
                "blocks": entries,
                "skipped_blocks": skipped,                # 批次里没收的块和原因（没有通过的片、记录损坏……）
                "platform_commit": code_commit,
            }
            _write(tmp / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1).encode())
            files = [f for e in entries for f in (e["array"]["file"], e["reviewed_z_file"])] + ["manifest.json"]
            _write(tmp / "checksums.sha256", "".join(f"{_sha_file(tmp / f)}  {f}\n" for f in files).encode())
            _fsync_dir(tmp)
            if precommit is not None:
                precommit()                          # 途中有人改了审核结论就在这里抛出，什么都不留
            os.rename(tmp, final)                    # ← 提交点：之前失败什么都不留，之后就是一个完整版本
            _fsync_dir(root)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        # 文件设为只读（防手滑改写）；目录不设只读，否则按天数清理旧备份时删不掉里面的文件
        for f in final.rglob("*"):
            if f.is_file():
                try:
                    f.chmod(0o444)
                except OSError:
                    pass
        return {"version": version, "path": str(final.relative_to(Path(workdir))), "manifest_sha256": _sha_file(final / "manifest.json"),
                "n_blocks": len(entries), "n_slices": n_slices,
                "blocks": [{"block_id": e["block_id"], "n_slices": e["n_reviewed"], "z_list": e["z_list"], "audit_seq": seqs[e["block_id"]]}
                           for e in entries]}


def set_aside(workdir: Path, rel_path: str) -> str | None:
    """入库目录已经改名生效、库里那一行却没写成：把目录挪开（.failed-…），不让一个库里没有记录的版本留在原位。"""
    src = Path(workdir) / rel_path
    if not src.exists():
        return None
    dst = src.with_name(f".failed-{src.name}-{uuid.uuid4().hex[:6]}")
    os.rename(src, dst)
    return str(dst)
