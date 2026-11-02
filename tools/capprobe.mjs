import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

const GAMES = Number(process.argv[2] || 12);
const dt = 1/30;
let opp = 0, affordable = 0, attacksCap = 0, attacksAll = 0;
const end = [];

for (let g=0; g<GAMES; g++) {
  const seed = 90001 + g*7919;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState(map, { seed, endOnHumansOut:false, seats:[{name:'A',isBot:true},{name:'B',isBot:true},{name:'C',isBot:true},{name:'D',isBot:true}] });
  Game.startGame(st);
  let next = 0, guard = 0;
  while (st.phase === 'playing' && guard++ < 40000) {
    Game.step(st, dt);
    Game.botTick(st, st.elapsed);
    for (const ev of st.events) if (ev.type==='attack') { attacksAll++; if (ev.capital) attacksCap++; }
    st.events.length = 0;
    if (st.elapsed >= next) {
      next += 1;
      for (const p of st.players) {
        if (!p.alive) continue;
        for (const r of st.regions) {
          if (r.capitalOf < 0 || r.owner === p.index || r.owner === null) continue;
          if (!r.neighbors.some(n => st.regions[n].owner === p.index)) continue;
          opp++;
          if (p.troops >= Game.attackCost(st, r, p.index)) affordable++;
        }
      }
    }
  }
  const alive = st.players.filter(p=>p.alive).map(p=>p.regionCount).sort((a,b)=>a-b);
  end.push(`${alive.join('/')}`);
}
console.log('相邻敌都城的「玩家·秒」机会:', opp, '| 其中兵力够:', affordable, `(${(affordable/Math.max(1,opp)*100).toFixed(1)}%)`);
console.log('总攻击', attacksAll, '| 打都城', attacksCap);
console.log('终局各玩家领地数:', end.join('  '));
