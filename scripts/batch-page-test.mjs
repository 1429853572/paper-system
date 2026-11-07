/**
 * 批量中心页回归测试（jsdom 无头）
 * 用法: node scripts/batch-page-test.mjs
 * 覆盖: 批量页签切换 / 圈定器（勾选·当前列表）/ 操作卡渲染 / 批次进度面板展开 / 批量条新按钮
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
  '/api/presets': { questions: [] },
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 2, collections: [
    { id: 'c1', name: '默认文献库', parent_id: null, papers: 2, papers_total: 2 },
    { id: 'c2', name: 'test', parent_id: null, papers: 43, papers_total: 43 }] },
  '/api/papers': { total: 2, papers: [
    { id: 'p1', title: 'Paper One', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    { id: 'p2', title: 'Paper Two', parse_status: 'failed', visibility: 'shared', owner_id: 1, page_count: 12, file_size: 2048 },
  ] },
  '/api/statuses': { statuses: {} },
  '/api/health': { db: true, mineru: true, ai: true, trash_days: 30 },
  '/api/batches': { batches: [
    { batch_id: 'bt1', job_type: 'summary', total: 3, done: 2, failed: 1, active: 0,
      started_at: '2026-11-07 10:00:00', updated_at: '2026-11-07 10:05:00' },
    { batch_id: 'synb', job_type: 'synthesis', total: 1, done: 1, failed: 0, active: 0,
      started_at: '2026-11-07 11:00:00', updated_at: '2026-11-07 11:09:00' },
  ] },
  '/api/synthesize/estimate': { valid: 2, missing_summaries: 1, groups: 1, calls: 3, no_parse: [] },
  '/api/synthesize': { synthesis_id: 's1', batch_id: 'synb', estimate: { valid: 2, missing_summaries: 1, groups: 1, calls: 3 } },
  '/api/jobs': { jobs: [
    { id: 11, job_type: 'summary', status: 'done', title: 'Paper One', paper_id: 'p1', batch_id: 'bt1', progress_done: 1, progress_total: 1 },
    { id: 12, job_type: 'summary', status: 'failed', title: 'Paper Two', paper_id: 'p2', batch_id: 'bt1', progress_done: 0, progress_total: 1, error: 'LLM 超时' },
  ] },
  '/api/syntheses/s1': { synthesis: {
    id: 's1', title: '文献综述 · 2 篇', status: 'done', stage: 'final',
    progress_done: 3, progress_total: 3, model: 'test-model',
    paper_ids: JSON.stringify(['p1', 'p2']),
    clusters: JSON.stringify([{ name: '三维重建', paper_ids: ['p1', 'p2'] }]),
    report_md: '# 文献综述\n## 一、总体概览\n两篇论文都研究三维重建。\n## 二、分主题梳理\n### 组 1: 三维重建\n- Paper One: 方法A\n- Paper Two: 方法B\n',
    matrix_csv: '主题组,标题\n三维重建,Paper One\n', error: null,
    created_at: '2026-11-07 11:00:00', updated_at: '2026-11-07 11:09:00' } },
  '/api/papers/p1': { paper: { id: 'p1', title: 'Paper One', parse_status: 'parsed', visibility: 'shared', owner_id: 1 }, blocks: [], total: 0 },
  '/api/papers/p1/bilingual': { pairs: [], versions: [] },
  '/api/papers/p1/notes': { notes: {} },
  '/api/papers/p1/assets': { figures: [], tables: [] },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/cite': { styles: {}, labels: {}, default: 'gbt7714' },
  '/api/papers/p1/summary': { summary: null },
  '/api/papers/p1/jobstate': { parse_status: 'parsed', parsing: false, translating: false, translated: false },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/admin/users': { users: [] },
  '/api/admin/pool': { enabled: false },
};

const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

// 45 篇论文基座：供自由勾选面板分页 mock（20/页 → 3 页）
const PICK_POOL = Array.from({length: 45}, (_, i) => ({
  id: `pb${String(i + 1).padStart(2, '0')}`,
  title: i === 44 ? 'UniqueNeedle Paper 独特针' : `Batch Pool Paper ${i + 1}`,
  year: String(2020 + (i % 6)), parse_status: 'parsed', visibility: 'shared', owner_id: 1,
  collection_id: i < 2 ? 'c1' : 'c2',
  page_count: 10 + i,
}));

window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const path = u.split('?')[0];
  const q = new URLSearchParams(u.split('?')[1] || '');
  // synthesis 批次的 job 明细（payload 携带 synthesis_id）
  if (path === '/api/jobs' && q.get('batch_id') === 'synb') {
    return { ok: true, status: 200, json: async () => ({ jobs: [
      { id: 21, job_type: 'synthesis', status: 'done', title: null, paper_id: null,
        batch_id: 'synb', payload: JSON.stringify({ synthesis_id: 's1' }),
        progress_done: 3, progress_total: 3 },
    ] }) };
  }
  // /api/papers：按 query 分页（自由勾选面板用）
  if (path === '/api/papers' && q.has('page') && q.get('page_size') === '20') {
    const kw = (q.get('q') || '').toLowerCase();
    const cids = (q.get('collection_id') || '').split(',').filter(Boolean);
    const filtered = PICK_POOL.filter(p =>
      (!kw || p.title.toLowerCase().includes(kw)) &&
      (!cids.length || cids.includes(p.collection_id)));
    const page = Math.max(1, +q.get('page') || 1);
    const slice = filtered.slice((page - 1) * 20, page * 20);
    return { ok: true, status: 200,
             json: async () => ({ papers: slice, page, has_more: page * 20 < filtered.length }) };
  }
  const body = DATA[path] ?? {};
  return { ok: true, status: 200, json: async () => body, blob: async () => ({ size: 10 }) };
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};

window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
process.on('unhandledRejection', (r) => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  if (/reading 'configured'/.test(m)) return;
  errors.push('rejection: ' + m);
});

try {
  window.eval(js + '\n;window.__T = { state, switchPage, renderBatchPage, setBatchSel };');
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

// 1) 顶栏「批量」页签存在且可切换
const btn = doc.querySelector('.topnav button[data-page="batch"]');
ok('批量页签按钮存在', !!btn);
if (btn) {
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const pg = doc.querySelector('#page-batch');
  ok('批量页显示', pg && pg.style.display !== 'none');
  ok('页面标题', doc.querySelector('#page-title').textContent === '批量中心');
}

// 2) 三区结构
ok('圈定器渲染', !!doc.querySelector('#page-batch .batch-pick'));
ok('操作卡数量≥6', doc.querySelectorAll('#page-batch .batch-card').length >= 6,
   `实际 ${doc.querySelectorAll('#page-batch .batch-card').length}`);
ok('综述卡已激活', !!doc.querySelector('#page-batch .batch-card[data-act="review"]') &&
   !doc.querySelector('#page-batch .batch-card[data-act="review"]').classList.contains('soon'));
ok('进度面板渲染', !!doc.querySelector('#page-batch #batch-panel'));

// 3) 圈定：当前列表
// jsdom 中 boot 在 initPdfJs 的动态 import 处中断（既有回归同样如此），loadPapers 不会执行——
// 这里直接 seed state.papers 模拟“已加载的文库列表”，被测对象是批量页逻辑而非 boot。
window.__T.state.papers = [
  { id: 'p1', title: 'Paper One', parse_status: 'parsed', visibility: 'shared', owner_id: 1 },
  { id: 'p2', title: 'Paper Two', parse_status: 'failed', visibility: 'shared', owner_id: 1 },
];
const bpList = doc.querySelector('#bp-list');
ok('「当前列表」按钮存在', !!bpList);
if (bpList) {
  bpList.click();
  await new Promise((r) => setTimeout(r, 100));
  ok('圈定计数 2 篇', doc.querySelector('#bp-count').textContent.includes('2 篇'),
     doc.querySelector('#bp-count').textContent);
  ok('明细展开显示 2 行', doc.querySelectorAll('#bp-rows .bp-row').length === 2);
  ok('清空按钮出现', !doc.querySelector('#bp-clear').hidden);
  doc.querySelector('#bp-clear').click();
  await new Promise((r) => setTimeout(r, 50));
  ok('清空后计数归零', doc.querySelector('#bp-count').textContent.includes('0 篇'));
}

// 4) 圈定：我的勾选
window.__T.state.selected.add('p1');
doc.querySelector('#bp-sel').click();
await new Promise((r) => setTimeout(r, 100));
ok('勾选圈定 1 篇', doc.querySelector('#bp-count').textContent.includes('1 篇'));

// 5) 批次进度面板：批次行渲染 + 展开逐篇
await new Promise((r) => setTimeout(r, 200));
const batchRow = doc.querySelector('#batch-panel .bpanel-batch');
ok('批次行渲染', !!batchRow);
ok('批次操作名显示', batchRow && batchRow.textContent.includes('批量导读'));
ok('失败数显示', batchRow && batchRow.textContent.includes('1 失败'));
const head = doc.querySelector('.bpanel-row.head');
if (head) {
  head.click();
  await new Promise((r) => setTimeout(r, 150));
  const jobs = doc.querySelectorAll('.bpanel-row.sub');
  ok('批次展开逐篇 2 行', jobs.length === 2, `实际 ${jobs.length}`);
  ok('失败行有重试键', !!doc.querySelector('[data-retry="12"]'));
  ok('错误信息显示', doc.querySelector('.bpanel-err')?.textContent.includes('LLM 超时'));
  head.click();
  await new Promise((r) => setTimeout(r, 100));
  ok('再点收起', doc.querySelector('[data-jobs="bt1"]').hidden);
}

// 6) 批量选择主入口在文库管理页：勾选 → 批量中心 »（耦合流）
window.__T.state.libLevel = 2;   // 进第二层（库内论文表），第一层是库列表
window.__T.state.libSel = '';
window.__T.switchPage('collections');
await new Promise((r) => setTimeout(r, 300));
const libCk = doc.querySelector('.lib-ck');
ok('文库页论文复选框存在', !!libCk);
if (libCk) {
  libCk.checked = true;
  window.libCk(libCk.dataset.cid);
  await new Promise((r) => setTimeout(r, 80));
  ok('勾选同步 state.selected', window.__T.state.selected.has(libCk.dataset.pid));
  window.libToBatchCenter(libCk.dataset.cid);
  await new Promise((r) => setTimeout(r, 400));
  ok('批量中心按钮切页', doc.querySelector('#page-batch').style.display !== 'none');
  const cnt = doc.querySelector('#bp-count')?.textContent || '';
  ok('preset 圈定生效', /1 篇/.test(cnt), cnt);
  window.__T.state.selected.clear();
}

// 6.5) 自由勾选面板：分页 / 复选 / 全选本页 / 搜索
window.__T.switchPage('batch');
window.__T.state.batchSel = new Set();   // 清掉步骤6 preset 残留，计数从零起算
await new Promise((r) => setTimeout(r, 300));
doc.querySelector('#bp-pick-toggle').click();
await new Promise((r) => setTimeout(r, 250));
ok('勾选面板展开且 20 行', !doc.querySelector('#bp-picker').hidden &&
   doc.querySelectorAll('.bpp-row').length === 20, `实际 ${doc.querySelectorAll('.bpp-row').length}`);
ok('下一页可用（45 篇 → 3 页）', !doc.querySelector('#bpp-next').disabled);
ok('行显示所属库', doc.body.textContent.includes('test') &&
   doc.body.textContent.includes('默认文献库'));
ok('库筛选下拉存在（全部库+2）', doc.querySelectorAll('#bpp-lib option').length === 3);
doc.querySelector('#bpp-lib').value = 'c2';
doc.querySelector('#bpp-lib').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 250));
ok('按库筛选后 20 行（c2 有 43 篇）', doc.querySelectorAll('.bpp-row').length === 20 &&
   doc.querySelector('#bpp-page').textContent.includes('test'));
doc.querySelector('#bpp-lib').value = '';
doc.querySelector('#bpp-lib').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 250));
doc.querySelector('.bpp-row input[type=checkbox]').click();
await new Promise((r) => setTimeout(r, 80));
ok('逐条勾选计数 1', doc.querySelector('#bp-count').textContent.includes('1 篇'));
doc.querySelector('#bpp-all').click();
await new Promise((r) => setTimeout(r, 80));
ok('全选本页 → 20 篇（已勾项在本页内，并集 20）',
   doc.querySelector('#bp-count').textContent.includes('20 篇'),
   doc.querySelector('#bp-count').textContent);
doc.querySelector('#bpp-next').click();
await new Promise((r) => setTimeout(r, 250));
ok('翻到第 2 页且勾选保留', doc.querySelector('#bpp-page').textContent.includes('第 2 页') &&
   doc.querySelector('#bp-count').textContent.includes('20 篇'));
doc.querySelector('#bpp-all').click();
await new Promise((r) => setTimeout(r, 80));
ok('第 2 页全选 → 40 篇', doc.querySelector('#bp-count').textContent.includes('40 篇'));
doc.querySelector('#bpp-none').click();
await new Promise((r) => setTimeout(r, 80));
ok('本页取消 → 20 篇', doc.querySelector('#bp-count').textContent.includes('20 篇'));
doc.querySelector('#bpp-search').value = '独特针';
doc.querySelector('#bpp-search').dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 450));   // 300ms 防抖 + 加载
ok('搜索命中 1 行', doc.querySelectorAll('.bpp-row').length === 1 &&
   doc.querySelector('.bpp-title').textContent.includes('独特针'));
doc.querySelector('#bp-clear').click();
await new Promise((r) => setTimeout(r, 100));
ok('清空圈定 → 0 篇', doc.querySelector('#bp-count').textContent.includes('0 篇'));

// 7) 综述流：卡片激活 → 预估确认 → 批次面板综述行 → 报告视图
const reviewCard = doc.querySelector('.batch-card[data-act="review"]');
ok('综述卡已激活（无 soon）', !!reviewCard && !reviewCard.classList.contains('soon'));
// 切回批量页重新渲染（前面 tocenter 已切页）
window.__T.switchPage('batch');
await new Promise((r) => setTimeout(r, 300));
window.__T.state.batchSel = new Set(['p1', 'p2']);
doc.querySelector('.batch-card[data-act="review"]').click();
await new Promise((r) => setTimeout(r, 200));
const synPop = [...doc.querySelectorAll('.ui-pop')].find(p => p.textContent.includes('发起综述'));
ok('综述预估确认弹窗出现', !!synPop && synPop.textContent.includes('3 次 LLM 调用'),
   synPop ? synPop.textContent.slice(0, 80) : '未找到弹窗');
if (synPop) {
  synPop.querySelector('[data-ok]').click();
  await new Promise((r) => setTimeout(r, 350));
  // 新批次自动展开（_batchOpen=synb）→ renderSynJob
  const synRow = doc.querySelector('[data-syn-view="s1"]');
  ok('综述行出现查看报告键', !!synRow);
  ok('综述行有导出键', !!doc.querySelector('[data-syn-dl="s1"][data-fmt="csv"]'));
  if (synRow) {
    synRow.click();
    await new Promise((r) => setTimeout(r, 250));
    ok('报告视图渲染', !!doc.querySelector('#syn-report') &&
       doc.querySelector('#syn-report').textContent.includes('总体概览'));
    ok('组导航渲染', doc.querySelectorAll('.syn-nav-group').length === 1 &&
       doc.querySelector('.syn-nav-group b').textContent.includes('三维重建'));
    ok('论文可点回阅读', !!doc.querySelector('[data-syn-paper="p1"]'));
    ok('导出键存在', !!doc.querySelector('#syn-dl-md') && !!doc.querySelector('#syn-dl-csv'));
    doc.querySelector('#syn-back').click();
    await new Promise((r) => setTimeout(r, 250));
    ok('返回批量页', !!doc.querySelector('.batch-ops'));
  }
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);   // 批量页轮询等 setInterval 会吊住事件循环，显式退出
