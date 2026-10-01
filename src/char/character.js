import * as THREE from 'three';
import { Rig } from './rig.js';
import { Locomotion } from './locomotion.js';
import { Ragdoll } from './ragdoll.js';
import { Pose, blendFrom, applyPoseDef, POSES } from './pose.js';
import { solveTwoBone, setWorldQuat } from './ik.js';
import { R, G, groups } from '../core/physics.js';
import RAPIER from '@dimforge/rapier3d-compat';
const R_CharacterCollision = RAPIER.CharacterCollision;
import { clamp, lerp, damp, approach, approachAngle, wrapAngle, smooth01, quatFromYaw, quatFromBasis, UP, makeRng } from '../core/util.js';
import { WEAPONS, buildWeaponModel } from '../game/weapons.js';
import { bikeRiderPose } from './bikeSequences.js';

// motorcycle helmet (shared geometry, per-colour material)
let HELMET_GEO = null;
const HELMET_MATS = {};
function makeHelmet(color) {
  if (!HELMET_GEO) {
    HELMET_GEO = {
      shell: new THREE.SphereGeometry(0.128, 22, 16).scale(1, 1.02, 1.14).translate(0, 0.105, -0.008),
      visor: new THREE.SphereGeometry(0.131, 18, 10, -0.95, 1.9, 1.05, 0.75).scale(1, 1.02, 1.14).translate(0, 0.1, -0.004),
      chin: new THREE.TorusGeometry(0.085, 0.03, 8, 16, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI).translate(0, 0.02, 0.04),
    };
    for (const g of Object.values(HELMET_GEO)) g.userData.shared = true;
    HELMET_MATS.visor = new THREE.MeshStandardMaterial({ color: 0x0b0f14, metalness: 0.6, roughness: 0.08 });
  }
  if (!HELMET_MATS[color]) HELMET_MATS[color] = new THREE.MeshPhysicalMaterial({ color, roughness: 0.25, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  const g = new THREE.Group();
  const shell = new THREE.Mesh(HELMET_GEO.shell, HELMET_MATS[color]);
  shell.castShadow = true;
  g.add(shell, new THREE.Mesh(HELMET_GEO.visor, HELMET_MATS.visor), new THREE.Mesh(HELMET_GEO.chin, HELMET_MATS[color]));
  g.visible = false;
  return g;
}
const HELMET_COLORS = ['#111111', '#e5e7eb', '#b91c1c', '#1d4ed8', '#f59e0b', '#16a34a', '#7c3aed'];

export const SPEEDS = { walk: 1.45, run: 5.1, sprint: 7.6 };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qShin = new THREE.Quaternion();
const _qFore = new THREE.Quaternion();
const _pole = new THREE.Vector3();
const _e = new THREE.Euler();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();
const _coll = new R_CharacterCollision();
const _wLeft = new THREE.Vector3(), _wRight = new THREE.Vector3(), _wDir = new THREE.Vector3(), _wLow = new THREE.Vector3();
const _wSR = new THREE.Vector3(), _wSL = new THREE.Vector3(), _wGrip = new THREE.Vector3(), _wFore = new THREE.Vector3();
const _wX = new THREE.Vector3(), _wY = new THREE.Vector3(), _wZ = new THREE.Vector3(), _wZ2 = new THREE.Vector3();
const _wPR = new THREE.Vector3(), _wPL = new THREE.Vector3();
const _wQR = new THREE.Quaternion(), _wQL = new THREE.Quaternion();

let CHAR_ID = 1;


export class Character {
  constructor(game, appearance, opts = {}) {
    this.id = CHAR_ID++;
    this.game = game;
    this.physics = game.physics;
    this.app = appearance;
    this.rig = new Rig(appearance);
    game.scene.add(this.rig.root);
    this.isPlayer = !!opts.player;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.pushVel = new THREE.Vector3();
    this.speedScalar = 0;
    this.vy = 0;
    this.grounded = true;
    this.landSpeed = 0;
    this.state = 'foot';
    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.crouch = 0;
    this.input = { dir: new THREE.Vector3(), mag: 0, mode: 'run', jump: false, face: null };
    this.armed = !!opts.armed;
    this.aimTarget = null;
    this.aimW = 0;
    this.holdW = 0;
    this.recoilT = 0;
    this.guns = {};
    this.gunsL = {};
    this.gun = null;
    this.weapon = 'fists';
    this.driveBy = null;
    this.handsUp = false;
    this.handsUpW = 0;
    this.umbrellaOn = false;
    this.umbW = 0;
    this.umbrella = null;
    this.lastDamageT = -99;
    this.lastPlayerHitT = -99;
    this.loco = new Locomotion(this);
    this.ragdoll = new Ragdoll(this.physics, this);
    this.pose = new Pose(this.rig.list.length);
    this.blend = null;
    this.vehicle = null;
    this.seatSide = 1;
    this.seq = null;
    this.handIK = { L: null, R: null };
    this.punchT = -1;
    this.punchSide = 'R';
    this.time = Math.random() * 10;
    this.removed = false;
    this.lastHitTime = -10;
    this.rng = makeRng(this.id * 31 + 7);
    this.createCapsule();
    if (this.armed) this.setWeapon('pistol');
    this.footstepTimer = 0;
    this.seatedCache = null;
    this.ai = null;
  }

  /* --------------------------------------------------------------- physics capsule */
  createCapsule() {
    const s = this.rig.scale;
    const r = 0.27 * s;
    const halfH = 0.9 * s - r;
    this.capOffset = 0.9 * s;
    this.capRadius = r;
    const desc = R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, this.capOffset, 0);
    this.body = this.physics.world.createRigidBody(desc);
    const cd = R.ColliderDesc.capsule(halfH, r)
      .setCollisionGroups(groups(G.CHAR, G.STATIC | G.CAR | G.CHAR | G.PROP))
      .setSolverGroups(groups(G.CHAR, G.PROP))
      .setFriction(0.0);
    this.collider = this.physics.world.createCollider(cd, this.body);
    this.physics.setOwner(this.collider, { type: 'char', char: this, surface: 'flesh' });
    this.capsuleOn = true;
  }

  setCapsuleEnabled(on) {
    if (this.capsuleOn === on) return;
    this.capsuleOn = on;
    this.collider.setEnabled(on);
  }

  teleport(p, yaw) {
    this.pos.copy(p);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.speedScalar = 0;
    this.vy = 0;
    this.body.setTranslation({ x: p.x, y: p.y + this.capOffset, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + this.capOffset, z: p.z });
    this.rig.root.position.copy(p);
    this.rig.root.quaternion.copy(quatFromYaw(yaw, _q));
    this.rig.resetPose();
    this.rig.root.updateMatrixWorld(true);
    this.loco.initialized = false;
  }

  groundAt(x, z, nearY) {
    const P = this.physics;
    _v3.set(x, nearY + 0.7, z);
    const hit = P.raycast(_v3, _down, 1.6, groups(G.ALL, G.STATIC | G.CAR | G.PROP), null, this.collider);
    return hit ? hit.point.y : nearY;
  }

  /* --------------------------------------------------------------- main update */
  update(dt) {
    if (this.removed) return;
    this.time += dt;
    this.helmetOn = false;
    switch (this.state) {
      case 'foot': this.updateFoot(dt); break;
      case 'seq': if (this.seq) this.seq.update(dt); break;
      case 'vehicle': this.updateSeated(dt); break;
      case 'ragdoll': case 'dead': this.updateRagdoll(dt); break;
      case 'getup': this.updateGetUp(dt); break;
      case 'heli': if (this.heliCrew) this.heliCrew.heli.poseCrew(this, dt); break;
      default: break;
    }
    this.applyBlend(dt);
    this.applyHandIK();
    this.updateHelmet(dt);
  }

  /** Helmet while riding (kept on for a while after coming off the bike). */
  updateHelmet(dt) {
    if (this.helmetT > 0) this.helmetT -= dt;
    const on = this.helmetOn || this.helmetT > 0;
    if (!on && !this.helmet) return;
    if (!this.helmet) {
      this.helmet = makeHelmet(HELMET_COLORS[(this.app.seed || this.id) % HELMET_COLORS.length]);
      this.rig.bones.head.add(this.helmet);
    }
    this.helmet.visible = on;
  }

  startBlend(dur, wf = null) {
    this.pose.capture(this.rig);
    this.blend = { from: new Pose(this.rig.list.length).copy(this.pose), t: 0, dur, wf };
  }

  applyBlend(dt) {
    const b = this.blend;
    if (!b) return;
    b.t += dt;
    const w = smooth01(b.t / b.dur);
    blendFrom(this.rig, b.from, w, b.wf);
    if (b.t >= b.dur) this.blend = null;
  }

  /* --------------------------------------------------------------- on foot */
  updateFoot(dt) {
    this.driveFoot(dt, this.input.dir, this.input.mag, this.input.mode, this.input.jump, this.input.face ?? null);
    this.input.jump = false;
  }

  /** Movement + locomotion for one frame. dir: world-space horizontal direction. */
  driveFoot(dt, dir, mag, mode = 'run', jump = false, faceYaw = null) {
    const s = this.rig.scale;
    const P = this.physics;
    const want = mag > 0.05;
    let maxSpeed = (SPEEDS[mode] || SPEEDS.run) * clamp(mag, 0, 1) * (0.92 + 0.08 * s);
    if (this.punchT >= 0) maxSpeed *= 0.35;
    if (this.health < 30) maxSpeed = Math.min(maxSpeed, SPEEDS.run * 0.7);
    let speedTarget = 0;
    if (this.grounded) {
      let moveYaw = this.moveYaw ?? this.yaw;
      if (want && faceYaw !== null) {
        // strafe: body faces faceYaw while moving along dir
        moveYaw = Math.atan2(dir.x, dir.z);
        this.yaw = approachAngle(this.yaw, faceYaw, 6.0 * dt);
        speedTarget = maxSpeed;
      } else if (want) {
        const targetYaw = Math.atan2(dir.x, dir.z);
        const diff = wrapAngle(targetYaw - this.yaw);
        const turnRate = mode === 'sprint' ? 4.6 : mode === 'run' ? 7.0 : 8.0;
        if (this.speedScalar > 5.6 && Math.abs(diff) > 2.3) {
          // sharp reversal while sprinting: brake first
          speedTarget = 0;
          this.yaw = approachAngle(this.yaw, targetYaw, turnRate * 0.35 * dt);
        } else {
          this.yaw = approachAngle(this.yaw, targetYaw, turnRate * dt);
          speedTarget = maxSpeed * Math.max(0, Math.cos(Math.min(Math.abs(diff), Math.PI / 2))) ** 0.6;
        }
        moveYaw = this.yaw;
      } else if (faceYaw !== null) {
        this.yaw = approachAngle(this.yaw, faceYaw, 5.0 * dt);
      }
      this.moveYaw = moveYaw;
      const acc = speedTarget > this.speedScalar ? (mode === 'sprint' ? 6.5 : 8.5) : (this.speedScalar > 5.5 ? 9 : 12);
      this.speedScalar = approach(this.speedScalar, speedTarget, acc * dt);
      this.vel.set(Math.sin(moveYaw) * this.speedScalar, 0, Math.cos(moveYaw) * this.speedScalar);
      if (jump) {
        this.vy = 4.4;
        this.grounded = false;
        this.game.audio?.jump(this.pos);
      }
    } else if (want) {
      // limited air control
      const targetYaw = Math.atan2(dir.x, dir.z);
      this.yaw = approachAngle(this.yaw, targetYaw, 1.5 * dt);
      this.vel.x = damp(this.vel.x, dir.x * maxSpeed, 0.6, dt);
      this.vel.z = damp(this.vel.z, dir.z * maxSpeed, 0.6, dt);
    }
    // gravity
    this.vy -= 9.81 * dt;
    if (this.vy < -40) this.vy = -40;
    // push velocity decays
    this.pushVel.multiplyScalar(Math.exp(-5 * dt));
    const desired = _v.set(
      (this.vel.x + this.pushVel.x) * dt,
      this.vy * dt - (this.grounded ? 0.012 : 0),
      (this.vel.z + this.pushVel.z) * dt,
    );
    const cc = P.cc;
    cc.computeColliderMovement(this.collider, desired, R.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.CHAR, G.STATIC | G.CAR | G.CHAR | G.PROP));
    const mv = cc.computedMovement();
    // Did we touch anything wall-like? (ground contacts have an upward normal)
    let wall = false;
    const nc = cc.numComputedCollisions();
    for (let i = 0; i < nc; i++) {
      const k = cc.computedCollision(i, _coll);
      if (!k || !k.normal1 || Math.abs(k.normal1.y) >= 0.6) continue;
      wall = true;
      const o = k.collider && P.ownerOf(k.collider);
      if (o && o.type === 'prop') this.shoveProp(k.collider);
      // sprinting into someone knocks them over
      if (o && o.type === 'char' && o.char.state === 'foot' && this.speedScalar > 6.3 && this.game.time - (this.lastShove || 0) > 0.6) {
        this.lastShove = this.game.time;
        const other = o.char;
        _v2.copy(this.vel).multiplyScalar(0.75);
        _v2.y = 1.4;
        other.damage(6, 'shove', this);
        other.toRagdoll(_v2, { spin: 1 });
        this.speedScalar *= 0.45;
        this.game.audio?.bodyHit(other.pos, 5);
        this.game.onShove?.(this, other);
      }
    }
    const wantH = Math.hypot(desired.x, desired.z);
    let mx = mv.x, mz = mv.z;
    if (!wall && wantH > 1e-4 && Math.hypot(mx, mz) < wantH * 0.3) {
      // the controller occasionally reports a zero step on flat ground; trust the desired motion
      mx = desired.x; mz = desired.z;
    }
    const wasGrounded = this.grounded;
    this.grounded = cc.computedGrounded();
    this.pos.x += mx; this.pos.y += mv.y; this.pos.z += mz;
    // effective horizontal speed (walking into walls should not animate running)
    const actual = Math.hypot(mx, mz) / Math.max(dt, 1e-4);
    if (wall && this.grounded && actual < this.speedScalar - 0.25) {
      this.speedScalar = Math.max(actual + 0.1, 0);
      const my = this.moveYaw ?? this.yaw;
      this.vel.set(Math.sin(my) * this.speedScalar, 0, Math.cos(my) * this.speedScalar);
    }
    // exact ground snap (the controller keeps a small, drifting skin offset)
    if (this.grounded || this.vy <= 0) {
      _v3.set(this.pos.x, this.pos.y + 0.45, this.pos.z);
      const gh = P.raycast(_v3, _down, 0.45 + (this.grounded ? 0.25 : 0.04), groups(G.ALL, G.STATIC | G.CAR | G.PROP), null, this.collider);
      if (gh && gh.normal.y > 0.6) {
        if (!this.grounded && this.vy < 0) this.grounded = true;
        this.pos.y = gh.point.y + 0.004;
      }
    }
    if (this.grounded) {
      if (!wasGrounded) {
        this.landSpeed = -this.vy;
        if (this.landSpeed > 13) {
          this.damage((this.landSpeed - 13) * 12, 'fall');
          if (this.landSpeed > 15) { this.toRagdoll(_v2.set(this.vel.x, this.vy * 0.3, this.vel.z)); return; }
        }
      }
      if (this.vy < 0) this.vy = 0;
    }
    if (this.pos.y < -20) this.respawnFallback();
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + this.capOffset, z: this.pos.z });
    this.checkVehicles(dt);
    if (this.state !== 'foot' && this.state !== 'seq') return;
    this.loco.update(dt);
    this.updatePunch(dt);
    this.updateAim(dt);
  }

  /* --------------------------------------------------------------- weapons */
  /** Select a weapon (model appears in the right hand; fists = none). */
  setWeapon(key) {
    if (!WEAPONS[key]) key = 'fists';
    this.weapon = key;
    for (const k in this.guns) this.guns[k].visible = false;
    for (const k in this.gunsL) this.gunsL[k].visible = false;
    if (WEAPONS[key].hold && !this.guns[key]) {
      const m = buildWeaponModel(key);
      this.rig.bones.handR.add(m);
      this.guns[key] = m;
    }
    this.gun = this.guns[key] || null;
  }

  /** Left-hand copy of a one-handed gun (shooting out of the driver's window). */
  gunLeft(key) {
    if (!this.gunsL[key]) {
      const m = buildWeaponModel(key);
      m.scale.x = -1; // mirror for the left hand
      this.rig.bones.handL.add(m);
      this.gunsL[key] = m;
    }
    return this.gunsL[key];
  }

  get activeGun() {
    if (this.driveBy && this.driveBy.hand === 'L') return this.gunsL[this.weapon] || this.gun;
    return this.gun;
  }

  /**
   * Weapon handling on foot: guns are held with hand IK so they line up exactly with the aim
   * (right hand on the grip with the stock in the shoulder, left hand on the foregrip). Long guns
   * are carried at low ready when not aiming. Also: the surrender pose and the umbrella.
   */
  updateAim(dt) {
    const rig = this.rig;
    const W = WEAPONS[this.weapon] || WEAPONS.fists;
    const hasGun = !!W.hold;
    const onFoot = this.state === 'foot';
    const aiming = hasGun && !!this.aimTarget && onFoot && !this.handsUp;
    this.aimW = approach(this.aimW, aiming ? 1 : 0, dt * (aiming ? 10 : 5));
    const lowReady = hasGun && W.hold !== 'pistol' && onFoot && !this.handsUp && this.umbW < 0.05;
    this.holdW = approach(this.holdW || 0, lowReady ? 1 : 0, dt * 6);
    this.recoilT = Math.max(0, (this.recoilT || 0) - dt * 9);
    if (this.gun) this.gun.visible = hasGun && (onFoot || this.state === 'getup' || this.state === 'ragdoll' || this.state === 'dead' || (this.state === 'vehicle' && this.driveBy && this.driveBy.hand === 'R'));
    if (aiming) (this.lastAim || (this.lastAim = new THREE.Vector3())).copy(this.aimTarget);
    const w = Math.max(this.aimW, this.holdW);
    if (hasGun && onFoot && w > 0.001) {
      this.weaponPose(W, this.aimW, this.holdW);
      this.weaponIK = true;
    } else if (this.weaponIK) {
      this.handIK.L = this.handIK.R = null;
      this.weaponIK = false;
    }
    // flinch from a bullet hit
    if (this.hitReact > 0) {
      this.hitReact = Math.max(0, this.hitReact - dt * 1.6);
      if (this.hitDir) {
        _v.set(this.hitDir.z, 0, -this.hitDir.x).normalize();
        _q.setFromAxisAngle(_v.applyQuaternion(_q2.copy(rig.root.quaternion).invert()), this.hitReact * 0.9);
        rig.bones.chest.quaternion.multiply(_q);
      }
    }
    // umbrella held overhead (pedestrians in the rain)
    this.umbW = approach(this.umbW, this.umbrellaOn && this.state === 'foot' && this.aimW < 0.05 ? 1 : 0, dt * 2.5);
    if (this.umbW > 0.001 || (this.umbrella && this.umbrella.visible)) {
      if (!this.umbrella) { this.umbrella = makeUmbrella(this.app.seed || this.id); rig.root.add(this.umbrella); }
      const w = this.umbW;
      _e.set(-0.55, 0, -0.2, 'XYZ');
      _q.setFromEuler(_e);
      rig.bones.upperArmR.quaternion.slerp(_q, w);
      _e.set(-1.85, 0.25, 0, 'XYZ');
      _q.setFromEuler(_e);
      rig.bones.forearmR.quaternion.slerp(_q, w);
      _q.setFromAxisAngle(_zAxis, 1.4);
      rig.bones.fingersR.quaternion.slerp(_q, w);
      this.umbrella.visible = w > 0.35;
      if (this.umbrella.visible) {
        rig.root.updateMatrixWorld(true);
        rig.bones.handR.getWorldPosition(_v2);
        rig.root.worldToLocal(_v2);
        this.umbrella.position.copy(_v2);
        this.umbrella.position.y -= 0.02;
        this.umbrella.rotation.set(0.1 + this.speedScalar * 0.05, 0, -0.06);
        this.umbrella.scale.setScalar(Math.min(1, w * 1.4 - 0.35) * 0.97 + 0.03);
      }
    }
    this.handsUpW = approach(this.handsUpW, this.handsUp && (this.state === 'foot') ? 1 : 0, dt * 4);
    if (this.handsUpW > 0.001) {
      const w = this.handsUpW;
      for (const [side, sx] of [['L', 1], ['R', -1]]) {
        _e.set(-2.35, 0, sx * 0.5, 'XYZ');
        _q.setFromEuler(_e);
        rig.bones['upperArm' + side].quaternion.slerp(_q, w);
        _e.set(-1.5, sx * 0.3, 0, 'XYZ');
        _q.setFromEuler(_e);
        rig.bones['forearm' + side].quaternion.slerp(_q, w);
      }
    }
  }

  /** Hand IK targets for holding weapon W (aim weight aw, low-ready weight hw). */
  weaponPose(W, aw, hw) {
    const rig = this.rig, s = rig.scale;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    _wLeft.set(fz, 0, -fx); // character's left
    _wRight.copy(_wLeft).negate();
    // lean the upper body into the aim (pitch)
    if (aw > 0.001 && this.lastAim) {
      rig.root.updateMatrixWorld(true);
      rig.bones.chest.getWorldPosition(_v);
      _wDir.subVectors(this.lastAim, _v).normalize();
      const pitch = clamp(Math.asin(clamp(_wDir.y, -1, 1)), -1.0, 1.0);
      _q.setFromAxisAngle(_xAxis, -pitch * 0.3 * aw);
      rig.bones.spine.quaternion.multiply(_q);
      rig.bones.chest.quaternion.multiply(_q);
      // square the shoulders to the target
      const yawErr = clamp(wrapAngle(Math.atan2(_wDir.x, _wDir.z) - this.yaw), -0.8, 0.8);
      _q.setFromAxisAngle(UP, yawErr * 0.5 * aw);
      rig.bones.chest.quaternion.multiply(_q);
    }
    rig.root.updateMatrixWorld(true);
    rig.bones.upperArmR.getWorldPosition(_wSR);
    rig.bones.upperArmL.getWorldPosition(_wSL);
    // aim direction, blended with the low-ready carry direction
    _wLow.set(fx * 0.88, -0.48, fz * 0.88).normalize();
    if (W.hold === 'pistol') {
      _wGrip.addVectors(_wSL, _wSR).multiplyScalar(0.5);
      _wGrip.y -= 0.03 * s;
      _wDir.copy(this.lastAim || _v.copy(_wGrip).addScaledVector(_wLow, 5)).sub(_wGrip).normalize();
      _wDir.lerp(_wLow, 1 - aw).normalize();
      _wGrip.addScaledVector(_wDir, 0.5 * s).addScaledVector(_wRight, 0.02 * s);
    } else {
      // shoulder pocket: inside of the right shoulder
      _wGrip.copy(_wSR).addScaledVector(_wLeft, 0.075 * s);
      _wGrip.y -= 0.035 * s;
      if (this.lastAim && aw > 0.001) _wDir.copy(this.lastAim).sub(_wGrip).normalize().lerp(_wLow, 1 - aw).normalize();
      else _wDir.copy(_wLow);
      // at low ready the gun drops to the hip
      if (aw < 0.999) _wGrip.addScaledVector(_wRight, 0.04 * (1 - aw) * s).add(_v.set(0, -0.2 * (1 - aw) * s, 0)).addScaledVector(_wDir, 0.06 * (1 - aw) * s);
      _wGrip.addScaledVector(_wDir, W.stock * s);
    }
    // recoil: kick back and climb
    if (this.recoilT > 0) {
      _wGrip.addScaledVector(_wDir, -this.recoilT * (W.hold === 'long' ? 0.045 : 0.06) * s);
      _wDir.y += this.recoilT * (W.hold === 'pistol' ? 0.22 : 0.1);
      _wDir.normalize();
    }
    // right hand: fingers (-Y) along the barrel, thumb side (+Z) up
    _wZ.set(0, 1, 0).addScaledVector(_wDir, -_wDir.y).normalize();
    _wY.copy(_wDir).negate();
    _wX.crossVectors(_wY, _wZ);
    quatFromBasis(_wX, _wY, _wZ, _wQR);
    // left hand: under the foregrip (long guns) or cupping the right hand (pistol)
    if (W.hold === 'pistol') {
      _wFore.copy(_wGrip).addScaledVector(_wLeft, 0.03 * s).addScaledVector(_wZ, -0.045 * s).addScaledVector(_wDir, 0.015 * s);
      _wY.copy(_wRight).multiplyScalar(0.75).addScaledVector(_wDir, 0.45).addScaledVector(_wZ, 0.35).normalize().negate();
    } else {
      _wFore.copy(_wGrip).addScaledVector(_wDir, W.fore * s).addScaledVector(_wZ, -0.02 * s).addScaledVector(_wLeft, 0.015 * s);
      _wY.copy(_wRight).multiplyScalar(0.8).addScaledVector(_wZ, 0.45).normalize().negate();
    }
    _wZ2.copy(_wDir).addScaledVector(_wY, -_wDir.dot(_wY)).normalize();
    _wX.crossVectors(_wY, _wZ2);
    quatFromBasis(_wX, _wY, _wZ2, _wQL);
    const w = Math.max(aw, hw);
    _wPR.set(0, -1, 0).addScaledVector(_wRight, 0.9);
    _wPL.set(0, -1, 0).addScaledVector(_wLeft, 0.35).addScaledVector(_wDir, -0.2);
    this.setHand('R', _wGrip, w, _wQR, _wPR, 0.95);
    this.setHand('L', _wFore, w, _wQL, _wPL, 0.85);
  }

  /** Shooting out of a vehicle: the gun hand points at the target, the other stays on the wheel. */
  driveByPose(veh) {
    const db = this.driveBy;
    const W = WEAPONS[this.weapon];
    if (!db || !W || !W.drive) {
      if (this.driveIK) { this.handIK.L = this.handIK.R = null; this.driveIK = false; }
      for (const k in this.gunsL) this.gunsL[k].visible = false;
      return;
    }
    const rig = this.rig;
    rig.root.updateMatrixWorld(true);
    const arm = db.hand;
    rig.bones['upperArm' + arm].getWorldPosition(_wSR);
    _wDir.subVectors(db.target, _wSR).normalize();
    _wGrip.copy(_wSR).addScaledVector(_wDir, 0.56 * rig.scale);
    if (this.recoilT > 0) { _wGrip.addScaledVector(_wDir, -this.recoilT * 0.06); _wDir.y += this.recoilT * 0.2; _wDir.normalize(); }
    _wZ.set(0, 1, 0).addScaledVector(_wDir, -_wDir.y).normalize();
    _wY.copy(_wDir).negate();
    _wX.crossVectors(_wY, _wZ);
    quatFromBasis(_wX, _wY, _wZ, _wQR);
    const out = arm === 'L' ? 1 : -1;
    _wPR.set(0, -1, 0).addScaledVector(_v.set(out, 0, 0).applyQuaternion(veh.curQuat), 0.8);
    this.handIK.L = this.handIK.R = null;
    this.setHand(arm, _wGrip, 1, _wQR, _wPR, 0.95);
    this.driveIK = true;
    if (arm === 'L') { const g = this.gunLeft(this.weapon); g.visible = true; if (this.gun) this.gun.visible = false; }
    else { for (const k in this.gunsL) this.gunsL[k].visible = false; if (this.gun) this.gun.visible = true; }
  }

  /** World position of the active gun's muzzle (and its direction in outDir, optional). */
  muzzleWorld(out) {
    this.rig.root.updateMatrixWorld(true);
    const g = this.activeGun;
    if (!g) return out.copy(this.pos).setY(this.pos.y + 1.4);
    return g.localToWorld(out.copy(g.userData.muzzle));
  }

  ejectWorld(out) {
    const g = this.activeGun;
    if (!g) return out.copy(this.pos).setY(this.pos.y + 1.3);
    return g.localToWorld(out.copy(g.userData.eject));
  }

  /** Walking into a loose prop transfers momentum (80 kg body, slightly bouncy contact). */
  shoveProp(collider) {
    const rb = collider.parent();
    if (!rb || !rb.isDynamic()) return;
    const t = rb.translation(), lv = rb.linvel();
    let dx = t.x - this.pos.x, dz = t.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const vInto = (this.vel.x - lv.x) * dx + (this.vel.z - lv.z) * dz;
    if (vInto <= 0.05) return;
    const m = rb.mass(), mu = (80 * m) / (80 + m);
    const J = mu * vInto * 1.15;
    rb.applyImpulseAtPoint({ x: dx * J, y: J * 0.08, z: dz * J }, { x: t.x, y: t.y + 0.1, z: t.z }, true);
  }

  respawnFallback() {
    const sp = this.game.city.playerSpawn();
    this.teleport(_v2.set(sp.x, sp.y + 0.2, sp.z), sp.yaw);
  }

  /** Vehicles touching the character: gentle push at low speed, ragdoll at high speed. */
  checkVehicles(dt) {
    const s = this.rig.scale;
    for (const veh of this.game.vehicles) {
      if (veh.removed) continue;
      const dx = veh.curPos.x - this.pos.x, dz = veh.curPos.z - this.pos.z;
      if (dx * dx + dz * dz > 49) continue;
      _v2.set(this.pos.x, this.pos.y + 0.9 * s, this.pos.z);
      const local = veh.worldToLocal(_v2, _v3);
      // predict a little ahead
      const vc = veh.velocityAt(_v2, _v);
      const carSp = Math.hypot(vc.x, vc.z);
      const margin = this.capRadius + 0.05 + Math.min(0.6, carSp * dt * 2);
      const hw = veh.halfW + margin, hl = veh.halfL + margin;
      if (Math.abs(local.x) > hw || Math.abs(local.z) > hl || local.y < -0.6 || local.y > veh.height + 0.4) continue;
      // face of the car we're touching (axis of least penetration) and the car's own speed
      // through that face: only the car moving into us knocks us down, never us walking into it
      const px = hw - Math.abs(local.x), pz = hl - Math.abs(local.z);
      const sideFace = px < pz;
      _v4.copy(vc).applyQuaternion(_q2.copy(veh.curQuat).invert());
      const closing = sideFace ? _v4.x * Math.sign(local.x) : _v4.z * Math.sign(local.z);
      const sweep = sideFace ? Math.abs(_v4.z) : Math.abs(_v4.x);
      if ((closing > 3.2 || (sweep > 7 && closing > -0.5)) && this.game.time - this.lastHitTime > 0.5) {
        this.hitByCar(veh, vc, local);
        return;
      }
      // a resting car is solid for the character controller already; only a moving one shoves
      if (carSp < 0.3) continue;
      // push out along the axis of least penetration
      if (sideFace) _v2.set(Math.sign(local.x) * px, 0, 0); else _v2.set(0, 0, Math.sign(local.z) * pz);
      _v2.applyQuaternion(veh.curQuat);
      _v2.y = 0;
      this.pos.add(_v2);
      this.pushVel.x += vc.x * 0.5; this.pushVel.z += vc.z * 0.5;
    }
  }

  hitByCar(veh, vc, local) {
    this.lastHitTime = this.game.time;
    const sp = vc.length();
    const dmg = (sp - 3) * (sp > 12 ? 11 : 7);
    this.damage(dmg, 'car', veh);
    // launch: most of the car's velocity, upward kick, a little sideways off the bonnet
    _v2.copy(vc).multiplyScalar(sp > 9 ? 0.72 : 0.85);
    _v2.y = Math.max(_v2.y, 0) + 1.1 + sp * 0.13;
    _v3.set(Math.sign(local.x || 1), 0, 0).applyQuaternion(veh.curQuat).multiplyScalar(0.6 + sp * 0.04);
    _v2.add(_v3);
    this.toRagdoll(_v2, { spin: 0.8 + sp * 0.18 });
    this.game.audio?.bodyHit(this.pos, sp);
    this.game.onPedHit?.(this, veh, sp);
  }

  damage(amount, cause, source) {
    if (!this.alive || amount <= 0) return;
    if (this.isPlayer && this.game.godMode) return;
    this.lastDamageT = this.game.time;
    if (source && (source.isPlayer || (source.driver && source.driver.isPlayer))) this.lastPlayerHitT = this.game.time;
    this.health -= amount;
    this.lastDamageCause = cause;
    // nothing between a rider and the bullet: shot riders often come off
    if (this.health > 0 && this.state === 'vehicle' && this.vehicle && this.vehicle.isBike && this.vehicle.driver === this) this.vehicle.onRiderHit?.(amount, cause, this);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      if (this.state !== 'ragdoll' && this.state !== 'dead') {
        if (this.state === 'foot' || this.state === 'getup') this.toRagdoll(_v2.copy(this.vel));
      }
      this.game.onCharacterDied?.(this, cause, source);
    }
  }

  /* --------------------------------------------------------------- punching */
  punch() {
    if (this.state !== 'foot' || this.punchT >= 0 || !this.grounded) return;
    this.punchT = 0;
    this.punchSide = this.punchSide === 'R' ? 'L' : 'R';
    this.punchHit = false;
    this.game.audio?.whoosh(this.pos);
  }

  updatePunch(dt) {
    if (this.punchT < 0) return;
    this.punchT += dt;
    const D = 0.5;
    const t = this.punchT / D;
    if (t >= 1) { this.punchT = -1; return; }
    const rig = this.rig;
    const side = this.punchSide;
    const sx = side === 'L' ? 1 : -1;
    // wind up -> extend -> recover
    const ext = t < 0.3 ? -0.25 * smooth01(t / 0.3) : t < 0.5 ? lerp(-0.25, 1, smooth01((t - 0.3) / 0.2)) : lerp(1, 0, smooth01((t - 0.5) / 0.5));
    const w = Math.sin(Math.PI * Math.min(1, t * 1.15));
    _e.set(lerp(0, -1.45, Math.max(0, ext)) + 0.3 * Math.min(0, ext), 0, sx * lerp(0.15, 0.05, Math.max(0, ext)), 'XYZ');
    _q.setFromEuler(_e);
    rig.bones['upperArm' + side].quaternion.slerp(_q, w);
    _e.set(lerp(-2.1, -0.15, Math.max(0, ext)), 0, 0, 'XYZ');
    _q.setFromEuler(_e);
    rig.bones['forearm' + side].quaternion.slerp(_q, w);
    _q.setFromAxisAngle(_zAxis, sx * -1.6);
    rig.bones['fingers' + side].quaternion.slerp(_q, w);
    // guard hand
    const o = side === 'L' ? 'R' : 'L';
    _e.set(-0.9, 0, -sx * 0.2, 'XYZ');
    _q.setFromEuler(_e);
    rig.bones['upperArm' + o].quaternion.slerp(_q, w * 0.8);
    _e.set(-2.0, 0, 0, 'XYZ');
    _q.setFromEuler(_e);
    rig.bones['forearm' + o].quaternion.slerp(_q, w * 0.8);
    // torso twist into the punch
    _q.setFromAxisAngle(UP, -sx * 0.35 * Math.max(0, ext) + sx * 0.15 * Math.min(0, ext) * -1);
    rig.bones.chest.quaternion.multiply(_q);
    if (!this.punchHit && t > 0.42) {
      this.punchHit = true;
      this.game.resolvePunch?.(this);
    }
  }

  /* --------------------------------------------------------------- ragdoll */
  toRagdoll(vel, opts = {}) {
    if (this.state === 'ragdoll' || this.state === 'dead') {
      if (opts.impulse) this.ragdoll.applyImpulse(opts.impulse, opts.impulseAt || this.pos);
      return;
    }
    if (this.seq && this.seq.abort) this.seq.abort('ragdoll');
    this.seq = null;
    this.blend = null;
    this.handIK.L = this.handIK.R = null;
    this.punchT = -1;
    if (this.vehicle) this.leaveVehicleInstant();
    this.rig.root.updateMatrixWorld(true);
    this.ragdoll.activate(vel, opts);
    this.state = this.alive ? 'ragdoll' : 'dead';
    this.setCapsuleEnabled(false);
    this.ragdollTime = 0;
    this.game.audio?.grunt?.(this.pos, this.app.female);
  }

  updateRagdoll(dt) {
    if (!this.ragdoll.active) return;
    this.ragdollTime += dt;
    if (this.state === 'dead' && this.ragdoll.calm > 3) return; // frozen corpse
    this.ragdoll.sync(dt);
    this.ragdoll.hipsPosition(this.pos);
    this.pos.y -= 0.12;
    if (this.state === 'dead') return;
    if (!this.alive) { this.state = 'dead'; return; }
    if ((this.ragdollTime > 1.6 && this.ragdoll.calm > 0.6) || this.ragdollTime > 9) this.startGetUp();
  }

  startGetUp() {
    const rd = this.ragdoll;
    const hips = rd.hipsPosition(new THREE.Vector3());
    const chest = rd.partPosition('chest', new THREE.Vector3());
    const hq = rd.partQuat('hips', new THREE.Quaternion());
    const front = _v.set(0, 0, 1).applyQuaternion(hq);
    const faceUp = front.y > 0;
    const hd = _v2.subVectors(chest, hips);
    hd.y = 0;
    if (hd.lengthSq() < 1e-6) hd.set(0, 0, 1);
    hd.normalize();
    const yaw = faceUp ? Math.atan2(-hd.x, -hd.z) : Math.atan2(hd.x, hd.z);
    const gy = this.groundAt(hips.x, hips.z, hips.y);
    this.pos.set(hips.x, gy, hips.z);
    this.yaw = yaw;
    this.rig.root.position.copy(this.pos);
    this.rig.root.quaternion.copy(quatFromYaw(yaw, _q));
    this.rig.root.updateMatrixWorld(true);
    rd.sync(0);
    rd.deactivate();
    this.pose.capture(this.rig);
    const keys = faceUp
      ? [['lieBack', 0.35], ['sitUp', 0.6], ['crouch', 0.6], ['stand', 0.5]]
      : [['lieFront', 0.3], ['pushUp', 0.6], ['kneel', 0.55], ['stand', 0.55]];
    this.getup = { keys, i: 0, t: 0, from: new Pose(this.rig.list.length).copy(this.pose) };
    this.state = 'getup';
  }

  updateGetUp(dt) {
    const g = this.getup;
    const [name, dur] = g.keys[g.i];
    g.t += dt;
    const w = smooth01(g.t / dur);
    applyPoseDef(this.rig, POSES[name]);
    blendFrom(this.rig, g.from, w);
    this.rig.root.position.copy(this.pos);
    if (g.t >= dur) {
      g.from.capture(this.rig);
      g.i++;
      g.t = 0;
      if (g.i >= g.keys.length) {
        this.state = 'foot';
        this.setCapsuleEnabled(true);
        this.teleportBody();
        this.loco.plantFromCurrent();
        this.vel.set(0, 0, 0);
        this.speedScalar = 0;
        this.vy = 0;
        this.grounded = true;
        this.startBlend(0.25);
        this.game.onGotUp?.(this);
      }
    }
  }

  teleportBody() {
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y + this.capOffset, z: this.pos.z }, true);
  }

  /* --------------------------------------------------------------- seated */
  enterVehicleInstant(veh, side = 1) {
    this.vehicle = veh;
    this.seatSide = side;
    if (side === 1) veh.driver = this; else veh.passengers.push(this);
    if (veh.isBike) { veh.setRiderCollider(true); veh.standDown = false; veh.body.wakeUp(); }
    this.state = 'vehicle';
    this.setCapsuleEnabled(false);
    this.vel.set(0, 0, 0);
  }

  leaveVehicleInstant() {
    const veh = this.vehicle;
    if (!veh) return;
    if (veh.isBike) { veh.setRiderCollider(false); this.helmetT = 8; }
    if (veh.driver === this) veh.driver = null;
    veh.passengers = veh.passengers.filter((p) => p !== this);
    this.vehicle = null;
  }

  /** Root transform for sitting in `veh` on `side` (in world). */
  seatRoot(veh, side, outPos, outQuat) {
    veh.seatLocal(side, _v);
    _v.y -= this.rig.L.hipsY;
    veh.localToWorld(_v, outPos);
    outQuat.copy(veh.curQuat);
  }

  updateSeated(dt) {
    const veh = this.vehicle;
    if (!veh || veh.removed) { this.leaveVehicleInstant(); this.state = 'foot'; this.setCapsuleEnabled(true); return; }
    if (veh.isBike) {
      this.driveByPose(veh);
      bikeRiderPose(this, veh, dt);
      return;
    }
    this.seatRoot(veh, this.seatSide, this.rig.root.position, this.rig.root.quaternion);
    this.pos.copy(this.rig.root.position);
    this.pos.y += this.rig.L.hipsY - 0.4;
    const f = veh.forward(_v);
    this.yaw = Math.atan2(f.x, f.z);
    const cam = this.game.camera;
    const far = cam ? cam.position.distanceToSquared(this.rig.root.position) > 70 * 70 : false;
    if (far && this.seatedCache) {
      this.seatedCache.apply(this.rig);
      return;
    }
    this.driveByPose(veh);
    this.seatedPose(veh, this.seatSide, dt);
    if (!this.alive) this.slumpPose();
    if (!this.seatedCache) this.seatedCache = new Pose(this.rig.list.length);
    this.seatedCache.capture(this.rig);
  }

  /** Dead in the seat: slumped forward, arms limp. */
  slumpPose() {
    const rig = this.rig;
    this.handIK.L = this.handIK.R = null;
    _q.setFromAxisAngle(_xAxis, 0.45);
    rig.bones.chest.quaternion.multiply(_q);
    _q.setFromAxisAngle(_xAxis, 0.35);
    rig.bones.neck.quaternion.multiply(_q);
    _e.set(0.55, 0, 0.25 * (this.id % 2 ? 1 : -1), 'XYZ');
    _q.setFromEuler(_e);
    rig.bones.head.quaternion.multiply(_q);
    for (const arm of ['L', 'R']) {
      const sx = arm === 'L' ? 1 : -1;
      _e.set(-0.25, 0, sx * 0.08, 'XYZ');
      rig.bones['upperArm' + arm].quaternion.setFromEuler(_e);
      _e.set(-0.35, 0, 0, 'XYZ');
      rig.bones['forearm' + arm].quaternion.setFromEuler(_e);
    }
  }

  /** Full seated driving pose with IK (hands on wheel, feet on pedals). */
  seatedPose(veh, side, dt = 0.016, opts = {}) {
    const rig = this.rig, L = rig.L;
    rig.resetPose();
    const driver = side === 1 && veh.driver === this || opts.driver;
    _e.set(-0.2, 0, 0, 'XYZ');
    rig.bones.hips.quaternion.setFromEuler(_e);
    _e.set(0.1, 0, 0, 'XYZ');
    rig.bones.spine.quaternion.setFromEuler(_e);
    _e.set(0.08, 0, 0, 'XYZ');
    rig.bones.chest.quaternion.setFromEuler(_e);
    rig.root.updateMatrixWorld(true);
    const M = veh.model;
    const sx = M.seat.x * side;
    // ------------------------------------------------ legs
    const thr = clamp(veh.input.throttle, 0, 1), brk = clamp(veh.input.brake, 0, 1);
    this.pedalBlend = damp(this.pedalBlend || 0, brk > thr ? 1 : 0, 12, dt);
    for (const leg of ['L', 'R']) {
      const ls = leg === 'L' ? 1 : -1;
      let target;
      if (driver && leg === 'R') {
        _v.copy(M.pedals.throttle).lerp(M.pedals.brake, this.pedalBlend);
        _v.z += (this.pedalBlend > 0.5 ? brk : thr) * 0.04;
        target = _v;
      } else if (driver) {
        target = _v.copy(M.pedals.rest);
      } else {
        target = _v.set(sx + ls * 0.13, M.pedals.rest.y + 0.02, M.pedals.rest.z - 0.05);
      }
      // ankle sits above/behind the pedal contact
      _v2.set(target.x, target.y + 0.06, target.z - 0.11);
      veh.localToWorld(_v2, _v3);
      _pole.set(ls * 0.25, 0.6, 1).applyQuaternion(veh.curQuat);
      solveTwoBone(rig.bones['thigh' + leg], rig.bones['shin' + leg], _v3, _pole, 1, L.thigh, L.shin, 1, _qShin);
      _q.setFromAxisAngle(_xAxis, -0.35);
      _q2.copy(veh.curQuat).multiply(_q);
      rig.bones['foot' + leg].quaternion.copy(_qShin).invert().multiply(_q2);
    }
    // ------------------------------------------------ arms
    if (driver) {
      for (const arm of ['L', 'R']) {
        if (this.handIK[arm] && this.handIK[arm].w >= 0.999) continue;
        this.wheelGrip(veh, arm, _v, _q2);
        _pole.set((arm === 'L' ? 1 : -1) * 0.9, -1, -0.4).applyQuaternion(veh.curQuat);
        solveTwoBone(rig.bones['upperArm' + arm], rig.bones['forearm' + arm], _v, _pole, -1, L.upperArm, L.forearm, 1, _qFore);
        rig.bones['hand' + arm].quaternion.copy(_qFore).invert().multiply(_q2);
        rig.bones['fingers' + arm].quaternion.setFromAxisAngle(_zAxis, (arm === 'L' ? -1 : 1) * 1.35);
      }
    } else {
      for (const arm of ['L', 'R']) {
        const sx2 = arm === 'L' ? 1 : -1;
        _e.set(-0.55, 0, sx2 * 0.12, 'XYZ');
        rig.bones['upperArm' + arm].quaternion.setFromEuler(_e);
        _e.set(-0.95, sx2 * 0.4, 0, 'XYZ');
        rig.bones['forearm' + arm].quaternion.setFromEuler(_e);
        rig.bones['fingers' + arm].quaternion.setFromAxisAngle(_zAxis, -sx2 * 0.5);
      }
    }
    // ------------------------------------------------ head
    if (this.isPlayer) {
      this.lookYaw = damp(this.lookYaw, clamp(veh.steerAngle * 1.2, -0.6, 0.6), 4, dt);
    } else {
      this.lookYaw = damp(this.lookYaw, clamp(veh.steerAngle * 1.4, -0.7, 0.7), 3, dt);
    }
    rig.root.updateMatrixWorld(true);
    _q.setFromAxisAngle(UP, this.lookYaw);
    _q2.copy(veh.curQuat).multiply(_q);
    _q3.setFromAxisAngle(_xAxis, 0.05);
    _q2.multiply(_q3);
    setWorldQuat(rig.bones.head, _q2);
  }

  /** Steering wheel grip target (wrist position + hand orientation) for the left/right hand. */
  wheelGrip(veh, arm, outPos, outQuat) {
    const M = veh.model;
    const rot = clamp(M.steeringWheel.rotation.z, -1.1, 1.1);
    const sgn = arm === 'L' ? 1 : -1;
    const theta = sgn > 0 ? 0.42 : Math.PI - 0.42;
    const a = theta + rot;
    const r = M.rimR;
    // wrist sits behind and slightly outside the rim
    _v2.set(Math.cos(a) * (r + 0.025), Math.sin(a) * (r + 0.025), -0.075);
    M.steerFrame.updateWorldMatrix(true, false);
    outPos.copy(_v2).applyMatrix4(M.steerFrame.matrixWorld);
    M.steerFrame.getWorldQuaternion(outQuat);
    _q3.setFromAxisAngle(_zAxis, rot + sgn * 0.42);
    outQuat.multiply(_q3);
    _q3.setFromAxisAngle(_xAxis, -Math.PI / 2);
    outQuat.multiply(_q3);
    return outPos;
  }

  /* --------------------------------------------------------------- hand IK overlay */
  /** Request a hand to reach a world target this frame (w: 0..1). */
  setHand(arm, target, w, quat = null, pole = null, grip = 0.6) {
    if (w <= 0.001) { this.handIK[arm] = null; return; }
    const h = this.handIK[arm] || (this.handIK[arm] = { target: new THREE.Vector3(), quat: new THREE.Quaternion(), hasQuat: false, pole: new THREE.Vector3(), hasPole: false, w: 0, grip: 0 });
    h.target.copy(target);
    h.w = w;
    h.hasQuat = !!quat;
    if (quat) h.quat.copy(quat);
    h.hasPole = !!pole;
    if (pole) h.pole.copy(pole);
    h.grip = grip;
  }

  applyHandIK() {
    const rig = this.rig, L = rig.L;
    for (const arm of ['L', 'R']) {
      const h = this.handIK[arm];
      if (!h) continue;
      rig.root.updateMatrixWorld(true);
      const sgn = arm === 'L' ? 1 : -1;
      if (h.hasPole) _pole.copy(h.pole);
      else {
        // elbow down and out
        _pole.set(sgn * 0.7, -1, -0.3).applyQuaternion(rig.root.quaternion);
      }
      solveTwoBone(rig.bones['upperArm' + arm], rig.bones['forearm' + arm], h.target, _pole, -1, L.upperArm, L.forearm, h.w, _qFore);
      if (h.hasQuat) {
        _q.copy(_qFore).invert().multiply(h.quat);
        rig.bones['hand' + arm].quaternion.slerp(_q, h.w);
      }
      _q.setFromAxisAngle(_zAxis, -sgn * h.grip * 1.5);
      rig.bones['fingers' + arm].quaternion.slerp(_q, h.w);
    }
  }

  clearHands() { this.handIK.L = null; this.handIK.R = null; }

  /* --------------------------------------------------------------- misc */
  onFootstep(foot, intensity) {
    if (!this.game.audio) return;
    _v.copy(foot.pos);
    this.game.audio.footstep(_v, intensity, this.isPlayer);
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    if (this.vehicle) this.leaveVehicleInstant();
    this.ragdoll.deactivate();
    this.physics.removeBody(this.body);
    this.game.scene.remove(this.rig.root);
    this.rig.mesh.geometry.dispose();
    this.rig.mesh.skeleton.dispose(); // frees the bone matrix texture
    for (const m of this.rig.materials) m.dispose();
  }
}

const _down = new THREE.Vector3(0, -1, 0);
export { _m };
