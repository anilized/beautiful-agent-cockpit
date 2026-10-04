// The page lifecycle: the garage works only while the tab is visible.
//   visible  a full sync (snapshot, then the event stream) and the animation-frame loop
//   hidden   cancel the rAF, abort the stream and any snapshot fetch, clear the reconcile timer: zero timers, rafs, readers or
//            fetches remain, and nothing wakes the page until it is visible again
//   401      the stream client halts and the message is shown; the lifecycle then stops listening too
// `doc`, `fetch`, `raf`/`caf`, timers and `now` are injected, so a test drives it all with stubs and a fake clock.
import { createStreamClient, type StreamClient, type StreamClientOptions } from './stream.js';

/** The part of `document` the lifecycle uses. */
export interface DocLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface LifecycleOptions extends StreamClientOptions {
  doc: DocLike;
  raf(callback: () => void): number;
  caf(handle: number): void;
  /** One animation frame at `now` (epoch ms): the renderer's `frame`. */
  onFrame(now: number): void;
}

export interface Lifecycle {
  /** Listens for visibility changes and, when the tab is visible, syncs and starts drawing. */
  start(): void;
  /** Hides everything and stops listening. */
  dispose(): void;
  client: StreamClient;
}

export function createLifecycle(o: LifecycleOptions): Lifecycle {
  let active = false; // visible and running
  let finished = false; // disposed, or halted by a 401
  let rafId: number | null = null;

  const loop = (): void => {
    rafId = o.raf(loop);
    o.onFrame(o.now());
  };
  const stopRaf = (): void => {
    if (rafId !== null) o.caf(rafId);
    rafId = null;
  };

  const show = (): void => {
    if (active || finished) return;
    active = true;
    rafId = o.raf(loop);
    client.start();
  };
  const hide = (): void => {
    active = false;
    client.stop();
    stopRaf();
  };
  const onVisibility = (): void => (o.doc.visibilityState === 'hidden' ? hide() : show());
  const finish = (): void => {
    finished = true;
    hide();
    o.doc.removeEventListener('visibilitychange', onVisibility);
  };

  const client = createStreamClient({
    ...o,
    onAuthError: (message) => {
      finish();
      o.onAuthError(message);
    },
  });

  return {
    client,
    start() {
      if (finished) return;
      o.doc.addEventListener('visibilitychange', onVisibility);
      onVisibility();
    },
    dispose: finish,
  };
}
