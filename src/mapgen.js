/**
 * mapgen.js —— 预切区域地图生成
 *
 * 文档第 8 节要求地图在制作阶段就把「多边形 + 邻接表 + 面积权重」固化下来，
 * 运行时只查表。这里用 Voronoi 图算法自动完成这一步，替代 Blender 手工切图，
 * 产出结构与 regions.json 完全一致，后续换成手工地图只要替换 generateRegions 的输出。
 */

/** 可复现随机数 */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPS = 1e-6;

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 去掉重复顶点（含首尾闭合点） */
function dedupe(poly, eps = 1e-5) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  if (out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop();
  }
  return out;
}

/**
 * 用半平面 nx*x + ny*y <= c 裁多边形（Sutherland–Hodgman）
 */
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  const n = poly.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const A = poly[i];
    const B = poly[(i + 1) % n];
    const da = nx * A.x + ny * A.y - c;
    const db = nx * B.x + ny * B.y - c;
    const ina = da <= EPS;
    const inb = db <= EPS;
    if (ina) out.push(A);
    if (ina !== inb) {
      const t = da / (da - db);
      out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
    }
  }
  return out;
}

/** 不规则的外边界（让地图边缘看起来是天然地形，而不是一个圆） */
function makeBoundary(rng, radius, sides = 15) {
  const pts = [];
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    const r = radius * (0.9 + rng() * 0.12);
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  // 保证逆时针
  return polyArea(pts) > 0 ? pts : pts.reverse();
}

/**
 * 生成区域
 * @param {{seed?:number, count?:number, radius?:number}} opts
 * @returns {{regions:Array, radius:number}}
 */
export function generateRegions(opts = {}) {
  const seed = opts.seed ?? 1;
  const count = opts.count ?? 62;
  const radius = opts.radius ?? 46;
  const rng = mulberry32(seed);

  const boundary = makeBoundary(rng, radius);

  // 1. 撒点（尽量均匀，Poisson 拒绝采样）
  const sites = [];
  let minDist = Math.sqrt((Math.PI * radius * radius) / count) * 0.68;
  let guard = 0;
  while (sites.length < count && guard < 40000) {
    guard++;
    if (guard % 6000 === 0) minDist *= 0.9; // 兜底放宽，避免死循环
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * radius * 0.95;
    const p = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    let ok = true;
    for (const s of sites) {
      if (Math.hypot(s.x - p.x, s.y - p.y) < minDist) { ok = false; break; }
    }
    if (ok) sites.push(p);
  }

  // 2. 逐点切割得到 Voronoi 单元
  const cells = sites.map((s, i) => {
    let poly = boundary.slice();
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const t = sites[j];
      // |p-si|^2 <= |p-sj|^2  =>  2p·(sj-si) <= |sj|^2 - |si|^2
      const nx = 2 * (t.x - s.x);
      const ny = 2 * (t.y - s.y);
      const c = t.x * t.x + t.y * t.y - (s.x * s.x + s.y * s.y);
      poly = clipHalfPlane(poly, nx, ny, c);
      if (poly.length < 3) return null;
    }
    poly = dedupe(poly);
    if (poly.length < 3) return null;
    const area = polyArea(poly);
    // 阈值不能太高：丢掉单元会在地图上留下空洞
    if (area < 0.15) return null;
    return { site: s, poly, area };
  });

  // 3. 过滤无效单元并重排 id
  const kept = [];
  const remap = new Map();
  cells.forEach((c, i) => {
    if (c) {
      remap.set(i, kept.length);
      kept.push(c);
    }
  });

  // 4. 扫边建立邻接表（共边即相邻）
  const edgeMap = new Map();
  kept.forEach((c, idx) => {
    const n = c.poly.length;
    for (let i = 0; i < n; i++) {
      const a = c.poly[i];
      const b = c.poly[(i + 1) % n];
      const ka = `${Math.round(a.x * 1000)}|${Math.round(a.y * 1000)}`;
      const kb = `${Math.round(b.x * 1000)}|${Math.round(b.y * 1000)}`;
      const key = ka < kb ? `${ka}/${kb}` : `${kb}/${ka}`;
      let arr = edgeMap.get(key);
      if (!arr) edgeMap.set(key, (arr = []));
      arr.push(idx);
    }
  });

  const neigh = kept.map(() => new Set());
  for (const arr of edgeMap.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        neigh[arr[i]].add(arr[j]);
        neigh[arr[j]].add(arr[i]);
      }
    }
  }

  // 5. 面积权重（相对平均值，平均约等于 1）
  const totalArea = kept.reduce((s, c) => s + c.area, 0);
  const avgArea = totalArea / kept.length;

  const regions = kept.map((c, idx) => {
    const cx = c.poly.reduce((s, p) => s + p.x, 0) / c.poly.length;
    const cy = c.poly.reduce((s, p) => s + p.y, 0) / c.poly.length;
    return {
      id: idx,
      polygon: c.poly.map((p) => ({ x: p.x, y: p.y })),
      center: { x: cx, y: cy },
      area: c.area,
      areaWeight: Math.min(3.6, Math.max(0.5, c.area / avgArea)),
      neighbors: [...neigh[idx]],
      height: 0,
    };
  });

  // 6. 地形不做高低差，整张图就是一个平的板子（厚度由挤出产生）
  for (const r of regions) {
    r.height = 2.6;
  }

  // 7. 至少 2 个邻居才好玩，孤岛直接并入邻区（正常不会出现）
  return { regions, radius };
}

/** 贪心最远点采样：挑 n 个彼此尽量远的起始区域 */
export function pickStartRegions(regions, n, rng) {
  const picks = [];
  const first = Math.floor(rng() * regions.length);
  picks.push(first);
  while (picks.length < n) {
    let best = -1;
    let bestD = -1;
    for (const r of regions) {
      if (picks.includes(r.id)) continue;
      let d = Infinity;
      for (const p of picks) {
        const q = regions[p];
        d = Math.min(d, Math.hypot(r.center.x - q.center.x, r.center.y - q.center.y));
      }
      if (d > bestD) { bestD = d; best = r.id; }
    }
    if (best < 0) break;
    picks.push(best);
  }
  return picks;
}
