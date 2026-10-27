"""问题切片上的人工判断（确认 / 误报）：误报让切片按通过算，可用比例、导出预览跟着变；撤销后完全还原。
以及总览页围绕「哪一次运行」：流程图角标、问题墙分步骤、?run= 切换。"""
import json
import re

from fastapi.testclient import TestClient
from sqlalchemy import select


def _failing_slice(rid):
    """这次运行里一片没通过、读得出、身上 high / critical 问题的切片：返回 (block_id, z, 这些问题的类型)。"""
    from emqc.db import session_scope
    from emqc.db.models import QCFinding, QCSlice

    with session_scope() as s:
        for sl in s.scalars(select(QCSlice).where(QCSlice.run_id == rid, QCSlice.passed.is_(False), QCSlice.status == "ok")):
            types = {t for t, sev in s.execute(select(QCFinding.failure_type, QCFinding.severity).where(
                QCFinding.run_id == rid, QCFinding.block_id == sl.block_id, QCFinding.z == sl.z)).all() if sev in ("high", "critical")}
            if types:
                return sl.block_id, sl.z, sorted(types)
    return None


def test_false_positive_clears_slice_and_undo_restores(registered, qc_run):
    from emqc.api.app import app
    from emqc.db import session_scope
    from emqc.db.models import FindingVerdict, QCRun, QCSlice

    from emqc.db.models import Dataset

    with session_scope() as s:   # 导出预览按数据集最新一次运行算：别的测试可能又跑过一次，用最新那次
        rid = s.get(Dataset, registered).latest_run_id
    c = TestClient(app)
    found = _failing_slice(rid)
    assert found, "测试数据里应该有没通过的切片"
    bid, z, types = found
    with session_scope() as s:
        ret0 = s.get(QCRun, rid).retention_rate
    keep0 = c.get("/api/v1/exports/preview", params={"dataset_id": registered}).json()["n_keep"]
    url = f"/api/v1/qc/runs/{rid}/verdicts"

    # 确认是问题：什么都不变
    r = c.post(url, json={"block_id": bid, "z": z, "failure_type": types[0], "verdict": "confirmed"}).json()
    assert r["slice_passed"] is False and r["run_retention"] == ret0 and set(r["kpi"]) >= {"retention", "n_problems"}
    # 只把一部分标成误报：还有别的 high 问题时仍不通过
    for i, t in enumerate(types):
        r = c.post(url, json={"block_id": bid, "z": z, "failure_type": t, "verdict": "false_positive"}).json()
        assert r["slice_passed"] is (i == len(types) - 1)
    assert r["run_retention"] > ret0 and "step_counts" in r
    keep1 = c.get("/api/v1/exports/preview", params={"dataset_id": registered}).json()["n_keep"]
    assert keep1 == keep0 + 1                       # 导出按改过的结果算，多了这一张

    # 撤销全部：切片和运行回到原来的结果，判断记录清空
    for t in types:
        c.post(url, json={"block_id": bid, "z": z, "failure_type": t, "verdict": None})
    with session_scope() as s:
        assert s.get(QCRun, rid).retention_rate == ret0
        assert s.scalars(select(QCSlice).where(QCSlice.run_id == rid, QCSlice.block_id == bid, QCSlice.z == z)).one().passed is False
        assert not s.scalars(select(FindingVerdict).where(FindingVerdict.run_id == rid)).all()
    assert c.get("/api/v1/exports/preview", params={"dataset_id": registered}).json()["n_keep"] == keep0

    assert c.post(url, json={"block_id": bid, "z": z, "failure_type": "no_such_type", "verdict": "confirmed"}).status_code == 404
    assert c.post(url, json={"block_id": bid, "z": z, "failure_type": types[0], "verdict": "maybe"}).status_code == 422
    assert c.post("/api/v1/qc/runs/999999/verdicts", json={"block_id": bid, "z": z, "failure_type": types[0], "verdict": "confirmed"}).status_code == 404


def test_overview_is_built_around_one_run(registered, qc_run):
    from emqc.api.app import app

    rid = qc_run
    c = TestClient(app)
    html = c.get(f"/overview?run={rid}").text
    badges = json.loads(re.search(r'id="ov-badges">(.*?)</script>', html).group(1))
    assert {"slice_qc", "serial_qc"} <= set(badges)
    wall = json.loads(re.search(r'id="ov-wall-data">(.*?)</script>', html, re.S).group(1))
    assert wall and all(row["step"] in ("slice_qc", "serial_qc") for row in wall)
    assert all(it["run_id"] == rid and it["z"] is not None and it["block_id"] for row in wall for it in row["items"])
    assert 'id="ov-wall-filter"' in html and f'data-sel="{rid}"' in html and 'data-kpi="retention"' in html
    # 找不到的运行：回到最新一次
    assert 'data-sel=""' not in c.get("/overview?run=987654").text
