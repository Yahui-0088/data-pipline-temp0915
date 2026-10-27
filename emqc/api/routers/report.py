"""汇报页的数据：按项目隔离。

汇报账号（role=reporter）只能看分配给它的项目（users.projects，对应 datasets.project），其他账号和不登录时不限。
所有数字都只从这些项目的数据集里算；问题样例图也走这里的接口取，会先核对图所属的数据集在不在范围内——
汇报账号碰不到 /previews 和其他任何接口（见 auth.gate）。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from emqc import auth
from emqc.config import settings
from emqc.db.base import get_session
from emqc.db.models import Block, Dataset, ETLMetric, ExportJob, QCFinding, QCRun, StreamSession

from .auth import current_user

router = APIRouter(prefix="/api/v1/report", tags=["report"])

SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def allowed_projects(request: Request, s: Session) -> tuple[list[str], bool]:
    """(这个人能选的项目, 是否受限)。受限 = 汇报账号，只能是它被分配的那些。"""
    scope = auth.report_scope(current_user(request))
    existing = [p for (p,) in s.execute(select(Dataset.project).distinct().order_by(Dataset.project)).all()]
    if scope is None:
        return [p or "" for p in existing], False
    return scope, True


def _scoped_datasets(request: Request, s: Session, project: str | None) -> tuple[list[Dataset], list[str], bool]:
    projects, limited = allowed_projects(request, s)
    if project is not None and project != "" and project not in projects:
        raise HTTPException(403, {"code": "forbidden", "message": "没有这个项目的查看权限"})
    want = [project] if project else projects
    q = select(Dataset).order_by(Dataset.dataset_id)
    if limited or project:
        q = q.where(Dataset.project.in_(want or ["\x00"]))
    return list(s.scalars(q)), projects, limited


def _week_start(d: datetime) -> datetime:
    d = d.replace(hour=0, minute=0, second=0, microsecond=0)
    return d - timedelta(days=d.weekday())


@router.get("/data")
def report_data(request: Request, project: str | None = None, weeks: int = 8, s: Session = Depends(get_session)):
    """汇报页一次要的全部数字：现状、按周趋势、本周 vs 上周、交付、问题类型与样例。"""
    from .dashboard import FAILURE_ZH

    weeks = max(2, min(int(weeks), 26))
    dss, projects, limited = _scoped_datasets(request, s, project)
    ids = [d.dataset_id for d in dss]
    now = _now()
    w0 = _week_start(now) - timedelta(weeks=weeks - 1)

    # ---- 现状：每个数据集最近一次运行
    latest = [d.latest_run_id for d in dss if d.latest_run_id]
    m_latest: dict[int, dict] = {}
    for m in s.scalars(select(ETLMetric).where(ETLMetric.run_id.in_(latest or [-1]), ETLMetric.block_id.is_(None))):
        m_latest.setdefault(m.run_id, {})[m.metric_name] = m.metric_value
    grades: dict[str, int] = {}
    for g, n in s.execute(select(Block.latest_grade, func.count()).where(Block.dataset_id.in_(ids or ["\x00"]), Block.latest_grade.is_not(None)).group_by(Block.latest_grade)):
        grades[g] = n
    table, tot, kept = [], 0.0, 0.0
    last_run_at = {r.id: r.finished_at for r in s.scalars(select(QCRun).where(QCRun.id.in_(latest or [-1])))}
    for d in dss:
        n = (m_latest.get(d.latest_run_id) or {}).get("n_slices_input") if d.latest_run_id else None
        if n and d.latest_retention_rate is not None:
            tot += n
            kept += n * d.latest_retention_rate
        t = last_run_at.get(d.latest_run_id)
        table.append({"dataset_id": d.dataset_id, "project": d.project, "grade": d.latest_grade, "retention": d.latest_retention_rate, "quality": d.latest_quality_score,
                      "n_sections": n, "n_blocks": len(d.blocks), "last_run": t.isoformat(timespec="minutes") if t else None})
    sev_latest = dict(s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id.in_(latest or [-1]), QCFinding.severity.in_(["high", "critical"])).group_by(QCFinding.failure_type)).all())
    failures = sorted(({"type": t, "zh": FAILURE_ZH.get(t, t), "n": n} for t, n in sev_latest.items()), key=lambda x: -x["n"])

    # ---- 问题样例：前 6 类问题，每类最多 3 张有证据图的
    examples = []
    for f in failures[:6]:
        rows = list(s.scalars(select(QCFinding).where(QCFinding.run_id.in_(latest or [-1]), QCFinding.failure_type == f["type"], QCFinding.preview_path.is_not(None),
                                                       QCFinding.severity.in_(["high", "critical"])).order_by(QCFinding.score, QCFinding.id).limit(40)))
        rows.sort(key=lambda x: (SEV_RANK.get(x.severity, 9), x.score if x.score is not None else 1))
        seen, shots = set(), []
        for x in rows:
            if (x.dataset_id, x.z) in seen:
                continue
            seen.add((x.dataset_id, x.z))
            shots.append({"finding_id": x.id, "dataset_id": x.dataset_id, "z": x.z, "severity": x.severity, "thumb": f"/api/v1/report/thumb/{x.id}"})
            if len(shots) >= 3:
                break
        if shots:
            examples.append({**f, "shots": shots})

    # ---- 按周：QC 运行
    runs = list(s.scalars(select(QCRun).where(QCRun.dataset_id.in_(ids or ["\x00"]), QCRun.status == "done", QCRun.finished_at >= w0 - timedelta(days=7))))
    rids = [r.id for r in runs]
    m_runs: dict[int, dict] = {}
    for m in s.scalars(select(ETLMetric).where(ETLMetric.run_id.in_(rids or [-1]), ETLMetric.block_id.is_(None))):
        m_runs.setdefault(m.run_id, {})[m.metric_name] = m.metric_value
    probs = dict(s.execute(select(QCFinding.run_id, func.count()).where(QCFinding.run_id.in_(rids or [-1]), QCFinding.severity.in_(["high", "critical"])).group_by(QCFinding.run_id)).all())
    keys = [(w0 + timedelta(weeks=i)) for i in range(weeks)]
    wk = {k: {"week": k.date().isoformat(), "runs": 0, "sections": 0.0, "kept": 0.0, "problems": 0, "delivered": 0, "datasets": set()} for k in keys}
    for r in runs:
        k = _week_start(r.finished_at)
        if k not in wk:
            continue
        n = (m_runs.get(r.id) or {}).get("n_slices_input") or 0
        b = wk[k]
        b["runs"] += 1
        b["sections"] += n
        b["kept"] += n * (r.retention_rate or 0)
        b["problems"] += probs.get(r.id, 0)
        b["datasets"].add(r.dataset_id)

    # ---- 交付（训练分片 + 训练数据包 + 推理流）
    exports = list(s.scalars(select(ExportJob).where(ExportJob.dataset_id.in_(ids or ["\x00"]), ExportJob.status == "done")))
    streams = list(s.scalars(select(StreamSession).where(StreamSession.dataset_id.in_(ids or ["\x00"]))))
    for j in exports:
        if j.finished_at and _week_start(j.finished_at) in wk:
            wk[_week_start(j.finished_at)]["delivered"] += j.n_sections or 0
    packs = [j for j in exports if (j.params_json or {}).get("kind") == "pack"]
    shards = [j for j in exports if (j.params_json or {}).get("kind") != "pack"]
    delivery = {"shard_sections": sum(j.n_sections or 0 for j in shards), "shard_bytes": sum(j.n_bytes or 0 for j in shards), "n_shard_jobs": len(shards),
                "pack_samples": sum(j.n_sections or 0 for j in packs), "pack_bytes": sum(j.n_bytes or 0 for j in packs), "n_packs": len(packs),
                "stream_chunks": sum(x.n_acked or 0 for x in streams), "stream_bytes": sum(x.n_bytes or 0 for x in streams), "n_streams": len(streams)}

    trend = []
    for k in keys:
        b = wk[k]
        trend.append({"week": b["week"], "runs": b["runs"], "sections": int(b["sections"]), "retention": (b["kept"] / b["sections"]) if b["sections"] else None,
                      "problems": b["problems"], "delivered": b["delivered"], "datasets": len(b["datasets"])})
    this, prev = trend[-1], trend[-2]
    return {"projects": projects, "limited": limited, "project": project or None, "generated_at": now.isoformat(timespec="minutes") + "Z", "weeks": weeks,
            "kpi": {"n_datasets": len(dss), "n_datasets_qc": len(latest), "n_sections": int(tot), "retention": (kept / tot) if tot else None, "n_kept": int(kept),
                    "n_problems": sum(sev_latest.values()), "grades": grades, "n_blocks": sum(grades.values())},
            "wow": {"this": this, "prev": prev}, "trend": trend, "datasets": table, "failures": failures, "examples": examples, "delivery": delivery}


@router.get("/thumb/{finding_id}")
def report_thumb(finding_id: int, request: Request, s: Session = Depends(get_session)):
    """一张问题样例图。先核对它属于能看的项目，再从预览目录里取文件。"""
    f = s.get(QCFinding, finding_id)
    if f is None or not f.preview_path:
        raise HTTPException(404, "没有这张图")
    ds = s.get(Dataset, f.dataset_id)
    projects, limited = allowed_projects(request, s)
    if ds is None or (limited and ds.project not in projects):
        raise HTTPException(404, "没有这张图")          # 不说「没权限」：不让人借此探测别的项目里有什么
    p = Path(f.preview_path).resolve()
    root = Path(settings.preview_dir).resolve()
    if root not in p.parents or not p.is_file():
        raise HTTPException(404, "没有这张图")
    return FileResponse(p, headers={"Cache-Control": "private, max-age=3600"})


# ----------------------------------------------------------------------------- 汇报页的数据流程图（/report）
@router.get("/flow")
def report_flow(request: Request, s: Session = Depends(get_session)):
    """/report 流程图要的全部真实数据：采集 → 数据集 → 清洗 → 问题图片 / 合格 → 汇总分级 → 2D / 3D 段 / 3D patch → 数据包 → 交付。
    只看这个账号能看的项目（汇报账号 = 分配给它的项目）。数字都来自平台已有的表，不做任何估算。"""
    from emqc.api.routers.crawl import PRESETS
    from emqc.db.models import CrawlJob, QCSlice
    from emqc.qc import catalog
    from emqc.qc.verdicts import not_false_positive

    from .dashboard import FAILURE_ZH, SERIAL_TYPES
    from .qc import pipeline_dashboard

    base = report_data(request, None, 8, s)
    dss, _, _ = _scoped_datasets(request, s, None)
    ids = [d.dataset_id for d in dss] or ["\x00"]

    # 最新一次完成的运行（流程图中间那一段就讲它）
    run = s.scalars(select(QCRun).where(QCRun.dataset_id.in_(ids), QCRun.status == "done").order_by(QCRun.finished_at.desc(), QCRun.id.desc())).first()
    runs_all = [r for r in pipeline_dashboard(days=0, dataset_id=None, s=s)["runs"] if r["dataset_id"] in ids]
    latest = None
    if run:
        info = next((r for r in runs_all if r["run_id"] == run.id), {})
        n_slices = s.scalar(select(func.count()).select_from(QCSlice).where(QCSlice.run_id == run.id)) or 0
        n_passed = s.scalar(select(func.count()).select_from(QCSlice).where(QCSlice.run_id == run.id, QCSlice.passed.is_(True))) or 0
        n_unread = s.scalar(select(func.count()).select_from(QCSlice).where(QCSlice.run_id == run.id, QCSlice.status != "ok")) or 0
        hi = dict(s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id == run.id, QCFinding.severity.in_(["high", "critical"]), not_false_positive())
                            .group_by(QCFinding.failure_type)).all())
        n_find = s.scalar(select(func.count()).select_from(QCFinding).where(QCFinding.run_id == run.id, not_false_positive())) or 0
        n_shots = s.scalar(select(func.count()).select_from(QCFinding).where(QCFinding.run_id == run.id, QCFinding.preview_path.is_not(None))) or 0
        latest = {"run_id": run.id, "dataset_id": run.dataset_id, "finished_at": run.finished_at.isoformat(timespec="minutes") if run.finished_at else None,
                  "n_slices": n_slices, "n_passed": n_passed, "n_failed": n_slices - n_passed, "n_unreadable": n_unread, "retention": run.retention_rate,
                  "quality": run.quality_score, "grades": run.grade_counts_json or {}, "n_findings": n_find, "n_shots": n_shots, "n_blocks": run.n_blocks,
                  "failures": sorted(({"type": t, "zh": FAILURE_ZH.get(t, t), "n": n, "step": "serial_qc" if t in SERIAL_TYPES else "slice_qc"} for t, n in hi.items()), key=lambda x: -x["n"]),
                  "stages": info.get("stages") or {}, "wall_s": info.get("wall_s")}

    # 数据包：最新那次运行的数据集，能做哪些格子、各多少样本（不写任何东西）
    plan = None
    if run:
        from emqc.patches.pack import plan_pack

        try:
            p = plan_pack(s, s.get(Dataset, run.dataset_id), {})
            plan = {"dataset_id": p["dataset_id"], "tasks": p["tasks"], "levels": p["levels"],
                    "cells": [{k: c.get(k) for k in ("task", "level", "applicable", "ready", "reason", "n", "est_bytes")} for c in p["cells"]]}
        except Exception as e:  # 数据集文件不在了之类：流程图照样画，只是这一格说明原因
            plan = {"dataset_id": run.dataset_id, "error": f"{type(e).__name__}: {e}"}

    exports = list(s.scalars(select(ExportJob).where(ExportJob.dataset_id.in_(ids)).order_by(ExportJob.id.desc()).limit(12)))
    streams = list(s.scalars(select(StreamSession).where(StreamSession.dataset_id.in_(ids)).order_by(StreamSession.id.desc()).limit(12)))
    iso = lambda t: t.isoformat(timespec="minutes") if t else None
    crawl_jobs = list(s.scalars(select(CrawlJob).where(CrawlJob.dataset_id.in_(ids)).order_by(CrawlJob.id.desc()).limit(8)))
    checks = [{"name": c["name"], "level": c["level"], "zh": FAILURE_ZH.get(c["failure_type"], c["failure_type"]), "description": c["description"], "implemented": c["implemented"]} for c in catalog()]
    # 问题图片相册：每类问题（各数据集最近一次运行，high / critical，不含标为误报的）最多 40 张有截图的切片
    from .dashboard import FAILURE_ZH as _ZH
    lat = [d.latest_run_id for d in dss if d.latest_run_id] or [-1]
    albums = []
    for t_, n_ in s.execute(select(QCFinding.failure_type, func.count()).where(QCFinding.run_id.in_(lat), QCFinding.severity.in_(["high", "critical"]),
                                                                              QCFinding.preview_path.is_not(None), QCFinding.z.is_not(None), not_false_positive())
                            .group_by(QCFinding.failure_type).order_by(func.count().desc())).all():
        rows = s.scalars(select(QCFinding).where(QCFinding.run_id.in_(lat), QCFinding.failure_type == t_, QCFinding.severity.in_(["high", "critical"]),
                                                 QCFinding.preview_path.is_not(None), QCFinding.z.is_not(None), not_false_positive())
                         .order_by(QCFinding.dataset_id, QCFinding.z, QCFinding.id).limit(400))
        seen, shots = set(), []
        for x in rows:
            if (x.dataset_id, x.z) in seen:
                continue
            seen.add((x.dataset_id, x.z))
            shots.append({"id": x.id, "dataset_id": x.dataset_id, "z": x.z, "block_id": x.block_id, "severity": x.severity, "src": f"/api/v1/report/thumb/{x.id}"})
            if len(shots) >= 40:
                break
        albums.append({"type": t_, "zh": _ZH.get(t_, t_), "n": n_, "shots": shots})
    n_err = s.scalar(select(func.count()).select_from(QCRun).where(QCRun.dataset_id.in_(ids), QCRun.status == "error")) or 0
    return {
        "kpi": base["kpi"], "datasets": base["datasets"], "failures": base["failures"], "examples": base["examples"], "delivery": base["delivery"],
        "latest": latest, "plan": plan, "checks": checks, "albums": albums,
        "runs": [{"run_id": r["run_id"], "dataset_id": r["dataset_id"], "finished_at": r.get("finished_at"), "retention": r.get("retention"),
                  "n_findings": r.get("n_findings"), "wall_s": r.get("wall_s"), "n_sections": r.get("n_sections"), "grades": r.get("grades") or {}}
                 for r in sorted(runs_all, key=lambda r: r["run_id"], reverse=True)[:300]],
        "n_runs": len(runs_all), "n_runs_error": n_err,
        "crawl": {"presets": [{"key": k, "label": v["label"], "url": v["em"]["url"], "mip": v["em"]["mip"], "note": v["em"].get("note"),
                               "seg_url": (v.get("seg") or {}).get("url"), "seg_mip": (v.get("seg") or {}).get("mip", 0), "mask_url": (v.get("mask") or {}).get("url"),
                               "species": v.get("species"), "brain_region": v.get("brain_region")} for k, v in PRESETS.items()],
                  "jobs": [{"id": j.id, "dataset_id": j.dataset_id, "status": j.status, "n_done": j.n_done, "n_sections": j.n_sections, "at": iso(j.finished_at or j.created_at)} for j in crawl_jobs]},
        "exports": [{"id": j.id, "dataset_id": j.dataset_id, "kind": "pack" if (j.params_json or {}).get("kind") == "pack" else "shards", "status": j.status,
                     "n_sections": j.n_sections, "n_bytes": j.n_bytes, "at": iso(j.finished_at or j.created_at)} for j in exports],
        "streams": [{"id": x.id, "dataset_id": x.dataset_id, "status": x.status, "n_items": x.n_items, "n_acked": x.n_acked, "n_bytes": x.n_bytes, "at": iso(x.created_at)} for x in streams],
    }


@router.get("/active")
def report_active(request: Request, s: Session = Depends(get_session)):
    """正在跑的清洗（流程图上的线据此流光）。只看能看的项目。"""
    dss, _, _ = _scoped_datasets(request, s, None)
    ids = [d.dataset_id for d in dss] or ["\x00"]
    rs = list(s.scalars(select(QCRun).where(QCRun.dataset_id.in_(ids), QCRun.status.in_(["queued", "running"])).order_by(QCRun.id)))
    return {"runs": [{"run_id": r.id, "dataset_id": r.dataset_id, "status": r.status, "stage": r.stage, "n_blocks": r.n_blocks, "n_blocks_done": r.n_blocks_done} for r in rs]}
