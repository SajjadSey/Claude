import * as THREE from 'three';
import { G, groups } from '../core/physics.js';
import { clamp, damp, dampAngle, lerp, wrapAngle } from '../core/util.js';

const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _want = new THREE.Vector3();
const _v = new THREE.Vector3();

export class CameraRig {
  constructor(camera, game) {
    this.camera = camera;
    this.game = game;
    this.yaw = 0;
    this.pitch = 0.22;
    this.dist = 4.0;
    this.zoom = 1;
    this.mode = 'foot';
    this.carW = 0; // 0 = on foot framing, 1 = vehicle framing
    this.pivot = new THREE.Vector3();
    this.lastMouse = -10;
    this.trauma = 0;
    this.fov = 62;
    this.curDist = 4;
    this.time = 0;
    this.lookBack = false;
    this.aimW = 0;
  }

  shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }

  update(dt, input) {
    const g = this.game;
    const ch = g.player.character;
    this.time += dt;
    // ---------------------------------------------------- mouse / stick look
    let mdx = input.mouseDX, mdy = input.mouseDY;
    if (input.gamepad) { mdx += input.gamepad.rx * 900 * dt; mdy += input.gamepad.ry * 600 * dt; }
    if (Math.abs(mdx) + Math.abs(mdy) > 0.5) this.lastMouse = this.time;
    const pl = g.player;
    const aimFoot = !!(pl.aiming && ch.state === 'foot');
    if (pl.driveAim || pl.aiming || pl.hipT > 0) this.lastMouse = this.time; // no auto-follow while shooting
    this.aimW = damp(this.aimW, aimFoot ? 1 : 0, 9, dt);
    const sens = g.settings.mouseSens * (1 - 0.35 * this.aimW);
    this.yaw -= mdx * 0.0024 * sens;
    this.pitch = clamp(this.pitch + mdy * 0.0021 * sens * (g.settings.invertY ? -1 : 1), aimFoot ? -0.95 : -0.55, aimFoot ? 1.15 : 1.25);
    // the mouse wheel zooms in vehicles; on foot it switches weapons
    if (input.wheel && ch.state === 'vehicle') this.zoom = clamp(this.zoom + input.wheel * 0.12, 0.6, 2.2);

    // ---------------------------------------------------- framing target
    const veh = ch.vehicle;
    const inCar = !!veh && (ch.state === 'vehicle' || (ch.seq && ['sit', 'close', 'openIn', 'out'].includes(ch.seq.phase)));
    this.carW = damp(this.carW, inCar ? 1 : 0, 3.2, dt);
    const s = ch.rig.scale;
    if (ch.state === 'ragdoll' || ch.state === 'dead' || ch.state === 'getup') {
      if (ch.ragdoll.active) ch.ragdoll.hipsPosition(_pivot); else _pivot.copy(ch.pos);
      _pivot.y += 0.9;
    } else {
      _pivot.copy(ch.pos);
      _pivot.y += (1.55 + 0.06 * this.aimW) * s;
    }
    let speed = 0;
    if (veh) {
      const vp = _v.copy(veh.curPos);
      vp.y += veh.T.beltY + 0.35;
      _pivot.lerp(vp, this.carW);
      speed = veh.speed;
      // auto-follow behind the car when the player isn't steering the camera
      if (inCar && this.time - this.lastMouse > 1.4) {
        const vel = veh.linvel(_v);
        const f = veh.forward(_dir);
        let tyaw = Math.atan2(f.x, f.z);
        if (speed > 3 && veh.fwdSpeed > 0) {
          const vyaw = Math.atan2(vel.x, vel.z);
          tyaw = tyaw + wrapAngle(vyaw - tyaw) * 0.55; // show the drift angle
        }
        if (this.lookBack) tyaw += Math.PI;
        const k = clamp(speed / 6, 0.2, 1) * 3.0;
        this.yaw = dampAngle(this.yaw, tyaw, k, dt);
        this.pitch = damp(this.pitch, 0.2 + (speed > 30 ? -0.03 : 0), 1.5, dt);
      }
    } else if (ch.state === 'foot' && this.time - this.lastMouse > 3.5 && ch.speedScalar > 2.5) {
      // gently swing behind a running character
      this.yaw = dampAngle(this.yaw, ch.yaw, 0.6, dt);
    }
    // smooth pivot (removes step bob)
    if (this.pivot.distanceToSquared(_pivot) > 100) this.pivot.copy(_pivot);
    const pk = inCar ? 18 : 12;
    this.pivot.x = damp(this.pivot.x, _pivot.x, pk, dt);
    this.pivot.y = damp(this.pivot.y, _pivot.y, inCar ? 10 : 7, dt);
    this.pivot.z = damp(this.pivot.z, _pivot.z, pk, dt);

    // ---------------------------------------------------- distance & fov
    const footDist = lerp((ch.speedScalar > 6 ? 4.4 : 3.7) * this.zoom, 1.75, this.aimW) * s;
    const carDist = veh ? (veh.halfL * 1.25 + 2.6 + Math.min(speed, 40) * 0.035) * this.zoom : 6;
    const want = lerp(footDist, carDist, this.carW);
    const fovT = lerp(lerp(60, 47, this.aimW), 66 + Math.min(speed, 45) * 0.42 - (pl.driveAim ? 8 : 0), this.carW);
    this.fov = damp(this.fov, fovT, 3, dt);
    // shoulder offset on foot
    const shoulder = (1 - this.carW) * lerp(0.38, 0.62, this.aimW) * s;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, -sp, Math.cos(this.yaw) * cp); // view direction
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const piv = _v.copy(this.pivot);
    piv.x += rx * shoulder;
    piv.z += rz * shoulder;
    // collision
    const P = g.physics;
    _want.copy(_dir).multiplyScalar(-1);
    const exclude = veh ? veh.body : null;
    const hit = P.raycast(piv, _want, want + 0.3, groups(G.ALL, G.STATIC | G.CAR), exclude);
    let d = want;
    if (hit) d = Math.max(0.6, hit.dist - 0.3);
    this.curDist = d < this.curDist ? d : damp(this.curDist, d, 3, dt);
    const cam = this.camera;
    cam.position.copy(piv).addScaledVector(_want, this.curDist);
    // keep above ground
    if (cam.position.y < 0.35) cam.position.y = 0.35;
    // look target slightly ahead in car
    const look = _pivot.copy(piv);
    if (inCar && veh) {
      const vel = veh.linvel(_dir);
      look.addScaledVector(vel, 0.04 * this.carW);
    }
    cam.lookAt(look);
    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const sh = this.trauma * this.trauma;
    const hs = veh && inCar ? clamp((speed - 25) / 40, 0, 1) * 0.004 : 0;
    if (sh > 0 || hs > 0) {
      const t = this.time * 40;
      cam.rotation.x += (Math.sin(t * 1.3) * 0.03 * sh) + Math.sin(t * 2.1) * hs;
      cam.rotation.y += (Math.sin(t * 1.7 + 2) * 0.03 * sh) + Math.sin(t * 1.6) * hs;
      cam.rotation.z += Math.sin(t * 2.3 + 1) * 0.02 * sh;
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Horizontal forward/right vectors for movement input. */
  basis(outF, outR) {
    outF.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    outR.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }
}
