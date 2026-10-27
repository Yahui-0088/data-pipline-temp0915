"""人对 QC 问题的判断（确认 / 误报），以及它对结果的影响。

规则（只做「放宽」，不会让本来通过的切片变成不通过）：
- 一片切片原来没通过，只要它身上 high / critical 的问题全部被标为误报、并且切片本身读得出（status = ok），就算通过；
- 撤销误报、或改判为「确认」，回到这片原来的结果（slice_was_passed）。
改完切片后，重算这个数据块和这次运行的可用比例；如果是数据集 / 数据块的最新一次运行，也同步它们的 latest_retention_rate。
等级（A/B/C/D）不重算：等级还看质量分和整块的问题，人工判断只影响「哪些切片能用」。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, exists, select
from sqlalchemy.orm import Session

from emqc.db.models import Block, Dataset, FindingVerdict, QCBlock, QCFinding, QCRun, QCSlice

VERDICTS = ("confirmed", "false_positive")
FAILING = ("high", "critical")  # 和 QCConfig.pass_max_severity 默认值（HIGH）一致：到这个级别切片就不通过


def not_false_positive():
    """SQL 条件：这条 QCFinding 没有被标为误报。"""
    return ~exists().where(and_(FindingVerdict.run_id == QCFinding.run_id, FindingVerdict.block_id == QCFinding.block_id,
                                FindingVerdict.z == QCFinding.z, FindingVerdict.failure_type == QCFinding.failure_type,
                                FindingVerdict.verdict == "false_positive"))


def verdict_map(s: Session, run_id: int) -> dict[tuple[str, int, str], str]:
    """(block_id, z, failure_type) -> verdict，这次运行里已经判过的。"""
    return {(v.block_id, v.z, v.failure_type): v.verdict for v in s.scalars(select(FindingVerdict).where(FindingVerdict.run_id == run_id))}


def _recompute_slice(s: Session, sl: QCSlice) -> None:
    vs = list(s.scalars(select(FindingVerdict).where(FindingVerdict.run_id == sl.run_id, FindingVerdict.block_id == sl.block_id, FindingVerdict.z == sl.z)))
    orig = next((v.slice_was_passed for v in vs if v.slice_was_passed is not None), sl.passed)
    fp = {v.failure_type for v in vs if v.verdict == "false_positive"}
    sev = s.execute(select(QCFinding.failure_type, QCFinding.severity).where(
        QCFinding.run_id == sl.run_id, QCFinding.block_id == sl.block_id, QCFinding.z == sl.z)).all()
    failing = [t for t, v in sev if v in FAILING]
    cleared = sl.status == "ok" and bool(failing) and all(t in fp for t in failing)
    sl.passed = bool(orig) or cleared


def _recompute_run(s: Session, run_id: int, block_id: str) -> None:
    run = s.get(QCRun, run_id)
    qb = s.scalars(select(QCBlock).where(QCBlock.run_id == run_id, QCBlock.block_id == block_id)).first()
    if qb is not None:
        rows = s.execute(select(QCSlice.passed).where(QCSlice.run_id == run_id, QCSlice.block_id == block_id)).all()
        qb.n_passed = sum(1 for (p,) in rows if p)
        qb.retention_rate = (qb.n_passed / qb.n_slices) if qb.n_slices else None
    ds = s.get(Dataset, run.dataset_id)
    latest = ds is not None and ds.latest_run_id == run_id
    if qb is not None and latest:
        blk = s.scalars(select(Block).where(Block.dataset_id == qb.dataset_id, Block.block_id == block_id)).first()
        if blk is not None:
            blk.latest_retention_rate = qb.retention_rate
    blocks = list(s.scalars(select(QCBlock).where(QCBlock.run_id == run_id)))
    n = sum(b.n_slices for b in blocks)
    run.retention_rate = (sum(b.n_passed for b in blocks) / n) if n else None
    if latest:
        ds.latest_retention_rate = run.retention_rate


def set_verdict(s: Session, run_id: int, block_id: str, z: int, failure_type: str, verdict: str | None,
                by_user: str | None = None, by_name: str | None = None) -> dict:
    """下判断（verdict = confirmed / false_positive），或撤销（verdict = None）。返回这片切片和这次运行改完以后的结果。"""
    if verdict is not None and verdict not in VERDICTS:
        raise ValueError(f"verdict 只能是 {' / '.join(VERDICTS)}")
    run = s.get(QCRun, run_id)
    if run is None:
        raise LookupError(f"没有运行 #{run_id}")
    has = s.scalar(select(QCFinding.id).where(QCFinding.run_id == run_id, QCFinding.block_id == block_id, QCFinding.z == z,
                                              QCFinding.failure_type == failure_type).limit(1))
    if has is None:
        raise LookupError("这次运行里没有这条问题")
    sl = s.scalars(select(QCSlice).where(QCSlice.run_id == run_id, QCSlice.block_id == block_id, QCSlice.z == z)).first()
    row = s.scalars(select(FindingVerdict).where(FindingVerdict.run_id == run_id, FindingVerdict.block_id == block_id,
                                                 FindingVerdict.z == z, FindingVerdict.failure_type == failure_type)).first()
    was = None
    if sl is not None:
        prev = s.scalars(select(FindingVerdict.slice_was_passed).where(FindingVerdict.run_id == run_id, FindingVerdict.block_id == block_id,
                                                                       FindingVerdict.z == z, FindingVerdict.slice_was_passed.is_not(None))).first()
        was = prev if prev is not None else sl.passed
    if verdict is None:
        if row is not None:
            s.delete(row)
    elif row is None:
        s.add(FindingVerdict(run_id=run_id, dataset_id=run.dataset_id, block_id=block_id, z=z, failure_type=failure_type, verdict=verdict,
                             slice_was_passed=was, by_user=by_user, by_name=by_name, updated_at=datetime.now(timezone.utc)))
    else:
        row.verdict, row.by_user, row.by_name, row.updated_at = verdict, by_user, by_name, datetime.now(timezone.utc)
    s.flush()
    if sl is not None:
        if verdict is None and not s.scalar(select(FindingVerdict.id).where(FindingVerdict.run_id == run_id, FindingVerdict.block_id == block_id,
                                                                            FindingVerdict.z == z).limit(1)):
            sl.passed = bool(was)  # 这片已经没有任何判断：回到原来的结果
        else:
            _recompute_slice(s, sl)
        s.flush()  # 会话没开 autoflush：先写下去，下面重算数据块时才查得到改过的 passed
        _recompute_run(s, run_id, block_id)
    s.flush()
    return {"run_id": run_id, "block_id": block_id, "z": z, "failure_type": failure_type, "verdict": verdict,
            "slice_passed": None if sl is None else bool(sl.passed), "run_retention": run.retention_rate}
