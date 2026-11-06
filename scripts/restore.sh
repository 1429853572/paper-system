#!/usr/bin/env bash
# paper-system 从备份恢复
# 用法: ./scripts/restore.sh [日期 YYYY-MM-DD]
#   不带参数 = 恢复最近一份
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="${1:-}"
BACKUP_DIR="data/backups"

pick() {
  local pattern="$1"
  ls -1t $BACKUP_DIR/$pattern 2>/dev/null | head -1
}

DB_FILE=$(pick "db-*.db")
TAR_FILE=$(pick "papers-*.tar.gz")
if [ -n "$STAMP" ]; then
  DB_FILE="$BACKUP_DIR/db-$STAMP.db"
  TAR_FILE="$BACKUP_DIR/papers-$STAMP.tar.gz"
fi

if [ ! -f "$DB_FILE" ] && [ ! -f "$TAR_FILE" ]; then
  echo "找不到备份（$BACKUP_DIR）" >&2; exit 1
fi

echo "将恢复："
[ -f "$DB_FILE" ] && echo "  数据库 ← $(basename "$DB_FILE")"
[ -f "$TAR_FILE" ] && echo "  论文   ← $(basename "$TAR_FILE")"
echo
read -r -p "确认恢复？当前数据将被覆盖（y/N）" ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "已取消"; exit 0; }

echo "停止应用…"
docker compose stop app >/dev/null 2>&1 || true

if [ -f "$TAR_FILE" ]; then
  echo "恢复论文目录…"
  rm -rf data/papers
  tar xzf "$TAR_FILE"
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
echo "恢复完成"
