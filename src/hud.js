const HINT_TEXT = 'scroll to keep building';

function separator(doc) {
  const node = doc.createElement('span');
  node.className = 'sw-sep';
  return node;
}

function dim(doc, text) {
  const node = doc.createElement('span');
  node.className = 'sw-dim';
  node.textContent = text;
  return node;
}

function button(doc, text, onClick) {
  const node = doc.createElement('button');
  node.type = 'button';
  node.className = 'sw-btn';
  node.textContent = text;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function createHud(doc, { agents, onTour, onSpeed, onClose }) {
  const el = doc.createElement('div');
  el.className = 'sw-hud';

  const avatars = doc.createElement('div');
  avatars.className = 'sw-avatars';
  for (const agent of agents.slice(0, 5)) {
    const node = doc.createElement('i');
    node.textContent = agent.initial;
    node.style.background = agent.color;
    avatars.appendChild(node);
  }
  el.appendChild(avatars);

  const agentCount = doc.createElement('b');
  agentCount.className = 'sw-num';
  agentCount.textContent = String(agents.length);
  el.appendChild(agentCount);
  el.appendChild(dim(doc, 'agents'));
  el.appendChild(separator(doc));

  const builtCount = doc.createElement('b');
  builtCount.className = 'sw-num';
  builtCount.textContent = '0';
  const totalCount = dim(doc, ' / 0 layers');
  el.appendChild(builtCount);
  el.appendChild(totalCount);

  const hint = doc.createElement('span');
  hint.className = 'sw-hint';
  hint.textContent = HINT_TEXT;
  el.appendChild(hint);

  const bar = doc.createElement('div');
  bar.className = 'sw-bar';
  const fill = doc.createElement('i');
  bar.appendChild(fill);
  el.appendChild(bar);

  el.appendChild(separator(doc));

  const tourButton = button(doc, 'Tour', () => onTour?.());
  const speedButton = button(doc, '1x', () => onSpeed?.());
  const closeButton = button(doc, '\u2715', () => onClose?.());
  el.appendChild(tourButton);
  el.appendChild(speedButton);
  el.appendChild(closeButton);

  return {
    el,
    setStats(built, total) {
      builtCount.textContent = String(built);
      totalCount.textContent = ' / ' + total + ' layers';
      fill.style.width = total ? ((built / total) * 100).toFixed(2) + '%' : '0%';
    },
    setHint(on) {
      el.classList.toggle('has-hint', !!on);
    },
    setTouring(on) {
      tourButton.textContent = on ? 'Touring' : 'Tour';
      tourButton.classList.toggle('is-on', !!on);
    },
    setSpeed(speed) {
      speedButton.textContent = speed + 'x';
    },
  };
}
