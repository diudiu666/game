/**
 * tools/roomflow.mjs —— 房间流程验收
 * 3 人开局 → 中途进第 4 人（观战）→ 结算回房间（第 4 人补位）→ 第二局 4 真人
 * 需要 TD_DURATION=15 的服务器。
 */

import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5175';
const exe = join(homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const VIEW = { width: 820, height: 560 };

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function open(url) {
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

async function waitSeats(page, n, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const c = await page.$$eval('.seat.filled', (e) => e.length).catch(() => 0);
    if (c >= n || Date.now() - t0 > ms) return c;
    await sleep(300);
  }
}

const p0 = await open(BASE);
await p0.waitForSelector('#roomCodeText');
const code = (await p0.textContent('#roomCodeText')).trim();
console.log('房间号', code);

const p1 = await open(`${BASE}/?room=${code}`);
const p2 = await open(`${BASE}/?room=${code}`);
console.log('大厅人数', await waitSeats(p0, 3));

await p0.click('#btnStart');
for (let i = 0; i < 40; i++) {
  await sleep(400);
  if ((await p0.evaluate(() => window.__game.state?.phase)) === 'playing') break;
}
console.log('开局', await p0.evaluate(() => window.__game.state.players.map((p) => p.name + (p.isBot ? '(AI)' : ''))));

// 第 4 人中途进来
const p3 = await open(`${BASE}/?room=${code}`);
for (let i = 0; i < 50; i++) {
  await sleep(400);
  if (await p3.evaluate(() => window.__game.spectator).catch(() => false)) break;
}
console.log('中途进来', await p3.evaluate(() => ({ spec: window.__game.spectator, text: document.getElementById('spec').textContent })));
if (!(await p3.evaluate(() => window.__game.spectator))) errors.push('第 4 人没有被安排观战');
await p3.screenshot({ path: 'shots/r1-watcher.png' });

// 等结算
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const over = await p0.evaluate(() => !document.getElementById('overlay').classList.contains('off'));
  if (over) break;
}
console.log('结算出现');
await p0.click('#btnRestart');
const n = await waitSeats(p0, 4);
console.log('回到大厅人数', n);
if (n !== 4) errors.push(`观战者没有被补进座位（${n}/4）`);
await p0.screenshot({ path: 'shots/r2-lobby4.png' });

// 第二局：4 个真人
await p0.click('#btnStart');
for (let i = 0; i < 40; i++) {
  await sleep(400);
  if ((await p0.evaluate(() => window.__game.state?.phase)) === 'playing') break;
}
const lineup = await p0.evaluate(() => window.__game.state.players.map((p) => (p.isBot ? 'AI' : '人')));
console.log('第二局阵容', lineup.join('/'));
if (lineup.filter((x) => x === '人').length !== 4) errors.push('第二局不是 4 个真人：' + lineup.join('/'));
await p0.screenshot({ path: 'shots/r3-full4.png' });

console.log(errors.length ? '\n错误:\n' + errors.join('\n') : '\n全部通过');
await browser.close();
process.exit(errors.length ? 1 : 0);
