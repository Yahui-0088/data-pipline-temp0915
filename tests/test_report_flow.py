"""汇报落地页（/report）：数据流程图 + 操作台。数据都来自 /api/v1/report/flow，按账号的项目范围过滤。"""
from fastapi.testclient import TestClient


def test_flow_page_and_data(registered, qc_run):
    from emqc.api.app import app

    c = TestClient(app)
    page = c.get("/report")
    assert page.status_code == 200 and "DATA GALAXY" in page.text and "/static/report-flow/flow.js" in page.text
    assert 'id="rf-prev"' in page.text and "上一节点" in page.text and 'id="rf-next"' in page.text and "下一节点" in page.text
    assert 'data-can-act="true"' in page.text                          # 没开登录：当管理员看，操作台里有按钮
    for f in ("flow.js", "flow.css", "em_block.png", "stack_block.png"):
        assert c.get(f"/static/report-flow/{f}").status_code == 200, f
    d = c.get("/api/v1/report/flow").json()
    L = d["latest"]
    assert L and L["n_slices"] == L["n_passed"] + L["n_failed"] and L["n_slices"] > 0
    assert 0 <= L["retention"] <= 1 and sum(L["grades"].values()) > 0
    assert all(f["step"] in ("slice_qc", "serial_qc") for f in L["failures"])
    assert len(d["checks"]) >= 10 and d["n_runs"] >= 1 and d["runs"][0]["run_id"] == max(r["run_id"] for r in d["runs"])
    assert d["plan"] and ("cells" in d["plan"] or "error" in d["plan"])
    assert d["crawl"]["presets"] and all(k in d["delivery"] for k in ("n_shard_jobs", "n_packs", "n_streams"))
    assert c.get("/api/v1/report/active").json() == {"runs": []}


def test_issue_albums_and_zip(registered, qc_run):
    """问题图片：相册数据按类别分组；导出的 zip 每类一个文件夹，张数和相册的条数对得上。"""
    import io
    import zipfile

    from emqc.api.app import app

    c = TestClient(app)
    albums = c.get("/api/v1/report/flow").json()["albums"]
    r = c.get("/api/v1/report/issues.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert all(n.startswith("问题图片/") for n in names)
    if albums:
        folders = {n.split("/")[1] for n in names}
        assert len(folders) == len(albums)
        for a in albums:
            got = [n for n in names if n.split("/")[1].endswith("_" + a["type"])]
            assert len(got) == a["n"] and len(a["shots"]) <= a["n"]
