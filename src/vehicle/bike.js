import * as THREE from 'three';
import { R, G, groups } from '../core/physics.js';
import { clamp, lerp, damp, approach, smoothstep } from '../core/util.js';
import { buildBikeModel, BIKE_TYPES } from './bikeModel.js';

const SURFACE_GRIP = { asphalt: 1.0, concrete: 0.95, metal: 0.85, wood: 0.85, grass: 0.62, sand: 0.5, dirt: 0.65, flesh: 0.6, car: 0.7 };
const WET_LOSS = { asphalt: 0.3, concrete: 0.32, metal: 0.4, wood: 0.34, grass: 0.22, sand: 0.06, dirt: 0.3, flesh: 0.1, car: 0.3 };
const GRAV = 9.81;

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _P = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _fh = new THREE.Vector3();
const _lh = new THREE.Vector3();
const _A = new THREE.Vector3();
const _S = new THREE.Vector3();
const _D = new THREE.Vector3();
const _C = new THREE.Vector3();
const _H = new THREE.Vector3();
const _n = new THREE.Vector3();
const _hw = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _F = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

let BIKE_ID = 50000;

/**
 * Motorcycle with physical two-wheel dynamics.
 *
 * Each tyre has a round profile: a sphere (the tyre crown) is swept along the suspension axis from
 * the fully compressed position, so the contact patch moves to the side of the tyre as the bike
 * leans. Tyre forces use the same slip model as the cars.
 *
 * Balance: the rider (or the kickstand, or a foot on the ground when stopped) is a roll
 * controller. Steering input sets the lean a coordinated turn needs at the current speed, and the
 * front wheel steers to match the bike's actual lean (lean-steer), as a rider counter-steers. A
 * bike without a rider is not balanced at all and falls over.
 */
export class Bike {
  constructor(game, type, color, pos, yaw, opts = {}) {
    this.isBike = true;
    this.id = BIKE_ID++;
    this.game = game;
    this.physics = game.physics;
    this.type = type;
    const T0 = BIKE_TYPES[type];
    // car-compatible fields used by shared systems (camera, HUD, audio, AI, effects)
    this.T = { ...T0, wheelR: (T0.rF + T0.rR) / 2, wheelW: T0.twR, roofY: 1.3, bottomY: 0.2 };
    const T = this.T;
    this.color = color || T.colors[Math.floor(Math.random() * T.colors.length)];
    this.model = buildBikeModel(type, this.color, { seed: this.id * 31 + 7 });
    this.root = this.model.root;
    game.scene.add(this.root);
    this.halfW = this.model.halfW;
    this.halfL = this.model.halfL;
    this.height = 1.3;

    // ---------------------------------------------------------------- body (bike + rider)
    const m = T.mass + 80;
    this.mass = m;
    this.com = new THREE.Vector3(0, 0.6, -0.04);
    this.Iroll = m * 0.11;
    this.Ipitch = m * 0.42;
    this.Iyaw = m * 0.36;
    _q.setFromAxisAngle(_Y, yaw);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setAdditionalMassProperties(m, { x: this.com.x, y: this.com.y, z: this.com.z }, { x: this.Ipitch, y: this.Iyaw, z: this.Iroll }, { x: 0, y: 0, z: 0, w: 1 })
      .setAngularDamping(0.3)
      .setCcdEnabled(true)
      .setCanSleep(true);
    if (opts.vel) desc.setLinvel(opts.vel.x, opts.vel.y, opts.vel.z);
    this.body = this.physics.world.createRigidBody(desc);
    this.colliders = [];
    const add = (cd, kind) => {
      cd.setDensity(0)
        .setFriction(0.45)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0.1)
        .setCollisionGroups(groups(G.CAR, G.ALL))
        .setSolverGroups(groups(G.CAR, G.ALL & ~G.CHAR))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(1500);
      const c = this.physics.world.createCollider(cd, this.body);
      this.physics.setOwner(c, { type: 'car', vehicle: this, surface: 'car', part: kind });
      this.colliders.push(c);
      return c;
    };
    const wb = T.wheelbase, hw = wb / 2;
    add(R.ColliderDesc.roundCuboid(0.12, 0.17, hw * 0.75, 0.04).setTranslation(0, 0.6, -0.02), 'core');
    add(R.ColliderDesc.roundCuboid(0.13, 0.08, 0.12, 0.04).setTranslation(0, T.head[1] - 0.05, T.head[2] + 0.1), 'nose');
    add(R.ColliderDesc.roundCuboid(0.08, 0.06, 0.2, 0.03).setTranslation(0, T.seat[1] + 0.02, T.seat[2] - 0.38), 'tail');
    this.riderCol = add(R.ColliderDesc.capsule(0.26, 0.2).setTranslation(0, T.seat[1] + 0.48, T.seat[2] + (T.kind === 'sport' ? 0.12 : -0.02)), 'rider');
    // lying on its side it rests on the wheels and the bars
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    this.fallCols = [
      add(R.ColliderDesc.cylinder(T.twF / 2, T.rF - 0.01).setTranslation(0, T.rF, hw).setRotation({ x: qx.x, y: qx.y, z: qx.z, w: qx.w }), 'wheelF'),
      add(R.ColliderDesc.cylinder(T.twR / 2, T.rR - 0.01).setTranslation(0, T.rR, -hw).setRotation({ x: qx.x, y: qx.y, z: qx.z, w: qx.w }), 'wheelR'),
      add(R.ColliderDesc.cuboid(T.grips[0] + 0.08, 0.03, 0.05).setTranslation(0, T.head[1] + T.grips[1], T.head[2] + T.grips[2]), 'bars'),
    ];
    this.setRiderCollider(false);
    this.setFallen(false);

    // ---------------------------------------------------------------- suspension & tyres
    this.rake = T.rake;
    const mkWheel = (front) => {
      const share = front ? 0.47 : 0.53;
      const r = front ? T.rF : T.rR, tw = front ? T.twF : T.twR, travel = front ? T.travelF : T.travelR;
      const hz = front ? T.springHzF : T.springHzR;
      const k = m * share * (2 * Math.PI * hz) ** 2;
      const c0 = (m * share * GRAV) / k;
      const axisL = front ? new THREE.Vector3(0, Math.cos(T.rake), -Math.sin(T.rake)) : new THREE.Vector3(0, 1, 0);
      const hubStatic = new THREE.Vector3(0, r, front ? hw : -hw);
      return {
        front, x: 0, z: hubStatic.z, r, tw, rho: tw / 2, travel, k, c0,
        cBump: 2 * T.damping * Math.sqrt(k * m * share), cRebound: 2 * T.damping * Math.sqrt(k * m * share) * 1.3,
        axisL, hubStatic, mountL: hubStatic.clone().addScaledVector(axisL, travel - c0),
        comp: c0, lastComp: c0, grounded: false, Fz: m * share * GRAV,
        contact: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'asphalt', hitBody: null, hitOwner: null,
        angVel: 0, spinAngle: 0, steer: 0, skidding: 0, slipLat: 0, lastSkidPos: null, visualY: r, burst: false, compVel: 0,
      };
    };
    this.wheels = [mkWheel(true), mkWheel(false)];

    // ---------------------------------------------------------------- state
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, wheelie: 0 };
    this.steerAngle = 0;
    this.lean = 0;
    this.leanTarget = 0;
    this.pitch = 0;
    this.gear = 1;
    this.rpm = 1300;
    this.shiftTimer = 0;
    this.reverse = false;
    this.speed = 0;
    this.fwdSpeed = 0;
    this.health = 100;
    this.engineOn = true;
    this.driver = null;
    this.ai = null;
    this.passengers = [];
    this.persistent = !!opts.persistent;
    this.removed = false;
    this.standDown = !opts.vel;
    this.fallen = false;
    this.hold = 0; // someone is holding the bike upright (getting on / off)
    this.footDown = false;
    this.grounded = 2;
    this.wheelSlip = 0;
    this.brakeLight = 0;
    this.lightsOn = false;
    this.sirenOn = false;
    this.headBroken = false;
    this.tailBroken = false;
    this.exploded = false;
    this.effThrottle = 0;
    this.effBrake = 0;
    this.crashT = 0;
    this.velPrev = new THREE.Vector3();
    this.velCur = new THREE.Vector3();
    this.crashPeak = 0;
    this.prevPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.curPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.curQuat = _q.clone();
    this.syncVisual();
  }

  /* ---------------------------------------------------------------- helpers (car-compatible) */
  get position() { return this.curPos; }
  get quaternion() { return this.curQuat; }
  get occupied() { return !!this.driver; }
  localToWorld(local, out) { return out.copy(local).applyQuaternion(this.curQuat).add(this.curPos); }
  worldToLocal(world, out) { _qi.copy(this.curQuat).invert(); return out.copy(world).sub(this.curPos).applyQuaternion(_qi); }
  velocityAt(world, out) { const v = this.body.velocityAtPoint({ x: world.x, y: world.y, z: world.z }); return out.set(v.x, v.y, v.z); }
  linvel(out) { const v = this.body.linvel(); return out.set(v.x, v.y, v.z); }
  forward(out) { return out.set(0, 0, 1).applyQuaternion(this.curQuat); }
  isUpsideDown() { return _up.set(0, 1, 0).applyQuaternion(this.curQuat).y < -0.3; }
  seatLocal(side, out) { const s = this.model.seat; return out.set(0, s.y, s.z); }
  doorClear() { return true; }
  doorBySide() { return null; }
  setDoorOpen() {}
  releaseDoor() {}
  smashWindow() {}
  deform() {}

  setRiderCollider(on) {
    if (this.riderOn === on) return;
    this.riderOn = on;
    this.riderCol.setEnabled(on);
  }
  setFallen(on) {
    if (this.fallenCols === on) return;
    this.fallenCols = on;
    for (const c of this.fallCols) c.setEnabled(on);
  }

  /* ---------------------------------------------------------------- physics */
  prePhysics(h) {
    if (this.removed) return;
    const body = this.body;
    if (body.isSleeping()) {
      if (this.driver || this.hold > 0 || this.input.throttle > 0.01) body.wakeUp();
      else return;
    }
    const T = this.T;
    const t = body.translation(), r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const pos = _P.set(t.x, t.y, t.z);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _left.set(1, 0, 0).applyQuaternion(_q);
    const lv = body.linvel();
    const vel = _v2.set(lv.x, lv.y, lv.z);
    // velocity history: a crash throws the rider on at the speed from just before the impact
    this.velPrev.copy(this.velCur);
    this.velCur.copy(vel);
    const vLong = vel.dot(_fwd);
    this.fwdSpeed = vLong;
    this.speed = vel.length();
    const v = Math.abs(vLong);
    // lean and pitch relative to the horizon
    _fh.copy(_fwd).addScaledVector(_Y, -_fwd.y);
    if (_fh.lengthSq() < 1e-6) _fh.set(0, 0, 1).applyQuaternion(_q).setY(0);
    _fh.normalize();
    _lh.crossVectors(_Y, _fh).normalize();
    this.lean = Math.atan2(_up.dot(_lh), _up.dot(_Y));
    this.pitch = Math.atan2(_fwd.y, Math.hypot(_fwd.x, _fwd.z));
    const av = body.angvel();
    const rollRateL = -(av.x * _fh.x + av.y * _fh.y + av.z * _fh.z);
    const pitchRateNoseDown = av.x * _lh.x + av.y * _lh.y + av.z * _lh.z;

    // ------------------------------------------------ inputs
    const inp = this.input;
    const rider = this.driver && this.driver.alive ? this.driver : null;
    let throttle = rider ? clamp(inp.throttle, 0, 1) : 0;
    let brake = rider ? clamp(inp.brake, 0, 1) : 0;
    if (!this.engineOn || this.health <= 0) throttle = 0;
    this.effThrottle = throttle;
    this.effBrake = brake;

    // ------------------------------------------------ suspension: round tyre crowns swept along the fork / shock
    const filter = groups(G.ALL, G.STATIC | G.CAR | G.PROP | G.RAGDOLL);
    let grounded = 0;
    const upright = Math.abs(this.lean) < 1.0 && _up.y > 0.3;
    for (const w of this.wheels) {
      w.lastComp = w.comp;
      w.wasGrounded = w.grounded;
      w.grounded = false;
      if (!upright) { w.comp = 0; w.hitBody = null; continue; }
      // axle direction (front axle turns with the steering about the fork axis)
      _A.set(1, 0, 0);
      if (w.front) { _qs.setFromAxisAngle(w.axisL, this.steerAngle); _A.applyQuaternion(_qs); }
      _A.applyQuaternion(_q);
      _S.copy(w.axisL).applyQuaternion(_q); // suspension axis (up)
      // direction from the hub to the lowest point of the tyre crown, in the wheel plane
      _D.set(0, -1, 0).addScaledVector(_A, _A.y);
      if (_D.lengthSq() < 1e-6) continue;
      _D.normalize();
      _H.copy(w.mountL).applyQuaternion(_q).add(pos);
      _C.copy(_H).addScaledVector(_D, w.r - w.rho); // crown centre with the suspension fully compressed
      // exact contact: the ground plane under the crown (precise ray), then solve how far the crown
      // sphere travels along the suspension axis before it touches that plane
      const hit = this.physics.raycast(_C, _down, w.travel + w.rho + 0.45, filter, body);
      if (!hit) { w.comp = 0; w.hitBody = null; continue; }
      _n.copy(hit.normal);
      if (_n.y < 0.5) _n.copy(_Y);
      const gap = _v.subVectors(_C, hit.point).dot(_n) - w.rho;
      const along = Math.max(0.3, _S.dot(_n));
      w.along = along;
      const toi = gap / along;
      if (toi > w.travel) { w.comp = 0; w.hitBody = null; continue; }
      w.comp = clamp(w.travel - toi, 0, w.travel);
      w.contact.copy(_C).addScaledVector(_S, -Math.max(0, toi)).addScaledVector(_n, -w.rho);
      w.normal.copy(_n);
      w.grounded = true;
      grounded++;
      const sh = hit;
      const owner = this.physics.ownerOf(sh.collider);
      w.surface = owner ? owner.surface || 'asphalt' : 'asphalt';
      const pb = sh.collider.parent();
      w.hitBody = pb && pb.isDynamic() ? pb : null;
      w.hitOwner = owner;
    }
    this.grounded = grounded;

    // ------------------------------------------------ engine & gearbox
    const gears = T.gears;
    if (this.shiftTimer > 0) this.shiftTimer -= h;
    const ratio = gears[this.gear - 1] * T.primary * T.finalDrive;
    const rear = this.wheels[1], frontW = this.wheels[0];
    const wheelRpm = Math.abs(rear.grounded ? vLong : rear.angVel * rear.r) / rear.r * 60 / (2 * Math.PI);
    const idle = T.kind === 'sport' ? 1400 : 900;
    this.rpm = damp(this.rpm, Math.max(idle, wheelRpm * ratio + (throttle > 0.1 && v < 2 ? throttle * T.redline * 0.35 : 0)), 12, h);
    if (this.shiftTimer <= 0) {
      if (this.rpm > T.redline - 400 && this.gear < gears.length) { this.gear++; this.shiftTimer = 0.12; }
      else if (this.gear > 1) {
        const lower = wheelRpm * gears[this.gear - 2] * T.primary * T.finalDrive;
        if (lower < T.redline * (throttle > 0.6 ? 0.72 : 0.5)) { this.gear--; this.shiftTimer = 0.1; }
      }
    }
    const n = this.rpm / T.redline;
    const curve = clamp(0.62 + 0.9 * n - 0.6 * n * n, 0.45, 1);
    let engineForce = throttle * T.torque * curve * ratio * 0.9 / rear.r * (this.health < 25 ? 0.55 : 1);
    if (this.rpm > T.redline + 200) engineForce = 0;
    if (this.shiftTimer > 0) engineForce *= 0.2;
    const wheelieMax = 0.32 + clamp(inp.wheelie || 0, 0, 1) * 0.36;
    const engineBrake = throttle < 0.05 && rider ? clamp(this.rpm / T.redline, 0, 1) * 380 : 0;

    // ------------------------------------------------ steering: drives the turn directly (speed-dependent lock)
    const steerIn = clamp(inp.steer, -1, 1);
    const vLat = vel.dot(_lh);
    // steering lock: limited at speed to the turn the tyres can actually hold
    const muRoad = T.grip * (SURFACE_GRIP[rear.surface] ?? 0.9) * (1 - (this.game.weather ? this.game.weather.wet : 0) * (WET_LOSS[rear.surface] ?? 0.25));
    const maxSteer = Math.min(T.steerMax / (1 + v * v / 150), Math.atan(0.82 * muRoad * GRAV * T.wheelbase / Math.max(v * v, 1)));
    // (AI riders ask for a wheel angle directly; the player's stick is a fraction of the lock)
    const steerCmd = rider && inp.steerAbs != null && rider !== this.game.player.character ? clamp(inp.steerAbs, -maxSteer, maxSteer) : steerIn * maxSteer;
    let steerTarget = rider ? steerCmd : 0;
    if (rider && v > 4 && Math.abs(vLat) > 0.8) steerTarget += clamp(Math.atan2(vLat, Math.abs(vLong)), -0.5, 0.5) * 0.4; // catch a slide
    // castor: the fork swings into a yaw the rider didn't ask for (the rear stepping out under braking),
    // so the front tyre stops pushing the bike further round
    if (rider && v > 3 && grounded > 0) {
      const yawWant = vLong * Math.tan(steerCmd) / T.wheelbase;
      steerTarget += clamp((yawWant - av.y) * 4 / Math.max(v, 6), -0.25, 0.25);
    }
    steerTarget = clamp(steerTarget, -Math.min(T.steerMax, maxSteer + 0.06), Math.min(T.steerMax, maxSteer + 0.06));
    const steerRate = Math.abs(steerTarget) < Math.abs(this.steerAngle) ? 4 : 2.6;
    this.steerAngle = rider ? approach(this.steerAngle, steerTarget, steerRate * h) : (this.fallen ? this.steerAngle : approach(this.steerAngle, 0, 1.5 * h));

    // ------------------------------------------------ balance: lean follows the actual cornering
    const yawRate = av.x * _Y.x + av.y * _Y.y + av.z * _Y.z;
    // the cornering force the tyres actually produced last step (a skid yaws without cornering)
    // (low-passed: rolling the bike swings the contact patches sideways, and feeding that straight
    // back into the lean target makes it weave)
    this.latAccF = damp(this.latAccF || 0, (this.latForce || 0) / this.mass, 5, h);
    const latAcc = clamp(this.latAccF, -GRAV * 1.4, GRAV * 1.4);
    // the lean that balances the measured cornering force, anticipating the commanded turn a little
    const leanEq = Math.atan(latAcc / GRAV);
    const leanCmd = Math.atan(v * v * Math.tan(steerTarget) / (T.wheelbase * GRAV));
    let leanWant = clamp(lerp(leanEq, leanCmd, 0.25), -T.maxLean, T.maxLean);
    this.footDown = !!rider && v < 1.3 && grounded > 0;
    if (this.footDown) leanWant = 0.05;
    else if (rider && v < 4) leanWant = lerp(0.03, leanWant, smoothstep(1.3, 4, v));
    this.leanTarget = rider ? approach(this.leanTarget, leanWant, 4 * h) : 0;

    // ------------------------------------------------ roll control: rider, foot, kickstand or held by hand
    let kp = 0, kd = 0, target = 0, tanEq = 0;
    if (rider && grounded > 0) { kp = this.footDown ? 110 : 105; kd = this.footDown ? 24 : 22; target = this.leanTarget; tanEq = this.footDown ? 0 : latAcc / GRAV; }
    else if (this.hold > 0) { kp = 95; kd = 22; target = this.holdLean ?? 0; }
    else if (!rider && this.standDown && v < 0.6 && !this.fallen) {
      kp = 85; kd = 20; target = 0.2; // resting on the kickstand (leaning left)
      if (Math.abs(this.lean - 0.2) > 0.45) { this.fallen = true; this.standDown = false; }
    }
    if (kp > 0) {
      // feed-forward: cancel the roll moment of the ground forces (normal force offset by the lean
      // against the cornering force), so the controller only has to steer the lean
      const ff = this.mass * GRAV * 0.55 * (Math.sin(this.lean) - Math.cos(this.lean) * tanEq) * (rider || this.hold > 0 ? 1 : 0.7);
      const tq = -this.Iroll * (kp * (target - this.lean) - kd * rollRateL) + ff;
      body.applyTorqueImpulse({ x: _fh.x * tq * h, y: _fh.y * tq * h, z: _fh.z * tq * h }, true);
    }
    if (!rider && !this.hold && (Math.abs(this.lean) > 0.75 || !upright)) this.fallen = true;
    this.setFallen(this.fallen || (!rider && Math.abs(this.lean) > 0.6));

    // ------------------------------------------------ anti-wheelie / anti-stoppie (load transfer limits)
    const dRear = Math.abs(-T.wheelbase / 2 - this.com.z), dFront = Math.abs(T.wheelbase / 2 - this.com.z);
    const hCom = this.com.y;
    const wheelieIn = clamp(inp.wheelie || 0, 0, 1);
    let driveCap = this.mass * GRAV * dRear / hCom * (0.82 + wheelieIn * 0.9);
    if (this.pitch > 0.03) driveCap *= clamp(1 - (this.pitch - 0.03) / (wheelieIn > 0 ? 0.6 : 0.16), 0.03, 1);
    if (!frontW.grounded && rear.grounded && wheelieIn < 0.1) driveCap *= 0.35;
    engineForce = Math.min(engineForce, driveCap);
    // front brake limited so the rear tyre always keeps some load (no stoppie, rear stays planted)
    this.frontBrakeCap = this.mass * GRAV * dFront / hCom * 0.74 * clamp(1 + (this.pitch + 0.02) * 6, 0.1, 1);

    // ------------------------------------------------ rider yaw control: keep the bike on the line the bars point to
    if (rider && grounded > 0 && v > 3) {
      const yawCmd = vLong * Math.tan(this.steerAngle) / T.wheelbase;
      const kY = brake > 0.3 ? 9 : 5;
      const tqY = clamp(-this.Iyaw * (yawRate - yawCmd) * kY, -this.Iyaw * kY, this.Iyaw * kY);
      body.applyTorqueImpulse({ x: 0, y: tqY * h, z: 0 }, true);
    }

    // ------------------------------------------------ per-wheel tyre forces
    let slipSum = 0;
    let latSum = 0;
    const wet = this.game.weather ? this.game.weather.wet : 0;
    // the rider squeezes the brake progressively instead of grabbing it (no instant stoppie)
    this.brakeRamp = approach(this.brakeRamp || 0, brake, (brake > (this.brakeRamp || 0) ? 3.5 : 8) * h);
    const brakeTotal = brake * T.brake; // (front share ramps in below)
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      w.steer = w.front ? this.steerAngle : 0;
      if (!w.grounded) {
        w.angVel = damp(w.angVel, !w.front && throttle > 0.1 ? 70 : w.angVel * 0.98, 2, h);
        if (brake > 0.3) w.angVel = approach(w.angVel, 0, 60 * h);
        w.skidding = 0;
        continue;
      }
      // (a wheel that just touched down has no meaningful compression speed yet: no damper spike)
      w.compVel = w.wasGrounded ? clamp((w.comp - w.lastComp) / h, -4, 4) : 0;
      let Fz = w.k * w.comp + (w.compVel > 0 ? w.cBump : w.cRebound) * w.compVel;
      if (w.comp > w.travel * 0.85) Fz += w.k * 10 * (w.comp - w.travel * 0.85);
      // the spring acts along the (leaning) suspension axis: only its normal component loads the tyre
      Fz = Math.max(0, Fz) * (w.along || 1);
      w.Fz = Fz;
      _n.copy(w.normal);
      // wheel heading in the ground plane
      _hw.set(0, 0, 1);
      if (w.front) { _qs.setFromAxisAngle(w.axisL, this.steerAngle); _hw.applyQuaternion(_qs); }
      _hw.applyQuaternion(_q);
      _hw.addScaledVector(_n, -_hw.dot(_n)).normalize();
      _ws.crossVectors(_n, _hw).normalize(); // left
      const cv = body.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z });
      _v.set(cv.x, cv.y, cv.z);
      if (w.hitBody) { const hv = w.hitBody.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z }); _v.x -= hv.x; _v.y -= hv.y; _v.z -= hv.z; }
      const vL = _v.dot(_hw), vT = _v.dot(_ws);
      const surf = (SURFACE_GRIP[w.surface] ?? 0.9) * (1 - wet * (WET_LOSS[w.surface] ?? 0.25));
      let mu = T.grip * surf * (w.burst ? 0.4 : 1);
      const nominal = this.mass * GRAV / 2;
      mu *= clamp(1.1 - 0.1 * (Fz / nominal), 0.85, 1.1);
      const maxF = mu * Fz;
      // longitudinal: chain drive on the rear, linked brakes (front 65%), ABS on the front
      let Fx = 0;
      if (!w.front) Fx += engineForce - Math.sign(vL) * engineBrake;
      let wantBrake = (w.front ? this.brakeRamp * T.brake : brakeTotal) * (w.front ? 0.65 : 0.35);
      let locked = false;
      if (!w.front && inp.handbrake && rider) { wantBrake += this.mass * GRAV * 0.5; locked = true; }
      // the front brake is limited to what keeps the rear wheel on the ground (anti-stoppie)
      if (w.front) wantBrake = Math.min(wantBrake, this.frontBrakeCap ?? wantBrake);
      if (wantBrake > 0) {
        const stopF = Math.abs(vL) * (this.mass / 2) / h;
        // ABS; the rear keeps a margin so it still has sideways grip when it goes light
        const lim = locked ? wantBrake : Math.min(wantBrake, maxF * (w.front ? 0.92 : 0.55));
        Fx -= Math.sign(vL) * Math.min(lim, stopF);
      }
      // at a standstill the rider paddles backwards with the feet
      if (!w.front && rider && v < 1.2 && inp.brake > 0.5 && inp.throttle < 0.05) Fx -= 260;
      Fx -= Math.sign(vL) * Math.min(Math.abs(vL) * 120, Fz * (w.burst ? 0.08 : 0.012));
      // lateral: slip-angle curve with saturation
      const vRef = Math.max(Math.abs(vL), 1.0);
      const alpha = Math.atan2(Math.abs(vT), vRef);
      const peak = 0.14;
      let gk;
      if (alpha < peak) { const x = alpha / peak; gk = x * (2 - x); } else gk = 1 - 0.3 * smoothstep(peak, peak * 5, alpha);
      if (locked) gk *= 0.55;
      const cancel = Math.abs(vT) * (this.mass / 2) / h * 0.5;
      let Fy = -Math.sign(vT) * Math.min(maxF * gk, cancel);
      let spin = 0;
      if (Math.abs(Fx) > maxF) { spin = (Math.abs(Fx) - maxF) / Math.max(1, maxF); Fx = Math.sign(Fx) * maxF * 0.92; }
      const tot = Math.hypot(Fx, Fy);
      if (tot > maxF) {
        const fx = Math.abs(Fx) / maxF;
        const lat = maxF * Math.sqrt(Math.max(0, 1 - fx * fx));
        Fy = Math.sign(Fy) * Math.min(Math.abs(Fy), Math.max(lat, maxF * 0.35));
      }
      _F.copy(_n).multiplyScalar(Fz).addScaledVector(_hw, Fx).addScaledVector(_ws, Fy);
      latSum += (_ws.x * _lh.x + _ws.y * _lh.y + _ws.z * _lh.z) * Fy;
      body.applyImpulseAtPoint({ x: _F.x * h, y: _F.y * h, z: _F.z * h }, { x: w.contact.x, y: w.contact.y, z: w.contact.z }, true);
      if (w.hitBody) {
        const k2 = w.hitOwner && w.hitOwner.type === 'ragdoll' ? 0.35 : 0.6;
        w.hitBody.applyImpulseAtPoint({ x: -_F.x * h * k2, y: -_F.y * h * k2, z: -_F.z * h * k2 }, { x: w.contact.x, y: w.contact.y, z: w.contact.z }, true);
      }
      const roll = vL / w.r;
      if (locked) w.angVel = approach(w.angVel, 0, 200 * h);
      else if (spin > 0 && !w.front) w.angVel = approach(w.angVel, roll + Math.sign(Fx || 1) * (8 + spin * 30), 120 * h);
      else w.angVel = roll;
      w.slipLat = vT;
      const longSlide = locked ? Math.abs(vL) : spin > 0 ? spin * 6 + 2 : 0;
      w.skidding = clamp((Math.abs(vT) - 1.8) / 4.5 + (longSlide > 1.5 ? longSlide / 8 : 0), 0, 1) * (w.surface === 'asphalt' || w.surface === 'concrete' ? 1 : 0.6);
      slipSum += w.skidding;
      // landing a big jump badly throws the rider off
      if (rider && (this.airT || 0) > 0.3 && vel.y < -9.5) this.crashPending = 'landing';
    }
    this.wheelSlip = slipSum / 2;
    this.latForce = latSum;

    // ------------------------------------------------ pitch: wheelie / stoppie limits, air control
    let pitchTq = 0;
    if (this.pitch > wheelieMax) pitchTq += this.Ipitch * 10 * (this.pitch - wheelieMax);
    // the rider throws his weight forward when the front comes up uninvited
    if (rider && wheelieIn < 0.1 && this.pitch > 0.06 && grounded > 0) pitchTq += this.Ipitch * (6 * (this.pitch - 0.06) + 1.5 * Math.max(0, -pitchRateNoseDown));
    if (rear.grounded && !frontW.grounded && rider && (inp.wheelie || 0) > 0.1 && v < 30) pitchTq -= this.Ipitch * 3.5 * inp.wheelie * clamp(1 - this.pitch / wheelieMax, 0, 1);
    else if (rear.grounded && frontW.grounded && rider && (inp.wheelie || 0) > 0.1 && throttle > 0.5 && v < 22) pitchTq -= this.Ipitch * 9 * inp.wheelie; // pop the front up
    if (this.pitch < -0.32) pitchTq += this.Ipitch * 12 * (this.pitch + 0.32); // stoppie: nose back up
    if (grounded === 0 && rider) {
      // in the air: lean forward / back to level the bike, and pitch rate damping
      pitchTq += this.Ipitch * (2.2 * (clamp(inp.brake, 0, 1) - clamp(inp.throttle, 0, 1)) * -1 - 0.8 * pitchRateNoseDown);
      pitchTq += this.Ipitch * 1.2 * this.pitch;
    }
    if (pitchTq) body.applyTorqueImpulse({ x: _lh.x * pitchTq * h, y: _lh.y * pitchTq * h, z: _lh.z * pitchTq * h }, true);

    // ------------------------------------------------ aero
    if (this.speed > 0.1) {
      const drag = 0.5 * 1.2 * T.dragCA * this.speed;
      body.applyImpulse({ x: -vel.x * drag * h, y: -vel.y * drag * h, z: -vel.z * drag * h }, true);
    }

    // ------------------------------------------------ crash detection (rider thrown off)
    this.airT = grounded === 0 ? (this.airT || 0) + h : 0;
    if (rider) {
      // sustained loss of control: sliding out sideways, falling over, looping or flipping
      const slideOut = this.wheels.every((w) => w.grounded && Math.abs(w.slipLat) > 4.5) && v > 6;
      const bad = slideOut || Math.abs(this.lean) > T.maxLean + 0.3 || Math.abs(this.pitch) > 1.0 || _up.y < 0.25;
      this.badT = bad ? (this.badT || 0) + h : 0;
      if (this.badT > 0.22) this.crashPending = this.crashPending || (slideOut ? 'slid out' : 'lost control');
    }
  }

  update(dt) {
    if (this.removed) return;
    const t = this.body.translation(), r = this.body.rotation();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
    this.crashT = Math.max(0, this.crashT - dt);
    this.hold = Math.max(0, this.hold - dt);
    if (this.crashPending) { const why = this.crashPending; this.crashPending = null; this.crash(why); }
    if (this.driver && !this.driver.alive) this.crash('rider down');
    // sleep when parked
    if (!this.driver && !this.hold && !this.body.isSleeping()) {
      const av = this.body.angvel();
      if (this.speed < 0.06 && Math.abs(av.x) + Math.abs(av.y) + Math.abs(av.z) < 0.06) this.idleT = (this.idleT || 0) + dt; else this.idleT = 0;
      if (this.idleT > 1.0) { this.body.sleep(); this.idleT = 0; }
    }
    // lights
    const L = this.model.lights;
    this.brakeLight = damp(this.brakeLight, (this.effBrake || 0) > 0.1 ? 1 : 0, 20, dt);
    const night = this.game.night ? 1 : 0;
    const occ = !!this.driver;
    const rainy = this.game.weather ? this.game.weather.rain > 0.3 : false;
    L.head.emissiveIntensity = this.headBroken ? 0 : occ ? (night || rainy || this.lightsOn ? 3.4 : 1.2) : 0.05;
    L.tail.emissiveIntensity = this.tailBroken ? 0 : (occ ? (night ? 1.6 : 0.7) : 0.05) + this.brakeLight * 3.5;
  }

  syncVisual() {
    if (this.removed) return;
    const t = this.body.translation(), r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.curPos.copy(this.root.position);
    this.curQuat.copy(this.root.quaternion);
    const M = this.model;
    const [wF, wR] = this.wheels;
    // front: bars turn about the fork axis, sliders and wheel move along it with the suspension
    M.steer.rotation.y = this.steerAngle;
    const cF = wF.grounded ? wF.comp : 0;
    wF.visualComp = damp(wF.visualComp ?? cF, cF, 30, 1 / 60);
    M.slider.position.y = wF.visualComp - wF.c0;
    wF.spinAngle += wF.angVel / 60;
    M.frontWheel.spin.rotation.x = wF.spinAngle;
    wF.visualY = wF.hubStatic.y + (wF.visualComp - wF.c0) * wF.axisL.y;
    // rear: the swingarm pivots so the axle follows the shock
    const cR = wR.grounded ? wR.comp : 0;
    wR.visualComp = damp(wR.visualComp ?? cR, cR, 30, 1 / 60);
    const hubY = wR.hubStatic.y + (wR.visualComp - wR.c0);
    wR.visualY = hubY;
    const py = this.T.pivot[1];
    M.swing.rotation.x = Math.asin(clamp((hubY - py) / M.armLen, -1, 1));
    wR.spinAngle += wR.angVel / 60;
    M.rearWheel.spin.rotation.x = wR.spinAngle;
    // kickstand
    const standOut = !this.driver && this.standDown && !this.fallen;
    M.kick.rotation.x = damp(M.kick.rotation.x, standOut ? 0.25 : -1.45, 10, 1 / 60);
    M.kick.rotation.z = damp(M.kick.rotation.z, standOut ? 0.35 : 0, 10, 1 / 60);
    this.root.updateMatrixWorld(true);
  }

  /* ---------------------------------------------------------------- rider */
  /** Throw the rider off (crash, hit, shot). The bike carries on without balance and falls. */
  crash(why = 'crash') {
    const rider = this.driver;
    if (!rider) return;
    this.lastCrash = why;
    // (the bike may already have stopped against whatever it hit; the rider carries on)
    const vel = this.linvel(new THREE.Vector3());
    for (const pv of [this.velPrev, this.velCur]) if (pv.lengthSq() > vel.lengthSq()) vel.copy(pv);
    const speed = vel.length();
    rider.leaveVehicleInstant();
    rider.state = 'foot';
    rider.seq = null;
    rider.clearHands();
    rider.driveBy = null;
    this.setRiderCollider(false);
    this.standDown = false;
    const side = Math.sign(this.lean || (Math.random() - 0.5)) || 1;
    _v.set(side * (1.2 + Math.random()), 1.4 + speed * 0.05, 0).applyQuaternion(this.curQuat);
    vel.multiplyScalar(0.9).add(_v);
    rider.rig.root.updateMatrixWorld(true);
    rider.ignoreVeh = this;
    rider.ignoreVehUntil = this.physics.time + 0.45;
    rider.toRagdoll(vel, { spin: 1.4 + speed * 0.08 });
    if (rider.alive) rider.damage(Math.max(0, speed - 7) * 2.2, 'bike', null);
    this.game.audio?.bodyHit?.(this.curPos, Math.min(15, speed));
    this.game.onBikeCrash?.(this, rider, why);
  }

  /** The rider is getting on / off: hold the bike at `lean` for t seconds. */
  holdUpright(t, lean = 0) {
    this.hold = Math.max(this.hold, t);
    this.holdLean = lean;
    this.body.wakeUp();
  }

  /** Stand a fallen bike back up (instant; used by the pick-up animation at its end and by R). */
  flip() {
    const t = this.body.translation();
    const f = this.forward(_v);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
    const yaw = Math.atan2(f.x, f.z);
    _q.setFromAxisAngle(_Y, yaw);
    this.body.setTranslation({ x: t.x, y: t.y + 0.35, z: t.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.fallen = false;
    this.standDown = !this.driver;
    this.setFallen(false);
  }

  /* ---------------------------------------------------------------- damage */
  applyDamage(worldPoint, impulse, otherOwner) {
    // (contact impulses are per physics step; a bike is light, so these are small numbers)
    const sev = clamp((impulse - 150) / 2600, 0, 1);
    if (this.crashT <= 0) this.crashPeak = 0;
    if (sev > this.crashPeak) { this.health = Math.max(0, this.health - (sev - this.crashPeak) * 26); this.crashPeak = sev; }
    if (sev > 0) this.crashT = Math.max(this.crashT, 0.3);
    // hit hard enough: the rider comes off
    if (this.driver && impulse > 260 && !(otherOwner && (otherOwner.type === 'ragdoll' || otherOwner.type === 'prop'))) this.crashPending = 'impact';
    if (sev > 0.6) this.headBroken = this.headBroken || Math.random() < 0.5;
  }

  /** The rider took a hit (not fatal): AI riders usually lose it, the player hangs on. */
  onRiderHit(amount, cause, rider) {
    if (rider === this.game.player.character) return;
    if (cause === 'shot' && Math.random() < 0.7) this.crashPending = this.crashPending || 'shot';
  }

  burstTire(i) {
    const w = this.wheels[i];
    if (!w || w.burst) return;
    w.burst = true;
    const p = this.localToWorld(_v.set(0, w.visualY, w.z), new THREE.Vector3());
    this.game.effects?.debrisBurst(p, new THREE.Color(0.05, 0.05, 0.05), 10);
    this.game.audio?.tyreBurst?.(p);
    const spin = i === 0 ? this.model.frontWheel.spin : this.model.rearWheel.spin;
    if (spin.children[0]) spin.children[0].scale.set(1, 0.86, 0.86);
  }

  bulletTire(local) {
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      if (Math.abs(local.x) > w.tw * 0.8) continue;
      if (Math.hypot(local.y - w.visualY, local.z - w.z) > w.r * 1.03) continue;
      this.burstTire(i);
      return true;
    }
    return false;
  }

  /** Bullets above the tank hit the rider directly. */
  glassHit(local) {
    return local.y > this.T.seat[1] - 0.05;
  }

  repair() {
    this.health = 100;
    this.headBroken = false;
    this.tailBroken = false;
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      if (!w.burst) continue;
      w.burst = false;
      const spin = i === 0 ? this.model.frontWheel.spin : this.model.rearWheel.spin;
      if (spin.children[0]) spin.children[0].scale.set(1, 1, 1);
    }
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.game.scene.remove(this.root);
    this.physics.removeBody(this.body);
    this.root.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    this.model.paint.dispose();
    this.model.paint2.dispose();
    for (const m of Object.values(this.model.lights)) m.dispose();
    this.model.plateMat.map?.dispose();
    this.model.plateMat.dispose();
  }
}

export { BIKE_TYPES };
