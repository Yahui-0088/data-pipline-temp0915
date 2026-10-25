"""登录、账号管理接口，以及给别的路由用的"当前用户"依赖。

Cookie 里是随机会话令牌（HttpOnly、SameSite=Lax），库里只存哈希；每个请求最多查一次库（结果记在 request.state）。
开着 EMQC_AUTH_DISABLED 时所有依赖都返回 None，路由按"没有账号"的老方式工作。
"""
from __future__ import annotations

import hmac
import logging
import threading
import time
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from emqc import auth
from emqc.auth import COOKIE, ROLES, user_dict
from emqc.config import settings
from emqc.db.base import get_session, session_scope
from emqc.db.models import AccountEvent, User

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def client_ip(request: Request) -> str:
    """请求来自哪个 IP。只认 TCP 连接的对端：前面没有反向代理，客户端自己填的 X-Forwarded-For 一律不信
    （信了的话登录限流、日志里的 IP 都能随便伪造）。以后前面加了反代，再在这里按反代的地址放行。"""
    return request.client.host if request.client else ""


def _throttle_keys(username: str, ip: str) -> tuple[str, ...]:
    """登录失败按登录名计，也按来源 IP 计。经 SSH 隧道进来的人来源都是 127.0.0.1——按它计的话一个人输错几次，
    所有人都要等一分钟，所以本机地址不参与按 IP 计数。"""
    keys = [f"u:{username.strip().lower()}"]
    if ip and ip not in ("127.0.0.1", "::1", "localhost"):
        keys.append(f"ip:{ip}")
    return tuple(keys)


# ---------------------------------------------------------------- 依赖
# 数据库短暂连不上（重启、卡住）时，最近验过的登录还能用一会：标注写的是文件，不该因为验不了登录就全部失败。
# 只在查库报错时才用；账号被停用、会话被踢，查库正常时立刻生效。
_SESSION_GRACE_S = 600
_recent_sessions: dict[str, tuple[User, float]] = {}
_recent_lock = threading.Lock()
_log = logging.getLogger("emqc.auth")


def current_user(request: Request) -> User | None:
    """Cookie → 用户；没登录是 None。一个请求里只查一次。"""
    if settings.auth_disabled:
        return None
    if getattr(request.state, "user_checked", False):
        return getattr(request.state, "user", None)
    request.state.user_checked = True
    request.state.user = None
    token = request.cookies.get(COOKIE)
    if token:
        from sqlalchemy.exc import SQLAlchemyError

        key = auth._token_hash(token) if len(token) <= 128 else None
        try:
            with session_scope() as s:
                request.state.user = auth.resolve_session(s, token)
        except SQLAlchemyError:
            hit = _recent_sessions.get(key) if key else None
            if hit is None or time.monotonic() - hit[1] > _SESSION_GRACE_S:
                raise
            _log.warning("数据库连不上，沿用 %s 最近一次验过的登录", hit[0].username)
            request.state.user = hit[0]
        else:
            if key:
                with _recent_lock:
                    if request.state.user is not None:
                        _recent_sessions[key] = (request.state.user, time.monotonic())
                        if len(_recent_sessions) > 2000:
                            for k in sorted(_recent_sessions, key=lambda k: _recent_sessions[k][1])[:1000]:
                                _recent_sessions.pop(k, None)
                    else:
                        _recent_sessions.pop(key, None)
        request.state.username = request.state.user.username if request.state.user is not None else None   # 给请求日志用，不再碰 ORM 对象
    return request.state.user


def forget_sessions() -> None:
    """登出、踢人、停用、改密码之后调用：宽限缓存里的旧登录一并作废。"""
    with _recent_lock:
        _recent_sessions.clear()


# ---------------------------------------------------------------- 全站登录关卡
# 不登录就能打开的只有这些：登录页和它要用的静态文件、登录 / 登录状态接口、探活，以及前端报错上报（登录页自己也会出错）。
# 其余所有页面和接口——包括数据清洗工作区、数据下载、QC 结果图——都要先登录。
PUBLIC_PATHS = frozenset({"/login", "/favicon.ico", "/api/v1/auth/login", "/api/v1/auth/status", "/api/v1/auth/logout",
                          "/api/v1/auth/me", "/api/v1/health", "/api/v1/logs/client"})
PUBLIC_PREFIXES = ("/static/",)
ROLE_RANK = {"reporter": -1, "annotator": 0, "reviewer": 1, "admin": 2}
SERVICE_NAME = "service-token"


def service_token_ok(request: Request) -> bool:
    """训练 / 推理脚本（emqc.loader）不走浏览器登录：请求头 X-EMQC-Token 带上服务器配置的 EMQC_API_TOKEN。
    没配令牌时这条路是关着的。令牌只能读数据、跑任务（相当于审核员），不能改标注、不能删东西、不能管账号。"""
    want = (settings.api_token or "").strip()
    if not want:
        return False
    got = request.headers.get("x-emqc-token", "")
    if not got:
        authz = request.headers.get("authorization", "")
        got = authz[7:].strip() if authz.lower().startswith("bearer ") else ""
    return bool(got) and hmac.compare_digest(got.encode(), want.encode())


def gate(request: Request) -> Response | None:
    """全站登录关卡（在 app.py 的中间件里跑，所以也管到 /previews 这类静态目录）。放行返回 None，否则返回要回给浏览器的响应。"""
    if settings.auth_disabled:
        return None
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
        return None
    api = path.startswith("/api/") or path == "/openapi.json"
    if service_token_ok(request):
        request.state.service = True
        request.state.username = SERVICE_NAME
        return None
    user = current_user(request)
    if user is None:
        if api or request.method not in ("GET", "HEAD"):
            return JSONResponse({"detail": {"code": "auth", "message": "请先登录"}}, status_code=401)
        nxt = path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(nxt, safe='')}", status_code=303)
    if user.must_change_password:
        if api and not path.startswith("/api/v1/auth/"):
            return JSONResponse({"detail": {"code": "password", "message": "请先修改初始密码（右上角「账号」）"}}, status_code=403)
        if not api and path != "/account":
            return RedirectResponse("/account?force=1", status_code=303)
    if user.role == "reporter" and not _reporter_may(path):
        # 汇报账号只能看汇报页：其他页面送回汇报页，其他接口一律 403（数据、预览图、下载都在这里挡住）
        if api or request.method not in ("GET", "HEAD"):
            return JSONResponse({"detail": {"code": "forbidden", "message": "汇报账号只能查看汇报页"}}, status_code=403)
        return RedirectResponse("/report", status_code=303)
    return None


REPORTER_PATHS = frozenset({"/report", "/account"})
REPORTER_PREFIXES = ("/report/", "/api/v1/report/", "/api/v1/auth/")


def _reporter_may(path: str) -> bool:
    return path in REPORTER_PATHS or path.startswith(REPORTER_PREFIXES)


def require_role(role: str):
    """接口依赖：至少是这个角色（管理员 > 审核员 > 标注员）。服务令牌算审核员。没开登录时不拦。"""
    need = ROLE_RANK[role]
    label = auth.ROLE_NAMES[role]

    def dep(request: Request) -> User | None:
        if settings.auth_disabled:
            return None
        if getattr(request.state, "service", False) or service_token_ok(request):
            if need <= ROLE_RANK["reviewer"]:
                return None
            raise HTTPException(403, {"code": "forbidden", "message": f"服务令牌不能做这件事，要{label}登录后操作"})
        user = require_user(request)
        if ROLE_RANK.get(user.role, -1) < need:
            raise HTTPException(403, {"code": "forbidden", "message": f"要{label}{'或管理员' if role == 'reviewer' else ''}才能做这件事"})
        return user

    return dep


require_reviewer = require_role("reviewer")
require_admin_role = require_role("admin")


def require_user(request: Request) -> User | None:
    """接口用：没登录 401。拿着初始密码还没改的，除了改密码什么都不能做。开着 AUTH_DISABLED 时返回 None（不拦）。"""
    if settings.auth_disabled:
        return None
    user = current_user(request)
    if user is None:
        raise HTTPException(401, {"code": "auth", "message": "请先登录"})
    if user.must_change_password and not request.url.path.startswith("/api/v1/auth/"):
        raise HTTPException(403, {"code": "password", "message": "请先修改初始密码（右上角「账号」）"})
    return user


def require_admin(request: Request) -> User | None:
    user = require_user(request)
    if user is not None and user.role != "admin":
        raise HTTPException(403, {"code": "forbidden", "message": "只有管理员能管理账号"})
    return user


def page_user(request: Request) -> User | None:
    """HTML 页面用：没登录跳到登录页并记住要回哪里；拿着初始密码的先去改密码。"""
    if settings.auth_disabled:
        return None
    user = current_user(request)
    if user is None:
        nxt = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        raise HTTPException(303, headers={"Location": f"/login?next={quote(nxt, safe='')}"})
    if user.must_change_password and request.url.path != "/account":
        raise HTTPException(303, headers={"Location": "/account?force=1"})
    return user


def safe_next(target: str | None) -> str:
    """登录后跳回的地址只允许本站路径：防开放重定向。"""
    t = target or ""
    return t if t.startswith("/") and not t.startswith("//") and "\\" not in t else "/annotate"


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE, token, max_age=settings.session_days * 86400, httponly=True, samesite="lax",
                        secure=settings.cookie_secure, path="/")


# ---------------------------------------------------------------- 登录 / 登出 / 我是谁 / 改密码
class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(default="", max_length=256)     # 试用模式下可以为空


@router.get("/status")
def status(s: Session = Depends(get_session)):
    """登录页用：这个实例开了登录没有、是不是试用模式、有没有任何账号（一个都没有就提示先用命令行建管理员）。"""
    if settings.auth_disabled:
        return {"auth_disabled": True, "auth_open": False, "has_users": None}
    return {"auth_disabled": False, "auth_open": auth.login_mode(s) == "open", "has_users": auth.count_users(s) > 0}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, s: Session = Depends(get_session)):
    if settings.auth_disabled:
        raise HTTPException(409, {"code": "disabled", "message": "这个实例没有开启登录（EMQC_AUTH_DISABLED=1），直接打开工作台即可"})
    ip = client_ip(request)
    existing = auth.find_user(s, body.username)
    if auth.login_mode(s) == "open" and (existing is None or not auth.has_password(existing)):
        # 试用模式：没有真正密码的账号不看密码，账号不存在就建；只有停用的账号进不来
        if existing is None:
            wait = auth.new_account_throttled()
            if wait:
                raise HTTPException(429, {"code": "throttled", "message": f"最近自动建的账号太多了，请 {wait} 秒后再试，或请管理员直接建号"})
        user = auth.open_login(s, body.username)
        if user is None:
            auth.record_event(s, "login_failed", target=existing, target_name=None if existing else body.username[:64],
                              detail="账号已停用" if existing else "名字是空的", ip=ip)
            s.commit()
            raise HTTPException(401, {"code": "bad_login", "message": "这个账号已停用，或者名字是空的"})
    else:
        keys = _throttle_keys(body.username, ip)
        wait = auth.throttled(*keys)
        if wait:
            raise HTTPException(429, {"code": "throttled", "message": f"尝试太频繁，请 {wait} 秒后再试"})
        user = auth.authenticate(s, body.username, body.password) if body.password else None
        if user is None:
            auth.note_failure(*keys)
            auth.record_event(s, "login_failed", target=existing, target_name=None if existing else body.username[:64],
                              detail="没填密码" if not body.password else "密码不对或账号不可用", ip=ip)
            s.commit()
            if existing is not None and not body.password and auth.login_mode(s) == "open":
                raise HTTPException(401, {"code": "need_password", "message": "这个账号设了密码，请输入密码"})
            raise HTTPException(401, {"code": "bad_login", "message": "登录名或密码不对"})
        auth.clear_failures(*keys)
    created = existing is None
    token = auth.open_session(s, user, request.headers.get("user-agent", ""), ip)
    auth.record_event(s, "login", actor=user, target=user, ip=ip)
    s.commit()
    if created:
        auth.note_new_account()
    auth.purge_expired_sessions_best_effort()     # 另开一个小事务：清理失败不能让这次登录失败
    _set_cookie(response, token)
    return {"user": user_dict(user)}


@router.post("/logout")
def logout(request: Request, response: Response, s: Session = Depends(get_session)):
    user = current_user(request)
    auth.revoke_session(s, request.cookies.get(COOKIE))
    if user is not None:
        auth.record_event(s, "logout", actor=user, target=user, ip=client_ip(request))
    s.commit()
    forget_sessions()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    if settings.auth_disabled:
        return {"user": None, "auth_disabled": True}
    user = current_user(request)
    if user is None:
        raise HTTPException(401, {"code": "auth", "message": "请先登录"})
    return {"user": user_dict(user), "auth_disabled": False}


class PasswordIn(BaseModel):
    old_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


@router.post("/password")
def change_password(body: PasswordIn, request: Request, s: Session = Depends(get_session)):
    user = require_user(request)
    if user is None:
        raise HTTPException(409, {"code": "disabled", "message": "这个实例没有开启登录"})
    u = s.get(User, user.id)
    if u is None or not auth.verify_password(body.old_password, u.password_hash):
        raise HTTPException(422, "原密码不对")
    if body.new_password == body.old_password:
        raise HTTPException(422, "新密码不能和原密码一样")
    try:
        auth.set_password(s, u, body.new_password, keep_session=request.cookies.get(COOKIE))
    except ValueError as e:
        raise HTTPException(422, str(e))
    auth.record_event(s, "change_password", actor=u, target=u, ip=client_ip(request))
    s.commit()
    forget_sessions()
    return {"ok": True, "user": user_dict(u)}


# ---------------------------------------------------------------- 管理员：账号管理
class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)            # 合规的登录名，或中文名（登录名由它生成，见 auth.username_for）
    display_name: str | None = Field(default=None, max_length=64)
    role: str = Field(default="annotator", pattern="^(admin|reviewer|annotator|reporter)$")
    password: str | None = Field(default=None, max_length=256)     # 不给就生成初始密码，首次登录必须改
    projects: list[str] | None = None                               # 汇报账号能看的项目（role=reporter 时必填）


class BulkIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)              # 一行一个：登录名或名字[,显示名[,角色]]
    role: str = Field(default="annotator", pattern="^(admin|reviewer|annotator|reporter)$")


class UserPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=64)
    role: str | None = Field(default=None, pattern="^(admin|reviewer|annotator|reporter)$")
    is_active: bool | None = None
    projects: list[str] | None = None


class ModeIn(BaseModel):
    mode: str = Field(pattern="^(open|password)$")


def _active_admins(s: Session) -> int:
    return len(list(s.scalars(select(User.id).where(User.role == "admin", User.is_active.is_(True)))))


def _new_user(s: Session, admin: User | None, typed: str, display: str | None, role: str, password: str | None, projects: list[str] | None = None):
    """填的是英文就必须是合规的登录名（打错了要报出来，不能悄悄换成别的）；填中文名则登录名由名字生成，本人填名字就能登录。"""
    typed = " ".join((typed or "").split())
    if typed.isascii():
        username, fallback = auth.normalize_username(typed), typed
    else:
        username, fallback = auth.username_for(typed)
    return auth.create_user(s, username, password, display or fallback, role, created_by=admin.id if admin else None, projects=projects)


@router.get("/users")
def list_users(admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    live: dict[int, int] = {}
    for sess in s.scalars(select(auth.AuthSession).where(auth.AuthSession.expires_at > now)):
        live[sess.user_id] = live.get(sess.user_id, 0) + 1
    users = []
    for u in s.scalars(select(User).order_by(User.id)):
        d = user_dict(u)
        d["n_sessions"] = live.get(u.id, 0)
        users.append(d)
    return {"users": users, "roles": list(ROLES), "login_mode": auth.login_mode(s), "login_modes": auth.LOGIN_MODES}


@router.post("/users")
def create_user(body: UserIn, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    try:
        u, issued = _new_user(s, admin, body.username, body.display_name, body.role, body.password, body.projects)
    except ValueError as e:
        raise HTTPException(422, str(e))
    auth.record_event(s, "create", actor=admin, target=u, detail=f"角色 {auth.ROLE_NAMES[u.role]}" + (f" · 项目 {', '.join(u.projects)}" if u.projects else ""), ip=client_ip(request))
    s.commit()
    return {"user": user_dict(u), "temp_password": issued}


@router.post("/users/bulk")
def bulk_create(body: BulkIn, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    """一次建一批：每行「登录名或名字[,显示名[,角色]]」，逗号或 Tab 分隔，角色可写中文。每个人各发一个初始密码（只返回这一次）。
    某一行出错不影响其他行。"""
    names = {v: k for k, v in auth.ROLE_NAMES.items()}
    results = []
    for n, raw in enumerate(body.text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [x.strip() for x in line.replace("\t", ",").replace("，", ",").split(",")]
        typed, display = parts[0], (parts[1] if len(parts) > 1 and parts[1] else None)
        role = parts[2] if len(parts) > 2 and parts[2] else body.role
        role = names.get(role, role)
        try:
            if role not in ROLES:
                raise ValueError(f"角色「{parts[2]}」不认识，只能是管理员 / 审核员 / 标注员 / 汇报")
            if role == "reporter":
                raise ValueError("汇报账号要指定项目，请在上面单个创建")
            u, issued = _new_user(s, admin, typed, display, role, None)
            auth.record_event(s, "create", actor=admin, target=u, detail=f"批量 · 角色 {auth.ROLE_NAMES[u.role]}", ip=client_ip(request))
            results.append({"line": n, "ok": True, "user": user_dict(u), "temp_password": issued})
        except ValueError as e:
            results.append({"line": n, "ok": False, "input": line[:100], "error": str(e)})
    s.commit()
    return {"results": results, "n_ok": sum(r["ok"] for r in results)}


@router.patch("/users/{uid}")
def patch_user(uid: int, body: UserPatch, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    u = s.get(User, uid)
    if u is None:
        raise HTTPException(404, "没有这个账号")
    demoting = body.role is not None and body.role != "admin"
    deactivating = body.is_active is False
    if u.role == "admin" and u.is_active and (demoting or deactivating) and _active_admins(s) <= 1:
        raise HTTPException(422, "至少要保留一个可用的管理员")
    if admin is not None and u.id == admin.id and (demoting or deactivating):
        raise HTTPException(422, "不能停用或降级自己，请让另一位管理员操作")
    changes, issued = [], None
    if body.display_name is not None:
        try:
            name = auth.clean_display_name(body.display_name, u.username)
        except ValueError as e:
            raise HTTPException(422, str(e))
        if name != u.display_name:
            changes.append(f"显示名 {u.display_name} → {name}")
            u.display_name = name
    new_role = body.role if body.role is not None else u.role
    if body.projects is not None or (body.role == "reporter" and u.role != "reporter"):
        projects = auth.clean_projects(body.projects if body.projects is not None else u.projects)
        if new_role == "reporter" and not projects:
            raise HTTPException(422, "汇报账号要指定能看哪些项目")
        if projects != list(u.projects or []):
            changes.append(f"可看项目 {', '.join(u.projects or []) or '–'} → {', '.join(projects) or '–'}")
            u.projects = projects
    if body.role is not None and body.role != u.role:
        changes.append(f"角色 {auth.ROLE_NAMES[u.role]} → {auth.ROLE_NAMES[body.role]}")
        u.role = body.role
        if body.role == "admin" and not auth.has_password(u):
            # 管理员必须有密码（试用模式下也要校验）：从试用账号升上来的，顺手发一个初始密码
            issued = auth.temp_password()
            auth.set_password(s, u, issued, must_change=True)
            changes.append("发了初始密码")
    if body.is_active is not None and body.is_active != u.is_active:
        changes.append("启用" if body.is_active else "停用")
        u.is_active = body.is_active
        if not body.is_active:
            auth.revoke_user_sessions(s, u.id)         # 停用立刻生效，不等会话过期
    if changes:
        auth.record_event(s, "update", actor=admin, target=u, detail="；".join(changes), ip=client_ip(request))
    s.commit()
    forget_sessions()               # 停用、改角色立刻生效，数据库连不上时的宽限缓存也不再认旧的
    return {"user": user_dict(u), "temp_password": issued}


@router.post("/users/{uid}/reset-password")
def reset_password(uid: int, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    u = s.get(User, uid)
    if u is None:
        raise HTTPException(404, "没有这个账号")
    temp = auth.temp_password()
    auth.set_password(s, u, temp, must_change=True)
    auth.record_event(s, "reset_password", actor=admin, target=u, ip=client_ip(request))
    s.commit()
    forget_sessions()
    return {"user": user_dict(u), "temp_password": temp}


@router.post("/users/{uid}/revoke-sessions")
def revoke_sessions(uid: int, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    """强制下线：这个人所有浏览器里的登录立刻作废（账号本身不动，重新登录就行）。"""
    u = s.get(User, uid)
    if u is None:
        raise HTTPException(404, "没有这个账号")
    keep = request.cookies.get(COOKIE) if admin is not None and u.id == admin.id else None
    n = auth.revoke_user_sessions(s, u.id, keep=keep)
    auth.record_event(s, "revoke", actor=admin, target=u, detail=f"{n} 个登录", ip=client_ip(request))
    s.commit()
    forget_sessions()
    return {"user": user_dict(u), "n_revoked": n}


@router.post("/users/issue-passwords")
def issue_passwords(request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    """给所有还没有真正密码的可用账号（试用模式自动建的）各发一个初始密码——切到「正式」登录方式之前用。只返回这一次。"""
    out = []
    for u in s.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)):
        if auth.has_password(u):
            continue
        temp = auth.temp_password()
        auth.set_password(s, u, temp, must_change=True)
        auth.record_event(s, "reset_password", actor=admin, target=u, detail="批量发初始密码", ip=client_ip(request))
        out.append({"user": user_dict(u), "temp_password": temp})
    s.commit()
    return {"results": out}


@router.get("/login-mode")
def get_login_mode(admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    n_nopw = sum(1 for u in s.scalars(select(User).where(User.is_active.is_(True))) if not auth.has_password(u))
    return {"mode": auth.login_mode(s), "modes": auth.LOGIN_MODES, "env_default": "open" if settings.auth_open else "password",
            "n_without_password": n_nopw, "open_role": settings.auth_open_role}


@router.put("/login-mode")
def put_login_mode(body: ModeIn, request: Request, admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    before = auth.login_mode(s)
    auth.set_login_mode(s, body.mode, admin)
    if before != body.mode:
        auth.record_event(s, "login_mode", actor=admin, detail=f"{before} → {body.mode}", ip=client_ip(request))
    s.commit()
    return get_login_mode(admin, s)


@router.get("/events")
def account_events(limit: int = 200, user_id: int | None = None, action: str | None = None,
                   admin: User | None = Depends(require_admin), s: Session = Depends(get_session)):
    """账号操作记录，新的在前。可以按人（actor 或 target 是他）、按动作筛。"""
    q = select(AccountEvent).order_by(AccountEvent.id.desc()).limit(max(1, min(limit, 1000)))
    if user_id is not None:
        q = q.where((AccountEvent.actor_id == user_id) | (AccountEvent.target_id == user_id))
    if action:
        q = q.where(AccountEvent.action == action)
    return {"events": [auth.event_dict(e) for e in s.scalars(q)], "actions": auth.ACTIONS}
