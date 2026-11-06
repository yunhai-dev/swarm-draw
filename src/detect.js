const INLINE_TAGS = new Set([
  'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'TIME', 'LABEL',
  'SPAN', 'BR', 'SUP', 'SUB', 'ABBR', 'CITE', 'Q', 'INS', 'DEL', 'BDI', 'BDO', 'WBR',
]);

const ATOMIC_TAGS = new Set([
  'LI', 'TR', 'DT', 'DD', 'BUTTON', 'IMG', 'PICTURE', 'SVG', 'VIDEO', 'CANVAS',
  'INPUT', 'TEXTAREA', 'SELECT', 'PROGRESS', 'METER',
]);

const DEFAULT_SKIP =
  'nav,header,footer,aside,script,style,noscript,template,iframe,' +
  '[role="navigation"],[aria-hidden="true"],[hidden]';

const px = (value) => parseFloat(value) || 0;

/** A box worth animating: drawn (background/border/shadow) and big enough. */
function isIgnored(el) {
  return !!el.closest('[data-swarm-ignore]');
}

/** Painted = the element draws its own box: background, gradient, border or shadow. */
function isPainted(style) {
  const bg = style.backgroundColor || '';
  const hasBg = bg !== '' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  const image = style.backgroundImage || 'none';
  const hasImage = image !== 'none' && image !== '';
  const hasBorder =
    px(style.borderTopWidth) > 0 ||
    px(style.borderLeftWidth) > 0 ||
    px(style.borderBottomWidth) > 0 ||
    px(style.borderRightWidth) > 0;
  const shadow = style.boxShadow || 'none';
  const hasShadow = shadow !== 'none' && /\d/.test(shadow);
  return hasBg || hasImage || hasBorder || hasShadow;
}

function isCard(el, style, viewport, opts, doc) {
  if (el.tagName === 'HTML' || el.tagName === 'BODY') return false;
  if (style.position === 'fixed' || style.position === 'sticky') return false;
  if (style.display === 'inline' || style.display === 'contents' || style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (Number(style.opacity) === 0) return false;
  if (style.pointerEvents === 'none') return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < opts.minWidth || rect.height < opts.minHeight) return false;
  if (rect.width * rect.height > viewport.w * viewport.h * opts.maxAreaRatio) return false;

  if (!isPainted(style)) return false;

  // a card must actually contain something visible (blocks or its own copy)
  for (const kid of el.children) {
    const kidStyle = doc.defaultView.getComputedStyle(kid);
    if (kidStyle.display === 'none' || kidStyle.visibility === 'hidden') continue;
    const kidRect = kid.getBoundingClientRect();
    if (kidRect.width >= 8 && kidRect.height >= 8) return true;
  }
  return (el.textContent || '').trim().length > 0;
}

/** Innermost visible blocks: headings, rows, tiles, buttons — not their wrappers. */
function collectParts(layer, doc, opts) {
  const parts = [];
  const win = doc.defaultView;

  const blockChild = (node) => {
    for (const kid of node.children) {
      if (INLINE_TAGS.has(kid.tagName)) continue;
      const style = win.getComputedStyle(kid);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = kid.getBoundingClientRect();
      if (rect.width >= 10 && rect.height >= 10) return true;
    }
    return false;
  };

  const walk = (node, depth) => {
    if (depth > 8) return;
    for (const child of node.children) {
      if (parts.length >= opts.maxParts) return;
      if (child.matches(DEFAULT_SKIP) || isIgnored(child)) continue;

      const style = win.getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.pointerEvents === 'none') continue;
      const rect = child.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      // Components (anything that paints its own box) are atomic blocks: we do
      // not drill into a card / pill / bordered row looking for smaller bits.
      if (ATOMIC_TAGS.has(child.tagName) || isPainted(style) || !blockChild(child)) {
        parts.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };

  walk(layer, 0);
  return parts.length ? parts : [layer];
}

/**
 * Find the artboards and the blocks inside them without any markup:
 * every painted, reasonably sized box that is not a page wrapper becomes a
 * layer, and the innermost visible blocks inside it become its parts.
 */
export function detectLayers(doc, options = {}) {
  const win = doc.defaultView;
  // No root given -> the whole page. With a root, that element (selector or
  // element) is the only scope, and it is a candidate artboard itself.
  const explicit = options.root !== undefined && options.root !== null;
  const root = explicit
    ? typeof options.root === 'string'
      ? doc.querySelector(options.root)
      : options.root
    : doc.body;
  if (!root) return [];

  const opts = {
    minWidth: options.minWidth ?? 120,
    minHeight: options.minHeight ?? 44,
    maxAreaRatio: options.maxAreaRatio ?? 0.5,
    maxParts: options.maxParts ?? 24,
    maxLayers: options.maxLayers ?? 40,
  };
  const skip = options.skip ?? DEFAULT_SKIP;
  const viewport = { w: win?.innerWidth || 1200, h: win?.innerHeight || 800 };

  const found = [];

  const walk = (node, depth) => {
    if (!node || depth > 12) return;
    for (const child of node.children) {
      if (found.length >= opts.maxLayers) return;
      if (skip && child.matches(skip)) continue;
      if (isIgnored(child)) continue;

      const style = win.getComputedStyle(child);
      if (isCard(child, style, viewport, opts, doc)) {
        found.push({ el: child, parts: collectParts(child, doc, opts) });
        continue; // nested cards are drawn as parts of this one
      }
      walk(child, depth + 1);
    }
  };

  const isSection = (el) => {
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 120) return false;

    let blocks = 0;
    for (const kid of el.children) {
      const kidStyle = win.getComputedStyle(kid);
      if (kidStyle.display === 'none' || kidStyle.visibility === 'hidden') continue;
      const kidRect = kid.getBoundingClientRect();
      if (kidRect.width >= 40 && kidRect.height >= 16) blocks += 1;
    }
    return blocks >= 2;
  };

  // A root that was picked on purpose may itself be the artboard.
  if (explicit && root.tagName !== 'BODY' && root.tagName !== 'HTML' && !isIgnored(root)) {
    const style = win.getComputedStyle(root);
    if (isCard(root, style, viewport, opts, doc) || isSection(root)) {
      found.push({ el: root, parts: collectParts(root, doc, opts) });
      return found;
    }
  }

  walk(root, 0);
  if (found.length) return found;

  // Fallback for flat pages (no cards, no borders): take the biggest visible
  // sections that actually hold several blocks, so there is still something to draw.
  const loose = (node, depth) => {
    if (!node || depth > 8 || found.length >= 8) return;
    for (const child of node.children) {
      if (found.length >= 8) return;
      if (skip && child.matches(skip)) continue;
      if (isIgnored(child)) continue;

      if (isSection(child)) {
        found.push({ el: child, parts: collectParts(child, doc, opts) });
        continue;
      }
      loose(child, depth + 1);
    }
  };
  loose(root, 0);
  return found;
}
