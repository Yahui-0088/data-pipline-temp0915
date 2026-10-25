// 界面：统计、控制面板（图案 / 颜色 / 滑杆 / 按钮）、数据集信息卡。只改 DOM，不碰 three。
import { CONFIG } from "./config.js";
import { SHAPES, SHAPE_LABEL } from "./shapes.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");

// 只记住这台浏览器上的偏好（图案、颜色、滑杆）；读写失败就用默认值
const STORE = "emqc.galaxy.prefs";
export function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch (_) { p = {}; }
  const d = CONFIG.defaults;
  return {
    shape: SHAPES.includes(p.shape) ? p.shape : d.shape,
    theme: p.theme === "custom" || CONFIG.themes[p.theme] ? p.theme : d.theme,
    custom: /^#[0-9a-f]{6}$/i.test(p.custom || "") ? p.custom : "#b8a6ff",
    size: Number.isFinite(p.size) ? p.size : d.size,
    brightness: Number.isFinite(p.brightness) ? p.brightness : d.brightness,
    glow: Number.isFinite(p.glow) ? p.glow : d.glow,
    speed: Number.isFinite(p.speed) ? p.speed : d.speed,
    auto: p.auto !== false,
  };
}
export function savePrefs(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (_) { /* 隐私模式等：不记 */ } }

// 自定义颜色 → 亮部（往白色提）+ 暗部（原色）
export function themeColors(p) {
  if (p.theme !== "custom") return CONFIG.themes[p.theme];
  const n = parseInt(p.custom.slice(1), 16), mix = (c) => Math.round(c + (255 - c) * 0.8);
  const a = "#" + [n >> 16, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, "0")).join("");
  return { a, b: p.custom };
}

export class UI {
  constructor(prefs, handlers) {
    this.prefs = prefs;
    this.h = handlers;
    this.info = $("gx-info");
    this._infoId = null;
    this._buildShapes();
    this._buildThemes();
    this._bindSliders();
    this._bindButtons();
  }

  _radio(group, value) {
    group.querySelectorAll("[role=radio]").forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
  }

  _arrowKeys(group, pick) {
    group.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const items = [...group.querySelectorAll("[role=radio]")], i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = items[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length];
      next.focus(); pick(next.dataset.value);
    });
  }

  _buildShapes() {
    const g = $("gx-shapes");
    g.innerHTML = SHAPES.map((s) => `<button type="button" role="radio" data-value="${s}">${SHAPE_LABEL[s]}</button>`).join("");
    const pick = (s) => { this.prefs.shape = s; this._radio(g, s); savePrefs(this.prefs); this.h.shape(s); };
    g.addEventListener("click", (e) => { const b = e.target.closest("[role=radio]"); if (b) pick(b.dataset.value); });
    this._arrowKeys(g, pick);
    this._radio(g, this.prefs.shape);
  }

  _buildThemes() {
    const g = $("gx-themes"), picker = g.querySelector(".gx-picker"), input = $("gx-color");
    for (const [k, t] of Object.entries(CONFIG.themes)) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.dataset.value = k;
      b.title = t.label; b.setAttribute("aria-label", t.label);
      b.style.setProperty("--a", t.a); b.style.setProperty("--b", t.b);
      g.insertBefore(b, picker);
    }
    picker.dataset.value = "custom";
    input.value = this.prefs.custom;
    const apply = () => { this._radio(g, this.prefs.theme); picker.classList.toggle("on", this.prefs.theme === "custom"); savePrefs(this.prefs); this.h.color(themeColors(this.prefs)); };
    const pick = (k) => { this.prefs.theme = k; apply(); };
    g.addEventListener("click", (e) => { const b = e.target.closest("button[role=radio]"); if (b) pick(b.dataset.value); });
    input.addEventListener("input", () => { this.prefs.custom = input.value; this.prefs.theme = "custom"; apply(); });
    this._arrowKeys(g, pick);
    apply();
  }

  _bindSliders() {
    for (const [id, key] of [["gx-size", "size"], ["gx-bright", "brightness"], ["gx-glow", "glow"], ["gx-speed", "speed"]]) {
      const el = $(id);
      el.value = this.prefs[key];
      el.addEventListener("input", () => { this.prefs[key] = +el.value; savePrefs(this.prefs); this.h.tune(key, +el.value); });
      this.h.tune(key, +el.value);
    }
    if (matchMedia("(max-width: 760px)").matches) $("gx-tune").open = false;     // 手机上默认收起
  }

  _bindButtons() {
    const auto = $("gx-auto");
    const setAuto = (on) => { this.prefs.auto = on; auto.setAttribute("aria-pressed", on ? "true" : "false"); savePrefs(this.prefs); this.h.auto(on); };
    auto.addEventListener("click", () => setAuto(!this.prefs.auto));
    setAuto(this.prefs.auto);
    $("gx-reset").addEventListener("click", () => this.h.reset());
    const fs = $("gx-fs");
    if (!document.fullscreenEnabled) fs.hidden = true;
    fs.addEventListener("click", () => this.toggleFullscreen());
    document.addEventListener("fullscreenchange", () => { fs.textContent = document.fullscreenElement ? "退出全屏" : "全屏"; });
  }

  toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }

  setSummary(sum, isMock, overflow) {
    $("gx-processed").textContent = sum.processed;
    $("gx-unprocessed").textContent = sum.unprocessed;
    $("gx-completion").textContent = pct(sum.completion);
    $("gx-mock").hidden = !isMock;
    $("gx-empty").hidden = sum.total > 0;
    if (overflow) $("gx-overflow").textContent = `另有 ${overflow} 个数据集未画在雕塑上`;
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

  fatal(msg) {
    const f = $("gx-fatal");
    f.hidden = false;
    f.querySelector("p").textContent = msg;
  }
}
