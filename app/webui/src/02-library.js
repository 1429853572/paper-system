/* ===== 02-library.js —— 文献库与侧栏：集合树/论文列表/上传导入/筛选 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
async function loadCollections(preset = null) {
  const d = preset || await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  state.unassignedCount = d.unassigned || 0;   // 未归类（含失效引用）——侧栏数字自洽
  state.sharedLibs = d.shared_libs || [];     // 他人库中的共享论文
  renderCollections();
}
function colDescendants(cid) {   // 不含自身的子孙 id（真身 libDescendants 在 11-libmgr，拼接同作用域）
  return libDescendants(cid).filter(id => id !== cid);
}
function renderCollections() {
  const el = $('#collections');
  if (!el) return;
  const colState = JSON.parse(localStorage.getItem('ps-col-open') || '{}');
  const nodes = state.collections;
  const children = {};
  nodes.forEach(c => (children[c.parent_id || 'root'] ||= []).push(c));
  const row = (c, depth) => {
    const kids = children[c.id] || [];
    // 库树默认收起（有子库的才可展开）；用户手动展开过则记忆
    const open = colState[c.id] === true;
    const selected = state.currentCollection === c.id;
    const desc = colDescendants(c.id);
    const active = selected || desc.includes(state.currentCollection);
    return `<div class="col-item ${active ? 'on' : ''}" data-id="${c.id}" style="padding-left:${8 + depth * 14}px">
      ${kids.length ? `<span class="col-arrow" data-toggle="${c.id}">${open ? icon('chevD') : icon('chevR')}</span>` : '<span class="col-arrow-none"></span>'}
      <span class="col-name">${icon('folder')} ${esc(c.name)}</span>
      <span class="col-count">${c.papers_total ?? c.papers ?? 0}</span>
      <button class="col-del" title="删除文献库">${icon('close')}</button>
    </div>` + (kids.length && open ? kids.map(k => row(k, depth + 1)).join('') : '');
  };
  const roots = children['root'] || [];
  const allOpen = roots.some(r => colState[r.id] === true);
  const unassigned = state.unassignedCount ?? 0;
  const sharedLibs = state.sharedLibs || [];
  el.innerHTML =
    `<div class="col-item ${state.currentCollection === '' ? 'on' : ''}" data-id="">
      <span class="col-arrow-none"></span><span class="col-name">${icon('library')} 全部文献</span>
      <span class="col-count">${state.totalPapers ?? 0}</span>
    </div>` +
    roots.map(r => row(r, 0)).join('') +
    // 未归类 / 他人共享库：让「总数 = 各行相加」自洽（否则读者以为论文丢了）
    (unassigned ? `<div class="col-item ${state.currentCollection === 'none' ? 'on' : ''}" data-id="none">
      <span class="col-arrow-none"></span><span class="col-name">${icon('inbox')} 未归类</span>
      <span class="col-count">${unassigned}</span></div>` : '') +
    sharedLibs.map(l => `<div class="col-item ${state.currentCollection === l.id ? 'on' : ''}" data-id="${l.id}">
      <span class="col-arrow-none"></span><span class="col-name">${icon('folder')} ${esc(l.name)} <span class="muted" style="font-size: var(--fs-xs)">${esc(l.owner || '')} 共享</span></span>
      <span class="col-count">${l.papers}</span></div>`).join('') +
    (state.groups || []).map(g => `
    <div class="col-item ${state.currentCollection === g.root_cid ? 'on' : ''}" data-id="${g.root_cid}" title="群组「${esc(g.name)}」· ${g.members_n} 位成员 · 点行筛选群组文献">
      <span class="col-arrow-none"></span>
      <span class="col-name">${icon('user')} ${esc(g.name)} <span class="muted" style="font-size: var(--fs-xs)">${g.members_n}人${g.role === 'owner' ? ' · 我管理' : ''}</span></span>
      <button class="group-mng" title="群组管理（成员/解散）" onclick="event.stopPropagation();tbGroupManage('${g.id}')">${icon('sliders')}</button>
      <span class="col-count">${g.papers}</span>
    </div>`).join('') +
    `<button class="col-new" id="col-group">${icon('user')} 群组</button>`;
  $$('.col-item', el).forEach(item => item.onclick = e => {
    if (e.target.closest?.('.col-del') || e.target.dataset.toggle) return;
    const id = item.dataset.id;
    // 文库页/表格页联动只对自己的库树生效——共享库/群组的 id 不在 collections 树里，
    // 塞给 selectLib/tbCollF 会渲染成空表；这类行走旧路径（筛侧栏列表）。
    const inTree = (state.collections || []).some(c => c.id === id);
    // 表格页上下文：库行点击分派为表格筛选（复用同一份库树，不重复渲染侧栏）
    if (state._page === 'tables' && inTree) { window.tbCollF(id); return; }
    // 文库页上下文：库行点击同步主区表格（P2 侧栏树 ↔ 主表格联动）
    if (state._page === 'collections' && inTree) { window.selectLib(id); return; }
    state.currentCollection = id;
    renderCollections(); loadPapers();
  });
  $$('.col-arrow', el).forEach(a => a.onclick = e => {
    e.stopPropagation();
    colState[a.dataset.toggle] = colState[a.dataset.toggle] === false ? true : false;
    localStorage.setItem('ps-col-open', JSON.stringify(colState));
    renderCollections();
  });
  $$('.col-del', el).forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const cid = e.target.closest('.col-item').dataset.id;
    const name = state.collections.find(c => c.id === cid)?.name || '';
    if (!(await uiConfirm(`删除文献库「${name}」？其子库一并删除；论文移出该库，不再属于任何库的论文进回收站（30 天内可恢复）`,
                           {title: '删除文献库', anchor: e.currentTarget}))) return;
    await api('/api/collections/' + cid, {method: 'DELETE'});
    if (state.currentCollection === cid) state.currentCollection = '';
    await refreshLib();
  });
  if (!$('#col-group')) return;   // 侧栏结构异常时保底（不中断 loadPapers 等后续逻辑）
  $('#col-group').onclick = () => openGroupEntryPop('create');
}
/* P4 群组入口合一：创建 / 加入（群组 ID）两 Tab 弹层，取代侧栏两个按钮+两份内联表单。
   isComposing：中文输入法选词回车不触发提交（web-quality-report D1，同 13-cmd.js 先例）。 */
window.openGroupEntryPop = (tab = 'create') => {
  const {pop, close} = openPop('group-entry-pop');
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('user')} 协作群组
    <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
  <div class="imp-tabs">
    <button type="button" class="chip-btn ${tab === 'create' ? 'on' : ''}" data-tab="create">${icon('plus', 12)} 创建群组</button>
    <button type="button" class="chip-btn ${tab === 'join' ? 'on' : ''}" data-tab="join">${icon('user', 12)} 加入群组</button>
  </div>
  <div class="imp-body" id="gp-entry-body" style="min-height:0"></div>`;
  pop.querySelector('[data-x]').onclick = () => close();
  const render = t => {
    pop.querySelectorAll('.imp-tabs .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    const body = pop.querySelector('#gp-entry-body');
    body.innerHTML = t === 'create'
      ? `<label class="imp-fld">群组名称（成员共享读写）
           <input id="gp-new-name" maxlength="50" placeholder="如：课题组 · GNN 研究">
           <button class="btn small primary" id="gp-new-ok" style="align-self:flex-start">创建</button></label>`
      : `<label class="imp-fld">群组 ID（向群主要，或用邀请链接）
           <input id="gp-join-id" maxlength="20" placeholder="粘贴群组 ID">
           <button class="btn small primary" id="gp-join-ok" style="align-self:flex-start">加入</button></label>`;
    if (t === 'create') {
      const go = async () => {
        const name = $('#gp-new-name').value.trim();
        if (!name) { toast('请输入名称'); return; }
        try {
          const d = await api('/api/groups', {method: 'POST', body: JSON.stringify({name})});
          state.currentCollection = d.root_collection;
          close(); await refreshLib();
          toast(`群组「${name}」已创建——点群组行尾 ⚙ 邀请成员`, 4500);
        } catch (e) { toast('创建失败: ' + e.message); }
      };
      body.querySelector('#gp-new-ok').onclick = go;
      body.querySelector('#gp-new-name').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
      body.querySelector('#gp-new-name').focus();
    } else {
      const go = async () => {
        const gid = $('#gp-join-id').value.trim();
        if (!gid) { toast('请输入群组 ID'); return; }
        try {
          const d = await api('/api/groups/join', {method: 'POST', body: JSON.stringify({gid})});
          state.currentCollection = '';
          close(); await refreshLib();
          toast(`已加入群组「${d.name}」`);
        } catch (e) { toast(friendlyError(e, '加入失败')); }
      };
      body.querySelector('#gp-join-ok').onclick = go;
      body.querySelector('#gp-join-id').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
      body.querySelector('#gp-join-id').focus();
    }
  };
  pop.querySelectorAll('.imp-tabs .chip-btn').forEach(b => b.onclick = () => render(b.dataset.tab));
  render(tab);
};
function treeDepth(cid) {
  let d = 0, cur = state.collections.find(c => c.id === cid);
  while (cur && cur.parent_id) { cur = state.collections.find(c => c.id === cur.parent_id); d++; }
  return d;
}

/* 库状态变更后的统一刷新入口。
   问题：改库的操作分散在多个页面，各刷各的 → 右侧「文库管理」更新了、
   左侧文库树/论文列表还是旧的（要手动点一下才对）。
   规则：凡是会改变"论文属于哪个库 / 库里有几篇 / 论文增删"的操作，
   结束时一律走 refreshLib()，三处视图同时刷新。
   collections 只拉一次，三处共用（refreshLib 传 preset 给 renderCollectionsPage）。 */
async function refreshLib() {
  const d = await api('/api/collections');
  state.groups = d.groups || [];            // 协作群组（侧栏群组区 + 管理弹层用）
  loadCollections(d);                       // 侧栏文库树（含各库计数）
  await loadPapers();                      // 侧栏论文列表
  const pg = $('#page-collections');
  if (pg && pg.style.display !== 'none') await renderCollectionsPage(d);   // 文库管理页
  // 解析/翻译进度水合（SSE 只覆盖在线期间的变更，刷新后从 statuses 补齐行内条）
  api('/api/statuses').then(s => {
    const pmap = {}, tmap = {};
    for (const [pid, st] of Object.entries(s.statuses || {})) {
      const pj = st.parse_job, tj = st.translate_job;
      if (pj && pj.status === 'running') pmap[pid] = {done: pj.done || 0, total: pj.total || 0};
      if (tj && tj.status === 'running') tmap[pid] = {done: tj.done || 0, total: tj.total || 0};
    }
    state.parseProg = pmap;
    state.translateProg = tmap;
    renderPapers();
  }).catch(() => {});
}

/* ---------------- 文库 ---------------- */
async function renderContentSearch() {
  const el = $('#paper-list');
  el.innerHTML = '<p class="muted" style="padding:14px">全文检索中…</p>';
  try {
    const d = await api('/api/search', {method: 'POST', body: JSON.stringify({query: state.q.trim(), top_k: 20})});
    if (!d.hits.length) { el.innerHTML = '<p class="muted" style="padding:14px">标题与全文均无匹配</p>'; return; }
    el.innerHTML = `<div style="padding:8px 14px" class="muted">${icon('search')} 全文命中 ${d.hits.length} 处（跨全部文库 · 不受当前库/筛选限制 · 清空搜索框返回列表）</div>` +
      d.hits.map(h => {
        const p = state.qaAllPapers?.find(x => x.id === h.paper_id) || state.papers.find(x => x.id === h.paper_id) || {};
        return `<div class="paper-item" data-id="${h.paper_id}" data-page="${h.page_index}">
          <div class="info"><div class="name">${esc(p.title || h.paper_id)}</div>
          <div class="meta">${icon('doc')} 第${h.page_index + 1}页</div>
          <div class="muted" style="font-size: var(--fs-xs);padding:2px 0">${esc(h.text.slice(0, 90))}</div></div></div>`;
      }).join('');
    $$('.paper-item', el).forEach(item => item.onclick = async () => {
      await openPaper(item.dataset.id);
      jumpEvidence(+item.dataset.page);
    });
  } catch (e) { el.innerHTML = `<p class="muted" style="padding:14px">检索失败: ${esc(e.message)}</p>`; }
}
async function loadPapers(append = false) {
  const scope = state.currentCollection
    ? [state.currentCollection, ...colDescendants(state.currentCollection)].join(',') : '';
  const page = append ? (state.papersPage || 1) + 1 : 1;
  const params = new URLSearchParams({q: state.q.trim(), collection_id: scope,
    status: state.filter, page, page_size: 200});
  const d = await api('/api/papers?' + params);
  let papers = d.papers;
  // 快捷范围（服务端筛不了的在前端过滤）
  if (state.scope === 'untranslated') {
    const st = state._statuses || {};
    papers = papers.filter(p => st[p.id]?.translate_job?.status !== 'done');
  } else if (state.scope === 'unread') {
    papers = papers.filter(p => !p.read_status);
  } else if (state.scope === 'private') {
    papers = papers.filter(p => p.visibility === 'private');
  }
  state.papers = append ? [...state.papers, ...papers] : papers;
  state.papersPage = page;
  state.papersHasMore = !!d.has_more;
  renderPapers();
}
function statusBadge(p) {  if (p.deleted_at) return '<span class="badge err">回收站</span>';
  // 解析中带 SSE 水合进度（比 parse_status 细）；其余状态统一走 parseBadge（全站唯一出口）
  if (p.parse_status === 'parsing') {
    const pr = (state.parseProg || {})[p.id];
    return `<span class="badge run">${pr && pr.total > 1 ? `解析中 ${pr.done}/${pr.total}` : '解析中…'}</span>`;
  }
  if (p.parse_status === 'skipped')
    return '<span class="badge dim" title="超页数上限未自动解析，可手动重解析">跳过</span>';
  return parseBadge(p);
}
function renderPapers() {
  const el = $('#paper-list');
  if (state.q && state.q.trim().length >= 2) { renderContentSearch(); return; }
  // 上传占位行（MinerU 式：上传中/失败可见，带真实百分比与重试）
  const ups = [...state.uploads.entries()].map(([name, u], idx) => u.phase === 'error' ? `
    <div class="paper-item uploading err">
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span class="badge err">失败</span>
          <span class="muted up-msg" title="${esc(u.msg || '')}">${esc((u.msg || '').slice(0, 36))}</span>
          ${/上限/.test(u.msg || '') ? '' : '<button class="up-act" data-idx="' + idx + '" data-act="retry">重试</button>'}
          <button class="up-act" data-idx="${idx}" data-act="drop">移除</button></div>
      </div>
    </div>` : `
    <div class="paper-item uploading">
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span class="up-pct">${u.phase === 'saving' ? '保存中…' : '上传中 ' + (u.pct || 0) + '%'}</span>
          ${progressBar(u.pct || 0)}</div>
      </div>
    </div>`).join('');
  if (!state.papers.length && !ups) {
    el.innerHTML = `<div class="empty-state">
      <p class="t">这里还没有论文</p>
      <p style="margin-bottom:14px">把 PDF 拖到这里，或从下方入口导入（也支持 DOI / arXiv / BibTeX）</p>
      <button class="btn primary" onclick="openImportPop('files')">${icon('upload')} 导入第一篇</button>
      <button class="btn" onclick="openImportPop('ident')">粘贴 DOI 导入</button>
    </div>`;
    return;
  }
  const listHtml = sortPapers(state.papers).map(p => {
    // 行内进度条（P7 统一进度条）：解析中 = x/y 实条或 0/1 不定长条；翻译中 = 块级实条或不定长条
    const pr = (state.parseProg || {})[p.id];
    const tr = (state.translateProg || {})[p.id];
    let bar = '';
    if (p.parse_status === 'parsing')
      bar += pr?.total > 1 ? progressBar(Math.round(100 * pr.done / pr.total), false, 'up-bar parse')
                           : progressIndet('up-bar indet parse');
    else if (p.parse_status === 'pending')
      bar += progressIndet('up-bar indet parse dim');   // 排队中也有条（灰色不定长）——不是死的
    else if (tr)
      bar += tr.total > 1 ? progressBar(Math.round(100 * tr.done / tr.total), false, 'up-bar')
                          : progressIndet('up-bar indet');
    return `
    <div class="paper-item ${state.current?.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      <div class="info">
        <div class="name">${esc(p.title || p.id)}</div>
        <div class="meta">${p.read_status ? '' : '<span class="unread-dot" title="未读"></span>'}${statusBadge(p)}
          ${p.visibility === 'private' ? '<span class="badge priv">私人</span>' : ''}
          ${p.owner_name && p.owner_id !== state.me?.id ? `<span class="muted" title="上传者">· ${esc(p.owner_name)}</span>` : ''}
          <span>${(p.page_count || '?')}页</span><span>${p.file_size ? (p.file_size/1048576).toFixed(1) + 'M' : ''}</span>
        </div>${bar}
      </div>
      <button class="pi-del" title="移入回收站">${icon('trash')}</button>
    </div>`;}).join('');
  el.innerHTML = ups + listHtml + (state.papersHasMore
    ? '<button class="qa-load-more" id="load-more">加载更多…</button>' : '');
  const lm = $('#load-more');
  if (lm) lm.onclick = () => loadPapers(true);
  $$('.paper-item', el).forEach(item => {
    const id = item.dataset.id;
    if (!id) return;   // 上传占位行无 paper id（由下方 up-act 接管）
    item.onclick = e => {
      if (e.target.closest?.('.pi-del')) { quickDelete(id, e.target.closest('.pi-del')); return; }   // closest：按钮内嵌 SVG 图标，e.target 常是 svg/path
      // 表格页上下文：论文行点击分派为筛选该论文的表格（再点取消）
      if (state._page === 'tables') { window.tbPaperF(id); return; }
      openPaper(id);   // 单击任意位置直接打开（批量选择在文库管理页）
    };
  });
  // 上传占位行：重试 / 移除
  $$('.up-act', el).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const entry = [...state.uploads.entries()][+b.dataset.idx];
    if (!entry) return;
    const [name, u] = entry;
    if (b.dataset.act === 'drop') { state.uploads.delete(name); renderPapers(); return; }
    state.uploads.delete(name);
    uploadFiles([u.file], u.cid);   // 重试保留原目标库
  });
}

/* ===== 导入文献弹层（P1 入口归一）：原侧栏 240px 窄弹层升级为居中三 Tab 弹层 =====
   文件（拖放区 + 全生命周期进度行：上传% → 解析排队 → 解析中 → 完成）/ 链接·标识符 / 服务器目录；
   公共底栏：目标库下拉 + 仅自己可见 + 解析过滤。列表拖放上传与占位行保留不动。 */
state.uploadPrivate = localStorage.getItem('ps-upload-private') === '1';
/* 429 预知与友好化：弹层打开即展示今日余量；「上限」类错误附重置说明、不渲染无效重试按钮 */
const quotaTip = msg => /上限/.test(msg || '') ? msg + '——明日 0 点重置，也可请管理员在设置页调整限额' : msg;
async function refreshQuotaHint() {
  const el = $('#quota-hint');
  if (!el) return;
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) { el.textContent = ''; return; }
  el.textContent = `今日解析 ${q.parse_used}/${q.parse_limit} 篇 · 磁盘 ${fmtGBs(q.disk_used_bytes)}/${q.disk_limit_gb} GB`;
}
let _importPop = null, _importPoll = null, _importTab = 'files', _importTarget = '';
/* 弹层内的目标库：下拉为唯一真值来源；弹层外（拖到列表）仍用当前侧栏选中库 */
const _importTargetOf = () => (_importPop ? ($('#imp-coll')?.value || null) : (state.currentCollection || null));
window.openImportPop = (tab = 'files', targetCid = '') => {
  _importPop?.close();          // beforeClose 已做清理（见下）
  _importTab = tab;
  _importTarget = targetCid || '';
  const {pop, close} = openPop('import-pop', {beforeClose: () => {
    clearInterval(_importPoll); _importPoll = null;
    state.impTrack = new Map();
    _importPop = null;
    return true;
  }});
  _importPop = {pop, close};
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('upload')} 导入文献
    <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
  <div class="imp-tabs" role="tablist">
    ${[['files', 'doc', '文件'], ['ident', 'key', '链接·标识符'], ['dir', 'folder', '服务器目录']].map(([id, ic, label]) =>
      `<button type="button" class="chip-btn ${tab === id ? 'on' : ''}" data-tab="${id}" role="tab" aria-selected="${tab === id}">${icon(ic, 12)} ${label}</button>`).join('')}
  </div>
  <div class="imp-quota muted" id="quota-hint"></div>
  <div class="imp-body" id="imp-body"></div>
  <div class="imp-foot">
    <label class="imp-coll">放入文献库
      <select id="imp-coll"><option value="">默认文献库</option></select></label>
    <label class="imp-vis"><input type="checkbox" id="upload-private" ${state.uploadPrivate ? 'checked' : ''}> 仅自己可见</label>
    <button type="button" class="btn small" id="pf-adv-toggle">⚙ 解析过滤<span class="muted" id="pf-adv-hint" style="font-size:var(--fs-xs);margin-left:4px"></span></button>
    <div id="pf-adv" hidden class="imp-pf">
      <label>页数上限 <input id="pf-max" type="number" min="0" max="2000" style="width:64px">（0=不限）</label>
      <label>排除文件名 <input id="pf-exclude" placeholder="supplement, /翻译/" style="flex:1"></label>
      <span class="muted" style="font-size:var(--fs-xs)">逗号分隔子串或 /正则/；超页数入库但不自动解析，可手动重解析</span>
    </div>
  </div>`;
  pop.querySelector('[data-x]').onclick = () => _importPop?.close();
  pop.querySelectorAll('.imp-tabs .chip-btn').forEach(b => b.onclick = () => {
    _importTab = b.dataset.tab;
    pop.querySelectorAll('.imp-tabs .chip-btn').forEach(x => {
      x.classList.toggle('on', x.dataset.tab === _importTab);
      x.setAttribute('aria-selected', x.dataset.tab === _importTab);
    });
    _renderImportBody();
  });
  pop.querySelector('#upload-private').onchange = e => {
    state.uploadPrivate = e.target.checked;
    localStorage.setItem('ps-upload-private', state.uploadPrivate ? '1' : '0');
    toast(state.uploadPrivate ? '新上传的文献将仅自己可见' : '新上传的文献将对所有人可见');
  };
  pop.querySelector('#pf-adv-toggle').onclick = () => {
    const adv = pop.querySelector('#pf-adv');
    if (adv) adv.hidden = !adv.hidden;
  };
  const pfMax = pop.querySelector('#pf-max'), pfEx = pop.querySelector('#pf-exclude');
  if (pfMax) pfMax.onchange = saveParseFilter;
  if (pfEx) pfEx.onchange = saveParseFilter;
  // 目标库选项（与表格工作台上传同源）：库名列表异步填充
  fetch('/api/collections').then(r => r.json()).then(d => {
    const opts = [...(d.collections || []),
      ...((d.shared_libs || []).map(x => ({...x, name: `${x.name}（${x.owner || '他人'} 共享）`}))),
      ...((d.group_libs || []).map(x => ({...x, name: `${x.name} · ${x.group_name}`})))];
    const sel = pop.querySelector('#imp-coll');
    if (!sel) return;
    const want = _importTarget || state.currentCollection || '';
    sel.innerHTML = `<option value="">默认文献库</option>` + opts.map(o =>
      `<option value="${o.id}" ${o.id === want ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  }).catch(() => {});
  loadParseFilter();
  refreshQuotaHint();
  _renderImportBody();
};
window.closeImportPop = () => _importPop?.close();
const _renderImportBody = () => {
  if (!_importPop) return;
  const box = $('#imp-body');
  if (!box) return;
  box.innerHTML = '';
  (_importTab === 'files' ? _impFilesBody : _importTab === 'ident' ? _impIdentBody : _impDirBody)(box);
};
/* 文件 Tab：拖放区 + 生命周期进度行（上传% → 解析排队/解析中 → ✓/✗） */
const _impFilesBody = box => {
  box.innerHTML = `
  <div class="imp-drop" id="imp-drop" tabindex="0" role="button" aria-label="选择或拖入文件">
    ${icon('upload', 26)}
    <div class="t">点击选择，或将文件拖到这里</div>
    <div class="muted" style="font-size:var(--fs-xs)">支持 PDF / 图片 / Word / PPT / Excel，可多选；也支持直接拖到左侧论文列表</div>
  </div>
  <div class="imp-rows" id="imp-rows"></div>`;
  const drop = box.querySelector('#imp-drop');
  drop.onclick = () => $('#file-input').click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } };
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => uploadFiles(e.dataTransfer.files, _importTargetOf() || undefined));
  renderImportRows();
};
/* 链接·标识符 Tab：URL 直链 + DOI/arXiv/BibTeX */
const _impIdentBody = box => {
  box.innerHTML = `
  <label class="imp-fld">网页 URL（PDF / arXiv 直链）
    <span class="imp-inline"><input id="url-import-input" placeholder="https://…  或  https://arxiv.org/abs/…"><button class="btn small primary" id="url-import-btn">导入 URL</button></span></label>
  <label class="imp-fld">DOI / arXiv ID / BibTeX（可多条，自动抓元数据 + OA PDF）
    <textarea id="ident-input" rows="5" placeholder="10.xxxx/xxxxx&#10;arXiv:2401.12345&#10;@article{…}"></textarea>
    <button class="btn small" id="ident-btn" style="align-self:flex-start">导入 ID</button></label>`;
  box.querySelector('#url-import-btn').onclick = urlImportGo;
  box.querySelector('#url-import-input').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) $('#url-import-btn').click(); };
  box.querySelector('#ident-btn').onclick = identImportGo;
  box.querySelector('#ident-input').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) $('#ident-btn').click(); };
};
/* 服务器目录 Tab：data/inbox/ 下子目录批量入库（CAJ/KDH 自动转 PDF） */
const _impDirBody = box => {
  box.innerHTML = `
  <label class="imp-fld">选择目录
    <span class="imp-inline"><select id="dir-select" style="flex:1"><option value="">从服务器目录导入…</option></select>
    <button class="btn small ic-only" id="dir-refresh" title="重新扫描 data/inbox/ 目录列表">${icon('retry')}</button></span></label>
  <button class="btn small" id="dir-btn" style="align-self:flex-start">${icon('folder')} 目录导入</button>
  <p class="muted" style="font-size:var(--fs-xs)">把知网等下载器输出的文件放进服务器 <code style="user-select:all">data/inbox/&lt;目录&gt;/</code> 后点 ⟳ 刷新；入库与解析进度见「任务中心」。</p>`;
  loadImportDirs();
  box.querySelector('#dir-btn').onclick = dirImportGo;
  box.querySelector('#dir-refresh').onclick = () => loadImportDirs();
};
/* 弹层内进度行：上半 = 正在上传的（uploads Map），下半 = 已入库跟踪解析的（impTrack）。
   impTrack 由 uploadFiles 成功入库时登记，解析进度经 4s 轮询 /api/statuses 推进（P7）。 */
function renderImportRows() {
  if (!_importPop) return;
  const box = $('#imp-rows');
  if (!box) return;
  const rows = [];
  for (const [name, u] of state.uploads.entries()) {
    rows.push(u.phase === 'error'
      ? `<div class="imp-row err"><div class="n">${esc(name)}</div>
           <div class="s"><span class="badge err">失败</span>
           <span class="muted" style="font-size:var(--fs-xs)" title="${esc(u.msg || '')}">${esc((u.msg || '').slice(0, 40))}</span></div></div>`
      : `<div class="imp-row"><div class="n">${esc(name)}</div>
           <div class="s"><span class="up-pct">${u.phase === 'saving' ? '保存中…' : '上传中 ' + (u.pct || 0) + '%'}</span>
           ${progressBar(u.pct || 0)}</div></div>`);
  }
  for (const [name, t] of (state.impTrack || new Map()).entries()) {
    if (t.status === 'parsed')
      rows.push(`<div class="imp-row ok"><div class="n">${esc(name)}</div>
        <div class="s"><span class="badge ok">✓ 已完成</span><button class="up-act" data-open="${t.paper_id}">阅读</button></div></div>`);
    else if (t.status === 'failed')
      rows.push(`<div class="imp-row err"><div class="n">${esc(name)}</div>
        <div class="s"><span class="badge err">解析失败</span><span class="muted" style="font-size:var(--fs-xs)">详情见任务中心</span></div></div>`);
    else if (t.status === 'skipped')
      rows.push(`<div class="imp-row ok"><div class="n">${esc(name)}</div>
        <div class="s"><span class="badge dim">已入库（超页数上限未解析）</span></div></div>`);
    else {
      const pr = (state.parseProg || {})[t.paper_id] || {};
      const xy = pr.total > 1;
      rows.push(`<div class="imp-row"><div class="n">${esc(name)}</div>
        <div class="s"><span class="up-pct">${t.status === 'parsing' ? (xy ? `解析中 ${pr.done}/${pr.total}` : '解析中…') : '已入库 · 解析排队'}</span>
        ${t.status === 'parsing' && xy ? progressBar(Math.round(100 * pr.done / pr.total), false, 'up-bar parse')
                                       : progressIndet('up-bar indet' + (t.status === 'parsing' ? '' : ' dim'))}</div></div>`);
    }
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const pid = b.dataset.open;
    closeImportPop();
    openPaper(pid);
  });
}
/* 弹层打开期间的解析进度轮询（tbTrackParse 同款模式，关弹层自动清掉） */
function startImportPoll() {
  if (_importPoll) return;
  _importPoll = setInterval(async () => {
    if (!_importPop) { clearInterval(_importPoll); _importPoll = null; return; }
    const ids = [...(state.impTrack || [])]
      .filter(([, t]) => !['parsed', 'failed', 'skipped'].includes(t.status)).map(([, t]) => t.paper_id);
    if (!ids.length) return;
    try {
      const d = await api('/api/statuses?paper_ids=' + ids.join(','));
      for (const [, t] of (state.impTrack || new Map()).entries()) {
        const s = d.statuses?.[t.paper_id];
        if (!s) continue;
        t.status = s.parse_status;
        if (s.parse_status === 'parsing' && s.parse_job) {
          state.parseProg ||= {};
          state.parseProg[t.paper_id] = {done: s.parse_job.done || 0, total: s.parse_job.total || 0};
        }
      }
      renderImportRows();
    } catch { /* ignore */ }
  }, 4000);
}
$('#upload-arrow')?.addEventListener('click', () => openImportPop());
$('#file-input').onchange = e => {
  uploadFiles(e.target.files, _importPop ? (_importTargetOf() || undefined) : undefined);
  e.target.value = '';
};
async function urlImportGo() {
  const url = $('#url-import-input').value.trim();
  if (!url) { toast('请输入 URL'); return; }
  try {
    const r = await api('/api/papers/import-url', {method: 'POST', body: JSON.stringify({
      url, visibility: state.uploadPrivate ? 'private' : 'shared',
      collection_id: _importTargetOf() || undefined})});
    toast(r.status === 'duplicate' ? (r.linked ? '该 URL 已在库中——已挂进当前文献库' : '该 URL 已在库中') : '已加入解析队列');
    $('#url-import-input').value = '';
    closeImportPop();
    await refreshLib();
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
}
/* 标识符导入（zotero-mcp 式）：DOI / arXiv ID / BibTeX → 元数据 + OA PDF */
async function identImportGo() {
  const ta = $('#ident-input');
  const text = ta.value.trim();
  if (!text) { toast('先粘贴 DOI / arXiv ID 或 BibTeX'); return; }
  const btn = $('#ident-btn');
  btn.disabled = true; btn.textContent = '解析中…';
  try {
    const d = await api('/api/papers/import-identifier', {method: 'POST', body: JSON.stringify({
      text, visibility: state.uploadPrivate ? 'private' : 'shared',
      collection_id: _importTargetOf()})});
    const q = d.results.filter(x => x.status === 'queued').length;
    const dup = d.results.filter(x => x.status === 'duplicate').length;
    const nopdf = d.results.filter(x => x.status === 'no_pdf').length;
    const nf = d.results.filter(x => x.status === 'not_found').length;
    let msg = q ? `已导入 ${q} 篇并开始解析` : '没有可导入的条目';
    if (dup) msg += `，${dup} 篇已在库——已挂进当前库`;
    if (nopdf) msg += `，${nopdf} 篇无公开 PDF`;
    if (nf) msg += `，${nf} 条未识别`;
    toast(msg, 4000);
    if (q) { ta.value = ''; closeImportPop(); await loadCollections(); await refreshLib(); }
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.textContent = '导入 ID';
}
/* 目录批量入库：inbox/ 下子目录 → 扫描入库（CAJ 自动转 PDF），进度见任务中心 */
async function loadImportDirs() {
  try {
    const d = await api('/api/import-dirs');
    const sel = $('#dir-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">从服务器目录导入…</option>' +
      (d.dirs.length ? d.dirs.map(x =>
        `<option value="${esc(x.path)}">${esc(x.name)}（${x.files} 个文件）</option>`).join('')
        : '<option value="" disabled>inbox/ 下暂无目录</option>');
    if (cur) sel.value = cur;
  } catch { /* ignore */ }
}
async function dirImportGo() {
  const path = $('#dir-select').value;
  if (!path) { toast('先选择要导入的目录'); return; }
  const btn = $('#dir-btn');
  btn.disabled = true; btn.textContent = '扫描中…';
  try {
    const d = await api('/api/import-directory', {method: 'POST',
      body: JSON.stringify({path, collection_id: _importTargetOf(),
                            visibility: state.uploadPrivate ? 'private' : 'shared'})});
    const q = d.queued.length, sk = d.skipped.length;
    toast(`已入库 ${q} 篇${sk ? `，跳过 ${sk} 个` : ''}——解析进度见「任务中心」`, 4000);
    if (sk) {
      const reasons = d.skipped.slice(0, 3).map(x => `${x.file}: ${x.reason}`).join('；');
      await uiConfirm(`以下文件未能入库：<br>${esc(reasons)}${sk > 3 ? `<br>…共 ${sk} 个` : ''}`,
                      {title: '跳过明细', okText: '知道了', hideCancel: true, html: true});
    }
    closeImportPop();
    await loadImportDirs();
    await refreshLib();
  } catch (e) { toast(quotaTip('目录导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.innerHTML = icon('folder') + ' 目录导入';
}
/* 解析过滤器（llm4z 式：页数上限 + 文件名排除；服务端上传时执行，设置跟随账号） */
async function loadParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter');
    const max = $('#pf-max'), ex = $('#pf-exclude'), hint = $('#pf-adv-hint');
    if (!max) return;
    max.value = d.max_pages || 0;
    ex.value = d.exclude || '';
    hint.textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
  } catch { /* ignore */ }
}
async function saveParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter', {method: 'PUT', body: JSON.stringify({
      max_pages: +$('#pf-max').value || 0, exclude: $('#pf-exclude').value.trim()})});
    $('#pf-adv-hint').textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
    toast('解析过滤规则已保存');
  } catch (e) { toast('保存失败: ' + e.message); }
}
// 论文列表区 = 拖放上传目标
const plist = $('#paper-list');
['dragover', 'dragenter'].forEach(ev => plist.addEventListener(ev, e => {
  e.preventDefault(); plist.classList.add('drop-hint');
}));
['dragleave', 'drop'].forEach(ev => plist.addEventListener(ev, e => {
  e.preventDefault(); plist.classList.remove('drop-hint');
}));
plist.addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
async function uploadFiles(files, targetCid) {
  const okFile = f => /\.(pdf|png|jpe?g|docx?|pptx?|xlsx?)$/i.test(f.name);
  const pdfs = [...files].filter(okFile);
  if (!pdfs.length) { toast('支持 PDF / 图片 / Office 文档'); return; }
  try {   // 磁盘软提醒：超上限警告但不拦截（展示口径，硬拦在 max_file_mb/页数过滤）
    const q = await api('/api/me/quota');
    const usedGb = fmtGB(q.disk_used_bytes);
    if (q.disk_limit_gb && usedGb >= q.disk_limit_gb)
      toast(`磁盘已用 ${usedGb.toFixed(1)}GB，已达上限 ${q.disk_limit_gb}GB——建议清理回收站或联系管理员`, 5000);
  } catch { /* ignore */ }
  const vis = state.uploadPrivate ? 'private' : 'shared';
  const col = (targetCid || state.currentCollection) ? `&collection_id=${targetCid || state.currentCollection}` : '';
  const cid = targetCid || state.currentCollection || '';
  // MinerU 式体验：逐文件上传，上传即在列表顶部显示占位行（真实百分比），
  // 服务端入库后被真实条目替换（状态随之变为 排队中 → 提取中 x/y）
  let okN = 0, dupN = 0, rejN = 0;
  for (const f of pdfs) {
    const up = {pct: 0, phase: 'uploading', msg: '', file: f, cid};
    state.uploads.set(f.name, up);
    renderPapers(); renderImportRows();
    try {
      const d = await new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('files', f);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/papers/upload?visibility=${vis}${col}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) { up.pct = Math.round(e.loaded / e.total * 100); renderPapers(); renderImportRows(); }
        };
        xhr.upload.onload = () => { up.phase = 'saving'; up.pct = 100; renderPapers(); renderImportRows(); };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.onload = () => {
          const body = xhr.response || {};
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.detail || `HTTP ${xhr.status}`));
        };
        xhr.send(fd);
      });
      const res = (d.results || [])[0] || {};
      if (res.status === 'rejected') { up.phase = 'error'; up.msg = res.reason || '被拒收'; rejN++; }
      else if (res.status === 'duplicate') {
        state.uploads.delete(f.name); dupN++;
        if (res.linked) { setTimeout(() => toast('该内容已在其他文献库——已同时放入当前文献库（同一份，不重复占用）'), 400); }
      }
      else if (res.status === 'skipped') {
        state.uploads.delete(f.name); okN++;
        (state.impTrack ||= new Map()).set(f.name, {paper_id: res.paper_id, status: 'skipped'});
        setTimeout(() => toast(`《${(res.name || '文件').slice(0, 30)}》已入库但超出解析页数上限，未排队解析（可手动重解析）`, 5000), 400);
      }
      else {
        state.uploads.delete(f.name); okN++;
        // 已入库 → 弹层内继续跟踪解析生命周期（列表侧由 SSE 驱动的 parseProg 接管）
        (state.impTrack ||= new Map()).set(f.name, {paper_id: res.paper_id, status: 'pending'});
        startImportPoll();
      }
      await refreshLib();
      renderImportRows();
      if (up.phase === 'error') renderPapers();
    } catch (e) {
      up.phase = 'error'; up.msg = e.message; rejN++; renderPapers(); renderImportRows();
    }
  }
  if (!rejN && !dupN) toast(`已排队 ${okN} 篇`);
  else {
    const bits = [];
    if (okN) bits.push(`已排队 ${okN} 篇`);
    if (dupN) bits.push(`去重跳过 ${dupN} 篇`);
    if (rejN) bits.push(`${rejN} 篇失败（列表中可重试）`);
    toast(bits.join('，'));
  }
}

/* 多选模式与批量操作 */
/* ---- 筛选（漏斗）与排序（并列图标）菜单 ---- */
/* 旧值迁移：private 此前是解析状态组的成员（前端过滤），并入「阅读范围」后口径统一 */
if (state.filter === 'private') {
  state.filter = '';
  state.scope = 'private';
  localStorage.setItem('ps-filter', '');
  localStorage.setItem('ps-scope', 'private');
}
const FILTERS = [['', '全部论文'], ['parsed', '已解析'], ['parsing', '解析中'],
                 ['failed', '解析失败'], ['skipped', '已跳过']];
const SCOPES = [['', '全部'], ['private', '仅我可见'], ['unread', '还没读'], ['untranslated', '还没翻译']];
const SORTS = [['recent', '最近添加'], ['title', '标题（拼音）'], ['pages', '页数从多到少'], ['size', '文件从大到小']];
function sortPapers(list) {
  const arr = [...list];
  const by = state.sortBy;
  if (by === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
  else if (by === 'pages') arr.sort((a, b) => (b.page_count || 0) - (a.page_count || 0));
  else if (by === 'size') arr.sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
  else arr.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return arr;
}
function markFilterMenu() {
  $$('#filter-pop .tp-item').forEach(it => {
    const on = it.dataset.f !== undefined ? it.dataset.f === state.filter
      : it.dataset.scope !== undefined ? it.dataset.scope === state.scope : false;
    it.classList.toggle('on', on);
  });
  $$('#sort-pop .tp-item').forEach(it => it.classList.toggle('on', it.dataset.s === state.sortBy));
  const arrow = $('#filter-arrow'), sarrow = $('#sort-arrow');
  if (arrow) {
    const parts = [];
    if (state.filter) parts.push(FILTERS.find(f => f[0] === state.filter)?.[1]);
    if (state.scope) parts.push(SCOPES.find(s => s[0] === state.scope)?.[1]);
    arrow.classList.toggle('has-val', parts.length > 0);
    arrow.title = parts.length ? `筛选中：${parts.join(' + ')}` : '筛选（解析状态 / 阅读范围）';
  }
  if (sarrow) {
    sarrow.classList.toggle('has-val', state.sortBy !== 'recent');
    sarrow.title = `排序：${SORTS.find(s => s[0] === state.sortBy)?.[1] || '最近添加'}`;
  }
}
$('#filter-arrow').onclick = e => {
  e.stopPropagation();
  $('#sort-pop').hidden = true;
  const pop = $('#filter-pop');
  pop.hidden = !pop.hidden;
  markFilterMenu();
};
$('#sort-arrow').onclick = e => {
  e.stopPropagation();
  $('#filter-pop').hidden = true;
  const pop = $('#sort-pop');
  pop.hidden = !pop.hidden;
  markFilterMenu();
};
$('#filter-pop').onclick = e => {
  const item = e.target.closest('.tp-item');
  if (!item) return;
  if (item.dataset.f !== undefined) {
    state.filter = item.dataset.f;
    localStorage.setItem('ps-filter', state.filter);
  } else if (item.dataset.scope !== undefined) {
    state.scope = state.scope === item.dataset.scope ? '' : item.dataset.scope;   // 再点取消
    localStorage.setItem('ps-scope', state.scope);
  }
  $('#filter-pop').hidden = true;
  markFilterMenu();
  loadPapers();
  if (state._page === 'tables') loadTables();   // 解析状态/阅读范围筛选 → 表格区同步收窄
};
$('#sort-pop').onclick = e => {
  const item = e.target.closest('.tp-item');
  if (!item?.dataset.s) return;
  state.sortBy = item.dataset.s;
  localStorage.setItem('ps-sort', state.sortBy);
  $('#sort-pop').hidden = true;
  markFilterMenu();
  loadPapers();
  if (state._page === 'tables') loadTables();   // 侧栏排序变化 → 表格卡片墙同键跟随（v1.12 合并后两侧一体）
};
outsideClose($('#filter-pop'), $('#filter-arrow'));
outsideClose($('#sort-pop'), $('#sort-arrow'));
markFilterMenu();

/* ---- 侧栏折叠 / 展开（MinerU 风格浮动箭头）---- */
state.sidebarCollapsed = localStorage.getItem('ps-sidebar-collapsed') === '1';
window.applySidebarCollapse = () => {
  const sb = $('.sidebar');
  // 任务/追踪两页自带工作区（或需要全宽）——主侧栏软收起；表格页已合并全局侧栏（不再软收起）；
  // 不写用户偏好（ps-sidebar-collapsed 不动），回阅读页自动恢复。
  // _softKeep：用户在软收起页里显式点过 » ——本次会话尊重其选择
  const soft = ['tasks', 'tracker'].includes(state._page || 'reader') && !state._softKeep;
  sb.classList.toggle('collapsed', state.sidebarCollapsed || soft);
  $('#side-rail').hidden = !(state.sidebarCollapsed || soft);
};
$('#side-collapse').onclick = () => {
  state.sidebarCollapsed = true;
  state._softKeep = false;
  localStorage.setItem('ps-sidebar-collapsed', '1');
  applySidebarCollapse();
};
$('#side-expand').onclick = () => {
  state.sidebarCollapsed = false;
  state._softKeep = true;   // 软收起页里显式展开：本次会话不再自动收
  localStorage.setItem('ps-sidebar-collapsed', '0');
  applySidebarCollapse();
};
applySidebarCollapse();
/* 初始即按视口宽收放（resize 监听只在变化时触发，窄窗口直开/刷新不会走 resize） */
if (innerWidth < 1100 && !state.sidebarCollapsed) {
  state._autoFolded = true; state.sidebarCollapsed = true; applySidebarCollapse();
}

/* 批量选择已收敛到「文库管理」页（勾选 → 完整批量条）与「批量中心」页；
   侧栏回归纯导航。state.selected 仍由文库页复选框维护（全站共享）。 */

/* 搜索（快捷范围 chips 已并入筛选弹层「阅读范围」组——v1.11.4 截图反馈） */
$('#lib-search').oninput = debounce(e => {   // 300ms 防抖：大库逐键触发全文检索会请求风暴
  state.q = e.target.value;
  loadPapers();
}, 300);

/* ---------------- 阅读器 ---------------- */

/* ---------- 群组管理弹层（成员邀请/移除/解散——仅群主可管理） ---------- */
window.tbGroupManage = async gid => {
  const {pop, close} = openPop('group-manage-pop');
  const d = await api(`/api/groups/${gid}/members`).catch(e => { close(); toast(friendlyError(e)); return null; });
  if (!d) return;
  const render = (members, iAmOwner) => {
    pop.innerHTML = `
    <div class="ui-pop-title">${icon('user')} 群组管理
      <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
    <div class="muted" style="font-size:var(--fs-xs);margin-top:6px">成员共享读写：往群组库收集/上传/移除论文、建子库。解散群组只摘论文挂链，论文本体不受影响。</div>
    ${iAmOwner ? `
    <div style="display:flex;gap:6px;margin-top:10px">
      <input id="gp-invite" placeholder="按用户名邀请成员…" style="flex:1" onkeydown="if(event.key==='Enter'&&!event.isComposing)gpInvite('${gid}')">
      <button class="btn small primary" onclick="gpInvite('${gid}')">邀请</button>
    </div>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
      <button class="btn small" onclick="gpCopyLink('${gid}')">${icon('copy', 12)} 复制邀请链接</button>
      <span class="muted" style="font-size:var(--fs-xs)">或把群组 ID <code style="user-select:all">${gid}</code> 发给同事，对方在侧栏「群组 → 加入群组」输入即可自助加入</span>
    </div>` : ''}
    <div style="margin-top:10px">
      ${members.map(m => `
      <div class="col-item" style="cursor:default">
        <span class="col-arrow-none"></span>
        <span class="col-name">${esc(m.username)}${m.role === 'owner' ? ' <span class="badge ok">群主</span>' : ''}</span>
        ${iAmOwner && m.role !== 'owner' ? `<button class="col-del" style="display:inline" onclick="gpRemove('${gid}', ${m.user_id}, '${esc(m.username)}')" title="移出群组">${icon('close')}</button>` : ''}
      </div>`).join('')}
    </div>
    ${iAmOwner ? `<button class="btn small danger" style="margin-top:12px" onclick="gpDisband('${gid}')">${icon('trash')} 解散群组</button>` : ''}`;
    pop.querySelector('[data-x]').onclick = close;
    if (iAmOwner) window._gpRefresh = () => tbGroupManage(gid);
  };
  render(d.members, d.iAmOwner);
};
window.gpCopyLink = async gid => {
  const url = `${location.origin}/?join_group=${gid}`;
  try { await navigator.clipboard.writeText(url); toast('邀请链接已复制——发给同事，打开即可加入', 4000); }
  catch { toast('复制失败，请手动复制：' + url, 8000); }
};
window.gpInvite = async gid => {
  const inp = document.querySelector('#gp-invite');
  const name = inp?.value.trim();
  if (!name) return;
  try {
    await api(`/api/groups/${gid}/members`, {method: 'POST', body: JSON.stringify({username: name})});
    toast(`已邀请 ${name}`);
    window._gpRefresh?.();
  } catch (e) { toast(friendlyError(e, '邀请失败')); }
};
window.gpRemove = async (gid, uid, name) => {
  if (!(await uiConfirm(`把 ${name} 移出群组？`, {title: '移除成员'}))) return;
  await api(`/api/groups/${gid}/members/${uid}`, {method: 'DELETE'});
  toast(`已移出 ${name}`);
  window._gpRefresh?.();
};
window.gpDisband = async gid => {
  if (!(await uiConfirm('解散群组？群组库树将删除（论文本体不受影响，只摘除挂链）。', {title: '解散群组', danger: true}))) return;
  await api(`/api/groups/${gid}`, {method: 'DELETE'});
  _tbCollectPop?.close?.();
  toast('群组已解散');
  document.querySelectorAll('.ui-backdrop').forEach(x => x.remove());
  await refreshLib();
};


/* ---------- 群组邀请链接深链（?join_group=<id>） ----------
   登录状态下直接弹加入确认；未登录先进 login.js 暂存，登录后此处接管。
   加入成功/拒绝都清掉暂存与 URL 参数，避免重复弹。 */
async function processPendingGroupJoin() {
  const gid = new URLSearchParams(location.search).get('join_group')
    || localStorage.getItem('ps-pending-join');
  if (!gid) return;
  localStorage.removeItem('ps-pending-join');
  history.replaceState(null, '', location.pathname);
  try {
    const r = await api('/api/groups/join', {method: 'POST', body: JSON.stringify({gid})});
    state.groups = [];
    await refreshLib();
    toast(`已加入群组「${r.name}」——群组文献见侧栏`, 6000);
  } catch (e) {
    const msg = friendlyError(e);
    if (/已是该群组成员/.test(msg)) toast('你已在该群组中');
    else if (/不存在/.test(msg)) toast('邀请链接失效：群组不存在或已解散', 6000);
    else toast(msg, 6000);
  }
}
processPendingGroupJoin();
