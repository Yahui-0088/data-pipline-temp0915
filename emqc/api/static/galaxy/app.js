// 入口：把场景、粒子雕塑、数据、镜头、界面接起来。只用鼠标 / 触摸操作；只有一个渲染循环。
import { CONFIG, lowPowerDevice } from "./config.js";
import { GalaxyScene, webglAvailable } from "./scene.js";
import { ParticleSculpture } from "./particleSculpture.js";
import { DatasetManager } from "./datasetManager.js";
import { CameraRig } from "./cameraRig.js";
import { UI } from "./ui.js";

const showFatal = (msg) => {
  const f = document.getElementById("gx-fatal");
  f.hidden = false;
  f.querySelector("p").textContent = msg;
};

async function main() {
  if (!webglAvailable()) { showFatal("这个浏览器或显卡不支持 WebGL2，看不了 3D 粒子。请换用新版 Chrome / Edge / Firefox，或直接看「汇报详情」。"); return; }
  const container = document.getElementById("gx-canvas");
  let gscene;
  try { gscene = new GalaxyScene(container); }
  catch (e) { showFatal("WebGL 初始化失败：" + (e && e.message ? e.message : e)); return; }

  const rig = new CameraRig(gscene.camera);

  const data = new DatasetManager();
  await data.load();
  const sculpture = new ParticleSculpture(data, {
    count: lowPowerDevice() ? CONFIG.sculpture.particlesLow : CONFIG.sculpture.particlesHigh,
    pixelRatio: gscene.pixelRatio,
  });
  gscene.add(sculpture.points);
  const fitView = () => sculpture.setViewHeight(container.clientHeight);
  addEventListener("resize", fitView);
  fitView();

  // 外观固定：紫色，大小 / 亮度 / 辉光 / 速度取中间值
  const L = CONFIG.look, T = CONFIG.themes[CONFIG.defaults.theme];
  sculpture.setColors(T.a, T.b);
  sculpture.setSize(L.size);
  sculpture.setBrightness(L.brightness);
  gscene.setGlow(L.glow);
  const speed = L.speed;

  let lastInput = performance.now();
  const touch = () => { lastInput = performance.now(); };
  const ui = new UI();
  ui.setSummary(data.summary(), data.isMock, data.overflow);

  // ---------------------------------------------------------------- 鼠标 / 触摸
  const canvas = gscene.renderer.domElement;
  let pointer = null, drag = null;
  canvas.addEventListener("pointermove", (e) => {
    pointer = e.pointerType === "touch" && !drag ? null : { x: e.clientX, y: e.clientY };
    touch();
    if (drag) {
      rig.orbitBy(-(e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.006);
      drag = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener("pointerleave", () => { pointer = null; drag = null; });
  let press = null;
  canvas.addEventListener("pointerdown", (e) => { if (leaving) return; drag = { x: e.clientX, y: e.clientY }; pointer = { x: e.clientX, y: e.clientY }; press = { x: e.clientX, y: e.clientY, t: performance.now() }; canvas.setPointerCapture(e.pointerId); touch(); });
  canvas.addEventListener("pointerup", (e) => {
    drag = null;
    // 单击（没拖动）在发光的细胞上 → 粒子散开，转场进总览
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6 && performance.now() - press.t < 500 && onCell(e.clientX, e.clientY)) leave();
    press = null;
  });
  canvas.addEventListener("pointercancel", () => { drag = null; pointer = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); rig.zoomBy(Math.exp(e.deltaY * 0.0012)); touch(); }, { passive: false });
  addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea")) return;
    if (e.key === "r" || e.key === "R") { rig.reset(); touch(); }
    else if (e.key === "f" || e.key === "F") ui.toggleFullscreen();
  });

  // ---------------------------------------------------------------- 点细胞 → 转场进总览
  // 细胞在屏幕上的范围：把中心和「中心 + 半径 × 镜头右方向」投影到屏幕上量一下（半径和 shapes.js 里的细胞膜一致）
  const CELL_R = 1.08;
  const project = (v) => { const p = v.clone().project(gscene.camera); return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight }; };
  function onCell(x, y) {
    const cam = gscene.camera, c = project(cam.position.clone().multiplyScalar(0));
    const right = cam.position.clone().cross(cam.up).normalize().multiplyScalar(CELL_R);
    const e = project(right);
    return Math.hypot(x - c.x, y - c.y) <= Math.hypot(e.x - c.x, e.y - c.y);
  }
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let leaving = null;
  function leave() {
    if (leaving) return;
    const href = "/overview";
    const pre = document.createElement("link"); pre.rel = "prefetch"; pre.href = href; document.head.append(pre);
    document.body.classList.add("gx-leaving");
    leaving = { t0: performance.now(), dur: REDUCE ? 350 : 2300, href };
    // 跳转不依赖渲染循环：就算某一帧出错、或者标签页在后台不画了，到点也一定进总览
    setTimeout(() => { if (leaving && !leaving.gone) { leaving.gone = true; location.href = href; } }, leaving.dur + 150);
    if (!REDUCE) rig.setDistance(rig.target.dist * 0.82);            // 镜头轻轻往前推一点，散开更有纵深
  }
  function leaveStep(now) {
    if (typeof sculpture.setBurst !== "function") return;            // 万一拿到的是旧版脚本：只做淡出，照样跳转
    const s = (now - leaving.t0) / leaving.dur;
    if (REDUCE) { sculpture.setBurst(0, Math.min(1, s)); }
    else {
      // 前 1.4 秒炸开（着色器里是快出慢停），之后继续漂浮；最后 0.7 秒整体淡出
      sculpture.setBurst(Math.min(1, (now - leaving.t0) / 1400), Math.max(0, Math.min(1, (s - 0.7) / 0.3)));
    }
    if (s >= 1 && !leaving.gone) { leaving.gone = true; location.href = leaving.href; }
  }

  // ---------------------------------------------------------------- 渲染循环（只有一个）
  let last = performance.now(), clock = 0, running = true;
  function frame(now) {
    if (!running) return;
    const wallDt = Math.max(0.001, (now - last) / 1000);
    const dt = Math.min(0.1, wallDt);
    last = now;
    clock += dt * speed;                                    // 只影响流动，不影响镜头
    const idle = !drag && (now - lastInput) / 1000 > CONFIG.camera.idleBeforeAutoRotate;   // 鼠标不动 = 自转
    rig.update(dt, idle);
    if (leaving) leaveStep(now);
    const h = leaving ? -1 : sculpture.pick(pointer ? pointer.x : null, pointer ? pointer.y : null, gscene.camera, innerWidth, innerHeight);
    sculpture.update(clock, dt, h, rig.cur.dist, wallDt);
    ui.showInfo(h >= 0 ? data.datasets[h] : null, pointer ? pointer.x : 0, pointer ? pointer.y : 0);
    canvas.style.cursor = leaving ? "default" : drag ? "grabbing" : h >= 0 || (pointer && onCell(pointer.x, pointer.y)) ? "pointer" : "grab";
    gscene.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 从总览按「后退」回来时（页面从缓存里恢复），粒子要回到原样
  addEventListener("pageshow", (e) => { if (e.persisted && leaving) { leaving = null; sculpture.setBurst(0, 0); document.body.classList.remove("gx-leaving"); rig.reset(); } });
  addEventListener("pagehide", (e) => { if (!e.persisted) { running = false; sculpture.dispose(); gscene.dispose(); } });
  // 给自动化测试 / 调试用：只读的状态快照
  window.__galaxy = { rig, data, sculpture, leave, get hovered() { return sculpture.hovered; } };
}

main().catch((e) => { console.error(e); showFatal("加载失败：" + (e && e.message ? e.message : e)); });
