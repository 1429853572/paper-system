/* paper-system 前端逻辑（原生 JS，无框架） */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  me: null, papers: [], filter: '', q: '',
  current: null,          // 当前论文 dict
  pdfDoc: null, pageNum: 1, scale: 1.0,
  view: 'orig', blocks: [], pairs: [], versions: [],
  selected: new Set(),    // 多选 paper_ids
  qaPapers: new Set(),    // 问答 scope
  qaSession: '', health: {},
};

/* ---------------- 基础 ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: {'Content-Type': 'application/json', ...(opts.headers || {})},
    ...opts,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  if (!r.ok) {
    let d = {}; try { d = await r.json(); } catch {}
    throw new Error(d.detail || `HTTP ${r.status}`);
  }
  return r.json();
}
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* ---------------- 健康自检 ---------------- */
async function pollHealth() {
  try {
    state.health = await api('/api/health');
    const ok = state.health.db && state.health.ollama;
    $('#health-dot').className = 'health-dot ' + (ok ? 'ok' : 'bad');
    $('#health-dot').title = `db:${state.health.db} mineru:${state.health.mineru} ollama:${state.health.ollama}`;
  } catch { $('#health-dot').className = 'health-dot bad'; }
}
setInterval(pollHealth, 20000);

/* ---------------- 文献库 ---------------- */
state.collections = [];
state.currentCollection = '';

async function loadCollections() {
  const d = await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  renderCollections();
}
function renderCollections() {
  const el = $('#collections');
  const total = state.papers.length;  // 仅当前视图
  const row = (id, name, count, active, deletable) => `
    <div class="col-item ${active ? 'on' : ''}" data-id="${id}">
      <span class="col-name">📁 ${esc(name)}</span>
      <span class="col-count">${count}</span>
      ${deletable ? `<button class="col-del" title="删除文献库">✕</button>` : ''}
    </div>`;
  el.innerHTML =
    row('', '全部文献', state.totalPapers ?? state.papers.length, state.currentCollection === '', false) +
    state.collections.map(c => row(c.id, c.name, c.papers, state.currentCollection === c.id, true)).join('') +
    `<button class="col-new" id="col-new">＋ 新建文献库</button>
    <div class="col-new-form" id="col-new-form" hidden>
      <input id="col-new-name" placeholder="文献库名称，回车创建" maxlength="50">
      <div><button class="btn small primary" id="col-new-ok">创建</button>
      <button class="btn small" id="col-new-cancel">取消</button></div>
    </div>`;
  $$('.col-item', el).forEach(item => item.onclick = e => {
    if (e.target.classList.contains('col-del')) return;
    state.currentCollection = item.dataset.id;
    $('#dz-target').textContent =
      state.collections.find(c => c.id === item.dataset.id)?.name || '默认文献库';
    renderCollections(); loadPapers();
  });
  $$('.col-del', el).forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const cid = e.target.closest('.col-item').dataset.id;
    const name = state.collections.find(c => c.id === cid)?.name || '';
    if (!confirm(`删除文献库「${name}」？库内论文保留（变为未分库）`)) return;
    await api('/api/collections/' + cid, {method: 'DELETE'});
    if (state.currentCollection === cid) state.currentCollection = '';
    loadCollections(); loadPapers();
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
      $('#dz-target').textContent = d.name;
      loadCollections(); loadPapers();
    } catch (e) { toast('创建失败: ' + e.message); }
  };
  $('#col-new-ok').onclick = createCol;
  $('#col-new-name').onkeydown = e => { if (e.key === 'Enter') createCol(); if (e.key === 'Escape') $('#col-new-form').hidden = true; };
  $('#col-new-cancel').onclick = () => { $('#col-new-form').hidden = true; };
  // 批量移动下拉
  $('#batch-move').innerHTML = '<option value="">移入…</option>' +
    state.collections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') +
    '<option value="__none__">未分库</option>';
}

/* ---------------- 文库 ---------------- */
async function renderContentSearch() {
  const el = $('#paper-list');
  el.innerHTML = '<p class="muted" style="padding:14px">全文检索中…</p>';
  try {
    const d = await api('/api/search', {method: 'POST', body: JSON.stringify({query: state.q.trim(), top_k: 20})});
    if (!d.hits.length) { el.innerHTML = '<p class="muted" style="padding:14px">标题与全文均无匹配</p>'; return; }
    el.innerHTML = `<div style="padding:8px 14px" class="muted">🔎 全文命中 ${d.hits.length} 处（点击跳转）</div>` +
      d.hits.map(h => {
        const p = state.qaAllPapers?.find(x => x.id === h.paper_id) || state.papers.find(x => x.id === h.paper_id) || {};
        return `<div class="paper-item" data-id="${h.paper_id}" data-page="${h.page_index}">
          <div class="info"><div class="name">${esc(p.title || h.paper_id)}</div>
          <div class="meta">📄 第${h.page_index + 1}页</div>
          <div class="muted" style="font-size:11px;padding:2px 0">${esc(h.text.slice(0, 90))}</div></div></div>`;
      }).join('');
    $$('.paper-item', el).forEach(item => item.onclick = async () => {
      await openPaper(item.dataset.id);
      jumpEvidence(+item.dataset.page);
    });
  } catch (e) { el.innerHTML = `<p class="muted" style="padding:14px">检索失败: ${esc(e.message)}</p>`; }
}
async function loadPapers() {
  const params = new URLSearchParams({q: state.q.trim(), collection_id: state.currentCollection});
  const d = await api('/api/papers?' + params);
  state.papers = d.papers;
  renderPapers();
}
function statusBadge(p) {
  if (p.deleted_at) return '<span class="badge err">回收站</span>';
  const m = {parsed: '<span class="badge ok">已解析</span>',
             parsing: '<span class="badge run">解析中</span>',
             pending: '<span class="badge run">排队中</span>',
             failed: '<span class="badge err">失败</span>'};
  return m[p.parse_status] || '';
}
function renderPapers() {
  const el = $('#paper-list');
  if (state.q && state.q.trim().length >= 2) { renderContentSearch(); return; }
  if (!state.papers.length) { el.innerHTML = '<p class="muted" style="padding:20px">暂无论文，上传 PDF 开始</p>'; return; }
  el.innerHTML = state.papers.map(p => `
    <div class="paper-item ${state.current?.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      ${state.selectMode ? `<input type="checkbox" ${state.selected.has(p.id) ? 'checked' : ''}>` : ''}
      <div class="info">
        <div class="name">${esc(p.title || p.id)}</div>
        <div class="meta">${statusBadge(p)}
          ${p.visibility === 'private' ? '<span class="badge priv">私人</span>' : ''}
          <span>${(p.page_count || '?')}页</span><span>${p.file_size ? (p.file_size/1048576).toFixed(1) + 'M' : ''}</span>
        </div>
      </div>
      <button class="pi-del" title="移入回收站">🗑</button>
    </div>`).join('');
  $$('.paper-item', el).forEach(item => {
    const id = item.dataset.id;
    item.onclick = e => {
      if (e.target.type === 'checkbox') { toggleSelect(id, e.target.checked); return; }
      if (e.target.classList.contains('pi-del')) { quickDelete(id); return; }
      if (state.selectMode) { toggleSelect(id, !state.selected.has(id)); return; }
      openPaper(id);   // 普通模式：单击任意位置直接打开
    };
  });
}
function toggleSelect(id, on) {
  on ? state.selected.add(id) : state.selected.delete(id);
  $('#batch-bar').classList.toggle('show', state.selectMode && state.selected.size > 0);
}

/* 上传 */
const dz = $('#dropzone');
dz.onclick = () => $('#file-input').click();
$('#file-input').onchange = e => uploadFiles(e.target.files);
$('#url-import-btn').onclick = async () => {
  const url = $('#url-import-input').value.trim();
  if (!url) { toast('请输入 URL'); return; }
  try {
    const r = await api('/api/papers/import-url', {method: 'POST', body: JSON.stringify({
      url, collection_id: state.currentCollection || undefined})});
    toast(r.status === 'duplicate' ? '该 URL 已在库中' : '已加入解析队列');
    $('#url-import-input').value = '';
    loadPapers();
  } catch (e) { toast('导入失败: ' + e.message); }
};
$('#url-import-input').onkeydown = e => { if (e.key === 'Enter') $('#url-import-btn').click(); };
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
async function uploadFiles(files, targetCid) {
  const okFile = f => /\.(pdf|png|jpe?g|docx?|pptx?|xlsx?)$/i.test(f.name);
  const pdfs = [...files].filter(okFile);
  if (!pdfs.length) { toast('支持 PDF / 图片 / Office 文档'); return; }
  const vis = $('#vis-private')?.checked ? 'private' : 'shared';
  const col = (targetCid || state.currentCollection) ? `&collection_id=${targetCid || state.currentCollection}` : '';
  const fd = new FormData();
  pdfs.forEach(f => fd.append('files', f));
  const r = await fetch(`/api/papers/upload?visibility=${vis}${col}`, {method: 'POST', body: fd});
  if (!r.ok) { toast((await r.json()).detail || '上传失败'); return; }
  const d = await r.json();
  const ok = d.results.filter(x => x.status === 'queued').length;
  const dup = d.results.filter(x => x.status === 'duplicate').length;
  const rej = d.results.filter(x => x.status === 'rejected');
  toast(`已排队 ${ok} 篇${dup ? `，去重跳过 ${dup} 篇` : ''}${rej.length ? `，拒收 ${rej.length} 篇：${rej[0].reason}` : ''}`);
  loadPapers(); loadCollections();
}

/* 多选模式与批量操作 */
state.selectMode = false;
$('#sel-toggle').onclick = () => {
  state.selectMode = !state.selectMode;
  $('#sel-toggle').classList.toggle('primary', state.selectMode);
  if (!state.selectMode) { state.selected.clear(); $('#batch-bar').classList.remove('show'); }
  renderPapers();
};
$('#batch-cancel').onclick = () => {
  state.selected.clear(); $('#batch-bar').classList.remove('show');
  state.selectMode = false; $('#sel-toggle').classList.remove('primary');
  renderPapers();
};
$('#batch-translate').onclick = async () => {
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [...state.selected]})});
  toast(`已加入翻译队列（${state.selected.size} 篇）`); $('#batch-cancel').click();
};
$('#batch-delete').onclick = async () => {
  if (!confirm(`删除选中的 ${state.selected.size} 篇？（进回收站，30 天内可恢复）`)) return;
  for (const id of state.selected) await api('/api/papers/' + id, {method: 'DELETE'});
  toast('已移入回收站'); $('#batch-cancel').click(); loadPapers();
};
$('#batch-move').onchange = async e => {
  if (!state.selected.size) return;
  const v = e.target.value;
  if (!v) return;
  const cid = v === '__none__' ? null : v;
  for (const id of state.selected) await api('/api/papers/' + id, {method: 'PATCH', body: JSON.stringify({collection_id: cid})});
  toast(`已移动 ${state.selected.size} 篇`);
  e.target.value = ''; $('#batch-cancel').click(); loadPapers(); loadCollections();
};

/* 搜索 */
$('#lib-search').oninput = e => { state.q = e.target.value; loadPapers(); };

/* ---------------- 阅读器 ---------------- */
let pdfjsLib = null;
async function initPdfJs() {
  pdfjsLib = await import('/static/vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';
  try { state.katex = (await import('/static/vendor/katex/katex.mjs')).default; }
  catch (e) { console.warn('katex 加载失败:', e); }
}
async function openPaper(id) {
  const d = await api('/api/papers/' + id);
  state.current = d.paper; state.blocks = d.blocks;
  renderPapers();
  $('#page-title').textContent = d.paper.title || d.paper.id;
  // PDF
  try {
    state.pdfDoc = await pdfjsLib.getDocument(`/api/papers/${id}/pdf`).promise;
    state.pageNum = 1; state.fitWidth = true; _pdfBuilt = null;
    $('#pdf-toolbar').hidden = false;
    renderPage();
    applyVsplit();   // 按当前分栏宽度自适应首帧
    figCropPass();   // PDF 就绪，补跑原图裁剪
  } catch (e) {
    // URL/Office 导入无本地 PDF——展示占位（右侧解析内容照常）
    const isImg = /\.(png|jpe?g)(\?|$)/i.test(state.current?.id ? '' : '');
    $('#pdf-host').innerHTML = `<div style="color:#aab;margin:40px auto;text-align:center;font-size:13px">
      ⚠ 本篇无 PDF 预览（URL/Office 导入）<br>右侧解析内容与问答功能正常</div>`;
  }
  // 解析内容 + 双语（先清掉上一篇的残留，避免串页）
  state.pairs = []; state.versions = []; state.assets = null;
  api(`/api/papers/${id}/block-notes`).then(d => { state._bnotes = d.notes; }).catch(() => { state._bnotes = {}; });
  api(`/api/papers/${id}/assets`).then(d => {
    state.assets = d;
    if (['orig', 'bilingual', 'zh'].includes(state.view)) renderContentView();   // 聚合就绪→升级原图裁剪
  }).catch(() => {});
  state._refs = null;   // 引用缓存随论文重置
  state.showLayout = false; $('#layout-btn')?.classList.remove('on');   // 布局框不跨篇残留
  refreshJobState();   // 先取完整标志
  loadBilingual(id).then(() => {   // 翻译完成才默认双语；未完成/未开始停在原文
    if (state.translatedComplete && state.view === 'orig') switchView('read', 'bilingual');
    else renderContentView();
    restorePos(id);
  });
  renderContentView();
  refreshJobState();          // 解析/翻译控制按钮状态
  // 问答 scope 跟随当前论文（用户显式多选了其他论文则保留）
  if (state.qaPapers.size <= 1) {
    state.qaPapers.clear(); state.qaPapers.add(id);
    renderQaTab();   // dock 常驻，范围变化即刷新
  }
}
async function renderPage(opts = {}) { /* 连续模式入口：滚动到当前页并维护覆盖层 */
  await pdfEnsureAll();
  pdfScrollToPage(state.pageNum, opts.noFollow);
}
let _pdfBuilt = null;   // {pid, scale, wrappers:Map}
async function pdfEnsureAll() {
  if (!state.pdfDoc) return;
  if (_pdfBuilt && _pdfBuilt.pid === state.current?.id && _pdfBuilt.scale === state.scale) return;
  const host = $('#pdf-host');
  host.innerHTML = '';
  const wraps = new Map();
  _pdfBuilt = {pid: state.current?.id, scale: state.scale, wraps};
  for (let i = 1; i <= state.pdfDoc.numPages; i++) {
    const w = document.createElement('div');
    w.className = 'pdf-page'; w.dataset.page = i - 1;
    w.innerHTML = `<div class="pdf-ph" style="height:${Math.round(state.pdfDoc.pgHeights?.[i-1] || 1000)}px">…</div>`;
    host.appendChild(w);
    wraps.set(i - 1, w);
  }
  // 预计算各页高度（按第一页比例），占位防跳动
  const p1 = await state.pdfDoc.getPage(1);
  const v1 = p1.getViewport({scale: state.scale});
  state.pdfDoc.pgHeights = [];
  for (let i = 1; i <= state.pdfDoc.numPages; i++) {
    const pg = await state.pdfDoc.getPage(i);
    const vp = pg.getViewport({scale: state.scale});
    state.pdfDoc.pgHeights[i-1] = vp.height;
    const w = wraps.get(i - 1);
    w.querySelector('.pdf-ph').style.height = Math.round(vp.height) + 'px';
    state.pdfDoc[`pgvp_${i}`] = vp;
  }
  // 懒渲染观察器：进入视口即渲染该页（画布+文字层+覆盖层）
  if (state._pdfObs) state._pdfObs.disconnect();
  state._pdfObs = new IntersectionObserver(async entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const wrap = en.target;
      if (!wrap.dataset.rendered) { wrap.dataset.rendered = '1'; await renderOneWrap(wrap); }
    }
  }, { root: $('#pdf-host'), rootMargin: '600px 0px' });
  wraps.forEach(w => state._pdfObs.observe(w));
  // 当前页可见性 → 同步页码 + 右侧跟随
  if (state._pdfPageObs) state._pdfPageObs.disconnect();
  state._pdfPageObs = new IntersectionObserver(entries => {
    const vis = entries.filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!vis) return;
    const pg = +vis.target.dataset.page + 1;
    if (pg !== state.pageNum) {
      state.pageNum = pg;
      $('#pg-label').textContent = `${pg} / ${state.pdfDoc.numPages}`;
      savePos();
    }
  }, { root: $('#pdf-host'), threshold: [0.35, 0.6] });
  wraps.forEach(w => state._pdfPageObs.observe(w));
  await renderOneWrap(wraps.get(state.pageNum - 1));   // 立即渲染当前页
}
async function renderOneWrap(wrap) {
  if (!wrap) return;
  const idx = +wrap.dataset.page;
  const page = await state.pdfDoc.getPage(idx + 1);
  const vp = page.getViewport({scale: state.scale});
  const host0 = $('#pdf-host'); host0.style.setProperty('--scale-factor', state.scale);
  wrap.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  wrap.appendChild(canvas);
  await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
  wrap._vp = vp; wrap._pageObj = page;
  try {
    const tc = await page.getTextContent();
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.width = vp.width + 'px'; tl.style.height = vp.height + 'px';
    wrap.appendChild(tl);
    await new pdfjsLib.TextLayer({textContentSource: tc, container: tl, viewport: vp}).render();
  } catch (e) {}
  drawOverlays(wrap);
}
function drawOverlays(wrap) {
  if (!wrap || !wrap._vp) return;
  const idx = +wrap.dataset.page;
  const vp = wrap._vp;
  // 黄框：当前激活块（在该页才画）
  const active = $('.blk.active');
  $$('.hl-rect', wrap).forEach(x => x.remove());
  if (active && +active.dataset.page === idx && active.dataset.bbox && active.dataset.bbox !== '') {
    const ab = state.blocks.find(x => x.block_id === active.dataset.bid);
    const hc = typeColor(ab ? ab.type : 'text');
    try { JSON.parse(active.dataset.bbox).forEach(b => {
      if (!b || b.length < 4) return;
      const r = document.createElement('div');
      r.className = 'hl-rect';
      r.style.borderColor = hc;
      r.style.background = hc + '2e';
      r.style.left = (b[0]*vp.width)+'px'; r.style.top = (b[1]*vp.height)+'px';
      r.style.width = ((b[2]-b[0])*vp.width)+'px'; r.style.height = ((b[3]-b[1])*vp.height)+'px';
      wrap.appendChild(r);
    }); } catch {}
  }
  // 布局框
  $$('.layout-rect', wrap).forEach(x => x.remove());
  if (state.showLayout) {
    const colors = {text: '#4a6cf7', title: '#8a5cf6', equation: '#e6a23c',
                    table: '#2eaa6e', image: '#e0528f', ref_text: '#8a93b0'};
    state.blocks.filter(b => b.page_index === idx && b.bbox).forEach(b => {
      const bb = JSON.parse(b.bbox);
      if (!bb || bb.length < 4) return;
      const r = document.createElement('div');
      r.className = 'layout-rect';
      r.style.left = (bb[0]*vp.width)+'px'; r.style.top = (bb[1]*vp.height)+'px';
      r.style.width = ((bb[2]-bb[0])*vp.width)+'px'; r.style.height = ((bb[3]-bb[1])*vp.height)+'px';
      r.style.borderColor = colors[b.type] || '#9aa3bd';
      r.title = `${b.type}`;
      wrap.appendChild(r);
    });
  }
}
function pdfScrollToPage(n, noFollow) {
  const wrap = _pdfBuilt?.wraps?.get(n - 1);
  if (!wrap) return;
  state._suppressFollow = !!noFollow;   // 来自右侧同步的滚动(noFollow)不再回推右侧，防环
  wrap.scrollIntoView({block: 'start'});
  setTimeout(() => { state._suppressFollow = false; }, 350);
  $('#pg-label').textContent = `${n} / ${state.pdfDoc.numPages}`;
}
function redrawHl() { _pdfBuilt?.wraps?.forEach(drawOverlays); }
function drawHighlights(page, vp) {
  // 当前激活 block 有 bbox（归一化）→ 在对应页高亮（激活块在其他页则跳过）
  const active = $('.blk.active');
  if (!active || !active.dataset.bbox) return;
  if (+active.dataset.page !== state.pageNum - 1) return;
  const bboxes = JSON.parse(active.dataset.bbox);
  const host = $('#pdf-host');
  for (const b of bboxes || []) {
    if (!b || b.length < 4) continue;
    const [x0, y0, x1, y1] = b;  // 归一化 [0,1]，原点左下（PDF）→ 转左上
    const rect = document.createElement('div');
    rect.className = 'hl-rect';
    rect.style.left = (x0 * vp.width) + 'px';
    rect.style.top = (y0 * vp.height) + 'px';   // MinerU bbox 为左上原点，不翻转
    rect.style.width = ((x1 - x0) * vp.width) + 'px';
    rect.style.height = ((y1 - y0) * vp.height) + 'px';
    host.appendChild(rect);
  }
}
$('#pg-prev').onclick = () => { if (state.pageNum > 1) { state.pageNum--; renderPage(); } };
$('#pg-next').onclick = () => { if (state.pdfDoc && state.pageNum < state.pdfDoc.numPages) { state.pageNum++; renderPage(); } };
$('#zoom-in').onclick = () => { state.scale = Math.min(3, state.scale + 0.2); state.fitWidth = false; _pdfBuilt = null; renderPage({noFollow: true}); };
$('#zoom-out').onclick = () => { state.scale = Math.max(0.5, state.scale - 0.2); state.fitWidth = false; _pdfBuilt = null; renderPage({noFollow: true}); };
state.showLayout = false;
$('#layout-btn').onclick = () => {
  state.showLayout = !state.showLayout;
  $('#layout-btn').classList.toggle('on', state.showLayout);
  renderPage({noFollow: true});
};

/* 内容视图（统一走 switchView，保证 mainView/view 两级状态一致） */
$$('.view-tabs [data-v]').forEach(b => b.onclick = () => switchView(b.dataset.v));
async function loadBilingual(id) {
  try {
    const d = await api(`/api/papers/${id}/bilingual`);
    state.pairs = d.pairs; state.versions = d.versions;
    $('#version-select').hidden = true;   // 只展示最新一份（历史版本保留在库，不占界面）
    renderContentView();
  } catch { state.pairs = []; }
}
$('#version-select').onchange = e => {
  const d = e.target.value;
  api(`/api/papers/${state.current.id}/bilingual?cache_key=${d}`).then(x => {
    state.pairs = x.pairs; renderContentView();
  });
};
/* 解析/翻译控制按钮：按论文实时 jobstate 切换 */
function renderJobButtons(js) {
  const tb = $('#translate-btn');
  let extra = $('#parse-ctrl');
  if (!extra) {
    extra = document.createElement('button');
    extra.id = 'parse-ctrl'; extra.className = 'btn small';
    extra.onclick = parseCtrl;
    $('.view-tabs').insertBefore(extra, $('#translate-btn'));
  }
  if (js.parsing) {
    extra.textContent = '⏹ 取消解析'; extra.classList.add('danger');
  } else if (js.parse_status === 'failed') {
    extra.textContent = '▶ 重新解析'; extra.classList.remove('danger');
  } else {
    extra.textContent = '↻ 重新解析'; extra.classList.remove('danger');
  }
  if (js.translating) {
    tb.textContent = '⏹ 取消翻译'; tb.onclick = cancelTranslate;
  } else if (js.translated) {
    tb.textContent = '✓ 已译';
    tb.title = '已有完整译文，点击查看双语';
    tb.onclick = () => { switchView('read', 'bilingual'); toast('已展示最新译文'); };
  } else {
    tb.textContent = '🌐 翻译全文'; tb.title = ''; tb.onclick = startTranslate;
  }
  /* 进度条 */
  const strip = $('#job-progress');
  const tp = js.translate_progress, pp = js.parse_progress;
  if (tp) {
    const st = tp.status === 'queued' ? '排队中' : '翻译中';
    const pct = tp.total ? Math.round(100 * tp.done / tp.total) : 0;
    strip.hidden = false;
    strip.innerHTML = `<span>${st} ${tp.done}/${tp.total} 段</span>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <span class="muted">完成后自动出现双语视图 · 全部任务见「任务中心」</span>`;
  } else if (pp) {
    strip.hidden = false;
    strip.innerHTML = `<span>${pp.status === 'queued' ? '解析排队中（GPU 队列）' : pp.status === 'pending_gate' ? '等待 GPU 就绪…' : '解析中'}</span>
      <div class="progress"><i style="width:${pp.total ? Math.round(100 * pp.done / pp.total) : 5}%"></i></div>
      <span class="muted">全部任务见「任务中心」</span>`;
  } else {
    strip.hidden = true;
  }
}
async function refreshJobState() {
  if (!state.current) return;
  try {
    const js = await api(`/api/papers/${state.current.id}/jobstate`);
    state.translatedComplete = js.translated;
    state.translatingNow = js.translating;
    renderJobButtons(js);
    if (js.translating) watchTranslation();   // 进行中→自动轮询完成刷新
  } catch {}
}
async function parseCtrl() {
  const pid = state.current.id;
  const js = await api(`/api/papers/${pid}/jobstate`);
  if (js.parsing) {
    if (!confirm('取消解析当前论文？')) return;
    await api(`/api/papers/${pid}/cancel-parse`, {method: 'POST'});
    toast('解析已取消');
  } else {
    await api(`/api/papers/${pid}/parse`, {method: 'POST'});
    toast('解析任务已开始（插队执行）');
  }
  refreshJobState(); loadPapers();
}
async function startTranslate() {
  try {
    const r = await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [state.current.id]})});
    toast(r.skipped_in_flight?.length ? '该论文已有译文/已在队列，无需重复' : '翻译任务已加入队列');
  } catch (e) { toast(e.message); }
  refreshJobState();
}
async function retranslate() {
  const js = await api(`/api/papers/${state.current.id}/jobstate`);
  if (!confirm(`已有完整译文（${js.translated_model}）。\n用当前模型/术语表重新翻译生成新版本？（消耗 token）`)) return;
  await api('/api/papers/translate', {method: 'POST',
    body: JSON.stringify({paper_ids: [state.current.id], force_new_version: true})});
  toast('重译任务已入队（生成新版本，完成后版本下拉可切换）');
  refreshJobState();
}
async function cancelTranslate() {
  if (!confirm('取消翻译当前论文？（已完成段落会保留）')) return;
  await api(`/api/papers/${state.current.id}/cancel-translate`, {method: 'POST'});
  toast('翻译已取消');
  refreshJobState();
}
/* 翻译进行中轮询：完成自动刷新视图 */
let watching = null;
function watchTranslation() {
  clearInterval(watching);
  watching = setInterval(async () => {
    if (!state.current) { clearInterval(watching); return; }
    const js = await api(`/api/papers/${state.current.id}/jobstate`);
    state.translatingNow = js.translating;
    if (!js.translating && js.translated) {   // 真正完成（非部分译文）
      clearInterval(watching); toast('翻译完成 ✓');
      state.translatedComplete = true;
      const d = await api(`/api/papers/${state.current.id}/bilingual`);
      state.versions = d.versions; state.pairs = d.pairs;
      if (state.view !== 'zh') switchView('read', 'bilingual'); else renderContentView();
    }
    refreshJobState();
  }, 4000);
}
$('#translate-btn').onclick = startTranslate;
function switchView(v, s) {
  // v ∈ read|meta|assets|json；兼容 orig/bilingual/zh → read+子视图；qa → 聚焦问答框
  if (['orig', 'bilingual', 'zh'].includes(v)) { s = v; v = 'read'; }
  if (v === 'qa') { switchPage('reader'); $('#qa-text')?.focus(); return; }
  if (v === 'read' && s) state.rpane.readingView = s;
  state.mainView = v;
  state.view = v === 'read' ? (s || state.rpane.readingView || 'orig') : v;
  $$('.view-tabs [data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  $('#r-subtabs').hidden = v !== 'read';
  // 问答 dock 只在阅读主视图常驻；其他视图整栏给内容
  const isRead = v === 'read';
  $('#qa-dock').hidden = !isRead;
  $('#rpane-handle').hidden = !isRead;
  const top = $('#rpane-top');
  if (isRead) { top.style.flex = 'none'; top.style.height = state.rpane.top + '%'; }
  else { top.style.flex = '1 1 auto'; top.style.height = ''; }
  $$('.r-subtabs [data-s]').forEach(x => x.classList.toggle('on', x.dataset.s === state.view));
  renderContentView();
}
function renderContentView() {
  const el = $('#content-view');
  if (!state.current) { el.innerHTML = '<p class="muted">选择左侧论文开始阅读</p>'; return; }
  if (state.mainView === 'read' || ['orig','bilingual','zh'].includes(state.view)) {
    // 阅读：走下方 orig/bilingual/zh 分支
  }
  if (state.view === 'meta') { renderMeta(); return; }
  if (state.view === 'assets') { renderAssets(); return; }
  if (state.view === 'json') {
    el.innerHTML = `<div class="card json-view">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <b>解析块 JSON（调试）</b><span class="muted" style="font-size:12px">${state.blocks.length} blocks</span>
        <button class="btn small" style="margin-left:auto" onclick="copyJson()">复制</button>
      </div>
      <pre>${esc(JSON.stringify(state.blocks, null, 2))}</pre></div>`;
    return;
  }
  if (state.view === 'bilingual') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="card" style="text-align:center;padding:40px 20px">
        <p style="font-size:15px;margin-bottom:14px">${state.translatingNow ? '⏳ 翻译中…' : '未翻译'}</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">🌐 全文翻译</button>`}
      </div>`;
      return;
    }
    // 双语渲染：图表/公式只出一份（在 en 行）；无译文的行整行跳过——不留空壳占位
    const rows = [];
    for (const p of state.pairs) {
      const enHtml = renderBlockBody(p);
      if (p.type === 'image' || p.type === 'equation') {
        if (enHtml) rows.push(`<div class="pair en blk" data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}'>${enHtml}</div>`);
        continue;   // 图/公式无对应译文行
      }
      if (!p.zh) continue;   // 未翻译段：不渲染空壳
      const isTitle = p.type === 'title';
      rows.push(`<div class="pair en blk ${isTitle ? 'blk-title' : ''}" data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}'>${renderBlockBody(p)}</div>
        <div class="pair zh blk ${isTitle ? 'blk-title-zh' : ''}" data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}' ondblclick="editBlockNote('${state.current.id}','${p.block_id}')">${katexify(esc(p.zh))}</div>`);
    }
    el.innerHTML = '<div class="pairs">' + rows.join('') + '</div>';
  } else if (state.view === 'zh') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="card" style="text-align:center;padding:40px 20px">
        <p style="font-size:15px;margin-bottom:14px">${state.translatingNow ? '⏳ 翻译中…' : '未翻译'}</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">🌐 全文翻译</button>`}
      </div>`;
      return;
    }
    const zh = state.pairs.filter(p => p.zh);
    el.innerHTML = zh.length ? zh.map(p =>
      `<div class="blk zh ${p.type === 'title' ? 'blk-title-zh' : ''}" data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}'>${esc(p.zh)}</div>`).join('')
      : '<p class="muted">尚无中文译文。</p>';
  } else {  // orig
    el.innerHTML = state.blocks.map(b => {
      const note = state._bnotes?.[b.block_id];
      const ord = state.showOrder ? `<span class="ord-badge" title="语义阅读顺序">${state.blocks.indexOf(b) + 1}</span>` : '';
      const aux = ['page_number', 'footer', 'header', 'aside_text', 'page_footnote'].includes(b.type) ? ' blk-aux' : '';
      return `<div class="blk${aux}" data-bid="${b.block_id}" data-page="${b.page_index}" data-bbox='${esc(b.bbox ?? '')}' ondblclick="editBlockNote('${state.current.id}','${b.block_id}')">
        ${ord}${b.type === 'title' ? '<h3>' : ''}${renderBlockBody(b)}${b.type === 'title' ? '</h3>' : ''}
        ${note ? `<div class="bnote" title="双击段落编辑批注">📌 ${esc(note)}</div>` : ''}
      </div>`;}).join('');
  }

  figCropPass();   // PDF 原图裁剪（异步，pdfDoc 未就绪则跳过）
  // 段落点击 → 跳页 + 高亮
  $$('.blk', el).forEach(x => x.onclick = () => {
    $$('.blk.active').forEach(y => { y.classList.remove('active'); y.style.removeProperty('--hlc'); });
    applyActiveStyle(x);
    const page = parseInt(x.dataset.page ?? '0') + 1;
    if (state.pdfDoc && page >= 1 && page <= state.pdfDoc.numPages) {
      state.pageNum = page; renderPage();  // renderPage 会依据 data-bbox 画高亮
    }
  });
}

/* 阅读子页签（原文/双语/中文） */
$$('.r-subtabs [data-s]').forEach(b => b.onclick = () => switchView('read', b.dataset.s));

/* ---------------- 页签切换 ---------------- */
$$('.topnav button[data-page]').forEach(b => b.onclick = () => switchPage(b.dataset.page));
function switchPage(page) {
  $$('.topnav button[data-page]').forEach(x => x.classList.toggle('on', x.dataset.page === page));
  $('#page-title').textContent = {reader: '阅读', collections: '文库管理',
    trash: '回收站', settings: '设置', admin: '管理'}[page];
  for (const p of ['reader', 'collections', 'trash', 'settings', 'admin']) {
    $('#page-' + p).style.display = p === page ? (p === 'reader' ? 'flex' : 'block') : 'none';
  }
  ({collections: renderCollectionsPage, trash: renderTrash,
    settings: renderSettings, admin: renderAdmin})[page]?.();
}
window.switchPage = switchPage;  // 内联 onclick 可访问（module 作用域不暴露全局）

/* ---------------- 队列浮层（替代任务中心页） ---------------- */
async function refreshQueueBadge() {
  try {
    const d = await api('/api/jobs?limit=200');
    const active = d.jobs.filter(j => ['queued', 'pending_gate', 'running'].includes(j.status));
    const btn = $('#queue-btn'), badge = $('#qbadge');
    btn.hidden = !active.length;
    badge.textContent = active.length;
    if (!$('#queue-pop').hidden) renderQueueList(d.jobs);
  } catch {}
}
async function renderQueueList(all) {
  const jobs = all || (await api('/api/jobs?limit=200')).jobs;
  const st = {queued: '排队', pending_gate: '等GPU', running: '进行中', done: '完成',
              failed: '失败', canceled: '已取消'};
  const live = jobs.filter(j => ['queued', 'pending_gate', 'running', 'failed'].includes(j.status)).slice(0, 30);
  $('#queue-list').innerHTML = live.map(j => `
    <div class="qp-row">
      <span class="badge ${j.status === 'failed' ? 'err' : 'run'}">${st[j.status] || j.status}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title || j.paper_id || '')}</span>
      <span class="muted" style="font-size:11px">${j.job_type}${j.progress_total ? ' ' + j.progress_done + '/' + j.progress_total : ''}</span>
      ${['failed', 'canceled'].includes(j.status) ? `<button class="btn small" onclick="retryJob(${j.id})">重试</button>` : ''}
      ${['queued', 'pending_gate', 'running'].includes(j.status) ? `<button class="btn small danger" onclick="cancelJob(${j.id})">取消</button>` : ''}
      ${j.error ? `<div class="muted" style="font-size:11px;width:100%">${esc(j.error.slice(0, 90))}</div>` : ''}
    </div>`).join('') || '<p class="muted" style="padding:10px">无进行中任务</p>';
}
window.toggleQueue = async show => {
  const pop = $('#queue-pop');
  pop.hidden = show === undefined ? !pop.hidden : !show;
  if (!pop.hidden) renderQueueList();
};
$('#queue-btn').onclick = e => { e.stopPropagation(); toggleQueue(); };
document.addEventListener('click', e => {
  const pop = $('#queue-pop');
  if (!pop.hidden && !pop.contains(e.target) && e.target.id !== 'queue-btn') pop.hidden = true;
});
window.retryJob = async id => { await api(`/api/jobs/${id}/retry`, {method: 'POST'}); renderQueueList(); refreshQueueBadge(); };
window.cancelJob = async id => { await api(`/api/jobs/${id}/cancel`, {method: 'POST'}); renderQueueList(); refreshQueueBadge(); };
window.pauseQueue = async () => { await api('/api/queue/parse/pause', {method: 'POST'}); toast('批量已暂停（手动任务不受影响）'); };
window.resumeQueue = async () => { await api('/api/queue/parse/resume', {method: 'POST'}); toast('批量已恢复'); };
setInterval(refreshQueueBadge, 8000);

/* SSE 实时进度 */
async function watchJobs() {
  const es = new EventSource('/api/jobs/stream');
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (state.current && ev.paper_id === state.current.id && ev.job_type === 'parse' && ev.status === 'done') {
      openPaper(state.current.id);  // 解析完成刷新视图
      loadPapers();
    }
    if (ev.job_type === 'parse' && (ev.status === 'done' || ev.status === 'failed')) {
      api('/api/papers').then(d => {
        state.qaAllPapers = d.papers;
        if (state.view === 'qa') {
          renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
          renderQaScope();
          if (ev.status === 'done') toast(`《${(d.papers.find(x => x.id === ev.paper_id) || {}).title || ''}》解析完成，可以提问了`);
        }
      });
    }
    refreshQueueBadge();
    // 文库管理页打开时同步行内状态
    const cp = $('#page-collections');
    if (cp && cp.style.display !== 'none') renderCollectionsPage();
  };
}

/* ---------------- 右栏页签：文献信息 / 导读 / 图表 ---------------- */
const SUMMARY_NAMES = {problem: '研究问题', core_idea: '核心思想', method: '方法', datasets: '数据集',
  baselines: '基线', metrics: '指标', ablation: '消融', complexity: '复杂度', limitations: '局限'};

async function renderMeta() {
  const p = state.current;
  if (!p) { $('#content-view').innerHTML = '<p class="muted">选择论文后查看文献信息</p>'; return; }
  const pid = p.id;
  const d = await api('/api/papers/' + pid);
  const paper = d.paper;
  const notes = await api(`/api/papers/${pid}/notes`);
  const refs = await api(`/api/papers/${pid}/references`);
  state._refs = refs.references;
  const kw = (() => { try { return JSON.parse(paper.keywords || '[]'); } catch { return []; } })();

  $('#content-view').innerHTML = `
    <div class="meta-head card">
      <h2 id="m-title" style="margin-bottom:8px">${esc(paper.title || paper.id)}</h2>
      <div class="meta-line">👤 <span id="m-authors">${esc(paper.authors || '—')}</span></div>
      <div class="meta-line" id="m-rank"><span class="muted">期刊分区：加载中…</span></div>
      <div class="meta-line">📚 <span id="m-src">${esc([paper.journal, paper.year, paper.doi ? 'DOI: ' + paper.doi : ''].filter(Boolean).join(' · ') || '—')}</span>
        ${paper.meta_source ? `<span class="badge ok" title="${esc(paper.meta_verified_at || '')}">✓ 已校准(${esc(paper.meta_source)})</span>` : '<span class="badge priv">未校准</span>'}</div>
      <div class="meta-line">⭐ <span id="m-stars">${[1,2,3,4,5].map(i => `<span class="star ${i <= (notes.importance||0) ? 'on' : ''}" data-i="${i}">★</span>`).join('')}</span>
        🏷 <span id="m-tags">${esc(notes.tags || '') || '<i class=muted>点击右侧添加</i>'}</span></div>
      <div class="meta-actions">
        <button class="btn small" onclick="editMeta('${pid}')">✏️ 编辑</button>
        <button class="btn small" onclick="extractMeta('${pid}')" title="用 AI 补全缺失字段（作者/摘要/关键词）">🤖 AI 补全</button>
        <button class="btn small" onclick="copyCite('${pid}')">✂ 引用</button>
        <a class="btn small" href="/api/papers/${pid}/pdf" download="${canonicalName(paper)}.pdf">⬇ PDF</a>
        <button class="btn small" onclick="parseCtrl()">↻ 重新解析</button>
        <button class="btn small" onclick="retranslatePaper('${pid}')" title="换模型/术语表后生成新译文版本">🔁 强制重译</button>
      </div>
    </div>
    <div class="card" style="cursor:pointer" onclick="flashAbstract('${pid}')" title="点击在 PDF 中定位摘要">
      <h3>摘要 <span class="muted" style="font-weight:400;font-size:12px">📍点击定位</span> ${kw.length ? '<span class="muted" style="font-weight:400;font-size:12px">· 关键词: ' + esc(kw.join(' · ')) + '</span>' : ''}</h3>
      <p style="font-size:13px; line-height:1.7">${esc(paper.abstract || '（无——可点 AI 提取）')}</p></div>
    <div class="card"><h3>📝 备注</h3>
      <textarea id="m-notes" placeholder="记录阅读笔记…（自动保存）" style="min-height:70px">${esc(notes.notes || '')}</textarea></div>
    <div class="card"><h3>References (${refs.references.length}) <input id="ref-search" placeholder="搜索…" style="width:140px; font-size:12px; margin-left:8px; display:inline-block"></h3>
      <div class="ref-list" id="ref-list"></div></div>
    <div class="card"><h3>📁 分库</h3>
      <select id="m-collection" style="max-width:240px"><option value="">未分库</option></select></div>`;

  // 分库下拉
  const colSel = $('#m-collection');
  state.collections.forEach(c2 => colSel.insertAdjacentHTML('beforeend',
    `<option value="${c2.id}" ${paper.collection_id === c2.id ? 'selected' : ''}>${esc(c2.name)}</option>`));
  colSel.onchange = () => api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: colSel.value || null})});

  // 星级
  $$('#m-stars .star').forEach(s => s.onclick = async () => {
    const val = +s.dataset.i === notes.importance ? 0 : +s.dataset.i;
    await api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, importance: val})});
    notes.importance = val; renderMeta();
  });
  // 标签（点行尾进入编辑）
  $('#m-tags').onclick = async () => {
    const v = prompt('标签（逗号分隔）:', notes.tags || '');
    if (v === null) return;
    await api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, tags: v})});
    notes.tags = v; renderMeta();
  };
  // 备注自动保存
  let noteTimer;
  $('#m-notes').oninput = e => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, notes: e.target.value})}).then(() => toast('已保存', 1000)), 800);
  };
  // 参考文献渲染+搜索
  const renderRefs = q => {
    const list = refs.references.filter(r => !q || r.text.toLowerCase().includes(q));
    state._refs = refs.references;
    $('#ref-list').innerHTML = list.map(r =>
      `<div class="ref-item" onclick="flashRefBlock('${r.block_id}')">📄 ${esc(r.text.slice(0, 150))}</div>`).join('') ||
      '<p class="muted">无匹配</p>';
  };
  renderRefs('');
  $('#ref-search').oninput = e => renderRefs(e.target.value.toLowerCase());
  loadRank(pid);   // 分区自动加载（按期刊缓存，同期刊只查一次）
}

window.editMeta = (pid) => {
  const p = state.current;
  const f = (label, key, val) => prompt(label, val || '');
  const title = f('标题', 'title', p.title);
  if (title === null) return;
  const authors = f('作者（逗号分隔）', 'authors', p.authors);
  const journal = f('期刊/会议', 'journal', p.journal);
  const year = f('年份', 'year', p.year);
  const doi = f('DOI', 'doi', p.doi);
  api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({title, authors, journal, year, doi})})
    .then(() => { toast('已保存'); openPaper(pid); });
};
function canonicalName(p) {
  const title = (p.title || p.id || '').trim();
  const authors = (p.authors || '').trim();
  const year = (p.year || '').trim();
  let surname = '';
  if (authors) {
    const first = authors.split(',')[0].trim();
    const tokens = first.split(/\s+/);
    surname = tokens[tokens.length - 1] || first;
  }
  return ((surname || '') + year + ' ' + title).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
window.reindexPaper = async (pid) => {
  if (!confirm('重建该论文的检索索引？（不影响解析/翻译结果）')) return;
  await api(`/api/papers/${pid}/reindex`, {method: 'POST'});
  toast('索引重建任务已入队');
};
window.verifyMeta = async (pid) => {
  toast('联网校准中…（arXiv/CrossRef，只发送标题）');
  try {
    const r = await api(`/api/papers/${pid}/verify-meta`, {method: 'POST'});
    if (r.verified) toast(`✓ 已按 ${r.candidate.source} 校准（标题相似度 ${r.candidate.match}）`);
    else toast('⚠ ' + r.message);
    openPaper(pid); renderMeta();
  } catch (e) { toast('校准失败: ' + e.message); }
};
window.loadRank = async (pid) => {
  const el = $('#m-rank');
  el.innerHTML = '<span class="muted">期刊分区：查询中…</span>';
  try {
    const r = await api(`/api/papers/${pid}/journal-rank`);
    if (r.found) {
      const bits = [r.cas && `中科院·${r.cas}`, r.cas_top && `TOP`,
                    r.jcr && `JCR ${r.jcr}`, r.impact_factor && `IF ${r.impact_factor}`,
                    r.if5 && `5年IF ${r.if5}`, r.warning && `⚠预警`].filter(Boolean);
      el.innerHTML = `<span class="badge ok">📊</span> ${esc(bits.join(' · ') || '无分区数据')}
        <span class="muted" style="font-size:11px">via easyScholar${r.cached ? '（缓存）' : ''}</span>`;
    } else {
      el.innerHTML = `<span class="muted">期刊分区：${esc(r.message)}</span>
        <button class="btn small" onclick="loadRank('${pid}')">重查</button>`;
    }
  } catch (e) { el.innerHTML = `<span class="muted">期刊分区：查询失败 ${esc(e.message)}</span>`; }
};
window.extractMeta = async (pid) => {
  toast('AI 提取中…（约 10 秒）');
  try {
    await api(`/api/papers/${pid}/extract-meta`, {method: 'POST'});
    toast('提取完成'); openPaper(pid); renderMeta();
  } catch (e) { toast('提取失败: ' + e.message); }
};
window.copyCite = async (pid) => {
  const d = await api('/api/papers/' + pid);
  const p = d.paper;
  const authors = (p.authors || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const citeGB = `${authors.map(a => a.split(' ').slice(-1)[0]).join(', ')}等. ${p.title}[J]. ${p.journal || ''}, ${p.year || ''}.`;
  const citeBib = `@article{${(p.title || 'paper').slice(0, 20).replace(/\W+/g, '')}${p.year || ''},\n  title = {${p.title}},\n  author = {${p.authors}},\n  journal = {${p.journal || ''}},\n  year = {${p.year || ''}},\n  doi = {${p.doi || ''}}\n}`;
  const pick = prompt('1 = GB/T 7714\n2 = BibTeX\n输入序号复制：', '1');
  if (pick === '1') { navigator.clipboard.writeText(citeGB); toast('GB/T 7714 已复制'); }
  if (pick === '2') { navigator.clipboard.writeText(citeBib); toast('BibTeX 已复制'); }
};

/* ---------------- 右栏页签：问答 / 导读（与文章并排） ---------------- */
function renderQaTab() {   // 问答常驻 dock
  renderQaUI($('#qa-dock-body'));
}
function renderQaUI(container) {   // 可注入 content-view（整栏）或 dock body（分屏）
  const pid = state.current?.id;
  container.innerHTML = `
    <div class="qa-scope" id="qa-scope"></div>
    <div class="qa-picker">
      <button class="btn small" id="qa-pick-toggle">📄 选择论文（<span id="qa-pick-count">0</span>）</button>
      <div class="qa-pick-panel" id="qa-pick-panel" hidden>
        <input id="qa-pick-filter" placeholder="过滤标题…" style="font-size:12px">
        <div id="qa-pick-list"></div>
      </div>
    </div>
    <div class="qa-parse-hint" id="qa-parse-hint" hidden></div>
    <div class="qa-msgs" id="qa-msgs">
      <div id="qa-sum-bubble"></div>
      <div id="qa-msg-list"></div>
    </div>
    <div class="preset-qs" id="preset-qs"></div>
    <div class="qa-quote" id="qa-quote" hidden>
      <span class="muted" style="font-size:11px">📎 引用</span>
      <div class="qa-quote-text" id="qa-quote-text"></div>
      <button class="btn small" id="qa-quote-clear" title="移除引用">✕</button>
    </div>
    <div class="qa-input">
      <textarea id="qa-text" placeholder="对着左侧文章提问…（Ctrl+Enter 发送）"></textarea>
      <button class="btn primary" id="qa-send">发送</button>
    </div>`;
  if (!state.qaPapers.size && pid) state.qaPapers.add(pid);   // 默认=当前论文
  renderQaScope();
  populateQaPicker();
  api('/api/presets').then(presets => {
    const el = $('#preset-qs');
    if (!el) return;
    const qs = [...presets.questions];
    if (state.qaPapers.size >= 2) qs.unshift('对比所选论文的方法、数据集与实验结果有何异同？');
    el.innerHTML = qs.map(q =>
      `<button onclick="askPreset('${esc(q).replace(/'/g, "\\'")}')">${esc(q)}</button>`).join('');
  });
  $('#qa-pick-toggle').onclick = () => {
    const panel = $('#qa-pick-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderPickList($('#qa-pick-filter').value.toLowerCase()); $('#qa-pick-filter').focus(); }
  };
  $('#qa-pick-filter').oninput = e => renderPickList(e.target.value.toLowerCase());
  $('#qa-send').onclick = sendQa;
  $('#qa-quote-clear').onclick = clearQuote;
  $('#qa-text').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) sendQa(); };
  $('#qa-text').oninput = e => {   // 自动长高（上限 150px）
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px';
  };
  // 会话恢复（就近取最近会话，输入区上方提示）
  api('/api/chat/sessions').then(d => {
    if (!state.qaSession && d.sessions.length) state.qaSession = d.sessions[0].id;
    if (state.qaSession) loadSession(state.qaSession);
    else renderSumBubble();
  });
}

/* 导读 = 对话首条默认回答 */
async function renderSumBubble() {
  const el = $('#qa-sum-bubble');
  if (!el) return;
  const pid = [...state.qaPapers][0] || state.current?.id;
  if (!pid) { el.innerHTML = ''; return; }
  const paper = (state.qaAllPapers || state.papers).find(x => x.id === pid) || state.current || {};
  const title = paper.title || pid;
  const multi = state.qaPapers.size > 1;
  // 悬浮提示而非常驻文字（优雅优先；多篇警示仅在生成按钮气泡里出现一次）
  state._sumTip = `针对：${title}` + (multi ? `（已选 ${state.qaPapers.size} 篇，导读仅第一篇）` : '');
  state._sumHead = multi ? `<div class="muted" style="font-size:11px;margin-bottom:4px">已选 ${state.qaPapers.size} 篇 · 导读针对第一篇</div>` : '';
  const cached = state._sumCache?.[pid];
  if (cached) { drawSummary(cached.summary, pid, '#qa-sum-bubble', true); return; }
  const d = await api(`/api/papers/${pid}/summary`).catch(() => null);
  if (d && d.summary) {
    state._sumCache = state._sumCache || {};
    state._sumCache[pid] = d;
    drawSummary(d.summary, pid, '#qa-sum-bubble', true);
  } else {
    el.innerHTML = head + `<div class="msg assistant"><div class="bubble">
      <span class="muted">开始提问前，可先生成该篇的结构化导读：</span><br>
      <button class="btn small primary" style="margin-top:6px" onclick="genSumBubble('${pid}')">✨ 生成导读</button>
    </div></div>`;
  }
}
window.genSumBubble = async pid => {
  const el = $('#qa-sum-bubble');
  el.innerHTML = (state._sumHead || '') + '<div class="msg assistant"><div class="bubble">📋 导读生成中…（全文直读，约 20-60 秒）</div></div>';
  try {
    const d = await api(`/api/papers/${pid}/summary`, {method: 'POST', body: JSON.stringify({session_id: state.qaSession})});
    if (d.session_id) state.qaSession = d.session_id;
    state._sumCache = state._sumCache || {};
    state._sumCache[pid] = d;
    drawSummary(d, pid, '#qa-sum-bubble', true);
    toast('导读已生成，并存入当前会话');
  } catch (e) {
    el.innerHTML = `<div class="msg assistant"><div class="bubble">生成失败: ${esc(e.message)} <button class="btn small" onclick="genSumBubble('${pid}')">重试</button></div></div>`;
  }
}

/* ---- 上下分栏：拖动调占比；问答可整体关闭/重开回默认位 ---- */
state.rpane = { top: parseFloat(localStorage.getItem('ps-rpane-top') || '55'), readingView: 'orig', split: true };
state.qaOpen = localStorage.getItem('ps-qa-open') !== '0';
window.applyQaLayout = () => {
  const top = $('#rpane-top'), dock = $('#qa-dock'), handle = $('#rpane-handle'), pill = $('#qa-reopen');
  if (state.qaOpen) {
    dock.hidden = false; handle.hidden = false; pill.hidden = true;
    top.style.flex = 'none'; top.style.height = state.rpane.top + '%';
  } else {
    dock.hidden = true; handle.hidden = true; pill.hidden = false;
    top.style.flex = '1 1 auto'; top.style.height = '';
  }
};
window.closeQa = () => { state.qaOpen = false; localStorage.setItem('ps-qa-open', '0'); applyQaLayout(); };
window.openQaDock = () => {
  state.qaOpen = true; localStorage.setItem('ps-qa-open', '1');
  if (!localStorage.getItem('ps-rpane-top')) state.rpane.top = 55;   // 无记忆则回默认
  applyQaLayout(); renderQaTab(); $('#qa-text')?.focus();
};
(() => {
  const top = $('#rpane-top');
  const apply = () => {
    if (state.qaOpen) { top.style.flex = 'none'; top.style.height = state.rpane.top + '%'; }
  };
  applyQaLayout();
  $('#qa-dock-close').onclick = closeQa;
  $('#qa-reopen').onclick = openQaDock;
  const handle = $('#rpane-handle');
  let dragging = false;
  handle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const body = $('.rpane-body').getBoundingClientRect();
    const pct = Math.min(99, Math.max(1, Math.round(100 * (e.clientY - body.top) / body.height)));
    state.rpane.top = pct; apply();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; localStorage.setItem('ps-rpane-top', String(state.rpane.top)); }
  });
})();
function renderQaScope() {
  const el = $('#qa-scope');
  if (!el) return;
  el.innerHTML = '问答范围: ' +
    ([...state.qaPapers].map(p2 => {
      const p = state.qaAllPapers?.find(x => x.id === p2) || state.papers.find(x => x.id === p2);
      return `<span class="chip">${esc(p?.title || p2)}<button onclick="qaRemove('${p2}')">✕</button></span>`;
    }).join('') || '<span class="muted">（空——默认用当前论文，或从下方选文）</span>') +
    `<button class="btn small" style="margin-left:auto" onclick="exportChat()">⬇ 对话</button>`;
  const hint = $('#qa-parse-hint');
  if (hint) {
    const waiting = [...state.qaPapers]
      .map(p2 => state.qaAllPapers.find(x => x.id === p2))
      .filter(p2 => p2 && p2.parse_status !== 'parsed');
    hint.hidden = !waiting.length;
    if (waiting.length) hint.innerHTML = '⏳ ' + waiting.map(p2 =>
      `《${esc((p2.title || '').slice(0, 20))}》${p2.parse_status === 'failed' ? '解析失败，将自动重试' : '正在解析，完成后可对其提问'}`).join('，');
  }
}
window.qaRemove = pid => { state.qaPapers.delete(pid); renderQaScope(); renderSumBubble(); renderQaTab(); };
window.qaAddCurrent = () => {
  if (!state.current) { toast('当前没有打开的论文'); return; }
  state.qaPapers.add(state.current.id); renderQaScope(); renderSumBubble();
};
window.askPreset = q => { $('#qa-text').value = q; sendQa(); };
window.autoParseForQA = async (pid, p) => {
  if (p.parse_status === 'parsing' || p.parse_status === 'pending') return;   // 已在队列
  try {
    await api(`/api/papers/${pid}/parse`, {method: 'POST'});
    p.parse_status = 'pending';
    toast(`《${(p.title || '').slice(0, 26)}》尚未解析——已自动加入解析队列（插队）`);
    renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
    renderQaScope();
  } catch (e) { toast(`解析入队失败: ${e.message}`); }
};
async function populateQaPicker() {
  if (!state.qaAllPapers) {
    const d = await api('/api/papers');
    state.qaAllPapers = d.papers;
  }
  if (!state.collections?.length) await loadCollections();   // 分组依赖文献库列表
  const toggle = $('#qa-pick-toggle');
  if (!toggle) return;
  $('#qa-pick-count').textContent = state.qaPapers.size;
}
function renderPickList(filter) {
  const el = $('#qa-pick-list');
  if (!el) return;
  const item = p => {
    const st = p.parse_status !== 'parsed'
      ? `<span class="badge run">${p.parse_status === 'failed' ? '解析失败' : '⏳解析中'}</span>` : '';
    return `<label class="qa-pick-item ${state.qaPapers.has(p.id) ? 'on' : ''}">
      <input type="checkbox" ${state.qaPapers.has(p.id) ? 'checked' : ''} data-id="${p.id}">
      <span>${esc(p.title || p.id)}</span>${st}
    </label>`;};
  // 按文献库分组（过滤时跨组匹配；空组隐藏）
  const match = p => !filter || (p.title || '').toLowerCase().includes(filter);
  const cols = [...(state.collections || [])].sort((a, b) =>
    (b.name === '默认文献库') - (a.name === '默认文献库'));
  const groups = cols.map(c => ({
    name: c.name, papers: state.qaAllPapers.filter(p => p.collection_id === c.id && match(p)),
  }));
  const orphan = state.qaAllPapers.filter(p => !p.collection_id && match(p));
  if (orphan.length) groups.push({name: '未分库', papers: orphan});
  const visible = groups.filter(g => g.papers.length);
  const matched = visible.reduce((s, g) => s + g.papers.length, 0);
  el.innerHTML = (matched
    ? visible.map((g, i) => `
      <div class="qa-pick-group" data-gi="${i}">
        <div class="qa-pick-ghead" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">
          <span>📁 ${esc(g.name)}</span><span class="muted" style="font-size:11px">${g.papers.length} 篇 ▾</span>
        </div>
        <div class="qa-pick-gbody">${g.papers.map(item).join('')}</div>
      </div>`).join('')
    : '<p class="muted" style="padding:8px">无匹配</p>');
  $$('.qa-pick-item input', el).forEach(cb => cb.onchange = () => {
    const id = cb.dataset.id;
    if (cb.checked) {
      if (state.qaPapers.size >= 10) { cb.checked = false; toast('对比最多 10 篇'); return; }
      state.qaPapers.add(id);
      const p = state.qaAllPapers.find(x => x.id === id);
      if (p && p.parse_status !== 'parsed') autoParseForQA(id, p);   // 未解析 → 自动入解析队列
    } else state.qaPapers.delete(id);
    $('#qa-pick-count').textContent = state.qaPapers.size;
    renderQaScope(); renderSumBubble(); renderQaTab();
  });
}
async function loadSession(sid) {
  state.qaSession = sid;
  const el = $('#qa-msgs');
  if (!el) return;
  if (!sid) { el.innerHTML = ''; return; }
  const d = await api(`/api/chat/sessions/${sid}/messages`);
  const list = $('#qa-msg-list');
  if (!list) return;
  const MARKER = '请生成这篇论文的科研导读';
  const msgs = [];
  for (let i = 0; i < d.messages.length; i++) {
    const m = d.messages[i];
    if (m.role === 'user' && m.content === MARKER) { i++; continue; }  // 导读对由气泡展示，跳过
    try { m._ev = JSON.parse(m.evidence || '[]'); } catch { m._ev = []; }
    msgs.push(m);
  }
  list.innerHTML = msgs.map((m, i) =>
    `<div class="msg ${m.role}"><div class="bubble" data-mi="${i}">${m.role === 'assistant' ? renderCites(m.content, m._ev) : esc(m.content)}</div></div>`).join('');
  msgs.forEach((m, i) => {
    if (m.role === 'assistant' && m._ev?.length) {
      const el = $(`#qa-msg-list .bubble[data-mi="${i}"]`);
      if (el) wireCites(el, m._ev);
    }
  });
  renderSumBubble();
}
function sendQa() {
  const text = $('#qa-text')?.value.trim();
  if (!text) return;
  if (!state.qaPapers.size) {
    if (state.current) { state.qaPapers.add(state.current.id); renderQaScope(); }
    else { toast('请先在范围里加入论文'); return; }
  }
  const parsedScope = [...state.qaPapers].filter(p2 => {
    const pp = state.qaAllPapers.find(x => x.id === p2);
    return !pp || pp.parse_status === 'parsed';
  });
  if (!parsedScope.length) { toast('所选论文尚未解析完成，请稍候'); return; }
  $('#qa-text').value = '';
  const quote = state.qaQuote || '';
  $('#qa-msg-list').insertAdjacentHTML('beforeend',
    `<div class="msg user"><div class="bubble">${quote ? '<div class="muted" style="font-size:11px;border-left:2px solid #c9d2ee;padding-left:6px;margin-bottom:4px">📎 ' + esc(quote.split('\n> ')[1]?.slice(0, 80) || '') + '…</div>' : ''}${esc(text)}</div></div>
     <div class="msg assistant"><div class="bubble" id="qa-live">…</div></div>`);
  const live = $('#qa-live'); live.id = '';
  clearQuote();
  const ta = $('#qa-text'); ta.style.height = '';
  fetch('/api/chat/stream', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({question: text, quote, paper_ids: parsedScope,
                          mode: 'auto', session_id: state.qaSession})}).then(async r => {
    if (!r.ok) { live.textContent = (await r.json()).detail; return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'delta') live.textContent += ev.text;
        else if (ev.type === 'error') live.textContent += `\n[错误] ${ev.message}`;
        else if (ev.type === 'done') {
          state.qaSession = ev.session_id;
          live.innerHTML = renderCites(live.textContent, ev.evidence);
          wireCites(live, ev.evidence);
          // 证据来源分布（跨文献一目了然）
          const byP = {};
          (ev.evidence || []).forEach(e2 => { byP[e2.title || e2.paper_id] = (byP[e2.title || e2.paper_id] || 0) + 1; });
          const origin = Object.entries(byP).map(([t, n]) => `${esc(t)}×${n}`).join('，');
          if (origin) live.insertAdjacentHTML('beforeend',
            `<div class="evo-line">证据来源: ${origin}</div>`);
          if (ev.citations?.illegal?.length) toast('⚠ 部分引用编号无效: ' + ev.citations.illegal.join(','));
          if (ev.truncated) live.insertAdjacentHTML('beforeend', '<div class="muted" style="font-size:11px;margin-top:6px">⚠ 内容过长，已启用检索取证模式</div>');
        }
      }
    }
  });
}
async function renderSummaryTab() {
  const pid = state.current?.id;
  if (!pid) { $('#content-view').innerHTML = '<p class="muted">选择论文后生成导读（也可先用上方选文）</p>'; return; }
  const d = await api(`/api/papers/${pid}/summary`);
  if (!d.summary) {
    $('#content-view').innerHTML = `<div class="card">
      <p>基于左侧全文生成科研导读（研究问题 / 核心思想 / 方法 / …，带页码证据）。</p>
      <button class="btn primary" onclick="genSummary('${pid}')">✨ 生成导读</button></div>`;
    return;
  }
  drawSummary(d.summary, pid);
}
$('#menu-toggle').onclick = () => document.querySelector('.sidebar').classList.toggle('open');
document.addEventListener('click', e => {
  const sb = document.querySelector('.sidebar');
  if (sb.classList.contains('open') && !sb.contains(e.target) && e.target.id !== 'menu-toggle') {
    sb.classList.remove('open');
  }
});
$('#qa-open').onclick = () => { switchPage('reader'); $('#qa-text')?.focus(); };

/* ---------------- 启动 ---------------- */
async function boot() {
  try { state.me = await api('/api/me'); }
  catch { return; }
  $('#who').textContent = state.me.username + (state.me.role === 'admin' ? ' · 管理员' : '');
  $('#logout-btn').onclick = async () => { await fetch('/api/logout', {method: 'POST'}); location.href = '/login'; };
  if (state.me.role === 'admin') $('#nav-admin').hidden = false;
  // 未配置 key 提示横幅
  if (!state.me.llm_configured.chat) {
    $('.main').insertAdjacentHTML('afterbegin',
      `<div class="check-banner">⚠️ 尚未配置 LLM key——问答/翻译不可用。前往 <a href="#" onclick="switchPage('settings');return false">设置页</a> 配置。</div>`);
  }
  await initPdfJs();
  state.mainView = 'read'; state.view = state.rpane.readingView || 'orig';
  applyQaLayout();
  if (state.qaOpen) renderQaTab();   // 问答 dock（按记忆的开合状态）
  await loadCollections();
  await loadPapers();
  watchJobs();
  pollHealth();
}
boot();

/* ================= 跨文献讨论（覆盖层） ================= */
function mdLite(text) {
  let h = esc(text);
  h = h.replace(/(^|\n)((?:\|[^\n]+\|\n)+)/g, (m, pre, block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[\s:|-]+\|$/.test(r));
    const cells = rows.map(r => r.split('|').slice(1, -1).map(c => c.trim()));
    if (cells.length < 2) return m;
    return pre + '<table class="tbl-md"><tr>' + cells[0].map(c => `<th>${c}</th>`).join('') + '</tr>' +
      cells.slice(1).map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>';
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{2,4} (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^- (.+)$/gm, '&bull; $1');
  return katexify(h);
}
function renderCites(text, evidence) {
  return mdLite(text).replace(/\[(\d{1,3})\]/g, (m, n) => {
    const ev = evidence && evidence[n - 1];
    const tip = ev ? `${ev.title || ev.paper_id} · 第${ev.page_index + 1}页` : '';
    return `<span class="cite" data-n="${n}"${tip ? ` title="${esc(tip)}"` : ''}>[${n}]</span>`;
  });
}
function wireCites(container, evidence) {
  $$('.cite', container).forEach(el => el.onclick = () => {
    const n = +(el.dataset.n || (el.textContent.match(/\d+/) || [0])[0]);
    const ev = evidence && evidence[n - 1];
    if (ev) jumpToEvidence(ev);
  });
}
window.jumpToEvidence = async e => {
  if (!e) return;
  if (state.current && state.current.id !== e.paper_id) await openPaper(e.paper_id);
  if (state.pdfDoc) { state.pageNum = e.page_index + 1; renderPage(); }
};
window.jumpEvidence = page => { switchPage('reader'); if (state.pdfDoc) { state.pageNum = page + 1; renderPage(); } };

/* ================= 恢复区：被误删函数重建（以文件末尾声明覆盖） ================= */

/* ---- 回收站 ---- */
async function renderTrash() {
  const d = await api('/api/papers?trash=1');
  $('#page-trash').innerHTML = `<div class="card"><h2>回收站（30 天后自动清理）</h2>
    <table class="list"><tr><th>标题</th><th>删除时间</th><th></th></tr>
    ${d.papers.map(p => `<tr><td>${esc(p.title)}</td><td class="muted">${p.deleted_at}</td>
      <td class="row-actions"><button class="btn small" onclick="restorePaper('${p.id}')">恢复</button>
      </td></tr>`).join('') || '<tr><td colspan="3" class="muted">回收站为空</td></tr>'}</table></div>`;
}
window.restorePaper = async id => { await api(`/api/papers/${id}/restore`, {method: 'POST'}); toast('已恢复'); renderTrash(); loadPapers(); };

/* ---- 设置（BYOK + 术语表 + 测试连接） ---- */
async function renderSettings() {
  const d = await api('/api/settings/llm');
  const tpl = `
    <label>API 地址 <input name="base_url" placeholder="https://open.bigmodel.cn/api/anthropic"></label>
    <label>模型 <input name="model" placeholder="glm-4.7"></label>
    <label>协议 <select name="api_type"><option value="anthropic">anthropic</option><option value="openai">openai</option></select></label>
    <label>API Key（留空保持不变）<input name="api_key" type="password" placeholder="••••••"></label>`;
  $('#page-settings').innerHTML = `
    <div class="card"><h2>LLM 配置（BYOK——各用户自己的 key）</h2>
      <p class="muted" style="margin-bottom:10px">聊天与翻译可分别配置；embedding 使用本机服务无需配置。密钥加密存储、永不回显。</p>
      <form id="f-chat"><h3>💬 聊天（问答/导读） ${d.chat.configured ? '✅已配置' : '⚠️未配置'}</h3>${tpl}
        <button class="btn" type="button" onclick="testLlm('f-chat')">测试连接</button>
        <button class="btn primary" type="submit">保存聊天配置</button>
        <span class="muted" style="font-size:12px"> 当前: ${esc(d.chat.base_url)} / ${esc(d.chat.model)}</span>
      </form>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)">
      <form id="f-translate"><h3>🌐 翻译 ${d.translate.configured ? '✅已配置' : '⚠️未配置'}</h3>${tpl}
        <button class="btn" type="button" onclick="testLlm('f-translate')">测试连接</button>
        <button class="btn primary" type="submit">保存翻译配置</button>
        <span class="muted" style="font-size:12px"> 当前: ${esc(d.translate.base_url)} / ${esc(d.translate.model)}</span>
      </form>
    </div>
    <div class="card"><h3>📖 翻译术语表（全局）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:8px">规则：keep_en=保留英文 · trans=固定译法 · first_both=首次中英并列。影响后续翻译。</p>
      <div id="gl-list" style="margin-bottom:10px"></div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center">
        <input id="gl-term" placeholder="术语，如 Gaussian Splatting" style="flex:2; min-width:150px">
        <select id="gl-target" style="flex:1; min-width:110px">
          <option value="keep_en">保留英文</option><option value="trans">固定译法</option><option value="first_both">首次并列</option>
        </select>
        <input id="gl-value" placeholder="译法（后两种填）" style="flex:2; min-width:120px">
        <button class="btn small primary" id="gl-add">添加</button>
      </div></div>`;
  const bind = (fid, purpose) => $(`#${fid}`).onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const conf = {base_url: f.get('base_url'), model: f.get('model'), api_type: f.get('api_type')};
    if (f.get('api_key')) conf.api_key = f.get('api_key');
    await api('/api/settings/llm', {method: 'PUT', body: JSON.stringify({[purpose]: conf})});
    toast('已保存'); renderSettings();
  };
  bind('f-chat', 'chat'); bind('f-translate', 'translate');
  for (const [fid, key] of [['f-chat', 'chat'], ['f-translate', 'translate']]) {
    const form = $('#' + fid);
    const q = n => form.querySelector(`[name=${n}]`);
    if (q('base_url')) q('base_url').value = d[key].base_url || '';
    if (q('model')) q('model').value = d[key].model || '';
    if (d[key].configured && q('api_key')) q('api_key').placeholder = '已配置（输入新值可更换）';
  }
  loadGlossary();
}
window.testLlm = async fid => {
  const f = new FormData($('#' + fid));
  if (!f.get('api_key')) { toast('请先输入 key'); return; }
  const r = await api('/api/settings/llm/test', {method: 'POST', body: JSON.stringify({
    base_url: f.get('base_url'), api_key: f.get('api_key'),
    model: f.get('model'), api_type: f.get('api_type')})});
  toast(r.ok ? '✅ ' + r.message : '❌ ' + r.message);
};
async function loadGlossary() {
  const d = await api('/api/glossary');
  const el = $('#gl-list');
  if (!el) return;
  el.innerHTML = d.terms.map(t =>
    `<span class="chip">${esc(t.term)}${t.target === 'trans' ? ' → ' + esc(t.value) : t.target === 'first_both' ? ' ⇄ ' + esc(t.value) : ' (EN)'}
     <button onclick="delGlossary('${esc(t.term).replace(/'/g, "\\'")}')">✕</button></span>`).join('') ||
    '<span class="muted" style="font-size:12px">暂无术语——按需添加以保证全文译名一致</span>';
  $('#gl-add').onclick = async () => {
    const term = $('#gl-term').value.trim();
    if (!term) { toast('请输入术语'); return; }
    await api('/api/glossary', {method: 'POST', body: JSON.stringify({
      term, target: $('#gl-target').value, value: $('#gl-value').value.trim()})});
    $('#gl-term').value = ''; $('#gl-value').value = '';
    toast('已添加，下次翻译生效'); loadGlossary();
  };
}
window.delGlossary = async term => {
  await api('/api/glossary/' + encodeURIComponent(term), {method: 'DELETE'});
  loadGlossary();
};

/* ---- 管理页 ---- */
async function renderAdmin() {
  const users = await api('/api/admin/users');
  const pool = await api('/api/admin/pool');
  $('#page-admin').innerHTML = `
    <div class="card"><h2>邀请码</h2>
      <button class="btn primary" onclick="createInvite()">生成邀请码（7天有效）</button>
      <div id="invite-out" style="margin-top:8px"></div></div>
    <div class="card"><h2>用户与限额</h2>
      <table class="list"><tr><th>用户</th><th>角色</th><th>论文数</th><th>限额覆盖(JSON)</th><th></th></tr>
      ${users.users.map(u => `<tr><td>${esc(u.username)}</td><td>${u.role}</td><td>${u.papers}</td>
        <td><input style="font-size:11px" id="q-${u.id}" value='${esc(u.overrides || '{}')}'></td>
        <td><button class="btn small" onclick="saveQuota(${u.id})">保存</button></td></tr>`).join('')}
      </table>
      <p class="muted" style="font-size:12px;margin-top:6px">示例: {"max_pages":1000,"daily_parse_papers":400} · admin 全豁免</p></div>
    <div class="card"><h2>公共额度池</h2>
      <p class="muted" style="margin-bottom:8px">开启后，未配置自己 key 的成员将使用 .env 中的 POOL_API_KEY（消耗你的额度，默认关闭）。</p>
      <button class="btn ${pool.enabled ? 'danger' : 'primary'}" onclick="togglePool(${!pool.enabled})">
        ${pool.enabled ? '关闭公共池' : '开启公共池'}</button></div>`;
}
window.createInvite = async () => {
  const d = await api('/api/admin/invite', {method: 'POST'});
  $('#invite-out').innerHTML = `邀请码: <code style="font-size:16px">${d.code}</code>（${d.expires_in_days} 天内有效，一次性）`;
};
window.saveQuota = async uid => {
  try {
    const overrides = JSON.parse($('#q-' + uid).value || '{}');
    await api(`/api/admin/users/${uid}/quota`, {method: 'PUT', body: JSON.stringify(overrides)});
    toast('已保存');
  } catch (e) { toast('JSON 格式错误: ' + e.message); }
};
window.togglePool = async enable => {
  await api('/api/admin/pool', {method: 'POST', body: JSON.stringify({enabled: enable})});
  toast(enable ? '公共池已开启' : '公共池已关闭'); renderAdmin();
};

/* ---- 图表页签 ---- */
async function renderAssets() {
  const pid = state.current?.id;
  if (!pid) { $('#content-view').innerHTML = '<p class="muted">选择论文后查看图表</p>'; return; }
  if (!state.assets) state.assets = await api(`/api/papers/${pid}/assets`);
  const {figures, tables} = state.assets;
  if (!figures.length && !tables.length) {
    $('#content-view').innerHTML = '<p class="muted">未提取到图表</p>'; return;
  }
  // 空条目过滤：图必须可显示，表必须有内容或坐标
  const F = figures.filter(f => f.image_path);
  const T = tables.filter(t => (t.html && t.html.trim()) || t.bbox);
  figures = F; tables = T;
  setTimeout(() => {   // 兜底：裁剪失败且无兜底内容的卡片隐藏
    $$('.asset', $('#content-view')).forEach(a => {
      const hasImg = [...a.querySelectorAll('img')].some(i => i.naturalWidth > 0);
      const hasTbl = a.querySelector('.tbl') && a.querySelector('.tbl').innerHTML.trim().length > 20;
      if (!hasImg && !hasTbl) a.style.display = 'none';
    });
  }, 1200);
  $('#content-view').innerHTML =
    (figures.length ? `<div class="card"><h2>🖼 图 (${figures.length})</h2>` +
      figures.map(f => `<div class="asset">
        ${f.label ? `<span class="asset-badge" onclick="jumpEvidence(${f.page_index})" title="跳到 PDF 该页">${esc(f.label)}</span>` : ''}
        <div class="fig-grid">
        <img loading="lazy" src="/api/papers/${pid}/images/${f.image_path.split('/').pop()}"
             ondblclick="lightbox(this.src, '')">
        ${(f.extra_images || []).map(p => `<img loading="lazy" src="/api/papers/${pid}/images/${p.split('/').pop()}" ondblclick="lightbox(this.src, '')">`).join('')}
        </div>
        ${f.sub_captions?.length ? `<p class="muted" style="font-size:11px">${esc(f.sub_captions.join(' | ').slice(0, 160))}</p>` : ''}
        <p class="muted" style="font-size:12px"><a href="#" onclick="jumpEvidence(${f.page_index});return false">📄 第${f.page_index + 1}页</a> · ${esc(f.caption || '（无题注）')}</p>
      </div>`).join('') + '</div>' : '') +
    (tables.length ? `<div class="card"><h2>📋 表 (${tables.length})</h2>` +
      tables.map(t => `<div class="asset">
        ${t.label ? `<span class="asset-badge" onclick="jumpEvidence(${t.page_index})">${esc(t.label)}</span>` : ''}
        ${t.bbox ? `<figure class="fig-crop" data-page="${t.page_index}" data-ub='${JSON.stringify(t.bbox)}'>
          <div class="fig-holder">${t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : ''}</div>
        </figure>` : (t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : '')}
        <p class="muted" style="font-size:12px"><a href="#" onclick="jumpEvidence(${t.page_index});return false">📄 第${t.page_index + 1}页</a> · ${esc(t.caption || '（无题注）')}</p>
      </div>`).join('') + '</div>' : '');
  figCropPass();
}

/* ---- 导读绘制（气泡/整栏两用） ---- */
function drawSummary(s, pid, target = '#content-view', asBubble = false) {
  const t = $(target);
  const sec = Object.entries(s.sections || {});
  t.innerHTML = (asBubble ? (state._sumHead || '') + '<div class="msg assistant"><div class="bubble" style="width:100%">' : '<div class="card">') +
    (asBubble ? `<b title="${esc(state._sumTip || '')}">📋 导读</b>` : '<h2>科研导读</h2>') +
    (sec.length ? sec.map(([k, v]) =>
      `<div class="summary-sec"><h3>${SUMMARY_NAMES[k] || k}</h3><p>${renderCites(v, s.evidence)}</p></div>`).join('')
      : '<p class="muted">导读内容为空，请重新生成。</p>') +
    (s.evidence?.length ? `<p class="muted" style="font-size:12px">证据: ${s.evidence.map(e =>
      `<span class="cite" data-eid="${e.evidence_id}">[${e.evidence_id}] 第${e.page_index + 1}页</span>`).join(' ')}</p>` : '') +
    `</div>${asBubble ? '</div>' : ''}<button class="btn small" onclick="genSumBubble('${pid}')">↻ 重新生成</button>`;
  if (asBubble) t.insertAdjacentHTML('beforeend', followupButtons(s.sections));
  $$('.cite', t).forEach(el => {
    if (el.dataset.eid) {
      const ev = (s.evidence || []).find(x => String(x.evidence_id) === el.dataset.eid);
      if (ev) el.onclick = () => jumpToEvidence(ev);
    } else wireCites(t, s.evidence);
  });
}

/* ---- 对话导出 ---- */
window.copyJson = () => copyText(JSON.stringify(state.blocks, null, 2), 'JSON');
window.exportChat = () => {
  if (!state.qaSession) { toast('当前还没有对话记录'); return; }
  location.href = `/api/chat/sessions/${state.qaSession}/export`;
};


/* ---- 📚 文库管理页 ---- */
async function renderCollectionsPage() {
  const d = await api('/api/collections');
  state._statuses = (await api('/api/statuses')).statuses;
  const el = $('#page-collections');
  const cards = await Promise.all(d.collections.map(async c => {
    const papers = (await api('/api/papers?collection_id=' + c.id)).papers;
    const paperRows = papers.map(p => {
      const st = state._statuses?.[p.id] || {};
      const pj = st.parse_job, tj = st.translate_job;
      const parseBadge = st.parsing
        ? `<span class="badge run" title="${esc(pj?.error || '')}">⏳解析${pj?.status === 'queued' ? '(排队)' : ''}</span>`
        : p.parse_status === 'parsed' ? '<span class="badge ok">✓已解析</span>'
        : p.parse_status === 'failed'
          ? `<span class="badge err" title="${esc(pj?.error || '解析失败')}">✗失败</span>
             <button class="btn small" onclick="retryPaperJob('${p.id}')">重试</button>`
          : '<span class="badge run">排队中</span>';
      const trBadge = st.translating
        ? `<span class="badge run">🌐${tj ? tj.done + '/' + tj.total : ''}</span>`
        : tj?.status === 'failed'
          ? `<span class="badge err" title="${esc(tj.error || '')}">译✗</span>
             <button class="btn small" onclick="retryPaperJob('${p.id}')">重试</button>`
          : (tj?.status === 'done' ? '<span class="badge ok">✓已译</span>' : '<span class="muted">—</span>');
      const tk = st.tokens;
      const tkBadge = tk ? `<span class="muted" title="prompt/completion tokens">${(tk.p + tk.c).toLocaleString()} tok</span>` : '';
      return `<tr>
        <td style="width:28px"><input type="checkbox" class="lib-ck" data-cid="${c.id}" data-pid="${p.id}" onchange="libCk('${c.id}')"></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${esc(p.title || '')}">${esc(p.title || p.id)}</td>
        <td>${parseBadge}</td><td>${trBadge}</td><td>${tkBadge}</td>
        <td class="row-actions">
          <button class="btn small" onclick="viewPaper('${p.id}')">阅读</button>
          <select style="width:auto;font-size:11px;padding:2px 4px" onchange="movePaper('${p.id}', this.value, this)">
            <option value="">移入…</option>
            ${d.collections.filter(x => x.id !== c.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
            <option value="__none__">未分库</option>
          </select>
          <button class="btn small danger" onclick="delPaperFromLib('${p.id}')">删除</button>
        </td></tr>`;}).join('');
    const st = state._statuses || {};
    const doneTr = papers.filter(p => st[p.id]?.translate_job?.status === 'done').length;
    const totTok = papers.reduce((s, p) => s + ((st[p.id]?.tokens?.p || 0) + (st[p.id]?.tokens?.c || 0)), 0);
    return `<div class="card lib-card" data-cid="${c.id}">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <h2 style="margin:0;flex:1">📁 ${esc(c.name)}
          <span class="muted" style="font-size:13px">${papers.length} 篇</span>
          <span class="muted" style="font-size:12px">· 已译 ${doneTr}/${papers.length} · ${totTok.toLocaleString()} tok</span></h2>
        <button class="btn small primary" onclick="libUpload('${c.id}')">⬆ 上传到此库</button>
        <button class="btn small" onclick="renameLib('${c.id}', '${esc(c.name).replace(/'/g, "\\'")}')">✏️ 重命名</button>
        <button class="btn small danger" onclick="delLib('${c.id}', '${esc(c.name).replace(/'/g, "\\'")}')">删除库</button>
      </div>
      <div class="lib-batch" id="lb-${c.id}" hidden>
        <span id="lb-count-${c.id}">0</span> 篇选中
        <button class="btn small primary" onclick="libBatchTranslate('${c.id}')">🌐 批量翻译</button>
        <select style="width:auto;font-size:12px" onchange="libBatchMove('${c.id}', this.value, this)"><option value="">移入…</option>
          ${d.collections.filter(x => x.id !== c.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <button class="btn small danger" onclick="libBatchDelete('${c.id}')">删除</button>
      </div>
      <table class="list"><tr><th><input type="checkbox" onchange="libCkAll('${c.id}', this.checked)" title="全选"></th><th>论文</th><th>解析</th><th>翻译</th><th>用量</th><th></th></tr>
      ${paperRows || `<tr><td colspan="6" class="muted">空库——点「⬆ 上传到此库」或拖拽 PDF 进来</td></tr>`}</table>
    </div>`;
  }));
  el.innerHTML = `
    <div class="card" style="display:flex;gap:10px;align-items:center">
      <h2 style="margin:0;flex:1">文献库管理</h2>
      <span class="muted" style="font-size:12px">拖 PDF 到任意库卡片可直接上传入库</span>
      <input id="newlib-name" placeholder="新库名称" style="max-width:240px">
      <button class="btn primary" onclick="createLibFromPage()">＋ 新建文献库</button>
    </div>` + (cards.join('') || '<div class="card"><p class="muted">暂无文献库——上传论文时会自动创建「默认文献库」</p></div>');
  // 拖拽上传绑定
  $$('.lib-card').forEach(card => {
    const cid = card.dataset.cid;
    ['dragover', 'dragenter'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.remove('drag'); }));
    card.addEventListener('drop', e => uploadFiles(e.dataTransfer.files, cid));
  });
}
function libSelected(cid) {
  return $$('.lib-ck').filter(x => x.dataset.cid === cid && x.checked).map(x => x.dataset.pid);
}
window.libCk = cid => {
  const n = libSelected(cid).length;
  $('#lb-' + cid).hidden = !n;
  $('#lb-count-' + cid).textContent = n;
};
window.libCkAll = (cid, on) => {
  $$(`.lib-ck[data-cid="${cid}"]`).forEach(x => x.checked = on);
  libCk(cid);
};
window.libBatchTranslate = async cid => {
  const ids = libSelected(cid);
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: ids})});
  toast(`已加入翻译队列 ${ids.length} 篇`); renderCollectionsPage();
};
window.libBatchMove = async (cid, v, sel) => {
  if (!v) return;
  const target = v === '__none__' ? null : v;
  for (const pid of libSelected(cid)) await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: target})});
  toast('已移动'); sel.value = ''; renderCollectionsPage();
};
window.libBatchDelete = async cid => {
  const ids = libSelected(cid);
  if (!confirm(`删除选中的 ${ids.length} 篇？（进回收站）`)) return;
  for (const pid of ids) await api('/api/papers/' + pid, {method: 'DELETE'});
  toast('已移入回收站'); renderCollectionsPage();
};
window.libUpload = cid => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf';
  inp.onchange = () => uploadFiles(inp.files, cid);
  inp.click();
};
window.renameLib = async (cid, oldName) => {
  const name = prompt('重命名文献库：', oldName);
  if (!name?.trim() || name === oldName) return;
  await api('/api/collections/' + cid, {method: 'PATCH', body: JSON.stringify({name: name.trim()})});
  toast('已重命名'); loadCollections(); renderCollectionsPage();
};
window.delLib = async (cid, name) => {
  if (!confirm(`删除文献库「${name}」？库内论文保留（变为未分库）`)) return;
  await api('/api/collections/' + cid, {method: 'DELETE'});
  toast('已删除'); loadCollections(); renderCollectionsPage();
};
window.createLibFromPage = async () => {
  const name = $('#newlib-name').value.trim();
  if (!name) { toast('请输入库名'); return; }
  await api('/api/collections', {method: 'POST', body: JSON.stringify({name})});
  $('#newlib-name').value = '';
  toast('已创建'); loadCollections(); renderCollectionsPage();
};
window.movePaper = async (pid, v, sel) => {
  if (!v) return;
  const cid = v === '__none__' ? null : v;
  await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: cid})});
  toast('已移动'); loadPapers(); renderCollectionsPage();
};
window.delPaperFromLib = async pid => {
  if (!confirm('删除这篇论文？（进回收站，30 天内可恢复）')) return;
  await api('/api/papers/' + pid, {method: 'DELETE'});
  toast('已移入回收站'); loadPapers(); renderCollectionsPage();
};
window.viewPaper = pid => { switchPage('reader'); openPaper(pid); };


/* 图片灯箱预览 */
window.lightbox = (src, caption) => {
  let lb = $('#ps-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ps-lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `<img><p class="lb-cap"></p><button class="lb-close">✕</button>`;
    document.body.appendChild(lb);
    lb.onclick = e => { if (e.target === lb || e.target.classList.contains('lb-close')) lb.classList.remove('open'); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') lb.classList.remove('open'); });
  }
  lb.querySelector('img').src = src;
  lb.querySelector('.lb-cap').textContent = caption || '';
  lb.classList.add('open');
};

window.retryPaperJob = async pid => {
  await api(`/api/papers/${pid}/parse`, {method: 'POST'}).catch(() => {});
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [pid]})}).catch(() => {});
  toast('已重新入队'); renderCollectionsPage();
};

window.quickDelete = async pid => {
  const p = state.papers.find(x => x.id === pid);
  if (p?.visibility === 'shared' && state.me?.role !== 'admin') {
    toast('共享论文仅管理员可删除'); return;
  }
  if (!confirm(`《${(p?.title || pid).slice(0, 40)}》移入回收站？（30 天内可恢复）`)) return;
  try {
    await api('/api/papers/' + pid, {method: 'DELETE'});
    toast('已移入回收站');
    if (state.current?.id === pid) { state.current = null; state.blocks = []; renderContentView(); }
    state.qaPapers.delete(pid);
    loadPapers();
  } catch (e) { toast(e.message); }
};

/* 导读后的追问建议（按章节挑 3-5 个） */
const FOLLOWUP_QS = {
  problem: '这个问题之前的主流解法是什么？为什么不够好？',
  core_idea: '核心思想的关键洞察是什么？与已有方法的本质区别在哪？',
  method: '方法的关键模块和公式各自起什么作用？整体流程是怎样的？',
  datasets: '实验用了哪些数据集？规模和训练/测试划分如何？',
  baselines: '与基线方法相比提升多少？主要优势体现在哪？',
  metrics: '各评价指标上的具体数字是多少？如何解读？',
  ablation: '消融实验如何验证每个组件的必要性？去掉哪个掉得最多？',
  complexity: '计算量和显存开销相比已有方法如何？',
  limitations: '论文承认的局限有哪些？有什么可能的改进方向？',
};
function followupButtons(sections) {
  const qs = Object.keys(sections || {}).map(k => FOLLOWUP_QS[k]).filter(Boolean).slice(0, 5);
  if (!qs.length) return '';
  return `<div class="followups"><span class="muted" style="font-size:12px">💬 可以接着问：</span>` +
    qs.map(q => `<button class="chip chip-q" onclick="askPreset('${esc(q).replace(/'/g, "\\'")}')">${esc(q)}</button>`).join('') +
    `</div>`;
}

/* ================= 四项借鉴功能 ================= */

/* ---- ① 划词工具条（右侧原文/译文区） ---- */
(() => {
  let bar = null, lastSel = null;
  const ensureBar = () => {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'sel-bar'; bar.hidden = true;
    bar.innerHTML = `<button data-a="ask">💬 提问</button><button data-a="cp">📋 复制</button>`;
    document.body.appendChild(bar);
    bar.onclick = e => {
      const b = e.target.closest('button'); if (!b || !lastSel) return;
      const {text, page} = lastSel;
      if (b.dataset.a === 'cp') { copyText(text, '选中文字'); hideBar(); return; }
      setQuote(text, page);   // 引用独立成块，输入框留给问题
      hideBar();
    };
    return bar;
  };
  const hideBar = () => { if (bar) bar.hidden = true; };
  document.addEventListener('mouseup', e => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    const inContent = e.target.closest && (e.target.closest('#content-view') || e.target.closest('.qa-msgs') || e.target.closest('#pdf-host'));
    if (!text || text.length < 2 || !inContent) { hideBar(); return; }
    const blk = e.target.closest('.blk');
    lastSel = {text, page: blk ? +blk.dataset.page : (state.pageNum - 1)};
    const b = ensureBar();
    b.hidden = false;
    const x = Math.min(e.clientX, innerWidth - 260), y = e.clientY - 44;
    b.style.left = Math.max(8, x) + 'px'; b.style.top = Math.max(8, y) + 'px';
  });
  document.addEventListener('mousedown', e => { if (bar && !bar.contains(e.target)) hideBar(); });
  window._hideSelBar = hideBar;
})();

/* ---- ② 引用悬浮预览（原文 [n] → 参考文献卡片） ---- */
(() => {
  let pop = null, refsLoading = null;
  const ensurePop = () => {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'ref-pop'; pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  };
  const loadRefs = pid => {
    if (state._refs) return Promise.resolve();
    if (!refsLoading) refsLoading = api(`/api/papers/${pid}/references`)
      .then(d => { state._refs = d.references; refsLoading = null; })
      .catch(() => { refsLoading = null; });
    return refsLoading;
  };
  document.addEventListener('mouseover', async e => {
    const el = e.target.closest && e.target.closest('.ref-cite');
    const p = ensurePop();
    if (!el) { p.hidden = true; return; }
    if (!state.current) return;
    await loadRefs(state.current.id);
    const n = +el.dataset.n;
    const ref = (state._refs || [])[n - 1];
    if (!ref) { p.hidden = true; return; }
    p.innerHTML = `<b>[${n}]</b> ${esc(ref.text.slice(0, 220))}${ref.text.length > 220 ? '…' : ''}
      <div class="muted" style="font-size:11px;margin-top:4px">📄 第${ref.page_index + 1}页 · 点击跳转</div>`;
    p.hidden = false;
    const r = el.getBoundingClientRect();
    p.style.left = Math.min(r.left, innerWidth - 340) + 'px';
    p.style.top = (r.bottom + 6 > innerHeight - 160 ? r.top - p.offsetHeight - 6 : r.bottom + 6) + 'px';
  });
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('.ref-cite');
    if (el && state._refs) {
      const ref = state._refs[+el.dataset.n - 1];
      if (ref) jumpEvidence(ref.page_index);
    }
    if (pop && !pop.contains(e.target)) ensurePop().hidden = true;
  });
})();
const linkifyRefs = html => html.replace(/\[(\d{1,3})\]/g,
  (m, n) => `<span class="ref-cite" data-n="${n}">[${n}]</span>`);

/* ---- ③ 段落笔记 ---- */
window.editBlockNote = async (pid, bid) => {
  const cur = (state._bnotes || {})[bid] || '';
  const note = prompt('段落批注（留空删除；入口=双击段落）：', cur);
  if (note === null) return;
  await api(`/api/papers/${pid}/block-notes`, {method: 'PUT',
    body: JSON.stringify({block_id: bid, note})});
  state._bnotes = state._bnotes || {};
  if (note.trim()) state._bnotes[bid] = note.trim(); else delete state._bnotes[bid];
  toast('批注已保存');
  renderContentView();
};

/* ---- ④ 目录导航 + 阅读位置记忆 ---- */
window.toggleToc = () => {
  let t = $('#toc-panel');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toc-panel'; t.hidden = true;
    $('.pane-right').appendChild(t);
    document.addEventListener('click', e => {
      if (!t.hidden && !t.contains(e.target) && e.target.id !== 'toc-btn') t.hidden = true;
    });
  }
  if (t.hidden) {
    const seen = new Set(); const items = [];
    for (const b of state.blocks) {
      const sp = b.section_path || '';
      if (!sp || seen.has(sp)) continue;
      seen.add(sp);
      items.push(`<div class="toc-item" data-page="${b.page_index}" data-bid="${b.block_id}">${esc(sp.split(' > ').pop())}</div>`);
    }
    t.innerHTML = `<div class="toc-head">目录 <button class="btn small" onclick="toggleToc()">✕</button></div>` +
      (items.join('') || '<p class="muted" style="padding:10px">无章节结构</p>');
    $$('.toc-item', t).forEach(x => x.onclick = () => {
      jumpEvidence(+x.dataset.page);
      const blk = $(`#content-view .blk[data-bid="${x.dataset.bid}"]`);
      if (blk) blk.scrollIntoView({block: 'start'});
      t.hidden = true;
    });
  }
  t.hidden = !t.hidden;
};
const savePos = () => {
  if (!state.current) return;
  const active = $('.blk.active');
  try {
    localStorage.setItem('ps-pos-' + state.current.id, JSON.stringify({
      page: state.pageNum, bid: active?.dataset?.bid || null,
    }));
  } catch {}
};
const restorePos = id => {
  try {
    const pos = JSON.parse(localStorage.getItem('ps-pos-' + id) || 'null');
    if (pos?.page && state.pdfDoc && pos.page <= state.pdfDoc.numPages) {
      state.pageNum = pos.page;
      renderPage({noFollow: false});
      if (pos.bid) setTimeout(() => {
        const blk = $(`#content-view .blk[data-bid="${pos.bid}"]`);
        if (blk) blk.scrollIntoView({block: 'center'});
      }, 200);
      return true;
    }
  } catch {}
  return false;
};

/* 表格 HTML 消毒（本地解析产物，剥脚本/事件即可） */
const sanitizeTbl = html => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  .replace(/javascript:/gi, '');
/* 块 → HTML（图/表内嵌正文；文本 linkify 引用） */
const renderBlockBody = b => {
  const pid = state.current?.id;
  if (b.type === 'image' && b.asset_path) {
    const figs = state.assets?.figures || [];
    if (figs.some(g => (g.extra_images || []).includes(b.asset_path))) return '';   // 子图已聚合
    const fig = figs.find(f => f.image_path === b.asset_path);
    const subCaps = fig?.sub_captions || [];
    const fb = [b.asset_path, ...(fig?.extra_images || [])].map(p => p.split('/').pop());
    const ub = fig?.union_bbox || null;   // 仅组图并集才裁（子块 bbox 是局部，会截错）
    return `<figure class="inline-fig ${ub ? 'fig-crop' : ''}" ${ub ? `data-page="${b.page_index}" data-ub='${JSON.stringify(ub)}'` : ''}>
      <div class="fig-holder">${fb.map(n => `<img loading="lazy" src="/api/papers/${pid}/images/${n}">`).join('')}</div>
      ${subCaps.length ? `<figcaption class="muted" style="font-size:11px">${esc(subCaps.join(' | ').slice(0, 200))}</figcaption>` : ''}
    </figure>`;
  }
  if (b.type === 'equation' && (b.text || b.en)) {
    const tex = (b.en !== undefined ? b.en : b.text).trim();
    let r = null;
    if (state.katex) { try {
      r = state.katex.renderToString(tex, {throwOnError: false, displayMode: true, strict: false, trust: true});
    } catch {} }
    return r ? `<div class="eq-block">${r}</div>` : `<div class="eq-block"><code>${esc(tex)}</code></div>`;
  }
  if (b.type === 'table') {
    const html = b.en !== undefined ? b.en : b.text;   // pairs 用 en，blocks 用 text
    const fallback = html && html.includes('<') ? `<div class="tbl">${sanitizeTbl(html)}</div>` : '';
    const ub = b.bbox ? JSON.parse(b.bbox) : null;
    if (!ub) return fallback;
    return `<figure class="fig-crop tbl-crop" data-page="${b.page_index}" data-ub='${JSON.stringify(ub)}'>
      <div class="fig-holder">${fallback}</div>
    </figure>`;
  }
  return katexify(linkifyRefs(esc(b.en !== undefined ? b.en : b.text)));
};

/* 悬停 .blk → PDF 临时对应框 */
(() => {
  let tmp = null;
  const clear = () => { if (tmp) { tmp.remove(); tmp = null; } };
  document.addEventListener('mouseover', e => {
    const blk = e.target.closest && e.target.closest('.blk');
    clear();
    if (!blk || !blk.dataset.bbox || blk.dataset.bbox === '') return;
    const pg = +blk.dataset.page;
    const wrap = _pdfBuilt && _pdfBuilt.wraps.get(pg);
    if (!wrap || !wrap._vp || wrap.dataset.rendered !== '1') return;
    let bboxes; try { bboxes = JSON.parse(blk.dataset.bbox); } catch { return; }
    const b = (bboxes || [])[0];
    if (!b || b.length < 4) return;
    const vp = wrap._vp;
    const r = document.createElement('div');
    r.className = 'hl-rect hl-hover';
    r.style.left = (b[0]*vp.width)+'px'; r.style.top = (b[1]*vp.height)+'px';
    r.style.width = ((b[2]-b[0])*vp.width)+'px'; r.style.height = ((b[3]-b[1])*vp.height)+'px';
    wrap.appendChild(r);
    tmp = r;
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest && e.target.closest('.blk')) clear();
  });
  // 滚动/渲染时清除，防止蓝框滞留
  window._hoverClear = clear;
  $('#pdf-host').addEventListener('scroll', clear);
  const cv = $('#content-view'); cv && cv.addEventListener('scroll', clear);
})();

/* ===== 左右分栏拖动 + 自适应 ===== */
state.vsplit = parseFloat(localStorage.getItem('ps-vsplit') || '50');   // 左栏百分比
state.fitWidth = true;   // PDF 随栏宽自适应（手动缩放后关闭，拖动/换论文恢复）
state.sideMode = localStorage.getItem('ps-side') || 'both';
window.applyVsplit = (fire = true) => {
  const reader = $('.reader');
  if (!reader || innerWidth <= 880) return;   // 小屏堆叠布局不动
  const pl = $('#pane-left'), pr = $('.pane-right'), vh = $('#v-handle'), sr = $('#side-restore');
  const mode = state.sideMode;
  if (mode === 'text') {            // 只看文字
    pl.style.width = '0'; pl.style.overflow = 'hidden'; pl.style.borderRight = 'none';
    vh.style.display = 'none';
    sr.hidden = false; sr.textContent = '‹ 显示 PDF'; sr.onclick = () => { state.sideMode = 'both'; localStorage.setItem('ps-side', 'both'); applyVsplit(); };
  } else if (mode === 'pdf') {      // 只看 PDF
    pl.style.width = '100%'; pl.style.borderRight = 'none';
    vh.style.display = 'none';
    sr.hidden = false; sr.textContent = '显示文字 ›'; sr.onclick = () => { state.sideMode = 'both'; localStorage.setItem('ps-side', 'both'); applyVsplit(); };
  } else {                          // 双栏
    pl.style.width = state.vsplit + '%';
    pl.style.overflow = ''; pl.style.borderRight = '';
    pl.style.flex = 'none';
    vh.style.display = '';
    sr.hidden = true;
  }
  pr.style.width = 'auto';
  pr.style.flex = '1 1 auto';
  pr.style.minWidth = 0;
  pr.classList.toggle('narrow', pr.getBoundingClientRect().width < 560);
  if (fire) fitPdf();
};
$('#va-l').onclick = e => { e.stopPropagation(); state.sideMode = 'text'; localStorage.setItem('ps-side', 'text'); applyVsplit(); };
$('#va-r').onclick = e => { e.stopPropagation(); state.sideMode = 'pdf'; localStorage.setItem('ps-side', 'pdf'); applyVsplit(); };
window.fitPdf = () => {
  if (!state.pdfDoc || !state.fitWidth) return;
  const w = $('#pane-left').clientWidth - 24;
  state.pdfDoc.getPage(1).then(p1 => {
    const base = p1.getViewport({scale: 1}).width;
    const s = Math.max(0.4, Math.min(3, w / base));
    if (Math.abs(s - state.scale) > 0.02) { state.scale = Math.round(s * 20) / 20; _pdfBuilt = null; renderPage({noFollow: true}); }
  });
};
(() => {
  const h = $('#v-handle');
  let dragging = false;
  h.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = $('.reader').getBoundingClientRect();
    const pct = Math.min(99, Math.max(1, Math.round(100 * (e.clientX - r.left) / r.width)));
    if (pct !== state.vsplit) { state.vsplit = pct; applyVsplit(); }
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; localStorage.setItem('ps-vsplit', String(state.vsplit)); }
  });
  h.addEventListener('dblclick', () => {
    state.vsplit = 50; localStorage.setItem('ps-vsplit', '50');
    state.fitWidth = true; applyVsplit(); toast('已复位 50/50');
  });
  // 手动缩放 = 退出自适应；窗口变化重适配
  const zi = $('#zoom-in'), zo = $('#zoom-out');
  if (zi) zi.addEventListener('click', () => state.fitWidth = false);
  if (zo) zo.addEventListener('click', () => state.fitWidth = false);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => applyVsplit(), 250); });
  // PDF 栏宽变化 → 重绘页面与全部覆盖层（布局框/高亮/文字层随尺寸走）
  if (window.ResizeObserver) {
    let rw;
    new ResizeObserver(() => {
      clearTimeout(rw);
      rw = setTimeout(() => { if (state.pdfDoc && state.fitWidth) fitPdf(); }, 150);
    }).observe($('#pane-left'));
  }
})();

/* 划词引用块（输入框保持干净） */
state.qaQuote = '';
window.setQuote = (text, page) => {
  state.qaQuote = `（第${(page ?? 0) + 1}页）\n> ${text.slice(0, 600)}`;
  const box = $('#qa-quote');
  if (!box) return;
  box.hidden = !state.qaQuote;
  $('#qa-quote-text').textContent = text.slice(0, 160) + (text.length > 160 ? '…' : '');
  $('#qa-text').focus();
  $('#qa-text').placeholder = '针对上方引用提问…';
};
window.clearQuote = () => {
  state.qaQuote = '';
  const box = $('#qa-quote');
  if (box) box.hidden = true;
  const t = $('#qa-text');
  if (t) t.placeholder = '对着左侧文章提问…（Ctrl+Enter 发送）';
};


/* 公式渲染：KaTeX（$$块级优先，$行内；esc 后文本） */
function katexify(html) {
  if (!state.katex) return html;
  const render = (tex, display) => {
    try {
      return state.katex.renderToString(tex, {throwOnError: false, displayMode: display,
        strict: false, trust: true});
    } catch (e) { return null; }
  };
  return html
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => render(tex, true) || m)
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => render(tex, true) || m)
    .replace(/\\\((.+?)\\\)/g, (m, tex) => render(tex, false) || m)
    .replace(/\$([^$\n][^$\n]*?)\$/g, (m, tex) => render(tex, false) || m);
}

/* PDF 原图裁剪：按组图 union bbox 从原 PDF 高清渲染（保真原图），失败保留 MinerU 兜底 */
window.figCropPass = async () => {
  if (!state.pdfDoc) return;
  const holders = $$('.fig-crop[data-page]');
  for (const fig of holders) {
    if (fig.dataset.done) continue;
    fig.dataset.done = '1';
    try {
      const pageIdx = +fig.dataset.page;
      const ub = JSON.parse(fig.dataset.ub);
      const page = await state.pdfDoc.getPage(pageIdx + 1);
      const base = page.getViewport({scale: 1});
      const rx = ub[0] * base.width, ry = ub[1] * base.height;   // 左上原点
      const rw = (ub[2] - ub[0]) * base.width, rh = (ub[3] - ub[1]) * base.height;
      const holder = fig.querySelector('.fig-holder');
      const targetW = Math.min(holder.clientWidth || 640, 1200);
      const scale = Math.max(2, targetW / rw);
      const vp = page.getViewport({scale});
      const full = document.createElement('canvas');
      full.width = vp.width; full.height = vp.height;
      await page.render({canvasContext: full.getContext('2d'), viewport: vp}).promise;
      const out = document.createElement('canvas');
      out.width = Math.round(rw * scale); out.height = Math.round(rh * scale);
      out.getContext('2d').drawImage(full,
        rx * scale, ry * scale, rw * scale, rh * scale,
        0, 0, out.width, out.height);
      const url = out.toDataURL('image/png');
      holder.innerHTML = `<img src="${url}" ondblclick="lightbox(this.src, '')">`;
      fig.classList.add('from-pdf');
    } catch (e) { /* 保留 MinerU 兜底图 */ }
  }
};

/* ===== PDF→右侧 点击联动：点 PDF 任意位置，右侧定位对应块 ===== */
(() => {
  $('#pdf-host').addEventListener('click', async e => {
    if (!state.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;   // 划词选择不触发
    const wrap = e.target.closest('.pdf-page');
    if (!wrap || wrap.dataset.rendered !== '1' || !wrap._vp) return;
    const vp = wrap._vp;
    const rect = wrap.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / vp.width;
    const ny = (e.clientY - rect.top) / vp.height;   // bbox 左上原点 ✓
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    const pg = +wrap.dataset.page;
    // 命中：该页所有 bbox 中包含点、面积最小者（最内层块）
    let hit = null, hitArea = 1e9;
    for (const b of state.blocks) {
      if (b.page_index !== pg || !b.bbox) continue;
      let bb; try { bb = JSON.parse(b.bbox); } catch { continue; }
      const [[x0, y0, x1, y1]] = [bb];
      if (!x1 || x0 === undefined) continue;
      if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
        const area = (x1 - x0) * (y1 - y0);
        if (area < hitArea) { hit = b; hitArea = area; }
      }
    }
    if (!hit) {   // 空白处：跳该页第一块
      hit = state.blocks.find(b => b.page_index === pg);
    }
    if (!hit) return;
    const blkEl = $(`#content-view .blk[data-bid="${hit.block_id}"]`);
    if (!blkEl) return;
    $$('.blk.active', $('#content-view')).forEach(x => { x.classList.remove('active'); x.style.removeProperty('--hlc'); });
    applyActiveStyle(blkEl);
    blkEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    redrawHl();
    savePos();
  });
})();

window.retranslatePaper = async pid => {
  if (!confirm('用当前模型/术语表重新翻译，生成新版本？（消耗 token，旧版本保留）')) return;
  await api('/api/papers/translate', {method: 'POST',
    body: JSON.stringify({paper_ids: [pid], force_new_version: true})});
  toast('重译已入队（完成后自动展示最新版）');
};

/* 统一联动色板（按块类型）——PDF 框与右侧高亮同色 */
const TYPE_COLORS = {text: '#4a6cf7', title: '#8a5cf6', paragraph_title: '#8a5cf6', doc_title: '#8a5cf6',
  equation: '#e6a23c', table: '#2eaa6e', image: '#e0528f', chart: '#e0528f',
  ref_text: '#8a93b0', list: '#4a8cf7', index: '#4a8cf7'};
window.typeColor = t => TYPE_COLORS[t] || '#4a6cf7';
window.applyActiveStyle = blkEl => {
  if (!blkEl) return;
  const b = state.blocks.find(x => x.block_id === blkEl.dataset.bid);
  const c = typeColor(b ? b.type : 'text');
  blkEl.style.setProperty('--hlc', c);
  blkEl.classList.add('active');
};

/* ===== 文献信息联动：摘要/参考文献 → PDF 定位并闪烁高亮 ===== */
window.pdfFlashBlock = async b => {
  if (!b || !state.pdfDoc) return;
  await pdfEnsureAll();
  const wrap = _pdfBuilt && _pdfBuilt.wraps.get(b.page_index);
  if (!wrap) return;
  if (wrap.dataset.rendered !== '1') await renderOneWrap(wrap);
  const vp = wrap._vp;
  state._suppressFollow = true;
  wrap.scrollIntoView({ block: 'center' });
  setTimeout(() => { state._suppressFollow = false; }, 350);
  let bb; try { bb = JSON.parse(b.bbox || 'null'); } catch { bb = null; }
  if (bb && bb.length >= 4) {
    const c = typeColor(b.type);
    const r = document.createElement('div');
    r.className = 'hl-rect hl-flash';
    r.style.borderColor = c; r.style.background = c + '30';
    r.style.left = (bb[0]*vp.width)+'px'; r.style.top = (bb[1]*vp.height)+'px';
    r.style.width = ((bb[2]-bb[0])*vp.width)+'px'; r.style.height = ((bb[3]-bb[1])*vp.height)+'px';
    wrap.appendChild(r);
    setTimeout(() => r.remove(), 2600);
  }
  state.pageNum = b.page_index + 1;
  $('#pg-label').textContent = `${state.pageNum} / ${state.pdfDoc.numPages}`;
};
window.flashAbstract = async pid => {
  const b = state.blocks.find(x => /abstract/i.test(x.section_path || '')) ||
            state.blocks.find(x => x.type === 'text' && x.page_index <= 1 && (x.text || '').length > 100);
  if (!b) { toast('未定位到摘要区域'); return; }
  pdfFlashBlock(b);
};
window.flashRefBlock = async blockId => {
  const b = state.blocks.find(x => x.block_id === blockId);
  if (b) pdfFlashBlock(b);
};

/* ===== 联动诊断（Ctrl+Shift+L）===== */
window.linkDiag = () => {
  const d = {
    当前视图: state.view, 主视图: state.mainView,
    块观察器: state._blkObs ? '挂载中' : '未挂载',
    PDF页观察器: state._pdfPageObs ? '挂载中' : '未挂载',
    PDF连续视图: _pdfBuilt ? `已建 ${_pdfBuilt.wraps.size} 页` : '未建',
    当前页: state.pageNum, 抑制回环: !!state._suppressFollow,
    论文: state.current?.id || '无',
  };
  const msg = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join('  |  ');
  console.log('[联动诊断]', d);
  toast(msg, 6000);
  copyText(msg, '诊断信息');
};
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); linkDiag(); }
});

/* ①顺序 / ☰目录 绑定（此前随联动开关块误删） */
state.showOrder = false;
$('#ord-btn').onclick = () => {
  state.showOrder = !state.showOrder;
  $('#ord-btn').classList.toggle('on', state.showOrder);
  renderContentView();
};
$('#toc-btn').onclick = () => toggleToc();
