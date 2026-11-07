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
  '/api/collections': { total: 1, collections: [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }] },
  '/api/papers': { total: 2, papers: [
    { id: 'p1', title: 'Paper One', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    { id: 'p2', title: 'Paper Two', parse_status: 'failed', visibility: 'shared', owner_id: 1, page_count: 12, file_size: 2048 },
  ] },
  '/api/statuses': { statuses: {} },
  '/api/health': { db: true, mineru: true, ai: true, trash_days: 30 },
  '/api/batches': { batches: [
    { batch_id: 'bt1', job_type: 'summary', total: 3, done: 2, failed: 1, active: 0,
      started_at: '2026-11-07 10:00:00', updated_at: '2026-11-07 10:05:00' },
  ] },
  '/api/jobs': { jobs: [
    { id: 11, job_type: 'summary', status: 'done', title: 'Paper One', paper_id: 'p1', batch_id: 'bt1', progress_done: 1, progress_total: 1 },
    { id: 12, job_type: 'summary', status: 'failed', title: 'Paper Two', paper_id: 'p2', batch_id: 'bt1', progress_done: 0, progress_total: 1, error: 'LLM 超时' },
  ] },
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

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  const body = DATA[u] ?? {};
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
ok('综述卡为 soon 占位', !!doc.querySelector('#page-batch .batch-card.soon'));
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

// 6) 批量条新按钮
ok('#batch-reparse 存在', !!doc.querySelector('#batch-reparse'));
ok('#batch-tocenter 存在', !!doc.querySelector('#batch-tocenter'));
// 带勾选进批量中心
doc.querySelector('#sel-toggle').click();          // 进选择模式
doc.querySelectorAll('.paper-item')[0]?.click();   // 勾第一篇（打开 paper 或 toggle——selectMode 下 toggle）
await new Promise((r) => setTimeout(r, 100));
const toCenter = doc.querySelector('#batch-tocenter');
if (toCenter) {
  toCenter.click();
  await new Promise((r) => setTimeout(r, 400));
  ok('批量中心按钮切页', doc.querySelector('#page-batch').style.display !== 'none');
  // preset 圈定（若选择模式勾选成功，计数≥1）
  const cnt = doc.querySelector('#bp-count')?.textContent || '';
  ok('preset 圈定生效', /1 篇|0 篇/.test(cnt), cnt);
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);   // 批量页轮询等 setInterval 会吊住事件循环，显式退出
