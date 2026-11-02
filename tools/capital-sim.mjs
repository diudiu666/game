/**
 * 无头对局：量「首都 + 战损」到底把节奏改成什么样。
 *
 * 用法: node tools/capital-sim.mjs [局数]
 * 输出：结束方式分布 / 平均时长 / 斩首发生频率与时机 / 座位胜率 / 领地曲线
 */
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

const GAMES = Number(process.argv[2] || 30);
const dt = 1 / 30;

const reason = {};
const seatWin = [0, 0, 0, 0];
const durations = [];
const capsCurve = []; // 每局每个 30 秒点的「剩余都城数」
let capitalHits = 0;
let gamesWithCapitalHit = 0;
let firstCapTime = [];
let regionTotal = 0;
let ghost = 0;

for (let g = 0; g < GAMES; g++) {
  const seed = 90001 + g * 7919;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState(map, {
    seed,
    endOnHumansOut: false,
    seats: [
      { name: 'A', isBot: true },
      { name: 'B', isBot: true },
      { name: 'C', isBot: true },
      { name: 'D', isBot: true },
    ],
  });
  Game.startGame(st);

  const curve = [];
  let nextSample = 0;
  let hits = 0;
  let firstHit = -1;
  let guard = 0;

  while (st.phase === 'playing' && guard++ < 40000) {
    Game.step(st, dt);
    Game.botTick(st, st.elapsed);

    for (const ev of st.events) {
      if (ev.type === 'capital') {
        hits++;
        if (firstHit < 0) firstHit = st.elapsed;
      }
    }
    st.events.length = 0;

    if (st.elapsed >= nextSample) {
      curve.push(st.regions.filter((r) => r.capitalOf >= 0).length);
      nextSample += 30;
    }
  }

  reason[st.endReason || 'running'] = (reason[st.endReason || 'running'] || 0) + 1;
  durations.push(st.elapsed);
  if (st.winner !== null && st.winner >= 0) seatWin[st.winner]++;
  capsCurve.push(curve);
  capitalHits += hits;
  if (hits) gamesWithCapitalHit++;
  if (firstHit >= 0) firstCapTime.push(firstHit);
  regionTotal += st.regions.filter((r) => r.owner === null).length;
  if (st.players.some((p) => p.alive && p.regionCount === 0)) ghost++;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log(`\n样本 ${GAMES} 局（4 个 AI，全 AI 对局）`);
console.log('\n结束方式：');
for (const [k, v] of Object.entries(reason)) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(3)} 局  ${((v / GAMES) * 100).toFixed(0)}%`);
}
const elim = (reason.elimination || 0) + (reason.capital || 0);
console.log(`  淘汰类合计   ${elim} 局  ${((elim / GAMES) * 100).toFixed(0)}%`);
console.log(`\n平均时长 ${avg(durations).toFixed(0)} 秒（中位 ${median(durations).toFixed(0)} 秒，上限 ${Game.CONFIG.duration}）`);
console.log(`\n斩首：${capitalHits} 次 / ${GAMES} 局，${gamesWithCapitalHit} 局出现过斩首（${((gamesWithCapitalHit / GAMES) * 100).toFixed(0)}%）`);
if (firstCapTime.length) {
  console.log(`  首次斩首平均在第 ${avg(firstCapTime).toFixed(0)} 秒（最早 ${Math.min(...firstCapTime).toFixed(0)}s，最晚 ${Math.max(...firstCapTime).toFixed(0)}s）`);
}
console.log(`\n座位胜场 ${seatWin.join(' / ')}（越平均越公平）`);
console.log(`平均剩余中立区 ${(regionTotal / GAMES).toFixed(1)} / 62`);
console.log(`0 地仍存活（幽灵）：${ghost} 局`);

// 剩余都城曲线：看灭国是「慢慢发生」还是「最后一把全崩」
console.log('\n剩余都城数随时间（0/30/60/…秒）');
const maxLen = Math.max(...capsCurve.map((c) => c.length));
const row = [];
for (let i = 0; i < maxLen; i++) {
  const vals = capsCurve.map((c) => c[i]).filter((v) => v !== undefined);
  row.push(`${i * 30}s:${avg(vals).toFixed(2)}`);
}
console.log('  ' + row.join('  '));
