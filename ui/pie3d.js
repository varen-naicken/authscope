// A 3D pie drawn on a canvas: tilted top, extruded side walls, slices that lift on hover and
// pop out when selected. Drag sideways to turn it. No libraries, so nothing loads from the web.

// Colours checked with the dataviz validator for light and dark, with every pair touching
// (as in a pie). Only four hues pass that, so slices beyond four fold into a hatched "Other".
const HUES = {
  light: ['#2a78d6', '#eda100', '#e87ba4', '#008300'],
  dark:  ['#3987e5', '#c98500', '#d55181', '#008300'],
};
const OTHER = { light: '#a3a8b0', dark: '#5d6670' };
export const MAX_SLICES = 4;

const TAU = Math.PI * 2;
const norm = a => ((a % TAU) + TAU) % TAU;

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f));
  return `rgb(${c.join(',')})`;
}

export class Pie3D {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.slices = [];
    this.rotation = -Math.PI / 2 - 0.35;   // first slice starts near the top, slightly turned
    this.hover = null;
    this.selected = null;
    this.lift = new Map();                 // animated pop-out per slice
    this.grow = 1;                         // intro sweep (0..1)
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.dark = matchMedia('(prefers-color-scheme: dark)');
    this.dark.addEventListener('change', () => this.draw());
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // slices: [{ id, label, value, folded?: bool }] - already ordered, at most MAX_SLICES + 1
  setData(slices, { animate = false } = {}) {
    const mode = this.dark.matches ? 'dark' : 'light';
    this.slices = slices.map((s, i) => ({ ...s, color: s.folded ? OTHER[mode] : HUES[mode][i % HUES[mode].length] }));
    if (this.selected && !this.slices.some(s => s.id === this.selected)) this.selected = null;
    if (animate && !this.reduceMotion) { this.grow = 0; this.growStart = null; this._animate(); }
    else this.draw();
  }

  colorOf(id) {
    const mode = this.dark.matches ? 'dark' : 'light';
    const i = this.slices.findIndex(s => s.id === id);
    if (i < 0) return null;
    return this.slices[i].folded ? OTHER[mode] : HUES[mode][i];
  }

  setSelected(id) {
    this.selected = id;
    this._animate();
  }

  resize() {
    const w = Math.max(240, this.canvas.parentElement.clientWidth);
    const h = Math.round(Math.min(340, Math.max(220, w * 0.62)));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.draw();
  }

  // ---------- geometry ----------
  _geom() {
    const labelRoom = Math.min(130, this.w * (this.w < 480 ? 0.31 : 0.26));
    const rx = Math.max(56, Math.min(this.w / 2 - labelRoom, 190));
    const ry = rx * 0.5;                    // tilt
    const depth = Math.max(16, rx * 0.17);  // extrusion
    return { cx: this.w / 2, cy: this.h / 2 - depth / 2, rx, ry, depth };
  }

  _arcs() {
    const total = this.slices.reduce((n, s) => n + s.value, 0) || 1;
    let a = this.rotation;
    return this.slices.map(s => {
      const sweep = (s.value / total) * TAU * this.grow;
      const arc = { s, a0: a, a1: a + sweep, mid: a + sweep / 2, share: s.value / total };
      a += sweep;
      return arc;
    });
  }

  _offset(arc, g) {
    const lift = this.lift.get(arc.s.id) || 0;
    return { dx: Math.cos(arc.mid) * lift * g.rx * 0.11, dy: Math.sin(arc.mid) * lift * g.ry * 0.11 };
  }

  // ---------- drawing ----------
  draw() {
    const { ctx } = this;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.slices.length) return;
    const g = this._geom();
    const surface = getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff';
    const arcs = this._arcs();

    // Floor shadow
    ctx.save();
    ctx.fillStyle = this.dark.matches ? 'rgba(0,0,0,.35)' : 'rgba(27,37,50,.10)';
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy + g.depth + 6, g.rx * 1.02, g.ry * 0.9, 0, 0, TAU);
    ctx.filter = 'blur(6px)';
    ctx.fill();
    ctx.restore();

    // Back to front: slices whose middle is further back get drawn first.
    const order = [...arcs].sort((p, q) => Math.sin(p.mid) - Math.sin(q.mid));

    for (const arc of order) {
      const o = this._offset(arc, g);
      const cx = g.cx + o.dx, cy = g.cy + o.dy;
      const side = shade(arc.s.color, -0.32);
      const pt = (a, y = 0) => [cx + Math.cos(a) * g.rx, cy + Math.sin(a) * g.ry + y];

      // Cut faces, visible once a slice is lifted or the pie is not whole
      for (const a of [arc.a0, arc.a1]) {
        ctx.beginPath();
        ctx.moveTo(cx, cy); ctx.lineTo(...pt(a)); ctx.lineTo(...pt(a, g.depth)); ctx.lineTo(cx, cy + g.depth);
        ctx.closePath();
        ctx.fillStyle = shade(arc.s.color, -0.42); ctx.fill();
      }

      // Outer wall: only the part facing us (angles with sin > 0)
      for (const [s, e] of this._frontSpans(arc.a0, arc.a1)) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, g.rx, g.ry, 0, s, e);
        ctx.lineTo(...pt(e, g.depth));
        ctx.ellipse(cx, cy + g.depth, g.rx, g.ry, 0, e, s, true);
        ctx.closePath();
        const grad = ctx.createLinearGradient(cx - g.rx, 0, cx + g.rx, 0);
        grad.addColorStop(0, shade(arc.s.color, -0.45));
        grad.addColorStop(0.45, side);
        grad.addColorStop(1, shade(arc.s.color, -0.5));
        ctx.fillStyle = grad; ctx.fill();
      }

      // Top face
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.ellipse(cx, cy, g.rx, g.ry, 0, arc.a0, arc.a1);
      ctx.closePath();
      ctx.fillStyle = arc.s.color;
      ctx.fill();
      if (arc.s.folded) this._hatch(cx, cy, g, surface);
      const sheen = ctx.createLinearGradient(0, cy - g.ry, 0, cy + g.ry);
      sheen.addColorStop(0, 'rgba(255,255,255,.18)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen; ctx.fill();
      // 2px surface gap between slices
      ctx.lineWidth = 2; ctx.strokeStyle = surface; ctx.lineJoin = 'round';
      ctx.stroke();
      if (arc.s.id === this.hover || arc.s.id === this.selected) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--ink').trim();
        ctx.stroke();
      }
    }
    this._labels(arcs, g);
  }

  _hatch(cx, cy, g, surface) {
    const { ctx } = this;
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = surface; ctx.globalAlpha = 0.55; ctx.lineWidth = 2;
    for (let x = cx - g.rx - g.ry * 2; x < cx + g.rx + g.ry * 2; x += 8) {
      ctx.beginPath(); ctx.moveTo(x, cy - g.ry - 4); ctx.lineTo(x + g.ry * 2 + 8, cy + g.ry + 4); ctx.stroke();
    }
    ctx.restore();
  }

  // Split [a0,a1] into the pieces that face the viewer (0..PI in screen terms).
  _frontSpans(a0, a1) {
    const spans = [];
    let start = a0;
    while (start < a1) {
      const base = Math.floor(start / TAU) * TAU;
      const fS = base, fE = base + Math.PI;           // front half of this turn
      const s = Math.max(start, fS), e = Math.min(a1, fE);
      if (e > s) spans.push([s, e]);
      start = base + TAU;
      if (start <= a0) break;
    }
    return spans;
  }

  _labels(arcs, g) {
    const { ctx } = this;
    const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim();
    const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim();
    const font = getComputedStyle(document.body).fontFamily;
    const placed = [];
    for (const arc of arcs) {
      if (arc.share < 0.03 && arcs.length > 2) continue; // tiny slices: legend carries them
      const o = this._offset(arc, g);
      const m = norm(arc.mid);
      const front = Math.sin(m) > 0;
      const ex = g.cx + o.dx + Math.cos(m) * g.rx, ey = g.cy + o.dy + Math.sin(m) * g.ry + (front ? g.depth : 0);
      const right = Math.cos(m) >= 0;
      let lx = g.cx + Math.cos(m) * (g.rx + 18) + (right ? 6 : -6);
      let ly = g.cy + Math.sin(m) * (g.ry + 14) + (front ? g.depth : 0);
      // keep labels from colliding
      for (const p of placed) if (p.right === right && Math.abs(p.y - ly) < 34) ly = p.y + (ly >= p.y ? 34 : -34);
      ly = Math.max(14, Math.min(this.h - 22, ly));
      placed.push({ y: ly, right });

      // Keep both lines of the label inside the canvas.
      const sub = `${arc.s.value} site${arc.s.value === 1 ? '' : 's'} · ${Math.round(arc.share * 100)}%`;
      ctx.font = `700 13.5px ${font}`; let tw = ctx.measureText(arc.s.label).width;
      ctx.font = `400 12.5px ${font}`; tw = Math.max(tw, ctx.measureText(sub).width);
      lx = right ? Math.min(lx, this.w - 4 - tw) : Math.max(lx, tw + 4);

      ctx.strokeStyle = muted; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(lx + (right ? -4 : 4), ly + 4); ctx.stroke();
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillStyle = ink; ctx.font = `700 13.5px ${font}`;
      ctx.fillText(arc.s.label, lx, ly);
      ctx.fillStyle = muted; ctx.font = `400 12.5px ${font}`;
      ctx.fillText(sub, lx, ly + 16);
    }
  }

  // ---------- animation ----------
  _animate() {
    if (this._raf) return;
    const step = t => {
      let moving = false;
      if (this.grow < 1) {
        // One opening sweep, timed so it lasts the same on slow and fast machines.
        if (this.growStart == null) this.growStart = t;
        const p = Math.min(1, (t - this.growStart) / 700);
        this.grow = 1 - Math.pow(1 - p, 3);
        if (p < 1) moving = true;
      }
      for (const s of this.slices) {
        const target = s.id === this.selected ? 1 : s.id === this.hover ? 0.45 : 0;
        const cur = this.lift.get(s.id) || 0;
        const next = this.reduceMotion ? target : cur + (target - cur) * 0.25;
        if (Math.abs(next - target) > 0.01) moving = true;
        this.lift.set(s.id, Math.abs(next - target) > 0.01 ? next : target);
      }
      this.draw();
      this._raf = moving ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  }

  // ---------- picking & input ----------
  hitTest(x, y) {
    if (!this.slices.length) return null;
    const g = this._geom();
    const arcs = this._arcs();
    // Check front-most slices first; test the top face, then the wall below it.
    const order = [...arcs].sort((p, q) => Math.sin(q.mid) - Math.sin(p.mid));
    for (let dy = 0; dy <= g.depth; dy += 3) {
      for (const arc of order) {
        // Test where the slice is drawn and where it rests, so a slice that lifts on hover
        // doesn't slip out from under the pointer at its edge.
        for (const o of [this._offset(arc, g), { dx: 0, dy: 0 }]) {
          const px = (x - g.cx - o.dx) / g.rx, py = (y - dy - g.cy - o.dy) / g.ry;
          if (px * px + py * py > 1) continue;
          const ang = norm(Math.atan2(py, px));
          if (dy > 0 && Math.sin(ang) <= 0) continue; // walls only exist at the front
          const rel = norm(ang - arc.a0);
          if (rel <= arc.a1 - arc.a0) return arc.s.id;
        }
      }
    }
    return null;
  }

  _bind() {
    const c = this.canvas;
    let down = null;
    const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', e => { down = { x: e.clientX, rot: this.rotation, moved: false }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (down) {
        const d = e.clientX - down.x;
        if (Math.abs(d) > 4) down.moved = true;
        if (down.moved) { this.rotation = down.rot + d * 0.012; c.style.cursor = 'grabbing'; this.draw(); return; }
      }
      const id = this.hitTest(...pos(e));
      c.style.cursor = id ? 'pointer' : 'grab';
      if (id !== this.hover) { this.hover = id; this.onHover(id, e); this._animate(); }
      else if (id) this.onHover(id, e);
    });
    c.addEventListener('pointerup', e => {
      const wasDrag = down?.moved;
      down = null;
      c.style.cursor = 'grab';
      if (wasDrag) return;
      const id = this.hitTest(...pos(e));
      this.onSelect(id && id === this.selected ? null : id);
    });
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.onHover(null); this._animate(); } });
  }
}
