import { clamp } from '../core/util.js';
import { WEAPONS } from './weapons.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor(game) {
    this.game = game;
    this.mm = $('minimap');
    this.mmCtx = this.mm.getContext('2d');
    this.sp = $('speedo-c');
    this.spCtx = this.sp.getContext('2d');
    this.prompt = $('prompt');
    this.msg = $('msg');
    this.health = $('health-fill');
    this.fpsEl = $('fps');
    this.speedoWrap = $('speedo');
    this.wasted = $('wasted');
    this.wantedEl = $('wanted');
    this.stars = this.wantedEl ? [...this.wantedEl.children] : [];
    this.hitEl = $('hitflash');
    this.cross = $('crosshair');
    this.crossBars = this.cross ? [...this.cross.querySelectorAll('i')] : [];
    this.hm = this.cross ? this.cross.querySelector('.hm') : null;
    this.hmT = 0;
    this.weaponEl = $('weapon');
    this.weaponT = 0;
    this.lastGap = -1;
    this.hitT = 0;
    this.lastStars = -1;
    this.lastWClass = '';
    this.vehName = $('vehname');
    this.msgT = 0;
    this.vehT = 0;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.fps = 60;
    this.showFps = false;
  }

  message(text, t = 3) {
    this.msg.textContent = text;
    this.msg.style.opacity = 1;
    this.msgT = t;
  }

  vehicleName(text) {
    this.vehName.textContent = text;
    this.vehName.style.opacity = 1;
    this.vehT = 2.5;
  }

  setPrompt(text) {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.style.opacity = text ? 1 : 0;
  }

  update(dt) {
    const g = this.game;
    const ch = g.player.character;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0; this.fpsN = 0;
      if (this.showFps) this.fpsEl.textContent = `${this.fps.toFixed(0)} FPS · ${g.vehicles.length} cars · ${g.characters.length} people`;
    }
    this.fpsEl.style.display = this.showFps ? 'block' : 'none';
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.msg.style.opacity = 0; }
    if (this.vehT > 0) { this.vehT -= dt; if (this.vehT <= 0) this.vehName.style.opacity = 0; }
    this.health.style.width = `${clamp(ch.health / ch.maxHealth, 0, 1) * 100}%`;
    this.health.style.background = ch.health < 30 ? '#ff3b4f' : '#4cd964';
    const veh = ch.state === 'vehicle' ? ch.vehicle : null;
    this.speedoWrap.style.opacity = veh ? 1 : 0;
    if (veh) this.drawSpeedo(veh);
    this.updateWanted(dt);
    this.updateCrosshair(dt);
    if (this.weaponT > 0 && this.weaponT < 1e8) { this.weaponT -= dt; if (this.weaponT <= 0) this.weaponEl.style.opacity = 0; }
    this.drawMinimap();
  }

  setWeapon(W) {
    if (!this.weaponEl) return;
    this.weaponEl.innerHTML = W.hold ? `${W.name}<b>∞</b><small>${W.fa}</small>` : `${W.name}<small>${W.fa}</small>`;
    this.weaponEl.style.opacity = 1;
    this.weaponT = W.hold ? 1e9 : 2.5;
  }

  hitMarker(kill) {
    if (!this.hm) return;
    this.hm.className = kill ? 'hm kill' : 'hm';
    this.hm.style.opacity = 1;
    this.hmT = kill ? 0.5 : 0.18;
  }

  updateCrosshair(dt) {
    const pl = this.game.player;
    if (!this.cross || !pl) return;
    const ch = pl.character;
    const show = (pl.aiming || pl.hipT > 0 || pl.driveAim) && ch.alive && !this.game.bustedT;
    this.cross.style.opacity = show ? 1 : 0;
    if (this.hmT > 0) { this.hmT -= dt; if (this.hmT <= 0) this.hm.style.opacity = 0; }
    if (!show) return;
    const W = WEAPONS[pl.weapon];
    const sp = W && W.hold ? ((pl.aiming || pl.driveAim) ? W.aimSpread : W.spread) * (1 + pl.bloom) : 0.01;
    const gap = Math.round(4 + sp * 420);
    if (gap !== this.lastGap) {
      this.lastGap = gap;
      const [t, b, l, r] = this.crossBars;
      t.style.top = `${-gap - 9}px`; b.style.top = `${gap}px`; l.style.left = `${-gap - 9}px`; r.style.left = `${gap}px`;
    }
    this.cross.classList.toggle('on', !!pl.aimOnTarget);
  }

  /** Red vignette when the player is shot. */
  hit() {
    this.hitT = 0.35;
    if (this.hitEl) this.hitEl.style.opacity = 1;
  }

  updateWanted(dt) {
    const g = this.game;
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0 && this.hitEl) this.hitEl.style.opacity = 0; }
    if (!g.police || !this.wantedEl) return;
    const W = g.police.wanted;
    if (W.stars !== this.lastStars) {
      this.lastStars = W.stars;
      this.stars.forEach((el, i) => el.classList.toggle('on', i < W.stars));
    }
    const cls = W.stars === 0 ? '' : W.flash > 0 ? 'gain' : !W.seen ? 'search' : '';
    if (cls !== this.lastWClass) { this.lastWClass = cls; this.wantedEl.className = cls; }
  }

  drawMinimap() {
    const g = this.game, ctx = this.mmCtx, W = this.mm.width, H = this.mm.height;
    const map = g.city.minimap;
    const ch = g.player.character;
    const p = ch.vehicle && ch.state === 'vehicle' ? ch.vehicle.curPos : ch.pos;
    const yaw = g.camRig.yaw;
    const zoom = ch.state === 'vehicle' ? 1.1 : 1.8; // pixels per meter
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#4a83a8';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    // world +x maps to map +x; rotate so camera forward points up
    ctx.rotate(Math.PI + yaw);
    const k = zoom / map.scale;
    ctx.scale(k, k);
    const mx = (p.x - map.ox) * map.scale, mz = (p.z - map.oz) * map.scale;
    ctx.drawImage(map.canvas, -mx, -mz);
    // police search area while out of sight
    const s = map.scale;
    const WS = g.police ? g.police.wanted : null;
    if (WS && WS.stars > 0 && !WS.seen) {
      const cx = (WS.lastKnown.x - map.ox) * s - mx, cz = (WS.lastKnown.z - map.oz) * s - mz;
      ctx.fillStyle = 'rgba(60,110,255,0.22)';
      ctx.strokeStyle = 'rgba(120,160,255,0.75)';
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      ctx.arc(cx, cz, WS.searchR * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const blink = (g.time * 4) % 2 < 1;
    for (const v of g.vehicles) {
      const vx = (v.curPos.x - map.ox) * s - mx, vz = (v.curPos.z - map.oz) * s - mz;
      const chasing = v.policeUnit && !v.policeUnit.leaving && WS && WS.stars > 0;
      ctx.fillStyle = v === g.player.lastVehicle ? '#4da3ff' : chasing ? (blink ? '#ff2a2a' : '#2a5bff') : v.T.police ? '#3a5bff' : v.driver ? '#f5f5f5' : '#bbbbbb';
      ctx.beginPath();
      ctx.arc(vx, vz, (chasing ? 4.6 : 3.2) / k * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of g.characters) {
      if (c === ch || c.state === 'vehicle') continue;
      const cx = (c.pos.x - map.ox) * s - mx, cz = (c.pos.z - map.oz) * s - mz;
      ctx.fillStyle = c.state === 'dead' ? '#7a1010' : c.isCop && WS && WS.stars > 0 ? (blink ? '#2a5bff' : '#ff2a2a') : c.isCop ? '#5577ff' : c.ai && c.ai.mode === 'fight' ? '#ff4040' : '#e8d080';
      ctx.fillRect(cx - 1.2 / k * 0.6, cz - 1.2 / k * 0.6, 2.4 / k * 0.6, 2.4 / k * 0.6);
    }
    ctx.restore();
    // player arrow (fixed in the center, rotated by heading relative to the camera)
    const rel = this.playerHeading() - yaw;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-rel);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // north marker
    ctx.save();
    ctx.translate(W / 2, H / 2);
    const na = Math.PI + yaw; // direction of world -z on the map
    const nx = Math.sin(na) * (W / 2 - 12), ny = -Math.cos(na) * (H / 2 - 12);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(nx, ny, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
    ctx.restore();
    // ring
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); ctx.stroke();
  }

  playerHeading() {
    const ch = this.game.player.character;
    if (ch.vehicle && ch.state === 'vehicle') {
      const q = ch.vehicle.curQuat;
      // forward = (0,0,1) rotated by q
      const x = 2 * (q.x * q.z + q.w * q.y);
      const z = 1 - 2 * (q.x * q.x + q.y * q.y);
      return Math.atan2(x, z);
    }
    return ch.yaw;
  }

  drawSpeedo(veh) {
    const ctx = this.spCtx, W = this.sp.width, H = this.sp.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2 + 10, R = W / 2 - 18;
    const kmh = Math.abs(veh.fwdSpeed) * 3.6;
    const maxK = 280;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    // background
    ctx.fillStyle = 'rgba(10,12,20,0.55)';
    ctx.beginPath(); ctx.arc(cx, cy, R + 12, 0, Math.PI * 2); ctx.fill();
    // rpm arc
    const rpmT = clamp(veh.rpm / (veh.T.redline + 400), 0, 1);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(cx, cy, R - 14, a0, a1); ctx.stroke();
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#2de2e6'); grad.addColorStop(0.7, '#ff6ec7'); grad.addColorStop(1, '#ff3b3b');
    ctx.strokeStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, R - 14, a0, a0 + (a1 - a0) * rpmT); ctx.stroke();
    // ticks
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= maxK; v += 20) {
      const a = a0 + (a1 - a0) * (v / maxK);
      const big = v % 40 === 0;
      ctx.lineWidth = big ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R - (big ? 10 : 6)), cy + Math.sin(a) * (R - (big ? 10 : 6)));
      ctx.stroke();
      if (big) ctx.fillText(String(v), cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
    }
    // needle
    const an = a0 + (a1 - a0) * clamp(kmh / maxK, 0, 1);
    ctx.strokeStyle = '#ff2f6d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(an) * 10, cy - Math.sin(an) * 10);
    ctx.lineTo(cx + Math.cos(an) * (R - 6), cy + Math.sin(an) * (R - 6));
    ctx.stroke();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
    // digital
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px "Segoe UI", sans-serif';
    ctx.fillText(String(Math.round(kmh)), cx, cy + 38);
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillStyle = '#9fe';
    ctx.fillText('km/h', cx, cy + 58);
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.fillStyle = veh.reverse ? '#ff9f43' : '#ffffff';
    ctx.fillText(veh.reverse ? 'R' : String(veh.gear), cx + 46, cy - 18);
    // damage
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(cx - 40, cy + 70, 80, 5);
    ctx.fillStyle = veh.health > 50 ? '#4cd964' : veh.health > 25 ? '#ffcc00' : '#ff3b30';
    ctx.fillRect(cx - 40, cy + 70, 80 * veh.health / 100, 5);
  }
}

