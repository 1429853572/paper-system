#!/usr/bin/env bash
# 部署 xinference 的两个模型（ModelScope 源，国内可达）：
#   - BAAI/bge-m3              embedding（替代原 ollama）
#   - BAAI/bge-reranker-v2-m3   rerank（交叉编码器重排）
# 用法: ./scripts/setup-xinference.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API="http://localhost:9997"
MODELS_DIR="/root/.xinference/cache"   # 容器内挂载点（宿主机 ./models/xinference）
mkdir -p "$MODELS_DIR"

echo "== 等待 xinference server 就绪 =="
for i in $(seq 1 60); do
  if curl -sf "$API/v1/models" >/dev/null 2>&1; then echo "  ✓ server 就绪"; break; fi
  sleep 5
  [ "$i" = "60" ] && { echo "  ✗ server 未就绪（docker compose logs xinference 查看）"; exit 1; }
done

launch() {  # name type path
  local name="$1" type="$2" path="$3"
  # 本地已下载优先（models/xinference/<name>），否则用 ModelScope 仓库名
  if [ -d "$MODELS_DIR/$name" ]; then path="$MODELS_DIR/$name"; fi
  if curl -sf "$API/v1/models/$name" >/dev/null 2>&1; then
    echo "  ✓ $name 已存在"; return 0
  fi
  echo "  → 启动 $name ($type, $path)…"
  curl -sf -X POST "$API/v1/models" \
    -H "Content-Type: application/json" \
    -d "{\"model_name\":\"$name\",\"model_type\":\"$type\",\"model_uid\":\"$name\",\"model_source\":\"modelscope\",\"model_path\":\"$path\",\"max_workers\":1,\"min_workers\":1}" \
    >/dev/null || { echo "  ✗ $name 启动失败"; return 1; }
}

echo "== 启动模型 =="
launch bge-m3              embedding "$MODELS_DIR/bge-m3"
launch bge-reranker-v2-m3   rerank    "$MODELS_DIR/bge-reranker-v2-m3"

echo "== 已加载模型 =="
curl -sf "$API/v1/models" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data', d.get('models', [])):
    print('  -', m.get('id') or m.get('model_uid'), '|', m.get('model_type', ''))"
echo "完成"
