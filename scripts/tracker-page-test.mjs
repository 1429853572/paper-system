/**
 * 文献追踪页面回归（jsdom 无头）
 * 用法: node scripts/tracker-page-test.mjs
 * 覆盖: 页面骨架/订阅卡与表单（分类 chip 联动）/收件箱行渲染（tier 徽章/补足标/AI 摘要/
 *       忽略确认）/accept 与 dismiss 与 enrich 调用/SMTP 配置卡（admin）/未读角标
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const SUB = { id: 'tsa1', user_id: 1, name: '3DGS 前沿', keywords: 'gaussian splatting',
  categories: 'cs.CV eess.IV', exclude: '', journals: '', frequency_hours: 24,
  llm_auto: 'core', email_enabled: 0, email_to: '', enabled: 1, new_count: 2,
  last_run_at: '2026-11-13 08:00:00', last_error: null, created_at: '2026-11-13' };
const ITEMS = [
  { id: 'tia1', sub_id: 'tsa1', user_id: 1, paper_id: null, title: 'Fresh GS Paper', zh_title: '新GS论文',
    authors: 'A', abstract: 'we study splatting', zh_summary: '这篇提出了一种新的泼溅方法。', doi: '10.1/1',
    arxiv_id: '2611.1', pdf_url: 'https://arxiv.org/pdf/2611.1', code_url: 'https://github.com/a/b',
    venue: 'arXiv', published: '2026-11-12', tier: 'core', is_fallback: 0, status: 'new',
    rank: '{"cas": "综合性期刊3区", "jcr": "Q1", "impact_factor": "4.9"}', cited_by: 3,
    created_at: '2026-11-13', accepted_at: null },
  { id: 'tia2', sub_id: 'tsa1', user_id: 1, paper_id: null, title: 'Filler Item', zh_title: null,
    authors: 'B', abstract: 'unrelated', zh_summary: null, doi: '', arxiv_id: '2611.2', pdf_url: '',
    code_url: '', venue: 'arXiv', published: '2026-11-10', tier: 'eco', is_fallback: 1, status: 'new',
    created_at: '2026-11-13', accepted_at: null },
];
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
  '/api/tracker/subs': { subs: [SUB], counts: { new: 2, core: 1, eco: 1, inbox: 2 }, smtp_ready: false },
  '/api/tracker/items': { items: ITEMS, total: 2, page: 1, page_size: 30,
    counts: { new: 2, core: 1, eco: 1, inbox: 2 } },
  '/api/tracker/smtp': { host: '', port: 465, sender: '', configured: false },
};

let acceptCalls = [], dismissCalls = [], enrichCalls = [], subSaves = [], smtpSaves = [], runCalls = [];
const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  if (u.startsWith('/api/tracker/items/') && u.endsWith('/accept')) {
    acceptCalls.push(u);
    return { ok: true, status: 200, json: async () => ({ ok: true, paper_id: 'pnew', status: 'queued', duplicate: false }) };
  }
  if (u.startsWith('/api/tracker/items/') && u.endsWith('/dismiss')) {
    dismissCalls.push(u);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.startsWith('/api/tracker/items/') && u.endsWith('/enrich')) {
    enrichCalls.push(u);
    return { ok: true, status: 200, json: async () => ({ ok: true, zh_summary: '手动生成的中文总结。', zh_title: '翻译标题' }) };
  }
  if (u === '/api/tracker/subs' && opts.method === 'POST') {
    subSaves.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ id: 'tsnew' }) };
  }
  if (u.startsWith('/api/tracker/subs/') && opts.method === 'PUT') {
    subSaves.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.startsWith('/api/tracker/run/')) {
    runCalls.push(u);
    return { ok: true, status: 200, json: async () => ({ ok: true, started: true }) };
  }
  if (u === '/api/tracker/smtp' && opts.method === 'PUT') {
    smtpSaves.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u === '/api/tracker/journal-suggest') {
    return { ok: true, status: 200, json: async () => ({ items: [
      { name: 'Scientific Reports', hint: 'JCR Q1 · IF 3.8' },
      { name: 'Nature Communications', hint: '中科院1区 · IF 14.1' }] }) };
  }
  if (u.startsWith('/api/tracker/items')) {
    const q = String(url);
    return { ok: true, status: 200, json: async () => (
      q.includes('tier=core') ? { items: [ITEMS[0]], total: 1, page: 1, page_size: 30,
        counts: { new: 1, core: 1, inbox: 1 } } : DATA['/api/tracker/items']) };
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
window.Element.prototype.scrollIntoView = function () {};   // jsdom 未实现
window.addEventListener('error', e => errors.push('window error: ' + e.message));
process.on('unhandledRejection', r => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  errors.push('rejection: ' + m);
});

// 跑 viewer.js（模块 → 借 dom.window.eval 执行）
window.eval(js);
window.uiConfirm = async () => true;   // DOM 确认弹窗在 jsdom 无法点击——stub 掉（同 batch-page-test）

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' — ' + x)); c ? pass++ : fail++; };

await sleep(600);

// 1. 页面注册与渲染
window.switchPage('tracker');
await sleep(400);
ok('1 双栏布局：左订阅导航 + 右内容流',
   window.document.querySelector('#page-tracker').style.display !== 'none' &&
   window.document.querySelector('#page-title').textContent === '文献追踪' &&
   window.document.querySelectorAll('#tk-rail-list .tk-rail-item').length === 4 &&
   window.document.querySelectorAll('#tk-kpis .tk-kpi').length === 4 &&
   window.document.querySelectorAll('#tk-stream .tracker-item').length === 2);
ok('1a 左栏：全部新到(角标2) + 订阅(角标2) + 已收进/已忽略',
   [...window.document.querySelectorAll('#tk-rail-list .tk-rail-item')].slice(0, 2)
     .map(x => x.querySelector('.tk-rail-badge')?.textContent).join(',') === '2,2' &&
   window.document.querySelector('#tk-rail-foot').textContent.includes('邮件发送'));
ok('1b KPI 统计带（24小时新到高亮）',
   window.document.querySelectorAll('#tk-kpis .tk-kpi.hot').length === 1 &&
   window.document.querySelector('#tk-kpis').textContent.includes('核心命中'));
ok('1c 条件 chips + 按天分组头（悬停订阅行 title）',
   window.document.querySelectorAll('#tk-rail-list .tk-chip').length === 0 &&
   window.document.querySelectorAll('#tk-stream .tk-day').length >= 1 &&
   /昨天|今天|\d+月\d+日/.test(window.document.querySelector('#tk-stream .tk-day')?.textContent || ''));

// 2. 行渲染：tier 徽章 / 补足标 / 中文摘要 / 代码链接 / 行内按钮
const row = window.document.querySelector('#tk-stream .tracker-item');
ok('2 行渲染完整（核心徽章/中文摘要/代码链接/三按钮）',
   row.textContent.includes('核心') && row.textContent.includes('这篇提出了一种新的泼溅方法。') &&
   row.textContent.includes('代码 ↗') &&
   [...row.querySelectorAll('.btn')].filter(b => b.textContent.includes('收进文献库')).length === 1 &&
   [...row.querySelectorAll('.btn')].some(b => b.textContent.includes('忽略')));
ok('2b 分区/被引徽章渲染',
   row.textContent.includes('中科院综合性期刊3区') && row.textContent.includes('JCR Q1') &&
   row.textContent.includes('IF 4.9') && row.textContent.includes('被引 3'));
ok('3 补足灰标只在 is_fallback 行',
   [...window.document.querySelectorAll('#tk-stream .tracker-item')].filter(x => x.textContent.includes('补足')).length === 1);

// 4. 筛选 chips：切层级 → items API 带 tier=core
acceptCalls = [];
window.trackerTierF('core');
await sleep(400);
ok('4 层级筛选触发（重渲染仅核心行）',
   window.document.querySelectorAll('#tk-stream .tracker-item').length === 1 &&
   window.document.querySelector('#tk-stream .tracker-item').textContent.includes('Fresh GS Paper'));
window.trackerTierF('');
await sleep(300);

// 5. accept → POST 调用
const acceptBtn = row.querySelector('[onclick*="trackerAccept"]');
acceptCalls = [];
await window.trackerAccept('tia1', acceptBtn);
await sleep(200);
ok('5 收进文献库调用 accept 端点', acceptCalls.some(u => u.includes('/tia1/accept')), JSON.stringify(acceptCalls));

// 6. dismiss → uiConfirm(mocked true) → POST
dismissCalls = [];
await window.trackerDismiss('tia2', null);
await sleep(200);
ok('6 忽略调用 dismiss 端点', dismissCalls.some(u => u.includes('/tia2/dismiss')), JSON.stringify(dismissCalls));

// 7. enrich → POST + 追加摘要
enrichCalls = [];
await window.trackerEnrich('tia1', row.querySelector('[onclick*="trackerEnrich"]') || row.querySelector('.btn'));
await sleep(200);
ok('7 AI 摘要调用 enrich 端点', enrichCalls.some(u => u.includes('/tia1/enrich')), JSON.stringify(enrichCalls));

// 8. 新建订阅表单：chip 联动 + 保存 payload
subSaves = [];
window.trackerNew();
await sleep(300);
window.document.querySelector('#tk-name').value = 'E2E';
window.document.querySelector('#tk-keywords').value = 'neural fields';
window.trackerToggleCat(window.document.querySelector('[data-cat="cs.GR"]'), 'cs.GR');   // jsdom 不执行内联 onclick → 直调
const catVal = window.document.querySelector('#tk-cats').value;
await window.trackerSave(null);
await sleep(300);
ok('8 新建订阅：chip 联动输入框 + POST payload 正确',
   catVal === 'cs.GR' && subSaves.length === 1 && subSaves[0].categories === 'cs.GR' &&
   subSaves[0].keywords === 'neural fields' && subSaves[0].llm_auto === 'core',
   JSON.stringify({ catVal, save: subSaves[0] }));

// 9. 左栏邮件入口：状态 + admin「前往设置」链接（SMTP 表单已迁管理后台）
const foot = window.document.querySelector('#tk-rail-foot');
ok('9 左栏邮件状态（未配置徽章+前往设置链接）',
   foot.textContent.includes('邮件发送') && foot.textContent.includes('未配置') &&
   !!foot.querySelector('a'), foot.textContent.slice(0, 40));

// 9b. 期刊搜索选择器：建议下拉 + 点选加 chip + 保存 payload 带期刊
window.trackerEdit('tsa1');
await sleep(300);
const sugBox = window.document.querySelector('#tk-jr-sug');
await window.trackerJrSuggest('report');
await sleep(600);
ok('9b 期刊建议下拉渲染', sugBox && !sugBox.hidden && sugBox.textContent.includes('Scientific Reports'),
   sugBox?.textContent?.slice(0, 40));
window.trackerJrPick('Scientific Reports');
await sleep(200);
const jrChip = window.document.querySelector('#tk-jr-chips .tk-chip.jr[data-j="Scientific Reports"]');
ok('9c 点选加期刊 chip', !!jrChip, '');

// 11. 角标
const badge = window.document.querySelector('#tbadge');
ok('11 未读角标显示收件箱数', badge && !badge.hidden && badge.textContent === '2',
   `hidden=${badge?.hidden} text=${badge?.textContent}`);

// 12. 编辑订阅表单：预填 + 期刊选择 + PUT
subSaves = [];
window.trackerEdit('tsa1');
await sleep(300);
const prefill = window.document.querySelector('#tk-keywords')?.value;
window.trackerJrPick('Scientific Reports');
window.document.querySelector('#tk-name').value = '改名';
await window.trackerSave('tsa1');
await sleep(300);
ok('12 编辑订阅：预填关键词 + PUT 保存（含所选期刊）', prefill === 'gaussian splatting' &&
   subSaves.length === 1 && subSaves[0].name === '改名' && subSaves[0].journals === 'Scientific Reports',
   JSON.stringify(subSaves[0] || {}));

ok('零 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
