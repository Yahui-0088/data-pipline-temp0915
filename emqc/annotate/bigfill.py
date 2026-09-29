"""大块填充：在没标注的大细胞里点一下，按电镜上的膜找出整个细胞；先预览，确认后才写入。numpy + scipy，不用模型、不用 GPU。

为什么不用 SAM：SAM 一次只看一张切片、按「像不像一个物体」出掩膜，对很大、质地均匀、只靠又长又细的膜隔开的细胞，
它要么只圈出一部分，要么选中里面的细胞器。这里反过来只看「哪里是膜」。点一下时两套各算一遍，择优（segment）：
  * 标记分水岭（bigfill_ws.py）：旁边的小细胞都标好时更准，但挡漏几乎全靠这些标签；
  * 随机游走（本文件）：
    1. 膜强度 = 每个像素比它周围暗多少（按局部标准差计），不用全局阈值——拼接数据各块明暗不一；
    2. 在点击处和其他区域的「内部核心」各放种子，已有标签整块当作别人的种子，解随机游走（每个像素先走到谁的种子，
       过膜的代价按膜强度指数增加）：一两个像素的膜缺口挡不住整体的解，边界自然落在膜中线上；
    3. 窗口随细胞放大：区域碰到窗口边就把窗口加倍重算（256 → 512 → 整片），大细胞不会被截断
       （删掉的旧「智能填充」固定只算点击点周围 256×256，这正是它在大细胞上不行的原因）；
    4. 点在线粒体、细胞核上时自动改成包住它的那片胞质；一块区域经膜上缺口连到隔壁时，按「窄通道 + 边界在膜上」判为漏，
       退回严格结果；细胞里的洞（细胞器）一律填上；
    5. 传到上 / 下一片（propagate，只用这一套）：上一片的区域内缩 8 像素当种子，其他细胞的核心和已有标签当别人的种子。
  分水岭的结果是空的、或比随机游走的大出一半以上，就用随机游走的。

实测（H01 四个 512² 块，把一片里所有 ≥3000 像素的细胞一起抹掉当作「一大片没标」，逐个在细胞最深处点击还原，
和原始分割比；没参与调参的切片上）：点 1 下平均 IoU 0.82、点 3 下 0.87，≥2 万像素的细胞 0.68 / 0.84，传播 8 片后 0.78；
一片里没有标注时 0.75。只用随机游走是 0.77 / 0.82，只用分水岭 0.85 / 0.88 但没有标注时掉到 0.43。
数字和做法见 docs/ANNOTATE.md「大块填充」。两套算法都与测评时冻结的版本逐行一致，只改了接口；
要改参数或择优规则，先按同样的做法在调参切片上重测，数字不降再改。
"""
from __future__ import annotations

import base64
import io
import logging
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait

import numpy as np
from PIL import Image
from scipy import ndimage, sparse

from emqc.annotate import bigfill_ws

log = logging.getLogger(__name__)

S4 = ndimage.generate_binary_structure(2, 1)
# 缓存按线程分开：同时算两个预览时（两个名额），各用各的，互不清空、也不会凭内存地址拿到对方的中间结果
_TLS = threading.local()


class Superseded(Exception):
    """同一个人在同一块上又点了一下：这一次的结果没人要了，尽早停下，把名额让出来。"""


def _cache() -> dict:
    c = getattr(_TLS, "cache", None)
    if c is None:
        c = _TLS.cache = {}
    return c


def _check_stop() -> None:
    stop = getattr(_TLS, "stop", None)
    if stop is not None and stop():
        raise Superseded()

P = dict(
    # membraneness
    sig=1.0, win=63, eps=4.0,
    # adaptive window
    R=128, Rgrow=2.0, maxgrow=3, touch=2,
    # markers (old _markers)
    qt=0.60, dmin=4.5, minmark=12, reloc=25, r_conn=0.0,
    # walker
    beta=25.0, mcap=0.8, floor=1e-4, margin=45, thr=0.80, rtol=1e-4, maxit=400, ds_area=40000, refine=4,
    # organelle fix
    organelle=1, ring=(3, 14), ring_free=0.85, ring_t=1.3, ring_one=0.7, encl=0.6, grow_fac=1.5,
    # leak check: loose vs strict own rule
    combine=1, rc_loose=0.0, rc_strict=1.5, cut_w=2, cut_m=0.5, cut_f=0.85,
    # multi-click
    union_first=1,
    # propagation
    perode=8.0, pgrow=6.0, pmargin=60, pthr=0.90,
)


# ------------------------------------------------------------------ features / solver
def membraneness(em, p=P):
    f = np.asarray(em, np.float32)
    if p["sig"]:
        f = ndimage.gaussian_filter(f, p["sig"])
    mu = ndimage.uniform_filter(f, p["win"])
    var = ndimage.uniform_filter(f * f, p["win"]) - mu * mu
    return (mu - f) / (np.sqrt(np.maximum(var, 0.0)) + p["eps"])


def walker(m, fg, bg, p):
    """probability of reaching fg before bg (the old _walker)."""
    h, w = m.shape
    mm = np.clip(m, 0.0, p["mcap"]) / p["mcap"]
    ew = np.concatenate([
        (np.exp(-p["beta"] * np.maximum(mm[:, :-1], mm[:, 1:])) + p["floor"]).ravel(),
        (np.exp(-p["beta"] * np.maximum(mm[:-1, :], mm[1:, :])) + p["floor"]).ravel()]).astype(np.float64)
    unknown = ~(fg | bg)
    nu = int(unknown.sum())
    prob = fg.astype(np.float64)
    if nu == 0:
        return prob
    ids = np.full(h * w, -1, np.int64)
    ids[unknown.ravel()] = np.arange(nu)
    ids = ids.reshape(h, w)
    ea = np.concatenate([ids[:, :-1].ravel(), ids[:-1, :].ravel()])
    eb = np.concatenate([ids[:, 1:].ravel(), ids[1:, :].ravel()])
    fa = np.concatenate([fg[:, :-1].ravel(), fg[:-1, :].ravel()])
    fb = np.concatenate([fg[:, 1:].ravel(), fg[1:, :].ravel()])
    ua, ub = ea >= 0, eb >= 0
    # 选中的边可能一条都没有（种子贴着图像左上角时），这时 bincount 返回整数数组，再 += 小数会报错——统一转成浮点
    diag = (np.bincount(ea[ua], weights=ew[ua], minlength=nu).astype(np.float64)
            + np.bincount(eb[ub], weights=ew[ub], minlength=nu))
    s = ua & fb
    rhs = np.bincount(ea[s], weights=ew[s], minlength=nu).astype(np.float64)
    s = ub & fa
    rhs += np.bincount(eb[s], weights=ew[s], minlength=nu)
    s = ua & ub
    rows = np.concatenate([ea[s], eb[s], np.arange(nu)])
    cols = np.concatenate([eb[s], ea[s], np.arange(nu)])
    data = np.concatenate([-ew[s], -ew[s], diag])
    A = sparse.coo_matrix((data, (rows, cols)), shape=(nu, nu)).tocsr()
    prob[unknown] = np.clip(pcg(A, rhs, 1.0 / np.maximum(diag, 1e-12), p["rtol"], p["maxit"]), 0.0, 1.0)
    return prob


def pcg(A, b, dinv, rtol, maxit):
    """Jacobi-preconditioned conjugate gradients from x = 0 (same iteration as scipy's cg, without its per-iteration
    LinearOperator overhead); stops at ||r|| <= rtol ||b||."""
    x = np.zeros_like(b)
    r = b.copy()
    tol2 = (rtol * np.linalg.norm(b)) ** 2
    if r @ r <= tol2:
        return x
    z = dinv * r
    d = z.copy()
    rz = r @ z
    for it in range(maxit):
        if it % 20 == 0:
            _check_stop()
        q = A @ d
        alpha = rz / (d @ q)
        x += alpha * d
        r -= alpha * q
        if r @ r <= tol2:
            break
        z = dinv * r
        rz_new = r @ z
        d *= rz_new / rz
        d += z
        rz = rz_new
    return x


def pool_max(a, f):
    h, w = a.shape
    H, W = -(-h // f), -(-w // f)
    pad = np.pad(a, ((0, H * f - h), (0, W * f - w)), mode="edge")
    return pad.reshape(H, f, W, f).max(axis=(1, 3))


def fill_holes(reg):
    if not reg.any():
        return reg
    ys, xs = np.nonzero(reg)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    sub = ~reg[y0:y1, x0:x1]
    lab, n = ndimage.label(sub, structure=S4)
    if n == 0:
        return reg
    border = np.zeros(n + 1, bool)
    border[lab[0, :]] = border[lab[-1, :]] = border[lab[:, 0]] = border[lab[:, -1]] = True
    border[0] = True
    out = reg.copy()
    out[y0:y1, x0:x1] |= ~border[lab]
    return out


def pick(reg, seeds, fg):
    """components of reg that hold a seed (else the one overlapping fg most)."""
    lab, n = ndimage.label(reg, structure=S4)
    if n == 0:
        return reg
    ks = {int(lab[y, x]) for y, x in seeds if 0 <= y < reg.shape[0] and 0 <= x < reg.shape[1] and lab[y, x]}
    if not ks:
        c = np.bincount(lab[fg].ravel(), minlength=n + 1)
        c[0] = 0
        if c.any():
            ks = {int(c.argmax())}
    return np.isin(lab, list(ks)) if ks else np.zeros_like(reg)


def solve(m, fg, bg, seeds, thr, p):
    """walker on the given box: 2x coarse grid + full-resolution band refinement when the box is large."""
    if m.size > p["ds_area"]:
        f = 2
        fgc = pool_max(fg.astype(np.uint8), f).astype(bool)
        bgc = pool_max(bg.astype(np.uint8), f).astype(bool) & ~fgc
        pc = walker(pool_max(m, f), fgc, bgc, p)
        prob = np.kron(pc, np.ones((f, f)))[:m.shape[0], :m.shape[1]]
        prob = ndimage.uniform_filter(prob, f)
        reg = (fill_holes(pick((prob >= thr) | fg, seeds, fg)) & ~bg) | fg
        r = p["refine"]
        if r and reg.any():
            ys, xs = np.nonzero(reg)
            h, w = reg.shape
            a0, a1 = max(0, ys.min() - r - 2), min(h, ys.max() + r + 3)
            b0, b1 = max(0, xs.min() - r - 2), min(w, xs.max() + r + 3)
            rs = reg[a0:a1, b0:b1]
            inner = ((ndimage.distance_transform_edt(rs) > r) | fg[a0:a1, b0:b1]) & ~bg[a0:a1, b0:b1]
            # the crop reaches r + 2 px beyond the region, so the band never touches an interior crop edge
            outer = ((ndimage.distance_transform_edt(~rs) > r) | bg[a0:a1, b0:b1]) & ~inner
            reg = np.zeros_like(reg)
            reg[a0:a1, b0:b1] = walker(m[a0:a1, b0:b1], inner, outer, p) >= 0.5
            reg |= fg
    else:
        reg = walker(m, fg, bg, p) >= thr
    return fill_holes(pick(reg | fg, seeds, fg))


# ------------------------------------------------------------------ markers / adaptive window
def nearest(mask, y, x, rmax):
    """nearest True pixel of mask to (y, x) within rmax (local patch search); None if there is none."""
    if mask[y, x]:
        return y, x
    r = int(np.ceil(rmax)) + 1
    y0, x0 = max(0, y - r), max(0, x - r)
    sub = mask[y0:y + r + 1, x0:x + r + 1]
    if not sub.any():
        return None
    d, (iy, ix) = ndimage.distance_transform_edt(~sub, return_indices=True)
    if d[y - y0, x - x0] > rmax:
        return None
    return int(iy[y - y0, x - x0]) + y0, int(ix[y - y0, x - x0]) + x0


def own_markers(m, free, seeds, p):
    """the old _markers on a window, with labels excluded and several seeds: fg (own cores), bg (other cores)."""
    ck = ("cores", m.shape, m.ctypes.data, hash(np.packbits(free).tobytes()), p["qt"], p["dmin"])
    cache = _cache()
    if ck not in cache:
        nm = (m <= np.quantile(m[free] if free.any() else m, p["qt"])) & free
        dnm = ndimage.distance_transform_edt(nm)
        lab, n = ndimage.label(dnm >= p["dmin"], structure=S4)
        cache[ck] = (nm, dnm, lab, n)
    nm, dnm, lab, n = cache[ck]
    if n == 0:
        return None
    core = lab > 0
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    sizes[0] = 0
    conn = nm if not p["r_conn"] else (dnm >= p["r_conn"])
    nml, _ = ndimage.label(conn, structure=S4)
    own = np.zeros(n + 1, bool)
    new_seeds = []
    for sy, sx in seeds:
        if not core[sy, sx] and p["reloc"]:
            q = nearest(core, sy, sx, p["reloc"])
            if q is not None:
                sy, sx = q
        new_seeds.append((sy, sx))
        l_nm = nml[sy, sx]
        if l_nm == 0:
            q = nearest(conn, sy, sx, 64)
            if q is None:
                _, (jy, jx) = ndimage.distance_transform_edt(~conn, return_indices=True)
                q = (jy[sy, sx], jx[sy, sx])
            l_nm = nml[q]
        o = np.bincount(lab[nml == l_nm].ravel(), minlength=n + 1) > 0.5 * np.maximum(sizes, 1)
        o[0] = False
        if not o.any():
            k = lab[sy, sx]
            if k == 0:
                q = nearest(core, sy, sx, 64)
                if q is None:
                    _, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
                    q = (iy[sy, sx], ix[sy, sx])
                k = lab[q]
            if k:
                o[k] = True
        own |= o
    own[0] = False
    if not own.any():
        return None
    fg = fill_holes(own[lab]) & free
    keep = (sizes >= p["minmark"]) & ~own
    keep[0] = False
    return fg, keep[lab] & ~fg, new_seeds


def _edges(shape, top, bottom, left, right):
    e = np.zeros(shape, bool)
    if top:
        e[0, :] = True
    if bottom:
        e[-1, :] = True
    if left:
        e[:, 0] = True
    if right:
        e[:, -1] = True
    return e


def window_region(M, free, seeds, R, p, extra_fg=None):
    """one windowed solve -> (region, truncated?)."""
    _check_stop()
    H, W = free.shape
    ys = [s[0] for s in seeds]
    xs = [s[1] for s in seeds]
    y0, y1 = max(0, min(ys) - R), min(H, max(ys) + R + 1)
    x0, x1 = max(0, min(xs) - R), min(W, max(xs) + R + 1)
    m, fr = M[y0:y1, x0:x1], free[y0:y1, x0:x1]
    mk = own_markers(m, fr, [(y - y0, x - x0) for y, x in seeds], p)
    if mk is None:
        return None, False
    fg, bg, loc = mk
    if extra_fg is not None:
        fg |= extra_fg[y0:y1, x0:x1] & fr
        bg &= ~fg
    bg |= ~fr                                            # existing labels are background
    edges = _edges(fg.shape, y0 > 0, y1 < H, x0 > 0, x1 < W)
    bg |= edges & ~fg
    fy, fx = np.nonzero(fg)
    g = p["margin"]
    a0, a1 = max(0, fy.min() - g), min(m.shape[0], fy.max() + g + 1)
    b0, b1 = max(0, fx.min() - g), min(m.shape[1], fx.max() + g + 1)
    fc, bc = fg[a0:a1, b0:b1], bg[a0:a1, b0:b1].copy()
    box = _edges(fc.shape, a0 > 0, a1 < m.shape[0], b0 > 0, b1 < m.shape[1])
    bc |= box & ~fc
    sl = [(y - a0, x - b0) for y, x in loc]
    key = (y0, y1, x0, x1, a0, a1, b0, b1, hash(np.packbits(fc).tobytes()), hash(np.packbits(bc).tobytes()), tuple(sl))
    reg = _cache().get(key)
    if reg is None:                                      # loose and strict rules often give the same markers
        reg = solve(m[a0:a1, b0:b1], fc, bc, sl, p["thr"], p) & fr[a0:a1, b0:b1]
        _cache()[key] = reg
    # truncated: the region reaches (within `touch` px) a side of the solve box that was forced to background
    t = p["touch"] + 1
    top = a0 > 0 or y0 > 0
    bottom = a1 < m.shape[0] or y1 < H
    left = b0 > 0 or x0 > 0
    right = b1 < m.shape[1] or x1 < W
    hit = ((reg[:t].sum() if top else 0) + (reg[-t:].sum() if bottom else 0)
           + (reg[:, :t].sum() if left else 0) + (reg[:, -t:].sum() if right else 0))
    out = np.zeros((H, W), bool)
    out[y0 + a0:y0 + a1, x0 + b0:x0 + b1] = reg
    return out, bool(hit > 3)


def adaptive_region(M, free, seeds, p, extra_fg=None):
    """grow the window (x2, margin x2) while the region is cut by the forced-background window / box edge."""
    H, W = free.shape
    R, reg = p["R"], None
    for it in range(p["maxgrow"] + 1):
        r2, trunc = window_region(M, free, seeds, int(R), dict(p, margin=int(p["margin"] * p["Rgrow"] ** it)), extra_fg)
        if r2 is None:
            break
        reg = r2
        if not trunc or R >= max(H, W):
            break
        R *= p["Rgrow"]
    return reg


def organelle_fix(M, free, reg, seeds, p):
    """the click hit an organelle: re-seed with the single cytoplasm component that surrounds the region."""
    r0, r1 = p["ring"]
    ys, xs = np.nonzero(reg)
    H, W = reg.shape
    a0, a1 = max(0, ys.min() - r1 - 1), min(H, ys.max() + r1 + 2)
    b0, b1 = max(0, xs.min() - r1 - 1), min(W, xs.max() + r1 + 2)
    d = ndimage.distance_transform_edt(~reg[a0:a1, b0:b1])
    ring = np.zeros_like(reg)
    ring[a0:a1, b0:b1] = (d > r0) & (d <= r1)
    if not ring.any() or (ring & free).sum() < p["ring_free"] * ring.sum():
        return reg
    cl, n = ndimage.label(ring & free & (M < p["ring_t"]), structure=np.ones((3, 3), bool))
    if n == 0:
        return reg
    c = np.bincount(cl.ravel())
    c[0] = 0
    k = int(c.argmax())
    if c[k] < p["ring_one"] * ring.sum():
        return reg
    surround = (cl == k) & (M <= np.quantile(M[free], p["qt"]))
    ys, xs = np.nonzero(surround)
    if ys.size == 0:
        return reg
    step = max(1, len(ys) // 8)
    seeds2 = list(seeds) + [(int(y), int(x)) for y, x in zip(ys[::step], xs[::step])]
    reg2 = adaptive_region(M, free, seeds2, p, extra_fg=reg | surround)
    if reg2 is not None and reg2.sum() >= p["grow_fac"] * reg.sum() and (reg2 & ring).sum() >= p["encl"] * ring.sum():
        return reg2
    return reg


def _region(M, free, seeds, p):
    reg = adaptive_region(M, free, seeds, p)
    if reg is not None and p["organelle"]:
        reg = organelle_fix(M, free, reg, seeds, p)
    return reg


def _keep_seeded(reg, seeds):
    lab, _ = ndimage.label(reg, structure=S4)
    ks = {int(lab[y, x]) for y, x in seeds} - {0}
    return np.isin(lab, list(ks)) if ks else reg


def _segment(M, free, seeds, p):
    _cache().clear()
    if not p["combine"]:
        reg = _region(M, free, seeds, p)
    else:
        A = _region(M, free, seeds, dict(p, r_conn=p["rc_loose"]))
        B = _region(M, free, seeds, dict(p, r_conn=p["rc_strict"]))
        if A is None or B is None:
            reg = A if B is None else B
        else:
            ex = A & ~B
            cut = ndimage.binary_dilation(B, iterations=p["cut_w"]) & ex
            leak = ex.sum() > 50 and cut.any() and (M[cut] > p["cut_m"]).mean() > p["cut_f"]
            reg = B if leak else A
    if reg is None:
        return np.zeros(free.shape, bool)
    return _keep_seeded(reg & free, seeds)


def segment_rw(em, labels, pos, neg):
    """随机游走这套：点击 → 区域。"""
    p = P
    free = np.asarray(labels) == 0
    H, W = free.shape
    seeds = []
    for x, y in pos:
        x, y = int(np.clip(x, 0, W - 1)), int(np.clip(y, 0, H - 1))
        if free[y, x]:
            seeds.append((y, x))
    if not seeds:
        return np.zeros((H, W), bool)
    M = membraneness(em, p)
    reg = _segment(M, free, seeds, p)
    if len(seeds) > 1 and p["union_first"]:
        reg = fill_holes(reg | _segment(M, free, seeds[:1], p)) & free
    return reg


# 两套择优：标记分水岭（bigfill_ws）在旁边标注齐全时更准，但一片里几乎没有标注时会一下填满大半片；随机游走这套稳。
# 分水岭的结果是空的、或比随机游走的大出一半以上，就用随机游走的。这条规则在调参切片上定下后没有再改。
FALLBACK_RATIO = 1.5
# 分水岭在另一个线程里和随机游走同时算（numpy / scipy 算的时候放开 GIL），1024² 的片上等待约减半。两个线程对应两个名额
_WS_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bigfill-ws")


def segment(em, labels, pos, neg):
    """点击点（屏幕坐标 x, y）→ 要填的区域（只含没标注的像素）。"""
    free = np.asarray(labels) == 0
    H, W = free.shape
    pos = [(x, y) for x, y in ((int(np.clip(x, 0, W - 1)), int(np.clip(y, 0, H - 1))) for x, y in pos) if free[y, x]]
    if not pos:
        return np.zeros((H, W), bool)
    stop = getattr(_TLS, "stop", None)          # 线程局部的，要显式交给另一个线程

    def check():
        if stop is not None and stop():
            raise Superseded()

    job = _WS_POOL.submit(bigfill_ws.segment, em, labels, pos, check)
    try:
        rw = segment_rw(em, labels, pos, neg)
    finally:
        wait([job])                             # 不论成败都等它算完或停下，名额才真正空出来
    try:
        ws = job.result() & free
    except Superseded:
        raise
    except Exception:                           # 分水岭出错不该让工具不能用：退回随机游走的结果
        log.exception("大块填充：标记分水岭出错，改用随机游走的结果")
        return rw
    n_ws, n_rw = int(ws.sum()), int(rw.sum())
    if n_ws == 0 or (n_rw > 0 and n_ws > FALLBACK_RATIO * n_rw):
        return rw
    return ws


# ------------------------------------------------------------------ propagation
def propagate(em, labels, prev):
    p = P
    _check_stop()
    free = np.asarray(labels) == 0
    prev = np.asarray(prev, bool)
    H, W = free.shape
    if not prev.any():
        return np.zeros((H, W), bool)
    d_in = ndimage.distance_transform_edt(prev)
    fg = (d_in > min(p["perode"], 0.5 * d_in.max())) & free
    if not fg.any():
        fg = prev & free
        if not fg.any():
            return np.zeros((H, W), bool)
    ys, xs = np.nonzero(prev)
    g = p["pmargin"]
    y0, y1 = max(0, ys.min() - g), min(H, ys.max() + g + 1)
    x0, x1 = max(0, xs.min() - g), min(W, xs.max() + g + 1)
    M = membraneness(em, p)
    m, fr, fgw = M[y0:y1, x0:x1], free[y0:y1, x0:x1], fg[y0:y1, x0:x1]
    nm = (m <= np.quantile(m[fr], p["qt"])) & fr
    lab, n = ndimage.label(ndimage.distance_transform_edt(nm) >= p["dmin"], structure=S4)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    near = ndimage.distance_transform_edt(~prev[y0:y1, x0:x1]) <= p["pgrow"]
    inn = np.bincount(lab[near].ravel(), minlength=n + 1)
    far = (inn < 0.5 * np.maximum(sizes, 1)) & (sizes >= p["minmark"])
    far[0] = False
    bg = (far[lab] | ~fr | _edges(fgw.shape, y0 > 0, y1 < H, x0 > 0, x1 < W)) & ~fgw
    fy, fx = np.nonzero(fgw)
    k = len(fy) // 2
    reg = solve(m, fgw, bg, [(int(fy[k]), int(fx[k]))], p["pthr"], p) & fr
    out = np.zeros((H, W), bool)
    out[y0:y1, x0:x1] = reg
    return out


# ------------------------------------------------------------------ 预览 / 应用（与 SAM 同一套：令牌、过期、这一片被改过就作废）
PREVIEW_TTL_S = 900
PREVIEW_RGBA = (255, 150, 0, 150)          # 橙色，和 SAM 的青色区分开
MAX_POINTS = 10


class BigFillService:
    def __init__(self):
        self.lock = threading.Lock()
        self.proposals: OrderedDict[str, dict] = OrderedDict()
        # 一次预览要算 0.2–3 秒 CPU（1024² 的块上大细胞可能十几秒）：同时最多两个，免得几个人一起点把线程池占满
        self.slots = threading.BoundedSemaphore(2)
        self.wait_s = 10.0
        # 同一个人在同一块上每点一下，代数加一：旧的那次（页面已经不要了）在排队或计算中发现自己过时就停下，让出名额
        self.gen: dict[tuple, int] = {}

    def _snapshot(self, block, z):
        """块锁里拍这一片的快照：电镜、当前标签、版本号。计算在锁外做，别人照常落笔；应用时再核对版本号。"""
        with block.lock:
            return block.em_slice(z), block.seg_slice(z), block.slice_rev(z)

    def _proposal(self, block, z, mask, rev, meta):
        token = uuid.uuid4().hex
        now = time.monotonic()
        with self.lock:
            self.proposals = OrderedDict((k, v) for k, v in self.proposals.items() if now - v["created"] < PREVIEW_TTL_S)
            self.proposals[token] = {"path": str(block.path.resolve()), "work": str(block.work.resolve()), "z": int(z), "mask": mask,
                                     "slice_rev": rev, "created": now, "meta": meta}
            while len(self.proposals) > 32:
                self.proposals.popitem(last=False)
        overlay = np.zeros((*mask.shape, 4), dtype=np.uint8)
        overlay[mask] = PREVIEW_RGBA
        buf = io.BytesIO()
        Image.fromarray(overlay).save(buf, format="PNG")
        return {"token": token, "z": int(z), "n_px": int(mask.sum()),
                "mask_png": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}

    def _ticket(self, block, who):
        key = (str(block.path.resolve()), who or "-")
        with self.lock:
            g = self.gen[key] = self.gen.get(key, 0) + 1
            if len(self.gen) > 2000:
                self.gen = {key: g}
        return lambda: self.gen.get(key) != g

    def _run(self, fn, stop):
        waited = 0.0
        while not self.slots.acquire(timeout=0.25):
            if stop():
                raise Superseded()
            waited += 0.25
            if waited >= self.wait_s:
                raise RuntimeError("别人正在算大块填充，请稍后再点")
        _TLS.stop = stop
        try:
            if stop():
                raise Superseded()
            return fn()
        finally:
            _TLS.stop = None
            self.slots.release()

    def preview(self, block, z, points, who=None):
        """点击点（屏幕坐标 x, y）→ 预览。只填没有标签的像素。who：谁在点（同一个人的新点击取代旧的）。"""
        stop = self._ticket(block, who)
        em, seg, rev = self._snapshot(block, z)
        started = time.perf_counter()
        mask = self._run(lambda: segment(em, seg, [(int(x), int(y)) for x, y in points], []), stop)
        mask &= seg == 0
        out = self._proposal(block, z, mask, rev, {"method": "bigfill-rwa3", "points": [list(map(int, p)) for p in points]})
        out["seconds"] = round(time.perf_counter() - started, 3)
        return out

    def propagate(self, block, z_from, z_to, label, who=None):
        """把第 z_from 片上标签 label 的区域接到相邻的 z_to 片：预览，不写入。"""
        stop = self._ticket(block, who)
        with block.lock:
            prev = block.seg_slice(z_from) == np.uint64(label)
        if not prev.any():
            raise ValueError(f"第 {z_from} 片上没有标签 {label}，没有东西可以往下接")
        em, seg, rev = self._snapshot(block, z_to)
        started = time.perf_counter()
        mask = self._run(lambda: propagate(em, seg, prev), stop)
        mask &= seg == 0
        out = self._proposal(block, z_to, mask, rev, {"method": "bigfill-rwa3-propagate", "from_z": int(z_from), "label": str(label)})
        out["seconds"] = round(time.perf_counter() - started, 3)
        return out

    def apply(self, block, token, new_id, by=None):
        with block.lock:
            with self.lock:
                p = self.proposals.get(token)
            if p is None or time.monotonic() - p["created"] >= PREVIEW_TTL_S:
                raise ValueError("预览已过期，请重新点一下")
            if p["path"] != str(block.path.resolve()) or p["work"] != str(block.work.resolve()):
                raise ValueError("预览不属于当前数据块")
            if p["slice_rev"] != block.slice_rev(p["z"]):
                raise ValueError("这一片刚被改过，请重新点一下生成预览")
            mask = p["mask"] & (block.seg_slice(p["z"]) == 0)
            rec = block.apply_mask(p["z"], mask, int(new_id), dict(p["meta"]), kind="bigfill", by=by)
            with self.lock:
                self.proposals.pop(token, None)
            return rec


service = BigFillService()
