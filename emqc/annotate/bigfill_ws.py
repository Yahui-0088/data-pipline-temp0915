"""大块填充的第二套算法：标记分水岭（按膜强度分层淹没）。只做「点一下 → 区域」，由 bigfill.segment 和随机游走那套择优。

做法（numpy + scipy，不用模型）：
  * 整片算一次：膜强度（局部比周围暗多少，按局部标准差计）；按膜强度的分位数分 27 层，每层取「膜强度低于这一层的
    没标注像素」的连通块——层越高、块越大，块之间只在越来越强的膜上连通；各没标注区域的内部核心（离膜最远的点）；
  * 点击处：往上一层层看点击所在的块，在它一步涨得太猛、或并进另一个不小的块（从膜缺口漏过去）之前停下，这一层的
    块内缩几像素当自己的种子；和点击处只隔着强膜才连得通的核心当别人的种子；已有标签也算别人的；
  * 两类种子一起从低层往高层淹没，同一个块里两类相遇就同时往外长、在膜的脊线上分界（膜有缺口也分得开）；
  * 收尾：填洞，剥掉贴在外面的膜带（人工标注的边在膜的内侧），只留点击所在的那块。
短板：挡漏几乎全靠旁边已标好的小细胞——一片里几乎没有标注时会一下填满大半片，所以不单独用（见 bigfill.segment）。
算法与测评时冻结的那一版一致，只去掉了测评用的缓存开关、加了可中途停下的 check()。
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

S4 = ndimage.generate_binary_structure(2, 1)
S8 = np.ones((3, 3), bool)


def _nothing():
    pass


P = dict(
    sig=1.0, win=31, eps=4.0, ssm=0.5,          # membraneness
    q=0.6, d0=3.0, mxw=9,                        # cores: DT maxima of {m < quantile q}, depth >= d0
    qmin=0.3, qmax=0.95, dq=0.025, reloc=25,     # ladder; a click off every component snaps to the nearest one
    jA=4000, jJ=1.5, jP=500, jcap=0.85, jero=4,   # adaptive target level
    qs=0.7, jqs=0.05,                            # competitor cores: pass value >= max(qs, target level + jqs)
    qW=0.3,                                      # labels compete from this ladder level up
    skiz=4, pad=16, fiters=12,                   # conflict splitting
    peel_t=0.3, peel_k=3,                        # membrane peel
)


# ------------------------------------------------------------------ per-section features
def membraneness(em, p):
    f = np.asarray(em, np.float32)
    if p["sig"]:
        f = ndimage.gaussian_filter(f, p["sig"])
    mu = ndimage.uniform_filter(f, p["win"])
    var = ndimage.uniform_filter(f * f, p["win"]) - mu * mu
    m = (mu - f) / (np.sqrt(np.maximum(var, 0.0)) + p["eps"])
    if p["ssm"]:
        m = ndimage.gaussian_filter(m, p["ssm"])
    return m


def features(em, labels, p, check=_nothing):
    free = np.asarray(labels) == 0
    m = membraneness(em, p)
    mf = m[free] if free.any() else m.ravel()
    # cores
    nm = free & (m < np.quantile(mf, p["q"]))
    dt = ndimage.distance_transform_edt(nm)
    dts = ndimage.gaussian_filter(dt, 1.0)
    core = (dts >= ndimage.maximum_filter(dts, size=p["mxw"]) - 1e-6) & (dt >= p["d0"])
    cl, n = ndimage.label(core, structure=S8)
    # ladder
    qs = np.round(np.arange(p["qmin"], p["qmax"] + 1e-9, p["dq"]), 4)
    levels = np.quantile(mf, qs)
    K = len(qs)
    L = np.zeros((K,) + m.shape, np.int32)
    ncs, cnts, wallc, par = [], [], [], [None]
    wallb = free & ndimage.binary_dilation(~free, structure=S4)
    for k, t in enumerate(levels):
        check()
        L[k], nc = ndimage.label(free & (m < t), structure=S4)
        ncs.append(nc)
        cnts.append(np.bincount(L[k].ravel(), minlength=nc + 1))
        w = np.zeros(nc + 1, bool)
        w[L[k][wallb]] = True
        w[0] = False
        wallc.append(w)
        if k:
            pk = np.zeros(ncs[k - 1] + 1, np.int32)
            prv = L[k - 1].ravel()
            pk[prv] = L[k].ravel()          # nested sets: every pixel of a level-(k-1) component maps to one parent
            pk[0] = 0
            par.append(pk)
    if n:
        # deepest pixel of each core (without ndimage.maximum_position, which sorts the whole image)
        dmax = np.zeros(n + 1)
        np.maximum.at(dmax, cl[core], dt[core])
        cand = np.flatnonzero(core.ravel() & (dt.ravel() >= dmax[cl.ravel()]))
        u, first = np.unique(cl.ravel()[cand], return_index=True)
        pix = np.zeros(n + 1, np.int64)
        pix[u] = cand[first]
        rep = np.stack([pix[1:] // m.shape[1], pix[1:] % m.shape[1]], 1)
        dep = dt[rep[:, 0], rep[:, 1]]
        repc = L[:, rep[:, 0], rep[:, 1]]
    else:
        rep = np.zeros((0, 2), np.int64)
        dep = np.zeros(0)
        repc = np.zeros((K, 0), np.int32)
    return dict(free=free, m=m, cl=cl, n=n, dt=dt, qs=qs, L=L, ncs=ncs, cnt=cnts, wallc=wallc, par=par,
                rep=rep, dep=dep, repc=repc)


# ------------------------------------------------------------------ markers
def _level(F, q):
    return int(np.argmin(np.abs(F["qs"] - q)))


def _ids_at(Lk, pts, reloc):
    ids = set()
    for x, y in pts:
        k = Lk[y, x]
        if not k and reloc:
            y0, x0 = max(0, y - reloc), max(0, x - reloc)
            sub = Lk[y0:y + reloc + 1, x0:x + reloc + 1]
            if sub.any():
                yy, xx = np.nonzero(sub)
                d2 = (yy + y0 - y) ** 2 + (xx + x0 - x) ** 2
                j = int(np.argmin(d2))
                if d2[j] <= reloc * reloc:
                    k = sub[yy[j], xx[j]]
        if k:
            ids.add(int(k))
    return ids


def _target_level(F, ids_k, p):
    K = len(F["qs"])
    areas = [int(sum(F["cnt"][k][i] for i in ids)) if ids else 0 for k, ids in enumerate(ids_k)]
    for k in range(K - 1):
        if F["qs"][k + 1] > p["jcap"]:
            return k
        if areas[k] < p["jA"]:
            continue
        if areas[k + 1] > p["jJ"] * areas[k]:
            return k
        nxt = ids_k[k + 1]
        if p["jP"] and nxt:
            ch = np.flatnonzero(np.isin(F["par"][k + 1], list(nxt)))
            ch = ch[(ch > 0) & ~np.isin(ch, list(ids_k[k]))]
            if ch.size and F["cnt"][k][ch].max() >= p["jP"]:
                return k
    return K - 1


def markers(F, pts, p):
    """-> (target marker bool (H, W), competitor core ids bool (n + 1,), target ladder level)"""
    K, n = len(F["qs"]), F["n"]
    ids_k = [_ids_at(F["L"][k], pts, p["reloc"]) for k in range(K)]
    kt = _target_level(F, ids_k, p)
    Lk = F["L"][kt]
    tm = np.isin(Lk, list(ids_k[kt])) if ids_k[kt] else np.zeros(Lk.shape, bool)
    if p["jero"]:
        e = ndimage.binary_erosion(tm, iterations=int(p["jero"]))
        tm = e if e.any() else tm
    free = F["free"]
    for x, y in pts:
        tm[max(0, y - 1):y + 2, max(0, x - 1):x + 2] |= free[max(0, y - 1):y + 2, max(0, x - 1):x + 2]
    # pass values of the cores from the click(s)
    pv = np.full(n, np.inf)
    for k in range(K):
        if ids_k[k] and n:
            hit = np.isin(F["repc"][k], list(ids_k[k])) & ~np.isfinite(pv)
            pv[hit] = F["qs"][k]
    ok = pv >= max(p["qs"], F["qs"][kt] + p["jqs"])
    comp = np.zeros(n + 1, bool)
    comp[1:] = ok
    comp &= ~(np.bincount(F["cl"][tm].ravel(), minlength=n + 1) > 0)
    comp[0] = False
    return tm, comp, kt


# ------------------------------------------------------------------ flood
def _dilate4(R):
    """4-neighbour grey dilation of a small-int image (max over the cross), by slicing."""
    g = R.copy()
    np.maximum(g[1:], R[:-1], out=g[1:])
    np.maximum(g[:-1], R[1:], out=g[:-1])
    np.maximum(g[:, 1:], R[:, :-1], out=g[:, 1:])
    np.maximum(g[:, :-1], R[:, 1:], out=g[:, :-1])
    return g


def _skiz(R, todo, iters):
    """grow class 1 (target) and 2 (other) into `todo` simultaneously; ties go to other."""
    for _ in range(iters):
        if not todo.any():
            break
        g = _dilate4(R)
        hit = todo & (g > 0)
        if not hit.any():
            break
        R[hit] = g[hit]
        todo &= ~hit
    return todo


class _Box:
    """bounding box of the target class, grown incrementally."""
    def __init__(self, shape, idx):
        self.H, self.W = shape
        self.b = None
        self.add(idx)

    def add(self, idx):
        if idx.size:
            ys, xs = idx // self.W, idx % self.W
            b = (int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max()))
            self.b = b if self.b is None else (min(self.b[0], b[0]), max(self.b[1], b[1]),
                                               min(self.b[2], b[2]), max(self.b[3], b[3]))

    def padded(self, pad):
        if self.b is None:
            return None
        y0, y1, x0, x1 = self.b
        return max(0, y0 - pad), min(self.H, y1 + pad + 1), max(0, x0 - pad), min(self.W, x1 + pad + 1)


def flood(F, tm, other, p, check=_nothing):
    """2-class flooding watershed on the ladder. tm: target marker; other: bool (H, W) other-class marker pixels
    (the labels are added here). Returns the target region."""
    free, L = F["free"], F["L"]
    H, W = free.shape
    R = np.zeros(free.shape, np.int8)
    R[~free] = 2
    R[other] = 2
    R[tm] = 1
    Rf = R.ravel()
    kW = _level(F, p["qW"]) if p["qW"] is not None else 10 ** 9
    tidx = np.flatnonzero(tm.ravel())
    oidx = np.flatnonzero(other.ravel() & free.ravel() & ~tm.ravel())
    U = np.flatnonzero((Rf == 0) & free.ravel())
    box = _Box(free.shape, tidx)
    hasT_prev = hasO_prev = None
    for k in range(len(F["qs"])):
        check()
        Lk = L[k].ravel()
        nc = F["ncs"][k]
        hasT = np.zeros(nc + 1, bool)
        hasT[Lk[tidx]] = True
        hasO = np.zeros(nc + 1, bool)
        hasO[Lk[oidx]] = True
        if hasO_prev is not None:     # nested level sets: flags propagate to the parent components
            hasT[F["par"][k][np.flatnonzero(hasT_prev)]] = True
            hasO[F["par"][k][np.flatnonzero(hasO_prev)]] = True
        if k >= kW:
            hasO |= F["wallc"][k]
        hasT[0] = hasO[0] = False
        lk = Lk[U]
        t1, o1 = hasT[lk], hasO[lk]
        newT = U[t1 & ~o1]
        Rf[newT] = 1
        Rf[U[o1 & ~t1]] = 2
        box.add(newT)
        cf = t1 & o1
        if cf.any():
            b = box.padded(p["pad"])
            if b is not None:
                y0, y1, x0, x1 = b
                ci = U[cf]
                cy, cx = ci // W, ci % W
                sel = (cy >= y0) & (cy < y1) & (cx >= x0) & (cx < x1)
                if sel.any():
                    conf = np.zeros((y1 - y0, x1 - x0), bool)
                    conf[cy[sel] - y0, cx[sel] - x0] = True
                    Rs = R[y0:y1, x0:x1]
                    before = Rs == 1
                    _skiz(Rs, conf, p["skiz"])
                    gy, gx = np.nonzero((Rs == 1) & ~before)
                    if gy.size:
                        box.add((gy + y0) * W + gx + x0)
        U = U[Rf[U] == 0]
        hasT_prev, hasO_prev = hasT, hasO
    rest = (R == 0) & free
    if rest.any():
        b = box.padded(p["pad"])
        if b is not None:
            y0, y1, x0, x1 = b
            _skiz(R[y0:y1, x0:x1], rest[y0:y1, x0:x1].copy(), p["fiters"])
    return R == 1


def finish(region, F, pts, p):
    free, m = F["free"], F["m"]
    region = ndimage.binary_fill_holes(region & free) & free
    rem = m > p["peel_t"]
    for _ in range(int(p["peel_k"])):
        edge = region & ~ndimage.binary_erosion(region, structure=S4, border_value=1) & rem
        if not edge.any():
            break
        region &= ~edge
    lab, k = ndimage.label(region, structure=S4)
    if k > 1:
        ids = {int(lab[y, x]) for x, y in pts if lab[y, x]}
        if not ids:
            sz = np.bincount(lab.ravel())
            sz[0] = 0
            ids = {int(sz.argmax())}
        region = np.isin(lab, list(ids))
    return ndimage.binary_fill_holes(region) & free


# ------------------------------------------------------------------ API
def segment(em, labels, pos, check=_nothing):
    if not pos:
        return np.zeros(np.shape(labels), bool)
    F = features(em, labels, P, check)
    H, W = F["free"].shape
    pts = [(int(np.clip(x, 0, W - 1)), int(np.clip(y, 0, H - 1))) for x, y in pos]
    tm, comp, _ = markers(F, pts, P)
    return finish(flood(F, tm, comp[F["cl"]], P, check), F, pts, P)
