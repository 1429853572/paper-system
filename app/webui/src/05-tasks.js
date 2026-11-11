/* ===== 05-tasks.js —— 任务中心与综述：任务聚合/综述列表/报告渲染 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const TASK_TYPES = {
  parse:          {label: '解析',    icon: '🔍', cls: 'tt-parse'},
  translate:      {label: '翻译',    icon: 'globe2', cls: 'tt-translate'},
  summary:        {label: '导读',    icon: 'brain', cls: 'tt-summary'},
  meta:           {label: '元数据',  icon: 'tag2', cls: 'tt-meta'},
  embed_backfill: {label: '索引回填', icon: '🧲', cls: 'tt-embed'},
  synthesis:      {label: '综述',    icon: 'doc', cls: 'tt-synthesis'},
  acquire:        {label: '采集下载', icon: 'inbox', cls: 'tt-acquire'},
};
const taskType = t => TASK_TYPES[t] || {label: t, icon: '•', cls: ''};
state._taskFilter = {type: '', status: ''};

async function renderTasksPage() {
  const el = $('#page-tasks');
  const f = state._taskFilter;
  const chips = (prefix, cur, items) => items.map(([v, label]) =>
    `<button class="chip-btn ${cur === v ? 'on' : ''}" data-${prefix}="${v}">${label}</button>`).join('');
  el.innerHTML = `
    <div class="tasks-wrap">
      <div class="card tasks-head">
        <div class="bp-head" style="border-bottom:none;padding-bottom:4px">
          <b style="font-size:var(--fs-lg)">任务中心</b>
          <span class="muted" style="font-size:11px">解析 / 翻译 / 导读 / 元数据 / 综述——全部任务的实时状态</span>
          <span class="spacer"></span>
          <button class="btn small" id="tk-pause-toggle" title="暂停/恢复批量解析队列（手动任务不受影响）">…</button></div>
        <div class="task-filters">
          <span class="muted" style="font-size:11px">类型</span>
          ${chips('tt', f.type, [['', '全部'], ['parse', '解析'], ['translate', '翻译'],
            ['summary', '导读'], ['meta', '元数据'], ['synthesis', '综述'], ['acquire', '采集下载']])}
          <span class="task-fsep"></span>
          <span class="muted" style="font-size:11px">状态</span>
          ${chips('ts', f.status, [['', '全部'], ['active', '进行中'], ['done', '完成'], ['failed', '失败']])}
        </div>
      </div>
      <div id="mcp-zone"></div>
      <div class="card tasks-body" id="task-body"><p class="muted" style="padding:10px">加载中…</p></div>
      <div class="card syn-list-card" style="margin-top:14px">
        <div class="bp-head"><b>我的综述</b>
          <span class="muted" style="font-size:11px">历史报告永久保存——查看 / 导出 / 删除；进行中的显示实时进度</span></div>
        <div id="syn-list"><p class="muted" style="padding:8px 16px">加载中…</p></div>
      </div>
    </div>`;
  renderSynList();   // 我的综述并入任务中心（原独立批量页已取消）
  // 暂停/恢复单 toggle（原双钮常驻：未暂停点「恢复」静默成功，无状态指示）
  {
    const tb = $('#tk-pause-toggle');
    if (tb) {
      const q = await api('/api/queue/parse').catch(() => null);
      const paused = !!q?.paused;
      tb.textContent = paused ? '▶ 恢复批量（已暂停）' : '⏸ 暂停批量';
      tb.classList.toggle('warn', paused);
      tb.onclick = async () => {
        await api(`/api/queue/parse/${paused ? 'resume' : 'pause'}`, {method: 'POST'});
        toast(paused ? '批量解析已恢复' : '批量解析已暂停（手动任务不受影响）');
        renderTasksPage();
      };
    }
  }
  $$('#page-tasks [data-tt]').forEach(b => b.onclick = () => { state._taskFilter.type = b.dataset.tt; renderTasksPage(); });
  $$('#page-tasks [data-ts]').forEach(b => b.onclick = () => { state._taskFilter.status = b.dataset.ts; renderTasksPage(); });
  await renderTaskPanel();
}

const taskStatusOf = j => ['queued', 'pending_gate', 'running'].includes(j.status) ? 'active'
  : j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'other';

/* 任务错误友好化：后端 error 是技术原文（"MinerU failed: Client error '404 Not Found' for url ..."），
   转成「发生了什么 + 可做什么」，URL 与堆栈细节截断 */
function taskErr(msg) {
  const raw = String(msg || '').replace(/https?:\/\/\S+/g, '').trim();
  if (/404/.test(raw)) return '源文件不可访问（404）——检查链接是否有效';
  if (/403/.test(raw)) return '访问被拒（403）——可能需要登录或已失效';
  if (/timeout|timed out|超时/i.test(raw)) return '请求超时——目标服务未响应，可稍后重试';
  if (/connection|refused|reset/i.test(raw)) return '连接失败——目标服务未启动';
  if (/budget|余额|额度|insufficient/i.test(raw)) return '模型额度不足——请检查 API key 或提高预算';
  if (/invalid|认证|unauthorized|401/i.test(raw)) return '认证失败——请检查 API key';
  const short = raw.replace(/^MinerU failed:\s*/i, '').replace(/^\w+ failed:\s*/i, '').slice(0, 72);
  return short || '任务失败';
}

function taskBody(activeBatches, settledBatches, looseActive, looseDone, activeN, doneN) {
  const f = state._taskFilter;
  const stMap = {queued: '排队', pending_gate: '等GPU', running: '进行中', done: '完成',
                 failed: '失败', canceled: '已取消'};
  /* 单篇任务按论文聚合：同一篇的 解析/导读/元数据/索引回填 合并成一行
     （原先每任务一行 → 同一标题刷屏 N 次，看不出是同一篇） */
  const groupByPaper = jobs => {
    const map = new Map();
    for (const j of jobs) {
      const key = j.paper_id || ('job-' + j.id);
      if (!map.has(key)) map.set(key, {key, title: j.title || j.paper_id || '（无标题）', items: []});
      map.get(key).items.push(j);
    }
    return [...map.values()];
  };
  const row = j => {
    const tt = taskType(j.job_type);
    const bar = j.progress_total > 1
      ? `<div class="up-bar task"><i style="width:${Math.min(100, Math.round(100 * (j.progress_done || 0) / j.progress_total))}%"></i></div>` : '';
    return `<div class="task-row">
      <span class="tt ${tt.cls}">${icon(tt.icon, 11)} ${tt.label}</span>
      <span class="task-main">
        <span class="task-title">${esc(j.title || j.paper_id || '（无标题）')}</span>
        ${bar}
        ${j.error ? `<span class="bpanel-err" style="padding:0">${esc(taskErr(j.error))}</span>` : ''}
      </span>
      <span class="muted" style="font-size:11px;white-space:nowrap">${stMap[j.status] || esc(j.status)}${j.progress_total > 1 ? ` ${j.progress_done}/${j.progress_total}` : ''}</span>
      ${j.status === 'failed' ? `<button class="btn small" data-retry="${j.id}">重试</button>` : ''}
      ${['queued', 'pending_gate', 'running'].includes(j.status) ? `<button class="btn small danger" data-cancel="${j.id}">取消</button>` : ''}
    </div>`;
  };
  /* 聚合行：一篇论文一行 + 各任务类型徽章组 + 汇总状态 */
  const paperRow = g => {
    const items = g.items;
    const failed = items.filter(x => x.status === 'failed');
    const live = items.filter(x => ['queued', 'pending_gate', 'running'].includes(x.status));
    const badgeSet = [...new Map(items.map(x => [x.job_type, x])).values()]
      .map(x => { const t = taskType(x.job_type);
        return `<span class="tt ${t.cls}" title="${esc(t.label)}">${icon(t.icon, 11)}</span>`; }).join('');
    const prog = items.filter(x => x.progress_total > 1)
      .map(x => `<div class="up-bar task"><i style="width:${Math.min(100, Math.round(100 * (x.progress_done || 0) / x.progress_total))}%"></i></div>`).join('');
    const state = failed.length ? ['err', `${failed.length} 个失败`]
      : live.length ? ['run', '进行中'] : ['ok', '已完成'];
    const t0 = items.map(x => x.updated_at || x.created_at).filter(Boolean).sort().pop();
    return `<div class="task-row task-paper">
      <span class="task-badges">${badgeSet}</span>
      <span class="task-main">
        <span class="task-title">${esc(g.title)}</span>
        ${prog}
        ${failed.map(x => `<span class="bpanel-err" style="padding:0">${esc(taskErr(x.error))}</span>`).join('')}
      </span>
      <span class="task-state"><span class="badge ${state[0]}">${state[1]}</span>
        <span class="muted" style="font-size:11px">${esc(relTime(t0))}</span></span>
      ${failed.length ? `<button class="btn small" data-retry="${failed[0].id}">重试</button>` : ''}
      ${live.length ? `<button class="btn small danger" data-cancel="${live[0].id}">取消</button>` : ''}
    </div>`;
  };
  const batchCard = b => {
    const tt = taskType(b.job_type);
    const resolved = b.done + b.failed + b.canceled;
    const badge = b.active > 0 ? ['run', '进行中'] : b.failed > 0 ? ['err', '有失败']
      : b.done > 0 ? ['ok', '完成'] : ['priv', '已取消'];
    return `<div class="bpanel-batch" data-batch="${esc(b.batch_id)}">
      <div class="bpanel-row head" data-tb="${esc(b.batch_id)}">
        <span class="badge ${badge[0]}">${badge[1]}</span>
        <span class="tt ${tt.cls}">${tt.icon} ${tt.label}</span>
        <span class="muted">${b.done}/${b.total}${b.failed ? ` · <span class="berr">${b.failed} 失败</span>` : ''}${b.canceled ? ` · ${b.canceled} 取消` : ''}</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size:11px">${esc(relTime(b.updated_at))}</span>
        <span class="ic">${icon('chevD')}</span>
      </div>
      <div class="bpanel-jobs" data-jobs="${esc(b.batch_id)}" ${state._batchOpen.has(b.batch_id) ? '' : 'hidden'}></div>
    </div>`;
  };
  const sec = (title, inner, empty) =>
    `<div class="bp-sec-title">${title}</div>` + (inner || `<p class="muted" style="padding:2px 0 8px">${empty}</p>`);
  let html = '';
  if (!f.status || f.status === 'active') {
    html += sec(`进行中${activeN ? `（${activeN}）` : ''}`,
      (activeBatches.map(batchCard).join('') || '') +
      (looseActive.length ? `<div class="bpanel-batch">${groupByPaper(looseActive).map(paperRow).join('')}</div>` : ''),
      '没有进行中的任务——发起批量操作或上传论文后，这里实时显示进度');
  }
  if (!f.status || f.status === 'done' || f.status === 'failed') {
    // 已结束默认折叠（历史任务量大，默认铺开会淹没进行中的）
    const doneInner = (settledBatches.map(batchCard).join('') || '') +
      (looseDone.length ? `<div class="bpanel-batch">${groupByPaper(looseDone).map(paperRow).join('')}</div>` : '');
    // 任务记录是纯日志，会无限堆积（本项目已积累 350+ 条，其中失败多是早已
    // 修复的外部源问题）——给一条清理出路，否则历史噪音只增不减。
    const clearBtn = `<button class="btn small" data-jobs-clear="all" title="删除全部已结束任务记录（不影响论文与综述）">清理记录</button>`;
    const doneBlock = (doneInner || `<p class="muted" style="padding:2px 0 8px">暂无已结束任务</p>`) +
      (doneN ? `<div style="padding:6px 0 2px">${clearBtn}</div>` : '');
    html += f.status
      ? sec(`已结束${doneN ? `（${doneN}）` : ''}`, doneBlock, '')
      : `<details class="task-done-fold"><summary class="bp-sec-title">已结束${doneN ? `（${doneN}）` : ''} —— 点击展开</summary>${doneBlock}</details>`;
  }
  return html;
}

async function renderTaskPanel() {
  const body = $('#task-body');
  if (!body) return;
  const f = state._taskFilter;
  let bs = [], jobs = [], pend = [];
  try {
    bs = (await api('/api/batches?limit=20')).batches;
    jobs = (await api('/api/jobs?limit=200')).jobs || [];
    try { pend = (await api('/api/mcp/pending')).pending || []; } catch { /* 忽略 */ }
  } catch (e) {
    body.innerHTML = `<p class="muted" style="padding:10px">加载失败: ${esc(e.message)}</p>`;
    return;
  }
  const stMatch = b => !f.status
    || (f.status === 'active' && b.active > 0)
    || (f.status === 'done' && b.active === 0 && b.done > 0 && !b.failed)
    || (f.status === 'failed' && b.failed > 0);
  const tMatchB = b => !f.type || b.job_type === f.type;
  const actB = bs.filter(b => b.active > 0 && tMatchB(b) && stMatch(b));
  const setB = bs.filter(b => b.active === 0 && tMatchB(b) && stMatch(b)).slice(0, 5);
  actB.forEach(b => state._batchOpen.add(b.batch_id));
  const tMatchJ = j => (!f.type || j.job_type === f.type) && (f.status ? taskStatusOf(j) === f.status || (f.status === 'failed' && j.status === 'canceled') : true);
  const looseActive = jobs.filter(j => !j.batch_id && ['queued', 'pending_gate', 'running'].includes(j.status) && tMatchJ(j)).slice(0, 12);
  const looseDone = jobs.filter(j => !j.batch_id && ['done', 'failed', 'canceled'].includes(j.status) && tMatchJ(j)).slice(0, 12);
  const activeN = actB.length + looseActive.length;
  const doneN = setB.length + looseDone.length;

  // MCP 待确认（不受筛选影响——需要人工动作的始终置顶）
  const mz = $('#mcp-zone');
  if (mz) {
    mz.innerHTML = pend.length
      ? `<div class="card" style="margin-bottom:12px;padding:0"><div class="bp-sec-title" style="padding:10px 16px 2px">MCP 待确认写操作（外部 AI 客户端发起）</div>
         <div style="padding:0 16px 12px">${pend.map(p => `
           <div class="bpanel-row head" style="border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:6px">
             <span class="badge run">待确认</span>
             <span style="flex:1;min-width:0">${esc(p.summary || p.tool)}</span>
             <button class="btn small primary" onclick="mcpConfirm('${esc(p.action_id)}',true)">执行</button>
             <button class="btn small danger" onclick="mcpConfirm('${esc(p.action_id)}',false)">丢弃</button>
           </div>`).join('')}</div></div>`
      : '';
  }
  body.innerHTML = taskBody(actB, setB, looseActive, looseDone, activeN, doneN);
  for (const bid of state._batchOpen) {
    const box = body.querySelector(`[data-jobs="${bid}"]`);
    if (box && !box.hidden) renderBatchJobs(bid, box);
  }
}

// 任务页事件委托：批次展开/收起 + 单篇任务重试/取消
$('#page-tasks').addEventListener('click', async e => {
  // 清理已结束任务记录（任务日志可清，论文/综述不受影响）
  const jclear = e.target.closest('[data-jobs-clear]');
  if (jclear) {
    const scope = jclear.dataset.jobsClear || 'all';
    const what = scope === 'all' ? '全部已结束任务记录' : '失败与取消的任务记录';
    if (!(await uiConfirm(`清理${what}？（仅删日志，不影响论文、译文与综述）`,
                          {title: '清理任务记录', danger: true, anchor: jclear}))) return;
    try {
      const d = await api('/api/jobs/clear-finished?scope=' + scope, {method: 'POST'});
      toast(`已清理 ${d.cleared} 条任务记录`);
    } catch (e) { toast(friendlyError(e, '清理失败')); }
    await renderTaskPanel(); refreshQueueBadge();
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) { await api(`/api/jobs/${retry.dataset.retry}/retry`, {method: 'POST'}); renderTaskPanel(); refreshQueueBadge(); return; }
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) { await api(`/api/jobs/${cancel.dataset.cancel}/cancel`, {method: 'POST'}); renderTaskPanel(); refreshQueueBadge(); return; }
  // 综述批次的 查看报告/MD/CSV/删除（renderSynJob 的按钮渲染在任务页；分支曾只挂在批量页容器上）
  const synView = e.target.closest('[data-syn-view]');
  if (synView) { showSynthesisReport(synView.dataset.synView); return; }
  const synDl = e.target.closest('[data-syn-dl]');
  if (synDl) { location.href = `/api/syntheses/${encodeURIComponent(synDl.dataset.synDl)}/export?fmt=${synDl.dataset.fmt}`; return; }
  const synDel = e.target.closest('[data-syn-del]');
  if (synDel) {
    if (await uiConfirm('删除这篇综述？（报告与矩阵将一并删除，进行中的任务同时取消）',
                        {title: '删除综述', danger: true, anchor: synDel})) {
      try { await api('/api/syntheses/' + encodeURIComponent(synDel.dataset.synDel), {method: 'DELETE'}); } catch { /* ignore */ }
      renderTaskPanel();
    }
    return;
  }
  const head = e.target.closest('.bpanel-row.head[data-tb]');
  if (head) {
    const bid = head.dataset.tb;
    const box = head.parentElement.querySelector('[data-jobs]');
    box.hidden = !box.hidden;
    if (box.hidden) state._batchOpen.delete(bid);
    else { state._batchOpen.add(bid); renderBatchJobs(bid, box); }
  }
});

/* 勾选变化后同步全部计数（卡头/已选定视图/操作卡置灰）——单一数据源，无滞后 */
function syncBpCount() {
  updateBatchOpsState();
}

/* 批量操作卡已移除（统一走文库批量条）——保留空实现以免调用点报错 */
function updateBatchOpsState() {}



/* ---- 综述流水线（批量页核心卡）----
   圈定 → 成本预估确认（缺导读自动补齐 + 组内比对 + 跨组综合 = N 次调用）
   → synthesis job 进批次面板（四阶段进度）→ 完成后查看报告/导出 MD·CSV */
function downloadBibtex(ids) {
  fetch('/api/papers/export/bibtex', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paper_ids: ids})})
    .then(async r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: 'references.bib'});
      a.click(); URL.revokeObjectURL(a.href);
      toast(`已导出 ${ids.length} 篇 BibTeX`);
    })
    .catch(e => toast('导出失败: ' + e.message));
}

/* ---- 专题采集任务：列表 → 详情（候选勾选 → 下载入库 → 综述） ---- */
