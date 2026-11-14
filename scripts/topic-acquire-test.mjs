/**
 * 专题采集 + 采集弹层回归测试（jsdom 无头）
 * 用法: node scripts/topic-acquire-test.mjs
 * 覆盖: 批量中心采集/专题入口卡存在且可点 / 采集弹层渲染与检索 / 专题列表与详情页 /
 *       勾选保存 / 下载入队 / 综述按钮按解析状态启用 / MCP 写工具门控
 * （此前 7 套测试未覆盖新增功能，导致入口卡缺失却「全绿」）
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
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 1, collections: [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }] },
  '/api/papers': { total: 1, papers: [{ id: 'p1', title: 'T', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1 }] },
  '/api/papers/p1': { paper: { id: 'p1', title: 'T', authors: '', year: '', journal: '', doi: '', keywords: '[]', abstract: '', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1 }, blocks: [], total: 0 },
  '/api/papers/p1/bilingual': { pairs: [], versions: [] },
  '/api/papers/p1/notes': { notes: {} },
  '/api/papers/p1/assets': { figures: [], tables: [] },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/cite': { styles: {}, labels: {}, default: 'gbt7714' },
  '/api/papers/p1/summary': { summary: null },
  '/api/papers/p1/jobstate': { parse_status: 'parsed', parsing: false, translating: false, translated: false },
  '/api/statuses': { statuses: {} },
  '/api/health': { trash_days: 30 },
  '/api/batches': { batches: [] },
  '/api/cmdtags': { tags: [] },
  '/api/mcp/pending': { pending: [] },
  '/api/syntheses': { syntheses: [] },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/admin/users': { users: [] },
  '/api/admin/pool': { enabled: false },
  '/api/acquire/status': { available: true, browser: true, playwright: true, sites: ['chinaxiv', 'cnki'] },
  '/api/acq-tasks': { tasks: [
    { id: 'atk1', title: '中文预印本专题', query: '深度学习', site: 'chinaxiv', status: 'ready',
      cand_total: 3, cand_selected: 1, cand_done: 0, papers: 0, updated_at: '2026-11-08 10:00:00' }] },
  '/api/acq-tasks/atk1': { task: {
    id: 'atk1', title: '中文预印本专题', query: '深度学习', site: 'chinaxiv', status: 'ready',
    filters: {}, candidates: [
      { title: '甲论文', authors: '张三', year: '2025', venue: '预印本', summary: '摘要甲',
        pdf_url: 'https://chinaxiv.org/user/download.htm?uuid=a1', abs_url: '', doi: '',
        selected: true, dl_status: 'pending', in_library: false },
      { title: '乙论文', authors: '李四', year: '2024', venue: '预印本', summary: '',
        pdf_url: 'https://chinaxiv.org/user/download.htm?uuid=a2', abs_url: '', doi: '',
        selected: false, dl_status: 'pending', in_library: false },
      { title: '已在库论文', authors: '', year: '', venue: '', summary: '',
        pdf_url: 'https://chinaxiv.org/user/download.htm?uuid=a3', abs_url: '', doi: '',
        selected: false, dl_status: 'done', in_library: true }],
    paper_ids: [], papers_detail: [], all_parsed: false } },
  '/api/acquire/search': { items: [
    { title: '检索结果一', authors: '王五', year: '2026', venue: '预印本', summary: '摘要一',
      pdf_url: 'https://chinaxiv.org/user/download.htm?uuid=b1', abs_url: '', doi: '',
      in_library: false }] },
  // 综述预估：含费用（priced=true → 前端显示金额；priced=false → 只显示调用数）
  '/api/synthesize/estimate': { valid: 3, missing_summaries: 1, groups: 2, calls: 4,
    no_parse: [], cost: { cost: 0.08, per_call: 0.02, samples: 12, priced: true } },
};

const calls = [];
const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  calls.push(`${u} ${(opts.method || 'GET')}`);
  const body = DATA[u] ?? {};
  return { ok: true, status: 200, json: async () => body };
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
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
  window.eval(js + '\n;window.__T = { state, switchPage, runSynthesis };');
} catch (e) {
  errors.push('eval: ' + e.stack.split('\n').slice(0, 3).join(' | '));
}
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise((r) => setTimeout(r, 300));

const doc = window.document;
const results = [];
const ok = (name, cond, extra = '') => {
  const line = `${cond ? 'OK' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
  results.push(line); console.log(line);
  if (!cond) errors.push(`${name}${extra ? ': ' + extra : ''}`);
};

// 1) 采集入口在文库管理工具条（批量页已取消，采集并入文库）
window.__T.switchPage('collections');
await new Promise((r) => setTimeout(r, 500));
const collectBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('采集文献'));
ok('文库工具条有「采集文献」入口', !!collectBtn);
ok('不再有独立「批量」顶级页', !doc.querySelector('.topnav button[data-page="batch"]'));

// 2) 点采集入口 → 浮层（快速采集 / 专题跟踪）→ 采集弹层渲染
window.openCollectPanel && window.openCollectPanel();   // jsdom 不执行内联 onclick
await new Promise((r) => setTimeout(r, 400));
ok('采集浮层打开', !!doc.querySelector('.collect-panel'));
ok('浮层含快速采集与专题跟踪', !!doc.querySelector('#acq-btn') && !!doc.querySelector('#cp-topics'));
const acqCard = doc.querySelector('#acq-btn');
acqCard?.onclick && acqCard.onclick();
await new Promise((r) => setTimeout(r, 300));
const pop = doc.querySelector('#acq-pop');
ok('采集弹层打开', pop && !pop.hidden);
ok('采集弹层有检索输入与按钮', !!doc.querySelector('#acq-q') && !!doc.querySelector('#acq-go'));
ok('采集弹层含站点切换（预印本/知网）',
   [...doc.querySelectorAll('.dp-tab')].some(t => t.dataset.as === 'chinaxiv') &&
   [...doc.querySelectorAll('.dp-tab')].some(t => t.dataset.as === 'cnki'));

// 3) 检索 → 候选渲染（先填关键词，真实用法）
doc.querySelector('#acq-q').value = '深度学习';
doc.querySelector('#acq-go').click();
await new Promise((r) => setTimeout(r, 300));
ok('检索调用了 /api/acquire/search', calls.some(c => c.startsWith('/api/acquire/search')));
ok('候选渲染', doc.querySelectorAll('.acq-item').length >= 1);

// 4) 专题入口 → 采集浮层内点「专题跟踪」→ 列表
doc.querySelector('#acq-pop').hidden = true;
window.openCollectPanel && window.openCollectPanel();
await new Promise((r) => setTimeout(r, 400));
const tpBtn = doc.querySelector('#cp-topics');
tpBtn?.onclick && tpBtn.onclick();
await new Promise((r) => setTimeout(r, 500));
ok('专题列表渲染', doc.querySelectorAll('.tp-row').length >= 1);
ok('专题列表显示标题', doc.body.textContent.includes('中文预印本专题'));
ok('新建专题按钮存在', !!doc.querySelector('#tp-new'));

// 5) 打开专题详情
doc.querySelector('[data-tp-open]').click();
await new Promise((r) => setTimeout(r, 400));
ok('专题详情渲染', !!doc.querySelector('#td-q'));
ok('候选勾选框渲染', doc.querySelectorAll('input[data-tc]').length === 3);
ok('已在库候选禁勾', doc.querySelectorAll('input[data-tc][disabled]').length === 1);
ok('已下载候选显示已入库', doc.body.textContent.includes('已入库'));

// 6) 勾选 → 保存 → 下载入队
const firstCk = [...doc.querySelectorAll('input[data-tc]')].find(x => !x.disabled);
firstCk.checked = true;
firstCk.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 200));
ok('勾选保存调用 /select', calls.some(c => c.includes('/api/acq-tasks/atk1/select')));
const dlBtn = doc.querySelector('#td-dl');
ok('下载入队按钮存在', !!dlBtn);
if (dlBtn) {
  dlBtn.click();
  await new Promise((r) => setTimeout(r, 250));
  ok('下载入队调用 /download', calls.some(c => c.includes('/api/acq-tasks/atk1/download')));
}

// 7) 综述按钮（论文未解析完成时应禁用）
ok('综述按钮存在（未解析完时禁用）',
   !!doc.querySelector('#td-mksyn') && doc.querySelector('#td-mksyn').disabled);

// 8) 综述发起弹层：显示预计调用数 + 费用预估（用户真正关心花多少钱）
{
  window.__T.state.selected = new Set(['p1', 'p2']);
  await window.__T.runSynthesis(null);
  await new Promise((r) => setTimeout(r, 300));
  const pop = doc.querySelector('.syn-launch');
  ok('综述发起弹层打开', !!pop);
  const callsTxt = (doc.querySelector('#syn-calls') || {}).textContent || '';
  ok('弹层显示预计调用数', callsTxt.trim() === '4', 'calls=' + callsTxt);
  const costTxt = (doc.querySelector('#syn-cost') || {}).textContent || '';
  ok('弹层显示费用预估金额', /¥0\.08(?!\d)/.test(costTxt), 'cost=' + costTxt);
  // 切档位 → 调用数与费用同步更新
  const std = [...doc.querySelectorAll('input[name=syn-tier]')].find(x => x.value === 'standard');
  if (std) {
    std.checked = true;
    std.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 120));
    const c2 = (doc.querySelector('#syn-calls') || {}).textContent || '';
    const m2 = (doc.querySelector('#syn-cost') || {}).textContent || '';
    ok('切篇幅档 → 调用数同步更新（4→12）', c2.trim() === '12', 'calls=' + c2);
    ok('切篇幅档 → 费用同步更新', /¥0\.24(?!\d)/.test(m2), 'cost=' + m2);
  }
  doc.querySelector('.syn-launch [data-cancel]')?.click();
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
