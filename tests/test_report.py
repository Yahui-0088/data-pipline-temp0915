"""汇报账号与汇报页：只能看汇报页、只能看分配给它的项目、样例图也按项目隔离；管理员能建 / 改汇报账号。"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from emqc import auth
from emqc.db import init_db, session_scope
from emqc.db.models import AccountEvent, AppSetting, AuthSession, Dataset, QCFinding, User

PW = "correct-horse-8"


@pytest.fixture
def app(monkeypatch, registered, qc_run):
    from emqc.api.app import app as fastapi_app
    from emqc.config import settings

    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "auth_open", False)
    init_db()
    with session_scope() as s:
        for t in (AuthSession, User, AccountEvent, AppSetting):
            s.execute(delete(t))
    auth._FAILS.clear()
    yield fastapi_app
    auth._FAILS.clear()


def _project(ds_id):
    with session_scope() as s:
        return s.get(Dataset, ds_id).project


def _user(name, role, projects=None):
    with session_scope() as s:
        auth.create_user(s, name, PW, None, role, projects=projects)


def _login(c, name):
    assert c.post("/api/v1/auth/login", json={"username": name, "password": PW}).status_code == 200


def test_reporter_only_sees_report_of_its_projects(app, registered):
    proj = _project(registered)
    _user("boss", "reporter", [proj])
    _user("outsider", "reporter", ["no-such-project"])
    with TestClient(app) as c:
        _login(c, "boss")
        # every other page goes back to the report, every other API is forbidden
        for page in ("/", "/overview", "/pipeline", f"/datasets/{registered}", "/training", "/annotate"):
            r = c.get(page, follow_redirects=False)
            assert r.status_code == 303 and r.headers["location"] == "/report", page
        for api in (f"/api/v1/datasets/{registered}", "/api/v1/pipeline/dashboard", "/api/v1/qc/runs", "/api/v1/exports"):
            assert c.get(api).status_code == 403, api
        assert c.post("/api/v1/qc/runs", json={"dataset_id": registered}).status_code == 403
        page = c.get("/report")
        assert page.status_code == 200 and "导出 PDF" in page.text and "/pipeline" not in page.text   # 没有通往平台其他页面的链接
        d = c.get("/api/v1/report/data").json()
        assert d["limited"] and d["projects"] == [proj]
        assert [x["dataset_id"] for x in d["datasets"]] == [registered]
        assert d["kpi"]["n_sections"] > 0 and len(d["trend"]) == 8
        assert c.get("/api/v1/report/data", params={"project": "someone-else"}).status_code == 403
        shots = [s for e in d["examples"] for s in e["shots"]]
        if shots:
            r = c.get(shots[0]["thumb"])
            assert r.status_code == 200 and r.headers["content-type"].startswith("image/")
        r = c.get("/previews/anything.png", follow_redirects=False)
        assert r.status_code in (303, 403) and r.headers.get("location", "/report") == "/report"   # 预览目录整个碰不到
    with TestClient(app) as c:
        _login(c, "outsider")
        d = c.get("/api/v1/report/data").json()
        assert d["datasets"] == [] and d["kpi"]["n_sections"] == 0
        with session_scope() as s:
            fid = s.scalar(select(QCFinding.id).where(QCFinding.dataset_id == registered, QCFinding.preview_path.is_not(None)))
        if fid:
            assert c.get(f"/api/v1/report/thumb/{fid}").status_code == 404     # 别的项目的图：当它不存在


def test_admin_manages_reporters_and_sees_everything(app, registered):
    _user("root", "admin")
    with TestClient(app) as c:
        _login(c, "root")
        assert c.post("/api/v1/auth/users", json={"username": "boss2", "role": "reporter"}).status_code == 422   # 必须给项目
        r = c.post("/api/v1/auth/users", json={"username": "boss2", "role": "reporter", "projects": ["a", " b ", "a"]}).json()
        assert r["user"]["projects"] == ["a", "b"] and r["temp_password"]
        uid = r["user"]["id"]
        assert c.patch(f"/api/v1/auth/users/{uid}", json={"projects": []}).status_code == 422
        assert c.patch(f"/api/v1/auth/users/{uid}", json={"projects": ["c"]}).json()["user"]["projects"] == ["c"]
        bulk = c.post("/api/v1/auth/users/bulk", json={"text": "boss3, 老板, 汇报"}).json()
        assert bulk["n_ok"] == 0 and "项目" in bulk["results"][0]["error"]
        d = c.get("/api/v1/report/data").json()
        assert not d["limited"] and registered in [x["dataset_id"] for x in d["datasets"]]
        assert c.get("/overview").status_code == 200 and 'href="/report"' in c.get("/overview").text


def test_cli_creates_reporter(app, capsys):
    from emqc.cli import main

    import io
    import sys

    sys.stdin = io.StringIO(PW + "\n")
    try:
        assert main(["create-user", "--username", "boss4", "--role", "reporter", "--projects", "x,y", "--password-stdin"]) == 0
    finally:
        sys.stdin = sys.__stdin__
    assert "可看项目 x, y" in capsys.readouterr().out
    with session_scope() as s:
        assert s.scalar(select(User).where(User.username == "boss4")).projects == ["x", "y"]
