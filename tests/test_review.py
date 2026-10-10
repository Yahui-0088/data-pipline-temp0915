"""标注审核：标记完成 → 审核员通过 / 退回修改 / 撤销通过；四眼原则；内容哈希钉住；并发；标记证据；入库版本。"""
import hashlib
import json
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient

from test_auth import PW, auth_on, detail, login, make_user  # noqa: F401  (auth_on 是 fixture)
from test_who import make_block

URL = "/api/v1/annotate/blocks/who"


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
    monkeypatch.setattr(review, "_blocks", lambda _s: [{"block_id": "who", "has_seg": True}])
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
    assert r.status_code == 409 and detail(r)["what"] == "open_marks", "还有未解决的标记，通过前要确认"
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
    assert r.status_code == 409 and detail(r)["what"] == "unattributed"
    assert act(rita, 1, "approve", st, confirm=True).status_code == 200


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
    assert nxt == {"block_id": "who", "z": 1}
    nxt = rita.get("/api/v1/annotate/review/next", params={"block": "who", "z": 1}).json()["next"]
    assert nxt == {"block_id": "who", "z": 0}, "到头绕回来"
    assert anna.get("/api/v1/annotate/review/next", params={"block": "who", "z": 0}).json()["next"] is None
    summary = rita.get("/api/v1/annotate/review/summary").json()
    assert summary["blocks"][0]["reviewable"] == 2 and summary["me"]["can_decide"]


def test_release(env, tmp_path):
    as_, b = env
    anna, rita = as_("anna"), as_("rita")
    paint(anna, 0, 1, 7)
    paint(anna, 2, 3, 8)
    complete(anna, 0, 2)
    for z in (0, 2):
        assert act(rita, z, "approve").status_code == 200
    paint(anna, 2, 4, 8)                                      # 通过后又改了第 2 片：这次不收
    pv = rita.get(URL + "/releases/preview").json()
    assert pv["included"] == [0] and pv["excluded"][0]["z"] == 2 and pv["excluded"][0]["reason"] == "changed"
    r = anna.post(URL + "/releases", json={"expect_included": [0]})
    assert r.status_code == 403, "标注员不能入库"
    r = rita.post(URL + "/releases", json={"expect_included": [0, 2]})
    assert r.status_code == 409 and detail(r)["code"] == "stale", "和预览不一致就拒绝"
    r = rita.post(URL + "/releases", json={"expect_included": [0], "note": "第一批"})
    assert r.status_code == 200, r.text
    rel = r.json()
    assert rel["version"] == 1 and rel["z_list"] == [0]
    d = tmp_path / "work" / rel["path"]
    seg = np.load(d / "seg.npy")
    src = np.load(b.work / "seg_edit.npy")
    assert seg.shape == src.shape and seg.dtype == src.dtype, "与原始 seg.npy 同形状同类型同轴序"
    assert np.array_equal(seg[:, :, 0], src[:, :, 0]) and not seg[:, :, 1:].any()
    assert np.load(d / "reviewed_z.npy").tolist() == [True, False, False]
    manifest = json.loads((d / "manifest.json").read_text())
    assert manifest["approval_scope"] == "whole_slice" and manifest["slices"][0]["approved_by"]["name"] == "丽塔"
    assert manifest["slices"][0]["contributors"][0]["by"] == "安娜"
    for line in (d / "checksums.sha256").read_text().splitlines():
        digest, name = line.split("  ")
        assert hashlib.sha256((d / name).read_bytes()).hexdigest() == digest
    assert not os.access(d / "seg.npy", os.W_OK), "版本文件只读"
    assert rel["manifest_sha256"] == hashlib.sha256((d / "manifest.json").read_bytes()).hexdigest()
    assert act(rita, 2, "approve").status_code == 200
    r = rita.post(URL + "/releases", json={"expect_included": [0, 2]})
    assert r.status_code == 200 and r.json()["version"] == 2
    assert [x["version"] for x in rita.get(URL + "/releases").json()["releases"]] == [2, 1]
    assert not any(p.name.startswith(".tmp") for p in (tmp_path / "work" / "_releases" / "who").iterdir())


def test_writes_from_another_origin_are_refused(env):
    as_, b = env
    anna = as_("anna")
    r = anna.post(URL + "/review-range", json={"action": "complete", "z_from": 0, "z_to": 0},
                  headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and detail(r)["code"] == "origin"
    r = anna.post(URL + "/review-range", json={"action": "complete", "z_from": 0, "z_to": 0},
                  headers={"Origin": "http://testserver"})
    assert r.status_code == 200
