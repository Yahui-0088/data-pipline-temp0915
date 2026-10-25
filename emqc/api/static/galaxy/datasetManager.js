// 数据集 → 细胞膜上一块固定的区域（定义在粒子的参数平面上）。
// 数据来自汇报接口（已按账号的项目范围过滤）；接口不可用时用示例数据，并在界面上标明。
import { CONFIG } from "./config.js";
import { SEG, DISSOLVE, membraneDir } from "./shapes.js";


// FNV-1a：同一个 dataset_id 永远得到同一个数 → 区域位置稳定，不随加载顺序或数据集增减变化
function hash32(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const unit = (h) => (h % 1000003) / 1000003;

const MOCK = [
  ["h01-demo-v1", "h01", 100, 0.79, "B", true], ["h01-demo-v1-y0000_x0000", "h01", 100, 0.79, "C", true],
  ["h01-demo-v1-y0000_x0512", "h01", 100, 0.62, "C", true], ["h01-demo-v1-y0512_x0000", "h01", 100, 0.58, "C", true],
  ["h01-demo-v1-y0512_x0512", "h01", 100, null, null, false], ["mouse-v1-batch-03", "mouse", 480, null, null, false],
  ["mouse-v1-batch-02", "mouse", 480, 0.86, "A", true], ["calib-crops", "calib", 260, null, null, false],
].map(([id, project, n, ret, grade, done]) => ({ dataset_id: id, project, n_sections: n, retention: ret, grade, last_run: done ? "2026-10-23T14:24" : null, n_blocks: Math.ceil(n / 64) }));

// 默认视角下朝向镜头的方向（和 config.camera.initialAzimuth 对应）
const FRONT = (() => { const a = CONFIG.camera.initialAzimuth; return [Math.sin(a), 0.15, Math.cos(a)]; })();

function toDataset(d, maxSections, few) {
  const processed = !!d.last_run;
  // 区域中心放在细胞膜上：经度 u、纬度 t（避开两极）；radius = 角半径（弧度）
  // 数据集少时（≤ 12），只放在默认视角看得到、又没散成像素的那半边，打开就能看到；位置仍由 id 决定、稳定
  let u = 0, t = 0;
  for (let k = 0; k < 40; k++) {
    u = unit(hash32(d.dataset_id, 2166136261 + k * 7919));
    t = 0.2 + 0.6 * unit(hash32(d.dataset_id, 0x9e3779b9 + k * 104729));
    if (!few) break;
    const p = membraneDir(u, t);
    const front = p[0] * FRONT[0] + p[1] * FRONT[1] + p[2] * FRONT[2], side = p[0] * DISSOLVE[0] + p[1] * DISSOLVE[1] + p[2] * DISSOLVE[2];
    if (front > 0.45 && side < 0.3) break;
  }
  const v = t * SEG.membrane;
  const n = d.n_sections || 0;
  const { regionMinRadius: r0, regionMaxRadius: r1 } = CONFIG.sculpture;
  const radius = r0 + (r1 - r0) * Math.sqrt(maxSections ? Math.min(1, n / maxSections) : 0);
  const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
  const description = processed
    ? `已完成质量检查：等级 ${d.grade || "–"}，${pct(d.retention)} 的切片可用于训练。`
    : "已登记，尚未做质量检查。";
  return {
    id: d.dataset_id, name: d.dataset_id, project: d.project || "", status: processed ? "processed" : "unprocessed",
    grade: d.grade || null, retention: d.retention, nSections: d.n_sections, nBlocks: d.n_blocks, lastRun: d.last_run,
    description, particleRegion: { u, v, radius, dir: membraneDir(u, t) },
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
    this.datasets = rows.slice(0, CONFIG.data.maxRegions).map((d) => toDataset(d, maxSections, rows.length <= 12));
    this.overflow = Math.max(0, rows.length - CONFIG.data.maxRegions);
    return this.datasets;
  }

  summary() {
    const processed = this.datasets.filter((d) => d.status === "processed").length;
    const total = this.datasets.length + (this.overflow || 0);
    return { processed, unprocessed: total - processed, total, completion: total ? processed / total : null };
  }

  /** 参数平面上的一点 (u, v) 属于哪个数据集：返回 [index, 角距离/区域角半径]；不在任何区域里 → [-1, Infinity]。
   *  只有细胞膜（v < SEG.membrane）上的粒子属于数据集；重叠时归（按半径归一化后）最近的那个。 */
  regionAt(u, v) {
    if (v >= SEG.membrane) return [-1, Infinity];
    const p = membraneDir(u, v / SEG.membrane);
    let best = -1, bestRatio = Infinity;
    for (let i = 0; i < this.datasets.length; i++) {
      const r = this.datasets[i].particleRegion, c = r.dir;
      const ang = Math.acos(Math.max(-1, Math.min(1, p[0] * c[0] + p[1] * c[1] + p[2] * c[2])));
      const ratio = ang / r.radius;
      if (ratio < bestRatio) { bestRatio = ratio; best = i; }
    }
    return bestRatio <= 1 ? [best, bestRatio] : [-1, Infinity];
  }


}
