/**
 * tools/endgame.mjs —— 整局流程验收
 * 用 TD_DURATION=25 的服务器跑完整一局：倒计时 → 对局 → 结算 → 回房间 → 再开一局。
 */

import { launch } from './lib/harness.mjs';

const BASE = process.argv[2] || 'http://localhost:5175';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const log = (...a) => console.log(...a);

const browser = await launch({  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const VIEW = { width: 900, height: 620 };

const c0 = await browser.newContext({ viewport: VIEW });
const p0 = await c0.newPage();
p0.on('pageerror', (e) => errors.push('[P0] ' + e.message));
await p0.goto(BASE, { waitUntil: 'networkidle' });
await p0.waitForSelector('#roomCodeText');
const code = (await p0.textContent('#roomCodeText')).trim();
log('房间号', code);

const c1 = await browser.newContext({ viewport: VIEW });
const p1 = await c1.newPage();
p1.on('pageerror', (e) => errors.push('[P1] ' + e.message));
await p1.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });

for (let i = 0; i < 40; i++) {
  await sleep(400);
  const n = await p0.$$eval('.seat.filled', (e) => e.length).catch(() => 0);
  if (n >= 2) break;
}
log('大厅人数', await p0.$$eval('.seat.filled', (e) => e.length));

// 开局
await p0.click('#btnStart');
await sleep(1200);
const cd = await p0.evaluate(() => ({
  txt: document.getElementById('countdown').textContent,
  hidden: document.getElementById('countdown').classList.contains('hidden'),
}));
log('倒计时', JSON.stringify(cd));
await p0.screenshot({ path: 'shots/e1-countdown.png' });

// 等开局
for (let i = 0; i < 40; i++) {
  await sleep(400);
  const ph = await p0.evaluate(() => window.__game.state?.phase);
  if (ph === 'playing') break;
}
const firstStart = await p0.evaluate(() => ({ p: window.__game.state.phase, t: Math.round(window.__game.state.time) }));
log('开局', JSON.stringify(firstStart));

// 打几块地，制造点战况
for (let round = 0; round < 12; round++) {
  for (const p of [p0, p1]) {
    await p.evaluate(() => {
      const s = window.__game.state;
      const me = s.viewIndex;
      const cand = [];
      for (const r of s.regions) {
        if (r.owner !== me) continue;
        for (const n of r.neighbors) if (s.regions[n].owner !== me) cand.push(n);
      }
      if (cand.length) window.__game.send({ t: 'attack', id: cand[0] });
    });
    await sleep(120);
  }
  await sleep(700);
}
await p0.screenshot({ path: 'shots/e2-mid.png' });
log('中盘', await p0.evaluate(() => window.__game.state.players.map((p) => p.regionCount)));

// 等结算
let ended = null;
for (let i = 0; i < 60; i++) {
  await sleep(700);
  ended = await p0
    .evaluate(() => ({
      phase: window.__game.state?.phase,
      overlay: !document.getElementById('overlay').classList.contains('off'),
      title: document.querySelector('#card h1')?.textContent,
      rows: document.querySelectorAll('#endStats .srow').length,
      btn: document.getElementById('btnRestart')?.textContent,
    }))
    .catch(() => null);
  if (ended?.overlay && ended.rows > 0) break;
}
log('结算', JSON.stringify(ended));
if (ended?.rows !== 4) errors.push('结算名次表不是 4 行：' + JSON.stringify(ended));
await p0.screenshot({ path: 'shots/e3-end.png' });
await p1.screenshot({ path: 'shots/e3-end-p1.png' });

// 回房间 → 再开一局
await p0.click('#btnRestart');
let lobby = null;
for (let i = 0; i < 30; i++) {
  await sleep(400);
  lobby = await p0.evaluate(() => ({
    code: document.getElementById('roomCodeText')?.textContent,
    phase: window.__game.state?.phase,
  }));
  if (lobby.code) break;
}
log('回到房间', JSON.stringify(lobby));
if (!lobby?.code) errors.push('结算后没有回到大厅');
await p0.screenshot({ path: 'shots/e4-lobby.png' });

// 第二局能否正常开始（验证房间状态被重置干净）
await p0.click('#btnStart');
let second = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  second = await p0
    .evaluate(() => ({
      phase: window.__game.state?.phase,
      time: Math.round(window.__game.state?.time || 0),
      owned: window.__game.state?.regions.filter((r) => r.owner !== null).length,
    }))
    .catch(() => null);
  if (second?.phase === 'playing') break;
}
log('第二局', JSON.stringify(second));
if (second?.phase !== 'playing') errors.push('第二局没能开始');
if (second && second.time < firstStart.t - 2) errors.push(`第二局计时没有重置：${second.time}（首局 ${firstStart.t}）`);

console.log(errors.length ? `\n错误:\n${errors.join('\n')}` : '\n全部通过');
await browser.close();
process.exit(errors.length ? 1 : 0);
