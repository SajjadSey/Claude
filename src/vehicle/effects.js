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
    this.fireP = new ParticlePool(scene, 900, smokeTexture(), THREE.AdditiveBlending, 0);
    this.splash = new ParticlePool(scene, 1600, sparkTexture(), THREE.NormalBlending, -9.8);
    this.blood = new ParticlePool(scene, 900, smokeTexture(), THREE.NormalBlending, -9.8);
    this.skids = new SkidMarks(scene);
    this.emitters = [];
  }

  /** Flames licking out of an engine bay. */
  fire(p, k = 1) {
    _v.set((Math.random() - 0.5) * 0.6, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.6);
    _v2.set(p.x + (Math.random() - 0.5) * 0.7 * k, p.y, p.z + (Math.random() - 0.5) * 0.7 * k);
    _c.setRGB(1.0, 0.45 + Math.random() * 0.25, 0.12);
    this.fireP.spawn(_v2, _v, 0.45 + Math.random() * 0.4, 0.5 * k, 1.4 * k, 0.9, _c, 0.8, 0);
  }

  /** Fireball, sparks, debris and smoke. */
  explosion(p) {
    for (let k = 0; k < 90; k++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI * 0.5;
      const sp = 3 + Math.random() * 7;
      _v.set(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp + 2, Math.sin(a) * Math.cos(b) * sp);
      _c.setRGB(1.0, 0.35 + Math.random() * 0.4, 0.08);
      this.fireP.spawn(p, _v, 0.5 + Math.random() * 0.6, 1.5, 4.5, 1, _c, 2.2, 0);
    }
    for (let k = 0; k < 40; k++) {
      _v.set((Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6);
      _c.setRGB(0.12, 0.11, 0.1);
      this.smoke.spawn(p, _v, 3 + Math.random() * 3, 2, 8, 0.55, _c, 0.7, 0);
    }
    this.sparkBurst(p, _v.set(0, 1, 0), 60, 12);
    this.debrisBurst(p, _c.setRGB(0.15, 0.15, 0.15), 30);
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

  /** Raindrops bouncing off a surface. */
  rainSplash(p, k = 1, bright = 1) {
    const n = Math.random() < 0.5 ? 2 : 3;
    _c.setRGB(0.78 * bright, 0.83 * bright, 0.9 * bright);
    for (let i = 0; i < n; i++) {
      _v.set((Math.random() - 0.5) * 1.4, 0.7 + Math.random() * 1.3 * k, (Math.random() - 0.5) * 1.4);
      _v2.set(p.x, p.y + 0.02, p.z);
      this.splash.spawn(_v2, _v, 0.16 + Math.random() * 0.14, 0.035, 0.02, 0.5, _c, 0.2, 1);
    }
  }

  /** Spray thrown up behind a tyre on a wet road. */
  spray(p, vel, k) {
    _v.set(-vel.x * 0.15 + (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.9, -vel.z * 0.15 + (Math.random() - 0.5) * 1.2);
    _v2.set(p.x + (Math.random() - 0.5) * 0.25, p.y + 0.12, p.z + (Math.random() - 0.5) * 0.25);
    _c.setRGB(0.82, 0.85, 0.88);
    this.smoke.spawn(_v2, _v, 0.6 + Math.random() * 0.5, 0.35, 1.9, 0.16 * k, _c, 1.6, 0);
  }

  /** Blood spray from a bullet wound. */
  bloodHit(p, dir, k = 1) {
    for (let i = 0; i < 7 * k; i++) {
      _v.set(dir.x * 2.2 + (Math.random() - 0.5) * 1.6, dir.y * 2 + Math.random() * 1.4, dir.z * 2.2 + (Math.random() - 0.5) * 1.6);
      _c.setRGB(0.45 + Math.random() * 0.15, 0.02, 0.03);
      this.blood.spawn(p, _v, 0.3 + Math.random() * 0.35, 0.05, 0.1, 0.9, _c, 0.5, 1);
    }
    _c.setRGB(0.4, 0.03, 0.04);
    _v.set(dir.x * 0.4, 0.2, dir.z * 0.4);
    this.blood.spawn(p, _v, 0.5, 0.12, 0.35, 0.45, _c, 2.5, 0.1);
  }

  /** Brass shell ejected from a gun. */
  shell(p, side, up) {
    _v.set(side.x * (1.6 + Math.random()) + up.x, 1.4 + Math.random() * 0.8, side.z * (1.6 + Math.random()) + up.z);
    _c.setRGB(0.85, 0.65, 0.25);
    this.debris.spawn(p, _v, 0.9, 0.035, 0.035, 1, _c, 0.15, 1);
  }

  /** Pistol muzzle flash. */
  muzzle(p, dir) {
    _c.setRGB(1.0, 0.78, 0.4);
    _v.set(dir.x * 2, dir.y * 2, dir.z * 2);
    this.fireP.spawn(p, _v, 0.06, 0.32, 0.12, 1, _c, 0, 0);
    _v2.copy(p).addScaledVector(dir, 0.12);
    this.fireP.spawn(_v2, _v, 0.05, 0.22, 0.08, 0.9, _c, 0, 0);
    for (let k = 0; k < 3; k++) {
      _v.set(dir.x * 6 + (Math.random() - 0.5) * 3, dir.y * 6 + Math.random() * 2, dir.z * 6 + (Math.random() - 0.5) * 3);
      this.sparks.spawn(p, _v, 0.08 + Math.random() * 0.08, 0.05, 0.02, 1, _c, 0.5, 0.3);
    }
    _c.setRGB(0.6, 0.6, 0.6);
    _v.set(dir.x * 0.6, 0.3, dir.z * 0.6);
    this.smoke.spawn(p, _v, 0.6, 0.08, 0.5, 0.18, _c, 1.5, 0);
  }

  /** Bullet striking a hard surface. */
  bulletHit(p, n) {
    for (let k = 0; k < 5; k++) {
      _v.set(n.x * 3 + (Math.random() - 0.5) * 3, n.y * 3 + Math.random() * 2, n.z * 3 + (Math.random() - 0.5) * 3);
      _c.setRGB(1, 0.8, 0.5);
      this.sparks.spawn(p, _v, 0.1 + Math.random() * 0.15, 0.05, 0.02, 1, _c, 0.6, 1);
    }
    _c.setRGB(0.65, 0.62, 0.58);
    _v.set(n.x * 0.8, n.y * 0.8 + 0.2, n.z * 0.8);
    this.smoke.spawn(p, _v, 0.7, 0.06, 0.45, 0.3, _c, 2, 0);
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
    this.fireP.update(dt, camera, scene, height);
    this.sparks.update(dt, camera, scene, height);
    this.debris.update(dt, camera, scene, height);
    this.splash.update(dt, camera, scene, height);
    this.blood.update(dt, camera, scene, height);
    this.skids.flush();
  }
}
