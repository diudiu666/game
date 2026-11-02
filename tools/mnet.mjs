/**
 * tools/mnet.mjs —— 手机端联机验收
 * 桌面房主 + 手机竖屏玩家，检查大厅 / 对局 / 触摸占领 的排版。
 */

import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5173';
const exe = join(homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const host = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const hp = await host.newPage();
hp.on('pageerror', (e) => errors.push('[host] ' + e.message));
await hp.goto(BASE, { waitUntil: 'networkidle' });
await hp.waitForSelector('#roomCodeText');
const code = (await hp.textContent('#roomCodeText')).trim();
console.log('房间号', code);

const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push('[phone] ' + e.message));
await pp.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });

for (let i = 0; i < 50; i++) {
  await sleep(400);
  const n = await hp.$$eval('.seat.filled', (e) => e.length).catch(() => 0);
  if (n >= 2) break;
}
await pp.screenshot({ path: 'shots/m-net1-lobby.png' });

// 手机端有没有溢出
const overflow = await pp.evaluate(() => {
  const card = document.getElementById('card');
  return { w: card.scrollWidth, cw: card.clientWidth, h: card.scrollHeight, vh: innerHeight };
});
console.log('大厅卡片', JSON.stringify(overflow));
if (overflow.w > overflow.cw + 2) errors.push('大厅卡片横向溢出');

await hp.click('#btnStart');
for (let i = 0; i < 50; i++) {
  await sleep(400);
  const ph = await pp.evaluate(() => window.__game.state?.phase).catch(() => null);
  if (ph === 'playing') break;
}
await sleep(1200);
await pp.screenshot({ path: 'shots/m-net2-play.png' });

// 触摸占领：点自己地盘旁边的一块
const hit = await pp.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  for (const r of s.regions) {
    if (r.owner !== me) continue;
    for (const n of r.neighbors) {
      if (s.regions[n].owner === me) continue;
      const t = s.regions[n];
      const pt = window.__probe.project(t.center.x, t.height + 0.2, t.center.y);
      return { id: n, x: pt.x, y: pt.y };
    }
  }
  return null;
});
if (hit) {
  await pp.touchscreen.tap(hit.x, hit.y);
  await sleep(700);
  const owner = await pp.evaluate((id) => window.__game.state.regions[id].owner, hit.id);
  console.log('手机点击占领', hit.id, '→', owner, '自己座位', await pp.evaluate(() => window.__game.state.viewIndex));
  if (owner !== 1) errors.push(`手机点击没能占领（owner=${owner}）`);
}
await pp.screenshot({ path: 'shots/m-net3-after.png' });

const hudCheck = await pp.evaluate(() => {
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  const me = r('me');
  const up = r('upgrades');
  const board = r('board');
  return {
    meBottom: Math.round(me.bottom),
    boardTop: Math.round(board.top),
    upTop: Math.round(up.top),
    vh: innerHeight,
    overlapTopBottom: me.bottom > board.top,
  };
});
console.log('手机布局', JSON.stringify(hudCheck));

console.log(errors.length ? '\n错误:\n' + errors.join('\n') : '\n无错误');
await browser.close();
process.exit(errors.length ? 1 : 0);
