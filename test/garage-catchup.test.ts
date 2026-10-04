import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAdapter } from '@cockpit/agents';
import { startDaemon, type Daemon } from '@cockpit/orchestrator';
import { testConfig, tempDir } from './helpers';

let daemon: Daemon;
let base: string;
let auth: { authorization: string };

beforeAll(async () => {
  const root = tempDir('garage-catchup');
  const srcDir = join(root, 'garage-src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'index.html'), '<!doctype html>');
  daemon = await startDaemon(testConfig(join(root, 'data')), {
    dbPath: ':memory:',
    garageSrcDir: srcDir,
    configureRegistry: (r) => r.register('fake', (p) => new FakeAdapter(p, async () => ({ text: '' }))),
  });
  base = `http://127.0.0.1:${daemon.info.port}`;
  auth = { authorization: `Bearer ${daemon.info.readToken}` };
});

afterAll(async () => {
  await daemon.stop();
});

const store = () => daemon.engine.ctx.store;
const bus = () => daemon.engine.ctx.bus;
let projects = 0;

/** A fresh run with `n` backlog events (and, between them, some for another run that must never show). */
function seedRun(n: number): { runId: string; seqs: number[] } {
  const project = store().ensureProject(`p-${projects++}`);
  const run = store().createRun(project.id, 'r');
  const other = store().createRun(project.id, 'other');
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) {
    seqs.push(store().appendEvent({ runId: run.id, type: 'run.status_changed', data: { from: `a${i}`, to: `b${i}` } }).seq);
    if (i % 7 === 0) store().appendEvent({ runId: other.id, type: 'run.status_changed', data: { from: 'x', to: 'y' } });
  }
  return { runId: run.id, seqs };
}

interface Frame {
  event: string;
  id: string | null;
  data: unknown;
}

/** An SSE connection that collects frames in the background; the wait helpers reject on timeout. */
async function connect(path: string) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { ...auth, accept: 'text/event-stream' }, signal: ctl.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;
  const frames: Frame[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return void (ended = true);
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        if (!event) continue; // a comment: ': connected' or ': ping'
        frames.push({ event, id: /^id: (.*)$/m.exec(block)?.[1] ?? null, data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) });
      }
    }
  })();
  const waitFor = async (pred: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${frames.length} frames, ended=${ended})`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    frames,
    waitFrames: (n: number) => waitFor(() => frames.length >= n, `${n} frames`),
    waitEnd: () => waitFor(() => ended, 'the stream to end'),
    isEnded: () => ended,
    close: async () => {
      ctl.abort();
      await pump;
    },
  };
}

const seqsOf = (frames: Frame[]) => frames.map((f) => (f.data as { seq: number }).seq);

describe('GET /events?catchup=1', () => {
  it('replays 2500 events in order, then goes live with no gap or duplicate at the boundary', async () => {
    const { runId, seqs } = seedRun(2500);
    const c = await connect(`/events?runId=${runId}&since=0&catchup=1`);
    await c.waitFrames(2500);
    // Live events straight away: the boundary is where the replay ends and the subscription begins.
    const live = [1, 2, 3].map((i) => bus().emit('run.status_changed', runId, { from: `l${i}`, to: `m${i}` }).seq);
    bus().emit('run.status_changed', null, { from: 'other', to: 'run' }); // not this run: filtered out
    await c.waitFrames(2503);
    const got = seqsOf(c.frames);
    expect(got).toEqual([...seqs, ...live]);
    expect(c.frames.every((f) => f.id === String((f.data as { seq: number }).seq))).toBe(true);
    expect(new Set(got).size).toBe(got.length);
    await c.close();
  });

  it('resumes after since', async () => {
    const { runId, seqs } = seedRun(1200);
    const c = await connect(`/events?runId=${runId}&since=${seqs[1100]}&catchup=1`);
    await c.waitFrames(99);
    expect(seqsOf(c.frames)).toEqual(seqs.slice(1101));
    await c.close();
  });

  it('past the hard cap sends a resync frame, with no id, and ends the response', async () => {
    const { runId, seqs } = seedRun(10_001);
    const c = await connect(`/events?runId=${runId}&since=0&catchup=1`);
    await c.waitEnd();
    expect(c.frames).toHaveLength(10_001);
    expect(seqsOf(c.frames.slice(0, 10_000))).toEqual(seqs.slice(0, 10_000));
    const last = c.frames[10_000]!;
    expect(last.event).toBe('resync');
    expect(last.id).toBeNull();
    expect(last.data).toEqual({});
    await c.close();
  }, 60_000);

  it('a backlog of exactly the cap is replayed whole and the stream stays live', async () => {
    const { runId, seqs } = seedRun(10_000);
    const c = await connect(`/events?runId=${runId}&since=0&catchup=1`);
    await c.waitFrames(10_000);
    const live = bus().emit('run.status_changed', runId, { from: 'a', to: 'b' }).seq;
    await c.waitFrames(10_001);
    expect(c.isEnded()).toBe(false);
    expect(seqsOf(c.frames)).toEqual([...seqs, live]);
    expect(c.frames.some((f) => f.event === 'resync')).toBe(false);
    await c.close();
  }, 60_000);
});

describe('GET /events without catchup', () => {
  it('replays the first 1000 events only, then live', async () => {
    const { runId, seqs } = seedRun(2500);
    const c = await connect(`/events?runId=${runId}&since=0`);
    await c.waitFrames(1000);
    const live = bus().emit('run.status_changed', runId, { from: 'a', to: 'b' }).seq;
    await c.waitFrames(1001);
    expect(seqsOf(c.frames)).toEqual([...seqs.slice(0, 1000), live]);
    await c.close();
  });
});

describe('GET /snapshot?runId=', () => {
  it('holds just that run, even one older than the visible ten, in the same shape', async () => {
    const project = store().ensureProject('snapshot-runs');
    const ids = Array.from({ length: 12 }, (_, i) => store().createRun(project.id, `run ${i}`).id);
    const get = async (q = '') => (await (await fetch(`${base}/snapshot${q}`, { headers: auth })).json()) as Record<string, unknown> & { runs: { id: string }[] };

    const all = await get();
    const hidden = ids.find((id) => !all.runs.some((r) => r.id === id))!;
    expect(hidden).toBeDefined();

    const one = await get(`?runId=${hidden}`);
    expect(one.runs).toHaveLength(1);
    expect(one.runs[0]!.id).toBe(hidden);
    expect(Object.keys(one).sort()).toEqual(Object.keys(all).sort());
    expect(Object.keys(one.runs[0]!).sort()).toEqual(Object.keys(all.runs[0]!).sort());
    expect(one.lastSeq).toBeTypeOf('number');

    const visible = await get(`?runId=${all.runs[0]!.id}`);
    expect(visible.runs.map((r) => r.id)).toEqual([all.runs[0]!.id]);

    expect((await get('?runId=run_unknown')).runs).toEqual([]);
  });
});
