/* 「批次 → 数据块」两级选择，工作台和前后对比页共用。
   批次 = 数据块所在的导入目录（和审核进度页、入库同一个名字）。数据块下拉只列当前批次的块；同一个原始块切出来的
   几块（<原始块>_yYYYY_xXXXX）归在一组里，组名是原始块，选项只写 yYYYY_xXXXX，完整名字在悬停提示里。
   别处要跳到某个块（下一张待审、标记链接、?block= 链接）都走 show(id)：先切到它所在的批次再选中它，不会出现
   下拉框里没有、页面却显示着的块。 */
window.EMQCBlockPicker = (() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TILE = /^(.+)_(y\d{4}_x\d{4})$/;
  const parts = id => { const m = TILE.exec(id); return m ? { parent: m[1], tile: m[2] } : { parent: null, tile: id }; };

  /* batchSel / blockSel：两个 <select>；blocks：接口给的块列表（已按 批次, 块 排序，每项有 batch_id）；
     note(b)：选项名字后面附加的说明（如「· 3 改动」）；onPick(id)：用户在下拉框里选了某个块。 */
  function create({ batchSel, blockSel, blocks, note = () => "", onPick }) {
    const byBatch = new Map();
    for (const b of blocks) {
      if (!byBatch.has(b.batch_id)) byBatch.set(b.batch_id, []);
      byBatch.get(b.batch_id).push(b);
    }
    const batchOf = new Map(blocks.map(b => [b.block_id, b.batch_id]));
    const last = new Map();                       // 每个批次最后看的块：切回这一批时回到它
    // 一块都读不出来的批次选了也打不开：灰掉，免得选了之后两个下拉框和正在看的块对不上
    batchSel.innerHTML = [...byBatch].map(([bt, list]) => {
      const dead = list.every(b => b.error);
      return `<option value="${esc(bt)}"${dead ? " disabled" : ""}>${esc(bt || "（目录不明）")}（${list.length} 块${dead ? " · 无法读取" : ""}）</option>`;
    }).join("");

    function fill(batch) {
      const list = byBatch.get(batch) || [], html = [];
      for (let i = 0; i < list.length;) {
        const p = parts(list[i].block_id).parent;
        let j = i + 1;
        while (p && j < list.length && parts(list[j].block_id).parent === p) j++;
        const opts = list.slice(i, j).map(b => {
          const label = j - i > 1 ? parts(b.block_id).tile : b.block_id;
          return `<option value="${esc(b.block_id)}" title="${esc(b.block_id)}"${b.error ? " disabled" : ""}>${esc(label)}${esc(note(b))}</option>`;
        }).join("");
        html.push(j - i > 1 ? `<optgroup label="${esc(p)}">${opts}</optgroup>` : opts);
        i = j;
      }
      blockSel.innerHTML = html.join("");
    }
    // 让两个下拉框显示这个块（不触发加载）。不认识的块返回 false
    function show(id) {
      if (!batchOf.has(id)) return false;
      const bt = batchOf.get(id);
      if (batchSel.value !== bt || ![...blockSel.options].some(o => o.value === id)) { batchSel.value = bt; fill(bt); }
      blockSel.value = id;
      last.set(bt, id);
      return true;
    }
    batchSel.addEventListener("change", () => {
      const bt = batchSel.value, list = byBatch.get(bt) || [];
      fill(bt);
      const prev = last.get(bt);
      const want = prev && list.some(b => b.block_id === prev && !b.error) ? prev : list.find(b => !b.error)?.block_id;
      if (want) { blockSel.value = want; last.set(bt, want); onPick(want); }
    });
    blockSel.addEventListener("change", () => { last.set(batchSel.value, blockSel.value); onPick(blockSel.value); });
    const first = blocks.find(b => !b.error)?.batch_id ?? blocks[0]?.batch_id;
    if (first !== undefined) { batchSel.value = first; fill(first); }
    return { show, has: id => batchOf.has(id), batchOf: id => batchOf.get(id) };
  }
  return { create, parts };
})();
