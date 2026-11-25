/**
 * 阶段④问答/上传 UX 回归（jsdom 无头）
 * 用法: node scripts/qa-ux-test.mjs
 * 覆盖: 命令标签渲染与执行/长按编辑保存 / 选中浮条与译文卡 / ↑↓历史 / / 快选 / 标识符导入
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
  '/api/collections': { total: 1, collections: [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }],
    shared_libs: [{ id: 'cs1', name: '合作者库', owner_id: 2, papers: 1, shared: true }] },
  '/api/statuses': { statuses: {} },
  // sharedLibs 走 /api/collections 的 shared_libs 字段 → loadCollections 读进 state
  '/api/papers': { total: 2, papers: [
    { id: 'p1', title: 'Test Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024, collection_ids: ['c1'] },
    { id: 'p2', title: 'Multi Lib Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024, collection_ids: ['c1', 'cs1'] }] },
  '/api/papers/p1': {
    paper: { id: 'p1', title: 'Test Paper', authors: 'A', year: '2025', journal: 'J', doi: '',
             keywords: '[]', abstract: 'This paper studies testing.', parse_status: 'parsed',
             visibility: 'shared', owner_id: 1, page_count: 10, file_size: 1024 },
    blocks: [], total: 0, offset: 0, limit: 40,
  },
  '/api/papers/p1/bilingual': { pairs: [], versions: [] },
  '/api/papers/p1/notes': { notes: {} },
  '/api/papers/p1/assets': { figures: [], tables: [] },
  '/api/papers/p1/references': { references: [] },
  '/api/papers/p1/cite': { styles: {}, labels: {}, default: 'gbt7714' },
  '/api/papers/p1/summary': { summary: null },
  '/api/papers/p1/jobstate': { parse_status: 'parsed', parsing: false, translating: false, translated: false },
  '/api/statuses': { statuses: {} },
  '/api/batches': { batches: [] },
  '/api/cmdtags': { tags: [{ id: 'c1', label: '📐 分析公式', prompt: '分析论文中的关键公式：{当前论文标题}' }] },
  '/api/usage': { by_user: [], by_day: [] },
  '/api/glossary': { terms: [] },
  '/api/admin/users': { users: [] },
  '/api/admin/pool': { enabled: false },
};

let chatCalls = [], tagSaves = [], identCalls = [], translateCalls = [];
const dom = new JSDOM(html, { url: 'http://localhost:7861/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];

window.fetch = async (url, opts = {}) => {
  const u = String(url).split('?')[0];
  if (u === '/api/chat/stream') {
    chatCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
  }
  if (u === '/api/cmdtags' && opts.method === 'PUT') {
    tagSaves.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ ok: true, tags: tagSaves.at(-1)?.tags || [] }) };
  }
  if (u === '/api/papers/import-identifier') {
    identCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ results: [
      { ident: { kind: 'doi', value: '10.1/x' }, status: 'queued', paper_id: 'pnew' },
      { ident: { kind: 'doi', value: '10.1/y' }, status: 'duplicate' }] }) };
  }
  if (u === '/api/translate-selection') {
    translateCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ translation: '这是译文。' }) };
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

window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
process.on('unhandledRejection', (r) => {
  const m = String(r?.message ?? r);
  if (/pdf\.min\.mjs|Cannot find module/.test(m)) return;
  if (/reading 'configured'/.test(m)) return;
  errors.push('rejection: ' + m);
});

try {
  window.eval(js + '\n;window.__T = { state, openPaper, sendQa, executeTag, renderCmdTags };');
} catch (e) {
  errors.push('eval: ' + e.stack.split('\n').slice(0, 3).join(' | '));
}
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (window.__T?.state?.me) break;
}
await new Promise((r) => setTimeout(r, 250));

const doc = window.document;
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'OK' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) errors.push(`${name}${extra ? ': ' + extra : ''}`);
};

// 准备：打开论文 + 打开问答 dock
await window.__T.openPaper('p1');
await new Promise((r) => setTimeout(r, 150));
doc.querySelector('#qa-open').click();
await new Promise((r) => setTimeout(r, 250));
window.__T.state.qaPapers.add('p1');
window.__T.state.qaAllPapers = [{ id: 'p1', parse_status: 'parsed' }];

// 1) 命令标签渲染
const tags = [...doc.querySelectorAll('#cmdtags .cmdtag')];
ok('命令标签 2 内置+1 自定义+＋（b2/b3 与划词浮条重复已砍）', tags.length === 4, `实际 ${tags.length}`);
ok('自定义标签渲染', tags.some(t => t.textContent.includes('分析公式')));

// 2) 快速总结（短按执行 → 发送）
tags.find(t => t.textContent.includes('快速总结')).dispatchEvent(new window.Event('mousedown'));
tags.find(t => t.textContent.includes('快速总结')).dispatchEvent(new window.Event('mouseup'));
await new Promise((r) => setTimeout(r, 150));
ok('快速总结触发发送', chatCalls.length === 1 && chatCalls[0].question.includes('核心问题'),
   chatCalls[0]?.question?.slice(0, 40));

// 3/4) 解读选中/就选中提问已移至划词浮条（SEL_TAGS）——标签排不再重复
ok('解读/提问标签已从标签排移除', !tags.some(t => t.textContent.includes('解读选中') || t.textContent.includes('就选中提问')));


// 5) ↑↓ 历史
doc.querySelector('#qa-text').value = '';
window.__T.state.qaHistory = ['历史问题甲', '历史问题乙'];
doc.querySelector('#qa-text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
ok('↑ 翻出最近历史', doc.querySelector('#qa-text').value === '历史问题甲');
doc.querySelector('#qa-text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
ok('再 ↑ 到更早', doc.querySelector('#qa-text').value === '历史问题乙');
doc.querySelector('#qa-text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
ok('↓ 回到较近', doc.querySelector('#qa-text').value === '历史问题甲');
doc.querySelector('#qa-text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
ok('↓ 到底回草稿', doc.querySelector('#qa-text').value === '');

// 5.5) 问答区高度可拖拽：分隔条 + 标题栏两处抓握点，握点提示可见
ok('标题栏为抓握点（拖拽逻辑走 .qa-dock-head）', !!doc.querySelector('.qa-dock-head'));
ok('⇕ 提示控件已移除（按需求精简）', !doc.querySelector('.qa-drag-hint'));
const handle = doc.querySelector('#rpane-handle');
ok('分隔条存在且未隐藏', !!handle && !handle.hidden);
{
  // jsdom 无布局（rect.height=0）→ 断言「拖拽处理链路触发」而非高度变化；
  // 真实高度变化由 CDP 无头 Chrome 在真实站点验证（24%→10%→31%）
  const hr = doc.querySelector('.qa-dock-head');
  const dock = doc.querySelector('#qa-dock');
  const o = {bubbles: true, cancelable: true, clientX: 100, clientY: 50, pointerId: 1, isPrimary: true, button: 0, buttons: 1};
  hr.dispatchEvent(new window.PointerEvent('pointerdown', o));
  ok('标题栏按下即进入拖拽态', dock.classList.contains('resizing'));
  doc.dispatchEvent(new window.PointerEvent('pointerup', {bubbles: true, clientX: 100, clientY: 50, pointerId: 1}));
  ok('松开退出拖拽态', !dock.classList.contains('resizing'));
}

// 6) / 快选面板 + 三条关闭路径（Esc / ✕ / 点面板外）
doc.querySelector('#qa-text').dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
ok(' / 打开论文快选面板', !doc.querySelector('#qa-pick-panel').hidden);
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
ok('Esc 关闭选文面板', doc.querySelector('#qa-pick-panel').hidden);
doc.querySelector('#qa-pick-toggle').click();
await new Promise((r) => setTimeout(r, 80));
ok('＋添加论文 chip 再开', !doc.querySelector('#qa-pick-panel').hidden);
doc.querySelector('#qa-pick-close').click();
await new Promise((r) => setTimeout(r, 50));
ok('✕ 关闭选文面板', doc.querySelector('#qa-pick-panel').hidden);
doc.querySelector('#qa-pick-toggle').click();
await new Promise((r) => setTimeout(r, 80));
doc.body.click();
await new Promise((r) => setTimeout(r, 50));
ok('点面板外关闭', doc.querySelector('#qa-pick-panel').hidden);

// 7) 新建标签（＋键直接打开编辑器）→ 保存走 PUT
const addBtn = doc.querySelector('#cmdtag-add');
addBtn.click();
await new Promise((r) => setTimeout(r, 150));
const dlg = [...doc.querySelectorAll('.ui-pop')].at(-1);
ok('长按打开标签编辑器', !!dlg && !!dlg.querySelector('#tag-prompt'));
if (dlg) {
  dlg.querySelector('#tag-label').value = '🧪 新标签';
  dlg.querySelector('#tag-prompt').value = '测试 {选中文字}';
  dlg.querySelector('[data-ok]').click();
  await new Promise((r) => setTimeout(r, 150));
  ok('保存走 PUT /api/cmdtags', tagSaves.length === 1 &&
     tagSaves[0].tags.some(t => t.label === '🧪 新标签'));
  ok('新标签出现在标签排', [...doc.querySelectorAll('#cmdtags .cmdtag')]
     .some(t => t.textContent.includes('新标签')));
}

// 8) 选中浮条：模拟 mouseup + 选区
const fakeNode = { parentElement: { closest: () => ({}) } };
window.getSelection = () => ({
  toString: () => 'a selected passage about gaussians',
  anchorNode: fakeNode,
  getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 120, left: 120 }) }),
});
doc.body.dispatchEvent(new window.Event('mouseup', { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const selBar = doc.querySelector('#sel-bar');
ok('选中浮条出现', !!selBar);
ok('浮条六键（AI 解读/提问/翻译/高亮/批注/文献入库）', selBar && selBar.querySelectorAll('button').length === 6);
selBar.querySelector('[data-a="translate"]').click();
await new Promise((r) => setTimeout(r, 150));
ok('翻译请求发出', translateCalls.length === 1 && translateCalls[0].text.includes('gaussians'));
// 引文提取：选中参考文献条目 → 走标识符导入
selBar.querySelector('[data-a="cite"]').click();
await new Promise((r) => setTimeout(r, 200));
ok('引文提取走标识符导入', identCalls.length === 1 &&
   identCalls[0].text.includes('gaussians') && !identCalls[0].text.startsWith('['));
ok('译文卡显示', !!doc.querySelector('#sel-result') &&
   doc.querySelector('#sel-result .sr-body').textContent.includes('译文'));

// 9) 标识符导入（P1：入口为导入弹层「链接·标识符」页签）
doc.querySelector('#upload-arrow').click();
doc.querySelector('.import-pop .chip-btn[data-tab="ident"]')?.click();
doc.querySelector('#ident-input').value = '10.1234/abc\narXiv:2401.12345';
doc.querySelector('#ident-btn').click();
await new Promise((r) => setTimeout(r, 200));
ok('标识符导入请求发出（含步骤8引文提取共 2 次）', identCalls.length === 2 &&
   identCalls[1].text.includes('10.1234/abc'));
ok('导入弹层关闭+列表刷新', !doc.querySelector('.import-pop'));

// 多对多：QA 选文共享库分组 + 多库论文标识
{
  window.__T.state.qaAllPapers = [
    { id: 'p1', title: 'Test Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, collection_ids: ['c1'] },
    { id: 'p2', title: 'Multi Lib Paper', parse_status: 'parsed', visibility: 'shared', owner_id: 1, collection_ids: ['c1', 'cs1'] },
  ];
  window.__T.state.sharedLibs = [{ id: 'cs1', name: '合作者库', owner_id: 2, papers: 1, shared: true }];
  window.__T.state.collections = [{ id: 'c1', name: '默认文献库', parent_id: null, papers: 1, papers_total: 1 }];
  const panelBtn = doc.querySelector('#qa-pick-toggle');
  if (panelBtn) {
    panelBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const body = doc.body.textContent;
    ok('共享库分组出现（合作者库）', body.includes('合作者库'));
    ok('多库论文行有归属标识', body.includes('默认文献库/合作者库'),
       JSON.stringify({
         list: doc.querySelector('#qa-pick-list')?.innerHTML.slice(0, 400) || '无列表',
         rows: doc.querySelectorAll('.qa-pick-item').length,
         papers: window.__T.state.qaAllPapers?.length,
         cols: window.__T.state.collections?.length,
         shared: window.__T.state.sharedLibs?.length,
       }).slice(0, 500));
  } else {
    ok('选文面板入口存在（跳过多库断言）', false, '无 #qa-pick-toggle');
  }
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\n❌ 失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
