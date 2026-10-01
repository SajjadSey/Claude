import * as THREE from 'three';
import { clamp, lerp } from '../core/util.js';

const _v = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Fully synthesized sound: no audio files. Engine, tyres, impacts, footsteps, doors, horn,
 * ambience and a little synthwave radio.
 */
export class AudioSys {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listener = new THREE.Vector3();
    this.listenerRight = new THREE.Vector3(1, 0, 0);
    this.muted = false;
    this.radioOn = true;
    this.lastPlay = new Map();
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.0;
    this.musicBus.connect(this.master);
    // noise buffers
    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
    const bb = ctx.createBuffer(1, len, ctx.sampleRate);
    const bd = bb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
    this.brown = bb;
    this.makeEngine();
    this.makeTires();
    this.makeAmbience();
    this.makeRadio();
    this.ready = true;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  setListener(camera) {
    this.listener.copy(camera.position);
    this.listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  }

  /** gain & pan for a world position */
  spatial(pos, ref = 8, max = 120) {
    const d = this.listener.distanceTo(pos);
    if (d > max) return null;
    const g = ref / Math.max(ref, d);
    _v.copy(pos).sub(this.listener);
    const pan = d > 0.01 ? clamp(_v.dot(this.listenerRight) / d, -1, 1) * 0.8 : 0;
    return { g: g * (1 - d / max), pan };
  }

  out(gain, pan) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfx);
    } else g.connect(this.sfx);
    return g;
  }

  throttleKey(key, minDt) {
    const now = this.ctx.currentTime;
    const l = this.lastPlay.get(key) || 0;
    if (now - l < minDt) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  noiseBurst(pos, { dur = 0.1, type = 'lowpass', freq = 1000, q = 1, gain = 0.5, attack = 0.002, rate = 1, ref = 8, max = 100, sweep = 0 }) {
    if (!this.ready || this.muted) return;
    const sp = pos ? this.spatial(pos, ref, max) : { g: 1, pan: 0 };
    if (!sp || sp.g < 0.01) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * sp.g, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this.out(1, sp.pan));
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  tone(pos, { freq = 100, type = 'sine', dur = 0.2, gain = 0.5, slide = 0.5, ref = 8, max = 100, attack = 0.003 }) {
    if (!this.ready || this.muted) return;
    const sp = pos ? this.spatial(pos, ref, max) : { g: 1, pan: 0 };
    if (!sp || sp.g < 0.01) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * sp.g, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(env).connect(this.out(1, sp.pan));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /* ------------------------------------------------------------- one-shots */
  footstep(pos, intensity = 1, isPlayer = false) {
    if (!this.ready) return;
    const k = isPlayer ? 1 : 0.6;
    this.noiseBurst(pos, { dur: 0.07 + 0.03 * intensity, type: 'bandpass', freq: 700 + Math.random() * 500, q: 0.9, gain: 0.16 * intensity * k, ref: 3, max: 30 });
    this.noiseBurst(pos, { dur: 0.05, type: 'lowpass', freq: 220, q: 0.7, gain: 0.22 * intensity * k, ref: 3, max: 25 });
  }
  jump(pos) { this.noiseBurst(pos, { dur: 0.12, type: 'bandpass', freq: 500, q: 1, gain: 0.12, ref: 3, max: 25 }); }
  whoosh(pos) { this.noiseBurst(pos, { dur: 0.22, type: 'bandpass', freq: 900, q: 2, gain: 0.25, sweep: 2.5, ref: 3, max: 25 }); }
  punchHit(pos) {
    this.tone(pos, { freq: 110, dur: 0.15, gain: 0.7, slide: 0.4, ref: 4 });
    this.noiseBurst(pos, { dur: 0.09, type: 'lowpass', freq: 1400, gain: 0.5, ref: 4 });
  }
  bodyHit(pos, speed = 8) {
    if (!this.ready || !this.throttleKey('body', 0.05)) return;
    const k = clamp(speed / 15, 0.3, 1.4);
    this.tone(pos, { freq: 85, dur: 0.25, gain: 0.9 * k, slide: 0.5, ref: 6 });
    this.noiseBurst(pos, { dur: 0.18, type: 'lowpass', freq: 900, gain: 0.7 * k, ref: 6 });
    this.noiseBurst(pos, { dur: 0.08, type: 'bandpass', freq: 2400, q: 1.5, gain: 0.25 * k, ref: 6 });
  }
  thud(pos, k = 1) {
    if (!this.ready || !this.throttleKey('thud', 0.04)) return;
    this.tone(pos, { freq: 70 + Math.random() * 30, dur: 0.16, gain: 0.45 * k, slide: 0.5, ref: 5, max: 60 });
    this.noiseBurst(pos, { dur: 0.08, type: 'lowpass', freq: 600, gain: 0.35 * k, ref: 5, max: 60 });
  }
  crash(pos, impulse) {
    if (!this.ready || !this.throttleKey('crash', 0.06)) return;
    const k = clamp(Math.log10(Math.max(10, impulse)) - 2.8, 0.1, 1.6);
    this.tone(pos, { freq: 55 + Math.random() * 20, dur: 0.45, gain: 0.9 * k, slide: 0.45, ref: 10, max: 160 });
    this.noiseBurst(pos, { dur: 0.35 + k * 0.25, type: 'lowpass', freq: 1700, gain: 0.95 * k, ref: 10, max: 160 });
    this.noiseBurst(pos, { dur: 0.2 + k * 0.2, type: 'bandpass', freq: 3200 + Math.random() * 1500, q: 3, gain: 0.45 * k, ref: 10, max: 160 });
    // metallic ring
    this.tone(pos, { freq: 600 + Math.random() * 500, type: 'triangle', dur: 0.35, gain: 0.12 * k, slide: 0.92, ref: 10, max: 120 });
  }
  scrape(pos, k = 1) {
    if (!this.ready || !this.throttleKey('scrape', 0.07)) return;
    this.noiseBurst(pos, { dur: 0.12, type: 'bandpass', freq: 2600 + Math.random() * 1500, q: 4, gain: 0.25 * k, ref: 8 });
  }
  glass(pos) {
    if (!this.ready) return;
    for (let i = 0; i < 9; i++) {
      setTimeout(() => this.tone(pos, { freq: 2500 + Math.random() * 4000, type: 'sine', dur: 0.12 + Math.random() * 0.2, gain: 0.08, slide: 0.98, ref: 8 }), i * 18 + Math.random() * 40);
    }
    this.noiseBurst(pos, { dur: 0.3, type: 'highpass', freq: 3500, gain: 0.4, ref: 8 });
  }
  metalHit(pos, k = 1) {
    this.tone(pos, { freq: 320, type: 'triangle', dur: 0.8, gain: 0.25 * k, slide: 0.97, ref: 10 });
    this.tone(pos, { freq: 811, type: 'sine', dur: 0.6, gain: 0.12 * k, slide: 0.99, ref: 10 });
    this.noiseBurst(pos, { dur: 0.15, type: 'lowpass', freq: 1200, gain: 0.5 * k, ref: 10 });
  }
  doorOpen(pos) {
    this.noiseBurst(pos, { dur: 0.04, type: 'highpass', freq: 2500, gain: 0.35, ref: 4 });
    this.tone(pos, { freq: 900, type: 'square', dur: 0.03, gain: 0.05, slide: 0.8, ref: 4 });
  }
  doorSlam(pos, k = 1) {
    if (!this.ready || !this.throttleKey('slam', 0.1)) return;
    this.tone(pos, { freq: 95, dur: 0.22, gain: 0.8 * k, slide: 0.55, ref: 5 });
    this.noiseBurst(pos, { dur: 0.12, type: 'lowpass', freq: 1100, gain: 0.6 * k, ref: 5 });
    this.noiseBurst(pos, { dur: 0.03, type: 'highpass', freq: 3000, gain: 0.25 * k, ref: 5 });
  }
  seat(pos) { this.noiseBurst(pos, { dur: 0.15, type: 'lowpass', freq: 400, gain: 0.3, ref: 4 }); }
  grunt(pos, female) {
    if (!this.ready || !this.throttleKey('grunt', 0.15)) return;
    this.tone(pos, { freq: female ? 330 : 150, type: 'sawtooth', dur: 0.18, gain: 0.08, slide: 0.7, ref: 5, max: 40 });
  }
  shout(pos, female) {
    if (!this.ready) return;
    const f0 = female ? 380 : 190;
    this.tone(pos, { freq: f0, type: 'sawtooth', dur: 0.35, gain: 0.07, slide: 1.25, ref: 5, max: 50 });
    setTimeout(() => this.tone(pos, { freq: f0 * 1.2, type: 'sawtooth', dur: 0.3, gain: 0.06, slide: 0.8, ref: 5, max: 50 }), 220);
  }
  horn(pos, k = 1) {
    if (!this.ready || this.muted) return;
    const sp = this.spatial(pos, 10, 200);
    if (!sp) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.out(1, sp.pan);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.13 * sp.g * k, t + 0.02);
    env.gain.setValueAtTime(0.13 * sp.g * k, t + 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    for (const fr of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = fr;
      o.connect(f);
      o.start(t); o.stop(t + 0.55);
    }
    f.connect(env).connect(out);
  }

  /* ------------------------------------------------------------- continuous: player engine */
  makeEngine() {
    const ctx = this.ctx;
    const e = {};
    e.out = ctx.createGain();
    e.out.gain.value = 0;
    e.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (e.pan) e.out.connect(e.pan).connect(this.sfx); else e.out.connect(this.sfx);
    e.filter = ctx.createBiquadFilter();
    e.filter.type = 'lowpass';
    e.filter.frequency.value = 800;
    e.filter.Q.value = 2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.5); }
    shaper.curve = curve;
    e.filter.connect(shaper).connect(e.out);
    e.o1 = ctx.createOscillator(); e.o1.type = 'sawtooth';
    e.o2 = ctx.createOscillator(); e.o2.type = 'square';
    e.o3 = ctx.createOscillator(); e.o3.type = 'sawtooth';
    e.g1 = ctx.createGain(); e.g1.gain.value = 0.5;
    e.g2 = ctx.createGain(); e.g2.gain.value = 0.25;
    e.g3 = ctx.createGain(); e.g3.gain.value = 0.18;
    e.o1.connect(e.g1).connect(e.filter);
    e.o2.connect(e.g2).connect(e.filter);
    e.o3.connect(e.g3).connect(e.filter);
    // combustion rumble noise modulated
    e.nsrc = ctx.createBufferSource(); e.nsrc.buffer = this.brown; e.nsrc.loop = true;
    e.nf = ctx.createBiquadFilter(); e.nf.type = 'bandpass'; e.nf.frequency.value = 200; e.nf.Q.value = 1.2;
    e.ng = ctx.createGain(); e.ng.gain.value = 0.3;
    e.nsrc.connect(e.nf).connect(e.ng).connect(e.filter);
    e.o1.start(); e.o2.start(); e.o3.start(); e.nsrc.start();
    this.engine = e;
  }

  makeTires() {
    const ctx = this.ctx;
    const t = {};
    t.src = ctx.createBufferSource(); t.src.buffer = this.noise; t.src.loop = true;
    t.f = ctx.createBiquadFilter(); t.f.type = 'bandpass'; t.f.frequency.value = 1100; t.f.Q.value = 6;
    t.f2 = ctx.createBiquadFilter(); t.f2.type = 'peaking'; t.f2.frequency.value = 2200; t.f2.Q.value = 4; t.f2.gain.value = 8;
    t.g = ctx.createGain(); t.g.gain.value = 0;
    t.src.connect(t.f).connect(t.f2).connect(t.g).connect(this.sfx);
    t.src.start();
    // rolling road noise
    t.rsrc = ctx.createBufferSource(); t.rsrc.buffer = this.brown; t.rsrc.loop = true;
    t.rf = ctx.createBiquadFilter(); t.rf.type = 'lowpass'; t.rf.frequency.value = 400;
    t.rg = ctx.createGain(); t.rg.gain.value = 0;
    t.rsrc.connect(t.rf).connect(t.rg).connect(this.sfx);
    t.rsrc.start();
    this.tires = t;
  }

  makeAmbience() {
    const ctx = this.ctx;
    const a = {};
    a.src = ctx.createBufferSource(); a.src.buffer = this.brown; a.src.loop = true;
    a.f = ctx.createBiquadFilter(); a.f.type = 'lowpass'; a.f.frequency.value = 500;
    a.g = ctx.createGain(); a.g.gain.value = 0.05;
    a.src.connect(a.f).connect(a.g).connect(this.sfx);
    a.src.start();
    // wind
    a.wsrc = ctx.createBufferSource(); a.wsrc.buffer = this.noise; a.wsrc.loop = true;
    a.wf = ctx.createBiquadFilter(); a.wf.type = 'bandpass'; a.wf.frequency.value = 600; a.wf.Q.value = 0.6;
    a.wg = ctx.createGain(); a.wg.gain.value = 0;
    a.wsrc.connect(a.wf).connect(a.wg).connect(this.sfx);
    a.wsrc.start();
    // surf
    a.ssrc = ctx.createBufferSource(); a.ssrc.buffer = this.brown; a.ssrc.loop = true;
    a.sf = ctx.createBiquadFilter(); a.sf.type = 'lowpass'; a.sf.frequency.value = 900;
    a.sg = ctx.createGain(); a.sg.gain.value = 0;
    a.ssrc.connect(a.sf).connect(a.sg).connect(this.sfx);
    a.ssrc.start();
    this.amb = a;
    this.gullT = 3;
  }

  /** Per-frame update for continuous sounds. */
  update(dt, game) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const ch = game.player.character;
    const veh = ch.vehicle && (ch.state === 'vehicle' || ch.state === 'seq') ? ch.vehicle : null;
    const e = this.engine;
    if (veh && !veh.removed) {
      const rpm = veh.rpm;
      const thr = veh.effThrottle || 0;
      const fire = rpm / 60 * (veh.T.label === 'Muscle' ? 4 : 3); // firing frequency
      e.o1.frequency.setTargetAtTime(fire, t, 0.03);
      e.o2.frequency.setTargetAtTime(fire * 0.5, t, 0.03);
      e.o3.frequency.setTargetAtTime(fire * 2.01, t, 0.03);
      e.nf.frequency.setTargetAtTime(fire * 1.5, t, 0.05);
      e.filter.frequency.setTargetAtTime(300 + thr * 1800 + rpm * 0.18, t, 0.05);
      const on = veh.engineOn && veh.health > 0 ? 1 : 0;
      e.out.gain.setTargetAtTime((0.09 + thr * 0.14) * on, t, 0.05);
      const tr = this.tires;
      const slip = clamp(veh.wheelSlip * 1.6, 0, 1);
      tr.g.gain.setTargetAtTime(slip * 0.22, t, 0.04);
      tr.f.frequency.setTargetAtTime(900 + slip * 500 + Math.sin(t * 9) * 80, t, 0.05);
      tr.rg.gain.setTargetAtTime(clamp(veh.speed / 40, 0, 1) * 0.12, t, 0.1);
      this.amb.wg.gain.setTargetAtTime(clamp((veh.speed - 10) / 50, 0, 1) * 0.08, t, 0.2);
    } else {
      e.out.gain.setTargetAtTime(0, t, 0.1);
      this.tires.g.gain.setTargetAtTime(0, t, 0.05);
      this.tires.rg.gain.setTargetAtTime(0, t, 0.1);
      this.amb.wg.gain.setTargetAtTime(0, t, 0.3);
    }
    // nearby AI engines contribute to the city hum
    let hum = 0.04;
    for (const v of game.vehicles) {
      if (v === veh || !v.driver) continue;
      const d = v.curPos.distanceTo(this.listener);
      if (d < 40) hum += (1 - d / 40) * 0.03 * clamp(v.speed / 10, 0.3, 1.2);
    }
    this.amb.g.gain.setTargetAtTime(clamp(hum, 0, 0.16), t, 0.3);
    // surf near the beach
    const beachD = Math.abs(this.listener.x - 287);
    this.amb.sg.gain.setTargetAtTime(beachD < 80 ? (1 - beachD / 80) * 0.12 * (0.7 + 0.3 * Math.sin(t * 0.6)) : 0, t, 0.3);
    if (beachD < 90) {
      this.gullT -= dt;
      if (this.gullT <= 0) {
        this.gullT = 4 + Math.random() * 8;
        const p = _r.set(287 + (Math.random() - 0.5) * 40, 10, this.listener.z + (Math.random() - 0.5) * 60);
        for (let k = 0; k < 3; k++) setTimeout(() => this.tone(p, { freq: 1500 + Math.random() * 300, type: 'triangle', dur: 0.18, gain: 0.05, slide: 0.65, ref: 20, max: 140 }), k * 220);
      }
    }
    // radio
    const radioTarget = veh && this.radioOn && ch.state === 'vehicle' ? 0.22 : 0;
    this.musicBus.gain.setTargetAtTime(radioTarget, t, 0.5);
    this.updateRadio(dt, radioTarget > 0);
  }

  /* ------------------------------------------------------------- synthwave radio */
  makeRadio() {
    const ctx = this.ctx;
    this.radio = { step: 0, next: ctx.currentTime + 0.2, bpm: 104, bar: 0 };
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 60 / 104 * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(this.musicBus);
    this.radio.delay = delay;
  }

  updateRadio(dt, playing) {
    const ctx = this.ctx;
    const R = this.radio;
    if (!playing) { R.next = ctx.currentTime + 0.1; return; }
    const spb = 60 / R.bpm / 4; // 16th notes
    const prog = [[45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59], [40, 47, 52, 55]]; // Am F G Em
    while (R.next < ctx.currentTime + 0.12) {
      const t = R.next;
      const s = R.step % 16;
      const chord = prog[Math.floor(R.step / 32) % 4];
      const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
      // drums
      if (s % 4 === 0) this.kick(t);
      if (s === 4 || s === 12) this.snare(t);
      if (s % 2 === 1) this.hat(t);
      // bass (8ths)
      if (s % 2 === 0) this.synth(t, midi(chord[0] - 12), 'sawtooth', spb * 1.6, 0.16, 500, false);
      // arpeggio
      const arp = chord[[0, 1, 2, 3, 2, 1, 2, 3][s % 8]] + 12;
      this.synth(t, midi(arp), 'square', spb * 0.9, 0.05, 2400, true);
      // pad on bar start
      if (R.step % 32 === 0) for (const n of chord.slice(1)) this.synth(t, midi(n), 'sawtooth', spb * 30, 0.025, 1200, true, 0.4);
      R.next += spb;
      R.step++;
    }
  }

  synth(t, f, type, dur, gain, cutoff, toDelay, attack = 0.005) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = type; o2.frequency.value = f * 1.006;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = cutoff; flt.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(flt); o2.connect(flt);
    flt.connect(g).connect(this.musicBus);
    if (toDelay) g.connect(this.radio.delay);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.musicBus);
    o.start(t); o.stop(t + 0.3);
  }
  snare(t) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    s.connect(f).connect(g).connect(this.musicBus);
    g.connect(this.radio.delay);
    s.start(t, Math.random()); s.stop(t + 0.2);
  }
  hat(t) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f).connect(g).connect(this.musicBus);
    s.start(t, Math.random()); s.stop(t + 0.06);
  }
}

export { lerp };
