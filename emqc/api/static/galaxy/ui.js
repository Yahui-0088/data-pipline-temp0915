// 界面上的小面板：统计、跟踪状态、手势状态、数据集信息卡、光标。只改 DOM，不碰 three。
import { TRACK_STATUS } from "./handTracking.js";
import { STATE } from "./gestureController.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");

const TRACK_TEXT = {
  [TRACK_STATUS.OFF]: ["off", "手势未开启 · 鼠标模式"], [TRACK_STATUS.STARTING]: ["wait", "请求摄像头…"], [TRACK_STATUS.LOADING]: ["wait", "加载手部模型…"],
  [TRACK_STATUS.RUNNING]: ["on", "摄像头已开启"], [TRACK_STATUS.DENIED]: ["err", "摄像头权限被拒绝"], [TRACK_STATUS.NO_CAMERA]: ["err", "没有摄像头"],
  [TRACK_STATUS.INSECURE]: ["err", "需要 localhost / https"], [TRACK_STATUS.FAILED]: ["err", "手部识别不可用"], [TRACK_STATUS.DISCONNECTED]: ["err", "摄像头断开"],
};
const GESTURE_TEXT = {
  [STATE.IDLE]: "手在画面里 · 待命", [STATE.ROTATING]: "旋转中 · 镜头绕行", [STATE.ZOOMING_OUT]: "握拳远离 · 拉远",
  [STATE.ZOOMING_IN]: "张开靠近 · 拉近", [STATE.TRACKING_LOST]: "没看到手",
};

export class UI {
  constructor() {
    this.info = $("gx-info");
    this.cursor = $("gx-cursor");
    this._infoId = null;
  }

  setSummary(sum, isMock, overflow) {
    $("gx-processed").textContent = sum.processed;
    $("gx-unprocessed").textContent = sum.unprocessed;
    $("gx-completion").textContent = pct(sum.completion);
    $("gx-mock").hidden = !isMock;
    $("gx-empty").hidden = sum.total > 0;
    if (overflow) $("gx-overflow").textContent = `另有 ${overflow} 个数据集未画在星球上`;
  }

  setTracking(status, detail) {
    const [cls, text] = TRACK_TEXT[status] || ["off", status];
    const el = $("gx-track");
    el.className = "gx-dot " + cls;
    $("gx-track-text").textContent = text;
    $("gx-track-detail").textContent = detail || "";
    $("gx-toggle").textContent = status === TRACK_STATUS.RUNNING || status === TRACK_STATUS.LOADING || status === TRACK_STATUS.STARTING ? "关闭手势 · 自动模式" : "开启手势控制";
    $("gx-debug-wrap").hidden = status !== TRACK_STATUS.RUNNING;
  }

  setGesture(mode, out) {
    const el = $("gx-gesture");
    if (mode !== "hand") { el.textContent = "鼠标：拖动旋转 · 滚轮缩放"; el.dataset.state = "mouse"; return; }
    el.textContent = GESTURE_TEXT[out.state] || out.state;
    el.dataset.state = out.state;
  }

  setCursor(x, y, visible, state) {
    const c = this.cursor;
    c.hidden = !visible;
    if (!visible) return;
    c.style.transform = `translate(${x}px, ${y}px)`;
    c.dataset.state = state || "";
  }

  showInfo(ds, x, y) {
    const box = this.info;
    if (!ds) { box.hidden = true; this._infoId = null; return; }
    if (this._infoId !== ds.id) {
      this._infoId = ds.id;
      const done = ds.status === "processed";
      box.innerHTML = `<div class="gx-info-h"><span class="gx-badge ${done ? "ok" : "todo"}">${done ? "已处理" : "未处理"}</span><b>${esc(ds.name)}</b></div>
        <div class="gx-info-grid">
          <span>项目</span><b>${esc(ds.project || "–")}</b>
          <span>切片</span><b>${ds.nSections == null ? "–" : ds.nSections.toLocaleString()}</b>
          ${done ? `<span>等级</span><b>${esc(ds.grade || "–")}</b><span>可用比例</span><b>${pct(ds.retention)}</b>` : ""}
          <span>最近检查</span><b>${ds.lastRun ? esc(ds.lastRun.replace("T", " ")) : "–"}</b>
        </div><p>${esc(ds.description)}</p>`;
    }
    box.hidden = false;
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = x + 24 + w > innerWidth - 12 ? x - 24 - w : x + 24;
    const top = Math.min(innerHeight - h - 12, Math.max(12, y - h / 2));
    box.style.transform = `translate(${Math.max(12, left)}px, ${top}px)`;
  }

  hideStart() { $("gx-start").hidden = true; }

  fatal(msg) {
    $("gx-start").hidden = true;
    const f = $("gx-fatal");
    f.hidden = false;
    f.querySelector("p").textContent = msg;
  }
}
