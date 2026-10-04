// The page entry. Thin on purpose: it reads the token and run from the URL fragment (then strips them), picks the run, and wires
//   stream client / lifecycle -> mapper state -> renderer (intents and state diff) and overlays.
// Read-only: the only requests are GET /snapshot and GET /events (through the stream client). The token lives in the stream
// client's closure and nowhere in the page: not in the URL, the DOM, storage or a global.
// Everything the page touches is injected through `BootEnv`, so a test boots it against stubs; the browser call is at the bottom.
import type { Snapshot } from '@cockpit/orchestrator';
import { createLifecycle, type DocLike, type Lifecycle } from './lifecycle.js';
import type { CharacterId } from './model.js';
import { createOverlays, type OverlayDocument, type Overlays } from './overlays.js';
import { createRenderer, wantsFps, type CanvasRenderer, type RenderSurface } from './renderer.js';
import { AUTH_MESSAGE, type FetchLike, type GarageUpdate } from './stream.js';

export { AUTH_MESSAGE };
export const NO_RUNS_MESSAGE = 'No runs yet — start one in the cockpit, then reopen the garage';
export const LOAD_FAILED_MESSAGE = 'Could not load the run list — reopen with `cockpit garage` or `/cockpit garage`';

const TERMINAL_RUN = new Set(['completed', 'rejected', 'failed']);
/** A click within this many CSS pixels of a character's anchor selects it. */
const PICK_RADIUS = 28;

export interface Boot {
  token: string;
  run: string | null;
}

/** `#token=…&run=…` (a leading `#` is optional). Missing parts come back empty / null. */
export function parseHash(hash: string): Boot {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return { token: params.get('token') ?? '', run: params.get('run') || null };
}

/** The given run, else the newest non-terminal run, else the newest run; null when there are none. */
export function selectRun(runs: readonly { id: string; status: string; createdAt: string }[], given: string | null): string | null {
  if (given) return given;
  const newestFirst = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return (newestFirst.find((r) => !TERMINAL_RUN.has(r.status)) ?? newestFirst[0])?.id ?? null;
}

export interface CanvasLike extends RenderSurface {
  addEventListener(type: 'click', listener: (ev: { clientX: number; clientY: number }) => void): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface BootEnv {
  hash: string;
  /** `history.replaceState(null, '', url)`: called once with the path and query only, so the fragment is gone. */
  replaceUrl(url: string): void;
  /** The current path and query, without the fragment. */
  url: string;
  doc: DocLike & OverlayDocument;
  canvas: CanvasLike;
  fetch: FetchLike;
  raf(callback: () => void): number;
  caf(handle: number): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  viewport(): { width: number; height: number; dpr: number };
  onResize(listener: () => void): void;
  /** Defaults to the Canvas2D renderer. */
  createRenderer?(canvas: RenderSurface): CanvasRenderer;
}

export interface Page {
  overlays: Overlays;
  renderer: CanvasRenderer | null;
  lifecycle: Lifecycle | null;
  /** The run being watched, or null when boot stopped early. */
  runId: string | null;
  dispose(): void;
}

export async function boot(env: BootEnv): Promise<Page> {
  const { token, run } = parseHash(env.hash);
  env.replaceUrl(env.url); // strip the token and run from the address bar and history, whatever happens next
  const overlays = createOverlays({ doc: env.doc });
  const page: Page = { overlays, renderer: null, lifecycle: null, runId: null, dispose: () => overlays.dispose() };

  if (!token) {
    overlays.authExpired();
    return page;
  }

  // Wiring starts once a run is known. With no run given, finding one is itself visibility-aware: it is deferred while the tab is
  // hidden, its request is aborted on hide, a stale answer is ignored, and it resumes when the tab is visible again.
  let discovery: AbortController | null = null;
  let discovering = false;
  const onVisibility = (): void => {
    if (env.doc.visibilityState === 'hidden') {
      discovery?.abort();
      discovery = null;
    } else discover();
  };
  const stopDiscovery = (): void => {
    discovering = false;
    discovery?.abort();
    discovery = null;
    env.doc.removeEventListener('visibilitychange', onVisibility);
  };
  function discover(): void {
    if (!discovering || discovery || env.doc.visibilityState === 'hidden') return;
    const ctl = (discovery = new AbortController());
    void (async () => {
      try {
        const res = await env.fetch('/snapshot', {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: ctl.signal,
        });
        if (discovery !== ctl) return;
        if (res.status === 401) {
          stopDiscovery();
          return overlays.authExpired();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const id = selectRun(((await res.json()) as Snapshot).runs, null);
        if (discovery !== ctl) return;
        discovery = null;
        stopDiscovery();
        if (!id) return overlays.banner(NO_RUNS_MESSAGE);
        overlays.banner(null); // a retry after a failed attempt
        wire(id);
      } catch {
        if (discovery !== ctl) return; // aborted by a hide: the next show starts over
        discovery = null;
        overlays.banner(LOAD_FAILED_MESSAGE); // stays listening: showing the tab again retries
      }
    })();
  }

  page.dispose = () => {
    stopDiscovery();
    overlays.dispose();
  };
  if (run) wire(run);
  else {
    discovering = true;
    env.doc.addEventListener('visibilitychange', onVisibility);
    discover();
  }
  return page;

  function wire(runId: string): void {
  page.runId = runId;
  const renderer = (env.createRenderer ?? ((c) => createRenderer({ canvas: c })))(env.canvas);
  page.renderer = renderer;
  const fitCanvas = (): void => {
    const v = env.viewport();
    renderer.resize(v.width, v.height, v.dpr);
  };
  fitCanvas();
  env.onResize(fitCanvas);

  const fpsEl = wantsFps(env.hash) ? env.doc.getElementById('g-fps') : null;
  fpsEl?.removeAttribute('hidden');

  let latest: GarageUpdate['state'] | null = null;
  let snapshot: Snapshot | null = null;
  const agentInfo = (agentId: string) => {
    const a = snapshot?.agents.find((x) => x.id === agentId);
    return a ? { model: a.model, effort: a.effort } : null;
  };
  const anchor = (id: CharacterId) => {
    const a = renderer.anchorOf(id);
    return a && a.visible ? { x: a.x, y: a.y } : null;
  };

  env.canvas.addEventListener('click', (ev) => {
    const r = env.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best: CharacterId | null = null;
    let bestD = PICK_RADIUS * PICK_RADIUS;
    for (const [id, a] of Object.entries(renderer.anchors())) {
      if (!a.visible) continue;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d <= bestD) {
        best = id;
        bestD = d;
      }
    }
    overlays.select(best);
  });

  const lifecycle = createLifecycle({
    doc: env.doc,
    fetch: env.fetch,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    now: env.now,
    raf: env.raf,
    caf: env.caf,
    token,
    runId,
    onUpdate(u) {
      latest = u.state;
      if (u.kind === 'event') for (const intent of u.intents) renderer.applyIntent(intent);
      else renderer.syncState(u.state);
    },
    onSnapshot: (snap) => (snapshot = snap),
    onAuthError: (message) => overlays.banner(message),
    onFrame(now) {
      renderer.frame(now);
      if (latest) overlays.render({ state: latest, anchor, agentInfo });
      if (fpsEl) fpsEl.textContent = `${renderer.stats().frameMs.toFixed(1)} ms · ${Math.round(renderer.stats().fps)} fps`;
    },
  });
  page.lifecycle = lifecycle;
  page.dispose = () => {
    lifecycle.dispose();
    renderer.dispose();
    overlays.dispose();
  };
  lifecycle.start();
  }
}

// Browser entry: runs only where there is a real page (tests import this module under node and call `boot` with stubs).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const canvas = document.getElementById('g-canvas') as unknown as CanvasLike & HTMLCanvasElement;
  void boot({
    hash: location.hash,
    url: location.pathname + location.search,
    replaceUrl: (url) => history.replaceState(null, '', url),
    doc: document as unknown as BootEnv['doc'],
    canvas,
    fetch: (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>,
    raf: (cb) => requestAnimationFrame(cb),
    caf: (h) => cancelAnimationFrame(h),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as number),
    now: () => Date.now(),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    onResize: (fn) => window.addEventListener('resize', fn),
  });
}
