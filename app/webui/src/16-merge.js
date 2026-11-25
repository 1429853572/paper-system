/* ===== 16-merge.js —— AI 合并表：跨表合成 + 合并工作台（编辑/撤销重做/版本回看/导出） =====
/* 依赖 15-tables 的 tbStatusBadge/tbCollectGrid 等（同模块拼接，跨分片直引） */
/* ---------- AI 合并表（跨表合成 → 独立工作台：编辑/撤销重做/版本回看/导出） ---------- */
let _tbMergePop = null, _tbMergeStack = tbGridKernel.stack();

window.tbMergeCreate = async (ids, btn) => {
  const instruction = await new Promise(res => {
    const {pop, close} = openPop('tb-merge-ask-pop');
    pop.innerHTML = `
    <div class="ui-pop-title">${icon('brain')} AI 合并所选表格
      <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
    <div class="muted" style="font-size:var(--fs-sm);margin-top:6px">已选 ${ids.length} 张表——AI 把它们合成一张汇总表（相同主题对齐合并、重复去重/并列标注来源）。之后可在工作台继续编辑、撤销、换指令重新合成。</div>
    <textarea id="tb-merge-instr" rows="3" style="width:100%;margin-top:8px;font-size:var(--fs-sm)"
      placeholder="例：按数据集对齐各方法的 PSNR/SSIM 列，来源论文用列尾标注；或：合并所有 ablation 表，只保留与 Ours 相关的行"></textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <button class="btn primary" id="tb-merge-go">${icon('brain')} 开始合成</button>
      <span class="muted" style="font-size:var(--fs-xs)">一次最多 10 张源表；约 10–40 秒</span>
    </div>`;
    pop.querySelector('[data-x]').onclick = () => { close(); res(null); };
    $('#tb-merge-go').onclick = async () => {
      const instr = ($('#tb-merge-instr')?.value || '').trim();
      if (!instr) { toast('先输入合成指令'); return; }
      const go = $('#tb-merge-go');
      go.disabled = true; go.textContent = '合成中…（10–40 秒）';
      try {
        const r = await api('/api/tables/ai-merge', {method: 'POST', body: JSON.stringify({ids, instruction: instr})});
        close(); res(r.merge);
      } catch (e) {
        toast(friendlyError(e, '合成失败'));
        go.disabled = false;
      }
    };
  });
  if (instruction) { state._tbSel = new Set(); await loadTables(); tbMergeWorkspace(instruction.merge); }
};

function tbMergeRenderGrid(grid) {
  const t = $('#tb-merge-grid');
  if (!t) return;
  tbGridKernel.render(t, grid);
}

function tbMergeSnap() { _tbMergeStack.snap(window._tbMergeGrid); }
async function tbMergeApply(rows, msg) {
  window._tbMergeGrid = rows;
  tbMergeRenderGrid(rows);
  tbMergeSave();
  toast(msg, 1600);
}
window.tbMergeSave = async () => {
  const grid = tbGridKernel.collect($('#tb-merge-grid'));
  try { await api(`/api/tables/ai-merges/${_tbMerge.mid}`, {method: 'PATCH', body: JSON.stringify({grid})}); }
  catch (e) { toast(friendlyError(e, '保存失败')); }
};
window.tbMergeUndo = () => {
  const rows = _tbMergeStack.undo(window._tbMergeGrid);
  if (rows === null) { toast('没有可撤销的操作'); return; }
  window._tbMergeGrid = rows;
  tbMergeRenderGrid(rows);
  tbMergeSave();
};
window.tbMergeRedo = () => {
  const rows = _tbMergeStack.redo(window._tbMergeGrid);
  if (rows === null) { toast('没有可重做的操作'); return; }
  window._tbMergeGrid = rows;
  tbMergeRenderGrid(rows);
  tbMergeSave();
};

window.tbMergeWorkspace = m => {
  _tbMergePop?.close();
  // kernel 栈随工作台会话保持（换表清旧引用改为重置实例）
  _tbMergeStack = tbGridKernel.stack();
  window._tbMerge = m;
  window._tbMergeGrid = m.grid;
  const {pop, close} = openPop('tb-merge-ws');
  _tbMergePop = {pop, close};
  const ver = (m.versions || []).find(x => x.v === m.cur_ver) || {};
  pop.innerHTML = `
  <div class="ui-pop-title">${icon('brain')} AI 合并表：${esc((m.title || '').slice(0, 40))}
    <span class="muted" style="font-size:var(--fs-xs);margin-left:8px" id="tb-merge-ver">v${m.cur_ver}/${m.versions?.length || 1}</span>
    <button class="btn small ic-only" data-x aria-label="关闭">${icon('close')}</button></div>
  <div class="muted" style="font-size:var(--fs-xs);margin-top:6px">${esc(ver.note || m.note || '')} · 指令：${esc(m.instruction.slice(0, 60))}</div>
  <div style="display:flex;gap:6px;align-items:center;margin:8px 0;flex-wrap:wrap">
    <button class="btn small" onclick="tbMergeVer(-1)" title="上一个版本">‹ 上一版</button>
    <button class="btn small" onclick="tbMergeVer(1)" title="下一个版本">下一版 ›</button>
    <span style="width:1px;height:18px;background:var(--border)"></span>
    <button class="btn small" onclick="tbMergeUndo()" title="撤销（Ctrl+Z）">↶ 撤销</button>
    <button class="btn small" onclick="tbMergeRedo()" title="重做（Ctrl+Y）">↷ 重做</button>
    <span style="flex:1"></span>
    <button class="btn small primary" onclick="tbMergeSave()">${icon('check')} 保存编辑</button>
  </div>
  <div class="tb-grid-wrap" style="max-height:50vh"><table class="tbl-md" id="tb-merge-grid" contenteditable="true"></table></div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
    <input id="tb-merge-reinstr" placeholder="改指令重新合成（基于源表，追加新版本）…" style="flex:1;min-width:180px;font-size:var(--fs-sm)"
      onkeydown="if(event.key==='Enter'&&!event.isComposing)tbMergeReinstr()">
    <button class="btn small" onclick="tbMergeReinstr()">${icon('bolt', 12)} 重新合成</button>
    <span style="flex:1"></span>
    <button class="btn small" onclick="tbMergeExport(this)" title="导出本合并表 xlsx（单 sheet）">${icon('download', 12)} 导出</button>
    <button class="btn small danger" onclick="tbMergeDelete(this)">${icon('trash', 12)} 删除</button>
  </div>
  <div class="muted" style="font-size:var(--fs-xs);margin-top:6px">来源表：${(m.source_ids || []).length} 张（${esc((m.source_ids || []).map(sid => (state._tbData?.items || []).find(x => x.id === sid)?.caption || sid).join('；').slice(0, 120))}…）</div>
  <div class="muted" style="font-size:var(--fs-xs);margin-top:2px">单元格直接编辑；撤销/重做与版本回看互不影响；编辑后保存即持久化</div>`;
  tbMergeRenderGrid(m.grid);
  pop.querySelector('[data-x]').onclick = () => { close(); _tbMergePop = null; };
  // 网格编辑入撤销栈（input 防抖快照：首击入栈，连续输入不刷栈）
  let snapTimer = null;
  $('#tb-merge-grid').addEventListener('input', () => {
    if (snapTimer) return;
    snapTimer = setTimeout(() => { snapTimer = null; tbMergeSnap(); }, 800);
  });
  pop.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? tbMergeRedo() : tbMergeUndo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); tbMergeRedo(); }
  });
};

window.tbMergeVer = async dir => {
  const m = window._tbMerge;
  const versions = m.versions || [];
  const cur = versions.findIndex(x => x.v === m.cur_ver);
  const next = versions[cur + dir];
  if (!next) { toast(dir > 0 ? '已是最新版本' : '已是最早版本'); return; }
  const r = await api(`/api/tables/ai-merges/${m.id}/revert`, {method: 'POST', body: JSON.stringify({ver: next.v})});
  window._tbMerge = r.merge;
  window._tbMergeGrid = r.merge.grid;
  $('#tb-merge-ver').textContent = `v${r.merge.cur_ver}/${r.merge.versions.length}`;
  tbMergeRenderGrid(r.merge.grid);
  toast(`已切到 v${next.v}（${next.note || ''}）`, 2500);
};

window.tbMergeReinstr = async () => {
  const inp = $('#tb-merge-reinstr');
  const instruction = (inp?.value || '').trim();
  if (!instruction) { toast('先输入新的合成指令'); return; }
  const go = document.querySelector('.tb-merge-ws button[onclick="tbMergeReinstr()"]');
  go && (go.disabled = true);
  try {
    const r = await api(`/api/tables/ai-merges/${_tbMerge.mid}/regen`, {method: 'POST', body: JSON.stringify({instruction})});
    window._tbMerge = r.merge;
    window._tbMergeGrid = r.merge.grid;
    $('#tb-merge-ver').textContent = `v${r.merge.cur_ver}/${r.merge.versions.length}`;
    tbMergeRenderGrid(r.merge.grid);
    toast(`已合成 v${r.merge.cur_ver}——历史版本可「上一版/下一版」回看`, 3200);
  } catch (e) { toast(friendlyError(e, '重新合成失败')); }
  finally { go && (go.disabled = false); }
};

window.tbMergeExport = async btn => {
  await withBusy(btn, () => downloadBlob(`/api/tables/ai-merges/${_tbMerge.mid}/export`, {}, 'merge.xlsx', '已导出'), '导出失败');
};
window.tbMergeDelete = async btn => {
  if (!(await uiConfirm('删除这张合并表？（源表不受影响）', {title: '删除'}))) return;
  await api(`/api/tables/ai-merges/${_tbMerge.mid}`, {method: 'DELETE'});
  _tbMergePop?.close(); _tbMergePop = null;
  toast('已删除');
};
