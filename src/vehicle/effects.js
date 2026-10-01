import * as THREE from 'three';
import { smokeTexture, sparkTexture, skidTexture } from '../world/textures.js';

const VS = `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
attribute float prot;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
varying float vFog;
uniform float scale;
uniform float fogNear;
uniform float fogFar;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * scale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
  vAlpha = palpha;
  vColor = pcolor;
  vRot = prot;
  vFog = smoothstep(fogNear, fogFar, -mv.z);
}`;
const FS = `
uniform sampler2D map;
uniform vec3 fogColor;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
varying float vFog;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vRot), co = cos(vRot);
  vec2 uv = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
  vec4 t = texture2D(map, uv);
  vec3 col = mix(vColor * t.rgb, fogColor, vFog * 0.85);
  gl_FragColor = vec4(col, t.a * vAlpha);
  if (gl_FragColor.a < 0.003) discard;
}`;

class ParticlePool {
  constructor(scene, cap, tex, blending, gravity = 0) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.rotV = new Float32Array(cap);
    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('psize', this.aSize);
    this.geo.setAttribute('palpha', this.aAlpha);
    this.geo.setAttribute('pcolor', this.aColor);
    this.geo.setAttribute('prot', this.aRot);
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending,
      uniforms: { map: { value: tex }, scale: { value: 600 }, fogColor: { value: new THREE.Color() }, fogNear: { value: 100 }, fogFar: { value: 700 } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.gravity = gravity;
  }

  spawn(p, v, life, s0, s1, alpha, color, drag = 1, grav = 1) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap);
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = s0; this.size1[i] = s1; this.alpha0[i] = alpha;
    this.drag[i] = drag; this.grav[i] = grav;
    this.rotV[i] = (Math.random() - 0.5) * 2;
    this.aRot.array[i] = Math.random() * 6.28;
    this.aColor.array[i * 3] = color.r; this.aColor.array[i * 3 + 1] = color.g; this.aColor.array[i * 3 + 2] = color.b;
  }

  update(dt, camera, scene, height) {
    const g = this.gravity;
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        this.copy(i, n);
        i--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + g * this.grav[i] * dt; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02 && this.grav[i] > 0) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.3; this.vel[i * 3] *= 0.6; this.vel[i * 3 + 2] *= 0.6; }
      const t = 1 - this.life[i] / this.maxLife[i];
      this.aSize.array[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      this.aAlpha.array[i] = this.alpha0[i] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      this.aRot.array[i] += this.rotV[i] * dt;
    }
    this.n = n;
    this.geo.setDrawRange(0, n);
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aRot.needsUpdate = true;
    this.mat.uniforms.scale.value = height / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
    if (scene.fog) {
      this.mat.uniforms.fogColor.value.copy(scene.fog.color);
      this.mat.uniforms.fogNear.value = scene.fog.near;
      this.mat.uniforms.fogFar.value = scene.fog.far;
    }
  }

  copy(dst, src) {
    for (let k = 0; k < 3; k++) {
      this.pos[dst * 3 + k] = this.pos[src * 3 + k];
      this.vel[dst * 3 + k] = this.vel[src * 3 + k];
      this.aColor.array[dst * 3 + k] = this.aColor.array[src * 3 + k];
    }
    this.life[dst] = this.life[src]; this.maxLife[dst] = this.maxLife[src];
    this.size0[dst] = this.size0[src]; this.size1[dst] = this.size1[src];
    this.alpha0[dst] = this.alpha0[src]; this.drag[dst] = this.drag[src]; this.grav[dst] = this.grav[src];
    this.rotV[dst] = this.rotV[src];
    this.aRot.array[dst] = this.aRot.array[src];
    this.aSize.array[dst] = this.aSize.array[src];
    this.aAlpha.array[dst] = this.aAlpha.array[src];
  }
}

/** Ground decal ribbons for tyre marks. */
class SkidMarks {
  constructor(scene, cap = 4000) {
    this.cap = cap;
    this.i = 0;
    this.pos = new Float32Array(cap * 6 * 3);
    this.col = new Float32Array(cap * 6 * 4);
    this.uv = new Float32Array(cap * 6 * 2);
    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('color', this.aCol);
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    for (let k = 0; k < cap; k++) {
      const u = this.uv;
      const o = k * 12;
      u.set([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], o);
    }
    this.mat = new THREE.MeshBasicMaterial({
      map: skidTexture(), vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, color: 0x111111,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.count = 0;
    this.dirtyFrom = cap;
    this.dirtyTo = 0;
  }

  add(a, b, width, alpha) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const nx = -dz / len * width / 2, nz = dx / len * width / 2;
    const k = this.i;
    const o = k * 18;
    const y0 = a.y + 0.012, y1 = b.y + 0.012;
    const p = [
      a.x + nx, y0, a.z + nz, a.x - nx, y0, a.z - nz, b.x - nx, y1, b.z - nz,
      a.x + nx, y0, a.z + nz, b.x - nx, y1, b.z - nz, b.x + nx, y1, b.z + nz,
    ];
    this.pos.set(p, o);
    for (let v = 0; v < 6; v++) {
      this.col[k * 24 + v * 4] = 1; this.col[k * 24 + v * 4 + 1] = 1; this.col[k * 24 + v * 4 + 2] = 1; this.col[k * 24 + v * 4 + 3] = alpha;
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, k);
    this.dirtyTo = Math.max(this.dirtyTo, k + 1);
    this.i = (this.i + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
  }

  flush() {
    if (this.dirtyTo <= this.dirtyFrom) return;
    this.geo.setDrawRange(0, this.count * 6);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.dirtyFrom = this.cap;
    this.dirtyTo = 0;
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const SMOKE_COLORS = {
  asphalt: new THREE.Color(0.86, 0.86, 0.88), concrete: new THREE.Color(0.86, 0.86, 0.86),
  sand: new THREE.Color(0.86, 0.76, 0.56), grass: new THREE.Color(0.45, 0.38, 0.26), dirt: new THREE.Color(0.5, 0.42, 0.3),
};

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.smoke = new ParticlePool(scene, 2200, smokeTexture(), THREE.NormalBlending, 0);
    this.sparks = new ParticlePool(scene, 900, sparkTexture(), THREE.AdditiveBlending, -9.8);
    this.debris = new ParticlePool(scene, 700, sparkTexture(), THREE.NormalBlending, -9.8);
    this.skids = new SkidMarks(scene);
    this.emitters = [];
  }

  tireSmoke(p, vel, intensity, surface) {
    const col = SMOKE_COLORS[surface] || SMOKE_COLORS.asphalt;
    _v.set(vel.x * 0.25 + (Math.random() - 0.5) * 1.2, 0.4 + Math.random() * 0.8, vel.z * 0.25 + (Math.random() - 0.5) * 1.2);
    _v2.set(p.x + (Math.random() - 0.5) * 0.2, p.y + 0.15, p.z + (Math.random() - 0.5) * 0.2);
    const dusty = surface === 'sand' || surface === 'grass' || surface === 'dirt';
    this.smoke.spawn(_v2, _v, 1.4 + Math.random() * 1.4 * intensity, 0.6, 2.8 + intensity * 2.2, (dusty ? 0.42 : 0.22) * Math.min(1, intensity + 0.3), col, 1.2, 0);
  }

  exhaust(p, vel) {
    _c.setRGB(0.6, 0.6, 0.62);
    _v.set(vel.x * 0.5, 0.25, vel.z * 0.5);
    this.smoke.spawn(p, _v, 0.8, 0.15, 0.7, 0.12, _c, 1.5, 0);
  }

  engineSmoke(p, heavy) {
    _c.setRGB(heavy ? 0.15 : 0.5, heavy ? 0.15 : 0.5, heavy ? 0.16 : 0.52);
    _v.set((Math.random() - 0.5) * 0.4, 1.2 + Math.random(), (Math.random() - 0.5) * 0.4);
    this.smoke.spawn(p, _v, 2.5, 0.4, 2.8, heavy ? 0.5 : 0.25, _c, 0.6, 0);
  }

  sparkBurst(p, dir, count = 14, speed = 6) {
    for (let k = 0; k < count; k++) {
      _v.set(dir.x * speed + (Math.random() - 0.5) * speed, Math.random() * speed * 0.6 + 1, dir.z * speed + (Math.random() - 0.5) * speed);
      _c.setRGB(1, 0.75 + Math.random() * 0.2, 0.4);
      this.sparks.spawn(p, _v, 0.25 + Math.random() * 0.45, 0.12, 0.05, 1, _c, 0.6, 1);
    }
  }

  glass(p, amount = 1) {
    const n = Math.floor(18 + amount * 30);
    for (let k = 0; k < n; k++) {
      _v.set((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4);
      _c.setRGB(0.75, 0.88, 0.95);
      this.debris.spawn(p, _v, 1.2 + Math.random(), 0.06, 0.05, 0.9, _c, 0.3, 1);
    }
  }

  dust(p, amount = 1) {
    for (let k = 0; k < 6 * amount; k++) {
      _v.set((Math.random() - 0.5) * 1.5, Math.random() * 0.8, (Math.random() - 0.5) * 1.5);
      _c.setRGB(0.7, 0.66, 0.6);
      this.smoke.spawn(p, _v, 1 + Math.random(), 0.3, 1.6, 0.25, _c, 1.5, 0);
    }
  }

  debrisBurst(p, color, count = 10) {
    for (let k = 0; k < count; k++) {
      _v.set((Math.random() - 0.5) * 5, Math.random() * 4 + 1, (Math.random() - 0.5) * 5);
      this.debris.spawn(p, _v, 1.5, 0.12, 0.1, 1, color, 0.2, 1);
    }
  }

  /** Long-lived fountain (hydrant). */
  waterJet(p, duration = 14) {
    this.emitters.push({ type: 'water', p: p.clone(), t: duration });
  }

  update(dt, camera, scene, height) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t -= dt;
      if (e.t <= 0) { this.emitters.splice(i, 1); continue; }
      if (e.type === 'water') {
        for (let k = 0; k < 6; k++) {
          _v.set((Math.random() - 0.5) * 1.6, 9 + Math.random() * 3, (Math.random() - 0.5) * 1.6);
          _c.setRGB(0.8, 0.9, 1.0);
          this.debris.spawn(e.p, _v, 1.8, 0.25, 0.4, 0.55, _c, 0.15, 1);
        }
        if (Math.random() < 0.5) {
          _v.set((Math.random() - 0.5), 1, (Math.random() - 0.5));
          _v2.copy(e.p); _v2.y = 0.2;
          this.smoke.spawn(_v2, _v, 1.5, 0.8, 2.5, 0.15, _c.setRGB(0.85, 0.92, 1), 1.0, 0);
        }
      }
    }
    this.smoke.update(dt, camera, scene, height);
    this.sparks.update(dt, camera, scene, height);
    this.debris.update(dt, camera, scene, height);
    this.skids.flush();
  }
}
