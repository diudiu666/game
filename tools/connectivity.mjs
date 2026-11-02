/** 检查生成的地图是否连通（不连通会出现永远打不到的飞地） */
import { generateRegions } from '../src/mapgen.js';

let bad = [];
let isolated = 0;
const N = Number(process.argv[2] || 200);
for (let s = 1; s <= N; s++) {
  const seed = s * 104729;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const n = map.regions.length;
  const seen = new Set([0]);
  const q = [0];
  while (q.length) {
    const i = q.pop();
    for (const j of map.regions[i].neighbors) if (!seen.has(j)) { seen.add(j); q.push(j); }
  }
  const lonely = map.regions.filter((r) => r.neighbors.length === 0);
  if (lonely.length) isolated += lonely.length;
  if (seen.size !== n) bad.push({ seed, total: n, reach: seen.size });
}
console.log('样本', N, '| 不连通地图数', bad.length, '| 孤立区域总数', isolated);
console.log(bad.slice(0, 8));
