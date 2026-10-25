"""数据星球（汇报落地页）：路由、手势状态机（Node 跑合成关键点）、静态文件。"""
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


def test_galaxy_routes(registered):
    from emqc.api.app import app

    c = TestClient(app)
    page = c.get("/report")
    assert page.status_code == 200 and "DATA GALAXY" in page.text and "importmap" in page.text
    assert "three@0.160.0" in page.text and "/static/galaxy/app.js" in page.text
    assert c.get("/report/summary").status_code == 200
    for f in ("app.js", "config.js", "scene.js", "particlePlanet.js", "datasetManager.js", "cameraRig.js", "handTracking.js", "gestureController.js", "ui.js", "galaxy.css"):
        assert c.get(f"/static/galaxy/{f}").status_code == 200, f


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_gesture_state_machine_in_node():
    r = subprocess.run(["node", "--experimental-default-type=module", "tests/js/gestures.test.mjs"], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-3000:] + r.stdout[-2000:]
    assert "all passed" in r.stdout
