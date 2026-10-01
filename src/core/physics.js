import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** Collision group bits. */
export const G = {
  STATIC: 1,
  CAR: 2,
  CHAR: 4,
  RAGDOLL: 8,
  PROP: 16,
  DEBRIS: 32,
  ALL: 0xffff,
};
export const groups = (member, filter) => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

export let R = null;

const _v = new THREE.Vector3();

export class Physics {
  async init() {
    await RAPIER.init();
    R = RAPIER;
    this.R = RAPIER;
    this.h = 1 / 120;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.h;
    this.world.numSolverIterations = 4;
    this.eq = new RAPIER.EventQueue(true);
    this.fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.owners = new Map(); // collider handle -> owner descriptor
    this.cc = this.world.createCharacterController(0.025);
    this.cc.enableAutostep(0.36, 0.15, false);
    this.cc.enableSnapToGround(0.35);
    this.cc.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.cc.setMinSlopeSlideAngle(60 * Math.PI / 180);
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(80);
    this.cc.setSlideEnabled(true);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.time = 0;
    this.impactListeners = [];
    this.prePhysics = [];
    this.pairCooldown = new Map();
  }

  setOwner(collider, owner) {
    this.owners.set(collider.handle, owner);
  }

  ownerOf(collider) {
    return collider ? this.owners.get(collider.handle) : undefined;
  }

  removeBody(body) {
    if (!body) return;
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.owners.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  addStaticBox(cx, cy, cz, hx, hy, hz, rotY = 0, opts = {}) {
    const desc = R.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setFriction(opts.friction ?? 0.8)
      .setRestitution(opts.restitution ?? 0.05)
      .setCollisionGroups(groups(opts.member ?? G.STATIC, G.ALL));
    if (rotY) desc.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY));
    if (opts.rotation) desc.setRotation(opts.rotation);
    const c = this.world.createCollider(desc, this.fixed);
    this.setOwner(c, opts.owner || { type: 'static', surface: opts.surface || 'concrete' });
    return c;
  }

  addStaticCylinder(cx, cy, cz, halfH, r, opts = {}) {
    const desc = R.ColliderDesc.cylinder(halfH, r)
      .setTranslation(cx, cy, cz)
      .setFriction(0.7)
      .setCollisionGroups(groups(G.STATIC, G.ALL));
    const c = this.world.createCollider(desc, this.fixed);
    this.setOwner(c, opts.owner || { type: 'static', surface: opts.surface || 'metal' });
    return c;
  }

  /**
   * Raycast returning hit point/normal/collider or null.
   * filter: membership/filter groups for the query.
   */
  raycast(origin, dir, maxDist, filter = groups(G.ALL, G.STATIC), excludeBody = null, excludeCollider = null, predicate = undefined) {
    const r = this.ray;
    r.origin.x = origin.x; r.origin.y = origin.y; r.origin.z = origin.z;
    r.dir.x = dir.x; r.dir.y = dir.y; r.dir.z = dir.z;
    const hit = this.world.castRayAndGetNormal(r, maxDist, true, undefined, filter, excludeCollider || undefined, excludeBody || undefined, predicate);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      dist: t,
      point: _hitPoint.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: _hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z),
      collider: hit.collider,
    };
  }

  /** Ground height under (x,z) against static world, or fallback. */
  groundHeight(x, z, fromY = 50, fallback = 0) {
    _o.set(x, fromY, z);
    const hit = this.raycast(_o, _down, fromY + 20, groups(G.ALL, G.STATIC));
    return hit ? hit.point.y : fallback;
  }

  step() {
    for (const fn of this.prePhysics) fn(this.h);
    this.world.step(this.eq);
    this.time += this.h;
    const world = this.world;
    this.eq.drainContactForceEvents((ev) => {
      const c1 = world.getCollider(ev.collider1());
      const c2 = world.getCollider(ev.collider2());
      if (!c1 || !c2) return;
      const o1 = this.owners.get(c1.handle);
      const o2 = this.owners.get(c2.handle);
      const mag = ev.totalForceMagnitude();
      const impulse = mag * this.h;
      ev.maxForceDirection(_dir);
      // Contact point
      let have = false;
      world.contactPair(c1, c2, (manifold) => {
        if (have) return;
        const n = manifold.numSolverContacts();
        if (n > 0) {
          const p = manifold.solverContactPoint(0);
          if (p) { _cp.set(p.x, p.y, p.z); have = true; }
        }
      });
      if (!have) {
        const t1 = c1.translation();
        const t2 = c2.translation();
        _cp.set((t1.x + t2.x) / 2, (t1.y + t2.y) / 2, (t1.z + t2.z) / 2);
      }
      for (const l of this.impactListeners) l(o1, o2, impulse, _cp, _dirV.set(_dir.x, _dir.y, _dir.z), c1, c2);
    });
  }
}

const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _o = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _dir = { x: 0, y: 0, z: 0 };
const _cp = new THREE.Vector3();
const _dirV = new THREE.Vector3();
void _v;
