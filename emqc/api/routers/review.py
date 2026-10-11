"""标注审核接口：对比页上的「通过 / 退回修改 / 撤销通过」，进度页上的「标记完成 / 撤回完成」、按批次的进度、按批次入库。

规则见 emqc/annotate/review.py 开头和 docs/REVIEW.md。要点：
- 所有审核动作都要落在具体的人名下：没开登录（EMQC_AUTH_DISABLED）时整套审核不可用（409 disabled）；服务令牌过不了 require_user。
- 「通过 / 退回 / 撤销通过 / 入库」只有审核员和管理员能做，而且必须是密码登录（试用模式下谁都能冒名，409 open_mode）。
- 通过钉在内容哈希上：请求带着审核员看到的哈希，服务器在块锁里重算，对不上就 409 stale。
- 四眼原则（严格，没有破例）：参与过这一片的人（改过、撤销过）不能通过它。
- 两个人同时操作同一片：带着旧 version 的那个条件更新落空 → 409 conflict。
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from pathlib import Path
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


# 要扫整块的请求（进度汇总、下一张待审、入库预览、入库）同时最多两个：大数据块上一次可能要几秒，
# 不限的话几个人一起刷新就把线程池占满，工作台的画笔请求也跟着排队
_heavy = threading.BoundedSemaphore(2)


@contextmanager
def _heavy_slot():
    if not _heavy.acquire(timeout=20):
        raise HTTPException(429, {"code": "busy", "message": "服务器正忙（别人在汇总或入库），请稍后再试"})
    try:
        yield
    finally:
        _heavy.release()


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


def _slice_now(b, z: int) -> tuple[str, int, list[dict]]:
    """这一片此刻的 (内容哈希, 版本号, 有效改动)，同一把锁里取。哈希按像素版本缓存，像素没变就不读盘。"""
    with b.lock:
        return rv.current_sha(b, z), b.slice_rev(z), b.edits(z)


def _history_problem(b, z: int, e: Exception, s: Session, user: User | None) -> dict:
    """这一片的改动记录读不出来（像素记录文件丢了或坏了）：不能可靠判断谁参与过、改了什么，所以不能审，说清原因。"""
    row = _row(s, b.id, z)
    why = f"这一片的改动记录读不出来（{e}），暂时不能审核，请联系管理员修复"
    return {"block_id": b.id, "z": z, "sha": None, "rev": b.slice_rev(z), "status": "in_progress", "status_name": "记录损坏",
            "stored": row.status if row else "open", "version": row.version if row else 0, "in_queue": False,
            "history_error": str(e), "completed_by": None, "completed_at": None, "decided_by": None, "decided_at": None,
            "last_comment": row.last_comment if row else None, "contributors": [], "unattributed": 0, "open_marks": [],
            "since_decision": {"n": 0, "n_px": 0, "by": []}, "can": {a: False for a in rv.TRANSITIONS},
            "why_not": {a: why for a in rv.TRANSITIONS}, "can_decide": False, "why_not_decide": why, "decision": None, "events": []}


def slice_state(s: Session, b, z: int, user: User | None) -> dict:
    try:
        sha, rev, recs = _slice_now(b, z)
    except ValueError as e:
        return _history_problem(b, z, e, s, user)
    has_edits = bool(recs)
    people, unattributed = rv.contributors(b, z, recs)
    row = _row(s, b.id, z)
    display = _display(b, row, sha, has_edits)
    marks = _open_marks(s, b.id, z)
    since = row.decided_rev if (row and row.decided_rev is not None) else (row.completed_rev if row else None)
    changes = [e for e in b.audit_entries() if since is not None and int(e["seq"]) > since and (e.get("z") is None or e.get("z") == z)]
    events = list(s.scalars(select(ReviewEvent).where(ReviewEvent.block_id == b.id, ReviewEvent.z == z)
                            .order_by(ReviewEvent.id.desc()).limit(20)))
    actor = _actor(user) if user else None
    can = {a: _why_not(a, s, user, display, row, people) for a in rv.TRANSITIONS}
    decider = _decider_problem(s, user) if user else ("disabled", "这个实例没有开启登录")
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
        "can_decide": decider is None, "why_not_decide": decider[1] if decider else None,
        # 最近一次审核结论是什么（通过 / 退回 / 撤销通过）：页面据此描述「谁在什么时候做了什么」
        "decision": s.scalar(select(ReviewEvent.action).where(ReviewEvent.block_id == b.id, ReviewEvent.z == z,
                                                              ReviewEvent.action.in_(rv.DECISIONS))
                             .order_by(ReviewEvent.id.desc()).limit(1)),
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
    # 通过时要确认的事项：还有未解决标记（open_marks）、有没署名的改动（unattributed）。每一项都要单独确认过才放行
    confirm: list[Literal["open_marks", "unattributed"]] = Field(default_factory=list, max_length=2)


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
    try:
        sha, rev, recs = _slice_now(b, z)
    except ValueError as e:
        raise _err(409, "history", f"这一片的改动记录读不出来（{e}），暂时不能审核，请联系管理员修复")
    has_edits = bool(recs)
    if action in rv.DECISIONS and body.expect_sha != sha:
        raise _err(409, "stale", "这一片在你看过之后被改过了，已刷新为最新内容，请看过再操作", sha=sha, rev=rev)
    row = _row(s, b.id, z)
    if (row.version if row else 0) != body.expect_version:
        raise _err(409, "conflict", "别人刚对这一片做了审核操作，已刷新为最新状态，请再看一眼")
    display = _display(b, row, sha, has_edits)
    people, unattributed = rv.contributors(b, z, recs)
    why = _why_not(action, s, user, display, row, people)
    if why:
        code, message = why
        raise _err(409 if code in ("state", "open_mode", "disabled") else 403, code, message)
    comment = _clean(body.comment)
    marks = _open_marks(s, b.id, z) if action in ("approve", "request_changes") else []
    if action == "approve":
        need = []
        if marks and "open_marks" not in body.confirm:
            need.append(("open_marks", f"这一片还有 {len(marks)} 个未解决的标记"))
        if unattributed and "unattributed" not in body.confirm:
            need.append(("unattributed", f"这一片有 {unattributed} 笔没有署名的改动（无法确认是谁做的）"))
        if need:                                    # 一次把要确认的都说出来；页面确认后带上全部 what 再发
            raise _err(409, "confirm", "；".join(m for _, m in need) + "。确认没问题、仍要通过吗？",
                       what=[k for k, _ in need], n_marks=len(marks), n_unattributed=unattributed)
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
        # 不读像素：标记完成 / 撤回只看存库状态就能定（已通过的两样都不行，退回的只能标记完成），
        # 显示用的「已通过 / 通过后被修改」「退回 / 已修改」按版本号粗分就够了
        if stored == "approved":
            display = "approved" if revs[z] == row.approved_rev else "changed"
        elif stored == "changes_requested":
            display = "returned" if revs[z] == row.decided_rev else "fixed"
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
        broken = bool(e.get("unreadable"))
        out.append({
            "z": z, "status": display, "status_name": rv.DISPLAY_NAMES[display], "version": r.version if r else 0,
            "rev": revs[z], "editors": e.get("editors", {}), "n_edits": e.get("n", 0), "unattributed": e.get("unattributed", 0),
            "last_edit": rv.ts_iso(e.get("last_ts")),
            "completed_by": r.completed_by_name if r else None, "completed_at": rv.db_iso(r.completed_at) if r else None,
            "decided_by": r.decided_by_name if r else None, "decided_at": rv.db_iso(r.decided_at) if r else None,
            "last_comment": r.last_comment if r else None, "open_marks": open_marks.get(z, 0), "mine": mine,
            # 我的待办：退回修改的片，我参与过或者没人参与过（没人认领的退回大家都看得到）
            "todo": display in ("returned", "fixed") and (mine or not keys.get(z)),
            "reviewable": display in rv.QUEUE and can_decide and not mine and not broken,
            "history_error": "有改动的像素记录读不出来，暂时不能审核，请联系管理员" if broken else None,
        })
    return {"block_id": b.id, "nz": b.nz, "counts": counts, "slices": out}


def _root_names() -> dict[str, str]:
    """解析后的根目录 → 配置里写的目录名。根目录本身是符号链接时，批次按配置里看到的名字（链接名）叫，
    而不是链接指向的目录名——改链接名就能改批次名，和管理员看到的一致。"""
    raw = [settings.annotate_root, *(x.strip() for x in settings.annotate_extra_roots.split(";") if x.strip()), settings.sam_blocks_dir]
    out = {}
    for r in raw:
        if r:
            r = Path(r)
            name = Path(os.path.normpath(r)).name           # 「x/..」这类写法按规整后的名字；「.」退回解析后的目录名
            out[str(r.resolve())] = name if name not in ("", ".", "..") else r.resolve().name
    return out


def _batch_id(path: str, names: dict[str, str]) -> str:
    parent = Path(path).parent
    return names.get(str(parent)) or rv.batch_of(path)


def _blocks(s: Session) -> list[dict]:
    """可审核的数据块（带分割标签的；打不开的也列上，在所属批次里报错），每个带上所属批次（导入目录名）。
    按（批次, 块）排好序：进度页、下一张待审都按这个顺序走。"""
    from .annotate import get_store

    st = get_store(read_only=True)
    names = _root_names()
    out = [{**x, "batch_id": _batch_id(x["path"], names) if x.get("path") else ""}
           for x in st.refresh() if x.get("error") or x.get("has_seg")]
    return sorted(out, key=lambda x: (x["batch_id"], x["block_id"]))


def _duplicates() -> list[dict]:
    from .annotate import get_store

    return [{"block_id": k, "used": v[0], "ignored": v[1:]} for k, v in sorted(get_store(read_only=True).duplicates.items())]


def _ambiguous(members: list[dict]) -> list[str]:
    """同一个批次名对应了不止一个目录（两个导入目录同名）：返回这些目录，入库时要拒绝。"""
    dirs = sorted({str(Path(x["path"]).parent) for x in members if x.get("path")})
    return dirs if len(dirs) > 1 else []


def _latest_release(s: Session, batch_id: str) -> dict | None:
    r = s.scalars(select(AnnotRelease).where(AnnotRelease.batch_id == batch_id).order_by(AnnotRelease.version.desc())).first()
    return None if r is None else {"version": r.version, "n_slices": r.n_slices, "n_blocks": r.n_blocks, "at": rv.db_iso(r.created_at)}


@router.get("/review/summary")
def review_summary(user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """按批次汇总的审核进度（进度页顶部），每批下面是各数据块的汇总；以及我是谁、能不能下结论。
    某一块的编辑记录坏了：那一块单独报错，其余照常显示（不能一块坏了整页打不开）。"""
    blocks = []
    with _heavy_slot():
        infos = _blocks(s)
        for info in infos:
            base = {"block_id": info["block_id"], "batch_id": info["batch_id"]}
            if info.get("error"):
                blocks.append({**base, "error": f"数据块打不开：{info['error']}"})
                continue
            try:
                b = _block(info["block_id"])
                rows = block_rows(s, b, user)
            except (ValueError, OSError, HTTPException) as e:
                msg = e.detail if isinstance(e, HTTPException) else str(e)
                blocks.append({**base, "error": f"编辑记录读不出来：{msg if isinstance(msg, str) else str(msg)}"})
                continue
            blocks.append({**base, "nz": b.nz, "counts": rows["counts"],
                           "todo": sum(1 for r in rows["slices"] if r["todo"]), "reviewable": sum(1 for r in rows["slices"] if r["reviewable"])})
    batches: dict[str, dict] = {}
    for x in blocks:
        g = batches.setdefault(x["batch_id"], {"batch_id": x["batch_id"], "blocks": [], "n_errors": 0, "nz": 0,
                                               "counts": {k: 0 for k in rv.DISPLAY_NAMES}, "todo": 0, "reviewable": 0})
        g["blocks"].append(x["block_id"])
        if x.get("error"):
            g["n_errors"] += 1
            continue
        g["nz"] += x["nz"]
        g["todo"] += x["todo"]
        g["reviewable"] += x["reviewable"]
        for k, n in x["counts"].items():
            g["counts"][k] += n
    for g in batches.values():
        g["latest_release"] = _latest_release(s, g["batch_id"])
        g["ambiguous_dirs"] = _ambiguous([x for x in infos if x["batch_id"] == g["batch_id"]])
    me = None
    if user is not None:
        p = _decider_problem(s, user)
        me = {"name": user.display_name or user.username, "role": user.role, "can_decide": p is None, "why_not": p[1] if p else None}
    return {"batches": list(batches.values()), "blocks": blocks, "duplicates": _duplicates(), "me": me, "status_names": rv.DISPLAY_NAMES}


@router.get("/blocks/{block_id}/review")
def block_review(block_id: str, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    b = _block(block_id)
    return {**block_rows(s, b, user), "batch_id": _batch_id(str(b.path), _root_names())}


@router.get("/review/next")
def next_to_review(block: str | None = None, z: int = -1, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """从 (block, z) 往后找下一张我能审的片：待审核或通过后被修改，而且我没参与过。按批次、数据块、z 的顺序，
    先把当前批次审完再进下一批（crossed_batch 告诉页面换批了），到头绕回来。
    不能审的人返回原因（页面显示原因，而不是说「没有待审」）。"""
    if user is None:
        return {"next": None, "why": "这个实例没有开启登录，审核功能不可用"}
    p = _decider_problem(s, user)
    if p is not None:
        return {"next": None, "why": p[1]}
    infos = [x for x in _blocks(s) if not x.get("error")]
    if not infos:
        return {"next": None}
    batch_of = {x["block_id"]: x["batch_id"] for x in infos}
    known = block in batch_of
    if not known:                                       # 没给块或不认识：从第一批第一块从头找
        block, z = infos[0]["block_id"], -1
    cur = batch_of[block]
    same = [x["block_id"] for x in infos if x["batch_id"] == cur]
    i = same.index(block)
    # 先审完本批：当前块 z 之后 → 本批其余的块（从下一块起绕一圈）→ 当前块 z 之前（不返回正在看的这一片）；
    # 本批没有了再按批次顺序从下一批起看其他批，到头绕回
    plan = [(block, lambda zz: zz > z)] + [(b, None) for b in same[i + 1:] + same[:i]] + [(block, lambda zz: zz < z)]
    order = list(dict.fromkeys(x["batch_id"] for x in infos))
    j = order.index(cur)
    plan += [(x["block_id"], None) for bt in order[j + 1:] + order[:j] for x in infos if x["batch_id"] == bt]
    rows: dict[str, list] = {}
    with _heavy_slot():
        for bid, keep in plan:
            if bid not in rows:
                try:
                    rows[bid] = block_rows(s, _block(bid), user)["slices"]
                except (ValueError, OSError, HTTPException):
                    rows[bid] = []                        # 这一块的记录坏了：跳过，别让下一张待审整个失灵
            for r in rows[bid]:
                if r["reviewable"] and (keep is None or keep(r["z"])):
                    return {"next": {"block_id": bid, "z": r["z"], "batch_id": batch_of[bid]},
                            "crossed_batch": known and batch_of[bid] != cur}
    return {"next": None}


# ------------------------------------------------------------------ 入库版本（按批次）
def _approved(s: Session, b) -> dict[int, dict]:
    rows = list(s.scalars(select(SliceReview).where(SliceReview.block_id == b.id, SliceReview.status == "approved")
                          .execution_options(populate_existing=True)))
    events = {e.id: e for e in s.scalars(select(ReviewEvent).where(ReviewEvent.id.in_([r.last_event_id for r in rows if r.last_event_id])))}
    out = {}
    for r in rows:
        e = events.get(r.last_event_id)
        out[r.z] = {"sha": r.approved_sha256, "rev": r.approved_rev, "version": r.version, "at": rv.db_iso(r.decided_at),
                    "event_id": r.last_event_id,
                    "by": {"id": r.decided_by, "user": r.decided_by_user, "name": r.decided_by_name},
                    "contributors": (e.contributors if e is not None else None) or []}
    return out


def _release_dict(r: AnnotRelease) -> dict:
    return {"batch_id": r.batch_id, "version": r.version, "path": r.path, "n_blocks": r.n_blocks, "n_slices": r.n_slices,
            "blocks": r.blocks or [], "skipped": r.skipped or [], "manifest_sha256": r.manifest_sha256, "note": r.note,
            "created_by": r.created_by_name, "created_at": rv.db_iso(r.created_at)}


def _batch_members(s: Session, batch_id: str) -> list[dict]:
    if not batch_id or batch_id.startswith("."):
        raise _err(404, "no_batch", "批次名不对")
    infos = [x for x in _blocks(s) if x["batch_id"] == batch_id]
    if not infos:
        raise _err(404, "no_batch", f"没有叫 {batch_id} 的批次（批次 = 数据块所在的导入目录）")
    return infos


def _plan_batch(s: Session, infos: list[dict], *, detail: bool = False):
    """这一批每块这次收哪些片（不写任何东西、不整块读盘）。
    返回 (要收切片的块和各自的通过记录, 每块的预览, 不收的块和原因)。"""
    members, plans, skipped = [], {}, []
    for x in infos:
        bid = x["block_id"]
        if x.get("error"):
            skipped.append({"block_id": bid, "reason": "unreadable", "message": f"数据块打不开：{x['error']}"})
            continue
        try:
            b = _block(bid)
            # 两份编辑记录都要读得出来才收：取快照要读流水；预览（detail）和真正入库按同一个条件判断，不会一个收、一个不收
            b.audit_entries()
            b.edits()
            approved = _approved(s, b)
            plan = rv.preview_release(b, approved)
        except (ValueError, OSError, HTTPException) as e:
            msg = e.detail if isinstance(e, HTTPException) else str(e)
            skipped.append({"block_id": bid, "reason": "history", "message": f"编辑记录读不出来，请联系管理员：{msg}"})
            continue
        if detail:                                  # 只是给预览页看的明细：算不出来也不影响收不收
            try:
                rows = block_rows(s, b, None)["slices"]
                plan["not_approved"] = [{"z": r["z"], "reason": r["status"], "message": r["status_name"]} for r in rows if r["z"] not in approved]
            except (ValueError, OSError, HTTPException) as e:
                plan["not_approved"] = []
                plan["detail_error"] = f"读不出每片的状态：{e.detail if isinstance(e, HTTPException) else e}"
        plans[bid] = {"nz": b.nz, **plan}
        if plan["included"]:
            members.append((b, approved))
        else:
            skipped.append({"block_id": bid, "reason": "none_approved", "message": "没有可入库的切片（还没有已通过、且通过后没再改过的片）"})
    return members, plans, skipped


@router.get("/review/batches/{batch_id}/releases")
def list_releases(batch_id: str, s: Session = Depends(get_session)):
    rows = s.scalars(select(AnnotRelease).where(AnnotRelease.batch_id == batch_id).order_by(AnnotRelease.version.desc()))
    return {"releases": [_release_dict(r) for r in rows], "root": str(rv.releases_root(settings.annotate_workdir) / batch_id)}


@router.get("/review/batches/{batch_id}/releases/preview")
def preview_release(batch_id: str, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    """这一批这次入库会收哪些块的哪些片、不收哪些和原因（不写任何东西，不整块读盘）。只有能入库的人用得到，也就只给他们算。"""
    user = _human(user)
    _need_decider(s, user)
    infos = _batch_members(s, batch_id)
    with _heavy_slot():
        members, plans, skipped = _plan_batch(s, infos, detail=True)
    blocks = [{"block_id": bid, **p} for bid, p in plans.items()]
    return {"batch_id": batch_id, "blocks": blocks, "skipped": skipped, "ambiguous_dirs": _ambiguous(infos),
            "n_blocks": len(members), "n_slices": sum(len(p["included"]) for p in plans.values()),
            "expect_included": {b.id: plans[b.id]["included"] for b, _ in members}}


class ReleaseIn(BaseModel):
    model_config = {"extra": "forbid"}
    # 预览时看到的「每块收哪些片」：入库前内容又变了就 409
    expect_included: dict[str, list[int]] = Field(max_length=10_000)
    note: str | None = Field(default=None, max_length=2000)


_release_gate = threading.BoundedSemaphore(1)                         # 入库一次占一块大小的内存、要写整批文件：同一时间只做一个
_STALE = "可入库的切片和你预览时不一样了（有人又通过或修改了），请重新预览后再入库"


@router.post("/review/batches/{batch_id}/releases")
def create_release(batch_id: str, body: ReleaseIn, user: User | None = Depends(require_user), s: Session = Depends(get_session)):
    from emqc.annotate.store import hold_workdir

    user = _human(user)
    _need_decider(s, user)
    infos = _batch_members(s, batch_id)
    dirs = _ambiguous(infos)
    if dirs:
        raise _err(409, "ambiguous", f"有 {len(dirs)} 个导入目录都叫 {batch_id}，分不清是哪一批：{'；'.join(dirs)}。"
                   "请管理员把其中一个目录改名并重启服务，再入库")
    if settings.annotate_workdir is None:
        raise _err(422, "workdir", "没有配置标注工作目录（EMQC_ANNOTATE_WORKDIR），无法入库")
    try:
        hold_workdir(settings.annotate_workdir)            # 和写像素一样：先占住工作目录（同一时间只有一个服务进程在写）
    except ValueError as e:
        raise _err(409, "workdir", str(e))
    if not _release_gate.acquire(timeout=5):
        raise _err(429, "busy", "另一个入库正在进行，请等它完成后再试")
    try:
        expect = {k: sorted(set(v)) for k, v in body.expect_included.items() if v}
        with _heavy_slot():
            members, plans, skipped = _plan_batch(s, infos)
        if {b.id: plans[b.id]["included"] for b, _ in members} != expect:
            raise _err(409, "stale", _STALE)
        db_max = s.scalar(select(func.max(AnnotRelease.version)).where(AnnotRelease.batch_id == batch_id)) or 0

        def precommit() -> None:
            # 原子改名之前再核对一遍：写文件的这段时间里有人退回 / 撤销 / 重新通过了某一片，这次入库就作废。
            # 先对这些行做一次不改值的 UPDATE 拿到写锁（SQLite 上是整库写锁，MySQL 上是行锁），一直占到下面写完版本记录提交为止：
            # 核对之后到达的审核动作排在这次入库之后（SQLite 不认 FOR UPDATE，只靠它会漏掉核对后、提交前的那一下）
            for b, _a in members:
                s.execute(update(SliceReview).where(SliceReview.block_id == b.id, SliceReview.z.in_(expect[b.id]))
                          .values(version=SliceReview.version).execution_options(synchronize_session=False))
            for b, approved in members:
                zs = expect[b.id]
                rows = {r.z: r for r in s.scalars(select(SliceReview).where(SliceReview.block_id == b.id, SliceReview.z.in_(zs))
                                                  .with_for_update().execution_options(populate_existing=True))}
                for z in zs:
                    r, a = rows.get(z), approved[z]
                    if r is None or r.status != "approved" or r.approved_sha256 != a["sha"] or r.version != a["version"]:
                        raise rv.ReleaseStale(f"{b.id} 的 z {z} 的审核结论在入库途中被改了，这次入库没有生效，请重新预览")

        from emqc.logs import _git_commit

        try:
            res = rv.write_release(batch_id, settings.annotate_workdir, members, expect, skipped=skipped, created_by=_who(user),
                                   note=_clean(body.note), code_commit=_git_commit(), db_max_version=db_max, precommit=precommit)
        except rv.ReleaseStale as e:
            s.rollback()
            raise _err(409, "stale", str(e))
        except ValueError as e:
            s.rollback()
            raise _err(422, "release", str(e))
        except OSError as e:
            s.rollback()
            raise _err(500, "release", f"写入库文件失败（{e.strerror or e}），这次入库没有生效，请联系管理员")
        row = AnnotRelease(batch_id=batch_id, version=res["version"], path=res["path"], n_blocks=res["n_blocks"], n_slices=res["n_slices"],
                           blocks=res["blocks"], skipped=skipped, manifest_sha256=res["manifest_sha256"], note=_clean(body.note),
                           created_by=user.id, created_by_user=user.username, created_by_name=_who(user)["name"])
        try:
            s.add(row)
            s.commit()
        except Exception:
            s.rollback()
            moved = rv.set_aside(settings.annotate_workdir, res["path"])
            import logging

            logging.getLogger(__name__).exception("入库目录已生成但记录没写成，目录已挪到 %s", moved)
            raise _err(500, "release", "入库记录没写成，这次入库没有生效（生成的目录已挪开），请重试或联系管理员")
        return _release_dict(row)
    finally:
        _release_gate.release()
