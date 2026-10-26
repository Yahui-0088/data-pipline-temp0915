// 汇报页 → 总览的转场（两页共用，2D canvas，不依赖任何库）。
// 整段运动都在汇报页上完成：白 / 紫 / 绿的光点从细胞里炸开 → 在外面慢慢飘 → 顺势收回中心，缩成一个静止的亮点；
// 这时才跳页。总览页第一帧就画同一个静止亮点，等页面准备好再让光晕散开、露出页面。
// 跳页只发生在「画面静止」的那一刻，所以运动里没有任何一帧停顿。
(function () {
  "use strict";
  const COLS = [
    ["255,255,255", 0.30], ["232,226,255", 0.12],             // 白
    ["201,184,240", 0.22], ["157,134,224", 0.16],             // 紫
    ["120,240,180", 0.12], ["44,240,138", 0.08],              // 绿
  ];
  const GLOW_R = 72;                                          // 中心亮点的半径（两页一致）

  function sprites() {
    return COLS.map(([c]) => {
      const s = document.createElement("canvas"); s.width = s.height = 32;
      const q = s.getContext("2d"), r = q.createRadialGradient(16, 16, 0, 16, 16, 16);
      r.addColorStop(0, `rgba(${c},1)`); r.addColorStop(0.3, `rgba(${c},0.6)`); r.addColorStop(1, `rgba(${c},0)`);
      q.fillStyle = r; q.fillRect(0, 0, 32, 32); return s;
    });
  }
  function pickCol(r) { let a = 0; for (let i = 0; i < COLS.length; i++) { a += COLS[i][1]; if (r < a) return i; } return 0; }

  function makeCanvas(z) {
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    cv.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:${z};pointer-events:none`;
    const W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    return { cv, g, W, H };
  }
  function glow(g, cx, cy, k) {                               // k: 0..1 亮点强度
    if (k <= 0.005) return;
    const R = 6 + (GLOW_R - 6) * k, rg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    rg.addColorStop(0, `rgba(255,255,255,${0.95 * k})`); rg.addColorStop(0.35, `rgba(214,200,250,${0.55 * k})`); rg.addColorStop(1, "rgba(157,134,224,0)");
    g.fillStyle = rg; g.fillRect(cx - R, cy - R, R * 2, R * 2);
  }

  // ---- 汇报页：炸开 → 漂 → 收回中心，一条连续曲线；结束时回调（此时画面是静止的亮点）
  // 每颗光点离中心的距离 = R · h(u)，h(u) = u^a (1-u)^b 归一化：a 小 → 一开始像炸开一样快，之后越来越慢地飘到最远，
  // 顺势掉头加速收回，b = 2 → 到中心时速度正好降到 0。全程只有这一个函数，没有分段，所以没有顿挫。
  function burst(from, onDone) {
    const { cv, g, W, H } = makeCanvas(40);
    document.body.append(cv);
    const SPR = sprites(), cx = W / 2, cy = H / 2;
    const N = Math.round(Math.min(4200, (W * H) / 240)), DIAG = Math.hypot(W, H);
    // 散开 0–30%：缓出（一下子炸开、越来越慢）；30–100%：smootherstep 收回（慢慢掉头、加速、最后缓停）。
    // 两段在接点处位置相同、速度都为 0（像往上抛的球到顶），再叠一层很缓的 sin 漂移，所以整条运动 C1 连续、没有停顿。
    const SPLIT = 0.3, ss = (v) => v * v * v * (v * (v * 6 - 15) + 10);
    const hcurve = (u) => {
      const base = u < SPLIT ? 1 - Math.pow(1 - u / SPLIT, 3) : 1 - ss((u - SPLIT) / (1 - SPLIT));
      return Math.max(0, base + 0.07 * Math.sin(Math.PI * u) * (1 - u));
    };
    const P = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.pow(Math.random(), 0.75);   // 远近都有，中间不留空洞
      const j = Math.sqrt(Math.random()) * from.r;              // 起点：散在细胞的范围里
      P[i] = { sx: from.x + Math.cos(a) * j - cx, sy: from.y + Math.sin(a) * j - cy,
               dx: Math.cos(a), dy: Math.sin(a) * 0.82, R: (0.02 + 0.5 * rr) * DIAG, s: Math.random(),
               c: pickCol(Math.random()), sz: (1.8 + Math.random() * 3.6) * (Math.random() < 0.07 ? 2.2 : 1), al: 0.65 + 0.35 * Math.random(),
               wob: Math.random() * 6.28 };
    }
    const DUR = 1900;
    let t0 = 0, done = false;
    function frame(now) {
      if (!t0) t0 = now;
      const T = Math.min(1, (now - t0) / DUR);
      g.clearRect(0, 0, W, H);
      g.globalCompositeOperation = "lighter";
      for (let i = 0; i < N; i++) {
        const p = P[i];
        const u = T, h = hcurve(u), back = (1 - u) * (1 - u);
        const sway = Math.sin(u * 6.0 + p.wob) * 6 * h;        // 漂浮时轻轻晃
        const x = cx + p.sx * back + p.dx * p.R * h + sway, y = cy + p.sy * back + p.dy * p.R * h + sway * 0.6;
        const near = Math.min(1, h * 3);                     // 只在最后贴近中心时才变小变暗，汇进亮点
        const sz = p.sz * (0.3 + 0.7 * near);
        g.globalAlpha = p.al * (0.25 + 0.75 * near);
        g.drawImage(SPR[p.c], x - sz, y - sz, sz * 2, sz * 2);
      }
      g.globalAlpha = 1;
      glow(g, cx, cy, Math.pow(Math.max(0, (T - 0.6) / 0.4), 2));
      g.globalCompositeOperation = "source-over";
      if (T >= 1) {
        if (!done) { done = true; onDone && onDone(); }
        g.clearRect(0, 0, W, H); glow(g, cx, cy, 1);           // 停在静止的亮点上，等跳页
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return cv;
  }

  // ---- 总览页：第一帧就是同一个静止亮点（黑底）；ready() 之后光晕散开、整层淡出
  function arrive(whenReady) {
    const { cv, g, W, H } = makeCanvas(100);
    cv.id = "ov-intro"; cv.style.background = "#000";
    document.body.prepend(cv);
    const cx = W / 2, cy = H / 2;
    glow(g, cx, cy, 1);                                         // 同步画，保证第一次绘制就有
    let t0 = 0;
    const OUT = 650;
    function frame(now) {
      if (!t0) t0 = now;
      const r = Math.min(1, (now - t0) / OUT), e = 1 - Math.pow(1 - r, 3);
      g.clearRect(0, 0, W, H);
      // 光晕放大、变淡，同时黑底淡出
      const R = GLOW_R + e * Math.hypot(W, H) * 0.5, rg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      rg.addColorStop(0, `rgba(255,255,255,${0.95 * (1 - e)})`); rg.addColorStop(0.35, `rgba(214,200,250,${0.5 * (1 - e)})`); rg.addColorStop(1, "rgba(157,134,224,0)");
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
      cv.style.background = `rgba(0,0,0,${1 - e})`;
      if (r >= 1) { cv.remove(); return; }
      requestAnimationFrame(frame);
    }
    whenReady.then(() => requestAnimationFrame(frame));
    setTimeout(() => cv.isConnected && cv.remove(), 9000);       // 兜底
    return cv;
  }

  window.GxTransition = { burst, arrive };
})();
