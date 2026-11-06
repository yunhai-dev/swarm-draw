import { injectStyles, removeStyles } from './style.js';
import { TIMING, buildPlan, nextPending, needsScroll } from './plan.js';
import {
  createAgent,
  aim,
  placeAgent,
  stepAgent,
  createInspector,
  drawInspector,
  createBox,
  drawBox,
  setGuides,
} from './overlay.js';
import { createHud } from './hud.js';
import { inferKind, fillMs } from './kind.js';
import { detectLayers } from './detect.js';

const PALETTE = [
  '#f5961a', '#2e9e5b', '#17a3b8', '#7b61ff', '#e0457b',
  '#0f9e8f', '#e0a80a', '#e5533d', '#2f80ed', '#8cc63f',
];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const SPEEDS = [1, 2, 0.5];
const SPARKS = 10;
const INTRO_MS = 700; // let the flock fly in before the first region starts

/**
 * Overlay a swarm of agent cursors that draws the page in real time.
 *
 * Markup contract:
 *   <div data-swarm-layer>            a region that gets drawn
 *     <div data-swarm-part>...</div>  sub-blocks, revealed in document order
 *   </div>
 * Layers are flat: nested layers are ignored. Layer sizes are never changed by
 * the runtime, so the page never reflows while it is being "designed".
 */
export function createSwarm(options = {}) {
  const doc = options.document ?? document;
  const win = doc.defaultView;
  const layerSelector = options.layerSelector ?? '[data-swarm-layer]';
  const partSelector = options.partSelector ?? '[data-swarm-part]';
  const agentCount = Math.max(1, options.agents ?? 18);
  const colors = options.colors ?? PALETTE;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 6);
  const showHud = options.hud ?? true;
  const onDone = options.onDone ?? null;
  const autoDetect = options.auto ?? true;
  const debug = options.debug ?? false;
  const listeners = new Map();

  let layers = [];
  let agents = [];
  let built = 0;
  let active = 0;
  let speed = Number(options.speed) > 0 ? Number(options.speed) : 1;
  let running = false;
  let touring = options.tour ?? false;
  let raf = 0;
  let now = 0;
  let frame = 0;
  let syncedBuilt = -1;
  let lastScrollX = 0;
  let lastScrollY = 0;
  let sparks = [];
  let idle = false;
  let entering = 'bottom';
  let needsScan = false;
  let introUntil = 0;
  let root = null;
  let hud = null;

  // ---------------------------------------------------------------- layers

  function scan() {
    const marked = Array.from(doc.querySelectorAll(layerSelector));
    // Explicit markup wins; otherwise the page is inspected for card-like boxes.
    const found = marked.length
      ? marked.map((el) => ({ el, parts: Array.from(el.querySelectorAll(partSelector)) }))
      : autoDetect
        ? detectLayers(doc, {
            root: options.root,
            skip: options.skip,
            minWidth: options.minWidth,
            minHeight: options.minHeight,
            maxAreaRatio: options.maxAreaRatio,
            maxParts: options.maxParts,
            maxLayers: options.maxLayers,
          })
        : [];

    layers = found
      // A layer nested inside another layer is not a second artboard: its parts
      // are drawn as part of the ancestor. Nothing invisible is part of a run.
      .filter((entry) => {
        if (marked.length && entry.el.parentElement?.closest(layerSelector)) return false;
        const rect = entry.el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((entry) => {
        const el = entry.el;
        const parts = entry.parts;
        const list = parts.length ? parts : [el];
        // Parts may come from markup or from auto detection: the styling hooks
        // live on a class so both paths behave the same.
        for (const part of list) part.classList.add('sw-part');
        if (debug) {
          el.setAttribute('data-swarm-role', 'layer');
          for (const part of list) part.setAttribute('data-swarm-role', 'part');
        }
        const kinds = list.map(inferKind);
        // Every layer starts unpainted: the page is empty until an agent draws it.
        el.classList.add('sw-veiled');
        return {
          el,
          parts: list,
          kinds,
          fills: list.map((part, i) => fillMs(kinds[i], part)),
          state: 'pending',
          inView: false,
          plan: null,
          stepIndex: 0,
          startedAt: 0,
          insp: null,
          agent: null,
          focus: null,
          origin: null,
          size: null,
          drag: null,
          dragPart: null,
          box: null,
          released: false,
          aimX: NaN,
          aimY: NaN,
        };
      });
    built = 0;
    active = 0;
    syncedBuilt = -1;
    poolCache = { at: -1e9, list: [] };
  }

  function scanVisibility() {
    const viewport = win.innerHeight || 0;
    for (const layer of layers) {
      if (layer.state !== 'pending') continue;
      const rect = layer.el.getBoundingClientRect();
      layer.inView = rect.top < viewport - 40 && rect.bottom > 40;
    }
    hud?.setHint(needsScroll(layers) && !touring);
  }

  function begin(layer, agent) {
    layer.state = 'drawing';
    layer.startedAt = now;
    layer.stepIndex = 0;
    layer.plan = buildPlan(layer.fills);
    layer.agent = agent;
    agent.layer = layer;
    releaseBrowse(agent);
    active += 1;

    const rect = layer.el.getBoundingClientRect();

    layer.insp = createInspector(doc, agent.color);
    root.appendChild(layer.insp.el);
    drawInspector(layer.insp, rect.left, rect.top, 0, 0);

    // Fly in to the top-left corner: the frame drag starts exactly there.
    aim(agent, rect.left, rect.top, now, TIMING.mark / speed);
  }

  function advance(layer) {
    const elapsed = (now - layer.startedAt) * speed;
    while (layer.stepIndex < layer.plan.length) {
      const step = layer.plan[layer.stepIndex];
      if (step.time > elapsed) break;
      layer.stepIndex += 1;
      applyStep(layer, step);
    }
  }

  function applyStep(layer, step) {
    switch (step.kind) {
      case 'frame': {
        layer.insp.el.classList.add('is-framing');
        setGuides(layer.insp.guides, true);
        layer.drag = { start: now, dur: Math.max(1, TIMING.frame / speed) };
        const rect = layer.el.getBoundingClientRect();
        placeAgent(layer.agent, rect.left, rect.top);
        break;
      }

      case 'release': {
        // Frame is done -> it becomes the real container: still empty, still grey.
        layer.drag = null;
        layer.released = true;
        layer.insp.el.classList.remove('is-framing');
        setGuides(layer.insp.guides, false);
        const rect = layer.el.getBoundingClientRect();
        drawInspector(layer.insp, rect.left, rect.top, rect.width, rect.height);
        layer.el.classList.remove('sw-veiled');
        layer.el.classList.add('sw-laying', 'sw-wireframe');
        break;
      }

      case 'aim': {
        // Nothing visual happens here: the plane flies to the block it is about
        // to touch, so no change can land ahead of the cursor.
        const part = layer.parts[step.index];
        const rect = part.getBoundingClientRect();
        const y = step.phase === 'fill' ? rect.top + Math.min(rect.height * 0.5, 18) : rect.top;
        aim(layer.agent, rect.left, y, now, Math.max(60, TIMING.travel / speed));
        break;
      }

      case 'wire': {
        // One box per part, in document order: parents before children, like a
        // designer blocking out a layout. The plane is already parked on the
        // top-left corner, so the drag starts on this frame.
        const part = layer.parts[step.index];
        if (part.textContent.trim()) part.classList.add('sw-wire-text');
        part.classList.add('sw-wire');
        layer.box?.el.remove();

        const rect = part.getBoundingClientRect();
        layer.box = createBox(doc, layer.agent ? layer.agent.color : '#1a8cff');
        layer.box.el.classList.add('sw-drag');
        root.appendChild(layer.box.el);
        drawBox(layer.box, rect.left, rect.top, 0, 0);

        layer.dragPart = {
          part,
          start: now,
          dur: Math.max(1, TIMING.wire / speed),
        };
        placeAgent(layer.agent, rect.left, rect.top);
        break;
      }

      case 'layoutdone': {
        layer.box?.el.remove();
        layer.box = null;
        layer.dragPart = null;
        layer.focus = null;
        trackAgent(layer, layer.el.getBoundingClientRect());
        break;
      }

      case 'fill': {
        startFill(layer, step.index);
        break;
      }

      case 'polish': {
        // Colour and depth land on the whole block at once, the way a designer
        // applies the final style.
        layer.el.classList.add('sw-polishing');
        layer.el.classList.remove('sw-wireframe');
        break;
      }

      case 'done':
        finish(layer);
        break;
    }
  }

  /** Content gesture: typing (text), pull-out (button) or copy-drag (item). */
  function startFill(layer, index) {
    const part = layer.parts[index];
    const kind = layer.kinds[index];
    const ms = layer.fills[index];

    part.classList.remove('sw-wire', 'sw-wire-text');
    layer.focus = part;

    const rect = part.getBoundingClientRect();

    if (kind === 'item') {
      // Duplicate the row and drag the copy in from the previous row's slot.
      const ghost = part.cloneNode(true);
      ghost.removeAttribute('id');
      for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
      for (const node of ghost.querySelectorAll('[data-swarm-part]')) node.removeAttribute('data-swarm-part');
      ghost.classList.add('sw-ghost');
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      root.appendChild(ghost);

      const prev = part.previousElementSibling;
      const prevRect = prev ? prev.getBoundingClientRect() : null;
      const from =
        prevRect && prevRect.height
          ? { x: prevRect.left - rect.left, y: prevRect.top - rect.top }
          : { x: 0, y: -rect.height - 10 };

      layer.fillAnim = { part, kind, start: now, dur: ms / speed, ghost, from };
      return;
    }

    // Typing advances one character cell at a time, so it reads as keystrokes.
    // Everything else is dragged out of its top-left corner as a growing shape.
    const chars = kind === 'text' ? Math.max(1, (part.textContent || '').trim().length) : 0;
    part.classList.add('sw-filled', kind === 'text' ? 'sw-typing' : 'sw-pull');
    part.style.setProperty('--sw-reveal', '0');
    layer.fillAnim = { part, kind, start: now, dur: ms / speed, ghost: null, chars };
  }

  function animateFill(layer) {
    const anim = layer.fillAnim;
    const k = Math.min(1, (now - anim.start) / anim.dur);
    const rect = anim.part.getBoundingClientRect();

    if (anim.ghost) {
      const dx = anim.from.x * (1 - k);
      const dy = anim.from.y * (1 - k);
      anim.ghost.style.left = rect.left + 'px';
      anim.ghost.style.top = rect.top + 'px';
      anim.ghost.style.width = rect.width + 'px';
      anim.ghost.style.height = rect.height + 'px';
      anim.ghost.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
      placeAgent(
        layer.agent,
        rect.left + rect.width + dx,
        rect.top + rect.height + dy,
      );
      if (k >= 1) {
        anim.ghost.remove();
        anim.part.classList.add('sw-filled');
        layer.fillAnim = null;
      }
      return;
    }

    const reveal = anim.chars ? Math.round(k * anim.chars) / anim.chars : k;
    anim.part.style.setProperty('--sw-reveal', reveal.toFixed(3));
    placeAgent(
      layer.agent,
      rect.left + rect.width * reveal,
      rect.top + rect.height * 0.55,
    );
    if (k >= 1) {
      anim.part.classList.remove('sw-typing', 'sw-pull');
      layer.fillAnim = null;
    }
  }

  function focusRect(layer) {
    let rect = (layer.focus ?? layer.el).getBoundingClientRect();
    if (!rect.width && !rect.height) rect = layer.el.getBoundingClientRect();
    return rect;
  }

  /** Re-aim only when the target moved: keeps the cursor glued to its element
   *  while the page scrolls, without restarting the curve every frame. */
  function trackAgent(layer, rect) {
    if (!layer.agent || (!rect.width && !rect.height)) return;
    const x = rect.left + rect.width * 0.65;
    const y = rect.top + rect.height * 0.7;
    if (Math.abs(x - layer.aimX) < 10 && Math.abs(y - layer.aimY) < 10) return;
    layer.aimX = x;
    layer.aimY = y;
    aim(layer.agent, x, y, now, 240 / speed);
  }

  function finish(layer) {
    layer.state = 'done';
    active -= 1;
    built += 1;

    layer.drag = null;
    layer.dragPart = null;
    if (layer.box) {
      layer.box.el.remove();
      layer.box = null;
    }
    layer.fillAnim = null;
    layer.el.classList.remove('sw-veiled', 'sw-laying', 'sw-wireframe', 'sw-polishing');
    layer.el.removeAttribute('data-swarm-role');
    for (const part of layer.parts) {
      part.classList.remove('sw-part', 'sw-wire', 'sw-wire-text', 'sw-filled', 'sw-typing', 'sw-pull');
      part.removeAttribute('data-swarm-role');
      part.style.removeProperty('--sw-reveal');
      if (!part.style.length) part.removeAttribute('style');
    }
    if (layer.insp) {
      layer.insp.el.remove();
      layer.insp = null;
    }
    if (layer.agent) {
      const agent = layer.agent;
      agent.layer = null;
      layer.agent = null;
      aim(agent, agent.x + (Math.random() - 0.5) * 120, agent.y + 60 + Math.random() * 80, now, 520 / speed);
    }

    if (built === layers.length) {
      for (const agent of agents) releaseBrowse(agent);
      setTouring(false);
      startFinale();
      emit('done', { built, total: layers.length });
      onDone?.({ built, total: layers.length });
    }
  }

  function paintInspectors() {
    for (const layer of layers) {
      if (layer.state !== 'drawing' || !layer.insp) continue;

      if (layer.drag) {
        // Dragging the layer frame: read the live rect so scrolling can never
        // leave the frame behind the element it is drawing.
        const rect = layer.el.getBoundingClientRect();
        const k = Math.min(1, (now - layer.drag.start) / layer.drag.dur);
        const w = rect.width * k;
        const h = rect.height * k;
        drawInspector(layer.insp, rect.left, rect.top, w, h);
        placeAgent(layer.agent, rect.left + w, rect.top + h);
        continue;
      }

      if (layer.dragPart && layer.box) {
        const drag = layer.dragPart;
        if (now < drag.start) continue; // the plane is still flying to the corner

        if (!drag.live) {
          drag.live = true;
          layer.box.el.style.visibility = 'visible';
          setGuides(layer.box.guides, true);
        }

        const rect = drag.part.getBoundingClientRect();
        const k = Math.min(1, (now - drag.start) / drag.dur);
        const w = rect.width * k;
        const h = rect.height * k;
        drawBox(layer.box, rect.left, rect.top, w, h);
        placeAgent(layer.agent, rect.left + w, rect.top + h);

        if (k >= 1) {
          layer.box.el.remove();
          layer.box = null;
          layer.dragPart = null;
        }
        continue;
      }

      if (layer.fillAnim) animateFill(layer);

      // Before the frame is dropped the chrome is a zero-size marker, but it
      // still has to follow the element so nothing is left stale by a scroll.
      const own = layer.el.getBoundingClientRect();
      drawInspector(
        layer.insp,
        own.left,
        own.top,
        layer.released ? own.width : 0,
        layer.released ? own.height : 0,
      );
      if (layer.focus && !layer.fillAnim) trackAgent(layer, focusRect(layer));
    }
  }

  // ---------------------------------------------------------------- agents

  function spawnAgents(entry = 'random') {
    const width = win.innerWidth || 1200;
    const height = win.innerHeight || 800;

    agents = Array.from({ length: agentCount }, (_, index) => {
      const color = colors[index % colors.length];
      let x = 40 + Math.random() * 260;
      let y = 120 + Math.random() * 320;
      if (entry === 'bottom') {
        x = 40 + Math.random() * Math.max(80, width - 80);
        y = height + 40 + Math.random() * 140;
      } else if (entry === 'top') {
        x = 40 + Math.random() * Math.max(80, width - 80);
        y = -60 - Math.random() * 140;
      }
      const agent = createAgent(doc, color, x, y);
      agent.initial = LETTERS[Math.floor(Math.random() * LETTERS.length)];
      agent.browse = { target: null, layerRef: null, box: null, next: 0, arrive: 0, until: 0, shown: false };
      root.appendChild(agent.el);
      return agent;
    });
  }

  /** Give every plane a slot in a loose grid and let the flock steering fly
   *  them there from off-screen. */
  function startFlock() {
    const width = win.innerWidth || 1200;
    const height = win.innerHeight || 800;
    const cols = Math.min(6, Math.max(1, agents.length));
    const rows = Math.max(1, Math.ceil(agents.length / cols));

    agents.forEach((agent, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      agent.flock = {
        slot: {
          x: (width * (col + 0.5)) / cols + (Math.random() - 0.5) * 80,
          y: (height * (row + 0.5)) / rows + (Math.random() - 0.5) * 80,
        },
        vx: (Math.random() - 0.5) * 80,
        vy: entering === 'top' ? 240 : -260,
        phase: Math.random() * Math.PI * 2,
        seed: Math.random() * 100,
        t: 0,
      };
    });
  }

  function startPending() {
    for (;;) {
      const free = agents.filter((item) => !item.layer);
      if (!free.length) return;
      const layer = nextPending(layers, maxConcurrent, active);
      if (!layer) return;
      // random pick: the same few cursors must not hoard every region
      begin(layer, free[(Math.random() * free.length) | 0]);
    }
  }

  // ---------------------------------------------------------------- idle hover

  let poolCache = { at: -1e9, list: [] };

  /** Blocks an idle agent may look at: only ones inside a region that is being
   *  drawn right now, so every measurement box sits next to real work. */
  function idlePool() {
    if (now - poolCache.at < 500) return poolCache.list;
    const viewport = win.innerHeight || 0;
    const list = [];
    for (const layer of layers) {
      if (layer.state !== 'drawing' || !layer.released) continue;
      for (const part of layer.parts) {
        const rect = part.getBoundingClientRect();
        if (rect.bottom < 40 || rect.top > viewport - 40 || rect.width < 8 || rect.height < 8) continue;
        list.push({ part, layer });
      }
    }
    poolCache = { at: now, list };
    return list;
  }

  /** Idle agents keep circling laid-out blocks with a measurement box, so the
   *  swarm never looks like it is waiting in a queue. */
  function stepIdle(agent) {
    if (agent.layer || !active) return;
    const browse = agent.browse;

    if (!browse.target) {
      if (now < browse.next) return;
      const pool = idlePool();
      if (!pool.length) {
        browse.next = now + 500;
        return;
      }
      const pick = pool[(Math.random() * pool.length) | 0];
      browse.target = pick.part;
      browse.layerRef = pick.layer;
      const rect = pick.part.getBoundingClientRect();
      aim(agent, rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, now, 420 + Math.random() * 380);
      browse.arrive = now + agent.dur;
      browse.until = browse.arrive + 520 + Math.random() * 520;
      return;
    }

    if (browse.layerRef.state !== 'drawing') {
      // the region it was watching is finished: stop measuring it
      hideBrowseBox(browse);
      browse.target = null;
      browse.next = now + 120;
      return;
    }

    if (now < browse.arrive) return;

    const rect = browse.target.getBoundingClientRect();
    const first = !browse.shown;
    if (first) {
      browse.shown = true;
      if (!browse.box) {
        browse.box = createBox(doc, agent.color);
        root.appendChild(browse.box.el);
      }
      browse.box.el.style.visibility = 'visible';
    }
    drawBox(browse.box, rect.left, rect.top, rect.width, rect.height);

    if (now > browse.until) {
      hideBrowseBox(browse);
      browse.target = null;
      browse.next = now + 120 + Math.random() * 300;
    }
  }

  /** The finished swarm blooms: each plane turns into a firework and disappears. */
  function startFinale() {
    if (!agents.length) return;
    hud?.setHint(false);

    for (const agent of agents) {
      const x = agent.x;
      const y = agent.y;

      const ring = doc.createElement('i');
      ring.className = 'sw-ring';
      ring.style.setProperty('--sw-c', agent.color);
      root.appendChild(ring);
      sparks.push({ el: ring, ring: true, x, y, t: 0, life: 0.55 });

      for (let i = 0; i < SPARKS; i++) {
        const angle = (Math.PI * 2 * i) / SPARKS + Math.random() * 0.6;
        const speed = 90 + Math.random() * 160;
        const size = 3 + Math.random() * 3;

        const spark = doc.createElement('i');
        spark.className = 'sw-spark';
        spark.style.setProperty('--sw-c', agent.color);
        spark.style.width = size.toFixed(1) + 'px';
        spark.style.height = size.toFixed(1) + 'px';
        root.appendChild(spark);

        sparks.push({
          el: spark,
          x,
          y,
          half: size / 2,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 50,
          t: 0,
          life: 0.65 + Math.random() * 0.5,
        });
      }

      // the plane itself pops out
      agent.el.style.transition = 'opacity .16s linear, transform .16s ease-out';
      agent.el.style.opacity = '0';
    }
  }

  function stepSparks(dtSeconds) {
    const alive = [];
    for (const spark of sparks) {
      spark.t += dtSeconds;
      const k = Math.min(1, spark.t / spark.life);

      if (spark.ring) {
        spark.el.style.transform =
          'translate3d(' + spark.x.toFixed(1) + 'px,' + spark.y.toFixed(1) + 'px,0) scale(' +
          (1 + k * 7).toFixed(2) + ')';
        spark.el.style.opacity = (0.55 * (1 - k)).toFixed(3);
      } else {
        spark.vy += 240 * dtSeconds; // a little gravity
        spark.x += spark.vx * dtSeconds;
        spark.y += spark.vy * dtSeconds;
        spark.el.style.transform =
          'translate3d(' + (spark.x - spark.half).toFixed(1) + 'px,' +
          (spark.y - spark.half).toFixed(1) + 'px,0)';
        spark.el.style.opacity = (1 - k).toFixed(3);
      }

      if (k >= 1) spark.el.remove();
      else alive.push(spark);
    }
    sparks = alive;

    if (!sparks.length) {
      for (const agent of agents) agent.el.remove();
      agents = [];
      idle = true;
    }
  }

  function hasVisibleWork() {
    return layers.some((layer) => layer.state === 'pending' && layer.inView);
  }

  /** Every plane has left the stage: bring them back for the next screenful. */
  function resumeSwarm() {
    idle = false;
    spawnAgents(entering);
    startFlock();
  }

  function shouldLeave() {
    return (
      !idle &&
      !sparks.length &&
      agents.length > 0 &&
      active === 0 &&
      !touring &&
      now >= introUntil &&
      !hasVisibleWork()
    );
  }

  function hideBrowseBox(browse) {
    if (browse.box) {
      browse.box.el.remove();
      browse.box = null;
    }
    browse.shown = false;
  }

  function releaseBrowse(agent) {
    const browse = agent.browse;
    if (!browse) return;
    hideBrowseBox(browse);
    browse.target = null;
    browse.layerRef = null;
    browse.next = now + 300;
  }

  // ---------------------------------------------------------------- tour

  function scrollTour(dt) {
    const next = layers.find((layer) => layer.state === 'pending');
    if (!next) {
      setTouring(false);
      return;
    }
    const rect = next.el.getBoundingClientRect();
    const margin = Math.max(80, (win.innerHeight - rect.height) / 2);
    const delta = rect.top - margin;
    if (Math.abs(delta) < 6) return;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 16 * speed * (dt / 16.7));
    win.scrollTo(0, win.scrollY + step);
  }

  function onViewportChange() {
    if (!running) return;
    needsScan = true;
    if (!raf) raf = win.requestAnimationFrame(tick);
  }

  function setTouring(on) {
    touring = !!on;
    hud?.setTouring(touring);
    hud?.setHint(false);
    if (touring && running && !raf) raf = win.requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- scroll

  /** Planes live in viewport coordinates, so a scroll must move them with the
   *  page; otherwise every gesture drifts away from its element. */
  function syncScroll() {
    const sx = win.scrollX || 0;
    const sy = win.scrollY || 0;
    const dx = sx - lastScrollX;
    const dy = sy - lastScrollY;
    if (!dx && !dy) return;
    lastScrollX = sx;
    lastScrollY = sy;

    for (const agent of agents) {
      agent.x += dx;
      agent.y += dy;
      agent.from.x += dx;
      agent.from.y += dy;
      agent.to.x += dx;
      agent.to.y += dy;
      agent.ctrl.x += dx;
      agent.ctrl.y += dy;
      agent.el.style.transform =
        'translate3d(' + agent.x.toFixed(1) + 'px,' + agent.y.toFixed(1) + 'px,0)';
    }
    for (const layer of layers) {
      if (!Number.isNaN(layer.aimX)) layer.aimX += dx;
      if (!Number.isNaN(layer.aimY)) layer.aimY += dy;
    }
    if (dy > 0) entering = 'bottom';
    else if (dy < 0) entering = 'top';
  }

  // ---------------------------------------------------------------- loop

  function tick(timestamp) {
    if (!running) return;
    const dt = now ? Math.min(64, timestamp - now) : 16.7;
    now = timestamp;
    frame += 1;

    if (!introUntil) introUntil = now + INTRO_MS;
    syncScroll();
    if (needsScan || frame % 8 === 1) {
      needsScan = false;
      scanVisibility();
    }

    // A new screenful of work means the swarm has to come back before anything
    // is scheduled, otherwise a stale (removed) plane would be handed the job.
    if (idle && hasVisibleWork()) resumeSwarm();

    for (const layer of layers) {
      if (layer.state === 'drawing') advance(layer);
    }
    // Scroll first, then paint: chrome must be laid out against the post-scroll
    // rect, otherwise everything trails the page by one frame.
    if (touring) {
      scrollTour(dt);
      syncScroll();
    }
    if (now >= introUntil) startPending();
    paintInspectors();

    // Nothing is being drawn -> the swarm stands still instead of fiddling with
    // finished blocks: no hovering, no drifting, no idle twitching.
    const animating = active > 0 || touring || now < introUntil;
    for (const agent of agents) {
      if (!agent.layer) {
        if (active > 0) stepIdle(agent);
        else if (agent.browse.target || agent.browse.shown) releaseBrowse(agent);
      }
      if (animating) stepAgent(agent, now, dt / 1000, agents);
    }

    if (sparks.length) stepSparks(dt / 1000);

    // Nothing left on this screenful: the swarm bows out and waits for the user
    // to scroll into new work, instead of hovering over finished blocks.
    if (shouldLeave()) startFinale();

    if (hud && built !== syncedBuilt) {
      syncedBuilt = built;
      hud.setStats(built, layers.length);
    }

    const busy = active > 0 || touring || sparks.length > 0 || now < introUntil;
    if (busy) raf = win.requestAnimationFrame(tick);
    else raf = 0;
  }

  // ---------------------------------------------------------------- api

  const api = {
    start() {
      if (running) return api;
      running = true;
      now = 0;
      frame = 0;
      introUntil = 0;
      lastScrollX = win.scrollX || 0;
      lastScrollY = win.scrollY || 0;
      touring = options.tour ?? touring;

      injectStyles(doc);
      root = doc.createElement('div');
      root.className = 'sw-root';
      doc.body.appendChild(root);

      spawnAgents('bottom');
      startFlock();
      if (showHud) {
        hud = createHud(doc, {
          agents,
          onTour: () => setTouring(!touring),
          onSpeed: () => {
            speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
            hud.setSpeed(speed);
          },
          onClose: () => api.stop(),
        });
        root.appendChild(hud.el);
        hud.setSpeed(speed);
        hud.setTouring(touring);
      }

      scan();
      scanVisibility();
      hud?.setStats(0, layers.length);
      win.addEventListener('scroll', onViewportChange, { passive: true });
      win.addEventListener('resize', onViewportChange);

      raf = win.requestAnimationFrame(tick);
      return api;
    },

    stop() {
      if (!running) return api;
      running = false;
      idle = false;
      introUntil = 0;
      win.removeEventListener('scroll', onViewportChange);
      win.removeEventListener('resize', onViewportChange);
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;

      for (const layer of layers) {
        layer.el.removeAttribute('data-swarm-role');
        layer.el.classList.remove('sw-veiled', 'sw-laying', 'sw-wireframe', 'sw-polishing');
        for (const part of layer.parts) {
          part.classList.remove('sw-part', 'sw-wire', 'sw-wire-text', 'sw-filled', 'sw-typing', 'sw-pull');
          part.removeAttribute('data-swarm-role');
          part.style.removeProperty('--sw-reveal');
          if (!part.style.length) part.removeAttribute('style');
        }
      }
      layers = [];
      agents = [];
      sparks = [];
      built = 0;
      active = 0;
      root?.remove();
      root = null;
      hud = null;
      removeStyles(doc);
      return api;
    },

    tour(on = true) {
      setTouring(on);
      return api;
    },

    setSpeed(value) {
      const next = Number(value);
      if (next > 0) {
        speed = next;
        hud?.setSpeed(speed);
      }
      return api;
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },

    get state() {
      return {
        built,
        total: layers.length,
        active,
        agents: agentCount,
        running,
        touring,
        speed,
      };
    },
  };

  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  }

  return api;
}
