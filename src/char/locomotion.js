import * as THREE from 'three';
import { clamp, lerp, damp, dampAngle, invLerp, smooth01, wrapAngle, approach, quatFromYaw, UP } from '../core/util.js';
import { solveTwoBone, setWorldQuat } from './ik.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _hipW = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qShin = new THREE.Quaternion();
const _e = new THREE.Euler();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _qLook = new THREE.Quaternion();

// gait cycle time (two steps) by speed: measured human cadence, ~116 steps/min walking,
// ~178 jogging/running, ~196 sprinting
const CYCLE = [[0, 1.16], [1.0, 1.12], [1.45, 1.03], [2.2, 0.86], [3.0, 0.76], [4.3, 0.70], [5.1, 0.674], [7.6, 0.612], [10, 0.58]];
function cycleTime(sp) {
  for (let i = 1; i < CYCLE.length; i++) {
    if (sp <= CYCLE[i][0]) {
      const [a, ta] = CYCLE[i - 1], [b, tb] = CYCLE[i];
      return lerp(ta, tb, (sp - a) / (b - a));
    }
  }
  return CYCLE[CYCLE.length - 1][1];
}

function mkFoot(side) {
  return {
    side, // +1 = left (+X local), -1 = right
    pos: new THREE.Vector3(),
    from: new THREE.Vector3(),
    target: new THREE.Vector3(),
    yaw: 0, yawFrom: 0,
    swing: false, u: 0, dur: 0.4, lift: 0.1, liftAmt: 0, relFrom: new THREE.Vector3(),
    pitch: 0, pitch0: 0, idleStep: false, lastFp: 0, fp: 0, locked: false, landT: 1, groundT: 0,
  };
}

/**
 * Procedural locomotion with planted feet. Drives the rig of a Character that exposes:
 * pos (ground point), yaw, vel (horizontal), grounded, vy, lookYaw, lookPitch, groundAt(x,z,y)
 */
export class Locomotion {
  constructor(char) {
    this.c = char;
    this.rig = char.rig;
    this.phase = 0;
    this.feet = [mkFoot(1), mkFoot(-1)];
    this.hipsY = this.rig.L.hipsY;
    this.speed = 0;
    this.lean = 0;
    this.bank = 0;
    this.prevYaw = 0;
    this.prevSpeed = 0;
    this.airW = 0;
    this.landComp = 0;
    this.wasGrounded = true;
    this.initialized = false;
    this.idleTimer = 0;
    this.time = Math.random() * 10;
    this.moving = false;
    this.armSwing = 0;
    this.runT = 0;
    this.stepLen = 0.7;
  }

  /** Plant both feet where the rig's foot bones currently are. */
  plantFromCurrent() {
    const c = this.c;
    this.rig.root.updateMatrixWorld(true);
    for (const f of this.feet) {
      const b = this.rig.bones[f.side > 0 ? 'footL' : 'footR'];
      b.getWorldPosition(_v);
      f.pos.set(_v.x, c.groundAt(_v.x, _v.z, c.pos.y), _v.z);
      f.yaw = c.yaw;
      f.swing = false;
      f.u = 0;
      f.pitch = 0;
      f.liftAmt = 0;
    }
    this.hipsY = this.rig.bones.hips.getWorldPosition(_v).y - c.pos.y;
    this.initialized = true;
    this.prevYaw = c.yaw;
  }

  idealPos(f, out) {
    const c = this.c, s = this.rig.scale;
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    // left = (cos, 0, -sin)
    const w = 0.105 * s;
    out.set(c.pos.x + cy * w * f.side + sy * 0.02 * s, c.pos.y, c.pos.z - sy * w * f.side + cy * 0.02 * s);
    out.y = c.groundAt(out.x, out.z, c.pos.y);
    return out;
  }

  startSwing(f, dur, idle = false, lift = 0.1) {
    f.swing = true;
    f.u = 0;
    f.dur = Math.max(0.12, dur);
    f.from.copy(f.pos);
    f.relFrom.set(f.pos.x - this.c.pos.x, 0, f.pos.z - this.c.pos.z);
    f.yawFrom = f.yaw;
    f.idleStep = idle;
    f.lift = lift * this.rig.scale;
    f.pitch0 = f.pitch;
    f.locked = false;
    f.u0 = 0;
    f.bodySpace = false;
  }

  update(dt) {
    const c = this.c, rig = this.rig, L = rig.L, s = rig.scale;
    if (!this.initialized) this.plantFromCurrent();
    this.time += dt;
    const vx = c.vel.x, vz = c.vel.z;
    const v = Math.hypot(vx, vz);
    this.speed = damp(this.speed, v, 12, dt);
    const sp = this.speed;
    const accel = (sp - this.prevSpeed) / Math.max(dt, 1e-4);
    this.prevSpeed = sp;
    const fwdX = Math.sin(c.yaw), fwdZ = Math.cos(c.yaw);
    const leftX = Math.cos(c.yaw), leftZ = -Math.sin(c.yaw);
    const moving = v > 0.25 && c.grounded;
    const legScale = Math.sqrt(L.leg / 0.87);
    const runT = invLerp(2.0, 4.2, sp);
    this.runT = runT;
    const Tc = cycleTime(sp) * legScale;
    // swing share of the cycle: 40% walking, ~70% running (flight phases), ~79% sprinting
    const sw = lerp(0.4, 0.7, runT) + 0.09 * invLerp(5.0, 7.6, sp);
    const swingDur = sw * Tc;
    const stanceDur = (1 - sw) * Tc;
    this.stepLen = Math.max(0.3, sp * Tc * 0.5);

    // ---------------------------------------------------- airborne handling
    if (!c.grounded) {
      this.airW = approach(this.airW, 1, dt * 5);
    } else if (!this.wasGrounded) {
      // landing: plant feet at current positions
      this.rig.root.updateMatrixWorld(true);
      for (const f of this.feet) {
        rig.bones[f.side > 0 ? 'footL' : 'footR'].getWorldPosition(_v);
        f.pos.set(_v.x, c.groundAt(_v.x, _v.z, c.pos.y), _v.z);
        f.swing = false;
        f.yaw = c.yaw;
      }
      this.landComp = clamp(c.landSpeed * 0.022, 0.03, 0.22) * s;
      if (c.onFootstep) { c.onFootstep(this.feet[0], 1.5); }
    }
    if (c.grounded) this.airW = approach(this.airW, 0, dt * 8);
    this.wasGrounded = c.grounded;

    // ---------------------------------------------------- gait phase & swing triggering
    if (moving) {
      if (!this.moving) {
        // start walking: the foot that is most behind relative to velocity lifts first
        const dl = (this.feet[0].pos.x - c.pos.x) * vx + (this.feet[0].pos.z - c.pos.z) * vz;
        const dr = (this.feet[1].pos.x - c.pos.x) * vx + (this.feet[1].pos.z - c.pos.z) * vz;
        const first = dl < dr ? 0 : 1;
        this.phase = first === 0 ? 0.999 : 0.499;
        for (const f of this.feet) f.lastFp = (this.phase + (f.side > 0 ? 0 : 0.5)) % 1;
      }
      this.phase = (this.phase + dt / Tc) % 1;
      for (const f of this.feet) {
        const fp = (this.phase + (f.side > 0 ? 0 : 0.5)) % 1;
        if (fp < f.lastFp) {
          // each foot lifts exactly once per cycle and its swing progress is read from the phase,
          // so the two legs always stay half a cycle apart (no limping after a rescue step)
          if (!f.swing || f.idleStep || !f.locked) this.startSwing(f, swingDur, false, lerp(0.12, 0.32, runT) + clamp((sp - 5.5) * 0.04, 0, 0.08));
          f.locked = true;
        }
        f.lastFp = fp;
        f.fp = fp;
        if (f.swing && f.locked) { f.u = Math.min(1, fp / sw); f.dur = swingDur; }
      }
    }
    this.moving = moving;

    // ---------------------------------------------------- idle corrective steps
    const anySwing = this.feet[0].swing || this.feet[1].swing;
    if (!moving && c.grounded && !anySwing) {
      this.idleTimer += dt;
      let worst = null, worstErr = 0;
      for (const f of this.feet) {
        this.idealPos(f, _v);
        const err = Math.hypot(f.pos.x - _v.x, f.pos.z - _v.z) + Math.abs(wrapAngle(f.yaw - c.yaw)) * 0.22 * s;
        if (err > worstErr) { worstErr = err; worst = f; }
      }
      if (worst && worstErr > 0.13 * s && this.idleTimer > 0.08) {
        this.startSwing(worst, 0.3 * legScale, true, 0.075);
        this.idleTimer = 0;
      }
    } else this.idleTimer = 0;

    // ---------------------------------------------------- feet update
    const maxReach = L.leg * 0.98;
    for (const f of this.feet) {
      if (!c.grounded) {
        f.liftAmt = 0;
        continue;
      }
      if (f.swing) {
        if (!(f.locked && moving)) f.u += dt / f.dur;
        const u = Math.min(f.u, 1);
        if (f.idleStep || !moving) {
          // stopping mid-stride: carry on from where the foot is now instead of the lift-off spot
          if (f.bodySpace) { f.bodySpace = false; f.from.copy(f.pos); f.u0 = u; }
          this.idealPos(f, f.target);
          const e = smooth01(clamp((u - f.u0) / Math.max(1e-3, 1 - f.u0), 0, 1));
          f.pos.x = lerp(f.from.x, f.target.x, e);
          f.pos.z = lerp(f.from.z, f.target.z, e);
          f.pos.y = lerp(f.from.y, f.target.y, e);
        } else {
          // The swing is a pendulum relative to the hips: it starts where the foot left the ground
          // (behind the body) and ends at the touchdown spot ahead of it. Interpolating in body
          // space keeps the foot from shooting forward early and hovering in front of the body.
          const remaining = (1 - u) * f.dur;
          const land = stanceDur * lerp(0.46, 0.37, runT);
          const w = lerp(0.105, 0.07, runT) * s;
          const rx = vx * land + leftX * w * f.side, rz = vz * land + leftZ * w * f.side;
          f.target.set(c.pos.x + vx * remaining + rx, c.pos.y, c.pos.z + vz * remaining + rz);
          f.target.y = c.groundAt(f.target.x, f.target.z, c.pos.y);
          // running: the heel kicks up behind first, then the knee drives through
          const d0 = lerp(0, 0.14, runT), d1 = lerp(0.05, 0.1, runT);
          const e = smooth01(clamp((u - d0) / (1 - d0 - d1), 0, 1));
          f.pos.x = c.pos.x + lerp(f.relFrom.x, rx, e);
          f.pos.z = c.pos.z + lerp(f.relFrom.z, rz, e);
          f.pos.y = lerp(f.from.y, f.target.y, smooth01(u));
          f.bodySpace = true;
        }
        // foot height peaks early in the swing (heel lifts behind, then the foot passes low)
        const uk = Math.pow(Math.min(1, u * 1.05), f.idleStep ? 1 : lerp(0.62, 0.7, runT));
        const liftShape = Math.sin(Math.PI * uk);
        f.liftAmt = f.lift * Math.pow(Math.max(0, liftShape), 0.8) + Math.max(0, (f.target.y - f.from.y)) * 0.0;
        f.yaw = f.yawFrom + wrapAngle(c.yaw - f.yawFrom) * smooth01(Math.min(1, u * 1.3));
        const mw = Math.min(1, sp / 1.5);
        // toe-down after push-off, toe-up for the heel strike (runners land flatter)
        f.pitch = f.idleStep ? 0 : (Math.max(0.5, f.pitch0) * (1 - u) * (1 - u) - lerp(0.32, 0.1, runT) * u * u) * mw;
        if (f.u >= 1) {
          f.swing = false;
          f.locked = false;
          f.target.copy(f.pos); // (equal at u=1, except right after a mid-stride stop)
          f.liftAmt = 0;
          f.landT = 0;
          if (c.onFootstep) c.onFootstep(f, lerp(0.5, 1.0, runT));
        }
      } else {
        f.landT += dt;
        // emergency step if the planted foot is out of reach
        _hipW.set(c.pos.x + leftX * L.hipX * f.side, 0, c.pos.z + leftZ * L.hipX * f.side);
        const hd = Math.hypot(f.pos.x - _hipW.x, f.pos.z - _hipW.z);
        // (while moving the gait phase lifts the foot itself; only a foot left far behind - after
        // a stumble or a sharp turn - needs a rescue step, and it would otherwise desync the legs)
        if (hd > maxReach * (moving ? 0.97 : 0.72) || Math.abs(f.pos.y - c.pos.y) > 0.5) {
          this.startSwing(f, moving ? Math.min(swingDur, 0.3) : 0.22, !moving, moving ? 0.18 : 0.12);
        }
        // heel-off: when the foot trails behind the body the heel rolls up over the toes
        if (moving) {
          const rel = ((f.pos.x - c.pos.x) * fwdX + (f.pos.z - c.pos.z) * fwdZ) / (this.stepLen + 1e-3);
          let target = clamp((-rel - 0.25) * lerp(1.0, 1.6, runT), 0, lerp(0.55, 0.85, runT));
          // by stance progress: walkers roll off the heel late, runners are up on the forefoot early
          const st = f.fp >= sw ? (f.fp - sw) / (1 - sw) : 0;
          const s0 = lerp(0.5, 0.25, runT);
          target = Math.max(target, lerp(0.6, 0.95, runT) * smooth01((st - s0) / (1 - s0)));
          f.pitch = damp(f.pitch, target, 25, dt);
        } else {
          f.pitch = damp(f.pitch, 0, 14, dt);
        }
        // heel strike flattening right after landing
        if (f.landT < 0.12 && f.pitch < 0) f.pitch = damp(f.pitch, 0, 30, dt);
      }
    }

    // ---------------------------------------------------- ankle targets for grounded feet
    for (const f of this.feet) {
      if (!f.ankle) f.ankle = new THREE.Vector3();
      const fyX = Math.sin(f.yaw), fyZ = Math.cos(f.yaw);
      const beta = f.pitch;
      if (!f.swing && beta > 0.001) {
        // heel-off: pivot around the toes
        const t = L.footFwd, a = L.ankle;
        const toeX = f.pos.x + fyX * t, toeZ = f.pos.z + fyZ * t;
        const up = a * Math.cos(beta) + t * Math.sin(beta);
        const fw = a * Math.sin(beta) - t * Math.cos(beta);
        f.ankle.set(toeX + fyX * fw, f.pos.y + up, toeZ + fyZ * fw);
      } else {
        f.ankle.set(f.pos.x, f.pos.y + L.ankle + f.liftAmt, f.pos.z);
      }
    }

    // ---------------------------------------------------- body lean / bank
    const yawRate = wrapAngle(c.yaw - this.prevYaw) / Math.max(dt, 1e-4);
    this.prevYaw = c.yaw;
    this.lean = damp(this.lean, clamp(sp * 0.018 + accel * 0.022, -0.12, 0.3), 5, dt);
    this.bank = damp(this.bank, clamp(-yawRate * sp * 0.035, -0.28, 0.28), 6, dt);

    // ---------------------------------------------------- pelvis
    rig.resetPose();
    const moveW = Math.min(1, sp / 1.2);
    const bobA = lerp(0.022, -0.045, runT) * moveW * s;
    const bob = bobA * Math.cos(4 * Math.PI * (this.phase - sw / 2));
    const sway = -lerp(0.022, 0.008, runT) * moveW * s * Math.cos(2 * Math.PI * (this.phase - sw / 2));
    // forward offsets of the feet relative to the hips (normalized)
    const norm = Math.max(0.3, this.stepLen * 0.42);
    const fl = clamp(((this.feet[0].pos.x - c.pos.x) * fwdX + (this.feet[0].pos.z - c.pos.z) * fwdZ) / norm, -1.3, 1.3);
    const fr = clamp(((this.feet[1].pos.x - c.pos.x) * fwdX + (this.feet[1].pos.z - c.pos.z) * fwdZ) / norm, -1.3, 1.3);
    const pelvisYaw = clamp(-(fl - fr) * lerp(0.09, 0.14, runT) * moveW, -0.25, 0.25);
    const swL = this.feet[0].swing ? Math.sin(Math.PI * Math.min(1, this.feet[0].u)) : 0;
    const swR = this.feet[1].swing ? Math.sin(Math.PI * Math.min(1, this.feet[1].u)) : 0;
    const pelvisRoll = (-swL + swR) * 0.05 * (1 - runT * 0.5) * moveW;

    this.landComp = damp(this.landComp, 0, 7, dt);
    let desiredH = L.hipsY * (1 - 0.035 * runT) + bob - this.landComp - (c.crouch || 0) * 0.35 * s;
    // keep both planted feet within reach
    const maxHipsFor = (f, reachK) => {
      const hx = c.pos.x + leftX * L.hipX * f.side - fwdX * this.lean * 0.12 * s;
      const hz = c.pos.z + leftZ * L.hipX * f.side - fwdZ * this.lean * 0.12 * s;
      const h = Math.hypot(f.ankle.x - hx, f.ankle.z - hz);
      const reach = L.leg * reachK;
      return f.ankle.y + Math.sqrt(Math.max(0, reach * reach - h * h)) + (L.hipsY - L.hipJointY) - c.pos.y;
    };
    if (c.grounded) {
      for (const f of this.feet) {
        if (!f.swing || f.u > 0.85) desiredH = Math.min(desiredH, maxHipsFor(f, 0.985));
      }
    }
    this.hipsY = damp(this.hipsY, desiredH, c.grounded ? 22 : 8, dt);
    if (c.grounded) {
      // hard clamp for the stance legs
      for (const f of this.feet) if (!f.swing) this.hipsY = Math.min(this.hipsY, maxHipsFor(f, 0.999));
    }
    // airborne legs tuck
    const air = this.airW;
    rig.root.position.copy(c.pos);
    rig.root.quaternion.copy(quatFromYaw(c.yaw, _qa));
    rig.root.updateMatrixWorld(true);
    _v.set(
      c.pos.x - leftX * sway,
      c.pos.y + this.hipsY + air * 0.04 * s,
      c.pos.z - leftZ * sway,
    );
    // shift hips back a bit when running fast leaning forward
    _v.x -= fwdX * this.lean * 0.12 * s;
    _v.z -= fwdZ * this.lean * 0.12 * s;
    rig.root.worldToLocal(_v);
    rig.bones.hips.position.copy(_v);
    _e.set(this.lean * 0.5 + air * -0.1, pelvisYaw, pelvisRoll + this.bank, 'YXZ');
    rig.bones.hips.quaternion.setFromEuler(_e);
    const breathe = Math.sin(this.time * 1.7) * 0.012 * (1 - moveW);
    _e.set(this.lean * 0.45 + breathe, -pelvisYaw * 0.45, -pelvisRoll * 0.5, 'YXZ');
    rig.bones.spine.quaternion.setFromEuler(_e);
    _e.set(this.lean * 0.25 - breathe * 0.5 + air * 0.1, -pelvisYaw * 0.55, -this.bank * 0.4, 'YXZ');
    rig.bones.chest.quaternion.setFromEuler(_e);
    rig.root.updateMatrixWorld(true);

    // ---------------------------------------------------- legs IK
    for (const f of this.feet) {
      const thigh = rig.bones[f.side > 0 ? 'thighL' : 'thighR'];
      const shin = rig.bones[f.side > 0 ? 'shinL' : 'shinR'];
      const foot = rig.bones[f.side > 0 ? 'footL' : 'footR'];
      const fyX = Math.sin(f.yaw), fyZ = Math.cos(f.yaw);
      if (air > 0.001) {
        // tucked / running-in-air legs relative to the hips
        rig.bones.hips.getWorldPosition(_hipW);
        const legPhase = f.side > 0 ? 1 : -1;
        const ax = _hipW.x + leftX * L.hipX * f.side * 1.1 + fwdX * 0.16 * s * legPhase;
        const az = _hipW.z + leftZ * L.hipX * f.side * 1.1 + fwdZ * 0.16 * s * legPhase;
        const ay = _hipW.y - L.leg * (0.86 - 0.08 * legPhase);
        const gx = f.pos.x, gy = f.pos.y + L.ankle + f.liftAmt, gz = f.pos.z;
        _ankle.set(lerp(gx, ax, air), lerp(gy, ay, air), lerp(gz, az, air));
        if (!c.grounded) { f.pos.set(_ankle.x, _ankle.y - L.ankle, _ankle.z); }
      } else {
        _ankle.copy(f.ankle);
      }
      _pole.set(fwdX * 0.9 + fyX * 0.3 + leftX * f.side * 0.18, 0.05, fwdZ * 0.9 + fyZ * 0.3 + leftZ * f.side * 0.18);
      solveTwoBone(thigh, shin, _ankle, _pole, 1, L.thigh, L.shin, 1, _qShin);
      // foot orientation
      quatFromYaw(f.yaw, _qa);
      _qb.setFromAxisAngle(_xAxis, air > 0.5 ? 0.35 : f.pitch);
      _qa.multiply(_qb);
      foot.quaternion.copy(_qShin).invert().multiply(_qa);
    }

    // ---------------------------------------------------- arms (FK)
    const runArm = runT;
    const amp = lerp(0.36, 0.76, runArm) * moveW;
    const swingL = clamp(-amp * fr, -1.0, 0.85);
    const swingR = clamp(-amp * fl, -1.0, 0.85);
    const elbowBase = lerp(0.22, 1.45, runArm);
    const idleSway = Math.sin(this.time * 1.3) * 0.02 * (1 - moveW);
    const armOut = lerp(0.1, 0.16, runArm) + air * 0.5;
    this.setArm('L', swingL - air * 0.5 + idleSway, armOut, elbowBase + Math.max(0, -swingL) * 0.35 + air * 0.4);
    this.setArm('R', swingR - air * 0.5 - idleSway, armOut, elbowBase + Math.max(0, -swingR) * 0.35 + air * 0.4);
    const curl = lerp(0.35, 1.3, runArm);
    rig.bones.fingersL.quaternion.setFromAxisAngle(_v.set(0, 0, 1), -curl);
    rig.bones.fingersR.quaternion.setFromAxisAngle(_v.set(0, 0, 1), curl);

    // ---------------------------------------------------- head stabilization / look
    this.lookAt(dt);
  }

  setArm(side, swing, out, elbow) {
    const rig = this.rig;
    const sx = side === 'L' ? 1 : -1;
    _e.set(swing, 0, out * sx, 'XYZ');
    rig.bones['upperArm' + side].quaternion.setFromEuler(_e);
    _e.set(-elbow, sx * 0.25, 0, 'XYZ');
    rig.bones['forearm' + side].quaternion.setFromEuler(_e);
    _e.set(0.1, 0, sx * -0.08, 'XYZ');
    rig.bones['hand' + side].quaternion.setFromEuler(_e);
  }

  lookAt(dt) {
    const c = this.c, rig = this.rig;
    this.lookYawS = damp(this.lookYawS || 0, clamp(c.lookYaw || 0, -1.2, 1.2), 6, dt);
    this.lookPitchS = damp(this.lookPitchS || 0, clamp(c.lookPitch || 0, -0.6, 0.5), 6, dt);
    rig.root.updateMatrixWorld(true);
    quatFromYaw(c.yaw + this.lookYawS, _qa);
    _qb.setFromAxisAngle(_xAxis, this.lookPitchS + this.lean * 0.3);
    _qa.multiply(_qb);
    // split between neck and head
    const neck = rig.bones.neck, head = rig.bones.head;
    neck.parent.getWorldQuaternion(_qb);
    _qLook.copy(_qa);
    _qb.invert().multiply(_qLook);
    neck.quaternion.identity().slerp(_qb, 0.45);
    setWorldQuat(head, _qLook);
  }
}

export { UP };
