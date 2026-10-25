// 数据星球的全部可调参数。改这里就行，其他模块只读它。
export const CONFIG = {
  data: {
    endpoint: "/api/v1/report/data?weeks=2",   // 汇报接口：已按登录账号的项目范围过滤
    maxRegions: 64,                           // 着色器里区域数组的长度；更多数据集不画在雕塑上（界面会说明）
  },
  sculpture: {
    particlesHigh: 90000,
    particlesLow: 50000,                      // 低配设备 / 手机
    morphSeconds: 1.8,                        // 换图案的过渡时长
    regionMinRadius: 0.06,                    // 数据集区域在参数平面上的半径（最小 / 切片最多时）
    regionMaxRadius: 0.11,
    hoverRadiusPx: 16,                        // 光标离最近粒子多少像素以内算命中
    pickSamples: 7000,                        // 命中检测抽样的粒子数（CPU 上）
  },
  // 配色：a = 亮部，b = 暗部 / 辅色。默认白 + 淡薰衣草
  themes: {
    white: { label: "白", a: "#ffffff", b: "#b8a6ff" },
    ice: { label: "冰蓝", a: "#eef9ff", b: "#78c6ff" },
    electric: { label: "电光蓝", a: "#d6e6ff", b: "#2c63ff" },
    violet: { label: "紫", a: "#f2e8ff", b: "#8d5bff" },
    magenta: { label: "品红", a: "#ffe4f6", b: "#ff3fb2" },
    emerald: { label: "翡翠绿", a: "#e8fff4", b: "#1fd58a" },
  },
  defaults: { shape: "wave", theme: "white", size: 1, brightness: 1, glow: 0.7, speed: 1 },
  hoverColors: { processed: "#2cf08a", unprocessed: "#c7ccd6" },   // 鼠标滑过：已处理 = 绿，未处理 = 灰白
  camera: {
    fov: 45,
    initialDistance: 4.3,
    minDistance: 1.9,                         // 硬下限：不会钻进雕塑里
    maxDistance: 9,                           // 硬上限：雕塑不会小到看不见
    initialAzimuth: 0.6,
    shapeElevation: { wave: 0.55, saturn: 0.22, cube: 0.3, heart: 0.08, mobius: 0.3 },   // 每种图案的电影感视角
    maxElevation: 1.25,                       // 约 72°，防止越过极点翻转
    followRate: 7,                            // 位置跟随目标的速度（越大越紧）
    autoRotateSpeed: 0.07,                    // 空闲时缓慢自转（弧度/秒）
    idleBeforeAutoRotate: 4,                  // 多少秒没有操作开始自转
  },
  hover: { glowRate: 5 },                     // 高亮渐亮 / 渐暗的速度
};

export const lowPowerDevice = () =>
  (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || Math.min(innerWidth, innerHeight) < 600;
