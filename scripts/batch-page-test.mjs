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
  '/api/mcp/pending': { pending: [] },
  '/api/health': { db: true, mineru: true, ai: true, trash_days: 30 },
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
      created_at: '2026-11-07 11:00:00', updated_at: '2026-11-07 11:09:00' } ] },
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

window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const path = u.split('?')[0];
  const q = new URLSearchParams(u.split('?')[1] || '');
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
  window.eval(js + '\n;window.__T = { state, switchPage, renderBatchPage, syncBpCount };');
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
ok('任务中心页签存在', !!doc.querySelector('.topnav button[data-page="tasks"]'));

// 3) 圈定：勾选即全站共享（文库页/批量页同一集合），已选定视图实时计数
window.__T.state.selected.add('p1');
doc.querySelector('#bpp-v-sel').click();
await new Promise((r) => setTimeout(r, 100));
ok('已选定视图实时计数', doc.querySelector('#bpp-v-n').textContent === '1' &&
   doc.querySelectorAll('.bpp-row').length === 1);
doc.querySelector('#bpp-v-all').click();
await new Promise((r) => setTimeout(r, 80));
window.__T.state.selected.clear();

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
  ok('批量中心按钮切页', doc.querySelector('#page-batch').style.display !== 'none');
  const cnt = doc.querySelector('#bp-count')?.textContent || '';
  ok('勾选全站共享（文库页勾选批量页可见）', /1 篇/.test(cnt), cnt);
  window.__T.state.selected.clear();
}

// 6.5) 勾选面板（常驻）：库树形分组 / 搜索 / 年份 / 整组全选 / 已选定视图
window.__T.switchPage('batch');
window.__T.state.selected.clear();   // 清掉步骤6 勾选
await new Promise((r) => setTimeout(r, 500));   // renderBatchPage 进页即 loadBpPicker（全量拉取）
ok('未圈定时操作卡置灰', [...doc.querySelectorAll('#page-batch .batch-card')]
   .every(c => c.classList.contains('off')));
const acts = [...doc.querySelectorAll('.batch-card')].map(c => c.dataset.act);
ok('批量卡含 采集/专题/综述入口', acts.includes('acquire') && acts.includes('topics') && acts.includes('review'),
   acts.join(','));
ok('综述卡主色高亮', [...doc.querySelectorAll('.batch-card')].find(c => c.dataset.act === 'review')
   ?.classList.contains('primary'));
const groups = [...doc.querySelectorAll('.bpp-group-head')];
ok('库树形分组渲染（默认文献库/test/未分库）',
   groups.length === 3 &&
   groups.some(g => g.textContent.includes('默认文献库')) &&
   groups.some(g => g.textContent.includes('test')) &&
   groups.some(g => g.textContent.includes('未分库')), `实际组数 ${groups.length}`);
ok('全部论文 45 行', doc.querySelectorAll('.bpp-row').length === 45,
   `实际 ${doc.querySelectorAll('.bpp-row').length}`);
// 整组全选（默认文献库 2 篇）
const gsel = [...doc.querySelectorAll('.bpp-gsel')].find(b => b.dataset.gid === 'c1');
gsel.click();
await new Promise((r) => setTimeout(r, 80));
ok('全选本库 → 2 篇', doc.querySelector('#bp-count').textContent.includes('2 篇'),
   doc.querySelector('#bp-count').textContent);
ok('按钮翻转为「取消本库」', gsel.textContent.includes('取消本库') ||
   [...doc.querySelectorAll('.bpp-gsel')].find(b => b.dataset.gid === 'c1').textContent.includes('取消本库'));
// 搜索
doc.querySelector('#bpp-search').value = '独特针';
doc.querySelector('#bpp-search').dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 400));
ok('搜索命中 1 行（空组隐藏）', doc.querySelectorAll('.bpp-row').length === 1 &&
   doc.body.textContent.includes('独特针'));
doc.querySelector('#bpp-search').value = '';
doc.querySelector('#bpp-search').dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 350));
// 年份筛选（mock 全部 2024 → 45 行）
doc.querySelector('#bpp-year').value = '2024';
doc.querySelector('#bpp-year').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 100));
ok('年份筛选命中 7 行（2024）', doc.querySelectorAll('.bpp-row').length === 7,
   `实际 ${doc.querySelectorAll('.bpp-row').length}`);
doc.querySelector('#bpp-year').value = '';
doc.querySelector('#bpp-year').dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 100));
// 组折叠
const ghead = doc.querySelector('.bpp-group-head[data-gid="c1"]');
ghead.click();
await new Promise((r) => setTimeout(r, 80));
ok('组折叠隐藏行', doc.querySelectorAll('[data-gid="c1"] ~ * .bpp-row, [data-gid="c1"] ~ .bpp-row').length === 0 ||
   ![...doc.querySelectorAll('.bpp-row')].some(r => r.textContent.includes('Batch Pool Paper 0')));
ghead.click();
await new Promise((r) => setTimeout(r, 80));
// 已选定视图
doc.querySelector('#bpp-v-sel').click();
await new Promise((r) => setTimeout(r, 80));
ok('已选定视图 2 行', doc.querySelectorAll('.bpp-row').length === 2,
   `实际 ${doc.querySelectorAll('.bpp-row').length}`);
doc.querySelector('#bpp-v-sel + #bpp-v-all, #bpp-v-all').click();
await new Promise((r) => setTimeout(r, 80));
// 已选定视图里取消一个
doc.querySelector('#bpp-v-all').click();
await new Promise((r) => setTimeout(r, 80));
doc.querySelector('#bpp-v-sel').click();
await new Promise((r) => setTimeout(r, 80));
const firstSel = doc.querySelector('.bpp-row input[type=checkbox]');
if (!firstSel) console.log('DEBUG sel view html:', doc.querySelector('#bpp-list').innerHTML.slice(0, 200),
  '| view:', window.__T.state._bpp.view, '| selected:', window.__T.state.selected.size);
firstSel.click();
await new Promise((r) => setTimeout(r, 80));
ok('已选定视图取消勾选 → 1 篇', doc.querySelector('#bp-count').textContent.includes('1 篇'));
if (!doc.querySelector('#bp-clear')) console.log('DEBUG page-batch:', doc.querySelector('#page-batch').innerHTML.slice(0, 300));
doc.querySelector('#bp-clear')?.click();
await new Promise((r) => setTimeout(r, 100));
ok('清空圈定 → 0 篇', doc.querySelector('#bp-count')?.textContent.includes('0 篇'));

// 7) 综述流：卡片激活 → 预估确认 → 批次面板综述行 → 报告视图
const reviewCard = doc.querySelector('.batch-card[data-act="review"]');
ok('综述卡已激活（无 soon）', !!reviewCard && !reviewCard.classList.contains('soon'));
// 切回批量页重新渲染（前面 tocenter 已切页）
window.__T.switchPage('batch');
await new Promise((r) => setTimeout(r, 300));
window.__T.state.selected.add('p1'); window.__T.state.selected.add('p2');
doc.querySelector('.batch-card[data-act="review"]').click();
await new Promise((r) => setTimeout(r, 200));
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
