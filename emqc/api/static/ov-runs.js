// 总览页「运行记录」：一张折线图，横轴是完成时间（按真实时间间隔），纵轴可切换 可用率 / 问题数 / 用时。
// 只有折线是淡紫色；悬停：最近的那次运行出提示框 + 一条虚线落到横轴；下面「回放运行」按时间顺序一次一次走过去。
(() => {
  "use strict";
  const host = document.getElementById("rc-chart");
  const dataEl = document.getElementById("rc-data");
  if (!host || !dataEl) return;
  let D = [];
  try { D = JSON.parse(dataEl.textContent); } catch { return; }
  D = D.filter((d) => d.t).map((d) => ({ ...d, time: new Date(d.t).getTime() })).sort((a, b) => a.time - b.time);
  if (!D.length) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
  const secs = (x) => (x == null ? "–" : x < 10 ? `${x.toFixed(2)} s` : `${x.toFixed(1)} s`);
  const nice = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const sameDay = new Set(D.map((d) => d.t.slice(0, 10))).size === 1;
  const hhmm = (d) => (sameDay ? d.t.slice(11, 16) : `${d.t.slice(5, 10)} ${d.t.slice(11, 16)}`);
  const M = {
    keep: { title: "可用率 %", val: (d) => (d.keep == null ? null : d.keep * 100), max: () => 100, step: 20, fmt: (v) => String(Math.round(v)) },
    f: { title: "问题数", val: (d) => d.f, fmt: (v) => String(Math.round(v)) },
    s: { title: "用时 s", val: (d) => d.s, fmt: (v) => (v % 1 ? v.toFixed(1) : String(Math.round(v))) },
  };
  for (const k of ["f", "s"]) {
    const top = nice(Math.max(...D.map((d) => M[k].val(d) || 0)) * 1.15);
    M[k].max = () => top; M[k].step = top / 5;
  }
  let metric = "keep", hover = -1, svg = null, G = null, cur = D.map((d) => M.keep.val(d)), tween = 0;

  const tip = document.createElement("div");
  tip.className = "rc-tip"; tip.hidden = true; tip.setAttribute("role", "status");
  host.append(tip);
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.append(e); return e; };

  function layout() {
    const W = Math.max(320, host.clientWidth), H = 310, L = 44, R = 28, T = 34, B = 62;
    // 按运行先后等距排开（运行时间常常扎堆，按真实时间间隔会挤成一团），标签写完成时间
    const pad = 0.04;
    const xOf = (i) => (D.length === 1 ? L + (W - L - R) / 2 : L + (W - L - R) * (pad + (1 - 2 * pad) * (i / (D.length - 1))));
    return { W, H, L, R, T, B, xOf, yOf: (v) => T + (H - T - B) * (1 - Math.max(0, v || 0) / M[metric].max()) };
  }

  function render() {
    G = layout();
    const { W, H, L, R, T, B, xOf, yOf } = G, m = M[metric];
    if (svg) svg.remove();
    svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "rc-svg", tabindex: "0", role: "img", "aria-label": `最近 ${D.length} 次运行的${m.title}` });
    host.prepend(svg);
    el("text", { x: 0, y: 14, class: "rc-ytitle" }, svg).textContent = m.title;
    for (let v = 0; v <= m.max() + 1e-9; v += m.step) {
      el("line", { x1: L, x2: W - R, y1: yOf(v), y2: yOf(v), class: v === 0 ? "rc-base" : "rc-grid" }, svg);
      el("text", { x: L - 10, y: yOf(v) + 4, class: "rc-tick", "text-anchor": "end" }, svg).textContent = m.fmt(v);
    }
    // 横轴：每次运行一根竖网格；时间标签太挤时跳过
    // 第一行时:分；换了一天时第二行写日期
    let lastX = -1e9, lastDay = "";
    D.forEach((d, i) => {
      const x = xOf(i);
      el("line", { x1: x, x2: x, y1: T, y2: H - B, class: "rc-vgrid" }, svg);
      if (x - lastX < 52) return;
      el("text", { x, y: H - B + 18, class: "rc-xtick", "text-anchor": "middle" }, svg).textContent = d.t.slice(11, 16);
      const day = d.t.slice(5, 10);
      if (day !== lastDay) el("text", { x, y: H - B + 33, class: "rc-xday", "text-anchor": "middle" }, svg).textContent = day;
      lastDay = day; lastX = x;
    });
    el("text", { x: W - R, y: H - 4, class: "rc-xtitle", "text-anchor": "end" }, svg).textContent = "完成时间";
    G.drop = el("line", { class: "rc-drop", x1: -9, x2: -9, y1: 0, y2: H - B }, svg);
    G.line = el("path", { class: "rc-line" }, svg);
    G.dots = D.map(() => el("circle", { r: 5, class: "rc-dot" }, svg));
    G.hit = el("rect", { x: L, y: T - 10, width: W - L - R, height: H - T - B + 10, class: "rc-hit" }, svg);
    draw(cur);
    const near = (clientX) => {
      const r = svg.getBoundingClientRect(), x = clientX - r.left;
      let best = 0, bd = Infinity; D.forEach((_, i) => { const dd = Math.abs(G.xOf(i) - x); if (dd < bd) { bd = dd; best = i; } }); return best;
    };
    G.hit.addEventListener("pointermove", (e) => { stopPlay(); setHover(near(e.clientX)); });
    G.hit.addEventListener("pointerleave", () => { if (!playing) setHover(-1); });
    G.hit.addEventListener("click", (e) => { location.href = `/runs/${D[near(e.clientX)].id}`; });
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); stopPlay(); setHover(Math.max(0, Math.min(D.length - 1, (hover < 0 ? D.length - 1 : hover) + (e.key === "ArrowRight" ? 1 : -1)))); }
      else if (e.key === "Enter" && hover >= 0) location.href = `/runs/${D[hover].id}`;
      else if (e.key === "Escape") setHover(-1);
    });
    const h = hover; hover = -1; if (h >= 0) setHover(h);
    placePlay();
  }

  function draw(vals) {
    const { xOf, yOf } = G;
    const pts = vals.map((v, i) => [xOf(i), yOf(v)]);
    G.line.setAttribute("d", pts.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
    pts.forEach(([x, y], i) => { G.dots[i].setAttribute("cx", x); G.dots[i].setAttribute("cy", y); });
    if (hover >= 0) placeHover();
  }

  // 切换 可用率 / 问题数 / 用时：点和线从旧位置平滑移到新位置（纵轴刻度直接换）
  function setMetric(k) {
    if (k === metric) return;
    const from = cur.map((v, i) => (v == null ? 0 : v) / M[metric].max());
    metric = k;
    const to = D.map((d) => M[k].val(d));
    render();
    cancelAnimationFrame(tween);
    if (reduce) { cur = to; draw(cur); return; }
    const t0 = performance.now(), dur = 450, ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const p = ease(Math.min(1, (now - t0) / dur));
      cur = to.map((v, i) => (from[i] + ((v == null ? 0 : v) / M[k].max() - from[i]) * p) * M[k].max());
      draw(cur);
      if (p < 1) tween = requestAnimationFrame(step); else { cur = to; draw(cur); }
    };
    tween = requestAnimationFrame(step);
  }
  document.querySelectorAll("#rc [data-m]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#rc [data-m]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    setMetric(b.dataset.m);
  }));

  function setHover(i) {
    if (hover >= 0 && G.dots[hover]) G.dots[hover].classList.remove("on");
    hover = i;
    svg.classList.toggle("has-hover", i >= 0);
    if (i < 0) { tip.hidden = true; G.drop.setAttribute("x1", -9); G.drop.setAttribute("x2", -9); return; }
    G.dots[i].classList.add("on");
    const d = D[i];
    tip.replaceChildren();
    const h = document.createElement("div"); h.className = "rc-tip-h"; h.textContent = `#${d.id}`;
    const sub = document.createElement("div"); sub.className = "rc-tip-sub"; sub.textContent = `${d.ds} · ${d.n} 张切片`;
    tip.append(h, sub);
    for (const [k, v] of [["可用率", pct(d.keep)], ["问题记录", String(d.f)], ["用时", secs(d.s)], ["完成", d.at || "–"]]) {
      const row = document.createElement("div"); row.className = "rc-tip-r";
      const a = document.createElement("span"); a.textContent = k; const b = document.createElement("b"); b.textContent = v;
      row.append(a, b); tip.append(row);
    }
    tip.hidden = false;
    placeHover();
    setPlayHead(i);
  }
  function placeHover() {
    const i = hover, x = G.xOf(i), y = G.yOf(cur[i]);
    G.drop.setAttribute("x1", x); G.drop.setAttribute("x2", x); G.drop.setAttribute("y1", y + 7);
    // 提示框在点的正上方，有个小尖角指着点；太靠边就往里推
    const tw = tip.offsetWidth, th = tip.offsetHeight, hw = host.clientWidth;
    const left = Math.max(0, Math.min(hw - tw, x - tw / 2));
    let top = y - th - 16; const below = top < 0; if (below) top = y + 16;
    tip.classList.toggle("is-below", below);
    tip.style.setProperty("--caret", `${x - left}px`);
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }

  // ------------------------------------------------------------------ 回放运行：按时间一次一次走过去
  const track = document.getElementById("rc-play-track"), btn = document.getElementById("rc-play-btn"), timeEl = document.getElementById("rc-play-time");
  let playing = false, playT = 0, marks = [];
  const fracOf = (i) => (D.length === 1 ? 1 : i / (D.length - 1));
  function placePlay() {
    if (!track) return;
    marks.forEach((m) => m.remove());
    marks = D.map((_, i) => { const s = document.createElement("span"); s.className = "rc-play-dot"; s.style.left = `${fracOf(i) * 100}%`; track.append(s); return s; });
    setPlayHead(hover >= 0 ? hover : D.length - 1);
  }
  function setPlayHead(i) {
    if (!track) return;
    track.style.setProperty("--p", fracOf(i));
    marks.forEach((m, k) => m.classList.toggle("done", k <= i));
    timeEl.textContent = `${hhmm(D[i])} / ${hhmm(D[D.length - 1])}`;
    track.setAttribute("aria-valuemin", "1"); track.setAttribute("aria-valuemax", String(D.length)); track.setAttribute("aria-valuenow", String(i + 1));
    track.setAttribute("aria-valuetext", `#${D[i].id}，${hhmm(D[i])}`);
  }
  function stopPlay() { if (!playing) return; playing = false; clearTimeout(playT); btn.classList.remove("is-on"); btn.setAttribute("aria-label", "回放运行"); }
  function play() {
    if (playing) { stopPlay(); return; }
    playing = true; btn.classList.add("is-on"); btn.setAttribute("aria-label", "暂停回放");
    let i = hover >= 0 && hover < D.length - 1 ? hover : -1;
    const next = () => {
      if (!playing) return;
      i += 1;
      if (i >= D.length) { stopPlay(); return; }
      setHover(i);
      playT = setTimeout(next, reduce ? 500 : 900);
    };
    next();
  }
  if (btn) btn.addEventListener("click", play);
  if (track) {
    const at = (clientX) => {
      const r = track.getBoundingClientRect(), f = (clientX - r.left) / r.width;
      let best = 0, bd = Infinity; D.forEach((_, i) => { const dd = Math.abs(fracOf(i) - f); if (dd < bd) { bd = dd; best = i; } }); return best;
    };
    let drag = false;
    track.addEventListener("pointerdown", (e) => { drag = true; stopPlay(); track.setPointerCapture(e.pointerId); setHover(at(e.clientX)); });
    track.addEventListener("pointermove", (e) => { if (drag) setHover(at(e.clientX)); });
    track.addEventListener("pointerup", () => { drag = false; });
    track.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault(); stopPlay();
      setHover(Math.max(0, Math.min(D.length - 1, (hover < 0 ? D.length - 1 : hover) + (e.key === "ArrowRight" ? 1 : -1))));
    });
  }

  render();
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
  // 第一次滚到这里：折线从左往右画出来
  if (!reduce && "IntersectionObserver" in window) {
    svg.classList.add("is-pre");
    const io = new IntersectionObserver((es) => {
      if (!es.some((x) => x.isIntersecting)) return;
      io.disconnect();
      const len = G.line.getTotalLength();
      G.line.style.strokeDasharray = `${len}`; G.line.style.strokeDashoffset = `${len}`;
      svg.classList.remove("is-pre");
      G.line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1100, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }).onfinish = () => { G.line.style.strokeDasharray = ""; G.line.style.strokeDashoffset = ""; };
      G.dots.forEach((d, i) => d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 250 + i * 50, fill: "backwards" }));
    }, { threshold: 0.35 });
    io.observe(host);
  }
})();
