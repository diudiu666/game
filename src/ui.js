/**
 * ui.js —— HUD 与覆盖层
 * 只负责把 state 画到 DOM 上，不掺入任何规则判断。
 */

import { attackCost, costMultiplier, defenseOf, upgradePrice, ranking, CONFIG } from './game.js';

const $ = (id) => document.getElementById(id);

function fmt(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n).toString();
}

function mmss(s) {
  const m = Math.floor(Math.max(0, s) / 60);
  const ss = Math.floor(Math.max(0, s) % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class HUD {
  constructor() {
    this.el = {
      meDot: $('meDot'),
      meName: $('meName'),
      meTag: $('meTag'),
      meFill: $('meFill'),
      meTxt: $('meTxt'),
      meRate: $('meRate'),
      meGold: $('meGold'),
      meWeight: $('meWeight'),
      me: $('me'),
      timeVal: $('timeVal'),
      timer: $('timer'),
      rankList: $('rankList'),
      inspect: $('inspect'),
      insDot: $('insDot'),
      insOwner: $('insOwner'),
      insWeight: $('insWeight'),
      insNeighbors: $('insNeighbors'),
      insDef: $('insDef'),
      insCap: $('insCap'),
      insCost: $('insCost'),
      log: $('log'),
      toast: $('toast'),
      overlay: $('overlay'),
      card: $('card'),
      upgrades: $('upgrades'),
      netbar: $('netbar'),
      spec: $('spec'),
      countdown: $('countdown'),
      impact: $('impact'),
      coup: $('coup'),
    };
    this.rows = [];
    this.upCards = [...document.querySelectorAll('.up')];
    this.upgradeHandler = null;
    this.spectator = false;
    this.specHint = '';

    for (const card of this.upCards) {
      card.addEventListener('click', () => {
        this.upgradeHandler?.(card.dataset.type);
      });
    }
  }

  onUpgrade(fn) {
    this.upgradeHandler = fn;
  }

  bind(state) {
    const me = state.viewIndex >= 0 ? state.players[state.viewIndex] : null;
    if (me) {
      this.el.meDot.style.background = me.color;
      this.el.meDot.style.color = me.color;
      this.el.meName.textContent = me.name;
    }

    // 重建排行榜行
    this.el.rankList.innerHTML = '';
    this.rows = state.players.map((p) => {
      const row = document.createElement('div');
      row.className = 'prow' + (p.index === state.viewIndex ? ' me' : '');
      row.innerHTML = `<span class="pd" style="background:${p.color}"></span>
        <span class="pn">${esc(p.name)}<i class="pbot hidden">AI</i></span>
        <span class="pw"><b>0</b> 区</span>`;
      this.el.rankList.appendChild(row);
      return { el: row, name: row.querySelector('.pn'), bot: row.querySelector('.pbot'), val: row.querySelector('.pw b') };
    });

    this.el.log.innerHTML = '';
    this.el.toast.innerHTML = '';
    this.el.countdown.classList.add('hidden');
    this._cd = 0;
  }

  setSpectator(on) {
    this.spectator = on;
    if (!on) this.specHint = '';
    this.el.me.classList.toggle('hidden', on);
    this.el.upgrades.classList.toggle('hidden', on);
    if (!on) this.el.spec.classList.remove('show');
  }

  /** 观战提示的定制文案（例如「本局结束后入场」）。会被 refreshBadge 保留，不再每帧被刷掉。 */
  setSpecText(text) {
    this.specHint = text || '';
    this.el.spec.textContent = this.specHint;
    this.el.spec.classList.toggle('show', !!this.specHint);
  }

  /** 顶部状态条：观战 / 已出局 */
  refreshBadge({ spectator, eliminated, alive }) {
    const el = this.el.spec;
    if (spectator) {
      el.textContent = this.specHint || `观战中 · 场上还剩 ${alive} 人`;
      el.classList.add('show');
    } else if (eliminated) {
      el.textContent = '你已出局 · 继续观战';
      el.classList.add('show');
    } else {
      el.classList.remove('show');
    }
  }

  /* ---------------- 网络状态 ---------------- */

  setNetStatus(kind, text) {
    const bar = this.el.netbar;
    if (kind === 'ok') {
      bar.classList.remove('show', 'bad');
      bar.textContent = '';
      return;
    }
    bar.textContent = text;
    bar.classList.add('show');
    bar.classList.toggle('bad', kind === 'bad');
  }

  /* ---------------- 倒计时 ---------------- */

  showCountdown(sec) {
    const el = this.el.countdown;
    if (!sec) {
      el.classList.add('hidden');
      this._cd = 0;
      return;
    }
    // 同一个数字不重复触发动画，否则每帧都在重播、看着像没显示
    if (this._cd === sec && !el.classList.contains('hidden')) return;
    this._cd = sec;
    el.classList.remove('hidden');
    el.textContent = sec;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  update(state, hoverId) {
    const me = state.viewIndex >= 0 ? state.players[state.viewIndex] : null;

    if (me) {
      const cap = me.troopCap || 1;
      const pct = Math.max(0, Math.min(100, (me.troops / cap) * 100));
      this.el.meFill.style.width = pct + '%';
      this.el.meTxt.textContent = `${Math.floor(me.troops)} / ${Math.floor(cap)}`;
      this.el.meTag.textContent = `${me.regionCount} 区`;
      this.el.meRate.textContent = `+${me.troopRate.toFixed(1)}/s`;
      this.el.meGold.textContent = fmt(me.gold);
      this.el.meWeight.textContent = me.weight.toFixed(1);
    }

    this.el.timeVal.textContent = mmss(state.time);
    this.el.timer.classList.toggle('warn', state.time <= 30);

    // 排行
    const sorted = ranking(state);
    sorted.forEach((p, i) => {
      const row = this.rows[p.index];
      if (!row) return;
      row.el.style.order = i;
      row.el.querySelector('.pw').innerHTML = `<b>${p.regionCount}</b> 区 · ${p.weight.toFixed(1)}`;
      row.el.classList.toggle('dead', !p.alive);
      row.el.classList.toggle('offline', p.alive && p.connected === false);
      row.bot?.classList.toggle('hidden', !p.isBot);
    });

    // 发育按钮
    if (me) {
      for (const card of this.upCards) {
        const type = card.dataset.type;
        const price = upgradePrice(me, type);
        $('lv-' + type).textContent = 'Lv.' + me[type];
        $('price-' + type).textContent = price;
        card.classList.toggle('disabled', me.gold < price || state.phase !== 'playing' || !me.alive);
      }
      // 兵营的折扣是累积的，直接把当前值写出来，玩家才知道升它到底赚了什么
      const off = Math.round((1 - costMultiplier(state, me.index)) * 100);
      $('desc-barracks').textContent = off > 0 ? `攻占消耗 −${off}%` : `攻占消耗 −7%/级`;
    }

    // 悬停区域信息
    if (hoverId >= 0 && state.regions[hoverId]) {
      this.showInspect(state, hoverId, me);
    } else {
      this.el.inspect.classList.remove('show');
    }
  }

  showInspect(state, id, me) {
    const r = state.regions[id];
    const owner = r.owner === null ? null : state.players[r.owner];
    const e = this.el;
    const cap = r.capitalOf >= 0;

    e.insDot.style.background = owner ? owner.color : '#5b6472';
    e.insOwner.textContent = cap
      ? owner
        ? `${owner.name} 的都城`
        : '无主都城'
      : owner
        ? owner.name + ' 的领土'
        : '中立区域';
    e.insCap.classList.toggle('hidden', !cap);
    e.inspect.classList.toggle('capital', cap);
    e.insWeight.textContent = r.areaWeight.toFixed(2);
    e.insNeighbors.textContent = r.neighbors.length;
    e.insDef.textContent = Math.round(defenseOf(state, r));

    const cost = attackCost(state, r, me ? me.index : undefined);
    if (me && r.owner === me.index) {
      e.insCost.textContent = '已是你的领土';
      e.insCost.className = '';
    } else if (!me) {
      e.insCost.textContent = `${cost} 兵`;
      e.insCost.className = '';
    } else {
      e.insCost.textContent = `${cost} 兵`;
      e.insCost.className = me.troops >= cost ? 'ok' : 'no';
    }
    e.inspect.classList.add('show');
  }

  /**
   * 斩首横幅：屏幕正中的大字 + 一行小字说明，1.5 秒后自动淡出。
   * 只给「攻破都城」用，普通占领不要调它，否则会变成刷屏。
   */
  coup(text, sub, color) {
    const el = this.el.coup;
    if (!el) return;
    const word = el.querySelector('.word');
    word.style.setProperty('--glow', color || '#ffce6b');
    word.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    el.classList.remove('show');
    void el.offsetWidth; // 强制回流，保证连续两次也能重播动画
    el.classList.add('show');
    clearTimeout(this._coupTimer);
    this._coupTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  /** 战报 */
  log(text, kind = '') {
    const div = document.createElement('div');
    div.className = 'logline ' + kind;
    div.textContent = text;
    this.el.log.appendChild(div);
    while (this.el.log.children.length > 5) this.el.log.firstChild.remove();
    setTimeout(() => {
      div.style.transition = 'opacity .4s, transform .4s';
      div.style.opacity = '0';
      div.style.transform = 'translateX(-8px)';
      setTimeout(() => div.remove(), 420);
    }, 5200);
  }

  toast(text, kind = '') {
    const div = document.createElement('div');
    div.className = 'toast ' + kind;
    div.textContent = text;
    this.el.toast.appendChild(div);
    while (this.el.toast.children.length > 2) this.el.toast.firstChild.remove();
    setTimeout(() => {
      div.style.transition = 'opacity .3s, transform .3s';
      div.style.opacity = '0';
      div.style.transform = 'translateY(-8px)';
      setTimeout(() => div.remove(), 320);
    }, 1100);
  }

  /**
   * 全屏打击反馈：'lost' 红边 + 状态面板震动，'gain' 绿边
   * 只做视觉，不参与任何判定
   */
  impact(kind) {
    const el = this.el.impact;
    if (!el) return;
    // 'capital' 也要清：它自带背景色，留着会把下一次普通受击也染成金色
    el.classList.remove('lost', 'gain', 'capital', 'hit');
    void el.offsetWidth; // 强制回流，让动画能重播
    el.classList.add(kind, 'hit');

    if (kind === 'lost') {
      const me = this.el.me;
      me.classList.remove('dmg');
      void me.offsetWidth;
      me.classList.add('dmg');
      setTimeout(() => me.classList.remove('dmg'), 420);
    }
  }

  /* ---------------- 覆盖层 ---------------- */

  showOverlay(on = true) {
    this.el.overlay.classList.toggle('off', !on);
    // 覆盖层开着时卡片居中，飘字让位到屏幕下方
    this.el.toast.classList.toggle('dock-bottom', !!on);
  }

  /** 连接中 / 连不上 */
  showConnecting(text = '正在连接对战服务器…', onLocal) {
    this.el.card.innerHTML = `
      <div class="eyebrow">Connecting</div>
      <h1>抢 地 盘</h1>
      <div class="sub">${esc(text)}</div>
      <div class="dots"><i></i><i></i><i></i></div>
      <button class="btn ghost" id="btnLocal" style="margin-top:22px">先玩单人练习</button>
    `;
    this.showOverlay(true);
    $('btnLocal').onclick = () => onLocal?.();
  }

  /**
   * 大厅
   * @param {object} room 服务端 roomView
   * @param {{onStart:Function,onLocal:Function,onCopy:Function}} acts
   */
  showLobby(room, acts) {
    const seats = [];
    const total = 4;
    for (let i = 0; i < total; i++) {
      const m = room.members[i];
      if (m) {
        const tags = [m.me ? '你' : '', m.host ? '房主' : '', m.online ? '' : '掉线']
          .filter(Boolean)
          .map((t) => `<span class="stag${t === '掉线' ? ' off' : ''}">${t}</span>`)
          .join('');
        seats.push(`<div class="seat filled${m.me ? ' me' : ''}">
          <span class="sd" style="background:${state_color(i)}"></span>
          <span class="sn">${esc(m.name)}</span>${tags}
        </div>`);
      } else {
        seats.push(`<div class="seat empty"><span class="sd"></span><span class="sn">空位 · AI 补足</span></div>`);
      }
    }

    const iAmHost = room.you.host;
    const seated = room.you.seated;
    const full = room.members.length >= total;

    let action = '';
    if (!seated) {
      action = `<div class="lobbynote">房间已满或本局已开始，你正在观战。一局结束后自动入座。</div>`;
    } else if (room.phase === 'countdown') {
      action = `<button class="btn disabled" disabled>即将开始…</button>`;
    } else if (iAmHost) {
      action = `<button class="btn" id="btnStart">开 始 对 局</button>`;
    } else {
      action = `<button class="btn disabled" disabled>等待房主开始…</button>`;
    }

    this.el.card.innerHTML = `
      <div class="eyebrow">Room · 最多 4 人</div>
      <h1>抢 地 盘</h1>
      <div class="roomcode">
        <span class="rl">房间号</span>
        <b id="roomCodeText">${esc(room.code)}</b>
        <button class="mini" id="btnCopy">复制邀请链接</button>
      </div>
      <div class="seats">${seats.join('')}</div>
      <div class="lobbynote">${full ? '4 人满员 · 可以开局' : `${room.members.length} 人已就位 · 空位由 AI 补满`}${
        room.watchers ? ` · ${room.watchers} 人观战` : ''
      }</div>
      ${action}
      <div class="namerow">
        <label for="nameIn">昵称</label>
        <input id="nameIn" maxlength="10" autocomplete="off" spellcheck="false" />
      </div>
      <div class="altrow"><button class="btn ghost small" id="btnLocal">单人练习</button></div>
      <div class="hint-row">把邀请链接发给朋友，手机打开就能进</div>
    `;
    this.showOverlay(true);

    $('btnStart')?.addEventListener('click', () => acts.onStart?.());
    $('btnLocal')?.addEventListener('click', () => acts.onLocal?.());
    $('btnCopy')?.addEventListener('click', () => acts.onCopy?.());
  }

  /** 单人练习的开场卡 */
  showSolo(onStart, onBack) {
    this.el.card.innerHTML = `
      <div class="eyebrow">Solo · 单人练习</div>
      <h1>抢 地 盘</h1>
      <div class="sub">3D 区域争夺 · 你 vs 3 个 AI</div>
      <div class="rules">
        <div><b>点击占领</b>只能打与己方领土接壤的区域</div>
        <div><b>自动发育</b>地盘越多，兵力和金币涨得越快</div>
        <div><b>金币买加成</b>农场（增兵最快）/ 市场（增金）/ 兵营（同样的地更省兵）</div>
        <div><b>都城</b>每人开局那一块，被打下就当场出局、领地回中立</div>
        <div><b>获胜条件</b>消灭全部对手，或 ${Math.round(CONFIG.duration / 60)} 分钟后权重最高</div>
      </div>
      <button class="btn" id="btnStart">开 始 对 局</button>
      <div class="altrow"><button class="btn ghost small" id="btnBack">回到联机房间</button></div>
      <div class="hint-row">左键拖动旋转 · 滚轮缩放 · 1 / 2 / 3 买发育</div>
    `;
    this.showOverlay(true);
    $('btnStart').onclick = () => {
      this.showOverlay(false);
      onStart();
    };
    $('btnBack').onclick = () => onBack?.();
  }

  showEnd(state, onRestart, reason, opts = {}) {
    const sorted = ranking(state);
    const me = state.viewIndex >= 0 ? state.players[state.viewIndex] : null;
    const win = state.winner === state.viewIndex;
    const wiped = reason === 'defeat' || (me && !me.alive);
    const myRank = me ? sorted.findIndex((p) => p.index === me.index) + 1 : 0;

    const title = !me ? '本 局 结 束' : win ? '胜 利' : wiped ? '出 局' : '落 败';
    const eyebrow = !me ? 'Result' : win ? 'Victory' : wiped ? 'Defeat' : 'Time Up';
    let subtitle;
    if (!me) subtitle = '观战结束 · 新一局马上开始';
    else if (win) {
      subtitle =
        reason === 'conquer'
          ? '你把整张地图都拿下了'
          : reason === 'timeout'
            ? '时间到，你的领地权重最高'
            : reason === 'capital'
              ? '最后一座都城被你攻破，对手当场出局'
              : '最后一块地盘是你的';
    }
    else if (wiped) subtitle = me && me.capitalLost ? '你的都城被攻破，领地尽失' : '你的地盘被清空了';
    else subtitle = `时间到，按领地权重结算 · 你排第 ${myRank}`;

    const rows = sorted
      .map((p, i) => {
        const isMe = me && p.index === me.index;
        return `<div class="srow ${p.index === state.winner ? 'win' : ''}">
          <span class="rk">${i + 1}</span>
          <span class="pd" style="background:${p.color}"></span>
          <span class="pn">${esc(p.name)}${isMe ? '（你）' : ''}${
            p.capitalLost ? ' · 都城失守' : p.alive ? '' : ' · 出局'
          }${p.isBot ? ' · AI' : ''}</span>
          <span class="pv">${p.regionCount} 区 · 权重 ${p.weight.toFixed(1)}</span>
        </div>`;
      })
      .join('');

    this.el.card.innerHTML = `
      <div class="eyebrow">${eyebrow}</div>
      <h1>${title}</h1>
      <div class="sub">${subtitle}</div>
      <div id="endStats">${rows}</div>
      <button class="btn" id="btnRestart">${opts.online ? '回 到 房 间' : '再 来 一 局'}</button>
      ${opts.onBack ? '<div class="altrow"><button class="btn ghost small" id="btnToNet">回到联机房间</button></div>' : ''}
      <div class="hint-row">${opts.online ? '房间会保留，可以直接再开一局' : `本局用时 ${Math.round(state.elapsed)} 秒`}</div>
    `;
    this.showOverlay(true);
    $('btnRestart').onclick = () => {
      this.showOverlay(false);
      onRestart();
    };
    $('btnToNet')?.addEventListener('click', () => opts.onBack());
  }

  /** 断线遮罩 */
  showDisconnect(text, onLocal) {
    this.el.card.innerHTML = `
      <div class="eyebrow">Offline</div>
      <h1>连 接 断 开</h1>
      <div class="sub">${esc(text)}</div>
      <div class="dots"><i></i><i></i><i></i></div>
      <div class="altrow" style="margin-top:24px"><button class="btn ghost small" id="btnLocal">单人练习</button></div>
    `;
    this.showOverlay(true);
    $('btnLocal').onclick = () => onLocal?.();
  }
}

/** 座位颜色跟玩家色一致（座位号 = 颜色号） */
function state_color(i) {
  const COLORS = ['#ff5b52', '#4b9dff', '#2fcf85', '#ffb02a'];
  return COLORS[i] || '#5b6472';
}
