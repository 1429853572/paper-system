/* ===== 13-cmd.js —— 命令面板与快捷键 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const CMD_PAGES = [
  {label: '阅读', hint: '页面', kw: 'read 阅读论文', run: () => switchPage('reader')},
  {label: '文库管理', hint: '页面', kw: 'collections 文库 库', run: () => switchPage('collections')},
  {label: '采集文献 / 专题跟踪', hint: '动作', kw: 'collect 采集 专题 知网 chinaxiv', run: () => { switchPage('collections'); setTimeout(() => openCollectPanel(), 200); }},
  {label: '任务中心', hint: '页面', kw: 'tasks 任务 队列 进度', run: () => switchPage('tasks')},
  {label: '文献追踪', hint: '页面', kw: 'tracker 追踪 订阅 巡逻 收件箱', run: () => switchPage('tracker')},
  {label: '表格工作台', hint: '页面', kw: 'tables 表格 收割 整理 导出 xlsx', run: () => switchPage('tables')},
  {label: '管理后台', hint: '页面 · admin', kw: 'admin 管理 成员 限额 邮件', run: () => switchPage('admin')},
  {label: '回收站', hint: '页面', kw: 'trash 回收 删除', run: () => switchPage('trash')},
  {label: '设置', hint: '页面', kw: 'settings 设置 key 密钥', run: () => switchPage('settings')},
  {label: '我的用量', hint: '页面', kw: 'usage 用量 配额 磁盘 token', run: () => { switchPage('settings'); setTimeout(() => renderSettings('usage'), 120); }},
];
const CMD_ACTIONS = [
  {label: '上传文献', hint: '动作', kw: 'upload 上传 pdf', run: () => { switchPage('reader'); $('#upload-arrow')?.click(); }},
  {label: '粘贴 DOI / arXiv / BibTeX 导入', hint: '动作', kw: 'doi arxiv bibtex 导入 identifier', run: () => { switchPage('reader'); $('#upload-arrow')?.click(); setTimeout(() => $('#ident-input')?.focus(), 200); }},
  {label: '目录批量导入', hint: '动作', kw: '目录 导入 inbox dir', run: () => { switchPage('reader'); $('#upload-arrow')?.click(); }},
  {label: '新建专题跟踪', hint: '动作', kw: 'topic 专题 采集 关键词', run: () => { switchPage('collections'); setTimeout(() => { openCollectPanel(); newTopicDialog(); }, 250); }},
  {label: '快速采集文献（检索入库）', hint: '动作', kw: 'acquire 采集 检索 知网 chinaxiv', run: () => { switchPage('collections'); setTimeout(() => openAcquirePop(), 250); }},
  {label: '发起综述', hint: '动作', kw: 'synthesis 综述 survey 报告', run: () => { switchPage('collections'); setTimeout(() => runSynthesis(null), 250); }},
  {label: '我的综述报告列表', hint: '跳转', kw: '综述 报告 syntheses 历史', run: () => { switchPage('tasks'); setTimeout(() => $('#syn-list')?.scrollIntoView({behavior: 'smooth'}), 400); }},
  {label: '翻译当前论文', hint: '动作', kw: 'translate 翻译', run: () => { switchPage('reader'); setTimeout(() => startTranslate?.(), 250); }},
  {label: '生成/查看导读', hint: '动作', kw: 'summary 导读', run: () => {
    switchPage('reader');
    setTimeout(() => {   // 导读气泡在问答 dock 内：先开 dock，再对当前论文触发
      openQaDock();
      if (state.current?.id) genSumBubble(state.current.id);
      else toast('先在左侧列表打开一篇论文');
    }, 250);
  }},
  {label: '找相关文献', hint: '动作', kw: 'discover 相关 推荐 引用', run: () => { switchPage('reader'); setTimeout(() => openDiscover(), 300); }},
  {label: '文献信息 / 元数据校准', hint: '动作', kw: 'meta 元数据 校准 校验', run: () => { switchPage('reader'); setTimeout(() => switchView('meta'), 250); }},
  {label: '导出引用（BibTeX/CSL）', hint: '动作', kw: 'cite 引用 bibtex csl 导出', run: () => { switchPage('reader'); setTimeout(() => { switchView('meta'); $('#cite-preview')?.scrollIntoView({block: 'center'}); }, 250); }},
  {label: '下载中心（PDF/对照/ZIP）', hint: '动作', kw: 'download 下载 zip pdf', run: () => { switchPage('reader'); setTimeout(() => $('#download-btn')?.click(), 250); }},
];

function cmdPapers() {
  return (state.papers || []).slice(0, 200).map(p => ({
    label: p.title || p.id, hint: '论文', kw: (p.title || '') + ' ' + (p.authors || ''),
    run: () => { switchPage('reader'); openPaper(p.id); },
  }));
}

function cmdAll() { return [...CMD_PAGES, ...CMD_ACTIONS, ...cmdPapers()]; }

/* 轻量模糊匹配：子序列（连续子串优先，再按 token 前缀） */
function cmdMatch(item, q) {
  if (!q) return 1;
  const label = (item.label || '').toLowerCase(), kw = (item.kw || '').toLowerCase();
  if (label.includes(q)) return 3;
  if (kw.includes(q)) return 2;
  // 子序列：q 的字符按序出现在 label 里
  let i = 0;
  for (const ch of label) { if (ch === q[i]) i++; if (i >= q.length) return 1; }
  return 0;
}

function openCmdPalette() {
  closeCmdPalette();
  const backdrop = Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
  const pop = Object.assign(document.createElement('div'), {className: 'ui-pop cmd-pop'});
  pop.innerHTML = `
    <input class="ui-pop-input cmd-input" placeholder="搜索功能 / 论文 / 设置…（↑↓ 选择 · Enter 执行 · Esc 关闭）">
    <div class="cmd-list" id="cmd-list"></div>`;
  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  const input = pop.querySelector('.cmd-input');
  const list = pop.querySelector('#cmd-list');
  let items = [], sel = 0;

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = cmdAll().map(it => ({ it, s: cmdMatch(it, q) }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map(x => x.it);
    items = all; sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((it, i) => `
      <div class="cmd-item ${i === sel ? 'on' : ''}" data-i="${i}">
        <span class="cmd-label">${esc(it.label.slice(0, 64))}</span>
        <span class="cmd-hint">${esc(it.hint)}</span>
      </div>`).join('') : '<p class="muted" style="padding:10px 14px">无匹配</p>';
    list.querySelectorAll('.cmd-item').forEach(el => {
      el.onclick = () => { exec(+el.dataset.i); };
      el.onmousemove = () => { if (sel !== +el.dataset.i) { sel = +el.dataset.i; paint(); } };
    });
  };
  const paint = () => list.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('on', i === sel));
  const exec = (i) => { const it = items[i]; if (!it) return; close(); it.run(); };
  const close = () => { pop.remove(); backdrop.remove(); document.removeEventListener('keydown', onKey, true); };

  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); scrollSel(); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); exec(sel); }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.onclick = e => { if (e.target === backdrop) close(); };
  input.oninput = () => { sel = 0; render(); };
  render();
  input.focus();
}
function closeCmdPalette() { document.querySelector('.cmd-pop')?.remove(); document.querySelector('.ui-backdrop .cmd-pop')?.closest('.ui-backdrop')?.remove(); }
window.openCmdPalette = openCmdPalette;

/* ---- 快捷键帮助层（?） ---- */
const SHORTCUTS = [
  ['Ctrl + K', '命令面板（功能/论文/设置一键搜索）'],
  ['?', '本帮助'],
  ['↑ / ↓', '文库列表切换选中论文（非输入状态生效）'],
  ['← / →', 'PDF 翻页'],
  ['+ / -', 'PDF 缩放'],
  ['Ctrl + /', '聚焦文库搜索框'],
  ['Ctrl + Q', '打开/关闭论文问答'],
  ['Ctrl + Enter', '问答输入框发送'],
  ['↑ / ↓（输入框内）', '翻提问历史'],
  ['/（问答输入框）', '选参与问答的论文'],
  ['Esc', '关闭弹窗/弹层/选文面板'],
];
function showShortcutHelp() {
  const backdrop = Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
  const pop = Object.assign(document.createElement('div'), {className: 'ui-pop'});
  pop.innerHTML = `
    <div class="ui-pop-title">键盘快捷键</div>
    <div class="cmd-help">${SHORTCUTS.map(([k, d]) =>
      `<div class="cmd-help-row"><code>${esc(k)}</code><span>${esc(d)}</span></div>`).join('')}
    </div>
    <div class="ui-pop-foot"><button class="btn small primary" data-ok>知道了</button></div>`;
  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  const close = () => { pop.remove(); backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape' || e.key === '?' || e.key === 'Enter') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  backdrop.onclick = e => { if (e.target === backdrop) close(); };
  pop.querySelector('[data-ok]').onclick = close;
}
window.showShortcutHelp = showShortcutHelp;

/* 调试入口：状态与导读渲染（供真机探针/排障调用；只读不改业务逻辑） */
window.__state = state;
window.renderSumBubble = renderSumBubble;
window.drawSummary = drawSummary;
window.openPaper = openPaper;

/* ---- 全局快捷键监听 ---- */
document.addEventListener('keydown', e => {
  // 输入类控件内不抢键（除 Ctrl 组合与 Esc——Esc 各弹层自管）
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault(); openCmdPalette(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === '?')) {
    e.preventDefault();
    const inp = $('#lib-search');
    inp?.focus(); inp?.select?.();   // 全选已有搜索词，输入直接覆盖
    return;
  }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); showShortcutHelp(); return; }
  // 文库列表 ↑↓+Enter 导航（列表聚焦/非输入态）
  if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) && !$('.ui-pop')) {
    const items = $$('#paper-list .paper-item[data-id]');
    if (!items.length) return;
    const cur = items.findIndex(x => x.classList.contains('sel'));
    if (e.key === 'ArrowDown') { e.preventDefault(); const n = items[Math.min(cur + 1, items.length - 1)]; n?.scrollIntoView({block: 'nearest'}); openPaper(n.dataset.id); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const n = items[Math.max(cur - 1, 0)]; n?.scrollIntoView({block: 'nearest'}); openPaper(n.dataset.id); }
    else if (e.key === 'Enter' && cur < 0) { e.preventDefault(); openPaper(items[0].dataset.id); }
  }
});

/* ---- 首次登录引导卡（可关；localStorage 记住） ---- */
function showOnboardingOnce() {
  if (localStorage.getItem('ps-onboarded') === '1' || !state.me) return;
  localStorage.setItem('ps-onboarded', '1');   // 先置位：只弹一次，关掉刷新不再来
  const backdrop = Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
  const pop = Object.assign(document.createElement('div'), {className: 'ui-pop onboard-pop'});
  pop.innerHTML = `
    <div class="ui-pop-title">欢迎使用 paper-system</div>
    <div class="onboard-steps">
      <div class="onboard-step"><b>① 上传文献</b><span>拖 PDF 到左侧论文列表，或点「上传」弹层选文件 / 粘贴 DOI、arXiv、BibTeX / 目录导入</span></div>
      <div class="onboard-step"><b>② 等待解析</b><span>GPU 提取全文（列表显示进度），完成后可阅读/翻译/图表</span></div>
      <div class="onboard-step"><b>③ 提问与导读</b><span>右栏「✍️ 提问」对着论文问答（引用可点回原文）；问答右栏「生成导读」产出 9 字段导读；「文献信息」页的「AI 补全」补元数据</span></div>
      <div class="onboard-step"><b>④ 批量与综述</b><span>「文库管理」勾选论文 → 批量条翻译 / 生成综述报告；工具条「采集文献」检索中文文献或建专题跟踪</span></div>
      <div class="onboard-step"><b>找不到入口？</b><span>随时 <code>Ctrl + K</code> 命令面板搜索一切；<code>?</code> 看快捷键</span></div>
    </div>
    <div class="ui-pop-foot"><span class="muted" style="font-size: var(--fs-xs);flex:1">问答/翻译需要 LLM key（「设置」页配置）；管理员开启公共额度池时可直接使用</span>
      <button class="btn small" data-settings>去设置</button>
      <button class="btn small primary" data-ok>开始使用</button></div>`;
  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  const close = () => { pop.remove(); backdrop.remove(); };
  backdrop.onclick = e => { if (e.target === backdrop) close(); };
  pop.querySelector('[data-ok]').onclick = close;
  pop.querySelector('[data-settings]').onclick = () => { close(); switchPage('settings'); };
}
window.showOnboardingOnce = showOnboardingOnce;
