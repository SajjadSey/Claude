import * as THREE from 'three';
import { Pose, blendFrom, applyPoseDef, POSES } from './pose.js';
import { solveTwoBone } from './ik.js';
import { clamp, lerp, smooth01, easeInOut, bezier3, quatFromYaw, wrapAngle, UP } from '../core/util.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _pole = new THREE.Vector3();
const _qShin = new THREE.Quaternion();
const _zero = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);

const LEG_BONES = ['thigh', 'shin', 'foot'];
const ARM_BONES = ['shoulder', 'upperArm', 'forearm', 'hand', 'fingers'];
function boneGroup(name) {
  if (name === 'hipsPos') return { g: 'torso' };
  for (const b of LEG_BONES) if (name.startsWith(b)) return { g: 'leg', s: name.slice(-1) };
  for (const b of ARM_BONES) if (name.startsWith(b)) return { g: 'arm', s: name.slice(-1) };
  return { g: name === 'neck' || name === 'head' ? 'head' : 'torso' };
}
const GROUP_CACHE = new Map();
function grp(name) {
  if (!GROUP_CACHE.has(name)) GROUP_CACHE.set(name, boneGroup(name));
  return GROUP_CACHE.get(name);
}

/** Pins a foot (ankle) to a world position with weight, keeping the foot's world orientation. */
function pinFoot(c, leg, pin, w, lift = 0, poleDir = null) {
  if (w <= 0.001 && lift <= 0.001) return;
  const rig = c.rig;
  rig.root.updateMatrixWorld(true);
  const foot = rig.bones['foot' + leg];
  foot.getWorldPosition(_v);
  foot.getWorldQuaternion(_q2);
  _v.lerp(pin, clamp(w, 0, 1));
  _v.y += lift;
  if (poleDir) _pole.copy(poleDir);
  else _pole.set(0, 0.3, 1).applyQuaternion(rig.root.quaternion);
  solveTwoBone(rig.bones['thigh' + leg], rig.bones['shin' + leg], _v, _pole, 1, rig.L.thigh, rig.L.shin, 1, _qShin);
  foot.quaternion.copy(_qShin).invert().multiply(_q2);
}

function groundY(game, x, z, nearY) {
  _v3.set(x, nearY, z);
  const P = game.physics;
  const hit = P.raycast(_v3.set(x, nearY + 1.0, z), _down, 3, P.R ? undefined : undefined);
  return hit ? hit.point.y : nearY;
}
const _down = new THREE.Vector3(0, -1, 0);

/* ======================================================================= ENTER */
export class EnterSequence {
  constructor(game, ch, veh, side = 1) {
    this.game = game;
    this.c = ch;
    this.veh = veh;
    this.side = side;
    this.phase = 'approach';
    this.t = 0;
    this.total = 0;
    this.done = false;
    this.aborted = false;
    this.occupant = side === 1 ? veh.driver : veh.passengers[0] || null;
    if (this.occupant === ch) this.occupant = null;
    this.from = new Pose(ch.rig.list.length);
    this.to = new Pose(ch.rig.list.length);
    this.pins = {};
    ch.seq = this;
    ch.state = 'seq';
    ch.clearHands();
    if (veh.ai && veh.ai.onThreat) veh.ai.onThreat(ch);
    this.buildPath();
  }

  get T() { return this.veh.T; }

  /** Car-local stand point outside the door, slightly behind its rear edge. */
  standLocal(out) {
    const v = this.veh;
    return out.set(this.side * (v.halfW + 0.62), 0, v.T.zDoorRear - 0.28);
  }
  gapLocal(out) {
    const v = this.veh;
    return out.set(this.side * (v.halfW + 0.36), 0, v.model.seat.z + 0.18);
  }

  buildPath() {
    const v = this.veh, side = this.side;
    const local = v.worldToLocal(this.c.pos, new THREE.Vector3());
    const hw = v.halfW + 0.85, hl = v.halfL + 0.75;
    const pts = [];
    const sameSide = Math.sign(local.x || side) === side && Math.abs(local.x) > v.halfW * 0.6;
    if (!sameSide) {
      const viaFront = local.z > -0.3;
      const zc = viaFront ? hl : -hl;
      pts.push(new THREE.Vector3(-side * hw, 0, zc), new THREE.Vector3(side * hw, 0, zc));
    } else if (Math.abs(local.z) > v.halfL) {
      pts.push(new THREE.Vector3(side * hw, 0, Math.sign(local.z) * (v.halfL + 0.2)));
    }
    pts.push(this.standLocal(new THREE.Vector3()));
    this.path = pts;
  }

  worldOf(local, out) {
    this.veh.localToWorld(local, out);
    out.y = this.c.groundAt(out.x, out.z, this.c.pos.y);
    return out;
  }

  abort(reason) {
    if (this.done) return;
    this.aborted = true;
    this.done = true;
    const c = this.c;
    c.clearHands();
    c.seq = null;
    if (this.veh.driver === c && c.state !== 'vehicle') this.veh.driver = null;
    if (c.state === 'seq') {
      c.state = 'foot';
      c.setCapsuleEnabled(true);
    }
    if (this.occupant && this.occupant.state === 'seq' && this.occupant.seq === this.occSeq) {
      this.occupant.seq = null;
      this.occupant.toRagdoll(_v.set(0, 0, 0));
    }
    const d = this.veh.doorBySide(this.side);
    if (d && d.scripted) this.veh.releaseDoor(this.side);
    void reason;
  }

  setPhase(p) {
    this.phase = p;
    this.t = 0;
  }

  update(dt) {
    if (this.done) return;
    const c = this.c, v = this.veh;
    this.t += dt;
    this.total += dt;
    if (v.removed) { this.abort('removed'); return; }
    switch (this.phase) {
      case 'approach': this.approach(dt); break;
      case 'align': this.align(dt); break;
      case 'open': this.open(dt); break;
      case 'step': this.step(dt); break;
      case 'jackReach': this.jackReach(dt); break;
      case 'jackPull': this.jackPull(dt); break;
      case 'jackRecover': this.jackRecover(dt); break;
      case 'sit': this.sit(dt); break;
      case 'close': this.close(dt); break;
      default: break;
    }
    void c;
  }

  approach(dt) {
    const c = this.c, v = this.veh;
    if (this.total > 7 || (v.speed > 5 && this.total > 2.5)) { this.abort('timeout'); return; }
    const last = this.path.length === 1;
    const tgt = this.worldOf(this.path[0], _v);
    const dx = tgt.x - c.pos.x, dz = tgt.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < (last ? 0.14 : 0.45)) {
      if (!last) { this.path.shift(); return; }
      this.setPhase('align');
      return;
    }
    const mode = dist > 2.5 && !last ? 'run' : dist > 3 ? 'run' : 'walk';
    const mag = last ? clamp(dist / 0.9, 0.35, 1) : 1;
    _v2.set(dx / dist, 0, dz / dist);
    c.driveFoot(dt, _v2, mag, mode);
  }

  align(dt) {
    const c = this.c, v = this.veh;
    v.doorHandleWorld(this.side, _v);
    const yaw = Math.atan2(_v.x - c.pos.x, _v.z - c.pos.z);
    c.driveFoot(dt, _zero, 0, 'walk', false, yaw);
    if ((Math.abs(wrapAngle(yaw - c.yaw)) < 0.12 && this.t > 0.2) || this.t > 0.7) {
      this.hand = this.handFor(_v);
      this.setPhase('open');
      this.doorStart = v.doorBySide(this.side).open;
    }
  }

  handFor(worldTarget) {
    const c = this.c;
    const dx = worldTarget.x - c.pos.x, dz = worldTarget.z - c.pos.z;
    // local x = dot with left vector (cos yaw, -sin yaw)
    const lx = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw);
    return lx >= 0 ? 'L' : 'R';
  }

  open(dt) {
    const c = this.c, v = this.veh, side = this.side;
    const D = 1.0, t = this.t;
    const openTarget = 1.08;
    // door motion after the hand grabs the handle
    const k = clamp((t - 0.32) / 0.48, 0, 1);
    const amount = Math.max(this.doorStart, openTarget * easeInOut(k));
    v.setDoorOpen(side, amount, true);
    if (t >= 0.32 && !this.clicked) { this.clicked = true; this.game.audio?.doorOpen(v.doorHandleWorld(side, _v2)); }
    // step back & aside while the door swings
    let mag = 0;
    if (t > 0.38 && t < 0.78) {
      _v2.set(side, 0, -0.9).applyQuaternion(v.curQuat);
      _v2.y = 0;
      _v2.normalize();
      mag = 0.32;
    } else _v2.set(0, 0, 0);
    v.doorHandleWorld(side, _v);
    const faceYaw = Math.atan2(_v.x - c.pos.x, _v.z - c.pos.z);
    c.driveFoot(dt, _v2, mag, 'walk', false, faceYaw);
    // reach for the handle
    const reach = t < 0.32 ? smooth01(t / 0.32) : t < 0.72 ? 1 : 1 - smooth01((t - 0.72) / 0.25);
    _v3.set(side * 0.03, -0.01, 0).applyQuaternion(v.curQuat);
    _v.add(_v3);
    c.setHand(this.hand, _v, reach, null, null, t > 0.25 && t < 0.75 ? 0.9 : 0.4);
    if (t >= D) {
      c.clearHands();
      this.setPhase('step');
      this.afterStep = this.occupant && this.occupant.state === 'vehicle' ? 'jackReach' : 'sit';
    }
  }

  step(dt) {
    const c = this.c, v = this.veh;
    const tgt = this.worldOf(this.gapLocal(_v2), _v);
    const dx = tgt.x - c.pos.x, dz = tgt.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    // face the car interior
    _v3.set(-this.side, 0, 0.15).applyQuaternion(v.curQuat);
    const faceYaw = Math.atan2(_v3.x, _v3.z);
    if (dist > 0.1 && this.t < 1.6) {
      _v3.set(dx / dist, 0, dz / dist);
      c.driveFoot(dt, _v3, clamp(dist / 0.6, 0.3, 0.7), 'walk', false, faceYaw);
    } else {
      c.driveFoot(dt, _zero, 0, 'walk', false, faceYaw);
      if (Math.abs(wrapAngle(faceYaw - c.yaw)) < 0.2 || this.t > 2.2) {
        this.setPhase(this.afterStep || 'sit');
        if (this.phase === 'sit') this.beginSit();
        if (this.phase === 'jackReach') this.beginJack();
      }
    }
  }

  /* ---------------------------------------------------------------- jacking */
  beginJack() {
    const occ = this.occupant;
    const v = this.veh;
    if (v.ai) { v.ai.disable?.(); v.ai = null; }
    occ.clearHands();
    this.occFrom = new Pose(occ.rig.list.length).capture(occ.rig);
    this.occSeq = { update: (dt) => this.updateOccupant(dt), abort: () => {} };
    occ.seq = this.occSeq;
    occ.state = 'seq';
    this.occT = -1;
    this.game.audio?.shout?.(occ.pos, occ.app.female);
  }

  occChest(out) {
    return this.occupant.rig.bones.chest.getWorldPosition(out);
  }

  jackReach(dt) {
    const c = this.c, v = this.veh;
    _v3.set(-this.side, 0, 0.1).applyQuaternion(v.curQuat);
    c.driveFoot(dt, _zero, 0, 'walk', false, Math.atan2(_v3.x, _v3.z));
    const w = smooth01(this.t / 0.38);
    this.occupant.rig.root.updateMatrixWorld(true);
    this.grabHands(w);
    c.rig.bones.spine.quaternion.multiply(_q.setFromAxisAngle(_xAxis, 0.25 * w));
    if (this.t >= 0.38) { this.setPhase('jackPull'); this.occT = 0; }
  }

  grabHands(w) {
    const c = this.c, v = this.veh;
    this.occChest(_v);
    for (const arm of ['L', 'R']) {
      _v2.set(0, 0.05, arm === 'L' ? 0.12 : -0.12);
      _v2.applyQuaternion(v.curQuat);
      _v3.copy(_v).add(_v2);
      _v2.set(this.side * 0.08, 0, 0).applyQuaternion(v.curQuat);
      _v3.add(_v2);
      c.setHand(arm, _v3, w, null, null, 1);
    }
  }

  updateOccupant(dt) {
    // driven by jackPull; when not yet pulling keep seated
    if (this.occT < 0) { this.occupant.updateSeated(dt); return; }
    const occ = this.occupant, v = this.veh, side = this.side;
    const u = clamp(this.occT / 0.8, 0, 1);
    // target pose: stumble
    applyPoseDef(occ.rig, POSES.stumble);
    blendFrom(occ.rig, this.occFrom, smooth01(u * 1.2));
    // root path in car space
    const s1 = v.seatLocal(side, _v).clone();
    s1.y -= occ.rig.L.hipsY;
    const e2 = _v2.set(side * (v.halfW + 0.75), 0, v.model.seat.z - 0.85);
    const gy = this.worldOf(e2, _v3).y;
    e2.y = v.worldToLocal(_v3, new THREE.Vector3()).y + 0.05;
    const c1 = s1.clone().add(new THREE.Vector3(side * 0.3, 0.18, 0));
    const c2 = e2.clone().add(new THREE.Vector3(0, 0.25, 0.35));
    const p = bezier3(s1, c1, c2, e2, smooth01(u), new THREE.Vector3());
    v.localToWorld(p, occ.rig.root.position);
    // rotate to face the car (pulled out backwards)
    _q.setFromAxisAngle(_yAxis, -side * Math.PI / 2 * smooth01(u));
    occ.rig.root.quaternion.copy(v.curQuat).multiply(_q);
    occ.rig.root.updateMatrixWorld(true);
    occ.pos.copy(occ.rig.root.position);
    occ.pos.y = gy;
    void dt;
  }

  jackPull(dt) {
    const c = this.c, v = this.veh, side = this.side;
    this.occT += dt;
    const u = clamp(this.occT / 0.8, 0, 1);
    // player leans back and turns towards the rear while pulling
    _v3.set(-side, 0, 0.1).applyQuaternion(v.curQuat);
    const base = Math.atan2(_v3.x, _v3.z);
    const faceYaw = base + side * 0.9 * smooth01(u);
    _v2.set(side * 0.4, 0, -0.6).applyQuaternion(v.curQuat);
    _v2.y = 0;
    _v2.normalize();
    c.driveFoot(dt, u > 0.2 && u < 0.8 ? _v2 : _zero, u > 0.2 && u < 0.8 ? 0.25 : 0, 'walk', false, faceYaw);
    c.rig.bones.spine.quaternion.multiply(_q.setFromAxisAngle(_xAxis, -0.25 * Math.sin(Math.PI * u)));
    this.grabHands(1 - smooth01((u - 0.85) / 0.15));
    if (u >= 1) {
      // throw!
      const occ = this.occupant;
      occ.seq = null;
      occ.leaveVehicleInstant();
      occ.state = 'foot';
      const vel = _v.set(side * 2.6, 1.4, -2.6).applyQuaternion(v.curQuat);
      v.linvel(_v2);
      vel.add(_v2);
      occ.toRagdoll(vel, { spin: 1.5 });
      occ.damage(4, 'jacked', c);
      this.game.onJacked?.(occ, c, v);
      c.clearHands();
      this.occupant = null;
      this.afterStep = 'sit';
      this.setPhase('jackRecover');
    }
  }

  jackRecover(dt) {
    this.c.driveFoot(dt, _zero, 0, 'walk', false, null);
    if (this.t > 0.15) this.setPhase('step');
  }

  /* ---------------------------------------------------------------- sitting down */
  beginSit() {
    const c = this.c, v = this.veh, side = this.side;
    c.clearHands();
    c.setCapsuleEnabled(false);
    if (side === 1) v.driver = c; else v.passengers.push(c);
    c.vehicle = v;
    c.seatSide = side;
    this.from.capture(c.rig);
    // car-local start root
    this.r0 = v.worldToLocal(c.rig.root.position, new THREE.Vector3());
    _qi.copy(v.curQuat).invert();
    this.q0 = _qi.clone().multiply(c.rig.root.quaternion);
    this.r1 = v.seatLocal(side, new THREE.Vector3());
    this.r1.y -= c.rig.L.hipsY;
    // remember where the feet are planted
    c.rig.root.updateMatrixWorld(true);
    this.pinL = c.rig.bones.footL.getWorldPosition(new THREE.Vector3());
    this.pinR = c.rig.bones.footR.getWorldPosition(new THREE.Vector3());
    // inner leg leads: for the left-hand seat the inner side is the character's right
    this.lead = side === 1 ? 'R' : 'L';
    this.trail = side === 1 ? 'L' : 'R';
    this.dipped = false;
  }

  sit(dt) {
    const c = this.c, v = this.veh, side = this.side, rig = c.rig;
    const D = 1.25;
    const u = clamp(this.t / D, 0, 1);
    // target seated pose computed at the final seat transform
    c.seatRoot(v, side, rig.root.position, rig.root.quaternion);
    rig.root.updateMatrixWorld(true);
    c.seatedPose(v, side, dt, { driver: side === 1 });
    this.to.capture(rig);
    // interpolated root
    const r1 = this.r1;
    const c1 = _v.copy(this.r0).add(_v3.set(-side * 0.05, 0.04, 0.05));
    const c2 = _v2.copy(r1).add(_v3.set(side * 0.38, 0.0, 0.1));
    const p = bezier3(this.r0, c1, c2, r1, smooth01(u), new THREE.Vector3());
    v.localToWorld(p, rig.root.position);
    const ru = smooth01((u - 0.08) / 0.6);
    _q.copy(this.q0).slerp(_q2.identity(), ru);
    rig.root.quaternion.copy(v.curQuat).multiply(_q);
    rig.root.updateMatrixWorld(true);
    // staggered blend from the standing snapshot
    this.to.apply(rig);
    const lead = this.lead, trail = this.trail;
    blendFrom(rig, this.from, u, (name) => {
      const g = grp(name);
      if (g.g === 'leg') return g.s === lead ? smooth01((u - 0.05) / 0.45) : smooth01((u - 0.48) / 0.42);
      if (g.g === 'arm') return smooth01((u - 0.2) / 0.6);
      if (g.g === 'head') return smooth01((u - 0.1) / 0.75);
      return smooth01((u - 0.1) / 0.62);
    });
    // duck the head under the roof line
    const duck = Math.sin(Math.PI * clamp((u - 0.15) / 0.7, 0, 1));
    rig.bones.spine.quaternion.multiply(_q.setFromAxisAngle(_xAxis, 0.32 * duck));
    rig.bones.neck.quaternion.multiply(_q.setFromAxisAngle(_xAxis, 0.35 * duck));
    // planted feet: trailing foot stays on the pavement until it swings in
    const pinTrail = 1 - smooth01((u - 0.5) / 0.25);
    const pinLead = 1 - smooth01((u - 0.04) / 0.2);
    const liftLead = 0.12 * Math.sin(Math.PI * clamp((u - 0.05) / 0.4, 0, 1));
    const liftTrail = 0.14 * Math.sin(Math.PI * clamp((u - 0.5) / 0.4, 0, 1));
    const pinFor = (leg) => (leg === 'L' ? this.pinL : this.pinR);
    pinFoot(c, lead, pinFor(lead), pinLead, liftLead);
    pinFoot(c, trail, pinFor(trail), pinTrail, liftTrail);
    c.pos.copy(rig.root.position);
    if (!this.dipped && u > 0.55) {
      this.dipped = true;
      v.seatLocal(side, _v);
      v.localToWorld(_v, _v2);
      v.body.applyImpulseAtPoint({ x: 0, y: -110, z: 0 }, { x: _v2.x, y: _v2.y, z: _v2.z }, true);
      this.game.audio?.seat?.(_v2);
    }
    if (u >= 1) {
      c.state = 'seq';
      this.setPhase('close');
      this.doorStart = v.doorBySide(side).open;
      this.outer = side === 1 ? 'L' : 'R';
    }
  }

  close(dt) {
    const c = this.c, v = this.veh, side = this.side;
    c.updateSeated(dt);
    const t = this.t;
    const reach = t < 0.28 ? smooth01(t / 0.28) : t < 0.66 ? 1 : 1 - smooth01((t - 0.66) / 0.2);
    const k = clamp((t - 0.28) / 0.36, 0, 1);
    const amt = this.doorStart * (1 - k * k);
    v.setDoorOpen(side, amt, true);
    v.doorInnerHandleWorld(side, _v);
    c.setHand(this.outer, _v, reach, null, null, 0.9);
    if (k >= 1 && !this.slammed) {
      this.slammed = true;
      v.setDoorOpen(side, 0, false);
      v.doorBySide(side).latched = true;
      v.localToWorld(v.doorBySide(side).hinge, _v2);
      this.game.audio?.doorSlam(_v2, 1);
      v.body.applyImpulseAtPoint({ x: 0, y: -40, z: 0 }, { x: _v2.x, y: _v2.y, z: _v2.z }, true);
    }
    if (t >= 0.88) {
      c.clearHands();
      c.state = 'vehicle';
      c.seq = null;
      this.done = true;
      c.startBlend(0.12);
      this.game.onEnteredVehicle?.(c, v);
    }
  }
}

/* ======================================================================= EXIT */
export class ExitSequence {
  constructor(game, ch, veh) {
    this.game = game;
    this.c = ch;
    this.veh = veh;
    this.side = ch.seatSide;
    this.phase = 'openIn';
    this.t = 0;
    this.done = false;
    this.from = new Pose(ch.rig.list.length);
    this.to = new Pose(ch.rig.list.length);
    ch.seq = this;
    ch.state = 'seq';
    this.outer = this.side === 1 ? 'L' : 'R';
    this.inner = this.side === 1 ? 'R' : 'L';
    this.doorStart = veh.doorBySide(this.side).open;
    if (veh.speed > 6.5) this.bailOut();
  }

  abort() {
    if (this.done) return;
    this.done = true;
    this.c.seq = null;
    this.c.clearHands();
    const d = this.veh.doorBySide(this.side);
    if (d && d.scripted) this.veh.releaseDoor(this.side);
  }

  setPhase(p) { this.phase = p; this.t = 0; }

  exitLocal(out) {
    const v = this.veh;
    return out.set(this.side * (v.halfW + 0.48), 0, v.model.seat.z + 0.1);
  }

  bailOut() {
    const c = this.c, v = this.veh, side = this.side;
    v.setDoorOpen(side, 1.0, false);
    v.doorBySide(side).latched = false;
    v.doorBySide(side).vel = 1.5;
    this.exitLocal(_v);
    _v.y = v.model.seat.y - 0.3;
    v.localToWorld(_v, _v2);
    c.leaveVehicleInstant();
    c.rig.root.position.copy(_v2).sub(_v3.set(0, c.rig.L.hipsY, 0));
    c.rig.root.updateMatrixWorld(true);
    const vel = v.linvel(new THREE.Vector3()).multiplyScalar(0.92);
    vel.add(_v.set(side * 2.5, 1.2, 0).applyQuaternion(v.curQuat));
    c.state = 'foot';
    c.seq = null;
    this.done = true;
    c.clearHands();
    c.toRagdoll(vel, { spin: 2 });
    c.damage(Math.max(0, v.speed - 8) * 2, 'bail');
    this.game.onExitedVehicle?.(c, v);
  }

  update(dt) {
    if (this.done) return;
    this.t += dt;
    if (this.veh.removed) { this.abort(); return; }
    if (this.phase === 'openIn') this.openIn(dt);
    else if (this.phase === 'out') this.out(dt);
    else if (this.phase === 'closeOut') this.closeOut(dt);
  }

  openIn(dt) {
    const c = this.c, v = this.veh, side = this.side;
    c.updateSeated(dt);
    const t = this.t;
    const reach = t < 0.22 ? smooth01(t / 0.22) : t < 0.5 ? 1 : 1 - smooth01((t - 0.5) / 0.15);
    const k = clamp((t - 0.18) / 0.38, 0, 1);
    v.setDoorOpen(side, Math.max(this.doorStart, 1.05 * easeInOut(k)), true);
    if (k > 0 && !this.clicked) { this.clicked = true; this.game.audio?.doorOpen(c.pos); }
    v.doorInnerHandleWorld(side, _v);
    c.setHand(this.outer, _v, reach, null, null, 0.9);
    if (t >= 0.62) {
      c.clearHands();
      this.beginOut();
      this.setPhase('out');
    }
  }

  beginOut() {
    const c = this.c, v = this.veh, side = this.side, rig = c.rig;
    this.from.capture(rig);
    this.r0 = v.seatLocal(side, new THREE.Vector3());
    this.r0.y -= rig.L.hipsY;
    const e = this.exitLocal(new THREE.Vector3());
    const ew = v.localToWorld(e, new THREE.Vector3());
    ew.y = c.groundAt(ew.x, ew.z, ew.y + 0.3);
    this.r1 = v.worldToLocal(ew, new THREE.Vector3());
    // final orientation: upright, facing outward and slightly forward
    const out = _v.set(side, 0, 0.55).applyQuaternion(v.curQuat);
    this.finalYaw = Math.atan2(out.x, out.z);
    _qi.copy(v.curQuat).invert();
    this.q1 = _qi.clone().multiply(quatFromYaw(this.finalYaw, new THREE.Quaternion()));
    applyPoseDef(rig, POSES.stand, this.to);
    this.from.apply(rig);
    // pins for the feet on the pavement
    const f = _v.set(Math.sin(this.finalYaw), 0, Math.cos(this.finalYaw));
    const l = _v2.set(Math.cos(this.finalYaw), 0, -Math.sin(this.finalYaw));
    const s = rig.scale;
    this.pinL = ew.clone().addScaledVector(l, 0.11 * s).addScaledVector(f, 0.02);
    this.pinR = ew.clone().addScaledVector(l, -0.11 * s).addScaledVector(f, 0.02);
    for (const p of [this.pinL, this.pinR]) p.y = c.groundAt(p.x, p.z, ew.y) + rig.L.ankle;
    this.lead = side === 1 ? 'L' : 'R'; // outer leg steps out first
    this.trail = side === 1 ? 'R' : 'L';
    this.groundW = ew;
  }

  out(dt) {
    const c = this.c, v = this.veh, side = this.side, rig = c.rig;
    const D = 1.15;
    const u = clamp(this.t / D, 0, 1);
    // target: standing pose
    this.to.apply(rig);
    const c1 = _v.copy(this.r0).add(_v3.set(side * 0.32, 0.06, 0.08));
    const c2 = _v2.copy(this.r1).add(_v3.set(-side * 0.12, 0.08, 0));
    const p = bezier3(this.r0, c1, c2, this.r1, smooth01(u), new THREE.Vector3());
    v.localToWorld(p, rig.root.position);
    _q.identity().slerp(this.q1, smooth01((u - 0.05) / 0.62));
    rig.root.quaternion.copy(v.curQuat).multiply(_q);
    // keep the root upright at the end
    rig.root.updateMatrixWorld(true);
    const lead = this.lead;
    blendFrom(rig, this.from, u, (name) => {
      const g = grp(name);
      if (g.g === 'leg') return g.s === lead ? smooth01(u / 0.42) : smooth01((u - 0.38) / 0.5);
      if (g.g === 'arm') return smooth01((u - 0.15) / 0.65);
      if (g.g === 'head') return smooth01((u - 0.05) / 0.7);
      return smooth01((u - 0.12) / 0.66);
    });
    const duck = Math.sin(Math.PI * clamp((u - 0.05) / 0.65, 0, 1));
    rig.bones.spine.quaternion.multiply(_q.setFromAxisAngle(_xAxis, 0.35 * duck));
    rig.bones.neck.quaternion.multiply(_q.setFromAxisAngle(_xAxis, 0.3 * duck));
    // feet: lead foot lands on the pavement at ~35%, trail foot at ~85%
    const leadPin = smooth01((u - 0.22) / 0.16);
    const trailPin = smooth01((u - 0.68) / 0.18);
    const liftLead = 0.1 * Math.sin(Math.PI * clamp(u / 0.38, 0, 1));
    const liftTrail = 0.12 * Math.sin(Math.PI * clamp((u - 0.4) / 0.48, 0, 1));
    const pinFor = (leg) => (leg === 'L' ? this.pinL : this.pinR);
    pinFoot(c, lead, pinFor(lead), leadPin, liftLead * (1 - leadPin));
    pinFoot(c, this.trail, pinFor(this.trail), trailPin, liftTrail * (1 - trailPin));
    c.pos.copy(rig.root.position);
    if (u >= 1) {
      // hand over to locomotion
      c.leaveVehicleInstant();
      c.pos.copy(this.groundW);
      c.yaw = this.finalYaw;
      rig.root.position.copy(c.pos);
      rig.root.quaternion.copy(quatFromYaw(c.yaw, _q));
      rig.root.updateMatrixWorld(true);
      c.state = 'seq';
      c.setCapsuleEnabled(true);
      c.teleportBody();
      c.vel.set(0, 0, 0);
      c.speedScalar = 0;
      c.vy = 0;
      c.grounded = true;
      c.loco.plantFromCurrent();
      c.startBlend(0.2);
      this.game.onExitedVehicle?.(c, v);
      this.setPhase('closeOut');
      this.doorStart = v.doorBySide(side).open;
    }
  }

  closeOut(dt) {
    const c = this.c, v = this.veh, side = this.side;
    const t = this.t;
    const inp = c.isPlayer ? this.game.player.moveIntent : 0;
    if (inp > 0.3 && t > 0.1) {
      // player wants to go: leave the door swinging
      v.releaseDoor(side);
      v.doorBySide(side).latched = false;
      c.clearHands();
      this.finish();
      return;
    }
    v.doorEdgeWorld(side, _v);
    if (!this.hand) this.hand = this.handFor(_v);
    const faceYaw = Math.atan2(_v.x - c.pos.x, _v.z - c.pos.z);
    c.driveFoot(dt, _zero, 0, 'walk', false, faceYaw);
    const reach = t < 0.3 ? smooth01(t / 0.3) : t < 0.62 ? 1 : 1 - smooth01((t - 0.62) / 0.22);
    const k = clamp((t - 0.3) / 0.32, 0, 1);
    v.setDoorOpen(side, this.doorStart * (1 - k * k), true);
    c.setHand(this.hand, _v, reach, null, null, 0.2);
    if (k >= 1 && !this.slammed) {
      this.slammed = true;
      v.setDoorOpen(side, 0, false);
      v.doorBySide(side).latched = true;
      v.localToWorld(v.doorBySide(side).hinge, _v2);
      this.game.audio?.doorSlam(_v2, 1);
      v.body.applyImpulseAtPoint({ x: 0, y: -30, z: 0 }, { x: _v2.x, y: _v2.y, z: _v2.z }, true);
    }
    if (t >= 0.86) this.finish();
  }

  handFor(worldTarget) {
    const c = this.c;
    const dx = worldTarget.x - c.pos.x, dz = worldTarget.z - c.pos.z;
    const lx = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw);
    return lx >= 0 ? 'L' : 'R';
  }

  finish() {
    const c = this.c;
    this.done = true;
    c.clearHands();
    c.seq = null;
    c.state = 'foot';
  }
}

export { groundY, UP };
