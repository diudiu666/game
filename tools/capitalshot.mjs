/**
 * 浏览器验收：首都标记 / 都市面板 / 斩首横幅
 *
 * 用法: node tools/capitalshot.mjs [base]
 * 产出: shots/capital-start.png、capital-inspect.png、capital-coup.png、capital-after.png
 *
 * 说明：斩首要用「改本地状态再点」的方式复现，那只有单人局是客户端权威，
 *      所以前半段在联机房间里验同步，后半段切单人局验表现。
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));

// 随机房号自建房间：否则「快速匹配」会把我们塞进别人没散的大厅，当不上房主就没有开始按钮
const code = 'K' + Math.random().toString(36).slice(2, 5).toUpperCase();
await page.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#btnStart', { timeout: 25000 });

/* ---------- A. 联机房间：首都信息确实同步到客户端 ---------- */
await page.click('#btnStart');
for (let i = 0; i < 60; i++) {
  await sleep(300);
  if (await page.evaluate(() => window.__game.state?.phase === 'playing')) break;
}
const sync = await page.evaluate(() => {
  const s = window.__game.state;
  return {
    capitals: s.regions.filter((r) => r.capitalOf >= 0).map((r) => `${r.id}→P${r.capitalOf}`),
    markers: window.__probe.world.capitalCount(),
    playersCapital: s.players.map((p) => p.capital),
    capitalLost: s.players.map((p) => p.capitalLost),
  };
});
console.log('联机同步：', JSON.stringify(sync));
await page.screenshot({ path: 'shots/capital-start.png' });

/* ---------- B. 单人局：悬停看面板 ---------- */
// 先退出房间，否则服务端还在往这里推快照
await page.evaluate(() => window.__game.net?.send({ t: 'leave' }));
await sleep(300);
await page.evaluate(() => window.__game.startSolo());
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if (await page.evaluate(() => window.__game.mode === 'solo' && window.__game.state?.phase === 'playing')) break;
}

const hover = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.players[s.viewIndex];
  const r = s.regions[me.capital];
  const p = window.__probe.project(r.center.x, r.height, r.center.y);
  return { x: Math.round(p.x), y: Math.round(p.y) };
});
await page.mouse.move(hover.x, hover.y);
await sleep(400);
const inspect = await page.evaluate(() => {
  const el = document.getElementById('inspect');
  return {
    shown: el.classList.contains('show'),
    capital: el.classList.contains('capital'),
    owner: document.getElementById('insOwner').textContent,
    badge: !document.getElementById('insCap').classList.contains('hidden'),
    def: document.getElementById('insDef').textContent,
  };
});
console.log('我的都城面板：', JSON.stringify(inspect));
await page.screenshot({ path: 'shots/capital-inspect.png' });

/* ---------- C. 斩首 ---------- */
const setup = await page.evaluate(() => {
  const s = window.__game.state;
  const me = s.viewIndex;
  const victim = s.players.find((p) => p.index !== me && p.alive && p.capital >= 0);
  const cap = s.regions[victim.capital];
  s.regions[cap.neighbors[0]].owner = me;
  s.players[me].troops = 9999;
  return { victim: victim.index, capId: cap.id, x: cap.center.x, y: cap.center.y, h: cap.height };
});
await sleep(150);
const pt = await page.evaluate((v) => window.__probe.project(v.x, v.h, v.y), setup);
await page.mouse.move(pt.x, pt.y);
await sleep(160);
await page.mouse.down();
await page.mouse.up();
await sleep(420);

const coup = await page.evaluate(() => {
  const s = window.__game.state;
  const el = document.getElementById('coup');
  return {
    banner: el.classList.contains('show'),
    text: el.querySelector('.word').textContent.replace(/\s+/g, ' ').trim(),
    impact: document.getElementById('impact').className,
    alive: s.players.map((p) => p.alive),
    capitalLost: s.players.map((p) => p.capitalLost),
    markers: window.__probe.world.capitalCount(),
    capitalsLeft: s.regions.filter((r) => r.capitalOf >= 0).length,
    toast: [...document.querySelectorAll('.toast')].map((d) => d.textContent).join(' | '),
    log: [...document.querySelectorAll('.logline')].map((d) => d.textContent).join(' | '),
    effects: window.__probe.world.effectCount(),
  };
});
console.log('斩首瞬间：', JSON.stringify(coup));
await page.screenshot({ path: 'shots/capital-coup.png' });

await sleep(1800);
const after = await page.evaluate(() => ({
  banner: document.getElementById('coup').classList.contains('show'),
  markers: window.__probe.world.capitalCount(),
  capitalsLeft: window.__game.state.regions.filter((r) => r.capitalOf >= 0).length,
  neutral: window.__game.state.regions.filter((r) => r.owner === null).length,
}));
console.log('1.8 秒后：', JSON.stringify(after));
await page.screenshot({ path: 'shots/capital-after.png' });

console.log(errors.length ? '页面错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
