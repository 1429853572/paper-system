#!/usr/bin/env node
/**
 * 全站按钮巡检：找出"点了没反应"的按钮。
 *
 * 两层检测：
 *   A) 静态运行时校验 —— 所有带 onclick 的元素，取引用的函数名，检查 window 上是否存在
 *      （不点击，安全；能覆盖删除类按钮）
 *   B) 动态点击巡检 —— 逐个点击非危险元素，捕获 JS 异常与 4xx/5xx 接口错误
 *      （能覆盖 addEventListener 绑定的按钮，静态审计查不到）
 *
 * 用法：
 *   node scripts/audit-buttons.mjs                       # 默认 http://127.0.0.1:7861
 *   BASE_URL=... node scripts/audit-buttons.mjs
 * 密码取 .env 的 ADMIN_INITIAL_PASSWORD（或环境变量 PAPERSYS_ADMIN_PW）。
 *
 * 注意：脚本会先备份 data/papersys.db；跳过的按钮清单见 SKIP 常量。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:7861';
const PORT = Number(process.env.AUDIT_PORT || 9371);
const PW = process.env.PAPERSYS_ADMIN_PW || (() => {
  const env = join(root, '.env');
  if (!existsSync(env)) return '';
  const m = readFileSync(env, 'utf8').match(/^ADMIN_INITIAL_PASSWORD=(.*)$/m);
  return m ? m[1].trim() : '';
})();
if (!PW) { console.error('找不到管理员密码：设置环境变量 PAPERSYS_ADMIN_PW 或 .env 里的 ADMIN_INITIAL_PASSWORD'); process.exit(2); }

// 会改数据 / 花钱 / 登出的按钮一律跳过
const SKIP = "/彻底删除|清空回收站|清空|删除|移除|✕|上传|导入|翻译|重译|生成导读|生成邀请码|保存配额|退出|重置|重命名|新建|创建|添加子库|批量翻译|批量删除|移入|术语|delGlossary|delLib|delPaperFromLib|col-del|pi-del|togglePool|createInvite|gl-add|renameLib|vis-toggle|sel-toggle|side-collapse|side-expand|upload-arrow|file/";

const PAGES = [
  { name: '阅读页', page: 'reader', wait: 900 },
  { name: '阅读·文献信息', page: 'reader', wait: 900, pre: `document.querySelector('.view-tabs [data-v="meta"]')?.click()` },
  { name: '阅读·图表', page: 'reader', wait: 900, pre: `document.querySelector('.view-tabs [data-v="assets"]')?.click()` },
  { name: '阅读·JSON', page: 'reader', wait: 900, pre: `document.querySelector('.view-tabs [data-v="json"]')?.click()` },
  { name: '阅读·双语对照', page: 'reader', wait: 1200, pre: `document.querySelector('#r-subtabs [data-s="bilingual"]')?.click()` },
  { name: '阅读·中文', page: 'reader', wait: 1200, pre: `document.querySelector('#r-subtabs [data-s="zh"]')?.click()` },
  { name: '文库管理', page: 'collections', wait: 2200 },
  { name: '回收站', page: 'trash', wait: 1400 },
  { name: '设置页', page: 'settings', wait: 1800 },
];

const chrome = spawn('google-chrome', ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
  `--remote-debugging-port=${PORT}`,'--window-size=1600,1000','--hide-scrollbars',
  `--user-data-dir=/tmp/psys-audit-profile`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) {
  try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = j.find(x => x.type === 'page'); if (target) break; } catch {}
  await sleep(250);
}
let msgId = 0; const pending = new Map();
let pendingErr = [], netErr = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++msgId; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pendingErr.push(String(d.exception?.description || d.text || '').split('\n')[0].slice(0, 220));
  } else if (m.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    netErr.push({ status: m.params.response.status, url: m.params.response.url.replace(BASE, '') });
  }
};
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || '').slice(0, 220) };
  return r.result.value;
};

// 先备份数据库
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', ['-c',
    `import sqlite3,datetime;c=sqlite3.connect('${join(root, 'data/papersys.db')}');` +
    `c.execute("VACUUM INTO 'data/backups/pre-audit-%s.db'"%datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));c.close()`],
    { cwd: root, stdio: 'ignore' });
  console.log('已备份 data/papersys.db → data/backups/pre-audit-*.db');
} catch (e) { console.log('（备份跳过：' + e.message.slice(0, 60) + '）'); }

await send('Page.navigate', { url: BASE + '/login' }); await sleep(1200);
await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:${JSON.stringify(PW)}})})`);
await send('Page.navigate', { url: BASE + '/' }); await sleep(2000);

const CHECK_ONCLICK = `(()=>{
  const bad = []; const seen = new Set();
  // 内置全局（不是项目函数，缺失也不报错）
  const BUILTIN = new Set(['document','window','console','setTimeout','setInterval','clearTimeout',
    'clearInterval','alert','confirm','prompt','fetch','JSON','Object','Array','String','Number',
    'Boolean','Math','Date','parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent',
    'Event','CustomEvent','FormData','URL','Blob','File','FileReader','Intl','Map','Set','Promise']);
  for (const el of document.querySelectorAll('[onclick]')) {
    const attr = el.getAttribute('onclick') || '';
    const key = el.tagName + '|' + (el.id||'') + '|' + attr.slice(0,50);
    if (seen.has(key)) continue; seen.add(key);
    // 剥掉「对象.方法(」「obj?.method(」「?.method(」三种形式——剩下的才是裸函数调用
    const clean = attr
      .replace(/\\?\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(/g, '(')
      .replace(/\\b[A-Za-z_$][\\w$]*\\s*\\?\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(/g, '(')
      .replace(/\\b[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\s*\\(/g, '(');
    for (const m of clean.matchAll(/\\b([A-Za-z_$][\\w$]*)\\s*\\(/g)) {
      const fn = m[1];
      if (fn === 'event' || fn === 'e' || fn === 'this') continue;
      if (BUILTIN.has(fn)) continue;
      if (typeof window[fn] !== 'function')
        bad.push({tag: el.tagName, cls: String(el.className).slice(0,26),
                  text: (el.textContent||'').trim().slice(0,16), fn, onclick: attr.slice(0,70)});
    }
  }
  return JSON.stringify(bad);
})()`;

const INJECT_NEXT = `window.__auditDone = window.__auditDone || new Set();
window.__auditNext = (skipRe) => {
  const SEL = 'button, a.btn, .tool-arrow, .col-arrow, .tab-collapse, .side-collapse, .side-expand, .tp-item, .chip, .lib-sel, .lib-paper-row';
  const els = [...document.querySelectorAll(SEL)].filter(el =>
    !el.disabled && !el.hidden && el.getBoundingClientRect().width && el.offsetParent !== null);
  for (const el of els) {
    const txt = (el.textContent||'').trim();
    const desc = el.tagName + (el.id ? '#'+el.id : '') +
      (el.className ? '.'+String(el.className).split(' ').filter(Boolean)[0] : '') +
      (txt ? ' <<'+txt.slice(0,14)+'>>' : '');
    // 去重键用结构（标签/类/onclick/id），不用文本——文本会随计数、页码实时变，
    // 否则同一个按钮会被反复点，迟迟轮不到别的按钮
    const key = el.tagName + '|' + (el.className||'') + '|' + (el.getAttribute('onclick')||'') + '|' + (el.id||'');
    if (window.__auditDone.has(key)) continue;
    window.__auditDone.add(key);
    if (skipRe.test(txt + ' ' + desc + ' ' + (el.getAttribute('onclick')||''))) continue;
    el.click();
    return 'clicked:' + desc;
  }
  return 'none';
}; 'ok'`;

const report = [];
for (const pg of PAGES) {
  await ev(`window.switchPage('${pg.page}')`);
  await sleep(pg.wait);
  if (pg.pre) { await ev(pg.pre); await sleep(1200); }
  await ev(`window.__auditDone = new Set(); 'ok'`);

  const rawBad = await ev(CHECK_ONCLICK);
  if (rawBad && rawBad.__err) report.push({ page: pg.name, kind: '校验本身异常', detail: rawBad.__err });
  else for (const b of JSON.parse(rawBad || '[]')) report.push({ page: pg.name, kind: 'onclick 函数缺失', ...b });

  await ev(INJECT_NEXT);
  let clicked = 0;
  for (let i = 0; i < 200; i++) {
    pendingErr = []; netErr = [];
    const r = await ev(`window.__auditNext(new RegExp(${JSON.stringify(SKIP)}))`);
    if (typeof r !== 'string' || r === 'none') break;
    if (r.startsWith('clicked:')) clicked++;
    await sleep(200);
    if (pendingErr.length) { report.push({ page: pg.name, kind: '点击抛异常', el: r.slice(8), err: pendingErr[0] }); pendingErr = []; }
    if (netErr.length) { for (const n of netErr) report.push({ page: pg.name, kind: '接口错误', el: r.slice(8), ...n }); netErr = []; }
    const onPage = await ev(`(()=>{const el=document.querySelector('#page-${pg.page}');return el&&el.style.display!=='none';})()`);
    if (!onPage) { await ev(`window.switchPage('${pg.page}')`); await sleep(900); await ev(INJECT_NEXT); }
  }
  console.log(`[${pg.name}] 点击 ${clicked} 个`);
}

console.log('\n===== 问题清单 =====');
if (!report.length) console.log('（无）');
for (const r of report) console.log(JSON.stringify(r));
writeFileSync('/tmp/psys-audit-report.json', JSON.stringify(report, null, 1));
ws.close(); chrome.kill();
process.exit(report.length ? 1 : 0);
