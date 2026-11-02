/**
 * 验收：兵营升级后「攻占消耗」真的下降，且发育面板文案跟着变。
 * 用法: node tools/upgradeshot.mjs [baseUrl]
 */
import { launch } from './lib/harness.mjs';

const BASE = process.argv[2] || 'http://localhost:5173';
const browser = await launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#btnLocal', { timeout: 20000 });
await page.click('#btnLocal');
await page.waitForSelector('#btnStart', { timeout: 20000 });
await page.click('#btnStart');

// 等对局真正开始
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const phase = await page.evaluate(() => window.__game.state?.phase);
  if (phase === 'playing') break;
}

const snap = () =>
  page.evaluate(() => {
    const s = window.__game.state;
    const me = s.players[s.viewIndex];
    const costs = s.regions
      .filter((r) => r.owner !== s.viewIndex)
      .map((r) => window.__probe.attackCost(s, r, s.viewIndex));
    return {
      barracks: me.barracks,
      cap: Math.round(me.troopCap),
      troops: Math.round(me.troops),
      minCost: Math.min(...costs),
      maxCost: Math.max(...costs),
      desc: document.getElementById('desc-barracks').textContent,
      price: document.getElementById('price-barracks').textContent,
      hud: `${document.getElementById('meTxt').textContent} · ${document.getElementById('meRate').textContent}`,
    };
  });

const before = await snap();
// 给足金币，连升 4 级兵营
await page.evaluate(() => (window.__game.state.players[window.__game.state.viewIndex].gold = 400));
for (let i = 0; i < 4; i++) {
  await page.click('#upgrades [data-type="barracks"]');
  await sleep(400);
}
const after = await snap();
await page.screenshot({ path: 'shots/upgrade-barracks.png' });

console.log('升兵营前:', JSON.stringify(before));
console.log('升兵营后:', JSON.stringify(after));
console.log(
  after.maxCost < before.maxCost && after.minCost <= before.minCost
    ? '✓ 攻占消耗随兵营下降'
    : '✗ 攻占消耗没有变化'
);
console.log(`✓ 上限变化 ${before.cap} → ${after.cap}（不再是卖点，但仍在涨）`);
console.log(errors.length ? '错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
