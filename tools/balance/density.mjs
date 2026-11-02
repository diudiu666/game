import { generateRegions } from '../../src/mapgen.js';
import * as Game from '../../src/game.js';

const DT = 1 / 30;

/* 1) 操作密度：每 20 秒发生了多少次「占地区域」的动作（全 AI 局） */
function density(seed) {
  const { regions, radius } = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState({ regions, radius }, { seed, playerCount: 4, endOnHumansOut: false });
  for (const p of st.players) p.isBot = true;
  Game.startGame(st);
  const buckets = new Array(16).fill(0); // 0..320s, 20s each
  const elim = [];
  let now = 0;
  while (st.phase === 'playing' && now < 320) {
    Game.step(st, DT);
    Game.botTick(st, now);
    for (const ev of st.events) {
      if (ev.type === 'attack') buckets[Math.min(15, Math.floor(now / 20))]++;
      if (ev.type === 'eliminated') elim.push(+now.toFixed(0));
    }
    st.events.length = 0;
    now += DT;
  }
  const perPlayerPer20s = buckets.map((b) => +(b / 4).toFixed(1));
  return { seed, per20s: buckets, perPlayerPer20s, elim, totalAttacks: buckets.reduce((a, b) => a + b, 0) };
}

/* 2) 快照体积 */
function snapSize(seed) {
  const { regions, radius } = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState({ regions, radius }, { seed, playerCount: 4, endOnHumansOut: false });
  Game.startGame(st);
  Game.step(st, 1);
  const snap = {
    t: 'state', tick: 120, phase: st.phase, time: 299.5, elapsed: 0.5, winner: null,
    owners: st.regions.map((r) => (r.owner === null ? -1 : r.owner)),
    players: st.players.map((p) => ({
      name: p.name, color: p.color, alive: p.alive, weight: +p.weight.toFixed(2),
      regionCount: p.regionCount, troops: +p.troops.toFixed(1), gold: +p.gold.toFixed(1),
      troopCap: +p.troopCap.toFixed(1), troopRate: +p.troopRate.toFixed(2), goldRate: +p.goldRate.toFixed(2),
      farm: p.farm, market: p.market, barracks: p.barracks, isBot: p.isBot, connected: true,
    })),
    events: [],
  };
  return Buffer.byteLength(JSON.stringify(snap), 'utf8');
}

/* 3) 起点公平：多张图上 4 个起始区域面积权重差 */
function startFairness(n = 200) {
  const spreads = [];
  for (let i = 0; i < n; i++) {
    const seed = 5000 + i * 131;
    const { regions, radius } = generateRegions({ seed, count: 62, radius: 46 });
    const st = Game.createState({ regions, radius }, { seed, playerCount: 4, endOnHumansOut: false });
    const w = st.players.map((p) => p.weight);
    spreads.push(+(Math.max(...w) - Math.min(...w)).toFixed(2));
  }
  spreads.sort((a, b) => a - b);
  return {
    min: spreads[0], p50: spreads[Math.floor(n / 2)], p90: spreads[Math.floor(n * 0.9)], max: spreads[n - 1],
    avg: +(spreads.reduce((a, b) => a + b, 0) / n).toFixed(2),
    worseThan10pct: +(spreads.filter((s) => s > 0.35).length / n * 100).toFixed(1),
  };
}

/* 4) 消灭一个玩家的理论代价 */
function elimCost() {
  const { regions, radius } = generateRegions({ seed: 777, count: 62, radius: 46 });
  const st = Game.createState({ regions, radius }, { seed: 777, playerCount: 4, endOnHumansOut: false });
  Game.startGame(st);
  // 假设中期：某玩家持有 1/4 地盘
  const perPlayer = 62 / 4;
  const avgW = 1;
  const costPer = Game.attackCost(st, { areaWeight: avgW });
  return { regionsPerPlayer: +perPlayer.toFixed(1), costPerRegion: costPer, totalTroops: Math.round(perPlayer * costPer), secondsAt2PerSec: Math.round((perPlayer * costPer) / 1.5) };
}

const games = [11, 22, 33, 44, 55, 66].map(density);
const avgPer20 = games[0].per20s.map((_, i) => +(games.reduce((a, g) => a + g.per20s[i], 0) / games.length).toFixed(1));
const avgPerPlayer = avgPer20.map((v) => +(v / 4).toFixed(1));

console.log(JSON.stringify({
  density: { games: games.map((g) => ({ seed: g.seed, elim: g.elim, total: g.totalAttacks })), avgPer20, avgPerPlayer },
  snapBytes: snapSize(999),
  startFairness: startFairness(),
  elimCost: elimCost(),
}, null, 1));
