import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { waterNormalTexture } from './textures.js';
import { DEG, lerp, clamp } from '../core/util.js';

const _c = new THREE.Color();
const _c2 = new THREE.Color();

const PRESETS = {
  golden: {
    elevation: 24, azimuth: 215, turbidity: 7, rayleigh: 2.2, mie: 0.006, mieG: 0.86,
    sun: 0xffc896, sunI: 3.4, hemiSky: 0xbcd3ff, hemiGround: 0x8f7458, hemiI: 0.45,
    fog: 0xe2b99c, fogNear: 140, fogFar: 760, exposure: 0.72, night: 0,
    envTop: 0x4f78b8, envHorizon: 0xf0b48a, envGround: 0x5a5048, envSun: 0xffb070, envI: 0.75,
  },
  noon: {
    elevation: 62, azimuth: 200, turbidity: 4, rayleigh: 1.2, mie: 0.004, mieG: 0.8,
    sun: 0xfff3e2, sunI: 3.6, hemiSky: 0xcfe3ff, hemiGround: 0x9a8a72, hemiI: 0.25,
    fog: 0xc4d6e6, fogNear: 180, fogFar: 900, exposure: 0.55, night: 0,
    envTop: 0x3f6fbf, envHorizon: 0xb8d0e8, envGround: 0x6a6258, envSun: 0xfff0d0, envI: 0.8,
  },
  night: {
    elevation: -6, azimuth: 235, turbidity: 2, rayleigh: 0.6, mie: 0.004, mieG: 0.8,
    sun: 0x8fa6ff, sunI: 0.45, hemiSky: 0x3a4a7a, hemiGround: 0x1a1612, hemiI: 0.35,
    fog: 0x141a2c, fogNear: 60, fogFar: 520, exposure: 1.0, night: 1,
    envTop: 0x0a1020, envHorizon: 0x2a2440, envGround: 0x0c0c10, envSun: 0x203050, envI: 0.6,
  },
};

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.presetName = 'golden';
    this.time = 0;
    this.shadowSize = 70;
  }

  build(quality) {
    const scene = this.scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    this.sunDir = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = quality.shadows;
    const ms = quality.shadowMap;
    this.sun.shadow.mapSize.set(ms, ms);
    const sc = this.sun.shadow.camera;
    sc.left = -this.shadowSize; sc.right = this.shadowSize; sc.top = this.shadowSize; sc.bottom = -this.shadowSize;
    sc.near = 1; sc.far = 500;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0xffffff, 100, 700);

    // Ocean
    const wn = waterNormalTexture();
    wn.repeat.set(60, 60);
    this.waterNormal = wn;
    this.waterMat = new THREE.MeshStandardMaterial({
      color: 0x1d6f8c, roughness: 0.06, metalness: 0.05, normalMap: wn, normalScale: new THREE.Vector2(0.45, 0.45),
      transparent: true, opacity: 0.9, envMapIntensity: 1.3,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 1, 1), this.waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(286 + 1200 - 4, -0.06, 0);
    water.receiveShadow = true;
    water.renderOrder = 1;
    scene.add(water);
    this.water = water;
    // surf line
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    this.foam = new THREE.Mesh(new THREE.PlaneGeometry(3, 1200), foamMat);
    this.foam.rotation.x = -Math.PI / 2;
    this.foam.position.set(287.5, -0.03, 0);
    scene.add(this.foam);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.apply(this.presetName);
  }

  apply(name) {
    this.presetName = name;
    const p = PRESETS[name];
    this.preset = p;
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mie;
    u.mieDirectionalG.value = p.mieG;
    const phi = (90 - p.elevation) * DEG;
    const theta = p.azimuth * DEG;
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(p.sun);
    this.sun.intensity = p.sunI;
    if (p.night) {
      // moonlight comes from above
      this.lightDir = new THREE.Vector3(-0.3, 0.8, 0.4).normalize();
    } else {
      this.lightDir = this.sunDir.clone();
    }
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiI;
    this.scene.fog.color.set(p.fog);
    this.scene.fog.near = p.fogNear;
    this.scene.fog.far = p.fogFar;
    this.renderer.toneMappingExposure = p.exposure;
    this.night = p.night;
    this.ovK = -1;
    this.envK = -1;
    this.setOvercast(this.overcast || 0);
    if (this.onChange) this.onChange(p);
  }

  /**
   * Blend the current time of day towards an overcast, rainy sky (k = 0..1): weaker sun, flat
   * diffuse light, grey fog closing in, and a greyer reflection environment (rebuilt in steps).
   */
  setOvercast(k) {
    const p = this.preset;
    if (!p) return;
    k = clamp(k, 0, 1);
    this.overcast = k;
    if (Math.abs(k - this.ovK) < 0.002) return;
    this.ovK = k;
    const u = this.sky.material.uniforms;
    u.turbidity.value = lerp(p.turbidity, 16, k);
    u.rayleigh.value = lerp(p.rayleigh, 0.25, k);
    u.mieCoefficient.value = lerp(p.mie, 0.02, k);
    this.sun.intensity = p.sunI * (1 - 0.94 * k);
    this.hemi.intensity = p.hemiI * (1 + (p.night ? 0.25 : 1.6) * k);
    this.hemi.color.set(p.hemiSky).lerp(_c.set(p.night ? 0x2a3040 : 0xb8bec6), k);
    this.scene.fog.color.set(p.fog).lerp(_c.set(p.night ? 0x0d1118 : 0x8e969e), k);
    this.scene.fog.near = lerp(p.fogNear, 18, k);
    this.scene.fog.far = lerp(p.fogFar, 300, k);
    this.renderer.toneMappingExposure = p.exposure * (1 + 0.12 * k);
    const step = Math.abs(k - this.envK);
    if (this.envK < 0 || step > 0.12 || (step > 0.001 && (k === 0 || k === 1))) this.buildEnv(k);
  }

  buildEnv(k) {
    const p = this.preset;
    this.envK = k;
    const grey = p.night ? 0x10141c : 0x9aa1a8;
    // Environment map: a controlled gradient dome (the raw sky shader's sun disk would flood the scene)
    const envScene = new THREE.Scene();
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(p.envTop).lerp(_c2.set(grey).multiplyScalar(0.8), k) },
        horizon: { value: new THREE.Color(p.envHorizon).lerp(_c2.set(grey), k) },
        ground: { value: new THREE.Color(p.envGround).lerp(_c2.set(grey).multiplyScalar(0.5), k * 0.6) },
        sunCol: { value: new THREE.Color(p.envSun).multiplyScalar(1 - 0.9 * k) },
        sunDir: { value: this.sunDir.clone() }, k: { value: p.envI },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunCol; uniform vec3 sunDir; uniform float k; varying vec3 vDir;
        void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(y, 0.55)) : mix(horizon, ground, pow(-y, 0.4));
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(s, 6.0) * 0.8 + pow(s, 64.0) * 2.5);
          gl_FragColor = vec4(c * k, 1.0); }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), domeMat);
    envScene.add(dome);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0, 1, 1000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.0;
    dome.geometry.dispose();
    domeMat.dispose();
  }

  cycle() {
    const order = ['golden', 'noon', 'night'];
    this.apply(order[(order.indexOf(this.presetName) + 1) % order.length]);
  }

  update(dt, focus) {
    this.time += dt;
    this.waterNormal.offset.set(this.time * 0.006, this.time * 0.004);
    this.foam.material.opacity = 0.25 + 0.15 * Math.sin(this.time * 0.8);
    // shadow camera follows the focus point, snapped to texels to avoid shimmering
    const ld = this.lightDir;
    const texel = (2 * this.shadowSize) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + ld.x * 200, ld.y * 200, fz + ld.z * 200);
    this.sun.target.updateMatrixWorld();
  }
}

export { lerp };
