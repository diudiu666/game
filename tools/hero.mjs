/**
 * 生成 README 用的头图：docs/hero.png
 *
 * 做法是开一局单人局，先让 AI 各自发育一会儿，再让自己手动吃掉一圈中立区，
 * 最后把指针悬停在一块自家领地上（顺手把右侧区域面板带出来），截图。
 * 这样出来的图是真实对局画面，不是摆拍的假数据。
 *
 * 用法: node tools/hero.mjs [base] [输出路径]
 * 注意：需要 playwrite 能启动浏览器（见 tools/lib/harness.mjs）。
 */
import { launch, sleep } from './lib/harness.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = process.argv[3] || 'docs/hero.png';
mkdirSync(dirname(OUT), { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#btnLocal', { timeout: 20000 });
await page.click('#btnLocal');
await page.waitForSelector('#btnStart');
await page.click('#btnStart');
await page.waitForFunction(() => window.__game?.state?.phase === 'playing', null, { timeout: 30000 });

// 先让 AI 铺开一点，避免头图是全灰的空盘
await sleep(9000);

// 自己吃掉一圈相邻中立区：每步给足兵力，占一块就走，节奏拉慢让特效播完
for (let i = 0; i < 14; i++) {
  const ok = await page.evaluate(() => {
    const s = window.__game.state;
    const me = s.viewIndex;
    if (s.phase !== 'playing') return false;
    s.players[me].troops = 120;
    const target = s.regions.find(
      (r) => r.owner !== me && r.neighbors.some((n) => s.regions[n].owner === me),
    );
    if (!target) return false;
    return window.__probe.attack(s, me, target.id).ok;
  });
  if (!ok) break;
  await sleep(420);
}

await sleep(2600);

// 悬停一块自家领地：触发高亮 + 右侧区域面板
const hover = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  const own = s.regions.filter((r) => r.owner === me);
  if (!own.length) return null;
  // 挑最靠中间的一块，构图更稳
  own.sort((a, b) => Math.hypot(a.center.x, a.center.y) - Math.hypot(b.center.x, b.center.y));
  const p = window.__probe.project(own[0].center.x, 2.6, own[0].center.y);
  return { x: Math.round(p.x), y: Math.round(p.y) };
});
if (hover) {
  await page.mouse.move(hover.x, hover.y);
  await sleep(900);
}

await page.screenshot({ path: OUT });
const stat = await page.evaluate(() => {
  const s = window.__game.state;
  return {
    phase: s.phase,
    mine: s.players[s.viewIndex].regionCount,
    ai: s.players.filter((p) => p.alive).map((p) => p.regionCount),
    neutral: s.regions.filter((r) => r.owner === null).length,
  };
});
console.log(`已保存 ${OUT}`, JSON.stringify(stat));
if (errors.length) console.log('页面报错:', errors.slice(0, 3));
await browser.close();
