/* paper-system 前端逻辑（原生 JS，无框架） */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  me: null, papers: [], q: '',
  filter: localStorage.getItem('ps-filter') || '',   // ''|parsed|parsing|failed|private
  sortBy: localStorage.getItem('ps-sort') || 'recent', // recent|title|pages|size
  current: null,          // 当前论文 dict
  pdfDoc: null, pageNum: 1, scale: 1.0,
  view: 'orig', blocks: [], pairs: [], versions: [],
  selected: new Set(),    // 多选 paper_ids
  qaPapers: new Set(),    // 问答 scope
  qaSession: '', health: {},
  uploads: new Map(),     // 上传中占位：name → {pct, phase: uploading|saving|error, msg, file, cid}
  parseProg: {},          // 解析实时进度：paper_id → {done, total}（SSE 推送 + statuses 水合）
};

/* ---------------- 基础 ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: {'Content-Type': 'application/json', ...(opts.headers || {})},
    ...opts,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  if (!r.ok) {
    let d = {}; try { d = await r.json(); } catch {}
    throw new Error(d.detail || `HTTP ${r.status}`);
  }
  return r.json();
}
let _toastTimer = 0;
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastTimer);   // 连续触发时旧 timer 会让后一条提前消失
  _toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---- 统一弹窗（替代原生 confirm/prompt；MinerU 式轻量浮层） ----
   uiConfirm(msg, {title, okText, cancelText, danger, anchor}) → Promise<bool>
   uiPrompt(title, {value, placeholder, okText, anchor})       → Promise<string|null>
   uiPassword(title, password)                                  → Promise<void>（展示+复制）
   anchor 给定时锚定弹出（无遮罩，点外/Esc 取消）；否则居中浮卡 + 半透明遮罩。 */
function _uiDialog({title, message = '', input = false, value = '', placeholder = '',
                    okText = '确定', cancelText = '取消', danger = false, anchor = null,
                    copyText = '', hideCancel = false, multiline = false}) {
  return new Promise(resolve => {
    const backdrop = anchor ? null : Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
    const pop = Object.assign(document.createElement('div'), {className: 'ui-pop' + (danger ? ' danger' : '')});
    const inputHtml = !input ? '' : multiline
      ? `<textarea class="ui-pop-input" rows="9" placeholder="${esc(placeholder || '')}">${esc(value)}</textarea>`
      : `<input class="ui-pop-input" value="${esc(value)}" placeholder="${esc(placeholder || '')}">`;
    pop.innerHTML = `
      <div class="ui-pop-title">${esc(title)}${copyText ? `<button class="btn small" data-copy>${icon('copy')} 复制</button>` : ''}</div>
      ${message ? `<div class="ui-pop-msg">${esc(message)}</div>` : ''}
      ${inputHtml}
      <div class="ui-pop-foot">${hideCancel ? '' : `<button class="btn small" data-cancel>${esc(cancelText)}</button>`}
        <button class="btn small ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button></div>`;
    const inputVal = () => (pop.querySelector('.ui-pop-input') || {}).value ?? null;
    const done = val => {
      pop.remove(); backdrop?.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); }
      else if (e.key === 'Enter' && !e.isComposing && (!multiline || e.ctrlKey)) {
        e.preventDefault(); done(input ? inputVal() : true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    pop.querySelector('[data-ok]').onclick = () => done(input ? inputVal() : true);
    const cancelBtn = pop.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.onclick = () => done(input ? null : false);
    if (copyText) pop.querySelector('[data-copy]').onclick = () => { navigator.clipboard?.writeText(copyText); toast('已复制'); };
    if (backdrop) {
      backdrop.onclick = () => done(input ? null : false);
      document.body.appendChild(backdrop);
    } else {
      document.addEventListener('click', function onOut(e) {
        if (!pop.contains(e.target) && e.target !== anchor && !anchor?.contains?.(e.target)) {
          document.removeEventListener('click', onOut, true);
          done(input ? null : false);
        }
      }, true);
    }
    document.body.appendChild(pop);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      pop.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let x = Math.min(r.left, innerWidth - pw - 8);
        let y = r.bottom + 6;
        if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
        pop.style.left = Math.max(8, x) + 'px';
        pop.style.top = y + 'px';
        pop.style.visibility = '';
      });
    } else {
      requestAnimationFrame(() => {   // 居中
        pop.style.left = Math.max(8, (innerWidth - pop.offsetWidth) / 2) + 'px';
        pop.style.top = Math.max(8, (innerHeight - pop.offsetHeight) / 2.4) + 'px';
      });
    }
    const inp = pop.querySelector('.ui-pop-input');
    if (inp) { inp.focus(); inp.select(); }
    else pop.querySelector('[data-ok]').focus();
  });
}
window.uiConfirm = (message, opts = {}) => _uiDialog({message, danger: true, ...opts});
window.uiPrompt = (title, opts = {}) => _uiDialog({title, input: true, ...opts});
window.uiPassword = (title, password) => _uiDialog({title, message: password, copyText: password, okText: '关闭', hideCancel: true, danger: false});
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* ---- SVG 图标库（v1.2 起 UI 图标全 SVG 化；toast 消息文本中的 emoji 保留）----
   线条风格：16 viewBox / stroke 1.5 / 圆角端点 / currentColor 跟随文字色。 */
const ICONS = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  chevD: '<path d="M4 6l4 4 4-4"/>',
  chevU: '<path d="M4 10l4-4 4 4"/>',
  chevL: '<path d="M10 3L5 8l5 5"/>',
  chevR: '<path d="M6 3l5 5-5 5"/>',
  dblL: '<path d="M7.5 4L3.5 8l4 4M11.5 4l-4 4 4 4"/>',
  dblR: '<path d="M8.5 4l4 4-4 4M4.5 4l4 4-4 4"/>',
  arrowL: '<path d="M13 8H3M7 4L3 8l4 4"/>',
  arrowR: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  download: '<path d="M8 2v8M5 7l3 3 3-3M3 13.5h10"/>',
  upload: '<path d="M8 10V2.5M5 5l3-3 3 3M3 13.5h10"/>',
  save: '<path d="M3.5 3.5h8l2 2v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-9a1 1 0 011-1z"/><path d="M5.5 3.5v3h5v-3M5.5 13V9.5h5V13"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9.5h5.8l.6-9.5"/>',
  edit: '<path d="M11.2 2.8l2 2L6.5 11.5l-2.8.8.8-2.8 6.7-6.7z"/>',
  retry: '<path d="M13 8A5 5 0 1111.6 4.4M13 2.5V5h-2.5"/>',
  check: '<path d="M3 8.5l3.2 3.2L13 4.5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2.3 2.8 2.3 8.2 0 11-2.3-2.8-2.3-8.2 0-11z"/>',
  play: '<path d="M5.5 3.5v9l7-4.5z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  menu: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5h-7v7"/>',
  doc: '<path d="M4 2.5h5.5L12.5 5.5V13.5h-8.5z"/><path d="M9.5 2.5v3h3"/>',
  folder: '<path d="M2.5 5a1 1 0 011-1h3.2l1.5 1.8h5.3a1 1 0 011 1v6.2a1 1 0 01-1 1h-10a1 1 0 01-1-1V5z"/>',
  library: '<path d="M3 13.5V3.5M6.3 13.5V3.5M9.6 13.5V3.5M2 13.5h12"/>',
  chat: '<path d="M2.5 5A1.5 1.5 0 014 3.5h8A1.5 1.5 0 0113.5 5v4A1.5 1.5 0 0112 10.5H7.5L4.5 13v-2.5H4A1.5 1.5 0 012.5 9V5z"/>',
  sliders: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.8"/><circle cx="10" cy="11" r="1.8"/>',
  star: '<path d="M8 2.5l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.7l-3.6 1.9.7-4L2.2 6.8l4-.6L8 2.5z"/>',
  lock: '<rect x="4" y="7" width="8" height="6.5" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 015 0V7"/>',
  unlock: '<rect x="4" y="7" width="8" height="6.5" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 014.9-.8"/>',
  layout: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/>',
  panelL: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/>',
  panelR: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M10 3v10"/>',
  zoomIn: '<circle cx="7" cy="7" r="4"/><path d="M10.5 10.5L13.5 13.5M7 5.5v3M5.5 7h3"/>',
  zoomOut: '<circle cx="7" cy="7" r="4"/><path d="M10.5 10.5L13.5 13.5M5.5 7h3"/>',
  bulb: '<path d="M6 13.5h4M6.3 11.2c0-2.2-1.8-2.7-1.8-4.7a3.5 3.5 0 017 0c0 2-1.8 2.5-1.8 4.7h-3.4z"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-3 2.6-4.2 5-4.2s4.4 1.2 5 4.2"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.5 8.5L13 3M11 3h2v2"/>',
  bolt: '<path d="M8.5 2L4 9h3l-.5 5L12 7H9l-.5-5z"/>',
  crown: '<path d="M3 11.5L2.5 5l3.5 2L8 3.5 10 7l3.5-2L13 11.5H3z"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3.5 11.5l3-3 2.5 2.5 1.5-1.5 2.5 2.5"/>',
  chart: '<path d="M3 13.5V3M3 13.5h10M6.5 13.5V8M10 13.5V5.5"/>',
  note: '<path d="M3.5 3h9v7l-3 3h-6z"/><path d="M9.5 13v-3h3"/>',
  pin: '<path d="M8 13.5V9M8 9C6 9 4.5 7.8 4.5 5.8V3.5h7v2.3C11.5 7.8 10 9 8 9z"/>',
  tag: '<path d="M2.5 8.3V3.5h4.8l6 6-4.8 4.8-6-6z"/><circle cx="5.2" cy="5.2" r=".9"/>',
  funnel: '<path d="M1.8 2.6h12.4a.5.5 0 01.39.81L9.9 9.4v4.1a.6.6 0 01-.87.54l-2.4-1.2a.6.6 0 01-.33-.54V9.4L1.41 3.41A.5.5 0 011.8 2.6z"/>',
  checklist: '<path d="M2.2 4.3l1.5 1.5 2.7-3M2.2 11.3l1.5 1.5 2.7-3M9.2 4.4h4.6M9.2 11.6h4.6"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10.5 10.5L13.5 13.5"/>',
  book: '<path d="M8 4.2C6.6 3 4.2 2.8 2.6 3.6v9c1.6-.8 4-.6 5.4.6 1.4-1.2 3.8-1.4 5.4-.6v-9C11.8 2.8 9.4 3 8 4.2z"/><path d="M8 4.2v9"/>',
  moon: '<path d="M13.2 9.7A5.7 5.7 0 016.3 2.8a5.7 5.7 0 106.9 6.9z"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/>',
  logout: '<path d="M6 13.5H3.5a1 1 0 01-1-1v-9a1 1 0 011-1H6M9.5 11L13.5 8l-4-3M13.5 8H6"/>',
  warn: '<path d="M8 2.2L14 12.5H2L8 2.2z"/><path d="M8 6.4v3.1M8 11.7v.1"/>',
  quote: '<path d="M2.8 12.4c0-3.3 1.4-5.9 4-6.9l.7 1.5C6 7.8 5.2 9.2 5 10.6h2.4v3.6H2.8v-1.8zM8.8 12.4c0-3.3 1.4-5.9 4-6.9l.7 1.5c-1.5.8-2.3 2.2-2.5 3.6h2.4v3.6H8.8v-1.8z"/>',
};
window.icon = (name, size = 14) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ---------------- 健康自检 ---------------- */
async function pollHealth() {
  try {
    state.health = await api('/api/health');
    // 注意键名：/api/health 返回 db/mineru/ai（xinference 替换 ollama 后 ai 为检索服务总开关）
    const ok = state.health.db && state.health.mineru && state.health.ai;
    $('#health-dot').className = 'health-dot ' + (ok ? 'ok' : 'bad');
    $('#health-dot').title = ok ? '服务正常（点击查看详情）' : '部分服务异常（点击查看详情）';
  } catch { $('#health-dot').className = 'health-dot bad'; }
  renderHealthPop();
}
function renderHealthPop() {
  const pop = $('#health-pop');
  if (!pop || pop.hidden) return;
  const h = state.health || {};
  const row = (name, okv, extra = '') =>
    `<div class="hp-row"><span class="hp-dot ${okv ? 'ok' : 'bad'}"></span>${name}` +
    (extra ? ` <span class="muted" style="font-size:11px">${esc(extra)}</span>` : '') + `</div>`;
  pop.innerHTML =
    `<div class="hp-head">服务状态 <button class="btn small" id="hp-recheck">${icon('retry')} 重新检测</button></div>` +
    row('数据库', h.db) +
    row('解析服务（MinerU GPU）', h.mineru) +
    row('语义检索（embedding/rerank）', h.ai, (h.models || []).join(' / ')) +
    `<div class="muted" style="font-size:11px;margin-top:6px">检测于 ${new Date().toLocaleTimeString()}</div>`;
  $('#hp-recheck').onclick = e => { e.stopPropagation(); pop.hidden = true; pollHealth(); };
}
$('#health-dot').onclick = e => {
  e.stopPropagation();
  const pop = $('#health-pop');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  renderHealthPop();
};
document.addEventListener('click', e => {
  const pop = $('#health-pop');
  if (pop && !pop.hidden && !pop.contains(e.target) && e.target.id !== 'health-dot') pop.hidden = true;
});
setInterval(pollHealth, 20000);

/* ---------------- 文献库 ---------------- */
state.collections = [];
state.currentCollection = '';

async function loadCollections(preset = null) {
  const d = preset || await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  renderCollections();
}
function colDescendants(cid) {
  const out = [];
  const walk = id => {
    state.collections.filter(c => c.parent_id === id).forEach(c => { out.push(c.id); walk(c.id); });
  };
  walk(cid);
  return out;
}
function renderCollections() {
  const el = $('#collections');
  if (!el) return;
  const colState = JSON.parse(localStorage.getItem('ps-col-open') || '{}');
  const nodes = state.collections;
  const children = {};
  nodes.forEach(c => (children[c.parent_id || 'root'] ||= []).push(c));
  const row = (c, depth) => {
    const kids = children[c.id] || [];
    // 库树默认收起（有子库的才可展开）；用户手动展开过则记忆
    const open = colState[c.id] === true;
    const selected = state.currentCollection === c.id;
    const desc = colDescendants(c.id);
    const active = selected || desc.includes(state.currentCollection);
    return `<div class="col-item ${active ? 'on' : ''}" data-id="${c.id}" style="padding-left:${8 + depth * 14}px">
      ${kids.length ? `<span class="col-arrow ${open ? '' : 'closed'}" data-toggle="${c.id}">${open ? icon('chevD') : icon('chevR')}</span>` : '<span class="col-arrow-none"></span>'}
      <span class="col-name">${icon('folder')} ${esc(c.name)}</span>
      <span class="col-count">${c.papers_total ?? c.papers ?? 0}</span>
      <button class="col-del" title="删除文献库">${icon('close')}</button>
    </div>` + (kids.length && open ? kids.map(k => row(k, depth + 1)).join('') : '');
  };
  const roots = children['root'] || [];
  const allOpen = roots.some(r => colState[r.id] === true);
  el.innerHTML =
    `<div class="col-item ${state.currentCollection === '' ? 'on' : ''}" data-id="">
      <span class="col-arrow-none"></span><span class="col-name">${icon('library')} 全部文献</span>
      <span class="col-count">${state.totalPapers ?? 0}</span>
    </div>` +
    roots.map(r => row(r, 0)).join('') +
    `<button class="col-new" id="col-new">${icon('plus')} 新建文献库</button>
     <div class="col-new-form" id="col-new-form" hidden>
       <input id="col-new-name" placeholder="文献库名称，回车创建" maxlength="50">
       <div><button class="btn small primary" id="col-new-ok">创建</button>
       <button class="btn small" id="col-new-cancel">取消</button></div>
     </div>`;
  $$('.col-item', el).forEach(item => item.onclick = e => {
    if (e.target.closest?.('.col-del') || e.target.dataset.toggle) return;
    const id = item.dataset.id;
    state.currentCollection = id;
    updateUploadTarget();
    renderCollections(); loadPapers();
  });
  $$('.col-arrow', el).forEach(a => a.onclick = e => {
    e.stopPropagation();
    colState[a.dataset.toggle] = colState[a.dataset.toggle] === false ? true : false;
    localStorage.setItem('ps-col-open', JSON.stringify(colState));
    renderCollections();
  });
  $$('.col-del', el).forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const cid = e.target.closest('.col-item').dataset.id;
    const name = state.collections.find(c => c.id === cid)?.name || '';
    if (!(await uiConfirm(`删除文献库「${name}」？其子库与库内论文将一并移入回收站（30 天内可恢复）`,
                           {title: '删除文献库', anchor: e.currentTarget}))) return;
    await api('/api/collections/' + cid, {method: 'DELETE'});
    if (state.currentCollection === cid) state.currentCollection = '';
    await refreshLib();
  });
  $('#col-new').onclick = () => {
    const form = $('#col-new-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#col-new-name').focus();
  };
  const createCol = async () => {
    const name = $('#col-new-name').value.trim();
    if (!name) { toast('请输入名称'); return; }
    try {
      const d = await api('/api/collections', {method: 'POST', body: JSON.stringify({name})});
      $('#col-new-name').value = '';
      $('#col-new-form').hidden = true;
      state.currentCollection = d.id;
      updateUploadTarget();
      await refreshLib();
    } catch (e) { toast('创建失败: ' + e.message); }
  };
  $('#col-new-ok').onclick = createCol;
  $('#col-new-name').onkeydown = e => { if (e.key === 'Enter') createCol(); if (e.key === 'Escape') $('#col-new-form').hidden = true; };
  $('#col-new-cancel').onclick = () => { $('#col-new-form').hidden = true; };
  // 批量移动下拉（树形缩进标签）
  $('#batch-move').innerHTML = '<option value="">移入…</option>' +
    nodes.map(c => `<option value="${c.id}">${'　'.repeat(treeDepth(c.id))}${esc(c.name)}</option>`).join('') +
    '<option value="__none__">未分库</option>';
}
function treeDepth(cid) {
  let d = 0, cur = state.collections.find(c => c.id === cid);
  while (cur && cur.parent_id) { cur = state.collections.find(c => c.id === cur.parent_id); d++; }
  return d;
}

/* 库状态变更后的统一刷新入口。
   问题：改库的操作分散在多个页面，各刷各的 → 右侧「文库管理」更新了、
   左侧文库树/论文列表还是旧的（要手动点一下才对）。
   规则：凡是会改变"论文属于哪个库 / 库里有几篇 / 论文增删"的操作，
   结束时一律走 refreshLib()，三处视图同时刷新。
   collections 只拉一次，三处共用（refreshLib 传 preset 给 renderCollectionsPage）。 */
async function refreshLib() {
  const d = await api('/api/collections');
  loadCollections(d);                       // 侧栏文库树（含各库计数）
  await loadPapers();                      // 侧栏论文列表
  const pg = $('#page-collections');
  if (pg && pg.style.display !== 'none') await renderCollectionsPage(d);   // 文库管理页
  // 解析进度水合（SSE 只覆盖在线期间的变更，刷新后从 statuses 补齐“提取中 x/y”）
  api('/api/statuses').then(s => {
    const map = {};
    for (const [pid, st] of Object.entries(s.statuses || {})) {
      const pj = st.parse_job;
      if (pj && pj.status === 'running') map[pid] = {done: pj.done || 0, total: pj.total || 0};
    }
    state.parseProg = map;
    renderPapers();
  }).catch(() => {});
}

/* ---------------- 文库 ---------------- */
async function renderContentSearch() {
  const el = $('#paper-list');
  el.innerHTML = '<p class="muted" style="padding:14px">全文检索中…</p>';
  try {
    const d = await api('/api/search', {method: 'POST', body: JSON.stringify({query: state.q.trim(), top_k: 20})});
    if (!d.hits.length) { el.innerHTML = '<p class="muted" style="padding:14px">标题与全文均无匹配</p>'; return; }
    el.innerHTML = `<div style="padding:8px 14px" class="muted">${icon('search')} 全文命中 ${d.hits.length} 处（点击跳转）</div>` +
      d.hits.map(h => {
        const p = state.qaAllPapers?.find(x => x.id === h.paper_id) || state.papers.find(x => x.id === h.paper_id) || {};
        return `<div class="paper-item" data-id="${h.paper_id}" data-page="${h.page_index}">
          <div class="info"><div class="name">${esc(p.title || h.paper_id)}</div>
          <div class="meta">${icon('doc')} 第${h.page_index + 1}页</div>
          <div class="muted" style="font-size:11px;padding:2px 0">${esc(h.text.slice(0, 90))}</div></div></div>`;
      }).join('');
    $$('.paper-item', el).forEach(item => item.onclick = async () => {
      await openPaper(item.dataset.id);
      jumpEvidence(+item.dataset.page);
    });
  } catch (e) { el.innerHTML = `<p class="muted" style="padding:14px">检索失败: ${esc(e.message)}</p>`; }
}
async function loadPapers(append = false) {
  const scope = state.currentCollection
    ? [state.currentCollection, ...colDescendants(state.currentCollection)].join(',') : '';
  const page = append ? (state.papersPage || 1) + 1 : 1;
  const params = new URLSearchParams({q: state.q.trim(), collection_id: scope,
    status: state.filter === 'private' ? '' : state.filter, page, page_size: 200});
  const d = await api('/api/papers?' + params);
  let papers = state.filter === 'private' ? d.papers.filter(p => p.visibility === 'private') : d.papers;
  // 快捷范围（服务端筛不了的在前端过滤）
  if (state.scope === 'untranslated') {
    const st = state._statuses || {};
    papers = papers.filter(p => st[p.id]?.translate_job?.status !== 'done');
  } else if (state.scope === 'parsing') {
    papers = papers.filter(p => ['parsing', 'pending'].includes(p.parse_status));
  } else if (state.scope === 'private') {
    papers = papers.filter(p => p.visibility === 'private');
  }
  state.papers = append ? [...state.papers, ...papers] : papers;
  state.papersPage = page;
  state.papersHasMore = !!d.has_more;
  renderPapers();
}
function statusBadge(p) {  if (p.deleted_at) return '<span class="badge err">回收站</span>';
  if (p.parse_status === 'pending') return '<span class="badge run">排队中</span>';
  if (p.parse_status === 'parsing') {
    const pr = (state.parseProg || {})[p.id];
    return `<span class="badge run">${pr && pr.total ? `提取中 ${pr.done}/${pr.total}` : '解析中'}</span>`;
  }
  const m = {parsed: '<span class="badge ok">已解析</span>',
             failed: '<span class="badge err">失败</span>'};
  return m[p.parse_status] || '';
}
function renderPapers() {
  const el = $('#paper-list');
  if (state.q && state.q.trim().length >= 2) { renderContentSearch(); return; }
  // 上传占位行（MinerU 式：上传中/失败可见，带真实百分比与重试）
  const ups = [...state.uploads.entries()].map(([name, u], idx) => u.phase === 'error' ? `
    <div class="paper-item uploading err">
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span class="badge err">失败</span>
          <span class="muted up-msg" title="${esc(u.msg || '')}">${esc((u.msg || '').slice(0, 36))}</span>
          <button class="up-act" data-idx="${idx}" data-act="retry">重试</button>
          <button class="up-act" data-idx="${idx}" data-act="drop">移除</button></div>
      </div>
    </div>` : `
    <div class="paper-item uploading">
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span class="up-pct">${u.phase === 'saving' ? '保存中…' : '上传中 ' + (u.pct || 0) + '%'}</span>
          <div class="up-bar"><i style="width:${u.pct || 0}%"></i></div></div>
      </div>
    </div>`).join('');
  if (!state.papers.length && !ups) { el.innerHTML = '<p class="muted" style="padding:20px">暂无论文，上传 PDF 开始</p>'; return; }
  const listHtml = sortPapers(state.papers).map(p => {
    const pr = (state.parseProg || {})[p.id];
    const bar = p.parse_status === 'parsing' && pr?.total
      ? `<div class="up-bar parse"><i style="width:${Math.min(100, Math.round(100 * pr.done / pr.total))}%"></i></div>` : '';
    return `
    <div class="paper-item ${state.current?.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      ${state.selectMode ? `<input type="checkbox" ${state.selected.has(p.id) ? 'checked' : ''}>` : ''}
      <div class="info">
        <div class="name">${esc(p.title || p.id)}</div>
        <div class="meta">${statusBadge(p)}
          ${p.visibility === 'private' ? '<span class="badge priv">私人</span>' : ''}
          <span>${(p.page_count || '?')}页</span><span>${p.file_size ? (p.file_size/1048576).toFixed(1) + 'M' : ''}</span>
        </div>${bar}
      </div>
      <button class="pi-del" title="移入回收站">${icon('trash')}</button>
    </div>`;}).join('');
  el.innerHTML = ups + listHtml + (state.papersHasMore
    ? '<button class="qa-load-more" id="load-more">加载更多…</button>' : '');
  const lm = $('#load-more');
  if (lm) lm.onclick = () => loadPapers(true);
  $$('.paper-item', el).forEach(item => {
    const id = item.dataset.id;
    if (!id) return;   // 上传占位行无 paper id（由下方 up-act 接管）
    item.onclick = e => {
      if (e.target.type === 'checkbox') { toggleSelect(id, e.target.checked); return; }
      if (e.target.closest?.('.pi-del')) { quickDelete(id, e.target.closest('.pi-del')); return; }   // closest：按钮内嵌 SVG 图标，e.target 常是 svg/path
      if (state.selectMode) { toggleSelect(id, !state.selected.has(id)); return; }
      openPaper(id);   // 普通模式：单击任意位置直接打开
    };
  });
  // 上传占位行：重试 / 移除
  $$('.up-act', el).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const entry = [...state.uploads.entries()][+b.dataset.idx];
    if (!entry) return;
    const [name, u] = entry;
    if (b.dataset.act === 'drop') { state.uploads.delete(name); renderPapers(); return; }
    state.uploads.delete(name);
    uploadFiles([u.file], u.cid);   // 重试保留原目标库
  });
}
function toggleSelect(id, on) {
  on ? state.selected.add(id) : state.selected.delete(id);
  $('#batch-bar').classList.toggle('show', state.selectMode && state.selected.size > 0);
}

/* 上传：入口是工具条图标 + 直接把文件拖到论文列表区（不再有独立大拖放框） */
state.uploadPrivate = localStorage.getItem('ps-upload-private') === '1';
function updateUploadTarget() {
  const el = $('#upload-target');
  if (el) el.textContent = '上传到：' +
    (state.currentCollection ? (state.collections.find(c => c.id === state.currentCollection)?.name || '默认文献库') : '全部文献');
}
function updateVisToggle() {
  const cb = $('#upload-private');
  if (cb) cb.checked = state.uploadPrivate;
}
$('#upload-private')?.addEventListener('change', e => {
  state.uploadPrivate = e.target.checked;
  localStorage.setItem('ps-upload-private', state.uploadPrivate ? '1' : '0');
  toast(state.uploadPrivate ? '新上传的文献将仅自己可见' : '新上传的文献将对所有人可见');
});
const upPop = $('#upload-pop');
$('#upload-arrow')?.addEventListener('click', e => {
  e.stopPropagation();
  upPop.hidden = !upPop.hidden;
  upPop.style.bottom = '52px'; upPop.style.top = 'auto';
  upPop.style.right = '12px'; upPop.style.left = 'auto';
  updateUploadTarget(); updateVisToggle();
});
$('#upload-file-btn').onclick = () => { upPop.hidden = true; $('#file-input').click(); };
document.addEventListener('click', e => {
  if (!upPop.hidden && !e.target.closest('#upload-pop') && !e.target.closest('#upload-arrow')) upPop.hidden = true;
});
$('#file-input').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
$('#url-import-btn').onclick = async () => {
  const url = $('#url-import-input').value.trim();
  if (!url) { toast('请输入 URL'); return; }
  try {
    const r = await api('/api/papers/import-url', {method: 'POST', body: JSON.stringify({
      url, collection_id: state.currentCollection || undefined})});
    toast(r.status === 'duplicate' ? '该 URL 已在库中' : '已加入解析队列');
    $('#url-import-input').value = '';
    upPop.hidden = true;
    await refreshLib();
  } catch (e) { toast('导入失败: ' + e.message); }
};
$('#url-import-input').onkeydown = e => { if (e.key === 'Enter') $('#url-import-btn').click(); };
// 论文列表区 = 拖放上传目标
const plist = $('#paper-list');
['dragover', 'dragenter'].forEach(ev => plist.addEventListener(ev, e => {
  e.preventDefault(); plist.classList.add('drop-hint');
}));
['dragleave', 'drop'].forEach(ev => plist.addEventListener(ev, e => {
  e.preventDefault(); plist.classList.remove('drop-hint');
}));
plist.addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
async function uploadFiles(files, targetCid) {
  const okFile = f => /\.(pdf|png|jpe?g|docx?|pptx?|xlsx?)$/i.test(f.name);
  const pdfs = [...files].filter(okFile);
  if (!pdfs.length) { toast('支持 PDF / 图片 / Office 文档'); return; }
  const vis = state.uploadPrivate ? 'private' : 'shared';
  const col = (targetCid || state.currentCollection) ? `&collection_id=${targetCid || state.currentCollection}` : '';
  const cid = targetCid || state.currentCollection || '';
  // MinerU 式体验：逐文件上传，上传即在列表顶部显示占位行（真实百分比），
  // 服务端入库后被真实条目替换（状态随之变为 排队中 → 提取中 x/y）
  let okN = 0, dupN = 0, rejN = 0;
  for (const f of pdfs) {
    const up = {pct: 0, phase: 'uploading', msg: '', file: f, cid};
    state.uploads.set(f.name, up);
    renderPapers();
    try {
      const d = await new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('files', f);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/papers/upload?visibility=${vis}${col}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) { up.pct = Math.round(e.loaded / e.total * 100); renderPapers(); }
        };
        xhr.upload.onload = () => { up.phase = 'saving'; up.pct = 100; renderPapers(); };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.onload = () => {
          const body = xhr.response || {};
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.detail || `HTTP ${xhr.status}`));
        };
        xhr.send(fd);
      });
      const res = (d.results || [])[0] || {};
      if (res.status === 'rejected') { up.phase = 'error'; up.msg = res.reason || '被拒收'; rejN++; }
      else if (res.status === 'duplicate') { state.uploads.delete(f.name); dupN++; }
      else { state.uploads.delete(f.name); okN++; }
      await refreshLib();
      if (up.phase === 'error') renderPapers();
    } catch (e) {
      up.phase = 'error'; up.msg = e.message; rejN++; renderPapers();
    }
  }
  if (!rejN && !dupN) toast(`已排队 ${okN} 篇`);
  else {
    const bits = [];
    if (okN) bits.push(`已排队 ${okN} 篇`);
    if (dupN) bits.push(`去重跳过 ${dupN} 篇`);
    if (rejN) bits.push(`${rejN} 篇失败（列表中可重试）`);
    toast(bits.join('，'));
  }
}

/* 多选模式与批量操作 */
state.selectMode = false;
/* ---- 筛选与排序菜单（▾）---- */
const FILTERS = [['', '全部'], ['parsed', '已解析'], ['parsing', '解析中'], ['failed', '失败'], ['private', '仅私人']];
const SORTS = [['recent', '最近更新'], ['title', '标题'], ['pages', '页数'], ['size', '文件大小']];
function sortPapers(list) {
  const arr = [...list];
  const by = state.sortBy;
  if (by === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
  else if (by === 'pages') arr.sort((a, b) => (b.page_count || 0) - (a.page_count || 0));
  else if (by === 'size') arr.sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
  else arr.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return arr;
}
function markFilterMenu() {
  const pop = $('#filter-pop');
  if (pop) {
    $$('.tp-item', pop).forEach(it => {
      const on = it.dataset.f !== undefined ? it.dataset.f === state.filter : it.dataset.s === state.sortBy;
      it.classList.toggle('on', on);
    });
  }
  const arrow = $('#filter-arrow');
  if (!arrow) return;
  const fn = FILTERS.find(f => f[0] === state.filter)?.[1] || '全部';
  const sn = SORTS.find(s => s[0] === state.sortBy)?.[1] || '最近更新';
  arrow.classList.toggle('has-val', !!state.filter || state.sortBy !== 'recent');
  arrow.title = `筛选：${fn} · 排序：${sn}`;
}
$('#filter-arrow').onclick = e => {
  e.stopPropagation();
  const pop = $('#filter-pop');
  pop.hidden = !pop.hidden;
  markFilterMenu();
};
$('#filter-pop').onclick = e => {
  const item = e.target.closest('.tp-item');
  if (!item) return;
  if (item.dataset.f !== undefined) {
    state.filter = item.dataset.f;
    localStorage.setItem('ps-filter', state.filter);
  } else if (item.dataset.s) {
    state.sortBy = item.dataset.s;
    localStorage.setItem('ps-sort', state.sortBy);
  }
  $('#filter-pop').hidden = true;
  markFilterMenu();
  loadPapers();
};
document.addEventListener('click', e => {
  const pop = $('#filter-pop');
  if (pop && !pop.hidden && !e.target.closest('#filter-pop') && !e.target.closest('#filter-arrow')) pop.hidden = true;
});
markFilterMenu();

/* ---- 侧栏折叠 / 展开（MinerU 风格浮动箭头）---- */
state.sidebarCollapsed = localStorage.getItem('ps-sidebar-collapsed') === '1';
window.applySidebarCollapse = () => {
  const sb = $('.sidebar');
  sb.classList.toggle('collapsed', state.sidebarCollapsed);
  $('#side-rail').hidden = !state.sidebarCollapsed;
};
$('#side-collapse').onclick = () => {
  state.sidebarCollapsed = true;
  localStorage.setItem('ps-sidebar-collapsed', '1');
  applySidebarCollapse();
};
$('#side-expand').onclick = () => {
  state.sidebarCollapsed = false;
  localStorage.setItem('ps-sidebar-collapsed', '0');
  applySidebarCollapse();
};
applySidebarCollapse();

const _toggleSelectMode = () => {
  state.selectMode = !state.selectMode;
  ['#sel-toggle', '#sel-toggle2'].forEach(sel => {
    const b = $(sel); if (!b) return;
    b.classList.toggle('has-val', state.selectMode);
    b.classList.toggle('primary', state.selectMode);
    b.title = state.selectMode ? '退出批量选择' : '批量选择';
  });
  if (!state.selectMode) { state.selected.clear(); $('#batch-bar').classList.remove('show'); }
  renderPapers();
};
$('#sel-toggle')?.addEventListener('click', _toggleSelectMode);
$('#sel-toggle2')?.addEventListener('click', _toggleSelectMode);
$('#batch-cancel').onclick = () => {
  state.selected.clear(); $('#batch-bar').classList.remove('show');
  state.selectMode = false; const sb = $('#sel-toggle'); sb.classList.remove('has-val'); sb.title = '批量选择';
  renderPapers();
};
$('#batch-translate').onclick = async () => {
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [...state.selected]})});
  toast(`已加入翻译队列（${state.selected.size} 篇）`); $('#batch-cancel').click();
};
$('#batch-delete').onclick = async e => {
  if (!(await uiConfirm(`删除选中的 ${state.selected.size} 篇？（进回收站，${state.health.trash_days || 30} 天内可恢复）`,
                         {title: '批量删除', anchor: e?.currentTarget}))) return;
  await api('/api/papers/batch-delete', {method: 'POST', body: JSON.stringify({paper_ids: [...state.selected]})});
  toast(`已移入回收站 ${state.selected.size} 篇`);
  state.selected.clear(); $('#batch-bar').classList.remove('show');
  await refreshLib();
};
$('#batch-move').onchange = async e => {
  if (!state.selected.size) return;
  const v = e.target.value;
  if (!v) return;
  const cid = v === '__none__' ? null : v;
  for (const id of state.selected) await api('/api/papers/' + id, {method: 'PATCH', body: JSON.stringify({collection_id: cid})});
  toast(`已移动 ${state.selected.size} 篇`);
  e.target.value = ''; $('#batch-cancel').click(); await refreshLib();
};

/* 搜索 + 快捷范围 chips */
let _libSearchTimer = 0;
$('#lib-search').oninput = e => {   // 300ms 防抖：大库逐键触发全文检索会请求风暴
  state.q = e.target.value;
  clearTimeout(_libSearchTimer);
  _libSearchTimer = setTimeout(loadPapers, 300);
};
$$('#scope-chips .chip-btn').forEach(b => b.addEventListener('click', () => {
  const s = b.dataset.scope;
  state.scope = state.scope === s ? '' : s;      // 再点取消
  $$('#scope-chips .chip-btn').forEach(x => x.classList.toggle('on', x.dataset.scope === state.scope));
  loadPapers();
}));

/* ---------------- 阅读器 ---------------- */
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
  const PAGE = 40;
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
    $('#pdf-host').innerHTML = `<div style="color:#aab;margin:40px auto;text-align:center;font-size:13px">
      ${icon('warn')} 本篇无 PDF 预览（URL/Office 导入）<br>右侧解析内容与问答功能正常</div>`;
  }
  // 解析内容 + 双语（先清掉上一篇的残留，避免串页）
  state.pairs = []; state.versions = []; state.assets = null;
  state._biTotal = 0; state._biOffset = 0;
  api(`/api/papers/${id}/assets`).then(d => {
    state.assets = d;
    if (['orig', 'bilingual', 'zh'].includes(state.view)) renderContentView();   // 聚合就绪→升级原图裁剪
  }).catch(() => {});
  state._refs = null;   // 引用缓存随论文重置
  state._cite = null;   // 引用文本缓存（{styles, labels, default}）
  state.citeStyle = localStorage.getItem('ps-cite-style') || 'gbt7714';
  state._metaEdit = false;   // 文献信息卡的内联编辑态
  state.showLayout = false; $('#layout-btn')?.classList.remove('on');   // 布局框不跨篇残留
  refreshJobState();   // 先取完整标志
  loadBilingual(id, false).then(() => {   // 翻译完成才默认双语；未完成/未开始停在原文
    // 渲染只此一次（原先 openPaper 链路全量渲染 ×3：loadBilingual 内、then 内、下方直调）
    if (state.translatedComplete && state.view === 'orig') switchView('read', 'bilingual');
    else renderContentView();
    restorePos(id);
  }).catch(() => {});
  renderContentView();
  refreshJobState();          // 解析/翻译控制按钮状态
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
    w.querySelector('.pdf-ph').style.height = Math.round(vp.height) + 'px';
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
    state.pairs = d.pairs; state.versions = d.versions;
    $('#version-select').hidden = true;   // 只展示最新一份（历史版本保留在库，不占界面）
    if (render) renderContentView();
  } catch { state.pairs = []; }
}
$('#version-select').onchange = e => {
  const d = e.target.value;
  api(`/api/papers/${state.current.id}/bilingual?cache_key=${d}`).then(x => {
    state.pairs = x.pairs; renderContentView();
  });
};
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
    strip.innerHTML = `<span>${pp.status === 'queued' ? '解析排队中（GPU 队列）' : pp.status === 'pending_gate' ? '等待 GPU 就绪…' : '解析中'}</span>
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
  try {
    const r = await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [state.current.id]})});
    toast(r.skipped_in_flight?.length ? '该论文已有译文/已在队列，无需重复' : '翻译任务已加入队列');
  } catch (e) { toast(e.message); }
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
function switchView(v, s) {
  updateQaBtn();
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
  } catch (e) { toast(e.message); }
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
    `<div class="pair zh blk ${isTitle ? 'blk-title-zh' : ''}" ${attrs}>${katexify(esc(p.zh))}</div>`];
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

function renderContentView() {
  const el = $('#content-view');
  if (!state.current) { el.innerHTML = '<p class="muted">选择左侧论文开始阅读</p>'; return; }
  if (state.mainView === 'read' || ['orig','bilingual','zh'].includes(state.view)) {
    // 阅读：走下方 orig/bilingual/zh 分支
  }
  if (state.view === 'meta') { renderMeta(); return; }
  if (state.view === 'assets') { renderAssets(); return; }
  if (state.view === 'json') {
    el.innerHTML = `<div class="card json-view">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <b>解析块 JSON（调试）</b><span class="muted" style="font-size:12px">${state.blocks.length} blocks</span>
        <button class="btn small" style="margin-left:auto" onclick="copyJson()">复制</button>
      </div>
      <pre>${esc(JSON.stringify(state.blocks, null, 2))}</pre></div>`;
    return;
  }
  if (state.view === 'bilingual') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="card" style="text-align:center;padding:40px 20px">
        <p style="font-size:15px;margin-bottom:14px">${state.translatingNow ? icon('clock', 12) + " 翻译中…" : '未翻译'}</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">${icon('globe')} 全文翻译</button>`}
      </div>`;
      return;
    }
    const rows = state.pairs.flatMap(pairRowsHtml);
    el.innerHTML = '<div class="pairs">' + rows.join('') + '</div>' +
      (state._biOffset < (state._biTotal || 0) ? loadHintHtml(`${state._biOffset}/${state._biTotal}`) : '');
  } else if (state.view === 'zh') {
    if (!state.translatedComplete) {
      el.innerHTML = `<div class="card" style="text-align:center;padding:40px 20px">
        <p style="font-size:15px;margin-bottom:14px">${state.translatingNow ? icon('clock', 12) + " 翻译中…" : '未翻译'}</p>
        ${state.translatingNow ? '' : `<button class="btn primary" onclick="startTranslate()">${icon('globe')} 全文翻译</button>`}
      </div>`;
      return;
    }
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
  $$('.topnav button[data-page]').forEach(x => x.classList.toggle('on', x.dataset.page === page));
  $('#page-title').textContent = {reader: '阅读', collections: '文库管理',
    trash: '回收站', settings: '设置'}[page];
  for (const p of ['reader', 'collections', 'trash', 'settings']) {
    $('#page-' + p).style.display = p === page ? (p === 'reader' ? 'flex' : 'block') : 'none';
  }
  ({collections: renderCollectionsPage, trash: renderTrash,
    settings: renderSettings})[page]?.();
}
window.switchPage = switchPage;  // 内联 onclick 可访问（module 作用域不暴露全局）

/* ---------------- 队列浮层（替代任务中心页） ---------------- */
let _badgeAt = 0;
async function refreshQueueBadge() {
  if (Date.now() - _badgeAt < 3000) return;   // SSE 事件风暴节流（3s）
  _badgeAt = Date.now();
  await _refreshQueueBadge();
}
async function _refreshQueueBadge() {
  try {
    const d = await api('/api/jobs?limit=200');
    const active = d.jobs.filter(j => ['queued', 'pending_gate', 'running'].includes(j.status));
    const btn = $('#queue-btn'), badge = $('#qbadge');
    btn.hidden = !active.length;
    badge.textContent = active.length;
    if (!$('#queue-pop').hidden) renderQueueList(d.jobs);
  } catch {}
}
async function renderQueueList(all) {
  const jobs = all || (await api('/api/jobs?limit=200')).jobs;
  const st = {queued: '排队', pending_gate: '等GPU', running: '进行中', done: '完成',
              failed: '失败', canceled: '已取消'};
  const live = jobs.filter(j => ['queued', 'pending_gate', 'running', 'failed'].includes(j.status)).slice(0, 30);
  $('#queue-list').innerHTML = live.map(j => `
    <div class="qp-row">
      <span class="badge ${j.status === 'failed' ? 'err' : 'run'}">${st[j.status] || j.status}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.title || j.paper_id || '')}</span>
      <span class="muted" style="font-size:11px">${j.job_type}${j.progress_total ? ' ' + j.progress_done + '/' + j.progress_total : ''}</span>
      ${['failed', 'canceled'].includes(j.status) ? `<button class="btn small" onclick="retryJob(${j.id})">重试</button>` : ''}
      ${['queued', 'pending_gate', 'running'].includes(j.status) ? `<button class="btn small danger" onclick="cancelJob(${j.id})">取消</button>` : ''}
      ${j.error ? `<div class="muted" style="font-size:11px;width:100%">${esc(j.error.slice(0, 90))}</div>` : ''}
    </div>`).join('') || '<p class="muted" style="padding:10px">无进行中任务</p>';
}
window.toggleQueue = async show => {
  const pop = $('#queue-pop');
  pop.hidden = show === undefined ? !pop.hidden : !show;
  if (!pop.hidden) renderQueueList();
};
$('#queue-btn').onclick = e => { e.stopPropagation(); toggleQueue(); };
document.addEventListener('click', e => {
  const pop = $('#queue-pop');
  if (!pop.hidden && !pop.contains(e.target) && e.target.id !== 'queue-btn') pop.hidden = true;
});
window.retryJob = async id => { await api(`/api/jobs/${id}/retry`, {method: 'POST'}); renderQueueList(); refreshQueueBadge(); };
window.cancelJob = async id => { await api(`/api/jobs/${id}/cancel`, {method: 'POST'}); renderQueueList(); refreshQueueBadge(); };
window.pauseQueue = async () => { await api('/api/queue/parse/pause', {method: 'POST'}); toast('批量已暂停（手动任务不受影响）'); };
window.resumeQueue = async () => { await api('/api/queue/parse/resume', {method: 'POST'}); toast('批量已恢复'); };
setInterval(refreshQueueBadge, 8000);

/* SSE 实时进度 */
let _sseCollectionsAt = 0;   // 批量任务事件风暴节流（3s 内只重建一次文库页）
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
    if (state.current && ev.paper_id === state.current.id && ev.job_type === 'parse' && ev.status === 'done') {
      openPaper(state.current.id);  // 解析完成刷新视图
      loadPapers();
    }
    if (ev.job_type === 'parse' && (ev.status === 'done' || ev.status === 'failed')) {
      api('/api/papers').then(d => {
        state.qaAllPapers = d.papers;
        if (state.view === 'qa') {
          renderPickList($('#qa-pick-filter')?.value.toLowerCase() || '');
          renderQaScope();
          if (ev.status === 'done') toast(`《${(d.papers.find(x => x.id === ev.paper_id) || {}).title || ''}》解析完成，可以提问了`);
        }
      });
    }
    refreshQueueBadge();
    // 文库管理页打开时同步行内状态（批量导入时每块一事件，全量重建需节流）
    const cp = $('#page-collections');
    if (cp && cp.style.display !== 'none' && Date.now() - _sseCollectionsAt > 3000) {
      _sseCollectionsAt = Date.now();
      renderCollectionsPage();
    }
  };
}

/* ---------------- 右栏页签：文献信息 / 导读 / 图表 ---------------- */
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
        ${paper.meta_source ? `<span class="badge ok" title="${esc(paper.meta_verified_at || '')}">${icon('check')} 已校准(${esc(paper.meta_source)})</span>` : '<span class="badge priv">未校准</span>'}</div>`;

  $('#content-view').innerHTML = `
    <div class="meta-head card">
      ${metaBody}
      <div class="meta-line"><span id="m-stars">${[1,2,3,4,5].map(i => `<span class="star ${i <= (notes.importance||0) ? 'on' : ''}" data-i="${i}">${icon('star')}</span>`).join('')}</span>
        ${icon('tag')} <span id="m-tags">${esc(notes.tags || '') || '<i class=muted>点击右侧添加</i>'}</span></div>
      <div class="meta-actions">
        ${editing ? `<button class="btn small primary" onclick="saveMeta('${pid}')">${icon('check')} 保存</button>
        <button class="btn small" onclick="cancelMeta()">取消</button>`
        : `<button class="btn small" onclick="editMeta('${pid}')">${icon('edit')} 编辑</button>`}
        <button class="btn small" onclick="extractMeta('${pid}')" title="用 AI 补全缺失字段（作者/摘要/关键词）">${icon('bolt')} AI 补全</button>
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
      <h3>摘要 <span class="muted" style="font-weight:400;font-size:12px">${icon('pin')}点击定位</span> ${kw.length ? '<span class="muted" style="font-weight:400;font-size:12px">· 关键词: ' + esc(kw.join(' · ')) + '</span>' : ''}</h3>
      <p style="font-size:13px; line-height:1.7">${esc(paper.abstract || '（无——可点 AI 提取）')}</p></div>
    <div class="card"><h3>${icon('note')} 备注</h3>
      <textarea id="m-notes" placeholder="记录阅读笔记…（自动保存）" style="min-height:70px">${esc(notes.notes || '')}</textarea></div>
    <div class="card"><h3>References (${refs.references.length}) <input id="ref-search" placeholder="搜索…" style="width:140px; font-size:12px; margin-left:8px; display:inline-block"></h3>
      <div class="ref-list" id="ref-list"></div></div>
    <div class="card"><h3>${icon('folder')} 分库</h3>
      <select id="m-collection" style="max-width:240px"><option value="">未分库</option></select></div>`;

  renderCiteCard();

  // 分库下拉
  const colSel = $('#m-collection');
  state.collections.forEach(c2 => colSel.insertAdjacentHTML('beforeend',
    `<option value="${c2.id}" ${paper.collection_id === c2.id ? 'selected' : ''}>${esc(c2.name)}</option>`));
  colSel.onchange = async () => {
    await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: colSel.value || null})});
    toast('已移动'); await refreshLib();
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
  let noteTimer;
  $('#m-notes').oninput = e => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => api(`/api/papers/${pid}/notes`, {method: 'PUT', body: JSON.stringify({...notes, notes: e.target.value})}).then(() => toast('已保存', 1000)), 800);
  };
  // 参考文献渲染+搜索
  const renderRefs = q => {
    const list = refs.references.filter(r => !q || r.text.toLowerCase().includes(q));
    state._refs = refs.references;
    $('#ref-list').innerHTML = list.map(r =>
      `<div class="ref-item" onclick="flashRefBlock('${r.block_id}')">${icon('doc')} ${esc(r.text.slice(0, 150))}</div>`).join('') ||
      '<p class="muted">无匹配</p>';
  };
  renderRefs('');
  $('#ref-search').oninput = e => renderRefs(e.target.value.toLowerCase());
  loadRank(pid);   // 分区自动加载（按期刊缓存，同期刊只查一次）
}

/* 元数据编辑：内联输入框，不弹 prompt 链（原来一次要弹 6 个框）。
   卷/期/页是引用格式需要的字段，一并在这里补。 */
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
function canonicalName(p) {
  const title = (p.title || p.id || '').trim();
  const authors = (p.authors || '').trim();
  const year = (p.year || '').trim();
  let surname = '';
  if (authors) {
    const first = authors.split(',')[0].trim();
    const tokens = first.split(/\s+/);
    surname = tokens[tokens.length - 1] || first;
  }
  return ((surname || '') + year + ' ' + title).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}
window.reindexPaper = async (pid) => {
  if (!(await uiConfirm('重建该论文的块结构与检索索引？（从已存解析产物重新入库，不重新解析、不影响译文）', {title: '重建索引'}))) return;
  const r = await api(`/api/papers/${pid}/reindex`, {method: 'POST'});
  toast(`已重建 ${r.blocks} 块 / ${r.chunks} 分块，向量回填中`);
};
window.verifyMeta = async (pid) => {
  toast('联网校准中…（arXiv/CrossRef，只发送标题）');
  try {
    const r = await api(`/api/papers/${pid}/verify-meta`, {method: 'POST'});
    if (r.verified) toast(`✓ 已按 ${r.candidate.source} 校准（标题相似度 ${r.candidate.match}）`);
    else toast('⚠ ' + r.message);
    openPaper(pid); renderMeta();
  } catch (e) { toast('校准失败: ' + e.message); }
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
        <span class="muted" style="font-size:11px">via easyScholar${r.cached ? '（缓存）' : ''}</span>`;
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
   CSL 样式（12 种）经 citeproc-js 本地渲染（vendor），BibTeX 与兜底用后端预渲染。 */
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
  if (!window.citeproc) throw new Error('citeproc 未加载');
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
  if (styleId === 'bibtex' || !window.citeproc) {
    const html = c.styles?.[styleId]?.html || '（该样式需要 citeproc 支持库）';
    box.innerHTML = html;
    state._citeRendered = {styleId, html};
    return;
  }
  box.innerHTML = '<span class="muted">渲染中…</span>';
  try {
    const html = await cslRender(c.csl_json, styleId);
    if (state.citeStyle !== styleId) return;   // 用户已切走样式：丢弃迟到渲染
    box.innerHTML = html || '（渲染为空）';
    state._citeRendered = {styleId, html};
  } catch (e) {
    box.innerHTML = c.styles?.[styleId]?.html || `<span class="muted">CSL 渲染失败：${esc(e.message)}</span>`;
    state._citeRendered = {styleId, html: box.innerHTML};
  }
}
window.copyCite = async (pid) => {
  const c = state._cite && state._cite.paper_id === pid ? state._cite
            : await api(`/api/papers/${pid}/cite`);
  const st = state.citeStyle || c.default || 'gbt7714';
  let txt = c.styles?.[st]?.text || '';
  if (state._citeRendered?.styleId === st && state._citeRendered.html) {
    const d = document.createElement('div');
    d.innerHTML = state._citeRendered.html;
    txt = (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  if (!txt) { toast('引用为空'); return; }
  try { await navigator.clipboard.writeText(txt); toast('已复制'); }
  catch { toast('复制失败，请手动选中复制'); }
};

/* ---------------- 右栏页签：问答 / 导读（与文章并排） ---------------- */
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
        <div class="qa-pick-head">添加参与问答的论文 <span class="muted">2 篇以上自动对比 · 已选 <b id="qa-pick-count">0</b></span></div>
        <div class="qa-pick-tools">
          <input id="qa-pick-filter" placeholder="搜索标题…" style="font-size:12px">
          <select id="qa-pick-sort" title="组内排序" style="font-size:12px;width:auto;flex:none">
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
      <div id="qa-sum-bubble"></div>
      <div id="qa-msg-list"></div>
    </div>
    <div class="preset-qs" id="preset-qs"></div>
    <div class="qa-quote" id="qa-quote" hidden>
      <span class="muted" style="font-size:11px">${icon('quote', 12)} 引用</span>
      <div class="qa-quote-text" id="qa-quote-text"></div>
      <button class="btn small" id="qa-quote-clear" title="移除引用">${icon('close')}</button>
    </div>
    <div class="qa-input">
      <textarea id="qa-text" placeholder="对着文献提问…（添加 2 篇以上自动对比 · Ctrl+Enter 发送）"></textarea>
      <button class="btn primary" id="qa-send">发送</button>
    </div>`;
  renderQaScope();
  populateQaPicker();
  api('/api/presets').then(presets => {
    const el = $('#preset-qs');
    if (!el) return;
    const qs = state.qaPapers.size >= 2 ? [...(presets.compare || [])] : [...presets.questions];
    // 预设问题默认收起成一行，不占正文版面；点标题展开，提问后自动收起
    el.innerHTML = `<button class="preset-toggle" id="preset-toggle">${icon('bulb')} 推荐问题<span class="arrow">${icon('chevD')}</span></button>
      <div class="preset-list" id="preset-list" hidden>${qs.map(q =>
      `<button onclick="askPreset('${esc(q).replace(/'/g, "\\'")}')">${esc(q)}</button>`).join('')}</div>`;
    $('#preset-toggle').onclick = () => togglePresetList();
  });
  const pickToggle = $('#qa-pick-toggle');           // 仅对比模式渲染（单篇无选择器）
  if (pickToggle) pickToggle.onclick = () => {
    const panel = $('#qa-pick-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderPickList($('#qa-pick-filter').value.toLowerCase()); $('#qa-pick-filter').focus(); }
  };
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
  $('#qa-text').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) sendQa(); };
  $('#qa-text').oninput = e => {   // 自动长高（上限 150px）
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px';
  };
  // 会话恢复：按「问答范围」过滤（不是当前打开的论文）
  // 范围为空 → 问答区留空并禁用输入；范围有论文 → 加载这些论文的会话
  const scope = [...state.qaPapers];
  api('/api/chat/sessions').then(d => {
    const hint = $('#qa-no-paper');
    const inp = $('#qa-text');
    if (!scope.length) {                 // 没选论文 → 不显示上一篇的残留问答
      state.qaSession = '';
      const list = $('#qa-msg-list'); if (list) list.innerHTML = '';
      const sum = $('#qa-sum-bubble'); if (sum) sum.innerHTML = '';
      if (hint) hint.hidden = false;
      if (inp) inp.disabled = true;
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
  const pid = [...state.qaPapers][0] || state.current?.id;
  if (!pid) { el.innerHTML = ''; return; }
  const paper = (state.qaAllPapers || state.papers).find(x => x.id === pid) || state.current || {};
  const title = paper.title || pid;
  const multi = state.qaPapers.size > 1;
  // 悬浮提示而非常驻文字（优雅优先；多篇警示仅在生成按钮气泡里出现一次）
  state._sumTip = `针对：${title}` + (multi ? `（已选 ${state.qaPapers.size} 篇，导读仅第一篇）` : '');
  state._sumHead = multi ? `<div class="muted" style="font-size:11px;margin-bottom:4px">已选 ${state.qaPapers.size} 篇 · 导读针对第一篇</div>` : '';
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
  el.innerHTML = (state._sumHead || '') + "<div class=\"msg assistant\"><div class=\"bubble\">" + icon('clock', 12) + " 导读生成中…（全文直读，任务中心可取消）</div></div>";
  try {
    const d = await api(`/api/papers/${pid}/summary`, {method: 'POST',
      body: JSON.stringify({session_id: state.qaSession, async: true})});
    const jobId = d.job_id;
    for (let i = 0; i < 150; i++) {          // 轮询任务状态（导读单并发，排队可能较久）
      await new Promise(r => setTimeout(r, 2000));
      if (state.current?.id !== pid) return;   // 已切到别的论文 → 停止轮询
      const js = await api(`/api/jobs/${jobId}`).catch(() => null);
      if (!js) continue;
      if (js.status === 'done') break;
      if (js.status === 'failed') throw new Error(js.error || '生成失败');
      if (js.status === 'canceled') { el.innerHTML = (state._sumHead || '') + '<p class="muted">导读生成已取消。</p>'; return; }
    }
    const d2 = await api(`/api/papers/${pid}/summary`);
    if (d2.session_id) state.qaSession = d2.session_id;
    state._sumCache = state._sumCache || {};
    state._sumCache[pid] = d2;
    drawSummary(d2, pid, '#qa-sum-bubble', true);
    toast('导读已生成，并存入当前会话');
  } catch (e) {
    el.innerHTML = (state._sumHead || '') + `<div class="msg assistant"><div class="bubble">生成失败: ${esc(e.message)} <button class="btn small" onclick="genSumBubble('${pid}')">重试</button></div></div>`;
  }
}

/* ---- 上下分栏：拖动调占比；问答可整体关闭/重开回默认位 ---- */
state.rpane = { top: parseFloat(localStorage.getItem('ps-rpane-top') || '55'), readingView: 'orig', split: true };
state.qaOpen = localStorage.getItem('ps-qa-open') === '1';   // 默认收起：手动打开过（'1'）才记住展开
window.applyQaLayout = () => {
  const top = $('#rpane-top'), dock = $('#qa-dock'), handle = $('#rpane-handle');
  if (state.qaOpen) {
    dock.hidden = false; handle.hidden = false;
    top.style.flex = 'none'; top.style.height = state.rpane.top + '%';
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
  const top = $('#rpane-top');
  const apply = () => {
    if (state.qaOpen) { top.style.flex = 'none'; top.style.height = state.rpane.top + '%'; }
  };
  applyQaLayout();
  $('#qa-dock-close').onclick = closeQa;
  $('#qa-export').onclick = exportChat;
  const handle = $('#rpane-handle');
  let dragging = false;
  handle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const body = $('.rpane-body').getBoundingClientRect();
    const pct = Math.min(99, Math.max(1, Math.round(100 * (e.clientY - body.top) / body.height)));
    state.rpane.top = pct; apply();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; localStorage.setItem('ps-rpane-top', String(state.rpane.top)); }
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
        <div class="muted" style="font-size:var(--fs-xs)">${(x.updated_at || '').slice(5, 16)}</div>
      </div>
      <button class="btn small" onclick="event.stopPropagation();renameSess('${x.id}', '${esc((x.title || '').replace(/'/g, "\'"))}')" title="重命名">${icon('edit', 12)}</button>
      <button class="btn small danger" onclick="event.stopPropagation();delSess('${x.id}')" title="删除会话">${icon('trash', 12)}</button>
    </div>`).join('') : '<p class="muted" style="padding:8px">当前范围还没有会话</p>';
}
window.switchSess = async sid => {
  state.qaSession = sid;
  $('#qa-sess-panel').hidden = true;
  await loadSession(sid);
  updateExportBtn?.();
};
window.delSess = async sid => {
  if (!(await uiConfirm('删除该会话及其全部消息？', {title: '删除会话'}))) return;
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
/* 推荐问题：展开/收起（默认收起，避免长期占用阅读空间） */
function togglePresetList(force) {
  const list = $('#preset-list'), tg = $('#preset-toggle');
  if (!list) return;
  list.hidden = force !== undefined ? !force : !list.hidden;
  tg?.classList.toggle('open', !list.hidden);
}
function collapsePresetList() { togglePresetList(false); }
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
  if (fl) {
    let t = 0;
    fl.oninput = () => {   // 防抖：大库逐键全量重渲染会卡
      clearTimeout(t);
      t = setTimeout(() => renderPickList(fl.value.toLowerCase()), 200);
    };
  }
  const toggle = $('#qa-pick-toggle');
  if (!toggle) return;
  $('#qa-pick-count').textContent = state.qaPapers.size;
}
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
  const groups = cols.map(c => ({
    id: c.id, name: c.name, papers: papers.filter(p => p.collection_id === c.id && match(p)),
  }));
  const orphan = papers.filter(p => !p.collection_id && match(p));
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
          <span class="muted" style="font-size:11px">${selN ? `<b class="qp-sel">${selN} 已选</b> · ` : ''}${g.papers.length} 篇 <span class="qp-caret ${isOpen ? 'open' : ''}">${icon('chevD')}</span></span>
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
  if (!sid) { el.innerHTML = ''; return; }
  const d = await api(`/api/chat/sessions/${sid}/messages`);
  const list = $('#qa-msg-list');
  if (!list) return;
  const MARKER = '请生成这篇论文的科研导读';
  const msgs = [];
  for (let i = 0; i < d.messages.length; i++) {
    const m = d.messages[i];
    if (m.role === 'user' && m.content === MARKER) { i++; continue; }  // 导读对由气泡展示，跳过
    try { m._ev = JSON.parse(m.evidence || '[]'); } catch { m._ev = []; }
    msgs.push(m);
  }
  list.innerHTML = msgs.map((m, i) =>
    `<div class="msg ${m.role}"><div class="bubble" data-mi="${i}">${m.role === 'assistant' ? renderCites(m.content, m._ev) : esc(m.content)}</div></div>`).join('');
  msgs.forEach((m, i) => {
    if (m.role === 'assistant' && m._ev?.length) {
      const el = $(`#qa-msg-list .bubble[data-mi="${i}"]`);
      if (el) wireCites(el, m._ev);
    }
  });
  renderSumBubble();
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
    return !pp || pp.parse_status === 'parsed';
  });
  if (!parsedScope.length) { toast('所选论文尚未解析完成，请稍候'); return; }
  $('#qa-text').value = '';
  collapsePresetList();      // 已提问 → 收起推荐问题，把版面让给回答
  const quote = state.qaQuote || '';
  $('#qa-msg-list').insertAdjacentHTML('beforeend',
    `<div class="msg user"><div class="bubble">${quote ? '<div class="muted" style="font-size:11px;border-left:2px solid #c9d2ee;padding-left:6px;margin-bottom:4px">' + icon('quote', 12) + ' ' + esc(quote.split('\n> ')[1]?.slice(0, 80) || '') + '…</div>' : ''}${esc(text)}</div></div>
     <div class="msg assistant"><div class="bubble" id="qa-live">…</div></div>`);
  const live = $('#qa-live'); live.id = '';
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
        if (ev.type === 'delta') live.textContent += ev.text;
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
          if (ev.truncated) live.insertAdjacentHTML('beforeend', "<div class=\"muted\" style=\"font-size:11px;margin-top:6px\">" + icon('warn') + " 内容过长，已启用检索取证模式</div>");
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
    else if (act === 'admin') {   // 管理区在设置页底部
      switchPage('settings');
      setTimeout(() => $('#admin-zone')?.scrollIntoView({block: 'start', behavior: 'smooth'}), 350);
    }
    else if (act === 'usage') { switchPage('settings'); setTimeout(() => $('#usage-zone')?.scrollIntoView({block: 'center'}), 300); }
  };
  // 未配置 key 提示横幅
  if (!state.me.llm_configured.chat) {
    $('.main').insertAdjacentHTML('afterbegin',
      `<div class="check-banner">${icon('warn')}️ 尚未配置 LLM key——问答/翻译不可用。前往 <a href="#" onclick="switchPage('settings');return false">设置页</a> 配置。</div>`);
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
boot();

/* ================= 跨文献讨论（覆盖层） ================= */
function mdLite(text) {
  let h = esc(text);
  h = h.replace(/(^|\n)((?:\|[^\n]+\|\n)+)/g, (m, pre, block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[\s:|-]+\|$/.test(r));
    const cells = rows.map(r => r.split('|').slice(1, -1).map(c => c.trim()));
    if (cells.length < 2) return m;
    return pre + '<table class="tbl-md"><tr>' + cells[0].map(c => `<th>${c}</th>`).join('') + '</tr>' +
      cells.slice(1).map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>';
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{2,4} (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^- (.+)$/gm, '&bull; $1');
  return katexify(h);
}
function renderCites(text, evidence) {
  return mdLite(text).replace(/\[(\d{1,3})\]/g, (m, n) => {
    // 按 evidence_id 匹配（校验后的 evidence 数组只剩被引用项，下标 ≠ 编号）
    const ev = evidence && evidence.find(x => String(x.evidence_id) === n);
    const tip = ev ? `${ev.title || ev.paper_id} · 第${ev.page_index + 1}页` : '';
    return `<span class="cite" data-n="${n}"${tip ? ` title="${esc(tip)}"` : ''}>[${n}]</span>`;
  });
}
function wireCites(container, evidence) {
  $$('.cite', container).forEach(el => {
    const n = String(el.dataset.n || (el.textContent.match(/\d+/) || [0])[0]);
    const ev = evidence && evidence.find(x => String(x.evidence_id) === n);
    el._ev = ev || null;              // 悬浮预览卡直接取（见 ② 引用悬浮预览）
    el.onclick = () => { if (ev) jumpToEvidence(ev); };
  });
}
/* 点引文 → 定位到具体块：PDF 里闪烁高亮 + 右侧阅读面板滚到该段并置为激活。
   只跳页的话整页几十个块还是不好找，所以必须定位到块。
   证据块常在分页未加载区间（首屏仅 40 块）→ 增量加载直到命中。 */
window.jumpToEvidence = async e => {
  if (!e) return;
  if (!state.current || state.current.id !== e.paper_id) await openPaper(e.paper_id);
  const match = () =>
    (state.blocks || []).find(x => x.block_id === e.block_id)
    || state.blocks.find(x => x.page_index === e.page_index && x.text
         && e.text && (x.text.includes(e.text.slice(0, 60)) || e.text.includes(x.text.slice(0, 60))));
  let blk = match();
  if (!blk && state.current) {
    // 分页穿透：切到原文视图逐批加载，直到目标块出现或已越过证据所在页
    switchPage('reader');
    if (state.view !== 'orig') switchView('read', 'orig');
    for (let i = 0; i < 80 && state._blkOffset < (state._blkTotal || 0); i++) {
      await loadMoreBlocks();
      blk = match();
      if (blk) break;
      const lastPg = state.blocks.length ? state.blocks[state.blocks.length - 1].page_index : -1;
      if (lastPg > e.page_index + 1) break;   // 已翻过证据页仍未命中（块失配）→ 放弃
    }
  }
  if (blk) {
    switchPage('reader');
    // 右侧阅读面板：置为激活块 + 滚到可见（当前子页签没显示正文就切到"原文"）
    let blkEl = $(`#content-view .blk[data-bid="${blk.block_id}"]`);
    if (!blkEl) {
      switchView('read', 'orig');
      blkEl = $(`#content-view .blk[data-bid="${blk.block_id}"]`);
    }
    if (blkEl) {
      $$('#content-view .blk').forEach(x => { x.classList.remove('active'); x.style.removeProperty('--hlc'); });
      applyActiveStyle(blkEl);
      blkEl.scrollIntoView({block: 'center', behavior: 'smooth'});
    }
    // PDF：滚到块所在页并闪烁高亮框（跨页段落每页各画一个）
    if (state.pdfDoc) state.pageNum = blk.page_index + 1;
    await pdfFlashBlock(blk);
    return;
  }
  // 找不到块（跨论文证据 / 块已重建）→ 至少跳到对应页
  if (state.pdfDoc) { state.pageNum = e.page_index + 1; renderPage(); }
};
window.jumpEvidence = page => { switchPage('reader'); if (state.pdfDoc) { state.pageNum = page + 1; renderPage(); } };

/* ================= 恢复区：被误删函数重建（以文件末尾声明覆盖） ================= */

/* ---- 回收站 ---- */
async function renderTrash() {
  const d = await api('/api/papers?trash=1');
  $('#page-trash').innerHTML = `<div class="card"><h2 style="display:flex;gap:10px;align-items:center">回收站（30 天后自动清理）
    <button class="btn small danger" style="margin-left:auto" onclick="emptyTrash()">${icon('trash')} 清空回收站</button></h2>
    <table class="list"><tr><th>标题</th><th>删除时间</th><th></th></tr>
    ${d.papers.map(p => `<tr><td>${esc(p.title)}</td><td class="muted">${p.deleted_at}</td>
      <td class="row-actions"><button class="btn small" onclick="restorePaper('${p.id}')">恢复</button>
      </td></tr>`).join('') || '<tr><td colspan="3" class="muted">回收站为空</td></tr>'}</table></div>`;
}
window.restorePaper = async id => { await api(`/api/papers/${id}/restore`, {method: 'POST'}); toast('已恢复'); renderTrash(); await refreshLib(); };

/* ---- 设置（BYOK + 术语表 + 测试连接） ---- */
async function renderSettings() {
  const d = await api('/api/settings/llm');
  const isAdmin = state.me?.role === 'admin';
  const tpl = (purpose, cfg, conf) => `
    <div class="set-card">
      <div class="set-head">${purpose === 'chat' ? icon('chat') + " 聊天（问答/导读）" : icon('globe') + " 翻译"} ${conf.configured ? '<span class="badge ok">已配置</span>' : '<span class="badge err">未配置</span>'}</div>
      <form id="f-${purpose}">
        <label>API 地址 <input name="base_url" value="${esc(conf.base_url)}" placeholder="https://open.bigmodel.cn/api/anthropic"></label>
        <label>模型 <input name="model" value="${esc(conf.model)}" placeholder="glm-4.7"></label>
        <label>协议 <select name="api_type"><option value="anthropic" ${conf.base_url.includes('anthropic') ? 'selected' : ''}>anthropic</option><option value="openai" ${!conf.base_url.includes('anthropic') ? 'selected' : ''}>openai</option></select></label>
        <label>API Key ${conf.configured ? '<span class="muted" style="font-size:11px">已保存（留空不变）</span>' : ''} <input name="api_key" type="password" placeholder="${conf.configured ? '••••••（输入可更换）' : '粘贴 API Key'}"></label>
        <div class="set-actions">
          <button class="btn" type="button" onclick="testLlm('f-${purpose}')">${icon('bolt')} 测试</button>
          <button class="btn primary" type="submit">${icon('save')} 保存</button>
        </div>
      </form>
    </div>`;
  $('#page-settings').innerHTML = `
    <div class="set-grid">
      <div class="set-col">
        <div class="set-card">
          <div class="set-head">${icon('lock')} 账号安全</div>
          <form id="f-password">
            <label>当前密码 <input name="old_password" type="password" required></label>
            <label>新密码（至少 8 位） <input name="new_password" type="password" minlength="8" required></label>
            <label>确认新密码 <input name="confirm" type="password" minlength="8" required></label>
            <div class="set-actions">
              <button class="btn primary" type="submit">${icon('check')} 修改密码</button>
              <button class="btn" type="button" onclick="logoutAll()">${icon('lock')} 登出所有设备</button>
            </div>
          </form>
        </div>
        <h2 class="page-h">${icon('key')} LLM 配置（BYOK）</h2>
        <p class="muted" style="font-size:12px;margin:2px 0 12px">聊天/翻译各自独立；embedding 本机运行无需配置。密钥加密存储、永不回显。</p>
        ${tpl('chat', d.chat, d.chat)}
        ${tpl('translate', d.translate, d.translate)}
      </div>
      <div class="set-col">
        <h2 class="page-h">${icon('book')} 翻译术语表（全局）</h2>
        <div id="gl-list" style="margin:10px 0"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="gl-term" placeholder="术语" style="flex:2;min-width:120px">
          <select id="gl-target" style="flex:1;min-width:100px">
            <option value="keep_en">保留英文</option><option value="trans">固定译法</option><option value="first_both">首次并列</option>
          </select>
          <input id="gl-value" placeholder="译法" style="flex:2;min-width:100px">
          <button class="btn small primary" id="gl-add">${icon('plus')}</button>
        </div>
        ${isAdmin ? '<div id="admin-zone" style="margin-top:22px"></div>' : ''}
      </div>
    </div>`;
  const bind = (fid, purpose) => $(`#${fid}`).onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const conf = {base_url: f.get('base_url'), model: f.get('model'), api_type: f.get('api_type')};
    if (f.get('api_key')) conf.api_key = f.get('api_key');
    await api('/api/settings/llm', {method: 'PUT', body: JSON.stringify({[purpose]: conf})});
    toast('已保存'); renderSettings();
  };
  bind('f-chat', 'chat'); bind('f-translate', 'translate');
  loadGlossary();
  $('#f-password').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (f.new_password.value !== f.confirm.value) { toast('两次输入的新密码不一致'); return; }
    try {
      await api('/api/password', {method: 'POST', body: JSON.stringify({
        old_password: f.old_password.value, new_password: f.new_password.value})});
      toast('密码已修改（其他设备已登出）');
      f.reset();
    } catch (err) { toast('修改失败: ' + err.message); }
  };
  if (isAdmin) renderAdminZone();
}
async function renderAdminZone() {
  const el = $('#admin-zone');
  if (!el) return;
  const users = await api('/api/admin/users');
  const pool = await api('/api/admin/pool');
  const usage = await api('/api/usage').catch(() => ({rows: []}));
  const audit = await api('/api/admin/audit?limit=50').catch(() => ({rows: []}));
  el.innerHTML = `
    <h2 class="page-h">${icon('crown')} 管理（仅管理员可见）</h2>
    <div class="set-card">
      <div class="set-head">邀请码</div>
      <button class="btn small primary" onclick="createInvite()">${icon('plus')} 生成（7天）</button>
      <div id="invite-out" style="margin-top:8px;font-size:13px"></div>
    </div>
    <div class="set-card">
      <div class="set-head">用户与限额 <span class="muted" style="font-size:11px">覆盖示例 {"max_pages":1000}</span></div>
      <table class="list">${users.users.map(u => `<tr>
        <td>${esc(u.username)} ${u.role === 'admin' ? '<span class="badge priv">admin</span>' : ''}</td>
        <td>${u.papers} 篇</td>
        <td style="width:40%"><input style="font-size:11px" id="q-${u.id}" value='${esc(u.overrides || '{}')}'></td>
        <td class="row-actions">
          ${u.disabled === 2 ? '<span class="badge priv">已注销</span>' : ''}
          <button class="btn small" onclick="saveQuota(${u.id})" title="保存限额">${icon('save')}</button>
          <button class="btn small danger" onclick="resetUserPw(${u.id}, '${esc(u.username)}')" title="重置为临时密码">${icon('key')}</button>
          ${u.id !== state.me.id && !u.disabled ? `<button class="btn small danger" onclick="toggleUser(${u.id}, '${esc(u.username)}', true)" title="禁用登录">${icon('stop')}</button>` : ''}
          ${u.disabled === 1 ? `<button class="btn small" onclick="toggleUser(${u.id}, '${esc(u.username)}', false)" title="重新启用">${icon('play')}</button>` : ''}
        </td></tr>`).join('')}</table>
      <div class="set-head" style="margin-top:14px">${icon('clock')} 审计日志 <span class="muted" style="font-weight:400">最近操作</span></div>
      <div id="audit-list" style="max-height:220px;overflow-y:auto;font-size:var(--fs-xs)">
        ${audit.rows.length ? audit.rows.map(r =>
          `<div style="padding:3px 0;border-bottom:1px solid var(--line-soft)">
             <span class="muted">${(r.created_at || '').slice(5, 16)}</span>
             <b>${esc(r.username || '系统')}</b> ${esc(r.action)}
             <span class="muted">${esc(r.detail || '').slice(0, 40)}</span>
           </div>`).join('') : '<p class="muted">暂无记录</p>'}
      </div>
    </div>
    <div class="set-card">
      <div class="set-head">${icon('chart')} Token 用量 <span class="muted" style="font-weight:400">按用户（chat+translate）</span></div>
      <table class="list">${(() => {
        const byName = {};
        (usage.by_user || []).forEach(r => {
          const k = r.username || 'CLI';
          byName[k] = byName[k] || {chat: 0, translate: 0};
          if (r.purpose === 'chat') byName[k].chat += r.p + r.c;
          else if (r.purpose === 'translate') byName[k].translate += r.p + r.c;
        });
        return Object.entries(byName).map(([name, t]) =>
          `<tr><td>${esc(name)}</td><td class="muted" style="font-size:11px">问答 ${(t.chat).toLocaleString()} tok · 翻译 ${(t.translate).toLocaleString()} tok</td></tr>`).join('') || '<tr><td class="muted">暂无用量</td></tr>';
      })()}</table>
    </div>
    <div class="set-card">
      <div class="set-head">公共额度池 <span class="muted" style="font-size:11px">未配置 key 的成员将使用你的 POOL key</span></div>
      <button class="btn small ${pool.enabled ? 'danger' : 'primary'}" onclick="togglePool(${!pool.enabled})">${pool.enabled ? '关闭' : '开启'}</button>
    </div>`;
}
/* 管理区动作（48b9862 改造时误删了实现，按钮留着 → 一按就 ReferenceError） */
window.createInvite = async () => {
  const d = await api('/api/admin/invite', {method: 'POST'});
  const el = $('#invite-out');
  if (el) el.innerHTML = `邀请码: <code style="font-size:16px">${d.code}</code>（${d.expires_in_days} 天内有效，一次性）`;
};
window.logoutAll = async () => {
  if (!(await uiConfirm('登出所有设备？其他已登录的会话将全部失效。', {title: '登出所有设备'}))) return;
  await api('/api/logout-all', {method: 'POST'});
  toast('已登出所有设备');
};
window.toggleUser = async (uid, uname, disable) => {
  const act = disable ? '禁用' : '重新启用';
  if (!(await uiConfirm(`${act}用户 ${uname}？${disable ? '该用户将无法登录，已有会话全部失效。' : ''}`, {title: `${act}用户`, danger: !disable}))) return;
  try {
    await api(`/api/admin/users/${uid}/${disable ? 'disable' : 'enable'}`, {method: 'POST'});
    toast(`已${act}`); renderAdminZone();
  } catch (e) { toast('操作失败: ' + e.message); }
};
window.resetUserPw = async (uid, uname) => {
  if (!(await uiConfirm(`重置 ${uname} 的密码？将生成一次性临时密码，且该用户所有会话立即失效。`, {title: '重置密码'}))) return;
  try {
    const r = await api(`/api/admin/users/${uid}/reset-password`, {method: 'POST'});
    await uiPassword(`${uname} 的临时密码（仅显示一次，请立即复制转交）`, r.temp_password);
  } catch (e) { toast('重置失败: ' + e.message); }
};

window.saveQuota = async uid => {
  try {
    const overrides = JSON.parse($('#q-' + uid).value || '{}');
    await api(`/api/admin/users/${uid}/quota`, {method: 'PUT', body: JSON.stringify(overrides)});
    toast('已保存');
  } catch (e) { toast('JSON 格式错误: ' + e.message); }
};
window.togglePool = async enable => {
  await api('/api/admin/pool', {method: 'POST', body: JSON.stringify({enabled: enable})});
  toast(enable ? '公共池已开启' : '公共池已关闭');
  renderAdminZone();
};
window.testLlm = async fid => {
  const f = new FormData($('#' + fid));
  if (!f.get('api_key')) { toast('请先输入 key'); return; }
  const r = await api('/api/settings/llm/test', {method: 'POST', body: JSON.stringify({
    base_url: f.get('base_url'), api_key: f.get('api_key'),
    model: f.get('model'), api_type: f.get('api_type')})});
  toast(r.ok ? '✅ ' + r.message : '❌ ' + r.message);
};
async function loadGlossary() {
  const d = await api('/api/glossary');
  const el = $('#gl-list');
  if (!el) return;
  el.innerHTML = d.terms.map(t =>
    `<span class="chip">${esc(t.term)}${t.target === 'trans' ? ' → ' + esc(t.value) : t.target === 'first_both' ? ' ⇄ ' + esc(t.value) : ' (EN)'}
     <button onclick="delGlossary('${esc(t.term).replace(/'/g, "\\'")}')">${icon('close')}</button></span>`).join('') ||
    '<span class="muted" style="font-size:12px">暂无术语——按需添加以保证全文译名一致</span>';
  $('#gl-add').onclick = async () => {
    const term = $('#gl-term').value.trim();
    if (!term) { toast('请输入术语'); return; }
    await api('/api/glossary', {method: 'POST', body: JSON.stringify({
      term, target: $('#gl-target').value, value: $('#gl-value').value.trim()})});
    $('#gl-term').value = ''; $('#gl-value').value = '';
    toast('已添加，下次翻译生效'); loadGlossary();
  };
}
window.delGlossary = async term => {
  await api('/api/glossary/' + encodeURIComponent(term), {method: 'DELETE'});
  loadGlossary();
};


/* ---- 图表页签 ---- */
async function renderAssets() {
  const pid = state.current?.id;
  if (!pid) { $('#content-view').innerHTML = '<p class="muted">选择论文后查看图表</p>'; return; }
  if (!state.assets) state.assets = await api(`/api/papers/${pid}/assets`);
  const {figures: rawFigures, tables: rawTables, formulas: rawFormulas} = state.assets;
  const figures = (rawFigures || []).filter(f => f.image_path);
  const tables = (rawTables || []).filter(t => (t.html && t.html.trim()) || t.bbox);
  const formulas = rawFormulas || [];
  if (!figures.length && !tables.length && !formulas.length) {
    $('#content-view').innerHTML = '<p class="muted">未提取到图表</p>'; return;
  }
  if (state.view !== 'assets' || state.current?.id !== pid) return;   // 用户已切走：丢弃迟到渲染

  /* IvySCI 式布局：图表(混排)/公式 二级页签；条目按页分组，页头点击跳 PDF。
     混排排序 = (页码, bbox y0)——保持论文内的视觉顺序。 */
  const merged = [
    ...figures.map(f => ({kind: 'fig', page: f.page_index, y: (f.bbox || [0, 9])[1], f})),
    ...tables.map(t => ({kind: 'tbl', page: t.page_index, y: (t.bbox || [0, 9])[1], t})),
  ].sort((a, b) => a.page - b.page || a.y - b.y);
  const groups = [];
  for (const it of merged) {
    let g = groups[groups.length - 1];
    if (!g || g.page !== it.page) { g = {page: it.page, items: []}; groups.push(g); }
    g.items.push(it);
  }
  const eqGroups = [];
  for (const eq of formulas) {
    let g = eqGroups[eqGroups.length - 1];
    if (!g || g.page !== eq.page_index) { g = {page: eq.page_index, items: []}; eqGroups.push(g); }
    g.items.push(eq);
  }

  const capHtml = (cap, id) => cap ? `
    <p class="asset-cap" id="${id}">${esc(cap)}</p>
    ${cap.length > 120 ? `<a href="#" class="asset-cap-toggle" data-cap="${id}">展开</a>` : ''}` : '';

  const itemHtml = it => {
    if (it.kind === 'fig') {
      const f = it.f;
      return `<div class="asset">
        ${f.label ? `<span class="asset-badge" onclick="jumpEvidence(${f.page_index})" title="跳到 PDF 该页">${esc(f.label)}</span>` : ''}
        <div class="fig-grid">
          <img loading="lazy" src="/api/papers/${pid}/images/${f.image_path.split('/').pop()}" ondblclick="lightbox(this.src, '')">
          ${(f.extra_images || []).map(p => `<img loading="lazy" src="/api/papers/${pid}/images/${p.split('/').pop()}" ondblclick="lightbox(this.src, '')">`).join('')}
        </div>
        ${(f.sub_captions || []).length ? `<p class="muted" style="font-size:11px">${esc(f.sub_captions.join(' | ').slice(0, 200))}</p>` : ''}
        ${capHtml(f.caption || '', `cap-${f.page_index}-${(f.image_path || '').replace(/\W/g, '')}`)}
      </div>`;
    }
    const t = it.t;
    return `<div class="asset">
      ${t.label ? `<span class="asset-badge" onclick="jumpEvidence(${t.page_index})">${esc(t.label)}</span>` : ''}
      ${t.bbox ? `<figure class="fig-crop" data-page="${t.page_index}" data-ub='${JSON.stringify(t.bbox)}'>
        <div class="fig-holder">${t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : ''}</div>
      </figure>` : (t.html ? `<div class="tbl">${sanitizeTbl(t.html)}</div>` : '')}
      ${capHtml(t.caption || '', `cap-t-${t.page_index}-${Math.round((t.bbox || [0, 0])[1] * 1000)}`)}
    </div>`;
  };

  const eqHtml = g => g.items.map(eq => {
    const tex = (eq.latex || '').trim();
    let r = null;
    if (state.katex && tex) { try { r = state.katex.renderToString(tex, {throwOnError: false, displayMode: true, strict: false, trust: true}); } catch {} }
    return `<div class="asset eq-asset" onclick="jumpEvidence(${eq.page_index})" title="跳到 PDF 该页">
      ${r ? r : `<code>${esc(tex.slice(0, 400))}</code>`}
    </div>`;
  }).join('');

  const tab = state.assetsTab || 'figs';
  const figsN = merged.length, eqsN = formulas.length;
  // 页签在次级工具条上（与原文/双语/中文同一行、同尺寸），这里只刷新计数与态
  $$('#assets-subtabs .asset-sub').forEach(b => {
    b.classList.toggle('on', b.dataset.at === tab);
    b.textContent = b.dataset.at === 'figs' ? `图表 (${figsN})` : `公式 (${eqsN})`;
    b.onclick = () => { state.assetsTab = b.dataset.at; renderAssets(); };
  });
  $('#content-view').innerHTML = `
    ${tab === 'figs'
      ? (merged.length ? groups.map(g => `
          <div class="asset-page">
            <div class="asset-page-head" onclick="jumpEvidence(${g.page})" title="跳到 PDF 该页">${icon('doc')} 第 ${g.page + 1} 页 <span class="muted">${g.items.length} 项 ${icon('arrowR', 11)}</span></div>
            ${g.items.map(itemHtml).join('')}
          </div>`).join('')
        : '<p class="muted" style="padding:12px">未提取到图表</p>')
      : (formulas.length ? eqGroups.map(g => `
          <div class="asset-page">
            <div class="asset-page-head" onclick="jumpEvidence(${g.page})" title="跳到 PDF 该页">${icon('doc')} 第 ${g.page + 1} 页 <span class="muted">${g.items.length} 式 ${icon('arrowR', 11)}</span></div>
            ${eqHtml(g)}
          </div>`).join('')
        : '<p class="muted" style="padding:12px">未提取到公式</p>')}
  `;
  // 题注展开/收起
  $$('.asset-cap-toggle', $('#content-view')).forEach(a => a.onclick = e => {
    e.preventDefault();
    const cap = $(`#${a.dataset.cap}`);
    const open = cap.classList.toggle('open');
    a.textContent = open ? '收起' : '展开';
  });
  figCropPass();
}

/* ---- 导读绘制（气泡/整栏两用） ----
   引文编号按字段独立（[1][2][3]），悬停显示"第 X 页 · 原文片段"，点击跳页。
   不再在底部铺一长串证据列表——那是各字段引用的并集，纯噪音。 */
function drawSummary(s, pid, target = '#content-view', asBubble = false) {
  const t = $(target);
  const sec = Object.entries(s.sections || {});
  const evById = new Map((s.evidence || []).map(e => [String(e.evidence_id), e]));
  const citeMap = s.cite_map || {};
  const secHtml = sec.map(([k, v]) => {
    const local = citeMap[k] || {};
    const html = mdLite(v).replace(/\[(\d{1,3})\]/g, (m, n) => {
      const gid = local[n];
      const ev = gid != null ? evById.get(String(gid)) : null;
      if (!ev) return m;                                   // 无对应证据 → 留原文
      const tip = `第${ev.page_index + 1}页 · ${(ev.text || '').slice(0, 120).replace(/\s+/g, ' ')}`;
      return `<span class="cite" data-gid="${gid}" title="${esc(tip)}">[${n}]</span>`;
    });
    return `<div class="summary-sec"><h3>${SUMMARY_NAMES[k] || k}</h3><p>${html}</p></div>`;
  }).join('');
  t.innerHTML = (asBubble ? (state._sumHead || '') + '<div class="msg assistant"><div class="bubble" style="width:100%">' : '<div class="card">') +
    (asBubble ? `<b title="${esc(state._sumTip || '')}">${icon('copy')} 导读</b>` : '<h2>科研导读</h2>') +
    (sec.length ? secHtml : '<p class="muted">导读内容为空，请重新生成。</p>') +
    `</div>${asBubble ? '</div>' : ''}<button class="btn small" onclick="genSumBubble('${pid}')">${icon('retry')} 重新生成</button>`;
  if (asBubble) t.insertAdjacentHTML('beforeend', followupButtons(s.sections));
  $$('.cite[data-gid]', t).forEach(el => {
    const ev = evById.get(String(el.dataset.gid));
    if (ev) { el._ev = ev; el.onclick = () => jumpToEvidence(ev); }
  });
}

/* ---- 对话导出 ---- */
window.copyJson = () => copyText(JSON.stringify(state.blocks, null, 2), 'JSON');
function exportChat() {
  if (!state.qaSession) { toast('当前还没有对话记录'); return; }
  location.href = `/api/chat/sessions/${state.qaSession}/export`;
}
window.exportChat = exportChat;   // 兼容内联 onclick 调用


/* ---- 📚 文库管理页（左库树 + 右条目 + 详情，参考 Zotero/EndNote 的下钻式） ---- */
state.libSel = localStorage.getItem('ps-lib-sel') || '';   // '' = 全部文献
state.libPaper = '';                                        // 详情面板选中的论文
state.scope = '';                                           // 侧栏快捷范围筛选
state.libQuery = '';                                        // 管理页搜索词
state.libLevel = 1;                                         // 管理页层级: 1=库列表 2=库内
state.libView = 'card';                                     // 库列表视图: card | list
state._libQTimer = 0;

function libDescendants(cid, list) {   // 含自身 + 全部子孙
  const out = [cid];
  const kids = (list || state.collections).filter(c => c.parent_id === cid);
  for (const k of kids) out.push(...libDescendants(k.id, list));
  return out;
}
window.selectLib = cid => {
  state.libSel = cid;
  state.libPaper = '';
  state.libLevel = 2;                 // 进第二层：库内（子库+论文）
  localStorage.setItem('ps-lib-sel', cid);
  renderCollectionsPage();
};
window.libGoL1 = () => {              // 返回第一层：库列表
  state.libLevel = 1; state.libSel = ''; state.libPaper = '';
  renderCollectionsPage();
};
window.libOpenLib = cid => {          // 第一层点库 → 进第二层
  state.libSel = cid; state.libPaper = ''; state.libLevel = 2;
  renderCollectionsPage();
};
window.selectLibPaper = pid => {
  state.libPaper = state.libPaper === pid ? '' : pid;
  renderCollectionsPage();
};
window.libSearch = q => { state.libQuery = q.trim(); renderCollectionsPage(); };

async function renderCollectionsPage(preset = null) {
  const d = preset || await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  state._statuses = (await api('/api/statuses')).statuses;
  const el = $('#page-collections');
  if (state.libLevel === 1) {           // 第一层：库列表
    el.innerHTML = libLevel1Html(d);
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
  const papers = (await api('/api/papers' + (scopeIds.length
      ? '?collection_id=' + scopeIds.join(',') : ''))).papers;
  const shown = q ? papers.filter(p => (p.title || '').toLowerCase().includes(q)
                                  || (p.authors || '').toLowerCase().includes(q)) : papers;
  const doneTr = papers.filter(p => st[p.id]?.translate_job?.status === 'done').length;
  const totTok = papers.reduce((s, p) => s + ((st[p.id]?.tokens?.p || 0) + (st[p.id]?.tokens?.c || 0)), 0);

  const moveOpts = exclude => d.collections.filter(x => x.id !== exclude)
    .map(x => `<option value="${x.id}">${'\u3000'.repeat(treeDepth(x.id))}${esc(x.name)}</option>`).join('');

  // ---- 左栏：库树 ----
  const treeRow = (c, depth) => {
    const kids = children[c.id] || [];
    const open = openState(c.id);
    const n = c.papers_total ?? c.papers ?? 0;
    return `<div class="lib-sel ${sel === c.id ? 'on' : ''}" onclick="selectLib('${c.id}')">
        <span class="lib-sel-name" style="padding-left:${6 + depth * 14}px">
          ${kids.length ? `<button class="col-arrow ${open ? '' : 'closed'}" onclick="event.stopPropagation();toggleColOpen('${c.id}')">${open ? icon('chevD') : icon('chevR')}</button>` : '<span class="col-arrow-none"></span>'}
          ${icon('folder')} ${esc(c.name)}</span>
        <span class="lib-sel-n">${n}</span>
      </div>` + (open ? kids.map(k => treeRow(k, depth + 1)).join('') : '');
  };
  const sideTree = `<div class="lib-side">
      <div class="lib-sel ${sel === '' ? 'on' : ''}" onclick="selectLib('')">
        <span class="lib-sel-name">${icon('library')} 全部文献</span><span class="lib-sel-n">${d.total}</span></div>
      ${(children['root'] || []).map(c => treeRow(c, 0)).join('')}
      ${d.collections.length ? '' : '<p class="muted" style="padding:10px 12px">还没有文献库</p>'}
    </div>`;

  // ---- 右栏：选中库的论文表 ----
  const paperRows = shown.map(p => {
    const s = st[p.id] || {};
    const tj = s.translate_job;
    const parseBadge = s.parsing ? "<span class=\"badge run\">" + icon('clock', 12) + "解析</span>"
      : p.parse_status === 'parsed' ? "<span class=\"badge ok\">" + icon('check') + "</span>"
      : "<span class=\"badge err\">" + icon('close') + "</span>";
    const trBadge = s.translating ? `<span class="badge run">${icon('globe')}${tj ? tj.done + '/' + tj.total : ''}</span>`
      : tj?.status === 'done' ? "<span class=\"badge ok\">译" + icon('check') + "</span>"
      : tj?.status === 'failed' ? "<span class=\"badge err\">译" + icon('close') + "</span>" : '<span class="muted">—</span>';
    const tk = s.tokens;
    const owner = d.collections.find(c => c.id === p.collection_id);
    return `<tr class="lib-paper-row ${state.libPaper === p.id ? 'on' : ''}" onclick="selectLibPaper('${p.id}')">
        <td style="width:26px" onclick="event.stopPropagation()"><input type="checkbox" class="lib-ck" data-cid="${scopeKey}" data-pid="${p.id}" onchange="libCk('${scopeKey}')"></td>
        <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis" title="${esc(p.title || '')}">
          ${esc(p.title || p.id)}
          ${owner && scopeIds.length > 1 ? `<span class="muted" style="font-size:11px"> · ${esc(owner.name)}</span>` : ''}</td>
        <td>${parseBadge}${p.parse_status === 'failed' ? `<button class="btn small" onclick="event.stopPropagation();retryPaperJob('${p.id}')">${icon('retry')}</button>` : ''}</td>
        <td>${trBadge}</td>
        <td class="muted" style="font-size:11px">${tk ? (tk.p + tk.c).toLocaleString() + ' tok' : ''}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <button class="btn small" onclick="viewPaper('${p.id}')">阅读</button>
          <select style="width:auto;font-size:11px;padding:2px 4px" onchange="movePaper('${p.id}', this.value, this)">
            <option value="">移入…</option>${moveOpts(p.collection_id)}</select>
          <button class="btn small danger" onclick="delPaperFromLib('${p.id}')">删</button>
        </td></tr>`;}).join('');

  // ---- 详情面板（选中论文的完整元数据）----
  const pd = state.libPaper ? papers.find(p => p.id === state.libPaper) : null;
  const detail = pd ? (() => {
    const s = st[pd.id] || {};
    const tj = s.translate_job;
    const kv = [
      ['作者', pd.authors], ['年份', pd.year], ['期刊', pd.journal], ['DOI', pd.doi],
      ['关键词', pd.keywords], ['页数', pd.page_count], ['大小', pd.file_size ? (pd.file_size / 1048576).toFixed(1) + ' MB' : ''],
      ['可见性', pd.visibility === 'private' ? icon('lock') + " 仅自己可见" : icon('globe') + " 共享"],
      ['解析', pd.parse_status], ['翻译', tj?.status === 'done' ? `已完成（${tj.model || ''}）` : (tj?.status || '未翻译')],
      ['所属库', d.collections.find(c => c.id === pd.collection_id)?.name || '—'],
      ['加入时间', (pd.created_at || '').slice(0, 16)], ['ID', pd.id],
    ].filter(x => x[1]);
    return `<div class="lib-detail">
      <div class="ld-title">${esc(pd.title || pd.id)}</div>
      <div class="muted" style="font-size:11px;margin-bottom:6px">当前选中</div>
      <div class="ld-kv">${kv.map(([k, v]) =>
        `<div><span class="ld-k">${k}</span><span class="ld-v">${esc(String(v))}</span></div>`).join('')}</div>
      ${pd.abstract ? `<div class="ld-sec">摘要</div><div class="ld-abs">${esc(pd.abstract)}</div>` : ''}
      <div class="ld-actions">
        <button class="btn small primary" onclick="viewPaper('${pd.id}')">${icon('book')} 阅读</button>
        <button class="btn small" onclick="copyCite('${pd.id}')">复制引用</button>
      </div></div>`;
  })() : '';

  // ---- 组装 ----
  const selName = sel ? (d.collections.find(c => c.id === sel)?.name || '') : '';
  const selNameArg = selName.replace(/'/g, "\\'");   // 塞进内联 onclick 的单引号参数
  el.innerHTML = `
    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">文献库管理</h2>
      <input id="lib-mgr-q" placeholder="搜索论文标题/作者…" style="max-width:200px" value="${esc(state.libQuery)}">
      <input id="newlib-name" placeholder="新库名称" style="max-width:150px">
      <button class="btn primary" onclick="createLibFromPage()">${icon('plus')} 新建库</button>
      <button class="btn" onclick="exportBibtex()" title="导出全库为 BibTeX（Zotero/EndNote 可直接导入）">⬇ BibTeX</button>
    </div>
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
          <h2 style="margin:0;flex:1">${sel ? icon('folder') : icon('library')} ${esc(scopeName)}
            <span class="muted" style="font-size:12px">${papers.length} 篇${scopeIds.length > 1 ? '（含子库）' : ''} · 译${doneTr}/${papers.length} · ${totTok.toLocaleString()}tok</span></h2>
          ${sel ? `<button class="btn small primary" onclick="libUpload('${sel}')">${icon('upload')} 上传</button>
          <button class="btn small" onclick="addSubLib('${sel}')" ${treeDepth(sel) >= 2 ? 'disabled title="最多三级"' : ''}>${icon('plus')}子库</button>
          <button class="btn small" onclick="renameLib('${sel}', '${selNameArg}')">${icon('edit')}</button>
          <button class="btn small danger" onclick="delLib('${sel}', '${selNameArg}')">${icon('trash')}</button>` : ''}
        </div>
        ${subLibs.length ? `<div class="lib-subbar">
          <span class="muted" style="font-size:12px">子库：</span>
          ${subLibs.map(k => `<span class="chip" onclick="libOpenLib('${k.id}')" style="cursor:pointer">${icon('folder')} ${esc(k.name)} · ${k.papers ?? 0} 篇</span>`).join('')}
        </div>` : ''}
        <div class="lib-batch" id="lb-${scopeKey}" hidden>
          <span id="lb-count-${scopeKey}">0</span> 篇选中
          <button class="btn small primary" onclick="libBatchTranslate('${scopeKey}')">${icon('globe')} 批量翻译</button>
          <select style="width:auto;font-size:12px" onchange="libBatchMove('${scopeKey}', this.value, this)"><option value="">移入…</option>${moveOpts(sel)}</select>
          <button class="btn small danger" onclick="libBatchDelete('${scopeKey}')">删除</button>
        </div>
        <div class="lib-split">
          <div class="lib-list">
            <table class="list lib-table"><tr><th style="width:26px"><input type="checkbox" class="lib-ck-all" data-cid="${scopeKey}" title="全选" onchange="libCkAll('${scopeKey}', this.checked)"></th><th>论文</th><th>析</th><th>译</th><th>用量</th><th></th></tr>
              ${paperRows || `<tr><td colspan="6" class="muted">${q ? '没有匹配的论文' : '空库'}</td></tr>`}</table>
          </div>
          <aside class="lib-side-detail">
            ${detail || '<p class="muted" style="padding:12px">点击左侧论文行查看详情</p>'}
          </aside>
        </div>
      </div>`;

  // 搜索框：输入去抖后重渲染，并恢复焦点与光标（否则每敲一个字就失焦）
  const qIn = $('#lib-mgr-q');
  if (qIn) {
    qIn.oninput = e => {
      state.libQuery = e.target.value;
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
window.toggleColOpen = cid => {
  const s = JSON.parse(localStorage.getItem('ps-col-open') || '{}');
  s[cid] = s[cid] === false ? true : false;
  localStorage.setItem('ps-col-open', JSON.stringify(s));
  renderCollections();          // 侧栏树
  if ($('#page-collections') && $('#page-collections').style.display !== 'none') renderCollectionsPage().catch(() => {});
};

function libSelected(cid) {
  return $$('.lib-ck').filter(x => x.dataset.cid === cid && x.checked).map(x => x.dataset.pid);
}
window.libCk = cid => {
  const n = libSelected(cid).length;
  $('#lb-' + cid).hidden = !n;
  $('#lb-count-' + cid).textContent = n;
  // 总复选框：随行勾选联动（全选 / 半选 / 未选）
  const all = document.querySelector(`.lib-ck-all[data-cid="${cid}"]`);
  if (all) {
    const boxes = $$(`.lib-ck[data-cid="${cid}"]`);
    all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    all.indeterminate = n > 0 && !all.checked;
  }
};
window.libCkAll = (cid, on) => {
  $$(`.lib-ck[data-cid="${cid}"]`).forEach(x => x.checked = on);
  libCk(cid);
};
window.libBatchTranslate = async cid => {
  const ids = libSelected(cid);
  await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: ids})});
  toast(`已加入翻译队列 ${ids.length} 篇`); await refreshLib();
};
window.libBatchMove = async (cid, v, sel) => {
  if (!v) return;
  const target = v === '__none__' ? null : v;
  for (const pid of libSelected(cid)) await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: target})});
  toast('已移动'); sel.value = ''; await refreshLib();
};
window.libBatchDelete = async cid => {
  const ids = libSelected(cid);
  if (!(await uiConfirm(`删除选中的 ${ids.length} 篇？（进回收站）`, {title: '批量删除'}))) return;
  for (const pid of ids) await api('/api/papers/' + pid, {method: 'DELETE'});
  toast('已移入回收站'); await refreshLib();
};
window.libUpload = cid => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf';
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
  const name = $('#newlib-name').value.trim();
  if (!name) { toast('请输入库名'); return; }
  await api('/api/collections', {method: 'POST', body: JSON.stringify({name})});
  $('#newlib-name').value = '';
  toast('已创建'); await refreshLib();
};
window.movePaper = async (pid, v, sel) => {
  if (!v) return;
  const cid = v === '__none__' ? null : v;
  await api('/api/papers/' + pid, {method: 'PATCH', body: JSON.stringify({collection_id: cid})});
  toast('已移动'); await refreshLib();
};
window.delPaperFromLib = async pid => {
  if (!(await uiConfirm(`删除这篇论文？（进回收站，${state.health.trash_days || 30} 天内可恢复）`, {title: '移入回收站'}))) return;
  await api('/api/papers/' + pid, {method: 'DELETE'});
  toast('已移入回收站'); await refreshLib();
};
window.viewPaper = pid => { switchPage('reader'); openPaper(pid); };


/* 图片灯箱预览 */
window.lightbox = (src, caption) => {
  let lb = $('#ps-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ps-lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `<img><p class="lb-cap"></p><button class="lb-close">${icon('close')}</button>`;
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
    toast('已移入回收站');
    if (state.current?.id === pid) { state.current = null; state.blocks = []; renderContentView(); }
    state.qaPapers.delete(pid);
    await refreshLib();
  } catch (e) { toast(e.message); }
};

/* 导读后的追问建议 */
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
  const qs = Object.keys(sections || {}).map(k => FOLLOWUP_QS[k]).filter(Boolean).slice(0, 5);
  if (!qs.length) return '';
  return `<div class="followups"><span class="muted" style="font-size:12px">${icon('chat')} 可以接着问：</span>` +
    qs.map(q => `<button class="chip chip-q" onclick="askPreset('${esc(q).replace(/'/g, "\\'")}')">${esc(q)}</button>`).join('') +
    `</div>`;
}

/* ================= 四项借鉴功能 ================= */

/* ---- ① 划词工具条（右侧原文/译文区） ---- */
(() => {
  let bar = null, lastSel = null;
  const ensureBar = () => {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'sel-bar'; bar.hidden = true;
    bar.innerHTML = `<button data-a="ask">${icon('chat')} 提问</button><button data-a="cp">${icon('copy')} 复制</button>`;
    document.body.appendChild(bar);
    bar.onclick = e => {
      const b = e.target.closest('button'); if (!b || !lastSel) return;
      const {text, page} = lastSel;
      if (b.dataset.a === 'cp') { copyText(text, '选中文字'); hideBar(); return; }
      setQuote(text, page);   // 引用独立成块，输入框留给问题
      hideBar();
    };
    return bar;
  };
  const hideBar = () => { if (bar) bar.hidden = true; };
  document.addEventListener('mouseup', e => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    const inContent = e.target.closest && (e.target.closest('#content-view') || e.target.closest('.qa-msgs') || e.target.closest('#pdf-host'));
    if (!text || text.length < 2 || !inContent) { hideBar(); return; }
    const blk = e.target.closest('.blk');
    lastSel = {text, page: blk ? +blk.dataset.page : (state.pageNum - 1)};
    const b = ensureBar();
    b.hidden = false;
    const x = Math.min(e.clientX, innerWidth - 260), y = e.clientY - 44;
    b.style.left = Math.max(8, x) + 'px'; b.style.top = Math.max(8, y) + 'px';
  });
  document.addEventListener('mousedown', e => { if (bar && !bar.contains(e.target)) hideBar(); });
  window._hideSelBar = hideBar;
})();

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
        <span class="muted" style="font-size:11px">· 第${ev.page_index + 1}页</span>
        <div style="margin-top:4px">${esc(snippet.slice(0, 220))}${snippet.length > 220 ? '…' : ''}</div>
        <div class="muted" style="font-size:11px;margin-top:4px">${icon('doc')} 点击定位原文</div>`;
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
      <div class="muted" style="font-size:11px;margin-top:4px">${icon('doc')} 第${ref.page_index + 1}页 · 点击跳转</div>`;
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
    document.addEventListener('click', e => {
      if (!t.hidden && !t.contains(e.target) && e.target.id !== 'toc-btn') t.hidden = true;
    });
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
      <div class="fig-holder">${fb.map(n => `<img loading="lazy" src="/api/papers/${pid}/images/${n}">`).join('')}</div>
      ${caps.length ? `<figcaption class="muted" style="font-size:11.5px;line-height:1.5">${esc(caps.join(' ｜ ').slice(0, 300))}</figcaption>` : ''}
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
      ${ta && ta.caption ? `<figcaption class="muted" style="font-size:11.5px;line-height:1.5">${esc(ta.caption.slice(0, 200))}</figcaption>` : ''}
    </figure>`;
  }
  return katexify(linkifyRefs(esc(b.en !== undefined ? b.en : b.text)));
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
  window._hoverClear = clear;
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
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => applyVsplit(), 250); });
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
  if (t) t.placeholder = '对着左侧文章提问…（Ctrl+Enter 发送）';
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
      holder.innerHTML = `<img src="${url}" ondblclick="lightbox(this.src, '')">`;
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

window.retranslatePaper = async pid => {
  if (!(await uiConfirm('用当前模型/术语表重新翻译，生成新版本？（消耗 token，旧版本保留）', {title: '强制重译', danger: false}))) return;
  await api('/api/papers/translate', {method: 'POST',
    body: JSON.stringify({paper_ids: [pid], force_new_version: true})});
  toast('重译已入队（完成后自动展示最新版）');
};

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
  for (const sel of ['#acc-pop', '#filter-pop', '#upload-pop', '#download-pop',
                     '#queue-pop', '#qa-picker-pop', '#col-new-form', '#health-pop']) {
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
  if (!(await uiConfirm('所有已删除论文（含译文/索引/会话）将永久移除，不可恢复。', {title: '彻底清空回收站', okText: '清空'}))) return;
  const r = await api('/api/trash/empty', {method: 'POST'});
  toast(`已彻底删除 ${r.purged} 篇`);
  renderTrash(); await refreshLib();
};

window.exportBibtex = () => {
  location.href = '/api/export/bibtex';
  toast('开始下载 BibTeX（Zotero/EndNote 可直接导入）');
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
        <div class="lc1-name">${esc(c.name)}</div>
        <div class="lc1-meta">${papers} 篇${kids.length ? ` · ${kids.length} 个子库` : ''}${doneTr ? ` · 已译 ${doneTr}` : ''}</div>
        ${kids.length ? `<div class="lc1-subs">${kids.map(k =>
          `<span class="lc1-sub" onclick="event.stopPropagation();libOpenLib('${k.id}')">${icon('folder')} ${esc(k.name)} <b>${k.papers ?? 0}</b></span>`).join('')}</div>` : ''}
      </div>
      <div class="lc1-ops" onclick="event.stopPropagation()">
        <button class="btn small" onclick="libUpload('${c.id}')" title="上传到此库">${icon('upload')}</button>
        <button class="btn small" onclick="addSubLib('${c.id}')" ${depth >= 2 ? 'disabled title="最多三级"' : ''} title="新建子库">${icon('plus')}</button>
        <button class="btn small" onclick="renameLib('${c.id}', '${esc(c.name).replace(/'/g, "\\'")}')" title="重命名">${icon('edit')}</button>
        <button class="btn small danger" onclick="delLib('${c.id}', '${esc(c.name).replace(/'/g, "\\'")}')" title="删除库">${icon('trash')}</button>
      </div>
    </div>`;
  };
  const cards = (children['root'] || []).map(c => cardOf(c, false)).join('');
  const total = d.total;
  return `<div class="card lib-l1-head">
      <h2 style="margin:0;flex:1">📚 全部文献库 <span class="muted" style="font-size:12px">${d.collections.length} 个库 · ${total} 篇论文</span></h2>
      <div class="seg">
        <button class="seg-btn ${state.libView === 'card' ? 'on' : ''}" onclick="setLibView('card')">卡片</button>
        <button class="seg-btn ${state.libView === 'list' ? 'on' : ''}" onclick="setLibView('list')">列表</button>
      </div>
    </div>
    ${state.libView === 'card'
      ? `<div class="lib-cards">${cards || '<p class="muted" style="padding:16px">还没有文献库——点上方「新建库」</p>'}</div>`
      : `<div class="card"><table class="list">
          <tr><th>库名</th><th>论文</th><th>子库</th><th></th></tr>
          ${(() => {
            // 树序遍历（父库紧跟其子库，缩进才对得上层级）——原先按 API 返回顺序平铺，
            // 子库排在前一个兄弟后面时会被误看成它的子库
            const kidsOf = cid => (children[cid] || [])
              .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
            const ordered = [];
            const walk = cid => { for (const k of kidsOf(cid)) { ordered.push(k); walk(k.id); } };
            walk('root');
            if (!ordered.length) return '<tr><td colspan="4" class="muted">还没有库</td></tr>';
            return ordered.map(c => `<tr class="lib-row" onclick="libOpenLib('${c.id}')">
              <td>${'　'.repeat(treeDepth(c.id))}${icon('folder')} ${esc(c.name)}</td>
              <td>${c.papers ?? 0}</td><td>${(children[c.id] || []).length}</td>
              <td class="row-actions" onclick="event.stopPropagation()">
                <button class="btn small" onclick="libUpload('${c.id}')">${icon('upload')}</button>
                <button class="btn small" onclick="renameLib('${c.id}', '${esc(c.name).replace(/'/g, "\\'")}')">${icon('edit')}</button>
              </td></tr>`).join('');
          })()}
        </table></div>`}`;
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
      // 浮动定位（fixed）：工具条 overflow-x:auto 会把 absolute 弹层裁掉——原先整框被剪到不可见
      const r = btn.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
      pop.style.left = 'auto';
    }
  });
  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true;
  });
  $$('#download-pop .tp-item[data-dl]').forEach(it => it.addEventListener('click', () => {
    const fmt = it.dataset.dl;
    const pid = state.current?.id;
    if (!pid) { toast('请先打开一篇论文'); return; }
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
