/**
 * server/index.mjs —— 权威服务端（静态资源 + WebSocket 同端口）
 *
 * 设计要点（对应技术文档第 6 节）：
 *   - 服务端权威：客户端只发 attack / upgrade，所有结算在服务端做
 *   - 20Hz 逻辑 tick，10Hz 广播快照；有事件时立刻补一帧
 *   - 房间制：4 位邀请码，最多 4 个真人，空位用 AI 补满
 *   - 断线重连：token 续座；掉线 8 秒后交给 AI 托管，回来立刻接管
 *   - 指令限流：攻击 90ms 冷却 + 令牌桶，防连点
 */

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { generateRegions } from '../src/mapgen.js';
import * as Game from '../src/game.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* 端口固定 5173。
   只有两种「显式」写法才会偏离：`TD_PORT=5180` 或 `node server/index.mjs 5180`。
   系统里的通用 PORT 变量不再生效——别的工具随手 export PORT 时，
   正式服不会被顶到奇怪端口上去（历史上 5174/5176 就是这么来的）。 */
const DEFAULT_PORT = 5173;
const override = process.env.TD_PORT || process.argv[2] || '';
const PORT = Number(override || DEFAULT_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`✗ 端口不合法：${override}（应为 1-65535 的整数）`);
  process.exit(1);
}
if (override && PORT !== DEFAULT_PORT) {
  console.warn(`⚠️  端口被显式覆盖为 ${PORT}（默认固定 ${DEFAULT_PORT}，仅测试用）`);
}

// 调试用：TD_DURATION=30 可以把一局压缩到半分钟
if (process.env.TD_DURATION) Game.CONFIG.duration = Number(process.env.TD_DURATION);

const TICK_MS = 50; // 逻辑 20Hz
const SNAP_EVERY = 2; // 快照 10Hz
const COUNTDOWN_SEC = 3;
const DISCONNECT_GRACE = 8000; // 掉线多久交给 AI 托管
const LOBBY_DROP_MS = 8000; // 大厅里掉线多久清座
const ROOM_IDLE_MS = 90000; // 全员掉线多久回收房间
const BOT_SLACK = 1.0; // AI 补位强度

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = normalize(join(ROOT, url === '/' ? '/index.html' : url));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + url);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ */
/* 房间                                                                */
/* ------------------------------------------------------------------ */

/** 房间码：去掉易混的 I/O/0/1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
/** token -> member，用于断线续座 */
const tokens = new Map();

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  } while (rooms.has(code));
  return code;
}

function sanitizeName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 10);
  return s || '玩家';
}

class Room {
  constructor(code) {
    this.code = code;
    /** 下一局有座位的真人，最多 4 个 */
    this.members = [];
    /** 坐满之后进来的人：只能看 */
    this.watchers = [];
    this.phase = 'lobby'; // lobby | countdown | playing | ended
    this.state = null;
    this.seed = 0;
    this.slots = new Map(); // memberId -> 座位号
    this.tick = 0;
    this.countdownEnd = 0;
    this.resetAt = 0;
    this.emptySince = 0;
    this.createdAt = Date.now();
  }

  get host() {
    return this.members.find((m) => m.ws) || this.members[0] || null;
  }

  humanCount() {
    return this.members.length;
  }
}

function createRoom(code) {
  const room = new Room(code || makeCode());
  rooms.set(room.code, room);
  return room;
}

function dropRoom(room) {
  rooms.delete(room.code);
  for (const m of [...room.members, ...room.watchers]) {
    m.room = null;
    m.slot = -1;
  }
}

function seatOf(room, member) {
  const s = room.slots.get(member.id);
  return s === undefined ? -1 : s;
}

function isHost(room, member) {
  return room.host === member;
}

/* ------------------------------------------------------------------ */
/* 收发                                                                */
/* ------------------------------------------------------------------ */

function send(member, obj) {
  if (!member.ws || member.ws.readyState !== 1) return;
  try {
    member.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  } catch {
    /* 忽略发送失败，close 事件会处理 */
  }
}

function broadcast(room, obj) {
  const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const m of [...room.members, ...room.watchers]) {
    if (m.ws && m.ws.readyState === 1) {
      try {
        m.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

function roomView(room, me) {
  const host = room.host;
  const inRoom = room.members.includes(me);
  const slot = room.slots.has(me.id) ? room.slots.get(me.id) : inRoom ? room.members.indexOf(me) : -1;
  return {
    t: 'room',
    code: room.code,
    phase: room.phase,
    you: {
      name: me.name,
      slot,
      host: host === me,
      watching: room.watchers.includes(me),
      seated: inRoom,
    },
    members: room.members.map((m, i) => ({
      name: m.name,
      seat: i,
      host: m === host,
      me: m === me,
      online: !!m.ws,
      bot: false,
    })),
    watchers: room.watchers.length,
    countdown: room.countdownEnd ? Math.max(0, Math.ceil((room.countdownEnd - Date.now()) / 1000)) : 0,
  };
}

function broadcastRoom(room) {
  for (const m of [...room.members, ...room.watchers]) send(m, roomView(room, m));
}

function commandResult(member, ok, reason) {
  if (!member) return;
  send(member, { t: 'cmd', ok, reason: reason || '' });
}

/* ------------------------------------------------------------------ */
/* 开局                                                                */
/* ------------------------------------------------------------------ */

function botName(seat, used) {
  const base = Game.PLAYER_NAMES[seat] || `AI${seat + 1}`;
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}${i++}`;
  used.add(name);
  return name;
}

/** 开局 / 中途补人共用的「整局初始数据」 */
function startMessage(room, member) {
  const s = room.state;
  return {
    t: 'start',
    you: seatOf(room, member),
    seed: room.seed,
    duration: Game.CONFIG.duration,
    /** 倒计时阶段的预览：牌面已经摆好，但还不能动手 */
    preview: room.phase === 'countdown',
    players: s.players.map((p) => ({ name: p.name, color: p.color, isBot: p.isBot })),
    map: {
      radius: s.map.radius,
      regions: s.map.regions.map((r) => ({
        id: r.id,
        polygon: r.polygon,
        center: r.center,
        area: r.area,
        areaWeight: r.areaWeight,
        neighbors: r.neighbors,
        height: r.height,
      })),
    },
  };
}

/** 摆好牌面：建图 + 分座位 + 下发 start。真正开跑由 goLive 决定 */
function buildMatch(room) {
  // 只给还在线的人分座位：刷新中的残座不该占名额
  const humans = room.members.filter((m) => m.ws).slice(0, Game.MAX_PLAYERS);
  if (!humans.length) return false;
  room.members = humans.concat(room.members.filter((m) => !m.ws));

  const used = new Set(humans.map((m) => m.name));
  const seats = humans.map((m) => ({ name: m.name, isBot: false }));
  while (seats.length < Game.MAX_PLAYERS) {
    seats.push({ name: botName(seats.length, used), isBot: true });
  }

  const seed = (Math.random() * 1e9) | 0;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  const state = Game.createState(map, { seed, seats, endOnHumansOut: false });
  for (const p of state.players) if (p.isBot) p.skill = BOT_SLACK;

  room.state = state;
  room.seed = seed;
  room.tick = 0;
  room.resetAt = 0;
  room.slots = new Map(humans.map((m, i) => [m.id, i]));
  for (const m of room.members) m.slot = seatOf(room, m);

  for (const m of [...room.members, ...room.watchers]) send(m, startMessage(room, m));
  broadcastState(room, []); // 先把起始地盘摆给所有人看
  console.log(`[room ${room.code}] 摆好牌面 种子=${seed} 座位=${seats.map((s) => s.name).join('/')}`);
  return true;
}

/** 倒计时结束，正式开跑 */
function goLive(room) {
  room.phase = 'playing';
  room.countdownEnd = 0;
  room.lastTick = 0; // 免得把倒计时的时长当成第一帧的 dt
  Game.startGame(room.state);
  for (const m of [...room.members, ...room.watchers]) send(m, startMessage(room, m));
  broadcastState(room, []);
  console.log(`[room ${room.code}] 开打`);
}

function resetRoom(room, { silent = false } = {}) {
  room.phase = 'lobby';
  room.state = null;
  room.slots = new Map();
  room.resetAt = 0;
  room.countdownEnd = 0;
  room.tick = 0;
  room.lastTick = 0;
  for (const m of room.members) m.slot = -1;
  // 只留还在线的人占座
  room.members = room.members.filter((m) => m.ws);
  // 观战者重新排队
  room.watchers = room.watchers.filter((m) => m.ws);
  // 上一局没座位的观战者，这一局优先补进来
  while (room.members.length < Game.MAX_PLAYERS && room.watchers.length) {
    room.members.push(room.watchers.shift());
  }
  if (!silent) broadcastRoom(room);
}

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

function snapshotOf(room, events) {
  const s = room.state;
  return {
    t: 'state',
    tick: room.tick,
    phase: s.phase,
    time: Math.round(s.time * 100) / 100,
    elapsed: Math.round(s.elapsed * 100) / 100,
    winner: s.winner,
    endReason: s.endReason || null,
    owners: s.regions.map((r) => (r.owner === null ? -1 : r.owner)),
    // 每家都城在哪块地上：客户端据此画首都标记、算折后价；-1 = 普通地块
    capitals: s.regions.map((r) => r.capitalOf),
    players: s.players.map((p) => ({
      name: p.name,
      color: p.color,
      alive: p.alive,
      weight: Math.round(p.weight * 100) / 100,
      regionCount: p.regionCount,
      troops: Math.round(p.troops * 10) / 10,
      gold: Math.round(p.gold * 10) / 10,
      troopCap: Math.round(p.troopCap * 10) / 10,
      troopRate: Math.round(p.troopRate * 100) / 100,
      goldRate: Math.round(p.goldRate * 100) / 100,
      farm: p.farm,
      market: p.market,
      barracks: p.barracks,
      isBot: p.isBot,
      connected: p.connected,
      capital: p.capital,
      capitalLost: p.capitalLost,
    })),
    events,
  };
}

function broadcastState(room, events) {
  if (!room.state) return;
  broadcast(room, snapshotOf(room, events));
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

function tickRoom(room, nowMs) {
  /**
   * 用「真实经过时间」当 dt，而不是固定 50ms。
   * 定时器在机器忙的时候会被推迟（实测 SwiftShader 满载时一局 25 秒能拖成 70 秒），
   * 固定 dt 会让对局时长跟着 CPU 负载飘。上限 0.25 秒，避免长时间卡顿后一次补太多。
   */
  const real = room.lastTick ? (nowMs - room.lastTick) / 1000 : TICK_MS / 1000;
  room.lastTick = nowMs;
  const dt = Math.max(0.005, Math.min(0.25, real));

  // 倒计时
  if (room.phase === 'countdown' && nowMs >= room.countdownEnd) {
    if (room.state && room.members.some((m) => m.ws)) goLive(room);
    else resetRoom(room);
    return;
  }

  // 结算后自动回大厅
  if (room.phase === 'ended' && room.resetAt && nowMs >= room.resetAt) {
    resetRoom(room);
    return;
  }

  if (room.phase !== 'playing' || !room.state) {
    cleanupMembers(room, nowMs);
    return;
  }

  const s = room.state;

  // 掉线托管 / 连接状态
  for (const m of room.members) {
    const slot = seatOf(room, m);
    if (slot < 0) continue;
    const p = s.players[slot];
    if (!p) continue;
    p.connected = !!m.ws;
    if (!m.ws) {
      if (!p.isBot && nowMs - (m.leftAt || nowMs) > DISCONNECT_GRACE) {
        p.isBot = true;
        p.skill = BOT_SLACK;
        console.log(`[room ${room.code}] ${p.name} 掉线超时，AI 托管`);
      }
    } else if (p.isBot) {
      // 重连后立刻收回控制权
      p.isBot = false;
    }
  }

  Game.step(s, dt);
  Game.botTick(s, s.elapsed);
  room.tick++;

  // AI 代打的玩家不掉线标记
  const events = s.events.splice(0, s.events.length);
  if (s.phase === 'ended') {
    room.phase = 'ended';
    room.resetAt = nowMs + 9000;
    broadcastState(room, events);
    const winner = s.winner === null ? '无人' : s.players[s.winner].name;
    console.log(`[room ${room.code}] 结束 胜者=${winner}`);
    return;
  }

  if (events.length || room.tick % SNAP_EVERY === 0) broadcastState(room, events);
  cleanupMembers(room, nowMs);
}

function cleanupMembers(room, nowMs) {
  // 大厅里掉线太久的人让出座位
  if (room.phase === 'lobby' || room.phase === 'countdown') {
    const dropped = room.members.filter((m) => !m.ws && nowMs - (m.leftAt || nowMs) > LOBBY_DROP_MS);
    if (dropped.length) {
      room.members = room.members.filter((m) => !dropped.includes(m));
      if (room.phase === 'countdown' && room.members.filter((m) => m.ws).length === 0) {
        room.phase = 'lobby';
        room.countdownEnd = 0;
      }
      // 从观战队列补位
      while (room.members.length < Game.MAX_PLAYERS && room.watchers.length) {
        const w = room.watchers.shift();
        if (w.ws) room.members.push(w);
      }
      broadcastRoom(room);
    }
  }

  const anyOnline = room.members.some((m) => m.ws) || room.watchers.some((m) => m.ws);
  if (!anyOnline) {
    if (!room.emptySince) room.emptySince = nowMs;
    else if (nowMs - room.emptySince > ROOM_IDLE_MS) dropRoom(room);
  } else {
    room.emptySince = 0;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) tickRoom(room, now);
}, TICK_MS).unref?.();

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  /** @type {any} */
  const member = {
    id: randomUUID(),
    token: randomUUID().replace(/-/g, ''),
    name: '玩家',
    ws,
    room: null,
    slot: -1,
    leftAt: 0,
    lastAttack: 0,
    lastUpgrade: 0,
    bucket: { t: 0, n: 8 },
    keepSeat: false,
  };

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(member, msg);
    } catch (err) {
      console.error('处理消息出错', msg.t, err);
    }
  });

  ws.on('close', () => {
    if (member.ws !== ws) return; // 已经被新连接顶掉
    member.ws = null;
    member.leftAt = Date.now();
    member.keepSeat = true;
    if (member.room) {
      broadcastRoom(member.room);
    }
  });

  ws.on('error', () => {
    /* close 会跟着来 */
  });

  send(member, { t: 'hello', id: member.id });
});

function handle(member, msg) {
  switch (msg.t) {
    /* ---------------- 身份 ---------------- */
    case 'hello': {
      // 带 token 回来 = 断线重连
      if (msg.token && tokens.has(msg.token)) {
        const prev = tokens.get(msg.token);
        if (prev && prev !== member) {
          // 把旧连接上的房间/座位搬过来
          prev.ws = null;
          member.id = prev.id;
          member.token = prev.token;
          member.name = prev.name;
          member.room = prev.room;
          member.slot = prev.slot;
          member.keepSeat = true;
          if (member.room) {
            const room = member.room;
            const idx = room.members.indexOf(prev);
            if (idx >= 0) room.members[idx] = member;
            const widx = room.watchers.indexOf(prev);
            if (widx >= 0) room.watchers[widx] = member;
            const p = room.state && room.slots.has(member.id) ? room.state.players[seatOf(room, member)] : null;
            if (p) {
              p.isBot = false;
              p.connected = true;
            }
          }
        } else {
          member.token = msg.token;
          if (msg.name) member.name = sanitizeName(msg.name);
        }
      } else if (msg.name) {
        member.name = sanitizeName(msg.name);
      }
      tokens.set(member.token, member);
      send(member, { t: 'welcome', id: member.id, token: member.token, name: member.name });

      if (member.room) {
        const room = member.room;
        send(member, roomView(room, member));
        if (room.state && (room.phase === 'playing' || room.phase === 'ended')) {
          // 补一帧完整状态，客户端不用等下一帧
          send(member, startMessage(room, member));
          broadcastState(room, []);
        }
      }
      break;
    }

    /* ---------------- 房间 ---------------- */
    case 'join': {
      if (member.room) leaveRoom(member);
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      let room = code ? rooms.get(code) : null;

      if (code && !room) room = createRoom(code);
      if (!room) {
        // 快速匹配：找一个还在大厅、有空位的房间
        room = [...rooms.values()].find(
          (r) => r.phase === 'lobby' && r.members.length < Game.MAX_PLAYERS && r.members.some((m) => m.ws)
        );
      }
      if (!room) room = createRoom(makeCode());

      member.room = room;
      member.keepSeat = true;

      if (room.phase === 'lobby' || room.phase === 'countdown') {
        if (room.members.length < Game.MAX_PLAYERS) room.members.push(member);
        else room.watchers.push(member);
      } else if (room.members.length < Game.MAX_PLAYERS && room.phase === 'ended') {
        room.members.push(member);
      } else {
        room.watchers.push(member);
      }

      send(member, roomView(room, member));
      broadcastRoom(room);

      // 中途进来的人也要拿到当前局面（观战）
      if (room.state) {
        send(member, startMessage(room, member));
        broadcastState(room, []);
      }
      break;
    }

    case 'start': {
      const room = member.room;
      if (!room) return;
      if (room.phase !== 'lobby') return;
      if (!isHost(room, member)) return commandResult(member, false, '只有房主能开局');
      if (!room.members.length) return;
      room.phase = 'countdown';
      room.countdownEnd = Date.now() + COUNTDOWN_SEC * 1000;
      if (!buildMatch(room)) {
        room.phase = 'lobby';
        room.countdownEnd = 0;
        return;
      }
      broadcast(room, { t: 'countdown', sec: COUNTDOWN_SEC });
      broadcastRoom(room);
      break;
    }

    case 'again': {
      const room = member.room;
      if (!room || room.phase !== 'ended') return;
      resetRoom(room);
      break;
    }

    case 'rename': {
      const name = sanitizeName(msg.name);
      if (!name) return;
      member.name = name;
      const room = member.room;
      if (room) {
        const slot = seatOf(room, member);
        if (room.state && slot >= 0) room.state.players[slot].name = name;
        broadcastRoom(room);
      }
      break;
    }

    case 'leave': {
      leaveRoom(member);
      break;
    }

    /* ---------------- 指令 ---------------- */
    case 'attack': {
      const room = member.room;
      if (!room || room.phase !== 'playing' || !room.state) return;
      const slot = seatOf(room, member);
      if (slot < 0) return commandResult(member, false, '你正在观战');
      const now = Date.now();
      if (now - member.lastAttack < 90) return; // 静默丢弃连点
      if (!takeToken(member, now)) return commandResult(member, false, '手速太快');
      member.lastAttack = now;
      const res = Game.attack(room.state, slot, msg.id | 0);
      commandResult(member, res.ok, res.reason);
      if (res.ok) broadcastState(room, room.state.events.splice(0, room.state.events.length));
      break;
    }

    case 'upgrade': {
      const room = member.room;
      if (!room || room.phase !== 'playing' || !room.state) return;
      const slot = seatOf(room, member);
      if (slot < 0) return commandResult(member, false, '你正在观战');
      const now = Date.now();
      if (now - member.lastUpgrade < 60) return;
      if (!takeToken(member, now)) return commandResult(member, false, '手速太快');
      member.lastUpgrade = now;
      const res = Game.upgrade(room.state, slot, msg.type);
      commandResult(member, res.ok, res.reason);
      if (res.ok) broadcastState(room, room.state.events.splice(0, room.state.events.length));
      break;
    }

    /* ---------------- 心跳 ---------------- */
    case 'ping':
      send(member, { t: 'pong', ts: msg.ts });
      break;

    default:
      break;
  }
}

function takeToken(member, now) {
  const b = member.bucket;
  if (now - b.t > 1000) {
    b.t = now;
    b.n = 8;
  }
  if (b.n <= 0) return false;
  b.n--;
  return true;
}

function leaveRoom(member) {
  const room = member.room;
  if (!room) return;
  room.members = room.members.filter((m) => m !== member);
  room.watchers = room.watchers.filter((m) => m !== member);
  member.room = null;
  member.slot = -1;
  member.keepSeat = false;
  if (room.phase === 'lobby' && room.members.length === 0) {
    dropRoom(room);
  } else {
    broadcastRoom(room);
  }
}

/* 心跳：踢掉僵死连接 + 清理长期不回来的 token */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [token, m] of tokens) {
    if (!m.ws && !m.room && now - (m.leftAt || 0) > 600000) tokens.delete(token);
  }
}, 30000).unref?.();

function onServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ 端口 ${PORT} 已被占用，服务没有启动。`);
    console.error('  多半是上一次的进程还活着。查一下占用者：');
    console.error(`    Windows:  netstat -ano | findstr :${PORT}`);
    console.error(`    macOS/Linux: lsof -i :${PORT}`);
    console.error('  然后结束它（Windows 用 taskkill /PID <pid> /F）。');
    console.error(`  只想临时换端口：TD_PORT=5180 node server/index.mjs\n`);
    process.exit(1);
  }
  throw err;
}

// 注意：ws 会把 http server 的 error 转发到 WebSocketServer 上再 emit 一次，
// 只在 server 上挂监听仍会被那个未处理的 'error' 抛死，两边都要挂。
server.on('error', onServerError);
wss.on('error', onServerError);

server.listen(PORT, () => {
  console.log(`抢地盘 server → http://localhost:${PORT}  (ws: /ws)`);
  if (PORT !== DEFAULT_PORT) console.log(`   （非默认端口，正式开服请用 ${DEFAULT_PORT}）`);
});
