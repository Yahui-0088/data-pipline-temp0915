// 五种图案：每个粒子有一个固定的 (u, v) 参数，图案 = 把 (u, v) 映射到三维表面的连续函数。
// 所有图案共用同一批粒子（同样的数量、同样的编号），所以可以逐粒子插值变形；
// 数据集区域也定义在 (u, v) 上，换图案时同一个数据集还是同一批粒子。
// 纯函数，不依赖 three，可以在 Node 里测试。

export const SHAPES = ["wave", "saturn", "cube", "heart", "mobius"];
export const SHAPE_LABEL = { wave: "波浪", saturn: "土星", cube: "立方体", heart: "爱心", mobius: "莫比乌斯环" };

const TAU = Math.PI * 2;
const gauss = (x, z, s) => Math.exp(-(x * x + z * z) / (2 * s * s));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function rotX(o, a) { const c = Math.cos(a), s = Math.sin(a), y = o[1], z = o[2]; o[1] = y * c - z * s; o[2] = y * s + z * c; }
function rotY(o, a) { const c = Math.cos(a), s = Math.sin(a), x = o[0], z = o[2]; o[0] = x * c + z * s; o[2] = -x * s + z * c; }
function rotZ(o, a) { const c = Math.cos(a), s = Math.sin(a), x = o[0], y = o[1]; o[0] = x * c - y * s; o[1] = x * s + y * c; }

// 每个函数：f(u, v, out) → 写入位置，返回「强调」值 0–1（棱、轮廓上更亮）
const FN = {
  // 1. 起伏的地形：正弦波 + 多频扰动 + 高斯山丘和山谷 + 不对称变形，边缘轻微卷起
  wave(u, v, o) {
    const x = (u - 0.5) * 3.6, z = (v - 0.5) * 2.7;
    let y = 0.2 * Math.sin(1.6 * x + 0.6) * Math.cos(1.25 * z - 0.3)
      + 0.46 * gauss(x - 0.55, z + 0.25, 0.42) - 0.32 * gauss(x + 0.85, z - 0.35, 0.5)
      + 0.24 * gauss(x + 0.15, z + 0.8, 0.3) + 0.16 * gauss(x - 1.25, z - 0.7, 0.35)
      + 0.05 * Math.sin(4.1 * x + 2.3 * z) + 0.03 * Math.sin(7.3 * x - 5.1 * z + 1.1) + 0.015 * Math.sin(13.1 * x + 9.7 * z)
      + 0.05 * x + 0.08 * (x / 1.8) * (x / 1.8) * (x / 1.8);
    o[0] = x; o[1] = y - 0.08; o[2] = z;
    return 0;
  },
  // 2. 土星：球体（v < 0.6）+ 带卡西尼缝的光环，整体倾斜
  saturn(u, v, o) {
    const a = TAU * u;
    if (v < 0.6) {
      const y = 1 - 2 * (v / 0.6), s = Math.sqrt(Math.max(0, 1 - y * y)), R = 0.78;
      o[0] = s * Math.cos(a) * R; o[1] = y * R; o[2] = s * Math.sin(a) * R;
    } else {
      const w = (v - 0.6) / 0.4;
      const r = w < 0.58 ? 1.08 + (w / 0.58) * 0.5 : 1.66 + ((w - 0.58) / 0.42) * 0.36;
      o[0] = Math.cos(a) * r; o[1] = 0; o[2] = Math.sin(a) * r;
    }
    rotX(o, 0.42); rotZ(o, 0.16);
    return v >= 0.6 ? 0.25 : 0;
  },
  // 3. 立方体：u 的前 2/3 绕四个侧面一圈（连续），后 1/3 是顶面和底面；棱更亮
  cube(u, v, o) {
    const h = 0.82;
    let x, y, z, a, b;
    if (u < 4 / 6) {
      const p = u * 6, f = Math.floor(p);
      a = (p - f) * 2 - 1; b = v * 2 - 1; y = b;
      if (f === 0) { x = a; z = 1; } else if (f === 1) { x = 1; z = -a; } else if (f === 2) { x = -a; z = -1; } else { x = -1; z = a; }
    } else if (u < 5 / 6) { a = (u - 4 / 6) * 12 - 1; b = v * 2 - 1; x = a; y = 1; z = b; }
    else { a = (u - 5 / 6) * 12 - 1; b = v * 2 - 1; x = a; y = -1; z = -b; }
    o[0] = x * h; o[1] = y * h; o[2] = z * h;
    rotY(o, 0.55); rotX(o, 0.12);
    return smooth(0.86, 0.99, Math.max(Math.abs(a), Math.abs(b)));
  },
  // 4. 爱心：经典隐式心形曲面 (x²+9/4·y²+z²−1)³ − x²z³ − 9/80·y²z³ = 0（z 朝上、y 是厚度）。
  //    (u, v) 先映射成从中心出发的方向，再沿这个方向找到曲面（从外往里扫，再二分），所以粒子连续地铺满整个表面
  heart(u, v, o) {
    const lon = TAU * u, cz = 1 - 2 * v, s = Math.sqrt(Math.max(0, 1 - cz * cz));
    const dx = s * Math.cos(lon), dy = s * Math.sin(lon), dz = cz;
    const f = (r) => {
      const x = dx * r, y = dy * r, z = dz * r + 0.1, q = x * x + 2.25 * y * y + z * z - 1;
      return q * q * q - x * x * z * z * z - 0.1125 * y * y * z * z * z;
    };
    let hi = 1.6, lo = hi;
    while (lo > 0.02 && f(lo) > 0) lo -= 0.04;            // 从外往里第一次进到心形里面
    hi = lo + 0.04;
    for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
    const r = (lo + hi) / 2, K = 0.92;
    o[0] = dx * r * K; o[1] = (dz * r - 0.05) * K; o[2] = dy * r * K;
    return 0;
  },
  // 5. 莫比乌斯环：半扭转的连续带子
  mobius(u, v, o) {
    const a = TAU * u, w = (v - 0.5) * 1.15, R = 1.15;
    const r = R + w * Math.cos(a / 2);
    o[0] = r * Math.cos(a); o[1] = w * Math.sin(a / 2); o[2] = r * Math.sin(a);
    rotX(o, 0.55); rotZ(o, -0.12);
    return smooth(0.8, 1.0, Math.abs(w) / 0.575) * 0.5;
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
