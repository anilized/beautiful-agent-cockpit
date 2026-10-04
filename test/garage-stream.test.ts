// The stream client against a fake daemon and a fake clock: sync, catch-up, duplicates, resync, rebase, reconcile, retry, 401, stop.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';
import { fromSnapshot } from '../packages/garage/src/mapper';
import {
  AUTH_MESSAGE, DEBOUNCE_MS, RECONCILE_MS, RING_MAX, createStreamClient, isStructural, rebase,
  type FetchLike, type GarageUpdate, type StreamStatus,
} from '../packages/garage/src/stream';
import { FakeClock, FakeDaemon, flush, idle, missionDaemon, wire } from './garage-stream-harness';
import { MISSION_LAST_SEQ, MISSION_RUN_ID, events, marks, runEvents, snapshotAt, tsOf } from './garage-mission';

// The real `fetch` must fit the injected seam.
export const realFetchFits: FetchLike = (url, init) => fetch(url, init);

const RUN = MISSION_RUN_ID;
const TOKEN = 'read-token-123';

function rig(head: number, daemon: FakeDaemon = missionDaemon(head), token = TOKEN) {
  const clock = new FakeClock(tsOf(head));
  const updates: (GarageUpdate & { at: number })[] = [];
  const auth: string[] = [];
  const snaps: { snap: Snapshot; at: number }[] = [];
  const statuses: StreamStatus[] = [];
  const client = createStreamClient({
    fetch: daemon.fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, token, runId: RUN,
    onUpdate: (u) => updates.push({ ...u, at: clock.t }),
    onAuthError: (m) => auth.push(m),
    onSnapshot: (snap) => snaps.push({ snap, at: clock.t }),
    onStatus: (s) => statuses.push(s),
  });
  const kinds = () => updates.map((u) => u.kind);
  return { clock, daemon, updates, auth, snaps, statuses, client, kinds };
}

const synthetic = (seq: number, type: 'usage.recorded' = 'usage.recorded'): CockpitEvent => ({
  seq, id: `evt_x${seq}`, runId: RUN, type, ts: new Date(tsOf(MISSION_LAST_SEQ)).toISOString(),
  data: { agentId: 'claude-opus', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
});

const firstOf = (type: string): CockpitEvent => events.find((e) => e.type === type && e.runId === RUN)!;
const stationsOf = (s: { characters: Record<string, { station: string; task: string | null }> }) =>
  Object.fromEntries(Object.entries(s.characters).map(([id, c]) => [id, [c.station, c.task]]));

describe('structural events', () => {
  it('names exactly the events the snapshot knows more about than the stream', () => {
    for (const t of ['plan.created', 'task.created', 'team.proposed', 'team.changed', 'run.roles_changed', 'proposal.created', 'proposal.accepted', 'proposal.rejected', 'proposal.escalated', 'review.started', 'review.passed', 'review.issue_found']) {
      expect(isStructural(t), t).toBe(true);
    }
    for (const t of ['agent.output', 'agent.started', 'task.status_changed', 'test.passed', 'usage.recorded', 'approval.requested', 'run.status_changed']) {
      expect(isStructural(t), t).toBe(false);
    }
  });
});

describe('sync', () => {
  it('fetches the snapshot of the run, then streams /events from its lastSeq with catch-up, with the token only in the header', async () => {
    const head = marks.workersRunning!;
    const r = rig(head);
    r.client.start();
    await flush();
    const [snapReq, evReq] = r.daemon.requests;
    expect(snapReq!.url).toBe(`/snapshot?runId=${RUN}`);
    expect(evReq!.url).toBe(`/events?runId=${RUN}&since=${head}&catchup=1`);
    expect(snapReq!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(evReq!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' });
    expect(r.daemon.requests.every((q) => q.method === 'GET' && !q.url.includes(TOKEN))).toBe(true);
    expect(r.kinds()).toEqual(['sync']);
    expect(r.updates[0]!.state.run.lastSeq).toBe(head);
    expect(r.statuses).toEqual(['syncing', 'live']);
  });

  it('opening mid-mission shows the whole state within one second of fake time', async () => {
    const head = marks.rateTestFailed!;
    const r = rig(head);
    const t0 = r.clock.t;
    r.client.start();
    await r.clock.advance(1000);
    const first = r.updates[0]!;
    expect(first.at - t0).toBeLessThanOrEqual(1000);
    expect(first.kind).toBe('sync');
    expect(first.state).toEqual(fromSnapshot(snapshotAt(head), RUN, first.at));
    expect(Object.keys(first.state.characters).length).toBeGreaterThan(5);
    expect(first.state.board.length).toBeGreaterThan(0);
  });

  it('applies the events that follow the snapshot and ends where a rebuild from the final snapshot ends', async () => {
    const start = marks.workersRunning!;
    const r = rig(start);
    r.client.start();
    await flush();
    // Play the rest of the mission one event at a time; the stream applies each as it arrives.
    for (const ev of events) {
      if (ev.seq <= start) continue;
      r.daemon.advanceTo(ev.seq);
      await flush();
    }
    const state = r.client.state()!;
    expect(state.run.lastSeq).toBe(runEvents.at(-1)!.seq); // the last event of the run (later seqs belong to other runs)
    const eventUpdates = r.updates.filter((u) => u.kind === 'event');
    expect(eventUpdates.length).toBe(events.filter((e) => e.seq > start && e.runId === RUN).length);
    expect(eventUpdates.some((u) => u.intents.length > 0)).toBe(true);
    // A reconcile makes the fold and the rebuild agree.
    await r.clock.advance(RECONCILE_MS);
    expect(r.client.state()!.run.lastSeq).toBe(MISSION_LAST_SEQ); // the snapshot's lastSeq counts other runs' events too
    const rebuilt = fromSnapshot(snapshotAt(MISSION_LAST_SEQ), RUN, r.clock.t);
    expect(stationsOf(r.client.state()!)).toEqual(stationsOf(rebuilt));
    expect(r.client.state()!.board).toEqual(rebuilt.board);
  });

  it('drops duplicates and stale events by seq but never infers a gap from seq contiguity', async () => {
    const head = marks.workersRunning!;
    const r = rig(head);
    r.client.start();
    await flush();
    const s = r.daemon.streams[0]!;
    const next = events.find((e) => e.seq > head && e.runId === RUN)!;
    const later = events.find((e) => e.seq > next.seq + 3 && e.runId === RUN)!; // seqs in between belong to other runs or are skipped
    const before = r.updates.length;
    s.send(events.find((e) => e.seq <= head && e.runId === RUN)!); // at or below the snapshot: a duplicate
    s.send(next);
    s.send(next); // the same seq again
    s.send(later); // a jump
    s.send(next); // older than `later` now
    await flush();
    expect(r.updates.slice(before).map((u) => u.state.run.lastSeq)).toEqual([next.seq, later.seq]);
    expect(r.daemon.snapshotRequests).toHaveLength(1); // no resync, no reconcile on a gap
    expect(r.daemon.eventRequests).toHaveLength(1);
  });

  it('ignores events of another run, keep-alives and frames that are not events, and reads frames split across chunks', async () => {
    const head = marks.workersRunning!;
    const r = rig(head);
    r.client.start();
    await flush();
    const s = r.daemon.streams[0]!;
    const next = events.find((e) => e.seq > head && e.runId === RUN)!;
    const text = wire(next);
    const before = r.updates.length;
    s.push(': keep-alive\n\n');
    s.push('event: x\ndata: not json\n\n');
    s.push('event: x\ndata: {"hello":1}\n\n');
    s.push(wire({ ...next, seq: next.seq + 1, runId: 'run_other' }));
    s.push(text.slice(0, 20));
    await flush();
    expect(r.updates).toHaveLength(before);
    s.push(text.slice(20));
    await flush();
    expect(r.updates.slice(before).map((u) => u.state.run.lastSeq)).toEqual([next.seq]);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
  });

  it('reports catch-up events the daemon replays after the snapshot', async () => {
    // The snapshot was taken at `a`; the daemon published more before the stream opened: they arrive as the catch-up.
    const a = marks.workersRunning!;
    const b = marks.docsFailed!;
    const daemon = new FakeDaemon({ events, snapshot: () => snapshotAt(a) });
    daemon.head = b;
    const r = rig(a, daemon);
    r.client.start();
    await flush();
    expect(r.updates[0]!.state.run.lastSeq).toBe(a);
    expect(r.client.state()!.run.lastSeq).toBe(b);
    expect(r.daemon.eventRequests[0]!.url).toContain(`since=${a}`);
  });
});

describe('resync and errors', () => {
  it('a resync frame runs a full sync: a new snapshot and a new stream from its lastSeq, the old reader cancelled', async () => {
    const head = marks.workersRunning!;
    const r = rig(head);
    r.client.start();
    await flush();
    const old = r.daemon.streams[0]!;
    r.daemon.head = marks.rateCompleted!;
    old.resync();
    await flush();
    expect(old.readerOpen).toBe(false);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.daemon.eventRequests[1]!.url).toBe(`/events?runId=${RUN}&since=${marks.rateCompleted}&catchup=1`);
    expect(r.kinds().filter((k) => k === 'sync')).toHaveLength(2);
    expect(r.client.state()!.run.lastSeq).toBe(marks.rateCompleted);
    expect(r.daemon.openReaders).toBe(1);
  });

  it('a stream error or a clean end runs a full sync', async () => {
    for (const how of ['fail', 'end'] as const) {
      const r = rig(marks.workersRunning!);
      r.client.start();
      await flush();
      r.daemon.streams[0]![how]();
      await flush();
      expect(r.daemon.snapshotRequests, how).toHaveLength(2);
      expect(r.daemon.eventRequests, how).toHaveLength(2);
      expect(r.daemon.openReaders, how).toBe(1);
      expect(r.statuses, how).toContain('reconnecting');
      r.client.stop();
    }
  });

  it('retries a failing snapshot at once, then with growing delays, and recovers', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.snapshotStatus = 500;
    r.client.start();
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(2); // the first try and one immediate retry
    await r.clock.advance(999);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    await r.clock.advance(1999);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(4);
    expect(r.clock.pending).toBe(1);
    expect(r.updates).toHaveLength(0);
    expect(r.auth).toEqual([]); // a 500 is not an auth failure
    r.daemon.snapshotStatus = 200;
    await r.clock.advance(4000);
    expect(r.kinds()).toEqual(['sync']);
    expect(r.daemon.maxSnapshotActive).toBe(1);
    expect(r.statuses.at(-1)).toBe('live');
  });
});

describe('rebase', () => {
  it('re-applies the events that arrived while the snapshot was being fetched', async () => {
    const a = marks.workersRunning!;
    const b = marks.rateTestFailed!;
    const r = rig(a);
    r.client.start();
    await flush();
    await r.clock.advance(RECONCILE_MS - 1);
    r.daemon.holdSnapshots = true;
    await r.clock.advance(1); // the reconcile starts, with a snapshot built at `a`
    expect(r.daemon.snapshotActive).toBe(1);
    r.daemon.advanceTo(b); // events keep streaming while it is out
    await flush();
    const live = r.client.state()!;
    expect(live.run.lastSeq).toBe(b);
    expect(r.daemon.snapshotsServed.at(-1)!.lastSeq).toBe(a);
    const before = r.updates.length;
    r.daemon.release();
    await flush();
    const u = r.updates.slice(before).find((x) => x.kind === 'rebase')!;
    expect(u).toBeDefined();
    expect(u.previous).toBe(live);
    expect(u.intents).toEqual([]);
    expect(u.state.run.lastSeq).toBe(b); // the stale snapshot did not move the clock back
    expect(stationsOf(u.state)).toEqual(stationsOf(live));
    expect(u.state.taskIndex.tasks).toEqual(live.taskIndex.tasks);
    expect(u.state.board).toEqual(live.board);
    // ... and it is the same as folding those events onto the snapshot.
    const ring = events.filter((e) => e.seq > a && e.seq <= b);
    expect(rebase(snapshotAt(a), RUN, ring, r.clock.t).run.lastSeq).toBe(b);
  });

  it('takes lastSeq from the snapshot when it is ahead of the stream, and drops the stream events it already covers', async () => {
    const a = marks.workersRunning!;
    const b = marks.rateCompleted!;
    const r = rig(a);
    r.client.start();
    await flush();
    r.daemon.head = b; // the daemon moved on, the stream has not delivered anything yet
    await r.clock.advance(RECONCILE_MS);
    expect(r.updates.at(-1)!.kind).toBe('rebase');
    expect(r.client.state()!.run.lastSeq).toBe(b);
    const before = r.updates.length;
    r.daemon.streams[0]!.send(events.find((e) => e.seq > a && e.seq <= b && e.runId === RUN)!); // already inside the snapshot
    await flush();
    expect(r.updates).toHaveLength(before);
  });

  it('keeps the events of a bounded ring: RING_MAX arrive during the fetch -> rebase, one more -> full sync', async () => {
    for (const extra of [0, 1]) {
      const a = marks.runStarted!;
      const r = rig(a);
      r.client.start();
      await flush();
      await r.clock.advance(RECONCILE_MS - 1);
      r.daemon.holdSnapshots = true;
      await r.clock.advance(1);
      const stream = r.daemon.streams[0]!;
      for (let i = 1; i <= RING_MAX + extra; i++) stream.send(synthetic(MISSION_LAST_SEQ + i));
      await flush();
      expect(r.client.state()!.run.lastSeq).toBe(MISSION_LAST_SEQ + RING_MAX + extra);
      r.daemon.holdSnapshots = false;
      r.daemon.release();
      await flush();
      if (extra === 0) {
        expect(r.kinds().at(-1), 'ring held everything').toBe('rebase');
        expect(r.daemon.snapshotRequests).toHaveLength(2);
        expect(r.client.state()!.run.lastSeq).toBe(MISSION_LAST_SEQ + RING_MAX);
      } else {
        expect(r.kinds().at(-1), 'ring overflowed').toBe('sync');
        expect(r.daemon.snapshotRequests).toHaveLength(3);
        expect(r.daemon.eventRequests).toHaveLength(2);
        expect(r.daemon.openReaders).toBe(1);
        expect(r.client.state()!.run.lastSeq).toBe(a); // rebuilt from the new snapshot
      }
      r.client.stop();
    }
  });

  it('forgets the events a snapshot covers: thousands of events over several reconciles never overflow the ring', async () => {
    const cut = marks.runStarted!;
    const daemon = new FakeDaemon({ events, snapshot: (h) => ({ ...snapshotAt(cut), lastSeq: h }) });
    daemon.head = MISSION_LAST_SEQ;
    const r = rig(cut, daemon);
    r.client.start();
    await flush();
    for (let round = 0; round < 3; round++) {
      const base = MISSION_LAST_SEQ + round * 1500;
      for (let i = 1; i <= 1500; i++) daemon.streams[0]!.send(synthetic(base + i));
      await flush();
      daemon.head = base + 1500; // the snapshot now covers them all
      await r.clock.advance(RECONCILE_MS);
    }
    expect(r.kinds().filter((k) => k === 'sync')).toHaveLength(1);
    expect(r.kinds().filter((k) => k === 'rebase')).toHaveLength(3);
    expect(daemon.snapshotRequests).toHaveLength(4);
    expect(daemon.eventRequests).toHaveLength(1);
  });
});

describe('reconcile', () => {
  it('fetches a snapshot every 5 s, on one timer, and never two at once', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.clock.pending).toBe(1);
    await r.clock.advance(RECONCILE_MS - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    for (let i = 3; i <= 6; i++) {
      await r.clock.advance(RECONCILE_MS);
      expect(r.daemon.snapshotRequests).toHaveLength(i);
      expect(r.clock.pending).toBe(1);
    }
    expect(r.kinds()).toEqual(['sync', 'rebase', 'rebase', 'rebase', 'rebase', 'rebase']);
    expect(r.daemon.eventRequests).toHaveLength(1); // a reconcile never restarts the stream
    expect(r.daemon.maxSnapshotActive).toBe(1);
  });

  it('does not start another fetch while one is slow, however long it takes', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    await r.clock.advance(RECONCILE_MS - 1);
    r.daemon.holdSnapshots = true;
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    await r.clock.advance(60_000);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.daemon.maxSnapshotActive).toBe(1);
    r.daemon.holdSnapshots = false;
    r.daemon.release();
    await flush();
    expect(r.kinds().at(-1)).toBe('rebase');
    await r.clock.advance(RECONCILE_MS);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    expect(r.daemon.maxSnapshotActive).toBe(1);
  });

  it('refreshes 1 s after a structural event, and not after others', async () => {
    const a = marks.workersRunning!;
    const structural = events.find((e) => e.seq > a && e.runId === RUN && isStructural(e.type))!;
    const plain = events.find((e) => e.seq > a && e.runId === RUN && !isStructural(e.type))!;
    expect(plain.seq).toBeLessThan(structural.seq);
    const r = rig(a);
    r.client.start();
    await flush();
    r.daemon.advanceTo(plain.seq);
    await r.clock.advance(DEBOUNCE_MS + 10);
    expect(r.daemon.snapshotRequests).toHaveLength(1); // plain events wait for the 5 s period
    r.daemon.advanceTo(structural.seq);
    await flush();
    await r.clock.advance(DEBOUNCE_MS - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.clock.pending).toBe(1); // the period timer, 5 s on
    await r.clock.advance(RECONCILE_MS);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
  });

  it('coalesces a burst of structural events into one refresh, 1 s after the last of them, on a single timer', async () => {
    const a = marks.runStarted!;
    const burst = events.filter((e) => e.seq > a && e.runId === RUN && isStructural(e.type)).slice(0, 5);
    expect(burst.length).toBe(5);
    const r = rig(a);
    r.client.start();
    await flush();
    for (const e of burst) {
      r.daemon.advanceTo(e.seq);
      await r.clock.advance(100);
      expect(r.clock.pending).toBe(1);
    }
    // The last event was 100 ms ago: the refresh is 900 ms away.
    await r.clock.advance(DEBOUNCE_MS - 100 - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    await r.clock.advance(RECONCILE_MS - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
  });

  it('is a debounce: a second structural event 900 ms after the first moves the refresh to 1900 ms, not 1000 ms', async () => {
    const a = marks.runStarted!;
    const [first, second] = events.filter((e) => e.seq > a && e.runId === RUN && isStructural(e.type));
    const r = rig(a);
    r.client.start();
    await flush();
    r.daemon.advanceTo(first!.seq); // t = 0
    await r.clock.advance(900);
    r.daemon.advanceTo(second!.seq); // t = 900
    await flush();
    await r.clock.advance(100); // t = 1000: where the first event's deadline was
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    await r.clock.advance(899); // t = 1899
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.clock.pending).toBe(1);
    await r.clock.advance(1); // t = 1900
    expect(r.daemon.snapshotRequests).toHaveLength(2);
  });

  it('cannot be postponed past the periodic reconcile by a continuous run of structural events', async () => {
    const a = marks.runStarted!;
    const plan = firstOf('plan.created');
    const r = rig(a);
    r.client.start();
    await flush();
    let seq = MISSION_LAST_SEQ;
    const stream = r.daemon.streams[0]!;
    // A structural event every 500 ms for 10 s: the 1 s debounce never matures, the 5 s period still does.
    const reconciles: number[] = [];
    for (let t = 0; t < 10_000; t += 500) {
      stream.send({ ...plan, seq: ++seq, id: `evt_p${seq}` });
      await r.clock.advance(500);
      reconciles.push(r.daemon.snapshotRequests.length - 1);
      expect(r.clock.pending).toBe(1);
    }
    expect(reconciles.slice(0, 9)).toEqual(Array(9).fill(0)); // nothing before t = 5000 ...
    expect(reconciles[9]).toBe(1); // ... the periodic one at 5000 ...
    expect(reconciles.slice(10, 19)).toEqual(Array(9).fill(1));
    expect(reconciles[19]).toBe(2); // ... and the next at 10000
    // That fetch covered the events so far, so no debounce is left over; one more event and then silence matures it.
    await r.clock.advance(DEBOUNCE_MS);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    stream.send({ ...plan, seq: ++seq, id: `evt_p${seq}` });
    await r.clock.advance(DEBOUNCE_MS - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(4);
    expect(r.daemon.maxSnapshotActive).toBe(1);
  });

  it('goes again 1 s after a fetch that a structural event overlapped, without a second fetch meanwhile', async () => {
    const a = marks.workersRunning!;
    const structural = events.find((e) => e.seq > a && e.runId === RUN && isStructural(e.type))!;
    const r = rig(a);
    r.client.start();
    await flush();
    await r.clock.advance(RECONCILE_MS - 1);
    r.daemon.holdSnapshots = true;
    await r.clock.advance(1);
    r.daemon.advanceTo(structural.seq);
    await r.clock.advance(DEBOUNCE_MS * 3); // the debounce timer fires while the fetch is out
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.daemon.maxSnapshotActive).toBe(1);
    r.daemon.holdSnapshots = false;
    r.daemon.release();
    await flush();
    await r.clock.advance(DEBOUNCE_MS - 1);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    await r.clock.advance(1);
    expect(r.daemon.snapshotRequests).toHaveLength(3);
    expect(r.daemon.maxSnapshotActive).toBe(1);
  });

  it('survives a failed reconcile: keeps its state and tries again on the next period', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    const state = r.client.state();
    r.daemon.snapshotStatus = 503;
    await r.clock.advance(RECONCILE_MS);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.client.state()).toBe(state);
    expect(r.kinds()).toEqual(['sync']);
    r.daemon.snapshotStatus = 200;
    await r.clock.advance(RECONCILE_MS);
    expect(r.kinds()).toEqual(['sync', 'rebase']);
    expect(r.daemon.eventRequests).toHaveLength(1);
  });

  // The daemon reads a worktree every 3 s (LiveWorkspaces) and the snapshot serves the cache: a changed file must reach the page
  // within that period plus the 5 s reconcile.
  it.each([0, 1, 2999, 3001, 4500, 7000])('shows a file changed in a worktree at +%i ms within the 3 s worktree period + 5 s', async (editAt) => {
    const LIVE_PERIOD = 3000;
    const head = marks.workersRunning!;
    const clock = new FakeClock(tsOf(head));
    const t0 = clock.t;
    const file = 'api/src/middleware/limit.ts';
    const daemon = new FakeDaemon({
      events,
      snapshot: (h) => {
        const snap = structuredClone(snapshotAt(h));
        const cachedAt = Math.floor((clock.t - t0) / LIVE_PERIOD) * LIVE_PERIOD; // the last time the daemon read the worktree
        if (cachedAt >= editAt) snap.runs[0]!.tasks[0]!.live = { files: [{ status: 'M', path: file }], preview: null };
        return snap;
      },
    });
    daemon.head = head;
    const seen: number[] = [];
    const client = createStreamClient({
      fetch: daemon.fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, token: TOKEN, runId: RUN,
      onUpdate: () => {},
      onAuthError: () => {},
      onSnapshot: (snap) => {
        if (snap.runs[0]!.tasks[0]!.live?.files.some((f) => f.path === file)) seen.push(clock.t - t0);
      },
    });
    client.start();
    for (let t = 0; t < editAt + LIVE_PERIOD + RECONCILE_MS + 1; t += 100) await clock.advance(100);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]! - editAt).toBeLessThanOrEqual(LIVE_PERIOD + RECONCILE_MS);
    client.stop();
  });
});

describe('401', () => {
  it('on the snapshot shows the reopen instruction once and stops everything', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.snapshotStatus = 401;
    r.client.start();
    await r.clock.advance(120_000);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(AUTH_MESSAGE).toMatch(/cockpit garage/);
    expect(r.daemon.requests).toHaveLength(1);
    expect(r.client.halted()).toBe(true);
    expect(r.statuses.at(-1)).toBe('halted');
    expect(idle(r.daemon, r.clock)).toBe(true);
    r.client.start(); // a halted client stays halted
    await r.clock.advance(60_000);
    expect(r.daemon.requests).toHaveLength(1);
  });

  it('on the event stream stops the reconcile as well', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.eventsStatus = 401;
    r.client.start();
    await r.clock.advance(120_000);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(r.daemon.snapshotRequests).toHaveLength(1);
    expect(r.daemon.eventRequests).toHaveLength(1);
    expect(idle(r.daemon, r.clock)).toBe(true);
  });

  it('on a later reconcile (the token expired mid-session) closes the stream and stops', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    expect(r.daemon.openReaders).toBe(1);
    r.daemon.snapshotStatus = 401;
    await r.clock.advance(RECONCILE_MS);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(idle(r.daemon, r.clock)).toBe(true);
    await r.clock.advance(120_000);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
  });

  it('with no token at all says so without asking the daemon', async () => {
    const r = rig(marks.workersRunning!, undefined, '');
    r.client.start();
    await r.clock.advance(60_000);
    expect(r.auth).toEqual([AUTH_MESSAGE]);
    expect(r.daemon.requests).toHaveLength(0);
    expect(r.clock.pending).toBe(0);
  });
});

describe('stop', () => {
  it('leaves zero timers, readers and fetches, and issues nothing afterwards', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    r.client.stop();
    expect(idle(r.daemon, r.clock)).toBe(true);
    const requests = r.daemon.requests.length;
    await r.clock.advance(120_000);
    expect(r.daemon.requests).toHaveLength(requests);
  });

  it('mid-fetch aborts it, and a late answer changes nothing', async () => {
    const r = rig(marks.workersRunning!);
    r.daemon.holdSnapshots = true;
    r.client.start();
    await flush();
    expect(r.daemon.snapshotActive).toBe(1);
    r.client.stop();
    expect(r.daemon.snapshotActive).toBe(0);
    r.daemon.release();
    await flush();
    expect(r.updates).toHaveLength(0);
    expect(r.daemon.eventRequests).toHaveLength(0);
    expect(idle(r.daemon, r.clock)).toBe(true);
  });

  it('during a reconcile or with a debounce armed leaves nothing behind', async () => {
    const a = marks.workersRunning!;
    const structural = events.find((e) => e.seq > a && e.runId === RUN && isStructural(e.type))!;
    const r = rig(a);
    r.client.start();
    await flush();
    r.daemon.advanceTo(structural.seq);
    await flush();
    expect(r.clock.pending).toBe(1);
    r.daemon.holdSnapshots = true;
    await r.clock.advance(DEBOUNCE_MS);
    expect(r.daemon.snapshotActive).toBe(1);
    r.client.stop();
    expect(idle(r.daemon, r.clock)).toBe(true);
    r.daemon.release();
    await r.clock.advance(60_000);
    expect(r.daemon.snapshotRequests).toHaveLength(2);
  });

  it('start after stop is a fresh full sync', async () => {
    const r = rig(marks.workersRunning!);
    r.client.start();
    await flush();
    r.client.stop();
    r.client.start();
    await flush();
    expect(r.daemon.snapshotRequests).toHaveLength(2);
    expect(r.daemon.eventRequests).toHaveLength(2);
    expect(r.daemon.openReaders).toBe(1);
    expect(r.kinds().filter((k) => k === 'sync')).toHaveLength(2);
  });
});

describe('read-only', () => {
  it('issues only GET /snapshot and GET /events across a whole mission, with the bearer header and no token in any URL', async () => {
    const r = rig(marks.runStarted!);
    r.client.start();
    await flush();
    for (const ev of events) {
      if (ev.seq <= marks.runStarted!) continue;
      r.daemon.advanceTo(ev.seq);
      await r.clock.advance(400);
    }
    r.daemon.streams[0]!.resync();
    await r.clock.advance(RECONCILE_MS * 2);
    expect(r.daemon.requests.length).toBeGreaterThan(5);
    for (const q of r.daemon.requests) {
      expect(q.method).toBe('GET');
      expect(['/snapshot', '/events']).toContain(q.path);
      expect(q.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(q.url).not.toContain(TOKEN);
    }
  });

  it('is written against the seam only: no DOM globals, no node imports, relative .js imports and type-only package imports', () => {
    for (const f of ['stream.ts', 'lifecycle.ts']) {
      const src = readFileSync(new URL(`../packages/garage/src/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from 'node:|\bwindow\b|\bdocument\.|\blocation\b|Date\.now|new Date\(|Math\.random|\binnerHTML\b|XMLHttpRequest|WebSocket|\bPOST\b|\bPUT\b|\bDELETE\b/);
      for (const m of src.matchAll(/^import (type )?[^;]*? from '([^']+)'/gms)) {
        if (m[2]!.startsWith('@cockpit/')) expect(m[1], `${f}: ${m[2]}`).toBe('type ');
        else expect(m[2], f).toMatch(/^\.\/[a-z]+\.js$/);
      }
    }
  });
});
