/**
 * 回收站按钮/委托点击回归测试（jsdom 无头）
 * 用法: node scripts/trash-btn-test.mjs
 * 覆盖: 点删除按钮内嵌 SVG 图标 → quickDelete → DELETE 请求（曾是 e.target.classList
 *       判断，点在 svg/path 上永远 false → 反而打开论文）
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const calls = [];
const DATA = {
  '/api/me': {id: 1, username: 'admin', role: 'admin', llm_configured: {chat: true, translate: true}},
  '/api/chat/sessions': {sessions: []},
  '/api/collections': {total: 1, collections: [{id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1}]},
  '/api/papers': {total: 1, papers: [{id: 'p1', title: 'T', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024}]},
  '/api/papers/p1/notes': {notes: {}},
  '/api/papers/p1/assets': {figures: [], tables: []},
  '/api/papers/p1/references': {references: []},
  '/api/papers/p1/summary': {summary: null},
  '/api/papers/p1/jobstate': {parse_status: 'parsed', parsing: false, translating: false, translated: false},
  '/api/papers/p1/bilingual': {run_id: 'r1', pairs: [], versions: [], total: 0, offset: 0, limit: 40},
  '/api/papers/p1/cite': {styles: {gbt7714: {label: 'GB/T 7714', html: 'c'}}, labels: {}, default: 'gbt7714'},
  '/api/statuses': {statuses: {}},
};

const dom = new JSDOM(html, {url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true});
const {window} = dom;
const errors = [];
setTimeout(() => { console.log('WATCHDOG: 测试超时'); process.exit(2); }, 20000).unref();

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  const m = opts.method || 'GET';
  calls.push(m + ' ' + u);
  if (m === 'DELETE' && u === '/api/papers/p1') return {ok: true, status: 200, json: async () => ({ok: true})};
  if (/\/api\/papers\/p1$/.test(u) && m === 'GET')
    return {ok: true, status: 200, json: async () => ({paper: DATA['/api/papers'].papers[0], blocks: [], total: 0, offset: 0, limit: 40})};
  return {ok: true, status: 200, json: async () => DATA[u] ?? {}};
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};
window.matchMedia = window.matchMedia || (q => ({matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
window.addEventListener('error', e => errors.push('win: ' + e.message));
process.on('unhandledRejection', r => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  if (/reading 'configured'/.test(m)) return;
  errors.push('rej: ' + m);
});

window.eval(js + ';window.__T={state,openPaper,loadPapers};');
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise(r => setTimeout(r, 200));
const doc = window.document;
await window.__T.loadPapers();   // jsdom 里 boot 断在 initPdfJs（vendor ESM），显式加载论文列表
await window.__T.openPaper('p1');
await new Promise(r => setTimeout(r, 100));
calls.length = 0;

let ok = true;
const check = (name, cond) => { console.log((cond ? '  OK ' : '  FAIL ') + name); ok = ok && cond; };

const del = doc.querySelector('.paper-item .pi-del');
check('删除按钮存在', !!del);
check('按钮内嵌 SVG 图标', !!del?.querySelector('svg'));
// 点在 SVG 图标上（用户实际点中的位置）→ 应出统一确认浮层（替代原生 confirm）
del.querySelector('svg').dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
await new Promise(r => setTimeout(r, 150));
let okBtn = doc.querySelector('.ui-pop [data-ok]');
check('统一确认浮层出现（替代原生 confirm）', !!okBtn);
check('浮层是危险操作样式', !!doc.querySelector('.ui-pop.danger'));
okBtn?.click();
await new Promise(r => setTimeout(r, 200));
check('确认后发出 DELETE（此前会误开论文）', calls.some(c => c.startsWith('DELETE /api/papers/p1')));

calls.length = 0;
del.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
await new Promise(r => setTimeout(r, 150));
okBtn = doc.querySelector('.ui-pop [data-ok]');
okBtn?.click();
await new Promise(r => setTimeout(r, 200));
check('点按钮本体同样走确认→DELETE', calls.some(c => c.startsWith('DELETE /api/papers/p1')));

// 破坏性按钮 hover-only 规则（用户决定：垃圾桶/删/× 默认隐藏、悬停行显形；
// 触屏兜底 @media(hover:none) 常驻——本断言管「类与 CSS 双在」，真机行为另有 CDP 验证）
{
  const css = fs.readFileSync(path.join(UI, 'styles.css'), 'utf8');
  const mustHaveClass = [
    ['L2 论文表行内 删', 'delPaperFromLib'],
    ['L2 库头 删除库', 'delLib'],
    ['问答会话 删除', 'delSess'],
    ['术语表 ×', 'delGlossary'],
  ];
  for (const [name, fn] of mustHaveClass) {
    const m = [...js.matchAll(new RegExp('<button ([^>]*?)\\s?onclick="[^"]*' + fn + '\\(', 'g'))].pop();
    check(name + ' 按钮带 hover-only', !!m && /hover-only/.test(m[1]),
          m ? m[1].slice(0, 60) : '未找到按钮');
  }
  check('CSS 悬停显形规则在', css.includes('tr:hover .hover-only') &&
        css.includes('.qa-sess-item:hover .hover-only') && css.includes('.chip:hover .hover-only'));
  check('CSS 触屏兜底在（hover:none 常驻）', css.includes('@media (hover: none)') &&
        css.includes('pointer-events: auto'));
}

check('无页面错误', !errors.length);
console.log('\n' + (ok ? '✅ 全部通过' : '❌ 存在失败') + (errors.length ? '\n  ' + errors.slice(0, 5).join('\n  ') : ''));
process.exit(ok ? 0 : 1);
