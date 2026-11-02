/**
 * 诊断：地图上有没有「点不到 / 点错」的格子。
 *
 * 对每个区域，把它的中心投影到屏幕上，问 world.pick() 返回谁：
 *   - 返回自己        = 正常
 *   - 返回别的区域    = 被前方地台的侧壁挡住了（掠射角遮挡）
 *   - 返回 -1         = 射线整个落空
 * 同时统计「这块地有多少比例的采样点能点中自己」。
 *
 * 用法: node tools/pickcheck.mjs [baseUrl]
 */
import { launch } from './lib/harness.mjs';

const BASE = process.argv[2] || 'http://localhost:5173';
const browser = await launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#btnLocal', { timeout: 20000 });
await page.click('#btnLocal');
await page.waitForSelector('#btnStart', { timeout: 20000 });
await page.click('#btnStart');
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if ((await page.evaluate(() => window.__game.state?.phase)) === 'playing') break;
}
await sleep(1200);

const res = await page.evaluate(() => {
  const s = window.__game.state;
  const w = window.__probe.world;
  const out = { total: s.regions.length, self: 0, other: 0, none: 0, samples: [], worst: [] };

  for (const r of s.regions) {
    // 区域中心顶面 -> 屏幕坐标
    const p = window.__probe.project(r.center.x, 2.6, r.center.y);
    const x = p.x, y = p.y;
    const id = w.pick(x, y);
    if (id === r.id) out.self++;
    else if (id < 0) out.none++;
    else out.other++;

    // 在该区域中心的 ±3 像素邻域采样，看命中率
    let ok = 0;
    for (let dx = -3; dx <= 3; dx += 2) {
      for (let dy = -3; dy <= 3; dy += 2) {
        if (w.pick(x + dx, y + dy) === r.id) ok++;
      }
    }
    out.samples.push(ok);
    if (id !== r.id) out.worst.push({ id: r.id, got: id, x: Math.round(x), y: Math.round(y) });
  }
  out.avgHitRate = out.samples.reduce((a, b) => a + b, 0) / out.samples.length;
  out.bad = out.samples.filter((n) => n <= 8).length;
  return out;
});

console.log(`区域 ${res.total} 块`);
console.log(`中心点直接命中自己: ${res.self}`);
console.log(`中心点点到别人:     ${res.other}`);
console.log(`中心点点了个空:     ${res.none}`);
console.log(`平均邻域命中率:     ${(res.avgHitRate / 16 * 100).toFixed(1)}% (满分 16/16)`);
console.log(`命中率 ≤50% 的格子: ${res.bad} 块`);
if (res.worst.length) console.log('前 10 个点错的:', JSON.stringify(res.worst.slice(0, 10)));
await browser.close();
