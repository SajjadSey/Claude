import * as THREE from 'three';
import { R, G, groups } from '../core/physics.js';

const DEFS = {
  trash: { shape: 'cyl', r: 0.28, h: 0.85, mass: 14, color: 0x2f6b3a, surface: 'metal' },
  cone: { shape: 'cone', r: 0.2, h: 0.55, mass: 2.5, color: 0xff6a00, surface: 'rubber' },
  barrel: { shape: 'cyl', r: 0.3, h: 0.9, mass: 24, color: 0xd12a1d, surface: 'metal' },
  crate: { shape: 'box', sx: 0.95, sy: 0.95, sz: 0.95, mass: 22, color: 0xa47a48, surface: 'wood' },
  box: { shape: 'box', sx: 0.6, sy: 0.45, sz: 0.5, mass: 4, color: 0xb8925a, surface: 'wood' },
  dumpster: { shape: 'box', sx: 1.9, sy: 1.25, sz: 1.1, mass: 380, color: 0x2a5a8a, surface: 'metal' },
  newsbox: { shape: 'box', sx: 0.5, sy: 1.0, sz: 0.45, mass: 35, color: 0x1e5aa8, surface: 'metal' },
};

const geoCache = new Map();
function geoFor(type) {
  if (geoCache.has(type)) return geoCache.get(type);
  const d = DEFS[type];
  let g;
  if (d.shape === 'cyl') {
    g = new THREE.CylinderGeometry(d.r, d.r * 0.92, d.h, 16);
  } else if (d.shape === 'cone') {
    const parts = [new THREE.ConeGeometry(d.r * 0.75, d.h, 14).translate(0, 0.02, 0), new THREE.BoxGeometry(d.r * 2.1, 0.04, d.r * 2.1).translate(0, -d.h / 2 + 0.02, 0)];
    g = mergeSimple(parts);
  } else {
    g = new THREE.BoxGeometry(d.sx, d.sy, d.sz, 2, 2, 2);
  }
  geoCache.set(type, g);
  return g;
}

function mergeSimple(list) {
  const pos = [], nor = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

const matCache = new Map();
function matFor(type) {
  if (matCache.has(type)) return matCache.get(type);
  const d = DEFS[type];
  const m = new THREE.MeshStandardMaterial({ color: d.color, roughness: d.surface === 'metal' ? 0.5 : 0.85, metalness: d.surface === 'metal' ? 0.4 : 0 });
  matCache.set(type, m);
  return m;
}

export class Props {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.fallen = [];
  }

  spawnAll(requests) {
    for (const r of requests) this.spawn(r.type, r.x, r.y, r.z, r.yaw);
  }

  spawn(type, x, y, z, yaw = 0) {
    const d = DEFS[type];
    if (!d) return null;
    const P = this.game.physics;
    const hh = d.shape === 'box' ? d.sy / 2 : d.h / 2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const body = P.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(x, y + hh + 0.01, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.1).setAngularDamping(0.3)
      .setSleeping(true));
    let cd;
    if (d.shape === 'cyl') cd = R.ColliderDesc.cylinder(d.h / 2, d.r);
    else if (d.shape === 'cone') cd = R.ColliderDesc.cone(d.h / 2, d.r);
    else cd = R.ColliderDesc.cuboid(d.sx / 2, d.sy / 2, d.sz / 2);
    cd.setMass(d.mass).setFriction(0.6).setRestitution(0.2)
      .setCollisionGroups(groups(G.PROP, G.ALL))
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(d.mass * 60);
    const col = P.world.createCollider(cd, body);
    const mesh = new THREE.Mesh(geoFor(type), matFor(type));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (type === 'trash') {
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 1.05, d.r * 1.05, 0.06, 16), new THREE.MeshStandardMaterial({ color: 0x1d4024, roughness: 0.6 }));
      lid.position.y = d.h / 2 + 0.03;
      mesh.add(lid);
    }
    if (type === 'cone') {
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 0.42, d.r * 0.52, 0.09, 14), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      stripe.position.y = 0.05;
      mesh.add(stripe);
    }
    if (type === 'barrel') {
      for (const yy of [-0.25, 0.25]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(d.r * 1.0, 0.02, 6, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6 }));
        ring.position.y = yy;
        mesh.add(ring);
      }
    }
    this.game.scene.add(mesh);
    const prop = { type, body, collider: col, mesh, surface: d.surface, mass: d.mass, home: new THREE.Vector3(x, y, z) };
    P.setOwner(col, { type: 'prop', prop, surface: d.surface });
    this.sync(prop);
    this.list.push(prop);
    return prop;
  }

  sync(p) {
    const t = p.body.translation();
    const r = p.body.rotation();
    p.mesh.position.set(t.x, t.y, t.z);
    p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** Break a street lamp off its base: replace the static collider with a falling dynamic pole. */
  breakLamp(lamp, impulseDir, impulse) {
    if (lamp.broken) return;
    lamp.broken = true;
    const city = this.game.city;
    const P = this.game.physics;
    city.hideLampInstance(lamp.index);
    P.world.removeCollider(lamp.collider, true);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), lamp.yaw);
    const body = P.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(lamp.x, lamp.y + 3.6, lamp.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setAngularDamping(0.2));
    const cd = R.ColliderDesc.cylinder(3.5, 0.12).setMass(90).setFriction(0.6).setRestitution(0.1)
      .setCollisionGroups(groups(G.PROP, G.ALL));
    const col = P.world.createCollider(cd, body);
    const cd2 = R.ColliderDesc.cuboid(0.18, 0.1, 1.0).setTranslation(0, 3.6, 1.2).setMass(15).setCollisionGroups(groups(G.PROP, G.ALL));
    P.world.createCollider(cd2, body);
    P.setOwner(col, { type: 'prop', surface: 'metal' });
    const group = new THREE.Group();
    const pole = new THREE.Mesh(city.lampPoleGeo, city.mats.darkMetal);
    const head = new THREE.Mesh(city.lampHeadGeo, city.mats.lampGlow);
    pole.position.y = -3.6; head.position.y = -3.6;
    pole.castShadow = true;
    group.add(pole, head);
    this.game.scene.add(group);
    const s = Math.min(1, impulse / 6000);
    body.applyImpulseAtPoint({ x: impulseDir.x * 600 * (0.4 + s), y: 50, z: impulseDir.z * 600 * (0.4 + s) }, { x: lamp.x, y: lamp.y + 5.5, z: lamp.z }, true);
    const prop = { type: 'lamp', body, collider: col, mesh: group, surface: 'metal' };
    this.list.push(prop);
    this.game.audio?.metalHit?.(new THREE.Vector3(lamp.x, lamp.y + 1, lamp.z), 1);
    this.game.effects?.sparkBurst(new THREE.Vector3(lamp.x, lamp.y + 0.6, lamp.z), impulseDir, 24, 5);
  }

  update() {
    for (const p of this.list) {
      if (p.body.isSleeping()) continue;
      this.sync(p);
    }
  }
}
