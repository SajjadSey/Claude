import * as THREE from 'three';
import { G, groups, R } from '../core/physics.js';
import { makeRng, DEG } from '../core/util.js';
import * as T from './textures.js';
import { GeoBucket, box, wall, hquad, strip, taperedTube, normalizeGeo } from './geom.js';

export const CITY = {
  N: 7,
  BLOCK: 72,
  ROAD_W: 14,
  SIDEWALK: 4.5,
  CURB: 0.15,
  LANE: 2.3,
  PARK_LANE: 5.7,
};
const HR = CITY.ROAD_W / 2; // half road
export const nodeCoord = (i) => (i - (CITY.N - 1) / 2) * CITY.BLOCK;
export const EXTENT = nodeCoord(CITY.N - 1); // 216
const OUTER = EXTENT + HR; // 223 : outer curb line
const OUTER_DEPTH = 40;
const BEACH_X0 = OUTER + 5;
const SHORE_X = 286;
export const WORLD_BOUNDS = { minX: -OUTER - OUTER_DEPTH, maxX: SHORE_X - 2, minZ: -OUTER - OUTER_DEPTH, maxZ: OUTER + OUTER_DEPTH };

const PALETTES = {
  deco: [['#f6c9c0', '#2fb5ad'], ['#aee6d0', '#ff7b8a'], ['#ffd8b8', '#2f7fb0'], ['#fff1d0', '#e8566c'], ['#cdd3f0', '#ff9d3b']],
  hotel: [['#f7f3ea', '#2aa7a0'], ['#fde3d5', '#ff6f61'], ['#e3f4f8', '#1f7a9a']],
  stucco: [['#efe1c6', '#2e6b5e'], ['#f4d6cc', '#4a5f8a'], ['#e8e3d3', '#8a3b3b'], ['#d9eadf', '#6a4a8a']],
  brick: [['#a0533e', '#ffffff'], ['#8a5a4a', '#ffffff'], ['#b5735a', '#ffffff']],
  glass: [['#d5dde2', '#ffffff'], ['#3a4750', '#ffffff'], ['#9fb1bc', '#ffffff']],
};
const NEON = [['NEON', '#ff3df2'], ['MOTEL', '#39e6ff'], ['CAFE', '#ffcf3d'], ['DINER', '#ff4d6d'], ['BAR', '#7dff6b'],
  ['HOTEL', '#ff7b3d'], ['PALMS', '#3dffb5'], ['SUNSET', '#ff5fa2'], ['TACOS', '#ffe23d'], ['CLUB', '#b26bff']];

export class City {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.rng = makeRng(20260901);
    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);
    this.mats = {};
    this.facadeMats = [];
    this.bucket = new GeoBucket();
    this.parkingSpots = [];
    this.palms = [];
    this.lamps = [];
    this.trees = [];
    this.props = []; // dynamic prop spawn requests {type,x,y,z,yaw}
    this.breakables = [];
    this.lightHeads = [];
    this.blocks = [];
    this.spawn = { x: 0, z: 0, yaw: 0 };
    this.nightLights = [];
  }

  /* ------------------------------------------------------------------ materials */
  mat(key) { return this.mats[key]; }

  makeMaterials() {
    const M = this.mats;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    M.asphalt = std({ map: T.asphaltTexture(), roughnessMap: T.asphaltRoughness(), roughness: 0.95, color: 0xffffff });
    M.lotAsphalt = std({ map: T.asphaltTexture(), roughness: 0.92, color: 0xd8d8d8 });
    M.sidewalk = std({ map: T.concreteTexture(), roughness: 0.9 });
    M.curb = std({ map: T.plainConcreteTexture(), roughness: 0.85, color: 0xdedad2 });
    M.plaza = std({ map: T.plainConcreteTexture(), roughness: 0.85, color: 0xf0e6d8 });
    M.grass = std({ map: T.grassTexture(), roughness: 1.0 });
    M.sand = std({ map: T.sandTexture(), roughness: 1.0 });
    M.dirt = std({ map: T.dirtTexture(), roughness: 1.0 });
    M.roof = std({ map: T.roofTexture(), roughness: 0.95 });
    M.parapet = std({ map: T.plainConcreteTexture(), color: 0xf2eee6, roughness: 0.85 });
    M.metal = std({ color: 0x8f959c, metalness: 0.7, roughness: 0.35 });
    M.darkMetal = std({ color: 0x2a2d31, metalness: 0.6, roughness: 0.45 });
    M.wood = std({ color: 0x8a6440, roughness: 0.8 });
    M.white = std({ color: 0xf4f2ec, roughness: 0.6 });
    M.red = std({ color: 0xc8202a, roughness: 0.45, metalness: 0.2 });
    M.yellowPaint = std({ color: 0xf2c230, roughness: 0.5 });
    const mark = (c) => std({ color: c, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    M.markWhite = mark(0xe9e8e0);
    M.markYellow = mark(0xe3b52a);
    M.skidBase = mark(0x333333);
    M.bark = std({ map: T.barkTexture(), roughness: 0.95 });
    M.palmLeaf = std({ map: T.palmLeafTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8 });
    M.foliage = std({ color: 0x3f7a35, roughness: 0.9, flatShading: true });
    M.lampGlow = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffd28a, emissiveIntensity: 0.25, roughness: 0.3 });
    M.water = std({ color: 0x3a8fb0, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.85 });
    M.glassDark = std({ color: 0x1d2a33, roughness: 0.1, metalness: 0.8 });
    M.canvasBlue = std({ color: 0x2a7fd4, roughness: 0.8, side: THREE.DoubleSide });
    M.canvasRed = std({ color: 0xe0453a, roughness: 0.8, side: THREE.DoubleSide });
    M.canvasYellow = std({ color: 0xf5c84a, roughness: 0.8, side: THREE.DoubleSide });
    M.rubber = std({ color: 0x18181a, roughness: 0.9 });
    M.signBack = std({ color: 0x1a1a1e, roughness: 0.6 });
  }

  solidMat(color) {
    const key = 'solid_' + color;
    if (!this.mats[key]) this.mats[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
    return key;
  }

  facadeMat(style, pi) {
    const key = `f_${style}_${pi}`;
    if (!this.mats[key]) {
      const [w, a] = PALETTES[style][pi];
      const tex = T.facadeTexture(style, w, a, pi + 1);
      const glass = style === 'glass';
      const m = new THREE.MeshStandardMaterial({
        map: tex.map, emissiveMap: tex.emissive, emissive: 0xffffff, emissiveIntensity: 0,
        roughness: glass ? 0.2 : 0.85, metalness: glass ? 0.25 : 0.0, envMapIntensity: glass ? 1.2 : 0.6,
      });
      this.mats[key] = m;
      this.facadeMats.push(m);
    }
    return key;
  }

  shopMat(seed, wallCol, awning) {
    const key = `shop_${seed}`;
    if (!this.mats[key]) {
      this.mats[key] = new THREE.MeshStandardMaterial({ map: T.shopTexture(seed, wallCol, awning), roughness: 0.6, metalness: 0.1 });
    }
    return key;
  }

  neonMat(i) {
    const key = 'neon_' + i;
    if (!this.mats[key]) {
      const [txt, col] = NEON[i % NEON.length];
      this.mats[key] = new THREE.MeshBasicMaterial({
        map: T.neonSignTexture(txt, col), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      this.mats[key].userData.neon = true;
    }
    return key;
  }

  /* ------------------------------------------------------------------ build */
  build() {
    this.makeMaterials();
    this.buildGround();
    this.buildRoadMarkings();
    for (let i = 0; i < CITY.N - 1; i++) for (let j = 0; j < CITY.N - 1; j++) this.buildBlock(i, j);
    this.buildOuterStrips();
    this.buildBeach();
    this.buildWalls();
    this.buildTrafficLights();
    this.buildStreetFurniture();
    this.buildPalmsInstanced();
    this.buildLampsInstanced();
    this.buildTreesInstanced();
    this.bucket.build(this.group, this.mats, {
      shadows: {
        asphalt: { cast: false, receive: true },
        markWhite: { cast: false, receive: true },
        markYellow: { cast: false, receive: true },
        sand: { cast: false, receive: true },
        grass: { cast: false, receive: true },
        lotAsphalt: { cast: false, receive: true },
        sidewalk: { cast: false, receive: true },
      },
    });
    for (const m of this.group.children) {
      if (m.material && m.material.userData && m.material.userData.neon) { m.castShadow = false; m.receiveShadow = false; m.renderOrder = 2; }
    }
    this.buildRoadGraph();
    this.buildPedGraph();
    this.buildMinimap();
  }

  /* ------------------------------------------------------------------ ground & roads */
  buildGround() {
    const P = this.physics;
    const S = 700;
    this.bucket.add('asphalt', hquad(-S / 2, -S / 2, S / 2, S / 2, 0, 9));
    P.addStaticBox(0, -0.5, 0, S / 2, 0.5, S / 2, 0, { surface: 'asphalt', friction: 1.0 });
  }

  buildRoadMarkings() {
    const b = this.bucket;
    const N = CITY.N;
    const segs = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - 1; j++) {
        // road along z at x = nodeCoord(i), between z nodes j and j+1
        segs.push({ x0: nodeCoord(i), z0: nodeCoord(j), x1: nodeCoord(i), z1: nodeCoord(j + 1) });
        // road along x at z = nodeCoord(i)
        segs.push({ x0: nodeCoord(j), z0: nodeCoord(i), x1: nodeCoord(j + 1), z1: nodeCoord(i) });
      }
    }
    this.roadSegments = segs;
    for (const s of segs) {
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len = Math.hypot(dx, dz);
      const ux = dx / len, uz = dz / len;
      const rx = -uz, rz = ux; // right of direction
      const yaw = Math.atan2(ux, uz);
      const a = HR + 3.4, bLen = len - 2 * a;
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      // double yellow
      for (const o of [-0.16, 0.16]) b.add('markYellow', strip(cx + rx * o, cz + rz * o, bLen, 0.12, yaw));
      // parking lane edge lines (dashed-ish long dashes)
      for (const side of [-1, 1]) {
        const o = side * 4.4;
        const dash = 6, gap = 3;
        for (let t = -bLen / 2; t < bLen / 2 - 1; t += dash + gap) {
          const l = Math.min(dash, bLen / 2 - t);
          const m = t + l / 2;
          b.add('markWhite', strip(cx + rx * o + ux * m, cz + rz * o + uz * m, l, 0.12, yaw));
        }
      }
      // crosswalks + stop lines at both ends
      for (const end of [0, 1]) {
        const nx = end ? s.x1 : s.x0, nz = end ? s.z1 : s.z0;
        const dir = end ? -1 : 1; // pointing from node into segment
        const cwMid = HR + 1.7;
        for (let o = -HR + 0.9; o <= HR - 0.9; o += 1.1) {
          b.add('markWhite', strip(nx + ux * dir * cwMid + rx * o, nz + uz * dir * cwMid + rz * o, 3.0, 0.55, yaw));
        }
        // stop line across the lanes entering the node (right side of traffic heading to node)
        const stopD = HR + 3.7;
        const travelSign = -dir; // traffic heading towards node travels in -dir*u
        const lrx = -(uz * travelSign), lrz = ux * travelSign; // right side of that traffic
        const lineYaw = yaw + Math.PI / 2;
        const off = 2.2;
        b.add('markWhite', strip(nx + ux * dir * stopD + lrx * off, nz + uz * dir * stopD + lrz * off, 4.0, 0.45, lineYaw));
      }
    }
  }

  /* ------------------------------------------------------------------ blocks */
  slab(x0, z0, x1, z1, lotMat, lotInset, surface = 'concrete') {
    const P = this.physics, b = this.bucket, h = CITY.CURB;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    P.addStaticBox(cx, h / 2, cz, hx, h / 2, hz, 0, { surface: 'concrete' });
    // sidewalk ring top
    const li = lotInset;
    if (li > 0) {
      b.add('sidewalk', hquad(x0, z0, x1, z0 + li, h, 6));
      b.add('sidewalk', hquad(x0, z1 - li, x1, z1, h, 6));
      b.add('sidewalk', hquad(x0, z0 + li, x0 + li, z1 - li, h, 6));
      b.add('sidewalk', hquad(x1 - li, z0 + li, x1, z1 - li, h, 6));
      // lot
      b.add(lotMat, hquad(x0 + li, z0 + li, x1 - li, z1 - li, h + 0.002, lotMat === 'grass' ? 7 : lotMat === 'sand' ? 9 : 5));
      if (surface !== 'concrete') {
        P.addStaticBox(cx, h / 2 + 0.002, cz, hx - li, h / 2, hz - li, 0, { surface });
      }
      // inner low kerb around grass/sand lots
      if (lotMat === 'grass') {
        for (const [ax, az, bx, bz] of [[x0 + li, z0 + li, x1 - li, z0 + li + 0.2], [x0 + li, z1 - li - 0.2, x1 - li, z1 - li],
          [x0 + li, z0 + li, x0 + li + 0.2, z1 - li], [x1 - li - 0.2, z0 + li, x1 - li, z1 - li]]) {
          b.add('curb', box(bx - ax, 0.08, bz - az, (ax + bx) / 2, h + 0.04, (az + bz) / 2, { uvScale: 2, skip: ['ny'] }));
        }
      }
    } else {
      b.add(lotMat, hquad(x0, z0, x1, z1, h, 6));
    }
    // curb faces + lip
    const lip = 0.22;
    b.add('curb', box(x1 - x0, h + 0.012, lip, cx, (h + 0.012) / 2, z0 + lip / 2, { uvScale: 2, skip: ['ny'] }));
    b.add('curb', box(x1 - x0, h + 0.012, lip, cx, (h + 0.012) / 2, z1 - lip / 2, { uvScale: 2, skip: ['ny'] }));
    b.add('curb', box(lip, h + 0.012, z1 - z0 - 2 * lip, x0 + lip / 2, (h + 0.012) / 2, cz, { uvScale: 2, skip: ['ny'] }));
    b.add('curb', box(lip, h + 0.012, z1 - z0 - 2 * lip, x1 - lip / 2, (h + 0.012) / 2, cz, { uvScale: 2, skip: ['ny'] }));
  }

  blockType(i, j) {
    const key = `${i},${j}`;
    const special = {
      '1,4': 'park', '4,1': 'park', '2,1': 'parking', '3,4': 'parking', '0,5': 'stunt', '3,2': 'plaza', '0,0': 'park',
    };
    if (special[key]) return special[key];
    const ci = Math.abs(i - 2.5), cj = Math.abs(j - 2.5);
    if (ci <= 1 && cj <= 1) return 'downtown';
    if (i === 5) return 'beachfront';
    return 'mixed';
  }

  buildBlock(i, j) {
    const x0 = nodeCoord(i) + HR, x1 = nodeCoord(i + 1) - HR;
    const z0 = nodeCoord(j) + HR, z1 = nodeCoord(j + 1) - HR;
    const type = this.blockType(i, j);
    const sw = CITY.SIDEWALK;
    const lot = { x0: x0 + sw, z0: z0 + sw, x1: x1 - sw, z1: z1 - sw };
    this.blocks.push({ i, j, type, x0, z0, x1, z1, lot });
    const r = this.rng;
    if (type === 'park') {
      this.slab(x0, z0, x1, z1, 'grass', sw, 'grass');
      this.buildPark(lot);
    } else if (type === 'parking') {
      this.slab(x0, z0, x1, z1, 'lotAsphalt', sw, 'asphalt');
      this.buildParkingLot(lot);
    } else if (type === 'stunt') {
      this.slab(x0, z0, x1, z1, 'lotAsphalt', sw, 'asphalt');
      this.buildStuntPark(lot);
    } else if (type === 'plaza') {
      this.slab(x0, z0, x1, z1, 'plaza', sw);
      this.buildPlaza(lot);
    } else {
      this.slab(x0, z0, x1, z1, 'plaza', sw);
      this.buildBuildingsBlock(lot, type, r);
    }
    // sidewalk furniture along the block edges
    this.decorateSidewalks(x0, z0, x1, z1, type);
  }

  buildBuildingsBlock(lot, type, r) {
    const w = lot.x1 - lot.x0, d = lot.z1 - lot.z0;
    const style = () => {
      if (type === 'downtown') return r.pick(['glass', 'glass', 'deco', 'hotel']);
      if (type === 'beachfront') return r.pick(['hotel', 'deco', 'deco', 'hotel']);
      return r.pick(['stucco', 'brick', 'deco', 'stucco']);
    };
    const height = () => {
      if (type === 'downtown') return r.range(38, 96);
      if (type === 'beachfront') return r.range(18, 44);
      return r.range(8, 26);
    };
    const layout = type === 'downtown' ? r.pick(['tower', 'quad', 'rows']) : r.pick(['quad', 'rows', 'rows', 'quad']);
    const gap = 4;
    const parcels = [];
    if (layout === 'tower') {
      parcels.push([lot.x0 + 4, lot.z0 + 4, lot.x1 - 4, lot.z1 - 4]);
    } else if (layout === 'quad') {
      const mx = lot.x0 + w / 2, mz = lot.z0 + d / 2;
      parcels.push([lot.x0, lot.z0, mx - gap / 2, mz - gap / 2], [mx + gap / 2, lot.z0, lot.x1, mz - gap / 2],
        [lot.x0, mz + gap / 2, mx - gap / 2, lot.z1], [mx + gap / 2, mz + gap / 2, lot.x1, lot.z1]);
    } else {
      const along = r.chance(0.5);
      const n = 3;
      for (let k = 0; k < n; k++) {
        if (along) {
          const a = lot.x0 + k * (w + gap) / n, b2 = lot.x0 + (k + 1) * (w + gap) / n - gap;
          parcels.push([a, lot.z0, b2, lot.z1]);
        } else {
          const a = lot.z0 + k * (d + gap) / n, b2 = lot.z0 + (k + 1) * (d + gap) / n - gap;
          parcels.push([lot.x0, a, lot.x1, b2]);
        }
      }
    }
    for (const [a, b2, c, e] of parcels) {
      const st = style();
      const pi = r.int(0, PALETTES[st].length - 1);
      const inset = r.range(0, 1.5);
      this.addBuilding(a + inset, b2 + inset, c - inset, e - inset, height(), st, pi, r);
    }
    // alley clutter: boxes, dumpsters
    const ax = lot.x0 + w / 2, az = lot.z0 + d / 2;
    if (layout !== 'tower') {
      this.props.push({ type: 'dumpster', x: ax + r.range(-1, 1), y: CITY.CURB, z: az + r.range(-6, 6), yaw: r.pick([0, Math.PI / 2]) });
      for (let k = 0; k < 3; k++) this.props.push({ type: 'box', x: ax + r.range(-1.2, 1.2), y: CITY.CURB, z: az + r.range(-10, 10), yaw: r() * 3 });
    }
  }

  addBuilding(x0, z0, x1, z1, h, style, pi, r) {
    const b = this.bucket, P = this.physics;
    const base = CITY.CURB;
    const fm = this.facadeMat(style, pi);
    const [wallCol, accent] = PALETTES[style][pi];
    const hasShops = style !== 'glass' && r.chance(0.75);
    const gf = 4.4;
    const tall = h > 40;
    const h1 = tall ? h * r.range(0.55, 0.75) : h;
    const walk = (ax0, az0, ax1, az1, y0, y1, mat, us, vs, vo) => {
      const pts = [[ax0, az1], [ax1, az1], [ax1, az0], [ax0, az0], [ax0, az1]];
      for (let k = 0; k < 4; k++) b.add(mat, wall(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], y0, y1, us, vs, vo));
    };
    if (hasShops) {
      const sm = this.shopMat(r.int(1, 999), wallCol, accent);
      walk(x0, z0, x1, z1, base, base + gf, sm, 8, gf, base);
      walk(x0, z0, x1, z1, base + gf, base + h1, fm, 8, 7, base + gf);
      // awnings
      const aw = this.solidMat(accent);
      const ah = base + gf - 0.25, dep = 1.1;
      b.add(aw, box(x1 - x0 - 1, 0.12, dep, (x0 + x1) / 2, ah, z1 + dep / 2));
      b.add(aw, box(x1 - x0 - 1, 0.12, dep, (x0 + x1) / 2, ah, z0 - dep / 2));
      b.add(aw, box(dep, 0.12, z1 - z0 - 1, x1 + dep / 2, ah, (z0 + z1) / 2));
      b.add(aw, box(dep, 0.12, z1 - z0 - 1, x0 - dep / 2, ah, (z0 + z1) / 2));
      // cornice band between shop and upper floors
      b.add('parapet', box(x1 - x0 + 0.3, 0.35, z1 - z0 + 0.3, (x0 + x1) / 2, base + gf + 0.1, (z0 + z1) / 2, { uvScale: 2 }));
    } else {
      walk(x0, z0, x1, z1, base, base + h1, fm, 8, 7, base);
    }
    // roof + parapet
    b.add('roof', hquad(x0, z0, x1, z1, base + h1, 8));
    this.parapetRing(x0, z0, x1, z1, base + h1, style === 'glass' ? 'darkMetal' : 'parapet');
    P.addStaticBox((x0 + x1) / 2, base + h1 / 2, (z0 + z1) / 2, (x1 - x0) / 2, h1 / 2, (z1 - z0) / 2, 0, { surface: 'concrete' });
    let topY = base + h1;
    if (tall) {
      const ins = Math.min((x1 - x0), (z1 - z0)) * r.range(0.12, 0.22);
      const ux0 = x0 + ins, uz0 = z0 + ins, ux1 = x1 - ins, uz1 = z1 - ins;
      walk(ux0, uz0, ux1, uz1, base + h1, base + h, fm, 8, 7, base);
      b.add('roof', hquad(ux0, uz0, ux1, uz1, base + h, 8));
      this.parapetRing(ux0, uz0, ux1, uz1, base + h, style === 'glass' ? 'darkMetal' : 'parapet');
      P.addStaticBox((ux0 + ux1) / 2, base + (h1 + h) / 2, (uz0 + uz1) / 2, (ux1 - ux0) / 2, (h - h1) / 2, (uz1 - uz0) / 2);
      topY = base + h;
      // antenna
      if (r.chance(0.6)) {
        b.add('darkMetal', new THREE.CylinderGeometry(0.15, 0.3, 12, 6).translate((ux0 + ux1) / 2, topY + 6, (uz0 + uz1) / 2));
      }
      this.rooftop(ux0, uz0, ux1, uz1, topY, r);
    } else {
      this.rooftop(x0, z0, x1, z1, topY, r);
    }
    // deco corner tower
    if (style === 'deco' && !tall && r.chance(0.55)) {
      const cr = Math.min(4, (x1 - x0) / 4);
      const corner = r.int(0, 3);
      const cx = corner & 1 ? x1 - cr * 0.6 : x0 + cr * 0.6;
      const cz = corner & 2 ? z1 - cr * 0.6 : z0 + cr * 0.6;
      const ch = h1 + 4;
      const cyl = new THREE.CylinderGeometry(cr, cr, ch, 24, 1, true);
      const uv = cyl.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (2 * Math.PI * cr) / 8, uv.getY(k) * ch / 7);
      cyl.translate(cx, base + ch / 2, cz);
      b.add(fm, cyl);
      const crown = this.solidMat(accent);
      b.add(crown, new THREE.CylinderGeometry(cr + 0.35, cr + 0.35, 0.6, 24).translate(cx, base + ch, cz));
      b.add('parapet', new THREE.CylinderGeometry(cr * 0.5, cr + 0.1, 2.2, 24).translate(cx, base + ch + 1.4, cz));
      b.add(crown, new THREE.CylinderGeometry(0.12, 0.12, 4, 6).translate(cx, base + ch + 4, cz));
      P.addStaticCylinder(cx, base + ch / 2, cz, ch / 2, cr, { surface: 'concrete' });
    }
    // vertical deco fins / bands
    if ((style === 'deco' || style === 'hotel') && r.chance(0.6)) {
      const aw = this.solidMat(accent);
      const fins = Math.floor((x1 - x0) / 8);
      for (let k = 1; k < fins; k++) {
        const fx = x0 + k * (x1 - x0) / fins;
        b.add(aw, box(0.35, h1 - gf - 1, 0.5, fx, base + gf + (h1 - gf) / 2 + 0.5, z1 + 0.25));
        b.add(aw, box(0.35, h1 - gf - 1, 0.5, fx, base + gf + (h1 - gf) / 2 + 0.5, z0 - 0.25));
      }
    }
    // neon sign
    if (style !== 'glass' && r.chance(0.55)) {
      const ni = r.int(0, NEON.length - 1);
      const nm = this.neonMat(ni);
      const side = r.int(0, 3);
      const sy = base + gf + r.range(1.2, Math.max(1.5, Math.min(8, h1 - gf - 3)));
      const sw = Math.min(7, (side < 2 ? x1 - x0 : z1 - z0) - 2), sh = sw / 4;
      const plane = new THREE.PlaneGeometry(sw, sh);
      const back = box(sw + 0.3, sh + 0.2, 0.12, 0, 0, -0.08);
      const m = new THREE.Matrix4();
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (side === 0) m.makeRotationY(0).setPosition(cx, sy, z1 + 0.22);
      else if (side === 1) m.makeRotationY(Math.PI).setPosition(cx, sy, z0 - 0.22);
      else if (side === 2) m.makeRotationY(Math.PI / 2).setPosition(x1 + 0.22, sy, cz);
      else m.makeRotationY(-Math.PI / 2).setPosition(x0 - 0.22, sy, cz);
      b.add(nm, plane, m);
      b.add('signBack', back, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      this.nightLights.push({ x: p.x, y: p.y, z: p.z, color: NEON[ni % NEON.length][1] });
    }
  }

  parapetRing(x0, z0, x1, z1, y, mat) {
    const b = this.bucket, t = 0.3, ph = 0.9;
    b.add(mat, box(x1 - x0, ph, t, (x0 + x1) / 2, y + ph / 2, z0 + t / 2, { uvScale: 2 }));
    b.add(mat, box(x1 - x0, ph, t, (x0 + x1) / 2, y + ph / 2, z1 - t / 2, { uvScale: 2 }));
    b.add(mat, box(t, ph, z1 - z0 - 2 * t, x0 + t / 2, y + ph / 2, (z0 + z1) / 2, { uvScale: 2 }));
    b.add(mat, box(t, ph, z1 - z0 - 2 * t, x1 - t / 2, y + ph / 2, (z0 + z1) / 2, { uvScale: 2 }));
  }

  rooftop(x0, z0, x1, z1, y, r) {
    const b = this.bucket;
    const n = r.int(1, 4);
    for (let k = 0; k < n; k++) {
      const sx = r.range(1.5, 3.5), sz = r.range(1.5, 3), sy = r.range(1, 2);
      const cx = r.range(x0 + 2 + sx / 2, x1 - 2 - sx / 2), cz = r.range(z0 + 2 + sz / 2, z1 - 2 - sz / 2);
      b.add('metal', box(sx, sy, sz, cx, y + sy / 2, cz));
      b.add('darkMetal', new THREE.CylinderGeometry(sx * 0.3, sx * 0.3, 0.15, 12).translate(cx, y + sy + 0.08, cz));
    }
    if (r.chance(0.35)) {
      const cx = r.range(x0 + 3, x1 - 3), cz = r.range(z0 + 3, z1 - 3);
      b.add('wood', new THREE.CylinderGeometry(1.4, 1.4, 2.6, 14).translate(cx, y + 3.4, cz));
      b.add('wood', new THREE.ConeGeometry(1.6, 0.9, 14).translate(cx, y + 5.1, cz));
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        b.add('darkMetal', box(0.12, 2.1, 0.12, cx + dx * 0.9, y + 1.05, cz + dz * 0.9));
      }
    }
  }

  decorateSidewalks(x0, z0, x1, z1, type) {
    const r = this.rng;
    // palms / lamps along each edge
    const edges = [
      [x0, z0, x1, z0, 0, -1], [x0, z1, x1, z1, 0, 1], [x0, z0, x0, z1, -1, 0], [x1, z0, x1, z1, 1, 0],
    ];
    for (const [ax, az, bx, bz, nx, nz] of edges) {
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const palmy = type === 'beachfront' || type === 'park' || r.chance(0.35);
      for (let t = 9; t < len - 8; t += 12) {
        const px = ax + ux * t - nx * 1.0, pz = az + uz * t - nz * 1.0;
        const k = Math.round(t / 12);
        if (k % 2 === 0) {
          this.lamps.push({ x: px, z: pz, yaw: Math.atan2(nx, nz) });
        } else if (palmy) {
          this.palms.push({ x: px, z: pz, s: r.range(0.85, 1.15), rot: r() * Math.PI * 2, v: r.int(0, 2) });
        }
      }
      // furniture
      if (r.chance(0.6)) {
        const t = r.range(14, len - 14);
        const px = ax + ux * t - nx * 3.6, pz = az + uz * t - nz * 3.6;
        this.addBench(px, pz, Math.atan2(nx, nz));
      }
      if (r.chance(0.7)) {
        const t = r.range(6, len - 6);
        this.props.push({ type: 'trash', x: ax + ux * t - nx * 0.9, y: CITY.CURB, z: az + uz * t - nz * 0.9, yaw: 0 });
      }
      if (r.chance(0.45)) {
        const t = r.range(8, len - 8);
        this.addHydrant(ax + ux * t - nx * 0.7, az + uz * t - nz * 0.7);
      }
      if (r.chance(0.2)) {
        const t = r.range(8, len - 8);
        this.props.push({ type: 'newsbox', x: ax + ux * t - nx * 3.8, y: CITY.CURB, z: az + uz * t - nz * 3.8, yaw: Math.atan2(nx, nz) });
      }
    }
  }

  addBench(x, z, yaw) {
    const b = this.bucket, y = CITY.CURB;
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    b.add('wood', box(1.8, 0.06, 0.45, 0, 0.45, 0), m);
    b.add('wood', box(1.8, 0.45, 0.06, 0, 0.75, -0.22), m);
    for (const sx of [-0.8, 0.8]) {
      b.add('darkMetal', box(0.06, 0.45, 0.45, sx, 0.22, 0), m);
      b.add('darkMetal', box(0.06, 0.5, 0.06, sx, 0.7, -0.22), m);
    }
    const c = this.physics.addStaticBox(x, y + 0.45, z, 0.9, 0.45, 0.3, yaw, { surface: 'wood' });
    void c;
  }

  addHydrant(x, z) {
    const b = this.bucket, y = CITY.CURB;
    b.add('red', new THREE.CylinderGeometry(0.13, 0.15, 0.6, 12).translate(x, y + 0.3, z));
    b.add('red', new THREE.SphereGeometry(0.14, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, y + 0.6, z));
    b.add('red', new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8).rotateZ(Math.PI / 2).translate(x, y + 0.42, z));
    b.add('metal', new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8).translate(x, y + 0.72, z));
    const c = this.physics.addStaticCylinder(x, y + 0.35, z, 0.35, 0.16, { owner: { type: 'hydrant', surface: 'metal' } });
    this.breakables.push({ kind: 'hydrant', x, y, z, collider: c, broken: false });
  }

  buildPark(lot) {
    const r = this.rng, b = this.bucket;
    const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;
    // crossing paths
    b.add('plaza', hquad(lot.x0, cz - 1.5, lot.x1, cz + 1.5, CITY.CURB + 0.006, 4));
    b.add('plaza', hquad(cx - 1.5, lot.z0, cx + 1.5, lot.z1, CITY.CURB + 0.007, 4));
    // fountain
    this.addFountain(cx, cz, 4.2);
    for (let k = 0; k < 14; k++) {
      const x = r.range(lot.x0 + 3, lot.x1 - 3), z = r.range(lot.z0 + 3, lot.z1 - 3);
      if (Math.abs(x - cx) < 3.5 || Math.abs(z - cz) < 3.5) continue;
      if (r.chance(0.55)) this.palms.push({ x, z, s: r.range(0.9, 1.25), rot: r() * 6.28, v: r.int(0, 2) });
      else this.trees.push({ x, z, s: r.range(0.8, 1.3), rot: r() * 6.28 });
    }
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      this.addBench(cx + Math.sin(a) * 7.5 + Math.cos(a) * 2.6, cz + Math.cos(a) * 7.5 - Math.sin(a) * 2.6, a + Math.PI);
    }
  }

  addFountain(cx, cz, rad) {
    const b = this.bucket, y = CITY.CURB;
    const ring = new THREE.TorusGeometry(rad, 0.3, 8, 40).rotateX(Math.PI / 2).translate(cx, y + 0.5, cz);
    b.add('parapet', ring);
    b.add('parapet', new THREE.CylinderGeometry(rad, rad, 0.5, 40, 1, true).translate(cx, y + 0.25, cz));
    b.add('water', new THREE.CircleGeometry(rad - 0.1, 40).rotateX(-Math.PI / 2).translate(cx, y + 0.42, cz));
    b.add('parapet', new THREE.CylinderGeometry(0.5, 0.8, 1.6, 16).translate(cx, y + 0.8, cz));
    b.add('parapet', new THREE.CylinderGeometry(1.6, 0.3, 0.35, 24).translate(cx, y + 1.7, cz));
    b.add('water', new THREE.CylinderGeometry(1.45, 1.45, 0.05, 24).translate(cx, y + 1.86, cz));
    this.physics.addStaticCylinder(cx, y + 0.3, cz, 0.3, rad + 0.3, { surface: 'concrete' });
    this.physics.addStaticCylinder(cx, y + 1.0, cz, 1.0, 0.8, { surface: 'concrete' });
    this.fountains = this.fountains || [];
    this.fountains.push({ x: cx, y: y + 1.9, z: cz });
  }

  buildParkingLot(lot) {
    const b = this.bucket, r = this.rng;
    const stallW = 3.0, stallD = 5.5;
    const w = lot.x1 - lot.x0;
    const n = Math.floor((w - 4) / stallW);
    const mid = (lot.z0 + lot.z1) / 2;
    const rows = [lot.z0 + 1 + stallD / 2, mid - stallD / 2, mid + stallD / 2, lot.z1 - 1 - stallD / 2];
    for (const zc of rows) {
      for (let s = 0; s <= n; s++) {
        const x = lot.x0 + 2 + s * stallW;
        b.add('markWhite', strip(x, zc, stallD, 0.12, 0, CITY.CURB + 0.014));
        if (s < n && r.chance(0.5)) {
          this.parkingSpots.push({ x: x + stallW / 2, y: CITY.CURB, z: zc, yaw: r.chance(0.5) ? 0 : Math.PI });
        }
      }
    }
    for (const [x, z] of [[lot.x0 + 1, lot.z0 + 13], [lot.x1 - 1, lot.z1 - 13]]) this.lamps.push({ x, z, yaw: 0 });
  }

  buildStuntPark(lot) {
    const b = this.bucket, P = this.physics;
    const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;
    const y = CITY.CURB;
    const ramp = (x, z, yaw, len, wid, hgt, mat = 'yellowPaint') => {
      // wedge rising along +z (local)
      const hl = len / 2, hw = wid / 2;
      const pts = [
        [-hw, 0, -hl], [hw, 0, -hl], [hw, 0, hl], [-hw, 0, hl], [-hw, hgt, hl], [hw, hgt, hl],
      ];
      const g = new THREE.BufferGeometry();
      const P0 = pts.map((p) => new THREE.Vector3(...p));
      const tri = (a, c, d) => [P0[a], P0[c], P0[d]];
      const faces = [
        tri(0, 4, 5), tri(0, 5, 1), // slope (top)
        tri(3, 2, 5), tri(3, 5, 4), // back
        tri(0, 1, 2), tri(0, 2, 3), // bottom
        tri(0, 3, 4), // side
        tri(1, 5, 2), // side
      ];
      const pos = [];
      for (const f of faces) for (const v of f) pos.push(v.x, v.y, v.z);
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const uv = [];
      for (let k = 0; k < pos.length; k += 3) uv.push(pos[k] / 2, pos[k + 2] / 2);
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
      b.add(mat, g, m);
      // stripes on slope
      const verts = new Float32Array(pts.flat());
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const desc = R.ColliderDesc.convexHull(verts).setTranslation(x, y, z).setRotation(q).setFriction(0.9)
        .setCollisionGroups(groups(G.STATIC, G.ALL));
      const c = P.world.createCollider(desc, P.fixed);
      P.setOwner(c, { type: 'static', surface: 'metal' });
    };
    ramp(cx - 10, cz - 8, 0, 12, 6, 2.2);
    ramp(cx - 10, cz + 12, Math.PI, 10, 6, 1.6);
    ramp(cx + 10, cz, Math.PI / 2, 14, 7, 3.0, 'red');
    ramp(cx + 14, cz - 16, -Math.PI / 2, 7, 4, 1.0);
    // barrels & boxes to smash
    for (let k = 0; k < 10; k++) this.props.push({ type: 'barrel', x: cx - 4 + (k % 5) * 1.1, y, z: cz + 16 + Math.floor(k / 5) * 1.1, yaw: 0 });
    let n = 0;
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4 - row; k++) {
        this.props.push({ type: 'crate', x: cx + 2 + k * 1.05 + row * 0.52, y: y + row * 1.0, z: cz - 18, yaw: 0 });
        n++;
      }
    }
    for (let k = 0; k < 12; k++) this.props.push({ type: 'cone', x: cx - 18 + k * 2.5, y, z: cz + 4 + Math.sin(k) * 2, yaw: 0 });
  }

  buildPlaza(lot) {
    const b = this.bucket, r = this.rng;
    const cx = (lot.x0 + lot.x1) / 2, cz = (lot.z0 + lot.z1) / 2;
    this.addFountain(cx, cz, 6);
    // checker pattern tiles
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2;
      this.palms.push({ x: cx + Math.cos(a) * 17, z: cz + Math.sin(a) * 17, s: r.range(0.9, 1.1), rot: r() * 6.28, v: k % 3 });
      k += 2;
    }
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2 + 0.3;
      this.addBench(cx + Math.cos(a) * 10, cz + Math.sin(a) * 10, -a - Math.PI / 2);
    }
    // statue
    b.add('parapet', box(2, 1.2, 2, cx + 14, CITY.CURB + 0.6, cz - 14));
    b.add('metal', new THREE.TorusKnotGeometry(0.8, 0.25, 80, 10).translate(cx + 14, CITY.CURB + 2.4, cz - 14));
    this.physics.addStaticBox(cx + 14, CITY.CURB + 1.2, cz - 14, 1, 1.2, 1);
  }

  /* ------------------------------------------------------------------ periphery */
  buildOuterStrips() {
    const r = this.rng;
    const d = OUTER_DEPTH;
    const strips = [
      // [x0,z0,x1,z1, facing]
      [-OUTER - d, -OUTER - d, -OUTER, OUTER + d, 'w'],
      [-OUTER, -OUTER - d, OUTER, -OUTER, 'n'],
      [-OUTER, OUTER, OUTER, OUTER + d, 's'],
    ];
    for (const [x0, z0, x1, z1, f] of strips) {
      this.slab(x0, z0, x1, z1, 'plaza', 0);
      // sidewalk band along road side
      const sw = 4.5;
      let bx0 = x0, bz0 = z0, bx1 = x1, bz1 = z1;
      if (f === 'w') { this.bucket.add('sidewalk', hquad(x1 - sw, z0, x1, z1, CITY.CURB + 0.004, 6)); bx1 = x1 - sw - 1; }
      if (f === 'n') { this.bucket.add('sidewalk', hquad(x0, z1 - sw, x1, z1, CITY.CURB + 0.004, 6)); bz1 = z1 - sw - 1; }
      if (f === 's') { this.bucket.add('sidewalk', hquad(x0, z0, x1, z0 + sw, CITY.CURB + 0.004, 6)); bz0 = z0 + sw + 1; }
      const along = f === 'w' ? 'z' : 'x';
      const L = along === 'z' ? bz1 - bz0 : bx1 - bx0;
      let t = 0;
      while (t < L - 8) {
        const w = Math.min(r.range(14, 30), L - t);
        const st = r.pick(['stucco', 'brick', 'deco', 'hotel']);
        const pi = r.int(0, PALETTES[st].length - 1);
        const h = r.range(9, 30);
        if (along === 'z') this.addBuilding(bx0 + 2, bz0 + t, bx1, bz0 + t + w - 1, h, st, pi, r);
        else this.addBuilding(bx0 + t, bz0 + (f === 's' ? 0 : 2), bx0 + t + w - 1, bz1 - (f === 's' ? 2 : 0), h, st, pi, r);
        t += w;
      }
      // lamps along the road edge
      if (f === 'w') for (let z = z0 + 10; z < z1 - 10; z += 24) this.lamps.push({ x: x1 - 1, z, yaw: Math.PI / 2 });
      if (f === 'n') for (let x = x0 + 10; x < x1 - 10; x += 24) this.lamps.push({ x, z: z1 - 1, yaw: 0 });
      if (f === 's') for (let x = x0 + 10; x < x1 - 10; x += 24) this.lamps.push({ x, z: z0 + 1, yaw: Math.PI });
    }
  }

  buildBeach() {
    const b = this.bucket, P = this.physics, r = this.rng;
    const z0 = -OUTER - OUTER_DEPTH, z1 = OUTER + OUTER_DEPTH;
    // boardwalk
    this.slab(OUTER, z0, BEACH_X0, z1, 'sidewalk', 0);
    // wooden boardwalk deck
    b.add('wood', box(4.4, 0.05, z1 - z0, (OUTER + BEACH_X0) / 2 + 0.1, CITY.CURB + 0.025, 0, { uvScale: 1.2, skip: ['ny'] }));
    // sand (flat top at curb height, slopes to water visually)
    const sx1 = SHORE_X + 30;
    b.add('sand', hquad(BEACH_X0, z0, SHORE_X - 2, z1, CITY.CURB, 9));
    // sloped sand into water
    const slope = new THREE.PlaneGeometry(36, z1 - z0, 4, 1);
    slope.rotateX(-Math.PI / 2);
    const sp = slope.attributes.position;
    for (let k = 0; k < sp.count; k++) {
      const x = sp.getX(k);
      sp.setY(k, CITY.CURB - (x + 18) / 36 * 2.2);
    }
    slope.computeVertexNormals();
    const uv = slope.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 4, uv.getY(k) * (z1 - z0) / 9);
    slope.translate(SHORE_X - 2 + 18, 0, 0);
    b.add('sand', slope);
    P.addStaticBox((BEACH_X0 + SHORE_X) / 2, CITY.CURB / 2, 0, (SHORE_X - BEACH_X0) / 2, CITY.CURB / 2, (z1 - z0) / 2, 0, { surface: 'sand', friction: 0.7 });
    this.beach = { x0: BEACH_X0, x1: SHORE_X, z0, z1 };
    void sx1;
    // palms
    for (let z = z0 + 6; z < z1 - 6; z += r.range(7, 14)) {
      this.palms.push({ x: BEACH_X0 + r.range(2, 8), z, s: r.range(0.9, 1.3), rot: r() * 6.28, v: r.int(0, 2) });
      if (r.chance(0.4)) this.palms.push({ x: BEACH_X0 + r.range(20, 45), z: z + r.range(-3, 3), s: r.range(0.8, 1.2), rot: r() * 6.28, v: r.int(0, 2) });
    }
    // lifeguard towers
    for (const z of [-150, -20, 110]) this.addLifeguardTower(SHORE_X - 22, z);
    // umbrellas + towels
    const canv = ['canvasBlue', 'canvasRed', 'canvasYellow'];
    for (let k = 0; k < 40; k++) {
      const x = r.range(BEACH_X0 + 14, SHORE_X - 10), z = r.range(z0 + 10, z1 - 10);
      const cm = r.pick(canv);
      b.add('white', new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6).translate(x, CITY.CURB + 1.15, z));
      b.add(cm, new THREE.ConeGeometry(1.3, 0.45, 12, 1, true).translate(x, CITY.CURB + 2.2, z));
      const tm = new THREE.Matrix4().makeRotationY(r() * 3).setPosition(x + r.range(0.8, 1.5), CITY.CURB + 0.01, z + r.range(-0.5, 0.5));
      b.add(r.pick(canv), new THREE.PlaneGeometry(0.9, 1.8).rotateX(-Math.PI / 2), tm);
    }
    // volleyball net
    const nx = BEACH_X0 + 30, nz = 60;
    b.add('wood', new THREE.CylinderGeometry(0.06, 0.06, 2.6, 8).translate(nx, CITY.CURB + 1.3, nz - 4.5));
    b.add('wood', new THREE.CylinderGeometry(0.06, 0.06, 2.6, 8).translate(nx, CITY.CURB + 1.3, nz + 4.5));
    b.add('white', box(0.02, 0.9, 9, nx, CITY.CURB + 2.0, nz));
    P.addStaticCylinder(nx, CITY.CURB + 1.3, nz - 4.5, 1.3, 0.08);
    P.addStaticCylinder(nx, CITY.CURB + 1.3, nz + 4.5, 1.3, 0.08);
  }

  addLifeguardTower(x, z) {
    const b = this.bucket, y = CITY.CURB, P = this.physics;
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      b.add('wood', box(0.18, 2.4, 0.18, x + dx * 1.1, y + 1.2, z + dz * 1.1));
    }
    b.add('white', box(2.8, 0.15, 2.8, x, y + 2.45, z));
    const hut = this.solidMat('#5fd0c8');
    b.add(hut, box(2.4, 1.9, 2.2, x, y + 3.5, z));
    b.add('canvasRed', box(2.8, 0.15, 2.6, x, y + 4.55, z));
    b.add('glassDark', box(0.05, 0.8, 1.6, x - 1.22, y + 3.8, z));
    // ramp
    const rm = new THREE.Matrix4().makeRotationZ(-0.62).setPosition(x - 2.6, y + 1.2, z);
    b.add('wood', box(3.4, 0.08, 1.0, 0, 0, 0), rm);
    P.addStaticBox(x, y + 2.5, z, 1.4, 0.1, 1.4);
    P.addStaticBox(x, y + 3.5, z, 1.2, 0.95, 1.1);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.addStaticBox(x + dx * 1.1, y + 1.2, z + dz * 1.1, 0.09, 1.2, 0.09);
  }

  buildWalls() {
    const P = this.physics;
    const B = WORLD_BOUNDS;
    const H = 30;
    P.addStaticBox(B.minX - 1, H / 2, 0, 1, H / 2, 400, 0, { surface: 'concrete' });
    P.addStaticBox(B.maxX + 1, H / 2, 0, 1, H / 2, 400, 0, { surface: 'concrete' });
    P.addStaticBox(0, H / 2, B.minZ - 1, 400, H / 2, 1, 0, { surface: 'concrete' });
    P.addStaticBox(0, H / 2, B.maxZ + 1, 400, H / 2, 1, 0, { surface: 'concrete' });
  }

  /* ------------------------------------------------------------------ traffic lights */
  buildTrafficLights() {
    const N = CITY.N;
    const poleGeo = [];
    const lampPositions = [];
    const r = this.rng;
    this.lightPhase = new Map();
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const nx = nodeCoord(i), nz = nodeCoord(j);
      const deg = (i > 0) + (i < N - 1) + (j > 0) + (j < N - 1);
      if (deg < 3) continue;
      this.lightPhase.set(i * N + j, r.range(0, 28));
      // approaches: direction of travel towards node
      const approaches = [];
      if (j > 0) approaches.push([0, 1]); // coming from -z travelling +z
      if (j < N - 1) approaches.push([0, -1]);
      if (i > 0) approaches.push([1, 0]);
      if (i < N - 1) approaches.push([-1, 0]);
      for (const [dx, dz] of approaches) {
        const rx = -dz, rz = dx; // right of travel
        const cx = nx - dx * (HR + 1.2) + rx * (HR + 1.2);
        const cz = nz - dz * (HR + 1.2) + rz * (HR + 1.2);
        const yaw = Math.atan2(-dx, -dz); // head faces oncoming traffic
        const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(cx, CITY.CURB, cz);
        poleGeo.push(m);
        // lamp positions in world: head hangs over lane at arm end
        const armLen = HR + 1.2 - 2.3;
        const hx = cx - rx * armLen, hz = cz - rz * armLen;
        const head = { node: i * N + j, axis: dx !== 0 ? 'x' : 'z', lamps: [] };
        for (let k = 0; k < 3; k++) {
          const ly = CITY.CURB + 6.0 - k * 0.42;
          head.lamps.push(lampPositions.length);
          lampPositions.push({ x: hx - dx * 0.22, y: ly, z: hz - dz * 0.22, kind: k });
        }
        // secondary pole-mounted head (at pedestrian level)
        for (let k = 0; k < 3; k++) {
          head.lamps.push(lampPositions.length);
          lampPositions.push({ x: cx - dx * 0.3, y: CITY.CURB + 3.2 - k * 0.32, z: cz - dz * 0.3, kind: k, small: true });
        }
        this.lightHeads.push(head);
        this.physics.addStaticCylinder(cx, CITY.CURB + 3, cz, 3, 0.14, { surface: 'metal' });
      }
    }
    // pole geometry (local: pole at origin, arm towards local -x(right->road), facing +z)
    const parts = [];
    const add = (g) => parts.push(normalizeGeo(g));
    add(new THREE.CylinderGeometry(0.11, 0.14, 6.6, 10).translate(0, 3.3, 0));
    const armLen = HR + 1.2 - 2.3 + 0.4;
    add(new THREE.CylinderGeometry(0.07, 0.09, armLen, 8).rotateZ(Math.PI / 2).translate(-armLen / 2, 6.3, 0));
    add(box(0.5, 1.45, 0.32, -(armLen - 0.4), 5.6, 0));
    add(box(0.9, 1.75, 0.04, -(armLen - 0.4), 5.6, -0.17));
    add(box(0.38, 1.05, 0.26, 0, 2.9, 0.3));
    add(new THREE.CylinderGeometry(0.2, 0.25, 0.2, 10).translate(0, 0.1, 0));
    // pole is placed at right corner; arm must extend towards the road center = local direction of -right.
    // With yaw = atan2(-dx,-dz) local +z faces oncoming traffic and local +x points to... compute per instance below.
    const merged = mergeGeos(parts);
    const inst = new THREE.InstancedMesh(merged, this.mats.darkMetal, poleGeo.length);
    const tmpM = new THREE.Matrix4();
    for (let k = 0; k < poleGeo.length; k++) {
      // local +x should point toward road center (= -right of travel = left of the facing direction)
      tmpM.copy(poleGeo[k]);
      inst.setMatrixAt(k, tmpM);
    }
    inst.castShadow = true; inst.receiveShadow = true;
    this.group.add(inst);
    // lamps
    const lampGeo = new THREE.SphereGeometry(0.13, 10, 8);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.3, toneMapped: false });
    const lampInst = new THREE.InstancedMesh(lampGeo, lampMat, lampPositions.length);
    const col = new THREE.Color(0x111111);
    for (let k = 0; k < lampPositions.length; k++) {
      const p = lampPositions[k];
      const s = p.small ? 0.75 : 1;
      tmpM.makeScale(s, s, s).setPosition(p.x, p.y, p.z);
      lampInst.setMatrixAt(k, tmpM);
      lampInst.setColorAt(k, col);
    }
    this.group.add(lampInst);
    this.lampInst = lampInst;
    this.lampPositions = lampPositions;
    this.lastLightUpdate = -1;
  }

  /** Returns 'green' | 'yellow' | 'red' for traffic travelling along `axis` ('x' or 'z') at node id. */
  lightState(nodeId, axis, time) {
    const ph = this.lightPhase.get(nodeId);
    if (ph === undefined) return 'green';
    const t = (time + ph) % 28;
    // 0-10 z green, 10-13 z yellow, 13-14 all red, 14-24 x green, 24-27 x yellow, 27-28 all red
    if (axis === 'z') return t < 10 ? 'green' : t < 13 ? 'yellow' : 'red';
    return t >= 14 && t < 24 ? 'green' : t >= 24 && t < 27 ? 'yellow' : 'red';
  }

  updateLights(time) {
    const step = Math.floor(time * 4);
    if (step === this.lastLightUpdate) return;
    this.lastLightUpdate = step;
    const off = new THREE.Color(0x1a1a1a);
    const colors = [new THREE.Color(5, 0.25, 0.15), new THREE.Color(5, 3.4, 0.2), new THREE.Color(0.2, 5, 1.2)];
    for (const h of this.lightHeads) {
      const st = this.lightState(h.node, h.axis, time);
      const on = st === 'red' ? 0 : st === 'yellow' ? 1 : 2;
      for (let k = 0; k < h.lamps.length; k++) {
        const li = h.lamps[k];
        const kind = this.lampPositions[li].kind;
        this.lampInst.setColorAt(li, kind === on ? colors[kind] : off);
      }
    }
    this.lampInst.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ instanced vegetation & lamps */
  buildStreetFurniture() {
    // bus stops at a few places
    const r = this.rng;
    for (let k = 0; k < 6; k++) {
      const blk = r.pick(this.blocks.filter((bk) => bk.type === 'mixed' || bk.type === 'downtown'));
      if (!blk) continue;
      const x = (blk.x0 + blk.x1) / 2 + r.range(-10, 10), z = blk.z1 - 2.6;
      this.addBusStop(x, z, Math.PI);
    }
  }

  addBusStop(x, z, yaw) {
    const b = this.bucket, y = CITY.CURB;
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    for (const sx of [-1.8, 1.8]) b.add('metal', box(0.08, 2.5, 0.08, sx, 1.25, -0.6), m);
    b.add('metal', box(3.9, 0.08, 1.6, 0, 2.5, 0), m);
    b.add('glassDark', box(3.6, 1.8, 0.04, 0, 1.4, -0.65), m);
    b.add('wood', box(2.6, 0.06, 0.4, 0, 0.5, -0.35), m);
    const ad = this.solidMat('#ff6f91');
    b.add(ad, box(0.05, 1.7, 1.2, 1.85, 1.4, 0), m);
    this.physics.addStaticBox(x, y + 1.25, z, 1.9, 1.25, 0.15, yaw);
  }

  buildPalmsInstanced() {
    const variants = [];
    for (let v = 0; v < 3; v++) {
      const lean = [0.6, 1.4, 2.2][v];
      const H = 8.5;
      const pts = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        pts.push(new THREE.Vector3(Math.sin(t * 1.2) * lean * t, t * H, 0));
      }
      const trunk = taperedTube(pts, 0.26, 0.16, 9);
      // TubeGeometry: uv.x runs along the length, uv.y around -> bark rings along the trunk
      const uv = trunk.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getY(k), uv.getX(k) * 8.0);
      const top = pts[pts.length - 1];
      // fronds
      const frondParts = [];
      const nF = 11;
      for (let f = 0; f < nF; f++) {
        const a = f / nF * Math.PI * 2 + v;
        const len = 3.6 + (f % 3) * 0.4;
        const droop = 0.9 + (f % 2) * 0.4;
        const g = new THREE.PlaneGeometry(1.0, len, 1, 8);
        const p = g.attributes.position;
        for (let k = 0; k < p.count; k++) {
          const yy = p.getY(k) + len / 2; // 0..len
          const t = yy / len;
          const x = p.getX(k) * (0.4 + 0.9 * Math.sin(Math.PI * Math.min(1, t * 1.1)));
          // fold leaflets into a shallow V
          const vfold = Math.abs(p.getX(k)) * 0.35;
          p.setXYZ(k, x, -droop * t * t * len * 0.55 + vfold + t * 0.6, yy);
        }
        g.computeVertexNormals();
        g.rotateY(a);
        g.rotateX(0);
        g.translate(top.x, top.y, top.z);
        frondParts.push(normalizeGeo(g));
      }
      // coconuts
      const nuts = [];
      for (let k = 0; k < 4; k++) {
        const a = k * 1.7;
        nuts.push(normalizeGeo(new THREE.SphereGeometry(0.16, 8, 6).translate(top.x + Math.cos(a) * 0.25, top.y - 0.3, top.z + Math.sin(a) * 0.25)));
      }
      variants.push({ trunk, fronds: mergeGeos(frondParts), nuts: mergeGeos(nuts) });
    }
    const nutMat = new THREE.MeshStandardMaterial({ color: 0x5a4a22, roughness: 0.8 });
    const tm = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    this.palmInstances = [];
    for (let v = 0; v < 3; v++) {
      const list = this.palms.filter((pl) => pl.v === v);
      if (!list.length) continue;
      const trunkI = new THREE.InstancedMesh(variants[v].trunk, this.mats.bark, list.length);
      const frondI = new THREE.InstancedMesh(variants[v].fronds, this.mats.palmLeaf, list.length);
      const nutI = new THREE.InstancedMesh(variants[v].nuts, nutMat, list.length);
      list.forEach((pl, k) => {
        const y = this.groundY(pl.x, pl.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.rot);
        s.setScalar(pl.s);
        p.set(pl.x, y, pl.z);
        tm.compose(p, q, s);
        trunkI.setMatrixAt(k, tm);
        frondI.setMatrixAt(k, tm);
        nutI.setMatrixAt(k, tm);
        this.physics.addStaticCylinder(pl.x, y + 1.5, pl.z, 1.5, 0.24 * pl.s, { surface: 'wood' });
      });
      for (const im of [trunkI, frondI, nutI]) { im.castShadow = true; im.receiveShadow = true; this.group.add(im); }
      frondI.userData.sway = true;
      this.palmInstances.push(frondI);
    }
  }

  buildTreesInstanced() {
    if (!this.trees.length) return;
    const trunk = new THREE.CylinderGeometry(0.15, 0.25, 3.2, 8).translate(0, 1.6, 0);
    const parts = [];
    const r = makeRng(5);
    for (let k = 0; k < 7; k++) {
      const g = new THREE.IcosahedronGeometry(r.range(1.2, 1.8), 1);
      g.translate(r.range(-1.2, 1.2), 3.6 + r.range(0, 1.6), r.range(-1.2, 1.2));
      parts.push(normalizeGeo(g));
    }
    const crown = mergeGeos(parts);
    const tI = new THREE.InstancedMesh(trunk, this.mats.bark, this.trees.length);
    const cI = new THREE.InstancedMesh(crown, this.mats.foliage, this.trees.length);
    const tm = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    this.trees.forEach((t, k) => {
      const y = this.groundY(t.x, t.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      s.setScalar(t.s); p.set(t.x, y, t.z);
      tm.compose(p, q, s);
      tI.setMatrixAt(k, tm); cI.setMatrixAt(k, tm);
      this.physics.addStaticCylinder(t.x, y + 1.5, t.z, 1.5, 0.22 * t.s, { surface: 'wood' });
    });
    for (const im of [tI, cI]) { im.castShadow = true; im.receiveShadow = true; this.group.add(im); }
  }

  buildLampsInstanced() {
    const parts = [];
    parts.push(normalizeGeo(new THREE.CylinderGeometry(0.08, 0.13, 7, 8).translate(0, 3.5, 0)));
    parts.push(normalizeGeo(new THREE.CylinderGeometry(0.2, 0.25, 0.5, 8).translate(0, 0.25, 0)));
    // curved arm towards +z
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 6.8, 0), new THREE.Vector3(0, 7.6, 0.6), new THREE.Vector3(0, 7.3, 1.8));
    parts.push(normalizeGeo(new THREE.TubeGeometry(curve, 10, 0.06, 6)));
    parts.push(normalizeGeo(box(0.35, 0.16, 0.8, 0, 7.25, 2.0)));
    const pole = mergeGeos(parts);
    const head = new THREE.BoxGeometry(0.28, 0.06, 0.66).translate(0, 7.15, 2.0);
    const poleI = new THREE.InstancedMesh(pole, this.mats.darkMetal, this.lamps.length);
    const headI = new THREE.InstancedMesh(head, this.mats.lampGlow, this.lamps.length);
    const tm = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    this.lamps.forEach((l, k) => {
      const y = this.groundY(l.x, l.z);
      // arm should point toward the road: yaw given is outward normal of block edge
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.yaw);
      p.set(l.x, y, l.z);
      tm.compose(p, q, s);
      poleI.setMatrixAt(k, tm); headI.setMatrixAt(k, tm);
      l.index = k;
      l.y = y;
      const c = this.physics.addStaticCylinder(l.x, y + 3.5, l.z, 3.5, 0.13, { owner: { type: 'lamp', surface: 'metal', lamp: l } });
      l.collider = c;
      l.broken = false;
      this.breakables.push({ kind: 'lamp', lamp: l, collider: c });
      const hp = new THREE.Vector3(0, 7.1, 2.0).applyQuaternion(q).add(p);
      this.nightLights.push({ x: hp.x, y: hp.y, z: hp.z, color: '#ffd28a', lamp: true });
    });
    poleI.castShadow = true; poleI.receiveShadow = true;
    headI.castShadow = false;
    this.group.add(poleI); this.group.add(headI);
    this.lampPoleInst = poleI; this.lampHeadInst = headI;
    this.lampPoleGeo = pole; this.lampHeadGeo = head;
  }

  hideLampInstance(k) {
    const z = new THREE.Matrix4().makeScale(0, 0, 0);
    this.lampPoleInst.setMatrixAt(k, z);
    this.lampHeadInst.setMatrixAt(k, z);
    this.lampPoleInst.instanceMatrix.needsUpdate = true;
    this.lampHeadInst.instanceMatrix.needsUpdate = true;
  }

  groundY(x, z) {
    // Everything except the road surface is raised by the curb height.
    if (this.isRoad(x, z)) return 0;
    return CITY.CURB;
  }

  isRoad(x, z) {
    if (x > OUTER + 0.01) return false;
    if (x < -OUTER || z < -OUTER || z > OUTER) return false;
    const m = (v) => {
      const t = v - nodeCoord(0);
      const k = Math.round(t / CITY.BLOCK);
      return Math.abs(t - k * CITY.BLOCK) <= HR;
    };
    return m(x) || m(z);
  }

  /* ------------------------------------------------------------------ graphs */
  buildRoadGraph() {
    const N = CITY.N;
    this.nodes = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      this.nodes.push({ id: i * N + j, i, j, x: nodeCoord(i), z: nodeCoord(j), links: [] });
    }
    for (const n of this.nodes) {
      const { i, j } = n;
      if (i > 0) n.links.push((i - 1) * N + j);
      if (i < N - 1) n.links.push((i + 1) * N + j);
      if (j > 0) n.links.push(i * N + j - 1);
      if (j < N - 1) n.links.push(i * N + j + 1);
    }
    // street parking along segments
    const r = this.rng;
    for (const s of this.roadSegments) {
      for (const dirSign of [1, -1]) {
        if (!r.chance(0.35)) continue;
        const ax = dirSign > 0 ? s.x0 : s.x1, az = dirSign > 0 ? s.z0 : s.z1;
        const bx = dirSign > 0 ? s.x1 : s.x0, bz = dirSign > 0 ? s.z1 : s.z0;
        const len = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        const rx = -uz, rz = ux;
        const n = r.int(1, 2);
        for (let k = 0; k < n; k++) {
          const t = r.range(HR + 7, len - HR - 7);
          this.parkingSpots.push({ x: ax + ux * t + rx * CITY.PARK_LANE, y: 0, z: az + uz * t + rz * CITY.PARK_LANE, yaw: Math.atan2(ux, uz), street: true });
        }
      }
    }
  }

  buildPedGraph() {
    const nodes = [];
    const idx = new Map();
    const key = (x, z) => `${Math.round(x)},${Math.round(z)}`;
    const add = (x, z) => {
      const k = key(x, z);
      if (idx.has(k)) return idx.get(k);
      const id = nodes.length;
      nodes.push({ id, x, z, y: CITY.CURB, links: [], cross: [] });
      idx.set(k, id);
      return id;
    };
    const link = (a, b, crossing = false) => {
      if (a === b) return;
      if (!nodes[a].links.includes(b)) { nodes[a].links.push(b); nodes[a].cross.push(crossing); }
      if (!nodes[b].links.includes(a)) { nodes[b].links.push(a); nodes[b].cross.push(crossing); }
    };
    const off = HR + 2.0; // path offset from road centerline
    const N = CITY.N;
    // corners around each node
    const corner = (i, j, sx, sz) => add(nodeCoord(i) + sx * off, nodeCoord(j) + sz * off);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = {};
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        // skip corners outside the walkable city on the periphery except beach boardwalk side
        c[`${sx},${sz}`] = corner(i, j, sx, sz);
      }
      // crossings around the node (zebra)
      link(c['-1,-1'], c['1,-1'], true);
      link(c['-1,1'], c['1,1'], true);
      link(c['-1,-1'], c['-1,1'], true);
      link(c['1,-1'], c['1,1'], true);
    }
    // sidewalks along blocks between nodes
    for (let i = 0; i < N; i++) for (let j = 0; j < N - 1; j++) {
      for (const sx of [-1, 1]) {
        link(corner(i, j, sx, 1), corner(i, j + 1, sx, -1));
        link(corner(j, i, 1, sx), corner(j + 1, i, -1, sx));
      }
    }
    // remove links that cross the beach boundary weirdly: all fine (boardwalk at east)
    this.pedNodes = nodes;
  }

  /* ------------------------------------------------------------------ minimap */
  buildMinimap() {
    const S = 1024;
    const c = T.canvas(S);
    const ctx = c.getContext('2d');
    const B = { minX: -300, maxX: 340, minZ: -300, maxZ: 300 };
    const sc = S / (B.maxX - B.minX);
    this.minimap = { canvas: c, scale: sc, ox: B.minX, oz: B.minZ };
    const X = (x) => (x - B.minX) * sc, Z = (z) => (z - B.minZ) * sc;
    ctx.fillStyle = '#4a83a8';
    ctx.fillRect(0, 0, S, S);
    // land
    ctx.fillStyle = '#9c9a94';
    ctx.fillRect(X(WORLD_BOUNDS.minX), Z(WORLD_BOUNDS.minZ), X(SHORE_X) - X(WORLD_BOUNDS.minX), Z(WORLD_BOUNDS.maxZ) - Z(WORLD_BOUNDS.minZ));
    // beach
    ctx.fillStyle = '#e6d3a3';
    ctx.fillRect(X(BEACH_X0), Z(WORLD_BOUNDS.minZ), X(SHORE_X) - X(BEACH_X0), Z(WORLD_BOUNDS.maxZ) - Z(WORLD_BOUNDS.minZ));
    // roads
    ctx.fillStyle = '#3b3d42';
    for (let i = 0; i < CITY.N; i++) {
      const v = nodeCoord(i);
      ctx.fillRect(X(v - HR), Z(-OUTER), CITY.ROAD_W * sc, (2 * OUTER) * sc);
      ctx.fillRect(X(-OUTER), Z(v - HR), (2 * OUTER) * sc, CITY.ROAD_W * sc);
    }
    // blocks
    for (const bk of this.blocks) {
      const col = { park: '#6aa457', parking: '#55585e', stunt: '#c9a33a', plaza: '#d8cdb8', downtown: '#c4c1bc', beachfront: '#e8c8c0', mixed: '#cfcac0' }[bk.type];
      ctx.fillStyle = col;
      ctx.fillRect(X(bk.lot.x0), Z(bk.lot.z0), (bk.lot.x1 - bk.lot.x0) * sc, (bk.lot.z1 - bk.lot.z0) * sc);
    }
    // lane center lines
    ctx.strokeStyle = 'rgba(240,200,60,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < CITY.N; i++) {
      const v = nodeCoord(i);
      ctx.beginPath(); ctx.moveTo(X(v), Z(-OUTER)); ctx.lineTo(X(v), Z(OUTER)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(-OUTER), Z(v)); ctx.lineTo(X(OUTER), Z(v)); ctx.stroke();
    }
  }

  /** Spawn location for the player: on a sidewalk near the center. */
  playerSpawn() {
    const x = nodeCoord(3) + HR + 2.2, z = nodeCoord(3) + 22;
    return { x, y: CITY.CURB, z, yaw: Math.PI };
  }

  update(time, dt) {
    this.updateLights(time);
    void dt;
  }
}

function mergeGeos(list) {
  // local import to avoid circular helper
  return _merge(list);
}
import { mergeGeometries as _mg } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
function _merge(list) { return _mg(list.map((g) => normalizeGeo(g)), false); }
void DEG;
