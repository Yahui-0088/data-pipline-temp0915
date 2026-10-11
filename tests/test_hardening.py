"""上线前审查修掉的问题：全站登录关卡和角色、输入校验、写入顺序与撤销的原子性、磁盘满、缓存失效、并发与资源上限。

每条测试对应审查报告里的一条（编号见各测试的说明），测的是"坏情况发生时数据还在、服务还在"。
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from emqc import auth, logs
from emqc.annotate import store as store_mod
from emqc.annotate.store import Block
from test_auth import PW, auth_on, login, make_user  # noqa: F401  (auth_on 是 fixture)
from test_who import make_block


@pytest.fixture
def app(auth_on):  # noqa: F811
    from emqc.api.app import app as fastapi_app

    return fastapi_app


@pytest.fixture(scope="module")
def qc_client(qc_run):
    from emqc.api.app import app as fastapi_app

    with TestClient(fastapi_app) as c:
        yield c


@pytest.fixture(scope="module")
def ann_client(tmp_path_factory):
    """一个 24×32×3 的小块 b0（标签 5 和 9 各占一半），没开登录。"""
    from emqc.api.app import app as fastapi_app
    from emqc.api.routers.annotate import reset_store
    from emqc.config import settings

    root = tmp_path_factory.mktemp("hard") / "blocks"
    b = root / "demo" / "b0"
    b.mkdir(parents=True)
    seg = np.zeros((32, 24, 3), np.uint64)
    seg[:16], seg[16:] = 5, 9
    np.save(b / "em.npy", np.full((32, 24, 3), 128, np.uint8))
    np.save(b / "seg.npy", seg)
    old = settings.annotate_root, settings.annotate_workdir
    settings.annotate_root, settings.annotate_workdir = root, tmp_path_factory.mktemp("hard-work")
    reset_store()
    with TestClient(fastapi_app) as c:
        yield c
    settings.annotate_root, settings.annotate_workdir = old
    reset_store()


# ---------------------------------------------------------------- 全站登录关卡（审查 #1）
def test_everything_but_login_needs_a_session(app):
    with TestClient(app) as c:
        assert c.get("/api/v1/datasets").status_code == 401, "数据清洗接口也要登录"
        assert c.delete("/api/v1/datasets/whatever").status_code == 401
        assert c.post("/api/v1/qc/runs", json={"dataset_id": "x"}).status_code == 401
        assert c.get("/api/v1/data/x/cutout?z0=0&z1=1&y0=0&y1=1&x0=0&x1=1").status_code == 401, "原始数据下载要登录"
        assert c.get("/api/v1/system/metrics").status_code == 401
        assert c.get("/openapi.json").status_code == 401, "接口清单不对未登录的人公开"
        assert c.get("/previews/anything.png", follow_redirects=False).status_code in (303, 401), "挂载的静态目录也在关卡后面"
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/login?next=%2F", "数据清洗首页跳登录"
        r = c.get("/datasets/abc", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"].startswith("/login?next=")
        # 公开的只有这些
        assert c.get("/login").status_code == 200
        assert c.get("/static/app.js").status_code == 200
        assert c.get("/api/v1/auth/status").status_code == 200
        h = c.get("/api/v1/health").json()
        assert h["status"] in ("ok", "degraded") and "data_root" not in h and "disk_ok" in h, "探活不登录也能用，但不报路径"
        assert c.post("/api/v1/logs/client", json={"message": "x"}).status_code == 200


def test_roles_on_destructive_and_heavy_routes(app):
    make_user("anno", role="annotator")
    make_user("rev", role="reviewer")
    make_user("boss", role="admin")
    with TestClient(app) as c:
        assert login(c, "anno").status_code == 200
        assert c.get("/api/v1/datasets").status_code == 200, "标注员可以看"
        r = c.delete("/api/v1/datasets/nope")
        assert r.status_code == 403, "标注员不能删数据集"
        assert c.post("/api/v1/qc/runs", json={"dataset_id": "nope"}).status_code == 403, "也不能起 QC"
        assert c.post("/api/v1/exports", json={"dataset_id": "nope"}).status_code == 403
        assert c.post("/api/v1/crawl/jobs", json={}).status_code == 403
        assert c.delete("/api/v1/patchsets/1").status_code == 403
    with TestClient(app) as c:
        login(c, "rev")
        assert c.post("/api/v1/qc/runs", json={"dataset_id": "nope"}).status_code == 404, "审核员能起任务（数据集不存在才 404）"
        assert c.delete("/api/v1/datasets/nope").status_code == 403, "删除只有管理员能做"
    with TestClient(app) as c:
        login(c, "boss")
        assert c.delete("/api/v1/datasets/nope").status_code == 404, "管理员过了权限（数据集不存在才 404）"
        r = c.post("/api/v1/qc/runs", json={"dataset_id": "nope", "sync": True})
        assert r.status_code in (404, 422)


def test_sync_jobs_are_refused_when_deployed(app, registered):
    make_user("rev2", role="reviewer")
    with TestClient(app) as c:
        login(c, "rev2")
        r = c.post("/api/v1/qc/runs", json={"dataset_id": registered, "sync": True})
        assert r.status_code == 422 and "同步" in r.text, "正式部署里不能在请求线程里跑整个 QC"
        assert c.post("/api/v1/exports", json={"dataset_id": registered, "sync": True}).status_code == 422


def test_service_token_reads_and_runs_but_never_edits_or_deletes(app, monkeypatch):
    from emqc.config import settings

    monkeypatch.setattr(settings, "api_token", "t0k3n-for-tests-0123456789")
    with TestClient(app) as c:
        assert c.get("/api/v1/datasets", headers={"X-EMQC-Token": "wrong"}).status_code == 401
        h = {"X-EMQC-Token": "t0k3n-for-tests-0123456789"}
        assert c.get("/api/v1/datasets", headers=h).status_code == 200
        assert c.get("/api/v1/datasets", headers={"Authorization": "Bearer t0k3n-for-tests-0123456789"}).status_code == 200
        assert c.post("/api/v1/qc/runs", json={"dataset_id": "nope"}, headers=h).status_code == 404, "能起任务"
        assert c.delete("/api/v1/datasets/nope", headers=h).status_code == 403, "不能删"
        assert c.post("/api/v1/annotate/blocks/x/paint", json={"z": 0, "points": [[0, 0]], "new_id": 1}, headers=h).status_code == 401, \
            "改标注必须是登录的真人，改动要记在人名下"
        assert c.get("/api/v1/auth/users", headers=h).status_code == 401, "不能管账号"
    monkeypatch.setattr(settings, "api_token", "")
    with TestClient(app) as c:
        assert c.get("/api/v1/datasets", headers={"X-EMQC-Token": ""}).status_code == 401, "没配令牌时这条路是关的"


def test_loader_sends_the_token(monkeypatch):
    from emqc import loader

    seen = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, *a):
            return json.dumps({"patches": []}).encode()

    monkeypatch.setattr(loader.urllib.request, "urlopen", lambda req, timeout=0: seen.append(req) or Resp())
    monkeypatch.setenv("EMQC_API_TOKEN", "abc")
    loader.PatchSetClient("http://x", 1)
    assert seen[-1].get_header("X-emqc-token") == "abc"


def test_must_change_password_blocks_the_qc_side_too(app):
    make_user("fresh", role="reviewer", must_change=True)
    with TestClient(app) as c:
        login(c, "fresh")
        r = c.get("/api/v1/datasets")
        assert r.status_code == 403 and r.json()["detail"]["code"] == "password"
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/account?force=1"


def test_forwarded_for_is_not_trusted_and_tunnel_users_do_not_share_a_throttle(app):
    make_user("a1", role="annotator")
    make_user("a2", role="annotator")
    with TestClient(app, client=("127.0.0.1", 50000)) as c:          # 经 SSH 隧道进来的样子
        for _ in range(auth.FAIL_LIMIT):
            login(c, "a1", "wrong-password")
        assert login(c, "a1").status_code == 429, "同一个登录名错太多次要等"
        assert login(c, "a2").status_code == 200, "经隧道进来的人来源 IP 都一样，一个人输错不能把所有人锁在外面"
    from starlette.requests import Request

    req = Request({"type": "http", "headers": [(b"x-forwarded-for", b"6.6.6.6")], "client": ("10.0.0.5", 1)})
    from emqc.api.routers.auth import client_ip

    assert client_ip(req) == "10.0.0.5", "客户端自己填的 X-Forwarded-For 不算数"


def test_open_mode_caps_new_accounts(app, monkeypatch):
    from emqc.config import settings

    monkeypatch.setattr(settings, "auth_open", True)
    monkeypatch.setattr(auth, "NEW_ACCOUNT_LIMIT", 2)
    auth._NEW_ACCOUNTS.clear()
    try:
        with TestClient(app) as c:
            assert c.post("/api/v1/auth/login", json={"username": "新人一"}).status_code == 200
            assert c.post("/api/v1/auth/login", json={"username": "新人二"}).status_code == 200
            r = c.post("/api/v1/auth/login", json={"username": "新人三"})
            assert r.status_code == 429, "试用模式一小时内自动建号有上限"
            assert c.post("/api/v1/auth/login", json={"username": "新人一"}).status_code == 200, "已有的账号照常进"
    finally:
        auth._NEW_ACCOUNTS.clear()


def test_session_survives_a_short_database_outage(app, monkeypatch):
    from sqlalchemy.exc import OperationalError

    make_user("steady", role="annotator")
    with TestClient(app) as c:
        login(c, "steady")
        assert c.get("/api/v1/auth/me").status_code == 200

        def down(*a, **k):
            raise OperationalError("SELECT", {}, Exception("server has gone away"))

        monkeypatch.setattr(auth, "resolve_session", down)
        r = c.get("/api/v1/auth/me")
        assert r.status_code == 200 and r.json()["user"]["username"] == "steady", "数据库一时连不上，刚验过的登录还认"
        c2 = TestClient(app)
        c2.cookies.set(auth.COOKIE, "never-seen-token")
        assert c2.get("/api/v1/auth/me").status_code == 500, "没验过的令牌照样拒绝（报错，不放行）"


# ---------------------------------------------------------------- 输入校验（审查 #3 #4 #5）
def test_crawl_rejects_foreign_sources_and_bad_ids(app):
    make_user("rev3", role="reviewer")
    roi = {"x": [0, 64], "y": [0, 64], "z": [0, 2]}
    with TestClient(app) as c:
        login(c, "rev3")
        assert c.get("/api/v1/crawl/volume", params={"url": "file:///etc/passwd"}).status_code == 422
        assert c.get("/api/v1/crawl/volume", params={"url": "https://169.254.169.254/latest"}).status_code == 422
        assert c.get("/api/v1/crawl/index", params={"props_url": "http://127.0.0.1:3307/"}).status_code == 422
        assert c.post("/api/v1/crawl/precheck", json={"roi": roi, "mask_url": "gs://someone-else/mask"}).status_code == 422
        r = c.post("/api/v1/crawl/jobs", json={"dataset_id": "../../etc", "url": "gs://h01-release/data/x", "roi": roi})
        assert r.status_code == 422 and "dataset_id" in r.text
        r = c.post("/api/v1/crawl/jobs", json={"dataset_id": "ok", "url": "gs://h01-release/data/x", "roi": roi, "out_dir": "/tmp/x"})
        assert r.status_code == 422, "输出目录不再由调用方指定"
        r = c.post("/api/v1/crawl/register", json={"dataset_id": "<img src=x onerror=alert(1)>", "url": "gs://h01-release/x", "roi": roi})
        assert r.status_code == 422


def test_id_checks():
    from emqc.ids import check_client, check_dataset_id, check_scanned_id

    assert check_dataset_id("h01_roi-1.v2") == "h01_roi-1.v2"
    for bad in ("", "../x", "a/b", ".hidden", "x" * 129, "a'b", "<x>"):
        with pytest.raises(ValueError):
            check_dataset_id(bad)
    assert check_scanned_id("旧数据 集 1") == "旧数据 集 1", "磁盘上已有的数据集名字宽松些，只拦危险字符"
    for bad in ("..", "a/b", "x'y", "<b>", "a\nb"):
        with pytest.raises(ValueError):
            check_scanned_id(bad)
    assert check_client(None) is None and check_client("unet-infer@gpu1") == "unet-infer@gpu1"
    with pytest.raises(ValueError):
        check_client("<script>")


def test_sampling_and_stream_inputs_are_bounded(qc_client, registered):
    client = qc_client
    r = client.post(f"/api/v1/data/{registered}/patches/sample", json={"n": -1})
    assert r.status_code == 422, "负数不再 500"
    assert client.post(f"/api/v1/data/{registered}/patches/sample", json={"n": 10 ** 9}).status_code == 422
    assert client.post(f"/api/v1/data/{registered}/patches/sample", json={"size": [0, 8, 8]}).status_code == 422
    assert client.post("/api/v1/streams", json={"dataset_id": registered, "client": "<img src=x>"}).status_code == 422


def test_templates_pass_ids_as_data_not_code():
    root = Path(__file__).resolve().parents[1] / "emqc" / "api" / "templates"
    for p in root.glob("*.html"):
        text = p.read_text()
        assert "('{{" not in text.replace("filterRows('runs','{{ k }}'", ""), f"{p.name}: 模板变量不能直接拼进内联 JS 字符串"


def test_log_lines_cannot_be_forged():
    assert logs.oneline("正常\n2026-09-25 00:00:00 ERROR 假的一条") == "正常⏎2026-09-25 00:00:00 ERROR 假的一条"
    assert "\n" not in logs.oneline("a\r\nb\x00c")
    assert logs.indented("line1\nline2") == "    | line1\n    | line2"


# ---------------------------------------------------------------- 写入顺序、撤销、磁盘满（审查 #8 #9 #10）
def _pixels(b, z=0):
    return b.seg_slice(z).copy()


def test_a_failed_record_leaves_no_pixels_behind(tmp_path, monkeypatch):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)                               # 先有一笔，工作副本和日志都在
    before = _pixels(b)
    log_before = (b.work / "edits.jsonl").read_bytes()

    def boom(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(b, "_audit_append", boom)
    with pytest.raises(ValueError, match="磁盘"):
        b.paint(0, [(4, 3)], 1, 6)
    assert np.array_equal(_pixels(b), before), "记录没写成，像素一个都不能动"
    assert (b.work / "edits.jsonl").read_bytes() == log_before, "追加的那一行被撤回"
    assert not (b.work / "edits" / "000002.npz").exists(), "像素文件也撤回"
    monkeypatch.undo()
    assert b.paint(0, [(4, 3)], 1, 6)["n"] == 2, "恢复后照常记下一笔，编号接得上"


def test_every_write_op_records_before_touching_pixels(tmp_path, monkeypatch):
    b = make_block(tmp_path)
    b.paint(0, [(2, 2)], 1, 5)
    b.paint(0, [(6, 3)], 0, 9)
    snapshots = []
    real = Block._record

    def spy(self, *a, **k):
        snapshots.append(_pixels(self))
        return real(self, *a, **k)

    monkeypatch.setattr(Block, "_record", spy)
    before = _pixels(b)
    ops = [lambda: b.fill(0, 0, 5, 3), lambda: b.merge_pair(0, (2, 2), (6, 3)), lambda: b.clear_labels(0, [3]),
           lambda: b.merge(5, 8, "block")]
    for op in ops:
        prev = _pixels(b)
        n = len(snapshots)
        assert op() is not None
        assert len(snapshots) == n + 1 and np.array_equal(snapshots[-1], prev), "记录落盘时像素还是改之前的样子"
    assert not np.array_equal(_pixels(b), before)


def test_truncated_tail_of_edit_log_is_repaired_not_fatal(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    with open(b.work / "edits.jsonl", "a") as f:
        f.write('{"n": 2, "kind": "pa')                  # 追加写到一半进程被杀
    assert [r["n"] for r in b.edits()] == [1], "半行被忽略，块照样打得开"
    assert b.paint(0, [(3, 3)], 0, 6)["n"] == 2
    lines = (b.work / "edits.jsonl").read_text().splitlines()
    assert [json.loads(x)["n"] for x in lines] == [1, 2], "追加前半行被切掉，不会留在文件中间"
    (b.work / "edits.jsonl").write_text(lines[0] + "\n{broken\n" + lines[1] + "\n")
    with pytest.raises(ValueError):
        b.edits()                                          # 中间坏了是被人改过：拒绝，不猜


def test_undo_keeps_the_edit_file_and_can_be_retried_after_a_crash(tmp_path, monkeypatch):
    b = make_block(tmp_path)
    original = _pixels(b)
    b.paint(0, [(1, 1)], 1, 5)
    b.paint(0, [(5, 3)], 1, 6)
    after_two = _pixels(b)

    real_replace = Path.replace

    def fail_log_swap(self, target):
        if self.name == "edits.jsonl.part":
            raise OSError(28, "No space left on device")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", fail_log_swap)
    with pytest.raises(ValueError, match="再点一次撤销"):
        b.undo(0)
    assert [r["n"] for r in b.edits()] == [1, 2], "日志没换成，这一笔还在"
    assert (b.work / "edits" / "000002.npz").exists(), "像素记录也还在"
    monkeypatch.undo()
    assert b.undo(0)["n"] == 2, "再撤一次就做完"
    assert not np.array_equal(_pixels(b), after_two)
    assert b.undo(0)["n"] == 1
    assert np.array_equal(_pixels(b), original), "撤到底回到原样"
    kept = sorted(p.name[:6] for p in (b.work / "edits" / "undone").iterdir())
    assert kept == ["000001", "000002"], "撤掉的改动文件挪进回收目录，不删"
    b.paint(0, [(2, 2)], 0, 7)
    assert (b.work / "edits" / "000001.npz").exists() and len(list((b.work / "edits" / "undone").iterdir())) == 2, \
        "编号复用时不会覆盖回收目录里的旧文件"


def test_undo_of_a_corrupt_edit_file_is_a_clear_error(ann_client):
    from emqc.api.routers.annotate import get_store

    client = ann_client

    r = client.post("/api/v1/annotate/blocks/b0/fill", json={"z": 0, "x": 1, "y": 1, "new_id": 777})
    assert r.status_code == 200, r.text
    n = r.json()["edit"]["n"]
    b = get_store().get("b0")
    (b.work / "edits" / f"{n:06d}.npz").write_bytes(b"not a zip")
    r = client.post("/api/v1/annotate/blocks/b0/undo?z=0")
    assert r.status_code == 422 and "损坏" in r.text, "坏文件不再是 500"


def test_low_disk_refuses_the_write_before_copying(tmp_path, monkeypatch):
    b = make_block(tmp_path)
    monkeypatch.setattr(store_mod, "disk_free", lambda p: 10 * 1024 * 1024)
    with pytest.raises(ValueError, match="磁盘空间不足"):
        b.paint(0, [(1, 1)], 0, 5)
    assert not (b.work / "seg_edit.npy").exists() and not (b.work / "seg_edit.npy.part").exists(), "工作副本都不开始复制"
    monkeypatch.undo()
    assert b.paint(0, [(1, 1)], 0, 5) is not None


def test_working_copy_is_a_real_copy_of_the_delivery(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    work, src = np.load(b.work / "seg_edit.npy"), np.load(b.path / "seg.npy")
    assert work.shape == src.shape and work.dtype == src.dtype and int(work[1, 1, 0]) == 5
    work[1, 1, 0] = 0
    assert np.array_equal(work, src), "除了这一笔，其余和交付的一模一样"
    assert int(np.load(b.path / "seg.npy")[1, 1, 0]) == 0, "交付的 seg.npy 没被动过"


# ---------------------------------------------------------------- 画笔上限与等价性（审查 #12）
def _stamp_reference(pts, radius, H, W):
    """以前的逐点盖章，拿来对照。"""
    mask = np.zeros((H, W), bool)
    yy, xx = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    disc = (xx * xx + yy * yy) <= radius * radius
    for x, y in pts:
        c0, c1 = max(0, x - radius), min(W, x + radius + 1)
        r0, r1 = max(0, y - radius), min(H, y + radius + 1)
        if c1 <= c0 or r1 <= r0:
            continue
        mask[r0:r1, c0:c1] |= disc[r0 - (y - radius):r1 - (y - radius), c0 - (x - radius):c1 - (x - radius)]
    return mask


def test_vectorised_brush_matches_the_old_stamp():
    rng = np.random.default_rng(0)
    for _ in range(60):
        H, W = int(rng.integers(5, 70)), int(rng.integers(5, 70))
        r = int(rng.integers(0, 12))
        pts = [(int(x), int(y)) for x, y in rng.integers(-15, 85, size=(int(rng.integers(1, 30)), 2))]
        assert np.array_equal(Block._stroke_mask(pts, r, H, W), _stamp_reference(pts, r, H, W)), (H, W, r, pts)


def test_paint_length_is_capped(tmp_path, ann_client):
    client = ann_client
    b = make_block(tmp_path)
    zigzag = [(0, 0), (7, 5)] * (store_mod.MAX_PAINT_STEPS // 7 + 2)
    with pytest.raises(ValueError, match="太长"):
        b.paint(0, zigzag, 1, 5)
    r = client.post("/api/v1/annotate/blocks/b0/paint", json={"z": 0, "points": [[1, 1]] * 10001, "new_id": 5})
    assert r.status_code == 422, "点数上限"
    r = client.post("/api/v1/annotate/blocks/b0/paint", json={"z": 0, "points": [[1, 1, 1]], "new_id": 5})
    assert r.status_code == 422


def test_block_merge_checks_ids(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    with pytest.raises(ValueError, match="背景"):
        b.merge(0, 5)
    with pytest.raises(ValueError):
        b.merge(5, -1)
    with pytest.raises(ValueError):
        b.merge(5, 2 ** 70)


# ---------------------------------------------------------------- 缓存失效（审查 中低风险 1、2）
def test_comparison_handle_never_serves_stale_labels(tmp_path):
    b = make_block(tmp_path)
    ro = Block(b.path, b.work.parent, read_only=True)
    assert ro.lock is b.lock
    ro.warm_labels(0, 2)
    png0 = ro.labels_png(0)
    b.paint(0, [(3, 3)], 1, 42)
    idx, ids = ro.labels(0)
    assert "42" in [str(int(i)) for i in ids], "对比页马上看到工作台刚写的"
    assert ro.labels_png(0) != png0
    from emqc.annotate.provenance import comparison_light

    assert comparison_light(ro, 0)["report"]["changed_px"] == int((b.seg_slice(0) != 0).sum())


def test_second_block_object_sees_the_other_ones_audit_log(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    twin = Block(b.path, b.work.parent)                    # 服务运行中块列表重建，同一个块有了第二个对象
    twin.paint(0, [(2, 2)], 0, 6)
    b.paint(0, [(3, 3)], 0, 7)
    seqs = [e["seq"] for e in b.audit_entries()]
    assert seqs == sorted(set(seqs)) == [1, 2, 3], "流水号不会重复（重复了这块就再也改不了）"


# ---------------------------------------------------------------- 守护脚本（审查 中低风险：部署重启卡住）
def test_supervisor_kills_a_child_that_ignores_sigterm(tmp_path):
    root = Path(__file__).resolve().parents[1]
    ready = tmp_path / "ready"
    child = (f"import signal, time, pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
             f"pathlib.Path({str(ready)!r}).write_text('1'); time.sleep(120)")
    env = dict(os.environ, EMQC_SUPERVISE_GRACE_S="1")
    p = subprocess.Popen([sys.executable, str(root / "scripts" / "supervise.py"), "--", sys.executable, "-c", child],
                         env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(100):
            if ready.exists():
                break
            time.sleep(0.1)
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=20)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 0 and "强制结束" in out, out


# ================================================================ 复查（第二轮审查）确认的问题
def _two_slice_merge_block(tmp_path):
    """z0 上先有一笔画笔 #1，z1 上一笔画笔 #2，再一笔整块合并 #3 同时覆盖 z0 和 z1。"""
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    b.paint(1, [(1, 1)], 0, 5)
    assert b.merge(5, 8, "block")["n"] == 3
    return b


def test_retry_after_failed_partial_undo_finishes_the_same_edit(tmp_path, monkeypatch):
    b = _two_slice_merge_block(tmp_path)
    real_replace = Path.replace

    def fail_log_swap(self, target):
        if self.name == "edits.jsonl.part":
            raise OSError(28, "No space left on device")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", fail_log_swap)
    with pytest.raises(ValueError, match="再点一次撤销"):
        b.undo(0)                                          # 只撤 z0 上的那部分；换日志时失败
    monkeypatch.undo()
    assert b.undo(0)["n"] == 3, "重试撤的还是整块合并 #3 在 z0 上的那部分，不会越过它去撤更早的 #1"
    assert int(b.seg_slice(0)[1, 1]) == 5 and int(b.seg_slice(1)[1, 1]) == 8, "z0 回到合并前，z1 仍是合并后"
    rec3 = next(r for r in b.edits() if r["n"] == 3)
    assert rec3["n_px"] == 1 and rec3["n_slices"] == 1, "记录裁剪成只剩 z1"
    # 失败的那一次已经回填过 z0 的像素：它也留一行流水（谁动过这一片要留痕，审核的四眼原则靠它）；重试成功再记一行
    assert [e["n"] for e in b.audit_entries() if e["action"] == "undo"] == [3, 3]
    assert b.undo(0)["n"] == 1 and int(b.seg_slice(0)[1, 1]) == 0, "再撤才轮到 #1"


def test_undo_that_committed_is_not_reported_as_failed(tmp_path, monkeypatch):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5)
    b.paint(0, [(3, 3)], 0, 6)
    real = os.replace

    def fail_retire(src, dst, *a, **k):
        if "undone" in str(dst):
            raise OSError(5, "Input/output error")
        return real(src, dst, *a, **k)

    monkeypatch.setattr(store_mod.os, "replace", fail_retire)
    assert b.undo(0)["n"] == 2, "日志已经换好就算撤销成功，收尾失败不报错"
    monkeypatch.undo()
    assert [r["n"] for r in b.edits()] == [1] and int(b.seg_slice(0)[3, 3]) == 0 and int(b.seg_slice(0)[1, 1]) == 5, \
        "#1 没被连带撤掉"
    assert [e["n"] for e in b.audit_entries() if e["action"] == "undo"] == [2], "操作流水照常记上，版本号前进"
    assert (b.work / "edits" / "000002.npz").exists(), "没挪走的旧文件还在"
    assert b.paint(0, [(4, 4)], 0, 7)["n"] == 2
    orphans = [p.name for p in (b.work / "edits" / "undone").iterdir() if "orphan" in p.name]
    assert orphans and orphans[0].startswith("000002-"), "编号复用前，没挪走的旧文件先进回收目录，不被覆盖"


def test_append_keeps_a_complete_last_record_without_newline_and_never_leaves_half_lines(tmp_path, monkeypatch):
    p = tmp_path / "x.jsonl"
    p.write_text('{"n": 1}\n{"n": 2}')                      # 手工修过：最后一条完整，只是缺换行
    assert [r["n"] for r in store_mod._parse_log(p, "测试日志")] == [1, 2]
    store_mod._append_line(p, '{"n": 3}\n')
    assert [r["n"] for r in store_mod._parse_log(p, "测试日志")] == [1, 2, 3], "读的时候算数的记录，写的时候也不删"
    before = p.read_bytes()
    monkeypatch.setattr(store_mod.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError(28, "No space left on device")))
    with pytest.raises(OSError):
        store_mod._append_line(p, '{"n": 4}\n')
    assert p.read_bytes() == before, "自己这次追加失败了，写了一半的内容截掉"


def test_torn_multibyte_tail_does_not_lock_the_block(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5, by="张三")
    audit = b.work / "audit.jsonl"
    whole = json.dumps({"seq": 2, "action": "edit", "by": "李四"}, ensure_ascii=False).encode("utf-8")
    with open(audit, "ab") as f:
        f.write(whole[:whole.index("李".encode()) + 1])        # 断在"李"字的第一个字节后面
    b2 = Block(b.path, b.work.parent)
    assert [e["seq"] for e in b2.audit_entries()] == [1], "半个汉字的残行被忽略，块照样打得开"
    assert b2.paint(0, [(2, 2)], 0, 6, by="王五")["n"] == 2
    assert [e["seq"] for e in b2.audit_entries()] == [1, 2]


def test_names_with_unicode_line_separators_do_not_split_log_lines(tmp_path):
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5, by="张 三")
    b2 = Block(b.path, b.work.parent)
    assert [e["by"] for e in b2.audit_entries()] == ["张 三"]


def test_ids_on_a_block_without_segmentation_are_a_422_not_a_500(tmp_path):
    path = tmp_path / "blocks" / "noseg"
    path.mkdir(parents=True)
    np.save(path / "em.npy", np.zeros((8, 6, 2), dtype=np.uint8))
    b = Block(path, tmp_path / "work")
    for op in (lambda: b.merge(1, 2), lambda: b.fill(0, 1, 1, 3), lambda: b.paint(0, [(1, 1)], 1, 3)):
        with pytest.raises(ValueError, match="seg"):
            op()


def test_slice_filter_reads_only_the_section_array(tmp_path, monkeypatch):
    b = _two_slice_merge_block(tmp_path)
    seen = []
    real = Block._load_edit

    def spy(self, n, keys=None):
        seen.append(keys)
        return real(self, n, keys)

    monkeypatch.setattr(Block, "_load_edit", spy)
    assert [r["n"] for r in b.edits(0)] == [1, 3]
    assert seen == [("zs",)], "列本片改动只解压 zs"


def test_small_cutouts_are_not_queued_behind_big_ones(qc_client, registered):
    from emqc.api.routers import data

    assert data._cutout_slots.acquire(timeout=1) and data._cutout_slots.acquire(timeout=1)   # 两个大块下载正在进行
    try:
        r = qc_client.get(f"/api/v1/data/{registered}/cutout", params={"z0": 0, "z1": 2, "y0": 0, "y1": 16, "x0": 0, "x1": 16})
        assert r.status_code == 200, "训练取的小块不排队"
    finally:
        data._cutout_slots.release(); data._cutout_slots.release()


def test_health_reads_disk_without_warning_or_alerting(qc_client, monkeypatch):
    from emqc.config import settings

    alerts = []
    monkeypatch.setattr(logs, "alert", lambda *a, **k: alerts.append(a))
    monkeypatch.setattr(settings, "disk_alert_gb", 10 ** 9)
    h = qc_client.get("/api/v1/health").json()
    assert h["disk_ok"] is False and h["status"] == "degraded"
    assert alerts == [], "探活只看不报，告警交给每分钟一次的监控线程"


def test_crawl_source_forms_and_cli_local_properties(tmp_path):
    from emqc.crawl.index import load_properties
    from emqc.registry.cloud import check_source

    assert check_source("precomputed://https://storage.googleapis.com/h01-release/data/x")
    f = tmp_path / "info"
    f.write_text(json.dumps({"inline": {"ids": ["1"], "properties": []}}))
    assert load_properties(f.as_uri(), allow_local=True)["inline"]["ids"] == ["1"], "命令行可以读本地文件"
    with pytest.raises(ValueError):
        load_properties(f.as_uri())                       # 接口调用不行


def test_restart_marks_queued_export_and_crawl_jobs_interrupted(registered):
    from emqc.db import session_scope
    from emqc.db.base import recover_stale_runs
    from emqc.db.models import CrawlJob, ExportJob

    with session_scope() as s:
        e = ExportJob(dataset_id=registered, status="queued"); c = CrawlJob(dataset_id="x", url="gs://h01-release/x", status="running")
        s.add_all([e, c]); s.flush(); ids = (e.id, c.id)
    assert recover_stale_runs() >= 2
    with session_scope() as s:
        assert s.get(ExportJob, ids[0]).status == "error" and s.get(CrawlJob, ids[1]).status == "error", \
            "排队 / 在跑的导出和爬取进程一退就永远不会再跑，要标出来"


def test_loader_retries_when_the_server_is_busy(monkeypatch):
    import urllib.error

    from emqc import loader

    calls = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, *a):
            return b"ok"

    def urlopen(req, timeout=0):
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "busy", {}, None)
        return Resp()

    monkeypatch.setattr(loader.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(loader, "RETRY_WAITS", (0,))
    assert loader._get("http://x/y", None) == b"ok" and len(calls) == 2


def test_backup_quotes_the_password_and_recopies_blocks_changed_mid_copy(tmp_path, monkeypatch):
    import importlib.util

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("emqc_backup", root / "scripts" / "backup.py")
    backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)
    assert backup._cnf('a#b\\c"d') == '"a#b\\\\c\\"d"', "# 和反斜杠在选项文件里要加引号转义"

    work = tmp_path / "work"
    b = make_block(tmp_path)                               # 工作目录在 tmp_path/work/who
    b.paint(0, [(1, 1)], 0, 5)
    real = backup._rsync
    state = {"n": 0}

    def racing_rsync(src, dest, link, only_pixels):
        rc = real(src, dest, link, only_pixels)
        state["n"] += 1
        if state["n"] == 1:                                # 第一遍拷完像素，有人正好撤销了一笔
            b.undo(0)
        return rc

    monkeypatch.setattr(backup, "_rsync", racing_rsync)
    dest = tmp_path / "bk" / "annotate"
    dest.parent.mkdir()                                    # 和 backup() 一样先建好这次备份的目录（GNU rsync 不会替你建两层）
    assert backup._copy_workdir(work, str(dest), None, tmp_path / "backup.log") == 1
    got = np.load(dest / "who" / "seg_edit.npy")
    assert int(got[1, 1, 0]) == 0 and (dest / "who" / "edits.jsonl").read_text() == "", \
        "撤销前的像素 + 撤销后的日志不会一起留在备份里：这个块被重拷成撤销后的一致状态"


def test_supervisor_stops_cleanly_while_waiting_to_retry_a_failed_launch(tmp_path):
    root = Path(__file__).resolve().parents[1]
    p = subprocess.Popen([sys.executable, str(root / "scripts" / "supervise.py"), "--", str(tmp_path / "no-such-binary")],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        seen = []
        deadline = time.time() + 30                    # 机器忙时守护脚本起得慢：等它真的进入重试等待再发信号
        while time.time() < deadline:
            line = p.stdout.readline()
            seen.append(line)
            if "启动服务失败" in line or not line:
                break
        p.send_signal(signal.SIGTERM)
        rest, _ = p.communicate(timeout=10)
        out = "".join(seen) + rest
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 0 and "启动服务失败" in out, "等下一次重试的时候也能被停掉，不会一直卡 60 秒"


def test_undo_failing_before_pixels_leaves_no_audit_line(tmp_path, monkeypatch):
    """撤销在动像素之前失败（写剩余部分的 .part 时磁盘满）：先记的那行流水收回，流水和像素都像没发生过。"""
    b = _two_slice_merge_block(tmp_path)
    seq = b.audit_entries()[-1]["seq"]
    real_open = Path.open

    def fail_part(self, *a, **k):
        if self.name.endswith(".npz.part"):
            raise OSError(28, "No space left on device")
        return real_open(self, *a, **k)

    monkeypatch.setattr(Path, "open", fail_part)
    with pytest.raises(ValueError, match="再点一次撤销"):
        b.undo(0)
    monkeypatch.undo()
    assert b.audit_entries()[-1]["seq"] == seq, "流水原样"
    assert b.undo(0)["n"] == 3
