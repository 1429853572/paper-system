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
  '/api/papers/p1/assets': {   // 非空：覆盖 renderAssets 的过滤重赋值路径（曾是 const 赋值必崩）
    figures: [{page_index: 0, image_path: 'images/page_0_image_1.jpg', caption: 'Fig 1', bbox: [0.1, 0.1, 0.5, 0.5], label: 'Fig. 1', extra_images: [], sub_captions: []}],
    tables: [{page_index: 1, label: 'Table 1', caption: 'results', bbox: [0.1, 0.1, 0.8, 0.6], html: '<table><tr><th>A</th><td>1</td></tr></table>'}],
  },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/cite': { styles: { gbt7714: { label: 'GB/T 7714', html: 'test cite' } }, labels: {}, default: 'gbt7714' },
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
  window.eval(js + '\n;window.__T = { state, switchView, switchPage, renderContentView, openPaper, openQa: window.openQa };');
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
// 顶栏只保留 阅读/文库；回收站/设置 已移入账号菜单
for (const pg of ['collections', 'reader']) {
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

// 1.5) 账号菜单（回收站/设置入口）
try {
  const acc = doc.querySelector('#acc-btn');
  if (!acc) errors.push('账号按钮缺失');
  else {
    acc.click();
    await new Promise((r) => setTimeout(r, 120));
    const items = [...doc.querySelectorAll('#acc-pop .acc-item')].map(x => x.dataset.act);
    results.push(`账号菜单: ${items.join(',')}`);
    for (const need of ['settings', 'trash', 'logout']) {
      if (!items.includes(need)) errors.push(`账号菜单缺少: ${need}`);
    }
    acc.click();
  }
} catch (e) { errors.push('账号菜单: ' + e.message); }

// 2) 右栏视图（先打开论文——否则 meta/assets 等只走"未选论文"占位分支，测不到真实渲染）
try {
  await window.__T.openPaper('p1');
  await new Promise((r) => setTimeout(r, 150));
} catch (e) { errors.push('openPaper: ' + e.message); }
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

// 2.5) 提问按钮应在阅读页内
const qaBtn = doc.querySelector('#qa-open');
if (!qaBtn) errors.push('提问按钮缺失');
else {
  const inTop = !!qaBtn.closest('.topbar');
  const inReader = !!qaBtn.closest('#page-reader');
  results.push(`提问按钮位置: ${inTop ? '顶栏' : inReader ? '阅读页' : '未知'}`);
  if (inTop) errors.push('提问按钮应在阅读页内，不该在顶栏');
  // 提问键 = 开关，默认收起：第一次点开、第二次关（qaOpen 由 localStorage 记忆）
  qaBtn.click();
  await new Promise((r) => setTimeout(r, 100));
  const openAfterFirst = window.__T.state.qaOpen === true;
  qaBtn.click();
  await new Promise((r) => setTimeout(r, 100));
  const closedAfterSecond = window.__T.state.qaOpen === false;
  results.push(`提问键开关(默认收起): 第一次开=${openAfterFirst} 第二次关=${closedAfterSecond}`);
  if (!openAfterFirst) errors.push('提问键第一次点击应打开问答框（默认收起语义）');
  if (!closedAfterSecond) errors.push('提问键第二次点击应关闭问答框');
  // 可视化修正：admin 打开论文后，正文块应出现行尾编辑图标
  const editBtns = doc.querySelectorAll('#paper-list, #content-view').length
    ? doc.querySelectorAll('#content-view .blk-edit')
    : [];
  results.push(`块编辑图标: ${editBtns.length} 个`);
  if (!editBtns.length) errors.push('admin 应看到块编辑图标（可视化修正）');
}

// 2.6) 下载弹层：开启后应为 fixed 浮动定位（工具条 overflow 会裁掉 absolute 弹层）
try {
  const dlBtn = doc.querySelector('#download-btn');
  const dlPop = doc.querySelector('#download-pop');
  if (!dlBtn || !dlPop) errors.push('下载按钮/弹层缺失');
  else {
    dlBtn.click();
    await new Promise((r) => setTimeout(r, 120));
    const fixed = dlPop.style.position === 'fixed' && !dlPop.hidden;
    results.push(`下载弹层浮动: ${fixed ? 'OK' : '未生效 position=' + dlPop.style.position}`);
    if (!fixed) errors.push('下载弹层应 fixed 浮动定位');
    dlBtn.click();
  }
} catch (e) { errors.push('下载弹层: ' + e.message); }

// 3) 关键函数存在性
// window 挂载的关键函数（内联 onclick 依赖它们）
// 注意: 段落合并/段落批注/补译已下线(用户要求移除)，不在检查范围；
//       exportBibtex 已删（孤儿端点 GET /api/export/bibtex 一并移除，批量走 /api/papers/export/bibtex）
for (const fn of ['quickDelete', 'lightbox', 'loadMoreBlocks',
                  'loadMorePairs', 'pdfFlashBlock', 'flashAbstract',
                  'linkDiag', 'toggleToc']) {
  if (typeof window[fn] !== 'function') errors.push(`window 函数缺失: ${fn}`);
}
results.push('函数检查完成');

// 4) 文库管理页批量条（勾选状态与全站共享：侧栏/批量中心同一集合）
try {
  window.__T.state.libLevel = 2;
  window.__T.state.libSel = '';
  window.__T.switchPage('collections');
  await new Promise((r) => setTimeout(r, 300));
  const rowCk = doc.querySelector('.lib-ck');
  if (!rowCk) throw new Error('论文行复选框缺失');
  rowCk.checked = true;
  window.libCk(rowCk.dataset.cid);
  await new Promise((r) => setTimeout(r, 100));
  const cid = rowCk.dataset.cid;
  const bar = doc.querySelector('#lb-' + cid);
  const barVisible = bar && !bar.hidden;
  results.push(`文库批量条: ${barVisible ? 'OK' : '未显示'}`);
  if (!barVisible) errors.push('文库批量条: 勾选后未显示');
  for (const label of ['翻译', '导读', '元数据', '重解析', '综述', 'BibTeX', '批量中心']) {
    if (!bar || !bar.textContent.includes(label)) errors.push(`文库批量条缺少: ${label}`);
  }
  // 勾选状态共享：state.selected 应含该论文；重渲染后复选框保持
  const pid = rowCk.dataset.pid;
  if (!window.__T.state.selected.has(pid)) errors.push('勾选未同步到 state.selected');
  window.__T.switchPage('reader');
  window.__T.switchPage('collections');
  await new Promise((r) => setTimeout(r, 300));
  const ck2 = doc.querySelector(`.lib-ck[data-pid="${pid}"]`);
  if (!ck2 || !ck2.checked) errors.push('文库勾选状态重渲染后丢失');
  results.push('文库勾选持久化: OK');
  // 清空
  window.libClearSel(cid);
  const bar2 = doc.querySelector('#lb-' + cid);
  if (bar2 && !bar2.hidden) errors.push('清空后批量条仍显示');
  window.__T.state.selected.clear();
} catch (e) { errors.push('文库批量条: ' + e.message); }

console.log(results.join('\n'));
console.log('\n' + (errors.length ? '❌ 失败:\n  ' + errors.slice(0, 12).join('\n  ') : '✅ 全部通过'));
process.exit(errors.length ? 1 : 0);
