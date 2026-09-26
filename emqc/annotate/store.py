"""On-disk annotation store.

A *block* is a directory with `em.npy` and optionally `seg.npy`, plus `meta.json`.

**Orientation.** The arrays are stored the way `fetch_train.py` received them from CloudVolume, i.e. axis 0 runs
along the source volume's X and axis 1 along its Y. The viewer draws a section with X horizontal and Y vertical,
the same way Neuroglancer and the rest of the connectomics world draw it, so a displayed section is the TRANSPOSE
of the stored one: `arr[:, :, z].T`. Screen (x = column, y = row) therefore reaches `arr[x, y, z]`.

Getting this backwards was a real bug: the page used to draw `arr[:, :, z]` directly, which showed every section
mirrored across its diagonal relative to the source dataset, and a jump to Neuroglancer landed on the transposed
pixel. The mapping was pinned down by downloading the volume with CloudVolume and cross-correlating: all four
quadrant blocks match at exactly 1.000 with zero displacement under the convention above.

`em_slice` / `seg_slice` hand out the displayed (transposed) orientation, so everything that thinks in screen
coordinates — the tools, SAM — is automatically right. Only the edit records go the other way:
they store indices into the array as it sits on disk, so that records written before this change still replay.

The data directory is treated as read-only. Everything the viewer writes lives in a separate *work directory*
(`<workdir>/<block_id>/`): the first edit copies `seg.npy` there as `seg_edit.npy` (copy-on-write) and every
change goes to that copy; each edit is logged as `edits/<n>.npz` (the voxels it changed and their previous ids)
so it can be undone exactly, and summarised in `edits.jsonl` for the UI.

Screen coordinates are (x = column, y = row); on a displayed plane that is `plane[y, x]`. Edit records store
indices into the on-disk array: `xs` = axis-0, `ys` = axis-1 — the historical names, kept so older records replay.
`_disk_idx` converts a displayed-frame mask into that pair.

Per slice the viewer gets a *label index map*: ids are renumbered 0..k (0 stays background) into a uint16
image, shipped as a lossless RGB PNG (R = hi byte, G = lo byte) together with the index -> id table. The
browser does colouring, eyedropping and hover-highlight on that map without a round trip; ids are sent as
strings because H01 ids exceed 2^53 and would lose precision as JSON numbers.
"""
from __future__ import annotations

import fcntl
import io
import json
import logging
import os
import shutil
import threading
import time
import uuid
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from weakref import WeakValueDictionary

import numpy as np
from PIL import Image
from scipy import ndimage

SEG_EDIT = "seg_edit.npy"
EDIT_DIR = "edits"
EDIT_LOG = "edits.jsonl"
CREATED_LABELS = "created_labels.json"
# 操作流水，只追加：每一笔写入和每一次撤销，带标注人。edits.jsonl 是"当前有效"的记录，被撤销的会从里面消失，
# 而"谁在几点撤销了谁的改动"正是追溯时要问的，所以另记一份。
AUDIT_LOG = "audit.jsonl"
WORKDIR_LOCK = ".server.lock"
MAX_LABELS_PER_SLICE = 65535
UNDONE_DIR = "undone"            # edits/undone/：撤销掉的改动文件挪到这里，不删（误撤、事后追查都还找得到）
MAX_PAINT_STEPS = 200_000        # 一笔画笔插值后的总步数上限：正常一笔几百到几千步，再大就是脚本或异常请求
_BLOCK_LOCKS = WeakValueDictionary()
_BLOCK_LOCKS_GUARD = threading.Lock()
_HELD_WORKDIRS: dict[str, object] = {}
_HELD_GUARD = threading.Lock()
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Actor:
    """谁在操作。`name` 是给人看的（记录里的 by）；登录用户另带账号名和用户 id，改名后旧记录仍能对上人。
    没有登录系统时（EMQC_AUTH_DISABLED）只有 name——页面里填的名字。"""
    name: str
    user: str | None = None
    id: int | None = None

    @classmethod
    def coerce(cls, by) -> "Actor | None":
        if by is None or isinstance(by, Actor):
            return by
        return cls(str(by))

    def stamp(self) -> dict:
        d: dict = {"by": self.name}
        if self.user is not None:
            d["by_user"] = self.user
        if self.id is not None:
            d["by_id"] = self.id
        return d


def same_actor(entry: dict, actor: Actor | None) -> bool:
    """这条记录（edits.jsonl 或 audit.jsonl 里的一行）是不是 actor 做的。有用户 id 就比 id，其次比账号名，最后比显示名。"""
    if actor is None:
        return False
    if entry.get("by_id") is not None and actor.id is not None:
        return entry["by_id"] == actor.id
    if isinstance(entry.get("by_user"), str) and actor.user is not None:
        return entry["by_user"] == actor.user
    return entry.get("by") == actor.name


class UndoForbidden(ValueError):
    """本片最近一次改动是别人做的：撤销要么撤自己的，要么明确说"我就是要撤他的"（force）。"""

    def __init__(self, record: dict):
        super().__init__(f"本片最近一次改动是 {record.get('by')} 做的，不能撤销别人的改动")
        self.record = record


class UndoMismatch(ValueError):
    """撤销时钉住的记录号已经不是本片最近一笔：中间有人又改了，界面上确认的那一笔不是现在会被撤掉的那一笔。"""

    def __init__(self, record: dict, expected: int):
        super().__init__(f"本片最近一笔已是 #{record.get('n')}（不是确认时的 #{expected}），请刷新后再撤销")
        self.record = record


def hold_workdir(root: Path) -> None:
    """把工作目录（所有块的 seg_edit / edits 都在它下面）占住，直到本进程退出。

    两个服务进程写同一个工作目录会怎样：edits.jsonl 的追加互相穿插、撤销时整文件重写把对方刚写的行冲掉、
    各自的缓存又都看不见对方的改动——悄无声息地坏。flock 把这变成第一次写入时的一句明确报错。
    进程退出（包括崩溃）时内核自动释放，不会留下死锁文件。不支持 flock 的文件系统上退回到只靠进程内的锁。"""
    key = str(root.resolve())
    with _HELD_GUARD:
        if key in _HELD_WORKDIRS:
            return
        root.mkdir(parents=True, exist_ok=True)
        fh = open(root / WORKDIR_LOCK, "a+")
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.close()
            raise ValueError(f"标注工作目录 {root} 正被另一个服务进程使用。同一个工作目录只能由一个服务写入："
                             "多人标注请都连到那个服务；确实要再起一个服务，就给它另一个 EMQC_ANNOTATE_WORKDIR")
        except OSError:
            fh.close()
            return
        fh.seek(0)
        fh.truncate()
        fh.write(f"{os.getpid()}\n")
        fh.flush()
        _HELD_WORKDIRS[key] = fh


class _Shared:
    """同一个块在本进程里的共享状态：锁，以及每一片的"像素版本"（写完像素加一）。

    工作台（写）和对比页（只读）各有一个 Block 对象，缓存各管各的；缓存键里带上像素版本，
    谁的缓存都不会在别人写完之后还拿旧图出来。"""
    __slots__ = ("lock", "gen", "__weakref__")

    def __init__(self):
        self.lock = threading.RLock()
        self.gen: dict[int, int] = {}


def _stat_key(p: Path):
    """文件变没变：inode、大小、修改时间。追加改大小，撤销时整文件替换换 inode。"""
    try:
        st = p.stat()
    except FileNotFoundError:
        return None
    return (st.st_ino, st.st_size, st.st_mtime_ns)


def _whole_record(raw: bytes) -> bool:
    try:
        return isinstance(json.loads(raw.decode("utf-8")), dict)
    except ValueError:                                  # 含 UnicodeDecodeError（断在一个汉字的中间）
        return False


def _append_line(p: Path, line: str) -> int:
    """往只追加的日志末尾写一行并落盘。返回追加前的文件长度——后面的步骤失败时截回去，日志里就不会留下
    一条没有真正发生的记录。

    文件末尾没有换行时：那一行要是残缺的（上一次追加断在半路），切掉它；要是一条完整的记录只是缺了换行
    （比如手工修过文件），补上换行、保留它——和 _parse_log 的读法一致，读的时候算数的记录，写的时候也不会删。
    这一次追加自己失败了（磁盘满），把写了一半的内容截掉再报错，不留半行。"""
    fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o644)
    with os.fdopen(fd, "r+b") as f:
        end = f.seek(0, os.SEEK_END)
        if end:
            f.seek(end - 1)
            if f.read(1) != b"\n":
                cut, pos = 0, end
                while pos > 0:
                    step = min(65536, pos)
                    pos -= step
                    f.seek(pos)
                    k = f.read(step).rfind(b"\n")
                    if k >= 0:
                        cut = pos + k + 1
                        break
                f.seek(cut)
                if _whole_record(f.read(end - cut)):
                    log.warning("%s: 最后一条记录缺换行，已补上", p)
                    f.seek(end)
                    f.write(b"\n")
                    end += 1
                else:
                    log.warning("%s: 末尾有半行（上次追加中断），追加前已切掉", p)
                    f.truncate(cut)
                    end = cut
        f.seek(end)
        try:
            f.write(line.encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        except OSError:
            try:
                f.truncate(end)
            except OSError:
                pass
            raise
    return end


def _parse_log(p: Path, what: str) -> list[dict]:
    """逐行读只追加的日志。最后一行残缺而且文件不以换行结尾 = 上次追加断在半路（这种日志唯一合理的损坏方式），
    丢掉那半行继续；别的地方坏了说明文件被人改过，拒绝读取，宁可停下也不给出错的记录。

    按字节切行、每行单独解码：半行可能正好断在一个汉字中间，整文件解码会在读到任何一行之前就失败；
    也不能按 str.splitlines 切——它把名字里的 U+2028 之类也当换行。"""
    data = p.read_bytes()
    lines = data.split(b"\n")
    out = []
    for i, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            out.append(json.loads(raw.decode("utf-8")))
        except ValueError:                              # 含 UnicodeDecodeError
            if i == len(lines) - 1 and not data.endswith(b"\n"):
                log.warning("%s: 末尾一行残缺（上次追加中断），已忽略", p)
                break
            raise ValueError(f"{what}格式损坏，无法可靠读取操作顺序")
    return out


def disk_free(path: Path) -> int:
    """path 所在盘剩多少字节（path 不存在就往上找存在的那一级）。"""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free


def _check_free(path: Path, need: int = 0) -> None:
    """写之前工作目录所在的盘至少要剩 need + EMQC_ANNOTATE_MIN_FREE_MB：磁盘写满时 memmap 写入会让整个进程
    收到 SIGBUS 直接死掉，改动记录也会写一半——宁可提前拒绝这一笔、提示管理员清盘。"""
    from emqc.config import settings

    free = disk_free(path)
    if free < need + settings.annotate_min_free_mb * 1024 * 1024:
        raise ValueError(f"服务器磁盘空间不足（{path} 所在盘只剩 {free / 2**30:.1f} GB），为免数据写坏已暂停写入，请联系管理员清理")


def label_color(label: int) -> tuple[int, int, int]:
    """Match the browser's FNV-1a/HSL palette, including Math.round rounding."""
    h = 2166136261
    for c in str(label):
        h = ((h ^ ord(c)) * 16777619) & 0xffffffff
    hue, sat, light = h % 360, .62 + ((h >> 9) % 30) / 100, .48 + ((h >> 17) % 16) / 100
    a = sat * min(light, 1 - light)
    def channel(n):
        k = (n + hue / 30) % 12
        return int(255 * (light - a * max(-1, min(k - 3, 9 - k, 1))) + .5)
    return tuple(channel(n) for n in (0, 8, 4))


def find_blocks(root: Path | None, max_depth: int = 4) -> list[Path]:
    """Directories under `root` (up to max_depth deep) that contain em.npy — the delivery layout is
    blocks/<dataset>/<block>/em.npy, but a flat <block>/em.npy works too."""
    if not root or not Path(root).exists():
        return []
    root = Path(root)
    return sorted(p.parent for p in root.rglob("em.npy") if len(p.relative_to(root).parts) <= max_depth)


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)  # speed over size: these are streamed per slice
    return buf.getvalue()


class Block:
    def __init__(self, path: Path, workdir: Path | None = None, *, read_only: bool = False):
        self.path = Path(path)
        self.id = self.path.name
        self.work = Path(workdir) / self.id if workdir else self.path  # None only for legacy callers/tests
        self.read_only = read_only
        # Comparison and editing stores share a lock, even when they use separate read-only handles.
        key = (self.path.resolve(), self.work.resolve())
        with _BLOCK_LOCKS_GUARD:
            self._shared = _BLOCK_LOCKS.get(key)
            if self._shared is None:
                self._shared = _BLOCK_LOCKS[key] = _Shared()
        self.lock = self._shared.lock
        self.em = np.load(self.path / "em.npy", mmap_mode="r")  # (rows, cols, z)
        if self.em.ndim != 3:
            raise ValueError(f"{self.path}/em.npy must be 3-D, got {self.em.shape}")
        self.has_seg = (self.path / "seg.npy").exists()
        self._seg_ro = np.load(self.path / "seg.npy", mmap_mode="r") if self.has_seg else None
        self._seg_rw = None
        self.meta = json.load(open(self.path / "meta.json")) if (self.path / "meta.json").exists() else {}
        self.visual_em = self._find_visual_em()
        if not read_only:
            with self.lock:
                self._migrate_legacy()
        self._max_id: int | None = None
        # audit.jsonl / edits.jsonl 解析结果，连同解析时文件的 (inode, 大小, 修改时间)：文件没变就不重读
        self._audit: tuple | None = None
        self._edits: tuple | None = None
        self._png_cache: OrderedDict[tuple, bytes] = OrderedDict()
        self._label_cache: OrderedDict[tuple, tuple[np.ndarray, np.ndarray]] = OrderedDict()   # (z, 像素版本) -> 索引
        # same thing for the DELIVERED labels: never invalidated (seg.npy is read-only), used by the compare page
        # to rebuild a baseline plane with a 5 ms gather instead of a 250 ms strided read of the whole file
        self._label_cache_ro: OrderedDict[int, tuple[np.ndarray, np.ndarray]] = OrderedDict()

    def _find_visual_em(self) -> Path | None:
        """`visual/slices_em/z0000.png` next to em.npy: the delivery's reference rendering of each section.
        Used verbatim as the EM layer when its size matches the array (rows x cols)."""
        d = self.path / "visual" / "slices_em"
        f = d / "z0000.png"
        if not f.exists():
            return None
        try:
            with Image.open(f) as im:
                w, h = im.size
        except Exception:
            return None
        return d if (h, w) == tuple(int(v) for v in self.em.shape[:2]) else None

    def _migrate_legacy(self) -> None:
        """Earlier versions wrote seg_edit.npy / edits into the data directory. Move them to the work directory
        once, so the data directory is left exactly as delivered and no edit is lost."""
        if self.work == self.path:
            return
        legacy = [self.path / SEG_EDIT, self.path / EDIT_DIR, self.path / EDIT_LOG]
        if not any(p.exists() for p in legacy):
            return
        self.work.mkdir(parents=True, exist_ok=True)
        for src in legacy:
            if src.exists() and not (self.work / src.name).exists():
                shutil.move(str(src), str(self.work / src.name))

    # ------------------------------------------------------------------ geometry
    @property
    def nz(self) -> int:
        return int(self.em.shape[2])

    @property
    def shape_zyx(self) -> tuple[int, int, int]:
        a0, a1, z = self.em.shape          # on disk: (volume X, volume Y, z)
        return (int(z), int(a1), int(a0))  # displayed: (z, rows = Y, cols = X)

    def info(self) -> dict:
        g = self.meta.get("geometry", {})
        return {
            "block_id": self.id, "path": str(self.path), "has_seg": self.has_seg,
            "shape_zyx": list(self.shape_zyx), "dtype_em": str(self.em.dtype),
            "dtype_seg": str(self._seg_ro.dtype) if self.has_seg else None,
            "voxel_size_nm": g.get("voxel_size_nm"), "origin": g.get("origin"), "dataset": self.meta.get("dataset", {}).get("id"),
            "n_edits": len(log := self.edits()), "editors": [r["by"] for r in self.editors(records=log)],
            "last_edit": self.last_edit(log), "has_working_copy": (self.work / SEG_EDIT).exists(),
            "working_copy": str(self.work / SEG_EDIT), "workdir": str(self.work), "em_source": "em.npy",
            "em_version": "3-transposed",  # bump when the EM rendering changes; the viewer keys its image URLs on it
        }

    # ------------------------------------------------------------------ label volume access
    def work_path(self, name: str | Path) -> Path:
        """Comparison can read legacy work in place; it must never migrate or copy it."""
        target = self.work / name
        if self.read_only and not target.exists() and (self.path / name).exists():
            return self.path / name
        return target

    def _seg(self) -> np.ndarray:
        """Read view: the working copy when it exists, else the pristine seg.npy."""
        if self._seg_rw is None and self.work_path(SEG_EDIT).exists():
            self._seg_rw = np.load(self.work_path(SEG_EDIT), mmap_mode="r" if self.read_only else "r+")
        return self._seg_rw if self._seg_rw is not None else self._seg_ro

    def _hold(self) -> None:
        # 旧式无工作目录的调用者直接写在数据目录旁边——那里一个锁文件都不该留
        if self.work != self.path:
            hold_workdir(self.work.parent)
        # 先把两份日志读进来：哪份坏了，都在写任何像素之前失败，而不是像素写完了才在记录时抛错
        self.audit_entries()
        self.edits()
        _check_free(self.work)

    def _seg_writable(self) -> np.ndarray:
        """Copy-on-write: materialise seg_edit.npy from seg.npy on first edit; seg.npy is never modified."""
        if self.read_only:
            raise ValueError("当前数据块以只读方式打开")
        if not self.has_seg:
            raise ValueError("block has no seg.npy")
        self._hold()
        p = self.work / SEG_EDIT
        if self._seg_rw is None:
            if not p.exists():
                self.work.mkdir(parents=True, exist_ok=True)
                src = self.path / "seg.npy"
                _check_free(self.work, src.stat().st_size)
                tmp = self.work / (SEG_EDIT + ".part")
                # 整文件逐字节复制，不用"建一个稀疏的 memmap 再往里填"：稀疏文件建出来不占盘，真正写的时候盘满了
                # 进程直接收到 SIGBUS 死掉；复制则在盘满时老老实实抛 OSError，这一笔拒绝，服务照常
                try:
                    shutil.copyfile(src, tmp)
                    with open(tmp, "rb+") as fh:
                        os.fsync(fh.fileno())
                    check = np.load(tmp, mmap_mode="r")
                    if check.shape != self._seg_ro.shape or check.dtype != self._seg_ro.dtype:
                        tmp.unlink(missing_ok=True)
                        raise ValueError("工作副本和原始分割的形状或类型不一致")
                    del check
                except OSError as e:
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"建工作副本失败（{e.strerror or e}），多半是磁盘满了，请联系管理员") from e
                tmp.rename(p)
            self._seg_rw = np.load(p, mmap_mode="r+")
        return self._seg_rw

    def em_slice(self, z: int) -> np.ndarray:
        """Section z as displayed: (rows = volume Y, cols = volume X). See the orientation note at the top."""
        return np.ascontiguousarray(self.em[:, :, z].T)

    def seg_slice(self, z: int) -> np.ndarray:
        return np.ascontiguousarray(self._seg()[:, :, z].T)

    def _plane(self, z: int) -> np.ndarray:
        """A writable, displayed-orientation view of section z. Writes go through to the memmap."""
        return self._seg_writable()[:, :, z].T

    def _plane_ro(self, z: int) -> np.ndarray:
        return self._seg()[:, :, z].T

    @staticmethod
    def _disk_idx(mask_display: np.ndarray):
        """A displayed-frame boolean mask -> (xs, ys), indices into the on-disk array, for the edit record."""
        rows, cols = np.nonzero(mask_display)
        return cols, rows        # displayed row = on-disk axis 1, displayed column = on-disk axis 0

    def _check_z(self, z: int) -> None:
        if not 0 <= z < self.nz:
            raise IndexError(f"z {z} out of range 0..{self.nz - 1}")

    # ------------------------------------------------------------------ renderings (cached)
    def _cached(self, key: tuple, make):
        with self.lock:
            if key in self._png_cache:
                self._png_cache.move_to_end(key)
                return self._png_cache[key]
        val = make()
        with self.lock:
            self._png_cache[key] = val
            while len(self._png_cache) > 64:
                self._png_cache.popitem(last=False)
        return val

    def em_png(self, z: int) -> bytes:
        self._check_z(z)
        # The delivery's own PNGs are in the on-disk orientation; since sections are now displayed transposed they
        # can no longer be served verbatim, so the EM layer is always rendered from em.npy.
        return self._cached(("em", z), lambda: _png(Image.fromarray(self.em_slice(z), mode="L")))

    LABEL_CACHE_SIZE = 48          # the compare page's ±10 playback holds 21 sections of both caches at once

    @staticmethod
    def _index(s: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
        """(idx16, ids) for one displayed plane: idx 0 is always id 0 / background. `ids[idx]` rebuilds the plane."""
        # `np.unique(..., return_inverse=True)` argsorts every pixel; we only need "value -> position in ids",
        # and searchsorted on the (already sorted) ids gives exactly that, 6x faster on a 1024² section.
        ids = np.unique(s)
        if ids.size == 0 or ids[0] != 0:
            ids = np.concatenate([np.zeros(1, dtype=ids.dtype), ids])
        if ids.size > MAX_LABELS_PER_SLICE:
            raise ValueError(f"slice {z} has {ids.size} labels; the uint16 index map holds at most {MAX_LABELS_PER_SLICE}")
        return np.searchsorted(ids, s).astype(np.uint16), ids

    def _gen(self, z: int) -> int:
        """第 z 片的像素版本：写入方每写完一次像素加一（见 _invalidate）。和工作台、对比页共享。"""
        return self._shared.gen.get(z, 0)

    def _labels_cached(self, cache: OrderedDict, key, z: int, plane) -> tuple[np.ndarray, np.ndarray]:
        with self.lock:
            if key in cache:
                cache.move_to_end(key)
                return cache[key]
        got = self._index(plane(), z)
        with self.lock:
            cache[key] = got
            while len(cache) > self.LABEL_CACHE_SIZE:
                cache.popitem(last=False)
        return got

    def labels(self, z: int) -> tuple[np.ndarray, np.ndarray]:
        """(idx16 (y, x), ids) of the CURRENT labels — idx 0 is always id 0 / background.

        缓存键是 (z, 像素版本)，版本在读像素之前取：算到一半有人写了，缓存里至多是比键更新的图（下次版本变了重算），
        绝不会是比键更旧的图——那样对比页会一直显示改动之前的结果。"""
        self._check_z(z)
        return self._labels_cached(self._label_cache, (z, self._gen(z)), z, lambda: self.seg_slice(z))

    def labels_baseline(self, z: int) -> tuple[np.ndarray, np.ndarray]:
        """Same for the DELIVERED labels (seg.npy). Cached for good — the delivery never changes."""
        self._check_z(z)
        return self._labels_cached(self._label_cache_ro, z, z, lambda: np.ascontiguousarray(self._seg_ro[:, :, z].T))

    def warm_labels(self, z0: int, z1: int) -> dict:
        """Fill both label caches for sections z0..z1 in ONE pass over each volume.

        On disk the arrays are (X, Y, Z) with Z fastest, so a single section is a 1M-element gather 800 bytes
        apart that pages through the whole file (~250 ms on a 1024² block) — but 21 sections touch the same
        pages as one, so reading the slab once costs about the same as one section. That is the difference
        between the ±10 playback taking 10 s to start and taking 1 s."""
        z0, z1 = max(0, int(z0)), min(self.shape_zyx[0] - 1, int(z1))
        if z1 < z0:
            raise ValueError("z1 must be >= z0")
        keys_rw = {z: (z, self._gen(z)) for z in range(z0, z1 + 1)}         # 版本在读体数据之前取，理由见 labels
        todo_rw = [z for z in range(z0, z1 + 1) if keys_rw[z] not in self._label_cache]
        todo_ro = [z for z in range(z0, z1 + 1) if z not in self._label_cache_ro] if self.has_seg else []
        started = time.perf_counter()
        for todo, vol, cache, key in ((todo_ro, (lambda: self._seg_ro), self._label_cache_ro, (lambda z: z)),
                                      (todo_rw, (lambda: self._seg()), self._label_cache, keys_rw.get)):
            if not todo or not self.has_seg:
                continue
            lo, hi = min(todo), max(todo) + 1
            slab = np.ascontiguousarray(vol()[:, :, lo:hi])          # one pass over the pages
            for z in todo:
                got = self._index(np.ascontiguousarray(slab[:, :, z - lo].T), z)
                with self.lock:
                    cache[key(z)] = got
                    cache.move_to_end(key(z))
                    while len(cache) > self.LABEL_CACHE_SIZE:
                        cache.popitem(last=False)
        return {"z0": z0, "z1": z1, "warmed_current": len(todo_rw), "warmed_baseline": len(todo_ro),
                "seconds": round(time.perf_counter() - started, 3)}

    def labels_png(self, z: int) -> bytes:
        gen = self._gen(z)

        def make():
            idx, _ = self.labels(z)
            rgb = np.zeros(idx.shape + (3,), dtype=np.uint8)
            rgb[..., 0] = idx >> 8
            rgb[..., 1] = idx & 255
            return _png(Image.fromarray(rgb, mode="RGB"))
        return self._cached(("labels", z, gen), make)

    def labels_table(self, z: int) -> dict:
        idx, ids = self.labels(z)
        counts = np.bincount(idx.ravel(), minlength=ids.size)
        return {"z": z, "n": int(ids.size), "ids": [str(int(i)) for i in ids], "counts": counts.tolist(),
                "created_ids": self.created_ids()}

    def pick(self, z: int, x: int, y: int) -> int:
        self._check_z(z)
        return int(self._seg()[x, y, z])        # screen x -> axis 0, screen y -> axis 1

    def _invalidate(self, z: int) -> None:
        """第 z 片的像素刚写完：版本加一（工作台、对比页的缓存都跟着失效），顺手丢掉自己这边的旧缓存省内存。"""
        with self.lock:
            self._shared.gen[z] = self._shared.gen.get(z, 0) + 1
            for k in [k for k in self._label_cache if k[0] == z]:
                self._label_cache.pop(k, None)
            for k in [k for k in self._png_cache if k[0] == "labels" and k[1] == z]:
                self._png_cache.pop(k, None)

    # ------------------------------------------------------------------ ids
    def max_id(self) -> int:
        if self._max_id is None:
            seg = self._seg()
            m = 0
            for k in range(seg.shape[2]):  # one section at a time: a full-volume max would page in 800 MB
                m = max(m, int(seg[:, :, k].max()))
            self._max_id = m
        return self._max_id

    def created_ids(self) -> list[str]:
        with self.lock:
            path = self.work_path(CREATED_LABELS)
            return json.loads(path.read_text()) if path.exists() else []

    def new_id(self, z: int = 0) -> int:
        self._hold()                     # created_labels.json 也是工作目录里的一笔写入
        """Reserve a reusable block label without changing pixels or edit history."""
        with self.lock:
            if self.read_only:
                raise ValueError("当前数据块以只读方式打开")
            self._check_z(z)
            created = self.created_ids()
            used = {label_color(int(i)) for i in self.labels(z)[1] if i != 0}
            used.update(label_color(int(i)) for i in created)
            label = max(self.max_id(), max(map(int, created), default=0)) + 1
            limit = np.iinfo(self._seg_ro.dtype).max
            while label <= limit and label_color(label) in used:
                label += 1
            if label > limit:
                raise ValueError("标签编号已用尽")
            self.work.mkdir(parents=True, exist_ok=True)
            tmp = self.work / (CREATED_LABELS + ".part")
            tmp.write_text(json.dumps([*created, str(label)]))
            tmp.replace(self.work / CREATED_LABELS)
            self._max_id = label
            return label

    # ------------------------------------------------------------------ edits
    def _edit_dir(self) -> Path:
        if self.read_only:
            raise ValueError("当前数据块以只读方式打开")
        self._hold()
        d = self.work / EDIT_DIR
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _load_edit(self, n: int, keys: tuple[str, ...] | None = None) -> dict:
        """第 n 笔改动的像素记录（edits/<n>.npz）；给了 keys 就只解压这几个数组（没有的跳过）。
        文件坏了抛 ValueError（接口返回 422），不让 EOFError / BadZipFile 变成 500。"""
        try:
            with np.load(self.work_path(f"{EDIT_DIR}/{n:06d}.npz"), allow_pickle=False) as data:
                names = data.files if keys is None else [k for k in keys if k in data.files]
                return {key: data[key] for key in names}
        except FileNotFoundError as e:
            raise ValueError(f"改动 #{n} 的像素记录文件不见了，这一笔无法撤销或溯源，请联系管理员") from e
        except (EOFError, zipfile.BadZipFile, OSError, ValueError) as e:
            raise ValueError(f"改动 #{n} 的像素记录文件已损坏（{e}），这一笔无法撤销，请联系管理员") from e

    def _edit_in_slice(self, rec: dict, z: int) -> dict | None:
        if rec.get("z") is not None:
            return rec if rec["z"] == z else None
        d = self._load_edit(rec["n"], ("zs",))           # 列表和撤销每次都要问：只解压 zs，不碰其余几个大数组
        if "zs" not in d:
            d = self._load_edit(rec["n"], ("xs", "z"))
        zs = d["zs"] if "zs" in d else np.full(d["xs"].shape, int(d["z"]))
        n_px = int(np.count_nonzero(zs == z))
        return {**rec, "z": z, "n_px": n_px, "n_slices": 1} if n_px else None

    def edits(self, z: int | None = None) -> list[dict]:
        """当前有效的改动记录，从旧到新。解析结果按文件的 (inode, 大小, 修改时间) 缓存：落一笔、心跳、溯源
        都要读它，历史长了每次整文件重读很费；文件一变（追加、撤销时整文件替换）就重读。返回的是副本，可以随便改。"""
        if z is not None:
            self._check_z(z)
            with self.lock:
                return [entry for rec in self.edits() if (entry := self._edit_in_slice(rec, z)) is not None]
        p = self.work_path(EDIT_LOG)
        key = _stat_key(p)
        if key is None:
            return []
        cached = self._edits
        if cached is not None and cached[0] == key:
            return list(cached[1])
        records = _parse_log(p, "编辑日志")
        previous = 0
        for rec in records:
            if (not isinstance(rec, dict) or type(rec.get("n")) is not int or rec["n"] <= previous
                    or ("kind" in rec and not isinstance(rec["kind"], str))
                    or (rec.get("z") is not None and (type(rec["z"]) is not int or not 0 <= rec["z"] < self.nz))):
                raise ValueError("编辑日志格式损坏，无法可靠读取操作顺序或切片坐标")
            previous = rec["n"]
        self._edits = (key, records)
        return list(records)

    def edit_mask_png(self, n: int, z: int) -> bytes:
        """Read an active edit's footprint in display coordinates, including erased pixels."""
        self._check_z(z)
        with self.lock:
            rec = next((rec for rec in self.edits() if rec["n"] == n), None)
            if rec is None or (rec.get("z") is not None and rec["z"] != z):
                raise KeyError("本片没有这笔改动，可能已撤销")
            data = self._load_edit(n)
            xs, ys = data["xs"].astype(np.intp), data["ys"].astype(np.intp)
            zs = data["zs"] if "zs" in data else np.full(xs.shape, int(data["z"]))
            if xs.shape != ys.shape or xs.shape != zs.shape or xs.ndim != 1:
                raise ValueError("改动像素记录格式无效")
            xs, ys = xs[zs == z], ys[zs == z]
            if not xs.size:
                raise KeyError("本片没有这笔改动")
            h, w = self.shape_zyx[1:]
            if np.any((xs < 0) | (xs >= w) | (ys < 0) | (ys >= h)):
                raise ValueError("改动像素超出本片范围")
            mask = np.zeros((h, w), dtype=bool)
            mask[ys, xs] = True
            edge = mask & ~ndimage.binary_erosion(mask)
            rgba = np.zeros((h, w, 4), dtype=np.uint8)
            rgba[mask] = [255, 214, 10, 100]
            rgba[edge] = [255, 214, 10, 235]
            return _png(Image.fromarray(rgba))

    def _record(self, kind: str, z: int | None, xs: np.ndarray, ys: np.ndarray, old, new_id: int, extra: dict | None = None,
                zs: np.ndarray | None = None, by: "str | Actor | None" = None) -> dict:
        """Persist one edit: every changed voxel (x, y, z) and the id it had before. `z` is the section shown in the
        UI (None for a 3-D edit spanning several sections); `zs` defaults to a constant z. `by` is who did it: the
        logged-in user (an Actor with account name and id), or just a display name when running without accounts.

        **必须在写像素之前调用**（每个写操作都是：算出要改哪些像素和它们的旧值 → _record → 写像素）。这样无论在哪一步
        失败，都不会出现"像素改了却没有记录"——那种改动撤不掉、也查不到是谁改的。反过来"有记录、像素没写成"是无害的：
        撤销时回填的旧值和现在的值一样。记录本身三步（像素文件、edits.jsonl、audit.jsonl），后面一步失败就把前面的撤回。"""
        actor = Actor.coerce(by)
        edit_dir = self._edit_dir()
        history = self.edits()
        n = (history[-1]["n"] + 1) if history else 1
        if zs is None:
            zs = np.full(xs.shape, int(z), dtype=np.uint16)
        npz = edit_dir / f"{n:06d}.npz"
        if npz.exists():
            # 日志里没有第 n 笔、文件却在：上一次撤销收尾时没挪走的。别覆盖，挪进回收目录
            try:
                (edit_dir / UNDONE_DIR).mkdir(exist_ok=True)
                os.replace(npz, edit_dir / UNDONE_DIR / f"{n:06d}-orphan-{uuid.uuid4().hex[:6]}.npz")
            except OSError:
                log.exception("没能把孤立的改动文件 %s 挪进回收目录，将被这一笔覆盖", npz)
        try:
            with open(npz, "wb") as fh:
                np.savez_compressed(fh, z=-1 if z is None else int(z), xs=xs.astype(np.uint16), ys=ys.astype(np.uint16),
                                    zs=zs.astype(np.uint16), old=np.asarray(old), new=np.asarray(new_id))
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as e:
            npz.unlink(missing_ok=True)
            raise ValueError(f"改动记录没写成（{e.strerror or e}），这一笔没有生效，多半是磁盘满了，请联系管理员") from e
        many = np.ndim(new_id) > 0                  # historical edits may write a different id per pixel
        rec = {"n": n, "kind": kind, "z": (None if z is None else int(z)), "n_px": int(xs.size),
               "new_id": (f"{int(np.unique(new_id).size)} 个 id" if many else str(int(new_id))),
               "old_id": (str(int(old)) if np.ndim(old) == 0 else None), "n_slices": int(np.unique(zs).size),
               "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "by": None, **(actor.stamp() if actor else {}), **(extra or {})}
        from emqc.annotate.provenance import source_for_edit
        rec["source"] = source_for_edit(rec)
        rec["provenance_version"] = 1
        self.work.mkdir(parents=True, exist_ok=True)
        edit_log = self.work / EDIT_LOG
        try:
            before = _append_line(edit_log, json.dumps(rec) + "\n")
        except OSError as e:
            npz.unlink(missing_ok=True)
            raise ValueError(f"改动记录没写成（{e.strerror or e}），这一笔没有生效，多半是磁盘满了，请联系管理员") from e
        try:
            self._audit_append({"action": "edit", "by": None, **(actor.stamp() if actor else {}), "n": n, "kind": kind, "z": rec["z"],
                                "n_px": rec["n_px"], "new_id": rec["new_id"], "n_slices": rec["n_slices"]})
        except (OSError, ValueError) as e:
            # 流水没记上：把刚追加的那一行和像素文件都撤回，这一笔当作没发生（像素还没写）
            try:
                os.truncate(edit_log, before)
                npz.unlink(missing_ok=True)
            except OSError:
                log.exception("撤回改动 #%s 的记录失败：edits.jsonl 里可能多出一条像素没写成的记录（无害，撤销时回填的是原值）", n)
            if isinstance(e, ValueError):
                raise
            raise ValueError(f"操作流水没写成（{e.strerror or e}），这一笔没有生效，多半是磁盘满了，请联系管理员") from e
        if self._max_id is not None:
            self._max_id = max(self._max_id, int(np.max(new_id)) if many else int(new_id))
        return rec

    # ------------------------------------------------------------------ 谁改的：审计流水、切片版本、改动人
    def _audit_append(self, entry: dict) -> dict:
        with self.lock:
            entries = list(self.audit_entries())
            entry = {"seq": (int(entries[-1]["seq"]) + 1) if entries else 1, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **entry}
            self.work.mkdir(parents=True, exist_ok=True)
            p = self.work / AUDIT_LOG
            _append_line(p, json.dumps(entry, ensure_ascii=False) + "\n")   # 上次断在半路留下的半行会先切掉
            entries.append(entry)
            self._audit = (_stat_key(p), entries)
            return entry

    def audit_entries(self) -> list[dict]:
        """每一次写入和撤销，从旧到新。解析结果按文件的 (inode, 大小, 修改时间) 缓存：写入方自己追加后直接更新缓存；
        只读句柄（对比页）和同一个块的另一个 Block 对象（服务运行中块列表重建过）看到文件变了就重读，
        不会拿着旧流水算出重复的流水号。返回值不要改。

        末尾那一行要是残缺的（追加时崩溃），丢掉它继续——这是追加日志唯一合理的损坏方式；
        中间坏了则说明文件被人改过，拒绝读取，宁可停下也不给出错的"谁改的"。"""
        p = self.work_path(AUDIT_LOG)
        key = _stat_key(p)
        cached = self._audit
        if cached is not None and cached[0] == key:
            return cached[1]
        with self.lock:
            key = _stat_key(p)
            if self._audit is not None and self._audit[0] == key:
                return self._audit[1]
            entries: list[dict] = []
            if key is not None:
                seq = 0
                for e in _parse_log(p, "审计日志"):
                    if not isinstance(e, dict) or type(e.get("seq")) is not int or e["seq"] <= seq:
                        raise ValueError("审计日志格式损坏，无法可靠读取操作顺序")
                    seq = e["seq"]
                    entries.append(e)
            self._audit = (key, entries)
            return entries

    def slice_rev(self, z: int) -> int:
        """第 z 片的版本号：最后一次动过它的操作（写入或撤销）的流水号，没动过是 0。

        用它而不用改动次数，因为改动次数撤销后会退回去——A 看到的是 5，B 撤销一次变成 4，A 再来一笔又是 5，
        什么都察觉不到。流水号只增不减，客户端拿着它就能问"我看过之后有没有人动过这一片"。"""
        for e in reversed(self.audit_entries()):
            if e.get("z") is None or e.get("z") == z:
                return int(e["seq"])
        return 0

    def conflicts(self, z: int, since: int, by: "str | Actor | None") -> dict | None:
        """版本 since 之后，别人（不是 `by`）对第 z 片做的最近一次操作；没有则 None。

        两个人改同一片：各自对着自己加载时的画面下手。B 把一块区域改成了别的颜色，A 还对着旧画面点填充，
        填的就是 A 没看见的东西。服务端没法替两个人合并意图，只能拒绝（409），让页面重新加载这一片再来。
        自己的后续操作永远不算冲突：连续几笔涂抹到服务端的速度比页面重载快。"""
        actor = Actor.coerce(by)
        for e in reversed(self.audit_entries()):
            if int(e["seq"]) <= since:
                break
            if (e.get("z") is None or e.get("z") == z) and not same_actor(e, actor):
                return e
        return None

    def editors(self, z: int | None = None, records: list[dict] | None = None) -> list[dict]:
        """谁在第 z 片（不给 z 就是整块）上有仍然有效的改动：每人一行，最近改过的排前面。旧记录没名字的归为一行 by=None。"""
        rows: dict = {}
        latest: dict = {}
        for rec in (self.edits(z) if records is None else records):
            by = rec.get("by") if isinstance(rec.get("by"), str) else None
            r = rows.setdefault(by, {"by": by, "n": 0, "n_px": 0, "first": rec.get("ts"), "last": rec.get("ts")})
            r["n"] += 1
            r["n_px"] += int(rec.get("n_px") or 0)
            if isinstance(rec.get("ts"), str):
                r["last"] = rec["ts"]
            latest[by] = int(rec.get("n") or 0)             # record numbers order edits within the same second too
        return sorted(rows.values(), key=lambda r: -latest[r["by"]])

    def last_edit(self, records: list[dict] | None = None) -> dict | None:
        log = self.edits() if records is None else records
        if not log:
            return None
        return {k: log[-1].get(k) for k in ("n", "kind", "z", "n_px", "ts", "by")}

    def _check_id(self, new_id: int) -> int:
        if not self.has_seg:
            raise ValueError("block has no seg.npy")
        new_id = int(new_id)
        if not 0 <= new_id <= np.iinfo(self._seg_ro.dtype).max:
            raise ValueError("label id is outside the segmentation dtype range")
        return new_id

    def apply_mask(self, z: int, mask: np.ndarray, new_id: int, metadata: dict, kind: str = "sam",
                   by: str | None = None) -> dict | None:
        """Apply a previewed mask (SAM) in display (y, x) coordinates; preserve exact undo."""
        self._check_z(z)
        if mask.shape != self.shape_zyx[1:] or mask.dtype != np.bool_:
            raise ValueError("mask shape or dtype does not match the slice")
        with self.lock:
            if not self.has_seg:
                raise ValueError("当前数据块没有标签基线，无法应用；仍可预览分割")
            limits = np.iinfo(self._seg_ro.dtype)
            if not 0 <= new_id <= limits.max:
                raise ValueError("label id is outside the segmentation dtype range")
            changed = mask & (self._plane_ro(z) != new_id)
            xs, ys = self._disk_idx(changed)
            if not xs.size:
                return None
            seg = self._seg_writable()
            old = seg[xs, ys, z].copy()
            rec = self._record(kind, z, xs, ys, old, new_id, metadata, by=by)
            seg[xs, ys, z] = new_id
            seg.flush()
            self._invalidate(z)
            return rec

    def clear_labels(self, z: int, ids, by: str | None = None) -> dict | None:
        """批量删除：把本片上这几个 id 的像素全部清为背景 0，记成一笔，可整笔撤销。只动第 z 片。"""
        self._check_z(z)
        ids = sorted({int(i) for i in ids} - {0})
        if not ids:
            raise ValueError("没有选中任何标签")
        with self.lock:
            seg = self._seg_writable()
            plane = self._plane(z)
            mask = np.isin(plane, np.asarray(ids, dtype=plane.dtype))
            xs, ys = self._disk_idx(mask)
            if not xs.size:
                return None
            old = seg[xs, ys, z].copy()
            rec = self._record("clear", z, xs, ys, old, 0, {"scope": "batch", "ids": [str(i) for i in ids], "n_ids": len(ids)}, by=by)
            plane[mask] = 0
            seg.flush()
            self._invalidate(z)
            return rec

    def fill(self, z: int, x: int, y: int, new_id: int, whole_slice: bool = False, by: str | None = None) -> dict | None:
        """Bucket fill: relabel the connected component of the clicked pixel (4-connectivity within the slice) to
        `new_id`; with whole_slice, every pixel of that id in the slice. Returns the edit record, or None if the
        clicked pixel already has new_id."""
        self._check_z(z)
        new_id = self._check_id(new_id)
        with self.lock:
            seg = self._seg_writable()
            plane = self._plane(z)  # displayed-orientation view on the memmap: writes go straight to disk
            old = int(plane[y, x])
            if old == new_id:
                return None
            mask = plane == old
            if not whole_slice:
                lab, _ = ndimage.label(mask)
                mask = lab == lab[y, x]
            xs, ys = self._disk_idx(mask)
            rec = self._record("fill", z, xs, ys, old, new_id, {"x": int(x), "y": int(y), "whole_slice": bool(whole_slice)}, by=by)
            plane[mask] = new_id
            seg.flush()
            self._invalidate(z)
            return rec

    def paint(self, z: int, points: list[tuple[int, int]], radius: int, new_id: int, by: str | None = None,
              only_id: int | None = None) -> dict | None:
        """Brush: stamp a disc of `radius` at every point of the stroke (points are consecutive, so gaps are
        bridged by interpolation). Nonzero labels only fill background pixels; new_id=0 erases existing labels —
        all of them, or with `only_id` just that one label (擦除只擦当前颜色，压到邻居身上也不会把邻居擦掉)."""
        self._check_z(z)
        new_id = self._check_id(new_id)
        if only_id is not None:
            only_id = self._check_id(only_id)
            if only_id == 0:
                raise ValueError("要擦的颜色不能是背景")
        if not points:
            return None
        radius = max(0, int(radius))
        steps = sum(int(max(abs(x1 - x0), abs(y1 - y0))) for (x0, y0), (x1, y1) in zip(points, points[1:]))
        if steps > MAX_PAINT_STEPS:
            # 一笔的长度设上限：没有上限时一个 2 万点的请求能在锁里跑两分钟、吃掉几个 GB 内存，这块上所有人跟着卡住
            raise ValueError(f"这一笔太长了（{steps} 步，上限 {MAX_PAINT_STEPS}），请分几笔画")
        with self.lock:
            seg = self._seg_writable()
            plane = self._plane(z)
            H, W = plane.shape
            pts = [points[0]]
            for (x0, y0), (x1, y1) in zip(points, points[1:]):  # bridge gaps between sampled mouse positions
                n = int(max(abs(x1 - x0), abs(y1 - y0)))
                pts.extend((int(round(x0 + (x1 - x0) * t / n)), int(round(y0 + (y1 - y0) * t / n))) for t in range(1, n + 1))
            mask = self._stroke_mask(pts, radius, H, W)
            mask &= plane != new_id
            if new_id != 0:
                mask &= plane == 0               # 所有画笔颜色都只补空白；橡皮仍可擦除已有标签
            elif only_id is not None:
                mask &= plane == only_id         # 橡皮只擦当前颜色
            xs, ys = self._disk_idx(mask)
            if xs.size == 0:
                return None
            old = seg[xs, ys, z].copy()
            extra = {"radius": radius, "n_points": len(points)}
            if only_id is not None:
                extra["only_id"] = str(only_id)
            rec = self._record("paint", z, xs, ys, old, new_id, extra, by=by)
            plane[mask] = new_id
            seg.flush()
            self._invalidate(z)
            return rec

    @staticmethod
    def _stroke_mask(pts: list[tuple[int, int]], radius: int, H: int, W: int) -> np.ndarray:
        """一笔盖到的像素：每个点半径 radius 的圆盘的并集 = 到最近一个点的距离不超过 radius 的像素。
        用距离变换一次算完（耗时和点数、半径无关），不逐点盖章——逐点盖章在点多、半径大时要跑好几分钟。
        圆盘外缘判定和逐点盖章完全一样：dx² + dy² ≤ r²。"""
        mask = np.zeros((H, W), dtype=bool)
        p = np.asarray(pts, dtype=np.int64).reshape(-1, 2)                     # (x = column, y = row)
        # 离画面超过 radius 的点碰不到任何像素，丢掉；其余点放进一张四周各留 radius 的画布里
        keep = (p[:, 0] >= -radius) & (p[:, 0] < W + radius) & (p[:, 1] >= -radius) & (p[:, 1] < H + radius)
        p = p[keep]
        if not p.size:
            return mask
        x0, x1 = max(0, int(p[:, 0].min()) - radius), min(W, int(p[:, 0].max()) + radius + 1)
        y0, y1 = max(0, int(p[:, 1].min()) - radius), min(H, int(p[:, 1].max()) + radius + 1)
        if x1 <= x0 or y1 <= y0:
            return mask
        ox, oy = x0 - radius, y0 - radius                                     # 画布左上角在画面坐标里的位置
        centres = np.zeros((y1 - y0 + 2 * radius, x1 - x0 + 2 * radius), dtype=bool)
        cx, cy = p[:, 0] - ox, p[:, 1] - oy
        inside = (cx >= 0) & (cx < centres.shape[1]) & (cy >= 0) & (cy < centres.shape[0])
        centres[cy[inside], cx[inside]] = True
        d2 = ndimage.distance_transform_edt(~centres, return_distances=True) ** 2
        mask[y0:y1, x0:x1] = (d2 <= radius * radius + 1e-6)[radius:radius + (y1 - y0), radius:radius + (x1 - x0)]
        return mask

    def refine_edge(self, z: int, x: int, y: int, sensitivity: float = 0.5, reach: int = 4, by=None) -> dict | None:
        """修缮边缘：点到的那块标签如果压过了黑色的膜、跨到邻居身上，就往里收——收到膜为止。

        只动最外层：跨过膜、大段贴着标签外面的部分才收；被细胞包着的暗色细胞器（线粒体等）和胞质一律留下。
        算法见 boundary.pull_back_to_membrane。只收缩、从不扩张；收掉的像素清成背景，留给邻居去填。
        返回改动记录；边缘本来就贴合时返回 None。"""
        from emqc.annotate.boundary import pull_back_to_membrane

        self._check_z(z)
        _, H, W = self.shape_zyx
        if not (0 <= x < W and 0 <= y < H):
            raise ValueError("outside the block")
        if not self.has_seg:
            raise ValueError("block has no segmentation")
        with self.lock:
            plane = self._plane_ro(z)
            label = int(plane[y, x])
            if label == 0:
                raise ValueError("这里是背景，没有可修缮的标签")
            comps, _ = ndimage.label(plane == label)
            mask = comps == comps[y, x]
            region = pull_back_to_membrane(mask, self.em_slice(z), int(x), int(y), float(sensitivity))
            removed = mask & ~region
            xs, ys = self._disk_idx(removed)
            if xs.size == 0:
                return None
            seg = self._seg_writable()
            old = seg[xs, ys, z].copy()
            rec = self._record("refine", z, xs, ys, old, 0, {"x": int(x), "y": int(y), "label": str(label),
                                                           "sensitivity": float(sensitivity), "reach": int(reach)}, by=by)
            seg[xs, ys, z] = 0
            seg.flush()
            self._invalidate(z)
            return rec

    def merge_pair(self, z: int, first: tuple[int, int], second: tuple[int, int], by: str | None = None) -> dict | None:
        """Relabel only the second clicked 4-connected region using the first's id.

        Both ids are read under the edit lock, so stale client-side label tables
        cannot choose the wrong keeper. Other islands and slices stay unchanged.
        """
        self._check_z(z)
        _, H, W = self.shape_zyx
        if any(not (0 <= x < W and 0 <= y < H) for x, y in (first, second)):
            raise ValueError("outside the block")
        if not self.has_seg:
            raise ValueError("block has no segmentation")
        with self.lock:
            plane = self._plane_ro(z)
            (fx, fy), (sx, sy) = first, second
            to_id, from_id = int(plane[fy, fx]), int(plane[sy, sx])
            if not to_id or not from_id:
                raise ValueError("请选择两个非背景色块")
            if from_id == to_id:
                return None
            components, _ = ndimage.label(plane == from_id)
            xs, ys = self._disk_idx(components == components[sy, sx])
            seg = self._seg_writable()
            rec = self._record("merge", z, xs, ys, from_id, to_id,
                               {"scope": "component", "first": list(first), "second": list(second)}, by=by)
            seg[xs, ys, z] = to_id
            seg.flush()
            self._invalidate(z)
            return rec

    def merge(self, from_id: int, to_id: int, scope: str = "block", z: int | None = None, by: str | None = None) -> dict | None:
        """Give every voxel of `from_id` the id `to_id` — the two cells become one segment (one colour).
        scope "block": all sections; "slice": only section z. Returns the edit record, or None if nothing changed."""
        from_id, to_id = self._check_id(from_id), self._check_id(to_id)
        if from_id == 0:
            raise ValueError("不能把背景合并到别的标签上")
        if from_id == to_id:
            return None
        if scope == "slice":
            if z is None:
                raise ValueError("只合并本片时要给出是哪一片")
            self._check_z(int(z))
        with self.lock:
            seg = self._seg_writable()
            ks = [int(z)] if scope == "slice" else range(seg.shape[2])
            # 先只读扫一遍收集坐标，记录落盘之后再写像素（见 _record）
            xs_all, ys_all, zs_all = [], [], []
            for k in ks:
                xs, ys = np.nonzero(seg[:, :, k] == from_id)
                if xs.size:
                    xs_all.append(xs); ys_all.append(ys); zs_all.append(np.full(xs.shape, k, dtype=np.uint16))
            if not xs_all:
                return None
            xs, ys, zs = np.concatenate(xs_all), np.concatenate(ys_all), np.concatenate(zs_all)
            rec = self._record("merge", (int(z) if scope == "slice" else None), xs, ys, from_id, to_id, {"scope": scope}, zs=zs, by=by)
            seg[xs, ys, zs.astype(np.intp)] = to_id
            seg.flush()
            for k in np.unique(zs):
                self._invalidate(int(k))
            return rec

    def undo(self, z: int | None = None, by: "str | Actor | None" = None, force: bool = False,
             expect_n: int | None = None) -> dict | None:
        """Undo the latest edit in one slice, or the latest whole operation when z is omitted.

        A block-wide record is trimmed when only one of its slices is undone; its remaining
        voxels stay available for undo and provenance. Later edits on other slices are untouched.

        多人时撤销是最危险的一键：撤销永远撤本片**最近**的一笔，而最近的一笔可能是别人刚做的。所以给了名字（by）
        的撤销只能撤自己的；最近一笔是别人的就抛 UndoForbidden，让界面问清楚了再带 force 来。不给名字的调用
        （脚本）照旧。为什么不允许"跳过别人的那笔撤我自己上一笔"：那笔记录里存的是改动前的旧值，别人后来在同一些
        像素上写过的话，回填旧值会把他的改动一起冲掉。

        `expect_n` 把撤销钉在一条记录上：界面确认"撤销 李四 的 #7"之后到请求到达之间，本片可能又多了一笔；
        钉住了就不会撤错。
        """
        actor = Actor.coerce(by)
        if z is not None:
            self._check_z(z)
        with self.lock:
            log = self.edits()
            selected = None
            for i in range(len(log) - 1, -1, -1):
                entry = log[i] if z is None else self._edit_in_slice(log[i], z)
                if entry is not None:
                    selected = i, log[i], entry
                    break
            if selected is None:
                return None
            index, rec, undone = selected
            if expect_n is not None and int(rec["n"]) != int(expect_n):
                raise UndoMismatch(undone, int(expect_n))
            owner = rec.get("by") if isinstance(rec.get("by"), str) else None
            # 只拦"确知是别人的"：记录带账号（by_id / by_user）而且不是我。登录系统之前的旧记录只有个自报的名字，
            # 名字对不上多半是同一个人换了登录名（以前填"张三"，现在账号叫 y），登录用户撤它照旧放行；
            # 没开登录（actor 也只有名字）时仍按名字比。
            verified = rec.get("by_id") is not None or isinstance(rec.get("by_user"), str)
            if actor is not None and owner is not None and not same_actor(rec, actor) and not force and (verified or actor.id is None):
                raise UndoForbidden(undone)
            f = self._edit_dir() / f"{rec['n']:06d}.npz"
            d = self._load_edit(int(rec["n"]))
            xs, ys = d["xs"].astype(np.intp), d["ys"].astype(np.intp)
            zs = d["zs"].astype(np.intp) if "zs" in d else np.full(xs.shape, int(d["z"]), dtype=np.intp)
            chosen = np.ones(xs.shape, dtype=bool) if z is None else zs == z
            remaining = ~chosen
            seg = self._seg_writable()
            # 顺序决定中途失败（磁盘满、进程被杀）之后还能不能再撤。提交点是第 3 步 edits.jsonl 换成新版：
            #   1. 只撤了多片记录中的一片：先把剩下那部分写成 .npz.part（还不替换原文件）；
            #   2. 回填像素并落盘——做多少遍结果都一样；
            #   3. 用 .part + 改名整体替换 edits.jsonl（提交）。
            # 3 之前失败：日志和像素文件都原封不动，页面再点一次撤销会选中同一笔、回填同样的值，接着做完。
            # 3 之后的收尾（像素文件换成剩下那部分 / 整笔挪进 edits/undone/、记操作流水）只尽力而为：撤销已经生效，
            # 收尾失败只记日志，绝不能再告诉用户"没做完、再点一次"——那会把更早的一笔也撤掉。
            try:
                if remaining.any():
                    rest = {key: (value[remaining] if key in {"xs", "ys", "zs", "old", "new"} and value.ndim else value)
                            for key, value in d.items()}
                    partial = f.with_suffix(".npz.part")
                    with partial.open("wb") as out:
                        np.savez_compressed(out, **rest)
                        out.flush()
                        os.fsync(out.fileno())
                    log[index] = {**rec, "n_px": int(remaining.sum()), "n_slices": int(np.unique(zs[remaining]).size)}
                else:
                    log.pop(index)
                for k in np.unique(zs[chosen]):
                    m = chosen & (zs == k)
                    seg[xs[m], ys[m], int(k)] = d["old"][m] if np.ndim(d["old"]) else d["old"]
                seg.flush()
                for k in np.unique(zs[chosen]):
                    self._invalidate(int(k))
                log_path = self.work / (EDIT_LOG + ".part")
                with open(log_path, "w") as out:
                    out.write("".join(json.dumps(r) + "\n" for r in log))
                    out.flush()
                    os.fsync(out.fileno())
                log_path.replace(self.work / EDIT_LOG)       # ← 提交点
            except OSError as e:
                raise ValueError(f"撤销没做完（{e.strerror or e}），多半是磁盘满了；这一笔的记录还在，清理磁盘后再点一次撤销即可") from e
            try:
                self._retire_edit_file(f, int(rec["n"]), partial if remaining.any() else None)
            except OSError:
                logging.getLogger(__name__).exception("撤销 #%s 已生效，但改动文件没挪进回收目录（不影响结果）", rec["n"])
            try:
                self._audit_append({"action": "undo", "by": None, **(actor.stamp() if actor else {}), "n": int(rec["n"]),
                                    "kind": rec.get("kind"), "z": (None if z is None else int(z)), "n_px": int(undone.get("n_px") or 0),
                                    "of": owner, "of_user": rec.get("by_user"), "of_id": rec.get("by_id"),
                                    "forced": bool(force and owner is not None and not same_actor(rec, actor))})
            except (OSError, ValueError):
                logging.getLogger(__name__).exception("撤销 #%s 已生效，但操作流水没记上（这一片的版本号没有前进）", rec["n"])
            # deliberately NOT resetting _max_id: recomputing it rescans the whole volume (1.2 s on a 1024²x100
            # block) and it is only ever used to hand out an unused id. Staying high is safe — ids just skip —
            # and it also guarantees an undone id is never handed out again while its edit record still exists.
            return undone


    def _retire_edit_file(self, f: Path, n: int, partial: Path | None) -> None:
        """撤销提交之后的收尾：原来的像素文件在 edits/undone/ 留一份（不删）。只撤了多片记录中的一片时，
        再把剩下那部分（partial）换上去；整笔撤掉时原文件直接挪走。"""
        undone_dir = f.parent / UNDONE_DIR
        undone_dir.mkdir(exist_ok=True)
        keep = undone_dir / f"{n:06d}-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}.npz"
        if partial is None:
            os.replace(f, keep)
            return
        try:
            os.link(f, keep)                                 # 硬链接，不占空间
        except OSError:
            shutil.copy2(f, keep)
        partial.replace(f)

    def undo_all(self, z: int, by: "str | Actor | None" = None, force: bool = False) -> dict:
        """撤销本片全部有效改动——回到这一片标注前的样子。从最近一笔往前逐笔撤，直到本片没有记录；每一笔照样
        记入审计流水。权限同 undo：本片有别人的记录而没带 force，一笔都不动，直接抛 UndoForbidden（带那一笔）。"""
        self._check_z(z)
        actor = Actor.coerce(by)
        with self.lock:
            if actor is not None and not force:
                for rec in self.edits(z):
                    owner = rec.get("by") if isinstance(rec.get("by"), str) else None
                    verified = rec.get("by_id") is not None or isinstance(rec.get("by_user"), str)
                    if owner is not None and not same_actor(rec, actor) and (verified or actor.id is None):
                        raise UndoForbidden(rec)
            n = px = 0
            while True:
                undone = self.undo(z, by=actor, force=force)
                if undone is None:
                    break
                n += 1
                px += int(undone.get("n_px") or 0)
            return {"n": n, "n_px": px, "z": int(z)}


class AnnotateStore:
    def __init__(self, root: Path | None, workdir: Path | None = None, extra_roots: list[Path] | None = None, *, read_only: bool = False):
        self.root = Path(root) if root else None
        self.roots = [r for r in [self.root, *(Path(x) for x in (extra_roots or []))] if r]
        self.workdir = Path(workdir) if workdir else None
        self.read_only = read_only
        self._blocks: dict[str, Block] = {}
        self._lock = threading.Lock()

    def refresh(self) -> list[dict]:
        found = [p for r in self.roots for p in find_blocks(r)]
        with self._lock:
            for p in found:
                if p.name not in self._blocks:
                    try:
                        self._blocks[p.name] = Block(p, self.workdir, read_only=self.read_only)
                    except Exception as e:  # a half-copied block must not take the page down
                        self._blocks[p.name] = e  # type: ignore[assignment]
            return [self._summary(k) for k in sorted(self._blocks)]

    def _summary(self, key: str) -> dict:
        b = self._blocks[key]
        if isinstance(b, Exception):
            return {"block_id": key, "error": str(b)}
        z, y, x = b.shape_zyx
        try:
            log = b.edits()
            n_edits, history_error = len(log), None
            editors, last = [r["by"] for r in b.editors(records=log)], b.last_edit(log)
        except (OSError, ValueError) as e:
            n_edits, history_error, editors, last = None, str(e), [], None
        return {"block_id": b.id, "has_seg": b.has_seg, "nz": z, "height": y, "width": x, "dataset": b.meta.get("dataset", {}).get("id"),
                "n_edits": n_edits, "history_error": history_error, "editors": editors, "last_edit": last,
                "has_working_copy": b.work_path(SEG_EDIT).exists(), "path": str(b.path),
                # always em.npy: since sections are displayed transposed, the delivery's own PNGs can no longer be
                # served verbatim, so visual/slices_em is not an EM source any more (see em_png)
                "em_source": "em.npy", "voxel_size_nm": b.meta.get("geometry", {}).get("voxel_size_nm")}

    def get(self, block_id: str) -> Block:
        if block_id not in self._blocks:
            self.refresh()
        b = self._blocks.get(block_id)
        if b is None:
            raise KeyError(block_id)
        if isinstance(b, Exception):
            raise ValueError(str(b))
        return b
