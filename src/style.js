const STYLE_ID = 'swarm-draw-style';

export const CSS = `
.sw-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;contain:layout style}
.sw-root *,.sw-root{box-sizing:border-box}

.sw-cursor{position:absolute;top:0;left:0;width:22px;height:22px;margin:-2px 0 0 -20px;transform-origin:20px 2px;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.28))}
.sw-cursor svg{display:block;width:22px;height:22px;overflow:visible}

.sw-insp{position:absolute;top:0;left:0;contain:layout style;will-change:transform}

/* the dragged frame is filled with a translucent wash, like a marquee */
.sw-mask{position:absolute;left:0;top:0;right:0;bottom:0;background:var(--sw-c,#1a8cff);opacity:0;border-radius:2px;transition:opacity .12s linear}
.sw-insp.is-framing .sw-mask{opacity:.12}
.sw-box .sw-mask{opacity:.12}
.sw-edge{position:absolute;background:var(--sw-c,#1a8cff);opacity:0;transition:transform .16s ease-out,opacity .1s linear}
.sw-edge.t{left:0;right:0;top:0;height:1.5px;transform:scaleX(0);transform-origin:0 50%}
.sw-edge.b{left:0;right:0;bottom:0;height:1.5px;transform:scaleX(0);transform-origin:100% 50%}
.sw-edge.l{top:0;bottom:0;left:0;width:1.5px;transform:scaleY(0);transform-origin:50% 0}
.sw-edge.r{top:0;bottom:0;right:0;width:1.5px;transform:scaleY(0);transform-origin:50% 100%}
.sw-handle{position:absolute;width:7px;height:7px;margin:-4px 0 0 -4px;background:#fff;border:1.5px solid var(--sw-c,#1a8cff);border-radius:1px;opacity:0;transition:opacity .12s linear}
.sw-handle.tl{left:0;top:0}
.sw-handle.tr{left:100%;top:0}
.sw-handle.bl{left:0;top:100%}
.sw-handle.br{left:100%;top:100%}
.sw-plus{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;background:#fff;border:1.5px solid var(--sw-c,#1a8cff);border-radius:2px;opacity:0;transition:opacity .12s linear}
.sw-plus::before,.sw-plus::after{content:"";position:absolute;left:50%;top:50%;background:var(--sw-c,#1a8cff)}
.sw-plus::before{width:5px;height:1.5px;transform:translate(-50%,-50%)}
.sw-plus::after{width:1.5px;height:5px;transform:translate(-50%,-50%)}
.sw-plus.tm{left:50%;top:0}
.sw-plus.bm{left:50%;top:100%}
.sw-badge{position:absolute;left:0;bottom:-21px;background:#1a8cff;color:#fff;padding:0 4px;border-radius:3px;white-space:nowrap;font:500 11px/16px ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.2px;opacity:0;transition:opacity .12s linear}
.sw-insp.is-drawn .sw-edge,.sw-insp.is-drawn .sw-handle,.sw-insp.is-drawn .sw-plus,.sw-insp.is-drawn .sw-badge{opacity:1}
.sw-insp.is-drawn .sw-edge{transform:none}

/* while a box is being dragged out: edges track the cursor 1:1, no handles yet */
.sw-insp.is-framing .sw-edge,.sw-insp.is-framing .sw-badge{opacity:1}
.sw-insp.is-framing .sw-edge{transform:none;transition:none}

.sw-box{position:absolute;top:0;left:0;border:1.5px solid var(--sw-c,#1a8cff);border-radius:3px;pointer-events:none}

/* smart guides: magenta lines running off the dragged box, like Figma's snapping */
.sw-guides{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;opacity:0;transition:opacity .12s linear}
.sw-guides.is-on{opacity:1}
.sw-guides i{position:absolute;background:#ff2d55}
.sw-guides i.v{top:-100vh;height:200vh;width:1px}
.sw-guides i.v.l{left:0}
.sw-guides i.v.r{left:100%}
.sw-guides i.h{left:-100vw;width:200vw;height:1px}
.sw-guides i.h.t{top:0}
.sw-guides i.h.b{top:100%}

/* the layer does not exist yet: its space is reserved, its pixels are not painted */
.sw-veiled{visibility:hidden!important}

/* debug: outline what the library decided to draw */
[data-swarm-role="layer"]{outline:1px dashed rgba(26,140,255,.75);outline-offset:-1px}
[data-swarm-role="part"]{outline:1px dashed rgba(255,45,85,.6);outline-offset:-1px}

/* wireframe fidelity: no colour until the polish pass lands */
.sw-wireframe{filter:saturate(0)}
.sw-polishing{transition:filter .46s ease-out}

/* frame dropped -> the container is real, its blocks are not drawn yet */
.sw-laying .sw-part{visibility:hidden}
.sw-laying .sw-part.sw-wire,.sw-laying .sw-part.sw-filled{visibility:visible}

.sw-part{transition:background-color .2s ease}
.sw-part.sw-wire{background-color:#dfe1e6!important;border-color:transparent!important;color:transparent!important;box-shadow:none!important;text-shadow:none!important;border-radius:3px}
.sw-part.sw-wire.sw-wire-text{background-image:repeating-linear-gradient(180deg,#c9cdd4 0 5px,transparent 5px 12px);background-repeat:no-repeat;background-position:0 7px;background-size:100% calc(100% - 14px)}
.sw-part.sw-wire *{visibility:hidden!important}

/* content gestures: typing reveals left to right, boxes/buttons are dragged out
   of their top-left corner (both axes grow together) */
.sw-part.sw-typing{clip-path:inset(0 calc((1 - var(--sw-reveal,0)) * 100%) 0 0)}
.sw-part.sw-pull{clip-path:inset(0 calc((1 - var(--sw-reveal,0)) * 100%) calc((1 - var(--sw-reveal,0)) * 100%) 0)}

/* copy-drag: a clone of the block travels into its slot */
.sw-ghost{position:absolute;left:0;top:0;display:block!important;margin:0!important;pointer-events:none;opacity:.92;overflow:hidden;border-radius:6px;filter:drop-shadow(0 10px 24px rgba(0,0,0,.18))}

/* finale: every plane blooms into fireworks and is gone */
.sw-spark{position:absolute;left:0;top:0;border-radius:50%;background:var(--sw-c,#1a8cff);pointer-events:none;will-change:transform,opacity}
.sw-ring{position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border:1.5px solid var(--sw-c,#1a8cff);border-radius:50%;pointer-events:none;will-change:transform,opacity}

.sw-hud{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;height:40px;padding:0 10px;border-radius:12px;background:rgba(24,24,26,.93);color:rgba(255,255,255,.72);font:500 13px/1 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;pointer-events:auto;box-shadow:0 8px 28px rgba(0,0,0,.28)}
.sw-avatars{display:flex;margin-right:2px}
.sw-avatars>i{width:18px;height:18px;margin-right:-5px;border-radius:50%;display:grid;place-items:center;color:#fff;font:600 9px/1 ui-sans-serif,system-ui;font-style:normal;box-shadow:0 0 0 1.5px rgba(24,24,26,.93)}
.sw-num{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.sw-dim{color:rgba(255,255,255,.5)}
.sw-sep{width:1px;height:16px;background:rgba(255,255,255,.16)}
.sw-bar{position:relative;width:120px;height:2px;border-radius:2px;background:rgba(255,255,255,.2);overflow:hidden}
.sw-bar>i{position:absolute;left:0;top:0;bottom:0;width:0;background:#1a8cff;transition:width .25s ease}
.sw-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:rgba(255,255,255,.72);font:inherit;font-size:12.5px;padding:4px 6px;border-radius:6px;cursor:pointer;line-height:1.2}
.sw-btn:hover{color:#fff;background:rgba(255,255,255,.1)}
.sw-btn.is-on{color:#8fc0ff;background:rgba(26,140,255,.18)}
.sw-hint{display:none;font-size:12px;color:rgba(255,255,255,.55);white-space:nowrap}
.sw-hud.has-hint .sw-hint{display:inline}
`;

export function injectStyles(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export function removeStyles(doc = document) {
  doc.getElementById(STYLE_ID)?.remove();
}
