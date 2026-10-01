import * as THREE from 'three';
import { CITY, nodeCoord } from '../world/city.js';
import { clamp, makeRng, lerp } from '../core/util.js';
import { Vehicle } from '../vehicle/vehicle.js';
import { Character } from '../char/character.js';
import { randomAppearance } from '../char/rig.js';

const HR = CITY.ROAD_W / 2;
const START_D = HR + 3.4;
const STOP_D = HR + 4.0;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function nodePos(city, id) { return city.nodes[id]; }

/** Point on the right-hand lane of edge a->b at distance d from a. */
function lanePoint(city, a, b, d, out) {
  const A = nodePos(city, a), B = nodePos(city, b);
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz);
  const ux = dx / len, uz = dz / len;
  const rx = -uz, rz = ux;
  return out.set(A.x + ux * d + rx * CITY.LANE, 0, A.z + uz * d + rz * CITY.LANE);
}
function edgeDir(city, a, b) {
  const A = nodePos(city, a), B = nodePos(city, b);
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz);
  return { x: dx / len, z: dz / len, len };
}

export class DriverAI {
  constructor(game, veh, rng) {
    this.game = game;
    this.veh = veh;
    this.rng = rng || makeRng(veh.id * 13);
    this.points = [];
    this.idx = 0;
    this.cruise = this.rng.range(10.5, 14) * (veh.T.label === 'Sport' ? 1.12 : 1);
    this.blocked = 0;
    this.panic = 0;
    this.threat = null;
    this.stopForThreat = 0;
    this.honkT = 0;
    this.reverseT = 0;
    this.disabled = false;
    veh.ai = this;
  }

  start(a, b) {
    this.points = [];
    this.idx = 0;
    this.cur = [a, b];
    this.appendStraight(a, b);
    this.extend();
  }

  appendStraight(a, b) {
    const d = edgeDir(this.game.city, a, b);
    const start = START_D, end = d.len - STOP_D;
    for (let s = start; s <= end + 0.01; s += 2.5) {
      const p = lanePoint(this.game.city, a, b, Math.min(s, end), new THREE.Vector3());
      this.points.push({ x: p.x, z: p.z, stop: null, turn: 0 });
    }
    const last = this.points[this.points.length - 1];
    last.stop = { node: b, axis: Math.abs(d.x) > Math.abs(d.z) ? 'x' : 'z' };
    this.lastEdge = [a, b];
  }

  extend() {
    const city = this.game.city;
    let guard = 0;
    while (this.points.length - this.idx < 40 && guard++ < 4) {
      const [a, b] = this.lastEdge;
      const node = city.nodes[b];
      let options = node.links.filter((n) => n !== a);
      if (!options.length) options = [a];
      // prefer straight slightly
      const d0 = edgeDir(city, a, b);
      const weights = options.map((n) => {
        const d1 = edgeDir(city, b, n);
        const dot = d0.x * d1.x + d0.z * d1.z;
        return dot > 0.5 ? 2.2 : 1;
      });
      let tot = weights.reduce((s, w) => s + w, 0);
      let r = this.rng() * tot;
      let c = options[0];
      for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { c = options[i]; break; } }
      // turn curve through the intersection
      const p0 = lanePoint(city, a, b, d0.len - STOP_D, new THREE.Vector3());
      const p2 = lanePoint(city, b, c, START_D, new THREE.Vector3());
      const d1 = edgeDir(city, b, c);
      const cross = d0.x * d1.z - d0.z * d1.x;
      const straight = Math.abs(cross) < 0.1;
      let p1;
      if (straight) p1 = p0.clone().lerp(p2, 0.5);
      else {
        // intersection of the two lane lines
        const den = d0.x * d1.z - d0.z * d1.x;
        const t = ((p2.x - p0.x) * d1.z - (p2.z - p0.z) * d1.x) / den;
        p1 = new THREE.Vector3(p0.x + d0.x * t, 0, p0.z + d0.z * t);
      }
      const len = p0.distanceTo(p2);
      const n = Math.max(4, Math.ceil(len / 1.5));
      const turnType = straight ? 0 : cross > 0 ? 1 : -1;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        this.points.push({
          x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
          z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
          stop: null, turn: turnType,
        });
      }
      this.appendStraight(b, c);
    }
    // drop consumed points
    if (this.idx > 60) {
      this.points.splice(0, this.idx - 10);
      this.idx = 10;
    }
  }

  onThreat(ch) {
    this.threat = ch;
    this.stopForThreat = 6;
  }

  disable() {
    this.disabled = true;
    this.veh.input.throttle = 0;
    this.veh.input.brake = 0.4;
    this.veh.input.steer = 0;
  }

  update(dt) {
    const v = this.veh;
    if (this.disabled || !v.driver || v.driver.state !== 'vehicle') {
      if (!this.disabled) { v.input.throttle = 0; v.input.brake = 0.3; }
      return;
    }
    if (v.health <= 0) { v.input.throttle = 0; v.input.brake = 1; return; }
    const pos = v.curPos;
    const fwd = v.forward(_v);
    const speed = v.fwdSpeed;
    this.panic = Math.max(0, this.panic - dt);
    this.honkT = Math.max(0, this.honkT - dt);
    // advance along path: nearest point ahead
    const pts = this.points;
    while (this.idx < pts.length - 1) {
      const p = pts[this.idx];
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const ahead = dx * fwd.x + dz * fwd.z;
      if (ahead < 1.0 || dx * dx + dz * dz < 4) this.idx++;
      else break;
    }
    this.extend();
    // lookahead target
    const look = 4.5 + Math.abs(speed) * 0.45;
    let tgt = pts[Math.min(this.idx, pts.length - 1)];
    let acc = 0;
    for (let i = this.idx; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      acc += Math.hypot(b.x - a.x, b.z - a.z);
      tgt = b;
      if (acc >= look) break;
    }
    const local = v.worldToLocal(_v2.set(tgt.x, pos.y, tgt.z), _v2);
    const ld = Math.max(1, Math.hypot(local.x, local.z));
    const alpha = Math.atan2(local.x, local.z);
    const wb = v.T.wheelbase;
    let steerAngle = Math.atan2(2 * wb * Math.sin(alpha), ld);
    let steer = clamp(steerAngle / v.T.steerMax, -1, 1);

    // ---------------- target speed
    let target = this.cruise * (this.panic > 0 ? 1.45 : 1);
    // upcoming turns / stops
    let dist = 0;
    const city = this.game.city;
    for (let i = this.idx; i < Math.min(pts.length - 1, this.idx + 30); i++) {
      const a = pts[i], b = pts[i + 1];
      dist += Math.hypot(b.x - a.x, b.z - a.z);
      if (a.turn !== 0) {
        const vt = a.turn > 0 ? 6.8 : 5.8;
        target = Math.min(target, Math.sqrt(vt * vt + 2 * 3.0 * Math.max(0, dist - 4)));
      }
      if (a.stop && this.panic <= 0) {
        const st = city.lightState(a.stop.node, a.stop.axis, this.game.time);
        const dStop = dist - (a === pts[this.idx] ? 0 : 0) - v.halfL + 0.5;
        if (st === 'red' || (st === 'yellow' && dStop > 9)) {
          const vs = Math.sqrt(2 * 3.2 * Math.max(0, dStop - 0.8));
          target = Math.min(target, vs);
        }
        break;
      }
      if (dist > 60) break;
    }
    // obstacles ahead
    const obs = this.obstacleAhead();
    if (obs < 60) target = Math.min(target, Math.max(0, (obs - 3.2) * 0.85));
    if (this.stopForThreat > 0) {
      this.stopForThreat -= dt;
      target = 0;
    }
    // ---------------- stuck handling
    if (target > 3 && Math.abs(speed) < 0.6) this.blocked += dt; else this.blocked = Math.max(0, this.blocked - dt * 2);
    if (obs < 8 && Math.abs(speed) < 0.3) {
      this.waitObs = (this.waitObs || 0) + dt;
      if (this.waitObs > 3 && this.honkT <= 0) { this.honkT = 4; this.game.audio?.horn(v.curPos, 0.6); }
    } else this.waitObs = 0;
    if (this.blocked > 5 && this.reverseT <= 0) { this.reverseT = 1.8; this.blocked = 0; }
    let throttle = 0, brake = 0;
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      brake = 0.7; // brake when stopped == reverse
      steer = -steer;
    } else {
      const err = target - speed;
      if (err > 0) throttle = clamp(err * 0.3, 0, this.panic > 0 ? 1 : 0.75);
      else brake = clamp(-err * 0.25, 0, 1);
      // below walking pace never press the brake (it would engage reverse); the parking hold keeps the car still
      if (speed < 1.0) brake = 0;
    }
    v.input.throttle = throttle;
    v.input.brake = brake;
    v.input.steer = steer;
    v.input.handbrake = false;
  }

  /** Distance to the nearest obstacle in our lane ahead (big number if none). */
  obstacleAhead() {
    const v = this.veh;
    let best = 999;
    const check = (p, halfLen, w) => {
      const l = v.worldToLocal(p, _v2);
      if (l.z <= 0 || l.z > 45) return;
      const lat = 1.5 + l.z * 0.03 + w;
      if (Math.abs(l.x) > lat) return;
      const d = l.z - v.halfL - halfLen;
      if (d < best) best = d;
    };
    for (const o of this.game.vehicles) {
      if (o === v || o.removed) continue;
      const dx = o.curPos.x - v.curPos.x, dz = o.curPos.z - v.curPos.z;
      if (dx * dx + dz * dz > 2500) continue;
      check(o.curPos, Math.min(o.halfL, 1.4), 0.4);
    }
    for (const c of this.game.characters) {
      if (c.state === 'vehicle' || c.removed) continue;
      const dx = c.pos.x - v.curPos.x, dz = c.pos.z - v.curPos.z;
      if (dx * dx + dz * dz > 900) continue;
      if (c.pos.y > 0.12 && c.state === 'foot') continue; // on the sidewalk
      check(c.pos, 0.4, -0.2);
    }
    return best;
  }
}

/* ======================================================================= manager */
const TYPES = [['sedan', 0.34], ['taxi', 0.14], ['suv', 0.2], ['sport', 0.1], ['muscle', 0.12], ['police', 0.04]];
function pickType(r) {
  let x = r();
  for (const [t, w] of TYPES) { x -= w; if (x <= 0) return t; }
  return 'sedan';
}

export class TrafficManager {
  constructor(game) {
    this.game = game;
    this.cars = [];
    this.target = 13;
    this.spawnTimer = 0;
    this.rng = makeRng(4242);
  }

  update(dt) {
    const g = this.game;
    const pp = g.player.character.pos;
    // despawn
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const v = this.cars[i];
      const d2 = (v.curPos.x - pp.x) ** 2 + (v.curPos.z - pp.z) ** 2;
      const isPlayers = v === g.player.lastVehicle || v.driver === g.player.character;
      if (v.removed) { this.cars.splice(i, 1); continue; }
      if (!isPlayers && d2 > 230 * 230) {
        this.removeCar(v);
        this.cars.splice(i, 1);
      }
    }
    this.spawnTimer -= dt;
    const active = this.cars.filter((v) => v.ai && !v.ai.disabled).length;
    if (active < this.target && this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.trySpawn(70, 190);
    }
    for (const v of this.cars) if (v.ai) v.ai.update(dt);
  }

  removeCar(v) {
    const g = this.game;
    if (v.driver && v.driver !== g.player.character) {
      g.removeCharacter(v.driver);
    }
    for (const p of v.passengers) if (p !== g.player.character) g.removeCharacter(p);
    g.removeVehicle(v);
  }

  trySpawn(minD, maxD, near = null) {
    const g = this.game, city = g.city;
    const pp = near || g.player.character.pos;
    const r = this.rng;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = r.int(0, city.nodes.length - 1);
      const na = city.nodes[a];
      const b = r.pick(na.links);
      const d = edgeDir(city, a, b);
      const s = r.range(START_D + 2, d.len - STOP_D - 6);
      const p = lanePoint(city, a, b, s, new THREE.Vector3());
      const dist = Math.hypot(p.x - pp.x, p.z - pp.z);
      if (dist < minD || dist > maxD) continue;
      // clear?
      let clear = true;
      for (const v of g.vehicles) {
        if ((v.curPos.x - p.x) ** 2 + (v.curPos.z - p.z) ** 2 < 14 * 14) { clear = false; break; }
      }
      if (!clear) continue;
      const type = pickType(r);
      const yaw = Math.atan2(d.x, d.z);
      const sp = 8;
      const veh = g.addVehicle(type, null, p.setY(0.08), yaw, { vel: new THREE.Vector3(d.x * sp, 0, d.z * sp) });
      const driver = new Character(g, randomAppearance(r.int(1, 1e9)));
      g.addCharacter(driver);
      driver.teleport(p, yaw);
      driver.enterVehicleInstant(veh, 1);
      if (type === 'police') veh.sirenOn = false;
      const ai = new DriverAI(g, veh, makeRng(r.int(1, 1e9)));
      // the lane start index: find the point closest to s
      ai.start(a, b);
      // skip points behind
      ai.idx = Math.max(0, Math.floor((s - START_D) / 2.5));
      this.cars.push(veh);
      return veh;
    }
    return null;
  }
}

export { lanePoint, lerp };
