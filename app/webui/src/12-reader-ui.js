/* ===== 12-reader-ui.js —— 阅读器交互：追问/目录/分栏/高亮/主题 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
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
  // 模型生成的 followups（每篇内容定制）优先；缺失时回退通用模板
  const custom = (sections?.followups || '').split(/\n|；|;/).map(x => x.replace(/^[-*\d.、)\s]+/, '').trim())
    .filter(x => x.length >= 6).slice(0, 3);
  const qs = custom.length ? custom
    : Object.keys(sections || {}).map(k => FOLLOWUP_QS[k]).filter(Boolean).slice(0, 5);
  if (!qs.length) return '';
  return `<div class="followups"><span class="muted" style="font-size: var(--fs-sm)">${icon('chat')} 可以接着问：</span>` +
    qs.map(q => `<button class="chip chip-q" onclick="askPreset('${jsArg(q)}')">${esc(q)}</button>`).join('') +
    `</div>`;
}

/* ================= 四项借鉴功能 ================= */

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
    const el = e.target.closest && e.target.closest('.ref-cite, .cite[data-n], .cite[data-gid]');
    const p = ensurePop();
    if (!el) { p.hidden = true; return; }
    // 证据引文（问答回答 [n] / 导读 [n]）：悬停预览来源原文片段
    if (!el.classList.contains('ref-cite')) {
      const ev = el._ev;
      if (!ev) { p.hidden = true; return; }
      const snippet = (ev.text || '').replace(/\s+/g, ' ').trim();
      p.innerHTML = `<b>${esc((ev.title || ev.paper_id || '').slice(0, 60))}</b>
        <span class="muted" style="font-size: var(--fs-xs)">· 第${ev.page_index + 1}页</span>
        <div style="margin-top:4px">${esc(snippet.slice(0, 220))}${snippet.length > 220 ? '…' : ''}</div>
        <div class="muted" style="font-size: var(--fs-xs);margin-top:4px">${icon('doc')} 点击定位原文</div>`;
      p.hidden = false;
      const r = el.getBoundingClientRect();
      p.style.left = Math.min(r.left, innerWidth - 340) + 'px';
      p.style.top = (r.bottom + 6 > innerHeight - 160 ? r.top - p.offsetHeight - 6 : r.bottom + 6) + 'px';
      return;
    }
    if (!state.current) return;
    await loadRefs(state.current.id);
    const n = +el.dataset.n;
    const ref = (state._refs || [])[n - 1];
    if (!ref) { p.hidden = true; return; }
    p.innerHTML = `<b>[${n}]</b> ${esc(ref.text.slice(0, 220))}${ref.text.length > 220 ? '…' : ''}
      <div class="muted" style="font-size: var(--fs-xs);margin-top:4px">${icon('doc')} 第${ref.page_index + 1}页 · 点击跳转</div>`;
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

/* ---- ④ 目录导航 + 阅读位置记忆 ---- */
window.toggleToc = () => {
  let t = $('#toc-panel');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toc-panel'; t.hidden = true;
    $('.pane-right').appendChild(t);
    outsideClose(t, $('#toc-btn'));
  }
  if (t.hidden) {
    const seen = new Set(); const items = [];
    for (const b of state.blocks) {
      const sp = b.section_path || '';
      if (!sp || seen.has(sp)) continue;
      seen.add(sp);
      items.push(`<div class="toc-item" data-page="${b.page_index}" data-bid="${b.block_id}">${esc(sp.split(' > ').pop())}</div>`);
    }
    t.innerHTML = `<div class="toc-head">目录 <button class="btn small" onclick="toggleToc()">${icon('close')}</button></div>` +
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
    const caps = [];
    if (fig && fig.caption) caps.push(fig.caption);
    (subCaps || []).forEach(c => c && caps.push(c));
    return `<figure class="inline-fig ${ub ? 'fig-crop' : ''}" ${ub ? `data-page="${b.page_index}" data-ub='${JSON.stringify(ub)}'` : ''}>
      <div class="fig-holder">${fb.map((n, i) => `<img loading="lazy" src="/api/papers/${pid}/images/${n}"${i === 0 && caps.length ? ` alt="${esc(caps.join(' ｜ ').slice(0, 120))}"` : ' alt=""'}>`).join('')}</div>
      ${caps.length ? `<figcaption class="muted" style="font-size:var(--fs-xs);line-height:1.5">${esc(caps.join(' ｜ ').slice(0, 300))}</figcaption>` : ''}
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
    const boxes = parseBoxes(b.bbox);
    const ub = boxes.length ? [Math.min(...boxes.map(x=>x[0])), Math.min(...boxes.map(x=>x[1])),
                               Math.max(...boxes.map(x=>x[2])), Math.max(...boxes.map(x=>x[3]))] : null;
    if (!ub) return fallback;
    const bbs = (b.bbox || '').replace(/\s/g, '');
    const ta = (state.assets?.tables || []).find(t =>
      t.page_index === b.page_index && JSON.stringify(t.bbox) === bbs);
    return `<figure class="fig-crop tbl-crop" data-page="${b.page_index}" data-ub='${JSON.stringify(ub)}'>
      <div class="fig-holder">${fallback}</div>
      ${ta && ta.caption ? `<figcaption class="muted" style="font-size:var(--fs-xs);line-height:1.5">${esc(ta.caption.slice(0, 200))}</figcaption>` : ''}
    </figure>`;
  }
  return mdLite(b.en !== undefined ? b.en : b.text);   // mdLite 已含 esc+katexify+linkifyRefs，并解析 markdown 表格
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
    let bboxes; try { bboxes = parseBoxes(blk.dataset.bbox); } catch { return; }
    if (!bboxes.length) return;
    const vp = wrap._vp;
    const made = [];
    for (const b of bboxes) {     // 跨栏合并块有多框，逐框画
      const r = document.createElement('div');
      r.className = 'hl-rect hl-hover';
      r.style.left = (b[0]*vp.width)+'px'; r.style.top = (b[1]*vp.height)+'px';
      r.style.width = ((b[2]-b[0])*vp.width)+'px'; r.style.height = ((b[3]-b[1])*vp.height)+'px';
      wrap.appendChild(r);
      made.push(r);
    }
    tmp = made.length === 1 ? made[0] : { remove: () => made.forEach(x => x.remove()) };
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest && e.target.closest('.blk')) clear();
  });
  // 滚动/渲染时清除，防止蓝框滞留
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
    sr.hidden = false; sr.innerHTML = icon('chevL') + " 显示 PDF"; sr.onclick = () => { state.sideMode = 'both'; localStorage.setItem('ps-side', 'both'); applyVsplit(); };
  } else if (mode === 'pdf') {      // 只看 PDF
    pl.style.width = '100%'; pl.style.borderRight = 'none';
    vh.style.display = 'none';
    sr.hidden = false; sr.innerHTML = "显示文字 " + icon('chevR'); sr.onclick = () => { state.sideMode = 'both'; localStorage.setItem('ps-side', 'both'); applyVsplit(); };
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
    // 适配宽度时不再按 0.05 粒度舍入（舍入会白白丢掉几个百分点分辨率），改用 0.001 精度
    if (Math.abs(s - state.scale) > 0.002) {
      state.scale = Math.round(s * 1000) / 1000;
      pdfEnsureAll();      // 轻量重排：只改尺寸 + 重绘可见页，不重建骨架、不跳滚动
    }
  });
};

/* ---- 右栏整体折叠 / 展开（参考 MinerU 官网：收起后右侧留一条可点的窄边） ---- */
state.rpaneCollapsed = localStorage.getItem('ps-rpane-collapsed') === '1';
window.applyRpaneCollapse = () => {
  const reader = $('.reader');
  if (!reader) return;
  reader.classList.toggle('rpane-collapsed', state.rpaneCollapsed);
  const rs = $('#rpane-restore');
  if (rs) rs.hidden = !state.rpaneCollapsed;
  const cb = $('#rpane-collapse');
  if (cb) { cb.innerHTML = state.rpaneCollapsed ? icon('dblL') : icon('dblR'); cb.title = state.rpaneCollapsed ? '展开右栏' : '收起右栏（只留 PDF）'; }
  // 右栏宽度变了 → PDF 重新按新宽度适配
  if (state.pdfDoc && state.fitWidth) setTimeout(() => window.fitPdf?.(), 80);
};
$('#rpane-collapse').onclick = () => {
  state.rpaneCollapsed = !state.rpaneCollapsed;
  localStorage.setItem('ps-rpane-collapsed', state.rpaneCollapsed ? '1' : '0');
  applyRpaneCollapse();
  if (state.rpaneCollapsed) toast('右栏已收起（阅读与问答都在右栏）· 点屏幕最右侧的「« 展开右栏」恢复', 4500);
};
$('#rpane-restore').onclick = () => {
  state.rpaneCollapsed = false;
  localStorage.setItem('ps-rpane-collapsed', '0');
  applyRpaneCollapse();
};
applyRpaneCollapse();
(() => {
  const h = $('#v-handle');
  let dragging = false;
  let dragFitAt = 0;
  h.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = $('.reader').getBoundingClientRect();
    const pct = Math.min(99, Math.max(1, Math.round(100 * (e.clientX - r.left) / r.width)));
    if (pct !== state.vsplit) {
      state.vsplit = pct;
      applyVsplit(false);                  // 先只改栏宽（CSS，立即生效）
      // PDF 跟随栏宽重排：节流 ~12fps，避免每次 mousemove 触发整页重绘
      const now = Date.now();
      if (now - dragFitAt > 80) { dragFitAt = now; fitPdf(); }
    }
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      localStorage.setItem('ps-vsplit', String(state.vsplit));
      fitPdf();                            // 收尾精确对齐
    }
  });
  h.addEventListener('dblclick', () => {
    state.vsplit = 50; localStorage.setItem('ps-vsplit', '50');
    state.fitWidth = true; applyVsplit(); toast('已复位 50/50');
  });
  // 手动缩放 = 退出自适应；窗口变化重适配
  const zi = $('#zoom-in'), zo = $('#zoom-out');
  if (zi) zi.addEventListener('click', () => state.fitWidth = false);
  if (zo) zo.addEventListener('click', () => state.fitWidth = false);
  window.addEventListener('resize', debounce(() => {
    applyVsplit();
    // ≤1100 自动收起侧栏（缩放/分屏场景；仅自动收放，不改写用户手动偏好）
    const narrow = innerWidth < 1100;
    if (narrow && !state.sidebarCollapsed && !state._autoFolded) {
      state._autoFolded = true; state.sidebarCollapsed = true; applySidebarCollapse();
    } else if (!narrow && state._autoFolded) {
      state._autoFolded = false; state.sidebarCollapsed = false; applySidebarCollapse();
    }
  }, 250));
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
  if (t) t.placeholder = '对着文献提问…（Ctrl+Enter 发送）';
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
      // 裁剪倍率：显示宽度 × DPR（HiDPI 才够清晰）；再按整页像素预算封顶，防止高倍渲染爆内存
      const want = Math.max(2, targetW * Math.min(window.devicePixelRatio || 1, 2) / Math.max(1, rw));
      const cap = Math.sqrt(MAX_CROP_PX / Math.max(1, base.width * base.height));
      const scale = Math.min(want, cap);
      const vp = page.getViewport({scale});
      const full = document.createElement('canvas');
      full.width = Math.floor(vp.width); full.height = Math.floor(vp.height);
      await page.render({canvasContext: full.getContext('2d'), viewport: vp}).promise;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(rw * scale)); out.height = Math.max(1, Math.round(rh * scale));
      out.getContext('2d').drawImage(full,
        rx * scale, ry * scale, rw * scale, rh * scale,
        0, 0, out.width, out.height);
      const url = out.toDataURL('image/png');
      const alt = esc((fig.querySelector('figcaption')?.textContent || '').slice(0, 120));
      holder.innerHTML = `<img src="${url}" alt="${alt}" ondblclick="lightbox(this.src, '')">`;
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
    // 命中：该页所有 bbox 中包含点、面积最小者（最内层块）；跨栏合并块有多框，逐框判
    let hit = null, hitArea = 1e9;
    for (const b of state.blocks) {
      if (b.page_index !== pg || !b.bbox) continue;
      for (const [x0, y0, x1, y1] of parseBoxes(b.bbox)) {
        if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
          const area = (x1 - x0) * (y1 - y0);
          if (area < hitArea) { hit = b; hitArea = area; }
        }
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

/* ===== PDF 定位：滚到块所在页 + 在该块上画闪烁高亮框 ===== */
/* 跨页段落：框分属多页 → 每页各画一个（按 bbox_pages 归位）。
   闪烁状态放在 state._flashBlock，页重渲染时由 drawOverlays 补画。 */
window.pdfFlashBlock = async b => {
  if (!b || !state.pdfDoc) return;
  await pdfEnsureAll();
  const boxes = parseBoxPages(b.bbox, b.bbox_pages, b);
  // 涉及的页先渲染出来（否则高亮框没地方画）
  for (const {page} of boxes) {
    const wrap = _pdfBuilt && _pdfBuilt.wraps.get(page);
    if (wrap && (wrap.dataset.rendered !== '1' || wrap._scale !== state.scale)) {
      wrap.dataset.rendered = '1';
      await renderOneWrap(wrap);
    }
  }
  state._flashBlock = {bid: b.block_id, until: Date.now() + 2600};
  redrawHl();
  setTimeout(() => {
    if (state._flashBlock && state._flashBlock.until <= Date.now()) {
      state._flashBlock = null;
      redrawHl();
    }
  }, 2700);
  // 滚动到块所在的首个页面
  const first = boxes.length ? boxes[0].page : b.page_index;
  const wrap0 = _pdfBuilt && _pdfBuilt.wraps.get(first);
  if (wrap0) {
    state._suppressFollow = true;
    wrap0.scrollIntoView({ block: 'center' });
    setTimeout(() => { state._suppressFollow = false; }, 350);
  }
  state.pageNum = first + 1;
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
  // 提问按钮 tooltip 承诺的快捷键：Ctrl+Q 开关问答框（与提问键同语义）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    const wasReader = $('#page-reader') && $('#page-reader').style.display !== 'none';
    switchPage('reader');
    if (wasReader && state.qaOpen) closeQa();
    else openQaDock();
  }
});
// Esc 统一关闭所有浮层（原先只有灯箱响应 Esc）
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  let closed = false;
  for (const sel of ['#acc-pop', '#filter-pop', '#download-pop',
                     '#discover-pop', '#col-new-form', '#health-pop']) {
    const el = document.querySelector(sel);
    if (el && !el.hidden) { el.hidden = true; closed = true; }
  }
  if (closed) e.stopPropagation();
});

/* ---- 深色模式切换 ---- */
state.theme = localStorage.getItem('ps-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
window.applyTheme = () => {
  document.documentElement.dataset.theme = state.theme;
  const b = $('#theme-btn');
  if (b) {
    b.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
    b.title = state.theme === 'dark' ? '切换浅色' : '切换深色';
  }
};
$('#theme-btn').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ps-theme', state.theme);
  applyTheme();
};
applyTheme();

/* 阅读页键盘：←/→ 翻页、+/- 缩放（输入框聚焦时不响应） */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.mainView !== 'read' || !state.pdfDoc) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('#pg-prev')?.click(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); $('#pg-next')?.click(); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); $('#zoom-in')?.click(); }
  else if (e.key === '-') { e.preventDefault(); $('#zoom-out')?.click(); }
});

$('#toc-btn').onclick = () => toggleToc();

window.addSubLib = async pid => {
  const name = await uiPrompt('新建子库', {placeholder: '子库名称', okText: '创建'});
  if (!name?.trim()) return;
  try {
    await api('/api/collections', {method: 'POST', body: JSON.stringify({name: name.trim(), parent_id: pid})});
    toast('子库已创建'); await refreshLib();
  } catch (e) { toast('创建失败: ' + e.message); }
};

window.emptyTrash = async () => {
  const n = (state._trashCount ?? 0);
  if (!(await uiConfirm(
      `将<strong>永久删除</strong>回收站中的 ${n} 篇论文（含译文、索引与会话），<strong>不可恢复</strong>。`,
      {title: '彻底清空回收站', okText: `永久删除 ${n} 篇`, danger: true}))) return;
  try {
    const r = await api('/api/trash/empty', {method: 'POST'});
    toast(`已彻底删除 ${r.purged} 篇`);
    renderTrash(); await refreshLib();
  } catch (e) { toast(friendlyError(e, '清空失败，请重试')); }
};

/* 增量加载解析块（滚动到底自动续拉；只追加新行，不全量重渲染） */
window.loadMoreBlocks = async () => {
  if (!state.current || state._blkOffset >= (state._blkTotal || 0)) return;
  if (state._blkLoading) return;   // 防滚动事件重复触发
  state._blkLoading = true;
  try {
    const id = state.current.id;
    const d = await api(`/api/papers/${id}?offset=${state._blkOffset}&limit=${state._blkPage}`);
    if (!d.blocks.length) { state._blkTotal = state._blkOffset; $('#load-more-hint')?.remove(); return; }
    state.blocks = state.blocks.concat(d.blocks);
    state._blkOffset += d.blocks.length;
    if (state.view === 'orig') {
      const hasMore = state._blkOffset < (state._blkTotal || 0);
      appendRows(d.blocks.filter(b => !CHROME_TYPES.includes(b.type)).map(blockRowHtml).join(''),
                 hasMore, `${state._blkOffset}/${state._blkTotal}`);
    } else {
      renderContentView();
    }
  } finally { state._blkLoading = false; }
};
window.loadMorePairs = async () => {
  if (!state.current || !(state._biTotal > state._biOffset)) return;
  if (state._biLoading) return;
  state._biLoading = true;
  try {
    const id = state.current.id;
    const d = await api(`/api/papers/${id}/bilingual?offset=${state._biOffset}&limit=40`);
    if (!d.pairs.length) { state._biTotal = state._biOffset; $('#load-more-hint')?.remove(); return; }
    state.pairs = state.pairs.concat(d.pairs);
    state._biOffset += d.pairs.length;
    if (state.view === 'bilingual') {
      const hasMore = state._biOffset < (state._biTotal || 0);
      appendRows(d.pairs.flatMap(pairRowsHtml).join(''), hasMore, `${state._biOffset}/${state._biTotal}`);
    } else {
      renderContentView();   // zh 视图整表依赖 pairs 过滤，全量重建（纯文本，代价低）
    }
  } finally { state._biLoading = false; }
};

/* ================= 文库管理：第一层 = 库列表 ================= */
function libLevel1Html(d) {
  const st = state._statuses || {};
  const children = {};
  d.collections.forEach(c => (children[c.parent_id || 'root'] ||= []).push(c));
  // 卡片：父库大卡 + 子库缩进嵌套其内（层级一眼可见）
  const cardOf = (c, isChild) => {
    const papers = c.papers ?? 0;
    const kids = children[c.id] || [];
    const depth = treeDepth(c.id);
    const doneTr = st[c.id]?.translated ?? 0;
    return `<div class="lib-card-l1 ${isChild ? 'child' : ''}" onclick="libOpenLib('${c.id}')">
      <div class="lc1-icon">${icon('folder')}</div>
      <div class="lc1-main">
        <div class="lc1-name" title="${esc(c.name)}">${esc(c.name)}</div>
        <div class="lc1-meta">${papers} 篇${kids.length ? ` · ${kids.length} 个子库` : ''}${doneTr ? ` · 已译 ${doneTr}` : ''}</div>
        ${kids.length ? `<div class="lc1-subs">${kids.slice(0, 2).map(k =>
          `<span class="lc1-sub" onclick="event.stopPropagation();libOpenLib('${k.id}')">${icon('folder')} ${esc(k.name)} <b>${k.papers ?? 0}</b></span>`).join('')
        }${kids.length > 2 ? `<span class="lc1-sub" onclick="event.stopPropagation();libOpenLib('${c.id}')" title="展开查看全部子库">+${kids.length - 2}</span>` : ''}</div>` : ''}
      </div>
      <div class="lc1-ops" onclick="event.stopPropagation()">
        <button class="btn small" onclick="libUpload('${c.id}')" title="上传到此库">${icon('upload')}</button>
        <button class="btn small" onclick="addSubLib('${c.id}')" ${depth >= 2 ? 'disabled title="最多三级"' : ''} title="新建子库">${icon('plus')}</button>
        <button class="btn small" onclick="renameLib('${c.id}', '${jsArg(c.name)}')" title="重命名">${icon('edit')}</button>
        <button class="btn small danger hover-only" onclick="delLib('${c.id}', '${jsArg(c.name)}')" title="删除库">${icon('trash')}</button>
      </div>
    </div>`;
  };
  const cards = (children['root'] || []).map(c => cardOf(c, false)).join('');
  const total = d.total;
  const myPapers = (d.collections || []).reduce((n, c) => n + (c.papers_total ?? c.papers ?? 0), 0);
  return `<div class="card lib-l1-head">
      <h2 class="page-h row" style="flex:1">${icon('library')} 全部文献库 <span class="muted">${d.collections.length} 个库 · 在库 ${myPapers} 篇${(d.unassigned || 0) ? ` + 未分库 ${d.unassigned} 篇` : ''} = 共 ${total} 篇</span></h2>
      <div class="seg">
        <button class="seg-btn ${state.libView === 'card' ? 'on' : ''}" onclick="setLibView('card')">卡片</button>
        <button class="seg-btn ${state.libView === 'list' ? 'on' : ''}" onclick="setLibView('list')">列表</button>
      </div>
    </div>
    ${state.libView === 'card'
      ? `<div class="lib-cards">${cards || `<div class="empty-state">
          <p class="t">还没有文献库</p>
          <p style="margin-bottom:12px">用文献库把论文按主题分组（可建子库，最多三级）</p>
          <button class="btn primary" onclick="createLibFromPage()">${icon('plus')} 新建文献库</button>
        </div>`}</div>`
      : `<table class="list" style="margin-top:4px">
          <tr><th>库名</th><th>论文</th><th>子库</th><th></th></tr>
          ${(() => {
            // 树序遍历（父库紧跟其子库，缩进才对得上层级）——原先按 API 返回顺序平铺，
            // 子库排在前一个兄弟后面时会被误看成它的子库
            const kidsOf = cid => (children[cid] || [])
              .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
            const ordered = [];
            const walk = cid => { for (const k of kidsOf(cid)) { ordered.push(k); walk(k.id); } };
            walk('root');
            if (!ordered.length) return `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">
              还没有文献库 —— <button class="btn small primary" onclick="createLibFromPage()">${icon('plus')} 新建文献库</button></td></tr>`;
            return ordered.map(c => `<tr class="lib-row" onclick="libOpenLib('${c.id}')">
              <td>${'　'.repeat(treeDepth(c.id))}${icon('folder')} ${esc(c.name)}</td>
              <td>${c.papers ?? 0}</td><td>${(children[c.id] || []).length}</td>
              <td class="row-actions" onclick="event.stopPropagation()">
                <button class="btn small" title="上传到此库" onclick="libUpload('${c.id}')">${icon('upload')}</button>
                <button class="btn small" title="重命名" onclick="renameLib('${c.id}', '${jsArg(c.name)}')">${icon('edit')}</button>
                <button class="btn small danger hover-only" title="删除库" onclick="delLib('${c.id}', '${jsArg(c.name)}')">${icon('trash')}</button>
              </td></tr>`).join('');
          })()}
        </table>`}`;
}

function bindLibLevel1() {
  // 视图切换
  $$('.seg-btn').forEach(b => b.onclick = e => {
    e.stopPropagation();
    state.libView = b.textContent.trim() === '卡片' ? 'card' : 'list';
    renderCollectionsPage();
  });
}

window.setLibView = v => { state.libView = v; renderCollectionsPage(); };

/* ===== 下载菜单 ===== */
(() => {
  const pop = $('#download-pop'), btn = $('#download-btn');
  if (!pop || !btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      loadDlOptions();
      // fixed 定位：工具条 overflow-x:auto 会把 absolute 弹层裁掉——原先整框被剪到不可见
      anchorPop(pop, btn);
    }
  });
  outsideClose(pop, btn);
  $$('#download-pop .tp-item[data-dl]').forEach(it => it.addEventListener('click', () => {
    const fmt = it.dataset.dl;
    const pid = state.current?.id;
    if (!pid) { toast('请先打开一篇论文'); return; }
    if (it.classList.contains('disabled')) { toast(it.title || '该格式暂不可用（需先完成翻译/解析）'); return; }
    location.href = `/api/papers/${pid}/download/${fmt}`;
    pop.hidden = true;
  }));
  $('#dl-zip-btn')?.addEventListener('click', () => {
    const pid = state.current?.id;
    if (!pid) { toast('请先打开一篇论文'); return; }
    const items = $$('#download-pop input[data-zip]').filter(x => x.checked).map(x => x.dataset.zip);
    if (!items.length) { toast('至少勾选一项'); return; }
    location.href = `/api/papers/${pid}/download/zip?items=${items.join(',')}`;
    pop.hidden = true;
  });
})();

async function loadDlOptions() {
  const pid = state.current?.id;
  if (!pid) return;
  try {
    const o = await api(`/api/papers/${pid}/download-options`);
    const map = {pdf: 'pdf', md: 'md', bilingual_md: 'bilingual_md',
                 bilingual_pdf: 'bilingual_pdf', zh_pdf: 'zh_pdf', en_pdf: 'en_pdf'};
    $$('#download-pop .tp-item[data-dl]').forEach(it => {
      const avail = o[map[it.dataset.dl]];
      it.classList.toggle('disabled', !avail);
      it.title = avail ? '' : (o.translated ? '原件缺失' : '尚未翻译');
    });
    $$('#download-pop input[data-zip]').forEach(cb => {
      cb.disabled = !o[cb.dataset.zip];
    });
  } catch (e) { /* 忽略 */ }
}


// 调试功能默认隐藏：版面框（解析质检）与 JSON 视图——地址栏加 ?debug=1 显示
if (!new URLSearchParams(location.search).has('debug')) {
  $('#layout-btn')?.setAttribute('hidden', '');
  const jb = document.querySelector('.view-tabs [data-v="json"]');
  if (jb) jb.hidden = true;
}

/* ================= 命令面板（Ctrl+K）+ 全局快捷键 + 帮助层 =================
   功能多了之后入口藏得深——面板把 页面/动作/论文/设置 变成一键可达。 */

/* ===== 个人标注层（划词高亮/批注——per-user，仅自己可见） ===== */
window.createAnnotation = async (text, kind) => {
  const pid = window.__state?.current?.id;
  if (!pid) { toast('先打开一篇论文'); return; }
  const blk = [...document.querySelectorAll('#content-view .blk')].find(b =>
    (b.textContent || '').includes(text.slice(0, 40)));
  const bid = blk?.dataset?.bid;
  if (!bid) { toast('仅支持在解析正文中标注'); return; }
  let body = '';
  if (kind === 'note') {
    body = await (window._uiDialog ? window._uiDialog({title: '添加批注', input: true, multiline: true,
      okText: '保存', cancelText: '取消', message: '对选中文字的批注（仅自己可见）'}) : Promise.resolve(null));
    if (!body || !body.trim()) return;
  }
  try {
    await api(`/api/papers/${pid}/annotations`, {method: 'POST',
      body: JSON.stringify({kind, quote: text.slice(0, 2000), body, block_id: bid})});
    toast(kind === 'highlight' ? '已高亮' : '批注已保存');
    loadAnnotations();
  } catch (e) { toast(friendlyError(e, '标注失败')); }
};

window.deleteAnnotation = async aid => {
  try {
    await api(`/api/annotations/${aid}`, {method: 'DELETE'});
    loadAnnotations();
  } catch (e) { toast(friendlyError(e, '删除失败')); }
};

window.editAnnotation = async (aid, cur) => {
  const body = await (window._uiDialog ? window._uiDialog({title: '修改批注', input: true, multiline: true,
    value: cur, okText: '保存', cancelText: '取消'}) : Promise.resolve(null));
  if (body === null || !body.trim()) return;
  try {
    await api(`/api/annotations/${aid}`, {method: 'PATCH', body: JSON.stringify({body})});
    loadAnnotations();
  } catch (e) { toast(friendlyError(e, '保存失败')); }
};

window.loadAnnotations = loadAnnotations;
async function loadAnnotations() {
  const pid = window.__state?.current?.id;
  if (!pid) return;
  let anns = [];
  try { anns = (await api(`/api/papers/${pid}/annotations`)).annotations || []; }
  catch { return; }
  window.__annotations = anns;
  // 渲染高亮：把 quote 在对应块文本中找到的位置包 tint span（幂等：先清旧）
  $$('#content-view .mark-u').forEach(x => { const p = x.parentNode; x.replaceWith(...x.childNodes); p.normalize?.(); });
  for (const a of anns.filter(x => x.kind === 'highlight')) {
    const blk = document.querySelector(`#content-view .blk[data-bid="${a.block_id}"]`);
    if (!blk) continue;
    const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
    let node; let done = false;
    while ((node = walker.nextNode()) && !done) {
      const idx = node.textContent.indexOf(a.quote.slice(0, 60));
      if (idx >= 0) {
        const range = document.createRange();
        const end = Math.min(idx + a.quote.length, node.textContent.length);
        range.setStart(node, idx); range.setEnd(node, end);
        const span = document.createElement('span');
        span.className = 'mark-u'; span.dataset.aid = a.id;
        try { range.surroundContents(span); done = true; } catch { /* 跨节点高亮放弃（不影响阅读） */ }
      }
    }
  }
  // 批注列表（侧栏批注区：挂在右栏头部下方的可折叠卡）
  let zone = $('#ann-zone');
  if (!zone) {
    zone = document.createElement('div');
    zone.id = 'ann-zone';
    const host = document.querySelector('.r-subtabs');
    host?.insertAdjacentElement('afterend', zone);
  }
  const notes = anns.filter(x => x.kind === 'note');
  zone.innerHTML = notes.length || anns.some(x => x.kind === 'highlight') ? `
    <details class="ann-zone" ${notes.length ? 'open' : ''}>
      <summary class="muted" style="font-size: var(--fs-xs)">${icon('book', 12)} 我的标注（${anns.length}）</summary>
      ${notes.map(n => `
        <div class="ann-item" data-aid="${n.id}">
          <div class="ann-quote">${esc(n.quote.slice(0, 60))}${n.quote.length > 60 ? '…' : ''}</div>
          <div class="ann-body">${esc(n.body)}</div>
          <div class="ann-ops">
            <button class="btn small hover-only" onclick="editAnnotation('${n.id}', ${JSON.stringify(n.body).replace(/"/g, '&quot;')})">${icon('edit', 12)}</button>
            <button class="btn small danger hover-only" onclick="deleteAnnotation('${n.id}')">${icon('trash', 12)}</button>
          </div>
        </div>`).join('')}
    </details>` : '';
  // 换论文时重渲染（openPaper 后由视图渲染触发）
}

/* ===== 论文讨论区（组内成员共享；阅读页右栏按钮 → 面板） ===== */
(() => {
  const btn = $('#discuss-open'), panel = $('#discuss-panel');
  if (!btn || !panel) return;
  panel.innerHTML = `
    <div style="padding:8px 12px;font-weight:600;font-size: var(--fs-base);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
      ${icon('chat')} 论文讨论
      <span class="spacer"></span>
      <button class="btn small" id="discuss-close">${icon('close')}</button>
    </div>
    <div id="discuss-msgs" style="max-height:60vh;overflow-y:auto;padding:8px 12px"></div>
    <div style="display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--border)">
      <input id="discuss-input" placeholder="写一条讨论…" style="flex:1;min-width:0">
      <button class="btn small primary" id="discuss-send">发送</button>
    </div>`;

  let curPaper = null;
  let _replyTo = null, _replyAuthor = '';

  const emptyHint = '<p class="muted" style="padding:8px;font-size: var(--fs-sm)">还没有讨论——写第一条</p>';

  const msgHtml = (m, pid) => `
    <div class="discuss-msg" data-mid="${m.id}">
      <div style="display:flex;align-items:center;gap:6px">
        <b style="font-size: var(--fs-xs)">${esc(m.username || m.author_id)}</b>
        <span class="muted" style="font-size: var(--fs-xs)">${relTime(m.created_at)}</span>
        <button class="btn small hover-only" style="padding:0 4px" title="回复"
                onclick="replyDiscuss('${m.id}','${esc((m.username || '').slice(0, 20))}')">${icon('chat', 12)}</button>
        ${m.author_id === state.me?.id ? `<button class="btn small hover-only" style="padding:0 4px" onclick="delDiscuss('${pid}','${m.id}')" title="删除">${icon('trash', 12)}</button>` : ''}
      </div>
      <div style="font-size: var(--fs-sm);margin-top:2px;white-space:pre-wrap">${m.reply_to ? `<span class="muted" style="font-size: var(--fs-xs)">↳ 回复 @${m.reply_author || '…'}：</span>` : ''}${esc(m.content)}</div>
    </div>`;

  async function load() {
    if (!curPaper) return;
    try {
      const d = await api(`/api/papers/${curPaper}/discuss`);
      const el = $('#discuss-msgs');
      if (!el) return;
      el.innerHTML = (d.messages || []).map(m => msgHtml(m, curPaper)).join('') || emptyHint;
      el.scrollTop = el.scrollHeight;
    } catch (e) { /* 静默 */ }
  }
  window.delDiscuss = async (pid, mid) => {
    try {
      await api(`/api/papers/${pid}/discuss/${mid}`, {method: 'DELETE'});
      toast('已删除');
    } catch (e) { return toast(friendlyError(e, '删除失败')); }
    // 删除后立即重拉（此前要关开面板才能看到变化）
    if (pid === curPaper && !panel.hidden) load();
  };
  window.replyDiscuss = (mid, author) => {
    _replyTo = mid; _replyAuthor = author;
    const inp = document.querySelector('#discuss-input');
    if (inp) { inp.value = `@${author} `; inp.focus(); }
    const rep = document.querySelector('#discuss-reply-indicator');
    if (rep) { rep.textContent = `回复 @${author}`; rep.hidden = false; }
  };

  const doSend = async () => {
    const inp = $('#discuss-input');
    const content = (inp?.value || '').trim();
    if (!content || !curPaper) return;
    inp.value = '';
    const body = {content};
    if (_replyTo) { body.reply_to = _replyTo; _replyTo = null; _replyAuthor = ''; repInd.hidden = true; }
    try {
      await api(`/api/papers/${curPaper}/discuss`, {method: 'POST', body: JSON.stringify(body)});
      await load();
    } catch (e) { toast(friendlyError(e, '发送失败')); }
  };

  btn.addEventListener('click', () => {
    // 没选中论文时不打开：讨论区是 per-paper 的，空面板只剩一个输入框（发送也静默无效）
    if (panel.hidden && !state.current?.id) { toast('讨论区属于单篇论文——先在左侧选择一篇论文', 3000); return; }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      curPaper = state.current?.id || null;
      panel.style.zIndex = '70';
      panel.style.width = '360px';
      panel.style.maxWidth = '94vw';
      panel.style.background = 'var(--panel)';
      panel.style.border = '1px solid var(--border)';
      panel.style.borderRadius = 'var(--r-lg)';
      panel.style.boxShadow = '0 12px 36px rgba(0,0,0,.18)';
      anchorPop(panel, btn);          // 锚到按钮下方（并清 left——tool-pop 样式表的 left:8px 不清会钉死左上角）
      const el = $('#discuss-msgs');
      if (el) { el.innerHTML = emptyHint; }   // 先给空态，加载完替换——面板不再只剩输入框
      load();
    }
  });
  $('#discuss-close')?.addEventListener('click', () => panel.hidden = true);
  // 点外关闭
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) panel.hidden = true;
  });

  // 回复指示条
  const repInd = document.createElement('div');
  repInd.id = 'discuss-reply-indicator';
  repInd.hidden = true;
  repInd.style.cssText = 'padding:4px 12px;font-size:var(--fs-xs);color:var(--primary);display:flex;align-items:center;gap:6px';
  panel.insertBefore(repInd, panel.querySelector('#discuss-msgs')?.nextSibling);

  $('#discuss-send')?.addEventListener('click', doSend);
  // Enter 发送（此前 onkeydown 调用的 sendDiscuss() 不存在——Enter 发送是死的）
  // isComposing：中文输入法选词回车不发送（web-quality-report D1）
  $('#discuss-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
})();
