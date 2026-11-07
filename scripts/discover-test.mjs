/**
 * 「🔍 找相关」排卡浮层回归测试（jsdom 无头）
 * 用法: node scripts/discover-test.mjs
 * 覆盖: 浮层打开 / 三页签切换与懒加载 / 已在库·无PDF 禁勾 / 勾选计数 / 导入调用与结果提示 / 切论文关浮层
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const ITEMS = [
  { s2_id: 'a1', title: 'Related Paper Alpha', year: '2025', venue: 'CVPR', abstract: 'abs A',
    doi: '10.1/a', arxiv: '', authors: 'X Y', citation_count: 7, pdf_url: 'https://arxiv.org/pdf/2501.00001', in_library: null },
  { s2_id: 'a2', title: 'Already In Library', year: '2024', venue: '', abstract: 'abs B',
    doi: '10.1/b', arxiv: '', authors: '', citation_count: 2, pdf_url: 'https://arxiv.org/pdf/2501.00002', in_library: 'p9' },
  { s2_id: 'a3', title: 'No Public PDF Here', year: '2023', venue: '', abstract: '',
    doi: '', arxiv: '', authors: '', citation_count: 0, pdf_url: '', in_library: null },
];

const DATA = {
  '/api/me': { id: 1, username: 'tester', role: 'admin', llm_configured: { chat: true, translate: true } },
  '/api/presets': { questions: [] },
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 1, collections: [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }] },
  '/api/papers': { total: 1, papers: [{ id: 'p1', title: 'Test Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 }] },
  '/api/papers/p1': {
    paper: { id: 'p1', title: 'Test Paper', authors: 'A', year: '2025', journal: 'J', doi: '10.0/orig',
             keywords: '[]', abstract: 'abs', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    blocks: [], total: 0, offset: 0, limit: 40,
  },
  '/api/papers/p1/discover': { items: ITEMS, mode: 'rec' },
  '/api/papers/p1/bilingual': { pairs: [], versions: [] },
  '/api/papers/p1/notes': { notes: {} },
  '/api/papers/p1/assets': { figures: [], tables: [] },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/cite': { styles: {}, labels: {}, default: 'gbt7714' },
  '/api/papers/p1/summary': { summary: null },
  '/api/papers/p1/jobstate': { parse_status: 'parsed', parsing: false, translating: false, translated: false },
  '/api/statuses': { statuses: {} },
  '/api/batches': { batches: [] },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/admin/users': { users: [] },
  '/api/admin/pool': { enabled: false },
};

let importCalls = [];
const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  if (u === '/api/papers/discover-import') {
    importCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ results: [
      { title: 'Related Paper Alpha', status: 'queued', paper_id: 'pnew' }] }) };
  }
  const body = DATA[u] ?? {};
  return { ok: true, status: 200, json: async () => body };
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };

window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
process.on('unhandledRejection', (r) => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  if (/reading 'configured'/.test(m)) return;
  errors.push('rejection: ' + m);
});

try {
  window.eval(js + '\n;window.__T = { state, openPaper };');
} catch (e) {
  errors.push('eval: ' + e.stack.split('\n').slice(0, 3).join(' | '));
}
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise((r) => setTimeout(r, 200));

const doc = window.document;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'OK' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) errors.push(`${name}${extra ? ': ' + extra : ''}`);
};

// 打开论文 → 点「找相关」
await window.__T.openPaper('p1');
await new Promise((r) => setTimeout(r, 150));
const btn = doc.querySelector('#discover-btn');
ok('找相关按钮存在', !!btn);
btn.click();
await new Promise((r) => setTimeout(r, 250));

const pop = doc.querySelector('#discover-pop');
ok('浮层打开', pop && !pop.hidden);
ok('三页签渲染', doc.querySelectorAll('.dp-tab').length === 3);
ok('默认相关推荐高亮', doc.querySelector('.dp-tab.on')?.dataset.dm === 'rec');

// 卡片与禁勾逻辑（等待 loadDiscover 完成）
await new Promise((r) => setTimeout(r, 150));
const cards = [...doc.querySelectorAll('.dp-item')];
ok('排卡 3 条', cards.length === 3, `实际 ${cards.length}`);
const cbs = [...doc.querySelectorAll('input[data-di]')];
ok('已在库条目禁勾', cbs[1].disabled);
ok('无公开PDF条目禁勾', cbs[2].disabled);
ok('可导入条目可勾', !cbs[0].disabled);
ok('已在库徽标', cards[1].textContent.includes('已在库'));
ok('无公开PDF徽标', cards[2].textContent.includes('无公开PDF'));

// 勾选 → 计数 → 导入
cbs[0].checked = true;
cbs[0].dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 50));
ok('勾选计数 1', doc.querySelector('#dp-n').textContent === '1');
doc.querySelector('#dp-import').click();
await new Promise((r) => setTimeout(r, 200));
ok('导入请求发出且带元数据', importCalls.length === 1 &&
   importCalls[0].items[0].title === 'Related Paper Alpha' && importCalls[0].items[0].doi === '10.1/a');
ok('导入后浮层关闭', pop.hidden);

// 页签切换懒加载（refs 未请求过 → 重新拉）
btn.click();
await new Promise((r) => setTimeout(r, 100));
doc.querySelector('.dp-tab[data-dm="refs"]').click();
await new Promise((r) => setTimeout(r, 250));
ok('切换页签后仍渲染', doc.querySelectorAll('.dp-item').length === 3);
ok('refs 高亮', doc.querySelector('.dp-tab.on')?.dataset.dm === 'refs');

// 切论文关浮层
await window.__T.openPaper('p1');
await new Promise((r) => setTimeout(r, 150));
ok('切论文后浮层关闭', doc.querySelector('#discover-pop').hidden);

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
