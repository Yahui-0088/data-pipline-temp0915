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
      <marker id="ahg" viewBox="0 0 13 10" refX="1" refY="5" markerWidth="13" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L13 5 L0 10 Z" fill="#3fdf93"/></marker>
      <marker id="aho" viewBox="0 0 13 10" refX="1" refY="5" markerWidth="13" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L13 5 L0 10 Z" fill="#ff9a3c"/></marker>
      <marker id="ahw" viewBox="0 0 13 10" refX="1" refY="5" markerWidth="13" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L13 5 L0 10 Z" fill="#9a9da6"/></marker>
      <filter id="glow2" filterUnits="userSpaceOnUse" x="0" y="0" width="1920" height="1080"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
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
    // 线停在箭头底边，三角形尖头正好落在终点（细线 + 小实心三角）
    const [ex, ey] = pts.at(-1), [px, py] = pts.at(-2), el = Math.hypot(ex - px, ey - py) || 1, AH = 12;
    d += ` L ${ex - (ex - px) / el * AH} ${ey - (ey - py) / el * AH}`;
    const c = opt.c || "#3fdf93";
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", c); p.setAttribute("stroke-width", opt.w || 3); p.setAttribute("stroke-opacity", opt.o ?? 0.85);
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
    if (sub) add("div", "hcap", cx, y0 + h + lift + 34, `<span>${sub}</span>`);
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
    const A = node("crawl", 170, 300, 200, "数据采集", "", "数据采集");
    const ds = holo("dataset", 470, 300, 240, "/static/report-flow/em_block.png", 401 / 640, [[.0176, .5026], [.5048, .9949], [.9952, .5982]],
      "DATASET", "", "#c9b8f0");
    path([[A.r + 2, 300], [ds.l + 4, 300]], { stage: 0 }); label((A.r + ds.l) / 2, 278, "写入数据集");
    // 数据清洗：菱形判断
    const dm = add("div", "diamond", 470, 560, `<svg viewBox="0 0 230 150"><polygon points="115,2 228,75 115,148 2,75" fill="#0b0b08" stroke="#f3e27a" stroke-width="2" stroke-dasharray="7 6"/></svg>
      <span>数据清洗<small>${D.checks.length} 项检查 · ${L ? num(L.n_slices) + " 张" : "还没有结果"}</small></span>`, nodeAttrs("clean", "数据清洗"));
    dm.id = "rf-clean";
    path([[470, ds.b + 30], [470, 560 - 77]], { stage: 1 }); label(530, (ds.b + 30 + 483) / 2, "读取切片");
    const G = node("passed", 470, 820, 200, L ? `合格 ${num(L.n_passed)} 张<small>可用率 ${pct(L.retention)}</small>` : "合格<small>–</small>", "green", "合格");
    path([[470, 560 + 77], [470, G.t - 4]], { stage: 2 }); label(505, (637 + G.t) / 2, "通过");
    const Q = node("issues", 170, 820, 200, `问题图片<small>${num(problems())} 条 · 截图 ${num(L ? L.n_shots : 0)}</small>`, "org", "问题图片");
    path([[470 - 117, 560], [170, 560], [170, Q.t - 4]], { c: "#ff9a3c", m: "aho", stage: 2 }); label(262, 538, "不通过", "org");
    // 汇总分级 → 三种形态 → 格式 → 数据包
    const S = node("grade", 800, 560, 200, `汇总 · 分级<small>${L ? gradeTxt(L.grades) : "–"}</small>`, "dark", "汇总分级");
    path([[G.r + 2, 820], [640, 820], [640, 560], [S.l - 6, 560]], { stage: 3 });
    const FX = 1090, CX2 = 1290, BX = 1430;
    for (const [lv, y] of [["slice", 300], ["segment", 560], ["patch", 820]]) {
      path(y === 560 ? [[S.r + 2, 560], [FX - 106, 560]] : [[S.r + 2, 560], [945, 560], [945, y], [FX - 106, y]], { stage: 4 });
      icon(FX, y - 62, ICONS[lv]);
      const n = rawN(lv);
      node(lv, FX, y, 200, `${LEVEL_ZH[lv]}<small>${n == null ? "–" : num(n) + (lv === "slice" ? " 张" : lv === "segment" ? " 段" : " 个")}</small>`, "", LEVEL_ZH[lv]);
      node(null, CX2, y, 120, "npy / png", "chip");
      path([[FX + 102, y], [CX2 - 64, y]], { r: 0, stage: 5 });
      path([[CX2 + 62, y], [BX - 4, y]], { r: 0, stage: 6 });
    }
    const bar = add("div", "bar", BX, 240, `<div>数据包<small>原图<br>train / val / test<br>${esc(D.plan ? D.plan.dataset_id : "–")}<br>已生成 ${num(dl.n_packs)} 个</small></div>`, nodeAttrs("pack", "数据包"));
    Object.assign(bar.style, { width: "130px", height: "640px" });
    // 交付
    const dv = holo("delivery", 1720, 300, 240, "/static/report-flow/stack_block.png", 391 / 520, [[.0017, .5556], [.457, .9978], [.9975, .6656]], "DELIVERY", "数据交付", "#7ff0b8");
    path([[BX + 132, 300], [1720 - 126, 300]], { stage: 7 });
    const T = node("export", 1720, 560, 240, `训练导出<small>${num(dl.n_shard_jobs)} 次 · ${num(dl.shard_sections)} 张 · ${mb(dl.shard_bytes)}</small>`, "teal", "训练导出");
    path([[1720, dv.b + 70], [1720, T.t - 4]], { r: 0, stage: 8 });
    const nOpen = D.streams.filter((x) => x.status === "open").length;
    const R = node("stream", 1720, 820, 240, `推理流<small>${num(dl.n_streams)} 个 · ${num(dl.stream_chunks)} 块 · ${nOpen} 个传输中</small>`, "", "推理流");
    path([[BX + 132, 820], [R.l - 4, 820]], { stage: 7 }); label(1720, 760, "逐块读取 · 不落地", "top");
    add("div", "factory", 1720, 128, `Patch Factory Backup<span>运行 ${num(D.n_runs)} 次 · 检查 ${D.checks.length} 项 · API 文档</span>`, nodeAttrs("factory", "Patch Factory Backup"));
    path([[1720, 156], [1720, 196]], { r: 0, c: "#9a9da6", m: "ahw" });
    makeComets();
    if (openId) mark(openId);
    showLive();
  }

  // ------------------------------------------------------------------ 流光：按数据流的先后一段接一段走到底
  let comets = [], playing = false, raf = 0, t0 = 0, introLeft = 0;   // 打开页面不放流光，只在清洗运行时放
  const SEG_MS = 900, N_STAGE = 9, GAP = 2;      // 一段 0.9 s，走完 9 段停一下再来
  function makeComets() {
    comets = FLOWS.map(({ p, c, stage }) => {
      const q = p.cloneNode(); q.removeAttribute("marker-end"); q.removeAttribute("stroke-dasharray");
      const L = p.getTotalLength();
      q.setAttribute("stroke", c === "#ff9a3c" ? "#ffd2a6" : "#c9ffe3"); q.setAttribute("stroke-width", 4.6); q.setAttribute("stroke-opacity", 1);
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
  // 数据集可用比例：横向条形图 + 0–100% 坐标轴；点一根条 = 选中这个数据集；悬停看切片数 / 等级 / 最近一次清洗
  function dsChart() {
    const ds = D.datasets, W = 520, L = 176, R = 446, row = 38, top = 10, H = top + ds.length * row + 34;
    const X = (v) => L + (R - L) * Math.max(0, Math.min(1, v || 0));
    const ticks = [0, .25, .5, .75, 1].map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${top - 4}" y2="${top + ds.length * row}" class="gd"/>
      <text x="${X(v)}" y="${top + ds.length * row + 20}" text-anchor="middle" class="ax">${v * 100}%</text>`).join("");
    const bars = ds.map((x, i) => {
      const y = top + i * row + row / 2, v = x.retention, on = x.dataset_id === selDs, w = Math.max(0, X(v) - L);
      return `<g class="dsb ${on ? "on" : ""}" ${CAN ? `data-ds="${esc(x.dataset_id)}"` : ""} data-tip="${esc(x.dataset_id)}|${num(x.n_sections)}|${pct(v)}|${esc(x.grade || "–")}|${when(x.last_run)}">
        <rect x="0" y="${y - row / 2}" width="${W}" height="${row}" class="hit"/>
        <text x="${L - 12}" y="${y + 4}" text-anchor="end" class="nm">${esc(x.dataset_id)}</text>
        <rect x="${L}" y="${y - 7}" width="${R - L}" height="14" rx="4" class="tr"/>
        ${v == null ? "" : `<rect x="${L}" y="${y - 7}" width="${w}" height="14" rx="4" class="br"/>`}
        <text x="${R + 10}" y="${y + 4}" class="vl">${v == null ? "未清洗" : pct(v)}<tspan class="gr"> ${esc(x.grade || "")}</tspan></text></g>`;
    }).join("");
    return `<div class="box dsc"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="各数据集可用比例">${ticks}${bars}</svg><div class="tip" hidden></div></div>`;
  }
  const noRun = `<p class="empty">还没有清洗结果：先在「数据集」里选一个数据集运行清洗。</p>`;

  const R = {
    crawl() {
      const p = D.crawl.presets[0] || { url: "", mip: 0 };
      const jobs = D.crawl.jobs.length ? `<table class="tb"><tr><th>#</th><th>数据集</th><th>状态</th><th>进度</th><th>时间</th></tr>${D.crawl.jobs.map((j) =>
        `<tr><td class="m">${j.id}</td><td>${esc(j.dataset_id)}</td><td><span class="st ${j.status === "done" ? "ok2" : j.status === "error" ? "bad" : ""}">${esc(j.status)}</span></td><td class="m">${num(j.n_done)} / ${num(j.n_sections)}</td><td class="m">${when(j.at)}</td></tr>`).join("")}</table>`
        : "";
      const top = head("", "数据采集与注册", `${D.crawl.presets.length} 个预设`)
        + kps([["已登记数据集", num(D.datasets.length)], ["采集任务", num(D.crawl.jobs.length)], ["公开数据预设", num(D.crawl.presets.length)]]);
      const jobBox = jobs ? `<div class="box"><h4>最近的采集任务</h4>${jobs}</div>` : "";
      if (!CAN) return top + jobBox;
      const step = (n, t) => `<h4><span class="stepn">${n}</span>${t}</h4>`;
      return top
        // 1 · 卷信息：看分辨率、尺寸、编码，不下载体素
        + `<div class="box form">${step(1, "URL")}
            <label>预设</label><select id="cw-preset">${D.crawl.presets.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join("")}</select>
            <div class="row2r"><div><label>卷 URL</label><input id="cw-url" value="${esc(p.url)}" spellcheck="false"></div><div><label>mip</label><input id="cw-mip" type="number" min="0" value="${p.mip}"></div></div>
            <div class="acts one"><button type="button" class="p" data-act="volume">查看</button></div><div id="cw-res"></div></div>`
        // 2 · ROI 预判：用组织类型图几秒判断这块值不值得爬
        + `<div class="box form">${step(2, "ROI")}
            <label>ROI</label><input id="cw-roi" value="260000-260512,210000-210512,2600-2632" spellcheck="false">
            <label>组织类型图 URL</label><input id="cw-mask" value="${esc(p.mask_url || "")}" spellcheck="false">
            <div class="acts one"><button type="button" class="p" data-act="precheck">预判</button></div><div id="cw-pre"></div></div>`
        // 3 · 注册 / 下载
        + `<div class="box form">${step(3, "数据集注册")}
            <div class="row2e"><div><label>dataset_id</label><input id="cw-dsid" placeholder="h01_roi_x260k" spellcheck="false"></div><div><label>分割卷</label><input id="cw-seg" value="${esc(p.seg_url || "")}" spellcheck="false"></div></div>
            <div class="row3"><div><label>物种</label><input id="cw-sp" value="${esc(p.species || "")}"></div><div><label>脑区</label><input id="cw-br" value="${esc(p.brain_region || "")}"></div><div><label>分割 mip</label><input id="cw-segmip" type="number" min="0" value="${p.seg_mip ?? 0}"></div></div>
            <label class="chk"><input type="checkbox" id="cw-req"> 预判不合格则拒绝</label>
            <div class="acts"><button type="button" class="p" data-act="register">注册（不下载）</button><button type="button" data-act="fetch">下载落盘</button></div><div id="cw-reg"></div></div>`
        + jobBox + link("/crawl", "打开完整的「数据采集」页");
    },
    dataset() {
      const k = D.kpi;
      const top = head("", "数据集", `${num(k.n_datasets)} 个`);
      if (!D.datasets.length) return top + `<p class="empty">这个账号能看的项目里还没有数据集。</p>`;
      if (!D.datasets.some((x) => x.dataset_id === selDs)) selDs = D.datasets[0].dataset_id;
      // 选择数据集 → 运行清洗；下面是每个数据集的清洗记录（点一行也能选中）
      const pick = CAN ? `<div class="box form"><h4>选择数据集</h4><select id="ds-sel" aria-label="数据集">${D.datasets.map((x) =>
            `<option value="${esc(x.dataset_id)}" ${x.dataset_id === selDs ? "selected" : ""}>${esc(x.dataset_id)}${x.project ? ` · ${esc(x.project)}` : ""}</option>`).join("")}</select>
          <div class="acts"><button type="button" class="p" data-act="run-ds">运行清洗 →</button><a href="/datasets/${encodeURIComponent(selDs)}">查看数据集 →</a></div><div id="ds-msg"></div></div>` : "";
      return top + pick + dsChart();
    },
    clean() {
      const top = head("", "数据清洗", `${D.checks.length} 项检查`);
      if (!D.datasets.length) return top + `<p class="empty">这个账号能看的项目里还没有数据集，先在「数据采集」里注册一个。</p>`;
      if (!D.datasets.some((x) => x.dataset_id === selDs)) selDs = D.datasets[0].dataset_id;
      const sel = `<select id="cl-ds" aria-label="数据集">${D.datasets.map((x) => `<option value="${esc(x.dataset_id)}" ${x.dataset_id === selDs ? "selected" : ""}>${esc(x.dataset_id)}${x.project ? ` · ${esc(x.project)}` : ""}</option>`).join("")}</select>`;
      // 清洗设置：数据集 + block 范围 + 检查项（全不选 = 全部）
      const cfg = CAN ? `<div class="box form"><h4>清洗设置</h4>
          <label>数据集</label>${sel}
          <label class="hint"><span class="lt">block 范围</span><span class="ht">留空 = 全部；填 block id，逗号分隔</span></label><input id="cl-blocks" placeholder="z00000-00099_y00000_x00000, …" spellcheck="false">
          <label class="hint"><span class="lt">检查项</span><span class="ht">全不选 = 全选</span></label>
          <div class="chks">${D.checks.map((c) => `<label class="${c.implemented === false ? "stub" : ""}"><input type="checkbox" name="cl-chk" value="${esc(c.name)}"><code>${esc(c.name)}</code><span>${esc(c.zh)}</span><em>${c.level === "slice" ? "切片" : "序列"}${c.implemented === false ? " · 未实现" : ""}</em></label>`).join("")}</div>
          <div class="acts one"><button type="button" class="p" data-act="run-cl">运行清洗 →</button></div><div id="cl-msg"></div></div>` : `<div class="box form"><label>数据集</label>${sel}</div>`;
      // 清洗记录：所选数据集的每一次运行
      const rs = D.runs.filter((r) => r.dataset_id === selDs);
      const grades = (g) => Object.entries(g || {}).sort().map(([k, n]) => `${esc(k)}×${n}`).join(" ") || "–";
      const rec = `<div class="box"><h4>清洗记录<small>${esc(selDs)} · ${rs.length} 次</small>${rs.length ? `<button type="button" class="dl" data-csv="1" aria-label="导出清洗记录 CSV"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>导出</button>` : ""}</h4>${rs.length ? `<table class="tb"><tr><th>#</th><th>切片</th><th>可用</th><th>等级</th><th>问题</th><th>用时</th><th>完成</th></tr>${rs.map((r) =>
          `<tr><td class="m">${CAN ? `<a href="/runs/${r.run_id}">${r.run_id}</a>` : r.run_id}</td><td class="m">${num(r.n_sections)}</td><td class="m">${pct(r.retention)}</td><td class="m">${grades(r.grades)}</td><td class="m">${num(r.n_findings)}</td><td class="m">${secs(r.wall_s)}</td><td class="m">${when(r.finished_at)}</td></tr>`).join("")}</table>`
          : `<p class="note">这个数据集还没清洗过。</p>`}</div>`;
      return top + cfg + rec;
    },
    issues() {
      const A = D.albums || [];
      // 相册：每类问题一个文件夹；悬停时三张图从夹子里冒出一点；点图 → 屏幕中央大图，滚轮翻前后
      const albums = A.length ? `<div class="box"><h4>样例图片<a class="dl" href="/api/v1/report/issues.zip" title="导出全部问题图片（按类型分文件夹的 zip）" aria-label="导出问题图片压缩包"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>导出</a></h4><div class="albums">${A.map((a, ai) =>
        `<button type="button" class="alb" data-alb="${ai}" aria-label="${esc(a.zh)}，${a.shots.length} 张">
          <span class="fb"></span>
          ${a.shots.slice(0, 3).map((s, i) => `<img class="pp p${i}" src="${esc(s.src)}" alt="" loading="lazy" data-alb="${ai}" data-i="${i}">`).join("")}
          <span class="ff"><b>${esc(a.zh)}</b><em>${num(a.shots.length)} 张${a.n > a.shots.length ? ` / ${num(a.n)} 条` : ""}</em></span>
        </button>`).join("")}</div></div>` : `<div class="box"><h4>样例图片</h4><p class="note">最近一次清洗没有留下问题截图。</p></div>`;
      return head("", "问题图片")
        + kps([["严重问题图片", num(problems()), "o"], ["不可用切片", num(D.latest ? D.latest.n_failed : 0), "y"], ["截图", num(D.latest ? D.latest.n_shots : 0)]])
        + albums
        + `<div class="box"><h4>问题统计</h4>${D.failures.length ? bars(D.failures.slice(0, 8).map((f) => [f.zh, f.n]), "o") : "<p class='note'>没有高等级问题。</p>"}</div>`;
    },
    passed() {
      const L = D.latest;
      if (!L) return head("", "合格切片") + noRun;
      return head("", "合格切片", `运行 #${L.run_id}`)
        + kps([["合格", num(L.n_passed), "g"], ["可用率", pct(L.retention), "g"], ["不可用", num(L.n_failed), "y"]]) + rateBox("这次运行可用率", L.retention)
        + `<div class="box"><h4>当前每个数据集的可用比例</h4>${bars(D.datasets.filter((d) => d.retention != null).map((d) => [d.dataset_id, d.retention, pct(d.retention)]), "g")}</div>`;
    },
    grade() {
      const L = D.latest, g = (L && L.grades) || {};
      return head("", "汇总与分级", L ? `运行 #${L.run_id}` : "")
        + kps([["tile", num(Object.values(g).reduce((a, b) => a + b, 0))], ["质量分", L && L.quality != null ? L.quality.toFixed(2) : "–", "l"], ["可用率", pct(L && L.retention), "g"]]).replace('class="kps"', 'class="kps mini"')
        + `<div class="box"><h4>tile 等级<span class="rule" tabindex="0" aria-describedby="rule-tip">分级规则<i aria-hidden="true">?</i><span class="rtip" role="tooltip" id="rule-tip"><b>A</b>可用 ≥ 95% 且没有致命问题<br><b>B</b>可用 ≥ 85%<br><b>C</b>可用 ≥ 60%<br><b>D</b>可用 &lt; 60% 或整块出问题</span></span></h4>${["A", "B", "C", "D"].map((x) => `<div class="cat">${x} 级<div class="t ${x === "A" || x === "B" ? "g" : x === "C" ? "" : "o"}"><span style="width:${((g[x] || 0) / Math.max(1, ...Object.values(g))) * 100}%"></span></div><b>${num(g[x] || 0)}</b></div>`).join("")}</div>`; 
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
    const ex = CAN && ready.length ? `<button type="button" class="dl hd" data-act="pack-lv" data-lv="${lv}" aria-label="导出${LEVEL_ZH[lv]}数据包"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>导出</button>` : "";
    return head("", LEVEL_ZH[lv]).replace("</h3>", "</h3>" + ex)
      + kps([["能做的用途", `${ready.length} / ${cells.length}`], ["原图样本", num(rawN(lv))], ["原图大小", mb((cells.find((c) => c.task === "raw" && c.ready) || {}).est_bytes)]])
      + `<div class="box"><h4>每种用途</h4><table class="tb lg"><tr><th>用途</th><th>样本</th><th>大小</th></tr>${cells.map((c) => {
          const t = (D.plan.tasks || []).find((x) => x.task === c.task);
          return c.ready ? `<tr><td>${esc(t ? t.zh : c.task)}</td><td class="m">${num(c.n)}</td><td class="m">${mb(c.est_bytes)}</td></tr>`
            : `<tr><td>${esc(t ? t.zh : c.task)}</td><td class="w" colspan="2"><span class="st">${esc(c.reason || "不能做")}</span></td></tr>`; }).join("")}</table></div>`
      + `<div id="pk-msg"></div>`;
  }
  let selDs = null;
  function render(id) {
    body.innerHTML = R[id]();
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
  // 清洗记录导出为 CSV（所选数据集的每一次运行）；带 BOM，Excel 打开中文不乱码
  function exportRuns() {
    const rs = D.runs.filter((r) => r.dataset_id === selDs);
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["运行编号", "数据集", "切片数", "可用比例", "等级", "问题数", "用时(秒)", "完成时间"];
    const lines = rs.map((r) => [r.run_id, r.dataset_id, r.n_sections, r.retention == null ? "" : (r.retention * 100).toFixed(1) + "%",
      Object.entries(r.grades || {}).sort().map(([k, n]) => `${k}×${n}`).join(" "), r.n_findings, r.wall_s == null ? "" : (+r.wall_s).toFixed(1), (r.finished_at || "").replace("T", " ")].map(q).join(","));
    const blob = new Blob(["\ufeff" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `clean-runs-${selDs.replace(/[^\w.-]+/g, "_")}.csv`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // 大图：屏幕中央显示一张，滚轮 / ← → 翻同一类的前后张，Esc 或点空白关闭
  let LB = null;
  function lightbox(ai, i) {
    const a = (D.albums || [])[ai]; if (!a || !a.shots.length) return;
    if (!LB) {
      LB = document.createElement("div"); LB.className = "rf-lb"; LB.setAttribute("role", "dialog"); LB.setAttribute("aria-modal", "true");
      LB.innerHTML = `<button type="button" class="lb-x" aria-label="关闭">✕</button><button type="button" class="lb-a lb-p" aria-label="上一张">‹</button>
        <figure><img alt=""><figcaption></figcaption></figure><button type="button" class="lb-a lb-n" aria-label="下一张">›</button>`;
      document.body.append(LB);
      LB.addEventListener("click", (e) => {
        if (e.target.closest(".lb-p")) step(-1); else if (e.target.closest(".lb-n")) step(1); else if (!e.target.closest("img")) closeLb();
      });
      let wheelT = 0;
      LB.addEventListener("wheel", (e) => { e.preventDefault(); const now = Date.now(); if (now - wheelT < 180) return; wheelT = now; step(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1); }, { passive: false });
    }
    LB.a = a; LB.i = i; show();
    requestAnimationFrame(() => LB.classList.add("on"));
  }
  function show() {
    const s = LB.a.shots[LB.i], img = LB.querySelector("img");
    img.src = s.src; img.alt = `${LB.a.zh} · ${s.dataset_id} z${s.z}`;
    LB.querySelector("figcaption").innerHTML = `<b>${esc(LB.a.zh)}</b> · ${esc(s.dataset_id)} · z${s.z}${s.block_id ? ` · <span>${esc(s.block_id)}</span>` : ""} · ${esc(s.severity)}<i>${LB.i + 1} / ${LB.a.shots.length}</i>`;
    LB.querySelector(".lb-p").disabled = LB.i === 0; LB.querySelector(".lb-n").disabled = LB.i === LB.a.shots.length - 1;
  }
  const step = (d) => { const j = Math.max(0, Math.min(LB.a.shots.length - 1, LB.i + d)); if (j !== LB.i) { LB.i = j; show(); } };
  const closeLb = () => LB && LB.classList.remove("on");
  addEventListener("keydown", (e) => {
    if (!LB || !LB.classList.contains("on")) return;
    if (e.key === "Escape") { closeLb(); e.stopImmediatePropagation(); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { step(1); e.stopImmediatePropagation(); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { step(-1); e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  // 启动类操作成功后：收起操作台，只留流程图，左下角短暂提示一句
  let toastT = 0;
  const done = (txt) => {
    closePanel();
    let el = $("rf-toast");
    if (!el) { el = document.createElement("div"); el.id = "rf-toast"; el.className = "rf-toast"; el.setAttribute("role", "status"); view.append(el); }
    el.textContent = txt; el.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 5000);
  };
  const say = (id, txt, err) => { const el = $(id); if (el) el.innerHTML = `<div class="res ${err ? "err" : ""}">${esc(txt)}</div>`; };
  body.addEventListener("click", async (e) => {
    if (e.target.closest("[data-csv]")) { exportRuns(); return; }
    const al = e.target.closest("[data-alb]");
    if (al) { const img = e.target.closest("img[data-i]"); lightbox(+al.dataset.alb, img ? +img.dataset.i : 0); return; }
    const ck = e.target.closest("[data-chk]");
    if (ck) { e.preventDefault(); body.querySelectorAll("input[name=cl-chk]").forEach((c) => { c.checked = ck.dataset.chk === "1"; }); return; }
    const row = e.target.closest("[data-ds]");
    if (row) { selDs = row.dataset.ds; render("dataset"); return; }
    const go = e.target.closest("[data-go]");
    if (go) { openNode(go.dataset.go); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    b.disabled = true;
    try {
      const cwRoi = () => { const ps = $("cw-roi").value.split(",").map((x) => x.trim()).filter(Boolean); const o = {};
        ["x", "y", "z"].forEach((k, i) => { const [lo, hi] = (ps[i] || "").split("-"); o[k] = [+lo, +hi]; });
        if (["x", "y", "z"].some((k) => o[k].some((v) => !Number.isFinite(v)))) throw new Error("ROI 格式：x0-x1,y0-y1,z0-z1"); return o; };
      const cwBody = () => { const id = $("cw-dsid").value.trim(); if (!id) throw new Error("请填 dataset_id");
        return { dataset_id: id, url: $("cw-url").value.trim(), roi: cwRoi(), mip: +$("cw-mip").value || 0 }; };
      if (act === "precheck") {
        const d = await post("/api/v1/crawl/precheck", { roi: cwRoi(), mask_url: $("cw-mask").value.trim(), min_wanted: 0.5, max_defect: 0.02 });
        $("cw-pre").innerHTML = `<div class="res">${d.verdict === "ok" ? "✓ 值得爬" : "✕ 建议换一块"}\n组成：${Object.entries(d.composition || {}).map(([k, v]) => `${esc(k)} ${(v * 100).toFixed(1)}%`).join(" · ")}\nneuropil ${(d.wanted_frac * 100).toFixed(1)}% · fissure ${(d.defect_frac * 100).toFixed(2)}% · ${d.seconds}s${(d.reasons || []).length ? "\n" + d.reasons.map(esc).join("\n") : ""}</div>`;
      } else if (act === "register") {
        const bd = cwBody(); bd.species = $("cw-sp").value || null; bd.brain_region = $("cw-br").value || null; bd.require_precheck_ok = $("cw-req").checked;
        if ($("cw-seg").value.trim()) bd.assets = [{ type: "gt_segmentation", url: $("cw-seg").value.trim(), mip: +$("cw-segmip").value || 0, format: "precomputed_cloud", label_encoding: "gray" }];
        const d = await post("/api/v1/crawl/register", bd);
        await load();
        done(`已注册 ${d.dataset_id}${d.shape ? `：${d.shape.z} × ${d.shape.y} × ${d.shape.x}` : ""}`);
      } else if (act === "fetch") {
        const j = await post("/api/v1/crawl/jobs", cwBody());
        done(`采集任务 #${j.job_id} 已开始`);
      } else if (act === "volume") {
        const r = await fetch(`/api/v1/crawl/volume?url=${encodeURIComponent($("cw-url").value.trim())}&mip=${encodeURIComponent($("cw-mip").value || 0)}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 403 ? "需要审核员权限" : typeof d.detail === "string" ? d.detail : `读不到这个卷（${r.status}）`);
        say("cw-res", `大小 ${d.size_xyz.join(" × ")}（x × y × z）\n分辨率 ${d.resolution_nm.join(" × ")} nm · ${d.encoding}${d.lossy ? "（有损）" : ""}\n块 ${d.chunk_xyz.join(" × ")} · ${d.dtype} · 共 ${d.n_mips} 级 mip`);
      } else if (act === "run-cl" || act === "run-ds") {
        const ds = selDs, bd = { dataset_id: ds };
        if (act === "run-cl") {
          const blocks = $("cl-blocks").value.split(",").map((x) => x.trim()).filter(Boolean);
          const chks = [...body.querySelectorAll("input[name=cl-chk]:checked")].map((c) => c.value);
          if (blocks.length) bd.block_ids = blocks; if (chks.length) bd.config = { checks_enabled: chks };
        }
        const d = await post("/api/v1/qc/runs", bd);
        closePanel();   // 只留左下角的运行条（带进度），不再另弹提示
        active = [{ run_id: d.run_id, dataset_id: ds, stage: "", n_blocks: 0, n_blocks_done: 0 }]; showLive(); play();
        poll();
      } else if (act === "pack-lv") {     // 导出这一种形态：所有能做的用途一起生成一个数据包
        const lv = b.dataset.lv, cells = cellsOf(lv).filter((c) => c.ready).map((c) => [c.task, lv]);
        const d = await post("/api/v1/packs", { dataset_id: D.plan.dataset_id, cells });
        done(`${LEVEL_ZH[lv]}数据包导出已开始 · 任务 #${d.job_id ?? d.id}`);
      } else if (act === "pack") {
        const cells = ["slice", "segment", "patch"].filter((lv) => rawN(lv)).map((lv) => ["raw", lv]);
        const d = await post("/api/v1/packs", { dataset_id: D.plan.dataset_id, cells });
        done(`数据包生成已开始 · 任务 #${d.job_id ?? d.id}`);
      }
    } catch (err) {
      say(act === "volume" ? "cw-res" : act === "precheck" ? "cw-pre" : act === "register" || act === "fetch" ? "cw-reg" : act === "pack" || act === "pack-lv" ? "pk-msg" : act === "run-ds" ? "ds-msg" : "cl-msg", err.message || "出错了", true);
    } finally { b.disabled = false; }
  });
  body.addEventListener("pointermove", (e) => {
    const g = e.target.closest(".dsb"), box = e.target.closest(".dsc"); const tip = box && box.querySelector(".tip");
    body.querySelectorAll(".dsc .tip").forEach((x) => { if (x !== tip) x.hidden = true; });
    if (!tip) return;
    if (!g) { tip.hidden = true; return; }
    const [n, s, v, gr, t] = g.dataset.tip.split("|"), rb = box.getBoundingClientRect();
    tip.innerHTML = `<b>${n}</b><span>可用 ${v} · 等级 ${gr}</span><span>${s} 张切片 · 最近 ${t}</span>`;
    tip.hidden = false;
    const x = Math.min(e.clientX - rb.left + 14, rb.width - tip.offsetWidth - 8), y = e.clientY - rb.top + 16;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  body.addEventListener("pointerleave", () => body.querySelectorAll(".dsc .tip").forEach((x) => { x.hidden = true; }));
  body.addEventListener("change", (e) => {
    if (e.target.id === "ds-sel") { selDs = e.target.value; render("dataset"); return; }
    if (e.target.id === "cl-ds") { selDs = e.target.value; render("clean"); return; }
    if (e.target.id === "cw-preset") { const p = D.crawl.presets[+e.target.value];
      $("cw-url").value = p.url; $("cw-mip").value = p.mip; $("cw-mask").value = p.mask_url || ""; $("cw-seg").value = p.seg_url || "";
      $("cw-sp").value = p.species || ""; $("cw-br").value = p.brain_region || ""; $("cw-segmip").value = p.seg_mip ?? 0; }
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
  // 进度条（页面中间下方，只有一根银白辉光的条）：开始清洗就出现，从左往右连续流到头；
  // 速度按这个数据集上次清洗的用时估，真实进度（块 / 步骤）走得更快时以真实进度为准；跑完补满到 100% 再淡出
  const PG = { run: null, t0: 0, est: 6000, real: 0, raf: 0, fin: 0 };
  function pgFrame(now) {
    const bar = $("rf-run"), i = bar.querySelector(".pg i"); if (!i) return;
    let f;
    if (PG.fin) f = 1;
    else { const u = (now - PG.t0) / PG.est; f = Math.max(PG.real, 0.95 * (1 - Math.exp(-2.2 * u))); }
    i.style.width = (Math.max(0.02, f) * 100).toFixed(2) + "%";
    bar.querySelector(".pg").setAttribute("aria-valuenow", Math.round(f * 100));
    if (PG.fin && now - PG.fin > 700) { bar.hidden = true; bar.innerHTML = ""; PG.run = null; PG.fin = 0; return; }
    PG.raf = requestAnimationFrame(pgFrame);
  }
  function showLive() {
    const bar = $("rf-run"), r = active[0];
    if (!r) {                                  // 跑完了：补满再淡出
      if (PG.run && !PG.fin) PG.fin = performance.now();
      return;
    }
    const ST = ["ingest", "slice_qc", "serial_qc", "aggregate", "persist"], st = (r.stage || "").split(" · ")[0];
    const k = ST.indexOf(st), nb = r.n_blocks || 0;
    PG.real = nb ? Math.min(0.97, (r.n_blocks_done + (k >= 0 ? (k + 0.5) / ST.length : 0)) / nb) : 0;
    if (PG.run !== r.run_id) {                 // 新的一次清洗：从头开始流
      const prev = D && D.runs.find((x) => x.dataset_id === r.dataset_id && x.wall_s);
      PG.run = r.run_id; PG.t0 = performance.now(); PG.fin = 0; PG.est = Math.max(3000, (prev ? prev.wall_s * 1000 : 6000));
      bar.hidden = false;
      bar.innerHTML = `<span class="pg" role="progressbar" aria-label="清洗 #${r.run_id} · ${esc(r.dataset_id)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="width:2%"></i></span>`;
      cancelAnimationFrame(PG.raf); PG.raf = requestAnimationFrame(pgFrame);
    }
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
        if (was && !active.length) { introLeft = 1; await load(); }   // 跑完了：数字刷新，流光把这一轮走到底再停
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
  load().then(() => poll());
})();
