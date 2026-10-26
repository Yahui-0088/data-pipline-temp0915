// 粒子雕塑：一个 BufferGeometry + 一个 ShaderMaterial，几何体只建一次。
// 换图案：把「当前形状」写进 A、「目标形状」写进 B，着色器用 uMorph 逐粒子插值（GPU 上）；
// 流动 / 呼吸都在顶点着色器里按时间算；CPU 每帧只更新几个 uniform。
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { SHAPES, makeParticles, buildShape, morphK } from "./shapes.js";

const NR = CONFIG.data.maxRegions;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uViewH;
uniform float uMorph;
uniform float uWaveA;
uniform float uWaveB;
uniform float uBright;
uniform float uCamDist;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uHoverOk;
uniform vec3 uHoverTodo;
uniform float uRegionStatus[${NR}];
uniform float uRegionGlow[${NR}];
attribute vec3 aPosB;
attribute vec3 aNorA;
attribute vec3 aNorB;
attribute float aAccA;
attribute float aAccB;
attribute vec2 aUV;
attribute vec3 aDir;
attribute float aSeed;
attribute float aSize;
attribute float aRegion;
attribute float aKind;
uniform float uRestGlow;
varying vec3 vColor;
varying float vAlpha;
varying float vSquare;

void main() {
  // 逐粒子错开的平滑进度（和 shapes.js 的 morphK 同一个公式）
  float k = clamp(uMorph * 1.35 - aSeed * 0.35, 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);
  vec3 p = mix(position, aPosB, k);
  vec3 n = normalize(mix(aNorA, aNorB, k) + vec3(1e-5));
  float acc = mix(aAccA, aAccB, k);
  float waveW = mix(uWaveA, uWaveB, k);
  float t = uTime;

  // 流动：地形上是缓慢推进的起伏；其他图案沿法线轻轻呼吸。形状始终连贯，不抖
  float rip = sin(p.x * 2.1 + t * 0.9) * 0.055 + sin(p.z * 2.6 - t * 0.7 + p.x * 0.8) * 0.045 + sin((p.x + p.z) * 4.3 + t * 1.25) * 0.014;
  p.y += rip * waveW;
  p += n * sin(t * 0.8 + dot(p, vec3(2.3, 1.7, 2.9))) * 0.014 * (1.0 - waveW);
  // 变形途中粒子走一小段弧线，而不是直线穿过去
  p += aDir * sin(k * 3.14159) * 0.16 * (0.4 + aSeed);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 nV = normalize(normalMatrix * n);
  vec3 toCam = normalize(-mv.xyz);
  vec3 L = normalize(vec3(-0.45, 0.6, 0.65));
  float lam = abs(dot(nV, L));                          // 双面受光：粒子没有正反面
  float facing = abs(dot(nV, toCam));
  float rim = pow(1.0 - facing, 2.0);
  float lit = 0.3 + 0.7 * lam + rim * 0.35 + acc * 0.7;
  float depth = -mv.z;
  float df = clamp(1.25 - (depth - uCamDist) * 0.32, 0.3, 1.0);   // 远处的粒子暗下去，有纵深

  float tone = clamp(lit * 0.75 + (aSeed - 0.5) * 0.5, 0.0, 1.0);
  vec3 col = mix(uColB, uColA, tone) * (0.55 + 0.6 * lit);
  float alpha = (0.26 + 0.22 * aSeed) * df * uBright;
  float size = aSize * (0.85 + 0.3 * lit);

  // 按粒子种类：0 细胞膜 / 1 内膜 / 2 细胞核 / 3 像素方块
  float kind = aKind;
  vSquare = 0.0;
  if (kind < 0.5) {                                     // 细胞膜：边缘亮、正面通透，边缘带一点虹彩
    float iri = 0.5 + 0.5 * sin(dot(n, vec3(3.1, 2.3, 1.7)) * 2.4 + t * 0.25);
    col = mix(col, mix(vec3(0.62, 0.86, 1.0), vec3(1.0, 0.72, 0.92), iri), rim * 0.35);
    alpha *= 0.42 + 0.7 * rim;
  } else if (kind < 1.5) {                              // 内膜褶皱：更淡
    alpha *= 0.42 + 0.7 * rim;
  } else if (kind < 2.5) {                              // 细胞核：深紫、更实，边缘有一圈亮光
    col = mix(uColB * 0.7, uColA, clamp(rim * 1.1 + lam * 0.25, 0.0, 1.0));
    alpha *= 1.15 + rim * 0.8;
  } else {                              // 像素方块：慢慢往外飘、越飘越淡，循环
    float f = fract(t * 0.035 + aSeed);
    p = p + vec3(0.92, 0.17, 0.28) * f * 0.35;
    mv = modelViewMatrix * vec4(p, 1.0);
    depth = -mv.z;
    // 颜色随离细胞的距离渐变：贴着细胞 = 细胞的紫，越往外越白
    float far = smoothstep(1.0, 1.9, length(p));
    col = mix(mix(uColB, uColA, 0.3 + 0.25 * aSeed), vec3(1.0), far);
    alpha = (0.24 + 0.24 * aSeed) * uBright * (1.0 - f) * smoothstep(0.0, 0.08, f) * (1.0 + 0.7 * far) * 0.8;   // 外圈的白色更实一点，不发灰；整体 ×0.8 让方块的辉光弱 20%
    size = aSize * 1.25;
    vSquare = 1.0;
  }

  if (aRegion >= 0.0) {                                 // 数据集区域：已处理平时泛淡绿，滑过更亮；未处理只在滑过时变灰白
    int i = int(aRegion + 0.5);
    float g = uRegionGlow[i];
    bool done = uRegionStatus[i] > 0.5;
    float w = done ? uRestGlow + (1.0 - uRestGlow) * g : g;
    vec3 hc = done ? uHoverOk : uHoverTodo;
    col = mix(col, hc * (0.7 + 0.5 * lit), w * 0.9);
    alpha *= 1.0 + (done ? 0.9 : 0.0) + g * 1.6;            // 膜正面很通透，区域要加一点实感才看得见
    size *= 1.0 + g * 0.45;
  }

  vColor = col;
  vAlpha = alpha;
  gl_Position = projectionMatrix * mv;
  float pxPerUnit = projectionMatrix[1][1] * uViewH * 0.5 / 1086.4;
  gl_PointSize = size * uSizeScale * uPixelRatio * pxPerUnit / max(depth, 0.1);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSquare;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  if (vSquare > 0.5) {                                  // 像素方块：实心小方块，边缘略亮
    vec2 q = abs(uv) * 2.0;
    float m = max(q.x, q.y);
    if (m > 0.86) discard;
    float a = vAlpha * (0.7 + 0.3 * smoothstep(0.55, 0.86, m));
    gl_FragColor = vec4(vColor * a, a);
    return;
  }
  float d = length(uv) * 2.0;
  if (d > 1.0) discard;
  float core = exp(-d * d * 6.0);                       // 圆形软边，中心最亮
  float halo = (1.0 - d) * 0.22;
  float a = vAlpha * (core + halo);
  gl_FragColor = vec4(vColor * a, a);
}
`;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export class ParticleSculpture {
  constructor(data, { count, pixelRatio, shape }) {
    this.data = data;
    this.P = makeParticles(count, mulberry32(20261025));
    this.shapes = {};                                     // 预先算好每种图案的目标位置
    for (const s of SHAPES) this.shapes[s] = buildShape(s, this.P);
    this.shape = SHAPES.includes(shape) ? shape : SHAPES[0];
    this.from = this.shape;
    this.morph = { t: 1, dur: CONFIG.sculpture.morphSeconds };

    const n = this.P.n;
    this.region = new Float32Array(n).fill(-1);
    for (let i = 0; i < n; i++) this.region[i] = data.regionAt(this.P.uv[i * 2], this.P.uv[i * 2 + 1])[0];

    const S = this.shapes[this.shape];
    const g = new THREE.BufferGeometry();
    this.attr = {
      posA: new THREE.BufferAttribute(new Float32Array(S.pos), 3), posB: new THREE.BufferAttribute(new Float32Array(S.pos), 3),
      norA: new THREE.BufferAttribute(new Float32Array(S.nor), 3), norB: new THREE.BufferAttribute(new Float32Array(S.nor), 3),
      accA: new THREE.BufferAttribute(new Float32Array(S.acc), 1), accB: new THREE.BufferAttribute(new Float32Array(S.acc), 1),
    };
    Object.values(this.attr).forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("position", this.attr.posA); g.setAttribute("aPosB", this.attr.posB);
    g.setAttribute("aNorA", this.attr.norA); g.setAttribute("aNorB", this.attr.norB);
    g.setAttribute("aAccA", this.attr.accA); g.setAttribute("aAccB", this.attr.accB);
    g.setAttribute("aUV", new THREE.BufferAttribute(this.P.uv, 2));
    g.setAttribute("aDir", new THREE.BufferAttribute(this.P.dir, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(this.P.seed, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.P.size, 1));
    g.setAttribute("aRegion", new THREE.BufferAttribute(this.region, 1));
    g.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(S.kind), 1));
    this.geometry = g;

    const isWave = this.shape === "wave" ? 1 : 0;
    this.uniforms = {
      uTime: { value: 0 }, uPixelRatio: { value: pixelRatio }, uSizeScale: { value: 9 }, uViewH: { value: 900 },
      uMorph: { value: 1 }, uWaveA: { value: isWave }, uWaveB: { value: isWave },
      uBright: { value: 1 }, uCamDist: { value: CONFIG.camera.initialDistance },
      uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
      uHoverOk: { value: new THREE.Color(CONFIG.hoverColors.processed) }, uHoverTodo: { value: new THREE.Color(CONFIG.hoverColors.unprocessed) },
      uRegionStatus: { value: new Float32Array(NR) }, uRegionGlow: { value: new Float32Array(NR) }, uRestGlow: { value: CONFIG.restGlow },
    };
    data.datasets.forEach((d, i) => { this.uniforms.uRegionStatus.value[i] = d.status === "processed" ? 1 : 0; });
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;

    // 命中检测抽样（CPU）：固定的一批粒子编号
    const m = Math.min(n, CONFIG.sculpture.pickSamples), rnd = mulberry32(7);
    this.pickIdx = new Uint32Array(m);
    for (let i = 0; i < m; i++) this.pickIdx[i] = Math.floor(rnd() * n);
    this.hovered = -1;
  }

  setColors(a, b) { this.uniforms.uColA.value.set(a); this.uniforms.uColB.value.set(b); }
  setSize(s) { this.uniforms.uSizeScale.value = 9 * s; }
  setBrightness(b) { this.uniforms.uBright.value = b; }
  setPixelRatio(pr) { this.uniforms.uPixelRatio.value = pr; }
  setViewHeight(h) { this.uniforms.uViewH.value = h; }

  /** 换图案：从「此刻看到的样子」平滑过渡到新图案；几何体不重建，只更新 A / B 两组目标。 */
  setShape(name) {
    if (!this.shapes[name] || (name === this.shape && this.morph.t >= 1)) return;
    const n = this.P.n, seed = this.P.seed, A = this.attr, m = this._m();
    const pa = A.posA.array, pb = A.posB.array, na = A.norA.array, nb = A.norB.array, aa = A.accA.array, ab = A.accB.array;
    if (m >= 1) { pa.set(pb); na.set(nb); aa.set(ab); }
    else if (m > 0) {                                      // 过渡中又换：把当前插值结果定格成新的起点
      for (let i = 0; i < n; i++) {
        const k = morphK(m, seed[i]);
        for (let c = 0; c < 3; c++) { const j = i * 3 + c; pa[j] += (pb[j] - pa[j]) * k; na[j] += (nb[j] - na[j]) * k; }
        aa[i] += (ab[i] - aa[i]) * k;
      }
      this.uniforms.uWaveA.value = m > 0.5 ? this.uniforms.uWaveB.value : this.uniforms.uWaveA.value;
    }
    if (m >= 1) this.uniforms.uWaveA.value = this.uniforms.uWaveB.value;
    const S = this.shapes[name];
    pb.set(S.pos); nb.set(S.nor); ab.set(S.acc);
    this.uniforms.uWaveB.value = name === "wave" ? 1 : 0;
    Object.values(A).forEach((a) => { a.needsUpdate = true; });
    this.from = this.shape; this.shape = name;
    this.morph.t = 0;
    this.uniforms.uMorph.value = 0;
  }

  _m() { return this.uniforms.uMorph.value; }

  update(time, dt, hovered, camDist, wallDt = dt) {
    const U = this.uniforms;
    U.uTime.value = time;
    U.uCamDist.value = camDist;
    // 变形按真实时间走：卡顿的机器上也按时变完
    if (this.morph.t < 1) { this.morph.t = Math.min(1, this.morph.t + Math.min(wallDt, 0.5) / this.morph.dur); U.uMorph.value = easeInOut(this.morph.t); }
    const g = U.uRegionGlow.value, kg = 1 - Math.exp(-CONFIG.hover.glowRate * dt);
    for (let i = 0; i < this.data.datasets.length; i++) g[i] += ((i === hovered ? 1 : 0) - g[i]) * kg;
  }

  /** 屏幕上 (px, py) 指着哪个数据集：在抽样粒子里找光标附近最前面的一层，按数据集投票。 */
  pick(px, py, camera, w, h) {
    if (px == null) { this.hovered = -1; return -1; }
    camera.updateMatrixWorld();
    const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const m = this.uniforms.uMorph.value;
    const pa = this.attr.posA.array, pb = this.attr.posB.array, seed = this.P.seed;
    const R = CONFIG.sculpture.hoverRadiusPx, keepR = R * 1.8;
    // 先找光标附近离镜头最近的一层（前表面），再在这一层里按数据集投票：
    // 只看最前面的一个粒子太敏感（稀疏处常常恰好是区域外的粒子），投票更稳
    const cand = [];
    let front = Infinity, keep = false;
    for (let s = 0; s < this.pickIdx.length; s++) {
      const i = this.pickIdx[s], r = this.region[i];
      const k = morphK(m, seed[i]), j = i * 3;
      const x = pa[j] + (pb[j] - pa[j]) * k;
      const y = pa[j + 1] + (pb[j + 1] - pa[j + 1]) * k;
      const z = pa[j + 2] + (pb[j + 2] - pa[j + 2]) * k;
      const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) continue;
      const sx = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw + 1) * 0.5 * w;
      const sy = (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw) * 0.5 * h;
      const d = Math.hypot(sx - px, sy - py);
      if (r === this.hovered && r >= 0 && d < keepR) keep = true;     // 滞回：已选中的区域要明显离开才放开
      if (d < R) { cand.push(cw, r); if (cw < front) front = cw; }
    }
    const votes = new Map();
    let total = 0;
    for (let c = 0; c < cand.length; c += 2) {
      if (cand[c] > front + 0.3) continue;                            // 后面那层（背面、被挡住的）不算
      total++;
      votes.set(cand[c + 1], (votes.get(cand[c + 1]) || 0) + 1);
    }
    let best = -1, bestN = 0;
    for (const [r, nv] of votes) if (r >= 0 && nv > bestN) { best = r; bestN = nv; }
    if (bestN < Math.max(1, total * 0.3)) best = -1;                  // 区域粒子太少 = 在区域边缘外
    this.hovered = keep ? this.hovered : best;
    return this.hovered;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
