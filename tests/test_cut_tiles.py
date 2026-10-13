"""scripts/cut_tiles.py：从原始块切小块做新批次。只新建、不碰任何已有标注；和现有批次同一套切法和 meta 约定。"""
import hashlib
import importlib.util
import json
import os
import sqlite3
import stat

import numpy as np
import pytest

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cut_tiles", ROOT / "scripts" / "cut_tiles.py")
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)


def _parent(base, name, shape=(8, 8, 3), seed=0):
    d = base / "blocks" / "h01" / name
    d.mkdir(parents=True)
    rng = np.random.default_rng(seed)
    np.save(d / "em.npy", np.asfortranarray(rng.integers(0, 255, shape, dtype=np.uint8)))      # 交付区的原始块是 F 顺序
    np.save(d / "seg.npy", np.asfortranarray(rng.integers(0, 2**40, shape, dtype=np.uint64)))
    (d / "meta.json").write_text(json.dumps({
        "schema_version": "1.0", "block_id": name,
        "dataset": {"id": "h01", "em_source": "precomputed://x/h01-release/em", "seg_source": "precomputed://x/h01-release/c3"},
        "geometry": {"origin": {"x": 1000, "y": 2000, "z": 30, "unit": "mip1 voxel"}, "size": {"x": shape[0], "y": shape[1], "z": shape[2]},
                     "voxel_size_nm": [8, 8, 33], "physical_size_um": [0.064, 0.064, 0.099]},
        "arrays": {"em": {"file": "em.npy"}, "seg": {"file": "seg.npy"}}, "provenance": {"tool": "crawl_delivery.py"}, "qc": {"x": 1}}))
    (d / "fingerprint.json").write_text(json.dumps({"uid": f"uid-{name}"}))
    return d


@pytest.fixture
def world(tmp_path):
    """一个实例：已有批次 h01-demo-v2（一个块、有改动、数据库里有审核记录）+ 交付区两个原始块。"""
    T = tmp_path / "inst"
    old = T / "var" / "annotation" / "h01-demo-v2" / "old_block"
    old.mkdir(parents=True)
    np.save(old / "em.npy", np.zeros((4, 4, 3), np.uint8))
    np.save(old / "seg.npy", np.zeros((4, 4, 3), np.uint64))
    work = T / "var" / "annotate" / "h01-demo-v2"
    (work / "old_block").mkdir(parents=True)
    (work / "old_block" / "edits.jsonl").write_text('{"n": 1}\n')
    db = T / "var" / "web-preview.db"
    con = sqlite3.connect(db)
    for t in ct.REVIEW_TABLES:
        con.execute(f"create table {t} (id integer primary key, block_id text)")
    con.execute("insert into annot_slice_reviews (block_id) values ('old_block')")
    con.commit(); con.close()
    D = tmp_path / "delivery"
    _parent(D, "h01_b0101", seed=1)
    _parent(D, "h01_b0102", seed=2)
    ds = D / "datasets" / "abc123"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps({"name": "h01-seg3d"}))
    (ds / "members.csv").write_text("block_id,uid,split,group\nh01_b0101,uid-h01_b0101,train,g1\nh01_b0102,uid-h01_b0102,val,g2\n")
    args = ["--instance", str(T), "--delivery", str(D), "--batch", "h01-train512-v1", "--workdir", str(work), "--db", str(db), "--size", "4"]
    yield T, D, work, db, args
    for p in tmp_path.rglob("*"):                         # 原件是只读的：放开写权限，pytest 才清得掉临时目录
        if p.is_dir() and not p.is_symlink():
            p.chmod(0o755)


def _tree_hashes(*roots):
    out = {}
    for r in roots:
        for p in sorted(Path(r).rglob("*")):
            if p.is_file():
                out[str(p)] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def test_cuts_tiles_exactly_like_the_current_batch(world):
    T, D, work, db, args = world
    before = _tree_hashes(T / "var" / "annotation" / "h01-demo-v2", work, D / "blocks")
    db_before = hashlib.sha256(db.read_bytes()).hexdigest()
    assert ct.main(args + ["h01_b0101", "h01_b0102"]) == 0
    imp, snap = T / "var" / "annotation" / "h01-train512-v1", T / "var" / "datasets" / "h01-train512-v1"
    names = sorted(p.name for p in imp.iterdir())
    assert names == [f"h01_b010{i}_y{y:04d}_x{x:04d}" for i in (1, 2) for y in (0, 4) for x in (0, 4)]
    pem = np.load(D / "blocks" / "h01" / "h01_b0101" / "em.npy")
    pseg = np.load(D / "blocks" / "h01" / "h01_b0101" / "seg.npy")
    tile = imp / "h01_b0101_y0004_x0000"
    em, seg = np.load(tile / "em.npy"), np.load(tile / "seg.npy")
    assert np.array_equal(em, pem[4:8, 0:4, :]) and np.array_equal(seg, pseg[4:8, 0:4, :]), "名字里 y 是第 0 轴、x 是第 1 轴"
    assert em.flags.c_contiguous and em.dtype == np.uint8 and seg.dtype == np.uint64, "和现有批次一样存成 C 顺序"
    assert os.path.islink(tile / "em.npy") and not os.path.isabs(os.readlink(tile / "em.npy")), "导入目录里是指向原件的相对链接"
    m = json.loads((tile / "meta.json").read_text())
    assert m["block_id"] == tile.name and m["parent_block"] == "h01_b0101" and m["parent_uid"] == "uid-h01_b0101"
    assert m["geometry"]["origin"] == {"x": 1000, "y": 2000, "z": 30, "unit": "mip1 voxel"}, "原点用原始块的，不加偏移"
    assert m["geometry"]["offset_in_parent"] == {"y0": 4, "x0": 0} and m["quadrant"]["index"] == 2
    assert m["dataset"]["id"] == "h01-q" and "qc" not in m
    assert m["parent_splits"] == {"h01-seg3d": {"dataset_id": "abc123", "split": "train", "group": "g1"}}
    assert json.loads((imp / "h01_b0102_y0000_x0000" / "meta.json").read_text())["parent_splits"]["h01-seg3d"]["split"] == "val"
    f = snap / "tiles" / tile.name / "seg.npy"
    assert not os.access(f, os.W_OK) and stat.S_IMODE(f.stat().st_mode) == 0o444 and stat.S_IMODE(f.parent.stat().st_mode) == 0o555
    man = json.loads((T / "var" / "manifests" / "h01-train512-v1.json").read_text())
    assert man["n_tiles"] == 8 and set(man["parents"]) == {"h01_b0101", "h01_b0102"}
    for rec in man["files"]:
        assert hashlib.sha256((T / rec["path"]).read_bytes()).hexdigest() == rec["sha256"]
    assert not list((T / "var" / "datasets").glob(".incoming-*")), "临时目录都改名到位了"
    assert _tree_hashes(T / "var" / "annotation" / "h01-demo-v2", work, D / "blocks") == before, "已有标注、工作目录、原始块一个字节都没动"
    assert hashlib.sha256(db.read_bytes()).hexdigest() == db_before, "数据库没动"


def test_platform_reads_new_tiles_and_groups_them_as_a_new_batch(world, monkeypatch):
    T, D, work, db, args = world
    assert ct.main(args + ["h01_b0101"]) == 0
    from emqc.annotate.store import Block
    b = Block(T / "var" / "annotation" / "h01-train512-v1" / "h01_b0101_y0000_x0004", T / "scratch-work", read_only=True)
    pem = np.load(D / "blocks" / "h01" / "h01_b0101" / "em.npy")
    assert b.shape_zyx == (3, 4, 4) and np.array_equal(b.em_slice(1), pem[0:4, 4:8, 1].T)
    from emqc.api.routers import annotate
    from emqc.config import settings
    monkeypatch.setattr(settings, "annotate_root", T / "var" / "annotation" / "h01-demo-v2")
    monkeypatch.setattr(settings, "annotate_extra_roots", str(T / "var" / "annotation" / "h01-train512-v1"))
    monkeypatch.setattr(settings, "sam_blocks_dir", None)
    monkeypatch.setattr(settings, "annotate_workdir", T / "scratch-work")
    annotate.reset_store()
    try:
        rows = annotate.with_batch(annotate.get_store(read_only=True).refresh())
        assert [(r["batch_id"], r["block_id"]) for r in rows][:2] == [("h01-demo-v2", "old_block"), ("h01-train512-v1", "h01_b0101_y0000_x0000")]
        assert {r["batch_id"] for r in rows} == {"h01-demo-v2", "h01-train512-v1"}
    finally:
        annotate.reset_store()


@pytest.mark.parametrize("make_clash, msg", [
    (lambda T, work, db: (work / "h01_b0101_y0000_x0000").mkdir(), "工作目录"),
    (lambda T, work, db: (sqlite3.connect(db).execute("insert into annot_marks (block_id) values ('h01_b0101_y0004_x0004')").connection.commit()), "数据库"),
    (lambda T, work, db: (T / "var" / "annotation" / "h01-train512-v1").mkdir(), "已经存在"),
    (lambda T, work, db: (T / "var" / "manifests").mkdir(parents=True) or (T / "var" / "manifests" / "h01-train512-v1.json").write_text("{}"), "已经存在"),
])
def test_refuses_and_writes_nothing_on_any_clash(world, capsys, make_clash, msg):
    T, D, work, db, args = world
    make_clash(T, work, db)
    before = _tree_hashes(T / "var")
    assert ct.main(args + ["h01_b0101"]) == 2
    assert msg in capsys.readouterr().err
    assert _tree_hashes(T / "var") == before and not (T / "var" / "datasets").exists()


def test_same_name_in_another_import_directory_is_refused(world, capsys):
    T, D, work, db, args = world
    other = T / "var" / "annotation" / "h01-demo-v1" / "h01_b0101_y0000_x0000"
    other.mkdir(parents=True)
    np.save(other / "em.npy", np.zeros((4, 4, 3), np.uint8))
    assert ct.main(args + ["h01_b0101"]) == 2 and "同名数据块" in capsys.readouterr().err


def test_dry_run_writes_nothing(world, capsys):
    T, D, work, db, args = world
    before = _tree_hashes(T)
    assert ct.main(args + ["--dry-run", "h01_b0101"]) == 0
    assert "什么都没写" in capsys.readouterr().out and _tree_hashes(T) == before and not (T / "var" / "datasets").exists()


def test_bad_inputs_are_refused(world, capsys):
    T, D, work, db, args = world
    _parent(D, "h01_b0199", shape=(6, 8, 3))
    assert ct.main(args + ["h01_b0199"]) == 2 and "整数倍" in capsys.readouterr().err
    assert ct.main(args + ["h01_b0101", "h01_b0101"]) == 2
    bad = list(args); bad[bad.index("h01-train512-v1")] = ".hidden"
    assert ct.main(bad + ["h01_b0101"]) == 2
    assert ct.main(args + ["h01_b9999"]) == 2
