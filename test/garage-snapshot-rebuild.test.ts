// A state rebuilt from a snapshot equals the state folded from events: the mission fixture's `snapshotAt(seq)` is the
// Snapshot the daemon would serve right after that event, `fromSnapshot` rebuilds from it, `applyEvent` folds on top of it.
import { describe, expect, it } from 'vitest';
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';
import { applyEvent, fromSnapshot, resolveState } from '../packages/garage/src/mapper';
import type { GarageState } from '../packages/garage/src/model';
import { MISSION_LAST_SEQ, MISSION_RUN_ID, events, marks, snapshotAt, tsOf } from './garage-mission';

const RUN = MISSION_RUN_ID;
const seqs = events.map((e) => e.seq);

/** The state a reader can rely on after a rebuild: everything but display text (log, narration, approval text). */
function durable(s: GarageState, now: number) {
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
    spend: {
      total: { ...s.spend.total, costUsd: Math.round(s.spend.total.costUsd * 1e6) / 1e6 },
      byAgent: Object.fromEntries(Object.entries(s.spend.byAgent).map(([k, v]) => [k, { ...v, costUsd: Math.round(v.costUsd * 1e6) / 1e6 }])),
    },
    limits: s.limits,
  };
}

const rebuilt = new Map<number, GarageState>();
const rebuild = (seq: number): GarageState => {
  let s = rebuilt.get(seq);
  if (!s) rebuilt.set(seq, (s = fromSnapshot(snapshotAt(seq), RUN, tsOf(seq))));
  return s;
};
const eventSeqsAfter = (seq: number) => events.filter((e) => e.seq > seq);

/** Folds the stream on top of the rebuild at `from`, comparing with the rebuild at every event. */
function foldAndCompare(from: number, upTo = MISSION_LAST_SEQ, mapEvent: (e: CockpitEvent) => CockpitEvent = (e) => e) {
  let state = fromSnapshot(snapshotAt(from), RUN, tsOf(from));
  for (const e of eventSeqsAfter(from)) {
    if (e.seq > upTo) break;
    state = applyEvent(state, mapEvent(e), tsOf(e.seq)).state;
    expect(durable(state, tsOf(e.seq)), `after seq ${e.seq} (${e.type}), folding from ${from}`).toEqual(durable(rebuild(e.seq), tsOf(e.seq)));
  }
  return state;
}

describe('fromSnapshot equals the event fold', () => {
  // From these cuts to the end, at every single event. Before `tasksCreated` the events cannot carry a task's persona, lead,
  // test command or repo, so a stream that joins that early is repaired by the reconcile that follows task.created.
  const starts = [marks.tasksCreated!, marks.teamApproved!, marks.workersRunning!, marks.rateTestFailed!, marks.workerAsks!, marks.reviewChanges!, marks.leaseConflict!, marks.approvalPending!];
  it.each(starts)('folding from the snapshot at seq %i, every step matches the rebuilt state', (from) => {
    foldAndCompare(from);
  });

  it('ends in the same state as the rebuild of the final snapshot', () => {
    const end = foldAndCompare(marks.tasksCreated!);
    expect(durable(end, tsOf(MISSION_LAST_SEQ))).toEqual(durable(rebuild(MISSION_LAST_SEQ), tsOf(MISSION_LAST_SEQ)));
    expect(end.run.status).toBe('completed');
    expect(end.board.every((c) => c.column === 'done')).toBe(true);
  });

  it('does not need recentEvents or minds: stripping them changes only the log and the narration', () => {
    for (const seq of [marks.workersRunning!, marks.workerAsks!, marks.reviewChanges!, marks.approvalPending!, MISSION_LAST_SEQ]) {
      const snap: Snapshot = structuredClone(snapshotAt(seq));
      for (const r of snap.runs) {
        r.recentEvents = [];
        r.minds = [];
      }
      expect(durable(fromSnapshot(snap, RUN, tsOf(seq)), tsOf(seq))).toEqual(durable(rebuild(seq), tsOf(seq)));
    }
  });

  it('takes the log and the narration from recentEvents and minds, for display only', () => {
    const seq = marks.workersRunning! + 8;
    const s = rebuild(seq);
    expect(s.log.length).toBeGreaterThan(0);
    expect(s.log.every((e) => e.seq === null && typeof e.text === 'string')).toBe(true);
    const narrated = Object.values(s.sessions).filter((x) => x.live && x.lastNarration !== null);
    expect(narrated.length).toBeGreaterThan(0);
  });

  it('reads the fine state of every live session from activeSessions, with the same classification as the fold', () => {
    const s = rebuild(marks.workersRunning! + 6); // meter1 has read a file, rate1 has run a shell command
    const meter = Object.values(s.sessions).find((x) => x.live && x.characterId === 'frontend-dev')!;
    expect(meter.lastTool).toMatch(/^(Read|Grep): /);
    expect(s.characters['frontend-dev']!.state).toBe('researching');
    expect(s.characters['frontend-dev']!.station).toBe('crate:web');
    expect(s.characters['backend-dev']!.state).toBe('implementing');
    expect(s.characters['backend-dev']!.station).toBe('terminal');
  });

  it('is unaffected by more than eight sessions, where minds is capped but activeSessions is not', () => {
    const baseSeq = marks.workersRunning!;
    const snap: Snapshot = structuredClone(snapshotAt(baseSeq));
    const run = snap.runs[0]!;
    const extra: CockpitEvent[] = [];
    let seq = snap.lastSeq + 1000;
    const stamp = (n: number) => new Date(tsOf(baseSeq) + n * 1000).toISOString();
    const open = (i: number) => {
      const sessionId = `ses_extra${i}`;
      const task = i % 2 === 0 ? 'TASK-1' : null;
      const taskId = task ? 'task_rate' : null;
      // One agent per session: a seatless session of the same agent and task is taken for the retry of the one before it.
      const agentId = `agent-${i}`;
      const role = i % 2 === 0 ? 'worker' : 'supervisor';
      const toolLine = i % 4 === 0 ? 'Edit: api/src/middleware/extra.ts' : i % 4 === 1 ? 'Read: api/src/server.ts' : null;
      extra.push({ seq: ++seq, id: `x${seq}`, runId: RUN, type: 'agent.started', ts: stamp(i * 2), data: { agentId, role, sessionId, taskId, contract: 'X', effort: null, seat: null } } as CockpitEvent);
      const out = toolLine ? { text: toolLine, kind: 'tool' as const } : { text: 'hmm', kind: 'thinking' as const };
      extra.push({ seq: ++seq, id: `x${seq}`, runId: RUN, type: 'agent.output', ts: stamp(i * 2 + 1), data: { agentId, taskId, text: out.text, kind: out.kind, role, sessionId } } as CockpitEvent);
      run.activeSessions.push({
        sessionId, agentId, role, seat: null, contract: 'X', effort: null, task, startedAt: stamp(i * 2),
        lastTool: out.kind === 'tool' ? { text: out.text, at: stamp(i * 2 + 1), seq } : null, lastOutput: { kind: out.kind, at: stamp(i * 2 + 1), seq },
      });
    };
    for (let i = 0; i < 12; i++) open(i);
    const lastSeq = seq;
    const now = tsOf(baseSeq) + 30_000;
    snap.lastSeq = lastSeq;

    expect(run.activeSessions.length).toBeGreaterThan(8);
    expect(run.minds.length).toBeLessThanOrEqual(8);
    const fromSnap = fromSnapshot(snap, RUN, now);
    let folded = fromSnapshot(snapshotAt(baseSeq), RUN, now);
    for (const e of extra) folded = applyEvent(folded, e, now).state;
    expect(Object.values(fromSnap.sessions).filter((x) => x.live).length).toBe(run.activeSessions.length);
    expect(durable(folded, now)).toEqual(durable(fromSnap, now));
    // Sessions that name no seat become their own characters, and the ones with a task work in the task's persona's bay.
    expect(Object.keys(fromSnap.characters).filter((id) => id.startsWith('session:')).length).toBeGreaterThan(0);
  });

  it('agrees on state and station between the snapshot and the fold when narration follows a tool, inside and past the window', () => {
    const base = marks.workersRunning!;
    const t0 = tsOf(base) + 1_000;
    const iso = (t: number) => new Date(t).toISOString();
    const toolText = 'Edit: api/src/middleware/rate-limit.ts';
    const cases: Array<{ textAt: number; now: number; state: string; station: string }> = [
      { textAt: 5_000, now: t0 + 10_000, state: 'implementing', station: 'bay:1' },
      { textAt: 5_000, now: t0 + 19_000, state: 'implementing', station: 'bay:1' },
      { textAt: 5_000, now: t0 + 21_000, state: 'thinking', station: 'home' },
      { textAt: 25_000, now: t0 + 26_000, state: 'thinking', station: 'home' },
    ];
    for (const k of cases) {
      const toolSeq = snapshotAt(base).lastSeq + 1;
      const textSeq = toolSeq + 1;
      const snap: Snapshot = structuredClone(snapshotAt(base));
      const session = snap.runs[0]!.activeSessions.find((a) => a.sessionId === 'ses_rate1')!;
      session.lastTool = { text: toolText, at: iso(t0), seq: toolSeq };
      session.lastOutput = { kind: 'text', at: iso(t0 + k.textAt), seq: textSeq };
      snap.lastSeq = textSeq;
      const fromSnap = fromSnapshot(snap, RUN, k.now);

      const out = (seq: number, at: number, kind: 'tool' | 'text', text: string) =>
        ({ seq, id: `syn_${seq}`, runId: RUN, type: 'agent.output', ts: iso(at), data: { agentId: session.agentId, taskId: 'task_rate', text, kind, role: 'worker', sessionId: 'ses_rate1' } }) as CockpitEvent;
      let folded = fromSnapshot(snapshotAt(base), RUN, k.now);
      for (const e of [out(toolSeq, t0, 'tool', toolText), out(textSeq, t0 + k.textAt, 'text', 'narrating')]) folded = applyEvent(folded, e, k.now).state;

      const label = `text at +${k.textAt}, read at +${k.now - t0}`;
      for (const [side, s] of [['snapshot', fromSnap], ['fold', folded]] as const) {
        const c = s.characters['backend-dev']!;
        expect(resolveState(c, s, k.now), `${side}: ${label}`).toBe(k.state);
        expect(c.station, `${side}: ${label}`).toBe(k.station === 'home' ? c.home : k.station);
      }
      expect(durable(folded, k.now), label).toEqual(durable(fromSnap, k.now));
    }
  });

  it('gives the coarse live state when the last tool call fell outside the scan window, then the fine state at the next output', () => {
    const seq = marks.workersRunning! + 6;
    const narrow = snapshotAt(seq, { scanWindow: 1 });
    const live = narrow.runs[0]!.activeSessions;
    expect(live.length).toBeGreaterThan(1);
    expect(live.some((a) => a.lastTool === null)).toBe(true);
    const now = tsOf(seq);
    const s = fromSnapshot(narrow, RUN, now);
    for (const a of live.filter((x) => x.lastTool === null)) {
      const c = s.characters[s.sessions[a.sessionId]!.characterId]!;
      expect(resolveState(c, s, now), `${c.id} with no known tool`).toBe('thinking');
      expect(c.station).toBe(c.home);
    }
    // The next agent.output for such a session restores the fine state.
    const next = events.find((e) => e.seq > seq && e.type === 'agent.output' && (e.data as { kind?: string }).kind === 'tool' && live.some((a) => a.lastTool === null && a.sessionId === (e.data as { sessionId?: string }).sessionId));
    expect(next).toBeDefined();
    const after = applyEvent(s, next!, tsOf(next!.seq)).state;
    const c = after.characters[after.sessions[(next!.data as { sessionId: string }).sessionId]!.characterId]!;
    expect(['implementing', 'researching', 'testing']).toContain(c.state);
  });
});

describe('applying events a snapshot already reflects', () => {
  it('is a no-op for every event at or below the snapshot lastSeq', () => {
    for (const cut of [marks.workersRunning!, marks.rateTestFailed!, marks.approvalPending!, MISSION_LAST_SEQ]) {
      const state = rebuild(cut);
      for (const e of events.filter((x) => x.seq <= cut)) {
        const result = applyEvent(state, e, tsOf(cut));
        expect(result.state, `seq ${e.seq}`).toBe(state);
        expect(result.intents).toEqual([]);
      }
    }
  });

  it('keeps the rebuilt state when the event arrives twice during a fetch (the rebase re-applies the ring)', () => {
    const cut = marks.workerAsks!;
    const ring = eventSeqsAfter(cut);
    let once = rebuild(cut);
    let twice = rebuild(cut);
    for (const e of ring) once = applyEvent(once, e, tsOf(e.seq)).state;
    for (const e of ring) {
      twice = applyEvent(twice, e, tsOf(e.seq)).state;
      expect(applyEvent(twice, e, tsOf(e.seq)).state).toBe(twice);
    }
    expect(durable(twice, tsOf(MISSION_LAST_SEQ))).toEqual(durable(once, tsOf(MISSION_LAST_SEQ)));
  });

  it('replaces provisional spend with the snapshot on every rebuild', () => {
    const cut = marks.rateCompleted!;
    let state = rebuild(cut);
    const bills = eventSeqsAfter(cut).filter((e) => e.type === 'usage.recorded').slice(0, 3);
    for (const e of bills) state = applyEvent(state, e, tsOf(e.seq)).state;
    expect(state.spend.total.calls).toBe(rebuild(cut).spend.total.calls + 3);
    const reconciled = fromSnapshot(snapshotAt(bills[2]!.seq), RUN, tsOf(bills[2]!.seq));
    expect(reconciled.spend.total.calls).toBe(state.spend.total.calls);
    expect(reconciled.spend.total.inputTokens).toBe(state.spend.total.inputTokens);
  });
});

describe('a stream that joins before the plan exists', () => {
  it('folds provisional tasks without inventing a repo, then the snapshot fills in persona, lead, test command and repo', () => {
    let state = fromSnapshot(snapshotAt(0), RUN, tsOf(1));
    expect(state.characters).toEqual({});
    for (const e of events.filter((x) => x.seq <= marks.tasksCreated!)) state = applyEvent(state, e, tsOf(e.seq)).state;
    const rate = state.taskIndex.tasks['TASK-1']!;
    expect(rate).toMatchObject({ id: 'task_rate', key: 'TASK-1', status: 'pending', persona: null, lead: null, testCommand: null, repo: '' });
    expect(state.crateOf).toEqual({});
    expect(Object.keys(state.bayOf)).toEqual(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
    const full = rebuild(marks.tasksCreated!);
    expect(full.taskIndex.tasks['TASK-1']).toMatchObject({ persona: 'backend-dev', lead: 'lead-1', testCommand: 'npm test -- rate-limit', repo: 'api' });
    expect(full.bayOf).toEqual(state.bayOf);
    expect(Object.keys(full.characters).sort()).toEqual(Object.keys(state.characters).sort());
  });

  it('learns a task persona from the worker session that starts on it', () => {
    let state = fromSnapshot(snapshotAt(0), RUN, tsOf(1));
    for (const e of events.filter((x) => x.seq <= marks.workersRunning!)) state = applyEvent(state, e, tsOf(e.seq)).state;
    expect(state.taskIndex.tasks['TASK-1']!.persona).toBe('backend-dev');
    expect(state.characters['backend-dev']!.task).toBe('TASK-1');
  });

  it('ignores another run, and does not infer anything from seq gaps', () => {
    const state = rebuild(marks.workersRunning!);
    const foreign = { ...events.find((e) => e.type === 'agent.started')!, seq: state.run.lastSeq + 1, runId: 'run_other' } as CockpitEvent;
    expect(applyEvent(state, foreign, tsOf(MISSION_LAST_SEQ))).toEqual({ state, intents: [] });
    const gap = { ...foreign, seq: state.run.lastSeq + 500, runId: RUN, type: 'run.efforts_changed', data: { efforts: {} } } as CockpitEvent;
    expect(applyEvent(state, gap, tsOf(MISSION_LAST_SEQ)).state.run.lastSeq).toBe(state.run.lastSeq + 500);
  });
});
