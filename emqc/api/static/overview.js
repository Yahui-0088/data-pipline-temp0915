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
  const bar = $("ov-bar"), results = theater ? [...theater.querySelectorAll(".ov-result")] : [], stepLbl = $("ov-bar-step"), totalLbl = $("ov-bar-total"), line = $("ov-progress");
  let current = -1, live = false, zLabel = "";
  // 运行中一闪而过的分支节点（取下一个 z 段 / 本段完成只要几毫秒），在流程图上亮一下
  function flash(id) {
    const el = nodes.find((x) => x.dataset.node === id);
    if (!el) return;
    el.setAttribute("data-flash", "");
    clearTimeout(el._fl);
    el._fl = setTimeout(() => el.removeAttribute("data-flash"), 900);
  }

  function show(i, p, secs, shown) {
    if (!acts.length) return;
    i = Math.max(0, Math.min(acts.length - 1, i));
    if (i !== current) {
      acts.forEach((a, k) => {
        a.classList.remove("is-reveal");
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
    // 进度条：按「第几步 / 共几步」走，最后一步走满
    const prog = p != null ? p : (i + 1) / acts.length;
    if (bar) bar.style.setProperty("--p", Math.max(0, Math.min(1, prog)).toFixed(4));
    // 横线下面：只放当前这一步自己的结果；到最后一步「结果汇总」时，前面每一步的结果一起列出来
    const last = i === acts.length - 1;
    results.forEach((r) => r.toggleAttribute("data-shown", last || r.dataset.step === steps[i]));
    if (stepLbl) stepLbl.textContent = `${i + 1} / ${acts.length}` + (zLabel ? ` · ${zLabel}` : "");
  }

  // 左边流程图缩放到正好放进这一屏
  const wrap = $("ov-graph-wrap"), fit = $("ov-graph-fit");
  function fitGraph() {
    if (!wrap || !fit) return;
    const g = fit.firstElementChild; if (!g) return;
    const gw = g.offsetWidth, gh = g.offsetHeight, w = wrap.clientWidth - 24;
    const pinned = desktop.matches && theater && !theater.classList.contains("is-static");
    // 尽量放大：最多放到 1.3 倍，受这一屏的宽和高限制
    const k = pinned ? Math.min(1.3, w / gw, (wrap.clientHeight - 24) / gh) : Math.min(1.3, w / gw);
    const x = Math.max(12, (wrap.clientWidth - gw * k) / 2);
    const y = pinned ? Math.max(12, (wrap.clientHeight - gh * k) / 2) : 12;
    fit.style.transformOrigin = "0 0";
    fit.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    fit.style.width = `${gw}px`;
    fit.style.height = pinned ? "" : `${gh * k + 24}px`;
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
    let jumpEnd = false;
    try { jumpEnd = sessionStorage.getItem("ov-show-finished") === "1"; sessionStorage.removeItem("ov-show-finished"); } catch {}
    if (jumpEnd) {
      if (trigger) scrollTo({ top: trigger.start + (trigger.end - trigger.start) * 0.995, behavior: "auto" });
      else { show(acts.length - 1, 1); acts[acts.length - 1].scrollIntoView({ block: "center" }); }
    }
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

  // 触屏没有悬停：点一下这一行切换景深（再点一次恢复）；点别处恢复。鼠标设备用 CSS :hover，键盘用 :focus-visible
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  for (const a of acts) {
    a.addEventListener("click", () => {
      if (finePointer.matches) return;
      const on = !a.classList.contains("is-reveal");
      acts.forEach((x) => x.classList.remove("is-reveal"));
      a.classList.toggle("is-reveal", on);
    });
  }
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ov-act")) acts.forEach((x) => x.classList.remove("is-reveal")); });

  if (acts.length) {
    show(0);
    if (document.readyState === "complete") setupScroll(); else addEventListener("load", setupScroll);   // 转场时脚本可能在 load 之后才跑
    desktop.addEventListener("change", setupScroll);
    addEventListener("resize", () => { fitGraph(); });
  }

  // 运行中每一步的结果（这次运行自己的数字）：节点耗时来自 /workflow，等级、可用比例、问题数来自 /runs/{id}
  const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
  const sec = (x) => (x == null ? "–" : `${x.toFixed(2)} s`);
  function setVals(step, pairs) {
    const el = results.find((x) => x.dataset.step === step);
    if (!el) return;
    const box = el.querySelector(".ov-result-vals");
    box.replaceChildren(...pairs.map(([k, v]) => { const sp = document.createElement("span"); const b = document.createElement("b"); b.textContent = v; sp.append(`${k} `, b); return sp; }));
  }
  let FAIL = { zh: {}, serial: [] };
  try { FAIL = JSON.parse($("ov-fail-meta").textContent); } catch {}
  function fillLive(r, n) {
    const t = (id) => (n[id] ? n[id].total_s : null);
    const findings = Object.values(r.findings_by_severity || {}).reduce((a, x) => a + x, 0);
    const grades = Object.entries(r.grade_counts || {}).sort().map(([g, c]) => `${g} ${c}`).join(" · ") || "–";
    setVals("prepare", [["tile", String(r.n_blocks ?? "–")], ["耗时", sec(t("prepare"))]]);
    setVals("ingest", [["耗时", sec(t("ingest"))]]);
    // 切片检查只写单张切片的问题，序列检查只写相邻切片之间的问题（各自前三种类型）
    const byType = Object.entries(r.findings_by_type || {}).sort((a, b) => b[1] - a[1]);
    const part = (serial, label) => {
      const xs = byType.filter(([ft]) => FAIL.serial.includes(ft) === serial);
      return [[label, String(xs.reduce((a, [, c]) => a + c, 0))], ...xs.slice(0, 3).map(([ft, c]) => [FAIL.zh[ft] || ft, String(c)])];
    };
    setVals("slice_qc", part(false, "单张问题"));
    setVals("serial_qc", part(true, "序列问题"));
    setVals("aggregate", [["tile 等级", grades], ["质量分", r.quality_score == null ? "–" : r.quality_score.toFixed(2)], ["可用比例", pct(r.retention_rate)]]);
    setVals("persist", [["写入问题", `${findings} 条`], ["写入 tile", `${r.n_blocks_done ?? 0} / ${r.n_blocks ?? "–"}`]]);
    setVals("finalize", [["可用比例", pct(r.retention_rate)], ["总耗时", sec(Object.values(n).reduce((a, x) => a + (x.total_s || 0), 0))]]);
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
    for (const r of results) r.querySelector(".ov-result-vals").textContent = "";  // 换成这次运行自己的结果
    current = -1;
    show(0, 1 / steps.length, 0);
    const t0 = performance.now();
    let lastP = 0, lastId = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let w;
      try { w = await (await fetch(`/api/v1/qc/runs/${runId}/workflow?after_id=${lastId}&limit=500`)).json(); } catch { continue; }
      // 两次轮询之间走过的节点：分支节点亮一下；记下现在在第几个 z 段
      const tr = w.trace || [];
      if (w.last_id) lastId = w.last_id;
      for (const ev of tr) {
        if (ev.phase === "enter" && (ev.node === "next_group" || ev.node === "group_done")) flash(ev.node);
        if (ev.n_groups && ev.group != null && ev.group >= 0) zLabel = `z 段 ${ev.group + 1} / ${ev.n_groups}`;
      }
      const n = w.nodes || {};
      // 舞台显示「现在正在跑的那一步」：tile 在 切片检查 → 落库 之间循环时，舞台跟着循环
      const ALIAS_LIVE = { next_group: "ingest", group_done: "persist" };
      const pos = (w.position && w.position.node) || w.active;
      let idx = steps.indexOf(ALIAS_LIVE[pos] || pos);
      if (idx < 0) idx = Math.max(0, current);
      // 横线下面：跑过（至少一次）的步骤都打出结果，不会因为循环回去而消失
      const ran = new Set(steps.filter((id) => n[id] && n[id].visits > 0));
      const total = Object.values(n).reduce((a, x) => a + (x.total_s || 0), 0);
      const done = !["queued", "running"].includes(w.status);
      let r = null;
      try { r = await (await fetch(`/api/v1/qc/runs/${runId}`)).json(); } catch {}
      if (r) fillLive(r, n);
      // 进度条：打开 + 读取算 1 步，tile 完成多少走多少（中间 5 步），收尾 1 步；只增不减
      const tiles = w.n_blocks ? w.n_blocks_done / w.n_blocks : 0;
      const p = done ? 1 : Math.max(lastP, Math.min(0.999, (ran.has("ingest") ? 1 : 0) / steps.length + tiles * 5 / steps.length));
      lastP = p;
      show(done ? steps.length - 1 : idx, p, total || (performance.now() - t0) / 1000);
      if (totalLbl) totalLbl.textContent = `${(total || 0).toFixed(2)} s`;
      if (done) {
        if (status) { status.textContent = w.status === "done" ? "完成" : w.status === "error" ? "出错" : "已取消"; status.className = w.status === "done" ? "ov-pill-ok" : "inline-flex h-6 items-center rounded-full bg-[#2c1a20] px-2.5 text-[12px] text-[#e5566f]"; }
        if (msg) msg.textContent = w.status === "done" ? "运行完成，正在刷新数据…" : "运行没有正常完成，点运行编号看详情。";
        if (w.status === "done") {
          // 刷新拿新数据；刷新后直接停在「全部跑完」那一屏，看刚跑出来的每一步结果
          try { sessionStorage.setItem("ov-show-finished", "1"); } catch {}
          setTimeout(() => location.reload(), 1800);
        }
        break;
      }
    }
  }
})();
