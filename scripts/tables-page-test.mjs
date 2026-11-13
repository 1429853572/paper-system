/**
 * 表格工作台页面回归（jsdom 无头）
 * 用法: node scripts/tables-page-test.mjs
 * 覆盖: 双栏渲染（KPI/左栏论文聚合）/卡片状态徽章/筛选/收表弹层/批量整理入队/
 *       批量取舍/编辑保存 PATCH/导出调用/对照弹层网格
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
  { id: 'tb1', paper_id: 'p1', page_index: 2, caption: 'Table 1: Ablation', review: 'pending',
    ai_status: 'done', ai_note: '合并表头', asset_name: 'page_2_table_1.jpg', paper_title: 'Paper A',
    n_rows: 6, n_cols: 16 },
  { id: 'tb2', paper_id: 'p1', page_index: 3, caption: 'Table 2: Compare', review: 'pending',
    ai_status: 'mismatch', ai_note: '行列不一致', asset_name: 'page_3_table_1.jpg', paper_title: 'Paper A',
    n_rows: 11, n_cols: 14 },
  { id: 'tb3', paper_id: 'p2', page_index: 0, caption: '表 3 数据', review: 'deleted',
    ai_status: 'none', ai_note: null, asset_name: null, paper_title: 'Paper B', n_rows: 4, n_cols: 5 },
];
const LIST = { items: ITEMS, total: 3, page: 1, page_size: 60,
  counts: { total: 3, pending: 2, kept: 0, deleted: 1, done: 1, mismatch: 1, queued: 0, running: 0, none: 2, failed: 0, working: 0 },
  by_paper: [
    { paper_id: 'p1', title: 'Paper A', n: 2, done: 1, mismatch: 1, deleted: 0 },
    { paper_id: 'p2', title: 'Paper B', n: 1, done: 0, mismatch: 0, deleted: 1 },
  ] };
const DETAIL = { id: 'tb1', paper_id: 'p1', page_index: 2, caption: 'Table 1: Ablation',
  cells: '[["Method","PSNR"],["A","25.1"]]', ai_cells: '[["Method","PSNR (dB)"],["A","25.1"]]',
  ai_note: '单位并入列头', ai_status: 'done', review: 'pending', html: '<table></table>',
  asset_name: 'page_2_table_1.jpg', paper_title: 'Paper A',
  img_url: '/api/papers/p1/images/page_2_table_1.jpg' };

const DATA = {
  '/api/me': { id: 1, username: 'tester', role: 'admin', llm_configured: { chat: true, translate: true } },
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 0, collections: [], shared_libs: [] },
  '/api/statuses': { statuses: {} },
  '/api/papers': { total: 0, papers: [] },
  '/api/batches': { batches: [] },
  '/api/cmdtags': { tags: [] },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/tracker/subs': { subs: [], counts: { inbox: 0 }, smtp_ready: false },
};

let tidyCalls = [], reviewCalls = [], patchCalls = [], exportCalls = [], harvestCalls = [];
const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  if (u === '/api/tables/list') {
    const q = String(url);
    if (q.includes('review=deleted')) return { ok: true, status: 200, json: async () => ({ ...LIST, items: [ITEMS[2]], total: 1 }) };
    if (q.includes('paper_id=p2')) return { ok: true, status: 200, json: async () => ({ ...LIST, items: [ITEMS[2]], total: 1 }) };
    const active = LIST.items.filter(i => i.review !== 'deleted');   // 默认 active=未剔除
    return { ok: true, status: 200, json: async () => ({ ...LIST, items: active, total: active.length }) };
  }
  if (u === '/api/tables/sources') {
    return { ok: true, status: 200, json: async () => ({ sources: [
      { paper_id: 'p1', title: 'Paper A', n_tables: 5, in_bench: 2 },
      { paper_id: 'p3', title: 'Paper C', n_tables: 3, in_bench: 0 }] }) };
  }
  if (u === '/api/tables/harvest') { harvestCalls.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ papers: 1, found: 3, inserted: 3, skipped: 0, job_id: 7 }) }; }
  if (u === '/api/tables/tidy-batch') { tidyCalls.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ ok: true, job_id: 9, count: 2 }) }; }
  if (u.startsWith('/api/tables/tb') && u.endsWith('/review')) { reviewCalls.push(u); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (u === '/api/tables/batch-review') { reviewCalls.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ ok: true, count: 2 }) }; }
  if (u.startsWith('/api/tables/tb1') && opts.method === 'PATCH') { patchCalls.push(JSON.parse(opts.body || '{}')); return { ok: true, status: 200, json: async () => ({ ok: true, rows: 2, cols: 2 }) }; }
  if (u === '/api/tables/tb1') return { ok: true, status: 200, json: async () => DETAIL };
  if (u === '/api/tables/export') {
    exportCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, blob: async () => ({ size: 100 }) };
  }
  const body = DATA[u] ?? {};
  return { ok: true, status: 200, json: async () => body };
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = () => {};
window.matchMedia = window.matchMedia || (q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
window.Element.prototype.scrollIntoView = function () {};
window.addEventListener('error', e => errors.push('window error: ' + e.message));
process.on('unhandledRejection', r => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  errors.push('rejection: ' + m);
});

window.eval(js);
window.uiConfirm = async () => true;   // jsdom 弹窗 stub

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' — ' + x)); c ? pass++ : fail++; };

await sleep(600);
window.switchPage('tables');
await sleep(500);

// 1. 双栏 + KPI + 左栏聚合
ok('1 页面渲染：KPI 6 卡 + 左栏聚合（全部+2 篇论文）',
   window.document.querySelectorAll('#tb-kpis .tk-kpi').length === 6 &&
   window.document.querySelectorAll('#tb-rail-list .tk-rail-item').length === 3 &&
   window.document.querySelector('#tb-rail-list .tk-rail-item .tk-rail-badge').textContent === '3');
ok('1b 左栏论文行带状态微标（✓1）',
   window.document.querySelector('#tb-rail-list .tb-rail-mini')?.textContent.includes('✓1'));
ok('2 卡片墙：2 张未剔除卡 + 状态徽章（已整理✓/需复核红）',
   window.document.querySelectorAll('.tb-card').length === 2 &&
   !!window.document.querySelector('.tb-card .badge.ok') &&
   !!window.document.querySelector('.tb-card .badge.err'));

// 2. 左栏筛选
await window.tbPaperF('p2');
await sleep(300);
ok('3 点论文筛选（Paper B 剔除卡出现）',
   window.document.querySelectorAll('.tb-card').length === 1 &&
   window.document.querySelector('.tb-card').textContent.includes('已剔除'));
await window.tbPaperF('');
await sleep(300);

// 3. 对照弹层 + 网格 + 保存
await window.tbCompare('tb1');
await sleep(400);
const pop = window.document.querySelector('.ui-pop.tb-compare-pop');
const trs = window.document.querySelectorAll('#tb-edit-grid tr').length;
const tds = [...window.document.querySelectorAll('#tb-edit-grid td[contenteditable="true"]')];
const navBar = [...(pop?.querySelectorAll('.tbws-foot .btn') || [])].map(b => b.textContent.trim()).join(',');
const count = pop?.querySelector('.tbws-count')?.textContent;
const imgOk = !!pop?.querySelector('.tbws-img img');
const cellV = tds.at(-1)?.textContent;
ok('4 对照工作台（全屏 + 截图 + 网格 + 翻页操作条）',
   !!pop && trs === 2 && cellV === '25.1' && imgOk &&
   navBar.includes('下一张') && navBar.includes('剔除并下一张') && /^\d+ \/ \d+$/.test(count || ''),
   `pop=${!!pop} trs=${trs} cell=${cellV} nav=${navBar.slice(0, 40)} count=${count}`);
await window.tbGridSave('tb1', null);
await sleep(300);
ok('5 编辑保存 PATCH（写整理版）', patchCalls.length === 1 && Array.isArray(patchCalls[0].cells), JSON.stringify(patchCalls[0]).slice(0, 60));
window.document.querySelector('.ui-pop.tb-compare-pop .btn')?.click();

// 4. 批量整理（按筛选圈表）
tidyCalls = [];
await window.tbTidyBatch(null, false);
await sleep(300);
ok('6 批量整理入队（filtered 传递当前筛选）',
   tidyCalls.length === 1 && tidyCalls[0].filtered && tidyCalls[0].filtered.review === 'active', JSON.stringify(tidyCalls[0]).slice(0, 60));

// 5. 勾选 + 批量取舍 + 批量整理选中
const ck = window.document.querySelector('.tb-ck');
ck.checked = true;
await window.tbCk(ck);
await sleep(300);
reviewCalls = [];
await window.tbBatchReview(null, 'deleted');
await sleep(300);
ok('7 批量剔除（batch-review 调用）',
   reviewCalls.length === 1 && reviewCalls[0].review === 'deleted' && reviewCalls[0].ids.length === 1);

// 6. 收表弹层
await window.tbHarvestOpen();
await sleep(300);
const srcItems = window.document.querySelectorAll('.tb-src-item');
ok('8 收表弹层（来源清单 + 已收徽章）', srcItems.length === 2 &&
   srcItems[0].textContent.includes('已收 2'));
window.document.querySelector('.tb-src-item:nth-child(2) input').checked = true;
harvestCalls = [];
await window.tbHarvestGo(window.document.querySelector('.ui-pop.tb-harvest-pop .btn.primary'), false);
await sleep(300);
ok('9 收表调用（勾选篇 + auto_tidy）',
   harvestCalls.length === 1 && harvestCalls[0].paper_ids.length === 1 && harvestCalls[0].auto_tidy === true,
   JSON.stringify(harvestCalls[0]));

// 6b. 上传链入口
await window.tbUploadOpen();
await sleep(200);
ok('6b 上传弹层（文件+自动整理勾选）',
   !!window.document.querySelector('#tb-up-files') &&
   window.document.querySelector('#tb-up-tidy')?.checked === true);
window._tbUpClose();

// 7. 导出（单表）
exportCalls = [];
await window.tbExport(['tb1'], null);
await sleep(300);
ok('10 单表导出调用', exportCalls.length === 1 && exportCalls[0].ids[0] === 'tb1');

ok('零 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
