import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createSwarm } from './index.js';

/**
 * Vue 3 wrapper.
 *
 *   <SwarmDraw :options="{ agents: 18, maxConcurrent: 6 }">
 *     <section class="card">…</section>
 *   </SwarmDraw>
 *
 * The component's own <div> is the detection root, so the swarm only draws what
 * is inside the slot. Everything else is the plain `createSwarm` option object.
 */
export const SwarmDraw = defineComponent({
  name: 'SwarmDraw',
  props: {
    options: { type: Object, default: () => ({}) },
    autoStart: { type: Boolean, default: true },
  },
  setup(props, { slots, expose }) {
    const host = ref(null);
    let swarm = null;

    const stop = () => {
      if (swarm) swarm.stop();
      swarm = null;
    };

    const start = () => {
      if (!host.value) return;
      stop();
      swarm = createSwarm({
        ...props.options,
        root: host.value,
        document: host.value.ownerDocument,
      });
      swarm.start();
    };

    onMounted(() => {
      if (props.autoStart) start();
    });
    onBeforeUnmount(stop);

    watch(
      () => props.options,
      () => {
        if (props.autoStart) start();
      },
      { deep: true },
    );
    watch(
      () => props.autoStart,
      (on) => (on ? start() : stop()),
    );

    expose({
      start,
      stop,
      tour: (on = true) => swarm?.tour(on),
      setSpeed: (speed) => swarm?.setSpeed(speed),
      get state() {
        return swarm?.state;
      },
    });

    return () => h('div', { ref: host }, slots.default ? slots.default() : []);
  },
});

export default SwarmDraw;
