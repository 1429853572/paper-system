/* ===== 02-library.js —— 文献库与侧栏：集合树/论文列表/上传导入/筛选 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
async function loadCollections(preset = null) {
  const d = preset || await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  state.unassignedCount = d.unassigned || 0;   // 未分库（含失效引用）——侧栏数字自洽
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
    // 未分库 / 他人共享库：让「总数 = 各行相加」自洽（否则读者以为论文丢了）
    (unassigned ? `<div class="col-item ${state.currentCollection === 'none' ? 'on' : ''}" data-id="none">
      <span class="col-arrow-none"></span><span class="col-name">${icon('inbox')} 未分库</span>
      <span class="col-count">${unassigned}</span></div>` : '') +
    sharedLibs.map(l => `<div class="col-item ${state.currentCollection === l.id ? 'on' : ''}" data-id="${l.id}">
      <span class="col-arrow-none"></span><span class="col-name">${icon('folder')} ${esc(l.name)} <span class="muted" style="font-size: var(--fs-xs)">共享</span></span>
      <span class="col-count">${l.papers}</span></div>`).join('') +
    `<button class="col-new" id="col-new">${icon('plus')} 新建文献库</button>
     <div class="col-new-form" id="col-new-form" hidden>
       <input id="col-new-name" placeholder="文献库名称，回车创建" maxlength="50">
       <div><button class="btn small primary" id="col-new-ok">创建</button>
       <button class="btn small" id="col-new-cancel">取消</button></div>
     </div>`;
  $$('.col-item', el).forEach(item => item.onclick = e => {
    if (e.target.closest?.('.col-del') || e.target.dataset.toggle) return;
    const id = item.dataset.id;
    state.currentCollection = id;
    updateUploadTarget();
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
    if (!(await uiConfirm(`删除文献库「${name}」？其子库与库内论文将一并移入回收站（30 天内可恢复）`,
                           {title: '删除文献库', anchor: e.currentTarget}))) return;
    await api('/api/collections/' + cid, {method: 'DELETE'});
    if (state.currentCollection === cid) state.currentCollection = '';
    await refreshLib();
  });
  $('#col-new').onclick = () => {
    const form = $('#col-new-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#col-new-name').focus();
  };
  const createCol = async () => {
    const name = $('#col-new-name').value.trim();
    if (!name) { toast('请输入名称'); return; }
    try {
      const d = await api('/api/collections', {method: 'POST', body: JSON.stringify({name})});
      $('#col-new-name').value = '';
      $('#col-new-form').hidden = true;
      state.currentCollection = d.id;
      updateUploadTarget();
      await refreshLib();
    } catch (e) { toast('创建失败: ' + e.message); }
  };
  $('#col-new-ok').onclick = createCol;
  $('#col-new-name').onkeydown = e => { if (e.key === 'Enter') createCol(); if (e.key === 'Escape') $('#col-new-form').hidden = true; };
  $('#col-new-cancel').onclick = () => { $('#col-new-form').hidden = true; };
}
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
  loadCollections(d);                       // 侧栏文库树（含各库计数）
  await loadPapers();                      // 侧栏论文列表
  const pg = $('#page-collections');
  if (pg && pg.style.display !== 'none') await renderCollectionsPage(d);   // 文库管理页
  // 解析进度水合（SSE 只覆盖在线期间的变更，刷新后从 statuses 补齐“提取中 x/y”）
  api('/api/statuses').then(s => {
    const map = {};
    for (const [pid, st] of Object.entries(s.statuses || {})) {
      const pj = st.parse_job;
      if (pj && pj.status === 'running') map[pid] = {done: pj.done || 0, total: pj.total || 0};
    }
    state.parseProg = map;
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
    status: state.filter === 'private' ? '' : state.filter, page, page_size: 200});
  const d = await api('/api/papers?' + params);
  let papers = state.filter === 'private' ? d.papers.filter(p => p.visibility === 'private') : d.papers;
  // 快捷范围（服务端筛不了的在前端过滤）
  if (state.scope === 'untranslated') {
    const st = state._statuses || {};
    papers = papers.filter(p => st[p.id]?.translate_job?.status !== 'done');
  } else if (state.scope === 'parsing') {
    papers = papers.filter(p => ['parsing', 'pending'].includes(p.parse_status));
  } else if (state.scope === 'private') {
    papers = papers.filter(p => p.visibility === 'private');
  }
  state.papers = append ? [...state.papers, ...papers] : papers;
  state.papersPage = page;
  state.papersHasMore = !!d.has_more;
  renderPapers();
}
function statusBadge(p) {  if (p.deleted_at) return '<span class="badge err">回收站</span>';
  if (p.parse_status === 'skipped') return '<span class="badge dim" title="超页数上限未自动解析，可手动重解析">已跳过</span>';
  if (p.parse_status === 'pending') return '<span class="badge run">排队中</span>';
  if (p.parse_status === 'parsing') {
    const pr = (state.parseProg || {})[p.id];
    return `<span class="badge run">${pr && pr.total ? `提取中 ${pr.done}/${pr.total}` : '解析中'}</span>`;
  }
  const m = {parsed: '<span class="badge ok">已解析</span>',
             failed: '<span class="badge err">失败</span>'};
  return m[p.parse_status] || '';
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
      <button class="btn primary" onclick="document.querySelector('#upload-arrow')?.click()">${icon('upload')} 上传第一篇</button>
      <button class="btn" onclick="document.querySelector('#upload-arrow')?.click(); setTimeout(()=>document.querySelector('#ident-input')?.focus(), 200)">粘贴 DOI 导入</button>
    </div>`;
    return;
  }
  const listHtml = sortPapers(state.papers).map(p => {
    const pr = (state.parseProg || {})[p.id];
    const bar = p.parse_status === 'parsing' && pr?.total
      ? `${progressBar(Math.round(100 * pr.done / pr.total), false, 'up-bar parse')}` : '';
    return `
    <div class="paper-item ${state.current?.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      <div class="info">
        <div class="name">${esc(p.title || p.id)}</div>
        <div class="meta">${statusBadge(p)}
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

/* 上传：入口是工具条图标 + 直接把文件拖到论文列表区（不再有独立大拖放框） */
state.uploadPrivate = localStorage.getItem('ps-upload-private') === '1';
function updateUploadTarget() {
  const el = $('#upload-target');
  if (el) el.textContent = '上传到：' +
    (state.currentCollection ? (state.collections.find(c => c.id === state.currentCollection)?.name || '默认文献库') : '全部文献');
}
function updateVisToggle() {
  const cb = $('#upload-private');
  if (cb) cb.checked = state.uploadPrivate;
}
$('#upload-private')?.addEventListener('change', e => {
  state.uploadPrivate = e.target.checked;
  localStorage.setItem('ps-upload-private', state.uploadPrivate ? '1' : '0');
  toast(state.uploadPrivate ? '新上传的文献将仅自己可见' : '新上传的文献将对所有人可见');
});
const upPop = $('#upload-pop');
/* 429 预知与友好化：弹层打开即展示今日余量；「上限」类错误附重置说明、不渲染无效重试按钮 */
const quotaTip = msg => /上限/.test(msg || '') ? msg + '——明日 0 点重置，也可请管理员在设置页调整限额' : msg;
async function refreshQuotaHint() {
  const el = $('#quota-hint');
  if (!el) return;
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) { el.textContent = ''; return; }
  el.textContent = `今日解析 ${q.parse_used}/${q.parse_limit} 篇 · 磁盘 ${fmtGB(q.disk_used_bytes).toFixed(1)}/${q.disk_limit_gb}G`;
}
$('#upload-arrow')?.addEventListener('click', e => {
  e.stopPropagation();
  upPop.hidden = !upPop.hidden;
  upPop.style.bottom = '52px'; upPop.style.top = 'auto';
  upPop.style.right = '12px'; upPop.style.left = 'auto';
  updateUploadTarget(); updateVisToggle();
  if (!upPop.hidden) refreshQuotaHint();
});
$('#upload-file-btn').onclick = () => { upPop.hidden = true; $('#file-input').click(); };
outsideClose(upPop, $('#upload-arrow'), $('#upload-file-btn'));
$('#file-input').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
$('#url-import-btn').onclick = async () => {
  const url = $('#url-import-input').value.trim();
  if (!url) { toast('请输入 URL'); return; }
  try {
    const r = await api('/api/papers/import-url', {method: 'POST', body: JSON.stringify({
      url, collection_id: state.currentCollection || undefined})});
    toast(r.status === 'duplicate' ? '该 URL 已在库中' : '已加入解析队列');
    $('#url-import-input').value = '';
    upPop.hidden = true;
    await refreshLib();
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
};
$('#url-import-input').onkeydown = e => { if (e.key === 'Enter') $('#url-import-btn').click(); };
/* 标识符导入（zotero-mcp 式）：DOI / arXiv ID / BibTeX → 元数据 + OA PDF */
$('#ident-btn').onclick = async () => {
  const ta = $('#ident-input');
  const text = ta.value.trim();
  if (!text) { toast('先粘贴 DOI / arXiv ID 或 BibTeX'); return; }
  const btn = $('#ident-btn');
  btn.disabled = true; btn.textContent = '解析中…';
  try {
    const d = await api('/api/papers/import-identifier', {method: 'POST', body: JSON.stringify({
      text, visibility: state.uploadPrivate ? 'private' : 'shared',
      collection_id: state.currentCollection || null})});
    const q = d.results.filter(x => x.status === 'queued').length;
    const dup = d.results.filter(x => x.status === 'duplicate').length;
    const nopdf = d.results.filter(x => x.status === 'no_pdf').length;
    const nf = d.results.filter(x => x.status === 'not_found').length;
    let msg = q ? `已导入 ${q} 篇并开始解析` : '没有可导入的条目';
    if (dup) msg += `，${dup} 篇已在库跳过`;
    if (nopdf) msg += `，${nopdf} 篇无公开 PDF`;
    if (nf) msg += `，${nf} 条未识别`;
    toast(msg, 4000);
    if (q) { ta.value = ''; upPop.hidden = true; await loadCollections(); await refreshLib(); }
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.textContent = '导入 ID';
};
$('#ident-input').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) $('#ident-btn').click(); };
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
$('#dir-btn').onclick = async () => {
  const path = $('#dir-select').value;
  if (!path) { toast('先选择要导入的目录'); return; }
  const btn = $('#dir-btn');
  btn.disabled = true; btn.textContent = '扫描中…';
  try {
    const d = await api('/api/import-directory', {method: 'POST',
      body: JSON.stringify({path, collection_id: state.currentCollection || null,
                            visibility: state.uploadPrivate ? 'private' : 'shared'})});
    const q = d.queued.length, sk = d.skipped.length;
    toast(`已入库 ${q} 篇${sk ? `，跳过 ${sk} 个` : ''}——解析进度见「任务中心」`, 4000);
    if (sk) {
      const reasons = d.skipped.slice(0, 3).map(x => `${x.file}: ${x.reason}`).join('；');
      await uiConfirm(`以下文件未能入库：<br>${esc(reasons)}${sk > 3 ? `<br>…共 ${sk} 个` : ''}`,
                      {title: '跳过明细', okText: '知道了', hideCancel: true, html: true});
    }
    upPop.hidden = true;
    await loadImportDirs();
    await refreshLib();
  } catch (e) { toast(quotaTip('目录导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.innerHTML = icon('folder') + ' 目录导入';
};
loadImportDirs();
/* 解析过滤器（llm4z 式：页数上限 + 文件名排除；服务端上传时执行，设置跟随账号） */
$('#pf-adv-toggle').onclick = () => { $('#pf-adv').hidden = !$('#pf-adv').hidden; };
async function loadParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter');
    $('#pf-max').value = d.max_pages || 0;
    $('#pf-exclude').value = d.exclude || '';
    $('#pf-adv-hint').textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
  } catch { /* ignore */ }
}
$('#pf-max').onchange = saveParseFilter;
$('#pf-exclude').onchange = saveParseFilter;
async function saveParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter', {method: 'PUT', body: JSON.stringify({
      max_pages: +$('#pf-max').value || 0, exclude: $('#pf-exclude').value.trim()})});
    $('#pf-adv-hint').textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
    toast('解析过滤规则已保存');
  } catch (e) { toast('保存失败: ' + e.message); }
}
loadParseFilter();
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
    renderPapers();
    try {
      const d = await new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('files', f);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/papers/upload?visibility=${vis}${col}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) { up.pct = Math.round(e.loaded / e.total * 100); renderPapers(); }
        };
        xhr.upload.onload = () => { up.phase = 'saving'; up.pct = 100; renderPapers(); };
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
      else if (res.status === 'duplicate') { state.uploads.delete(f.name); dupN++; }
      else { state.uploads.delete(f.name); okN++; }
      await refreshLib();
      if (up.phase === 'error') renderPapers();
    } catch (e) {
      up.phase = 'error'; up.msg = e.message; rejN++; renderPapers();
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
/* ---- 筛选与排序菜单（▾）---- */
const FILTERS = [['', '全部'], ['parsed', '已解析'], ['parsing', '解析中'], ['skipped', '已跳过'], ['failed', '失败'], ['private', '仅私人']];
const SORTS = [['recent', '最近更新'], ['title', '标题'], ['pages', '页数'], ['size', '文件大小']];
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
  const pop = $('#filter-pop');
  if (pop) {
    $$('.tp-item', pop).forEach(it => {
      const on = it.dataset.f !== undefined ? it.dataset.f === state.filter : it.dataset.s === state.sortBy;
      it.classList.toggle('on', on);
    });
  }
  const arrow = $('#filter-arrow');
  if (!arrow) return;
  const fn = FILTERS.find(f => f[0] === state.filter)?.[1] || '全部';
  const sn = SORTS.find(s => s[0] === state.sortBy)?.[1] || '最近更新';
  arrow.classList.toggle('has-val', !!state.filter || state.sortBy !== 'recent');
  arrow.title = `筛选：${fn} · 排序：${sn}`;
}
$('#filter-arrow').onclick = e => {
  e.stopPropagation();
  const pop = $('#filter-pop');
  pop.hidden = !pop.hidden;
  markFilterMenu();
};
$('#filter-pop').onclick = e => {
  const item = e.target.closest('.tp-item');
  if (!item) return;
  if (item.dataset.f !== undefined) {
    state.filter = item.dataset.f;
    localStorage.setItem('ps-filter', state.filter);
  } else if (item.dataset.s) {
    state.sortBy = item.dataset.s;
    localStorage.setItem('ps-sort', state.sortBy);
  }
  $('#filter-pop').hidden = true;
  markFilterMenu();
  loadPapers();
};
outsideClose($('#filter-pop'), $('#filter-arrow'));
markFilterMenu();

/* ---- 侧栏折叠 / 展开（MinerU 风格浮动箭头）---- */
state.sidebarCollapsed = localStorage.getItem('ps-sidebar-collapsed') === '1';
window.applySidebarCollapse = () => {
  const sb = $('.sidebar');
  sb.classList.toggle('collapsed', state.sidebarCollapsed);
  $('#side-rail').hidden = !state.sidebarCollapsed;
};
$('#side-collapse').onclick = () => {
  state.sidebarCollapsed = true;
  localStorage.setItem('ps-sidebar-collapsed', '1');
  applySidebarCollapse();
};
$('#side-expand').onclick = () => {
  state.sidebarCollapsed = false;
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

/* 搜索 + 快捷范围 chips */
$('#lib-search').oninput = debounce(e => {   // 300ms 防抖：大库逐键触发全文检索会请求风暴
  state.q = e.target.value;
  loadPapers();
}, 300);
$$('#scope-chips .chip-btn').forEach(b => b.addEventListener('click', () => {
  const s = b.dataset.scope;
  state.scope = state.scope === s ? '' : s;      // 再点取消
  $$('#scope-chips .chip-btn').forEach(x => x.classList.toggle('on', x.dataset.scope === state.scope));
  loadPapers();
}));

/* ---------------- 阅读器 ---------------- */
