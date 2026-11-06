import { easeOut, fmtDim } from './plan.js';

// Lucide `send` (ISC licence, https://lucide.dev/icons/send): the plane's nose
// is at (21.85, 2.15) in a 24x24 viewBox, which is the cursor hot spot.
const PLANE_BODY =
  'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z';
const PLANE_CREASE = 'm21.854 2.147-10.94 10.939';

function plane(color) {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="' + PLANE_BODY + '" fill="' + color + '" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>' +
    '<path d="' + PLANE_CREASE + '" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1"/>' +
    '</svg>'
  );
}

/** One agent: a paper plane that travels to, and drags, whatever it is drawing. */
export function createAgent(doc, color, x, y) {
  const el = doc.createElement('div');
  el.className = 'sw-cursor';
  el.innerHTML = plane(color);
  el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
  return {
    el,
    color,
    initial: '',
    layer: null,
    x,
    y,
    from: { x, y },
    to: { x, y },
    ctrl: { x, y },
    start: 0,
    dur: 0,
    pinned: false,
    seed: Math.random() * 1000,
    vx: 0,
    vy: 0,
    angle: 0,
    flock: null,
  };
}

// The artwork's nose points 45 degrees above +x, so a heading of theta needs
// rotate(theta + 45). Rotation pivots on the nose (see transform-origin in CSS).
const NOSE_DEG = 45;

function writeTransform(agent) {
  agent.el.style.transform =
    'translate3d(' + agent.x.toFixed(1) + 'px,' + agent.y.toFixed(1) + 'px,0) rotate(' +
    agent.angle.toFixed(1) + 'deg)';
}

/** Turn the plane toward its direction of travel, with a capped turn rate. */
function orient(agent, dx, dy, dt) {
  if (Math.hypot(dx, dy) < 1.2) return; // shivering is not travelling
  const target = (Math.atan2(dy, dx) * 180) / Math.PI + NOSE_DEG;
  const delta = ((target - agent.angle + 540) % 360) - 180;
  agent.angle += delta * Math.min(1, dt * 18);
  agent.angle = (((agent.angle + 180) % 360) + 360) % 360 - 180;
}

/** Start a curved move toward (x, y). Control point bends perpendicular to the path. */
export function aim(agent, x, y, time, dur) {
  agent.flock = null;
  agent.vx = 0;
  agent.vy = 0;
  agent.from.x = agent.x;
  agent.from.y = agent.y;
  agent.to.x = x;
  agent.to.y = y;

  const dx = x - agent.from.x;
  const dy = y - agent.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = (Math.random() - 0.5) * Math.min(180, len * 0.5);

  agent.ctrl.x = (agent.from.x + x) / 2 - (dy / len) * bend;
  agent.ctrl.y = (agent.from.y + y) / 2 + (dx / len) * bend;
  agent.start = time;
  agent.dur = Math.max(120, dur);
  agent.pinned = false;
}

/** Hard placement: used while dragging, where the tip must sit on the box corner. */
export function placeAgent(agent, x, y) {
  orient(agent, x - agent.x, y - agent.y, 0.032);
  agent.x = x;
  agent.y = y;
  agent.from.x = x;
  agent.from.y = y;
  agent.to.x = x;
  agent.to.y = y;
  agent.dur = 0;
  agent.pinned = true;
  agent.flock = null;
  writeTransform(agent);
}

/**
 * Flock entry: a boids-lite steering pass (seek slot + separation + wander) so
 * the planes stream in from off-screen in curved, non-parallel paths instead of
 * each following its own straight bezier.
 */
function stepFlock(agent, dt, others) {
  const flock = agent.flock;
  const MAX_SPEED = 560;
  const GAIN = 3.6; // how hard it chases its desired velocity

  const dx = flock.slot.x - agent.x;
  const dy = flock.slot.y - agent.y;
  const dist = Math.hypot(dx, dy) || 1;

  // arrive: slow down inside 220px so it lands instead of orbiting the slot
  const wanted = Math.min(MAX_SPEED, dist * 2.1);
  const dvx = (dx / dist) * wanted;
  const dvy = (dy / dist) * wanted;

  let ax = (dvx - agent.vx) * GAIN;
  let ay = (dvy - agent.vy) * GAIN;

  // separation from nearby planes
  let sepX = 0;
  let sepY = 0;
  for (const other of others) {
    if (other === agent) continue;
    const ox = agent.x - other.x;
    const oy = agent.y - other.y;
    const d2 = ox * ox + oy * oy;
    if (d2 > 7225 || d2 < 1) continue; // 85px
    sepX += ox / d2;
    sepY += oy / d2;
  }
  ax += sepX * 2600;
  ay += sepY * 2600;

  // a little wander so the flock curves instead of marching in lockstep
  flock.phase += dt * 1.1;
  ax += Math.cos(flock.phase + flock.seed) * 90;
  ay += Math.sin(flock.phase * 1.5 + flock.seed) * 90;

  const accel = Math.hypot(ax, ay) || 1;
  if (accel > 1500) {
    ax = (ax / accel) * 1500;
    ay = (ay / accel) * 1500;
  }

  agent.vx += ax * dt;
  agent.vy += ay * dt;
  const speed = Math.hypot(agent.vx, agent.vy) || 1;
  if (speed > MAX_SPEED) {
    agent.vx = (agent.vx / speed) * MAX_SPEED;
    agent.vy = (agent.vy / speed) * MAX_SPEED;
  }

  agent.x += agent.vx * dt;
  agent.y += agent.vy * dt;
  flock.t += dt;

  if ((dist < 12 && speed < 40) || flock.t > 5) {
    agent.x = flock.slot.x;
    agent.y = flock.slot.y;
    agent.vx = 0;
    agent.vy = 0;
    agent.to.x = flock.slot.x;
    agent.to.y = flock.slot.y;
    agent.flock = null;
  }
}

export function stepAgent(agent, time, dt, others) {
  if (agent.pinned) return; // the drag placed it this frame, 1:1 with the box corner
  const px = agent.x;
  const py = agent.y;

  let travelling = false;

  if (agent.flock) {
    stepFlock(agent, dt, others || []);
    travelling = true;
  } else if (agent.dur) {
    const k = (time - agent.start) / agent.dur;
    if (k >= 1) {
      // Idle shiver: agents never sit perfectly still. The shiver must not turn
      // the plane, otherwise a hovering plane slowly spins in a circle.
      agent.x = agent.to.x + Math.sin(time / 430 + agent.seed) * 1.5;
      agent.y = agent.to.y + Math.cos(time / 390 + agent.seed) * 1.5;
    } else {
      const e = easeOut(Math.max(0, k));
      const u = 1 - e;
      agent.x = u * u * agent.from.x + 2 * u * e * agent.ctrl.x + e * e * agent.to.x;
      agent.y = u * u * agent.from.y + 2 * u * e * agent.ctrl.y + e * e * agent.to.y;
      travelling = true;
    }
  }

  if (travelling) orient(agent, agent.x - px, agent.y - py, dt);
  writeTransform(agent);
}

function guides(doc) {
  const wrap = doc.createElement('div');
  wrap.className = 'sw-guides';
  for (const cls of ['v l', 'v r', 'h t', 'h b']) {
    const line = doc.createElement('i');
    line.className = cls;
    wrap.appendChild(line);
  }
  return wrap;
}

export function setGuides(wrap, on) {
  if (wrap) wrap.classList.toggle('is-on', !!on);
}

/** Figma-ish selection chrome: drawn outline, corner handles, + marks, size badge. */
export function createInspector(doc, color) {
  const el = doc.createElement('div');
  el.className = 'sw-insp';
  el.style.setProperty('--sw-c', color);

  const mask = doc.createElement('div');
  mask.className = 'sw-mask';
  el.appendChild(mask);

  for (const edge of ['t', 'b', 'l', 'r']) {
    const node = doc.createElement('div');
    node.className = 'sw-edge ' + edge;
    el.appendChild(node);
  }
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const node = doc.createElement('div');
    node.className = 'sw-handle ' + corner;
    el.appendChild(node);
  }
  for (const side of ['tm', 'bm']) {
    const node = doc.createElement('div');
    node.className = 'sw-plus ' + side;
    el.appendChild(node);
  }

  const badge = doc.createElement('div');
  badge.className = 'sw-badge';
  el.appendChild(badge);

  const guideLines = guides(doc);
  el.appendChild(guideLines);

  return { el, badge, guides: guideLines, drawn: false, x: NaN, y: NaN, w: NaN, h: NaN };
}

/** Writes only when the rect actually changed, so drags stay off the layout path
 *  except for the one box being dragged. */
export function drawInspector(insp, x, y, w, h) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  w = Math.max(0, w || 0);
  h = Math.max(0, h || 0);

  if (x !== insp.x || y !== insp.y) {
    insp.x = x;
    insp.y = y;
    insp.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
  }
  if (w !== insp.w || h !== insp.h) {
    insp.w = w;
    insp.h = h;
    insp.el.style.width = w.toFixed(1) + 'px';
    insp.el.style.height = h.toFixed(1) + 'px';
    insp.badge.textContent = fmtDim(w, h);
  }
  if (!insp.drawn && w > 0.5 && h > 0.5) {
    insp.drawn = true;
    insp.el.classList.add('is-drawn');
  }
}

/** Thin outline drawn while a layout box (part) is being dragged out. */
export function createBox(doc, color) {
  const el = doc.createElement('div');
  el.className = 'sw-box';
  el.style.setProperty('--sw-c', color);
  const mask = doc.createElement('div');
  mask.className = 'sw-mask';
  el.appendChild(mask);
  const badge = doc.createElement('div');
  badge.className = 'sw-badge';
  el.appendChild(badge);
  const guideLines = guides(doc);
  el.appendChild(guideLines);
  el.style.visibility = 'hidden'; // the plane flies there first, then the drag starts
  return { el, badge, guides: guideLines, x: NaN, y: NaN, w: NaN, h: NaN };
}

export function drawBox(box, x, y, w, h) {
  if (x !== box.x) {
    box.x = x;
    box.el.style.left = x.toFixed(1) + 'px';
  }
  if (y !== box.y) {
    box.y = y;
    box.el.style.top = y.toFixed(1) + 'px';
  }
  if (w !== box.w || h !== box.h) {
    box.w = w;
    box.h = h;
    box.el.style.width = w.toFixed(1) + 'px';
    box.el.style.height = h.toFixed(1) + 'px';
    box.badge.textContent = fmtDim(w, h);
  }
}
