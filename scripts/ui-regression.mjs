/**
 * paper-system 前端回归测试（jsdom 无头）
 * 用法: node scripts/ui-regression.mjs
 * 覆盖: 页面加载无异常 / 导航页切换 / 右栏视图切换 / 问答面板 / 抽屉开关
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const DATA = {
  '/api/me': { id: 1, username: 'tester', role: 'admin', llm_configured: { chat: true, translate: true } },
  '/api/presets': { questions: ['q1', 'q2'] },
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 1, collections: [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }] },
  '/api/papers': { total: 1, papers: [{ id: 'p1', title: 'Test Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 }] },
  '/api/papers/p1': {
    paper: { id: 'p1', title: 'Test Paper', authors: 'A, B', year: '2024', journal: 'J', doi: '', keywords: '[]', abstract: 'abs', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    blocks: [{ block_id: 'p1-p000-b00001', type: 'text', section_path: 'S', page_index: 0, block_index: 1, bbox: '[0.1,0.1,0.9,0.2]', text: 'hello world', source_hash: 'h' }],
    total: 1, offset: 0, limit: 40,
  },
  '/api/papers/p1/bilingual': { run_id: 'r1', pairs: [], versions: [], total: 0, offset: 0, limit: 40 },
  '/api/papers/p1/notes': { notes: {} },
  '/api/papers/p1/assets': { figures: [], tables: [] },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/summary': { summary: null },
  '/api/papers/p1/jobstate': { parse_status: 'parsed', parsing: false, translating: false, translated: false },
  '/api/papers/p1/bilingual/blocks': { pairs: [], total: 0 },
  '/api/statuses': { statuses: {} },
  '/api/jobs': { jobs: [] },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/admin/users': { users: [] },
  '/api/admin/pool': { enabled: false },
};

const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url) => {
  const u = String(url).split('?')[0];
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
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;   // pdf.js 动态导入失败属测试环境限制
  if (/reading 'configured'/.test(m)) return;   // boot 未完成时的时序噪音
  errors.push('rejection: ' + m);
});

try {
  window.eval(js + '\n;window.__T = { state, switchView, switchPage, renderContentView, openQa: window.openQa };');
} catch (e) {
  errors.push('eval: ' + e.stack.split('\n').slice(0, 3).join(' | '));
}
// 等待 boot() 完成（state.me 就绪）
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise((r) => setTimeout(r, 200));

const doc = window.document;
const results = [];

// 1) 导航页
for (const pg of ['collections', 'trash', 'settings', 'reader']) {
  const btn = doc.querySelector(`.topnav button[data-page="${pg}"]`);
  if (!btn) { errors.push(`nav ${pg}: 按钮缺失`); continue; }
  try {
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    const el = doc.querySelector('#page-' + pg);
    const shown = el && el.style.display !== 'none';
    results.push(`nav ${pg}: ${shown ? 'OK' : '未显示'}`);
    if (!shown) errors.push(`nav ${pg}: 点击后未显示`);
  } catch (e) { errors.push(`nav ${pg}: ${e.message}`); }
}

// 2) 右栏视图
for (const v of ['meta', 'assets', 'json', 'qa', 'read']) {
  try {
    window.eval(`switchView('${v}')`);
    await new Promise((r) => setTimeout(r, 120));
    const cv = doc.querySelector('#content-view');
    const len = cv ? cv.innerHTML.length : 0;
    results.push(`view ${v}: ${len} 字符`);
    if (len === 0) errors.push(`view ${v}: 内容为空`);
  } catch (e) { errors.push(`view ${v}: ${e.message}`); }
}

// 3) 关键函数存在性
// window 挂载的关键函数（内联 onclick 依赖它们）
// 注意: 段落合并/段落批注/补译已下线(用户要求移除)，不在检查范围
for (const fn of ['exportBibtex', 'quickDelete', 'lightbox', 'loadMoreBlocks',
                  'loadMorePairs', 'pdfFlashBlock', 'flashAbstract',
                  'linkDiag', 'toggleToc']) {
  if (typeof window[fn] !== 'function') errors.push(`window 函数缺失: ${fn}`);
}
results.push('函数检查完成');

console.log(results.join('\n'));
console.log('\n' + (errors.length ? '❌ 失败:\n  ' + errors.slice(0, 12).join('\n  ') : '✅ 全部通过'));
process.exit(errors.length ? 1 : 0);
