import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TIMING, buildPlan, fmtDim, needsScroll, nextPending } from '../src/plan.js';
import { inferKind, fillMs } from '../src/kind.js';
import { CSS } from '../src/style.js';
import { createSwarm } from '../src/index.js';

const STEP = 16.7;
const readTransform = (el) => {
  if (!el) return null;
  const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px,[^)]*\)(?:\s*rotate\((-?[\d.]+)deg\))?/.exec(
    el.style.transform || '',
  );
  return match
    ? { x: Number(match[1]), y: Number(match[2]), a: match[3] === undefined ? 0 : Number(match[3]) }
    : null;
};

/** The plane that owns the (single) layer currently being drawn. */
const workerTip = (doc) => {
  const insp = doc.querySelector('.sw-insp');
  if (!insp) return null;
  const color = insp.style.getPropertyValue('--sw-c');
  const cursor = [...doc.querySelectorAll('.sw-cursor')].find((node) => node.innerHTML.includes(color));
  return readTransform(cursor);
};

function makeHarness({
  layers = 3,
  parts = 2,
  maxConcurrent = 4,
  speed = 1,
  agents = 6,
  gap = 300,
  body,
  rects,
} = {}) {
  const markup =
    body ??
    Array.from({ length: layers }, (_, i) => {
      const id = 'l' + i;
      const inner = Array.from(
        { length: parts },
        (_, j) => '<div data-swarm-part id="' + id + 'p' + j + '">p' + j + '</div>',
      ).join('');
      return '<section data-swarm-layer id="' + id + '">' + inner + '</section>';
    }).join('');

  const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
    pretendToBeVisual: true,
  });
  const win = dom.window;

  const queue = [];
  let clock = 0;
  let scroll = 0;
  let peakInFlight = 0;

  win.requestAnimationFrame = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  win.cancelAnimationFrame = () => {
    queue.length = 0;
  };
  Object.defineProperty(win, 'innerHeight', { value: 900, configurable: true });
  win.scrollTo = (...args) => {
    scroll = args[args.length - 1];
  };
  Object.defineProperty(win, 'scrollY', { get: () => scroll, configurable: true });

  // Synthetic layout: layer i sits at 100 + i * gap, shifted by the scroll offset.
  const layout = rects ?? {};
  if (!rects) {
    for (let i = 0; i < layers; i++) {
      const top = 100 + i * gap;
      layout['l' + i] = [top, 40, 600, 220];
      for (let j = 0; j < parts; j++) layout['l' + i + 'p' + j] = [top + 20 + j * 60, 60, 300, 40];
    }
  }
  win.Element.prototype.getBoundingClientRect = function () {
    const rect = layout[this.id];
    if (!rect) return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
    const top = rect[0] - scroll;
    return {
      top,
      left: rect[1],
      width: rect[2],
      height: rect[3],
      right: rect[1] + rect[2],
      bottom: top + rect[3],
      x: rect[1],
      y: top,
    };
  };

  const doc = win.document;
  const swarm = createSwarm({ document: doc, agents, maxConcurrent, speed, hud: true });

  return {
    win,
    doc,
    swarm,
    rects: layout,
    pump(frames) {
      for (let i = 0; i < frames; i++) {
        clock += STEP;
        for (const cb of queue.splice(0)) cb(clock);
        peakInFlight = Math.max(peakInFlight, doc.querySelectorAll('.sw-insp').length);
      }
    },
    runUntilDone(maxFrames = 2000) {
      let frames = 0;
      while (swarm.state.built < swarm.state.total && frames < maxFrames) {
        this.pump(1);
        frames += 1;
      }
      return frames;
    },
    get peakInFlight() {
      return peakInFlight;
    },
    get scroll() {
      return scroll;
    },
    setScroll(value) {
      scroll = value;
      win.dispatchEvent(new win.Event('scroll'));
    },
  };
}

test('buildPlan runs mark -> frame -> release -> layout -> fill -> done, times strictly increasing', () => {
  const plan = buildPlan([240, 240, 240]);
  assert.deepEqual(
    plan.map((step) => step.kind),
    [
      'mark', 'frame', 'release',
      'aim', 'wire', 'aim', 'wire', 'aim', 'wire', 'layoutdone',
      'aim', 'fill', 'aim', 'fill', 'aim', 'fill',
      'polish', 'done',
    ],
  );
  assert.equal(plan[0].time, 0);
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].time > plan[i - 1].time, 'step ' + i + ' must come after step ' + (i - 1));
  }

  const release = plan.find((step) => step.kind === 'release').time;
  const firstFill = plan.find((step) => step.kind === 'fill').time;
  const lastWire = plan.filter((step) => step.kind === 'wire').at(-1).time;
  assert.ok(release < lastWire, 'all layout boxes are dragged after the frame is dropped');
  assert.ok(lastWire < firstFill, 'content never starts before the last layout box');
  assert.ok(firstFill - release > 800, 'layout phase is not instant: ' + (firstFill - release) + 'ms');

  const polish = plan.find((step) => step.kind === 'polish').time;
  const lastFill = plan.filter((step) => step.kind === 'fill').at(-1).time;
  assert.ok(polish > lastFill, 'colour lands after the last piece of copy');

  // the plan must reserve the real gesture time (typing / pull-out / copy-drag)
  const slow = buildPlan([0, 500, 0]);
  const slowFill = slow.find((step) => step.kind === 'fill' && step.index === 1).time;
  const nextAim = slow.find((step) => step.kind === 'aim' && step.phase === 'fill' && step.index === 2).time;
  assert.equal(nextAim - slowFill, 500 + TIMING.fillGap, 'the plan waits for the typing gesture');

  // every visual change waits for its own aim step
  for (const kind of ['wire', 'fill']) {
    for (const step of plan.filter((item) => item.kind === kind)) {
      const index = plan.indexOf(step);
      const aim = plan[index - 1];
      assert.equal(aim.kind, 'aim', kind + ' must be preceded by an aim step');
      assert.equal(aim.index, step.index);
      assert.equal(
        plan.findIndex((item) => item.kind === 'aim' && item.index === step.index && item.phase === (kind === 'wire' ? 'box' : 'fill')),
        index - 1,
      );
      assert.equal(step.time - aim.time, TIMING.travel, 'the plane gets exactly one travel window to arrive');
    }
  }
});

test('CSS gating: unpainted layers stay hidden, wired parts show only a gray box, filled parts show content', () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><style>' + CSS + '</style></head><body>' +
      '<section id="layer" class="sw-laying sw-wireframe">' +
        '<h3 id="wired" class="sw-part sw-wire sw-wire-text">a<span id="wiredChild">x</span></h3>' +
        '<div id="plain" class="sw-part sw-wire">b</div>' +
        '<div id="filled" class="sw-part sw-filled">b<span id="filledChild">y</span></div>' +
        '<div id="pending" class="sw-part">c<span id="pendingChild">z</span></div>' +
        '<p id="bare">bare text</p>' +
      '</section>' +
      '<section id="veiled" class="sw-veiled"><div data-swarm-part>x</div></section>' +
    '</body></html>',
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  const vis = (id) => win.getComputedStyle(win.document.getElementById(id)).visibility;

  assert.equal(vis('veiled'), 'hidden', 'an unpainted layer paints nothing');
  assert.equal(vis('bare'), 'visible', 'container chrome comes with the container, not at the end');
  assert.equal(vis('wired'), 'visible');
  assert.equal(vis('wiredChild'), 'hidden', 'a layout box shows as a gray box only');
  assert.equal(win.getComputedStyle(win.document.getElementById('wired')).backgroundColor, 'rgb(223, 225, 230)');
  assert.equal(vis('filled'), 'visible');
  assert.equal(vis('filledChild'), 'visible', 'filled content must actually be revealed');
  assert.equal(vis('pending'), 'hidden');
  assert.equal(vis('pendingChild'), 'hidden');

  const style = (id) => win.getComputedStyle(win.document.getElementById(id));
  assert.match(style('wired').backgroundImage, /repeating-linear-gradient/, 'copy blocks show filler text bars');
  assert.equal(style('plain').backgroundImage, 'none', 'blocks without copy stay solid');
  assert.equal(style('layer').filter, 'saturate(0)', 'the container is wireframe grey until the polish pass');
});

function makeAutoPage(markup, sizes, options = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head><style>' +
      '.card{background:#fff;border:1px solid #e8eaee;border-radius:10px;padding:12px}' +
      '.panel{background:#fff;border:1px solid #eee}' +
      '.plain{background:transparent}' +
      '</style></head><body>' + markup + '</body></html>',
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  const doc = win.document;
  const queue = [];
  let clock = 0;

  Object.defineProperty(win, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: 1200, configurable: true });
  win.requestAnimationFrame = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  win.cancelAnimationFrame = () => {
    queue.length = 0;
  };
  win.scrollTo = () => {};
  Object.defineProperty(win, 'scrollY', { get: () => 0, configurable: true });

  win.Element.prototype.getBoundingClientRect = function () {
    const size = sizes[this.id] || (this.dataset && this.dataset.size) || '';
    const [w, h] = size.split('x').map(Number);
    const width = w || 0;
    const height = h || 0;
    return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 };
  };

  const swarm = createSwarm({ document: doc, agents: 4, maxConcurrent: 2, ...options });
  return {
    win,
    doc,
    swarm,
    pump(frames) {
      for (let i = 0; i < frames; i++) {
        clock += 16.7;
        for (const cb of queue.splice(0)) cb(clock);
      }
    },
  };
}

test('without any markup the library finds the cards and their innermost blocks', () => {
  const page = makeAutoPage(
    '<div id="wrap">' +
      '<section class="card" id="cardA" data-size="620x240">' +
        '<h3 id="aTitle" data-size="300x30">标题<em>副</em></h3>' +
        '<div id="aRow" data-size="600x60"><span id="aPill" data-size="80x20">tag</span></div>' +
        '<a id="aBtn" href="#" data-size="120x32">充值</a>' +
      '</section>' +
      '<section class="card" id="cardB" data-size="620x200">' +
        '<ul id="aList" data-size="600x120"><li id="li1" data-size="600x30">a</li><li id="li2" data-size="600x30">b</li></ul>' +
      '</section>' +
    '</div>',
    {},
  );

  page.swarm.start();
  assert.equal(page.swarm.state.total, 2, 'two painted cards detected');
  assert.ok(page.doc.getElementById('cardA').classList.contains('sw-veiled'), 'the card is the artboard');
  assert.equal(page.doc.getElementById('wrap').classList.contains('sw-veiled'), false, 'the wrapper is not');

  const wired = new Set();
  for (let f = 0; f < 900; f++) {
    page.pump(1);
    for (const el of page.doc.querySelectorAll('.sw-wire')) wired.add(el.id);
  }

  assert.deepEqual([...wired].sort(), ['aBtn', 'aRow', 'aTitle', 'li1', 'li2'], 'innermost blocks only');
  assert.equal(wired.has('aPill'), false, 'inline badges belong to their block');
  assert.equal(wired.has('aList'), false, 'the list wrapper is not a block');
  page.swarm.stop();
});

test('root: an explicit selector limits the scope, and may itself be the artboard', () => {
  const page = makeAutoPage(
    '<div class="card" id="outside" data-size="620x200"><p id="op" data-size="200x20">out</p></div>' +
    '<div id="scope">' +
      '<section class="card" id="inner" data-size="620x240"><h3 id="t" data-size="300x30">t</h3></section>' +
    '</div>',
    {},
    { root: '#inner' },
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 1);
  assert.ok(page.doc.getElementById('inner').classList.contains('sw-veiled'), 'the root itself is drawn');
  assert.equal(page.doc.getElementById('outside').classList.contains('sw-veiled'), false);
  page.swarm.stop();
});

test('root: a container selector scans inside it only', () => {
  const page = makeAutoPage(
    '<section class="card" id="outside" data-size="620x200"><p id="op" data-size="200x20">out</p></section>' +
    '<div id="scope"><section class="card" id="inner" data-size="620x240"><h3 id="t" data-size="300x30">t</h3></section></div>',
    {},
    { root: '#scope' },
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 1);
  assert.ok(page.doc.getElementById('inner').classList.contains('sw-veiled'));
  assert.equal(page.doc.getElementById('outside').classList.contains('sw-veiled'), false);
  page.swarm.stop();
});

test('root: a selector that matches nothing simply finds nothing', () => {
  const page = makeAutoPage(
    '<section class="card" id="card" data-size="620x240"><p id="p" data-size="200x20">a</p></section>',
    {},
    { root: '#does-not-exist' },
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 0);
  assert.equal(page.doc.getElementById('card').classList.contains('sw-veiled'), false);
  page.swarm.stop();
});

test('a page with nothing to draw: the swarm flies in, finds nothing, bows out', () => {
  const page = makeAutoPage(
    '<div id="plain" class="plain" data-size="600x400"><p id="p" data-size="200x20">只是文字</p></div>',
    {},
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 0, 'no card-like boxes on the page');
  page.pump(140);
  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0, 'planes leave instead of idling');
  page.swarm.stop();
});

test('auto-detected blocks get the same grey box / hiding as marked ones', () => {
  const page = makeAutoPage(
    '<section class="card" id="card" data-size="620x240">' +
      '<h3 id="title" data-size="300x30">标题</h3>' +
      '<div id="row" data-size="600x60"><span id="pill" data-size="80x20">x</span></div>' +
    '</section>',
    {},
  );
  page.swarm.start();

  const title = page.doc.getElementById('title');
  assert.ok(title.classList.contains('sw-part'), 'detected blocks carry the styling class');
  assert.equal(
    page.win.getComputedStyle(title).visibility,
    'hidden',
    'an unpainted block is invisible, so nothing leaks before its box is dragged',
  );

  let wiredState = null;
  for (let f = 0; f < 400 && !wiredState; f++) {
    page.pump(1);
    if (title.classList.contains('sw-wire')) {
      const style = page.win.getComputedStyle(title);
      wiredState = { visibility: style.visibility, bg: style.backgroundColor };
    }
  }

  assert.ok(wiredState, 'the block eventually goes through the wireframe state');
  assert.equal(wiredState.visibility, 'visible', 'a laid-out block is visible');
  assert.equal(wiredState.bg, 'rgb(223, 225, 230)', 'and shows the grey placeholder');
  assert.equal(
    page.win.getComputedStyle(page.doc.getElementById('pill')).visibility,
    'hidden',
    'inline children stay hidden inside the grey box',
  );

  page.pump(500);
  assert.equal(page.doc.querySelectorAll('.sw-part').length, 0, 'styling classes are removed at the end');
  page.swarm.stop();
});

test('a component that paints its own box is one block, not its internal pieces', () => {
  const page = makeAutoPage(
    '<section class="card" id="card" data-size="620x240">' +
      '<div id="rule" class="panel" data-size="600x60">' +
        '<b id="b" data-size="120x18">标题</b><span id="sp" data-size="80x18">说明</span><i id="sw" data-size="28x16"></i>' +
      '</div>' +
    '</section>',
    {},
  );
  page.swarm.start();
  const wired = new Set();
  for (let f = 0; f < 400; f++) {
    page.pump(1);
    for (const el of page.doc.querySelectorAll('.sw-wire')) wired.add(el.id);
  }
  assert.deepEqual([...wired], ['rule'], 'the bordered row is atomic');
  page.swarm.stop();
});

test('detection can be told to leave parts of the page alone', () => {
  const page = makeAutoPage(
    '<section class="card" id="keep" data-size="620x240"><p id="p1" data-size="200x20">a</p></section>' +
    '<section class="card" id="skipme" data-swarm-ignore data-size="620x240"><p id="p2" data-size="200x20">b</p></section>',
    {},
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 1);
  assert.equal(page.doc.getElementById('skipme').classList.contains('sw-veiled'), false);
  page.swarm.stop();
});

test('flat pages fall back to their biggest sections', () => {
  const page = makeAutoPage(
    '<div id="flat" class="plain" data-size="900x400">' +
      '<div id="one" class="plain" data-size="400x120"><p id="p1" data-size="200x20">a</p></div>' +
      '<div id="two" class="plain" data-size="400x120"><p id="p2" data-size="200x20">b</p></div>' +
    '</div>',
    {},
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 1, 'the section holding two block groups is drawn');
  assert.ok(page.doc.getElementById('flat').classList.contains('sw-veiled'));
  page.swarm.stop();
});

test('debug outlines the detected layers and blocks', () => {
  const page = makeAutoPage(
    '<section class="card" id="card" data-size="620x240"><p id="p" data-size="200x20">a</p></section>',
    {},
    { debug: true },
  );
  page.swarm.start();
  assert.equal(page.doc.getElementById('card').getAttribute('data-swarm-role'), 'layer');
  assert.equal(page.doc.getElementById('p').getAttribute('data-swarm-role'), 'part');
  page.swarm.stop();
  assert.equal(page.doc.getElementById('card').getAttribute('data-swarm-role'), null);
  assert.equal(page.doc.getElementById('p').getAttribute('data-swarm-role'), null);
});

test('auto detection skips page wrappers, unpainted boxes and landmarks', () => {
  const page = makeAutoPage(
    '<div id="huge" class="card" data-size="1200x860">' +
      '<div class="plain" id="plain" data-size="600x200">' +
        '<div class="panel" id="innerCard" data-size="300x120"><p id="innerText" data-size="200x20">text</p></div>' +
      '</div>' +
    '</div>' +
    '<aside id="side" class="card" data-size="240x600"><a id="sideLink" href="#" data-size="200x30">x</a></aside>',
    {},
  );
  page.swarm.start();
  assert.equal(page.swarm.state.total, 1, 'only the inner card qualifies');
  page.swarm.stop();
});

test('auto:false with no markup does nothing; marked markup still wins over auto', () => {
  const off = makeAutoPage('<div class="card" id="c" data-size="600x200"><p id="p" data-size="200x20">x</p></div>', {}, { auto: false });
  off.swarm.start();
  assert.equal(off.swarm.state.total, 0);
  off.swarm.stop();

  const both = makeAutoPage(
    '<div class="card" id="autoCard" data-size="600x200"><p id="autoText" data-size="200x20">x</p></div>' +
    '<section data-swarm-layer id="marked" data-size="600x120"><div data-swarm-part id="markedPart" data-size="200x20">y</div></section>',
    {},
  );
  both.swarm.start();
  assert.equal(both.swarm.state.total, 1, 'explicit markup disables auto detection');
  assert.ok(both.doc.getElementById('marked').classList.contains('sw-veiled'));
  assert.equal(both.doc.getElementById('autoCard').classList.contains('sw-veiled'), false);
  both.swarm.stop();
});

test('a nested layer is not a second artboard: its blocks are drawn with the ancestor', () => {
  const page = makeHarness({
    agents: 2,
    body:
      '<section data-swarm-layer id="outer">' +
        '<h3 data-swarm-part id="title">t</h3>' +
        '<section data-swarm-layer id="inner"><p data-swarm-part id="copy">c</p></section>' +
      '</section>',
    rects: {
      outer: [100, 40, 600, 220],
      title: [120, 60, 300, 30],
      inner: [200, 60, 570, 100],
      copy: [220, 80, 400, 30],
    },
  });

  page.swarm.start();
  assert.equal(page.swarm.state.total, 1, 'only the outer layer is an artboard');
  assert.equal(
    page.doc.getElementById('inner').classList.contains('sw-veiled'),
    false,
    'the nested layer is never veiled on its own',
  );

  const wired = new Set();
  for (let f = 0; f < 400; f++) {
    page.pump(1);
    for (const part of page.doc.querySelectorAll('[data-swarm-part].sw-wire')) wired.add(part.id);
  }

  assert.deepEqual([...wired].sort(), ['copy', 'title'], 'both blocks drawn, in document order');
  assert.equal(page.swarm.state.built, 1);
  page.swarm.stop();
});

test('layers that are not rendered are left out instead of stalling the run', () => {
  const page = makeHarness({
    agents: 2,
    body:
      '<section data-swarm-layer id="shown"><div data-swarm-part id="shownPart">a</div></section>' +
      '<section data-swarm-layer id="hidden"><div data-swarm-part id="hiddenPart">b</div></section>',
    rects: { shown: [100, 40, 600, 220], shownPart: [120, 60, 300, 30] }, // `hidden` has no layout
  });

  page.swarm.start();
  assert.equal(page.swarm.state.total, 1, 'a zero-size layer is not part of the run');
  page.pump(500);

  const hud = page.doc.querySelector('.sw-hud');
  assert.equal(page.swarm.state.built, 1);
  assert.match(hud.textContent, /1\s*\/\s*1\s*layers/);
  assert.equal(hud.classList.contains('has-hint'), false, 'no "scroll to keep building" forever');
  assert.equal(page.doc.getElementById('hidden').hasAttribute('style'), false);
  page.swarm.stop();
});

test('gesture kind is inferred from the markup, and can be overridden per element', () => {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<h3 id="heading">标题<em>副</em></h3>' +
      '<a id="link" href="#">充值</a>' +
      '<button id="button">确定</button>' +
      '<li id="row">item</li>' +
      '<div id="box"><span>x</span><div>y</div></div>' +
      '<div id="forced" data-swarm-draw="item">x</div>' +
      '</body></html>',
  );
  const doc = dom.window.document;

  assert.equal(inferKind(doc.getElementById('heading')), 'text');
  assert.equal(inferKind(doc.getElementById('link')), 'button');
  assert.equal(inferKind(doc.getElementById('button')), 'button');
  assert.equal(inferKind(doc.getElementById('row')), 'item');
  assert.equal(inferKind(doc.getElementById('box')), 'box');
  assert.equal(inferKind(doc.getElementById('forced')), 'item', 'data-swarm-draw wins');

  assert.ok(fillMs('text', doc.getElementById('heading')) >= 240);
  assert.ok(fillMs('text', doc.getElementById('heading')) <= 1100);
  assert.ok(fillMs('box', doc.getElementById('box')) > 0, 'cards are dragged out too');
  assert.ok(fillMs('item', doc.getElementById('row')) > 0);
});

test('text is typed out: the reveal grows 0 -> 1 while the plane rides the caret', () => {
  const page = makeHarness({
    agents: 2,
    body: '<section data-swarm-layer id="l0"><div data-swarm-part id="txt">待办事项列表</div></section>',
    rects: { l0: [100, 40, 600, 220], txt: [120, 60, 300, 30] },
  });
  page.swarm.start();
  const part = page.doc.getElementById('txt');
  const partLeft = page.rects.txt[1];
  const partWidth = page.rects.txt[2];

  const reveals = [];
  const carets = [];
  let settledReveal = null;
  for (let f = 0; f < 400; f++) {
    page.pump(1);
    if (!part.classList.contains('sw-typing')) {
      if (reveals.length && settledReveal === null) {
        settledReveal = Number(part.style.getPropertyValue('--sw-reveal'));
      }
      continue;
    }
    const reveal = Number(part.style.getPropertyValue('--sw-reveal'));
    reveals.push(reveal);
    const tip = workerTip(page.doc);
    if (tip) carets.push(Math.abs(tip.x - (partLeft + partWidth * reveal)));
  }

  assert.ok(reveals.length > 5, 'typing is a process, not a pop-in');
  assert.ok(
    new Set(reveals).size < reveals.length,
    'typing advances in character cells, not a smooth wipe',
  );
  for (let i = 1; i < reveals.length; i++) assert.ok(reveals[i] >= reveals[i - 1], 'reveal only grows');
  assert.equal(settledReveal, 1, 'the copy ends fully revealed');
  assert.ok(carets.length > 5 && Math.max(...carets) < 2, 'the plane tip sits on the reveal edge');
  assert.equal(part.classList.contains('sw-typing'), false);
  assert.equal(page.swarm.state.built, 1);
  page.swarm.stop();
});

test('cards and buttons are dragged out of their top-left corner, not wiped left to right', () => {
  const page = makeHarness({
    agents: 2,
    body:
      '<section data-swarm-layer id="l0">' +
        '<div data-swarm-part id="card"><div>x</div></div>' +
        '<a data-swarm-part id="btn" href="#">go</a>' +
      '</section>',
    rects: { l0: [100, 40, 600, 220], card: [120, 60, 300, 60], btn: [200, 60, 120, 32] },
  });
  page.swarm.start();

  const seen = new Map();
  for (let f = 0; f < 420; f++) {
    page.pump(1);
    for (const part of page.doc.querySelectorAll('[data-swarm-part].sw-typing')) {
      assert.fail(part.id + ' must not be revealed with the text wipe');
    }
    for (const part of page.doc.querySelectorAll('[data-swarm-part].sw-pull')) {
      if (!seen.has(part.id)) seen.set(part.id, []);
      seen.get(part.id).push(Number(part.style.getPropertyValue('--sw-reveal')));
    }
  }

  assert.deepEqual([...seen.keys()].sort(), ['btn', 'card'], 'both grow out of the top-left corner');
  for (const [id, values] of seen) {
    assert.ok(values.length > 4, id + ' is dragged open progressively');
    assert.ok(values.at(-1) > 0.9, id + ' ends up fully revealed');
  }
  page.swarm.stop();
});

test('list rows are duplicated and dragged in from the previous row', () => {
  const page = makeHarness({
    agents: 2,
    body:
      '<section data-swarm-layer id="l0"><ul>' +
        '<li data-swarm-part id="row1">a</li>' +
        '<li data-swarm-part id="row2">b</li>' +
      '</ul></section>',
    rects: { l0: [100, 40, 600, 220], row1: [120, 60, 500, 30], row2: [170, 60, 500, 30] },
  });
  page.swarm.start();

  let ghostFrames = 0;
  let startOffset = null;
  let endOffset = null;
  for (let f = 0; f < 500; f++) {
    page.pump(1);
    const ghost = page.doc.querySelector('.sw-ghost');
    if (!ghost) continue;
    ghostFrames += 1;
    const match = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(ghost.style.transform);
    if (!match) continue;
    if (!startOffset) startOffset = { x: Number(match[1]), y: Number(match[2]) };
    endOffset = { x: Number(match[1]), y: Number(match[2]) };
  }

  assert.ok(ghostFrames > 5, 'a copy of the row travels into its slot');
  assert.ok(startOffset && (startOffset.x !== 0 || startOffset.y !== 0), 'the copy starts away from the slot');
  assert.ok(Math.abs(endOffset.x) <= 1 && Math.abs(endOffset.y) <= 1, 'the copy lands in the slot');
  assert.equal(page.doc.querySelector('.sw-ghost'), null, 'the copy is dropped after it lands');
  assert.equal(page.swarm.state.built, 1);
  page.swarm.stop();
});

test('fmtDim rounds and uses the multiplication sign', () => {
  assert.equal(fmtDim(124.4, 96.2), '124 \u00d7 96');
});

test('needsScroll is only true while pending work is fully off screen', () => {
  assert.equal(needsScroll([{ state: 'pending', inView: false }]), true);
  assert.equal(needsScroll([{ state: 'pending', inView: true }, { state: 'pending', inView: false }]), false);
  assert.equal(needsScroll([{ state: 'done', inView: false }]), false);
});

test('nextPending respects the concurrency cap and visibility', () => {
  const layers = [
    { state: 'pending', inView: false },
    { state: 'pending', inView: true },
  ];
  assert.equal(nextPending(layers, 1, 0), layers[1]);
  assert.equal(nextPending(layers, 1, 1), null);
  assert.equal(nextPending(layers.slice(0, 1), 4, 0), null);
});

test('the first screenful waits for the swarm to fly in before it starts drawing', () => {
  const page = makeHarness({ layers: 1, parts: 1, agents: 6 });
  page.swarm.start();

  const start = [...page.doc.querySelectorAll('.sw-cursor')].map(readTransform);
  assert.ok(start.every((tip) => tip.y > 900), 'planes start below the fold');

  page.pump(20); // ~330ms into the entrance
  assert.equal(page.swarm.state.active, 0, 'nothing is drawn while the flock is entering');
  const mid = [...page.doc.querySelectorAll('.sw-cursor')].map(readTransform);
  assert.ok(
    mid.some((tip, i) => tip.y < start[i].y - 60),
    'the planes are visibly flying up the screen',
  );

  page.pump(40); // past the entrance beat
  assert.ok(page.swarm.state.active > 0, 'work starts once the flock is in');
  page.swarm.stop();
});

test('planes enter as a flock from off-screen, and their nose points along the flight path', () => {
  const page = makeHarness({ layers: 3, parts: 1, agents: 8, maxConcurrent: 1 });
  page.swarm.start();

  const cursors = () => [...page.doc.querySelectorAll('.sw-cursor')];
  assert.equal(cursors().length, 8);
  assert.ok(
    cursors().every((cursor) => readTransform(cursor).y > 900),
    'the swarm starts below the fold',
  );

  const state = cursors().map((el) => ({ el, prev: readTransform(el), turn: 0, err: 0, samples: 0 }));

  for (let f = 0; f < 40; f++) {
    page.pump(1);
    for (const entry of state) {
      if (!entry.el.isConnected) continue;
      const now = readTransform(entry.el);
      if (!now) continue;
      if (f > 2) entry.turn += Math.abs(((now.a - entry.prev.a + 540) % 360) - 180);

      const dx = now.x - entry.prev.x;
      const dy = now.y - entry.prev.y;
      if (Math.hypot(dx, dy) > 3) {
        const heading = (Math.atan2(dy, dx) * 180) / Math.PI;
        entry.err += Math.abs(((heading + 45 - now.a + 540) % 360) - 180);
        entry.samples += 1;
      }
      entry.prev = now;
    }
  }

  const turns = state.map((entry) => entry.turn).sort((a, b) => a - b);
  const median = turns[Math.floor(turns.length / 2)];
  assert.ok(median > 15, 'entry paths curve like a flock, median turn ' + median.toFixed(0) + '°');

  const travelling = state.filter((entry) => entry.samples > 5);
  assert.ok(travelling.length >= 6, 'the flock actually moves (' + travelling.length + ')');
  const meanErr =
    travelling.reduce((sum, entry) => sum + entry.err / entry.samples, 0) / travelling.length;
  assert.ok(meanErr < 25, 'the nose follows the direction of travel, mean error ' + meanErr.toFixed(0) + '°');

  const inside = cursors().filter((cursor) => {
    const tip = readTransform(cursor);
    return tip && tip.y > 0 && tip.y < 900;
  });
  assert.ok(inside.length >= 5, 'planes reach the viewport');
  page.swarm.stop();
});

test('the frame is dragged out of empty space and the plane rides its corner', () => {
  const page = makeHarness({ layers: 1, parts: 2 });
  const layer = page.doc.getElementById('l0');
  page.swarm.start();

  const widths = [];
  let framingSamples = 0;
  let cornerHits = 0;

  for (let f = 0; f < 140; f++) {
    page.pump(1);
    const insp = page.doc.querySelector('.sw-insp');
    if (!insp) continue;

    const width = parseFloat(insp.style.width) || 0;
    if (width > 0) widths.push(width);
    if (!insp.classList.contains('is-framing')) continue;

    framingSamples += 1;
    assert.ok(layer.classList.contains('sw-veiled'), 'the layer must stay unpainted while its frame is dragged');
    assert.equal(layer.classList.contains('sw-laying'), false);

    assert.ok(page.doc.querySelector('.sw-guides.is-on'), 'smart guides are visible while dragging');

    const origin = readTransform(insp);
    const tip = workerTip(page.doc);
    const height = parseFloat(insp.style.height) || 0;
    if (Math.abs(tip.x - (origin.x + width)) < 1.6 && Math.abs(tip.y - (origin.y + height)) < 1.6) {
      cornerHits += 1;
    }
  }

  assert.ok(widths.length > 10, 'the frame must be visible while being dragged');
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1], 'the frame only ever grows');
  }
  assert.equal(widths.at(-1), 600, 'the frame ends at the layer width');
  assert.ok(widths.filter((w) => w < 600).length >= 8, 'the box is drawn step by step, not popped in');
  assert.equal(cornerHits, framingSamples, 'the plane tip must sit exactly on the dragged corner');
  page.pump(120);
  assert.equal(page.doc.querySelector('.sw-guides.is-on'), null, 'guides disappear once the frame is dropped');
  page.swarm.stop();
});

test('empty space -> dragged frame -> real container -> empty layer -> layout -> content', () => {
  const page = makeHarness({ layers: 1, parts: 2 });
  const layer = page.doc.getElementById('l0');
  page.swarm.start();

  const states = [];
  let containerFrame = -1;
  let firstWireFrame = -1;
  let firstFillFrame = -1;
  let polishFrame = -1;

  for (let f = 0; f < 420; f++) {
    page.pump(1);
    const state = layer.classList.contains('sw-veiled')
      ? 'veiled'
      : layer.classList.contains('sw-laying')
        ? 'laying'
        : 'done';
    if (containerFrame < 0 && state === 'laying') containerFrame = f;
    if (firstWireFrame < 0 && page.doc.querySelectorAll('.sw-wire').length) firstWireFrame = f;
    if (firstFillFrame < 0 && page.doc.querySelectorAll('.sw-filled').length) firstFillFrame = f;
    if (polishFrame < 0 && layer.classList.contains('sw-polishing')) polishFrame = f;
    states.push(state);
  }

  assert.ok(polishFrame > firstFillFrame, 'colour lands after the copy');

  assert.deepEqual([...new Set(states)], ['veiled', 'laying', 'done'], 'states must appear in this order');
  assert.ok(states.indexOf('veiled') < states.indexOf('laying'));

  assert.ok(containerFrame > 0 && firstWireFrame > containerFrame);
  assert.ok(firstFillFrame > firstWireFrame);

  // the moment the real container shows up it is empty and grey
  assert.equal(page.doc.querySelectorAll('.sw-wire, .sw-filled, .sw-wire-text').length, 0);
  page.swarm.stop();
});

test('scrolling mid-gesture keeps the frame and the plane glued to the element', () => {
  const page = makeHarness({ layers: 1, parts: 2 });
  page.swarm.start();
  page.pump(95); // past the entry beat, inside the frame drag

  const insp = page.doc.querySelector('.sw-insp');
  assert.ok(insp.classList.contains('is-framing'));

  const frameBefore = readTransform(insp);

  page.setScroll(120);
  page.pump(1);

  const frameAfter = readTransform(insp);
  assert.ok(Math.abs(frameBefore.y - frameAfter.y - 120) < 1.5, 'the frame follows the page');

  const tipAfter = workerTip(page.doc);
  const width = parseFloat(insp.style.width);
  const height = parseFloat(insp.style.height);
  assert.ok(Math.abs(tipAfter.x - (frameAfter.x + width)) < 1.6, 'tip still on the dragged corner');
  assert.ok(Math.abs(tipAfter.y - (frameAfter.y + height)) < 1.6);

  page.setScroll(260);
  page.pump(2);
  const frameLater = readTransform(insp);
  assert.ok(Math.abs(frameLater.y - frameAfter.y + 140) < 1.5, 'still glued after a second scroll');
  page.swarm.stop();
});



test('the dragged frame is filled with a translucent wash, and it clears on release', () => {
  const page = makeHarness({ layers: 1, parts: 2 });
  page.swarm.start();

  let frameMask = null;
  let releasedMask = null;
  let boxMask = null;

  for (let f = 0; f < 400; f++) {
    page.pump(1);

    const insp = page.doc.querySelector('.sw-insp');
    const mask = insp?.querySelector('.sw-mask');
    if (mask && insp.classList.contains('is-framing') && frameMask === null) {
      frameMask = page.win.getComputedStyle(mask).opacity;
    }
    if (mask && insp.classList.contains('is-drawn') && !insp.classList.contains('is-framing') && releasedMask === null) {
      releasedMask = page.win.getComputedStyle(mask).opacity;
    }

    const box = page.doc.querySelector('.sw-box.sw-drag');
    if (box && box.style.visibility !== 'hidden' && boxMask === null) {
      const inner = box.querySelector('.sw-mask');
      boxMask = inner ? page.win.getComputedStyle(inner).opacity : null;
    }
  }

  assert.equal(frameMask, '0.12', 'the frame carries a wash while it is dragged out');
  assert.equal(releasedMask, '0', 'the wash clears once the frame is dropped');
  assert.equal(boxMask, '0.12', 'layout boxes carry the same wash while dragged');
  page.swarm.stop();
});

test('idle agents hover in place instead of stacking at the origin', () => {
  const page = makeHarness({ layers: 1, parts: 1, agents: 5 });
  page.swarm.start();
  page.pump(1);

  const cursors = [...page.doc.querySelectorAll('.sw-cursor')];
  assert.equal(cursors.length, 5);
  const first = cursors.map(readTransform);
  first.forEach((tip) => assert.ok(tip, 'every cursor must have a transform'));
  assert.ok(first.some((tip) => tip.x > 0 || tip.y > 0));

  page.pump(3);
  const second = cursors.map(readTransform);
  assert.ok(
    second.some((tip, i) => tip.x !== first[i].x || tip.y !== first[i].y),
    'idle cursors keep drifting',
  );
  page.swarm.stop();
});

test('layout comes first: every part box is dragged out before any content fills in', () => {
  const page = makeHarness({ layers: 1, parts: 3 });
  page.swarm.start();

  const wire = [];
  const filled = [];
  for (let f = 0; f < 520; f++) {
    page.pump(1);
    wire.push(page.doc.querySelectorAll('[data-swarm-part].sw-wire').length);
    filled.push(page.doc.querySelectorAll('[data-swarm-part].sw-filled').length);
  }

  assert.equal(Math.max(...wire), 3, 'all three layout boxes must be up at the same time');
  const firstFilled = filled.findIndex((n) => n > 0);
  assert.ok(firstFilled > 0);
  assert.equal(wire[firstFilled - 1], 3, 'content starts only after the whole layout is up');

  for (let i = firstFilled; i < filled.length && filled[i] > 0; i++) {
    assert.ok(filled[i] >= filled[i - 1], 'content is revealed part by part, never removed');
  }

  assert.equal(page.swarm.state.built, 1);
  assert.equal(page.doc.querySelector('.sw-bar > i').style.width, '100%');
  assert.match(page.doc.querySelector('.sw-hud').textContent, /1\s*\/\s*1\s*layers/);
  assert.equal(
    page.doc.querySelectorAll(
      '.sw-veiled, .sw-laying, .sw-wireframe, .sw-polishing, .sw-wire, .sw-wire-text, .sw-filled, .sw-insp, .sw-box',
    ).length,
    0,
  );
  assert.equal(page.doc.querySelector('.sw-bar > i').style.width, '100%');
  page.swarm.stop();
});

test('nothing appears before its plane gets there: box under the tip, copy inside the block', () => {
  const page = makeHarness({ layers: 1, parts: 2 });
  page.swarm.start();

  let boxChecked = 0;
  let fillsChecked = 0;
  let bars = 0;
  const seen = new Set();
  const tips = () => [...page.doc.querySelectorAll('.sw-cursor')].map(readTransform);

  for (let f = 0; f < 400; f++) {
    page.pump(1);

    const box = page.doc.querySelector('.sw-box.sw-drag');
    if (box && box.style.visibility !== 'hidden' && !boxChecked) {
      boxChecked = 1;
      const left = parseFloat(box.style.left);
      const top = parseFloat(box.style.top);
      assert.ok(
        tips().some((tip) => Math.abs(tip.x - left) < 2 && Math.abs(tip.y - top) < 2),
        'a drag box may not appear before the plane reaches its corner',
      );
    }

    if (page.doc.querySelector('[data-swarm-part].sw-wire.sw-wire-text')) bars += 1;

    for (const part of page.doc.querySelectorAll('[data-swarm-part].sw-filled')) {
      if (seen.has(part)) continue;
      seen.add(part);
      const rect = page.rects[part.id];
      const tip = workerTip(page.doc);
      assert.ok(
        tip &&
          tip.x >= rect[1] - 8 && tip.x <= rect[1] + rect[2] + 8 &&
          tip.y >= rect[0] - 8 && tip.y <= rect[0] + rect[3] + 8,
        'copy may only land while its plane is at that block',
      );
      fillsChecked += 1;
    }
  }

  assert.equal(boxChecked, 1);
  assert.equal(fillsChecked, 2, 'both blocks got their copy, each gated on the plane');
  assert.ok(bars > 5, 'copy blocks show filler text bars while laid out');
  page.swarm.stop();
});

test('different planes draw different regions at the same time, the rest keep hovering', () => {
  const page = makeHarness({ layers: 6, parts: 1, maxConcurrent: 3, agents: 6, gap: 120 });
  page.swarm.start();

  let widest = 0;
  let hoverFrames = 0;

  for (let f = 0; f < 700; f++) {
    page.pump(1);
    const colors = new Set(
      [...page.doc.querySelectorAll('.sw-insp')].map((el) => el.style.getPropertyValue('--sw-c')),
    );
    widest = Math.max(widest, colors.size);
    if (page.doc.querySelector('.sw-box:not(.sw-drag)')) hoverFrames += 1;
  }

  assert.equal(widest, 3, 'three different planes work three regions at once');
  assert.ok(hoverFrames > 20, 'planes without a region keep circling laid-out blocks with measurements');
  assert.equal(page.swarm.state.built, 6);
  page.swarm.stop();
});

test('concurrency cap holds while many layers are on screen', () => {
  const page = makeHarness({ layers: 5, parts: 2, maxConcurrent: 2, agents: 6, gap: 150 });
  page.swarm.start();
  page.pump(1400);
  assert.equal(page.swarm.state.built, 5);
  assert.equal(page.peakInFlight, 2);
  page.swarm.stop();
});

test('a swarm with nothing to do flies in, bows out, and comes back only for real work', () => {
  const page = makeHarness({
    layers: 1,
    parts: 1,
    agents: 6,
    body: '<section data-swarm-layer id="l0"><div data-swarm-part id="l0p0">x</div></section>',
    rects: { l0: [2100, 40, 600, 220], l0p0: [2120, 60, 300, 40] },
  });
  page.swarm.start();

  page.pump(20);
  assert.ok(page.doc.querySelectorAll('.sw-cursor').length > 0, 'planes fly in first');

  page.pump(120); // intro over, nothing visible -> fireworks, then gone
  assert.equal(page.swarm.state.built, 0);
  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0, 'no task means no planes left on screen');
  assert.equal(page.doc.querySelectorAll('.sw-spark').length, 0);
  assert.ok(page.doc.querySelector('.sw-hud').classList.contains('has-hint'));

  page.setScroll(1600); // the only layer scrolls into view
  page.pump(6);
  assert.ok(page.doc.querySelectorAll('.sw-cursor').length > 0, 'real work brings them back');
  page.pump(400);
  assert.equal(page.swarm.state.built, 1);
  page.swarm.stop();
});

test('the swarm leaves when the visible work is done, and returns when new work scrolls in', () => {
  const page = makeHarness({ layers: 2, parts: 1, maxConcurrent: 2, gap: 1900 });
  page.swarm.start();
  page.pump(320); // first screenful drawn, fireworks burnt out

  assert.equal(page.swarm.state.built, 1);
  assert.equal(page.swarm.state.active, 0);
  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0, 'planes leave the stage');
  assert.equal(page.doc.querySelectorAll('.sw-spark, .sw-ring').length, 0);
  assert.equal(page.doc.querySelector('.sw-box'), null);
  assert.ok(page.doc.querySelector('.sw-hud').classList.contains('has-hint'), 'HUD asks for a scroll');

  // a scroll brings the second layer into view: the swarm must come back
  page.setScroll(1600);
  page.pump(4);
  assert.ok(page.doc.querySelectorAll('.sw-cursor').length > 0, 'planes fly back in');

  page.pump(400);
  assert.equal(page.swarm.state.built, 2, 'and finish the new work');
  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0, 'then leave again');
  page.swarm.stop();
});

test('nothing moves once the swarm has left the stage', () => {
  const page = makeHarness({ layers: 1, parts: 1, agents: 4 });
  page.swarm.start();
  page.runUntilDone();
  page.pump(200); // fireworks + removal

  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0);
  const html = page.doc.querySelector('.sw-root').innerHTML;
  page.pump(200);
  assert.equal(page.doc.querySelector('.sw-root').innerHTML, html, 'the overlay is completely static');
  assert.equal(page.doc.querySelectorAll('.sw-box, .sw-insp, .sw-spark').length, 0);
  page.swarm.stop();
});

test('when the last layer lands every plane blooms into fireworks and disappears', () => {
  const page = makeHarness({ layers: 1, parts: 1, agents: 5 });
  page.swarm.start();
  page.runUntilDone();

  page.pump(2);
  assert.ok(page.doc.querySelectorAll('.sw-spark').length > 0, 'the swarm bursts');
  assert.equal(page.doc.querySelectorAll('.sw-ring').length, 5, 'one bloom ring per plane');
  assert.equal(page.doc.querySelector('.sw-cursor').style.opacity, '0', 'the plane itself pops out');

  page.pump(120);
  assert.equal(page.doc.querySelectorAll('.sw-spark, .sw-ring').length, 0, 'sparks burn out');
  assert.equal(page.doc.querySelectorAll('.sw-cursor').length, 0, 'the planes are gone');
  assert.ok(page.doc.querySelector('.sw-hud'), 'the HUD stays');
  assert.equal(page.swarm.state.built, 1);
  page.swarm.stop();
});

test('once every layer is drawn the overlay stops: no boxes, no movement', () => {
  const page = makeHarness({ layers: 2, parts: 2 });
  page.swarm.start();
  page.runUntilDone();
  page.pump(120);

  const before = [...page.doc.querySelectorAll('.sw-cursor')].map((cursor) => cursor.style.transform);
  page.pump(120);
  const after = [...page.doc.querySelectorAll('.sw-cursor')].map((cursor) => cursor.style.transform);

  assert.deepEqual(after, before, 'the swarm stops moving once the work is finished');
  assert.equal(page.doc.querySelectorAll('.sw-box, .sw-insp').length, 0);
  assert.equal(page.doc.querySelector('.sw-bar > i').style.width, '100%');
  page.swarm.stop();
});

test('off-screen layers wait for the scroll hint, then the tour scrolls to them', () => {
  const page = makeHarness({ layers: 2, parts: 1, maxConcurrent: 2, gap: 1900 });
  page.swarm.start();
  page.pump(260);

  assert.equal(page.swarm.state.built, 1, 'only the visible layer may build');
  assert.ok(
    page.doc.querySelector('.sw-hud').classList.contains('has-hint'),
    'hint appears while a layer waits below the fold',
  );

  page.swarm.tour(true);
  page.pump(900);

  assert.equal(page.swarm.state.built, 2);
  assert.ok(page.scroll > 600, 'tour must scroll the page toward the next layer');
  page.swarm.stop();
});

test('speed changes the wall-clock time to finish', () => {
  const slow = makeHarness({ layers: 3, parts: 2, maxConcurrent: 1, speed: 1 });
  slow.swarm.start();
  const slowFrames = slow.runUntilDone();
  slow.swarm.stop();

  const fast = makeHarness({ layers: 3, parts: 2, maxConcurrent: 1, speed: 3 });
  fast.swarm.start();
  const fastFrames = fast.runUntilDone();
  fast.swarm.stop();

  assert.ok(
    fastFrames < slowFrames * 0.5,
    'x3 speed must finish in well under half the frames (' + fastFrames + ' vs ' + slowFrames + ')',
  );
});

test('stop() restores the page, removes the overlay and can be started again', () => {
  const page = makeHarness({ layers: 2, parts: 2 });
  page.swarm.start();
  page.pump(40);
  page.swarm.stop();

  assert.equal(page.doc.querySelector('.sw-root'), null);
  assert.equal(page.doc.getElementById('swarm-draw-style'), null);
  assert.equal(
    page.doc.querySelectorAll(
      '.sw-veiled, .sw-laying, .sw-wireframe, .sw-polishing, .sw-wire, .sw-wire-text, .sw-filled, .sw-insp, .sw-box',
    ).length,
    0,
  );
  assert.equal(page.doc.getElementById('l0').hasAttribute('style'), false, 'the library never writes inline styles on layers');
  assert.equal(page.swarm.state.running, false);

  page.swarm.start();
  page.pump(400);
  assert.equal(page.swarm.state.built, 2);
  page.swarm.stop();
});
