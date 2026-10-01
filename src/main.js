import * as THREE from 'three';
import { Physics, G } from './core/physics.js';
import { Input } from './core/input.js';
import { clamp, makeRng } from './core/util.js';
import { City, CITY } from './world/city.js';
import { Environment } from './world/sky.js';
import { Props } from './world/props.js';
import { setMaxAnisotropy } from './world/textures.js';
import { Character } from './char/character.js';
import { PLAYER_APPEARANCE } from './char/rig.js';
import { Vehicle } from './vehicle/vehicle.js';
import { Effects } from './vehicle/effects.js';
import { TrafficManager } from './ai/traffic.js';
import { PedManager } from './ai/peds.js';
import { CameraRig } from './game/camera.js';
import { AudioSys } from './game/audio.js';
import { HUD } from './game/hud.js';
import { PlayerController } from './game/player.js';
import { Explosions } from './game/explosions.js';
import { EnterSequence, ExitSequence } from './char/carSequences.js';
import { randomAppearance } from './char/rig.js';

const QUALITY = {
  low: { shadows: false, shadowMap: 1024, pixelRatio: 0.75, label: 'Low' },
  medium: { shadows: true, shadowMap: 1024, pixelRatio: 1.0, label: 'Medium' },
  high: { shadows: true, shadowMap: 2048, pixelRatio: 1.5, label: 'High' },
};

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { /* storage unavailable */ }
  return null;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

class Game {
  constructor() {
    this.vehicles = [];
    this.characters = [];
    this.time = 0;
    this.paused = true;
    this.started = false;
    this.night = 0;
    this.settings = { mouseSens: Number(store('nc_sens')) || 1, invertY: store('nc_inv') === '1', quality: store('nc_q') || 'high' };
    if (!QUALITY[this.settings.quality]) this.settings.quality = 'high';
    this.acc = 0;
    this.deathT = 0;
    this.godMode = false;
  }

  setLoading(p, text) {
    const bar = document.getElementById('load-fill');
    const t = document.getElementById('load-text');
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    if (t && text) t.textContent = text;
  }

  async init() {
    const q = QUALITY[this.settings.quality];
    this.quality = q;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!window.__NC_TEST });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('game').appendChild(renderer.domElement);
    this.renderer = renderer;
    setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.input = new Input(renderer.domElement);
    window.addEventListener('resize', () => this.onResize());

    this.setLoading(0.08, 'Starting physics…');
    await nextFrame();
    this.physics = new Physics();
    await this.physics.init();
    this.physics.prePhysics.push((h) => this.prePhysics(h));
    this.physics.impactListeners.push((...a) => this.onImpact(...a));

    this.setLoading(0.25, 'Building the city…');
    await nextFrame();
    this.city = new City(this.scene, this.physics);
    this.city.build();

    this.setLoading(0.55, 'Lighting & ocean…');
    await nextFrame();
    this.env = new Environment(renderer, this.scene);
    this.env.onChange = (p) => this.onTimeOfDay(p);
    this.env.build(q);

    this.effects = new Effects(this.scene);
    this.props = new Props(this);
    this.props.spawnAll(this.city.props);
    this.audio = new AudioSys();

    this.setLoading(0.7, 'Spawning people and cars…');
    await nextFrame();
    // player
    const sp = this.city.playerSpawn();
    const pc = new Character(this, PLAYER_APPEARANCE, { player: true });
    this.addCharacter(pc);
    pc.teleport(_v.set(sp.x, sp.y, sp.z), -0.7);
    this.player = new PlayerController(this, pc);
    // the player's first ride, parked right next to the spawn
    const car = this.addVehicle('sport', '#ff2d6f', _v.set(5.7, 0.06, 27), Math.PI, { persistent: true });
    this.player.lastVehicle = car;
    this.parked = new ParkedCars(this);
    this.parked.update(true);
    this.traffic = new TrafficManager(this);
    this.peds = new PedManager(this);
    this.camRig = new CameraRig(this.camera, this);
    this.camRig.yaw = -0.7;
    this.hud = new HUD(this);
    this.explosions = new Explosions(this);
    // warm-up: prefill traffic & peds around the player
    for (let i = 0; i < 7; i++) this.traffic.trySpawn(25, 150);
    for (let i = 0; i < 18; i++) this.peds.spawn(6, 80);
    this.setLoading(0.9, 'Compiling shaders…');
    await nextFrame();
    this.camRig.update(0.016, this.input);
    renderer.compile(this.scene, this.camera);
    this.setLoading(1, 'Ready');
    this.clock = new THREE.Timer();
    this.clock.connect?.(document);
    this.bindUI();
    this.loop = this.loop.bind(this);
    if (!window.__NC_TEST) requestAnimationFrame(this.loop);
    window.__game = this;
    if (window.__NC_TEST) window.__mods = { EnterSequence, ExitSequence, Character, Vehicle, randomAppearance, THREE };
  }

  /* ---------------------------------------------------------------- entities */
  addVehicle(type, color, pos, yaw, opts = {}) {
    const v = new Vehicle(this, type, color, pos, yaw, opts);
    this.vehicles.push(v);
    return v;
  }
  removeVehicle(v) {
    if (v.driver && !v.driver.isPlayer) this.removeCharacter(v.driver);
    v.remove();
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }
  addCharacter(c) { this.characters.push(c); return c; }
  removeCharacter(c) {
    if (c.isPlayer) return;
    c.remove();
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
  }

  /* ---------------------------------------------------------------- events */
  onImpact(o1, o2, impulse, point, dir) {
    const pc = this.player.character;
    let crashed = false;
    for (const [a, b] of [[o1, o2], [o2, o1]]) {
      if (!a) continue;
      if (a.type === 'car') {
        const v = a.vehicle;
        if (b && b.type === 'ragdoll') {
          // hitting bodies: a thump, no dents
          if (impulse > 300) this.audio.thud(point, Math.min(1.5, impulse / 900));
          continue;
        }
        v.applyDamage(point, impulse, b);
        if (!crashed && impulse > 900) {
          crashed = true;
          this.audio.crash(point, impulse);
          if (impulse > 3500) this.effects.sparkBurst(point, dir, Math.min(40, 8 + impulse / 800), 5);
          if (v.health < 60 && impulse > 9000 && Math.random() < 0.5) { this.effects.glass(point, 0.6); this.audio.glass(point); }
        } else if (!crashed && impulse > 150) {
          this.audio.scrape(point, Math.min(1, impulse / 900));
          if (Math.random() < 0.3) this.effects.sparkBurst(point, dir, 4, 3);
        }
        if (v.driver === pc) this.camRig.shake(Math.min(0.7, impulse / 30000));
        if (b && b.type === 'lamp' && impulse > 1200) {
          const vel = v.linvel(_v2);
          vel.y = 0;
          vel.normalize();
          this.props.breakLamp(b.lamp, vel, impulse);
        }
        if (b && b.type === 'hydrant' && impulse > 1200) {
          const br = this.city.breakables.find((x) => x.kind === 'hydrant' && x.collider === undefined) || null;
          void br;
          if (!b.broken) {
            b.broken = true;
            this.effects.waterJet(point.clone().setY(0.4), 18);
            this.audio.metalHit(point, 0.8);
          }
        }
        if (v.ai && b && b.type === 'car' && b.vehicle.driver === pc && impulse > 2500) {
          v.ai.panic = 10;
          this.audio.horn(v.curPos, 1);
        }
      } else if (a.type === 'ragdoll') {
        const ch = a.char;
        if (impulse > 160) {
          const fromCar = b && b.type === 'car';
          ch.damage((impulse - 160) / (fromCar ? 9 : 14), fromCar ? 'car' : 'impact');
          if (!fromCar) this.audio.thud(point, Math.min(1, impulse / 600));
          if (impulse > 500 && Math.random() < 0.4) this.effects.dust(point, 1);
        }
      } else if (a.type === 'prop' && impulse > 200) {
        if (!b || b.type !== 'car') this.audio.thud(point, Math.min(0.6, impulse / 1500));
      }
    }
  }

  resolvePunch(attacker) {
    const f = _v.set(Math.sin(attacker.yaw), 0, Math.cos(attacker.yaw));
    let hit = null, best = 1.4;
    for (const c of this.characters) {
      if (c === attacker || (c.state !== 'foot' && c.state !== 'getup' && c.state !== 'seq')) continue;
      const dx = c.pos.x - attacker.pos.x, dz = c.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > best || d < 0.01) continue;
      if ((dx * f.x + dz * f.z) / d < 0.45) continue;
      hit = c; best = d;
    }
    if (!hit) return;
    const dir = _v2.set(hit.pos.x - attacker.pos.x, 0, hit.pos.z - attacker.pos.z).normalize();
    this.audio.punchHit(hit.pos);
    hit.damage(16 + Math.random() * 10, 'punch', attacker);
    if (hit.state === 'seq' && hit.seq && hit.seq.abort) hit.seq.abort('punched');
    if (!hit.alive || hit.health < 55 || Math.random() < 0.4) {
      _v.copy(dir).multiplyScalar(3.4);
      _v.y = 1.6;
      hit.toRagdoll(_v, { spin: 1.2 });
    } else {
      hit.pushVel.addScaledVector(dir, 3.2);
    }
    if (hit.ai && hit.alive) {
      if (attacker.isPlayer && hit.ai.mode !== 'fight' && Math.random() < 0.35) hit.ai.fight(attacker);
      else if (hit.ai.mode !== 'fight') hit.ai.flee(attacker.pos, 9);
    }
    if (attacker.isPlayer) this.peds.panic(hit.pos, 14, attacker.pos);
  }

  onPedHit(ch, veh, speed) {
    this.peds.panic(ch.pos, 22, veh.curPos);
    if (veh.driver === this.player.character) this.camRig.shake(Math.min(0.3, speed / 60));
  }

  onJacked(occ, attacker, veh) {
    this.peds.adopt(occ, Math.random() < 0.3 ? 'fight' : 'flee', Math.random() < 0.3 ? attacker : attacker.pos.clone());
    if (occ.ai && occ.ai.mode === 'flee') occ.ai.threat.copy(attacker.pos);
    this.peds.panic(veh.curPos, 12, attacker.pos);
    const ti = this.traffic.cars.indexOf(veh);
    void ti;
  }

  onEnteredVehicle(ch, veh) {
    if (!ch.isPlayer) return;
    this.player.lastVehicle = veh;
    veh.persistent = true;
    if (veh.ai) { veh.ai.disable(); veh.ai = null; }
    this.hud.vehicleName(`${veh.T.label} · ${veh.model.plate}`);
  }

  onExitedVehicle(ch, veh) {
    void ch; void veh;
  }

  onCharacterDied(ch, cause) {
    if (ch.isPlayer) {
      this.deathT = 0.001;
      return;
    }
    this.peds.panic(ch.pos, 25, ch.pos);
    void cause;
  }

  onGotUp(ch) { void ch; }

  onShove(a, b) {
    if (b.ai && b.alive && Math.random() < 0.4 && a.isPlayer) b.ai.fight(a);
  }

  onTimeOfDay(p) {
    this.night = p.night;
    const city = this.city;
    for (const m of city.facadeMats) m.emissiveIntensity = p.night ? 0.85 : 0;
    city.mats.lampGlow.emissiveIntensity = p.night ? 5 : 0.25;
    for (const [k, m] of Object.entries(city.mats)) if (k.startsWith('neon_')) m.opacity = p.night ? 1 : 0.55;
    if (this.headlights) this.headlights.visible = !!p.night;
    if (this.nightPool) for (const l of this.nightPool) l.visible = !!p.night;
  }

  /* ---------------------------------------------------------------- loop */
  prePhysics(h) {
    for (const v of this.vehicles) v.prePhysics(h);
    for (const c of this.characters) if (c.ragdoll.active) c.ragdoll.prePhysics(h);
  }

  loop() {
    requestAnimationFrame(this.loop);
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.frame(dt);
  }

  /** Test hook: advance n frames deterministically, rendering only the last one. */
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      this.skipRender = i < n - 1;
      this.frame(dt);
    }
    this.skipRender = false;
  }

  frame(dt) {
    const input = this.input;
    input.pollGamepad();
    if (input.hit('Escape') && !input.locked) this.togglePause(true);
    if (input.gamepad && input.gamepad.pressed('start')) this.togglePause(!this.paused);
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      input.endFrame();
      return;
    }
    this.time += dt;
    this.autoQuality();
    if (input.hit('KeyN')) { this.env.cycle(); this.hud.message(`Time: ${this.env.presetName}`, 1.5); }
    if (input.hit('KeyM')) { this.audio.radioOn = !this.audio.radioOn; this.hud.message(this.audio.radioOn ? '📻 Radio ON' : '📻 Radio OFF', 1.2); }
    if (input.hit('F3') || input.hit('KeyP')) this.hud.showFps = !this.hud.showFps;
    if (input.hit('F2')) this.cycleQuality();

    this.player.update(dt);
    this.traffic.update(dt);
    this.peds.update(dt);
    this.parked.update(false);

    // fixed-step physics
    const h = this.physics.h;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= h && steps < 5) {
      this.physics.step();
      this.acc -= h;
      steps++;
    }
    if (steps >= 5) this.acc = 0;

    for (const v of this.vehicles) { v.update(dt); v.syncVisual(); }
    // characters far from the camera are animated at half rate
    this.frameNo = (this.frameNo || 0) + 1;
    const camP = this.camera.position;
    for (const c of this.characters) {
      c.lodAcc = (c.lodAcc || 0) + dt;
      const cd2 = camP.distanceToSquared(c.pos);
      const shadowOn = c.isPlayer || cd2 < 40 * 40;
      if (c.rig.mesh.castShadow !== shadowOn) c.rig.mesh.castShadow = shadowOn;
      const far = !c.isPlayer && c.state !== 'ragdoll' && c.state !== 'seq' && cd2 > 45 * 45;
      if (far && ((this.frameNo + c.id) & 1)) continue;
      c.update(Math.min(c.lodAcc, 0.1));
      c.lodAcc = 0;
    }
    this.vehicleFX(dt);
    this.explosions.update(dt);
    this.props.update();
    this.city.update(this.time, dt);
    const pc = this.player.character;
    this.env.update(dt, pc.ragdoll.active ? pc.ragdoll.hipsPosition(_v) : pc.pos);
    this.camRig.update(dt, input);
    this.updateNightLights();
    this.audio.setListener(this.camera);
    this.audio.update(dt, this);
    this.effects.update(dt, this.camera, this.scene, this.renderer.domElement.height);
    this.hud.update(dt);
    this.updateDeath(dt);
    if (!this.skipRender) this.renderer.render(this.scene, this.camera);
    input.endFrame();
  }

  vehicleFX(dt) {
    const cam = this.camera.position;
    for (const v of this.vehicles) {
      if (v.removed) continue;
      const d2 = v.curPos.distanceToSquared(cam);
      if (d2 > 150 * 150) continue;
      const vel = v.linvel(_v);
      for (const w of v.wheels) {
        if (w.grounded && w.skidding > 0.12) {
          if (Math.random() < w.skidding * dt * 32) this.effects.tireSmoke(w.contact, vel, w.skidding, w.surface);
          if (w.surface === 'asphalt' || w.surface === 'concrete') {
            if (w.lastSkidPos) {
              if (w.lastSkidPos.distanceToSquared(w.contact) > 0.04) {
                this.effects.skids.add(w.lastSkidPos, w.contact, v.T.wheelW * 0.95, Math.min(0.85, w.skidding * 1.2));
                w.lastSkidPos.copy(w.contact);
              }
            } else w.lastSkidPos = w.contact.clone();
          }
        } else w.lastSkidPos = null;
      }
      if (v.health < 40 && v.health > 0 && Math.random() < dt * (v.health < 15 ? 25 : 10)) {
        v.localToWorld(_v2.set(0, v.T.beltY + 0.05, v.halfL - 0.7), _v2);
        this.effects.engineSmoke(_v2, v.health < 15);
      }
    }
  }

  updateNightLights() {
    if (!this.night) return;
    if (!this.headlights) {
      this.headlights = new THREE.Group();
      for (const s of [1, -1]) {
        const l = new THREE.SpotLight(0xfff1d6, 4000, 90, 0.52, 0.5, 2);
        l.position.set(s * 0.6, 0.7, 2.3);
        l.target.position.set(s * 0.6, 0.0, 14);
        l.castShadow = false;
        this.headlights.add(l, l.target);
      }
      this.scene.add(this.headlights);
      this.nightPool = [];
      for (let i = 0; i < 8; i++) {
        const pl = new THREE.PointLight(0xffc880, 400, 32, 2);
        this.scene.add(pl);
        this.nightPool.push(pl);
      }
      this.nightPoolT = 0;
    }
    const pc = this.player.character;
    const veh = pc.state === 'vehicle' ? pc.vehicle : null;
    this.headlights.visible = !!veh && !veh.headBroken;
    if (veh) {
      this.headlights.position.copy(veh.curPos);
      this.headlights.quaternion.copy(veh.curQuat);
      this.headlights.children[0].position.set(veh.halfW - 0.3, veh.T.noseY - 0.1, veh.halfL - 0.2);
      this.headlights.children[2].position.set(-veh.halfW + 0.3, veh.T.noseY - 0.1, veh.halfL - 0.2);
    }
    this.nightPoolT -= 1 / 60;
    if (this.nightPoolT <= 0) {
      this.nightPoolT = 0.5;
      const p = this.camera.position;
      const lights = this.city.nightLights.slice().sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
      for (let i = 0; i < this.nightPool.length; i++) {
        const L = lights[i];
        const pl = this.nightPool[i];
        if (!L) { pl.visible = false; continue; }
        pl.visible = true;
        pl.position.set(L.x, L.y - (L.lamp ? 0.4 : 0), L.z);
        pl.color.set(L.color);
        pl.intensity = L.lamp ? 650 : 160;
      }
    }
  }

  updateDeath(dt) {
    if (!this.deathT) return;
    this.deathT += dt;
    const w = document.getElementById('wasted');
    if (this.deathT > 1.2) {
      w.style.opacity = 1;
      this.renderer.domElement.style.filter = 'grayscale(0.85) contrast(1.1)';
    }
    if (this.deathT > 5.5) {
      this.deathT = 0;
      w.style.opacity = 0;
      this.renderer.domElement.style.filter = '';
      const pc = this.player.character;
      pc.ragdoll.deactivate();
      pc.health = pc.maxHealth;
      pc.alive = true;
      pc.state = 'foot';
      pc.seq = null;
      pc.blend = null;
      pc.clearHands();
      pc.setCapsuleEnabled(true);
      const sp = this.city.playerSpawn();
      pc.teleport(_v.set(sp.x, sp.y + 0.05, sp.z), sp.yaw);
      this.hud.message('Respawned · دوباره زنده شدی', 2);
    }
  }

  /* ---------------------------------------------------------------- ui */
  bindUI() {
    const menu = document.getElementById('menu');
    const start = document.getElementById('start');
    const canvas = this.renderer.domElement;
    document.getElementById('loading').style.display = 'none';
    start.style.display = 'block';
    const go = () => {
      this.audio.resume();
      this.input.requestLock();
      this.togglePause(false);
    };
    start.addEventListener('click', go);
    canvas.addEventListener('click', () => { if (!this.paused && !this.input.locked) this.input.requestLock(); });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.started && !window.__NC_TEST) this.togglePause(true);
    });
    const sens = document.getElementById('sens');
    sens.value = this.settings.mouseSens;
    sens.addEventListener('input', () => { this.settings.mouseSens = Number(sens.value); store('nc_sens', sens.value); });
    const inv = document.getElementById('invert');
    inv.checked = this.settings.invertY;
    inv.addEventListener('change', () => { this.settings.invertY = inv.checked; store('nc_inv', inv.checked ? '1' : '0'); });
    const qb = document.getElementById('quality');
    qb.textContent = `Graphics: ${this.quality.label}`;
    qb.addEventListener('click', (e) => { e.stopPropagation(); this.cycleQuality(); qb.textContent = `Graphics: ${this.quality.label}`; });
    const mb = document.getElementById('mute');
    mb.addEventListener('click', (e) => { e.stopPropagation(); this.audio.resume(); this.audio.setMuted(!this.audio.muted); mb.textContent = this.audio.muted ? 'Sound: OFF' : 'Sound: ON'; });
    void menu;
  }

  togglePause(p) {
    this.paused = p;
    const menu = document.getElementById('menu');
    menu.style.display = p ? 'flex' : 'none';
    if (!p) {
      this.started = true;
      document.getElementById('start').textContent = 'Continue · ادامه';
      this.clock.update();
    }
  }

  cycleQuality() {
    const order = ['low', 'medium', 'high'];
    this.setQuality(order[(order.indexOf(this.settings.quality) + 1) % 3]);
  }

  setQuality(k) {
    this.settings.quality = k;
    store('nc_q', k);
    const q = QUALITY[k];
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.env.sun.castShadow = q.shadows;
    if (this.env.sun.shadow.map) { this.env.sun.shadow.map.dispose(); this.env.sun.shadow.map = null; }
    this.env.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.needsUpdate = true; } });
    this.hud?.message(`Graphics: ${q.label}`, 1.5);
    const qb = document.getElementById('quality');
    if (qb) qb.textContent = `Graphics: ${q.label}`;
  }

  /** Measures the first seconds of play (wall clock) and steps quality down on slow machines. */
  autoQuality() {
    if (this.autoQDone || window.__NC_TEST) return;
    const now = performance.now();
    if (!this.autoQStart) { this.autoQStart = now; this.autoQN = 0; return; }
    const el = (now - this.autoQStart) / 1000;
    if (el < 2) { this.autoQN = 0; this.autoQMeasure = now; return; } // skip warm-up
    this.autoQN++;
    if (el > 8) {
      const fps = this.autoQN / ((now - this.autoQMeasure) / 1000);
      const order = ['low', 'medium', 'high'];
      const i = order.indexOf(this.settings.quality);
      if (fps < 32 && i > 0) {
        this.setQuality(order[i - 1]);
        this.hud.message(`Auto graphics: ${QUALITY[order[i - 1]].label} (${fps.toFixed(0)} FPS)`, 3);
        this.autoQStart = now;
        if (i - 1 === 0) this.autoQDone = true;
      } else this.autoQDone = true;
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

/** Streams parked cars in and out around the player. */
class ParkedCars {
  constructor(game) {
    this.game = game;
    this.spots = game.city.parkingSpots.map((s) => ({ ...s, veh: null }));
    this.rng = makeRng(99);
    this.t = 0;
    const types = ['sedan', 'sedan', 'suv', 'sport', 'muscle', 'taxi', 'sedan', 'suv'];
    for (const s of this.spots) s.type = this.rng.pick(types);
  }
  update(force) {
    this.t -= 1 / 60;
    if (this.t > 0 && !force) return;
    this.t = 0.5;
    const g = this.game;
    const p = g.player.character.pos;
    let active = this.spots.filter((s) => s.veh && !s.veh.removed).length;
    for (const s of this.spots) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (!s.veh && d < 85 && active < 16) {
        // avoid spawning into something
        let clear = true;
        for (const v of g.vehicles) if ((v.curPos.x - s.x) ** 2 + (v.curPos.z - s.z) ** 2 < 9) { clear = false; break; }
        if (!clear) continue;
        s.veh = g.addVehicle(s.type, null, _v.set(s.x, s.y + 0.06, s.z), s.yaw);
        s.veh.parkedSpot = s;
        active++;
      } else if (s.veh && d > 130) {
        const v = s.veh;
        if (v.removed) { s.veh = null; continue; }
        if (v === g.player.lastVehicle || v.driver) { s.veh = null; continue; }
        g.removeVehicle(v);
        s.veh = null;
        active--;
      } else if (s.veh && s.veh.removed) s.veh = null;
    }
  }
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

const game = new Game();
game.init().catch((e) => {
  console.error(e);
  const t = document.getElementById('load-text');
  if (t) t.textContent = 'Error: ' + (e && e.message ? e.message : e);
});

export { CITY, G, clamp };
