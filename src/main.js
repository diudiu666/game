/**
 * main.js —— 胶水层：把规则 / 渲染 / HUD / 网络串起来
 *
 * 两种模式共用同一套渲染与 HUD：
 *   - net  ：服务端权威，客户端只发指令、收快照（最多 4 人联机）
 *   - solo ：规则跑在本地，前端直接调 Game（单人练习 / 断网兜底）
 */

import * as THREE from 'three';
import { generateRegions } from './mapgen.js';
import * as Game from './game.js';
import { createWorld } from './world3d.js';
import { HUD } from './ui.js';
import { createNet } from './net.js';

const NEUTRAL_FILL = '#6d7887';
const NEUTRAL_LINE = '#333e4d';
const HOVER_LINE = '#ffffff';
const NEIGHBOR_LINE = '#9db4d0';
const ATTACK_LINE = '#cfe0f5';

const canvas = document.getElementById('gl');
const hud = new HUD();
const world = createWorld(canvas);

const outlineColor = Game.COLORS.map((c) =>
  new THREE.Color(c).lerp(new THREE.Color('#ffffff'), 0.3).getStyle()
);

/* ------------------------------------------------------------------ */
/* 本地状态                                                            */
/* ------------------------------------------------------------------ */

let state = null;
let mode = 'solo'; // 'net' | 'solo'
let net = null;
let currentSeed = 0;
let isSpectator = false;
let endShown = false;
let hoverId = -1;
let pointer = null;
let pointerDirty = false;
let lastClick = -99;
let lastRoomSig = '';
let cdUntil = 0;

/** 刚被易手的区域：{ t0, color }，用来跑占领闪光的时间轴 */
const impacts = new Map();

const store = {
  get token() {
    return localStorage.getItem('td_token') || null;
  },
  set token(v) {
    if (v) localStorage.setItem('td_token', v);
  },
  get name() {
    return localStorage.getItem('td_name') || '';
  },
  set name(v) {
    localStorage.setItem('td_name', v);
  },
};

const urlParams = new URLSearchParams(location.search);
let wantRoom = (urlParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || null;

if (urlParams.get('name')) store.name = urlParams.get('name').slice(0, 10);
let myName = store.name || `玩家${Math.floor(Math.random() * 90 + 10)}`;

/* ------------------------------------------------------------------ */
/* 建图                                                                */
/* ------------------------------------------------------------------ */

function buildMap(map, seed) {
  world.resize();
  world.buildMap(map);
  world.resetCamera();
  currentSeed = seed;
  const home = world.homeView();
  world.camera.position.set(home.pos.x, home.pos.y * 1.5, home.pos.z * 1.72);
  world.controls.update();
  hoverId = -1;
  pointerDirty = false;
  impacts.clear();
  canvas.style.cursor = 'default';
}

/** 标题界面背后的展示用地图（四家已占地，像打了一半） */
function buildShowcase() {
  const seed = (Math.random() * 1e9) | 0;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  buildMap(map, seed);
  const demo = Game.createState(map, { seed, playerCount: 4, humanName: '你' });
  demo.phase = 'lobby';
  state = demo;
  isSpectator = false;
  refreshVisuals(nowSec());
}

/* ------------------------------------------------------------------ */
/* 状态合并                                                            */
/* ------------------------------------------------------------------ */

function makeViewState(msg) {
  return {
    regions: msg.map.regions.map((r) => ({
      id: r.id,
      owner: null,
      neighbors: r.neighbors,
      areaWeight: r.areaWeight,
      area: r.area,
      center: r.center,
      height: r.height,
      polygon: r.polygon,
    })),
    players: msg.players.map((p, i) => ({
      index: i,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
      connected: true,
      troops: 0,
      gold: 0,
      alive: true,
      weight: 0,
      regionCount: 0,
      troopRate: 0,
      goldRate: 0,
      troopCap: 0,
      farm: 0,
      market: 0,
      barracks: 0,
    })),
    viewIndex: msg.you,
    phase: 'playing',
    time: msg.duration,
    elapsed: 0,
    winner: null,
    events: [],
    map: msg.map,
  };
}

function applySnapshot(snap) {
  if (!state) return;
  // 已经在打单人局：房间那边可能还在跑（比如中途切出去单练），别让快照把本地局冲掉
  if (mode === 'solo') return;
  state.time = snap.time;
  state.elapsed = snap.elapsed;
  state.phase = snap.phase;
  state.winner = snap.winner;
  if (snap.endReason) state.endReason = snap.endReason;

  const n = Math.min(snap.owners.length, state.regions.length);
  for (let i = 0; i < n; i++) state.regions[i].owner = snap.owners[i] === -1 ? null : snap.owners[i];
  if (snap.capitals) {
    const m = Math.min(snap.capitals.length, state.regions.length);
    for (let i = 0; i < m; i++) state.regions[i].capitalOf = snap.capitals[i];
  }

  for (let i = 0; i < snap.players.length; i++) {
    const p = state.players[i];
    const s = snap.players[i];
    if (!p) continue;
    p.name = s.name;
    p.alive = s.alive;
    p.weight = s.weight;
    p.regionCount = s.regionCount;
    p.troops = s.troops;
    p.gold = s.gold;
    p.troopCap = s.troopCap;
    p.troopRate = s.troopRate;
    p.goldRate = s.goldRate;
    p.farm = s.farm;
    p.market = s.market;
    p.barracks = s.barracks;
    p.isBot = s.isBot;
    p.connected = s.connected;
    if (s.capital !== undefined) p.capital = s.capital;
    if (s.capitalLost !== undefined) p.capitalLost = s.capitalLost;
  }

  if (snap.events && snap.events.length) state.events.push(...snap.events);

  // 「结算」事件可能在上一次连接里就发过了，靠状态兜底
  if (snap.phase === 'ended' && !endShown) showEndCard(null);
}

function endReason(ev) {
  const reason = (ev && ev.reason) || state?.endReason;
  if (reason) return reason;
  if (isSpectator) return 'watch';
  const me = state.players[state.viewIndex];
  if (me && !me.alive) return 'defeat';
  return state.winner === state.viewIndex ? 'elimination' : 'timeout';
}

function showEndCard(reason) {
  if (endShown) return;
  endShown = true;
  // 结算后房间会重置回大厅，房号/成员都没变 → 签名一样会被当成“没变化”而卡在结算卡上
  lastRoomSig = '';
  setTimeout(() => {
    hud.showEnd(state, backToRoom, endReason(reason ? { reason } : null), {
      online: mode === 'net',
      onBack: mode === 'net' ? null : () => rejoinNet(),
    });
  }, 700);
}

/* ------------------------------------------------------------------ */
/* 视觉刷新                                                            */
/* ------------------------------------------------------------------ */

const nowSec = () => performance.now() / 1000;

/**
 * 名牌定位：每位玩家一个名字，落在自己地盘上，字号跟着地盘大小走。
 * 质心按面积权重算，再吸附到离质心最近的自家区域中心 —— 有飞地时质心可能落在别人地里。
 */
function syncNameLabels() {
  if (!state) return;
  const acc = new Map();
  for (const r of state.regions) {
    if (r.owner === null) continue;
    let a = acc.get(r.owner);
    if (!a) {
      a = { w: 0, x: 0, z: 0 };
      acc.set(r.owner, a);
    }
    a.w += r.areaWeight;
    a.x += r.center.x * r.areaWeight;
    a.z += -r.center.y * r.areaWeight;
  }

  const list = [];
  for (const [idx, a] of acc) {
    const p = state.players[idx];
    if (!p) continue;
    const cx = a.x / a.w;
    const cz = a.z / a.w;
    let best = null;
    let bestD = Infinity;
    for (const r of state.regions) {
      if (r.owner !== idx) continue;
      const dx = r.center.x - cx;
      const dz = -r.center.y - cz;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (!best) continue;
    list.push({
      key: idx,
      text: p.name,
      color: p.color,
      weight: p.weight > 0 ? p.weight : a.w,
      x: best.center.x,
      z: -best.center.y,
    });
  }
  world.syncLabels(list);
}

function refreshVisuals(now) {
  if (!state) return;
  const meIndex = isSpectator ? -1 : state.viewIndex;
  const hovered = hoverId >= 0 ? state.regions[hoverId] : null;
  const neighborHighlight = new Set(hovered ? hovered.neighbors : []);
  const pulse = 0.5 + 0.5 * Math.sin(now * 3.2);
  const playing = state.phase === 'playing';

  for (const r of state.regions) {
    const isHover = r.id === hoverId;
    const owned = r.owner !== null;
    const attackable = playing && meIndex >= 0 && r.owner !== meIndex && Game.canAttack(state, meIndex, r.id);

    let fill = owned ? state.players[r.owner].color : NEUTRAL_FILL;
    let glow = 0;

    if (owned && !state.players[r.owner].alive) fill = '#2b3442';

    if (attackable) glow = 0.09 + pulse * 0.08;

    // 刚被占领：先白热一下，再回落成新主人的颜色
    let hot = 0;
    const imp = impacts.get(r.id);
    if (imp) {
      const age = now - imp;
      if (age > 1.1) {
        impacts.delete(r.id);
      } else if (age < 0.075) {
        hot = 1;
        glow = 1.7;
      } else {
        const k = (age - 0.075) / 1.0;
        glow = Math.max(glow, 1.15 * Math.pow(1 - k, 2.6));
      }
    }
    if (hot) fill = '#ffffff';

    if (isHover) glow = Math.max(glow, 0.38);

    world.paint(r.id, fill, glow);

    let lineColor = owned ? outlineColor[r.owner] : NEUTRAL_LINE;
    let lineOpacity = owned ? 0.7 : 0.85;
    if (hot) {
      lineColor = '#ffffff';
      lineOpacity = 1;
    } else if (imp && now - imp < 0.4) {
      lineColor = '#ffffff';
      lineOpacity = 0.9;
    }
    if (attackable && !owned) {
      lineColor = ATTACK_LINE;
      lineOpacity = 0.28 + pulse * 0.32;
    }
    if (neighborHighlight.has(r.id)) {
      lineColor = NEIGHBOR_LINE;
      lineOpacity = 1;
    }
    if (isHover) {
      lineColor = HOVER_LINE;
      lineOpacity = 1;
    }
    world.setOutline(r.id, lineColor, lineOpacity);
    world.setPlate(r.id, '#ffffff', isHover ? 0.1 : 0);
  }

  syncCapitals();
  syncNameLabels();
}

/** 首都标记跟着归属走：地被抢走 / 玩家出局后标记自动消失 */
function syncCapitals() {
  if (!state) return;
  for (const r of state.regions) {
    const p = r.capitalOf >= 0 && r.owner !== null ? state.players[r.owner] : null;
    world.setCapital(r.id, p && p.alive ? p.color : null);
  }
}

/* ------------------------------------------------------------------ */
/* 事件（弹道、战报、结算）                                            */
/* ------------------------------------------------------------------ */

function drainEvents() {
  if (!state || !state.events.length) return;
  const events = state.events.splice(0, state.events.length);
  const meIndex = isSpectator ? -1 : state.viewIndex;

  for (const ev of events) {
    try {
      handleEvent(ev, meIndex);
    } catch (err) {
      // 单个事件（通常是特效）出错，不能连累同批里的结算事件
      console.warn('[event]', ev.type, err);
    }
  }
}

function handleEvent(ev, meIndex) {
  {
    // 斩首那一下：攻击表现只留弹道，剩下的（重闪、横幅、全城回中立）交给紧随其后的 capital 事件，
    // 否则同一个格子会被两套特效叠着播
    if (ev.type === 'attack' && ev.capital) {
      world.spawnAttack(ev.from, ev.to, ev.color);
      return;
    }

    if (ev.type === 'attack') {
      const stolen = ev.prevOwner !== null && ev.prevOwner !== undefined;
      const prev = stolen ? state.players[ev.prevOwner] : null;
      const wiped = !!prev && !prev.alive; // 这一击把人打没了
      const mine = ev.player === meIndex;
      const lost = ev.prevOwner === meIndex;

      world.spawnAttack(ev.from, ev.to, ev.color);
      world.spawnCapture(ev.to, ev.color, {
        stolenColor: prev ? prev.color : null,
        big: wiped,
      });
      impacts.set(ev.to, nowSec());

      // 自己被打：红屏 + 重震；自己抢地：轻震 + 绿边；别人互殴：很轻的一下
      if (lost) {
        world.shake(wiped ? 1.5 : 1.0);
        hud.impact('lost');
      } else if (mine) {
        world.shake(wiped ? 0.9 : 0.5);
        hud.impact('gain');
      } else if (stolen) {
        world.shake(0.2);
      }

      if (mine) {
        const target = ev.prevOwner === null ? '中立区' : state.players[ev.prevOwner].name + ' 的领地';
        hud.log(`占领 ${target} · 消耗 ${ev.cost} 兵`, 'good');
      } else if (lost) {
        hud.log(`${state.players[ev.player].name} 抢走了你一块地`, 'bad');
        hud.toast(`${state.players[ev.player].name} 抢走了你一块地`, 'bad');
      } else if (meIndex >= 0) {
        const who = state.players[ev.player].name;
        const from = ev.prevOwner === null ? '中立区' : `${state.players[ev.prevOwner].name} 的地`;
        hud.log(`${who} 拿下${from}`);
      }
    } else if (ev.type === 'capital') {
      // 都城被攻破：守方当场出局、领土全部回中立
      const victim = state.players[ev.player];
      const killer = state.players[ev.by];
      const mine = ev.by === meIndex;
      const lost = ev.player === meIndex;

      world.spawnCapture(ev.region, killer.color, {
        big: true,
        stolenColor: victim.color,
        capital: true,
      });
      impacts.set(ev.region, nowSec());
      world.shake(lost ? 2.4 : 1.6);
      hud.impact('capital');
      hud.coup(
        lost ? '都 城 失 守' : '斩 首',
        `${killer.name} 攻破 ${victim.name} 的都城 · 领土尽失`,
        lost ? victim.color : killer.color
      );
      hud.log(`${killer.name} 攻破 ${victim.name} 的都城`, lost ? 'bad' : mine ? 'good' : '');
      if (!mine && !lost) hud.toast(`${killer.name} 斩首 ${victim.name}`, 'bad');
    } else if (ev.type === 'eliminated') {
      // 斩首已经播过横幅与战报，这里不再重复一次「XX 出局」
      if (ev.capital) return;
      const p = state.players[ev.player];
      hud.log(`${p.name} 已被淘汰`, 'bad');
      hud.toast(`${p.name} 出局`, 'bad');
      world.shake(0.7);
    } else if (ev.type === 'ended') {
      showEndCard(ev.reason);
    }
  }
}

function backToRoom() {
  if (mode === 'net' && net) {
    net.send({ t: 'again' });
    hud.toast('正在返回房间…');
  } else {
    startSolo(); // 单机直接再开一局
  }
}

/* ------------------------------------------------------------------ */
/* 单人练习                                                            */
/* ------------------------------------------------------------------ */

function openSoloCard() {
  hud.showSolo(
    () => startSolo(),
    () => rejoinNet()
  );
}

/** 从大厅/断线界面点「单人练习」 */
function openSolo() {
  if (net) net.send({ t: 'leave' });
  wantRoom = null;
  lastRoomSig = '';
  openSoloCard();
}

function startSolo() {
  mode = 'solo';
  isSpectator = false;
  endShown = false;
  lastRoomSig = '';

  const seed = (Math.random() * 1e9) | 0;
  const map = generateRegions({ seed, count: 62, radius: 46 });
  buildMap(map, seed);

  state = Game.createState(map, { seed, playerCount: 4, humanName: myName, endOnHumansOut: true });
  Game.startGame(state);
  state.viewIndex = 0;

  hud.setSpectator(false);
  hud.setNetStatus('ok');
  hud.bind(state);
  hud.showOverlay(false);

  const v = world.homeView();
  world.flyTo(v.pos, v.target, 1.4, v.fov);
  hud.toast('点击与红色领土接壤的区域开始扩张', 'good');
}

function rejoinNet() {
  wantRoom = null;
  lastRoomSig = '';
  if (!net || net.status !== 'open') {
    hud.showDisconnect('服务器还没连上。稍等一下，或刷新页面重试。', openSoloCard);
    return;
  }
  hud.showConnecting('正在进入房间…');
  net.send({ t: 'join', code: wantRoom });
}

/* ------------------------------------------------------------------ */
/* 联机                                                                */
/* ------------------------------------------------------------------ */

function onStartMessage(msg) {
  const preview = !!msg.preview;
  mode = 'net';
  endShown = false;
  lastRoomSig = ''; // 开局后大厅缓存作废，结算回到大厅才能重新渲染
  isSpectator = msg.you < 0;
  hud.showOverlay(false);
  if (!preview) hud.showCountdown(0);

  const sameMap = state && currentSeed === msg.seed && state.regions.length === msg.map.regions.length;

  if (sameMap) {
    // 重连 / 倒计时转正：复用同一张图，不重建场景，免得镜头乱跳
    state.viewIndex = msg.you;
    state.phase = preview ? 'lobby' : 'playing';
    for (let i = 0; i < msg.players.length; i++) {
      const p = state.players[i];
      if (!p) continue;
      p.name = msg.players[i].name;
      p.isBot = msg.players[i].isBot;
    }
  } else {
    buildMap(msg.map, msg.seed);
    state = makeViewState(msg);
    if (preview) state.phase = 'lobby';
    hud.bind(state);
    const v = world.homeView();
    world.flyTo(v.pos, v.target, 1.4, v.fov);
  }

  hud.setSpectator(isSpectator);
  hud.setNetStatus('ok');
  if (isSpectator) hud.setSpecText('观战中 · 本局结束后入场');
  else if (!preview) hud.toast('点击与你的领土接壤的区域开始扩张', 'good');
}

function roomSignature(room) {
  return [room.code, room.phase, room.you.host, room.you.seated, room.you.slot, room.members.map((m) => `${m.name}${m.online ? '' : '!'}`).join(','), room.watchers].join('|');
}

function applyRoom(room) {
  if (room.phase !== 'lobby' && room.phase !== 'countdown') return;
  mode = 'net'; // 人在房间里就不再是单机局，避免单机的结算兜底把大厅盖住
  net.room = room.code;
  if (room.phase === 'lobby') {
    cdUntil = 0;
    hud.showCountdown(0);
  }

  // 把房间号写进地址栏，刷新 / 分享都能回到同一间
  if (location.search.indexOf(`room=${room.code}`) < 0) {
    const q = new URLSearchParams(location.search);
    q.set('room', room.code);
    history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
  }
  wantRoom = room.code;

  const sig = roomSignature(room);
  if (sig === lastRoomSig) return;
  lastRoomSig = sig;

  endShown = false;
  hud.setSpectator(false);
  hud.showLobby(room, {
    onStart: () => net.send({ t: 'start' }),
    onLocal: openSolo,
    onCopy: copyInvite,
  });
  bindNameInput();
  if (room.phase === 'countdown') hud.showCountdown(room.countdown || 3);
  // 倒计时阶段收起遮罩，让大数字和地图露出来
  hud.showOverlay(room.phase === 'lobby');
}

function bindNameInput() {
  const input = document.getElementById('nameIn');
  if (!input) return;
  input.value = myName;
  input.addEventListener('change', () => {
    const v = (input.value || '').trim().slice(0, 10) || myName;
    myName = v;
    store.name = v;
    net?.send({ t: 'rename', name: v });
  });
}

function copyInvite() {
  const code = wantRoom || net?.room || '';
  const url = `${location.origin}${location.pathname}?room=${code}`;
  // 按钮原地变成“已复制”，不用去屏幕边缘找提示
  const markBtn = () => {
    const btn = document.getElementById('btnCopy');
    if (!btn) return;
    btn.textContent = '已复制 ✓';
    btn.classList.add('ok');
    clearTimeout(btn._okTimer);
    btn._okTimer = setTimeout(() => {
      btn.textContent = '复制邀请链接';
      btn.classList.remove('ok');
    }, 1600);
  };
  const done = () => {
    hud.toast('邀请链接已复制', 'good');
    markBtn();
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      hud.toast('复制失败，请手动复制地址栏', 'bad');
    }
    ta.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(fallback);
  else fallback();
}

function connectNet() {
  net = createNet({
    onOpen() {
      net.send({ t: 'hello', name: myName, token: store.token });
    },
    onStatus(s) {
      if (s === 'connecting') hud.setNetStatus('warn', '正在连接对战服务器…');
      else if (s === 'reconnecting') hud.setNetStatus('bad', '连接断开，正在重连…');
      else if (s === 'open') hud.setNetStatus('ok');
      else if (s === 'closed') hud.setNetStatus('bad', '服务器未连接');
    },
    onMessage: handleNetMessage,
  });

  net.connect();
  setTimeout(() => {
    if (net.status !== 'open' && mode === 'solo' && !state?.phase) return;
    if (net.status !== 'open') {
      hud.showDisconnect('对战服务器没有响应。可以先玩单人练习，或稍后刷新重试。', openSoloCard);
    }
  }, 5000);
}

function handleNetMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      store.token = msg.token;
      net.send({ t: 'join', code: wantRoom });
      break;

    case 'room':
      applyRoom(msg);
      break;

    case 'countdown':
      cdUntil = performance.now() + msg.sec * 1000;
      hud.showCountdown(msg.sec);
      hud.showOverlay(false); // 让位给大数字和地图
      break;

    case 'start':
      onStartMessage(msg);
      break;

    case 'state':
      if (mode !== 'net') return;
      applySnapshot(msg);
      break;

    case 'cmd':
      if (!msg.ok && msg.reason && msg.reason !== '已经是你的地盘') hud.toast(msg.reason, 'bad');
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

let down = null;

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, button: e.button };
});

canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const sameButton = e.button === down.button;
  down = null;
  if (!sameButton || moved > 7 || e.button !== 0) return;
  onClick(e.clientX, e.clientY);
});

canvas.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  pointerDirty = true;
  const rect = canvas.getBoundingClientRect();
  world.setPointer(e.clientX - rect.left, e.clientY - rect.top);
});

canvas.addEventListener('pointerleave', () => {
  pointer = null;
  pointerDirty = true;
  world.setPointer(null, null);
});

function canAct() {
  return state && state.phase === 'playing' && !isSpectator && state.viewIndex >= 0;
}

function onClick(clientX, clientY) {
  if (!canAct()) return;
  const id = world.pick(clientX, clientY);
  if (id < 0) return;
  if (state.regions[id].owner === state.viewIndex) return;

  const now = nowSec();
  if (now - lastClick < 0.09) return;
  lastClick = now;

  if (mode === 'net') net.send({ t: 'attack', id });
  else {
    const res = Game.attack(state, state.viewIndex, id);
    if (!res.ok && res.reason !== '已经是你的地盘') hud.toast(res.reason, 'bad');
  }
}

function tryUpgrade(type) {
  if (!canAct()) return;
  if (mode === 'net') {
    net.send({ t: 'upgrade', type });
    return;
  }
  const res = Game.upgrade(state, state.viewIndex, type);
  if (!res.ok) {
    hud.toast(res.reason, 'bad');
    return;
  }
  const label = { farm: '农场', market: '市场', barracks: '兵营' }[type];
  hud.log(`${label} 升级到 Lv.${res.level} · 花费 ${res.price} 金`);
}

hud.onUpgrade(tryUpgrade);

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '1') tryUpgrade('farm');
  else if (e.key === '2') tryUpgrade('market');
  else if (e.key === '3') tryUpgrade('barracks');
  else if (e.key === 'Enter') {
    hud.el.card.querySelector('#btnStart')?.click();
  }
});

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

let last = 0;
let hudAcc = 0;

function frame(ts) {
  requestAnimationFrame(frame);
  const now = ts / 1000;
  const dt = last ? Math.min(0.06, now - last) : 0.016;
  last = now;

  world.resize();

  if (state) {
    if (state.phase === 'playing') {
      if (mode === 'solo') {
        Game.step(state, dt);
        Game.botTick(state, state.elapsed);
      } else {
        state.time = Math.max(0, state.time - dt); // 快照之间本地补时
      }
    }

    if (pointerDirty && world.regions.length) {
      pointerDirty = false;
      const id = pointer ? world.pick(pointer.x, pointer.y) : -1;
      if (id !== hoverId) {
        hoverId = id;
        const ok = id >= 0 && canAct() && Game.canAttack(state, state.viewIndex, id);
        canvas.style.cursor = ok ? 'pointer' : 'default';
      }
    }

    drainEvents();
    // 兜底：单机只靠 ended 事件，事件一丢就静默卡死；这里用状态兜一层。
    // 联机不能走这条：房主回大厅后 state.phase 还是 ended，会拿结算卡盖住大厅。
    if (mode === 'solo' && state.phase === 'ended' && !endShown) showEndCard(null);
    refreshVisuals(now);
    drainHud(dt);
  }

  world.render(dt);
}

function drainHud(dt) {
  hudAcc += dt;
  if (hudAcc < 0.08) return;
  hudAcc = 0;
  hud.update(state, hoverId);
  const me = !isSpectator && state.viewIndex >= 0 ? state.players[state.viewIndex] : null;
  hud.refreshBadge({
    spectator: isSpectator,
    eliminated: !!me && !me.alive,
    alive: state.players.filter((p) => p.alive).length,
  });
  // 开局倒计时（服务端只发一次总秒数，本地走表）
  if (cdUntil) {
    const left = Math.ceil((cdUntil - performance.now()) / 1000);
    if (left > 0) hud.showCountdown(left);
    else {
      cdUntil = 0;
      hud.showCountdown(0);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

buildShowcase();
hud.showConnecting();
connectNet();
requestAnimationFrame(frame);

// 便于控制台调参 / 自动化测试
window.__game = {
  get state() {
    return state;
  },
  get mode() {
    return mode;
  },
  get spectator() {
    return isSpectator;
  },
  get net() {
    return net;
  },
  CONFIG: Game.CONFIG,
  restart: startSolo,
  startSolo,
  openSolo,
  send: (m) => net?.send(m),
};

window.__probe = {
  attackCost: Game.attackCost,
  attack: Game.attack,
  world,
  hud,
  /** 区域中心 (x, z=-y) 投影到屏幕坐标 */
  project(x, height, y) {
    const v = new THREE.Vector3(x, height, -y);
    v.project(world.camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  },
};
