"""大块填充：点一下按膜找出整个大细胞，先预览、确认后才写；接到相邻片；只填没标注的地方；过期 / 被改过的预览拒绝写入。"""
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from emqc.annotate.store import Block

H = W = 160
Z = 3


def _membrane_row(x, z):
    """上下两个大细胞之间那条弯弯的细膜，在第 x 列的行号（每片稍微挪一点，像真实的相邻切片）。"""
    return int(70 + 12 * np.sin(x / 17.0) + 2 * z)


def _truth(z):
    """显示方向 (行 y, 列 x)：上面那个大细胞（膜以上、左上方已标注的小细胞以外）。"""
    yy, xx = np.mgrid[0:H, 0:W]
    top = yy < np.array([_membrane_row(x, z) for x in range(W)])[None, :] - 1
    return top & ~_small_cells()


def _small_cells():
    yy, xx = np.mgrid[0:H, 0:W]
    return ((yy - 20) ** 2 + (xx - 25) ** 2 <= 12 ** 2) | ((yy - 25) ** 2 + (xx - 60) ** 2 <= 10 ** 2)


def _section(z, rng):
    em = rng.normal(165, 18, (H, W))                  # 胞质：亮、有噪声
    for x in range(W):
        r = _membrane_row(x, z)
        em[r - 1:r + 2, x] = 45                        # 3 像素宽的膜
    em[2:4, :] = 45                                    # 块的上边也有一道膜
    from scipy import ndimage

    small = _small_cells()
    em[small & ~ndimage.binary_erosion(small, iterations=2)] = 45     # 小细胞的膜
    for cy, cx in ((40, 110), (45, 115)):              # 上面那个细胞里有两个暗的细胞器
        em[cy - 3:cy + 3, cx - 3:cx + 3] = 60
    return np.clip(em, 0, 255).astype(np.uint8)


@pytest.fixture
def bf_block(tmp_path):
    rng = np.random.default_rng(3)
    em = np.stack([_section(z, rng) for z in range(Z)], axis=2)        # (H, W, Z) 显示方向
    seg = np.zeros((H, W, Z), np.uint64)
    seg[_small_cells(), :] = 11                                        # 左上两个小细胞已经标好了
    seg[_small_cells() & (np.mgrid[0:H, 0:W][1] > 45), :] = 12
    path = tmp_path / "blocks" / "bf"
    path.mkdir(parents=True)
    np.save(path / "em.npy", np.ascontiguousarray(em.transpose(1, 0, 2)))    # 存盘是 (X, Y, Z)
    np.save(path / "seg.npy", np.ascontiguousarray(seg.transpose(1, 0, 2)))
    (path / "meta.json").write_text(json.dumps({"dataset": {"id": "bf"}}))
    return path


@pytest.fixture
def bf_client(bf_block, tmp_path):
    from emqc.api.app import app
    from emqc.api.routers.annotate import reset_store
    from emqc.config import settings

    old = settings.annotate_root, settings.annotate_workdir
    settings.annotate_root, settings.annotate_workdir = bf_block.parent, tmp_path / "work"
    reset_store()
    with TestClient(app) as c:
        yield c
    settings.annotate_root, settings.annotate_workdir = old
    reset_store()


def _iou(a, b):
    return (a & b).sum() / max(1, (a | b).sum())


def test_one_click_finds_the_whole_big_cell_and_stops_at_the_thin_membrane(bf_block, tmp_path):
    from emqc.annotate.bigfill import segment

    b = Block(bf_block, tmp_path / "work")
    em, seg = b.em_slice(0), b.seg_slice(0)
    mask = segment(em, seg, [(120, 25)], [])
    assert _iou(mask, _truth(0)) > 0.9, "一下就是整个大细胞，停在那条细膜上"
    assert not (mask & (seg != 0)).any(), "已标注的小细胞一个像素都不动"
    below = np.mgrid[0:H, 0:W][0] > np.array([_membrane_row(x, 0) for x in range(W)])[None, :] + 2
    assert (mask & below).sum() < 0.01 * mask.sum(), "不越过膜漏到下面那个细胞"
    assert mask[40, 110] and mask[45, 115], "细胞里的暗细胞器算这个细胞的"


def test_preview_then_apply_writes_only_background_and_undoes(bf_client, bf_block):
    url = "/api/v1/annotate/blocks/bf"
    r = bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": [[120, 25]]})
    assert r.status_code == 200, r.text
    prev = r.json()
    assert prev["n_px"] > 3000 and prev["mask_png"].startswith("data:image/png;base64,")
    before = np.asarray(bf_client.get(url + "/labels/0.json").json()["ids"])
    assert "777" not in before, "预览不写任何东西"
    r = bf_client.post(url + "/bigfill/apply", json={"token": prev["token"], "new_id": 777})
    assert r.status_code == 200, r.text
    edit = r.json()["edit"]
    assert edit["kind"] == "bigfill" and edit["n_px"] == prev["n_px"] and edit["source"] == "assisted"
    assert bf_client.post(url + "/bigfill/apply", json={"token": prev["token"], "new_id": 777}).status_code == 409, "一个预览只能用一次"
    from emqc.api.routers.annotate import get_store

    plane = get_store().get("bf").seg_slice(0)
    assert _iou(plane == 777, _truth(0)) > 0.9
    assert (plane[_small_cells()] != 777).all(), "小细胞原样"
    assert bf_client.post(url + "/undo?z=0").json()["undone"]["kind"] == "bigfill"
    assert not (get_store().get("bf").seg_slice(0) == 777).any(), "撤销后原样"


def test_a_stale_preview_is_refused(bf_client):
    url = "/api/v1/annotate/blocks/bf"
    prev = bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": [[120, 25]]}).json()
    bf_client.post(url + "/paint", json={"z": 0, "points": [[150, 150]], "radius": 2, "new_id": 5})
    r = bf_client.post(url + "/bigfill/apply", json={"token": prev["token"], "new_id": 777})
    assert r.status_code == 409 and "改过" in r.text, "预览之后这一片被改过：拒绝写入，要重新点"


def test_propagate_continues_the_cell_on_the_next_section(bf_client):
    url = "/api/v1/annotate/blocks/bf"
    prev = bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": [[120, 25]]}).json()
    assert bf_client.post(url + "/bigfill/apply", json={"token": prev["token"], "new_id": 777}).status_code == 200
    r = bf_client.post(url + "/bigfill/propagate", json={"z_from": 0, "z_to": 1, "label": "777"})
    assert r.status_code == 200, r.text
    nxt = r.json()
    assert nxt["z"] == 1 and nxt["n_px"] > 3000
    assert bf_client.post(url + "/bigfill/apply", json={"token": nxt["token"], "new_id": 777}).status_code == 200
    from emqc.api.routers.annotate import get_store

    assert _iou(get_store().get("bf").seg_slice(1) == 777, _truth(1)) > 0.85, "膜在下一片挪了位置，照样停在膜上"


def test_bigfill_inputs_are_checked(bf_client):
    url = "/api/v1/annotate/blocks/bf"
    assert bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": [[999, 5]]}).status_code == 422
    assert bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": []}).status_code == 422
    assert bf_client.post(url + "/bigfill/preview", json={"z": 0, "points": [[1, 1]] * 11}).status_code == 422
    assert bf_client.post(url + "/bigfill/propagate", json={"z_from": 0, "z_to": 2, "label": 11}).status_code == 422, "只能接相邻一片"
    r = bf_client.post(url + "/bigfill/propagate", json={"z_from": 0, "z_to": 1, "label": 4242})
    assert r.status_code == 422 and "没有标签" in r.text
    for bad in ("-3", str(2 ** 64), "abc"):
        assert bf_client.post(url + "/bigfill/propagate", json={"z_from": 0, "z_to": 1, "label": bad}).status_code == 422, bad
    assert bf_client.post(url + "/bigfill/apply", json={"token": "0" * 32, "new_id": 5}).status_code == 409


def test_a_click_in_the_corner_works(bf_client):
    """最左上角那个像素：以前这里算到一半报 500（整数数组里混进小数）。"""
    r = bf_client.post("/api/v1/annotate/blocks/bf/bigfill/preview", json={"z": 0, "points": [[0, 0], [W - 1, H - 1]]})
    assert r.status_code == 200, r.text


def test_busy_server_says_so(bf_client, monkeypatch):
    from emqc.annotate import bigfill

    monkeypatch.setattr(bigfill.service, "slots", type("Full", (), {"acquire": lambda self, timeout=None: False, "release": lambda self: None})())
    monkeypatch.setattr(bigfill.service, "wait_s", 0.5)
    r = bf_client.post("/api/v1/annotate/blocks/bf/bigfill/preview", json={"z": 0, "points": [[120, 25]]})
    assert r.status_code == 429


def test_a_newer_click_supersedes_the_older_one(bf_block, tmp_path, monkeypatch):
    """同一个人又点了一下：还在排队 / 在算的那次自己停下，让出名额；别人的不受影响。"""
    import threading

    from emqc.annotate import bigfill

    svc = bigfill.BigFillService()
    b = Block(bf_block, tmp_path / "work")
    old = svc._ticket(b, "u1")
    other = svc._ticket(b, "u2")
    new = svc._ticket(b, "u1")
    assert old() and not new() and not other()
    with pytest.raises(bigfill.Superseded):                     # 排队时发现过时
        svc.slots = type("Full", (), {"acquire": lambda self, timeout=None: False, "release": lambda self: None})()
        svc._run(lambda: 1, old)
    svc.slots = threading.BoundedSemaphore(2)
    em, seg = b.em_slice(0), b.seg_slice(0)
    flips = iter([False])                                       # 开算时还没过时，算的途中被取代
    with pytest.raises(bigfill.Superseded):                     # 算到一半发现过时
        svc._run(lambda: bigfill.segment(em, seg, [(120, 25)], []), lambda: next(flips, True))
    assert svc.slots.acquire(blocking=False) and svc.slots.acquire(blocking=False), "名额都还回来了"
    svc.slots.release(); svc.slots.release()
    assert svc._run(lambda: bigfill.segment(em, seg, [(120, 25)], []), new).any(), "新的那次照常算完"


def test_the_watershed_result_is_dropped_when_it_runs_away(bf_block, tmp_path, monkeypatch):
    """两套择优：分水岭的结果比随机游走的大出一半以上（旁边没什么标注时会一下填满大半片）或是空的，就用随机游走的。"""
    from emqc.annotate import bigfill, bigfill_ws

    b = Block(bf_block, tmp_path / "work")
    em, seg = b.em_slice(0), b.seg_slice(0)
    rw = bigfill.segment_rw(em, seg, [(120, 25)], [])
    monkeypatch.setattr(bigfill_ws, "segment", lambda em, labels, pos, check=None: np.ones(labels.shape, bool))
    assert (bigfill.segment(em, seg, [(120, 25)], []) == rw).all(), "填满整片的那个不要"
    monkeypatch.setattr(bigfill_ws, "segment", lambda em, labels, pos, check=None: np.zeros(labels.shape, bool))
    assert (bigfill.segment(em, seg, [(120, 25)], []) == rw).all(), "空的也不要"
    close = rw & ~np.roll(rw, 3, axis=0)
    monkeypatch.setattr(bigfill_ws, "segment", lambda em, labels, pos, check=None: rw | close)
    assert (bigfill.segment(em, seg, [(120, 25)], []) == (rw | close)).all(), "差不多大小就用分水岭的"
    assert not bigfill.segment(em, seg, [(25, 20)], []).any(), "点在已标注的细胞上：什么都不填"

    def broken(em, labels, pos, check=None):
        raise IndexError("bug")
    monkeypatch.setattr(bigfill_ws, "segment", broken)
    assert (bigfill.segment(em, seg, [(120, 25)], []) == rw).all(), "分水岭出错：退回随机游走的结果，工具照样能用"
