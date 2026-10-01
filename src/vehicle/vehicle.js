import * as THREE from 'three';
import { R, G, groups } from '../core/physics.js';
import { clamp, lerp, damp, approach, smoothstep, invLerp } from '../core/util.js';
import { buildCarModel, CAR_TYPES } from './carModel.js';

const SURFACE_GRIP = { asphalt: 1.0, concrete: 0.95, metal: 0.85, wood: 0.85, grass: 0.62, sand: 0.55, dirt: 0.65, flesh: 0.6, car: 0.7 };
// grip lost when the surface is fully wet
const WET_LOSS = { asphalt: 0.28, concrete: 0.3, metal: 0.38, wood: 0.32, grass: 0.2, sand: 0.06, dirt: 0.3, flesh: 0.1, car: 0.3 };

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _n = new THREE.Vector3();
const _F = new THREE.Vector3();
const _P = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _qw = new THREE.Quaternion();
const _qAxle = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const _P2 = new THREE.Vector3();

let VEH_ID = 1;

export class Vehicle {
  constructor(game, type, color, pos, yaw, opts = {}) {
    this.id = VEH_ID++;
    this.game = game;
    this.physics = game.physics;
    this.type = type;
    this.T = CAR_TYPES[type];
    const T = this.T;
    this.color = color || T.colors[Math.floor(Math.random() * T.colors.length)];
    this.model = buildCarModel(type, this.color, { seed: this.id * 7919 });
    this.root = this.model.root;
    game.scene.add(this.root);
    this.halfW = this.model.halfW;
    this.halfL = this.model.halfL;
    this.height = T.roofY;

    // ---------------------------------------------------------------- physics body
    const m = T.mass;
    const L = T.length, W = T.width, H = T.roofY - T.bottomY;
    const Ixx = m / 12 * (H * H + L * L) * 0.9;
    const Iyy = m / 12 * (W * W + L * L) * 0.95;
    const Izz = m / 12 * (W * W + H * H) * 0.9;
    this.com = new THREE.Vector3(0, T.bottomY + (T.beltY - T.bottomY) * 0.38, T.wheelOffset * 0.5 + 0.05);
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setAdditionalMassProperties(m, { x: this.com.x, y: this.com.y, z: this.com.z }, { x: Ixx, y: Iyy, z: Izz }, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.0)
      .setAngularDamping(0.25)
      .setCcdEnabled(true)
      .setCanSleep(true);
    if (opts.vel) desc.setLinvel(opts.vel.x, opts.vel.y, opts.vel.z);
    this.body = this.physics.world.createRigidBody(desc);
    this.colliders = [];
    const P = this.model.profile;
    const lowTop = T.beltY + 0.02, lowBot = T.bottomY + 0.07;
    const addBox = (hx, hy, hz, cx, cy, cz) => {
      const cd = R.ColliderDesc.roundCuboid(hx - 0.05, hy - 0.05, hz - 0.05, 0.05)
        .setTranslation(cx, cy, cz)
        .setDensity(0)
        .setFriction(0.3)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0.12)
        .setCollisionGroups(groups(G.CAR, G.ALL))
        .setSolverGroups(groups(G.CAR, G.ALL & ~G.CHAR))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(8000);
      const c = this.physics.world.createCollider(cd, this.body);
      this.physics.setOwner(c, { type: 'car', vehicle: this, surface: 'car' });
      this.colliders.push(c);
    };
    // main lower body, a slightly shorter nose/tail box and the cabin
    addBox(P.W * 0.98, (lowTop - lowBot) / 2, P.L - 0.22, 0, (lowTop + lowBot) / 2, 0);
    addBox(P.W * 0.86, (lowTop - lowBot) / 2 * 0.7, 0.3, 0, (lowTop + lowBot) / 2 - 0.02, P.L - 0.3 + 0.08);
    addBox(P.W * 0.86, (lowTop - lowBot) / 2 * 0.7, 0.3, 0, (lowTop + lowBot) / 2 - 0.02, -P.L + 0.3 - 0.08);
    const cabFront = (T.zWindBase + T.zRoofFront) / 2, cabRear = (T.zRearBase + T.zRoofRear) / 2;
    addBox(P.W * 0.82, (T.roofY - lowTop) / 2, (cabFront - cabRear) / 2, 0, (T.roofY + lowTop) / 2, (cabFront + cabRear) / 2);

    // ---------------------------------------------------------------- wheels / suspension
    const qMass = m / 4;
    const k = qMass * (2 * Math.PI * T.springHz) ** 2;
    this.k = k;
    this.cBump = 2 * T.damping * Math.sqrt(k * qMass);
    this.cRebound = this.cBump * 1.35;
    this.suspRest = T.suspTravel;
    const staticComp = (qMass * 9.81) / k;
    this.wheels = this.model.wheels.map((wm) => ({
      ...wm,
      r: T.wheelR,
      mountY: T.wheelR + this.suspRest - staticComp,
      comp: staticComp, lastComp: staticComp, grounded: false,
      Fz: qMass * 9.81, angVel: 0, spinAngle: 0, slipLat: 0, slipLong: 0,
      contact: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'asphalt', hitBody: null, visualY: T.wheelR,
      steer: 0, skidding: 0, lastSkidPos: null,
    }));

    // ---------------------------------------------------------------- drivetrain & state
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.steerAngle = 0;
    this.gear = 1;
    this.rpm = 900;
    this.shiftTimer = 0;
    this.reverse = false;
    this.speed = 0;
    this.fwdSpeed = 0;
    this.health = 100;
    this.engineOn = true;
    this.driver = null;
    this.ai = null;
    this.passengers = [];
    this.horn = false;
    this.lastImpact = 0;
    this.damageCooldown = 0;
    this.crashT = 0;
    this.crashPeak = 0;
    this.prevVel = new THREE.Vector3();
    this.accelLocal = new THREE.Vector3();
    this.prevPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.prevQuat = _q.clone();
    this.curPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.curQuat = _q.clone();
    this.brakeLight = 0;
    this.lightsOn = false;
    this.sirenOn = false;
    this.wheelSlip = 0;
    this.persistent = !!opts.persistent;
    this.removed = false;
    this.lastDriverTime = 0;
    this.syncVisual(1);
  }

  /* ---------------------------------------------------------------- helpers */
  get position() { return this.curPos; }
  get quaternion() { return this.curQuat; }

  localToWorld(local, out) {
    return out.copy(local).applyQuaternion(this.curQuat).add(this.curPos);
  }
  worldToLocal(world, out) {
    _qi.copy(this.curQuat).invert();
    return out.copy(world).sub(this.curPos).applyQuaternion(_qi);
  }
  velocityAt(world, out) {
    const v = this.body.velocityAtPoint({ x: world.x, y: world.y, z: world.z });
    return out.set(v.x, v.y, v.z);
  }
  linvel(out) {
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }
  forward(out) { return out.set(0, 0, 1).applyQuaternion(this.curQuat); }
  isUpsideDown() { return _up.set(0, 1, 0).applyQuaternion(this.curQuat).y < 0.3; }
  get occupied() { return !!this.driver; }

  /* ---------------------------------------------------------------- physics */
  prePhysics(h) {
    if (this.removed) return;
    const body = this.body;
    if (body.isSleeping()) {
      const inp = this.input;
      if (inp.throttle > 0.01 || inp.brake > 0.01 || this.driver === this.game.player) body.wakeUp();
      else return;
    }
    const T = this.T;
    const t = body.translation();
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const pos = _P.set(t.x, t.y, t.z);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q); // +x = car left
    const lv = body.linvel();
    const vel = _v2.set(lv.x, lv.y, lv.z);
    const vLongCar = vel.dot(_fwd);
    const vLatCar = vel.dot(_right);
    this.fwdSpeed = vLongCar;
    this.speed = vel.length();

    // ------------------------------------------------ inputs
    const inp = this.input;
    let throttle = clamp(inp.throttle, 0, 1);
    let brake = clamp(inp.brake, 0, 1);
    // automatic reverse: holding brake while (nearly) stopped engages reverse, throttle disengages it
    if (!this.reverse) {
      if (brake > 0.05 && throttle < 0.05 && vLongCar < 0.8) this.reverse = true;
    } else if (throttle > 0.05 && vLongCar > -1.0) this.reverse = false;
    if (this.reverse) { const t2 = brake; brake = throttle; throttle = t2; }
    if (!this.engineOn || this.health <= 0) throttle = 0;
    this.effThrottle = throttle;
    this.effBrake = brake;

    // handbrake "drift mode": full slide behaviour while pulled, fading out after release so a
    // handbrake-started drift can still be held on the throttle; without it the car grips more
    this.hbDrift = inp.handbrake ? 1 : Math.max(0, (this.hbDrift || 0) - h * 0.7);
    const dm = this.hbDrift;

    // ------------------------------------------------ steering
    const v = Math.abs(vLongCar);
    const maxSteer = T.steerMax / (1 + v * v / 520);
    let target = clamp(inp.steer, -1, 1) * maxSteer;
    // counter-steer assist when the body slides (player-friendly drifting)
    if (this.driver && (this.driver.isPlayer || this.driver.isCop) && v > 4) {
      const slip = Math.atan2(vLatCar, Math.max(1, Math.abs(vLongCar)));
      target = clamp(target + slip * 0.55 * Math.sign(vLongCar || 1), -T.steerMax, T.steerMax);
    }
    const rate = (Math.abs(target) < Math.abs(this.steerAngle) ? 4.5 : 2.8) * (1 + 0.6 * Math.abs(inp.steer));
    this.steerAngle = approach(this.steerAngle, target, rate * h);

    // ------------------------------------------------ engine / gearbox
    const gears = T.gears;
    if (this.shiftTimer > 0) this.shiftTimer -= h;
    const toRpm = (ratio) => Math.abs(vLongCar) / T.wheelR * ratio * T.finalDrive * 60 / (2 * Math.PI);
    const ratio = this.reverse ? 3.2 : gears[this.gear - 1];
    let rpm = toRpm(ratio);
    // driven-wheel flare when spinning the tyres
    const spinFlare = Math.max(0, (Math.abs(this.wheels[2].angVel + this.wheels[3].angVel) * 0.5 * T.wheelR - Math.abs(vLongCar)));
    rpm += spinFlare / T.wheelR * ratio * T.finalDrive * 60 / (2 * Math.PI) * 0.6;
    if (throttle > 0.05) rpm = Math.max(rpm, 1100 + throttle * 2400 * clamp(1 - Math.abs(vLongCar) / 12, 0, 1)); // clutch slip at launch
    this.rpm = damp(this.rpm, clamp(Math.max(rpm, 850), 850, T.redline + 200), 14, h);
    if (!this.reverse && this.shiftTimer <= 0) {
      const cur = toRpm(gears[this.gear - 1]);
      if (cur > T.redline - 250 && this.gear < gears.length) { this.gear++; this.shiftTimer = 0.2; }
      else if (this.gear > 1) {
        const lower = toRpm(gears[this.gear - 2]);
        const downAt = throttle > 0.6 ? 3600 : 2300;
        if (cur < downAt && lower < T.redline - 1300) { this.gear--; this.shiftTimer = 0.16; }
      }
    } else if (this.reverse) this.gear = 1;
    const curve = (x) => {
      const n = x / T.redline;
      return clamp(0.55 + 1.1 * n - 0.75 * n * n, 0.4, 1.0);
    };
    let engineTorque = throttle * T.torque * curve(this.rpm) * (this.health < 25 ? 0.55 : 1);
    if (this.rpm > T.redline) engineTorque = 0;
    if (this.shiftTimer > 0) engineTorque *= 0.15;
    const driveForceTotal = engineTorque * ratio * T.finalDrive * 0.86 / T.wheelR * (this.reverse ? -1 : 1);
    const engineBrake = throttle < 0.05 ? clamp(this.rpm / T.redline, 0, 1) * 900 * (this.reverse ? 0 : 1) : 0;

    // ------------------------------------------------ suspension: wheel-shaped casts
    // A rounded cylinder (the tyre) is swept down from the fully compressed position, so the
    // rubber itself meets curbs, ramps and bodies instead of a single ray under the hub.
    const P = this.physics;
    let grounded = 0;
    const filter = groups(G.ALL, G.STATIC | G.CAR | G.PROP | G.RAGDOLL);
    if (!this.wheelShape) {
      const r = T.wheelR, hh = T.wheelW * 0.36, b = 0.05;
      this.wheelShape = new R.RoundCylinder(hh - b, r - b, b);
    }
    // cylinder axis (local Y) -> car X
    _qw.copy(_q).multiply(_qAxle);
    const W = P.world;
    for (const w of this.wheels) {
      _mount.set(w.x, w.mountY, w.z).applyQuaternion(_q).add(pos);
      _v.copy(_up).negate();
      w.lastComp = w.comp;
      let found = false;
      const sh = W.castShape({ x: _mount.x, y: _mount.y, z: _mount.z }, { x: _qw.x, y: _qw.y, z: _qw.z, w: _qw.w },
        { x: _v.x, y: _v.y, z: _v.z }, this.wheelShape, 0.0, this.suspRest, false, undefined, filter, undefined, body);
      if (sh && sh.time_of_impact > 1e-4) {
        const t = sh.time_of_impact;
        // witness1/normal1 lie on the hit collider and are already in world space
        _P2.set(sh.witness1.x, sh.witness1.y, sh.witness1.z);
        _n.set(sh.normal1.x, sh.normal1.y, sh.normal1.z);
        w.comp = clamp(this.suspRest - t, 0, this.suspRest);
        w.contact.copy(_P2);
        // steep contacts (curb faces) lift the wheel but the tyre plane stays aligned with the body
        if (_n.dot(_up) < 0.5) _n.copy(_up);
        w.normal.copy(_n);
        found = true;
        w.hitCollider = sh.collider;
      } else {
        // fallback ray (also covers casts that start already touching something)
        const maxLen = this.suspRest + w.r;
        const hit = P.raycast(_mount, _v, maxLen, filter, body);
        if (hit) {
          w.comp = clamp(maxLen - hit.dist, 0, this.suspRest);
          w.contact.copy(hit.point);
          w.normal.copy(hit.normal);
          w.hitCollider = hit.collider;
          found = true;
        }
      }
      if (found) {
        w.grounded = true;
        grounded++;
        const owner = P.ownerOf(w.hitCollider);
        w.surface = owner ? owner.surface || 'asphalt' : 'asphalt';
        const pb = w.hitCollider.parent();
        w.hitBody = pb && pb.isDynamic() ? pb : null;
        w.hitOwner = owner;
      } else {
        w.grounded = false;
        w.comp = 0;
        w.hitBody = null;
      }
    }
    // anti-roll bars
    const arbF = (a, b) => (a.comp - b.comp) * T.arb;
    const arbFront = arbF(this.wheels[0], this.wheels[1]);
    const arbRear = arbF(this.wheels[2], this.wheels[3]);

    // ------------------------------------------------ per-wheel forces
    let slipSum = 0;
    const wet = this.game.weather ? this.game.weather.wet : 0;
    const driven = [2, 3];
    const brakeTotal = brake * T.brake;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.steer = w.front ? this.steerAngle * (1 + (w.side > 0 === this.steerAngle > 0 ? 0.08 : -0.06)) : 0;
      if (!w.grounded) {
        // free spinning wheels
        const isDriven = driven.includes(i);
        w.angVel = damp(w.angVel, isDriven && throttle > 0.1 ? (this.reverse ? -1 : 1) * 60 : w.angVel * 0.98, 2, h);
        if (inp.handbrake && !w.front) w.angVel = 0;
        w.skidding = 0;
        continue;
      }
      const compVel = (w.comp - w.lastComp) / h;
      let Fz = this.k * w.comp + (compVel > 0 ? this.cBump : this.cRebound) * compVel;
      if (w.comp > this.suspRest * 0.85) Fz += this.k * 8 * (w.comp - this.suspRest * 0.85);
      Fz += (i < 2 ? (i === 0 ? arbFront : -arbFront) : (i === 2 ? arbRear : -arbRear));
      Fz = Math.max(0, Fz);
      w.Fz = Fz;
      // wheel frame on the ground
      _n.copy(w.normal);
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      _wf.copy(_fwd).multiplyScalar(cs).addScaledVector(_right, sn);
      _wf.addScaledVector(_n, -_wf.dot(_n)).normalize();
      _ws.crossVectors(_n, _wf).normalize(); // points to the car's left
      const cv = body.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z });
      _v.set(cv.x, cv.y, cv.z);
      if (w.hitBody) {
        const hv = w.hitBody.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z });
        _v.x -= hv.x; _v.y -= hv.y; _v.z -= hv.z;
      }
      const vLong = _v.dot(_wf);
      const vLat = _v.dot(_ws);
      const surf = (SURFACE_GRIP[w.surface] ?? 0.9) * (1 - wet * (WET_LOSS[w.surface] ?? 0.25));
      let mu = (w.front ? T.grip : T.rearGrip) * surf;
      // load sensitivity
      const nominal = T.mass * 9.81 / 4;
      mu *= clamp(1.12 - 0.12 * (Fz / nominal), 0.8, 1.1);
      const maxF = mu * Fz;
      // longitudinal
      let Fx = 0;
      const isDriven = driven.includes(i);
      if (isDriven) Fx += driveForceTotal / 2 - Math.sign(vLong) * engineBrake / 2;
      // brakes (ABS for the foot brake)
      const bshare = w.front ? 0.64 : 0.36;
      let wantBrake = brakeTotal * bshare;
      let locked = false;
      if (inp.handbrake && !w.front) {
        wantBrake += T.mass * 9.81 * 0.36;
        locked = true;
      }
      if (wantBrake > 0) {
        const stopF = Math.abs(vLong) * (T.mass / 4) / h; // force that would stop the wheel this step
        const abs = locked ? wantBrake : Math.min(wantBrake, maxF * 0.92);
        Fx -= Math.sign(vLong) * Math.min(abs, stopF);
      }
      // rolling resistance
      Fx -= Math.sign(vLong) * Math.min(Math.abs(vLong) * 200, Fz * 0.013);
      // holding brake when idle
      if (throttle < 0.02 && Math.abs(vLong) < 0.6 && !this.driverless) {
        const hold = Math.abs(vLong) * (T.mass / 4) / h * 0.5;
        Fx -= Math.sign(vLong) * Math.min(hold, Fz * 0.6);
      }
      // lateral: slip-angle based curve with saturation and fall-off (drift), plus a low-speed limiter
      const vRef = Math.max(Math.abs(vLong), 1.0);
      const alpha = Math.atan2(Math.abs(vLat), vRef);
      const peak = 0.13;
      let g;
      const fall = w.front ? 0.24 : lerp(0.14, 0.24, dm);
      if (alpha < peak) { const x = alpha / peak; g = x * (2 - x); } else g = 1 - fall * smoothstep(peak, peak * 5, alpha);
      if (locked) g *= 0.5;
      const FyCancel = Math.abs(vLat) * (T.mass / 4) / h * 0.5;
      let Fy = -Math.sign(vLat) * Math.min(maxF * g, FyCancel);
      // friction circle (drive/brake reduce lateral grip -> power oversteer)
      let wheelspin = 0;
      if (Math.abs(Fx) > maxF) {
        wheelspin = (Math.abs(Fx) - maxF) / Math.max(1, maxF);
        Fx = Math.sign(Fx) * maxF * 0.9;
      }
      const tot = Math.hypot(Fx, Fy);
      if (tot > maxF) {
        // the longitudinal demand eats into lateral grip
        const fxr = Math.abs(Fx) / maxF;
        const latAvail = maxF * Math.sqrt(Math.max(0, 1 - fxr * fxr)) * (wheelspin > 0 ? lerp(0.9, 0.8, dm) : 1);
        Fy = Math.sign(Fy) * Math.min(Math.abs(Fy), Math.max(latAvail, maxF * (w.front ? 0.45 : lerp(0.55, 0.45, dm))));
      }
      // apply
      _F.copy(_up).multiplyScalar(Fz).addScaledVector(_wf, Fx).addScaledVector(_ws, Fy);
      // application point raised toward the roll center to tame body roll
      _v.copy(w.contact).addScaledVector(_up, T.rollCenter);
      const imp = { x: _F.x * h, y: _F.y * h, z: _F.z * h };
      body.applyImpulseAtPoint(imp, { x: _v.x, y: _v.y, z: _v.z }, true);
      if (w.hitBody) {
        const k2 = w.hitOwner && w.hitOwner.type === 'ragdoll' ? 0.35 : 0.6;
        w.hitBody.applyImpulseAtPoint({ x: -imp.x * k2, y: -imp.y * k2, z: -imp.z * k2 }, { x: w.contact.x, y: w.contact.y, z: w.contact.z }, true);
      }
      // wheel spin (visual + rpm)
      const rollAng = vLong / w.r;
      if (locked) w.angVel = approach(w.angVel, 0, 200 * h);
      else if (wheelspin > 0 && isDriven) w.angVel = approach(w.angVel, rollAng + Math.sign(Fx || 1) * (8 + wheelspin * 30), 120 * h);
      else w.angVel = rollAng;
      const latSlide = Math.abs(vLat);
      const longSlide = locked ? Math.abs(vLong) : wheelspin > 0 ? wheelspin * 6 + 2 : 0;
      w.skidding = clamp((latSlide - 2.2) / 5 + (longSlide > 1.5 ? longSlide / 8 : 0), 0, 1) * (w.surface === 'asphalt' || w.surface === 'concrete' ? 1 : 0.6);
      w.slipLat = vLat;
      slipSum += w.skidding;
    }
    this.wheelSlip = slipSum / 4;
    this.grounded = grounded;

    // ------------------------------------------------ drift stabilizer (keeps slides controllable)
    if (grounded >= 3 && this.driver && (this.driver.isPlayer || this.driver.isCop) && Math.abs(vLongCar) > 3) {
      const slip = Math.atan2(vLatCar, Math.abs(vLongCar));
      const av = body.angvel();
      const yawRate = av.x * _up.x + av.y * _up.y + av.z * _up.z;
      const limit = lerp(0.47, 0.95, dm);
      const excess = Math.abs(slip) - limit;
      let corr = 0;
      // yaw rate that increases |slip| beyond the limit is damped
      if (excess > 0 && Math.sign(yawRate) === -Math.sign(slip) * Math.sign(vLongCar)) corr = -yawRate * clamp(excess * 4, 0, 1) * 0.6;
      // mild general yaw damping while sliding without handbrake
      if (!inp.handbrake && Math.abs(slip) > 0.12) corr += -yawRate * lerp(0.12, 0.05, dm);
      if (corr !== 0) {
        const I = this.T.mass / 12 * (this.T.width ** 2 + this.T.length ** 2);
        const tq = corr * I * 0.9;
        body.applyTorqueImpulse({ x: _up.x * tq * h * 8, y: _up.y * tq * h * 8, z: _up.z * tq * h * 8 }, true);
      }
    }

    // ------------------------------------------------ aero & air control
    const sp = this.speed;
    if (sp > 0.1) {
      const drag = 0.5 * 1.2 * T.dragCA * sp;
      body.applyImpulse({ x: -vel.x * drag * h, y: -vel.y * drag * h, z: -vel.z * drag * h }, true);
      const down = 0.4 * sp * sp * (T.label === 'Sport' ? 1.6 : 0.6);
      body.applyImpulse({ x: -_up.x * down * h, y: -_up.y * down * h, z: -_up.z * down * h }, true);
    }
    if (grounded === 0 && this.driver && (this.driver.isPlayer || this.driver.isCop)) {
      const pitch = (inp.throttle - inp.brake) * 0.0;
      const tq = _v.copy(_right).multiplyScalar(-pitch * 2200).addScaledVector(_fwd, -inp.steer * 1400);
      body.applyTorqueImpulse({ x: tq.x * h, y: tq.y * h, z: tq.z * h }, true);
    }
  }

  /* ---------------------------------------------------------------- per-frame */
  update(dt) {
    if (this.removed) return;
    // store transforms for interpolation
    const t = this.body.translation();
    const r = this.body.rotation();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
    // local acceleration (for door dynamics / camera)
    const lv = this.body.linvel();
    _v.set(lv.x, lv.y, lv.z);
    const acc = _v2.copy(_v).sub(this.prevVel).multiplyScalar(1 / Math.max(dt, 1e-3));
    this.prevVel.copy(_v);
    _qi.copy(this.curQuat).invert();
    acc.applyQuaternion(_qi);
    this.accelLocal.lerp(acc, 0.3);
    this.updateDoors(dt);
    this.damageCooldown = Math.max(0, this.damageCooldown - dt);
    this.crashT = Math.max(0, (this.crashT || 0) - dt);
    // put idle, driverless cars to sleep so they cost nothing
    if (!this.driver && !this.body.isSleeping()) {
      const av = this.body.angvel();
      if (this.speed < 0.08 && Math.abs(av.x) + Math.abs(av.y) + Math.abs(av.z) < 0.08 && this.grounded >= 4) this.idleT = (this.idleT || 0) + dt;
      else this.idleT = 0;
      if (this.idleT > 0.8 && this.model.doors.every((d) => d.latched || d.scripted === false && d.vel === 0)) { this.body.sleep(); this.idleT = 0; }
    }
    // level of detail
    const cam = this.game.camera;
    if (cam) {
      const d2 = cam.position.distanceToSquared(this.curPos);
      const near = d2 < 45 * 45 || this.driver === this.game.player?.character;
      if (near !== this.lodNear) {
        this.lodNear = near;
        this.model.interior.visible = near;
        this.model.details.visible = near || d2 < 90 * 90;
        for (const d of this.model.doors) d.card.visible = near;
      }
      const mid = d2 < 90 * 90;
      if (mid !== this.lodMid) { this.lodMid = mid; this.model.details.visible = mid; for (const w of this.wheels) w.mount.children[0].children.forEach((c) => { if (!c.isGroup) c.visible = mid; }); }
    }
    // lights
    const L = this.model.lights;
    const braking = (this.effBrake || 0) > 0.1;
    this.brakeLight = damp(this.brakeLight, braking ? 1 : 0, 20, dt);
    const night = this.game.night ? 1 : 0;
    const occupied = !!this.driver;
    const rainy = this.game.weather ? this.game.weather.rain > 0.3 : false;
    const headOn = (occupied && (night || this.lightsOn || rainy)) && !this.headBroken;
    L.head.emissiveIntensity = this.headBroken ? 0 : headOn ? 3.2 : occupied ? 0.5 : 0.08;
    L.tail.emissiveIntensity = this.tailBroken ? 0 : (occupied ? (night ? 1.4 : 0.6) : 0.05) + this.brakeLight * 3.5;
    L.reverse.emissiveIntensity = this.reverse && occupied ? 2.0 : 0;
    if (this.model.siren) {
      const on = this.sirenOn;
      const ph = Math.floor(performance.now() / 160) % 2;
      L.sirenR.emissiveIntensity = on && ph ? 6 : 0;
      L.sirenB.emissiveIntensity = on && !ph ? 6 : 0;
    }
  }

  /** Copies interpolated physics transform to the visual model. */
  syncVisual(alpha = 1) {
    if (this.removed) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.curPos.copy(this.root.position);
    this.curQuat.copy(this.root.quaternion);
    void alpha;
    const T = this.T;
    for (const w of this.wheels) {
      const ext = w.grounded ? this.suspRest - w.comp : this.suspRest;
      w.visualY = damp(w.visualY, w.mountY - ext, 30, 1 / 60);
      w.mount.position.set(w.x, w.visualY, w.z);
      w.mount.rotation.set(0, w.steer, 0);
      w.spinAngle += w.angVel * (1 / 60);
      w.spin.rotation.x = (w.side > 0 ? 1 : -1) * w.spinAngle;
    }
    // steering wheel rotation (approx 2.5 turns lock to lock compressed visually)
    this.model.steeringWheel.rotation.z = -this.steerAngle / T.steerMax * 2.1;
    this.root.updateMatrixWorld(true);
  }

  /* ---------------------------------------------------------------- doors */
  doorBySide(side) { return this.model.doors.find((d) => d.side === side); }

  setDoorOpen(side, amount, scripted = true) {
    const d = this.doorBySide(side);
    if (!d) return;
    d.open = clamp(amount, 0, d.maxOpen);
    d.scripted = scripted;
    d.vel = 0;
    d.latched = amount <= 0.001;
    d.group.rotation.y = -d.side * d.open;
  }

  releaseDoor(side) {
    const d = this.doorBySide(side);
    if (d) d.scripted = false;
  }

  updateDoors(dt) {
    for (const d of this.model.doors) {
      if (d.scripted || d.latched) { d.group.rotation.y = -d.side * d.open; continue; }
      // free swinging door: pseudo forces from the car's acceleration and airflow
      const a = this.accelLocal;
      const len = d.length * 0.5;
      const th = d.open; // opening angle (outwards)
      // inertial torque: forward acceleration closes the door, lateral acceleration towards the door side opens it
      let alpha = (-a.z * Math.sin(th) - a.x * d.side * Math.cos(th)) / (1.33 * len);
      // airflow closes the door when moving forward
      const vz = this.fwdSpeed;
      alpha -= Math.sign(vz) * vz * vz * 0.06 * Math.sin(th) * (vz > 0 ? 1 : 0.3);
      alpha -= d.vel * 2.2; // hinge damping
      d.vel += alpha * dt;
      d.open += d.vel * dt;
      if (d.open >= d.maxOpen) { d.open = d.maxOpen; d.vel = -Math.abs(d.vel) * 0.25; }
      if (d.open <= 0) {
        if (d.vel < -0.6) {
          d.open = 0; d.vel = 0; d.latched = true;
          this.game.audio?.doorSlam(this.localToWorld(d.hinge, _v), 0.8);
        } else { d.open = 0; d.vel = Math.abs(d.vel) * 0.2; }
      }
      d.group.rotation.y = -d.side * d.open;
    }
  }

  /** World position of the exterior handle of a door (moves with the door). */
  doorHandleWorld(side, out) {
    const d = this.doorBySide(side);
    _v.copy(d.handleLocal).sub(d.hinge).applyAxisAngle(_yAxis, -d.side * d.open).add(d.hinge);
    return this.localToWorld(_v, out);
  }
  doorInnerHandleWorld(side, out) {
    const d = this.doorBySide(side);
    _v.copy(d.innerHandleLocal).sub(d.hinge).applyAxisAngle(_yAxis, -d.side * d.open).add(d.hinge);
    return this.localToWorld(_v, out);
  }
  /** Point on the door's top edge near the rear (for pushing it shut). */
  doorEdgeWorld(side, out) {
    const d = this.doorBySide(side);
    const T = this.T;
    _v.set(d.handleLocal.x, T.beltY + 0.02, T.zDoorRear + 0.12).sub(d.hinge).applyAxisAngle(_yAxis, -d.side * d.open).add(d.hinge);
    return this.localToWorld(_v, out);
  }

  /** Is there room on this side to open the door and stand next to it? */
  doorClear(side) {
    const W = this.physics.world;
    const T = this.T;
    const filter = groups(G.ALL, G.STATIC | G.CAR | G.PROP);
    const checks = [
      // capsules float above kerb height so curbs and low steps don't count as blocking
      [side * (this.halfW + 0.55), 1.05, this.model.seat.z + 0.1, 0.28],
      [side * (this.halfW + 0.6), 1.05, T.zDoorRear - 0.2, 0.28],
      [side * (this.halfW + 0.55), 1.05, (T.zDoorFront + T.zDoorRear) / 2 + 0.2, 0.22],
    ];
    for (const [x, y, z, r] of checks) {
      this.localToWorld(_v.set(x, y, z), _v2);
      const shape = new R.Capsule(0.38, r);
      const hit = W.intersectionWithShape({ x: _v2.x, y: _v2.y, z: _v2.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, filter, undefined, this.body);
      if (hit) return false;
    }
    return true;
  }

  /** Seat H-point in car-local coordinates for a side (+1 driver/left, -1 passenger). */
  seatLocal(side, out) {
    const s = this.model.seat;
    return out.set(s.x * side, s.y, s.z);
  }

  /* ---------------------------------------------------------------- damage */
  applyDamage(worldPoint, impulse, otherOwner) {
    // health: a single crash fires many contact events (several colliders, several substeps);
    // it costs its peak severity once instead of the sum of every event
    const sev = clamp((impulse - 1800) / 15000, 0, 1);
    if (this.crashT <= 0) this.crashPeak = 0;
    if (sev > this.crashPeak) {
      this.health = Math.max(0, this.health - (sev - this.crashPeak) * 26);
      this.crashPeak = sev;
    }
    if (sev > 0) this.crashT = 0.35;
    if (this.damageCooldown > 0 && impulse < 9000) return;
    this.damageCooldown = 0.08;
    const local = this.worldToLocal(worldPoint, _v);
    const amount = clamp((impulse - 1000) / 15000, 0, 1);
    if (amount <= 0) return;
    const depth = 0.06 + amount * 0.3;
    const radius = 0.5 + amount * 0.75;
    // inward direction: towards the car's centre line, mostly horizontal
    _n.set(-local.x * 0.6, -Math.max(0, local.y - 0.9) * 0.4, -local.z).normalize();
    if (Math.abs(local.z) < this.halfL - 0.6) _n.set(-Math.sign(local.x), 0, 0); // side impact
    this.deform(local, _n, depth, radius);
    // breakable parts
    if (local.z > this.halfL - 0.5 && amount > 0.25) this.headBroken = this.headBroken || amount > 0.45;
    if (local.z < -this.halfL + 0.5 && amount > 0.3) this.tailBroken = true;
    if (amount > 0.35) {
      const gm = this.model.glassMeshes;
      const crack = (name) => { if (gm[name]) gm[name].material = sharedCracked(); };
      if (Math.abs(local.z) > 0.8 || local.z < this.T.zB[1]) crack('body');
      else crack(local.x > 0 ? 'doorL' : 'doorR');
      if (amount > 0.5) this.game.effects?.glass(worldPoint, amount);
    }
    // a hard side impact can pop a door open
    if (amount > 0.55 && Math.abs(local.z) < 1.2) {
      const d = this.doorBySide(local.x > 0 ? 1 : -1);
      if (d && d.latched && !d.scripted && Math.random() < 0.4) { d.latched = false; d.vel = 3; }
    }
    void otherOwner;
  }

  deform(local, dir, depth, radius) {
    for (const mesh of this.model.deformables) {
      const geo = mesh.geometry;
      const posAttr = geo.attributes.position;
      const orig = mesh.userData.orig;
      // transform impact into the mesh's local frame (doors are parented to hinges)
      let lp = local, ld = dir;
      if (mesh.parent !== this.root) {
        mesh.parent.updateMatrix();
        _m4.copy(mesh.parent.matrix).invert();
        lp = _tmpA.copy(local).applyMatrix4(_m4);
        ld = _tmpB.copy(dir).transformDirection(_m4);
      }
      const arr = posAttr.array;
      let changed = false;
      const r2 = radius * radius;
      for (let i = 0; i < arr.length; i += 3) {
        const dx = arr[i] - lp.x, dy = arr[i + 1] - lp.y, dz = arr[i + 2] - lp.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const f = (1 - d2 / r2) ** 2;
        const nx = arr[i] + ld.x * depth * f, ny = arr[i + 1] + ld.y * depth * f, nz = arr[i + 2] + ld.z * depth * f;
        // clamp total displacement
        const ox = orig[i], oy = orig[i + 1], oz = orig[i + 2];
        const tx = nx - ox, ty = ny - oy, tz = nz - oz;
        const tl = Math.hypot(tx, ty, tz);
        const maxD = 0.32;
        const k = tl > maxD ? maxD / tl : 1;
        arr[i] = ox + tx * k; arr[i + 1] = oy + ty * k; arr[i + 2] = oz + tz * k;
        changed = true;
      }
      if (changed) {
        posAttr.needsUpdate = true;
        geo.computeVertexNormals();
      }
    }
  }

  repair() {
    for (const mesh of this.model.deformables) {
      mesh.geometry.attributes.position.array.set(mesh.userData.orig);
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    this.health = 100;
    this.headBroken = false;
    this.tailBroken = false;
  }

  flip() {
    const t = this.body.translation();
    const f = this.forward(_v);
    const yaw = Math.atan2(f.x, f.z);
    _q.setFromAxisAngle(_yAxis, yaw);
    this.body.setTranslation({ x: t.x, y: t.y + 1.2, z: t.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.game.scene.remove(this.root);
    this.physics.removeBody(this.body);
    // free per-car GPU resources (wheel geometry and the shared materials are cached and kept)
    this.root.traverse((o) => {
      if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    });
    this.model.paint.dispose();
    for (const m of Object.values(this.model.lights)) m.dispose();
    if (this.model.plateMat) { this.model.plateMat.map?.dispose(); this.model.plateMat.dispose(); }
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0);
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
let _cracked = null;
import { sharedCarMaterials } from './carModel.js';
function sharedCracked() {
  if (!_cracked) _cracked = sharedCarMaterials().glassCracked;
  return _cracked;
}
void invLerp;
