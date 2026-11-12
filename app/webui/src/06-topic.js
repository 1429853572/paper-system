/* ===== 06-topic.js —— 专题跟踪与采集：检索/入库/发起综述 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const TASK_STATUS = {draft: '待检索', searching: '检索中', ready: '待勾选',
  downloading: '下载中', ingested: '已入库', reviewing: '综述中', done: '已完成', failed: '失败'};
const taskBadge = st =>
  `<span class="badge ${st === 'done' ? 'ok' : st === 'failed' ? 'err' : 'run'}">${TASK_STATUS[st] || st}</span>`;

async function showTopicsView(container, onBack, hideBack) {
  const el = container || document.querySelector('#cp-body') || $('#page-tasks');
  el.innerHTML = `<div class="batch-wrap"><div class="card pad-x">
    <p class="muted">加载中…</p></div></div>`;
  let tasks = [];
  try { tasks = (await api('/api/acq-tasks')).tasks; }
  catch (e) { el.innerHTML = `<div class="batch-wrap"><div class="card pad-x">
    加载失败：${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `
    <div class="batch-wrap">
      <div class="card topics-head">
        ${hideBack ? '' : '<button class="btn small" id="tp-back">← 返回采集</button>'}
        <h2 class="page-h row" style="flex:1">${icon('library')} 我的专题</h2>
        <button class="btn primary" id="tp-new">${icon('plus')} 新建专题</button>
      </div>
      <div class="card" style="padding:0">
        ${tasks.length ? tasks.map(t => `
          <div class="tp-row" data-tid="${esc(t.id)}">
            ${taskBadge(t.status)}
            <span class="tp-main">
              <b>${esc(t.title)}</b>
              <span class="muted" style="font-size: var(--fs-xs)">${esc(t.query)} · ${esc(t.site)} · 候选 ${t.cand_selected}/${t.cand_total} · 已下载 ${t.cand_done} · 入库 ${t.papers} 篇 · ${esc(relTime(t.updated_at))}</span>
              ${t.error ? `<span class="bpanel-err" style="padding:0">${esc(t.error.slice(0, 120))}</span>` : ''}
            </span>
            <button class="btn small primary" data-tp-open="${esc(t.id)}">打开</button>
            <button class="btn small danger hover-only" title="删除专题" data-tp-del="${esc(t.id)}">${icon('trash')}</button>
          </div>`).join('') : `<div class="empty-state"><p class="t">还没有专题</p><p>专题跟踪会定期按关键词检索，新论文可勾选入库、一键综述</p><button class="btn primary" onclick="newTopicDialog()">${icon('plus')} 新建专题</button></div>`}
      </div>
    </div>`;
  const backBtn = $('#tp-back');
  if (backBtn) backBtn.onclick = () => (onBack ? onBack() : openCollectPanel());
  $('#tp-new').onclick = newTopicDialog;
  $$('[data-tp-open]', el).forEach(b => b.onclick = () =>
    showTopicDetail(b.dataset.tpOpen, el, () => showTopicsView(el, onBack)));
  $$('[data-tp-del]', el).forEach(b => b.onclick = async () => {
    if (!(await uiConfirm('删除这个专题？已入库的论文会保留在文库中。',
                          {title: '删除专题', danger: true, anchor: b}))) return;
    try { await api('/api/acq-tasks/' + b.dataset.tpDel, {method: 'DELETE'}); showTopicsView(); }
    catch (e) { toast('删除失败: ' + e.message); }
  });
}

async function newTopicDialog() {
  const name = await uiPrompt('专题名（同时作为综述的研究问题，例如「3DGS 稀疏视图 中文综述」）',
                               {value: '', placeholder: '专题名'});
  if (!name || !name.trim()) return;
  const q = await uiPrompt('检索关键词', {value: name.trim(), placeholder: '关键词'});
  if (!q || !q.trim()) return;
  try {
    const d = await api('/api/acq-tasks', {method: 'POST', body: JSON.stringify({
      title: name.trim(), query: q.trim(), site: 'chinaxiv'})});
    showTopicDetail(d.id);
    toast('专题已创建，点「检索」开始');
  } catch (e) { toast('创建失败: ' + e.message); }
}

async function showTopicDetail(tid, container, onBack) {
  const el = container || document.querySelector('#cp-body') || $('#page-tasks');
  el.innerHTML = `<div class="batch-wrap"><div class="card pad-x">加载中…</div></div>`;
  let t;
  try { t = (await api('/api/acq-tasks/' + tid)).task; }
  catch (e) { el.innerHTML = `<div class="batch-wrap"><div class="card pad-x">${esc(e.message)}</div></div>`; return; }
  const cands = t.candidates || [];
  const sel = cands.filter(c => c.selected);
  const done = cands.filter(c => c.dl_status === 'done').length;
  const failed = cands.filter(c => c.dl_status === 'failed').length;
  const papers = t.papers_detail || [];
  const parsed = papers.filter(p => p.parse_status === 'parsed').length;
  el.innerHTML = `
    <div class="batch-wrap">
      <div class="card topics-head">
        <button class="btn small" id="td-back">← 我的专题</button>
        <h2 class="page-h row tr ell">${esc(t.title)}</h2>
        ${taskBadge(t.status)}
      </div>
      <div class="card pad-x">
        <div class="bp-sources" style="padding:0">
          <input id="td-q" value="${esc(t.query)}" placeholder="检索关键词" style="flex:1;min-width:140px">
          <select id="td-site" style="width:auto;font-size: var(--fs-sm)">
            <option value="chinaxiv" ${t.site === 'chinaxiv' ? 'selected' : ''}>中国科学院预印本</option>
            <option value="cnki" ${t.site === 'cnki' ? 'selected' : ''}>中国知网</option>
          </select>
          <button class="btn small primary" id="td-search">检索</button>
        </div>
        ${cands.length ? `<div class="muted" style="font-size: var(--fs-xs);margin-top:8px">
          候选 ${cands.length} 条 · 已勾选 ${sel.length} · 已下载 ${done}${failed ? ` · <span class="berr">失败 ${failed}</span>` : ''}
          ${sel.length ? `· <button class="btn small" id="td-dl">下载并入库（${sel.filter(c => c.dl_status !== 'done').length}）</button>` : ''}
          ${sel.length ? `· <button class="btn small" id="td-selall">全选未入库</button>` : ''}
        </div>` : '<p class="muted" style="font-size: var(--fs-xs);margin-top:8px">填关键词点「检索」拉候选（走宿主浏览器，需采集服务在运行）</p>'}
      </div>
      ${cands.length ? `<div class="card" style="padding:0">
        ${cands.map((c, i) => `
          <label class="tp-cand ${c.in_library ? 'have' : ''}">
            <input type="checkbox" data-tc="${esc(c.pdf_url)}" ${c.selected ? 'checked' : ''} ${c.in_library || !c.pdf_url ? 'disabled' : ''}>
            <span class="tp-cand-main">
              <b>${esc(c.title || '')}</b>
              <span class="muted" style="font-size: var(--fs-xs)">${esc([c.authors, c.year, c.venue].filter(Boolean).join(' · ').slice(0, 70))}</span>
              ${c.summary ? `<span class="tp-cand-abs">${esc(c.summary)}</span>` : ''}
            </span>
            ${c.dl_status === 'done' ? '<span class="badge ok">已入库</span>'
              : c.dl_status === 'failed' ? `<span class="badge err" title="${esc(c.error || '')}">失败</span>`
              : c.dl_status === 'skipped' ? '<span class="badge dim" title="无下载链接或内容重复未计入">跳过</span>'
              : c.in_library ? '<span class="badge ok">已在库</span>' : ''}
          </label>`).join('')}
      </div>` : ''}
      <div class="card pad-x">
        <b>已入库论文（${parsed}/${papers.length} 解析完成）</b>
        <div class="muted" style="font-size: var(--fs-xs);margin:6px 0">${papers.length
          ? papers.map(p => esc((p.title || '').slice(0, 40))).join('、')
          : '尚未下载入库任何文献'}</div>
        ${t.synthesis_id ? `<button class="btn small primary" id="td-syn">查看综述报告</button>`
          : `<button class="btn small primary" id="td-mksyn" ${papers.length < 2 ? 'disabled' : ''}>
              ${papers.length < 2 ? '至少需要 2 篇入库论文'
                : parsed < papers.length ? `用已完成的 ${parsed} 篇生成（剔除 ${papers.length - parsed} 篇未完成）`
                : '生成综述报告'}</button>`}
      </div>
    </div>`;
  $('#td-back').onclick = () => (onBack ? onBack() : showTopicsView());
  $('#td-search').onclick = async () => {
    const q = $('#td-q').value.trim();
    const site = $('#td-site').value;
    if (!q) { toast('输入关键词'); return; }
    const btn = $('#td-search');
    btn.disabled = true; btn.textContent = '检索中…';
    try {
      await api(`/api/acq-tasks/${tid}/search`, {method: 'POST', body: JSON.stringify({query: q, site, limit: 30})});
      showTopicDetail(tid);
    } catch (e) { toast('检索失败: ' + e.message); btn.disabled = false; btn.textContent = '检索'; }
  };
  const saveSel = async () => {
    const urls = $$('input[data-tc]', el).filter(x => x.checked && !x.disabled).map(x => x.dataset.tc);
    try { await api(`/api/acq-tasks/${tid}/select`, {method: 'PUT', body: JSON.stringify({pdf_urls: urls})}); }
    catch (e) { toast('保存勾选失败: ' + e.message); }
  };
  $$('input[data-tc]', el).forEach(cb => cb.onchange = saveSel);
  $('#td-selall')?.addEventListener('click', async () => {
    $$('input[data-tc]', el).forEach(x => { if (!x.disabled && !x.closest('.tp-cand').classList.contains('have')) x.checked = true; });
    await saveSel();
    showTopicDetail(tid);
  });
  $('#td-dl')?.addEventListener('click', async () => {
    await saveSel();
    try {
      const d = await api(`/api/acq-tasks/${tid}/download`, {method: 'POST'});
      toast(`已入队下载 ${d.queued} 篇——进度见「任务」页`);
      showTopicDetail(tid);
    } catch (e) { toast('下载入队失败: ' + e.message); }
  });
  $('#td-syn')?.addEventListener('click', () => showSynthesisReport(t.synthesis_id));
  // 进行中（下载/综述/解析未完）→ 自动刷新详情，进度可见
  if (t.status === 'downloading' || t.status === 'reviewing' ||
      (papers.length && parsed < papers.length)) {
    setTimeout(() => {
      // 用户正在输入/编辑时跳过本次轮询（草稿不被覆盖）
      const host = document.querySelector('#cp-body') || $('#page-tasks');
      const busy = document.activeElement?.closest?.('#cp-body');
      if (host?.innerHTML.includes('td-search') && !busy) showTopicDetail(tid);
    }, 4000);
  }
  $('#td-mksyn')?.addEventListener('click', async () => {
    try {
      const d = await api(`/api/acq-tasks/${tid}/synthesize`, {method: 'POST'});
      toast('综述已启动——进度见「任务」页，完成后在此查看');
      showTopicDetail(tid);
    } catch (e) { toast('生成综述失败: ' + e.message); }
  });
}

/* ---- 采集弹层：检索中文文献 → 勾选 → 批量下载入库 ---- */
function openAcquirePop(anchorEl) {
  const pop = $('#acq-pop');
  if (!pop) return;
  pop.hidden = false;
  const el = anchorEl || $('#acq-btn');
  if (el) anchorPop(pop, el);
  else {                         // 无锚点（入口在浮层里，浮层已关闭）→ 靠右固定
    pop.style.position = 'fixed';
    pop.style.top = '96px';
    pop.style.right = '24px';
    pop.style.left = 'auto';
  }
  state._acq = state._acq || {site: 'chinaxiv', q: '', items: [], sel: new Set()};
  renderAcquirePop();
  $('#acq-q')?.focus();
}
function renderAcquirePop() {
  const pop = $('#acq-pop');
  const a = state._acq;
  pop.innerHTML = `
    <div class="acq-tabs">
      <button class="dp-tab ${a.site === 'chinaxiv' ? 'on' : ''}" data-as="chinaxiv">中国科学院预印本</button>
      <button class="dp-tab ${a.site === 'cnki' ? 'on' : ''}" data-as="cnki">中国知网</button>
      <span class="spacer"></span><button class="btn small" id="acq-close" title="关闭">${icon('close')}</button>
    </div>
    <div class="acq-search">
      <input id="acq-q" placeholder="关键词（中文标题/主题）" value="${esc(a.q)}" style="flex:1">
      <button class="btn small primary" id="acq-go">检索</button>
    </div>
    <div class="acq-list">${a.items.length ? a.items.map((it, i) => `
      <label class="acq-item ${it.in_library ? 'have' : ''}">
        <input type="checkbox" data-ai="${i}" ${it.in_library || !it.pdf_url ? 'disabled' : ''}>
        <span class="acq-body">
          <b>${esc(it.title || '')}</b>
          <span class="muted">${esc([it.authors, it.year, it.venue].filter(Boolean).join(' · ').slice(0, 70))}</span>
          ${it.summary ? `<span class="acq-abs">${esc(it.summary)}</span>` : ''}
        </span>
        ${it.in_library ? '<span class="badge ok">已在库</span>' : !it.pdf_url ? '<span class="badge dim">无下载</span>' : ''}
      </label>`).join('') : '<div class="empty-note">输入关键词检索（需宿主采集服务在运行）</div>'}</div>
    <div class="acq-foot">
      <span class="muted" style="font-size: var(--fs-xs)" id="acq-stat"></span>
      <span class="spacer"></span>
      <button class="btn small" id="acq-all">${a.items.every((it, i) => it.in_library || !it.pdf_url || a.sel.has(i)) ? '取消全选' : '全选'}</button>
      <button class="btn small primary" id="acq-import">下载并入库（<span id="acq-n">0</span>）</button>
    </div>`;
  $$('.dp-tab', pop).forEach(b => b.onclick = () => { a.site = b.dataset.as; a.items = []; renderAcquirePop(); });
  $('#acq-close').onclick = () => { pop.hidden = true; };
  $('#acq-go').onclick = doAcquireSearch;
  $('#acq-q').onkeydown = e => { if (e.key === 'Enter') doAcquireSearch(); };
  $$('input[data-ai]', pop).forEach(cb => cb.onchange = e => {
    const i = +cb.dataset.ai;
    if (e.target.checked) a.sel.add(i); else a.sel.delete(i);
    syncAcqCount();
  });
  $('#acq-all').onclick = () => {
    const all = a.items.every((it, i) => it.in_library || !it.pdf_url || a.sel.has(i));
    a.items.forEach((it, i) => { if (it.in_library || !it.pdf_url) return; all ? a.sel.delete(i) : a.sel.add(i); });
    renderAcquirePop();
  };
  $('#acq-import').onclick = doAcquireImport;
  syncAcqCount();
}
function syncAcqCount() {
  const n = document.querySelector('#acq-n');
  if (n) n.textContent = state._acq.sel.size;
  const s = document.querySelector('#acq-stat');
  if (s) s.textContent = state._acq.items.length ? `共 ${state._acq.items.length} 条候选` : '';
}
async function doAcquireSearch() {
  const q = $('#acq-q').value.trim();
  const a = state._acq;
  a.q = q;
  if (!q) { toast('输入关键词'); return; }
  const list = document.querySelector('.acq-list');
  if (list) list.innerHTML = '<p class="muted" style="padding:12px">检索中…（浏览器会话，稍等）</p>';
  try {
    const d = await api('/api/acquire/search', {method: 'POST',
      body: JSON.stringify({site: a.site, query: q, limit: 20})});
    a.items = d.items || [];
    a.sel = new Set();
    renderAcquirePop();
    if (!a.items.length) toast('没有候选结果');
  } catch (e) {
    if (list) list.innerHTML = `<p class="muted" style="padding:12px">检索失败：${esc(e.message)}</p>`;
    toast('检索失败: ' + e.message, 4000);
  }
}
async function doAcquireImport() {
  const a = state._acq;
  const sel = [...a.sel].map(i => a.items[i]).filter(Boolean);
  if (!sel.length) { toast('先勾选要采集的文献'); return; }
  const btn = document.querySelector('#acq-import');
  if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
  try {
    const d = await api('/api/acquire/import', {method: 'POST', body: JSON.stringify({
      items: sel, collection_id: state.currentCollection || null,
      visibility: state.uploadPrivate ? 'private' : 'shared'})});
    const q = d.queued.length, sk = d.skipped.length;
    toast(`已采集 ${q} 篇${sk ? `，跳过 ${sk} 篇` : ''}——解析进度见「任务中心」`, 4000);
    $('#acq-pop').hidden = true;
    a.sel = new Set();
    await refreshLib();
  } catch (e) { toast(quotaTip('采集失败: ' + e.message), 5000); }
  if (btn) { btn.disabled = false; btn.textContent = '下载并入库（' + state._acq.sel.size + '）'; }
}

async function runSynthesis(anchor, ids = null) {
  ids = ids || [...state.selected];
  if (ids.length < 2) { toast('综述至少需要选择 2 篇'); return; }
  let est;
  try {
    est = await api('/api/synthesize/estimate', {method: 'POST', body: JSON.stringify({paper_ids: ids})});
  } catch (e) { toast(friendlyError(e, '估算失败——请确认已勾选 ≥2 篇已解析论文')); return; }

  // 参数弹窗（survey-writer 五问的落地：轴最关键；quick 可空轴）
  const {pop, close} = openPop('syn-launch');
  const extra = {quick: 0, standard: 8, deep: 14};
  // 费用预估：按历史均摊单价 × 调用数（priced=false 表示没有历史样本，不编造数字）
  const cost = est.cost || {};
  // 金额显示：<1 元保留 3 位（0.08 元不该显示成 0.08 元以外的四位小数），≥1 元两位
  const yuan = n => (n >= 1 ? n.toFixed(2) : String(Number(n.toFixed(3)))) + ' 元';
  const costLine = (calls) => cost.priced
    ? `预计费用 <b id="syn-cost">${yuan(cost.per_call * calls)}</b>（按你的历史单价 ¥${yuan(cost.per_call)}/次 × ${calls} 次调用）`
    : '预计调用次数如下；费用按你的历史用量估算（暂无可用样本）';
  const updCalls = () => {
    const tier = pop.querySelector('input[name=syn-tier]:checked')?.value || 'quick';
    const calls = est.calls + extra[tier];
    pop.querySelector('#syn-calls').textContent = calls;
    const ce = pop.querySelector('#syn-cost');
    if (ce) ce.textContent = yuan(cost.per_call * calls);
  };
  pop.innerHTML = `
    <div class="ui-pop-title">发起综述（${est.valid} 篇 · ${est.groups} 组${est.missing_summaries ? ` · 补导读 ${est.missing_summaries}` : ''}）</div>
    <div class="syn-f-row"><label>组织轴</label>
      <input id="syn-axis" placeholder="综述围绕的主线问题（standard/deep 必填），如：前馈大模型输出如何用于 3DGS 初始化"></div>
    <div class="syn-f-row"><label>篇幅档</label>
      <label class="syn-seg"><input type="radio" name="syn-tier" value="quick" checked>快速（~3k 字·一次成文）</label>
      <label class="syn-seg"><input type="radio" name="syn-tier" value="standard">标准（~8k 字·章节化+框架）</label>
      <label class="syn-seg"><input type="radio" name="syn-tier" value="deep">详尽（15k+·核心章逐组）</label></div>
    <div class="syn-f-row"><label>引用式</label>
      <select id="syn-style"><option value="author_year">作者-年份 (Wang et al., 2025a)</option>
        <option value="numeric">数字编号 [1]（GB/T）</option></select></div>
    <div class="syn-f-row"><label>用途</label>
      <select id="syn-purpose"><option value="note">个人笔记（方法细节）</option>
        <option value="proposal">开题/学位（研究空白）</option>
        <option value="submit">投稿初稿（贡献分类）</option></select></div>
    <div class="muted" style="font-size: var(--fs-xs);margin:4px 0">预计 <b id="syn-calls">${est.calls}</b> 次 LLM 调用；${costLine(est.calls)}；引用键表自动核验，机器校验通过才交付</div>
    <div class="ui-pop-foot"><button class="btn small" data-cancel>取消</button>
      <button class="btn small primary" data-ok>开始综述</button></div>`;
  $$('input[name=syn-tier]', pop).forEach(r => r.onchange = updCalls);
  pop.querySelector('[data-cancel]').onclick = close;
  const okBtn = pop.querySelector('[data-ok]');
  okBtn.onclick = async () => {
    const params = {
      axis: pop.querySelector('#syn-axis').value.trim(),
      tier: pop.querySelector('input[name=syn-tier]:checked').value,
      style: pop.querySelector('#syn-style').value,
      purpose: pop.querySelector('#syn-purpose').value};
    close();
    try {
      const d = await api('/api/synthesize', {method: 'POST',
        body: JSON.stringify({paper_ids: ids, params})});
      const n = d.estimate.calls;
      toast(`综述已启动（${params.tier} 档，预计 ${n} 次调用）——进度见「任务中心」`);
      state._batchOpen = new Set([d.batch_id]);
      await renderTaskPanel();
      switchPage('tasks');
      setTimeout(() => $('#task-body')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 350);
    } catch (e) { toast('综述启动失败: ' + e.message); }
  };
}
const BATCH_ST = {queued: '排队', pending_gate: '等GPU', running: '进行中', done: '完成',
                  failed: '失败', canceled: '已取消'};

async function renderBatchJobs(bid, box) {
  try {
    const d = await api('/api/jobs?batch_id=' + encodeURIComponent(bid) + '&limit=300');
    const j0 = d.jobs[0];
    if (d.jobs.length === 1 && j0?.job_type === 'synthesis') {
      let sid = '';
      try { sid = JSON.parse(j0.payload || '{}').synthesis_id || ''; } catch { /* ignore */ }
      if (sid) { await renderSynJob(sid, box); return; }
    }
    box.innerHTML = d.jobs.map(j => `
      <div class="bpanel-row sub">
        <span class="badge ${j.status === 'failed' ? 'err' : j.status === 'done' ? 'ok' : j.status === 'canceled' ? 'dim' : 'run'}">${BATCH_ST[j.status] || esc(j.status)}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title || j.paper_id || '')}</span>
        <span class="muted" style="font-size: var(--fs-xs)">${j.progress_total > 1 ? `${j.progress_done}/${j.progress_total}` : ''}</span>
        ${j.status === 'failed' ? `<button class="btn small" data-retry="${j.id}">重试</button>` : ''}
        ${['queued', 'pending_gate', 'running'].includes(j.status) ? `<button class="btn small danger" data-cancel="${j.id}">取消</button>` : ''}
      </div>${j.error ? `<div class="bpanel-err">${esc(j.error.slice(0, 140))}</div>` : ''}`).join('')
      || '<p class="muted" style="padding:6px">无任务</p>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function renderSynJob(sid, box) {
  let s = null;
  // 轻量 progress 端点（六字段）——detail 全量行含 report_md/evidence 0.2-0.7MB
  try { s = (await api('/api/syntheses/' + encodeURIComponent(sid) + '/progress')).synthesis; } catch { /* ignore */ }
  if (!s) { box.innerHTML = '<p class="muted" style="padding:6px">综述记录不存在（可能已删除）</p>'; return; }
  const stageTxt = {cluster: '聚类分组', group: '组内精读比对', final: '跨组综合'}[s.stage] || s.stage;
  const pct = synPct(s);
  box.innerHTML = `
    <div class="bpanel-row sub">
      ${synBadge(s.status)}
      <span style="flex:1;min-width:0">${esc(s.title)} · ${esc(stageTxt)}${s.status === 'running' ? ` ${s.progress_done}/${s.progress_total}` : ''}</span>
      ${['done', 'needs_fix'].includes(s.status) ? `<button class="btn small primary" data-syn-view="${esc(s.id)}">查看报告</button>
        <button class="btn small" title="导出 Markdown" data-syn-dl="${esc(s.id)}" data-fmt="md">${icon('doc')} MD</button>
        <button class="btn small" title="导出对比矩阵 CSV" data-syn-dl="${esc(s.id)}" data-fmt="csv">${icon('chart')} CSV</button>` : ''}
      <button class="btn small danger hover-only" title="删除综述" data-syn-del="${esc(s.id)}">${icon('trash')}</button>
    </div>
    ${s.status === 'running' ? progressBar(pct, false, 'up-bar parse', 'margin:0 12px 10px') : ''}
    ${s.error ? `<div class="bpanel-err">${esc(s.error)}</div>` : ''}`;
}

/* ---- 综述报告视图（批量页内全屏切换）---- */
async function showSynthesisReport(sid) {
  const el = $('#page-tasks');   // 综述报告属「产出」，并入任务中心（原独立批量页已取消）
  el.classList.add('syn-page');       // 综述报告页放宽容器（全文宽度利用）
  let s;
  try { s = (await api('/api/syntheses/' + encodeURIComponent(sid))).synthesis; }
  catch (e) { toast(friendlyError(e, '综述报告加载失败')); return; }
  // 记录来源：从此页跳到论文后，阅读页顶栏出现「← 返回综述」
  state._synBack = {sid, title: s.title || ''};
  syncSynBackBtn();
  let clusters = [];
  try { clusters = JSON.parse(s.clusters || '[]'); } catch { /* ignore */ }
  let evidence = [];
  try { evidence = JSON.parse(s.evidence || '[]'); } catch { /* ignore */ }
  const evByN = new Map((evidence || []).map(e => [e.n, e]));
  let ver = null, fws = null, ctab = [];
  try { ver = JSON.parse(s.verification || 'null'); } catch { /* ignore */ }
  try { fws = JSON.parse(s.frameworks || 'null'); } catch { /* ignore */ }
  try { ctab = JSON.parse(s.cite_table || '[]'); } catch { /* ignore */ }
  const pr = (() => { try { return JSON.parse(s.params || '{}'); } catch { return {}; } })();
  const pickIdx = (typeof pr.framework === 'number') ? pr.framework : (fws?.recommended ?? 0);
  const byId = new Map([...state.papers, ...state._batchPapers].map(p => [p.id, p]));
  const nav = clusters.map((c, i) => `
    <div class="syn-nav-group">
      <b>${esc(c.name || '组 ' + (i + 1))} <span class="muted">(${(c.paper_ids || []).length} 篇)</span></b>
      ${(c.paper_ids || []).map(pid => {
        const p = byId.get(pid);
        return `<a href="javascript:void 0" data-syn-paper="${esc(pid)}" title="打开阅读">${esc(p ? (p.title || pid) : pid)}</a>`;
      }).join('')}
    </div>`).join('');
  el.innerHTML = `
    <div class="batch-wrap">
      <div class="card syn-head">
        <button class="btn small" id="syn-back">← 返回任务</button>
        <b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</b>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(s.model || '')} · ${esc(relTime(s.updated_at))}</span>
        ${ver ? `<span class="badge ${ver.pass ? 'ok' : 'err'}" title="引用双向校验">${ver.pass ? '✓ 引用校验 PASS' : '引用校验需修复'}（${ver.table_n - ver.missing.length}/${ver.table_n}）</span>` : ''}
        <button class="btn small" id="syn-dl-md">${icon('download')} MD</button>
        <button class="btn small" id="syn-dl-csv">${icon('chart')} CSV</button>
      </div>
      ${clusters.length ? `<details class="syn-groups">
        <summary>${icon('stack')} 主题分组 <span class="muted">${clusters.length} 组 · ${clusters.reduce((n, c) => n + (c.paper_ids || []).length, 0)} 篇（点击标题定位论文）</span></summary>
        <div class="syn-groups-body">${nav}</div>
      </details>` : ''}
      <div class="syn-body">
        <div class="syn-report card" id="syn-report"></div>
      </div>
      ${fws?.frameworks?.length > 1 ? `
      <div class="card syn-fw">
        <b>组织框架</b>
        <div class="syn-fw-cur">当前：${esc(fws.frameworks[pickIdx]?.name || '')} —— ${esc(fws.frameworks[pickIdx]?.rationale || '')}</div>
        <div class="syn-fw-alts">${fws.frameworks.map((f, i) => i === pickIdx ? '' : `
          <button class="btn small" data-fw-rewrite="${i}">换「${esc(f.name)}」重写</button>`).join('')}
        </div>
        <div class="muted" style="font-size: var(--fs-xs)">换框架只重跑章节化（组比对与键表复用，成本约为首次的 1/3）</div>
      </div>` : ''}
      ${ctab.length ? `
      <div class="card syn-refs">
        <b title="键表：综述发起时冻结的论文引用清单（含在线核验结果）。正文引用只出自此表，保证引用真实可查。">参考文献</b>
        <span class="muted" style="font-size: var(--fs-xs)">${ctab.filter(e => e.evidence !== 'inferred').length} 条已核验${ctab.length - ctab.filter(e => e.evidence !== 'inferred').length ? ` · ${ctab.length - ctab.filter(e => e.evidence !== 'inferred').length} 条待核验（元数据未经 API 确认，未进正文）` : ''}</span>
        <div class="syn-refs-list">${ctab.map(e => `
          <div class="syn-ref-row ${e.evidence === 'inferred' ? 'weak' : ''}">
            <code>(${esc(e.key)})</code>
            <span class="syn-ref-main">${esc((e.title || '').slice(0, 60))}
              <span class="muted" style="font-size: var(--fs-xs)">${esc([e.venue, e.year, e.arxiv ? 'arXiv:' + e.arxiv : ''].filter(Boolean).join(' · '))}</span></span>
            ${e.evidence === 'api' ? '<span class="badge ok">已核验</span>'
              : e.evidence === 'watermark' ? '<span class="badge run">水印</span>'
              : e.evidence === 'inferred' ? '<span class="badge err" title="元数据未核验，未进入正文引用">待核验</span>' : ''}
          </div>`).join('')}</div>
      </div>` : ''}
      ${ver && !ver.pass ? `
      <div class="card syn-fix">
        <b style="color:var(--err)">引用校验未通过</b>
        ${ver.missing?.length ? `<div>缺漏（表有文无，${ver.missing.length} 条）：${ver.missing.map(k => `<code>${esc(k)}</code>`).join(' ')}</div>` : ''}
        ${ver.phantom?.length ? `<div>幻影（文有表无）：${ver.phantom.map(k => `<code>${esc(k)}</code>`).join(' ')}</div>` : ''}
        <div class="muted" style="font-size: var(--fs-xs)">可稍后重试综述，或先在文献信息页核验元数据（待核验条目不参与正文引用）</div>
      </div>` : ''}
      ${evidence.length ? `<div class="card syn-ev">
        <b>证据索引（点击编号跳原文）</b>
        <div class="syn-ev-list">${evidence.map(e => `
          <div class="syn-ev-row" data-ev="${e.n}">
            <span class="badge run">E${e.n}</span>
            <span class="syn-ev-main">
              <b>${esc((e.title || e.paper_id || '').slice(0, 50))}</b>
              <span class="muted" style="font-size: var(--fs-xs)">第 ${(e.page_index || 0) + 1} 页 · ${esc((e.text || '').slice(0, 80))}…</span>
            </span>
          </div>`).join('')}</div>
      </div>` : ''}
    </div>`;
  // [E3] → 可点击脚注
  const rep = $('#syn-report');
  if (rep) {
    // E 证据编号不显示（用户口径：正文已有作者-年份引用，编号是生成期内部产物；
    // 新报告在生成端已剥离，此处兜底剥旧报告的残留标记）
    const body = (s.report_md || '报告尚未生成')
      .replace(/^# /gm, '## ')
      .replace(/[【\[]E\d{1,4}[】\]]/g, '');
    rep.innerHTML = mdLite(body);
  }
  // 换框架重写
  $$('#page-tasks [data-fw-rewrite]').forEach(b => b.onclick = async () => {
    if (!(await uiConfirm('用候选框架重写本综述？（组比对与键表复用，只重跑章节化）',
                          {title: '换框架重写', anchor: b}))) return;
    try {
      await api(`/api/syntheses/${encodeURIComponent(sid)}/rewrite`,
                {method: 'POST', body: JSON.stringify({framework: +b.dataset.fwRewrite})});
      toast('重写已入队——进度见「任务」页');
      renderSynList();
    } catch (e) { toast('重写失败: ' + e.message); }
  });
  // 证据索引行点击同样跳原文
  $$('#page-tasks .syn-ev-row').forEach(row => row.onclick = () => {
    const e = evByN.get(+row.dataset.ev);
    if (!e || !e.paper_id) return;
    switchPage('reader');
    openPaper(e.paper_id).then(() => jumpEvidence({
      paper_id: e.paper_id, page_index: e.page_index || 0,
      block_id: e.block_id, text: e.text }));
  });
  // 综述报告整页覆盖了任务页内容 → 返回时需 switchPage 触发 renderTasksPage 重建
  $('#syn-back').onclick = () => { el.classList.remove('syn-page'); switchPage('tasks'); };
  $('#syn-dl-md').onclick = () => { location.href = `/api/syntheses/${encodeURIComponent(sid)}/export?fmt=md`; };
  $('#syn-dl-csv').onclick = () => { location.href = `/api/syntheses/${encodeURIComponent(sid)}/export?fmt=csv`; };
  $$('#page-tasks [data-syn-paper]').forEach(a => a.onclick = () => {
    switchPage('reader');
    openPaper(a.dataset.synPaper);
  });
}


// 批量页可见时轮询进度（SSE 也会触发，双保险；面板不存在时静默跳过）
setInterval(() => {
  const pg = $('#page-tasks');
  if (pg && pg.style.display !== 'none') { renderTaskPanel(); renderSynList(); }
}, 6000);

// SSE 事件风暴节流动作（throttle 前沿放行：风暴期首事件生效，其余丢弃）
const refreshTaskOnBatchSse = throttle(() => { renderTaskPanel(); renderSynList(); }, 2000);
const refreshSidebarOnParse = throttle(() => loadCollections().catch(() => {}), 3000);

/* ---------------- 找相关（Semantic Scholar 三模式排卡，llm-for-zotero /discover_related 式） ----
   推荐/参考文献/引证三页签；勾选一键导入（DOI/标题自动查重，无公开 PDF 不可导）。 */
state._discover = {};        // paper_id → {mode: items | null(失败) | []（加载中）}
state._discMode = 'rec';
state._discSel = new Set();

function discoverCache() {
  return (state._discover[state.current?.id] ||= {});
}

async function openDiscover() {
  const p = state.current;
  if (!p) { toast('先选择论文'); return; }
  const pop = $('#discover-pop');
  pop.hidden = !pop.hidden;
  if (pop.hidden) return;
  anchorPop(pop, $('#discover-btn'));
  state._discSel = new Set();
  renderDiscover();
  await loadDiscover();
}

async function loadDiscover() {
  const pid = state.current?.id;
  const mode = state._discMode;
  const cache = discoverCache();
  if (cache[mode] !== undefined) { renderDiscover(); return; }
  cache[mode] = [];   // 占位防重复拉
  try {
    const d = await api(`/api/papers/${pid}/discover?mode=${mode}&limit=20`);
    cache[mode] = d.items;
  } catch (e) {
    cache[mode] = null;
    toast('找相关失败: ' + e.message);
  }
  if (state.current?.id === pid) renderDiscover();
}

const DISC_LABELS = {rec: '相关推荐', refs: '参考文献', cites: '引证'};

function renderDiscover() {
  const pop = $('#discover-pop');
  if (!pop || pop.hidden) return;
  const mode = state._discMode;
  const items = discoverCache()[mode];
  const body = items === undefined || items === null ? '' : items.length ? items.map((it, i) => `
    <label class="dp-item ${it.in_library ? 'have' : ''}">
      <input type="checkbox" data-di="${i}" ${it.in_library || !it.pdf_url ? 'disabled' : ''}>
      <span class="dp-body">
        <b>${esc(it.title)}</b>
        <span class="muted">${esc([it.year, it.venue, it.citation_count ? '被引 ' + it.citation_count : ''].filter(Boolean).join(' · '))}</span>
        ${it.in_library ? '<span class="badge ok">已在库</span>' : !it.pdf_url ? '<span class="badge dim">无公开PDF</span>' : ''}
        ${it.abstract ? `<span class="dp-abs">${esc(it.abstract)}</span>` : ''}
      </span>
    </label>`).join('') : '<div class="empty-note">该模式下没有结果</div>';
  const foot = items && items.length ? `
    <div class="dp-foot">
      <span class="muted" style="font-size: var(--fs-xs)">勾选一键导入（自动查重）</span>
      <span class="spacer"></span>
      <button class="btn small primary" id="dp-import">导入所选（<span id="dp-n">0</span>）</button>
    </div>` : '';
  pop.innerHTML = `
    <div class="dp-tabs">
      ${Object.entries(DISC_LABELS).map(([k, v]) =>
        `<button class="dp-tab ${k === mode ? 'on' : ''}" data-dm="${k}">${v}</button>`).join('')}
      <span class="spacer"></span>
      <button class="btn small" id="dp-reload" title="重新检索（清缓存）">${icon('retry')}</button>
      <button class="btn small" id="dp-close" aria-label="关闭">${icon('close')}</button>
    </div>
    <div class="dp-list">${items === null ? '<p class="muted" style="padding:14px">加载失败，请稍后重试</p>'
      : items === undefined ? '<p class="muted" style="padding:14px">加载中…</p>' : body}</div>${foot}`;
  const rl = $('#dp-reload');
  if (rl) rl.onclick = e2 => {
    e2.stopPropagation();
    delete discoverCache()[state._discMode];
    renderDiscover();
    loadDiscover();
  };
  $$('.dp-tab', pop).forEach(b => b.onclick = e2 => {
    e2.stopPropagation();   // 处理器内重建了浮层内容，放行冒泡会让 document 的外点关闭逻辑误判（target 已脱离 DOM）
    state._discMode = b.dataset.dm;
    state._discSel = new Set();
    renderDiscover();
    loadDiscover();
  });
  $('#dp-close').onclick = () => { pop.hidden = true; };
  $$('input[data-di]', pop).forEach(cb => cb.onchange = () => {
    if (cb.checked) state._discSel.add(cb.dataset.di);
    else state._discSel.delete(cb.dataset.di);
    const n = $('#dp-n');
    if (n) n.textContent = state._discSel.size;
  });
  $('#dp-import')?.addEventListener('click', async () => {
    const items2 = discoverCache()[state._discMode] || [];
    const sel = [...state._discSel].map(i => items2[+i]).filter(Boolean);
    if (!sel.length) { toast('先勾选要导入的论文'); return; }
    try {
      const d = await api('/api/papers/discover-import', {method: 'POST',
        body: JSON.stringify({items: sel, collection_id: state.currentCollection || null})});
      const q = d.results.filter(x => x.status === 'queued').length;
      const dup = d.results.filter(x => x.status === 'duplicate').length;
      const nopdf = d.results.filter(x => x.status === 'no_pdf').length;
      toast(`已导入 ${q} 篇并开始解析` +
            (dup ? `，${dup} 篇已在库跳过` : '') + (nopdf ? `，${nopdf} 篇无公开 PDF` : ''));
      pop.hidden = true;
      loadPapers();
    } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
  });
}
$('#discover-btn')?.addEventListener('click', e => { e.stopPropagation(); openDiscover(); });
document.addEventListener('click', e => {
  const pop = $('#discover-pop');
  if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest('#discover-btn')) pop.hidden = true;
});

/* SSE 实时进度 */
const refreshCollectionsOnSse = throttle(() => renderCollectionsPage(), 3000);
const refreshQaPapersOnParse = throttle(ev => {
  api('/api/papers').then(d => {
    state.qaAllPapers = d.papers;
    if (state.view === 'qa') {
      renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
      renderQaScope();
      if (ev.status === 'done') toast(`《${(d.papers.find(x => x.id === ev.paper_id) || {}).title || ''}》解析完成，可以提问了`);
    }
  });
}, 3000);
async function watchJobs() {
  const es = new EventSource('/api/jobs/stream');
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    // 解析实时进度 → 侧栏列表“提取中 x/y”（SSE 事件自带 done/total）
    if (ev.job_type === 'parse') {
      const prev = JSON.stringify(state.parseProg[ev.paper_id] || null);
      if (ev.status === 'running') state.parseProg[ev.paper_id] = {done: ev.done || 0, total: ev.total || 0};
      else if (['done', 'failed', 'canceled'].includes(ev.status)) delete state.parseProg[ev.paper_id];
      if (JSON.stringify(state.parseProg[ev.paper_id] || null) !== prev) renderPapers();
    }
    // 导读任务完成 → 重拉并重绘气泡（此前只在生成页轮询，切走或超时就看不到结果）
    if (ev.job_type === 'summary' && ['done', 'failed', 'canceled'].includes(ev.status)) {
      refreshSummaryFor(ev.paper_id, ev.status);
    }
    if (state.current && ev.paper_id === state.current.id && ev.job_type === 'parse' && ev.status === 'done') {
      openPaper(state.current.id);  // 解析完成刷新视图
      loadPapers();
    }
    if (ev.job_type === 'parse' && (ev.status === 'done' || ev.status === 'failed')) {
      refreshSidebarOnParse(ev);   // 侧栏计数节流刷新（导入/上传高峰期数字跟着跳）
      refreshQaPapersOnParse(ev);  // 逐篇事件风暴节流（批量导入 90 篇=90 次全量拉）
    }
    refreshQueueBadge();
    // 批量中心打开时，批次事件实时刷新进度面板（2s 节流，避免逐篇事件风暴全量重建）
    if (ev.batch_id && $('#page-tasks')?.style.display !== 'none') refreshTaskOnBatchSse();
    // 文库管理页打开时同步行内状态（批量导入时每块一事件，全量重建需节流）
    const cp = $('#page-collections');
    const qIn = document.activeElement?.id === 'lib-mgr-q';   // 正在文库管理页搜索框输入
    if (cp && cp.style.display !== 'none' && !qIn) refreshCollectionsOnSse();
  };
}

/* ---------------- 右栏页签：文献信息 / 导读 / 图表 ---------------- */
