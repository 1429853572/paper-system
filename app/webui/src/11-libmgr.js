/* ===== 11-libmgr.js —— 文库管理页：库列表/批量操作/选题 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
function libDescendants(cid, list) {   // 含自身 + 全部子孙
  const out = [cid];
  const kids = (list || state.collections).filter(c => c.parent_id === cid);
  for (const k of kids) out.push(...libDescendants(k.id, list));
  return out;
}
window.libGoPage = async pg => {
  state._libPage = Math.max(1, pg);
  await renderCollectionsPage();
};
window.selectLib = cid => {
  state._libPage = 1;
  state.libSel = cid;
    state.libLevel = 2;                 // 进第二层：库内（子库+论文）
  localStorage.setItem('ps-lib-sel', cid);
  renderCollectionsPage();
};
window.libGoL1 = () => {              // 返回第一层：库列表
  state.libLevel = 1; state.libSel = '';   renderCollectionsPage();
};
window.libOpenLib = cid => {          // 第一层点库 → 进第二层
  state.libSel = cid; state.libLevel = 2;
  renderCollectionsPage();
};

/* 文库管理顶部工具条（第一/第二层共用：标题/搜索/新建库/导出弹层） */
function libMgrToolbarHtml(d) {
  return `
    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 class="page-h row" style="flex:1">文献库管理</h2>
      <button class="btn" onclick="openCollectPanel()" title="按关键词检索中文文献并入库（一次性或建专题跟踪）">${icon('inbox')} 采集文献</button>
      <input id="lib-mgr-q" placeholder="搜索论文标题/作者…" style="max-width:200px" value="${esc(state.libQuery)}">
      <input id="newlib-name" placeholder="新库名称" style="max-width:150px">
      <button class="btn primary" onclick="createLibFromPage()">${icon('plus')} 新建库</button>
      <button class="btn" id="export-btn" title="批量导出当前范围/勾选的论文">${icon('download')} 导出</button>
      <div class="tool-pop export-pop" id="export-pop" hidden>
        <div class="tp-label">范围</div>
        <label class="tp-item" style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="radio" name="exp-scope" value="scope" style="width:auto" checked> 当前范围（<span id="exp-scope-n">0</span> 篇，含子库）</label>
        <label class="tp-item" id="exp-sel-item" style="display:flex;gap:8px;align-items:center;cursor:pointer" hidden>
          <input type="radio" name="exp-scope" value="sel" style="width:auto"> 勾选的 <span id="exp-sel-n">0</span> 篇</label>
        <div class="tp-sep"></div>
        <div class="tp-label">内容</div>
        <div class="dl-checks">
          <label><input type="checkbox" data-fmt="pdf" checked> 原始 PDF</label>
          <label><input type="checkbox" data-fmt="md" checked> 原文 MD</label>
          <label><input type="checkbox" data-fmt="bilingual_md"> 中英对照 MD</label>
          <label><input type="checkbox" data-fmt="bilingual_pdf"> 对照 PDF（逐篇渲染较慢）</label>
          <label><input type="checkbox" data-fmt="bibtex"> BibTeX</label>
        </div>
        <button class="btn small primary" id="export-zip-btn" style="margin:8px 0 4px">${icon('download')} 导出 ZIP</button>
      </div>
    </div>`;
}

function bindLibMgrToolbar() {
  const qIn = $('#lib-mgr-q');
  if (qIn) {
    qIn.oninput = e => {
      state.libQuery = e.target.value;
      state._libPage = 1;              // 换搜索词回到第一页
      clearTimeout(state._libQTimer);
      state._libQTimer = setTimeout(async () => {
        if (state.libLevel === 1) { renderCollectionsPage(); }
        else { await renderCollectionsPage(); }
        const n = $('#lib-mgr-q');
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      }, 300);
    };
  }
}

async function renderCollectionsPage(preset = null) {
  // collections（或 preset）与 statuses 并行——文库页首屏少等一个串行往返
  const [d, st0] = await Promise.all([
    preset ? Promise.resolve(preset) : api('/api/collections'), api('/api/statuses')]);
  state.collections = d.collections;
  state.totalPapers = d.total;
  state._statuses = st0.statuses;
  const el = $('#page-collections');
  if (state.libLevel === 1) {           // 第一层：库列表（顶部工具条与第二层同一套，含新建库/搜索/导出）
    el.innerHTML = libMgrToolbarHtml(d) + libLevel1Html(d);
    bindLibMgrToolbar();
    bindLibLevel1();
    return;
  }
  const colState = JSON.parse(localStorage.getItem('ps-col-open') || '{}');
  const children = {};
  d.collections.forEach(c => (children[c.parent_id || 'root'] ||= []).push(c));
  const openState = cid => colState[cid] !== false;
  const st = state._statuses || {};
  const q = state.libQuery.toLowerCase();

  // ---- 当前选中范围（库 + 其子孙，与侧栏一致）----
  const sel = state.libSel;
  const scopeIds = sel ? libDescendants(sel, d.collections) : [];
  const scopeKey = sel || 'all';
  const subLibs = sel ? (d.collections.filter(c => c.parent_id === sel)) : [];
  const scopeName = sel ? (d.collections.find(c => c.id === sel)?.name || '文献库') : '全部文献';
  // 真分页：25 篇/页（原先一次拉全量 87 行 × 2 控件 = 180 个，首屏外 87%）；
  // 搜索走后端 q（跨页命中 title+authors，前端过滤只能搜当前页）
  const page = state._libPage || 1;
  const ps = state._libPageSize || 25;
  const qs = new URLSearchParams();
  if (scopeIds.length) qs.set('collection_id', scopeIds.join(','));
  if (q) qs.set('q', state.libQuery);
  qs.set('page', String(page));
  qs.set('page_size', String(ps));
  const pd = await api('/api/papers?' + qs.toString());
  const papers = pd.papers || [];
  const total = pd.total ?? papers.length;
  // 范围全量 id（已译统计/跨页全选用；按 scope 缓存，scope 变则失效）
  state._scopeAllIds = state._scopeAllIds || {};
  if (!state._scopeAllIds[scopeKey] || state._scopeAllIds._at !== scopeKey + '|' + (state.libSel || '') + '|' + (state.q || '')) {
    const scopeQ = new URLSearchParams();
    if (scopeIds.length) scopeQ.set('collection_id', scopeIds.join(','));
    if (q) scopeQ.set('q', state.libQuery);
    scopeQ.set('all', '1');
    try {
      const ad = await api('/api/papers?' + scopeQ.toString());
      state._scopeAllIds[scopeKey] = (ad.papers || []).map(x => x.id);
      state._scopeAllIds._at = scopeKey + '|' + (state.libSel || '') + '|' + (state.q || '');
    } catch { state._scopeAllIds[scopeKey] = papers.map(x => x.id); }
  }
  const totalPages = Math.max(1, Math.ceil(total / ps));
  const shown = papers;
  const doneTr = papers.filter(p => st[p.id]?.translate_job?.status === 'done').length;
  // 已译数按【范围全量】统计（state._scopeAllIds 为范围内全部 id，跨页准确）
  const allIds = state._scopeAllIds && state._scopeAllIds[scopeKey];
  const doneTrAll = allIds ? allIds.filter(id => st[id]?.translate_job?.status === 'done').length : doneTr;

  const moveOpts = exclude => d.collections.filter(x => x.id !== exclude)
    .map(x => `<option value="${x.id}">${'\u3000'.repeat(treeDepth(x.id))}${esc(x.name)}</option>`).join('');

  // ---- 右栏：选中库的论文表 ----
  const paperRows = shown.map(p => {
    const s = st[p.id] || {};
    const tj = s.translate_job;
    const parseBadge = s.parsing ? "<span class=\"badge run\">" + icon('clock', 12) + "解析</span>"
      : p.parse_status === 'parsed' ? "<span class=\"badge ok\">" + icon('check') + "</span>"
      : p.parse_status === 'skipped' ? '<span class="badge dim" title="超页数上限未自动解析，可手动重解析">已跳过</span>'
      : "<span class=\"badge err\">" + icon('close') + "</span>";
    const trBadge = s.translating ? `<span class="badge run">${icon('globe')}${tj ? tj.done + '/' + tj.total : ''}</span>`
      : tj?.status === 'done' ? "<span class=\"badge ok\">译" + icon('check') + "</span>"
      : tj?.status === 'failed' ? "<span class=\"badge err\">译" + icon('close') + "</span>" : '<span class="muted">—</span>';
    const owner = d.collections.find(c => c.id === p.collection_id);
    return `<tr class="lib-paper-row" onclick="viewPaper('${p.id}')">
        <td style="width:26px" onclick="event.stopPropagation()"><input type="checkbox" class="lib-ck" data-cid="${scopeKey}" data-pid="${p.id}" ${selBucket(scopeKey).has(p.id) ? 'checked' : ''} onchange="libCk('${scopeKey}')"></td>
        <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis" title="${esc(p.title || '')}">
          ${esc(p.title || p.id)}
          ${owner && scopeIds.length > 1 ? `<span class="muted" style="font-size: var(--fs-xs)"> · ${esc(owner.name)}</span>` : ''}
          ${p.owner_name && p.owner_id !== state.me?.id ? `<span class="muted" style="font-size: var(--fs-xs)" title="上传者"> · ${esc(p.owner_name)}</span>` : ''}</td>
        <td>${parseBadge}${p.parse_status === 'failed' ? `<button class="btn small" title="重试解析与翻译（两者一起重新排队）" onclick="event.stopPropagation();retryPaperJob('${p.id}')">${icon('retry')}</button>` : ''}</td>
        <td>${trBadge}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <button class="btn small danger" title="移入回收站（移库：勾选后用上方批量条）" onclick="delPaperFromLib('${p.id}')">删</button>
        </td></tr>`;}).join('');

  // ---- 组装 ----
  const selName = sel ? (d.collections.find(c => c.id === sel)?.name || '') : '';
  const selNameArg = selName.replace(/'/g, "\\'");   // 塞进内联 onclick 的单引号参数
  el.innerHTML = libMgrToolbarHtml(d) + `
    <div class="lib-crumb">
      ${state.libLevel === 2 ? `<a href="#" onclick="libGoL1();return false">← 全部库</a> <span class="muted">›</span> ` : '<span class="muted">位置：</span>'}
      ${(() => {
        const chain = [];
        let cur = d.collections.find(c => c.id === sel);
        while (cur) { chain.unshift(cur); cur = d.collections.find(c => c.id === cur.parent_id); }
        return `<a href="#" onclick="selectLib('');return false">全部文献</a>` +
          chain.map(c => ` <span class="muted">›</span> <a href="#" onclick="selectLib('${c.id}');return false" class="${c.id === sel ? 'cur' : ''}">${esc(c.name)}</a>`).join('');
      })()}
      <span class="muted" style="margin-left:8px">（在左侧库树点击可切换）</span>
    </div>
    <div class="lib-main" id="lib-main-drop">
        <div class="lib-head">
          <h2 class="page-h row" style="flex:1">${sel ? icon('folder') : icon('library')} ${esc(scopeName)}
            <span class="muted">共 ${total} 篇${scopeIds.length > 1 ? '（含子库）' : ''}${scopeIds.length > 1 ? ` · 本页 ${papers.length} 篇` : ''} · 已译 ${doneTrAll}</span></h2>
          ${sel ? `<button class="btn small primary" onclick="libUpload('${sel}')">${icon('upload')} 上传</button>
          <button class="btn small" onclick="addSubLib('${sel}')" ${treeDepth(sel) >= 2 ? 'disabled title="最多三级"' : ''}>${icon('plus')}子库</button>
          <button class="btn small" title="重命名" onclick="renameLib('${sel}', '${selNameArg}')">${icon('edit')}</button>
          <button class="btn small danger" title="删除库（整棵子树进回收站）" onclick="delLib('${sel}', '${selNameArg}')">${icon('trash')}</button>` : ''}
        </div>
        ${subLibs.length ? `<div class="lib-subbar">
          <span class="muted" style="font-size: var(--fs-sm)">子库：</span>
          ${subLibs.map(k => `<span class="chip" onclick="libOpenLib('${k.id}')" style="cursor:pointer">${icon('folder')} ${esc(k.name)} · ${k.papers ?? 0} 篇</span>`).join('')}
        </div>` : ''}
        <div class="lib-batch" id="lb-${scopeKey}" hidden>
          <b id="lb-count-${scopeKey}">0</b>&nbsp;篇选中
          <button class="btn small primary" onclick="libBatchTranslate('${scopeKey}')">${icon('globe')} 翻译</button>
          <button class="btn small" onclick="libBatchSynth('${scopeKey}')" title="自动分组比对生成综述报告">综述</button>
          <select style="width:auto;font-size: var(--fs-sm)" onchange="libBatchMove('${scopeKey}', this.value, this)"><option value="">移入…</option>${moveOpts(sel)}</select>
          <button class="btn small danger" onclick="libBatchDelete('${scopeKey}')">${icon('trash')} 删除</button>
          <span class="lib-batch-sep"></span>
          <button class="btn small primary" onclick="libToBatchCenter('${scopeKey}')" title="切换到任务中心（勾选全局共享，自动可见）">去任务中心</button>
          <button class="btn small" onclick="libClearSel('${scopeKey}')">清空</button>
          <details class="more-pop"><summary class="btn small">更多 ▾</summary>
            <div class="tool-pop more-menu">
              <div class="tp-item" onclick="libBatchAct('${scopeKey}','summary');this.closest('details').removeAttribute('open')">批量导读（9 字段）</div>
              <div class="tp-item" onclick="libBatchAct('${scopeKey}','meta');this.closest('details').removeAttribute('open')">元数据补全</div>
              <div class="tp-item" onclick="libBatchAct('${scopeKey}','parse');this.closest('details').removeAttribute('open')">批量重解析</div>
              <div class="tp-item" onclick="libBatchBibtex('${scopeKey}');this.closest('details').removeAttribute('open')">导出 BibTeX</div>
            </div>
          </details>
        </div>
        <div class="lib-list">
          ${totalPages > 1 ? `<div class="lib-pager">
            <button class="btn small" ${page <= 1 ? 'disabled' : ''} onclick="libGoPage(${page - 1})">‹ 上一页</button>
            <span class="muted">第 <b>${page}</b> / ${totalPages} 页 · 共 ${total} 篇</span>
            <button class="btn small" ${page >= totalPages ? 'disabled' : ''} onclick="libGoPage(${page + 1})">下一页 ›</button>
          </div>` : `<div class="lib-pager"><span class="muted">共 ${total} 篇</span></div>`}
          <table class="list lib-table"><tr><th style="width:26px"><input type="checkbox" class="lib-ck-all" data-cid="${scopeKey}" title="全选" onchange="libCkAll('${scopeKey}', this.checked)"></th><th>论文</th><th title="解析状态">解析</th><th title="翻译状态">翻译</th><th></th></tr>
            ${paperRows || `<tr><td colspan="5" class="muted">${q ? '没有匹配的论文' : '空库'}</td></tr>`}</table>
        </div>
      </div>`;

  // 导出弹层：范围（当前范围/勾选）× 内容（PDF/MD/对照/BibTeX）→ ZIP
  {
    state._libScopeKey = scopeKey;
    state._libScopePapers = papers;
    const scopeN = $('#exp-scope-n'), selN = $('#exp-sel-n'), selItem = $('#exp-sel-item');
    if (scopeN) scopeN.textContent = total;   // 范围总数（非当前页 25 篇）
    const selCnt = libSelected(scopeKey).length;
    if (selN) selN.textContent = selCnt;
    if (selItem) selItem.hidden = !selCnt;
  }
  // 搜索框：输入去抖后重渲染，并恢复焦点与光标（否则每敲一个字就失焦）
  // 勾选状态持久化在 state.selected（与侧栏/批量中心共享）——重渲染后恢复批量条
  {
    const pre = libSelected(scopeKey);   // 跨页累计（同一范围内勾选不因翻页丢失）
    const bar = $('#lb-' + scopeKey);
    if (bar) { bar.hidden = !pre.length; $('#lb-count-' + scopeKey).textContent = pre.length; }
  }
  const qIn = $('#lib-mgr-q');
  if (qIn) {
    qIn.oninput = e => {
      state.libQuery = e.target.value;
      state._libPage = 1;              // 换搜索词回到第一页
      clearTimeout(state._libQTimer);
      state._libQTimer = setTimeout(async () => {
        await renderCollectionsPage();          // 等重渲染完成再恢复焦点，否则焦点落在被替换的旧节点上
        const n = $('#lib-mgr-q');
        if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      }, 300);
    };
  }
  // 拖 PDF 到右栏 → 上传到当前库
  const main = $('#lib-main-drop');
  if (main) {
    ['dragover', 'dragenter'].forEach(ev => main.addEventListener(ev, e => { e.preventDefault(); main.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => main.addEventListener(ev, e => { e.preventDefault(); main.classList.remove('drag'); }));
    main.addEventListener('drop', e => uploadFiles(e.dataTransfer.files, sel || undefined));
  }
}
window.renderCollectionsPage = renderCollectionsPage;   // 内联 onclick 在全局作用域求值

/* 文库管理·导出弹层：与阅读页下载弹层同款交互（fixed 锚定按钮）。
   document 级事件委托——collections 页每次渲染重建 DOM，一次性绑定会在重渲染后失效。 */
document.addEventListener('click', async e => {
  const btn = e.target.closest?.('#export-btn');
  const pop = $('#export-pop');
  if (btn && pop) {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      const r = btn.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
      pop.style.left = 'auto';
    }
    return;
  }
  const zip = e.target.closest?.('#export-zip-btn');
  if (zip) {
    const scope = document.querySelector('input[name="exp-scope"]:checked')?.value || 'scope';
    const ids = scope === 'sel'
      ? libSelected(state._libScopeKey)
      : (state._libScopePapers || []).map(p => p.id);
    const fmts = $$('#export-pop input[data-fmt]').filter(x => x.checked).map(x => x.dataset.fmt);
    if (!ids.length) { toast('当前范围没有论文'); return; }
    if (!fmts.length) { toast('先勾选要导出的内容'); return; }
    zip.disabled = true; zip.textContent = '打包中…';
    try {
      let url, payload;
      if (fmts.length === 1 && fmts[0] === 'bibtex') {
        url = '/api/papers/export/bibtex'; payload = {paper_ids: ids};   // 纯 BibTeX → 直接 .bib
      } else {
        url = '/api/papers/export-zip'; payload = {paper_ids: ids, fmts};
      }
      const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
                                  body: JSON.stringify(payload)});
      if (!r.ok) throw new Error((await r.json()).detail || 'HTTP ' + r.status);
      const blob = await r.blob();
      const a = Object.assign(document.createElement('a'),
        {href: URL.createObjectURL(blob), download: fmts.length === 1 && fmts[0] === 'bibtex' ? 'references.bib' : '论文导出.zip'});
      a.click(); URL.revokeObjectURL(a.href);
      toast(`已导出 ${ids.length} 篇`);
      pop.hidden = true;
    } catch (err) { toast('导出失败: ' + err.message); }
    zip.disabled = false; zip.innerHTML = icon('download') + ' 导出 ZIP';
    return;
  }
  if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest('#export-btn')) {
    pop.hidden = true;
  }
});

/* 导出弹层的「勾选的 N 篇」与批量条计数同步（弹层只在页面渲染时算过一次，
   勾选后不重渲染 → 数字会停在旧值） */
function syncExportSelCount(cid, n) {
  const selN = $('#exp-sel-n'), selItem = $('#exp-sel-item');
  if (selN) selN.textContent = n;
  if (selItem) selItem.hidden = !n;
}

/* 勾选按【范围】分桶：同一范围内跨页累积（翻页不丢），不同库互不串。
   真值不再查 DOM（DOM 只有当前页 → 翻页后计数与批量操作会丢）。 */
state._selByScope = state._selByScope || {};
function selBucket(cid) {
  const key = cid ?? state.libSel ?? 'all';
  state._selByScope[key] = state._selByScope[key] || new Set();
  return state._selByScope[key];
}
function libSelected(cid) {
  return [...selBucket(cid)];
}
window.libCk = cid => {
  // 勾选状态与全站共享（侧栏批量条 / 批量中心「我的勾选」同一集合）+ 范围分桶真值
  const bucket = selBucket(cid);
  $$(`.lib-ck[data-cid="${cid}"]`).forEach(x => {
    if (x.checked) { bucket.add(x.dataset.pid); state.selected.add(x.dataset.pid); }
    else { bucket.delete(x.dataset.pid); state.selected.delete(x.dataset.pid); }
  });
  const n = libSelected(cid).length;
  $('#lb-' + cid).hidden = !n;
  $('#lb-count-' + cid).textContent = n;
  syncExportSelCount(cid, n);   // 导出弹层的「勾选的 N 篇」即时跟随
  // 总复选框：随行勾选联动（全选 / 半选 / 未选）
  const all = document.querySelector(`.lib-ck-all[data-cid="${cid}"]`);
  if (all) {
    const boxes = $$(`.lib-ck[data-cid="${cid}"]`);
    all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    all.indeterminate = n > 0 && !all.checked;
  }
};
window.libCkAll = async (cid, on) => {
  const bucket = selBucket(cid);
  if (on) {
    // 全选【当前范围】的全部论文（跨页）——后端 all=1 返回范围内所有 id
    try {
      const scope = cid === 'all' ? '' : `collection_id=${encodeURIComponent(cid)}`;
      const d = await api(`/api/papers?all=1${scope ? '&' + scope : ''}`);
      (d.papers || []).forEach(p => { bucket.add(p.id); state.selected.add(p.id); });
    } catch (e) { toast(friendlyError(e, '全选失败')); return; }
  } else {
    bucket.forEach(id => state.selected.delete(id));
    bucket.clear();
  }
  $$(`.lib-ck[data-cid="${cid}"]`).forEach(x => x.checked = on);
  const n = libSelected(cid).length;
  $('#lb-' + cid).hidden = !n;
  $('#lb-count-' + cid).textContent = n;
  syncExportSelCount(cid, n);
  const all = document.querySelector(`.lib-ck-all[data-cid="${cid}"]`);
  if (all) { all.checked = on; all.indeterminate = false; }
};
window.libBatchTranslate = async cid => {
  const ids = libSelected(cid);
  if (!ids.length) { toast('先勾选论文'); return; }
  try {
    const d = await api('/api/batch/translate', {method: 'POST', body: JSON.stringify({paper_ids: ids})});
    toast(`已入队 ${d.queued?.length ?? ids.length} 篇${d.skipped?.length ? `，跳过 ${d.skipped.length} 篇` : ''}——批次进度见任务中心`);
  } catch (e) { toast('批量翻译失败: ' + e.message); }
  await refreshLib();
};
/* 文库页批量条 → 与批量中心同一批次机制（batch_id 进度面板跟踪） */
window.libBatchAct = async (cid, act) => {
  const ids = libSelected(cid);
  if (!ids.length) { toast('先勾选论文'); return; }
  if (act === 'parse' && !(await uiConfirm(`重解析 ${ids.length} 篇将重建全文，译文与旧版本的对应关系作废（仅自己上传的可执行）。继续？`,
      {title: '批量重解析', danger: true}))) return;
  try {
    const d = await api('/api/batch/' + act, {method: 'POST', body: JSON.stringify({paper_ids: ids})});
    toast(`${d.queued.length} 篇已入队${d.skipped.length ? `，跳过 ${d.skipped.length} 篇` : ''}——进度见「任务中心」`);
  } catch (e) { toast('批量操作失败: ' + e.message); }
};
window.libBatchSynth = async cid => {
  const ids = libSelected(cid);
  if (!ids.length) { toast('先勾选论文'); return; }
  await runSynthesis(null, ids);
};
window.libBatchBibtex = async cid => {
  const ids = libSelected(cid);
  if (!ids.length) { toast('先勾选论文'); return; }
  downloadBibtex(ids);
};
window.libToBatchCenter = () => {
  switchPage('tasks');
  setTimeout(() => $('#task-body')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 350);
};
window.libClearSel = cid => {
  $$(`.lib-ck[data-cid="${cid}"]`).forEach(x => {
    x.checked = false;
    state.selected.delete(x.dataset.pid);
  });
  libCk(cid);
};
window.libBatchMove = async (cid, v, sel) => {
  if (!v) return;
  const ids = libSelected(cid);
  if (!ids.length) { toast('先勾选要移动的论文'); return; }
  const target = v === '__none__' ? null : v;
  await withBusy(sel, async () => {
    sel.value = '';
    let ok = 0, bad = 0;
    for (const pid of ids) {
      try {
        await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: target})});
        ok++;
      } catch (e) { bad++; }
    }
    toast(`已移动 ${ok} 篇${bad ? `，${bad} 篇失败` : ''}`);
    await refreshLib();
  }, '移动失败，请重试');
};
window.libBatchDelete = async cid => {
  const ids = libSelected(cid);
  if (!(await uiConfirm(`删除选中的 ${ids.length} 篇？（进回收站，${state.health.trash_days || 30} 天内可恢复）`,
                        {title: '批量删除', danger: true}))) return;
  try {
    await api('/api/papers/batch-delete', {method: 'POST', body: JSON.stringify({paper_ids: ids})});
    ids.forEach(pid => state.selected.delete(pid));
    // 删除是软删除（回收站），给一条「撤销」——误删不必去回收站翻
    toast(`已移入回收站 ${ids.length} 篇`, 0, {
      label: '撤销',
      onClick: async () => {
        await Promise.all(ids.map(pid => api(`/api/papers/${pid}/restore`, {method: 'POST'})
          .catch(() => {})));
        toast('已撤销，恢复 ' + ids.length + ' 篇');
        await refreshLib();
      },
    });
  } catch (e) { toast(friendlyError(e, '批量删除失败')); }
  await refreshLib();
};
window.libUpload = cid => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;   // 不设 accept：与侧栏上传一致（PDF/图片/Office），由 uploadFiles 统一过滤
  inp.onchange = () => uploadFiles(inp.files, cid);
  inp.click();
};
window.renameLib = async (cid, oldName) => {
  const name = await uiPrompt('重命名文献库', {value: oldName, okText: '保存'});
  if (!name?.trim() || name === oldName) return;
  await api('/api/collections/' + cid, {method: 'PATCH', body: JSON.stringify({name: name.trim()})});
  toast('已重命名'); await refreshLib();
};
window.delLib = async (cid, name) => {
  // 子树统计（子库数 + 论文数），确认框里交代清楚删除范围
  const kids = state.collections || [];
  const sub = cid2 => kids.filter(c => c.parent_id === cid2).map(c => c.id);
  let libN = 0, paperN = 0;
  const walk = id => { for (const k of sub(id)) { libN++; paperN += (kids.find(c => c.id === k)?.papers_total ?? 0); walk(k); } };
  walk(cid);
  paperN += (kids.find(c => c.id === cid)?.papers_total ?? 0);
  const scope = `${libN ? `${libN} 个子库、` : ''}库内 ${paperN} 篇论文`;
  if (!(await uiConfirm(`删除文献库「${name}」？${scope}将一并移入回收站（30 天内可恢复）`,
                        {title: '删除文献库'}))) return;
  await api('/api/collections/' + cid, {method: 'DELETE'});
  toast('已删除'); await refreshLib();
};
window.createLibFromPage = async () => {
  const inp = $('#newlib-name');
  const name = inp.value.trim();
  if (!name) { toast('请输入库名'); return; }
  if (name.length > 50) { toast('库名最多 50 个字符'); inp.focus(); return; }
  try {
    await api('/api/collections', {method: 'POST', body: JSON.stringify({name})});
    inp.value = '';
    toast('已创建'); await refreshLib();
  } catch (e) { toast(friendlyError(e, '创建失败，请重试')); }
};
window.delPaperFromLib = async pid => {
  const p = (state.papers || []).find(x => x.id === pid) || (state._libScopePapers || []).find(x => x.id === pid);
  if (p?.visibility === 'shared' && state.me?.role !== 'admin') { toast('共享论文仅管理员可删除'); return; }
  const title = (p?.title || '这篇论文').slice(0, 40);
  if (!(await uiConfirm(`《${title}》移入回收站？（${state.health.trash_days || 30} 天内可恢复）`,
                        {title: '移入回收站'}))) return;
  try {
    await api('/api/papers/' + pid, {method: 'DELETE'});
    toast('已移入回收站', 0, {
      label: '撤销',
      onClick: async () => {
        await api(`/api/papers/${pid}/restore`, {method: 'POST'}).catch(() => {});
        toast('已撤销');
        await refreshLib();
      },
    });
    await refreshLib();
  } catch (e) { toast(friendlyError(e, '删除失败，请重试')); }
};
window.viewPaper = pid => { switchPage('reader'); openPaper(pid); };


/* 图片灯箱预览 */
window.lightbox = (src, caption) => {
  let lb = $('#ps-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ps-lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `<img><p class="lb-cap"></p><button class="lb-close" title="关闭" aria-label="关闭">${icon('close')}</button>`;
    document.body.appendChild(lb);
    lb.onclick = e => { if (e.target === lb || e.target.closest?.('.lb-close')) lb.classList.remove('open'); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') lb.classList.remove('open'); });
  }
  lb.querySelector('img').src = src;
  lb.querySelector('.lb-cap').textContent = caption || '';
  lb.classList.add('open');
};

window.retryPaperJob = async pid => {
  await api(`/api/papers/${pid}/parse`, {method: 'POST'}).catch(() => {});
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [pid]})}).catch(() => {});
  toast('已重新入队'); await refreshLib();
};

window.quickDelete = async (pid, anchor) => {
  const p = state.papers.find(x => x.id === pid);
  if (p?.visibility === 'shared' && state.me?.role !== 'admin') {
    toast('共享论文仅管理员可删除'); return;
  }
  if (!(await uiConfirm(`《${(p?.title || pid).slice(0, 40)}》移入回收站？（${state.health.trash_days || 30} 天内可恢复）`,
                         {title: '移入回收站', anchor}))) return;
  try {
    await api('/api/papers/' + pid, {method: 'DELETE'});
    toast('已移入回收站', 0, {
      label: '撤销',
      onClick: async () => {
        await api(`/api/papers/${pid}/restore`, {method: 'POST'}).catch(() => {});
        toast('已撤销');
        await refreshLib();
      },
    });
    if (state.current?.id === pid) { state.current = null; state.blocks = []; renderContentView(); }
    state.qaPapers.delete(pid);
    await refreshLib();
  } catch (e) { toast(friendlyError(e, '删除失败，请重试')); }
};

/* 导读后的追问建议 */
