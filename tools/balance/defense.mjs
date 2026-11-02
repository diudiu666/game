/**
 * probe6 —— 「给兵力防守价值」的 A/B：守方兵力越满，攻方成本越高。
 *   costMult = attackFactor + defTroopK * (守方兵力/守方上限)，中立区不变
 * 复用同一批种子与同一套策略，只看「攒兵策略是否重新变得可行」。
 *
 * ⚠️ 本脚本内置的 BASE 是 2026-10-30 版规则（capPerWeight 4.2、兵营只加上限、无折扣），
 *    作为「改造前」的固定对照组保留，不要与现行 game.js 的数值混着比较。
 */
import { generateRegions, mulberry32, pickStartRegions } from '../../src/mapgen.js';

const DT = 1 / 30;
const BASE = {
  duration: 300, startTroops: 26, startGold: 10, baseTroopRate: 1.0, baseGoldRate: 0.38,
  baseTroopCap: 60, kTroop: 0.055, kGold: 0.03, capPerWeight: 4.2, farmBonus: 0.15,
  marketBonus: 0.2, barracksBonus: 26, neutralDefense: 8.6, attackFactor: 1.1, attackFlat: 2,
  upgradeBase: { farm: 11, market: 11, barracks: 14 }, upgradeMult: 1.42,
  defTroopK: 0, capital: false, capitalMult: 2.2, lossRatio: 0,
};

function build(seed, cfg) {
  const { regions } = generateRegions({ seed, count: 62, radius: 46 });
  const rng = mulberry32(seed);
  const rs = regions.map((r) => ({ id: r.id, owner: -1, neighbors: r.neighbors, w: r.areaWeight, center: r.center, capitalOf: -1 }));
  const starts = pickStartRegions(rs, 4, rng);
  const players = [];
  for (let i = 0; i < 4; i++) {
    players.push({ i, troops: cfg.startTroops, gold: cfg.startGold, farm: 0, market: 0, barracks: 0, alive: true, weight: 0, count: 0, rate: 0, goldRate: 0, cap: 0 });
    rs[starts[i]].owner = i;
    if (cfg.capital) rs[starts[i]].capitalOf = i;
  }
  const st = { regions: rs, players, rng, time: cfg.duration, elapsed: 0, phase: 'playing', winner: null, elims: 0 };
  recompute(st, cfg);
  return st;
}

function recompute(st, cfg) {
  for (const p of st.players) { p.weight = 0; p.count = 0; }
  for (const r of st.regions) if (r.owner >= 0) { st.players[r.owner].weight += r.w; st.players[r.owner].count++; }
  for (const p of st.players) {
    p.rate = cfg.baseTroopRate * (1 + p.weight * cfg.kTroop) * (1 + p.farm * cfg.farmBonus);
    p.goldRate = cfg.baseGoldRate * (1 + p.weight * cfg.kGold) * (1 + p.market * cfg.marketBonus);
    p.cap = cfg.baseTroopCap + p.weight * cfg.capPerWeight + p.barracks * cfg.barracksBonus;
  }
}

function costOf(st, cfg, r) {
  const base = cfg.neutralDefense * r.w * (r.capitalOf >= 0 ? cfg.capitalMult : 1);
  let mult = cfg.attackFactor;
  if (r.owner >= 0 && cfg.defTroopK > 0) {
    const d = st.players[r.owner];
    mult += cfg.defTroopK * Math.min(1, d.troops / Math.max(1, d.cap));
  }
  return Math.ceil(base * mult + cfg.attackFlat);
}
const priceOf = (cfg, p, t) => Math.round(cfg.upgradeBase[t] * Math.pow(cfg.upgradeMult, p[t]));

function step(st, cfg, dt) {
  if (st.phase !== 'playing') return;
  st.elapsed += dt; st.time -= dt;
  recompute(st, cfg);
  for (const p of st.players) {
    if (!p.alive) continue;
    p.troops = Math.min(p.troops + p.rate * dt, p.cap);
    p.gold += p.goldRate * dt;
  }
  if (st.time <= 0) {
    const alive = st.players.filter((p) => p.alive).sort((a, b) => b.weight - a.weight);
    st.phase = 'ended'; st.winner = alive[0]?.i ?? null; st.endBy = 'timeout';
  }
}

function attack(st, cfg, pi, rid) {
  const p = st.players[pi], r = st.regions[rid];
  if (!p.alive || st.phase !== 'playing' || r.owner === pi) return false;
  if (!r.neighbors.some((n) => st.regions[n].owner === pi)) return false;
  const cost = costOf(st, cfg, r);
  if (p.troops < cost) return false;
  p.troops -= cost;
  const prev = r.owner;
  r.owner = pi;
  if (prev >= 0 && cfg.lossRatio > 0) st.players[prev].troops = Math.max(0, st.players[prev].troops - cost * cfg.lossRatio);
  if (cfg.capital && r.capitalOf >= 0 && r.capitalOf !== pi) {
    const dead = st.players[r.capitalOf];
    dead.alive = false;
    for (const q of st.regions) if (q.owner === dead.i) q.owner = -1;
    r.capitalOf = -1; r.owner = pi; st.elims++;
  }
  recompute(st, cfg);
  const alive = st.players.filter((x) => x.alive);
  if (alive.length <= 1) { st.phase = 'ended'; st.winner = alive[0]?.i ?? pi; st.endBy = 'elim'; }
  return true;
}
function buy(st, cfg, pi) {
  const p = st.players[pi];
  const order = p.troops > p.cap * 0.92 ? ['barracks', 'farm', 'market'] : ['farm', 'market', 'barracks'];
  for (const t of order) if (p.gold >= priceOf(cfg, p, t)) { p.gold -= priceOf(cfg, p, t); p[t]++; recompute(st, cfg); return; }
}

function human(st, cfg, pi, threshold) {
  const p = st.players[pi];
  if (!p.alive) return;
  if (p.troops < p.cap * threshold) { buy(st, cfg, pi); return; }
  const cands = [];
  for (const r of st.regions) {
    if (r.owner === pi || !r.neighbors.some((n) => st.regions[n].owner === pi)) continue;
    const c = costOf(st, cfg, r);
    if (c > p.troops) continue;
    let s = (r.w * 10) / c;
    if (r.owner < 0) s *= 1.45; else if (st.players[r.owner].count <= 2) s *= 1.2;
    cands.push({ id: r.id, s });
  }
  if (cands.length) { cands.sort((a, b) => b.s - a.s); attack(st, cfg, pi, cands[0].id); return; }
  buy(st, cfg, pi);
}
function bot(st, cfg, pi) {
  const p = st.players[pi];
  if (!p.alive) return;
  const cands = [];
  for (const r of st.regions) {
    if (r.owner === pi || !r.neighbors.some((n) => st.regions[n].owner === pi)) continue;
    const c = costOf(st, cfg, r);
    if (c > p.troops) continue;
    let s = (r.w * 10) / c;
    if (r.owner < 0) s *= 1.45; else if (st.players[r.owner].count <= 2) s *= 1.2;
    cands.push({ id: r.id, c, s });
  }
  cands.sort((a, b) => b.s - a.s);
  if (cands.length && p.troops > cands[0].c * 1.2 && st.rng() < 0.95) { attack(st, cfg, pi, cands[0].id); return; }
  buy(st, cfg, pi);
}

function run(seed, cfg, threshold) {
  const st = build(seed, cfg);
  let now = 0, acc = 0;
  const think = st.players.map((_, i) => 1 + i * 0.4);
  while (st.phase === 'playing' && now < cfg.duration + 5) {
    step(st, cfg, DT);
    for (let i = 1; i < 4; i++) if (now >= think[i]) { think[i] = now + 0.55 + st.rng() * 0.7; bot(st, cfg, i); }
    acc += DT;
    if (acc >= 1 / 3) { acc = 0; human(st, cfg, 0, threshold); }
    now += DT;
  }
  const rk = st.players.slice().sort((a, b) => (b.alive - a.alive) || (b.weight - a.weight));
  return { win: st.winner === 0, rank: rk.findIndex((p) => p.i === 0) + 1, regions: st.players[0].count, alive: st.players[0].alive };
}

const seeds = Array.from({ length: 30 }, (_, i) => 9000 + i * 421);
const rows = [];
for (const k of [0.1, 0.15, 0.2, 0.25, 0.3]) {
  for (const th of [0, 0.35, 0.6]) {
    const cfg = { ...BASE, defTroopK: k };
    const rs = seeds.map((s) => run(s, cfg, th));
    const avg = (f) => +(rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(2);
    rows.push({
      防守系数: k === 0 ? '0（现状）' : `+${k}×兵力占比`,
      出手阈值: th === 0 ? '有兵就打' : `${Math.round(th * 100)}%`,
      胜率: +((rs.filter((r) => r.win).length / rs.length) * 100).toFixed(0) + '%',
      平均名次: avg((r) => r.rank),
      平均区数: avg((r) => r.regions),
      存活率: +((rs.filter((r) => r.alive).length / rs.length) * 100).toFixed(0) + '%',
    });
  }
}
console.table(rows);
