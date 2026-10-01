import * as THREE from 'three';
import { EnterSequence, ExitSequence } from '../char/carSequences.js';
import { BikeMount, BikeDismount } from '../char/bikeSequences.js';
import { clamp, approach, wrapAngle } from '../core/util.js';
import { WEAPONS, WEAPON_ORDER, BULLET_FILTER } from './weapons.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _cf = new THREE.Vector3();
const _o = new THREE.Vector3();
const _bd = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _mz = new THREE.Vector3();
const _ej = new THREE.Vector3();
const _side = new THREE.Vector3();

export class PlayerController {
  constructor(game, ch) {
    this.game = game;
    this.character = ch;
    this.walk = false;
    this.lastVehicle = null;
    this.moveIntent = 0;
    this.steer = 0;
    this.hornT = 0;
    this.seqAge = 0;
    this.nearVehicle = null;
    // weapons (all free, unlimited ammo)
    this.weapon = 'fists';
    this.aiming = false;
    this.driveAim = false;
    this.fireT = 0;
    this.hipT = 0;
    this.bloom = 0;
    this.wasFiring = false;
    this.lastCrimeT = -10;
    this.aimPoint = new THREE.Vector3();
    this.aimOnTarget = false;
  }

  selectWeapon(key) {
    if (!WEAPONS[key] || key === this.weapon) return;
    this.weapon = key;
    this.character.setWeapon(key);
    this.game.audio?.weaponSwitch?.();
    this.game.hud.setWeapon?.(WEAPONS[key]);
  }

  /** Weapon selection: 1-5, mouse wheel on foot, LB/RB on a gamepad on foot. */
  weaponInput(onFoot) {
    const inp = this.game.input;
    for (let i = 0; i < WEAPON_ORDER.length; i++) if (inp.hit('Digit' + (i + 1))) this.selectWeapon(WEAPON_ORDER[i]);
    let step = 0;
    if (onFoot && inp.wheel) step = Math.sign(inp.wheel);
    if (onFoot && inp.gamepad) { if (inp.gamepad.pressed('rb')) step = 1; if (inp.gamepad.pressed('lb')) step = -1; }
    if (step) {
      const i = WEAPON_ORDER.indexOf(this.weapon);
      this.selectWeapon(WEAPON_ORDER[(i + step + WEAPON_ORDER.length) % WEAPON_ORDER.length]);
    }
  }

  /** Where the crosshair points: camera ray, starting at the player's depth. */
  computeAim(exclude) {
    const g = this.game, cam = g.camera, ch = this.character;
    cam.getWorldDirection(_cf);
    _v.copy(ch.state === 'vehicle' && ch.vehicle ? ch.vehicle.curPos : ch.pos);
    const depth = Math.max(0, _v.sub(cam.position).dot(_cf) - 0.6);
    _o.copy(cam.position).addScaledVector(_cf, depth);
    const hit = g.physics.raycast(_o, _cf, 250, BULLET_FILTER, exclude, ch.collider);
    if (hit) {
      this.aimPoint.copy(hit.point);
      const o = g.physics.ownerOf(hit.collider);
      this.aimOnTarget = !!o && ((o.type === 'char' && o.char.alive) || (o.type === 'ragdoll' && o.char && o.char.alive));
      // people react to a gun pointed at them
      if (this.aimOnTarget && o.type === 'char' && hit.dist < 30) {
        const c = o.char;
        if (c.isCop) { if (g.time - (this.threatT || -10) > 3) { this.threatT = g.time; g.police.crime('threatCop', c.pos); } }
        else if (c.ai && c.ai.aimedAt) c.ai.aimedAt(ch);
      }
    } else {
      this.aimPoint.copy(_o).addScaledVector(_cf, 250);
      this.aimOnTarget = false;
    }
    return this.aimPoint;
  }

  /** Fire the current weapon once (all pellets) at the crosshair. */
  shoot(W) {
    const g = this.game, ch = this.character, cam = g.camera;
    const veh = ch.state === 'vehicle' ? ch.vehicle : null;
    cam.getWorldDirection(_cf);
    const muzzle = ch.muzzleWorld(_mz);
    const moving = ch.state === 'foot' && ch.speedScalar > 2;
    const spread = ((this.aiming || this.driveAim) ? W.aimSpread : W.spread) * (1 + this.bloom) + (moving ? W.spread * 0.4 : 0) + (veh ? W.spread * 0.5 : 0);
    const exclude = veh ? veh.body : null;
    for (let p = 0; p < W.pellets; p++) {
      // random direction inside the spread cone
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      _side.set(-_cf.z, 0, _cf.x).normalize();
      _v.crossVectors(_side, _cf);
      _bd.copy(_cf).addScaledVector(_side, Math.cos(a) * r).addScaledVector(_v, Math.sin(a) * r).normalize();
      _v.copy(veh ? veh.curPos : ch.pos);
      const depth = Math.max(0, _v.sub(cam.position).dot(_bd) - 0.6);
      _o.copy(cam.position).addScaledVector(_bd, depth);
      const hit = g.physics.raycast(_o, _bd, W.range, BULLET_FILTER, exclude, ch.collider);
      _aim.copy(hit ? hit.point : _o.addScaledVector(_bd, W.range));
      // the bullet itself leaves the muzzle
      _bd.subVectors(_aim, muzzle);
      const len = _bd.length();
      _bd.divideScalar(Math.max(len, 1e-4));
      const end = g.ballistics.shoot(ch, W, muzzle, _bd, Math.min(W.range, len + 0.8));
      if (p < 3) g.ballistics.tracer(muzzle, end);
    }
    _cf.subVectors(this.aimPoint, muzzle).normalize();
    g.effects.muzzle(muzzle, _cf);
    _side.set(_cf.z, 0, -_cf.x).normalize().negate();
    g.effects.shell(ch.ejectWorld(_ej), _side, _cf);
    g.audio.gunshot(muzzle, W.key, true);
    ch.recoilT = 1;
    const rk = (this.aiming || this.driveAim) ? 0.55 : 1;
    g.camRig.pitch -= W.recoil * rk * (0.8 + Math.random() * 0.4);
    g.camRig.yaw += (Math.random() - 0.5) * W.recoil * 0.5 * rk;
    g.camRig.shake(W.key === 'shotgun' ? 0.18 : 0.05);
    this.bloom = Math.min(1.6, this.bloom + W.bloom);
    g.peds.panic(muzzle, 40, muzzle);
    if (g.time - this.lastCrimeT > 2) { this.lastCrimeT = g.time; g.police.crime('shooting', muzzle); }
  }

  /** Aiming / firing logic shared by on-foot and drive-by shooting. */
  updateGun(dt, onFoot) {
    const g = this.game, inp = g.input, ch = this.character, gp = inp.gamepad;
    this.fireT -= dt;
    this.hipT = Math.max(0, this.hipT - dt);
    this.bloom = Math.max(0, this.bloom - dt * 2.4);
    let W = WEAPONS[this.weapon];
    const aimBtn = (inp.locked && inp.mouseDown(2)) || (gp && gp.lt > 0.5 && onFoot);
    const fireBtn = (inp.locked && inp.mouseDown(0)) || (gp && gp.rt > 0.5 && onFoot);
    this.aiming = false;
    this.driveAim = false;
    if (!onFoot) {
      // drive-by: pistol or SMG out of the window
      const veh = ch.vehicle;
      if (!aimBtn || !veh) { ch.driveBy = null; this.wasFiring = false; return; }
      if (!W.drive) { this.selectWeapon('smg'); W = WEAPONS.smg; g.hud.message('Drive-by: SMG · شلیک از ماشین', 1.4); }
      this.driveAim = true;
      const tgt = this.computeAim(veh.body);
      const local = veh.worldToLocal(_v.copy(tgt), _v);
      const hand = local.x > 0 ? 'L' : 'R';
      ch.driveBy = { target: tgt, hand };
      if (fireBtn && this.fireT <= 0 && (W.auto || !this.wasFiring)) {
        // first shot out of a closed side window breaks it
        if (Math.abs(local.x) > Math.abs(local.z) * 0.5) veh.smashWindow(hand === 'L' ? 'doorL' : 'doorR');
        this.shoot(W);
        this.fireT = W.rate;
      }
      this.wasFiring = fireBtn;
      return;
    }
    ch.driveBy = null;
    if (!W.hold) { this.wasFiring = false; ch.aimTarget = null; return; }
    this.aiming = !!aimBtn;
    if (fireBtn) this.hipT = 0.9;
    const raised = this.aiming || this.hipT > 0;
    if (raised) {
      ch.aimTarget = this.computeAim(null);
      ch.input.face = g.camRig.yaw;
    } else {
      ch.aimTarget = null;
      ch.input.face = null;
    }
    if (fireBtn && this.fireT <= 0 && ch.aimW > 0.55 && (W.auto || !this.wasFiring)) {
      this.shoot(W);
      this.fireT = W.rate;
    }
    this.wasFiring = fireBtn;
  }

  axes() {
    const inp = this.game.input;
    let ax = 0, az = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) az += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) az -= 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) ax -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) ax += 1;
    const gp = inp.gamepad;
    if (gp) { ax += gp.lx; az -= gp.ly; }
    return [clamp(ax, -1, 1), clamp(az, -1, 1)];
  }

  enterPressed() {
    const inp = this.game.input;
    return inp.hit('KeyF') || inp.hit('Enter') || (inp.gamepad && inp.gamepad.pressed('y'));
  }

  update(dt) {
    const g = this.game, inp = g.input, ch = this.character;
    if (g.bustedT) { ch.input.mag = 0; g.hud.setPrompt(''); return; }
    const gp = inp.gamepad;
    const [ax, az] = this.axes();
    this.moveIntent = Math.min(1, Math.hypot(ax, az));
    if (inp.hit('KeyC') || inp.hit('CapsLock')) { this.walk = !this.walk; g.hud.message(this.walk ? 'Walk mode · حالت راه رفتن' : 'Run mode · حالت دویدن', 1.2); }
    this.nearVehicle = null;

    if (ch.state === 'foot') {
      g.camRig.basis(_f, _r);
      _d.set(0, 0, 0).addScaledVector(_f, az).addScaledVector(_r, ax);
      if (_d.lengthSq() > 1e-6) _d.normalize();
      const sprint = inp.down('ShiftLeft') || inp.down('ShiftRight') || (gp && gp.a);
      ch.input.dir.copy(_d);
      ch.input.mag = this.moveIntent;
      ch.input.mode = sprint ? 'sprint' : this.walk ? 'walk' : 'run';
      if (inp.hit('Space') || (gp && gp.pressed('x'))) ch.input.jump = true;
      this.weaponInput(true);
      const armed = !!WEAPONS[this.weapon].hold;
      if ((!armed && inp.mouseHit(0) && inp.locked) || inp.hit('KeyQ') || (gp && gp.pressed('b'))) ch.punch();
      this.updateGun(dt, true);
      if (this.aiming || this.hipT > 0) {
        // aiming: jog at most, no sprint
        if (ch.input.mode === 'sprint') ch.input.mode = 'run';
        ch.input.mag = Math.min(ch.input.mag, this.aiming ? 0.55 : 0.8);
      }
      // head follows the camera
      ch.lookYaw = clamp(wrapAngle(g.camRig.yaw - ch.yaw), -1.2, 1.2) * (Math.abs(wrapAngle(g.camRig.yaw - ch.yaw)) < 2.2 ? 1 : 0);
      ch.lookPitch = -g.camRig.pitch * 0.4;
      // vehicle nearby?
      const veh = this.findVehicle();
      this.nearVehicle = veh;
      if (veh) g.hud.setPrompt(`[F] ${veh.isBike ? (veh.driver ? 'Hijack · دزدیدن موتور' : veh.fallen ? 'Pick up & ride · بلند کردن و سوار شدن' : 'Ride · سوار شدن موتور') : veh.driver ? 'Hijack · دزدیدن ماشین' : 'Enter · سوار شدن'}  —  ${veh.T.label}`);
      else g.hud.setPrompt('');
      if (veh && veh.isBike && this.enterPressed()) {
        ch.aimTarget = null; ch.input.face = null;
        new BikeMount(g, ch, veh);
        this.seqAge = 0;
        g.hud.setPrompt('');
      } else if (veh && this.enterPressed()) {
        let side = 1, shuffle = false;
        if (!veh.doorClear(1)) {
          if (!veh.driver && veh.doorClear(-1)) { side = -1; shuffle = true; }
          else side = 0;
        }
        if (side) {
          new EnterSequence(g, ch, veh, side, shuffle);
          this.seqAge = 0;
        } else g.hud.message('No room to open the door · جای باز کردن در نیست', 1.6);
        g.hud.setPrompt('');
      }
    } else if (ch.state === 'seq') {
      ch.aimTarget = null; ch.driveBy = null; ch.input.face = null; this.aiming = false; this.driveAim = false;
      this.seqAge += dt;
      g.hud.setPrompt('');
      const seq = ch.seq;
      if ((seq instanceof EnterSequence || seq instanceof BikeMount) && (seq.phase === 'approach' || seq.phase === 'align' || seq.phase === 'toPickup')) {
        if ((this.moveIntent > 0.5 && this.seqAge > 0.35) || (this.enterPressed() && this.seqAge > 0.2)) seq.abort('player');
      }
      if (seq instanceof ExitSequence && seq.phase === 'closeOut') {
        // allow walking away; ExitSequence checks moveIntent
        g.camRig.basis(_f, _r);
        _d.set(0, 0, 0).addScaledVector(_f, az).addScaledVector(_r, ax);
        if (_d.lengthSq() > 1e-6) _d.normalize();
        ch.input.dir.copy(_d);
        ch.input.mag = this.moveIntent;
      }
    } else if (ch.state === 'vehicle') {
      g.hud.setPrompt('');
      const v = ch.vehicle;
      this.weaponInput(false);
      this.updateGun(dt, false);
      if (v.driver === ch) {
        let thr = (inp.down('KeyW') || inp.down('ArrowUp')) ? 1 : 0;
        let brk = (inp.down('KeyS') || inp.down('ArrowDown')) ? 1 : 0;
        let steerT = ((inp.down('KeyA') || inp.down('ArrowLeft')) ? 1 : 0) - ((inp.down('KeyD') || inp.down('ArrowRight')) ? 1 : 0);
        let analog = false;
        if (gp) {
          thr = Math.max(thr, gp.rt);
          brk = Math.max(brk, gp.lt);
          if (Math.abs(gp.lx) > 0.01) { steerT = -gp.lx; analog = true; }
        }
        if (analog) this.steer = steerT;
        else {
          const rate = Math.sign(steerT) === Math.sign(this.steer) || steerT === 0 ? 3.2 : 6.5;
          this.steer = approach(this.steer, steerT, (steerT === 0 ? 5.5 : rate) * dt);
        }
        v.input.throttle = thr;
        v.input.brake = brk;
        v.input.steer = this.steer;
        v.input.handbrake = inp.down('Space') || (gp && (gp.rb || gp.a));
        if (v.isBike) v.input.wheelie = (inp.down('ShiftLeft') || inp.down('ShiftRight') || (gp && gp.x)) ? 1 : 0;
        // horn
        this.hornT -= dt;
        if ((inp.down('KeyH') || inp.down('KeyE') || (gp && gp.ls)) && this.hornT <= 0) {
          this.hornT = 0.45;
          g.audio.horn(v.curPos, 1);
          g.peds.panic(v.curPos, 10, v.curPos);
        }
        if (inp.hit('KeyR') || (gp && gp.pressed('back'))) {
          if (v.isUpsideDown() || v.speed < 3) v.flip();
        }
        if (inp.hit('KeyL')) v.lightsOn = !v.lightsOn;
        if (inp.hit('KeyG') && v.T.police) v.sirenOn = !v.sirenOn;
        g.camRig.lookBack = inp.down('KeyV') || (gp && gp.rs);
      }
      if (this.enterPressed()) {
        v.input.throttle = 0; v.input.brake = 0; v.input.handbrake = false; v.input.steer = 0;
        this.steer = 0;
        let side = ch.seatSide;
        if (!v.isBike && v.speed < 6.5 && !v.doorClear(side)) {
          side = v.doorClear(-side) ? -side : 0;
        }
        ch.driveBy = null;
        if (v.isBike) new BikeDismount(g, ch, v);
        else if (side) new ExitSequence(g, ch, v, side);
        else g.hud.message('Blocked — can\'t get out here · راه خروج بسته است', 1.6);
      }
    } else {
      g.hud.setPrompt('');
    }
  }

  findVehicle() {
    const ch = this.character;
    let best = null, bd = 6.0;
    for (const v of this.game.vehicles) {
      if (v.removed || v.speed > 9) continue;
      if (v.driver && v.driver.isPlayer) continue;
      const d = v.curPos.distanceTo(ch.pos) - v.halfW;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
}

export { _v };
