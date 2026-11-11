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
# 前端产物同步性：src/ 分片改了但忘了重建 viewer.js → 改动静默丢失
if [ -d app/webui/src ]; then
  python3 scripts/build-webui.py --check >/dev/null 2>&1 \
    && ok "viewer.js 与 src/ 同步" \
    || bad "viewer.js 与 src/ 不同步——跑 python3 scripts/build-webui.py"
fi
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

# 7. 新功能端点（第 6 段改密测试会吊销旧会话——先重登拿新 cookie）
CJ2=$(mktemp)
curl -sf -c "$CJ2" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PW\"}" >/dev/null
for ep in "/api/acquire/status" "/api/acq-tasks" "/api/syntheses" "/api/jobs/count" "/api/me/quota"; do
    CODE=$(curl -sf -b "$CJ2" -o /dev/null -w '%{http_code}' "$BASE$ep")
    [[ "$CODE" == 200 ]] && ok "GET $ep" || bad "GET $ep HTTP $CODE"
done
# 多用户管理字段（disabled 列缺失曾导致「启用」按钮永不渲染）
AU=$(curl -sf -b "$CJ2" "$BASE/api/admin/users" || echo '')
echo "$AU" | grep -q '"disabled"' && ok "admin/users 含 disabled 列" || bad "admin/users 缺 disabled 列"
echo "$AU" | grep -q '"disk_used"' && ok "admin/users 含磁盘用量" || bad "admin/users 缺 disk_used"
PP=$(curl -sf -b "$CJ2" "$BASE/api/papers?page_size=1" || echo '')
echo "$PP" | grep -q '"owner_name"' && ok "papers 列表含归属 owner_name" || bad "papers 缺 owner_name"
# 论文详情四联端点（cite 曾因 helper 递归 500——详情/引用是阅读页首屏路径）
PID1=$(echo "$PP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["papers"][0]["id"])
except Exception: print("")' 2>/dev/null)
if [[ -n "${PID1:-}" ]]; then
    for ep in "" "/cite" "/notes" "/jobstate"; do
        CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ2" "$BASE/api/papers/$PID1$ep")
        [[ "$CODE" == 200 ]] && ok "GET /api/papers/{id}$ep" || bad "GET /api/papers/{id}$ep HTTP $CODE"
    done
fi
FIRST_SYN=$(curl -s -b "$CJ2" "$BASE/api/syntheses" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get("syntheses",[{}])[0].get("id","") if d.get("syntheses") else "")')
if [[ -n "${FIRST_SYN:-}" ]]; then
    CODE=$(curl -sf -b "$CJ2" -o /dev/null -w '%{http_code}' "$BASE/api/syntheses/$FIRST_SYN/progress")
    [[ "$CODE" == 200 ]] && ok "GET /api/syntheses/{id}/progress" || bad "progress HTTP $CODE"
fi
# MCP tools/list（bearer token）
TOOLS=$(curl -sf "$BASE/api/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || echo '')
echo "$TOOLS" | grep -q 'search_papers' && ok "MCP tools/list" || bad "MCP tools/list 异常"

rm -f "$CJ" "$CJ2"
echo
echo "结果: $pass 通过, $fail 失败"
[[ $fail -eq 0 ]] || exit 1
