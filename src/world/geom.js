import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Normalizes a geometry so it can be merged with others: non-indexed, position/normal/uv only. */
export function normalizeGeo(g, keepColor = false) {
  let geo = g.index ? g.toNonIndexed() : g;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && !(keepColor && k === 'color')) geo.deleteAttribute(k);
  }
  if (keepColor && !geo.attributes.color) {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  geo.clearGroups();
  return geo;
}

/** Paint a uniform vertex color onto a geometry. */
export function paint(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Box with world-space UVs (meters / uvScale). Faces can be skipped with opts.skip = ['py','ny',...].
 */
export function box(sx, sy, sz, cx = 0, cy = 0, cz = 0, opts = {}) {
  const us = opts.uvScale ?? 1;
  const skip = opts.skip || [];
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const pos = [], nor = [], uv = [];
  const face = (name, n, corners, uvs) => {
    if (skip.includes(name)) return;
    const [a, b, c, d] = corners;
    const [ua, ub, uc, ud] = uvs;
    for (const [p, t] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) {
      pos.push(p[0] + cx, p[1] + cy, p[2] + cz);
      nor.push(n[0], n[1], n[2]);
      uv.push(t[0], t[1]);
    }
  };
  const X0 = cx - hx, Z0 = cz - hz, Y0 = cy - hy;
  const wu = (v) => v / us;
  // +X face: u along -z, v along y
  face('px', [1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]],
    [[wu(-Z0 - sz), wu(Y0)], [wu(-Z0), wu(Y0)], [wu(-Z0), wu(Y0 + sy)], [wu(-Z0 - sz), wu(Y0 + sy)]].map(([u, v]) => [u, v]));
  face('nx', [-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]],
    [[wu(Z0), wu(Y0)], [wu(Z0 + sz), wu(Y0)], [wu(Z0 + sz), wu(Y0 + sy)], [wu(Z0), wu(Y0 + sy)]]);
  face('py', [0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]],
    [[wu(X0), wu(-Z0 - sz)], [wu(X0 + sx), wu(-Z0 - sz)], [wu(X0 + sx), wu(-Z0)], [wu(X0), wu(-Z0)]]);
  face('ny', [0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]],
    [[wu(X0), wu(Z0)], [wu(X0 + sx), wu(Z0)], [wu(X0 + sx), wu(Z0 + sz)], [wu(X0), wu(Z0 + sz)]]);
  face('pz', [0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]],
    [[wu(X0), wu(Y0)], [wu(X0 + sx), wu(Y0)], [wu(X0 + sx), wu(Y0 + sy)], [wu(X0), wu(Y0 + sy)]]);
  face('nz', [0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]],
    [[wu(-X0 - sx), wu(Y0)], [wu(-X0), wu(Y0)], [wu(-X0), wu(Y0 + sy)], [wu(-X0 - sx), wu(Y0 + sy)]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Vertical wall quad from (x0,z0) to (x1,z1). Faces direction (-dz, dx), so for a footprint
 * walk (x0,z1)->(x1,z1)->(x1,z0)->(x0,z0)->(x0,z1) all walls face outwards.
 */
export function wall(x0, z0, x1, z1, y0, y1, uScale, vScale, vOffset = 0) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
  const u1 = len / uScale;
  const v0 = (y0 - vOffset) / vScale, v1 = (y1 - vOffset) / vScale;
  const pos = [x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0];
  const uv = [0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1];
  const nor = [];
  for (let i = 0; i < 6; i++) nor.push(nx, 0, nz);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Horizontal quad at height y covering [x0,x1]x[z0,z1], facing up (or down). */
export function hquad(x0, z0, x1, z1, y, uvScale = 1, up = true) {
  const pos = up
    ? [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0]
    : [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / uvScale, -pos[i + 2] / uvScale);
  const nor = [];
  for (let i = 0; i < 6; i++) nor.push(0, up ? 1 : -1, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Oriented flat strip (road marking) on the ground: center (cx,cz), length along dir angle. */
export function strip(cx, cz, len, width, yaw, y = 0.012) {
  const g = hquad(-width / 2, -len / 2, width / 2, len / 2, 0, 1);
  g.rotateY(yaw);
  g.translate(cx, y, cz);
  return g;
}

/** Collects geometries per material and merges them into meshes. */
export class GeoBucket {
  constructor() { this.map = new Map(); }
  add(key, geo, matrix = null) {
    let g = normalizeGeo(geo, true);
    if (matrix) g.applyMatrix4(matrix);
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push(g);
  }
  build(parent, materials, opts = {}) {
    const meshes = [];
    for (const [key, list] of this.map) {
      if (!list.length) continue;
      const mat = materials[key];
      if (!mat) { console.warn('missing material', key); continue; }
      // merge in chunks to keep buffers reasonable
      const chunk = opts.chunk || 4000;
      for (let i = 0; i < list.length; i += chunk) {
        const merged = mergeGeometries(list.slice(i, i + chunk), false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        const m = new THREE.Mesh(merged, mat);
        const shadowOpt = opts.shadows?.[key] ?? opts.shadow ?? { cast: true, receive: true };
        m.castShadow = shadowOpt.cast;
        m.receiveShadow = shadowOpt.receive;
        m.name = 'bucket_' + key;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        parent.add(m);
        meshes.push(m);
      }
    }
    this.map.clear();
    return meshes;
  }
}

/** Tapered tube along a list of points (used for palm trunks etc.). */
export function taperedTube(points, r0, r1, radial = 10) {
  const curve = new THREE.CatmullRomCurve3(points);
  const segs = points.length * 6;
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  // scale radius along the curve: TubeGeometry builds rings in order
  const ringSize = radial + 1;
  const tmpP = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = curve.getPointAt(t);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j < ringSize; j++) {
      const idx = i * ringSize + j;
      tmpP.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(idx, tmpP.x, tmpP.y, tmpP.z);
    }
  }
  g.computeVertexNormals();
  return g;
}
