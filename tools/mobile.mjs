/** 手机竖屏 + 重开流程验收 */
import { launch } from './lib/harness.mjs';

const browser = await launch({  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const errors = [];
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

await page.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/m1-start.png' });

await page.tap('#btnLocal');
await page.waitForTimeout(400);
await page.tap('#btnStart');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/m2-play.png' });

// 竖屏下试着点一块可攻击区域
const pt = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  for (const r of s.regions) {
    if (r.owner === me) continue;
    const adj = r.neighbors.some((x) => s.regions[x].owner === me);
    if (!adj) continue;
    if (s.players[me].troops < window.__probe.attackCost(s, r, me)) continue;
    return window.__probe.project(r.center.x, r.height + 0.6, r.center.y);
  }
  return null;
});
if (pt) {
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForTimeout(600);
}
const st = await page.evaluate(() => ({
  mine: window.__game.state.players[0].regionCount,
  logs: [...document.querySelectorAll('.logline')].map((d) => d.textContent),
}));
console.log('手机端点按结果', JSON.stringify(st));
await page.screenshot({ path: 'shots/m3-after.png' });

// 重开流程
await page.evaluate(() => { window.__game.state.time = 0.5; });
await page.waitForTimeout(1500);
await page.tap('#btnRestart');
await page.waitForTimeout(1500);
const re = await page.evaluate(() => ({
  mode: window.__game.mode,
  phase: window.__game.state.phase,
  overlayOff: document.getElementById('overlay').classList.contains('off'),
  seeds: window.__game.state.regions.length,
}));
console.log('重开结果', JSON.stringify(re));
await page.screenshot({ path: 'shots/m4-restart.png' });

console.log(errors.length ? '错误:\n' + errors.join('\n') : '无控制台错误');
await browser.close();
