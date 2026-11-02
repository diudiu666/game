/**
 * game.js —— 纯逻辑层（不依赖 DOM / Three.js）
 *
 * 与文档第 2、5 节一致：
 *   - 全局兵力池 + 金币，按领土总权重产出
 *   - 攻击需与己方领土接壤（只查邻接表，不做几何计算）
 *   - 金币购买农场 / 市场 / 兵营，价格递增、效果叠加
 *   - 淘汰制 + 计时制双保险
 */

import { mulberry32, pickStartRegions } from './mapgen.js';

/** 所有可调参数集中在这里，方便手感调优 */
export const CONFIG = {
  playerCount: 4,
  duration: 300, // 秒；文档建议 8–10 分钟，原型用 5 分钟便于测试

  startTroops: 26,
  startGold: 10,
  baseTroopRate: 1.0, // 兵/秒
  baseGoldRate: 0.38, // 金/秒
  baseTroopCap: 60,

  kTroop: 0.055, // 领土权重对兵力增速的系数
  kGold: 0.03,
  /**
   * 领地对上限的贡献刻意压低（原来 4.2/权重，等于 62 格就有 260 上限）。
   * 实测：玩家/ AI 的兵力常年在 6~27 之间（因为「够兵就立刻出兵」永远是最优解），
   * 上限只要高过一次攻占的量级就再也不会触发，纯属摆设 —— 所以它只作为「防止无限囤兵」的
   * 安全阀保留，不再充当发育的主要卖点。
   */
  capPerWeight: 2.0,

  farmBonus: 0.15, // 每级农场 +15% 兵力增速
  marketBonus: 0.3, // 每级市场 +30% 金币增速
  barracksBonus: 12, // 每级兵营 +12 上限（附属效果）
  /** 兵营的主动效果：每级降低攻占消耗。这才是「持续消耗」玩法里真正值钱的东西 */
  barracksCostCut: 0.07,
  costCutFloor: 0.5, // 攻占消耗最低打到基础值的 50%

  neutralDefense: 8.6, // 区域守备（只乘面积权重，与归属无关）
  attackFactor: 1.1, // 派兵 = 防御 × 1.1
  attackFlat: 2,

  /* ---- 斩首 / 战损 / 反领先（对应优化建议 P0-1 / P0-2 / P0-4）---- */
  /**
   * 首都（每人开局那一块）的守备倍率。
   * 实测（tools/capsweep.mjs，10 局/组）：2.2 时 AI 一次都不会打（太贵，算下来不如刷普通地），
   * 淘汰率 0%；1.5 时最早 36 秒就有人被斩首，太早；1.8 时最早 96 秒、平均 154 秒，
   * 淘汰局占 70%、平均时长 258 秒 —— 落在「终盘决胜负」的位置。
   */
  capitalDefense: 1.8,
  /** 占领敌方区域时，守方全局兵力池损失 = 本次攻占成本 × 该系数（中立区不产生战损） */
  lossRatio: 1.0,
  /** AI 反领先：目标是当前领土权重第一时，评分乘这个系数 */
  antiLeader: 1.5,
  /** AI 斩首倾向：目标是首都时，评分乘这个系数（要盖过 1.8 倍的守备价，否则 AI 永远不碰） */
  capitalHunt: 2.4,

  upgradeBase: { farm: 11, market: 11, barracks: 14 },
  upgradeMult: 1.42,

  attackCooldown: 0.11, // 秒，防连点
  botSkill: 0.82, // AI 效率折扣（0~1），越高越强
};

export const COLORS = ['#ff5b52', '#4b9dff', '#2fcf85', '#ffb02a'];
export const PLAYER_NAMES = ['你', '赤狐', '蓝鲸', '青狼'];
/** 房间最多坐几个人 */
export const MAX_PLAYERS = 4;

/** 没传座位时按「1 个真人 + N-1 个 AI」凑一桌（单机练习 / 模拟器用） */
function defaultSeats(opts) {
  const n = Math.max(1, Math.min(MAX_PLAYERS, opts.playerCount ?? CONFIG.playerCount));
  const seats = [];
  for (let i = 0; i < n; i++) {
    seats.push({
      name: i === 0 ? opts.humanName || '你' : PLAYER_NAMES[i] || `AI${i}`,
      isBot: i !== 0,
    });
  }
  return seats;
}

/**
 * 建立一局的状态。
 * @param {object} map  generateRegions() 的产出
 * @param {object} opts
 *   seats: [{name, isBot}]  —— 座位表，长度 1~4，索引即玩家 index
 *   seed / playerCount / humanName / viewIndex / endOnHumansOut
 */
export function createState(map, opts = {}) {
  const seed = opts.seed ?? 20261030;
  const rng = mulberry32(seed);
  const seats = (opts.seats?.length ? opts.seats : defaultSeats(opts)).slice(0, MAX_PLAYERS);

  const regions = map.regions.map((r) => ({
    id: r.id,
    owner: null,
    neighbors: r.neighbors.slice(),
    areaWeight: r.areaWeight,
    area: r.area,
    center: r.center,
    height: r.height,
    polygon: r.polygon,
    /** 谁的都城：-1 = 普通地块；被夺走后清回 -1（新主人的都城还是自己那一块） */
    capitalOf: -1,
  }));

  const starts = pickStartRegions(regions, seats.length, rng);

  const players = [];
  for (let i = 0; i < seats.length; i++) {
    players.push({
      index: i,
      name: seats[i].name || PLAYER_NAMES[i] || `AI${i}`,
      color: COLORS[i],
      isBot: !!seats[i].isBot,
      connected: true,
      troops: CONFIG.startTroops,
      gold: CONFIG.startGold,
      farm: 0,
      market: 0,
      barracks: 0,
      alive: true,
      /** 都城所在区域 id；失守后置 -1 */
      capital: starts[i],
      capitalLost: false,
      weight: 0,
      regionCount: 0,
      troopRate: 0,
      goldRate: 0,
      troopCap: 0,
      nextThink: 1 + i * 0.4,
      lastAttack: -99,
      skill: CONFIG.botSkill,
    });
    regions[starts[i]].owner = i;
    regions[starts[i]].capitalOf = i;
  }

  const state = {
    regions,
    players,
    /** 客户端自己的座位；服务端不关心，由每个客户端各自设置 */
    viewIndex: opts.viewIndex ?? players.findIndex((p) => !p.isBot),
    /** 真人全部出局就提前收摊（单机体验用）；联机时关掉，让剩下的人打完 */
    endOnHumansOut: opts.endOnHumansOut ?? true,
    phase: 'lobby', // lobby | playing | ended
    time: CONFIG.duration,
    elapsed: 0,
    winner: null,
    /** 结束原因：elimination | conquer | defeat | timeout，客户端据此出结算卡 */
    endReason: null,
    events: [],
    rng,
    map,
  };
  if (state.viewIndex < 0) state.viewIndex = 0;

  recompute(state);
  return state;
}

/** 该座位是不是真人 */
export function humans(state) {
  return state.players.filter((p) => !p.isBot);
}

export function startGame(state) {
  state.phase = 'playing';
  state.events.push({ type: 'start' });
}

/** 重算每个玩家的领土权重与三项速率 */
export function recompute(state) {
  for (const p of state.players) {
    p.weight = 0;
    p.regionCount = 0;
  }
  for (const r of state.regions) {
    if (r.owner === null) continue;
    const p = state.players[r.owner];
    p.weight += r.areaWeight;
    p.regionCount++;
  }
  for (const p of state.players) {
    p.troopRate =
      CONFIG.baseTroopRate * (1 + p.weight * CONFIG.kTroop) * (1 + p.farm * CONFIG.farmBonus);
    p.goldRate =
      CONFIG.baseGoldRate * (1 + p.weight * CONFIG.kGold) * (1 + p.market * CONFIG.marketBonus);
    p.troopCap =
      CONFIG.baseTroopCap + p.weight * CONFIG.capPerWeight + p.barracks * CONFIG.barracksBonus;
  }
}

/** 区域防御只由面积权重决定：同样大小，中立区和敌区一样难打；首都要额外乘一个倍率 */
export function defenseOf(state, region) {
  const base = CONFIG.neutralDefense * region.areaWeight;
  return region.capitalOf >= 0 ? base * CONFIG.capitalDefense : base;
}

/** 这块地是不是还挂着某个人的都城（被打下来就清空了） */
export function isCapital(region) {
  return !!region && region.capitalOf >= 0;
}

/** 兵营带来的攻占消耗系数（1 = 无折扣），UI 与 AI 共用 */
export function costMultiplier(state, playerIndex) {
  const p = playerIndex == null ? null : state.players[playerIndex];
  if (!p) return 1;
  return Math.max(CONFIG.costCutFloor, 1 - p.barracks * CONFIG.barracksCostCut);
}

/**
 * 攻占一块地要花多少兵。
 * 传入 playerIndex 时按该玩家的兵营等级打折，不传则是基础价（用于通用展示）。
 */
export function attackCost(state, region, playerIndex) {
  const base = defenseOf(state, region) * CONFIG.attackFactor + CONFIG.attackFlat;
  return Math.ceil(base * costMultiplier(state, playerIndex));
}

export function upgradePrice(player, type) {
  return Math.round(CONFIG.upgradeBase[type] * Math.pow(CONFIG.upgradeMult, player[type]));
}

/**
 * 某项发育的「下一级」能带来多少相对增益（0~1）。
 * 农场/市场是线性叠加、边际递减；兵营是消耗打折，边际递增（后期更猛）。
 */
export function upgradeGain(player, type) {
  if (type === 'farm') return CONFIG.farmBonus / (1 + player.farm * CONFIG.farmBonus);
  if (type === 'market') return CONFIG.marketBonus / (1 + player.market * CONFIG.marketBonus);
  const now = Math.max(CONFIG.costCutFloor, 1 - player.barracks * CONFIG.barracksCostCut);
  const next = Math.max(CONFIG.costCutFloor, 1 - (player.barracks + 1) * CONFIG.barracksCostCut);
  return now / next - 1;
}

/** 该区域是否与某玩家的领土接壤 */
export function touchingPlayer(state, region, playerIndex) {
  for (const n of region.neighbors) {
    if (state.regions[n].owner === playerIndex) return n;
  }
  return -1;
}

export function ownedNeighborCount(state, region, playerIndex) {
  let c = 0;
  for (const n of region.neighbors) if (state.regions[n].owner === playerIndex) c++;
  return c;
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

export function step(state, dt) {
  if (state.phase !== 'playing') return;

  state.elapsed += dt;
  state.time = Math.max(0, state.time - dt);

  recompute(state);
  syncAlive(state);

  for (const p of state.players) {
    if (!p.alive) continue;
    p.troops = Math.min(p.troops + p.troopRate * dt, p.troopCap);
    p.gold += p.goldRate * dt;
  }

  if (state.time <= 0) {
    endByScore(state);
    return;
  }
  checkEnd(state);
}

/* ------------------------------------------------------------------ */
/* 指令                                                                */
/* ------------------------------------------------------------------ */

export function attack(state, playerIndex, targetId) {
  if (state.phase !== 'playing') return { ok: false, reason: '对局未开始' };
  const p = state.players[playerIndex];
  if (!p || !p.alive) return { ok: false, reason: '已出局' };

  const region = state.regions[targetId];
  if (!region) return { ok: false, reason: '目标不存在' };
  if (region.owner === playerIndex) return { ok: false, reason: '已经是你的地盘' };

  const from = touchingPlayer(state, region, playerIndex);
  if (from < 0) return { ok: false, reason: '必须与你的领土接壤' };

  const cost = attackCost(state, region, playerIndex);
  if (p.troops < cost) return { ok: false, reason: `兵力不足（需 ${cost}）`, cost };

  const prevOwner = region.owner;
  /** 打的是不是别人的都城 —— 是的话这一下就是斩首 */
  const wasCapital = region.capitalOf >= 0;
  p.troops -= cost;
  p.lastAttack = state.elapsed;
  region.owner = playerIndex;
  if (wasCapital) region.capitalOf = -1;

  // 战损：占领敌方区域时，守方全局兵力池跟着掉一截（中立区不产生战损）
  let loss = 0;
  if (prevOwner !== null && !wasCapital) {
    const def = state.players[prevOwner];
    const before = def.troops;
    def.troops = Math.max(0, def.troops - cost * CONFIG.lossRatio);
    loss = Math.round((before - def.troops) * 10) / 10;
  }

  recompute(state);
  state.events.push({
    type: 'attack',
    player: playerIndex,
    from,
    to: targetId,
    cost,
    prevOwner,
    color: p.color,
    loss,
    capital: wasCapital,
  });

  if (wasCapital) {
    // 斩首：失守者立即出局，全部领土回中立（给别人新的可抢目标）
    const def = state.players[prevOwner];
    def.capitalLost = true;
    def.capital = -1;
    def.alive = false;
    for (const rr of state.regions) if (rr.owner === prevOwner) rr.owner = null;
    recompute(state);
    state.events.push({ type: 'capital', player: prevOwner, by: playerIndex, region: targetId, color: p.color });
    state.events.push({ type: 'eliminated', player: prevOwner, by: playerIndex, capital: true });
  } else if (prevOwner !== null && state.players[prevOwner].regionCount === 0) {
    state.players[prevOwner].alive = false;
    state.events.push({ type: 'eliminated', player: prevOwner, by: playerIndex });
  }

  checkEnd(state, wasCapital ? 'capital' : null);
  return { ok: true, cost, from, capital: wasCapital, loss };
}

export function upgrade(state, playerIndex, type) {
  if (state.phase !== 'playing') return { ok: false, reason: '对局未开始' };
  const p = state.players[playerIndex];
  if (!p || !p.alive) return { ok: false, reason: '已出局' };
  if (!(type in CONFIG.upgradeBase)) return { ok: false, reason: '未知发育项' };

  const price = upgradePrice(p, type);
  if (p.gold < price) return { ok: false, reason: `金币不足（需 ${price}）` };

  p.gold -= price;
  p[type] += 1;
  recompute(state);
  state.events.push({ type: 'upgrade', player: playerIndex, upgrade: type, level: p[type] });
  return { ok: true, price, level: p[type] };
}

/** 区域清零就算出局：兜住任何漏掉淘汰判定的路径，避免「0 地还活着」卡住胜负判定 */
function syncAlive(state) {
  for (const p of state.players) {
    if (!p.alive || p.regionCount > 0) continue;
    p.alive = false;
    state.events.push({ type: 'eliminated', player: p.index });
  }
}

function endMatch(state, winner, reason) {
  state.phase = 'ended';
  state.winner = winner ?? null;
  state.endReason = reason;
  state.events.push({ type: 'ended', winner: state.winner, reason });
}

function checkEnd(state, hint) {
  syncAlive(state);
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    // 最后一击如果是斩首，就用 capital 文案，别跟普通清场混为一谈
    endMatch(state, alive[0] ? alive[0].index : null, hint === 'capital' ? 'capital' : 'elimination');
    return true;
  }

  // 一个人吃掉整张地图 —— 不用等对手被逐个淘汰
  const total = state.regions.length;
  if (total > 0) {
    const lord = alive.find((p) => p.regionCount === total);
    if (lord) {
      endMatch(state, lord.index, 'conquer');
      return true;
    }
  }

  // 单机时人类一死就收摊，免得干看着 AI 打完；联机时闭嘴，让剩下的人继续
  if (state.endOnHumansOut) {
    const hs = humans(state);
    if (hs.length && hs.every((p) => !p.alive)) {
      const best = alive.slice().sort((a, b) => b.weight - a.weight)[0];
      endMatch(state, best ? best.index : null, 'defeat');
      return true;
    }
  }
  return false;
}

function endByScore(state) {
  const alive = state.players.filter((p) => p.alive);
  alive.sort((a, b) => b.weight - a.weight || b.regionCount - a.regionCount);
  endMatch(state, alive[0] ? alive[0].index : null, 'timeout');
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export function botAct(state, playerIndex) {
  if (state.phase !== 'playing') return;
  const p = state.players[playerIndex];
  if (!p.alive) return;
  const rng = state.rng;

  // 0. 先看谁最肥：反领先倾向只针对一个人（自己除外）
  let leader = -1;
  let leaderW = -1;
  for (const q of state.players) {
    if (!q.alive || q.index === playerIndex) continue;
    if (q.weight > leaderW) {
      leaderW = q.weight;
      leader = q.index;
    }
  }

  // 1. 列出所有可打的目标
  const cand = [];
  for (const r of state.regions) {
    if (r.owner !== playerIndex) continue;
    for (const nId of r.neighbors) {
      const t = state.regions[nId];
      if (t.owner === playerIndex) continue;
      const cost = attackCost(state, t, playerIndex);
      if (cost > p.troops) continue;
      // 打分：优先便宜、面积大、且要削弱的对手
      let score = (t.areaWeight * 10) / cost;
      if (t.owner === null) {
        score *= 1.45; // 前期先吃中立
      } else {
        if (state.players[t.owner].regionCount <= 2) score *= 1.2; // 落井下石
        if (t.owner === leader) score *= CONFIG.antiLeader; // 谁肥打谁
        if (t.capitalOf >= 0) score *= CONFIG.capitalHunt; // 顺手就斩首
      }
      cand.push({ id: nId, cost, score });
    }
  }

  // 2. 兵足够多再出手，避免把池子打空被反推
  if (cand.length) {
    cand.sort((a, b) => b.score - a.score);
    const best = cand[0];
    const reserve = best.cost * (1.15 + rng() * 0.35);
    if (p.troops > reserve && rng() < 0.55 + p.skill * 0.4) {
      attack(state, playerIndex, best.id);
      return;
    }
  }

  // 3. 发育：按「每金币买到的增益」挑，而不是固定顺序（旧写法会把钱砸在没用的兵营上）
  //    市场只产出金币，价值要绕一道才能变成兵力，所以打个折，免得 AI 把一半钱用来「理财」
  const TYPE_WEIGHT = { farm: 1, barracks: 1, market: 0.7 };
  let pickType = null;
  let pickScore = 0;
  for (const type of ['farm', 'market', 'barracks']) {
    const price = upgradePrice(p, type);
    if (p.gold < price) continue;
    const score = ((upgradeGain(p, type) * TYPE_WEIGHT[type]) / price) * (0.85 + rng() * 0.3);
    if (score > pickScore) {
      pickScore = score;
      pickType = type;
    }
  }
  if (pickType && rng() < 0.85) upgrade(state, playerIndex, pickType);
}

/** 一局内所有 AI 的调度（主循环每帧调用） */
export function botTick(state, now) {
  for (const p of state.players) {
    if (!p.isBot || !p.alive) continue;
    if (now < p.nextThink) continue;
    p.nextThink = now + 0.55 + state.rng() * 0.7;
    botAct(state, p.index);
  }
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

/** 玩家是否可攻击该区域（用于高亮提示） */
export function canAttack(state, playerIndex, regionId) {
  const r = state.regions[regionId];
  if (!r || r.owner === playerIndex) return false;
  if (state.players[playerIndex].troops < attackCost(state, r, playerIndex)) return false;
  return touchingPlayer(state, r, playerIndex) >= 0;
}

export function ranking(state) {
  return state.players
    .slice()
    .sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.weight - a.weight;
    });
}
