// 渲染器、背景（星空、星云、光晕、轨道弧）、辉光后处理、窗口缩放。
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CONFIG } from "./config.js";

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
  } catch (e) { return false; }
}

function radialTexture(stops, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GalaxyScene {
  constructor(container) {
    this.container = container;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x010207, 1);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, container.clientWidth / container.clientHeight, 0.05, 400);
    this._fitFov();
    this._disposables = [];
    this._background();
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.75, 0.5, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
  }

  _background() {
    // 远处星空：稀疏、小、偏蓝白
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), r = 60 + Math.random() * 90;
      pos.set([s * Math.cos(th) * r, u * r, s * Math.sin(th) * r], i * 3);
      const b = 0.35 + Math.random() * 0.65, blue = Math.random() < 0.25;
      col.set(blue ? [0.45 * b, 0.65 * b, b] : [b, b, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false });
    this.stars = new THREE.Points(g, m);
    this.scene.add(this.stars);
    this._disposables.push(g, m);

    // 星云：几片很淡的蓝色光斑，跟着镜头方向贴在远处
    const neb = radialTexture([[0, "rgba(40,90,220,0.35)"], [0.45, "rgba(20,40,120,0.12)"], [1, "rgba(0,0,0,0)"]]);
    this._disposables.push(neb);
    [[-30, 12, -60, 70], [38, -18, -70, 90], [5, 30, 70, 80]].forEach(([x, y, z, s]) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: neb, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3 }));
      sp.position.set(x, y, z); sp.scale.set(s, s, 1);
      this.scene.add(sp); this._disposables.push(sp.material);
    });

    // 星球外的光晕
    const halo = radialTexture([[0, "rgba(120,190,255,0.0)"], [0.34, "rgba(110,180,255,0.0)"], [0.4, "rgba(90,160,255,0.16)"], [0.55, "rgba(40,90,220,0.05)"], [1, "rgba(0,0,0,0)"]]);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const hs = CONFIG.planet.radius * 5.2;
    this.halo.scale.set(hs, hs, 1);
    this.scene.add(this.halo);
    this._disposables.push(halo, this.halo.material);

    // 两条很细的轨道弧
    this.arcs = new THREE.Group();
    [[1.55, 0.35, 0.2], [1.85, -0.5, 1.1]].forEach(([r, tilt, rot]) => {
      const pts = [];
      for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 1.35; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      const g2 = new THREE.BufferGeometry().setFromPoints(pts);
      const m2 = new THREE.LineBasicMaterial({ color: 0x3f7dff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(g2, m2);
      line.rotation.set(tilt, rot, 0);
      this.arcs.add(line);
      this._disposables.push(g2, m2);
    });
    this.scene.add(this.arcs);
  }

  // 竖屏（手机）时把垂直视角放大，让星球的「横向」大小和横屏差不多，不会撑出屏幕
  _fitFov() {
    const a = this.camera.aspect, base = CONFIG.camera.fov;
    this.camera.fov = a >= 1 ? base : Math.min(78, 2 * Math.atan(Math.tan((base * Math.PI) / 360) / a) * 180 / Math.PI);
    this.camera.updateProjectionMatrix();
  }

  add(obj) { this.scene.add(obj); }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this._fitFov();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  render(dt) {
    this.arcs.rotation.y += dt * 0.02;
    this.composer.render();
  }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this._disposables.forEach((d) => d.dispose && d.dispose());
    this.composer.dispose && this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
