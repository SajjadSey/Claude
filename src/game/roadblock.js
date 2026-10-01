import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY, nodeCoord } from '../world/city.js';
import { clamp } from '../core/util.js';

/*
 * Police roadblocks (3+ stars): two patrol cars parked at an angle across the street a block or two
 * ahead of a fleeing driver, officers behind them with their guns drawn, and stinger spike strips
 * laid across the lanes in front. The sidewalks stay open: you can try to squeeze round them.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const HALF_ROAD = CITY.ROAD_W / 2;
const EXTENT = nodeCoord(CITY.N - 1);

// ------------------------------------------------------------------ spike strip
let stripGeo = null, stripMats = null;
function stripAssets() {
  if (stripGeo) return { geo: stripGeo, mats: stripMats };
  // one 6 m stinger: hinged zig-zag links (dark), a carpet of steel spikes, yellow end grips
  const base = [], spikes = [], grips = [];
  const L = 6, nSeg = 12, segL = L / nSeg;
  for (let i = 0; i < nSeg; i++) {
    const x = -L / 2 + segL * (i + 0.5);
    const a = (i % 2 ? 1 : -1) * 0.22;
    const g = new THREE.BoxGeometry(segL * 1.04, 0.022, 0.3).rotateY(a).translate(x, 0.011, 0);
    base.push(g);
    for (let k = 0; k < 6; k++) {
      for (const zz of [-0.09, 0.0, 0.09]) {
        const sx = x - segL / 2 + segL * (k + 0.5) / 6;
        const sz = zz + Math.sin(a) * (sx - x);
        spikes.push(new THREE.ConeGeometry(0.009, 0.05, 4).translate(sx, 0.045, sz));
      }
    }
  }
  for (const s of [-1, 1]) grips.push(new THREE.BoxGeometry(0.16, 0.05, 0.36).translate(s * (L / 2 + 0.06), 0.025, 0));
  const merge = (list) => { const m = mergeGeometries(list, false); for (const g of list) g.dispose(); return m; };
  stripGeo = { base: merge(base), spikes: merge(spikes), grips: merge(grips), L, W: 0.36 };
  stripMats = {
    base: new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.6, roughness: 0.5 }),
    spikes: new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.95, roughness: 0.25 }),
    grips: new THREE.MeshStandardMaterial({ color: 0xf2c200, metalness: 0.1, roughness: 0.6 }),
  };
  return { geo: stripGeo, mats: stripMats };
}

export class SpikeStrip {
  constructor(game, pos, yaw) {
    this.game = game;
    const { geo, mats } = stripAssets();
    this.L = geo.L;
    this.W = geo.W;
    this.root = new THREE.Group();
    for (const k of ['base', 'spikes', 'grips']) {
      const m = new THREE.Mesh(geo[k], mats[k]);
      m.receiveShadow = true;
      this.root.add(m);
    }
    this.root.position.copy(pos);
    this.root.rotation.y = yaw;
    game.scene.add(this.root);
    this.pos = pos.clone();
    this.yaw = yaw;
    this.removed = false;
  }

  /** Burst the tyres of anything rolling over it (police drivers know where it is). */
  update() {
    const g = this.game;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const v of g.vehicles) {
      if (v.removed || v.policeUnit || !v.wheels) continue;
      if ((v.curPos.x - this.pos.x) ** 2 + (v.curPos.z - this.pos.z) ** 2 > 64) continue;
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        if (w.burst || !w.grounded) continue;
        v.localToWorld(_v.set(w.x || 0, 0, w.z), _v2);
        const dx = _v2.x - this.pos.x, dz = _v2.z - this.pos.z;
        // strip frame: x along the strip, z across it
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < this.L / 2 + 0.05 && Math.abs(lz) < this.W / 2 + 0.12 && Math.abs(_v2.y - this.pos.y) < 0.9) {
          v.burstTire(i);
          if (v.driver && v.driver.isPlayer) g.hud.message('Spike strip! · تایر ترکید', 1.6);
        }
      }
    }
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.game.scene.remove(this.root); // (the geometry is shared by all strips)
  }
}

// ------------------------------------------------------------------ roadblocks
export class Roadblocks {
  constructor(police) {
    this.police = police;
    this.game = police.game;
    this.list = [];
    this.timer = 12;
  }

  get active() { return this.list.length; }

  update(dt) {
    const P = this.police, g = this.game, W = P.wanted, pc = g.player.character;
    // set one up now and then, while the player is driving away with 3+ stars
    this.timer -= dt;
    const veh = pc.state === 'vehicle' ? pc.vehicle : null;
    if (W.stars >= 3 && W.seen && veh && veh.speed > 9 && this.timer <= 0 && this.list.length < (W.stars >= 5 ? 2 : 1)) {
      this.timer = this.tryPlace(veh) ? (W.stars >= 5 ? 22 : W.stars >= 4 ? 28 : 36) : 2;
    }
    const pp = P.playerPos(_v);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const rb = this.list[i];
      rb.t += dt;
      for (const s of rb.strips) s.update();
      // has the player got past it (or turned off)?
      const along = (pp.x - rb.pos.x) * rb.dir.x + (pp.z - rb.pos.z) * rb.dir.z;
      const d = Math.hypot(pp.x - rb.pos.x, pp.z - rb.pos.z);
      // (or stopped at it and got out: then it's an ordinary arrest / chase)
      if (!rb.passed && (along > 6 || (rb.t > 6 && d > 120) || W.stars === 0 || (pc.state !== 'vehicle' && d < 30))) rb.passed = true;
      // packed up once it's well behind and out of sight
      const camD = g.camera.position.distanceTo(rb.pos);
      if ((rb.passed && camD > 120) || rb.t > 150 || (W.stars === 0 && camD > 60)) {
        for (const s of rb.strips) s.remove();
        for (const u of rb.units) { u.roadblock = null; if (!u.dead && W.stars === 0) P.release(u); }
        this.list.splice(i, 1);
      }
    }
  }

  /** Find the street ahead of the player's car and block it 90-170 m out. */
  tryPlace(veh) {
    const g = this.game, P = this.police;
    const p = veh.curPos, vel = veh.linvel(_v2);
    const B = CITY.BLOCK;
    let axis, dirSign, line, along;
    if (Math.abs(vel.x) > Math.abs(vel.z)) { axis = 'x'; dirSign = Math.sign(vel.x); line = Math.round(p.z / B) * B; along = p.x; if (Math.abs(p.z - line) > HALF_ROAD + 2) return false; }
    else { axis = 'z'; dirSign = Math.sign(vel.z); line = Math.round(p.x / B) * B; along = p.z; if (Math.abs(p.x - line) > HALF_ROAD + 2) return false; }
    if (Math.abs(line) > EXTENT + 1) return false;
    // mid-block positions ahead (between two intersections)
    for (let k = 1; k <= 3; k++) {
      const node = Math.floor(along / B + (dirSign > 0 ? 1 : 0)) * B + (dirSign > 0 ? (k - 1) * B : -(k - 1) * B);
      const at = node + dirSign * B * 0.55;
      const dist = (at - along) * dirSign;
      if (dist < 90 || dist > 175) continue;
      if (Math.abs(at) > EXTENT - 12) continue;
      const pos = axis === 'x' ? new THREE.Vector3(at, 0, line) : new THREE.Vector3(line, 0, at);
      let clear = true;
      for (const v of g.vehicles) if ((v.curPos.x - pos.x) ** 2 + (v.curPos.z - pos.z) ** 2 < 14 * 14) { clear = false; break; }
      if (!clear) continue;
      for (const rb of this.list) if (rb.pos.distanceTo(pos) < 40) clear = false;
      if (!clear) continue;
      const dir = axis === 'x' ? new THREE.Vector3(dirSign, 0, 0) : new THREE.Vector3(0, 0, dirSign);
      // make room: unattended parked cars on this stretch go
      for (const v of g.vehicles.slice()) {
        if (v.driver || v === g.player.lastVehicle || v.policeUnit || v.persistent) continue;
        if ((v.curPos.x - pos.x) ** 2 + (v.curPos.z - pos.z) ** 2 < 16 * 16) g.removeVehicle(v);
      }
      this.build(pos, dir);
      return true;
    }
    return false;
  }

  build(pos, dir) {
    const g = this.game, P = this.police, W = P.wanted;
    const left = new THREE.Vector3(dir.z, 0, -dir.x); // left of the player's travel direction
    const roadYaw = Math.atan2(dir.x, dir.z);
    const rb = { pos: pos.clone(), dir: dir.clone(), units: [], strips: [], t: 0, passed: false };
    // two cars nose to nose at an angle, blocking both directions
    const cars = [
      { w: 3.2, u: 0, yaw: roadYaw + Math.PI / 2 - 0.45 },
      { w: -3.4, u: 1.6, yaw: roadYaw - Math.PI / 2 + 0.45 },
    ];
    for (const [ci, cd] of cars.entries()) {
      const cp = pos.clone().addScaledVector(left, cd.w).addScaledVector(dir, cd.u);
      cp.y = 0.1;
      const veh = g.addVehicle('police', null, cp, cd.yaw, {});
      veh.input.handbrake = true;
      const cops = [];
      const n = W.stars >= 4 ? 2 : (ci === 0 ? 2 : 1);
      for (let k = 0; k < n; k++) {
        const c = P.makeCop(P.rng.int(1, 1e9));
        // behind the cars, spread across the road, guns out
        const sp = pos.clone().addScaledVector(dir, 5 + P.rng.range(0, 2.5)).addScaledVector(left, cd.w + (k ? -1.6 : 1.4) * Math.sign(cd.w));
        sp.y = 0.05;
        c.teleport(sp, roadYaw + Math.PI);
        c.seatSide = k === 0 ? 1 : -1;
        cops.push(c);
      }
      const u = P.attachUnit(veh, cops, true);
      u.onFoot = true;
      u.ai.disabled = true;
      u.roadblock = rb;
      u.post = cops.map((c) => c.pos.clone());
      rb.units.push(u);
    }
    // stingers across all lanes in front of the cars
    for (const w of [-3.0, 3.0]) {
      const sp = pos.clone().addScaledVector(dir, -9).addScaledVector(left, w);
      sp.y = 0.012;
      rb.strips.push(new SpikeStrip(g, sp, roadYaw)); // (strip length runs across the road)
    }
    this.list.push(rb);
    return rb;
  }

  /** Is (x, z) inside a roadblock's footprint (keeps parked cars from spawning into it)? */
  blocks(x, z) {
    for (const rb of this.list) if ((rb.pos.x - x) ** 2 + (rb.pos.z - z) ** 2 < 15 * 15) return true;
    return false;
  }

  clear() {
    for (const rb of this.list) for (const s of rb.strips) s.remove();
    this.list.length = 0;
    this.timer = 12;
  }
}

export { clamp };
