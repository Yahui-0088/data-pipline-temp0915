"""导出预览：和真实导出的决定完全一致，剔除原因分得清。"""
from types import SimpleNamespace as NS

from fastapi.testclient import TestClient

from emqc.qc.export import plan_block


def _r(passed=True, q=0.9, status="ok"):
    return NS(passed=passed, quality_score=q, status=status, max_severity="none" if passed else "high", failure_types=[] if passed else ["blur"])


def test_plan_block_codes_and_shards():
    rows = {z: _r() for z in range(0, 20)}
    rows[3] = _r(passed=False)                 # splits off a 3-long run (0..2): too short for min_run 4
    rows[10] = _r(q=0.5)                       # passes QC, below min_quality
    del rows[19]                               # no QC record
    pl = plan_block(rows, 0, 20, {"min_run": 4, "shard_z": 4, "min_quality": 0.8})
    assert pl["codes"] == "SSSQ" + "K" * 6 + "L" + "K" * 8 + "M"
    assert pl["shards"] == [(4, 8), (8, 10), (11, 15), (15, 19)]
    assert sorted(x["z"] for x in pl["excluded"]) == [3, 10]   # the manifest keeps listing only QC / quality exclusions


def test_preview_matches_the_real_export(registered, qc_run, tmp_path, monkeypatch):
    from emqc.api.app import app
    from emqc.config import settings

    monkeypatch.setattr(settings, "export_dir", tmp_path)
    c = TestClient(app)
    params = {"dataset_id": registered, "min_run": 3, "shard_z": 5}
    pv = c.get("/api/v1/exports/preview", params=params).json()
    job = c.post("/api/v1/exports", json={**params, "sync": True}).json()
    assert job["status"] == "done"
    assert pv["n_keep"] == job["n_sections"] and pv["n_shards"] == job["n_shards"]
    man = c.get(f"/api/v1/exports/{job['job_id']}/manifest").json()
    shards = sorted((x["block_id"], x["z_start"], x["z_end"]) for x in man["shards"])
    assert shards == sorted((b["block_id"], z0, z1) for b in pv["blocks"] for z0, z1 in b["shards"])
    reasons = {r["code"]: r["n"] for r in pv["reasons"]}
    assert sum(reasons.values()) == pv["n_sections"] == 40 and reasons["K"] == pv["n_keep"]
    assert c.get("/api/v1/exports/preview", params={"dataset_id": "nope"}).status_code == 404
