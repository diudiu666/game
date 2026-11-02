/**
 * 验收：玩家名牌是否出现在自己的地盘上、字号是否跟着地盘变大。
 * 用法: node tools/nameplates.mjs [baseUrl]
 */
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5173';
const exe = join(homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));

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
await page.screenshot({ path: 'shots/names-start.png' });

const snap = () =>
  page.evaluate(() => ({
    labels: window.__probe.world.labelDebug(),
    players: window.__game.state.players.map((p) => ({ name: p.name, w: +p.weight.toFixed(1) })),
  }));

const atStart = await snap();
console.log('开局名牌:', JSON.stringify(atStart.labels));
console.log('开局权重:', JSON.stringify(atStart.players));

// 让「你」连吃一片地，看名字会不会长大
await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  s.players[me].troops = 9999;
});
for (let i = 0; i < 26; i++) {
  const ok = await page.evaluate(() => {
    const s = window.__game.state;
    const me = s.viewIndex;
    s.players[me].troops = 9999;
    for (const r of s.regions) {
      if (r.owner === me) continue;
      if (!r.neighbors.some((n) => s.regions[n].owner === me)) continue;
      return window.__probe.attack(s, me, r.id).ok;
    }
    return false;
  });
  await sleep(120);
  if (!ok) break;
}
await sleep(1500);
await page.screenshot({ path: 'shots/names-grown.png' });
const grown = await snap();
console.log('扩张后名牌:', JSON.stringify(grown.labels));
console.log('扩张后权重:', JSON.stringify(grown.players));

const myName = atStart.players[0].name;
const meBefore = atStart.labels.find((l) => l.text === myName);
const meAfter = grown.labels.find((l) => l.text === myName);
console.log(
  meAfter && meBefore && meAfter.h > meBefore.h
    ? `✓ 名字随地盘变大：${meBefore.h} → ${meAfter.h}`
    : `✗ 名字没有变大：${JSON.stringify([meBefore, meAfter])}`
);

// 手机竖屏
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
m.on('pageerror', (e) => errors.push('[m] ' + e.message));
await m.goto(BASE, { waitUntil: 'networkidle' });
await m.waitForSelector('#btnLocal', { timeout: 20000 });
await m.click('#btnLocal');
await m.waitForSelector('#btnStart', { timeout: 20000 });
await m.click('#btnStart');
await sleep(3000);
await m.screenshot({ path: 'shots/names-mobile.png' });
const mobileLabels = await m.evaluate(() => {
  const w = window.innerWidth, h = window.innerHeight;
  return window.__probe.world.labelDebug().map((l) => ({
    ...l,
    inside: !!l.rect && l.rect[0] >= -1 && l.rect[1] >= -1 && l.rect[2] <= w + 1 && l.rect[3] <= h + 1,
  }));
});
console.log('手机端名牌:', JSON.stringify(mobileLabels));
const clipped = mobileLabels.filter((l) => !l.inside);
console.log(clipped.length ? '✗ 有名字超出屏幕: ' + JSON.stringify(clipped.map((l) => l.text)) : '✓ 手机端没有名字被裁切');

console.log(errors.length ? '错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
