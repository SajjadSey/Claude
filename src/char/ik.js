import * as THREE from 'three';
import { clamp, quatFromBasis } from '../core/util.js';

const _A = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _k = new THREE.Vector3();
const _K = new THREE.Vector3();
const _T = new THREE.Vector3();
const _low = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _qp = new THREE.Quaternion();
const _qu = new THREE.Quaternion();
const _ql = new THREE.Quaternion();
const _qtmp = new THREE.Quaternion();

/** World quaternion whose local -Y points along `dir` and local +Z towards `pole` (times sign). */
export function boneWorldQuat(dir, pole, sign, out) {
  _y.copy(dir).multiplyScalar(-1);
  _z.copy(pole).addScaledVector(_y, -pole.dot(_y));
  if (_z.lengthSq() < 1e-8) {
    _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0);
  }
  _z.normalize().multiplyScalar(sign);
  _x.crossVectors(_y, _z).normalize();
  return quatFromBasis(_x, _y, _z, out);
}

/** Converts a desired world rotation into the bone's local quaternion. */
export function setWorldQuat(bone, worldQ, parentWorldQ = null) {
  if (!parentWorldQ) {
    bone.parent.getWorldQuaternion(_qp);
    parentWorldQ = _qp;
  }
  bone.quaternion.copy(parentWorldQ).invert().multiply(worldQ);
}

/**
 * Analytic two bone IK.
 * upper/lower: bones whose child offset points along local -Y.
 * target: world position for the end of `lower`.
 * pole: world direction the middle joint should point to.
 * sign: +1 if the bone's local +Z should face the pole (legs), -1 otherwise (arms).
 * weight: 0..1 blend with the current (FK) pose.
 * Returns the lower bone's world quaternion (useful to orient the end effector).
 */
export function solveTwoBone(upper, lower, target, pole, sign, L1, L2, weight = 1, outLowerQ = new THREE.Quaternion()) {
  upper.parent.updateWorldMatrix(true, false);
  upper.parent.getWorldQuaternion(_qp);
  upper.getWorldPosition(_A);
  _d.subVectors(target, _A);
  const dist = _d.length();
  const maxR = (L1 + L2) * 0.9995;
  const minR = Math.abs(L1 - L2) + 1e-3;
  const dc = clamp(dist, minR, maxR);
  _n.copy(_d).multiplyScalar(1 / Math.max(dist, 1e-6));
  if (dist < 1e-6) _n.set(0, -1, 0);
  const cosA = (L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc);
  const angA = Math.acos(clamp(cosA, -1, 1));
  _p.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_p.lengthSq() < 1e-8) {
    _p.set(0, 0, 1).addScaledVector(_n, -_n.z);
    if (_p.lengthSq() < 1e-8) _p.set(1, 0, 0);
  }
  _p.normalize();
  _k.copy(_n).multiplyScalar(Math.cos(angA)).addScaledVector(_p, Math.sin(angA));
  _K.copy(_A).addScaledVector(_k, L1);
  _T.copy(_A).addScaledVector(_n, dc);
  _low.subVectors(_T, _K).normalize();

  boneWorldQuat(_k, _p, sign, _qu);
  boneWorldQuat(_low, _p, sign, _ql);

  if (weight >= 0.999) {
    upper.quaternion.copy(_qp).invert().multiply(_qu);
    lower.quaternion.copy(_qu).invert().multiply(_ql);
    outLowerQ.copy(_ql);
  } else {
    // blend with existing local rotations
    _qtmp.copy(_qp).invert().multiply(_qu);
    upper.quaternion.slerp(_qtmp, weight);
    // recompute world of upper after blend
    const upperW = _qtmp.copy(_qp).multiply(upper.quaternion);
    const lowLocal = new THREE.Quaternion().copy(_qu).invert().multiply(_ql);
    lower.quaternion.slerp(lowLocal, weight);
    outLowerQ.copy(upperW).multiply(lower.quaternion);
  }
  return outLowerQ;
}
