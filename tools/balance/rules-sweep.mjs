/**
 * probe4 —— 规则参数扫描：定位「为什么没有淘汰」的真因。
 *
 * 对照组 = 当前线上规则（loss=0, 无首都, 无骚乱, 300s）
 * 实验组 = 逐个打开：战损 / 首都 / 骚乱 / 时长
 * 指标：淘汰率、终结方式、饱和时间、120s 领先者胜率、领地易手次数、人均每分钟动作
 *
 * ⚠️ 本脚本内置的 BASE 是 2026-10-30 版规则（capPerWeight 4.2、兵营只加上限、无折扣），
 *    作为「改造前」的固定对照组保留，不要与现行 game.js 的数值混着比较。
 */
import { generateRegions, mulberry32, pickStartRegions } from '../../src/mapgen.js';

const DT = 1 / 30;
const BASE = {
  duration: 300,
  startTroops: 26,
  startGold: 10,
  baseTroopRate: 1.0,
  baseGoldRate: 0.38,
  baseTroopCap: 60,
  kTroop: 0.055,
  kGold: 0.03,
  capPerWeight: 4.2,
  farmBonus: 0.15,
  marketBonus: 0.2,
  barracksBonus: 26,
  neutralDefense: 8.6,
  attackFactor: 1.1,
  attackFlat: 2,
  upgradeBase: { farm: 11, market: 11, barracks: 14 },
  upgradeMult: 1.42,
  // 实验开关
  lossRatio: 0,      // 占领成功时，守方全局池损失 = 成本 × 该系数
  capital: false,    // 首都机制
  capitalMult: 2.2,
  riotEvery: 0,      // 0 = 关闭；否则每 N 秒
  riotCount: 3,
  botThink: [0.55, 1.25],
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
  const st = { regions: rs, players, rng, time: cfg.duration, elapsed: 0, phase: 'playing', winner: null, elims: 0, riots: 0, nextRiot: cfg.riotEvery || Infinity, starts };
  recompute(st, cfg);
  return st;
}

function recompute(st, cfg) {
  for (const p of st.players) { p.weight = 0; p.count = 0; }
  for (const r of st.regions) {
    if (r.owner < 0) continue;
    st.players[r.owner].weight += r.w;
    st.players[r.owner].count++;
  }
  for (const p of st.players) {
    p.rate = cfg.baseTroopRate * (1 + p.weight * cfg.kTroop) * (1 + p.farm * cfg.farmBonus);
    p.goldRate = cfg.baseGoldRate * (1 + p.weight * cfg.kGold) * (1 + p.market * cfg.marketBonus);
    p.cap = cfg.baseTroopCap + p.weight * cfg.capPerWeight + p.barracks * cfg.barracksBonus;
  }
}

const defOf = (st, cfg, r) => cfg.neutralDefense * r.w * (r.capitalOf >= 0 ? cfg.capitalMult : 1);
const costOf = (st, cfg, r) => Math.ceil(defOf(st, cfg, r) * cfg.attackFactor + cfg.attackFlat);
const priceOf = (cfg, p, t) => Math.round(cfg.upgradeBase[t] * Math.pow(cfg.upgradeMult, p[t]));

function step(st, cfg, dt) {
  if (st.phase !== 'playing') return;
  st.elapsed += dt;
  st.time -= dt;
  recompute(st, cfg);
  for (const p of st.players) {
    if (!p.alive) continue;
    p.troops = Math.min(p.troops + p.rate * dt, p.cap);
    p.gold += p.goldRate * dt;
  }
  if (st.elapsed >= st.nextRiot) {
    st.nextRiot += cfg.riotEvery;
    const pool = st.regions.filter((r) => r.owner >= 0 && r.capitalOf < 0);
    for (let k = 0; k < cfg.riotCount && pool.length; k++) {
      const r = pool.splice(Math.floor(st.rng() * pool.length), 1)[0];
      r.owner = -1;
      st.riots++;
    }
    recompute(st, cfg);
  }
  if (st.time <= 0) endScore(st);
}

function attack(st, cfg, pi, rid) {
  const p = st.players[pi];
  const r = st.regions[rid];
  if (!p.alive || st.phase !== 'playing' || r.owner === pi) return false;
  if (!r.neighbors.some((n) => st.regions[n].owner === pi)) return false;
  const cost = costOf(st, cfg, r);
  if (p.troops < cost) return false;
  p.troops -= cost;
  const prev = r.owner;
  r.owner = pi;
  st.attacks = (st.attacks || 0) + 1;

  // 战损：削弱守方全局池（当前版本为 0）
  if (prev >= 0 && cfg.lossRatio > 0) {
    const d = st.players[prev];
    d.troops = Math.max(0, d.troops - cost * cfg.lossRatio);
  }

  // 斩首
  if (cfg.capital && r.capitalOf >= 0 && r.capitalOf !== pi) {
    const dead = st.players[r.capitalOf];
    dead.alive = false;
    for (const q of st.regions) if (q.owner === dead.i) q.owner = -1;
    r.capitalOf = -1;
    r.owner = pi;
    st.elims++;
  }
  recompute(st, cfg);

  const alive = st.players.filter((x) => x.alive);
  if (alive.length <= 1) { st.phase = 'ended'; st.winner = alive[0]?.i ?? pi; st.endBy = 'elim'; return true; }
  // 天然淘汰：领土清零
  if (prev >= 0 && st.players[prev].count === 0 && st.players[prev].alive) {
    st.players[prev].alive = false;
    st.elims++;
    const a2 = st.players.filter((x) => x.alive);
    if (a2.length <= 1) { st.phase = 'ended'; st.winner = a2[0]?.i ?? pi; st.endBy = 'elim'; }
  }
  return true;
}

function upgrade(st, cfg, pi, t) {
  const p = st.players[pi];
  const price = priceOf(cfg, p, t);
  if (p.gold < price) return false;
  p.gold -= price;
  p[t]++;
  recompute(st, cfg);
  return true;
}

function endScore(st) {
  const alive = st.players.filter((p) => p.alive).sort((a, b) => b.weight - a.weight || b.count - a.count);
  st.phase = 'ended';
  st.winner = alive[0]?.i ?? null;
  st.endBy = 'timeout';
}

function botAct(st, cfg, pi) {
  const p = st.players[pi];
  if (!p.alive) return;
  const cands = [];
  for (const r of st.regions) {
    if (r.owner === pi) continue;
    if (!r.neighbors.some((n) => st.regions[n].owner === pi)) continue;
    const c = costOf(st, cfg, r);
    if (c > p.troops) continue;
    let score = (r.w * 10) / c;
    if (r.owner < 0) score *= 1.45;
    else if (st.players[r.owner].count <= 2) score *= 1.2;
    if (cfg.capital && r.capitalOf >= 0) score *= 2.4;
    cands.push({ id: r.id, c, score });
  }
  cands.sort((a, b) => b.score - a.score);
  if (cands.length) {
    const best = cands[0];
    const reserve = best.c * (1.15 + st.rng() * 0.35);
    if (p.troops > reserve && st.rng() < 0.95) { attack(st, cfg, pi, best.id); return; }
  }
  const order = p.troops > p.cap * 0.92 ? ['barracks', 'farm', 'market'] : ['farm', 'market', 'barracks'];
  for (const t of order) if (p.gold >= priceOf(cfg, p, t) && st.rng() < 0.75) { upgrade(st, cfg, pi, t); return; }
}

function run(seed, cfg) {
  const st = build(seed, cfg);
  let now = 0;
  const think = st.players.map((_, i) => 1 + i * 0.4);
  let neutralZeroAt = null, swings = 0, lead120 = null, sampler = 0;
  let last = st.regions.map((r) => r.owner);
  let maxW = 0;
  while (st.phase === 'playing' && now < cfg.duration + 5) {
    step(st, cfg, DT);
    for (const p of st.players) if (now >= think[p.i]) { think[p.i] = now + cfg.botThink[0] + st.rng() * (cfg.botThink[1] - cfg.botThink[0]); botAct(st, cfg, p.i); }
    now += DT;
    if (now >= sampler) {
      sampler += 1;
      const neutral = st.regions.filter((r) => r.owner < 0).length;
      if (neutral === 0 && neutralZeroAt === null) neutralZeroAt = Math.round(now);
      for (let i = 0; i < st.regions.length; i++) if (st.regions[i].owner !== last[i]) { swings++; last[i] = st.regions[i].owner; }
      maxW = Math.max(maxW, ...st.players.map((p) => p.weight));
      if (Math.abs(now - 120) < 0.5) {
        const top = st.players.filter((p) => p.alive).sort((a, b) => b.weight - a.weight)[0];
        lead120 = top ? top.i : null;
      }
    }
  }
  return { seed, elims: st.elims, endBy: st.endBy, winner: st.winner, winnerIsLead120: lead120 !== null && lead120 === st.winner, neutralZeroAt, swings, attacks: st.attacks || 0, maxW: +maxW.toFixed(1), elapsed: +st.elapsed.toFixed(0) };
}

const configs = {
  'A 现状': { ...BASE },
  'B 战损0.5': { ...BASE, lossRatio: 0.5 },
  'C 战损0.5+首都': { ...BASE, lossRatio: 0.5, capital: true },
  'D 战损0.5+首都+骚乱': { ...BASE, lossRatio: 0.5, capital: true, riotEvery: 45, riotCount: 3 },
  'E 战损0.8+首都+骚乱': { ...BASE, lossRatio: 0.8, capital: true, riotEvery: 45, riotCount: 3 },
  'F 战损0.5+首都+240s': { ...BASE, lossRatio: 0.5, capital: true, duration: 240 },
  'G 战损0.5+首都+骚乱+240s': { ...BASE, lossRatio: 0.5, capital: true, riotEvery: 45, riotCount: 3, duration: 240 },
};

export { BASE, run, build, step, attack, upgrade, costOf, priceOf, recompute, botAct, DT };

if (!process.env.NO_TABLE) {
  const seeds = Array.from({ length: 20 }, (_, i) => 4000 + i * 613);
  const rows = [];
  for (const [name, cfg] of Object.entries(configs)) {
    const rs = seeds.map((s) => run(s, cfg));
    const avg = (f) => +(rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(2);
    rows.push({
      方案: name,
      淘汰局占比: +((rs.filter((r) => r.elims > 0).length / rs.length) * 100).toFixed(0) + '%',
      平均淘汰次数: avg((r) => r.elims),
      淘汰终结占比: +((rs.filter((r) => r.endBy === 'elim').length / rs.length) * 100).toFixed(0) + '%',
      平均饱和时间: avg((r) => r.neutralZeroAt ?? 999),
      平均易手次数: avg((r) => r.swings),
      人均动作每分: +((avg((r) => r.attacks) / 4) / (avg((r) => r.elapsed) / 60)).toFixed(1),
      最大权重: avg((r) => r.maxW),
      '120s领先者胜率': +((rs.filter((r) => r.winnerIsLead120).length / rs.length) * 100).toFixed(0) + '%',
    });
  }
  console.table(rows);
}
