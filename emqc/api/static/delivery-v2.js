// 新版交付页（delivery_v2.html）。所有可视化都绑定真实数据，不写任何示例数据：
//   01 训练分片：每张切片交付与否 / 原因 / 分片 —— GET /api/v1/exports/preview（和导出用的是同一个 plan_block，规则与后端一致）
//              每张切片的综合分 —— GET /api/v1/qc/runs/{id}/profile
//              资产轨道 —— GET /api/v1/data/{ds}/assets/{type}/zs 和 …/preview/z/{z}.png（没有文件的位置显示缺失，不生成）
//              导出 —— POST /api/v1/exports，进度只看 GET /api/v1/exports/{id} 和 /events
//   02 推理流：子块划分按后端 build_plan 的规则（每个 block 按 z_chunk 切，跳过含未通过切片的子块）；
//              有会话时窗口只跟着 GET /api/v1/streams/{id}/map 里的真实状态走
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const mb = (b) => (b == null ? "–" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  const pad5 = (n) => String(n).padStart(5, "0");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.append(e); return e; };
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const getJSON = async (url, opt) => {
    const r = await fetch(url, { priority: "high", ...opt });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(typeof d.detail === "string" ? d.detail : Array.isArray(d.detail) ? d.detail.map((x) => x.msg).join("；") : `HTTP ${r.status}`), { status: r.status });
    return d;
  };
  const tileOf = (bid) => (bid && bid.includes("_") ? bid.slice(bid.indexOf("_") + 1) : bid || "");
  const texUrl = (ds, z) => `/api/v1/data/${encodeURIComponent(ds)}/preview/z/${z}.png`;
  const assetUrl = (ds, a, z) => `/api/v1/data/${encodeURIComponent(ds)}/assets/${encodeURIComponent(a)}/preview/z/${z}.png`;
  const CODE_ZH = { K: "交付", Q: "未通过 QC", L: "综合分低于下限", S: "连续段不足 min_run", M: "没有 QC 记录" };
  let ASSETS = {};
  try { ASSETS = JSON.parse($("dl-assets").textContent || "{}"); } catch {}
  const tip = $("dl-tip");

  // 展开 / 收起「怎么读」
  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const d = $(b.dataset.toggle); d.open = !d.open; b.setAttribute("aria-expanded", String(d.open));
    b.textContent = b.textContent.replace(/[›‹]$/, d.open ? "‹" : "›");
  }));

  const profiles = new Map();
  const profileOf = (runId) => {
    if (!runId) return Promise.resolve(null);
    if (!profiles.has(runId)) profiles.set(runId, getJSON(`/api/v1/qc/runs/${runId}/profile`).catch(() => null));
    return profiles.get(runId);
  };
  const assetZs = new Map();
  const assetZsOf = (ds, a) => {
    const k = `${ds}|${a}`;
    if (!assetZs.has(k)) assetZs.set(k, getJSON(`/api/v1/data/${encodeURIComponent(ds)}/assets/${encodeURIComponent(a)}/zs`).then((d) => new Set(d.zs)).catch(() => null));
    return assetZs.get(k);
  };

  // ==================================================================================== 01 训练分片
  const exForm = $("ex-form");
  const EX = { pv: null, prof: null, col: null, tile: null, ds: null, view: null, els: new Map(), assetEls: new Map(), job: null, jobBlocks: new Map(), lastEvt: 0, poll: 0, drawn: false };

  function exParams() {
    const f = new FormData(exForm), errs = [];
    const num = (name, lo, hi, int) => {
      const raw = String(f.get(name) ?? "").trim(), inp = exForm.elements[name];
      if (raw === "") { inp.removeAttribute("aria-invalid"); return null; }
      const v = Number(raw), bad = !Number.isFinite(v) || v < lo || (hi != null && v > hi) || (int && !Number.isInteger(v));
      inp.toggleAttribute("aria-invalid", bad);
      if (bad) errs.push(`${name} 要是 ${lo}${hi != null ? `–${hi}` : " 以上"}${int ? " 的整数" : " 之间的数"}`);
      return bad ? null : v;
    };
    const min_run = num("min_run", 1, null, true), shard_z = num("shard_z", 0, null, true), min_quality = num("min_quality", 0, 1, false);
    if (min_run == null && !errs.some((e) => e.startsWith("min_run"))) errs.push("min_run 不能空");
    if (shard_z == null && !errs.some((e) => e.startsWith("shard_z"))) errs.push("shard_z 不能空");
    return {
      ok: !errs.length, errs, dataset_id: f.get("dataset_id"), min_run: min_run ?? 1, shard_z: shard_z ?? 0, min_quality,
      block_ids: String(f.get("block_ids") || "").split(",").map((x) => x.trim()).filter(Boolean),
      with_assets: [...exForm.querySelectorAll('input[name="asset"]:checked')].map((x) => x.value),
      resume: !!document.querySelector('input[name="resume"]').checked,
    };
  }
  function showErr(id, errs) { const e = $(id); e.hidden = !errs.length; e.textContent = errs.join("；"); }

  function renderAssetChoices(ds) {
    const box = $("ex-assets"); box.replaceChildren();
    const list = ASSETS[ds] || [];
    box.append(h("span", "dl-assets-lab", "一并拷贝的资产"));
    if (!list.length) { box.append(h("span", "dl-assets-none", "这个数据集没有登记可拷贝的资产")); return; }
    for (const a of list) {
      const l = h("label", "dl-chip"); const i = document.createElement("input");
      i.type = "checkbox"; i.name = "asset"; i.value = a;
      l.append(i, h("span", null, a)); box.append(l);
    }
  }

  let exTimer = 0, exSeq = 0;
  const exSchedule = (ms = 200) => { clearTimeout(exTimer); exTimer = setTimeout(exLoad, ms); };
  async function exLoad() {
    const p = exParams(); showErr("ex-err", p.errs);
    if (!p.ok) return;
    const seq = ++exSeq;
    const qs = new URLSearchParams({ dataset_id: p.dataset_id, min_run: p.min_run, shard_z: p.shard_z });
    if (p.min_quality != null) qs.set("min_quality", p.min_quality);
    if (p.block_ids.length) qs.set("block_ids", p.block_ids.join(","));
    $("ex-viz").setAttribute("aria-busy", "true");
    let pv;
    try { pv = await getJSON(`/api/v1/exports/preview?${qs}`); }
    catch (e) { if (seq === exSeq) { showErr("ex-err", [`预览没取到：${e.message}`]); $("ex-viz").removeAttribute("aria-busy"); } return; }
    const prof = await profileOf(pv.run_id);
    await Promise.all(p.with_assets.map((a) => assetZsOf(p.dataset_id, a)));
    if (seq !== exSeq) return;
    $("ex-viz").removeAttribute("aria-busy");
    const dsChanged = EX.ds !== p.dataset_id;
    EX.ds = p.dataset_id; EX.pv = pv; EX.p = p;
    EX.prof = new Map((prof || []).map((r) => [`${r.block_id}|${r.z}`, r]));
    pickTile(dsChanged);
    renderExport(dsChanged);
  }

  // ---- 一列 = 同一个 xy tile 在各个 z 段上的 block；连续段只在一个 block 里算，不跨 block
  function pickTile(reset) {
    const sel = $("ex-tile"), blocks = EX.pv.blocks || [];
    const tiles = new Map();
    for (const b of blocks) { const t = tileOf(b.block_id); tiles.set(t, (tiles.get(t) || 0) + b.n_keep); }
    const keep = !reset && tiles.has(EX.tile) ? EX.tile : [...tiles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    sel.replaceChildren(...[...tiles.entries()].map(([t, n]) => new Option(`${t}（交付 ${n} 张）`, t)));
    if (keep != null) sel.value = keep;
    sel.closest("label").hidden = tiles.size <= 1;
    if (keep !== EX.tile) EX.view = null;
    EX.tile = keep;
  }
  function buildColumn() {
    const blocks = (EX.pv.blocks || []).filter((b) => tileOf(b.block_id) === EX.tile).sort((a, b) => a.z_start - b.z_start);
    if (!blocks.length) return null;
    const zA = blocks[0].z_start, zB = blocks[blocks.length - 1].z_end;
    const cells = new Map(), runs = [], shards = [];
    for (const b of blocks) {
      for (let i = 0; i < b.codes.length; i++) {
        const z = b.z_start + i, r = EX.prof.get(`${b.block_id}|${z}`);
        cells.set(z, { z, block: b.block_id, code: b.codes[i], q: r ? (r.status !== "ok" ? 0 : r.quality_score) : null });
      }
      // 连续合格段 = 通过 QC 且分数够（K 或 S）的连续切片；整段都是 S 说明短于 min_run
      let s = null;
      for (let z = b.z_start; z <= b.z_end; z++) {
        const c = z < b.z_end ? b.codes[z - b.z_start] : null, ok = c === "K" || c === "S";
        if (ok && s == null) s = z;
        if (!ok && s != null) { runs.push({ a: s, b: z, block: b.block_id, short: b.codes[s - b.z_start] === "S" }); s = null; }
      }
      for (const [a, e] of b.shards || []) shards.push({ a, b: e, block: b.block_id });
    }
    return { blocks, zA, zB, cells, runs, shards };
  }

  // ---- 视图：缩放 / 平移（只渲染看得见的；太密时抽样）
  const viewW = () => Math.max(200, $("ex-track").clientWidth);
  function fitView() { EX.view = { a: EX.col.zA, b: EX.col.zB }; }
  function setView(a, b) {
    const { zA, zB } = EX.col, minN = Math.min(12, zB - zA);
    const n = clamp(b - a, minN, zB - zA);
    a = clamp(a, zA, zB - n); EX.view = { a, b: a + n };
    renderViz();
  }
  function zoomAt(f, centerZ) {
    const { a, b } = EX.view, n = b - a, c = centerZ ?? (a + b) / 2, nn = n / f, na = c - ((c - a) / n) * nn;
    setView(na, na + nn);
  }

  function renderExport(reset) {
    const empty = $("ex-empty");
    EX.col = EX.tile != null ? buildColumn() : null;
    if (!EX.col) {
      empty.hidden = false; empty.textContent = (EX.pv.blocks || []).length ? "没有符合 block 筛选的切片。" : "这个数据集还没有 QC 结果，先在总览页跑一次。";
      for (const id of ["ex-curve", "ex-track", "ex-asset-tracks", "ex-axis"]) $(id).replaceChildren();
      EX.els.clear(); EX.assetEls.clear();
      renderFiles(); return;
    }
    empty.hidden = true;
    if (!EX.view || reset) fitView();
    renderViz();
    renderFiles();
    const pv = EX.pv;
    $("ex-reasons").textContent = `交付 ${pv.n_keep} / ${pv.n_sections} 张（${(pv.retention * 100).toFixed(1)}%）· ` +
      (pv.reasons || []).filter((r) => r.code !== "K" && r.n).map((r) => `${r.zh} ${r.n}`).join(" · ");
    EX.drawn = true;
  }

  function renderViz() {
    const { col, view, p } = EX, W = viewW(), n = view.b - view.a, slot = W / n;
    const step = Math.max(1, Math.ceil(5 / slot));                    // 每张至少 5px，再密就抽样
    const X = (z) => (z - view.a + 0.5) * slot;
    const zsIn = []; for (let z = Math.ceil(view.a); z < view.b; z++) zsIn.push(z);
    const sampled = zsIn.filter((z) => (z - col.zA) % step === 0);
    const sw = clamp(slot * step * 1.7, 5, 30);
    const texStep = Math.max(1, Math.ceil(sampled.length / 36));
    EX.geom = { X, slot, step, W };

    // ---------- 综合分曲线 + 可拖动的最低综合分
    const ch = $("ex-curve"); ch.replaceChildren();
    const H = 104, T = 12, B = 10, y = (v) => T + (H - T - B) * (1 - clamp(v, 0, 1));
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "dl-qsvg" }, ch);
    for (const v of [0, 0.5, 1]) { svgEl("line", { x1: 0, x2: W, y1: y(v), y2: y(v), class: "dl-qgrid" }, svg); svgEl("text", { x: 2, y: y(v) - 3, class: "dl-qax" }, svg).textContent = v.toFixed(1); }
    for (const b of col.blocks.slice(1)) if (b.z_start > view.a && b.z_start < view.b) svgEl("line", { x1: X(b.z_start) - slot / 2, x2: X(b.z_start) - slot / 2, y1: 0, y2: H, class: "dl-qsep" }, svg);
    let d = "", pen = false;
    for (const z of zsIn) { const c = col.cells.get(z); if (!c || c.q == null) { pen = false; continue; } d += `${pen ? "L" : "M"}${X(z).toFixed(1)} ${y(c.q).toFixed(1)}`; pen = true; }
    if (d) svgEl("path", { d, class: "dl-qline" }, svg);
    else svgEl("text", { x: W / 2, y: H / 2, class: "dl-qax", "text-anchor": "middle" }, svg).textContent = "这次运行没有逐张的综合分";
    for (const z of zsIn) {
      const c = col.cells.get(z); if (!c || c.q == null) continue;
      const low = p.min_quality != null && c.q < p.min_quality;
      if (low || slot >= 7) svgEl("circle", { cx: X(z), cy: y(c.q), r: low ? 2.6 : 1.6, class: low ? "dl-qlow" : "dl-qdot", "data-z": z }, svg);
    }
    const thr = svgEl("g", { class: `dl-thr${p.min_quality == null ? " is-off" : ""}`, tabindex: "0", role: "slider", "aria-label": "最低综合分", "aria-valuemin": "0", "aria-valuemax": "1", "aria-valuenow": p.min_quality ?? "" }, svg);
    const ty = y(p.min_quality ?? 0.8);
    svgEl("line", { x1: 0, x2: W, y1: ty, y2: ty, class: "dl-thr-line" }, thr);
    svgEl("rect", { x: 0, y: ty - 9, width: W, height: 18, class: "dl-thr-hit" }, thr);
    const tl = svgEl("g", { class: "dl-thr-tag", transform: `translate(${W - 4}, ${ty})` }, thr);
    svgEl("rect", { x: -112, y: -11, width: 112, height: 22, rx: 11 }, tl);
    svgEl("text", { x: -56, y: 4, "text-anchor": "middle" }, tl).textContent = p.min_quality == null ? "拖动设最低综合分" : `最低综合分 ${p.min_quality.toFixed(2)}`;
    const setQ = (clientY) => {
      const r = svg.getBoundingClientRect(), v = Math.round(clamp(1 - (clientY - r.top - T) / (H - T - B), 0, 1) * 100) / 100;
      exForm.elements.min_quality.value = v.toFixed(2);
      EX.p.min_quality = v; renderViz(); exSchedule(160);
    };
    thr.addEventListener("pointerdown", (e) => {
      e.preventDefault(); thr.setPointerCapture(e.pointerId); setQ(e.clientY);
      const mv = (ev) => setQ(ev.clientY), up = () => { thr.removeEventListener("pointermove", mv); thr.removeEventListener("pointerup", up); };
      thr.addEventListener("pointermove", mv); thr.addEventListener("pointerup", up);
    });
    thr.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const v = clamp((EX.p.min_quality ?? 0.8) + (e.key === "ArrowUp" ? 0.01 : -0.01), 0, 1);
      exForm.elements.min_quality.value = v.toFixed(2); EX.p.min_quality = v; renderViz(); exSchedule(200);
      requestAnimationFrame(() => document.querySelector(".dl-thr")?.focus());
    });

    // ---------- 切片轨道：只渲染看得见的；同一个 z 的元素复用，状态变化用 CSS 过渡
    const track = $("ex-track");
    let ov = track.querySelector(".dl-track-svg");
    if (!ov) { ov = svgEl("svg", { class: "dl-track-svg" }); track.append(ov); }
    ov.setAttribute("width", W); ov.setAttribute("height", 150); ov.replaceChildren();
    const keepZ = new Set(sampled);
    for (const [z, el] of EX.els) if (!keepZ.has(z)) { el.remove(); EX.els.delete(z); }
    sampled.forEach((z, i) => {
      const c = col.cells.get(z);
      let el = EX.els.get(z);
      if (!el) {
        el = h("i", "dt-sl"); el.dataset.z = z;
        if (!reduce && !EX.drawn) el.style.animationDelay = `${Math.min(i, 60) * 14}ms`;
        track.append(el); EX.els.set(z, el);
      }
      const low = c && p.min_quality != null && c.q != null && c.q < p.min_quality;
      el.className = `dt-sl is-${(c?.code || "M").toLowerCase()}${low ? " is-low" : ""}${EX.drawn ? "" : " is-enter"}`;
      el.style.left = `${X(z) - sw / 2}px`; el.style.width = `${sw}px`;
      // 纹理：一屏最多取 ~36 张不同的缩略图（相邻几片共用一张），免得一次压上几百个请求把接口排队卡住
      const tz = sampled[i - (i % texStep)];
      if (sw >= 8) el.style.setProperty("--tex", `url("${texUrl(EX.ds, tz)}")`); else el.style.removeProperty("--tex");
    });
    // block 边界和名称
    for (const b of col.blocks) {
      if (b.z_end <= view.a || b.z_start >= view.b) continue;
      const x0 = Math.max(0, X(b.z_start) - slot / 2);
      if (b.z_start > view.a) svgEl("line", { x1: x0, x2: x0, y1: 26, y2: 146, class: "dl-bsep" }, ov);
      svgEl("text", { x: x0 + 4, y: 146, class: "dl-blab" }, ov).textContent = `z${pad5(b.z_start)}–${pad5(b.z_end - 1)}`;
    }
    // 连续合格段的括号：够长的淡紫（会交付），不够 min_run 的变暗（悬停看原因）；交付段里按真实分片画分隔
    const widest = col.runs.filter((r) => !r.short).sort((u, v) => (v.b - v.a) - (u.b - u.a))[0];
    for (const r of col.runs) {
      if (r.b <= view.a || r.a >= view.b) continue;
      const x0 = X(r.a) - slot / 2 + 1, x1 = X(r.b - 1) + slot / 2 - 1;
      const g = svgEl("g", { class: `dl-run${r.short ? " is-short" : ""}` }, ov);
      svgEl("path", { d: `M${x0} 22 V14 H${x1} V22` }, g);
      svgEl("title", {}, g).textContent = r.short ? `连续 ${r.b - r.a} 张合格，少于 min_run = ${p.min_run}，这段不交付` : `连续 ${r.b - r.a} 张，交付`;
      const label = r === widest && p.shard_z > 0 ? `每片最多 ${p.shard_z} 张` : r.short ? "连续长度不足" : `${r.b - r.a} 张`;
      if (x1 - x0 > label.length * 8 + 6) svgEl("text", { x: (x0 + x1) / 2, y: 9, "text-anchor": "middle" }, g).textContent = label;
    }
    for (const s of col.shards) {
      if (s.a <= view.a || s.a >= view.b) continue;
      if (!col.shards.some((o) => o.block === s.block && o.b === s.a)) continue;   // 只画同一段里两个分片之间
      const x = X(s.a) - slot / 2;
      svgEl("line", { x1: x, x2: x, y1: 14, y2: 140, class: "dl-shard-edge" }, ov);
    }

    // ---------- 资产轨道
    const at = $("ex-asset-tracks"); at.replaceChildren(); EX.assetEls.clear();
    for (const a of p.with_assets) {
      const lab = h("div", "dl-row-lab", a), row = h("div", "dl-track is-asset");
      at.append(lab, row);
      const zsP = assetZs.get(`${EX.ds}|${a}`);
      if (zsP) zsP.then((have) => {
        if (!have) { row.append(h("span", "dl-track-msg", "这个资产读不出来")); return; }
        const m = new Map();
        sampled.forEach((z, i) => {
          const el = h("i", `dt-sl is-asset${have.has(z) ? "" : " is-miss"}`); el.dataset.z = z;
          el.style.left = `${X(z) - sw / 2}px`; el.style.width = `${sw}px`;
          const tz = sampled[i - (i % texStep)];
          if (have.has(z) && have.has(tz) && sw >= 8) el.style.setProperty("--tex", `url("${assetUrl(EX.ds, a, tz)}")`);
          row.append(el); m.set(z, el);
        });
        EX.assetEls.set(a, { m, have });
        const miss = [...col.cells.values()].filter((c) => c.code === "K" && !have.has(c.z)).length;
        lab.textContent = miss ? `${a} · 交付范围里缺 ${miss} 张` : a;
      });
    }

    // ---------- z 轴刻度 + 全卷概览
    const ax = $("ex-axis"); ax.replaceChildren();
    const asv = svgEl("svg", { width: W, height: 30 }, ax);
    svgEl("line", { x1: 0, x2: W - 6, y1: 6, y2: 6, class: "dl-ax-line" }, asv);
    svgEl("path", { d: `M${W - 8} 2 L${W} 6 L${W - 8} 10 Z`, class: "dl-ax-head" }, asv);
    const tickStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => s * slot >= 64) || 10000;
    for (let z = Math.ceil(view.a / tickStep) * tickStep; z < view.b; z += tickStep) {
      svgEl("line", { x1: X(z), x2: X(z), y1: 3, y2: 9, class: "dl-ax-line" }, asv);
      svgEl("text", { x: X(z), y: 24, "text-anchor": "middle", class: "dl-ax-t" }, asv).textContent = z;
    }
    svgEl("text", { x: W - 12, y: 24, "text-anchor": "end", class: "dl-ax-lab" }, asv).textContent = "切片位置 z";
    drawBrush();
  }

  function drawBrush() {
    const { col, view } = EX, cv = $("ex-brush-c"), W = $("ex-brush").clientWidth, Hh = 14, dpr = devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = Hh * dpr; cv.style.width = `${W}px`; cv.style.height = `${Hh}px`;
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const n = col.zB - col.zA, COL = { K: "rgba(167,139,250,0.85)", S: "rgba(167,139,250,0.35)", L: "rgba(242,196,109,0.7)", Q: "rgba(255,255,255,0.12)", M: "rgba(255,255,255,0.05)" };
    for (const [z, c] of col.cells) { g.fillStyle = COL[c.code] || COL.M; g.fillRect(((z - col.zA) / n) * W, 0, Math.max(1, W / n), Hh); }
    const win = $("ex-brush-win");
    win.style.left = `${((view.a - col.zA) / n) * 100}%`; win.style.width = `${((view.b - view.a) / n) * 100}%`;
  }

  // ---- 悬停：曲线、原图轨道、标签轨道同步高亮；浮层里原图 + 标签 + 状态 + 分数
  function zAt(clientX) {
    if (!EX.geom) return null;
    const r = $("ex-track").getBoundingClientRect(), { view } = EX;
    const z = Math.floor(view.a + (clientX - r.left) / EX.geom.slot);
    return z >= view.a && z < view.b ? z : null;
  }
  function setHot(z, e) {
    const near = (m) => { if (z == null) return null; const s = EX.geom.step; return m.get(z - ((z - EX.col.zA) % s)) || null; };
    document.querySelectorAll(".dt-sl.is-hot, .dl-qsvg circle.is-hot").forEach((x) => x.classList.remove("is-hot"));
    if (z == null) { tip.hidden = true; return; }
    near(EX.els)?.classList.add("is-hot");
    for (const { m } of EX.assetEls.values()) near(m)?.classList.add("is-hot");
    document.querySelector(`.dl-qsvg circle[data-z="${z}"]`)?.classList.add("is-hot");
    const c = EX.col.cells.get(z);
    tip.replaceChildren();
    const head = h("div", "dl-tip-h"); head.append(h("b", null, `z ${z}`), h("span", null, c ? c.block : "—")); tip.append(head);
    const imgs = h("div", "dl-tip-imgs");
    const fig = (src, cap, missing) => { const f = h("figure"); if (missing) f.append(h("div", "dl-tip-miss", "缺失")); else { const im = new Image(); im.src = src; im.alt = cap; f.append(im); } f.append(h("figcaption", null, cap)); imgs.append(f); };
    fig(texUrl(EX.ds, z), "原图");
    for (const [a, { have }] of EX.assetEls) fig(assetUrl(EX.ds, a, z), a, !have.has(z));
    tip.append(imgs);
    const st = h("div", "dl-tip-r"); st.append(h("span", null, "状态"), h("b", `c-${(c?.code || "M").toLowerCase()}`, CODE_ZH[c?.code || "M"])); tip.append(st);
    const sc = h("div", "dl-tip-r"); sc.append(h("span", null, "综合分"), h("b", null, c?.q == null ? "–" : c.q.toFixed(3))); tip.append(sc);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = e.clientX + 16, yy = e.clientY + 16;
    if (x + tw > innerWidth - 8) x = e.clientX - 16 - tw;
    if (yy + th > innerHeight - 8) yy = e.clientY - 16 - th;
    tip.style.transform = `translate(${x}px, ${yy}px)`;
  }
  const viz = $("ex-tracks");
  let drag = null;
  for (const host of [viz, $("ex-curve")]) {
    host.addEventListener("pointermove", (e) => {
      if (!EX.col) return;
      if (drag && host === viz) { const dz = (drag.x - e.clientX) / EX.geom.slot; setView(drag.a + dz, drag.b + dz); tip.hidden = true; return; }
      if (e.target.closest(".dl-thr")) { setHot(null); return; }
      setHot(zAt(e.clientX), e);
    });
    host.addEventListener("pointerleave", () => setHot(null));
  }
  viz.addEventListener("pointerdown", (e) => { if (!EX.col || e.button !== 0) return; drag = { x: e.clientX, a: EX.view.a, b: EX.view.b }; viz.setPointerCapture(e.pointerId); viz.classList.add("is-pan"); });
  viz.addEventListener("pointerup", () => { drag = null; viz.classList.remove("is-pan"); });
  viz.addEventListener("wheel", (e) => {
    if (!EX.col || !(e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) return;  // 普通上下滚动留给页面
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.25 : 0.8, zAt(e.clientX) ?? undefined);
    else { const dz = e.deltaX / EX.geom.slot; setView(EX.view.a + dz, EX.view.b + dz); }
  }, { passive: false });
  document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
    if (!EX.col) return;
    if (b.dataset.zoom === "fit") { fitView(); renderViz(); } else zoomAt(b.dataset.zoom === "in" ? 1.6 : 1 / 1.6);
  }));
  { // 概览条：拖方框平移，点空白处跳过去
    const br = $("ex-brush"); let bd = null;
    br.addEventListener("pointerdown", (e) => {
      if (!EX.col) return;
      const r = br.getBoundingClientRect(), n = EX.col.zB - EX.col.zA, z = EX.col.zA + ((e.clientX - r.left) / r.width) * n, w = EX.view.b - EX.view.a;
      if (!e.target.closest(".dl-brush-win")) setView(z - w / 2, z + w / 2);
      bd = { x: e.clientX, a: EX.view.a, b: EX.view.b, k: n / r.width }; br.setPointerCapture(e.pointerId);
    });
    br.addEventListener("pointermove", (e) => { if (bd) { const dz = (e.clientX - bd.x) * bd.k; setView(bd.a + dz, bd.b + dz); } });
    br.addEventListener("pointerup", () => { bd = null; });
  }
  $("ex-tile").addEventListener("change", (e) => { EX.tile = e.target.value; EX.view = null; EX.els.forEach((el) => el.remove()); EX.els.clear(); renderExport(true); });

  // ---- 右侧本地分片：名称是真实的文件名；状态只看真实任务
  function shardList() {
    const out = [];
    for (const b of EX.pv?.blocks || []) for (const [a, e] of b.shards || []) out.push({ block: b.block_id, a, b: e, name: `z${pad5(a)}-${pad5(e - 1)}.npy` });
    return out;
  }
  function stateOf(s, order) {
    const j = EX.job;
    if (!j) return ["待导出", "is-idle"];
    const done = EX.jobBlocks.get(s.block);
    if (done) return done.n_reused && done.n_reused >= done.n_shards ? ["已存在 · 跳过", "is-skip"] : ["已写入", "is-done"];
    if (j.status === "error") return ["失败", "is-fail"];
    if (j.status === "cancelled") return ["已取消", "is-fail"];
    if (j.status === "done") return ["没有写入", "is-idle"];
    const cur = order.find((bid) => !EX.jobBlocks.has(bid));
    return s.block === cur ? ["写入中", "is-run"] : ["排队中", "is-queue"];
  }
  function renderFiles() {
    const list = $("ex-files"), all = shardList();
    $("ex-nshards").textContent = EX.pv ? EX.pv.n_shards : "–";
    const order = [...new Set((EX.pv?.blocks || []).map((b) => b.block_id))].sort();
    const prev = new Map([...list.children].map((el) => [el.dataset.key, el.dataset.state]));
    list.replaceChildren();
    if (!EX.pv) return;
    if (!all.length) list.append(h("p", "dl-empty", "按现在的设置一张都不交付"));
    const shown = all.slice(0, 150);
    for (const s of shown) {
      const [txt, cls] = stateOf(s, order), key = `${s.block}/${s.name}`;
      const card = h("div", `dl-file-card ${cls}`); card.setAttribute("role", "listitem"); card.dataset.key = key; card.dataset.state = cls;
      const ic = h("span", "dl-file-ic"); ic.setAttribute("aria-hidden", "true");
      const body = h("div", "min-w-0");
      body.append(h("b", null, s.name), h("small", null, `${tileOf(s.block)} · ${s.b - s.a} 张`));
      card.append(ic, body, h("em", cls, txt));
      if (prev.has(key) && prev.get(key) !== cls && !reduce) card.animate([{ boxShadow: "0 0 0 1px rgba(196,181,253,0.9), 0 0 24px rgba(167,139,250,0.6)" }, { boxShadow: "0 0 0 0 rgba(0,0,0,0)" }], { duration: 900, easing: EASE });
      list.append(card);
    }
    if (all.length > shown.length) list.append(h("p", "dl-empty", `还有 ${all.length - shown.length} 个分片（共 ${all.length} 个）`));
    $("ex-sum").textContent = `${EX.pv.n_keep} 张 · ${all.length} 个分片 · 约 ${mb(EX.pv.est_bytes)}`;
    renderJob();
  }
  function renderJob() {
    const box = $("ex-job"), j = EX.job;
    box.hidden = !j; if (!j) return;
    box.replaceChildren();
    const STJ = { queued: "排队中", running: "写入中", done: "已完成", error: "失败", cancelled: "已取消" };
    const top = h("div", "dl-job-h"); top.append(h("b", null, `任务 #${j.job_id}`), h("span", `st-${j.status}`, STJ[j.status] || j.status)); box.append(top);
    const live = ["queued", "running"].includes(j.status);
    if (j.n_blocks) {
      const bar = h("div", "dl-bar is-wide"), f = h("span"); f.style.width = `${Math.round((j.n_blocks_done / j.n_blocks) * 100)}%`; bar.append(f); box.append(bar);
      box.append(h("small", null, `${j.n_blocks_done} / ${j.n_blocks} 个 block · ${j.n_shards} 个分片${j.n_shards_reused ? `（${j.n_shards_reused} 个已存在）` : ""} · ${mb(j.n_bytes)}`));
    } else if (live) box.append(h("small", "dl-spin", "处理中…"));
    if (j.error) box.append(h("small", "dl-errtxt", j.error));
  }

  // ---- 开始导出：切片组收拢成文件卡片飞进右边；之后的状态全靠轮询真实任务
  function packAnimation() {
    if (reduce) return;
    const target = $("ex-files").getBoundingClientRect();
    const groups = EX.col.runs.filter((r) => !r.short && r.b > EX.view.a && r.a < EX.view.b).slice(0, 6);
    groups.forEach((r, gi) => {
      const els = [...EX.els.entries()].filter(([z]) => z >= r.a && z < r.b).map(([, el]) => el);
      if (!els.length) return;
      const rs = els.map((el) => el.getBoundingClientRect());
      const cx = (rs[0].left + rs[rs.length - 1].right) / 2, cy = rs[0].top + rs[0].height / 2;
      els.forEach((el, i) => el.animate([{ translate: "0 0", opacity: 1 }, { translate: `${cx - (rs[i].left + rs[i].width / 2)}px 0`, opacity: 0.15, offset: 0.55 }, { translate: "0 0", opacity: 1 }],
        { duration: 1400, delay: gi * 120, easing: EASE }));
      const ghost = h("div", "dl-ghost-card", `${r.b - r.a} 张`);
      ghost.style.left = `${cx - 40}px`; ghost.style.top = `${cy - 26}px`; document.body.append(ghost);
      ghost.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1)", offset: 0.3 },
        { opacity: 0.9, transform: `translate(${target.left + 30 - cx}px, ${target.top + 20 - cy}px) scale(0.7)` }],
        { duration: 1100, delay: 450 + gi * 120, easing: EASE, fill: "forwards" }).onfinish = () => ghost.remove();
    });
  }
  async function pollJob() {
    clearTimeout(EX.poll);
    const j = EX.job; if (!j) return;
    try {
      const [job, evs] = await Promise.all([getJSON(`/api/v1/exports/${j.job_id}`), getJSON(`/api/v1/exports/${j.job_id}/events?after_id=${EX.lastEvt}`)]);
      if (EX.job !== j && EX.job?.job_id !== j.job_id) return;
      EX.job = job;
      for (const ev of evs) { EX.lastEvt = Math.max(EX.lastEvt, ev.id); if (ev.block_id && ev.data && ev.data.n_shards != null) EX.jobBlocks.set(ev.block_id, ev.data); }
      renderFiles();
      if (["queued", "running"].includes(job.status)) EX.poll = setTimeout(pollJob, 1000);
      else { $("ex-msg").textContent = job.status === "done" ? `导出完成：${job.n_sections} 张，${job.n_shards} 个分片` : job.status === "error" ? "导出失败，详情见任务" : "导出已取消"; refreshLists(); }
    } catch { EX.poll = setTimeout(pollJob, 2000); }
  }
  function bindJob(job) { EX.job = job; EX.jobBlocks = new Map(); EX.lastEvt = 0; pollJob(); }
  $("ex-go").addEventListener("click", async () => {
    const p = exParams(); showErr("ex-err", p.errs);
    if (!p.ok) return;
    const go = $("ex-go"), msg = $("ex-msg");
    go.disabled = true; msg.textContent = "正在提交…";
    try {
      const j = await getJSON("/api/v1/exports", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataset_id: p.dataset_id, min_run: p.min_run, shard_z: p.shard_z, min_quality: p.min_quality, with_assets: p.with_assets, block_ids: p.block_ids.length ? p.block_ids : null, resume: p.resume }) });
      msg.textContent = `导出任务 #${j.job_id} 已开始`;
      if (EX.col) packAnimation();
      bindJob(j); refreshLists();
    } catch (e) { msg.textContent = e.status === 401 || e.status === 403 ? "需要审核员权限才能导出。" : `没有提交成功：${e.message}`; }
    finally { go.disabled = false; }
  });
  exForm.addEventListener("input", (e) => {
    if (e.target.name === "dataset_id") { renderAssetChoices(e.target.value); EX.job = null; EX.els.forEach((el) => el.remove()); EX.els.clear(); EX.drawn = false; }
    else if (EX.job && !["queued", "running"].includes(EX.job.status) && e.target.name !== "asset") EX.job = null;   // 参数变了，上一次任务的状态不再对应
    exSchedule(e.target.name === "min_quality" ? 250 : 200);
  });
  document.querySelector('input[name="resume"]').addEventListener("change", () => renderFiles());

  // ==================================================================================== 02 推理流
  const stForm = $("st-form");
  const ST = { pvs: new Map(), sess: null, map: null, poll: 0, lastOk: null, tile: null };
  function stParams() {
    const f = new FormData(stForm), errs = [];
    const zc = Number(String(f.get("z_chunk") || "").trim()), inp = stForm.elements.z_chunk;
    const bad = !Number.isInteger(zc) || zc < 1; inp.toggleAttribute("aria-invalid", bad);
    if (bad) errs.push("z_chunk 要是 1 以上的整数");
    const client = String(f.get("client") || "").trim();
    if (client.length > 64) errs.push("客户端名最多 64 个字");
    return { ok: !errs.length, errs, dataset_id: f.get("dataset_id"), z_chunk: bad ? 16 : zc, order: f.get("order"), client, skip_failed: f.get("skip_failed") === "on" };
  }
  let stTimer = 0;
  const stSchedule = () => { clearTimeout(stTimer); stTimer = setTimeout(stLoad, 180); };
  async function stLoad() {
    const p = stParams(); showErr("st-err", p.errs);
    $("st-client").textContent = p.client || "推理程序";
    if (!p.ok) return;
    let pv = ST.pvs.get(p.dataset_id);
    if (!pv) {
      try { pv = await getJSON(`/api/v1/exports/preview?${new URLSearchParams({ dataset_id: p.dataset_id, min_run: 1, shard_z: 0 })}`); ST.pvs.set(p.dataset_id, pv); }
      catch (e) { showErr("st-err", [`没取到这个数据集的 block 划分：${e.message}`]); return; }
    }
    drawStream();
  }
  // 子块：会话已建好就用会话自己的子块（map 里的），否则按 build_plan 的规则现算
  function streamColumn() {
    const p = stParams(), pv = ST.pvs.get(p.dataset_id);
    if (!pv || !(pv.blocks || []).length) return null;
    const m = ST.map && ST.map.dataset_id === p.dataset_id ? ST.map : null;
    const tiles = [...new Set(pv.blocks.map((b) => tileOf(b.block_id)))];
    const tile = m && m.current ? tileOf(m.current.block_id) : ST.tile && tiles.includes(ST.tile) ? ST.tile : tiles[0];
    ST.tile = tile;
    const blocks = pv.blocks.filter((b) => tileOf(b.block_id) === tile).sort((a, b) => a.z_start - b.z_start);
    const chunks = [];
    if (m) {
      for (const bk of m.blocks.filter((b) => tileOf(b.block_id) === tile)) for (const c of bk.cells) chunks.push({ block: bk.block_id, a: c.z0, b: c.z1, bad: c.n_failed > 0, skip: c.state === "skipped", state: c.state });
    } else {
      for (const b of blocks) for (let a = b.z_start; a < b.z_end; a += p.z_chunk) {
        const e = Math.min(a + p.z_chunk, b.z_end); let bad = false;
        for (let z = a; z < e; z++) if (b.codes[z - b.z_start] === "Q") { bad = true; break; }
        chunks.push({ block: b.block_id, a, b: e, bad, skip: p.skip_failed && bad, state: "pending" });
      }
    }
    chunks.sort((u, v) => u.a - v.a);
    return { p, pv, m, tile, blocks, chunks, zA: blocks[0].z_start, zB: blocks[blocks.length - 1].z_end, nTiles: tiles.length };
  }
  function cuboid(x0, x1, cls) {
    const c = h("div", `cub ${cls}`); c.style.left = `${x0}px`; c.style.width = `${Math.max(2, x1 - x0)}px`;
    for (const f of ["front", "back", "top", "bottom", "end-a", "end-b"]) c.append(h("i", `cf cf-${f}`));
    for (const m of ["cub-mark", "cub-mark-l", "cub-mark-r"]) c.append(h("b", m));
    return c;
  }
  let stScene = null;
  function drawStream() {
    const vol = $("st-vol"), C = streamColumn();
    if (!C) { vol.replaceChildren(h("p", "dl-empty", "这个数据集还没有 QC 结果。")); stScene = null; renderStStatus(null); return; }
    const L = Math.max(300, vol.clientWidth * 0.86), span = C.zB - C.zA, X = (z) => ((z - C.zA) / span) * L;
    const key = `${C.p.dataset_id}|${C.tile}|${C.chunks.map((c) => `${c.a}-${c.b}-${c.skip ? 1 : 0}`).join(",")}|${Math.round(L)}`;
    if (!stScene || stScene.key !== key) {
      vol.replaceChildren();
      const scene = h("div", "dl-scene"), world = h("div", "dl-world"); world.style.width = `${L}px`; scene.append(world); vol.append(scene);
      const n = Math.min(span, 56), step = span / n, planes = [];
      for (let i = 0; i < n; i++) {
        const z = Math.floor(C.zA + i * step), pl = h("i", "pl"); pl.dataset.z = z;
        pl.style.left = `calc(${X(z)}px - var(--d) / 2)`;
        pl.style.setProperty("--tex", `url("${texUrl(C.p.dataset_id, Math.floor(C.zA + (i - (i % 3)) * step))}")`);
        if (!reduce) pl.style.animationDelay = `${Math.min(i, 50) * 12}ms`;
        world.append(pl); planes.push(pl);
      }
      const labels = h("div", "dl-labels"); vol.append(labels);
      const blocks = C.blocks.map((b, i) => { const c = cuboid(X(b.z_start), X(b.z_end), "is-block"); world.append(c); const l = h("span", "lab lab-block", `block ${String(i + 1).padStart(2, "0")}`); labels.append(l); return [c, l]; });
      // 跳过的子块：变暗 + 一条虚线弧从它上面越过去
      const skips = [];
      const runs = [];  // 相邻的被跳过子块合成一段，只画一条弧
      for (const ch of C.chunks.filter((c) => c.skip)) { const last = runs[runs.length - 1]; if (last && last.b === ch.a) last.b = ch.b; else runs.push({ a: ch.a, b: ch.b }); }
      runs.forEach((r, i) => { const c = cuboid(X(r.a), X(r.b), "is-skip"); world.append(c); const l = h("span", "lab lab-skip"); l.append(h("span", null, i ? "跳过" : "跳过不合格子块")); labels.append(l); skips.push([c, l]); });
      const win = cuboid(0, 10, "is-win"); win.hidden = true; world.append(win);
      const winLab = h("span", "lab lab-win"), winTxt = h("span"); winLab.append(winTxt); winLab.hidden = true; labels.append(winLab);
      const link = h("span", "dl-link-line"); labels.append(link);
      const axis = h("span", "dl-vaxis"); axis.append(h("span", null, "z")); vol.append(axis);
      stScene = { key, C, X, planes, blocks, skips, win, winLab, winTxt, link, cur: null };
    }
    stScene.C = C;
    placeWindow();
    renderStStatus(C);
  }
  // 窗口：有会话 → 只停在客户端真正拿走的那个子块上；没有会话 → 停在第一个会读的子块上，不自己往前走
  function currentChunk(C) {
    if (C.m) return C.m.current ? C.chunks.find((c) => c.block === C.m.current.block_id && c.a === C.m.current.z0) || null : null;
    return C.chunks.find((c) => !c.skip) || null;
  }
  function placeWindow() {
    const S = stScene; if (!S) return;
    const ch = currentChunk(S.C);
    S.win.hidden = !ch; S.winLab.hidden = !ch;
    for (const pl of S.planes) {
      const z = +pl.dataset.z, c = S.C.chunks.find((k) => z >= k.a && z < k.b);
      pl.classList.toggle("is-cur", !!ch && z >= ch.a && z < ch.b);
      pl.classList.toggle("is-skip", !!c && c.skip);
      pl.classList.toggle("is-done", !!c && c.state === "ok");
    }
    if (ch) {
      S.win.style.left = `${S.X(ch.a)}px`; S.win.style.width = `${Math.max(4, S.X(ch.b) - S.X(ch.a))}px`;
      S.winTxt.textContent = `${tileOf(ch.block)} · z${pad5(ch.a)}–${pad5(ch.b - 1)} · ${ch.b - ch.a} 张`;
    }
    S.cur = ch;
    const t0 = performance.now(), f = () => { placeLabels(); if (performance.now() - t0 < 520) requestAnimationFrame(f); }; requestAnimationFrame(f);
  }
  function placeLabels() {
    const S = stScene; if (!S) return;
    const vr = $("st-vol").getBoundingClientRect(), at = (el, m) => el.querySelector(m).getBoundingClientRect();
    const wl = S.cur ? at(S.win, ".cub-mark-l").left : -1e9, wr = S.cur ? at(S.win, ".cub-mark-r").left : -1e9;
    for (const [c, l] of S.blocks) {
      const r = at(c, ".cub-mark-l"), x = r.left + 6;
      l.style.transform = `translate(${x - vr.left}px, ${r.top - vr.top}px)`;
      l.style.opacity = x > wl - 70 && x < wr + 10 ? "0" : "1";   // 被读取窗口的标签压住时先藏起来
    }
    for (const [c, l] of S.skips) { const a = at(c, ".cub-mark-l"), b = at(c, ".cub-mark-r"); l.style.transform = `translate(${a.left - vr.left}px, ${Math.min(a.top, b.top) - vr.top}px)`; l.style.width = `${Math.max(24, b.left - a.left)}px`; }
    if (S.cur) {
      const a = at(S.win, ".cub-mark-l"), b = at(S.win, ".cub-mark-r");
      S.winLab.style.transform = `translate(${a.left - vr.left}px, ${Math.min(a.top, b.top) - vr.top}px)`; S.winLab.style.width = `${Math.max(60, b.left - a.left)}px`;
      const m = at(S.win, ".cf-end-b"), x0 = m.left + m.width / 2 - vr.left, y0 = m.top + m.height / 2 - vr.top;
      S.link.hidden = false; S.link.style.left = `${x0}px`; S.link.style.top = `${y0}px`; S.link.style.width = `${Math.max(0, vr.width - x0 + 22)}px`;
    } else S.link.hidden = true;
  }
  // 客户端每确认一个子块，就有一小块从窗口飞到右边的客户端节点
  function sendPacket() {
    if (reduce || !stScene || !stScene.cur) return;
    const a = stScene.win.querySelector(".cf-front").getBoundingClientRect(), b = $("st-client-node").getBoundingClientRect();
    const pk = h("div", "dl-packet"); pk.style.left = `${a.left + a.width / 2 - 9}px`; pk.style.top = `${a.top + a.height / 2 - 12}px`;
    document.body.append(pk);
    pk.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${b.top + b.height / 2 - (a.top + a.height / 2)}px) scale(0.6)`, opacity: 0.2 }],
      { duration: 700, easing: EASE }).onfinish = () => pk.remove();
    $("st-client-node").animate([{ filter: "drop-shadow(0 0 0 rgba(167,139,250,0))" }, { filter: "drop-shadow(0 0 18px rgba(167,139,250,0.8))" }, { filter: "drop-shadow(0 0 0 rgba(167,139,250,0))" }], { duration: 800, delay: 600 });
  }
  function renderStStatus(C) {
    const box = $("st-status"), t = $("st-status-t"), meta = $("st-meta"), m = C && C.m;
    box.classList.remove("is-live", "is-done", "is-fail");
    if (!C) { t.textContent = "没有可读的数据"; meta.textContent = ""; return; }
    const total = C.chunks.length * C.nTiles, skipped = C.chunks.filter((c) => c.skip).length * C.nTiles;
    if (!m) {
      t.textContent = "等待客户端读取";
      meta.textContent = `还没有会话 · 按现在的设置共 ${total - skipped} 个子块${skipped ? `（跳过 ${skipped} 个）` : ""}`;
      return;
    }
    const cnt = m.counts || {}, ok = cnt.ok || 0, fail = cnt.fail || 0, out = cnt.out || 0;
    const all = Object.entries(cnt).filter(([k]) => k !== "skipped").reduce((a, [, v]) => a + v, 0);
    if (m.status === "open" && m.current) { box.classList.add("is-live"); t.textContent = `读取中 · 会话 #${m.stream_id}`; }
    else if (m.status === "open") t.textContent = `等待客户端读取 · 会话 #${m.stream_id}`;
    else if (m.status === "done") { box.classList.add("is-done"); t.textContent = `已完成 · 会话 #${m.stream_id}`; }
    else t.textContent = `${m.status === "aborted" ? "已中止" : m.status} · 会话 #${m.stream_id}`;
    if (fail) box.classList.add("is-fail");
    meta.textContent = `${m.client || "未命名客户端"} · 已完成 ${ok} / ${all} 个子块${out ? ` · 处理中 ${out}` : ""}${fail ? ` · 失败 ${fail}` : ""}${cnt.skipped ? ` · 跳过 ${cnt.skipped}` : ""}${m.chunks_per_min ? ` · ${m.chunks_per_min.toFixed(1)} 块/分钟` : ""}`;
  }
  async function pollMap() {
    clearTimeout(ST.poll);
    const sess = ST.sess; if (!sess) return;
    try {
      const m = await getJSON(`/api/v1/streams/${sess.stream_id}/map`);
      if (ST.sess !== sess) return;
      const ok = (m.counts || {}).ok || 0;
      if (ST.lastOk != null && ok > ST.lastOk) sendPacket();
      ST.lastOk = ok; ST.map = m;
      drawStream();
      if (m.status === "open") ST.poll = setTimeout(pollMap, 1000);
    } catch { ST.poll = setTimeout(pollMap, 3000); }
  }
  function bindSession(sess) {
    if (ST.sess && sess && ST.sess.stream_id === sess.stream_id) return;
    clearTimeout(ST.poll);
    ST.sess = sess; ST.map = null; ST.lastOk = null; stScene = null;
    if (sess) pollMap(); else drawStream();
  }
  stForm.addEventListener("input", (e) => {
    if (e.target.name === "dataset_id") { bindSession(null); ST.tile = null; }
    else if (ST.sess && ["z_chunk", "skip_failed", "order"].includes(e.target.name)) bindSession(null);  // 改了参数：显示新参数下的划分，等新建会话
    stSchedule();
  });
  $("st-go").addEventListener("click", async () => {
    const p = stParams(); showErr("st-err", p.errs);
    if (!p.ok) return;
    const go = $("st-go"), msg = $("st-msg");
    go.disabled = true; msg.textContent = "正在创建…";
    try {
      const s = await getJSON("/api/v1/streams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset_id: p.dataset_id, z_chunk: p.z_chunk, order: p.order, client: p.client || null, skip_failed: p.skip_failed }) });
      msg.textContent = `会话 #${s.stream_id} 已创建，推理程序用 stream_id=${s.stream_id} 接上`;
      bindSession(s); refreshLists();
    } catch (e) { msg.textContent = e.status === 401 || e.status === 403 ? "需要审核员权限才能创建会话。" : `没有创建成功：${e.message}`; }
    finally { go.disabled = false; }
  });

  // ==================================================================================== 最近的任务
  const STZ = { queued: "排队", running: "进行中", done: "完成", error: "出错", cancelled: "已取消", open: "传输中", aborted: "已中止" };
  function row(title, sub, status, prog) {
    const r = h("div", "dl-row"), l = h("div", "min-w-0"), rr = h("div", "dl-row-r");
    l.append(h("b", null, title), h("small", null, sub));
    const bar = h("span", "dl-bar"), f = h("span"); f.style.width = `${Math.round((prog || 0) * 100)}%`; bar.append(f);
    rr.append(h("em", `st-${status}`, STZ[status] || status), bar); r.append(l, rr); return r;
  }
  let firstLists = true;
  async function refreshLists() {
    try {
      const jobs = await getJSON("/api/v1/exports?limit=6");
      const box = $("dl-jobs"); box.replaceChildren();
      for (const j of jobs) box.append(row(`#${j.job_id} · ${j.dataset_id}`, `${j.n_sections ?? 0} 张 · ${j.n_shards ?? 0} 个分片 · ${mb(j.n_bytes)} · ${(j.created_at || "").slice(5, 16).replace("T", " ")}`, j.status, j.progress ?? (j.status === "done" ? 1 : 0)));
      if (!jobs.length) box.append(h("p", "dl-empty", "还没有导出任务"));
      // 打开页面时这个数据集正好有导出在跑：接上它，右边的文件卡片跟着它走
      if (firstLists && !EX.job) { const live = jobs.find((j) => j.dataset_id === exForm.elements.dataset_id.value && ["queued", "running"].includes(j.status)); if (live) bindJob(live); }
    } catch {}
    try {
      const ss = (await getJSON("/api/v1/streams?limit=8")).slice(0, 6);
      const box = $("dl-sessions"); box.replaceChildren();
      for (const x of ss) box.append(row(`#${x.stream_id} · ${x.dataset_id}`, `${x.client || "未命名客户端"} · ${x.n_acked}/${x.n_items} 个子块 · ${mb(x.n_bytes)} · ${(x.created_at || "").slice(5, 16).replace("T", " ")}`, x.status, x.progress));
      if (!ss.length) box.append(h("p", "dl-empty", "还没有推理流会话"));
      if (!ST.sess) { const p = stParams(); const open = ss.find((x) => x.dataset_id === p.dataset_id && x.status === "open"); if (open) bindSession(open); }
    } catch {}
    firstLists = false;
  }

  let rz = 0;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (EX.col) renderViz(); stScene = null; drawStream(); }, 150); });
  renderAssetChoices(exForm.elements.dataset_id.value);
  exLoad();
  stLoad();
  refreshLists();
  setInterval(refreshLists, 4000);
})();
