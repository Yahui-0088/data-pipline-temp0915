/* 审核进度页：各数据块汇总 → 选中一块看每一片的状态、按范围标记完成、入库。所有人名、意见都是用户输入，一律 esc() 后再放进 HTML。 */
(() => {
  const $ = id => document.getElementById(`rv-${id}`), API = "/api/v1/annotate";
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const ME = window.EMQC_USER || null;
  const S = {summary: null, block: null, data: null, names: {}, plan: null, busy: false};
  const ORDER = ["not_started", "in_progress", "pending", "returned", "fixed", "changed", "approved"];
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
  const compareLink = z => `/annotate/compare?${new URLSearchParams({block: S.block, z})}`;
  const editLink = z => `/annotate?${new URLSearchParams({block: S.block, z})}`;

  // ---------------------------------------------------------------- 汇总
  async function loadSummary() {
    S.summary = await call(`${API}/review/summary`);
    S.names = S.summary.status_names || {};
    const me = S.summary.me;
    $("me").textContent = me ? `${me.name} · ${me.can_decide ? "可以审核" : (me.role === "annotator" ? "标注员" : (me.why_not || "不能审核"))}` : "";
    renderBlocks();
    const want = new URLSearchParams(location.search).get("block");
    const pick = S.summary.blocks.find(b => b.block_id === (S.block || want)) || S.summary.blocks[0];
    if (pick) await selectBlock(pick.block_id, {keepMessages: true});
    else $("blocks").innerHTML = '<div class="card muted">没有可审核的数据块（需要带分割标签的数据块）。</div>';
  }
  function renderBlocks() {
    $("blocks").innerHTML = S.summary.blocks.map(b => {
      if (b.error) return `<div class="rv-block" aria-disabled="true"><b>${esc(b.block_id)}</b><span class="rv-flag">这个数据块的编辑记录读不出来：${esc(b.error)}（请联系管理员）</span></div>`;
      const n = b.nz, c = b.counts;
      const seg = k => c[k] ? `<i data-status="${k}" style="width:${(100 * c[k] / n).toFixed(2)}%" title="${esc(S.names[k])} ${c[k]}"></i>` : "";
      const rel = b.latest_release ? `已入库 v${b.latest_release.version}（${b.latest_release.n_slices} 片）` : "未入库";
      return `<button class="rv-block" data-block="${esc(b.block_id)}" aria-pressed="${b.block_id === S.block}">
        <b>${esc(b.block_id)}</b>
        <span class="rv-bar-track" aria-hidden="true">${["approved", "changed", "pending", "returned", "fixed", "in_progress"].map(seg).join("")}</span>
        <span class="rv-nums">已通过 <b>${c.approved}</b>/${n} · 待审 <b>${c.pending + c.changed}</b> · 退回 <b>${c.returned + c.fixed}</b> · 未完成 <b>${c.not_started + c.in_progress}</b> · ${esc(rel)}</span>
        ${b.todo ? `<span class="rv-flag">我的待办 ${b.todo} 片</span>` : ""}${b.reviewable ? `<span class="rv-flag" style="color:var(--accent-ink)">我能审 ${b.reviewable} 片</span>` : ""}
      </button>`;
    }).join("");
  }
  $("blocks").addEventListener("click", ev => { const b = ev.target.closest(".rv-block"); if (b && b.dataset.block) selectBlock(b.dataset.block); });

  // ---------------------------------------------------------------- 一块的明细
  async function selectBlock(id, {keepMessages = false} = {}) {
    const changed = S.block !== id;
    S.block = id;
    if (changed || !keepMessages) { S.plan = null; $("plan").hidden = true; $("release-result").hidden = true; $("range-result").hidden = true; }
    history.replaceState(null, "", `/annotate/review?${new URLSearchParams({block: id})}`);
    document.querySelectorAll(".rv-block").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.block === id)));
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
    loadReleases().catch(e => { $("release-why").textContent = `版本历史读取失败：${e.message}`; });
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
        <td><span class="rv-chip" data-status="${r.status}">${esc(r.status_name)}</span>${r.unattributed ? `<br><span class="muted" title="这一片有没署名的改动">未署名 ${r.unattributed}</span>` : ""}</td>
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
    if (!confirm(`把 z ${Math.min(lo, hi)}–${Math.max(lo, hi)} ${what}？`)) return;
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

  // ---------------------------------------------------------------- 入库
  const canDecide = () => !!S.summary?.me?.can_decide;
  async function loadReleases() {
    const block = S.block;
    const r = await call(`${API}/blocks/${encodeURIComponent(block)}/releases`);
    if (block !== S.block) return;
    $("release-count").textContent = r.releases.length ? `${r.releases.length} 个版本` : "";
    $("releases").innerHTML = r.releases.map(x => `<tr><td class="mono">v${x.version}</td><td class="mono">${x.n_slices}</td><td>${esc(x.created_by)}</td>
      <td class="mono">${when(x.created_at)}</td><td>${esc(x.note || "")}</td><td class="mono">${esc(x.path)}</td>
      <td class="mono" title="${esc(x.manifest_sha256)}">${esc(x.manifest_sha256.slice(0, 12))}…</td></tr>`).join("")
      || '<tr><td colspan="7" class="muted">还没有入库版本</td></tr>';
    $("preview").disabled = !canDecide();
    $("release-why").textContent = canDecide() ? "" : (S.summary?.me?.why_not || "只有审核员或管理员能入库");
  }
  $("preview").addEventListener("click", async () => {
    const block = S.block; $("preview").disabled = true;
    try {
      const p = await call(`${API}/blocks/${encodeURIComponent(block)}/releases/preview`);
      if (block !== S.block) return;
      S.plan = p;
      $("plan").hidden = false;
      $("plan-summary").innerHTML = p.included.length
        ? `这次会收 <b>${p.included.length}</b> 片：z ${esc(compact(p.included))}。`
        : "现在没有可以入库的切片（需要已通过、且通过后没再改过）。";
      const excl = [...p.excluded.map(x => `z${x.z}：${esc(x.message)}`), ...p.not_approved.map(x => `z${x.z}：${esc(x.message)}`)];
      $("plan-excluded-title").textContent = `不收 ${excl.length} 片（展开看原因）`;
      $("plan-excluded").innerHTML = excl.map(t => `<li>${t}</li>`).join("");
      $("create").disabled = !p.included.length;
    } catch (e) { $("release-result").hidden = false; $("release-result").textContent = `预览失败：${e.message}`; }
    finally { $("preview").disabled = !canDecide(); }
  });
  $("create").addEventListener("click", async () => {
    if (!S.plan?.included?.length) return;
    if (!confirm(`把 ${S.block} 的 ${S.plan.included.length} 片入库，生成一个新的只读版本？`)) return;
    $("create").disabled = true;
    const out = $("release-result"); out.hidden = false; out.textContent = "正在入库…";
    try {
      const r = await call(`${API}/blocks/${encodeURIComponent(S.block)}/releases`, {expect_included: S.plan.included, note: $("note").value.trim() || null});
      out.innerHTML = `已生成 <b>v${r.version}</b>（${r.n_slices} 片），位置：<span class="mono">${esc(r.path)}</span>`;
      $("plan").hidden = true; S.plan = null; $("note").value = "";
      await refresh();
    } catch (e) {
      out.textContent = `入库失败：${e.message}`;
      if (e.code === "stale") $("preview").click();               // 内容和预览时不一样了：重新预览
    } finally { $("create").disabled = false; }
  });
  function compact(zs) {                                          // [0,1,2,5,7,8] → "0–2, 5, 7–8"
    const out = []; let a = null, b = null;
    for (const z of zs) { if (a === null) { a = b = z; } else if (z === b + 1) { b = z; } else { out.push(a === b ? `${a}` : `${a}–${b}`); a = b = z; } }
    if (a !== null) out.push(a === b ? `${a}` : `${a}–${b}`);
    return out.join(", ");
  }

  async function refresh() {
    try { await loadSummary(); }
    catch (e) { $("blocks").innerHTML = `<div class="card">读取失败：${esc(e.message)}</div>`; }
  }
  $("refresh").addEventListener("click", refresh);
  if (ME && ME.role === "annotator") $("mine").checked = true;   // 标注员默认先看退回给自己的
  refresh();
})();
