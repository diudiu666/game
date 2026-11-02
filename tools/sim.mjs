/**
 * 无头模拟：4 个 AI 自动打一局，检查规则与节奏是否可玩。
 * 用法: node tools/sim.mjs [seed]
 */
import { generateRegions } from '../src/mapgen.js';
import { createState, startGame, step, botTick, ranking } from '../src/game.js';

const seed = Number(process.argv[2] || 20261030);
const { regions } = generateRegions({ seed, count: 62, radius: 46 });
const state = createState({ regions }, { seed });
// 全 AI 对局
for (const p of state.players) p.isBot = true;
startGame(state);

const dt = 1 / 30;
let now = 0;
let lastLog = 0;
while (state.phase === 'playing' && now < 400) {
  step(state, dt);
  botTick(state, now);
  now += dt;
  if (now - lastLog >= 20) {
    lastLog = now;
    const s = ranking(state)
      .map((p) => `${p.name}:${p.regionCount}区 W${p.weight.toFixed(1)} 兵${p.troops.toFixed(0)}/${p.troopCap.toFixed(0)} 金${p.gold.toFixed(0)} 农${p.farm}/市${p.market}/营${p.barracks}${p.alive ? '' : '(出局)'}`)
      .join(' | ');
    console.log(`t=${now.toFixed(0)}s  ${s}`);
  }
}

console.log('---- 结果 ----');
console.log('phase', state.phase, 'winner', state.players[state.winner]?.name, '用时', state.elapsed.toFixed(1) + 's');
console.log('事件数', state.events.length, '攻击', state.events.filter((e) => e.type === 'attack').length, '升级', state.events.filter((e) => e.type === 'upgrade').length);
console.log('占领分布', state.regions.reduce((m, r) => { const k = r.owner === null ? '中立' : state.players[r.owner].name; m[k] = (m[k] || 0) + 1; return m; }, {}));
