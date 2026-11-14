/* ===== 03-reader.js —— 阅读器：PDF 渲染/覆盖层/中英对照/翻译 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
let pdfjsLib = null;
async function initPdfJs() {
  pdfjsLib = await import('/static/vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';
  try { state.katex = (await import('/static/vendor/katex/katex.mjs')).default; }
  catch (e) { console.warn('katex 加载失败:', e); }
}

/* ---- 渲染分辨率（DPR 感知）----
   canvas 的位图尺寸若只按 CSS 像素给，HiDPI 屏(dpr=2)浏览器会把 1× 位图拉伸成 2× 设备像素
   → 文字/线条整体发虚（典型 pdf.js 糊屏根因）。
   正确做法：位图按 CSS 尺寸 × devicePixelRatio 渲染，再用 style 把显示尺寸钉回 CSS 尺寸。
   dpr 受像素预算限制，避免高倍缩放时画布过大爆内存。 */
const MAX_PAGE_PX = 12e6;     // 单页画布像素上限（~48MB RGBA）
const MAX_CROP_PX = 8e6;      // 裁剪用整页画布像素上限（~32MB，临时）
function dprFor(cssW, cssH, budget) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const area = Math.max(1, cssW * cssH);
  return Math.max(1, Math.min(dpr, Math.sqrt(budget / area)));
}

async function openPaper(id) {
    // 阅读追踪：fire-and-forget（不 await 不 toast——零打扰）
    // 同时更新本地 state.papers 的 read_status → 侧栏圆点即时消失（否则要等下次拉列表）
    try {
      const pos = JSON.parse(localStorage.getItem('ps-pos-' + id) || 'null');
      api(`/api/papers/${id}/read`, {method: 'POST',
        body: JSON.stringify({page: pos?.page || null, bid: pos?.bid || null})}).then(() => {
        const lp = state.papers.find(x => x.id === id);
        if (lp) lp.read_status = 'read';
        renderPapers();
      }).catch(() => {});
    } catch { api(`/api/papers/${id}/read`, {method: 'POST'}).catch(() => {}); }

  const PAGE = 40;
  const dp = $('#discover-pop');
  if (dp) dp.hidden = true;   // 切论文关掉「找相关」浮层，避免新论文配旧数据
  syncSynBackBtn('reader');   // 从综述证据跳进来时（不经 switchPage）也要更新返回键
  const d = await api(`/api/papers/${id}?offset=0&limit=${PAGE}`);
  state.current = d.paper; state.blocks = d.blocks;
  state._blkTotal = d.total ?? d.blocks.length;
  state._blkOffset = d.blocks.length;
  state._blkPage = PAGE;
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
    $('#pdf-host').innerHTML = `<div style="color:#aab;margin:40px auto;text-align:center;font-size: var(--fs-base)">
      ${icon('warn')} 本篇无 PDF 预览（URL/Office 导入）<br>右侧解析内容与问答功能正常</div>`;
  }
  // 解析内容 + 双语（先清掉上一篇的残留，避免串页）
  state.pairs = []; state.versions = []; state.assets = null;
  state._biTotal = 0; state._biOffset = 0;
  api(`/api/papers/${id}/assets`).then(d => {
    if (state.current?.id !== id) return;   // 已切到别的论文：丢弃迟到响应（否则 A 的图表数据污染 B）
    state.assets = d;
    if (['orig', 'bilingual', 'zh'].includes(state.view)) renderContentView();   // 聚合就绪→升级原图裁剪
  }).catch(() => {});
  state._refs = null;   // 引用缓存随论文重置
  state._cite = null;   // 引用文本缓存（{styles, labels, default}）
  state._citeRendered = null;   // 引用渲染缓存同样跨篇作废（防复制到上一篇的引用）
  state.citeStyle = localStorage.getItem('ps-cite-style') || 'gbt7714';
  state._metaEdit = false;   // 文献信息卡的内联编辑态
  state.showLayout = false; $('#layout-btn')?.classList.remove('on');   // 布局框不跨篇残留
  // 懒加载双语：不再 openPaper 预拉全文对照（en+zh 300-500KB/次切论文，90% 场景只看 PDF/原文）。
  // translated 标志由 refreshJobState（jobstate 接口）带回；真正切到双语/中文视图时才拉（见 switchView 钩子）。
  state.pairs = [];           // 清上一篇残留，防串台
  state._biLoadedFor = null; state._biLoading = null;   // 懒拉哨兵同篇解绑（renderContentView 的自愈按当前篇重新拉）
  refreshJobState().then(() => {
    // state.view 可能残留上一篇的子视图（bilingual/zh/meta…），不能用它判断「无偏好」——
    // 用持久化的 rpane.readingView；残留视图的渲染由 renderContentView 的自愈兜底
    if (state.translatedComplete && (state.view ?? 'orig') === 'orig'
        && (state.rpane.readingView || 'orig') === 'orig') {
      // 有完整译文且用户无特定子视图偏好 → 默认进双语（懒拉在 switchView 内触发）
      switchView('read', 'bilingual');
    } else {
      renderContentView();
    }
    restorePos(id);
    window.loadAnnotations?.();   // 个人标注高亮/批注区渲染
  }).catch(() => { renderContentView(); });
  // 问答 scope 跟随当前论文（用户显式多选了其他论文则保留）
  if (state.qaPapers.size <= 1) {
    state.qaPapers.clear(); state.qaPapers.add(id);
  }
  renderQaTab();   // dock 常驻：切论文时同步会话内容
}
async function renderPage(opts = {}) { /* 连续模式入口：滚动到当前页并维护覆盖层 */
  await pdfEnsureAll();
  pdfScrollToPage(state.pageNum, opts.noFollow);
}
let _pdfBuilt = null;   // {pid, scale, wrappers:Map}
async function pdfEnsureAll() {
  if (!state.pdfDoc) return;
  const pid = state.current?.id;
  if (_pdfBuilt && _pdfBuilt.pid === pid && _pdfBuilt.scale === state.scale) return;
  // 仅倍率变化（拖动分栏 / 缩放）：原地更新尺寸，不重建页面骨架——避免整页重绘闪烁
  if (_pdfBuilt && _pdfBuilt.pid === pid) { await _pdfRescale(); return; }
  const host = $('#pdf-host');
  if (!host) return;
  host.innerHTML = '';
  const wraps = new Map();
  _pdfBuilt = {pid, scale: state.scale, wraps};
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
    if (!w) continue;   // 换文档竞态（切论文时 numPages 变化）→ 该页骨架已不存在，跳过
    const ph = w.querySelector('.pdf-ph');
    if (ph) ph.style.height = Math.round(vp.height) + 'px';
    state.pdfDoc[`pgvp_${i}`] = vp;
  }
  // 懒渲染观察器：进入视口即渲染该页（画布+文字层+覆盖层）
  if (state._pdfObs) state._pdfObs.disconnect();
  state._pdfObs = new IntersectionObserver(async entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const wrap = en.target;
      // 倍率变了也要重绘（否则旧尺寸画布留在页面上）
      if (!wrap.dataset.rendered || wrap._scale !== state.scale) {
        wrap.dataset.rendered = '1';
        await renderOneWrap(wrap);
      }
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
  updateZoomLabel();
}
/* 倍率变化：只更新占位高度 + 重绘当前可见页（DOM 骨架不动，滚动位置保持） */
let _pdfFitBusy = false, _pdfFitPending = false;
async function _pdfRescale() {
  if (_pdfFitBusy) { _pdfFitPending = true; return; }   // 拖拽时可能重入：合并到下一次
  _pdfFitBusy = true;
  try {
    const b = _pdfBuilt; if (!b) return;
    const host = $('#pdf-host');
    const cur = b.wraps.get(state.pageNum - 1);
    const oldTop = cur?.offsetTop ?? 0, oldScroll = host.scrollTop;
    b.scale = state.scale;
    for (let i = 1; i <= state.pdfDoc.numPages; i++) {
      const pg = await state.pdfDoc.getPage(i);
      const vp = pg.getViewport({scale: state.scale});
      state.pdfDoc.pgHeights[i-1] = vp.height;
      state.pdfDoc[`pgvp_${i}`] = vp;
      const ph = b.wraps.get(i - 1)?.querySelector('.pdf-ph');
      if (ph) ph.style.height = Math.round(vp.height) + 'px';
    }
    // 视口内的页立即按新倍率重绘；视口外的页滚进来时由观察器重绘
    const hr = host.getBoundingClientRect();
    for (const w of b.wraps.values()) {
      if (!w.dataset.rendered) continue;
      const r = w.getBoundingClientRect();
      if (r.bottom > hr.top - 200 && r.top < hr.bottom + 200) await renderOneWrap(w);
    }
    // 保持当前页在视口中的相对位置（高度变化不引起跳动）
    const newTop = cur?.offsetTop ?? 0;
    host.scrollTop = Math.max(0, oldScroll - oldTop + newTop);
    updateZoomLabel();
  } finally {
    _pdfFitBusy = false;
    if (_pdfFitPending) { _pdfFitPending = false; _pdfRescale(); }
  }
}
function updateZoomLabel() {
  const el = $('#zoom-label');
  if (el) el.textContent = Math.round(state.scale * 100) + '%';
}
async function renderOneWrap(wrap) {
  if (!wrap) return;
  const idx = +wrap.dataset.page;
  const page = await state.pdfDoc.getPage(idx + 1);
  const vp = page.getViewport({scale: state.scale});           // CSS 尺寸：覆盖层/文字层/点击命中都用它
  const ds = dprFor(vp.width, vp.height, MAX_PAGE_PX);
  const rvp = page.getViewport({scale: state.scale * ds});     // 位图尺寸：按 DPR 提分辨率
  const host0 = $('#pdf-host'); host0.style.setProperty('--scale-factor', state.scale);
  wrap.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(rvp.width); canvas.height = Math.floor(rvp.height);
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  wrap.appendChild(canvas);
  await page.render({canvasContext: canvas.getContext('2d'), viewport: rvp}).promise;
  wrap._vp = vp; wrap._pageObj = page; wrap._scale = state.scale;
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
  // 高亮框：当前激活块（跨页段落会在它的每一页各画一个框），颜色与右侧激活块同色
  const active = $('.blk.active');
  $$('.hl-rect', wrap).forEach(x => x.remove());
  if (active && active.dataset.bbox && active.dataset.bbox !== '') {
    const ab = state.blocks.find(x => x.block_id === active.dataset.bid);
    const hc = typeColor(ab ? ab.type : 'text');
    for (const {box: b, page} of parseBoxPages(active.dataset.bbox, active.dataset.bboxPages, ab)) {
      if (page !== idx) continue;   // 该框属于别的页（跨页段落）
      const r = document.createElement('div');
      r.className = 'hl-rect';
      r.style.borderColor = hc;
      r.style.background = hc + '2e';
      r.style.left = (b[0]*vp.width)+'px'; r.style.top = (b[1]*vp.height)+'px';
      r.style.width = ((b[2]-b[0])*vp.width)+'px'; r.style.height = ((b[3]-b[1])*vp.height)+'px';
      wrap.appendChild(r);
    }
  }
  // 布局框：跨页段落的框按 bbox_pages 画到各自的页上
  $$('.layout-rect', wrap).forEach(x => x.remove());
  if (state.showLayout) {
    const colors = {text: '#4a6cf7', title: '#8a5cf6', equation: '#e6a23c',
                    table: '#2eaa6e', image: '#e0528f', ref_text: '#8a93b0'};
    state.blocks.filter(b => b.bbox).forEach(b => {
      for (const {box: bb, page} of parseBoxPages(b.bbox, b.bbox_pages, b)) {
        if (page !== idx) continue;
        const r = document.createElement('div');
        r.className = 'layout-rect';
        r.style.left = (bb[0]*vp.width)+'px'; r.style.top = (bb[1]*vp.height)+'px';
        r.style.width = ((bb[2]-bb[0])*vp.width)+'px'; r.style.height = ((bb[3]-bb[1])*vp.height)+'px';
        r.style.borderColor = colors[b.type] || '#9aa3bd';
        r.title = `${b.type}`;
        wrap.appendChild(r);
      }
    });
  }
  // 定位闪烁框（点引文跳转到的那一块）：由 state._flashBlock 驱动，
  // 重绘时补画——页重渲染会 innerHTML='' 清空，直接 append 会被抹掉
  const fb = state._flashBlock;
  if (fb && fb.until > Date.now()) {
    const fblk = state.blocks.find(x => x.block_id === fb.bid);
    if (fblk) {
      const fc = typeColor(fblk.type);
      for (const {box: b, page} of parseBoxPages(fblk.bbox, fblk.bbox_pages, fblk)) {
        if (page !== idx) continue;
        const r = document.createElement('div');
        r.className = 'hl-rect hl-flash';
        r.style.borderColor = fc; r.style.background = fc + '30';
        r.style.left = (b[0]*vp.width)+'px'; r.style.top = (b[1]*vp.height)+'px';
        r.style.width = ((b[2]-b[0])*vp.width)+'px'; r.style.height = ((b[3]-b[1])*vp.height)+'px';
        wrap.appendChild(r);
      }
    }
  }
}
/* 块 bbox 统一解析：DB 存的是扁平 [x0,y0,x1,y1]；兼容列表 [[...],[...]]（跨栏/跨页段落）。
   注意：不要直接对扁平数组用 .forEach 取框——那会把 4 个数字当框迭代，算出 NaN 尺寸。
   返回 [[x0,y0,x1,y1], ...]（保持旧形状，多数调用点按数组解构）。 */
function parseBoxes(bbox) {
  if (!bbox) return [];
  let v; try { v = JSON.parse(bbox); } catch { return []; }
  if (!Array.isArray(v) || v.length === 0) return [];
  if (typeof v[0] === 'number') return v.length >= 4 ? [v] : [];
  return v.filter(b => Array.isArray(b) && b.length >= 4);
}
/* 带页码的框：跨页段落有多个框、分属不同页（bbox_pages 与 bbox 一一对应）。
   bbox_pages 缺省时所有框都落在 block.page_index。
   结果 memo 在块对象上（drawOverlays 每页×每块高频调用，免重复 JSON.parse）。 */
function parseBoxPages(bbox, bboxPages, blk) {
  if (blk && blk._boxes) return blk._boxes;
  const boxes = parseBoxes(bbox);
  let pages = null;
  if (bboxPages) { try { pages = JSON.parse(bboxPages); } catch { pages = null; } }
  if (!Array.isArray(pages)) pages = null;
  const dflt = blk && Number.isFinite(+blk.page_index) ? +blk.page_index : 0;
  const out = boxes.map((b, i) => ({box: b, page: (pages && pages[i] != null) ? +pages[i] : dflt}));
  if (blk) blk._boxes = out;
  return out;
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
$('#pg-prev').onclick = () => { if (state.pageNum > 1) { state.pageNum--; renderPage(); } };
$('#pg-next').onclick = () => { if (state.pdfDoc && state.pageNum < state.pdfDoc.numPages) { state.pageNum++; renderPage(); } };
// 手动缩放：走 _pdfRescale 轻量路径（不重建页面骨架），并退出宽度自适应
$('#zoom-in').onclick = () => { state.scale = Math.min(3, state.scale + 0.2); state.fitWidth = false; updateZoomLabel(); renderPage({noFollow: true}); };
$('#zoom-out').onclick = () => { state.scale = Math.max(0.5, state.scale - 0.2); state.fitWidth = false; updateZoomLabel(); renderPage({noFollow: true}); };
state.showLayout = false;
$('#layout-btn').onclick = () => {
  state.showLayout = !state.showLayout;
  $('#layout-btn').classList.toggle('on', state.showLayout);
  // 立即生效：只重画覆盖层（布局框），不重建位图、不触发滚动跳转
  redrawHl();
  ensureCurrentRendered();
};
/* 当前页若尚未渲染则补渲染（布局框/高亮依赖已渲染的页） */
function ensureCurrentRendered() {
  const w = _pdfBuilt?.wraps?.get(state.pageNum - 1);
  if (w && (!w.dataset.rendered || w._scale !== state.scale)) {
    w.dataset.rendered = '1';
    renderOneWrap(w);
  }
}
/* 右侧段落 → PDF：在该块所在页立即画高亮框（页未渲染则先渲染，渲染完自动带出）。
   跨页段落会在它涉及的每一页都画（每页各一个框）。 */
function highlightBlockOnPdf(blkEl) {
  const pg = parseInt(blkEl?.dataset.page ?? '-1');
  if (!Number.isFinite(pg) || pg < 0) return;
  // 收集该段落涉及的所有页（跨页段落：首段所在页 + 续文所在页）
  const pages = new Set([pg]);
  const blk = state.blocks.find(x => x.block_id === blkEl?.dataset.bid);
  if (blk) {
    for (const {page} of parseBoxPages(blk.bbox, blk.bbox_pages, blk)) pages.add(page);
  }
  let needsRedraw = false;
  for (const p of pages) {
    const wrap = _pdfBuilt?.wraps?.get(p);
    if (!wrap) continue;
    if (wrap.dataset.rendered !== '1' || wrap._scale !== state.scale) {
      wrap.dataset.rendered = '1';
      renderOneWrap(wrap);      // 未渲染 → 渲染完成后 drawOverlays 会画出高亮
    } else {
      needsRedraw = true;
    }
  }
  if (needsRedraw) redrawHl();   // 已渲染 → 直接重画覆盖层（不重绘位图）
}

/* 内容视图（统一走 switchView，保证 mainView/view 两级状态一致） */
$$('.view-tabs [data-v]').forEach(b => b.onclick = () => switchView(b.dataset.v));
async function loadBilingual(id, render = true) {
  try {
    const d = await api(`/api/papers/${id}/bilingual`);
    if (state.current?.id !== id) return;   // 已切到别的论文：丢弃迟到响应（防串页，同 assets 拉取守卫）
    state.pairs = d.pairs; state.versions = d.versions;
    state._biLoadedFor = id;
    if (render) renderContentView();
  } catch { if (state.current?.id === id) state.pairs = []; }
}
/* 译文版本切换控件已移除（历史版本保留在库，如需回溯可导出对照 MD） */
/* 解析/翻译控制按钮：按论文实时 jobstate 切换 */
function renderJobButtons(js) {
  // 重新解析按钮（挂在主级页签行）
  let extra = $('#parse-ctrl');
  if (!extra) {
    extra = document.createElement('button');
    extra.id = 'parse-ctrl'; extra.className = 'btn small';
    extra.onclick = parseCtrl;
    $('.view-tabs').appendChild(extra);
  }
  if (js.parsing) {
    extra.innerHTML = icon('stop') + " 取消解析"; extra.classList.add('danger');
  } else if (js.parse_status === 'failed') {
    extra.innerHTML = icon('play') + " 重新解析"; extra.classList.remove('danger');
  } else {
    extra.innerHTML = icon('retry') + " 重新解析"; extra.classList.remove('danger');
  }
  renderProgressStrip(js);
}
function renderProgressStrip(js) {
  const strip = $('#job-progress');
  const tp = js.translate_progress, pp = js.parse_progress;
  if (tp) {
    const st = tp.status === 'queued' ? '排队中' : '翻译中';
    const pct = tp.total ? Math.round(100 * tp.done / tp.total) : 0;
    strip.hidden = false;
    strip.innerHTML = `<span>${st} ${tp.done}/${tp.total} 段</span>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <button class="btn small danger" onclick="cancelTranslate()">${icon('stop')} 取消</button>`;
  } else if (pp) {
    strip.hidden = false;
    strip.innerHTML = `<span>${pp.status === 'queued' ? '解析排队中（GPU 队列）' : pp.status === 'pending_gate' ? '排队等待解析资源（通常 1-3 分钟/篇）…' : '解析中'}</span>
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
  return true;
}
async function parseCtrl() {
  const pid = state.current.id;
  const js = await api(`/api/papers/${pid}/jobstate`);
  if (js.parsing) {
    if (!(await uiConfirm('取消解析当前论文？', {title: '取消解析'}))) return;
    await api(`/api/papers/${pid}/cancel-parse`, {method: 'POST'});
    toast('解析已取消');
  } else {
    await api(`/api/papers/${pid}/parse`, {method: 'POST'});
    toast('解析任务已开始（插队执行）');
  }
  refreshJobState(); loadPapers();
}
window.parseCtrl = parseCtrl;   // 内联 onclick 在全局作用域求值，模块函数需显式挂 window
async function startTranslate() {
  if (!state.current?.id) { toast('先在左侧列表打开一篇论文'); return; }
  try {
    const r = await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [state.current.id]})});
    toast(r.skipped_in_flight?.length ? '该论文已有译文/已在队列，无需重复' : '翻译任务已加入队列');
  } catch (e) { toast(friendlyError(e, '翻译失败，请检查 LLM key 与队列状态')); }
  refreshJobState();
}
window.startTranslate = startTranslate;
async function cancelTranslate() {
  if (!(await uiConfirm('取消翻译当前论文？（已完成段落会保留）', {title: '取消翻译'}))) return;
  await api(`/api/papers/${state.current.id}/cancel-translate`, {method: 'POST'});
  toast('翻译已取消');
  refreshJobState();
}
window.cancelTranslate = cancelTranslate;
/* 翻译进行中轮询：完成自动刷新视图（循环内存活检查——切论文即终止） */
let watching = null;
let watchingPid = null;
function watchTranslation() {
  clearInterval(watching);
  watchingPid = state.current?.id ?? null;
  watching = setInterval(async () => {
    if (document.hidden) return;   // 后台标签页暂停轮询（badge/health 同款守卫）
    if (!state.current || state.current.id !== watchingPid) {   // 已切到别的论文 → 停止轮询
      clearInterval(watching); watchingPid = null; return;
    }
    try {
      const js = await api(`/api/papers/${watchingPid}/jobstate`);
      if (!state.current || state.current.id !== watchingPid) return;
      state.translatingNow = js.translating;
      if (!js.translating && js.translated) {   // 真正完成（非部分译文）
        clearInterval(watching); toast('翻译完成 ✓');
        state.translatedComplete = true;
        const d = await api(`/api/papers/${watchingPid}/bilingual`);
        state.versions = d.versions; state.pairs = d.pairs;
        if (state.view !== 'zh') switchView('read', 'bilingual'); else renderContentView();
      }
      refreshJobState();
    } catch { /* 网络/会话抖动：下轮再试 */ }
  }, 4000);
}
window.updateQaBtn = () => {
  const b = $('#qa-open');
  if (!b) return;
  b.classList.toggle('on', !!state.qaOpen);
  b.title = state.qaOpen ? '隐藏论文问答框' : '显示论文问答框（Ctrl+Q）';
};
