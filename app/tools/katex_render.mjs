// 服务端 KaTeX 渲染：输入 {"maths":["..."]} → 输出 {"rendered":["<html>",...]}（失败回退原文）
import fs from 'node:fs';
const katexPath = process.env.KATEX_PATH || '/app/webui/vendor/katex/katex.mjs';
const { default: katex } = await import(katexPath);
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = input.maths.map(m => {
  try {
    return katex.renderToString(m, { throwOnError: false, displayMode: false, strict: false, trust: true });
  } catch (e) { return m; }
});
fs.writeFileSync(process.argv[3], JSON.stringify({ rendered: out }));
