const TEXT_TAGS = new Set([
  'SPAN', 'EM', 'STRONG', 'B', 'I', 'A', 'SMALL', 'CODE', 'BR', 'MARK', 'TIME', 'LABEL', 'U', 'S', 'SUP', 'SUB',
]);
const ITEM_TAGS = new Set(['LI', 'TR', 'DD', 'DT']);

/** How long the content gesture of each kind takes (ms, unscaled). */
export const FILL_MS = { box: 320, button: 340, item: 460 };

/**
 * What gesture writes this block's content:
 *   text   -> the plane types it out, character by character
 *   button -> the shape is dragged out of its top-left corner
 *   item   -> a copy is dragged in from the previous row's slot
 *   box    -> the block is dragged out of its top-left corner too
 *
 * Override with data-swarm-draw="text|button|item|box".
 */
export function inferKind(el) {
  const forced = el.getAttribute('data-swarm-draw');
  if (forced === 'text' || forced === 'button' || forced === 'item' || forced === 'box') return forced;

  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'SUMMARY' || el.getAttribute('role') === 'button') return 'button';
  if (tag === 'A' && el.hasAttribute('href')) return 'button';
  if (ITEM_TAGS.has(tag)) return 'item';

  const kids = [...el.children];
  if (kids.every((kid) => TEXT_TAGS.has(kid.tagName))) return 'text';
  return 'box';
}

/** Typing time is proportional to the amount of copy, within sane bounds. */
export function fillMs(kind, el) {
  if (kind === 'text') {
    const chars = (el.textContent || '').trim().length;
    return Math.min(1100, Math.max(240, chars * 45));
  }
  return FILL_MS[kind] ?? 0;
}
