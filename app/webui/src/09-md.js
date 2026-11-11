/* ===== 09-md.js —— Markdown 渲染：mdLite/表格/引用跳转 =====
   由 app/webui/src/ 拼接生成（见 scripts/build-webui.py）；
   请勿直接改 app/webui/viewer.js（构建产物）。 */
function mdLite(text) {
  let raw = String(text ?? '');
  // 模型偶尔给 ```json 围栏（历史坏数据）——剥掉围栏只留内容
  if (raw.trim().startsWith('```')) {
    const m2 = raw.trim().match(/^```(?:\w*)\n?([\s\S]*?)\n?```$/);
    if (m2) raw = m2[1];
  }
  let h = esc(raw);
  // 表格先抽出（占位保护，避免逐行处理把表格拆散）
  const tables = [];
  // 表格：每行以 | 结尾，行间可有换行；末行允许直接到文末（表格在段落末尾时无换行）
  h = h.replace(/(^|\n)((?:\|[^\n]+\|[ \t]*(?:\n|$))+)/g, (m3, pre, block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[\s:|-]+\|$/.test(r));
    const cells = rows.map(r => r.split('|').slice(1, -1).map(c => c.trim()));
    if (cells.length < 2) return m3;
    // 数字列右对齐 + 等宽数字（消融表这类「标签+数值」表才读得下去）
    const isNum = c => /^[+\-−]?\d[\d,.]*\s*(?:%|dB|×|fps|ms|s|m|h|K|M|G|T|B)?$/.test(c.trim());
    const numCols = cells[0].map((_, i) => cells.slice(1).every(r => isNum(r[i] ?? '')));
    const th = cells[0].map((c, i) => `<th class="${numCols[i] ? 'num' : ''}">${c}</th>`).join('');
    const tb = cells.slice(1).map(r => '<tr>' + r.map((c, i) =>
      `<td class="${numCols[i] ? 'num' : ''}">${c}</td>`).join('') + '</tr>').join('');
    const html = '<div class="tbl-wrap"><table class="tbl-md"><thead><tr>' + th + '</tr></thead>' +
      '<tbody>' + tb + '</tbody></table></div>';
    tables.push(html);
    return pre + `\u0000TBL${tables.length - 1}\u0000`;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^#{2,4} (.+)$/gm, '<h4>$1</h4>');
  // 逐行处理：编号/无序列表成组，段落按空行切分（导读的「方法」几乎都是 1) 2) 3) 结构）
  const lines = h.split('\n');
  const out = [];
  let listBuf = [], listType = '', paraBuf = [];
  const flushList = () => {
    if (listBuf.length) { out.push(`<${listType} class="md-list">${listBuf.join('')}</${listType}>`); listBuf = []; listType = ''; }
  };
  const flushPara = () => {
    if (paraBuf.length) { out.push(`<p>${paraBuf.join('<br>')}</p>`); paraBuf = []; }
  };
  for (const ln of lines) {
    let mm;
    // 先判行内编号（覆盖 '1) A 2) B' 与 '1) A' 两种：序号从 1 连续递增才拆）
    const inline = splitInlineList(ln);
    if (inline) {
      flushPara(); flushList();
      if (inline.lead) out.push(`<p>${inline.lead}</p>`);
      out.push(`<ol class="md-list">${inline.items.map(it =>
        `<li class="md-num"><span class="md-n">${it.num}</span><span>${it.content}</span></li>`).join('')}</ol>`);
      continue;
    }
    if ((mm = ln.match(/^(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listBuf.push(`<li class="md-num"><span class="md-n">${mm[1]}</span><span>${mm[2]}</span></li>`);
      continue;
    }
    if ((mm = ln.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listBuf.push(`<li class="md-bullet"><span class="md-n">&bull;</span><span>${mm[1]}</span></li>`);
      continue;
    }
    if (!ln.trim()) { flushPara(); flushList(); continue; }
    flushList();
    paraBuf.push(ln);
  }
  flushPara(); flushList();
  let res = out.join('');
  tables.forEach((t, i) => { res = res.replace(`\u0000TBL${i}\u0000`, t); });
  return linkifyRefs(katexify(res));
}
function renderCites(text, evidence) {
  return mdLite(text).replace(/\[(\d{1,3})\]/g, (m, n) => {
    // 按 evidence_id 匹配（校验后的 evidence 数组只剩被引用项，下标 ≠ 编号）
    const ev = evidence && evidence.find(x => String(x.evidence_id) === n);
    const tip = ev ? `${ev.title || ev.paper_id} · 第${ev.page_index + 1}页` : '';
    return `<span class="cite" data-n="${n}"${tip ? ` title="${esc(tip)}"` : ''}>[${n}]</span>`;
  });
}
function wireCites(container, evidence) {
  $$('.cite', container).forEach(el => {
    const n = String(el.dataset.n || (el.textContent.match(/\d+/) || [0])[0]);
    const ev = evidence && evidence.find(x => String(x.evidence_id) === n);
    el._ev = ev || null;              // 悬浮预览卡直接取（见 ② 引用悬浮预览）
    el.onclick = () => { if (ev) jumpToEvidence(ev); };
  });
}
/* 点引文 → 定位到具体块：PDF 里闪烁高亮 + 右侧阅读面板滚到该段并置为激活。
   只跳页的话整页几十个块还是不好找，所以必须定位到块。
   证据块常在分页未加载区间（首屏仅 40 块）→ 增量加载直到命中。 */
window.jumpToEvidence = async e => {
  if (!e) return;
  if (!state.current || state.current.id !== e.paper_id) await openPaper(e.paper_id);
  const match = () =>
    (state.blocks || []).find(x => x.block_id === e.block_id)
    || state.blocks.find(x => x.page_index === e.page_index && x.text
         && e.text && (x.text.includes(e.text.slice(0, 60)) || e.text.includes(x.text.slice(0, 60))));
  let blk = match();
  if (!blk && state.current) {
    // 分页穿透：切到原文视图逐批加载，直到目标块出现或已越过证据所在页
    switchPage('reader');
    if (state.view !== 'orig') switchView('read', 'orig');
    for (let i = 0; i < 80 && state._blkOffset < (state._blkTotal || 0); i++) {
      await loadMoreBlocks();
      blk = match();
      if (blk) break;
      const lastPg = state.blocks.length ? state.blocks[state.blocks.length - 1].page_index : -1;
      if (lastPg > e.page_index + 1) break;   // 已翻过证据页仍未命中（块失配）→ 放弃
    }
  }
  if (blk) {
    switchPage('reader');
    // 右侧阅读面板：置为激活块 + 滚到可见（当前子页签没显示正文就切到"原文"）
    let blkEl = $(`#content-view .blk[data-bid="${blk.block_id}"]`);
    if (!blkEl) {
      switchView('read', 'orig');
      blkEl = $(`#content-view .blk[data-bid="${blk.block_id}"]`);
    }
    if (blkEl) {
      $$('#content-view .blk').forEach(x => { x.classList.remove('active'); x.style.removeProperty('--hlc'); });
      applyActiveStyle(blkEl);
      blkEl.scrollIntoView({block: 'center', behavior: 'smooth'});
      // 源句闪烁（llm-for-zotero/zotero-mcp 式）：跳到后 2 秒内一眼锁定引用原文
      blkEl.classList.remove('blk-flash');
      void blkEl.offsetWidth;   // 强制 reflow 重启动画
      blkEl.classList.add('blk-flash');
      setTimeout(() => blkEl.classList.remove('blk-flash'), 2200);
    }
    // PDF：滚到块所在页并闪烁高亮框（跨页段落每页各画一个）
    if (state.pdfDoc) state.pageNum = blk.page_index + 1;
    await pdfFlashBlock(blk);
    return;
  }
  // 找不到块（跨论文证据 / 块已重建）→ 至少跳到对应页；保守提示而非静默
  if (state.pdfDoc) { state.pageNum = e.page_index + 1; renderPage(); }
  toast('该引用的原文段落未精确定位（块可能已重建），已跳到所在页');
};
window.jumpEvidence = page => { switchPage('reader'); if (state.pdfDoc) { state.pageNum = page + 1; renderPage(); } };

/* ================= 恢复区：被误删函数重建（以文件末尾声明覆盖） ================= */

/* ---- 回收站 ---- */
async function renderTrash() {
  const d = await api('/api/papers?trash=1');
  state._trashCount = (d.papers || []).length;   // 清空确认框要显示影响篇数
  $('#page-trash').innerHTML = `<div class="card"><h2 style="display:flex;gap:10px;align-items:center">回收站（${state.health.trash_days || 30} 天后自动清理）
    <button class="btn small danger" style="margin-left:auto" onclick="emptyTrash()">${icon('trash')} 清空回收站</button></h2>
    <table class="list"><tr><th>标题</th><th>删除时间</th><th></th></tr>
    ${d.papers.map(p => `<tr><td>${esc(p.title)}</td><td class="muted">${fmtTime(p.deleted_at)}</td>
      <td class="row-actions"><button class="btn small" onclick="restorePaper('${p.id}')">恢复</button>
      </td></tr>`).join('') || '<tr><td colspan="3" class="muted">回收站为空——删除的论文在此保留 30 天，可随时恢复</td></tr>'}</table></div>`;
}
window.restorePaper = async id => {
  try {
    await api(`/api/papers/${id}/restore`, {method: 'POST'});
    toast('已恢复'); renderTrash(); await refreshLib();
  } catch (e) { toast(friendlyError(e, '恢复失败，请重试')); }
};

/* ---- 设置（BYOK + 术语表 + 测试连接） ---- */
/* 设置页：页签分组（账号 / AI 模型 / 术语表 / 用量 / 管理）——
   原为单页 97 个控件 3.6 屏（86% 在首屏外），改为每页只渲染本类内容。 */
