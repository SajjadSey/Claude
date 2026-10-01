import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shirtTexture } from '../world/textures.js';
import { makeRng, clamp } from '../core/util.js';

export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL', 'fingersL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR', 'fingersR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];

export const SKIN_TONES = ['#f3cfb0', '#e6b58f', '#d39d74', '#b77a52', '#8d5a3a', '#6a4129', '#4e2f1e'];
const HAIR_COLORS = ['#1b1410', '#2e1f16', '#4a3020', '#6b4a2e', '#a07040', '#d8b070', '#8a8a8a', '#c0392b'];
const SHIRT_COLORS = ['#f2f2f2', '#1d1d1f', '#2f6db5', '#d9534f', '#3cb371', '#f0ad4e', '#8e44ad', '#16a085', '#ff7eb6', '#34495e', '#e67e22', '#00bcd4'];
const PANTS_COLORS = ['#2b3a55', '#1f2833', '#5a4a3a', '#c8b48a', '#3d3d3d', '#6c7a89', '#8b5a2b', '#e8e2d0'];
const SHOE_COLORS = ['#f5f5f5', '#202020', '#7a5230', '#c0392b', '#2c3e50'];

/** Random appearance for NPCs. */
export function randomAppearance(seed) {
  const r = makeRng(seed);
  const female = r.chance(0.45);
  return {
    female,
    skin: r.pick(SKIN_TONES),
    hair: r.pick(HAIR_COLORS.slice(0, female ? 8 : 7)),
    hairStyle: female ? r.pick(['long', 'ponytail', 'bob', 'long']) : r.pick(['short', 'buzz', 'short', 'curly', 'bald', 'short']),
    shirt: r.pick(SHIRT_COLORS),
    shirtAccent: r.pick(SHIRT_COLORS),
    shirtKind: r.pick(['plain', 'plain', 'plain', 'stripes', 'hawaiian', 'plaid']),
    sleeve: r.pick(['short', 'short', 'long', female ? 'none' : 'short']),
    pants: r.pick(PANTS_COLORS),
    pantsKind: r.pick(['long', 'long', 'shorts']),
    shoes: r.pick(SHOE_COLORS),
    glasses: r.chance(0.2),
    hat: !female && r.chance(0.15),
    hatColor: r.pick(SHIRT_COLORS),
    scale: female ? r.range(0.9, 0.99) : r.range(0.96, 1.06),
    build: r.range(0.92, 1.14),
    seed,
  };
}

export const PLAYER_APPEARANCE = {
  female: false, skin: '#d6a07a', hair: '#1e1611', hairStyle: 'short', shirt: '#17a2b8', shirtAccent: '#ff5e8a',
  shirtKind: 'hawaiian', sleeve: 'short', pants: '#2e3b55', pantsKind: 'long', shoes: '#f4f4f4', glasses: false,
  hat: false, scale: 1.0, build: 1.03, seed: 7, beard: true,
};

/* ------------------------------------------------------------------ geometry helpers */
function capsuleProfile(r1, r2, len, capSeg = 5, midSeg = 6) {
  const pts = [];
  for (let i = 0; i <= capSeg; i++) {
    const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0, r2 * Math.cos(a)), -len + r2 * Math.sin(a)));
  }
  for (let i = 1; i < midSeg; i++) {
    const t = i / midSeg;
    pts.push(new THREE.Vector2(r2 + (r1 - r2) * t, -len + len * t));
  }
  for (let i = 0; i <= capSeg; i++) {
    const a = (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0, r1 * Math.cos(a)), r1 * Math.sin(a)));
  }
  return pts;
}

/** Tapered capsule from y=0 (radius r1) down to y=-len (radius r2). */
function limb(r1, r2, len, radial = 12, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(capsuleProfile(r1, r2, len), radial);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  return g;
}

/** Lathe from explicit [radius, y] profile (bottom -> top). */
function latheProfile(prof, radial = 16, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), radial);
  g.scale(sx, 1, sz);
  return g;
}

function ellipsoid(rx, ry, rz, w = 16, h = 12) {
  return new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
}

function roundedBox(sx, sy, sz, r = 0.4) {
  // squashed sphere-box hybrid
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const s = v.clone().normalize().multiplyScalar(0.5);
    v.lerp(s, r);
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ rig */
export class Rig {
  constructor(app) {
    this.app = app;
    const s = app.scale || 1;
    this.scale = s;
    const fem = app.female;
    const bw = app.build || 1;
    const shoulderX = (fem ? 0.135 : 0.155) * (0.9 + bw * 0.1);
    const hipX = (fem ? 0.095 : 0.09);
    // rest local offsets (unscaled, the root group carries the scale)
    this.def = {
      hips: [null, 0, 0.98, 0],
      spine: ['hips', 0, 0.09, 0],
      chest: ['spine', 0, 0.21, 0],
      neck: ['chest', 0, 0.24, -0.012],
      head: ['neck', 0, 0.09, 0.012],
      shoulderL: ['chest', 0.035, 0.19, -0.01],
      upperArmL: ['shoulderL', shoulderX, 0, 0],
      forearmL: ['upperArmL', 0, -0.285, 0],
      handL: ['forearmL', 0, -0.255, 0],
      fingersL: ['handL', 0, -0.092, 0],
      shoulderR: ['chest', -0.035, 0.19, -0.01],
      upperArmR: ['shoulderR', -shoulderX, 0, 0],
      forearmR: ['upperArmR', 0, -0.285, 0],
      handR: ['forearmR', 0, -0.255, 0],
      fingersR: ['handR', 0, -0.092, 0],
      thighL: ['hips', hipX, -0.04, 0],
      shinL: ['thighL', 0, -0.445, 0],
      footL: ['shinL', 0, -0.425, 0],
      thighR: ['hips', -hipX, -0.04, 0],
      shinR: ['thighR', 0, -0.445, 0],
      footR: ['shinR', 0, -0.425, 0],
    };
    // world-scale lengths
    this.L = {
      thigh: 0.445 * s, shin: 0.425 * s, upperArm: 0.285 * s, forearm: 0.255 * s,
      hipsY: 0.98 * s, hipJointY: 0.94 * s, ankle: 0.07 * s, footFwd: 0.14 * s, heel: 0.05 * s,
      hipX: hipX * s, shoulderY: 1.47 * s, height: 1.8 * s,
    };
    this.L.leg = this.L.thigh + this.L.shin;

    this.root = new THREE.Group();
    this.root.scale.setScalar(s);
    this.bones = {};
    this.list = [];
    for (const name of BONE_NAMES) {
      const b = new THREE.Bone();
      b.name = name;
      const [parent, x, y, z] = this.def[name];
      b.position.set(x, y, z);
      if (parent) this.bones[parent].add(b);
      this.bones[name] = b;
      this.list.push(b);
    }
    this.restPos = this.list.map((b) => b.position.clone());
    this.index = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
    this.buildMesh(app);
  }

  resetPose() {
    for (let i = 0; i < this.list.length; i++) {
      this.list[i].position.copy(this.restPos[i]);
      this.list[i].quaternion.identity();
    }
  }

  /* -------------------------------------------------------------- mesh */
  buildMesh(app) {
    const parts = []; // {geo, bone, color, shirt, top:{bone,y,range}, bot:{bone,y,range}}
    const skin = app.skin, shirt = app.shirt, pants = app.pants, shoes = app.shoes, hair = app.hair;
    const fem = app.female;
    const bw = app.build || 1;
    const P = (geo, bone, color, extra = {}) => parts.push({ geo, bone, color, ...extra });
    const shirtSleeve = app.sleeve;
    const tex = app.shirtKind && app.shirtKind !== 'plain';

    // ---------- pelvis / hips
    const hipW = (fem ? 0.175 : 0.165) * (0.95 + bw * 0.05);
    P(ellipsoid(hipW, 0.115, 0.118, 18, 12).translate(0, -0.03, -0.005), 'hips', pants, {
      top: { bone: 'spine', y: 0.05, range: 0.08 },
    });
    // belt
    P(new THREE.TorusGeometry(0.152, 0.018, 6, 24).rotateX(Math.PI / 2).scale(hipW / 0.155, 1, 0.78).translate(0, 0.055, -0.003), 'hips', '#2a1d14');
    P(new THREE.BoxGeometry(0.04, 0.03, 0.01).translate(0, 0.055, 0.098), 'hips', '#c9a227');

    // ---------- abdomen
    const absProf = [[0, -0.07], [0.12, -0.065], [0.142, -0.02], [0.138, 0.06], [0.142, 0.14], [0.15, 0.2], [0.12, 0.26], [0, 0.27]];
    P(latheProfile(absProf, 18, (fem ? 0.92 : 1.0) * bw, 0.74), 'spine', shirt, {
      shirt: true,
      bot: { bone: 'hips', y: -0.0, range: 0.08, up: true },
      top: { bone: 'chest', y: 0.21, range: 0.08 },
    });

    // ---------- chest / ribcage + shoulders
    const chestProf = [[0, -0.05], [0.14, -0.04], [0.155, 0.04], [0.175, 0.12], [0.18, 0.17], [0.16, 0.215], [0.1, 0.25], [0.05, 0.27], [0, 0.275]];
    P(latheProfile(chestProf, 20, (fem ? 0.92 : 1.06) * bw, fem ? 0.7 : 0.68), 'chest', shirt, {
      shirt: true, bot: { bone: 'spine', y: 0.0, range: 0.1, up: true },
    });
    if (fem) {
      for (const sx of [-1, 1]) P(ellipsoid(0.058, 0.055, 0.055, 12, 10).translate(sx * 0.06, 0.115, 0.082), 'chest', shirt, { shirt: true });
    } else {
      // pectoral shape
      for (const sx of [-1, 1]) P(ellipsoid(0.075, 0.05, 0.035, 12, 8).translate(sx * 0.065, 0.14, 0.09), 'chest', shirt, { shirt: true });
    }
    // trapezius
    P(ellipsoid(0.15 * bw, 0.06, 0.07, 14, 8).translate(0, 0.22, -0.02), 'chest', shirt, { shirt: true });
    // collar / neckline
    if (shirtSleeve !== 'none') P(new THREE.TorusGeometry(0.06, 0.014, 6, 18).rotateX(Math.PI / 2 - 0.25).translate(0, 0.252, 0.0), 'chest', shirt, { shirt: true });

    // ---------- neck & head
    P(limb(0.05, 0.056, 0.12, 12).rotateX(Math.PI).translate(0, -0.02, 0), 'neck', skin, {
      bot: { bone: 'chest', y: -0.0, range: 0.06, up: true },
      top: { bone: 'head', y: 0.09, range: 0.04 },
    });
    this.buildHead(P, app);

    // ---------- arms
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? 1 : -1;
      const armSkin = shirtSleeve === 'long' ? shirt : skin;
      // deltoid
      P(ellipsoid(0.066, 0.07, 0.066, 12, 10).translate(-sx * 0.005, -0.02, 0), 'upperArm' + side, shirtSleeve === 'none' ? skin : shirt, {
        shirt: shirtSleeve !== 'none',
        top: { bone: 'chest', y: 0.03, range: 0.06 },
      });
      P(limb(0.054, 0.043, 0.285, 12, 1, 1.05), 'upperArm' + side, shirtSleeve === 'none' || shirtSleeve === 'short' ? skin : shirt, {
        shirt: shirtSleeve === 'long',
        top: { bone: 'chest', y: 0.0, range: 0.06 },
        bot: { bone: 'forearm' + side, y: -0.285, range: 0.07 },
      });
      if (shirtSleeve === 'short') {
        P(limb(0.064, 0.058, 0.13, 12).translate(0, -0.01, 0), 'upperArm' + side, shirt, {
          shirt: true, top: { bone: 'chest', y: 0.0, range: 0.06 },
        });
      }
      P(limb(0.044, 0.033, 0.255, 12, 1, 0.9), 'forearm' + side, armSkin, {
        shirt: shirtSleeve === 'long',
        top: { bone: 'upperArm' + side, y: 0, range: 0.06, parentJoint: true },
        bot: { bone: 'hand' + side, y: -0.255, range: 0.04 },
      });
      if (shirtSleeve === 'long') P(limb(0.04, 0.038, 0.03, 10).translate(0, -0.235, 0), 'forearm' + side, shirt, { shirt: true });
      // hand: palm (thin along x), thumb towards +z
      P(roundedBox(0.03, 0.09, 0.08, 0.55).translate(0, -0.047, 0.004), 'hand' + side, skin, {
        top: { bone: 'forearm' + side, y: 0.0, range: 0.03 },
      });
      const thumb = limb(0.013, 0.01, 0.05, 8).rotateX(0.55).rotateZ(sx * 0.25).translate(-sx * 0.004, -0.025, 0.035);
      P(thumb, 'hand' + side, skin);
      // fingers (on fingers bone, curl around x)
      const fl = [];
      for (let k = 0; k < 4; k++) {
        const z = 0.027 - k * 0.018;
        const len = [0.07, 0.078, 0.074, 0.06][k];
        fl.push(limb(0.0105, 0.0085, len, 7).translate(0, 0.004, z));
      }
      P(mergeParts(fl), 'fingers' + side, skin, { top: { bone: 'hand' + side, y: 0.004, range: 0.02 } });
      if (app.watch && side === 'L') P(new THREE.TorusGeometry(0.036, 0.008, 6, 14).rotateX(Math.PI / 2).translate(0, -0.23, 0), 'forearm' + side, '#222');
    }

    // ---------- legs
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? 1 : -1;
      const shorts = app.pantsKind === 'shorts';
      P(limb(0.088, 0.062, 0.445, 14, 1, 1.0).translate(sx * 0.004, 0, 0), 'thigh' + side, shorts ? skin : pants, {
        top: { bone: 'hips', y: 0.02, range: 0.08 },
        bot: { bone: 'shin' + side, y: -0.445, range: 0.08 },
      });
      if (shorts) {
        P(limb(0.096, 0.08, 0.27, 14).translate(sx * 0.004, 0.02, 0), 'thigh' + side, pants, {
          top: { bone: 'hips', y: 0.02, range: 0.08 },
        });
      }
      // calf with slight bulge at the back
      const calf = latheProfile([[0, -0.44], [0.035, -0.432], [0.042, -0.36], [0.05, -0.22], [0.058, -0.12], [0.062, -0.03], [0.058, 0.02], [0, 0.04]], 12, 1, 1);
      P(calf, 'shin' + side, shorts ? skin : pants, {
        top: { bone: 'thigh' + side, y: 0.0, range: 0.08, parentJoint: true },
        bot: { bone: 'foot' + side, y: -0.425, range: 0.05 },
      });
      if (!shorts) P(limb(0.048, 0.05, 0.05, 12).translate(0, -0.37, 0), 'shin' + side, pants);
      else P(limb(0.034, 0.036, 0.05, 10).translate(0, -0.39, 0), 'shin' + side, '#ffffff'); // sock
      // shoe
      const shoe = roundedBox(0.095, 0.075, 0.25, 0.6).translate(0, -0.032, 0.045);
      P(shoe, 'foot' + side, shoes);
      P(roundedBox(0.1, 0.025, 0.265, 0.3).translate(0, -0.062, 0.045), 'foot' + side, shoes === '#f5f5f5' ? '#d8d8d8' : '#f0f0f0');
      P(limb(0.044, 0.046, 0.04, 10).translate(0, 0.02, -0.005), 'foot' + side, shorts ? '#ffffff' : pants, {
        top: { bone: 'shin' + side, y: 0.04, range: 0.04 },
      });
    }

    // ---------- assemble skinned geometry
    // bones are still a standalone hierarchy rooted at the hips: their world matrices are mesh-space
    this.bones.hips.updateMatrixWorld(true);
    const baseGeos = [], shirtGeos = [];
    const tmpV = new THREE.Vector3();
    for (const part of parts) {
      let g = part.geo.index ? part.geo.toNonIndexed() : part.geo;
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      const n = g.attributes.position.count;
      const bone = this.bones[part.bone];
      const bi = this.index[part.bone];
      const skinIndex = new Uint16Array(n * 4);
      const skinWeight = new Float32Array(n * 4);
      const col = new THREE.Color(part.color);
      const colors = new Float32Array(n * 3);
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const y = pos.getY(i);
        let wt = 0, wb = 0;
        if (part.top) {
          const t = (y - (part.top.y - part.top.range)) / part.top.range;
          wt = clamp(0.5 * smooth(t), 0, 0.5) + (t > 1 ? clamp((t - 1) * 0.3, 0, 0.25) : 0);
        }
        if (part.bot) {
          let t;
          if (part.bot.up) t = ((part.bot.y + part.bot.range) - y) / part.bot.range; // joint below, part extends upwards
          else t = ((part.bot.y + part.bot.range) - y) / part.bot.range;
          wb = clamp(0.5 * smooth(t), 0, 0.5) + (t > 1 ? clamp((t - 1) * 0.3, 0, 0.25) : 0);
        }
        const ws = Math.max(0, 1 - wt - wb);
        skinIndex[i * 4] = bi; skinWeight[i * 4] = ws;
        skinIndex[i * 4 + 1] = part.top ? this.index[part.top.bone] : 0; skinWeight[i * 4 + 1] = wt;
        skinIndex[i * 4 + 2] = part.bot ? this.index[part.bot.bone] : 0; skinWeight[i * 4 + 2] = wb;
        const cmul = part.shirt && tex ? 1 : 1;
        colors[i * 3] = col.r * cmul; colors[i * 3 + 1] = col.g * cmul; colors[i * 3 + 2] = col.b * cmul;
      }
      g = g.clone();
      // transform to bind (model) space
      g.applyMatrix4(bone.matrixWorld);
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      for (const k of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'color'].includes(k)) g.deleteAttribute(k);
      }
      if (part.shirt && tex) {
        // scale uvs for the fabric pattern
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.5, uv.getY(i) * 1.2);
        // pattern texture already carries the shirt colors -> vertex colour white
        g.attributes.color.array.fill(1);
        g.attributes.color.needsUpdate = true;
        shirtGeos.push(g);
      } else baseGeos.push(g);
      void tmpV;
    }
    const groupsList = [mergeGeometries(baseGeos, false)];
    if (shirtGeos.length) groupsList.push(mergeGeometries(shirtGeos, false));
    const geo = groupsList.length > 1 ? mergeGeometries(groupsList, true) : groupsList[0];
    geo.computeBoundingSphere();
    const baseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });
    const mats = [baseMat];
    if (shirtGeos.length) {
      const st = shirtTexture(app.shirtKind, app.shirt, app.shirtAccent || '#ff6699', app.seed || 1);
      mats.push(new THREE.MeshStandardMaterial({ map: st, vertexColors: true, roughness: 0.82 }));
    }
    const mesh = new THREE.SkinnedMesh(geo, mats.length > 1 ? mats : baseMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.add(this.bones.hips);
    this.root.add(mesh);
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.list);
    mesh.bind(skeleton);
    this.mesh = mesh;
    this.materials = mats;
  }

  buildHead(P, app) {
    const skin = app.skin, hair = app.hair;
    const fem = app.female;
    // cranium & face
    P(ellipsoid(0.092, 0.108, 0.1, 22, 18).translate(0, 0.105, 0.008), 'head', skin, { bot: { bone: 'neck', y: 0.0, range: 0.04, up: true } });
    // jaw / chin
    P(ellipsoid(fem ? 0.068 : 0.075, 0.062, 0.075, 16, 12).translate(0, 0.045, 0.03), 'head', skin);
    P(ellipsoid(0.03, 0.022, 0.025, 10, 8).translate(0, 0.012, 0.075), 'head', skin);
    // cheekbones
    for (const sx of [-1, 1]) P(ellipsoid(0.03, 0.022, 0.025, 10, 8).translate(sx * 0.052, 0.085, 0.072), 'head', skin);
    // ears
    for (const sx of [-1, 1]) {
      P(ellipsoid(0.012, 0.028, 0.02, 10, 8).translate(sx * 0.092, 0.095, 0.0), 'head', skin);
    }
    // nose
    const nose = new THREE.ConeGeometry(0.016, 0.045, 10).rotateX(Math.PI * 0.6).translate(0, 0.088, 0.108);
    P(nose, 'head', skin);
    P(ellipsoid(0.017, 0.012, 0.012, 10, 8).translate(0, 0.072, 0.112), 'head', skin);
    // eyes
    for (const sx of [-1, 1]) {
      P(ellipsoid(0.015, 0.011, 0.01, 12, 8).translate(sx * 0.034, 0.105, 0.093), 'head', '#f4f1ea');
      P(ellipsoid(0.0075, 0.0075, 0.004, 10, 8).translate(sx * 0.034, 0.105, 0.1025), 'head', app.eyes || '#3b2a1a');
      P(ellipsoid(0.0035, 0.0035, 0.002, 8, 6).translate(sx * 0.034, 0.105, 0.1062), 'head', '#050505');
      // eyelid
      P(ellipsoid(0.017, 0.006, 0.011, 12, 6).translate(sx * 0.034, 0.113, 0.093), 'head', skin);
      // eyebrow
      P(new THREE.BoxGeometry(0.036, 0.007, 0.01).rotateZ(sx * (fem ? -0.1 : -0.05)).translate(sx * 0.036, 0.128, 0.098), 'head', hair);
    }
    // mouth
    P(ellipsoid(0.022, 0.0055, 0.008, 12, 6).translate(0, 0.048, 0.1), 'head', fem ? '#b04a52' : '#8a4a40');
    P(ellipsoid(0.02, 0.004, 0.007, 12, 6).translate(0, 0.041, 0.098), 'head', fem ? '#c25a62' : '#9a5a50');
    // beard / stubble
    if (app.beard) {
      P(ellipsoid(0.079, 0.06, 0.077, 16, 10).translate(0, 0.043, 0.031), 'head', shade(hair, 0.9), { stubble: true });
    }
    // hair
    const hs = app.hairStyle;
    if (hs !== 'bald') {
      const cap = (r, thetaLen = Math.PI * 0.55) => new THREE.SphereGeometry(r, 22, 14, 0, Math.PI * 2, 0, thetaLen);
      if (hs === 'buzz') {
        P(cap(0.098, Math.PI * 0.52).scale(0.97, 1.05, 1.04).rotateX(-0.35).translate(0, 0.112, 0.0), 'head', hair);
      } else if (hs === 'curly') {
        P(cap(0.115, Math.PI * 0.58).scale(1.0, 1.0, 1.05).rotateX(-0.3).translate(0, 0.11, -0.004), 'head', hair);
        for (let k = 0; k < 10; k++) {
          const a = k / 10 * Math.PI * 2;
          P(ellipsoid(0.03, 0.03, 0.03, 8, 6).translate(Math.cos(a) * 0.08, 0.17 + Math.sin(k) * 0.01, Math.sin(a) * 0.08 - 0.01), 'head', hair);
        }
      } else {
        P(cap(0.104, Math.PI * 0.56).scale(0.98, 1.06, 1.06).rotateX(-0.38).translate(0, 0.113, -0.002), 'head', hair);
        // fringe / top volume
        P(ellipsoid(0.085, 0.035, 0.07, 14, 8).rotateX(-0.2).translate(0, 0.19, 0.02), 'head', hair);
        if (hs === 'long' || hs === 'bob') {
          const len = hs === 'long' ? 0.24 : 0.12;
          P(latheProfile([[0, -len], [0.06, -len + 0.01], [0.095, -len + 0.06], [0.105, 0.0], [0.1, 0.06], [0, 0.065]], 18, 1.02, 0.95)
            .translate(0, 0.11, -0.022), 'head', hair);
          // keep the face open: front locks
          for (const sx of [-1, 1]) P(limb(0.022, 0.018, len * 0.75, 8).translate(sx * 0.085, 0.13, 0.04), 'head', hair);
        }
        if (hs === 'ponytail') {
          P(ellipsoid(0.03, 0.03, 0.03, 8, 6).translate(0, 0.13, -0.1), 'head', hair);
          P(limb(0.028, 0.012, 0.2, 8).rotateX(0.35).translate(0, 0.13, -0.11), 'head', hair);
        }
      }
    }
    if (app.glasses) {
      for (const sx of [-1, 1]) P(new THREE.BoxGeometry(0.036, 0.022, 0.006).translate(sx * 0.034, 0.105, 0.112), 'head', '#0b0b0d');
      P(new THREE.BoxGeometry(0.03, 0.004, 0.004).translate(0, 0.11, 0.112), 'head', '#0b0b0d');
      for (const sx of [-1, 1]) P(new THREE.BoxGeometry(0.004, 0.004, 0.1).translate(sx * 0.09, 0.108, 0.06), 'head', '#0b0b0d');
    }
    if (app.hat) {
      P(new THREE.SphereGeometry(0.108, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.85, 1.05).translate(0, 0.13, -0.005), 'head', app.hatColor);
      P(new THREE.CylinderGeometry(0.08, 0.085, 0.01, 18, 1, false, -Math.PI / 2, Math.PI).scale(1, 1, 1.15).translate(0, 0.135, 0.07), 'head', app.hatColor);
    }
  }
}

function smooth(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return '#' + c.getHexString();
}

function mergeParts(list) {
  return mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false);
}
