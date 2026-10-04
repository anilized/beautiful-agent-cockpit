#!/usr/bin/env node
// Serves Pixel Garage with a scripted mission, no daemon or agents needed: for working on the page and for the
// README's screenshot. Dev-only (it is not part of the plugin). It serves the real page and modules through
// garage.ts, a fake /snapshot and an SSE /events that replay test/garage-mission.ts in a loop: a council of 2,
// 2 leads, 4 workers, a review with CHANGES then APPROVED, a failed then a passing test, an escalation from a
// worker to its lead to the loft, an approval card, completion.
//
//   node scripts/demo-garage.mjs                 → http://127.0.0.1:4778/garage#token=c0ffee
//   PORT=5000 DEMO_SPEED=8 node scripts/demo-garage.mjs
//   open the URL with `&fps` in the fragment (#token=c0ffee&fps) to see frame time
//
// DEMO_SPEED compresses the mission clock (default 4: the ~9 minute mission plays in ~2 minutes). DEMO_PAUSE_MS
// is how long the finished mission rests before the loop restarts (default 8000). DEMO_SKIP_MS starts the first
// loop that far into the mission (default 0), which is how the README screenshot gets a busy room.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const originalEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite')) return;
  return originalEmit.call(process, warning, ...rest);
};
const { register } = await import('tsx/esm/api');
register();
const { garageHtml, garageModule } = await import(pathToFileURL(join(root, 'packages', 'orchestrator', 'src', 'garage.ts')).href);
const mission = await import(pathToFileURL(join(root, 'test', 'garage-mission.ts')).href);

const port = Number(process.env.PORT ?? 4778);
const TOKEN = 'c0ffee';
const SPEED = Number(process.env.DEMO_SPEED ?? 4);
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS ?? 8000);
const SKIP_MS = Number(process.env.DEMO_SKIP_MS ?? 0);
const TICK_MS = 100;
const SEQ_STRIDE = 1000; // each loop's seqs sit above the last one's, so a reconnecting page never sees a seq go backwards
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const { MISSION_RUN_ID, MISSION_START_MS, MISSION_LAST_SEQ, events, snapshotAt } = mission;
const runEvents = events.filter((e) => e.runId === MISSION_RUN_ID);

// ---------- the loop clock ----------

let loop = 0;
let startedAt = Date.now() - SKIP_MS / SPEED; // wall time at mission time zero
let finishedAt = null;
let cursor = 0; // index in `events` of the next event not yet emitted
const streams = new Set(); // { runId, send(e), end() }

const seqOffset = () => loop * SEQ_STRIDE;
/** A mission timestamp (ms) on the wall clock of this loop. */
const wallOf = (missionMs) => startedAt + (missionMs - MISSION_START_MS) / SPEED;
const wallIso = (iso) => new Date(wallOf(Date.parse(iso))).toISOString();

/** Rebases a fixture value: ISO timestamps onto this loop's clock, seqs above the previous loop's. */
function rebase(value, key = '') {
  if (typeof value === 'string') return ISO.test(value) ? wallIso(value) : value;
  if (typeof value === 'number') return (key === 'seq' || key === 'lastSeq') && value > 0 ? value + seqOffset() : value;
  if (Array.isArray(value)) return value.map((v) => rebase(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v, k)]));
  return value;
}
const eventOut = (e) => ({ ...rebase({ ...e, data: undefined }), data: rebase(e.data) });

/** The highest fixture seq emitted so far in this loop (0 before the first event). */
const emittedSeq = () => (cursor === 0 ? 0 : events[cursor - 1].seq);

function startLoop() {
  loop += 1;
  startedAt = Date.now();
  finishedAt = null;
  cursor = 0;
  for (const s of streams) s.end(); // the page syncs again: a fresh snapshot of the empty room
  streams.clear();
}

function tick() {
  const now = Date.now();
  while (cursor < events.length && wallOf(Date.parse(events[cursor].ts)) <= now) {
    const e = events[cursor++];
    const out = eventOut(e);
    out.seq = e.seq + seqOffset();
    for (const s of streams) if (e.runId === s.runId) s.send(out);
  }
  if (cursor >= events.length) {
    finishedAt ??= now;
    if (now - finishedAt >= PAUSE_MS) startLoop();
  }
}
// the first loop may start part-way in: what already happened is history, not a flood of frames
if (SKIP_MS > 0) while (cursor < events.length && wallOf(Date.parse(events[cursor].ts)) <= Date.now()) cursor += 1;
setInterval(tick, TICK_MS);

// ---------- routes ----------

const authorized = (req) => req.headers.authorization === `Bearer ${TOKEN}`;
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function snapshot(runId) {
  const snap = rebase(snapshotAt(emittedSeq()));
  snap.lastSeq = emittedSeq() === 0 ? seqOffset() : emittedSeq() + seqOffset();
  snap.generatedAt = new Date().toISOString();
  if (runId && runId !== MISSION_RUN_ID) snap.runs = [];
  return snap;
}

function serveEvents(req, res, url) {
  const runId = url.searchParams.get('runId') ?? undefined;
  const since = Number(url.searchParams.get('since') ?? 0);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const frame = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  // catch-up and subscribe in one synchronous run, so nothing slips between them (catchup=1 is what this always does)
  for (let i = 0; i < cursor; i += 1) {
    const e = events[i];
    if (runId && e.runId !== runId) continue;
    const out = eventOut(e);
    out.seq = e.seq + seqOffset();
    if (out.seq > since) frame(out);
  }
  const stream = { runId, send: frame, end: () => res.end() };
  streams.add(stream);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(ping);
    streams.delete(stream);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (url.pathname === '/garage' || url.pathname === '/') {
      const page = garageHtml();
      res.writeHead(page.status, page.headers);
      return void res.end(page.body);
    }
    if (url.pathname.startsWith('/garage/')) {
      const file = await garageModule(decodeURIComponent(url.pathname.slice('/garage/'.length)));
      res.writeHead(file.status, file.headers);
      return void res.end(file.body);
    }
    // data routes sit behind the read-only token, as on the daemon
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/snapshot') return json(res, 200, snapshot(url.searchParams.get('runId') ?? undefined));
    if (url.pathname === '/events') return serveEvents(req, res, url);
    res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e instanceof Error ? e.message : e));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`demo garage: http://127.0.0.1:${port}/garage#token=${TOKEN}`);
  console.log(`mission: ${runEvents.length} events (last seq ${MISSION_LAST_SEQ}), speed x${SPEED}, loops with a ${PAUSE_MS / 1000}s rest`);
});
