/* ===== 10-settings.js —— 设置与管理：页签/配额/成员/审计 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const SET_TABS = [
  {id: 'acc',  label: '账号安全', icon: 'lock'},
  {id: 'ai',   label: 'AI 模型',  icon: 'key'},
  {id: 'gloss',label: '术语表',   icon: 'book'},
  {id: 'usage',label: '我的用量', icon: 'chart'},
];
function setTab() {
  const t = localStorage.getItem('ps-set-tab') || 'acc';
  return SET_TABS.some(x => x.id === t) ? t : 'acc';
}
async function renderSettings(tab) {
  const isAdmin = state.me?.role === 'admin';
  let cur = tab || setTab();
  if (cur === 'admin' && !isAdmin) cur = 'acc';   // 非管理员不能停管理页签
  localStorage.setItem('ps-set-tab', cur);
  const d = await api('/api/settings/llm');
  const tpl = (purpose, cfg, conf) => `
    <div class="set-card">
      <div class="set-head">${purpose === 'chat' ? icon('chat') + " 聊天（问答/导读）" : icon('globe') + " 翻译"} ${conf.configured ? '<span class="badge ok">已配置</span>' : '<span class="badge err">未配置</span>'}</div>
      <form id="f-${purpose}">
        <label>API 地址 <input name="base_url" value="${esc(conf.base_url)}" placeholder="https://open.bigmodel.cn/api/anthropic"></label>
        <label>模型 <input name="model" value="${esc(conf.model)}" placeholder="glm-4.7"></label>
        <label>协议 <select name="api_type"><option value="anthropic" ${(conf.api_type || (conf.base_url.includes('anthropic') ? 'anthropic' : 'openai')) === 'anthropic' ? 'selected' : ''}>anthropic</option><option value="openai" ${(conf.api_type || (conf.base_url.includes('anthropic') ? 'anthropic' : 'openai')) !== 'anthropic' ? 'selected' : ''}>openai</option></select></label>
        <label>API Key ${conf.configured ? '<span class="muted" style="font-size: var(--fs-xs)">已保存（留空不变）</span>' : ''} <input name="api_key" type="password" placeholder="${conf.configured ? '••••••（输入可更换）' : '粘贴 API Key'}"></label>
        <div class="set-actions">
          <button class="btn" type="button" onclick="testLlm('f-${purpose}')">${icon('bolt')} 测试</button>
          <button class="btn primary" type="submit">${icon('save')} 保存</button>
        </div>
      </form>
    </div>`;
  const tabs = SET_TABS.filter(t => !t.admin || isAdmin);
  $('#page-settings').innerHTML = `
    <div class="set-tabs" role="tablist">
      ${tabs.map(t => `<button class="set-tab ${cur === t.id ? 'on' : ''}" data-set-tab="${t.id}">${icon(t.icon)} ${t.label}</button>`).join('')}
    </div>
    <div class="set-panel" id="set-panel-${cur}">
      ${cur === 'acc' ? `
        <div class="set-card">
          <div class="set-head">${icon('lock')} 账号安全</div>
          <form id="f-password">
            <label>当前密码 <input name="old_password" type="password" required></label>
            <label>新密码（至少 8 位） <input name="new_password" type="password" minlength="8" required></label>
            <label>确认新密码 <input name="confirm" type="password" minlength="8" required></label>
            <div class="set-actions">
              <button class="btn primary" type="submit">${icon('check')} 修改密码</button>
              <button class="btn" type="button" onclick="logoutAll()">${icon('lock')} 登出所有设备</button>
            </div>
          </form>
        </div>` : ''}
      ${cur === 'ai' ? `
        <h2 class="page-h">${icon('key')} LLM 配置（BYOK）</h2>
        <p class="muted" style="font-size: var(--fs-sm);margin:2px 0 12px">聊天/翻译各自独立；embedding 本机运行无需配置。密钥加密存储、永不回显。</p>
        ${tpl('chat', d.chat, d.chat)}
        ${tpl('translate', d.translate, d.translate)}` : ''}
      ${cur === 'gloss' ? `
        <h2 class="page-h">${icon('book')} 翻译术语表（全局）</h2>
        <div id="gl-list" style="margin:10px 0"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="gl-term" placeholder="术语" style="flex:2;min-width:120px">
          <select id="gl-target" style="flex:1;min-width:100px">
            <option value="keep_en">保留英文</option><option value="trans">固定译法</option><option value="first_both">首次中英并列</option>
          </select>
          <input id="gl-value" placeholder="译法" style="flex:2;min-width:100px">
          <button class="btn small primary" id="gl-add" title="添加术语">${icon('plus')}</button>
        </div>` : ''}
      ${cur === 'usage' ? '<div id="me-quota-zone"></div>' : ''}
    </div>`;
  $$('#page-settings .set-tab').forEach(b => b.onclick = () => renderSettings(b.dataset.setTab));
  const bind = (fid, purpose) => {
    const form = $(`#${fid}`);
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const conf = {base_url: f.get('base_url'), model: f.get('model'), api_type: f.get('api_type')};
      if (f.get('api_key')) conf.api_key = f.get('api_key');
      await api('/api/settings/llm', {method: 'PUT', body: JSON.stringify({[purpose]: conf})});
      toast('已保存'); renderSettings();
    };
  };
  bind('f-chat', 'chat'); bind('f-translate', 'translate');
  if (cur === 'gloss') loadGlossary();
  if (cur === 'acc') {
    const pf = $('#f-password');
    if (pf) pf.onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      if (f.new_password.value !== f.confirm.value) { toast('两次输入的新密码不一致'); return; }
      try {
        await api('/api/password', {method: 'POST', body: JSON.stringify({
          old_password: f.old_password.value, new_password: f.new_password.value})});
        toast('密码已修改（其他设备已登出）');
        f.reset();
      } catch (err) { toast('修改失败: ' + err.message); }
    };
  }
  if (cur === 'usage') renderMeQuota();
}
/* 我的用量：真额度（解析/磁盘）+ 本月花费与预算闸。
   token 数字不展示——余额是上游商家的事，上游额度不足会原样报错；这里只给"花了多少/还能花多少"。 */
async function renderMeQuota() {
  const el = $('#me-quota-zone');
  if (!el) return;
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) return;
  const pPct = q.parse_limit ? Math.round(q.parse_used / q.parse_limit * 100) : 0;
  const usedGb = fmtGB(q.disk_used_bytes);
  const dPct = q.disk_limit_gb ? Math.round(usedGb / q.disk_limit_gb * 100) : 0;
  const bar = (pct, warn) => `<div class="progress" style="margin-top:4px">
    <i style="width:${Math.min(100, pct)}%;${pct >= warn ? 'background:var(--warn)' : ''}"></i></div>`;
  const purposeName = {chat: '问答/导读', translate: '翻译', summary: '导读', embed: '向量化', synthesis: '综述'};
  const costRows = Object.entries(q.cost_by_purpose || {})
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(purposeName[k] || k)}</td>
      <td class="num">¥${Number(v).toFixed(2)}</td>
      <td class="num" style="width:34%">
        <div class="progress"><i style="width:${q.month_cost ? Math.min(100, v / q.month_cost * 100) : 0}%"></i></div></td></tr>`).join('');
  const delta = q.prev_month_cost ? Math.round((q.month_cost - q.prev_month_cost) / q.prev_month_cost * 100) : 0;
  const hasBudget = q.budget > 0;
  el.innerHTML = `
    <h2 class="page-h">${icon('chart')} 我的用量</h2>
    <div class="set-card">
      <div class="set-head">本月花费
        <span class="muted" style="font-weight:400;font-size: var(--fs-xs)">按模型单价估算${q.cost_priced ? '' : '（当前模型未收录单价，估为 0——可在下方填你的实际单价）'}</span></div>
      <div style="font-size: var(--fs-h1);font-weight:600">¥${Number(q.month_cost || 0).toFixed(2)}
        ${q.prev_month_cost ? `<span class="muted" style="font-size: var(--fs-sm);font-weight:400">（上月 ¥${Number(q.prev_month_cost).toFixed(2)} ${delta >= 0 ? '↑' : '↓'}${Math.abs(delta)}%）</span>` : ''}</div>
      ${hasBudget ? `<div style="font-size: var(--fs-sm);margin-top:8px">月预算 ¥${q.budget} · 已用 <b>${q.budget_pct}%</b>
          ${q.budget_pct >= 100 ? '<span class="badge err">已用尽，将拦截调用</span>' : q.budget_pct >= 80 ? '<span class="badge run">接近上限</span>' : ''}</div>
        ${bar(q.budget_pct, 100)}`
        : `<div class="muted" style="font-size: var(--fs-sm);margin-top:6px">未设预算——不拦截调用；上游余额不足时由上游报错</div>`}
      ${costRows ? `<table class="list" style="margin-top:10px">${costRows}</table>` : ''}
      <div class="set-actions">
        <button class="btn small" onclick="openBudgetDialog()">设置预算 / 单价</button>
      </div>
    </div>
    <div class="set-card">
      <div class="set-head">额度上限</div>
      <div style="font-size: var(--fs-sm)">今日解析 <b>${q.parse_used}</b> / ${q.parse_limit} 篇${pPct >= 80 ? ' <span class="badge run">接近上限</span>' : ''}</div>
      ${bar(pPct, 80)}
      <div style="font-size: var(--fs-sm);margin-top:12px">磁盘已用 <b>${fmtGBs(q.disk_used_bytes)}</b> / ${q.disk_limit_gb} GB${dPct >= 90 ? ' <span class="badge err">空间紧张</span>' : ''}</div>
      ${bar(dPct, 90)}
      <div class="muted" style="font-size: var(--fs-xs);margin-top:10px">${q.month_calls || 0} 次调用（本月）</div>
    </div>`;
}

/* 审计动作名（库里是英文 action → 中文可读） */
const AUDIT_ACT = {
  'delete-user': '注销账号', 'enable-user': '启用账号', 'disable-user': '禁用账号',
  'reset-password': '重置密码', 'change-password': '修改密码', 'create_invite': '生成邀请码',
  'login': '登录', 'logout': '退出', 'create-topic': '新建专题', 'update-quota': '调整限额',
};
function auditActionName(a) { return AUDIT_ACT[a] || a; }

function renderAuditTable(rows) {
  const expanded = state._auditExpanded;
  const shown = expanded ? rows : rows.slice(0, 8);
  const trs = shown.map(r => `<tr>
    <td class="muted" style="font-size: var(--fs-xs)">${esc(relTime(r.created_at))}</td>
    <td style="font-size: var(--fs-sm)">${esc(r.username || '系统')}</td>
    <td style="font-size: var(--fs-sm)">${esc(auditActionName(r.action))}${r.detail ? ` <span class="muted">${esc(String(r.detail).slice(0, 40))}</span>` : ''}</td>
  </tr>`).join('');
  const more = rows.length > 8 && !expanded
    ? `<div style="padding:6px 0 0"><button class="btn small" id="audit-more">展开其余 ${rows.length - 8} 条</button></div>`
    : rows.length > 8 && expanded
    ? `<div style="padding:6px 0 0"><button class="btn small" id="audit-more">收起</button></div>` : '';
  return `<table class="list adm-table">
    <tr><th style="width:110px">时间</th><th style="width:110px">操作者</th><th>操作</th></tr>
    ${trs}</table>${more}`;
}

async function renderAdminZone() {
  const el = $('#page-admin');
  if (!el) return;
  const [users, pool, audit, smtp] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/pool').catch(() => ({enabled: false})),
    api('/api/admin/audit?limit=50').catch(() => ({rows: []})),
    api('/api/tracker/smtp').catch(() => ({configured: false})),
  ]);
  state._smtpReady = !!smtp.configured;
  const list = users.users || [];
  const memberN = list.filter(u => u.role !== 'admin' && u.disabled !== 2).length;
  const adminN = list.filter(u => u.role === 'admin').length;
  const paperN = list.reduce((n, u) => n + (u.papers || 0), 0);
  const diskN = list.reduce((n, u) => n + (u.disk_used || 0), 0);
  const costN = list.reduce((n, u) => n + (u.month_cost || 0), 0);
  const auditRows = (audit.rows || []).filter(r => r.action !== 'login');

  const quotaSummary = ov => {
    const keys = ['daily_parse_papers', 'max_file_mb', 'max_pages', 'max_disk_gb', 'monthly_budget_cny', 'tracker_subs'];
    const hit = keys.filter(k => ov[k] !== undefined && ov[k] !== null);
    return hit.length
      ? `<span class="badge run" title="${hit.join('、')}">${hit.length} 项自定义</span>`
      : '<span class="muted" style="font-size: var(--fs-xs)">默认</span>';
  };
  const stateBadge = u => u.disabled === 2 ? '<span class="badge dim">已注销</span>'
    : u.disabled === 1 ? '<span class="badge err">已禁用</span>'
    : u.role === 'admin' ? '<span class="badge ok">管理员</span>'
    : '<span class="badge ok">正常</span>';

  el.innerHTML = `
    <h2 class="page-h">${icon('crown')} 管理后台</h2>

    <div class="adm-stats">
      <div class="adm-stat"><span class="muted">成员</span><b>${memberN}</b><span class="muted">人活跃 · 管理员 ${adminN}${list.filter(u => u.disabled === 2).length ? ` · 已注销 ${list.filter(u => u.disabled === 2).length}` : ''}</span></div>
      <div class="adm-stat"><span class="muted">论文</span><b>${paperN}</b><span class="muted">篇 · 全员合计</span></div>
      <div class="adm-stat"><span class="muted">磁盘</span><b>${fmtGB(diskN).toFixed(1)}</b><span class="muted">GB 已用</span></div>
      <div class="adm-stat"><span class="muted">本月花费</span><b>¥${costN.toFixed(2)}</b><span class="muted">LLM 调用估算</span></div>
    </div>

    <div class="set-card">
      <div class="set-head">${icon('inbox')} 邮件发送（文献追踪日报的全局发件邮箱）
        <span class="badge ${state._smtpReady ? 'ok' : 'dim'}" style="margin-left:8px">${state._smtpReady ? '已配置' : '未配置'}</span>
        <button class="btn small" style="margin-left:auto" onclick="admSmtpToggle()">${state._smtpOpen ? '收起' : '配置'}</button></div>
      ${state._smtpOpen ? `
      <div style="display:grid;gap:8px;padding:4px 14px 12px">
        <div style="display:flex;gap:8px">
          <label class="tk-fld" style="flex:1">SMTP 主机
            <input id="smtp-host" value="${esc(state._smtpHost || '')}" placeholder="smtp.qq.com"></label>
          <label class="tk-fld" style="width:120px">端口
            <input id="smtp-port" value="${esc(String(state._smtpPort || 465))}"></label>
          <label class="tk-fld" style="flex:1.2">发件邮箱
            <input id="smtp-sender" value="${esc(state._smtpSender || '')}" placeholder="xxx@qq.com"></label>
          <label class="tk-fld" style="flex:1">授权码（留空=不改）
            <input id="smtp-pass" type="password" placeholder="${state._smtpReady ? '已保存' : 'SMTP 授权码'}"></label>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn primary" onclick="admSaveSmtp(this)">保存配置</button>
          <label class="tk-inline" style="margin-left:auto">测试发到
            <input id="smtp-test-to" placeholder="收件邮箱" style="width:200px"></label>
          <button class="btn" onclick="admTestSmtp(this)">发送测试</button>
        </div>
        <div class="muted" style="font-size: var(--fs-xs)">QQ/163 等邮箱需先开启 SMTP 并生成「授权码」（不是登录密码）；465=SSL，587=STARTTLS。配置一次全站共用——成员在文献追踪订阅里只填收件邮箱。</div>
      </div>` : ''}</div>

    <div class="set-card">
      <div class="set-head">${icon('user')} 成员管理
        <span class="muted" style="font-weight:400">限额留空=默认值；超限在调用前拦截</span>
        <span class="spacer"></span>
        <select id="invite-days" style="width:auto;font-size: var(--fs-sm)">
          <option value="3">3 天</option><option value="7" selected>7 天</option>
          <option value="14">14 天</option><option value="30">30 天</option>
        </select>
        <button class="btn small primary" onclick="createInvite()">${icon('plus')} 生成邀请码</button>
      </div>
      <div id="invite-out" style="margin:2px 0 10px;font-size: var(--fs-base)"></div>
      <table class="list adm-table">
        <tr><th>成员</th><th>状态</th><th class="num">论文</th><th class="num">磁盘</th>
            <th class="num">本月花费</th><th>限额</th><th style="width:auto"></th></tr>
        ${list.filter(u => u.disabled !== 2).map(u => {
          const ov = (() => { try { return JSON.parse(u.overrides || '{}'); } catch { return {}; } })();
          state._quotaRaw = state._quotaRaw || {};
          state._quotaRaw[u.id] = ov;
          const isSelf = u.id === state.me.id;
          return `<tr>
            <td><b>${esc(u.username)}</b>${u.role === 'admin' ? ' <span class="muted" style="font-size: var(--fs-xs)">admin</span>' : ''}</td>
            <td>${stateBadge(u)}</td>
            <td class="num">${u.papers || 0}</td>
            <td class="num">${fmtGBs(u.disk_used)}</td>
            <td class="num">¥${Number(u.month_cost || 0).toFixed(2)}</td>
            <td>${quotaSummary(ov)}</td>
            <td class="row-actions">
              <details class="adm-menu">
                <summary class="btn small" title="更多操作" aria-label="更多操作">更多 ▾</summary>
                <div class="tool-pop adm-menu-pop">
                  <div class="tp-item" onclick="openQuotaDialog(${u.id});this.closest('details').removeAttribute('open')">${icon('sliders')} 编辑限额</div>
                  <div class="tp-item" onclick="resetUserPw(${u.id}, '${esc(u.username)}');this.closest('details').removeAttribute('open')">${icon('key')} 重置密码</div>
                  ${!isSelf && u.role !== 'admin' && !u.disabled ? `<div class="tp-item" onclick="deleteUser(${u.id}, '${esc(u.username)}');this.closest('details').removeAttribute('open')">${icon('trash')} 注销账号</div>` : ''}
                  ${!isSelf && !u.disabled ? `<div class="tp-item" onclick="toggleUser(${u.id}, '${esc(u.username)}', true);this.closest('details').removeAttribute('open')">${icon('stop')} 禁用登录</div>` : ''}
                  ${u.disabled === 1 ? `<div class="tp-item" onclick="toggleUser(${u.id}, '${esc(u.username)}', false);this.closest('details').removeAttribute('open')">${icon('play')} 重新启用</div>` : ''}
                </div>
              </details>
            </td></tr>`;
        }).join('')}
      </table>
      ${(() => {
        const gone = list.filter(u => u.disabled === 2);
        if (!gone.length) return '';
        return `<details class="adm-gone"><summary class="muted">已注销 ${gone.length} 个账号（论文保留，可恢复）</summary>
          <table class="list adm-table" style="margin-top:6px">
            ${gone.map(u => `<tr><td class="muted" style="font-size: var(--fs-sm)">${esc(u.username)}</td>
              <td class="muted" style="font-size: var(--fs-xs)">已注销</td>
              <td class="num">${u.papers || 0}</td>
              <td colspan="4"></td></tr>`).join('')}
          </table></details>`;
      })()}
    </div>

    <div class="set-card">
      <div class="set-head">${icon('stack')} 公共额度池
        <span class="muted" style="font-weight:400">未配置 key 的成员可用管理员的 key 调用</span></div>
      <div class="pool-row">
        <span class="badge ${pool.enabled ? 'ok' : 'priv'}">${pool.enabled ? '已开启' : '已关闭'}</span>
        <span class="muted" style="font-size: var(--fs-sm)">${pool.enabled ? '成员未配 key 时走公共池' : '成员必须各自配置 key'}</span>
        <span class="spacer"></span>
        <button class="btn small ${pool.enabled ? 'danger' : 'primary'}" onclick="togglePool(${!pool.enabled})">${pool.enabled ? '关闭' : '开启'}</button>
      </div>
    </div>

    <div class="set-card">
      <div class="set-head">${icon('clock')} 审计日志
        <span class="muted" style="font-weight:400">敏感操作留痕（登录不计）</span></div>
      ${renderAuditTable(auditRows)}
        : '<p class="muted">暂无记录——删除/重置密码/禁用等敏感操作会记录在此</p>'}
    </div>`;

  const more = $('#audit-more');
  if (more) more.onclick = () => {
    state._auditExpanded = !state._auditExpanded;   // 切换展开（此前盲调 renderAdminZone——重渲染还是 8 条，按钮死循环）
    renderAdminZone();
  };
}

/* 限额编辑弹窗：6 个数字字段（留空=默认），保存复用 saveQuota */
function openQuotaDialog(uid) {
  const ov = (state._quotaRaw || {})[uid] || {};
  // suf = DOM 后缀（saveQuota 按后缀取值），key = 后端语义键（ov 里存的是语义键）
  const f = (suf, key, label, ph, min) => `<label class="adm-q-row"><span>${label}</span>
    <input id="q-${uid}-${suf}" type="number" min="${min}" style="width:100px;font-size: var(--fs-sm)"
      value="${ov[key] ?? ''}" placeholder="${ph}"></label>`;
  const {pop, close} = openPop('adm-quota-pop');
  pop.innerHTML = `
    <div class="ui-pop-title">编辑限额 <span class="muted" style="font-weight:400">留空 = 使用默认值</span></div>
    <div class="adm-q-grid">
      ${f('dp', 'daily_parse_papers', '每日解析篇数', '200', 1)}
      ${f('fm', 'max_file_mb', '单文件上限 MB', '100', 1)}
      ${f('pp', 'max_pages', '单篇页数', '500', 1)}
      ${f('dk', 'max_disk_gb', '磁盘上限 GB', '20', 1)}
      ${f('bg', 'monthly_budget_cny', '月预算 ¥', '不限', 0)}
      ${f('ts', 'tracker_subs', '订阅数上限', '5', 1)}
    </div>
    <div class="muted" style="font-size: var(--fs-xs);margin-top:6px">预算超限会在调用前拦截；解析篇数/页数/磁盘按上限校验。</div>
    <div class="ui-pop-foot">
      <button class="btn small" data-cancel>取消</button>
      <button class="btn small primary" data-ok>保存</button>
    </div>`;
  pop.querySelector('[data-cancel]').onclick = close;
  pop.querySelector('[data-ok]').onclick = async () => { await saveQuota(uid); close(); };
}
window.openQuotaDialog = openQuotaDialog;
/* 管理区动作（48b9862 改造时误删了实现，按钮留着 → 一按就 ReferenceError） */
window.createInvite = async () => {
  const days = +($('#invite-days')?.value || 7);
  const d = await api(`/api/admin/invite?days=${days}`, {method: 'POST'});
  const el = $('#invite-out');
  if (el) el.innerHTML = `邀请码: <code style="font-size: var(--fs-md)">${d.code}</code>（${d.expires_in_days} 天内有效，一次性）`
    + ` <button class="btn small" onclick="copyText('${d.code}', '邀请码已复制，转交给新成员')">复制</button>`;
};
window.logoutAll = async () => {
  if (!(await uiConfirm('登出所有设备？其他已登录的会话将全部失效（本设备保持登录）。', {title: '登出所有设备', danger: true}))) return;
  await api('/api/logout-all', {method: 'POST'});
  toast('其他设备已登出（本设备保持登录）');
};
window.toggleUser = async (uid, uname, disable) => {
  const act = disable ? '禁用' : '重新启用';
  if (!(await uiConfirm(`${act}用户 ${uname}？${disable ? '该用户将无法登录，已有会话全部失效。' : ''}`, {title: `${act}用户`, danger: disable}))) return;
  try {
    await api(`/api/admin/users/${uid}/${disable ? 'disable' : 'enable'}`, {method: 'POST'});
    toast(`已${act}`); renderAdminZone();
  } catch (e) { toast('操作失败: ' + e.message); }
};
window.resetUserPw = async (uid, uname) => {
  if (!(await uiConfirm(`重置 ${uname} 的密码？将生成一次性临时密码，且该用户所有会话立即失效。`, {title: '重置密码'}))) return;
  try {
    const r = await api(`/api/admin/users/${uid}/reset-password`, {method: 'POST'});
    await uiPassword(`${uname} 的临时密码（仅显示一次，请立即复制转交）`, r.temp_password);
  } catch (e) { toast('重置失败: ' + e.message); }
};

/* 结构化限额编辑：4 个数字字段 + 保留结构化编辑器之外的历史键（_quotaRaw 渲染时缓存） */
window.saveQuota = async uid => {
  const ov = {...((state._quotaRaw || {})[uid] || {})};
  const num = (suf, key) => {
    const v = $(`#q-${uid}-${suf}`)?.value.trim();
    if (v) ov[key] = +v; else delete ov[key];
  };
  num('dp', 'daily_parse_papers');
  num('fm', 'max_file_mb');
  num('pp', 'max_pages');
  num('dk', 'max_disk_gb');
  num('bg', 'monthly_budget_cny');
  num('ts', 'tracker_subs');          // 订阅数上限（弹窗有字段、保存曾漏传——断链修复）
  try {
    await api(`/api/admin/users/${uid}/quota`, {method: 'PUT', body: JSON.stringify(ov)});
    toast('已保存限额'); renderAdminZone();
  } catch (e) { toast('保存失败: ' + e.message); }
};
window.deleteUser = async (uid, uname) => {
  const inp = await uiPrompt(`注销账号 <b>${esc(uname)}</b>？将立即禁用并匿名化用户名（其论文保留、归属不变，可恢复）。<br>输入用户名以确认：`,
                             {placeholder: uname, okText: '确认注销', html: true});
  if (inp === null) return;
  if (inp.trim() !== uname) { toast('用户名不匹配，已取消'); return; }
  try {
    await api(`/api/admin/users/${uid}`, {method: 'DELETE'});
    toast('已注销'); renderAdminZone();
  } catch (e) { toast('操作失败: ' + e.message); }
};
/* 预算与单价设置：预算=0 表示不设闸（默认不拦）；单价覆盖按你的实际定价填 */
window.openBudgetDialog = async () => {
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) { toast('无法读取当前用量'); return; }
  const cur = q.budget || 0;
  const v = await uiPrompt(`月预算（元）——超过后拦截问答/翻译/导读/综述调用；填 0 表示不设闸。<br>
    当前本月已花 ¥${Number(q.month_cost || 0).toFixed(2)}`,
    {value: cur ? String(cur) : '', placeholder: '如 50（不设=留空）', okText: '保存'});
  if (v === null) return;
  const parsed = parseFloat(v);
  if (v !== '' && v !== null && !Number.isFinite(parsed)) { toast('请输入有效金额（数字）'); return; }
  if (Number.isFinite(parsed) && parsed < 0) { toast('预算不能为负'); return; }
  const budget = Number.isFinite(parsed) ? parsed : 0;
  try {
    await api('/api/me/budget', {method: 'PUT', body: JSON.stringify({budget})});
    toast(budget ? `月预算已设为 ¥${budget}` : '已取消预算（不再拦截）');
    renderMeQuota();
  } catch (e) { toast('保存失败: ' + e.message); }
};
window.togglePool = async enable => {
  await api('/api/admin/pool', {method: 'POST', body: JSON.stringify({enabled: enable})});
  toast(enable ? '公共池已开启' : '公共池已关闭');
  renderAdminZone();
};
window.testLlm = async fid => {
  const f = new FormData($('#' + fid));
  // key 留空 = 测试已保存配置（表单里的 base_url/模型仍生效）
  const r = await api('/api/settings/llm/test', {method: 'POST', body: JSON.stringify({
    base_url: f.get('base_url'), api_key: f.get('api_key'),
    model: f.get('model'), api_type: f.get('api_type'), purpose: fid.replace('f-', '')})});
  toast(r.ok ? '✅ ' + r.message : '❌ ' + r.message);
};
async function loadGlossary() {
  const d = await api('/api/glossary');
  const el = $('#gl-list');
  if (!el) return;
  el.innerHTML = d.terms.map(t =>
    `<span class="chip">${esc(t.term)}${t.target === 'trans' ? ' → ' + esc(t.value) : t.target === 'first_both' ? ' ⇄ ' + esc(t.value) : ' (EN)'}
     <button class="hover-only" title="删除该术语" onclick="delGlossary('${jsArg(t.term)}')">${icon('close')}</button></span>`).join('') ||
    '<span class="muted" style="font-size: var(--fs-sm)">暂无术语——按需添加以保证全文译名一致</span>';
  $('#gl-add').onclick = async () => {
    const term = $('#gl-term').value.trim();
    if (!term) { toast('请输入术语'); return; }
    const target = $('#gl-target').value, value = $('#gl-value').value.trim();
    if (target !== 'keep_en' && !value) { toast('该模式需要填写译法（否则该术语不会生效）'); return; }
    await api('/api/glossary', {method: 'POST', body: JSON.stringify({
      term, target, value})});
    $('#gl-term').value = ''; $('#gl-value').value = '';
    toast('已添加，下次翻译生效'); loadGlossary();
  };
}
window.delGlossary = async term => {
  if (!(await uiConfirm(`删除术语「${term}」？之后翻译将不再套用该术语。`, {title: '删除术语'}))) return;
  try {
    await api('/api/glossary/' + encodeURIComponent(term), {method: 'DELETE'});
    toast('已删除术语'); loadGlossary();
  } catch (e) { toast(friendlyError(e, '删除失败，请重试')); }
};


/* ---- 图表页签 ---- */
async function renderAssets() {
  const pid = state.current?.id;
  if (!pid) { $('#content-view').innerHTML = '<p class="muted">选择论文后查看图表</p>'; return; }
  if (!state.assets) state.assets = await api(`/api/papers/${pid}/assets`);
  const {figures: rawFigures, tables: rawTables, formulas: rawFormulas} = state.assets;
  const figures = (rawFigures || []).filter(f => f.image_path);
  const tables = (rawTables || []).filter(t => (t.html && t.html.trim()) || t.bbox);
  const formulas = rawFormulas || [];
  if (!figures.length && !tables.length && !formulas.length) {
    $('#content-view').innerHTML = '<p class="muted">未提取到图表</p>'; return;
  }
  if (state.view !== 'assets' || state.current?.id !== pid) return;   // 用户已切走：丢弃迟到渲染

  /* IvySCI 式布局：图表(混排)/公式 二级页签；条目按页分组，页头点击跳 PDF。
     混排排序 = (页码, bbox y0)——保持论文内的视觉顺序。 */
  const merged = [
    ...figures.map(f => ({kind: 'fig', page: f.page_index, y: (f.bbox || [0, 9])[1], f})),
    ...tables.map(t => ({kind: 'tbl', page: t.page_index, y: (t.bbox || [0, 9])[1], t})),
  ].sort((a, b) => a.page - b.page || a.y - b.y);
  const groups = [];
  for (const it of merged) {
    let g = groups[groups.length - 1];
    if (!g || g.page !== it.page) { g = {page: it.page, items: []}; groups.push(g); }
    g.items.push(it);
  }
  const eqGroups = [];
  for (const eq of formulas) {
    let g = eqGroups[eqGroups.length - 1];
    if (!g || g.page !== eq.page_index) { g = {page: eq.page_index, items: []}; eqGroups.push(g); }
    g.items.push(eq);
  }

  const capHtml = (cap, id) => cap ? `
    <p class="asset-cap" id="${id}">${esc(cap)}</p>
    ${cap.length > 120 ? `<a href="#" class="asset-cap-toggle" data-cap="${id}">展开</a>` : ''}` : '';

  const itemHtml = it => {
    if (it.kind === 'fig') {
      const f = it.f;
      return `<div class="asset">
        ${f.label ? `<span class="asset-badge" onclick="jumpEvidence(${f.page_index})" title="跳到 PDF 该页">${esc(f.label)}</span>` : ''}
        <div class="fig-grid">
          <img loading="lazy" src="/api/papers/${pid}/images/${f.image_path.split('/').pop()}" ondblclick="lightbox(this.src, '')">
          ${(f.extra_images || []).map(p => `<img loading="lazy" src="/api/papers/${pid}/images/${p.split('/').pop()}" ondblclick="lightbox(this.src, '')">`).join('')}
        </div>
        ${(f.sub_captions || []).length ? `<p class="muted" style="font-size: var(--fs-xs)">${esc(f.sub_captions.join(' | ').slice(0, 200))}</p>` : ''}
        ${capHtml(f.caption || '', `cap-${f.page_index}-${(f.image_path || '').replace(/\W/g, '')}`)}
      </div>`;
    }
    const t = it.t;
    return `<div class="asset">
      ${t.label ? `<span class="asset-badge" title="跳到 PDF 该页" onclick="jumpEvidence(${t.page_index})">${esc(t.label)}</span>` : ''}
      ${t.bbox ? `<figure class="fig-crop" data-page="${t.page_index}" data-ub='${JSON.stringify(t.bbox)}'>
        <div class="fig-holder">${t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : ''}</div>
      </figure>` : (t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : '')}
      ${capHtml(t.caption || '', `cap-t-${t.page_index}-${Math.round((t.bbox || [0, 0])[1] * 1000)}`)}
    </div>`;
  };

  const eqHtml = g => g.items.map(eq => {
    const tex = (eq.latex || '').trim();
    let r = null;
    if (state.katex && tex) { try { r = state.katex.renderToString(tex, {throwOnError: false, displayMode: true, strict: false, trust: true}); } catch {} }
    return `<div class="asset eq-asset" onclick="jumpEvidence(${eq.page_index})" title="跳到 PDF 该页">
      ${r ? r : `<code>${esc(tex.slice(0, 400))}</code>`}
    </div>`;
  }).join('');

  const tab = state.assetsTab || 'figs';
  const figsN = merged.length, eqsN = formulas.length;
  // 页签在次级工具条上（与原文/双语/中文同一行、同尺寸），这里只刷新计数与态
  $$('#assets-subtabs .asset-sub').forEach(b => {
    b.classList.toggle('on', b.dataset.at === tab);
    b.textContent = b.dataset.at === 'figs' ? `图表 (${figsN})` : `公式 (${eqsN})`;
    b.onclick = () => { state.assetsTab = b.dataset.at; renderAssets(); };
  });
  $('#content-view').innerHTML = `
    ${tab === 'figs'
      ? (merged.length ? groups.map(g => `
          <div class="asset-page">
            <div class="asset-page-head" onclick="jumpEvidence(${g.page})" title="跳到 PDF 该页">${icon('doc')} 第 ${g.page + 1} 页 <span class="muted">${g.items.length} 项 ${icon('arrowR', 11)}</span></div>
            ${g.items.map(itemHtml).join('')}
          </div>`).join('')
        : '<p class="muted" style="padding:12px">未提取到图表</p>')
      : (formulas.length ? eqGroups.map(g => `
          <div class="asset-page">
            <div class="asset-page-head" onclick="jumpEvidence(${g.page})" title="跳到 PDF 该页">${icon('doc')} 第 ${g.page + 1} 页 <span class="muted">${g.items.length} 式 ${icon('arrowR', 11)}</span></div>
            ${eqHtml(g)}
          </div>`).join('')
        : '<p class="muted" style="padding:12px">未提取到公式</p>')}
  `;
  // 题注展开/收起
  $$('.asset-cap-toggle', $('#content-view')).forEach(a => a.onclick = e => {
    e.preventDefault();
    const cap = $(`#${a.dataset.cap}`);
    const open = cap.classList.toggle('open');
    a.textContent = open ? '收起' : '展开';
  });
  figCropPass();
}

/* ---- 导读绘制（气泡/整栏两用） ----
   引文编号按字段独立（[1][2][3]），悬停显示"第 X 页 · 原文片段"，点击跳页。
   不再在底部铺一长串证据列表——那是各字段引用的并集，纯噪音。 */
function drawSummary(s, pid, target = '#content-view', asBubble = false) {
  const t = $(target);
  const sec = Object.entries(s.sections || {}).filter(([k]) => k !== 'followups');   // followups 走追问按钮，不作章节卡
  const evById = new Map((s.evidence || []).map(e => [String(e.evidence_id), e]));
  const citeMap = s.cite_map || {};
  const secHtml = sec.map(([k, v]) => {
    const local = citeMap[k] || {};
    // 编号由后端跨字段连续分配（整篇 [1][2][3]…），此处只做可点击渲染
    const html = mdLite(v).replace(/\[(\d{1,3})\]/g, (m, n) => {
      const gid = local[n];
      const ev = gid != null ? evById.get(String(gid)) : null;
      if (!ev) return m;                                   // 无对应证据 → 留原文
      const tip = `第${ev.page_index + 1}页 · ${(ev.text || '').slice(0, 120).replace(/\s+/g, ' ')}`;
      return `<span class="cite" data-gid="${gid}" title="${esc(tip)}">[${n}]</span>`;
    });
    return `<div class="summary-sec"><h3>${SUMMARY_NAMES[k] || k}</h3><div class="summary-body">${html}</div></div>`;
  }).join('');
  t.innerHTML = (asBubble ? (state._sumHead || '') + '<div class="msg assistant"><div class="bubble" style="width:100%">' : '<div class="card">') +
    (asBubble ? `<b class="sum-toggle" data-sum-toggle title="点击展开/收起导读">${icon('copy')} 导读（9 字段）<span class="sum-arrow">▾</span></b>` : '<h2>科研导读</h2>') +
    (sec.length ? secHtml : '<p class="muted">导读内容为空，请重新生成。</p>') +
    `</div>${asBubble ? '</div>' : ''}<button class="btn small" onclick="genSumBubble('${pid}')">${icon('retry')} 重新生成</button>`;
  if (asBubble) {
    t.insertAdjacentHTML('beforeend', followupButtons(s.sections));
    t.classList.add('sum-fold');   // 导读气泡默认收起——9 字段全文占问答区半屏
    t.querySelector('[data-sum-toggle]')?.addEventListener('click', () => t.classList.toggle('sum-fold'));
  }
  $$('.cite[data-gid]', t).forEach(el => {
    const ev = evById.get(String(el.dataset.gid));
    if (ev) { el._ev = ev; el.onclick = () => jumpToEvidence(ev); }
  });
}

/* ---- 对话导出 ---- */
window.copyJson = () => copyText(JSON.stringify(state.blocks, null, 2), 'JSON');
function exportChat() {
  if (!state.qaSession) { toast('当前还没有对话记录'); return; }
  location.href = `/api/chat/sessions/${state.qaSession}/export`;
}
window.exportChat = exportChat;   // 兼容内联 onclick 调用


/* ---- 📚 文库管理页（左库树 + 右条目 + 详情，参考 Zotero/EndNote 的下钻式） ---- */
state.libSel = localStorage.getItem('ps-lib-sel') || '';   // '' = 全部文献
state.scope = '';                                           // 侧栏快捷范围筛选
state.libQuery = '';                                        // 管理页搜索词
state._libPage = 1; state._libPageSize = 25;                // 文库表格真分页（25 篇/页）
state.libLevel = 1;                                         // 管理页层级: 1=库列表 2=库内
state.libView = 'card';                                     // 库列表视图: card | list
state._libQTimer = 0;


/* ---- 管理后台：邮件发送（全局发件 SMTP） ---- */
window.admSmtpToggle = async () => {
  state._smtpOpen = !state._smtpOpen;
  if (state._smtpOpen && !state._smtpLoaded) {
    try {
      const cfg = await api('/api/tracker/smtp');
      state._smtpHost = cfg.host || ''; state._smtpPort = cfg.port || 465; state._smtpSender = cfg.sender || '';
      state._smtpLoaded = true;
    } catch {}
  }
  renderAdminZone();
};
window.admSaveSmtp = async btn => {
  await withBusy(btn, async () => {
    const host = $('#smtp-host')?.value || '', sender = $('#smtp-sender')?.value || '';
    if (!host || !sender.includes('@')) { toast('SMTP 主机与发件邮箱必填'); return; }
    state._smtpHost = host; state._smtpPort = $('#smtp-port')?.value || 465; state._smtpSender = sender;
    await api('/api/tracker/smtp', {method: 'PUT', body: JSON.stringify({
      host, port: parseInt(state._smtpPort, 10) || 465, sender,
      password: $('#smtp-pass')?.value || '', sender_name: 'paper-system'})});
    state._smtpReady = true;
    toast('SMTP 配置已保存');
    renderAdminZone();
  }, '保存失败');
};
window.admTestSmtp = async btn => {
  const to = $('#smtp-test-to')?.value || '';
  if (!to.includes('@')) { toast('先填测试收件邮箱'); return; }
  await withBusy(btn, async () => {
    try {
      await api('/api/tracker/smtp/test', {method: 'POST', body: JSON.stringify({to})});
      toast(`测试邮件已发到 ${to}——收到即配置成功`, 5000);
    } catch (e) { toast(friendlyError(e, '发送失败——检查主机/端口/授权码')); }
  }, '发送中…');
};
