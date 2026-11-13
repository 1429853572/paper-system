/* ===== 14-tracker.js —— 文献追踪：订阅巡逻 → 收件箱审阅 → 收进文献库 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */

const ARXIV_CAT_PRESETS = ['cs.CV', 'eess.IV', 'cs.GR', 'cs.LG', 'cs.AI', 'cs.CL', 'physics.optics', 'math.AP'];

function trackerTierBadge(tier) {
  const map = {core: ['核心', 'ok'], proxy: ['相关', 'run'], eco: ['生态', 'dim']};
  const [label, cls] = map[tier] || [tier, 'dim'];
  return `<span class="badge ${cls}" title="${label}层">${label}</span>`;
}

function trackerCondSummary(s) {
  const parts = [];
  const kws = (s.keywords || '').split(',').map(x => x.trim()).filter(Boolean);
  const cats = (s.categories || '').split(/\s+/).filter(Boolean);
  const jns = (s.journals || '').split(',').map(x => x.trim()).filter(Boolean);
  const exc = (s.exclude || '').split(',').map(x => x.trim()).filter(Boolean);
  if (kws.length) parts.push(`关键词 ${kws.length}`);
  if (cats.length) parts.push(`分类 ${cats.join(' ')}`);
  if (jns.length) parts.push(`期刊 ${jns.length}`);
  if (exc.length) parts.push(`排除 ${exc.length}`);
  return parts.join(' · ') || '未配置';
}

function trackerSubFormHtml(s = null) {
  const isEdit = !!s;
  const cats = isEdit ? (s.categories || '').split(/\s+/).filter(Boolean) : [];
  const chips = ARXIV_CAT_PRESETS.map(c =>
    `<span class="chip-btn ${cats.includes(c) ? 'on' : ''}" data-cat="${c}"
           onclick="trackerToggleCat(this, '${c}')">${c}</span>`).join(' ');
  const auto = isEdit ? (s.llm_auto || 'core') : 'core';
  return `
  <div class="set-card" id="tracker-sub-form" style="margin:10px 0">
    <div class="set-head">${isEdit ? '编辑订阅' : '新建订阅'}</div>
    <div style="display:grid;gap:8px;padding:12px 14px">
      <label style="display:flex;gap:8px;align-items:center">名称
        <input id="tk-name" value="${esc(isEdit ? s.name : '')}" placeholder="如：3DGS 前沿" style="flex:1"></label>
      <label style="display:flex;gap:8px;align-items:center">关键词
        <input id="tk-keywords" value="${esc(isEdit ? s.keywords : '')}" placeholder="逗号分隔，命中标题/摘要（如：gaussian splatting, SLAM）" style="flex:1"></label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">arXiv 分类 ${chips}
        <input id="tk-cats" value="${esc(isEdit ? s.categories : '')}" placeholder="或手填：空格分隔" style="flex:1;min-width:180px"></div>
      <label style="display:flex;gap:8px;align-items:center">排除词
        <input id="tk-exclude" value="${esc(isEdit ? s.exclude : '')}" placeholder="逗号分隔（命中即不进收件箱）" style="flex:1"></label>
      <label style="display:flex;gap:8px;align-items:center">顶刊期刊
        <input id="tk-journals" value="${esc(isEdit ? s.journals : '')}" placeholder="逗号分隔期刊名（可空，如：Nature,IEEE Transactions on Pattern Analysis）" style="flex:1"></label>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center">巡逻频率
          <select id="tk-freq" style="width:auto">
            <option value="6" ${isEdit && s.frequency_hours === 6 ? 'selected' : ''}>每 6 小时</option>
            <option value="12" ${isEdit && s.frequency_hours === 12 ? 'selected' : ''}>每 12 小时</option>
            <option value="24" ${(!isEdit || s.frequency_hours === 24) ? 'selected' : ''}>每天</option>
            <option value="72" ${isEdit && s.frequency_hours === 72 ? 'selected' : ''}>每 3 天</option>
            <option value="168" ${isEdit && s.frequency_hours === 168 ? 'selected' : ''}>每周</option>
          </select></label>
        <label style="display:flex;gap:6px;align-items:center">AI 中文摘要
          <select id="tk-auto" style="width:auto">
            <option value="off" ${auto === 'off' ? 'selected' : ''}>不自动（可手动点）</option>
            <option value="core" ${auto === 'core' ? 'selected' : ''}>仅核心层（推荐）</option>
            <option value="all" ${auto === 'all' ? 'selected' : ''}>全部条目</option>
          </select></label>
        <label style="display:flex;gap:6px;align-items:center">收件邮箱
          <input id="tk-email" value="${esc(isEdit ? s.email_to : '')}" placeholder="接收巡逻日报（可空）" style="width:220px"></label>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="tk-mail-on"
          ${isEdit && s.email_enabled ? 'checked' : ''}> 发邮件</label>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="tk-enabled"
          ${!isEdit || s.enabled ? 'checked' : ''}> 启用</label>
      </div>
      ${isEdit && s.last_error ? `<div class="badge err" style="align-self:start">上次错误：${esc(s.last_error.slice(0, 120))}</div>` : ''}
      <div style="display:flex;gap:8px">
        <button class="btn primary" onclick="trackerSave(${isEdit ? `'${s.id}'` : 'null'})">保存</button>
        ${isEdit ? `<button class="btn" onclick="trackerRun('${s.id}')" title="立即按此订阅巡逻一轮">${icon('bolt')} 立即跑一轮</button>` : ''}
        <button class="btn" onclick="trackerCancelEdit()">取消</button>
        ${isEdit ? `<button class="btn danger" style="margin-left:auto" onclick="trackerDel('${s.id}')">${icon('trash')} 删除订阅</button>` : ''}
      </div>
    </div>
  </div>`;
}

function trackerSubCardHtml(s, counts) {
  const last = s.last_run_at ? relTime(s.last_run_at) : '从未';
  return `
  <div class="set-card" style="margin:10px 0">
    <div class="set-head">${esc(s.name)} ${s.enabled ? '' : '<span class="badge dim">已停用</span>'}
      <span style="margin-left:auto;font-size:var(--fs-xs);color:var(--text-2)">
        条件：${esc(trackerCondSummary(s))} · 频率：每 ${s.frequency_hours} 小时 · 上次巡逻：${last}</span></div>
    <div style="display:flex;gap:8px;padding:10px 14px;align-items:center;flex-wrap:wrap">
      ${s.last_error ? `<span class="badge err" title="${esc(s.last_error.slice(0, 150))}">上次出错</span>` : ''}
      <span class="badge ${s.llm_auto === 'off' ? 'dim' : 'ok'}">AI 摘要：${{off: '关', core: '核心层', all: '全部'}[s.llm_auto] || s.llm_auto}</span>
      ${s.email_enabled && s.email_to ? `<span class="badge dim">日报 → ${esc(s.email_to)}</span>` : ''}
      <span style="margin-left:auto"></span>
      <button class="btn small" onclick="trackerRun('${s.id}')">${icon('bolt')} 立即跑一轮</button>
      <button class="btn small" onclick="trackerEdit('${s.id}')">${icon('edit')} 编辑</button>
    </div>
  </div>`;
}

function trackerItemHtml(it, selMap) {
  const checked = selMap.has(it.id) ? 'checked' : '';
  const zh = it.zh_title ? `<div style="font-size:var(--fs-base);margin-top:1px">${esc(it.zh_title)}</div>` : '';
  const code = it.code_url ? ` · <a href="${esc(it.code_url)}" target="_blank" rel="noopener" style="color:var(--primary)">代码 ↗</a>` : '';
  const pdf = it.pdf_url ? ` · <a href="${esc(it.pdf_url)}" target="_blank" rel="noopener" style="color:var(--text-2)">PDF ↗</a>` : '';
  const sum = it.zh_summary ? `<div style="color:var(--text-2);font-size:var(--fs-sm);margin-top:4px">${esc(it.zh_summary)}</div>` : '';
  return `
  <div class="card tracker-item" data-iid="${it.id}" style="padding:12px 14px;margin:8px 0">
    <div style="display:flex;gap:10px;align-items:flex-start">
      <input type="checkbox" class="tk-ck" data-iid="${it.id}" ${checked}
             onchange="trackerCk(this)" style="margin-top:3px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${trackerTierBadge(it.tier)}${it.is_fallback ? '<span class="badge dim" title="核心/相关不足时的补足项">补足</span>' : ''}
          ${it.status !== 'new' ? `<span class="badge dim">${it.status === 'accepted' ? '已收进' : '已忽略'}</span>` : ''}
          <span class="muted" style="font-size:var(--fs-xs)">${esc(it.published || '')} · ${esc(it.venue || '')}
            · ${esc((it.authors || '').slice(0, 90))}${code}${pdf}</span>
        </div>
        <div style="font-weight:600;margin-top:4px"><a href="#" style="color:inherit"
             onclick="return false">${esc(it.title)}</a></div>
        ${zh}${sum}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:none">
        ${it.status === 'new' ? `
          <button class="btn small primary" onclick="trackerAccept('${it.id}', this)">收进文献库</button>
          ${!it.zh_summary ? `<button class="btn small" onclick="trackerEnrich('${it.id}', this)" title="LLM 生成中文总结与标题翻译">AI 摘要</button>` : ''}
          <button class="btn small danger hover-only" onclick="trackerDismiss('${it.id}', this)">忽略</button>` : `
          <span class="badge dim">${it.status === 'accepted' ? `paper: ${String(it.paper_id).slice(0, 12)}` : ''}</span>`}
      </div>
    </div>
  </div>`;
}

function renderTrackerPage() {
  const el = $('#page-tracker');
  el.innerHTML = `<div style="max-width:1080px;margin:0 auto">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 style="margin:0">文献追踪</h2>
      <span class="muted">按关键词/分类/期刊定时巡逻 arXiv 与顶刊，新论文进收件箱审阅后收进文献库</span>
      <span style="margin-left:auto"></span>
      <button class="btn primary" onclick="trackerNew()">${icon('plus')} 新建订阅</button>
    </div>
    <div id="tracker-alert" style="margin-top:8px"></div>
    <div id="tracker-subs"></div>
    <div id="tracker-inbox" style="margin-top:16px"></div>
  </div>`;
  loadTracker();
}
window.renderTrackerPage = renderTrackerPage;

async function loadTracker() {
  const subsEl = $('#tracker-subs'), inboxEl = $('#tracker-inbox');
  if (!subsEl) return;
  let subs, inbox;
  try {
    const tier = state._trackerTier || '';
    const st = state._trackerStatus || 'new';
    const page = state._trackerPage || 1;
    [subs, inbox] = await Promise.all([
      api('/api/tracker/subs'),
      api(`/api/tracker/items?status=${st}&tier=${tier}&page=${page}&page_size=30`),
    ]);
  } catch (e) {
    subsEl.innerHTML = `<div class="empty-state"><p class="t">加载失败</p><p>${esc(friendlyError(e))}</p></div>`;
    return;
  }
  const counts = inbox.counts || {};
  updateTrackerBadge(counts.inbox || 0);

  // 订阅区
  const me = state.me || {};
  const smtpHint = me.role === 'admin'
    ? '' : (subs.smtp_ready ? '' : `<div class="empty-note" style="margin-top:8px">邮件日报需要管理员先在下方配置发件邮箱</div>`);
  const smtpCard = me.role === 'admin' ? trackerSmtpCardHtml(subs.smtp_ready) : '';
  subsEl.innerHTML =
    (state._trackerEdit === 'new' ? trackerSubFormHtml(null) : '') +
    subs.subs.map(s => (state._trackerEdit === s.id ? trackerSubFormHtml(s) : trackerSubCardHtml(s, counts))).join('') +
    (subs.subs.length || state._trackerEdit ? '' :
      `<div class="empty-state"><p class="t">还没有订阅</p>
       <p>点「新建订阅」：填关键词与 arXiv 分类（或顶刊期刊名），系统按频率自动巡逻新论文</p></div>`) +
    smtpCard + (smtpHint || '');
  if (state._trackerEdit !== 'new') {
    const nf = $('#tracker-new-form'); if (nf) nf.remove();
  }

  // 收件箱区
  const st = state._trackerStatus || 'new';
  const tier = state._trackerTier || '';
  const chips = [['', '全部新'], ['core', '核心'], ['proxy', '相关'], ['eco', '生态'], ['all', '全部']]
    .map(([v, label]) => `<span class="chip-btn ${st === v && !tier ? 'on' : ''}" onclick="trackerStatus('${v}')">${label}</span>`).join(' ');
  const tierChips = [['core', '核心'], ['proxy', '相关'], ['eco', '生态']]
    .map(([v, label]) => `<span class="chip-btn ${tier === v ? 'on' : ''}" onclick="trackerTierF('${v}')">${label}</span>`).join(' ');
  const selMap = state._trackerSel || new Set();
  const stLabel = st === 'new' ? '收件箱（新）' : st === 'all' ? '全部条目' : st === 'dismissed' ? '已忽略' : '已收进';
  inboxEl.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <h3 style="margin:0">收件箱</h3> ${chips}
      ${st === 'new' ? `<span class="muted">| 层级：</span>${tierChips}<span class="chip-btn ${!tier ? 'on' : ''}" onclick="trackerTierF('')">全部层级</span>` : ''}
      <span style="margin-left:auto" class="muted">共 ${inbox.total} 条</span>
    </div>
    ${st === 'new' && selMap.size ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-top:8px">
      已选 ${selMap.size} 篇
      <button class="btn small primary" onclick="trackerBatchAccept(this)">批量收进文献库</button>
      <button class="btn small" onclick="trackerCkClear()">取消选择</button></div>` : ''}
    ${inbox.items.length ? inbox.items.map(it => trackerItemHtml(it, selMap)).join('') :
      `<div class="empty-state"><p class="t">${st === 'new' ? '收件箱是空的' : '没有条目'}</p>
       <p>${st === 'new' ? '订阅巡逻到新论文后会出现在这里；也可以点订阅卡的「立即跑一轮」马上巡逻' : '换个筛选条件看看'}</p></div>`}
    ${inbox.total > (state._trackerPage || 1) * 30 ? `<div style="text-align:center;padding:10px">
      <button class="btn" onclick="trackerLoadMore()">加载更多（${inbox.total - (state._trackerPage || 1) * 30} 条未显示）</button></div>` : ''}`;
}
window.trackerStatus = v => { state._trackerStatus = v; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); loadTracker(); };
window.trackerTierF = v => { state._trackerTier = v === state._trackerTier ? '' : v; state._trackerPage = 1; loadTracker(); };
window.trackerLoadMore = () => { state._trackerPage = (state._trackerPage || 1) + 1; loadTracker(); };
window.trackerCkClear = () => { state._trackerSel = new Set(); loadTracker(); };

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

/* ---- 订阅编辑 ---- */
window.trackerNew = () => { state._trackerEdit = 'new'; loadTracker();
  $('#tracker-subs').scrollIntoView({behavior: 'smooth', block: 'start'}); };
window.trackerEdit = id => { state._trackerEdit = id; loadTracker(); };
window.trackerCancelEdit = () => { state._trackerEdit = null; loadTracker(); };
window.trackerToggleCat = (el, cat) => {
  el.classList.toggle('on');
  const inp = $('#tk-cats');
  if (!inp) return;
  const cats = new Set(inp.value.split(/\s+/).filter(Boolean));
  if (el.classList.contains('on')) cats.add(cat); else cats.delete(cat);
  inp.value = [...cats].join(' ');
};

async function trackerSave(id) {
  const payload = {
    name: $('#tk-name')?.value || '',
    keywords: $('#tk-keywords')?.value || '',
    categories: $('#tk-cats')?.value || '',
    exclude: $('#tk-exclude')?.value || '',
    journals: $('#tk-journals')?.value || '',
    frequency_hours: parseInt($('#tk-freq')?.value || '24', 10),
    llm_auto: $('#tk-auto')?.value || 'core',
    email_to: $('#tk-email')?.value || '',
    email_enabled: $('#tk-mail-on')?.checked || false,
    enabled: $('#tk-enabled')?.checked !== false,
  };
  if (payload.email_to && !payload.email_to.includes('@')) { toast('收件邮箱格式不正确'); return; }
  try {
    if (id) await api(`/api/tracker/subs/${id}`, {method: 'PUT', body: JSON.stringify(payload)});
    else {
      const r = await api('/api/tracker/subs', {method: 'POST', body: JSON.stringify(payload)});
      toast('订阅已创建——点「立即跑一轮」马上巡逻', 4000);
      state._trackerEdit = r.id;    // 保持表单展开（含「立即跑一轮」按钮）
      loadTracker();
      return;
    }
    toast('已保存');
    state._trackerEdit = null;
    loadTracker();
  } catch (e) { toast(friendlyError(e, '保存失败')); }
}
window.trackerSave = trackerSave;

async function trackerDel(id) {
  if (!(await uiConfirm('删除订阅？收件箱中该订阅的历史条目一并删除。', {title: '删除订阅', danger: true}))) return;
  try { await api(`/api/tracker/subs/${id}`, {method: 'DELETE'}); toast('订阅已删除'); state._trackerEdit = null; loadTracker(); }
  catch (e) { toast(friendlyError(e, '删除失败')); }
}
window.trackerDel = trackerDel;

async function trackerRun(id) {
  const btn = document.querySelector(`#tracker-subs .btn[onclick*="'${id}'"]`);
  try {
    await api(`/api/tracker/run/${id}`, {method: 'POST'});
    toast('巡逻已开始——arXiv 检索约十几秒，结果会自动出现在收件箱', 4500);
  } catch (e) { toast(friendlyError(e, '启动巡逻失败')); }
}
window.trackerRun = trackerRun;

/* ---- 收件箱行操作 ---- */
window.trackerCk = async (ck) => {
  const sel = state._trackerSel || (state._trackerSel = new Set());
  if (ck.checked) sel.add(ck.dataset.iid); else sel.delete(ck.dataset.iid);
  const page = $('#page-tracker');
  const st = page.scrollTop;
  await loadTracker();
  page.scrollTop = st;          // 勾选触发的重渲染保持滚动位置
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
    if (card) {
      const m = document.createElement('div');
      m.style.cssText = 'color:var(--text-2);font-size:var(--fs-sm);margin-top:4px';
      m.textContent = r.zh_summary || '';
      card.querySelector('div[style*="flex:1"]')?.appendChild(m);
    }
  }, 'AI 摘要失败');
}
window.trackerEnrich = trackerEnrich;

/* ---- SMTP 配置卡（admin） ---- */
function trackerSmtpCardHtml(ready) {
  state._smtpOpen = state._smtpOpen || false;
  return `
  <div class="set-card" style="margin:10px 0">
    <div class="set-head">邮件发送（全局发件邮箱，配置一次全站共用）
      <span class="badge ${ready ? 'ok' : 'dim'}" style="margin-left:8px">${ready ? '已配置' : '未配置'}</span>
      <button class="btn small" style="margin-left:auto" onclick="trackerSmtpToggle()">
        ${state._smtpOpen ? '收起' : '配置'}</button></div>
    ${state._smtpOpen ? `
    <div style="display:grid;gap:8px;padding:12px 14px">
      <div style="display:flex;gap:8px">
        <label style="display:flex;gap:6px;align-items:center;flex:1">SMTP 主机
          <input id="smtp-host" value="${esc(state._smtpHost || '')}" placeholder="smtp.qq.com" style="flex:1"></label>
        <label style="display:flex;gap:6px;align-items:center;width:120px">端口
          <input id="smtp-port" value="${esc(String(state._smtpPort || 465))}" style="width:70px"></label>
      </div>
      <div style="display:flex;gap:8px">
        <label style="display:flex;gap:6px;align-items:center;flex:1">发件邮箱
          <input id="smtp-sender" value="${esc(state._smtpSender || '')}" placeholder="xxx@qq.com" style="flex:1"></label>
        <label style="display:flex;gap:6px;align-items:center;flex:1">授权码（留空=不改）
          <input id="smtp-pass" type="password" placeholder="${ready ? '已保存——留空保持不变' : 'SMTP 授权码'}" style="flex:1"></label>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn primary" onclick="trackerSaveSmtp(this)">保存配置</button>
        <label style="display:flex;gap:6px;align-items:center;margin-left:auto">测试发到
          <input id="smtp-test-to" placeholder="收件邮箱" style="width:200px"></label>
        <button class="btn" onclick="trackerTestSmtp(this)">发送测试</button>
      </div>
      <div class="muted" style="font-size:var(--fs-xs)">QQ/163 等邮箱需在邮箱设置里开启 SMTP 并生成「授权码」（不是登录密码）；端口 465=SSL，587=STARTTLS</div>
    </div>` : ''}`;
}

window.trackerSmtpToggle = () => { state._smtpOpen = !state._smtpOpen; loadTracker(); };

async function trackerSaveSmtp(btn) {
  await withBusy(btn, async () => {
    const host = $('#smtp-host')?.value || '', sender = $('#smtp-sender')?.value || '';
    if (!host || !sender.includes('@')) { toast('SMTP 主机与发件邮箱必填'); return; }
    state._smtpHost = host; state._smtpPort = $('#smtp-port')?.value || 465; state._smtpSender = sender;
    await api('/api/tracker/smtp', {method: 'PUT', body: JSON.stringify({
      host, port: parseInt(state._smtpPort, 10) || 465, sender,
      password: $('#smtp-pass')?.value || '', sender_name: 'paper-system'})});
    toast('SMTP 配置已保存');
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
