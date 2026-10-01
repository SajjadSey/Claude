import * as THREE from 'three';
import { R, G, groups } from '../core/physics.js';

const DEFS = [
  { bone: 'hips', parent: null, shape: ['box', 0.15, 0.1, 0.105], off: [0, -0.02, 0], mass: 11, ccd: true },
  { bone: 'spine', parent: 'hips', shape: ['box', 0.135, 0.105, 0.09], off: [0, 0.11, 0], mass: 9 },
  { bone: 'chest', parent: 'spine', shape: ['box', 0.16, 0.125, 0.1], off: [0, 0.13, 0], mass: 14, ccd: true },
  { bone: 'neck', parent: 'chest', shape: ['ball', 0.105], off: [0, 0.2, 0.015], mass: 5.5 },
  { bone: 'upperArmL', parent: 'chest', shape: ['capsule', 0.1, 0.05], off: [0, -0.14, 0], mass: 2.3 },
  { bone: 'forearmL', parent: 'upperArmL', shape: ['capsule', 0.15, 0.042], off: [0, -0.19, 0], mass: 1.9 },
  { bone: 'upperArmR', parent: 'chest', shape: ['capsule', 0.1, 0.05], off: [0, -0.14, 0], mass: 2.3 },
  { bone: 'forearmR', parent: 'upperArmR', shape: ['capsule', 0.15, 0.042], off: [0, -0.19, 0], mass: 1.9 },
  { bone: 'thighL', parent: 'hips', shape: ['capsule', 0.16, 0.07], off: [0, -0.22, 0], mass: 8.5 },
  { bone: 'shinL', parent: 'thighL', shape: ['capsule', 0.155, 0.052], off: [0, -0.205, 0], mass: 4.6, foot: true },
  { bone: 'thighR', parent: 'hips', shape: ['capsule', 0.16, 0.07], off: [0, -0.22, 0], mass: 8.5 },
  { bone: 'shinR', parent: 'thighR', shape: ['capsule', 0.155, 0.052], off: [0, -0.205, 0], mass: 4.6, foot: true },
];

const LIMITS = {
  spine: { cone: 0.42 }, chest: { cone: 0.38 }, neck: { cone: 0.75 },
  upperArmL: { cone: 1.9 }, upperArmR: { cone: 1.9 },
  forearmL: { hinge: [-2.5, 0.05] }, forearmR: { hinge: [-2.5, 0.05] },
  thighL: { cone: 1.45 }, thighR: { cone: 1.45 },
  shinL: { hinge: [-0.05, 2.5] }, shinR: { hinge: [-0.05, 2.5] },
};

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _t = new THREE.Vector3();
const _w = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class Ragdoll {
  constructor(physics, char) {
    this.physics = physics;
    this.char = char;
    this.rig = char.rig;
    this.parts = [];
    this.byBone = {};
    this.active = false;
    this.calm = 0;
    this.time = 0;
  }

  activate(baseVel, opts = {}) {
    if (this.active) return;
    const P = this.physics, world = P.world, rig = this.rig, s = rig.scale;
    rig.root.updateMatrixWorld(true);
    this.parts = [];
    this.byBone = {};
    const filter = G.STATIC | G.CAR | G.PROP | G.DEBRIS;
    for (const d of DEFS) {
      const bone = rig.bones[d.bone];
      bone.getWorldPosition(_p);
      bone.getWorldQuaternion(_q);
      const v = baseVel;
      const spin = opts.spin || 0;
      const bodyDesc = R.RigidBodyDesc.dynamic()
        .setTranslation(_p.x, _p.y, _p.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(v.x + (Math.random() - 0.5) * spin, v.y + (Math.random() - 0.3) * spin * 0.5, v.z + (Math.random() - 0.5) * spin)
        .setLinearDamping(0.08)
        .setAngularDamping(2.0)
        .setCcdEnabled(!!d.ccd);
      const body = world.createRigidBody(bodyDesc);
      let cd;
      const sh = d.shape;
      if (sh[0] === 'box') cd = R.ColliderDesc.cuboid(sh[1] * s, sh[2] * s, sh[3] * s);
      else if (sh[0] === 'ball') cd = R.ColliderDesc.ball(sh[1] * s);
      else cd = R.ColliderDesc.capsule(sh[1] * s, sh[2] * s);
      cd.setTranslation(d.off[0] * s, d.off[1] * s, d.off[2] * s)
        .setMass(d.mass * s * s * s)
        .setFriction(0.85)
        .setRestitution(0.05)
        .setCollisionGroups(groups(G.RAGDOLL, filter))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1500);
      const col = world.createCollider(cd, body);
      P.setOwner(col, { type: 'ragdoll', char: this.char, part: d.bone, surface: 'flesh' });
      if (d.foot) {
        const fc = R.ColliderDesc.cuboid(0.045 * s, 0.035 * s, 0.11 * s)
          .setTranslation(0, -0.455 * s, 0.05 * s)
          .setMass(1.0 * s)
          .setFriction(0.9)
          .setCollisionGroups(groups(G.RAGDOLL, filter));
        const c2 = world.createCollider(fc, body);
        P.setOwner(c2, { type: 'ragdoll', char: this.char, part: d.bone, surface: 'flesh' });
      }
      const part = { def: d, bone, body, parent: null, joint: null, inertia: 0.02 };
      const len = sh[0] === 'capsule' ? (sh[1] * 2 + sh[2] * 2) * s : sh[0] === 'ball' ? sh[1] * 2 * s : sh[2] * 2 * s;
      part.inertia = Math.max(0.004, d.mass * len * len / 12 + d.mass * 0.01 * s * s);
      this.parts.push(part);
      this.byBone[d.bone] = part;
    }
    // joints
    for (const part of this.parts) {
      const d = part.def;
      if (!d.parent) continue;
      const parent = this.byBone[d.parent];
      part.parent = parent;
      // anchor of child origin in parent body frame
      const pt = parent.body.translation();
      const pr = parent.body.rotation();
      const ct = part.body.translation();
      _p.set(ct.x - pt.x, ct.y - pt.y, ct.z - pt.z);
      _q.set(pr.x, pr.y, pr.z, pr.w).invert();
      _p.applyQuaternion(_q);
      const jd = R.JointData.spherical({ x: _p.x, y: _p.y, z: _p.z }, { x: 0, y: 0, z: 0 });
      const joint = world.createImpulseJoint(jd, parent.body, part.body, true);
      joint.setContactsEnabled(false);
      part.joint = joint;
      part.limit = LIMITS[d.bone];
      // relative rest orientation: identity local rotations except intermediate bones (shoulders)
      part.rest = new THREE.Quaternion();
      if (d.bone.startsWith('upperArm')) {
        part.rest.copy(rig.bones[d.bone === 'upperArmL' ? 'shoulderL' : 'shoulderR'].quaternion);
      }
    }
    this.active = true;
    this.calm = 0;
    this.time = 0;
    this.maxSpeed = 0;
    if (opts.impulse && opts.impulseAt) this.applyImpulse(opts.impulse, opts.impulseAt);
  }

  applyImpulse(imp, at) {
    // distribute to the closest part
    let best = null, bd = 1e9;
    for (const part of this.parts) {
      const t = part.body.translation();
      const d = (t.x - at.x) ** 2 + (t.y - at.y) ** 2 + (t.z - at.z) ** 2;
      if (d < bd) { bd = d; best = part; }
    }
    if (best) best.body.applyImpulseAtPoint({ x: imp.x, y: imp.y, z: imp.z }, { x: at.x, y: at.y, z: at.z }, true);
  }

  addVelocity(v) {
    for (const part of this.parts) {
      const lv = part.body.linvel();
      part.body.setLinvel({ x: lv.x + v.x, y: lv.y + v.y, z: lv.z + v.z }, true);
    }
  }

  /**
   * Soft joint limits + joint friction, applied each physics substep at velocity level
   * (stable regardless of the limbs' tiny inertia about their long axis).
   */
  prePhysics(h) {
    if (!this.active) return;
    this.time += h;
    const friction = 0.06;
    for (const part of this.parts) {
      if (!part.parent || !part.limit) continue;
      const pb = part.parent.body, cb = part.body;
      if (pb.isSleeping() && cb.isSleeping()) continue;
      const pr = pb.rotation(), cr = cb.rotation();
      _qp.set(pr.x, pr.y, pr.z, pr.w);
      _qc.set(cr.x, cr.y, cr.z, cr.w);
      _qr.copy(_qp).invert().multiply(_qc);
      _q2.copy(part.rest).invert().multiply(_qr);
      if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
      const wc = cb.angvel(), wp = pb.angvel();
      // relative angular velocity (world)
      _w.set(wc.x - wp.x, wc.y - wp.y, wc.z - wp.z);
      // joint friction: bleed off a little relative spin
      const dw = _t.copy(_w).multiplyScalar(-friction);
      const lim = part.limit;
      const correct = (axisLocal, excess) => {
        // axisLocal: unit axis in parent frame along which the joint is over the limit (positive = further)
        _ax.copy(axisLocal).applyQuaternion(_qp);
        const along = _w.dot(_ax);
        const target = -excess * 14; // rad/s back towards the limit
        if (along > target) dw.addScaledVector(_ax, (target - along));
      };
      if (lim.cone !== undefined) {
        const ang = 2 * Math.acos(Math.min(1, _q2.w));
        if (ang > lim.cone) {
          const sh = Math.sqrt(Math.max(1e-9, 1 - _q2.w * _q2.w));
          correct(_v3.set(_q2.x / sh, _q2.y / sh, _q2.z / sh), ang - lim.cone);
        }
      } else if (lim.hinge) {
        const tw = 2 * Math.atan2(_q2.x, _q2.w);
        const ht = tw / 2;
        _q.set(Math.sin(ht), 0, 0, Math.cos(ht)).invert();
        _q.premultiply(_q2);
        if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
        const sang = 2 * Math.acos(Math.min(1, _q.w));
        if (sang > 0.08) {
          const sh = Math.sqrt(Math.max(1e-9, 1 - _q.w * _q.w));
          correct(_v3.set(_q.x / sh, _q.y / sh, _q.z / sh), sang - 0.08);
        }
        if (tw > lim.hinge[1]) correct(_v3.set(1, 0, 0), tw - lim.hinge[1]);
        else if (tw < lim.hinge[0]) correct(_v3.set(-1, 0, 0), lim.hinge[0] - tw);
      }
      if (dw.lengthSq() < 1e-8) continue;
      // split the correction: the lighter child takes most of it
      const mc = part.def.mass, mp = part.parent.def.mass;
      const kc = mp / (mc + mp), kp = mc / (mc + mp);
      cb.setAngvel({ x: wc.x + dw.x * kc, y: wc.y + dw.y * kc, z: wc.z + dw.z * kc }, true);
      pb.setAngvel({ x: wp.x - dw.x * kp, y: wp.y - dw.y * kp, z: wp.z - dw.z * kp }, true);
    }
  }

  /** Copies body transforms onto the skeleton. */
  sync(dt) {
    if (!this.active) return;
    const rig = this.rig;
    let maxV = 0;
    for (const part of this.parts) {
      const b = part.body;
      const r = b.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      part.bone.parent.getWorldQuaternion(_q2);
      part.bone.quaternion.copy(_q2.invert().multiply(_q));
      if (part.def.bone === 'hips') {
        const t = b.translation();
        _p.set(t.x, t.y, t.z);
        rig.root.updateMatrixWorld(true);
        rig.root.worldToLocal(_p);
        rig.bones.hips.position.copy(_p);
      }
      part.bone.updateMatrixWorld(true);
      const lv = b.linvel();
      maxV = Math.max(maxV, Math.hypot(lv.x, lv.y, lv.z));
    }
    this.maxSpeed = maxV;
    if (maxV < 0.35) this.calm += dt; else this.calm = 0;
  }

  hipsPosition(out) {
    const t = this.byBone.hips.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  partPosition(name, out) {
    const t = this.byBone[name].body.translation();
    return out.set(t.x, t.y, t.z);
  }

  partQuat(name, out) {
    const r = this.byBone[name].body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  velocity(out) {
    const v = this.byBone.chest.body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  deactivate() {
    if (!this.active) return;
    for (const part of this.parts) this.physics.removeBody(part.body);
    this.parts = [];
    this.byBone = {};
    this.active = false;
  }
}

export { _p2 };
