#!/usr/bin/env bash
# API 冒烟测试（只读，不改任何数据）。部署后/发版前跑一遍，确认服务活着、关键端点通。
# 用法: bash scripts/smoke-test.sh            # 默认 http://127.0.0.1:7861
#       BASE_URL=... bash scripts/smoke-test.sh
# 凭据取 .env（ADMIN_INITIAL_PASSWORD / PAPERSYS_API_TOKEN），或用环境变量覆盖。
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE_URL:-http://127.0.0.1:7861}"
if [[ -f .env ]]; then
    ENV_PW=$(grep -E '^ADMIN_INITIAL_PASSWORD=' .env | cut -d= -f2-)
    ENV_TOKEN=$(grep -E '^PAPERSYS_API_TOKEN=' .env | cut -d= -f2-)
fi
PW="${PAPERSYS_ADMIN_PW:-${ENV_PW:-}}"
TOKEN="${PAPERSYS_API_TOKEN:-${ENV_TOKEN:-}}"

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

echo "== paper-system 冒烟测试 @ $BASE =="

# 1. 健康（无需登录）
H=$(curl -sf "$BASE/api/health" || echo '')
echo "$H" | grep -q '"db":true' && ok "health: db" || bad "health: db 异常: $H"
echo "$H" | grep -q '"mineru":true' && ok "health: mineru" || bad "health: mineru 异常: $H"
echo "$H" | grep -q '"ollama":true' && ok "health: ollama" || bad "health: ollama 异常: $H"

# 2. 静态资源
CSS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE/static/styles.css")
[[ "$CSS" == 200 ]] && ok "styles.css 200" || bad "styles.css HTTP $CSS"
VJS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE/static/viewer.js")
[[ "$VJS" == 200 ]] && ok "viewer.js 200" || bad "viewer.js HTTP $VJS"
FV=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE/static/favicon.svg")
[[ "$FV" == 200 ]] && ok "favicon.svg 200" || bad "favicon.svg HTTP $FV"

# 3. 登录 → cookie
CJ=$(mktemp)
LOGIN=$(curl -sf -c "$CJ" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PW\"}" || echo '')
echo "$LOGIN" | grep -q '"role":"admin"' && ok "login: admin" || bad "login 失败: $LOGIN"

# 4. 关键只读端点（带 cookie）
for ep in "/api/papers" "/api/collections" "/api/statuses" "/api/presets" "/api/jobs" "/api/glossary"; do
    CODE=$(curl -sf -b "$CJ" -o /dev/null -w '%{http_code}' "$BASE$ep")
    [[ "$CODE" == 200 ]] && ok "GET $ep" || bad "GET $ep HTTP $CODE"
done

# 5. CLI token 通道（/api/me with Bearer）
ME=$(curl -sf "$BASE/api/me" -H "Authorization: Bearer $TOKEN" || echo '')
echo "$ME" | grep -q '"role":"admin"' && ok "CLI token /api/me" || bad "CLI token 异常: $ME"

# 6. 未登录访问受保护端点应 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/papers")
[[ "$CODE" == 401 ]] && ok "未登录 401 保护" || bad "未登录访问返回 $CODE（应 401）"

rm -f "$CJ"
echo
echo "结果: $pass 通过, $fail 失败"
[[ $fail -eq 0 ]] || exit 1
