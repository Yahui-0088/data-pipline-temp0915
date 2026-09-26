#!/usr/bin/env python
"""每晚备份：标注工作目录（seg_edit.npy、edits/、edits.jsonl、audit.jsonl …）和数据库，放到另一块盘 / 另一台机器上。

    python scripts/backup.py /mnt/nas/emqc-backup                 # 本地目录（另一块盘、挂载的 NAS）
    python scripts/backup.py backup@10.0.0.5:/data/emqc-backup     # 另一台机器（rsync over ssh，要先配好免密钥）
    python scripts/backup.py DEST --keep-days 14 --dump-bin /path/to/mariadb-dump
    python scripts/backup.py DEST --list                           # 看已有的备份

每次在 DEST 下建一个 emqc-<时间>/：
  annotate/   标注工作目录的完整副本。没变的文件和上一份备份硬链接，不重复占空间（本地目录和远程都是）
  db.sql.gz   mariadb-dump --single-transaction 的整库导出（一致快照，不锁表，标注照常）；SQLite 时是 db.sqlite
  BACKUP.json 这份备份的时间、来源、文件数、耗时
然后把 latest 指到它（下一份和它硬链接），删掉超过 keep-days 天的旧备份（远程目录不删，交给那边自己管）。

备份和标注同时进行时怎么保证一致：平台落一笔是"先写记录、再写像素"，所以先拷 seg_edit.npy、再拷 edits/ 和日志，
备份里的记录只会比像素多（多出来的那笔撤销时回填的是原值，无害）。撤销的顺序反过来（先回填像素、再改日志），
单靠拷贝顺序保证不了，所以每个块拷之前和拷完之后各看一眼 edits.jsonl、audit.jsonl（每一次写入、撤销都会改动
其中至少一个）：变了就说明拷的过程中有人动过这块，把这个块重拷一遍，直到前后一致（最多 5 轮，还不一致就报错告警）。

数据库口令从 EMQC_DB_URL（环境变量或项目 .env）读，写进一个只有自己能读的临时配置文件交给 mariadb-dump，
不出现在命令行参数里（ps 看不到）。失败会记进 var/log/backup.log，配了 EMQC_ALERT_WEBHOOK 还会推告警。

恢复：
  标注：停服务 → 把 emqc-<时间>/annotate/<块> 拷回 EMQC_ANNOTATE_WORKDIR/<块> → 起服务
  数据库：gunzip -c db.sql.gz | mariadb --defaults-extra-file=<含口令的配置> <库名>
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from emqc import logs  # noqa: E402
from emqc.config import settings  # noqa: E402

PREFIX = "emqc-"


def _remote(dest: str) -> bool:
    """host:path 或 user@host:path 是远程；/a/b、./a、C:\\ 这类是本地。"""
    head = dest.split("/", 1)[0]
    return ":" in head and not dest.startswith(("/", "."))


def _say(log_file: Path, msg: str) -> None:
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _rsync(src: Path, dest: str, link_dest: str | None, only_pixels: bool) -> int:
    """跑一遍 rsync，返回退出码。23 / 24 是"拷的时候文件变了或不见了"（有人正好在撤销），由调用方重拷；别的非零直接报错。"""
    cmd = ["rsync", "-a", "--delete" if not only_pixels else "--quiet"]
    if link_dest:
        cmd.append(f"--link-dest={link_dest}")
    if only_pixels:
        # 第一遍只拷各块的 seg_edit.npy（像素），第二遍再拷记录——理由见文件开头。
        # 按内容比（--checksum）：工作副本大小永远不变，像素是经内存映射改的，修改时间不一定跟着变；只看大小和时间的话，
        # rsync 会以为没变，把上一份备份里的旧像素硬链接过来
        cmd += ["--checksum", "--include=*/", "--include=seg_edit.npy", "--exclude=*"]
    else:
        # 第二遍不再碰 seg_edit.npy：两遍之间有人落了一笔的话，第二遍拷的日志会比像素新（无害），反过来就不行
        cmd += ["--exclude=*.part", "--exclude=.server.lock", "--exclude=seg_edit.npy"]
    cmd += [f"{src}/", dest.rstrip("/") + "/"]
    rc = subprocess.run(cmd).returncode
    if rc not in (0, 23, 24):
        raise RuntimeError(f"rsync 失败（退出码 {rc}）：{' '.join(cmd[-2:])}")
    return rc


def _state(block: Path) -> tuple:
    """这个块的两份日志现在是什么样：每一次写入、撤销都会改动其中至少一个（追加改大小，撤销时整文件替换换 inode）。"""
    out = []
    for name in ("edits.jsonl", "audit.jsonl"):
        try:
            st = (block / name).stat()
            out.append((st.st_ino, st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            out.append(None)
    return tuple(out)


def _copy_workdir(work: Path, target: str, link: str | None, log_file: Path, rounds: int = 5) -> int:
    """把整个工作目录拷到 target（先像素、后记录）；拷的过程中被人动过的块单独重拷，直到前后一致。返回块数。"""
    blocks = sorted(p.name for p in work.iterdir() if p.is_dir())
    before = {b: _state(work / b) for b in blocks}
    rc = max(_rsync(work, target, link, only_pixels=True), _rsync(work, target, link, only_pixels=False))
    dirty = [b for b in blocks if rc or _state(work / b) != before[b]]
    for _ in range(rounds):
        if not dirty:
            return len(blocks)
        _say(log_file, f"拷的过程中有人改了 {len(dirty)} 个块，重拷：{', '.join(dirty[:10])}")
        again = []
        for b in dirty:
            s0 = _state(work / b)
            blink = f"../{link}/{b}" if link else None       # 目标目录深了一层，相对的 --link-dest 也要多退一层
            rc = max(_rsync(work / b, f"{target}/{b}", blink, only_pixels=True),
                     _rsync(work / b, f"{target}/{b}", blink, only_pixels=False))
            if rc or _state(work / b) != s0:
                again.append(b)
        dirty = again
    if dirty:
        raise RuntimeError(f"这些块一直在被改动，{rounds} 轮都没拷到前后一致的状态：{', '.join(dirty)}；请换个没人标注的时间再备份")
    return len(blocks)


def _cnf(v: str) -> str:
    """MySQL 选项文件里的值要加引号：口令里的 # 不加引号会被当成注释截掉，反斜杠会被当成转义。"""
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def _dump_db(out_dir: Path, dump_bin: str | None) -> str:
    """整库导出到 out_dir，返回文件名。"""
    from sqlalchemy.engine import make_url

    url = make_url(settings.db_url)
    if url.get_backend_name() == "sqlite":
        import sqlite3

        src = sqlite3.connect(url.database)
        dst = sqlite3.connect(str(out_dir / "db.sqlite"))
        with dst:
            src.backup(dst)                     # SQLite 自带的在线备份，写入进行中也一致
        src.close(); dst.close()
        return "db.sqlite"
    exe = dump_bin or os.environ.get("EMQC_MYSQLDUMP") or shutil.which("mariadb-dump") or shutil.which("mysqldump")
    if not exe:
        raise RuntimeError("找不到 mariadb-dump / mysqldump：用 --dump-bin 指定，或设 EMQC_MYSQLDUMP")
    with tempfile.TemporaryDirectory() as tmp:
        cnf = Path(tmp) / "client.cnf"
        fd = os.open(cnf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("[client]\n")
            f.write(f"user={_cnf(url.username or '')}\n")
            f.write(f"password={_cnf(url.password or '')}\n")
            f.write(f"host={_cnf(url.host or '127.0.0.1')}\n")
            if url.port:
                f.write(f"port={url.port}\n")
        cmd = [exe, f"--defaults-extra-file={cnf}", "--single-transaction", "--quick", "--routines", "--triggers",
               "--default-character-set=utf8mb4", "--hex-blob", url.database]
        target = out_dir / "db.sql.gz"
        with gzip.open(target, "wb") as gz:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for chunk in iter(lambda: p.stdout.read(1 << 20), b""):
                gz.write(chunk)
            err = p.stderr.read().decode("utf-8", "replace")
            if p.wait() != 0:
                raise RuntimeError(f"数据库导出失败：{err.strip()[:500]}")
    return "db.sql.gz"


def _prune(dest: Path, keep_days: int, keep: str, log_file: Path) -> int:
    cutoff = datetime.now() - timedelta(days=keep_days)
    n = 0
    for d in sorted(dest.glob(PREFIX + "*")):
        if d.name == keep or not d.is_dir():
            continue
        try:
            when = datetime.strptime(d.name[len(PREFIX):], "%Y%m%d-%H%M%S")
        except ValueError:
            continue                            # 不是我们建的，别碰
        if when < cutoff:
            shutil.rmtree(d)
            n += 1
            _say(log_file, f"删掉过期备份 {d.name}")
    return n


def backup(dest: str, keep_days: int = 14, dump_bin: str | None = None, with_db: bool = True) -> dict:
    t0 = time.time()
    log_file = logs.log_dir() / "backup.log"
    work = Path(settings.annotate_workdir)
    name = PREFIX + datetime.now().strftime("%Y%m%d-%H%M%S")
    remote = _remote(dest)
    link = "../../latest/annotate"              # rsync 的相对 --link-dest 按目标目录 <dest>/<name>/annotate 解析
    if not remote:
        base = Path(dest)
        base.mkdir(parents=True, exist_ok=True)
        if not (base / "latest" / "annotate").is_dir():
            link = None
        (base / name).mkdir()
    else:
        host, path = dest.split(":", 1)
        path = path.rstrip("/")
        subprocess.run(["ssh", host, "mkdir", "-p", f"{path}/{name}"], check=True)
        if subprocess.run(["ssh", host, "test", "-d", f"{path}/latest/annotate"]).returncode != 0:
            link = None
    target = dest.rstrip("/") + "/" + name
    _say(log_file, f"开始备份 {work} → {target}")
    info = {"name": name, "started": datetime.now().isoformat(timespec="seconds"), "source": str(work),
            "deployment": settings.deployment_name or None}
    if work.is_dir():
        info["n_blocks"] = _copy_workdir(work, target + "/annotate", link, log_file)
    with tempfile.TemporaryDirectory() as tmp:
        side = Path(tmp)
        if with_db:
            info["db"] = _dump_db(side, dump_bin)
        info["seconds"] = round(time.time() - t0, 1)
        (side / "BACKUP.json").write_text(json.dumps(info, ensure_ascii=False, indent=1))
        if subprocess.run(["rsync", "-a", f"{side}/", target.rstrip("/") + "/"]).returncode != 0:
            raise RuntimeError("数据库导出和 BACKUP.json 没拷到备份目录")
    if not remote:
        latest = Path(dest) / "latest"
        tmp_link = Path(dest) / ".latest.tmp"
        tmp_link.unlink(missing_ok=True)
        tmp_link.symlink_to(name)
        tmp_link.replace(latest)
        info["pruned"] = _prune(Path(dest), keep_days, name, log_file)
    else:
        host, path = dest.split(":", 1)
        subprocess.run(["ssh", host, "ln", "-sfn", name, path.rstrip("/") + "/latest"], check=True)
    _say(log_file, f"备份完成 {name}：{info.get('n_blocks', 0)} 个块，数据库 {info.get('db', '未备份')}，{info['seconds']} 秒")
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dest", help="备份放到哪：本地目录，或 user@host:/path")
    ap.add_argument("--keep-days", type=int, default=14, help="本地目录里保留几天（默认 14）")
    ap.add_argument("--dump-bin", help="mariadb-dump / mysqldump 的路径（不在 PATH 里时）")
    ap.add_argument("--no-db", action="store_true", help="只备份标注，不导出数据库")
    ap.add_argument("--list", action="store_true", help="列出已有的备份")
    a = ap.parse_args(argv)
    if a.list:
        if _remote(a.dest):
            host, path = a.dest.split(":", 1)
            return subprocess.run(["ssh", host, "ls", "-l", path]).returncode
        for d in sorted(Path(a.dest).glob(PREFIX + "*")):
            meta = d / "BACKUP.json"
            print(d.name, meta.read_text().replace("\n", " ") if meta.exists() else "")
        return 0
    try:
        backup(a.dest, a.keep_days, a.dump_bin, not a.no_db)
        return 0
    except Exception as e:  # 备份失败要让人知道：记日志、推告警，退出码非零（cron 会发邮件）
        msg = f"备份失败：{type(e).__name__}: {e}"
        _say(logs.log_dir() / "backup.log", msg)
        try:
            logs.alert("backup", msg, wait=True)
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
