/* ===== 17-inline.js —— 阅读页「表格」页签：内嵌编辑器（与图表/公式同布局流） =====
   每表卡片 = 网格（contenteditable）+ AI 指令框 + 撤销重做 + 自动保存；
   状态 _tbInline[tid].stack 用 tbGridKernel；完整对照仍走 tbCompare 弹层。 */
window._tbInline = {};

window.tbInlineEditor = (t, idx = 0) => `
  <div class="tb-inline" id="tb-inline-${t.id}" data-tid="${t.id}">
    <div class="tb-inline-head">
      <span class="tb-inline-cap" title="${esc(t.caption)} · 点击跳到 PDF 该页表格" onclick="tbInlineJump(${t.page_index}, ${idx})" style="cursor:pointer;color:var(--primary)">${esc(t.caption || '（无表题）')}</span>
      ${tbStatusBadge(t.ai_status)}
      <span class="muted" style="font-size:var(--fs-xs);flex:none">${t.n_rows}×${t.n_cols}</span>
      <span style="flex:1"></span>
      <button class="btn small ic-only" onclick="tbInlineAIBox('${t.id}')" title="AI 按指令加工此表" aria-label="AI 加工">${icon('brain', 12)}</button>
      <button class="btn small ic-only" onclick="tbCompare('${t.id}')" title="完整对照工作台（原图并排）" aria-label="对照">${icon('stack', 12)}</button>
    </div>
    <div class="tb-inline-ai" hidden>
      <input placeholder="按指令加工此表，如：多级表头压成一行；只保留 Ours 相关行…" aria-label="AI 加工指令"
        onkeydown="if(event.key==='Enter'&&!event.isComposing)tbInlineAI('${t.id}')">
      <button class="btn small primary" onclick="tbInlineAI('${t.id}')">${icon('bolt', 12)} 加工</button>
    </div>
    <div class="tb-inline-tools">
      <button class="btn small" onclick="tbInlineAdd('${t.id}', 'row')" title="加一行">+行</button>
      <button class="btn small" onclick="tbInlineAdd('${t.id}', 'col')" title="加一列">+列</button>
      <button class="btn small" onclick="tbInlineUndo('${t.id}')" title="撤销（Ctrl+Z）">↶</button>
      <button class="btn small" onclick="tbInlineRedo('${t.id}')" title="重做（Ctrl+Y）">↷</button>
      <button class="btn small" onclick="tbExport(['${t.id}'], this)" title="下载此表 xlsx">${icon('download', 12)}</button>
      <span class="muted tb-inline-dirty" hidden>未保存</span>
      <span style="flex:1"></span>
      <button class="btn small primary" onclick="tbInlineSave('${t.id}')">${icon('check', 12)} 保存</button>
    </div>
    <div class="tb-inline-grid"><table class="tbl-md" contenteditable="true" id="tb-mgrid-${t.id}"></table></div>
  </div>`;

window.tbInlineBind = t => {
  const box = $(`#tb-inline-${t.id}`);
  if (!box) return;
  window._tbInline[t.id] = {stack: tbGridKernel.stack(), timer: null, dirty: false};
  // 初始网格：AI 整理版优先（ai_cells），未整理落回原始提取——与对照工作台同口径
  const initGrid = (() => {
    if (t.ai_cells) { try { const g = JSON.parse(t.ai_cells); if (g.length) return g; } catch {} }
    try { return JSON.parse(t.cells || '[]'); } catch { return []; }
  })();
  tbInlineRenderGrid(t.id, initGrid);
  // 编辑快照（防抖入撤销栈）+ 自动保存（1.5s 静默后 PATCH）
  box.querySelector('table').addEventListener('input', () => {
    const st = window._tbInline[t.id];
    if (!st.timer) { tbInlineSnap(t.id); }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { st.timer = null; tbInlineSave(t.id); }, 1500);
    const dirty = box.querySelector('.tb-inline-dirty');
    if (dirty) dirty.hidden = false;
  });
  box.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.target.closest('[contenteditable]')) { e.preventDefault(); tbInlineUndo(t.id); }
  });
};

window.tbInlineRenderGrid = (tid, grid) => {
  const t = $(`#tb-mgrid-${tid}`);
  if (!t) return;
  tbGridKernel.render(t, grid);
};

const tbInlineCollect = tid => tbGridKernel.collect($(`#tb-mgrid-${tid}`));

window.tbInlineSnap = tid => {
  const st = window._tbInline[tid];
  st.stack.snap(tbInlineCollect(tid));
  st.redo = [];
  if (st.undo.length > 50) st.undo.shift();
};

window.tbInlineSave = async tid => {
  const st = window._tbInline[tid];
  const grid = tbInlineCollect(tid);
  try {
    await api(`/api/tables/${tid}`, {method: 'PATCH', body: JSON.stringify({cells: grid})});
    const dirty = $(`#tb-inline-${tid} .tb-inline-dirty`);
    if (dirty) dirty.hidden = true;
    if (st) st.dirty = false;
    const btn = $(`#tb-inline-${tid} .tb-inline-tools .btn.primary`);
    if (btn) { btn.textContent = '✓ 已保存'; setTimeout(() => { btn.innerHTML = `${icon('check', 12)} 保存`; }, 1200); }
  } catch (e) { toast(friendlyError(e, '保存失败')); }
};

window.tbInlineUndo = tid => {
  const st = window._tbInline[tid];
  if (!st) return;
  const rows = st.stack.undo(tbInlineCollect(tid));
  if (rows === null) { toast('没有可撤销的操作'); return; }
  tbInlineRenderGrid(tid, rows);
  tbInlineSave(tid);
};
window.tbInlineRedo = tid => {
  const st = window._tbInline[tid];
  if (!st) return;
  const rows = st.stack.redo(tbInlineCollect(tid));
  if (rows === null) { toast('没有可重做的操作'); return; }
  tbInlineRenderGrid(tid, rows);
  tbInlineSave(tid);
};

window.tbInlineAdd = (tid, kind) => {
  const st = window._tbInline[tid];
  tbInlineSnap(tid);
  const grid = tbInlineCollect(tid);
  if (kind === 'row') grid.push(new Array(grid[0]?.length || 1).fill(''));
  else grid.forEach(r => r.push(''));
  window._tbInline[tid] = st;
  tbInlineRenderGrid(tid, grid);
  tbInlineSave(tid);
};

// 版面序块匹配：MinerU 裁剪名 page_N_table_M 的 M = 该页第 M 个表块（按 bbox 纵向排序）
// ——同页多表各自精确跳转的关键；图表 image_N、公式同理。
// 逐项跳转（通用）：kind=块类型；idx1 从 1 计。name 优先解析序号（image_M/table_M），
// 传不了序号的（公式）退化为页内第 idx+1 个同类型块，仍无块则纯跳页。
window.tbJumpFlashItem = (page, kind, name, idx = 0) => {
  const m = String(name || '').match(new RegExp(kind + '_(\\d+)\\.'));
  if (m) return tbJumpFlash(page, kind, +m[1]);
  tbJumpFlash(page, kind, idx + 1);
};
const _bboxY = b => { const bb = typeof b.bbox === 'string' ? JSON.parse(b.bbox) : (b.bbox || [9, 9]); const f = Array.isArray(bb[0]) ? bb[0] : bb; return f[1]; };
// 文档级同类块序（MinerU asset 名 page_N_table_M 的 M = 全文档累积序）：按页码 + 页内 y 排序取第 idx1-1 个
window.tbBlockDocOrder = (kind, idx1) => {
  const sorted = (window.__state.blocks || [])
    .filter(b => b.type === kind)
    .sort((a, b2) => (a.page_index - b2.page_index) || (_bboxY(a) - _bboxY(b2)));
  return sorted[idx1 - 1] || null;
};
window.tbBlockOnPage = (page, kind, idx1) => {
  const sorted = (window.__state.blocks || [])
    .filter(b => b.type === kind && b.page_index === page)
    .sort((a, b2) => _bboxY(a) - _bboxY(b2));
  return sorted[idx1 - 1] || null;
};
window.tbJumpFlash = async (page, kind, idx1) => {
  // idx1 从 1 计（文件名约定）。blocks 懒加载：缺块时循环补拉（有界）再匹配。
  let b = window.tbBlockDocOrder(kind, idx1);
  let guard = 0;
  while (!b && guard < 30 && window.__state._blkOffset < (window.__state._blkTotal || 0)) {
    await window.loadMoreBlocks();
    b = window.tbBlockDocOrder(kind, idx1);
    guard++;
    if (window.__state._blkLoading) break;   // 已有加载在跑：本轮结束后再试一轮
  }
  if (b) { window.pdfFlashBlock(b); return; }
  window.jumpEvidence(b?.page_index ?? page);   // 兜底：至少跳到该页
};
window.tbInlineJump = async (page, idxInPage = 0) => {
  // 同页第 idxInPage+1 张表 ↔ 该页表块按 bbox 纵向序的第 idxInPage+1 个
  // （收割按 MinerU 块序产生，页内顺序一致）——同页多表各自精确跳转。
  await tbJumpFlash(page, 'table', idxInPage + 1);
};
window.tbInlineAIBox = tid => {
  const box = $(`#tb-inline-${tid} .tb-inline-ai`);
  if (box) box.hidden = !box.hidden;
};

window.tbInlineAI = async tid => {
  const box = $(`#tb-inline-${tid}`);
  const inp = box.querySelector('.tb-inline-ai input');
  const instruction = (inp?.value || '').trim();
  if (!instruction) { toast('先输入加工指令'); return; }
  const go = box.querySelector('.tb-inline-ai .btn');
  go.disabled = true;
  try {
    tbInlineSnap(tid);   // 加工前快照 → 可撤销回到加工前
    const r = await api(`/api/tables/${tid}/regen`,
      {method: 'POST', body: JSON.stringify({instruction, base_cells: tbInlineCollect(tid)})});
    window._tbInline[tid].gridLen = r.rows.length;
    tbInlineRenderGrid(tid, r.rows);
    toast((r.note ? r.note + ' · ' : '') + '已生成并保存', 3200);
    // 同步状态徽章
    const badge = box.querySelector('.tb-inline-head .badge');
    if (badge) { badge.className = 'badge ok'; badge.textContent = '已整理 ✓'; }
  } catch (e) { toast(friendlyError(e, '加工失败')); }
  finally { go.disabled = false; }
};

