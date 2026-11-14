/* ===== 14-tracker.js —— 文献追踪：订阅巡逻 → 收件箱审阅 → 收进文献库 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。
   布局：Feedly 式双栏——左栏订阅导航（每源未读角标），右栏 KPI 统计带 + 按天分组内容流。 */

const ARXIV_CAT_PRESETS = ['cs.CV', 'eess.IV', 'cs.GR', 'cs.LG', 'cs.AI', 'cs.CL', 'physics.optics', 'math.AP'];
const _TIER_LABEL = {core: '核心', proxy: '相关', eco: '生态'};

/* 已收进条目的实时阶段条：收进 → 入库 → 解析 → 可阅读（SSE 推进自动更新） */
window.trackerOpenPaper = async pid => {   // openPaper 不切页——同表格页 tbLocate 的已知坑
  switchPage('reader');
  await openPaper(pid);
};
function trackerStageStrip(it) {
  const coll = collNameOf(it.accepted_to);
  const ps = it.parse_status, pj = (it.parse_job || '').split(':')[0], prog = (it.parse_job || '').split(':')[1] || '';
  const stages = `<span class="badge ok" title="收进：${esc(coll)}">已收进 · ${esc(coll)}</span>`;
  const openBtn = `<button class="btn small" onclick="trackerOpenPaper('${it.paper_id}')" title="打开这篇论文">打开</button>`;
  const retryBtn = `<button class="btn small" onclick="trackerRetryParse('${it.paper_id}', this)">重试解析</button>`;
  if (ps === 'parsed')
    return `${stages}<span class="badge ok">已解析 ✓</span>${openBtn}`;
  if (ps === 'failed')
    return `${stages}<span class="badge err">解析失败</span>${retryBtn}`;
  if (ps === 'parsing' || pj === 'running') {
    const [done, total] = prog.split('/');
    return `${stages}<span class="badge run">解析中 ${done && total ? `${done}/${total}` : ''}</span>${openBtn}`;
  }
  if (pj === 'queued' || ps === 'pending' || !pj)
    return `${stages}<span class="badge run">解析排队中</span>`;
  return `${stages}<span class="badge run">入库中…</span>`;
}
window.trackerRetryParse = async (pid, btn) => {
  await withBusy(btn, async () => {
    await api(`/api/papers/${pid}/parse`, {method: 'POST'});
    toast('解析已重新排队');
  }, '重试失败');
};

function trackerTierBadge(tier) {
  // 分类用中性 cat 色——此前借 run 进度色，与"进行中"语义冲突
  const [label, cls] = {core: ['核心', 'cat hi'], proxy: ['相关', 'cat'], eco: ['dim']}[tier] || [tier, 'dim'];
  const label2 = {core: '核心', proxy: '相关', eco: '生态'}[tier] || tier;
  return `<span class="badge ${cls}" title="${label2}层">${label2}</span>`;
}

function trackerCondText(s) {
  const kw = (s.keywords || '').split(',').map(x => x.trim()).filter(Boolean);
  const cats = (s.categories || '').split(/\s+/).filter(Boolean);
  const jns = (s.journals || '').split(',').map(x => x.trim()).filter(Boolean);
  const exc = (s.exclude || '').split(',').map(x => x.trim()).filter(Boolean);
  const parts = [];
  if (kw.length) parts.push('关键词: ' + kw.join('、'));
  if (cats.length) parts.push('分类: ' + cats.join(' '));
  if (jns.length) parts.push('期刊: ' + jns.join('、'));
  if (exc.length) parts.push('排除: ' + exc.join('、'));
  return parts.join(' · ') || '未配置条件';
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
  <h2 class="page-h" style="margin:0 0 12px">${icon('bolt')} 文献追踪</h2>
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
    const collP = api('/api/collections').then(d => {
      const opts = [{id: '', name: '默认文献库'},
        ...(d.collections || []), ...(d.shared_libs || []).map(x => ({...x, name: x.name + '（共享）'}))];
      state._trackerCollOpts = opts.map(o => `<option value="${o.id}" ${o.id === (state._trackerCollId || '') ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    }).catch(() => {});
    [subs, inbox] = await Promise.all([
      api('/api/tracker/subs'),
      api(`/api/tracker/items?status=${st}&tier=${tier}&sub_id=${subF}&page=${page}&page_size=30`),
      collP,
    ]).then(([a, b]) => [a, b]);
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
    subs.subs.map(s => {
      const on = st === 'new' && subF === s.id;
      return `<div class="tk-rail-item ${on ? 'on' : ''}" onclick="trackerSubF('${s.id}')">
        <span class="tk-rail-name" title="${esc(trackerCondText(s))}">${esc(s.name)}</span>
        ${s.new_count ? `<span class="tk-rail-badge">${s.new_count > 99 ? '99+' : s.new_count}</span>` : ''}
        <span class="tk-rail-edit" title="编辑订阅" onclick="event.stopPropagation(); trackerEdit('${s.id}')">${icon('edit', 12)}</span></div>`;
    }).join('') +
    `<div class="tk-rail-sep"></div>` +
    railItem('已收进', counts.accepted, "trackerStatus('accepted')", st === 'accepted', {dim: 1}) +
    railItem('已忽略', counts.dismissed, "trackerStatus('dismissed')", st === 'dismissed', {dim: 1});
  foot.innerHTML = `<div style="display:flex;align-items:center;gap:6px">邮件发送
      <span class="badge ${subs.smtp_ready ? 'ok' : 'dim'}">${subs.smtp_ready ? '已配置' : '未配置'}</span>
      ${me.role === 'admin'
        ? `<a href="#" style="margin-left:auto;color:var(--primary)" onclick="switchPage('admin');return false">前往设置</a>`
        : '<span class="muted" style="margin-left:auto">联系管理员</span>'}</div>`;

  /* ---- 右栏：KPI 统计带 ---- */
  kpis.innerHTML = [
    {n: counts.today, t: '24 小时新到', cls: 'hot'},
    {n: counts.inbox, t: '待处理', cls: ''},
    {n: counts.core, t: '核心命中', cls: ''},
    {n: counts.accepted, t: '已收进文献库', cls: ''},
  ].map(k => `<div class="tk-kpi ${k.cls}"><div class="n">${k.n}</div><div class="t">${k.t}</div></div>`).join('');

  /* ---- 右栏：工具行 ---- */
  const tierChips = [['', '全部层级'], ...Object.entries(_TIER_LABEL)]
    .map(([v, label]) => `<button type="button" class="chip-btn ${tier === v ? 'on' : ''}" onclick="trackerTierF('${v}')">${label}</button>`).join(' ');
  toolbar.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${curSub ? `<span class="tk-subtag">${icon('bulb')} ${esc(curSub.name)}
        <b class="muted" style="font-weight:400;cursor:pointer" onclick="trackerSubF('')" title="查看全部订阅">✕</b></span>
        <button class="btn small" onclick="trackerRun('${curSub.id}')">${icon('bolt')} 巡逻</button>` : ''}
      ${tierChips}
      <span style="margin-left:auto"></span>
      <label class="tk-inline">收进目标库
        <select id="tk-target-coll" style="width:auto;max-width:200px" onchange="trackerCollChange(this)">${state._trackerCollOpts || '<option value="">默认文献库</option>'}</select></label>
      <span class="muted">共 ${inbox.total} 条</span>
    </div>
    ${st === 'new' && selMapSize() ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-top:8px">
      已选 ${selMapSize()} 篇
      <button class="btn small primary" onclick="trackerBatchAccept(this)">批量收进文献库</button>
      <button class="btn small" onclick="trackerCkClear()">取消选择</button></div>` : ''}`;

  /* ---- 右栏：按天分组的条目流 ---- */
  const selMap = state._trackerSel || new Set();
  if (state._trackerAppend) {
    const prev = state._trackerShownItems || [];
    const seen = new Set(prev.map(x => x.id));
    inbox.items = [...prev, ...inbox.items.filter(x => !seen.has(x.id))];   // 追加而非替换
  }
  state._trackerShownItems = inbox.items;
  state._trackerAppend = false;
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
      <button class="btn small" onclick="trackerLoadMore()">加载更多（${inbox.total - (state._trackerPage || 1) * 30} 条未显示）</button></div>` : ''}`;
}
function selMapSize() { return (state._trackerSel || new Set()).size; }
function collNameOf(cid) {
  if (!cid) return '默认文献库';
  const opt = [...document.querySelectorAll('#tk-target-coll option')].find(o => o.value === cid);
  return opt?.text || '文献库';
}
window.trackerStatus = v => { state._trackerStatus = v; state._trackerSub = ''; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); state._trackerShownItems = null; loadTracker(); };
window.trackerSubF = id => { state._trackerSub = id; state._trackerStatus = 'new'; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); state._trackerShownItems = null; loadTracker(); };
window.trackerTierF = v => { state._trackerTier = v === state._trackerTier ? '' : v; state._trackerPage = 1; state._trackerSel = new Set(); loadTracker(); };
window.trackerLoadMore = () => { state._trackerPage = (state._trackerPage || 1) + 1; state._trackerAppend = true; loadTracker(); };
window.trackerCkClear = () => { state._trackerSel = new Set(); loadTracker(); };
window.trackerCollChange = el => { state._trackerCollId = el.value; };

/* ---------- 收件箱行 ---------- */
function trackerRankBadge(it) {
  if (!it.rank) return '';
  try {
    const r = JSON.parse(it.rank);
    const bits = [];
    if (r.cas) bits.push(`中科院${r.cas}`);
    if (r.jcr) bits.push(`JCR ${r.jcr}`);
    if (r.impact_factor) bits.push(`IF ${r.impact_factor}`);
    return bits.length ? `<span class="badge ok" title="期刊分区（easyScholar）">${esc(bits.join(' · '))}</span>` : '';
  } catch { return ''; }
}

function trackerItemHtml(it, selMap, st) {
  const checked = selMap.has(it.id) ? 'checked' : '';
  const zh = it.zh_title ? `<div style="color:var(--text);margin-top:2px">${esc(it.zh_title)}</div>` : '';
  const code = it.code_url ? ` · <a href="${esc(it.code_url)}" target="_blank" rel="noopener" style="color:var(--primary)">代码 ↗</a>` : '';
  const pdf = it.pdf_url ? ` · <a href="${esc(it.pdf_url)}" target="_blank" rel="noopener" style="color:var(--text-2)">PDF ↗</a>` : '';
  const cite = it.cited_by != null && it.cited_by > 0 ? ` · 被引 ${it.cited_by}` : '';
  const isNew = it.status === 'new' && st !== 'accepted' && st !== 'dismissed';
  const ck = isNew && st === 'new'
    ? `<input type="checkbox" class="tk-ck" data-iid="${it.id}" ${checked} onchange="trackerCk(this)" style="margin-top:3px">`
    : '<span style="width:13px;flex:none"></span>';
  const actions = isNew
    ? `<button class="btn small primary" onclick="trackerAccept('${it.id}', this)">收进文献库</button>
       ${!it.zh_summary ? `<button class="btn small" onclick="trackerEnrich('${it.id}', this)" title="LLM 生成中文总结与标题翻译">AI 摘要</button>` : ''}
       <button class="btn small danger hover-only" onclick="trackerDismiss('${it.id}', this)">忽略</button>`
    : it.status === 'accepted' ? trackerStageStrip(it)
      : '<span class="badge dim">已忽略</span>';
  // 总结优先，无总结显示原摘要；超过 3 行折叠，点击展开/收起
  const bodyText = it.zh_summary || it.abstract || '';
  const isZh = !!it.zh_summary;
  let body = '';
  if (bodyText) {
    const label = isZh ? 'AI 总结' : '摘要';
    body = `<div class="tk-abs" data-iid="${it.id}">
      <span class="tk-abs-tag">${label}</span>
      <span class="tk-abs-text clamp">${esc(bodyText)}</span>
      ${bodyText.length > 110 ? '<b class="tk-abs-toggle" onclick="trackerToggleAbs(this)">展开</b>' : ''}
    </div>`;
  }
  const fresh = it.status === 'new' && st === 'new';
  return `
  <div class="card tracker-item ${fresh ? 'tk-fresh' : ''}" data-iid="${it.id}" style="padding:12px 14px;margin:0 0 10px">
    <div style="display:flex;gap:10px;align-items:flex-start">
      ${ck}
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${trackerTierBadge(it.tier)}${trackerRankBadge(it)}${it.is_fallback ? '<span class="badge dim" title="核心/相关不足时的补足项">补足</span>' : ''}
          ${it.cited_by != null && it.cited_by > 0 ? `<span class="badge dim" title="被引数">被引 ${it.cited_by}</span>` : ''}
          <span class="muted" style="font-size:var(--fs-xs)">${esc(it.published || '')} · ${esc(it.venue || '')}
            · ${esc((it.authors || '').slice(0, 110))}${code}${pdf}</span>
        </div>
        <div class="tk-title ${fresh ? '' : 'tk-read'}" style="margin-top:4px">${esc(it.title)}</div>
        ${zh}${body}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:none">${actions}</div>
    </div>
  </div>`;
}
window.trackerToggleAbs = el => {
  const txt = el.parentElement.querySelector('.tk-abs-text');
  const open = txt.classList.toggle('clamp') === false;
  el.textContent = open ? '收起' : '展开';
};

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
  const cid = state._trackerCollId || '';
  const opt = [...(document.querySelectorAll('#tk-target-coll option') || [])].find(o => o.value === cid);
  const collName = opt?.text || '默认文献库';
  let done = false;
  const timer = setTimeout(() => {
    if (!done) toast(`PDF 还在下载（慢源最多 30 秒）——完成后会出现在「${collName}」，解析自动排队`, 6000);
  }, 8000);
  await withBusy(btn, async () => {
    const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({collection_id: cid})});
    done = true; clearTimeout(timer);
    toast(r.duplicate ? `已在「${collName}」中（已自动挂库）` : `已收进「${collName}」——解析已排队，进度见「任务」页`, 5000);
    loadTracker();
  }, '收进失败');
  done = true; clearTimeout(timer);
}
window.trackerAccept = trackerAccept;

async function trackerBatchAccept(btn) {
  const sel = [...(state._trackerSel || new Set())];
  if (!sel.length) return;
  await withBusy(btn, async () => {
    let ok = 0, dup = 0;
    for (const id of sel) {
      try {
        const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({collection_id: state._trackerCollId || ''})});
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
    `<button type="button" class="chip-btn ${cats.includes(c) ? 'on' : ''}" data-cat="${c}"
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
      <div class="tk-fld">顶刊期刊（搜索选择，可多个；不必知道全称）
        <div id="tk-jr-chips" style="display:flex;gap:5px;flex-wrap:wrap;${s && s.journals ? '' : 'display:none'}">
          ${(s ? s.journals : '').split(',').map(x => x.trim()).filter(Boolean).map(j =>
            `<span class="tk-chip jr" data-j="${esc(j)}">${esc(j)}
               <b style="cursor:pointer;margin-left:2px" onclick="trackerJrRemove(this)">✕</b></span>`).join('')}
        </div>
        <input id="tk-jr-q" placeholder="输入期刊名关键词（如 nature、ieee、report），从下拉选择"
               autocomplete="off" oninput="trackerJrSuggest(this.value)">
        <div id="tk-jr-sug" hidden style="border:1px solid var(--border);border-radius:var(--r-md);
             background:var(--panel);max-height:200px;overflow-y:auto;margin-top:4px"></div>
      </div>
    </div>
    <div class="tk-grid2">
      <label class="tk-fld">巡逻时刻（频率为每天/每周时生效）
        <input id="tk-time" type="time" value="${esc(s?.run_at_time || '08:00')}" title="每天到这个时刻巡逻一次">
      </label>
      <label class="tk-fld">说明
        <div class="muted" style="font-size:var(--fs-xs);line-height:1.6;padding-top:4px">
          每 6/12 小时的订阅按间隔滚动，不受时刻影响；每天/每周的订阅到设定时刻自动巡逻（服务器本地时区）</div>
      </label>
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
    journals: (window.trackerJrSelected?.() || []).join(','),
    frequency_hours: parseInt(g('#tk-freq')?.value || '24', 10),
    run_at_time: g('#tk-time')?.value || '',
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

let _jrSugTimer = null;
window.trackerJrSuggest = q => {
  clearTimeout(_jrSugTimer);
  const box = $('#tk-jr-sug');
  if (!box) return;
  if ((q || '').trim().length < 2) { box.hidden = true; return; }
  _jrSugTimer = setTimeout(async () => {
    try {
      const d = await api(`/api/tracker/journal-suggest?q=${encodeURIComponent(q.trim())}`);
      const have = new Set([...document.querySelectorAll('#tk-jr-chips .tk-chip.jr')].map(x => x.dataset.j.toLowerCase()));
      box.innerHTML = (d.items || []).filter(x => !have.has(x.name.toLowerCase())).map(x => `
        <div class="tk-sug-item" onclick="trackerJrPick('${jsArg(x.name)}')">
          <b>${esc(x.name)}</b> ${x.hint ? `<span class="muted" style="font-size:var(--fs-xs)">${esc(x.hint)}</span>` : ''}
        </div>`).join('') || '<div class="muted" style="padding:6px 10px">无匹配期刊</div>';
      box.hidden = false;
    } catch { box.hidden = true; }
  }, 350);
};
window.trackerJrPick = name => {
  const box = $('#tk-jr-chips');
  const have = new Set([...box.querySelectorAll('.tk-chip.jr')].map(x => x.dataset.j.toLowerCase()));
  if (![...have].includes(name.toLowerCase())) {
    box.insertAdjacentHTML('beforeend',
      `<span class="tk-chip jr" data-j="${esc(name)}">${esc(name)}
         <b style="cursor:pointer;margin-left:2px" onclick="trackerJrRemove(this)">✕</b></span>`);
  }
  box.style.display = 'flex';
  const q = $('#tk-jr-q'); if (q) q.value = '';
  const sug = $('#tk-jr-sug'); if (sug) sug.hidden = true;
};
window.trackerJrRemove = b => {
  b.closest('.tk-chip').remove();
  const box = $('#tk-jr-chips');
  if (box && !box.children.length) box.style.display = 'none';
};
window.trackerJrSelected = () =>
  [...document.querySelectorAll('#tk-jr-chips .tk-chip.jr')].map(x => x.dataset.j);

window.trackerToggleCat = (el, cat) => {
  el.classList.toggle('on');
  const inp = $('#tk-cats');
  if (!inp) return;
  const cats = new Set(inp.value.split(/\s+/).filter(Boolean));
  if (el.classList.contains('on')) cats.add(cat); else cats.delete(cat);
  inp.value = [...cats].join(' ');
};
