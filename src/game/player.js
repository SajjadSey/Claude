import * as THREE from 'three';
import { EnterSequence, ExitSequence } from '../char/carSequences.js';
import { clamp, approach, wrapAngle } from '../core/util.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();

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
      if ((inp.mouseHit(0) && inp.locked) || inp.hit('KeyQ') || (gp && gp.pressed('b'))) ch.punch();
      // head follows the camera
      ch.lookYaw = clamp(wrapAngle(g.camRig.yaw - ch.yaw), -1.2, 1.2) * (Math.abs(wrapAngle(g.camRig.yaw - ch.yaw)) < 2.2 ? 1 : 0);
      ch.lookPitch = -g.camRig.pitch * 0.4;
      // vehicle nearby?
      const veh = this.findVehicle();
      this.nearVehicle = veh;
      if (veh) g.hud.setPrompt(`[F] ${veh.driver ? 'Hijack · دزدیدن ماشین' : 'Enter · سوار شدن'}  —  ${veh.T.label}`);
      else g.hud.setPrompt('');
      if (veh && this.enterPressed()) {
        new EnterSequence(g, ch, veh, 1);
        this.seqAge = 0;
        g.hud.setPrompt('');
      }
    } else if (ch.state === 'seq') {
      this.seqAge += dt;
      g.hud.setPrompt('');
      const seq = ch.seq;
      if (seq instanceof EnterSequence && (seq.phase === 'approach' || seq.phase === 'align')) {
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
        new ExitSequence(g, ch, v);
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
