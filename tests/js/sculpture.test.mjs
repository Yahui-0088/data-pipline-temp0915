// 粒子雕塑的纯函数测试（不需要浏览器）：五种图案同样的粒子数、位置有限且有形状、变形公式、数据集区域。
// 运行：node tests/js/sculpture.test.mjs
import assert from "node:assert/strict";
import { SHAPES, makeParticles, buildShape, morphK } from "../../emqc/api/static/galaxy/shapes.js";
import { DatasetManager } from "../../emqc/api/static/galaxy/datasetManager.js";

let a = 1;
const rand = () => ((a = (a * 16807) % 2147483647) / 2147483647);
const N = 20000;
const P = makeParticles(N, rand);

const box = (pos) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[i + c]); hi[c] = Math.max(hi[c], pos[i + c]); }
  return hi.map((h, c) => h - lo[c]);
};

const built = {};
for (const s of SHAPES) {
  const S = (built[s] = buildShape(s, P));
  assert.equal(S.pos.length, N * 3, `${s}: same particle count`);
  assert.ok(S.pos.every(Number.isFinite) && S.nor.every(Number.isFinite), `${s}: finite positions / normals`);
  const ext = box(S.pos);
  assert.ok(Math.max(...ext) > 1.2 && Math.max(...ext) < 4.5, `${s}: sensible size ${ext.map((e) => e.toFixed(2))}`);
  for (let i = 0; i < N; i += 997) assert.ok(Math.abs(Math.hypot(S.nor[i * 3], S.nor[i * 3 + 1], S.nor[i * 3 + 2]) - 1) < 1e-3, `${s}: unit normals`);
}
// 地形：横向铺开、比高度宽得多
const w = box(built.wave.pos);
assert.ok(w[0] > 3 && w[2] > 2 && w[1] < 1.4, "wave is a broad horizontal surface");
// 土星：球体半径 ~0.78 的粒子 + 半径 > 1.05 的光环粒子都有
let body = 0, ring = 0;
for (let i = 0; i < N; i++) { const r = Math.hypot(built.saturn.pos[i * 3], built.saturn.pos[i * 3 + 1], built.saturn.pos[i * 3 + 2]); if (r < 0.82) body++; else if (r > 1.05) ring++; }
assert.ok(body > N * 0.5 && ring > N * 0.3, `saturn has a body (${body}) and rings (${ring})`);
// 立方体：棱上的粒子被强调
assert.ok(built.cube.acc.some((x) => x > 0.9) && built.cube.acc.some((x) => x === 0), "cube edges are emphasised");
// 变形：起点 0、终点 1，单调，种子只让粒子稍微错开
for (const seed of [0, 0.5, 1]) {
  assert.equal(morphK(0, seed), 0); assert.equal(morphK(1, seed), 1);
  let prev = -1; for (let m = 0; m <= 1.0001; m += 0.05) { const k = morphK(m, seed); assert.ok(k >= prev - 1e-12); prev = k; }
}
// 同一套参数再生成一次，结果一样（粒子身份固定）
a = 1; const P2 = makeParticles(N, rand);
assert.deepEqual(P2.uv, P.uv, "particles are deterministic");

// 数据集区域：同一个 id 永远在同一个位置；区域中心命中这个数据集；接口不可用时退回示例数据
const dm = new DatasetManager();
const rows = [{ dataset_id: "a" }, { dataset_id: "b", last_run: "2026-10-01T00:00", n_sections: 100 }];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ datasets: rows }) });
await dm.load();
const regA = dm.datasets.find((d) => d.id === "a").particleRegion;
rows.push({ dataset_id: "c" });
await dm.load();
assert.deepEqual(dm.datasets.find((d) => d.id === "a").particleRegion, regA, "region is stable when other datasets are added");
const b = dm.datasets.find((d) => d.id === "b");
assert.equal(b.status, "processed"); assert.equal(dm.datasets.find((d) => d.id === "a").status, "unprocessed");
assert.equal(dm.datasets[dm.regionAt(b.particleRegion.u, b.particleRegion.v)[0]].id, "b", "region centre hits that dataset");
assert.equal(dm.summary().processed, 1); assert.equal(dm.summary().unprocessed, 2);
globalThis.fetch = async () => ({ ok: false, status: 403 });
await dm.load();
assert.ok(dm.isMock && dm.datasets.length > 0, "falls back to clearly-marked mock data when the API is unavailable");

console.log("sculpture + dataset tests: all passed");
