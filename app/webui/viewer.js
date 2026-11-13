/* ============================================================
 * paper-system 前端主文件 —— 由 app/webui/src/*.js 拼接生成
 *   构建：python3 scripts/build-webui.py
 *   请勿直接编辑本文件；改 app/webui/src/ 下的分片后重新构建。
 * ============================================================ */
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
/* 弹窗基座：ui-backdrop + ui-pop 脚手架（Esc / 点外关闭统一；原先 8 处手写同款）。
   返回 {pop, close}，内容由调用方填充。 */
function openPop(className = '') {
  const backdrop = Object.assign(document.createElement('div'), {className: 'ui-backdrop'});
  const pop = Object.assign(document.createElement('div'), {className: 'ui-pop' + (className ? ' ' + className : '')});
  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  const close = () => { pop.remove(); backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  backdrop.onclick = e => { if (e.target === backdrop) close(); };
  return { pop, close };
}
/* 弹层锚定到按钮下方（fixed 定位——工具条 overflow-x:auto 会裁掉 absolute 弹层） */
function anchorPop(pop, btn, gap = 6) {
  const r = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (r.bottom + gap) + 'px';
  pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
  pop.style.left = 'auto';
}
/* 点外关闭浮层：点 pop 与任一触发钮之外 → hidden=true（原先 9 处手写同款监听） */
function outsideClose(pop, ...btns) {
  document.addEventListener('click', e => {
    if (pop.hidden || pop.contains(e.target) || btns.some(b => b && b.contains(e.target))) return;
    pop.hidden = true;
  });
}
/* POST 下载 blob 并触发保存（BibTeX/ZIP 导出共用） */
async function downloadBlob(url, payload, filename, okMsg) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
                              body: JSON.stringify(payload)});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: filename});
  a.click(); URL.revokeObjectURL(a.href);
  if (okMsg) toast(okMsg);
}
/* 进度细条（上传/解析/任务行共用，warn=true 转警示色） */
function progressBar(pct, warn = false, cls = 'up-bar', style = '') {
  return `<div class="${cls}"${style ? ` style="${style}"` : ''}><i style="width:${Math.min(100, pct || 0)}%${warn ? ';background:var(--warn)' : ''}"></i></div>`;
}
/* 前沿节流：ms 内只放行第一次调用（SSE 事件风暴/轮询兜底共用） */
function throttle(fn, ms = 2000) {
  let last = 0;
  return (...args) => { const now = Date.now(); if (now - last < ms) return; last = now; fn(...args); };
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
      pop.style.transform = 'none';   // 居中样式不再生效——锚定坐标按左上角计算
      requestAnimationFrame(() => {
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let x = Math.min(r.left, innerWidth - pw - 8);
        let y = r.bottom + 6;
        if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
        pop.style.left = Math.max(8, x) + 'px';
        pop.style.top = y + 'px';
        pop.style.visibility = '';
      });
    }
    // 非锚定模态的居中由 .ui-pop CSS 统一处理（left/top 50% + translate -50%；
    // 此前的 JS 居中写内联 left/top 会覆盖 CSS 且纵向偏上，已删）
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
  download: '<path d="M8 2.5v7.5M4.5 6.5L8 10l3.5-3.5M3 13.5h10"/>',
  pause: '<path d="M5.5 3v10M10.5 3v10"/>',
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
    (extra ? ` <span class="muted" style="font-size: var(--fs-xs)">${esc(extra)}</span>` : '') + `</div>`;
  pop.innerHTML =
    `<div class="hp-head">服务状态 <button class="btn small" id="hp-recheck">${icon('retry')} 重新检测</button></div>` +
    row('数据库', h.db) +
    row('解析服务（MinerU GPU）', h.mineru) +
    row('语义检索（embedding/rerank）', h.ai, (h.models || []).join(' / ')) +
    `<div class="muted" style="font-size:var(--fs-xs);margin-top:6px">刚刚检测</div>`;
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
/* ===== 02-library.js —— 文献库与侧栏：集合树/论文列表/上传导入/筛选 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
async function loadCollections(preset = null) {
  const d = preset || await api('/api/collections');
  state.collections = d.collections;
  state.totalPapers = d.total;
  state.unassignedCount = d.unassigned || 0;   // 未分库（含失效引用）——侧栏数字自洽
  state.sharedLibs = d.shared_libs || [];     // 他人库中的共享论文
  renderCollections();
}
function colDescendants(cid) {   // 不含自身的子孙 id（真身 libDescendants 在 11-libmgr，拼接同作用域）
  return libDescendants(cid).filter(id => id !== cid);
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
      ${kids.length ? `<span class="col-arrow" data-toggle="${c.id}">${open ? icon('chevD') : icon('chevR')}</span>` : '<span class="col-arrow-none"></span>'}
      <span class="col-name">${icon('folder')} ${esc(c.name)}</span>
      <span class="col-count">${c.papers_total ?? c.papers ?? 0}</span>
      <button class="col-del" title="删除文献库">${icon('close')}</button>
    </div>` + (kids.length && open ? kids.map(k => row(k, depth + 1)).join('') : '');
  };
  const roots = children['root'] || [];
  const allOpen = roots.some(r => colState[r.id] === true);
  const unassigned = state.unassignedCount ?? 0;
  const sharedLibs = state.sharedLibs || [];
  el.innerHTML =
    `<div class="col-item ${state.currentCollection === '' ? 'on' : ''}" data-id="">
      <span class="col-arrow-none"></span><span class="col-name">${icon('library')} 全部文献</span>
      <span class="col-count">${state.totalPapers ?? 0}</span>
    </div>` +
    roots.map(r => row(r, 0)).join('') +
    // 未分库 / 他人共享库：让「总数 = 各行相加」自洽（否则读者以为论文丢了）
    (unassigned ? `<div class="col-item ${state.currentCollection === 'none' ? 'on' : ''}" data-id="none">
      <span class="col-arrow-none"></span><span class="col-name">${icon('inbox')} 未分库</span>
      <span class="col-count">${unassigned}</span></div>` : '') +
    sharedLibs.map(l => `<div class="col-item ${state.currentCollection === l.id ? 'on' : ''}" data-id="${l.id}">
      <span class="col-arrow-none"></span><span class="col-name">${icon('folder')} ${esc(l.name)} <span class="muted" style="font-size: var(--fs-xs)">共享</span></span>
      <span class="col-count">${l.papers}</span></div>`).join('') +
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
    if (!(await uiConfirm(`删除文献库「${name}」？其子库一并删除；论文移出该库，不再属于任何库的论文进回收站（30 天内可恢复）`,
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
    el.innerHTML = `<div style="padding:8px 14px" class="muted">${icon('search')} 全文命中 ${d.hits.length} 处（跨全部文库 · 不受当前库/筛选限制 · 清空搜索框返回列表）</div>` +
      d.hits.map(h => {
        const p = state.qaAllPapers?.find(x => x.id === h.paper_id) || state.papers.find(x => x.id === h.paper_id) || {};
        return `<div class="paper-item" data-id="${h.paper_id}" data-page="${h.page_index}">
          <div class="info"><div class="name">${esc(p.title || h.paper_id)}</div>
          <div class="meta">${icon('doc')} 第${h.page_index + 1}页</div>
          <div class="muted" style="font-size: var(--fs-xs);padding:2px 0">${esc(h.text.slice(0, 90))}</div></div></div>`;
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
  } else if (state.scope === 'unread') {
    papers = papers.filter(p => !p.read_status);
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
  if (p.parse_status === 'skipped') return '<span class="badge dim" title="超页数上限未自动解析，可手动重解析">已跳过</span>';
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
          ${/上限/.test(u.msg || '') ? '' : '<button class="up-act" data-idx="' + idx + '" data-act="retry">重试</button>'}
          <button class="up-act" data-idx="${idx}" data-act="drop">移除</button></div>
      </div>
    </div>` : `
    <div class="paper-item uploading">
      <div class="info">
        <div class="name">${esc(name)}</div>
        <div class="meta"><span class="up-pct">${u.phase === 'saving' ? '保存中…' : '上传中 ' + (u.pct || 0) + '%'}</span>
          ${progressBar(u.pct || 0)}</div>
      </div>
    </div>`).join('');
  if (!state.papers.length && !ups) {
    el.innerHTML = `<div class="empty-state">
      <p class="t">这里还没有论文</p>
      <p style="margin-bottom:14px">把 PDF 拖到这里，或从下方入口导入（也支持 DOI / arXiv / BibTeX）</p>
      <button class="btn primary" onclick="document.querySelector('#upload-arrow')?.click()">${icon('upload')} 上传第一篇</button>
      <button class="btn" onclick="document.querySelector('#upload-arrow')?.click(); setTimeout(()=>document.querySelector('#ident-input')?.focus(), 200)">粘贴 DOI 导入</button>
    </div>`;
    return;
  }
  const listHtml = sortPapers(state.papers).map(p => {
    const pr = (state.parseProg || {})[p.id];
    const bar = p.parse_status === 'parsing' && pr?.total
      ? `${progressBar(Math.round(100 * pr.done / pr.total), false, 'up-bar parse')}` : '';
    return `
    <div class="paper-item ${state.current?.id === p.id ? 'sel' : ''}" data-id="${p.id}">
      <div class="info">
        <div class="name">${esc(p.title || p.id)}</div>
        <div class="meta">${p.read_status ? '' : '<span class="unread-dot" title="未读"></span>'}${statusBadge(p)}
          ${p.visibility === 'private' ? '<span class="badge priv">私人</span>' : ''}
          ${p.owner_name && p.owner_id !== state.me?.id ? `<span class="muted" title="上传者">· ${esc(p.owner_name)}</span>` : ''}
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
      if (e.target.closest?.('.pi-del')) { quickDelete(id, e.target.closest('.pi-del')); return; }   // closest：按钮内嵌 SVG 图标，e.target 常是 svg/path
      openPaper(id);   // 单击任意位置直接打开（批量选择在文库管理页）
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

/* 上传：入口是工具条图标 + 直接把文件拖到论文列表区（不再有独立大拖放框） */
state.uploadPrivate = localStorage.getItem('ps-upload-private') === '1';
function updateUploadTarget() {
  const el = $('#upload-target');
  if (el) el.textContent = '放入：' +
    (state.currentCollection ? (state.collections.find(c => c.id === state.currentCollection)?.name || '默认文献库')
     : '默认文献库（可在文库管理移动）');
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
/* 429 预知与友好化：弹层打开即展示今日余量；「上限」类错误附重置说明、不渲染无效重试按钮 */
const quotaTip = msg => /上限/.test(msg || '') ? msg + '——明日 0 点重置，也可请管理员在设置页调整限额' : msg;
async function refreshQuotaHint() {
  const el = $('#quota-hint');
  if (!el) return;
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) { el.textContent = ''; return; }
  el.textContent = `今日解析 ${q.parse_used}/${q.parse_limit} 篇 · 磁盘 ${fmtGB(q.disk_used_bytes).toFixed(1)}/${q.disk_limit_gb}G`;
}
$('#upload-arrow')?.addEventListener('click', e => {
  e.stopPropagation();
  upPop.hidden = !upPop.hidden;
  upPop.style.bottom = '52px'; upPop.style.top = 'auto';
  upPop.style.right = '12px'; upPop.style.left = 'auto';
  updateUploadTarget(); updateVisToggle();
  if (!upPop.hidden) refreshQuotaHint();
});
$('#upload-file-btn').onclick = () => { upPop.hidden = true; $('#file-input').click(); };
outsideClose(upPop, $('#upload-arrow'), $('#upload-file-btn'));
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
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
};
$('#url-import-input').onkeydown = e => { if (e.key === 'Enter') $('#url-import-btn').click(); };
/* 标识符导入（zotero-mcp 式）：DOI / arXiv ID / BibTeX → 元数据 + OA PDF */
$('#ident-btn').onclick = async () => {
  const ta = $('#ident-input');
  const text = ta.value.trim();
  if (!text) { toast('先粘贴 DOI / arXiv ID 或 BibTeX'); return; }
  const btn = $('#ident-btn');
  btn.disabled = true; btn.textContent = '解析中…';
  try {
    const d = await api('/api/papers/import-identifier', {method: 'POST', body: JSON.stringify({
      text, visibility: state.uploadPrivate ? 'private' : 'shared',
      collection_id: state.currentCollection || null})});
    const q = d.results.filter(x => x.status === 'queued').length;
    const dup = d.results.filter(x => x.status === 'duplicate').length;
    const nopdf = d.results.filter(x => x.status === 'no_pdf').length;
    const nf = d.results.filter(x => x.status === 'not_found').length;
    let msg = q ? `已导入 ${q} 篇并开始解析` : '没有可导入的条目';
    if (dup) msg += `，${dup} 篇已在库——已挂进当前库`;
    if (nopdf) msg += `，${nopdf} 篇无公开 PDF`;
    if (nf) msg += `，${nf} 条未识别`;
    toast(msg, 4000);
    if (q) { ta.value = ''; upPop.hidden = true; await loadCollections(); await refreshLib(); }
  } catch (e) { toast(quotaTip('导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.textContent = '导入 ID';
};
$('#ident-input').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) $('#ident-btn').click(); };
/* 目录批量入库：inbox/ 下子目录 → 扫描入库（CAJ 自动转 PDF），进度见任务中心 */
async function loadImportDirs() {
  try {
    const d = await api('/api/import-dirs');
    const sel = $('#dir-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">从服务器目录导入…</option>' +
      (d.dirs.length ? d.dirs.map(x =>
        `<option value="${esc(x.path)}">${esc(x.name)}（${x.files} 个文件）</option>`).join('')
        : '<option value="" disabled>inbox/ 下暂无目录</option>');
    if (cur) sel.value = cur;
  } catch { /* ignore */ }
}
$('#dir-btn').onclick = async () => {
  const path = $('#dir-select').value;
  if (!path) { toast('先选择要导入的目录'); return; }
  const btn = $('#dir-btn');
  btn.disabled = true; btn.textContent = '扫描中…';
  try {
    const d = await api('/api/import-directory', {method: 'POST',
      body: JSON.stringify({path, collection_id: state.currentCollection || null,
                            visibility: state.uploadPrivate ? 'private' : 'shared'})});
    const q = d.queued.length, sk = d.skipped.length;
    toast(`已入库 ${q} 篇${sk ? `，跳过 ${sk} 个` : ''}——解析进度见「任务中心」`, 4000);
    if (sk) {
      const reasons = d.skipped.slice(0, 3).map(x => `${x.file}: ${x.reason}`).join('；');
      await uiConfirm(`以下文件未能入库：<br>${esc(reasons)}${sk > 3 ? `<br>…共 ${sk} 个` : ''}`,
                      {title: '跳过明细', okText: '知道了', hideCancel: true, html: true});
    }
    upPop.hidden = true;
    await loadImportDirs();
    await refreshLib();
  } catch (e) { toast(quotaTip('目录导入失败: ' + e.message), 5000); }
  btn.disabled = false; btn.innerHTML = icon('folder') + ' 目录导入';
};
loadImportDirs();
/* 解析过滤器（llm4z 式：页数上限 + 文件名排除；服务端上传时执行，设置跟随账号） */
$('#pf-adv-toggle').onclick = () => { $('#pf-adv').hidden = !$('#pf-adv').hidden; };
async function loadParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter');
    $('#pf-max').value = d.max_pages || 0;
    $('#pf-exclude').value = d.exclude || '';
    $('#pf-adv-hint').textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
  } catch { /* ignore */ }
}
$('#pf-max').onchange = saveParseFilter;
$('#pf-exclude').onchange = saveParseFilter;
async function saveParseFilter() {
  try {
    const d = await api('/api/settings/parse-filter', {method: 'PUT', body: JSON.stringify({
      max_pages: +$('#pf-max').value || 0, exclude: $('#pf-exclude').value.trim()})});
    $('#pf-adv-hint').textContent =
      d.max_pages || d.exclude ? `（≤${d.max_pages || '∞'}页${d.exclude ? '·排除' + d.exclude.split(',')[0] : ''}）` : '';
    toast('解析过滤规则已保存');
  } catch (e) { toast('保存失败: ' + e.message); }
}
loadParseFilter();
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
  try {   // 磁盘软提醒：超上限警告但不拦截（展示口径，硬拦在 max_file_mb/页数过滤）
    const q = await api('/api/me/quota');
    const usedGb = fmtGB(q.disk_used_bytes);
    if (q.disk_limit_gb && usedGb >= q.disk_limit_gb)
      toast(`磁盘已用 ${usedGb.toFixed(1)}GB，已达上限 ${q.disk_limit_gb}GB——建议清理回收站或联系管理员`, 5000);
  } catch { /* ignore */ }
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
      else if (res.status === 'duplicate') {
        state.uploads.delete(f.name); dupN++;
        if (res.linked) { setTimeout(() => toast('该内容已在其他文献库——已同时放入当前文献库（同一份，不重复占用）'), 400); }
      }
      else if (res.status === 'skipped') {
        state.uploads.delete(f.name); okN++;
        setTimeout(() => toast(`《${(res.name || '文件').slice(0, 30)}》已入库但超出解析页数上限，未排队解析（可手动重解析）`, 5000), 400);
      }
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
/* ---- 筛选与排序菜单（▾）---- */
const FILTERS = [['', '全部'], ['parsed', '已解析'], ['parsing', '解析中'], ['skipped', '已跳过'], ['failed', '失败'], ['private', '仅私人']];
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
outsideClose($('#filter-pop'), $('#filter-arrow'));
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
/* 初始即按视口宽收放（resize 监听只在变化时触发，窄窗口直开/刷新不会走 resize） */
if (innerWidth < 1100 && !state.sidebarCollapsed) {
  state._autoFolded = true; state.sidebarCollapsed = true; applySidebarCollapse();
}

/* 批量选择已收敛到「文库管理」页（勾选 → 完整批量条）与「批量中心」页；
   侧栏回归纯导航。state.selected 仍由文库页复选框维护（全站共享）。 */

/* 搜索 + 快捷范围 chips */
$('#lib-search').oninput = debounce(e => {   // 300ms 防抖：大库逐键触发全文检索会请求风暴
  state.q = e.target.value;
  loadPapers();
}, 300);
$$('#scope-chips .chip-btn').forEach(b => b.addEventListener('click', () => {
  const s = b.dataset.scope;
  state.scope = state.scope === s ? '' : s;      // 再点取消
  $$('#scope-chips .chip-btn').forEach(x => x.classList.toggle('on', x.dataset.scope === state.scope));
  loadPapers();
}));

/* ---------------- 阅读器 ---------------- */
/* ===== 03-reader.js —— 阅读器：PDF 渲染/覆盖层/中英对照/翻译 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
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
    // 阅读追踪：fire-and-forget（不 await 不 toast——零打扰）
    // 同时更新本地 state.papers 的 read_status → 侧栏圆点即时消失（否则要等下次拉列表）
    try {
      const pos = JSON.parse(localStorage.getItem('ps-pos-' + id) || 'null');
      api(`/api/papers/${id}/read`, {method: 'POST',
        body: JSON.stringify({page: pos?.page || null, bid: pos?.bid || null})}).then(() => {
        const lp = state.papers.find(x => x.id === id);
        if (lp) lp.read_status = 'read';
        renderPapers();
      }).catch(() => {});
    } catch { api(`/api/papers/${id}/read`, {method: 'POST'}).catch(() => {}); }

  const PAGE = 40;
  const dp = $('#discover-pop');
  if (dp) dp.hidden = true;   // 切论文关掉「找相关」浮层，避免新论文配旧数据
  syncSynBackBtn('reader');   // 从综述证据跳进来时（不经 switchPage）也要更新返回键
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
    $('#pdf-host').innerHTML = `<div style="color:#aab;margin:40px auto;text-align:center;font-size: var(--fs-base)">
      ${icon('warn')} 本篇无 PDF 预览（URL/Office 导入）<br>右侧解析内容与问答功能正常</div>`;
  }
  // 解析内容 + 双语（先清掉上一篇的残留，避免串页）
  state.pairs = []; state.versions = []; state.assets = null;
  state._biTotal = 0; state._biOffset = 0;
  api(`/api/papers/${id}/assets`).then(d => {
    if (state.current?.id !== id) return;   // 已切到别的论文：丢弃迟到响应（否则 A 的图表数据污染 B）
    state.assets = d;
    if (['orig', 'bilingual', 'zh'].includes(state.view)) renderContentView();   // 聚合就绪→升级原图裁剪
  }).catch(() => {});
  state._refs = null;   // 引用缓存随论文重置
  state._cite = null;   // 引用文本缓存（{styles, labels, default}）
  state._citeRendered = null;   // 引用渲染缓存同样跨篇作废（防复制到上一篇的引用）
  state.citeStyle = localStorage.getItem('ps-cite-style') || 'gbt7714';
  state._metaEdit = false;   // 文献信息卡的内联编辑态
  state.showLayout = false; $('#layout-btn')?.classList.remove('on');   // 布局框不跨篇残留
  // 懒加载双语：不再 openPaper 预拉全文对照（en+zh 300-500KB/次切论文，90% 场景只看 PDF/原文）。
  // translated 标志由 refreshJobState（jobstate 接口）带回；真正切到双语/中文视图时才拉（见 switchView 钩子）。
  state.pairs = [];           // 清上一篇残留，防串台
  state._biLoadedFor = null; state._biLoading = null;   // 懒拉哨兵同篇解绑（renderContentView 的自愈按当前篇重新拉）
  refreshJobState().then(() => {
    // state.view 可能残留上一篇的子视图（bilingual/zh/meta…），不能用它判断「无偏好」——
    // 用持久化的 rpane.readingView；残留视图的渲染由 renderContentView 的自愈兜底
    if (state.translatedComplete && (state.view ?? 'orig') === 'orig'
        && (state.rpane.readingView || 'orig') === 'orig') {
      // 有完整译文且用户无特定子视图偏好 → 默认进双语（懒拉在 switchView 内触发）
      switchView('read', 'bilingual');
    } else {
      renderContentView();
    }
    restorePos(id);
  }).catch(() => { renderContentView(); });
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
  if (!host) return;
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
    if (!w) continue;   // 换文档竞态（切论文时 numPages 变化）→ 该页骨架已不存在，跳过
    const ph = w.querySelector('.pdf-ph');
    if (ph) ph.style.height = Math.round(vp.height) + 'px';
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
    if (state.current?.id !== id) return;   // 已切到别的论文：丢弃迟到响应（防串页，同 assets 拉取守卫）
    state.pairs = d.pairs; state.versions = d.versions;
    state._biLoadedFor = id;
    if (render) renderContentView();
  } catch { if (state.current?.id === id) state.pairs = []; }
}
/* 译文版本切换控件已移除（历史版本保留在库，如需回溯可导出对照 MD） */
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
    strip.innerHTML = `<span>${pp.status === 'queued' ? '解析排队中（GPU 队列）' : pp.status === 'pending_gate' ? '排队等待解析资源（通常 1-3 分钟/篇）…' : '解析中'}</span>
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
  return true;
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
  if (!state.current?.id) { toast('先在左侧列表打开一篇论文'); return; }
  try {
    const r = await api('/api/papers/translate', {method: 'POST', body: JSON.stringify({paper_ids: [state.current.id]})});
    toast(r.skipped_in_flight?.length ? '该论文已有译文/已在队列，无需重复' : '翻译任务已加入队列');
  } catch (e) { toast(friendlyError(e, '翻译失败，请检查 LLM key 与队列状态')); }
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
    if (document.hidden) return;   // 后台标签页暂停轮询（badge/health 同款守卫）
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
  $$('.topnav button[data-page]').forEach(x => x.classList.toggle('on', x.dataset.page === page));
  $('#page-title').textContent = {reader: '阅读', collections: '文库管理',
    tasks: '任务中心', tracker: '文献追踪', trash: '回收站', settings: '设置',
    admin: '管理后台'}[page] || 'paper-system';
  syncSynBackBtn();
  for (const p of ['reader', 'collections', 'tasks', 'tracker', 'trash', 'settings', 'admin']) {
    $('#page-' + p).style.display = p === page ? (p === 'reader' ? 'flex' : 'block') : 'none';
  }
  ({collections: renderCollectionsPage, tasks: renderTasksPage, tracker: renderTrackerPage,
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
    // 轻量计数端点（两个数字）——原先拉全量 ?limit=200（~70KB）只为数个数
    const d = await api('/api/jobs/count');
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
/* ===== 05-tasks.js —— 任务中心与综述：任务聚合/综述列表/报告渲染 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const TASK_TYPES = {
  parse:          {label: '解析',    icon: 'search', cls: 'tt-parse'},
  translate:      {label: '翻译',    icon: 'globe2', cls: 'tt-translate'},
  summary:        {label: '导读',    icon: 'brain', cls: 'tt-summary'},
  meta:           {label: '元数据',  icon: 'tag2', cls: 'tt-meta'},
  embed_backfill: {label: '索引回填', icon: 'stack', cls: 'tt-embed'},
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
        <h2 class="page-h row">任务中心
          <span class="muted">解析 / 翻译 / 导读 / 元数据 / 综述——全部任务的实时状态</span>
          <span class="spacer"></span>
          <button class="btn small" id="tk-pause-toggle" title="暂停/恢复批量解析队列（手动任务不受影响）">…</button></h2>
        <div class="task-filters">
          <span class="muted" style="font-size:var(--fs-xs)">类型</span>
          ${chips('tt', f.type, [['', '全部'], ['parse', '解析'], ['translate', '翻译'],
            ['summary', '导读'], ['meta', '元数据'], ['synthesis', '综述'], ['acquire', '采集下载']])}
          <span class="task-fsep"></span>
          <span class="muted" style="font-size:var(--fs-xs)">状态</span>
          ${chips('ts', f.status, [['', '全部'], ['active', '进行中'], ['done', '完成'], ['failed', '失败']])}
        </div>
      </div>
      <div id="mcp-zone"></div>
      <div class="card tasks-body" id="task-body"><p class="muted" style="padding:10px">加载中…</p></div>
      <div class="card syn-list-card" style="margin-top:14px">
        <h2 class="page-h row sec">我的综述
          <span class="muted">历史报告永久保存——查看 / 导出 / 删除；进行中的显示实时进度</span></h2>
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
      tb.innerHTML = paused ? icon('play', 12) + ' 恢复批量（已暂停）' : icon('pause', 12) + ' 暂停批量';
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
  const stMap = {queued: '排队', pending_gate: '排队等资源', running: '进行中', done: '完成',
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
      ? `${progressBar(Math.round(100 * (j.progress_done || 0) / j.progress_total), false, 'up-bar task')}` : '';
    return `<div class="task-row">
      <span class="tt ${tt.cls}">${icon(tt.icon, 11)} ${tt.label}</span>
      <span class="task-main">
        <span class="task-title">${esc(j.title || j.paper_id || '（无标题）')}</span>
        ${bar}
        ${j.error ? `<span class="bpanel-err" style="padding:0">${esc(taskErr(j.error))}</span>` : ''}
      </span>
      <span class="muted" style="font-size: var(--fs-xs);white-space:nowrap">${stMap[j.status] || esc(j.status)}${j.progress_total > 1 ? ` ${j.progress_done}/${j.progress_total}` : ''}</span>
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
      .map(x => progressBar(Math.round(100 * (x.progress_done || 0) / x.progress_total), false, 'up-bar task')).join('');
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
        <span class="muted" style="font-size: var(--fs-xs)">${esc(relTime(t0))}</span></span>
      ${failed.length ? `<button class="btn small" data-retry="${failed[0].id}">重试</button>` : ''}
      ${live.length ? `<button class="btn small danger" data-cancel="${live[0].id}">取消</button>` : ''}
    </div>`;
  };
  const batchCard = b => {
    const tt = taskType(b.job_type);
    const resolved = b.done + b.failed + b.canceled;
    const badge = b.active > 0 ? ['run', '进行中'] : b.failed > 0 ? ['err', '有失败']
      : b.done > 0 ? ['ok', '完成'] : ['dim', '已取消'];
    return `<div class="bpanel-batch" data-batch="${esc(b.batch_id)}">
      <div class="bpanel-row head" data-tb="${esc(b.batch_id)}">
        <span class="badge ${badge[0]}">${badge[1]}</span>
        <span class="tt ${tt.cls}">${icon(tt.icon, 11)} ${tt.label}</span>
        <span class="muted">${b.done}/${b.total}${b.failed ? ` · <span class="berr">${b.failed} 失败</span>` : ''}${b.canceled ? ` · ${b.canceled} 取消` : ''}</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(relTime(b.updated_at))}</span>
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
           <div class="bpanel-row head" style="border-bottom:1px solid var(--border);margin-bottom:6px">
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

/* 任务页唯一点击委托。此前三处重叠监听同一容器（本文件的批次委托 +
   06-topic 的任务页委托 + 04-view 的 syn-list 委托）：综述删除会弹两个
   确认框、DELETE 发两次；MCP 行头在 06-topic 分支会 null.dataset 抛错。 */
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
  // 综述行：查看报告 / 导出 / 删除（syn-list 与批次内渲染共用 data-* 键）
  const synView = e.target.closest('[data-syn-view]');
  if (synView) { showSynthesisReport(synView.dataset.synView); return; }
  const synDl = e.target.closest('[data-syn-dl]');
  if (synDl) { location.href = `/api/syntheses/${encodeURIComponent(synDl.dataset.synDl)}/export?fmt=${synDl.dataset.fmt}`; return; }
  const synDel = e.target.closest('[data-syn-del]');
  if (synDel) {
    if (await uiConfirm('删除这篇综述？（报告与矩阵将一并删除，进行中的任务同时取消）',
                        {title: '删除综述', danger: true, anchor: synDel})) {
      try { await api('/api/syntheses/' + encodeURIComponent(synDel.dataset.synDel), {method: 'DELETE'}); } catch { /* ignore */ }
      renderSynList();
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



/* ---- 综述流水线（批量页核心卡）----
   圈定 → 成本预估确认（缺导读自动补齐 + 组内比对 + 跨组综合 = N 次调用）
   → synthesis job 进批次面板（四阶段进度）→ 完成后查看报告/导出 MD·CSV */
function downloadBibtex(ids) {
  downloadBlob('/api/papers/export/bibtex', {paper_ids: ids}, 'references.bib',
               `已导出 ${ids.length} 篇 BibTeX`).catch(e => toast('导出失败: ' + e.message));
}

/* ---- 专题采集任务：列表 → 详情（候选勾选 → 下载入库 → 综述） ---- */
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
const BATCH_ST = {queued: '排队', pending_gate: '排队等解析资源', running: '进行中', done: '完成',
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
    // 作者-年份引用高亮 + 点击滚到参考文献对应条目
    const CITE_RE = /[（(]([^（）()]{1,80}?,\s*20[12]\d[a-z]?)[）)]/g;
    const walker = document.createTreeWalker(rep, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.textContent;
      if (!CITE_RE.test(text)) continue;
      CITE_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(CITE_RE)) {
        const start = m.index, end = m.index + m[0].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const span = document.createElement('span');
        span.className = 'cite-key';
        span.textContent = m[0];
        const key = m[1].trim();
        span.onclick = () => {
          const row = $$('#syn-report ~ * .syn-ref-row, .syn-refs .syn-ref-row')
            .find(r => r.textContent.includes(key.slice(0, 24)));
          if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.style.background = 'var(--tint-primary)'; setTimeout(() => row.style.background = '', 1200); }
        };
        frag.appendChild(span);
        last = end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
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
// 数据变更统一刷新：失效范围缓存 + 库树/列表/文库管理页/QA 选文 papers
const refreshOnData = throttle(entity => {
  invalidateScopeIds();
  loadCollections().catch(() => {});
  loadPapers();
  const cp = $('#page-collections');
  if (cp && cp.style.display !== 'none') renderCollectionsPage();
  if (entity === 'tracker' && window.refreshTrackerBadge) window.refreshTrackerBadge();
  const tp = $('#page-tracker');
  if (entity === 'tracker' && tp && tp.style.display !== 'none') window.renderTrackerPage?.();
  // QA 选文 papers 重拉（选文面板开着时）
  api('/api/papers').then(d => {
    state.qaAllPapers = d.papers;
    if (state.view === 'qa') { renderPickList($('#qa-pick-filter')?.value.toLowerCase() || ''); renderQaScope(); }
  }).catch(() => {});
}, 3000);
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
    // 数据变更广播（双标签一致性）：另一标签页删/挂链/恢复/清空回收站/改库
    // → 通知本页失效缓存 + 节流刷新（事件不含内容，拉取走可见性过滤）
    if (ev.type === 'data') {
      refreshOnData(ev.entity);
      return;
    }
    // 解析实时进度 → 侧栏列表“提取中 x/y”（SSE 事件自带 done/total）
    if (ev.job_type === 'parse') {
      const prev = JSON.stringify(state.parseProg[ev.paper_id] || null);
      if (ev.status === 'running') state.parseProg[ev.paper_id] = {done: ev.done || 0, total: ev.total || 0};
      else if (['done', 'failed', 'canceled'].includes(ev.status)) delete state.parseProg[ev.paper_id];
      if (JSON.stringify(state.parseProg[ev.paper_id] || null) !== prev) renderPapers();
    }
    // 导读任务完成 → 重拉并重绘气泡（此前只在生成页轮询，切走或超时就看不到结果）
    // 讨论区新消息 → 同论文讨论面板实时追加（refreshOnData 已在 else-if 处理全量刷新）
    if (ev.type === 'data' && ev.entity === 'discussion') {
      const dp = document.querySelector('#discuss-msgs');
      if (dp && !document.querySelector('#discuss-panel').hidden) {
        // 面板开着 → 直接重拉（load 在 12-reader-ui 闭包内——用 fetch 简化：重触发点击）
        document.querySelector('#discuss-open')?.click();
        document.querySelector('#discuss-open')?.click();   // toggle × 2 = 重载
      }
    }
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
    <div class="card"><h3>${icon('folder')} 分库</h3>
      <div id="m-collection-chips" class="chip-row"></div>
      <select id="m-collection-add" style="max-width:200px;font-size: var(--fs-sm)"></select></div>`;

  renderCiteCard();

  // 分库多选 chips（多对多：一篇可挂 N 库；×移出，下拉加入）
  const linked = paper.collection_ids || [];
  const chipRow = $('#m-collection-chips');
  chipRow.innerHTML = linked.length
    ? linked.map(cid => {
        const c2 = state.collections.find(x => x.id === cid);
        return `<span class="chip">${icon('folder', 12)} ${esc(c2?.name || cid)}
          <button class="hover-only" title="从此库移出" onclick="unlinkPaper('${pid}','${cid}')">${icon('close', 12)}</button></span>`;
      }).join('')
    : '<span class="muted" style="font-size: var(--fs-sm)">未分库</span>';
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
  if (!(await uiConfirm('从此库移出？（论文本体与译文不受影响；全部库移出后落「未分库」）',
                        {title: '移出分库', danger: true}))) return;
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
  const pid = c.paper_id;
  const put = html => { if (state.current?.id === pid && state._cite?.paper_id === pid) box.innerHTML = html; };
  if (styleId === 'bibtex' || !window.citeproc) {
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
/* ===== 09-md.js —— Markdown 渲染：mdLite/表格/引用跳转 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
function mdLite(text) {
  let raw = String(text ?? '');
  // 模型偶尔给 ```json 围栏（历史坏数据）——剥掉围栏只留内容
  if (raw.trim().startsWith('```')) {
    const m2 = raw.trim().match(/^```(?:\w*)\n?([\s\S]*?)\n?```$/);
    if (m2) raw = m2[1];
  }
  let h = esc(raw);
  // 表格先抽出（占位保护，避免逐行处理把表格拆散）
  const tables = [];
  // 表格：每行以 | 结尾，行间可有换行；末行允许直接到文末（表格在段落末尾时无换行）
  h = h.replace(/(^|\n)((?:\|[^\n]+\|[ \t]*(?:\n|$))+)/g, (m3, pre, block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[\s:|-]+\|$/.test(r));
    const cells = rows.map(r => r.split('|').slice(1, -1).map(c => c.trim()));
    if (cells.length < 2) return m3;
    // 数字列右对齐 + 等宽数字（消融表这类「标签+数值」表才读得下去）
    const isNum = c => /^[+\-−]?\d[\d,.]*\s*(?:%|dB|×|fps|ms|s|m|h|K|M|G|T|B)?$/.test(c.trim());
    const numCols = cells[0].map((_, i) => cells.slice(1).every(r => isNum(r[i] ?? '')));
    const th = cells[0].map((c, i) => `<th class="${numCols[i] ? 'num' : ''}">${c}</th>`).join('');
    const tb = cells.slice(1).map(r => '<tr>' + r.map((c, i) =>
      `<td class="${numCols[i] ? 'num' : ''}">${c}</td>`).join('') + '</tr>').join('');
    const html = '<div class="md-tbl-box">' +
      '<div class="md-tbl-bar">' +
      '<button class="md-tbl-btn" data-act="copy-md" title="复制为 Markdown">MD</button>' +
      '<button class="md-tbl-btn" data-act="copy-tsv" title="复制为表格文本（可直接粘贴进 Excel/Word）">Excel</button>' +
      '<button class="md-tbl-btn" data-act="expand" title="放大只看此表格">放大</button>' +
      '</div><div class="tbl-wrap"><table class="tbl-md"><thead><tr>' + th + '</tr></thead>' +
      '<tbody>' + tb + '</tbody></table></div></div>';
    tables.push(html);
    return pre + `\u0000TBL${tables.length - 1}\u0000`;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{2,4} (.+)$/gm, '<h4>$1</h4>');
  // 逐行处理：编号/无序列表成组，段落按空行切分（导读的「方法」几乎都是 1) 2) 3) 结构）
  const lines = h.split('\n');
  const out = [];
  let listBuf = [], listType = '', paraBuf = [];
  const flushList = () => {
    if (listBuf.length) { out.push(`<${listType} class="md-list">${listBuf.join('')}</${listType}>`); listBuf = []; listType = ''; }
  };
  const flushPara = () => {
    if (paraBuf.length) { out.push(`<p>${paraBuf.join('<br>')}</p>`); paraBuf = []; }
  };
  for (const ln of lines) {
    let mm;
    // 先判行内编号（覆盖 '1) A 2) B' 与 '1) A' 两种：序号从 1 连续递增才拆）
    const inline = splitInlineList(ln);
    if (inline) {
      flushPara(); flushList();
      if (inline.lead) out.push(`<p>${inline.lead}</p>`);
      out.push(`<ol class="md-list">${inline.items.map(it =>
        `<li class="md-num"><span class="md-n">${it.num}</span><span>${it.content}</span></li>`).join('')}</ol>`);
      continue;
    }
    if ((mm = ln.match(/^(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listBuf.push(`<li class="md-num"><span class="md-n">${mm[1]}</span><span>${mm[2]}</span></li>`);
      continue;
    }
    if ((mm = ln.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listBuf.push(`<li class="md-bullet"><span class="md-n">&bull;</span><span>${mm[1]}</span></li>`);
      continue;
    }
    if (!ln.trim()) { flushPara(); flushList(); continue; }
    flushList();
    paraBuf.push(ln);
  }
  flushPara(); flushList();
  let res = out.join('');
  tables.forEach((t, i) => { res = res.replace(`\u0000TBL${i}\u0000`, t); });
  return linkifyRefs(katexify(res));
}
/* ---- 表格工具条：复制（MD / Excel 可粘贴格式）+ 放大只看（居中弹层） ----
   委托监听：问答气泡/导读/综述/放大层里的表格统一生效 */
function _tblToMarkdown(tbl) {
  const rows = [...tbl.querySelectorAll('tr')];
  const n = rows[0]?.children.length || 0;
  const lines = rows.map(tr =>
    '| ' + [...tr.children].map(c => (c.textContent || '').trim().replace(/\|/g, '\\|')).join(' | ') + ' |');
  if (rows.length > 1) lines.splice(1, 0, '|' + ' --- |'.repeat(n));
  return lines.join('\n');
}
function _tblToTSV(tbl) {
  return [...tbl.querySelectorAll('tr')]
    .map(tr => [...tr.children].map(c => (c.textContent || '').trim()).join('\t')).join('\n');
}
document.addEventListener('click', async e => {
  const btn = e.target.closest?.('.md-tbl-btn');
  if (!btn) return;
  const box = btn.closest('.md-tbl-box');
  const tbl = box?.querySelector('table.tbl-md');
  if (!tbl) return;
  const act = btn.dataset.act;
  if (act === 'copy-md') {
    toast(await copyText(_tblToMarkdown(tbl)) ? '表格已复制为 Markdown' : '复制失败');
  } else if (act === 'copy-tsv') {
    toast(await copyText(_tblToTSV(tbl)) ? '表格已复制——可直接粘贴进 Excel/Word' : '复制失败');
  } else if (act === 'expand') {
    const {pop, close} = openPop('md-tbl-pop');
    pop.innerHTML = `<div class="ui-pop-title">${icon('stack')} 表格<button class="btn small" data-x style="margin-left:auto">${icon('close')} 关闭</button></div>`;
    pop.appendChild(box.cloneNode(true));
    pop.querySelector('[data-x]').onclick = close;
  }
});
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
      // 源句闪烁（llm-for-zotero/zotero-mcp 式）：跳到后 2 秒内一眼锁定引用原文
      blkEl.classList.remove('blk-flash');
      void blkEl.offsetWidth;   // 强制 reflow 重启动画
      blkEl.classList.add('blk-flash');
      setTimeout(() => blkEl.classList.remove('blk-flash'), 2200);
    }
    // PDF：滚到块所在页并闪烁高亮框（跨页段落每页各画一个）
    if (state.pdfDoc) state.pageNum = blk.page_index + 1;
    await pdfFlashBlock(blk);
    return;
  }
  // 找不到块（跨论文证据 / 块已重建）→ 至少跳到对应页；保守提示而非静默
  if (state.pdfDoc) { state.pageNum = e.page_index + 1; renderPage(); }
  toast('该引用的原文段落未精确定位（块可能已重建），已跳到所在页');
};
window.jumpEvidence = page => { switchPage('reader'); if (state.pdfDoc) { state.pageNum = page + 1; renderPage(); } };

/* ================= 恢复区：被误删函数重建（以文件末尾声明覆盖） ================= */

/* ---- 回收站 ---- */
async function renderTrash() {
  const d = await api('/api/papers?trash=1');
  state._trashCount = (d.papers || []).length;   // 清空确认框要显示影响篇数
  $('#page-trash').innerHTML = `<div class="card"><h2 class="page-h row">回收站（${state.health.trash_days || 30} 天后自动清理）
    <button class="btn small danger" style="margin-left:auto" onclick="emptyTrash()">${icon('trash')} 清空回收站</button></h2>
    <table class="list"><tr><th>标题</th><th>删除时间</th><th></th></tr>
    ${d.papers.map(p => `<tr><td>${esc(p.title)}</td><td class="muted">${relTime(p.deleted_at)}</td>
      <td class="row-actions"><button class="btn small" onclick="restorePaper('${p.id}')">恢复</button>
      </td></tr>`).join('') || '<tr><td colspan="3" class="muted">回收站为空——删除的论文在此保留 30 天，可随时恢复</td></tr>'}</table>`;
}
window.restorePaper = async id => {
  try {
    await api(`/api/papers/${id}/restore`, {method: 'POST'});
    toast('已恢复'); renderTrash(); await refreshLib();
  } catch (e) { toast(friendlyError(e, '恢复失败，请重试')); }
};

/* ---- 设置（BYOK + 术语表 + 测试连接） ---- */
/* 设置页：页签分组（账号 / AI 模型 / 术语表 / 用量 / 管理）——
   原为单页 97 个控件 3.6 屏（86% 在首屏外），改为每页只渲染本类内容。 */
/* ===== 10-settings.js —— 设置与管理：页签/配额/成员/审计 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const SET_TABS = [
  {id: 'acc',  label: '账号安全', icon: 'lock'},
  {id: 'ai',   label: 'AI 模型',  icon: 'key'},
  {id: 'gloss',label: '术语表',   icon: 'book'},
  {id: 'usage',label: '我的用量', icon: 'chart'},
];
function setTab() {
  const t = localStorage.getItem('ps-set-tab') || 'acc';
  return SET_TABS.some(x => x.id === t) ? t : 'acc';
}
async function renderSettings(tab) {
  const isAdmin = state.me?.role === 'admin';
  let cur = tab || setTab();
  if (cur === 'admin' && !isAdmin) cur = 'acc';   // 非管理员不能停管理页签
  localStorage.setItem('ps-set-tab', cur);
  const d = await api('/api/settings/llm');
  const tpl = (purpose, cfg, conf) => `
    <div class="set-card">
      <div class="set-head">${purpose === 'chat' ? icon('chat') + " 聊天（问答/导读）" : icon('globe') + " 翻译"} ${conf.configured ? '<span class="badge ok">已配置</span>' : '<span class="badge err">未配置</span>'}</div>
      <form id="f-${purpose}">
        <label>API 地址 <input name="base_url" value="${esc(conf.base_url)}" placeholder="https://open.bigmodel.cn/api/anthropic"></label>
        <label>模型 <input name="model" value="${esc(conf.model)}" placeholder="glm-4.7"></label>
        <label>协议 <select name="api_type"><option value="anthropic" ${(conf.api_type || (conf.base_url.includes('anthropic') ? 'anthropic' : 'openai')) === 'anthropic' ? 'selected' : ''}>anthropic</option><option value="openai" ${(conf.api_type || (conf.base_url.includes('anthropic') ? 'anthropic' : 'openai')) !== 'anthropic' ? 'selected' : ''}>openai</option></select></label>
        <label>API Key ${conf.configured ? '<span class="muted" style="font-size: var(--fs-xs)">已保存（留空不变）</span>' : ''} <input name="api_key" type="password" placeholder="${conf.configured ? '••••••（输入可更换）' : '粘贴 API Key'}"></label>
        <div class="set-actions">
          <button class="btn" type="button" onclick="testLlm('f-${purpose}')">${icon('bolt')} 测试</button>
          <button class="btn primary" type="submit">${icon('save')} 保存</button>
        </div>
      </form>
    </div>`;
  const tabs = SET_TABS.filter(t => !t.admin || isAdmin);
  $('#page-settings').innerHTML = `
    <div class="set-tabs" role="tablist">
      ${tabs.map(t => `<button class="set-tab ${cur === t.id ? 'on' : ''}" data-set-tab="${t.id}">${icon(t.icon)} ${t.label}</button>`).join('')}
    </div>
    <div class="set-panel" id="set-panel-${cur}">
      ${cur === 'acc' ? `
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
        </div>` : ''}
      ${cur === 'ai' ? `
        <h2 class="page-h">${icon('key')} LLM 配置（BYOK）</h2>
        <p class="muted" style="font-size: var(--fs-sm);margin:2px 0 12px">聊天/翻译各自独立；embedding 本机运行无需配置。密钥加密存储、永不回显。</p>
        ${tpl('chat', d.chat, d.chat)}
        ${tpl('translate', d.translate, d.translate)}` : ''}
      ${cur === 'gloss' ? `
        <h2 class="page-h">${icon('book')} 翻译术语表（全局）</h2>
        <div id="gl-list" style="margin:10px 0"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="gl-term" placeholder="术语" style="flex:2;min-width:120px">
          <select id="gl-target" style="flex:1;min-width:100px">
            <option value="keep_en">保留英文</option><option value="trans">固定译法</option><option value="first_both">首次中英并列</option>
          </select>
          <input id="gl-value" placeholder="译法" style="flex:2;min-width:100px">
          <button class="btn small primary" id="gl-add" title="添加术语">${icon('plus')}</button>
        </div>` : ''}
      ${cur === 'usage' ? '<div id="me-quota-zone"></div>' : ''}
    </div>`;
  $$('#page-settings .set-tab').forEach(b => b.onclick = () => renderSettings(b.dataset.setTab));
  const bind = (fid, purpose) => {
    const form = $(`#${fid}`);
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const conf = {base_url: f.get('base_url'), model: f.get('model'), api_type: f.get('api_type')};
      if (f.get('api_key')) conf.api_key = f.get('api_key');
      await api('/api/settings/llm', {method: 'PUT', body: JSON.stringify({[purpose]: conf})});
      toast('已保存'); renderSettings();
    };
  };
  bind('f-chat', 'chat'); bind('f-translate', 'translate');
  if (cur === 'gloss') loadGlossary();
  if (cur === 'acc') {
    const pf = $('#f-password');
    if (pf) pf.onsubmit = async e => {
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
  }
  if (cur === 'usage') renderMeQuota();
}
/* 我的用量：真额度（解析/磁盘）+ 本月花费与预算闸。
   token 数字不展示——余额是上游商家的事，上游额度不足会原样报错；这里只给"花了多少/还能花多少"。 */
async function renderMeQuota() {
  const el = $('#me-quota-zone');
  if (!el) return;
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) return;
  const pPct = q.parse_limit ? Math.round(q.parse_used / q.parse_limit * 100) : 0;
  const usedGb = fmtGB(q.disk_used_bytes);
  const dPct = q.disk_limit_gb ? Math.round(usedGb / q.disk_limit_gb * 100) : 0;
  const bar = (pct, warn) => `<div class="progress" style="margin-top:4px">
    <i style="width:${Math.min(100, pct)}%;${pct >= warn ? 'background:var(--warn)' : ''}"></i></div>`;
  const purposeName = {chat: '问答/导读', translate: '翻译', summary: '导读', embed: '向量化', synthesis: '综述'};
  const costRows = Object.entries(q.cost_by_purpose || {})
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(purposeName[k] || k)}</td>
      <td class="num">¥${Number(v).toFixed(2)}</td>
      <td class="num" style="width:34%">
        <div class="progress"><i style="width:${q.month_cost ? Math.min(100, v / q.month_cost * 100) : 0}%"></i></div></td></tr>`).join('');
  const delta = q.prev_month_cost ? Math.round((q.month_cost - q.prev_month_cost) / q.prev_month_cost * 100) : 0;
  const hasBudget = q.budget > 0;
  el.innerHTML = `
    <h2 class="page-h">${icon('chart')} 我的用量</h2>
    <div class="set-card">
      <div class="set-head">本月花费
        <span class="muted" style="font-weight:400;font-size: var(--fs-xs)">按模型单价估算${q.cost_priced ? '' : '（当前模型未收录单价，估为 0——可在下方填你的实际单价）'}</span></div>
      <div style="font-size: var(--fs-h1);font-weight:600">¥${Number(q.month_cost || 0).toFixed(2)}
        ${q.prev_month_cost ? `<span class="muted" style="font-size: var(--fs-sm);font-weight:400">（上月 ¥${Number(q.prev_month_cost).toFixed(2)} ${delta >= 0 ? '↑' : '↓'}${Math.abs(delta)}%）</span>` : ''}</div>
      ${hasBudget ? `<div style="font-size: var(--fs-sm);margin-top:8px">月预算 ¥${q.budget} · 已用 <b>${q.budget_pct}%</b>
          ${q.budget_pct >= 100 ? '<span class="badge err">已用尽，将拦截调用</span>' : q.budget_pct >= 80 ? '<span class="badge run">接近上限</span>' : ''}</div>
        ${bar(q.budget_pct, 100)}`
        : `<div class="muted" style="font-size: var(--fs-sm);margin-top:6px">未设预算——不拦截调用；上游余额不足时由上游报错</div>`}
      ${costRows ? `<table class="list" style="margin-top:10px">${costRows}</table>` : ''}
      <div class="set-actions">
        <button class="btn small" onclick="openBudgetDialog()">设置预算 / 单价</button>
      </div>
    </div>
    <div class="set-card">
      <div class="set-head">额度上限</div>
      <div style="font-size: var(--fs-sm)">今日解析 <b>${q.parse_used}</b> / ${q.parse_limit} 篇${pPct >= 80 ? ' <span class="badge err">接近上限</span>' : ''}</div>
      ${bar(pPct, 80)}
      <div style="font-size: var(--fs-sm);margin-top:12px">磁盘已用 <b>${usedGb.toFixed(2)}</b> / ${q.disk_limit_gb} GB${dPct >= 90 ? ' <span class="badge err">空间紧张</span>' : ''}</div>
      ${bar(dPct, 90)}
      <div class="muted" style="font-size: var(--fs-xs);margin-top:10px">${q.month_calls || 0} 次调用（本月）</div>
    </div>`;
}

/* 审计动作名（库里是英文 action → 中文可读） */
const AUDIT_ACT = {
  'delete-user': '注销账号', 'enable-user': '启用账号', 'disable-user': '禁用账号',
  'reset-password': '重置密码', 'change-password': '修改密码', 'create_invite': '生成邀请码',
  'login': '登录', 'logout': '退出', 'create-topic': '新建专题', 'update-quota': '调整限额',
};
function auditActionName(a) { return AUDIT_ACT[a] || a; }

async function renderAdminZone() {
  const el = $('#page-admin');
  if (!el) return;
  const [users, pool, audit] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/pool').catch(() => ({enabled: false})),
    api('/api/admin/audit?limit=50').catch(() => ({rows: []})),
  ]);
  const list = users.users || [];
  const memberN = list.filter(u => u.role !== 'admin' && u.disabled !== 2).length;
  const adminN = list.filter(u => u.role === 'admin').length;
  const paperN = list.reduce((n, u) => n + (u.papers || 0), 0);
  const diskN = list.reduce((n, u) => n + (u.disk_used || 0), 0);
  const costN = list.reduce((n, u) => n + (u.month_cost || 0), 0);
  const auditRows = (audit.rows || []).filter(r => r.action !== 'login');

  const quotaSummary = ov => {
    const keys = ['daily_parse_papers', 'max_file_mb', 'max_pages', 'max_disk_gb', 'monthly_budget_cny'];
    const hit = keys.filter(k => ov[k] !== undefined && ov[k] !== null);
    return hit.length
      ? `<span class="badge run" title="${hit.join('、')}">${hit.length} 项自定义</span>`
      : '<span class="muted" style="font-size: var(--fs-xs)">默认</span>';
  };
  const stateBadge = u => u.disabled === 2 ? '<span class="badge dim">已注销</span>'
    : u.disabled === 1 ? '<span class="badge err">已禁用</span>'
    : u.role === 'admin' ? '<span class="badge ok">管理员</span>'
    : '<span class="badge ok">正常</span>';

  el.innerHTML = `
    <h2 class="page-h">${icon('crown')} 管理后台</h2>

    <div class="adm-stats">
      <div class="adm-stat"><span class="muted">成员</span><b>${memberN}</b><span class="muted">人活跃 · 管理员 ${adminN}${list.filter(u => u.disabled === 2).length ? ` · 已注销 ${list.filter(u => u.disabled === 2).length}` : ''}</span></div>
      <div class="adm-stat"><span class="muted">论文</span><b>${paperN}</b><span class="muted">篇 · 全员合计</span></div>
      <div class="adm-stat"><span class="muted">磁盘</span><b>${fmtGB(diskN).toFixed(1)}</b><span class="muted">GB 已用</span></div>
      <div class="adm-stat"><span class="muted">本月花费</span><b>¥${costN.toFixed(2)}</b><span class="muted">LLM 调用估算</span></div>
    </div>

    <div class="set-card">
      <div class="set-head">${icon('user')} 成员管理
        <span class="muted" style="font-weight:400">限额留空=默认值；超限在调用前拦截</span>
        <span class="spacer"></span>
        <select id="invite-days" style="width:auto;font-size: var(--fs-sm)">
          <option value="3">3 天</option><option value="7" selected>7 天</option>
          <option value="14">14 天</option><option value="30">30 天</option>
        </select>
        <button class="btn small primary" onclick="createInvite()">${icon('plus')} 生成邀请码</button>
      </div>
      <div id="invite-out" style="margin:2px 0 10px;font-size: var(--fs-base)"></div>
      <table class="list adm-table">
        <tr><th>成员</th><th>状态</th><th class="num">论文</th><th class="num">磁盘</th>
            <th class="num">本月花费</th><th>限额</th><th style="width:auto"></th></tr>
        ${list.filter(u => u.disabled !== 2).map(u => {
          const ov = (() => { try { return JSON.parse(u.overrides || '{}'); } catch { return {}; } })();
          state._quotaRaw = state._quotaRaw || {};
          state._quotaRaw[u.id] = ov;
          const isSelf = u.id === state.me.id;
          return `<tr>
            <td><b>${esc(u.username)}</b>${u.role === 'admin' ? ' <span class="muted" style="font-size: var(--fs-xs)">admin</span>' : ''}</td>
            <td>${stateBadge(u)}</td>
            <td class="num">${u.papers || 0}</td>
            <td class="num">${fmtGB(u.disk_used).toFixed(2)}G</td>
            <td class="num">¥${Number(u.month_cost || 0).toFixed(2)}</td>
            <td>${quotaSummary(ov)}</td>
            <td class="row-actions">
              <details class="adm-menu">
                <summary class="btn small" title="更多操作" aria-label="更多操作">更多 ▾</summary>
                <div class="tool-pop adm-menu-pop">
                  <div class="tp-item" onclick="openQuotaDialog(${u.id});this.closest('details').removeAttribute('open')">${icon('sliders')} 编辑限额</div>
                  <div class="tp-item" onclick="resetUserPw(${u.id}, '${esc(u.username)}');this.closest('details').removeAttribute('open')">${icon('key')} 重置密码</div>
                  ${!isSelf && u.role !== 'admin' && !u.disabled ? `<div class="tp-item" onclick="deleteUser(${u.id}, '${esc(u.username)}');this.closest('details').removeAttribute('open')">${icon('trash')} 注销账号</div>` : ''}
                  ${!isSelf && !u.disabled ? `<div class="tp-item" onclick="toggleUser(${u.id}, '${esc(u.username)}', true);this.closest('details').removeAttribute('open')">${icon('stop')} 禁用登录</div>` : ''}
                  ${u.disabled === 1 ? `<div class="tp-item" onclick="toggleUser(${u.id}, '${esc(u.username)}', false);this.closest('details').removeAttribute('open')">${icon('play')} 重新启用</div>` : ''}
                </div>
              </details>
            </td></tr>`;
        }).join('')}
      </table>
      ${(() => {
        const gone = list.filter(u => u.disabled === 2);
        if (!gone.length) return '';
        return `<details class="adm-gone"><summary class="muted">已注销 ${gone.length} 个账号（论文保留，可恢复）</summary>
          <table class="list adm-table" style="margin-top:6px">
            ${gone.map(u => `<tr><td class="muted" style="font-size: var(--fs-sm)">${esc(u.username)}</td>
              <td class="muted" style="font-size: var(--fs-xs)">已注销</td>
              <td class="num">${u.papers || 0}</td>
              <td colspan="4"></td></tr>`).join('')}
          </table></details>`;
      })()}
    </div>

    <div class="set-card">
      <div class="set-head">${icon('stack')} 公共额度池
        <span class="muted" style="font-weight:400">未配置 key 的成员可用管理员的 key 调用</span></div>
      <div class="pool-row">
        <span class="badge ${pool.enabled ? 'ok' : 'priv'}">${pool.enabled ? '已开启' : '已关闭'}</span>
        <span class="muted" style="font-size: var(--fs-sm)">${pool.enabled ? '成员未配 key 时走公共池' : '成员必须各自配置 key'}</span>
        <span class="spacer"></span>
        <button class="btn small ${pool.enabled ? 'danger' : 'primary'}" onclick="togglePool(${!pool.enabled})">${pool.enabled ? '关闭' : '开启'}</button>
      </div>
    </div>

    <div class="set-card">
      <div class="set-head">${icon('clock')} 审计日志
        <span class="muted" style="font-weight:400">敏感操作留痕（登录不计）</span></div>
      ${auditRows.length ? `<table class="list adm-table">
        <tr><th style="width:110px">时间</th><th style="width:110px">操作者</th><th>操作</th></tr>
        ${auditRows.slice(0, 8).map(r => `<tr>
          <td class="muted" style="font-size: var(--fs-xs)">${esc(relTime(r.created_at))}</td>
          <td style="font-size: var(--fs-sm)">${esc(r.username || '系统')}</td>
          <td style="font-size: var(--fs-sm)">${esc(auditActionName(r.action))}${r.detail ? ` <span class="muted">${esc(String(r.detail).slice(0, 40))}</span>` : ''}</td>
        </tr>`).join('')}
      </table>${auditRows.length > 8 ? `<div style="padding:6px 0 0"><button class="btn small" id="audit-more">展开其余 ${auditRows.length - 8} 条</button></div>` : ''}`
        : '<p class="muted">暂无记录——删除/重置密码/禁用等敏感操作会记录在此</p>'}
    </div>`;

  const more = $('#audit-more');
  if (more) more.onclick = () => renderAdminZone();
}

/* 限额编辑弹窗：5 个数字字段（留空=默认），保存复用 saveQuota */
function openQuotaDialog(uid) {
  const ov = (state._quotaRaw || {})[uid] || {};
  // suf = DOM 后缀（saveQuota 按后缀取值），key = 后端语义键（ov 里存的是语义键）
  const f = (suf, key, label, ph, min) => `<label class="adm-q-row"><span>${label}</span>
    <input id="q-${uid}-${suf}" type="number" min="${min}" style="width:100px;font-size: var(--fs-sm)"
      value="${ov[key] ?? ''}" placeholder="${ph}"></label>`;
  const {pop, close} = openPop('adm-quota-pop');
  pop.innerHTML = `
    <div class="ui-pop-title">编辑限额 <span class="muted" style="font-weight:400">留空 = 使用默认值</span></div>
    <div class="adm-q-grid">
      ${f('dp', 'daily_parse_papers', '每日解析篇数', '200', 1)}
      ${f('fm', 'max_file_mb', '单文件上限 MB', '100', 1)}
      ${f('pp', 'max_pages', '单篇页数', '500', 1)}
      ${f('dk', 'max_disk_gb', '磁盘上限 GB', '20', 1)}
      ${f('bg', 'monthly_budget_cny', '月预算 ¥', '不限', 0)}
    </div>
    <div class="muted" style="font-size: var(--fs-xs);margin-top:6px">预算超限会在调用前拦截；解析篇数/页数/磁盘按上限校验。</div>
    <div class="ui-pop-foot">
      <button class="btn small" data-cancel>取消</button>
      <button class="btn small primary" data-ok>保存</button>
    </div>`;
  pop.querySelector('[data-cancel]').onclick = close;
  pop.querySelector('[data-ok]').onclick = async () => { await saveQuota(uid); close(); };
}
window.openQuotaDialog = openQuotaDialog;
/* 管理区动作（48b9862 改造时误删了实现，按钮留着 → 一按就 ReferenceError） */
window.createInvite = async () => {
  const days = +($('#invite-days')?.value || 7);
  const d = await api(`/api/admin/invite?days=${days}`, {method: 'POST'});
  const el = $('#invite-out');
  if (el) el.innerHTML = `邀请码: <code style="font-size: var(--fs-md)">${d.code}</code>（${d.expires_in_days} 天内有效，一次性）`
    + ` <button class="btn small" onclick="copyText('${d.code}', '邀请码已复制，转交给新成员')">复制</button>`;
};
window.logoutAll = async () => {
  if (!(await uiConfirm('登出所有设备？其他已登录的会话将全部失效（本设备保持登录）。', {title: '登出所有设备', danger: true}))) return;
  await api('/api/logout-all', {method: 'POST'});
  toast('其他设备已登出（本设备保持登录）');
};
window.toggleUser = async (uid, uname, disable) => {
  const act = disable ? '禁用' : '重新启用';
  if (!(await uiConfirm(`${act}用户 ${uname}？${disable ? '该用户将无法登录，已有会话全部失效。' : ''}`, {title: `${act}用户`, danger: disable}))) return;
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

/* 结构化限额编辑：4 个数字字段 + 保留结构化编辑器之外的历史键（_quotaRaw 渲染时缓存） */
window.saveQuota = async uid => {
  const ov = {...((state._quotaRaw || {})[uid] || {})};
  const num = (suf, key) => {
    const v = $(`#q-${uid}-${suf}`)?.value.trim();
    if (v) ov[key] = +v; else delete ov[key];
  };
  num('dp', 'daily_parse_papers');
  num('fm', 'max_file_mb');
  num('pp', 'max_pages');
  num('dk', 'max_disk_gb');
  num('bg', 'monthly_budget_cny');
  try {
    await api(`/api/admin/users/${uid}/quota`, {method: 'PUT', body: JSON.stringify(ov)});
    toast('已保存限额'); renderAdminZone();
  } catch (e) { toast('保存失败: ' + e.message); }
};
window.deleteUser = async (uid, uname) => {
  const inp = await uiPrompt(`注销账号 <b>${esc(uname)}</b>？将立即禁用并匿名化用户名（其论文保留、归属不变，可恢复）。<br>输入用户名以确认：`,
                             {placeholder: uname, okText: '确认注销', html: true});
  if (inp === null) return;
  if (inp.trim() !== uname) { toast('用户名不匹配，已取消'); return; }
  try {
    await api(`/api/admin/users/${uid}`, {method: 'DELETE'});
    toast('已注销'); renderAdminZone();
  } catch (e) { toast('操作失败: ' + e.message); }
};
/* 预算与单价设置：预算=0 表示不设闸（默认不拦）；单价覆盖按你的实际定价填 */
window.openBudgetDialog = async () => {
  const q = await api('/api/me/quota').catch(() => null);
  if (!q) { toast('无法读取当前用量'); return; }
  const cur = q.budget || 0;
  const v = await uiPrompt(`月预算（元）——超过后拦截问答/翻译/导读/综述调用；填 0 表示不设闸。<br>
    当前本月已花 ¥${Number(q.month_cost || 0).toFixed(2)}`,
    {value: cur ? String(cur) : '', placeholder: '如 50（不设=留空）', okText: '保存'});
  if (v === null) return;
  const parsed = parseFloat(v);
  if (v !== '' && v !== null && !Number.isFinite(parsed)) { toast('请输入有效金额（数字）'); return; }
  if (Number.isFinite(parsed) && parsed < 0) { toast('预算不能为负'); return; }
  const budget = Number.isFinite(parsed) ? parsed : 0;
  try {
    await api('/api/me/budget', {method: 'PUT', body: JSON.stringify({budget})});
    toast(budget ? `月预算已设为 ¥${budget}` : '已取消预算（不再拦截）');
    renderMeQuota();
  } catch (e) { toast('保存失败: ' + e.message); }
};
window.togglePool = async enable => {
  await api('/api/admin/pool', {method: 'POST', body: JSON.stringify({enabled: enable})});
  toast(enable ? '公共池已开启' : '公共池已关闭');
  renderAdminZone();
};
window.testLlm = async fid => {
  const f = new FormData($('#' + fid));
  // key 留空 = 测试已保存配置（表单里的 base_url/模型仍生效）
  const r = await api('/api/settings/llm/test', {method: 'POST', body: JSON.stringify({
    base_url: f.get('base_url'), api_key: f.get('api_key'),
    model: f.get('model'), api_type: f.get('api_type'), purpose: fid.replace('f-', '')})});
  toast(r.ok ? '✅ ' + r.message : '❌ ' + r.message);
};
async function loadGlossary() {
  const d = await api('/api/glossary');
  const el = $('#gl-list');
  if (!el) return;
  el.innerHTML = d.terms.map(t =>
    `<span class="chip">${esc(t.term)}${t.target === 'trans' ? ' → ' + esc(t.value) : t.target === 'first_both' ? ' ⇄ ' + esc(t.value) : ' (EN)'}
     <button class="hover-only" title="删除该术语" onclick="delGlossary('${jsArg(t.term)}')">${icon('close')}</button></span>`).join('') ||
    '<span class="muted" style="font-size: var(--fs-sm)">暂无术语——按需添加以保证全文译名一致</span>';
  $('#gl-add').onclick = async () => {
    const term = $('#gl-term').value.trim();
    if (!term) { toast('请输入术语'); return; }
    const target = $('#gl-target').value, value = $('#gl-value').value.trim();
    if (target !== 'keep_en' && !value) { toast('该模式需要填写译法（否则该术语不会生效）'); return; }
    await api('/api/glossary', {method: 'POST', body: JSON.stringify({
      term, target, value})});
    $('#gl-term').value = ''; $('#gl-value').value = '';
    toast('已添加，下次翻译生效'); loadGlossary();
  };
}
window.delGlossary = async term => {
  if (!(await uiConfirm(`删除术语「${term}」？之后翻译将不再套用该术语。`, {title: '删除术语'}))) return;
  try {
    await api('/api/glossary/' + encodeURIComponent(term), {method: 'DELETE'});
    toast('已删除术语'); loadGlossary();
  } catch (e) { toast(friendlyError(e, '删除失败，请重试')); }
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
        ${(f.sub_captions || []).length ? `<p class="muted" style="font-size: var(--fs-xs)">${esc(f.sub_captions.join(' | ').slice(0, 200))}</p>` : ''}
        ${capHtml(f.caption || '', `cap-${f.page_index}-${(f.image_path || '').replace(/\W/g, '')}`)}
      </div>`;
    }
    const t = it.t;
    return `<div class="asset">
      ${t.label ? `<span class="asset-badge" title="跳到 PDF 该页" onclick="jumpEvidence(${t.page_index})">${esc(t.label)}</span>` : ''}
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
  const sec = Object.entries(s.sections || {}).filter(([k]) => k !== 'followups');   // followups 走追问按钮，不作章节卡
  const evById = new Map((s.evidence || []).map(e => [String(e.evidence_id), e]));
  const citeMap = s.cite_map || {};
  const secHtml = sec.map(([k, v]) => {
    const local = citeMap[k] || {};
    // 编号由后端跨字段连续分配（整篇 [1][2][3]…），此处只做可点击渲染
    const html = mdLite(v).replace(/\[(\d{1,3})\]/g, (m, n) => {
      const gid = local[n];
      const ev = gid != null ? evById.get(String(gid)) : null;
      if (!ev) return m;                                   // 无对应证据 → 留原文
      const tip = `第${ev.page_index + 1}页 · ${(ev.text || '').slice(0, 120).replace(/\s+/g, ' ')}`;
      return `<span class="cite" data-gid="${gid}" title="${esc(tip)}">[${n}]</span>`;
    });
    return `<div class="summary-sec"><h3>${SUMMARY_NAMES[k] || k}</h3><div class="summary-body">${html}</div></div>`;
  }).join('');
  t.innerHTML = (asBubble ? (state._sumHead || '') + '<div class="msg assistant"><div class="bubble" style="width:100%">' : '<div class="card">') +
    (asBubble ? `<b class="sum-toggle" data-sum-toggle title="点击展开/收起导读">${icon('copy')} 导读（9 字段）<span class="sum-arrow">▾</span></b>` : '<h2>科研导读</h2>') +
    (sec.length ? secHtml : '<p class="muted">导读内容为空，请重新生成。</p>') +
    `</div>${asBubble ? '</div>' : ''}<button class="btn small" onclick="genSumBubble('${pid}')">${icon('retry')} 重新生成</button>`;
  if (asBubble) {
    t.insertAdjacentHTML('beforeend', followupButtons(s.sections));
    t.classList.add('sum-fold');   // 导读气泡默认收起——9 字段全文占问答区半屏
    t.querySelector('[data-sum-toggle]')?.addEventListener('click', () => t.classList.toggle('sum-fold'));
  }
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
state.scope = '';                                           // 侧栏快捷范围筛选
state.libQuery = '';                                        // 管理页搜索词
state._libPage = 1; state._libPageSize = 25;                // 文库表格真分页（25 篇/页）
state.libLevel = 1;                                         // 管理页层级: 1=库列表 2=库内
state.libView = 'card';                                     // 库列表视图: card | list
state._libQTimer = 0;
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

/* 文库管理搜索框：两处渲染路径共用一份防抖逻辑（原先两份几乎逐行相同的闭包） */
function bindLibMgrQ() {
  const qIn = $('#lib-mgr-q');
  if (!qIn) return;
  qIn.oninput = debounce(async e => {
    state.libQuery = e.target.value;
    state._libPage = 1;              // 换搜索词回到第一页
    await renderCollectionsPage();   // 等重渲染完成再恢复焦点，否则焦点落在被替换的旧节点上
    const n = $('#lib-mgr-q');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }, 300);
}

function bindLibMgrToolbar() {
  bindLibMgrQ();
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
  if (!state._scopeAllIds[scopeKey] || state._scopeAllIds._at !== scopeKey + '|' + (state.libSel || '') + '|' + (state.libQuery || '')) {
    const scopeQ = new URLSearchParams();
    if (scopeIds.length) scopeQ.set('collection_id', scopeIds.join(','));
    if (q) scopeQ.set('q', state.libQuery);
    scopeQ.set('all', '1');
    try {
      const ad = await api('/api/papers?' + scopeQ.toString());
      state._scopeAllIds[scopeKey] = (ad.papers || []).map(x => x.id);
      state._scopeAllIds._at = scopeKey + '|' + (state.libSel || '') + '|' + (state.libQuery || '');
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
    // 多库归属：显示全部所属库名（挂 N 库一目了然）
    const ownerNames = (p.collection_ids || [])
      .map(cid => (d.collections.find(c => c.id === cid) || {}).name)
      .filter(Boolean);
    return `<tr class="lib-paper-row" onclick="viewPaper('${p.id}')">
        <td style="width:26px" onclick="event.stopPropagation()"><input type="checkbox" class="lib-ck" data-cid="${scopeKey}" data-pid="${p.id}" ${selBucket(scopeKey).has(p.id) ? 'checked' : ''} onchange="libCk('${scopeKey}')"></td>
        <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis" title="${esc(p.title || '')}">
          ${p.read_status ? '' : '<span class="unread-dot" title="未读" style="margin-right:4px"></span>'}${esc(p.title || p.id)}
          ${ownerNames.length && scopeIds.length > 1 ? `<span class="muted" style="font-size: var(--fs-xs)"> · ${esc(ownerNames.join(' · '))}</span>` : ''}
          ${p.owner_name && p.owner_id !== state.me?.id ? `<span class="muted" style="font-size: var(--fs-xs)" title="上传者"> · ${esc(p.owner_name)}</span>` : ''}</td>
        <td>${parseBadge}${p.parse_status === 'failed' ? `<button class="btn small" title="重试解析与翻译（两者一起重新排队）" onclick="event.stopPropagation();retryPaperJob('${p.id}')">${icon('retry')}</button>` : ''}</td>
        <td>${trBadge}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <button class="btn small danger hover-only" title="移入回收站（移库：勾选后用上方批量条）" onclick="delPaperFromLib('${p.id}')">${icon('trash')}</button>
        </td></tr>`;}).join('');

  // ---- 组装 ----
  const selName = sel ? (d.collections.find(c => c.id === sel)?.name || '') : '';
  const selNameArg = jsArg(selName);   // 塞进内联 onclick 的参数（引号/&/双引号全兜）
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
          <button class="btn small danger hover-only" title="删除库（论文移出该库；无主论文进回收站）" onclick="delLib('${sel}', '${selNameArg}')">${icon('trash')}</button>` : ''}
        </div>
        ${subLibs.length ? `<div class="lib-subbar">
          <span class="muted" style="font-size: var(--fs-sm)">子库：</span>
          ${subLibs.map(k => `<span class="chip" onclick="libOpenLib('${k.id}')" style="cursor:pointer">${icon('folder')} ${esc(k.name)} · ${k.papers ?? 0} 篇</span>`).join('')}
        </div>` : ''}
        <div class="lib-batch" id="lb-${scopeKey}" hidden>
          <b id="lb-count-${scopeKey}">0</b>&nbsp;篇选中
          <button class="btn small primary" onclick="libBatchTranslate('${scopeKey}')">${icon('globe')} 翻译</button>
          <button class="btn small" onclick="libBatchSynth('${scopeKey}')" title="自动分组比对生成综述报告">综述</button>
          <select style="width:auto;font-size: var(--fs-sm)" onchange="libBatchMove('${scopeKey}', this.value, this)"><option value="">加入库…</option><option value="__remove__">从本库移出</option>${moveOpts(sel)}</select>
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
    state._libScopeAll = allIds;   // 范围全量 id（跨页）——导出用，此前误用当前页 papers
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
  bindLibMgrQ();
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
    if (!pop.hidden) anchorPop(pop, btn);
    return;
  }
  const zip = e.target.closest?.('#export-zip-btn');
  if (zip) {
    const scope = document.querySelector('input[name="exp-scope"]:checked')?.value || 'scope';
    const ids = scope === 'sel'
      ? libSelected(state._libScopeKey)
      : (state._libScopeAll || (state._libScopePapers || []).map(p => p.id));
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
      await downloadBlob(url, payload,
        fmts.length === 1 && fmts[0] === 'bibtex' ? 'references.bib' : '论文导出.zip',
        `已导出 ${ids.length} 篇（跳过项见压缩包内清单）`);
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
// 范围全量 id 缓存失效：所有改变论文集合的动作（挂链/删除/恢复/清空回收站）后调用。
// 此前只有挂链一处清，批删/恢复/清空回收站后导出仍用旧 id 集（含已删行）。
function invalidateScopeIds() {
  state._scopeAllIds = {};
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
    // 全选【当前范围】的全部论文（跨页）——后端 all=1；范围=子树（与列表查询一致）
    try {
      const ids = cid === 'all' ? [] : [cid, ...colDescendants(cid)];
      const scope = ids.length ? `collection_id=${encodeURIComponent(ids.join(','))}` : '';
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
  if (ids.length >= 10 && !(await uiConfirm(`批量翻译 ${ids.length} 篇？（按篇分批调用 LLM——已有完整译文的自动跳过；预计耗时数分钟）`,
      {title: '批量翻译'}))) return;
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
  if (!ids.length) { toast('先勾选论文'); return; }
  const remove = v === '__remove__';
  const target = remove ? scopeLibId(cid) : v;
  if (remove && !target) { toast('当前是「全部文献」视图——请先进某个库再移出'); sel.value = ''; return; }
  if (remove) {
    if (!(await uiConfirm(`从本库移出选中的 ${ids.length} 篇？（论文本体不动；移出唯一所属库的论文将落「未归类」）`,
                          {title: '从本库移出', danger: true}))) { sel.value = ''; return; }
  }
  await withBusy(sel, async () => {
    sel.value = '';
    try {
      await api(remove ? '/api/papers/batch-unlink' : '/api/papers/batch-link',
                {method: 'POST', body: JSON.stringify({paper_ids: ids, collection_id: target})});
      toast(remove ? `已从本库移出 ${ids.length} 篇（论文本体不动）` : `已加入库 ${ids.length} 篇`);
    } catch (e) { toast(friendlyError(e, '操作失败，请重试')); return; }
    invalidateScopeIds();   // 挂链变更 → 各范围全量 id 缓存失效
    await refreshLib();
  }, '操作失败，请重试');
};
// scopeKey（'全部文献' 视图为 'all'）→ 当前所在库 id（空串=全部视图）
function scopeLibId(scopeKey) {
  return scopeKey === 'all' ? '' : scopeKey;
}
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
  if (!(await uiConfirm(`删除文献库「${name}」？论文将移出该库；不再属于任何库的论文进回收站（30 天内可恢复）`,
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
    invalidateScopeIds();
    toast('已移入回收站', 0, {
      label: '撤销',
      onClick: async () => {
        await api(`/api/papers/${pid}/restore`, {method: 'POST'}).catch(() => {});
        toast('已撤销');
        invalidateScopeIds();
        await refreshLib();
      },
    });
    if (state.current?.id === pid) { state.current = null; state.blocks = []; renderContentView(); }
    state.qaPapers.delete(pid);
    await refreshLib();
  } catch (e) { toast(friendlyError(e, '删除失败，请重试')); }
};

/* 导读后的追问建议 */
/* ===== 12-reader-ui.js —— 阅读器交互：追问/目录/分栏/高亮/主题 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
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
  // 模型生成的 followups（每篇内容定制）优先；缺失时回退通用模板
  const custom = (sections?.followups || '').split(/\n|；|;/).map(x => x.replace(/^[-*\d.、)\s]+/, '').trim())
    .filter(x => x.length >= 6).slice(0, 3);
  const qs = custom.length ? custom
    : Object.keys(sections || {}).map(k => FOLLOWUP_QS[k]).filter(Boolean).slice(0, 5);
  if (!qs.length) return '';
  return `<div class="followups"><span class="muted" style="font-size: var(--fs-sm)">${icon('chat')} 可以接着问：</span>` +
    qs.map(q => `<button class="chip chip-q" onclick="askPreset('${jsArg(q)}')">${esc(q)}</button>`).join('') +
    `</div>`;
}

/* ================= 四项借鉴功能 ================= */

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
        <span class="muted" style="font-size: var(--fs-xs)">· 第${ev.page_index + 1}页</span>
        <div style="margin-top:4px">${esc(snippet.slice(0, 220))}${snippet.length > 220 ? '…' : ''}</div>
        <div class="muted" style="font-size: var(--fs-xs);margin-top:4px">${icon('doc')} 点击定位原文</div>`;
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
      <div class="muted" style="font-size: var(--fs-xs);margin-top:4px">${icon('doc')} 第${ref.page_index + 1}页 · 点击跳转</div>`;
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
    outsideClose(t, $('#toc-btn'));
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
      ${caps.length ? `<figcaption class="muted" style="font-size:var(--fs-xs);line-height:1.5">${esc(caps.join(' ｜ ').slice(0, 300))}</figcaption>` : ''}
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
      ${ta && ta.caption ? `<figcaption class="muted" style="font-size:var(--fs-xs);line-height:1.5">${esc(ta.caption.slice(0, 200))}</figcaption>` : ''}
    </figure>`;
  }
  return mdLite(b.en !== undefined ? b.en : b.text);   // mdLite 已含 esc+katexify+linkifyRefs，并解析 markdown 表格
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
  window.addEventListener('resize', debounce(() => {
    applyVsplit();
    // ≤1100 自动收起侧栏（缩放/分屏场景；仅自动收放，不改写用户手动偏好）
    const narrow = innerWidth < 1100;
    if (narrow && !state.sidebarCollapsed && !state._autoFolded) {
      state._autoFolded = true; state.sidebarCollapsed = true; applySidebarCollapse();
    } else if (!narrow && state._autoFolded) {
      state._autoFolded = false; state.sidebarCollapsed = false; applySidebarCollapse();
    }
  }, 250));
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
  if (t) t.placeholder = '对着文献提问…（Ctrl+Enter 发送）';
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
                     '#discover-pop', '#col-new-form', '#health-pop']) {
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
  const n = (state._trashCount ?? 0);
  if (!(await uiConfirm(
      `将<strong>永久删除</strong>回收站中的 ${n} 篇论文（含译文、索引与会话），<strong>不可恢复</strong>。`,
      {title: '彻底清空回收站', okText: `永久删除 ${n} 篇`, danger: true}))) return;
  try {
    const r = await api('/api/trash/empty', {method: 'POST'});
    toast(`已彻底删除 ${r.purged} 篇`);
    renderTrash(); await refreshLib();
  } catch (e) { toast(friendlyError(e, '清空失败，请重试')); }
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
        <button class="btn small" onclick="renameLib('${c.id}', '${jsArg(c.name)}')" title="重命名">${icon('edit')}</button>
        <button class="btn small danger hover-only" onclick="delLib('${c.id}', '${jsArg(c.name)}')" title="删除库">${icon('trash')}</button>
      </div>
    </div>`;
  };
  const cards = (children['root'] || []).map(c => cardOf(c, false)).join('');
  const total = d.total;
  const myPapers = (d.collections || []).reduce((n, c) => n + (c.papers_total ?? c.papers ?? 0), 0);
  return `<div class="card lib-l1-head">
      <h2 class="page-h row" style="flex:1">${icon('library')} 全部文献库 <span class="muted">${d.collections.length} 个库 · 在库 ${myPapers} 篇${(d.unassigned || 0) ? ` + 未分库 ${d.unassigned} 篇` : ''} = 共 ${total} 篇</span></h2>
      <div class="seg">
        <button class="seg-btn ${state.libView === 'card' ? 'on' : ''}" onclick="setLibView('card')">卡片</button>
        <button class="seg-btn ${state.libView === 'list' ? 'on' : ''}" onclick="setLibView('list')">列表</button>
      </div>
    </div>
    ${state.libView === 'card'
      ? `<div class="lib-cards">${cards || `<div class="empty-state">
          <p class="t">还没有文献库</p>
          <p style="margin-bottom:12px">用文献库把论文按主题分组（可建子库，最多三级）</p>
          <button class="btn primary" onclick="document.querySelector('#newlib-name')?.focus()">${icon('plus')} 新建文献库</button>
        </div>`}</div>`
      : `<table class="list" style="margin-top:4px">
          <tr><th>库名</th><th>论文</th><th>子库</th><th></th></tr>
          ${(() => {
            // 树序遍历（父库紧跟其子库，缩进才对得上层级）——原先按 API 返回顺序平铺，
            // 子库排在前一个兄弟后面时会被误看成它的子库
            const kidsOf = cid => (children[cid] || [])
              .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
            const ordered = [];
            const walk = cid => { for (const k of kidsOf(cid)) { ordered.push(k); walk(k.id); } };
            walk('root');
            if (!ordered.length) return `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">
              还没有文献库 —— <button class="btn small primary" onclick="document.querySelector('#newlib-name')?.focus()">${icon('plus')} 新建文献库</button></td></tr>`;
            return ordered.map(c => `<tr class="lib-row" onclick="libOpenLib('${c.id}')">
              <td>${'　'.repeat(treeDepth(c.id))}${icon('folder')} ${esc(c.name)}</td>
              <td>${c.papers ?? 0}</td><td>${(children[c.id] || []).length}</td>
              <td class="row-actions" onclick="event.stopPropagation()">
                <button class="btn small" title="上传到此库" onclick="libUpload('${c.id}')">${icon('upload')}</button>
                <button class="btn small" title="重命名" onclick="renameLib('${c.id}', '${jsArg(c.name)}')">${icon('edit')}</button>
                <button class="btn small danger hover-only" title="删除库" onclick="delLib('${c.id}', '${jsArg(c.name)}')">${icon('trash')}</button>
              </td></tr>`).join('');
          })()}
        </table>`}`;
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
      // fixed 定位：工具条 overflow-x:auto 会把 absolute 弹层裁掉——原先整框被剪到不可见
      anchorPop(pop, btn);
    }
  });
  outsideClose(pop, btn);
  $$('#download-pop .tp-item[data-dl]').forEach(it => it.addEventListener('click', () => {
    const fmt = it.dataset.dl;
    const pid = state.current?.id;
    if (!pid) { toast('请先打开一篇论文'); return; }
    if (it.classList.contains('disabled')) { toast(it.title || '该格式暂不可用（需先完成翻译/解析）'); return; }
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


// 调试功能默认隐藏：版面框（解析质检）与 JSON 视图——地址栏加 ?debug=1 显示
if (!new URLSearchParams(location.search).has('debug')) {
  $('#layout-btn')?.setAttribute('hidden', '');
  const jb = document.querySelector('.view-tabs [data-v="json"]');
  if (jb) jb.hidden = true;
}

/* ================= 命令面板（Ctrl+K）+ 全局快捷键 + 帮助层 =================
   功能多了之后入口藏得深——面板把 页面/动作/论文/设置 变成一键可达。 */

/* ===== 论文讨论区（组内成员共享；阅读页右栏按钮 → 面板） ===== */
(() => {
  const btn = $('#discuss-open'), panel = $('#discuss-panel');
  if (!btn || !panel) return;
  panel.innerHTML = `
    <div style="padding:8px 12px;font-weight:600;font-size: var(--fs-base);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
      ${icon('chat')} 论文讨论
      <span class="spacer"></span>
      <button class="btn small" id="discuss-close">${icon('close')}</button>
    </div>
    <div id="discuss-msgs" style="max-height:60vh;overflow-y:auto;padding:8px 12px"></div>
    <div style="display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--border)">
      <input id="discuss-input" placeholder="写一条讨论…" style="flex:1;min-width:0">
      <button class="btn small primary" id="discuss-send">发送</button>
    </div>`;

  let curPaper = null;
  let _replyTo = null, _replyAuthor = '';

  const emptyHint = '<p class="muted" style="padding:8px;font-size: var(--fs-sm)">还没有讨论——写第一条</p>';

  const msgHtml = (m, pid) => `
    <div class="discuss-msg" data-mid="${m.id}">
      <div style="display:flex;align-items:center;gap:6px">
        <b style="font-size: var(--fs-xs)">${esc(m.username || m.author_id)}</b>
        <span class="muted" style="font-size: var(--fs-xs)">${relTime(m.created_at)}</span>
        <button class="btn small hover-only" style="padding:0 4px" title="回复"
                onclick="replyDiscuss('${m.id}','${esc((m.username || '').slice(0, 20))}')">${icon('chat', 12)}</button>
        ${m.author_id === state.me?.id ? `<button class="btn small hover-only" style="padding:0 4px" onclick="delDiscuss('${pid}','${m.id}')" title="删除">${icon('trash', 12)}</button>` : ''}
      </div>
      <div style="font-size: var(--fs-sm);margin-top:2px;white-space:pre-wrap">${m.reply_to ? `<span class="muted" style="font-size: var(--fs-xs)">↳ 回复 @${m.reply_author || '…'}：</span>` : ''}${esc(m.content)}</div>
    </div>`;

  async function load() {
    if (!curPaper) return;
    try {
      const d = await api(`/api/papers/${curPaper}/discuss`);
      const el = $('#discuss-msgs');
      if (!el) return;
      el.innerHTML = (d.messages || []).map(m => msgHtml(m, curPaper)).join('') || emptyHint;
      el.scrollTop = el.scrollHeight;
    } catch (e) { /* 静默 */ }
  }
  window.delDiscuss = async (pid, mid) => {
    try {
      await api(`/api/papers/${pid}/discuss/${mid}`, {method: 'DELETE'});
      toast('已删除');
    } catch (e) { return toast(friendlyError(e, '删除失败')); }
    // 删除后立即重拉（此前要关开面板才能看到变化）
    if (pid === curPaper && !panel.hidden) load();
  };
  window.replyDiscuss = (mid, author) => {
    _replyTo = mid; _replyAuthor = author;
    const inp = document.querySelector('#discuss-input');
    if (inp) { inp.value = `@${author} `; inp.focus(); }
    const rep = document.querySelector('#discuss-reply-indicator');
    if (rep) { rep.textContent = `回复 @${author}`; rep.hidden = false; }
  };

  const doSend = async () => {
    const inp = $('#discuss-input');
    const content = (inp?.value || '').trim();
    if (!content || !curPaper) return;
    inp.value = '';
    const body = {content};
    if (_replyTo) { body.reply_to = _replyTo; _replyTo = null; _replyAuthor = ''; repInd.hidden = true; }
    try {
      await api(`/api/papers/${curPaper}/discuss`, {method: 'POST', body: JSON.stringify(body)});
      await load();
    } catch (e) { toast(friendlyError(e, '发送失败')); }
  };

  btn.addEventListener('click', () => {
    // 没选中论文时不打开：讨论区是 per-paper 的，空面板只剩一个输入框（发送也静默无效）
    if (panel.hidden && !state.current?.id) { toast('讨论区属于单篇论文——先在左侧选择一篇论文', 3000); return; }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      curPaper = state.current?.id || null;
      panel.style.zIndex = '70';
      panel.style.width = '360px';
      panel.style.maxWidth = '94vw';
      panel.style.background = 'var(--panel)';
      panel.style.border = '1px solid var(--border)';
      panel.style.borderRadius = 'var(--r-lg)';
      panel.style.boxShadow = '0 12px 36px rgba(0,0,0,.18)';
      anchorPop(panel, btn);          // 锚到按钮下方（并清 left——tool-pop 样式表的 left:8px 不清会钉死左上角）
      const el = $('#discuss-msgs');
      if (el) { el.innerHTML = emptyHint; }   // 先给空态，加载完替换——面板不再只剩输入框
      load();
    }
  });
  $('#discuss-close')?.addEventListener('click', () => panel.hidden = true);
  // 点外关闭
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) panel.hidden = true;
  });

  // 回复指示条
  const repInd = document.createElement('div');
  repInd.id = 'discuss-reply-indicator';
  repInd.hidden = true;
  repInd.style.cssText = 'padding:4px 12px;font-size:var(--fs-xs);color:var(--primary);display:flex;align-items:center;gap:6px';
  panel.insertBefore(repInd, panel.querySelector('#discuss-msgs')?.nextSibling);

  $('#discuss-send')?.addEventListener('click', doSend);
  // Enter 发送（此前 onkeydown 调用的 sendDiscuss() 不存在——Enter 发送是死的）
  $('#discuss-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
})();
/* ===== 13-cmd.js —— 命令面板与快捷键 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
const CMD_PAGES = [
  {label: '阅读', hint: '页面', kw: 'read 阅读论文', run: () => switchPage('reader')},
  {label: '文库管理', hint: '页面', kw: 'collections 文库 库', run: () => switchPage('collections')},
  {label: '采集文献 / 专题跟踪', hint: '动作', kw: 'collect 采集 专题 知网 chinaxiv', run: () => { switchPage('collections'); setTimeout(() => openCollectPanel(), 200); }},
  {label: '任务中心', hint: '页面', kw: 'tasks 任务 队列 进度', run: () => switchPage('tasks')},
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
/* ===== 14-tracker.js —— 文献追踪：订阅巡逻 → 收件箱审阅 → 收进文献库 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */

const ARXIV_CAT_PRESETS = ['cs.CV', 'eess.IV', 'cs.GR', 'cs.LG', 'cs.AI', 'cs.CL', 'physics.optics', 'math.AP'];

function trackerTierBadge(tier) {
  const map = {core: ['核心', 'ok'], proxy: ['相关', 'run'], eco: ['生态', 'dim']};
  const [label, cls] = map[tier] || [tier, 'dim'];
  return `<span class="badge ${cls}" title="${label}层">${label}</span>`;
}

function trackerCondSummary(s) {
  const parts = [];
  const kws = (s.keywords || '').split(',').map(x => x.trim()).filter(Boolean);
  const cats = (s.categories || '').split(/\s+/).filter(Boolean);
  const jns = (s.journals || '').split(',').map(x => x.trim()).filter(Boolean);
  const exc = (s.exclude || '').split(',').map(x => x.trim()).filter(Boolean);
  if (kws.length) parts.push(`关键词 ${kws.length}`);
  if (cats.length) parts.push(`分类 ${cats.join(' ')}`);
  if (jns.length) parts.push(`期刊 ${jns.length}`);
  if (exc.length) parts.push(`排除 ${exc.length}`);
  return parts.join(' · ') || '未配置';
}

function trackerSubFormHtml(s = null) {
  const isEdit = !!s;
  const cats = isEdit ? (s.categories || '').split(/\s+/).filter(Boolean) : [];
  const chips = ARXIV_CAT_PRESETS.map(c =>
    `<span class="chip-btn ${cats.includes(c) ? 'on' : ''}" data-cat="${c}"
           onclick="trackerToggleCat(this, '${c}')">${c}</span>`).join(' ');
  const auto = isEdit ? (s.llm_auto || 'core') : 'core';
  return `
  <div class="set-card" id="tracker-sub-form" style="margin:10px 0">
    <div class="set-head">${isEdit ? '编辑订阅' : '新建订阅'}</div>
    <div style="display:grid;gap:8px;padding:12px 14px">
      <label style="display:flex;gap:8px;align-items:center">名称
        <input id="tk-name" value="${esc(isEdit ? s.name : '')}" placeholder="如：3DGS 前沿" style="flex:1"></label>
      <label style="display:flex;gap:8px;align-items:center">关键词
        <input id="tk-keywords" value="${esc(isEdit ? s.keywords : '')}" placeholder="逗号分隔，命中标题/摘要（如：gaussian splatting, SLAM）" style="flex:1"></label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">arXiv 分类 ${chips}
        <input id="tk-cats" value="${esc(isEdit ? s.categories : '')}" placeholder="或手填：空格分隔" style="flex:1;min-width:180px"></div>
      <label style="display:flex;gap:8px;align-items:center">排除词
        <input id="tk-exclude" value="${esc(isEdit ? s.exclude : '')}" placeholder="逗号分隔（命中即不进收件箱）" style="flex:1"></label>
      <label style="display:flex;gap:8px;align-items:center">顶刊期刊
        <input id="tk-journals" value="${esc(isEdit ? s.journals : '')}" placeholder="逗号分隔期刊名（可空，如：Nature,IEEE Transactions on Pattern Analysis）" style="flex:1"></label>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center">巡逻频率
          <select id="tk-freq" style="width:auto">
            <option value="6" ${isEdit && s.frequency_hours === 6 ? 'selected' : ''}>每 6 小时</option>
            <option value="12" ${isEdit && s.frequency_hours === 12 ? 'selected' : ''}>每 12 小时</option>
            <option value="24" ${(!isEdit || s.frequency_hours === 24) ? 'selected' : ''}>每天</option>
            <option value="72" ${isEdit && s.frequency_hours === 72 ? 'selected' : ''}>每 3 天</option>
            <option value="168" ${isEdit && s.frequency_hours === 168 ? 'selected' : ''}>每周</option>
          </select></label>
        <label style="display:flex;gap:6px;align-items:center">AI 中文摘要
          <select id="tk-auto" style="width:auto">
            <option value="off" ${auto === 'off' ? 'selected' : ''}>不自动（可手动点）</option>
            <option value="core" ${auto === 'core' ? 'selected' : ''}>仅核心层（推荐）</option>
            <option value="all" ${auto === 'all' ? 'selected' : ''}>全部条目</option>
          </select></label>
        <label style="display:flex;gap:6px;align-items:center">收件邮箱
          <input id="tk-email" value="${esc(isEdit ? s.email_to : '')}" placeholder="接收巡逻日报（可空）" style="width:220px"></label>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="tk-mail-on"
          ${isEdit && s.email_enabled ? 'checked' : ''}> 发邮件</label>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="tk-enabled"
          ${!isEdit || s.enabled ? 'checked' : ''}> 启用</label>
      </div>
      ${isEdit && s.last_error ? `<div class="badge err" style="align-self:start">上次错误：${esc(s.last_error.slice(0, 120))}</div>` : ''}
      <div style="display:flex;gap:8px">
        <button class="btn primary" onclick="trackerSave(${isEdit ? `'${s.id}'` : 'null'})">保存</button>
        ${isEdit ? `<button class="btn" onclick="trackerRun('${s.id}')" title="立即按此订阅巡逻一轮">${icon('bolt')} 立即跑一轮</button>` : ''}
        <button class="btn" onclick="trackerCancelEdit()">取消</button>
        ${isEdit ? `<button class="btn danger" style="margin-left:auto" onclick="trackerDel('${s.id}')">${icon('trash')} 删除订阅</button>` : ''}
      </div>
    </div>
  </div>`;
}

function trackerSubCardHtml(s, counts) {
  const last = s.last_run_at ? relTime(s.last_run_at) : '从未';
  return `
  <div class="set-card" style="margin:10px 0">
    <div class="set-head">${esc(s.name)} ${s.enabled ? '' : '<span class="badge dim">已停用</span>'}
      <span style="margin-left:auto;font-size:var(--fs-xs);color:var(--text-2)">
        条件：${esc(trackerCondSummary(s))} · 频率：每 ${s.frequency_hours} 小时 · 上次巡逻：${last}</span></div>
    <div style="display:flex;gap:8px;padding:10px 14px;align-items:center;flex-wrap:wrap">
      ${s.last_error ? `<span class="badge err" title="${esc(s.last_error.slice(0, 150))}">上次出错</span>` : ''}
      <span class="badge ${s.llm_auto === 'off' ? 'dim' : 'ok'}">AI 摘要：${{off: '关', core: '核心层', all: '全部'}[s.llm_auto] || s.llm_auto}</span>
      ${s.email_enabled && s.email_to ? `<span class="badge dim">日报 → ${esc(s.email_to)}</span>` : ''}
      <span style="margin-left:auto"></span>
      <button class="btn small" onclick="trackerRun('${s.id}')">${icon('bolt')} 立即跑一轮</button>
      <button class="btn small" onclick="trackerEdit('${s.id}')">${icon('edit')} 编辑</button>
    </div>
  </div>`;
}

function trackerItemHtml(it, selMap) {
  const checked = selMap.has(it.id) ? 'checked' : '';
  const zh = it.zh_title ? `<div style="font-size:var(--fs-base);margin-top:1px">${esc(it.zh_title)}</div>` : '';
  const code = it.code_url ? ` · <a href="${esc(it.code_url)}" target="_blank" rel="noopener" style="color:var(--primary)">代码 ↗</a>` : '';
  const pdf = it.pdf_url ? ` · <a href="${esc(it.pdf_url)}" target="_blank" rel="noopener" style="color:var(--text-2)">PDF ↗</a>` : '';
  const sum = it.zh_summary ? `<div style="color:var(--text-2);font-size:var(--fs-sm);margin-top:4px">${esc(it.zh_summary)}</div>` : '';
  return `
  <div class="card tracker-item" data-iid="${it.id}" style="padding:12px 14px;margin:8px 0">
    <div style="display:flex;gap:10px;align-items:flex-start">
      <input type="checkbox" class="tk-ck" data-iid="${it.id}" ${checked}
             onchange="trackerCk(this)" style="margin-top:3px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${trackerTierBadge(it.tier)}${it.is_fallback ? '<span class="badge dim" title="核心/相关不足时的补足项">补足</span>' : ''}
          ${it.status !== 'new' ? `<span class="badge dim">${it.status === 'accepted' ? '已收进' : '已忽略'}</span>` : ''}
          <span class="muted" style="font-size:var(--fs-xs)">${esc(it.published || '')} · ${esc(it.venue || '')}
            · ${esc((it.authors || '').slice(0, 90))}${code}${pdf}</span>
        </div>
        <div style="font-weight:600;margin-top:4px"><a href="#" style="color:inherit"
             onclick="return false">${esc(it.title)}</a></div>
        ${zh}${sum}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:none">
        ${it.status === 'new' ? `
          <button class="btn small primary" onclick="trackerAccept('${it.id}', this)">收进文献库</button>
          ${!it.zh_summary ? `<button class="btn small" onclick="trackerEnrich('${it.id}', this)" title="LLM 生成中文总结与标题翻译">AI 摘要</button>` : ''}
          <button class="btn small danger hover-only" onclick="trackerDismiss('${it.id}', this)">忽略</button>` : `
          <span class="badge dim">${it.status === 'accepted' ? `paper: ${String(it.paper_id).slice(0, 12)}` : ''}</span>`}
      </div>
    </div>
  </div>`;
}

function renderTrackerPage() {
  const el = $('#page-tracker');
  el.innerHTML = `<div style="max-width:1080px;margin:0 auto">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 style="margin:0">文献追踪</h2>
      <span class="muted">按关键词/分类/期刊定时巡逻 arXiv 与顶刊，新论文进收件箱审阅后收进文献库</span>
      <span style="margin-left:auto"></span>
      <button class="btn primary" onclick="trackerNew()">${icon('plus')} 新建订阅</button>
    </div>
    <div id="tracker-alert" style="margin-top:8px"></div>
    <div id="tracker-subs"></div>
    <div id="tracker-inbox" style="margin-top:16px"></div>
  </div>`;
  loadTracker();
}
window.renderTrackerPage = renderTrackerPage;

async function loadTracker() {
  const subsEl = $('#tracker-subs'), inboxEl = $('#tracker-inbox');
  if (!subsEl) return;
  let subs, inbox;
  try {
    const tier = state._trackerTier || '';
    const st = state._trackerStatus || 'new';
    const page = state._trackerPage || 1;
    [subs, inbox] = await Promise.all([
      api('/api/tracker/subs'),
      api(`/api/tracker/items?status=${st}&tier=${tier}&page=${page}&page_size=30`),
    ]);
  } catch (e) {
    subsEl.innerHTML = `<div class="empty-state"><p class="t">加载失败</p><p>${esc(friendlyError(e))}</p></div>`;
    return;
  }
  const counts = inbox.counts || {};
  updateTrackerBadge(counts.inbox || 0);

  // 订阅区
  const me = state.me || {};
  const smtpHint = me.role === 'admin'
    ? '' : (subs.smtp_ready ? '' : `<div class="empty-note" style="margin-top:8px">邮件日报需要管理员先在下方配置发件邮箱</div>`);
  const smtpCard = me.role === 'admin' ? trackerSmtpCardHtml(subs.smtp_ready) : '';
  subsEl.innerHTML =
    (state._trackerEdit === 'new' ? trackerSubFormHtml(null) : '') +
    subs.subs.map(s => (state._trackerEdit === s.id ? trackerSubFormHtml(s) : trackerSubCardHtml(s, counts))).join('') +
    (subs.subs.length || state._trackerEdit ? '' :
      `<div class="empty-state"><p class="t">还没有订阅</p>
       <p>点「新建订阅」：填关键词与 arXiv 分类（或顶刊期刊名），系统按频率自动巡逻新论文</p></div>`) +
    smtpCard + (smtpHint || '');
  if (state._trackerEdit !== 'new') {
    const nf = $('#tracker-new-form'); if (nf) nf.remove();
  }

  // 收件箱区
  const st = state._trackerStatus || 'new';
  const tier = state._trackerTier || '';
  const chips = [['', '全部新'], ['core', '核心'], ['proxy', '相关'], ['eco', '生态'], ['all', '全部']]
    .map(([v, label]) => `<span class="chip-btn ${st === v && !tier ? 'on' : ''}" onclick="trackerStatus('${v}')">${label}</span>`).join(' ');
  const tierChips = [['core', '核心'], ['proxy', '相关'], ['eco', '生态']]
    .map(([v, label]) => `<span class="chip-btn ${tier === v ? 'on' : ''}" onclick="trackerTierF('${v}')">${label}</span>`).join(' ');
  const selMap = state._trackerSel || new Set();
  const stLabel = st === 'new' ? '收件箱（新）' : st === 'all' ? '全部条目' : st === 'dismissed' ? '已忽略' : '已收进';
  inboxEl.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <h3 style="margin:0">收件箱</h3> ${chips}
      ${st === 'new' ? `<span class="muted">| 层级：</span>${tierChips}<span class="chip-btn ${!tier ? 'on' : ''}" onclick="trackerTierF('')">全部层级</span>` : ''}
      <span style="margin-left:auto" class="muted">共 ${inbox.total} 条</span>
    </div>
    ${st === 'new' && selMap.size ? `<div class="lib-batch" style="display:flex;gap:8px;align-items:center;margin-top:8px">
      已选 ${selMap.size} 篇
      <button class="btn small primary" onclick="trackerBatchAccept(this)">批量收进文献库</button>
      <button class="btn small" onclick="trackerCkClear()">取消选择</button></div>` : ''}
    ${inbox.items.length ? inbox.items.map(it => trackerItemHtml(it, selMap)).join('') :
      `<div class="empty-state"><p class="t">${st === 'new' ? '收件箱是空的' : '没有条目'}</p>
       <p>${st === 'new' ? '订阅巡逻到新论文后会出现在这里；也可以点订阅卡的「立即跑一轮」马上巡逻' : '换个筛选条件看看'}</p></div>`}
    ${inbox.total > (state._trackerPage || 1) * 30 ? `<div style="text-align:center;padding:10px">
      <button class="btn" onclick="trackerLoadMore()">加载更多（${inbox.total - (state._trackerPage || 1) * 30} 条未显示）</button></div>` : ''}`;
}
window.trackerStatus = v => { state._trackerStatus = v; state._trackerTier = ''; state._trackerPage = 1; state._trackerSel = new Set(); loadTracker(); };
window.trackerTierF = v => { state._trackerTier = v === state._trackerTier ? '' : v; state._trackerPage = 1; loadTracker(); };
window.trackerLoadMore = () => { state._trackerPage = (state._trackerPage || 1) + 1; loadTracker(); };
window.trackerCkClear = () => { state._trackerSel = new Set(); loadTracker(); };

function updateTrackerBadge(n) {
  const b = $('#tbadge');
  if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
}
window.refreshTrackerBadge = async () => {
  try {
    const d = await api('/api/tracker/items?page=1&page_size=1');
    updateTrackerBadge((d.counts || {}).inbox || 0);
  } catch {}  // noqa: 静默（角标非关键路径）
};

/* ---- 订阅编辑 ---- */
window.trackerNew = () => { state._trackerEdit = 'new'; loadTracker();
  $('#tracker-subs').scrollIntoView({behavior: 'smooth', block: 'start'}); };
window.trackerEdit = id => { state._trackerEdit = id; loadTracker(); };
window.trackerCancelEdit = () => { state._trackerEdit = null; loadTracker(); };
window.trackerToggleCat = (el, cat) => {
  el.classList.toggle('on');
  const inp = $('#tk-cats');
  if (!inp) return;
  const cats = new Set(inp.value.split(/\s+/).filter(Boolean));
  if (el.classList.contains('on')) cats.add(cat); else cats.delete(cat);
  inp.value = [...cats].join(' ');
};

async function trackerSave(id) {
  const payload = {
    name: $('#tk-name')?.value || '',
    keywords: $('#tk-keywords')?.value || '',
    categories: $('#tk-cats')?.value || '',
    exclude: $('#tk-exclude')?.value || '',
    journals: $('#tk-journals')?.value || '',
    frequency_hours: parseInt($('#tk-freq')?.value || '24', 10),
    llm_auto: $('#tk-auto')?.value || 'core',
    email_to: $('#tk-email')?.value || '',
    email_enabled: $('#tk-mail-on')?.checked || false,
    enabled: $('#tk-enabled')?.checked !== false,
  };
  if (payload.email_to && !payload.email_to.includes('@')) { toast('收件邮箱格式不正确'); return; }
  try {
    if (id) await api(`/api/tracker/subs/${id}`, {method: 'PUT', body: JSON.stringify(payload)});
    else {
      const r = await api('/api/tracker/subs', {method: 'POST', body: JSON.stringify(payload)});
      toast('订阅已创建——点「立即跑一轮」马上巡逻', 4000);
      state._trackerEdit = r.id;    // 保持表单展开（含「立即跑一轮」按钮）
      loadTracker();
      return;
    }
    toast('已保存');
    state._trackerEdit = null;
    loadTracker();
  } catch (e) { toast(friendlyError(e, '保存失败')); }
}
window.trackerSave = trackerSave;

async function trackerDel(id) {
  if (!(await uiConfirm('删除订阅？收件箱中该订阅的历史条目一并删除。', {title: '删除订阅', danger: true}))) return;
  try { await api(`/api/tracker/subs/${id}`, {method: 'DELETE'}); toast('订阅已删除'); state._trackerEdit = null; loadTracker(); }
  catch (e) { toast(friendlyError(e, '删除失败')); }
}
window.trackerDel = trackerDel;

async function trackerRun(id) {
  const btn = document.querySelector(`#tracker-subs .btn[onclick*="'${id}'"]`);
  try {
    await api(`/api/tracker/run/${id}`, {method: 'POST'});
    toast('巡逻已开始——arXiv 检索约十几秒，结果会自动出现在收件箱', 4500);
  } catch (e) { toast(friendlyError(e, '启动巡逻失败')); }
}
window.trackerRun = trackerRun;

/* ---- 收件箱行操作 ---- */
window.trackerCk = async (ck) => {
  const sel = state._trackerSel || (state._trackerSel = new Set());
  if (ck.checked) sel.add(ck.dataset.iid); else sel.delete(ck.dataset.iid);
  const page = $('#page-tracker');
  const st = page.scrollTop;
  await loadTracker();
  page.scrollTop = st;          // 勾选触发的重渲染保持滚动位置
};

async function trackerAccept(id, btn) {
  await withBusy(btn, async () => {
    // collection_id 留空 → 服务端落入默认文献库
    const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({collection_id: ''})});
    toast(r.duplicate ? '已在文献库中（已自动挂库）' : '已收进文献库——解析已排队，进度见「任务」页', 4500);
  }, '收进失败');
}
window.trackerAccept = trackerAccept;

async function trackerBatchAccept(btn) {
  const sel = [...(state._trackerSel || new Set())];
  if (!sel.length) return;
  await withBusy(btn, async () => {
    let ok = 0, dup = 0;
    for (const id of sel) {
      try {
        const r = await api(`/api/tracker/items/${id}/accept`, {method: 'POST', body: JSON.stringify({})});
        if (r.duplicate) dup++; else ok++;
      } catch (e) { /* 单条失败继续 */ }
    }
    state._trackerSel = new Set();
    toast(`批量收进完成：${ok} 篇新入库${dup ? `，${dup} 篇已在库` : ''}——解析排队进行中`, 5000);
  }, '批量收进失败');
}
window.trackerBatchAccept = trackerBatchAccept;

async function trackerDismiss(id, btn) {
  if (!(await uiConfirm('忽略这条？忽略后不再出现在收件箱（历史里仍可查）。', {title: '忽略', danger: true}))) return;
  await withBusy(btn, async () => {
    await api(`/api/tracker/items/${id}/dismiss`, {method: 'POST'});
  }, '操作失败');
}
window.trackerDismiss = trackerDismiss;

async function trackerEnrich(id, btn) {
  await withBusy(btn, async () => {
    const r = await api(`/api/tracker/items/${id}/enrich`, {method: 'POST'});
    toast('中文摘要已生成');
    const card = btn.closest('.tracker-item');
    if (card) {
      const m = document.createElement('div');
      m.style.cssText = 'color:var(--text-2);font-size:var(--fs-sm);margin-top:4px';
      m.textContent = r.zh_summary || '';
      card.querySelector('div[style*="flex:1"]')?.appendChild(m);
    }
  }, 'AI 摘要失败');
}
window.trackerEnrich = trackerEnrich;

/* ---- SMTP 配置卡（admin） ---- */
function trackerSmtpCardHtml(ready) {
  state._smtpOpen = state._smtpOpen || false;
  return `
  <div class="set-card" style="margin:10px 0">
    <div class="set-head">邮件发送（全局发件邮箱，配置一次全站共用）
      <span class="badge ${ready ? 'ok' : 'dim'}" style="margin-left:8px">${ready ? '已配置' : '未配置'}</span>
      <button class="btn small" style="margin-left:auto" onclick="trackerSmtpToggle()">
        ${state._smtpOpen ? '收起' : '配置'}</button></div>
    ${state._smtpOpen ? `
    <div style="display:grid;gap:8px;padding:12px 14px">
      <div style="display:flex;gap:8px">
        <label style="display:flex;gap:6px;align-items:center;flex:1">SMTP 主机
          <input id="smtp-host" value="${esc(state._smtpHost || '')}" placeholder="smtp.qq.com" style="flex:1"></label>
        <label style="display:flex;gap:6px;align-items:center;width:120px">端口
          <input id="smtp-port" value="${esc(String(state._smtpPort || 465))}" style="width:70px"></label>
      </div>
      <div style="display:flex;gap:8px">
        <label style="display:flex;gap:6px;align-items:center;flex:1">发件邮箱
          <input id="smtp-sender" value="${esc(state._smtpSender || '')}" placeholder="xxx@qq.com" style="flex:1"></label>
        <label style="display:flex;gap:6px;align-items:center;flex:1">授权码（留空=不改）
          <input id="smtp-pass" type="password" placeholder="${ready ? '已保存——留空保持不变' : 'SMTP 授权码'}" style="flex:1"></label>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn primary" onclick="trackerSaveSmtp(this)">保存配置</button>
        <label style="display:flex;gap:6px;align-items:center;margin-left:auto">测试发到
          <input id="smtp-test-to" placeholder="收件邮箱" style="width:200px"></label>
        <button class="btn" onclick="trackerTestSmtp(this)">发送测试</button>
      </div>
      <div class="muted" style="font-size:var(--fs-xs)">QQ/163 等邮箱需在邮箱设置里开启 SMTP 并生成「授权码」（不是登录密码）；端口 465=SSL，587=STARTTLS</div>
    </div>` : ''}`;
}

window.trackerSmtpToggle = () => { state._smtpOpen = !state._smtpOpen; loadTracker(); };

async function trackerSaveSmtp(btn) {
  await withBusy(btn, async () => {
    const host = $('#smtp-host')?.value || '', sender = $('#smtp-sender')?.value || '';
    if (!host || !sender.includes('@')) { toast('SMTP 主机与发件邮箱必填'); return; }
    state._smtpHost = host; state._smtpPort = $('#smtp-port')?.value || 465; state._smtpSender = sender;
    await api('/api/tracker/smtp', {method: 'PUT', body: JSON.stringify({
      host, port: parseInt(state._smtpPort, 10) || 465, sender,
      password: $('#smtp-pass')?.value || '', sender_name: 'paper-system'})});
    toast('SMTP 配置已保存');
    loadTracker();
  }, '保存失败');
}
window.trackerSaveSmtp = trackerSaveSmtp;

async function trackerTestSmtp(btn) {
  const to = $('#smtp-test-to')?.value || '';
  if (!to.includes('@')) { toast('先填测试收件邮箱'); return; }
  await withBusy(btn, async () => {
    try {
      await api('/api/tracker/smtp/test', {method: 'POST', body: JSON.stringify({to})});
      toast(`测试邮件已发到 ${to}——收到即配置成功`, 5000);
    } catch (e) { toast(friendlyError(e, '发送失败——检查主机/端口/授权码')); }
  }, '发送中…');
}
window.trackerTestSmtp = trackerTestSmtp;
