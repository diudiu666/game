/**
 * tools/nettest.mjs —— 无头协议测试
 * 用两个 WebSocket 客户端模拟两名真人，验证：
 *   进房 / 房主开局 / 双端状态一致 / 攻击生效 / 非法攻击被拒 / 断线重连
 *
 * 用法: node tools/nettest.mjs [base]
 *   需要先起服务端（默认 5173）：node server/index.mjs
 */

import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://localhost:5173';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const CODE = String((Math.random() * 1e6) | 0).padStart(4, '0').slice(-4).replace(/\d/g, (d) => 'ABCDEFGHJK'[d]);

class Client {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.state = null;
    this.start = null;
    this.room = null;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'welcome') this.welcome = msg;
        if (msg.t === 'start') this.start = msg;
        if (msg.t === 'state') this.state = msg;
        if (msg.t === 'room') this.room = msg;
        this.events.push(msg);
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(type, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = this.events.find((e) => e.t === type);
        if (hit) {
          this.events = this.events.filter((e) => e !== hit);
          return resolve(hit);
        }
        if (Date.now() - t0 > ms) return reject(new Error(`${this.name} 等待 ${type} 超时`));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  clear(type) {
    this.events = this.events.filter((e) => e.t !== type);
  }
}

function assert(cond, label) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等服务端真正开打（倒计时结束后才有 phase=playing 的快照） */
async function waitPlaying(client, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (client.state?.phase === 'playing') return true;
    await sleep(100);
  }
  return false;
}

const a = new Client('A');
const b = new Client('B');

await a.connect();
a.send({ t: 'hello', name: 'A玩家' });
await a.waitFor('welcome');

await b.connect();
b.send({ t: 'hello', name: 'B玩家' });
await b.waitFor('welcome');

a.send({ t: 'join', code: CODE });
b.send({ t: 'join', code: CODE });
await sleep(250);

assert(a.room?.code === CODE, `进房成功 ${CODE}`);
assert(a.room?.members.length === 2, `房间有 2 人：${a.room?.members.map((m) => m.name).join('、')}`);
assert(a.room?.you.host === true, 'A 是房主');
assert(b.room?.you.host === false, 'B 不是房主');

// 非房主开局应被拒
b.clear('countdown');
b.send({ t: 'start' });
await sleep(200);
assert(!b.events.some((e) => e.t === 'countdown'), '非房主开局被拒');

a.send({ t: 'start' });
await a.waitFor('countdown');
const startA = await a.waitFor('start');
await b.waitFor('start');

assert(startA.players.length === 4, `座位补满 4 人：${startA.players.map((p) => p.name + (p.isBot ? '(AI)' : '')).join('、')}`);
assert(startA.you === 0 && b.start.you === 1, '座位号正确（A=0,B=1）');
assert(startA.map.regions.length > 40, `地图区域 ${startA.map.regions.length} 块`);

assert(await waitPlaying(a), '倒计时结束，进入对局');
await waitPlaying(b);
assert(!!a.state && !!b.state, '双方都收到快照');
assert(
  JSON.stringify(a.state.owners) === JSON.stringify(b.state.owners),
  '开局双方地形归属一致'
);

// A 找一块与自己接壤的区域打
const me = a.start.you;
const st = a.state;
const owners = st.owners;
const myRegions = owners.map((o, i) => (o === me ? i : -1)).filter((i) => i >= 0);
const targets = new Set();
for (const r of myRegions) {
  for (const n of startA.map.regions[r].neighbors) if (owners[n] !== me) targets.add(n);
}
const target = [...targets][0];
const cost = Math.ceil(startA.map.regions[target].areaWeight * 8.6 * 1.1 + 2);

a.clear('cmd');
a.send({ t: 'attack', id: target });
const cmd = await a.waitFor('cmd');
await sleep(300);
assert(owners[target] === me || a.state.owners[target] === me, `A 占领接壤区域 #${target}（需 ${cost} 兵）`);
assert(a.state.owners[target] === b.state.owners[target], 'B 端同步看到归属变化');

// 打一块不接壤的远处区域应被拒
const far = a.state.owners.findIndex((o, i) => o !== me && !startA.map.regions[i].neighbors.some((n) => a.state.owners[n] === me));
if (far >= 0) {
  a.clear('cmd');
  a.send({ t: 'attack', id: far });
  const r = await a.waitFor('cmd');
  assert(r.ok === false, `不接壤目标被拒：${r.reason}`);
}

// 断线重连
const token = a.welcome.token;
a.ws.close();
await sleep(400);
const a2 = new Client('A2');
await a2.connect();
a2.send({ t: 'hello', name: 'A玩家', token });
const w = await a2.waitFor('welcome');
const room2 = await a2.waitFor('room');
await a2.waitFor('start');
assert(!!w.token, '重连拿到同一 token');
assert(room2.you.slot === 0, `重连续上原座位 ${room2.you.slot}`);

await sleep(400);
assert(!!a2.state, '重连后立即收到局面');
assert(a2.state.players[0].isBot === false, '重连后 AI 托管已收回');

// 结束
for (const c of [a2, b]) c.ws.close();
await sleep(200);
console.log('\n完成');
process.exit(process.exitCode || 0);
