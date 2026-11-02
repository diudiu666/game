/** 结算后房间是否自动回大厅（只看协议层） */
import WebSocket from 'ws';

const WS = (process.argv[2] || 'http://localhost:5176').replace(/^http/, 'ws') + '/ws';
const ws = new WebSocket(WS);
const seen = [];
let ended = false;

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'T' })));
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.t === 'room') {
    seen.push(`room:${m.phase}`);
    if (m.phase === 'ended') seen.push('room:ended');
    if (ended && m.phase === 'lobby') {
      console.log('✓ 结算后自动回大厅');
      console.log([...new Set(seen)].join(' → '));
      process.exit(0);
    }
  }
  if (m.t === 'state' && m.phase === 'ended') ended = true;
});
setTimeout(() => ws.send(JSON.stringify({ t: 'start' })), 1500);
setTimeout(() => {
  console.log('✗ 超时未回大厅');
  console.log([...new Set(seen)].join(' → '));
  process.exit(1);
}, 60000);
