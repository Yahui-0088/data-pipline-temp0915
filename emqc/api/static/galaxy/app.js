// 入口：把场景、星球、数据、镜头、手势、界面接起来。只有一个渲染循环。
import * as THREE from "three";
import { CONFIG, lowPowerDevice } from "./config.js";
import { GalaxyScene, webglAvailable } from "./scene.js";
import { ParticlePlanet } from "./particlePlanet.js";
import { DatasetManager } from "./datasetManager.js";
import { CameraRig } from "./cameraRig.js";
import { HandTracker, TRACK_STATUS } from "./handTracking.js";
import { GestureController, STATE } from "./gestureController.js";
import { UI } from "./ui.js";

const ui = new UI();

async function main() {
  if (!webglAvailable()) { ui.fatal("这个浏览器或显卡不支持 WebGL2，看不了 3D 星球。请换用新版 Chrome / Edge / Firefox，或直接看「汇报详情」。"); return; }
  const container = document.getElementById("gx-canvas");
  let gscene;
  try { gscene = new GalaxyScene(container); }
  catch (e) { ui.fatal("WebGL 初始化失败：" + (e && e.message ? e.message : e)); return; }
  const rig = new CameraRig(gscene.camera);

  const data = new DatasetManager();
  await data.load();
  // 打开时正对一个数据集区域（优先已处理的），略偏一点，让区域落在受光面
  const focus = data.datasets.find((d) => d.status === "processed") || data.datasets[0];
  if (focus) { const [x, y, z] = focus.center; rig.setHome(Math.atan2(x, z) - 0.35, Math.asin(Math.max(-1, Math.min(1, y))) + 0.12); }
  ui.setSummary(data.summary(), data.isMock, data.overflow);
  const planet = new ParticlePlanet(data.datasets, { count: lowPowerDevice() ? CONFIG.planet.particlesLow : CONFIG.planet.particlesHigh, pixelRatio: gscene.pixelRatio });
  gscene.add(planet.points);
  addEventListener("resize", () => planet.setViewHeight(container.clientHeight));
  planet.setViewHeight(container.clientHeight);

  // ---------------------------------------------------------------- 输入
  let mode = "mouse";                       // "mouse" | "hand"
  let mouse = null;                         // 鼠标在画面里的位置（0–1）
  let lastInput = performance.now();
  let drag = null;
  const canvas = gscene.renderer.domElement;
  canvas.addEventListener("pointermove", (e) => {
    mouse = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
    lastInput = performance.now();
    if (drag) {
      rig.orbitBy(-(e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.006);
      drag = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener("pointerleave", () => { mouse = null; drag = null; });
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); rig.zoomBy(Math.exp(e.deltaY * 0.0012)); lastInput = performance.now(); }, { passive: false });
  addEventListener("keydown", (e) => { if (e.key === "r" || e.key === "R") rig.reset(); });

  const gesture = new GestureController();
  let gout = gesture.out;
  const tracker = new HandTracker({
    onResult: (res, t, aspect) => {
      gout = gesture.update(res, t, aspect, rig.target.dist);
      if (gout.handPresent) lastInput = performance.now();
      drawDebug(res);
    },
    onStatus: (status, detail) => {
      ui.setTracking(status, detail);
      if (status === TRACK_STATUS.RUNNING) mode = "hand";
      else if (status !== TRACK_STATUS.STARTING && status !== TRACK_STATUS.LOADING) { mode = "mouse"; gesture.reset(); gout = gesture.out; }
    },
  });
  ui.setTracking(TRACK_STATUS.OFF, "");

  document.getElementById("gx-enter").addEventListener("click", () => { ui.hideStart(); tracker.start(); });
  document.getElementById("gx-mouse").addEventListener("click", () => ui.hideStart());
  document.getElementById("gx-reset").addEventListener("click", () => rig.reset());
  document.getElementById("gx-toggle").addEventListener("click", () => {
    if (tracker.status === TRACK_STATUS.RUNNING || tracker.status === TRACK_STATUS.LOADING || tracker.status === TRACK_STATUS.STARTING) { tracker.stop(); mode = "mouse"; ui.setTracking(TRACK_STATUS.OFF, ""); }
    else tracker.start();
  });

  // 调试画面：默认收起；展开后画关键点，方便判断识别得准不准
  const dbg = document.getElementById("gx-debug"), dbgCtx = dbg.getContext("2d");
  const dbgOpen = document.getElementById("gx-debug-wrap");
  function drawDebug(res) {
    if (!dbgOpen.open || !tracker.video) return;
    const v = tracker.video;
    dbgCtx.save();
    dbgCtx.setTransform(-1, 0, 0, 1, dbg.width, 0);
    dbgCtx.drawImage(v, 0, 0, dbg.width, dbg.height);
    dbgCtx.restore();
    dbgCtx.fillStyle = "#3dff9a";
    (res.landmarks || []).forEach((lm) => lm.forEach((p) => { dbgCtx.beginPath(); dbgCtx.arc((1 - p.x) * dbg.width, p.y * dbg.height, 2.5, 0, 7); dbgCtx.fill(); }));
  }

  // ---------------------------------------------------------------- 光标 → 星球表面上的数据集
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), sphere = new THREE.Sphere(new THREE.Vector3(), CONFIG.planet.radius * 1.01), hit = new THREE.Vector3();
  let hovered = -1;
  function pick(cursor) {
    if (!cursor) { hovered = -1; return -1; }
    ndc.set(cursor.x * 2 - 1, -(cursor.y * 2 - 1));
    raycaster.setFromCamera(ndc, gscene.camera);
    if (!raycaster.ray.intersectSphere(sphere, hit)) { hovered = -1; return -1; }
    hit.normalize();
    // 滞回：已选中的区域要明显离开才放开，避免在相邻区域之间来回跳
    if (hovered >= 0 && data.ratioTo(hovered, hit.x, hit.y, hit.z) < CONFIG.hover.leaveRatio) return hovered;
    const [i, ratio] = data.regionAt(hit.x, hit.y, hit.z);
    hovered = ratio < CONFIG.hover.enterRatio ? i : -1;
    return hovered;
  }

  // ---------------------------------------------------------------- 渲染循环（只有一个）
  let last = performance.now(), t0 = last;
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
    last = now;
    let cursor = null;
    if (mode === "hand") {
      if (gout.zoomTarget != null) rig.setDistance(gout.zoomTarget);
      rig.driveAzimuth(gout.handPresent ? gout.azVelocity : 0, dt);
      cursor = gout.cursor;
    } else {
      rig.driveAzimuth(0, dt);
      cursor = mouse;
    }
    const idle = (now - lastInput) / 1000 > CONFIG.camera.idleBeforeAutoRotate && !drag && !(mode === "hand" && gout.handPresent);
    rig.update(dt, idle);
    const h = pick(cursor);
    planet.update((now - t0) / 1000, dt, h);
    ui.setGesture(mode, gout);
    ui.setCursor(cursor ? cursor.x * innerWidth : 0, cursor ? cursor.y * innerHeight : 0, mode === "hand" && !!cursor, gout.state);
    ui.showInfo(h >= 0 ? data.datasets[h] : null, cursor ? cursor.x * innerWidth : 0, cursor ? cursor.y * innerHeight : 0);
    gscene.render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener("pagehide", (e) => { tracker.stop(); if (!e.persisted) { planet.dispose(); gscene.dispose(); } });
  // 给自动化测试 / 调试用：只读的状态快照
  window.__galaxy = { rig, data, gesture, get hovered() { return hovered; }, get mode() { return mode; }, STATE };
}

main().catch((e) => { console.error(e); ui.fatal("出错了：" + (e && e.message ? e.message : e)); });
