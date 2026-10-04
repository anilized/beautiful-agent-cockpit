import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CockpitEvent, EventType } from '@cockpit/core';
import { HEAD_LEAD, STATE_PRIORITY, THINKING_WINDOW_MS, applyEvent, canVisit, fromSnapshot, resolveState, resolveTarget } from '../packages/garage/src/mapper';
import type { Character, CharacterStateName, GarageState, SceneIntent, SessionInfo, StationId } from '../packages/garage/src/model';
import { MISSION_LAST_SEQ, MISSION_RUN_ID, events, marks, snapshotAt, tsOf } from './garage-mission';

const RUN = MISSION_RUN_ID;
type Rec = Record<string, any>;

// ---------- helpers ----------

const stateBefore = (e: CockpitEvent): GarageState => fromSnapshot(snapshotAt(e.seq - 1), RUN, tsOf(e.seq));
const stateAt = (seq: number): GarageState => fromSnapshot(snapshotAt(seq), RUN, tsOf(seq) ?? Date.parse(snapshotAt(seq).generatedAt));
const nth = (type: EventType, n = 0, pred: (d: Rec) => boolean = () => true): CockpitEvent => {
  const e = events.filter((x) => x.type === type && pred(x.data as Rec)).at(n);
  if (!e) throw new Error(`no ${type} #${n} in the mission`);
  return e;
};
/** Applies one mission event on top of the rebuilt state just before it. */
const step = (e: CockpitEvent) => {
  const before = stateBefore(e);
  return { before, ...applyEvent(before, e, tsOf(e.seq)) };
};
const where = (intents: SceneIntent[], type: SceneIntent['type'], match: Rec = {}) =>
  intents.filter((i) => i.type === type && Object.entries(match).every(([k, v]) => (i as Rec)[k] === v));
const one = (intents: SceneIntent[], type: SceneIntent['type'], match: Rec = {}) => {
  const got = where(intents, type, match);
  expect(got, `${type} ${JSON.stringify(match)} in ${JSON.stringify(intents)}`).toHaveLength(1);
  return got[0] as Rec;
};
const live = (s: GarageState) => Object.entries(s.sessions).filter(([, x]) => x.live).map(([id]) => id).sort();
const now0 = (s: GarageState) => tsOf(s.run.lastSeq) ?? 0;

/** Feeds made-up events (strictly newer than the state) at a moving clock. */
class Sim {
  state: GarageState;
  at: number;
  last: SceneIntent[] = [];
  constructor(from: GarageState, at: number) {
    this.state = from;
    this.at = at;
  }
  feed(type: EventType, data: object, dtMs = 1000): this {
    this.at += dtMs;
    const seq = this.state.run.lastSeq + 1;
    const ev = { seq, id: `syn_${seq}`, runId: RUN, type, ts: new Date(this.at).toISOString(), data } as CockpitEvent;
    const r = applyEvent(this.state, ev, this.at);
    this.state = r.state;
    this.last = r.intents;
    return this;
  }
  start(sessionId: string, agentId: string, role: string, seat: string | null, taskId: string | null) {
    return this.feed('agent.started', { agentId, role, sessionId, taskId, contract: 'X', effort: null, seat });
  }
  out(sessionId: string, agentId: string, taskId: string | null, kind: 'text' | 'thinking' | 'tool' | 'result', text: string, dtMs = 1000) {
    return this.feed('agent.output', { agentId, taskId, text, kind, role: 'worker', sessionId }, dtMs);
  }
  char(id: string) {
    return this.state.characters[id]!;
  }
  resolved(id: string, plus = 0) {
    return resolveState(this.char(id), this.state, this.at + plus);
  }
}
const simAt = (seq: number) => new Sim(stateAt(seq), tsOf(seq) ?? Date.parse(snapshotAt(seq).generatedAt));

// ---------- the Event -> scene table ----------

/** Compile-time exhaustive: adding an event type to core without a row below fails the typecheck. */
const ALL_TYPES: Record<EventType, true> = {
  'run.started': true, 'run.status_changed': true, 'run.roles_changed': true, 'council.reviewed': true, 'team.proposed': true, 'team.changed': true, 'run.efforts_changed': true,
  'run.completed': true, 'architecture.defined': true, 'proposal.created': true, 'proposal.accepted': true, 'proposal.rejected': true, 'proposal.escalated': true, 'plan.created': true,
  'task.created': true, 'task.assigned': true, 'task.started': true, 'task.status_changed': true, 'task.blocked': true, 'task.completed': true, 'task.failed': true,
  'agent.started': true, 'agent.waiting': true, 'agent.output': true, 'agent.completed': true, 'agent.failed': true, 'question.asked': true, 'question.answered': true,
  'file.lease.acquired': true, 'file.lease.released': true, 'file.lease.conflict': true, 'file.lease.resolved': true, 'review.started': true, 'review.issue_found': true,
  'review.passed': true, 'test.started': true, 'test.passed': true, 'test.failed': true, 'escalation.requested': true, 'escalation.resolved': true, 'approval.requested': true,
  'approval.accepted': true, 'approval.rejected': true, 'approval.changes_requested': true, 'integration.started': true, 'integration.conflict': true, 'integration.completed': true,
  'validation.completed': true, 'merge.completed': true, 'usage.limits': true, 'usage.recorded': true,
};

type Row = [name: string, type: EventType, run: () => void];
const rows: Row[] = [];
const row = (name: string, type: EventType, run: () => void) => rows.push([name, type, run]);

const logged = (r: { state: GarageState }, e: CockpitEvent) => expect(r.state.log.at(-1)).toMatchObject({ seq: e.seq, type: e.type });
const quiet = (type: EventType, n = 0, pred?: (d: Rec) => boolean) =>
  row(`${type}: logged, nothing on stage`, type, () => {
    const e = nth(type, n, pred);
    const r = step(e);
    logged(r, e);
    expect(r.intents).toEqual([]);
    expect(r.state.run.lastSeq).toBe(e.seq);
  });

row('starts the log and nothing else', 'run.started', () => {
  const e = nth('run.started');
  const r = step(e);
  expect(r.before.characters).toEqual({});
  logged(r, e);
  expect(r.intents).toEqual([]);
});
row('sets status and phase, and the bench goes busy while integrating', 'run.status_changed', () => {
  const e = nth('run.status_changed', 0, (d) => d.to === 'integrating');
  const r = step(e);
  expect(r.state.run).toMatchObject({ status: 'integrating', phase: 'integration' });
  expect(one(r.intents, 'station', { id: 'bench' }).state).toBe('busy');
});
row('seats the council and the leads, each spawning at its own place', 'run.roles_changed', () => {
  const e = nth('run.roles_changed');
  const r = step(e);
  // The snapshot before it already seats the chair and the head lead (a run starts with those two).
  expect(Object.keys(r.before.characters).sort()).toEqual(['lead-1', 'sup-1']);
  expect(Object.keys(r.state.characters).sort()).toEqual(['lead-1', 'lead-2', 'sup-1', 'sup-2']);
  expect(r.state.characters['sup-2']).toMatchObject({ kind: 'council', agentId: 'codex-gpt', home: 'loft:sup-2' });
  expect(r.state.characters['lead-2']).toMatchObject({ kind: 'lead', agentId: 'claude-sonnet', home: 'desk:lead-2' });
  expect(one(r.intents, 'spawn', { character: 'lead-2' })).toMatchObject({ kind: 'lead', at: 'desk:lead-2' });
  expect(one(r.intents, 'spawn', { character: 'sup-2' })).toMatchObject({ kind: 'council', at: 'loft:sup-2' });
  expect(where(r.intents, 'spawn')).toHaveLength(2);
});
row('a council review is a bubble and an approval stamp at the seat', 'council.reviewed', () => {
  const r = step(nth('council.reviewed'));
  one(r.intents, 'bubble', { character: 'sup-2' });
  expect(one(r.intents, 'stamp', { kind: 'approved' }).at).toBe('loft:sup-2');
});
row('the proposed team spawns the worker personas at the entrance', 'team.proposed', () => {
  const r = step(nth('team.proposed'));
  for (const p of ['backend-dev', 'frontend-dev', 'test-engineer', 'docs-writer']) {
    expect(r.state.characters[p]).toMatchObject({ kind: 'worker', state: 'idle', station: 'entrance' });
    expect(one(r.intents, 'spawn', { character: p }).at).toBe('entrance');
  }
});
row('a team change re-seats the agent of the persona, nobody spawns again', 'team.changed', () => {
  const r = step(nth('team.changed'));
  expect(r.before.characters['test-engineer']!.agentId).toBe('codex-gpt');
  expect(r.state.characters['test-engineer']!.agentId).toBe('claude-sonnet');
  expect(where(r.intents, 'spawn')).toEqual([]);
});
quiet('run.efforts_changed');
row('an approved run celebrates and settles as completed', 'run.completed', () => {
  const e = nth('run.completed');
  const r = step(e);
  expect(r.state.run).toMatchObject({ status: 'completed', phase: 'done' });
  one(r.intents, 'celebrate', { scope: 'run' });
  // Not in the mission: a rejected and a failed run.
  const rejected = simAt(MISSION_LAST_SEQ).feed('run.completed', { outcome: 'rejected' });
  expect(rejected.state.run).toMatchObject({ status: 'rejected', phase: 'done' });
  expect(one(rejected.last, 'stamp', { kind: 'rejected' }).at).toBe('entrance');
  const failed = simAt(MISSION_LAST_SEQ).feed('run.completed', { outcome: 'failed', reason: 'out of budget' });
  expect(failed.state.run.status).toBe('failed');
  one(failed.last, 'stamp', { kind: 'failed', at: 'entrance' });
  expect(where(failed.last, 'celebrate')).toEqual([]);
});
row('the chair says the architecture', 'architecture.defined', () => {
  const r = step(nth('architecture.defined'));
  expect(one(r.intents, 'bubble', { character: 'sup-1' }).text).toContain('Token-bucket');
});
row('a lead proposal goes to the outbox and comes back to where it stood', 'proposal.created', () => {
  const r = step(nth('proposal.created'));
  expect(r.state.outbox.map((o) => o.id)).toEqual(['prop_bucket']);
  expect(r.state.stations['outbox']!.state).toBe('busy');
  one(r.intents, 'station', { id: 'outbox', state: 'busy' });
  const errand = where(r.intents, 'move', { character: 'lead-1' });
  expect(errand.map((i) => (i as Rec).to)).toEqual(['outbox', r.state.characters['lead-1']!.station]);
});
row('a worker proposal stops at the lead desk: a worker may not enter the outbox', 'proposal.created', () => {
  const r = step(nth('proposal.created', 0, (d) => d.proposalId === 'prop_poll'));
  expect(r.state.outbox.find((o) => o.id === 'prop_poll')).toMatchObject({ task: 'TASK-2', status: 'open' });
  const errand = where(r.intents, 'move', { character: 'frontend-dev' }).map((i) => (i as Rec).to);
  expect(errand).toEqual(['desk:lead-2', r.state.characters['frontend-dev']!.station]);
  expect(errand).not.toContain('outbox');
});
row('accepting stamps approved at the outbox and empties it; with changes the stamp says so', 'proposal.accepted', () => {
  const plain = step(nth('proposal.accepted', 0, (d) => d.proposalId === 'prop_bucket'));
  expect(plain.state.outbox.map((o) => o.id)).toEqual(['prop_redis']);
  expect(one(plain.intents, 'stamp', { kind: 'approved' }).at).toBe('outbox');
  const changes = step(nth('proposal.accepted', 0, (d) => d.withChanges));
  expect(changes.state.outbox).toEqual([]);
  one(changes.intents, 'stamp', { kind: 'changes', at: 'outbox' });
  one(changes.intents, 'station', { id: 'outbox', state: 'idle' });
});
row('rejecting stamps rejected at the outbox', 'proposal.rejected', () => {
  const r = step(nth('proposal.rejected'));
  one(r.intents, 'stamp', { kind: 'rejected', at: 'outbox' });
  expect(r.state.outbox).toEqual([]);
});
row('an escalated proposal stays pending and raises an alert', 'proposal.escalated', () => {
  const sim = simAt(marks.proposalsPending!).feed('proposal.escalated', { proposalId: 'prop_redis', rationale: 'needs the human' });
  expect(sim.state.outbox.find((o) => o.id === 'prop_redis')!.status).toBe('escalated');
  expect(sim.state.stations['outbox']!.state).toBe('alert');
  one(sim.last, 'station', { id: 'outbox', state: 'alert' });
});
quiet('plan.created');
row('creates the task, its bay and its board card; a provisional task has no repo yet', 'task.created', () => {
  const first = step(nth('task.created'));
  expect(first.state.taskIndex.keyOfId['task_rate']).toBe('TASK-1');
  expect(first.state.taskIndex.tasks['TASK-1']).toMatchObject({ status: 'pending', repo: '' });
  expect(first.state.bayOf).toEqual({ 'TASK-1': '1' });
  expect(first.state.crateOf).toEqual({});
  expect(first.state.board).toEqual([{ key: 'TASK-1', title: 'Add rate-limit middleware', persona: null, column: 'backlog' }]);
  const last = step(nth('task.created', 3));
  expect(last.state.bayOf['TASK-4']).toBe('4');
  expect(where(last.intents, 'station')).toEqual([]);
});
quiet('task.assigned');
row('records branch and worktree', 'task.started', () => {
  const r = step(nth('task.started'));
  expect(r.state.taskIndex.tasks['TASK-1']).toMatchObject({ branch: 'cockpit/TASK-1' });
  expect(r.state.taskIndex.tasks['TASK-1']!.worktree).toContain('TASK-1');
});
row('a task in review sends its worker to the lead desk and puts the lead in review; a task needing input blocks the worker there', 'task.status_changed', () => {
  const review = step(nth('task.status_changed', 0, (d) => d.taskId === 'task_rate' && d.to === 'in_review'));
  expect(review.state.board.find((c) => c.key === 'TASK-1')!.column).toBe('review');
  expect(one(review.intents, 'animate', { character: 'lead-1' }).animation).toBe('review');
  expect(one(review.intents, 'move', { character: 'backend-dev' }).to).toBe('desk:lead-1');
  const blocked = step(nth('task.status_changed', 0, (d) => d.taskId === 'task_meter' && d.to === 'needs_input'));
  expect(blocked.state.characters['frontend-dev']).toMatchObject({ state: 'blocked', station: 'desk:lead-2' });
  expect(one(blocked.intents, 'animate', { character: 'frontend-dev' }).animation).toBe('blocked');
  one(blocked.intents, 'station', { id: 'bay:2', state: 'alert' });
  expect(blocked.state.board.find((c) => c.key === 'TASK-2')!.column).toBe('blocked');
  const approved = step(nth('task.status_changed', 0, (d) => d.taskId === 'task_rate' && d.to === 'approved'));
  expect(one(approved.intents, 'move', { character: 'backend-dev' }).to).toBe('entrance');
  one(approved.intents, 'station', { id: 'bay:1', state: 'ok' });
});
row('a blocked worker says why', 'task.blocked', () => {
  const r = step(nth('task.blocked'));
  expect(one(r.intents, 'bubble', { character: 'frontend-dev' }).text).toMatch(/^Blocked: /);
});
row('a completed task celebrates', 'task.completed', () => {
  const r = step(nth('task.completed'));
  one(r.intents, 'celebrate', { scope: 'task', task: 'TASK-1' });
});
row('a failed task fails its worker and stamps the bay', 'task.failed', () => {
  const sim = simAt(marks.workersRunning! + 12).feed('task.failed', { taskId: 'task_rate', reason: 'gave up' });
  expect(sim.state.taskIndex.tasks['TASK-1']!.status).toBe('failed');
  expect(sim.state.board.find((c) => c.key === 'TASK-1')!.column).toBe('failed');
  one(sim.last, 'stamp', { kind: 'failed', at: 'bay:1', task: 'TASK-1' });
  expect(sim.resolved('backend-dev')).toBe('failed');
  expect(one(sim.last, 'animate', { character: 'backend-dev' }).animation).toBe('failed');
});
row('a session opens as live and its character wakes', 'agent.started', () => {
  const e = nth('agent.started');
  const r = step(e);
  expect(r.state.sessions['ses_arch']).toMatchObject({ characterId: 'sup-1', live: true, task: null, contract: 'ArchitectureOutput', lastTool: null });
  expect(r.state.characters['sup-1']!.state).toBe('thinking');
  expect(one(r.intents, 'animate', { character: 'sup-1' }).animation).toBe('thinking');
});
row('a question for the lead is a bubble from the waiting worker', 'agent.waiting', () => {
  const r = step(nth('agent.waiting'));
  one(r.intents, 'bubble', { character: 'frontend-dev' });
});
row('a tool line sets the session record, the fine state and the station; a thinking record sets the bubble tone', 'agent.output', () => {
  const read = step(nth('agent.output', 0, (d) => d.kind === 'tool' && d.sessionId === 'ses_meter1'));
  expect(read.state.sessions['ses_meter1']).toMatchObject({ lastTool: 'Read: web/src/header/Header.tsx', lastOutputKind: 'tool', lastToolSeq: read.state.run.lastSeq });
  expect(read.state.characters['frontend-dev']).toMatchObject({ state: 'researching', station: 'crate:web' });
  expect(one(read.intents, 'move', { character: 'frontend-dev' }).to).toBe('crate:web');
  expect(one(read.intents, 'bubble', { character: 'frontend-dev' }).tone).toBe('tool');
  const think = step(nth('agent.output', 0, (d) => d.kind === 'thinking' && d.sessionId === 'ses_rate1'));
  expect(think.state.sessions['ses_rate1']).toMatchObject({ lastOutputKind: 'thinking', lastNarration: expect.stringContaining('Token bucket') });
  expect(one(think.intents, 'bubble', { character: 'backend-dev' }).tone).toBe('think');
  const test = step(nth('agent.output', 0, (d) => d.kind === 'tool' && d.sessionId === 'ses_rate1' && String(d.text).includes('npm test')));
  expect(test.state.characters['backend-dev']).toMatchObject({ state: 'testing', station: 'lab' });
  const edit = step(nth('agent.output', 0, (d) => d.kind === 'tool' && d.sessionId === 'ses_rate1' && String(d.text).startsWith('edit:')));
  expect(edit.state.characters['backend-dev']).toMatchObject({ state: 'implementing', station: 'bay:1' });
});
row('the session closes by id and its character settles', 'agent.completed', () => {
  const r = step(nth('agent.completed'));
  expect(r.state.sessions['ses_arch']!.live).toBe(false);
  expect(r.state.characters['sup-1']!.state).toBe('idle');
  expect(one(r.intents, 'animate', { character: 'sup-1' }).animation).toBe('idle');
});
row('a failed attempt closes the sessions of that agent and task, and its worker shows the failure', 'agent.failed', () => {
  const e = nth('agent.failed');
  const r = step(e);
  expect(r.before.sessions['ses_docs1']!.live).toBe(true);
  expect(r.state.sessions['ses_docs1']!.live).toBe(false);
  expect(one(r.intents, 'animate', { character: 'docs-writer', animation: 'failed' })).toBeDefined();
  one(r.intents, 'stamp', { kind: 'failed', task: 'TASK-4' });
});
row('a question is a bubble from the worker', 'question.asked', () => {
  expect(one(step(nth('question.asked')).intents, 'bubble', { character: 'frontend-dev' }).text).toContain('poll');
});
row('the answer is a bubble from the one who gave it', 'question.answered', () => {
  expect(one(step(nth('question.answered')).intents, 'bubble', { character: 'sup-1' }).text).toContain('Poll every 5 s');
});
quiet('file.lease.acquired');
quiet('file.lease.released');
row('a lease conflict is the worker saying so', 'file.lease.conflict', () => {
  expect(one(step(nth('file.lease.conflict')).intents, 'bubble', { character: 'docs-writer' }).text).toContain('web/src/meter/**');
});
row('a lease decision is the lead saying so', 'file.lease.resolved', () => {
  expect(one(step(nth('file.lease.resolved')).intents, 'bubble', { character: 'lead-2' }).text).toContain('wait');
});
row('a review starting leaves the lead in review, already on stage', 'review.started', () => {
  const e = nth('review.started');
  const r = step(e);
  logged(r, e);
  expect(r.state.characters['lead-1']!.state).toBe('review');
  expect(r.intents).toEqual([]);
});
row('requested changes stamp the lead desk', 'review.issue_found', () => {
  const r = step(nth('review.issue_found'));
  expect(one(r.intents, 'stamp', { kind: 'changes' })).toMatchObject({ at: 'desk:lead-1', task: 'TASK-3' });
  one(r.intents, 'bubble', { character: 'lead-1' });
});
row('an approved review stamps the lead desk', 'review.passed', () => {
  expect(one(step(nth('review.passed')).intents, 'stamp', { kind: 'approved' })).toMatchObject({ at: 'desk:lead-1', task: 'TASK-1' });
});
row('a test starting makes the lab busy', 'test.started', () => {
  const r = step(nth('test.started'));
  expect(r.state.stations['lab']!.state).toBe('busy');
  one(r.intents, 'station', { id: 'lab', state: 'busy' });
});
row('a passing test turns the lab ok and stamps passed', 'test.passed', () => {
  const r = step(nth('test.passed'));
  expect(r.state.stations['lab']!.state).toBe('ok');
  expect(one(r.intents, 'stamp', { kind: 'passed' })).toMatchObject({ at: 'lab', task: 'TASK-1' });
});
row('a failing test turns the lab failed and stamps failed', 'test.failed', () => {
  const r = step(nth('test.failed'));
  expect(r.state.stations['lab']!.state).toBe('failed');
  expect(one(r.intents, 'stamp', { kind: 'failed' })).toMatchObject({ at: 'lab', task: 'TASK-1' });
  one(r.intents, 'station', { id: 'lab', state: 'failed' });
});
row('escalating is the asker speaking up', 'escalation.requested', () => {
  expect(one(step(nth('escalation.requested', 0)).intents, 'bubble', { character: 'frontend-dev' }).text).toContain('Escalating to lead');
  expect(one(step(nth('escalation.requested', 1)).intents, 'bubble', { character: 'lead-2' }).text).toContain('Escalating to supervisor');
});
quiet('escalation.resolved');
row('an approval request shows the card (summary only) and the owner awaits the human', 'approval.requested', () => {
  const team = step(nth('approval.requested', 0));
  expect(team.state.approval).toEqual({ id: 'appr_team1', kind: 'team', summary: expect.stringContaining('worker team'), text: null });
  expect(team.state.characters['lead-1']!.state).toBe('awaitingHuman');
  expect(one(team.intents, 'animate', { character: 'lead-1' }).animation).toBe('awaitingHuman');
  const final = step(nth('approval.requested', 0, (d) => d.approvalId === 'appr_final'));
  expect(final.state.characters['sup-1']!.state).toBe('awaitingHuman');
});
row('an accepted approval clears the card and stamps approved at the owner', 'approval.accepted', () => {
  const r = step(nth('approval.accepted', 0, (d) => d.approvalId === 'appr_final'));
  expect(r.state.approval).toBeNull();
  one(r.intents, 'stamp', { kind: 'approved', at: 'loft:sup-1' });
  expect(r.state.characters['sup-1']!.state).toBe('idle');
});
row('a rejected approval clears the card and stamps rejected', 'approval.rejected', () => {
  const sim = simAt(marks.approvalPending!).feed('approval.rejected', { approvalId: 'appr_final', response: null });
  expect(sim.state.approval).toBeNull();
  one(sim.last, 'stamp', { kind: 'rejected', at: 'loft:sup-1' });
});
row('requested changes clear the card and stamp changes at the owner', 'approval.changes_requested', () => {
  const r = step(nth('approval.changes_requested'));
  expect(r.state.approval).toBeNull();
  one(r.intents, 'stamp', { kind: 'changes', at: 'desk:lead-1' });
});
quiet('integration.started');
row('a merge conflict is the lead of the task speaking', 'integration.conflict', () => {
  expect(one(step(nth('integration.conflict')).intents, 'bubble', { character: 'lead-2' }).text).toContain('web/src/meter/README.md');
});
row('integration stamps passed at the bench', 'integration.completed', () => {
  one(step(nth('integration.completed')).intents, 'stamp', { kind: 'passed', at: 'bench' });
  const failed = simAt(marks.integrationConflict!).feed('integration.completed', { repoId: 'repo_02', branch: 'b', passed: false });
  one(failed.last, 'stamp', { kind: 'failed', at: 'bench' });
});
row('validation stamps the chair loft', 'validation.completed', () => {
  one(step(nth('validation.completed')).intents, 'stamp', { kind: 'passed', at: 'loft:sup-1' });
  one(simAt(marks.integrationDone!).feed('validation.completed', { verdict: 'fail', summary: 'x' }).last, 'stamp', { kind: 'failed', at: 'loft:sup-1' });
});
row('a merge stamps merged at the bench', 'merge.completed', () => {
  one(step(nth('merge.completed')).intents, 'stamp', { kind: 'merged', at: 'bench' });
});
row('limits replace the provider windows and carry no intent', 'usage.limits', () => {
  const e = nth('usage.limits', 2);
  const r = step(e);
  expect(r.state.limits.claude).toEqual({ windows: (e.data as Rec).windows, at: e.ts });
  expect(r.intents).toEqual([]);
});
row('a billed call adds provisional spend', 'usage.recorded', () => {
  const e = nth('usage.recorded');
  const r = step(e);
  const d = e.data as Rec;
  expect(r.state.spend.total.calls).toBe(r.before.spend.total.calls + 1);
  expect(r.state.spend.total.inputTokens).toBe(r.before.spend.total.inputTokens + d.inputTokens);
  expect(r.state.spend.byAgent[d.agentId]!.outputTokens).toBe((r.before.spend.byAgent[d.agentId]?.outputTokens ?? 0) + d.outputTokens);
  expect(r.intents).toEqual([]);
});

describe('every event of the MVP table maps to the expected state change and intents', () => {
  it('has a row for every event type', () => {
    expect(new Set(rows.map(([, type]) => type))).toEqual(new Set(Object.keys(ALL_TYPES)));
  });
  it.each(rows.map(([name, type, run]) => [`${type}: ${name}`, run] as const))('%s', (_name, run) => run());
});

// ---------- priority, the thinking rule, the hard rule ----------

const working: CharacterStateName[] = ['testing', 'implementing', 'researching', 'thinking'];

describe('resolveState', () => {
  const base = () => {
    const s = stateAt(marks.workersRunning! + 6);
    const c = s.characters['backend-dev']!;
    return { s, c, now: tsOf(marks.workersRunning! + 6) };
  };
  const flagsOf = (f: Partial<Character['flags']>) => ({ failed: false, blocked: false, awaitingHuman: false, review: false, ...f });

  it('ranks failed > blocked > awaitingHuman > review > testing > implementing > researching > thinking > waiting > idle', () => {
    expect(STATE_PRIORITY).toEqual(['failed', 'blocked', 'awaitingHuman', 'review', 'testing', 'implementing', 'researching', 'thinking', 'waiting', 'idle']);
    const { s, c, now } = base();
    expect(resolveState(c, s, now)).toBe('implementing');
    const order: Array<[Partial<Character['flags']>, CharacterStateName]> = [
      [{ review: true }, 'review'],
      [{ review: true, awaitingHuman: true }, 'awaitingHuman'],
      [{ review: true, awaitingHuman: true, blocked: true }, 'blocked'],
      [{ review: true, awaitingHuman: true, blocked: true, failed: true }, 'failed'],
      [{ failed: true, review: true }, 'failed'],
      [{ blocked: true, awaitingHuman: true }, 'blocked'],
    ];
    for (const [flags, expected] of order) expect(resolveState({ ...c, flags: flagsOf(flags) }, s, now), JSON.stringify(flags)).toBe(expected);
  });

  it('ranks the fine states of several live sessions: testing > implementing > researching > thinking > waiting', () => {
    const { s, c, now } = base();
    const sessions = (specs: Array<Partial<SessionInfo>>): GarageState => {
      const copy = structuredClone(s);
      for (const [id, x] of Object.entries(copy.sessions)) if (x.characterId === c.id) delete copy.sessions[id];
      specs.forEach((spec, i) => {
        copy.sessions[`ses_p${i}`] = {
          characterId: c.id, agentId: 'codex-gpt', task: 'TASK-1', contract: null, live: true, lastTool: null, lastToolAt: now, lastToolSeq: 1, lastOutputKind: 'tool',
          lastOutputAt: now, lastOutputSeq: 1, lastNarration: null, ...spec,
        };
      });
      return copy;
    };
    const read = { lastTool: 'Read: a.ts' };
    const edit = { lastTool: 'edit: a.ts' };
    const test = { lastTool: 'shell: npm test -- rate-limit' };
    const think = { lastTool: null, lastOutputKind: 'thinking' as const };
    const stale = { lastTool: null, lastOutputKind: 'text' as const, lastOutputAt: now - 60_000, lastToolAt: null };
    const cases: Array<[Array<Partial<SessionInfo>>, CharacterStateName]> = [
      [[read, edit, test, think, stale], 'testing'],
      [[read, edit, think, stale], 'implementing'],
      [[read, think, stale], 'researching'],
      [[think, stale], 'thinking'],
      [[stale], 'waiting'],
    ];
    for (const [specs, expected] of cases) {
      const st = sessions(specs);
      expect(resolveState(st.characters[c.id]!, st, now), JSON.stringify(specs.map((x) => x.lastTool ?? x.lastOutputKind))).toBe(expected);
      expect(resolveState(st.characters[c.id]!, st, now)).toBe(expected);
    }
  });

  it('applies the 20 s thinking rule: thinking until 20 s after the last record, then waiting', () => {
    const sim = simAt(marks.workersRunning!).feed('agent.output', { agentId: 'codex-gpt', taskId: 'task_rate', text: 'hmm', kind: 'thinking', role: 'worker', sessionId: 'ses_rate1' });
    expect(sim.resolved('backend-dev')).toBe('thinking');
    expect(sim.resolved('backend-dev', THINKING_WINDOW_MS)).toBe('thinking');
    expect(sim.resolved('backend-dev', THINKING_WINDOW_MS + 1)).toBe('waiting');
    expect(sim.resolved('backend-dev', 10 * 60_000)).toBe('waiting');
  });

  it('plays the mission silence: 45 s after the chair thought, the chair is waiting, then busy again with the next record', () => {
    const think = events.find((e) => e.seq === marks.thinkingThenSilence)!;
    const r = applyEvent(stateAt(think.seq - 1), think, tsOf(think.seq));
    const chair = r.state.characters['sup-1']!;
    expect(resolveState(chair, r.state, tsOf(think.seq) + 5_000)).toBe('thinking');
    expect(resolveState(chair, r.state, tsOf(think.seq) + 45_000)).toBe('waiting');
    const next = events.find((e) => e.seq > think.seq && e.type === 'agent.output')!;
    const after = applyEvent(r.state, next, tsOf(next.seq));
    expect(resolveState(after.state.characters['sup-1']!, after.state, tsOf(next.seq))).toBe('thinking');
  });

  it('keeps a tool state however old the tool is, until something else is said', () => {
    const sim = simAt(marks.workersRunning!).out('ses_rate1', 'codex-gpt', 'task_rate', 'tool', 'edit: api/src/middleware/rate-limit.ts');
    expect(sim.resolved('backend-dev', 5 * 60_000)).toBe('implementing');
    sim.out('ses_rate1', 'codex-gpt', 'task_rate', 'text', 'Done editing.');
    expect(sim.resolved('backend-dev', 5 * 60_000)).toBe('implementing');
    sim.out('ses_rate1', 'codex-gpt', 'task_rate', 'thinking', 'what next');
    expect(sim.resolved('backend-dev', 5 * 60_000)).toBe('waiting');
  });

  it('never resolves implementing, researching, testing or thinking without a live session, at any step or time', () => {
    let state = stateAt(marks.tasksCreated!);
    let checked = 0;
    for (const e of events.filter((x) => x.seq > marks.tasksCreated!)) {
      state = applyEvent(state, e, tsOf(e.seq)).state;
      for (const c of Object.values(state.characters)) {
        if (Object.values(state.sessions).some((x) => x.live && x.characterId === c.id)) continue;
        for (const plus of [0, 5_000, 25_000, 10 * 60_000]) {
          expect(working, `${c.id} after seq ${e.seq}`).not.toContain(resolveState(c, state, tsOf(e.seq) + plus));
        }
        expect(working).not.toContain(c.state);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('puts a character with a stale tool but no live session at rest, not at its tool station', () => {
    const sim = simAt(marks.workersRunning!).out('ses_rate1', 'codex-gpt', 'task_rate', 'tool', 'shell: npm test -- rate-limit');
    expect(sim.char('backend-dev')).toMatchObject({ state: 'testing', station: 'lab' });
    sim.feed('agent.completed', { agentId: 'codex-gpt', sessionId: 'ses_rate1', taskId: 'task_rate' });
    expect(sim.char('backend-dev')).toMatchObject({ state: 'waiting', station: 'bay:1' });
    expect(sim.state.sessions['ses_rate1']!.lastTool).toContain('npm test');
  });
});

// ---------- sessions ----------

describe('session lifecycle', () => {
  it('maps a session to its seat, else the task persona, else a one-off character', () => {
    const sim = simAt(marks.workersRunning!);
    sim.start('s_seat', 'codex-gpt', 'lead', 'lead-2', null);
    expect(sim.state.sessions['s_seat']!.characterId).toBe('lead-2');
    sim.start('s_persona', 'claude-sonnet', 'worker', null, 'task_meter');
    expect(sim.state.sessions['s_persona']!.characterId).toBe('frontend-dev');
    sim.start('s_one', 'claude-opus', 'supervisor', null, null);
    expect(sim.state.sessions['s_one']!.characterId).toBe('session:s_one');
    expect(sim.char('session:s_one')).toMatchObject({ kind: 'council', seat: null, home: 'entrance', station: 'entrance' });
    expect(one(sim.last, 'spawn', { character: 'session:s_one' }).at).toBe('entrance');
    // A seat nobody announced becomes a character of the kind its role says.
    sim.start('s_new', 'codex-gpt', 'worker', 'perf-tuner', 'task_rate');
    expect(sim.char('perf-tuner')).toMatchObject({ kind: 'worker', persona: 'perf-tuner' });
  });

  it('closes a prior live session of the same agent, task and seat when the next one starts (the attempt failed silently)', () => {
    const sim = simAt(marks.workersRunning!);
    expect(sim.state.sessions['ses_docs1']!.live).toBe(true);
    sim.start('ses_docs1b', 'claude-sonnet', 'worker', 'docs-writer', 'task_docs');
    expect(sim.state.sessions['ses_docs1']!.live).toBe(false);
    expect(sim.state.sessions['ses_docs1b']!.live).toBe(true);
    expect(live(sim.state).filter((id) => sim.state.sessions[id]!.task === 'TASK-4')).toEqual(['ses_docs1b']);
    // Seatless one-offs of the same agent and task are retries of each other too.
    sim.start('o1', 'claude-opus', 'supervisor', null, null).start('o2', 'claude-opus', 'supervisor', null, null);
    expect(sim.state.sessions['o1']!.live).toBe(false);
  });

  it('keeps sessions of different seats live even when they share agent and task (two seats on one model)', () => {
    const s = stateAt(marks.proposalsPending!);
    expect(live(s)).toEqual(expect.arrayContaining(['ses_council1', 'ses_leadarch']));
    const sim = simAt(marks.proposalsPending! - 6);
    // ses_leadarch (lead-1) and ses_council1 (sup-2) are both codex-gpt with no task.
    expect(sim.state.sessions['ses_leadarch']!.live && sim.state.sessions['ses_council1']!.live).toBe(true);
    const folded = events.filter((e) => e.seq > marks.proposalsPending! - 6 && e.seq <= marks.proposalsPending!).reduce((st, e) => applyEvent(st, e, tsOf(e.seq)).state, sim.state);
    expect(folded.sessions['ses_leadarch']!.live && folded.sessions['ses_council1']!.live).toBe(true);
  });

  it('closes a session by sessionId and leaves its siblings alone', () => {
    const sim = simAt(marks.workersRunning!);
    sim.start('a', 'codex-gpt', 'lead', 'lead-1', 'task_rate').start('b', 'codex-gpt', 'lead', 'lead-2', 'task_rate');
    sim.feed('agent.completed', { agentId: 'codex-gpt', sessionId: 'a', taskId: 'task_rate' });
    expect(sim.state.sessions['a']!.live).toBe(false);
    expect(sim.state.sessions['b']!.live).toBe(true);
    expect(sim.state.sessions['ses_rate1']!.live).toBe(true);
  });

  it('closes every live session of that agent and task on agent.failed, and no other', () => {
    const sim = simAt(marks.workersRunning!);
    sim.start('a', 'codex-gpt', 'lead', 'lead-1', 'task_rate').start('b', 'codex-gpt', 'worker', 'backend-dev', 'task_rate');
    sim.feed('agent.failed', { agentId: 'codex-gpt', taskId: 'task_rate', error: 'boom' });
    for (const id of ['a', 'b', 'ses_rate1']) expect(sim.state.sessions[id]!.live, id).toBe(false);
    expect(sim.state.sessions['ses_meter1']!.live).toBe(true);
    expect(sim.state.sessions['ses_docs1']!.live).toBe(true);
    // A session of the same agent but another task survives.
    const other = simAt(marks.workersRunning!).start('c', 'codex-gpt', 'worker', 'test-engineer', 'task_contract');
    other.feed('agent.failed', { agentId: 'codex-gpt', taskId: 'task_rate', error: 'boom' });
    expect(other.state.sessions['c']!.live).toBe(true);
  });

  it('plays the mission: the failed first attempt is closed by agent.failed, or by the next agent.started if that event is lost', () => {
    const failed = events.find((e) => e.type === 'agent.failed')!;
    const retry = events.find((e) => e.type === 'agent.started' && (e.data as Rec).sessionId === 'ses_docs2')!;
    const withFailed = events.filter((e) => e.seq > marks.workersRunning! && e.seq <= retry.seq).reduce((st, e) => applyEvent(st, e, tsOf(e.seq)).state, stateAt(marks.workersRunning!));
    expect(withFailed.sessions['ses_docs1']!.live).toBe(false);
    const lost = events.filter((e) => e.seq > marks.workersRunning! && e.seq <= retry.seq && e.seq !== failed.seq).reduce((st, e) => applyEvent(st, e, tsOf(e.seq)).state, stateAt(marks.workersRunning!));
    expect(lost.sessions['ses_docs1']!.live).toBe(false);
    expect(lost.sessions['ses_docs2']!.live).toBe(true);
    expect(live(lost)).toEqual(live(withFailed));
    // Between the failure and the retry the worker does not pretend to work.
    const gap = events.filter((e) => e.seq > marks.workersRunning! && e.seq <= failed.seq).reduce((st, e) => applyEvent(st, e, tsOf(e.seq)).state, stateAt(marks.workersRunning!));
    expect(working).not.toContain(resolveState(gap.characters['docs-writer']!, gap, tsOf(failed.seq)));
  });

  it('adopts output from a session whose start it never saw, and a snapshot corrects it', () => {
    const sim = simAt(marks.workersRunning!).out('ses_unseen', 'codex-gpt', 'task_contract', 'tool', 'Read: api/x.ts');
    expect(sim.state.sessions['ses_unseen']).toMatchObject({ live: true, lastTool: 'Read: api/x.ts' });
    expect(sim.state.sessions['ses_unseen']!.characterId).toBe('test-engineer');
  });
});

// ---------- idempotence and purity ----------

describe('idempotence and purity', () => {
  it('sets, never toggles: applying an event again on its own result changes nothing but provisional spend', () => {
    let state = stateAt(marks.tasksCreated!);
    for (const e of events.filter((x) => x.seq > marks.tasksCreated!)) {
      const first = applyEvent(state, e, tsOf(e.seq));
      const again = applyEvent({ ...first.state, run: { ...first.state.run, lastSeq: state.run.lastSeq } }, e, tsOf(e.seq));
      const strip = (s: GarageState) => ({ ...s, spend: null, run: { ...s.run, lastSeq: 0 } });
      expect(strip(again.state), `${e.seq} ${e.type}`).toEqual(strip(first.state));
      if (e.type === 'usage.recorded') expect(again.state.spend.total.calls).toBe(first.state.spend.total.calls + 1);
      state = first.state;
    }
  });

  it('updates a session record only from an output newer than the stored one', () => {
    const sim = simAt(marks.workersRunning!);
    sim.out('ses_rate1', 'codex-gpt', 'task_rate', 'tool', 'edit: api/src/middleware/rate-limit.ts');
    const stored = structuredClone(sim.state.sessions['ses_rate1']!);
    const old = { seq: stored.lastOutputSeq - 1, id: 'old', runId: RUN, type: 'agent.output', ts: new Date(sim.at - 5000).toISOString(), data: { agentId: 'codex-gpt', taskId: 'task_rate', text: 'Read: older.ts', kind: 'tool', role: 'worker', sessionId: 'ses_rate1' } } as CockpitEvent;
    const reopened = { ...sim.state, run: { ...sim.state.run, lastSeq: 0 } };
    const result = applyEvent(reopened, old, sim.at);
    expect(result.state.sessions['ses_rate1']).toEqual(stored);
    expect(where(result.intents, 'bubble')).toEqual([]);
    expect(result.state.characters['backend-dev']).toMatchObject({ state: 'implementing', station: 'bay:1' });
    // Equal seq is a duplicate too; a newer one wins.
    const same = applyEvent(reopened, { ...old, seq: stored.lastOutputSeq }, sim.at);
    expect(same.state.sessions['ses_rate1']).toEqual(stored);
    const newer = applyEvent(reopened, { ...old, seq: stored.lastOutputSeq + 1 }, sim.at);
    expect(newer.state.sessions['ses_rate1']).toMatchObject({ lastTool: 'Read: older.ts', lastToolSeq: stored.lastOutputSeq + 1 });
  });

  it('does not mutate its input, and is deterministic', () => {
    const state = stateAt(marks.workerAsks!);
    const frozen = JSON.stringify(state);
    const e = events.find((x) => x.seq > marks.workerAsks!)!;
    const a = applyEvent(state, e, 123);
    const b = applyEvent(state, e, 123);
    expect(JSON.stringify(state)).toBe(frozen);
    expect(a).toEqual(b);
    expect(a.state).not.toBe(state);
    expect(fromSnapshot(snapshotAt(marks.workerAsks!), RUN, 5)).toEqual(fromSnapshot(snapshotAt(marks.workerAsks!), RUN, 5));
  });

  it('has no DOM, node, clock or randomness, and imports only relative .js modules and types', () => {
    const src = readFileSync(new URL('../packages/garage/src/mapper.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\b(document|window|navigator|localStorage|requestAnimationFrame|setTimeout|setInterval)\b/);
    expect(src).not.toMatch(/node:/);
    expect(src).not.toMatch(/Date\.now|Math\.random|new Date\(|performance\.now|randomUUID|crypto\./);
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map((m) => ({ type: !!m[1], from: m[2]! }));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      if (i.from.startsWith('@cockpit/')) expect(i.type, i.from).toBe(true);
      else expect(i.from, 'relative .js').toMatch(/^\.\/[\w-]+\.js$/);
    }
  });

  it('caps the log', () => {
    const sim = simAt(marks.workersRunning!);
    for (let i = 0; i < 250; i++) sim.feed('plan.created', { taskCount: 4, round: 1 }, 10);
    expect(sim.state.log).toHaveLength(200);
    expect(sim.state.log.at(-1)!.seq).toBe(sim.state.run.lastSeq);
  });
});

// ---------- the spatial hierarchy ----------

describe('canVisit and the escalation path', () => {
  const s = stateAt(marks.workersRunning! + 6);
  const ch = (id: string) => s.characters[id]!;
  const stations = (...ids: string[]) => ids as StationId[];

  it('lets a worker go only to its own bay, its own repo crate, the lab, the terminal, the entrance and its own lead desk', () => {
    const backend = ch('backend-dev'); // TASK-1: bay 1, repo api, lead-1
    const allowed = stations('bay:1', 'crate:api', 'lab', 'terminal', 'entrance', 'desk:lead-1');
    const denied = stations('bay:2', 'bay:3', 'bay:4', 'crate:web', 'desk:lead-2', 'loft:sup-1', 'loft:sup-2', 'loft:lead-1', 'bench', 'outbox', 'ext:pet');
    for (const st of allowed) expect(canVisit(backend, st, s), st).toBe(true);
    for (const st of denied) expect(canVisit(backend, st, s), st).toBe(false);
    const frontend = ch('frontend-dev'); // TASK-2: bay 2, repo web, lead-2
    for (const st of stations('bay:2', 'crate:web', 'desk:lead-2', 'lab')) expect(canVisit(frontend, st, s), st).toBe(true);
    for (const st of stations('bay:1', 'crate:api', 'desk:lead-1', 'loft:sup-1')) expect(canVisit(frontend, st, s), st).toBe(false);
  });

  it('resolves the own lead from the task, else lead-1', () => {
    expect(HEAD_LEAD).toBe('lead-1');
    const copy = structuredClone(s);
    copy.taskIndex.tasks['TASK-2']!.lead = null;
    const frontend = copy.characters['frontend-dev']!;
    expect(canVisit(frontend, 'desk:lead-1', copy)).toBe(true);
    expect(canVisit(frontend, 'desk:lead-2', copy)).toBe(false);
    // No task at all: lead-1 too.
    const idle = { ...copy.characters['test-engineer']!, task: null };
    expect(canVisit(idle, 'desk:lead-1', copy)).toBe(true);
  });

  it('resolves own bay and own crate from bayOf and crateOf', () => {
    const copy = structuredClone(s);
    copy.bayOf['TASK-1'] = '9';
    copy.crateOf['TASK-1'] = 'docs-repo';
    const backend = copy.characters['backend-dev']!;
    expect(canVisit(backend, 'bay:9', copy)).toBe(true);
    expect(canVisit(backend, 'bay:1', copy)).toBe(false);
    expect(canVisit(backend, 'crate:docs-repo', copy)).toBe(true);
    expect(canVisit(backend, 'crate:api', copy)).toBe(false);
  });

  it('lets only leads and the council into the loft; a lead visits its own desk only; the council goes anywhere', () => {
    for (const id of ['lead-1', 'lead-2', 'sup-1', 'sup-2']) expect(canVisit(ch(id), 'loft:sup-1', s), id).toBe(true);
    expect(canVisit(ch('lead-1'), 'desk:lead-1', s)).toBe(true);
    expect(canVisit(ch('lead-1'), 'desk:lead-2', s)).toBe(false);
    for (const st of stations('bay:2', 'crate:web', 'bench', 'outbox', 'lab', 'terminal', 'entrance')) expect(canVisit(ch('lead-1'), st, s), st).toBe(true);
    for (const st of stations('desk:lead-1', 'desk:lead-2', 'bay:3', 'bench', 'outbox', 'loft:sup-2')) expect(canVisit(ch('sup-1'), st, s), st).toBe(true);
  });

  it('turns a disallowed target into the nearest allowed station on the escalation path', () => {
    const backend = ch('backend-dev');
    expect(resolveTarget(backend, 'loft:sup-1', s)).toBe('desk:lead-1');
    expect(resolveTarget(backend, 'desk:lead-2', s)).toBe('desk:lead-1');
    expect(resolveTarget(backend, 'bay:2', s)).toBe('desk:lead-1');
    expect(resolveTarget(backend, 'outbox', s)).toBe('desk:lead-1');
    expect(resolveTarget(backend, 'bay:1', s)).toBe('bay:1');
    expect(resolveTarget(ch('frontend-dev'), 'loft:sup-1', s)).toBe('desk:lead-2');
    // A lead that cannot go where it wanted goes to its own desk; it may go up to the loft.
    expect(resolveTarget(ch('lead-2'), 'desk:lead-1', s)).toBe('desk:lead-2');
    expect(resolveTarget(ch('lead-2'), 'loft:sup-1', s)).toBe('loft:sup-1');
    expect(resolveTarget(ch('sup-1'), 'desk:lead-1', s)).toBe('desk:lead-1');
  });

  it('escalates worker -> own lead desk -> loft: the worker asks at the desk, then the lead goes up while the council works on it', () => {
    let state = stateAt(marks.workersRunning! + 30);
    const moves: Array<{ seq: number; character: string; to: string }> = [];
    for (const e of events.filter((x) => x.seq > marks.workersRunning! + 30 && x.seq <= marks.escalationResolved! + 12)) {
      const r = applyEvent(state, e, tsOf(e.seq));
      state = r.state;
      for (const i of where(r.intents, 'move')) moves.push({ seq: e.seq, character: (i as Rec).character, to: (i as Rec).to });
    }
    const worker = moves.filter((m) => m.character === 'frontend-dev');
    const lead = moves.filter((m) => m.character === 'lead-2');
    const toDesk = worker.find((m) => m.to === 'desk:lead-2')!;
    const toLoft = lead.find((m) => m.to === 'loft:sup-1')!;
    expect(toDesk.seq).toBeGreaterThanOrEqual(marks.workerAsks!);
    expect(toDesk.seq).toBeLessThan(marks.escalationToSupervisor!);
    expect(toLoft.seq).toBeGreaterThanOrEqual(marks.escalationToSupervisor!);
    expect(toDesk.seq).toBeLessThan(toLoft.seq);
    // The worker never goes to the loft or the other lead's desk; the lead returns to its desk afterwards, the worker to its bay.
    expect(worker.map((m) => m.to).filter((to) => to.startsWith('loft:') || to === 'desk:lead-1')).toEqual([]);
    expect(lead.filter((m) => m.seq > toLoft.seq).some((m) => m.to === 'desk:lead-2')).toBe(true);
    expect(worker.at(-1)!.to).toBe('bay:2');
  });

  it('sends a worker to the loft never: across the whole mission, every station and every move obeys canVisit', () => {
    let state = stateAt(marks.tasksCreated!);
    let moves = 0;
    for (const e of events.filter((x) => x.seq > marks.tasksCreated!)) {
      const r = applyEvent(state, e, tsOf(e.seq));
      state = r.state;
      for (const c of Object.values(state.characters)) expect(canVisit(c, c.station, state), `${c.id} at ${c.station} after seq ${e.seq}`).toBe(true);
      for (const i of r.intents) {
        if (i.type !== 'move' && i.type !== 'spawn') continue;
        const target = i.type === 'move' ? i.to : i.at;
        const c = state.characters[i.character]!;
        expect(canVisit(c, target, state), `${c.id} -> ${target} at seq ${e.seq}`).toBe(true);
        if (c.kind === 'worker') {
          expect(target.startsWith('loft:'), `${c.id} -> ${target}`).toBe(false);
          if (target.startsWith('desk:')) expect(target).toBe(`desk:${c.lead}`);
        }
        moves += 1;
      }
    }
    expect(moves).toBeGreaterThan(40);
  });
});

// ---------- fromSnapshot specifics ----------

describe('fromSnapshot', () => {
  it('gives an empty state for a run the snapshot does not hold, keeping lastSeq and limits', () => {
    const snap = snapshotAt(MISSION_LAST_SEQ);
    const s = fromSnapshot(snap, 'run_missing', 1);
    expect(s.run).toEqual({ runId: 'run_missing', lastSeq: MISSION_LAST_SEQ, phase: 'setup', status: 'created' });
    expect(s.characters).toEqual({});
    expect(s.limits).toEqual(snap.limits);
  });

  it('builds the cast, the board, the outbox and the approval from structured fields', () => {
    const s = stateAt(marks.approvalPending!);
    expect(Object.values(s.characters).map((c) => `${c.kind}:${c.id}`).sort()).toEqual([
      'council:sup-1', 'council:sup-2', 'lead:lead-1', 'lead:lead-2', 'worker:backend-dev', 'worker:docs-writer', 'worker:frontend-dev', 'worker:test-engineer',
    ]);
    expect(s.approval).toMatchObject({ id: 'appr_final', kind: 'result', text: expect.stringContaining('ready to merge') });
    expect(s.characters['sup-1']!.state).toBe('awaitingHuman');
    expect(s.board.map((c) => c.column)).toEqual(['done', 'done', 'done', 'done']);
    expect(s.run).toMatchObject({ status: 'awaiting_approval', phase: 'approval' });
    // Decided proposals are not in the outbox; a pending one is.
    expect(s.outbox).toEqual([]);
    expect(stateAt(marks.proposalPollPending!).outbox).toEqual([{ id: 'prop_poll', kind: 'implementation', title: expect.any(String), status: 'open', task: 'TASK-2' }]);
  });

  it('takes spend and limits from the snapshot', () => {
    const snap = snapshotAt(MISSION_LAST_SEQ);
    const s = fromSnapshot(snap, RUN, 1);
    const t = snap.runs[0]!.telemetry;
    expect(s.spend.total).toEqual({ calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd });
    expect(Object.keys(s.spend.byAgent).sort()).toEqual(t.byAgent.map((a) => a.agentId).sort());
    expect(s.limits.claude!.windows[0]!.usedPercent).toBe(41.8);
  });

  it('puts the lab by the last test and the bench by the run status', () => {
    expect(stateAt(marks.rateTestFailed!).stations['lab']!.state).toBe('failed');
    expect(stateAt(marks.rateTestPassed!).stations['lab']!.state).toBe('ok');
    expect(stateAt(marks.integrationConflict!).stations['bench']!.state).toBe('busy');
    expect(stateAt(MISSION_LAST_SEQ).stations['bench']!.state).toBe('ok');
  });
});
