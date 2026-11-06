import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createSwarm } from './index.js';

/**
 * React wrapper.
 *
 *   <SwarmDraw agents={18} maxConcurrent={6}>
 *     <section className="card">…</section>
 *   </SwarmDraw>
 *
 * The wrapper's own <div> is the detection root, so the swarm only draws what
 * you put inside it. Everything else is the plain `createSwarm` option object.
 */
export const SwarmDraw = forwardRef(function SwarmDraw(props, ref) {
  const { children, className, style, autoStart = true, ...options } = props;
  const host = useRef(null);
  const swarm = useRef(null);
  const latest = useRef(options);

  latest.current = options;
  // Restart when the serialisable options change (functions are ignored).
  const signature = JSON.stringify({ ...options, onDone: undefined, document: undefined });

  useEffect(() => {
    if (!autoStart || !host.current) return undefined;
    const node = host.current;
    const instance = createSwarm({
      ...latest.current,
      root: node,
      document: node.ownerDocument,
    });
    instance.start();
    swarm.current = instance;

    return () => {
      instance.stop();
      swarm.current = null;
    };
  }, [signature, autoStart]);

  useImperativeHandle(
    ref,
    () => ({
      start: () => swarm.current?.start(),
      stop: () => swarm.current?.stop(),
      tour: (on = true) => swarm.current?.tour(on),
      setSpeed: (speed) => swarm.current?.setSpeed(speed),
      get state() {
        return swarm.current?.state;
      },
    }),
    [],
  );

  return createElement('div', { ref: host, className, style }, children);
});

export default SwarmDraw;
