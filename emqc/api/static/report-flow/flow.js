// 汇报落地页（/report）：整条数据流程图 + 右侧操作台。
// - 图按 1920×1080 的设计坐标画在 #rf-world 里，按视口等比缩放；数字全部来自 GET /api/v1/report/flow。
// - 点一个节点：这个节点放大靠近、其余变暗，整张图缩到左边，右侧滑出这个节点的操作台；底部「上一节点 / 下一节点」按流程顺序切换。
// - 单击空白处进入画布模式：滚轮以鼠标为中心缩放、拖动平移、双击复位、Esc 退出。
// - 有清洗正在跑时（GET /api/v1/report/active，每 4 秒）流程线上有流光，一段接一段从采集一直流到交付；打开页面时也先完整流一遍。
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = $("rf"), view = $("rf-view"), world = $("rf-world"), svg = $("rf-svg"), host = $("rf-nodes");
  const panel = $("rf-panel"), body = $("rf-body");
  if (!root) return;
  const CAN = root.dataset.canAct === "true";
  const NS = "http://www.w3.org/2000/svg";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ 格式
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (x) => (x == null ? "–" : Number(x).toLocaleString("zh-CN"));
  const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
  const mb = (b) => (!b ? "0 MB" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  const secs = (x) => (x == null ? "–" : x < 10 ? `${x.toFixed(2)} s` : `${x.toFixed(1)} s`);
  const when = (t) => (t ? t.replace("T", " ").slice(5, 16) : "–");
  const gradeTxt = (g) => { const k = Object.keys(g || {}).sort(); return k.length ? k.map((x) => `${x}${g[x]}`).join(" · ") : "–"; };

  // ------------------------------------------------------------------ 数据
  let D = null, active = [], openId = null;
  const LEVEL_ZH = { slice: "2D 切片", segment: "3D 连续段", patch: "3D patch" };
  const cellsOf = (lv) => ((D.plan && D.plan.cells) || []).filter((c) => c.level === lv && c.applicable);
  const rawN = (lv) => { const c = cellsOf(lv).find((x) => x.task === "raw"); return c && c.ready ? c.n : null; };
  const problems = () => (D.latest ? D.latest.failures.reduce((a, f) => a + f.n, 0) : 0);

  // ------------------------------------------------------------------ 画图的小工具
  const FLOWS = [];
  function defs() {
    svg.innerHTML = `<defs>
      <marker id="ahg" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#3fdf93"/></marker>
      <marker id="aho" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#ff9a3c"/></marker>
      <marker id="ahw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#9a9da6"/></marker>
      <filter id="glow2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  }
  // 直角折线 + 圆角转弯；stage = 这段线在数据流里的先后（流光一段接一段走）
  function path(pts, opt = {}) {
    pts = pts.filter((q, i) => !i || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
    const r = opt.r ?? 30;
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1), rr = Math.min(r, d1 / 2, d2 / 2);
      d += ` L ${x1 - (x1 - x0) / d1 * rr} ${y1 - (y1 - y0) / d1 * rr} Q ${x1} ${y1} ${x1 + (x2 - x1) / d2 * rr} ${y1 + (y2 - y1) / d2 * rr}`;
    }
    d += ` L ${pts.at(-1)[0]} ${pts.at(-1)[1]}`;
    const c = opt.c || "#3fdf93";
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", c); p.setAttribute("stroke-width", opt.w || 2); p.setAttribute("stroke-opacity", opt.o ?? 0.85);
    if (opt.dash) p.setAttribute("stroke-dasharray", opt.dash);
    p.setAttribute("marker-end", `url(#${opt.m || "ahg"})`);
    svg.append(p);
    if (opt.stage != null) FLOWS.push({ p, c, stage: opt.stage });
    return p;
  }
  const add = (tag, cls, x, y, html, attrs = {}) => {
    const d = document.createElement(tag); d.className = cls; d.style.left = x + "px"; d.style.top = y + "px"; d.innerHTML = html;
    for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v);
    host.append(d); return d;
  };
  const box = (el) => ({ l: parseFloat(el.style.left) - el.offsetWidth / 2, r: parseFloat(el.style.left) + el.offsetWidth / 2,
                         t: parseFloat(el.style.top) - el.offsetHeight / 2, b: parseFloat(el.style.top) + el.offsetHeight / 2 });
  const nodeAttrs = (id, label) => ({ "data-node": id, tabindex: "0", role: "button", "aria-label": `${label}：打开操作台` });
  function node(id, x, y, w, html, cls, label) { const d = add("div", "n " + (cls || ""), x, y, html, id ? nodeAttrs(id, label) : {}); if (w) d.style.width = w + "px"; return box(d); }
  const label = (x, y, t, cls) => add("div", "el " + (cls || ""), x, y, t);
  const icon = (x, y, inner) => add("div", "ic", x, y, `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`);

  // 悬浮的方块（数据集 / 交付）：图片原样；底下冰蓝 LED 光 + 细紫色底边轮廓光 + 贴合底面透视的地面光晕 + 接触阴影；名字躺在地上
  // corners：图片里底面三个角（左、前、右）在图片宽高里的比例位置
  function holo(id, cx, cy, w, src, ratio, corners, cap, sub, capCol) {
    const h = w * ratio, x0 = cx - w / 2, y0 = cy - h / 2, lift = 12;
    const P = ([fx, fy], dy = 0) => [x0 + fx * w, y0 + fy * h + dy];
    const [BL, BF, BR] = corners, BK = [BL[0] + BR[0] - BF[0], BL[1] + BR[1] - BF[1]];
    const foot = (dy, s = 1) => { const c = P([(BL[0] + BR[0]) / 2, (BL[1] + BR[1]) / 2], dy);
      return [BL, BF, BR, BK].map((q) => { const p = P(q, dy); return [c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s].join(","); }).join(" "); };
    const k = w / 300, fid = "hl" + id;
    const g = document.createElementNS(NS, "g");
    g.innerHTML = `<defs><filter id="${fid}a" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="${22 * k}"/></filter>
        <filter id="${fid}b" x="-50%" y="-80%" width="200%" height="260%"><feGaussianBlur stdDeviation="${7 * k}"/></filter>
        <filter id="${fid}c" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
      <polygon points="${foot(lift + 8, 1.28)}" fill="#7fd8ff" opacity=".16" filter="url(#${fid}a)"/>
      <polygon points="${foot(lift + 6, 1.06)}" fill="#a6e8ff" opacity=".42" filter="url(#${fid}b)"/>
      <polygon points="${foot(lift + 2, .9)}" fill="#000" opacity=".55" filter="url(#${fid}c)"/>`;
    svg.prepend(g);
    const im = document.createElement("img");
    im.src = src; im.alt = ""; im.className = "holo"; im.draggable = false;
    for (const [a, v] of Object.entries(nodeAttrs(id, cap === "DATASET" ? "数据集" : "数据交付"))) im.setAttribute(a, v);
    Object.assign(im.style, { left: x0 + "px", top: y0 + "px", width: w + "px", height: h + "px" });
    host.append(im);
    const top = document.createElementNS(NS, "g");
    top.innerHTML = `<polyline points="${[BL, BF, BR].map((q) => P(q, 3).join(",")).join(" ")}" fill="none" stroke="#9fe9ff" stroke-width="5" opacity=".55" filter="url(#${fid}c)"/>
      <polyline points="${[BL, BF, BR].map((q) => P(q).join(",")).join(" ")}" fill="none" stroke="#c4a8ff" stroke-width="1.4" stroke-linejoin="round" opacity=".95"/>`;
    svg.append(top);
    const e0 = P(BF, lift), e1 = P(BR, lift), b0 = P(BL, lift);
    const ul = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]), vl = Math.hypot(e0[0] - b0[0], e0[1] - b0[1]);
    const U = [(e1[0] - e0[0]) / ul, (e1[1] - e0[1]) / ul], V = [(e0[0] - b0[0]) / vl, (e0[1] - b0[1]) / vl];
    const c1 = add("div", "hcap edge", (e0[0] + e1[0]) / 2 + V[0] * 30, (e0[1] + e1[1]) / 2 + V[1] * 30, `<b>${cap}</b>`);
    c1.style.color = capCol; c1.style.transformOrigin = "0 0"; c1.style.transform = `matrix(${U[0]},${U[1]},${V[0]},${V[1]},0,0) translate(-50%,-50%)`;
    add("div", "hcap", cx, y0 + h + lift + 34, `<span>${sub}</span>`);
    return { l: x0, r: x0 + w, t: y0, b: y0 + h };
  }

  // ------------------------------------------------------------------ 整张流程图（横版，设计坐标 1920×1080）
  const ICONS = {
    slice: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    segment: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    patch: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  };
  function build() {
    FLOWS.length = 0; comets = [];
    defs(); host.replaceChildren();
    const L = D.latest, k = D.kpi, dl = D.delivery;
    const A = node("crawl", 170, 470, 220, `数据采集<small>${D.crawl.presets.length} 个预设 · 采集任务 ${D.crawl.jobs.length}</small>`, "", "数据采集");
    const ds = holo("dataset", 470, 236, 300, "/static/report-flow/em_block.png", 401 / 640, [[.0176, .5026], [.5048, .9949], [.9952, .5982]],
      "DATASET", `数据集 ${num(k.n_datasets)} 个 · ${num(k.n_sections)} 张切片`, "#c9b8f0");
    path([[170, A.t - 2], [170, 236], [ds.l + 6, 236]], { stage: 0 }); label(238, 212, "写入数据集");
    // 数据清洗：菱形判断
    const dm = add("div", "diamond", 470, 560, `<svg viewBox="0 0 230 150"><polygon points="115,2 228,75 115,148 2,75" fill="#0b0b08" stroke="#f3e27a" stroke-width="2" stroke-dasharray="7 6"/></svg>
      <span>数据清洗<small>${D.checks.length} 项检查 · ${L ? num(L.n_slices) + " 张" : "还没有结果"}</small><em class="live" id="rf-live"></em></span>`, nodeAttrs("clean", "数据清洗"));
    dm.id = "rf-clean";
    path([[470, ds.b + 34 + 36], [470, 560 - 77]], { dash: "7 6", stage: 1 }); label(530, (ds.b + 70 + 483) / 2, "读取切片");
    const G = node("passed", 470, 790, 210, L ? `合格 ${num(L.n_passed)} 张<small>可用率 ${pct(L.retention)}</small>` : "合格<small>–</small>", "green", "合格");
    path([[470, 560 + 77], [470, G.t - 4]], { stage: 2 }); label(505, 690, "通过");
    const Q = node("issues", 170, 790, 220, `问题图片<small>${num(problems())} 条 · 截图 ${num(L ? L.n_shots : 0)}</small>`, "org", "问题图片");
    path([[470 - 117, 560], [170, 560], [170, Q.t - 4]], { c: "#ff9a3c", m: "aho", stage: 2 }); label(260, 540, "不通过", "org");
    // 汇总分级 → 三种形态 → 格式 → 数据包
    const S = node("grade", 800, 560, 190, `汇总 · 分级<small>${L ? gradeTxt(L.grades) : "–"}</small>`, "dark", "汇总分级");
    path([[G.r + 2, 790], [640, 790], [640, 560], [S.l - 6, 560]], { stage: 3 });
    const FX = 1090, CX2 = 1290, BX = 1430;
    for (const [lv, y] of [["slice", 330], ["segment", 560], ["patch", 790]]) {
      path(y === 560 ? [[S.r + 2, 560], [FX - 92, 560]] : [[S.r + 2, 560], [950, 560], [950, y], [FX - 92, y]], { stage: 4 });
      icon(FX, y - 62, ICONS[lv]);
      const n = rawN(lv);
      node(lv, FX, y, 170, `${LEVEL_ZH[lv]}<small>${n == null ? "–" : num(n) + (lv === "slice" ? " 张" : lv === "segment" ? " 段" : " 个")}</small>`, "", LEVEL_ZH[lv]);
      node(null, CX2, y, 120, "npy / png", "chip");
      path([[FX + 86, y], [CX2 - 64, y]], { r: 0, stage: 5 });
      path([[CX2 + 62, y], [BX - 4, y]], { r: 0, stage: 6 });
    }
    const bar = add("div", "bar", BX, 250, `<div>数据包<small>原图<br>train / val / test<br>${esc(D.plan ? D.plan.dataset_id : "–")}<br>已生成 ${num(dl.n_packs)} 个</small></div>`, nodeAttrs("pack", "数据包"));
    Object.assign(bar.style, { width: "130px", height: "640px" });
    // 交付
    holo("delivery", 1720, 322, 240, "/static/report-flow/stack_block.png", 391 / 520, [[.0017, .5556], [.457, .9978], [.9975, .6656]], "DELIVERY", "数据交付", "#7ff0b8");
    path([[BX + 132, 322], [1720 - 132, 322]], { stage: 7 });
    const T = node("export", 1720, 560, 250, `训练导出<small>${num(dl.n_shard_jobs)} 次 · ${num(dl.shard_sections)} 张 · ${mb(dl.shard_bytes)}</small>`, "teal", "训练导出");
    path([[1720, 498], [1720, T.t - 4]], { r: 0, stage: 8 });
    const nOpen = D.streams.filter((x) => x.status === "open").length;
    const R = node("stream", 1720, 790, 250, `推理流<small>${num(dl.n_streams)} 个 · ${num(dl.stream_chunks)} 块 · ${nOpen} 个传输中</small>`, "", "推理流");
    path([[BX + 132, 790], [R.l - 4, 790]], { stage: 7 }); label(1720, 728, "逐块读取 · 不落地", "top");
    add("div", "factory", 1720, 150, `Patch Factory Backup<span>运行 ${num(D.n_runs)} 次 · 检查 ${D.checks.length} 项 · API 文档</span>`, nodeAttrs("factory", "Patch Factory Backup"));
    path([[1720, 178], [1720, 214]], { r: 0, c: "#9a9da6", m: "ahw" });
    makeComets();
    if (openId) mark(openId);
    showLive();
  }

  // ------------------------------------------------------------------ 流光：按数据流的先后一段接一段走到底
  let comets = [], playing = false, raf = 0, t0 = 0, introLeft = 1;
  const SEG_MS = 900, N_STAGE = 9, GAP = 2;      // 一段 0.9 s，走完 9 段停一下再来
  function makeComets() {
    comets = FLOWS.map(({ p, c, stage }) => {
      const q = p.cloneNode(); q.removeAttribute("marker-end"); q.removeAttribute("stroke-dasharray");
      const L = p.getTotalLength();
      q.setAttribute("stroke", c === "#ff9a3c" ? "#ffd2a6" : "#c9ffe3"); q.setAttribute("stroke-width", 3.2); q.setAttribute("stroke-opacity", 1);
      q.setAttribute("stroke-dasharray", `46 ${L + 60}`); q.setAttribute("stroke-linecap", "round"); q.setAttribute("filter", "url(#glow2)");
      q.style.opacity = 0; svg.append(q); return { q, L, stage };
    });
  }
  function frame(now) {
    if (!t0) t0 = now;
    const T = ((now - t0) / SEG_MS) % (N_STAGE + GAP);
    for (const c of comets) {
      const u = T - c.stage;
      c.q.style.opacity = u < 0 || u > 1.15 ? 0 : 1;
      c.q.setAttribute("stroke-dashoffset", 46 - Math.max(0, Math.min(1.15, u)) * (c.L + 46));
    }
    if ((now - t0) / SEG_MS >= N_STAGE + GAP) { t0 = now; if (introLeft > 0) introLeft--; }
    if (!active.length && introLeft <= 0) { playing = false; for (const c of comets) c.q.style.opacity = 0; return; }
    raf = requestAnimationFrame(frame);
  }
  function play() { if (reduce || playing) return; playing = true; t0 = 0; raf = requestAnimationFrame(frame); }

  // ------------------------------------------------------------------ 视图：按视口等比缩放；画布模式下再叠一层用户的缩放 / 平移
  let V = { s: 1, x: 0, y: 0 };
  function fit() {
    const pw = root.classList.contains("open") && innerWidth > 800 ? panel.offsetWidth : 0;
    const W = view.clientWidth - pw, H = view.clientHeight, pad = pw ? 28 : 12;
    const s = Math.min((W - pad * 2) / 1920, (H - pad * 2) / 1080);
    return { s, x: (W - 1920 * s) / 2, y: (H - 1080 * s) / 2 };
  }
  function apply() {
    const f = fit();
    world.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.s}) translate(${f.x}px, ${f.y}px) scale(${f.s})`;
    $("rf-zv").textContent = Math.round(V.s * 100) + "%";
  }
  const resetView = () => { V = { s: 1, x: 0, y: 0 }; apply(); };
  function zoomAt(cx, cy, k) {
    const s = Math.max(0.4, Math.min(3, V.s * k)); if (s === V.s) return;
    V.x = cx - (cx - V.x) * (s / V.s); V.y = cy - (cy - V.y) * (s / V.s); V.s = s;
    root.classList.add("zooming"); apply(); clearTimeout(zoomT); zoomT = setTimeout(() => root.classList.remove("zooming"), 120);
  }
  let zoomT = 0;
  const canvasOn = (on) => { root.classList.toggle("canvas", on); if (!on) resetView(); };
  addEventListener("resize", apply);

  // ------------------------------------------------------------------ 操作台
  const ORDER = ["crawl", "dataset", "clean", "issues", "passed", "grade", "slice", "segment", "patch", "pack", "delivery", "export", "stream", "factory"];
  const NAME = { crawl: "数据采集", dataset: "数据集", clean: "数据清洗", issues: "问题图片", passed: "合格", grade: "汇总 · 分级", slice: "2D 切片", segment: "3D 连续段",
                 patch: "3D patch", pack: "数据包", delivery: "数据交付", export: "训练导出", stream: "推理流", factory: "Patch Factory Backup" };
  function mark(id) { host.querySelectorAll("[data-node]").forEach((x) => x.classList.toggle("on", x.dataset.node === id)); }
  function openNode(id) {
    if (!D || !ORDER.includes(id)) return;
    const first = !root.classList.contains("open");
    openId = id; canvasOn(false);
    root.classList.add("open"); panel.setAttribute("aria-hidden", "false");
    mark(id); render(id);
    const i = ORDER.indexOf(id), pv = $("rf-prev"), nx = $("rf-next");
    pv.hidden = i === 0; nx.hidden = i === ORDER.length - 1;
    pv.querySelector("b").textContent = i > 0 ? NAME[ORDER[i - 1]] : "";
    nx.querySelector("b").textContent = i < ORDER.length - 1 ? NAME[ORDER[i + 1]] : "";
    apply();
    if (first) $("rf-close").focus({ preventScroll: true });
  }
  function closePanel() {
    if (!openId) return;
    const back = host.querySelector(`[data-node="${openId}"]`);
    openId = null; root.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); mark(null); apply();
    if (back) back.focus({ preventScroll: true });
  }
  $("rf-close").addEventListener("click", closePanel);
  $("rf-prev").addEventListener("click", () => { const i = ORDER.indexOf(openId); if (i > 0) openNode(ORDER[i - 1]); });
  $("rf-next").addEventListener("click", () => { const i = ORDER.indexOf(openId); if (i < ORDER.length - 1) openNode(ORDER[i + 1]); });

  // 小块 HTML
  const head = (crumb, title, tag, desc) => `${crumb ? `<div class="pc">${crumb}</div>` : ""}<div class="ph"><h3>${title}</h3>${tag ? `<span class="tag">${tag}</span>` : ""}</div>${desc ? `<p class="desc">${desc}</p>` : ""}`;
  const kps = (items) => `<div class="kps">${items.map(([k, v, c]) => `<div>${k}<b class="${c || ""}">${v}</b></div>`).join("")}</div>`;
  const bars = (rows, cls) => { const m = Math.max(1, ...rows.map((r) => r[1])); return rows.map(([k, v, txt]) => `<div class="cat">${esc(k)}<div class="t ${cls || ""}"><span style="width:${(v / m) * 100}%"></span></div><b>${txt ?? num(v)}</b></div>`).join(""); };
  const okRow = (txt, warn) => `<div class="ok ${warn ? "warn" : ""}"><i>${warn ? "!" : "✓"}</i>${txt}</div>`;
  const link = (href, txt) => (CAN ? `<a class="lk" href="${href}">${txt} ↗</a>` : "");
  const tabs = (names, sel) => `<div class="tabs" role="tablist">${names.map((n, i) => `<button type="button" role="tab" data-tab="${i}" aria-selected="${i === sel}">${n}</button>`).join("")}</div>`;
  const rateBox = (label, r) => `<div class="box"><div class="rate">${label}<b>${pct(r)}</b></div><div class="rbar"><span style="width:${(r || 0) * 100}%"></span></div></div>`;
  const noRun = `<p class="empty">还没有清洗结果：先在「数据集」里选一个数据集运行清洗。</p>`;

  const R = {
    crawl() {
      const p = D.crawl.presets[0] || { url: "", mip: 0 };
      const jobs = D.crawl.jobs.length ? `<table class="tb"><tr><th>#</th><th>数据集</th><th>状态</th><th>进度</th><th>时间</th></tr>${D.crawl.jobs.map((j) =>
        `<tr><td class="m">${j.id}</td><td>${esc(j.dataset_id)}</td><td><span class="st ${j.status === "done" ? "ok2" : j.status === "error" ? "bad" : ""}">${esc(j.status)}</span></td><td class="m">${num(j.n_done)} / ${num(j.n_sections)}</td><td class="m">${when(j.at)}</td></tr>`).join("")}</table>`
        : `<p class="note">还没有从公开数据采集过；现有的 ${num(D.datasets.length)} 个数据集都是本地登记的。</p>`;
      const form = CAN ? `<div class="box form"><h4>选数据来源</h4>
          <label>预设</label><select id="cw-preset">${D.crawl.presets.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join("")}</select>
          <label>卷 URL</label><input id="cw-url" value="${esc(p.url)}" spellcheck="false">
          <div class="row2"><div><label>mip</label><input id="cw-mip" type="number" min="0" value="${p.mip}"></div><div><label>说明</label><input value="${esc(p.note || "")}" disabled></div></div>
          <div id="cw-res"></div>
          <div class="acts"><button type="button" class="p" data-act="volume">查看卷信息</button><a href="/crawl">框 ROI · 注册 →</a></div></div>` : "";
      return head("数据采集", "采集与登记", `${D.crawl.presets.length} 个预设`, "从公开的电镜数据（Neuroglancer precomputed）框一块 ROI 爬下来，登记成平台里的数据集；也可以直接登记本地已有的数据。")
        + kps([["已登记数据集", num(D.datasets.length)], ["采集任务", num(D.crawl.jobs.length)], ["公开数据预设", num(D.crawl.presets.length)]])
        + form + `<div class="box"><h4>最近的采集任务</h4>${jobs}</div>` + link("/crawl", "打开完整的「数据采集」页");
    },
    dataset() {
      if (!D.datasets.length) return head("", "数据集") + `<p class="empty">这个账号能看的项目里还没有数据集。</p>`;
      const d = D.datasets.find((x) => x.dataset_id === selDs) || D.datasets[0];
      selDs = d.dataset_id;
      return head("", "数据集")
        + `<div class="box form"><h4>选择数据集，运行清洗</h4><label for="ds-sel" style="margin-top:0">数据集</label><select id="ds-sel">${D.datasets.map((x) =>
            `<option value="${esc(x.dataset_id)}" ${x.dataset_id === selDs ? "selected" : ""}>${esc(x.dataset_id)}${x.project ? ` · ${esc(x.project)}` : ""}</option>`).join("")}</select></div>`
        + kps([["切片", num(d.n_sections)], ["可用比例", pct(d.retention), "g"], ["等级", esc(d.grade || "–"), "l"]])
        + `<div class="box"><h4>${esc(d.dataset_id)}</h4><table class="tb">
            <tr><td>项目</td><td class="m">${esc(d.project || "–")}</td></tr>
            <tr><td>数据块</td><td class="m">${num(d.n_blocks)}</td></tr>
            <tr><td>质量分</td><td class="m">${d.quality != null ? d.quality.toFixed(2) : "–"}</td></tr>
            <tr><td>最近一次清洗</td><td class="m">${when(d.last_run)}</td></tr></table></div>`
        + (CAN ? `<div class="acts"><button type="button" class="p" data-act="run-ds">运行清洗 →</button><a href="/datasets/${encodeURIComponent(d.dataset_id)}">查看数据集 →</a></div><div id="ds-msg"></div>` : "")
        + `<div class="box"><h4>全部数据集</h4><table class="tb"><tr><th>数据集</th><th>切片</th><th>可用</th><th>等级</th><th>最近</th></tr>${D.datasets.map((x) =>
          `<tr data-ds="${esc(x.dataset_id)}" style="cursor:pointer${x.dataset_id === selDs ? ";background:rgba(201,184,240,.08)" : ""}"><td>${esc(x.dataset_id)}</td><td class="m">${num(x.n_sections)}</td><td class="m">${pct(x.retention)}</td><td class="m">${esc(x.grade || "–")}</td><td class="m">${when(x.last_run)}</td></tr>`).join("")}</table></div>`;
    },
    clean(tab = 0) {
      const L = D.latest;
      if (!L) return head("数据清洗", "清洗结果") + noRun;
      const top = head("数据清洗 / <b>结果详情</b>", "清洗结果") + tabs(["总览", "问题明细", "运行记录"], tab);
      let main = "";
      if (tab === 0) {
        main = kps([["总切片", num(L.n_slices)], ["合格", num(L.n_passed), "g"], ["不合格", num(L.n_failed), "y"]]) + rateBox("可用率", L.retention)
          + `<div class="box"><h4>问题分类<small>high / critical</small></h4>${L.failures.length ? bars(L.failures.slice(0, 5).map((f) => [f.zh, f.n])) : "<p class='note'>没有高等级问题。</p>"}</div>`
          + `<div class="box"><h4>处理结果</h4>${okRow(`检查结果已落库 · ${num(L.n_findings)} 条问题记录`)}${okRow(`问题截图已归档 · ${num(L.n_shots)} 张`)}${L.n_unreadable ? okRow(`有 ${num(L.n_unreadable)} 张切片读不出或缺失`, true) : ""}</div>`;
      } else if (tab === 1) {
        const st = L.stages || {};
        main = `<div class="box"><h4>每类问题<small>high / critical · 不含标为误报的</small></h4><table class="tb"><tr><th>问题</th><th>哪一步查出</th><th>条数</th></tr>${L.failures.map((f) =>
          `<tr><td>${esc(f.zh)}</td><td>${f.step === "serial_qc" ? "序列检查" : "切片检查"}</td><td class="m">${num(f.n)}</td></tr>`).join("")}</table></div>`
          + `<div class="box"><h4>每一步用时</h4>${bars([["读取 · 统计", st.ingest || 0, secs(st.ingest)], ["切片检查", st.slice_qc || 0, secs(st.slice_qc)], ["序列检查", st.serial_qc || 0, secs(st.serial_qc)],
                                                      ["汇总 · 分级", st.aggregate || 0, secs(st.aggregate)], ["落库", st.persist || 0, secs(st.persist)]], "l")}</div>`
          + `<div class="box"><h4>检查项<small>${D.checks.length} 项</small></h4><p class="note">切片级 ${D.checks.filter((c) => c.level === "slice").length} 项：${esc(D.checks.filter((c) => c.level === "slice").map((c) => c.zh).join("、"))}<br>
             序列级 ${D.checks.filter((c) => c.level !== "slice").length} 项：${esc(D.checks.filter((c) => c.level !== "slice").map((c) => c.zh).join("、"))}</p></div>`;
      } else {
        main = `<div class="box"><h4>最近的运行</h4><table class="tb"><tr><th>#</th><th>数据集</th><th>可用</th><th>问题</th><th>用时</th><th>完成</th></tr>${D.runs.map((r) =>
          `<tr><td class="m">${r.run_id}</td><td>${esc(r.dataset_id)}</td><td class="m">${pct(r.retention)}</td><td class="m">${num(r.n_findings)}</td><td class="m">${secs(r.wall_s)}</td><td class="m">${when(r.finished_at)}</td></tr>`).join("")}</table></div>`;
      }
      return top + main + `<div class="acts"><button type="button" class="p" data-go="issues">▣ 查看问题图片 →</button>${CAN ? `<button type="button" data-act="rerun">↻ 重新清洗</button>` : `<span aria-hidden="true"></span>`}</div><div id="cl-msg"></div>`
        + link("/overview", "打开总览，看每一步的结果");
    },
    issues() {
      const shots = D.examples.flatMap((e) => e.shots.map((s) => ({ ...s, zh: e.zh })));
      return head("问题图片", "问题图片", "high / critical", "清洗没通过的切片：截图按问题类型归档。合格的切片继续往后走，问题图片单独留着复核。")
        + kps([["问题", num(problems()), "o"], ["不可用切片", num(D.latest ? D.latest.n_failed : 0), "y"], ["截图", num(D.latest ? D.latest.n_shots : 0)]])
        + `<div class="box"><h4>每类多少条<small>每个数据集最近一次</small></h4>${bars(D.failures.slice(0, 8).map((f) => [f.zh, f.n]), "o")}</div>`
        + (shots.length ? `<div class="box"><h4>样例</h4><div class="shots">${shots.slice(0, 9).map((s) => `<figure><img src="${esc(s.thumb)}" alt="${esc(s.zh)}" loading="lazy"><figcaption><b>${esc(s.zh)}</b> · ${esc(s.dataset_id)} z${s.z}</figcaption></figure>`).join("")}</div></div>` : "")
        + link("/overview#ov-wall-section", "到总览里逐张确认 / 标误报");
    },
    passed() {
      const L = D.latest;
      if (!L) return head("合格", "合格切片") + noRun;
      return head("合格", "合格切片", `运行 #${L.run_id}`, "通过全部检查的切片：可以直接用于训练和推理，后面的分级、数据包都只用这些。")
        + kps([["合格", num(L.n_passed), "g"], ["可用率", pct(L.retention), "g"], ["不可用", num(L.n_failed), "y"]]) + rateBox("这次运行可用率", L.retention)
        + `<div class="box"><h4>每个数据集的可用比例</h4>${bars(D.datasets.filter((d) => d.retention != null).map((d) => [d.dataset_id, d.retention, pct(d.retention)]), "g")}</div>`;
    },
    grade() {
      const L = D.latest, g = (L && L.grades) || {};
      return head("汇总 · 分级", "汇总与分级", L ? `运行 #${L.run_id}` : "", "把每个 tile 的问题汇总起来打质量分、定等级。")
        + kps([["tile", num(Object.values(g).reduce((a, b) => a + b, 0))], ["质量分", L && L.quality != null ? L.quality.toFixed(2) : "–", "l"], ["可用率", pct(L && L.retention), "g"]])
        + `<div class="box"><h4>tile 等级</h4>${["A", "B", "C", "D"].map((x) => `<div class="cat">${x} 级<div class="t ${x === "A" || x === "B" ? "g" : x === "C" ? "" : "o"}"><span style="width:${((g[x] || 0) / Math.max(1, ...Object.values(g))) * 100}%"></span></div><b>${num(g[x] || 0)}</b></div>`).join("")}</div>`
        + `<div class="box"><h4>分级规则</h4><p class="note">A：可用 ≥ 95% 且没有致命问题　B：可用 ≥ 85%　C：可用 ≥ 60%　D：可用 &lt; 60% 或整块出问题</p></div>`;
    },
    slice() { return levelPanel("slice"); }, segment() { return levelPanel("segment"); }, patch() { return levelPanel("patch"); },
    pack() {
      const P = D.plan, ready = P && P.cells ? P.cells.filter((c) => c.ready) : [];
      const packs = D.exports.filter((x) => x.kind === "pack");
      return head("数据包", "训练数据包", P ? esc(P.dataset_id) : "", "按「用途 × 形态」把合格的切片打成训练侧拿到就能用的包：带标签、train / val / test 划分和索引。")
        + kps([["能做的格子", num(ready.length)], ["已生成", num(D.delivery.n_packs)], ["样本", num(D.delivery.pack_samples)]])
        + (P && P.error ? `<div class="res err">${esc(P.error)}</div>` : `<div class="box"><h4>原图 · 三种形态</h4>${bars(["slice", "segment", "patch"].map((lv) => [LEVEL_ZH[lv], rawN(lv) || 0]), "l")}</div>`)
        + `<div class="box"><h4>最近生成的数据包</h4>${packs.length ? `<table class="tb"><tr><th>#</th><th>数据集</th><th>状态</th><th>样本</th><th>大小</th><th>时间</th></tr>${packs.map((x) => `<tr><td class="m">${x.id}</td><td>${esc(x.dataset_id)}</td><td><span class="st ${x.status === "done" ? "ok2" : x.status === "error" ? "bad" : ""}">${esc(x.status)}</span></td><td class="m">${num(x.n_sections)}</td><td class="m">${mb(x.n_bytes)}</td><td class="m">${when(x.at)}</td></tr>`).join("")}</table>` : "<p class='note'>还没有生成过。</p>"}</div>`
        + (CAN && P && !P.error ? `<div class="acts"><button type="button" class="p" data-act="pack">生成原图数据包</button><a href="/training">选用途 · 形态 →</a></div><div id="pk-msg"></div>` : "")
        + link("/training", "打开「训练数据包」页");
    },
    delivery() {
      const d = D.delivery;
      return head("数据交付", "数据交付", "", "把数据交出去：离线的训练导出（写成分片文件），以及在线的推理流（逐块读，不落地）。")
        + kps([["训练导出", `${num(d.n_shard_jobs)} 次`], ["导出切片", num(d.shard_sections), "g"], ["推理流", `${num(d.n_streams)} 个`]])
        + `<div class="box"><h4>交付量</h4>${okRow(`训练分片 ${num(d.shard_sections)} 张 · ${mb(d.shard_bytes)}`)}${okRow(`数据包 ${num(d.n_packs)} 个 · ${num(d.pack_samples)} 个样本 · ${mb(d.pack_bytes)}`)}${okRow(`推理流 ${num(d.stream_chunks)} 块 · ${mb(d.stream_bytes)}`)}</div>`
        + link("/delivery", "打开「数据交付」页");
    },
    export() {
      const xs = D.exports.filter((x) => x.kind === "shards");
      return head("数据交付 / <b>训练导出</b>", "训练导出", `${num(D.delivery.n_shard_jobs)} 次`)
        + kps([["切片", num(D.delivery.shard_sections), "g"], ["大小", mb(D.delivery.shard_bytes)]])
        + `<div class="box"><h4>最近的导出</h4>${xs.length ? `<table class="tb"><tr><th>#</th><th>数据集</th><th>状态</th><th>切片</th><th>大小</th><th>时间</th></tr>${xs.map((x) =>
          `<tr><td class="m">${x.id}</td><td>${esc(x.dataset_id)}</td><td><span class="st ${x.status === "done" ? "ok2" : x.status === "error" ? "bad" : ""}">${esc(x.status)}</span></td><td class="m">${num(x.n_sections)}</td><td class="m">${mb(x.n_bytes)}</td><td class="m">${when(x.at)}</td></tr>`).join("")}</table>` : "<p class='note'>还没有导出过。</p>"}</div>`
        + link("/delivery", "去导出");
    },
    stream() {
      return head("数据交付 / <b>推理流</b>", "推理流", `${num(D.delivery.n_streams)} 个`, "推理侧按块拉数据：每块读完确认一次，数据不在本地生成副本。")
        + kps([["已传", `${num(D.delivery.stream_chunks)} 块`, "g"], ["传输中", num(D.streams.filter((x) => x.status === "open").length), "y"], ["大小", mb(D.delivery.stream_bytes)]])
        + `<div class="box"><h4>最近的推理流</h4>${D.streams.length ? `<table class="tb"><tr><th>#</th><th>数据集</th><th>状态</th><th>进度</th><th>开始</th></tr>${D.streams.map((x) =>
          `<tr><td class="m">${x.id}</td><td>${esc(x.dataset_id)}</td><td><span class="st ${x.status === "done" ? "ok2" : x.status === "aborted" ? "bad" : ""}">${x.status === "open" ? "传输中" : esc(x.status)}</span></td><td class="m">${num(x.n_acked)} / ${num(x.n_items)}</td><td class="m">${when(x.at)}</td></tr>`).join("")}</table>` : "<p class='note'>还没有推理流。</p>"}</div>`
        + link("/delivery", "打开「数据交付」页");
    },
    factory() {
      return head("Patch Factory Backup", "运行 · 检查 · 接口", "", "平台的后台：每一次清洗的运行记录、全部检查项，以及给训练 / 推理侧用的 API。")
        + kps([["运行", num(D.n_runs)], ["出错", num(D.n_runs_error), D.n_runs_error ? "o" : ""], ["检查项", num(D.checks.length), "l"]])
        + ["slice", "serial"].map((lv) => { const cs = D.checks.filter((c) => (lv === "slice") === (c.level === "slice"));
            return `<div class="box"><h4>${lv === "slice" ? "切片级检查" : "序列级检查"}<small>${cs.length} 项 · 悬停看说明</small></h4><div class="chips">${cs.map((c) => `<span title="${esc(c.description || "")}">${esc(c.zh)}</span>`).join("")}</div></div>`; }).join("")
        + (CAN ? `<div class="acts"><a class="p" href="/pipeline">运行记录 →</a><a href="/docs">API 文档 →</a></div>` + link("/checks", "检查项详情") : "");
    },
  };
  function levelPanel(lv) {
    const cells = cellsOf(lv), ready = cells.filter((c) => c.ready);
    return head(`数据包 / <b>${LEVEL_ZH[lv]}</b>`, LEVEL_ZH[lv], D.plan ? esc(D.plan.dataset_id) : "",
      { slice: "每张合格切片裁成所在 tile 大小的 2D 图（PNG + 同尺寸标签）。", segment: "块里连续合格的切片段，切成 (n, H, W) 的 3D 数组。", patch: "固定大小的 3D 小体块，带采样与验收规则。" }[lv])
      + kps([["能做的用途", `${ready.length} / ${cells.length}`], ["原图样本", num(rawN(lv))], ["原图大小", mb((cells.find((c) => c.task === "raw" && c.ready) || {}).est_bytes)]])
      + `<div class="box"><h4>每种用途</h4><table class="tb"><tr><th>用途</th><th>样本</th><th>大小</th></tr>${cells.map((c) => {
          const t = (D.plan.tasks || []).find((x) => x.task === c.task);
          return c.ready ? `<tr><td>${esc(t ? t.zh : c.task)}</td><td class="m">${num(c.n)}</td><td class="m">${mb(c.est_bytes)}</td></tr>`
            : `<tr><td>${esc(t ? t.zh : c.task)}</td><td class="w" colspan="2"><span class="st">${esc(c.reason || "不能做")}</span></td></tr>`; }).join("")}</table></div>`
      + link("/training", "去生成数据包");
  }
  let cleanTab = 0, selDs = null;
  function render(id) {
    if (id !== "clean") cleanTab = 0;
    body.innerHTML = id === "clean" ? R.clean(cleanTab) : R[id]();
    body.scrollTop = 0;
  }

  // 操作台里的按钮
  async function post(url, data) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error("需要审核员权限才能做这件事");
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : (d.detail && d.detail.message) || `出错了（${r.status}）`);
    return d;
  }
  const say = (id, txt, err) => { const el = $(id); if (el) el.innerHTML = `<div class="res ${err ? "err" : ""}">${esc(txt)}</div>`; };
  body.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { cleanTab = +tab.dataset.tab; render("clean"); return; }
    const row = e.target.closest("[data-ds]");
    if (row) { selDs = row.dataset.ds; render("dataset"); return; }
    const go = e.target.closest("[data-go]");
    if (go) { openNode(go.dataset.go); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    b.disabled = true;
    try {
      if (act === "volume") {
        const r = await fetch(`/api/v1/crawl/volume?url=${encodeURIComponent($("cw-url").value.trim())}&mip=${encodeURIComponent($("cw-mip").value || 0)}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 403 ? "需要审核员权限" : typeof d.detail === "string" ? d.detail : `读不到这个卷（${r.status}）`);
        say("cw-res", `大小 ${d.size_xyz.join(" × ")}（x × y × z）\n分辨率 ${d.resolution_nm.join(" × ")} nm · ${d.encoding}${d.lossy ? "（有损）" : ""}\n块 ${d.chunk_xyz.join(" × ")} · ${d.dtype} · 共 ${d.n_mips} 级 mip`);
      } else if (act === "rerun" || act === "run-ds") {
        const ds = act === "run-ds" ? selDs : D.latest.dataset_id;
        const d = await post("/api/v1/qc/runs", { dataset_id: ds });
        say(act === "run-ds" ? "ds-msg" : "cl-msg", `运行 #${d.run_id} 已开始（${ds}），流程线上会有流光，跑完数字自动更新。`);
        poll();
      } else if (act === "pack") {
        const cells = ["slice", "segment", "patch"].filter((lv) => rawN(lv)).map((lv) => ["raw", lv]);
        const d = await post("/api/v1/packs", { dataset_id: D.plan.dataset_id, cells });
        say("pk-msg", `已开始生成（任务 #${d.job_id ?? d.id}），在「训练数据包」页看进度。`);
      }
    } catch (err) {
      say(act === "volume" ? "cw-res" : act === "pack" ? "pk-msg" : act === "run-ds" ? "ds-msg" : "cl-msg", err.message || "出错了", true);
    } finally { b.disabled = false; }
  });
  body.addEventListener("change", (e) => {
    if (e.target.id === "ds-sel") { selDs = e.target.value; render("dataset"); return; }
    if (e.target.id === "cw-preset") { const p = D.crawl.presets[+e.target.value]; $("cw-url").value = p.url; $("cw-mip").value = p.mip; }
  });

  // ------------------------------------------------------------------ 指针：点节点 / 单击空白进画布 / 拖动 / 滚轮 / 双击
  let down = null;
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".rf-hud, .rf-tools, a, button")) return;
    down = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y, moved: false, node: e.target.closest("[data-node]") };
  });
  addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 4 && root.classList.contains("canvas")) { down.moved = true; root.classList.add("dragging"); view.setPointerCapture?.(e.pointerId); }
    if (down.moved) { V.x = down.vx + dx; V.y = down.vy + dy; apply(); }
  });
  addEventListener("pointerup", () => {
    if (!down) return;
    const d = down; down = null; root.classList.remove("dragging");
    if (d.moved) return;
    if (d.node) openNode(d.node.dataset.node);
    else if (openId) closePanel();
    else canvasOn(true);
  });
  view.addEventListener("wheel", (e) => {
    if (!root.classList.contains("canvas")) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015));
  }, { passive: false });
  view.addEventListener("dblclick", (e) => { if (!e.target.closest("[data-node], .rf-hud") && root.classList.contains("canvas")) resetView(); });
  $("rf-hud").addEventListener("click", (e) => {
    const b = e.target.closest("[data-z]"); if (!b) return;
    const z = +b.dataset.z;
    if (!z) resetView(); else zoomAt(view.clientWidth / 2, view.clientHeight / 2, z > 0 ? 1.25 : 0.8);
  });
  host.addEventListener("keydown", (e) => {
    const n = e.target.closest("[data-node]");
    if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openNode(n.dataset.node); }
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (openId) closePanel(); else if (root.classList.contains("canvas")) canvasOn(false); }
    else if (openId && !e.target.closest("input, select, textarea")) {
      if (e.key === "ArrowLeft") $("rf-prev").click(); else if (e.key === "ArrowRight") $("rf-next").click();
    }
  });

  // ------------------------------------------------------------------ 正在跑的清洗
  function showLive() {
    const live = $("rf-live"), bar = $("rf-run"), r = active[0];
    if (live) live.textContent = r ? `运行中 · ${r.n_blocks_done}/${r.n_blocks || "?"} 块` : "";
    bar.hidden = !r;
    if (r) bar.textContent = `清洗运行中 · #${r.run_id} · ${r.dataset_id}${r.stage ? " · " + r.stage.split(" · ")[0] : ""} · ${r.n_blocks_done}/${r.n_blocks || "?"} 块`;
  }
  let pollT = 0;
  async function poll() {
    clearTimeout(pollT);
    try {
      const r = await fetch("/api/v1/report/active");
      if (r.ok) {
        const was = active.length;
        active = (await r.json()).runs || [];
        showLive();
        if (active.length) play();
        if (was && !active.length) await load();   // 跑完了：数字刷新
      }
    } catch { /* 网络抖一下：下次再试 */ }
    pollT = setTimeout(poll, document.hidden ? 15000 : 4000);
  }

  async function load() {
    const msg = $("rf-msg");
    try {
      const r = await fetch("/api/v1/report/flow");
      if (!r.ok) throw new Error(r.status);
      D = await r.json();
      if (!selDs && D.latest) selDs = D.latest.dataset_id;
      msg.hidden = true;
      build(); apply();
      if (openId) render(openId);
    } catch {
      msg.hidden = false; msg.textContent = "流程图的数据没取到，稍后刷新再试。";
    }
  }
  apply();
  load().then(() => { play(); poll(); });
})();
