// The garage's data client: GET /snapshot and GET /events (SSE over fetch + a stream reader), nothing else. Read-only: it never
// issues anything but GET, and the read token travels only in the `authorization` header (never in a URL).
//
// `createStreamClient` owns the three ways the page learns what happened:
//   sync       snapshot -> fromSnapshot, then /events?since=<snap.lastSeq>&catchup=1; each event with seq > state.lastSeq is applied,
//              the rest are duplicates. Seqs are global and the stream is filtered by run, so a gap is never inferred from seq
//              contiguity; the daemon says `resync` when a catch-up outgrew its cap, and that (or a stream error) means a new sync.
//   reconcile  a fresh snapshot while the stream keeps running: every 5 s, and 1 s after a structural event (the things the
//              events do not fully carry). It REBASES instead of restarting the stream: fold(applyEvent, fromSnapshot(snap),
//              events applied since the last base with seq > snap.lastSeq). A ring that overflowed past snap.lastSeq lost events
//              the snapshot does not hold, so that is a full sync instead.
//   stop       cancels the fetch, the reader and the timer. Nothing may remain pending.
// One timer drives both reconcile and retry, and at most one snapshot fetch is in flight (a full sync supersedes a reconcile).
// `fetch`, timers and `now` are injected; there is no DOM here.
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';
import { applyEvent, fromSnapshot } from './mapper.js';
import type { GarageState, SceneIntent } from './model.js';
import { createSseParser, isResync } from './sse.js';

export const RECONCILE_MS = 5000;
export const DEBOUNCE_MS = 1000;
export const RING_MAX = 2000;
const RETRY_MAX_MS = 10_000;

export const AUTH_MESSAGE = 'Session expired or token missing — reopen with `cockpit garage` or `/cockpit garage`';

/** What changes the snapshot knows and the events only hint at: tasks (repo, persona, lead), team, proposals, review results. */
const STRUCTURAL = new Set(['plan.created', 'task.created', 'team.proposed', 'team.changed', 'run.roles_changed']);
export const isStructural = (type: string): boolean => STRUCTURAL.has(type) || type.startsWith('proposal.') || type.startsWith('review.');

// ---------- the injected seams (structural, so `fetch` and a test stub both fit) ----------

export interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: { getReader(): ReaderLike } | null;
}
export interface RequestLike {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
}
export type FetchLike = (url: string, init: RequestLike) => Promise<ResponseLike>;

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

// ---------- low level: one snapshot, one event stream ----------

export interface Endpoint {
  /** '' for same-origin (the page is served by the daemon). */
  baseUrl: string;
  token: string;
  runId: string;
}

const headers = (token: string, accept: string): Record<string, string> => ({ authorization: `Bearer ${token}`, accept });

export const snapshotUrl = (e: Endpoint): string => `${e.baseUrl}/snapshot?runId=${encodeURIComponent(e.runId)}`;
export const eventsUrl = (e: Endpoint, since: number): string =>
  `${e.baseUrl}/events?runId=${encodeURIComponent(e.runId)}&since=${since}&catchup=1`;

export async function fetchSnapshot(f: FetchLike, e: Endpoint, signal: AbortSignal): Promise<Snapshot> {
  const res = await f(snapshotUrl(e), { method: 'GET', headers: headers(e.token, 'application/json'), signal });
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as Snapshot;
}

export type StreamEnd =
  | { reason: 'closed' }
  | { reason: 'resync' }
  | { reason: 'ended' }
  | { reason: 'unauthorized' }
  | { reason: 'error'; error: unknown };

export interface EventStream {
  /** Settles once, when the stream is over for any reason. */
  done: Promise<StreamEnd>;
  /** Aborts the request and cancels the reader. */
  close(): void;
}

export interface StreamHandlers {
  onEvent(ev: CockpitEvent): void;
  /** Any bytes at all arrived (including keep-alive comments): the connection is healthy. */
  onActivity?(): void;
}

const parseEvent = (data: string): CockpitEvent | null => {
  try {
    const ev = JSON.parse(data) as CockpitEvent;
    return ev && typeof ev.seq === 'number' && typeof ev.type === 'string' ? ev : null;
  } catch {
    return null;
  }
};

/** Opens `/events` for the run from `since` with catch-up and feeds each frame to the handlers. */
export function openEventStream(f: FetchLike, e: Endpoint, since: number, h: StreamHandlers): EventStream {
  const ctl = new AbortController();
  let reader: ReaderLike | null = null;
  let closed = false;

  const run = async (): Promise<StreamEnd> => {
    try {
      const res = await f(eventsUrl(e, since), { method: 'GET', headers: headers(e.token, 'text/event-stream'), signal: ctl.signal });
      if (res.status === 401) return { reason: 'unauthorized' };
      if (!res.ok || !res.body) return { reason: 'error', error: new HttpError(res.status) };
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) return { reason: 'ended' };
        h.onActivity?.();
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (closed) break;
          if (isResync(frame)) return { reason: 'resync' };
          const ev = parseEvent(frame.data);
          if (ev) h.onEvent(ev);
        }
      }
      return { reason: 'closed' };
    } catch (error) {
      return closed ? { reason: 'closed' } : { reason: 'error', error };
    } finally {
      reader?.cancel().catch(() => {});
    }
  };

  return {
    done: run().then((end) => (closed ? { reason: 'closed' } : end)),
    close() {
      closed = true;
      ctl.abort();
      reader?.cancel().catch(() => {});
    },
  };
}

// ---------- rebase ----------

/** The state a snapshot gives, with the events that arrived after it re-applied on top. Pure. */
export function rebase(snap: Snapshot, runId: string, ring: readonly CockpitEvent[], now: number): GarageState {
  let state = fromSnapshot(snap, runId, now);
  for (const ev of ring) if (ev.seq > snap.lastSeq) state = applyEvent(state, ev, now).state;
  return state;
}

// ---------- the client ----------

export type StreamStatus = 'syncing' | 'live' | 'reconnecting' | 'halted' | 'stopped';

/** What the renderer and overlays are told. A `rebase` carries no intents: the renderer diffs `previous` against `state`. */
export interface GarageUpdate {
  kind: 'sync' | 'event' | 'rebase';
  state: GarageState;
  previous: GarageState | null;
  intents: SceneIntent[];
}

export interface StreamClientOptions {
  fetch: FetchLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Epoch milliseconds. */
  now(): number;
  baseUrl?: string;
  token: string;
  runId: string;
  onUpdate(update: GarageUpdate): void;
  /** Each snapshot that became a base (sync or rebase): for what the state does not carry, such as a task's changed files. */
  onSnapshot?(snap: Snapshot): void;
  /** The token is missing or was refused: shows `AUTH_MESSAGE`, after which the client is stopped for good. */
  onAuthError(message: string): void;
  onStatus?(status: StreamStatus): void;
}

export interface StreamClient {
  /** A full sync; safe to call again (it supersedes whatever is running). */
  start(): void;
  /** Cancels the fetch, the stream and the timer. The last state stays readable. */
  stop(): void;
  state(): GarageState | null;
  /** True after a 401: `start` does nothing any more. */
  halted(): boolean;
}

const retryDelay = (failures: number): number => (failures <= 1 ? 0 : Math.min(1000 * 2 ** (failures - 2), RETRY_MAX_MS));

export function createStreamClient(o: StreamClientOptions): StreamClient {
  const ep: Endpoint = { baseUrl: o.baseUrl ?? '', token: o.token, runId: o.runId };
  let state: GarageState | null = null;
  /** Events applied since the last base, oldest first; `dropped` is the highest seq that fell off the front. */
  let ring: CockpitEvent[] = [];
  let dropped = 0;
  let running = false;
  let isHalted = false;
  let gen = 0; // bumped on every start/stop: results of an older generation are ignored
  let snapCtl: AbortController | null = null;
  let stream: EventStream | null = null;
  let timer: unknown = null;
  let timerDue = 0;
  let needFull = false;
  let followUp = false; // a timer fired while a snapshot was in flight: go again after it
  let failures = 0;

  const status = (s: StreamStatus): void => o.onStatus?.(s);
  const emit = (u: GarageUpdate): void => o.onUpdate(u);

  /** The one timer: asking for an earlier moment moves it up, a later one is ignored. */
  const arm = (delay: number): void => {
    const due = o.now() + delay;
    if (timer !== null) {
      if (timerDue <= due) return;
      o.clearTimeout(timer);
    }
    timerDue = due;
    timer = o.setTimeout(fire, delay);
  };
  const disarm = (): void => {
    if (timer !== null) o.clearTimeout(timer);
    timer = null;
  };
  const armNext = (): void => {
    arm(followUp ? DEBOUNCE_MS : RECONCILE_MS);
    followUp = false;
  };

  const teardown = (): void => {
    if (snapCtl) {
      snapCtl.abort();
      snapCtl = null;
    }
    if (stream) {
      const s = stream;
      stream = null;
      s.close();
    }
  };

  const halt = (): void => {
    isHalted = true;
    running = false;
    gen++;
    teardown();
    disarm();
    status('halted');
    o.onAuthError(AUTH_MESSAGE);
  };

  const failed = (error: unknown): void => {
    if (error instanceof HttpError && error.status === 401) return halt();
    failures++;
    needFull = true;
    status('reconnecting');
    const delay = retryDelay(failures);
    if (delay === 0) void fullSync();
    else arm(delay);
  };

  function fire(): void {
    timer = null;
    if (!running) return;
    if (needFull) void fullSync();
    else if (snapCtl) followUp = true;
    else void reconcile();
  }

  const onEvent = (ev: CockpitEvent): void => {
    if (!state || ev.seq <= state.run.lastSeq) return; // duplicates by seq; never infer a gap
    if (ev.runId !== null && ev.runId !== o.runId) return;
    const previous = state;
    const result = applyEvent(state, ev, o.now());
    state = result.state;
    ring.push(ev);
    if (ring.length > RING_MAX) dropped = Math.max(dropped, ring.shift()!.seq);
    emit({ kind: 'event', state, previous, intents: result.intents });
    if (isStructural(ev.type)) arm(DEBOUNCE_MS);
  };

  const open = (since: number): void => {
    const s = openEventStream(o.fetch, ep, since, { onEvent, onActivity: () => (failures = 0) });
    stream = s;
    void s.done.then((end) => {
      if (stream !== s) return; // superseded or stopped
      stream = null;
      if (end.reason === 'closed') return;
      if (end.reason === 'unauthorized') return halt();
      if (end.reason === 'resync') {
        failures = 0;
        return void fullSync();
      }
      failed(end.reason === 'error' ? end.error : new Error('event stream ended'));
    });
  };

  async function fullSync(): Promise<void> {
    if (!running) return;
    teardown();
    const g = ++gen;
    needFull = false;
    const ctl = (snapCtl = new AbortController());
    status('syncing');
    let snap: Snapshot;
    try {
      snap = await fetchSnapshot(o.fetch, ep, ctl.signal);
    } catch (error) {
      if (g !== gen) return;
      snapCtl = null;
      return failed(error);
    }
    if (g !== gen) return;
    snapCtl = null;
    const previous = state;
    state = fromSnapshot(snap, o.runId, o.now());
    ring = [];
    dropped = 0;
    o.onSnapshot?.(snap);
    emit({ kind: 'sync', state, previous, intents: [] });
    open(snap.lastSeq);
    status('live');
    armNext();
  }

  async function reconcile(): Promise<void> {
    if (!running || snapCtl) return;
    const g = gen;
    const ctl = (snapCtl = new AbortController());
    let snap: Snapshot;
    try {
      snap = await fetchSnapshot(o.fetch, ep, ctl.signal);
    } catch (error) {
      if (g !== gen) return;
      snapCtl = null;
      if (error instanceof HttpError && error.status === 401) return halt();
      return armNext(); // keep the state we have and try again on the next period
    }
    if (g !== gen) return;
    snapCtl = null;
    if (!state || dropped > snap.lastSeq) return void fullSync(); // events the snapshot lacks fell off the ring
    const previous = state;
    let next = rebase(snap, o.runId, ring, o.now());
    if (next.run.lastSeq < previous.run.lastSeq) next = { ...next, run: { ...next.run, lastSeq: previous.run.lastSeq } };
    ring = ring.filter((e) => e.seq > snap.lastSeq);
    dropped = 0;
    state = next;
    o.onSnapshot?.(snap);
    emit({ kind: 'rebase', state, previous, intents: [] });
    armNext();
  }

  return {
    start() {
      if (isHalted) return;
      if (!o.token) return halt();
      running = true;
      void fullSync();
    },
    stop() {
      if (!running) return;
      running = false;
      gen++;
      teardown();
      disarm();
      needFull = false;
      followUp = false;
      ring = [];
      dropped = 0;
      status('stopped');
    },
    state: () => state,
    halted: () => isHalted,
  };
}
