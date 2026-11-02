/**
 * 上限经济性诊断：上限到底有没有卡住玩家？兵营到底值不值得买？
 * 用法: node tools/capstudy.mjs [局数]
 *
 * 指标：
 *  - atCap：玩家处于「贴着上限」的时间占比（上限真正生效的时刻）
 *  - waste ：每秒产出里被上限吃掉、白白浪费掉的比例
 *  - 发育花费：农场/市场/兵营各花掉多少金币
 */
import { generateRegions } from '../src/mapgen.js';
import { CONFIG, createState, startGame, step, botTick } from '../src/game.js';

const N = Number(process.argv[2] || 12);
const dt = 1 / 30;

const acc = {
  ticks: 0,
  atCapTicks: 0,
  nearCapTicks: 0,
  produced: 0,
  wasted: 0,
  troopsSum: 0,
  capSum: 0,
  spend: { farm: 0, market: 0, barracks: 0 },
  levels: { farm: 0, market: 0, barracks: 0 },
  games: 0,
  ended: 0,
  durations: [],
};

for (let g = 0; g < N; g++) {
  const seed = 1013 + g * 7919;
  const { regions } = generateRegions({ seed, count: 62, radius: 46 });
  const state = createState({ regions }, { seed });
  for (const p of state.players) p.isBot = true;
  startGame(state);

  let now = 0;
  let seen = 0;
  while (state.phase === 'playing' && now < CONFIG.duration + 5) {
    // 采样「本 tick 之前」的状态，判断上限是否会吃掉产出
    for (const p of state.players) {
      if (!p.alive) continue;
      const prod = p.troopRate * dt;
      const room = Math.max(0, p.troopCap - p.troops);
      acc.produced += prod;
      acc.wasted += Math.max(0, prod - room);
      acc.troopsSum += p.troops;
      acc.capSum += p.troopCap;
      acc.ticks++;
      if (p.troops >= p.troopCap - 0.05) acc.atCapTicks++;
      if (p.troops >= p.troopCap * 0.9 && p.troops <= p.troopCap) acc.nearCapTicks++;
    }
    step(state, dt);
    botTick(state, now);
    now += dt;

    // 消化升级事件，累计花费
    while (seen < state.events.length) {
      const ev = state.events[seen++];
      if (ev.type !== 'upgrade') continue;
      acc.levels[ev.upgrade]++;
      const lv = ev.level - 1;
      acc.spend[ev.upgrade] += Math.round(CONFIG.upgradeBase[ev.upgrade] * Math.pow(CONFIG.upgradeMult, lv));
    }
  }
  acc.games++;
  if (state.phase === 'ended') acc.ended++;
  acc.durations.push(state.elapsed);
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');
const totalSpend = acc.spend.farm + acc.spend.market + acc.spend.barracks;

console.log(`样本 ${acc.games} 局 | 正常结束 ${acc.ended}`);
console.log(`平均对局时长 ${(acc.durations.reduce((a, b) => a + b, 0) / acc.durations.length).toFixed(0)}s`);
console.log(`平均兵力 ${(acc.troopsSum / acc.ticks).toFixed(1)} / 平均上限 ${(acc.capSum / acc.ticks).toFixed(1)}`);
console.log(`贴上限时间占比 ${pct(acc.atCapTicks, acc.ticks)} | 90% 以上时间占比 ${pct(acc.nearCapTicks, acc.ticks)}`);
console.log(`产出被上限浪费 ${pct(acc.wasted, acc.produced)}`);
console.log('--- 发育投入 ---');
for (const k of ['farm', 'market', 'barracks']) {
  console.log(`${k}: 买了 ${acc.levels[k]} 次, 花金 ${acc.spend[k]}, 占总投入 ${pct(acc.spend[k], totalSpend)}`);
}
