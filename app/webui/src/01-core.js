/* ===== 01-core.js —— 基础设施：state/api/toast/对话框/图标/健康检查 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
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
  cmdtags: [],            // 自定义命令标签（服务端 settings 存储；内置标签在代码里）
  qaHistory: [],          // 问答输入历史（↑↓ 回溯）
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
/* 相对时间（任务中心用）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 绝对日期 */
function relTime(s) {
  if (!s) return '';
  const iso = String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z');
  const t = new Date(iso).getTime();
  if (!t || isNaN(t)) return fmtTime(s);
  const d = Date.now() - t;
  if (d < 0) return fmtTime(s);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  return fmtTime(s);
}

/* 统一时间格式：MM-DD HH:MM（同年内）/ YYYY-MM-DD HH:MM（跨年）；空值 → — */
function fmtTime(s) {
  if (!s) return '—';
  const t = s.slice(0, 16).replace('T', ' ');
  return t.length >= 16 ? t.slice(5, 16) : t;
}
/* 公共防抖（原先 7 处各自 clearTimeout+setTimeout 手写，行为微妙不一致） */
function debounce(fn, ms = 300) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let _toastTimer = 0;
function toast(msg, ms = 0, action = null) {
  const t = $('#toast');
  // action = {label:'撤销', onClick:fn} —— 破坏性操作后给一条反悔路
  const text = String(msg || '');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  t.appendChild(span);
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { hide(); try { action.onClick?.(); } catch (e) { console.error(e); } };
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(_toastTimer);   // 连续触发时旧 timer 会让后一条提前消失
  const dur = ms || (action ? Math.max(text.length > 30 ? 5000 : 2500, 6000)
                            : text.length > 80 ? 8000 : text.length > 30 ? 5000 : 2500);
  _toastTimer = setTimeout(hide, dur);
  function hide() { t.classList.remove('show'); }
}

/* 写操作统一包装：期间禁用按钮（防连点/重复提交）+ 捕获异常并给友好提示 */
async function withBusy(btn, fn, failMsg) {
  const el = btn && btn.tagName === 'BUTTON' ? btn : null;
  const old = el ? el.innerHTML : '';
  if (el) { el.disabled = true; el.innerHTML = '<span class="spin"></span> 处理中…'; }
  try {
    await fn();
  } catch (e) {
    toast(friendlyError(e, failMsg || '操作失败，请重试'));
  } finally {
    if (el) { el.disabled = false; el.innerHTML = old; }
  }
}

/* 用户可见错误：把技术异常翻译成「发生了什么 + 下一步做什么」，
   原始信息只进 console（排障用），不让用户看到 ConnectionError / HTTP 502 这类黑话。 */
window.friendlyError = friendlyError;
function friendlyError(e, fallback) {
  const raw = String(e?.message || e || '');
  const msg = raw.toLowerCase();
  if (/429|rate limit|额度|余额|too many requests/.test(msg))
    return '请求太频繁或额度已用尽，请稍后再试；若是额度问题可在「设置 → 我的用量」查看';
  if (/401|未登录|登录/.test(msg))
    return '登录状态已失效，请重新登录';
  if (/403|无权|权限|仅管理员/.test(msg))
    return '没有权限执行该操作，请联系管理员';
  if (/no ?key|未配置.*key|key.*未配置/.test(msg))
    return '尚未配置 LLM key，请到「设置 → AI 模型」填写后再试';
  if (/404|not found|不存在/.test(msg))
    return '目标不存在或已被删除';
  if (/connection|connect|网络|timeout|超时|refused|abort/.test(msg))
    return '连接不上服务（网络或后端未响应），请稍后重试';
  if (/5\d\d|internal|服务器/.test(msg))
    return '服务出错了，请稍后重试；若持续出现请查看任务中心';
  if (/llm api/.test(msg))
    return '模型接口报错——可能是 key 无效、额度不足或模型名不对，请到「设置 → AI 模型」用「测试」验证';
  return fallback || '操作失败，请重试';
}

/* 复制到剪贴板：clipboard API 仅安全上下文（HTTPS/localhost）可用——
   局域网 http://192.168.x.x 访问时是 undefined，必须走 execCommand 兜底 */
window.copyText = async text => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
};

/* ---- 统一弹窗（替代原生 confirm/prompt；MinerU 式轻量浮层） ----
   uiConfirm(msg, {title, okText, cancelText, danger, anchor}) → Promise<bool>
   uiPrompt(title, {value, placeholder, okText, anchor})       → Promise<string|null>
   uiPassword(title, password)                                  → Promise<void>（展示+复制）
   anchor 给定时锚定弹出（无遮罩，点外/Esc 取消）；否则居中浮卡 + 半透明遮罩。
   _uiStack：弹窗栈——叠加时仅栈顶响应键盘（防止一次 Esc/Enter 连带确认底层 danger 框） */
const _uiStack = [];
function _uiDialog({title, message = '', input = false, value = '', placeholder = '',
                    okText = '确定', cancelText = '取消', danger = false, anchor = null,
                    copyText = '', hideCancel = false, multiline = false, html = false}) {
  return new Promise(resolve => {
    const backdrop = anchor ? null : Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
    const pop = Object.assign(document.createElement('div'), {className: 'ui-pop' + (danger ? ' danger' : '')});
    const inputHtml = !input ? '' : multiline
      ? `<textarea class="ui-pop-input" rows="9" placeholder="${esc(placeholder || '')}">${esc(value)}</textarea>`
      : `<input class="ui-pop-input" value="${esc(value)}" placeholder="${esc(placeholder || '')}">`;
    pop.innerHTML = `
      <div class="ui-pop-title">${html ? title : esc(title)}${copyText ? `<button class="btn small" data-copy>${icon('copy')} 复制</button>` : ''}</div>
      ${message ? `<div class="ui-pop-msg">${html ? message : esc(message)}</div>` : ''}
      ${inputHtml}
      <div class="ui-pop-foot">${hideCancel ? '' : `<button class="btn small" data-cancel>${esc(cancelText)}</button>`}
        <button class="btn small ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button></div>`;
    const inputVal = () => (pop.querySelector('.ui-pop-input') || {}).value ?? null;
    const done = val => {
      const i = _uiStack.indexOf(done);
      if (i >= 0) _uiStack.splice(i, 1);
      pop.remove(); backdrop?.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      if (onOut) document.removeEventListener('click', onOut, true);
      resolve(val);
    };
    _uiStack.push(done);   // 入栈在 done 定义后（TDZ）；叠加时仅栈顶响应键盘
    const onKey = e => {
      if (_uiStack[_uiStack.length - 1] !== done) return;   // 非栈顶不响应
      if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); }
      else if (e.key === 'Enter' && !e.isComposing && (!multiline || e.ctrlKey)) {
        e.preventDefault(); done(input ? inputVal() : true);
      }
    };
    // 锚定浮层是 fixed 定位：锚点随内容滚动会脱节——滚动/缩放直接关闭（所见即所点）
    const onScroll = () => { if (anchor && _uiStack[_uiStack.length - 1] === done) done(input ? null : false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
    pop.querySelector('[data-ok]').onclick = () => done(input ? inputVal() : true);
    const cancelBtn = pop.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.onclick = () => done(input ? null : false);
    if (copyText) pop.querySelector('[data-copy]').onclick = async () => {
      toast(await window.copyText(copyText) ? '已复制' : '复制失败，请手动选中');
    };
    let onOut = null;
    if (backdrop) {
      backdrop.onclick = () => done(input ? null : false);
      document.body.appendChild(backdrop);
    } else {
      onOut = function (e) {
        if (!pop.contains(e.target) && e.target !== anchor && !anchor?.contains?.(e.target)) {
          done(input ? null : false);
        }
      };
      document.addEventListener('click', onOut, true);
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
function esc(s) {
  // textContent→innerHTML 只转义 & < >，**不转义引号**——属性上下文（value="..."）会破防。
  // 补齐 " ' 的转义（正文与属性通用）。
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 内联 onclick 的 JS 字符串参数转义（先 JS 层再属性层；esc() 的 &#39; 会被
   HTML 解码回 ' 再进 JS 解析，两者叠加=互相抵消——含引号文本会让按钮语法错误）。
   顺序：反斜杠→单引号（JS 层）→ & → "（属性层，解码后还原为字面量）。 */
const fmtGB = b => (b || 0) / 1073741824;   // 字节 → GB（用量展示共用）
const jsArg = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/* ---- SVG 图标库（v1.2 起 UI 图标全 SVG 化；toast 消息文本中的 emoji 保留）----
   线条风格：16 viewBox / stroke 1.5 / 圆角端点 / currentColor 跟随文字色。 */
const ICONS = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevD: '<path d="M4 6l4 4 4-4"/>',
  chevL: '<path d="M10 3L5 8l5 5"/>',
  chevR: '<path d="M6 3l5 5-5 5"/>',
  dblL: '<path d="M7.5 4L3.5 8l4 4M11.5 4l-4 4 4 4"/>',
  dblR: '<path d="M8.5 4l4 4-4 4M4.5 4l4 4-4 4"/>',
  arrowR: '<path d="M3 8h10M9 4l4 4-4 4"/>',
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
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5h-7v7"/>',
  brain: '<path d="M8 2.5a2.5 2.5 0 00-2.5 2.5v.5A2 2 0 004 7.4V10a2 2 0 002 2h1v1.5h2V12h1a2 2 0 002-2V7.4a2 2 0 00-1.5-1.9V5A2.5 2.5 0 008 2.5z"/>',
  globe2: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2.3 2.8 2.3 8.2 0 11-2.3-2.8-2.3-8.2 0-11z"/>',
  tag2: '<path d="M2.5 3.5h4l6 6-3 3-6-6z"/><circle cx="5" cy="5" r=".8"/>',
  stack: '<rect x="2.5" y="3" width="8" height="8" rx="1.2"/><path d="M5.5 5.5h2M5.5 7.5h3"/>',
  inbox: '<path d="M2.5 9V5.5L5 3.5h6l2.5 2V9a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 9z"/><path d="M5.5 6.5h5"/>',
  doc: '<path d="M4 2.5h5.5L12.5 5.5V13.5h-8.5z"/><path d="M9.5 2.5v3h3"/>',
  folder: '<path d="M2.5 5a1 1 0 011-1h3.2l1.5 1.8h5.3a1 1 0 011 1v6.2a1 1 0 01-1 1h-10a1 1 0 01-1-1V5z"/>',
  library: '<path d="M3 13.5V3.5M6.3 13.5V3.5M9.6 13.5V3.5M2 13.5h12"/>',
  chat: '<path d="M2.5 5A1.5 1.5 0 014 3.5h8A1.5 1.5 0 0113.5 5v4A1.5 1.5 0 0112 10.5H7.5L4.5 13v-2.5H4A1.5 1.5 0 012.5 9V5z"/>',
  sliders: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.8"/><circle cx="10" cy="11" r="1.8"/>',
  star: '<path d="M8 2.5l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.7l-3.6 1.9.7-4L2.2 6.8l4-.6L8 2.5z"/>',
  lock: '<rect x="4" y="7" width="8" height="6.5" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 015 0V7"/>',
  bulb: '<path d="M6 13.5h4M6.3 11.2c0-2.2-1.8-2.7-1.8-4.7a3.5 3.5 0 017 0c0 2-1.8 2.5-1.8 4.7h-3.4z"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-3 2.6-4.2 5-4.2s4.4 1.2 5 4.2"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.5 8.5L13 3M11 3h2v2"/>',
  bolt: '<path d="M8.5 2L4 9h3l-.5 5L12 7H9l-.5-5z"/>',
  crown: '<path d="M3 11.5L2.5 5l3.5 2L8 3.5 10 7l3.5-2L13 11.5H3z"/>',
  chart: '<path d="M3 13.5V3M3 13.5h10M6.5 13.5V8M10 13.5V5.5"/>',
  note: '<path d="M3.5 3h9v7l-3 3h-6z"/><path d="M9.5 13v-3h3"/>',
  pin: '<path d="M8 13.5V9M8 9C6 9 4.5 7.8 4.5 5.8V3.5h7v2.3C11.5 7.8 10 9 8 9z"/>',
  tag: '<path d="M2.5 8.3V3.5h4.8l6 6-4.8 4.8-6-6z"/><circle cx="5.2" cy="5.2" r=".9"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10.5 10.5L13.5 13.5"/>',
  book: '<path d="M8 4.2C6.6 3 4.2 2.8 2.6 3.6v9c1.6-.8 4-.6 5.4.6 1.4-1.2 3.8-1.4 5.4-.6v-9C11.8 2.8 9.4 3 8 4.2z"/><path d="M8 4.2v9"/>',
  moon: '<path d="M13.2 9.7A5.7 5.7 0 016.3 2.8a5.7 5.7 0 106.9 6.9z"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/>',
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
setInterval(() => { if (!document.hidden) pollHealth(); }, 20000)   // 后台标签页暂停;

/* ---------------- 文献库 ---------------- */
state.collections = [];
state.currentCollection = '';
