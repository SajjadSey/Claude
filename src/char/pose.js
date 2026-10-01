import * as THREE from 'three';
import { DEG } from '../core/util.js';

/** Snapshot of all bone local rotations + hips position (rig-local units). */
export class Pose {
  constructor(n) {
    this.q = new Float32Array(n * 4);
    this.p = new Float32Array(3);
    this.n = n;
  }
  capture(rig) {
    const L = rig.list;
    for (let i = 0; i < L.length; i++) {
      const q = L[i].quaternion;
      this.q[i * 4] = q.x; this.q[i * 4 + 1] = q.y; this.q[i * 4 + 2] = q.z; this.q[i * 4 + 3] = q.w;
    }
    const hp = rig.bones.hips.position;
    this.p[0] = hp.x; this.p[1] = hp.y; this.p[2] = hp.z;
    return this;
  }
  apply(rig) {
    const L = rig.list;
    for (let i = 0; i < L.length; i++) L[i].quaternion.set(this.q[i * 4], this.q[i * 4 + 1], this.q[i * 4 + 2], this.q[i * 4 + 3]);
    rig.bones.hips.position.set(this.p[0], this.p[1], this.p[2]);
  }
  copy(o) { this.q.set(o.q); this.p.set(o.p); return this; }
}

const _qa = new THREE.Quaternion();

/**
 * Blends the rig's current pose (as "to") with `from` using weight w (0 = from, 1 = current).
 * Optional per-bone weight function wf(boneName, w) to stagger limbs.
 */
export function blendFrom(rig, from, w, wf = null) {
  if (w >= 1) return;
  const L = rig.list;
  for (let i = 0; i < L.length; i++) {
    const bw = wf ? wf(L[i].name, w) : w;
    if (bw >= 1) continue;
    _qa.set(from.q[i * 4], from.q[i * 4 + 1], from.q[i * 4 + 2], from.q[i * 4 + 3]);
    // current = slerp(from, current, bw)
    _qa.slerp(L[i].quaternion, Math.max(0, bw));
    L[i].quaternion.copy(_qa);
  }
  const hp = rig.bones.hips.position;
  const wh = wf ? wf('hipsPos', w) : w;
  hp.set(
    from.p[0] + (hp.x - from.p[0]) * wh,
    from.p[1] + (hp.y - from.p[1]) * wh,
    from.p[2] + (hp.z - from.p[2]) * wh,
  );
}

/**
 * Keyframe pose definitions: Euler angles in degrees (XYZ) for local bone rotations and
 * the hips position in rig units. Unlisted bones are identity.
 */
const _e = new THREE.Euler();
export function applyPoseDef(rig, def, out = null) {
  rig.resetPose();
  for (const [name, v] of Object.entries(def)) {
    if (name === 'hipsPos') {
      rig.bones.hips.position.set(v[0], v[1], v[2]);
      continue;
    }
    const b = rig.bones[name];
    if (!b) continue;
    _e.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, v[3] || 'XYZ');
    b.quaternion.setFromEuler(_e);
  }
  if (out) out.capture(rig);
}

/** Mirror helper: build both sides from one spec. */
function sym(spec) {
  const o = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k.endsWith('_')) {
      const base = k.slice(0, -1);
      o[base + 'L'] = v;
      o[base + 'R'] = [v[0], -v[1], -v[2]];
    } else o[k] = v;
  }
  return o;
}

export const POSES = {
  stand: sym({ hipsPos: [0, 0.98, 0], upperArm_: [0, 0, 7], forearm_: [-12, 0, 0], fingers_: [0, 0, -20] }),
  lieBack: sym({
    hipsPos: [0, 0.13, 0], hips: [-90, 0, 0], spine: [-4, 0, 0], chest: [-3, 0, 0], neck: [8, 0, 0], head: [6, 0, 0],
    upperArm_: [0, 0, 18], forearm_: [-15, 0, 0], thigh_: [-6, 0, 3], shin_: [10, 0, 0], foot_: [-15, 0, 0], fingers_: [0, 0, -30],
  }),
  sitUp: sym({
    hipsPos: [0, 0.14, -0.02], hips: [-28, 0, 0], spine: [22, 0, 0], chest: [18, 0, 0], neck: [6, 0, 0], head: [2, 0, 0],
    upperArm_: [-45, 0, 12], forearm_: [-35, 0, 0], thigh_: [-62, 0, 6], shin_: [60, 0, 0], foot_: [-8, 0, 0], fingers_: [0, 0, -40],
  }),
  crouch: sym({
    hipsPos: [0, 0.52, -0.1], hips: [12, 0, 0], spine: [22, 0, 0], chest: [12, 0, 0], neck: [-14, 0, 0], head: [-14, 0, 0],
    upperArm_: [-38, 0, 14], forearm_: [-40, 0, 0], thigh_: [-112, 0, 8], shin_: [128, 0, 0], foot_: [-28, 0, 0], fingers_: [0, 0, -40],
  }),
  lieFront: sym({
    hipsPos: [0, 0.13, 0], hips: [90, 0, 0], spine: [3, 0, 0], chest: [2, 0, 0], neck: [-25, 0, 0], head: [-10, 0, 0],
    upperArm_: [-150, 0, 20], forearm_: [-60, 0, 0], thigh_: [4, 0, 4], shin_: [10, 0, 0], foot_: [40, 0, 0], fingers_: [0, 0, -15],
  }),
  pushUp: sym({
    hipsPos: [0, 0.5, -0.12], hips: [62, 0, 0], spine: [8, 0, 0], chest: [6, 0, 0], neck: [-32, 0, 0], head: [-18, 0, 0],
    upperArm_: [-62, 0, 6], forearm_: [-6, 0, 0], thigh_: [-62, 0, 4], shin_: [92, 0, 0], foot_: [55, 0, 0], fingers_: [0, 0, 10],
  }),
  kneel: {
    hipsPos: [0, 0.52, -0.05], hips: [8, 0, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [-8, 0, 0], head: [-6, 0, 0],
    upperArmL: [-30, 0, 10], forearmL: [-40, 0, 0], upperArmR: [-20, 0, -14], forearmR: [-30, 0, 0],
    thighL: [-95, 0, 4], shinL: [95, 0, 0], footL: [-6, 0, 0],
    thighR: [-8, 0, -3], shinR: [92, 0, 0], footR: [45, 0, 0], fingersL: [0, 0, -30], fingersR: [0, 0, 30],
  },
  // pulled out of a car: stumbling, arms flailing
  stumble: sym({
    hipsPos: [0, 0.9, 0], hips: [-18, 0, 0], spine: [-10, 0, 0], chest: [-8, 0, 0], neck: [12, 0, 0], head: [8, 0, 0],
    upperArm_: [-70, 0, 45], forearm_: [-50, 0, 0], thigh_: [-35, 0, 6], shin_: [45, 0, 0], foot_: [-10, 0, 0], fingers_: [0, 0, -10],
  }),
  // getting knocked: arms up protecting the face
  brace: sym({
    hipsPos: [0, 0.94, 0], hips: [6, 0, 0], spine: [10, 0, 0], chest: [8, 0, 0], neck: [10, 0, 0],
    upperArm_: [-60, 0, 30], forearm_: [-120, 0, 0], thigh_: [-10, 0, 0], shin_: [20, 0, 0], fingers_: [0, 0, -80],
  }),
};

export const DEG2RAD = DEG;
