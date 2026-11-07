/**
 * 引文跳转/悬浮卡回归测试（jsdom 无头）
 * 用法: node scripts/cite-jump-test.mjs
 * 覆盖: 点引用→分页穿透增量加载→命中块高亮 / 悬停→#ref-pop 预览卡 / 未命中退化跳页
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

// 100 块论文：block_id p1-p000-b00001 … p1-p099-b00100，页 = 块序
const ALL_BLOCKS = Array.from({length: 100}, (_, i) => ({
  block_id: `p1-p${String(Math.floor(i / 8)).padStart(3, '0')}-b${String(i + 1).padStart(5, '0')}`,
  type: 'text', section_path: 'S', page_index: Math.floor(i / 8), block_index: i + 1,
  bbox: '[0.1,0.1,0.9,0.2]', text: `block text number ${i + 1} unique token ZZZ${i + 1}`,
  source_hash: 'h' + i,
}));
const EVIDENCE = [
  {evidence_id: 1, paper_id: 'p1', title: 'Test Paper', page_index: 9, block_id: ALL_BLOCKS[78].block_id, text: ALL_BLOCKS[78].text},
  {evidence_id: 2, paper_id: 'p1', title: 'Test Paper', page_index: 0, block_id: ALL_BLOCKS[2].block_id, text: ALL_BLOCKS[2].text},
];

const DATA = {
  '/api/me': {id: 1, username: 'tester', role: 'admin', llm_configured: {chat: true, translate: true}},
  '/api/presets': {questions: []},
  '/api/chat/sessions': {sessions: []},
  '/api/collections': {total: 1, collections: []},
  '/api/papers': {total: 1, papers: [{id: 'p1', title: 'Test Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 13, file_size: 1024}]},
  '/api/papers/p1/bilingual': {run_id: 'r1', pairs: [], versions: [], total: 0, offset: 0, limit: 40},
  '/api/papers/p1/notes': {notes: {}},
  '/api/papers/p1/assets': {figures: [], tables: []},
  '/api/papers/p1/references': {references: []},
  '/api/papers/p1/summary': {summary: null},
  '/api/papers/p1/jobstate': {parse_status: 'parsed', parsing: false, translating: false, translated: false},
  '/api/papers/p1/bilingual/blocks': {pairs: [], total: 0},
  '/api/statuses': {statuses: {}},
  '/api/jobs': {jobs: []},
  '/api/usage': {by_user: [], by_day: []},
  '/api/glossary': {terms: []},
  '/api/admin/users': {users: []},
  '/api/admin/pool': {enabled: false},
};
const fetchedUrls = [];

const dom = new JSDOM(html, {url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true});
const {window} = dom;
const errors = [];

window.fetch = async (url) => {
  const u = String(url);
  fetchedUrls.push(u);
  const base = u.split('?')[0];
  if (base === '/api/papers/p1') {   // 分页块接口
    const q = new URLSearchParams(u.split('?')[1] || '');
    const offset = +(q.get('offset') || 0), limit = +(q.get('limit') || 40);
    const blocks = ALL_BLOCKS.slice(offset, offset + limit);
    return {ok: true, status: 200, json: async () => ({paper: {...DATA['/api/papers'].papers[0], authors: 'A', year: '2024', journal: 'J', abstract: 'a', keywords: '[]'}, blocks, total: ALL_BLOCKS.length, offset, limit})};
  }
  return {ok: true, status: 200, json: async () => DATA[base] ?? {}};
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () { this.dataset.scrolled = '1'; };
window.matchMedia = window.matchMedia || (q => ({matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, }));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
window.addEventListener('error', e => errors.push('window error: ' + e.message));
process.on('unhandledRejection', r => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  if (/reading 'configured'/.test(m)) return;
  errors.push('rejection: ' + m);
});

try {
  window.eval(js + '\n;window.__T = { state, openPaper, jumpToEvidence, wireCites, renderCites };');
} catch (e) {
  errors.push('eval: ' + e.stack.split('\n').slice(0, 3).join(' | '));
}
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise(r => setTimeout(r, 200));

const {state} = window.__T;
const results = [];
let ok = true;
const check = (name, cond) => { results.push((cond ? '  OK ' : '  FAIL ') + name); ok = ok && cond; };

// ---- 前置：打开论文（首屏 40 块）----
await window.__T.openPaper('p1');
check('openPaper 首屏 40 块', state.blocks.length === 40);
check('证据块(78)未加载', !state.blocks.some(b => b.block_id === ALL_BLOCKS[78].block_id));

// ---- 1. renderCites + wireCites ----
const container = window.document.createElement('div');
container.innerHTML = window.__T.renderCites('依据原文 [1] 所述，对比 [2] 的结论。', EVIDENCE);
window.document.body.appendChild(container);
window.__T.wireCites(container, EVIDENCE);
const cites = [...container.querySelectorAll('.cite')];
check('引用渲染 2 个', cites.length === 2);
check('cite 挂了 _ev', cites.every(el => el._ev && el._ev.evidence_id));

// ---- 2. 悬浮预览卡 ----
container.querySelector('.cite[data-n="1"]').dispatchEvent(new window.MouseEvent('mouseover', {bubbles: true}));
await new Promise(r => setTimeout(r, 50));
const pop = window.document.querySelector('#ref-pop');
check('悬停出预览卡', pop && !pop.hidden);
check('预览含来源摘录', pop && pop.textContent.includes('ZZZ79'));
check('预览含页码', pop && /第10页/.test(pop.textContent));

// ---- 3. 点引用 → 分页穿透命中（证据块 #79）----
await cites[0].onclick();
await new Promise(r => setTimeout(r, 100));
check('穿透加载后命中证据块', state.blocks.some(b => b.block_id === ALL_BLOCKS[78].block_id));
check('加载量约 80 块（2 批）', state.blocks.length === 80);
check('视图停在原文', state.view === 'orig');
const active = window.document.querySelector('#content-view .blk.active');
check('目标块已激活', active && active.dataset.bid === ALL_BLOCKS[78].block_id);
check('目标块滚到可见', active && active.dataset.scrolled === '1');

// ---- 4. 点首屏内引用（#3 证据）→ 直接命中不额外加载 ----
const before = state.blocks.length;
await cites[1].onclick();
await new Promise(r => setTimeout(r, 50));
const active2 = window.document.querySelector('#content-view .blk.active');
check('首屏引用直接激活', active2 && active2.dataset.bid === ALL_BLOCKS[2].block_id);
check('不触发额外加载', state.blocks.length === before);

// ---- 5. 未命中（块失配）→ 不崩（jsdom 无 PDF，跳页分支由真机 pdfDoc 覆盖）----
const badEv = {evidence_id: 9, paper_id: 'p1', title: 'T', page_index: 12, block_id: 'p1-p999-b99999', text: '不存在的文本'};
let crashed = false;
try { await window.__T.jumpToEvidence(badEv); } catch (e) { crashed = true; }
check('未命中不崩', !crashed && !errors.length);

console.log(results.join('\n'));
console.log('\n' + (errors.length ? '❌ 页面错误:\n  ' + errors.slice(0, 6).join('\n  ') : '') +
            (ok && !errors.length ? '✅ 全部通过' : '❌ 存在失败'));
process.exit(ok && !errors.length ? 0 : 1);
