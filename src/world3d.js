/**
 * world3d.js —— Three.js 场景层
 *
 * 职责：把一个「预切区域地图」变成可交互的 3D 地形。
 * 每个区域是一个从自身多边形挤出的棱柱，顶面高度统一（全平），
 * 靠挤出厚度和描边区分地块；如果以后想恢复高低起伏，只改 mapgen 里的 height 即可。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** 一张柔光点：火花、光球、弹道都用它，比纯色方块干净得多 */
function makeGlowTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  // 地形是平的，没有投影关系，开阴影只会在平坦面上产生自遮挡暗斑
  renderer.shadowMap.enabled = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070a11');

  // near 别设太小：近裁剪面太近会毁掉深度精度，共边描边会闪成虚线
  const camera = new THREE.PerspectiveCamera(40, 1, 4, 500);
  camera.position.set(0, 96, 108);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.minDistance = 48;
  controls.maxDistance = 190;
  controls.minPolarAngle = 0.38;
  controls.maxPolarAngle = 1.15;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.75;

  // ---- 灯光 ----
  scene.add(new THREE.HemisphereLight(0xaec6ff, 0x151d28, 1.45));

  const key = new THREE.DirectionalLight(0xfff4e2, 2.15);
  key.position.set(52, 86, 40);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x3f6dff, 0.75);
  rim.position.set(-60, 34, -70);
  scene.add(rim);

  const world = {
    renderer,
    scene,
    camera,
    controls,
    regions: [],
    meshes: [],
    map: null,
    baseRadius: 46,
  };

  const root = new THREE.Group();
  scene.add(root);
  world.root = root;

  let ground = null;
  let effectGroup = new THREE.Group();
  root.add(effectGroup);

  /* ---------------------------------------------------------------- */
  /* 玩家名牌                                                          */
  /* ---------------------------------------------------------------- */

  const labelGroup = new THREE.Group();
  root.add(labelGroup);

  /** 名牌字体：中文优先用系统黑体，够粗才好在彩色地块上压住背景 */
  const LABEL_FONT =
    '700 80px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Hiragino Sans GB", system-ui, sans-serif';
  /** 画布高度 / 字号，留出描边和光晕的余量 */
  const LABEL_BOX = 1.62;

  /** 把一句话画进画布：白字 + 深色描边 + 玩家色光晕 */
  function makeLabelTexture(text, color) {
    const F = 80;
    const pad = Math.round(F * 0.34);
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = LABEL_FONT;
    const tw = Math.max(F * 0.6, Math.ceil(probe.measureText(text).width));

    const c = document.createElement('canvas');
    c.width = tw + pad * 2;
    c.height = Math.round(F * LABEL_BOX);
    const g = c.getContext('2d');
    g.font = LABEL_FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';

    const cx = c.width / 2;
    const cy = c.height / 2;

    g.lineWidth = F * 0.22;
    g.strokeStyle = 'rgba(5, 8, 13, 0.92)';
    g.shadowColor = color;
    g.shadowBlur = F * 0.55;
    g.strokeText(text, cx, cy);
    g.shadowBlur = 0;
    g.strokeText(text, cx, cy);
    g.fillStyle = '#ffffff';
    g.fillText(text, cx, cy);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { tex, aspect: c.width / c.height, glyphRatio: F / c.height };
  }

  /** key -> { sprite, text, color, weight, target:Vector3, pos:Vector3, h } */
  const labels = new Map();
  const labelTarget = new THREE.Vector3();

  function dropLabel(entry) {
    labelGroup.remove(entry.sprite);
    entry.sprite.material.map?.dispose();
    entry.sprite.material.dispose();
  }

  /**
   * 同步名牌列表（main.js 每帧算好每位玩家的地盘质心传进来）。
   * 这里的尺寸是「屏幕像素」，再按相机距离折回世界单位 —— 缩放时字号稳定，
   * 否则拉到最近时名牌会把半张地图盖住。
   */
  world.syncLabels = function syncLabels(list) {
    const seen = new Set();
    for (const item of list || []) {
      seen.add(item.key);
      let e = labels.get(item.key);
      if (!e || e.text !== item.text || e.color !== item.color) {
        if (e) dropLabel(e);
        const { tex, aspect, glyphRatio } = makeLabelTexture(item.text, item.color);
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
        );
        sprite.renderOrder = 6;
        labelGroup.add(sprite);
        e = {
          sprite,
          aspect,
          glyphRatio,
          text: item.text,
          color: item.color,
          weight: item.weight,
          h: 0,
          fresh: true,
          target: new THREE.Vector3(item.x, 0, item.z),
          pos: new THREE.Vector3(item.x, 0, item.z),
        };
        labels.set(item.key, e);
      }
      e.text = item.text;
      e.color = item.color;
      e.weight = item.weight;
      e.target.set(item.x, 0, item.z);
    }
    for (const [key, e] of labels) {
      if (seen.has(key)) continue;
      dropLabel(e);
      labels.delete(key);
    }
  };

  /** 名牌调试信息（验收脚本用：字号有没有跟地盘一起长、有没有被屏幕裁掉） */
  world.labelDebug = function labelDebug() {
    return [...labels.values()].map((e) => ({
      text: e.text,
      weight: Math.round(e.weight * 10) / 10,
      h: Math.round(e.h * 100) / 100,
      w: Math.round(e.h * e.aspect * 100) / 100,
      x: Math.round(e.pos.x * 10) / 10,
      z: Math.round(e.pos.z * 10) / 10,
      alpha: e.alpha === undefined ? null : Math.round(e.alpha * 100) / 100,
      rect: e.rect ? e.rect.map((n) => Math.round(n)) : null,
    }));
  };

  const labelScreen = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();

  /** 指针在画布上的位置（CSS 像素），null = 不在画布上 */
  let pointerX = null;
  let pointerY = null;

  /** main.js 每次 pointermove / pointerleave 调一次；名牌据此让路 */
  world.setPointer = function setPointer(x, y) {
    pointerX = x == null ? null : x;
    pointerY = y == null ? null : y;
  };

  // 名牌本体不透明度：平时稍微透一点（不把地块完全糊住），
  // 指针压在上面时几乎让开（能看见底下的格子、看得见悬停高亮）
  const LABEL_OPACITY = 0.86;
  const LABEL_OPACITY_HOVER = 0.08;

  function updateLabels(dt) {
    if (!labels.size) return;

    // 当前视野里「一个世界单位等于多少屏幕像素」
    const viewH = camera.position.distanceTo(controls.target);
    const spanY = 2 * viewH * Math.tan((camera.fov * Math.PI) / 360);
    const pxPerUnit = (canvas.clientHeight || window.innerHeight) / Math.max(1, spanY);
    // 窄屏上字号整体收一点，不然三四个字就横穿半个屏
    const vw = canvas.clientWidth || window.innerWidth;
    const vh = canvas.clientHeight || window.innerHeight;
    const uiScale = Math.min(1.12, Math.max(0.75, vw / 1440));
    // 拉近时让字稍微跟着长一点（屏幕尺寸按 dist^-0.5 增长），既有「贴在地盘上」的体积感，
    // 又不至于像纯世界尺寸那样怼到脸上
    const refDist = world.baseRadius * 2.9;
    const zoomK = Math.sqrt(Math.max(0.4, Math.min(2.2, refDist / Math.max(1, viewH))));
    const k = 1 - Math.pow(0.0015, Math.min(0.1, dt));

    camera.updateMatrixWorld();
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);

    for (const e of labels.values()) {
      // 地盘越大名字越大：用权重开方，62 格 vs 1 格大概是 3 倍字号而不是 8 倍
      const wantPx = Math.min(78, (17 + 6.8 * Math.sqrt(Math.max(1, e.weight))) * uiScale);
      const worldH = Math.max(1.4, Math.min(18, (wantPx * zoomK) / (e.glyphRatio * pxPerUnit)));

      if (e.fresh) {
        e.fresh = false;
        e.h = worldH;
        e.pos.set(e.target.x, 2.6 + e.h * 0.52 + 0.35, e.target.z);
      } else {
        e.h += (worldH - e.h) * k;
      }

      e.sprite.scale.set(e.h * e.aspect, e.h, 1);

      labelTarget.set(e.target.x, 2.6 + e.h * 0.52 + 0.35, e.target.z);

      // 贴着地图边缘的地盘，名字会有一半飘到屏幕外：按屏幕矩形把中心推回安全区
      labelScreen.copy(labelTarget).project(camera);
      const halfW = ((e.h * e.aspect) / 2) * pxPerUnit + 12;
      const halfH = (e.h / 2) * pxPerUnit + 12;
      const loX = Math.min(vw / 2, halfW);
      const hiX = Math.max(vw / 2, vw - halfW);
      const loY = Math.min(vh / 2, halfH);
      const hiY = Math.max(vh / 2, vh - halfH);
      const sx = (labelScreen.x * 0.5 + 0.5) * vw;
      const sy = (-labelScreen.y * 0.5 + 0.5) * vh;
      const dx = Math.min(hiX, Math.max(loX, sx)) - sx;
      const dy = Math.min(hiY, Math.max(loY, sy)) - sy;
      if (dx || dy) {
        labelTarget
          .addScaledVector(camRight, dx / pxPerUnit)
          .addScaledVector(camUp, -dy / pxPerUnit);
      }

      e.pos.lerp(labelTarget, k);
      e.sprite.position.copy(e.pos);

      // 记录实际投影矩形（调试/验收用）
      labelScreen.copy(e.pos).project(camera);
      const csx = (labelScreen.x * 0.5 + 0.5) * vw;
      const csy = (-labelScreen.y * 0.5 + 0.5) * vh;
      e.rect = [csx - halfW, csy - halfH, csx + halfW, csy + halfH];

      // 指针压住名牌时让它几乎透明：否则大地盘的名字会盖住一片格子，
      // 玩家既看不见底下是谁的地，也看不见悬停高亮，就会觉得「点不到」
      const over =
        pointerX !== null &&
        pointerX >= e.rect[0] &&
        pointerX <= e.rect[2] &&
        pointerY >= e.rect[1] &&
        pointerY <= e.rect[3];
      const wantA = over ? LABEL_OPACITY_HOVER : LABEL_OPACITY;
      if (e.alpha === undefined) e.alpha = wantA;
      e.alpha += (wantA - e.alpha) * Math.min(1, k * 1.8);
      e.sprite.material.opacity = e.alpha;
    }
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /* ---------------------------------------------------------------- */
  /* 构建地图                                                          */
  /* ---------------------------------------------------------------- */

  world.buildMap = function buildMap(map) {
    world.disposeMap();
    world.map = map;
    world.baseRadius = map.radius;

    // 底座
    const gr = map.radius;
    ground = new THREE.Mesh(
      new THREE.CylinderGeometry(gr * 1.0, gr * 1.03, 2.2, 96),
      new THREE.MeshStandardMaterial({ color: '#131b26', roughness: 1, metalness: 0 })
    );
    ground.position.y = -1.1;
    root.add(ground);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(gr * 1.35, 96),
      new THREE.MeshStandardMaterial({ color: '#0a0e16', roughness: 1, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.7;
    root.add(floor);
    world.floor = floor;

    for (const r of map.regions) {
      const shape = new THREE.Shape(r.polygon.map((p) => new THREE.Vector2(p.x, p.y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: r.height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // 挤出方向从 +Z 变成 +Y，底面落在 y=0
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        color: '#4e5866',
        roughness: 0.88,
        metalness: 0.04,
        flatShading: true,
        emissive: new THREE.Color('#000000'),
        emissiveIntensity: 0,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.regionId = r.id;
      root.add(mesh);

      // 顶面轮廓线。相邻区域会各画一条共边，完全共面会 z-fighting 出虚线，
      // 所以每个区域按 id 错开一点点高度，保证任何一条共边两侧都不共面
      const lift = 0.008 + r.id * 0.0012;
      const topPts = r.polygon.map((p) => new THREE.Vector3(p.x, r.height + lift, -p.y));
      const lineGeo = new THREE.BufferGeometry().setFromPoints(topPts);
      const lineMat = new THREE.LineBasicMaterial({
        color: '#232c3a',
        transparent: true,
        opacity: 0.9,
      });
      const outline = new THREE.LineLoop(lineGeo, lineMat);
      root.add(outline);

      // 悬停高亮面（默认全透明，避免额外开销）
      const plateGeo = new THREE.ShapeGeometry(shape);
      plateGeo.rotateX(-Math.PI / 2);
      plateGeo.translate(0, r.height + 0.06, 0);
      const plateMat = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.renderOrder = 2;
      root.add(plate);

      world.regions[r.id] = {
        id: r.id,
        data: r,
        mesh,
        outline,
        plate,
        fill: '#4e5866',
        glow: 0,
        outlineColor: '#232c3a',
        /** 从中心到最远顶点的距离：首都圈按它缩放，大地块的大圈才套得住 */
        radius: r.polygon.reduce(
          (m, q) => Math.max(m, Math.hypot(q.x - r.center.x, q.y - r.center.y)),
          1
        ),
      };
      world.meshes.push(mesh);
    }

    return world.regions;
  };

  world.disposeMap = function disposeMap() {
    for (const c of capitals.values()) disposeCapital(c);
    capitals.clear();
    for (const entry of world.regions) {
      if (!entry) continue;
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.outline.geometry.dispose();
      entry.outline.material.dispose();
      entry.plate.geometry.dispose();
      entry.plate.material.dispose();
      root.remove(entry.mesh, entry.outline, entry.plate);
    }
    world.regions = [];
    world.meshes = [];
    if (ground) { root.remove(ground); ground.geometry.dispose(); ground.material.dispose(); ground = null; }
    if (world.floor) { root.remove(world.floor); world.floor.geometry.dispose(); world.floor.material.dispose(); world.floor = null; }
    for (const f of fx) { effectGroup.remove(f.obj); disposeObj(f.obj); }
    fx.length = 0;
  };

  /* ---------------------------------------------------------------- */
  /* 外观                                                              */
  /* ---------------------------------------------------------------- */

  const tmpColor = new THREE.Color();

  /** fill: 顶面颜色；glow: 自发光强度（允许 >1，用来做占领瞬间的白热） */
  world.paint = function paint(i, fill, glow = 0) {
    const e = world.regions[i];
    if (!e) return;
    if (e.fill !== fill) {
      e.fill = fill;
      e.mesh.material.color.set(fill);
      tmpColor.set(fill);
      e.mesh.material.emissive.copy(tmpColor);
    }
    // 强度每次都写：只在"变化时"写会在首次错过 glow=0 的区域，
    // 让它们停在初始值上，整张图颜色就花了
    const g = Math.max(0, Math.min(2.4, glow));
    e.mesh.material.emissiveIntensity = g;
    e.glow = g;
  };

  world.setOutline = function setOutline(i, color, opacity = 0.9) {
    const e = world.regions[i];
    if (!e) return;
    if (e.outlineColor !== color) {
      e.outlineColor = color;
      e.outline.material.color.set(color);
    }
    if (Math.abs(e.outline.material.opacity - opacity) > 0.02) {
      e.outline.material.opacity = opacity;
    }
  };

  world.setPlate = function setPlate(i, color, opacity) {
    const e = world.regions[i];
    if (!e) return;
    e.plate.material.color.set(color);
    e.plate.material.opacity = opacity;
  };

  /* ---------------------------------------------------------------- */
  /* 首都标记                                                          */
  /*                                                                   */
  /* 名牌一直浮在区域中心上空，悬浮的立体标记会被它挡住，所以全部做在   */
  /* 地面上：双层光环 + 四个缓慢旋转的刻度，读作一枚「印章」。           */
  /* 随归属换色；失守后整组移除。                                        */
  /* ---------------------------------------------------------------- */

  const capitals = new Map(); // regionId -> { group, rings:[], ticks, color, phase }

  function disposeCapital(entry) {
    root.remove(entry.group);
    entry.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  /** color 传 null 表示「这块地不再是都城」 */
  world.setCapital = function setCapital(regionId, color) {
    const cur = capitals.get(regionId);
    if (!color) {
      if (cur) {
        disposeCapital(cur);
        capitals.delete(regionId);
      }
      return;
    }
    if (cur) {
      if (cur.color !== color) {
        cur.color = color;
        for (const r of cur.rings) r.material.color.set(color);
        for (const t of cur.ticks) t.material.color.set(color);
      }
      return;
    }

    const e = world.regions[regionId];
    if (!e) return;
    const top = e.data.height;
    const rr = Math.max(1.0, Math.min(3.6, e.radius * 0.92));

    const group = new THREE.Group();
    group.position.set(e.data.center.x, 0, -e.data.center.y);

    const flat = (geo, opacity) => {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = top + 0.11;
      m.renderOrder = 3;
      group.add(m);
      return m;
    };

    // 外环粗、内环细：两个圈叠在一起才有「刻章」的感觉，单圈太像 hover 高亮
    const rings = [
      flat(new THREE.RingGeometry(rr * 0.9, rr, 64), 0.5),
      flat(new THREE.RingGeometry(rr * 0.6, rr * 0.65, 56), 0.34),
    ];

    // 地面柔光：让远处也能一眼看出「这块地不是普通地」
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(rr * 2.9, rr * 2.9),
      new THREE.MeshBasicMaterial({
        map: GLOW_TEX,
        color,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = top + 0.085;
    halo.renderOrder = 1;
    group.add(halo);

    // 四个刻度：绕中心缓慢转，静止看也像有东西在「守」
    const ticks = [];
    const tw = Math.max(0.1, rr * 0.13);
    const tl = Math.max(0.22, rr * 0.26);
    for (let i = 0; i < 4; i++) {
      const holder = new THREE.Group();
      holder.rotation.y = (i * Math.PI) / 2;
      const geo = new THREE.PlaneGeometry(tw, tl);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, top + 0.115, rr * 1.02);
      m.renderOrder = 3;
      holder.add(m);
      group.add(holder);
      ticks.push(m);
    }

    root.add(group);
    capitals.set(regionId, { group, rings, ticks, color, phase: Math.random() * 6.283 });
  };

  /** 每帧的开销很小：标记最多 4 个 */
  let capClock = 0;
  function updateCapitals(dt) {
    capClock += dt;
    const t = capClock;
    for (const c of capitals.values()) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.7 + c.phase);
      c.rings[0].material.opacity = 0.34 + 0.26 * pulse;
      c.rings[1].material.opacity = 0.2 + 0.18 * (1 - pulse);
      for (const tk of c.ticks) tk.material.opacity = 0.36 + 0.3 * pulse;
      c.group.rotation.y = t * 0.26 + c.phase;
    }
  }

  world.capitalCount = function capitalCount() {
    return capitals.size;
  };

  /* ---------------------------------------------------------------- */
  /* 拾取                                                              */
  /* ---------------------------------------------------------------- */

  world.pick = function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(world.meshes, false);
    return hits.length ? hits[0].object.userData.regionId : -1;
  };

  /* ---------------------------------------------------------------- */
  /* 特效                                                              */
  /*                                                                   */
  /* 统一用「一个对象 + 一段 update(k)」的形式排队，按进度 k 自己算变化。*/
  /* 这样加新特效只要写一个 pushFx，不用改主循环。                      */
  /* ---------------------------------------------------------------- */

  const GLOW_TEX = makeGlowTexture();
  const fx = [];

  function pushFx(obj, life, update) {
    effectGroup.add(obj);
    fx.push({ obj, t: 0, life, update });
    return obj;
  }

  function disposeObj(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose(); // 贴图是共享的，别跟着释放
      }
    });
  }

  function glowSprite(color, scale, opacity = 1) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: GLOW_TEX,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    s.scale.setScalar(scale);
    return s;
  }

  /**
   * 沿多边形轮廓生成一条「环带」，相对质心径向偏移 inner ~ outer。
   * Voronoi 单元都是凸的，用径向偏移代替真正的多边形外扩完全够看。
   * 几何以质心为原点，所以缩放 mesh 就是绕地块中心扩张/收缩。
   */
  function polygonBand(poly, inner, outer) {
    let cx = 0;
    let cy = 0;
    for (const p of poly) {
      cx += p.x;
      cy += p.y;
    }
    cx /= poly.length;
    cy /= poly.length;

    const at = (p, d) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [dx + (dx / len) * d, dy + (dy / len) * d];
    };
    const inn = poly.map((p) => at(p, inner));
    const out = poly.map((p) => at(p, outer));

    const pos = [];
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const a = [inn[i][0], 0, -inn[i][1]];
      const b = [out[i][0], 0, -out[i][1]];
      const c = [out[j][0], 0, -out[j][1]];
      const d = [inn[j][0], 0, -inn[j][1]];
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return { geo, cx, cy };
  }

  /** 火花四溅 */
  function sparkBurst(center, color, count, opt = {}) {
    const speed = opt.speed ?? 15;
    const up = opt.up ?? 1;
    const size = opt.size ?? 2.6;
    const life = opt.life ?? 0.75;
    const gravity = opt.gravity ?? 32;

    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = center.x;
      pos[i * 3 + 1] = center.y;
      pos[i * 3 + 2] = center.z;
      const a = Math.random() * Math.PI * 2;
      const r = (0.3 + Math.random() * 0.8) * speed;
      vel[i * 3] = Math.cos(a) * r;
      vel[i * 3 + 1] = up * (0.6 + Math.random() * 0.9) * speed * 0.6;
      vel[i * 3 + 2] = Math.sin(a) * r;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      map: GLOW_TEX,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;

    pushFx(pts, life, (k, dt) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        vel[i * 3 + 1] -= gravity * dt;
        arr[i * 3] += vel[i * 3] * dt;
        arr[i * 3 + 1] += vel[i * 3 + 1] * dt;
        arr[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = Math.pow(1 - k, 1.6);
      mat.size = size * (1 - 0.4 * k);
    });
  }

  /* ---- 攻击弹道：一颗带拖尾的光弹，命中再炸一下 ---- */

  world.spawnAttack = function spawnAttack(fromId, toId, color) {
    const a = world.regions[fromId];
    const b = world.regions[toId];
    if (!a || !b) return;

    const from = world.regionAnchor(fromId);
    const to = world.regionAnchor(toId);
    const arc = 4 + from.distanceTo(to) * 0.16;

    const group = new THREE.Group();
    const head = glowSprite(color, 3.6);
    group.add(head);

    const trailMat = new THREE.SpriteMaterial({
      map: GLOW_TEX,
      color,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const trail = [];
    for (let i = 1; i <= 7; i++) {
      const s = new THREE.Sprite(trailMat);
      s.scale.setScalar(2.8 - i * 0.26);
      group.add(s);
      trail.push({ s, lag: i * 0.052 });
    }

    const pointAt = (t, out) => {
      out.lerpVectors(from, to, t);
      out.y += Math.sin(Math.PI * t) * arc;
      return out;
    };
    const tmp = new THREE.Vector3();
    let hit = false;

    pushFx(group, 0.58, (k) => {
      const t = Math.min(1, k * 1.06);
      pointAt(t, tmp);
      head.position.copy(tmp);
      head.scale.setScalar(3.4 + Math.sin(k * 26) * 0.45);
      for (const d of trail) {
        pointAt(Math.max(0, t - d.lag), tmp);
        d.s.position.copy(tmp);
      }
      trailMat.opacity = 0.5 * (1 - k * 0.9);

      if (!hit && k > 0.74) {
        hit = true;
        sparkBurst(to, color, 12, { speed: 11, up: 0.8, size: 1.9, life: 0.5 });
        const flash = glowSprite(color, 3, 0.95);
        flash.position.copy(to);
        pushFx(flash, 0.26, (kk) => {
          flash.scale.setScalar(3 + 13 * kk);
          flash.material.opacity = (1 - kk) * 0.85;
        });
      }
    });
  };

  /* ---- 占领：轮廓冲击波 + 光柱 + 火花 + 核心闪光 ---- */

  world.spawnCapture = function spawnCapture(regionId, color, opt = {}) {
    const entry = world.regions[regionId];
    if (!entry) return;
    const r = entry.data;
    const y = r.height;
    const x = r.center.x;
    const z = -r.center.y;
    const big = !!opt.big;
    const rad = Math.sqrt(Math.max(1, r.area) / Math.PI);

    // ① 冲击波：贴着地块轮廓的细环，由内向外炸开。
    //    用细环而不是粗带——粗带在小区块上会糊成一个白方框。
    const th = Math.max(0.45, rad * 0.17);
    const waves = big
      ? [
          { grow: 1.5, delay: 0, life: 0.7, peak: 0.95, tint: '#ffffff' },
          { grow: 2.2, delay: 0.05, life: 0.8, peak: 0.8, tint: color },
          { grow: 3.2, delay: 0.1, life: 0.92, peak: 0.55, tint: color },
        ]
      : [
          { grow: 1.7, delay: 0, life: 0.6, peak: 0.9, tint: '#ffffff' },
          { grow: 2.6, delay: 0.06, life: 0.74, peak: 0.62, tint: color },
        ];

    for (const w of waves) {
      const { geo, cx, cy } = polygonBand(r.polygon, th, th * 2);
      const mat = new THREE.MeshBasicMaterial({
        color: w.tint,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, y + 0.18, -cy);
      mesh.renderOrder = 3;
      pushFx(mesh, w.life, (k) => {
        const local = Math.max(0, (k - w.delay) / Math.max(0.35, 1 - w.delay));
        const e = 1 - Math.pow(1 - local, 2.4);
        mesh.scale.setScalar(1 + e * (w.grow - 1));
        mat.opacity = w.peak * Math.pow(1 - local, 1.5);
      });
    }

    // ② 被人抢走时：原主人的颜色向内塌缩，读起来像"地盘被打碎"
    if (opt.stolenColor) {
      const { geo, cx, cy } = polygonBand(r.polygon, th, th * 3.2);
      const mat = new THREE.MeshBasicMaterial({
        color: opt.stolenColor,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, y + 0.26, -cy);
      mesh.renderOrder = 3;
      pushFx(mesh, 0.46, (k) => {
        const e = 1 - Math.pow(1 - k, 2);
        mesh.scale.setScalar(1.7 - e * 0.9);
        mat.opacity = 0.75 * Math.pow(1 - k, 1.3);
      });
    }

    // ③ 光柱：用两片拉伸的柔光精灵叠出体积感。
    //    之前用圆柱做，透视下边缘是硬直线，像一块竖着的玻璃板。
    const beamH = big ? 30 : 15 + rad * 1.1;
    const beamY = y + beamH * 0.34;
    const beamOuter = glowSprite(color, 1, 0.55);
    beamOuter.position.set(x, beamY, z);
    pushFx(beamOuter, 0.82, (k) => {
      const rise = Math.min(1, k / 0.26);
      const e = 1 - Math.pow(1 - rise, 3);
      const w = rad * 2.4 * (0.6 + e * 0.7);
      beamOuter.scale.set(w, beamH * e, 1);
      beamOuter.material.opacity = 0.5 * Math.pow(1 - k, 1.6);
    });

    const beamInner = glowSprite(color, 1, 0.85);
    beamInner.position.set(x, beamY * 0.92, z);
    pushFx(beamInner, 0.62, (k) => {
      const rise = Math.min(1, k / 0.18);
      const e = 1 - Math.pow(1 - rise, 3);
      beamInner.scale.set(rad * 0.75 * (0.5 + e), beamH * 0.72 * e, 1);
      beamInner.material.opacity = 0.85 * Math.pow(1 - k, 2.0);
    });

    // ④ 火花
    sparkBurst(new THREE.Vector3(x, y + 1, z), color, big ? 34 : 22, {
      speed: 12 + rad * 1.1,
      size: 4.4,
      life: 0.85,
    });

    // ⑤ 核心一闪
    const core = glowSprite(color, 6, 0.95);
    core.position.set(x, y + 2, z);
    core.renderOrder = 4;
    pushFx(core, 0.3, (k) => {
      core.scale.setScalar(6 + 24 * k);
      core.material.opacity = (1 - k) * 0.85;
    });

    // ⑥ 大场面（斩首 / 灭国）：地面再铺一层扩散光斑
    if (big) {
      const halo = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: GLOW_TEX,
          color,
          transparent: true,
          opacity: 0.7,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.set(x, y + 0.1, z);
      halo.renderOrder = 2;
      const size0 = rad * 3;
      pushFx(halo, 0.9, (k) => {
        const e = 1 - Math.pow(1 - k, 2.2);
        halo.scale.set(size0 * (1 + e * 3.2), size0 * (1 + e * 3.2), 1);
        halo.material.opacity = 0.7 * Math.pow(1 - k, 1.6);
      });
    }

    // ⑦ 斩首专属：两圈大圆冲击波（金 → 白）。
    //    这里不用地块轮廓：放大 4 倍后多边形会读成一个悬空的「方框」，
    //    圆形在透视下才像炸开的气浪。
    if (opt.capital) {
      const waves = [
        { color: '#ffd27a', delay: 0, to: 4.4, life: 1.05, peak: 0.85 },
        { color: '#fff6e0', delay: 0.12, to: 3.2, life: 1.25, peak: 0.7 },
      ];
      for (const w of waves) {
        const mat = new THREE.MeshBasicMaterial({
          color: w.color,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 96), mat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, y + 0.22, z);
        ring.renderOrder = 3;
        const base = rad * 1.1;
        pushFx(ring, w.life, (k) => {
          const local = Math.max(0, (k - w.delay) / Math.max(0.3, 1 - w.delay));
          const e = 1 - Math.pow(1 - local, 2.2);
          ring.scale.setScalar(base * (0.3 + e * w.to));
          mat.opacity = w.peak * Math.pow(1 - local, 1.3);
        });
      }

      sparkBurst(new THREE.Vector3(x, y + 1.4, z), '#ffd27a', 26, {
        speed: 16 + rad * 1.4,
        size: 5,
        life: 1.0,
      });

      const white = glowSprite('#fff6e0', 10, 1);
      white.position.set(x, y + 2.6, z);
      white.renderOrder = 5;
      pushFx(white, 0.4, (k) => {
        white.scale.setScalar(8 + 30 * k);
        white.material.opacity = (1 - k) * 0.9;
      });
    }
  };

  world.effectCount = () => fx.length;

  world.updateEffects = function updateEffects(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.update(k, dt);
      if (k >= 1) {
        effectGroup.remove(f.obj);
        disposeObj(f.obj);
        fx.splice(i, 1);
      }
    }
  };

  /* ---- 震屏 ---- */

  let shakePower = 0;
  const shakeOffset = new THREE.Vector3();

  world.shake = function shake(power = 1) {
    shakePower = Math.min(2.6, shakePower + power);
  };

  function updateShake(dt) {
    if (shakePower < 0.002) {
      shakePower = 0;
      shakeOffset.set(0, 0, 0);
      return;
    }
    shakePower *= Math.pow(0.0009, dt); // 衰减得很快，不然会晕
    const a = shakePower * 2.2;
    shakeOffset.set(
      (Math.random() - 0.5) * a,
      (Math.random() - 0.5) * a * 0.7,
      (Math.random() - 0.5) * a
    );
  }

  /* ---------------------------------------------------------------- */
  /* 相机                                                              */
  /* ---------------------------------------------------------------- */

  let tween = null;

  /** 根据画幅给出合适的取景（竖屏水平视野窄，需要拉远 + 加大 fov） */
  world.homeView = function homeView() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    const r = world.baseRadius;
    if (aspect < 0.95) {
      return { pos: { x: 0, y: r * 2.95, z: r * 1.9 }, target: { x: 0, y: 0, z: 0 }, fov: 62 };
    }
    return { pos: { x: 0, y: r * 1.88, z: r * 2.12 }, target: { x: 0, y: 0, z: 0 }, fov: 40 };
  };

  world.flyTo = function flyTo(pos, target, dur = 1.1, fov) {
    tween = {
      p0: camera.position.clone(),
      p1: new THREE.Vector3(pos.x, pos.y, pos.z),
      t0: controls.target.clone(),
      t1: new THREE.Vector3(target.x, target.y, target.z),
      f0: camera.fov,
      f1: fov ?? camera.fov,
      t: 0,
      dur,
    };
  };

  world.resetCamera = function resetCamera() {
    const v = world.homeView();
    camera.fov = v.fov;
    camera.updateProjectionMatrix();
    camera.position.set(v.pos.x, v.pos.y, v.pos.z);
    controls.target.set(v.target.x, v.target.y, v.target.z);
    controls.update();
  };

  function updateTween(dt) {
    if (!tween) return;
    tween.t += dt;
    const k = Math.min(1, tween.t / tween.dur);
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (tween.f0 !== tween.f1) {
      camera.fov = tween.f0 + (tween.f1 - tween.f0) * e;
      camera.updateProjectionMatrix();
    }
    if (k >= 1) tween = null;
  }

  /* ---------------------------------------------------------------- */
  /* 尺寸                                                              */
  /* ---------------------------------------------------------------- */

  world.resize = function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      // 横竖屏切换时重新取景
      const portrait = w / Math.max(1, h) < 0.95;
      if (world._portrait !== undefined && world._portrait !== portrait) world.resetCamera();
      world._portrait = portrait;
    }
  };

  world.render = function render(dt) {
    updateTween(dt);
    updateLabels(dt);
    updateCapitals(dt);
    world.updateEffects(dt);
    controls.update();
    updateShake(dt);
    // 震屏不能直接改相机位置后不管：OrbitControls 下帧会拿它当新的轨道位置，
    // 镜头会越抖越偏。所以只在渲染这一下加上偏移，渲染完就撤回。
    if (shakeOffset.lengthSq() > 0) {
      camera.position.add(shakeOffset);
      renderer.render(scene, camera);
      camera.position.sub(shakeOffset);
    } else {
      renderer.render(scene, camera);
    }
  };

  /** 区域顶面中心的世界坐标（特效起点） */
  world.regionAnchor = function regionAnchor(regionId) {
    const r = world.regions[regionId];
    if (!r) return new THREE.Vector3();
    return new THREE.Vector3(r.data.center.x, r.data.height + 1.2, -r.data.center.y);
  };

  return world;
}
