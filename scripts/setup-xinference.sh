#!/usr/bin/env bash
# 部署 xinference 的两个模型（ModelScope 源，国内可达）：
#   - BAAI/bge-m3              embedding（替代原 ollama）
#   - BAAI/bge-reranker-v2-m3   rerank（交叉编码器重排）
# 用法: ./scripts/setup-xinference.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API="http://localhost:9997"
CONTAINER_MODELS_DIR="/root/.xinference/cache"   # 容器内挂载点
HOST_MODELS_DIR="models/xinference"              # 本脚本跑在宿主——检查宿主侧目录
mkdir -p "$HOST_MODELS_DIR"

echo "== 等待 xinference server 就绪 =="
for i in $(seq 1 60); do
  if curl -sf "$API/v1/models" >/dev/null 2>&1; then echo "  ✓ server 就绪"; break; fi
  sleep 5
  [ "$i" = "60" ] && { echo "  ✗ server 未就绪（docker compose logs xinference 查看）"; exit 1; }
done

launch() {  # name type
  local name="$1" type="$2"
  # 本地已下载优先（宿主 ./models/xinference/<name> → 容器内 /root/.xinference/cache/<name>）。
  # 注意：此版 xinference 的 rerank 加载会把请求里的多余字段（model_source /
  # max_workers / min_workers…）原样透传给 CrossEncoder 构造器 → TypeError。
  # 因此 rerank 只发最小字段；embedding 类型无此问题，保留 worker 参数。
  local payload path="$CONTAINER_MODELS_DIR/$name"
  if [ "$type" = "rerank" ]; then
    payload="{\"model_name\":\"$name\",\"model_type\":\"$type\",\"model_uid\":\"$name\",\"model_path\":\"$path\"}"
  elif [ -d "$HOST_MODELS_DIR/$name" ]; then
    payload="{\"model_name\":\"$name\",\"model_type\":\"$type\",\"model_uid\":\"$name\",\"model_path\":\"$path\",\"max_workers\":1,\"min_workers\":1}"
  else
    payload="{\"model_name\":\"$name\",\"model_type\":\"$type\",\"model_uid\":\"$name\",\"model_source\":\"modelscope\",\"max_workers\":1,\"min_workers\":1}"
  fi
  if curl -sf "$API/v1/models/$name" >/dev/null 2>&1; then
    echo "  ✓ $name 已存在"; return 0
  fi
  echo "  → 启动 $name ($type, $([ "$type" != "rerank" ] && [ ! -d "$HOST_MODELS_DIR/$name" ] && echo ModelScope || echo 本地))…"
  curl -sf -X POST "$API/v1/models" -H "Content-Type: application/json" -d "$payload" \
    >/dev/null || { echo "  ✗ $name 启动失败"; return 1; }
}

echo "== 启动模型 =="
launch bge-m3              embedding
launch bge-reranker-v2-m3  rerank

echo "== 已加载模型 =="
curl -sf "$API/v1/models" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data', d.get('models', [])):
    print('  -', m.get('id') or m.get('model_uid'), '|', m.get('model_type', ''))"
echo "完成"
