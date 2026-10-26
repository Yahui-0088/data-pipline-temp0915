// 总览页「问题切片」：地面透视的多轨胶片墙 + 悬停聚焦 + 滚轮切换 + 侧边浏览条。
// 每行是一种问题类型（真实的问题截图）；相邻行反向匀速滚动、速度不同；悬停一行这一行慢下来；
// 悬停一张图：它从原位浮到展示区正中，转为正面，旁边只写「类型 · 序号 / 总数」和一句说明。
(() => {
  "use strict";
  const wall = document.getElementById("ov-wall");
  const dataEl = document.getElementById("ov-wall-data");
  if (!wall || !dataEl) return;
  let DATA = [];
  try { DATA = JSON.parse(dataEl.textContent); } catch { return; }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const DESC = {
    blank: "整张切片几乎没有信号，像是空拍。", blur: "失焦或抖动，细胞膜边界看不清。", saturation: "亮度顶满，过曝区域的细节丢失。",
    corrupt: "文件读不出或数据损坏。", missing: "这个 z 位置没有切片。", crack: "切片上有裂缝或褶皱。", no_coverage: "成像范围外的空白区域。",
    missing_region: "切片里缺了一块。", charging: "荷电造成的条纹或亮斑。", contamination: "表面有颗粒或污染物。",
    local_deformation: "局部被拉伸或扭曲。", section_deformation: "整张切片发生形变。", local_misalign: "局部和相邻切片对不齐。",
    contrast_drift: "对比度沿 z 方向慢慢漂移。", brightness_jump: "和上一张相比亮度突然跳变。", slice_jump: "相邻切片内容不连续，像跳了一张。",
    global_misalign: "整张和相邻切片错位。", z_order: "切片顺序颠倒。",
  };
  const SPEED = [30, 44, 24, 38, 27, 34];  // 每行每秒移动的像素；相邻两行方向相反

  // ------------------------------------------------------------------ 胶片：每种问题一行，横向无缝循环
  const cols = [...wall.querySelectorAll(".ov-wall-row")].map((col, ci) => {
    const track = col.querySelector(".ov-wall-track");
    const reel = col.querySelector(".ov-wall-reel");
    const base = [...reel.children];
    // 先补到比这一行可见宽度多两张，再整体复制一份：动画走「一份」的长度回到原点，正好无缝（图少时同一批图重复出现）
    const visible = track.clientWidth || 2400;
    const unit = (base[0] ? base[0].offsetWidth : 150) + 16;
    let copies = 1;
    while (base.length * copies * unit < visible + unit * 2) copies++;
    for (let c = 1; c < copies; c++) base.forEach((n) => { const k = n.cloneNode(true); k.tabIndex = -1; k.setAttribute("aria-hidden", "true"); reel.append(k); });
    const set = [...reel.children];
    set.forEach((n) => { const k = n.cloneNode(true); k.tabIndex = -1; k.setAttribute("aria-hidden", "true"); reel.append(k); });
    const span = set.length * unit;
    const left = ci % 2 === 0;
    let anim = null;
    if (!reduce) {
      anim = reel.animate(
        left ? [{ transform: "translateX(0)" }, { transform: `translateX(${-span}px)` }] : [{ transform: `translateX(${-span}px)` }, { transform: "translateX(0)" }],
        { duration: (span / SPEED[ci % SPEED.length]) * 1000, iterations: Infinity, easing: "linear" });
      anim.currentTime = ((ci * 0.37) % 1) * anim.effect.getTiming().duration;  // 各行起点错开
    }
    return { col, reel, anim, ci, rate: 1, target: 1, data: DATA[ci] };
  });

  // 分类名：正面画在每一行左端看得见的地方（把行里的锚点挪到展示区左侧 11% 处，再按它投影到屏幕上的位置放标签）
  function placeLabels() {
    const wr = wall.getBoundingClientRect();
    const tx = wr.left + wr.width * 0.11;
    wall.querySelectorAll(".ov-wall-label").forEach((lb) => {
      const c = cols[+lb.dataset.row]; if (!c) return;
      const an = c.col.querySelector(".ov-wall-anchor");
      let L = parseFloat(an.style.left) || 600;
      for (let i = 0; i < 4; i++) {
        const r = an.getBoundingClientRect(), ref = c.col.getBoundingClientRect();
        const k = ref.width / c.col.offsetWidth || 1;
        L += (tx - r.left) / k; an.style.left = `${L}px`;
      }
      const r = an.getBoundingClientRect();
      lb.style.left = `${r.left - wr.left}px`;
      lb.style.top = `${Math.min(Math.max(r.top + r.height / 2 - wr.top, 26), wr.height - 26)}px`;
    });
  }
  // ------------------------------------------------------------------ 一次看三行：右侧发光滚轮 + 鼠标滚轮上下切换
  const SHOW = 3;
  const box = document.getElementById("ov-wall-box");
  const plane = wall.querySelector(".ov-wall-plane");
  const scroller = document.getElementById("ov-wall-scroll");
  const sThumb = scroller && scroller.querySelector(".ov-wall-scroll-thumb");
  const maxStart = Math.max(0, cols.length - SHOW);
  let start = 0, quietUntil = 0;
  function follow(ms) {  // 平面在动的这段时间里，分类名跟着投影位置走
    const t0 = performance.now();
    const step = () => { placeLabels(); if (performance.now() - t0 < ms) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function setStart(s, instant) {
    s = Math.max(0, Math.min(maxStart, s));
    const changed = s !== start; start = s;
    const row = cols[0] ? cols[0].col : null;
    const unit = row ? row.offsetHeight + parseFloat(getComputedStyle(plane).rowGap || 22) : 190;
    if (instant) plane.style.transition = "none";
    plane.style.setProperty("--shift", `${(cols.length - SHOW - start) * unit}px`);
    if (instant) { plane.offsetHeight; plane.style.transition = ""; }
    cols.forEach((c, i) => {
      const out = i < start || i >= start + SHOW;
      c.col.classList.toggle("is-out", out);
      c.col.querySelectorAll(".ov-wall-card").forEach((b) => { if (!b.hasAttribute("aria-hidden")) b.tabIndex = out ? -1 : 0; });
    });
    wall.querySelectorAll(".ov-wall-label").forEach((lb) => { const i = +lb.dataset.row; lb.classList.toggle("is-out", i < start || i >= start + SHOW); });
    if (sThumb) {
      const h = scroller.clientHeight, th = Math.max(24, (h * SHOW) / cols.length);
      sThumb.style.height = `${th}px`;
      sThumb.style.top = `${maxStart ? (start / maxStart) * (h - th) : 0}px`;
      scroller.setAttribute("aria-valuemin", "0"); scroller.setAttribute("aria-valuemax", String(maxStart)); scroller.setAttribute("aria-valuenow", String(start));
      scroller.setAttribute("aria-valuetext", `第 ${start + 1}–${Math.min(cols.length, start + SHOW)} 类，共 ${cols.length} 类`);
    }
    if (instant) placeLabels(); else if (changed) follow(reduce ? 50 : 620);
  }
  setStart(0, true);
  addEventListener("resize", () => setStart(start, true));

  // 鼠标在图片墙或滚轮上滚动：一格换一行；已经到头时不拦截，页面照常滚动
  let wAcc = 0, wLast = 0, wLockUntil = 0;
  const onWallWheel = (e) => {
    if (focus || maxStart === 0) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    if ((dy > 0 && start >= maxStart) || (dy < 0 && start <= 0)) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wLast > 220) wAcc = 0;
    wLast = now;
    if (now < wLockUntil) return;
    wAcc += dy;
    clearTimeout(hoverT); hoverT = 0; quietUntil = now + 700;
    if (Math.abs(wAcc) >= 46) { setStart(start + (wAcc > 0 ? 1 : -1)); wAcc = 0; wLockUntil = now + 480; }
  };
  wall.addEventListener("wheel", onWallWheel, { passive: false });
  if (scroller) {
    scroller.addEventListener("wheel", onWallWheel, { passive: false });
    let sDrag = false;
    const at = (y) => { const r = scroller.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (y - r.top) / r.height)) * maxStart); };
    scroller.addEventListener("pointerdown", (e) => { e.preventDefault(); sDrag = true; sThumb.classList.add("is-drag"); scroller.setPointerCapture(e.pointerId); setStart(at(e.clientY)); });
    scroller.addEventListener("pointermove", (e) => { if (sDrag) setStart(at(e.clientY)); });
    const end = () => { sDrag = false; sThumb.classList.remove("is-drag"); };
    scroller.addEventListener("pointerup", end); scroller.addEventListener("pointercancel", end);
    scroller.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); setStart(start + 1); }
      else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); setStart(start - 1); }
    });
  }

  // 速度平滑过渡（悬停一行 → 慢下来；聚焦 → 停住）
  let raf = 0;
  function tick() {
    let busy = false;
    for (const c of cols) {
      if (!c.anim) continue;
      const d = c.target - c.rate;
      if (Math.abs(d) > 0.004) { c.rate += d * 0.08; busy = true; } else c.rate = c.target;
      c.anim.playbackRate = c.rate;
    }
    raf = busy ? requestAnimationFrame(tick) : 0;
  }
  const setRate = (c, r) => { c.target = r; if (!raf) raf = requestAnimationFrame(tick); };
  for (const c of cols) {
    c.col.addEventListener("pointerenter", () => { if (!focus) setRate(c, 0.18); });
    c.col.addEventListener("pointerleave", () => { if (!focus) setRate(c, 1); });
  }

  // ------------------------------------------------------------------ 聚焦层
  let focus = null;  // {c, k, stage, frame, img, ...}
  const layer = document.createElement("div");
  layer.className = "ov-focus";
  layer.innerHTML = `<div class="ov-focus-stage" role="dialog" aria-modal="false" aria-label="问题切片预览">
      <div class="ov-focus-frame"></div>
      <div class="ov-focus-side">
        <div class="ov-focus-bar" role="slider" aria-orientation="vertical" tabindex="0"><span class="ov-focus-thumb"></span></div>
        <div class="ov-focus-cap"><p class="ov-focus-title"></p><p class="ov-focus-desc"></p></div>
      </div>
    </div>`;
  layer.hidden = true;
  document.body.append(layer);
  const stage = layer.querySelector(".ov-focus-stage"), frame = layer.querySelector(".ov-focus-frame");
  const bar = layer.querySelector(".ov-focus-bar"), thumb = layer.querySelector(".ov-focus-thumb");
  const title = layer.querySelector(".ov-focus-title"), desc = layer.querySelector(".ov-focus-desc");
  const pad = (n, w) => String(n).padStart(w, "0");

  // 画面上看得见的那一张（同一张图在胶片上有好几份）
  function visibleCard(c, k) {
    const wr = wall.getBoundingClientRect();
    let best = null, bd = Infinity;
    for (const el of c.reel.querySelectorAll(`.ov-wall-card[data-k="${k}"]`)) {
      const r = el.getBoundingClientRect();
      if (r.bottom < wr.top || r.top > wr.bottom || r.right < wr.left + wr.width * 0.1 || r.left > wr.right - wr.width * 0.1) continue;
      const d = Math.abs(r.left + r.width / 2 - (wr.left + wr.width / 2));
      if (d < bd) { bd = d; best = el; }
    }
    return best;
  }

  // 中央大图的尺寸和位置：展示区正中（展示区一部分滚出屏幕时，夹在视口里）
  function layout(img) {
    const wr = wall.getBoundingClientRect();
    const mobile = innerWidth < 768;
    const ar = img && img.naturalWidth ? img.naturalWidth / img.naturalHeight : 1;
    const maxW = mobile ? innerWidth - 40 : Math.min(620, innerWidth * 0.5), maxH = Math.min(560, innerHeight * 0.66);
    let w = maxW, h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }
    const sideW = mobile ? 0 : 6 + 16 + 208 + 18;  // 浏览条 + 说明
    const cy = Math.min(Math.max(wr.top + wr.height / 2, h / 2 + 24), innerHeight - h / 2 - (mobile ? 110 : 24));
    const cx = wr.left + wr.width / 2;
    return { w, h, x: Math.round(cx - (w + sideW) / 2), y: Math.round(cy - h / 2) };
  }

  function place(L) {
    stage.style.left = `${L.x}px`; stage.style.top = `${L.y}px`;
    frame.style.width = `${L.w}px`; frame.style.height = `${L.h}px`;
    bar.style.height = `${L.h}px`;
  }

  function caption() {
    const { c, k } = focus, n = c.data.items.length, w = String(n).length < 2 ? 2 : String(n).length;
    title.innerHTML = "";
    title.append(`${c.data.zh} · `);
    const b = document.createElement("b"); b.textContent = `${pad(k + 1, w)} / ${pad(n, w)}`; title.append(b);
    desc.textContent = DESC[c.data.type] || "这一类问题的截图。";
    const th = Math.max(20, bar.clientHeight / n);
    thumb.style.height = `${th}px`;
    thumb.style.top = `${n > 1 ? (k / (n - 1)) * (bar.clientHeight - th) : 0}px`;
    bar.setAttribute("aria-valuemin", "1"); bar.setAttribute("aria-valuemax", String(n)); bar.setAttribute("aria-valuenow", String(k + 1));
    bar.setAttribute("aria-valuetext", `${c.data.zh} 第 ${k + 1} 张，共 ${n} 张`);
  }

  function hold(c, k) {
    wall.querySelectorAll(".ov-wall-card.is-held").forEach((x) => x.classList.remove("is-held"));
    c.reel.querySelectorAll(`.ov-wall-card[data-k="${k}"]`).forEach((x) => x.classList.add("is-held"));
  }

  function open(card) {
    if (focus) return;
    const c = cols.find((x) => x.reel.contains(card));
    if (!c) return;
    const k = +card.dataset.k;
    const src = card.querySelector("img");
    const img = new Image(); img.src = c.data.items[k].url; img.alt = `${c.data.zh} 第 ${k + 1} 张`; img.draggable = false;
    frame.replaceChildren(img);
    const L = layout(src);
    place(L);
    focus = { c, k, entered: false, card, closing: false };
    cols.forEach((x) => setRate(x, 0));
    hold(c, k);
    layer.hidden = false;
    wall.classList.add("is-focus"); box && box.classList.add("is-focus");
    caption();
    // 从原位置飞到中央：同一个框，先放在原卡片的位置（FLIP），再回到正常位置
    const r = card.getBoundingClientRect();
    const sx = r.width / L.w, sy = r.height / L.h;
    const from = `translate(${r.left - L.x}px, ${r.top - L.y}px) scale(${sx}, ${sy})`;
    frame.animate([{ transform: from, opacity: 0.85 }, { transform: "none", opacity: 1 }], { duration: reduce ? 1 : 460, easing: EASE });
    requestAnimationFrame(() => layer.classList.add("is-open"));
  }

  function close() {
    if (!focus || focus.closing) return;
    focus.closing = true;
    clearTimeout(leaveT);
    const { c, k } = focus;
    const target = visibleCard(c, k);
    const fr = frame.getBoundingClientRect();
    layer.classList.remove("is-open");
    wall.classList.remove("is-focus"); box && box.classList.remove("is-focus");
    let a;
    if (target && !reduce) {
      const r = target.getBoundingClientRect();
      a = frame.animate([{ transform: "none" }, { transform: `translate(${r.left - fr.left}px, ${r.top - fr.top}px) scale(${r.width / fr.width}, ${r.height / fr.height})`, opacity: 0.6 }],
        { duration: 400, easing: EASE, fill: "forwards" });
    } else {
      a = frame.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], { duration: 240, easing: EASE, fill: "forwards" });
    }
    a.onfinish = () => {
      layer.hidden = true; a.cancel();
      wall.querySelectorAll(".ov-wall-card.is-held").forEach((x) => x.classList.remove("is-held"));
      const last = focus; focus = null;
      cols.forEach((x) => setRate(x, x.col.matches(":hover") ? 0.18 : 1));
      if (last && last.viaKey && target) target.focus({ preventScroll: true });
    };
  }

  // 同一类里换一张：旧图向上 / 下淡出，新图从另一侧轻微位移 + 缩放淡入，中央位置不动
  function go(k) {
    if (!focus || focus.closing) return;
    const n = focus.c.data.items.length;
    k = Math.max(0, Math.min(n - 1, k));
    if (k === focus.k) return;
    const dir = k > focus.k ? 1 : -1;
    focus.k = k;
    const old = frame.querySelector("img:last-child");
    const img = new Image(); img.src = focus.c.data.items[k].url; img.alt = `${focus.c.data.zh} 第 ${k + 1} 张`; img.draggable = false;
    frame.append(img);
    const d = reduce ? 1 : 1;
    if (old) {
      const o = old.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${-dir * 16 * d}px) scale(0.97)` }],
        { duration: reduce ? 120 : 220, easing: "ease-in", fill: "forwards" });
      o.onfinish = () => old.remove();
    }
    img.animate([{ opacity: 0, transform: `translateY(${dir * 18 * d}px) scale(0.97)` }, { opacity: 1, transform: "none" }],
      { duration: reduce ? 150 : 380, easing: EASE });
    hold(focus.c, k);
    caption();
  }

  // ------------------------------------------------------------------ 进入：悬停（有鼠标）/ 点击（触屏、键盘）
  // 只有鼠标自己移到图片上才打开：胶片在滚、或者刚用滚轮翻过行，图片从静止的鼠标底下滑过去时不打开
  let hoverT = 0, lastMove = 0;
  wall.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    lastMove = performance.now();
    if (!finePointer || focus || performance.now() < quietUntil) return;
    const card = e.target.closest(".ov-wall-card");
    if (!card) { clearTimeout(hoverT); hoverT = 0; return; }
    if (hoverT && card === hoverCard) return;
    clearTimeout(hoverT); hoverCard = card;
    hoverT = setTimeout(() => {  // 停留 160ms 才打开，一扫而过不触发
      hoverT = 0;
      if (!focus && card.matches(":hover") && performance.now() - lastMove < 400 && performance.now() >= quietUntil) open(card);
    }, 160);
  });
  let hoverCard = null;
  wall.addEventListener("pointerleave", () => clearTimeout(hoverT));
  wall.addEventListener("click", (e) => {
    const card = e.target.closest(".ov-wall-card");
    if (!card || focus) return;
    e.stopPropagation();
    open(card);
    if (e.detail === 0 && focus) { focus.viaKey = true; bar.focus({ preventScroll: true }); }
  });

  // ------------------------------------------------------------------ 退出：离开预览区约 300ms / 点空白 / Esc
  let leaveT = 0;
  stage.addEventListener("pointerenter", () => { if (focus) { focus.entered = true; clearTimeout(leaveT); } });
  stage.addEventListener("pointerleave", (e) => {
    if (!focus || e.pointerType !== "mouse" || drag) return;
    clearTimeout(leaveT); leaveT = setTimeout(close, 300);
  });
  // 刚打开时鼠标还停在原来的位置：在它进入中央大图之前，只要还在展示区里就不收起
  document.addEventListener("pointermove", (e) => {
    if (!focus || focus.entered || e.pointerType !== "mouse") return;
    const r = wall.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    clearTimeout(leaveT);
    if (!inside) leaveT = setTimeout(close, 300);
  });
  document.addEventListener("pointerdown", (e) => { if (focus && !stage.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => {
    if (!focus) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(focus.k + 1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(focus.k - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(focus.c.data.items.length - 1); }
  });
  addEventListener("resize", () => { if (focus) close(); });
  addEventListener("scroll", () => { if (focus && !focus.closing) { const L = layout(frame.querySelector("img")); place(L); } }, { passive: true });

  // ------------------------------------------------------------------ 滚轮：只在预览区里切图；阈值 + 节流，兼容触控板惯性
  let acc = 0, lastWheel = 0, lockUntil = 0, quietT = 0, locked = false;
  stage.addEventListener("wheel", (e) => {
    if (!focus) return;
    e.preventDefault();
    const now = performance.now();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    if (now - lastWheel > 220) acc = 0;
    lastWheel = now;
    // 切过一张以后，要等滚轮停一下（触控板惯性的尾巴）或者过 600ms 才能再切
    clearTimeout(quietT); quietT = setTimeout(() => { locked = false; }, 140);
    if (locked && now < lockUntil) return;
    acc += dy;
    if (Math.abs(acc) >= 46) {
      go(focus.k + (acc > 0 ? 1 : -1));
      acc = 0; locked = true; lockUntil = now + 600;
    }
  }, { passive: false });

  // ------------------------------------------------------------------ 浏览条：点轨道跳转、拖滑块
  let drag = false;
  const idxAt = (clientY) => {
    const r = bar.getBoundingClientRect(), n = focus.c.data.items.length;
    return Math.round(Math.max(0, Math.min(1, (clientY - r.top) / r.height)) * (n - 1));
  };
  bar.addEventListener("pointerdown", (e) => {
    if (!focus) return;
    e.preventDefault(); e.stopPropagation();
    drag = true; thumb.classList.add("is-drag"); bar.setPointerCapture(e.pointerId);
    go(idxAt(e.clientY));
  });
  bar.addEventListener("pointermove", (e) => { if (drag && focus) go(idxAt(e.clientY)); });
  const endDrag = () => { drag = false; thumb.classList.remove("is-drag"); };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);

  // ------------------------------------------------------------------ 触屏：在大图上上下滑切图
  let ty = null;
  stage.addEventListener("touchstart", (e) => { ty = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener("touchmove", (e) => { if (focus) e.preventDefault(); }, { passive: false });
  stage.addEventListener("touchend", (e) => {
    if (ty == null || !focus) return;
    const dy = e.changedTouches[0].clientY - ty; ty = null;
    if (Math.abs(dy) > 40) go(focus.k + (dy < 0 ? 1 : -1));
  });
})();
