/**
 * 多用户管理/用量/归属回归测试（jsdom 无头）
 * 用法: node scripts/user-test.mjs
 * 覆盖:
 *   1. 设置页「我的用量」区对所有用户渲染（曾是 admin 专属；member 此前零用量可见性）
 *   2. 管理区用户表含 disabled 徽章/磁盘/30d token 列 + 启用按钮（后端 SELECT 缺 disabled
 *      列导致启用按钮永不渲染的 bug 的前端面）
 *   3. 结构化限额编辑器（4 数字字段 + 保存组装 PUT）替代裸 JSON 框
 *   4. 删除用户（danger 按钮 + 输入用户名确认 → DELETE）
 *   5. 邀请码有效期下拉（3/7/14/30 天 → ?days=）
 *   6. shared 论文归属标识：主列表/文库表「· 用户名」、自己上传的不显示
 *   7. 上传弹层 quota-hint（今日解析 X/Y）+ 「上限」错误不渲染重试按钮
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'app', 'webui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'viewer.js'), 'utf8');

const calls = [];
const ME = {id: 1, username: 'admin', role: 'admin', llm_configured: {chat: true, translate: true}};
const USERS = {users: [
  {id: 1, username: 'admin', role: 'admin', disabled: 0, created_at: '2026-11-04', overrides: '{"max_pages":500}', papers: 89, disk_used: 1150586768, tokens_30d: 4272075},
  {id: 2, username: 'labmate', role: 'member', disabled: 1, created_at: '2026-11-06', overrides: '{}', papers: 3, disk_used: 52428800, tokens_30d: 12000},
  {id: 3, username: 'newmember', role: 'member', disabled: 0, created_at: '2026-11-08', overrides: '{}', papers: 0, disk_used: 0, tokens_30d: 0},
]};
const DATA = {
  '/api/me': ME,
  '/api/me/quota': {parse_used: 3, parse_limit: 600, disk_used_bytes: 1150586768, disk_limit_gb: 20, tokens_30d: 4272075},
  '/api/usage': {by_user: [], by_day: [{day: '2026-11-09', p: 1000, c: 200}]},
  '/api/admin/users': USERS,
  '/api/admin/pool': {enabled: false},
  '/api/admin/audit': {rows: []},
  '/api/presets': {questions: [], compare: []},
  '/api/chat/sessions': {sessions: []},
  '/api/collections': {total: 2, collections: [{id: 'c1', name: '默认文献库', parent_id: null, papers: 2, papers_total: 2}]},
  '/api/papers': {total: 2, papers: [
    {id: 'p1', title: '别人上传的论文', parse_status: 'parsed', visibility: 'shared', owner_id: 2, owner_name: 'labmate', page_count: 10, file_size: 1024},
    {id: 'p2', title: '我上传的论文', parse_status: 'parsed', visibility: 'shared', owner_id: 1, owner_name: 'admin', page_count: 12, file_size: 2048},
  ]},
  '/api/papers/p1/notes': {notes: {}}, '/api/papers/p2/notes': {notes: {}},
  '/api/papers/p1/assets': {figures: [], tables: []}, '/api/papers/p2/assets': {figures: [], tables: []},
  '/api/papers/p1/references': {references: []}, '/api/papers/p2/references': {references: []},
  '/api/papers/p1/summary': {summary: null}, '/api/papers/p2/summary': {summary: null},
  '/api/papers/p1/jobstate': {parse_status: 'parsed'}, '/api/papers/p2/jobstate': {parse_status: 'parsed'},
  '/api/papers/p1/bilingual': {run_id: 'r1', pairs: [], versions: [], total: 0, offset: 0, limit: 40},
  '/api/papers/p1/cite': {styles: {gbt7714: {label: 'GB/T 7714', html: 'c'}}, labels: {}, default: 'gbt7714'},
  '/api/statuses': {statuses: {}},
  '/api/settings/llm': {chat: {base_url: '', model: '', configured: false}, translate: {base_url: '', model: '', configured: false}},
  '/api/glossary': {terms: []},
  '/api/settings/parse-filter': {max_pages: 0, exclude: ''},
  '/api/import-dirs': {dirs: []},
};

const dom = new JSDOM(html, {url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true});
const {window} = dom;
const errors = [];
setTimeout(() => { console.log('WATCHDOG: 测试超时'); process.exit(2); }, 25000).unref();

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  const m = opts.method || 'GET';
  calls.push(m + ' ' + String(url));
  if (/\/api\/papers\/p\d$/.test(u) && m === 'GET')
    return {ok: true, status: 200, json: async () => ({paper: DATA['/api/papers'].papers.find(p => p.id === u.split('/').pop()), blocks: [], total: 0, offset: 0, limit: 40})};
  return {ok: true, status: 200, json: async () => DATA[u] ?? {}};
};
window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
window.alert = window.confirm = () => true;
window.prompt = () => 'labmate';
window.isSecureContext = false;
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function () {};
window.matchMedia = window.matchMedia || (q => ({matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} };
window.addEventListener('error', e => errors.push('win: ' + e.message));
process.on('unhandledRejection', r => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module|reading 'configured'/.test(m)) return;
  errors.push('rej: ' + m);
});

window.eval(js + ';window.__T={state,loadPapers,renderSettings,switchPage};');
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise(r => setTimeout(r, 300));
const doc = window.document;
await window.__T.loadPapers();
calls.length = 0;

let ok = true;
const check = (name, cond) => { console.log((cond ? '  OK ' : '  FAIL ') + name); ok = ok && cond; };

/* 1. 主列表归属标识 */
const items = [...doc.querySelectorAll('.paper-item .meta')].map(m => m.textContent);
check('他人上传的论文显示「· labmate」', items.some(t => t.includes('· labmate')));
check('自己上传的不显示归属', !items.some(t => t.includes('· admin')));

/* 2. 上传弹层 quota-hint */
const arrow = doc.querySelector('#upload-arrow');
arrow?.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
await new Promise(r => setTimeout(r, 250));
check('上传弹层含今日解析余量提示', (doc.querySelector('#quota-hint')?.textContent || '').includes('今日解析 3/600'));

/* 3. 「上限」错误 → 失败行不渲染重试按钮（429 重试必然再失败） */
{
  const t = window.__T.state;
  t.uploads.set('x.pdf', {pct: 100, phase: 'error', msg: '今日解析已达上限 200 篇', file: {name: 'x.pdf'}, cid: ''});
  t.uploads.set('y.pdf', {pct: 100, phase: 'error', msg: '网络错误', file: {name: 'y.pdf'}, cid: ''});
  window.__T.state.uploads = t.uploads;
  // renderPapers 未导出——通过 loadPapers 之外直接触发列表渲染的内部路径不可行，改 eval 内直接调
  window.eval('window.__T.renderPapers ||= null');
  // renderPapers 在模块内，loadPapers 会调用——这里直接通过 DOM 层验证：重新 eval 一段调用
  window.eval('window.__TP = () => { try { renderPapers(); } catch (e) {} };');
  window.__TP();
  await new Promise(r => setTimeout(r, 100));
  const rows = [...doc.querySelectorAll('.paper-item.uploading .up-act')].map(b => b.dataset.act + ':' + b.closest('.paper-item').textContent);
  check('配额上限失败行无「重试」按钮', rows.every(r => !r.startsWith('retry:') || !r.includes('上限')));
  const retryX = rows.find(r => r.startsWith('retry:') && r.includes('上限'));
  check('配额上限行确实缺 retry（网络错误行仍可重试）', !retryX && rows.some(r => r.startsWith('retry:')));
  t.uploads.clear();
}

/* 4. 设置页：我的用量（admin 也显示）+ 管理区 */
// 设置页已改页签分组：按页签逐个渲染（账号/用量/管理）
await window.__T.renderSettings('usage');
await new Promise(r => setTimeout(r, 500));
const qz = doc.querySelector('#me-quota-zone');
check('「我的用量」区渲染', !!qz && qz.textContent.includes('今日解析'));
check('用量区含磁盘已用', (qz?.textContent || '').includes('磁盘已用'));
check('用量区含本月花费（token 展示已按需求移除）',
   (qz?.textContent || '').includes('本月花费') && !(qz?.textContent || '').includes('近 30 天 token'));

await window.__T.renderSettings('admin');
await new Promise(r => setTimeout(r, 500));
const az = doc.querySelector('#admin-zone');
check('管理区用户表渲染 2 用户', (az?.querySelectorAll('table.list tr').length || 0) >= 2);
check('管理区显示磁盘占用（1.07G）', (az?.textContent || '').includes('1.07G'));
check('管理区显示本月花费（非 token）', (az?.textContent || '').includes('本月花费'));
check('已禁用用户带「已禁用」徽章', (az?.textContent || '').includes('已禁用'));
const enableBtn = [...(az?.querySelectorAll('button[title="重新启用"]') || [])];
// 操作已收进「更多 ▾」菜单：禁用用户的「重新启用」在菜单里
const disabledMenuHasEnable = (() => {
  const row = [...(az?.querySelectorAll('tr') || [])].find(r => r.textContent.includes('已禁用'));
  const item = row ? [...row.querySelectorAll('.tp-item')].find(x => x.textContent.includes('重新启用')) : null;
  return !!item;
})();
check('禁用用户菜单含「重新启用」（依赖后端 disabled 列的 bug 面）', disabledMenuHasEnable);
check('邀请码有效期下拉存在', !!az?.querySelector('#invite-days'));
check('邀请码下拉含 30 天选项', [...(az?.querySelectorAll('#invite-days option') || [])].some(o => o.value === '30'));
const qd = az?.querySelector('details.q-edit');
// 限额编辑已改为弹窗（openQuotaDialog）；等 renderAdminZone 填好 _quotaRaw
await new Promise(r => setTimeout(r, 400));
window.openQuotaDialog && window.openQuotaDialog(1);
await new Promise(r => setTimeout(r, 150));
const qpop = doc.querySelector('.adm-quota-pop');
check('结构化限额编辑器（弹窗）存在（替代裸 JSON 框）', !!qpop);
check('限额编辑器含 5 个数字字段（含月预算）', (qpop?.querySelectorAll('input[type="number"]').length || 0) === 5);
check('已有 override 值回填（max_pages=500）', qpop?.querySelector('input[id$="-pp"]')?.value === '500');
doc.querySelector('.adm-quota-pop')?.remove();
// 删除已收进「更多 ▾」菜单
const delInMenu = [...(az?.querySelectorAll('.adm-menu-pop .tp-item') || [])].filter(x => x.textContent.includes('注销账号')).length;
check('删除用户在「更多」菜单里（仅启用中的非 admin）', delInMenu === 1, '菜单内删除项=' + delInMenu);

/* 5. 保存限额 → 结构化 PUT */
calls.length = 0;
await window.saveQuota(2);
await new Promise(r => setTimeout(r, 150));
const putQ = calls.find(c => c.startsWith('PUT /api/admin/users/2/quota'));
check('保存限额发出 PUT', !!putQ);
const putBody = JSON.parse(putQ ? putQ.split(' HTTP')[0] && '{}' : '{}');  // body 不在 URL 里，单独从 fetch mock 取
{
  // 从 window.fetch 的调用记录里拿 body：mock 只记 URL——直接拦 opts 验证
  let captured = null;
  const of = window.fetch;
  window.fetch = async (url, opts = {}) => {
    if (String(url).includes('/quota')) captured = opts.body;
    return of(url, opts);
  };
  // 限额编辑已改为弹窗（openQuotaDialog），输入框在弹窗里
  window.openQuotaDialog && window.openQuotaDialog(2);
  await new Promise(r => setTimeout(r, 150));
  const dkInp = doc.querySelector('#q-2-dk');
  check('限额编辑弹窗含磁盘上限输入', !!dkInp);
  dkInp.value = '50';
  await window.saveQuota(2);
  doc.querySelector('.adm-quota-pop')?.remove();   // 关掉限额弹窗，避免后续选择器误命中
  await new Promise(r => setTimeout(r, 150));
  const j = JSON.parse(captured || '{}');
  check('限额 PUT 组装 {max_disk_gb:50}（留空键不写入）', j.max_disk_gb === 50 && !('daily_parse_papers' in j));
  window.fetch = of;
}

/* 6. 删除用户：弹层输入用户名确认 → DELETE（不匹配则不发） */
{
  calls.length = 0;
  const p = window.deleteUser(3, 'newmember');   // 不 await：等弹层
  await new Promise(r => setTimeout(r, 200));
  const inp = doc.querySelector('.ui-pop .ui-pop-input');
  check('注销弹层带用户名输入框', !!inp);
  inp.value = 'wrong-name';
  doc.querySelector('.ui-pop [data-ok]').click();
  await p;
  await new Promise(r => setTimeout(r, 100));
  check('用户名不匹配 → 不发 DELETE', !calls.some(c => c.startsWith('DELETE /api/admin/users/3')));
  calls.length = 0;
  const p2 = window.deleteUser(3, 'newmember');
  await new Promise(r => setTimeout(r, 200));
  doc.querySelector('.ui-pop .ui-pop-input').value = 'newmember';
  doc.querySelector('.ui-pop [data-ok]').click();
  await p2;
  await new Promise(r => setTimeout(r, 150));
  check('输入用户名匹配 → DELETE /api/admin/users/3', calls.some(c => c.startsWith('DELETE /api/admin/users/3')));
}

/* 7. 邀请码带有效期 */
calls.length = 0;
if (az) az.querySelector('#invite-days').value = '14';
await window.createInvite();
await new Promise(r => setTimeout(r, 150));
check('生成邀请码带 ?days=14', calls.some(c => c.startsWith('POST /api/admin/invite?days=14')));

/* 8. member 视角：归属标识不变（state 在模块作用域，经 __T.state 修改） */
{
  window.__T.state.me = {id: 2, username: 'labmate', role: 'member'};
  calls.length = 0;
  await window.__T.loadPapers();
  const metas = [...doc.querySelectorAll('.paper-item .meta')].map(m => m.textContent);
  check('member 视角：admin 上传的论文显示「· admin」', metas.some(t => t.includes('· admin')));
  window.__T.state.me = {id: 1, username: 'admin', role: 'admin'};
}

check('无页面错误', !errors.length);
console.log('\n' + (ok ? '✅ 全部通过' : '❌ 存在失败') + (errors.length ? '\n  ' + errors.slice(0, 5).join('\n  ') : ''));
process.exit(ok ? 0 : 1);
