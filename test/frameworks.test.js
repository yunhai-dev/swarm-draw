import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><head><style>' +
    '.card{background:#fff;border:1px solid #e8eaee;border-radius:10px;padding:12px}' +
    '</style></head><body>' +
    '<div id="react-root"></div>' +
    '<div id="vue-root"></div>' +
    '<section class="card" id="outside">outside</section>' +
  '</body></html>',
  { pretendToBeVisual: true },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

dom.window.Element.prototype.getBoundingClientRect = function () {
  const isCard = this.classList && this.classList.contains('card');
  const width = isCard ? 620 : 300;
  const height = isCard ? 240 : 40;
  return { width, height, top: 100, left: 40, right: 40 + width, bottom: 100 + height, x: 40, y: 100 };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React.act ? React : await import('react-dom/test-utils');
const { SwarmDraw: SwarmDrawReact } = await import('../src/react.js');

const Vue = await import('vue');
const { SwarmDraw: SwarmDrawVue } = await import('../src/vue.js');

test('React: <SwarmDraw> mounts, scopes detection to its own subtree and cleans up', async () => {
  const container = document.getElementById('react-root');
  const root = createRoot(container);
  const ref = React.createRef();

  await act(async () => {
    root.render(
      React.createElement(
        SwarmDrawReact,
        { agents: 4, maxConcurrent: 2, ref },
        React.createElement('section', { className: 'card', id: 'rcard' }, 'card'),
      ),
    );
  });

  assert.ok(document.querySelector('.sw-root'), 'overlay is mounted');
  assert.ok(document.getElementById('rcard').classList.contains('sw-veiled'), 'the child card is drawn');
  assert.equal(
    document.getElementById('outside').classList.contains('sw-veiled'),
    false,
    'content outside the component is untouched',
  );
  assert.equal(ref.current.state.total, 1, 'the imperative handle exposes state');

  const card = document.getElementById('rcard');
  await act(async () => {
    root.unmount();
  });
  assert.equal(document.querySelector('.sw-root'), null, 'unmount removes the overlay');
  assert.equal(card.classList.contains('sw-veiled'), false, 'and clears the classes it added');
});

test('Vue: <SwarmDraw> mounts, scopes detection to its slot and cleans up', async () => {
  const { createApp, h } = Vue;
  const host = document.getElementById('vue-root');
  const ref = Vue.ref(null);

  const app = createApp({
    render: () =>
      h(
        SwarmDrawVue,
        { options: { agents: 4, maxConcurrent: 2 }, ref },
        { default: () => h('section', { class: 'card', id: 'vcard' }, 'card') },
      ),
  });

  app.mount(host);
  await Vue.nextTick();

  assert.ok(document.querySelector('.sw-root'), 'overlay is mounted');
  assert.ok(document.getElementById('vcard').classList.contains('sw-veiled'), 'the slotted card is drawn');
  assert.equal(document.getElementById('outside').classList.contains('sw-veiled'), false);
  assert.equal(ref.value.state.total, 1, 'exposed state');

  app.unmount();
  await Vue.nextTick();
  assert.equal(document.querySelector('.sw-root'), null, 'unmount removes the overlay');
});
