// 数据集 → 星球表面上一块固定的区域。
// 数据来自汇报接口（已按账号的项目范围过滤）；接口不可用时用示例数据，并在界面上标明。
import { CONFIG } from "./config.js";

const DEG = Math.PI / 180;

// FNV-1a：同一个 dataset_id 永远得到同一个数 → 区域位置稳定，不随加载顺序或数据集增减变化
function hash32(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const unit = (h) => (h % 1000003) / 1000003;

export function latLonToVec(latDeg, lonDeg, out = [0, 0, 0]) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  out[0] = Math.cos(la) * Math.cos(lo); out[1] = Math.sin(la); out[2] = Math.cos(la) * Math.sin(lo);
  return out;
}

const MOCK = [
  ["h01-demo-v1", "h01", 100, 0.79, "B", true], ["h01-demo-v1-y0000_x0000", "h01", 100, 0.79, "C", true],
  ["h01-demo-v1-y0000_x0512", "h01", 100, 0.62, "C", true], ["h01-demo-v1-y0512_x0000", "h01", 100, 0.58, "C", true],
  ["h01-demo-v1-y0512_x0512", "h01", 100, null, null, false], ["mouse-v1-batch-03", "mouse", 480, null, null, false],
  ["mouse-v1-batch-02", "mouse", 480, 0.86, "A", true], ["calib-crops", "calib", 260, null, null, false],
].map(([id, project, n, ret, grade, done]) => ({ dataset_id: id, project, n_sections: n, retention: ret, grade, last_run: done ? "2026-10-23T14:24" : null, n_blocks: Math.ceil(n / 64) }));

function toDataset(d, maxSections) {
  const processed = !!d.last_run;
  const h = hash32(d.dataset_id);
  const h2 = hash32(d.dataset_id, 0x9e3779b9);
  // 球面均匀分布：纬度用 asin，避免都挤到两极
  const lat = Math.asin(2 * unit(h) - 1) / DEG * 0.88;
  const lon = unit(h2) * 360 - 180;
  const n = d.n_sections || 0;
  const { regionBaseRadiusDeg: r0, regionMaxRadiusDeg: r1 } = CONFIG.planet;
  const angularRadius = r0 + (r1 - r0) * Math.sqrt(maxSections ? Math.min(1, n / maxSections) : 0);
  const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");
  const description = processed
    ? `已完成质量检查：等级 ${d.grade || "–"}，${pct(d.retention)} 的切片可用于训练。`
    : "已登记，尚未做质量检查。";
  return {
    id: d.dataset_id, name: d.dataset_id, project: d.project || "", status: processed ? "processed" : "unprocessed",
    grade: d.grade || null, retention: d.retention, nSections: d.n_sections, nBlocks: d.n_blocks, lastRun: d.last_run,
    description, particleRegion: { latitude: lat, longitude: lon, angularRadius },
    center: latLonToVec(lat, lon), cosRadius: Math.cos(angularRadius * DEG), radiusRad: angularRadius * DEG,
  };
}

export class DatasetManager {
  constructor() { this.datasets = []; this.isMock = false; this.error = null; }

  async load() {
    let rows;
    try {
      const r = await fetch(CONFIG.data.endpoint, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`汇报接口返回 ${r.status}`);
      rows = (await r.json()).datasets || [];
      this.isMock = false;
    } catch (e) {
      this.error = e.message;
      rows = MOCK;
      this.isMock = true;
    }
    rows = rows.slice().sort((a, b) => (a.dataset_id < b.dataset_id ? -1 : 1));
    const maxSections = Math.max(1, ...rows.map((d) => d.n_sections || 0));
    this.datasets = rows.slice(0, CONFIG.data.maxRegions).map((d) => toDataset(d, maxSections));
    this.overflow = Math.max(0, rows.length - CONFIG.data.maxRegions);
    return this.datasets;
  }

  summary() {
    const processed = this.datasets.filter((d) => d.status === "processed").length;
    const total = this.datasets.length + (this.overflow || 0);
    return { processed, unprocessed: total - processed, total, completion: total ? processed / total : null };
  }

  /** 单位向量 p 落在哪个区域里：返回 [index, 角距离/区域半径]；不在任何区域里返回 [-1, Infinity]。 */
  regionAt(px, py, pz) {
    let best = -1, bestRatio = Infinity;
    for (let i = 0; i < this.datasets.length; i++) {
      const c = this.datasets[i].center;
      const dot = Math.max(-1, Math.min(1, c[0] * px + c[1] * py + c[2] * pz));
      const ratio = Math.acos(dot) / this.datasets[i].radiusRad;
      if (ratio < bestRatio) { bestRatio = ratio; best = i; }
    }
    return [best, bestRatio];
  }

  ratioTo(i, px, py, pz) {
    const c = this.datasets[i].center;
    return Math.acos(Math.max(-1, Math.min(1, c[0] * px + c[1] * py + c[2] * pz))) / this.datasets[i].radiusRad;
  }
}
