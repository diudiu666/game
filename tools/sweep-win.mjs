/** 扫 300 张图：全清后是否一定结束、是否出现「0 地但还活着」的幽灵玩家 */
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

let bad = 0, ghostCase = 0;
for (let s = 1; s <= 300; s++) {
  const seed = s * 7919;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const st = Game.createState(map, { seed, playerCount: 4, humanName: '你', endOnHumansOut: true });
  Game.startGame(st);
  const me = 0;
  let guard = 0;
  while (st.phase === 'playing' && guard++ < 3000) {
    st.players[me].troops = 9999;
    let acted = false;
    for (const r of st.regions) {
      if (r.owner === me) continue;
      if (!r.neighbors.some((n) => st.regions[n].owner === me)) continue;
      if (Game.attack(st, me, r.id).ok) { acted = true; break; }
    }
    if (!acted) break;
    Game.step(st, 0.05);
  }
  const ghost = st.players.filter((p) => p.alive && p.regionCount === 0);
  if (st.phase === 'playing') {
    bad++;
    if (bad <= 5) console.log('未结束 seed', seed, '我占', st.players[me].regionCount, '/', st.regions.length, '中立', st.regions.filter((r) => r.owner === null).length, 'ghost', ghost.length);
  }
  if (ghost.length) { ghostCase++; if (ghostCase <= 3) console.log('幽灵存活 seed', seed, JSON.stringify(ghost.map((g) => g.index)), 'phase', st.phase); }
}
console.log('样本 300 | 清完仍未结束:', bad, '| 出现 0 地存活:', ghostCase);
