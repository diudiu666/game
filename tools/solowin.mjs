/** 复现：单人模式把人机全清空 / 占满全图后，客户端到底有没有结算提示 */
import { launch } from './lib/harness.mjs';

const browser = await launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

await page.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('#btnLocal', { timeout: 20000 });
await page.click('#btnLocal');
await page.waitForSelector('#btnStart');
await page.click('#btnStart');
await page.waitForFunction(() => window.__game?.mode === 'solo' && window.__game.state.phase === 'playing');

// 一步步（每帧一次）把能打的地全打下来，走真实 attack 路径
const trace = [];
for (let step = 0; step < 80; step++) {
  const res = await page.evaluate(() => {
    const s = window.__game.state;
    const me = s.viewIndex;
    if (s.phase !== 'playing') {
      return { done: true, phase: s.phase, owned: s.players[me].regionCount, total: s.regions.length };
    }
    s.players[me].troops = 9999;
    for (const r of s.regions) {
      if (r.owner === me) continue;
      if (!r.neighbors.some((n) => s.regions[n].owner === me)) continue;
      const out = window.__probe.attack(s, me, r.id);
      if (out.ok) {
        return {
          done: false,
          owned: s.players[me].regionCount,
          neutral: s.regions.filter((x) => x.owner === null).length,
          alive: s.players.filter((p) => p.alive).length,
          phase: s.phase,
        };
      }
    }
    return { stuck: true, owned: s.players[me].regionCount, phase: s.phase, neutral: s.regions.filter((x) => x.owner === null).length };
  });
  trace.push(res);
  if (res.done || res.stuck) break;
  await page.waitForTimeout(40); // 留一帧给 drainEvents
}

await page.waitForTimeout(1400);
const final = await page.evaluate(() => {
  const s = window.__game.state;
  const card = document.getElementById('card');
  return {
    phase: s.phase,
    winner: s.winner,
    owned: s.players[s.viewIndex].regionCount,
    total: s.regions.length,
    neutral: s.regions.filter((r) => r.owner === null).length,
    aliveFlags: s.players.map((p) => ({ n: p.regionCount, alive: p.alive })),
    overlayOff: document.getElementById('overlay').classList.contains('off'),
    cardTitle: (card.querySelector('h1')?.textContent || '').trim(),
    cardSub: (card.querySelector('.sub')?.textContent || '').trim(),
    eventsLeft: s.events.length,
    endReason: (window.__game.endish || null),
  };
});
await page.screenshot({ path: 'shots/solo-win.png' });

// 第二轮：模拟「ended 事件丢了」——只把状态改成 ended，不给事件，看结算卡会不会自己弹出来
await page.click('#btnRestart');
await page.waitForFunction(() => window.__game.state.phase === 'playing');
await page.evaluate(() => {
  const s = window.__game.state;
  s.phase = 'ended';
  s.winner = 0;
  s.endReason = 'conquer';
});
await page.waitForTimeout(1300);
const fallback = await page.evaluate(() => {
  const card = document.getElementById('card');
  return {
    overlayOff: document.getElementById('overlay').classList.contains('off'),
    title: (card.querySelector('h1')?.textContent || '').trim(),
    sub: (card.querySelector('.sub')?.textContent || '').trim(),
  };
});
await page.screenshot({ path: 'shots/solo-win-fallback.png' });

const last = trace[trace.length - 1];
console.log('最后一步:', JSON.stringify(last));
console.log('结束状态:', JSON.stringify(final, null, 1));
console.log('丢事件兜底:', JSON.stringify(fallback));
console.log('步数:', trace.length);
console.log(errors.length ? '错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
