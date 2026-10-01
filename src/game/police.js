import * as THREE from 'three';
import { CITY, nodeCoord } from '../world/city.js';
import { clamp, makeRng, wrapAngle } from '../core/util.js';
import { G, groups } from '../core/physics.js';
import { DriverAI, lanePoint, edgeDir, START_D, STOP_D } from '../ai/traffic.js';
import { Character } from '../char/character.js';
import { copAppearance } from '../char/rig.js';
import { ExitSequence, EnterSequence } from '../char/carSequences.js';

/*
 * Wanted level (0-5 stars) and the police response.
 *
 * Crimes add points; enough points raise the star level. Every level has a hard cap on how many
 * patrol cars may chase the player, how many officers may shoot at once, how accurate they are
 * and how long the player must stay out of sight to lose them, so a chase escalates but never
 * turns into an endless swarm.
 */
const STAR_POINTS = [0, 1, 6, 14, 26, 42];
const MAX_UNITS = [0, 1, 2, 3, 4, 5];
const MAX_SHOOTERS = [0, 0, 2, 3, 3, 4];
const ACCURACY = [0, 0, 0.16, 0.22, 0.27, 0.32];
const DAMAGE = [0, 0, 6, 7, 8, 9];
const EVADE_TIME = [0, 9, 13, 18, 24, 30];
const SEARCH_R = [0, 70, 90, 115, 140, 170];
// after losing line of sight the police keep tracking the player this long (radio, "he went left")
const GRACE = [0, 2.5, 3, 3.5, 4, 4.5];

// pts: points added; witness: needs a police officer to see it (unless already wanted); min: star floor
const CRIMES = {
  assault: { pts: 1, witness: true },
  jack: { pts: 1, witness: true },
  hitPed: { pts: 1.5, witness: true },
  killCiv: { pts: 3, witness: false, min: 1 },
  assaultCop: { pts: 4, witness: false, min: 1 },
  ramCop: { pts: 2, witness: false, min: 1 },
  stealCop: { pts: 5, witness: false, min: 2 },
  killCop: { pts: 8, witness: false, min: 2 },
  explosion: { pts: 3, witness: false, min: 1 },
};

const N = CITY.N;
const HR = CITY.ROAD_W / 2;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _eye = new THREE.Vector3();

/* =================================================================== wanted state */
export class Wanted {
  constructor() {
    this.stars = 0;
    this.points = 0;
    this.seen = false;
    this.lastKnown = new THREE.Vector3();
    this.unseenT = 0;
    this.flash = 0;
  }
  get evadeTime() { return EVADE_TIME[this.stars]; }
  get searchR() { return SEARCH_R[this.stars]; }
  clear() {
    this.stars = 0;
    this.points = 0;
    this.seen = false;
    this.unseenT = 0;
  }
}

/** The road edge (a -> b, node ids) a car at pos heading fwd is driving along, or null off-road. */
function edgeAt(pos, fwd) {
  const B = CITY.BLOCK, c0 = nodeCoord(0);
  const k = (x) => clamp(Math.round((x - c0) / B), 0, N - 1);
  const i = k(pos.x), j = k(pos.z);
  const onNS = Math.abs(pos.x - nodeCoord(i)) < HR + 3;
  const onEW = Math.abs(pos.z - nodeCoord(j)) < HR + 3;
  if (!onNS && !onEW) return null;
  const useNS = onNS && (!onEW || Math.abs(fwd.z) >= Math.abs(fwd.x));
  if (useNS) {
    const j0 = clamp(Math.floor((pos.z - c0) / B), 0, N - 2);
    const A = i * N + j0, Bn = i * N + j0 + 1;
    return fwd.z >= 0 ? [A, Bn] : [Bn, A];
  }
  const i0 = clamp(Math.floor((pos.x - c0) / B), 0, N - 2);
  const A = i0 * N + j, Bn = (i0 + 1) * N + j;
  return fwd.x >= 0 ? [A, Bn] : [Bn, A];
}

/* =================================================================== pursuit driver */
/**
 * Drives a patrol car. Far away it follows the road graph towards the player like normal traffic
 * (but with the siren on: no red lights, higher speeds). Once it reaches the player's track it
 * follows the exact route the player took, which is always drivable, and closes in directly at
 * the end. Without sight of the player it only knows the trail up to where they were last seen.
 */
export class PoliceDriver extends DriverAI {
  constructor(game, veh, police) {
    super(game, veh);
    this.police = police;
    this.mode = 'route';
    this.tIdx = -1;
    this.replanT = 0;
    this.stuckT = 0;
    this.revT = 0;
    this.cruise = 19;
    this.turnK = 1.45;
    this.decel = 5.5;
    this.wander = false;
  }

  get chasing() { return !this.wander && this.police.wanted.stars > 0; }

  onThreat(ch) { if (!ch.isCop) super.onThreat(ch); }

  chooseNext(a, b, options) {
    if (!this.chasing) return super.chooseNext(a, b, options);
    const P = this.police, W = P.wanted, city = this.game.city;
    const tgt = W.seen ? P.playerPos(_v3) : W.lastKnown;
    const nb = city.nodes[b];
    // searching: roam the streets around the last known position
    if (!W.seen && Math.hypot(nb.x - tgt.x, nb.z - tgt.z) < W.searchR * 0.6) return super.chooseNext(a, b, options);
    let best = options[0], bd = Infinity;
    for (const n of options) {
      const p = city.nodes[n];
      const d = Math.hypot(p.x - tgt.x, p.z - tgt.z) + this.rng() * 4;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** Siren on: pull into the opposite lane around slow or stopped traffic. */
  overtake(dt) {
    this.passT = Math.max(0, (this.passT || 0) - dt);
    if (this.passT <= 0) { this.passing = null; this.laneShift = 0; }
    const v = this.veh;
    if (this.passing || !this.chasing) return;
    const fwd = v.forward(_v);
    let best = null, bd = 30;
    for (const o of this.game.vehicles) {
      if (o === v || o.removed || o.speed > Math.max(4, v.speed * 0.6)) continue;
      const l = v.worldToLocal(o.curPos, _v3);
      if (l.z < 3 || l.z > bd || Math.abs(l.x) > 2.2) continue;
      best = o; bd = l.z;
    }
    void fwd;
    if (!best) return;
    // is the other lane clear for a while?
    for (const o of this.game.vehicles) {
      if (o === v || o === best || o.removed) continue;
      const l = v.worldToLocal(o.curPos, _v3);
      if (l.z > 0 && l.z < 45 && l.x > 2.2 && l.x < 7.5) return;
    }
    this.passing = best;
    this.laneShift = 4.6;
    this.passT = 2.2;
  }

  replan() {
    const v = this.veh;
    const e = edgeAt(v.curPos, v.forward(_v));
    if (!e) return false;
    this.start(e[0], e[1]);
    return true;
  }

  update(dt) {
    const v = this.veh;
    if (this.disabled || !v.driver || v.driver.state !== 'vehicle' || v.health <= 0) {
      // parked: handbrake only (the foot brake on a stopped car would select reverse)
      v.input.throttle = 0; v.input.brake = v.speed > 1.5 ? 0.6 : 0; v.input.steer = 0; v.input.handbrake = v.speed <= 1.5;
      return;
    }
    if (!this.chasing) {
      this.panic = 0;
      this.cruise = 12;
      this.turnK = 1;
      this.decel = 3;
      if (this.mode !== 'route') { this.mode = 'route'; if (!this.replan()) this.mode = 'trail'; }
      if (this.mode === 'route') { super.update(dt); return; }
    } else {
      this.panic = 1e9; // siren: ignore red lights, drive faster
      this.cruise = 19;
      this.turnK = 1.45;
      this.decel = 5.5;
    }
    const P = this.police;
    const pos = v.curPos;
    const tgt = P.targetPos(_v2);
    const dTgt = Math.hypot(tgt.x - pos.x, tgt.z - pos.z);
    if (this.mode === 'route') {
      this.overtake(dt);
      const j = this.chasing ? P.trailNear(pos, 12) : -1;
      if (j >= 0 || (dTgt < 24 && P.wanted.seen)) {
        this.mode = 'trail';
        this.tIdx = Math.max(0, j);
      } else {
        this.replanT -= dt;
        if (this.replanT <= 0) {
          this.replanT = 3;
          if (!this.replan()) { this.mode = 'trail'; this.tIdx = P.trailNear(pos, 1e4); }
        }
        if (this.mode === 'route') { super.update(dt); return; }
      }
    }
    this.trailDrive(dt, tgt, dTgt);
  }

  trailDrive(dt, tgt, dTgt) {
    const v = this.veh, P = this.police, W = P.wanted, tr = P.trail;
    const pos = v.curPos;
    const fwd = v.forward(_v);
    const end = P.trailEnd();
    if (this.tIdx > end) this.tIdx = end;
    // end of what we know while searching: go back to roaming the roads
    if (!W.seen && this.chasing && (end < 0 || (this.tIdx >= end - 1 && dTgt < 18))) {
      if (this.replan()) { this.mode = 'route'; super.update(dt); return; }
    }
    if (this.tIdx < 0 || end < 0) {
      // nothing to follow (yet): head straight for the target
      this.tIdx = -1;
    } else {
      // progress is measured along the trail's own direction (not the car's nose), so a car that
      // joined the track facing the wrong way turns around instead of driving it backwards
      while (this.tIdx < end) {
        const p = tr[this.tIdx], n = tr[this.tIdx + 1];
        const rx = pos.x - p.x, rz = pos.z - p.z;
        if (rx * (n.x - p.x) + rz * (n.z - p.z) > 0 || rx * rx + rz * rz < 9) this.tIdx++;
        else break;
      }
      // the player looped back past us: jump ahead along the trail
      const j = P.trailNear(pos, 9);
      if (j > this.tIdx + 4) this.tIdx = j;
    }
    // look-ahead target along the trail (or the target itself at the end of it)
    const speed = v.fwdSpeed;
    const look = 5 + Math.abs(speed) * 0.45;
    let tx = tgt.x, tz = tgt.z, reachedEnd = true;
    let vCorner = 34;
    if (this.tIdx >= 0) {
      let acc = 0, px = pos.x, pz = pos.z;
      for (let i = this.tIdx; i <= end; i++) {
        const p = tr[i];
        acc += Math.hypot(p.x - px, p.z - pz);
        px = p.x; pz = p.z;
        if (acc >= look && reachedEnd) { tx = p.x; tz = p.z; reachedEnd = false; }
        // corner ahead: its speed (lateral grip) plus the distance we have to brake for it
        if (i > this.tIdx && i < end) {
          const a = tr[i - 1], c = tr[i + 1];
          const l1 = Math.hypot(p.x - a.x, p.z - a.z), l2 = Math.hypot(c.x - p.x, c.z - p.z);
          if (l1 > 0.3 && l2 > 0.3) {
            const turn = Math.abs(wrapAngle(Math.atan2(c.x - p.x, c.z - p.z) - Math.atan2(p.x - a.x, p.z - a.z)));
            const kap = turn / Math.max(1.5, (l1 + l2) * 0.5);
            if (kap > 0.004) vCorner = Math.min(vCorner, Math.sqrt(5.5 / kap + 2 * 5.5 * Math.max(0, acc - 4)));
          }
        }
        if (acc > 70) break;
      }
    }
    if (reachedEnd && W.seen) {
      // lead the target a little
      const pv = P.playerVel(_v3);
      tx = tgt.x + pv.x * 0.35; tz = tgt.z + pv.z * 0.35;
    }
    const local = v.worldToLocal(_v3.set(tx, pos.y, tz), _v3);
    const ld = Math.max(1, Math.hypot(local.x, local.z));
    const alpha = Math.atan2(local.x, local.z);
    let steer = clamp(Math.atan2(2 * v.T.wheelbase * Math.sin(alpha), ld) / v.T.steerMax, -1, 1);

    // ------------------------------------------------ target speed
    const pc = this.game.player.character;
    const pveh = pc.state === 'vehicle' ? pc.vehicle : null;
    const ram = W.stars >= 3 && pveh && W.seen;
    let want;
    if (!this.chasing) want = 10;
    else if (!W.seen) want = dTgt < 12 ? 4 : 15;
    else if (pveh) want = pveh.speed + clamp((dTgt - (ram ? -3 : 9)) * 0.7, -10, 15);
    else want = clamp((dTgt - 7) * 1.2, 0, 22);
    // pointing well off the path: slow down enough to make the turn
    want = Math.min(want, vCorner, 34, 7 + 24 * Math.max(0, Math.cos(alpha)));
    const obs = this.obstacleAhead(ram ? pveh : null);
    if (obs < 40) want = Math.min(want, Math.max(0, (obs - 3) * 0.9));

    // ------------------------------------------------ stuck / overshoot recovery
    const behind = Math.abs(alpha) > 1.9 && dTgt < 40;
    let throttle = 0, brake = 0, handbrake = false;
    if (behind && speed > 6 && this.revT <= 0) {
      // facing the wrong way at speed: handbrake turn
      v.input.throttle = 0.35; v.input.brake = 0; v.input.steer = Math.sign(alpha) || 1; v.input.handbrake = true;
      return;
    }
    if ((want > 3 && Math.abs(speed) < 0.8) || behind) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt);
    if (this.stuckT > (behind ? 0.5 : 1.6) && this.revT <= 0) { this.revT = 1.3; this.stuckT = 0; }
    if (this.revT > 0) {
      this.revT -= dt;
      brake = 0.8; // braking while stopped engages reverse
      steer = -steer;
    } else {
      const err = want - speed;
      // traction control: no full power at full lock (the car would just spin)
      if (err > 0) throttle = clamp(err * 0.35, 0, 1) * clamp(1.15 - Math.abs(steer) * 0.75, 0.3, 1);
      else brake = clamp(-err * 0.3, 0, 1);
      if (speed < 1.0 && speed > -0.5) brake = 0;
    }
    v.input.throttle = throttle;
    v.input.brake = brake;
    v.input.steer = steer;
    v.input.handbrake = handbrake;
    this.dbg = { want, vCorner, obs, dTgt, rev: this.revT > 0 };
  }
}

/* =================================================================== police manager */
export class PoliceManager {
  constructor(game) {
    this.game = game;
    this.wanted = new Wanted();
    this.units = [];
    this.trail = [];
    this.seenIdx = -1;
    this.spawnT = 0;
    this.sightT = 0;
    this.arrestT = 0;
    this.ramT = 0;
    this.rng = makeRng(9001);
    this.tracers = [];
    const mat = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, mat.clone());
      line.visible = false;
      line.frustumCulled = false;
      line.life = 0;
      game.scene.add(line);
      this.tracers.push(line);
    }
  }

  get stars() { return this.wanted.stars; }

  /* ------------------------------------------------------------- player helpers */
  playerPos(out) {
    const pc = this.game.player.character;
    if (pc.state === 'vehicle' && pc.vehicle) return out.copy(pc.vehicle.curPos);
    if (pc.ragdoll.active) return pc.ragdoll.hipsPosition(out);
    return out.copy(pc.pos);
  }
  playerVel(out) {
    const pc = this.game.player.character;
    if (pc.state === 'vehicle' && pc.vehicle) return pc.vehicle.linvel(out);
    return out.copy(pc.vel);
  }
  playerChest(out) {
    const pc = this.game.player.character;
    if (pc.state === 'vehicle' && pc.vehicle) return out.copy(pc.pos).setY(pc.pos.y + 0.45);
    if (pc.ragdoll.active) return pc.ragdoll.hipsPosition(out);
    return out.copy(pc.pos).setY(pc.pos.y + 1.3 * pc.rig.scale);
  }
  /** Where the police think the player is. */
  targetPos(out) {
    return this.wanted.seen ? this.playerPos(out) : out.copy(this.wanted.lastKnown);
  }

  /* ------------------------------------------------------------- crimes */
  crime(kind, pos) {
    const C = CRIMES[kind];
    const W = this.wanted, g = this.game;
    if (!C || !g.player.character.alive || g.bustedT) return;
    if (C.witness && W.stars === 0 && !this.copWitness(pos)) return;
    W.points += C.pts;
    let s = 0;
    for (let i = 1; i <= 5; i++) if (W.points >= STAR_POINTS[i]) s = i;
    s = Math.min(5, Math.max(s, C.min || 0, W.stars));
    if (s > W.stars) {
      W.stars = s;
      W.points = Math.max(W.points, STAR_POINTS[s]);
      W.flash = 2.5;
      g.hud.message(`${'★'.repeat(s)}  Wanted · تحت تعقیب پلیس`, 2.2);
      this.spawnT = Math.min(this.spawnT, 1.2);
    }
    W.seen = true;
    W.unseenT = 0;
    this.playerPos(W.lastKnown);
  }

  /** Is any police officer close enough to see `pos`? */
  copWitness(pos) {
    for (const c of this.game.characters) {
      if (!c.isCop || !c.alive || c.state === 'ragdoll' || c.state === 'dead') continue;
      const d = c.pos.distanceTo(pos);
      if (d > 45) continue;
      if (d < 12 || this.lineOfSight(c, pos)) return true;
    }
    return false;
  }

  lineOfSight(c, target) {
    _eye.copy(c.pos).setY(c.state === 'vehicle' ? c.pos.y + 0.6 : c.pos.y + 1.6);
    _d.subVectors(target, _eye);
    const len = _d.length();
    if (len < 0.5) return true;
    _d.divideScalar(len);
    const hit = this.game.physics.raycast(_eye, _d, len - 0.3, groups(G.ALL, G.STATIC));
    return !hit;
  }

  /* ------------------------------------------------------------- trail of the player's route */
  updateTrail() {
    const p = this.playerPos(_v);
    const tr = this.trail;
    const last = tr[tr.length - 1];
    const d2 = last ? (p.x - last.x) ** 2 + (p.z - last.z) ** 2 : 1e9;
    if (d2 > 6.25) {
      if (last && d2 > 30 * 30) {
        // teleport / respawn: the old track is meaningless
        tr.length = 0;
        this.seenIdx = -1;
        for (const u of this.units) if (u.ai) { u.ai.tIdx = -1; u.ai.mode = 'route'; }
      }
      tr.push({ x: p.x, z: p.z });
      if (tr.length > 600) {
        const cut = 150;
        tr.splice(0, cut);
        this.seenIdx -= cut;
        for (const u of this.units) if (u.ai && u.ai.tIdx >= 0) { u.ai.tIdx -= cut; if (u.ai.tIdx < 0) { u.ai.tIdx = -1; u.ai.mode = 'route'; } }
      }
    }
    if (this.wanted.seen) this.seenIdx = tr.length - 1;
  }
  trailEnd() { return this.wanted.seen ? this.trail.length - 1 : Math.min(this.seenIdx, this.trail.length - 1); }
  /** Highest trail index (within what the police know) closer than r to pos, or -1. */
  trailNear(pos, r) {
    const tr = this.trail, end = this.trailEnd();
    const r2 = r * r;
    for (let i = end; i >= Math.max(0, end - 400); i--) {
      const p = tr[i];
      if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < r2) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------- main update */
  update(dt) {
    const g = this.game, W = this.wanted, pc = g.player.character;
    this.updateTrail();
    W.flash = Math.max(0, W.flash - dt);
    this.ramT = Math.max(0, this.ramT - dt);

    // sight checks (5 Hz)
    this.sightT -= dt;
    if (this.sightT <= 0) {
      this.sightT = 0.2;
      this.updateSight();
    }
    // losing the police
    if (W.stars > 0) {
      const pp = this.playerPos(_v);
      if (W.seen) W.lastKnown.copy(pp);
      else {
        const outside = Math.hypot(pp.x - W.lastKnown.x, pp.z - W.lastKnown.z) > W.searchR;
        W.unseenT += dt * (outside ? 1 : 0.45);
        if (W.unseenT >= W.evadeTime) this.evaded();
      }
    }
    if (!pc.alive) { this.arrestT = 0; }

    // dispatch
    this.spawnT -= dt;
    const active = this.units.filter((u) => !u.leaving && !u.dead).length;
    if (W.stars > 0 && active < MAX_UNITS[W.stars] && this.spawnT <= 0 && pc.alive && !g.bustedT) {
      this.spawnT = active === 0 ? 4 : 6;
      if (!this.recruitPatrol() && !this.spawnUnit()) this.spawnT = 1; // nowhere suitable right now: retry soon
    }
    // too many after the level dropped (or wanted cleared): send extras home
    if (W.stars === 0) for (const u of this.units) if (!u.leaving) this.release(u);

    this.updateUnits(dt);
    this.shooters = 0;
    this.arrestNear = false;
    for (const u of this.units) for (const c of u.cops) this.updateCop(c, u, dt);
    // arrest
    if (this.arrestNear) this.arrestT += dt; else this.arrestT = Math.max(0, this.arrestT - dt * 0.6);
    if (this.arrestT > 1.3 && pc.alive && !g.bustedT) {
      this.arrestT = 0;
      g.onBusted?.();
    }
    // tracers fade
    for (const t of this.tracers) {
      if (!t.visible) continue;
      t.life -= dt;
      t.material.opacity = Math.max(0, t.life / 0.07) * 0.9;
      if (t.life <= 0) t.visible = false;
    }
  }

  updateSight() {
    const g = this.game, W = this.wanted, pc = g.player.character;
    const chest = this.playerChest(_v2);
    let seen = false;
    for (const c of g.characters) {
      if (!c.isCop) continue;
      c.copSees = false;
      if (!c.alive || c.state === 'ragdoll' || c.state === 'dead' || c.state === 'getup') continue;
      const d = c.pos.distanceTo(chest);
      const range = c.state === 'vehicle' ? 110 : 60;
      if (d > range) continue;
      if (d < 10 || this.lineOfSight(c, chest)) { c.copSees = true; seen = true; }
    }
    if (W.stars === 0) { W.seen = false; return; }
    if (seen) this.lostT = 0;
    else this.lostT = (this.lostT || 0) + 0.2;
    const tracked = seen || this.lostT < GRACE[W.stars];
    if (tracked && !W.seen) W.unseenT = 0;
    if (!tracked && W.seen && pc.alive) g.hud.message('Out of sight — get away · از دید پلیس خارج شدی', 1.6);
    W.seen = tracked;
  }

  evaded() {
    const g = this.game;
    this.wanted.clear();
    g.hud.message('Lost the police · از دست پلیس فرار کردی', 2.5);
    for (const u of this.units) this.release(u);
  }

  /** Wanted level gone: siren off, officers return to the car and drive off. */
  release(u) {
    u.leaving = true;
    u.veh.sirenOn = false;
    if (u.ai) u.ai.wander = true;
  }

  /* ------------------------------------------------------------- units */
  makeCop(seed) {
    const g = this.game;
    const c = new Character(g, copAppearance(seed), { armed: true });
    c.isCop = true;
    g.addCharacter(c);
    return c;
  }

  attachUnit(veh, cops, siren = true) {
    const ai = new PoliceDriver(this.game, veh, this);
    const u = { veh, ai, cops, leaving: false, dead: false, onFoot: false };
    for (const c of cops) { c.copUnit = u; c.copSeat = c.seatSide || 1; }
    veh.sirenOn = siren;
    veh.policeUnit = u;
    veh.persistent = true;
    this.units.push(u);
    return u;
  }

  /** An officer pulled out of his car by the player keeps chasing on foot. */
  adoptJackedCop(c, veh) {
    if (c.copUnit && !c.copUnit.dead) return;
    const i = this.game.traffic.cars.indexOf(veh);
    if (i >= 0) this.game.traffic.cars.splice(i, 1);
    const u = this.attachUnit(veh, [c], false);
    u.onFoot = true;
    u.ai.disabled = true;
  }

  /** A patrol car already driving nearby joins the chase. */
  recruitPatrol() {
    const g = this.game;
    const pp = this.playerPos(_v);
    for (const v of g.traffic.cars) {
      if (!v.T.police || v.removed || !v.driver || !v.driver.isCop || v.driver.state !== 'vehicle' || v.health <= 0) continue;
      if (v.curPos.distanceTo(pp) > 170) continue;
      g.traffic.cars.splice(g.traffic.cars.indexOf(v), 1);
      if (v.ai) v.ai.disabled = true;
      const u = this.attachUnit(v, [v.driver]);
      u.ai.replan();
      return true;
    }
    return false;
  }

  spawnUnit() {
    const g = this.game, city = g.city, W = this.wanted, r = this.rng;
    const near = this.targetPos(_v).clone();
    const cam = g.camera;
    cam.getWorldDirection(_d);
    // a fleeing driver: try to send cars in from ahead as well
    const pv = this.playerVel(new THREE.Vector3());
    const ahead = W.seen && pv.length() > 8 && r() < 0.6;
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = r.int(0, city.nodes.length - 1);
      const na = city.nodes[a];
      const bn = r.pick(na.links);
      const ed = edgeDir(city, a, bn);
      // drive towards the player along this street
      const nb = city.nodes[bn];
      const toward = (near.x - na.x) * ed.x + (near.z - na.z) * ed.z > 0;
      const [s0, s1] = toward ? [a, bn] : [bn, a];
      const e = edgeDir(city, s0, s1);
      const s = r.range(START_D + 2, e.len - STOP_D - 6);
      const p = lanePoint(city, s0, s1, s, new THREE.Vector3());
      const dist = Math.hypot(p.x - near.x, p.z - near.z);
      if (dist < 75 || dist > 165) continue;
      if (ahead && attempt < 20 && (p.x - near.x) * pv.x + (p.z - near.z) * pv.z < 0) continue;
      // prefer spawning out of view
      _v2.subVectors(p, cam.position);
      if (attempt < 30 && _v2.dot(_d) / Math.max(1, _v2.length()) > 0.35 && dist < 140) continue;
      let clear = true;
      for (const v of g.vehicles) if ((v.curPos.x - p.x) ** 2 + (v.curPos.z - p.z) ** 2 < 12 * 12) { clear = false; break; }
      if (!clear) continue;
      void nb;
      const yaw = Math.atan2(e.x, e.z);
      const veh = g.addVehicle('police', null, p.setY(0.08), yaw, { vel: new THREE.Vector3(e.x * 12, 0, e.z * 12) });
      const cops = [this.makeCop(r.int(1, 1e9))];
      cops[0].teleport(p, yaw);
      cops[0].enterVehicleInstant(veh, 1);
      if (W.stars >= 2) {
        const c2 = this.makeCop(r.int(1, 1e9));
        c2.teleport(p, yaw);
        c2.enterVehicleInstant(veh, -1);
        cops.push(c2);
      }
      const u = this.attachUnit(veh, cops);
      u.ai.start(s0, s1);
      u.ai.idx = Math.max(0, Math.floor((s - START_D) / 2.5));
      return u;
    }
    return null;
  }

  removeUnit(u) {
    const g = this.game;
    u.dead = true;
    for (const c of u.cops) if (!c.removed) g.removeCharacter(c);
    if (!u.veh.removed) {
      if (u.veh === g.player.lastVehicle) { u.veh.policeUnit = null; u.veh.sirenOn = false; }
      else g.removeVehicle(u.veh);
    }
  }

  /** Remove every unit at once (death / arrest respawn). */
  reset() {
    for (const u of this.units) this.removeUnit(u);
    this.units.length = 0;
    this.wanted.clear();
    this.arrestT = 0;
    this.trail.length = 0;
    this.seenIdx = -1;
  }

  updateUnits(dt) {
    const g = this.game, W = this.wanted, pc = g.player.character;
    const pp = this.playerPos(_v);
    const cam = g.camera.position;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const v = u.veh;
      u.cops = u.cops.filter((c) => !c.removed);
      if (v.removed && !u.cops.length) { this.units.splice(i, 1); continue; }
      const d = v.removed ? 0 : v.curPos.distanceTo(pp);
      const camD = v.removed ? 0 : v.curPos.distanceTo(cam);
      // despawn: far and unseen, or released and gone
      const copsFar = u.cops.every((c) => c.pos.distanceTo(pp) > 90 || c.state === 'dead');
      if ((camD > 260 && copsFar) || (u.leaving && camD > 110 && copsFar) || (u.cops.length === 0 && camD > 70)) {
        this.removeUnit(u);
        this.units.splice(i, 1);
        continue;
      }
      if (v.removed) continue;
      if (pc.vehicle === v) { u.onFoot = true; continue; }
      if (u.ai.disabled && v.health > 0) { u.ai.disabled = false; v.ai = u.ai; } // the player abandoned our car
      const wrecked = v.health <= 0 || v.isUpsideDown() || v.exploded;
      if (wrecked) v.sirenOn = false;
      // a unit that is hopelessly stuck or left far behind is quietly replaced (off camera) by a
      // fresh one dispatched closer to the player, keeping the pressure steady without swarming
      if (W.stars > 0 && !u.leaving && !u.onFoot && !wrecked) {
        u.slowT = v.speed < 2.5 && d > 25 ? (u.slowT || 0) + dt : 0;
        const camDir = g.camera.getWorldDirection(_d);
        const onScreen = camD < 140 && (v.curPos.x - cam.x) * camDir.x + (v.curPos.y - cam.y) * camDir.y + (v.curPos.z - cam.z) * camDir.z > camD * 0.5;
        if (!onScreen && (u.slowT > 6 || d > 150) && u.cops.every((c) => c.state === 'vehicle')) {
          this.removeUnit(u);
          this.units.splice(i, 1);
          this.spawnT = Math.min(this.spawnT, 0.5);
          continue;
        }
      }
      if (u.ai && !u.onFoot) u.ai.update(dt);
      // get out: the player is on foot (or stopped) close by, or the car is wrecked
      const inCar = u.cops.filter((c) => c.state === 'vehicle' && c.vehicle === v);
      if (inCar.length && !u.leaving && W.stars > 0) {
        const pveh = pc.state === 'vehicle' ? pc.vehicle : null;
        const slowTarget = !pveh || pveh.speed < 2.5;
        if (wrecked || (W.seen && d < 17 && slowTarget && v.speed < 2.2)) {
          for (const c of inCar) new ExitSequence(g, c, v, c.seatSide);
          u.onFoot = true;
          v.input.throttle = 0; v.input.brake = 0; v.input.steer = 0; v.input.handbrake = true;
          continue;
        }
      }
      if (u.onFoot) { v.input.throttle = 0; v.input.brake = 0; v.input.handbrake = true; }
      if (u.onFoot && inCar.length === u.cops.filter((c) => c.alive).length && inCar.length > 0) {
        // everybody is back inside
        u.onFoot = false;
        u.ai.mode = 'route';
        u.ai.replan();
      }
    }
  }

  /* ------------------------------------------------------------- officers on foot */
  updateCop(c, u, dt) {
    if (!c.alive || c.removed) return;
    if (c.state !== 'foot') { c.aimTarget = null; c.input.face = null; return; }
    const g = this.game, W = this.wanted, pc = g.player.character;
    c.input.jump = false;
    const v = u.veh;
    const pveh = pc.state === 'vehicle' ? pc.vehicle : null;
    // back to the car: released, or the player drove off
    const carOk = !v.removed && v.health > 0 && !v.isUpsideDown();
    if (u.leaving || W.stars === 0 || (pveh && pveh.speed > 7 && carOk && c.pos.distanceTo(v.curPos) < 40)) {
      c.aimTarget = null;
      c.input.face = null;
      if (!carOk) { c.input.mag = 0; return; }
      const side = c.copSeat || (v.driver ? -1 : 1);
      if ((side === 1 && v.driver) || (side === -1 && v.passengers.length)) { c.input.mag = 0; return; }
      const door = v.localToWorld(_v.set(side * (v.halfW + 0.6), 0, v.model.seat.z), _v);
      const dd = Math.hypot(door.x - c.pos.x, door.z - c.pos.z);
      if (dd < 1.4) {
        c.input.mag = 0;
        if (v.doorClear(side)) new EnterSequence(g, c, v, side);
        else c.enterVehicleInstant(v, side);
        return;
      }
      c.input.dir.set((door.x - c.pos.x) / dd, 0, (door.z - c.pos.z) / dd);
      c.input.mag = 1;
      c.input.mode = dd > 6 ? 'run' : 'walk';
      return;
    }
    const tgt = W.seen ? this.playerPos(_v) : W.lastKnown;
    const dx = tgt.x - c.pos.x, dz = tgt.z - c.pos.z;
    const d = Math.max(1e-3, Math.hypot(dx, dz));
    const yawTo = Math.atan2(dx, dz);
    // arrest: the player stands still within reach, or sits in a stopped car with an officer at the door
    const pcFoot = pc.state === 'foot' || pc.state === 'getup';
    if (W.seen && pcFoot && d < 1.9 && pc.speedScalar < 2.4) {
      this.arrestNear = true;
      c.aimTarget = null;
      c.input.face = yawTo;
      c.input.mag = 0;
      return;
    }
    if (W.seen && pveh && pveh.speed < 1.0) {
      const side = pc.seatSide || 1;
      const door = pveh.localToWorld(_v2.set(side * (pveh.halfW + 0.55), 0, pveh.model.seat.z), _v2);
      const dd = Math.hypot(door.x - c.pos.x, door.z - c.pos.z);
      if (dd < 1.6) {
        this.arrestNear = true;
        c.aimTarget = null;
        c.input.face = Math.atan2(pveh.curPos.x - c.pos.x, pveh.curPos.z - c.pos.z);
        c.input.mag = 0;
        return;
      }
      if (W.stars <= 1 || dd < 9) {
        c.aimTarget = null;
        c.input.face = null;
        c.input.dir.set((door.x - c.pos.x) / dd, 0, (door.z - c.pos.z) / dd);
        c.input.mag = 1;
        c.input.mode = dd > 5 ? 'run' : 'walk';
        return;
      }
    }
    // shoot (2 stars and up), a limited number of officers at a time
    const canShoot = W.stars >= 2 && W.seen && c.copSees && d > 3 && d < 34 && pc.alive &&
      (pc.state === 'foot' || pc.state === 'vehicle' || pc.state === 'getup' || pc.state === 'seq');
    if (canShoot && this.shooters < MAX_SHOOTERS[W.stars]) {
      this.shooters++;
      c.input.face = yawTo;
      c.aimTarget = this.playerChest(c.aimVec || (c.aimVec = new THREE.Vector3()));
      if (d > 18) { c.input.dir.set(dx / d, 0, dz / d); c.input.mag = 0.75; c.input.mode = 'walk'; }
      else if (d < 6) { c.input.dir.set(-dx / d, 0, -dz / d); c.input.mag = 0.7; c.input.mode = 'walk'; }
      else c.input.mag = 0;
      c.fireT = (c.fireT ?? this.rng.range(0.6, 1.2)) - dt;
      if (c.fireT <= 0 && c.aimW > 0.85) {
        this.fire(c);
        c.fireT = this.rng.range(1.2, 1.9);
      }
      return;
    }
    c.aimTarget = null;
    c.input.face = null;
    if (!W.seen && d < 6) {
      // searching the area on foot: look around
      c.input.mag = 0;
      c.lookYaw = Math.sin(g.time * 0.7 + c.id) * 0.9;
      return;
    }
    let dirX = dx / d, dirZ = dz / d;
    // keep officers from piling into each other
    for (const o of u.cops) {
      if (o === c || o.state !== 'foot') continue;
      const ox = c.pos.x - o.pos.x, oz = c.pos.z - o.pos.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.4 && od > 1e-3) { dirX += ox / od * 0.6; dirZ += oz / od * 0.6; }
    }
    const l = Math.hypot(dirX, dirZ) || 1;
    c.input.dir.set(dirX / l, 0, dirZ / l);
    // officers sprint a little slower than the player can, so running away is possible
    c.input.mag = d > 18 ? 0.9 : 1;
    c.input.mode = d > 18 ? 'sprint' : d > 4 ? 'run' : 'walk';
  }

  fire(c) {
    const g = this.game, W = this.wanted, pc = g.player.character;
    const muzzle = c.muzzleWorld(new THREE.Vector3());
    const chest = this.playerChest(new THREE.Vector3());
    _d.subVectors(chest, muzzle);
    const dist = _d.length();
    _d.divideScalar(dist);
    const P = g.physics;
    const pveh = pc.state === 'vehicle' ? pc.vehicle : null;
    // something solid in between?
    const block = P.raycast(muzzle, _d, dist - 0.4, groups(G.ALL, G.STATIC | (pveh ? 0 : G.CAR)), c.vehicle ? c.vehicle.body : null);
    let p = ACCURACY[W.stars] * clamp(1.25 - dist / 32, 0.3, 1);
    if (pc.state === 'foot' && pc.speedScalar > 4) p *= 0.6;
    if (pveh) p *= 0.75;
    const hit = !block && this.rng() < p;
    let end;
    if (hit) {
      end = chest.clone();
      if (pveh) {
        pc.damage(DAMAGE[W.stars] * 0.6, 'shot', c);
        pveh.health = Math.max(0, pveh.health - 1.2);
        if (this.rng() < 0.3) g.effects.glass(chest, 0.2);
      } else {
        pc.damage(DAMAGE[W.stars], 'shot', c);
        pc.pushVel.addScaledVector(_d, 0.8);
        g.audio.bulletImpact(chest, true);
      }
      g.camRig.shake(0.12);
      g.hud.hit?.();
    } else {
      // a miss: deflect the shot and let it strike whatever is behind
      _v.set(-_d.z, 0, _d.x).multiplyScalar((this.rng() < 0.5 ? -1 : 1) * this.rng.range(0.5, 1.6));
      _v.y = this.rng.range(-0.6, 0.8);
      _v2.copy(chest).add(_v).sub(muzzle).normalize();
      const h = block || P.raycast(muzzle, _v2, 80, groups(G.ALL, G.STATIC | G.CAR | G.PROP), c.vehicle ? c.vehicle.body : null);
      if (h) {
        end = h.point.clone();
        g.effects.bulletHit(end, h.normal);
        g.audio.bulletImpact(end, false);
      } else end = muzzle.clone().addScaledVector(_v2, 80);
      // near miss whiz for the player
      if (chest.distanceTo(end) < 6 || dist < 20) g.audio.whiz(chest);
    }
    g.effects.muzzle(muzzle, _d);
    g.audio.gunshot(muzzle);
    this.tracer(muzzle, end);
    g.peds.panic(muzzle, 35, muzzle);
  }

  tracer(a, b) {
    const t = this.tracers.find((x) => !x.visible) || this.tracers[0];
    const pos = t.geometry.attributes.position;
    // only the far 60% of the segment, like a streak flying away from the barrel
    _v.copy(a).lerp(b, 0.25);
    pos.setXYZ(0, _v.x, _v.y, _v.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    t.visible = true;
    t.life = 0.07;
    t.material.opacity = 0.9;
  }
}
