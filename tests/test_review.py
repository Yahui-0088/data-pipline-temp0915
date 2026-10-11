"""标注审核：标记完成 → 审核员通过 / 退回修改 / 撤销通过；四眼原则；内容哈希钉住；并发；标记证据；入库版本。"""
import hashlib
import json
import os
import shutil

import numpy as np
import pytest
from fastapi.testclient import TestClient

from test_auth import PW, auth_on, detail, login, make_user  # noqa: F401  (auth_on 是 fixture)
from test_who import make_block

URL = "/api/v1/annotate/blocks/who"
BATCH = "/api/v1/annotate/review/batches/blocks"         # make_block 把块放在 <tmp>/blocks/who：导入目录 blocks 就是批次


@pytest.fixture
def env(auth_on, tmp_path, monkeypatch):
    from emqc.api.app import app
    from emqc.api.routers import annotate, review
    from emqc.config import settings
    from emqc.db import session_scope
    from emqc.db.models import AnnotRelease, Mark, MarkComment, ReviewEvent, ReviewEventMark, SliceReview
    from sqlalchemy import delete

    with session_scope() as s:
        for t in (ReviewEventMark, ReviewEvent, SliceReview, AnnotRelease, MarkComment, Mark):
            s.execute(delete(t))
    b = make_block(tmp_path)
    monkeypatch.setattr(settings, "annotate_workdir", tmp_path / "work")
    monkeypatch.setattr(annotate, "_block", lambda *_a, **_k: b)
    monkeypatch.setattr(review, "_blocks", lambda _s: [{"block_id": "who", "has_seg": True, "path": str(b.path), "batch_id": "blocks"}])
    annotate._presence.clear()
    make_user("anna", "annotator", "安娜")
    make_user("bob", "annotator", "鲍勃")
    make_user("rita", "reviewer", "丽塔")
    make_user("rex", "reviewer", "雷克斯")
    make_user("adam", "admin", "亚当")
    clients = {}

    def as_(name):
        if name not in clients:
            c = TestClient(app)
            c.__enter__()
            assert login(c, name).status_code == 200
            clients[name] = c
        return clients[name]

    yield as_, b
    for c in clients.values():
        c.__exit__(None, None, None)


def paint(c, z, x, label):
    r = c.post(URL + "/paint", json={"z": z, "points": [[x, 1]], "radius": 0, "new_id": label})
    assert r.status_code == 200, r.text
    return r.json()


def state(c, z):
    r = c.get(f"{URL}/review/{z}")
    assert r.status_code == 200, r.text
    return r.json()


def act(c, z, action, st=None, **extra):
    st = st or state(c, z)
    body = {"action": action, "expect_version": st["version"], **extra}
    if action in ("approve", "request_changes", "revoke"):
        body.setdefault("expect_sha", st["sha"])
    return c.post(f"{URL}/review/{z}", json=body)


def complete(c, lo, hi=None, action="complete"):
    r = c.post(URL + "/review-range", json={"action": action, "z_from": lo, "z_to": lo if hi is None else hi})
    assert r.status_code == 200, r.text
    return r.json()


def test_complete_approve_and_history(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    assert state(rita, 0)["status"] == "not_started"
    paint(anna, 0, 1, 7)
    assert state(rita, 0)["status"] == "in_progress"
    assert complete(anna, 0, 2)["done"] == [0, 1, 2], "没动过的片也能标记完成（整片都要审）"
    st = state(rita, 0)
    assert st["status"] == "pending" and st["in_queue"] and st["can"]["approve"], st["why_not"]
    assert st["completed_by"] == "安娜"
    r = act(rita, 0, "approve", st, comment="边界都对")
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["status"] == "approved" and st["decided_by"] == "丽塔" and st["version"] == 2
    ev = st["events"][0]
    assert ev["action"] == "approve" and ev["by"] == "丽塔" and ev["role"] == "reviewer" and ev["sha"] == st["sha"]
    assert [e["action"] for e in st["events"]] == ["approve", "complete"]
    # 同一个动作再点一次：状态不允许（不是悄悄再记一条）
    r = act(rita, 0, "approve")
    assert r.status_code == 409 and detail(r)["code"] == "state"


def test_sha_matches_blockledger_slice_hash_and_compare_page(env):
    as_, b = env
    anna = as_("anna")
    paint(anna, 1, 2, 9)
    st = state(anna, 1)
    vol = np.load(b.work / "seg_edit.npy")
    assert st["sha"] == hashlib.sha256(vol[:, :, 1].astype("<u8").tobytes(order="F")).hexdigest(), "与 blockledger 的切片哈希同一个数"
    cmp = anna.get(f"{URL}/compare/1").json()
    assert cmp["review_sha"] == st["sha"] and cmp["slice_rev"] == st["rev"], "对比页给出的哈希就是审核要带回的那个"


def test_four_eyes_edit_and_force_undo(env):
    as_, b = env
    anna, rita, rex = as_("anna"), as_("rita"), as_("rex")
    paint(rita, 1, 3, 5)                        # 审核员自己也动手改了第 1 片
    complete(anna, 1)
    st = state(rita, 1)
    assert not st["can"]["approve"] and "四眼" in st["why_not"]["approve"]
    r = act(rita, 1, "approve", st)
    assert r.status_code == 403 and detail(r)["code"] == "four_eyes"
    assert act(rex, 1, "approve").status_code == 200, "没参与过的审核员可以通过"
    # 撤销别人的改动也算参与：rita 强制撤掉 anna 在第 2 片上的改动，然后不能自己通过
    paint(anna, 2, 1, 6)
    r = rita.post(URL + "/undo?z=2", json={"force": True})
    assert r.status_code == 200, r.text
    complete(anna, 2)
    st = state(rita, 2)
    assert not st["can"]["approve"] and "四眼" in st["why_not"]["approve"]
    assert state(rex, 2)["can"]["approve"]


def test_stale_content_is_refused_even_when_the_revision_did_not_move(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    seen = state(rita, 0)
    paint(anna, 0, 2, 8)                        # 审核员看过之后标注员又改了
    r = act(rita, 0, "approve", seen)
    assert r.status_code == 409 and detail(r)["code"] == "stale"
    # 版本号没动、像素却变了（例如撤销后流水没记上）：照样拦住
    seen = state(rita, 0)
    with b.lock:
        b._seg_writable()[3, 1, 0] = 99         # 绕过记录直接改像素
        b._invalidate(0)
    assert b.slice_rev(0) == seen["rev"]
    r = act(rita, 0, "approve", seen)
    assert r.status_code == 409 and detail(r)["code"] == "stale"
    assert act(rita, 0, "approve").status_code == 200, "看过最新内容后可以通过"


def test_block_wide_op_that_leaves_a_slice_unchanged_keeps_its_approval(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    paint(anna, 1, 1, 9)
    complete(anna, 0, 1)
    assert act(rita, 1, "approve").status_code == 200
    rev_before = state(rita, 1)["rev"]
    b.merge(7, 70, scope="block", by="安娜")    # 只动了第 0 片的像素，但每一片的版本号都前进了
    st = state(rita, 1)
    assert st["rev"] > rev_before and st["status"] == "approved", "内容没变，通过仍然有效"
    rows = rita.get(URL + "/review").json()["slices"]
    assert rows[1]["status"] == "approved"


def test_changed_after_approval_returns_to_queue(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    assert act(rita, 0, "approve").status_code == 200
    paint(anna, 0, 2, 7)
    st = state(rita, 0)
    assert st["status"] == "changed" and st["in_queue"] and st["since_decision"]["n"] == 1
    assert act(rita, 0, "approve").status_code == 200
    assert state(rita, 0)["status"] == "approved"


def test_request_changes_fix_and_resubmit(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    r = act(rita, 0, "request_changes")
    assert r.status_code == 422 and detail(r)["code"] == "comment", "退回要写原因"
    r = act(rita, 0, "request_changes", comment="左下角漏标了一块")
    assert r.status_code == 200 and r.json()["status"] == "returned"
    rows = anna.get(URL + "/review").json()["slices"]
    assert rows[0]["todo"] and rows[0]["last_comment"] == "左下角漏标了一块", "退回的片出现在标注员的待办里"
    assert not act(rita, 0, "approve").json().get("status") == "approved"
    paint(anna, 0, 3, 7)
    assert state(anna, 0)["status"] == "fixed"
    assert complete(anna, 0)["done"] == [0]
    assert state(rita, 0)["status"] == "pending"


def test_revoke_needs_a_reason_and_requeues(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    complete(anna, 2)
    assert act(rita, 2, "approve").status_code == 200
    r = act(rita, 2, "revoke")
    assert r.status_code == 422
    r = act(rita, 2, "revoke", comment="看错了片")
    assert r.status_code == 200 and r.json()["status"] == "pending"


def test_concurrent_reviewers_do_not_overwrite(env):
    as_, b = env
    anna, rita, rex = as_("anna"), as_("rita"), as_("rex")
    complete(anna, 1)
    seen = state(rita, 1)
    assert act(rex, 1, "request_changes", seen, comment="不行").status_code == 200
    r = act(rita, 1, "approve", seen)
    assert r.status_code == 409 and detail(r)["code"] == "conflict"


def test_permissions(env, monkeypatch):
    as_, b = env
    anna, rita, adam, bob = as_("anna"), as_("rita"), as_("adam"), as_("bob")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    r = act(bob, 0, "approve")
    assert r.status_code == 403 and detail(r)["code"] == "role", "标注员不能下结论"
    assert not state(bob, 0)["can"]["approve"]
    r = bob.post(URL + "/review-range", json={"action": "uncomplete", "z_from": 0, "z_to": 0})
    assert r.json()["done"] == [] and "撤回" in r.json()["skipped"][0]["reason"], "别人标的完成，只有本人或审核员能撤回"
    # 试用模式下审核结论无法确认是本人：拒绝
    from emqc import auth
    from emqc.db import session_scope

    with session_scope() as s:
        auth.set_login_mode(s, "open", None)
    r = act(rita, 0, "approve")
    assert r.status_code == 409 and detail(r)["code"] == "open_mode"
    with session_scope() as s:
        auth.set_login_mode(s, "password", None)
    assert act(adam, 0, "approve").status_code == 200, "管理员也能审"


def test_review_is_off_without_login(monkeypatch, tmp_path):
    from emqc.api.app import app
    from emqc.api.routers import annotate
    from emqc.config import settings

    monkeypatch.setattr(settings, "auth_disabled", True)
    b = make_block(tmp_path)
    monkeypatch.setattr(annotate, "_block", lambda *_a, **_k: b)
    with TestClient(app) as c:
        st = c.get(URL + "/review/0").json()
        assert not any(st["can"].values())
        r = c.post(URL + "/review/0", json={"action": "complete", "expect_version": 0})
        assert r.status_code == 409 and detail(r)["code"] == "disabled"


def test_marks_cited_by_a_decision_are_kept_as_evidence(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    m = rita.post(URL + "/marks", json={"z": 0, "x": 2, "y": 2, "text": "这里断开了"}).json()
    r = act(rita, 0, "approve")
    assert r.status_code == 409 and detail(r)["what"] == ["open_marks"], "还有未解决的标记，通过前要确认"
    r = act(rita, 0, "request_changes")                      # 有标记就不必再写一遍原因
    assert r.status_code == 200 and r.json()["events"][0]["marks"][0]["text"] == "这里断开了"
    assert rita.delete(f"/api/v1/annotate/marks/{m['id']}").status_code == 409
    assert rita.patch(f"/api/v1/annotate/marks/{m['id']}", json={"text": "改口"}).status_code == 409
    assert anna.patch(f"/api/v1/annotate/marks/{m['id']}", json={"status": "resolved"}).status_code == 200, "可以标为已解决"


def test_unattributed_edits_need_confirmation(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    b.paint(1, [(1, 1)], 0, 4, by=None)               # 旧数据：没署名的改动
    complete(anna, 1)
    st = state(rita, 1)
    assert st["unattributed"] == 1
    r = act(rita, 1, "approve", st)
    assert r.status_code == 409 and detail(r)["what"] == ["unattributed"]
    assert act(rita, 1, "approve", st, confirm=["unattributed"]).status_code == 200


def test_progress_and_next(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    complete(anna, 0, 1)
    data = rita.get(URL + "/review").json()
    assert data["counts"]["pending"] == 2 and data["counts"]["not_started"] == 1
    assert [r["reviewable"] for r in data["slices"]] == [True, True, False]
    assert data["slices"][0]["editors"] == {"安娜": 1}
    assert data["slices"][0]["last_edit"][-6] in "+-", "编辑时间带时区，和库里的 UTC 时间能放在一起比较"
    nxt = rita.get("/api/v1/annotate/review/next", params={"block": "who", "z": 0}).json()["next"]
    assert nxt == {"block_id": "who", "z": 1, "batch_id": "blocks"}
    nxt = rita.get("/api/v1/annotate/review/next", params={"block": "who", "z": 1}).json()["next"]
    assert nxt == {"block_id": "who", "z": 0, "batch_id": "blocks"}, "到头绕回来"
    assert anna.get("/api/v1/annotate/review/next", params={"block": "who", "z": 0}).json()["next"] is None
    summary = rita.get("/api/v1/annotate/review/summary").json()
    assert summary["blocks"][0]["reviewable"] == 2 and summary["me"]["can_decide"]
    assert [(g["batch_id"], g["blocks"], g["reviewable"], g["nz"]) for g in summary["batches"]] == [("blocks", ["who"], 2, 3)]


def test_release(env, tmp_path):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    paint(anna, 2, 3, 8)
    complete(anna, 0, 2)
    for z in (0, 2):
        assert act(rita, z, "approve").status_code == 200
    paint(anna, 2, 4, 8)                                      # 通过后又改了第 2 片：这次不收
    pv = rita.get(BATCH + "/releases/preview").json()
    blk = pv["blocks"][0]
    assert blk["included"] == [0] and blk["excluded"][0]["z"] == 2 and blk["excluded"][0]["reason"] == "changed"
    assert pv["expect_included"] == {"who": [0]} and pv["n_slices"] == 1
    r = anna.post(BATCH + "/releases", json={"expect_included": {"who": [0]}})
    assert r.status_code == 403, "标注员不能入库"
    r = rita.post(BATCH + "/releases", json={"expect_included": {"who": [0, 2]}})
    assert r.status_code == 409 and detail(r)["code"] == "stale", "和预览不一致就拒绝"
    r = rita.post(BATCH + "/releases", json={"expect_included": {"who": [0]}, "note": "第一批"})
    assert r.status_code == 200, r.text
    rel = r.json()
    assert rel["version"] == 1 and rel["blocks"][0]["z_list"] == [0] and rel["path"] == "_releases/blocks/v1"
    d = tmp_path / "work" / rel["path"] / "who"
    seg = np.load(d / "seg.npy")
    src = np.load(b.work / "seg_edit.npy")
    assert seg.shape == src.shape and seg.dtype == src.dtype, "与原始 seg.npy 同形状同类型同轴序"
    assert np.array_equal(seg[:, :, 0], src[:, :, 0]) and not seg[:, :, 1:].any()
    assert np.load(d / "reviewed_z.npy").tolist() == [True, False, False]
    top = d.parent
    manifest = json.loads((top / "manifest.json").read_text())
    assert manifest["batch_id"] == "blocks" and manifest["approval_scope"] == "whole_slice"
    mb = manifest["blocks"][0]
    assert mb["block_id"] == "who" and mb["slices"][0]["approved_by"]["name"] == "丽塔"
    assert mb["slices"][0]["contributors"][0]["by"] == "安娜"
    for line in (top / "checksums.sha256").read_text().splitlines():
        digest, name = line.split("  ")
        assert hashlib.sha256((top / name).read_bytes()).hexdigest() == digest
    assert not os.access(d / "seg.npy", os.W_OK), "版本文件只读"
    assert rel["manifest_sha256"] == hashlib.sha256((top / "manifest.json").read_bytes()).hexdigest()
    assert act(rita, 2, "approve").status_code == 200
    r = rita.post(BATCH + "/releases", json={"expect_included": {"who": [0, 2]}})
    assert r.status_code == 200 and r.json()["version"] == 2
    assert [x["version"] for x in rita.get(BATCH + "/releases").json()["releases"]] == [2, 1]
    assert not any(p.name.startswith(".tmp") for p in (tmp_path / "work" / "_releases" / "blocks").iterdir())


def test_writes_from_another_origin_are_refused(env):
    as_, b = env
    anna = as_("anna")
    r = anna.post(URL + "/review-range", json={"action": "complete", "z_from": 0, "z_to": 0},
                  headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and detail(r)["code"] == "origin"
    r = anna.post(URL + "/review-range", json={"action": "complete", "z_from": 0, "z_to": 0},
                  headers={"Origin": "http://testserver"})
    assert r.status_code == 200


def test_each_confirmation_must_be_given(env):
    """未解决标记和没署名的改动要分别确认：确认了一项不能顺带跳过另一项。"""
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    b.paint(0, [(1, 1)], 0, 4, by=None)
    complete(anna, 0)
    rita.post(URL + "/marks", json={"z": 0, "x": 2, "y": 2, "text": "看一下"})
    r = act(rita, 0, "approve")
    assert r.status_code == 409 and sorted(detail(r)["what"]) == ["open_marks", "unattributed"], "一次说清两件事"
    r = act(rita, 0, "approve", confirm=["open_marks"])
    assert r.status_code == 409 and detail(r)["what"] == ["unattributed"]
    assert act(rita, 0, "approve", confirm=["open_marks", "unattributed"]).status_code == 200


def test_release_is_void_if_a_decision_changes_while_writing(env, monkeypatch):
    """入库写文件的途中有人退回了某一片：这次入库作废（409），不留下任何版本目录。"""
    from emqc.annotate import review as rv

    as_, b = env
    anna, rita, rex = as_("anna"), as_("rita"), as_("rex")
    paint(anna, 0, 1, 7)
    complete(anna, 0)
    assert act(rita, 0, "approve").status_code == 200
    real = rv._write

    def write_and_meanwhile_reject(path, data):
        real(path, data)
        if path.name == "manifest.json":
            assert act(rex, 0, "request_changes", comment="不对").status_code == 200
    monkeypatch.setattr(rv, "_write", write_and_meanwhile_reject)
    r = rita.post(BATCH + "/releases", json={"expect_included": {"who": [0]}})
    assert r.status_code == 409 and detail(r)["code"] == "stale"
    root = b.work.parent / "_releases" / "blocks"
    assert not [p for p in root.iterdir()], "什么都不留：没有版本目录，也没有临时目录"
    assert rita.get(BATCH + "/releases").json()["releases"] == []


def test_release_version_never_reuses_a_recorded_number(env):
    """旧版本目录被人删了腾空间：下一个版本号仍然接着库里的最大号，不会造出一个和记录对不上的同号版本。"""
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    complete(anna, 0)
    assert act(rita, 0, "approve").status_code == 200
    assert rita.post(BATCH + "/releases", json={"expect_included": {"who": [0]}}).json()["version"] == 1
    v1 = b.work.parent / "_releases" / "blocks" / "v1"
    shutil.rmtree(v1)
    r = rita.post(BATCH + "/releases", json={"expect_included": {"who": [0]}})
    assert r.status_code == 200 and r.json()["version"] == 2


def test_a_damaged_block_does_not_take_the_progress_page_down(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    paint(anna, 1, 1, 8)
    p = b.work / "audit.jsonl"
    lines = p.read_text().splitlines()
    p.write_text("\n".join([lines[0], "{坏了", *lines[1:]]) + "\n")      # 中间一行坏了：存储层拒绝读取
    r = rita.get("/api/v1/annotate/review/summary")
    assert r.status_code == 200 and "error" in r.json()["blocks"][0]
    assert rita.get("/api/v1/annotate/review/next").status_code == 200


def test_release_preview_is_for_reviewers(env):
    as_, b = env
    anna = as_("anna")
    assert anna.get(BATCH + "/releases/preview").status_code == 403


def test_origin_null_is_refused(env):
    as_, b = env
    anna = as_("anna")
    r = anna.post(URL + "/review-range", json={"action": "complete", "z_from": 0, "z_to": 0}, headers={"Origin": "null"})
    assert r.status_code == 403


def test_undo_is_refused_if_its_audit_line_cannot_be_written(tmp_path, monkeypatch):
    """撤销先记流水再动像素：流水写不进去（磁盘满）就整个不做，不会出现「像素回退了、谁撤的没留下」。"""
    b = make_block(tmp_path)
    b.paint(0, [(1, 1)], 0, 5, by="安娜")
    before, rev = b.seg_slice(0).copy(), b.slice_rev(0)

    def boom(*a, **k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(b, "_audit_append", boom)
    with pytest.raises(ValueError, match="磁盘"):
        b.undo(z=0, by="丽塔", force=True)
    assert np.array_equal(b.seg_slice(0), before) and len(b.edits(0)) == 1 and b.slice_rev(0) == rev
    monkeypatch.undo()
    assert b.undo(z=0, by="丽塔", force=True) is not None


def test_author_of_an_undone_3d_edit_still_counts_as_contributor(env):
    """整块合并（3-D 改动）被别人在这一片撤掉了：合并的人仍然算动过这一片，不能自己通过它。"""
    from emqc.annotate.store import Actor
    from emqc.db import session_scope
    from emqc.db.models import User

    as_, b = env
    anna, rita, rex = as_("anna"), as_("rita"), as_("rex")
    with session_scope() as s:
        rita_id = s.query(User).filter_by(username="rita").one().id
    paint(anna, 1, 1, 7)
    b.merge(7, 70, scope="block", by=Actor("丽塔", "rita", rita_id))      # rita 的 3-D 改动
    entry = b.audit_entries()[-1]
    assert entry["z"] is None and entry["zs"] == [1], "3-D 改动在流水里记下落到的切片"
    r = rex.post(URL + "/undo?z=1", json={"force": True})                  # rex 把它在第 1 片撤掉了
    assert r.status_code == 200, r.text
    assert not [e for e in b.edits(1) if e.get("by_id") == rita_id], "rita 在第 1 片已经没有有效改动"
    complete(anna, 1)
    st = state(rita, 1)
    assert "丽塔" in [p["by"] for p in st["contributors"]]
    r = act(rita, 1, "approve", st)
    assert r.status_code == 403 and detail(r)["code"] == "four_eyes"


def test_unreadable_pixel_record_blocks_review_with_a_reason(env):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    b.merge(7, 70, scope="block", by="安娜")
    n = b.edits()[-1]["n"]
    (b.work / "edits" / f"{n:06d}.npz").unlink()                       # 3-D 改动的像素记录丢了
    complete(anna, 0)
    st = state(rita, 0)
    assert st.get("history_error") and not any(st["can"].values()) and "联系管理员" in st["why_not"]["approve"]
    r = act(rita, 0, "approve", st | {"sha": "0" * 64})
    assert r.status_code == 409 and detail(r)["code"] == "history"
    rows = rita.get(URL + "/review").json()["slices"]
    assert not rows[0]["reviewable"] and rows[0]["history_error"]


def test_switching_to_password_mode_ends_passwordless_sessions(env):
    """试用模式里填名字建的号（没有密码）谁都能冒用：切到密码登录后，它们的旧会话不能再用。"""
    from emqc import auth
    from emqc.api.app import app
    from emqc.db import session_scope

    with session_scope() as s:
        auth.set_login_mode(s, "open", None)
    c = TestClient(app)
    c.__enter__()
    try:
        assert c.post("/api/v1/auth/login", json={"username": "试用某人"}).status_code == 200
        assert c.get(URL + "/review").status_code == 200
        with session_scope() as s:
            auth.set_login_mode(s, "password", None)
        assert c.get(URL + "/review").status_code == 401
    finally:
        c.__exit__(None, None, None)


# ------------------------------------------------------------------ 按批次（导入目录）汇总与入库
def _put_block(root, *parts):
    d = root.joinpath(*parts)
    d.mkdir(parents=True)
    np.save(d / "em.npy", np.zeros((8, 6, 3), dtype=np.uint8))
    np.save(d / "seg.npy", np.zeros((8, 6, 3), dtype=np.uint64))
    return d


@pytest.fixture
def batches(auth_on, tmp_path, monkeypatch):
    """真实的块发现：<tmp>/imports/b1/{qa,qb,qd} 和 <tmp>/imports/b2/qc —— 两个导入目录 = 两个批次。"""
    from emqc.api.app import app
    from emqc.api.routers import annotate
    from emqc.config import settings
    from emqc.db import session_scope
    from emqc.db.models import AnnotRelease, Mark, MarkComment, ReviewEvent, ReviewEventMark, SliceReview
    from sqlalchemy import delete

    with session_scope() as s:
        for t in (ReviewEventMark, ReviewEvent, SliceReview, AnnotRelease, MarkComment, Mark):
            s.execute(delete(t))
    root = tmp_path / "imports"
    for parts in (("b1", "qa"), ("b1", "qb"), ("b1", "qd"), ("b2", "qc")):
        _put_block(root, *parts)
    monkeypatch.setattr(settings, "annotate_root", root)
    monkeypatch.setattr(settings, "annotate_extra_roots", "")
    monkeypatch.setattr(settings, "sam_blocks_dir", None)
    monkeypatch.setattr(settings, "annotate_workdir", tmp_path / "work")
    annotate.reset_store()
    annotate._presence.clear()
    make_user("anna", "annotator", "安娜")
    make_user("rita", "reviewer", "丽塔")
    clients = []

    def as_(name):
        c = TestClient(app)
        c.__enter__()
        assert login(c, name).status_code == 200
        clients.append(c)
        return c

    yield as_, root
    for c in clients:
        c.__exit__(None, None, None)
    annotate.reset_store()


def _blk(bid):
    return f"/api/v1/annotate/blocks/{bid}"


def _approve(anna, rita, bid, *zs):
    for z in zs:
        r = anna.post(_blk(bid) + "/paint", json={"z": z, "points": [[1, 1]], "radius": 0, "new_id": 10 + z})
        assert r.status_code == 200, r.text
    r = anna.post(_blk(bid) + "/review-range", json={"action": "complete", "z_from": min(zs), "z_to": max(zs)})
    assert r.status_code == 200, r.text
    for z in zs:
        st = rita.get(f"{_blk(bid)}/review/{z}").json()
        r = rita.post(f"{_blk(bid)}/review/{z}", json={"action": "approve", "expect_version": st["version"], "expect_sha": st["sha"]})
        assert r.status_code == 200, r.text


def test_progress_is_grouped_by_import_directory(batches):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    _approve(anna, rita, "qa", 0)
    sm = rita.get("/api/v1/annotate/review/summary").json()
    assert [(g["batch_id"], g["blocks"], g["nz"]) for g in sm["batches"]] == [("b1", ["qa", "qb", "qd"], 9), ("b2", ["qc"], 3)]
    assert sm["batches"][0]["counts"]["approved"] == 1 and sm["batches"][1]["counts"]["not_started"] == 3
    assert [b["batch_id"] for b in sm["blocks"]] == ["b1", "b1", "b1", "b2"], "数据块按（批次, 块）排序"
    assert rita.get(_blk("qa") + "/review").json()["batch_id"] == "b1"
    assert sm["duplicates"] == [] and sm["batches"][0]["ambiguous_dirs"] == []


def test_release_is_per_batch_with_one_directory_per_block(batches, tmp_path):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    _approve(anna, rita, "qa", 0)
    _approve(anna, rita, "qb", 1, 2)
    _approve(anna, rita, "qc", 0)                          # 另一批：不进 b1 的版本
    pv = rita.get("/api/v1/annotate/review/batches/b1/releases/preview").json()
    assert pv["expect_included"] == {"qa": [0], "qb": [1, 2]} and pv["n_blocks"] == 2 and pv["n_slices"] == 3
    assert [(x["block_id"], x["reason"]) for x in pv["skipped"]] == [("qd", "none_approved")], "没有通过的块列出来、不收"
    r = rita.post("/api/v1/annotate/review/batches/b1/releases", json={"expect_included": pv["expect_included"], "note": "第一次交付"})
    assert r.status_code == 200, r.text
    rel = r.json()
    assert (rel["version"], rel["n_blocks"], rel["n_slices"]) == (1, 2, 3)
    top = tmp_path / "work" / rel["path"]
    assert sorted(p.name for p in top.iterdir()) == ["checksums.sha256", "manifest.json", "qa", "qb"]
    for bid, zs in (("qa", [0]), ("qb", [1, 2])):
        seg = np.load(top / bid / "seg.npy")
        assert seg.shape == (8, 6, 3) and seg.dtype == np.uint64
        keep = np.load(top / bid / "reviewed_z.npy")
        assert np.flatnonzero(keep).tolist() == zs
        assert all(seg[1, 1, z] == 10 + z for z in zs) and not seg[:, :, ~keep].any(), "没收的片全是 0"
    m = json.loads((top / "manifest.json").read_text())
    assert m["kind"] == "annotation_batch_release" and m["batch_id"] == "b1" and m["n_slices"] == 3
    assert [b["block_id"] for b in m["blocks"]] == ["qa", "qb"] and m["skipped_blocks"][0]["block_id"] == "qd"
    names = [line.split("  ")[1] for line in (top / "checksums.sha256").read_text().splitlines()]
    assert names == ["qa/seg.npy", "qa/reviewed_z.npy", "qb/seg.npy", "qb/reviewed_z.npy", "manifest.json"]
    for line in (top / "checksums.sha256").read_text().splitlines():
        digest, name = line.split("  ")
        assert hashlib.sha256((top / name).read_bytes()).hexdigest() == digest
    assert not os.access(top / "qb" / "seg.npy", os.W_OK)
    hist = rita.get("/api/v1/annotate/review/batches/b1/releases").json()["releases"]
    assert [(h["version"], h["n_blocks"], [b["block_id"] for b in h["blocks"]]) for h in hist] == [(1, 2, ["qa", "qb"])]
    r = rita.post("/api/v1/annotate/review/batches/b2/releases", json={"expect_included": {"qc": [0]}})
    assert r.status_code == 200 and r.json()["version"] == 1 and r.json()["path"] == "_releases/b2/v1", "每批各自编号"
    sm = rita.get("/api/v1/annotate/review/summary").json()
    assert [g["latest_release"]["version"] for g in sm["batches"]] == [1, 1]


def test_batch_release_is_refused_if_any_block_changed_since_preview(batches, tmp_path):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    _approve(anna, rita, "qa", 0)
    _approve(anna, rita, "qb", 1)
    pv = rita.get("/api/v1/annotate/review/batches/b1/releases/preview").json()
    r = anna.post(_blk("qb") + "/paint", json={"z": 1, "points": [[2, 2]], "radius": 0, "new_id": 99})
    assert r.status_code == 200
    r = rita.post("/api/v1/annotate/review/batches/b1/releases", json={"expect_included": pv["expect_included"]})
    assert r.status_code == 409 and detail(r)["code"] == "stale"
    assert not (tmp_path / "work" / "_releases" / "b1").exists() or not any((tmp_path / "work" / "_releases" / "b1").iterdir())


def test_next_finishes_the_current_batch_first(batches):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    for bid, z in (("qa", 0), ("qb", 2), ("qc", 0)):
        assert anna.post(_blk(bid) + "/review-range", json={"action": "complete", "z_from": z, "z_to": z}).status_code == 200
    nxt = lambda b, z: rita.get("/api/v1/annotate/review/next", params={"block": b, "z": z}).json()
    r = nxt("qa", 0)
    assert r["next"] == {"block_id": "qb", "z": 2, "batch_id": "b1"} and r["crossed_batch"] is False
    r = nxt("qb", 2)
    assert r["next"] == {"block_id": "qc", "z": 0, "batch_id": "b2"} and r["crossed_batch"] is True, "本批审完才换批，并说明换了"
    r = nxt("qc", 0)
    assert r["next"]["block_id"] == "qa" and r["crossed_batch"] is True


def test_same_block_name_in_two_import_directories_is_reported(batches):
    as_, root = batches
    rita = as_("rita")
    _put_block(root, "b2", "qa")                           # 和 b1/qa 同名：块按目录名识别，只能用一个
    sm = rita.get("/api/v1/annotate/review/summary").json()
    assert [(d["block_id"], d["used"].endswith("b1/qa"), [p.endswith("b2/qa") for p in d["ignored"]]) for d in sm["duplicates"]] \
        == [("qa", True, [True])]


def test_two_import_directories_with_the_same_name_cannot_be_released(batches):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    _put_block(root, "other", "b1", "qz")                  # 另一个也叫 b1 的导入目录
    _approve(anna, rita, "qa", 0)
    sm = rita.get("/api/v1/annotate/review/summary").json()
    assert len(sm["batches"][0]["ambiguous_dirs"]) == 2
    r = rita.post("/api/v1/annotate/review/batches/b1/releases", json={"expect_included": {"qa": [0]}})
    assert r.status_code == 409 and detail(r)["code"] == "ambiguous"
    assert rita.get("/api/v1/annotate/review/batches/nope/releases/preview").status_code == 404


def test_a_broken_block_is_shown_in_its_batch_and_left_out_of_the_release(batches):
    as_, root = batches
    anna, rita = as_("anna"), as_("rita")
    bad = root / "b1" / "qe"
    bad.mkdir()
    np.save(bad / "em.npy", np.zeros((8, 6), dtype=np.uint8))          # 2-D：打不开
    _approve(anna, rita, "qa", 0)
    sm = rita.get("/api/v1/annotate/review/summary").json()
    b1 = sm["batches"][0]
    assert b1["blocks"] == ["qa", "qb", "qd", "qe"] and b1["n_errors"] == 1, "打不开的块留在所属批次里报错，不悄悄消失"
    pv = rita.get("/api/v1/annotate/review/batches/b1/releases/preview").json()
    assert ("qe", "unreadable") in [(x["block_id"], x["reason"]) for x in pv["skipped"]]
    r = rita.post("/api/v1/annotate/review/batches/b1/releases", json={"expect_included": pv["expect_included"]})
    assert r.status_code == 200 and "qe" in [x["block_id"] for x in r.json()["skipped"]], "版本记录里写明哪块没收、为什么"
