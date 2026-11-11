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
  '/api/chat/sessions': { sessions: [] },
  '/api/collections': { total: 2, collections: [
    { id: 'c1', name: '默认文献库', parent_id: null, papers: 2, papers_total: 2 },
    { id: 'c2', name: 'test', parent_id: null, papers: 43, papers_total: 43 }] },
  '/api/papers': { total: 2, papers: [
    { id: 'p1', title: 'Paper One', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    { id: 'p2', title: 'Paper Two', parse_status: 'failed', visibility: 'shared', owner_id: 1, page_count: 12, file_size: 2048 },
  ] },
  '/api/statuses': { statuses: {} },
  '/api/mcp/pending': { pending: [] },
  '/api/health': { db: true, mineru: true, ai: true, trash_days: 30 },
  '/api/acq-tasks': { tasks: [{ id: 'atk1', title: '测试专题', query: '3DGS', site: 'chinaxiv',
      status: 'running', cand_total: 3, cand_selected: 1, cand_done: 1, papers: 1,
      created_at: '2026-11-10', updated_at: '2026-11-10' }] },
  '/api/batches': { batches: [
    { batch_id: 'live1', job_type: 'translate', total: 2, done: 0, failed: 0, canceled: 0, active: 2,
      started_at: '2026-11-07 12:00:00', updated_at: '2026-11-07 12:01:00' },
    { batch_id: 'bt1', job_type: 'summary', total: 3, done: 2, failed: 1, canceled: 0, active: 0,
      started_at: '2026-11-07 10:00:00', updated_at: '2026-11-07 10:05:00' },
    { batch_id: 'synb', job_type: 'synthesis', total: 1, done: 1, failed: 0, canceled: 0, active: 0,
      started_at: '2026-11-07 11:00:00', updated_at: '2026-11-07 11:09:00' },
  ] },
  '/api/syntheses': { syntheses: [
    { id: 's1', title: '文献综述 · 2 篇', status: 'done', papers: 2, model: 'test-model',
      progress_done: 3, progress_total: 3, error: null,
      created_at: '2026-11-07 11:00:00', updated_at: '2026-11-07 11:09:00' },
    { id: 's2', title: '需修复综述', status: 'needs_fix', papers: 3, model: 'test-model',
      progress_done: 5, progress_total: 5, error: '引用校验未通过：缺漏 2 / 幻影 0',
      created_at: '2026-11-07 12:00:00', updated_at: '2026-11-07 12:10:00' } ] },
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
    report_md: '# 文献综述\n## 一、总体概览\n两篇论文都研究三维重建。\n## 二、分主题梳理\n### 组 1: 三维重建\n- Paper One: 方法A\n- Paper Two: 方法B\n\n## 参考文献\n- (Fei et al., 2024) x. ',
    matrix_csv: '主题组,标题\n三维重建,Paper One\n', error: null,
    verification: JSON.stringify({pass: true, missing: [], phantom: [], stale: [], refs_n: 2, table_n: 2, cjk: 800}),
    frameworks: JSON.stringify({recommended: 0, reason: 'test',
      frameworks: [{name: '按先验范式', rationale: 'r1', outline: []},
                   {name: '按问题类型', rationale: 'r2', outline: []}]}),
    cite_table: JSON.stringify([
      {id: 'p1', key: 'Fei et al., 2024', evidence: 'api', title: 'Paper One', venue: 'CVPR', year: '2024', arxiv: ''},
      {id: 'p2', key: '刘晓悦等，2026', evidence: 'zh-manual', title: 'Paper Two', venue: '', year: '2026', arxiv: ''}]),
    params: JSON.stringify({tier: 'standard', style: 'author_year', axis: '测试轴'}),
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

const calls = [];
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const path = u.split('?')[0];
  const q = new URLSearchParams(u.split('?')[1] || '');
  calls.push(`${path} ${(opts.method || 'GET')}`);
  // synthesis 批次的 job 明细（payload 携带 synthesis_id）
  if (path === '/api/jobs' && q.get('batch_id') === 'live1') {
    return { ok: true, status: 200, json: async () => ({ jobs: [
      { id: 31, job_type: 'translate', status: 'running', title: 'Pool Paper A', paper_id: 'pb01',
        batch_id: 'live1', progress_done: 1, progress_total: 3 },
      { id: 32, job_type: 'translate', status: 'queued', title: 'Pool Paper B', paper_id: 'pb02',
        batch_id: 'live1', progress_done: 0, progress_total: 0 },
    ] }) };
  }
  if (path === '/api/jobs' && q.get('batch_id') === 'synb') {
    return { ok: true, status: 200, json: async () => ({ jobs: [
      { id: 21, job_type: 'synthesis', status: 'done', title: null, paper_id: null,
        batch_id: 'synb', payload: JSON.stringify({ synthesis_id: 's1' }),
        progress_done: 3, progress_total: 3 },
    ] }) };
  }
  // /api/papers：勾选面板全量拉取（page_size=500）
  if (path === '/api/papers' && q.get('page_size') === '500') {
    return { ok: true, status: 200,
             json: async () => ({ papers: PICK_POOL, page: 1, has_more: false }) };
  }
  const body = DATA[path] ?? {};
  return { ok: true, status: 200, json: async () => body, blob: async () => ({ size: 10 }) };
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'x';
window.isSecureContext = false;
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};   // jsdom 未实现
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
  window.eval(js + '\n;window.__T = { state, switchPage, renderTaskPanel, renderCollectionsPage };');
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
  const line = `${cond ? 'OK' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
  results.push(line); console.log(line);   // 即时输出：中途崩溃也不丢结果
  if (!cond) errors.push(`${name}${extra ? ': ' + extra : ''}`);
};

// 1) 顶级导航已精简为 阅读/文库/任务（批量页取消，采集并入文库、综述历史并入任务）
ok('不再有独立「批量」顶级页', !doc.querySelector('.topnav button[data-page="batch"]'));
ok('导航保留 阅读/文库/任务', ['reader', 'collections', 'tasks']
   .every(p => !!doc.querySelector(`.topnav button[data-page="${p}"]`)));
ok('任务中心页签存在', !!doc.querySelector('.topnav button[data-page="tasks"]'));

// 5) 任务中心：独立页 + 类型徽章 + 分区
window.__T.switchPage('tasks');
await new Promise((r) => setTimeout(r, 300));
ok('任务中心页标题', doc.querySelector('#page-title').textContent === '任务中心');
ok('类型筛选 chips（含采集下载）', doc.querySelectorAll('#page-tasks [data-tt]').length === 7);
ok('状态筛选 chips', doc.querySelectorAll('#page-tasks [data-ts]').length === 4);
await new Promise((r) => setTimeout(r, 200));
ok('进度分组标题（进行中/已结束）', doc.body.textContent.includes('进行中') &&
   doc.body.textContent.includes('已结束'));
ok('活跃批次自动展开（live1 逐篇可见）',
   !doc.querySelector('[data-jobs="live1"]').hidden &&
   doc.querySelectorAll('[data-jobs="live1"] .bpanel-row.sub').length === 2);
ok('失败计数口径（2/3 · 1 失败）',
   [...doc.querySelectorAll('.bpanel-row.head')].some(r => r.textContent.includes('2/3') &&
                                                    r.textContent.includes('1 失败')));
const batchRow = doc.querySelector('#page-tasks [data-batch="bt1"]');
ok('批次行渲染', !!batchRow);
ok('任务类型徽章显示', batchRow && batchRow.textContent.includes('导读'));
ok('失败数显示', batchRow && batchRow.textContent.includes('1 失败'));
const head = doc.querySelector('#page-tasks [data-batch="bt1"] .bpanel-row.head');
if (head) {
  head.click();
  await new Promise((r) => setTimeout(r, 150));
  const jobs = doc.querySelectorAll('#page-tasks [data-batch="bt1"] .bpanel-row.sub');
  ok('批次展开逐篇 2 行', jobs.length === 2, `实际 ${jobs.length}`);
  ok('失败行有重试键', !!doc.querySelector('[data-retry="12"]'));
  ok('错误信息显示', doc.querySelector('.bpanel-err')?.textContent.includes('LLM 超时'));
  head.click();
  await new Promise((r) => setTimeout(r, 100));
  ok('再点收起', doc.querySelector('[data-jobs="bt1"]').hidden);
}

// 5b) 已结束区有「清理记录」入口（任务日志会无限堆积）
{
  await window.__T.renderTaskPanel();
  await new Promise((r) => setTimeout(r, 250));
  const clr = doc.querySelector('[data-jobs-clear]');
  ok('已结束区有清理记录按钮', !!clr);
  if (clr) {
    calls.length = 0;
    clr.click();
    await new Promise((r) => setTimeout(r, 250));
    // 确认框 → 点确认
    const okBtn = doc.querySelector('.ui-pop [data-ok]');
    ok('清理前有确认框', !!okBtn);
    if (okBtn) {
      okBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      ok('清理调用 /api/jobs/clear-finished',
         calls.some(c => c.includes('/api/jobs/clear-finished')));
    }
  }
}

// 6) 批量选择主入口在文库管理页：勾选 → 批量中心（耦合流）
window.__T.switchPage('batch');
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
  window.libToBatchCenter();
  await new Promise((r) => setTimeout(r, 400));
  ok('「去任务中心」按钮切页', doc.querySelector('#page-tasks').style.display !== 'none');
  ok('勾选全站共享（文库页勾选任务中心可见）', window.__T.state.selected.size === 1);
  window.__T.state.selected.clear();
}

// 6.5) 采集浮层（批量页取消后，采集入口并入文库管理）
window.__T.switchPage('collections');
await new Promise((r) => setTimeout(r, 400));
window.openCollectPanel && window.openCollectPanel();
await new Promise((r) => setTimeout(r, 400));
ok('采集浮层打开', !!doc.querySelector('.collect-panel'));
ok('浮层含快速采集与专题跟踪', !!doc.querySelector('#acq-btn') && !!doc.querySelector('#cp-topics'));
ok('浮层内含专题列表', doc.querySelectorAll('.tp-row').length >= 1);
// 7) 综述流：文库批量条「综述」发起（综述唯一入口）→ 预估确认 → 批次面板综述行 → 报告视图

// 切到文库管理页第二层，用页面复选框勾选 2 篇（走真实勾选路径），再点批量条「综述」
window.__T.state.libLevel = 2; window.__T.state.libSel = '';
window.__T.switchPage('collections');
await new Promise((r) => setTimeout(r, 400));
const cks = [...doc.querySelectorAll('.lib-ck')].slice(0, 2);
ok('文库论文表有复选框', cks.length >= 2, `实际 ${cks.length}`);
for (const c of cks) { c.checked = true; window.libCk(c.dataset.cid); }
await new Promise((r) => setTimeout(r, 200));
const synBtn = [...doc.querySelectorAll('.lib-batch button')].find(b => b.textContent.includes('综述'));
ok('文库批量条有「综述」按钮（唯一入口）', !!synBtn);
// 注意：jsdom runScripts:'outside-only' 不执行内联 onclick 属性（真实浏览器有效）→ 直接调等价入口
await window.libBatchSynth('all');
await new Promise((r) => setTimeout(r, 600));
const synPop = [...doc.querySelectorAll('.ui-pop')].find(p => p.textContent.includes('发起综述'));
ok('综述参数弹窗出现（survey-writer 五问）', !!synPop, '未找到弹窗');
ok('参数弹窗含组织轴输入', !!synPop?.querySelector('#syn-axis'));
ok('参数弹窗含三档篇幅', synPop && synPop.querySelectorAll('input[name=syn-tier]').length === 3);
ok('参数弹窗含引用式/用途', !!synPop?.querySelector('#syn-style') && !!synPop?.querySelector('#syn-purpose'));
ok('调用数联动显示', synPop && synPop.querySelector('#syn-calls')?.textContent === '3');
if (synPop) {
  // 选 standard → 调用数 +8
  const stdRadio = synPop.querySelector('input[name=syn-tier][value="standard"]');
  stdRadio.checked = true; stdRadio.dispatchEvent(new window.Event('change'));
  ok('选 standard 调用数 +8', synPop.querySelector('#syn-calls').textContent === '11');
  synPop.querySelector('[data-ok]').click();
  await new Promise((r) => setTimeout(r, 350));
  // 新批次自动展开（_batchOpen=synb）→ renderSynJob
  const synRow = doc.querySelector('[data-syn-view="s1"]');
  ok('综述行出现查看报告键', !!synRow);
  const nfRow = doc.querySelector('[data-syn-view="s2"]');
  ok('needs_fix 综述也有查看报告入口（不再失联）', !!nfRow &&
     nfRow.closest('.syn-item').textContent.includes('引用需修复'));
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
    ok('校验徽章 PASS', !!doc.querySelector('.syn-head .badge.ok') &&
       doc.querySelector('.syn-head .badge.ok').textContent.includes('PASS'));
    ok('框架卡渲染 + 换框架键', !!doc.querySelector('.syn-fw') &&
       !!doc.querySelector('[data-fw-rewrite="1"]'));
    ok('参考文献卡渲染（键+已核验徽章）', !!doc.querySelector('.syn-refs') &&
       doc.querySelector('.syn-refs').textContent.includes('Fei et al., 2024') &&
       doc.querySelector('.syn-refs .badge.ok'));
    doc.querySelector('#syn-back').click();
    await new Promise((r) => setTimeout(r, 250));
    ok('返回任务中心（综述报告并入任务页）', !!doc.querySelector('#task-body') &&
       !doc.querySelector('.syn-report'));
  }
}

// 10) 删除操作带「撤销」——误删不必去回收站翻
{
  calls.length = 0;
  const delBtn = doc.querySelector('[data-lib-del], .lib-batch .btn.danger');
  // 文库页渲染后才有批量删除按钮；找不到则直接构造 toast 场景验证组件
  if (delBtn) {
    delBtn.click();
    await new Promise((r) => setTimeout(r, 300));
  }
  // 直接验证 toast 组件能力：带 action 的 toast 渲染出按钮，点击后触发回调
  let fired = false;
  window.eval(`toast('已移入回收站', 0, {label:'撤销', onClick: () => { window.__undoFired = true; }})`);
  await new Promise((r) => setTimeout(r, 120));
  const undoBtn = doc.querySelector('#toast .toast-action');
  ok('toast 带「撤销」按钮', !!undoBtn && undoBtn.textContent.trim() === '撤销');
  if (undoBtn) {
    undoBtn.click();
    await new Promise((r) => setTimeout(r, 120));
    fired = !!window.__undoFired;
  }
  ok('点「撤销」触发回调', fired);
  // 恢复：清掉 toast 状态，避免影响后续断言
  window.eval(`document.querySelector('#toast')?.classList.remove('show')`);
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);   // 批量页轮询等 setInterval 会吊住事件循环，显式退出
