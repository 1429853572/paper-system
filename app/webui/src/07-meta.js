/* ===== 07-meta.js —— 元数据与引用：AI 补全/校准/CSL 引用 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const SUMMARY_NAMES = {problem: '研究问题', core_idea: '核心思想', method: '方法', datasets: '数据集',
  baselines: '基线', metrics: '指标', ablation: '消融', complexity: '复杂度', limitations: '局限'};

async function renderMeta() {
  const p = state.current;
  if (!p) { $('#content-view').innerHTML = '<p class="muted">选择论文后查看文献信息</p>'; return; }
  const pid = p.id;
  const [d, notes, refs, cite] = await Promise.all([
    api('/api/papers/' + pid), api(`/api/papers/${pid}/notes`), api(`/api/papers/${pid}/references`),
    api(`/api/papers/${pid}/cite`)
  ]);
  if (state.view !== 'meta' || state.current?.id !== pid) return;   // 用户已切走：丢弃迟到渲染，否则文献信息的导出条/重解析会覆盖图表等新视图
  state._cite = {...cite, paper_id: pid};
  const paper = d.paper;
  state._refs = refs.references;
  const kw = (() => { try { return JSON.parse(paper.keywords || '[]'); } catch { return []; } })();

  const editing = state._metaEdit;
  const metaBody = editing ? `
      <input id="m-f-title" class="m-f-wide" value="${esc(paper.title || '')}" placeholder="标题">
      <div class="meta-line">${icon('user')} <input id="m-f-authors" class="m-f-wide" value="${esc(paper.authors || '')}" placeholder="作者（逗号分隔）"></div>
      <div class="meta-line">${icon('library')}
        <input id="m-f-journal" value="${esc(paper.journal || '')}" placeholder="期刊/会议">
        <input id="m-f-year" value="${esc(paper.year || '')}" placeholder="年" style="width:72px">
        <input id="m-f-volume" value="${esc(paper.volume || '')}" placeholder="卷" style="width:64px">
        <input id="m-f-issue" value="${esc(paper.issue || '')}" placeholder="期" style="width:64px">
        <input id="m-f-pages" value="${esc(paper.pages || '')}" placeholder="页码" style="width:96px">
        <input id="m-f-doi" value="${esc(paper.doi || '')}" placeholder="DOI" style="width:180px"></div>`
    : `
      <h2 id="m-title" style="margin-bottom:8px">${esc(paper.title || paper.id)}</h2>
      <div class="meta-line">${icon('user')} <span id="m-authors">${esc(paper.authors || '—')}</span></div>
      <div class="meta-line" id="m-rank"><span class="muted">期刊分区：加载中…</span></div>
      <div class="meta-line">${icon('library')} <span id="m-src">${esc([paper.journal, paper.year, paper.doi ? 'DOI: ' + paper.doi : ''].filter(Boolean).join(' · ') || '—')}</span>
        ${paper.meta_source ? `<span class="badge ok" title="${esc(paper.meta_verified_at || '')}">${icon('check')} 已校准(${esc(paper.meta_source)})</span>` : '<span class="badge dim">未校准</span>'}</div>
      ${paper.owner_name && paper.owner_id !== state.me?.id ? `<div class="meta-line">${icon('user')} <span class="muted">上传者 ${esc(paper.owner_name)}</span></div>` : ''}`;

  $('#content-view').innerHTML = `
    <div class="meta-head card">
      ${metaBody}
      <div class="meta-line"><span id="m-stars">${[1,2,3,4,5].map(i => `<span class="star ${i <= (notes.importance||0) ? 'on' : ''}" data-i="${i}">${icon('star')}</span>`).join('')}</span>
        ${icon('tag')} <span id="m-tags">${esc(notes.tags || '') || '<i class=muted>点击编辑标签</i>'}</span></div>
      <div class="meta-actions">
        ${editing ? `<button class="btn small primary" onclick="saveMeta('${pid}')">${icon('check')} 保存</button>
        <button class="btn small" onclick="cancelMeta()">取消</button>`
        : `<button class="btn small" onclick="editMeta('${pid}')">${icon('edit')} 编辑</button>`}
        <button class="btn small" onclick="extractMeta('${pid}')" title="用 AI 补全缺失字段（作者/摘要/关键词）">${icon('bolt')} AI 补全</button>
        <button class="btn small" onclick="verifyMeta('${pid}')" title="联网校准：arXiv/S2/CrossRef/OpenAlex/DBLP 比对，改前→改后确认后写入">${icon('globe')} 联网校准</button>
        ${/[\u4e00-\u9fff]/.test(paper.title || '') ? `<button class="btn small" onclick="cnkiCalibrate('${pid}')" title="知网搜索候选，人工确认后写入">🇨🇳 中文源校准</button>` : ''}
      </div>
    </div>
    <div class="card cite-card">
      <h3>${icon('quote')} 引用</h3>
      <div class="cite-preview" id="cite-preview"></div>
      <div class="cite-bar">
        <label for="cite-style">样式</label>
        <select id="cite-style"></select>
        <button class="btn small" onclick="copyCite('${pid}')">${icon('copy')} 复制</button>
      </div>
    </div>
    <div class="card" style="cursor:pointer" onclick="flashAbstract('${pid}')" title="点击在 PDF 中定位摘要">
      <h3>摘要 <span class="muted" style="font-weight:400;font-size: var(--fs-sm)">${icon('pin')}点击定位</span> ${kw.length ? '<span class="muted" style="font-weight:400;font-size: var(--fs-sm)">· 关键词: ' + esc(kw.join(' · ')) + '</span>' : ''}</h3>
      <p style="font-size: var(--fs-base); line-height:1.7">${esc(paper.abstract || '（无——可点 AI 提取）')}</p></div>
    <div class="card"><h3>${icon('note')} 备注</h3>
      <textarea id="m-notes" placeholder="记录阅读笔记…（自动保存）" style="min-height:70px">${esc(notes.notes || '')}</textarea></div>
    <div class="card"><h3>References (${refs.references.length}) <input id="ref-search" placeholder="搜索…" style="width:140px; font-size: var(--fs-sm); margin-left:8px; display:inline-block"></h3>
      <div class="ref-list" id="ref-list"></div></div>
    <div class="card"><h3>${icon('folder')} 文献库</h3>
      <div id="m-collection-chips" class="chip-row"></div>
      <select id="m-collection-add" aria-label="加入文献库" style="max-width:200px;font-size: var(--fs-sm)"></select></div>`;

  renderCiteCard();

  // 文献库多选 chips（多对多：一篇可挂 N 库；×移出，下拉加入）
  const linked = paper.collection_ids || [];
  const chipRow = $('#m-collection-chips');
  chipRow.innerHTML = linked.length
    ? linked.map(cid => {
        const c2 = state.collections.find(x => x.id === cid);
        return `<span class="chip">${icon('folder', 12)} ${esc(c2?.name || cid)}
          <button class="hover-only" title="从此库移出" onclick="unlinkPaper('${pid}','${cid}')">${icon('close', 12)}</button></span>`;
      }).join('')
    : '<span class="muted" style="font-size: var(--fs-sm)">未归类</span>';
  const addSel = $('#m-collection-add');
  addSel.innerHTML = '<option value="">+ 加入库…</option>' + state.collections
    .filter(c2 => !linked.includes(c2.id))
    .map(c2 => `<option value="${c2.id}">${esc(c2.name)}</option>`).join('');
  addSel.onchange = async () => {
    if (!addSel.value) return;
    await api('/api/papers/' + pid + '/collections', {method: 'POST', body: JSON.stringify({collection_id: addSel.value})});
    toast('已加入'); addSel.value = ''; await refreshLib(); renderMeta();
  };

  // 星级
  $$('#m-stars .star').forEach(s => s.onclick = async () => {
    const val = +s.dataset.i === notes.importance ? 0 : +s.dataset.i;
    await api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, importance: val})});
    notes.importance = val; renderMeta();
  });
  // 标签（点行尾进入编辑）
  $('#m-tags').onclick = async e => {
    const v = await uiPrompt('编辑标签（逗号分隔）', {value: notes.tags || '', placeholder: '如：综述, 必读', okText: '保存', anchor: e?.currentTarget});
    if (v === null) return;
    await api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, tags: v})});
    notes.tags = v; renderMeta();
  };
  // 备注自动保存
  $('#m-notes').oninput = debounce(e =>
    api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, notes: e.target.value})})
      .then(() => toast('已保存', 1000)), 800);
  // 参考文献渲染+搜索
  const renderRefs = q => {
    const list = refs.references.filter(r => !q || r.text.toLowerCase().includes(q));
    state._refs = refs.references;
    $('#ref-list').innerHTML = list.map(r =>
      // 全文显示——库里块文本完整，此前 slice(0,150) 把年份/页码静默截掉（用户报告「信息显示不全」）
      `<div class="ref-item" onclick="flashRefBlock('${r.block_id}')">${icon('doc')} ${esc(r.text)}</div>`).join('') ||
      '<div class="empty-note">无匹配</div>';
  };
  renderRefs('');
  $('#ref-search').oninput = e => renderRefs(e.target.value.toLowerCase());
  loadRank(pid);   // 分区自动加载（按期刊缓存，同期刊只查一次）
}

/* 元数据编辑：内联输入框，不弹 prompt 链（原来一次要弹 6 个框）。
   卷/期/页是引用格式需要的字段，一并在这里补。 */
window.unlinkPaper = async (pid, cid) => {
  if (!(await uiConfirm('从此库移出？（论文本体与译文不受影响；全部库移出后落「未归类」）',
                        {title: '移出文献库', danger: true}))) return;
  await api(`/api/papers/${pid}/collections/${cid}`, {method: 'DELETE'});
  toast('已移出'); await refreshLib(); renderMeta();
};
window.editMeta = (pid) => { state._metaEdit = true; renderMeta(); };
window.cancelMeta = () => { state._metaEdit = false; renderMeta(); };
window.saveMeta = async (pid) => {
  const g = id => ($('#' + id)?.value ?? '').trim();
  const body = {
    title: g('m-f-title'), authors: g('m-f-authors'), journal: g('m-f-journal'),
    year: g('m-f-year'), volume: g('m-f-volume'), issue: g('m-f-issue'),
    pages: g('m-f-pages'), doi: g('m-f-doi'),
  };
  try {
    await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify(body)});
    state._metaEdit = false;
    toast('已保存');
    await openPaper(pid);
    renderMeta();
  } catch (e) { toast('保存失败: ' + e.message); }
};
window.verifyMeta = async (pid) => {
  toast('联网校准中…（arXiv/S2/CrossRef/OpenAlex/DBLP，只发送标题）');
  try {
    const r = await api(`/api/papers/${pid}/verify-meta`, {method: 'POST', body: JSON.stringify({})});
    if (!r.verified) { toast('⚠ ' + r.message); return; }
    const c = r.candidate;
    const cur = state.current || {};
    const diff = [
      ['作者', cur.authors, c.authors], ['期刊', cur.journal, c.journal],
      ['年份', cur.year, c.year], ['DOI', cur.doi, c.doi],
      ['卷', cur.volume, c.volume || ''], ['期', cur.issue, c.issue || ''], ['页码', cur.pages, c.pages || ''],
    ].filter(([, a, b]) => (b || '') && (a || '') !== (b || ''));
    if (!diff.length) { toast('✓ 元数据已与 ' + c.source + ' 一致，无需改动'); return; }
    const msg = '以下字段将被更新（来源 ' + c.source + '，标题相似度 ' + c.match + '）：\n' +
      diff.map(([k, a, b]) => `· ${k}: ${a || '（空）'} → ${b}`).join('\n');
    if (!(await uiConfirm(msg, {title: '确认写入校准结果', okText: '写入'}))) return;
    const r2 = await api(`/api/papers/${pid}/verify-meta`,
                         {method: 'POST', body: JSON.stringify({apply: true, candidate: c})});
    toast(r2.applied ? '✓ 元数据已更新' : '写入失败');
    await openPaper(pid);
    renderMeta();
  } catch (e) { toast('校准失败: ' + e.message); }
};
/* 中文源校准（jasminum 式）：知网搜索候选人工确认（best-effort，反爬拦截时明确提示） */
window.cnkiCalibrate = async (pid) => {
  const cur = state.current || {};
  if (!cur.title) { toast('缺少标题'); return; }
  toast('知网检索中…');
  let cands;
  try {
    cands = await api('/api/meta/cnki-search?title=' + encodeURIComponent(cur.title));
  } catch (e) { toast('知网检索失败: ' + e.message); return; }
  if (!cands.candidates.length) { toast('知网未找到候选，可试「联网校准」的 CrossRef 中文分支'); return; }
  const {pop, close} = openPop();
  pop.innerHTML = `
    <div class="ui-pop-title">中文源候选（知网）——选最匹配的一条</div>
    <div class="cnki-list">${cands.candidates.map((c, i) => `
      <label class="cnki-item"><input type="radio" name="cnki" value="${i}">
        <span><b>${esc(c.title)}</b><br><span class="muted" style="font-size: var(--fs-xs)">${esc([c.authors, c.journal, c.year].filter(Boolean).join(' · '))}</span></span>
      </label>`).join('')}</div>
    <div class="ui-pop-foot">
      <button class="btn small" data-cancel>取消</button>
      <button class="btn small primary" data-ok>写入</button></div>`;
  pop.querySelector('[data-cancel]').onclick = close;
  pop.querySelector('[data-ok]').onclick = async () => {
    const pick = pop.querySelector('input[name=cnki]:checked');
    if (!pick) { toast('先选一条候选'); return; }
    const c = cands.candidates[+pick.value];
    try {
      await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({
        authors: c.authors || cur.authors || '', journal: c.journal || cur.journal || '',
        year: c.year || cur.year || '', title: c.title || cur.title})});
      toast('✓ 已按知网候选更新元数据');
      close();
      await openPaper(pid);
      renderMeta();
    } catch (e) { toast('写入失败: ' + e.message); }
  };
};
window.loadRank = async (pid) => {
  const el = $('#m-rank');
  if (!el) return;          // 编辑态没有分区行（分区与引用无关）
  el.innerHTML = '<span class="muted">期刊分区：查询中…</span>';
  try {
    const r = await api(`/api/papers/${pid}/journal-rank`);
    if (r.found) {
      const bits = [r.cas && `中科院·${r.cas}`, r.cas_top && `TOP`,
                    r.jcr && `JCR ${r.jcr}`, r.impact_factor && `IF ${r.impact_factor}`,
                    r.if5 && `5年IF ${r.if5}`, r.warning && `${icon('warn')}预警`].filter(Boolean);
      el.innerHTML = `<span class="badge ok">${icon('chart')}</span> ${esc(bits.join(' · ') || '无分区数据')}
        <span class="muted" style="font-size: var(--fs-xs)">via easyScholar${r.cached ? '（缓存）' : ''}</span>`;
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
/* 引用：卡片里选样式 + 即时预览 + 复制。
   CSL 样式（12 种）经 citeproc-js 本地渲染（vendor），BibTeX 与兜底用后端预渲染。
   citeproc 按需加载（专项轮 R5）：原 967KB 阻塞每页首屏、仅此模块在用——首次调用时
   注入压缩版（vendor/citeproc.min.js，373KB），调用方拿到的 Promise 复用不重复注入。 */
let _citeprocLoad = null;
const ensureCiteproc = () => _citeprocLoad ??= new Promise((resolve, reject) => {
  if (window.citeproc) return resolve();
  const s = document.createElement('script');
  s.src = '/static/vendor/citeproc/citeproc.min.js';
  s.onload = resolve;
  s.onerror = () => { _citeprocLoad = null; reject(new Error('citeproc 加载失败')); };
  document.head.appendChild(s);
});
const _cslCache = {xml: {}, locale: {}};
async function _fetchText(url, cache, key) {
  if (cache[key]) return cache[key];
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  cache[key] = t;
  return t;
}
async function cslRender(item, styleId) {
  await ensureCiteproc();
  const styleXml = await _fetchText(`/static/vendor/csl/${styleId}.csl`, _cslCache.xml, styleId);
  const lang = item.language || 'en-US';
  await _fetchText(`/static/vendor/citeproc/locales-${lang}.xml`, _cslCache.locale, lang);
  const sys = {
    retrieveLocale: l => _cslCache.locale[l] || null,
    retrieveItem: () => item,
  };
  // forceLang=true：GB 官方样式自带 default-locale="zh-CN"，不强制会被压过——
  // 条目语言（en→et al. / zh→等）必须赢
  const eng = new window.citeproc.Engine(sys, styleXml, lang, true);
  eng.updateItems([item.id]);
  const bib = eng.makeBibliography();
  // 数字型样式的 csl-left-margin/right-inline div 间有源码换行——
  // cite-preview 是 pre-wrap，会渲染成多余空行，压掉标签间空白
  return ((bib && bib[1] && bib[1][0]) || '').replace(/>\s+</g, '><');
}
const DEFAULT_STYLE_MAP = {gbt7714: 'china-national-standard-gb-t-7714-2015-numeric'};
function renderCiteCard() {
  const box = $('#cite-preview'), sel = $('#cite-style');
  if (!box || !sel) return;
  const c = state._cite;
  if (!c) { box.textContent = '（引用加载失败）'; return; }
  const opts = [...(c.csl_list || []), ['bibtex', 'BibTeX（导出）']];
  if (DEFAULT_STYLE_MAP[state.citeStyle]) state.citeStyle = DEFAULT_STYLE_MAP[state.citeStyle];
  if (DEFAULT_STYLE_MAP[c.default]) c.default = DEFAULT_STYLE_MAP[c.default];
  if (!opts.some(x => x[0] === state.citeStyle)) state.citeStyle = c.default || opts[0][0];
  sel.innerHTML = opts.map(([k, v]) => `<option value="${k}"${k === state.citeStyle ? ' selected' : ''}>${esc(v)}</option>`).join('');
  _renderCiteBox(box, c, state.citeStyle);
  sel.onchange = () => {
    state.citeStyle = sel.value;
    localStorage.setItem('ps-cite-style', sel.value);
    _renderCiteBox(box, c, sel.value);
  };
}
async function _renderCiteBox(box, c, styleId) {
  const pid = c.paper_id;
  const put = html => { if (state.current?.id === pid && state._cite?.paper_id === pid) box.innerHTML = html; };
  if (styleId === 'bibtex') {   // bibtex 走后端预渲染；其余样式由 cslRender 内部按需加载 citeproc
    const html = c.styles?.[styleId]?.html || '（该样式需要 citeproc 支持库）';
    put(html);
    state._citeRendered = {pid, styleId, html};
    return;
  }
  put('<span class="muted">渲染中…</span>');
  try {
    const html = await cslRender(c.csl_json, styleId);
    if (state.citeStyle !== styleId || state._cite?.paper_id !== pid) return;   // 已切样式/论文：丢弃迟到渲染
    put(html || '（渲染为空）');
    state._citeRendered = {pid, styleId, html};
  } catch (e) {
    put(c.styles?.[styleId]?.html || `<span class="muted">CSL 渲染失败：${esc(e.message)}</span>`);
    // 失败分支不写 _citeRendered——防止把错误提示文案复制进剪贴板
  }
}
window.copyCite = async (pid) => {
  const c = state._cite && state._cite.paper_id === pid ? state._cite
            : await api(`/api/papers/${pid}/cite`);
  const st = state.citeStyle || c.default || 'gbt7714';
  let txt = '';
  if (st === 'bibtex') {
    txt = c.styles?.bibtex?.text || '';
  } else if (state._citeRendered?.pid === pid && state._citeRendered?.styleId === st && state._citeRendered.html) {
    const d = document.createElement('div');
    d.innerHTML = state._citeRendered.html;
    // 数字型样式的 [1] 与正文分属相邻块级节点，textContent 直接拼接会丢间隔
    txt = [...d.querySelectorAll('.csl-left-margin, .csl-right-inline, .csl-entry')]
      .map(n => (n.textContent || '').trim()).filter(Boolean).join(' ')
      .replace(/\s+/g, ' ').trim() || (d.textContent || '').trim();
  }
  if (!txt) { toast('引用为空'); return; }
  toast(await window.copyText(txt) ? '已复制' : '复制失败，请手动选中复制');
};

/* ---------------- 右栏页签：问答 / 导读（与文章并排） ---------------- */
