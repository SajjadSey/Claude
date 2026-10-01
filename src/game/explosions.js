import * as THREE from 'three';
import { clamp } from '../core/util.js';

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Wrecked cars catch fire and explode, flinging everything nearby. */
export class Explosions {
  constructor(game) {
    this.game = game;
    this.flash = new THREE.PointLight(0xffa040, 0, 32, 2);
    game.scene.add(this.flash);
    this.flashT = 0;
  }

  update(dt) {
    const g = this.game;
    for (const v of g.vehicles) {
      if (v.removed || v.exploded) continue;
      // cars left upside down eventually catch fire too
      if (v.isUpsideDown() && v.speed < 1.5) {
        v.upsideT = (v.upsideT || 0) + dt;
        // after a while on its roof the engine starts to cook: smoke first, fire later
        if (v.upsideT > 8 && v.health > 0) v.health = Math.max(0, v.health - 12 * dt);
      } else v.upsideT = 0;
      if (v.health <= 0) {
        if (v.burnT === undefined) {
          v.burnT = 10;
          v.engineOn = false;
          g.hud?.message && v.driver === g.player.character && g.hud.message('🔥 Get out! · سریع پیاده شو!', 2.5);
        }
        v.burnT -= dt;
        v.localToWorld(_v.set(0, v.T.beltY + 0.1, v.halfL - 0.7), _v);
        const k = clamp(1.2 - v.burnT / 10, 0.4, 1.3);
        if (Math.random() < dt * 40) g.effects.fire(_v, k);
        if (Math.random() < dt * 15) g.effects.engineSmoke(_v, true);
        if (v.burnT <= 0) this.explode(v);
      }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.intensity = Math.max(0, this.flashT / 0.7) ** 2 * 7000;
    } else this.flash.intensity = 0;
  }

  explode(v) {
    const g = this.game;
    v.exploded = true;
    g.onExploded?.(v);
    const p = v.curPos.clone();
    p.y += 0.8;
    g.effects.explosion(p);
    g.audio?.explosion?.(p);
    this.flash.position.copy(p);
    this.flashT = 0.7;
    const pc = g.player.character;
    const camD = g.camera.position.distanceTo(p);
    g.camRig.shake(clamp(1.2 - camD / 60, 0.1, 1));
    // the car itself jumps and turns black
    v.body.applyImpulseAtPoint({ x: (Math.random() - 0.5) * 3000, y: v.T.mass * 6.5, z: (Math.random() - 0.5) * 3000 },
      { x: p.x + (Math.random() - 0.5), y: p.y - 0.4, z: p.z + (Math.random() - 0.5) }, true);
    v.model.paint.color.setRGB(0.06, 0.055, 0.05);
    v.model.paint.clearcoat = 0.1;
    v.model.paint.roughness = 0.9;
    v.model.paint.metalness = 0.2;
    v.headBroken = true;
    v.tailBroken = true;
    for (const m of Object.values(v.model.glassMeshes)) if (m) m.visible = false;
    for (const d of v.model.doors) { d.latched = false; d.scripted = false; d.vel = (Math.random() * 2 + 2); }
    v.deform(new THREE.Vector3(0, v.T.beltY, v.halfL - 0.6), new THREE.Vector3(0, -0.6, -0.4).normalize(), 0.25, 1.6);
    // blast wave
    const R = 13;
    for (const o of g.vehicles) {
      if (o === v || o.removed) continue;
      _d.subVectors(o.curPos, p);
      const d = _d.length();
      if (d > R) continue;
      const f = (1 - d / R);
      _d.normalize();
      const J = o.T.mass * 9 * f;
      o.body.applyImpulseAtPoint({ x: _d.x * J, y: J * 0.6, z: _d.z * J }, { x: o.curPos.x, y: o.curPos.y + 0.3, z: o.curPos.z }, true);
      o.applyDamage(o.curPos.clone().addScaledVector(_d, -o.halfW), 20000 * f, null);
    }
    for (const c of g.characters) {
      const cp = c.ragdoll.active ? c.ragdoll.hipsPosition(_v) : c.pos;
      _d.subVectors(cp, p);
      const d = _d.length();
      if (d > R * 0.8) continue;
      const f = 1 - d / (R * 0.8);
      if (c.vehicle === v) { c.damage(500, 'explosion'); }
      else c.damage(140 * f, 'explosion');
      _d.y = 0;
      _d.normalize();
      const vel = new THREE.Vector3(_d.x * 16 * f, 4 + 8 * f, _d.z * 16 * f);
      if (c.state === 'vehicle' && c.vehicle !== v) continue;
      if (c.vehicle === v && c.state === 'vehicle') {
        // thrown out of the burning wreck
        c.leaveVehicleInstant();
        c.state = 'foot';
      }
      if (c.ragdoll.active) c.ragdoll.addVelocity(vel);
      else c.toRagdoll(vel, { spin: 3 });
    }
    for (const pr of g.props.list) {
      const t = pr.body.translation();
      _d.set(t.x - p.x, t.y - p.y, t.z - p.z);
      const d = _d.length();
      if (d > R) continue;
      _d.normalize();
      const J = (pr.mass || 20) * 12 * (1 - d / R);
      pr.body.applyImpulse({ x: _d.x * J, y: J * 0.7, z: _d.z * J }, true);
    }
    g.peds.panic(p, 40, p);
    void pc;
  }
}
