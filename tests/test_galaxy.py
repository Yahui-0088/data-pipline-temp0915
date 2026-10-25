"""数据星球（汇报落地页）：路由、静态文件、细胞图案和数据集区域（Node 跑纯函数）。"""
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
    # 只用鼠标：页面上没有摄像头 / 手势，有图案、颜色、全屏
    assert "mediapipe" not in page.text and "手势" not in page.text and "getUserMedia" not in page.text
    # 只有细胞一个图案、外观固定：没有图案 / 颜色 / 滑杆，也没有底部按钮栏
    assert "gx-dock" not in page.text and 'id="gx-reset"' not in page.text and 'id="gx-fs"' not in page.text
    assert 'id="gx-shapes"' not in page.text and 'type="range"' not in page.text and 'type="color"' not in page.text
    for f in ("app.js", "config.js", "scene.js", "shapes.js", "particleSculpture.js", "datasetManager.js", "cameraRig.js", "ui.js", "galaxy.css"):
        assert c.get(f"/static/galaxy/{f}").status_code == 200, f


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_shapes_and_regions_in_node():
    r = subprocess.run(["node", "tests/js/sculpture.test.mjs"], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-3000:] + r.stdout[-2000:]
    assert "all passed" in r.stdout
