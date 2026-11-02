/**
 * 复现：「加上名牌以后，有格子被盖住点不到」
 *
 * 做法：在每块名牌的屏幕矩形里做网格采样，逐点问 world.pick()
 *   - 拿到 -1  = 那个像素下面没有地块（真·点不到）
 *   - 拿到地块 = 射线穿过了名牌，点击逻辑正常（只是被挡住了看不见）
 * 再挑几个「名牌下面的地块」，走真实的指针按下/抬起，确认攻击真的发出去。
 *
 * 用法: node tools/labelclick.mjs [baseUrl]
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
await sleep(1500);

// 1) 名牌矩形内网格采样
const report = await page.evaluate(() => {
  const w = window.__probe.world;
  const labels = w.labelDebug();
  const out = [];
  for (const l of labels) {
    if (!l.rect) continue;
    const [x0, y0, x1, y1] = l.rect;
    let hit = 0, miss = 0, own = 0;
    const owners = new Set();
    const cols = 7, rows = 5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + ((c + 0.5) / cols) * (x1 - x0);
        const y = y0 + ((r + 0.5) / rows) * (y1 - y0);
        const id = w.pick(x, y);
        if (id < 0) { miss++; continue; }
        hit++;
        const p = window.__game.state.regions[id].owner;
        owners.add(p === null ? 'neutral' : p);
        if (p === window.__game.state.viewIndex) own++;
      }
    }
    out.push({ text: l.text, rect: l.rect, hit, miss, own, owners: [...owners] });
  }
  return out;
});

console.log('=== 名牌矩形内的拾取采样（7×5 网格）===');
let totalMiss = 0, totalHit = 0;
for (const r of report) {
  totalMiss += r.miss;
  totalHit += r.hit;
  console.log(
    `${r.text.padEnd(8)} 矩形[${r.rect.join(',')}] 命中 ${r.hit} / 空 ${r.miss}` +
      `  | 落点归属: ${r.owners.join(',')}`
  );
}
console.log(`合计: 命中 ${totalHit} 像素点，空 ${totalMiss} 像素点`);

// 1.5) 指针压到名牌上时，名牌必须让开（淡出），否则会一直盖住底下的格子
const big = report.slice().sort((a, b) => (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]))[0];
if (big) {
  const cx = Math.round((big.rect[0] + big.rect[2]) / 2);
  const cy = Math.round((big.rect[1] + big.rect[3]) / 2);
  const idle = await page.evaluate(() => window.__probe.world.labelDebug().map((l) => l.alpha));
  await page.screenshot({ path: "shots/label-normal.png" });
  await page.mouse.move(cx, cy);
  await sleep(600);
  const hov = await page.evaluate(
    (t) => window.__probe.world.labelDebug().find((l) => l.text === t)?.alpha,
    big.text
  );
  await page.screenshot({ path: "shots/label-hover.png" });
  await page.mouse.move(20, 20);
  await sleep(600);
  const back = await page.evaluate(
    (t) => window.__probe.world.labelDebug().find((l) => l.text === t)?.alpha,
    big.text
  );
  console.log(`\n=== 名牌让路 ===`);
  console.log(`常态 alpha 样本: ${JSON.stringify(idle.slice(0, 4))}`);
  console.log(`指针压在「${big.text}」上: ${hov} → 移开: ${back}`);
  console.log(hov !== null && hov < 0.3 && back > 0.6 ? '✓ 压住时淡出、移开恢复' : '✗ 淡出逻辑没生效');
}

// 2) 找一块「名牌正下方、属于别人、且与我接壤」的地，用真实鼠标点击
const target = await page.evaluate(() => {
  const s = window.__game.state;
  const w = window.__probe.world;
  const me = s.viewIndex;
  const labels = w.labelDebug().filter((l) => l.rect);
  for (const l of labels) {
    const [x0, y0, x1, y1] = l.rect;
    for (let i = 1; i < 6; i++) {
      for (let j = 1; j < 4; j++) {
        const x = x0 + (i / 6) * (x1 - x0);
        const y = y0 + (j / 4) * (y1 - y0);
        const id = w.pick(x, y);
        if (id < 0) continue;
        const r = s.regions[id];
        if (r.owner === me) continue;
        if (!r.neighbors.some((n) => s.regions[n].owner === me)) continue;
        return { x: Math.round(x), y: Math.round(y), id, underLabel: l.text };
      }
    }
  }
  return null;
});

if (!target) {
  console.log('✗ 没找到「名牌下方 + 接壤 + 非我方」的地块，无法做点击测试');
} else {
  console.log(`\n=== 真实点击：名牌「${target.underLabel}」下面的地块 #${target.id} @ (${target.x},${target.y}) ===`);
  const before = await page.evaluate((id) => {
    const s = window.__game.state;
    s.players[s.viewIndex].troops = 9999;
    return { owner: s.regions[id].owner, troops: s.players[s.viewIndex].troops };
  }, target.id);

  await page.mouse.click(target.x, target.y);
  await sleep(500);

  const after = await page.evaluate((id) => {
    const s = window.__game.state;
    return {
      owner: s.regions[id].owner,
      troops: s.players[s.viewIndex].troops,
      toast: [...document.querySelectorAll('.toast')].map((d) => d.textContent).join('|'),
    };
  }, target.id);

  const ok = after.owner === (await page.evaluate(() => window.__game.state.viewIndex));
  console.log(`点击前归属 ${before.owner} / 兵力 ${Math.round(before.troops)}`);
  console.log(`点击后归属 ${after.owner} / 兵力 ${Math.round(after.troops)} / toast「${after.toast}」`);
  console.log(ok ? '✓ 名牌下方的地块点击有效（射线穿过了名牌）' : '✗ 击穿名牌后点击被吞掉');
}

console.log(errors.length ? '错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
