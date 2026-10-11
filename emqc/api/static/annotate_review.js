/* 审核进度页：各批次（导入目录）汇总 → 选中一批看它的数据块、按批次入库 → 选中一块看每一片的状态、按范围标记完成。
   所有人名、意见、目录名都可能是用户输入，一律 esc() 后再放进 HTML。 */
(() => {
  const $ = id => document.getElementById(`rv-${id}`), API = "/api/v1/annotate";
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const ME = window.EMQC_USER || null;
  const S = {summary: null, batch: null, block: null, data: null, names: {}, plan: null, busy: false};
  const ORDER = ["not_started", "in_progress", "pending", "returned", "fixed", "changed", "approved"];
  const BAR = ["approved", "changed", "pending", "returned", "fixed", "in_progress"];
  const when = iso => {
    if (!iso) return "—";
    const d = new Date(iso), p = n => String(n).padStart(2, "0");
    return isNaN(d) ? iso : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  async function call(url, body) {
    const r = await fetch(url, body ? {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), cache: "no-store"} : {cache: "no-store"});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const d = data.detail, err = new Error(typeof d === "string" ? d : d?.message || `请求失败 (${r.status})`);
      if (d && typeof d === "object") { err.code = d.code; err.info = d; }
      throw err;
    }
    return data;
  }
  const batchURL = id => `${API}/review/batches/${encodeURIComponent(id)}`;
  const compareLink = z => `/annotate/compare?${new URLSearchParams({block: S.block, z})}`;
  const editLink = z => `/annotate?${new URLSearchParams({block: S.block, z})}`;
  function compact(zs) {                                          // [0,1,2,5,7,8] → "0–2, 5, 7–8"
    const out = []; let a = null, b = null;
    for (const z of zs) { if (a === null) { a = b = z; } else if (z === b + 1) { b = z; } else { out.push(a === b ? `${a}` : `${a}–${b}`); a = b = z; } }
    if (a !== null) out.push(a === b ? `${a}` : `${a}–${b}`);
    return out.join(", ");
  }
  // 一张卡片上的进度条和数字：批次卡和数据块卡共用
  function progress(n, c) {
    const seg = k => c[k] ? `<i data-status="${k}" style="width:${(100 * c[k] / n).toFixed(2)}%" title="${esc(S.names[k])} ${c[k]}"></i>` : "";
    return `<span class="rv-bar-track" aria-hidden="true">${n ? BAR.map(seg).join("") : ""}</span>
      <span class="rv-nums">已通过 <b>${c.approved}</b>/${n} · 待审 <b>${c.pending + c.changed}</b> · 退回 <b>${c.returned + c.fixed}</b> · 未完成 <b>${c.not_started + c.in_progress}</b></span>`;
  }
  const flags = x => `${x.todo ? `<span class="rv-flag">我的待办 ${x.todo} 片</span>` : ""}${x.reviewable ? `<span class="rv-flag rv-can">我能审 ${x.reviewable} 片</span>` : ""}`;

  // ---------------------------------------------------------------- 批次汇总
  async function loadSummary() {
    S.summary = await call(`${API}/review/summary`);
    S.names = S.summary.status_names || {};
    const me = S.summary.me;
    $("me").textContent = me ? `${me.name} · ${me.can_decide ? "可以审核" : (me.role === "annotator" ? "标注员" : (me.why_not || "不能审核"))}` : "";
    const dups = S.summary.duplicates || [];
    $("dups").hidden = !dups.length;
    $("dups").innerHTML = dups.length ? `有 ${dups.length} 个数据块同名出现在不止一个目录里，只用了第一个（请管理员改名或移走）：`
      + dups.map(d => `<span class="mono">${esc(d.block_id)}</span>（用 ${esc(d.used)}，忽略 ${d.ignored.map(esc).join("、")}）`).join("；") : "";
    renderBatches();
    const q = new URLSearchParams(location.search), wantBlock = S.block || q.get("block");
    const owner = S.summary.blocks.find(b => b.block_id === wantBlock)?.batch_id;
    const pick = S.summary.batches.find(g => g.batch_id === (S.batch ?? q.get("batch") ?? owner)) || S.summary.batches[0];
    if (pick) await selectBatch(pick.batch_id, {keepMessages: true, block: wantBlock});
    else { $("batches").innerHTML = '<div class="card muted">没有可审核的数据块（需要带分割标签的数据块）。</div>'; $("batch").hidden = true; }
  }
  function renderBatches() {
    $("batches").innerHTML = S.summary.batches.map(g => {
      const rel = g.latest_release ? `已入库 v${g.latest_release.version}（${g.latest_release.n_blocks} 块 ${g.latest_release.n_slices} 片）` : "未入库";
      return `<button class="rv-block rv-batchcard" data-batch="${esc(g.batch_id)}" aria-pressed="${g.batch_id === S.batch}">
        <b>${esc(g.batch_id || "（目录不明）")}</b>
        <span class="rv-nums">${g.blocks.length} 个数据块 · ${g.nz} 片 · ${esc(rel)}</span>
        ${progress(g.nz, g.counts)}
        ${g.n_errors ? `<span class="rv-flag">${g.n_errors} 个数据块读不出来</span>` : ""}${g.ambiguous_dirs.length ? '<span class="rv-flag">有同名的导入目录，不能入库</span>' : ""}${flags(g)}
      </button>`;
    }).join("");
  }
  $("batches").addEventListener("click", ev => { const b = ev.target.closest(".rv-batchcard"); if (b) selectBatch(b.dataset.batch); });

  async function selectBatch(id, {keepMessages = false, block = null} = {}) {
    const changed = S.batch !== id;
    S.batch = id;
    if (changed || !keepMessages) { S.plan = null; $("plan").hidden = true; $("release-result").hidden = true; }
    if (changed) {                                                // 别让上一批的版本历史挂在这一批的标题下面
      $("release-count").textContent = "";
      $("releases").innerHTML = '<tr><td colspan="8" class="muted">加载中…</td></tr>';
    }
    document.querySelectorAll(".rv-batchcard").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.batch === id)));
    const g = S.summary.batches.find(x => x.batch_id === id);
    $("batch").hidden = false;
    $("batch-title").textContent = `${id} · ${g.blocks.length} 个数据块`;
    $("release-title").textContent = id;
    $("batch-warn").hidden = !g.ambiguous_dirs.length;
    $("batch-warn").textContent = g.ambiguous_dirs.length ? `这个批次名对应了 ${g.ambiguous_dirs.length} 个目录，分不清是哪一批，暂时不能入库：${g.ambiguous_dirs.join("；")}` : "";
    const mine = S.summary.blocks.filter(b => b.batch_id === id);
    renderBlocks(mine);
    loadReleases().catch(e => { $("release-why").textContent = `版本历史读取失败：${e.message}`; });
    const pick = mine.find(b => b.block_id === (block || S.block) && !b.error) || mine.find(b => !b.error);
    if (pick) await selectBlock(pick.block_id, {keepMessages});
    else { S.block = null; S.data = null; $("detail").hidden = true; setURL(); }
  }
  function renderBlocks(list) {
    $("blocks").innerHTML = list.map(b => {
      if (b.error) return `<div class="rv-block" aria-disabled="true"><b>${esc(b.block_id)}</b><span class="rv-flag">${esc(b.error)}（请联系管理员）</span></div>`;
      return `<button class="rv-block" data-block="${esc(b.block_id)}" aria-pressed="${b.block_id === S.block}">
        <b>${esc(b.block_id)}</b>${progress(b.nz, b.counts)}${flags(b)}
      </button>`;
    }).join("");
  }
  $("blocks").addEventListener("click", ev => { const b = ev.target.closest(".rv-block"); if (b && b.dataset.block) selectBlock(b.dataset.block); });
  const setURL = () => history.replaceState(null, "", `/annotate/review?${new URLSearchParams(S.block ? {batch: S.batch, block: S.block} : {batch: S.batch})}`);

  // ---------------------------------------------------------------- 一块的明细
  async function selectBlock(id, {keepMessages = false} = {}) {
    const changed = S.block !== id;
    S.block = id;
    if (changed || !keepMessages) $("range-result").hidden = true;
    setURL();
    document.querySelectorAll("#rv-blocks .rv-block").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.block === id)));
    $("detail").hidden = false;
    $("detail-title").textContent = id;
    if (changed) $("rows").innerHTML = '<tr><td colspan="9" class="muted">加载中…</td></tr>';
    let data;
    try { data = await call(`${API}/blocks/${encodeURIComponent(id)}/review`); }
    catch (e) {
      if (S.block === id) $("rows").innerHTML = `<tr><td colspan="9">读取失败：${esc(e.message)}（点「刷新」重试）</td></tr>`;
      return;
    }
    if (S.block !== id) return;                                   // 结果到的时候已经换了别的块：丢掉
    const first = !S.data || S.data.block_id !== id;
    S.data = data;
    $("from").max = $("to").max = data.nz - 1;
    if (first) { $("from").value = 0; $("to").value = data.nz - 1; }   // 只在换块时给默认范围，别把用户填的值改掉
    renderDetail();
  }
  function renderDetail() {
    const d = S.data; if (!d) return;
    $("grid").innerHTML = d.slices.map(r => `<a role="listitem" href="${compareLink(r.z)}" data-status="${r.status}" class="${r.todo ? "rv-mine" : ""}"
      title="z ${r.z} · ${esc(r.status_name)}${r.last_comment ? ` · ${esc(r.last_comment)}` : ""}">${r.z}</a>`).join("");
    $("legend").innerHTML = ORDER.map(k => `<span><i data-status="${k}"></i>${esc(S.names[k] || k)} ${d.counts[k] || 0}</span>`).join("")
      + '<span><i style="box-shadow:inset 0 0 0 2px var(--high)"></i>我的待办</span>';
    const sel = $("filter"), cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>' + ORDER.map(k => `<option value="${k}">${esc(S.names[k] || k)}（${d.counts[k] || 0}）</option>`).join("");
    sel.value = cur;
    renderRows();
  }
  function renderRows() {
    const d = S.data; if (!d) return;
    const f = $("filter").value, mine = $("mine").checked, reviewable = $("reviewable").checked;
    const rows = d.slices.filter(r => (!f || r.status === f) && (!mine || r.todo) && (!reviewable || r.reviewable));
    $("shown").textContent = `显示 ${rows.length} / ${d.nz} 片`;
    $("rows").innerHTML = rows.map(r => {
      const editors = Object.entries(r.editors).map(([k, n]) => `${esc(k)}×${n}`).join("、") || '<span class="muted">—</span>';
      const done = r.completed_by ? `${esc(r.completed_by)}<br><span class="muted">${when(r.completed_at)}</span>` : '<span class="muted">—</span>';
      const decided = r.decided_by ? `${esc(r.decided_by)}<br><span class="muted">${when(r.decided_at)}</span>` : '<span class="muted">—</span>';
      const links = [`<a href="${compareLink(r.z)}">${r.reviewable ? "去审核" : "看对比"}</a>`];
      if (r.status === "returned" || r.status === "fixed" || r.status === "in_progress" || r.status === "not_started") links.push(`<a href="${editLink(r.z)}">去修改</a>`);
      return `<tr class="${r.todo ? "rv-todo" : ""}"><td class="mono">${r.z}</td>
        <td><span class="rv-chip" data-status="${r.status}">${esc(r.status_name)}</span>${r.unattributed ? `<br><span class="muted" title="这一片有没署名的改动">未署名 ${r.unattributed}</span>` : ""}${r.history_error ? `<br><span class="rv-flag">${esc(r.history_error)}</span>` : ""}</td>
        <td>${editors}</td><td class="mono">${when(r.last_edit)}</td><td>${done}</td><td>${decided}</td>
        <td class="rv-comment">${r.last_comment ? esc(r.last_comment) : '<span class="muted">—</span>'}</td>
        <td class="mono">${r.open_marks || ""}</td><td class="rv-links">${links.join("")}</td></tr>`;
    }).join("") || '<tr><td colspan="9" class="muted">没有符合条件的切片</td></tr>';
  }
  for (const id of ["filter", "mine", "reviewable"]) $(id).addEventListener("change", renderRows);

  // ---------------------------------------------------------------- 按范围标记完成 / 撤回
  let rangeAction = "complete";
  $("range-form").querySelectorAll("button[data-action]").forEach(b => b.addEventListener("click", () => { rangeAction = b.dataset.action; }));
  $("range-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (S.busy || !S.block) return;
    const lo = +$("from").value, hi = +$("to").value;
    const what = rangeAction === "complete" ? "标记完成" : "撤回完成";
    if (!confirm(`把 ${S.block} 的 z ${Math.min(lo, hi)}–${Math.max(lo, hi)} ${what}？`)) return;
    S.busy = true;
    const out = $("range-result"); out.hidden = false; out.textContent = `正在${what}…`;
    try {
      const r = await call(`${API}/blocks/${encodeURIComponent(S.block)}/review-range`, {action: rangeAction, z_from: lo, z_to: hi});
      const skipped = r.skipped.length ? `；跳过 ${r.skipped.length} 片：${r.skipped.slice(0, 6).map(s => `z${s.z} ${esc(s.reason)}`).join("；")}${r.skipped.length > 6 ? " …" : ""}` : "";
      out.innerHTML = `已${what} ${r.done.length} 片${skipped}`;
      await refresh();
    } catch (e) { out.textContent = `${what}失败：${e.message}`; }
    finally { S.busy = false; }
  });

  // ---------------------------------------------------------------- 按批次入库
  const canDecide = () => !!S.summary?.me?.can_decide;
  async function loadReleases() {
    const batch = S.batch;
    const r = await call(`${batchURL(batch)}/releases`);
    if (batch !== S.batch) return;
    $("release-count").textContent = r.releases.length ? `${r.releases.length} 个版本` : "";
    $("releases").innerHTML = r.releases.map(x => `<tr><td class="mono">v${x.version}</td>
      <td class="mono" title="${esc(x.blocks.map(b => `${b.block_id}：${b.n_slices} 片`).join("\n"))}">${x.n_blocks}</td><td class="mono">${x.n_slices}</td>
      <td>${esc(x.created_by)}</td><td class="mono">${when(x.created_at)}</td><td>${esc(x.note || "")}</td><td class="mono">${esc(x.path)}</td>
      <td class="mono" title="${esc(x.manifest_sha256)}">${esc(x.manifest_sha256.slice(0, 12))}…</td></tr>`).join("")
      || '<tr><td colspan="8" class="muted">这一批还没有入库版本</td></tr>';
    gateRelease();
  }
  function gateRelease() {                                        // 能不能点「预览这次入库」，不能就说原因
    const blocked = !!(S.summary?.batches.find(g => g.batch_id === S.batch)?.ambiguous_dirs || []).length;
    $("preview").disabled = !canDecide() || blocked;
    $("release-why").textContent = !canDecide() ? (S.summary?.me?.why_not || "只有审核员或管理员能入库") : blocked ? "批次名对应了不止一个目录，暂时不能入库（见上方提示）" : "";
  }
  $("preview").addEventListener("click", async () => {
    const batch = S.batch; $("preview").disabled = true;
    try {
      const p = await call(`${batchURL(batch)}/releases/preview`);
      if (batch !== S.batch) return;
      S.plan = p;
      $("plan").hidden = false;
      $("plan-summary").innerHTML = p.n_slices
        ? `这次会收批次 <b>${esc(batch)}</b> 里 <b>${p.n_blocks}</b> 个数据块的 <b>${p.n_slices}</b> 片。`
        : "这一批现在没有可以入库的切片（需要已通过、且通过后没再改过）。";
      const broken = p.skipped.filter(x => x.reason !== "none_approved");
      $("plan-blocks").innerHTML = p.blocks.map(b => `<tr><td class="mono">${esc(b.block_id)}</td>
        <td>${b.included.length ? `${b.included.length} 片：z ${esc(compact(b.included))}` : '<span class="muted">不收（没有可入库的切片）</span>'}</td>
        <td class="mono">${b.excluded.length + b.not_approved.length}</td></tr>`).join("")
        + broken.map(x => `<tr><td class="mono">${esc(x.block_id)}</td><td colspan="2"><span class="rv-flag">不收：${esc(x.message)}</span></td></tr>`).join("");
      // 不收的切片按原因归并：「未开始：z 3–99」而不是一百行
      const lines = p.blocks.flatMap(b => {
        const by = {};
        for (const x of [...b.excluded, ...b.not_approved]) (by[x.message] ||= []).push(x.z);
        return Object.entries(by).map(([why, zs]) => `<li><span class="mono">${esc(b.block_id)}</span>　${esc(why)}：z ${esc(compact(zs.sort((a, c) => a - c)))}</li>`);
      });
      const nEx = p.blocks.reduce((n, b) => n + b.excluded.length + b.not_approved.length, 0);
      $("plan-excluded-wrap").hidden = !nEx;
      $("plan-excluded-title").textContent = `不收的 ${nEx} 片（展开看原因）`;
      $("plan-excluded").innerHTML = lines.join("");
      $("create").disabled = !p.n_slices;
    } catch (e) { $("release-result").hidden = false; $("release-result").textContent = `预览失败：${e.message}`; }
    finally { gateRelease(); }
  });
  $("create").addEventListener("click", async () => {
    const plan = S.plan, batch = S.batch;
    if (!plan?.n_slices || plan.batch_id !== batch) return;
    if (!confirm(`把批次 ${batch} 里 ${plan.n_blocks} 个数据块、共 ${plan.n_slices} 片入库，生成一个新的只读版本？`)) return;
    $("create").disabled = true;
    const out = $("release-result"); out.hidden = false; out.textContent = "正在入库（一块一块地写，大批次要等一会儿）…";
    try {
      const r = await call(`${batchURL(batch)}/releases`, {expect_included: plan.expect_included, note: $("note").value.trim() || null});
      out.innerHTML = `已生成批次 ${esc(batch)} 的 <b>v${r.version}</b>（${r.n_blocks} 个数据块、${r.n_slices} 片），位置：<span class="mono">${esc(r.path)}</span>`;
      $("plan").hidden = true; S.plan = null; $("note").value = "";
      await refresh();
    } catch (e) {
      out.textContent = `入库失败：${e.message}`;
      if (e.code === "stale") $("preview").click();               // 内容和预览时不一样了：重新预览
    } finally { $("create").disabled = false; }
  });

  async function refresh() {
    try { await loadSummary(); }
    catch (e) { $("batches").innerHTML = `<div class="card">读取失败：${esc(e.message)}</div>`; }
  }
  $("refresh").addEventListener("click", refresh);
  if (ME && ME.role === "annotator") $("mine").checked = true;   // 标注员默认先看退回给自己的
  refresh();
})();
