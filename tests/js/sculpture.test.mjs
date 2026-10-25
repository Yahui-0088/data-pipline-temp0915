// 粒子雕塑的纯函数测试（不需要浏览器）：细胞图案的粒子数、位置有限且有形状、变形公式、数据集区域。
// 运行：node tests/js/sculpture.test.mjs
import assert from "node:assert/strict";
import { SHAPES, KIND, SEG, makeParticles, buildShape, morphK } from "../../emqc/api/static/galaxy/shapes.js";
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
// 细胞：只有一个图案；四种粒子都有，各占合理比例（没有轨道环）
assert.deepEqual(SHAPES, ["cell"]);
const c = built.cell, cnt = {};
for (const k of c.kind) cnt[k] = (cnt[k] || 0) + 1;
for (const k of Object.values(KIND)) assert.ok(cnt[k] > N * 0.04, `kind ${k}: ${cnt[k]}`);
// 细胞核在细胞里面；像素方块都在溶解的那一侧（x > 0）
for (let i = 0; i < N; i++) {
  const r = Math.hypot(c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]);
  if (c.kind[i] === KIND.NUCLEUS) assert.ok(r < 0.5, "nucleus inside the cell");
  if (c.kind[i] === KIND.PIXEL) assert.ok(c.pos[i * 3] > -0.1, "pixels only on the dissolving side");
  if (c.kind[i] === KIND.MEMBRANE) assert.ok(r > 0.75 && r < 1.3, `membrane radius ${r}`);
}
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
assert.equal(dm.regionAt(0.5, SEG.membrane + 0.01)[0], -1, "only membrane particles belong to datasets");
assert.equal(dm.summary().processed, 1); assert.equal(dm.summary().unprocessed, 2);
globalThis.fetch = async () => ({ ok: false, status: 403 });
await dm.load();
assert.ok(dm.isMock && dm.datasets.length > 0, "falls back to clearly-marked mock data when the API is unavailable");

console.log("sculpture + dataset tests: all passed");
