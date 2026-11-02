/**
 * 浏览器验收脚本：截图 + 控制台报错 + 模拟点击占领（走单人练习，不依赖别人）
 * 用法: node tools/shot.mjs [base]
 */
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exe = join(homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/01-start.png' });

// 进单人练习（不依赖服务端对局）
await page.click('#btnLocal');
await page.waitForTimeout(400);
await page.click('#btnStart');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/02-board.png' });

// 读一下运行时状态
const info = await page.evaluate(() => {
  const s = window.__game.state;
  return {
    phase: s.phase,
    regions: s.regions.length,
    players: s.players.map((p) => ({ n: p.name, r: p.regionCount, t: Math.round(p.troops), c: Math.round(p.troopCap) })),
    canvas: !!document.querySelector('canvas'),
  };
});
console.log('运行状态', JSON.stringify(info));

// 找到一块可攻击区域，用真实射线坐标点它
const hit = await page.evaluate(() => {
  const s = window.__game.state;
  const { attackCost } = window.__probe;
  const me = s.viewIndex;
  for (const r of s.regions) {
    if (r.owner === me) continue;
    const n = r.neighbors.find((x) => s.regions[x].owner === me);
    if (n === undefined) continue;
    if (s.players[me].troops < attackCost(s, r, me)) continue;
    return { id: r.id, cx: r.center.x, cy: r.center.y, h: r.height + 0.6, from: r.id };
  }
  return null;
});
console.log('目标区域', JSON.stringify(hit));

if (hit) {
  // 用相机投影算出屏幕坐标再点击
  const pt = await page.evaluate(
    ({ x, h, y }) => window.__probe.project(x, h, y),
    { x: hit.cx, h: hit.h, y: hit.cy }
  );
  console.log('屏幕坐标', JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(320);
  await page.screenshot({ path: 'shots/03-hover.png' });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'shots/04-attack.png' });
  const after = await page.evaluate(() => {
    const s = window.__game.state;
    return {
      mine: s.players[0].regionCount,
      troops: Math.round(s.players[0].troops),
      logs: [...document.querySelectorAll('.logline')].map((d) => d.textContent),
    };
  });
  console.log('点击后', JSON.stringify(after));
}

// 让 AI 跑一会儿，看看多玩家画面
await page.waitForTimeout(6000);
await page.screenshot({ path: 'shots/05-later.png' });

// 拉近看看地形起伏
await page.mouse.move(720, 520);
await page.mouse.wheel(0, -700);
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/06-close.png' });

// 结算界面：把时间压到 1 秒触发计时结算
await page.evaluate(() => { window.__game.state.time = 0.8; });
await page.waitForTimeout(1800);
await page.screenshot({ path: 'shots/07-end.png' });
const ended = await page.evaluate(() => ({
  phase: window.__game.state.phase,
  winner: window.__game.state.winner,
  overlayVisible: !document.getElementById('overlay').classList.contains('off'),
}));
console.log('结算', JSON.stringify(ended));

console.log(errors.length ? '错误:\n' + errors.join('\n') : '无控制台错误');
await browser.close();
