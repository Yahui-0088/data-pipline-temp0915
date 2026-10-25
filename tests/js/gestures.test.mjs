// 手势状态机的自动化测试：用合成的 MediaPipe 21 点手部关键点驱动 GestureController，
// 不需要摄像头。运行：node --experimental-default-type=module tests/js/gestures.test.mjs
import assert from "node:assert/strict";
import { GestureController, STATE, POSE } from "../../emqc/api/static/galaxy/gestureController.js";
import { CONFIG } from "../../emqc/api/static/galaxy/config.js";
import { DatasetManager, latLonToVec } from "../../emqc/api/static/galaxy/datasetManager.js";

// 手的局部坐标：手腕在原点，y 指向手指；[MCP, PIP, DIP, TIP]
const OPEN = {
  thumb: [[-0.35, 0.25], [-0.6, 0.45], [-0.8, 0.62], [-0.98, 0.78]],
  index: [[-0.3, 1.0], [-0.34, 1.35], [-0.36, 1.62], [-0.38, 1.9]],
  middle: [[0, 1.05], [0, 1.45], [0, 1.75], [0, 2.02]],
  ring: [[0.25, 1.0], [0.28, 1.38], [0.3, 1.65], [0.31, 1.88]],
  pinky: [[0.48, 0.9], [0.53, 1.18], [0.57, 1.4], [0.6, 1.6]],
};
const FIST = {
  thumb: [[-0.35, 0.25], [-0.45, 0.45], [-0.35, 0.62], [-0.18, 0.7]],
  index: [[-0.3, 1.0], [-0.32, 1.2], [-0.28, 0.95], [-0.25, 0.8]],
  middle: [[0, 1.05], [0, 1.25], [0.02, 1.0], [0.02, 0.82]],
  ring: [[0.25, 1.0], [0.27, 1.18], [0.27, 0.95], [0.25, 0.8]],
  pinky: [[0.48, 0.9], [0.5, 1.05], [0.48, 0.88], [0.45, 0.75]],
};
const NEUTRAL = { ...OPEN, ring: FIST.ring, pinky: FIST.pinky };

function hand(shape, { cx = 0.5, cy = 0.6, scale = 0.12, theta = 0 } = {}) {
  // theta = 手腕→手指方向相对「竖直向上」的转角（画面坐标，弧度）
  const pts = [[0, 0]];
  for (const f of ["thumb", "index", "middle", "ring", "pinky"]) pts.push(...shape[f]);
  const c = Math.cos(theta), s = Math.sin(theta);
  return pts.map(([x, y]) => {
    const rx = x * c - y * s, ry = x * s + y * c;
    // 画面 y 向下；镜像由控制器做，这里给原始（未镜像）坐标
    return { x: 1 - (cx + rx * scale), y: cy - ry * scale, z: 0 };
  });
}
const res = (lm) => ({ landmarks: lm ? [lm] : [], handedness: lm ? [[{ categoryName: "Right", score: 0.95 }]] : [] });

const g = new GestureController();
let t = 0, dist = CONFIG.camera.initialDistance;
const step = (lm, ms = 33) => { t += ms; const o = g.update(res(lm), t, 1, dist); if (o.zoomTarget != null) dist = o.zoomTarget; return { ...o }; };

// 1. 张开手掌但不动：认出 OPEN，不缩放
for (let i = 0; i < 20; i++) step(hand(OPEN));
let o = step(hand(OPEN));
assert.equal(o.pose, POSE.OPEN, "open palm recognised");
assert.equal(o.state, STATE.IDLE, "a still open palm does not zoom");
assert.equal(o.zoomTarget, null);
assert.ok(o.cursor && Math.abs(o.cursor.x - 0.5) < 0.1, "cursor follows the palm (mirrored)");

// 2. 张开 + 靠近（掌宽变大）：拉近，fast→slow，不低于最小距离
const d0 = dist, inSteps = [];
for (let i = 0; i < 40; i++) { o = step(hand(OPEN, { scale: 0.12 * Math.exp(0.02 * (i + 1)) })); inSteps.push(dist); }
assert.equal(g.state, STATE.ZOOMING_IN, "open palm moving closer zooms in");
assert.ok(dist < d0 - 0.5, `camera moved closer (${d0.toFixed(2)} -> ${dist.toFixed(2)})`);
assert.ok(Math.min(...inSteps) >= CONFIG.camera.minDistance - 1e-9, "never below min distance");
const firstIn = inSteps[8] - inSteps[12], lateIn = inSteps[30] - inSteps[34];
assert.ok(firstIn > lateIn, `zoom-in decelerates (early step ${firstIn.toFixed(3)} > late ${lateIn.toFixed(3)})`);
for (let i = 0; i < 40; i++) step(hand(OPEN, { scale: 0.12 * Math.exp(0.8 + 0.01 * i) }));     // 继续往前推
assert.ok(dist >= CONFIG.camera.minDistance, "hard minimum holds however far the hand moves");

// 3. 握拳但不动：认出 FIST，退出拉近，不缩放
const big = 0.12 * Math.exp(0.8 + 0.01 * 39);   // 和上一步最后的位置一样：换成拳头时手不动
for (let i = 0; i < 15; i++) o = step(hand(FIST, { scale: big }));
assert.equal(o.pose, POSE.FIST, "fist recognised");
assert.equal(o.state, STATE.IDLE, "a still fist does not zoom");
assert.equal(o.zoomTarget, null);

// 4. 握拳 + 远离（掌宽变小）：拉远，slow→fast，不超过最大距离
const outSteps = [], d1 = dist;
for (let i = 0; i < 30; i++) { o = step(hand(FIST, { scale: big * Math.exp(-0.02 * (i + 1)) })); outSteps.push(dist); }
assert.equal(g.state, STATE.ZOOMING_OUT, "fist moving away zooms out");
assert.ok(dist > d1 + 0.5, "camera moved away");
const early = outSteps[6] - outSteps[3], late = outSteps[28] - outSteps[25];
assert.ok(late > early, `zoom-out accelerates (early ${early.toFixed(3)} < late ${late.toFixed(3)})`);
for (let i = 0; i < 40; i++) step(hand(FIST, { scale: big * Math.exp(-0.6 - 0.05 * i) }));
assert.ok(dist <= CONFIG.camera.maxDistance + 1e-9, "never beyond max distance");
// 拳头回到原处（手靠近）不会反向拉近
const dHold = dist;
for (let i = 0; i < 20; i++) step(hand(FIST, { scale: big }));
assert.ok(dist >= dHold - 1e-9, "moving the fist back does not zoom in");

// 5. 半握的手旋转，跨过 ±π 也不跳
for (let i = 0; i < 10; i++) step(hand(NEUTRAL, { theta: 2.9 }));
const vels = [];
for (let i = 0; i < 40; i++) { o = step(hand(NEUTRAL, { theta: 2.9 + 0.05 * (i + 1) })); if (i > 8) vels.push(o.azVelocity); }   // 1.5 rad/s，越过 π
assert.equal(g.state, STATE.ROTATING, "turning the hand rotates");
assert.ok(vels.every((v) => Math.sign(v) === Math.sign(vels[0]) && Math.abs(v) <= CONFIG.gestures.maxAngularVelocity * 2), "velocity keeps one sign across the ±π wrap, no spike");
const rev = [];
for (let i = 0; i < 30; i++) { o = step(hand(NEUTRAL, { theta: 4.9 - 0.05 * (i + 1) })); if (i > 10) rev.push(o.azVelocity); }
assert.ok(Math.sign(rev[rev.length - 1]) === -Math.sign(vels[0]), "turning the other way reverses the orbit");
for (let i = 0; i < 20; i++) o = step(hand(NEUTRAL, { theta: 3.4 }));
assert.equal(o.azVelocity, 0, "a still hand stops driving rotation");

// 6. 手离开画面：先保持，超过 lostMs 后 TRACKING_LOST，不产生缩放 / 旋转
o = step(null, 100);
assert.notEqual(o.state, STATE.TRACKING_LOST, "short dropouts are tolerated");
o = step(null, CONFIG.gestures.lostMs + 50);
assert.equal(o.state, STATE.TRACKING_LOST);
assert.equal(o.azVelocity, 0); assert.equal(o.zoomTarget, null); assert.equal(o.cursor, null);
// 回来以后不跳：第一帧速度为 0
o = step(hand(NEUTRAL, { theta: -1.0 }));
assert.equal(o.azVelocity, 0, "no spike on re-acquiring the hand");

// 7. 低置信度的手不用
o = g.update({ landmarks: [hand(OPEN)], handedness: [[{ categoryName: "Left", score: 0.2 }]] }, t += 33, 1, dist);
assert.equal(o.handPresent, false, "low-score hands ignored");

// 8. 数据集区域：同一个 id 永远落在同一个位置；命中检测和区域一致
const dm = new DatasetManager();
const rows = [{ dataset_id: "a" }, { dataset_id: "b", last_run: "2026-10-01T00:00", n_sections: 100 }];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ datasets: rows }) });
await dm.load();
const posA = dm.datasets.find((d) => d.id === "a").particleRegion;
rows.push({ dataset_id: "c" });
await dm.load();
assert.deepEqual(dm.datasets.find((d) => d.id === "a").particleRegion, posA, "region is stable when other datasets are added");
const b = dm.datasets.find((d) => d.id === "b");
assert.equal(b.status, "processed"); assert.equal(dm.datasets.find((d) => d.id === "a").status, "unprocessed");
const [hit] = dm.regionAt(...b.center);
assert.equal(dm.datasets[hit].id, "b", "the centre of a region hits that dataset");
assert.equal(dm.summary().processed, 1); assert.equal(dm.summary().unprocessed, 2);
globalThis.fetch = async () => ({ ok: false, status: 403 });
await dm.load();
assert.ok(dm.isMock && dm.datasets.length > 0, "falls back to clearly-marked mock data when the API is unavailable");
void latLonToVec;

console.log("gesture + dataset tests: all passed");
