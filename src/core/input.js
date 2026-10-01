/**
 * Keyboard / mouse / gamepad input with pointer lock.
 */
const BLOCK_DEFAULT = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'KeyF', 'F1', 'F2', 'F3',
]);

export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = 0;
    this.clicked = new Set();
    this.wheel = 0;
    this.locked = false;
    this.lastMouseMove = 0;
    this.gamepad = null;
    this.padPrev = [];
    this.virtual = new Map(); // scripted inputs (tests / automation)

    addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = 0;
    });
    dom.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      this.clicked.add(e.button);
    });
    addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (this.locked) {
        // Some browsers emit huge spikes when pointer lock engages; ignore those.
        if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
        this.lastMouseMove = performance.now();
      }
    });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
    });
  }

  requestLock() {
    if (!this.locked && this.dom.requestPointerLock) {
      try {
        const p = this.dom.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) p.catch(() => { try { this.dom.requestPointerLock(); } catch (_) { /* ignore */ } });
      } catch (_) {
        try { this.dom.requestPointerLock(); } catch (__) { /* ignore */ }
      }
    }
  }

  down(code) { return this.keys.has(code) || this.virtual.get(code) === true; }
  hit(code) { return this.pressed.has(code); }
  mouseDown(b = 0) { return (this.buttons & (1 << b)) !== 0; }
  mouseHit(b = 0) { return this.clicked.has(b); }

  /** Synthesized press for automation/tests. */
  tap(code) { this.pressed.add(code); }
  hold(code, on = true) { this.virtual.set(code, on); }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) { this.gamepad = null; return; }
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const val = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const state = {
      lx: dz(gp.axes[0] || 0), ly: dz(gp.axes[1] || 0),
      rx: dz(gp.axes[2] || 0), ry: dz(gp.axes[3] || 0),
      rt: val(7), lt: val(6),
      a: btn(0), b: btn(1), x: btn(2), y: btn(3), lb: btn(4), rb: btn(5),
      back: btn(8), start: btn(9), ls: btn(10), rs: btn(11),
    };
    const prev = this.padPrev;
    state.pressed = (name) => state[name] && !prev[name];
    this.gamepad = state;
    this.padPrev = { a: state.a, b: state.b, x: state.x, y: state.y, lb: state.lb, rb: state.rb, back: state.back, start: state.start, ls: state.ls, rs: state.rs };
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.clicked.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
