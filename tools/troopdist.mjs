/** 兵力占用的分布：如果要让「上限」真正生效，它应该设在哪个量级 */
import { generateRegions } from '../src/mapgen.js';
import { CONFIG, createState, startGame, step, botTick } from '../src/game.js';

const N = 10;
const dt = 1 / 30;
const samples = [];

for (let g = 0; g < N; g++) {
  const seed = 1013 + g * 7919;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const state = createState(map, { seed });
  for (const p of state.players) p.isBot = true;
  startGame(state);
  let now = 0;
  while (state.phase === 'playing' && now < CONFIG.duration + 5) {
    for (const p of state.players) {
      if (!p.alive) continue;
      samples.push(p.troops);
    }
    step(state, dt);
    botTick(state, now);
    now += dt;
  }
}

samples.sort((a, b) => a - b);
const q = (p) => samples[Math.floor(p * (samples.length - 1))];
console.log('样本', samples.length);
for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
  console.log(`p${(p * 100).toFixed(0)} = ${q(p).toFixed(1)} 兵`);
}
console.log('max', samples[samples.length - 1].toFixed(1));
for (const cap of [20, 26, 30, 36, 44, 60, 80]) {
  const over = samples.filter((t) => t > cap).length;
  console.log(`上限设 ${cap}: 会有 ${((over / samples.length) * 100).toFixed(1)}% 的时间在「溢出」`);
}
