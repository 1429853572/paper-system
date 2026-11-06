#!/usr/bin/env bash
# 服务器重启后自动执行的收尾流程（由 systemd paper-system-postboot.service 调用）
# 目标: 驱动修复后自动恢复服务 + 加载模型 + 验证 + 写报告
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

REPORT="data/verify-report.txt"
LOG="data/postboot.log"
mkdir -p data
exec >> "$LOG" 2>&1

log() { echo "[$(date '+%F %T')] $*"; }

log "=== postboot 开始 ==="
log "内核: $(uname -r) | 驱动: $(head -1 /proc/driver/nvidia/version 2>/dev/null | cut -c1-60)"

# 1. 驱动是否已修复
if nvidia-smi >/dev/null 2>&1; then
  log "✓ nvidia-smi 正常（驱动已对齐）"
else
  log "✗ nvidia-smi 仍失败："
  nvidia-smi 2>&1 | head -3 | while read -r l; do log "  $l"; done
fi

# 2. 启动全部服务（ollama 若因旧库缺失起不来属预期，会被 xinference 取代）
log "启动 docker 服务…"
docker compose up -d >/dev/null 2>&1
sleep 20

for svc in mineru xinference app caddy; do
  st=$(docker inspect --format '{{.State.Status}}' paper-system-$svc 2>/dev/null || echo "missing")
  log "  $svc: $st"
done

# 3. xinference 模型（本地路径优先，否则 ModelScope）
log "加载 xinference 模型…"
if [ -d models/xinference/bge-m3 ]; then
  MP_BGE="models/xinference/bge-m3"
elif [ -d models/xinference/bge-reranker-v2-m3 ]; then
  MP_RR="models/xinference/bge-reranker-v2-m3"
fi
bash scripts/setup-xinference.sh

# 4. 等待 app 健康
log "等待 app 就绪…"
for i in $(seq 1 30); do
  if curl -sf http://localhost:7861/api/health >/dev/null 2>&1; then log "✓ app 健康"; break; fi
  sleep 5
done

# 5. 重算向量（ollama → xinference；保持检索索引与新 embedding 服务一致）
log "重算向量（embedding → xinference）…"
docker compose exec -T app python - <<'PY' 2>&1 | tail -3
import os
from core.db import db
from core.retrieval import embed_texts
rows = db.all("SELECT id, text FROM chunks WHERE embedding IS NULL")
print("待回填:", len(rows))
if rows:
    vecs = embed_texts([r["text"] for r in rows], batch_size=16)
    with db.write() as c:
        for r, v in zip(rows, vecs):
            c.execute("UPDATE chunks SET embedding=? WHERE id=?", (__import__("struct").pack(f"<{len(v)}f", *v), r["id"]))
    print("已回填:", len(rows))
PY

# 6. 检索 sanity check
log "检索 sanity check…"
curl -sf -X POST http://localhost:7861/api/search -H "Content-Type: application/json" \
  -d '{"query":"dense novel view synthesis gaussian splatting","top_k":5}' \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('  命中', len(d.get('hits',[])), '条')
    for h in d.get('hits',[])[:3]:
        print('   -', h.get('text','')[:70].replace(chr(10),' '))
except Exception as e:
    print('  检索失败:', e)
" 2>&1 | while read -r l; do log "$l"; done

# 7. rerank 可用性（若已启用）
log "rerank 状态:"
curl -sf -m 10 -X POST http://localhost:9997/v1/rerank -H "Content-Type: application/json" \
  -d '{"model":"bge-reranker-v2-m3","query":"test","documents":["a","b"]}' \
  | head -c 200 | while read -r l; do log "  $l"; done

# 8. 汇总报告
{
  echo "==================== paper-system 重启后自检 ===================="
  echo "时间: $(date '+%F %T')"
  echo "内核: $(uname -r)"
  echo "驱动: $(head -1 /proc/driver/nvidia/version 2>/dev/null)"
  echo "nvidia-smi: $(nvidia-smi --query-gpu=name,memory.used --format=csv,noheader 2>&1 | head -1)"
  echo
  echo "--- 服务状态 ---"
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
  echo
  echo "--- 端点健康 ---"
  for u in http://localhost:7861/api/health http://localhost:8001/api/health; do
    echo "$u → $(curl -s -m 5 $u 2>&1 | head -c 120)"
  done
  echo
  echo "--- xinference 模型 ---"
  curl -s -m 10 http://localhost:9997/v1/models 2>/dev/null | head -c 600
} > "$REPORT"

log "报告已写入 $REPORT"
log "=== postboot 结束 ==="
