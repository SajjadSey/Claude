import * as THREE from 'three';
import { solveTwoBone, setWorldQuat } from './ik.js';
import { clamp, lerp, damp, smooth01, quatFromYaw, quatFromBasis, wrapAngle, approach } from '../core/util.js';
import { G, groups } from '../core/physics.js';

/*
 * Riding a motorcycle: the riding pose (hands on the grips, feet on the pegs or a foot down at a
 * stop, hanging off into turns) and the get-on / get-off / hijack / pick-up animations.
 */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _gw = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qShin = new THREE.Quaternion();
const _e = new THREE.Euler();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _Y = new THREE.Vector3(0, 1, 0);

function groundY(game, p, ignoreBody) {
  _v3.set(p.x, p.y + 1.0, p.z);
  const hit = game.physics.raycast(_v3, _down, 3, groups(G.ALL, G.STATIC | G.PROP), ignoreBody);
  return hit ? hit.point.y : p.y;
}

/** Hand orientation for gripping a bar: fingers wrap forward/down, thumb inwards. */
function gripQuat(bike, side, out) {
  bike.forward(_f);
  _u.set(0, 1, 0).applyQuaternion(bike.curQuat);
  _l.set(1, 0, 0).applyQuaternion(bike.curQuat); // bike left
  _y.copy(_f).multiplyScalar(-0.5).addScaledVector(_u, 0.85).normalize(); // fingers point along -Y
  _z.copy(_l).multiplyScalar(-side).addScaledVector(_y, _l.dot(_y) * side).normalize(); // thumb inwards
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y);
  return quatFromBasis(_x, _y, _z, out);
}

/** Wrist target for a hand on the grip of `side` (+1 left, -1 right). */
function gripWrist(bike, side, out) {
  bike.model.grips[side > 0 ? 'L' : 'R'].getWorldPosition(out);
  gripQuat(bike, side, _q2);
  _gw.set(0, 1, 0).applyQuaternion(_q2);
  return out.addScaledVector(_gw, 0.055);
}

function legIK(ch, leg, target, poleSide) {
  const rig = ch.rig, L = rig.L;
  _pole.copy(ch.bikeFwd || _f).multiplyScalar(1).addScaledVector(ch.bikeLeft || _l, poleSide * 0.35).addScaledVector(_Y, 0.2);
  solveTwoBone(rig.bones['thigh' + leg], rig.bones['shin' + leg], target, _pole, 1, L.thigh, L.shin, 1, _qShin);
}

function footFlat(ch, leg, bike, pitch = -0.15) {
  const rig = ch.rig;
  _q.copy(bike.curQuat);
  _q2.setFromAxisAngle(_xAxis, pitch);
  _q.multiply(_q2);
  rig.bones['foot' + leg].quaternion.copy(_qShin).invert().multiply(_q);
}

/* ================================================================== riding pose */
export function bikeRiderPose(ch, bike, dt, opts = {}) {
  const rig = ch.rig, s = rig.scale, T = bike.T;
  rig.resetPose();
  // seat the hips on the saddle; the whole rider leans with the bike
  const seat = bike.model.seat;
  _v.set(0, seat.y - rig.L.hipsY * s * 0.97, seat.z);
  bike.localToWorld(_v, rig.root.position);
  rig.root.quaternion.copy(bike.curQuat);
  ch.pos.copy(rig.root.position);
  ch.pos.y += rig.L.hipsY * s - 0.4;
  bike.forward(_f);
  ch.yaw = Math.atan2(_f.x, _f.z);
  ch.bikeFwd = ch.bikeFwd || new THREE.Vector3();
  ch.bikeLeft = ch.bikeLeft || new THREE.Vector3();
  ch.bikeFwd.copy(_f);
  ch.bikeLeft.set(1, 0, 0).applyQuaternion(bike.curQuat);
  // body: tuck (sport) or upright (cruiser), hanging off into the turn, ducking behind the screen at speed
  const lean = bike.lean || 0;
  const tuck = T.riderLean + (T.kind === 'sport' ? clamp((bike.speed - 25) / 30, 0, 1) * 0.15 : 0);
  ch.hang = damp(ch.hang || 0, clamp(lean * 0.45, -0.35, 0.35), 6, dt);
  _e.set(tuck * 0.42, 0, ch.hang * 0.5, 'XYZ');
  rig.bones.hips.quaternion.setFromEuler(_e);
  rig.bones.hips.position.x += ch.hang * 0.12 / s;
  _e.set(tuck * 0.32, 0, ch.hang * 0.35, 'XYZ');
  rig.bones.spine.quaternion.setFromEuler(_e);
  _e.set(tuck * 0.26, 0, ch.hang * 0.3, 'XYZ');
  rig.bones.chest.quaternion.setFromEuler(_e);
  rig.root.updateMatrixWorld(true);

  // ------------------------------------------------ legs: pegs, or a foot on the ground at a stop
  const foot = bike.footDown && !opts.noFootDown ? 1 : 0;
  ch.bikeFootW = damp(ch.bikeFootW || 0, foot, 7, dt);
  for (const [leg, side] of [['L', 1], ['R', -1]]) {
    _v.set(side * T.pegs[0], T.pegs[1] + 0.06, T.pegs[2] - 0.05);
    bike.localToWorld(_v, _v2);
    const w = leg === 'L' ? ch.bikeFootW : ch.bikeFootW * (bike.speed < 0.3 ? 0.85 : 0); // both feet down when fully stopped
    if (w > 0.001) {
      _v.set(side * 0.36 * s, 0, seat.z + 0.12);
      bike.localToWorld(_v, _v3);
      _v3.y = groundY(ch.game, _v3, bike.body) + rig.L.ankle;
      _v2.lerp(_v3, w);
    }
    legIK(ch, leg, _v2, side);
    footFlat(ch, leg, bike, lerp(-0.35, 0, w));
  }

  // ------------------------------------------------ arms: on the grips (one may be shooting)
  for (const [arm, side] of [['L', 1], ['R', -1]]) {
    if (ch.driveBy && ch.driveBy.hand === arm) continue;
    if (opts.handsW !== undefined && opts.handsW <= 0.001) continue;
    gripWrist(bike, side, _v2);
    gripQuat(bike, side, _q);
    _pole.copy(ch.bikeLeft).multiplyScalar(side * 0.8).addScaledVector(_Y, -0.6).addScaledVector(_f, -0.3);
    ch.setHand(arm, _v2, opts.handsW ?? 1, _q, _pole, 0.9);
  }

  // ------------------------------------------------ head: keeps the horizon level, looks up the road
  rig.root.updateMatrixWorld(true);
  quatFromYaw(ch.yaw + (ch.lookYawBike || 0), _q);
  _q2.setFromAxisAngle(_xAxis, 0.04);
  _q.multiply(_q2);
  setWorldQuat(rig.bones.head, _q);
  ch.helmetOn = true;
}

/* ================================================================== get on */
export class BikeMount {
  constructor(game, ch, bike) {
    this.game = game;
    this.c = ch;
    this.bike = bike;
    this.isBikeSeq = true;
    this.t = 0;
    this.done = false;
    // side: the one we're standing on, unless it's blocked
    const mine = this.sideOf(ch.pos);
    this.side = this.sideClear(mine) ? mine : this.sideClear(-mine) ? -mine : mine;
    this.phase = bike.fallen ? 'toPickup' : 'approach';
    ch.seq = this;
    ch.state = 'seq';
    ch.clearHands();
    ch.aimTarget = null;
  }

  sideClear(side) { return bikeSideClear(this.game, this.bike, side); }

  /** Which side of the bike (+1 left, -1 right) a point is on. */
  sideOf(p) {
    const b = this.bike;
    _l.set(1, 0, 0).applyQuaternion(b.curQuat);
    return (p.x - b.curPos.x) * _l.x + (p.z - b.curPos.z) * _l.z >= 0 ? 1 : -1;
  }

  /**
   * Next point to walk to on the way to `goal` on our side: when standing on the other side of
   * the bike, go round the back of it first (never through it).
   */
  routeTo(goal, out) {
    const b = this.bike, c = this.c;
    const L = b.worldToLocal(c.pos, _v3);
    const rearZ = -(b.halfL || 1.1) - 0.55;
    if (Math.sign(L.x || 1) !== this.side && Math.abs(L.x) > 0.25) {
      // to the rear corner on our current side, then across behind the tail
      const cur = Math.sign(L.x);
      if (L.z > rearZ + 0.3) return b.localToWorld(out.set(cur * 0.95, 0, rearZ), out);
      return b.localToWorld(out.set(this.side * 0.95, 0, rearZ), out);
    }
    return out.copy(goal);
  }

  standPoint(out) {
    const b = this.bike;
    return b.localToWorld(out.set(this.side * 0.62, 0, b.model.seat.z + 0.05), out);
  }

  abort() {
    if (this.done) return;
    this.done = true;
    const c = this.c;
    c.seq = null;
    c.clearHands();
    if (c.state === 'seq') { c.state = 'foot'; c.setCapsuleEnabled(true); c.loco.initialized = false; }
  }

  walkTo(dt, p, faceYaw = null) {
    const c = this.c;
    _v.set(p.x - c.pos.x, 0, p.z - c.pos.z);
    const d = _v.length();
    if (d > 0.08) _v.divideScalar(d);
    c.driveFoot(dt, _v, d > 0.15 ? clamp(d * 1.5, 0.35, 1) : 0, d > 2.5 ? 'run' : 'walk', false, faceYaw);
    return d;
  }

  update(dt) {
    if (this.done) return;
    const c = this.c, b = this.bike, g = this.game;
    this.t += dt;
    if (b.removed) { this.abort(); return; }
    b.forward(_f);
    const bikeYaw = Math.atan2(_f.x, _f.z);
    switch (this.phase) {
      case 'toPickup': {
        // walk round to the side the saddle faces, then face the bike
        if (!this.pk) this.planPickup();
        const pk = this.pk;
        const near = d0(c, pk.stand0) < 1.3;
        // the bike lies between us and that spot: walk along it to its nearer end and round the tip
        const out = _v3.copy(pk.fd).negate();
        const rx = c.pos.x - pk.base.x, rz = c.pos.z - pk.base.z;
        const a = rx * out.x + rz * out.z, along = rx * pk.fwd.x + rz * pk.fwd.z;
        const end = along >= 0 ? 1 : -1;
        let goal = pk.stand0;
        if (a < 1.0) {
          goal = _v2.copy(pk.base).addScaledVector(pk.fwd, end * 2.0);
          goal.addScaledVector(out, Math.abs(along) < 1.75 ? clamp(a, -0.7, 1.5) : 1.5);
        }
        const d = this.walkTo(dt, goal, near ? pk.faceYaw : null);
        if ((goal === pk.stand0 && d < 0.22 && Math.abs(wrapAngle(c.yaw - pk.faceYaw)) < 0.35) || this.t > 9) {
          this.phase = 'pickup';
          this.t = 0;
          c.setCapsuleEnabled(false);
          this.planPickup(); // the bike may have slid a little meanwhile
          g.audio?.metalHit?.(this.pk.p0, 0.25);
        }
        break;
      }
      case 'pickup': this.pickupPose(dt); break;
      case 'approach': {
        b.holdUpright(0.2, b.standDown ? 0.2 : 0);
        const p = this.standPoint(new THREE.Vector3());
        const w = this.routeTo(p, new THREE.Vector3());
        const final = w.distanceToSquared(p) < 1e-6;
        const d = this.walkTo(dt, w, final && d0(c, p) < 1.5 ? bikeYaw : null);
        if (final && (d < 0.22 || (this.t > 9 && d < 0.6))) { this.phase = 'align'; this.t = 0; }
        else if (this.t > 12) this.abort();
        break;
      }
      case 'align': {
        b.holdUpright(0.2, b.standDown ? 0.2 : 0);
        const p = this.standPoint(new THREE.Vector3());
        this.walkTo(dt, p, bikeYaw);
        if (this.t > 0.3 && Math.abs(wrapAngle(c.yaw - bikeYaw)) < 0.2) {
          this.phase = b.driver ? 'jack' : 'mount';
          this.t = 0;
          this.startPose();
        }
        break;
      }
      case 'jack': {
        // grab the rider and drag him off the far side
        b.holdUpright(0.3, 0.03);
        const occ = b.driver;
        const D = 0.7, u = clamp(this.t / D, 0, 1);
        if (occ) {
          occ.rig.bones.chest.getWorldPosition(_v2);
          for (const arm of ['L', 'R']) c.setHand(arm, _v2, Math.sin(Math.PI * Math.min(1, u * 1.4)) * 0.9, null, null, 0.8);
          c.driveFoot(dt, _v.set(0, 0, 0), 0, 'walk', false, bikeYaw);
          if (u > 0.55) {
            occ.leaveVehicleInstant();
            occ.state = 'foot';
            b.setRiderCollider(false);
            _v.set(-this.side * 2.4, 1.3, -0.4).applyQuaternion(b.curQuat);
            occ.rig.root.updateMatrixWorld(true);
            occ.ignoreVeh = b;
            occ.ignoreVehUntil = g.physics.time + 0.5;
            occ.toRagdoll(_v, { spin: 1.6 });
            occ.damage(6, 'jacked', c);
            g.onJacked?.(occ, c, b);
          }
        } else if (u > 0.6) {
          c.clearHands();
          this.phase = 'mount';
          this.t = 0;
          this.startPose();
        }
        break;
      }
      case 'mount': this.mountPose(dt); break;
      default: break;
    }
  }

  /** Where to stand to lift a fallen bike: on the side its saddle faces, a step away from it. */
  planPickup() {
    const b = this.bike, c = this.c, g = this.game;
    const r = b.body.rotation(), t = b.body.translation();
    const q0 = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const p0 = new THREE.Vector3(t.x, t.y, t.z);
    // the bike's "up" lies along the ground now, pointing out of the saddle
    const upH = new THREE.Vector3(0, 1, 0).applyQuaternion(q0).setY(0);
    const leftW = new THREE.Vector3(1, 0, 0).applyQuaternion(q0);
    if (upH.lengthSq() < 0.04) upH.copy(leftW).setY(0).multiplyScalar(leftW.y < 0 ? -1 : 1);
    if (upH.lengthSq() < 1e-6) upH.set(c.pos.x - p0.x, 0, c.pos.z - p0.z);
    upH.normalize();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q0).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(-upH.z, 0, upH.x);
    fwd.normalize();
    const base = b.localToWorld(new THREE.Vector3(0, 0, b.model.seat.z + 0.1), new THREE.Vector3());
    const gy = groundY(g, base, b.body);
    base.y = gy;
    // blocked on the saddle side (a wall)? lift from the wheel side instead
    _v.set(base.x, gy + 0.6, base.z);
    let dir = 1;
    if (g.physics.raycast(_v, upH, 1.6, groups(G.ALL, G.STATIC | G.CAR), b.body)) dir = -1;
    const out = upH.clone().multiplyScalar(dir);
    const stand0 = base.clone().addScaledVector(out, dir > 0 ? 1.2 : 0.75);
    const stand1 = base.clone().addScaledVector(out, 0.62);
    const fd = out.clone().negate(); // facing the bike
    const left = new THREE.Vector3().crossVectors(_Y, fd).normalize();
    this.pk = {
      q0, p0, upH, fwd, base, gy, stand0, stand1, fd, left,
      faceYaw: Math.atan2(fd.x, fd.z),
      // the grip that sticks up, and which hand takes it (the one nearer the front)
      upSide: leftW.y > 0 ? 1 : -1,
      barArm: fwd.dot(left) > 0 ? 'L' : 'R',
      q1: quatFromYaw(Math.atan2(fwd.x, fwd.z), new THREE.Quaternion()),
      p1: new THREE.Vector3(p0.x, gy + 0.01, p0.z),
    };
    if (this.phase === 'pickup') {
      this.feet0 = {};
      for (const [leg, sd] of [['L', 1], ['R', -1]]) this.feet0[leg] = this.footSpot(stand0, sd);
    }
  }

  footSpot(at, sd, out = new THREE.Vector3()) {
    const pk = this.pk, s = this.c.rig.scale;
    return out.copy(at).addScaledVector(pk.left, sd * 0.15 * s).addScaledVector(pk.fd, sd > 0 ? 0.07 : -0.07);
  }

  /** Squat, grab the high grip and the tail, and lift with the legs while stepping in. */
  pickupPose(dt) {
    const c = this.c, b = this.bike, rig = c.rig, s = rig.scale, pk = this.pk, L = rig.L;
    const D = 1.8, u = clamp(this.t / D, 0, 1);
    const down = smooth01(clamp(u / 0.24, 0, 1));
    const e = smooth01(clamp((u - 0.34) / 0.6, 0, 1)); // how far the bike is up
    const sq = down * (1 - e * 0.95);
    // the bike swings up about its tyres
    const q = _q.copy(pk.q0).slerp(pk.q1, e);
    _v.copy(pk.p0).lerp(pk.p1, e);
    b.body.setTranslation({ x: _v.x, y: _v.y, z: _v.z }, true);
    b.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.curPos.copy(_v);
    b.curQuat.copy(q);
    b.syncVisual();
    // body: hinge at the hips with a flat back, legs doing the work
    rig.resetPose();
    const stepIn = smooth01(clamp((u - 0.42) / 0.5, 0, 1));
    const root = _v2.copy(pk.stand0).lerp(pk.stand1, stepIn);
    root.y = pk.gy - sq * 0.36 * s;
    rig.root.position.copy(root);
    quatFromYaw(pk.faceYaw, rig.root.quaternion);
    _e.set(0.62 * sq + 0.06 * down, 0, 0, 'XYZ');
    rig.bones.hips.quaternion.setFromEuler(_e);
    _e.set(0.16 * sq, 0, 0, 'XYZ');
    rig.bones.spine.quaternion.setFromEuler(_e);
    _e.set(-0.12 * sq, 0, 0, 'XYZ');
    rig.bones.chest.quaternion.setFromEuler(_e);
    rig.root.updateMatrixWorld(true);
    c.bikeFwd = c.bikeFwd || new THREE.Vector3();
    c.bikeLeft = c.bikeLeft || new THREE.Vector3();
    c.bikeFwd.copy(pk.fd);
    c.bikeLeft.copy(pk.left);
    // feet: planted, then one short step each as the rider follows the bike up
    for (const [leg, sd, t0] of [['L', 1, 0.45], ['R', -1, 0.66]]) {
      const k = smooth01(clamp((u - t0) / 0.22, 0, 1));
      const target = this.footSpot(pk.stand1, sd, _v3).lerp(this.feet0[leg], 1 - k);
      target.y = pk.gy + L.ankle + Math.sin(Math.PI * k) * 0.07;
      legIK(c, leg, target, sd);
      quatFromYaw(pk.faceYaw, _q2);
      _qShin.invert();
      rig.bones['foot' + leg].quaternion.copy(_qShin).multiply(_q2);
    }
    // hands: the high grip and the tail of the seat
    const hw = smooth01(clamp((u - 0.06) / 0.2, 0, 1)) * (1 - smooth01(clamp((u - 0.9) / 0.1, 0, 1)));
    const seatArm = pk.barArm === 'L' ? 'R' : 'L';
    gripWrist(b, pk.upSide, _v3);
    _pole.copy(pk.left).multiplyScalar(pk.barArm === 'L' ? 0.7 : -0.7).addScaledVector(pk.fd, -0.4).addScaledVector(_Y, -0.3);
    c.setHand(pk.barArm, _v3, hw, null, _pole, 0.95);
    b.localToWorld(_v3.set(pk.upSide * 0.1, b.model.seat.y + 0.03, b.model.seat.z - 0.42), _v3);
    _pole.copy(pk.left).multiplyScalar(seatArm === 'L' ? 0.7 : -0.7).addScaledVector(pk.fd, -0.4).addScaledVector(_Y, -0.3);
    c.setHand(seatArm, _v3, hw, null, _pole, 0.9);
    c.yaw = pk.faceYaw;
    c.pos.copy(root).setY(pk.gy);
    if (u >= 1) {
      // standing on its stand, ready to get on
      c.clearHands();
      c.setCapsuleEnabled(true);
      c.teleport(c.pos, pk.faceYaw);
      b.fallen = false;
      b.setFallen(false);
      b.standDown = true;
      b.holdUpright(0.4, 0.2);
      this.pk = null;
      this.phase = 'approach';
      this.t = 0;
      _v.set(1, 0, 0).applyQuaternion(b.curQuat);
      const mySide = (c.pos.x - b.curPos.x) * _v.x + (c.pos.z - b.curPos.z) * _v.z > 0 ? 1 : -1;
      this.side = this.sideClear(mySide) ? mySide : -mySide;
    }
  }

  startPose() {
    const c = this.c;
    c.setCapsuleEnabled(false);
    c.rig.root.updateMatrixWorld(true);
    this.feet = {
      L: c.rig.bones.footL.getWorldPosition(new THREE.Vector3()),
      R: c.rig.bones.footR.getWorldPosition(new THREE.Vector3()),
    };
    this.startRoot = c.rig.root.position.clone();
  }

  /** Swing the outer... no: swing the far leg over the seat and sit down. */
  mountPose(dt) {
    const c = this.c, b = this.bike, rig = c.rig, s = rig.scale, T = b.T;
    const D = 0.95, u = clamp(this.t / D, 0, 1);
    b.holdUpright(0.3, lerp(b.standDown ? 0.2 : 0, 0.04, smooth01(u)));
    const e = smooth01(u);
    rig.resetPose();
    // root: from standing beside the bike to the saddle, lifting while the leg swings over
    const seat = b.model.seat;
    const sit = b.localToWorld(_v.set(0, seat.y - rig.L.hipsY * s * 0.97, seat.z), new THREE.Vector3());
    rig.root.position.copy(this.startRoot).lerp(sit, e);
    rig.root.position.y += Math.sin(Math.PI * u) * 0.12;
    b.forward(_f);
    quatFromYaw(Math.atan2(_f.x, _f.z), _q);
    rig.root.quaternion.copy(_q).slerp(b.curQuat, e);
    const near = this.side > 0 ? 'L' : 'R', far = this.side > 0 ? 'R' : 'L';
    _e.set(T.riderLean * 0.42 * e, -this.side * 0.45 * Math.sin(Math.PI * u), 0, 'XYZ');
    rig.bones.hips.quaternion.setFromEuler(_e);
    _e.set(T.riderLean * 0.3 * e + 0.15 * Math.sin(Math.PI * u), this.side * 0.25 * Math.sin(Math.PI * u), 0, 'XYZ');
    rig.bones.spine.quaternion.setFromEuler(_e);
    rig.root.updateMatrixWorld(true);
    c.bikeFwd = c.bikeFwd || new THREE.Vector3();
    c.bikeLeft = c.bikeLeft || new THREE.Vector3();
    c.bikeFwd.copy(_f);
    c.bikeLeft.set(1, 0, 0).applyQuaternion(b.curQuat);
    // near leg stays planted, then steps to the foot-down spot
    _v2.copy(this.feet[near]);
    _v2.y += rig.L.ankle;
    if (u > 0.7) {
      b.localToWorld(_v3.set(this.side * 0.36 * s, 0, seat.z + 0.12), _v3);
      _v3.y = groundY(this.game, _v3, b.body) + rig.L.ankle;
      _v2.lerp(_v3, smooth01((u - 0.7) / 0.3));
    }
    legIK(c, near, _v2, this.side);
    footFlat(c, near, b, 0);
    // far leg: lifted behind the saddle and over to the other side
    const p0 = _v3.copy(this.feet[far]);
    p0.y += rig.L.ankle;
    const apex = b.localToWorld(_v.set(0, seat.y + 0.4, seat.z - 0.5), new THREE.Vector3());
    const p2 = b.localToWorld(_v.set(-this.side * 0.36 * s, 0, seat.z + 0.12), new THREE.Vector3());
    p2.y = groundY(this.game, p2, b.body) + rig.L.ankle;
    const k = smooth01(clamp((u - 0.1) / 0.75, 0, 1));
    const a = 1 - k;
    _v2.set(a * a * p0.x + 2 * a * k * apex.x + k * k * p2.x, a * a * p0.y + 2 * a * k * apex.y + k * k * p2.y, a * a * p0.z + 2 * a * k * apex.z + k * k * p2.z);
    legIK(c, far, _v2, -this.side);
    footFlat(c, far, b, -0.3 * Math.sin(Math.PI * k));
    // hands to the grips: the near one first, the far one once the leg is over the saddle
    for (const [arm, side] of [['L', 1], ['R', -1]]) {
      const hw = side === this.side ? smooth01(clamp(u / 0.3, 0, 1)) : smooth01(clamp((u - 0.45) / 0.4, 0, 1));
      gripWrist(b, side, _v2);
      gripQuat(b, side, _q);
      _pole.copy(c.bikeLeft).multiplyScalar(side * 0.8).addScaledVector(_Y, -0.6);
      c.setHand(arm, _v2, hw, _q, _pole, 0.9);
    }
    c.helmetOn = true;
    c.pos.copy(rig.root.position);
    if (u >= 1) {
      this.done = true;
      c.seq = null;
      c.clearHands();
      c.enterVehicleInstant(b, 1);
      b.standDown = false;
      this.game.onEnteredVehicle?.(c, b);
    }
  }
}

function d0(c, p) { return Math.hypot(p.x - c.pos.x, p.z - c.pos.z); }

/** Is there room to stand on that side of the bike (+1 left, -1 right)? */
function bikeSideClear(game, b, side) {
  _v3.set(side, 0, 0).applyQuaternion(b.curQuat);
  const from = b.localToWorld(_v.set(0, 0.9, b.model.seat.z), new THREE.Vector3());
  return !game.physics.raycast(from, _v3, 1.0, groups(G.ALL, G.STATIC | G.CAR), b.body);
}

/* ================================================================== get off */
export class BikeDismount {
  constructor(game, ch, bike) {
    this.game = game;
    this.c = ch;
    this.bike = bike;
    this.isBikeSeq = true;
    this.t = 0;
    this.done = false;
    this.side = 1;
    ch.seq = this;
    ch.state = 'seq';
    ch.driveBy = null;
    if (bike.speed > 6.5) { this.bail(); return; }
    this.phase = bike.speed > 0.4 ? 'stop' : 'off';
    if (this.phase === 'off') this.begin();
  }

  abort() {
    if (this.done) return;
    this.finish();
  }

  bail() {
    const c = this.c, b = this.bike, g = this.game;
    const vel = b.linvel(new THREE.Vector3()).multiplyScalar(0.9);
    vel.add(_v.set(1.8, 1.3, 0).applyQuaternion(b.curQuat));
    c.leaveVehicleInstant();
    c.state = 'foot';
    c.seq = null;
    c.clearHands();
    b.standDown = false;
    this.done = true;
    c.rig.root.updateMatrixWorld(true);
    c.ignoreVeh = b;
    c.ignoreVehUntil = g.physics.time + 0.45;
    c.toRagdoll(vel, { spin: 2 });
    c.damage(Math.max(0, b.speed - 8) * 2, 'bail');
    g.onExitedVehicle?.(c, b);
  }

  begin() {
    const c = this.c, b = this.bike;
    this.phase = 'off';
    this.t = 0;
    b.input.throttle = 0; b.input.brake = 0; b.input.steer = 0;
    c.leaveVehicleInstant();
    c.rig.root.updateMatrixWorld(true);
    this.sat = c.rig.root.position.clone();
    b.standDown = true;
    // the side to step off: left unless blocked
    this.side = bikeSideClear(this.game, b, 1) ? 1 : -1;
  }

  finish() {
    const c = this.c, b = this.bike;
    this.done = true;
    c.seq = null;
    c.clearHands();
    if (c.vehicle === b) c.leaveVehicleInstant();
    c.state = 'foot';
    const stand = b.localToWorld(_v.set(this.side * 0.62, 0, b.model.seat.z + 0.05), new THREE.Vector3());
    stand.y = groundY(this.game, stand, b.body);
    c.teleport(stand, c.yaw);
    c.setCapsuleEnabled(true);
    c.helmetT = 0.5;
    b.holdUpright(0.4, 0.2);
    this.game.onExitedVehicle?.(c, b);
  }

  update(dt) {
    if (this.done) return;
    const c = this.c, b = this.bike;
    this.t += dt;
    if (b.removed) { this.finish(); return; }
    if (this.phase === 'stop') {
      // brake to a standstill first (still riding)
      b.input.throttle = 0; b.input.brake = 1; b.input.steer = 0; b.input.handbrake = false;
      bikeRiderPose(c, b, dt);
      if (b.speed < 0.4 || this.t > 3) this.begin();
      return;
    }
    // off: swing the leg back over and stand beside the bike
    const rig = c.rig, s = rig.scale, T = b.T;
    const D = 0.9, u = clamp(this.t / D, 0, 1), e = smooth01(u);
    b.holdUpright(0.3, lerp(0.04, 0.2, e));
    rig.resetPose();
    const stand = b.localToWorld(_v.set(this.side * 0.62, 0, b.model.seat.z + 0.05), new THREE.Vector3());
    stand.y = groundY(this.game, stand, b.body);
    b.forward(_f);
    const yaw = Math.atan2(_f.x, _f.z);
    rig.root.position.copy(this.sat).lerp(stand, e);
    rig.root.position.y += Math.sin(Math.PI * u) * 0.12;
    quatFromYaw(yaw, _q);
    rig.root.quaternion.copy(b.curQuat).slerp(_q, e);
    _e.set(T.riderLean * 0.42 * (1 - e), -this.side * 0.45 * Math.sin(Math.PI * u), 0, 'XYZ');
    rig.bones.hips.quaternion.setFromEuler(_e);
    rig.root.updateMatrixWorld(true);
    c.bikeFwd = c.bikeFwd || new THREE.Vector3();
    c.bikeLeft = c.bikeLeft || new THREE.Vector3();
    c.bikeFwd.copy(_f);
    c.bikeLeft.set(1, 0, 0).applyQuaternion(b.curQuat);
    const near = this.side > 0 ? 'L' : 'R', far = this.side > 0 ? 'R' : 'L';
    // near foot on the ground beside the bike
    const nearP = b.localToWorld(_v2.set(this.side * 0.36 * s, 0, b.model.seat.z + 0.12), new THREE.Vector3());
    nearP.y = groundY(this.game, nearP, b.body) + rig.L.ankle;
    const nearEnd = _v3.copy(stand).addScaledVector(c.bikeLeft, this.side * 0.11);
    nearEnd.y = stand.y + rig.L.ankle;
    nearP.lerp(nearEnd, smooth01(clamp((u - 0.55) / 0.45, 0, 1)));
    legIK(c, near, nearP, this.side);
    footFlat(c, near, b, 0);
    // far leg comes back over the saddle
    const p0 = b.localToWorld(_v.set(-this.side * 0.36 * s, 0, b.model.seat.z + 0.12), new THREE.Vector3());
    p0.y = groundY(this.game, p0, b.body) + rig.L.ankle;
    const apex = b.localToWorld(_v.set(0, b.model.seat.y + 0.4, b.model.seat.z - 0.5), new THREE.Vector3());
    const p2 = stand.clone().addScaledVector(c.bikeLeft, -this.side * 0.11);
    p2.y = stand.y + rig.L.ankle;
    const k = smooth01(clamp(u / 0.8, 0, 1)), a = 1 - k;
    _v2.set(a * a * p0.x + 2 * a * k * apex.x + k * k * p2.x, a * a * p0.y + 2 * a * k * apex.y + k * k * p2.y, a * a * p0.z + 2 * a * k * apex.z + k * k * p2.z);
    legIK(c, far, _v2, -this.side);
    footFlat(c, far, b, -0.3 * Math.sin(Math.PI * k));
    // hands leave the grips at the end
    const hw = 1 - smooth01(clamp((u - 0.6) / 0.4, 0, 1));
    for (const [arm, side] of [['L', 1], ['R', -1]]) {
      gripWrist(b, side, _v2);
      gripQuat(b, side, _q);
      _pole.copy(c.bikeLeft).multiplyScalar(side * 0.8).addScaledVector(_Y, -0.6);
      c.setHand(arm, _v2, hw, _q, _pole, 0.9);
    }
    c.helmetOn = true;
    c.pos.copy(rig.root.position);
    c.yaw = yaw;
    if (u >= 1) this.finish();
  }
}

export { approach };
