import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp01((v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, invLerp(a, b, v));
export const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const smoother01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
export const smoothstep = (a, b, x) => smooth01((x - a) / (b - a));
export const easeOut = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t) => clamp01(t) ** 3;
export const easeInOut = (t) => smoother01(t);
export const sign = (v) => (v < 0 ? -1 : 1);

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
export function approachAngle(a, b, maxStep) {
  const d = wrapAngle(b - a);
  return a + clamp(d, -maxStep, maxStep);
}
export function approach(a, b, maxStep) {
  return a < b ? Math.min(a + maxStep, b) : Math.max(a - maxStep, b);
}

/** Critically damped spring (value, velocity) towards a target. */
export function spring(state, target, omega, dt) {
  const x = state.x - target;
  const exp = Math.exp(-omega * dt);
  const tmp = (state.v + omega * x) * dt;
  state.v = (state.v - omega * tmp) * exp;
  state.x = target + (x + tmp) * exp;
  return state.x;
}

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  return r;
}

export const rand = makeRng(1337);

export const yawFromDir = (x, z) => Math.atan2(x, z);

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Pool of temporary vectors/quaternions to avoid per-frame allocation. */
export const tmp = {
  v: Array.from({ length: 24 }, () => new THREE.Vector3()),
  q: Array.from({ length: 12 }, () => new THREE.Quaternion()),
  m: Array.from({ length: 4 }, () => new THREE.Matrix4()),
  e: new THREE.Euler(),
};

export const UP = new THREE.Vector3(0, 1, 0);
export const FWD = new THREE.Vector3(0, 0, 1);
export const RIGHT = new THREE.Vector3(-1, 0, 0);

export function quatFromYaw(yaw, out = new THREE.Quaternion()) {
  return out.setFromAxisAngle(UP, yaw);
}

export function quatFromEulerDeg(x, y, z, out = new THREE.Quaternion(), order = 'XYZ') {
  tmp.e.set(x * DEG, y * DEG, z * DEG, order);
  return out.setFromEuler(tmp.e);
}

/** Builds a quaternion from an orthonormal basis given as three column vectors. */
const _m = new THREE.Matrix4();
export function quatFromBasis(x, y, z, out = new THREE.Quaternion()) {
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

export function bezier2(a, b, c, t, out) {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  );
}

export function bezier3(a, b, c, d, t, out) {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return out.set(
    w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x,
    w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y,
    w0 * a.z + w1 * b.z + w2 * c.z + w3 * d.z,
  );
}

/** Piecewise timeline helper: returns local 0..1 progress of t inside [a,b]. */
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
