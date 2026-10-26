// 总览页：
// 1) 选数据集 + 运行（POST /api/v1/qc/runs），然后舞台跟着真实运行一步一步走（轮询 /runs/{id}/workflow）；
// 2) 没在跑的时候，舞台由滚动驱动（GSAP ScrollTrigger 固定这一屏）：往下滚 = 回放最新一次运行的每一步；
// 3) 舞台中心只放当前这一步的大字，右边是累计秒数，下面是白色进度条；悬停 / 聚焦大字 = 景深切换到说明（CSS）。
(() => {
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const desktop = matchMedia("(min-width: 1024px)");

  // ---------------------------------------------------------------- 运行按钮
  const form = $("ov-run-form"), sel = $("ov-ds"), btn = $("ov-run"), msg = $("ov-run-msg");
  if (form && sel && btn) {
    sel.addEventListener("change", () => { btn.disabled = !sel.value; msg.textContent = ""; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sel.value || btn.disabled) return;
      btn.disabled = true;
      msg.textContent = `正在启动 ${sel.value} 的质量检查…`;
      try {
        const r = await fetch("/api/v1/qc/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset_id: sel.value }) });
        if (r.status === 401 || r.status === 403) throw new Error("这个账号没有启动运行的权限");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `启动失败（${r.status}）`);
        const run = await r.json();
        msg.textContent = `运行 #${run.run_id} 已开始，下面一步一步显示进度。`;
        follow(run.run_id, sel.value);
      } catch (err) {
        msg.textContent = err.message || "启动失败";
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- 舞台
  const theater = $("ov-theater");
  const acts = theater ? [...theater.querySelectorAll(".ov-act")] : [];
  const steps = acts.map((a) => a.dataset.step);
  const nodes = [...document.querySelectorAll(".ov-node[data-node]")];
  const fill = $("ov-bar-fill"), stepLbl = $("ov-bar-step"), totalLbl = $("ov-bar-total"), line = $("ov-progress");
  let current = -1, live = false;

  function show(i, p, secs) {
    if (!acts.length) return;
    i = Math.max(0, Math.min(acts.length - 1, i));
    if (i !== current) {
      acts.forEach((a, k) => {
        a.classList.toggle("is-current", k === i);
        a.classList.toggle("is-past", k < i);
        a.setAttribute("aria-hidden", k === i || theater.classList.contains("is-static") ? "false" : "true");
        a.tabIndex = k === i ? 0 : -1;
      });
      const doneIds = new Set(steps.slice(0, i));
      for (const n of nodes) {
        n.toggleAttribute("data-on", n.dataset.node === steps[i]);
        n.toggleAttribute("data-done", doneIds.has(n.dataset.node));
      }
      current = i;
    }
    if (secs != null) {
      const s = acts[i].querySelector(".ov-act-secs");
      if (s) s.firstChild.nodeValue = secs.toFixed(2);
    }
    const prog = p != null ? p : parseFloat(acts[i].dataset.p || "0");
    if (fill) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, prog)).toFixed(4)})`;
    if (stepLbl) stepLbl.textContent = `${i + 1} / ${acts.length}`;
  }

  // 左边流程图缩放到正好放进这一屏
  const wrap = $("ov-graph-wrap"), fit = $("ov-graph-fit");
  function fitGraph() {
    if (!wrap || !fit) return;
    const g = fit.firstElementChild; if (!g) return;
    const gw = g.offsetWidth, gh = g.offsetHeight, w = wrap.clientWidth - 32;
    const pinned = desktop.matches && theater && !theater.classList.contains("is-static");
    const k = pinned ? Math.min(1, w / gw, (wrap.clientHeight - 32) / gh) : Math.min(1, w / gw);
    const x = Math.max(16, (wrap.clientWidth - gw * k) / 2);
    fit.style.transformOrigin = "0 0";
    fit.style.transform = `translate(${x}px, 16px) scale(${k})`;
    fit.style.width = `${gw}px`;
    fit.style.height = pinned ? "" : `${gh * k + 32}px`;
  }

  // 滚动回放：固定这一屏，往下滚一段换一步
  let trigger = null;
  function setupScroll() {
    if (trigger) { trigger.kill(); trigger = null; }
    const canPin = !reduce && desktop.matches && window.gsap && window.ScrollTrigger && acts.length;
    theater && theater.classList.toggle("is-static", !canPin);
    if (canPin) {
      gsap.registerPlugin(ScrollTrigger);
      trigger = ScrollTrigger.create({
        trigger: "#run", pin: ".ov-stage-pin", start: "top top", end: `+=${acts.length * 55}%`,
        onUpdate: (self) => {
          if (line) line.style.transform = `scaleY(${self.progress.toFixed(4)})`;
          if (!live) show(Math.min(acts.length - 1, Math.floor(self.progress * acts.length)));
        },
      });
    }
    fitGraph();
    if (!live) show(Math.max(0, current));
  }
  // 点左边流程图的节点：右边跳到那一步。固定舞台时滚到那一步对应的滚动位置（滚动和舞台保持一致）；
  // 手机 / 减少动画的列表模式下把那一块滚进视野。控制节点跳到它后面那一步
  const ALIAS = { next_group: "ingest", group_done: "finalize" };
  function jumpTo(nodeId) {
    const i = steps.indexOf(ALIAS[nodeId] || nodeId);
    if (i < 0) return;
    if (trigger && !live) {
      const y = trigger.start + (trigger.end - trigger.start) * ((i + 0.5) / acts.length);
      scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
      show(i);
    } else if (theater.classList.contains("is-static")) {
      show(i);
      acts[i].scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    } else {
      show(i);   // 正在跟着真实运行走：先看这一步，下一次进度更新时回到实时
    }
    acts[i].focus({ preventScroll: true });
  }
  for (const n of nodes) n.addEventListener("click", () => jumpTo(n.dataset.node));

  if (acts.length) {
    show(0);
    addEventListener("load", setupScroll);
    desktop.addEventListener("change", setupScroll);
    addEventListener("resize", () => { fitGraph(); });
  }

  // ---------------------------------------------------------------- 跟着真实运行走
  async function follow(runId, datasetId) {
    live = true;
    const runLink = $("ov-run-id"), ds = $("ov-run-ds"), status = $("ov-run-status");
    if (runLink) { runLink.textContent = `#${runId}`; runLink.href = `/runs/${runId}`; }
    if (ds) ds.textContent = datasetId;
    if (status) { status.textContent = "运行中"; status.className = "inline-flex h-6 items-center rounded-full bg-[#2a2a2a] px-2.5 text-[12px] text-neutral-200"; }
    const run = $("run");
    if (run) {
      const y = trigger ? trigger.start : run.getBoundingClientRect().top + scrollY;
      scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    }
    if (!acts.length) return;  // 还没有过任何运行：页面上没有舞台，跑完刷新就有了
    show(0, 0, 0);
    const t0 = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let w;
      try { w = await (await fetch(`/api/v1/qc/runs/${runId}/workflow?limit=0`)).json(); } catch { continue; }
      const n = w.nodes || {};
      // 已经完成过（至少退出过一次）的步骤里，最靠后的那一个就是舞台上显示的这一步
      let idx = 0;
      steps.forEach((id, k) => { const x = n[id]; if (x && x.visits > 0 && !(w.active === id && x.phase === "enter" && x.visits === 1)) idx = k; });
      const total = Object.values(n).reduce((a, x) => a + (x.total_s || 0), 0);
      const done = !["queued", "running"].includes(w.status);
      const p = done ? 1 : (w.n_blocks ? (w.n_blocks_done / w.n_blocks) * 0.92 : 0) + (idx / steps.length) * 0.08;
      show(done ? steps.length - 1 : idx, p, total || (performance.now() - t0) / 1000);
      if (totalLbl) totalLbl.textContent = `${(total || 0).toFixed(2)} s`;
      if (done) {
        if (status) { status.textContent = w.status === "done" ? "完成" : w.status === "error" ? "出错" : "已取消"; status.className = w.status === "done" ? "ov-pill-ok" : "inline-flex h-6 items-center rounded-full bg-[#2c1a20] px-2.5 text-[12px] text-[#e5566f]"; }
        if (msg) msg.textContent = w.status === "done" ? "运行完成，正在刷新数据…" : "运行没有正常完成，点运行编号看详情。";
        if (w.status === "done") setTimeout(() => location.reload(), 1800);
        break;
      }
    }
  }
})();
