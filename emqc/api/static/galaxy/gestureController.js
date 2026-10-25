// 手势识别 + 状态机。只依赖 config.js，不碰 three，可以在 Node 里用合成关键点单独测试。
//
// 状态：IDLE / ROTATING / ZOOMING_OUT / ZOOMING_IN / TRACKING_LOST
//   旋转：手腕→中指根向量在画面里的角度变化（跨 ±π 正确展开）→ 镜头绕行角速度
//   握拳 + 手远离摄像头（掌宽变小）→ 拉远：ease-in，越往后越快
//   五指张开 + 手靠近摄像头（掌宽变大）→ 拉近：ease-out，越接近越慢
//   只握拳 / 只张开不动 → 不缩放；缩放中不旋转，互不冲突
import { CONFIG } from "./config.js";

export const STATE = { IDLE: "IDLE", ROTATING: "ROTATING", ZOOMING_OUT: "ZOOMING_OUT", ZOOMING_IN: "ZOOMING_IN", TRACKING_LOST: "TRACKING_LOST" };
export const POSE = { NONE: "none", OPEN: "open", FIST: "fist", NEUTRAL: "neutral" };

const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// MediaPipe 手部 21 点：0 手腕；指根 5/9/13/17；指尖 8/12/16/20；拇指尖 4
const FINGERS = [[8, 5], [12, 9], [16, 13], [20, 17]];

export class GestureController {
  constructor() { this.reset(); }

  reset() {
    this.state = STATE.TRACKING_LOST;
    this.pose = POSE.NONE;
    this._raw = POSE.NONE; this._rawSince = 0;
    this._pts = null;
    this._lastT = null; this._lastSeen = -1e9;
    this._logS = null; this._dLog = 0;
    this._theta = null; this._dTheta = 0;
    this._rotQuietSince = 0;
    this._poseLog = null;
    this._zoom = null;   // { log0, d0, pMax }
    this.out = { state: this.state, pose: this.pose, handPresent: false, cursor: null, azVelocity: 0, zoomTarget: null, handedness: null };
  }

  /** res: HandLandmarkerResult；t: 毫秒；aspect: 视频宽/高；currentDistance: 镜头当前目标距离 */
  update(res, t, aspect, currentDistance) {
    const g = CONFIG.gestures, c = CONFIG.camera;
    const dt = this._lastT == null ? 1 / 30 : Math.min(0.2, Math.max(1e-3, (t - this._lastT) / 1000));
    this._lastT = t;
    const o = this.out;
    o.zoomTarget = null;

    const hand = this._pickHand(res);
    if (!hand) {
      o.handPresent = false; o.cursor = null; o.azVelocity = 0;
      if (t - this._lastSeen > g.lostMs) { this.state = STATE.TRACKING_LOST; this.pose = POSE.NONE; this._zoom = null; this._pts = null; this._logS = null; this._theta = null; }
      o.state = this.state; o.pose = this.pose;
      return o;
    }
    const resumed = t - this._lastSeen > g.lostMs;
    this._lastSeen = t;
    o.handPresent = true; o.handedness = hand.handedness;

    // 1. 镜像 + 宽高比修正 + 指数平滑
    const a = g.smoothing;
    if (!this._pts || resumed) this._pts = hand.landmarks.map((p) => [(1 - p.x) * aspect, p.y]);
    else hand.landmarks.forEach((p, i) => { const q = this._pts[i]; q[0] += ((1 - p.x) * aspect - q[0]) * a; q[1] += (p.y - q[1]) * a; });
    const P = this._pts, d = (i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);

    // 2. 光标 = 掌心（握拳时食指尖会缩回去，掌心更稳）
    let cx = 0, cy = 0;
    for (const i of [0, 5, 9, 13, 17]) { cx += P[i][0]; cy += P[i][1]; }
    o.cursor = { x: cx / 5 / aspect, y: cy / 5 };

    // 3. 掌宽（离摄像头远近的代理）：手腕→中指根、食指根→小指根的平均，比整个包围盒稳定
    const scale = (d(0, 9) + d(5, 17)) / 2;
    const logS = Math.log(Math.max(scale, 1e-4));
    if (this._logS == null || resumed) { this._logS = logS; this._dLog = 0; }
    else {
      const prev = this._logS;
      this._logS += (logS - this._logS) * 0.5;
      this._dLog += ((this._logS - prev) / dt - this._dLog) * 0.5;
    }

    // 4. 手的朝向：手腕→中指根的角度，跨 ±π 展开
    const theta = Math.atan2(P[9][1] - P[0][1], P[9][0] - P[0][0]);
    if (this._theta == null || resumed) { this._theta = theta; this._dTheta = 0; }
    else { const dth = wrap(theta - this._theta); this._theta = theta; this._dTheta += (dth / dt - this._dTheta) * 0.4; }

    // 5. 手形：带滞回的手指伸直 / 握紧判断 + 持续 confirmMs 才确认
    const raw = this._classify(P, d, scale);
    if (raw !== this._raw) { this._raw = raw; this._rawSince = t; }
    if (raw !== this.pose && t - this._rawSince >= g.confirmMs) { this.pose = raw; this._poseLog = this._logS; }

    // 6. 状态机
    if (this.state === STATE.TRACKING_LOST) this.state = STATE.IDLE;
    if (this.state === STATE.ZOOMING_OUT && this.pose !== POSE.FIST) { this.state = STATE.IDLE; this._zoom = null; }
    if (this.state === STATE.ZOOMING_IN && this.pose !== POSE.OPEN) { this.state = STATE.IDLE; this._zoom = null; }

    if (this.state === STATE.IDLE || this.state === STATE.ROTATING) {
      if (this.pose === POSE.FIST && this._dLog < -g.motionThreshold) {
        this.state = STATE.ZOOMING_OUT;
        this._zoom = { log0: Math.max(this._poseLog ?? this._logS, this._logS), d0: currentDistance, pMax: 0 };
      } else if (this.pose === POSE.OPEN && this._dLog > g.motionThreshold) {
        this.state = STATE.ZOOMING_IN;
        this._zoom = { log0: Math.min(this._poseLog ?? this._logS, this._logS), d0: currentDistance, pMax: 0 };
      }
    }

    o.azVelocity = 0;
    if (this.state === STATE.ZOOMING_OUT) {
      const z = this._zoom;
      z.pMax = Math.max(z.pMax, z.log0 - this._logS);         // 只往远走才算；手回来不会反向拉近
      o.zoomTarget = z.d0 + (c.maxDistance - z.d0) * easeInCubic(clamp01(z.pMax / g.zoomRange));
    } else if (this.state === STATE.ZOOMING_IN) {
      const z = this._zoom;
      z.pMax = Math.max(z.pMax, this._logS - z.log0);
      o.zoomTarget = z.d0 - (z.d0 - c.minDistance) * easeOutCubic(clamp01(z.pMax / g.zoomRange));
    } else if (Math.abs(this._dTheta) > g.rotationThreshold) {
      this.state = STATE.ROTATING;
      this._rotQuietSince = t;
      o.azVelocity = g.rotationDirection * g.rotationGain * this._dTheta;
    } else if (this.state === STATE.ROTATING && t - this._rotQuietSince > 250) {
      this.state = STATE.IDLE;
    }
    o.state = this.state; o.pose = this.pose;
    return o;
  }

  _pickHand(res) {
    if (!res || !res.landmarks || !res.landmarks.length) return null;
    const hs = res.handedness || res.handednesses || [];
    let best = null, bestScore = -1;
    res.landmarks.forEach((lm, i) => {
      const cat = hs[i] && hs[i][0];
      const score = cat ? cat.score : 1;
      if (lm && lm.length === 21 && score >= CONFIG.gestures.minHandScore && score > bestScore) { best = { landmarks: lm, handedness: cat ? cat.categoryName : null }; bestScore = score; }
    });
    return best;
  }

  _classify(P, d, scale) {
    const g = CONFIG.gestures;
    const prev = this.pose;
    // 滞回：已经是张开 / 握拳时，门槛放宽一点，避免在边界上来回跳
    const ext = prev === POSE.OPEN ? g.fingerExtended - 0.12 : g.fingerExtended;
    const curl = prev === POSE.FIST ? g.fingerCurled + 0.1 : g.fingerCurled;
    let nExt = 0, nCurl = 0;
    for (const [tip, mcp] of FINGERS) {
      const ratio = d(0, tip) / Math.max(1e-5, d(0, mcp));
      if (ratio > ext) nExt++;
      else if (ratio < curl) nCurl++;
    }
    const thumbOpen = d(4, 5) / Math.max(1e-5, scale) > g.thumbExtended;
    if (nExt === 4 && thumbOpen) return POSE.OPEN;
    if (nCurl >= 3 && !(nExt >= 1)) return POSE.FIST;
    return POSE.NEUTRAL;
  }
}
