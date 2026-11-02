/**
 * tools/mplay.mjs —— 多客户端联机验收
 * 起 2~4 个独立浏览器上下文进同一房间，验证大厅 / 开局 / 同步 / 抢地 / 观战。
 *
 * 用法: node tools/mplay.mjs [players=3] [base=http://localhost:5173]
 */

import { launch } from './lib/harness.mjs';
import { mkdirSync } from 'node:fs';

const N = Number(process.argv[2] || 3);
const BASE = process.argv[3] || 'http://localhost:5173';
mkdirSync('shots', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const VIEW = { width: 900, height: 620 };
const sleep2 = sleep;

/** 等到页面上凑齐 n 个座位（软件渲染下多开很慢，只能轮询） */
async function waitSeats(page, n, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const c = await page.$$eval('.seat.filled', (els) => els.length).catch(() => 0);
    if (c >= n) return c;
    if (Date.now() - t0 > ms) return c;
    await sleep2(300);
  }
}

const pages = [];
const errors = [];

// 房主先进，拿到邀请码
const ctx0 = await browser.newContext({ viewport: VIEW });
const first = await ctx0.newPage();
first.on('pageerror', (e) => errors.push(`[P0] ${e.message}`));
first.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[P0] console: ${m.text()}`);
});
await first.goto(BASE, { waitUntil: 'networkidle' });
pages.push(first);
await first.waitForSelector('#roomCodeText', { timeout: 8000 });
const code = (await first.textContent('#roomCodeText')).trim();
console.log('房间号', code);

// 其余人用邀请链接进来
for (let i = 1; i < N; i++) {
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[P${i}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[P${i}] console: ${m.text()}`);
  });
  await page.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
  pages.push(page);
}
await waitSeats(first, N);

await sleep(600);
const seats = await pages[0].$$eval('.seat.filled .sn', (els) => els.map((e) => e.textContent));
if (seats.length !== N) errors.push(`大厅只坐到 ${seats.length}/${N} 人`);
console.log('大厅座位', JSON.stringify(seats));
await pages[0].screenshot({ path: 'shots/net1-lobby.png' });

// 2. 开局
await pages[0].click('#btnStart');
await sleep(700);
await pages[0].screenshot({ path: 'shots/net2-countdown.png' });
await sleep(3400);

const info = [];
for (const p of pages) {
  info.push(
    await p.evaluate(() => ({
      mode: window.__game.mode,
      phase: window.__game.state?.phase,
      you: window.__game.state?.viewIndex,
      players: window.__game.state?.players.length,
      regions: window.__game.state?.regions.length,
      owned: window.__game.state?.regions.filter((r) => r.owner !== null).length,
      spec: window.__game.spectator,
    }))
  );
}
console.log('开局状态', JSON.stringify(info[0]));
info.forEach((x, i) => {
  if (x.phase !== 'playing') errors.push(`P${i} 未进入对局: ${JSON.stringify(x)}`);
});

await sleep(1200);
await pages[0].screenshot({ path: 'shots/net3-play.png' });

// 3. 各自占一块地，验证另一端能看到
for (let i = 0; i < pages.length; i++) {
  const res = await pages[i].evaluate(() => {
    const s = window.__game.state;
    const me = s.viewIndex;
    const targets = [];
    for (const r of s.regions) {
      if (r.owner !== me) continue;
      for (const n of r.neighbors) {
        if (s.regions[n].owner !== me) targets.push(n);
      }
    }
    return { me, target: targets[0] ?? -1, troops: s.players[me].troops };
  });
  if (res.target < 0) continue;
  await pages[i].evaluate((t) => window.__game.send({ t: 'attack', id: t }), res.target);
  await sleep(350);
  const ok = await pages[0].evaluate((t) => window.__game.state.regions[t].owner, res.target);
  console.log(`P${i} 攻击 #${res.target} → 全房看到 owner=${ok}`);
  if (ok === -1 || ok === undefined) errors.push(`P${i} 的占领没有同步`);
}

await sleep(400);
await pages[0].screenshot({ path: 'shots/net4-owned.png' });

// 4. 刷新页面重连（真断线：socket 关闭 + 同 token 续座）
await pages[1].reload({ waitUntil: 'networkidle' });
let back = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  back = await pages[1]
    .evaluate(() => ({
      phase: window.__game.state?.phase,
      you: window.__game.state?.viewIndex,
      bot: window.__game.state?.players[window.__game.state?.viewIndex]?.isBot,
      spec: window.__game.spectator,
    }))
    .catch(() => null);
  if (back?.phase === 'playing') break;
}
console.log('刷新重连后', JSON.stringify(back));
if (back?.phase !== 'playing' || back?.you !== 1) errors.push('重连没有续上原座位：' + JSON.stringify(back));
if (back?.spec) errors.push('重连后被当成观战');
await pages[1].screenshot({ path: 'shots/net4-reconnect.png' });

// 5. 观战：第 5 个人进同一个房间
const extra = await browser.newContext({ viewport: VIEW });
const extraPage = await extra.newPage();
extraPage.on('pageerror', (e) => errors.push(`[spec] ${e.message}`));
await extraPage.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const ok = await extraPage.evaluate(() => window.__game.spectator).catch(() => false);
  if (ok) break;
}
const specState = await extraPage.evaluate(() => ({
  spec: window.__game.spectator,
  phase: window.__game.state?.phase,
  regions: window.__game.state?.regions.length,
  text: document.getElementById('spec').textContent,
}));
console.log('观战者', JSON.stringify(specState));
if (!specState.spec) errors.push('第 5 人没有被安排成观战');
await extraPage.screenshot({ path: 'shots/net5-spectator.png' });

console.log(errors.length ? `\n错误 ${errors.length} 条:\n` + errors.join('\n') : '\n无错误');
await browser.close();
process.exit(errors.length ? 1 : 0);
