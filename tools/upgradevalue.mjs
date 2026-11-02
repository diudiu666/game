/**
 * 发育路线价值对照：四种「只买某一项」的打法，在同一张图、同一套出兵规则下比最终权重。
 * 用来判断兵营改版后是不是还值得买（不再是无用项，也没变成必买项）。
 *
 * 用法: node tools/upgradevalue.mjs [局数]
 */
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

const N = Number(process.argv[2] || 24);
const DT = 1 / 30;
const POLICIES = ['farm', 'market', 'barracks', 'mix'];
const LABEL = { farm: '只买农场', market: '只买市场', barracks: '只买兵营', mix: '按性价比混买' };

const acc = Object.fromEntries(
  POLICIES.map((k) => [k, { weight: 0, regions: 0, wins: 0, gold: 0, lv: { farm: 0, market: 0, barracks: 0 } }])
);
let games = 0;

/** 每金币买到多少相对增益，mix 策略据此挑 */
function gain(p, type) {
  return Game.upgradeGain(p, type);
}

function develop(st, pi, policy) {
  const p = st.players[pi];
  const types = policy === 'mix' ? ['farm', 'market', 'barracks'] : [policy];
  let best = null;
  let bestScore = 0;
  for (const type of types) {
    const price = Game.upgradePrice(p, type);
    if (p.gold < price) continue;
    const score = policy === 'mix' ? gain(p, type) / price : 1 / price;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  if (best) Game.upgrade(st, pi, best);
}

function act(st, pi, policy) {
  const p = st.players[pi];
  if (!p.alive) return;
  let best = -1;
  let bestScore = 0;
  for (const r of st.regions) {
    if (r.owner === pi) continue;
    if (Game.touchingPlayer(st, r, pi) < 0) continue;
    const cost = Game.attackCost(st, r, pi);
    if (cost > p.troops) continue;
    const s = (r.areaWeight * 10) / cost;
    if (s > bestScore) {
      bestScore = s;
      best = r.id;
    }
  }
  if (best >= 0) Game.attack(st, pi, best);
  else develop(st, pi, policy);
}

for (let g = 0; g < N; g++) {
  const seed = 33331 + g * 9001;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const seats = POLICIES.map((k) => ({ name: LABEL[k], isBot: true }));
  const st = Game.createState(map, { seed, seats, endOnHumansOut: false });
  Game.startGame(st);

  let now = 0;
  while (st.phase === 'playing' && now < Game.CONFIG.duration + 1) {
    for (let i = 0; i < st.players.length; i++) act(st, i, POLICIES[i]);
    Game.step(st, DT);
    now += DT;
  }

  const rank = Game.ranking(st);
  POLICIES.forEach((k, i) => {
    const p = st.players[i];
    acc[k].weight += p.weight;
    acc[k].regions += p.regionCount;
    acc[k].gold += p.gold;
    acc[k].lv.farm += p.farm;
    acc[k].lv.market += p.market;
    acc[k].lv.barracks += p.barracks;
    if (rank[0].index === i) acc[k].wins++;
  });
  games++;
}

console.log(`样本 ${games} 局（4 个座位各执一条路线，地图与出兵规则完全相同）`);
console.log('路线          平均权重  平均区域  胜场   平均等级 农/市/营');
for (const k of POLICIES) {
  const a = acc[k];
  const lv = `${(a.lv.farm / games).toFixed(1)}/${(a.lv.market / games).toFixed(1)}/${(a.lv.barracks / games).toFixed(1)}`;
  console.log(
    `${LABEL[k].padEnd(11)} ${(a.weight / games).toFixed(2).padStart(8)} ${(a.regions / games)
      .toFixed(1)
      .padStart(9)} ${String(a.wins).padStart(6)}   ${lv}`
  );
}
