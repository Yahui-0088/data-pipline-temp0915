// 总览页「导出数据包」：用途（原图 / 质检分类 / 实例分割 / 膜…）× 形态（2D 切片 / 3D 连续段 / 3D patch）。
// 数字全部来自 POST /api/v1/packs/plan（这个数据集的真实统计，不写任何数据）；「生成产出」调 POST /api/v1/packs。
(() => {
  "use strict";
  const root = document.getElementById("pk");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const LEVEL_ZH = { slice: "2D 切片", segment: "3D 连续段", patch: "3D patch" };
  const UNIT = { slice: "张", segment: "段", patch: "个" };
  const MORE = ["synapse", "mitochondria", "hard_negative", "proofreading"];
  const st = { ds: $("pk-ds").value || root.dataset.default, task: "raw", split: "", view: "patch", plan: null, sel: new Set() };
  const cache = new Map();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
  const key = (t, l) => `${t}|${l}`;

  // ------------------------------------------------------------------ 体块：一层层磨砂玻璃
  const vol = $("pk-vol"), scene = $("pk-scene");
  const N = 13, GAP = 9;
  const layers = [];
  for (let i = 0; i < N; i++) {
    const l = document.createElement("div");
    l.className = "pk-layer" + (i % 3 === 0 ? " tex" : "") + (i === N - 1 ? " top tex" : "");
    l.style.transform = `translateZ(${i * GAP}px)`;
    vol.append(l); layers.push(l);
  }
  const hole = document.createElement("div");
  hole.className = "pk-hole"; hole.style.transform = `translateZ(${(N - 1) * GAP + 1}px)`;
  vol.append(hole);

  // 投影点：在被切走的方框四角、立方体八个顶点上各放一个看不见的点，取它们在屏幕上的位置
  const pt = (parent, x, y) => { const d = document.createElement("i"); d.className = "pk-pt"; d.style.left = x; d.style.top = y; parent.append(d); return d; };
  const holePts = [["0", "0"], ["100%", "0"], ["100%", "100%"], ["0", "100%"]].map(([x, y]) => pt(hole, x, y));
  const cubePts = [".f1", ".f2"].flatMap((f) => { const face = scene.querySelector(`.pk-face${f}`); return [["0", "0"], ["100%", "0"], ["100%", "100%"], ["0", "100%"]].map(([x, y]) => pt(face, x, y)); });
  const center = (ps) => ps.reduce((a, p) => ({ x: a.x + p.x / ps.length, y: a.y + p.y / ps.length }), { x: 0, y: 0 });
  // 虚线：方框和立方体两侧的「外轮廓」各连一条（两条线正好夹住立方体，像从体块里抽出来的轨迹）
  function links() {
    const sc = scene.getBoundingClientRect(), k = sc.width / 560 || 1;
    const H = holePts.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const V = cubePts.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    if (!H.length || !V.length) return;
    const ch = center(H), cv = center(V);
    const dx = cv.x - ch.x, dy = cv.y - ch.y, nx = -dy, ny = dx;  // 垂直于「方框 → 立方体」的方向
    const side = (p) => p.x * nx + p.y * ny;
    const pick = (ps, max) => ps.reduce((a, p) => ((max ? side(p) > side(a) : side(p) < side(a)) ? p : a));
    const P = (p) => `${((p.x - sc.left) / k).toFixed(1)} ${((p.y - sc.top) / k).toFixed(1)}`;
    $("pk-l1").setAttribute("d", `M ${P(pick(H, true))} L ${P(pick(V, true))}`);
    $("pk-l2").setAttribute("d", `M ${P(pick(H, false))} L ${P(pick(V, false))}`);
  }

  // 大图可以用鼠标 / 手指拖着转（左右转、上下俯仰，松手带一点惯性）
  const world = $("pk-world");
  let rx = 0, ry = 0, vx = 0, vy = 0, drag = null, spin = 0;
  const apply = () => { world.style.setProperty("--rx", `${rx.toFixed(2)}deg`); world.style.setProperty("--ry", `${ry.toFixed(2)}deg`); if (st.view === "patch") links(); };
  world.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, rx, ry, t: performance.now() };
    vx = vy = 0; cancelAnimationFrame(spin);
    world.setPointerCapture(e.pointerId); world.classList.add("is-drag");
  });
  world.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const nrx = Math.max(-22, Math.min(22, drag.rx - (e.clientY - drag.y) * 0.25));
    const nry = Math.max(-55, Math.min(55, drag.ry + (e.clientX - drag.x) * 0.35));
    const now = performance.now(), dt = Math.max(1, now - drag.t);
    vx = ((nrx - rx) / dt) * 16; vy = ((nry - ry) / dt) * 16; drag.t = now;
    rx = nrx; ry = nry; apply();
  });
  const release = () => {
    if (!drag) return;
    drag = null; world.classList.remove("is-drag");
    if (reduceMotion) return;
    const step = () => {
      vx *= 0.9; vy *= 0.9;
      rx = Math.max(-22, Math.min(22, rx + vx)); ry = Math.max(-55, Math.min(55, ry + vy)); apply();
      if (Math.abs(vx) + Math.abs(vy) > 0.02) spin = requestAnimationFrame(step);
    };
    spin = requestAnimationFrame(step);
  };
  world.addEventListener("pointerup", release);
  world.addEventListener("pointercancel", release);
  world.addEventListener("dblclick", () => { rx = ry = 0; apply(); });  // 双击回正

  function texture() {  // 纹理用这个数据集真实的问题截图（图片墙里的），没有就不加纹理
    let url = null;
    try {
      const wall = JSON.parse(($("ov-wall-data") || {}).textContent || "[]");
      const all = wall.flatMap((c) => c.items || []);
      const plain = all.filter((i) => !/montage/.test(i.url));  // 单张切片，不用拼图
      url = ((plain.find((i) => i.dataset_id === st.ds) || plain[0]) || {}).url || null;
    } catch {}
    root.style.setProperty("--tex", url ? `url("${url}")` : "none");
  }

  // ------------------------------------------------------------------ 数据
  async function load() {
    const ds = st.ds;
    if (!cache.has(ds)) {
      setBusy(true);
      try {
        const r = await fetch("/api/v1/packs/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset_id: ds }) });
        if (!r.ok) throw new Error(r.status);
        cache.set(ds, await r.json());
      } catch {
        if (ds === st.ds) { st.plan = null; setBusy(false); render(); $("pk-msg").textContent = "这个数据集的统计没取到，稍后再试。"; }
        return;
      }
    }
    if (ds !== st.ds) return;
    st.plan = cache.get(ds);
    // 默认勾选：数据包的默认组合里能做的那几格
    st.sel = new Set((st.plan.params.cells || []).filter(([t, l]) => (cell(t, l) || {}).ready).map(([t, l]) => key(t, l)));
    setBusy(false);
    render();
  }
  const cell = (t, l) => (st.plan ? st.plan.cells.find((c) => c.task === t && c.level === l) : null);
  function setBusy(b) { root.toggleAttribute("aria-busy", b); if (b) root.querySelectorAll(".pk-n").forEach((x) => (x.textContent = "…")); }

  // 这一格在当前划分（全部 / train / val / test）下的数量和大小
  function count(c) {
    if (!c || !c.ready) return null;
    const bp = c.by_partition || {};
    if (!st.split) return { n: c.n, bytes: c.est_bytes, split: false };
    if (!Object.keys(bp).length) return { n: c.n, bytes: c.est_bytes, split: false, nosplit: true };
    const n = bp[st.split] || 0;
    return { n, bytes: c.n ? (c.est_bytes * n) / c.n : 0, split: true };
  }
  const labelOf = (t) => ((st.plan && st.plan.tasks.find((x) => x.task === t)) || {}).label;

  function render() {
    const p = st.plan;
    // 用途
    root.querySelectorAll("[data-task]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.task === st.task)));
    const more = $("pk-more"), inMore = MORE.includes(st.task);
    more.setAttribute("aria-pressed", String(inMore));
    more.textContent = inMore ? `${(p && p.tasks.find((x) => x.task === st.task) || {}).zh || "更多"} ▾` : "更多";
    root.querySelectorAll("[data-split]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.split === st.split)));
    // 三张卡
    root.querySelectorAll(".pk-card").forEach((card) => {
      const lv = card.dataset.level, c = cell(st.task, lv), q = count(c);
      const box = card.querySelector("input");
      card.classList.toggle("on", st.sel.has(key(st.task, lv)));  // 勾选了的都描紫边
      card.setAttribute("aria-pressed", String(st.sel.has(key(st.task, lv))));
      card.classList.toggle("is-off", !q);
      box.disabled = !q;
      box.checked = st.sel.has(key(st.task, lv));
      const nEl = card.querySelector(".pk-n"), meta = card.querySelector(".pk-meta");
      if (!p) { nEl.textContent = "–"; meta.textContent = ""; return; }
      const unitEl = card.querySelector(".pk-num small");
      unitEl.textContent = q ? UNIT[lv] : "";
      if (!q) { nEl.textContent = "—"; meta.textContent = c ? (c.applicable ? c.reason || "现在做不了" : "这个用途没有这种形态") : ""; return; }
      nEl.textContent = (c.approx ? "≤ " : "") + q.n.toLocaleString("zh-CN");
      const bits = [];
      if (lv === "segment" && c.n_sections && !q.split) bits.push(`${c.n_sections} 张切片`);
      if (st.task === "qc" && c.by_class && !q.split) bits.push(`clean ${c.by_class.clean ?? 0} · 有问题 ${c.by_class.fail ?? 0}`);
      bits.push(`约 ${mb(q.bytes)}`);
      if (q.nosplit) bits.push("不分 train / val / test");
      meta.textContent = bits.join(" · ");
    });
    // 左边大数字 = 当前预览的那一格
    const c = cell(st.task, st.view), q = count(c);
    $("pk-big-k").textContent = c && c.approx ? "最多" : "共";
    $("pk-big-n").textContent = q ? q.n.toLocaleString("zh-CN") : "—";
    $("pk-big-u").textContent = q ? UNIT[st.view] : "";
    $("pk-big-t").textContent = LEVEL_ZH[st.view];
    const lab = labelOf(st.task);
    $("pk-big-m").textContent = !p ? "" : q ? `${lab ? `标签：${lab}` : "无需标签"} · 约 ${mb(q.bytes)}` : (c ? (c.applicable ? c.reason : "这个用途没有这种形态") : "");
    $("pk-hint-r").textContent = st.view === "patch" ? "patch 数量为上限估计" : "";
    // 体块
    scene.dataset.view = st.view;
    scene.classList.toggle("is-empty", !q);
    layers.forEach((l, i) => {
      const pickSlice = st.view === "slice" && i === N - 1, pickSeg = st.view === "segment" && i >= 3 && i <= 9;
      l.classList.toggle("is-pick", pickSlice || pickSeg);
      l.style.transform = `translateZ(${i * GAP + (pickSlice ? 40 : 0)}px)`;
    });
    if (st.view === "patch") {  // 立方体滑进来的这段时间里虚线跟着走
      const t0 = performance.now();
      const f = () => { links(); if (performance.now() - t0 < 650) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }
    // 已选
    const chosen = [...st.sel].map((k) => k.split("|"));
    $("pk-count").textContent = chosen.length;
    $("pk-go").disabled = !chosen.length || !p;
    const list = $("pk-list");
    const ul = document.createElement("ul");
    ul.className = "m-0 list-none p-0";
    for (const [t, l] of chosen) {
      const cc = cell(t, l), li = document.createElement("li");
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = `${(p.tasks.find((x) => x.task === t) || {}).zh || t} · ${LEVEL_ZH[l]}`;
      b.textContent = cc ? `${cc.approx ? "≤ " : ""}${cc.n} ${UNIT[l]} · 约 ${mb(cc.est_bytes)}` : "";
      li.append(a, b); ul.append(li);
    }
    list.replaceChildren(chosen.length ? ul : Object.assign(document.createElement("p"), { className: "m-0 text-neutral-500", textContent: "还没有勾选任何产出" }));
  }

  // ------------------------------------------------------------------ 交互
  $("pk-ds").addEventListener("change", (e) => { st.ds = e.target.value; $("pk-msg").textContent = ""; texture(); load(); });
  root.querySelectorAll("[data-task]").forEach((b) => b.addEventListener("click", () => {
    st.task = b.dataset.task;
    if (!MORE.includes(st.task)) { $("pk-more-list").hidden = true; $("pk-more").setAttribute("aria-expanded", "false"); }
    // 换用途时，预览停在这个用途能做的形态上
    const c = cell(st.task, st.view);
    if (!c || !c.ready) { const ok = ["patch", "slice", "segment"].find((lv) => (cell(st.task, lv) || {}).ready); if (ok) st.view = ok; }
    render();
  }));
  $("pk-more").addEventListener("click", () => {
    const list = $("pk-more-list"); list.hidden = !list.hidden;
    $("pk-more").setAttribute("aria-expanded", String(!list.hidden));
  });
  root.querySelectorAll("[data-split]").forEach((b) => b.addEventListener("click", () => { st.split = b.dataset.split; render(); }));
  root.querySelectorAll(".pk-card").forEach((card) => {
    const box = card.querySelector("input");
    // 点整张卡片：预览这一种，同时勾选 / 取消勾选（做不了的只预览）
    const toggle = () => {
      st.view = card.dataset.level;
      if (!box.disabled) {
        const k = key(st.task, card.dataset.level);
        if (st.sel.has(k)) st.sel.delete(k); else st.sel.add(k);
      }
      render();
    };
    card.addEventListener("click", (e) => { if (e.target.closest(".pk-check")) return; toggle(); });  // 小方框自己会处理
    card.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); toggle(); } });
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      st.view = card.dataset.level;
      const k = key(st.task, card.dataset.level);
      if (box.checked) st.sel.add(k); else st.sel.delete(k);
      render();
    });
  });
  $("pk-listbtn").addEventListener("click", () => {
    const l = $("pk-list"); l.hidden = !l.hidden;
    $("pk-listbtn").setAttribute("aria-expanded", String(!l.hidden));
    $("pk-listbtn").textContent = l.hidden ? "查看清单 ›" : "收起清单 ‹";
  });
  $("pk-go").addEventListener("click", async () => {
    const cells = [...st.sel].map((k) => k.split("|"));
    if (!cells.length) return;
    const go = $("pk-go"), msg = $("pk-msg");
    go.disabled = true; msg.textContent = "正在提交…";
    try {
      const r = await fetch("/api/v1/packs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset_id: st.ds, cells }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { msg.textContent = "需要审核员权限才能生成数据包。"; return; }
      if (!r.ok) { msg.textContent = typeof d.detail === "string" ? d.detail : "没有提交成功。"; return; }
      msg.replaceChildren(`已开始生成（任务 #${d.job_id ?? d.id}）· `, Object.assign(document.createElement("a"), { href: `/training?dataset=${encodeURIComponent(st.ds)}`, textContent: "去训练数据看进度 →" }));
    } catch { msg.textContent = "网络出错，没有提交成功。"; }
    finally { go.disabled = !st.sel.size; }
  });
  addEventListener("resize", () => { if (st.view === "patch") links(); });

  texture();
  render();
  load();
})();
