import * as THREE from 'three';
import { makeRng } from '../core/util.js';

let maxAniso = 8;
export function setMaxAnisotropy(a) { maxAniso = a; }

export function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function toTexture(c, { repeat = true, srgb = true, aniso = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (aniso) t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise on a grid (wraps at `period`). */
function makeNoise(seed, period) {
  const r = makeRng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const at = (x, y) => g[((y % period + period) % period) * period + ((x % period + period) % period)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

function fbmField(size, seed, octaves = 5, base = 4) {
  const out = new Float32Array(size * size);
  const noises = [];
  for (let o = 0; o < octaves; o++) noises.push(makeNoise(seed + o * 17, base << o));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 0.5, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        const f = (base << o) / size;
        sum += noises[o](x * f, y * f) * amp;
        norm += amp; amp *= 0.5;
      }
      out[y * size + x] = sum / norm;
    }
  }
  return out;
}

function fillNoise(ctx, size, seed, colA, colB, octaves = 5, base = 4, contrast = 1) {
  const img = ctx.getImageData(0, 0, size, size);
  const f = fbmField(size, seed, octaves, base);
  for (let i = 0; i < size * size; i++) {
    let t = (f[i] - 0.5) * contrast + 0.5;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    img.data[i * 4] = colA[0] + (colB[0] - colA[0]) * t;
    img.data[i * 4 + 1] = colA[1] + (colB[1] - colA[1]) * t;
    img.data[i * 4 + 2] = colA[2] + (colB[2] - colA[2]) * t;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function speckle(ctx, size, seed, count, colors, minR = 0.5, maxR = 1.6) {
  const r = makeRng(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = r.pick(colors);
    const x = r() * size, y = r() * size, rad = r.range(minR, maxR);
    ctx.fillRect(x, y, rad, rad);
  }
}

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

export function asphaltTexture() {
  return cached('asphalt', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 11, [52, 53, 56], [78, 79, 82], 6, 4, 1.4);
    speckle(ctx, s, 3, 9000, ['#5c5d60', '#2d2e30', '#86868a', '#46474a'], 0.6, 1.8);
    // tar patches & cracks
    const r = makeRng(7);
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = r.chance(0.5) ? '#222326' : '#646468';
      ctx.beginPath();
      ctx.ellipse(r() * s, r() * s, r.range(10, 50), r.range(6, 30), r() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#1d1e20';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 7; i++) {
      let x = r() * s, y = r() * s;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 12; k++) { x += r.range(-14, 14); y += r.range(-14, 14); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return toTexture(c);
  });
}

export function asphaltRoughness() {
  return cached('asphaltRough', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 99, [190, 190, 190], [255, 255, 255], 5, 4, 1.6);
    const t = toTexture(c, { srgb: false });
    return t;
  });
}

export function concreteTexture() {
  return cached('concrete', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 21, [168, 164, 156], [205, 201, 192], 5, 4, 1.2);
    speckle(ctx, s, 22, 5000, ['#9c978d', '#c9c4ba', '#b5b0a6'], 0.5, 1.4);
    // slab joints: 4x4 tiles per texture
    ctx.strokeStyle = 'rgba(90,86,80,0.75)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * s / 4, 0); ctx.lineTo(i * s / 4, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s / 4); ctx.lineTo(s, i * s / 4); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * s / 4 + 2, 0); ctx.lineTo(i * s / 4 + 2, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s / 4 + 2); ctx.lineTo(s, i * s / 4 + 2); ctx.stroke();
    }
    // stains
    const r = makeRng(23);
    ctx.globalAlpha = 0.08;
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = '#3a342c';
      ctx.beginPath(); ctx.arc(r() * s, r() * s, r.range(3, 22), 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    return toTexture(c);
  });
}

export function plainConcreteTexture() {
  return cached('plainConcrete', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 31, [150, 147, 141], [190, 186, 178], 5, 4, 1.1);
    speckle(ctx, s, 32, 1500, ['#8a867e', '#c4c0b6'], 0.5, 1.2);
    return toTexture(c);
  });
}

export function grassTexture() {
  return cached('grass', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 41, [58, 98, 38], [104, 150, 60], 6, 4, 1.5);
    const r = makeRng(42);
    for (let i = 0; i < 22000; i++) {
      const x = r() * s, y = r() * s;
      const g = r.int(80, 170);
      ctx.strokeStyle = `rgba(${g * 0.55 | 0},${g},${g * 0.35 | 0},0.6)`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r.range(-1.5, 1.5), y - r.range(2, 6)); ctx.stroke();
    }
    return toTexture(c);
  });
}

export function sandTexture() {
  return cached('sand', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 51, [205, 186, 145], [238, 222, 184], 6, 4, 1.2);
    speckle(ctx, s, 52, 20000, ['#c9b080', '#f4e6c4', '#b89c6c', '#e8d6aa'], 0.5, 1.3);
    // wind ripples
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = '#7a6440';
    for (let y = 0; y < s; y += 9) {
      ctx.beginPath();
      for (let x = 0; x <= s; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.05 + y) * 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return toTexture(c);
  });
}

export function dirtTexture() {
  return cached('dirt', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 61, [96, 78, 58], [140, 118, 88], 5, 4, 1.4);
    speckle(ctx, s, 62, 4000, ['#5e4a34', '#a48a66'], 0.5, 1.5);
    return toTexture(c);
  });
}

export function roofTexture() {
  return cached('roof', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 71, [110, 108, 104], [150, 148, 142], 5, 4, 1.3);
    speckle(ctx, s, 72, 6000, ['#6e6c68', '#a8a6a0', '#55534f'], 0.5, 1.3);
    ctx.strokeStyle = 'rgba(60,60,60,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * s / 2); ctx.lineTo(s, i * s / 2); ctx.stroke();
    }
    return toTexture(c);
  });
}

/**
 * Building facade. Each texture covers a 2-window x 2-floor cell (8m x 7m).
 * style: 'deco' | 'glass' | 'stucco' | 'brick' | 'hotel'
 */
export function facadeTexture(style, wall, accent, seed = 1) {
  return cached(`facade_${style}_${wall}_${accent}_${seed}`, () => {
    const W = 256, H = 224;
    const c = canvas(W, H), ctx = c.getContext('2d');
    const e = canvas(W, H), ex = e.getContext('2d');
    ex.fillStyle = '#000'; ex.fillRect(0, 0, W, H);
    const r = makeRng(seed * 31 + style.length);
    const wallCol = new THREE.Color(wall);
    const toRGB = (col, k = 1) => `rgb(${Math.min(255, col.r * 255 * k) | 0},${Math.min(255, col.g * 255 * k) | 0},${Math.min(255, col.b * 255 * k) | 0})`;
    // wall base with subtle noise
    ctx.fillStyle = toRGB(wallCol);
    ctx.fillRect(0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const nf = makeNoise(seed + 5, 16);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const n = (nf(x / 16, y / 16) - 0.5) * 18 + (Math.random() - 0.5) * 8;
      const i = (y * W + x) * 4;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);

    const glass = (x, y, w, h, lit) => {
      const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
      if (lit) {
        g.addColorStop(0, '#ffe7b0'); g.addColorStop(1, '#d9a560');
      } else {
        g.addColorStop(0, '#9fb8c8'); g.addColorStop(0.45, '#4d6676'); g.addColorStop(1, '#23323d');
      }
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      // reflection streak
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.15, y); ctx.lineTo(x + w * 0.4, y); ctx.lineTo(x + w * 0.1, y + h); ctx.lineTo(x, y + h * 0.8);
      ctx.closePath(); ctx.fill();
      if (lit) {
        ex.fillStyle = '#ffd59a';
        ex.fillRect(x + 1, y + 1, w - 2, h - 2);
      }
    };

    if (style === 'glass') {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#7fa6bd'); g.addColorStop(0.5, '#3f6378'); g.addColorStop(1, '#5d8aa3');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = toRGB(wallCol, 0.9);
      for (let i = 0; i <= 4; i++) ctx.fillRect(i * W / 4 - 2, 0, 4, H);
      for (let j = 0; j <= 2; j++) ctx.fillRect(0, j * H / 2 - 5, W, 10);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
        if (r.chance(0.18)) {
          ex.fillStyle = 'rgba(255,220,160,0.8)';
          ex.fillRect(i * W / 4 + 3, j * H / 2 + 6, W / 4 - 6, H / 2 - 12);
        }
        ctx.fillStyle = `rgba(255,255,255,${r.range(0.02, 0.12)})`;
        ctx.fillRect(i * W / 4 + 3, j * H / 2 + 6, W / 4 - 6, H / 2 - 12);
      }
    } else if (style === 'deco') {
      // horizontal racing bands + ribbon windows
      for (let j = 0; j < 2; j++) {
        const y0 = j * H / 2;
        ctx.fillStyle = accent;
        ctx.fillRect(0, y0 + H / 2 - 16, W, 6);
        ctx.fillRect(0, y0 + H / 2 - 7, W, 3);
        for (let i = 0; i < 2; i++) {
          const x0 = i * W / 2 + 14, wW = W / 2 - 28, wy = y0 + 22, wh = H / 2 - 50;
          ctx.fillStyle = toRGB(wallCol, 0.75);
          ctx.fillRect(x0 - 4, wy - 4, wW + 8, wh + 8);
          glass(x0, wy, wW, wh, r.chance(0.12));
          ctx.fillStyle = toRGB(wallCol, 1.05);
          ctx.fillRect(x0 + wW / 2 - 2, wy, 4, wh);
          ctx.fillRect(x0, wy + wh * 0.35, wW, 3);
        }
      }
      // vertical pilaster
      ctx.fillStyle = toRGB(wallCol, 1.1);
      ctx.fillRect(W / 2 - 3, 0, 6, H);
    } else if (style === 'hotel') {
      for (let j = 0; j < 2; j++) {
        const y0 = j * H / 2;
        // balcony slab
        ctx.fillStyle = toRGB(wallCol, 1.12);
        ctx.fillRect(0, y0 + H / 2 - 14, W, 10);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, y0 + H / 2 - 4, W, 4);
        for (let i = 0; i < 2; i++) {
          const x0 = i * W / 2 + 10, wW = W / 2 - 20, wy = y0 + 12, wh = H / 2 - 30;
          glass(x0, wy, wW, wh, r.chance(0.15));
          // balcony railing
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 - 2, wy + wh * 0.55, wW + 4, wh * 0.45);
          for (let k = 0; k < 9; k++) {
            ctx.beginPath(); ctx.moveTo(x0 + k * wW / 8, wy + wh * 0.55); ctx.lineTo(x0 + k * wW / 8, wy + wh); ctx.stroke();
          }
        }
      }
    } else if (style === 'brick') {
      // brick pattern
      const bw = 16, bh = 7;
      for (let y = 0; y < H; y += bh) {
        const off = (y / bh) % 2 ? bw / 2 : 0;
        for (let x = -bw; x < W; x += bw) {
          const k = r.range(0.85, 1.1);
          ctx.fillStyle = toRGB(wallCol, k);
          ctx.fillRect(x + off + 1, y + 1, bw - 2, bh - 2);
        }
      }
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const x0 = i * W / 2 + 26, wW = W / 2 - 52, wy = j * H / 2 + 22, wh = H / 2 - 44;
        ctx.fillStyle = '#e8e2d6';
        ctx.fillRect(x0 - 5, wy - 6, wW + 10, wh + 12);
        glass(x0, wy, wW, wh, r.chance(0.15));
        ctx.fillStyle = '#e8e2d6';
        ctx.fillRect(x0 + wW / 2 - 2, wy, 4, wh);
        ctx.fillRect(x0, wy + wh / 2 - 2, wW, 4);
      }
    } else {
      // stucco with shuttered windows
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const x0 = i * W / 2 + 30, wW = W / 2 - 60, wy = j * H / 2 + 20, wh = H / 2 - 46;
        ctx.fillStyle = toRGB(wallCol, 0.82);
        ctx.fillRect(x0 - 5, wy + wh, wW + 10, 6);
        glass(x0, wy, wW, wh, r.chance(0.14));
        ctx.fillStyle = accent;
        ctx.fillRect(x0 - 16, wy, 13, wh);
        ctx.fillRect(x0 + wW + 3, wy, 13, wh);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let k = 0; k < wh; k += 5) {
          ctx.fillRect(x0 - 16, wy + k, 13, 1.5);
          ctx.fillRect(x0 + wW + 3, wy + k, 13, 1.5);
        }
      }
    }
    // grime gradient
    const gr = ctx.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(40,30,20,0.08)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    return { map: toTexture(c), emissive: toTexture(e) };
  });
}

/** Shop front strip for the ground floor (one cell = 8m wide x 4m tall). */
export function shopTexture(seed, wall, awning) {
  return cached(`shop_${seed}_${wall}_${awning}`, () => {
    const W = 256, H = 128, c = canvas(W, H), ctx = c.getContext('2d');
    const r = makeRng(seed);
    ctx.fillStyle = wall; ctx.fillRect(0, 0, W, H);
    // big windows
    for (let i = 0; i < 2; i++) {
      const x0 = i * W / 2 + 8, w = W / 2 - 16;
      const g = ctx.createLinearGradient(0, 30, 0, H);
      g.addColorStop(0, '#3b4c55'); g.addColorStop(1, '#151d22');
      ctx.fillStyle = g; ctx.fillRect(x0, 34, w, H - 40);
      // goods inside
      for (let k = 0; k < 8; k++) {
        ctx.fillStyle = `hsl(${r.int(0, 360)},50%,${r.int(35, 60)}%)`;
        ctx.fillRect(x0 + 6 + r() * (w - 20), H - 30 + r.range(-10, 6), r.range(6, 16), r.range(6, 20));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0 + 8, 34, 10, H - 40);
      ctx.fillStyle = '#d9d4c8';
      ctx.fillRect(x0 + w / 2 - 2, 34, 4, H - 40);
    }
    // awning stripes
    for (let x = 0; x < W; x += 16) {
      ctx.fillStyle = (x / 16) % 2 ? awning : '#f3efe6';
      ctx.fillRect(x, 4, 16, 22);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 26, W, 4);
    return toTexture(c);
  });
}

export function neonSignTexture(text, color) {
  return cached(`neon_${text}_${color}`, () => {
    const W = 512, H = 128, c = canvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.font = 'bold 86px "Brush Script MT", "Segoe Script", cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H / 2 + 4);
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.fillText(text, W / 2, H / 2 + 4);
    return toTexture(c, { repeat: false });
  });
}

export function plateTexture(text) {
  const W = 256, H = 128, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2ee'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#2a4a8a'; ctx.lineWidth = 6; ctx.strokeRect(4, 4, W - 8, H - 8);
  // orange sun emblem
  ctx.fillStyle = '#ff8a3d';
  ctx.beginPath(); ctx.arc(W / 2, H / 2 + 6, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f3d7a';
  ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center';
  ctx.fillText('NEON COAST', W / 2, 26);
  ctx.font = 'bold 58px "Arial Black", Arial';
  ctx.fillStyle = '#1c2230';
  ctx.fillText(text, W / 2, 98);
  return toTexture(c, { repeat: false });
}

export function palmLeafTexture() {
  return cached('palmLeaf', () => {
    const W = 128, H = 512, c = canvas(W, H), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // rachis
    ctx.strokeStyle = '#6f7a32';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(W / 2, H); ctx.lineTo(W / 2, 0); ctx.stroke();
    // leaflets
    const r = makeRng(5);
    for (let y = H - 12; y > 6; y -= 7) {
      const t = y / H;
      const len = (W / 2 - 4) * Math.sin(Math.PI * Math.min(1, (1 - t) * 1.25 + 0.05)) * 0.98;
      for (const s of [-1, 1]) {
        const gcol = `hsl(${r.int(78, 100)},${r.int(42, 58)}%,${r.int(24, 36)}%)`;
        ctx.strokeStyle = gcol;
        ctx.lineWidth = r.range(2.2, 3.4);
        ctx.beginPath();
        ctx.moveTo(W / 2, y);
        ctx.quadraticCurveTo(W / 2 + s * len * 0.5, y - 10, W / 2 + s * len, y - 4 - r() * 26);
        ctx.stroke();
      }
    }
    const t = toTexture(c, { repeat: false });
    return t;
  });
}

export function barkTexture() {
  return cached('bark', () => {
    const W = 128, H = 256, c = canvas(W, H), ctx = c.getContext('2d');
    fillNoise(ctx, W, 81, [120, 100, 76], [168, 146, 112], 4, 4, 1.3);
    ctx.drawImage(c, 0, 0, W, W, 0, W, W, W);
    for (let y = 0; y < H; y += 10) {
      ctx.fillStyle = 'rgba(60,45,30,0.55)';
      ctx.fillRect(0, y, W, 3);
      ctx.fillStyle = 'rgba(210,190,150,0.25)';
      ctx.fillRect(0, y + 3, W, 2);
    }
    return toTexture(c);
  });
}

export function smokeTexture() {
  return cached('smoke', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    // break it up a bit
    const img = ctx.getImageData(0, 0, s, s);
    const nf = makeNoise(3, 8);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      img.data[i + 3] *= 0.55 + 0.45 * nf(x / 16, y / 16);
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

export function sparkTexture() {
  return cached('spark', () => {
    const s = 64, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,230,1)');
    g.addColorStop(0.25, 'rgba(255,200,90,0.9)');
    g.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    return toTexture(c, { repeat: false });
  });
}

export function skidTexture() {
  return cached('skid', () => {
    const W = 64, H = 64, c = canvas(W, H), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const r = makeRng(9);
    for (let x = 0; x < W; x++) {
      const edge = Math.min(x, W - 1 - x) / (W * 0.18);
      const a = Math.min(1, edge) * (0.55 + r() * 0.45);
      ctx.fillStyle = `rgba(14,14,14,${a})`;
      ctx.fillRect(x, 0, 1, H);
    }
    return toTexture(c, { srgb: false });
  });
}

export function waterNormalTexture() {
  return cached('waterN', () => {
    const s = 256;
    const c = canvas(s), ctx = c.getContext('2d');
    const h = fbmField(s, 401, 5, 4);
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const hx = h[y * s + ((x + 1) % s)] - h[y * s + ((x - 1 + s) % s)];
      const hy = h[((y + 1) % s) * s + x] - h[((y - 1 + s) % s) * s + x];
      const nx = -hx * 6, ny = -hy * 6, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      img.data[i * 4] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i * 4 + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false });
  });
}

/** Hawaiian / patterned shirt texture. */
export function shirtTexture(kind, base, accent, seed = 1) {
  return cached(`shirt_${kind}_${base}_${accent}_${seed}`, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
    const r = makeRng(seed);
    if (kind === 'hawaiian') {
      for (let i = 0; i < 26; i++) {
        const x = r() * s, y = r() * s, rad = r.range(10, 20);
        // leaves
        ctx.fillStyle = 'rgba(30,90,60,0.85)';
        for (let k = 0; k < 3; k++) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(r() * 6.28);
          ctx.beginPath(); ctx.ellipse(rad * 1.2, 0, rad * 1.1, rad * 0.32, 0, 0, 7); ctx.fill();
          ctx.restore();
        }
        // flower
        ctx.fillStyle = accent;
        for (let p = 0; p < 5; p++) {
          const a = p / 5 * 6.28;
          ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * rad * 0.5, y + Math.sin(a) * rad * 0.5, rad * 0.55, rad * 0.32, a, 0, 7); ctx.fill();
        }
        ctx.fillStyle = '#ffe680';
        ctx.beginPath(); ctx.arc(x, y, rad * 0.2, 0, 7); ctx.fill();
      }
    } else if (kind === 'stripes') {
      ctx.fillStyle = accent;
      for (let y = 0; y < s; y += 24) ctx.fillRect(0, y, s, 9);
    } else if (kind === 'plaid') {
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = accent;
      for (let i = 0; i < s; i += 32) { ctx.fillRect(i, 0, 12, s); ctx.fillRect(0, i, s, 12); }
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < s; i += 32) { ctx.fillRect(i + 20, 0, 2, s); ctx.fillRect(0, i + 20, s, 2); }
      ctx.globalAlpha = 1;
    } else {
      // fabric weave noise only
      const img = ctx.getImageData(0, 0, s, s);
      for (let i = 0; i < s * s; i++) {
        const n = (Math.random() - 0.5) * 14;
        img.data[i * 4] += n; img.data[i * 4 + 1] += n; img.data[i * 4 + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    }
    // fabric weave lines
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#000';
    for (let i = 0; i < s; i += 2) ctx.fillRect(0, i, s, 1);
    ctx.globalAlpha = 1;
    return toTexture(c);
  });
}

export function crackedGlassTexture() {
  return cached('crackGlass', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const r = makeRng(77);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    const cx = s * 0.45, cy = s * 0.5;
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2;
      let x = cx, y = cy;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += Math.cos(a + r.range(-0.4, 0.4)) * r.range(10, 26);
        y += Math.sin(a + r.range(-0.4, 0.4)) * r.range(10, 26);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let ring = 1; ring < 5; ring++) {
      ctx.beginPath();
      for (let k = 0; k <= 20; k++) {
        const a = k / 20 * Math.PI * 2;
        const rr = ring * 22 + r.range(-6, 6);
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.stroke();
    }
    return toTexture(c, { repeat: false });
  });
}

export function tireTexture() {
  return cached('tire', () => {
    const W = 512, H = 64, c = canvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#1b1b1d'; ctx.fillRect(0, 0, W, H);
    // tread blocks
    ctx.fillStyle = '#0d0d0e';
    for (let x = 0; x < W; x += 16) {
      ctx.fillRect(x, 8, 6, 20);
      ctx.fillRect(x + 8, 36, 6, 20);
    }
    ctx.fillRect(0, 30, W, 4);
    return toTexture(c);
  });
}

export function interiorTexture() {
  return cached('interior', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    fillNoise(ctx, s, 91, [30, 30, 32], [52, 50, 50], 4, 4, 1.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    for (let i = 0; i < s; i += 16) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke(); }
    return toTexture(c);
  });
}
