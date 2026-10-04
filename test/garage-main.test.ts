import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGE, NO_RUNS_MESSAGE, boot, parseHash, selectRun, type BootEnv, type CanvasLike } from '../packages/garage/src/main';
import type { GarageState } from '../packages/garage/src/model';
import { IDS, type OverlayElement } from '../packages/garage/src/overlays';
import { createRenderer, type CanvasRenderer, type RenderCtx, type RenderSurface } from '../packages/garage/src/renderer';
import type { FetchLike, ResponseLike } from '../packages/garage/src/stream';
import { MISSION_RUN_ID, marks, tsOf } from './garage-mission';
import { FakeClock, FakeDaemon, FakeDoc, FakeRaf, flush, idle, missionDaemon } from './garage-stream-harness';

class El implements OverlayElement {
  textContent: string | null = '';
  attrs: Record<string, string> = {};
  style = { setProperty: () => {} };
  children: El[] = [];
  listeners: Record<string, () => void> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  append(...n: El[]) { this.children.push(...n); }
  replaceChildren(...n: El[]) { this.children = n; }
  addEventListener(t: string, fn: () => void) { this.listeners[t] = fn; }
  remove() {}
  texts(): string[] { return [this.textContent ?? '', ...this.children.flatMap((c) => c.texts())].filter(Boolean); }
}

/** A canvas that is its own 2D context and draws nothing. */
class Surf implements RenderSurface, RenderCtx {
  fillStyle: string | object = '';
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  style = { width: '', height: '' };
  constructor(public width: number, public height: number) {}
  getContext(): RenderCtx { return this; }
  fillRect() {}
  drawImage() {}
  setTransform() {}
}

const run = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });
const RUNS = [run('old', 'completed', '2026-01-01'), run('mid', 'running', '2026-01-02'), run('new', 'failed', '2026-01-03')];

interface Setup {
  hash: string;
  runs?: ReturnType<typeof run>[];
  status?: number;
  daemon?: FakeDaemon;
  hidden?: boolean;
  t?: number;
  /** Use the real Canvas2D renderer over stub surfaces. */
  realRenderer?: boolean;
}

function setup(opts: Setup) {
  const clock = new FakeClock(opts.t ?? 1000);
  const fdoc = new FakeDoc();
  if (opts.hidden) fdoc.visibilityState = 'hidden';
  const raf = new FakeRaf();
  const els = new Map<string, El>(Object.values(IDS).map((id) => [id, new El()]));
  els.set('g-fps', new El());
  const requests: { method: string; url: string }[] = [];
  const replaced: string[] = [];
  const fetch: FetchLike = opts.daemon
    ? opts.daemon.fetch
    : async (url, init) => {
        requests.push({ method: init.method, url });
        const ok = (opts.status ?? 200) === 200 && url.startsWith('/snapshot') && !url.includes('runId');
        return { ok, status: opts.status ?? (ok ? 200 : 503), json: async () => ({ runs: opts.runs ?? RUNS }), body: null } as ResponseLike;
      };
  const clicks: ((ev: { clientX: number; clientY: number }) => void)[] = [];
  const canvas = Object.assign(new Surf(800, 600), {
    addEventListener: (_t: string, fn: (typeof clicks)[number]) => clicks.push(fn),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 1, height: 1 }),
  }) as unknown as CanvasLike;
  const calls = { synced: [] as GarageState[], intents: [] as unknown[], frames: 0, disposed: 0 };
  const renderer = {
    resize() {},
    dispose() { calls.disposed++; },
    frame() { calls.frames++; },
    syncState: (s: GarageState) => calls.synced.push(s),
    applyIntent: (i: unknown) => calls.intents.push(i),
    anchorOf: () => null,
    inspect: () => null,
    anchors: () => (calls.synced.length ? { 'lead-1': { x: 100, y: 100, visible: true }, far: { x: 900, y: 900, visible: true } } : {}),
    stats: () => ({ frameMs: 1, fps: 60 }),
  } as unknown as CanvasRenderer;
  const env: BootEnv = {
    hash: opts.hash, url: '/garage', replaceUrl: (u) => replaced.push(u),
    doc: Object.assign(fdoc, {
      createElement: () => new El(), getElementById: (id: string) => els.get(id) ?? null,
      documentElement: { style: { setProperty: () => {} } },
    }),
    canvas, fetch, raf: raf.raf, caf: raf.caf, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    viewport: () => ({ width: 800, height: 600, dpr: 1 }), onResize: () => {}, createRenderer: opts.realRenderer ? (c) => createRenderer({ canvas: c, surfaces: { create: (w, h) => new Surf(w, h) } }) : () => renderer,
  };
  return { env, requests, replaced, els, fdoc, raf, clock, clicks, calls };
}

describe('garage main', () => {
  it('parses the token and run from the hash', () => {
    expect(parseHash('#token=abc&run=r1')).toEqual({ token: 'abc', run: 'r1' });
    expect(parseHash('')).toEqual({ token: '', run: null });
  });

  it('selects the given run, else the newest non-terminal, else the newest', () => {
    expect(selectRun(RUNS, 'x')).toBe('x');
    expect(selectRun(RUNS, null)).toBe('mid');
    expect(selectRun(RUNS.filter((r) => r.id !== 'mid'), null)).toBe('new');
    expect(selectRun([], null)).toBeNull();
  });

  it('strips the token from the URL and keeps it out of the page and of every URL', async () => {
    const t = setup({ hash: '#token=sekret&fps' });
    const page = await boot(t.env);
    await flush();
    expect(t.replaced).toEqual(['/garage']);
    expect(page.runId).toBe('mid');
    expect(t.requests.every((r) => r.method === 'GET' && /^\/(snapshot|events)/.test(r.url) && !r.url.includes('sekret'))).toBe(true);
    expect(t.requests.some((r) => r.url === '/snapshot')).toBe(true);
    expect(t.requests.some((r) => r.url.startsWith('/snapshot?runId=mid'))).toBe(true);
    expect(t.els.get('g-fps')!.attrs.hidden).toBeUndefined();
    page.dispose();
  });

  it('uses the given run without listing runs first', async () => {
    const t = setup({ hash: '#token=sekret&run=given' });
    const page = await boot(t.env);
    await flush();
    expect(page.runId).toBe('given');
    expect(t.requests.every((r) => r.url.includes('runId=given'))).toBe(true);
    page.dispose();
  });

  it('shows the reopen message and issues no data request without a token', async () => {
    const t = setup({ hash: '' });
    await boot(t.env);
    await flush();
    expect(t.requests).toEqual([]);
    expect(t.els.get(IDS.banner)!.textContent).toBe(AUTH_MESSAGE);
    expect(t.replaced).toEqual(['/garage']);
  });

  it('shows the auth message on a 401 and the empty message when there are no runs', async () => {
    const a = setup({ hash: '#token=t', status: 401 });
    await boot(a.env);
    await flush();
    expect(a.els.get(IDS.banner)!.textContent).toBe(AUTH_MESSAGE);
    const b = setup({ hash: '#token=t', runs: [] });
    await boot(b.env);
    await flush();
    expect(b.els.get(IDS.banner)!.textContent).toBe(NO_RUNS_MESSAGE);
    expect(b.requests).toHaveLength(1);
  });

  describe('lifecycle wiring (mission daemon)', () => {
    const HEAD = marks.workersRunning!;
    const mission = (extra: Partial<Setup> = {}) => {
      const daemon = missionDaemon(HEAD);
      return { daemon, ...setup({ hash: `#token=tok&run=${MISSION_RUN_ID}`, daemon, t: tsOf(HEAD), ...extra }) };
    };

    it('syncs the snapshot, streams from its lastSeq, delivers intents, renders overlays, and leaves nothing running when hidden', async () => {
      const t = mission();
      const page = await boot(t.env);
      await flush();
      expect(t.calls.synced).toHaveLength(1);
      expect(t.calls.synced[0]!.run.runId).toBe(MISSION_RUN_ID);
      expect(t.daemon.snapshotRequests[0]!.url).toContain(`runId=${MISSION_RUN_ID}`);
      expect(t.daemon.eventRequests).toHaveLength(1);
      expect(t.daemon.eventRequests[0]!.url).toContain(`since=${t.daemon.snapshotsServed[0]!.lastSeq}`);
      expect(t.daemon.eventRequests[0]!.url).toContain('catchup=1');
      expect(t.daemon.requests.every((r) => r.method === 'GET' && r.headers.authorization === 'Bearer tok')).toBe(true);

      // a frame draws and renders the HUD from the mapped state
      t.raf.tick();
      expect(t.calls.frames).toBe(1);
      expect(t.els.get(IDS.hud)!.texts().length).toBeGreaterThan(0);

      // live events reach the renderer as intents
      t.daemon.advanceTo(marks.rateTestFailed!);
      await flush();
      expect(t.calls.intents.length).toBeGreaterThan(0);

      // hiding cancels the rAF, the stream and the timer
      t.fdoc.set('hidden');
      await flush();
      expect(idle(t.daemon, t.clock, t.raf)).toBe(true);
      page.dispose();
      expect(t.calls.disposed).toBe(1);
    });

    it('a live structural event reaches the renderer: layout, destination and character metadata before any new snapshot', async () => {
      const t = mission({ realRenderer: true, t: tsOf(marks.proposalsDecided!) });
      t.daemon.head = marks.proposalsDecided!;
      const page = await boot(t.env);
      await flush();
      const r = page.renderer!;
      const client = page.lifecycle!.client;
      expect(Object.keys(client.state()!.bayOf)).toHaveLength(0); // no bays yet
      expect(r.layout.resolve('bay:1')).toBeFalsy();

      t.daemon.advanceTo(marks.workersRunning!); // plan, tasks and workers arrive over the stream only
      await flush();
      expect(t.daemon.snapshotRequests).toHaveLength(1); // no reconcile has happened
      const state = client.state()!;
      const workers = Object.values(state.characters).filter((c) => c.station.startsWith('bay:'));
      expect(workers.length).toBeGreaterThan(0);
      expect(r.layout.resolve(workers[0]!.station)).toBeTruthy();
      for (const w of workers) expect(r.inspect(w.id)!.station).toBe(w.station); // not parked at the entrance

      // metadata: a task-scoped celebration finds the newly assigned worker
      const w = workers.find((c) => c.task)!;
      for (let n = 1; n <= 40; n++) r.frame(n * 250); // let everyone arrive
      expect(r.inspect(w.id)!.moving).toBe(false);
      const before = r.inspect(w.id)!.pose;
      r.applyIntent({ type: 'celebrate', scope: 'task', task: w.task });
      r.frame(10_250);
      r.frame(10_500);
      expect(r.inspect(w.id)!.pose).not.toBe(before);
      page.dispose();
    });

    it('a canvas click selects the nearest character and opens the detail panel; a miss closes it', async () => {
      const t = mission();
      await boot(t.env);
      await flush();
      t.raf.tick();
      const detail = t.els.get(IDS.detail)!;
      expect(detail.attrs.hidden).toBeDefined();
      t.clicks[0]!({ clientX: 10 + 105, clientY: 20 + 98 }); // within the radius of lead-1 at (100, 100)
      expect(detail.attrs.hidden).toBeUndefined();
      expect(detail.texts().length).toBeGreaterThan(0);
      t.clicks[0]!({ clientX: 10 + 400, clientY: 20 + 400 });
      expect(detail.attrs.hidden).toBeDefined();
    });

    it('boots hidden without any request, and starts discovery when the tab becomes visible', async () => {
      const t = mission({ hash: '#token=tok', hidden: true });
      const page = await boot(t.env);
      await flush();
      expect(t.daemon.requests).toEqual([]);
      expect(t.raf.pending).toBe(0);
      t.fdoc.set('visible');
      await flush();
      expect(t.daemon.snapshotRequests[0]!.url).toBe('/snapshot');
      expect(page.runId).toBe(MISSION_RUN_ID);
      expect(t.calls.synced).toHaveLength(1);
      expect(t.fdoc.listeners.size).toBe(1); // discovery handed visibility over to the lifecycle
      t.fdoc.set('hidden');
      await flush();
      expect(idle(t.daemon, t.clock, t.raf)).toBe(true);
    });

    it('hiding during discovery aborts the request, ignores its result, and resumes when visible', async () => {
      const t = mission({ hash: '#token=tok' });
      t.daemon.holdSnapshots = true;
      const page = await boot(t.env);
      await flush();
      expect(t.daemon.snapshotActive).toBe(1);
      t.fdoc.set('hidden');
      await flush();
      expect(t.daemon.snapshotActive).toBe(0);
      t.daemon.release();
      await flush();
      expect(page.runId).toBeNull();
      expect(t.daemon.eventRequests).toHaveLength(0);
      expect(t.raf.pending).toBe(0);

      t.fdoc.set('visible');
      await flush();
      expect(t.daemon.snapshotRequests).toHaveLength(2);
      t.daemon.release();
      await flush();
      expect(page.runId).toBe(MISSION_RUN_ID);
      t.daemon.release(); // the lifecycle's own sync snapshot
      await flush();
      expect(t.calls.synced).toHaveLength(1);
      page.dispose();
    });
  });
});
