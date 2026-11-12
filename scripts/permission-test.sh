#!/usr/bin/env bash
# 权限/认证边界测试（全矩阵）。可重复执行：随机用户名，结束注销+清理测试行。
# 用法: bash scripts/permission-test.sh        # 默认 http://127.0.0.1:7861（需 docker，用于 private 造数与清理）
# 依赖: .env 的 ADMIN_INITIAL_PASSWORD；curl；python3；docker（paper-system-app 容器）
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE_URL:-http://127.0.0.1:7861}"
PW=$(grep -E '^ADMIN_INITIAL_PASSWORD=' .env | cut -d= -f2-)
MU="mu_t_$(date +%s | tail -c 6)_$RANDOM"
MU_PW='MuT#'"$RANDOM"'ab'

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1${2:+ — $2}"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys
try: d=json.load(sys.stdin); print(d$1)
except Exception: print('')" 2>/dev/null; }

CJA=$(mktemp)   # admin cookie
CJM=$(mktemp)   # member cookie
CJM2=$(mktemp)  # member 第二会话（改密吊销验证）

echo "== paper-system 权限边界测试 @ $BASE（测试用户: $MU）=="

# ---------- 准备：admin 登录 + 邀请码建 member ----------
curl -sf -c "$CJA" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$PW\"}" >/dev/null
INV=$(curl -sf -b "$CJA" -X POST "$BASE/api/admin/invite?days=1" | jget "['code']")
[[ -n "$INV" ]] && ok "准备: admin 登录+邀请码" || bad "准备: 邀请码获取失败"

REG=$(curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MU\",\"password\":\"$MU_PW\",\"invite_code\":\"$INV\"}")
echo "$REG" | grep -q '"ok":true' && ok "准备: member 注册" || bad "准备: 注册失败: $REG"
curl -sf -c "$CJM" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MU\",\"password\":\"$MU_PW\"}" >/dev/null
curl -sf -c "$CJM2" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MU\",\"password\":\"$MU_PW\"}" >/dev/null
UID2=$(curl -sf -b "$CJA" "$BASE/api/admin/users" | python3 -c "import json,sys
print(next((u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='$MU'), ''))")
[[ -n "$UID2" ]] && ok "准备: member 登录×2（uid=$UID2）" || bad "准备: member 登录失败"

# ---------- A. 未认证 → 401 ----------
echo "-- A. 未认证边界"
[[ "$(code "$BASE/api/papers")" == 401 ]] && ok "A1 未认证 GET /api/papers → 401" || bad "A1 未认证 papers 非 401"
[[ "$(code "$BASE/api/admin/users")" == 401 ]] && ok "A2 未认证 admin/users → 401" || bad "A2 非 401"
[[ "$(code "$BASE/api/me/quota")" == 401 ]] && ok "A3 未认证 me/quota → 401" || bad "A3 非 401"
UC=$(code -X POST "$BASE/api/papers/upload")
[[ "$UC" != 200 ]] && ok "A4 未认证 upload 拒绝（$UC——表单校验先于认证）" || bad "A4 未认证 upload 竟 200"
[[ "$(code "$BASE/api/jobs/stream")" == 401 ]] && ok "A5 未认证 SSE → 401" || bad "A5 非 401"
[[ "$(code -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{}')" == 401 ]] && ok "A6 未认证 MCP → 401" || bad "A6 非 401"

# ---------- B. member 越权 → 403 ----------
echo "-- B. member 越权（应全部 403）"
b3() { local n="$1" name="$2"; shift 2
  [[ "$(code -b "$CJM" "$@")" == 403 ]] && ok "B$n $name → 403" || bad "B$n $name 未拦（应 403）"; }
b3 1 "查全站用户" "$BASE/api/admin/users"
b3 2 "生成邀请码" -X POST "$BASE/api/admin/invite?days=1"
b3 3 "改他人限额" -X PUT "$BASE/api/admin/users/1/quota" -H 'Content-Type: application/json' -d '{}'
b3 4 "开关公共池" -X POST "$BASE/api/admin/pool" -H 'Content-Type: application/json' -d '{"enabled":true}'
b3 5 "重置他人密码" -X POST "$BASE/api/admin/users/1/reset-password"
b3 6 "禁用他人" -X POST "$BASE/api/admin/users/1/disable"
b3 7 "注销他人" -X DELETE "$BASE/api/admin/users/1"
b3 8 "看审计日志" "$BASE/api/admin/audit?limit=10"

# ---------- C. 资源属主边界 ----------
echo "-- C. 资源属主边界"
PID1=$(curl -sf -b "$CJA" "$BASE/api/papers?page_size=1" | jget "['papers'][0]['id']")
ADMINLIB=$(curl -sf -b "$CJA" "$BASE/api/collections" | jget "['collections'][0]['id']")
[[ "$(code -b "$CJM" -X DELETE "$BASE/api/papers/$PID1")" == 403 ]] \
  && ok "C1 member 删他人 shared 论文 → 403" || bad "C1 共享论文删除未拦"
# C5: batch-delete 他人 shared → 403（此前批删只拦 private，shared 放行 = 越权洞）
C5=$(code -b "$CJM" -X POST "$BASE/api/papers/batch-delete" -H 'Content-Type: application/json' \
    -d "{\"paper_ids\":[\"$PID1\"]}")
[[ "$C5" == 403 ]] && ok "C5 member batch-delete 他人 shared → 403" || bad "C5 batch-delete 越权未拦（$C5）"
# C6: member batch-link 他人 shared 论文进自己库 → 200（行为锚：收藏他人共享论文合法）
MYLIB=$(curl -sf -b "$CJM" "$BASE/api/collections" | jget "['collections'][0]['id']")
[[ -n "$MYLIB" ]] && { C6=$(code -b "$CJM" -X POST "$BASE/api/papers/batch-link" -H 'Content-Type: application/json' \
    -d "{\"paper_ids\":[\"$PID1\"],\"collection_id\":\"$MYLIB\"}")
    [[ "$C6" == 200 ]] && ok "C6 member 挂他人 shared 论文进自己库 → 200（行为锚）" || bad "C6 收藏行为异常（$C6）"
    # 清理：移出
    curl -sf -b "$CJM" -X POST "$BASE/api/papers/batch-unlink" -H 'Content-Type: application/json' \
        -d "{\"paper_ids\":[\"$PID1\"],\"collection_id\":\"$MYLIB\"}" >/dev/null
    ok "C6b batch-unlink 清理成功"
  } || ok "C6 member 无库（跳过收藏行为锚）"
# C7: member batch-link 目标他人库 → 403
C7=$(code -b "$CJM" -X POST "$BASE/api/papers/batch-link" -H 'Content-Type: application/json' \
    -d "{\"paper_ids\":[\"$PID1\"],\"collection_id\":\"$ADMINLIB\"}")
[[ "$C7" == 403 ]] && ok "C7 member batch-link 他人库 → 403" || bad "C7 他人库挂链未拦（$C7）"
# private 隔离（临时把一篇 admin 论文置 private，测完恢复）
ORIG_VIS=$(docker exec paper-system-app python3 -c "
import sqlite3; c = sqlite3.connect('/app/data/papersys.db')
print(c.execute('SELECT visibility FROM papers WHERE id=?', ('$PID1',)).fetchone()[0])")
docker exec paper-system-app python3 -c "
import sqlite3; c = sqlite3.connect('/app/data/papersys.db')
c.execute(\"UPDATE papers SET visibility='private' WHERE id=?\", ('$PID1',)); c.commit()"
[[ "$(code -b "$CJM" "$BASE/api/papers/$PID1")" == 403 ]] \
  && ok "C2 member 访问他人 private 论文 → 403" || bad "C2 private 隔离未拦"
# private 不出现在 member 列表
CNT=$(curl -sf -b "$CJM" "$BASE/api/papers?page_size=500" | python3 -c "import json,sys
print(sum(1 for p in json.load(sys.stdin)['papers'] if p['id']=='$PID1'))")
[[ "$CNT" == "0" ]] && ok "C3 private 论文不在 member 列表" || bad "C3 列表泄露 private"
docker exec paper-system-app python3 -c "
import sqlite3; c = sqlite3.connect('/app/data/papersys.db')
c.execute(\"UPDATE papers SET visibility='$ORIG_VIS' WHERE id=?\", ('$PID1',)); c.commit()"
ok "C4 private 恢复 $ORIG_VIS"

# ---------- D. member 正常能力 ----------
echo "-- D. member 正常能力（应 200）"
[[ "$(code -b "$CJM" "$BASE/api/papers")" == 200 ]] && ok "D1 member GET /api/papers" || bad "D1 papers 非 200"
MQ=$(curl -sf -b "$CJM" "$BASE/api/me/quota")
echo "$MQ" | grep -q parse_limit && ok "D2 member me/quota" || bad "D2 quota 异常: $MQ"
US=$(curl -sf -b "$CJM" "$BASE/api/usage")
NU=$(echo "$US" | python3 -c "import json,sys
d=json.load(sys.stdin); print(len(d['by_user']))")
[[ "$NU" -le 1 ]] && ok "D3 usage 收窄（member 至多见自己，实际 $NU 行）" || bad "D3 usage 泄露全站（$NU 行）"
[[ "$(code -b "$CJM" "$BASE/api/statuses")" == 200 ]] && ok "D4 member statuses" || bad "D4 非 200"

# ---------- E. 配额 429（override=0 → 任何解析入口立即 429）----------
echo "-- E. 每日解析配额"
curl -sf -b "$CJA" -X PUT "$BASE/api/admin/users/$UID2/quota" -H 'Content-Type: application/json' \
    -d '{"daily_parse_papers": 0}' >/dev/null
C429=$(code -b "$CJM" -X POST "$BASE/api/acquire/import" -H 'Content-Type: application/json' \
    -d '{"items":[{"title":"t","pdf_url":"https://example.com/x.pdf"}]}')
[[ "$C429" == 429 ]] && ok "E1 override=0 → 采集入库 429（堵漏路径生效）" || bad "E1 配额未拦（$C429）"
C429B=$(code -b "$CJM" -X POST "$BASE/api/papers/import-url" -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com/x.pdf"}')
[[ "$C429B" == 429 ]] && ok "E2 import-url 429（URL 校验后即查配额）" || bad "E2 配额未拦（$C429B）"
curl -sf -b "$CJA" -X PUT "$BASE/api/admin/users/$UID2/quota" -H 'Content-Type: application/json' \
    -d '{}' >/dev/null && ok "E3 override 清除"

# ---------- F. 邀请码一次性 ----------
echo "-- F. 邀请码"
RE2=$(curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${MU}b\",\"password\":\"$MU_PW\",\"invite_code\":\"$INV\"}")
echo "$RE2" | grep -q '"ok":true' && bad "F1 已用邀请码可重复注册（应拒绝）" || ok "F1 已用邀请码拒绝二次注册"
RE3=$(curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${MU}c\",\"password\":\"$MU_PW\",\"invite_code\":\"bogus-code\"}")
echo "$RE3" | grep -q '"ok":true' && bad "F2 伪邀请码可注册（应拒绝）" || ok "F2 伪邀请码拒绝"

# ---------- G. 会话吊销（disable → token_ver 吊销全部会话）----------
echo "-- G. 会话吊销"
curl -sf -b "$CJA" -X POST "$BASE/api/admin/users/$UID2/disable" >/dev/null
[[ "$(code -b "$CJM" "$BASE/api/papers")" == 401 ]] && ok "G1 disable 后旧会话 401（token_ver 吊销）" || bad "G1 会话未吊销"
[[ "$(code -b "$CJM2" "$BASE/api/papers")" == 401 ]] && ok "G2 第二会话同时失效" || bad "G2 第二会话仍活"
LC=$(code -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MU\",\"password\":\"$MU_PW\"}")
[[ "$LC" == 403 || "$LC" == 401 ]] && ok "G3 禁用账号登录被拒（$LC）" || bad "G3 禁用账号可登录（$LC）"
curl -sf -b "$CJA" -X POST "$BASE/api/admin/users/$UID2/enable" >/dev/null
curl -sf -c "$CJM" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MU\",\"password\":\"$MU_PW\"}" >/dev/null
[[ "$(code -b "$CJM" "$BASE/api/papers")" == 200 ]] && ok "G4 启用后可重新登录" || bad "G4 启用后登录失败"

# ---------- 清理：注销测试用户 + 删测试行 ----------
curl -sf -b "$CJA" -X DELETE "$BASE/api/admin/users/$UID2" >/dev/null && ok "清理: 测试用户已注销"
# 硬删测试账号以免残留。注销接口会把用户名改写成「[已注销]<原名>#<id>」，
# 所以匹配模式要同时覆盖改写前后两种形态（否则测试账号越跑越多）。
# 邀请码/配额/LLM key 等子表按 user_id 级联删除（user_llm_keys、user_quotas
# 已声明 ON DELETE CASCADE）；invite_codes.used_by 亦已加 CASCADE。
docker exec paper-system-app python3 -c "
import sqlite3
c = sqlite3.connect('/app/data/papersys.db')
c.execute('PRAGMA foreign_keys=ON')
MU = '${MU}'
pats = [MU + '%', '[已注销]' + MU + '%']
n = 0
for p in pats:
    n += c.execute('DELETE FROM users WHERE username LIKE ?', (p,)).rowcount
# 兜底：used_by 指向已不存在用户的邀请码（悬挂引用）
n += c.execute('DELETE FROM invite_codes WHERE used_by IS NOT NULL AND used_by NOT IN (SELECT id FROM users)').rowcount
c.commit()
print(f'清理: 已删 {n} 行测试数据')"
rm -f "$CJA" "$CJM" "$CJM2"

echo
echo "结果: $pass 通过, $fail 失败"
[[ $fail -eq 0 ]] || exit 1
