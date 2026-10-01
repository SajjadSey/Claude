import * as THREE from 'three';
import { R, G, groups } from '../core/physics.js';
import { clamp, lerp, damp, approach, wrapAngle, quatFromYaw, smoothstep } from '../core/util.js';
import { solveTwoBone, setWorldQuat } from '../char/ik.js';
import { buildHeliModel, disposeHeliModel, HELI } from '../vehicle/heliModel.js';
import { WEAPONS } from './weapons.js';

/*
 * Police helicopter (4-5 stars): a dynamic rigid body flown by a controller that tilts the rotor
 * thrust like a real helicopter. It circles the player with its open door facing him so the
 * gunner can shoot, climbs over buildings, sweeps a searchlight at night, and can be shot down
 * (spins down trailing smoke and explodes where it hits). Pilot and door gunner are full
 * characters posed in their seats.
 */

const GRAV = 9.81;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3();
const _f = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qShin = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _pole = new THREE.Vector3();
const _e = new THREE.Euler();

// door gunner: hit chance per shot and damage, by wanted level
const GUN_ACC = { 4: 0.16, 5: 0.22 };
const GUN_DMG = { 4: 8, 5: 9 };

let nextId = 1;

export class Heli {
  constructor(game, pos, yaw, opts = {}) {
    this.game = game;
    this.physics = game.physics;
    this.id = nextId++;
    this.isHeli = true;
    this.model = buildHeliModel();
    this.root = this.model.root;
    game.scene.add(this.root);
    this.health = 100;
    this.state = 'flying'; // flying | leaving | down | wreck
    this.removed = false;
    this.curPos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.curQuat = quatFromYaw(yaw, new THREE.Quaternion());
    this.vel = new THREE.Vector3();
    this.rotorSpin = 1; // 0..1
    this.rotorAngle = 0;
    this.tailAngle = 0;
    this.orbitA = Math.random() * Math.PI * 2;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.goal = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.goalVel = new THREE.Vector3();
    this.altGoal = pos.y;
    this.yawGoal = yaw;
    this.planT = 0;
    this.fireT = 2.5;
    this.burst = 0;
    this.lightAim = new THREE.Vector3(pos.x, 0, pos.z);
    this.sweepA = 0;
    this.smokeT = 0;
    this.wreckT = 0;
    this.strikeT = 0;
    this.seesPlayer = false;
    this.lastPlayerHitT = -99;

    // ---- rigid body
    const m = HELI.mass;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: this.curQuat.x, y: this.curQuat.y, z: this.curQuat.z, w: this.curQuat.w })
      .setAdditionalMassProperties(m, { x: 0, y: 1.45, z: -0.2 }, { x: m * 3.2, y: m * 3.6, z: m * 0.9 }, { x: 0, y: 0, z: 0, w: 1 })
      .setLinearDamping(0.02)
      .setAngularDamping(0.6)
      .setCcdEnabled(true)
      .setCanSleep(false);
    if (opts.vel) desc.setLinvel(opts.vel.x, opts.vel.y, opts.vel.z);
    this.body = this.physics.world.createRigidBody(desc);
    const owner = { type: 'heli', heli: this, surface: 'metal' };
    const add = (cd) => {
      cd.setDensity(0).setFriction(0.5).setRestitution(0.1)
        .setCollisionGroups(groups(G.CAR, G.ALL))
        .setSolverGroups(groups(G.CAR, G.ALL & ~G.CHAR))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(6000);
      const c = this.physics.world.createCollider(cd, this.body);
      this.physics.setOwner(c, owner);
      return c;
    };
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const rot = { x: qz.x, y: qz.y, z: qz.z, w: qz.w };
    add(R.ColliderDesc.capsule(1.25, 0.86).setTranslation(0, HELI.bodyY, 0.45).setRotation(rot)); // cabin
    add(R.ColliderDesc.capsule(2.2, 0.3).setTranslation(0, 1.95, -4.15).setRotation(rot)); // tail boom
    add(R.ColliderDesc.cuboid(0.06, 0.6, 0.45).setTranslation(0, 2.45, -6.6)); // fin
    add(R.ColliderDesc.cuboid(1.1, 0.07, 1.65).setTranslation(0, 0.08, 0)); // skids

    // ---- crew: pilot (right front) and the door gunner (open left door)
    const police = game.police;
    this.pilot = police.makeCop(Math.floor(Math.random() * 1e9));
    this.gunner = police.makeCop(Math.floor(Math.random() * 1e9));
    this.gunner.setWeapon('rifle');
    this.pilot.setWeapon('fists');
    for (const [c, seat] of [[this.pilot, 'pilot'], [this.gunner, 'gunner']]) {
      c.heliCrew = { heli: this, seat };
      c.state = 'heli';
      c.setCapsuleEnabled(false);
      c.aimW = 0;
      c.helmetOn = false;
    }
    game.aircraft.push(this);
  }

  get speed() { return this.vel.length(); }
  forward(out) { return out.set(0, 0, 1).applyQuaternion(this.curQuat); }
  localToWorld(local, out) { return out.copy(local).applyQuaternion(this.curQuat).add(this.curPos); }
  worldToLocal(world, out) { _q.copy(this.curQuat).invert(); return out.copy(world).sub(this.curPos).applyQuaternion(_q); }

  /** Ground (or water/roof) height under a point, ignoring the helicopter itself. */
  groundBelow(p, maxD = 200) {
    _v3.set(p.x, p.y - 0.5, p.z);
    const hit = this.physics.raycast(_v3, _down, maxD, groups(G.ALL, G.STATIC), this.body);
    return hit ? hit.point.y : 0;
  }

  /* ================================================================ AI */
  leave() {
    if (this.state !== 'flying') return;
    this.state = 'leaving';
    const pp = this.game.police.playerPos(_v);
    _d.subVectors(this.curPos, pp).setY(0);
    if (_d.lengthSq() < 1) _d.set(1, 0, 0);
    _d.normalize();
    this.goal.copy(this.curPos).addScaledVector(_d, 900);
    this.goalVel.set(0, 0, 0);
    this.altGoal = Math.max(this.curPos.y, 90);
  }

  /** Where to fly, how high, which way to face (10 Hz). */
  plan(dt) {
    const g = this.game, P = g.police, W = P.wanted, city = g.city;
    const pos = this.curPos;
    if (this.state === 'leaving') {
      _d.subVectors(this.goal, pos).setY(0).normalize();
      this.yawGoal = Math.atan2(_d.x, _d.z);
      this.altGoal = Math.max(90, city.roofHeight(pos.x + _d.x * 40, pos.z + _d.z * 40, 30) + 25);
      return;
    }
    const seen = W.seen;
    const tgt = seen ? P.playerPos(_v) : _v.copy(W.lastKnown);
    const tv = seen ? P.playerVel(_v2).setY(0) : _v2.set(0, 0, 0);
    if (tv.length() > 40) tv.setLength(40);
    const fast = tv.length() > 9;
    // circle the target with the gunner's door towards it; follow a fast target from behind and to the side
    const R0 = seen ? (fast ? 34 : 30) : 52;
    const orbitSpeed = seen ? 7 : 11;
    this.orbitA += this.orbitDir * orbitSpeed / R0 * dt;
    _d.set(Math.cos(this.orbitA), 0, Math.sin(this.orbitA));
    this.goal.copy(tgt).addScaledVector(_d, R0).addScaledVector(tv, fast ? 1.2 : 0.5);
    this.goal.y = 0;
    this.goalVel.copy(tv);
    // altitude: above everything near the goal, near us and along the way
    let roof = Math.max(city.roofHeight(this.goal.x, this.goal.z, 10), city.roofHeight(pos.x, pos.z, 10));
    for (let k = 1; k <= 5; k++) {
      const t = k / 5;
      roof = Math.max(roof, city.roofHeight(lerp(pos.x, this.goal.x, t), lerp(pos.z, this.goal.z, t), 9));
    }
    // look ahead along the current velocity too (a few seconds of flight)
    const vh = Math.hypot(this.vel.x, this.vel.z);
    for (const s of [1.2, 2.5, 4]) if (vh > 2) roof = Math.max(roof, city.roofHeight(pos.x + this.vel.x * s, pos.z + this.vel.z * s, 10));
    const gy = Math.max(0, tgt.y);
    const want = clamp(Math.max(gy + (seen ? 28 : 40), roof + 14), 22, 150);
    // climb at once; come down only after a while, and slowly (towers come and go along the orbit)
    if (want >= this.altGoal) { this.altGoal = want; this.lowT = 0; }
    else {
      this.lowT = (this.lowT || 0) + dt;
      if (this.lowT > 2.5) this.altGoal = Math.max(want, this.altGoal - 2.5 * dt);
    }
    // the highest thing on the way: don't move towards it until we're above it
    this.clearAlt = roof + 9;
    // face: door (left side) to the target when close, else the way we're going
    _d.subVectors(tgt, pos).setY(0);
    const dist = _d.length();
    if (dist < 95 && this.gunner.alive) {
      _d.divideScalar(Math.max(dist, 1e-3));
      this.yawGoal = Math.atan2(-_d.z, _d.x);
    } else {
      _d.subVectors(this.goal, pos).setY(0);
      if (_d.lengthSq() > 4) this.yawGoal = Math.atan2(_d.x, _d.z);
    }
  }

  /* ================================================================ physics */
  prePhysics(h) {
    if (this.removed) return;
    const body = this.body;
    const t = body.translation(), r = body.rotation(), lv = body.linvel();
    const pos = _v.set(t.x, t.y, t.z);
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _f.set(0, 0, 1).applyQuaternion(_q);
    const m = HELI.mass;
    if (this.state === 'flying' || this.state === 'leaving') {
      // horizontal: velocity towards the goal (plus the target's own velocity), acceleration limited
      _d.set(this.goal.x - pos.x, 0, this.goal.z - pos.z);
      const maxSpd = this.state === 'leaving' ? 30 : 26;
      _w.copy(_d).multiplyScalar(0.45);
      if (_w.length() > maxSpd) _w.setLength(maxSpd);
      _w.add(this.goalVel);
      // too low for what's ahead: hold position and climb first
      const low = (this.clearAlt ?? -1e9) - pos.y;
      if (low > 0) _w.multiplyScalar(clamp(1 - low / 12, 0.05, 1));
      const ax = clamp((_w.x - lv.x) * 1.1, -8, 8), az = clamp((_w.z - lv.z) * 1.1, -8, 8);
      // vertical
      const ay = clamp((this.altGoal - pos.y) * 0.55 - lv.y * 1.5, -4.5, 6);
      // thrust vector (tilt limited to 32 degrees)
      _d.set(ax, ay + GRAV, az);
      const hz = Math.hypot(_d.x, _d.z), lim = Math.tan(0.56) * _d.y;
      if (hz > lim) { _d.x *= lim / hz; _d.z *= lim / hz; }
      const thrust = m * _d.length();
      _d.normalize();
      // attitude: tilt the disc towards the thrust direction; yaw towards the goal heading
      _w.crossVectors(_up, _d).multiplyScalar(3.2);
      const yaw = Math.atan2(_f.x, _f.z);
      _w.y += clamp(wrapAngle(this.yawGoal - yaw) * 1.4, -0.85, 0.85);
      body.setAngvel({ x: _w.x, y: _w.y, z: _w.z }, true);
      const k = Math.max(0.2, _up.dot(_d)) * this.rotorSpin;
      body.applyImpulse({ x: _up.x * thrust * k * h, y: _up.y * thrust * k * h, z: _up.z * thrust * k * h }, true);
    } else if (this.state === 'down') {
      // tail rotor gone: spinning, losing lift, wobbling
      this.downT += h;
      const spin = Math.min(4.2, 1 + this.downT * 1.6) * this.spinDir;
      const av = body.angvel();
      const wob = Math.sin(this.downT * 3.1) * 0.5;
      body.setAngvel({ x: lerp(av.x, _f.z * wob * 0.6, 0.05), y: spin, z: lerp(av.z, -_f.x * wob * 0.6, 0.05) }, true);
      const lift = m * GRAV * clamp(0.82 - this.downT * 0.08, 0.35, 0.82) * this.rotorSpin;
      body.applyImpulse({ x: _up.x * lift * h, y: _up.y * lift * h, z: _up.z * lift * h }, true);
    }
  }

  /* ================================================================ per frame */
  update(dt) {
    if (this.removed) return;
    const g = this.game, P = g.police, W = P.wanted;
    const t = this.body.translation(), r = this.body.rotation(), lv = this.body.linvel();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
    this.vel.set(lv.x, lv.y, lv.z);
    // fell out of the world or flew off for good
    const camD = this.curPos.distanceTo(g.camera.position);
    if (this.curPos.y < -30 || (this.state === 'leaving' && camD > 330)) { this.remove(); return; }
    if (this.state === 'flying' || this.state === 'leaving') {
      this.planT -= dt;
      if (this.planT <= 0) { this.plan(Math.max(0.1, -this.planT + 0.1)); this.planT = 0.1; }
      // a pilot who is hit badly or killed can't fly
      if (!this.pilot.alive) this.goDown('pilot');
      this.rotorStrikeCheck(dt);
    }
    if (this.state === 'down') {
      this.rotorSpin = Math.max(0.55, this.rotorSpin - dt * 0.05);
      // hit the ground / a roof
      const agl = this.curPos.y - this.groundBelow(this.curPos, 6);
      if (agl < 1.3 || this.downT > 14) this.explode();
    }
    if (this.state === 'wreck') {
      this.rotorSpin = Math.max(0, this.rotorSpin - dt * 0.4);
      this.wreckT += dt;
      if (this.wreckT < 22 && Math.random() < dt * 30) g.effects.fire(this.localToWorld(_v.set(0, 1.6, -0.6), _v), clamp(1.4 - this.wreckT / 20, 0.4, 1.3));
      if (Math.random() < dt * 10) g.effects.engineSmoke(this.localToWorld(_v.set(0, 2.2, -0.6), _v), true);
      if ((this.wreckT > 45 && camD > 70) || this.wreckT > 150) { this.remove(); return; }
    } else {
      // damage smoke / fire from the engine bay
      if (this.health < 55 && Math.random() < dt * (this.health < 25 ? 30 : 12)) g.effects.engineSmoke(this.localToWorld(_v.set(0, 2.5, -1.3), _v), this.health < 30);
      if ((this.health < 25 || this.state === 'down') && Math.random() < dt * 20) g.effects.fire(this.localToWorld(_v.set(0, 2.45, -1.0), _v), 0.6);
    }
    // sight & gunner
    this.seesPlayer = this.state === 'flying' && this.canSee(P.playerChest(_v2));
    this.updateGunner(dt);
    this.updateLights(dt);
    this.downwash(dt);
  }

  /** Line of sight from under the nose to a point. */
  canSee(p) {
    const pos = this.curPos;
    if (Math.hypot(p.x - pos.x, p.z - pos.z) > 190) return false;
    this.localToWorld(_v3.set(0, 0.4, 1.4), _v3);
    _d.subVectors(p, _v3);
    const len = _d.length();
    if (len < 1) return true;
    _d.divideScalar(len);
    return !this.physics.raycast(_v3, _d, len - 0.5, groups(G.ALL, G.STATIC), this.body);
  }

  /** Blades clipping a building: the helicopter is finished. */
  rotorStrikeCheck(dt) {
    this.strikeT -= dt;
    if (this.strikeT > 0) return;
    this.strikeT = 0.1;
    this.localToWorld(_v.set(0, HELI.rotorY, HELI.rotorZ), _v);
    const a = (this.rotorAngle * 3.1) % (Math.PI * 2);
    for (let k = 0; k < 4; k++) {
      const ang = a + k * Math.PI / 2;
      _d.set(Math.cos(ang), 0, Math.sin(ang));
      if (this.physics.raycast(_v, _d, HELI.rotorR - 0.2, groups(G.ALL, G.STATIC), this.body)) {
        this.health = 0;
        this.goDown('rotor strike');
        this.game.effects.sparkBurst(_v.addScaledVector(_d, HELI.rotorR - 0.6), _d, 30, 8);
        this.game.audio?.metalHit?.(_v, 1);
        return;
      }
    }
  }

  /* ================================================================ gunner */
  updateGunner(dt) {
    const g = this.game, P = g.police, W = P.wanted, pc = g.player.character;
    const c = this.gunner;
    this.fireT -= dt;
    const can = c.alive && this.state === 'flying' && W.stars >= 4 && W.seen && this.seesPlayer && pc.alive && !g.bustedT;
    let aimP = null;
    if (can) {
      aimP = P.playerChest(c.aimVec || (c.aimVec = new THREE.Vector3()));
      // only out of the door: the target must be off the left side, or steeply below (leaning out)
      const local = this.worldToLocal(aimP, _v);
      const d = local.length(), horiz = Math.hypot(local.x, local.z);
      if (!(local.x > 0.3 * horiz || -local.y > 1.7 * horiz) || d > 115) aimP = null;
    }
    c.aimW = approach(c.aimW || 0, aimP ? 1 : 0, dt * 3);
    // between bursts / with nothing to shoot at, the rifle points out of the door and down
    if (!c.lastAim) c.lastAim = this.localToWorld(_v.set(6, -3, -0.4), new THREE.Vector3());
    const want = aimP || this.localToWorld(_v.set(6, -3, -0.4), _v3);
    c.lastAim.lerp(want, 1 - Math.exp(-dt * (aimP ? 6 : 3)));
    if (aimP) {
      if (this.fireT <= 0 && c.aimW > 0.9) {
        this.fire(c);
        this.burst++;
        if (this.burst >= 4 + (W.stars >= 5 ? 2 : 0)) { this.burst = 0; this.fireT = 1.7 + Math.random() * 1.2; }
        else this.fireT = 0.13;
      }
    }
  }

  fire(c) {
    const g = this.game, P = g.police, W = P.wanted, pc = g.player.character;
    const muzzle = c.muzzleWorld(new THREE.Vector3());
    const chest = P.playerChest(new THREE.Vector3());
    _d.subVectors(chest, muzzle);
    const dist = _d.length();
    _d.divideScalar(dist);
    const Ph = this.physics;
    const pveh0 = pc.state === 'vehicle' ? pc.vehicle : null;
    const pveh = pveh0 && !pveh0.isBike ? pveh0 : null;
    const block = Ph.raycast(muzzle, _d, dist - 0.4, groups(G.ALL, G.STATIC | (pveh0 ? 0 : G.CAR)), this.body);
    const stars = Math.min(5, Math.max(4, W.stars));
    let p = GUN_ACC[stars] * clamp(1.35 - dist / 70, 0.35, 1);
    if (pc.state === 'foot' && pc.speedScalar > 4) p *= 0.65;
    if (pveh) p *= 0.8;
    else if (pveh0) p *= clamp(1.1 - pveh0.speed / 40, 0.45, 1);
    const hit = !block && Math.random() < p;
    let end;
    if (hit) {
      end = chest.clone();
      if (pveh) {
        pc.damage(GUN_DMG[stars] * 0.6, 'shot', c);
        pveh.health = Math.max(0, pveh.health - 1.5);
        if (Math.random() < 0.3) g.effects.glass(chest, 0.2);
      } else {
        pc.damage(GUN_DMG[stars], 'shot', c);
        g.effects.bloodHit?.(chest, _d, 0.6);
        g.audio.bulletImpact(chest, true);
      }
      g.camRig.shake(0.12);
      g.hud.hit?.();
    } else {
      // a miss: the round strikes something near the target
      _v.set(-_d.z, 0, _d.x).multiplyScalar((Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.4));
      _v.y = -0.5 + Math.random() * 1.1;
      _v2.copy(chest).add(_v).sub(muzzle).normalize();
      const h = block || Ph.raycast(muzzle, _v2, 140, groups(G.ALL, G.STATIC | G.CAR | G.PROP), this.body);
      if (h) {
        end = h.point.clone();
        g.effects.bulletHit(end, h.normal);
        g.audio.bulletImpact(end, false);
      } else end = muzzle.clone().addScaledVector(_v2, 140);
      if (chest.distanceTo(end) < 6) g.audio.whiz(chest);
    }
    g.effects.muzzle(muzzle, _d);
    g.audio.gunshot(muzzle, 'rifle');
    g.ballistics.tracer(muzzle, end);
    c.recoilT = 1;
  }

  /* ================================================================ crew poses */
  poseCrew(c, dt) {
    const rig = c.rig, s = rig.scale, L = rig.L;
    const gunner = c === this.gunner;
    rig.resetPose();
    const seat = gunner ? HELI.gunnerSeat : HELI.pilotSeat;
    // the gunner sits sideways in the door, facing out; the pilot faces forward
    _q.copy(this.curQuat);
    if (gunner) _q.multiply(_q2.setFromAxisAngle(_Y, Math.PI / 2));
    rig.root.quaternion.copy(_q);
    this.localToWorld(_v.set(seat[0], seat[1], seat[2]), _v);
    _v2.set(0, L.hipsY * s * 0.97, 0).applyQuaternion(_q);
    rig.root.position.copy(_v).sub(_v2);
    c.pos.copy(_v);
    _f.set(0, 0, 1).applyQuaternion(_q);
    c.yaw = Math.atan2(_f.x, _f.z);
    if (!c.alive) {
      // slumped in the seat
      _e.set(0.5, 0, 0.25, 'XYZ');
      rig.bones.spine.quaternion.setFromEuler(_e);
      _e.set(0.6, 0.2, 0, 'XYZ');
      rig.bones.neck.quaternion.setFromEuler(_e);
    }
    rig.root.updateMatrixWorld(true);
    // legs: pilot's feet on the pedals, gunner's on the skid step
    const left = _v3.set(1, 0, 0).applyQuaternion(_q);
    for (const [leg, sd] of [['L', 1], ['R', -1]]) {
      if (gunner) this.localToWorld(_v.set(HELI.gunnerFeet[0], HELI.gunnerFeet[1], HELI.gunnerFeet[2] + sd * 0.17), _v);
      else this.localToWorld(_v.set(seat[0] + sd * 0.13, 0.8, seat[2] + 0.62), _v);
      _v.y += L.ankle * 0.6;
      _pole.copy(_f).addScaledVector(left, sd * 0.25).addScaledVector(_Y, 0.3);
      solveTwoBone(rig.bones['thigh' + leg], rig.bones['shin' + leg], _v, _pole, 1, L.thigh, L.shin, 1, _qShin);
      _qShin.invert();
      rig.bones['foot' + leg].quaternion.copy(_qShin).multiply(_q);
    }
    // hands
    c.recoilT = Math.max(0, (c.recoilT || 0) - dt * 9);
    if (gunner) {
      const W = WEAPONS[c.weapon];
      if (!c.lastAim) c.lastAim = this.localToWorld(_v.set(6, -3, -0.4), new THREE.Vector3());
      if (c.alive && W && W.hold) {
        if (c.gun) c.gun.visible = true;
        c.weaponPose(W, 1, 0);
      } else { c.handIK.L = c.handIK.R = null; if (c.gun) c.gun.visible = false; }
    } else {
      if (c.alive) {
        // right hand on the cyclic, left on the collective
        this.localToWorld(_v.set(seat[0] - 0.02, 0.98, seat[2] + 0.36), _v);
        _pole.copy(left).multiplyScalar(-0.6).addScaledVector(_Y, -0.6);
        c.setHand('R', _v, 1, null, _pole, 0.95);
        this.localToWorld(_v.set(seat[0] + 0.3, 0.9, seat[2] + 0.12), _v);
        _pole.copy(left).multiplyScalar(0.6).addScaledVector(_Y, -0.6);
        c.setHand('L', _v, 1, null, _pole, 0.95);
      } else c.handIK.L = c.handIK.R = null;
    }
    // head: watches the target (or looks ahead)
    rig.root.updateMatrixWorld(true);
    if (c.alive) {
      const tgt = this.game.police.wanted.seen ? this.game.police.playerPos(_v2) : this.game.police.wanted.lastKnown;
      rig.bones.head.getWorldPosition(_v);
      _d.subVectors(tgt, _v);
      const yawT = Math.atan2(_d.x, _d.z);
      const yawRel = clamp(wrapAngle(yawT - c.yaw), -1.1, 1.1);
      const pitch = clamp(Math.atan2(_d.y, Math.hypot(_d.x, _d.z)), -0.9, 0.4);
      quatFromYaw(c.yaw + yawRel, _q2);
      _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
      _q2.multiply(_q);
      setWorldQuat(rig.bones.head, _q2);
    }
  }

  /* ================================================================ searchlight, nav lights */
  updateLights(dt) {
    const g = this.game, P = g.police, W = P.wanted, M = this.model;
    const alive = this.state === 'flying' || this.state === 'leaving';
    // blinking strobe and beacons
    const tt = g.time;
    M.mats.strobe.emissiveIntensity = alive && (tt % 1.2) < 0.07 ? 9 : 0;
    M.mats.beacon.emissiveIntensity = alive && (tt % 0.9) < 0.45 ? 4 : 0.2;
    // searchlight target: the player while tracked, otherwise sweeping the last known area
    let aim;
    if (this.state === 'flying' && W.seen) aim = P.playerPos(_v);
    else {
      this.sweepA += dt * 0.55;
      const c = this.state === 'flying' ? W.lastKnown : this.localToWorld(_v2.set(0, -30, 25), _v2);
      aim = _v.set(c.x + Math.cos(this.sweepA) * 22, Math.max(0, c.y), c.z + Math.sin(this.sweepA * 1.3) * 22);
    }
    this.lightAim.lerp(aim, 1 - Math.exp(-dt * (W.seen ? 4 : 1.5)));
    // gimbal follows (limited to the lower hemisphere)
    const gm = M.gimbal;
    this.root.updateMatrixWorld(true);
    gm.parent.worldToLocal(_v2.copy(this.lightAim));
    _d.subVectors(_v2, gm.position);
    const dl = _d.length();
    if (_d.y > -0.2 * dl) _d.y = -0.2 * dl; // it can't look up through the fuselage
    gm.parent.localToWorld(_v2.copy(gm.position).add(_d));
    gm.lookAt(_v2);
    this.lightOn = !!g.night && alive;
  }

  downwash(dt) {
    if (this.state === 'wreck' || this.rotorSpin < 0.5) return;
    const pos = this.curPos;
    const gy = this.groundBelow(pos, 40);
    const agl = pos.y - gy;
    if (agl > 32) return;
    const k = (1 - agl / 32) * this.rotorSpin;
    if (Math.random() < dt * 30 * k) {
      const a = Math.random() * Math.PI * 2, rr = 2 + Math.random() * 6 * (1 + k);
      this.game.effects.dust(_v.set(pos.x + Math.cos(a) * rr, gy + 0.2, pos.z + Math.sin(a) * rr), 0.6 + k);
    }
  }

  /* ================================================================ damage */
  bulletHit(point, dir, W, shooter) {
    const g = this.game;
    if (this.state === 'wreck') { g.effects.bulletHit(point, _d.copy(dir).negate()); return; }
    if (shooter && shooter.isPlayer) {
      this.lastPlayerHitT = g.time;
      this.pilot.lastPlayerHitT = this.gunner.lastPlayerHitT = g.time;
    }
    // through the open door or the canopy: the crew
    const local = this.worldToLocal(point, _v);
    if (this.hitCrew(point, dir, W, shooter, local)) return;
    g.effects.bulletHit(point, _d.copy(dir).negate());
    g.effects.sparkBurst(point, _d, 3, 3);
    g.audio.metalHit(point, 0.15);
    this.health = Math.max(0, this.health - W.carDmg * 1.1);
    if (this.health <= 0 && (this.state === 'flying' || this.state === 'leaving')) this.goDown('shot');
  }

  hitCrew(point, dir, W, shooter, local) {
    const inDoor = local.x > 0.45 && local.z > -0.8 && local.z < 0.5 && local.y > 0.8 && local.y < 2.2;
    const inCanopy = local.z > 0.35 && local.y > HELI.bodyY - 0.2;
    if (!inDoor && !inCanopy) return false;
    let best = null, bt = 3.2, head = false;
    for (const c of [this.pilot, this.gunner]) {
      if (!c.alive) continue;
      for (const [bone, r, isHead] of [['head', 0.14, true], ['chest', 0.22, false], ['spine', 0.2, false]]) {
        c.rig.bones[bone].getWorldPosition(_v2);
        _d.subVectors(_v2, point);
        const t = _d.dot(dir);
        if (t < -0.3 || t > bt) continue;
        if (_d.lengthSq() - t * t < r * r) { bt = t; best = c; head = isHead; }
      }
    }
    if (inCanopy && !best) { this.game.effects.glass(point, 0.25); this.game.audio.glass?.(point); }
    if (!best) return false;
    const g = this.game;
    g.effects.bloodHit(_v2.copy(point).addScaledVector(dir, bt), dir, 1);
    const wasAlive = best.alive;
    best.damage(W.dmg * (head ? 4 : 1), 'shot', shooter);
    if (shooter && shooter.isPlayer) g.hud.hitMarker?.(wasAlive && !best.alive);
    return true;
  }

  /** Lost: tail rotor shot away / pilot hit / blades struck something. */
  goDown(why) {
    if (this.state === 'down' || this.state === 'wreck') return;
    const g = this.game;
    this.state = 'down';
    this.downT = 0;
    this.spinDir = Math.random() < 0.5 ? 1 : -1;
    this.health = Math.min(this.health, 10);
    this.body.setAngularDamping(0.3);
    this.whyDown = why;
    g.audio?.metalHit?.(this.curPos, 1);
    const byPlayer = g.time - this.lastPlayerHitT < 8;
    if (byPlayer) g.hud.message('🚁 Police chopper going down! · هلیکوپتر پلیس سقوط کرد', 2.5);
  }

  explode() {
    if (this.state === 'wreck') return;
    const g = this.game;
    this.state = 'wreck';
    this.wreckT = 0;
    this.health = 0;
    const p = this.curPos.clone();
    p.y += 1.4;
    g.explosions.blast(p, 16, { power: 1.3 });
    g.camRig.shake(clamp(1.3 - g.camera.position.distanceTo(p) / 70, 0.1, 1));
    g.effects.explosion(p);
    g.effects.explosion(_v.copy(p).add(_d.set(0, 1.5, -2).applyQuaternion(this.curQuat)));
    g.effects.debrisBurst?.(p, new THREE.Color(0.85, 0.87, 0.9), 26);
    g.audio?.explosion?.(p);
    // blackened wreck, rotor stopping
    for (const k of ['white', 'blue']) {
      const m = this.model.mats[k];
      m.color.setRGB(0.07, 0.065, 0.06);
      m.clearcoat = 0.05;
      m.roughness = 0.95;
      m.metalness = 0.15;
    }
    this.model.mats.glass.opacity = 0.15;
    this.model.disc.visible = false;
    this.body.setAngularDamping(1.5);
    this.body.setLinearDamping(0.3);
    // the crew don't survive
    for (const c of [this.pilot, this.gunner]) {
      if (c.removed) continue;
      c.lastPlayerHitT = this.lastPlayerHitT;
      if (c.alive) c.damage(500, 'explosion');
      c.heliCrew = null;
      c.state = 'foot';
      c.ignoreVeh = this;
      c.ignoreVehUntil = this.physics.time + 1.0;
      c.rig.root.updateMatrixWorld(true);
      _v.copy(this.vel).add(_v2.set((Math.random() - 0.5) * 6, 5 + Math.random() * 3, (Math.random() - 0.5) * 6));
      c.toRagdoll(_v, { spin: 3 });
    }
  }

  /** A hard knock from the physics (crashing into something). */
  onImpact(impulse) {
    if (this.state === 'down' && impulse > 2500) { this.explode(); return; }
    if ((this.state === 'flying' || this.state === 'leaving') && impulse > 9000) {
      this.health = Math.max(0, this.health - impulse / 900);
      if (this.health <= 0) this.goDown('collision');
    }
  }

  /* ================================================================ visuals */
  syncVisual(dt) {
    if (this.removed) return;
    const t = this.body.translation(), r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    this.curPos.copy(this.root.position);
    this.curQuat.copy(this.root.quaternion);
    const M = this.model;
    // the rotors turn slower on screen than for real: a readable blur instead of strobing
    this.rotorAngle += dt * 13.5 * this.rotorSpin;
    this.tailAngle += dt * 31 * this.rotorSpin;
    M.rotor.rotation.y = this.rotorAngle;
    M.tail.rotation.x = this.tailAngle;
    M.mats.disc.opacity = 0.2 * smoothstep(0.3, 0.9, this.rotorSpin);
    M.tailDisc.visible = this.rotorSpin > 0.4;
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    const g = this.game;
    for (const c of [this.pilot, this.gunner]) if (!c.removed) g.removeCharacter(c);
    g.scene.remove(this.root);
    this.physics.removeBody(this.body);
    disposeHeliModel(this.model);
    const i = g.aircraft.indexOf(this);
    if (i >= 0) g.aircraft.splice(i, 1);
  }
}

/* ==================================================================== searchlight */
const BEAM_VS = `
varying float vAlong;
varying vec3 vN;
varying vec3 vV;
void main() {
  vAlong = 1.0 - uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FS = `
uniform float uI;
uniform vec3 uColor;
varying float vAlong;
varying vec3 vN;
varying vec3 vV;
void main() {
  float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
  float a = uI * edge * pow(1.0 - vAlong, 1.3) * smoothstep(0.0, 0.04, vAlong);
  gl_FragColor = vec4(uColor * a, a);
}`;

/**
 * The helicopter's searchlight: one real spot light (made once, when night first falls, so the
 * scene's shaders compile with it) and a soft additive cone for the visible beam in the air.
 */
export class Searchlight {
  constructor(game) {
    this.game = game;
    const ang = 0.15;
    this.spot = new THREE.SpotLight(0xf4f1ff, 0, 260, ang, 0.45, 1.6);
    this.spot.castShadow = false;
    game.scene.add(this.spot, this.spot.target);
    const geo = new THREE.CylinderGeometry(0.006, Math.tan(ang) * 0.92, 1, 28, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
      uniforms: { uI: { value: 0 }, uColor: { value: new THREE.Color(0.95, 0.93, 1.0) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(geo, this.mat);
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 4;
    this.beam.visible = false;
    game.scene.add(this.beam);
    this.k = 0;
  }

  update(dt, heli) {
    const on = !!(heli && heli.lightOn && !heli.removed);
    this.k = approach(this.k, on ? 1 : 0, dt * 3);
    this.spot.intensity = 90000 * this.k;
    this.beam.visible = this.k > 0.01;
    if (!heli || heli.removed || this.k <= 0.001) return;
    const gm = heli.model.gimbal;
    gm.updateMatrixWorld(true);
    const from = gm.getWorldPosition(_v);
    _d.set(0, 0, 1).applyQuaternion(gm.getWorldQuaternion(_q));
    // the beam ends where it meets the ground / a roof / a car
    const hit = this.game.physics.raycast(from.clone().addScaledVector(_d, 0.4), _d, 250, groups(G.ALL, G.STATIC | G.CAR), heli.body);
    const len = hit ? hit.dist + 0.4 : 250;
    this.spot.position.copy(from);
    this.spot.target.position.copy(from).addScaledVector(_d, len);
    this.spot.target.updateMatrixWorld();
    this.beam.position.copy(from);
    this.beam.lookAt(this.spot.target.position);
    this.beam.scale.setScalar(len);
    // thicker in the rain, faint in clear air
    const rain = this.game.weather ? this.game.weather.rain : 0;
    this.mat.uniforms.uI.value = (0.6 + rain * 0.45) * this.k;
  }
}
