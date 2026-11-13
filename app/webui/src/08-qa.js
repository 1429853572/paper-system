/* ===== 08-qa.js —— 问答与导读：问答面板/导读流式/会话 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
function renderQaTab() {   // 问答常驻 dock
  renderQaUI($('#qa-dock-body'));
}
function renderQaUI(container) {   // 可注入 content-view（整栏）或 dock body（分屏）
  const pid = state.current?.id;
  // 统一交互：范围 = 已添加的文档 chips（1 篇自然单篇问答，2+ 篇后端自动检索取证对比）
  container.innerHTML = `
    <div class="qa-scope" id="qa-scope"></div>
    <div class="qa-picker">
      <div class="qa-pick-panel" id="qa-pick-panel" hidden>
        <div class="qa-pick-head">添加参与问答的论文 <span class="muted">2 篇以上自动对比 · 已选 <b id="qa-pick-count">0</b></span>
        <button class="btn small" id="qa-pick-close" title="收起（Esc / 点面板外也可关）">${icon('close')}</button></div>
        <div class="qa-pick-tools">
          <input id="qa-pick-filter" placeholder="搜索标题…" style="font-size: var(--fs-sm)">
          <select id="qa-pick-sort" title="组内排序" style="font-size: var(--fs-sm);width:auto;flex:none">
            <option value="recent">最近添加</option>
            <option value="title">标题 A-Z</option>
            <option value="year">年份（新→旧）</option>
          </select>
        </div>
        <div id="qa-pick-list"></div>
      </div>
    </div>
    <div class="qa-parse-hint" id="qa-parse-hint" hidden></div>
    <div class="qa-sess-panel" id="qa-sess-panel" hidden>
      <div class="qa-sess-head">本范围历史会话 <span class="muted" id="qa-sess-count"></span></div>
      <div id="qa-sess-list"></div>
    </div>
    <div class="qa-msgs" id="qa-msgs">
      <div class="qa-no-paper" id="qa-no-paper" hidden>${icon('plus')} 点「＋ 添加论文」或在左侧打开一篇，即可提问<br><span style="font-size:var(--fs-xs)">添加 2 篇以上自动进入对比</span></div>
      <div class="qa-curq" id="qa-curq" hidden title="滚回这个问题">${icon('chat', 12)}<span class="t" id="qa-curq-t"></span></div>
      <div id="qa-sum-bubble"></div>
      <div id="qa-msg-list"></div>
      <div class="qa-jumps">
        <button id="qa-jump-up" title="回到顶部" aria-label="回到顶部"><svg class="ic" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>
        <button id="qa-jump-down" title="跳到最新（含进行中的回答）" aria-label="跳到最新"><svg class="ic" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
      </div>
    </div>
    <div class="qa-quote" id="qa-quote" hidden>
      <span class="muted" style="font-size: var(--fs-xs)">${icon('quote', 12)} 引用</span>
      <div class="qa-quote-text" id="qa-quote-text"></div>
      <button class="btn small" id="qa-quote-clear" title="移除引用">${icon('close')}</button>
    </div>
    <div class="cmdtags" id="cmdtags"></div>
    <div class="qa-input">
      <textarea id="qa-text" placeholder="对着文献提问…（/ 选论文 · ↑↓ 历史 · Ctrl+Enter 发送）"></textarea>
      <button class="btn primary" id="qa-send">发送</button>
    </div>`;
  renderCmdTags($('#cmdtags'));
  renderQaScope();
  populateQaPicker();
  const pickToggle = $('#qa-pick-toggle');           // 仅对比模式渲染（单篇无选择器）
  if (pickToggle) pickToggle.onclick = () => {
    const panel = $('#qa-pick-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderPickList($('#qa-pick-filter').value.toLowerCase()); $('#qa-pick-filter').focus(); }
  };
  const pickClose = $('#qa-pick-close');
  if (pickClose) pickClose.onclick = () => { $('#qa-pick-panel').hidden = true; };
  // 选文搜索接线在 populateQaPicker（200ms 防抖）
  // 历史会话面板（当前范围）
  const sessToggle = $('#qa-sess-toggle');
  if (sessToggle) sessToggle.onclick = () => {
    const panel = $('#qa-sess-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderSessList();
  };
  $('#qa-send').onclick = sendQa;
  $('#qa-quote-clear').onclick = clearQuote;
  $('#qa-text').onkeydown = e => {
    if (e.key === 'Enter' && e.ctrlKey) { sendQa(); return; }
    // ↑↓ 翻历史（zotero-gpt 式）：↑ 首次给最近一条、再按更早；↓ 逐条回来、到底回草稿
    if (e.key === 'ArrowUp' && !e.shiftKey && state.qaHistory.length) {
      if (state._histIdx == null) { e.target._preHist = e.target.value; state._histIdx = 0; }
      else state._histIdx = Math.min(state._histIdx + 1, state.qaHistory.length - 1);
      e.target.value = state.qaHistory[state._histIdx];
      e.target.dispatchEvent(new Event('input'));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && state._histIdx != null) {
      if (state._histIdx > 0) {
        state._histIdx--;
        e.target.value = state.qaHistory[state._histIdx];
      } else {
        state._histIdx = null;
        e.target.value = e.target._preHist ?? '';
      }
      e.target.dispatchEvent(new Event('input'));
      e.preventDefault();
      return;
    }
    // 输入 / 打开论文快选（复用选文面板）
    if (e.key === '/' && e.target.value === '' && state.qaPapers.size) {
      e.preventDefault();
      const panel = $('#qa-pick-panel');
      if (panel) {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) { renderPickList($('#qa-pick-filter')?.value.toLowerCase() || ''); $('#qa-pick-filter')?.focus(); }
      }
      return;
    }
    if (e.key.length === 1) state._histIdx = null;   // 打字即退出历史浏览
  };
  $('#qa-text').oninput = e => {   // 自动长高（上限 150px）
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px';
  };
  // 会话恢复：按「问答范围」过滤（不是当前打开的论文）
  // 范围为空 → 问答区留空并禁用输入；范围有论文 → 加载这些论文的会话
  const scope = [...state.qaPapers];
  // ↑↓ 悬浮箭头 + 「当前问题」置顶条：显示视口上方最近的提问（长回答滚走问题后
  // 仍知道在看的回答对应哪问；翻历史时跟随切换），点击滚回该问题
  const msgs = $('#qa-msgs'), up = $('#qa-jump-up'), down = $('#qa-jump-down'), curq = $('#qa-curq');
  window._qaScrollUI = () => {
    if (!msgs?.isConnected) return;
    down.hidden = msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 90;
    up.hidden = msgs.scrollTop <= 140;
    const top = msgs.getBoundingClientRect().top;
    let target = null, next = null;
    for (const q of msgs.querySelectorAll('#qa-msg-list .msg.user .bubble')) {
      if (q.getBoundingClientRect().bottom < top + 8) target = q;
      else { next = q; break; }
    }
    // 最近的提问就在视口顶部附近可见 → 它自己就是当前答案，条不必出现
    if (target && next && next.getBoundingClientRect().top - top < 60) target = null;
    curq.hidden = !target;
    if (target) {
      curq._target = target;
      const t = $('#qa-curq-t');
      if (t) t.textContent = '问：' + (target.dataset.q || target.textContent).trim().slice(0, 120);
    }
  };
  if (msgs) {
    up.onclick = () => { state._qaFollow = false; msgs.scrollTo({top: 0, behavior: 'smooth'}); };
    down.onclick = () => {   // 跟随模式：流式增长期间保持贴底，用户滚轮/触摸即解除
      state._qaFollow = true;
      msgs.scrollTop = msgs.scrollHeight;
      window._qaScrollUI();
    };
    curq.onclick = () => {   // 落点下让 44px：避免提问恰好被置顶条盖住
      const t = curq._target;
      if (!t || !msgs) return;
      const y = msgs.scrollTop + t.getBoundingClientRect().top - msgs.getBoundingClientRect().top - 44;
      msgs.scrollTo({top: Math.max(0, y), behavior: 'smooth'});
    };
    msgs.addEventListener('scroll', () => window._qaScrollUI(), {passive: true});
    msgs.addEventListener('wheel', () => state._qaFollow = false, {passive: true});
    msgs.addEventListener('touchmove', () => state._qaFollow = false, {passive: true});
  }
  api('/api/chat/sessions').then(d => {
    const hint = $('#qa-no-paper');
    const inp = $('#qa-text');
    if (!scope.length) {                 // 没选论文 → 不显示上一篇的残留问答
      state.qaSession = '';
      const list = $('#qa-msg-list'); if (list) list.innerHTML = '';
      const sum = $('#qa-sum-bubble'); if (sum) sum.innerHTML = '';
      if (hint) hint.hidden = false;
      if (inp) inp.disabled = true;
      window._qaScrollUI?.();
      updateExportBtn();
      return;
    }
    if (hint) hint.hidden = true;
    if (inp) inp.disabled = false;
    const sessions = d.sessions.filter(s =>
      (s.paper_scope || '').split(',').some(p => scope.includes(p)));
    const cur = sessions.find(s => s.id === state.qaSession);
    if (!state.qaSession || !cur) state.qaSession = sessions.length ? sessions[0].id : '';
    if (state.qaSession) loadSession(state.qaSession);
    else renderSumBubble();
    updateExportBtn();
  });
}
/* 导出按钮：没有会话时禁用 */
function updateExportBtn() {
  const b = $('#qa-export');
  if (b) { b.disabled = !state.qaSession; b.title = state.qaSession ? '导出对话记录（Markdown）' : '还没有对话记录'; }
}

/* 导读 = 对话首条默认回答 */
async function renderSumBubble() {
  const el = $('#qa-sum-bubble');
  if (!el) return;
  if (state._sumStreaming) {           // 流式进行中：渲染已累积的段落（DOM 可能被重建过）
    const got = (state._sumStreamState && state._sumStreamState.got) || {};
    el.innerHTML = (state._sumHead || '') +
      '<div class="msg assistant"><div class="bubble" style="width:100%">' +
      `<b class="sum-toggle" data-sum-toggle title="点击展开/收起导读">${icon('copy')} 导读（生成中…）<span class="sum-arrow">▾</span></b>` +
      Object.entries(got).map(([k, v]) =>
        `<div class="summary-sec"><h3>${SUMMARY_NAMES[k] || k}</h3><div class="summary-body">${mdLite(v)}</div></div>`).join('') +
      '</div></div>';
    return;
  }
  const pid = [...state.qaPapers][0] || state.current?.id;
  if (!pid) { el.innerHTML = ''; return; }
  const paper = (state.qaAllPapers || state.papers).find(x => x.id === pid) || state.current || {};
  const title = paper.title || pid;
  const multi = state.qaPapers.size > 1;
  state._sumHead = multi ? `<div class="muted" style="font-size: var(--fs-xs);margin-bottom:4px">已选 ${state.qaPapers.size} 篇 · 导读针对第一篇</div>` : '';
  const cached = state._sumCache?.[pid];
  if (cached) { drawSummary(cached.summary, pid, '#qa-sum-bubble', true); return; }
  const d = await api(`/api/papers/${pid}/summary`).catch(() => null);
  if (d && d.summary) {
    state._sumCache = state._sumCache || {};
    state._sumCache[pid] = d;
    drawSummary(d.summary, pid, '#qa-sum-bubble', true);
  } else {
    el.innerHTML = (state._sumHead || '') + `<div class="msg assistant"><div class="bubble">
      <span class="muted">开始提问前，可先生成该篇的结构化导读：</span><br>
      <button class="btn small primary" style="margin-top:6px" onclick="genSumBubble('${pid}')">${icon('star')} 生成导读</button>
    </div></div>`;
  }
}
window.genSumBubble = async pid => {
  const el = $('#qa-sum-bubble');
  el.innerHTML = (state._sumHead || '') + "<div class=\"msg assistant\"><div class=\"bubble\">" + icon('clock', 12) + " 导读生成中…（全文直读，逐段显示）</div></div>";
  // 流式优先：逐段上屏（用户不用等整篇生成完）
  state._sumStreaming = pid;
  try {
    const streamed = await streamSummary(pid, el);
    if (streamed) return;
  } catch (e) {
    // 流式不可用 → 回退队列模式（任务中心可见进度）
    console.warn('流式导读失败，回退队列：', e);
  } finally {
    state._sumStreaming = null;
  }
  try {
    const d = await api(`/api/papers/${pid}/summary`, {method: 'POST',
      body: JSON.stringify({session_id: state.qaSession, async: true})});
    const jobId = d.job_id;
    state._sumPending = state._sumPending || {};
    state._sumPending[pid] = jobId;
    // 完成检测走 SSE（watchJobs 监听 summary 事件 → refreshSummaryFor 重拉重绘）；
    // 此前这里还轮询 GET /api/jobs/{id}——后端从无该路由，catch 恒 null 空转 10 分钟，已删。
    el.innerHTML = (state._sumHead || '') + `<div class="msg assistant"><div class="bubble">
      导读正在生成——完成后会自动显示，也可到「任务中心」查看进度</div></div>`;
  } catch (e) {
    el.innerHTML = (state._sumHead || '') + `<div class="msg assistant"><div class="bubble">生成失败: ${esc(e.message)} <button class="btn small" onclick="genSumBubble('${pid}')">重试</button></div></div>`;
  }
}

/* 流式导读：POST /summary/stream，逐段解析 SSE → 即时上屏。
   返回 true=流式成功；false=服务端不支持/无产出（调用方回退队列模式）。 */
async function streamSummary(pid, el) {
  const res = await fetch(`/api/papers/${pid}/summary/stream`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: state.qaSession}),
  });
  if (!res.ok || !res.body) return false;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const got = {};
  let final = null;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'section') {
        got[ev.key] = ev.content;
        // 即时上屏：已完成的段落渲染出来（引用先按原文显示，done 后用校验版覆盖）
        // 注意：renderQaUI 会整体重建 dock body（气泡节点被替换）——故状态驱动、每次重渲染
        state._sumStreamState = {pid, got: {...got}};
        renderSumBubble();
      } else if (ev.type === 'done') {
        final = ev;
      } else if (ev.type === 'error') {
        throw new Error(ev.message || '生成失败');
      }
    }
  }
  if (!final) return false;
  state._sumStreamState = null;
  const summary = {sections: final.sections, evidence: final.evidence, cite_map: final.cite_map};
  state._sumCache = state._sumCache || {};
  state._sumCache[pid] = {summary};
  delete (state._sumPending || {})[pid];
  drawSummary(summary, pid, '#qa-sum-bubble', true);   // drawSummary 收 summary 本体
  toast('导读已生成');
  return true;
}
window.streamSummary = streamSummary;

/* 导读完成/失败后的统一处理：重拉 → 写缓存 → 若正在看该论文则重绘气泡 */
async function refreshSummaryFor(pid, status, silent) {
  if (!pid) return;
  if (status !== 'done') {
    delete (state._sumPending || {})[pid];
    if (state.current?.id === pid && !silent) {
      const el = $('#qa-sum-bubble');
      if (el) el.innerHTML = (state._sumHead || '') +
        `<div class="msg assistant"><div class="bubble">导读生成${status === 'failed' ? '失败' : '已取消'}。</div></div>`;
    }
    return;
  }
  try {
    const d = await api(`/api/papers/${pid}/summary`);
    if (!d || !d.summary) return;
    state._sumCache = state._sumCache || {};
    state._sumCache[pid] = d;
    delete (state._sumPending || {})[pid];
    if (state.current?.id === pid) drawSummary(d.summary, pid, '#qa-sum-bubble', true);  // 同上：传 summary 本体
    if (!silent) toast('导读已生成');
  } catch { /* ignore */ }
}
window.refreshSummaryFor = refreshSummaryFor;

/* ---- 上下分栏：拖动调占比；问答可整体关闭/重开回默认位 ---- */
state.rpane = { top: parseFloat(localStorage.getItem('ps-rpane-top') || '55'), readingView: 'orig', split: true };
state.qaOpen = localStorage.getItem('ps-qa-open') === '1';   // 默认收起：手动打开过（'1'）才记住展开
window.applyQaLayout = () => {
  const top = $('#rpane-top'), dock = $('#qa-dock'), handle = $('#rpane-handle');
  if (state.qaOpen) {
    dock.hidden = false; handle.hidden = false;
    top.style.flex = 'none';
    top.style.height = `min(${state.rpane.top}%, calc(100% - 240px))`;   // dock 保底 240px（矮视口不被挤没）
  } else {
    dock.hidden = true; handle.hidden = true;
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
  const apply = () => {
    if (state.qaOpen) { const top = $('#rpane-top'); top.style.flex = 'none'; top.style.height = state.rpane.top + '%'; }
  };
  applyQaLayout();
  $('#qa-dock-close').onclick = closeQa;
  $('#qa-export').onclick = exportChat;
  // 拖拽改占比：起点两处——中间分隔条 #rpane-handle，或问答框标题栏 .qa-dock-head（排除按钮）
  document.addEventListener('pointerdown', e => {
    const onHandle = e.target.closest?.('#rpane-handle');
    const onHead = e.target.closest?.('.qa-dock-head');
    const headBtn = e.target.closest?.('.qa-dock-head button');
    if (!onHandle && !(onHead && !headBtn)) return;
    e.preventDefault();
    const handle = $('#rpane-handle');
    handle?.classList.add('dragging');
    $('#qa-dock')?.classList.add('resizing');
    const move = ev => {
      const body = $('.rpane-body')?.getBoundingClientRect();
      if (!body || !body.height) return;
      const pct = Math.min(94, Math.max(6, Math.round(100 * (ev.clientY - body.top) / body.height)));
      state.rpane.top = pct;
      apply();
    };
    const up = () => {
      handle?.classList.remove('dragging');
      $('#qa-dock')?.classList.remove('resizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      localStorage.setItem('ps-rpane-top', String(state.rpane.top));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
})();
async function renderSessList() {
  const list = $('#qa-sess-list'), count = $('#qa-sess-count');
  if (!list) return;
  const d = await api('/api/chat/sessions').catch(() => ({sessions: []}));
  const scope = [...state.qaPapers];
  const rows = d.sessions.filter(x => (x.paper_scope || '').split(',').some(p => scope.includes(p)));
  if (count) count.textContent = `${rows.length} 条`;
  list.innerHTML = rows.length ? rows.map(x => `
    <div class="qa-sess-item ${x.id === state.qaSession ? 'on' : ''}" onclick="switchSess('${x.id}')">
      <div style="flex:1;min-width:0">
        <div class="qa-sess-title">${esc(x.title || '未命名会话')}</div>
        <div class="muted" style="font-size:var(--fs-xs)">${relTime(x.updated_at)}</div>
      </div>
      <button class="btn small" onclick="event.stopPropagation();renameSess('${x.id}', '${jsArg(x.title || '')}')" title="重命名">${icon('edit', 12)}</button>
      <button class="btn small danger hover-only" onclick="event.stopPropagation();delSess('${x.id}')" title="删除会话">${icon('trash', 12)}</button>
    </div>`).join('') : '<div class="empty-note">当前范围还没有会话</div>';
}
window.switchSess = async sid => {
  state.qaSession = sid;
  $('#qa-sess-panel').hidden = true;
  await loadSession(sid);
  updateExportBtn?.();
};
window.delSess = async sid => {
  if (!(await uiConfirm('删除该会话及其全部消息？此操作不可恢复。', {title: '删除会话', danger: true}))) return;
  await api(`/api/chat/sessions/${sid}`, {method: 'DELETE'});
  if (state.qaSession === sid) state.qaSession = '';
  $('#qa-sess-panel').hidden = true;
  renderQaTab();
  toast('会话已删除');
};
window.renameSess = async (sid, old) => {
  const t = await uiPrompt('重命名会话', {value: old, okText: '保存'});
  if (!t || t === old) return;
  await api(`/api/chat/sessions/${sid}`, {method: 'PATCH', body: JSON.stringify({title: t})});
  renderSessList();
  renderQaTab();
};

function renderQaScope() {
  const el = $('#qa-scope');
  if (!el) return;
  const cnt = $('#qa-pick-count');
  if (cnt) cnt.textContent = state.qaPapers.size;
  const ids = [...state.qaPapers];
  const paperName = p2 => {
    const p = state.qaAllPapers?.find(x => x.id === p2) || state.papers?.find(x => x.id === p2);
    return p?.title || p2;
  };
  // chips 常显：每篇可移除；末尾虚线「＋添加论文」chip = 面板入口（恒在）
  el.hidden = false;
  el.innerHTML = ids.map(p2 =>
    `<span class="chip">${esc(paperName(p2))}<button onclick="qaRemove('${p2}')" title="移除">${icon('close')}</button></span>`).join('') +
    `<button class="chip chip-add" id="qa-pick-toggle" title="添加参与问答的论文（2 篇以上自动对比）">${icon('plus')} 添加论文</button>`;
  const hint = $('#qa-parse-hint');
  if (hint) {
    const waiting = ids
      .map(p2 => state.qaAllPapers?.find(x => x.id === p2))
      .filter(p2 => p2 && p2.parse_status !== 'parsed');
    hint.hidden = !waiting.length;
    if (waiting.length) hint.innerHTML = icon('clock', 12) + " " + waiting.map(p2 =>
      `《${esc((p2.title || '').slice(0, 20))}》${p2.parse_status === 'failed' ? '解析失败，将自动重试' : '正在解析，完成后可对其提问'}`).join('，');
  }
}
window.qaRemove = pid => { state.qaPapers.delete(pid); renderQaScope(); renderSumBubble(); renderQaTab(); };
window.askPreset = q => { $('#qa-text').value = q; sendQa(); };
/* 选文面板全局关闭途径：Esc / 点击面板外（✕ 在面板头；＋添加论文 chip 本身也是开关）。
   模块级只挂一次；弹窗栈非空时让位（栈顶的 Esc 自己处理）。 */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || _uiStack.length) return;
  const p = $('#qa-pick-panel');
  if (p && !p.hidden) { p.hidden = true; e.stopPropagation(); }
});
document.addEventListener('click', e => {
  const p = $('#qa-pick-panel');
  if (p && !p.hidden && !p.contains(e.target) && !e.target.closest('#qa-pick-toggle')) p.hidden = true;
});
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
  // 选文面板状态：组折叠记忆 + 组内排序（持久化）
  state.qaPickOpen = new Set(JSON.parse(localStorage.getItem('ps-pick-open') || '[]'));
  state.qaPickSort = localStorage.getItem('ps-pick-sort') || 'recent';
  const sortSel = $('#qa-pick-sort');
  if (sortSel) {
    sortSel.value = state.qaPickSort;
    sortSel.onchange = () => {
      state.qaPickSort = sortSel.value;
      localStorage.setItem('ps-pick-sort', sortSel.value);
      renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
    };
  }
  const fl = $('#qa-pick-filter');
  if (fl) fl.oninput = debounce(() => renderPickList(fl.value.toLowerCase()), 200);   // 防抖：大库逐键全量重渲染会卡
  const toggle = $('#qa-pick-toggle');
  if (!toggle) return;
  $('#qa-pick-count').textContent = state.qaPapers.size;
}
  // 库 id → 名（我的库 + 他人共享库统一解析）
  const _lib_names = ids => ids.map(cid =>
    ((state.collections || []).find(c => c.id === cid) || {}).name ||
    ((state.sharedLibs || []).find(c => c.id === cid) || {}).name || cid).filter(Boolean);
function renderPickList(filter) {
  const el = $('#qa-pick-list');
  if (!el) return;
  const item = p => {
    const st = p.parse_status !== 'parsed'
      ? `<span class="badge run">${p.parse_status === 'failed' ? '解析失败' : icon('clock', 12) + "解析中"}</span>` : '';
    return `<label class="qa-pick-item ${state.qaPapers.has(p.id) ? 'on' : ''}">
      <input type="checkbox" ${state.qaPapers.has(p.id) ? 'checked' : ''} data-id="${p.id}">
      <span class="qp-title">${esc(p.title || p.id)}</span>
      ${p.year ? `<span class="qp-year">${esc(p.year)}</span>` : ''}${st}
      ${(p.collection_ids || []).length > 1 ? `<span class="muted" style="font-size: var(--fs-xs)" title="${esc(_lib_names(p.collection_ids).join(' · '))}">${esc(_lib_names(p.collection_ids).join('/'))}</span>` : ''}
    </label>`;};
  // 按文献库分组；库多时默认折叠（展开状态记忆），搜索时自动全展开（跨组匹配要一眼可见）
  const papers = state.qaAllPapers || state.papers || [];   // boot 早期 qaAllPapers 可能未加载
  const match = p => !filter || (p.title || '').toLowerCase().includes(filter);
  const sorters = {
    recent: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    title:  (a, b) => (a.title || '').localeCompare(b.title || '', 'zh'),
    year:   (a, b) => (b.year || '').localeCompare(a.year || ''),
  };
  const sortFn = sorters[state.qaPickSort] || sorters.recent;
  const cols = [...(state.collections || [])].sort((a, b) =>
    (b.name === '默认文献库') - (a.name === '默认文献库') ||
    (a.name || '').localeCompare(b.name || '', 'zh'));
  // 多对多：一篇可能挂 N 库 → 分到首个命中的库（Set 勾选会去重 id，视觉不重复）
  const taken = new Set();
  const groups = cols.map(c => ({
    id: c.id, name: c.name,
    papers: papers.filter(p => !taken.has(p.id) && (p.collection_ids || []).includes(c.id) && match(p)
      ? (taken.add(p.id), true) : false),
  }));
  // 他人库中的共享论文（state.collections 只含我的库——不补这组会从选文器消失）
  for (const l of (state.sharedLibs || [])) {
    groups.push({
      id: l.id, name: `${l.name}（共享）`,
      papers: papers.filter(p => !taken.has(p.id) && (p.collection_ids || []).includes(l.id) && match(p)
        ? (taken.add(p.id), true) : false),
    });
  }
  const orphan = papers.filter(p => !(p.collection_ids || []).length && match(p));
  if (orphan.length) groups.push({id: '__orphan', name: '未分库', papers: orphan});
  groups.forEach(g => g.papers.sort(sortFn));
  const visible = groups.filter(g => g.papers.length);
  const matched = visible.reduce((s, g) => s + g.papers.length, 0);
  const open = state.qaPickOpen;
  // 单组不折叠（没意义）；搜索中全展开
  const expandAll = !!filter || visible.length === 1;
  el.innerHTML = (matched
    ? visible.map(g => {
        const isOpen = expandAll || open.has(g.id);
        const selN = g.papers.filter(p => state.qaPapers.has(p.id)).length;
        return `
      <div class="qa-pick-group" data-g="${esc(g.id)}">
        <div class="qa-pick-ghead" data-g="${esc(g.id)}">
          <span>${icon('folder')} ${esc(g.name)}</span>
          <span class="muted" style="font-size: var(--fs-xs)">${selN ? `<b class="qp-sel">${selN} 已选</b> · ` : ''}${g.papers.length} 篇 <span class="qp-caret ${isOpen ? 'open' : ''}">${icon('chevD')}</span></span>
        </div>
        <div class="qa-pick-gbody" ${isOpen ? '' : 'hidden'}>${g.papers.map(item).join('')}</div>
      </div>`;}).join('')
    : '<p class="muted" style="padding:8px">无匹配</p>');
  $$('.qa-pick-ghead', el).forEach(h => h.onclick = () => {
    const gid = h.dataset.g;
    open.has(gid) ? open.delete(gid) : open.add(gid);
    localStorage.setItem('ps-pick-open', JSON.stringify([...open]));
    renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
  });
  const panelWasOpen = !$('#qa-pick-panel')?.hidden;
  const panelFilter = $('#qa-pick-filter')?.value.toLowerCase() || '';
  $$('.qa-pick-item input', el).forEach(cb => cb.onchange = () => {
    const id = cb.dataset.id;
    if (cb.checked) {
      if (state.qaPapers.size >= 6) { cb.checked = false; toast('参与问答的论文最多 6 篇（2 篇以上自动对比；篇数越多噪声越大）'); return; }
      if (state.qaPapers.size >= 10) { cb.checked = false; toast('对比最多 10 篇'); return; }
      state.qaPapers.add(id);
      const p = state.qaAllPapers.find(x => x.id === id);
      if (p && p.parse_status !== 'parsed') autoParseForQA(id, p);   // 未解析 → 自动入解析队列
    } else state.qaPapers.delete(id);
    $('#qa-pick-count').textContent = state.qaPapers.size;
    renderQaScope(); renderSumBubble();
    renderQaTab();
    // 勾选后保持面板展开 + 搜索词（否则每选一篇面板就收起，多选体验很差）
    if (panelWasOpen) {
      const p2 = $('#qa-pick-panel');
      if (p2) { p2.hidden = false; renderPickList(panelFilter); const f2 = $('#qa-pick-filter'); f2?.focus(); }
    }
  });
}
async function loadSession(sid) {
  state.qaSession = sid;
  const el = $('#qa-msgs');
  if (!el) return;
  const list = $('#qa-msg-list');
  if (!list) return;
  if (!sid) { list.innerHTML = ''; window._qaScrollUI?.(); return; }
  const d = await api(`/api/chat/sessions/${sid}/messages`);
  const MARKER = '请生成这篇论文的科研导读';
  const msgs = [];
  for (let i = 0; i < d.messages.length; i++) {
    const m = d.messages[i];
    if (m.role === 'user' && m.content === MARKER) { i++; continue; }  // 导读对由气泡展示，跳过
    try { m._ev = JSON.parse(m.evidence || '[]'); } catch { m._ev = []; }
    msgs.push(m);
  }
  list.innerHTML = msgs.map((m, i) =>
    `<div class="msg ${m.role}"><div class="bubble" data-mi="${i}"${m.role === 'user' ? ` data-q="${esc(m.content).slice(0, 300)}"` : ''}>${m.role === 'assistant' ? renderCites(m.content, m._ev) : esc(m.content)}</div></div>`).join('');
  msgs.forEach((m, i) => {
    if (m.role === 'assistant' && m._ev?.length) {
      const el = $(`#qa-msg-list .bubble[data-mi="${i}"]`);
      if (el) wireCites(el, m._ev);
    }
  });
  renderSumBubble();
  window._qaScrollUI?.();
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
    return !pp || ['parsed', 'skipped'].includes(pp.parse_status);  // skipped 可重解析，允许入 scope
  });
  if (!parsedScope.length) { toast('所选论文尚未解析完成，请稍候'); return; }
  $('#qa-text').value = '';
  state.qaHistory = [text, ...state.qaHistory.filter(x => x !== text)].slice(0, 30);
  state._histIdx = null;
  const quote = state.qaQuote || '';
  $('#qa-msg-list').insertAdjacentHTML('beforeend',
    `<div class="msg user"><div class="bubble" data-q="${esc(text).slice(0, 300)}">${quote ? '<div class="muted" style="font-size: var(--fs-xs);border-left:2px solid #c9d2ee;padding-left:6px;margin-bottom:4px">' + icon('quote', 12) + ' ' + esc(quote.split('\n> ')[1]?.slice(0, 80) || '') + '…</div>' : ''}${esc(text)}</div></div>
     <div class="msg assistant"><div class="bubble" id="qa-live">…</div></div>`);
  const live = $('#qa-live'); live.id = '';
  // 新提问默认跟随到底部（用户上滚解除）
  state._qaFollow = true;
  const msgs = $('#qa-msgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  window._qaScrollUI?.();
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
        if (ev.type === 'delta') {
          // 吸底：跟随模式（点过↓/刚发送）或本就在底部附近 → 跟随流式增长
          const m = $('#qa-msgs');
          const stick = state._qaFollow || (m && m.scrollTop + m.clientHeight >= m.scrollHeight - 120);
          live.textContent += ev.text;
          if (stick && m) m.scrollTop = m.scrollHeight;
          window._qaScrollUI?.();
        }
        else if (ev.type === 'error') live.textContent += `\n[错误] ${ev.message}`;
        else if (ev.type === 'done') {
          state.qaSession = ev.session_id;
          updateExportBtn();
          live.innerHTML = renderCites(live.textContent, ev.evidence);
          wireCites(live, ev.evidence);
          // 证据来源分布（跨文献一目了然）
          const byP = {};
          (ev.evidence || []).forEach(e2 => { byP[e2.title || e2.paper_id] = (byP[e2.title || e2.paper_id] || 0) + 1; });
          const origin = Object.entries(byP).map(([t, n]) => `${esc(t)}×${n}`).join('，');
          if (origin) live.insertAdjacentHTML('beforeend',
            `<div class="evo-line">证据来源: ${origin}</div>`);
          if (ev.citations?.illegal?.length) toast('⚠ 部分引用编号无效: ' + ev.citations.illegal.join(','));
          if (ev.truncated) live.insertAdjacentHTML('beforeend', "<div class=\"muted\" style=\"font-size: var(--fs-xs);margin-top:6px\">" + icon('warn') + " 内容较长，已改为按相关段落检索作答</div>");
        }
      }
    }
  }).catch(e => {   // 网络/解析失败：不再让气泡永远停在"…"
    if (live.isConnected) live.textContent = '请求失败：' + e.message + '（检查网络后重试）';
  });
}
$('#menu-toggle').onclick = () => document.querySelector('.sidebar').classList.toggle('open');
document.addEventListener('click', e => {
  const sb = document.querySelector('.sidebar');
  if (sb.classList.contains('open') && !sb.contains(e.target) && e.target.id !== 'menu-toggle') {
    sb.classList.remove('open');
  }
});
$('#qa-open').onclick = () => {
  const wasReader = $('#page-reader') && $('#page-reader').style.display !== 'none';
  switchPage('reader');
  // 提问键 = 开关（tooltip 承诺的 显示/隐藏）：阅读页内点一下开、再点一下关；
  // 从其他页过来则总是打开
  if (wasReader && state.qaOpen) closeQa();
  else openQaDock();
};

/* ---------------- 命令标签（zotero-gpt 式：短按执行 / 长按编辑） ---------------- */
/* 划词浮条专用 prompt（浮条与命令标签原是同一功能两入口——b2/b3 已从标签排移除） */
const SEL_TAGS = {
  explain: {id: 'sel-explain', label: '解读', prompt: '解释这段文字的含义与上下文（涉及的概念、方法、为什么重要）：\n「{选中文字}」'},
  ask: {id: 'sel-ask', label: '提问', prompt: '', prefill: '关于这段文字：「{选中文字}」\n我的问题：'},
};
const BUILTIN_TAGS = [
  {id: 'b1', label: '📝 快速总结', prompt: '总结本篇论文：核心问题、方法要点、主要结果与局限，5 句以内。（需要 9 字段结构化导读请点「生成导读」）'},
  {id: 'b4', label: '🔎 检索相似', prompt: '在当前文献范围内检索与下面内容最相关的段落，逐条说明它们与这段内容的关联：\n「{选中文字}」'},
];
state._lastSelection = '';

function renderCmdTags(el) {
  if (!el) return;
  const all = [...BUILTIN_TAGS, ...state.cmdtags.map(t => ({...t, custom: true}))];
  el.innerHTML = all.map(t =>
    `<button class="cmdtag" data-tag="${esc(t.id)}" title="${esc(t.prompt || t.prefill || '')}（长按编辑）">${esc(t.label)}</button>`
  ).join('') + '<button class="cmdtag add" id="cmdtag-add" title="新建自定义标签">' + icon('plus', 12) + '</button>';
  $$('.cmdtag[data-tag]', el).forEach(b => {
    const tag = all.find(t => t.id === b.dataset.tag);
    let press = 0, longFired = false;
    b.onmousedown = b.ontouchstart = () => {
      longFired = false;
      press = setTimeout(() => { longFired = true; editTagDialog(tag); }, 550);
    };
    b.onmouseup = b.ontouchend = () => {
      clearTimeout(press);
      if (!longFired) executeTag(tag);
    };
    b.onmouseleave = () => clearTimeout(press);
  });
  $('#cmdtag-add', el).onclick = () => editTagDialog({label: '', prompt: '', custom: true, _new: true});
}

function resolveTagText(tpl) {
  const cur = state.current || {};
  return (tpl || '')
    .replaceAll('{选中文字}', state._lastSelection || '')
    .replaceAll('{当前论文标题}', cur.title || '')
    .replaceAll('{当前论文摘要}', (cur.abstract || '').slice(0, 800));
}

async function executeTag(tag) {
  const ta = $('#qa-text');
  if (!ta) { toast('先打开论文问答'); return; }
  const needsSel = (tag.prompt || tag.prefill || '').includes('{选中文字}');
  if (needsSel && !state._lastSelection) { toast('先在正文中选中一段文字'); return; }
  const text = resolveTagText(tag.prompt || tag.prefill || '');
  if (!text.trim()) { toast('标签内容为空，长按可编辑'); return; }
  if (!$('#page-reader') || $('#page-reader').style.display === 'none') switchPage('reader');
  if (!state.qaOpen) openQaDock();
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  if (tag.prefill) { ta.focus(); return; }   // 就选中提问：预填不发送
  sendQa();
}

function editTagDialog(tag) {
  const isCustom = !!tag.custom;
  const {pop, close} = openPop();
  pop.innerHTML = `
    <div class="ui-pop-title">${isCustom && !tag._new ? '编辑标签' : tag._new ? '新建标签' : '内置标签 → 存为自定义'}</div>
    <input class="ui-pop-input" id="tag-label" value="${esc(tag.label || '')}" placeholder="按钮名称（如 📐 分析公式）" style="margin-bottom:8px">
    <textarea class="ui-pop-input" id="tag-prompt" rows="6" placeholder="提示词，可用占位符：{选中文字} {当前论文标题} {当前论文摘要}">${esc(tag.prompt || tag.prefill || '')}</textarea>
    <div class="ui-pop-foot">
      ${isCustom && !tag._new ? '<button class="btn small danger" data-del>删除</button>' : ''}
      <span class="spacer"></span>
      <button class="btn small" data-cancel>取消</button>
      <button class="btn small primary" data-ok>保存</button>
    </div>`;
  pop.querySelector('[data-cancel]').onclick = close;
  pop.querySelector('[data-ok]').onclick = () => {
    saveTag(tag, pop.querySelector('#tag-label').value.trim(), pop.querySelector('#tag-prompt').value);
    close();
  };
  const del = pop.querySelector('[data-del]');
  if (del) del.onclick = () => { saveTag(tag, null, null); close(); };
  pop.querySelector('#tag-label').focus();
}

async function saveTag(tag, label, prompt) {
  if (label === null) {   // 删除
    state.cmdtags = state.cmdtags.filter(t => t.id !== tag.id);
  } else if (tag.custom || tag._new) {   // 自定义新建/更新
    if (!label) { toast('标签名称不能为空'); return; }
    const exist = state.cmdtags.find(t => t.id === tag.id);
    if (exist) { exist.label = label; exist.prompt = prompt; }
    else state.cmdtags.push({id: 'c' + Date.now().toString(36), label, prompt});
  } else {   // 内置 → 存为自定义副本
    if (!label) { toast('标签名称不能为空'); return; }
    state.cmdtags.push({id: 'c' + Date.now().toString(36), label, prompt});
    toast('已存为自定义标签（原内置标签保留）');
  }
  renderCmdTags($('#cmdtags'));
  try { await api('/api/cmdtags', {method: 'PUT', body: JSON.stringify({tags: state.cmdtags})}); }
  catch (e) { toast('保存失败: ' + e.message); }
}
api('/api/cmdtags').then(d => { state.cmdtags = d.tags || []; renderCmdTags($('#cmdtags')); }).catch(() => {});

/* ---------------- 选中浮条（llm-for-zotero 式：解读/提问/翻译） ---------------- */
function hideSelBar() {
  const b = $('#sel-bar');
  if (b) b.remove();
}

function showSelBar(sel, text) {
  hideSelBar();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const bar = Object.assign(document.createElement('div'), {className: 'sel-bar', id: 'sel-bar'});
  bar.innerHTML = `<button data-a="explain" title="解读选中文字">解读</button>
    <button data-a="ask" title="拿选中文字提问">提问</button>
    <button data-a="quote" title="引用到问答输入框（作为上下文）">引用</button>
    <button data-a="translate" title="翻译选中文字">译</button>
    <button data-a="cite" title="智能提取：选中参考文献条目一键入库（Zotero 智能提取式）">引文</button>`;
  bar.style.top = Math.max(8, rect.top - 36) + 'px';
  bar.style.left = Math.min(innerWidth - 140, Math.max(8, rect.left)) + 'px';
  document.body.appendChild(bar);
  $$('#sel-bar button').forEach(b => b.onclick = () => {
    hideSelBar();
    if (b.dataset.a === 'translate') translateSelection(text);
    else if (b.dataset.a === 'cite') importCitation(text);
    else if (b.dataset.a === 'quote') {
      // 引用到问答输入框（旧划词条的有用能力，保留）
      switchPage('reader');
      if (!state.qaOpen) openQaDock();
      setQuote(text, state.pageNum - 1);
    }
    else executeTag(SEL_TAGS[b.dataset.a === 'explain' ? 'explain' : 'ask']);
  });
}

document.addEventListener('mouseup', e => {
  if (e.target.closest?.('#sel-bar')) return;
  const sel = window.getSelection();
  const text = sel ? String(sel).trim() : '';
  if (text.length < 2) { hideSelBar(); return; }
  const node = sel.anchorNode;
  if (!node?.parentElement?.closest?.('#content-view, .textLayer')) { hideSelBar(); return; }
  state._lastSelection = text;
  try { showSelBar(sel, text); } catch { /* range 已释放等边缘情况 */ }
});
document.addEventListener('selectionchange', () => {
  if (!window.getSelection()?.toString()) hideSelBar();
});

/* 智能提取引文（Zotero 式）：选中参考文献条目 → 解析元数据 → 自动入库 */
async function importCitation(text) {
  // 去掉条目编号前缀 [24] / (2) / 3. —— 提高标题匹配命中
  const cleaned = text.replace(/^\s*\[\d+\]\s*/, '').replace(/^\s*\(\d+\)\s*/, '')
    .replace(/^\s*\d+[.)]\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (cleaned.length < 10) { toast('选中的引文太短，选完整一条（标题+作者）'); return; }
  toast('正在识别引文…');
  try {
    const d = await api('/api/papers/import-identifier', {method: 'POST',
      body: JSON.stringify({text: cleaned, collection_id: state.currentCollection || null,
                            visibility: state.uploadPrivate ? 'private' : 'shared'})});
    const r = d.results[0];
    if (!r) { toast('未能识别该引文'); return; }
    const m = r.metadata || {};
    if (r.status === 'queued') toast(`✓ 已入库《${(m.title || '').slice(0, 40)}》并开始解析`);
    else if (r.status === 'duplicate') toast('该引文已在库中');
    else if (r.status === 'no_pdf') toast(`识别到《${(m.title || '').slice(0, 40)}》但无公开 PDF，未导入`);
    else toast(r.message || '识别失败（可稍后重试）');
  } catch (e) { toast('引文识别失败: ' + e.message); }
}

async function translateSelection(text) {
  const card = Object.assign(document.createElement('div'), {className: 'sel-result', id: 'sel-result'});
  card.innerHTML = `<div class="sr-head"><b>译文</b><span class="spacer"></span>
    <button class="btn small" data-copy>复制</button>
    <button class="btn small" data-close title="关闭">${icon('close')}</button></div>
    <div class="sr-body">翻译中…</div>`;
  document.body.appendChild(card);
  card.querySelector('[data-close]').onclick = () => card.remove();
  try {
    const d = await api('/api/translate-selection', {method: 'POST',
      body: JSON.stringify({text, paper_id: state.current?.id || null})});
    card.querySelector('.sr-body').textContent = d.translation || '（空结果）';
    card.querySelector('[data-copy]').onclick = async () =>
      toast(await window.copyText(d.translation) ? '已复制' : '复制失败');
  } catch (e) {
    card.querySelector('.sr-body').textContent = '翻译失败: ' + e.message;
  }
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try { state.me = await api('/api/me'); }
  catch { return; }
  // 账号信息渲染进头像菜单（旧的 #who 已移除）
  const ai = $('#acc-initial'); if (ai) ai.textContent = (state.me.username || '?').trim()[0].toUpperCase();
  const an = $('#acc-name'); if (an) an.textContent = state.me.username;
  const ar = $('#acc-role'); if (ar) ar.textContent = state.me.role === 'admin' ? '管理员' : '成员';
  // 账号头像菜单
  const accPop = $('#acc-pop');
  $('#acc-btn').onclick = e => {
    e.stopPropagation();
    accPop.hidden = !accPop.hidden;
    if (!accPop.hidden) {
      $('#acc-name').textContent = state.me.username;
      $('#acc-role').textContent = state.me.role === 'admin' ? '管理员' : '成员';
      const ai = $('#acc-admin-item'); if (ai) ai.hidden = state.me.role !== 'admin';
      $('#acc-initial').textContent = (state.me.username || '?').trim()[0].toUpperCase();
    }
  };
  document.addEventListener('click', e => {
    if (!accPop.hidden && !accPop.contains(e.target) && e.target.id !== 'acc-btn') accPop.hidden = true;
  });
  accPop.onclick = async e => {
    const item = e.target.closest('.acc-item');
    if (!item) return;
    accPop.hidden = true;
    const act = item.dataset.act;
    if (act === 'logout') { await fetch('/api/logout', {method: 'POST'}); location.href = '/login'; }
    else if (act === 'settings') switchPage('settings');
    else if (act === 'trash') switchPage('trash');
    else if (act === 'admin') switchPage('admin');   // 管理后台独立页
  };
  // key 缺失提示横幅（公共池开启时问答可用不算缺失；翻译需本人 key）
  {
    const miss = [];
    if (!state.me.llm_usable?.chat) miss.push('问答');
    if (!state.me.llm_configured.translate) miss.push('翻译');
    if (miss.length) $('.main').insertAdjacentHTML('afterbegin',
      `<div class="check-banner">${icon('warn')}️ ${miss.join('与')}不可用——前往 <a href="#" onclick="switchPage('settings');return false">设置页</a> 配置对应 LLM key。</div>`);
  }
  await initPdfJs();
  state.mainView = 'read'; state.view = state.rpane.readingView || 'orig';
  applyQaLayout();
  updateVisToggle(); updateUploadTarget(); updateExportBtn();
  if (state.qaOpen) renderQaTab();   // 问答 dock（按记忆的开合状态）
  await loadCollections();
  await loadPapers();
  watchJobs();
  pollHealth();
}
boot().then(() => setTimeout(showOnboardingOnce, 600)).catch(() => {});

/* ================= 跨文献讨论（覆盖层） ================= */
/* 行内编号列表拆分：模型常把「方法」写成一行 '1) xxx 2) yyy'，需按序号切分。
   仅当序号从 1 连续递增时才拆（避免误伤 F1=0.523 / (2024) 之类）。 */
function splitInlineList(text) {
  // 编号前只允许空白或中文句读（不含括号——否则 "Sim(3)" 会被误当编号）
  const re = /(?:^|[\s。；;，,、])(\d{1,2})\)\s+/g;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ num: +m[1], start: m.index, from: re.lastIndex });
  if (hits.length < 2) return null;
  // 从 1 起贪心取连续递增的编号（跳过误命中项，如 "Sim(3)"）
  const picked = [];
  let expect = 1;
  for (const h of hits) if (h.num === expect) { picked.push(h); expect++; }
  if (picked.length < 2) return null;
  const lead = text.slice(0, picked[0].start).trim();
  const items = picked.map((h, i) => ({
    num: h.num,
    content: text.slice(h.from, i + 1 < picked.length ? picked[i + 1].start : text.length).trim(),
  }));
  return { lead, items };
}
