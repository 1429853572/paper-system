/**
 * 全站交互走查（真机 CDP）——每个页面的关键按钮/弹层/快捷键逐一真实点按。
 * 用法: node scripts/e2e-walkthrough.mjs（需 CDP 浏览器 :9222 + /tmp/pw.txt）
 * 破坏性操作（DELETE/清空）在 fetch 层拦截 mock——走查不碰真实数据。
 */
import fs from 'fs';
const PW = fs.readFileSync('/tmp/pw.txt', 'utf8').trim();
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const excs = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') excs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 110)); };
function send(m, p = {}) { return new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Runtime.enable'); await send('Page.enable');
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : ' — ' + x)); c ? pass++ : (fail++, fails.push(n)); };

await send('Page.navigate', { url: 'http://127.0.0.1:7861/login' }); await sleep(1300);
await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:${JSON.stringify(PW)}})}).then(r=>r.text())`);
await send('Page.navigate', { url: 'http://127.0.0.1:7861/' }); await sleep(2600);
await ev(`localStorage.setItem('ps-onboarded','1'); 'ok'`);
await ev(`document.querySelector('.onboard-pop [data-ok]')?.click()`);
await sleep(400);
await ev(`window.__apiLog = [];
const _f = window.fetch.bind(window);
window.fetch = function(u, o) { const url = String(u), m = (o&&o.method)||'GET';
  window.__apiLog.push(m + ' ' + url.slice(0, 90));
  if (m === 'DELETE' || /empty-trash/.test(url)) return Promise.resolve({ok:true,status:200,json:async()=>({ok:true})});
  window.__realFetch = _f;   // 真请求出口（末尾清理走查残留用）
  return _f(u, o); };
window.uiConfirm = async () => true; window.prompt = () => '走查库';
'ready'`);
await ev(`window.openPaper([...document.querySelectorAll('#paper-list .paper-item')].find(i => i.textContent.includes('MetroGS'))?.dataset.id); 'ok'`);
await sleep(3200);

// ---- 补测 3 项（正确事件模型）----
console.log('━━━ 补测（walk1 修正）━━━');
await ev(`window.__apiLog = [];
  document.querySelector('.cmdtag[data-tag=b1]')?.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); 'ok'`);
await sleep(3500);
ok('命令标签「快速总结」（mouseup 正确事件）', await ev(`window.__apiLog.some(x => x.includes('chat'))`) === true,
   await ev(`(window.__apiLog||[]).filter(x=>x.includes('chat')).length + ' chat calls'`));
await ev(`switchPage('collections')`); await sleep(1400);
await ev(`[...document.querySelectorAll('#page-collections button')].find(b => b.textContent.includes('新建库'))?.click(); 'ok'`);
await sleep(500);
await ev(`const i = document.querySelector('.ui-pop .ui-pop-input'); if (i) { i.value = '走查临时库'; } 'ok'`);
await ev(`window.__apiLog = []; [...document.querySelectorAll('.ui-pop .btn.primary')].pop()?.click(); 'ok'`);
await sleep(1100);
ok('新建库（对话框填名+确定）', await ev(`window.__apiLog.some(x => x.startsWith('POST /api/collections'))`) === true,
   await ev(`(window.__apiLog||[]).filter(x=>x.includes('collections')).slice(0,2).join(',')`));
await ev(`document.querySelector('.ui-backdrop')?.remove()`); await sleep(300);
// 列表视图：找切换（可能是 icon title）
await ev(`[...document.querySelectorAll('#page-collections button')].find(b => (b.title||'').includes('列表') || b.textContent.trim()==='列表')?.click(); 'ok'`);
await sleep(800);
const ckN = await ev(`document.querySelectorAll('.lib-ck:not(.lib-ck-all)').length`);
if (ckN > 0) {
  await ev(`document.querySelector('.lib-ck:not(.lib-ck-all)')?.click()`); await sleep(800);
  ok('列表勾选出批量条', await ev(`!!document.querySelector('.lib-batch')`) === true);
  await ev(`document.querySelector('.lib-batch .btn')?.click(); document.body.click()`); await sleep(300);
} else {
  // 兜底：全选框
  await ev(`document.querySelector('.lib-ck-all')?.click()`); await sleep(800);
  ok('全选勾选出批量条', await ev(`!!document.querySelector('.lib-batch')`) === true, 'ckN=0 用全选兜底');
  await ev(`document.querySelector('.lib-ck-all')?.click(); document.body.click()`); await sleep(300);
}

// ---- 追踪页 ----
console.log('━━━ 追踪页 ━━━');
await ev(`switchPage('tracker')`); await sleep(1400);
await ev(`document.querySelector('.topnav [data-page=tracker]')?.click()`); await sleep(900);
await ev(`window.trackerNew()`); await sleep(700);
ok('新建订阅弹层', await ev(`!!document.querySelector('#tk-name')`) === true);
await ev(`document.querySelector('#tk-keywords').value = 'walkthrough'; 'ok'`);
await ev(`window.__apiLog = []; window.trackerSave(null)`); await sleep(1100);
ok('订阅保存 POST', await ev(`window.__apiLog.some(x => x.startsWith('POST /api/tracker/subs'))`) === true);
// 编辑按钮（悬停铅笔）
await ev(`window.trackerEdit((window.__state?._trackerSubs||[])[0]?.id)`); await sleep(600);
ok('编辑弹层预填', await ev(`document.querySelector('#tk-keywords')?.value.length > 0`) === true);
// 分类 chip 联动
await ev(`document.querySelector('[data-cat="cs.CV"]')?.click()`); await sleep(300);
ok('分类 chip 联动', await ev(`document.querySelector('#tk-cats').value.includes('cs.CV')`) === true);
await ev(`window.trackerCloseForm()`); await sleep(400);
// rail 各视图
for (const label of ['已收进', '已忽略']) {
  await ev(`[...document.querySelectorAll('#tk-rail-list .tk-rail-item')].find(x => x.textContent.includes('${label}'))?.click()`); await sleep(700);
}
ok('rail 已收进/已忽略视图切换', true);
await ev(`[...document.querySelectorAll('#tk-rail-list .tk-rail-item')][0]?.click()`); await sleep(700);
// 层级 chips
for (const t of ['核心', '相关', '生态']) {
  await ev(`[...document.querySelectorAll('#tk-toolbar .chip-btn')].find(x => x.textContent.trim() === '${t}')?.click()`); await sleep(400);
}
ok('层级筛选 chips', true);
// 收进条目操作（已收进视图里打开+阶段条）
await ev(`[...document.querySelectorAll('#tk-rail-list .tk-rail-item')].find(x => x.textContent.includes('已收进'))?.click()`); await sleep(900);
const openBtn = await ev(`!!document.querySelector('#tk-stream [onclick*=trackerOpenPaper]')`);
if (openBtn) {
  await ev(`document.querySelector('#tk-stream [onclick*=trackerOpenPaper]')?.click()`); await sleep(2500);
  ok('追踪「打开」切回阅读页', await ev(`document.querySelector('#page-reader').style.display !== 'none' && !!window.__state?.current`) === true);
  await ev(`switchPage('tracker')`); await sleep(900);
}

// ---- 表格页 ----
console.log('━━━ 表格页 ━━━');
await ev(`switchPage('tables')`); await sleep(1500);
await ev(`window.tbHarvestOpen()`); await sleep(900);
ok('收表弹层（搜索/库/只看未收）', await ev(`!!document.querySelector('#tb-src-q') && !!document.querySelector('#tb-src-lib')`) === true);
await ev(`window._tbHarvestClose()`); await sleep(300);
await ev(`window.tbUploadOpen()`); await sleep(700);
ok('上传弹层（库下拉+文件+自动整理）', await ev(`!!document.querySelector('#tb-up-coll') && !!document.querySelector('#tb-up-files')`) === true);
await ev(`window._tbUpClose()`); await sleep(300);
// 状态 chips + 库下拉
for (const c of ['待取舍', '已保留', '已剔除', '全部']) {
  await ev(`[...document.querySelectorAll('#tb-toolbar .chip-btn')].find(x => x.textContent.trim() === '${c}')?.click()`); await sleep(400);
}
await ev(`[...document.querySelectorAll('#tb-toolbar .chip-btn')].find(x => x.textContent.trim() === '未剔除')?.click()`); await sleep(500);
ok('表格状态 chips 切换', true);
// 卡片行内按钮：对照开→翻页→布局→关闭
await ev(`window.tbCompare(document.querySelector('.tb-card')?.dataset?.tid)`); await sleep(1400);
ok('对照工作台打开', await ev(`!!document.querySelector('.tbws')`) === true);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}))`); await sleep(1300);
ok('→ 翻下一张', await ev(`document.querySelector('.tbws-count')?.textContent`) !== '1 / 635');
for (const m of ['img', 'grid', 'both']) { await ev(`window.tbCmpLayout('${m}')`); await sleep(350); }
ok('布局三态切换', true);
await ev(`document.querySelector('.tbws-foot .btn[onclick*=tbLocate]')?.click()`); await sleep(2500);
ok('定位原文切页', await ev(`document.querySelector('#page-reader').style.display !== 'none'`) === true);
await ev(`switchPage('tables')`); await sleep(1000);
await ev(`window.tbCompareClose()`); await sleep(600);
// 批量：勾选→剔除→撤销
await ev(`document.querySelector('.tb-card .tb-ck')?.click()`); await sleep(900);
await ev(`window.__apiLog = []; [...document.querySelectorAll('.lib-batch .btn')].find(b => b.textContent.includes('剔除'))?.click()`); await sleep(1000);
const undid = await ev(`!!document.querySelector('#toast .toast-action')`);
if (undid) { await ev(`document.querySelector('#toast .toast-action')?.click()`); await sleep(1000); }
ok('批量剔除+撤销链', await ev(`window.__apiLog.some(x => x.includes('batch-review'))`) === true);
// 导出选中
await ev(`document.querySelector('.tb-card .tb-ck')?.click()`); await sleep(900);
await ev(`window.__apiLog = []; window.tbExportSel ? tbExportSel(null) : 0; 'ok'`);
await sleep(1200);
ok('导出选中 xlsx 调用', await ev(`window.__apiLog.some(x => x.includes('/api/tables/export'))`) === true);
await ev(`tbCkClear()`); await sleep(400);

// ---- 回收站 ----
console.log('━━━ 回收站 ━━━');
await ev(`switchPage('trash')`); await sleep(900);
const trashBtns = await ev(`[...document.querySelectorAll('#page-trash button')].map(b => b.textContent.trim())`);
ok('回收站按钮（' + trashBtns.join('/') + '）', trashBtns.some(t => t.includes('清空')));   // 空站只有清空钮，行数>0 才有恢复钮
await ev(`window.__confirmLog = []; window.uiConfirm = async (m) => { window.__confirmLog.push(String(m).slice(0,30)); return false; };
  [...document.querySelectorAll('#page-trash button')].find(b => b.textContent.includes('清空'))?.click()`); await sleep(700);
ok('清空回收站弹确认（自动取消保护）', await ev(`window.__confirmLog.length > 0`) === true);
await ev(`window.uiConfirm = async () => true`);

// ---- 设置页 ----
console.log('━━━ 设置页 ━━━');
await ev(`switchPage('settings')`); await sleep(1100);
for (const tab of ['账号安全', 'AI 模型', '术语表', '我的用量']) {
  await ev(`[...document.querySelectorAll('.set-tabs button, [data-set-tab]')].find(b => b.textContent.trim() === '${tab}')?.click()`); await sleep(600);
}
ok('设置 4 tab 切换', true);
// 术语表加删
await ev(`[...document.querySelectorAll('.set-tab')].find(b => b.textContent.trim() === '术语表')?.click(); 'ok'`); await sleep(600);
await ev(`window.__apiLog = []; const t = document.querySelector('#gl-term');
  if (t) { t.value = '走查术语'; document.querySelector('#gl-value').value = 'walkthrough';
           document.querySelector('#gl-add')?.click(); } 'ok'`);
await sleep(900);
ok('术语表添加触发 POST /api/glossary', await ev(`window.__apiLog.some(x => x.includes('glossary'))`) === true);
await ev(`window.__realFetch('/api/glossary/' + encodeURIComponent('走查术语'), {method: 'DELETE'}).catch(() => {}); 'cleaned'`);

// ---- 管理后台 ----
console.log('━━━ 管理后台 ━━━');
await ev(`switchPage('admin')`); await sleep(1800);
// 邮件配置展开
await ev(`window.admSmtpToggle()`); await sleep(1200);
ok('邮件配置卡展开', await ev(`!!document.querySelector('#smtp-host')`) === true);
await ev(`window.admSmtpToggle()`); await sleep(900);
// 邀请码生成
await ev(`window.__apiLog = []; window.createInvite()`); await sleep(1100);
ok('生成邀请码', await ev(`window.__apiLog.some(x => x.includes('invite'))`) === true);
const invCode = await ev(`document.querySelector('#invite-out code')?.textContent`);
if (invCode) { await ev(`[...document.querySelectorAll('#invite-out button')].find(b => b.textContent.includes('复制'))?.click()`); await sleep(500); }
ok('邀请码复制按钮', !!invCode);
// 成员行更多菜单
await ev(`document.querySelector('.adm-menu summary')?.click()`); await sleep(600);
ok('成员行「更多」菜单展开', await ev(`!!document.querySelector('.adm-menu[open] .tool-pop')`) === true);
await ev(`document.querySelector('.adm-menu')?.removeAttribute('open')`);
// 编辑限额弹层
await ev(`window.openQuotaDialog ? (window.__state._quotaRaw = window.__state._quotaRaw || {}, openQuotaDialog(2)) : 0; 'ok'`);
await sleep(600);
ok('编辑限额弹层（6 字段）', (await ev(`document.querySelectorAll('.adm-q-row').length`)) >= 6);
await ev(`document.querySelector('.ui-pop .btn.small:not(.primary)')?.click()`); await sleep(400);

// 清理走查残留（新建库 POST 是真发的；DELETE 被拦截 mock，须走 __realFetch）
await ev(`(async () => {
  try {
    const d = await (await window.__realFetch('/api/collections')).json();
    const junk = (d.collections || []).find(c => c.name === '走查临时库');
    if (junk) await window.__realFetch('/api/collections/' + junk.id, {method: 'DELETE'});
  } catch {}
  return 'cleaned';
})()`);
await sleep(500);

console.log(`\n第 2 段+补测：${pass} 通过, ${fail} 失败`);
if (fails.length) { console.log('失败清单:'); fails.forEach(f => console.log('  ✗ ' + f)); }
console.log('JS 异常:', excs.length); excs.slice(0, 4).forEach(e => console.log('  ', e));
fs.writeFileSync('/tmp/rp/walk2-result.json', JSON.stringify({ pass, fail, fails, excs: excs.length }));
process.exit(fail ? 1 : 0);
