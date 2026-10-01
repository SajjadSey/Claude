import * as THREE from 'three';
import { clamp } from '../core/util.js';
import { G, groups } from '../core/physics.js';

/*
 * Firearms: models, stats and shared ballistics (used by the player and the police).
 *
 * Gun models are built in the right hand's local frame: the grip sits in the fist at the origin,
 * the barrel points along -Y (the direction of the fingers) and the top of the gun is +Z (thumb
 * side). Holding the hand so that -Y follows the aim direction points the gun at the target.
 */
export const WEAPONS = {
  fists: { key: 'fists', name: 'Fists', fa: 'مشت', slot: 1 },
  pistol: {
    key: 'pistol', name: 'Pistol', fa: 'کلت', slot: 2, dmg: 28, rate: 0.2, auto: false, pellets: 1,
    spread: 0.022, aimSpread: 0.006, bloom: 0.5, recoil: 0.022, range: 140, impulse: 1.2, carDmg: 2.2,
    hold: 'pistol', fore: 0, stock: 0, drive: true,
  },
  smg: {
    key: 'smg', name: 'SMG', fa: 'مسلسل یوزی', slot: 3, dmg: 15, rate: 0.072, auto: true, pellets: 1,
    spread: 0.045, aimSpread: 0.016, bloom: 0.25, recoil: 0.011, range: 95, impulse: 0.8, carDmg: 1.4,
    hold: 'compact', fore: 0.2, stock: 0.2, drive: true,
  },
  shotgun: {
    key: 'shotgun', name: 'Shotgun', fa: 'شاتگان', slot: 4, dmg: 14, rate: 0.85, auto: false, pellets: 9,
    spread: 0.075, aimSpread: 0.055, bloom: 0.4, recoil: 0.07, range: 55, impulse: 2.8, carDmg: 1.1, knock: 11,
    hold: 'long', fore: 0.43, stock: 0.3, drive: false,
  },
  rifle: {
    key: 'rifle', name: 'Assault rifle', fa: 'تفنگ تهاجمی', slot: 5, dmg: 31, rate: 0.105, auto: true, pellets: 1,
    spread: 0.028, aimSpread: 0.0055, bloom: 0.2, recoil: 0.018, range: 220, impulse: 1.7, carDmg: 2.9,
    hold: 'long', fore: 0.34, stock: 0.29, drive: false,
  },
};
export const WEAPON_ORDER = ['fists', 'pistol', 'smg', 'shotgun', 'rifle'];

/* ------------------------------------------------------------------ models */
let MATS = null;
function mats() {
  if (!MATS) {
    MATS = {
      metal: new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.42, metalness: 0.75 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.75, metalness: 0.15 }),
      poly: new THREE.MeshStandardMaterial({ color: 0x2b2c2a, roughness: 0.65, metalness: 0.1 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.6, metalness: 0.0 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.3, metalness: 0.9 }),
    };
  }
  return MATS;
}
const GEO_CACHE = new Map();
function box(w, l, h, x, y, z, rx = 0) {
  const k = `b${w}_${l}_${h}_${x}_${y}_${z}_${rx}`;
  if (!GEO_CACHE.has(k)) {
    const g = new THREE.BoxGeometry(w, l, h);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    g.userData.shared = true;
    GEO_CACHE.set(k, g);
  }
  return GEO_CACHE.get(k);
}
function tube(r, l, x, y, z, seg = 10) {
  const k = `t${r}_${l}_${x}_${y}_${z}`;
  if (!GEO_CACHE.has(k)) {
    const g = new THREE.CylinderGeometry(r, r, l, seg);
    g.translate(x, y, z);
    g.userData.shared = true;
    GEO_CACHE.set(k, g);
  }
  return GEO_CACHE.get(k);
}

const X = 0.012; // gun centre line, slightly to the palm side of the hand bone
const BUILDERS = {
  pistol: (M) => ({
    parts: [
      [box(0.03, 0.19, 0.034, X, -0.1, 0.056), M.metal],
      [box(0.027, 0.04, 0.105, X, -0.055, -0.004, 0.18), M.dark],
      [box(0.008, 0.035, 0.02, X, -0.085, 0.026), M.metal],
      [box(0.006, 0.012, 0.008, X, -0.19, 0.077), M.steel],
    ],
    muzzle: [X, -0.205, 0.058], eject: [X + 0.016, -0.08, 0.066],
  }),
  smg: (M) => ({
    parts: [
      [box(0.042, 0.27, 0.058, X, -0.085, 0.062), M.metal],
      [tube(0.011, 0.07, X, -0.255, 0.062), M.steel],
      [box(0.03, 0.045, 0.21, X, -0.05, -0.045, 0.05), M.dark], // grip + magazine
      [box(0.034, 0.06, 0.03, X, -0.17, 0.02), M.poly], // front grip block
      [box(0.012, 0.16, 0.012, X + 0.012, 0.11, 0.07), M.steel], // folding stock rails
      [box(0.012, 0.16, 0.012, X - 0.012, 0.11, 0.07), M.steel],
      [box(0.04, 0.012, 0.05, X, 0.19, 0.06), M.steel],
      [box(0.012, 0.04, 0.02, X, -0.02, 0.1), M.metal], // rear sight
    ],
    muzzle: [X, -0.295, 0.062], eject: [X + 0.024, -0.06, 0.075],
  }),
  shotgun: (M) => ({
    parts: [
      [tube(0.0125, 0.62, X, -0.43, 0.075), M.steel], // barrel
      [tube(0.011, 0.5, X, -0.37, 0.047), M.metal], // magazine tube
      [box(0.052, 0.19, 0.05, X, -0.43, 0.045), M.wood], // pump
      [box(0.046, 0.23, 0.072, X, -0.03, 0.06), M.metal], // receiver
      [box(0.032, 0.06, 0.09, X, 0.03, -0.015, 0.35), M.wood], // wrist
      [box(0.042, 0.32, 0.075, X, 0.22, 0.03, -0.12), M.wood], // stock
      [box(0.046, 0.025, 0.1, X, 0.375, 0.012, -0.12), M.dark], // butt pad
      [box(0.008, 0.035, 0.022, X, -0.065, 0.02), M.metal], // trigger guard
    ],
    muzzle: [X, -0.745, 0.075], eject: [X + 0.026, -0.04, 0.07],
  }),
  rifle: (M) => ({
    parts: [
      [box(0.04, 0.27, 0.075, X, -0.04, 0.068), M.metal], // receiver
      [box(0.052, 0.3, 0.058, X, -0.32, 0.072), M.poly], // handguard
      [tube(0.0085, 0.16, X, -0.54, 0.075), M.steel], // barrel
      [tube(0.0125, 0.05, X, -0.64, 0.075), M.metal], // flash hider
      [box(0.026, 0.065, 0.17, X, -0.085, -0.035, -0.18), M.dark], // magazine
      [box(0.03, 0.04, 0.1, X, 0.035, -0.02, 0.32), M.dark], // pistol grip
      [box(0.04, 0.24, 0.058, X, 0.21, 0.055), M.poly], // stock
      [box(0.044, 0.03, 0.11, X, 0.335, 0.04), M.dark], // butt
      [box(0.018, 0.22, 0.016, X, -0.12, 0.114), M.metal], // top rail
      [box(0.01, 0.02, 0.04, X, -0.43, 0.115), M.metal], // front sight
    ],
    muzzle: [X, -0.665, 0.075], eject: [X + 0.022, -0.02, 0.08],
  }),
};

/** Gun mesh group for a weapon, with its muzzle / ejection port in local coordinates. */
export function buildWeaponModel(key) {
  const b = BUILDERS[key];
  if (!b) return null;
  const spec = b(mats());
  const g = new THREE.Group();
  for (const [geo, m] of spec.parts) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    g.add(mesh);
  }
  g.userData.muzzle = new THREE.Vector3(...spec.muzzle);
  g.userData.eject = new THREE.Vector3(...spec.eject);
  g.visible = false;
  return g;
}

/* ------------------------------------------------------------------ ballistics */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);
const _Z = new THREE.Vector3(0, 0, 1);
export const BULLET_FILTER = groups(G.ALL, G.STATIC | G.CAR | G.CHAR | G.PROP | G.RAGDOLL);

function holeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, 'rgba(8,8,8,1)');
  gr.addColorStop(0.22, 'rgba(20,18,16,0.95)');
  gr.addColorStop(0.35, 'rgba(70,64,58,0.7)');
  gr.addColorStop(0.7, 'rgba(90,85,80,0.18)');
  gr.addColorStop(1, 'rgba(90,85,80,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Ballistics {
  constructor(game) {
    this.game = game;
    const scene = game.scene;
    this.tracers = [];
    const mat = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 24; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, mat.clone());
      line.visible = false;
      line.frustumCulled = false;
      line.life = 0;
      scene.add(line);
      this.tracers.push(line);
    }
    // bullet holes on static surfaces
    this.maxHoles = 160;
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.075, 0.075),
      new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      this.maxHoles);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    this.holeIdx = 0;
    scene.add(this.holes);
  }

  update(dt) {
    for (const t of this.tracers) {
      if (!t.visible) continue;
      t.life -= dt;
      t.material.opacity = Math.max(0, t.life / 0.06) * 0.85;
      if (t.life <= 0) t.visible = false;
    }
  }

  tracer(a, b) {
    const t = this.tracers.find((x) => !x.visible) || this.tracers[(this.tIdx = ((this.tIdx || 0) + 1) % this.tracers.length)];
    const pos = t.geometry.attributes.position;
    _v.copy(a).lerp(b, 0.15);
    pos.setXYZ(0, _v.x, _v.y, _v.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    t.visible = true;
    t.life = 0.06;
    t.material.opacity = 0.85;
  }

  hole(p, n) {
    _q.setFromUnitVectors(_Z, n);
    _v.copy(p).addScaledVector(n, 0.004);
    _s.setScalar(0.7 + Math.random() * 0.6);
    _m.compose(_v, _q, _s);
    this.holes.setMatrixAt(this.holeIdx, _m);
    this.holeIdx = (this.holeIdx + 1) % this.maxHoles;
    this.holes.count = Math.min(this.maxHoles, this.holes.count + 1);
    this.holes.instanceMatrix.needsUpdate = true;
  }

  /**
   * Resolve one bullet travelling from `from` along unit `dir` (max `range`).
   * Returns the end point. The shooter's own capsule and vehicle are ignored.
   */
  shoot(shooter, W, from, dir, range) {
    const g = this.game, P = g.physics;
    const exBody = shooter && shooter.vehicle ? shooter.vehicle.body : null;
    const exCol = shooter && shooter.collider ? shooter.collider : null;
    const hit = P.raycast(from, dir, range, BULLET_FILTER, exBody, exCol);
    // tyres have no colliders (the suspension is simulated): test the wheel cylinders directly
    // (the body collision box covers the wheels from the side, so a wheel just behind the box face
    // of the same car still counts)
    const hitCar = hit ? this.game.physics.ownerOf(hit.collider) : null;
    const tyre = this.tyreHit(from, dir, hit ? hit.dist + (hitCar && hitCar.type === 'car' ? 0.6 : 0) : range, shooter && shooter.vehicle,
      hit && hitCar && hitCar.type === 'car' ? { v: hitCar.vehicle, dist: hit.dist } : null);
    if (tyre) {
      tyre.v.burstTire(tyre.i);
      if (shooter && shooter.isPlayer) tyre.v.lastPlayerHitT = this.game.time;
      this.game.effects.dust(tyre.point, 0.5);
      this.game.audio.bulletImpact(tyre.point, true);
      return tyre.point;
    }
    if (!hit) return _v2.copy(from).addScaledVector(dir, range).clone();
    this.impact(shooter, W, hit, dir, from.distanceTo(hit.point));
    return hit.point.clone();
  }

  /** Closest wheel cylinder along the ray (before maxDist), in any nearby vehicle. */
  tyreHit(from, dir, maxDist, ignore, carHit = null) {
    let best = null, bt = maxDist;
    for (const v of this.game.vehicles) {
      if (v.removed || v === ignore || !v.wheels) continue;
      // quick reject: car centre far from the ray
      _d.subVectors(v.curPos, from);
      const along = _d.dot(dir);
      if (along < -4 || along > bt + 4) continue;
      if (_d.lengthSq() - along * along > 16) continue;
      _q.copy(v.curQuat).invert();
      const o = _v.copy(from).sub(v.curPos).applyQuaternion(_q);
      const d = _n.copy(dir).applyQuaternion(_q);
      const R = v.T.wheelR, hw = v.T.wheelW / 2;
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        const cy = w.visualY, cz = w.z, cx = w.x;
        // curved tread: infinite cylinder along local x
        const oy = o.y - cy, oz = o.z - cz;
        const A = d.y * d.y + d.z * d.z, B = 2 * (oy * d.y + oz * d.z), C = oy * oy + oz * oz - R * R;
        const disc = B * B - 4 * A * C;
        const cand = [];
        if (A > 1e-8 && disc >= 0) cand.push((-B - Math.sqrt(disc)) / (2 * A));
        // sidewalls (discs at both faces)
        if (Math.abs(d.x) > 1e-6) for (const fx of [cx - hw, cx + hw]) cand.push((fx - o.x) / d.x);
        for (const t of cand) {
          if (t <= 0 || t >= bt) continue;
          if (carHit && t > carHit.dist && carHit.v !== v) continue; // behind another car's body
          const x = o.x + d.x * t, y = o.y + d.y * t - cy, z = o.z + d.z * t - cz;
          if (Math.abs(x - cx) > hw + 1e-3 || y * y + z * z > R * R * 1.0001) continue;
          bt = t;
          best = { v, i, point: from.clone().addScaledVector(dir, t) };
        }
      }
    }
    return best;
  }

  impact(shooter, W, hit, dir, dist) {
    const g = this.game;
    const o = g.physics.ownerOf(hit.collider);
    const type = o ? o.type : 'static';
    if (type === 'char') this.hitCharacter(o.char, hit.point, dir, W, shooter, dist);
    else if (type === 'ragdoll') this.hitRagdoll(o, hit, dir, W, shooter);
    else if (type === 'car') this.hitVehicle(o.vehicle, hit, dir, W, shooter);
    else if (type === 'heli' && o.heli) o.heli.bulletHit(hit.point, dir, W, shooter);
    else if (type === 'prop') {
      const rb = hit.collider.parent();
      if (rb && rb.isDynamic()) rb.applyImpulseAtPoint({ x: dir.x * W.impulse * 6, y: dir.y * W.impulse * 6 + 1, z: dir.z * W.impulse * 6 }, hit.point, true);
      g.effects.bulletHit(hit.point, hit.normal);
      g.audio.bulletImpact(hit.point, false);
    } else {
      g.effects.bulletHit(hit.point, hit.normal);
      g.audio.bulletImpact(hit.point, false);
      this.hole(hit.point, hit.normal);
    }
  }

  hitCharacter(c, point, dir, W, shooter, dist) {
    const g = this.game;
    const s = c.rig.scale;
    const rel = (point.y - c.pos.y) / (1.76 * s);
    const head = rel > 0.86;
    const mult = head ? 4 : rel < 0.47 ? 0.7 : 1;
    const fall = W.pellets > 1 ? clamp(1.3 - dist / W.range, 0.25, 1) : 1;
    _n.copy(dir).multiplyScalar(-1);
    g.effects.bloodHit(point, dir, head ? 1.5 : 1);
    g.audio.bulletImpact(point, true);
    const wasAlive = c.alive;
    c.damage(W.dmg * mult * fall, 'shot', shooter);
    const knock = W.knock && dist < W.knock;
    if (!c.alive || knock) {
      _v.copy(dir).multiplyScalar(2 + W.impulse * 1.6 * fall);
      _v.y = Math.max(_v.y, 0) + 0.8;
      if (c.state === 'ragdoll' || c.state === 'dead') {
        if (c.ragdoll.active) c.ragdoll.addVelocity?.(_v.multiplyScalar(0.4));
      } else if (c.state === 'foot' || c.state === 'getup' || c.state === 'seq') c.toRagdoll(_v, { spin: 0.7 });
    } else {
      c.pushVel.addScaledVector(dir, 0.5 * W.impulse);
      c.hitReact = 0.3;
      c.hitDir = c.hitDir || new THREE.Vector3();
      c.hitDir.copy(dir);
    }
    if (shooter && shooter.isPlayer) {
      g.hud.hitMarker?.(wasAlive && !c.alive);
      if (c.alive) g.police.crime(c.isCop ? 'assaultCop' : 'assault', c.pos); // deaths are reported by onCharacterDied
      if (c.ai && c.alive && c.ai.flee) c.ai.flee(shooter.pos, 12);
    }
  }

  hitRagdoll(o, hit, dir, W, shooter) {
    const g = this.game;
    const rb = hit.collider.parent();
    if (rb) rb.applyImpulseAtPoint({ x: dir.x * W.impulse * 9, y: dir.y * W.impulse * 9 + 2, z: dir.z * W.impulse * 9 }, hit.point, true);
    g.effects.bloodHit(hit.point, dir, 0.8);
    g.audio.bulletImpact(hit.point, true);
    const c = o.char;
    if (c && c.alive) {
      const wasAlive = c.alive;
      c.damage(W.dmg * (o.part === 'head' ? 4 : 1), 'shot', shooter);
      if (shooter && shooter.isPlayer) g.hud.hitMarker?.(wasAlive && !c.alive);
    }
  }

  hitVehicle(v, hit, dir, W, shooter) {
    const g = this.game;
    const local = v.worldToLocal(hit.point, new THREE.Vector3());
    if (shooter && shooter.isPlayer) v.lastPlayerHitT = g.time;
    // tyres
    if (v.bulletTire && v.bulletTire(local)) {
      g.effects.dust(hit.point, 0.5);
      g.audio.bulletImpact(hit.point, true);
      return;
    }
    v.health = Math.max(0, v.health - W.carDmg);
    const glass = v.glassHit ? v.glassHit(local, hit.point) : false;
    if (glass) {
      // through the window: the people inside
      this.hitOccupants(v, hit.point, dir, W, shooter, 1);
    } else {
      g.effects.bulletHit(hit.point, hit.normal);
      g.audio.metalHit(hit.point, 0.12);
      // door skins don't stop bullets either (at reduced damage)
      if (v.model && v.model.seat && Math.abs(local.z - v.model.seat.z) < 0.85 && local.y > v.T.beltY - 0.5) this.hitOccupants(v, hit.point, dir, W, shooter, 0.55);
    }
    if (shooter && shooter.isPlayer && v.driver && !v.driver.isPlayer && v.ai && v.ai.panic !== undefined) v.ai.panic = 8;
  }

  hitOccupants(v, from, dir, W, shooter, k = 1) {
    const occ = [v.driver, ...v.passengers].filter((c) => c && c.state === 'vehicle' && c !== shooter);
    let best = null, bt = 3.5, head = false;
    for (const c of occ) {
      c.rig.root.updateMatrixWorld(true);
      for (const [bone, r, isHead] of [['head', 0.14, true], ['chest', 0.21, false], ['spine', 0.19, false]]) {
        c.rig.bones[bone].getWorldPosition(_v);
        _d.subVectors(_v, from);
        const t = _d.dot(dir);
        if (t < 0 || t > bt) continue;
        const d2 = _d.lengthSq() - t * t;
        if (d2 < r * r) { bt = t; best = c; head = isHead; }
      }
    }
    if (!best) return;
    const g = this.game;
    _v.copy(from).addScaledVector(dir, bt);
    g.effects.bloodHit(_v, dir, 1);
    const wasAlive = best.alive;
    best.damage(W.dmg * (head ? 4 : 1) * k, 'shot', shooter);
    if (shooter && shooter.isPlayer) {
      g.hud.hitMarker?.(wasAlive && !best.alive);
      if (best.alive) g.police.crime(best.isCop ? 'assaultCop' : 'assault', best.pos);
    }
  }
}
