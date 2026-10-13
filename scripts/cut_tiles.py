#!/usr/bin/env python
"""从交付区的原始块（1024²×100）切出 S×S 的小块，做成标注平台的一个新批次（导入目录）。只新建，不改、不删任何已有文件。

和团队现有批次 h01-demo-v2 同一套约定（2026-10-13 在服务器上逐字节核对过）：
  小块 <原始块>_yYYYY_xXXXX = 原始块[YYYY:YYYY+S, XXXX:XXXX+S, :]，C 顺序存储。名字里的 y 是第 0 轴、x 是第 1 轴
  （沿用 scripts/block_quadrants.py 的命名；平台显示时第 0 轴画在横向）。meta.json 的 geometry.origin 用原始块的原点、
  不加偏移，偏移记在 offset_in_parent {y0, x0}，Neuroglancer 换算时只加一次（见 emqc/annotate/neuroglancer.py）。

产物（实例目录 T 下）：
  var/datasets/<批次>/tiles/<小块>/{em.npy, seg.npy, meta.json}   只读原件（文件 0444、目录 0555）
  var/annotation/<批次>/<小块>/{em.npy, seg.npy, meta.json}       导入目录：两个数组是指向原件的相对链接
  var/manifests/<批次>.json                                         清单：每个文件的 sha256，来源原始块的 uid 和它在各训练数据集里的划分
都先写在 var/datasets/ 下的 .incoming-* 临时目录里：每块和原始块逐字节核对、用平台自己的读法核对之后，先把原件改名到
var/datasets/<批次>（平台不读这里），再确认导入目录的链接都指到这些原件，最后才把导入目录改名到 var/annotation/<批次>。
中途失败不会有任何东西出现在 var/annotation 里（临时目录留着，不自动删）。

动手之前检查（--dry-run 只做这些）：批次名合法、三个目标都不存在；原始块只写目录名、形状 / 类型对、meta 里有原点；
小块名字和平台能看到的所有数据块（var/annotation、var/sam_blocks 下每一项，以及 --root 给的根目录）、标注工作目录、
数据库里的审核和标记记录都不重名（重名会把别人已有的改动配到新数据上）；磁盘够。

接进服务（另外做，要重启）：run.sh 里加 export EMQC_ANNOTATE_EXTRA_ROOTS=$T/var/annotation/<批次>，再
systemctl --user restart emqc-8792。

用法：
  python scripts/cut_tiles.py --instance T --delivery DELIVERY --batch h01-train512-v1 \\
      --workdir T/var/annotate/h01-demo-v2 --db T/var/web-preview.db  h01_b0004 h01_b0008 ...   [--dry-run]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BATCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")      # 原始块只能写目录名：不许路径、..、末尾斜杠
REVIEW_TABLES = ("annot_marks", "annot_slice_reviews", "annot_review_events")


class Refuse(Exception):
    """检查没过：什么都没写。"""


def _header(path: Path) -> tuple[tuple, np.dtype, bool]:
    fmt = np.lib.format
    with open(path, "rb") as fh:
        version = fmt.read_magic(fh)
        shape, fortran, dtype = (fmt.read_array_header_1_0 if version == (1, 0) else fmt.read_array_header_2_0)(fh)
    return tuple(shape), np.dtype(dtype), bool(fortran)


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def _save(path: Path, arr: np.ndarray) -> None:
    with open(path, "xb") as fh:                  # x：文件已存在就失败，绝不覆盖
        np.save(fh, arr)
        fh.flush()
        os.fsync(fh.fileno())


def _write_json(path: Path, obj) -> None:
    with open(path, "x", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())


def _git_commit() -> str | None:
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              timeout=10).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _existing_block_names(instance: Path, extra_roots: list[Path]) -> set[str]:
    """平台能看到的所有数据块名字：var/annotation 和 var/sam_blocks 下的每一项（是符号链接就先解析，和平台对根目录的处理一样），
    再加上实例配置里写的根目录（--root）。找法用平台自己的 find_blocks。"""
    sys.path.insert(0, str(ROOT))
    from emqc.annotate.store import find_blocks

    roots = [Path(r).resolve() for r in extra_roots]
    for base in (instance / "var" / "annotation", instance / "var" / "sam_blocks"):
        if base.is_dir():
            roots += [c.resolve() for c in base.iterdir() if c.is_dir()]
    return {p.name for r in roots for p in find_blocks(r)}


def _db_block_ids(db: Path) -> set[str]:
    """数据库里审核 / 标记记录用到的块名（只读打开）。"""
    if not db.exists():
        raise Refuse(f"数据库 {db} 不存在")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        have = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
        ids = set()
        for t in REVIEW_TABLES:
            if t in have:
                ids |= {r[0] for r in con.execute(f"select distinct block_id from {t}")}
        return ids
    finally:
        con.close()


def _splits(delivery: Path) -> dict[str, dict]:
    """各训练数据集（delivery/datasets/*/members.csv）里每个原始块的划分（train / val / test）和分组。"""
    out: dict[str, dict] = {}
    for members in sorted((delivery / "datasets").glob("*/members.csv")):
        try:
            name = json.loads((members.parent / "dataset.json").read_text()).get("name") or members.parent.name
        except (OSError, ValueError):
            name = members.parent.name
        with open(members, newline="") as fh:
            for r in csv.DictReader(fh):
                # 按数据集 id 记（同名的数据集可能重建过好几次，按名字记会互相覆盖）
                out.setdefault(r["block_id"], {})[members.parent.name] = {"name": name, "split": r.get("split"),
                                                                          "group": r.get("group")}
    return out


def plan(args) -> dict:
    """所有检查；返回要做的事。任何一项不过就 Refuse（什么都还没写）。"""
    T, S = Path(args.instance).resolve(), int(args.size)
    delivery = Path(args.delivery).resolve()
    parents_dir = delivery / "blocks" / args.dataset
    if not BATCH_RE.match(args.batch):
        raise Refuse(f"批次名 {args.batch!r} 不合法：只用字母、数字、点、横线、下划线，不以点开头")
    snap, imp, manifest = T / "var" / "datasets" / args.batch, T / "var" / "annotation" / args.batch, T / "var" / "manifests" / f"{args.batch}.json"
    for p in (snap, imp, manifest):
        if p.exists() or p.is_symlink():
            raise Refuse(f"{p} 已经存在：一个批次只切一次，换个批次名，或者先确认那边是什么")
    for p in (snap, imp):
        if p.is_relative_to(delivery):
            raise Refuse("输出不能放在交付区里")
    workdir, db = Path(args.workdir).resolve(), Path(args.db).resolve()
    if not workdir.is_dir():
        raise Refuse(f"标注工作目录 {workdir} 不存在（用来检查重名，必须给对）")
    if len(set(args.parents)) != len(args.parents):
        raise Refuse("原始块重复了")
    for name in args.parents:
        if not NAME_RE.match(name) or Path(name).name != name:
            raise Refuse(f"原始块要写目录名（如 h01_b0004），不能写路径：{name!r}")
    # 导入目录里的链接是 ../../../datasets/...：var/annotation 和 var/datasets 必须真的是同一个 var 下的兄弟目录
    va, vd = (T / "var" / "annotation"), (T / "var" / "datasets")
    if (va.exists() and va.resolve().parent != (T / "var").resolve()) or (vd.exists() and vd.resolve().parent != (T / "var").resolve()):
        raise Refuse("var/annotation 或 var/datasets 是指到别处的符号链接，导入目录里的相对链接会断，先确认目录结构")
    tiles, nbytes = [], 0
    for name in args.parents:
        pdir = parents_dir / name
        if not (pdir / "em.npy").is_file() or not (pdir / "seg.npy").is_file() or not (pdir / "meta.json").is_file():
            raise Refuse(f"{pdir} 里没有 em.npy / seg.npy / meta.json")
        (es, ed, _), (ss, sd, _) = _header(pdir / "em.npy"), _header(pdir / "seg.npy")
        if len(es) != 3 or es != ss:
            raise Refuse(f"{name}: em {es} 和 seg {ss} 形状不一致或不是三维")
        if ed != np.uint8 or sd != np.uint64:
            raise Refuse(f"{name}: 类型应为 em uint8、seg uint64，实际 {ed} / {sd}")
        if es[0] % S or es[1] % S:
            raise Refuse(f"{name}: {es[0]}×{es[1]} 不是 {S} 的整数倍")
        try:
            o = json.loads((pdir / "meta.json").read_text()).get("geometry", {}).get("origin")
            ok = isinstance(o, dict) and all(isinstance(o.get(k), int) for k in ("x", "y", "z"))
        except (OSError, ValueError, AttributeError):
            ok = False
        if not ok:
            raise Refuse(f"{name}: meta.json 里没有整数的 geometry.origin {{x, y, z}}（Neuroglancer 定位要用）")
        for y0 in range(0, es[0], S):
            for x0 in range(0, es[1], S):
                tiles.append({"name": f"{name}_y{y0:04d}_x{x0:04d}", "parent": name, "pdir": pdir, "y0": y0, "x0": x0,
                              "index": (y0 // S) * (es[1] // S) + x0 // S, "z": es[2], "pw": es[1]})
                nbytes += S * S * es[2] * (1 + 8)
    names = [t["name"] for t in tiles]
    clash = sorted(set(names) & _existing_block_names(T, [Path(r) for r in (args.root or [])]))
    if clash:
        raise Refuse(f"这些名字已经有同名数据块了：{', '.join(clash)}")
    clash = sorted(n for n in names if (workdir / n).exists())
    if clash:
        raise Refuse(f"标注工作目录里已经有这些名字的改动目录：{', '.join(clash)}（新数据会被配上旧改动，绝对不行）")
    clash = sorted(set(names) & _db_block_ids(db))
    if clash:
        raise Refuse(f"数据库里已经有这些块的审核 / 标记记录：{', '.join(clash)}")
    free = shutil.disk_usage(T / "var").free
    need = int(nbytes * 1.1) + (1 << 30)
    if free < need:
        raise Refuse(f"磁盘不够：要 {need / 2**30:.1f} GB，只剩 {free / 2**30:.1f} GB")
    return {"T": T, "S": S, "delivery": delivery, "snap": snap, "imp": imp, "manifest": manifest, "tiles": tiles,
            "bytes": nbytes, "free": free, "splits": _splits(delivery)}


def _tile_meta(p: dict, t: dict, pmeta: dict, fp: dict, batch: str, commit: str | None, now: str) -> dict:
    S, Z = p["S"], t["z"]
    g = pmeta.get("geometry") or {}
    vox = g.get("voxel_size_nm") or [8, 8, 33]
    ds = dict(pmeta.get("dataset") or {})
    if ds.get("id"):
        ds["id"] = f"{ds['id']}-q"
    phys = [round(S * vox[0] / 1000, 6), round(S * vox[1] / 1000, 6), round(Z * vox[2] / 1000, 6)]
    return {
        "schema_version": pmeta.get("schema_version"),
        "block_id": t["name"],
        "dataset": ds,
        "geometry": {"origin": g.get("origin"), "size": {"rows": S, "cols": S, "z": Z}, "voxel_size_nm": vox,
                     "physical_size_um": phys, "offset_in_parent": {"y0": t["y0"], "x0": t["x0"]}},
        "arrays": _tile_arrays(pmeta.get("arrays"), S, Z),
        "provenance": pmeta.get("provenance"),
        "parent_block": pmeta.get("block_id") or t["parent"],
        "parent_uid": fp.get("uid"),
        # 训练数据划分按原始块定：同一原始块切出来的小块共享细胞，必须跟着原始块进同一个划分，不能拆开
        "parent_splits": p["splits"].get(pmeta.get("block_id") or t["parent"], {}),
        "quadrant": {"index": t["index"], "y0": t["y0"], "x0": t["x0"], "size": S},
        "workspace_import": {
            "source": f"var/datasets/{batch}/tiles/{t['name']}",
            "parent_source": str(t["pdir"]),
            "source_geometry": g,
            "transform": "none; links to canonical read-only YXZ source arrays",
            "array_axes": "y,x,z",
            "source_axes": "y,x,z",
            "geometry_note": ("Origin is the source parent origin, not the tile corner. Neuroglancer adds offset_in_parent exactly once: "
                              "volume X = origin.x + y0 + screen_x; volume Y = origin.y + x0 + screen_y; volume Z = origin.z + z. "
                              f"Physical size recalculated for {S}x{S}x{Z}; parent QC not copied."),
            "parent_arrays": pmeta.get("arrays"),
            "cut_by": "scripts/cut_tiles.py", "platform_commit": commit, "cut_at": now,
        },
    }


def _tile_arrays(parent: dict | None, S: int, Z: int) -> dict:
    """meta.arrays 写小块自己的事实：保留文件名、类型、含义这类描述，形状和存储顺序按小块改；原始块的 bytes / sha256 不抄
    （小块文件的 sha256 在清单里）。原始块的 arrays 原样留在 workspace_import.parent_arrays。"""
    out = {}
    for key, info in (parent or {"em": {"file": "em.npy", "dtype": "uint8"}, "seg": {"file": "seg.npy", "dtype": "uint64"}}).items():
        info = dict(info) if isinstance(info, dict) else {}
        for drop in ("bytes", "sha256", "byte_order_sha256"):
            info.pop(drop, None)
        if "shape" in info:
            info["shape"] = [S, S, Z]
        if "fortran_order" in info:
            info["fortran_order"] = False
        out[key] = info
    return out


def _self_check(tile_dir: Path, pem: np.ndarray, t: dict, S: int) -> None:
    """用平台自己的读法打开小块（只读、临时工作目录）：形状、显示出来的切片、Neuroglancer 坐标都要对。"""
    sys.path.insert(0, str(ROOT))
    from emqc.annotate.neuroglancer import global_position
    from emqc.annotate.store import Block

    with tempfile.TemporaryDirectory() as tmp:
        b = Block(tile_dir, Path(tmp), read_only=True)
        if b.shape_zyx != (t["z"], S, S):
            raise RuntimeError(f"{t['name']}: 平台读到的形状 {b.shape_zyx} 不对")
        for z in sorted({0, t["z"] // 2, t["z"] - 1}):
            if not np.array_equal(b.em_slice(z), np.asarray(pem[t["y0"]:t["y0"] + S, t["x0"]:t["x0"] + S, z]).T):
                raise RuntimeError(f"{t['name']}: 平台显示的第 {z} 片和原始块对不上")
        o = b.meta["geometry"]["origin"]
        want = [int(o["x"]) + t["y0"], int(o["y"]) + t["x0"], int(o["z"])]
        if global_position(b.meta, 0, 0, 0) != want:
            raise RuntimeError(f"{t['name']}: Neuroglancer 坐标换算不对")


def cut(p: dict, batch: str) -> dict:
    T, S = p["T"], p["S"]
    tag = uuid.uuid4().hex[:8]
    stage = T / "var" / "datasets" / f".incoming-{batch}-{tag}"
    stage_imp = T / "var" / "datasets" / f".incoming-import-{batch}-{tag}"
    commit, now = _git_commit(), datetime.now(timezone.utc).isoformat(timespec="seconds")
    files, parents = [], {}
    (stage / "tiles").mkdir(parents=True)
    stage_imp.mkdir()
    for t in p["tiles"]:
        pdir = t["pdir"]
        pem, pseg = np.load(pdir / "em.npy", mmap_mode="r"), np.load(pdir / "seg.npy", mmap_mode="r")
        pmeta = json.loads((pdir / "meta.json").read_text())
        fp = json.loads((pdir / "fingerprint.json").read_text()) if (pdir / "fingerprint.json").is_file() else {}
        sl = (slice(t["y0"], t["y0"] + S), slice(t["x0"], t["x0"] + S), slice(None))
        d = stage / "tiles" / t["name"]
        d.mkdir()
        for fname, src in (("em.npy", pem), ("seg.npy", pseg)):
            _save(d / fname, np.ascontiguousarray(src[sl]))
            back = np.load(d / fname, mmap_mode="r")
            if not back.flags.c_contiguous or not np.array_equal(back, src[sl]):     # 逐字节和原始块那一片核对
                raise RuntimeError(f"{t['name']}/{fname} 写出来和原始块对不上")
            del back
        meta = _tile_meta(p, t, pmeta, fp, batch, commit, now)
        _write_json(d / "meta.json", meta)
        di = stage_imp / t["name"]
        di.mkdir()
        for fname in ("em.npy", "seg.npy"):                  # 指向最终位置的相对链接（改名到位后才解析得通）
            (di / fname).symlink_to(Path("..") / ".." / ".." / "datasets" / batch / "tiles" / t["name"] / fname)
        _write_json(di / "meta.json", meta)
        for fname in ("em.npy", "seg.npy", "meta.json"):
            files.append({"path": f"var/datasets/{batch}/tiles/{t['name']}/{fname}", "sha256": _sha(d / fname)})
        files.append({"path": f"var/annotation/{batch}/{t['name']}/meta.json", "sha256": _sha(di / "meta.json")})
        parents.setdefault(t["parent"], {"parent_block": meta["parent_block"], "uid": meta["parent_uid"],
                                         "splits": meta["parent_splits"], "source": str(pdir), "tiles": []})["tiles"].append(t["name"])
        print(f"  {t['name']}  ✓", flush=True)
    # 先在暂存区里用平台自己的读法核对每一块（这时还什么都没发布）
    for t in p["tiles"]:
        _self_check(stage / "tiles" / t["name"], np.load(t["pdir"] / "em.npy", mmap_mode="r"), t, S)
    # 原件设只读，改名到位（var/datasets/<批次>：平台不读这里，出现了也不会被服务）
    for f in (stage / "tiles").rglob("*"):
        if f.is_file():
            f.chmod(0o444)
    for d in sorted((x for x in stage.rglob("*") if x.is_dir()), key=lambda x: -len(x.parts)):
        d.chmod(0o555)
    if p["snap"].exists() or p["imp"].exists():
        raise RuntimeError("切的过程中目标目录被别人建了：停下，什么都没发布")
    os.rename(stage, p["snap"])
    p["snap"].chmod(0o555)
    # 导入目录的链接（和最终位置同样深，现在已经能解析）必须指到刚发布的原件，确认后才改名到 var/annotation
    for t in p["tiles"]:
        for fname in ("em.npy", "seg.npy"):
            if not os.path.samefile(stage_imp / t["name"] / fname, p["snap"] / "tiles" / t["name"] / fname):
                raise RuntimeError(f"{t['name']}/{fname} 的链接没有指到原件")
    os.rename(stage_imp, p["imp"])
    manifest = {"batch": batch, "created_at": now, "tool": "scripts/cut_tiles.py", "platform_commit": commit, "tile_size": S,
                "order": "C", "naming": "<parent>_yYYYY_xXXXX = parent[YYYY:YYYY+S, XXXX:XXXX+S, :]",
                "snapshot": f"var/datasets/{batch}", "import_root": f"var/annotation/{batch}",
                "parents": parents, "n_tiles": len(p["tiles"]), "files": files}
    tmp = p["manifest"].with_name(f".{p['manifest'].name}.{tag}")
    p["manifest"].parent.mkdir(parents=True, exist_ok=True)
    _write_json(tmp, manifest)
    os.rename(tmp, p["manifest"])
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parents", nargs="+", help="原始块目录名，如 h01_b0004")
    ap.add_argument("--instance", required=True, help="平台实例目录（var/ 在它下面）")
    ap.add_argument("--delivery", required=True, help="交付区（下面有 blocks/<数据集>/<原始块> 和 datasets/）")
    ap.add_argument("--dataset", default="h01")
    ap.add_argument("--batch", required=True, help="新批次名 = 导入目录名，定了以后不要改")
    ap.add_argument("--workdir", required=True, help="实例的 EMQC_ANNOTATE_WORKDIR，用来检查重名")
    ap.add_argument("--db", required=True, help="实例的 SQLite 数据库，用来检查重名（只读）")
    ap.add_argument("--root", action="append", help="实例配置的数据块根目录（EMQC_ANNOTATE_ROOT / EXTRA_ROOTS / SAM 目录），可重复；用来查重名")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--dry-run", action="store_true", help="只检查，什么都不写")
    a = ap.parse_args(argv)
    try:
        p = plan(a)
    except Refuse as e:
        print(f"没有动手：{e}", file=sys.stderr)
        return 2
    print(f"批次 {a.batch}：{len(a.parents)} 个原始块 → {len(p['tiles'])} 块 {p['S']}×{p['S']}，"
          f"约 {p['bytes'] / 2**30:.1f} GB（剩 {p['free'] / 2**30:.0f} GB）")
    for t in p["tiles"]:
        print(f"  {t['name']}  ← {t['parent']}[{t['y0']}:{t['y0'] + p['S']}, {t['x0']}:{t['x0'] + p['S']}, :]")
    print(f"原件 → {p['snap']}\n导入目录 → {p['imp']}\n清单 → {p['manifest']}")
    if a.dry_run:
        print("（--dry-run：检查都通过了，什么都没写）")
        return 0
    m = cut(p, a.batch)
    print(f"完成：{m['n_tiles']} 块，清单 {p['manifest']}。接进服务：run.sh 加 "
          f"export EMQC_ANNOTATE_EXTRA_ROOTS={p['imp']}，再 systemctl --user restart emqc-8792")
    return 0


if __name__ == "__main__":
    sys.exit(main())
