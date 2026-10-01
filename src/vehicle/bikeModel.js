import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { plateTexture } from '../world/textures.js';

/*
 * Procedural motorcycles. Bike-local frame: +z forward, +y up, +x = left side, ground at y = 0.
 *
 * The model is split into rigid sub-assemblies that move independently:
 *  - frame       (bike body: frame, engine, tank, fairing / fenders, seat, exhaust, tail)
 *  - steerPivot  (at the steering head, tilted by the rake) -> steer (turns with the bars)
 *                -> slider (fork lowers, moves along the fork with the suspension) -> front wheel
 *  - swing       (swingarm, pivots with the rear suspension) -> rear wheel
 * Every assembly is merged by material, so a whole bike costs only a handful of draw calls.
 */
export const BIKE_TYPES = {
  sportbike: {
    label: 'Sport bike', bike: true, kind: 'sport',
    wheelbase: 1.42, rF: 0.305, rR: 0.315, twF: 0.12, twR: 0.18, rake: 0.42, head: [0, 0.98, 0.41],
    pivot: [0, 0.42, -0.2], travelF: 0.12, travelR: 0.12, springHzF: 2.0, springHzR: 2.1, damping: 0.42,
    seat: [0, 0.84, -0.14], pegs: [0.17, 0.37, -0.3], grips: [0.31, 0.06, 0.03], riderLean: 0.72,
    mass: 205, torque: 112, redline: 12800, gears: [2.6, 1.95, 1.6, 1.38, 1.24, 1.13], primary: 1.7, finalDrive: 2.8,
    brake: 4200, grip: 1.32, dragCA: 0.42, maxLean: 0.95, firing: 2, engineTone: 'scream',
    beltY: 0.95, noseY: 0.92, length: 2.05, width: 0.74, steerMax: 0.62,
    colors: ['#e10600', '#0a58ca', '#f5c400', '#101010', '#f2f2f2', '#22c55e', '#ff6b00', '#7c3aed'],
  },
  cruiser: {
    label: 'Cruiser', bike: true, kind: 'cruiser',
    wheelbase: 1.62, rF: 0.33, rR: 0.33, twF: 0.13, twR: 0.2, rake: 0.56, head: [0, 1.0, 0.48],
    pivot: [0, 0.4, -0.28], travelF: 0.12, travelR: 0.09, springHzF: 1.7, springHzR: 1.8, damping: 0.4,
    seat: [0, 0.7, -0.24], pegs: [0.25, 0.36, 0.4], grips: [0.38, 0.22, -0.12], riderLean: -0.04,
    mass: 285, torque: 150, redline: 6200, gears: [2.7, 1.9, 1.45, 1.18, 1.0], primary: 1.6, finalDrive: 2.4,
    brake: 3900, grip: 1.2, dragCA: 0.62, maxLean: 0.72, firing: 1, engineTone: 'rumble',
    beltY: 0.9, noseY: 0.95, length: 2.3, width: 0.95, steerMax: 0.6,
    colors: ['#0b0b0b', '#7f1d1d', '#1e3a8a', '#e5e7eb', '#14532d', '#78350f', '#6b21a8'],
  },
};

/* ------------------------------------------------------------------ materials (shared) */
let SH = null;
function shared() {
  if (SH) return SH;
  const S = (o) => new THREE.MeshStandardMaterial(o);
  SH = {
    chrome: S({ color: 0xe6e8ea, metalness: 1, roughness: 0.12 }),
    alu: S({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.33 }),
    dark: S({ color: 0x1b1c20, metalness: 0.45, roughness: 0.5 }),
    plastic: S({ color: 0x0e0f11, metalness: 0.1, roughness: 0.6 }),
    rubber: S({ color: 0x121212, metalness: 0, roughness: 0.93 }),
    leather: S({ color: 0x1c1a19, metalness: 0, roughness: 0.78 }),
    gold: S({ color: 0xc9a227, metalness: 1, roughness: 0.25 }),
    disc: S({ color: 0x9a9da2, metalness: 0.95, roughness: 0.28 }),
    red: S({ color: 0xb91c1c, metalness: 0.3, roughness: 0.4 }),
    engine: S({ color: 0x2b2d31, metalness: 0.75, roughness: 0.38 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x1f2b38, metalness: 0.3, roughness: 0.05, transparent: true, opacity: 0.42, depthWrite: false }),
    mirror: S({ color: 0xc8d4dc, metalness: 1, roughness: 0.04 }),
  };
  for (const m of Object.values(SH)) m.userData.shared = true;
  return SH;
}

/* ------------------------------------------------------------------ geometry helpers */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

/** Collects geometries per material and merges them into one mesh per material. */
class Bucket {
  constructor() { this.map = new Map(); }
  add(geo, mat) {
    const g = geo.index ? geo : geo;
    if (!this.map.has(mat)) this.map.set(mat, []);
    this.map.get(mat).push(g);
    return g;
  }
  build(parent, { shadow = true } = {}) {
    for (const [mat, list] of this.map) {
      // normalise attributes to position/normal/uv; mix of indexed and extruded (non-indexed) shapes
      const anyFlat = list.some((g) => !g.index);
      const norm = list.map((g) => {
        let c = anyFlat && g.index ? g.toNonIndexed() : g;
        for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') c.deleteAttribute(k);
        if (c.groups) c.clearGroups();
        return c;
      });
      const merged = mergeGeometries(norm, false);
      for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadow && !mat.transparent;
      mesh.receiveShadow = false;
      parent.add(mesh);
    }
    this.map.clear();
  }
}

/** Cylinder between two points (local coordinates). */
function rod(p0, p1, r0, r1 = r0, seg = 10) {
  _a.set(...p0); _b.set(...p1);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
  _m.compose(_a.clone().add(_b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(_m);
}
function tubeCurve(pts, r, seg = 24, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, seg, r, radial, false);
}
function ellip(rx, ry, rz, p, seg = 18, rot = null) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(8, seg >> 1));
  g.scale(rx, ry, rz);
  if (rot) g.rotateX(rot[0]).rotateY(rot[1] || 0).rotateZ(rot[2] || 0);
  return g.translate(...p);
}
function box(w, h, l, p, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  return g.translate(...p);
}
/** Side-profile shape (bike z, y) extruded across the bike, from x0 to x0 + depth, with rounded edges. */
function profile(pts, x0, depth, bevel = 0.015) {
  const sh = new THREE.Shape();
  const v = pts.map(([z, y]) => new THREE.Vector2(z, y));
  sh.moveTo(v[0].x, v[0].y);
  sh.splineThru(v.slice(1).concat([v[0]]));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 28 });
  // shape (x, y) = bike (z, y); extrusion along shape z -> bike -x
  g.rotateY(-Math.PI / 2);
  g.translate(x0 + depth, 0, 0);
  g.computeVertexNormals();
  return g;
}

/** Narrow a geometry towards one end: x scaled from 1 at z = z0 to k at z = z1. */
function taper(g, z0, z1, k) {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getZ(i) - z0) / (z1 - z0));
    pos.setX(i, pos.getX(i) * (1 + (k - 1) * t * t));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function cylX(r, w, p, seg = 20, open = false) {
  return new THREE.CylinderGeometry(r, r, w, seg, 1, open).rotateZ(Math.PI / 2).translate(...p);
}

/* ------------------------------------------------------------------ wheels */
function buildWheel(T, front, M, paint) {
  const R = front ? T.rF : T.rR, tw = front ? T.twF : T.twR;
  const spin = new THREE.Group();
  const B = new Bucket();
  // tyre: round crown torus, slightly squarer sidewall via a second inner torus
  B.add(new THREE.TorusGeometry(R - tw / 2, tw / 2, 12, 40).rotateY(Math.PI / 2), M.rubber);
  const rimR = R - tw * 0.72;
  B.add(cylX(rimR, tw * 0.82, [0, 0, 0], 32, true), T.kind === 'sport' ? M.dark : M.chrome);
  B.add(new THREE.TorusGeometry(rimR, 0.008, 6, 32).rotateY(Math.PI / 2).translate(tw * 0.4, 0, 0), M.alu);
  B.add(new THREE.TorusGeometry(rimR, 0.008, 6, 32).rotateY(Math.PI / 2).translate(-tw * 0.4, 0, 0), M.alu);
  B.add(cylX(0.045, tw * 0.9, [0, 0, 0], 14), M.alu); // hub
  if (T.kind === 'sport') {
    // five split spokes
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      for (const off of [-0.09, 0.09]) {
        const aa = a + off;
        B.add(rod([0, Math.sin(a) * 0.04, Math.cos(a) * 0.04], [0, Math.sin(aa) * (rimR - 0.01), Math.cos(aa) * (rimR - 0.01)], 0.011, 0.008, 6), M.dark);
      }
    }
  } else {
    // wire spokes, laced from both hub flanges
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2, side = i % 2 ? 1 : -1;
      const a2 = a + side * 0.35;
      B.add(rod([side * 0.04, Math.sin(a) * 0.05, Math.cos(a) * 0.05], [0, Math.sin(a2) * (rimR - 0.006), Math.cos(a2) * (rimR - 0.006)], 0.0022, 0.0022, 4), M.chrome);
    }
  }
  // brake discs
  const discR = front ? (T.kind === 'sport' ? 0.155 : 0.15) : 0.11;
  const discs = front ? (T.kind === 'sport' ? [0.075, -0.075] : [0.07]) : [-0.07];
  for (const dx of discs) {
    B.add(cylX(discR, 0.006, [dx, 0, 0], 32), M.disc);
    B.add(cylX(discR * 0.55, 0.008, [dx, 0, 0], 16), M.alu);
  }
  B.build(spin);
  // calipers stay put (do not spin)
  const fixed = new THREE.Group();
  const C = new Bucket();
  for (const dx of discs) C.add(box(0.035, 0.07, 0.09, [dx + Math.sign(dx || 1) * 0.01, front ? 0.11 : -0.1, front ? -0.08 : -0.06], front ? 0.5 : -0.4), front && T.kind === 'sport' ? M.gold : M.red);
  C.build(fixed);
  const g = new THREE.Group();
  g.add(spin, fixed);
  void paint;
  return { group: g, spin };
}

/* ------------------------------------------------------------------ main builder */
export function buildBikeModel(typeName, color, opts = {}) {
  const T = BIKE_TYPES[typeName];
  const M = shared();
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const paint2 = new THREE.MeshPhysicalMaterial({ color: T.kind === 'sport' ? 0x15161a : color, metalness: 0.4, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
  const lights = {
    head: new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xeaf2ff, emissiveIntensity: 0.3, roughness: 0.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1a1a, emissiveIntensity: 0.4, roughness: 0.3 }),
    ind: new THREE.MeshStandardMaterial({ color: 0x664400, emissive: 0xff9a1a, emissiveIntensity: 0.0, roughness: 0.3 }),
  };
  const root = new THREE.Group();
  const frame = new THREE.Group();
  root.add(frame);
  const F = new Bucket();
  const [hx, hy, hz] = T.head;
  const [px, py, pz] = T.pivot;
  const halfWB = T.wheelbase / 2;
  void px;

  if (T.kind === 'sport') {
    // twin-spar aluminium frame from the steering head to the swingarm pivot
    for (const s of [1, -1]) {
      F.add(tubeCurve([[s * 0.04, hy, hz], [s * 0.13, hy - 0.04, hz - 0.18], [s * 0.15, hy - 0.16, hz - 0.42], [s * 0.13, py + 0.08, pz + 0.02], [s * 0.11, py - 0.02, pz]], 0.03, 24, 8), M.alu);
      F.add(rod([s * 0.13, py + 0.06, pz + 0.02], [s * 0.08, 0.8, -0.5], 0.012), M.alu); // subframe
    }
    F.add(rod([0, hy - 0.06, hz + 0.02], [0, hy + 0.08, hz - 0.04], 0.035), M.alu); // steering head
    // engine: crankcase, cylinder block tilted forward, head, covers
    F.add(box(0.27, 0.22, 0.36, [0, 0.42, 0.04]), M.engine);
    F.add(box(0.3, 0.2, 0.2, [0, 0.62, 0.12], -0.45), M.engine);
    F.add(box(0.31, 0.08, 0.2, [0, 0.74, 0.19], -0.45), M.dark);
    F.add(cylX(0.1, 0.06, [0.16, 0.42, 0.0], 20), M.alu);
    F.add(cylX(0.07, 0.05, [-0.155, 0.4, 0.1], 18), M.alu);
    // radiator
    F.add(box(0.36, 0.26, 0.05, [0, 0.66, 0.36], -0.2), M.plastic);
    // exhaust: headers sweep under the engine to an angled muffler on the right
    for (const s of [-0.09, -0.03, 0.03, 0.09]) F.add(tubeCurve([[s, 0.66, 0.3], [s * 0.8, 0.42, 0.36], [s * 0.4, 0.22, 0.12], [-0.06, 0.24, -0.2]], 0.017, 16, 6), M.chrome);
    F.add(tubeCurve([[-0.06, 0.24, -0.2], [-0.15, 0.32, -0.38], [-0.18, 0.44, -0.55]], 0.04, 10, 10), M.alu);
    F.add(rod([-0.18, 0.44, -0.55], [-0.2, 0.56, -0.78], 0.062, 0.05, 16), M.dark);
    F.add(cylX(0.045, 0.02, [-0.2, 0.565, -0.79], 14).rotateX(0), M.chrome);
    // fuel tank
    F.add(taper(profile([[0.36, 0.86], [0.3, 1.0], [0.12, 1.05], [-0.06, 0.98], [-0.08, 0.86]], -0.15, 0.3, 0.05), 0.12, -0.1, 0.62), paint);
    F.add(box(0.06, 0.02, 0.1, [0, 1.085, 0.14]), M.alu); // filler cap
    // seat and pointed tail
    F.add(profile([[0.0, 0.84], [-0.08, 0.89], [-0.3, 0.88], [-0.36, 0.83], [-0.1, 0.8]], -0.12, 0.24, 0.03), M.leather);
    F.add(taper(profile([[-0.28, 0.8], [-0.36, 0.9], [-0.6, 0.95], [-0.86, 1.02], [-0.88, 0.95], [-0.62, 0.8], [-0.36, 0.74]], -0.1, 0.2, 0.025), -0.35, -0.9, 0.35), paint);
    F.add(profile([[-0.42, 0.93], [-0.6, 0.97], [-0.8, 1.02], [-0.6, 0.94]], -0.04, 0.08, 0.012), paint2); // pillion cowl
    F.add(box(0.13, 0.04, 0.12, [0, 0.86, -0.77]), M.plastic); // tail tidy
    // fairing: pointed nose, sculpted side panels with an accent stripe, belly pan, screen
    F.add(ellip(0.15, 0.13, 0.24, [0, 0.98, 0.6], 22), paint);
    const side = [[0.76, 0.99], [0.68, 0.78], [0.6, 0.56], [0.44, 0.38], [0.2, 0.32], [0.04, 0.4], [0.02, 0.56], [0.12, 0.72], [0.3, 0.86], [0.5, 0.96], [0.64, 1.04]];
    for (const s of [1, -1]) {
      F.add(profile(side, s > 0 ? 0.125 : -0.165, 0.04, 0.016), paint);
      F.add(profile([[0.62, 0.74], [0.46, 0.58], [0.2, 0.5], [0.1, 0.56], [0.3, 0.64], [0.5, 0.72]], s > 0 ? 0.172 : -0.18, 0.008, 0.004), paint2);
    }
    F.add(profile([[0.42, 0.38], [0.3, 0.24], [0.0, 0.24], [-0.08, 0.34]], -0.13, 0.26, 0.03), paint2); // belly pan
    F.add(ellip(0.15, 0.1, 0.17, [0, 1.12, 0.5], 18, [-0.65, 0, 0]), M.screen);
    // mirrors on stalks
    for (const s of [1, -1]) {
      F.add(rod([s * 0.17, 1.03, 0.58], [s * 0.27, 1.07, 0.6], 0.008), M.plastic);
      F.add(ellip(0.05, 0.03, 0.02, [s * 0.29, 1.07, 0.6], 10), M.plastic);
    }
    // footpegs and rearsets
    for (const s of [1, -1]) {
      F.add(cylX(0.012, 0.09, [s * (T.pegs[0] + 0.02), T.pegs[1], T.pegs[2]], 8), M.alu);
      F.add(box(0.012, 0.12, 0.05, [s * 0.13, T.pegs[1] + 0.05, T.pegs[2] + 0.02], 0.3), M.alu);
    }
  } else {
    // cruiser: tubular cradle frame, V-twin, teardrop tank, chrome everywhere
    for (const s of [1, -1]) {
      F.add(tubeCurve([[s * 0.03, hy, hz], [s * 0.1, 0.75, 0.32], [s * 0.12, 0.28, 0.25], [s * 0.12, 0.2, -0.05], [s * 0.11, py, pz]], 0.022, 24, 8), M.dark);
      F.add(tubeCurve([[s * 0.03, hy - 0.02, hz - 0.02], [s * 0.07, 0.86, 0.0], [s * 0.1, 0.72, -0.4], [s * 0.1, 0.62, -0.7]], 0.02, 20, 8), M.dark);
    }
    F.add(rod([0, hy - 0.08, hz + 0.03], [0, hy + 0.08, hz - 0.04], 0.034), M.dark);
    // V-twin: crankcase + two finned cylinders at 45 degrees each side of vertical
    F.add(box(0.24, 0.2, 0.34, [0, 0.36, 0.02]), M.alu);
    // front cylinder leans forward, rear cylinder leans back (45 degree vee)
    for (const [ang, z0] of [[0.5, 0.1], [-0.5, -0.06]]) {
      const y0 = 0.46, dy = Math.cos(ang), dz = Math.sin(ang);
      for (let i = 0; i < 7; i++) {
        const t = 0.03 + (i / 6) * 0.2;
        const g = new THREE.CylinderGeometry(0.085, 0.085, 0.012, 18).rotateX(ang).translate(0, y0 + t * dy, z0 + t * dz);
        F.add(g, i === 6 ? M.chrome : M.engine);
      }
      F.add(rod([0, y0, z0], [0, y0 + 0.24 * dy, z0 + 0.24 * dz], 0.06), M.engine);
    }
    F.add(ellip(0.1, 0.1, 0.07, [-0.12, 0.6, 0.02], 14), M.chrome); // air cleaner
    // twin shotgun pipes on the right
    F.add(tubeCurve([[-0.06, 0.66, 0.2], [-0.14, 0.4, 0.28], [-0.17, 0.3, 0.0], [-0.18, 0.32, -0.5], [-0.18, 0.36, -0.95]], 0.034, 24, 10), M.chrome);
    F.add(tubeCurve([[-0.06, 0.6, -0.15], [-0.14, 0.44, -0.1], [-0.16, 0.42, -0.4], [-0.16, 0.45, -0.9]], 0.03, 20, 10), M.chrome);
    // teardrop tank with chrome console
    F.add(ellip(0.17, 0.12, 0.3, [0, 0.88, 0.14], 22), paint);
    F.add(box(0.05, 0.02, 0.26, [0, 1.0, 0.12]), M.chrome);
    // stepped seat, rear fender with the tail lamp
    F.add(ellip(0.17, 0.06, 0.24, [0, 0.72, -0.22], 16), M.leather);
    F.add(ellip(0.13, 0.06, 0.13, [0, 0.79, -0.44], 14), M.leather);
    F.add(tubeCurve([[0, 0.66, -0.35], [0, 0.66, -0.62], [0, 0.56, -0.9], [0, 0.4, -1.04]], 0.11, 18, 14).scale(1, 1, 1), paint);
    // floorboards and forward controls
    for (const s of [1, -1]) {
      F.add(box(0.11, 0.02, 0.24, [s * 0.27, T.pegs[1] - 0.03, T.pegs[2]]), M.chrome);
      F.add(rod([s * 0.12, 0.3, 0.1], [s * 0.25, T.pegs[1], T.pegs[2]], 0.012), M.chrome);
    }
    // saddle bags
    for (const s of [1, -1]) F.add(box(0.12, 0.26, 0.4, [s * 0.24, 0.6, -0.6]), M.leather);
  }
  // rear light and plate
  const tailZ = T.kind === 'sport' ? -0.84 : -0.98;
  const tailY = T.kind === 'sport' ? 0.88 : 0.5;
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(opts.plate || 'NC ' + (100 + (opts.seed || 1) % 900)), roughness: 0.5 });
  F.build(frame);
  const tail = new THREE.Mesh(box(0.14, 0.045, 0.03, [0, tailY, tailZ]), lights.tail);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.09).rotateY(Math.PI).translate(0, tailY - 0.13, tailZ - 0.03), plateMat);
  frame.add(tail, plate);
  // indicators
  const ind = new Bucket();
  for (const s of [1, -1]) {
    ind.add(ellip(0.018, 0.018, 0.03, [s * 0.11, tailY + 0.01, tailZ + 0.01], 8), lights.ind);
    ind.add(ellip(0.018, 0.018, 0.03, [s * (T.kind === 'sport' ? 0.16 : 0.18), T.kind === 'sport' ? 0.92 : 0.95, T.kind === 'sport' ? 0.66 : 0.6], 8), lights.ind);
  }
  ind.build(frame, { shadow: false });

  /* ------------------------------ steering assembly */
  const steerPivot = new THREE.Group();
  steerPivot.position.set(hx, hy, hz);
  steerPivot.rotation.x = -T.rake;
  root.add(steerPivot);
  const steer = new THREE.Group();
  steerPivot.add(steer);
  // fork length head -> front axle (static)
  const axleF = new THREE.Vector3(0, T.rF, halfWB);
  const forkLen = new THREE.Vector3(hx, hy, hz).distanceTo(axleF);
  const S = new Bucket();
  const fx = T.kind === 'sport' ? 0.095 : 0.11;
  // top yoke, bars, grips
  S.add(box(fx * 2 + 0.07, 0.03, 0.08, [0, 0.07, 0]), T.kind === 'sport' ? M.alu : M.chrome);
  S.add(box(fx * 2 + 0.07, 0.03, 0.07, [0, -0.12, 0]), T.kind === 'sport' ? M.alu : M.chrome);
  const [gx, gy, gz] = T.grips;
  if (T.kind === 'sport') {
    for (const s of [1, -1]) {
      S.add(rod([s * fx, 0.04, 0], [s * gx, gy, gz], 0.012), M.alu); // clip-ons
      S.add(rod([s * (gx - 0.02), gy, gz], [s * (gx + 0.09), gy - 0.005, gz + 0.005], 0.017, 0.017, 10), M.rubber);
      S.add(rod([s * (gx - 0.04), gy + 0.01, gz + 0.04], [s * (gx + 0.11), gy + 0.0, gz + 0.06], 0.006), M.alu); // levers
    }
    S.add(box(0.2, 0.09, 0.05, [0, 0.13, 0.04], -0.5), M.plastic); // dash
    // twin headlights live in the fairing (frame); add them there
  } else {
    // pull-back bars on risers, round headlight, front fender
    for (const s of [1, -1]) {
      S.add(rod([s * 0.03, 0.08, 0], [s * 0.04, 0.16, -0.02], 0.014), M.chrome);
      S.add(tubeCurve([[s * 0.04, 0.16, -0.02], [s * 0.22, 0.2, 0.02], [s * 0.34, gy, gz + 0.04], [s * gx, gy, gz]], 0.012, 14, 8), M.chrome);
      S.add(rod([s * (gx - 0.02), gy, gz], [s * (gx + 0.11), gy, gz - 0.01], 0.018, 0.018, 10), M.rubber);
      S.add(rod([s * 0.3, gy + 0.02, gz + 0.03], [s * 0.36, gy + 0.18, gz + 0.03], 0.006), M.chrome);
      S.add(ellip(0.035, 0.05, 0.012, [s * 0.36, gy + 0.21, gz + 0.03], 10), M.mirror);
    }
    S.add(cylX(0.012, 0.3, [0, -0.06, 0.1], 8), M.chrome);
  }
  // fork stanchions (fixed part, in the steer group)
  const upperLen = forkLen * 0.55;
  for (const s of [1, -1]) S.add(rod([s * fx, 0.1, 0], [s * fx, -upperLen, 0], T.kind === 'sport' ? 0.026 : 0.022, T.kind === 'sport' ? 0.026 : 0.022, 12), T.kind === 'sport' ? M.gold : M.chrome);
  S.build(steer);
  // fork sliders + front wheel move together along the fork
  const slider = new THREE.Group();
  steer.add(slider);
  const L = new Bucket();
  for (const s of [1, -1]) {
    L.add(rod([s * fx, -upperLen + 0.12, 0], [s * fx, -forkLen + 0.02, 0], T.kind === 'sport' ? 0.033 : 0.03, T.kind === 'sport' ? 0.03 : 0.028, 12), T.kind === 'sport' ? M.dark : M.alu);
  }
  L.add(cylX(0.015, fx * 2 + 0.06, [0, -forkLen, 0], 10), M.alu); // axle
  // front fender
  if (T.kind === 'sport') L.add(ellip(0.07, 0.035, 0.24, [0, -forkLen + T.rF + 0.05, 0.03], 14, [-0.2 + T.rake, 0, 0]), paint);
  else L.add(new THREE.TorusGeometry(T.rF + 0.05, 0.075, 8, 18, Math.PI * 0.62).rotateY(Math.PI / 2).rotateX(Math.PI * 0.12 + T.rake).scale(1, 1, 1).translate(0, -forkLen, 0), paint);
  L.build(slider);
  const front = buildWheel(T, true, M, paint);
  front.group.position.set(0, -forkLen, 0);
  // the wheel stays perpendicular to the ground plane of the bike: undo the rake tilt for its axle frame
  front.group.rotation.x = T.rake;
  slider.add(front.group);
  // headlights
  const hl = new Bucket();
  if (T.kind === 'sport') {
    for (const s of [1, -1]) hl.add(ellip(0.05, 0.03, 0.02, [s * 0.065, 0.95, 0.79], 12, [0.2, s * 0.25, 0]), lights.head);
    hl.build(frame, { shadow: false });
  } else {
    S.add(rod([0, 0.0, 0.12], [0, 0.0, 0.2], 0.105, 0.11, 22), M.chrome);
    S.build(steer);
    const lamp = new THREE.Mesh(cylX(0.095, 0.01, [0, 0, 0], 22).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0.0, 0.205), lights.head);
    // the lamp lives in the steer group and turns with the bars
    steer.add(lamp);
  }
  // grip markers (for hand IK)
  const grips = {};
  for (const [k, s] of [['L', 1], ['R', -1]]) {
    const o = new THREE.Object3D();
    o.position.set(s * (gx + 0.035), gy, gz);
    steer.add(o);
    grips[k] = o;
  }

  /* ------------------------------ rear: swingarm + wheel */
  const swing = new THREE.Group();
  swing.position.set(0, py, pz);
  root.add(swing);
  const axleR = new THREE.Vector3(0, T.rR, -halfWB);
  const armLen = Math.hypot(axleR.y - py, axleR.z - pz);
  // swingarm built pointing along -z from the pivot; the group is rotated to reach the axle
  const SW = new Bucket();
  const sx = T.kind === 'sport' ? 0.1 : 0.12;
  for (const s of [1, -1]) {
    SW.add(box(0.035, T.kind === 'sport' ? 0.07 : 0.035, armLen, [s * sx, 0, -armLen / 2]), T.kind === 'sport' ? M.alu : M.chrome);
  }
  SW.add(box(sx * 2, 0.05, 0.06, [0, 0, -0.06]), T.kind === 'sport' ? M.alu : M.chrome);
  SW.add(cylX(0.016, sx * 2 + 0.06, [0, 0, -armLen], 10), M.alu);
  // chain (left side)
  SW.add(box(0.012, 0.012, armLen, [0.085, 0.07, -armLen / 2 + 0.02]), M.dark);
  SW.add(box(0.012, 0.012, armLen, [0.085, -0.05, -armLen / 2 + 0.02]), M.dark);
  SW.add(cylX(0.09, 0.008, [0.085, 0, -armLen], 22), M.dark); // sprocket
  if (T.kind === 'sport') {
    // rear shock
    SW.add(rod([0, 0.04, -0.1], [0, 0.36, 0.0], 0.03), M.gold);
  } else {
    for (const s of [1, -1]) SW.add(rod([s * (sx + 0.03), 0.0, -armLen + 0.06], [s * 0.11, 0.38, -armLen + 0.2], 0.022), M.chrome);
  }
  SW.build(swing);
  const rear = buildWheel(T, false, M, paint);
  rear.group.position.set(0, 0, -armLen);
  swing.add(rear.group);
  const swingRest = Math.atan2(axleR.y - py, -(axleR.z - pz)); // angle of the arm below horizontal (pointing back)

  /* ------------------------------ kickstand (left side) */
  const kick = new THREE.Group();
  kick.position.set(0.12, 0.3, -0.06);
  const kickMesh = new THREE.Mesh(rod([0, 0, 0], [0, -0.3, 0.02], 0.011), M.dark);
  kick.add(kickMesh);
  root.add(kick);

  return {
    T, root, frame, steerPivot, steer, slider, swing, kick, paint, paint2, lights, plateMat,
    frontWheel: front, rearWheel: rear, grips, forkLen, armLen, swingRest,
    halfW: T.width / 2, halfL: T.length / 2,
    seat: new THREE.Vector3(...T.seat),
    plate: opts.plate || 'NC',
    glassMeshes: {}, doors: [],
  };
}
