/**
 * 规则自检：首都（斩首淘汰）+ 战损
 *
 * 用法: node tools/capital.mjs
 * 只依赖 src/game.js，不碰浏览器。检查的是「规则本身对不对」，不是手感。
 */
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

const seed = 20261102;
const map = generateRegions({ seed, count: 62, radius: 46 });

/* ------------------------------------------------------------------ */
console.log('\n[1] 开局：每人一块都城，且就是起始地');
{
  const st = Game.createState(map, { seed, seats: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
  const caps = st.regions.filter((r) => r.capitalOf >= 0);
  ok(caps.length === 4, '全图恰好 4 块都城', { got: caps.length });
  ok(
    st.players.every((p) => p.capital >= 0 && st.regions[p.capital].capitalOf === p.index),
    '每位玩家的 capital 字段指向自己那块都城'
  );
  ok(
    st.players.every((p) => st.regions[p.capital].owner === p.index),
    '都城开局的归属就是本人'
  );
  ok(
    new Set(caps.map((r) => r.capitalOf)).size === 4,
    '没有人共用一块都城'
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[2] 都城更难打：同样面积下，都城守备 ×2.2');
{
  const st = Game.createState(map, { seed });
  Game.startGame(st);
  const cap = st.regions.find((r) => r.capitalOf === 1);
  const normal = st.regions.find((r) => r.capitalOf < 0);
  const dCap = Game.defenseOf(st, cap);
  const dNor = Game.defenseOf(st, normal);
  ok(Math.abs(dCap / cap.areaWeight - Game.CONFIG.neutralDefense * Game.CONFIG.capitalDefense) < 1e-6, '都城守备 = 8.6 × 权重 × 2.2');
  ok(dCap / cap.areaWeight > dNor / normal.areaWeight, '都城的单位面积守备高于普通地');
  ok(
    Game.attackCost(st, cap, 0) > Math.ceil(Game.defenseOf(st, cap) * Game.CONFIG.attackFactor + Game.CONFIG.attackFlat) - 1,
    '都城攻占消耗按放大后的守备计价'
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[3] 战损：抢敌区，守方兵力跟着掉；中立区不掉');
{
  const st = Game.createState(map, { seed });
  Game.startGame(st);
  const me = 0;
  const enemy = 1;
  st.players[me].troops = 9999;

  // 找一块与 0 号接壤、属于 1 号的普通地（非都城）
  const target = st.regions.find(
    (r) => r.owner === enemy && r.capitalOf < 0 && r.neighbors.some((n) => st.regions[n].owner === me)
  );
  if (!target) {
    console.log('  - 这张图开局没有相邻敌区，构造一块');
    const bridge = st.regions.find((r) => r.neighbors.some((n) => st.regions[n].owner === me) && r.owner !== enemy);
    bridge.owner = enemy;
    bridge.capitalOf = -1;
    Game.recompute(st);
  }
  const t2 =
    target ||
    st.regions.find((r) => r.owner === enemy && r.capitalOf < 0 && r.neighbors.some((n) => st.regions[n].owner === me));

  const enemyBefore = st.players[enemy].troops;
  const cost = Game.attackCost(st, t2, me);
  const res = Game.attack(st, me, t2.id);
  ok(res.ok, '攻下相邻敌区', res);
  const lost = enemyBefore - st.players[enemy].troops;
  ok(
    Math.abs(lost - Math.min(enemyBefore, cost * Game.CONFIG.lossRatio)) < 0.11,
    '守方兵力损失 = 攻方花费 × lossRatio',
    { lost, expect: cost * Game.CONFIG.lossRatio, cost }
  );

  // 中立区不该产生战损
  const st2 = Game.createState(map, { seed });
  Game.startGame(st2);
  st2.players[0].troops = 9999;
  const neutral = st2.regions.find((r) => r.owner === null && r.neighbors.some((n) => st2.regions[n].owner === 0));
  const before = st2.players.map((p) => p.troops);
  const r2 = Game.attack(st2, 0, neutral.id);
  ok(r2.ok, '攻下相邻中立区', r2);
  ok(
    st2.players.slice(1).every((p, i) => p.troops === before[i + 1]),
    '打中立区不产生战损'
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[4] 斩首：打掉都城 → 当场出局 + 领土全部回中立');
{
  const st = Game.createState(map, { seed, endOnHumansOut: false });
  Game.startGame(st);
  const me = 0;
  const victim = 2;
  const cap = st.regions.find((r) => r.capitalOf === victim);

  // 造一条接壤通道：把首都的一个邻居划给自己
  const n = st.regions[cap.neighbors[0]];
  n.owner = me;
  Game.recompute(st);
  st.players[me].troops = 9999;

  const victimRegionsBefore = st.players[victim].regionCount;
  const cost = Game.attackCost(st, cap, me);
  const res = Game.attack(st, me, cap.id);

  ok(res.ok, '斩首攻击成功执行', res);
  ok(res.capital === true, '返回值标记了这是一次斩首');
  ok(cost > 0, `都城要价 ${cost} 兵（普通地同面积约 ${Math.ceil(cost / Game.CONFIG.capitalDefense)}）`);
  ok(!st.players[victim].alive, '守方当场出局');
  ok(st.players[victim].capitalLost === true, '守方标记 capitalLost');
  ok(st.players[victim].capital === -1, '守方 capital 字段清空');
  ok(st.regions[cap.id].capitalOf === -1, '被攻破的都城不再挂都城标记');
  ok(st.regions[cap.id].owner === me, '都城归攻方');
  ok(
    st.regions.filter((r) => r.owner === victim).length === 0,
    '守方所有领地回中立',
    { before: victimRegionsBefore }
  );
  ok(
    st.events.some((e) => e.type === 'capital' && e.player === victim && e.by === me),
    '发出 capital 事件'
  );
  ok(
    st.events.some((e) => e.type === 'eliminated' && e.player === victim && e.capital),
    '发出的 eliminated 事件带 capital 标记（客户端据此不再重复提示）'
  );
  ok(
    st.regions.filter((r) => r.capitalOf >= 0).length === 3,
    '场上只剩 3 座都城'
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 最后一人靠斩首收尾 → endReason = capital');
{
  const st = Game.createState(map, { seed, endOnHumansOut: false });
  Game.startGame(st);
  const me = 0;
  // 手动把 1、3 号判出局，只留 0 和 2
  for (const idx of [1, 3]) {
    st.players[idx].alive = false;
    for (const r of st.regions) if (r.owner === idx) r.owner = null;
  }
  Game.recompute(st);

  const cap = st.regions.find((r) => r.capitalOf === 2);
  st.regions[cap.neighbors[0]].owner = me;
  Game.recompute(st);
  st.players[me].troops = 9999;

  Game.attack(st, me, cap.id);
  ok(st.phase === 'ended', '对局结束');
  ok(st.winner === me, '胜者是斩首方');
  ok(st.endReason === 'capital', '结束原因 = capital', { got: st.endReason });
}

/* ------------------------------------------------------------------ */
console.log('\n[6] 都城被攻破后，那块地可以正常易手（不会卡住）');
{
  const st = Game.createState(map, { seed, endOnHumansOut: false });
  Game.startGame(st);
  const me = 0;
  const victim = 1;
  const cap = st.regions.find((r) => r.capitalOf === victim);
  st.regions[cap.neighbors[0]].owner = me;
  Game.recompute(st);
  st.players[me].troops = 9999;
  Game.attack(st, me, cap.id);

  const third = 3;
  const nb = cap.neighbors.find((x) => st.regions[x].owner === third) ?? cap.neighbors[1];
  st.regions[nb].owner = third;
  Game.recompute(st);
  st.players[third].troops = 9999;
  const res = Game.attack(st, third, cap.id);
  ok(res.ok, '第三方能抢走已失守的都城地', res);
  ok(res.capital === false, '这一次是普通占领，不再触发斩首');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
