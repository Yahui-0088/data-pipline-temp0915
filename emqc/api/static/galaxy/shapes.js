// 图案：细胞。每个粒子有一个固定的 (u, v) 参数，图案 = 把 (u, v) 映射到三维空间的连续函数。
// 数据集区域定义在细胞膜的 (u, v) 上，所以一个数据集永远是膜上同一片粒子。
// 保留「多图案 + 逐粒子变形」的结构（SHAPES 只有一个），以后要加图案只需在 FN 里加一个函数。
// 纯函数，不依赖 three，可以在 Node 里测试。

export const SHAPES = ["cell"];
export const SHAPE_LABEL = { cell: "细胞" };

// 粒子的种类（着色器按种类上色 / 画圆点或方块）
export const KIND = { MEMBRANE: 0, INNER: 1, NUCLEUS: 2, PIXEL: 3 };
// 参数平面 v 的分段：细胞膜 / 内膜褶皱 / 细胞核 / 其余 = 散开的像素
export const SEG = { membrane: 0.62, inner: 0.8, nucleus: 0.93 };
// 细胞向这一侧「数字化溶解」成方块像素
export const DISSOLVE = (() => { const d = [1, 0.18, 0.3], l = Math.hypot(...d); return d.map((x) => x / l); })();

const TAU = Math.PI * 2;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (u, v, k) => { const x = Math.sin(u * 127.1 + v * 311.7 + k * 74.7) * 43758.5453; return x - Math.floor(x); };


/** 膜上 (u, t) → 单位方向（经度 u、t 从北极到南极，面积均匀） */
export function membraneDir(u, t, out = [0, 0, 0]) {
  const lon = TAU * u, cz = 1 - 2 * t, s = Math.sqrt(Math.max(0, 1 - cz * cz));
  out[0] = s * Math.cos(lon); out[1] = cz; out[2] = s * Math.sin(lon);
  return out;
}
// 细胞膜的起伏：几个低频正弦叠加，像有机的、软的气泡
const lumpy = (x, y, z) => 1 + 0.085 * Math.sin(3.1 * x + 1.3) * Math.sin(2.3 * y + 0.4) + 0.06 * Math.sin(4.2 * z + 2.1 * x) + 0.045 * Math.sin(5.3 * y + 3.1 * z + 0.7) + 0.02 * Math.sin(9.1 * x - 7.3 * z);

// 每个函数：f(u, v, out) → 写入位置 out[0..2]、种类 out[3]，返回「强调」值 0–1（轮廓上更亮）
const FN = {
  cell(u, v, o) {
    const D = DISSOLVE, d = [0, 0, 0];
    if (v < SEG.membrane) {                                  // 细胞膜：起伏的半透明外膜；朝 D 的一侧逐渐散成像素方块
      membraneDir(u, v / SEG.membrane, d);
      const r = 1.02 * lumpy(d[0], d[1], d[2]);
      o[0] = d[0] * r; o[1] = d[1] * r * 0.93; o[2] = d[2] * r; o[3] = KIND.MEMBRANE;
      const side = d[0] * D[0] + d[1] * D[1] + d[2] * D[2];
      const prob = sstep(0.35, 0.98, side) * 0.6;
      if (hash(u, v, 1) < prob) {
        const out = 0.06 + 0.8 * Math.pow(hash(u, v, 2), 1.6) * (0.4 + prob);
        o[0] += D[0] * out + (hash(u, v, 3) - 0.5) * 0.12; o[1] += D[1] * out + (hash(u, v, 4) - 0.5) * 0.12; o[2] += D[2] * out + (hash(u, v, 5) - 0.5) * 0.12;
        o[3] = KIND.PIXEL;
      }
      return 0.25;
    }
    if (v < SEG.inner) {                                     // 内膜褶皱：一层更小、起伏更大的膜，像花瓣一样折叠
      membraneDir(u, (v - SEG.membrane) / (SEG.inner - SEG.membrane), d);
      const lon = TAU * u;
      const r = 0.68 * (1 + 0.2 * Math.sin(3 * lon + 2.2 * d[1]) * Math.cos(2.4 * d[1] + lon) + 0.06 * Math.sin(5 * lon));
      o[0] = d[0] * r - 0.04; o[1] = d[1] * r * 0.9; o[2] = d[2] * r; o[3] = KIND.INNER;
      return 0;
    }
    if (v < SEG.nucleus) {                                   // 细胞核：偏心的深紫色小球
      membraneDir(u, (v - SEG.inner) / (SEG.nucleus - SEG.inner), d);
      const r = 0.3 * (1 + 0.025 * Math.sin(6 * d[0] + 4 * d[2]));
      o[0] = d[0] * r - 0.05; o[1] = d[1] * r + 0.05; o[2] = d[2] * r + 0.1; o[3] = KIND.NUCLEUS;
      return 0.4;
    }
    // 散在溶解一侧外面的像素方块
    const h1 = hash(u, v, 6), h2 = hash(u, v, 7), h3 = hash(u, v, 8);
    const out = 1.0 + Math.pow(h1, 0.8) * 0.95;
    const spread = 0.25 + 0.75 * h1;
    o[0] = D[0] * out + (h2 - 0.5) * 0.25; o[1] = D[1] * out + (h3 - 0.5) * 1.5 * spread; o[2] = D[2] * out + (hash(u, v, 9) - 0.5) * 1.3 * spread;
    o[3] = KIND.PIXEL;
    return 0;
  },
};

// R2 低差异序列：比纯随机均匀得多（没有一团团的空洞），又不像规则网格那样看出纹路
const G = 1.32471795724474602596;
const A1 = 1 / G, A2 = 1 / (G * G);

/** 粒子的固定属性：参数坐标 uv、随机种子、大小、发散方向。只生成一次。 */
export function makeParticles(n, rand) {
  const uv = new Float32Array(n * 2), seed = new Float32Array(n), size = new Float32Array(n), dir = new Float32Array(n * 3), jit = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = (0.5 + A1 * (i + 1) + (rand() - 0.5) * 0.4 / Math.sqrt(n)) % 1;
    uv[i * 2 + 1] = (0.5 + A2 * (i + 1) + (rand() - 0.5) * 0.4 / Math.sqrt(n)) % 1;
    seed[i] = rand();
    const big = Math.pow(rand(), 7);               // 少数特别亮的光点
    size[i] = 0.9 + rand() * 1.1 + big * 3.2;
    const zz = rand() * 2 - 1, th = rand() * TAU, s = Math.sqrt(1 - zz * zz);
    dir[i * 3] = s * Math.cos(th); dir[i * 3 + 1] = zz; dir[i * 3 + 2] = s * Math.sin(th);
    jit[i] = (rand() - 0.5);                       // 沿法线的厚度抖动：表面有一点体积感
  }
  return { n, uv, seed, size, dir, jit };
}

/** 一个图案的目标位置、法线（光照用）、强调值、粒子种类。 */
export function buildShape(name, P) {
  const f = FN[name];
  if (!f) throw new Error("unknown shape " + name);
  const { n, uv, jit } = P;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), acc = new Float32Array(n), kind = new Float32Array(n);
  const p = [0, 0, 0, 0], pu = [0, 0, 0, 0], pv = [0, 0, 0, 0], e = 1e-3;
  for (let i = 0; i < n; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    acc[i] = f(u, v, p);
    kind[i] = p[3];
    // 数值法线：沿 u、v 各走一小步；靠近上界时往回走，避免跨过图案的分段边界
    const su = u + e < 1 ? e : -e, sv = v + e < 1 ? e : -e;
    f(u + su, v, pu); f(u, v + sv, pv);
    const ax = (pu[0] - p[0]) * su, ay = (pu[1] - p[1]) * su, az = (pu[2] - p[2]) * su;
    const bx = (pv[0] - p[0]) * sv, by = (pv[1] - p[1]) * sv, bz = (pv[2] - p[2]) * sv;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const t = jit[i] * 0.018;
    pos[i * 3] = p[0] + nx * t; pos[i * 3 + 1] = p[1] + ny * t; pos[i * 3 + 2] = p[2] + nz * t;
    nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
  }
  return { pos, nor, acc, kind };
}

/** 变形进度：每个粒子按自己的种子稍微错开，然后 smoothstep。着色器里是同一个公式。 */
export function morphK(m, seed) {
  const k = Math.min(1, Math.max(0, m * 1.35 - seed * 0.35));
  return k * k * (3 - 2 * k);
}
