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

  function links() {  // 虚线：从体块上被切走的位置连到切出来的立方体
    const sc = scene.getBoundingClientRect(), k = sc.width / 560 || 1;
    const h = hole.getBoundingClientRect(), c = scene.querySelector(".pk-face.f1").getBoundingClientRect();
    if (!h.width || !c.width) return;
    const P = (x, y) => `${((x - sc.left) / k).toFixed(1)} ${((y - sc.top) / k).toFixed(1)}`;
    $("pk-l1").setAttribute("d", `M ${P(h.right - 2, h.top + h.height * 0.5)} L ${P(c.left + 6, c.top + 6)}`);
    $("pk-l2").setAttribute("d", `M ${P(h.left + h.width * 0.5, h.bottom - 2)} L ${P(c.left + 4, c.bottom - 6)}`);
  }

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
      card.classList.toggle("on", lv === st.view);
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
    if (st.view === "patch") requestAnimationFrame(links);
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
    card.addEventListener("click", (e) => { if (e.target.closest(".pk-check")) return; st.view = card.dataset.level; render(); });
    card.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); st.view = card.dataset.level; render(); } });
    const box = card.querySelector("input");
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
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
