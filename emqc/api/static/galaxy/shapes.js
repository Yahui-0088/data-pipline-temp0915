// 图案：DNA 双螺旋。每个粒子有一个固定的 (u, v) 参数，图案 = 把 (u, v) 映射到三维表面的连续函数。
// 数据集区域也定义在 (u, v) 上，所以一个数据集永远是螺旋上同一段粒子。
// 保留「多图案 + 逐粒子变形」的结构（SHAPES 只有一个），以后要加图案只需在 FN 里加一个函数。
// 纯函数，不依赖 three，可以在 Node 里测试。

export const SHAPES = ["dna"];
export const SHAPE_LABEL = { dna: "DNA" };

const TAU = Math.PI * 2;

function rotX(o, a) { const c = Math.cos(a), s = Math.sin(a), y = o[1], z = o[2]; o[1] = y * c - z * s; o[2] = y * s + z * c; }
function rotZ(o, a) { const c = Math.cos(a), s = Math.sin(a), x = o[0], y = o[1]; o[0] = x * c - y * s; o[1] = x * s + y * c; }

// 每个函数：f(u, v, out) → 写入位置，返回「强调」值 0–1（轮廓上更亮）
const DNA = { height: 3.4, radius: 0.56, turns: 2.75, strand: 0.05, rung: 0.022, rungs: 34, tilt: 0.38 };
const FN = {
  // DNA 双螺旋：v < 0.31 = 第一条链，0.31–0.62 = 第二条链（相位差约 140°，有大沟和小沟），其余 = 碱基对横档。
  // 链是绕螺旋线的细管；横档是两条链之间的细杆，中间留一点缝（碱基配对处），整体斜放
  dna(u, v, o) {
    const { height: H, radius: R, turns: T, strand: rs, rung: rr, rungs: N } = DNA;
    const ang = (t) => TAU * T * t;
    const helix = (t, ph, out) => { const a = ang(t) + ph; out[0] = R * Math.cos(a); out[1] = (t - 0.5) * H; out[2] = R * Math.sin(a); return a; };
    const PH = 2.45;                                      // 两条链的相位差（弧度）
    let acc = 0;
    if (v < 0.62) {
      const second = v >= 0.31, w = (second ? v - 0.31 : v) / 0.31;
      const a = helix(u, second ? PH : 0, o);
      // 管截面：径向和「沿螺旋线垂直于切线」两个方向张成的平面里画圆
      const phi = TAU * w, rx = Math.cos(a), rz = Math.sin(a);
      const tl = Math.hypot(TAU * T * R, H), tx = -Math.sin(a) * TAU * T * R / tl, ty = H / tl, tz = Math.cos(a) * TAU * T * R / tl;
      const bx = ty * rz, by = tz * rx - tx * rz, bz = -ty * rx;     // b = t × r
      const c = Math.cos(phi) * rs, s = Math.sin(phi) * rs;
      o[0] += rx * c + bx * s; o[1] += by * s; o[2] += rz * c + bz * s;
      acc = 0.35;
    } else {
      const w = (v - 0.62) / 0.38;
      const k = Math.min(N - 1, Math.floor(u * N)), t = (k + 0.5) / N, f = u * N - k;
      const A = [0, 0, 0], B = [0, 0, 0];
      helix(t, 0, A); helix(t, PH, B);
      const g = f < 0.5 ? f * 0.94 : 0.06 + f * 0.94;      // 中间留一道小缝：两个碱基
      const phi = TAU * w;
      o[0] = A[0] + (B[0] - A[0]) * g; o[1] = A[1] + Math.cos(phi) * rr; o[2] = A[2] + (B[2] - A[2]) * g + Math.sin(phi) * rr;
      acc = 0.2;
    }
    rotZ(o, DNA.tilt); rotX(o, 0.12);
    return acc;
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

/** 一个图案的目标位置、法线（光照用）、强调值。 */
export function buildShape(name, P) {
  const f = FN[name];
  if (!f) throw new Error("unknown shape " + name);
  const { n, uv, jit } = P;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), acc = new Float32Array(n);
  const p = [0, 0, 0], pu = [0, 0, 0], pv = [0, 0, 0], e = 1e-3;
  for (let i = 0; i < n; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    acc[i] = f(u, v, p);
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
  return { pos, nor, acc };
}

/** 变形进度：每个粒子按自己的种子稍微错开，然后 smoothstep。着色器里是同一个公式。 */
export function morphK(m, seed) {
  const k = Math.min(1, Math.max(0, m * 1.35 - seed * 0.35));
  return k * k * (3 - 2 * k);
}
