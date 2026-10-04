// The page lifecycle against a stub document, stub rAF/fetch and a fake clock: visible syncs and draws, hidden leaves nothing running.
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@cockpit/orchestrator';
import type { GarageState } from '../packages/garage/src/model';
import { createLifecycle, type DocLike } from '../packages/garage/src/lifecycle';
import { AUTH_MESSAGE, DEBOUNCE_MS, RECONCILE_MS, isStructural, type GarageUpdate } from '../packages/garage/src/stream';
import { fromSnapshot } from '../packages/garage/src/mapper';
import { FakeClock, FakeDaemon, FakeDoc, FakeRaf, flush, idle, missionDaemon } from './garage-stream-harness';
import { MISSION_RUN_ID, events, marks, snapshotAt, tsOf } from './garage-mission';

// The real document must fit the injected seam.
export const realDocFits = (d: Document): DocLike => d;

const RUN = MISSION_RUN_ID;

function rig(head: number, o: { daemon?: FakeDaemon; hidden?: boolean; token?: string; clockAt?: number } = {}) {
  const daemon = o.daemon ?? missionDaemon(head);
  const clock = new FakeClock(o.clockAt ?? tsOf(head));
  const doc = new FakeDoc();
  if (o.hidden) doc.visibilityState = 'hidden';
  const raf = new FakeRaf();
  const updates: (GarageUpdate & { at: number })[] = [];
  const frames: number[] = [];
  const auth: string[] = [];
  const life = createLifecycle({
    doc, fetch: daemon.fetch, raf: raf.raf, caf: raf.caf, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    token: o.token ?? 'tok', runId: RUN,
    onFrame: (now) => frames.push(now),
    onUpdate: (u) => updates.push({ ...u, at: clock.t }),
    onAuthError: (m) => auth.push(m),
  });
  return { daemon, clock, doc, raf, life, updates, frames, auth };
}

describe('visible', () => {
  it('starts with a full sync and an animation frame loop', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.daemon.eventRequests).toHaveLength(1);
    expect(r.raf.pending).toBe(1);
    expect(r.doc.listeners.size).toBe(1);
    r.raf.tick();
    r.clock.t += 16;
    r.raf.tick();
    expect(r.frames).toEqual([tsOf(marks.workersRunning!), tsOf(marks.workersRunning!) + 16]);
    expect(r.raf.pending).toBe(1); // it keeps asking for the next frame
  });

  it('opening mid-mission shows the state within one second of fake time', async () => {
    const head = marks.rateTestFailed!;
    const r = rig(head);
    const t0 = r.clock.t;
    r.life.start();
    await r.clock.advance(1000);
    expect(r.updates[0]!.at - t0).toBeLessThanOrEqual(1000);
    expect(r.updates[0]!.state).toEqual(fromSnapshot(snapshotAt(head), RUN, r.updates[0]!.at));
  });

  it('never fetches twice at once, however the tab is toggled', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.holdSnapshots = true;
    r.life.start();
    await flush();
    for (let i = 0; i < 4; i++) {
      r.doc.set('hidden');
      r.doc.set('visible');
    }
    await flush();
    expect(r.daemon.maxSnapshotActive).toBe(1);
    r.daemon.holdSnapshots = false;
    r.daemon.release();
    await r.clock.advance(RECONCILE_MS * 3);
    expect(r.daemon.maxSnapshotActive).toBe(1);
    expect(r.raf.pending).toBe(1);
    expect(r.daemon.openReaders).toBe(1);
  });

  it('a duplicate visible event does not start a second sync or loop', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    r.doc.set('visible');
    r.doc.set('visible');
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.raf.pending).toBe(1);
  });
});

describe('hidden', () => {
  it('cancels the rAF, the stream and the timer: zero timers, rafs, readers and fetches remain', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await r.clock.advance(RECONCILE_MS * 2 + 100);
    expect(r.raf.pending).toBe(1);
    expect(r.daemon.openReaders).toBe(1);
    expect(r.clock.pending).toBe(1);
    r.doc.set('hidden');
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    const requests = r.daemon.requests.length;
    await r.clock.advance(10 * 60_000);
    expect(r.daemon.requests).toHaveLength(requests);
    expect(r.raf.pending).toBe(0);
    expect(r.clock.pending).toBe(0);
  });

  it('aborts a snapshot fetch that is in flight', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    await r.clock.advance(RECONCILE_MS - 1);
    r.daemon.holdSnapshots = true;
    await r.clock.advance(1);
    expect(r.daemon.snapshotActive).toBe(1);
    r.doc.set('hidden');
    expect(r.daemon.snapshotActive).toBe(0);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    const updates = r.updates.length;
    r.daemon.release(); // a late answer is ignored
    await r.clock.advance(60_000);
    expect(r.updates).toHaveLength(updates);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
  });

  it('clears an armed debounce', async () => {
    const a = marks.workersRunning!;
    const structural = events.find((e) => e.seq > a && e.runId === RUN && isStructural(e.type))!;
    const r = rig(a);
    r.life.start();
    await flush();
    r.daemon.advanceTo(structural.seq);
    await r.clock.advance(DEBOUNCE_MS / 2);
    expect(r.clock.pending).toBe(1);
    r.doc.set('hidden');
    expect(r.clock.pending).toBe(0);
    await r.clock.advance(60_000);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
  });

  it('while retrying a failed sync leaves no retry timer behind', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.snapshotStatus = 500;
    r.life.start();
    await r.clock.advance(1500);
    expect(r.clock.pending).toBe(1);
    r.doc.set('hidden');
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
  });

  it('a tab that starts hidden does nothing until it is shown', async () => {
    const r = rig(marks.workersRunning!, { hidden: true });
    r.life.start();
    await r.clock.advance(60_000);
    expect(r.daemon.requests).toHaveLength(0);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    r.doc.set('visible');
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.raf.pending).toBe(1);
  });
});

describe('visible again', () => {
  it('runs a full sync: a fresh snapshot, a new stream from its lastSeq, the loop back', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    r.doc.set('hidden');
    r.daemon.head = marks.rateCompleted!; // the mission moved on while the tab was hidden
    r.daemon.advanceTo(marks.rateCompleted!);
    await r.clock.advance(60_000);
    r.doc.set('visible');
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.daemon.eventRequests).toHaveLength(2);
    expect(r.daemon.eventRequests[1]!.url).toBe(`/events?runId=${RUN}&since=${marks.rateCompleted}&catchup=1`);
    expect(r.updates.map((u) => u.kind)).toEqual(['sync', 'sync']);
    expect(r.updates[1]!.previous).toBe(r.updates[0]!.state); // the renderer diffs the two and eases the difference
    expect(r.updates[1]!.state.run.lastSeq).toBe(marks.rateCompleted);
    expect(r.raf.pending).toBe(1);
    expect(r.daemon.openReaders).toBe(1);
    await r.clock.advance(RECONCILE_MS);
    expect(r.updates.at(-1)!.kind).toBe('rebase'); // and the 5 s reconcile is back
  });
});

describe('401', () => {
  it('shows the reopen instruction and stops polling, drawing and listening', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.snapshotStatus = 401;
    r.life.start();
    await r.clock.advance(60_000);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(r.daemon.requests).toHaveLength(1);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    expect(r.doc.listeners.size).toBe(0);
    r.doc.set('hidden');
    r.doc.set('visible');
    await r.clock.advance(60_000);
    expect(r.daemon.requests).toHaveLength(1);
    expect(r.raf.pending).toBe(0);
  });

  it('after the token expires mid-session stops everything, the stream included', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    r.daemon.snapshotStatus = 401;
    await r.clock.advance(RECONCILE_MS);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    expect(r.doc.listeners.size).toBe(0);
  });

  it('with no token asks the daemon for nothing and draws nothing', async () => {
    const r = rig(marks.workersRunning!, { token: '' });
    r.life.start();
    await r.clock.advance(60_000);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(r.daemon.requests).toHaveLength(0);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
  });
});

describe('dispose', () => {
  it('stops everything and listens no more', async () => {
    const r = rig(marks.workersRunning!);
    r.life.start();
    await flush();
    r.life.dispose();
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    expect(r.doc.listeners.size).toBe(0);
    r.doc.set('visible');
    await r.clock.advance(60_000);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
  });
});

describe('a time-driven fine-state change', () => {
  const SES = 'ses_rate1';
  const head = marks.workersRunning!;
  const T = tsOf(head); // the worker's edit
  const iso = (ms: number) => new Date(ms).toISOString();
  // The daemon serves the same snapshot every time: an edit at T, then narration at T+1 s, and no event after it.
  const stillSnapshot = (): Snapshot => {
    const snap = structuredClone(snapshotAt(head));
    const s = snap.runs[0]!.activeSessions.find((x) => x.sessionId === SES)!;
    s.lastTool = { text: 'edit: api/src/middleware/rate-limit.ts', at: iso(T), seq: head };
    s.lastOutput = { kind: 'text', at: iso(T + 1000), seq: head + 1 };
    return snap;
  };
  const view = (u: { state: GarageState }) => {
    const c = u.state.characters[u.state.sessions[SES]!.characterId]!;
    return { state: c.state, station: c.station, home: c.home };
  };

  it('shows the worker implementing at its bay, then thinking at its home station within one reconcile period after T+20 s', async () => {
    const daemon = new FakeDaemon({ events, snapshot: stillSnapshot });
    daemon.head = head;
    const r = rig(head, { daemon, clockAt: T + 2000 });
    r.life.start();
    await flush();
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]!.kind).toBe('sync');
    expect(view(r.updates[0]!)).toMatchObject({ state: 'implementing', station: 'bay:1' });

    // Up to T+20 s the reconciles hand the renderer the same fine state.
    await r.clock.advance(T + 20_000 - r.clock.t);
    const rebases = r.updates.filter((u) => u.kind === 'rebase');
    expect(rebases.length).toBeGreaterThanOrEqual(3);
    for (const u of rebases) expect(view(u)).toMatchObject({ state: 'implementing', station: 'bay:1' });
    expect(view(r.updates.at(-1)!).state).toBe('implementing');

    // No SSE event arrives; the 5 s reconcile with the current clock is what moves it on.
    await r.clock.advance(5000);
    expect(r.daemon.streams.every((s) => s.closed === false)).toBe(true);
    const last = r.updates.at(-1)!;
    expect(last.kind).toBe('rebase');
    expect(last.at).toBeLessThanOrEqual(T + 25_000);
    expect(last.at).toBeGreaterThan(T + 20_000);
    const v = view(last);
    expect(v.state).toBe('thinking');
    expect(v.station).toBe(v.home);
    // The first update that says so came within one reconcile period of T+20 s.
    const first = r.updates.find((u) => view(u).state === 'thinking')!;
    expect(first.at).toBeGreaterThan(T + 20_000);
    expect(first.at - (T + 20_000)).toBeLessThanOrEqual(RECONCILE_MS);
    expect(first.previous && view({ state: first.previous }).state).toBe('implementing'); // the renderer diffs this pair and eases it
    expect(r.updates.every((u) => u.kind !== 'event')).toBe(true);

    // Hidden: no more re-resolves, nothing pending.
    r.doc.set('hidden');
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
    const updates = r.updates.length;
    const requests = r.daemon.requests.length;
    await r.clock.advance(5 * 60_000);
    expect(r.updates).toHaveLength(updates);
    expect(r.daemon.requests).toHaveLength(requests);
    expect(r.clock.pending).toBe(0);
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
  });
});

describe('a whole mission through the lifecycle', () => {
  it('stays in step with the daemon while visible, issues only GETs, and ends idle when hidden', async () => {
    const r = rig(marks.runStarted!);
    r.life.start();
    await flush();
    for (const ev of events) {
      if (ev.seq <= marks.runStarted!) continue;
      r.daemon.advanceTo(ev.seq);
      await r.clock.advance(700);
      r.raf.tick();
      expect(r.clock.pending).toBeLessThanOrEqual(1);
    }
    await r.clock.advance(RECONCILE_MS);
    const last = events.at(-1)!.seq;
    expect(r.life.client.state()!.run.lastSeq).toBe(last);
    expect(r.daemon.maxSnapshotActive).toBe(1);
    expect(r.daemon.requests.every((q) => q.method === 'GET' && ['/snapshot', '/events'].includes(q.path))).toBe(true);
    expect(r.updates.filter((u) => u.kind === 'rebase').length).toBeGreaterThan(3);
    expect(r.frames.length).toBeGreaterThan(10);
    r.doc.set('hidden');
    expect(idle(r.daemon, r.clock, r.raf)).toBe(true);
  });
});
