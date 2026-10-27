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
    page = c.get("/report/galaxy")   # 数据星球挪到这里；/report 现在是数据流程图（test_report_flow.py）
    assert page.status_code == 200 and "DATA GALAXY" in page.text and "importmap" in page.text
    assert "three@0.160.0" in page.text and "/static/galaxy/app.js" in page.text
    assert c.get("/report/summary").status_code == 200
    # 只用鼠标：页面上没有摄像头 / 手势，有图案、颜色、全屏
    assert "mediapipe" not in page.text and "手势" not in page.text and "getUserMedia" not in page.text
    # 只有细胞一个图案、外观固定：没有图案 / 颜色 / 滑杆，也没有底部按钮栏
    # 没有操作说明文字、没有「汇报详情」「退出」
    assert "拖动旋转" not in page.text and "鼠标滑过" not in page.text and "汇报详情 →</a>" not in page.text.split('id="gx-fatal"')[0] and "gx-logout" not in page.text
    assert "gx-dock" not in page.text
    # 统计面板默认收起：有小三角按钮控制展开
    assert 'id="gx-tab"' in page.text and 'aria-controls="gx-stats"' in page.text
    # 左侧小三角 → 导航栏 → 总览；统计面板里不再有「回到平台」
    assert 'id="gx-sidetab"' in page.text and 'class="gx-nav-item" href="/overview"' in page.text and "回到平台" not in page.text and 'id="gx-reset"' not in page.text and 'id="gx-fs"' not in page.text
    assert 'id="gx-shapes"' not in page.text and 'type="range"' not in page.text and 'type="color"' not in page.text
    for f in ("app.js", "config.js", "scene.js", "shapes.js", "particleSculpture.js", "datasetManager.js", "cameraRig.js", "ui.js", "galaxy.css"):
        assert c.get(f"/static/galaxy/{f}").status_code == 200, f


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_shapes_and_regions_in_node():
    r = subprocess.run(["node", "tests/js/sculpture.test.mjs"], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-3000:] + r.stdout[-2000:]
    assert "all passed" in r.stdout
