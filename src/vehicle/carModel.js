import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { plateTexture, tireTexture, crackedGlassTexture } from '../world/textures.js';
import { clamp, smoothstep, lerp, makeRng } from '../core/util.js';

/** Vehicle archetypes: geometry + physics parameters. */
export const CAR_TYPES = {
  sedan: {
    label: 'Sedan', length: 4.62, width: 1.84, wheelbase: 2.74, wheelOffset: 0.06, wheelR: 0.33, wheelW: 0.225, track: 1.57,
    bottomY: 0.27, beltY: 0.96, roofY: 1.45, noseY: 0.76, tailY: 0.99, crown: 0.035,
    zWindBase: 0.95, zRoofFront: 0.16, zRoofRear: -0.92, zRearBase: -1.5, tumble: 0.17,
    zDoorFront: 0.9, zDoorRear: -0.3, zB: [-0.4, -0.3], zC: -1.25, rearDoorSeam: -1.15,
    seat: [0.37, 0.5, -0.36], noseR: 0.24, tailR: 0.2, planR: 0.6,
    mass: 1380, torque: 340, redline: 6800, gears: [3.3, 2.1, 1.5, 1.16, 0.93, 0.76], finalDrive: 3.7,
    grip: 1.12, rearGrip: 1.07, springHz: 1.3, damping: 0.3, suspTravel: 0.28, arb: 5000, dragCA: 0.72, brake: 15000,
    steerMax: 0.62, rollCenter: 0.06, colors: ['#c1121f', '#f2f2f0', '#1d3557', '#8d99ae', '#2b2d42', '#0b0b0b', '#118ab2', '#6a994e', '#e9c46a'],
  },
  sport: {
    label: 'Sport', length: 4.5, width: 1.94, wheelbase: 2.62, wheelOffset: -0.05, wheelR: 0.34, wheelW: 0.27, track: 1.66,
    bottomY: 0.2, beltY: 0.84, roofY: 1.22, noseY: 0.62, tailY: 0.9, crown: 0.03,
    zWindBase: 0.62, zRoofFront: -0.1, zRoofRear: -0.72, zRearBase: -1.72, tumble: 0.2,
    zDoorFront: 0.56, zDoorRear: -0.72, zB: [-0.8, -0.72], zC: -1.0, rearDoorSeam: null,
    seat: [0.39, 0.33, -0.55], noseR: 0.28, tailR: 0.18, planR: 0.75, spoiler: true,
    mass: 1320, torque: 520, redline: 7600, gears: [3.1, 2.15, 1.6, 1.25, 1.0, 0.82], finalDrive: 3.6,
    grip: 1.25, rearGrip: 1.2, springHz: 1.6, damping: 0.34, suspTravel: 0.22, arb: 7000, dragCA: 0.62, brake: 18000,
    steerMax: 0.6, rollCenter: 0.05, colors: ['#ff006e', '#ffbe0b', '#3a86ff', '#fb5607', '#e5e5e5', '#06d6a0', '#8338ec', '#111111'],
  },
  suv: {
    label: 'SUV', length: 4.85, width: 1.96, wheelbase: 2.9, wheelOffset: 0.02, wheelR: 0.39, wheelW: 0.26, track: 1.66,
    bottomY: 0.42, beltY: 1.17, roofY: 1.82, noseY: 1.0, tailY: 1.2, crown: 0.03,
    zWindBase: 1.18, zRoofFront: 0.5, zRoofRear: -2.05, zRearBase: -2.3, tumble: 0.12,
    zDoorFront: 1.08, zDoorRear: -0.12, zB: [-0.22, -0.12], zC: -1.95, rearDoorSeam: -1.05,
    seat: [0.39, 0.78, -0.15], noseR: 0.25, tailR: 0.12, planR: 0.5, roofRails: true,
    mass: 2050, torque: 480, redline: 6200, gears: [3.6, 2.2, 1.5, 1.14, 0.9, 0.72], finalDrive: 3.8,
    grip: 1.05, rearGrip: 1.02, springHz: 1.15, damping: 0.3, suspTravel: 0.32, arb: 9000, dragCA: 1.05, brake: 19000,
    steerMax: 0.6, rollCenter: 0.16, colors: ['#2b2d42', '#ffffff', '#5f0f40', '#264653', '#9a8c98', '#14213d', '#386641'],
  },
  muscle: {
    label: 'Muscle', length: 4.9, width: 1.9, wheelbase: 2.82, wheelOffset: -0.02, wheelR: 0.35, wheelW: 0.26, track: 1.62,
    bottomY: 0.24, beltY: 0.92, roofY: 1.33, noseY: 0.82, tailY: 0.94, crown: 0.02,
    zWindBase: 0.55, zRoofFront: -0.1, zRoofRear: -0.98, zRearBase: -1.55, tumble: 0.13,
    zDoorFront: 0.5, zDoorRear: -0.82, zB: [-0.9, -0.82], zC: -1.1, rearDoorSeam: null,
    seat: [0.38, 0.42, -0.6], noseR: 0.12, tailR: 0.12, planR: 0.35, hoodScoop: true,
    mass: 1560, torque: 600, redline: 6400, gears: [2.9, 1.95, 1.45, 1.12, 0.9, 0.75], finalDrive: 3.5,
    grip: 1.12, rearGrip: 1.0, springHz: 1.3, damping: 0.28, suspTravel: 0.26, arb: 4500, dragCA: 0.85, brake: 16000,
    steerMax: 0.6, rollCenter: 0.06, colors: ['#ff7b00', '#d00000', '#001d3d', '#ffd500', '#f8f9fa', '#212529', '#2a9d8f'],
  },
};
CAR_TYPES.taxi = { ...CAR_TYPES.sedan, label: 'Taxi', taxi: true, colors: ['#f5c400'] };
CAR_TYPES.police = { ...CAR_TYPES.sedan, label: 'Police', police: true, torque: 420, colors: ['#111418'] };

/* ------------------------------------------------------------------------- materials */
const sharedMats = {};
function shared() {
  if (sharedMats.glass) return sharedMats;
  sharedMats.glass = new THREE.MeshPhysicalMaterial({
    color: 0x0c1418, metalness: 0.2, roughness: 0.04, transparent: true, opacity: 0.42, side: THREE.DoubleSide,
    envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false,
  });
  sharedMats.glassCracked = new THREE.MeshPhysicalMaterial({
    color: 0x1a2328, metalness: 0.2, roughness: 0.3, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
    map: crackedGlassTexture(), depthWrite: false,
  });
  sharedMats.interior = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.85, vertexColors: true, side: THREE.DoubleSide });
  sharedMats.trim = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6 });
  sharedMats.chrome = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, metalness: 1.0, roughness: 0.12 });
  sharedMats.rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.92, map: tireTexture() });
  sharedMats.rim = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.95, roughness: 0.22 });
  sharedMats.rimDark = new THREE.MeshStandardMaterial({ color: 0x2e3034, metalness: 0.85, roughness: 0.3 });
  sharedMats.disc = new THREE.MeshStandardMaterial({ color: 0x77797d, metalness: 0.8, roughness: 0.45 });
  sharedMats.caliper = new THREE.MeshStandardMaterial({ color: 0xc1121f, roughness: 0.4 });
  sharedMats.grille = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.5, metalness: 0.3 });
  sharedMats.seat = new THREE.MeshStandardMaterial({ color: 0x3b3430, roughness: 0.9 });
  sharedMats.mirror = new THREE.MeshStandardMaterial({ color: 0xbfd4e0, metalness: 1, roughness: 0.02 });
  return sharedMats;
}

export function makeLightMats() {
  return {
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dc, emissiveIntensity: 0.35, roughness: 0.05, metalness: 0.3 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x8a0a0a, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.2 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.2 }),
    indicator: new THREE.MeshStandardMaterial({ color: 0xff8c00, emissive: 0xff8c00, emissiveIntensity: 0.1, roughness: 0.2 }),
    sirenR: new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff0000, emissiveIntensity: 0.0, roughness: 0.3 }),
    sirenB: new THREE.MeshStandardMaterial({ color: 0x000055, emissive: 0x0040ff, emissiveIntensity: 0.0, roughness: 0.3 }),
  };
}

/* ------------------------------------------------------------------------- body profile */
class Profile {
  constructor(T) {
    this.T = T;
    this.L = T.length / 2;
    this.W = T.width / 2;
    this.wheelZ = [T.wheelbase / 2 + T.wheelOffset, -T.wheelbase / 2 + T.wheelOffset];
    this.ra = T.wheelR + 0.075;
  }
  // end squeeze (side view rounding) 0..1
  squeeze(z) {
    const T = this.T, L = this.L;
    if (z > L - T.noseR) {
      const t = (z - (L - T.noseR)) / T.noseR;
      return Math.sqrt(Math.max(0, 1 - t * t));
    }
    if (z < -L + T.tailR) {
      const t = ((-L + T.tailR) - z) / T.tailR;
      return Math.sqrt(Math.max(0, 1 - t * t));
    }
    return 1;
  }
  yb(z) {
    const T = this.T, L = this.L;
    return T.bottomY + 0.13 * smoothstep(L - 0.55, L, z) + 0.12 * smoothstep(L - 0.5, L, -z);
  }
  yt(z) {
    const T = this.T, L = this.L;
    if (z >= T.zWindBase) {
      const t = smoothstep(T.zWindBase, L - 0.12, z);
      return lerp(T.beltY, T.noseY + 0.05, t) + (T.hoodScoop ? 0 : 0);
    }
    if (z <= T.zRearBase) {
      const t = smoothstep(T.zRearBase, -L + 0.1, z);
      return lerp(T.beltY, T.tailY, Math.min(1, t * 1.6)) - 0.05 * t * t;
    }
    return T.beltY;
  }
  w(z) {
    const T = this.T, L = this.L, W = this.W;
    const a = Math.abs(z);
    let k = 1;
    if (a > L - T.planR) {
      const t = (a - (L - T.planR)) / T.planR;
      k = 1 - 0.16 * t * t;
    }
    return W * k;
  }
  /** Half cross-section of the lower body at z (x >= 0), 20 points with tags. */
  section(z, out) {
    const T = this.T;
    let yb = this.yb(z), yt = this.yt(z);
    const sq = this.squeeze(z);
    const cy = (yb + yt) / 2;
    yb = cy + (yb - cy) * sq;
    yt = cy + (yt - cy) * sq;
    const w = this.w(z) * (0.72 + 0.28 * sq);
    const h = Math.max(0.001, yt - yb);
    const rb = Math.min(0.09, h * 0.3), rt = Math.min(0.13, h * 0.32);
    const crown = T.crown * sq * (z > T.zWindBase || z < T.zRearBase ? 1 : 0.3);
    let n = 0;
    const put = (x, y, tag) => { const p = out[n] || (out[n] = { x: 0, y: 0, tag: '' }); p.x = x; p.y = y; p.tag = tag; n++; };
    put(0, yb, 'under');
    put(w * 0.35, yb, 'under');
    put(w * 0.66, yb, 'under');
    put(w * 0.72, yb, 'under');
    put(w - rb, yb, 'under');
    for (let k = 1; k <= 3; k++) {
      const a = -Math.PI / 2 + (k / 3) * (Math.PI / 2);
      put(w - rb + rb * Math.cos(a), yb + rb + rb * Math.sin(a), 'side');
    }
    for (let k = 1; k <= 5; k++) {
      const y = yb + rb + (h - rb - rt) * (k / 6);
      const bul = 1 + 0.018 * Math.sin(Math.PI * (y - yb) / h);
      put(w * bul, y, 'side');
    }
    for (let k = 1; k <= 4; k++) {
      const a = (k / 4) * (Math.PI / 2);
      put(w - rt + rt * Math.cos(a), yt - rt + rt * Math.sin(a), 'shoulder');
    }
    put(w * 0.6, yt + crown * 0.55, 'top');
    put(w * 0.3, yt + crown * 0.88, 'top');
    put(0, yt + crown, 'top');
    // wheel arches
    for (const zw of this.wheelZ) {
      const dz = z - zw;
      if (Math.abs(dz) < this.ra) {
        // never cut through the top of the fender
        const arch = Math.min(T.wheelR + Math.sqrt(this.ra * this.ra - dz * dz), out[12].y - 0.05);
        for (let i = 3; i < 13; i++) {
          const p = out[i];
          if (p.y < arch && p.x > w * 0.7) {
            p.y = arch;
            if (i >= 5) p.x = Math.min(p.x, w * (0.985 - (i - 5) * 0.004));
          }
        }
      }
    }
    return n;
  }
  /** Greenhouse top height at z. */
  ghTop(z) {
    const T = this.T;
    const H = T.roofY - T.beltY;
    if (z >= T.zRoofFront) {
      const t = clamp((T.zWindBase - z) / (T.zWindBase - T.zRoofFront), 0, 1);
      return T.beltY + H * Math.pow(Math.sin(t * Math.PI / 2), 0.8);
    }
    if (z <= T.zRoofRear) {
      const t = clamp((z - T.zRearBase) / (T.zRoofRear - T.zRearBase), 0, 1);
      return T.beltY + H * Math.pow(Math.sin(t * Math.PI / 2), 0.75);
    }
    const t = (z - T.zRoofRear) / (T.zRoofFront - T.zRoofRear);
    return T.roofY + 0.018 * Math.sin(Math.PI * t);
  }
  /** Greenhouse half section, 10 points (bottom side -> top center). */
  ghSection(z, out) {
    const T = this.T;
    const yTop = this.ghTop(z);
    const wb = this.w(z) * 0.94 - 0.04;
    const H = Math.max(0.0001, yTop - T.beltY);
    const fullH = T.roofY - T.beltY;
    const wt = wb - T.tumble * (H / fullH);
    const r = Math.min(0.08, H * 0.4);
    let n = 0;
    const put = (x, y) => { const p = out[n] || (out[n] = { x: 0, y: 0 }); p.x = x; p.y = y; n++; };
    put(wb, T.beltY);
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      put(lerp(wb, wt, t), T.beltY + (H - r) * t);
    }
    for (let k = 1; k <= 3; k++) {
      const a = (k / 3) * (Math.PI / 2);
      put(wt - r + r * Math.cos(a), yTop - r + r * Math.sin(a));
    }
    put(wt * 0.5, yTop + 0.02 * (H / fullH));
    put(0, yTop + 0.025 * (H / fullH));
    return n;
  }
  /** z of the body surface at the front (dir=1) or back (dir=-1) for a given x,y. */
  surfaceZ(x, y, dir) {
    const out = [];
    const L = this.L;
    for (let z = L * dir; Math.abs(z) > 0.3; z -= 0.01 * dir) {
      const n = this.section(z, out);
      // check if (x,y) inside the polygon (half)
      const ax = Math.abs(x);
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = out[i], b = out[j];
        if ((a.y > y) !== (b.y > y) && ax < ((b.x - a.x) * (y - a.y)) / (b.y - a.y + 1e-9) + a.x) inside = !inside;
      }
      // the half polygon is closed by the x=0 axis implicitly
      if (inside || (ax < out[0].x)) return z;
    }
    return 0.3 * dir;
  }
}

/* ------------------------------------------------------------------------- builder */
const DARK = new THREE.Color(0.06, 0.06, 0.065);
const WHITE = new THREE.Color(1, 1, 1);

export function buildCarModel(typeName, color, opts = {}) {
  const T = CAR_TYPES[typeName];
  const P = new Profile(T);
  const M = shared();
  const rng = makeRng(opts.seed || Math.floor(Math.random() * 1e9));
  const root = new THREE.Group();
  root.name = 'car_' + typeName;
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), metalness: 0.55, roughness: 0.3, clearcoat: 1.0, clearcoatRoughness: 0.05,
    vertexColors: true, envMapIntensity: 1.2, side: THREE.DoubleSide,
  });
  const lights = makeLightMats();

  /* ------------------------------ lower body loft */
  const zs = [];
  const NS = 64;
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    // denser at ends
    const u = 0.5 - 0.5 * Math.cos(Math.PI * t);
    zs.push(-P.L + (2 * P.L) * lerp(t, u, 0.55));
  }
  for (const z of [T.zDoorFront, T.zDoorRear]) zs.push(z);
  // dense slices around the wheel arches for a smooth arch outline
  for (const zw of P.wheelZ) {
    for (let z = zw - P.ra - 0.06; z <= zw + P.ra + 0.06; z += 0.025) zs.push(z);
  }
  zs.sort((a, b) => a - b);
  // dedupe
  const Z = zs.filter((z, i) => i === 0 || z - zs[i - 1] > 0.004);
  const HALF = 20;
  const LOOP = HALF * 2 - 2;
  const sec = [];
  const pos = [];
  const tags = [];
  for (let i = 0; i < Z.length; i++) {
    P.section(Z[i], sec);
    for (let j = 0; j < HALF; j++) { pos.push(sec[j].x, sec[j].y, Z[i]); tags.push(sec[j].tag); }
    for (let j = HALF - 2; j >= 1; j--) { pos.push(-sec[j].x, sec[j].y, Z[i]); tags.push(sec[j].tag); }
  }
  const vid = (i, j) => i * LOOP + ((j % LOOP) + LOOP) % LOOP;
  // map loop index -> half index & side
  const halfIndex = (j) => (j < HALF ? j : LOOP - j);
  const sideOf = (j) => (j === 0 || j === HALF - 1 ? 0 : j < HALF ? 1 : -1);
  const iDF = Z.findIndex((z) => Math.abs(z - T.zDoorFront) < 0.003);
  const iDR = Z.findIndex((z) => Math.abs(z - T.zDoorRear) < 0.003);
  const DOOR_J0 = 8, DOOR_J1 = 16;
  const bodyIdx = [], doorIdx = { 1: [], '-1': [] };
  for (let i = 0; i < Z.length - 1; i++) {
    for (let j = 0; j < LOOP; j++) {
      const a = vid(i, j), b = vid(i, j + 1), c = vid(i + 1, j + 1), d = vid(i + 1, j);
      const h0 = halfIndex(j), h1 = halfIndex((j + 1) % LOOP);
      const side = sideOf(j) || sideOf((j + 1) % LOOP);
      const inDoorZ = i >= iDR && i < iDF;
      const inDoorJ = Math.min(h0, h1) >= DOOR_J0 && Math.max(h0, h1) <= DOOR_J1;
      if (inDoorZ && inDoorJ && side !== 0) {
        doorIdx[side].push([i, j]);
      } else {
        bodyIdx.push(a, b, c, a, c, d);
      }
    }
  }
  // end caps (fans) – mostly degenerate thanks to squeezing but close any gap
  const capFront = [], capRear = [];
  const last = Z.length - 1;
  for (let j = 1; j < LOOP - 1; j++) {
    capRear.push(vid(0, 0), vid(0, j + 1), vid(0, j));
    capFront.push(vid(last, 0), vid(last, j), vid(last, j + 1));
  }
  bodyIdx.push(...capRear, ...capFront);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const colArr = new Float32Array(pos.length);
  for (let v = 0; v < tags.length; v++) {
    const t = tags[v];
    const y = pos[v * 3 + 1];
    const dark = t === 'under' || (t === 'side' && y < T.bottomY + 0.1 && Math.abs(pos[v * 3]) > P.W * 0.6 && false);
    const c = dark ? DARK : WHITE;
    colArr[v * 3] = c.r; colArr[v * 3 + 1] = c.g; colArr[v * 3 + 2] = c.b;
  }
  // inner wheel-well surfaces (lifted underside points) are dark; the outer lip keeps the paint
  for (let i = 0; i < Z.length; i++) {
    for (const zw of P.wheelZ) {
      if (Math.abs(Z[i] - zw) < P.ra) {
        for (let j = 0; j < LOOP; j++) {
          const v = vid(i, j);
          const hi = halfIndex(j);
          if (hi >= 3 && hi <= 5) { colArr[v * 3] = DARK.r; colArr[v * 3 + 1] = DARK.g; colArr[v * 3 + 2] = DARK.b; }
        }
      }
    }
  }
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  bodyGeo.setIndex(bodyIdx);
  bodyGeo.computeVertexNormals();

  /* ------------------------------ greenhouse loft */
  const GZ = [];
  const NG = 36;
  for (let i = 0; i <= NG; i++) GZ.push(lerp(T.zRearBase, T.zWindBase, i / NG));
  for (const z of [T.zB[0], T.zB[1], T.zC, T.zRoofFront, T.zRoofRear]) if (z > T.zRearBase && z < T.zWindBase) GZ.push(z);
  GZ.sort((a, b) => a - b);
  const GZu = GZ.filter((z, i) => i === 0 || z - GZ[i - 1] > 0.004);
  const GH = 10, GL = GH * 2 - 1;
  const gpos = [];
  const gsec = [];
  for (const z of GZu) {
    P.ghSection(z, gsec);
    for (let j = 0; j < GH; j++) gpos.push(gsec[j].x, gsec[j].y, z);
    for (let j = GH - 2; j >= 0; j--) gpos.push(-gsec[j].x, gsec[j].y, z);
  }
  const gvid = (i, j) => i * GL + j;
  const ghPaint = [], ghLiner = [];
  const glassTris = { wind: [], rear: [], sideL: [], sideR: [], doorL: [], doorR: [] };
  for (let i = 0; i < GZu.length - 1; i++) {
    const zc = (GZu[i] + GZu[i + 1]) / 2;
    for (let j = 0; j < GL - 1; j++) {
      const a = gvid(i, j), b = gvid(i, j + 1), c = gvid(i + 1, j + 1), d = gvid(i + 1, j);
      const hj = j < GH - 1 ? j : GL - 2 - j; // half index of the lower vertex of the quad
      const side = j < GH - 1 ? 1 : -1;
      const sideWall = hj <= 3; // quads between points 0..4
      let cls = 'paint';
      if (sideWall) {
        if (zc > T.zB[1] && zc < T.zDoorFront + 0.2) cls = side > 0 ? 'doorL' : 'doorR';
        else if (zc < T.zB[0] && zc > T.zC) cls = side > 0 ? 'sideL' : 'sideR';
        else if (zc >= T.zDoorFront + 0.2) cls = side > 0 ? 'doorL' : 'doorR';
        else cls = 'paint';
        // A-pillar strip: the front-most side quads near the windshield edge
        if (zc > T.zRoofFront && hj === 3) cls = 'paint';
        if (zc > T.zWindBase - 0.12) cls = 'paint';
      } else if (hj >= 6 || (hj >= 4 && hj <= 5 && zc > T.zRoofRear && zc < T.zRoofFront)) {
        // roof / windshield / rear window
        if (zc > T.zRoofFront + 0.02 && hj >= 6) cls = 'wind';
        else if (zc < T.zRoofRear - 0.02 && hj >= 6) cls = 'rear';
        else cls = 'paint';
      } else {
        cls = 'paint'; // pillars and roof rails
      }
      const tri = [a, b, c, a, c, d];
      if (cls === 'paint') ghPaint.push(...tri);
      else glassTris[cls].push(...tri);
    }
  }
  const ghGeo = new THREE.BufferGeometry();
  ghGeo.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3));
  ghGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(gpos.length).fill(1), 3));
  ghGeo.setIndex(ghPaint);
  ghGeo.computeVertexNormals();

  // body (lower + greenhouse paint) with an interior liner as a second material group
  const outer = mergeGeometries([bodyGeo.toNonIndexed(), ghGeo.toNonIndexed()], false);
  // roof liner: an inset copy of the greenhouse panels with interior trim colour
  const liner = ghGeo.toNonIndexed();
  {
    const p = liner.attributes.position, n = liner.attributes.normal;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) - n.getX(i) * 0.022, p.getY(i) - n.getY(i) * 0.022, p.getZ(i) - n.getZ(i) * 0.022);
    const arr = p.array, narr = n.array;
    for (let t = 0; t < p.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const tmp = arr[(t + 1) * 3 + k]; arr[(t + 1) * 3 + k] = arr[(t + 2) * 3 + k]; arr[(t + 2) * 3 + k] = tmp;
        const tn = narr[(t + 1) * 3 + k]; narr[(t + 1) * 3 + k] = narr[(t + 2) * 3 + k]; narr[(t + 2) * 3 + k] = tn;
      }
    }
    for (let i = 0; i < narr.length; i++) narr[i] = -narr[i];
    const c = liner.attributes.color;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, 0.55, 0.53, 0.5);
  }
  const bodyAll = mergeGeometries([outer, liner], true);
  const bodyMesh = new THREE.Mesh(bodyAll, [paint, M.interior]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  /* ------------------------------ glass */
  const glassMeshes = {};
  const makeGlass = (name, idx, parent, offset) => {
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3));
    g.setIndex(idx);
    const gg = g.toNonIndexed();
    gg.computeVertexNormals();
    if (offset) gg.translate(-offset.x, -offset.y, -offset.z);
    const m = new THREE.Mesh(gg, M.glass);
    m.renderOrder = 3;
    m.castShadow = false;
    parent.add(m);
    glassMeshes[name] = m;
    return m;
  };
  makeGlass('body', [...glassTris.wind, ...glassTris.rear, ...glassTris.sideL, ...glassTris.sideR], root);

  /* ------------------------------ doors */
  const doors = [];
  for (const side of [1, -1]) {
    const quads = doorIdx[side];
    if (!quads.length) continue;
    const hingeZ = T.zDoorFront;
    const hingeSec = [];
    P.section(hingeZ, hingeSec);
    const hingeX = side * (P.w(hingeZ) * 1.0);
    const hingeY = 0.6;
    const hinge = new THREE.Vector3(hingeX, hingeY, hingeZ);
    const group = new THREE.Group();
    group.position.copy(hinge);
    root.add(group);
    const dpos = [], dcol = [], ipos = [];
    const pv = (v) => [pos[v * 3] - hinge.x, pos[v * 3 + 1] - hinge.y, pos[v * 3 + 2] - hinge.z];
    const inset = (p) => [p[0] - side * 0.075, p[1], p[2]];
    for (const [i, j] of quads) {
      const a = pv(vid(i, j)), b = pv(vid(i, j + 1)), c = pv(vid(i + 1, j + 1)), d = pv(vid(i + 1, j));
      dpos.push(...a, ...b, ...c, ...a, ...c, ...d);
      // inner card (reverse winding)
      const ai = inset(a), bi = inset(b), ci = inset(c), di = inset(d);
      ipos.push(...ai, ...ci, ...bi, ...ai, ...di, ...ci);
    }
    // edge strips around the door boundary
    const edge = [];
    const boundary = new Map();
    const key = (i, j) => `${i},${j}`;
    for (const [i, j] of quads) boundary.set(key(i, j), true);
    const has = (i, j) => boundary.has(key(i, j));
    for (const [i, j] of quads) {
      const corners = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]];
      const nb = [[i, j - 1], [i + 1, j], [i, j + 1], [i - 1, j]]; // neighbours across each edge
      // edges: (0-1) shares with quad (i-1,j)... compute per edge
      const edges = [[0, 1, i - 1, j], [1, 2, i, j + 1], [2, 3, i + 1, j], [3, 0, i, j - 1]];
      void nb;
      for (const [e0, e1, ni, nj] of edges) {
        if (has(ni, nj)) continue;
        const p0 = pv(vid(corners[e0][0], corners[e0][1])), p1 = pv(vid(corners[e1][0], corners[e1][1]));
        const q0 = inset(p0), q1 = inset(p1);
        edge.push(...p0, ...q0, ...q1, ...p0, ...q1, ...p1);
      }
    }
    const skin = new THREE.BufferGeometry();
    skin.setAttribute('position', new THREE.Float32BufferAttribute(dpos, 3));
    skin.computeVertexNormals();
    skin.setAttribute('color', new THREE.BufferAttribute(new Float32Array(dpos.length).fill(1), 3));
    const skinMesh = new THREE.Mesh(skin, paint);
    skinMesh.castShadow = true;
    skinMesh.receiveShadow = true;
    group.add(skinMesh);
    const card = new THREE.BufferGeometry();
    const cardPos = [...ipos, ...edge];
    card.setAttribute('position', new THREE.Float32BufferAttribute(cardPos, 3));
    card.computeVertexNormals();
    const cc = new Float32Array(cardPos.length);
    for (let k = 0; k < cc.length; k += 3) { cc[k] = 0.42; cc[k + 1] = 0.4; cc[k + 2] = 0.38; }
    card.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    const cardMesh = new THREE.Mesh(card, M.interior);
    cardMesh.castShadow = true;
    group.add(cardMesh);
    // armrest + handle inside
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.45), M.trim);
    arm.position.set(-side * 0.11, T.beltY - 0.28 - hingeY, (T.zDoorRear + T.zDoorFront) / 2 - hingeZ - 0.05);
    group.add(arm);
    // window glass of the door
    const glass = makeGlass(side > 0 ? 'doorL' : 'doorR', glassTris[side > 0 ? 'doorL' : 'doorR'], group, hinge);
    // exterior handle
    const hz = T.zDoorRear + 0.16;
    const hy = T.beltY - 0.1;
    const hx = side * (P.w(hz) * 1.012);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.17), M.chrome);
    handle.position.set(hx - hinge.x, hy - hinge.y, hz - hinge.z);
    group.add(handle);
    // mirror on the door
    const mz = T.zDoorFront - 0.1, my = T.beltY + 0.07;
    const mGroup = new THREE.Group();
    mGroup.position.set(side * (P.w(mz) * 0.96) - hinge.x, my - hinge.y, mz - hinge.z);
    const housing = new THREE.Mesh(roundedBoxGeo(0.2, 0.12, 0.09), paint);
    housing.position.set(side * 0.13, 0.02, 0);
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.04), M.trim);
    stalk.position.set(side * 0.04, 0, 0);
    const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.09), M.mirror);
    mirror.position.set(side * 0.13, 0.02, -0.047);
    mirror.rotation.y = Math.PI;
    mGroup.add(housing, stalk, mirror);
    housing.castShadow = true;
    group.add(mGroup);
    doors.push({
      side, group, hinge: hinge.clone(), skin: skinMesh, card: cardMesh, glass,
      handleLocal: new THREE.Vector3(hx, hy, hz), // car local, closed state
      innerHandleLocal: new THREE.Vector3(side * (P.w(hz) - 0.14), T.beltY - 0.22, hz + 0.25),
      length: T.zDoorFront - T.zDoorRear,
      maxOpen: 1.15,
      open: 0, vel: 0, latched: true, scripted: false,
    });
  }

  /* ------------------------------ interior */
  const [sx, sy, sz] = T.seat;
  const interior = new THREE.Group();
  root.add(interior);
  const ibox = (w, h, d, x, y, z, mat = M.seat, rx = 0) => {
    const m = new THREE.Mesh(roundedBoxGeo(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    interior.add(m);
    return m;
  };
  const floorY = T.bottomY + 0.06;
  ibox(P.W * 2 - 0.2, 0.04, T.zDoorFront - T.zRearBase + 0.2, 0, floorY, (T.zDoorFront + T.zRearBase) / 2 + 0.05, M.trim);
  for (const s of [1, -1]) {
    ibox(0.5, 0.12, 0.52, s * sx, sy - 0.06, sz + 0.2);
    ibox(0.5, 0.64, 0.13, s * sx, sy + 0.28, sz - 0.12, M.seat, -0.2);
    ibox(0.26, 0.17, 0.1, s * sx, sy + 0.7, sz - 0.22, M.seat, -0.15);
    // seat base
    ibox(0.4, sy - floorY - 0.1, 0.4, s * sx, (sy + floorY) / 2 - 0.08, sz + 0.2, M.trim);
  }
  if (T.zDoorRear - T.zRearBase > 0.9) {
    const rz = sz - 0.9;
    ibox(P.W * 2 - 0.4, 0.13, 0.5, 0, sy - 0.04, rz + 0.15);
    ibox(P.W * 2 - 0.4, 0.6, 0.13, 0, sy + 0.27, rz - 0.13, M.seat, -0.22);
  }
  // dashboard
  const dashZ = T.zWindBase - 0.32;
  ibox(P.W * 2 - 0.22, 0.26, 0.5, 0, T.beltY - 0.12, dashZ, M.trim);
  ibox(0.42, 0.08, 0.16, sx, T.beltY + 0.0, dashZ - 0.18, M.trim); // cluster hood
  ibox(0.24, 0.3, 0.75, 0, floorY + 0.15, sz + 0.45, M.trim); // console
  const gear = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), M.chrome);
  gear.position.set(0, floorY + 0.38, sz + 0.5);
  interior.add(gear);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), M.trim);
  knob.position.set(0, floorY + 0.46, sz + 0.5);
  interior.add(knob);
  // steering wheel
  const wheelCenter = new THREE.Vector3(sx, sy + 0.37, sz + 0.47);
  const tilt = 0.42; // radians, top of wheel towards the driver
  const steerFrame = new THREE.Group();
  steerFrame.position.copy(wheelCenter);
  steerFrame.rotation.x = -tilt;
  interior.add(steerFrame);
  const steeringWheel = new THREE.Group();
  steerFrame.add(steeringWheel);
  const rimR = 0.185;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.017, 8, 32), M.trim);
  steeringWheel.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.05, 16).rotateX(Math.PI / 2), M.trim);
  hub.position.z = 0.02;
  steeringWheel.add(hub);
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(rimR, 0.03, 0.015), M.trim);
    sp.position.set(Math.cos(a) * rimR / 2, Math.sin(a) * rimR / 2, 0.01);
    sp.rotation.z = a;
    steeringWheel.add(sp);
  }
  const logo = new THREE.Mesh(new THREE.CircleGeometry(0.02, 12), M.chrome);
  logo.position.z = -0.006;
  logo.rotation.y = Math.PI;
  steeringWheel.add(logo);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.32, 8).rotateX(Math.PI / 2), M.trim);
  column.position.set(0, 0, 0.17);
  steerFrame.add(column);
  // pedals
  const pedals = {
    throttle: new THREE.Vector3(sx - 0.12, floorY + 0.12, sz + 0.98),
    brake: new THREE.Vector3(sx + 0.03, floorY + 0.14, sz + 0.94),
    rest: new THREE.Vector3(sx + 0.22, floorY + 0.1, sz + 0.88),
  };
  for (const k of ['throttle', 'brake']) {
    const pd = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.02), M.chrome);
    pd.position.copy(pedals[k]);
    pd.rotation.x = -0.6;
    interior.add(pd);
  }

  /* ------------------------------ lights, grille, plates, details */
  const details = new THREE.Group();
  root.add(details);
  const lamps = new THREE.Group();
  root.add(lamps);
  const surf = (x, y, dir) => P.surfaceZ(x, y, dir);
  const hlY = T.noseY - 0.12;
  const hlX = P.W * 0.64;
  const headLights = [];
  for (const s of [1, -1]) {
    const z = surf(s * hlX, hlY, 1);
    const hl = new THREE.Mesh(roundedBoxGeo(0.3, 0.1, 0.12), lights.head);
    hl.position.set(s * hlX, hlY, z - 0.04);
    hl.rotation.y = s * 0.28;
    lamps.add(hl);
    const bezel = new THREE.Mesh(roundedBoxGeo(0.32, 0.12, 0.1), M.chrome);
    bezel.position.set(s * hlX, hlY, z - 0.055);
    bezel.rotation.y = s * 0.28;
    details.add(bezel);
    headLights.push(hl);
    // fog light
    const fz = surf(s * (P.W - 0.32), T.bottomY + 0.2, 1);
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12).rotateX(Math.PI / 2), lights.head);
    fl.position.set(s * (P.W - 0.32), T.bottomY + 0.2, fz - 0.005);
    lamps.add(fl);
  }
  // grille
  {
    const gy = hlY - 0.02, gz = surf(0, gy, 1);
    const grille = new THREE.Mesh(roundedBoxGeo(P.W * 0.8, 0.14, 0.08), M.grille);
    grille.position.set(0, gy, gz - 0.025);
    details.add(grille);
    for (let k = 0; k < 4; k++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(P.W * 0.76, 0.008, 0.02), M.chrome);
      bar.position.set(0, gy - 0.05 + k * 0.033, gz + 0.012);
      details.add(bar);
    }
    const ly = T.bottomY + 0.14, lz = surf(0, ly, 1);
    const lower = new THREE.Mesh(roundedBoxGeo(P.W * 1.05, 0.1, 0.06), M.grille);
    lower.position.set(0, ly, lz - 0.02);
    details.add(lower);
  }
  // tail lights
  const tailLights = [];
  const tlY = T.tailY - 0.13;
  for (const s of [1, -1]) {
    const x = P.W * 0.66;
    const z = surf(s * x, tlY, -1);
    const tl = new THREE.Mesh(roundedBoxGeo(0.32, 0.1, 0.08), lights.tail);
    tl.position.set(s * x, tlY, z + 0.025);
    tl.rotation.y = -s * 0.25;
    lamps.add(tl);
    tailLights.push(tl);
    const rv = new THREE.Mesh(roundedBoxGeo(0.1, 0.06, 0.06), lights.reverse);
    rv.position.set(s * (x - 0.26), tlY, surf(s * (x - 0.26), tlY, -1) + 0.018);
    lamps.add(rv);
  }
  {
    const z = surf(0, tlY, -1);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(P.W * 0.7, 0.025, 0.03), lights.tail);
    strip.position.set(0, tlY, z + 0.005);
    lamps.add(strip);
  }
  // plates
  const plateText = `${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}${rng.int(100, 999)}`;
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(plateText), roughness: 0.5 });
  for (const dir of [1, -1]) {
    const y = dir > 0 ? T.bottomY + 0.24 : T.tailY - 0.33;
    const z = surf(0, y, dir);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.12), plateMat);
    pl.position.set(0, y, z + dir * 0.012);
    if (dir < 0) pl.rotation.y = Math.PI;
    details.add(pl);
  }
  // exhaust
  for (const s of T.typeTwinExhaust || [1, -1]) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.2, 10).rotateX(Math.PI / 2), M.chrome);
    ex.position.set(s * 0.45, T.bottomY + 0.08, -P.L + 0.12);
    details.add(ex);
  }
  // wipers
  for (const s of [1, -1]) {
    const wp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.02), M.trim);
    wp.position.set(s * 0.25, T.beltY + 0.03, T.zWindBase - 0.05);
    wp.rotation.z = s * 0.15;
    wp.rotation.x = -0.6;
    details.add(wp);
  }
  // door seams on the body (rear door / fender lines)
  const seamMat = M.trim;
  const seamAt = (z) => {
    for (const s of [1, -1]) {
      const sec2 = [];
      P.section(z, sec2);
      const y0 = sec2[8].y, y1 = sec2[15].y;
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.006, y1 - y0, 0.008), seamMat);
      seam.position.set(s * (P.w(z) * 1.012 + 0.002), (y0 + y1) / 2, z);
      details.add(seam);
    }
  };
  if (T.rearDoorSeam) seamAt(T.rearDoorSeam);
  // spoiler / roof extras
  if (T.spoiler) {
    const wing = new THREE.Mesh(roundedBoxGeo(P.W * 2 - 0.2, 0.03, 0.26), paint);
    wing.position.set(0, T.tailY + 0.2, -P.L + 0.22);
    wing.rotation.x = 0.08;
    details.add(wing);
    for (const s of [1, -1]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.12), M.trim);
      st.position.set(s * 0.6, T.tailY + 0.09, -P.L + 0.25);
      details.add(st);
    }
  }
  if (T.roofRails) {
    for (const s of [1, -1]) {
      const rr = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, T.zRoofFront - T.zRoofRear - 0.2), M.chrome);
      rr.position.set(s * (P.w(0) * 0.94 - 0.04 - T.tumble - 0.04), T.roofY + 0.06, (T.zRoofFront + T.zRoofRear) / 2);
      details.add(rr);
    }
  }
  if (T.hoodScoop) {
    const sc = new THREE.Mesh(roundedBoxGeo(0.6, 0.1, 0.7), paint);
    sc.position.set(0, P.yt(T.zWindBase + 0.6) + 0.03, T.zWindBase + 0.6);
    details.add(sc);
    const scf = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.02), M.grille);
    scf.position.set(0, P.yt(T.zWindBase + 0.6) + 0.04, T.zWindBase + 0.96);
    details.add(scf);
  }
  if (T.taxi) {
    const sign = new THREE.Mesh(roundedBoxGeo(0.62, 0.2, 0.26), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2a0, emissiveIntensity: 0.4 }));
    sign.position.set(0, T.roofY + 0.13, (T.zRoofFront + T.zRoofRear) / 2);
    details.add(sign);
    const checker = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 1.4), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    for (const s of [1, -1]) {
      const c2 = checker.clone();
      c2.position.set(s * (P.W * 1.01), T.beltY - 0.25, -0.1);
      details.add(c2);
    }
  }
  let siren = null;
  if (T.police) {
    siren = new THREE.Group();
    const base = new THREE.Mesh(roundedBoxGeo(1.1, 0.08, 0.26), M.trim);
    siren.add(base);
    const r = new THREE.Mesh(roundedBoxGeo(0.48, 0.1, 0.22), lights.sirenR);
    r.position.set(0.28, 0.07, 0);
    const b = new THREE.Mesh(roundedBoxGeo(0.48, 0.1, 0.22), lights.sirenB);
    b.position.set(-0.28, 0.07, 0);
    siren.add(r, b);
    siren.position.set(0, T.roofY + 0.06, (T.zRoofFront + T.zRoofRear) / 2);
    lamps.add(siren);
  }
  // antenna
  if (!T.taxi && !T.police && T.zRoofRear > -1.5) {
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, 0.45, 4), M.trim);
    ant.position.set(0, T.roofY + 0.24, T.zRoofRear + 0.15);
    ant.rotation.x = -0.35;
    details.add(ant);
  }
  mergeByMaterial(details);
  mergeByMaterial(interior, [steerFrame]);
  for (const g of [details, interior, lamps]) g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });

  /* ------------------------------ wheels */
  const wheels = [];
  const wheelGeo = getWheelGeometry(T.wheelR, T.wheelW);
  const wx = T.track / 2;
  for (const [x, z, front] of [[wx, P.wheelZ[0], true], [-wx, P.wheelZ[0], true], [wx, P.wheelZ[1], false], [-wx, P.wheelZ[1], false]]) {
    const mount = new THREE.Group();
    mount.position.set(x, T.wheelR, z);
    root.add(mount);
    const flip = new THREE.Group();
    if (x < 0) flip.rotation.y = Math.PI;
    mount.add(flip);
    const spin = new THREE.Group();
    flip.add(spin);
    const tire = new THREE.Mesh(wheelGeo.tire, M.rubber);
    const rimM = new THREE.Mesh(wheelGeo.rim, T.label === 'Sport' || T.label === 'Muscle' ? M.rimDark : M.rim);
    tire.castShadow = true; rimM.castShadow = false;
    spin.add(tire, rimM);
    const caliper = new THREE.Mesh(wheelGeo.caliper, M.caliper);
    caliper.castShadow = false;
    caliper.position.set(0, T.wheelR * 0.38, front ? -0.06 : 0.06);
    flip.add(caliper);
    wheels.push({ mount, spin, flip, x, z, front, side: x > 0 ? 1 : -1 });
  }

  // collect deformable meshes (body + door skins)
  const deformables = [bodyMesh, ...doors.map((d) => d.skin), ...doors.map((d) => d.card)];
  for (const m of deformables) m.userData.orig = Float32Array.from(m.geometry.attributes.position.array);

  return {
    T, root, profile: P, paint, lights, glassMeshes, doors, wheels, steeringWheel, steerFrame, wheelCenter, rimR, tilt,
    pedals, seat: new THREE.Vector3(sx, sy, sz), headLights, tailLights, siren, deformables, interior, details, lamps,
    halfW: P.W, halfL: P.L, plate: plateText, plateMat,
  };
}

/** Bakes all static meshes of a group into one mesh per material (fewer draw calls). */
function mergeByMaterial(group, exclude = []) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const remove = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    for (const ex of exclude) { let p = o; while (p) { if (p === ex) return; p = p.parent; } }
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(m);
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push(g);
    remove.push(o);
  });
  for (const o of remove) o.parent.remove(o);
  for (const [mat, list] of buckets) {
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    group.add(mesh);
  }
}

function roundedBoxGeo(w, h, d) {
  const g = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const s = v.clone().normalize().multiplyScalar(0.5);
    v.lerp(s, 0.35);
    p.setXYZ(i, v.x * w, v.y * h, v.z * d);
  }
  g.computeVertexNormals();
  return g;
}

const wheelCache = new Map();
function getWheelGeometry(R, W) {
  const key = `${R}_${W}`;
  if (wheelCache.has(key)) return wheelCache.get(key);
  // tire profile in (radius, x) -> lathe around the X axis
  const rimR = R * 0.64;
  const hw = W / 2;
  const prof = [];
  const push = (r, x) => prof.push(new THREE.Vector2(r, x));
  push(rimR * 0.98, -hw * 0.9);
  push(rimR * 1.02, -hw * 0.96);
  push(R * 0.82, -hw);
  push(R * 0.95, -hw * 0.94);
  push(R, -hw * 0.75);
  push(R, hw * 0.75);
  push(R * 0.95, hw * 0.94);
  push(R * 0.82, hw);
  push(rimR * 1.02, hw * 0.96);
  push(rimR * 0.98, hw * 0.9);
  const tire = new THREE.LatheGeometry(prof, 36);
  // lathe is around Y; rotate so the axle is X
  tire.rotateZ(Math.PI / 2);
  const uv = tire.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 8, uv.getY(i));
  // rim: barrel + face + spokes + hub
  const parts = [];
  const barrel = new THREE.CylinderGeometry(rimR, rimR, W * 0.85, 28, 1, true).rotateZ(Math.PI / 2);
  parts.push(barrel);
  const lip = new THREE.TorusGeometry(rimR * 0.98, 0.012, 6, 32).rotateY(Math.PI / 2).translate(hw * 0.9, 0, 0);
  parts.push(lip);
  const face = new THREE.RingGeometry(rimR * 0.82, rimR * 0.97, 28).rotateY(Math.PI / 2).translate(hw * 0.78, 0, 0);
  parts.push(face);
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.03, rimR * 0.78, 0.05);
    sp.translate(0, rimR * 0.45, 0);
    sp.rotateX(a);
    sp.translate(hw * 0.74, 0, 0);
    parts.push(sp);
  }
  const hub = new THREE.CylinderGeometry(rimR * 0.22, rimR * 0.26, 0.06, 16).rotateZ(Math.PI / 2).translate(hw * 0.75, 0, 0);
  parts.push(hub);
  const rim = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g; }), false);
  const disc = new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.025, 24).rotateZ(Math.PI / 2).translate(hw * 0.2, 0, 0);
  const caliper = new THREE.BoxGeometry(0.06, 0.1, 0.14).translate(hw * 0.32, 0, 0);
  const res = { tire, rim, disc, caliper };
  for (const g of Object.values(res)) g.userData.shared = true;
  wheelCache.set(key, res);
  return res;
}

export { shared as sharedCarMaterials };
