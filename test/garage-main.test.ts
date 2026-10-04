import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGE, NO_RUNS_MESSAGE, boot, parseHash, selectRun, type BootEnv, type CanvasLike } from '../packages/garage/src/main';
import { IDS, type OverlayElement } from '../packages/garage/src/overlays';
import type { CanvasRenderer } from '../packages/garage/src/renderer';
import type { FetchLike, ResponseLike } from '../packages/garage/src/stream';
import { FakeClock, FakeDoc, FakeRaf, flush } from './garage-stream-harness';

class El implements OverlayElement {
  textContent: string | null = '';
  attrs: Record<string, string> = {};
  style = { setProperty: () => {} };
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  append() {}
  replaceChildren() {}
  addEventListener() {}
  remove() {}
}

const run = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });
const RUNS = [run('old', 'completed', '2026-01-01'), run('mid', 'running', '2026-01-02'), run('new', 'failed', '2026-01-03')];

function setup(opts: { hash: string; runs?: ReturnType<typeof run>[]; status?: number }) {
  const clock = new FakeClock(1000);
  const fdoc = new FakeDoc();
  const raf = new FakeRaf();
  const els = new Map<string, El>(Object.values(IDS).map((id) => [id, new El()]));
  els.set('g-fps', new El());
  const requests: { method: string; url: string }[] = [];
  const replaced: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ method: init.method, url });
    const ok = (opts.status ?? 200) === 200 && url.startsWith('/snapshot') && !url.includes('runId');
    return { ok, status: opts.status ?? (ok ? 200 : 503), json: async () => ({ runs: opts.runs ?? RUNS }), body: null } as ResponseLike;
  };
  const canvas = { addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) } as unknown as CanvasLike;
  const renderer = { resize() {}, dispose() {}, frame() {}, syncState() {}, applyIntent() {}, anchorOf: () => null, anchors: () => ({}), stats: () => ({ frameMs: 1, fps: 60 }) } as unknown as CanvasRenderer;
  const env: BootEnv = {
    hash: opts.hash, url: '/garage', replaceUrl: (u) => replaced.push(u),
    doc: Object.assign(fdoc, {
      createElement: () => new El(), getElementById: (id: string) => els.get(id) ?? null,
      documentElement: { style: { setProperty: () => {} } },
    }),
    canvas, fetch, raf: raf.raf, caf: raf.caf, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    viewport: () => ({ width: 800, height: 600, dpr: 1 }), onResize: () => {}, createRenderer: () => renderer,
  };
  return { env, requests, replaced, els };
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
    expect(a.els.get(IDS.banner)!.textContent).toBe(AUTH_MESSAGE);
    const b = setup({ hash: '#token=t', runs: [] });
    await boot(b.env);
    expect(b.els.get(IDS.banner)!.textContent).toBe(NO_RUNS_MESSAGE);
    expect(b.requests).toHaveLength(1);
  });
});
