from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from emqc.config import settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str | None = None):
    url = url or settings.db_url
    kwargs: dict = {"echo": settings.db_echo, "future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    else:
        # 数据库停机、重启或卡住时，每个请求最多等这么久就报错，而不是把工作线程一个个挂死：
        # 连接 5 秒、单条读写 30 秒、从连接池取连接 10 秒
        kwargs.update(pool_pre_ping=True, pool_recycle=1800, pool_timeout=10)
        if url.startswith("mysql"):
            kwargs["connect_args"] = {"connect_timeout": 5, "read_timeout": 30, "write_timeout": 30}
    eng = create_engine(url, **kwargs)
    if url.startswith("mysql"):
        from sqlalchemy import event

        @event.listens_for(eng, "connect")
        def _mariadb_session(dbapi_conn, _rec):  # pragma: no cover - driver level
            # MariaDB 11.8 默认开着 innodb_snapshot_isolation：两个事务读了同一行、先后去改，后一个直接报 1020
            # "记录在读之后被改过"——同时登录、同时回复同一条标记时偶发 500。我们的写入都是短事务，
            # 用 InnoDB 传统的可重复读就够了。MySQL 和老版本 MariaDB 没有这个变量，设不上就算了。
            cur = dbapi_conn.cursor()
            try:
                cur.execute("SET SESSION innodb_snapshot_isolation=OFF")
            except Exception:
                pass
            finally:
                cur.close()
    if url.startswith("sqlite") and ":memory:" not in url:
        # shared deployments run background QC threads while people browse: WAL lets readers work during a write
        from sqlalchemy import event

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_conn, _rec):  # pragma: no cover - driver level
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

    return eng


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def rebind(url: str) -> None:
    """Point the global engine/session at another database (used by tests)."""
    global engine
    engine = _make_engine(url)
    SessionLocal.configure(bind=engine)


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    Base.metadata.create_all(engine)
    ensure_columns()


def ensure_columns() -> None:
    """Additive migrations: add columns that exist in the models but not in the database, widen VARCHARs that grew."""
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"]: c for c in insp.get_columns(table.name)}
            for col in table.columns:
                ddl = col.type.compile(dialect=engine.dialect)
                if col.name not in existing:
                    conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {col.name} {ddl}"))
                    continue
                want = getattr(col.type, "length", None)
                have = getattr(existing[col.name]["type"], "length", None)
                if engine.dialect.name == "mysql" and want and have and have < want:
                    nullable = "NULL" if existing[col.name].get("nullable", True) else "NOT NULL"
                    conn.execute(text(f"ALTER TABLE {table.name} MODIFY COLUMN {col.name} {ddl} {nullable}"))


@contextmanager
def session_scope() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def recover_stale_runs() -> int:
    """Runs left 'queued' / 'running' by a previous process can never finish: mark them as error (called at startup)."""
    from datetime import datetime, timezone

    from sqlalchemy import select

    from .models import Block, CrawlEvent, CrawlJob, Dataset, ExportEvent, ExportJob, QCRun, QCRunEvent

    n = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with session_scope() as s:
        # 导出、爬取也是后台线程（排队的在等名额，见 emqc.jobslots）：进程一退，它们永远不会再跑，标成出错，页面上看得出来
        for job_cls, event_cls in ((ExportJob, ExportEvent), (CrawlJob, CrawlEvent)):
            for job in s.scalars(select(job_cls).where(job_cls.status.in_(["queued", "running"]))):
                job.status, job.error, job.finished_at = "error", "interrupted: the server process ended before the job finished", now
                s.add(event_cls(job_id=job.id, level="error", message="job interrupted by a server restart; start it again (finished parts are reused)"))
                n += 1
        for run in s.scalars(select(QCRun).where(QCRun.status.in_(["queued", "running"]))):
            run.status, run.error, run.finished_at = "error", "interrupted: the server process ended before the run finished", datetime.now(timezone.utc).replace(tzinfo=None)
            s.add(QCRunEvent(run_id=run.id, level="error", message="run interrupted by a server restart; blocks already persisted are kept"))
            ds = s.get(Dataset, run.dataset_id)
            if ds is not None and ds.status == "qc_running":
                ds.status = "qc_done" if ds.latest_run_id else "registered"
            for b in s.scalars(select(Block).where(Block.dataset_id == run.dataset_id, Block.status == "running")):
                b.status = "pending"
            n += 1
    return n
