/** 验收：大厅点“复制邀请链接”后，飘字必须显示在覆盖层之上（不被遮住） */
import { launch } from './lib/harness.mjs';

const browser = await launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('#btnCopy', { timeout: 15000 });

// 等大厅稳定
await page.waitForTimeout(600);

const before = await page.evaluate(() => ({
  overlayOn: !document.getElementById('overlay').classList.contains('off'),
  dock: document.getElementById('toast').className,
}));

await page.click('#btnCopy');
await page.waitForTimeout(350);

const probe = await page.evaluate(() => {
  const t = document.querySelector('.toast');
  if (!t) return { toast: null };
  const r = t.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // pointer-events:none 的元素不参与 elementFromPoint，临时打开才能验证谁压在上面
  const prevPE = t.style.pointerEvents;
  t.style.pointerEvents = 'auto';
  const top = document.elementFromPoint(cx, cy);
  t.style.pointerEvents = prevPE;
  const card = document.getElementById('card').getBoundingClientRect();
  return {
    text: t.textContent,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    hitIsToast: !!(top && top.classList.contains('toast')),
    topEl: top ? top.id || top.className : null,
    overlappedByCard: !(r.bottom < card.top || r.top > card.bottom),
    card: { top: Math.round(card.top), bottom: Math.round(card.bottom) },
    zToast: getComputedStyle(document.getElementById('toast')).zIndex,
    zOverlay: getComputedStyle(document.getElementById('overlay')).zIndex,
    btn: (() => {
      const b = document.getElementById('btnCopy');
      return b ? { text: b.textContent, ok: b.classList.contains('ok') } : null;
    })(),
  };
});
await page.screenshot({ path: 'shots/copy-lobby.png' });

// 进局内，确认飘字回到上方且仍可见
await page.click('#btnStart');
await page.waitForTimeout(2200);
await page.evaluate(() => window.__probe.hud.toast('局内提示层级检查'));
await page.waitForTimeout(250);
const inGame = await page.evaluate(() => {
  const t = document.querySelector('.toast');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  const prevPE = t.style.pointerEvents;
  t.style.pointerEvents = 'auto';
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  t.style.pointerEvents = prevPE;
  return {
    text: t.textContent,
    y: Math.round(r.y),
    hitIsToast: !!(top && top.classList.contains('toast')),
    dock: document.getElementById('toast').className,
    nearTop: r.y < window.innerHeight * 0.3,
  };
});
await page.screenshot({ path: 'shots/copy-ingame.png' });

const m = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await m.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await m.waitForSelector('#btnCopy', { timeout: 15000 });
await m.waitForTimeout(600);
await m.tap('#btnCopy');
await m.waitForTimeout(350);
const mobile = await m.evaluate(() => {
  const t = document.querySelector('.toast');
  const card = document.getElementById('card').getBoundingClientRect();
  const r = t.getBoundingClientRect();
  return {
    text: t.textContent,
    cardBottom: Math.round(card.bottom),
    toastTop: Math.round(r.top),
    toastBottom: Math.round(r.bottom),
    gap: Math.round(r.top - card.bottom),
    overlapped: r.top < card.bottom,
  };
});
await m.screenshot({ path: 'shots/copy-lobby-mobile.png' });
console.log('手机端:', JSON.stringify(mobile));

console.log('大厅前:', JSON.stringify(before));
console.log('复制后:', JSON.stringify(probe, null, 0));
console.log('局内:', JSON.stringify(inGame));
console.log(errors.length ? '错误: ' + errors.join(' | ') : '无页面错误');
await browser.close();
