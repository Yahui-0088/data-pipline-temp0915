/* 问题切片浏览器：一张一张往下翻。
   页面里放一个 <script type="application/json" id="viewer-data">[...]</script>（items 见 dashboard._viewer_items），
   任何带 data-view-index / data-view-type 的元素点了就打开。← → 翻页，Esc 关闭，顶部按问题类型筛选。 */
(function () {
  let items = [], list = [], pos = 0, filter = "", el = null;

  function load() {
    const src = document.getElementById("viewer-data");
    if (!src) return false;
    try { items = JSON.parse(src.textContent || "[]"); } catch (e) { items = []; }
    return items.length > 0;
  }

  function build() {
    el = document.createElement("div");
    el.className = "vw";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `<div class="vw-box">
        <div class="vw-top"><div class="vw-chips"></div><button class="vw-x" aria-label="关闭">✕</button></div>
        <div class="vw-stage"><button class="vw-nav vw-prev" aria-label="上一张">‹</button>
          <figure class="vw-fig"><img alt=""><figcaption></figcaption></figure>
          <button class="vw-nav vw-next" aria-label="下一张">›</button></div>
        <div class="vw-strip"></div>
        <div class="vw-hint muted">← → 翻页 · Esc 关闭</div></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", e => { if (e.target === el) close(); });
    el.querySelector(".vw-x").onclick = close;
    el.querySelector(".vw-prev").onclick = () => go(pos - 1);
    el.querySelector(".vw-next").onclick = () => go(pos + 1);
  }

  function chips() {
    const counts = {};
    items.forEach(x => { counts[x.type] = counts[x.type] || { zh: x.zh, n: 0 }; counts[x.type].n++; });
    const all = `<button class="vw-chip ${filter ? "" : "on"}" data-t="">全部 <b>${items.length}</b></button>`;
    el.querySelector(".vw-chips").innerHTML = all + Object.entries(counts).sort((a, b) => b[1].n - a[1].n)
      .map(([t, c]) => `<button class="vw-chip ${filter === t ? "on" : ""}" data-t="${esc(t)}">${esc(c.zh)} <b>${c.n}</b></button>`).join("");
    el.querySelectorAll(".vw-chip").forEach(b => b.onclick = () => { setFilter(b.dataset.t); go(0); });
  }

  function setFilter(t) {
    filter = t || "";
    list = filter ? items.filter(x => x.type === filter) : items.slice();
    chips();
    const strip = el.querySelector(".vw-strip");
    strip.innerHTML = list.map((x, i) => `<button class="vw-th sv-${esc(x.severity)}" data-i="${i}" title="${esc(x.zh)} · z${x.z}"><img loading="lazy" src="${esc(x.url)}" alt=""></button>`).join("");
    strip.querySelectorAll(".vw-th").forEach(b => b.onclick = () => go(Number(b.dataset.i)));
  }

  function go(i) {
    if (!list.length) return;
    pos = (i + list.length) % list.length;
    const x = list[pos];
    const img = el.querySelector(".vw-fig img");
    img.src = x.url; img.alt = `${x.zh} z${x.z}`;
    img.className = "sv-" + x.severity;
    el.querySelector("figcaption").innerHTML =
      `<span class="vw-n mono">${pos + 1} / ${list.length}</span>
       <b>${esc(x.zh)}</b><span class="pill sv-pill-${esc(x.severity)}">${esc(x.severity)}</span>
       <span class="mono">${esc(x.dataset_id)} · z${x.z}${x.tile ? " · " + esc(x.tile) : ""}</span>
       <span class="muted mono">${esc(x.check)}${x.score == null ? "" : " · 分数 " + x.score}</span>
       <a href="${esc(x.href)}">打开这一段 →</a>`;
    el.querySelectorAll(".vw-th.on").forEach(b => b.classList.remove("on"));
    const th = el.querySelector(`.vw-th[data-i="${pos}"]`);
    if (th) { th.classList.add("on"); th.scrollIntoView({ block: "nearest", inline: "center" }); }
    [list[pos + 1], list[pos - 1]].forEach(n => { if (n) { const p = new Image(); p.src = n.url; } });  // preload neighbours
  }

  function key(e) {
    if (!el || el.hidden) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(pos + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(pos - 1); }
    else if (e.key === "Escape") close();
  }

  function open(type, index) {
    if (!items.length && !load()) return;
    if (!el) build();
    el.hidden = false;
    document.body.classList.add("vw-open");
    setFilter(type || "");
    go(index || 0);
    el.querySelector(".vw-next").focus();
  }
  function close() { if (el) { el.hidden = true; document.body.classList.remove("vw-open"); } }

  document.addEventListener("keydown", key);
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-view-type],[data-view-index]");
    if (!t || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (!items.length && !load()) return;
    e.preventDefault();
    const type = t.dataset.viewType || "";
    let idx = 0;
    if (t.dataset.viewUrl) {  // open on this exact picture
      const pool = type ? items.filter(x => x.type === type) : items;
      idx = Math.max(0, pool.findIndex(x => x.url === t.dataset.viewUrl));
    }
    open(type, idx);
  });
  window.openProblemViewer = open;
})();
