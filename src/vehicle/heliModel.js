import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/*
 * Procedural police helicopter. Local frame: +z forward, +y up, +x = left (port) side, skids at y = 0.
 * Moving parts (main rotor, tail rotor, searchlight gimbal) are separate groups; everything else is
 * merged per material.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

export const HELI = {
  mass: 2100,
  rotorY: 3.2, rotorZ: -0.25, rotorR: 5.5,
  tailRotor: [0.16, 2.62, -6.78], tailR: 0.68,
  bodyY: 1.5, // fuselage centre height
  pilotSeat: [-0.36, 1.0, 1.15], // right front (pilots sit on the right)
  gunnerSeat: [0.5, 0.98, -0.12], // in the open left door, legs out on the skid
  gunnerFeet: [1.02, 0.12, -0.05],
  light: [0, 0.58, 1.95],
};

class Bucket {
  constructor() { this.map = new Map(); }
  add(geo, mat) {
    if (!this.map.has(mat)) this.map.set(mat, []);
    this.map.get(mat).push(geo);
    return geo;
  }
  build(parent, shadow = true) {
    for (const [mat, list] of this.map) {
      const anyFlat = list.some((g) => !g.index);
      const norm = list.map((g) => {
        const c = anyFlat && g.index ? g.toNonIndexed() : g;
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

function rod(p0, p1, r0, r1 = r0, seg = 10) {
  _a.set(...p0); _b.set(...p1);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
  _m.compose(_a.clone().add(_b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(_m);
}
function tube(pts, r, seg = 24, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, seg, r, radial, false);
}
function box(w, h, d, x, y, z) { return new THREE.BoxGeometry(w, h, d).translate(x, y, z); }
function ellip(rx, ry, rz, p, seg = 16) { return new THREE.SphereGeometry(1, seg, Math.max(8, seg >> 1)).scale(rx, ry, rz).translate(...p); }
/** Flat extruded side shape (points in z, y), centred on x with thickness t. */
function fin(pts, x, t) {
  const sh = new THREE.Shape();
  sh.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: true, bevelThickness: t * 0.3, bevelSize: t * 0.3, bevelSegments: 1, curveSegments: 4 });
  // shape x -> local z, shape y -> local y, extrude z -> local x
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g.translate(x - t / 2, 0, 0);
}

// fuselage: a body of revolution along z (radius r at z), squeezed to width KX
const BODY = [[0.0, 2.78], [0.34, 2.7], [0.6, 2.52], [0.8, 2.24], [0.93, 1.86], [1.0, 1.3], [1.01, 0.5], [1.0, 0.35],
  [0.97, -0.25], [0.89, -0.7], [0.86, -0.85], [0.66, -1.42], [0.44, -1.86]];
const KX = 0.8;
const rows = (z0, z1) => BODY.filter(([, z]) => z >= z0 - 1e-6 && z <= z1 + 1e-6);
/** A patch of the fuselage skin between azimuths phi0..phi1 (phi = 0 bottom, PI/2 left, PI top). */
function skin(prof, phi0, phi1, scale = 1, seg = 28) {
  const pts = prof.map(([r, z]) => new THREE.Vector2(Math.max(0.001, r * scale), z));
  const n = Math.max(3, Math.round(seg * (phi1 - phi0) / (Math.PI * 2)));
  const g = new THREE.LatheGeometry(pts, n, phi0, phi1 - phi0);
  // lathe axis Y -> local +z
  g.rotateX(Math.PI / 2);
  g.scale(KX, 1, 1);
  g.translate(0, HELI.bodyY, 0);
  return g;
}

let _policeTex = null;
/** 'POLICE' written along the length of the texture (v), letters standing up along u. */
function policeTexture() {
  if (_policeTex) return _policeTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 512);
  x.translate(64, 256);
  x.rotate(Math.PI / 2);
  x.font = 'bold 104px Arial, Helvetica, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineWidth = 7;
  x.strokeStyle = 'rgba(255,255,255,0.95)';
  x.strokeText('POLICE', 0, 6);
  x.fillStyle = '#13307a';
  x.fillText('POLICE', 0, 6);
  _policeTex = new THREE.CanvasTexture(c);
  _policeTex.colorSpace = THREE.SRGBColorSpace;
  _policeTex.anisotropy = 4;
  return _policeTex;
}

/** Lettering wrapped round the tapering tail boom on one side (+1 left, -1 right). */
function boomDecal(side) {
  const z0 = -2.35, z1 = -4.65, len = z0 - z1, zc = (z0 + z1) / 2;
  const rAt = (z) => (0.4 + (0.14 - 0.4) * (-1.7 - z) / 4.85) * 1.015;
  const th = 0.95;
  const g = new THREE.CylinderGeometry(rAt(z0), rAt(z1), len, 14, 1, true, (side > 0 ? Math.PI / 2 : Math.PI * 1.5) - th, th * 2);
  if (side < 0) {
    // the other side reads the other way round
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getX(i), 1 - uv.getY(i));
  }
  g.rotateX(Math.PI / 2);
  g.rotateX(0.062); // the boom rises towards the tail
  return g.translate(0, 1.78 + 0.3 * (-1.7 - zc) / 4.85, zc);
}

export function buildHeliModel() {
  const root = new THREE.Group();
  root.name = 'heli';
  const body = new THREE.Group();
  root.add(body);
  const M = {
    white: new THREE.MeshPhysicalMaterial({ color: 0xe9edf3, metalness: 0.35, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, side: THREE.DoubleSide }),
    blue: new THREE.MeshPhysicalMaterial({ color: 0x13307a, metalness: 0.4, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24272d, metalness: 0.6, roughness: 0.45 }),
    black: new THREE.MeshStandardMaterial({ color: 0x0d0e10, metalness: 0.2, roughness: 0.7 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x1b1c20, metalness: 0.1, roughness: 0.85 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa1aa, metalness: 0.85, roughness: 0.3 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x31465a, metalness: 0.2, roughness: 0.04, transparent: true, opacity: 0.36, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }),
    blade: new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.4, roughness: 0.5 }),
    disc: new THREE.MeshBasicMaterial({ color: 0x15171a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    decal: new THREE.MeshStandardMaterial({ map: policeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, metalness: 0.2, roughness: 0.4, side: THREE.FrontSide }),
    navRed: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 2.5 }),
    navGreen: new THREE.MeshStandardMaterial({ color: 0x003000, emissive: 0x1aff4a, emissiveIntensity: 2.5 }),
    strobe: new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xffffff, emissiveIntensity: 0 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2020, emissiveIntensity: 0 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xfff4dd, emissiveIntensity: 0.2, metalness: 0.5, roughness: 0.2 }),
  };
  const B = new Bucket();
  // ---- fuselage: white upper skin, blue belly band, tinted canopy over the cockpit, open door on the left
  const P = Math.PI, BELLY = 1.05, CAN = 1.32, DOOR = 2.3;
  const front = rows(0.35, 3), mid = rows(-0.7, 0.35), rear = rows(-3, -0.7);
  B.add(skin(BODY, -BELLY, BELLY, 1, 40), M.blue);
  B.add(skin(front, BELLY, P - CAN), M.white);
  B.add(skin(front, P + CAN, 2 * P - BELLY), M.white);
  B.add(skin(front, P - CAN, P + CAN, 1, 36), M.glass);
  B.add(skin(mid, DOOR, P + 0.35), M.white); // roof over the open door
  B.add(skin(mid, P + 0.35, P + 1.15), M.glass); // right cabin window
  B.add(skin(mid, P + 1.15, 2 * P - BELLY), M.white);
  B.add(skin(rear, BELLY, 2 * P - BELLY), M.white);
  // the left door is slid back along its rail
  B.add(skin(rows(-1.0, 0.0), BELLY + 0.12, DOOR - 0.05, 1.04).translate(0, 0, -0.95), M.white);
  B.add(box(0.05, 0.04, 2.3, 0.82, 2.02, -0.55), M.dark); // door rail
  B.add(box(0.06, 1.0, 0.06, 0.74, 1.45, 0.36), M.dark); // door frame posts
  B.add(box(0.06, 1.0, 0.06, 0.7, 1.45, -0.7), M.dark);
  // closed right door outline + window frame bars
  for (const s of [1, -1]) B.add(rod([s * 0.77, 0.95, 0.62], [s * 0.7, 2.2, 0.35], 0.025, 0.025, 6), M.dark);
  // cabin interior (seen through the glass)
  B.add(box(1.3, 0.06, 2.6, 0, 0.72, 0.2), M.interior);
  B.add(box(1.2, 0.32, 0.4, 0, 1.25, 1.95).rotateX(-0.3), M.black); // instrument panel
  for (const x of [-0.36, 0.36]) {
    B.add(box(0.48, 0.12, 0.5, x, 0.86, 1.1), M.interior); // front seats
    B.add(box(0.48, 0.7, 0.1, x, 1.22, 0.82).rotateX(0.12), M.interior);
  }
  B.add(box(1.3, 0.12, 0.5, 0, 0.86, -0.25), M.interior); // rear bench
  B.add(box(1.3, 0.7, 0.1, 0, 1.22, -0.55), M.interior);
  // engine & transmission cowling, intakes, exhausts
  B.add(ellip(0.52, 0.34, 1.35, [0, 2.48, -0.55], 20), M.white);
  B.add(box(0.7, 0.22, 0.9, 0, 2.58, -0.2), M.white);
  for (const s of [1, -1]) {
    B.add(ellip(0.1, 0.12, 0.22, [s * 0.42, 2.5, 0.1], 10), M.black); // intakes
    B.add(rod([s * 0.2, 2.5, -1.75], [s * 0.3, 2.42, -2.05], 0.09, 0.11, 10), M.dark); // exhausts
  }
  B.add(rod([0, 2.6, HELI.rotorZ], [0, HELI.rotorY - 0.06, HELI.rotorZ], 0.12, 0.08, 12), M.dark); // mast
  // ---- tail boom, fin, stabiliser
  B.add(rod([0, 1.78, -1.7], [0, 2.08, -6.55], 0.4, 0.14, 16), M.white);
  B.add(rod([0, 1.7, -1.75], [0, 1.98, -4.2], 0.36, 0.2, 16).scale(1, 0.92, 1), M.blue);
  B.add(fin([[-5.95, 1.98], [-6.55, 3.05], [-6.95, 3.12], [-6.85, 2.7], [-6.7, 1.92], [-6.3, 1.7]], 0, 0.07), M.blue);
  B.add(fin([[-6.7, 1.92], [-6.92, 1.5], [-7.05, 1.52], [-6.95, 1.95]], 0, 0.06), M.blue); // ventral fin
  B.add(box(1.75, 0.05, 0.38, 0, 2.02, -5.45), M.white);
  for (const s of [1, -1]) B.add(fin([[-5.25, 1.9], [-5.6, 2.3], [-5.75, 2.3], [-5.65, 1.9]], s * 0.88, 0.04), M.blue); // end plates
  B.add(rod([0, 2.62, -6.78], [0.16, 2.62, -6.78], 0.07, 0.07, 10), M.dark); // tail rotor shaft
  // ---- skids
  for (const s of [1, -1]) {
    B.add(tube([[s * 1.05, 0.08, -1.55], [s * 1.05, 0.06, 0.9], [s * 1.05, 0.1, 1.45], [s * 1.04, 0.32, 1.8]], 0.045, 24, 8), M.dark);
    for (const z of [-0.85, 0.85]) B.add(tube([[s * 1.05, 0.08, z], [s * 0.98, 0.45, z], [s * 0.62, 0.78, z]], 0.04, 10, 8), M.dark);
    B.add(box(0.28, 0.05, 0.45, s * 1.05, 0.12, -0.05), M.black); // step (gunner's footrest on the left)
  }
  // ---- searchlight mount, antennas, lights
  B.add(box(0.12, 0.2, 0.12, 0, 0.7, 1.95), M.dark);
  B.add(rod([0, 0.6, 0.3], [0, 0.32, 0.3], 0.015, 0.008, 4), M.black); // belly antenna
  B.add(rod([0.1, 2.75, -1.0], [0.1, 3.0, -1.25], 0.012, 0.012, 4), M.black);
  B.add(ellip(0.06, 0.06, 0.06, [0.88, 2.06, -5.45], 8), M.navRed); // port red
  B.add(ellip(0.06, 0.06, 0.06, [-0.88, 2.06, -5.45], 8), M.navGreen); // starboard green
  B.add(ellip(0.07, 0.05, 0.07, [0, 3.14, -6.92], 8), M.strobe);
  B.add(ellip(0.08, 0.06, 0.08, [0, 2.85, -1.1], 8), M.beacon);
  B.add(ellip(0.08, 0.06, 0.08, [0, 0.5, -0.6], 8), M.beacon);
  // ---- POLICE lettering on both sides of the boom
  for (const sd of [1, -1]) B.add(boomDecal(sd), M.decal);
  B.build(body);

  // ---- main rotor
  const rotor = new THREE.Group();
  rotor.position.set(0, HELI.rotorY, HELI.rotorZ);
  root.add(rotor);
  const RB = new Bucket();
  RB.add(new THREE.CylinderGeometry(0.22, 0.26, 0.18, 14), M.dark);
  RB.add(new THREE.CylinderGeometry(0.08, 0.12, 0.25, 8).translate(0, 0.18, 0), M.dark);
  for (let i = 0; i < 4; i++) {
    const g = box(HELI.rotorR - 0.25, 0.045, 0.3, (HELI.rotorR - 0.25) / 2 + 0.25, 0.02, 0);
    g.rotateX(0.06); // twist
    g.rotateY(i * Math.PI / 2);
    RB.add(g, M.blade);
    RB.add(box(0.5, 0.08, 0.16, 0.42, 0.02, 0).rotateY(i * Math.PI / 2), M.dark); // grips
  }
  RB.build(rotor);
  const blades = rotor.children.slice();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(HELI.rotorR, 48).rotateX(-Math.PI / 2), M.disc);
  disc.position.set(0, HELI.rotorY + 0.02, HELI.rotorZ);
  disc.renderOrder = 3;
  root.add(disc);

  // ---- tail rotor (spins about local x)
  const tail = new THREE.Group();
  tail.position.set(...HELI.tailRotor);
  root.add(tail);
  const TB = new Bucket();
  TB.add(new THREE.CylinderGeometry(0.08, 0.08, 0.08, 10).rotateZ(Math.PI / 2), M.dark);
  for (let i = 0; i < 2; i++) TB.add(box(0.03, HELI.tailR * 2, 0.12, 0.02, 0, 0).rotateX(i * Math.PI / 2 + 0.1), M.blade);
  TB.build(tail, false);
  const tailDisc = new THREE.Mesh(new THREE.CircleGeometry(HELI.tailR, 24).rotateY(Math.PI / 2), M.disc);
  tailDisc.position.set(HELI.tailRotor[0] + 0.04, HELI.tailRotor[1], HELI.tailRotor[2]);
  root.add(tailDisc);

  // ---- searchlight on a gimbal under the nose (aims along its local +z)
  const gimbal = new THREE.Group();
  gimbal.position.set(...HELI.light);
  root.add(gimbal);
  const GB = new Bucket();
  GB.add(new THREE.CylinderGeometry(0.17, 0.15, 0.36, 16).rotateX(Math.PI / 2), M.dark);
  GB.add(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 16).rotateX(Math.PI / 2).translate(0, 0, 0.18), M.lamp);
  GB.build(gimbal, false);

  return { root, body, rotor, blades, disc, tail, tailDisc, gimbal, mats: M };
}

export function disposeHeliModel(model) {
  model.root.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  for (const m of Object.values(model.mats)) m.dispose(); // (the shared lettering texture stays)
}
