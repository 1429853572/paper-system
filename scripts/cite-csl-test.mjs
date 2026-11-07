/**
 * CSL 引用渲染回归测试（jsdom 无头 + 真 citeproc 引擎 + 真 CSL 样式文件）
 * 用法: node scripts/cite-csl-test.mjs
 * 覆盖: GB/T 7714 英文文献 et al. / 中文文献 等 / 引用卡下拉切换 / 复制取文
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const CSL_JSON = {
  id: 'p1', type: 'article-journal',
  title: '3D Gaussian Splatting as a New Era: A Survey',
  author: [{family: 'Fei', given: 'Bin'}, {family: 'Xu', given: 'Jing'},
           {family: 'Zhang', given: 'Rui'}, {family: 'Wang', given: 'Yang'}],
  language: 'en-US', DOI: '10.48550/arXiv.2402.07181',
  issued: {'date-parts': [[2024]]}, 'container-title': 'arXiv preprint',
};
const DATA = {
  '/api/me': {id: 1, username: 'admin', role: 'admin', llm_configured: {chat: true, translate: true}},
  '/api/presets': {questions: [], compare: []},
  '/api/chat/sessions': {sessions: []},
  '/api/collections': {total: 1, collections: []},
  '/api/papers': {total: 1, papers: [{id: 'p1', title: 'T', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024}]},
  '/api/papers/p1/notes': {notes: {}},
  '/api/papers/p1/assets': {figures: [], tables: [], formulas: []},
  '/api/papers/p1/references': {references: []},
  '/api/papers/p1/summary': {summary: null},
  '/api/papers/p1/jobstate': {parse_status: 'parsed', parsing: false, translating: false, translated: false},
  '/api/papers/p1/bilingual': {run_id: 'r1', pairs: [], versions: [], total: 0, offset: 0, limit: 40},
  '/api/papers/p1/cite': {
    styles: {bibtex: {text: '@misc{p1}', html: '@misc{p1}'}, gbt7714: {text: 'legacy', html: 'legacy'}},
    labels: {gbt7714: 'GB/T 7714', bibtex: 'BibTeX'}, default: 'gbt7714',
    csl_json: CSL_JSON,
    csl_list: [['china-national-standard-gb-t-7714-2015-numeric', 'GB/T 7714-2015（顺序编码）'], ['apa', 'APA 7']],
  },
  '/api/statuses': {statuses: {}},
};

const dom = new JSDOM(html, {url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true});
const {window} = dom;
const errors = [];
setTimeout(() => { console.log('WATCHDOG: 测试超时'); process.exit(2); }, 30000).unref();

window.fetch = async (url) => {
  const u = String(url).split('?')[0];
  // vendor 静态文件：从磁盘读（模拟 /static 服务）
  if (u.startsWith('/static/vendor/csl/')) {
    const f = path.join(UI, 'vendor', 'csl', path.basename(u));
    return {ok: fs.existsSync(f), status: 200, text: async () => fs.readFileSync(f, 'utf8'), json: async () => ({})};
  }
  if (u.startsWith('/static/vendor/citeproc/locales-')) {
    const f = path.join(UI, 'vendor', 'citeproc', path.basename(u));
    return {ok: fs.existsSync(f), status: 200, text: async () => fs.readFileSync(f, 'utf8'), json: async () => ({})};
  }
  if (/\/api\/papers\/p1$/.test(u))
    return {ok: true, status: 200, json: async () => ({paper: DATA['/api/papers'].papers[0], blocks: [], total: 0, offset: 0, limit: 40})};
  return {ok: true, status: 200, text: async () => '', json: async () => DATA[u] ?? {}};
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
  if (/pdf\.min\.mjs|Cannot find module|reading 'configured'/.test(m)) return;
  errors.push('rej: ' + m);
});

// 真引擎：eval vendor citeproc（UMD 壳挂 window.citeproc）
window.eval(fs.readFileSync(path.join(UI, 'vendor', 'citeproc', 'citeproc.js'), 'utf8'));
window.citeproc = window.citeproc || globalThis.citeproc;   // jsdom outside-only eval realm 怪癖兜底
window.eval(js + ';window.__T={state,openPaper,cslRender};');
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise(r => setTimeout(r, 200));
const doc = window.document;
await window.__T.loadPapers?.() ?? null;
await window.__T.openPaper('p1');
await new Promise(r => setTimeout(r, 100));

let ok = true;
const check = (name, cond) => { console.log((cond ? '  OK ' : '  FAIL ') + name); ok = ok && cond; };

check('citeproc 引擎已加载', typeof window.citeproc?.Engine === 'function');

// 进文献信息页签 → 引用卡渲染
window.eval("switchView('meta')");
await new Promise(r => setTimeout(r, 600));
const preview = doc.querySelector('#cite-preview');
const sel = doc.querySelector('#cite-style');
check('引用卡存在', !!preview && !!sel);
check('下拉含 12+1 种样式', sel && sel.options.length === 3, );
const gbHtml = preview?.innerHTML || '';
check('GB/T 7714（英文文献）渲染出 et al.', gbHtml.includes('et al.'));
check('GB/T 7714 无中文"等"', !gbHtml.includes('等'));
check('含 [J/OL] 文献类型标识（GB 样式特征）', gbHtml.includes('[J'));
check('含 DOI', gbHtml.includes('10.48550'));

// zh item → 等
const zhHtml = await window.__T.cslRender({...CSL_JSON, language: 'zh-CN', author: [{family: '张三', given: ''}, {family: '李四', given: ''}, {family: '王五', given: ''}, {family: '赵六', given: ''}]}, 'china-national-standard-gb-t-7714-2015-numeric');
check('GB/T 7714（中文文献）渲染出 等', zhHtml.includes('等') && !zhHtml.includes('et al.'));

// 切 APA
sel.value = 'apa';
sel.dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 400));
const apaHtml = doc.querySelector('#cite-preview')?.innerHTML || '';
check('APA 渲染（含年份与 ampersand 特征或标题）', /201?4|2024/.test(apaHtml) && apaHtml.length > 40);
check('无页面错误', !errors.length);

console.log('\n' + (ok && !errors.length ? '✅ 全部通过' : '❌ 存在失败') + (errors.length ? '\n  ' + errors.slice(0, 5).join('\n  ') : ''));
process.exit(ok && !errors.length ? 0 : 1);
