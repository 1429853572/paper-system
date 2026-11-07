#!/usr/bin/env bash
# paper-system 从备份恢复
# 用法: ./scripts/restore.sh [日期 YYYY-MM-DD]
#   不带参数 = 恢复最近一份（db 与 papers 按同一日期配对，避免跨日错配）
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="data/backups"

if [ -n "${1:-}" ]; then
  STAMP="$1"
else
  # 取"同一日期同时有 db 与 papers 归档"的最新日期；都缺则退回任一最新
  STAMP=$(comm -12 \
    <(ls -1 $BACKUP_DIR/db-*.db 2>/dev/null     | sed -n 's/.*db-\(.*\)\.db/\1/p' | sort -ru) \
    <(ls -1 $BACKUP_DIR/papers-*.tar.gz 2>/dev/null | sed -n 's/.*papers-\(.*\)\.tar\.gz/\1/p' | sort -ru) \
    | head -1)
  if [ -z "$STAMP" ]; then
    F=$(ls -1t $BACKUP_DIR/db-*.db $BACKUP_DIR/papers-*.tar.gz 2>/dev/null | head -1)
    [ -n "$F" ] || { echo "找不到备份（$BACKUP_DIR）" >&2; exit 1; }
    STAMP=$(basename "$F" | sed -n 's/.*-\(.*\)\.\(db\|tar\)\(.*\)/\1/p')
  fi
fi
DB_FILE="$BACKUP_DIR/db-$STAMP.db"
TAR_FILE="$BACKUP_DIR/papers-$STAMP.tar.gz"

if [ ! -f "$DB_FILE" ] && [ ! -f "$TAR_FILE" ]; then
  echo "找不到 $STAMP 的备份（$BACKUP_DIR）" >&2; exit 1
fi

echo "将恢复（日期 $STAMP）："
[ -f "$DB_FILE" ] && echo "  数据库 ← $(basename "$DB_FILE")"
[ -f "$TAR_FILE" ] && echo "  论文   ← $(basename "$TAR_FILE")"
echo
read -r -p "确认恢复？当前数据将被覆盖（y/N）" ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "已取消"; exit 0; }

echo "停止应用…"
docker compose stop app >/dev/null 2>&1 || true

# 覆盖前先把现有数据留存一份（tar 中途失败/恢复内容有误时还有回头的余地）
KEEP="data/backups/pre-restore-$(date +%F-%H%M%S)"
mkdir -p "$KEEP"
[ -f data/papersys.db ] && cp data/papersys.db "$KEEP/"
[ -d data/papers ] && mv data/papers "$KEEP/papers"
echo "  现有数据已留存到 $KEEP"

if [ -f "$TAR_FILE" ]; then
  echo "恢复论文目录…"
  mkdir -p data/papers
  # 恢复前完整性校验（清单存在才校验）
  if [[ -f "$BACKUP_DIR/manifest-$STAMP.json" ]]; then
    python3 - "$BACKUP_DIR" "$STAMP" <<'PY'
import hashlib, json, sys, pathlib
d, stamp = pathlib.Path(sys.argv[1]), sys.argv[2]
man = json.loads((d / f"manifest-{stamp}.json").read_text())
for name, meta in man["files"].items():
    p = d / name
    assert p.exists(), f"缺失备份文件: {name}"
    assert hashlib.sha256(p.read_bytes()).hexdigest() == meta["sha256"], f"哈希不符: {name}"
print("备份完整性校验通过")
PY
  else
    echo "（该备份无清单，跳过哈希校验）"
  fi
  tar xzf "$TAR_FILE"   # 归档内是 data/papers/…，在仓库根解包
fi
if [ -f "$DB_FILE" ]; then
  echo "恢复数据库…"
  cp "$DB_FILE" data/papersys.db
  rm -f data/papersys.db-wal data/papersys.db-shm
fi

echo "启动应用…"
docker compose up -d app >/dev/null 2>&1 || true
sleep 3
curl -s -m 5 http://localhost:8001/api/health 2>/dev/null || curl -s -m 5 http://localhost:7861/api/health 2>/dev/null
echo
echo "恢复完成（确认无误后可删除 $KEEP）"
