import * as THREE from 'three';
import { clamp, lerp, damp, makeRng } from '../core/util.js';
import { G, groups } from '../core/physics.js';

/*
 * Weather: clear / rain / storm.
 *
 * - rain: current intensity (0..1), eases towards the target of the current weather state
 * - wet: how wet the streets are; rises quickly in rain and dries slowly afterwards
 *
 * Rain streaks are animated entirely on the GPU in a box that follows the camera. Splashes are
 * raycast against the world so they land on roads, roofs and car bodies alike. Wet surfaces are
 * a shader patch on the city's ground materials: darker, glossier, with mirror-like puddles.
 * Lower tyre grip on wet surfaces is read by the vehicle physics through `wet`.
 */
export const WEATHER = {
  clear: { rain: 0, label: 'Clear · صاف' },
  rain: { rain: 0.6, label: 'Rain · باران' },
  storm: { rain: 1.0, label: 'Storm · طوفان' },
};
const ORDER = ['clear', 'rain', 'storm'];

// shared uniforms of every wettable material
export const WET_UNIFORMS = {
  uWet: { value: 0 },
  uRainNow: { value: 0 },
  uPuddleMap: { value: null },
  uTimeW: { value: 0 },
};

/** Tileable fbm noise texture (grayscale) used as the puddle mask. */
function puddleTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rng = makeRng(31337);
  // periodic value noise
  const grid = (n) => { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rng(); return g; };
  const octaves = [[4, 0.5], [8, 0.27], [16, 0.15], [32, 0.08]].map(([n, a]) => ({ n, a, g: grid(n) }));
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const o of octaves) {
        const fx = x / S * o.n, fy = y / S * o.n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = sm(fx - x0), ty = sm(fy - y0);
        const at = (i, j) => o.g[((j % o.n) * o.n) + (i % o.n)];
        const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        v += o.a * ((a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty);
      }
      const k = (y * S + x) * 4;
      const b = Math.round(clamp(v, 0, 1) * 255);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * Make a MeshStandardMaterial react to rain. shine: how much it turns glossy, darken: how much
 * darker it gets, puddles: how much standing water collects on it.
 */
export function makeWettable(mat, { shine = 1, darken = 0.4, puddles = 0 } = {}) {
  if (!mat || mat.userData.wettable) return;
  mat.userData.wettable = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uWet = WET_UNIFORMS.uWet;
    sh.uniforms.uPuddleMap = WET_UNIFORMS.uPuddleMap;
    sh.uniforms.uTimeW = WET_UNIFORMS.uTimeW;
    sh.uniforms.uRainNow = WET_UNIFORMS.uRainNow;
    sh.uniforms.uShine = { value: shine };
    sh.uniforms.uDarken = { value: darken };
    sh.uniforms.uPuddleK = { value: puddles };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRainW;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vRainW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vRainW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRainW;
        uniform float uWet; uniform float uShine; uniform float uDarken; uniform float uPuddleK; uniform float uTimeW; uniform float uRainNow;
        uniform sampler2D uPuddleMap;
        // expanding rings where raindrops hit standing water
        vec2 rainRipple(vec2 p, float t) {
          vec2 acc = vec2(0.0);
          for (int i = 0; i < 2; i++) {
            vec2 q = p * 2.6 + float(i) * 17.3;
            vec2 cell = floor(q);
            vec2 f = fract(q) - 0.5;
            float h = fract(sin(dot(cell, vec2(12.9898, 78.233)) + float(i) * 3.1) * 43758.5453);
            vec2 c = (vec2(fract(h * 7.1), fract(h * 13.7)) - 0.5) * 0.6;
            vec2 d = f - c;
            float r = length(d);
            float age = fract(t * 1.25 + h);
            float front = age * 0.42;
            float ring = sin((r - front) * 42.0) * smoothstep(0.12, 0.0, abs(r - front)) * (1.0 - age);
            acc += d / max(r, 1e-3) * ring;
          }
          return acc;
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float rainPuddle = 0.0;
        if (uWet > 0.001) {
          float pm = texture2D(uPuddleMap, vRainW.xz * 0.031).r * 0.7 + texture2D(uPuddleMap, vRainW.xz * 0.11 + 0.37).r * 0.3;
          rainPuddle = smoothstep(0.58 - 0.14 * uWet, 0.66 - 0.1 * uWet, pm) * uPuddleK * uWet;
          diffuseColor.rgb *= (1.0 - uWet * uDarken) * (1.0 - 0.55 * rainPuddle);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (uWet > 0.001) {
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.42, uWet * uShine);
          roughnessFactor = mix(roughnessFactor, 0.035, rainPuddle);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (rainPuddle * uRainNow > 0.01) {
          vec2 rp = rainRipple(vRainW.xz, uTimeW) * 0.3 * rainPuddle * uRainNow;
          normal = normalize(normal + (viewMatrix * vec4(rp.x, 0.0, rp.y, 0.0)).xyz);
        }`);
  };
  mat.customProgramCacheKey = () => `wet_${shine}_${darken}_${puddles}`;
  mat.needsUpdate = true;
}

/* ------------------------------------------------------------------ rain streaks (GPU) */
const RAIN_VS = `
  attribute vec3 aOff;
  attribute float aRnd;
  uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec2 uWind; uniform float uSpeed;
  uniform float uLen; uniform float uWidth;
  varying float vA; varying float vX;
  void main() {
    float sp = uSpeed * (0.85 + 0.3 * aRnd);
    vec3 vel = vec3(uWind.x, -sp, uWind.y);
    vec3 p = aOff * uBox + vel * uTime;
    vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
    vec3 wp = uCam + rel;
    vec3 dir = normalize(vel);
    vec3 toCam = normalize(cameraPosition - wp);
    vec3 side = normalize(cross(dir, toCam));
    float d = length(rel);
    vec3 pos = wp + side * position.x * uWidth * (1.0 + d * 0.035) + dir * (position.y - 0.5) * uLen * (0.8 + 0.4 * aRnd);
    vX = position.x * 2.0;
    vA = (0.35 + 0.65 * position.y) * smoothstep(0.6, 2.5, d) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, length(rel.xz)));
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }`;
const RAIN_FS = `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vA; varying float vX;
  void main() {
    float a = uOpacity * vA * (1.0 - vX * vX);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }`;

/* ------------------------------------------------------------------ cloud layer */
const CLOUD_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CLOUD_FS = `
  uniform float uK; uniform float uTime; uniform vec3 uCol; uniform vec3 uDark; uniform float uFlash;
  varying vec3 vDir;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1,0)), f.x), mix(h(i + vec2(0,1)), h(i + vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir);
    float y = max(d.y, 0.0);
    vec2 uv = d.xz / (y + 0.12) * 1.4 + vec2(uTime * 0.012, uTime * 0.005);
    float c = fbm(uv);
    float dens = smoothstep(0.25, 0.75, c);
    vec3 col = mix(uCol, uDark, dens);
    col += vec3(0.75, 0.8, 1.0) * uFlash * (0.4 + 0.6 * c);
    float a = uK * mix(0.86, 1.0, dens) * smoothstep(-0.25, 0.04, d.y);
    gl_FragColor = vec4(col, a);
  }`;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

export class Weather {
  constructor(game) {
    this.game = game;
    this.state = 'clear';
    this.rain = 0;
    this.wet = 0;
    this.auto = true;
    this.autoT = 240 + Math.random() * 180;
    this.time = 0;
    this.flash = 0;
    this.nextStrike = 12;
    this.bolts = [];
    this.splashAcc = 0;
    this.rng = makeRng(4711);
    WET_UNIFORMS.uPuddleMap.value = puddleTexture();
    this.buildRain();
    this.buildClouds();
    this.lightning = new THREE.DirectionalLight(0xc8d6ff, 0);
    this.lightning.position.set(0, 1, 0);
    game.scene.add(this.lightning);
    game.scene.add(this.lightning.target);
    this.wetCity(game.city);
  }

  wetCity(city) {
    const M = city.mats;
    const set = (k, o) => M[k] && makeWettable(M[k], o);
    set('asphalt', { shine: 1, darken: 0.45, puddles: 1 });
    set('lotAsphalt', { shine: 1, darken: 0.45, puddles: 1 });
    set('sidewalk', { shine: 0.85, darken: 0.4, puddles: 0.55 });
    set('plaza', { shine: 0.85, darken: 0.35, puddles: 0.55 });
    set('curb', { shine: 0.8, darken: 0.35, puddles: 0 });
    set('roof', { shine: 0.8, darken: 0.4, puddles: 0.8 });
    set('parapet', { shine: 0.6, darken: 0.3, puddles: 0 });
    set('markWhite', { shine: 0.9, darken: 0.25, puddles: 1 });
    set('markYellow', { shine: 0.9, darken: 0.25, puddles: 1 });
    set('skidBase', { shine: 0.9, darken: 0.3, puddles: 1 });
    set('grass', { shine: 0.25, darken: 0.3, puddles: 0 });
    set('dirt', { shine: 0.4, darken: 0.4, puddles: 0.6 });
    set('sand', { shine: 0.15, darken: 0.35, puddles: 0 });
    for (const m of city.facadeMats) makeWettable(m, { shine: 0.35, darken: 0.18, puddles: 0 });
  }

  buildRain() {
    const N = 9000;
    this.maxDrops = N;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const off = new Float32Array(N * 3), rnd = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      off[i * 3] = this.rng(); off[i * 3 + 1] = this.rng(); off[i * 3 + 2] = this.rng();
      rnd[i] = this.rng();
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 1));
    geo.instanceCount = 0;
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(44, 26, 44) },
        uWind: { value: new THREE.Vector2(1.2, 0.6) }, uSpeed: { value: 10 }, uLen: { value: 0.62 }, uWidth: { value: 0.011 },
        uColor: { value: new THREE.Color(0.78, 0.82, 0.88) }, uOpacity: { value: 0.3 },
      },
    });
    this.rainMesh = new THREE.Mesh(geo, this.rainMat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 5;
    this.rainMesh.visible = false;
    this.game.scene.add(this.rainMesh);
  }

  buildClouds() {
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: {
        uK: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 },
        uCol: { value: new THREE.Color(0.55, 0.57, 0.6) }, uDark: { value: new THREE.Color(0.33, 0.35, 0.38) },
      },
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1700, 32, 16), this.cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    this.clouds.visible = false;
    this.game.scene.add(this.clouds);
  }

  /** Cycle clear -> rain -> storm (key K). */
  cycle() {
    this.set(ORDER[(ORDER.indexOf(this.state) + 1) % ORDER.length]);
    this.autoT = 300 + this.rng() * 240;
  }

  set(state) {
    this.state = state;
    this.game.hud?.message(`${state === 'clear' ? '☀' : state === 'rain' ? '🌧' : '⛈'}  ${WEATHER[state].label}`, 1.6);
  }

  get target() { return WEATHER[this.state].rain; }
  get label() { return WEATHER[this.state].label; }

  update(dt) {
    const g = this.game;
    this.time += dt;
    // automatic weather changes every few minutes
    if (this.auto) {
      this.autoT -= dt;
      if (this.autoT <= 0) {
        const r = this.rng();
        this.set(this.state === 'clear' ? (r < 0.7 ? 'rain' : 'storm') : r < 0.75 ? 'clear' : this.state === 'rain' ? 'storm' : 'rain');
        this.autoT = this.state === 'clear' ? 240 + this.rng() * 240 : 120 + this.rng() * 150;
      }
    }
    // rain eases in/out over ~15 s; streets get wet in ~20 s and dry over ~2 min
    this.rain = damp(this.rain, this.target, this.target > this.rain ? 0.22 : 0.3, dt);
    if (Math.abs(this.rain - this.target) < 0.002) this.rain = this.target;
    const wetTarget = clamp(this.rain * 1.6, 0, 1);
    this.wet = wetTarget > this.wet ? Math.min(wetTarget, this.wet + dt * (0.03 + this.rain * 0.06)) : Math.max(wetTarget, this.wet - dt * 0.008);
    WET_UNIFORMS.uWet.value = this.wet;
    WET_UNIFORMS.uRainNow.value = clamp(this.rain * 1.4, 0, 1);
    WET_UNIFORMS.uTimeW.value = this.time;

    const env = g.env, night = !!env.night;
    env.setOvercast(clamp(this.rain * 1.25, 0, 1));

    // streaks
    const cam = g.camera.position;
    const on = this.rain > 0.01;
    this.rainMesh.visible = on;
    if (on) {
      const u = this.rainMat.uniforms;
      u.uTime.value = this.time;
      u.uCam.value.copy(cam);
      u.uOpacity.value = (night ? 0.24 : 0.3) * clamp(0.5 + this.rain * 0.6, 0, 1);
      u.uColor.value.setRGB(night ? 0.55 : 0.78, night ? 0.6 : 0.82, night ? 0.7 : 0.88);
      u.uWind.value.set(1.2 + this.rain * 1.6, 0.6 + this.rain * 0.8);
      this.rainMesh.geometry.instanceCount = Math.floor(this.maxDrops * clamp(this.rain, 0, 1));
      this.splashes(dt);
    }
    // clouds
    const ck = clamp(this.rain * 1.4, 0, 1);
    this.clouds.visible = ck > 0.01;
    if (this.clouds.visible) {
      this.clouds.position.copy(cam);
      const cu = this.cloudMat.uniforms;
      cu.uK.value = ck;
      cu.uTime.value = this.time;
      if (night) { cu.uCol.value.setRGB(0.05, 0.055, 0.07); cu.uDark.value.setRGB(0.025, 0.028, 0.035); }
      else if (env.presetName === 'golden') { cu.uCol.value.setRGB(0.5, 0.48, 0.47); cu.uDark.value.setRGB(0.3, 0.3, 0.32); }
      else { cu.uCol.value.setRGB(0.58, 0.6, 0.63); cu.uDark.value.setRGB(0.36, 0.38, 0.41); }
    }
    this.updateLightning(dt);
    g.audio?.setRain?.(this.rain, g.player.character.state === 'vehicle');
  }

  /** Droplets bouncing off whatever the rain hits around the camera. */
  splashes(dt) {
    const g = this.game, P = g.physics, cam = g.camera.position;
    this.splashAcc += dt * this.rain * 900;
    let n = Math.min(40, Math.floor(this.splashAcc));
    this.splashAcc -= n;
    const filter = groups(G.ALL, G.STATIC | G.CAR | G.PROP);
    while (n-- > 0) {
      const a = this.rng() * Math.PI * 2, r = 1.5 + Math.sqrt(this.rng()) * 18;
      _v.set(cam.x + Math.cos(a) * r, cam.y + 14, cam.z + Math.sin(a) * r);
      const hit = P.raycast(_v, _down, 40, filter);
      if (!hit) continue;
      g.effects.rainSplash(hit.point, this.rain);
    }
  }

  updateLightning(dt) {
    const g = this.game;
    this.flash = Math.max(0, this.flash - dt * 6);
    const storm = this.state === 'storm' && this.rain > 0.6;
    if (storm) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = 9 + this.rng() * 22;
        this.strike();
      }
    }
    // double flicker
    let f = this.flash;
    if (this.flashT !== undefined) {
      this.flashT += dt;
      const t = this.flashT;
      f = Math.max(f, t < 0.08 ? 1 : t < 0.14 ? 0.15 : t < 0.22 ? 0.85 : t < 0.5 ? (0.5 - t) * 1.5 : 0);
      if (t > 0.6) this.flashT = undefined;
    }
    this.lightning.intensity = f * (g.env.night ? 1.5 : 3.0);
    this.cloudMat.uniforms.uFlash.value = f * 0.6;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.mesh.material.opacity = b.life > 0.2 ? (Math.sin(b.life * 60) > -0.3 ? 1 : 0.2) : Math.max(0, b.life / 0.2);
      if (b.life <= 0) {
        g.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  /** A lightning bolt somewhere around the player, thunder after the light. */
  strike() {
    const g = this.game, r = this.rng;
    const cam = g.camera.position;
    const ang = r() * Math.PI * 2, dist = 250 + r() * 700;
    const gx = cam.x + Math.cos(ang) * dist, gz = cam.z + Math.sin(ang) * dist;
    this.flashT = 0;
    this.lightning.position.set(gx - cam.x, 300, gz - cam.z).normalize().multiplyScalar(100).add(cam);
    this.lightning.target.position.copy(cam);
    this.lightning.target.updateMatrixWorld();
    // jagged ribbon from the clouds to the ground, facing the camera
    const pts = [];
    let x = gx + (r() - 0.5) * 60, y = 320, z = gz + (r() - 0.5) * 60;
    pts.push(new THREE.Vector3(x, y, z));
    while (y > 0) {
      y -= 12 + r() * 22;
      x += (r() - 0.5) * 26; z += (r() - 0.5) * 26;
      pts.push(new THREE.Vector3(x, Math.max(0, y), z));
    }
    const pos = [];
    const w = 2.2;
    for (const p of pts) {
      _v2.subVectors(cam, p).normalize();
      const side = _v.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(w);
      pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
    }
    const idx = [];
    for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe8eeff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    g.scene.add(mesh);
    this.bolts.push({ mesh, life: 0.45 });
    // sound travels ~340 m/s
    g.audio?.thunder?.(dist / 340, clamp(1.4 - dist / 900, 0.35, 1.2));
  }
}

export { lerp };
