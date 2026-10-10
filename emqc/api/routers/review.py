"""标注审核接口：对比页上的「通过 / 退回修改 / 撤销通过」，进度页上的「标记完成 / 撤回完成」、每片状态、入库版本。

规则见 emqc/annotate/review.py 开头和 docs/REVIEW.md。要点：
- 所有审核动作都要落在具体的人名下：没开登录（EMQC_AUTH_DISABLED）时整套审核不可用（409 disabled）；服务令牌过不了 require_user。
- 「通过 / 退回 / 撤销通过 / 入库」只有审核员和管理员能做，而且必须是密码登录（试用模式下谁都能冒名，409 open_mode）。
- 通过钉在内容哈希上：请求带着审核员看到的哈希，服务器在块锁里重算，对不上就 409 stale。
- 四眼原则（严格，没有破例）：参与过这一片的人（改过、撤销过）不能通过它。
- 两个人同时操作同一片：带着旧 version 的那个条件更新落空 → 409 conflict。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from emqc import auth
from emqc.annotate import review as rv
from emqc.config import settings
from emqc.db.base import get_session
from emqc.db.models import AnnotRelease, Mark, ReviewEvent, ReviewEventMark, SliceReview, User

from .auth import require_user

router = APIRouter(prefix="/api/v1/annotate", tags=["review"], dependencies=[Depends(require_user)])


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _err(status: int, code: str, message: str, **extra):
    return HTTPException(status, {"code": code, "message": message, **extra})


# ------------------------------------------------------------------ 身份与权限
def _human(user: User | None) -> User:
    if user is None:
        raise _err(409, "disabled", "这个实例没有开启登录，审核功能不可用：审核结论必须落在具体的人名下")
    return user


def _decider_problem(s: Session, user: User) -> tuple[str, str] | None:
    """能不能下审核结论（通过 / 退回 / 撤销通过 / 入库）。不能就返回 (code, 原因)。"""
    if user.role not in ("reviewer", "admin"):
        return "role", "只有审核员或管理员能下审核结论"
    if auth.login_mode(s) == "open":
        return "open_mode", "现在是试用模式（填名字即可登录），无法确认审核结论是本人做的；请管理员在「用户管理」里切换为密码登录"
    if not auth.has_password(user):
        return "no_password", "你的账号还没有设置密码，不能下审核结论；请先在右上角「账号」里设置密码"
    return None


def _need_decider(s: Session, user: User) -> None:
    p = _decider_problem(s, user)
    if p:
        raise _err(409 if p[0] == "open_mode" else 403, p[0], p[1])


def _actor(user: User):
    return auth.actor_for(user)


def _who(user: User) -> dict:
    return {"id": user.id, "user": user.username, "name": user.display_name or user.username, "role": user.role}


def _block(block_id: str, *, write: bool = False):
    from .annotate import _block as get

    return get(block_id, read_only=not write)


def _check_z(b, z: int) -> None:
    if not 0 <= z < b.nz:
        raise HTTPException(404, f"z {z} 超出范围 0..{b.nz - 1}")


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    text = text.replace("\r\n", "\n").strip()
    return text or None


# ------------------------------------------------------------------ 读状态
def _row(s: Session, block_id: str, z: int) -> SliceReview | None:
    return s.scalars(select(SliceReview).where(SliceReview.block_id == block_id, SliceReview.z == z)
                     .execution_options(populate_existing=True)).first()


def _open_marks(s: Session, block_id: str, z: int) -> list[Mark]:
    return list(s.scalars(select(Mark).where(Mark.block_id == block_id, Mark.z == z, Mark.status == "open").order_by(Mark.id)))


def _mark_brief(m: Mark) -> dict:
    return {"id": m.id, "x": m.x, "y": m.y, "label_id": m.label_id, "text": m.text, "created_by_name": m.created_by_name,
            "status": m.status}


def _event_dict(e: ReviewEvent) -> dict:
    return {"id": e.id, "action": e.action, "action_name": rv.ACTION_NAMES.get(e.action, e.action), "from": e.from_status,
            "to": e.to_status, "comment": e.comment, "by": e.actor_name, "by_user": e.actor_user, "role": e.actor_role,
            "at": rv.db_iso(e.created_at), "sha": e.content_sha256, "rev": e.slice_rev, "marks": e.marks or [],
            "unattributed": e.unattributed}


def _display(b, row: SliceReview | None, sha: str, has_edits: bool) -> str:
    stored = row.status if row else "open"
    return rv.display_status(stored, has_edits,
                             approved_fresh=(stored == "approved" and row.approved_sha256 == sha),
                             edited_since_decision=(stored == "changes_requested" and row.decided_sha256 != sha))


def _why_not(action: str, s: Session, user: User | None, display: str, row: SliceReview | None,
             people: list[dict]) -> tuple[str, str] | None:
    """这个人现在能不能对这一片做这个动作；不能就给 (原因代码, 一句原因)，按钮灰掉时显示原因。"""
    if user is None:
        return "disabled", "这个实例没有开启登录，审核功能不可用"
    allowed, _ = rv.TRANSITIONS[action]
    if display not in allowed:
        return "state", f"当前是「{rv.DISPLAY_NAMES[display]}」，不能{rv.ACTION_NAMES[action]}"
    if action in rv.DECISIONS:
        p = _decider_problem(s, user)
        if p:
            return p
    if action == "approve" and rv.is_contributor(_actor(user), people):
        return "four_eyes", "你参与过这一片的标注（改过或撤销过），按四眼原则不能自己通过，请其他审核员审"
    if action == "uncomplete" and user.role not in ("reviewer", "admin") and (row is None or row.completed_by != user.id):
        return "forbidden", "只有标记完成的人或审核员能撤回"
    return None


def slice_state(s: Session, b, z: int, user: User | None) -> dict:
    with b.lock:
        sha = rv.plane_sha(rv.current_plane(b, z))
        rev = b.slice_rev(z)
        has_edits = bool(b.edits(z))
    people, unattributed = rv.contributors(b, z)
    row = _row(s, b.id, z)
    display = _display(b, row, sha, has_edits)
    marks = _open_marks(s, b.id, z)
    since = row.decided_rev if (row and row.decided_rev is not None) else (row.completed_rev if row else None)
    changes = [e for e in b.audit_entries() if since is not None and int(e["seq"]) > since and (e.get("z") is None or e.get("z") == z)]
    events = list(s.scalars(select(ReviewEvent).where(ReviewEvent.block_id == b.id, ReviewEvent.z == z)
                            .order_by(ReviewEvent.id.desc()).limit(20)))
    actor = _actor(user) if user else None
    can = {a: _why_not(a, s, user, display, row, people) for a in rv.TRANSITIONS}
    return {
        "block_id": b.id, "z": z, "sha": sha, "rev": rev, "status": display, "status_name": rv.DISPLAY_NAMES[display],
        "stored": row.status if row else "open", "version": row.version if row else 0, "in_queue": display in rv.QUEUE,
        "completed_by": row.completed_by_name if row else None, "completed_at": rv.db_iso(row.completed_at) if row else None,
        "decided_by": row.decided_by_name if row else None, "decided_at": rv.db_iso(row.decided_at) if row else None,
        "last_comment": row.last_comment if row else None,
        "contributors": [{"by": p.get("by") or p.get("by_user"), "n": p["n"], "me": bool(actor and rv.is_contributor(actor, [p]))}
                         for p in people],
        "unattributed": unattributed, "open_marks": [_mark_brief(m) for m in marks],
        "since_decision": {"n": len(changes), "n_px": sum(int(e.get("n_px") or 0) for e in changes),
                           "by": sorted({e.get("by") or "未署名" for e in changes})},
        "can": {a: why is None for a, why in can.items()}, "why_not": {a: why[1] for a, why in can.items() if why},
        "events": [_event_dict(e) for e in events],
    }


@router.get("/blocks/{block_id}/review/{z}")
def get_slice_review(block_id: str, z: int, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    b = _block(block_id)
    _check_z(b, z)
    return slice_state(s, b, z, user)


# ------------------------------------------------------------------ 动作
class ReviewActionIn(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["complete", "uncomplete", "approve", "request_changes", "revoke"]
    expect_version: int = Field(ge=0)                                     # 页面看到的审核版本：别人先动了就 409
    expect_sha: str | None = Field(default=None, pattern="^[0-9a-f]{64}$")  # 页面上这一片的内容哈希（通过 / 退回 / 撤销必带）
    comment: str | None = Field(default=None, max_length=4000)
    confirm: bool = False                                                 # 还有未解决标记、或有未署名改动时，确认仍要通过


def _apply(s: Session, b, z: int, row: SliceReview | None, action: str, user: User, *, sha: str | None, rev: int,
           comment: str | None, people: list[dict] | None, unattributed: int, marks: list[Mark], display: str) -> ReviewEvent:
    """把一个已经校验过的动作写进库：条件更新当前状态（version 对不上就 409）+ 追加一条事件。"""
    _, to = rv.TRANSITIONS[action]
    now = _now()
    who = _who(user)
    old_version = row.version if row else 0
    values: dict = {"status": to, "version": old_version + 1, "updated_at": now}
    if action == "complete":
        values.update(completed_rev=rev, completed_by=user.id, completed_by_user=user.username, completed_by_name=who["name"],
                      completed_at=now)
    elif action == "uncomplete":
        values.update(completed_rev=None, completed_by=None, completed_by_user=None, completed_by_name=None, completed_at=None)
    else:
        values.update(decided_rev=rev, decided_sha256=sha, decided_by=user.id, decided_by_user=user.username,
                      decided_by_name=who["name"], decided_at=now, last_comment=comment)
        if action == "approve":
            values.update(approved_sha256=sha, approved_rev=rev)
        else:
            values.update(approved_sha256=None, approved_rev=None)
    try:
        if row is None:
            row = SliceReview(block_id=b.id, z=z, **values)
            s.add(row)
            s.flush()
        else:
            res = s.execute(update(SliceReview).where(SliceReview.id == row.id, SliceReview.version == old_version).values(**values))
            if res.rowcount != 1:
                raise _err(409, "conflict", "别人刚对这一片做了审核操作，已刷新为最新状态，请再看一眼")
        ev = ReviewEvent(block_id=b.id, z=z, action=action, from_status=display, to_status=to, version=old_version + 1,
                         content_sha256=sha, slice_rev=rev, comment=comment, contributors=people, unattributed=unattributed,
                         marks=[_mark_brief(m) for m in marks] if action in ("approve", "request_changes") else None,
                         actor_id=user.id, actor_user=user.username, actor_name=who["name"], actor_role=user.role)
        s.add(ev)
        s.flush()
        if action in ("approve", "request_changes"):
            for m in marks:
                s.add(ReviewEventMark(event_id=ev.id, mark_id=m.id))
        s.execute(update(SliceReview).where(SliceReview.id == row.id).values(last_event_id=ev.id))
        s.commit()
        return ev
    except IntegrityError:
        s.rollback()
        raise _err(409, "conflict", "别人刚对这一片做了审核操作，已刷新为最新状态，请再看一眼")
    except HTTPException:
        s.rollback()
        raise


@router.post("/blocks/{block_id}/review/{z}")
def review_action(block_id: str, z: int, body: ReviewActionIn, user: User | None = Depends(require_user),
                  s: Session = Depends(get_session)):
    user = _human(user)
    b = _block(block_id)
    _check_z(b, z)
    action = body.action
    if action in rv.DECISIONS:
        _need_decider(s, user)
        if body.expect_sha is None:
            raise _err(422, "sha", "缺少 expect_sha：审核结论要绑定你看到的那一版内容")
    with b.lock:
        sha = rv.plane_sha(rv.current_plane(b, z))
        rev = b.slice_rev(z)
        has_edits = bool(b.edits(z))
    if action in rv.DECISIONS and body.expect_sha != sha:
        raise _err(409, "stale", "这一片在你看过之后被改过了，已刷新为最新内容，请看过再操作", sha=sha, rev=rev)
    row = _row(s, b.id, z)
    if (row.version if row else 0) != body.expect_version:
        raise _err(409, "conflict", "别人刚对这一片做了审核操作，已刷新为最新状态，请再看一眼")
    display = _display(b, row, sha, has_edits)
    people, unattributed = rv.contributors(b, z)
    why = _why_not(action, s, user, display, row, people)
    if why:
        code, message = why
        raise _err(409 if code in ("state", "open_mode", "disabled") else 403, code, message)
    comment = _clean(body.comment)
    marks = _open_marks(s, b.id, z) if action in ("approve", "request_changes") else []
    if action == "approve" and not body.confirm:
        if marks:
            raise _err(409, "confirm", f"这一片还有 {len(marks)} 个未解决的标记，确认没问题、仍要通过吗？", what="open_marks", n=len(marks))
        if unattributed:
            raise _err(409, "confirm", f"这一片有 {unattributed} 笔没有署名的改动（无法确认是谁做的），确认仍要通过吗？",
                       what="unattributed", n=unattributed)
    if action == "request_changes" and not comment and not marks:
        raise _err(422, "comment", "退回修改要写明原因（或先在图上钉标记说明问题）")
    if action == "revoke" and not comment:
        raise _err(422, "comment", "撤销通过要写明原因")
    _apply(s, b, z, row, action, user, sha=sha if action in rv.DECISIONS else None, rev=rev, comment=comment,
           people=people, unattributed=unattributed, marks=marks, display=display)
    return slice_state(s, b, z, user)


class RangeIn(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["complete", "uncomplete"]
    z_from: int = Field(ge=0)
    z_to: int = Field(ge=0)


@router.post("/blocks/{block_id}/review-range")
def review_range(block_id: str, body: RangeIn, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """进度页上按范围「标记完成 / 撤回完成」。逐片判断：不能做的片跳过并说明原因，其余照做。"""
    user = _human(user)
    b = _block(block_id)
    lo, hi = sorted((body.z_from, body.z_to))
    _check_z(b, lo)
    _check_z(b, hi)
    eds = rv.slice_editors(b)
    revs = rv.slice_revs(b)
    done, skipped = [], []
    for z in range(lo, hi + 1):
        row = _row(s, b.id, z)
        stored = row.status if row else "open"
        has_edits = z in eds
        if stored in ("approved", "changes_requested"):
            sha = rv.current_sha(b, z)
            display = _display(b, row, sha, has_edits)
        else:
            display = rv.display_status(stored, has_edits)
        why = _why_not(body.action, s, user, display, row, [])
        if why:
            skipped.append({"z": z, "reason": why[1]})
            continue
        try:
            _apply(s, b, z, row, body.action, user, sha=None, rev=revs[z], comment=None, people=None, unattributed=0, marks=[],
                   display=display)
            done.append(z)
        except HTTPException as e:
            skipped.append({"z": z, "reason": e.detail.get("message") if isinstance(e.detail, dict) else str(e.detail)})
    return {"done": done, "skipped": skipped}


# ------------------------------------------------------------------ 进度
def block_rows(s: Session, b, user: User | None) -> dict:
    """进度页一块的数据：每一片的状态、改动人、最后编辑、最近结论、未解决标记数，以及我能不能审。
    状态全部现算；已通过的片只有版本号变过才重新算哈希（整片读一次），没变就沿用。"""
    revs = rv.slice_revs(b)
    eds = rv.slice_editors(b)
    keys = rv.slice_contributor_keys(b, eds)
    rows = {r.z: r for r in s.scalars(select(SliceReview).where(SliceReview.block_id == b.id).execution_options(populate_existing=True))}
    open_marks: dict[int, int] = {}
    for z, n in s.execute(select(Mark.z, func.count()).where(Mark.block_id == b.id, Mark.status == "open").group_by(Mark.z)):
        open_marks[int(z)] = int(n)
    actor = _actor(user) if user else None
    can_decide = user is not None and _decider_problem(s, user) is None
    counts: dict[str, int] = {k: 0 for k in rv.DISPLAY_NAMES}
    out = []
    for z in range(b.nz):
        r = rows.get(z)
        stored = r.status if r else "open"
        fresh, edited = None, False
        if stored == "approved":
            fresh = revs[z] == r.approved_rev or rv.current_sha(b, z) == r.approved_sha256
        elif stored == "changes_requested":
            edited = revs[z] != r.decided_rev and rv.current_sha(b, z) != r.decided_sha256
        display = rv.display_status(stored, z in eds, approved_fresh=fresh, edited_since_decision=edited)
        counts[display] += 1
        mine = bool(actor and rv.actor_matches(actor, keys.get(z, set())))
        e = eds.get(z, {})
        out.append({
            "z": z, "status": display, "status_name": rv.DISPLAY_NAMES[display], "version": r.version if r else 0,
            "rev": revs[z], "editors": e.get("editors", {}), "n_edits": e.get("n", 0), "unattributed": e.get("unattributed", 0),
            "last_edit": rv.ts_iso(e.get("last_ts")),
            "completed_by": r.completed_by_name if r else None, "completed_at": rv.db_iso(r.completed_at) if r else None,
            "decided_by": r.decided_by_name if r else None, "decided_at": rv.db_iso(r.decided_at) if r else None,
            "last_comment": r.last_comment if r else None, "open_marks": open_marks.get(z, 0), "mine": mine,
            # 我的待办：退回修改的片，我参与过或者没人参与过（没人认领的退回大家都看得到）
            "todo": display in ("returned", "fixed") and (mine or not keys.get(z)),
            "reviewable": display in rv.QUEUE and can_decide and not mine,
        })
    return {"block_id": b.id, "nz": b.nz, "counts": counts, "slices": out}


def _blocks(s: Session):
    from .annotate import get_store

    st = get_store(read_only=True)
    return [x for x in st.refresh() if not x.get("error") and x.get("has_seg")]


@router.get("/review/summary")
def review_summary(user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """所有数据块的审核进度汇总（进度页顶部），以及我是谁、能不能下结论。"""
    out = []
    for info in _blocks(s):
        b = _block(info["block_id"])
        rows = block_rows(s, b, user)
        latest = s.scalars(select(AnnotRelease).where(AnnotRelease.block_id == b.id).order_by(AnnotRelease.version.desc())).first()
        out.append({"block_id": b.id, "nz": b.nz, "counts": rows["counts"],
                    "todo": sum(1 for r in rows["slices"] if r["todo"]), "reviewable": sum(1 for r in rows["slices"] if r["reviewable"]),
                    "latest_release": None if latest is None else {"version": latest.version, "n_slices": latest.n_slices,
                                                                   "at": rv.db_iso(latest.created_at)}})
    me = None
    if user is not None:
        p = _decider_problem(s, user)
        me = {"name": user.display_name or user.username, "role": user.role, "can_decide": p is None, "why_not": p[1] if p else None}
    return {"blocks": out, "me": me, "status_names": rv.DISPLAY_NAMES}


@router.get("/blocks/{block_id}/review")
def block_review(block_id: str, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    b = _block(block_id)
    return block_rows(s, b, user)


@router.get("/review/next")
def next_to_review(block: str | None = None, z: int = -1, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """从 (block, z) 往后找下一张我能审的片：待审核或通过后被修改，而且我没参与过。按数据块、z 顺序，到头绕回来。"""
    if user is None or _decider_problem(s, user) is not None:
        return {"next": None}
    ids = [x["block_id"] for x in _blocks(s)]
    if not ids:
        return {"next": None}
    start = ids.index(block) if block in ids else 0
    order = ids[start:] + ids[:start]
    for i, bid in enumerate(order + [order[0]]):
        rows = block_rows(s, _block(bid), user)["slices"]
        for r in rows:
            if i == 0 and r["z"] <= z:
                continue
            if i == len(order) and r["z"] >= z:
                break
            if r["reviewable"]:
                return {"next": {"block_id": bid, "z": r["z"]}}
    return {"next": None}


# ------------------------------------------------------------------ 入库版本
def _approved(s: Session, b) -> dict[int, dict]:
    rows = list(s.scalars(select(SliceReview).where(SliceReview.block_id == b.id, SliceReview.status == "approved")
                          .execution_options(populate_existing=True)))
    events = {e.id: e for e in s.scalars(select(ReviewEvent).where(ReviewEvent.id.in_([r.last_event_id for r in rows if r.last_event_id])))}
    out = {}
    for r in rows:
        e = events.get(r.last_event_id)
        out[r.z] = {"sha": r.approved_sha256, "rev": r.approved_rev, "at": rv.db_iso(r.decided_at), "event_id": r.last_event_id,
                    "by": {"id": r.decided_by, "user": r.decided_by_user, "name": r.decided_by_name},
                    "contributors": (e.contributors if e is not None else None) or []}
    return out


def _release_dict(r: AnnotRelease) -> dict:
    return {"version": r.version, "path": r.path, "n_slices": r.n_slices, "z_list": r.z_list or [], "manifest_sha256": r.manifest_sha256,
            "audit_seq": r.audit_seq, "note": r.note, "created_by": r.created_by_name, "created_at": rv.db_iso(r.created_at)}


@router.get("/blocks/{block_id}/releases")
def list_releases(block_id: str, s: Session = Depends(get_session)):
    _block(block_id)
    rows = s.scalars(select(AnnotRelease).where(AnnotRelease.block_id == block_id).order_by(AnnotRelease.version.desc()))
    return {"releases": [_release_dict(r) for r in rows], "root": str(rv.releases_root(settings.annotate_workdir))}


@router.get("/blocks/{block_id}/releases/preview")
def preview_release(block_id: str, s: Session = Depends(get_session)):
    """这次入库会收哪些片、不收哪些（不写任何东西）。"""
    b = _block(block_id)
    approved = _approved(s, b)
    plan = rv.plan_release(b, approved)
    rows = block_rows(s, b, None)["slices"]
    not_approved = [{"z": r["z"], "reason": r["status"], "message": r["status_name"]} for r in rows if r["z"] not in approved]
    return {"included": plan["included"], "excluded": plan["excluded"], "not_approved": not_approved, "nz": b.nz}


class ReleaseIn(BaseModel):
    model_config = {"extra": "forbid"}
    expect_included: list[int]                                     # 预览时看到的那份清单：入库前内容又变了就 409
    note: str | None = Field(default=None, max_length=2000)


@router.post("/blocks/{block_id}/releases")
def create_release(block_id: str, body: ReleaseIn, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    user = _human(user)
    _need_decider(s, user)
    b = _block(block_id, write=True)
    if settings.annotate_workdir is None or b.work == b.path:
        raise _err(422, "workdir", "没有配置标注工作目录（EMQC_ANNOTATE_WORKDIR），无法入库")
    try:
        b._hold()                                         # 和写像素一样：先占住工作目录（同一时间只有一个服务进程在写）、查磁盘
    except ValueError as e:
        raise _err(409, "workdir", str(e))
    approved = _approved(s, b)
    plan = rv.plan_release(b, approved)
    if sorted(plan["included"]) != sorted(set(body.expect_included)):
        raise _err(409, "stale", "可入库的切片和你预览时不一样了（有人又通过或修改了），请重新预览后再入库",
                   included=plan["included"], excluded=plan["excluded"])
    from emqc.logs import _git_commit

    try:
        res = rv.write_release(b, settings.annotate_workdir, plan, approved, created_by=_who(user), note=_clean(body.note),
                               code_commit=_git_commit())
    except ValueError as e:
        raise _err(422, "release", str(e))
    row = AnnotRelease(block_id=b.id, version=res["version"], path=res["path"], n_slices=res["n_slices"], z_list=res["z_list"],
                       manifest_sha256=res["manifest_sha256"], audit_seq=res["audit_seq"], note=_clean(body.note),
                       created_by=user.id, created_by_user=user.username, created_by_name=_who(user)["name"])
    s.add(row)
    s.commit()
    return {**_release_dict(row), "excluded": res["excluded"]}
