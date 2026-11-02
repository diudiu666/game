/**
 * 参数扫描：想找出「既不会开局就被斩首、又能真的打死人」的组合。
 *
 * 用法: node tools/capsweep.mjs [每组局数]
 * 改动只发生在进程内（直接改 CONFIG 的属性），不会写回文件。
 */
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

const GAMES = Number(process.argv[2] || 10);
const dt = 1 / 30;
const SEEDS = Array.from({ length: GAMES }, (_, i) => 90001 + i * 7919);
const maps = SEEDS.map((seed) => generateRegions({ seed, count: 62, radius: 46 }));

function run(cfg) {
  Object.assign(Game.CONFIG, cfg);
  let elim = 0;
  let capHits = 0;
  let gamesWithElim = 0;
  const spreads = [];
  const durs = [];
  const firstHit = [];

  for (let g = 0; g < GAMES; g++) {
    const st = Game.createState(maps[g], {
      seed: SEEDS[g],
      endOnHumansOut: false,
      seats: [
        { name: 'A', isBot: true },
        { name: 'B', isBot: true },
        { name: 'C', isBot: true },
        { name: 'D', isBot: true },
      ],
    });
    Game.startGame(st);
    let guard = 0;
    let hits = 0;
    let first = -1;
    while (st.phase === 'playing' && guard++ < 40000) {
      Game.step(st, dt);
      Game.botTick(st, st.elapsed);
      for (const ev of st.events) {
        if (ev.type === 'capital') {
          hits++;
          if (first < 0) first = st.elapsed;
        }
      }
      st.events.length = 0;
    }
    const counts = st.players.map((p) => p.regionCount).sort((a, b) => a - b);
    spreads.push(counts[3] - counts[0]);
    if (st.endReason === 'elimination' || st.endReason === 'capital') elim++;
    if (hits) gamesWithElim++;
    if (first >= 0) firstHit.push(first);
    capHits += hits;
    durs.push(st.elapsed);
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    elimPct: ((elim / GAMES) * 100).toFixed(0),
    hitPct: ((gamesWithElim / GAMES) * 100).toFixed(0),
    capHits,
    spread: avg(spreads).toFixed(1),
    dur: avg(durs).toFixed(0),
    first: firstHit.length ? avg(firstHit).toFixed(0) : '-',
    earliest: firstHit.length ? Math.min(...firstHit).toFixed(0) : '-',
  };
}

const GRID = [
  { name: '都城1.5+战损1.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 1.5, capitalHunt: 2.4 },
  { name: '都城1.6+战损1.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 1.6, capitalHunt: 2.4 },
  { name: '都城1.8+战损1.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 1.8, capitalHunt: 2.4 },
  { name: '都城2.0+战损1.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 2.0, capitalHunt: 2.4 },
  { name: '都城1.8+战损1.0+猎2.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 1.8, capitalHunt: 2.0 },
  { name: '都城1.8+战损1.0+猎3.0', lossRatio: 1.0, antiLeader: 1.5, capitalDefense: 1.8, capitalHunt: 3.0 },
  { name: '都城1.8+战损0.8', lossRatio: 0.8, antiLeader: 1.5, capitalDefense: 1.8, capitalHunt: 2.4 },
  { name: '都城1.8+战损1.2', lossRatio: 1.2, antiLeader: 1.5, capitalDefense: 1.8, capitalHunt: 2.4 },
];

console.log(
  '配置'.padEnd(24),
  '淘汰局%',
  '出现斩首%',
  '斩首次数',
  '领地极差',
  '平均时长',
  '首次斩首',
  '最早'
);
for (const cfg of GRID) {
  const r = run(cfg);
  console.log(
    cfg.name.padEnd(24),
    String(r.elimPct).padStart(6),
    String(r.hitPct).padStart(8),
    String(r.capHits).padStart(8),
    String(r.spread).padStart(8),
    String(r.dur).padStart(8),
    String(r.first).padStart(8),
    String(r.earliest).padStart(6)
  );
}
