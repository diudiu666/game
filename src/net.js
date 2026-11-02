/**
 * net.js —— WebSocket 客户端
 *
 * 只管连接、自动重连、心跳，不懂游戏规则。
 * 重连成功后回调 onOpen，由上层重新发 hello / join 完成续座。
 */

export function createNet(handlers = {}) {
  const secure = location.protocol === 'https:';
  const url = `${secure ? 'wss' : 'ws'}://${location.host}/ws`;

  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let hbTimer = null;
  let manualClose = false;
  let status = 'idle';
  let rtt = 0;

  function setStatus(s) {
    if (status === s) return;
    status = s;
    handlers.onStatus?.(s, rtt);
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    manualClose = false;
    setStatus('connecting');

    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      setStatus('closed');
      return;
    }
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      setStatus('open');
      hbTimer = setInterval(() => {
        send({ t: 'ping', ts: performance.now() });
      }, 4000);
      handlers.onOpen?.();
    };

    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        rtt = Math.round(performance.now() - (msg.ts || 0));
        handlers.onRtt?.(rtt);
        return;
      }
      handlers.onMessage?.(msg);
    };

    sock.onclose = () => {
      clearInterval(hbTimer);
      hbTimer = null;
      ws = null;
      handlers.onClose?.();
      if (manualClose) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      const delay = Math.min(8000, 400 * 2 ** retry);
      retry++;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    sock.onerror = () => {
      /* onclose 会跟着来 */
    };
  }

  return {
    connect,
    send,
    get status() {
      return status;
    },
    get rtt() {
      return rtt;
    },
    close() {
      manualClose = true;
      clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
