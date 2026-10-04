// Stubs for the garage stream and lifecycle tests: a fake clock (timers only run when a test advances it), a fake daemon that serves
// /snapshot and /events like the real one (catch-up replay from `since`, then live), a stub document and a stub rAF.
// Everything a test needs to prove "zero timers, rafs, readers or fetches remain" is counted here.
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';
import type { DocLike } from '../packages/garage/src/lifecycle';
import type { FetchLike, ReaderLike, ResponseLike } from '../packages/garage/src/stream';
import { events, snapshotAt } from './garage-mission';

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
};

// ---------- clock ----------

export class FakeClock {
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(public t = 0) {}
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => void this.timers.delete(handle as number);
  get pending(): number {
    return this.timers.size;
  }
  /** Moves time forward, firing due timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

// ---------- document and rAF ----------

export class FakeDoc implements DocLike {
  visibilityState = 'visible';
  listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: 'visibilitychange', fn: () => void): void {
    this.listeners.delete(fn);
  }
  set(state: 'visible' | 'hidden'): void {
    this.visibilityState = state;
    for (const fn of [...this.listeners]) fn();
  }
}

export class FakeRaf {
  private seq = 0;
  private cbs = new Map<number, () => void>();
  raf = (cb: () => void): number => {
    const id = ++this.seq;
    this.cbs.set(id, cb);
    return id;
  };
  caf = (id: number): void => void this.cbs.delete(id);
  get pending(): number {
    return this.cbs.size;
  }
  /** Runs one frame: every pending callback once. */
  tick(): void {
    const run = [...this.cbs];
    this.cbs.clear();
    for (const [, cb] of run) cb();
  }
}

// ---------- daemon ----------

export interface Request {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
}

const enc = new TextEncoder();

export const wire = (ev: CockpitEvent): string => `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

export class FakeStream {
  readerOpen = false;
  closed = false;
  private queue: (string | Error | null)[] = [];
  private waiter: { resolve(v: { done: boolean; value?: Uint8Array }): void; reject(e: unknown): void } | null = null;
  constructor(readonly url: string, readonly since: number, readonly runId: string | null) {}
  private pump(): void {
    if (!this.waiter || !this.queue.length) return;
    const w = this.waiter;
    const item = this.queue.shift()!;
    this.waiter = null;
    if (item === null) w.resolve({ done: true });
    else if (item instanceof Error) w.reject(item);
    else w.resolve({ done: false, value: enc.encode(item) });
  }
  push(text: string): void {
    this.queue.push(text);
    this.pump();
  }
  send(ev: CockpitEvent): void {
    this.push(wire(ev));
  }
  resync(): void {
    this.push('event: resync\ndata: {}\n\n');
  }
  end(): void {
    this.queue.push(null);
    this.pump();
  }
  fail(error = new Error('network down')): void {
    this.queue.push(error);
    this.pump();
  }
  reader(): ReaderLike {
    this.readerOpen = true;
    return {
      read: () => new Promise((resolve, reject) => {
        this.waiter = { resolve, reject };
        this.pump();
      }),
      cancel: async () => {
        this.readerOpen = false;
        this.closed = true;
        const w = this.waiter;
        this.waiter = null;
        w?.resolve({ done: true });
      },
    };
  }
}

export interface DaemonOptions {
  /** The whole history, in seq order. */
  events: readonly CockpitEvent[];
  /** The snapshot the daemon serves right now; it is built when the request arrives, as the real one is. */
  snapshot(head: number, runId: string | null): Snapshot;
}

export class FakeDaemon {
  /** The seq of the last event the daemon has published. */
  head = 0;
  requests: Request[] = [];
  streams: FakeStream[] = [];
  /** Snapshot and event responses waiting for `release`. */
  private held: (() => void)[] = [];
  holdSnapshots = false;
  snapshotStatus = 200;
  eventsStatus = 200;
  snapshotActive = 0;
  maxSnapshotActive = 0;
  snapshotsServed: Snapshot[] = [];

  constructor(private readonly o: DaemonOptions) {}

  get snapshotRequests(): Request[] {
    return this.requests.filter((r) => r.path === '/snapshot');
  }
  get eventRequests(): Request[] {
    return this.requests.filter((r) => r.path === '/events');
  }
  get openReaders(): number {
    return this.streams.filter((s) => s.readerOpen).length;
  }
  get liveStreams(): FakeStream[] {
    return this.streams.filter((s) => !s.closed);
  }

  /** Publishes every event up to `seq`: each open stream gets those of its run. */
  advanceTo(seq: number): void {
    for (const ev of this.o.events) {
      if (ev.seq <= this.head || ev.seq > seq) continue;
      for (const s of this.streams) if (!s.closed && (!s.runId || ev.runId === s.runId)) s.send(ev);
    }
    this.head = Math.max(this.head, seq);
  }

  /** Lets the held snapshot responses through. */
  release(): void {
    const run = this.held.splice(0);
    for (const f of run) f();
  }

  fetch: FetchLike = (url, init) => {
    const u = new URL(url, 'http://daemon');
    this.requests.push({ method: init.method, url, path: u.pathname, headers: init.headers });
    if (u.pathname === '/snapshot') return this.snapshotResponse(u, init.signal);
    if (u.pathname === '/events') return Promise.resolve(this.eventsResponse(u));
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), body: null });
  };

  private snapshotResponse(u: URL, signal: AbortSignal): Promise<ResponseLike> {
    const runId = u.searchParams.get('runId');
    const snap = this.o.snapshot(this.head, runId);
    this.snapshotActive++;
    this.maxSnapshotActive = Math.max(this.maxSnapshotActive, this.snapshotActive);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        this.snapshotActive--;
        return true;
      };
      signal.addEventListener('abort', () => {
        if (settle()) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      const respond = (): void => {
        if (!settle()) return;
        if (this.snapshotStatus !== 200) return resolve({ ok: false, status: this.snapshotStatus, json: async () => ({}), body: null });
        this.snapshotsServed.push(snap);
        resolve({ ok: true, status: 200, json: async () => snap, body: null });
      };
      if (this.holdSnapshots) this.held.push(respond);
      else queueMicrotask(respond);
    });
  }

  private eventsResponse(u: URL): ResponseLike {
    if (this.eventsStatus !== 200) return { ok: false, status: this.eventsStatus, json: async () => ({}), body: null };
    const runId = u.searchParams.get('runId');
    const since = Number(u.searchParams.get('since') ?? 0);
    const s = new FakeStream(u.pathname + u.search, since, runId);
    this.streams.push(s);
    // The catch-up: replay what the snapshot did not cover, then the stream is live (the real daemon does both in one tick).
    for (const ev of this.o.events) if (ev.seq > since && ev.seq <= this.head && (!runId || ev.runId === runId)) s.send(ev);
    return { ok: true, status: 200, json: async () => ({}), body: { getReader: () => s.reader() } };
  }
}

/** True when nothing is left running: no timers, rafs, open readers or snapshot fetches. */
export const idle = (d: FakeDaemon, clock: FakeClock, raf?: FakeRaf): boolean =>
  clock.pending === 0 && d.openReaders === 0 && d.snapshotActive === 0 && d.liveStreams.length === 0 && (raf?.pending ?? 0) === 0;

/** A daemon serving the shared mission: `snapshotAt(head)` and the mission's events, published up to `head`. */
export function missionDaemon(head: number): FakeDaemon {
  const d = new FakeDaemon({ events, snapshot: (h) => snapshotAt(h) });
  d.head = head;
  return d;
}
