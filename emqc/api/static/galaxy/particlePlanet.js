// 粒子星球：一个 BufferGeometry + 一个 ShaderMaterial。几何只生成一次；每帧只更新 uniform（时间、区域高亮）。
import * as THREE from "three";
import { CONFIG } from "./config.js";

const VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uRadius;
uniform float uViewH;
uniform float uRegionStatus[${CONFIG.data.maxRegions}];
uniform float uRegionGlow[${CONFIG.data.maxRegions}];
attribute float aSeed;
attribute float aSize;
attribute float aLayer;
attribute float aRegion;
varying vec3 vColor;
varying float vAlpha;

vec3 ramp(float t) {
  vec3 black = vec3(0.008, 0.012, 0.04);
  vec3 navy  = vec3(0.03, 0.08, 0.28);
  vec3 blue  = vec3(0.12, 0.38, 1.0);
  vec3 cyan  = vec3(0.5, 0.86, 1.0);
  vec3 white = vec3(1.0, 0.98, 0.94);
  if (t < 0.28) return mix(black, navy, smoothstep(0.0, 0.28, t));
  if (t < 0.55) return mix(navy, blue, smoothstep(0.28, 0.55, t));
  if (t < 0.85) return mix(blue, cyan, smoothstep(0.55, 0.85, t));
  return mix(cyan, white, smoothstep(0.85, 1.15, t));
}

void main() {
  vec3 p = position;
  float r = length(p);
  vec3 n = p / max(r, 1e-4);
  // 小幅、低频的起伏：形状不变，表面在"呼吸"
  float wob = sin(uTime * 0.7 + aSeed * 6.2831) * 0.006 + sin(uTime * 0.23 + dot(n, vec3(3.1, 1.7, 2.3)) * 2.0) * 0.007;
  if (aLayer > 3.5) {                               // 尘埃：绕 y 轴慢慢漂
    float a = uTime * 0.035 * (0.4 + aSeed);
    float c = cos(a), s = sin(a);
    p.xz = mat2(c, -s, s, c) * p.xz;
    p.y += sin(uTime * 0.2 + aSeed * 12.0) * 0.04 * uRadius;
  } else {
    p += n * wob * uRadius;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 nView = normalize(normalMatrix * n);
  vec3 toCam = normalize(-mv.xyz);
  float facing = dot(nView, toCam);
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  float lambert = clamp(dot(nView, L) * 0.5 + 0.5, 0.0, 1.0);
  float rim = pow(1.0 - abs(facing), 2.2);
  float rn = r / uRadius;

  float t; float alpha; float size = aSize;
  if (aLayer < 0.5) {                               // 表面壳：光照 + 边缘光决定明暗
    float lit = pow(lambert, 1.4);
    t = lit * 1.18 + rim * 0.22 + (aSeed - 0.5) * 0.14;
    alpha = 0.1 + 0.55 * lit;
    alpha *= mix(0.18, 1.0, smoothstep(-0.2, 0.25, facing));   // 背面暗下去，球形更清楚
  } else if (aLayer < 1.5) {                        // 内部：越往里越亮
    t = 1.2 - rn * 0.75 + (aSeed - 0.5) * 0.12;
    alpha = 0.05 + 0.16 * (1.0 - rn) * (1.0 - rn);
  } else if (aLayer < 2.5) {                        // 核心：白
    t = 1.25;
    alpha = 0.16;
  } else if (aLayer < 3.5) {                        // 大气：只有边缘亮
    t = 0.3 + rim * 0.55 + lambert * 0.1;
    alpha = 0.03 + rim * 0.16;
  } else {                                          // 尘埃
    t = 0.38 + aSeed * 0.3;
    alpha = 0.22;
  }
  vec3 col = ramp(t);

  if (aRegion >= 0.0) {                             // 数据集区域：绿 = 已处理，灰 = 未处理
    int i = int(aRegion + 0.5);
    float st = uRegionStatus[i];
    float glow = uRegionGlow[i];
    vec3 tint = st > 0.5 ? vec3(0.16, 1.0, 0.52) : vec3(0.6, 0.64, 0.7);
    col = mix(col, tint * (0.55 + 0.75 * lambert), 0.8);
    col += tint * glow * (st > 0.5 ? 1.1 : 1.0);
    alpha = min(1.0, max(alpha * 1.5, 0.22 * smoothstep(-0.2, 0.25, facing)) + glow * 0.45);
    size *= 1.0 + glow * 0.7;
  }

  vColor = col;
  vAlpha = alpha;
  gl_Position = projectionMatrix * mv;
  // 粒子像素大小跟着「每个世界单位占多少像素」走（参考：900px 高、45° 视角），换屏幕 / 竖屏时密度不变
  float pxPerUnit = projectionMatrix[1][1] * uViewH * 0.5 / 1086.4;
  gl_PointSize = size * uSizeScale * uPixelRatio * pxPerUnit / max(-mv.z, 0.1);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv) * 2.0;
  if (d > 1.0) discard;
  float core = exp(-d * d * 5.5);
  float halo = (1.0 - d) * 0.28;
  float a = vAlpha * (core + halo);
  gl_FragColor = vec4(vColor * a, a);
}
`;

// 均匀随机方向（不用 Fibonacci：规则网格在近处会看出纹路）
function randDir(rand, out) {
  const u = rand() * 2 - 1, th = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  out[0] = s * Math.cos(th); out[1] = u; out[2] = s * Math.sin(th);
  return out;
}

// 固定种子的随机数：每次打开星球长得一样
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class ParticlePlanet {
  constructor(datasets, { count, pixelRatio }) {
    this.datasets = datasets;
    this.count = count;
    this.R = CONFIG.planet.radius;
    this.uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uSizeScale: { value: CONFIG.planet.sizeScale },
      uRadius: { value: this.R },
      uViewH: { value: typeof innerHeight === "number" ? innerHeight : 900 },
      uRegionStatus: { value: new Float32Array(CONFIG.data.maxRegions) },
      uRegionGlow: { value: new Float32Array(CONFIG.data.maxRegions) },
    };
    this.setDatasets(datasets);
    this.geometry = this._build();
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  setDatasets(datasets) {
    this.datasets = datasets;
    const st = this.uniforms.uRegionStatus.value;
    st.fill(0);
    datasets.forEach((d, i) => { st[i] = d.status === "processed" ? 1 : 0; });
  }

  _build() {
    const n = this.count, R = this.R, L = CONFIG.planet.layers, rand = mulberry32(20261025);
    const pos = new Float32Array(n * 3), seed = new Float32Array(n), size = new Float32Array(n);
    const layer = new Float32Array(n), region = new Float32Array(n).fill(-1);
    const counts = [L.surface, L.inner, L.core, L.atmosphere, L.dust].map((f) => Math.round(f * n));
    const dir = [0, 0, 0];
    let k = 0;
    for (let li = 0; li < 5; li++) {
      for (let j = 0; j < counts[li] && k < n; j++, k++) {
        randDir(rand, dir);
        let r, s;
        const big = Math.pow(rand(), 6);             // 少数特别大、特别亮的粒子
        if (li === 0) { r = R * (1 + (rand() - 0.5) * 0.035); s = 1.1 + rand() * 1.6 + big * 5; }
        else if (li === 1) { r = R * 0.95 * Math.pow(rand(), 0.55); s = 0.8 + rand() * 1.4 + big * 3; }
        else if (li === 2) { r = R * 0.5 * Math.pow(rand(), 1.6); s = 2.5 + rand() * 4.5; }
        else if (li === 3) { r = R * (1.03 + 0.2 * Math.pow(rand(), 2)); s = 0.7 + rand() * 1.2; }
        else { r = R * (1.3 + 1.3 * rand()); s = 0.6 + rand() * 1.6 + big * 2; }
        pos[k * 3] = dir[0] * r; pos[k * 3 + 1] = dir[1] * r; pos[k * 3 + 2] = dir[2] * r;
        seed[k] = rand(); size[k] = s; layer[k] = li;
        if (li === 0) region[k] = this._regionOf(dir);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aLayer", new THREE.BufferAttribute(layer, 1));
    g.setAttribute("aRegion", new THREE.BufferAttribute(region, 1));
    g.setDrawRange(0, k);
    return g;
  }

  // 表面粒子属于哪个数据集：区域重叠时归离中心（按区域半径归一化）最近的那个
  _regionOf(dir) {
    let best = -1, bestRatio = 1;
    for (let i = 0; i < this.datasets.length; i++) {
      const c = this.datasets[i].center;
      const ratio = Math.acos(Math.max(-1, Math.min(1, c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2]))) / this.datasets[i].radiusRad;
      if (ratio < bestRatio) { bestRatio = ratio; best = i; }
    }
    return best;
  }

  /** 每帧：hovered = 当前目标区域（-1 无）；高亮按 dt 渐变，不会闪。 */
  update(time, dt, hovered) {
    this.uniforms.uTime.value = time;
    const g = this.uniforms.uRegionGlow.value, k = 1 - Math.exp(-CONFIG.hover.glowRate * dt);
    for (let i = 0; i < this.datasets.length; i++) g[i] += ((i === hovered ? 1 : 0) - g[i]) * k;
  }

  setPixelRatio(pr) { this.uniforms.uPixelRatio.value = pr; }
  setViewHeight(h) { this.uniforms.uViewH.value = h; }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
