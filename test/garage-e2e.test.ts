// Pixel Garage end to end, with fake agents driving a real daemon:
//  (1) no effect on work: the same mission run with and without a garage client (which streams /events?catchup=1, polls
//      /snapshot?runId= with the read-only token, and disconnects mid-run) ends in the same state with the same event types in order;
//  (2) equivalence: at completion, and at points where worker sessions are live, fromSnapshot(buildSnapshot()) equals the fold of
//      applyEvent over every event of the run, compared on durable state.
// The mission is long enough that events fall out of the 40-entry recentEvents window and sessions out of the 8-entry minds cap.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCall } from '@cockpit/agents';
import type { CockpitEvent, LeadPlan } from '@cockpit/core';
import { buildSnapshot, runView, startDaemon, type Daemon, type Snapshot } from '@cockpit/orchestrator';
import { applyEvent, fromSnapshot, resolveState } from '../packages/garage/src/mapper';
import type { GarageState } from '../packages/garage/src/model';
import { git, makeRepo, sleep, tempDir, testConfig } from './helpers';

const ARCH = {
  summary: 'Add alpha/beta modules to svc-a and gamma to svc-b',
  architecture: 'Plain modules, each with its own file.',
  constraints: ['no new dependencies'],
  acceptanceCriteria: ['all modules exist', 'check.js passes'],
  risks: [{ risk: 'cross-service drift', mitigation: 'gamma depends on alpha' }],
  repositoriesInScope: ['svc-a', 'svc-b'],
  guidanceForLead: 'Parallelize alpha and beta.',
};

const task = (key: string, title: string, repository: string, file: string, role: string, dependsOn: string[] = []): LeadPlan['tasks'][number] => ({
  key, title, description: `create ${file}`, kind: 'implementation', repository, specialty: 'backend', risk: 'low', complexity: 'low',
  worker: null, role, lead: null, files: [file], modules: [], resources: [], dependsOn, acceptanceCriteria: [`exports ${key}`], testsRequired: true, testCommand: 'node check.js',
});
const PLAN: LeadPlan = {
  notes: 'four tasks',
  tasks: [
    task('TASK-101', 'alpha module', 'svc-a', 'src/alpha.js', 'backend-dev'),
    task('TASK-102', 'beta module', 'svc-a', 'src/beta.js', 'backend-dev'),
    task('TASK-103', 'gamma client', 'svc-b', 'src/gamma.js', 'client-dev', ['TASK-101']),
    task('TASK-104', 'delta client', 'svc-b', 'src/delta.js', 'client-dev', ['TASK-102']),
  ],
  // Personas, as a real plan names them: the garage gives each its own character (a task without one is a one-off `session:<id>`).
  team: [
    { id: 'backend-dev', title: 'Backend developer', specialty: 'backend', worker: 'sonnet', effort: null, rationale: 'owns the modules' },
    { id: 'client-dev', title: 'Client developer', specialty: 'backend', worker: 'sonnet', effort: null, rationale: 'owns the clients' },
  ],
};
const MODULE_OF: Record<string, string> = { 'TASK-101': 'alpha', 'TASK-102': 'beta', 'TASK-103': 'gamma', 'TASK-104': 'delta' };

// ---------- the scripted fake agents ----------

interface Hooks {
  /** Called while a model session is live: a worker that has said something, or a lead or supervisor at its call. */
  checkpoint?: (label: string) => void;
}

/**
 * The fake adapter says nothing while it works, so the worker handler plays the tool use of a real worker through the daemon's event bus
 * (the same `agent.output` events `agent-runner` emits). Every mission does this identically, whoever is watching.
 */
function handler(getDaemon: () => Daemon, hooks: Hooks = {}) {
  const workerCalls = new Map<string, number>();
  return async (call: FakeCall, n: number) => {
    switch (call.contract) {
      case 'ArchitectureOutput':
        return ARCH;
      case 'LeadArchitectureReview':
        return n === 1
          ? { assessment: 'mostly sound', proposals: [{ kind: 'risk', title: 'Add a shared check', rationale: 'evidence', suggestion: 'run check.js per repo' }] }
          : { assessment: 'ok', proposals: [] };
      case 'SupervisorDecisions':
        return { decisions: [{ proposalIndex: 0, outcome: 'accept', rationale: 'good catch', changes: null }], architectureUpdate: null, questionForHuman: null, routingStrategy: null };
      case 'LeadPlan':
        return PLAN;
      case 'WorkerResult': {
        const key = basename(call.cwd);
        const count = (workerCalls.get(key) ?? 0) + 1;
        workerCalls.set(key, count);
        const { store, bus } = getDaemon().engine.ctx;
        const run = store.runs(1)[0]!;
        const session = store.sessions(run.id).find((s) => s.status === 'active' && s.role === 'worker' && s.cwd === call.cwd)!;
        const say = (kind: 'text' | 'thinking' | 'tool', text: string) =>
          bus.emit('agent.output', run.id, { agentId: call.agentId, role: 'worker', sessionId: session.id, taskId: session.taskId, kind, text });
        const name = MODULE_OF[key]!;
        say('thinking', 'planning the change');
        say('tool', `Read: src/.keep`);
        await sleep(40);
        hooks.checkpoint?.(`${key} reading`);
        say('tool', `Edit: src/${name}.js`);
        // TASK-102's first attempt contains a bug the test command catches; TASK-103 asks a question once.
        if (key === 'TASK-103' && count === 1) {
          await sleep(40);
          hooks.checkpoint?.(`${key} asking`);
          return { status: 'needs_input', summary: 'unclear export name', filesChanged: [], testsAdded: [], testsRun: [], questions: ['Should gamma be default export?'], leaseRequests: [], notes: null };
        }
        const body = key === 'TASK-102' && count === 1 ? `module.exports.${name} = 'bug';\n` : `module.exports.${name} = () => '${name}';\n`;
        writeFileSync(join(call.cwd, 'src', `${name}.js`), body);
        await sleep(40);
        hooks.checkpoint?.(`${key} editing`);
        say('tool', 'Bash: node check.js');
        await sleep(40);
        hooks.checkpoint?.(`${key} testing`);
        return { status: 'completed', summary: `implemented ${name}`, filesChanged: [`src/${name}.js`], testsAdded: ['check.js'], testsRun: [{ command: 'node check.js', passed: true }], questions: [], leaseRequests: [], notes: null };
      }
      case 'LeadAnswer':
        hooks.checkpoint?.('lead answering');
        return { answer: 'Use a named export.', escalateToSupervisor: false, escalationQuestion: null };
      case 'LeadReview':
        hooks.checkpoint?.('lead reviewing');
        return { verdict: 'approve', summary: 'clean', issues: [], testsAdequate: true, proposals: [] };
      case 'LeadLeaseDecision':
        return { action: 'wait', rationale: 'owner is nearly done' };
      case 'SupervisorValidation':
        hooks.checkpoint?.('supervisor validating');
        return {
          verdict: 'accept', summary: 'All modules delivered', reportDepth: 'standard', architectureDecisions: ['modules per file'],
          findings: [], requiredChanges: [], remainingRisks: ['none significant'], knownLimitations: [], followUps: ['add docs'], proposalDecisions: [],
        };
      default:
        throw new Error(`unexpected contract ${call.contract}`);
    }
  };
}

// ---------- a mission on a real daemon ----------

interface Mission {
  daemon: Daemon;
  base: string;
  auth: { authorization: string };
  runId: string;
  repos: string[];
  /**
   * The snapshot at the moment the plan's tasks exist (right after `plan.created`): where a fold starts. Events carry no task repo, persona
   * or lead, so a fold that starts before the plan is repaired by the reconcile that follows task.created (see TASK-107, decision 2).
   */
  planned: Snapshot | null;
}

const store = (m: Mission) => m.daemon.engine.ctx.store;

async function startMission(name: string, hooks: (m: () => Mission) => Hooks = () => ({})): Promise<Mission> {
  const root = tempDir(name);
  const repos = [makeRepo(root, 'svc-a'), makeRepo(root, 'svc-b')];
  // One task at a time: the order of the events is then the same on every run, which the comparison of two missions needs.
  const config = testConfig(join(root, 'data'), { maxParallelTasks: 1 });
  let mission!: Mission;
  const daemon = await startDaemon(config, {
    dbPath: ':memory:',
    configureRegistry: (r) => r.register('fake', (p) => new FakeAdapter(p, handler(() => daemon, hooks(() => mission)))),
  });
  let planned: Snapshot | null = null;
  daemon.engine.ctx.bus.subscribe((e) => {
    if (e.type === 'plan.created' && !planned) planned = buildSnapshot(daemon.engine.ctx.store, config, { pid: process.pid, port: daemon.info.port }, undefined, {}, e.runId!);
  });
  const run = await daemon.engine.startRun({ request: 'Add alpha, beta, gamma and delta modules', repos: repos.map((path) => ({ path, testCommand: 'node check.js' })) });
  const base = `http://127.0.0.1:${daemon.info.port}`;
  mission = {
    daemon, base, auth: { authorization: `Bearer ${daemon.info.readToken}` }, runId: run.id, repos,
    get planned() {
      return planned;
    },
  };
  return mission;
}

/** Runs the mission to completion: the human approves the team, then (at the approval card) the result. */
async function finish(m: Mission) {
  const { engine } = m.daemon;
  const gate = await engine.settled(m.runId);
  expect(gate.status).toBe('awaiting_human_decision');
  engine.resolveApproval(store(m).approvals({ status: 'pending', runId: m.runId }).find((a) => a.kind === 'team')!.id, 'approve');
  const waiting = await engine.settled(m.runId);
  expect(waiting.error).toBeNull();
  expect(waiting.status).toBe('awaiting_approval');
  engine.decideRun(m.runId, 'approve', 'ship it');
  const done = await engine.settled(m.runId);
  expect(done.status).toBe('completed');
  return done;
}

/** Everything the mission leaves behind that the work itself decides, with ids and times left out. */
function outcome(m: Mission) {
  const s = store(m);
  const run = s.runById(m.runId)!;
  const tasks = s.tasks(m.runId);
  return {
    run: { status: run.status, round: run.round, error: run.error },
    tasks: tasks.map((t) => ({ key: t.key, status: t.status, iteration: t.iteration, round: t.round, repo: t.repoId === '' ? '' : s.repository(t.repoId)!.name, summary: t.summary })),
    proposals: s.proposals(m.runId).map((p) => ({ kind: p.kind, title: p.title, status: p.status })),
    reviews: tasks.map((t) => [t.key, s.reviews(t.id).map((r) => r.verdict)]),
    decisions: s.decisions(m.runId).length,
    usage: s.usageSummary(m.runId).map((u) => ({ agentId: u.agentId, calls: u.calls, outputTokens: u.outputTokens })), // input tokens are the prompt's length, which carries run ids and paths
    sessions: s.sessions(m.runId).map((x) => ({ agentId: x.agentId, role: x.role, status: x.status })),
    files: m.repos.map((r) => ['alpha', 'beta', 'gamma', 'delta'].flatMap((n) => (existsSync(join(r, 'src', `${n}.js`)) ? [`${n}: ${readFileSync(join(r, 'src', `${n}.js`), 'utf8')}`] : []))),
    mainUntouched: m.repos.map((r) => git(r, 'status', '--porcelain')),
    contracts: FakeAdapter.calls.map((c) => `${c.agentId}:${c.contract}${c.readOnly ? ':ro' : ''}`),
  };
}

const eventTypes = (m: Mission) => store(m).events({ runId: m.runId, limit: 100_000 }).map((e) => e.type);

// ---------- (1) no effect on work ----------

/** A garage client as the page runs one: SSE with catch-up plus polled snapshots, read-only token only; it folds what it reads. */
async function garageClient(m: Mission) {
  const ctl = new AbortController();
  const seen: CockpitEvent[] = [];
  const snapshots: Snapshot[] = [];
  const requests: string[] = [];
  const get = (path: string, init: RequestInit = {}) => {
    requests.push(`GET ${path.split('?')[0]}`);
    return fetch(m.base + path, { ...init, headers: { ...m.auth, ...init.headers }, signal: ctl.signal });
  };
  const stream = (async () => {
    const res = await get(`/events?runId=${m.runId}&since=0&catchup=1`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
        const data = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1];
        buf = buf.slice(i + 2);
        if (data) seen.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const res = await get(`/snapshot?runId=${m.runId}`).catch(() => null);
      if (res?.ok) snapshots.push((await res.json()) as Snapshot);
      await sleep(15);
    }
  })().catch(() => {});
  return {
    seen, snapshots, requests,
    /** Closes the stream, stops the polling, and waits for both loops to be gone. */
    async disconnect() {
      polling = false;
      ctl.abort();
      await Promise.all([stream, poller]);
    },
  };
}

describe('garage client has no effect on the work', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('the same mission with and without a garage client that disconnects mid-run ends in the same state with the same event types in order', async () => {
    // Mission A: watched. The client connects as soon as the run exists and goes away while workers are still running.
    let client!: Awaited<ReturnType<typeof garageClient>>;
    let disconnected: Promise<void> | null = null;
    const a = await startMission('e2e-watched', () => ({
      checkpoint: (label) => {
        if (label === 'TASK-102 reading') disconnected = client.disconnect();
      },
    }));
    client = await garageClient(a);
    await finish(a);
    await disconnected;
    expect(disconnected, 'the client disconnected while the mission was running').not.toBeNull();
    const watched = { outcome: outcome(a), types: eventTypes(a) };
    const totalEvents = store(a).events({ runId: a.runId, limit: 100_000 });
    const lastSeq = totalEvents.at(-1)!.seq;

    // What the client saw: whole events, in order, and only part of the run (it left mid-run); only snapshots of this run, only GETs.
    expect(client.seen.length).toBeGreaterThan(0);
    expect(client.seen.length).toBeLessThan(totalEvents.length);
    expect(client.seen.map((e) => e.seq)).toEqual(totalEvents.slice(0, client.seen.length).map((e) => e.seq));
    expect(client.snapshots.length).toBeGreaterThan(0);
    expect(client.snapshots.every((s) => s.runs.length === 1 && s.runs[0]!.id === a.runId && s.lastSeq <= lastSeq)).toBe(true);
    expect(new Set(client.requests)).toEqual(new Set(['GET /events', 'GET /snapshot']));
    const folded = client.seen.reduce((s, e) => applyEvent(s, e, Date.parse(e.ts)).state, fromSnapshot(a.planned!, a.runId, Date.parse(a.planned!.generatedAt)));
    expect(folded.run.lastSeq).toBe(client.seen.at(-1)!.seq);

    // Mission B: the same run, nobody watching.
    FakeAdapter.calls.length = 0;
    const b = await startMission('e2e-unwatched');
    await finish(b);
    const unwatched = { outcome: outcome(b), types: eventTypes(b) };

    expect(watched.types.length).toBeGreaterThan(100);
    expect(watched.types).toEqual(unwatched.types);
    expect(watched.outcome).toEqual(unwatched.outcome);
    expect(watched.outcome.tasks.map((t) => t.status)).toEqual(['integrated', 'integrated', 'integrated', 'integrated']);
    expect(watched.outcome.files[0]!.some((f) => f.includes('bug'))).toBe(false);
    for (const m of [a, b]) await m.daemon.stop();
  }, 60_000);
});

// ---------- (2) snapshot vs fold ----------

/** The state a reader can rely on: everything but display text (log, narration, approval text). */
function durable(s: GarageState, now: number) {
  const money = (v: { costUsd: number }) => ({ ...v, costUsd: Math.round(v.costUsd * 1e6) / 1e6 });
  return {
    run: { runId: s.run.runId, lastSeq: s.run.lastSeq, phase: s.run.phase, status: s.run.status },
    characters: Object.fromEntries(
      Object.values(s.characters).map((c) => [c.id, {
        kind: c.kind, agentId: c.agentId, seat: c.seat, persona: c.persona, lead: c.lead, home: c.home, station: c.station, task: c.task,
        flags: c.flags, state: c.state, resolved: resolveState(c, s, now),
      }]),
    ),
    liveSessions: Object.fromEntries(
      Object.entries(s.sessions)
        .filter(([, x]) => x.live)
        .map(([id, x]) => [id, { characterId: x.characterId, agentId: x.agentId, task: x.task, contract: x.contract, lastTool: x.lastTool, lastToolAt: x.lastToolAt, lastToolSeq: x.lastToolSeq, lastOutputKind: x.lastOutputKind, lastOutputAt: x.lastOutputAt, lastOutputSeq: x.lastOutputSeq }]),
    ),
    tasks: s.taskIndex,
    bayOf: s.bayOf,
    crateOf: s.crateOf,
    stations: s.stations,
    board: s.board,
    outbox: s.outbox,
    approval: s.approval && { id: s.approval.id, kind: s.approval.kind, summary: s.approval.summary },
    spend: { total: money(s.spend.total), byAgent: Object.fromEntries(Object.entries(s.spend.byAgent).map(([k, v]) => [k, money(v)])) },
    limits: s.limits,
  };
}

/** Every path where two JSON-like values differ, with both values: a readable failure instead of a wall of diff. */
function diffPaths(a: unknown, b: unknown, path = '$'): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return [`${path}: fold=${JSON.stringify(a)} rebuild=${JSON.stringify(b)}`];
}

interface Checkpoint {
  label: string;
  lastSeq: number;
  liveWorkers: number;
  liveSessions: number;
  workerStates: string[];
  eventsInRun: number;
  sessionsInRun: number;
  buildMs: number;
  runViewMs: number;
  diff: unknown | null;
}

describe('fromSnapshot(buildSnapshot()) equals the fold of applyEvent over the events', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('holds mid-run, with live worker sessions, and at completion; the run outgrows recentEvents and minds', async () => {
    const checkpoints: Checkpoint[] = [];
    let follower: GarageState | null = null;

    /** Builds the snapshot the daemon would serve, rebuilds from it, and compares with the fold of every event up to its lastSeq. */
    const compare = (m: Mission, label: string): Checkpoint => {
      const { config } = m.daemon.engine.ctx;
      const t0 = performance.now();
      const snap = buildSnapshot(store(m), config, { pid: process.pid, port: m.daemon.info.port }, undefined, {}, m.runId);
      const buildMs = performance.now() - t0;
      const events = store(m).events({ runId: m.runId, limit: 100_000 });
      const upTo = events.filter((e) => e.seq <= snap.lastSeq);
      const now = Date.parse(upTo.at(-1)!.ts);
      follower ??= fromSnapshot(m.planned!, m.runId, Date.parse(m.planned!.generatedAt));
      for (const e of upTo) follower = applyEvent(follower, e, Date.parse(e.ts)).state;
      const rebuilt = fromSnapshot(snap, m.runId, now);
      const a = durable(follower, now);
      const b = durable(rebuilt, now);
      const run = snap.runs[0]!;
      const t1 = performance.now();
      runView(store(m), config, store(m).runById(m.runId)!);
      const runViewMs = performance.now() - t1;
      const paths = diffPaths(a, b);
      const diff = paths.length ? `fold vs rebuild differ at:\n${paths.join('\n')}` : null;
      const live = Object.values(rebuilt.sessions).filter((x) => x.live);
      return {
        label, lastSeq: snap.lastSeq, liveSessions: live.length,
        liveWorkers: run.activeSessions.filter((s) => s.role === 'worker').length,
        workerStates: run.activeSessions.filter((s) => s.role === 'worker').map((s) => `${s.task}:${rebuilt.characters[rebuilt.sessions[s.sessionId]!.characterId]!.state}@${rebuilt.characters[rebuilt.sessions[s.sessionId]!.characterId]!.station}`),
        eventsInRun: events.length, sessionsInRun: store(m).sessions(m.runId).length, buildMs, runViewMs, diff,
      };
    };

    const m = await startMission('e2e-equiv', (get) => ({ checkpoint: (label) => void checkpoints.push(compare(get(), label)) }));
    await finish(m);
    checkpoints.push(compare(m, 'completed'));

    const midRun = checkpoints.filter((c) => c.label !== 'completed');
    const atWorkers = midRun.filter((c) => /^TASK-/.test(c.label));
    for (const c of checkpoints) if (c.diff) throw new Error(`${c.label} @${c.lastSeq}: ${c.diff}`);
    // Mid-run points had a live worker session, with fine state from its tool records.
    expect(midRun.length).toBeGreaterThanOrEqual(4);
    expect(atWorkers.length).toBeGreaterThanOrEqual(12);
    expect(atWorkers.every((c) => c.liveWorkers >= 1)).toBe(true);
    expect(new Set(atWorkers.flatMap((c) => c.workerStates.map((s) => s.split(':')[1]!.split('@')[0]))).size).toBeGreaterThanOrEqual(3);

    // The run is past what a snapshot can narrate: more events than recentEvents holds, more sessions than minds shows.
    const last = checkpoints.at(-1)!;
    const end = buildSnapshot(store(m), m.daemon.engine.ctx.config, { pid: process.pid, port: m.daemon.info.port }, undefined, {}, m.runId).runs[0]!;
    expect(last.eventsInRun).toBeGreaterThan(40);
    expect(end.recentEvents).toHaveLength(40);
    expect(last.sessionsInRun).toBeGreaterThan(8);
    expect(end.minds).toHaveLength(8);
    expect(midRun.some((c) => c.lastSeq > 40 && c.sessionsInRun > 8)).toBe(true);
    expect(end.status).toBe('completed');

    // At completion everything is on the board and nobody is working.
    const done = fromSnapshot(buildSnapshot(store(m), m.daemon.engine.ctx.config, { pid: process.pid, port: m.daemon.info.port }, undefined, {}, m.runId), m.runId, Date.now());
    expect(done.board.every((c) => c.column === 'done')).toBe(true);
    expect(Object.values(done.sessions).some((x) => x.live)).toBe(false);

    // The same snapshot over HTTP with the read-only token matches what the daemon builds in process.
    const res = await fetch(`${m.base}/snapshot?runId=${m.runId}`, { headers: m.auth });
    const served = (await res.json()) as Snapshot;
    expect(served.lastSeq).toBe(last.lastSeq);
    expect(durable(fromSnapshot(served, m.runId, Date.parse(served.generatedAt)), 0).board).toEqual(durable(done, 0).board);

    // How long the daemon takes to project the run, per snapshot: reported, with a generous sanity bound (the flag line is ~50 ms).
    const stat = (xs: number[]) => {
      const sorted = [...xs].sort((x, y) => x - y);
      return `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms`;
    };
    const report = `on ${last.eventsInRun} events / ${last.sessionsInRun} sessions, ${checkpoints.length} samples: runView ${stat(checkpoints.map((c) => c.runViewMs))}; buildSnapshot(runId) ${stat(checkpoints.map((c) => c.buildMs))}`;
    console.info(`[garage-e2e] ${report}${Math.max(...checkpoints.map((c) => c.runViewMs)) > 50 ? ' -- ABOVE 50 ms' : ''}`);
    expect(Math.max(...checkpoints.map((c) => c.runViewMs)), report).toBeLessThan(1000);
    await m.daemon.stop();
  }, 60_000);
});
