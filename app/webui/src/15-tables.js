/* ===== 15-tables.js —— 表格工作台：收割 → LLM 整理 → 取舍 → xlsx =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。
   双栏（同追踪页）：左栏按论文导航 + 右侧 KPI 统计带 + 按论文分组的卡片墙。 */

const _TB_ST = {
  none: ['待整理', 'dim'], queued: ['排队中', 'run'], running: ['整理中', 'run'],
  done: ['已整理 ✓', 'ok'], mismatch: ['需复核', 'err'], failed: ['失败', 'err'],
};

function tbStatusBadge(st) {
  const [label, cls] = _TB_ST[st] || [st, 'dim'];
  return `<span class="badge ${cls}">${label}</span>`;
}

/* ---------- 页面骨架 ---------- */
function renderTablesPage() {
  const el = $('#page-tables');
  el.innerHTML = `
  <h2 class="page-h" style="margin:0 0 12px">${icon('stack')} 表格工作台</h2>
  <div class="tk-wrap">
    <div class="tk-rail">
      <div class="tk-rail-head"><b>论文</b>
        <button class="btn small primary" onclick="tbHarvestOpen()" title="从已解析论文收割表格">${icon('plus')}</button></div>
      <input id="tb-rail-q" placeholder="搜索论文…" value="${esc(state._tbRailQ || '')}" style="margin:0 8px 6px" oninput="tbRailFilter(this.value)">
      <div id="tb-rail-list"></div>
      <div class="tk-rail-flex"></div>
      <div class="tk-rail-foot" id="tb-rail-foot"></div>
    </div>
    <div class="tk-main">
      <div class="tk-kpis" id="tb-kpis"></div>
      <div id="tb-toolbar"></div>
      <div id="tb-stream"></div>
    </div>
  </div>`;
  $('#tb-rail-list') && ($('#tb-rail-list').innerHTML = '<div class="muted" style="padding:8px"><span class="spin"></span> 加载中…</div>');
  $('#tb-stream') && ($('#tb-stream').innerHTML = '<div class="muted" style="padding:20px 0"><span class="spin"></span> 加载表格…</div>');
  loadTables();
}
window.renderTablesPage = renderTablesPage;

async function loadTables() {
  const rail = $('#tb-rail-list'), kpis = $('#tb-kpis'), toolbar = $('#tb-toolbar'), stream = $('#tb-stream');
  if (!rail) return;
  const review = state._tbReview || 'active';
  const q = state._tbQ || '';
  const paperF = state._tbPaper || '';
  const page = state._tbPage || 1;
  let d;
  try {
    d = await api(`/api/tables/list?review=${review}&q=${encodeURIComponent(q)}&paper_id=${paperF}` +
                 `&collection_id=${state._tbColl || ''}&batch=${encodeURIComponent(state._tbBatch || '')}&page=${page}&page_size=60`);
  } catch (e) {
    rail.innerHTML = `<div class="empty-note" style="padding:8px">${esc(friendlyError(e))}</div>`;
    return;
  }
  state._tbData = d;
  if (!state._tbColls) {
    try {
      const c = await api('/api/collections');
      state._tbColls = [...(c.collections || []), ...((c.shared_libs || []).map(x => ({...x, name: x.name + '（共享）'})))];
    } catch { state._tbColls = []; }
  }

  /* ---- 左栏：批次 + 论文导航 ---- */
  const qLower = (state._tbRailQ || '').toLowerCase();
  const papers = (d.by_paper || []).filter(p => !qLower || (p.title || '').toLowerCase().includes(qLower));
  const railItem = (label, count, onclick, on, extra = '') => `
    <div class="tk-rail-item ${on ? 'on' : ''}" onclick="${onclick}">
      <span class="tk-rail-name">${esc(label)}</span>${extra}
      ${count != null ? `<span class="tk-rail-badge ${on ? '' : 'dim'}">${count}</span>` : ''}</div>`;
  const batches = (d.by_batch || []).slice(0, 8);
  rail.innerHTML =
    (batches.length ? `<div class="tb-rail-sec">批次</div>` +
      batches.map(bt => `
      <div class="tk-rail-item ${state._tbBatch === bt.batch ? 'on' : ''}" onclick="tbBatchF('${esc(bt.batch).replace(/'/g, '')}')" title="${esc(bt.batch)}">
        <span class="tk-rail-name">${esc(bt.batch)}</span>
        <span class="tb-rail-mini">${bt.done ? `✓${bt.done}` : ''}</span>
        <span class="tk-rail-badge ${state._tbBatch === bt.batch ? '' : 'dim'}">${bt.n}</span></div>`).join('') : '') +
    `<div class="tb-rail-sec">论文</div>` +
    railItem(`全部表格`, d.counts.total, "tbPaperF('')", !paperF) +
    papers.map(p => railItem(
      p.title || '(无标题)', p.n, `tbPaperF('${p.paper_id}')`, paperF === p.paper_id,
      `<span class="tb-rail-mini" title="已整理${p.done}·复核${p.mismatch}·剔除${p.deleted}">${p.done ? `✓${p.done}` : ''}${p.mismatch ? ` <b class="tb-mis">${p.mismatch}</b>` : ''}</span>`
    )).join('') || '<div class="empty-note" style="padding:8px">无匹配论文</div>';
  $('#tb-rail-foot').innerHTML = `<div class="muted">${d.counts.total} 张表 · ${d.by_paper.length} 篇论文</div>`;

  /* ---- KPI 统计带 ---- */
  const c = d.counts;
  const working = (c.queued || 0) + (c.running || 0);
  kpis.innerHTML = [
    {n: d.by_paper.length, t: '来源论文', cls: ''},
    {n: c.total, t: '表格总数', cls: ''},
    {n: working, t: '排队/整理中', cls: working ? 'hot' : ''},
    {n: c.done, t: '已整理', cls: ''},
    {n: c.mismatch, t: '需复核', cls: c.mismatch ? 'mis' : ''},
    {n: c.deleted, t: '已剔除', cls: ''},
  ].map(k => `<div class="tk-kpi ${k.cls}"><div class="n">${k.n}</div><div class="t">${k.t}</div></div>`).join('');

  /* ---- 工具栏：筛选 + 批量 ---- */
  const chips = [['active', '未剔除'], ['pending', '待取舍'], ['kept', '已保留'], ['deleted', '已剔除'], ['all', '全部']]
    .map(([v, l]) => `<button type="button" class="chip-btn ${review === v ? 'on' : ''}" onclick="tbReviewF('${v}')">${l}</button>`).join(' ');
  const selN = (state._tbSel || new Set()).size;
  toolbar.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      ${paperF ? `<span class="tk-subtag">${icon('library')} ${esc((d.by_paper.find(p => p.paper_id === paperF) || {}).title || '…')}
        <b class="muted" style="font-weight:400;cursor:pointer" onclick="tbPaperF('')" title="查看全部">✕</b></span>` : ''}
      ${state._tbBatch ? `<span class="tk-subtag">${icon('stack')} ${esc(state._tbBatch)}
        <b class="muted" style="font-weight:400;cursor:pointer" onclick="tbBatchClear()" title="查看全部">✕</b></span>` : ''}
      ${chips}
      <input id="tb-q" placeholder="搜表题/论文…" value="${esc(q)}" style="width:160px"
             onkeydown="if(event.key==='Enter'){tbSearch(this.value)}">
      <select onchange="tbCollF(this.value)" title="按文献库筛选" style="width:auto;max-width:170px">
        <option value="">全部文献库</option>
        ${(state._tbColls || []).map(c => `<option value="${c.id}" ${state._tbColl === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <span style="margin-left:auto"></span>
      <button class="btn small" onclick="tbUploadOpen()">${icon('upload')} 上传解析</button>
      <button class="btn small" onclick="tbHarvestOpen()">${icon('plus')} 收表</button>
      <button class="btn small primary" onclick="tbTidyBatch(this, false)" title="把当前筛选里的待整理表批量入队（LLM 整理）">${icon('bolt')} 整理待办${working ? '（进行中…）' : ''}</button>
    </div>
    ${selN ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      已选 ${selN} 张
      <button class="btn small primary" onclick="tbTidySel(this)">整理选中</button>
      <button class="btn small" onclick="tbBatchReview(this,'kept')">标记保留</button>
      <button class="btn small danger" onclick="tbBatchReview(this,'deleted')">剔除</button>
      <button class="btn small" onclick="tbExportSel(this)">导出选中</button>
      <button class="btn small" onclick="tbCkClear()">取消选择</button></div>` : ''}
    ${working ? `<div class="empty-note" style="margin-bottom:8px">${icon('clock')} 批量整理进行中（${working} 张在队列/处理）——完成会自动刷新；预算用尽时剩余保持待整理，可再点「整理待办」续跑</div>` : ''}
    ${c.mismatch ? `<div class="empty-note" style="margin-bottom:8px;color:var(--err)">${c.mismatch} 张需人工复核（模型输出与原表不一致）——点卡片「对照」人工修整后保存即转为已整理</div>` : ''}`;

  /* ---- 卡片墙：按论文分组 ---- */
  const groups = [];
  {
    let last = null, bucket = null;
    for (const it of d.items) {
      const key = it.paper_id;
      if (key !== last) { bucket = {title: it.paper_title, pid: it.paper_id, items: []}; groups.push(bucket); last = key; }
      bucket.items.push(it);
    }
  }
  const sel = state._tbSel || new Set();
  stream.innerHTML = groups.map(g => `
    <div class="tk-day"><span>${esc(g.title || '(无标题)')}</span><span class="tk-day-n">${g.items.length} 张</span><i></i></div>
    <div class="tb-wall">${g.items.map(it => tbCardHtml(it, sel, review)).join('')}</div>`).join('')
    + (d.total > page * 60 ? `<div style="text-align:center;padding:10px">
      <button class="btn small" onclick="tbLoadMore()">加载更多（${d.total - page * 60} 张未显示）</button></div>` : '')
    || `<div class="empty-state"><p class="t">还没有表格</p>
       <p>点「收表」从已解析论文批量收割表格（一键全部已解析论文）；或先在文库上传并解析 PDF</p></div>`;
}
window.tbReviewF = v => { state._tbReview = v; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };
window.tbPaperF = id => { state._tbPaper = id; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };
window.tbBatchF = b => { state._tbBatch = state._tbBatch === b ? '' : b; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };
window.tbCollF = id => { state._tbColl = id; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };
window.tbBatchClear = () => { state._tbBatch = ''; state._tbPage = 1; loadTables(); };
window.tbRailFilter = debounce(v => { state._tbRailQ = v; loadTables(); }, 250);
window.tbCkClear = () => { state._tbSel = new Set(); loadTables(); };

/* ---------- 卡片 ---------- */
function tbCardHtml(it, sel, review) {
  const st = _TB_ST[it.ai_status] || ['待整理', 'dim'];
  const img = it.asset_name
    ? `<img src="/api/papers/${it.paper_id}/images/${esc(it.asset_name)}" loading="lazy"
           onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tb-thumb-fallback',textContent:'（截图缺失）'}))">`
    : `<div class="tb-thumb-fallback">（无截图）</div>`;
  const checked = sel.has(it.id) ? 'checked' : '';
  const del = it.review === 'deleted';
  return `
  <div class="card tb-card ${del ? 'tb-del' : ''}" data-tid="${it.id}">
    <div class="tb-thumb" onclick="tbCompare('${it.id}')" title="对照核验与编辑">${img}</div>
    <div class="tb-meta">
      <label style="display:flex;gap:6px;align-items:flex-start">
        <input type="checkbox" class="tb-ck" data-tid="${it.id}" ${checked} onchange="tbCk(this)">
        <span class="tb-cap" title="${esc(it.caption)}">${esc(it.caption || '（无表题）')}</span></label>
      <div class="muted" style="font-size:var(--fs-xs)">第 ${it.page_index + 1} 页 · ${it.n_rows}×${it.n_cols}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:2px">
        ${tbStatusBadge(it.ai_status)}
        ${it.review === 'kept' ? '<span class="badge ok">保留</span>' : ''}
        ${del ? '<span class="badge dim">已剔除</span>' : ''}
        ${it.ai_note ? `<span class="muted" style="font-size:var(--fs-xs)" title="${esc(it.ai_note)}">${esc(it.ai_note.slice(0, 24))}…</span>` : ''}
      </div>
      <div class="tb-actions">
        <button class="btn small primary" onclick="tbCompare('${it.id}')">对照</button>
        <button class="btn small hover-only" onclick="tbTidyOne('${it.id}', this)" title="LLM 整理此表">${icon('bolt', 12)}</button>
        ${del
          ? `<button class="btn small hover-only" onclick="tbReview('${it.id}','pending',this)">恢复</button>
             <button class="btn small danger hover-only" onclick="tbHardDel('${it.id}',this)" title="从工作台彻底删除">${icon('trash', 12)}</button>`
          : `<button class="btn small danger hover-only" onclick="tbReview('${it.id}','deleted',this)">剔除</button>`}
        <button class="btn small hover-only" onclick="tbExport(['${it.id}'], this)" title="下载此表 xlsx">${icon('download', 12)}</button>
        <button class="btn small hover-only" onclick="tbLocate('${it.paper_id}', ${it.page_index})" title="打开原论文并跳到该页">${icon('library', 12)}</button>
      </div>
    </div>
  </div>`;
}

/* ---------- 事件 ---------- */
window.tbCk = async ck => {
  const s = state._tbSel || (state._tbSel = new Set());
  ck.checked ? s.add(ck.dataset.tid) : s.delete(ck.dataset.tid);
  const pg = $('#page-tables');
  const st = pg.scrollTop;            // 首次勾选也渲染批量条；整页重渲保持滚动（与追踪页一致）
  await loadTables();
  pg.scrollTop = st;
};
window.tbLocate = async (pid, page) => {
  switchPage('reader');               // openPaper 不切页——不切回阅读页等于没跳
  await openPaper(pid);
  state.pageNum = page + 1;
  renderPage({noFollow: true});
  toast(`已跳到第 ${page + 1} 页`, 2000);
};

/* ---------- 收表弹层 ---------- */
let _tbHarvPop = null;
window._tbHarvestClose = () => { _tbHarvPop?.close(); _tbHarvPop = null; };
window.tbHarvestOpen = async () => {
  _tbHarvPop?.close();
  const {pop, close} = openPop('tb-harvest-pop');
  _tbHarvPop = {pop, close};
  pop.innerHTML = `<div class="ui-pop-title">${icon('plus')} 从文库收表
    <button class="btn small" style="margin-left:auto" onclick="_tbHarvestClose()">${icon('close')}</button></div>
    <div style="margin-top:10px"><span class="spin"></span> 加载可收割论文…</div>`;
  let d;
  try { d = await api('/api/tables/sources'); }
  catch (e) { pop.querySelector('div:last-child').textContent = friendlyError(e); return; }
  const srcs = d.sources || [];
  window._tbSrcs = srcs;
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('plus')} 从文库收表
    <button class="btn small" style="margin-left:auto" onclick="_tbHarvestClose()">${icon('close')}</button></div>
  <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <input id="tb-src-q" placeholder="搜论文标题…" style="width:150px" oninput="tbSrcRender()">
    <select id="tb-src-lib" style="width:auto;max-width:150px" onchange="tbSrcRender()">
      <option value="">全部文献库</option>
      ${(d.libs || []).map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
    </select>
    <label class="tk-inline"><input type="checkbox" id="tb-src-new" checked onchange="tbSrcRender()"> 只看未收</label>
    <span style="margin-left:auto"></span>
    <button class="btn small" onclick="tbHarvestCkAll(this)">全选可见</button>
    <label class="tk-inline"><input type="checkbox" id="tb-auto" checked> 收完自动整理</label>
  </div>
  <div class="tb-src-list" id="tb-src-list"></div>
  <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
    <button class="btn primary" onclick="tbHarvestGo(this, false)">收割所选</button>
    <button class="btn" onclick="tbHarvestGo(this, true)">收割全部未收</button>
    <span class="muted" id="tb-src-stat" style="margin-left:auto;font-size:var(--fs-xs)"></span>
  </div>`;
  tbSrcRender();
};
window.tbSrcRender = () => {
  const q = ($('#tb-src-q')?.value || '').toLowerCase();
  const lib = $('#tb-src-lib')?.value || '';
  const onlyNew = $('#tb-src-new')?.checked !== false;
  const srcs = (window._tbSrcs || []).filter(s =>
    (!q || (s.title || '').toLowerCase().includes(q))
    && (!lib || (s.libs || []).includes(lib))
    && (!onlyNew || !s.in_bench));
  // 按首库分组（无库 → 未归类）
  const groups = new Map();
  for (const s of srcs) {
    const g = (s.libs && s.libs[0]) || '未归类';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const box = $('#tb-src-list');
  if (!box) return;
  box.innerHTML = [...groups.entries()].map(([g, items]) => `
    <div class="tb-rail-sec">${esc(g)} <span class="muted">${items.length} 篇</span></div>
    ${items.map(s => `
    <label class="tb-src-item"><input type="checkbox" class="tb-src-ck" value="${s.paper_id}" ${s.in_bench ? 'disabled' : ''}>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.title)}">${esc(s.title)}</span>
      ${s.in_bench ? `<span class="badge dim">已收 ${s.in_bench}</span>` : ''}
      <span class="muted">${s.n_tables} 张</span></label>`).join('')}`).join('')
    || '<div class="empty-note" style="padding:12px">没有匹配的论文（试试切换库或取消「只看未收」）</div>';
  const visible = srcs.filter(s => !s.in_bench);
  $('#tb-src-stat').textContent = `可见 ${srcs.length} 篇（可收 ${visible.length}）`;
};
window.tbHarvestCkAll = btn => {
  const cks = [...document.querySelectorAll('.tb-src-ck:not(:disabled)')];
  const on = cks.some(c => !c.checked);
  cks.forEach(c => c.checked = on);
};  // 只影响当前筛选可见项（隐藏的已不在 DOM）
window.tbHarvestGo = async (btn, all) => {
  await withBusy(btn, async () => {
    const ids = all ? [] : [...document.querySelectorAll('.tb-src-ck:checked')].map(c => c.value);
    if (!all && !ids.length) { toast('先勾选论文（或点「收割全部未收」）'); return; }
    const r = await api('/api/tables/harvest', {method: 'POST',
      body: JSON.stringify(all ? {all: true, auto_tidy: $('#tb-auto')?.checked} : {paper_ids: ids, auto_tidy: $('#tb-auto')?.checked})});
    toast(`收表完成：${r.papers} 篇 ${r.found} 张，新入库 ${r.inserted} 张（跳过 ${r.skipped}）${r.job_id ? '，整理已排队' : ''}`, 6000);
    window._tbHarvestClose?.();
    state._tbReview = 'active';
    loadTables();
  }, '收表失败');
};

/* ---------- 批量整理 / 取舍 / 导出 ---------- */
async function tbTidyBatch(btn, force) {
  await withBusy(btn, async () => {
    const f = {review: state._tbReview || 'active', q: state._tbQ || '', paper_id: state._tbPaper || ''};
    const r = await api('/api/tables/tidy-batch', {method: 'POST', body: JSON.stringify({filtered: f, force})});
    toast(`已入队 ${r.count} 张——整理进度见顶部统计，完成自动刷新`, 5000);
    loadTables();
  }, '入队失败');
}
window.tbTidyBatch = tbTidyBatch;
window.tbTidySel = async btn => {
  const ids = [...(state._tbSel || new Set())];
  if (!ids.length) return;
  await withBusy(btn, async () => {
    const r = await api('/api/tables/tidy-batch', {method: 'POST', body: JSON.stringify({ids})});
    toast(`已入队 ${r.count} 张`);
    state._tbSel = new Set();
    loadTables();
  }, '入队失败');
};
window.tbTidyOne = async (tid, btn) => {
  await withBusy(btn, async () => {
    await api('/api/tables/tidy-batch', {method: 'POST', body: JSON.stringify({ids: [tid], force: true})});
    toast('已入队整理');
    loadTables();
  }, '入队失败');
};
window.tbReview = async (tid, rv, btn) => {
  await withBusy(btn, async () => {
    await api(`/api/tables/${tid}/review`, {method: 'POST', body: JSON.stringify({review: rv})});
  }, '操作失败');
};
window.tbBatchReview = async (btn, rv) => {
  const ids = [...(state._tbSel || new Set())];
  if (!ids.length) return;
  const verb = rv === 'deleted' ? '剔除' : '标记保留';
  if (!(await uiConfirm(`${verb}选中的 ${ids.length} 张表格？`, {title: verb, danger: rv === 'deleted'}))) return;
  await withBusy(btn, async () => {
    await api('/api/tables/batch-review', {method: 'POST', body: JSON.stringify({ids, review: rv})});
    state._tbSel = new Set();
    if (rv === 'deleted') {
      // 破坏性批量操作给撤销路（Eleken/PatternFly 惯例：确认+已删 N 条—撤销）
      toast(`已剔除 ${ids.length} 张`, 0, {label: '撤销', onClick: async () => {
        try {
          await api('/api/tables/batch-review', {method: 'POST', body: JSON.stringify({ids, review: 'pending'})});
          toast('已恢复');
        } catch (e) { toast(friendlyError(e, '恢复失败')); }
        loadTables();
      }});
    } else {
      toast(`已${verb} ${ids.length} 张`);
    }
    loadTables();
  }, '操作失败');
};
window.tbHardDel = async (tid, btn) => {
  if (!(await uiConfirm('彻底删除这张表？（不可恢复；「剔除」可恢复）', {title: '彻底删除', danger: true}))) return;
  await withBusy(btn, async () => {
    await api(`/api/tables/${tid}`, {method: 'DELETE'});
    loadTables();
  }, '删除失败');
};
async function tbExport(ids, btn) {
  const payload = ids ? {ids} : {kept_only: true};
  if (ids && btn) await withBusy(btn, () => downloadBlob('/api/tables/export', payload, 'table.xlsx', '已下载'), '导出失败');
  else if (ids) await downloadBlob('/api/tables/export', payload, 'table.xlsx', '已下载');
  else {
    const d = state._tbData;
    if (!(await uiConfirm(`导出全部未剔除表格（约 ${d.counts.total - d.counts.deleted} 张，每表一个 sheet）？`, {title: '导出 xlsx'}))) return;
    try {
      await downloadBlob('/api/tables/export', payload, 'tables.xlsx', '已导出——可直接用 Excel/WPS 打开');
    } catch (e) { toast(friendlyError(e, '导出失败')); }
  }
}
window.tbExport = tbExport;
window.tbExportSel = btn => tbExport([...(state._tbSel || new Set())], btn);   // 内联 onclick 取不到模块 state
window.tbLoadMore = () => { state._tbPage = (state._tbPage || 1) + 1; loadTables(); };
window.tbSearch = v => { state._tbQ = v; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };

/* ---------- 全屏对照审阅工作台（连续翻页核验：←→ 翻表 / X 剔除并下一张） ---------- */
let _tbCompareTab = 'ai';
let _tbCmpPop = null;
const _tbCmp = {idx: 0, dirty: false, layout: 'both', tid: null, items: []};

window.tbCompareClose = () => {
  if (_tbCmp.dirty) tbCmpAutoSave();          // 离开自动保存——编辑永不丢
  _tbCmp.keyHandler && document.removeEventListener('keydown', _tbCmp.keyHandler);
  _tbCmp.keyHandler = null;
  _tbCmpPop?.close();
  _tbCmpPop = null;
  loadTables();                               // 审阅后的状态/统计刷新
};

function _tbItems() { return state._tbData?.items || []; }

window.tbCompare = async tid => {
  _tbCmpPop?.close();
  const {pop, close} = openPop('tb-compare-pop');
  _tbCmpPop = {pop, close};
  _tbCmp.items = _tbItems();
  _tbCmp.idx = Math.max(0, _tbCmp.items.findIndex(x => x.id === tid));
  _tbCmp.dirty = false;
  // 全局快捷键（编辑单元格时不劫持方向键）
  if (!_tbCmp.keyHandler) {
    _tbCmp.keyHandler = e => {
      if (!_tbCmpPop?.pop?.isConnected) {       // Esc 已拆层——自清
        document.removeEventListener('keydown', _tbCmp.keyHandler);
        _tbCmp.keyHandler = null;
        return;
      }
      if (e.target?.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); tbCmpNav(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); tbCmpNav(-1); }
      else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); tbCmpReview('deleted'); }
      else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); tbCmpReview('pending'); }
    };
    document.addEventListener('keydown', _tbCmp.keyHandler);
  }
  pop.innerHTML = `<div style="padding:40px;text-align:center"><span class="spin"></span> 加载…</div>`;
  await tbCmpRender();
};

async function tbCmpRender() {
  const it = _tbCmp.items[_tbCmp.idx];
  if (!it) { window.tbCompareClose(); return; }
  const pop = _tbCmpPop?.pop;
  if (!pop) return;
  let d;
  try { d = await api(`/api/tables/${it.id}`); }
  catch (e) { pop.innerHTML = `<div style="padding:40px">${esc(friendlyError(e))}</div>`; return; }
  if (_tbCmp.tid !== d.id) { _tbCompareTab = d.ai_cells ? 'ai' : 'orig'; }   // 换表重置页签
  _tbCmp.tid = d.id;
  _tbCmp.dirty = false;
  const gridOf = tab => {
    if (tab === 'ai' && d.ai_cells) { try { return JSON.parse(d.ai_cells); } catch { /* 落回原始 */ } }
    return JSON.parse(d.cells || '[]');
  };
  window._tbGrid = gridOf(_tbCompareTab);
  const st = _TB_ST[it.ai_status] || ['', 'dim'];
  pop.innerHTML = `
  <div class="tbws">
    <div class="tbws-head">
      <div style="flex:1;min-width:0">
        <b style="font-size:var(--fs-md)">${esc((d.caption || '（无表题）').slice(0, 90))}</b>
        <div class="muted" style="font-size:var(--fs-xs)">${esc(d.paper_title)} · 第 ${d.page_index + 1} 页 · ${window._tbGrid.length}×${window._tbGrid[0]?.length || 0}
          ${tbStatusBadge(it.ai_status)}${it.review === 'kept' ? '<span class="badge ok">保留</span>' : ''}${it.review === 'deleted' ? '<span class="badge dim">已剔除</span>' : ''}</div>
      </div>
      <span class="tbws-count">${_tbCmp.idx + 1} / ${_tbCmp.items.length}</span>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'both' ? 'on' : ''}" onclick="tbCmpLayout('both')">并排</button>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'img' ? 'on' : ''}" onclick="tbCmpLayout('img')">仅截图</button>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'grid' ? 'on' : ''}" onclick="tbCmpLayout('grid')">仅表格</button>
      <button class="btn small" onclick="tbCompareClose()" title="关闭（Esc）">${icon('close')}</button>
    </div>
    ${d.ai_status === 'mismatch' ? `<div class="tb-mis-bar">${icon('warn')} ${esc(d.ai_note || '模型输出与原表不一致')}——人工修整后保存即转为已整理</div>` : ''}
    <div class="tbws-body tbws-${_tbCmp.layout}">
      <div class="tbws-img">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">原始截图（点击放大）</div>
        ${d.img_url ? `<img src="${d.img_url}" onclick="tbCmpZoom('${d.img_url}')" title="点击放大">
          <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">MinerU 裁剪 · ${esc(d.asset_name || '')}</div>`
          : '<div class="tb-thumb-fallback" style="padding:40px 0">无截图（以原始提取网格为准）</div>'}
      </div>
      <div class="tbws-grid">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
          <button type="button" class="chip-btn ${_tbCompareTab === 'ai' ? 'on' : ''}" onclick="tbCmpTab('ai')">AI 整理${d.ai_cells ? '' : '（未整理）'}</button>
          <button type="button" class="chip-btn ${_tbCompareTab === 'orig' ? 'on' : ''}" onclick="tbCmpTab('orig')">原始提取</button>
          <span style="flex:1"></span>
          <button class="btn small" onclick="tbGridAddRow()">+行</button>
          <button class="btn small" onclick="tbGridAddCol()">+列</button>
          <button class="btn small primary" onclick="tbGridSave('${d.id}', this)">${icon('check')} 保存</button>
        </div>
        <div class="tb-grid-wrap"><table class="tbl-md tb-edit-grid" id="tb-edit-grid" contenteditable="true"></table></div>
        <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">点击单元格直接改；行首/表头 ✕ 删行删列；翻页/关闭自动保存修改</div>
      </div>
    </div>
    <div class="tbws-foot">
      <button class="btn small" onclick="tbCmpNav(-1)" ${_tbCmp.idx === 0 ? 'disabled' : ''}>‹ 上一张</button>
      <button class="btn small ${it.review === 'kept' ? 'primary' : ''}" onclick="tbCmpReview('kept')" title="快捷键 J">保留</button>
      <button class="btn small danger" onclick="tbCmpReview('deleted')" title="快捷键 X">剔除并下一张</button>
      <button class="btn small" onclick="tbTidyOne('${d.id}', this)">${icon('bolt')} 重整理</button>
      <button class="btn small" onclick="tbExport(['${d.id}'], this)">${icon('download')} 下载</button>
      <button class="btn small" onclick="tbLocate('${d.paper_id}', ${d.page_index})">${icon('library')} 原文</button>
      <span style="flex:1"></span>
      <span class="muted tbws-hint">← → 翻表 · X 剔除 · J 保留 · 编辑自动保存</span>
      <button class="btn small primary" onclick="tbCmpNav(1)" ${_tbCmp.idx >= _tbCmp.items.length - 1 ? 'disabled' : ''}>下一张 ›</button>
    </div>
  </div>`;
  tbRenderGrid(window._tbGrid);
  // 网格任何编辑 → dirty（翻页/关闭时自动保存）
  const grid = $('#tb-edit-grid');
  grid?.addEventListener('input', () => { _tbCmp.dirty = true; });
  // 键盘惯例（Excel/Airtable）：Enter=提交并下移 / Shift+Enter=上移 / Esc=还原进入编辑前的值
  grid?.addEventListener('keydown', e => {
    const td = e.target.closest?.('[contenteditable="true"][data-r]');
    if (!td) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      td.textContent = _tbCellBefore(td) ?? td.textContent;   // 还原进入编辑时快照
      td.blur(); _tbCmp.dirty = true;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      focusCell(+td.dataset.r + 1, +td.dataset.c);           // 提交（contenteditable 已实时）并下移
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      focusCell(+td.dataset.r - 1, +td.dataset.c);
    }
  });
  grid?.addEventListener('focusin', e => {                   // 进入编辑快照（Esc 还原用）
    const td = e.target.closest?.('[contenteditable="true"][data-r]');
    if (td) td._before = td.textContent;
  });
  function _tbCellBefore(td) { return td._before; }
  function focusCell(r, c) {
    const next = grid.querySelector(`[contenteditable="true"][data-r="${Math.max(0, r)}"][data-c="${Math.max(0, c)}"]`);
    if (next) next.focus();
  }
}
window.tbCmpLayout = mode => { _tbCmp.layout = mode; tbCmpRender(); };
window.tbCmpTab = tab => { if (_tbCmp.dirty) tbCmpAutoSave(); _tbCompareTab = tab; tbCmpRender(); };
window.tbCmpZoom = url => {
  const {pop, close} = openPop('tb-zoom-pop');
  pop.innerHTML = `<img src="${url}" style="max-width:92vw;max-height:86vh;display:block;cursor:zoom-out"
    onclick="this.closest('.ui-backdrop').remove()">`;
};
async function tbCmpAutoSave() {
  if (!_tbCmp.dirty || !_tbCmp.tid) return;
  _tbCmp.dirty = false;
  const grid = _tbCollectGrid();
  try {
    await api(`/api/tables/${_tbCmp.tid}`, {method: 'PATCH', body: JSON.stringify({cells: grid})});
    toast('修改已自动保存', 2000);
  } catch (e) { toast(friendlyError(e, '自动保存失败——修改未保存')); _tbCmp.dirty = true; }
}
window.tbCmpNav = async dir => {
  const next = _tbCmp.idx + dir;
  if (next < 0 || next >= _tbCmp.items.length) { toast(dir > 0 ? '已是最后一张' : '已是第一张'); return; }
  await tbCmpAutoSave();
  _tbCmp.idx = next;
  await tbCmpRender();
};
window.tbCmpReview = async rv => {
  const it = _tbCmp.items[_tbCmp.idx];
  if (!it) return;
  await tbCmpAutoSave();
  try {
    await api(`/api/tables/${it.id}/review`, {method: 'POST', body: JSON.stringify({review: rv})});
    it.review = rv;                            // 本地同步（KPI 在关闭时刷新）
    toast(rv === 'deleted' ? '已剔除' : '已标记保留', 1800);
    if (rv === 'deleted' && _tbCmp.idx < _tbCmp.items.length - 1) await tbCmpNav(1);
    else await tbCmpRender();
  } catch (e) { toast(friendlyError(e, '操作失败')); }
};

function tbRenderGrid(grid) {
  const t = $('#tb-edit-grid');
  if (!t) return;
  t.innerHTML = grid.map((row, r) => `
    <tr>${r === 0 ? `<th class="tb-rowop" contenteditable="false" title="删除此行" onclick="tbGridDelRow(${r})">✕</th>` : `<td class="tb-rowop" contenteditable="false" title="删除此行" onclick="tbGridDelRow(${r})">✕</td>`}
    ${row.map((v, c) => r === 0
      ? `<th class="tb-cel"><span contenteditable="true" data-r="${r}" data-c="${c}">${esc(v ?? '')}</span><b class="tb-col-x" title="删除此列" onclick="event.stopPropagation();tbGridDelCol(${c})">✕</b></th>`
      : `<td contenteditable="true" data-r="${r}" data-c="${c}">${esc(v ?? '')}</td>`).join('')}</tr>`).join('');
}
function _tbCollectGrid() {
  // 从 DOM 读回（contenteditable 的实时文本；✕ 在 span 外不会混入）
  const grid = window._tbGrid.map(r => [...r]);
  document.querySelectorAll('#tb-edit-grid [contenteditable][data-r]').forEach(td => {
    grid[+td.dataset.r][+td.dataset.c] = (td.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  });
  return grid;
}
window.tbGridDelRow = r => {
  window._tbGrid = _tbCollectGrid();
  if (window._tbGrid.length <= 1) { toast('至少保留一行'); return; }
  window._tbGrid.splice(r, 1);
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridDelCol = c => {
  window._tbGrid = _tbCollectGrid();
  if ((window._tbGrid[0] || []).length <= 1) { toast('至少保留一列'); return; }
  window._tbGrid.forEach(row => row.splice(c, 1));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridAddRow = () => {
  window._tbGrid = _tbCollectGrid();
  const w = (window._tbGrid[0] || []).length;
  window._tbGrid.push(Array(w).fill(null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridAddCol = () => {
  window._tbGrid = _tbCollectGrid();
  window._tbGrid.forEach(row => row.push(null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridSave = async (tid, btn) => {
  const grid = _tbCollectGrid();
  _tbCmp.dirty = false;
  await withBusy(btn, async () => {
    const r = await api(`/api/tables/${tid}`, {method: 'PATCH', body: JSON.stringify({cells: grid})});
    toast(`已保存（${r.rows} 行 × ${r.cols} 列）——导出 xlsx 用这份整理版`);
  }, '保存失败');
};

/* ---------- 上传解析 → 自动收表 → 自动整理（一条链） ---------- */
let _tbUpPop = null;
window._tbUpClose = () => { _tbUpPop?.close(); _tbUpPop = null; };
window.tbUploadOpen = async () => {
  _tbUpPop?.close();
  const {pop, close} = openPop('tb-upload-pop');
  _tbUpPop = {pop, close};
  // 目标库选项（与追踪页「收进目标库」同源：默认 + 本人各库 + 共享库）
  let collOpts = '<option value="">默认文献库</option>';
  try {
    const d = await api('/api/collections');
    const opts = [...(d.collections || []), ...((d.shared_libs || []).map(x => ({...x, name: x.name + '（共享）'})))];
    collOpts = `<option value="">默认文献库</option>` + opts.map(o =>
      `<option value="${o.id}" ${o.id === (state._tbUpColl || '') ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  } catch { /* 下拉退化默认 */ }
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('upload')} 上传 PDF → 解析 → 自动收表
    <button class="btn small" style="margin-left:auto" onclick="_tbUpClose()">${icon('close')}</button></div>
  <div style="margin-top:10px" class="tb-up-body">
    <div class="tk-grid2">
      <label class="tk-fld">放入文献库
        <select id="tb-up-coll" onchange="state._tbUpColl=this.value">${collOpts}</select></label>
      <label class="tk-fld">选择文件（可多选 PDF/图片/Office）
        <input id="tb-up-files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.xls,.xlsx"></label>
    </div>
    <label class="tk-inline" style="margin-top:8px">
      <input type="checkbox" id="tb-up-tidy" checked> 解析完成后自动收表并 AI 整理（走月预算闸）</label>
    <div id="tb-up-status" style="margin-top:10px;font-size:var(--fs-sm)"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" onclick="tbUploadGo(this)">上传并跟踪</button>
    </div>
    <div class="muted" style="font-size:var(--fs-xs);margin-top:8px">
      上传 → MinerU 解析（1-3 分钟/篇，页数多更久）→ 自动收割此批论文的表格 → 勾选整理则批量过 LLM。
      也可以随时关掉此窗口——解析完不会自动收表，稍后用「收表」手动圈这批论文即可。</div>
  </div>`;
};

window.tbUploadGo = async btn => {
  const files = [...($('#tb-up-files')?.files || [])];
  const st = $('#tb-up-status');
  if (!files.length) { toast('先选择文件'); return; }
  await withBusy(btn, async () => {
    const ids = [];
    for (const f of files) {
      st.innerHTML = `上传中：${esc(f.name)}（${ids.length + 1}/${files.length}）…`;
      try {
        const fd = new FormData();
        fd.append('files', f);
        const cid = $('#tb-up-coll')?.value || '';
        const r = await fetch(`/api/papers/upload?visibility=shared${cid ? `&collection_id=${cid}` : ''}`,
                              {method: 'POST', body: fd});
        const d = await r.json();
        const res = (d.results || [])[0] || {};
        if (res.paper_id && res.status !== 'rejected') ids.push(res.paper_id);
        else st.insertAdjacentHTML('beforeend', `<div style="color:var(--err)">${esc(f.name)}：${esc(res.reason || res.status || '上传失败')}</div>`);
      } catch (e) {
        st.insertAdjacentHTML('beforeend', `<div style="color:var(--err)">${esc(f.name)}：上传失败 ${esc(e.message)}</div>`);
      }
    }
    if (!ids.length) { st.insertAdjacentHTML('beforeend', '<div style="color:var(--err)">没有成功上传的文件</div>'); return; }
    await tbTrackParse(ids, $('#tb-up-tidy')?.checked);
  }, '上传失败');
};

async function tbTrackParse(ids, autoTidy) {
  const st = $('#tb-up-status');
  const names = {};
  for (;;) {
    try {
      const d = await api(`/api/statuses?paper_ids=${ids.join(',')}`);
      const ss = d.statuses || {};
      const rows = ids.map(pid => {
        const x = ss[pid] || {};
        const ps = x.parse_status || 'pending';
        return {pid, ps, label: {pending: '排队中', parsing: '解析中', parsed: '✓ 完成', failed: '✗ 失败', skipped: '跳过'}[ps] || ps};
      });
      const done = rows.filter(r => ['parsed', 'failed', 'skipped'].includes(r.ps));
      st.innerHTML = `等待解析（${done.length}/${ids.length}）——完成后自动收表${autoTidy ? '并整理' : ''}<div class="tb-up-list">${
        rows.map(r => `<div class="${r.ps === 'parsed' ? 'ok' : r.ps === 'failed' ? 'err' : 'muted'}">${r.label} · ${esc(names[r.pid] || r.pid.slice(0, 10))}</div>`).join('')}</div>`;
      if (done.length === ids.length) break;
    } catch { /* 网络抖动下轮再试 */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  // 全部到达终态 → 收表（失败/跳过的自然被 harvest 的 parsed 过滤排除）
  const okIds = ids;   // harvest 只收 parsed
  try {
    const h = await api('/api/tables/harvest', {method: 'POST', body: JSON.stringify({paper_ids: okIds, auto_tidy: !!autoTidy, from_upload: true})});
    st.insertAdjacentHTML('beforeend',
      `<div style="margin-top:6px;color:var(--primary)">收表完成：${h.found} 张（新收 ${h.inserted}）${h.job_id ? '，整理已排队' : ''}</div>`);
    const collName = $('#tb-up-coll')?.selectedOptions?.[0]?.text || '默认文献库';
    toast(`新一批「${h.batch || '批次'}」就绪：论文已入「${collName}」，收进 ${h.inserted} 张表${autoTidy ? '，AI 整理进行中' : ''}`, 6000);
    state._tbBatch = h.batch || '';      // 视图切到该批次——所见即所收
    setTimeout(() => { window._tbUpClose?.(); loadTables(); }, 1200);
  } catch (e) {
    st.insertAdjacentHTML('beforeend', `<div style="color:var(--err)">收表失败：${esc(friendlyError(e))}——稍后用「收表」手动圈这批论文</div>`);
  }
}
