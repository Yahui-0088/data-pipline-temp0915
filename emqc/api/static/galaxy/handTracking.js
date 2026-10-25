// 摄像头 + MediaPipe HandLandmarker（Tasks Vision 0.10.14，VIDEO 模式）。
// 画面只在浏览器本地推理，不上传。推理按视频帧走（同一帧不重复推理），和渲染循环分开。
import { CONFIG } from "./config.js";

export const TRACK_STATUS = {
  OFF: "off", STARTING: "starting", LOADING: "loading", RUNNING: "running",
  DENIED: "denied", NO_CAMERA: "no_camera", INSECURE: "insecure", FAILED: "failed", DISCONNECTED: "disconnected",
};

export class HandTracker {
  constructor({ onResult, onStatus }) {
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.status = TRACK_STATUS.OFF;
    this.video = null;
    this.stream = null;
    this.landmarker = null;
    this._running = false;
    this._lastVideoTime = -1;
  }

  _set(status, detail = "") {
    this.status = status;
    this.onStatus && this.onStatus(status, detail);
  }

  async start() {
    if (this._running) return;
    if (!window.isSecureContext) {
      this._set(TRACK_STATUS.INSECURE, location.protocol === "file:" ? "直接打开文件不能用摄像头，请通过 localhost 或 https 访问" : "摄像头只能在 localhost 或 https 下使用");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._set(TRACK_STATUS.FAILED, "这个浏览器不支持摄像头接口");
      return;
    }
    this._set(TRACK_STATUS.STARTING, "请求摄像头权限…");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) this._set(TRACK_STATUS.DENIED, "摄像头权限被拒绝。可以在地址栏左侧重新允许，或先用鼠标浏览");
      else if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) this._set(TRACK_STATUS.NO_CAMERA, "没有找到摄像头");
      else this._set(TRACK_STATUS.FAILED, "打不开摄像头：" + (e && e.message ? e.message : e));
      return;
    }
    this.stream.getVideoTracks().forEach((t) => t.addEventListener("ended", () => { this.stop(); this._set(TRACK_STATUS.DISCONNECTED, "摄像头断开了"); }));
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch (e) { /* 自动播放受限时由下一帧重试 */ }

    this._set(TRACK_STATUS.LOADING, "加载手部识别模型…");
    try {
      const vision = await import(CONFIG.cdn.visionBundle);
      const fileset = await vision.FilesetResolver.forVisionTasks(CONFIG.cdn.visionWasm);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: CONFIG.cdn.handModel, delegate }, runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      try { this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("GPU")); }
      catch (e) { this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("CPU")); }
    } catch (e) {
      this.stop();
      this._set(TRACK_STATUS.FAILED, "手部识别模型加载失败（需要能访问 cdn.jsdelivr.net 和 storage.googleapis.com）");
      return;
    }
    this._running = true;
    this._set(TRACK_STATUS.RUNNING, "");
    this._loop();
  }

  _loop() {
    if (!this._running) return;
    const v = this.video;
    const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this._loop()) : requestAnimationFrame(() => this._loop()));
    if (v.readyState >= 2 && v.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = v.currentTime;
      try {
        const now = performance.now();
        const res = this.landmarker.detectForVideo(v, now);
        this.onResult && this.onResult(res, now, v.videoWidth / Math.max(1, v.videoHeight));
      } catch (e) { /* 单帧失败忽略，下一帧继续 */ }
    }
    next();
  }

  stop() {
    this._running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) { this.video.srcObject = null; this.video = null; }
    if (this.landmarker) { try { this.landmarker.close(); } catch (e) {} this.landmarker = null; }
    if (this.status === TRACK_STATUS.RUNNING) this._set(TRACK_STATUS.OFF, "");
  }
}
