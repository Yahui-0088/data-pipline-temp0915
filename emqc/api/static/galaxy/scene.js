// 渲染器（纯黑背景）、辉光后处理、窗口缩放。
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

export class GalaxyScene {
  constructor(container) {
    this.container = container;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, container.clientWidth / container.clientHeight, 0.05, 400);
    this._fitFov();
    this._disposables = [];
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.6, 0.12, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
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

  /** 辉光强度 0–1（滑杆）→ bloom 强度；0 时直接关掉这一步 */
  setGlow(v) { this.bloom.strength = v * 0.9; this.bloom.enabled = v > 0.01; }

  render() { this.composer.render(); }

  dispose() {
    window.removeEventListener("resize", this._onResize);
    this._disposables.forEach((d) => d.dispose && d.dispose());
    this.composer.dispose && this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
