/* ===== 14-tracker.js —— 文献追踪：订阅巡逻 → 收件箱审阅 → 收进文献库 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。
   布局：Feedly 式双栏——左栏订阅导航（每源未读角标），右栏 KPI 统计带 + 按天分组内容流。 */

const ARXIV_CAT_PRESETS = ['cs.CV', 'eess.IV', 'cs.GR', 'cs.LG', 'cs.AI', 'cs.CL', 'physics.optics', 'math.AP'];
const _TIER_LABEL = {core: '核心', proxy: '相关', eco: '生态'};

function trackerTierBadge(tier) {
  const [label, cls] = {core: ['核心', 'ok'], proxy: ['相关', 'run'], eco: ['生态', 'dim']}[tier] || [tier, 'dim'];
  return `<span class="badge ${cls}" title="${label}层">${label}</span>`;
}

function trackerCondChips(s) {
  const kw = (s.keywords || '').split(',').map(x => x.trim()).filter(Boolean);
  const cats = (s.categories || '').split(/\s+/).filter(Boolean);
  const jns = (s.journals || '').split(',').map(x => x.trim()).filter(Boolean);
  const exc = (s.exclude || '').split(',').map(x => x.trim()).filter(Boolean);
  const h = [];
  for (const k of kw) h.push(`<span class="tk-chip kw" title="关键词">${esc(k)}</span>`);
  for (const c of cats) h.push(`<span class="tk-chip cat" title="arXiv 分类">${esc(c)}</span>`);
  for (const j of jns) h.push(`<span class="tk-chip jr" title="顶刊">${esc(j)}</span>`);
  for (const x of exc) h.push(`<span class="tk-chip ex" title="排除">✕ ${esc(x)}</span>`);
  return h.join('');
}

function trackerDayLabel(dateStr) {
  if (!dateStr) return '无日期';
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return dateStr.slice(0, 10);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 0 && diff < 7) return '本周';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/* ---------- 页面骨架：左栏订阅导航 + 右栏内容流 ---------- */
function renderTrackerPage() {
  const el = $('#page-tracker');
  el.innerHTML = `
  <div class="tk-wrap">
    <div class="tk-rail">
      <div class="tk-rail-head"><b>订阅</b>
        <button class="btn small primary" onclick="trackerNew()" title="新建订阅">${icon('plus')}</button></div>
      <div id="tk-rail-list"></div>
      <div class="tk-rail-flex"></div>
      <div class="tk-rail-foot" id="tk-rail-foot"></div>
    </div>
    <div class="tk-main">
      <div class="tk-kpis" id="tk-kpis"></div>
      <div id="tk-toolbar"></div>
      <div id="tk-stream"></div>
    </div>
  </div>`;
  loadTracker();
}
window.renderTrackerPage = renderTrackerPage;

function updateTrackerBadge(n) {
  const b = $('#tbadge');
  if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
}
window.refreshTrackerBadge = async () => {
  try {
    const d = await api('/api/tracker/items?page=1&page_size=1');
    updateTrackerBadge((d.counts || {}).inbox || 0);
  } catch {}  // noqa: 静默（角标非关键路径）
};

async function loadTracker() {
  const rail = $('#tk-rail-list'), foot = $('#tk-rail-foot'),
        kpis = $('#tk-kpis'), toolbar = $('#tk-toolbar'), stream = $('#tk-stream');
  if (!rail) return;
  const tier = state._trackerTier || '';
  const st = state._trackerStatus || 'new';
  const subF = state._trackerSub || '';
  const page = state._trackerPage || 1;
  let subs, inbox;
  try {
    [subs, inbox] = await Promise.all([
      api('/api/tracker/subs'),
      api(`/api/tracker/items?status=${st}&tier=${tier}&sub_id=${subF}&page=${page}&page_size=30`),
    ]);
  } catch (e) {
    rail.innerHTML = `<div class="empty-note" style="padding:8px">${esc(friendlyError(e))}</div>`;
    return;
  }
  state._trackerSubs = subs.subs;
  const counts = inbox.counts || {};
  updateTrackerBadge(counts.inbox || 0);
  const me = state.me || {};
  const curSub = subs.subs.find(s => s.id === subF) || null;

  /* ---- 左栏：订阅导航 ---- */
  const railItem = (label, badge, onclick, on, opts = {}) => `
    <div class="tk-rail-item ${on ? 'on' : ''}" onclick="${onclick}">
      <span class="tk-rail-name" ${opts.title ? `title="${esc(opts.title)}"` : ''}>${esc(label)}</span>
      ${badge != null && badge !== 0 ? `<span class="tk-rail-badge ${opts.dim ? 'dim' : ''}">${badge > 99 ? '99+' : badge}</span>` : ''}
      ${opts.icon ? `<span class="muted">${opts.icon}</span>` : ''}</div>`;
  rail.innerHTML =
    railItem('全部新到', counts.inbox, "trackerSubF('')", st === 'new' && !subF) +
    subs.subs.map(s => railItem(s.name, s.new_count, `trackerSubF('${s.id}')`,
                                st === 'new' && subF === s.id, {title: trackerCondChips(s)})).join('') +
    `<div class="tk-rail-sep"></div>` +
    railItem('已收进', counts.accepted, "trackerStatus('accepted')", st === 'accepted', {dim: 1}) +
    railItem('已忽略', counts.dismissed, "trackerStatus('dismissed')", st === 'dismissed', {dim: 1});
  foot.innerHTML = me.role === 'admin'
    ? `<div style="display:flex;align-items:center;gap:6px">邮件发送
         <span class="badge ${subs.smtp_ready ? 'ok' : 'dim'}">${subs.smtp_ready ? '已配置' : '未配置'}</span>
         <button class="btn small" style="margin-left:auto" onclick="trackerSmtpOpen()">${subs.smtp_ready ? '管理' : '配置'}</button></div>`
    : `邮件发送 ${subs.smtp_ready ? '<span class="badge ok">已配置</span>' : '<span class="badge dim">未配置（联系管理员）</span>'}`;

  /* ---- 右栏：KPI 统计带 ---- */
  kpis.innerHTML = [
    {n: counts.today, t: '24 小时新到', cls: 'hot'},
    {n: counts.inbox, t: '待处理', cls: ''},
    {n: counts.core, t: '核心命中', cls: ''},
    {n: counts.accepted, t: '已收进文献库', cls: ''},
  ].map(k => `<div class="tk-kpi ${k.cls}"><div class="n">${k.n}</div><div class="t">${k.t}</div></div>`).join('');

  /* ---- 右栏：工具行 ---- */
  const tierChips = [['', '全部层级'], ...Object.entries(_TIER_LABEL)]
    .map(([v, label]) => `<span class="chip-btn ${tier === v ? 'on' : ''}" onclick="trackerTierF('${v}')">${label}</span>`).join(' ');
  toolbar.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${curSub ? `<span class="tk-subtag">${icon('bulb')} ${esc(curSub.name)}
        <b class="muted" style="font-weight:400;cursor:pointer" onclick="trackerSubF('')" title="查看全部订阅">✕</b></span>
        <button class="btn small" onclick="trackerRun('${curSub.id}')">${icon('bolt')} 巡逻</button>` : ''}
      ${tierChips}
      <span style="margin-left:auto" class="muted">共 ${inbox.total} 条</span>
    </div>
    ${st === 'new' && selMapSize() ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-top:8px">
      已选 ${selMapSize()} 篇
      <button class="btn small primary" onclick="trackerBatchAccept(this)">批量收进文献库</button>
      <button class="btn small" onclick="trackerCkClear()">取消选择</button></div>` : ''}`;

  /* ---- 右栏：按天分组的条目流 ---- */
  const selMap = state._trackerSel || new Set();
  const groups = [];
  {
    let last = null, bucket = null;
    for (const it of inbox.items) {
      const day = trackerDayLabel(it.published || it.created_at);
      if (day !== last) { bucket = {day, items: []}; groups.push(bucket); last = day; }
      bucket.items.push(it);
    }
  }
  const groupHtml = groups.map(g => `
    <div class="tk-day"><span>${g.day}</span><span class="tk-day-n">${g.items.length} 篇</span><i></i></div>
    ${g.items.map(it => trackerItemHtml(it, selMap, st)).join('')}`).join('');
  stream.innerHTML = `
    ${groupHtml || `<div class="empty-state"><p class="t">${st === 'new' ? (subF ? '该订阅还没有新条目' : '收件箱是空的') : '没有条目'}</p>
       <p>${st === 'new' ? (subs.subs.length ? '点左栏订阅卡上的「巡逻」马上拉一轮' : '点左上「＋」新建订阅，系统按频率自动巡逻') : '换个筛选条件看看'}</p></div>`}
    ${inbox.total > (state._trackerPage || 1) * 30 ? `<div style="text-align:center;padding:10px">
      <button class="btn" onclick="trackerLoadMore()">加载更多（${inbox.total - (state._trackerPage || 1) * 30} 条未显示）</button></div>` : ''}`;
}
function selMapSize() { return (state._trackerSel || new Set()).size; }
window.trackerStatus = v => { state._trackerStatus = v; state._trackerSub = ''; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); loadTracker(); };
window.trackerSubF = id => { state._trackerSub = id; state._trackerStatus = 'new'; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); loadTracker(); };
window.trackerTierF = v => { state._trackerTier = v === state._trackerTier ? '' : v; state._trackerPage = 1; loadTracker(); };
window.trackerLoadMore = () => { state._trackerPage = (state._trackerPage || 1) + 1; loadTracker(); };
window.trackerCkClear = () => { state._trackerSel = new Set(); loadTracker(); };

/* ---------- 收件箱行 ---------- */
function trackerItemHtml(it, selMap, st) {
  const checked = selMap.has(it.id) ? 'checked' : '';
  const zh = it.zh_title ? `<div style="color:var(--text);margin-top:2px">${esc(it.zh_title)}</div>` : '';
  const code = it.code_url ? ` · <a href="${esc(it.code_url)}" target="_blank" rel="noopener" style="color:var(--primary)">代码 ↗</a>` : '';
  const pdf = it.pdf_url ? ` · <a href="${esc(it.pdf_url)}" target="_blank" rel="noopener" style="color:var(--text-2)">PDF ↗</a>` : '';
  const sum = it.zh_summary ? `<div style="color:var(--text-2);font-size:var(--fs-sm);margin-top:6px;line-height:1.6">${esc(it.zh_summary)}</div>` : '';
  const isNew = it.status === 'new' && st !== 'accepted' && st !== 'dismissed';
  const ck = isNew && st === 'new'
    ? `<input type="checkbox" class="tk-ck" data-iid="${it.id}" ${checked} onchange="trackerCk(this)" style="margin-top:3px">`
    : '<span style="width:13px;flex:none"></span>';
  const actions = isNew
    ? `<button class="btn small primary" onclick="trackerAccept('${it.id}', this)">收进文献库</button>
       ${!it.zh_summary ? `<button class="btn small" onclick="trackerEnrich('${it.id}', this)" title="LLM 生成中文总结与标题翻译">AI 摘要</button>` : ''}
       <button class="btn small danger hover-only" onclick="trackerDismiss('${it.id}', this)">忽略</button>`
    : `<span class="badge dim">${it.status === 'accepted' ? '已收进' : '已忽略'}</span>`;
  return `
  <div class="card tracker-item" data-iid="${it.id}" style="padding:12px 14px;margin:0 0 10px">
    <div style="display:flex;gap:10px;align-items:flex-start">
      ${ck}
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${trackerTierBadge(it.tier)}${it.is_fallback ? '<span class="badge dim" title="核心/相关不足时的补足项">补足</span>' : ''}
          <span class="muted" style="font-size:var(--fs-xs)">${esc(it.published || '')} · ${esc(it.venue || '')}
            · ${esc((it.authors || '').slice(0, 80))}${code}${pdf}</span>
        </div>
        <div style="font-weight:600;margin-top:4px">${esc(it.title)}</div>
        ${zh}${sum}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:none">${actions}</div>
    </div>
  </div>`;
}

/* ---------- 事件 ---------- */
window.trackerCk = async (ck) => {
  const sel = state._trackerSel || (state._trackerSel = new Set());
  if (ck.checked) sel.add(ck.dataset.iid); else sel.delete(ck.dataset.iid);
  const page = $('#page-tracker');
  const st = page.scrollTop;
  await loadTracker();
  page.scrollTop = st;
};

async function trackerAccept(id, btn) {
  await withBusy(btn, async () => {
    // collection_id 留空 → 服务端落入默认文献库
    const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({collection_id: ''})});
    toast(r.duplicate ? '已在文献库中（已自动挂库）' : '已收进文献库——解析已排队，进度见「任务」页', 4500);
  }, '收进失败');
}
window.trackerAccept = trackerAccept;

async function trackerBatchAccept(btn) {
  const sel = [...(state._trackerSel || new Set())];
  if (!sel.length) return;
  await withBusy(btn, async () => {
    let ok = 0, dup = 0;
    for (const id of sel) {
      try {
        const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({})});
        if (r.duplicate) dup++; else ok++;
      } catch (e) { /* 单条失败继续 */ }
    }
    state._trackerSel = new Set();
    toast(`批量收进完成：${ok} 篇新入库${dup ? `，${dup} 篇已在库` : ''}——解析排队进行中`, 5000);
  }, '批量收进失败');
}
window.trackerBatchAccept = trackerBatchAccept;

async function trackerDismiss(id, btn) {
  if (!(await uiConfirm('忽略这条？忽略后不再出现在收件箱（历史里仍可查）。', {title: '忽略', danger: true}))) return;
  await withBusy(btn, async () => {
    await api(`/api/tracker/items/${id}/dismiss`, {method: 'POST'});
  }, '操作失败');
}
window.trackerDismiss = trackerDismiss;

async function trackerEnrich(id, btn) {
  await withBusy(btn, async () => {
    const r = await api(`/api/tracker/items/${id}/enrich`, {method: 'POST'});
    toast('中文摘要已生成');
    const card = btn.closest('.tracker-item');
    if (card && r.zh_summary) {
      const m = document.createElement('div');
      m.style.cssText = 'color:var(--text-2);font-size:var(--fs-sm);margin-top:6px;line-height:1.6';
      m.textContent = r.zh_summary;
      card.querySelector('div[style*="flex:1"]')?.appendChild(m);
    }
  }, 'AI 摘要失败');
}
window.trackerEnrich = trackerEnrich;

/* ---------- 订阅表单（居中弹层） ---------- */
function trackerFormHtml(s = null) {
  const cats = s ? (s.categories || '').split(/\s+/).filter(Boolean) : [];
  const chips = ARXIV_CAT_PRESETS.map(c =>
    `<span class="chip-btn ${cats.includes(c) ? 'on' : ''}" data-cat="${c}"
           onclick="trackerToggleCat(this, '${c}')">${c}</span>`).join(' ');
  const freq = s?.frequency_hours || 24;
  const auto = s?.llm_auto || 'core';
  return `
  <div style="display:grid;gap:10px">
    <div class="tk-grid2">
      <label class="tk-fld">名称
        <input id="tk-name" value="${esc(s ? s.name : '')}" placeholder="如：3DGS 前沿"></label>
      <label class="tk-fld">巡逻频率
        <select id="tk-freq">
          <option value="6" ${freq === 6 ? 'selected' : ''}>每 6 小时</option>
          <option value="12" ${freq === 12 ? 'selected' : ''}>每 12 小时</option>
          <option value="24" ${freq === 24 ? 'selected' : ''}>每天</option>
          <option value="72" ${freq === 72 ? 'selected' : ''}>每 3 天</option>
          <option value="168" ${freq === 168 ? 'selected' : ''}>每周</option>
        </select></label>
    </div>
    <label class="tk-fld">关键词（逗号分隔，命中标题/摘要）
      <input id="tk-keywords" value="${esc(s ? s.keywords : '')}" placeholder="gaussian splatting, SLAM"></label>
    <div class="tk-fld">arXiv 分类
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${chips}</div>
      <input id="tk-cats" value="${esc(s ? s.categories : '')}" placeholder="或手填，空格分隔（如：cs.CV eess.IV）"></div>
    <div class="tk-grid2">
      <label class="tk-fld">排除词（逗号分隔，命中即不收）
        <input id="tk-exclude" value="${esc(s ? s.exclude : '')}" placeholder="survey, review"></label>
      <label class="tk-fld">顶刊期刊（逗号分隔，可空）
        <input id="tk-journals" value="${esc(s ? s.journals : '')}" placeholder="Nature, IEEE TPAMI"></label>
    </div>
    <div class="tk-row">
      <label class="tk-fld" style="flex:1">收件邮箱（接收巡逻日报）
        <input id="tk-email" value="${esc(s ? s.email_to : '')}" placeholder="you@example.com（可空）"></label>
      <label class="tk-inline">AI 摘要
        <select id="tk-auto">
          <option value="off" ${auto === 'off' ? 'selected' : ''}>不自动</option>
          <option value="core" ${auto === 'core' ? 'selected' : ''}>核心层</option>
          <option value="all" ${auto === 'all' ? 'selected' : ''}>全部</option>
        </select></label>
      <label class="tk-inline"><input type="checkbox" id="tk-mail-on" ${s?.email_enabled ? 'checked' : ''}> 发邮件</label>
      <label class="tk-inline"><input type="checkbox" id="tk-enabled" ${!s || s.enabled ? 'checked' : ''}> 启用</label>
    </div>
    ${s?.last_error ? `<div class="badge err" style="align-self:start;white-space:normal">上次错误：${esc(s.last_error.slice(0, 160))}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:2px">
      <button class="btn primary" onclick="trackerSave(${s ? `'${s.id}'` : 'null'})">${icon('check')} 保存</button>
      ${s ? `<button class="btn" onclick="trackerRun('${s.id}'); trackerCloseForm()" title="立即按此订阅巡逻一轮">${icon('bolt')} 立即跑一轮</button>` : ''}
      <button class="btn" onclick="trackerCloseForm()">取消</button>
      ${s ? `<button class="btn danger" style="margin-left:auto" onclick="trackerDel('${s.id}')">${icon('trash')} 删除</button>` : ''}
    </div>
  </div>`;
}

let _trackerFormPop = null;
function trackerOpenForm(s = null) {
  if (_trackerFormPop) _trackerFormPop.close();
  const {pop, close} = openPop('tk-form-pop');
  _trackerFormPop = {pop, close};
  pop.innerHTML = `<div class="ui-pop-title">${icon('bulb')} ${s ? '编辑订阅' : '新建订阅'}
    <button class="btn small" style="margin-left:auto" onclick="trackerCloseForm()">${icon('close')}</button></div>
    <div style="margin-top:10px">${trackerFormHtml(s)}</div>`;
  setTimeout(() => $('#tk-name')?.focus(), 50);
}
window.trackerCloseForm = () => { _trackerFormPop?.close(); _trackerFormPop = null; };
window.trackerNew = () => trackerOpenForm(null);
window.trackerEdit = id => {
  const sub = (state._trackerSubs || []).find(s => s.id === id);
  if (sub) trackerOpenForm(sub);
};

async function trackerSave(id) {
  const g = sel => _trackerFormPop?.pop?.querySelector(sel) || document.querySelector(sel);
  const payload = {
    name: g('#tk-name')?.value || '',
    keywords: g('#tk-keywords')?.value || '',
    categories: g('#tk-cats')?.value || '',
    exclude: g('#tk-exclude')?.value || '',
    journals: g('#tk-journals')?.value || '',
    frequency_hours: parseInt(g('#tk-freq')?.value || '24', 10),
    llm_auto: g('#tk-auto')?.value || 'core',
    email_to: g('#tk-email')?.value || '',
    email_enabled: g('#tk-mail-on')?.checked || false,
    enabled: g('#tk-enabled')?.checked !== false,
  };
  if (payload.email_to && !payload.email_to.includes('@')) { toast('收件邮箱格式不正确'); return; }
  try {
    if (id) await api(`/api/tracker/subs/${id}`, {method: 'PUT', body: JSON.stringify(payload)});
    else await api('/api/tracker/subs', {method: 'POST', body: JSON.stringify(payload)});
    toast(id ? '订阅已保存' : '订阅已创建——点卡上的「巡逻」马上拉一轮', 4500);
    trackerCloseForm();
    loadTracker();
  } catch (e) { toast(friendlyError(e, '保存失败')); }
}
window.trackerSave = trackerSave;

async function trackerDel(id) {
  if (!(await uiConfirm('删除订阅？收件箱中该订阅的历史条目一并删除。', {title: '删除订阅', danger: true}))) return;
  try { await api(`/api/tracker/subs/${id}`, {method: 'DELETE'}); toast('订阅已删除'); trackerCloseForm(); loadTracker(); }
  catch (e) { toast(friendlyError(e, '删除失败')); }
}
window.trackerDel = trackerDel;

async function trackerRun(id) {
  try {
    await api(`/api/tracker/run/${id}`, {method: 'POST'});
    toast('巡逻已开始——arXiv 检索约十几秒，结果会自动出现在收件箱', 4500);
  } catch (e) { toast(friendlyError(e, '启动巡逻失败')); }
}
window.trackerRun = trackerRun;

window.trackerToggleCat = (el, cat) => {
  el.classList.toggle('on');
  const inp = $('#tk-cats');
  if (!inp) return;
  const cats = new Set(inp.value.split(/\s+/).filter(Boolean));
  if (el.classList.contains('on')) cats.add(cat); else cats.delete(cat);
  inp.value = [...cats].join(' ');
};

/* ---------- SMTP 配置（admin，弹层） ---------- */
window.trackerSmtpOpen = async () => {
  if (_trackerFormPop) _trackerFormPop.close();
  const {pop, close} = openPop('tk-smtp-pop');
  _trackerFormPop = {pop, close};
  let cfg = {host: '', port: 465, sender: ''};
  try { cfg = {...cfg, ...(await api('/api/tracker/smtp'))}; } catch {}
  pop.innerHTML = `<div class="ui-pop-title">${icon('inbox')} 邮件发送（全局发件邮箱）
    <button class="btn small" style="margin-left:auto" onclick="trackerCloseForm()">${icon('close')}</button></div>
    <div style="display:grid;gap:8px;margin-top:10px">
      <div style="display:flex;gap:8px">
        <label class="tk-fld" style="flex:1">SMTP 主机
          <input id="smtp-host" value="${esc(cfg.host || '')}" placeholder="smtp.qq.com"></label>
        <label class="tk-fld" style="width:120px">端口
          <input id="smtp-port" value="${cfg.port || 465}"></label>
        <label class="tk-fld" style="flex:1.2">发件邮箱
          <input id="smtp-sender" value="${esc(cfg.sender || '')}" placeholder="xxx@qq.com"></label>
        <label class="tk-fld" style="flex:1">授权码（留空=不改）
          <input id="smtp-pass" type="password" placeholder="${cfg.configured ? '已保存' : 'SMTP 授权码'}"></label>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn primary" onclick="trackerSaveSmtp(this)">保存配置</button>
        <label class="tk-inline" style="margin-left:auto">测试发到
          <input id="smtp-test-to" placeholder="收件邮箱" style="width:200px"></label>
        <button class="btn" onclick="trackerTestSmtp(this)">发送测试</button>
      </div>
      <div class="muted" style="font-size:var(--fs-xs)">QQ/163 等邮箱需先开启 SMTP 并生成「授权码」（不是登录密码）；465=SSL，587=STARTTLS。配置一次全站共用——用户订阅里只填收件邮箱。</div>
    </div>`;
};
window.trackerSmtpToggle = window.trackerSmtpOpen;

async function trackerSaveSmtp(btn) {
  await withBusy(btn, async () => {
    const host = $('#smtp-host')?.value || '', sender = $('#smtp-sender')?.value || '';
    if (!host || !sender.includes('@')) { toast('SMTP 主机与发件邮箱必填'); return; }
    state._smtpHost = host; state._smtpPort = $('#smtp-port')?.value || 465; state._smtpSender = sender;
    await api('/api/tracker/smtp', {method: 'PUT', body: JSON.stringify({
      host, port: parseInt(state._smtpPort, 10) || 465, sender,
      password: $('#smtp-pass')?.value || '', sender_name: 'paper-system'})});
    toast('SMTP 配置已保存');
    trackerCloseForm();
    loadTracker();
  }, '保存失败');
}
window.trackerSaveSmtp = trackerSaveSmtp;

async function trackerTestSmtp(btn) {
  const to = $('#smtp-test-to')?.value || '';
  if (!to.includes('@')) { toast('先填测试收件邮箱'); return; }
  await withBusy(btn, async () => {
    try {
      await api('/api/tracker/smtp/test', {method: 'POST', body: JSON.stringify({to})});
      toast(`测试邮件已发到 ${to}——收到即配置成功`, 5000);
    } catch (e) { toast(friendlyError(e, '发送失败——检查主机/端口/授权码')); }
  }, '发送中…');
}
window.trackerTestSmtp = trackerTestSmtp;
