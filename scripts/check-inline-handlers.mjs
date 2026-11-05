#!/usr/bin/env node
/**
 * 检查内联事件里的函数调用是否都能解析。
 *
 * 背景：viewer.js 以 <script type="module"> 加载，模块顶层函数不在 window 上；
 * 而内联 onclick="fn()" 在**全局作用域**求值 → 引用模块函数会抛
 * ReferenceError，按钮看起来"点了没反应"。这个坑已出现过多次
 * （导出按钮、库卡折叠箭头、管理区三件套、生成导读）。
 *
 * 用法：node scripts/check-inline-handlers.mjs
 * 退出码 0 = 全部可解析；1 = 有缺失（列出名字）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(root, 'app/webui/viewer.js'), 'utf8');
const html = readFileSync(join(root, 'app/webui/index.html'), 'utf8');

/**
 * 把模板字符串插值 ${...} 整段替换成占位符。
 * 插值内部可能含引号（如 ${esc(q).replace(/'/g, "\\'")}），会截断后面的属性正则；
 * 而插值内容是运行时在 JS 作用域求值的，不受 window 作用域影响，必须整体排除。
 * 用非嵌套匹配（内部不含 {} 的常见情形）；嵌套插值残留的标识符一般都在 builtin 里。
 */
function stripInterpolations(s) {
  return s.replace(/\$\{[^{}]*\}/g, ' __TPL__ ');
}

const src = stripInterpolations(js) + '\n' + stripInterpolations(html);

// 收集内联事件属性里的函数调用标识符（属性值可能含转义引号，不能用 [^"]*）
const handlers = [
  ...src.matchAll(/on(?:click|change|input|keydown|submit|error)\s*=\s*"((?:[^"\\]|\\.)*)"/g),
  ...src.matchAll(/on(?:click|change|input|keydown|submit)\s*=\s*'((?:[^'\\]|\\.)*)'/g),
];
const called = new Set();
for (const m of handlers) {
  // 排除对象方法调用（event.stopPropagation()、e.preventDefault() 等）：整段替换掉
  const expr = m[1].replace(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/g, '(');
  for (const id of expr.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) called.add(id[1]);
}

const onWindow = new Set([...js.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]));
const builtin = new Set([
  'confirm', 'prompt', 'alert', 'parseInt', 'parseFloat', 'String', 'Number', 'Math', 'Date',
  'JSON', 'Boolean', 'Object', 'Array', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'undefined', 'replace', 'toString', 'trim', 'split', 'join',
]);

const missing = [...called].filter(n => !onWindow.has(n) && !builtin.has(n)).sort();
if (missing.length) {
  console.error('❌ 内联事件引用了未挂到 window 的函数（点击会抛 ReferenceError）：');
  for (const n of missing) console.error('   - ' + n);
  console.error('\n修法：在 viewer.js 里加 `window.<名字> = <名字>;`（模块作用域的函数）');
  process.exit(1);
}
console.log(`✅ 内联事件引用的 ${called.size} 个函数全部可解析（window 暴露 ${onWindow.size} 个）`);
