// 数据星球的全部可调参数。改这里就行，其他模块只读它。
export const CONFIG = {
  cdn: {
    // 版本固定，与 templates/galaxy.html 里 importmap 的 three@0.160.0 对应
    visionBundle: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    visionWasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    handModel: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  },
  data: {
    endpoint: "/api/v1/report/data?weeks=2",   // 汇报接口：已按登录账号的项目范围过滤
    maxRegions: 64,                           // 着色器里区域数组的长度；更多数据集会并入最后一个区域之外（不着色）
  },
  planet: {
    radius: 1,
    particlesHigh: 70000,
    particlesLow: 32000,
    sizeScale: 10,                            // 粒子像素大小的总体倍数（再乘以距离衰减）
    // 各层占比：表面壳、内部体、白色核心、大气、漂浮尘埃
    layers: { surface: 0.66, inner: 0.13, core: 0.05, atmosphere: 0.11, dust: 0.05 },
    regionBaseRadiusDeg: 11,                  // 数据集区域的最小角半径
    regionMaxRadiusDeg: 22,                   // 切片最多的数据集的角半径
  },
  camera: {
    fov: 45,
    initialDistance: 3.6,
    minDistance: 1.6,                         // 硬下限：永远在星球表面之外
    maxDistance: 9,                           // 硬上限：星球不会小到看不见
    initialAzimuth: 0.6,
    initialElevation: 0.28,
    maxElevation: 1.25,                       // 约 72°，防止越过极点翻转
    followRate: 7,                            // 位置跟随目标的速度（越大越紧）
    autoRotateSpeed: 0.07,                    // 空闲时缓慢自转（弧度/秒）
    idleBeforeAutoRotate: 4,                  // 多少秒没有输入开始自转
  },
  gestures: {
    minHandScore: 0.55,                       // 低于这个置信度的手不用
    smoothing: 0.35,                          // 关键点指数平滑（0–1，越小越平滑）
    confirmMs: 140,                           // 手势要稳定这么久才算数（防误触）
    lostMs: 450,                              // 这么久看不到手 = 跟踪丢失
    rotationGain: 1.4,                        // 手转 1 弧度 → 镜头绕行多少弧度/秒（按速度）
    rotationDirection: -1,                    // 1 或 -1：手顺时针时镜头的绕行方向
    rotationThreshold: 0.5,                   // 手转得比这个慢（弧度/秒）不算旋转
    maxAngularVelocity: 2.2,                  // 镜头最大绕行角速度（弧度/秒）
    rotationDamping: 2.6,                     // 手停下后绕行速度衰减的快慢
    motionThreshold: 0.22,                    // 手靠近 / 远离摄像头的速度门槛（ln 掌宽 / 秒）
    zoomRange: 0.55,                          // 手掌视宽变化 e^0.55≈1.7 倍 = 走完整段缩放
    fingerExtended: 1.55,                     // 指尖到手腕 / 指根到手腕 > 这个 = 伸直
    fingerCurled: 1.18,                       // < 这个 = 握紧
    thumbExtended: 0.62,                      // 拇指尖到食指根 / 掌宽 > 这个 = 张开
  },
  hover: {
    enterRatio: 0.95,                         // 光标进入区域：角距离 / 区域半径 < 这个
    leaveRatio: 1.18,                         // 已选中的区域要离开到这个比例才放开（防闪烁）
    glowRate: 5,                              // 高亮渐亮 / 渐暗的速度
  },
};

export const lowPowerDevice = () =>
  (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || Math.min(innerWidth, innerHeight) < 600;
