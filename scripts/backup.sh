#!/usr/bin/env bash
# paper-system 自动备份
#   - SQLite 在线一致性快照（VACUUM INTO，运行中也安全）
#   - 论文目录打包（PDF 原件 + 解析产物）
#   - 轮转保留最近 N 份
# 用法: ./scripts/backup.sh [保留份数]
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP="${1:-$(python3 -c "
import yaml;print(yaml.safe_load(open('config.yaml'))['retention']['backup_keep'])" 2>/dev/null || echo 7)}"
STAMP=$(date +%F)
BACKUP_DIR="data/backups"
mkdir -p "$BACKUP_DIR"

# 1. 数据库快照（VACUUM INTO = 一致性快照，不会拷到写一半的状态）
if [ -f data/papersys.db ]; then
  DB_OUT="$BACKUP_DIR/db-$STAMP.db"
  rm -f "$DB_OUT"
  python3 - "$DB_OUT" <<'PY'
import sqlite3, sys
src = sqlite3.connect('data/papersys.db')
dst = sys.argv[1]
src.execute("VACUUM INTO ?", (dst,))
src.close()
print(f"  ✓ 数据库快照 {dst}")
PY
fi

# 2. 论文目录（PDF + 解析产物）
if [ -d data/papers ] && [ -n "$(ls -A data/papers 2>/dev/null)" ]; then
  TAR_OUT="$BACKUP_DIR/papers-$STAMP.tar.gz"
  tar czf "$TAR_OUT" data/papers
  echo "  ✓ 论文归档 $TAR_OUT"
fi

# 2.5 清单 + 哈希（与容器内 janitor 备份同规格——restore.sh 恢复前校验完整性）
python3 - "$BACKUP_DIR" "$STAMP" <<'PY2'
import hashlib, json, sys, pathlib
bdir = pathlib.Path(sys.argv[1]); stamp = sys.argv[2]
manifest = {"created": stamp, "files": {}}
for name in (f"db-{stamp}.db", f"papers-{stamp}.tar.gz"):
    f = bdir / name
    if f.exists():
        manifest["files"][name] = {"sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                                   "size": f.stat().st_size}
if manifest["files"]:
    (bdir / f"manifest-{stamp}.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                                 encoding="utf-8")
    print(f"  ✓ 备份清单 manifest-{stamp}.json")
PY2

# 3. 轮转（只保留最近 N 份同名文件）
# 轮转按类别各自保留 N 份（此前 db/papers 混一个 ls -1t 池——mtime 同刻排序漂移
# 导致 papers 永远轮不掉，10 份堆积 9.6G）
for pat in "db-*.db" "papers-*.tar.gz"; do
  ls -1t "$BACKUP_DIR/"$pat 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    rm -f "$f"; echo "  - 清理旧备份 $(basename "$f")"
  done
done
# 审计预快照（pre-audit-*.db）与手动快照目录超过 7 天的清理——不计入 KEEP
find "$BACKUP_DIR" -maxdepth 1 -name "pre-audit-*.db" -mtime +7 -delete 2>/dev/null || true

# 4. 报告
TOTAL=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "备份完成：$BACKUP_DIR（当前 ${TOTAL:-0}，保留最近 $KEEP 份）"
echo "提示：备份与数据同盘，硬盘故障会一起丢——建议 rsync 到另一台机器"
