import { describe, expect, it } from 'vitest';
import type { ProposalKind, ProposalStatus } from '@cockpit/core';
import { Store } from '@cockpit/persistence';
import { buildSnapshot } from '../packages/orchestrator/src/snapshot';
import { testConfig } from './helpers';

const config = testConfig('unused');
const daemon = { pid: 1, port: null };

/** A store with one run, one repo and one task, the way the engine leaves them. */
function seed() {
  const store = new Store(':memory:');
  const project = store.ensureProject('p');
  const repo = store.upsertRepository({ projectId: project.id, name: 'svc', path: '/tmp/svc', baseBranch: 'main', testCommand: null, protectedBranches: [] });
  const run = store.createRun(project.id, 'build it');
  store.setRunMeta(run.id, { repoIds: [repo.id] });
  const task = store.insertTask({
    runId: run.id, key: 'TASK-101', title: 'alpha', description: 'd', kind: 'implementation', repoId: repo.id, specialty: 'backend', risk: 'low', complexity: 'low',
    scope: { files: [], modules: [], resources: [] }, acceptanceCriteria: [], testsRequired: false, testCommand: null, status: 'running', agentId: 'sonnet',
    iteration: 1, branch: 'agent/alpha', worktreePath: '/tmp/wt/alpha', summary: null, blockedReason: null, round: 1,
  });
  return { store, run, repo, task };
}

type Seeded = ReturnType<typeof seed>;

function startSession(s: Seeded, n: number, opts: { seat?: string; contract?: string; taskId?: string | null; role?: 'worker' | 'lead' | 'supervisor' } = {}) {
  const session = s.store.insertSession({
    runId: s.run.id, taskId: opts.taskId === undefined ? s.task.id : opts.taskId, agentId: `agent-${n}`, role: opts.role ?? 'worker', externalId: null, status: 'active', cwd: '/tmp',
  });
  s.store.appendEvent({
    runId: s.run.id, type: 'agent.started',
    data: { agentId: session.agentId, role: session.role, sessionId: session.id, taskId: session.taskId, contract: opts.contract ?? 'WorkerResult', effort: 'high', seat: opts.seat ?? `seat-${n}` },
  });
  return session;
}

const output = (s: Seeded, sessionId: string, kind: 'text' | 'thinking' | 'tool' | 'result' | undefined, text: string) =>
  s.store.appendEvent({ runId: s.run.id, type: 'agent.output', data: { agentId: 'x', taskId: s.task.id, text, kind, sessionId } });

const view = (s: Seeded) => buildSnapshot(s.store, config, daemon).runs.find((r) => r.id === s.run.id)!;

describe('garage snapshot fields', () => {
  it('lastSeq is the store max seq, read in the same call, and 0 when there are no events', () => {
    const s = seed();
    expect(s.store.lastSeq()).toBe(0);
    expect(buildSnapshot(s.store, config, daemon).lastSeq).toBe(0);
    s.store.appendEvent({ runId: s.run.id, type: 'run.status_changed', data: { from: 'created', to: 'planning' } });
    const last = s.store.appendEvent({ runId: null, type: 'run.status_changed', data: { from: 'a', to: 'b' } });
    expect(s.store.lastSeq()).toBe(last.seq);
    expect(buildSnapshot(s.store, config, daemon).lastSeq).toBe(last.seq);
  });

  it('carries every active session, past the 8 the Minds view keeps, with seat and contract', () => {
    const s = seed();
    const ids = Array.from({ length: 12 }, (_, i) => startSession(s, i, { seat: `seat-${i}`, contract: i % 2 ? 'LeadPlan' : 'WorkerResult' }).id);
    const done = startSession(s, 99);
    s.store.updateSession(done.id, { status: 'completed' });

    const v = view(s);
    expect(v.minds).toHaveLength(8);
    expect(v.activeSessions.map((a) => a.sessionId)).toEqual(ids);
    expect(v.activeSessions.map((a) => a.sessionId)).not.toContain(done.id);
    expect(v.activeSessions[3]).toMatchObject({
      agentId: 'agent-3', role: 'worker', seat: 'seat-3', contract: 'LeadPlan', effort: 'high', task: 'TASK-101', lastTool: null, lastOutput: null,
    });
    expect(v.activeSessions[2]).toMatchObject({ contract: 'WorkerResult' });
  });

  it('records the latest tool call (text sliced) and the latest output of any kind, per session', () => {
    const s = seed();
    const a = startSession(s, 1);
    const b = startSession(s, 2, { taskId: null, role: 'lead' });
    const idle = startSession(s, 3);
    output(s, a.id, 'tool', 'Read: old.ts');
    const tool = output(s, a.id, 'tool', `Bash: ${'x'.repeat(500)}`);
    output(s, b.id, 'tool', 'Grep: other');
    const last = output(s, a.id, 'thinking', 'let me think about this');
    output(s, a.id, undefined, 'Read: from before kinds were recorded');
    s.store.appendEvent({ runId: s.run.id, type: 'agent.output', data: { agentId: 'x', taskId: s.task.id, text: 'Edit: no session', kind: 'tool' } });

    const [va, vb, vidle] = view(s).activeSessions;
    expect(va!.sessionId).toBe(a.id);
    expect(va!.lastTool).toEqual({ text: `Bash: ${'x'.repeat(200 - 'Bash: '.length)}`, at: tool.ts, seq: tool.seq });
    expect(va!.lastTool!.text).toHaveLength(200);
    expect(va!.lastOutput).toEqual({ kind: 'thinking', at: last.ts, seq: last.seq });
    expect(Object.keys(va!.lastOutput!).sort()).toEqual(['at', 'kind', 'seq']);
    expect(vb).toMatchObject({ sessionId: b.id, role: 'lead', task: null, lastTool: { text: 'Grep: other' }, lastOutput: { kind: 'tool' } });
    expect(vidle).toMatchObject({ sessionId: idle.id, lastTool: null, lastOutput: null });
  });

  it('names each task by id and worktree', () => {
    const s = seed();
    const t = view(s).tasks[0]!;
    expect(t).toMatchObject({ id: s.task.id, worktree: '/tmp/wt/alpha', key: 'TASK-101' });
    const bare = s.store.insertTask({ ...s.task, id: undefined, key: 'TASK-102', worktreePath: null, branch: null });
    expect(view(s).tasks.find((x) => x.key === 'TASK-102')).toMatchObject({ id: bare.id, worktree: null });
  });

  it('adds input and output tokens per agent and keeps the totals', () => {
    const s = seed();
    const use = (agentId: string, i: number, o: number, c: number) =>
      s.store.insertUsage({ runId: s.run.id, taskId: null, agentId, role: 'worker', model: 'm', inputTokens: i, outputTokens: o, cachedTokens: 0, costUsd: c, durationMs: 1 });
    use('sonnet', 100, 10, 0.5);
    use('sonnet', 200, 20, 0.25);
    use('haiku', 7, 3, 0.125);
    const t = view(s).telemetry;
    expect(t).toEqual({
      calls: 3, inputTokens: 307, outputTokens: 33, costUsd: 0.875,
      byAgent: [
        { agentId: 'haiku', calls: 1, inputTokens: 7, outputTokens: 3, costUsd: 0.125 },
        { agentId: 'sonnet', calls: 2, inputTokens: 300, outputTokens: 30, costUsd: 0.75 },
      ],
    });
  });

  it('lists pending proposals and only the last 10 decided, without the rationale', () => {
    const s = seed();
    const add = (n: number, status: ProposalStatus, kind: ProposalKind = 'scope', taskId: string | null = null) => {
      const p = s.store.insertProposal({ runId: s.run.id, taskId, kind, title: `p${n}`, rationale: 'secret reasoning', suggestion: 'secret suggestion' });
      if (status !== 'open') s.store.setProposalStatus(p.id, status);
      return p;
    };
    for (let i = 0; i < 12; i++) add(i, i % 2 ? 'rejected' : 'accepted');
    add(100, 'open', 'risk', s.task.id);
    add(101, 'needs_analysis');
    add(102, 'escalated');

    const proposals = view(s).proposals;
    const titles = proposals.map((p) => p.title);
    // two oldest decided give way; every undecided one stays
    expect(titles).not.toContain('p0');
    expect(titles).not.toContain('p1');
    expect(titles).toEqual(expect.arrayContaining(['p2', 'p11', 'p100', 'p101', 'p102']));
    expect(proposals).toHaveLength(13);
    expect(proposals.find((p) => p.title === 'p100')).toEqual({ id: expect.any(String), kind: 'risk', title: 'p100', status: 'open', task: 'TASK-101' });
    expect(proposals.find((p) => p.title === 'p3')).toMatchObject({ status: 'rejected', task: null });
    expect(JSON.stringify(proposals)).not.toContain('secret');
  });

  it('leaves every existing field as it was', () => {
    const s = seed();
    const a = startSession(s, 1, { seat: 'backend-dev' });
    output(s, a.id, 'tool', 'Edit: src/a.ts');
    s.store.appendEvent({ runId: s.run.id, type: 'test.failed', data: { taskId: s.task.id, command: 'npm t', scope: 'task', output: '' } as never });

    const snap = buildSnapshot(s.store, config, daemon, undefined, { codex: { windows: [], at: 'now' } });
    expect(Object.keys(snap)).toEqual(['lastSeq', 'generatedAt', 'daemon', 'hierarchy', 'agents', 'runs', 'limits', 'pendingApprovals']);
    expect(snap.daemon).toEqual(daemon);
    expect(snap.limits).toEqual({ codex: { windows: [], at: 'now' } });

    const v = snap.runs[0]!;
    expect(Object.keys(v).sort()).toEqual([
      'activeSessions', 'conflicts', 'council', 'createdAt', 'efforts', 'error', 'id', 'leadership', 'leads', 'minds', 'proposals', 'recentEvents', 'repositories',
      'request', 'roles', 'round', 'status', 'tasks', 'team', 'telemetry', 'tests', 'workers',
    ]);
    expect(Object.keys(v.tasks[0]!).sort()).toEqual([
      'agentId', 'blockedReason', 'branch', 'dependsOn', 'detail', 'id', 'iteration', 'key', 'lead', 'live', 'persona', 'repo', 'specialty', 'status', 'title', 'worktree',
    ]);
    expect(v.workers).toEqual([{ agentId: 'agent-1', role: 'worker', task: 'TASK-101', since: a.startedAt }]);
    expect(v.team).toEqual([]);
    expect(v.repositories).toEqual([{ name: 'svc', path: '/tmp/svc', baseBranch: 'main', integration: null }]);
    expect(v.tests).toEqual([expect.objectContaining({ scope: 'task', command: 'npm t', status: 'failed', task: 'TASK-101' })]);
    expect(v.recentEvents.at(-1)).toMatchObject({ type: 'test.failed', text: 'test.failed task TASK-101' });
    expect(v.recentEvents.at(-2)).toMatchObject({ type: 'agent.output', text: 'x@TASK-101: Edit: src/a.ts' });
    // the Minds view still carries the text the garage's own record leaves out
    expect(v.minds[0]).toMatchObject({ sessionId: a.id, seat: 'backend-dev', contract: 'WorkerResult', activity: [{ kind: 'tool', text: 'Edit: src/a.ts' }] });
    expect(Object.keys(v.minds[0]!).sort()).toEqual(['activity', 'agentId', 'contract', 'effort', 'endedAt', 'role', 'seat', 'sessionId', 'startedAt', 'status', 'task']);
  });
});
