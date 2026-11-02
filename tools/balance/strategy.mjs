/**
 * 一次性分析脚本：量化「抢地盘」当前版本的节奏、雪球、操作强度与策略差异。
 * 不修改项目代码，只 import 规则层跑无头对局。
 */
import { generateRegions } from '../../src/mapgen.js';
import * as Game from '../../src/game.js';

const DT = 1 / 30;
const DUR = Game.CONFIG.duration;

function mkGame(seed, policyName, botSkill = 0.82) {
  const { regions, radius } = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState({ regions, radius }, { seed, playerCount: 4, endOnHumansOut: false });
  // 座位 0 = 被测「人类策略」，1..3 = 标准 AI
  st.players[0].isBot = false;
  for (let i = 1; i < 4; i++) { st.players[i].isBot = true; st.players[i].skill = botSkill; }
  Game.startGame(st);
  return st;
}

/* ---------------- 人类策略 ---------------- */
// 受真实手速限制：每秒最多 3 次点击
const policies = {
  // 能打就打，永远打最便宜、最赚的
  spam(st) {
    const me = 0, p = st.players[0];
    let best = -1, bestScore = -1;
    for (const r of st.regions) {
      if (r.owner === me) continue;
      if (Game.touchingPlayer(st, r, me) < 0) continue;
      const cost = Game.attackCost(st, r, me);
      if (cost > p.troops) continue;
      const sc = (r.areaWeight * 10) / cost;
      if (sc > bestScore) { bestScore = sc; best = r.id; }
    }
    if (best >= 0) Game.attack(st, me, best);
    else tryUp(st, 0, ['farm', 'market', 'barracks']);
  },
  // 兵到上限 70% 才推，优先大块地
  balanced(st) {
    const me = 0, p = st.players[0];
    if (p.troops > p.troopCap * 0.7) {
      let best = -1, bestW = -1;
      for (const r of st.regions) {
        if (r.owner === me || Game.touchingPlayer(st, r, me) < 0) continue;
        if (Game.attackCost(st, r, me) > p.troops) continue;
        if (r.areaWeight > bestW) { bestW = r.areaWeight; best = r.id; }
      }
      if (best >= 0) { Game.attack(st, me, best); return; }
    }
    tryUp(st, 0, ['farm', 'market', 'barracks']);
  },
  // 只吃开局 3 块地，然后纯发育
  turtle(st) {
    const me = 0, p = st.players[0];
    if (p.regionCount < 3) {
      for (const r of st.regions) {
        if (r.owner === me || Game.touchingPlayer(st, r, me) < 0) continue;
        if (Game.attackCost(st, r, me) <= p.troops) { Game.attack(st, me, r.id); return; }
      }
    }
    tryUp(st, 0, ['farm', 'market', 'barracks']);
  },
  // 完全挂机
  idle(st) { tryUp(st, 0, ['farm', 'market', 'barracks']); },
};

function tryUp(st, i, order) {
  const p = st.players[i];
  for (const t of order) {
    if (p.gold >= Game.upgradePrice(p, t)) { Game.upgrade(st, i, t); return; }
  }
}

function runOne(seed, policyName, { upgradeHz = 1 } = {}) {
  const st = mkGame(seed, policyName);
  const fn = policies[policyName];
  let now = 0, actAcc = 0, upAcc = 0;
  const timeline = [];
  let nextSample = 0;
  while (st.phase === 'playing' && now < DUR + 5) {
    Game.step(st, DT);
    Game.botTick(st, now);
    // 人类动作节流：3/s 点击
    actAcc += DT;
    if (actAcc >= 1 / 3) { actAcc = 0; fn(st); }
    now += DT;
    if (now >= nextSample) {
      nextSample += 5;
      const neutral = st.regions.filter((r) => r.owner === null).length;
      const leader = Game.ranking(st).find((p) => p.alive) || Game.ranking(st)[0];
      timeline.push({
        t: Math.round(now),
        neutral,
        meRegions: st.players[0].regionCount,
        meWeight: +st.players[0].weight.toFixed(2),
        meTroops: Math.round(st.players[0].troops),
        meCap: Math.round(st.players[0].troopCap),
        leaderW: leader ? +leader.weight.toFixed(2) : 0,
        span: +(Math.max(...st.players.map((p) => p.weight)) - Math.min(...st.players.map((p) => p.weight))).toFixed(2),
      });
    }
  }
  const rk = Game.ranking(st);
  return {
    seed,
    policyName,
    ended: st.phase,
    winner: st.winner,
    myRank: rk.findIndex((p) => p.index === 0) + 1,
    myAlive: st.players[0].alive,
    elapsed: +st.elapsed.toFixed(1),
    myRegions: st.players[0].regionCount,
    myWeight: +st.players[0].weight.toFixed(2),
    topWeight: +rk[0].weight.toFixed(2),
    neutralLeft: st.regions.filter((r) => r.owner === null).length,
    up: { farm: st.players[0].farm, market: st.players[0].market, barracks: st.players[0].barracks },
    timeline,
  };
}

/* ---------------- 1. 纯 AI 对局节奏 ---------------- */
function botOnly(seed) {
  const { regions, radius } = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState({ regions, radius }, { seed, playerCount: 4, endOnHumansOut: false });
  for (const p of st.players) p.isBot = true;
  Game.startGame(st);
  let now = 0;
  const snaps = [];
  let nextSample = 0;
  const firstLead = { t60: null, t120: null };
  while (st.phase === 'playing' && now < DUR + 5) {
    Game.step(st, DT);
    Game.botTick(st, now);
    now += DT;
    if (now >= nextSample) {
      nextSample += 1;
      if (Math.abs(now - 60) < 0.5) firstLead.t60 = Game.ranking(st)[0].index;
      if (Math.abs(now - 120) < 0.5) firstLead.t120 = Game.ranking(st)[0].index;
      snaps.push({
        t: Math.round(now),
        neutral: st.regions.filter((r) => r.owner === null).length,
        max: Math.max(...st.players.map((p) => p.regionCount)),
        ghost: st.players.filter((p) => !p.alive || p.regionCount === 0).length,
      });
    }
  }
  const neutralZero = snaps.find((s) => s.neutral === 0);
  return {
    seed,
    winner: st.winner,
    elapsed: +st.elapsed.toFixed(1),
    neutralAtEnd: snaps[snaps.length - 1].neutral,
    saturateAt: neutralZero ? neutralZero.t : null,
    lead60: firstLead.t60,
    lead120: firstLead.t120,
    snowball60: firstLead.t60 !== null && firstLead.t60 === st.winner,
    snowball120: firstLead.t120 !== null && firstLead.t120 === st.winner,
    endState: st.players.map((p) => ({ n: p.name, r: p.regionCount, w: +p.weight.toFixed(1), alive: p.alive, up: `${p.farm}/${p.market}/${p.barracks}` })),
  };
}

/* ---------------- 2. 成本曲线 / 回报 ---------------- */
function curves() {
  const C = Game.CONFIG;
  const rows = [];
  for (const w of [0.5, 1, 1.5, 2, 2.5, 3, 3.6]) {
    const def = C.neutralDefense * w;
    const cost = Math.ceil(def * C.attackFactor + C.attackFlat);
    rows.push({ w, def: +def.toFixed(2), cost });
  }
  const up = [];
  for (const type of ['farm', 'market', 'barracks']) {
    let acc = 0;
    for (let lv = 0; lv < 8; lv++) {
      const price = Math.round(C.upgradeBase[type] * Math.pow(C.upgradeMult, lv));
      acc += price;
      // 回本时间：以「权重=6（约 20 区）、已有 lv 级」估算
      const gain = type === 'farm' ? C.baseTroopRate * (1 + 6 * C.kTroop) * C.farmBonus
        : type === 'market' ? C.baseGoldRate * (1 + 6 * C.kGold) * C.marketBonus
          : 0;
      up.push({ type, lv, price, cum: acc, gainPerSec: +gain.toFixed(3) });
    }
  }
  return { costRows: rows, upRows: up };
}

/* ---------------- 3. 策略对比 ---------------- */
const seeds = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);
const results = {};
for (const pol of ['spam', 'balanced', 'turtle', 'idle']) {
  results[pol] = seeds.map((s) => runOne(s, pol));
}

const summarize = (arr) => {
  const wins = arr.filter((r) => r.winner === 0).length;
  const ranks = arr.map((r) => r.myRank);
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const alive = arr.filter((r) => r.myAlive).length;
  return {
    n: arr.length,
    winRate: +(wins / arr.length * 100).toFixed(1),
    avgRank: +avgRank.toFixed(2),
    surviveRate: +(alive / arr.length * 100).toFixed(1),
    avgRegions: +(arr.reduce((a, r) => a + r.myRegions, 0) / arr.length).toFixed(1),
    avgWeight: +(arr.reduce((a, r) => a + r.myWeight, 0) / arr.length).toFixed(1),
    avgElapsed: +(arr.reduce((a, r) => a + r.elapsed, 0) / arr.length).toFixed(1),
    neutralLeft: +(arr.reduce((a, r) => a + r.neutralLeft, 0) / arr.length).toFixed(1),
    avgUp: {
      farm: +(arr.reduce((a, r) => a + r.up.farm, 0) / arr.length).toFixed(1),
      market: +(arr.reduce((a, r) => a + r.up.market, 0) / arr.length).toFixed(1),
      barracks: +(arr.reduce((a, r) => a + r.up.barracks, 0) / arr.length).toFixed(1),
    },
  };
};

const out = {
  strategies: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, summarize(v)])),
  sampleTimeline: results.balanced[0].timeline,
  botOnly: seeds.slice(0, 12).map(botOnly),
  curves: curves(),
};

const bo = out.botOnly;
out.botSummary = {
  n: bo.length,
  avgElapsed: +(bo.reduce((a, r) => a + r.elapsed, 0) / bo.length).toFixed(1),
  avgNeutralAtEnd: +(bo.reduce((a, r) => a + r.neutralAtEnd, 0) / bo.length).toFixed(1),
  saturateAt: bo.map((r) => r.saturateAt),
  snowball60: +(bo.filter((r) => r.snowball60).length / bo.length * 100).toFixed(1),
  snowball120: +(bo.filter((r) => r.snowball120).length / bo.length * 100).toFixed(1),
  endStates: bo.slice(0, 4).map((r) => r.endState),
};

console.log(JSON.stringify(out, null, 1));
