/* ===== 15-tables.js —— 表格工作台：批量收集 → LLM 整理 → 取舍 → xlsx =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。
   双栏（同追踪页）：左栏按论文导航 + 右侧 KPI 统计带 + 按论文分组的卡片墙。 */

const _TB_ST = {
  none: ['待整理', 'dim'], queued: ['排队中', 'run'], running: ['整理中', 'run'],
  done: ['已整理 ✓', 'ok'], mismatch: ['需复核', 'err'], failed: ['失败', 'err'],
};

/* 分页大小（设置弹层可调，纯前端记忆；默认 60） */
const _tbPageSize = () => { const v = +(localStorage.getItem('ps-tbl-page') || 60); return [20, 40, 60, 100].includes(v) ? v : 60; };

function tbStatusBadge(st) {
  const [label, cls] = _TB_ST[st] || [st, 'dim'];
  return `<span class="badge ${cls}">${label}</span>`;
}

/* ---------- 页面骨架 ---------- */
function renderTablesPage() {
  const el = $('#page-tables');
  // 侧栏合并（v1.12）：不再自带 rail——直接复用全局文库侧栏（库树/论文/搜索只存在一份），
  // 侧栏点击在本页上下文里分派为筛选（02-library.js 按 state._page 分派）。
  // 表格特有维度全部进主区：批次/审阅状态收进漏斗弹层，批量收集/上传解析在工具条右侧。
  el.innerHTML = `
  <div class="tk-kpis" id="tb-kpis"></div>
  <div id="tb-toolbar"></div>
  <div id="tb-stream"></div>`;
  $('#tb-stream') && ($('#tb-stream').innerHTML = '<div class="muted" style="padding:20px 0"><span class="spin"></span> 加载表格…</div>');
  loadTables();
}
window.renderTablesPage = renderTablesPage;

async function loadTables() {
  const kpis = $('#tb-kpis'), toolbar = $('#tb-toolbar'), stream = $('#tb-stream');
  if (!kpis) return;
  const review = state._tbReview || 'active';
  const q = state._tbQ || '';
  const paperF = state._tbPaper || '';
  const page = state._tbPage || 1;
  let d;
  try {
    d = await api(`/api/tables/list?review=${review}&q=${encodeURIComponent(q)}&paper_id=${paperF}` +
                 `&collection_id=${state._tbColl || ''}&page=${page}&page_size=${_tbPageSize()}` +
                 `&sort=${encodeURIComponent(state.sortBy || 'recent')}` +
                 // 侧栏「解析状态/阅读范围」筛选跟随（filter-pop 改的 state.filter/scope）
                 `&ps=${encodeURIComponent(state.filter || '')}&sc=${encodeURIComponent(state.scope || '')}` +
                 (state._tbSt ? `&st=${encodeURIComponent(state._tbSt)}` : ''));
  } catch (e) {
    $('#tb-stream').innerHTML = `<div class="empty-note" style="padding:8px">${esc(friendlyError(e))}</div>`;
    return;
  }
  state._tbData = d;
  if (!state._tbColls) {
    try {
      const c = await api('/api/collections');
      state._tbColls = [...(c.collections || []),
        ...(c.shared_libs || []).map(x => ({...x, name: `${x.name}（${x.owner || '他人'} 共享）`})),
        ...(c.group_libs || []).map(x => ({...x, name: `${x.name} · ${x.group_name}`}))];
    } catch { state._tbColls = []; }
  }

  /* ---- 导航全在全局侧栏（库树/论文点击经 02-library 分派到本页筛选）----
     表格特有维度进工具条：批次下拉在 chips 行；生效筛选 chips 照旧。 */
  const colls = d.by_collection || [];   // KPI 范围提示也用
  syncSideSel();

  /* ---- KPI 智能卡片：零值不占位（0 的卡是负信息量），有值才出现大字强调 ----
     来源论文/表格总数恒显（范围锚点）；整理中/已整理/需复核/已剔除 >0 才出卡。
     全站口径说明在筛选生效时置于卡上方（数字不随左栏筛选变）。 */
  const c = d.counts;
  const working = (c.queued || 0) + (c.running || 0);
  const scopeName = colls.find(x => x.collection_id === state._tbColl)?.name
    || (state._tbColl && (state._tbColls || []).find(x => x.id === state._tbColl)?.name);
  const scopeTip = state._tbColl
    ? `<div class="tk-kpi-scope" title="以下为全站统计，不随筛选变化">全站口径${scopeName ? ` · 已选「${esc(scopeName)}」` : ''}</div>` : '';
  kpis.innerHTML = scopeTip + [
    {n: d.by_paper.length, t: '来源论文', show: true},
    {n: c.total, t: '表格总数', show: true},
    {n: working, t: '排队/整理中', cls: 'hot', show: working > 0},
    {n: c.done, t: '已整理', show: c.done > 0},
    {n: c.mismatch, t: '需复核', cls: 'mis', show: c.mismatch > 0, click: 'tbStF(\'mismatch\')', tip: '点此筛出需人工复核的表'},
    {n: c.deleted, t: '已剔除', show: c.deleted > 0},
  ].filter(k => k.show)
   .map(k => `<div class="tk-kpi ${k.cls || ''}" ${k.click ? `onclick="${k.click}" style="cursor:pointer" title="${k.tip || ''}"` : ''}><div class="n">${k.n}</div><div class="t">${k.t}</div></div>`).join('');

  /* ---- 工具栏：状态 chips + 搜索 + 动作（单行）；生效筛选独立 chips 行 ---- */
  const chipsDesc = {active: '没被剔除的（待处理+已标记保留）', pending: '还没决定去留的',
                     kept: '明确标记要保留的', deleted: '已剔除（软删可恢复）', all: '包含已剔除'};
  const chipIcon = {active: 'stack', pending: 'clock', kept: 'check', deleted: 'trash', all: 'doc'};
  const chips = [['active', '全部可用'], ['pending', '待处理'], ['kept', '已标记保留'], ['deleted', '已剔除'], ['all', '全部']]
    .map(([v, l]) => `<div class="tp-item ${review === v ? 'on' : ''}" data-rv="${v}" title="${chipsDesc[v]}">${l}</div>`).join(' ');
  // 生效筛选统一为可移除 chips（Linear/Notion 惯例）——此前批次/论文是两种样式的
  // subtag、库藏在下拉里（与左栏重复且窄屏溢出），三处口径不一
  const collName = colls.find(x => x.collection_id === state._tbColl)?.name
    || (state._tbColls || []).find(x => x.id === state._tbColl)?.name || '所选库';
  const af = [];
  if (state._tbColl) af.push({x: "tbCollF('')", t: collName});
  if (paperF) af.push({x: "tbPaperF('')", t: (d.by_paper.find(p => p.paper_id === paperF) || {}).title || '所选论文'});
  if (state._tbSt) af.push({x: "tbStF('')", t: `整理状态：${({none: '待整理', done: '已整理', mismatch: '需复核', failed: '失败'})[state._tbSt] || state._tbSt}`});
  if (q) af.push({x: "tbSearch('')", t: `搜索「${q}」`});
  const filtRow = af.length ? `<div class="tb-filtrow"><span class="muted" style="font-size:var(--fs-xs)">筛选：</span>${
    af.map(f => `<span class="tb-fchip">${esc((f.t || '').slice(0, 40))}<b class="tb-fchip-x" onclick="${f.x}" title="移除该筛选">✕</b></span>`).join('')
  }<button class="btn small" style="padding:1px 8px" onclick="tbClearFilters()">清除全部</button></div>` : '';
  const selN = (state._tbSel || new Set()).size;
  const paperSelN = (state._tbPaperSel || new Set()).size;
  // 工具条精简（v1.12）：状态 chips + 批次下拉收进漏斗弹层（文库页 filter-pop 同款），
  // 常驻只留搜索框——激活筛选由上方 chips 行展示（含清除全部）
  const filterOn = review !== 'active' || !!state._tbSt;
    toolbar.innerHTML = `
    ${filtRow}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span style="position:relative">
        <button class="btn small ic-only tool-arrow ${filterOn ? 'has-val' : ''}" id="tb-filter-arrow"
                title="筛选：审阅状态" aria-label="筛选">${icon('sliders')}</button>
        <div class="tool-pop" id="tb-filter-pop" hidden>
          <div class="tp-label">整理状态</div>
          ${[['', '全部'], ['none', '待整理'], ['done', '已整理'], ['mismatch', '需复核'], ['failed', '失败']]
            .map(([v, l]) => `<div class="tp-item ${state._tbSt === v ? 'on' : ''}" data-st="${v}">${l}</div>`).join('')}
          <div class="tp-sep"></div>
          <div class="tp-label">审阅状态</div>
          ${chips}
          
        </div>
      </span>
      <input id="tb-q" placeholder="搜表题/论文…" value="${esc(q)}" style="flex:1;min-width:140px;max-width:420px"
             onkeydown="if(event.key==='Enter'){tbSearch(this.value)}">
      <span style="margin-left:auto"></span>
      <span class="tb-view-toggle" role="group" aria-label="显示模式">
        <button type="button" class="chip-btn ${(state._tbView || 'card') === 'card' ? 'on' : ''}" onclick="tbViewF('card')">卡片</button>
        <button type="button" class="chip-btn ${state._tbView === 'rows' ? 'on' : ''}" onclick="tbViewF('rows')">列表</button>
      </span>
      <button class="btn small" onclick="tbExportMain(this)" title="导出：有勾选=导出选中（论文含全部可用表）；无勾选=按当前筛选">${icon('download')} 导出</button>
      <button class="btn small" onclick="tbCollectOpen()" title="从文库收集表格，或上传新文件自动收集">${icon('inbox')} 收集表格</button>
      <button class="btn small primary" onclick="tbTidyBatch(this, false)" title="把当前筛选里的待整理表批量入队（LLM 整理）">${icon('bolt')} 整理待办${working ? '（进行中…）' : ''}</button>
      <button class="btn small ic-only" onclick="tbSettingsOpen(this)" title="表格整理设置（整理要求 / 容差 / 分页）" aria-label="表格整理设置">${icon('sliders')}</button>
    </div>
    ${(selN || paperSelN) ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      已选 ${selN} 张${paperSelN ? ` · ${paperSelN} 篇论文` : ''}
      <button class="btn small primary" onclick="tbTidySel(this)">整理选中</button>
      <button class="btn small" onclick="tbBatchReview(this,'kept')">标记保留</button>
      <button class="btn small danger" onclick="tbBatchReview(this,'deleted')">剔除</button>
      ${selN >= 2 ? `<button class="btn small" onclick="tbMergeCreate([...(state._tbSel || new Set())])" title="把选中的表交给 AI 合成一张汇总表（可编辑/撤销/版本回看）">${icon('brain', 12)} AI 合并</button>` : ''}
      <button class="btn small" onclick="tbExportMain(this)">导出选中</button>
      <button class="btn small" onclick="tbCkClear()">取消选择</button></div>` : ''}
    ${working ? `<div class="empty-note" style="margin-bottom:8px">${icon('clock')} 批量整理进行中（${working} 张在队列/处理）——完成会自动刷新；预算用尽时剩余保持待整理，可再点「整理待办」续跑</div>` : ''}
    ${c.mismatch ? `<div class="empty-note" style="margin-bottom:8px;color:var(--err)">${c.mismatch} 张需人工复核（模型输出与原表不一致）——点卡片「对照」人工修整后保存即转为已整理</div>` : ''}`;
  // 筛选弹层交互（弹层元素随 toolbar 重建，箭头/弹层 onclick 每轮重绑；
  // outside-close 用一次性 document 委托，避免 loadTables 循环累积监听器）
  {
    const pop = $('#tb-filter-pop'), arrow = $('#tb-filter-arrow');
    if (pop && arrow) {
      arrow.onclick = () => { pop.hidden = !pop.hidden; };
      pop.onclick = e => {
        const it = e.target.closest('.tp-item');
        if (!it) return;
        pop.hidden = true;
        if (it.dataset.st !== undefined) window.tbStF(it.dataset.st);
        else if (it.dataset.rv !== undefined) window.tbReviewF(it.dataset.rv);
      };
    }
    if (!state._tbPopBound) {
      state._tbPopBound = true;
      document.addEventListener('click', e => {
        const pop = $('#tb-filter-pop'), arrow = $('#tb-filter-arrow');
        if (!pop || pop.hidden) return;
        if (pop.contains(e.target) || arrow?.contains(e.target)) return;
        pop.hidden = true;
      });
    }
  }

  /* ---- 卡片墙：按论文分组，分组顺序 = 侧栏论文列表同款排序（state.sortBy：
     created_at DESC / title / pages / size）——两侧同一系统顺序，不再是两套 ---- */
  const groups = [];
  {
    const railScoped = !!state._tbColl;
    const byId = {};
    for (const it of d.items) (byId[it.paper_id] ||= {title: it.paper_title, pid: it.paper_id, items: []}).items.push(it);
    const src = (railScoped ? (d.by_paper_scoped || []) : (d.by_paper || []))
      .filter(p => byId[p.paper_id]);   // 分页截断的论文以 items 实际出现的为准
    const by = state.sortBy;
    if (by === 'title') src.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    else if (by === 'pages') src.sort((a, b) => (b.page_count || 0) - (a.page_count || 0));
    else if (by === 'size') src.sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
    else src.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    for (const p of src) {
      const g = byId[p.paper_id];
      g.items.sort((a, b) => (a.page_index - b.page_index) || String(a.created_at).localeCompare(String(b.created_at)));
      groups.push(g);
    }
  }
  const sel = state._tbSel || new Set();
  const rowsView = (state._tbView || 'card') === 'rows';
  const totalPages = Math.max(1, Math.ceil(d.total / _tbPageSize()));
  // 列表视图 = 审阅流，翻页（先自动保存未保存的内嵌编辑）；卡片视图 = 瀑布流，保留加载更多
  const pager = rowsView ? `<div class="tb-pager" style="display:flex;gap:10px;align-items:center;justify-content:center;padding:10px">
      <button class="btn small" onclick="tbPageTo(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="muted" style="font-size:var(--fs-sm)">第 ${page} / ${totalPages} 页 · 共 ${d.total} 张</span>
      <button class="btn small" onclick="tbPageTo(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页 ›</button>
    </div>`
    : (d.total > page * _tbPageSize() ? `<div style="text-align:center;padding:10px">
      <button class="btn small" onclick="tbLoadMore()">加载更多（${d.total - page * _tbPageSize()} 张未显示）</button></div>` : '');
  if (groups.length) {
    // 视图切换（v1.12）：卡片=截图对照向，列表=批量审阅向（同一数据源、同一操作）
    stream.innerHTML = groups.map(g => `
    <div class="tk-day">
      <input type="checkbox" class="tb-group-ck" data-pid="${g.pid}" data-ids="${g.items.map(i => i.id).join(',')}" onchange="tbGroupSel(this)" title="选中这篇论文（导出含其全部可用表，跨页全量）" aria-label="选中这篇论文">
      <span>${esc(g.title || '(无标题)')}</span><span class="tk-day-n">${g.items.length} 张</span><i></i>
      <button class="btn small hover-only" onclick="tbExportGroup('${g.pid}', this)" title="导出该论文的全部可用表格（跨页全量，AI 整理版优先）">${icon('download', 12)} 导出本组</button>
    </div>
    <div class="${rowsView ? 'tb-rows' : 'tb-wall'}">${g.items.map(it => rowsView ? tbRowHtml(it, sel, review) : tbCardHtml(it, sel, review)).join('')}</div>`).join('') + pager;
    // 分组头复选状态（两级选中模型）：论文级勾选=checked；仅部分表勾（未勾论文）=indeterminate
    const paperSel = state._tbPaperSel || new Set();
    $$('#tb-stream .tb-group-ck').forEach(ck => {
      const ids = ck.dataset.ids.split(',').filter(Boolean);
      const n = ids.filter(id => sel.has(id)).length;
      ck.checked = paperSel.has(ck.dataset.pid);
      ck.indeterminate = !ck.checked && n > 0;
    });
  } else if (af.length || review !== 'active') {
    // 筛选没命中（如选了 test 库又挂着别篇论文的筛选）——给逃生门，不再误显「还没有表格」
    stream.innerHTML = `<div class="empty-state"><p class="t">当前筛选下没有表格</p>
       <p>库/论文/关键词筛选取交集——可能组合后为空；左侧数字是该范围的总量</p>
       <button class="btn small" onclick="tbClearFilters()">${icon('retry')} 清除全部筛选</button></div>`;
  } else {
    stream.innerHTML = `<div class="empty-state"><p class="t">还没有表格</p>
       <p>点「批量收集」从已解析论文批量收集表格（可一键圈选全部已解析论文）；或先在文库上传并解析 PDF</p></div>`;
  }
}
window.tbClearFilters = () => {
  state._tbColl = ''; state._tbPaper = ''; state._tbQ = ''; state._tbSt = '';
  state._tbPage = 1; state._tbSel = new Set();
  loadTables();
};
window.tbReviewF = v => { state._tbReview = v; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };
/* 整理状态筛选（KPI「需复核」卡直达 + 漏斗弹层「整理状态」组）：与审阅状态正交维度 */
window.tbStF = v => { state._tbSt = state._tbSt === v ? '' : v; state._tbPage = 1; loadTables(); };
// 视图切换：卡片（截图对照向）/ 列表（批量审阅向）——持久化，与筛选无关不重拉数据
window.tbViewF = v => {
  state._tbView = v;
  localStorage.setItem('ps-tb-view', v);
  loadTables();
};
state._tbView = localStorage.getItem('ps-tb-view') || 'card';
// 筛选入口：全局侧栏（tables 页上下文分派）+ 工具条（批次下拉/搜表题）。
// syncSideSel 让侧栏高亮跟随表格筛选（选中/取消都即时反映）。
function syncSideSel() {
  $$('.sidebar .col-item').forEach(x => x.classList.toggle('on', x.dataset.id === (state._tbColl || '')));
  $$('.sidebar .paper-item').forEach(x => x.classList.toggle('sel', x.dataset.id === state._tbPaper));
}
window.tbPaperF = id => { state._tbPaper = state._tbPaper === id ? '' : id; state._tbPage = 1; state._tbSel = new Set(); syncSideSel(); loadTables(); };   // 再点已选论文 = 取消筛选
window.tbCollF = id => { state._tbColl = id; state._tbPage = 1; state._tbSel = new Set(); syncSideSel(); loadTables(); };

window.tbCkClear = () => { state._tbSel = new Set(); state._tbPaperSel = new Set(); loadTables(); };

/* ---------- 卡片 ---------- */
function tbCardHtml(it, sel, review) {
  const st = _TB_ST[it.ai_status] || ['待整理', 'dim'];
  const img = it.asset_name
    ? `<img src="/api/papers/${it.paper_id}/images/${esc(it.asset_name)}" loading="lazy" alt="" aria-hidden="true"
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
        <button class="btn small hover-only" onclick="tbTidyOne('${it.id}', this)" title="LLM 整理此表" aria-label="AI 整理此表">${icon('bolt', 12)}</button>
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
/* 列表行（v1.12 视图切换）：与卡片同一数据源，信息密度优先——批量审阅一屏几十张 */
function tbRowHtml(it, sel, review) {
  const img = it.asset_name
    ? `<img class="tb-row-thumb" src="/api/papers/${it.paper_id}/images/${esc(it.asset_name)}" loading="lazy" alt="" aria-hidden="true" title="点击预览（对照工作台）"
           onclick="tbCompare('${it.id}')" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tb-thumb-fallback',textContent:'—'}))">`
    : '<div class="tb-row-thumb tb-thumb-fallback" title="点击预览（对照工作台）" onclick="tbCompare(\'' + it.id + '\')">—</div>';
  const checked = sel.has(it.id) ? 'checked' : '';
  const del = it.review === 'deleted';
  return `
  <div class="tb-row ${del ? 'tb-del' : ''}" data-tid="${it.id}">
    <input type="checkbox" class="tb-ck" data-tid="${it.id}" ${checked} onchange="tbCk(this)" aria-label="选中此表">
    ${img}
    <span class="tb-row-cap" title="${esc(it.caption)}">${esc(it.caption || '（无表题）')}</span>
    <span class="muted tb-row-meta">第 ${it.page_index + 1} 页</span>
    <span class="muted tb-row-meta">${it.n_rows}×${it.n_cols}</span>
    <span class="tb-row-st">${tbStatusBadge(it.ai_status)}${it.review === 'kept' ? '<span class="badge ok">保留</span>' : ''}${del ? '<span class="badge dim">已剔除</span>' : ''}</span>
    <span class="tb-row-ops">
      <button class="btn small primary" onclick="tbCompare('${it.id}')">对照</button>
      <button class="btn small hover-only" onclick="tbTidyOne('${it.id}', this)" title="LLM 整理此表" aria-label="AI 整理此表">${icon('bolt', 12)}</button>
      ${del
        ? `<button class="btn small hover-only" onclick="tbReview('${it.id}','pending',this)">恢复</button>
           <button class="btn small danger hover-only" onclick="tbHardDel('${it.id}',this)" title="从工作台彻底删除">${icon('trash', 12)}</button>`
        : `<button class="btn small danger hover-only" onclick="tbReview('${it.id}','deleted',this)">剔除</button>`}
      <button class="btn small hover-only" onclick="tbExport(['${it.id}'], this)" title="下载此表 xlsx">${icon('download', 12)}</button>
      <button class="btn small hover-only" onclick="tbLocate('${it.paper_id}', ${it.page_index})" title="打开原论文并跳到该页">${icon('library', 12)}</button>
    </span>
  </div>`;
}

/* ---------- 事件 ---------- */
window.tbCk = async ck => {
  const s = state._tbSel || (state._tbSel = new Set());
  ck.checked ? s.add(ck.dataset.tid) : s.delete(ck.dataset.tid);
  // 行级变化打破论文级选中（语义：动了其中一张 = 改为按表选；论文级导出要求整篇未动）
  const it = (state._tbData?.items || []).find(x => x.id === ck.dataset.tid);
  if (it && !ck.checked) state._tbPaperSel?.delete(it.paper_id);
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

/* ---------- 批量收集弹层 ---------- */
window._tbHarvestClose = () => { document.querySelectorAll('.ui-backdrop').forEach(x => x.remove()); _tbCollectPop = null; };
/* 批量收集主弹层（合并原「上传解析」与「批量收集」两个入口）：
   页签一「从文库收集」= 已解析论文勾选收割；页签二「上传新文件」= 上传→解析→自动收集一条链。 */
let _tbCollectPop = null, _tbCollectTab = 'harvest';
window.tbCollectOpen = (tab = 'harvest') => {
  _tbCollectPop?.close();
  const {pop, close} = openPop('tb-collect-pop');
  _tbCollectPop = {pop, close};
  _tbCollectTab = tab;
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('inbox')} 收集表格
    <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
  <div class="tb-collect-tabs" style="display:flex;gap:6px;margin-top:8px">
    <button type="button" class="chip-btn ${tab === 'harvest' ? 'on' : ''}" data-tab="harvest">${icon('doc', 12)} 从文库收集</button>
    <button type="button" class="chip-btn ${tab === 'upload' ? 'on' : ''}" data-tab="upload">${icon('upload', 12)} 上传新文件</button>
  </div>
  <div id="tb-collect-body" style="margin-top:10px"></div>`;
  pop.querySelector('[data-x]').onclick = () => { close(); _tbCollectPop = null; };
  const render = t => {
    _tbCollectTab = t;
    pop.querySelectorAll('.tb-collect-tabs .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    const body = $('#tb-collect-body');
    body.innerHTML = '';
    (t === 'harvest' ? _tbHarvestBody : _tbUploadBody)(body);
  };
  pop.querySelectorAll('.tb-collect-tabs .chip-btn').forEach(b => b.onclick = () => render(b.dataset.tab));
  render(tab);
};

window.tbHarvestOpen = () => tbCollectOpen('harvest');   // 兼容旧入口（命令面板等）
window._tbHarvestClose = () => { _tbCollectPop?.close(); _tbCollectPop = null; };

async function _tbHarvestBody(box) {
  box.innerHTML = `<div style="padding:8px 0"><span class="spin"></span> 加载可收集论文…</div>`;
  let d;
  try { d = await api('/api/tables/sources'); }
  catch (e) { box.textContent = friendlyError(e); return; }
  const srcs = d.sources || [];
  window._tbSrcs = srcs;
  box.innerHTML = `
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <input id="tb-src-q" placeholder="搜论文标题…" style="width:150px" oninput="tbSrcRender()">
    <select id="tb-src-lib" style="width:auto;max-width:150px" onchange="tbSrcRender()">
      <option value="">全部文献库</option>
      ${(d.libs || []).map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
    </select>
    <label class="tk-inline"><input type="checkbox" id="tb-src-new" ${localStorage.getItem('ps-tbl-onlynew') !== '0' ? 'checked' : ''} onchange="localStorage.setItem('ps-tbl-onlynew', this.checked?'1':'0');tbSrcRender()"> 只看未收集</label>
    <span style="margin-left:auto"></span>
    <button class="btn small" onclick="tbHarvestCkAll(this)">全选可见</button>
    <label class="tk-inline"><input type="checkbox" id="tb-auto" ${localStorage.getItem('ps-tbl-autotidy') !== '0' ? 'checked' : ''} onchange="localStorage.setItem('ps-tbl-autotidy', this.checked?'1':'0')"> 收集后自动整理</label>
  </div>
  <div class="tb-src-list" id="tb-src-list" style="max-height:46vh;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r-md);margin-top:8px"></div>
  <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
    <button class="btn primary" onclick="tbHarvestGo(this, false)">收集所选</button>
    <button class="btn" onclick="tbHarvestGo(this, true)">收集全部剩余</button>
    <span class="muted" id="tb-src-stat" style="margin-left:auto;font-size:var(--fs-xs)"></span>
  </div>`;
  tbSrcRender();
}
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
  // 行风格与文库侧栏统一（col-item：箭头 + 图标 + 右侧圆角计数）
  box.innerHTML = [...groups.entries()].map(([g, items]) => `
    <div class="tb-rail-sec">${esc(g)} <span class="muted">${items.length} 篇</span></div>
    ${items.map(s => `
    <div class="col-item">
      <input type="checkbox" class="tb-src-ck" value="${s.paper_id}" ${s.in_bench ? 'disabled title="已收集过（不可重复勾选）"' : 'title="勾选收集"'}>
      <span class="col-arrow" role="button" aria-expanded="false" title="展开该篇的表格清单"
            onclick="tbSrcExpand('${s.paper_id}', this)">${icon('chevR')}</span>
      <span class="col-name">${icon('doc')} ${esc(s.title)}${s.in_bench ? ` <span class="badge dim">已收集 ${s.in_bench}</span>` : ''}</span>
      <span class="col-count" title="${s.n_tables} 张表格">${s.n_tables}</span>
    </div>`).join('')}`).join('')
    || '<div class="empty-note" style="padding:12px">没有匹配的论文（试试切换库或取消「只看未收集」）</div>';
  const visible = srcs.filter(s => !s.in_bench);
  $('#tb-src-stat').textContent = `可见 ${srcs.length} 篇（可收 ${visible.length}）`;
};
/* 收集弹层下钻：点 ▸ 展开该篇的表格清单（懒加载轻量列表）——收什么先看清楚 */
window.tbSrcExpand = async (pid, tw) => {
  const item = tw.closest('.col-item');
  const open = tw.getAttribute('aria-expanded') === 'true';
  item.nextElementSibling?.classList.contains('tb-src-detail') && item.nextElementSibling.remove();
  if (open) { tw.setAttribute('aria-expanded', 'false'); tw.textContent = '▸'; return; }
  tw.setAttribute('aria-expanded', 'true'); tw.textContent = '▾';
  const det = document.createElement('div');
  det.className = 'tb-src-detail';
  det.innerHTML = '<div class="muted" style="padding:4px 10px;font-size:var(--fs-xs)"><span class="spin"></span> 加载…</div>';
  item.after(det);
  try {
    const d = await api(`/api/tables/list?review=all&paper_id=${pid}&page_size=200`);
    if (!det.isConnected) return;   // 弹层已关
    det.innerHTML = (d.items || []).length
      ? d.items.map(t => `
      <div class="col-item" style="padding-left:30px">
        <span class="col-arrow-none"></span>
        <span class="col-name" style="font-size:var(--fs-xs)">${esc(t.caption || '（无表题）')}</span>
        ${tbStatusBadge(t.ai_status)}
        <span class="col-count" title="第 ${t.page_index + 1} 页">第 ${t.page_index + 1} 页 · ${t.n_rows}×${t.n_cols}</span>
      </div>`).join('')
      : '<div class="muted" style="padding:4px 10px;font-size:var(--fs-xs)">该论文没有检测到表格</div>';
  } catch (e) {
    if (det.isConnected) det.innerHTML = `<div class="muted" style="padding:4px 10px">${esc(friendlyError(e))}</div>`;
  }
};
window.tbHarvestCkAll = btn => {
  const cks = [...document.querySelectorAll('.tb-src-ck:not(:disabled)')];
  const on = cks.some(c => !c.checked);
  cks.forEach(c => c.checked = on);
};  // 只影响当前筛选可见项（隐藏的已不在 DOM）
window.tbHarvestGo = async (btn, all) => {
  await withBusy(btn, async () => {
    const ids = all ? [] : [...document.querySelectorAll('.tb-src-ck:checked')].map(c => c.value);
    if (!all && !ids.length) { toast('先勾选论文（或点「收集全部剩余」）'); return; }
    const r = await api('/api/tables/harvest', {method: 'POST',
      body: JSON.stringify(all ? {all: true, auto_tidy: $('#tb-auto')?.checked} : {paper_ids: ids, auto_tidy: $('#tb-auto')?.checked})});
    toast(`收集完成：${r.papers} 篇 ${r.found} 张，新入库 ${r.inserted} 张（跳过 ${r.skipped}）${r.job_id ? '，整理已排队' : ''}`, 8000);
    window._tbHarvestClose?.();
    state._tbReview = 'active';
    loadTables();
  }, '收集失败');
};

/* ---------- 批量整理 / 取舍 / 导出 ---------- */
async function tbTidyBatch(btn, force) {
  await withBusy(btn, async () => {
    // 按所见圈表：批次/文献库筛选一并透传——此前只传 review/q/paper，入队范围比看到的大
    const f = {review: state._tbReview || 'active', q: state._tbQ || '', paper_id: state._tbPaper || '',
               collection_id: state._tbColl || ''};
    const r = await api('/api/tables/tidy-batch', {method: 'POST', body: JSON.stringify({filtered: f, force})});
    toast(`已入队 ${r.count} 张——整理进度见顶部统计，完成自动刷新`, 5000);
    loadTables();
  }, '入队失败');
}

/* ---------- 表格整理设置（per-user：整理要求模板 + mismatch 容差；分页纯前端） ---------- */
let _tbSetPop = null;
window._tbSettingsClose = () => { _tbSetPop?.close(); _tbSetPop = null; };
window.tbSettingsOpen = async btn => {
  _tbSetPop?.close();
  const {pop, close} = openPop('tb-settings-pop');
  _tbSetPop = {pop, close};
  pop.innerHTML = `<div class="ui-pop-title">${icon('sliders')} 表格整理设置
    <button class="btn small" style="margin-left:auto" onclick="_tbSettingsClose()">${icon('close')}</button></div>
    <div style="margin-top:10px"><span class="spin"></span> 加载…</div>`;
  let d;
  try { d = await api('/api/settings/tables'); }
  catch (e) { pop.querySelector('div:last-child').textContent = friendlyError(e); return; }
  window._tbSetDefaults = d.defaults;
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('sliders')} 表格整理设置
    <button class="btn small" style="margin-left:auto" onclick="_tbSettingsClose()">${icon('close')}</button></div>
  <div style="margin-top:10px">
    <label class="tk-fld">整理要求（随每次 LLM 整理下发；留空 = 用默认）
      <textarea id="tb-set-rules" rows="7" style="width:100%;font-family:inherit">${esc(d.rules)}</textarea>
    </label>
    <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">仅影响「整理要求」段——行列数硬约束与输出 JSON 格式由系统固定拼接，不会因模板改坏而全量复核。</div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <button class="btn small" onclick="tbSettingsResetRules(this)">恢复默认要求</button>
      ${d.is_custom ? '<span class="badge run">已自定义</span>' : '<span class="badge dim">默认模板</span>'}
    </div>
    <label class="tk-fld" style="margin-top:12px">mismatch 行容差（表头合并允许的最大减行数，0-10；默认 2）
      <input id="tb-set-tol" type="number" min="0" max="10" step="1" value="${d.row_tol}" style="width:80px"></label>
    <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">列数始终严格校验（数据完整性不受容差影响）；容差同时作用于提示词承诺与结果判定，两处联动。</div>
    <label class="tk-fld" style="margin-top:12px">列表分页大小（每页卡片数）
      <select id="tb-set-page" style="width:auto">
        ${[20, 40, 60, 100].map(n => `<option value="${n}" ${_tbPageSize() === n ? 'selected' : ''}>${n} 张/页</option>`).join('')}
      </select></label>
    <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <button class="btn primary" onclick="tbSettingsSave(this)">${icon('check')} 保存</button>
      <span class="muted" style="font-size:var(--fs-xs)">分页立即生效；模板/容差对下一次整理生效（已整理的不受影响）</span>
    </div>
  </div>`;
};
window.tbSettingsResetRules = btn => {
  const ta = $('#tb-set-rules');
  const def = window._tbSetDefaults?.rules || '';
  if (ta) ta.value = def;
  toast('已填回默认要求——点「保存」生效', 2500);
};
window.tbSettingsSave = async btn => {
  const rules = ($('#tb-set-rules')?.value || '').trim();
  const tol = Math.max(0, Math.min(10, +($('#tb-set-tol')?.value || 2)));
  const pageSize = +($('#tb-set-page')?.value || 60);
  if (rules.length > 2000) { toast('整理要求过长（≤2000 字）——请精简'); return; }
  await withBusy(btn, async () => {
    await api('/api/settings/tables', {method: 'PUT', body: JSON.stringify({rules, row_tol: tol})});
    localStorage.setItem('ps-tbl-page', String(pageSize));
    toast('表格设置已保存');
    window._tbSettingsClose?.();
    loadTables();
  }, '保存失败');
};
window.tbTidyBatch = tbTidyBatch;
window.tbTidySel = async btn => {
  const pids = [...(state._tbPaperSel || new Set())];
  const ids = [...(state._tbSel || new Set())];
  if (!ids.length && !pids.length) return;
  await withBusy(btn, async () => {
    const r = await api('/api/tables/tidy-batch',
      {method: 'POST', body: JSON.stringify({ids, paper_ids: pids})});
    toast(`已入队 ${r.count} 张${pids.length ? `（含论文级 ${pids.length} 篇）` : ''}`);
    state._tbSel = new Set(); state._tbPaperSel = new Set();
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
    const undoRv = rv === 'deleted' ? 'pending' : 'pending';
    toast(rv === 'deleted' ? '已剔除' : rv === 'kept' ? '已标记保留' : '已回待处理', 5000,
      {label: '撤销', onClick: async () => {
        try { await api(`/api/tables/${tid}/review`, {method: 'POST', body: JSON.stringify({review: undoRv})}); loadTables(); } catch {}
      }});
  }, '操作失败');
};
window.tbBatchReview = async (btn, rv) => {
  const ids = [...(state._tbSel || new Set())];
  const pids = [...(state._tbPaperSel || new Set())];
  if (!ids.length && !pids.length) return;
  const verb = rv === 'deleted' ? '剔除' : '标记保留';
  const parts = [];
  if (pids.length) parts.push(`${pids.length} 篇论文（各含全部可用表）`);
  if (ids.length) parts.push(`${ids.length} 张单选表`);
  if (!(await uiConfirm(`${verb}选中：${parts.join(' + ')}？`, {title: verb, danger: rv === 'deleted'}))) return;
  await withBusy(btn, async () => {
    await api('/api/tables/batch-review', {method: 'POST', body: JSON.stringify({ids, paper_ids: pids, review: rv})});
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
    if (!(await uiConfirm(`导出全部可用表格（约 ${d.counts.total - d.counts.deleted} 张，每表一个 sheet）？`, {title: '导出 xlsx'}))) return;
    try {
      await downloadBlob('/api/tables/export', payload, 'tables.xlsx', '已导出——可直接用 Excel/WPS 打开');
    } catch (e) { toast(friendlyError(e, '导出失败')); }
  }
}
window.tbExport = tbExport;
window.tbExportSel = btn => tbExport([...(state._tbSel || new Set())], btn);   // 内联 onclick 取不到模块 state
/* 导出主入口（工具条「导出」/ 批量条「导出选中」共用）：弹层式——
   范围摘要 + 可选「AI 按指令加工」（批量入队，完成后 AI 整理版即加工版）+ 版本选择。
   有选中 → 导出选中（论文级 _tbPaperSel + 表级 _tbSel 混合，论文=跨页全量）；
   无选中 → 按当前筛选（filtered，与所见一致）。优先级：选中 > 筛选。 */
let _tbExportPop = null;
window.tbExportMain = async btn => {
  _tbExportPop?.close();
  const pids = [...(state._tbPaperSel || new Set())];
  const tids = [...(state._tbSel || new Set())];
  const d = state._tbData;
  const fN = d?.total ?? 0;
  const hasSel = pids.length || tids.length;
  const scopeLine = hasSel
    ? [pids.length ? `${pids.length} 篇论文（各含全部可用表）` : '', tids.length ? `${tids.length} 张单选表` : ''].filter(Boolean).join(' + ')
    : `当前筛选 ${fN} 张`;
  const {pop, close} = openPop('tb-export-pop tb-export-pop');
  _tbExportPop = {pop, close};
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('download')} 导出 xlsx
    <button class="btn small ic-only" data-x title="关闭" aria-label="关闭">${icon('close')}</button></div>
  <div class="muted" style="font-size:var(--fs-sm);margin-top:8px">范围：${esc(scopeLine)}${hasSel ? '' : '（可先勾选论文/表格缩小范围）'}</div>
  <div class="tb-exp-sec">
    <div class="tp-label">AI 加工（可选）</div>
    <textarea id="tb-exp-instr" rows="3" placeholder="例：只保留 Method 列与 AUC 列；或：多级表头压成一行，空值填 —"></textarea>
    <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">留空 = 直接导出。填指令 = 每张表由 AI 按指令重生成（后台逐张处理，完成后此批即加工版，可在 AI 页签继续调整）</div>
  </div>
  <div class="tb-exp-sec">
    <div class="tp-label">表内容版本</div>
    <div class="tb-exp-ver">
      <label><input type="radio" name="tb-exp-ver" value="ai" checked> AI 整理版优先（未整理自动用原始提取）</label>
      <label><input type="radio" name="tb-exp-ver" value="orig"> 原始提取</label>
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
    <button class="btn primary" id="tb-exp-go">${icon('download')} 导出</button>
    <span class="muted" id="tb-exp-msg" style="font-size:var(--fs-xs)"></span>
  </div>`;
  pop.querySelector('[data-x]').onclick = close;
  $('#tb-exp-go').onclick = async () => {
    const instruction = ($('#tb-exp-instr')?.value || '').trim();
    const version = pop.querySelector('input[name=tb-exp-ver]:checked')?.value || 'ai';
    const msg = $('#tb-exp-msg'), go = $('#tb-exp-go');
    const payloadBase = hasSel ? {paper_ids: pids, ids: tids}
      : {filtered: {review: state._tbReview || 'active', q: state._tbQ || '', paper_id: state._tbPaper || '',
                    collection_id: state._tbColl || '',
                    ps: state.filter || '', sc: state.scope || ''}};
    const fname = hasSel ? 'tables-selected.xlsx' : 'tables-filtered.xlsx';
    go.disabled = true;
    try {
      if (instruction) {
        // AI 加工：批量入队（job 逐表 regen 落库）——完成后 AI 整理版即加工版
        const r = await api('/api/tables/regen-batch',
          {method: 'POST', body: JSON.stringify({...payloadBase, instruction})});
        close();
        toast(`AI 加工已排队（${r.count} 张，逐张按指令重生成）——完成后表格自动刷新，再点「导出」即是加工版`, 8000);
        return;
      }
      await downloadBlob('/api/tables/export', {...payloadBase, version}, fname, '已导出');
      close();
    } catch (e) {
      msg.textContent = friendlyError(e, '操作失败');
      go.disabled = false;
    }
  };
};
window.tbExportFiltered = window.tbExportMain;   // 旧入口别名
/* 导出本组：分组头按钮——该论文在当前筛选下的全部可用表（跨页全量，不只本页可见的） */
window.tbExportGroup = async (pid, btn) => {
  const agg = (state._tbData?.by_paper_scoped || state._tbData?.by_paper || []).find(p => p.paper_id === pid);
  const n = agg?.n ?? '?';
  const title = (agg?.title || '').slice(0, 40);
  if (!(await uiConfirm(`导出「${title}…」的全部可用表格（${n} 张，跨页全量，AI 整理版优先）？`, {title: '导出 xlsx'}))) return;
  await withBusy(btn, () => downloadBlob('/api/tables/export',
    {filtered: {review: state._tbReview || 'active', q: state._tbQ || '', paper_id: pid,
                collection_id: state._tbColl || '',
                ps: state.filter || '', sc: state.scope || ''}},
    'tables-group.xlsx', `已导出 ${n} 张`), '导出失败');
};
/* 分组头全选/取消（当前页内该论文的表） */
window.tbGroupSel = ck => {
  // 论文级复选：勾 = 该论文进 _tbPaperSel（导出跨页全量）+ 组内本页表进 _tbSel（行框视觉同步）
  const pid = ck.dataset.pid;
  const s = state._tbSel || (state._tbSel = new Set());
  const ps = state._tbPaperSel || (state._tbPaperSel = new Set());
  if (ck.checked) {
    ck.dataset.ids.split(',').filter(Boolean).forEach(id => s.add(id));
    ps.add(pid);
  } else {
    ck.dataset.ids.split(',').filter(Boolean).forEach(id => s.delete(id));
    ps.delete(pid);
  }
  loadTables();
};
window.tbLoadMore = () => { state._tbPage = (state._tbPage || 1) + 1; loadTables(); };
/* 列表视图翻页：先保存未保存的内嵌编辑（dirty）再翻，翻后回顶 */
window.tbPageTo = async p => {
  for (const [tid, st] of Object.entries(window._tbInline || {})) {
    if (st.dirty) await tbInlineSave(tid);
  }
  state._tbPage = Math.max(1, p);
  loadTables();
  document.querySelector('#page-tables')?.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0 });
};
window.tbSearch = v => { state._tbQ = v; state._tbPage = 1; state._tbSel = new Set(); loadTables(); };

/* ---------- 全屏对照审阅工作台（连续翻页核验：←→ 翻表 / X 剔除并下一张） ---------- */
let _tbCompareTab = 'ai';
let _tbCmpPop = null;
const _tbCmp = {idx: 0, dirty: false, layout: null, tid: null, items: []};
const _TB_LAYOUTS = ['both', 'img', 'grid'];

function _tbLayoutInit() {
  if (!_tbCmp.layout) {
    const saved = localStorage.getItem('ps-tbl-layout');
    _tbCmp.layout = _TB_LAYOUTS.includes(saved) ? saved : 'both';
  }
  return _tbCmp.layout;
}
function _tbSplitRead() { return localStorage.getItem('ps-tbl-split') || '42%'; }
/* 分栏拖拽（复用阅读页 vsplit 交互惯例：拖动改比例、双击复位 50/50 处的等价物） */
window.tbSplitStart = e => {
  e.preventDefault();
  const body = document.querySelector('.tbws-body.tbws-both');
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const move = ev => {
    const pct = Math.max(20, Math.min(80, ((ev.clientX - rect.left) / rect.width) * 100));
    body.style.setProperty('--tb-split', pct.toFixed(1) + '%');
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const v = body.style.getPropertyValue('--tb-split') || '42%';
    localStorage.setItem('ps-tbl-split', v);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
};
window.tbSplitReset = () => {
  document.querySelector('.tbws-body.tbws-both')?.style.setProperty('--tb-split', '42%');
  localStorage.setItem('ps-tbl-split', '42%');
};

function _tbCmpCleanup() {
  if (_tbCmp.dirty) tbCmpAutoSave();          // 离开自动保存——编辑永不丢
  _tbCmp.keyHandler && document.removeEventListener('keydown', _tbCmp.keyHandler);
  _tbCmp.keyHandler = null;
  _tbCellPopClose();
  _tbCmpPop = null;
  loadTables();                               // 审阅后的状态/统计刷新
}
/* 关闭统一收口：按钮 / Esc / 点遮罩全走 openPop 的 close（beforeClose 保证未保存
   编辑不丢——此前 Esc 与遮罩直通 remove()，绕过本函数丢编辑） */
window.tbCompareClose = () => { _tbCmpPop?.close(); };

function _tbItems() { return state._tbData?.items || []; }

window.tbCompare = async tid => {
  _tbCmpPop?.close();
  _tbLayoutInit();
  const {pop, close} = openPop('tb-compare-pop', {beforeClose: () => { _tbCmpCleanup(); return true; }});
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
      else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); tbCmpReview('kept'); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? tbGridRedo() : tbGridUndo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); tbGridRedo(); }
    };
    document.addEventListener('keydown', _tbCmp.keyHandler);
  }
  pop.innerHTML = `<div style="padding:40px;text-align:center"><span class="spin"></span> 加载…</div>`;
  await tbCmpRender();
};

async function tbCmpRender() {
  _tbCellPopClose();                          // 翻表/重渲关掉残留的右键菜单
  const it = _tbCmp.items[_tbCmp.idx];
  if (!it) { window.tbCompareClose(); return; }
  const pop = _tbCmpPop?.pop;
  if (!pop) return;
  let d;
  try { d = await api(`/api/tables/${it.id}`); }
  catch (e) { pop.innerHTML = `<div style="padding:40px">${esc(friendlyError(e))}</div>`; return; }
  if (_tbCmp.tid !== d.id) { _tbCompareTab = d.ai_cells ? 'ai' : 'orig'; _tbUndo = []; _tbRedo = []; }   // 换表重置页签与撤销/重做栈
  _tbCmp.tid = d.id;
  _tbCmp.detail = d;   // 自动保存后同步 ai_cells 标记（页签「未整理」角标随下次渲染消失）
  _tbCmp.dirty = false;
  const gridOf = tab => {
    if (tab === 'ai' && d.ai_cells) { try { return JSON.parse(d.ai_cells); } catch { /* 落回原始 */ } }
    if (tab === 'ai') return [];   // 未整理：AI 页签空态（不预览原始数据，指令框生成）——底稿歧义已由问答框替代
    return JSON.parse(d.cells || '[]');
  };
  const aiTab = _tbCompareTab === 'ai';
  const aiEmpty = aiTab && !d.ai_cells;
  window._tbGrid = gridOf(_tbCompareTab);
  const st = _TB_ST[it.ai_status] || ['', 'dim'];
  pop.innerHTML = `
  <div class="tbws">
    <div class="tbws-head">
      <div style="flex:1;min-width:0">
        <b style="font-size:var(--fs-md)">${esc((d.caption || '（无表题）').slice(0, 90))}</b>
        <div class="muted" style="font-size:var(--fs-xs)">${esc(d.paper_title)} · 第 ${d.page_index + 1} 页 · <span id="tb-dim">${window._tbGrid.length}×${window._tbGrid[0]?.length || 0}</span>
          <span id="tb-badge">${tbStatusBadge(it.ai_status)}${it.review === 'kept' ? '<span class="badge ok">保留</span>' : ''}${it.review === 'deleted' ? '<span class="badge dim">已剔除</span>' : ''}</span></div>
      </div>
      <span class="tbws-count">${_tbCmp.idx + 1} / ${_tbCmp.items.length}</span>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'both' ? 'on' : ''}" onclick="tbCmpLayout('both')">并排</button>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'img' ? 'on' : ''}" onclick="tbCmpLayout('img')">仅截图</button>
      <button type="button" class="chip-btn ${_tbCmp.layout === 'grid' ? 'on' : ''}" onclick="tbCmpLayout('grid')">仅表格</button>
      <button class="btn small" onclick="tbCompareClose()" title="关闭（Esc）">${icon('close')}</button>
    </div>
    ${d.ai_status === 'mismatch' ? `<div class="tb-mis-bar">${icon('warn')} ${esc(d.ai_note || '模型输出与原表不一致')}——人工修整后保存即转为已整理</div>` : ''}
    <div class="tbws-body tbws-${_tbCmp.layout}" style="--tb-split:${esc(_tbSplitRead())}">
      <div class="tbws-img">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">原始截图（点击放大）</div>
        ${d.img_url ? `<img src="${d.img_url}" onclick="tbCmpZoom('${d.img_url}')" title="点击放大">
          <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">MinerU 裁剪 · ${esc(d.asset_name || '')}</div>`
          : '<div class="tb-thumb-fallback" style="padding:40px 0">无截图（以原始提取网格为准）</div>'}
      </div>
      ${_tbCmp.layout === 'both' ? `<div class="tb-v-handle" role="separator" aria-orientation="vertical"
        title="拖动调整比例（20%–80%）· 双击复位" onmousedown="tbSplitStart(event)" ondblclick="tbSplitReset()"></div>` : ''}
      <div class="tbws-grid">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
          <button type="button" class="chip-btn ${_tbCompareTab === 'ai' ? 'on' : ''}" onclick="tbCmpTab('ai')">AI 整理${d.ai_cells ? '' : '（未整理）'}</button>
          <button type="button" class="chip-btn ${_tbCompareTab === 'orig' ? 'on' : ''}" onclick="tbCmpTab('orig')">原始提取</button>
          <span style="flex:1"></span>
          ${aiEmpty ? '' : `
          <button class="btn small" onclick="tbGridAddRow()">+行</button>
          <button class="btn small" onclick="tbGridAddCol()">+列</button>
          <button class="btn small" onclick="tbGridUndo()" title="撤销（Ctrl+Z）——含结构操作与 AI 重生成">↶ 撤销</button>
          <button class="btn small" onclick="tbGridRedo()" title="重做（Ctrl+Y）">↷ 重做</button>
          <button class="btn small" onclick="tbCellMenuAtBtn(this)" title="单元格操作菜单（右键单元格同款）" aria-label="单元格操作菜单">${icon('sliders', 12)}</button>
          <button class="btn small primary" onclick="tbGridSave('${d.id}', this)">${icon('check')} 保存</button>`}
        </div>
        ${aiTab ? `
        <div class="tb-ai-ask">
          <input id="tb-ai-ask-inp" placeholder="${aiEmpty
            ? '告诉 AI 怎么整理这张表，如：合并多级表头为一行；数值列只保留最大值行…'
            : '继续调整：如转置表格 / 只保留前两列 / 按avg列降序排序…'}" aria-label="表格整理指令"
            onkeydown="if(event.key==='Enter'&&!event.isComposing)tbAiAsk()">
          <button class="btn small primary" id="tb-ai-ask-go" onclick="tbAiAsk()">${icon('bolt', 12)} 生成</button>
          ${aiEmpty ? '' : `<button class="btn small" onclick="tbResetOrig()" title="工作副本重置为 AI 处理前的原始提取（可撤销）">⟲ 还原原始</button>`}
        </div>
        <div id="tb-ai-note" class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">${aiEmpty ? '尚未整理——此页签不预览原始数据（见「原始提取」页签）。输入指令让 AI 生成整理版，生成即自动保存。' : ''}</div>` : ''}
        ${aiEmpty ? '' : `
        <div class="tb-grid-wrap"><table class="tbl-md tb-edit-grid" id="tb-edit-grid" contenteditable="true"></table></div>
        <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">点击单元格直接改；右键单元格：合并/插行列/移动/清空（Excel 式）；悬停行首/表头出 ✕ 删行删列；翻页/关闭自动保存</div>`}
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
  // 键盘惯例（Excel/Airtable）：Enter=提交并下移 / Shift+Enter=上移 / Esc=还原进入编辑前的值。
  // 整表 contenteditable 下点击单元格焦点常落在 <table>（嵌套编辑宿主）——target 不是
  // td[data-r]，用 selection 锚点兜底定位真实单元格
  grid?.addEventListener('keydown', e => {
    let td = e.target.closest?.('[contenteditable="true"][data-r]');
    if (!td && e.target === grid) {
      td = document.getSelection()?.anchorNode?.parentElement
        ?.closest?.('[contenteditable="true"][data-r]');
    }
    if (!td) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      td.textContent = _tbCellBefore(td) ?? td.textContent;   // 还原进入编辑时快照
      document.activeElement?.blur();   // blur 编辑宿主（table/td）——下一次 Esc 才关工作台
      _tbCmp.dirty = true;
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {   // isComposing：中文选词回车不下移
      e.preventDefault();
      focusCell(+td.dataset.r + 1, +td.dataset.c);           // 提交（contenteditable 已实时）并下移
    } else if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      focusCell(+td.dataset.r - 1, +td.dataset.c);
    }
  });
  // （右键监听在模块级 document 捕获段——见 _tbDocContextmenu）
  grid?.addEventListener('focusin', e => {                   // 进入编辑快照（Esc 还原用）
    // 点击设焦点的时序：focusin 可能先于 selection 更新——当场定位不到就
    // 下一拍重试（否则 _before 没存上，Esc 还原退化为无操作）
    const find = () => e.target.closest?.('[contenteditable="true"][data-r]') ||
      document.getSelection()?.anchorNode?.parentElement
        ?.closest?.('[contenteditable="true"][data-r]');
    const td = find();
    if (td) { td._before = td.textContent; _tbLastCell = [+td.dataset.r, +td.dataset.c]; }
    else setTimeout(() => { const t = find(); if (t) { t._before = t.textContent; _tbLastCell = [+t.dataset.r, +t.dataset.c]; } }, 0);
  });
  function _tbCellBefore(td) { return td._before; }
  function focusCell(r, c) {
    const next = grid.querySelector(`[contenteditable="true"][data-r="${Math.max(0, r)}"][data-c="${Math.max(0, c)}"]`);
    if (next) next.focus();
  }
}
window.tbCmpLayout = async mode => {
  await tbCmpAutoSave();          // 切布局重拉重渲——先保住未保存编辑（此前直接丢）
  _tbCmp.layout = mode;
  localStorage.setItem('ps-tbl-layout', mode);
  tbCmpRender();
};
window.tbCmpTab = async tab => { await tbCmpAutoSave(); _tbCompareTab = tab; tbCmpRender(); };
/* AI 页签问答框：按用户指令对当前表格内容 LLM 再生成（regen 端点直接落 ai_cells+done）。
   已整理表的底稿用 DOM 实时网格（未保存编辑也纳入）；未整理表由后端取原始提取。 */
window.tbAiAsk = async () => {
  const inp = $('#tb-ai-ask-inp');
  const instruction = (inp?.value || '').trim();
  if (!instruction) { toast('先输入整理指令'); inp?.focus(); return; }
  const btn = $('#tb-ai-ask-go'), note = $('#tb-ai-note');
  btn.disabled = true;
  if (note) note.textContent = '生成中…（几秒到几十秒，取决于表格大小）';
  try {
    const base = (window._tbGrid || []).length ? _tbCollectGrid() : undefined;
    if (base) _tbSnap();   // 重生成前的版本入撤销栈（↶ 可回到生成前；空态不入栈——底稿为空）
    const r = await api(`/api/tables/${_tbCmp.tid}/regen`,
      {method: 'POST', body: JSON.stringify({instruction, base_cells: base})});
    if (_tbCmp.detail?.id === _tbCmp.tid) {
      _tbCmp.detail.ai_cells = JSON.stringify(r.rows);   // 本地同步：页签角标/空态随重渲染消失
      _tbCmp.detail.ai_status = 'done';
    }
    toast((r.note ? r.note + ' · ' : '') + '已生成并保存', 3200);
    await tbCmpRender();
  } catch (e) {
    if (note) note.textContent = friendlyError(e, '生成失败');
    toast(friendlyError(e, '生成失败'));
  } finally { btn.disabled = false; }
};
window.tbCmpZoom = url => {
  const {pop, close} = openPop('tb-zoom-pop');
  window._tbZoomClose = () => { close(); window._tbZoomClose = null; };
  pop.innerHTML = `<img src="${url}" style="max-width:92vw;max-height:86vh;display:block;cursor:zoom-out"
    onclick="_tbZoomClose()">`;
};
async function tbCmpAutoSave() {
  if (!_tbCmp.dirty || !_tbCmp.tid) return;
  _tbCmp.dirty = false;
  const grid = _tbCollectGrid();
  try {
    await api(`/api/tables/${_tbCmp.tid}`, {method: 'PATCH', body: JSON.stringify({cells: grid})});
    if (_tbCmp.detail?.id === _tbCmp.tid) _tbCmp.detail.ai_cells = JSON.stringify(grid);   // 保存即整理：本地同步，「未整理」角标下次渲染消失
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
    const undoRv = rv === 'deleted' ? 'pending' : rv === 'kept' ? 'pending' : 'kept';
    toast(rv === 'deleted' ? '已剔除' : rv === 'kept' ? '已标记保留' : '已回待处理', 5000,
      {label: '撤销', onClick: async () => {
        try { await api(`/api/tables/${it.id}/review`, {method: 'POST', body: JSON.stringify({review: undoRv})}); it.review = undoRv; loadTables(); } catch {}
      }});
    if (rv === 'deleted' && _tbCmp.idx < _tbCmp.items.length - 1) await tbCmpNav(1);
    else await tbCmpRender();
  } catch (e) { toast(friendlyError(e, '操作失败')); }
};

function tbRenderGrid(grid) {
  const t = $('#tb-edit-grid');
  if (!t) return;
  // 首行（多级表头合并后的表头行）进 thead → 启用 .tbl-md 的表头吸顶（长表滚动时
  // 列名常驻）；✕ 删除列随之吸顶/吸附——删除按钮常驻可视是合理副产物
  const rowHtml = (row, r) => `
    <tr>${r === 0 ? `<th class="tb-rowop" data-r="${r}" contenteditable="false" title="删除此行（右键本行任意处可插入/移动）" onclick="tbGridDelRow(${r})">✕</th>` : `<td class="tb-rowop" data-r="${r}" contenteditable="false" title="删除此行（右键本行任意处可插入/移动）" onclick="tbGridDelRow(${r})">✕</td>`}
    ${row.map((v, c) => r === 0
      ? `<th class="tb-cel" data-r="${r}" data-c="${c}"><span contenteditable="true" data-r="${r}" data-c="${c}">${esc(v ?? '')}</span><b class="tb-col-x" title="删除此列（右键本列任意处可插入/移动/合并）" onclick="event.stopPropagation();tbGridDelCol(${c})">✕</b></th>`
      : `<td contenteditable="true" data-r="${r}" data-c="${c}">${esc(v ?? '')}</td>`).join('')}</tr>`;
  t.innerHTML = `<thead>${rowHtml(grid[0], 0)}</thead><tbody>${grid.slice(1).map((row, i) => rowHtml(row, i + 1)).join('')}</tbody>`;
}
function _tbCollectGrid() {
  // 从 DOM 读回（contenteditable 的实时文本；✕ 在 span 外不会混入）
  const grid = window._tbGrid.map(r => [...r]);
  document.querySelectorAll('#tb-edit-grid [contenteditable][data-r]').forEach(td => {
    grid[+td.dataset.r][+td.dataset.c] = (td.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  });
  return grid;
}
/* ---- 结构操作统一走：回读 DOM 编辑 → 快照入撤销栈 → 改网格 → 重渲 ----
   数据模型是纯二维数组（无 colspan/rowspan），「合并」= 内容并入相邻格 + 本格
   置空——与 xlsx 导出、LLM 行列数校验完全兼容，不动 schema。 */
/* 撤销/重做双栈（覆盖整个工作台内容面：结构操作 + AI 问答重生成 + 还原原始提取；
   单元格逐键编辑不进栈——实时文本本身可改，退一步即整版回退）。切换表格时双栈清零。 */
let _tbUndo = [], _tbRedo = [];
function _tbSnap() {
  _tbUndo.push(JSON.stringify(window._tbGrid));
  _tbRedo = [];   // 新动作截断重做分支（标准 undo 语义）
  if (_tbUndo.length > 50) _tbUndo.shift();
}
async function _tbApplyRows(rows, msg) {
  window._tbGrid = rows;
  _tbCmp.dirty = true;
  tbRenderGrid(rows);
  await tbCmpAutoSave();   // 撤销/重做同样落库——翻页/重开不丢
  tbCmpRefreshHead();      // 表头尺寸/状态徽章跟随网格刷新（此前只刷网格——来回切换时表头陈旧）
  toast(msg, 1600);
}
function tbCmpRefreshHead() {
  const dim = $('#tb-dim');
  if (dim) dim.textContent = `${window._tbGrid.length}×${window._tbGrid[0]?.length || 0}`;
  const bd = $('#tb-badge');
  const it = _tbCmp.items[_tbCmp.idx] || {};
  const aiSt = _tbCmp.detail?.ai_status ?? it.ai_status;
  if (bd) bd.innerHTML = tbStatusBadge(aiSt)
    + (it.review === 'kept' ? '<span class="badge ok">保留</span>' : '')
    + (it.review === 'deleted' ? '<span class="badge dim">已剔除</span>' : '');
}
window.tbGridUndo = () => {
  if (!_tbUndo.length) { toast('没有可撤销的操作'); return; }
  const rows = JSON.parse(_tbUndo.at(-1));
  if (!rows.length) { toast('已是最早状态'); _tbUndo = []; return; }
  _tbRedo.push(JSON.stringify(window._tbGrid));
  void _tbApplyRows(JSON.parse(_tbUndo.pop()), '已撤销');
};
window.tbGridRedo = () => {
  if (!_tbRedo.length) { toast('没有可重做的操作'); return; }
  _tbUndo.push(JSON.stringify(window._tbGrid));
  void _tbApplyRows(JSON.parse(_tbRedo.pop()), '已重做');
};
/* 一键还原原始提取：工作副本重置为 cells（AI 处理前的原表），可再撤销 */
window.tbResetOrig = async () => {
  const orig = (() => { try { return JSON.parse(_tbCmp.detail?.cells || '[]'); } catch { return []; } })();
  if (!orig.length) { toast('原始提取为空'); return; }
  _tbSnap();
  await _tbApplyRows(orig, '已还原为原始提取（可再编辑或重新生成）');
};

window.tbGridDelRow = r => {
  window._tbGrid = _tbCollectGrid();
  if (window._tbGrid.length <= 1) { toast('至少保留一行'); return; }
  _tbSnap();
  window._tbGrid.splice(r, 1);
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridDelCol = c => {
  window._tbGrid = _tbCollectGrid();
  if ((window._tbGrid[0] || []).length <= 1) { toast('至少保留一列'); return; }
  _tbSnap();
  window._tbGrid.forEach(row => row.splice(c, 1));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridAddRow = () => {
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  const w = (window._tbGrid[0] || []).length;
  window._tbGrid.push(Array(w).fill(null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbGridAddCol = () => {
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  window._tbGrid.forEach(row => row.push(null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};

/* ---- 右键菜单新增操作：指定位置插入 / 移动 / 合并内容 / 填充 / 清空 ---- */
window.tbInsRow = (r, above) => {
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  const w = (window._tbGrid[0] || []).length;
  window._tbGrid.splice(above ? r : r + 1, 0, Array(w).fill(null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbInsCol = (c, left) => {
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  window._tbGrid.forEach(row => row.splice(left ? c : c + 1, 0, null));
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbMoveRow = (r, d) => {
  const j = r + d;
  if (r === 0 || j < 1 || j >= window._tbGrid.length) return;   // 表头行不参与移动
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  [window._tbGrid[r], window._tbGrid[j]] = [window._tbGrid[j], window._tbGrid[r]];
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbMoveCol = (c, d) => {
  const j = c + d;
  if (j < 0 || j >= (window._tbGrid[0] || []).length) return;
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  window._tbGrid.forEach(row => { [row[c], row[j]] = [row[j], row[c]]; });
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
const _joinCell = (a, b) =>
  [a, b].map(v => (v ?? '').toString().trim()).filter(Boolean).join(' ') || null;
window.tbMergeLeft = (r, c) => {
  if (c === 0) return;
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  const g = window._tbGrid;
  g[r][c - 1] = _joinCell(g[r][c - 1], g[r][c]);
  g[r][c] = null;
  _tbCmp.dirty = true;
  tbRenderGrid(g);
};
window.tbMergeUp = (r, c) => {
  if (r === 0) return;
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  const g = window._tbGrid;
  g[r - 1][c] = _joinCell(g[r - 1][c], g[r][c]);
  g[r][c] = null;
  _tbCmp.dirty = true;
  tbRenderGrid(g);
};
window.tbFillAbove = (r, c) => {
  if (r === 0) return;
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  window._tbGrid[r][c] = window._tbGrid[r - 1][c];
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};
window.tbClearCell = (r, c) => {
  window._tbGrid = _tbCollectGrid();
  _tbSnap();
  window._tbGrid[r][c] = null;
  _tbCmp.dirty = true;
  tbRenderGrid(window._tbGrid);
};

/* ---- 单元格右键菜单（Excel/Notion 惯例）：合并/插入/移动/清空 ----
   监听挂 document 捕获级（注册一次，不随工作台重渲反复挂）：捕获相位先于一切
   内层处理，任何 stopPropagation/焦点时序都抢不走；未命中网格区域则放行原生菜单。
   另有工具栏 ⚙ 备用入口（_tbLastCell）——不依赖右键，浏览器差异/扩展拦截时可用。 */
let _tbCellPop = null;
let _tbLastCell = [0, 0];
const _tbDocContextmenu = e => {
  if (!_tbCmpPop?.pop?.isConnected) return;
  const grid = document.querySelector('#tb-edit-grid');
  if (!grid || !grid.contains(e.target)) return;
  const td = e.target.closest?.('[data-r]') || e.target.querySelector?.('[data-r]') ||
    document.getSelection()?.anchorNode?.parentElement?.closest?.('[data-r]');
  if (td) { e.preventDefault(); e.stopPropagation(); tbCellMenu(e, +td.dataset.r, +(td.dataset.c ?? 0)); }
};
document.addEventListener('contextmenu', _tbDocContextmenu, true);
function _tbCellPopClose() { _tbCellPop?.remove(); _tbCellPop = null; }
window._tbCellPopClose = _tbCellPopClose;   // 右键菜单条目内联 onclick 引用（模块作用域）
window.tbCellMenuAtBtn = btn => {           // 右键失效时的保底入口：对最后所在格弹同款菜单
  const [r, c] = _tbLastCell || [0, 0];
  const rect = btn.getBoundingClientRect();
  tbCellMenu({preventDefault(){}, stopPropagation(){}, clientX: rect.left, clientY: rect.top - 8}, r, c);
};
window.tbCellMenu = (ev, r, c) => {
  ev.preventDefault();
  ev.stopPropagation();
  _tbCellPopClose();
  const pop = Object.assign(document.createElement('div'), {className: 'tool-pop tb-cellmenu'});
  const item = (label, fn, dis) => dis ? '' :
    `<div class="tp-item" onclick="${fn};_tbCellPopClose()">${label}</div>`;
  const cols = (window._tbGrid[0] || []).length;
  pop.innerHTML = [
    item('合并到左侧', `tbMergeLeft(${r},${c})`, c === 0),
    item('合并到上方', `tbMergeUp(${r},${c})`, r === 0),
    item('填入上格值', `tbFillAbove(${r},${c})`, r === 0),
    item('清空本格', `tbClearCell(${r},${c})`),
    '<div class="tp-sep"></div>',
    item('上方插入行', `tbInsRow(${r},true)`),
    item('下方插入行', `tbInsRow(${r},false)`),
    item('删除本行', `tbGridDelRow(${r})`, window._tbGrid.length <= 1),
    item('本行上移', `tbMoveRow(${r},-1)`, r === 0),
    item('本行下移', `tbMoveRow(${r},1)`, r === 0 || r >= window._tbGrid.length - 1),
    '<div class="tp-sep"></div>',
    item('左侧插入列', `tbInsCol(${c},true)`),
    item('右侧插入列', `tbInsCol(${c},false)`),
    item('删除本列', `tbGridDelCol(${c})`, cols <= 1),
    item('本列左移', `tbMoveCol(${c},-1)`, c === 0),
    item('本列右移', `tbMoveCol(${c},1)`, c >= cols - 1),
  ].join('');
  document.body.appendChild(pop);
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(ev.clientX, innerWidth - rect.width - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(ev.clientY, innerHeight - rect.height - 8)) + 'px';
  _tbCellPop = pop;
  document.addEventListener('mousedown', e => {
    if (!pop.contains(e.target)) _tbCellPopClose();
  }, {once: true});
};
window.tbGridSave = async (tid, btn) => {
  const grid = _tbCollectGrid();
  _tbCmp.dirty = false;
  await withBusy(btn, async () => {
    const r = await api(`/api/tables/${tid}`, {method: 'PATCH', body: JSON.stringify({cells: grid})});
    toast(`已保存（${r.rows} 行 × ${r.cols} 列）——导出 xlsx 用这份整理版`);
  }, '保存失败');
};

/* ---------- 上传解析 → 自动收集 → 自动整理（一条链） ---------- */
window._tbUpClose = () => { document.querySelectorAll('.ui-backdrop').forEach(x => x.remove()); _tbCollectPop = null; };
window.tbUploadOpen = () => tbCollectOpen('upload');   // 兼容旧入口
window._tbUpClose = () => { _tbCollectPop?.close(); _tbCollectPop = null; };

function _tbUploadBody(box) {
  // 目标库选项（与追踪页「收进目标库」同源）：先渲染骨架，库名列表异步填充
  box.innerHTML = `
  <div class="tk-grid2">
    <label class="tk-fld">放入文献库
      <select id="tb-up-coll"><option value="">默认文献库</option></select></label>
    <label class="tk-fld">选择文件（可多选 PDF/图片/Office）
      <input id="tb-up-files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.ppt,.pptx,.xls,.xlsx"></label>
  </div>
  <label class="tk-inline" style="margin-top:8px">
    <input type="checkbox" id="tb-up-tidy" ${localStorage.getItem('ps-tbl-uptidy') !== '0' ? 'checked' : ''} onchange="localStorage.setItem('ps-tbl-uptidy', this.checked?'1':'0')"> 解析完成后自动收集并 AI 整理（走月预算闸）</label>
  <div id="tb-up-status" style="margin-top:10px;font-size:var(--fs-sm)"></div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <button class="btn primary" onclick="tbUploadGo(this)">上传并跟踪</button>
  </div>`;
  fetch('/api/collections').then(r => r.json()).then(d => {
    const opts = [...(d.collections || []),
      ...((d.shared_libs || []).map(x => ({...x, name: `${x.name}（${x.owner || '他人'} 共享）`}))),
      ...((d.group_libs || []).map(x => ({...x, name: `${x.name} · ${x.group_name}`})))];
    const sel = box.querySelector('#tb-up-coll');
    if (!sel) return;
    sel.innerHTML = `<option value="">默认文献库</option>` + opts.map(o =>
      `<option value="${o.id}" ${o.id === (state._tbUpColl || '') ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  }).catch(() => {});
}


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
        // P7：statuses 的 parse_job 已带 done/total——解析中显示真实 x/y（此前只显示状态字）
        const pj = x.parse_job || {};
        return {pid, ps,
                label: {pending: '排队中…', parsing: `解析中${pj.total > 1 ? ` ${pj.done}/${pj.total}` : '…'}`,
                        parsed: '✓ 完成', failed: '✗ 失败', skipped: '跳过'}[ps] || ps,
                bar: ps === 'parsing' ? (pj.total > 1
                  ? progressBar(Math.round(100 * (pj.done || 0) / pj.total), false, 'up-bar parse')
                  : progressIndet('up-bar indet parse')) : ''};
      });
      const done = rows.filter(r => ['parsed', 'failed', 'skipped'].includes(r.ps));
      st.innerHTML = `等待解析（${done.length}/${ids.length}）——完成后自动收表${autoTidy ? '并整理' : ''}<div class="tb-up-list">${
        rows.map(r => `<div class="${r.ps === 'parsed' ? 'ok' : r.ps === 'failed' ? 'err' : 'muted'}">${esc(r.label)} · ${esc(names[r.pid] || r.pid.slice(0, 10))}${r.bar}</div>`).join('')}</div>`;
      if (done.length === ids.length) break;
    } catch { /* 网络抖动下轮再试 */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  // 全部到达终态 → 收表（失败/跳过的自然被 harvest 的 parsed 过滤排除）
  const okIds = ids;   // harvest 只收 parsed
  try {
    const h = await api('/api/tables/harvest', {method: 'POST', body: JSON.stringify({paper_ids: okIds, auto_tidy: !!autoTidy, from_upload: true})});
    st.insertAdjacentHTML('beforeend',
      `<div style="margin-top:6px;color:var(--primary)">收集完成：${h.found} 张（新收 ${h.inserted}）${h.job_id ? '，整理已排队' : ''}</div>`);
    const collName = $('#tb-up-coll')?.selectedOptions?.[0]?.text || '默认文献库';
    toast(`新一批「${h.batch || '批次'}」就绪：论文已入「${collName}」，收进 ${h.inserted} 张表${autoTidy ? '，AI 整理进行中' : ''}`, 6000);

    setTimeout(() => { window._tbUpClose?.(); loadTables(); }, 1200);
  } catch (e) {
    st.insertAdjacentHTML('beforeend', `<div style="color:var(--err)">收集失败：${esc(friendlyError(e))}——稍后用「收表」手动圈这批论文</div>`);
  }
}

