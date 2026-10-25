// 界面：统计、数据集信息卡。只改 DOM，不碰 three。
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");

export class UI {
  constructor() {
    this.info = $("gx-info");
    this._infoId = null;
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
    if (overflow) $("gx-overflow").textContent = `另有 ${overflow} 个数据集未画在细胞上`;
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
}
