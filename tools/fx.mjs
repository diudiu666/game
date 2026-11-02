/**
 * 特效验收：占领 / 被占领 两条路径各抓几帧，并检查特效对象有没有泄漏
 * 用法: node tools/fx.mjs [base]
 */
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5173/';
const exe = join(homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

await page.click('#btnLocal');
await page.waitForTimeout(350);
await page.click('#btnStart');
await page.waitForTimeout(2600);

// 1) 真打一次。打之前给足兵力，并暂停规则推进，免得 AI 同时抢地干扰截图
const target = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  s.players[me].troops = 260;
  s.players[me].troopCap = 400;
  const r = s.regions.find((x) => x.owner !== me && x.neighbors.some((n) => s.regions[n].owner === me));
  if (!r) return null;
  const p = window.__probe.project(r.center.x, r.height, r.center.y);
  return { id: r.id, x: p.x, y: p.y };
});
console.log('目标区域', JSON.stringify(target));

if (target) {
  await page.mouse.click(target.x, target.y);
  // 立刻冻结：不让 AI 在截图间隙里也去抢地
  await page.evaluate(() => {
    window.__game.state.phase = 'paused';
  });
  await page.waitForTimeout(70);
  await page.screenshot({ path: 'shots/fx1-hit.png' });
  await page.waitForTimeout(160);
  await page.screenshot({ path: 'shots/fx2-spread.png' });
  await page.waitForTimeout(260);
  await page.screenshot({ path: 'shots/fx3-after.png' });
  await page.waitForTimeout(1400);
}

// 2) 被占领：同一套渲染，换成对方颜色 + 原主人颜色塌缩 + 红屏
const stolen = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  const mine = s.regions.filter((r) => r.owner === me);
  if (!mine.length) return null;
  const r = mine[Math.floor(mine.length / 2)];
  const foe = (me + 1) % s.players.length;
  const w = window.__probe.world;
  w.spawnAttack(r.id, r.id, s.players[foe].color);
  w.spawnCapture(r.id, s.players[foe].color, { stolenColor: s.players[me].color, big: true });
  w.shake(1.1);
  window.__probe.hud.impact('lost');
  const p = window.__probe.project(r.center.x, r.height, r.center.y);
  return { id: r.id, x: p.x, y: p.y };
});
console.log('被占领', JSON.stringify(stolen));
await page.waitForTimeout(90);
await page.screenshot({ path: 'shots/fx4-lost.png' });
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/fx5-lost-spread.png' });

await page.waitForTimeout(1800);
const alive = await page.evaluate(() => window.__probe.world.effectCount());
console.log('剩余特效对象', alive);

console.log(errors.length ? '错误: ' + errors.join(' | ') : '无控制台错误');
await browser.close();
