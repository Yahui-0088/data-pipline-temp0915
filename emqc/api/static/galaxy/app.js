// 入口：把场景、粒子雕塑、数据、镜头、界面接起来。只用鼠标 / 触摸操作；只有一个渲染循环。
import { CONFIG, lowPowerDevice } from "./config.js";
import { GalaxyScene, webglAvailable } from "./scene.js";
import { ParticleSculpture } from "./particleSculpture.js";
import { DatasetManager } from "./datasetManager.js";
import { CameraRig } from "./cameraRig.js";
import { UI, loadPrefs } from "./ui.js";

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

  const prefs = loadPrefs();
  const rig = new CameraRig(gscene.camera);
  rig.setHome(CONFIG.camera.initialAzimuth, CONFIG.camera.shapeElevation[prefs.shape]);

  const data = new DatasetManager();
  await data.load();
  const sculpture = new ParticleSculpture(data, {
    count: lowPowerDevice() ? CONFIG.sculpture.particlesLow : CONFIG.sculpture.particlesHigh,
    pixelRatio: gscene.pixelRatio, shape: prefs.shape,
  });
  gscene.add(sculpture.points);
  const fitView = () => sculpture.setViewHeight(container.clientHeight);
  addEventListener("resize", fitView);
  fitView();

  let speed = 1, autoRotate = true, lastInput = performance.now();
  const touch = () => { lastInput = performance.now(); };
  const ui = new UI(prefs, {
    shape: (s) => { sculpture.setShape(s); rig.setHome(rig.target.az, CONFIG.camera.shapeElevation[s], false); touch(); },
    color: ({ a, b }) => sculpture.setColors(a, b),
    tune: (key, v) => {
      if (key === "size") sculpture.setSize(v);
      else if (key === "brightness") sculpture.setBrightness(v);
      else if (key === "glow") gscene.setGlow(v);
      else if (key === "speed") speed = v;
    },
    auto: (on) => { autoRotate = on; },
    reset: () => { rig.reset(); touch(); },
  });
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
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; pointer = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); touch(); });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointercancel", () => { drag = null; pointer = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); rig.zoomBy(Math.exp(e.deltaY * 0.0012)); touch(); }, { passive: false });
  addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea")) return;
    if (e.key === "r" || e.key === "R") { rig.reset(); touch(); }
    else if (e.key === "f" || e.key === "F") ui.toggleFullscreen();
  });

  // ---------------------------------------------------------------- 渲染循环（只有一个）
  let last = performance.now(), clock = 0, running = true;
  function frame(now) {
    if (!running) return;
    const wallDt = Math.max(0.001, (now - last) / 1000);
    const dt = Math.min(0.1, wallDt);
    last = now;
    clock += dt * speed;                                    // 速度滑杆：只影响流动，不影响镜头和变形
    const idle = autoRotate && !drag && (now - lastInput) / 1000 > CONFIG.camera.idleBeforeAutoRotate;
    rig.update(dt, idle);
    const h = sculpture.pick(pointer ? pointer.x : null, pointer ? pointer.y : null, gscene.camera, innerWidth, innerHeight);
    sculpture.update(clock, dt, h, rig.cur.dist, wallDt);
    ui.showInfo(h >= 0 ? data.datasets[h] : null, pointer ? pointer.x : 0, pointer ? pointer.y : 0);
    canvas.style.cursor = drag ? "grabbing" : h >= 0 ? "pointer" : "grab";
    gscene.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener("pagehide", (e) => { if (!e.persisted) { running = false; sculpture.dispose(); gscene.dispose(); } });
  // 给自动化测试 / 调试用：只读的状态快照
  window.__galaxy = { rig, data, sculpture, get hovered() { return sculpture.hovered; }, prefs };
}

main().catch((e) => { console.error(e); showFatal("加载失败：" + (e && e.message ? e.message : e)); });
