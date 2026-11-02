/**
 * probe5 —— 两组受控实验
 *  E1 出手阈值：同样的目标规则、同样的手速上限（3 次/秒），只改「兵到上限的多少比例才出手」
 *  E2 反领先倾向：AI 是否额外针对当前第一名，对「120s 领先者最终是否获胜」的影响
 */
import { build, step, attack, upgrade, costOf, priceOf, recompute, DT } from './rules-sweep.mjs';
import { generateRegions, mulberry32, pickStartRegions } from '../../src/mapgen.js';

const CFG = {
  duration: 300, startTroops: 26, startGold: 10, baseTroopRate: 1.0, baseGoldRate: 0.38,
  baseTroopCap: 60, kTroop: 0.055, kGold: 0.03, capPerWeight: 4.2, farmBonus: 0.15,
  marketBonus: 0.2, barracksBonus: 26, neutralDefense: 8.6, attackFactor: 1.1, attackFlat: 2,
  upgradeBase: { farm: 11, market: 11, barracks: 14 }, upgradeMult: 1.42,
  lossRatio: 0, capital: false, capitalMult: 2.2, riotEvery: 0, riotCount: 3, botThink: [0.55, 1.25],
};

/** 人类策略：目标规则与 AI 一致（性价比），只改出手阈值 */
function humanAct(st, pi, threshold) {
  const p = st.players[pi];
  if (!p.alive) return;
  if (p.troops < p.cap * threshold) {
    // 攒兵期只发育
    buy(st, pi);
    return;
  }
  const cands = [];
  for (const r of st.regions) {
    if (r.owner === pi) continue;
    if (!r.neighbors.some((n) => st.regions[n].owner === pi)) continue;
    const c = costOf(st, CFG, r);
    if (c > p.troops) continue;
    let score = (r.w * 10) / c;
    if (r.owner < 0) score *= 1.45;
    else if (st.players[r.owner].count <= 2) score *= 1.2;
    cands.push({ id: r.id, c, score });
  }
  if (cands.length) {
    cands.sort((a, b) => b.score - a.score);
    attack(st, CFG, pi, cands[0].id);
  } else buy(st, pi);
}
function buy(st, pi) {
  const p = st.players[pi];
  const order = p.troops > p.cap * 0.92 ? ['barracks', 'farm', 'market'] : ['farm', 'market', 'barracks'];
  for (const t of order) if (p.gold >= priceOf(CFG, p, t)) { upgrade(st, CFG, pi, t); return; }
}

function runMix(seed, threshold) {
  const st = build(seed, CFG);
  let now = 0;
  const think = st.players.map((_, i) => 1 + i * 0.4);
  let actAcc = 0;
  while (st.phase === 'playing' && now < CFG.duration + 5) {
    step(st, CFG, DT);
    for (let i = 1; i < 4; i++) {
      const p = st.players[i];
      if (now >= think[i]) { think[i] = now + CFG.botThink[0] + st.rng() * 0.7; botSimple(st, i, false); }
    }
    actAcc += DT;
    if (actAcc >= 1 / 3) { actAcc = 0; humanAct(st, 0, threshold); }
    now += DT;
  }
  const rk = st.players.slice().sort((a, b) => (b.alive - a.alive) || (b.weight - a.weight));
  return {
    win: st.winner === 0,
    rank: rk.findIndex((p) => p.i === 0) + 1,
    regions: st.players[0].count,
    weight: st.players[0].weight,
    alive: st.players[0].alive,
    up: `${st.players[0].farm}/${st.players[0].market}/${st.players[0].barracks}`,
    neutralLeft: st.regions.filter((r) => r.owner < 0).length,
  };
}

function botSimple(st, pi, antiLeader) {
  const p = st.players[pi];
  if (!p.alive) return;
  const top = st.players.filter((x) => x.alive).sort((a, b) => b.weight - a.weight)[0];
  const cands = [];
  for (const r of st.regions) {
    if (r.owner === pi) continue;
    if (!r.neighbors.some((n) => st.regions[n].owner === pi)) continue;
    const c = costOf(st, CFG, r);
    if (c > p.troops) continue;
    let score = (r.w * 10) / c;
    if (r.owner < 0) score *= 1.45;
    else if (st.players[r.owner].count <= 2) score *= 1.2;
    if (antiLeader && r.owner === top?.i && top.i !== pi) score *= 1.5;
    cands.push({ id: r.id, c, score });
  }
  cands.sort((a, b) => b.score - a.score);
  if (cands.length) {
    const best = cands[0];
    if (p.troops > best.c * 1.2 && st.rng() < 0.95) { attack(st, CFG, pi, best.id); return; }
  }
  buy(st, pi);
}

/* E1 */
const seeds = Array.from({ length: 30 }, (_, i) => 9000 + i * 421);
const thresholds = [0, 0.35, 0.6, 0.85];
console.log('== E1 出手阈值（兵达到上限的多少比例才推）==');
console.table(thresholds.map((th) => {
  const rs = seeds.map((s) => runMix(s, th));
  const avg = (f) => +(rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(2);
  return {
    阈值: th === 0 ? '有兵就打(0%)' : `${Math.round(th * 100)}%`,
    胜率: +((rs.filter((r) => r.win).length / rs.length) * 100).toFixed(0) + '%',
    平均名次: avg((r) => r.rank),
    平均区数: avg((r) => r.regions),
    平均权重: avg((r) => r.weight),
    存活率: +((rs.filter((r) => r.alive).length / rs.length) * 100).toFixed(0) + '%',
    典型发育: rs[0].up,
  };
}));

/* E2 */
console.log('\n== E2 反领先倾向（AI 是否额外针对第一名）==');
function runE2(seed, antiLeader) {
  const st = build(seed, CFG);
  let now = 0;
  const think = st.players.map((_, i) => 1 + i * 0.4);
  let lead120 = null, sampler = 0;
  while (st.phase === 'playing' && now < CFG.duration + 5) {
    step(st, CFG, DT);
    for (let i = 0; i < 4; i++) if (now >= think[i]) { think[i] = now + CFG.botThink[0] + st.rng() * 0.7; botSimple(st, i, antiLeader); }
    now += DT;
    if (now >= sampler) { sampler += 1; if (Math.abs(now - 120) < 0.5) { const t = st.players.filter((p) => p.alive).sort((a, b) => b.weight - a.weight)[0]; lead120 = t ? t.i : null; } }
  }
  return { snow: lead120 !== null && lead120 === st.winner };
}
const e2 = [false, true].map((f) => {
  const rs = seeds.slice(0, 24).map((s) => runE2(s, f));
  return { 反领先: f ? '开' : '关', '120s领先者胜率': +((rs.filter((r) => r.snow).length / rs.length) * 100).toFixed(0) + '%' };
});
console.table(e2);
