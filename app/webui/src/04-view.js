/* ===== 04-view.js —— 视图切换与内容视图：双栏/块编辑/切页 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
function switchView(v, s) {
  updateQaBtn();
  // 双语懒加载：首次切到双语/中文且尚未拉取（openPaper 不再预拉），此时才取全文对照
  if (v === 'read' && ['bilingual', 'zh'].includes(s) && state.current &&
      !(state.pairs || []).length && state.translatedComplete) {
    loadBilingual(state.current.id, true).catch(() => {});
  }
  // v ∈ read|meta|assets|json；兼容 orig/bilingual/zh → read+子视图；qa → 聚焦问答框
  if (['orig', 'bilingual', 'zh'].includes(v)) { s = v; v = 'read'; }
  if (v === 'qa') { switchPage('reader'); $('#qa-text')?.focus(); return; }
  if (v === 'read' && s) state.rpane.readingView = s;
  state.mainView = v;
  state.view = v === 'read' ? (s || state.rpane.readingView || 'orig') : v;
  $$('.view-tabs [data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  // 次级工具条：阅读=原文/双语/中文；图表=图表/公式（同一行、同尺寸，紧贴上沿）
  $('#r-subtabs').hidden = v !== 'read' && v !== 'assets';
  $('#read-subtabs').hidden = v !== 'read';
  $('#assets-subtabs').hidden = v !== 'assets';
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
/* 行 HTML 生成（renderContentView 与增量追加共用，避免追加时全量重渲染） */
const CHROME_TYPES = ['page_number', 'footer', 'header'];   // 页眉/页码是版面噪声，正文流不显示
const EDITABLE_TYPES = ['text', 'title', 'list', 'aside_text', 'page_footnote', 'equation', 'ref_text', 'page_title'];

function canEditBlock() {
  const me = state.me, p = state.current;
  return !!(me && p && (me.role === 'admin' || p.owner_id === me.id));
}

function editBtnHtml(bid, type) {
  if (!canEditBlock() || !EDITABLE_TYPES.includes(type)) return '';
  return `<button class="blk-edit" data-bid="${bid}" title="修正此块（索引/向量同步更新）">${icon('edit')}</button>`;
}

/* 可视化修正：浮层改块文本 → PATCH → 本地同步 blocks/pairs */
window.editBlock = async (bid, anchorEl) => {
  const blk = state.blocks.find(x => x.block_id === bid) || (state.pairs || []).find(x => x.block_id === bid);
  if (!blk || !state.current) return;
  const cur = (blk.text ?? blk.en ?? '');
  const v = await _uiDialog({title: '修正此块文本', input: true, multiline: true,
    value: cur, okText: '保存', cancelText: '取消', anchor: anchorEl,
    message: '保存后全文索引与向量同步更新（检索/问答即刻生效）；译文不变，可点强制重译生成新版本。'});
  if (v === null) return;
  const nv = v.trim();
  if (!nv || nv === cur.trim()) return;
  try {
    await api(`/api/papers/${state.current.id}/blocks/${bid}`, {method: 'PATCH', body: JSON.stringify({text: nv})});
    const b = state.blocks.find(x => x.block_id === bid); if (b) b.text = nv;
    const pr = (state.pairs || []).find(x => x.block_id === bid); if (pr) pr.en = nv;
    renderContentView();
    toast('已修正（索引与向量已同步）');
  } catch (e) { toast(friendlyError(e, '保存失败，请重试')); }
};

function blockRowHtml(b) {
  const aux = ['aside_text', 'page_footnote'].includes(b.type) ? ' blk-aux' : '';
  return `<div class="blk${aux}" data-bid="${b.block_id}" data-page="${b.page_index}" data-bbox='${esc(b.bbox ?? '')}' data-bbox-pages='${esc(b.bbox_pages ?? '')}'>
    ${editBtnHtml(b.block_id, b.type)}${b.type === 'title' ? '<h3>' : ''}${renderBlockBody(b)}${b.type === 'title' ? '</h3>' : ''}
  </div>`;
}

function pairRowsHtml(p) {
  const enHtml = renderBlockBody(p);
  const attrs = `data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}' data-bbox-pages='${esc(p.bbox_pages ?? '')}'`;
  if (p.type === 'image' || p.type === 'equation') {
    // 图/公式无对应译文行，只出一份（在 en 行）
    return enHtml ? [`<div class="pair en blk" ${attrs}>${editBtnHtml(p.block_id, p.type)}${enHtml}</div>`] : [];
  }
  if (!p.zh) return [];   // 未翻译段：不渲染空壳
  const isTitle = p.type === 'title';
  return [`<div class="pair en blk ${isTitle ? 'blk-title' : ''}" ${attrs}>${editBtnHtml(p.block_id, p.type)}${enHtml}</div>`,
    `<div class="pair zh blk ${isTitle ? 'blk-title-zh' : ''}" ${attrs}>${mdLite(p.zh)}</div>`];
}

function loadHintHtml(txt) {
  return `<p id="load-more-hint" class="muted" style="text-align:center;padding:10px">继续下滑加载更多…（已加载 ${txt}）</p>`;
}

/* 增量追加：只把新行插到容器尾部，不重建已渲染内容（长论文滚动不再 O(n²)） */
function appendRows(rowsHtml, hasMore, hintTxt) {
  const el = $('#content-view');
  $('#load-more-hint')?.remove();
  const wrap = $('.pairs', el);
  (state.view === 'bilingual' && wrap ? wrap : el).insertAdjacentHTML('beforeend', rowsHtml);
  if (hasMore) el.insertAdjacentHTML('beforeend', loadHintHtml(hintTxt));
  bindBlkClicks(el);
  figCropPass();   // 幂等（dataset.done 守卫），只处理新图
  // 追加后仍在底部附近 → 续拉（一次追加可能没填满视口）
  if (hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
    (state.view === 'bilingual' || state.view === 'zh' ? loadMorePairs : loadMoreBlocks)();
  }
}

function bindBlkClicks(el) {
  // 段落点击 → 跳页 + 高亮（重复绑定无害：onclick 覆盖式赋值）
  $$('.blk', el).forEach(x => x.onclick = e => {
    const editBtn = e.target.closest?.('.blk-edit');
    if (editBtn) { e.stopPropagation(); editBlock(editBtn.dataset.bid, editBtn); return; }   // 修正模式：不触发跳页
    $$('.blk.active').forEach(y => { y.classList.remove('active'); y.style.removeProperty('--hlc'); });
    applyActiveStyle(x);
    const page = parseInt(x.dataset.page ?? '0') + 1;
    if (state.pdfDoc && page >= 1 && page <= state.pdfDoc.numPages) {
      state.pageNum = page; renderPage();
    }
    highlightBlockOnPdf(x);   // 右侧 → PDF：立刻在该页画出高亮框
  });
}

/* 双语/中文视图的数据自愈：懒拉数据未就绪（openPaper 恢复子视图等路径不经过 switchView 的
   懒拉钩子）时不再渲染空壳白屏——显示加载态并触发拉取，拉完自动重渲。 */
function ensurePairsOrLoading(el) {
  if ((state.pairs || []).length || state._biLoadedFor === state.current?.id) return true;   // 就绪（或确认拉过且为空）
  el.innerHTML = `<p class="muted" style="text-align:center;padding:40px">${icon('clock', 12)} 加载对照内容…</p>`;
  if (state._biLoading !== state.current.id) {
    state._biLoading = state.current.id;
    loadBilingual(state.current.id, true)
      .finally(() => { if (state._biLoading === state.current.id) state._biLoading = null; });
  }
  return false;
}

function renderContentView() {
  const el = $('#content-view');
  if (!state.current) { el.innerHTML = '<div class="empty-state"><p class="t">选择左侧论文开始阅读</p><p>打开一篇后，这里显示正文、图表与引用</p></div>'; return; }
  if (state.mainView === 'read' || ['orig','bilingual','zh'].includes(state.view)) {
    // 阅读：走下方 orig/bilingual/zh 分支
  }
  if (state.view === 'meta') { renderMeta(); return; }
  if (state.view === 'assets') { renderAssets(); return; }
  if (state.view === 'json') {
    el.innerHTML = `<div class="card json-view">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <b>解析块 JSON（调试）</b><span class="muted" style="font-size: var(--fs-sm)">${state.blocks.length} blocks</span>
        <button class="btn small" style="margin-left:auto" onclick="copyJson()">复制</button>
      </div>
      <pre>${esc(JSON.stringify(state.blocks, null, 2))}</pre></div>`;
    return;
  }
  if (state.view === 'bilingual') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="empty-state">
        <p class="t">${state.translatingNow ? icon('clock', 12) + " 翻译中…" : '未翻译'}</p>
        <p>翻译完成后可在这里对照阅读；现在发起全文翻译，稍后自动显示</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">${icon('globe')} 全文翻译</button>`}
      </div>`;
      return;
    }
    if (!ensurePairsOrLoading(el)) return;
    const rows = state.pairs.flatMap(pairRowsHtml);
    el.innerHTML = '<div class="pairs">' + rows.join('') + '</div>' +
      (state._biOffset < (state._biTotal || 0) ? loadHintHtml(`${state._biOffset}/${state._biTotal}`) : '');
  } else if (state.view === 'zh') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="empty-state">
        <p class="t">${state.translatingNow ? icon('clock', 12) + " 翻译中…" : '未翻译'}</p>
        <p>翻译完成后可在这里对照阅读；现在发起全文翻译，稍后自动显示</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">${icon('globe')} 全文翻译</button>`}
      </div>`;
      return;
    }
    if (!ensurePairsOrLoading(el)) return;
    const zh = state.pairs.filter(p => p.zh);
    el.innerHTML = zh.length ? zh.map(p =>
      `<div class="blk zh ${p.type === 'title' ? 'blk-title-zh' : ''}" data-bid="${p.block_id}" data-page="${p.page_index}" data-bbox='${esc(p.bbox ?? '')}' data-bbox-pages='${esc(p.bbox_pages ?? '')}'>${esc(p.zh)}</div>`).join('')
      : '<p class="muted">尚无中文译文。</p>';
  } else {  // orig
    el.innerHTML = state.blocks.filter(b => !CHROME_TYPES.includes(b.type)).map(blockRowHtml).join('') +
      (state._blkOffset < (state._blkTotal || 0) ? loadHintHtml(`${state._blkOffset}/${state._blkTotal}`) : '');
  }

  figCropPass();   // PDF 原图裁剪（异步，pdfDoc 未就绪则跳过）
  // 滚动到底 → 续拉解析块（分页加载）
  el.onscroll = () => {
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      if (state.view === 'bilingual' || state.view === 'zh') loadMorePairs();
      else loadMoreBlocks();
    }
  };
  bindBlkClicks(el);
}

/* 阅读子页签（原文/双语/中文） */
$$('.r-subtabs [data-s]').forEach(b => b.onclick = () => switchView('read', b.dataset.s));

/* ---------------- 页签切换 ---------------- */
$$('.topnav button[data-page]').forEach(b => b.onclick = () => switchPage(b.dataset.page));
function switchPage(page) {
  state._page = page;   // 侧栏软收起判定用（表格/追踪页自带左栏）
  $$('.topnav button[data-page]').forEach(x => x.classList.toggle('on', x.dataset.page === page));
  $('#page-title').textContent = {reader: '阅读', collections: '文库管理',
    tasks: '任务中心', tracker: '文献追踪', tables: '表格工作台', trash: '回收站', settings: '设置',
    admin: '管理后台'}[page] || 'paper-system';
  syncSynBackBtn();
  applySidebarCollapse();
  for (const p of ['reader', 'collections', 'tasks', 'tracker', 'tables', 'trash', 'settings', 'admin']) {
    $('#page-' + p).style.display = p === page ? (p === 'reader' ? 'flex' : 'block') : 'none';
  }
  ({collections: renderCollectionsPage, tasks: renderTasksPage, tracker: renderTrackerPage, tables: renderTablesPage,
    trash: renderTrash, settings: renderSettings, admin: renderAdminZone})[page]?.();
}
window.switchPage = switchPage;  // 内联 onclick 可访问（module 作用域不暴露全局）

/* ---- 从综述跳到论文后的返回路径 ----
   综述报告里的「主题分组」/ 证据索引点进论文后，需要一键回到原综述界面。
   state._synBack 记录来源（综述 id + 标题），阅读页顶栏显示「← 返回综述」。 */
function syncSynBackBtn() {
  const b = $('#syn-back-btn');
  if (!b) return;
  // 只在阅读页显示（综述/文库等页面出现这个按钮会让人误解）
  const onReader = !!$('#page-reader') && $('#page-reader').style.display !== 'none';
  const has = !!(state._synBack && state._synBack.sid);
  b.hidden = !(has && onReader);
  if (has) b.title = `返回综述：${state._synBack.title || ''}`;
}
window.syncSynBackBtn = syncSynBackBtn;
window.backToSynthesis = async () => {
  const back = state._synBack;
  if (!back?.sid) { toast('没有可返回的综述'); return; }
  switchPage('tasks');
  try {
    await showSynthesisReport(back.sid);
  } catch (e) {
    state._synBack = null; syncSynBackBtn();
    toast('综述已不存在或无法打开');
  }
};

/* ---------------- 任务中心（合并进批量中心 ③ 区块） ----------------
   顶栏「队列」按钮 = 角标提醒；点击跳批量中心任务进度区。批次任务、无批次的
   单篇任务、MCP 待确认写操作、批量暂停/恢复 全部在 ③ 区块内统一展示与操作。 */
const refreshQueueBadge = throttle(async () => { await _refreshQueueBadge(); }, 3000);   // SSE 事件风暴节流（3s）
async function _refreshQueueBadge() {
  if (document.hidden) return;   // 后台标签页暂停轮询（回来时 visibilitychange 立即刷一次）
  try {
    // 轻量计数端点（两个数字）——原先拉全量 ?limit=200（~70KB）只为数个数；
    // priority:low = 后台轮询让位于用户触发的请求（MWG deprioritize-background-fetches，
    // 不支持的浏览器忽略该选项，无副作用）
    const d = await api('/api/jobs/count', {priority: 'low'});
    const badge = $('#qbadge');
    if (badge) {
      badge.hidden = !(d.active + d.mcp_pending);
      badge.textContent = d.active + d.mcp_pending;
    }
    if ($('#page-tasks')?.style.display !== 'none' && Date.now() - _batchSseAt > 2000) {
      _batchSseAt = Date.now();
      renderTaskPanel();
      renderSynList();
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQueueBadge(); });
window.mcpConfirm = async (id, approve) => {
  try {
    const r = await api('/api/mcp/confirm', {method: 'POST', body: JSON.stringify({action_id: id, approve})});
    toast(r.ok ? (r.executed ? '✓ 已执行' + (r.summary ? '：' + r.summary : '') : '已丢弃') : (r.message || '失败'));
  } catch (e) { toast('操作失败: ' + e.message); }
  renderTaskPanel();
  refreshQueueBadge();
};
// 顶栏「任务」角标：有活跃任务才显示；点击 = 页签本来的切页行为
setInterval(refreshQueueBadge, 8000);

/* ---------------- 批量中心 ----------------
   圈定（勾选/当前列表/按库）→ 操作卡发起一批同型任务（后端 /api/batch/{action}）
   → 批次进度面板按 batch_id 聚合跟踪（轮询 + SSE），失败项单独重试。 */
state._batchOpen = new Set();   // 进度面板里展开的批次
state._batchPapers = [];        // 圈定来源论文缓存（供明细显示标题）

// 批量导读/翻译/元数据/重解析/BibTeX/删除卡已移除——与文库管理页批量条逐一重复（收敛到单一入口）

/* ---- 采集与专题面板（浮层）——原「批量」顶级页并入文库管理 ----
   快速采集=一次性检索入库；专题跟踪=持久化任务（可中断可恢复 + 一键综述）。 */
window.openCollectPanel = async () => {
  const old = document.querySelector('#collect-panel');
  if (old) old.remove();
  const {pop, close} = openPop('collect-panel');
  pop.innerHTML = `<div class="ui-pop-title">采集文献
      <span class="muted" style="font-weight:400;font-size: var(--fs-xs)">按关键词检索中文文献（知网 / 中科院预印本）并入库</span>
      <span class="spacer"></span><button class="btn small" data-cp-close title="关闭">${icon('close')}</button></div>
    <div class="collect-actions">
      <button class="btn" id="acq-btn">${icon('inbox')} 快速采集<span class="muted">一次性检索 → 勾选 → 下载入库</span></button>
      <button class="btn" id="cp-topics">${icon('stack')} 专题跟踪<span class="muted">持久化任务 · 可中断可恢复 · 一键综述</span></button>
    </div>
    <div id="cp-body"></div>`;
  pop.querySelector('[data-cp-close]').onclick = close;
  pop.querySelector('[data-cancel], .ui-pop-foot [data-ok]')?.remove();
  const body = pop.querySelector('#cp-body');
  // 快速采集 → 复用现有采集弹层
  pop.querySelector('#acq-btn').onclick = () => { close(); openAcquirePop(); };
  // 专题跟踪 → 专题列表（可反复进入）
  const showTopics = async () => {
    body.innerHTML = '<p class="muted" style="padding:10px">加载中…</p>';
    await showTopicsView(body, null, true);   // 浮层内不显示「返回」（浮层本身就是入口）
  };
  pop.querySelector('#cp-topics').onclick = showTopics;
  await showTopics();
};
window.openCollectPanel = openCollectPanel;
window.showTopicsView = showTopicsView;
window.newTopicDialog = newTopicDialog;
window.openAcquirePop = openAcquirePop;
window.runSynthesis = runSynthesis;


/* ---- 综述状态公共件（syn-list / 任务面板 synJob 两处复用，原先各写一份映射） ---- */
const SYN_ST = { done: ['完成', 'ok'], failed: ['失败', 'err'], running: ['进行中', 'run'],
                 needs_fix: ['引用需修复', 'err'] };
function synBadge(status) {
  const [txt, cls] = SYN_ST[status] || [status, 'run'];
  return `<span class="badge ${cls}">${txt}</span>`;
}
function synPct(s) {
  return s.progress_total ? Math.min(100, Math.round(100 * s.progress_done / s.progress_total)) : 0;
}

/* ---- 我的综述：历史报告列表（syntheses 表永久记录） ---- */
/* 综述标题兜底：模型常给「文献综述」这类泛称 → 用首篇论文标题拼出可辨识的标题 */
function synTitleOf(s) {
  const raw = String(s?.title || '').trim();
  const vague = !raw || (raw.length <= 12 && /综述|survey|report/i.test(raw));
  if (!vague) return raw;
  const first = s?.first_paper ? String(s.first_paper).slice(0, 42) : '';
  return first ? `综述：${first}` : '综述报告';
}

async function renderSynList(all) {
  const el = $('#syn-list');
  if (!el) return;
  let items;
  try { items = (await api('/api/syntheses' + (all ? '?limit=100' : ''))).syntheses; }
  catch (e) { el.innerHTML = `<p class="muted" style="padding:8px 16px">加载失败: ${esc(e.message)}</p>`; return; }
  if (!items.length) {
    el.innerHTML = '<div class="empty-note">还没有综述报告——在「文库管理」勾选 2 篇以上已解析论文，点批量条「生成综述报告」</div>';
    return;
  }
  const shown = all ? items : items.slice(0, 5);
  el.innerHTML = shown.map(s => {
    const pct = synPct(s);
    return `<div class="syn-item" data-sid="${esc(s.id)}">
      ${synBadge(s.status)}
      <span class="syn-item-main">
        <b title="${esc(synTitleOf(s))}">${esc(synTitleOf(s))}</b>
        <span class="muted" style="font-size: var(--fs-xs)">${s.papers ?? '—'} 篇 · ${esc(s.model || '')} · ${esc(relTime(s.updated_at))}</span>
        ${s.status === 'running' ? progressBar(pct, false, 'up-bar parse', 'max-width:280px') : ''}
        ${s.status === 'failed' && s.error ? `<div class="bpanel-err">${esc(s.error.slice(0, 120))}</div>` : ''}
      </span>
      <span class="spacer"></span>
      ${['done', 'needs_fix'].includes(s.status) ? `<button class="btn small primary" data-syn-view="${esc(s.id)}">查看报告</button>
        <button class="btn small" title="导出 Markdown" data-syn-dl="${esc(s.id)}" data-fmt="md">${icon('doc')} MD</button>
        <button class="btn small" title="导出对比矩阵 CSV" data-syn-dl="${esc(s.id)}" data-fmt="csv">${icon('chart')} CSV</button>` : ''}
      <button class="btn small danger hover-only" title="删除综述" data-syn-del="${esc(s.id)}">${icon('trash')}</button>
    </div>`;
  }).join('');
  if (items.length > 5) {
    el.insertAdjacentHTML('beforeend', `<div style="padding:4px 0 2px"><button class="btn small" id="syn-more">展开全部 ${items.length} 条</button></div>`);
    $('#syn-more').onclick = async () => { el.innerHTML = ''; await renderSynList(true); };
  }
}


/* ================= 任务中心（独立页） =================
   全部任务的唯一视图：批次任务按组展开、单篇任务平铺；
   类型彩色徽章 + 类型/状态筛选；MCP 待确认置顶。 */
