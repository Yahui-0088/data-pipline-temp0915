// 镜头：球坐标（方位角、仰角、距离），永远看向星球中心。
// 手势 / 鼠标只改「目标」，镜头按 dt 指数逼近目标（临界阻尼式），所以不会瞬移。
import { CONFIG } from "./config.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.home = { az: CONFIG.camera.initialAzimuth, el: CONFIG.camera.initialElevation };
    this.reset(true);
  }

  /** 初始 / 重置视角：默认正对第一个数据集，打开页面就能看到颜色。 */
  setHome(az, el, immediate = true) {
    this.home = { az, el: clamp(el, -CONFIG.camera.maxElevation, CONFIG.camera.maxElevation) };
    this.reset(immediate);
  }

  reset(immediate = false) {
    const c = CONFIG.camera;
    this.target = { az: this.home.az, el: this.home.el, dist: c.initialDistance };
    if (immediate || !this.cur) this.cur = { ...this.target };
    this.azVel = 0;           // 手势旋转产生的方位角速度（弧度/秒），会衰减
    this.apply();
  }

  /** 手势旋转：给一个目标角速度；手停下时传 0，速度按 rotationDamping 平滑衰减。 */
  driveAzimuth(velocity, dt) {
    const g = CONFIG.gestures;
    const v = clamp(velocity, -g.maxAngularVelocity, g.maxAngularVelocity);
    this.azVel += (v - this.azVel) * (1 - Math.exp(-g.rotationDamping * dt));
  }

  orbitBy(dAz, dEl) {
    this.target.az += dAz;
    this.target.el = clamp(this.target.el + dEl, -CONFIG.camera.maxElevation, CONFIG.camera.maxElevation);
  }

  setDistance(d) { this.target.dist = clamp(d, CONFIG.camera.minDistance, CONFIG.camera.maxDistance); }
  zoomBy(factor) { this.setDistance(this.target.dist * factor); }

  update(dt, autoRotate) {
    const c = CONFIG.camera;
    this.target.az += this.azVel * dt + (autoRotate ? c.autoRotateSpeed * dt : 0);
    const k = 1 - Math.exp(-c.followRate * dt);
    this.cur.az += (this.target.az - this.cur.az) * k;
    this.cur.el += (this.target.el - this.cur.el) * k;
    this.cur.dist += (this.target.dist - this.cur.dist) * k;
    // 硬约束：无论手势多快、抖动多大、帧率多低，都不会穿进星球或飞太远
    this.cur.dist = clamp(this.cur.dist, c.minDistance, c.maxDistance);
    this.cur.el = clamp(this.cur.el, -c.maxElevation, c.maxElevation);
    if (!Number.isFinite(this.cur.az + this.cur.el + this.cur.dist)) this.reset(true);
    this.apply();
  }

  apply() {
    const { az, el, dist } = this.cur, ce = Math.cos(el);
    this.camera.position.set(dist * ce * Math.sin(az), dist * Math.sin(el), dist * ce * Math.cos(az));
    this.camera.lookAt(0, 0, 0);
  }
}
