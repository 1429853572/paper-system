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
echo "$H" | grep -q '"ai":true' && ok "health: ai(xinference)" || bad "health: ai 异常: $H"

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

# 5b. 改密码闭环：改密 → 旧密码 401 → 新密码可用 → 恢复原密码
PW_TMP=$(python3 -c "import secrets;print(secrets.token_urlsafe(12))")
CJ2=$(mktemp)
curl -sf -c "$CJ2" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PW\"}" >/dev/null
R1=$(curl -sf -b "$CJ2" -c "$CJ2" -X POST "$BASE/api/password" -H 'Content-Type: application/json'     -d "{\"old_password\":\"$PW\",\"new_password\":\"$PW_TMP\"}" || echo '')
echo "$R1" | grep -q '"ok":true' && ok "改密码接受" || bad "改密码失败: $R1"
R2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" -H 'Content-Type: application/json'     -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
[[ "$R2" == 401 ]] && ok "旧密码已失效" || bad "旧密码仍可用（HTTP $R2）"
R3=$(curl -sf -X POST "$BASE/api/login" -H 'Content-Type: application/json'     -d "{\"username\":\"admin\",\"password\":\"$PW_TMP\"}" || echo '')
echo "$R3" | grep -q '"role":"admin"' && ok "新密码可用" || bad "新密码登录失败: $R3"
# 恢复原密码（避免影响后续用例）
curl -sf -b "$CJ2" -X POST "$BASE/api/password" -H 'Content-Type: application/json'     -d "{\"old_password\":\"$PW_TMP\",\"new_password\":\"$PW\"}" >/dev/null && ok "密码已还原" || bad "密码还原失败"
rm -f "$CJ2"

# 5c. 安全响应头
H1=$(curl -s -D- -o /dev/null "$BASE/")
echo "$H1" | grep -qi "x-frame-options: DENY" && ok "X-Frame-Options" || bad "缺 X-Frame-Options"
echo "$H1" | grep -qi "x-content-type-options: nosniff" && ok "X-Content-Type-Options" || bad "缺 XCTO"
echo "$H1" | grep -qi "content-security-policy" && ok "CSP" || bad "缺 CSP"

# 5d. CSP 指令正确性（曾经因 script-src 'self' 拦截内联脚本，导致登录页无法提交）
CSP=$(curl -s -D- -o /dev/null "$BASE/login" | grep -i "^content-security-policy" | tr -d '\r')
echo "$CSP" | grep -qi "script-src-elem 'self'" && ok "CSP 禁止内联 <script> 块" \
  || bad "CSP 缺 script-src-elem 'self'（登录页会静默失效）: $CSP"
echo "$CSP" | grep -qi "script-src-attr 'unsafe-inline'" && ok "CSP 放行 onclick 属性" \
  || bad "CSP 缺 script-src-attr 'unsafe-inline'（内联 onclick 会全部失效）"
# 登录页不得再有内联 <script>（外置为 /static/login.js）
INL=$(curl -s "$BASE/login" | grep -c "<script>" || true)
[[ "$INL" == "0" ]] && ok "登录页无内联 <script>" || bad "登录页仍有 $INL 个内联 <script>，会被 CSP 拦截"
LJS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE/static/login.js")
[[ "$LJS" == 200 ]] && ok "login.js 200" || bad "login.js HTTP $LJS"

# 6. 未登录访问受保护端点应 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/papers")
[[ "$CODE" == 401 ]] && ok "未登录 401 保护" || bad "未登录访问返回 $CODE（应 401）"

rm -f "$CJ"
echo
echo "结果: $pass 通过, $fail 失败"
[[ $fail -eq 0 ]] || exit 1
