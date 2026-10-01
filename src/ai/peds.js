import * as THREE from 'three';
import { Character } from '../char/character.js';
import { randomAppearance } from '../char/rig.js';
import { makeRng, clamp, wrapAngle } from '../core/util.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class PedAI {
  constructor(game, ch, rng) {
    this.game = game;
    this.c = ch;
    this.rng = rng || makeRng(ch.id * 97 + 1);
    this.mode = 'walk';
    this.node = -1;
    this.next = -1;
    this.prev = -1;
    this.wait = 0;
    this.fleeT = 0;
    this.threat = new THREE.Vector3();
    this.laneOff = this.rng.range(-0.7, 0.7);
    this.speedK = this.rng.range(0.85, 1.12);
    this.idleT = 0;
    this.repath = 0;
    this.lookT = 0;
    ch.ai = this;
  }

  startAt(nodeId) {
    const nodes = this.game.city.pedNodes;
    this.node = nodeId;
    const n = nodes[nodeId];
    this.next = this.rng.pick(n.links);
    this.prev = nodeId;
  }

  nearestNode(p) {
    const nodes = this.game.city.pedNodes;
    let best = 0, bd = 1e9;
    for (const n of nodes) {
      const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2;
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }

  flee(from, t = 8) {
    this.mode = 'flee';
    this.threat.copy(from);
    this.fleeT = t + this.rng.range(0, 3);
  }

  fight(target) {
    this.mode = 'fight';
    this.target = target;
    this.fightT = 10;
  }

  update(dt) {
    const c = this.c;
    if (c.state !== 'foot') return;
    const g = this.game;
    const nodes = g.city.pedNodes;
    let dirX = 0, dirZ = 0, mag = 0, mode = 'walk';
    if (this.mode === 'flee') {
      this.fleeT -= dt;
      _v.set(c.pos.x - this.threat.x, 0, c.pos.z - this.threat.z);
      if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
      _v.normalize();
      dirX = _v.x; dirZ = _v.z; mag = 1; mode = this.fleeT > 3 ? 'sprint' : 'run';
      if (this.fleeT <= 0) {
        this.mode = 'walk';
        this.startAt(this.nearestNode(c.pos));
      }
    } else if (this.mode === 'fight') {
      const t = this.target;
      this.fightT -= dt;
      if (!t || t.state !== 'foot' || this.fightT <= 0 || !t.alive) { this.flee(t ? t.pos : c.pos, 6); return; }
      _v.set(t.pos.x - c.pos.x, 0, t.pos.z - c.pos.z);
      const d = _v.length();
      _v.normalize();
      if (d > 1.0) { dirX = _v.x; dirZ = _v.z; mag = 1; mode = d > 4 ? 'run' : 'walk'; }
      else {
        c.yaw = c.yaw + wrapAngle(Math.atan2(_v.x, _v.z) - c.yaw) * Math.min(1, dt * 8);
        if (this.rng() < dt * 1.6) c.punch();
      }
    } else if (this.mode === 'wait') {
      this.wait -= dt;
      if (this.wait <= 0) {
        if (this.crossingClear(this.node, this.next)) this.mode = 'walk';
        else this.wait = 0.5;
      }
      const n = nodes[this.next];
      c.input.dir.set(0, 0, 0);
      c.input.mag = 0;
      c.lookYaw = clamp(wrapAngle(Math.atan2(n.x - c.pos.x, n.z - c.pos.z) - c.yaw), -1, 1);
      return;
    } else {
      // walk the sidewalk graph
      if (this.next < 0) this.startAt(this.nearestNode(c.pos));
      const a = nodes[this.node], b = nodes[this.next];
      // offset target sideways so peds don't walk in a single file
      const ex = b.x - a.x, ez = b.z - a.z;
      const el = Math.hypot(ex, ez) || 1;
      const tx = b.x + (-ez / el) * this.laneOff, tz = b.z + (ex / el) * this.laneOff;
      _v.set(tx - c.pos.x, 0, tz - c.pos.z);
      const d = _v.length();
      if (d < 0.9) this.arrive();
      _v.normalize();
      dirX = _v.x; dirZ = _v.z; mag = this.speedK;
      // idle pauses (looking around)
      if (this.idleT > 0) { this.idleT -= dt; mag = 0; }
      else if (this.rng() < dt * 0.01) this.idleT = this.rng.range(1.5, 4);
      this.lookT -= dt;
      if (this.lookT <= 0) { this.lookT = this.rng.range(2, 6); c.lookYaw = this.rng.range(-0.7, 0.7) * (this.rng() < 0.5 ? 1 : 0); }
    }
    // separation from other characters
    for (const o of g.characters) {
      if (o === c || o.state !== 'foot') continue;
      const dx = c.pos.x - o.pos.x, dz = c.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.0 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        dirX += dx / d * (1 - d) * 0.9;
        dirZ += dz / d * (1 - d) * 0.9;
      }
    }
    // dodge fast cars heading at us
    for (const v of g.vehicles) {
      if (v.speed < 6) continue;
      const dx = c.pos.x - v.curPos.x, dz = c.pos.z - v.curPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 225) continue;
      const vel = v.linvel(_v2);
      const along = (dx * vel.x + dz * vel.z) / Math.max(0.1, v.speed);
      const lat = Math.abs(dx * vel.z - dz * vel.x) / Math.max(0.1, v.speed);
      if (along > 0 && along < 14 && lat < 3) {
        // jump out of the way, perpendicular to the car's path
        const sx = (dx * vel.z - dz * vel.x) > 0 ? 1 : -1;
        dirX = vel.z / v.speed * sx; dirZ = -vel.x / v.speed * sx;
        mag = 1; mode = 'sprint';
        if (this.mode === 'walk' && this.rng() < 0.02) this.flee(v.curPos, 4);
      }
    }
    const l = Math.hypot(dirX, dirZ);
    if (l > 1e-4) c.input.dir.set(dirX / l, 0, dirZ / l); else c.input.dir.set(0, 0, 0);
    c.input.mag = mag;
    c.input.mode = mode;
  }

  arrive() {
    const nodes = this.game.city.pedNodes;
    const n = nodes[this.next];
    const opts = n.links.filter((x) => x !== this.node);
    const choice = opts.length ? this.rng.pick(opts) : this.node;
    this.prev = this.node;
    this.node = this.next;
    this.next = choice;
    const idx = n.links.indexOf(choice);
    if (n.cross[idx]) {
      if (!this.crossingClear(this.node, this.next)) { this.mode = 'wait'; this.wait = 0.6; }
    }
  }

  crossingClear(a, b) {
    const nodes = this.game.city.pedNodes;
    const A = nodes[a], B = nodes[b];
    const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
    for (const v of this.game.vehicles) {
      if (v.speed < 1.5) continue;
      const dx = mx - v.curPos.x, dz = mz - v.curPos.z;
      const d = Math.hypot(dx, dz);
      if (d > 30) continue;
      const vel = v.linvel(_v2);
      const toward = (dx * vel.x + dz * vel.z) / (d * v.speed + 1e-3);
      if (toward > 0.3 && d / v.speed < 4.5) return false;
    }
    return true;
  }
}

export class PedManager {
  constructor(game) {
    this.game = game;
    this.peds = [];
    this.target = 26;
    this.rng = makeRng(777);
    this.timer = 0;
  }

  update(dt) {
    const g = this.game;
    const pp = g.player.character.pos;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const c = this.peds[i];
      if (c.removed) { this.peds.splice(i, 1); continue; }
      const d2 = (c.pos.x - pp.x) ** 2 + (c.pos.z - pp.z) ** 2;
      const tooFar = d2 > 150 * 150 || (c.state === 'dead' && d2 > 60 * 60 && c.ragdollTime > 20);
      if (tooFar && c.state !== 'vehicle') {
        g.removeCharacter(c);
        this.peds.splice(i, 1);
      }
    }
    this.timer -= dt;
    const alive = this.peds.filter((c) => c.state !== 'dead').length;
    if (alive < this.target && this.timer <= 0) {
      this.timer = 0.15;
      this.spawn(35, 110);
    }
    for (const c of this.peds) if (c.ai) c.ai.update(dt);
  }

  spawn(minD, maxD, near = null) {
    const g = this.game;
    const nodes = g.city.pedNodes;
    const pp = near || g.player.character.pos;
    for (let k = 0; k < 10; k++) {
      const n = nodes[this.rng.int(0, nodes.length - 1)];
      const d = Math.hypot(n.x - pp.x, n.z - pp.z);
      if (d < minD || d > maxD) continue;
      const c = new Character(g, randomAppearance(this.rng.int(1, 1e9)));
      g.addCharacter(c);
      const ai = new PedAI(g, c, makeRng(this.rng.int(1, 1e9)));
      ai.startAt(n.id);
      const nb = nodes[ai.next];
      const t = this.rng.range(0, 0.8);
      const x = n.x + (nb.x - n.x) * t, z = n.z + (nb.z - n.z) * t;
      c.teleport(_v.set(x, c.groundAt(x, z, 0.5), z), Math.atan2(nb.x - n.x, nb.z - n.z));
      if (t > 0.01) ai.node = n.id;
      c.input.mode = 'walk';
      this.peds.push(c);
      return c;
    }
    return null;
  }

  adopt(c, mode, threat) {
    if (!c.ai) new PedAI(this.game, c);
    if (!this.peds.includes(c)) this.peds.push(c);
    if (mode === 'flee') c.ai.flee(threat, 10);
    else if (mode === 'fight') c.ai.fight(threat);
  }

  panic(pos, radius = 25, source = null) {
    for (const c of this.peds) {
      if (!c.ai || c.state !== 'foot') continue;
      const d = c.pos.distanceTo(pos);
      if (d < radius && c.ai.mode !== 'fight') c.ai.flee(source ? source : pos, 6 + (radius - d) * 0.2);
    }
  }
}
