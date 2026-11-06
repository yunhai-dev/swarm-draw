/** Unscaled timings (ms) for one layer's draw-in. Mirrors how a designer
 *  actually works: frame the artboard, block out the structure, write the copy,
 *  then apply colour last. */
export const TIMING = {
  mark: 520, // fly in to the corner, press
  frame: 700, // drag the artboard frame out of empty space
  release: 220, // drop it: the container exists, still wireframe
  travel: 160, // fly to the next block before touching it
  wire: 240, // drag that block open
  wireGap: 70,
  hold: 300, // whole layout is blocked out, still uncoloured
  fillGap: 70,
  polish: 460, // colour / depth arrive on the whole block
  settle: 240,
};

/**
 * Ordered steps for one layer:
 *   mark -> frame(drag) -> release -> wire each box -> layout done -> fill each box
 *   -> polish -> done
 *
 * `fills` is the content gesture duration per block (0 = content just appears),
 * so the plan waits for typing / pull-out / copy-drag to finish before moving on.
 * Layout strictly precedes content, and colour comes last. Times stay unscaled;
 * the runtime multiplies elapsed time by the speed multiplier.
 */
export function buildPlan(fills, timing = TIMING) {
  const durations = (Array.isArray(fills) ? fills : [0]).map((ms) => (Number(ms) > 0 ? Number(ms) : 0));
  const n = Math.max(1, durations.length);
  const steps = [];
  let time = 0;

  steps.push({ time, kind: 'mark' });
  time += timing.mark;
  steps.push({ time, kind: 'frame' });
  time += timing.frame;
  steps.push({ time, kind: 'release' });

  // Every visual change is preceded by an 'aim' step: the plane flies to the
  // block first, so nothing can appear before the cursor gets there.
  time += timing.wireGap;
  for (let i = 0; i < n; i++) {
    if (i) time += timing.wireGap;
    steps.push({ time, kind: 'aim', phase: 'box', index: i });
    time += timing.travel;
    steps.push({ time, kind: 'wire', index: i });
    time += timing.wire;
  }

  time += timing.hold;
  steps.push({ time, kind: 'layoutdone' });

  time += timing.fillGap;
  for (let i = 0; i < n; i++) {
    if (i) time += timing.fillGap;
    steps.push({ time, kind: 'aim', phase: 'fill', index: i });
    time += timing.travel;
    steps.push({ time, kind: 'fill', index: i });
    time += durations[i] ?? 0; // typing / pulling / copy-dragging takes real time
  }

  time += timing.polish;
  steps.push({ time, kind: 'polish' });

  time += timing.settle;
  steps.push({ time, kind: 'done' });

  return steps;
}

/** Next layer allowed to start, respecting the concurrency cap and the viewport. */
export function nextPending(layers, maxConcurrent, active) {
  if (active >= maxConcurrent) return null;
  for (const layer of layers) {
    if (layer.state === 'pending' && layer.inView) return layer;
  }
  return null;
}

/** True when pending work exists but none of it is on screen yet. */
export function needsScroll(layers) {
  let pending = 0;
  for (const layer of layers) {
    if (layer.state !== 'pending') continue;
    if (layer.inView) return false;
    pending += 1;
  }
  return pending > 0;
}

export const fmtDim = (w, h) => Math.round(w) + ' \u00d7 ' + Math.round(h);

export const easeOut = (k) => 1 - (1 - k) ** 3;
