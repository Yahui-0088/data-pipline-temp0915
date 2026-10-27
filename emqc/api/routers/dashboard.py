"""Server-rendered pages (Jinja2). Numbers come from the same serializers as the REST API."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from emqc.auth import ROLE_NAMES
from emqc.config import settings
from emqc.db.base import get_session
from emqc.db.models import AgentTrace, Block, Dataset, ETLMetric, ExportJob, QCBlock, QCFinding, QCRun, QCSlice, ServeLog, StreamSession

from emqc.qc import catalog
from emqc.qc.verdicts import not_false_positive, verdict_map

from ..serializers import block_to_dict, dataset_to_dict, export_job_to_dict, finding_to_dict, qcblock_to_dict, qcslice_to_dict, run_to_dict, stream_to_dict, trace_to_dict
from .auth import current_user, page_user, safe_next
from .qc import get_run_workflow, pipeline_dashboard, pipeline_status, run_graph, run_summary

router = APIRouter(tags=["dashboard"], include_in_schema=False)
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))


def _fmt(v, nd=2):
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def _pct(v):
    return "–" if v is None else f"{100 * v:.0f}%"


def _bytes(n):
    if n is None:
        return "–"
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {u}" if u == "B" else f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} PB"


_STATIC = Path(__file__).resolve().parents[1] / "static"


def _static_v(name: str) -> int:
    """Cache-buster for /static links: the file's mtime, so browsers pick up a changed stylesheet/script after a deploy."""
    try:
        return int((_STATIC / name).stat().st_mtime)
    except OSError:
        return 0


templates.env.globals["static_v"] = _static_v
templates.env.filters["fmt"] = _fmt
templates.env.filters["pct"] = _pct
templates.env.filters["bytes"] = _bytes
templates.env.globals["settings"] = settings
templates.env.globals["role_names"] = ROLE_NAMES


def _render(name: str, request: Request, **ctx):
    ctx.setdefault("workspace", "qc")  # which side of the shell the page belongs to: "qc" (cleaning) or "annotate"
    ctx.setdefault("user", current_user(request))  # 顶栏的用户菜单；没登录或没开登录时是 None
    return templates.TemplateResponse(request, name, ctx)


def _profile(s: Session, run_id: int) -> list[dict]:
    return [{"z": z, "block_id": b, "q": q, "sev": sev, "passed": p, "status": st} for z, b, q, sev, p, st in s.execute(select(QCSlice.z, QCSlice.block_id, QCSlice.quality_score, QCSlice.max_severity, QCSlice.passed, QCSlice.status).where(QCSlice.run_id == run_id).order_by(QCSlice.z, QCSlice.block_id)).all()]


SEV_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def _worst_per_z(profile: list[dict]) -> list[dict]:
    """Collapse tiles: for each z keep the worst tile (used for the compact dataset strips)."""
    best: dict[int, dict] = {}
    for p in profile:
        cur = best.get(p["z"])
        rank = 5 if p["status"] != "ok" else SEV_RANK.get(p["sev"], 0)
        if cur is None or rank > cur["_rank"]:
            best[p["z"]] = {**p, "_rank": rank}
    return [best[z] for z in sorted(best)]


# ----------------------------------------------------------------------------- visual summaries (run page, overview)

FAILURE_ZH = {
    "missing": "缺失切片", "corrupt": "损坏切片", "blank": "空白切片", "blur": "严重模糊", "saturation": "过曝 / 饱和",
    "crack": "裂缝 / 褶皱", "no_coverage": "无数据区", "missing_region": "缺块", "brightness_jump": "亮度突变",
    "contrast_drift": "对比度漂移", "charging": "荷电伪影", "contamination": "表面污染", "slice_jump": "切片跳变",
    "local_misalign": "局部错位", "global_misalign": "整体错位", "z_order": "顺序错误", "local_deformation": "局部形变",
    "section_deformation": "切片形变",
}


def _profile_chart(profile: list[dict], blocks: list[dict]) -> dict | None:
    """Worst tile per z -> points for the quality-along-depth chart, failed z's, labelled worst spots, grade bands."""
    worst = _worst_per_z(profile)
    if not worst:
        return None
    z0, z1 = worst[0]["z"], worst[-1]["z"]
    pts = [{"z": p["z"], "q": 0.0 if p["status"] != "ok" else (p["q"] if p["q"] is not None else 1.0), "sev": p["sev"] if p["status"] == "ok" else "critical",
            "status": p["status"], "passed": p["passed"]} for p in worst]
    # grade per z range: the worst tile grade in that range
    order = {"A": 0, "B": 1, "C": 2, "D": 3}
    bands: dict[tuple[int, int], str] = {}
    for b in blocks:
        g = b.get("grade")
        if not g:
            continue
        c = b.get("coordinate") or {}
        if c.get("z_start") is None:
            continue
        k = (c["z_start"], c["z_end"])
        if k not in bands or order.get(g, 0) > order.get(bands[k], 0):
            bands[k] = g
    n_failed = sum(1 for p in pts if not p["passed"])
    return {"z0": z0, "z1": z1, "points": pts, "n": len(pts), "n_failed": n_failed,
            "bands": [{"z_start": a, "z_end": b, "grade": g} for (a, b), g in sorted(bands.items())]}


def _viewer_items(rows, limit: int = 1500) -> list[dict]:
    """(failure_type, z, block_id, severity, check, score, preview_path, dataset_id, run_id) rows -> items for the
    one-by-one viewer (static/viewer.js). One item per stored crop and problem type, in z order."""
    from ..serializers import preview_url

    out, seen = [], set()
    for ft, z, bid, sev, chk, score, pp, ds_id, run_id in rows:
        url = preview_url(pp)
        if not url or (url, ft) in seen:
            continue
        seen.add((url, ft))
        tile = bid.split("_", 1)[1] if bid and "_" in bid else None
        out.append({"type": ft, "zh": FAILURE_ZH.get(ft, ft), "z": z, "dataset_id": ds_id, "block_id": bid, "tile": tile, "severity": sev,
                    "check": chk, "score": None if score is None else round(float(score), 3), "url": url, "run_id": run_id,
                    "href": f"/datasets/{ds_id}/blocks/{bid}?run_id={run_id}#z{z}"})
        if len(out) >= limit:
            break
    return out


def _gallery(s: Session, run_id: int, dataset_id: str, profile: list[dict], per_type: int = 4, max_types: int = 12) -> dict:
    """Flagged slices (high / critical, with a stored preview) grouped by failure type + one clean reference slice."""
    rows = s.execute(select(QCFinding.failure_type, QCFinding.z, QCFinding.block_id, QCFinding.severity, QCFinding.check_name, QCFinding.preview_path)
                     .where(QCFinding.run_id == run_id, QCFinding.severity.in_(["high", "critical"]), QCFinding.z.is_not(None))
                     .order_by(QCFinding.z)).all()
    from ..serializers import preview_url

    groups: dict[str, dict] = {}
    for ft, z, bid, sev, chk, pp in rows:
        g = groups.setdefault(ft, {"type": ft, "zh": FAILURE_ZH.get(ft, ft), "zs": set(), "shots": []})
        if z in g["zs"]:
            continue  # same section flagged in several tiles: show it once
        g["zs"].add(z)
        url = preview_url(pp)
        if url and len(g["shots"]) < per_type:
            g["shots"].append({"z": z, "block_id": bid, "severity": sev, "check": chk, "url": url})
    out = sorted(groups.values(), key=lambda g: -len(g["zs"]))[:max_types]
    for g in out:
        g["n"] = len(g.pop("zs"))
    # reference: the cleanest passed section closest to the middle of the volume
    worst = _worst_per_z(profile)
    clean = [p for p in worst if p["passed"] and p["status"] == "ok"]
    ref = None
    if clean:
        mid = (worst[0]["z"] + worst[-1]["z"]) / 2
        best = max(clean, key=lambda p: ((p["q"] or 0) >= 0.95, -abs(p["z"] - mid)))
        ref = {"z": best["z"], "url": f"/api/v1/data/{dataset_id}/preview/z/{best['z']}.png"}
    allrows = s.execute(select(QCFinding.failure_type, QCFinding.z, QCFinding.block_id, QCFinding.severity, QCFinding.check_name, QCFinding.score,
                               QCFinding.preview_path, QCFinding.dataset_id, QCFinding.run_id)
                        .where(QCFinding.run_id == run_id, QCFinding.severity.in_(["high", "critical"]), QCFinding.z.is_not(None))
                        .order_by(QCFinding.z, QCFinding.block_id)).all()
    return {"groups": out, "ref": ref, "n_types": len(groups), "n_sections": sum(g["n"] for g in out), "all": _viewer_items(allrows)}


# ----------------------------------------------------------------------------- pages


@router.get("/", response_class=HTMLResponse)
def index(request: Request, s: Session = Depends(get_session)):
    dss = list(s.scalars(select(Dataset).order_by(Dataset.dataset_id)))
    rows = []
    kpi = {"n_datasets": len(dss), "n_sections": 0, "n_blocks": 0, "passed": 0, "evaluated": 0, "grades": Counter(), "size": Counter()}
    for d in dss:
        dd = dataset_to_dict(d)
        kpi["n_sections"] += d.size_z
        kpi["n_blocks"] += len(d.blocks)
        kpi["size"][d.size_class] += 1
        for b in d.blocks:
            if b.latest_grade:
                kpi["grades"][b.latest_grade] += 1
        dd["strip"] = _worst_per_z(_profile(s, d.latest_run_id)) if d.latest_run_id else None
        dd["blocks_grades"] = Counter(b.latest_grade or "pending" for b in d.blocks)
        if d.latest_run_id:
            m = {x.metric_name: x.metric_value for x in s.scalars(select(ETLMetric).where(ETLMetric.run_id == d.latest_run_id, ETLMetric.block_id.is_(None)))}
            kpi["passed"] += m.get("n_slices_passed") or 0
            kpi["evaluated"] += m.get("n_slices_input") or 0
            dd["n_findings"] = m.get("n_findings")
        rows.append(dd)
    kpi["retention"] = (kpi["passed"] / kpi["evaluated"]) if kpi["evaluated"] else None
    # 顶部数字和问题样例默认只看「本次」= 最近一次完成的运行；?scope=all 看所有数据集各自最近一次运行的汇总
    scope = "all" if request.query_params.get("scope") == "all" else "latest"
    last_run = s.scalars(select(QCRun).where(QCRun.status == "done").order_by(QCRun.id.desc()).limit(1)).first()
    if last_run is None:
        scope = "all"
    this_run = run_summary(s, last_run) if last_run is not None else None
    if this_run is not None:
        ds_row = s.get(Dataset, last_run.dataset_id)
        this_run["dataset_size"] = {"z": ds_row.size_z, "y": ds_row.size_y, "x": ds_row.size_x, "size_class": ds_row.size_class} if ds_row else None
    latest_ids = select(Dataset.latest_run_id).where(Dataset.latest_run_id.is_not(None)) if scope == "all" else select(QCRun.id).where(QCRun.id == last_run.id)
    by_type = s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id.in_(latest_ids), QCFinding.severity.in_(["high", "critical"])).group_by(QCFinding.failure_type).order_by(func.count().desc())).all()
    runs = []
    for r in s.scalars(select(QCRun).order_by(QCRun.id.desc()).limit(100 if scope == "all" else 6)):
        rd = run_to_dict(r)
        rd["wall_s"] = (r.finished_at - r.started_at).total_seconds() if r.started_at and r.finished_at else None
        runs.append(rd)
    run_time = dict(s.execute(select(QCRun.id, QCRun.finished_at).where(QCRun.id.in_([d["latest_run_id"] for d in rows if d.get("latest_run_id")] or [-1]))).all())
    for dd in rows:
        t = run_time.get(dd.get("latest_run_id"))
        dd["latest_run_at"] = t.isoformat(sep=" ", timespec="minutes") if t else None
    n_served = s.scalar(select(func.count()).select_from(ServeLog)) or 0
    from ..serializers import preview_url

    flagged = _viewer_items(s.execute(
        select(QCFinding.failure_type, QCFinding.z, QCFinding.block_id, QCFinding.severity, QCFinding.check_name, QCFinding.score,
               QCFinding.preview_path, QCFinding.dataset_id, QCFinding.run_id)
        .where(QCFinding.run_id.in_(latest_ids), QCFinding.severity.in_(["high", "critical"]), QCFinding.preview_path.is_not(None), QCFinding.z.is_not(None))
        .order_by(QCFinding.dataset_id, QCFinding.z, QCFinding.block_id)).all())
    per_type = Counter(x["type"] for x in flagged)
    examples, used = [], set()
    for ft, _n in per_type.most_common():  # one card per type, preferring a section no other card shows
        cands = [x for x in flagged if x["type"] == ft]
        pick = next((x for x in cands if (x["dataset_id"], x["z"]) not in used), cands[0])
        used.add((pick["dataset_id"], pick["z"]))
        examples.append({**pick, "n": _n})
    by_type_zh = [(FAILURE_ZH.get(ft, ft), n) for ft, n in by_type]
    return _render("index.html", request, datasets=rows, kpi=kpi, failure_counts=by_type_zh, runs=runs, n_served=n_served, examples=examples, flagged=flagged, scope=scope, this_run=this_run, active="datasets")


@router.get("/datasets/{dataset_id}", response_class=HTMLResponse)
def dataset_page(dataset_id: str, request: Request, s: Session = Depends(get_session)):
    ds = s.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(404)
    d = dataset_to_dict(ds, with_children=True)
    run = s.get(QCRun, ds.latest_run_id) if ds.latest_run_id else None
    summary = run_summary(s, run) if run else None
    qc_blocks = {b["block_id"]: b for b in summary["blocks"]} if summary else {}
    profile = _profile(s, run.id) if run else []
    by_block: dict[str, list] = {}
    for p in profile:
        by_block.setdefault(p["block_id"], []).append(p)
    findings = [finding_to_dict(f) for f in s.scalars(select(QCFinding).where(QCFinding.run_id == run.id, QCFinding.severity.in_(["medium", "high", "critical"])).order_by(QCFinding.block_id, QCFinding.z).limit(300))] if run else []
    by_type = dict(s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id == run.id).group_by(QCFinding.failure_type).order_by(func.count().desc())).all()) if run else {}
    by_type_hi = dict(s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id == run.id, QCFinding.severity.in_(["high", "critical"])).group_by(QCFinding.failure_type)).all()) if run else {}
    by_sev = dict(s.execute(select(QCFinding.severity, func.count()).where(QCFinding.run_id == run.id).group_by(QCFinding.severity)).all()) if run else {}
    # per-check aggregate across blocks
    checks = catalog()
    check_summary = []
    for c in checks:
        mins, means, flagged, evaluated = [], [], 0, 0
        for q in qc_blocks.values():
            sc = (q.get("scores") or {}).get(c["name"])
            if sc:
                if sc.get("min") is not None:
                    mins.append(sc["min"])
                if sc.get("mean") is not None:
                    means.append(sc["mean"])
                flagged += sc.get("n_flagged") or 0
                evaluated += sc.get("n_evaluated") or 0
        check_summary.append({**c, "min": min(mins) if mins else None, "mean": (sum(means) / len(means)) if means else None, "n_flagged": flagged, "n_evaluated": evaluated})
    runs = [run_to_dict(r) for r in s.scalars(select(QCRun).where(QCRun.dataset_id == dataset_id).order_by(QCRun.id.desc()).limit(10))]
    traces = [trace_to_dict(t) for t in s.scalars(select(AgentTrace).where(AgentTrace.dataset_id == dataset_id).order_by(AgentTrace.id.desc()).limit(8))]
    assets_by_type: dict[str, list] = {}
    for a in d["assets"]:
        assets_by_type.setdefault(a["asset_type"], []).append(a)
    return _render("dataset.html", request, ds=d, run=summary, qc_blocks=qc_blocks, profile_by_block=by_block, findings=findings, by_type=by_type, by_type_hi=by_type_hi, by_sev=by_sev, check_summary=check_summary, runs=runs, traces=traces, assets_by_type=assets_by_type, active="datasets")


@router.get("/datasets/{dataset_id}/blocks/{block_id}", response_class=HTMLResponse)
def block_page(dataset_id: str, block_id: str, request: Request, run_id: int | None = None, s: Session = Depends(get_session)):
    ds = s.get(Dataset, dataset_id)
    blk = s.scalar(select(Block).where(Block.dataset_id == dataset_id, Block.block_id == block_id))
    if ds is None or blk is None:
        raise HTTPException(404)
    rid = run_id or ds.latest_run_id
    qcb = s.scalar(select(QCBlock).where(QCBlock.run_id == rid, QCBlock.block_id == block_id)) if rid else None
    slices = [qcslice_to_dict(x, with_stats=True) for x in s.scalars(select(QCSlice).where(QCSlice.run_id == rid, QCSlice.block_id == block_id).order_by(QCSlice.z))] if rid else []
    findings = [finding_to_dict(f) for f in s.scalars(select(QCFinding).where(QCFinding.run_id == rid, QCFinding.block_id == block_id).order_by(QCFinding.z, QCFinding.check_name))] if rid else []
    metrics = {m.metric_name: (m.extra_json if m.metric_name == "findings_by_type" else m.metric_value) for m in s.scalars(select(ETLMetric).where(ETLMetric.run_id == rid, ETLMetric.block_id == block_id, ETLMetric.stage == "aggregate"))} if rid else {}
    siblings = [block_to_dict(b) for b in s.scalars(select(Block).where(Block.dataset_id == dataset_id).order_by(Block.z_start, Block.y_start, Block.x_start))]
    by_sev = Counter(x["max_severity"] for x in slices)
    return _render("block.html", request, ds=dataset_to_dict(ds), block=block_to_dict(blk), siblings=siblings, qcb=qcblock_to_dict(qcb) if qcb else None, slices=slices, findings=findings, metrics=metrics, checks=catalog(), run_id=rid, by_sev=by_sev, active="datasets")


@router.get("/runs/{run_id}", response_class=HTMLResponse)
def run_page(run_id: int, request: Request, s: Session = Depends(get_session)):
    run = s.get(QCRun, run_id)
    if run is None:
        raise HTTPException(404)
    metrics = list(s.scalars(select(ETLMetric).where(ETLMetric.run_id == run_id).order_by(ETLMetric.block_id, ETLMetric.stage, ETLMetric.metric_name)))
    per_block: dict[str, dict] = {}
    for m in metrics:
        if m.block_id:
            per_block.setdefault(m.block_id, {})[f"{m.stage}:{m.metric_name}" if m.metric_name == "stage_duration_s" else m.metric_name] = m.extra_json if m.metric_name == "findings_by_type" else m.metric_value
    ds = s.get(Dataset, run.dataset_id)
    blocks = [block_to_dict(b) for b in s.scalars(select(Block).where(Block.dataset_id == run.dataset_id).order_by(Block.z_start, Block.y_start, Block.x_start))]
    summary = run_summary(s, run)
    qc_blocks = {b["block_id"]: b for b in summary["blocks"]}
    max_dur = max([b.get("duration_s") or 0 for b in summary["blocks"]] + [1])
    prof = _profile(s, run_id)
    chart = _profile_chart(prof, summary["blocks"])
    gallery = _gallery(s, run_id, run.dataset_id, prof) if prof else None
    return _render("run.html", request, run=summary, graph=run_graph(s, run), per_block=per_block, ds=dataset_to_dict(ds) if ds else None, blocks=blocks, qc_blocks=qc_blocks, max_dur=max_dur,
                   chart=chart, gallery=gallery, failure_zh=FAILURE_ZH, active="runs")


@router.get("/runs", response_class=HTMLResponse)
def runs_page(request: Request, s: Session = Depends(get_session)):
    runs = [run_to_dict(r) for r in s.scalars(select(QCRun).order_by(QCRun.id.desc()).limit(100))]
    by_status = Counter(r["status"] for r in runs)
    return _render("runs.html", request, runs=runs, by_status=by_status, active="runs")


@router.get("/checks", response_class=HTMLResponse)
def checks_page(request: Request):
    return _render("checks.html", request, checks=catalog(), active="checks")


@router.get("/traces", response_class=HTMLResponse)
def traces_page(request: Request, s: Session = Depends(get_session)):
    traces = [trace_to_dict(t) for t in s.scalars(select(AgentTrace).order_by(AgentTrace.id.desc()).limit(200))]
    served = list(s.scalars(select(ServeLog).order_by(ServeLog.id.desc()).limit(100)))
    served_kinds = Counter(x.kind for x in served)
    return _render("traces.html", request, traces=traces, served=served, served_kinds=served_kinds, active="traces")


# 总览页：左边 LangGraph 流程图，右边每一步的产出（手风琴）。数字全部来自 pipeline_dashboard（和旧的仪表盘同一个数据源）
SERIAL_TYPES = {"contrast_drift", "brightness_jump", "slice_jump", "global_misalign"}
OVERVIEW_STEPS = [  # (节点 id, 类型, 标题, 说明)
    ("prepare", "NODE", "准备 · 打开数据", "打开数据集，读元数据，按 z 段和 tile 切分任务。"),
    ("ingest", "NODE", "读取 · 统计", "逐段读入图像，计算亮度、对比度等基础统计，供后面的检查使用。"),
    ("slice_qc", "NODE", "切片检查", "单张切片自己的问题：空白、模糊、过曝、损坏、污染、形变。"),
    ("serial_qc", "NODE", "序列检查", "相邻切片之间的问题：对比度漂移、亮度突变、切片跳变、整体错位。"),
    ("aggregate", "NODE", "汇总 · 分级", "把问题汇总到每个 tile，打质量分、定等级，算出能用于训练的切片比例。"),
    ("persist", "BRANCH", "落库", "写入问题记录和 tile 结果；还有 tile 回到切片检查，本段查完进入本段完成。"),
    ("finalize", "NODE", "结果汇总", "整个数据集跑完：前面每一步的结果都放在这里一起看。"),
]


def _overview_ctx(s: Session, run_id: int | None = None) -> dict:
    """run_id：总览页显示哪一次运行（从运行记录点过来的）；不给 / 找不到就是最新一次。整页（舞台、流程图角标、问题切片、导出数据包）都围绕这一次。"""
    d = pipeline_dashboard(days=0, dataset_id=None, s=s)
    kpi, runs = d["kpi"], d["runs"]
    newest = max(runs, key=lambda r: (r.get("finished_at") or "", r["run_id"])) if runs else None
    latest = next((r for r in runs if r["run_id"] == run_id), None) or newest
    is_latest = latest is newest
    pct = lambda x: "–" if x is None else f"{x * 100:.1f}%"
    secs = lambda x: "–" if x is None else (f"{x:.2f} s" if x < 10 else f"{x:.1f} s")
    st = (latest or {}).get("stages") or {}
    wall = (latest or {}).get("wall_s") or 0
    n_tiles = sum(((latest or {}).get("grades") or {}).values())
    fails = d["failures"]
    # 这次运行自己的问题，按类型拆成「单张切片」和「相邻切片之间」两组（和落库写入的条数对得上）
    own = s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id == latest["run_id"], not_false_positive()).group_by(QCFinding.failure_type).order_by(func.count().desc())).all() if latest else []
    own_f = [{"type": ft, "zh": FAILURE_ZH.get(ft, ft), "n": n} for ft, n in own]
    slice_f = [f for f in own_f if f["type"] not in SERIAL_TYPES]
    serial_f = [f for f in own_f if f["type"] in SERIAL_TYPES]
    grades = (latest or {}).get("grades") or {}
    grade_txt = " · ".join(f"{g} {grades[g]}" for g in sorted(grades)) or "–"
    ds_grade = next((x["grade"] for x in d["datasets"] if latest and x["run_id"] == latest["run_id"]), None)
    share = lambda k: f"{st[k] / wall * 100:.0f}%" if wall and st.get(k) else "–"
    items = {
        "prepare": [("切片", f"{int(latest['n_sections'])}" if latest else "–"), ("tile", str(n_tiles or "–")), ("读取量", f"{latest['bytes_read'] / 1e6:.1f} MB" if latest and latest.get("bytes_read") else "–")],
        "ingest": [("耗时", secs(st.get("ingest"))), ("吞吐", f"{latest['sections_per_s']:.1f} 张/s" if latest and latest.get("sections_per_s") else "–"), ("占这次运行", share("ingest"))],
        # 切片检查只写单张切片的问题，序列检查只写相邻切片之间的问题
        "slice_qc": ([("单张问题", str(sum(f["n"] for f in slice_f)))] + [(f["zh"], str(f["n"])) for f in slice_f[:3]]) if slice_f else [("单张问题", "0")],
        "serial_qc": ([("序列问题", str(sum(f["n"] for f in serial_f)))] + [(f["zh"], str(f["n"])) for f in serial_f[:3]]) if serial_f else [("序列问题", "0")],
        "aggregate": [("可用比例", pct((latest or {}).get("retention"))), ("质量分", f"{latest['quality']:.2f}" if latest and latest.get("quality") is not None else "–"), ("tile 等级", grade_txt)],
        "persist": [("写入问题", f"{int(latest['n_findings'])} 条" if latest else "–"), ("写入 tile", str(n_tiles or "–"))],
        "finalize": [("数据集等级", ds_grade or "–"), ("总耗时", secs(wall or None))],
    }
    loop = {"slice_qc", "serial_qc", "aggregate", "persist"}
    steps = []
    for nid, kind, title, desc in OVERVIEW_STEPS:
        tag = ["条件分支" if kind == "BRANCH" else "节点"]
        if nid in loop and n_tiles:
            tag.append(f"每个 tile 一次，共 {n_tiles} 次")
        if st.get(nid) is not None:
            tag.append(("累计 " if nid in loop else "") + secs(st[nid]))
        steps.append({"id": nid, "tag": " · ".join(tag), "title": title, "desc": desc, "rows": items[nid]})
    # 标题下面那一句：这次运行最要紧的结论（能不能用、问题出在哪）
    finding = []  # 标题下面的几点：这次运行最要紧的结论（能不能用、问题出在哪），一行一点
    if latest:
        top = max(fails, key=lambda f: f["n"])["zh"] if fails else None
        finding = [f"{'最新运行' if is_latest else '运行'} #{latest['run_id']}（{latest['dataset_id']}）",
                   f"{pct(latest.get('retention'))} 的切片可用于训练"]
        if ds_grade:
            finding.append(f"数据集等级 {ds_grade}")
        finding.append(f"{int(latest['n_findings'])} 条问题" + (f"，最多的是{top}" if top else ""))
    node_time = {k: secs(v) for k, v in st.items()}
    # 舞台：7 步按顺序，每步的累计秒数（来自这次运行的 LangGraph 节点记录）和跑到这一步为止的进度
    stage = []
    if latest:
        try:
            wf = get_run_workflow(latest["run_id"], after_id=0, limit=0, s=s)["nodes"]
        except Exception:  # 老的运行没有节点记录：用阶段耗时
            wf = {}
        secs_of = {nid: (wf.get(nid) or {}).get("total_s", st.get(nid)) or 0.0 for nid, *_ in OVERVIEW_STEPS}
        total = sum(secs_of.values()) or 1.0
        acc = 0.0
        for nid, kind, title, desc in OVERVIEW_STEPS:
            acc += secs_of[nid]
            stage.append({"id": nid, "title": title, "desc": desc, "s": round(secs_of[nid], 2), "at": round(acc, 2), "p": round(acc / total, 4),
                          "rows": items[nid]})  # 这一步的结果：跑完以后列在进度条下面
    datasets = [x for (x,) in s.execute(select(Dataset.dataset_id).order_by(Dataset.dataset_id)).all()]
    # 问题图片墙：这一次运行里真实存下来的问题截图，按问题类型分行（问题多的在上，最多 12 行、每行最多 40 张）。
    # 每行标上它属于流程图的哪一步（切片检查 / 序列检查），点流程图节点时按这个筛选；每张带上人已经下过的判断（确认 / 误报）。
    wall = []
    if latest:
        rows = s.execute(select(QCFinding.failure_type, QCFinding.z, QCFinding.block_id, QCFinding.severity, QCFinding.check_name, QCFinding.score,
                                QCFinding.preview_path, QCFinding.dataset_id, QCFinding.run_id)
                         .where(QCFinding.run_id == latest["run_id"], QCFinding.preview_path.is_not(None), QCFinding.z.is_not(None))  # 只要切片（整块的问题不在这里判）
                         .order_by(QCFinding.z, QCFinding.block_id)).all()
        vmap = verdict_map(s, latest["run_id"])
        by_type: dict[str, list] = {}
        for it in _viewer_items(rows, limit=5000):
            by_type.setdefault(it["type"], []).append(it)
        for ft, its in sorted(by_type.items(), key=lambda kv: -len(kv[1]))[:12]:
            wall.append({"type": ft, "zh": FAILURE_ZH.get(ft, ft), "n": len(its), "step": "serial_qc" if ft in SERIAL_TYPES else "slice_qc",
                         "items": [{"url": i["url"], "z": i["z"], "dataset_id": i["dataset_id"], "block_id": i["block_id"], "run_id": i["run_id"],
                                    "href": i["href"], "v": vmap.get((i["block_id"], i["z"], ft))} for i in its[:40]]})
    # 流程图节点右上角的小标：这一步查出来的问题数（和舞台上这一步的结果是同一个数）、分级结果
    badges = {"slice_qc": sum(f["n"] for f in slice_f), "serial_qc": sum(f["n"] for f in serial_f)} if latest else {}
    if latest and grades:
        badges["aggregate"] = " ".join(f"{g}{grades[g]}" for g in sorted(grades))
    return {
        "stage": stage, "datasets": datasets, "wall": wall, "badges": badges, "is_latest": is_latest, "newest": newest,
        "kpi": kpi, "latest": latest, "steps": steps, "finding": finding, "node_time": node_time, "n_tiles": n_tiles, "ds_grade": ds_grade,
        "runs": sorted(runs, key=lambda r: r["run_id"], reverse=True)[:8], "delivery": d["delivery"],
        # 运行记录图：最近 24 次运行，按时间从旧到新
        "run_series": [{"id": r["run_id"], "ds": r["dataset_id"], "at": (r.get("finished_at") or "")[5:].replace("T", " "), "t": r.get("finished_at"), "n": int(r.get("n_sections") or 0),
                        "f": int(r.get("n_findings") or 0), "keep": r.get("retention"), "s": r.get("wall_s")}
                       for r in sorted(runs, key=lambda r: r["run_id"])[-24:]],
        "pct": pct, "secs": secs, "fmt_mb": lambda b: f"{(b or 0) / 1e6:.1f} MB",
    }


@router.get("/overview", response_class=HTMLResponse)
def overview_page(request: Request, run: int | None = None, s: Session = Depends(get_session)):
    return _render("overview.html", request, active="overview", fail_meta={"zh": FAILURE_ZH, "serial": sorted(SERIAL_TYPES)}, **_overview_ctx(s, run))


@router.get("/overview/classic", response_class=HTMLResponse)
def overview_classic_page(request: Request):
    """旧的指标仪表盘（筛选、图表、数据表），从新总览页的「详细仪表盘」进来。"""
    return _render("overview_classic.html", request, active="overview")


@router.get("/pipeline", response_class=HTMLResponse)
def pipeline_page(request: Request, s: Session = Depends(get_session)):
    status = pipeline_status(s)
    datasets = [dataset_to_dict(d) for d in s.scalars(select(Dataset).order_by(Dataset.dataset_id))]
    recent = [run_to_dict(r) for r in s.scalars(select(QCRun).where(QCRun.status.in_(["done", "error", "cancelled"])).order_by(QCRun.id.desc()).limit(12))]
    return _render("pipeline.html", request, status=status, datasets=datasets, checks=catalog(), recent=recent, active="pipeline")


@router.get("/delivery", response_class=HTMLResponse)
def delivery_page(request: Request, dataset: str | None = None, s: Session = Depends(get_session)):
    datasets = [dataset_to_dict(d) for d in s.scalars(select(Dataset).order_by(Dataset.dataset_id))]
    base = str(request.base_url).rstrip("/")
    if not dataset:  # default to a dataset that already has QC results
        dataset = next((d["dataset_id"] for d in datasets if d["latest_run_id"]), datasets[0]["dataset_id"] if datasets else None)
    # 每个数据集能「一并拷贝」的资产：除了原图本身以外的 image_stack（导出时按同一批 z 原样复制）
    from emqc.db.models import DatasetAsset
    assets: dict[str, list[str]] = {}
    for a in s.scalars(select(DatasetAsset).order_by(DatasetAsset.asset_type)):
        if (a.format or "").startswith("image_stack") and a.asset_type != "em_image":
            assets.setdefault(a.dataset_id, []).append(a.asset_type)
    return _render("delivery_v2.html", request, datasets=datasets, preselect=dataset, assets=assets, export_dir=str(settings.export_dir), api_base=base, active="delivery")


@router.get("/delivery/classic", response_class=HTMLResponse)
def delivery_classic_page(request: Request, dataset: str | None = None, s: Session = Depends(get_session)):
    """旧版交付页（完整的导出预览表、任务列表和推理流子块地图），新版页面右上角「详细版」进来。"""
    datasets = [dataset_to_dict(d) for d in s.scalars(select(Dataset).order_by(Dataset.dataset_id))]
    jobs = [export_job_to_dict(j) for j in s.scalars(select(ExportJob).order_by(ExportJob.id.desc()).limit(20))]
    sessions = [stream_to_dict(x) for x in s.scalars(select(StreamSession).order_by(StreamSession.id.desc()).limit(30))]
    base = str(request.base_url).rstrip("/")
    if not dataset:
        dataset = next((d["dataset_id"] for d in datasets if d["latest_run_id"]), datasets[0]["dataset_id"] if datasets else None)
    return _render("delivery.html", request, datasets=datasets, jobs=jobs, sessions=sessions, preselect=dataset, export_dir=str(settings.export_dir), api_base=base, active="delivery")


@router.get("/report", response_class=HTMLResponse)
def galaxy_page(request: Request):
    """汇报工作区的落地页：数据星球（3D 粒子星球，每片区域一个数据集，绿 = 已处理，灰 = 未处理；可用手势控制视角）。
    数据走 /api/v1/report/data（同样按账号的项目范围过滤）。"""
    return _render("galaxy.html", request, active="report")


@router.get("/report/summary", response_class=HTMLResponse)
def report_page(request: Request, project: str | None = None, s: Session = Depends(get_session)):
    """给老板看的汇报详情页。汇报账号登录后只能进汇报工作区（/report、/report/…），只看分配给它的项目。"""
    from .report import allowed_projects

    projects, limited = allowed_projects(request, s)
    if project and project not in projects:
        project = None
    return _render("report.html", request, projects=projects, limited=limited, selected=project, active="report")


@router.get("/training", response_class=HTMLResponse)
def training_page(request: Request, dataset: str | None = None, s: Session = Depends(get_session)):
    datasets = [dataset_to_dict(d) for d in s.scalars(select(Dataset).order_by(Dataset.dataset_id))]
    return _render("training.html", request, datasets=datasets, selected=dataset, active="training")


@router.get("/patches", response_class=HTMLResponse)
def patches_page(request: Request, dataset: str | None = None, s: Session = Depends(get_session)):
    from emqc.db.models import PATCH_TYPES

    datasets = [dataset_to_dict(d) for d in s.scalars(select(Dataset).order_by(Dataset.dataset_id))]
    if not dataset:
        dataset = next((d["dataset_id"] for d in datasets if d["latest_run_id"]), datasets[0]["dataset_id"] if datasets else None)
    base = str(request.base_url).rstrip("/")
    return _render("patches.html", request, datasets=datasets, preselect=dataset, types=list(PATCH_TYPES), api_base=base, active="patches")


@router.get("/crawl", response_class=HTMLResponse)
def crawl_page(request: Request, s: Session = Depends(get_session)):
    from emqc.api.routers.crawl import PRESETS

    return _render("crawl.html", request, presets=PRESETS, active="crawl")


# ----------------------------------------------------------------------------- annotation workspace
# Separate shell: its own nav, top bar and accent colour. Shares the service and the stylesheet with the QC pages.


@router.get("/annotate", response_class=HTMLResponse)
def annotate_page(request: Request, block: str | None = None, user=Depends(page_user)):
    return _render("annotate.html", request, preselect=block, active="workbench", workspace="annotate")


@router.get("/annotate/compare", response_class=HTMLResponse)
def annotate_compare_page(request: Request, user=Depends(page_user)):
    return _render("annotate_compare.html", request, active="compare", workspace="annotate")


@router.get("/annotate/review", response_class=HTMLResponse)
def annotate_review_page(request: Request, user=Depends(page_user)):
    """审核进度：每个数据块每一片的状态、改动人、审核意见；标注员在这里按范围标记完成，审核员在这里入库。"""
    return _render("annotate_review.html", request, active="review", workspace="annotate")


@router.get("/annotate/guide", response_class=HTMLResponse)
def annotate_guide_page(request: Request, user=Depends(page_user)):
    return _render("annotate_guide.html", request, workdir=str(settings.annotate_workdir), sam_dir=str(settings.sam_blocks_dir), active="guide", workspace="annotate")


# ----------------------------------------------------------------------------- 登录 / 账号 / 用户管理
@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, next: str = "/annotate"):
    if settings.auth_disabled:
        return RedirectResponse(safe_next(next), status_code=303)
    if current_user(request) is not None:
        return RedirectResponse(safe_next(next), status_code=303)
    from emqc import __version__

    return templates.TemplateResponse(request, "login.html", {"next": safe_next(next), "version": __version__})


@router.get("/account", response_class=HTMLResponse)
def account_page(request: Request, force: int = 0, user=Depends(page_user)):
    if settings.auth_disabled:
        return RedirectResponse("/annotate", status_code=303)
    return _render("account.html", request, force=bool(force), active="account", workspace="annotate")


@router.get("/annotate/users", response_class=HTMLResponse)
def users_page(request: Request, user=Depends(page_user)):
    if settings.auth_disabled:
        raise HTTPException(404, "这个实例没有开启登录（EMQC_AUTH_DISABLED=1），没有账号可管")
    if user.role != "admin":
        raise HTTPException(403, "只有管理员能管理账号")
    return _render("users.html", request, active="users", workspace="annotate")


@router.get("/annotate/logs", response_class=HTMLResponse)
def logs_page(request: Request, user=Depends(page_user)):
    if user is not None and user.role != "admin":
        raise HTTPException(403, "只有管理员能看运行日志")
    return _render("annotate_logs.html", request, active="logs", workspace="annotate")
