import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canTransitionRun, canTransitionTask, type CockpitEvent, type EventType, type RunStatus, type TaskStatus } from '@cockpit/core';
import { MISSION_LAST_SEQ, MISSION_RUN_ID, TASKS, eventAt, events, marks, runEvents, snapshotAt, tsOf } from './garage-mission';

const run = (seq: number) => snapshotAt(seq).runs[0]!;
const typesOf = (list: readonly CockpitEvent[]) => new Set<EventType>(list.map((e) => e.type));

describe('garage mission fixture: events', () => {
  it('has strictly increasing seqs with gaps, forward time and unique ids', () => {
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      expect(Date.parse(events[i]!.ts)).toBeGreaterThanOrEqual(Date.parse(events[i - 1]!.ts));
    }
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    // The run's stream is not contiguous: a viewer must never infer gaps from seq.
    expect(runEvents.some((e, i) => i > 0 && e.seq - runEvents[i - 1]!.seq > 1)).toBe(true);
    expect(events.some((e) => e.runId === null)).toBe(true);
    expect(MISSION_LAST_SEQ).toBe(events.at(-1)!.seq);
  });

  it('covers every scenario of the mission', () => {
    const t = typesOf(events);
    for (const type of [
      'run.started', 'run.status_changed', 'run.roles_changed', 'run.efforts_changed', 'team.proposed', 'team.changed', 'plan.created', 'task.created', 'task.assigned',
      'task.started', 'task.blocked', 'task.completed', 'agent.started', 'agent.completed', 'agent.failed', 'agent.waiting', 'agent.output', 'review.started', 'review.issue_found',
      'review.passed', 'test.started', 'test.passed', 'test.failed', 'escalation.requested', 'escalation.resolved', 'question.asked', 'question.answered', 'council.reviewed',
      'proposal.created', 'proposal.accepted', 'proposal.rejected', 'integration.started', 'integration.conflict', 'integration.completed', 'validation.completed',
      'approval.requested', 'approval.accepted', 'approval.changes_requested', 'merge.completed', 'run.completed', 'usage.recorded', 'usage.limits', 'file.lease.conflict',
      'architecture.defined',
    ] as EventType[]) expect(t, type).toContain(type);

    const started = events.filter((e) => e.type === 'agent.started').map((e) => e.data as { seat?: string | null; contract?: string; role: string });
    expect(new Set(started.map((s) => s.seat))).toEqual(new Set(['sup-1', 'sup-2', 'lead-1', 'lead-2', 'backend-dev', 'frontend-dev', 'test-engineer', 'docs-writer']));
    expect(started.every((s) => s.contract)).toBe(true);
    const kinds = new Set(events.filter((e) => e.type === 'agent.output').map((e) => (e.data as { kind?: string }).kind));
    expect(kinds).toEqual(new Set(['text', 'thinking', 'tool', 'result']));
    const roles = events.find((e) => e.type === 'run.roles_changed')!.data as { council: unknown[]; leads: { area?: string | null }[] };
    expect(roles.council).toHaveLength(2);
    expect(roles.leads.map((l) => l.area ?? null)).toEqual([null, 'frontend']);
  });

  it('plays the review cycle (CHANGES then APPROVED) and the failed-then-passing test in order', () => {
    const seqOf = (type: EventType, taskId: string) => runEvents.filter((e) => e.type === type && (e.data as { taskId?: string }).taskId === taskId).map((e) => e.seq);
    const [changes] = seqOf('review.issue_found', 'task_contract');
    const [approved] = seqOf('review.passed', 'task_contract');
    expect(changes).toBeLessThan(approved!);
    const [failed] = seqOf('test.failed', 'task_rate');
    const [passed] = seqOf('test.passed', 'task_rate');
    expect(failed).toBeLessThan(passed!);
  });

  it('escalates worker -> lead -> supervisor before the answer', () => {
    const esc = runEvents.filter((e) => e.type === 'escalation.requested').map((e) => e.data as { from: string; to: string });
    expect(esc.map((x) => `${x.from}>${x.to}`)).toEqual(['worker>lead', 'lead>supervisor']);
    expect(marks.escalationToLead).toBeLessThan(marks.escalationToSupervisor!);
    expect(marks.escalationToSupervisor).toBeLessThan(marks.escalationResolved!);
  });

  it('only makes valid run and task transitions, and ends completed', () => {
    const taskState = new Map<string, TaskStatus>(TASKS.map((t) => [t.id, 'pending']));
    let status: RunStatus = 'created';
    for (const e of runEvents) {
      const d = e.data as { from?: string; to?: string; taskId?: string };
      if (e.type === 'run.status_changed') {
        expect(d.from, `seq ${e.seq}`).toBe(status);
        expect(canTransitionRun(d.from as RunStatus, d.to as RunStatus), `seq ${e.seq} ${d.from}->${d.to}`).toBe(true);
        status = d.to as RunStatus;
      }
      if (e.type === 'task.status_changed') {
        expect(d.from, `seq ${e.seq}`).toBe(taskState.get(d.taskId!));
        expect(canTransitionTask(d.from as TaskStatus, d.to as TaskStatus), `seq ${e.seq} ${d.from}->${d.to}`).toBe(true);
        taskState.set(d.taskId!, d.to as TaskStatus);
      }
    }
    expect(status).toBe('completed');
    expect([...taskState.values()].every((s) => s === 'integrated')).toBe(true);
  });

  it('opens and closes every session once, and never speaks outside one', () => {
    const live = new Set<string>();
    const seen = new Set<string>();
    for (const e of runEvents) {
      const d = e.data as { sessionId?: string; agentId: string; taskId?: string | null };
      if (e.type === 'agent.started') {
        expect(seen.has(d.sessionId!)).toBe(false);
        seen.add(d.sessionId!);
        live.add(d.sessionId!);
      } else if (e.type === 'agent.completed') {
        expect(live.delete(d.sessionId!), `seq ${e.seq}`).toBe(true);
      } else if (e.type === 'agent.output') {
        expect(live.has(d.sessionId!), `seq ${e.seq}`).toBe(true);
      }
    }
    // The only session that never completes is the one agent.failed killed.
    expect([...live]).toEqual(['ses_docs1']);
  });

  it('is deterministic: no clock, no randomness, same output twice', () => {
    const src = readFileSync(new URL('./garage-mission.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now|Math\.random|new Date\(\)|randomUUID|performance\.now/);
    expect(JSON.stringify(snapshotAt(MISSION_LAST_SEQ))).toBe(JSON.stringify(snapshotAt(MISSION_LAST_SEQ)));
    expect(snapshotAt(marks.rateTestFailed!).generatedAt).toBe(eventAt(marks.rateTestFailed!)!.ts);
  });
});

describe('garage mission fixture: snapshotAt', () => {
  it('reports lastSeq as the cut, is JSON-clean, and starts empty before the run', () => {
    expect(snapshotAt(0).runs).toEqual([]);
    for (const seq of [1, marks.runStarted!, marks.completed!, MISSION_LAST_SEQ]) {
      const snap = snapshotAt(seq);
      expect(snap.lastSeq).toBe(seq);
      expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    }
    expect(snapshotAt(MISSION_LAST_SEQ + 50).lastSeq).toBe(MISSION_LAST_SEQ);
  });

  it('activeSessions is exactly the sessions open after each event, with their latest tool and output', () => {
    // Independent replay of the same events.
    const open = new Map<string, { agentId: string; taskId: string | null; seat: string | null; contract: string | null }>();
    const tools = new Map<string, { text: string; seq: number }>();
    const outs = new Map<string, { kind: string; seq: number }>();
    let cursor = 0;
    for (const snapSeq of runEvents.map((e) => e.seq)) {
      while (cursor < runEvents.length && runEvents[cursor]!.seq <= snapSeq) {
        const e = runEvents[cursor++]!;
        const d = e.data as { sessionId?: string; agentId: string; taskId?: string | null; seat?: string | null; contract?: string; kind?: string; text?: string };
        if (e.type === 'agent.started') open.set(d.sessionId!, { agentId: d.agentId, taskId: d.taskId ?? null, seat: d.seat ?? null, contract: d.contract ?? null });
        if (e.type === 'agent.completed') open.delete(d.sessionId!);
        if (e.type === 'agent.failed') for (const [id, s] of open) if (s.agentId === d.agentId && s.taskId === (d.taskId ?? null)) open.delete(id);
        if (e.type === 'agent.output') {
          outs.set(d.sessionId!, { kind: d.kind!, seq: e.seq });
          if (d.kind === 'tool') tools.set(d.sessionId!, { text: d.text!, seq: e.seq });
        }
      }
      const got = run(snapSeq).activeSessions;
      expect(got.map((s) => s.sessionId).sort(), `seq ${snapSeq}`).toEqual([...open.keys()].sort());
      for (const s of got) {
        expect({ seat: s.seat, contract: s.contract }).toEqual({ seat: open.get(s.sessionId)!.seat, contract: open.get(s.sessionId)!.contract });
        expect(s.lastTool?.seq ?? null).toBe(tools.get(s.sessionId)?.seq ?? null);
        expect(s.lastTool?.text ?? null).toBe(tools.get(s.sessionId)?.text ?? null);
        expect(s.lastOutput?.seq ?? null).toBe(outs.get(s.sessionId)?.seq ?? null);
        expect(s.lastOutput?.kind ?? null).toBe(outs.get(s.sessionId)?.kind ?? null);
        if (s.lastOutput) expect(s.lastOutput).not.toHaveProperty('text');
      }
    }
  });

  it('tasks carry id and worktree once started, and follow the run through its states', () => {
    const early = run(marks.tasksCreated!);
    expect(early.tasks.map((t) => [t.id, t.key, t.worktree, t.status])).toEqual(TASKS.map((t) => [t.id, t.key, null, 'pending']));
    expect(early.tasks.find((t) => t.key === 'TASK-3')!.dependsOn).toEqual(['TASK-1']);

    const going = run(marks.workersRunning!);
    expect(going.status).toBe('executing');
    expect(going.tasks.filter((t) => t.status === 'running').map((t) => t.key)).toEqual(['TASK-1', 'TASK-2', 'TASK-4']);
    for (const t of going.tasks.filter((x) => x.status === 'running')) expect(t.worktree).toContain(t.key);
    expect(going.tasks.find((t) => t.key === 'TASK-3')!.worktree).toBeNull();
    expect(going.activeSessions.filter((s) => s.role === 'worker').map((s) => s.seat).sort()).toEqual(['backend-dev', 'docs-writer', 'frontend-dev']);

    const done = run(marks.completed!);
    expect(done.status).toBe('completed');
    expect(done.activeSessions).toEqual([]);
    expect(done.tasks.map((t) => t.status)).toEqual(['integrated', 'integrated', 'integrated', 'integrated']);
    expect(done.tasks.every((t) => t.worktree && t.branch)).toBe(true);
    expect(done.repositories.map((r) => r.integration?.passed)).toEqual([true, true]);
  });

  it('shows the failed test, the lease conflict and the review as the snapshot would at that moment', () => {
    const failed = run(marks.rateTestFailed!).tasks.find((t) => t.key === 'TASK-1')!;
    expect(failed.detail.validation).toMatchObject({ passed: false, skipped: false, command: 'npm test -- rate-limit' });
    expect(run(marks.rateTestPassed!).tasks.find((t) => t.key === 'TASK-1')!.detail.validation?.passed).toBe(true);
    expect(run(marks.rateTestFailed!).tests.at(-1)).toMatchObject({ status: 'failed', task: 'TASK-1' });

    const blocked = run(marks.leaseConflict!);
    expect(blocked.tasks.find((t) => t.key === 'TASK-4')).toMatchObject({ status: 'lease_conflict', blockedReason: null });
    expect(blocked.conflicts).toEqual([expect.objectContaining({ task: 'TASK-4', heldBy: 'TASK-2' })]);
    // The engine never writes blockedReason on entering lease_conflict, and task.blocked does not persist it.
    expect(run(marks.workerAsks!).tasks.find((t) => t.key === 'TASK-2')!.blockedReason).toBeNull();
    // Repository ids are opaque: events name `repo_01`, the snapshot names `api`.
    const ids = events.filter((e) => e.type === 'task.created').map((e) => (e.data as { repoId: string }).repoId);
    expect(ids.every((id) => /^repo_\d+$/.test(id))).toBe(true);
    expect(run(marks.completed!).repositories.map((r) => r.name)).toEqual(['api', 'web']);

    const changes = run(marks.reviewChanges!).tasks.find((t) => t.key === 'TASK-3')!;
    expect(changes.detail.review).toMatchObject({ verdict: 'changes_requested', iteration: 1 });
    expect(changes.detail.review!.issues.length).toBeGreaterThan(0);
    expect(run(marks.reviewApproved!).tasks.find((t) => t.key === 'TASK-3')!.detail.review).toMatchObject({ verdict: 'approve', iteration: 2 });
  });

  it('keeps proposals, approvals, limits, council and team in step with the events', () => {
    expect(run(marks.proposalsPending!).proposals.map((p) => p.status)).toEqual(['open', 'open']);
    expect(run(marks.proposalsDecided!).proposals.map((p) => [p.id, p.status])).toEqual([['prop_bucket', 'accepted'], ['prop_redis', 'rejected']]);
    expect(run(marks.proposalPollPending!).proposals.at(-1)).toEqual({ id: 'prop_poll', kind: 'implementation', title: expect.any(String), status: 'open', task: 'TASK-2' });
    expect(run(marks.proposalPollAccepted!).proposals.at(-1)!.status).toBe('accepted_with_changes');

    expect(snapshotAt(marks.teamApprovalPending!).pendingApprovals.map((a) => a.id)).toEqual(['appr_team1']);
    expect(snapshotAt(marks.teamApproved!).pendingApprovals).toEqual([]);
    expect(snapshotAt(marks.approvalPending!).pendingApprovals).toEqual([expect.objectContaining({ id: 'appr_final', runId: MISSION_RUN_ID, operation: 'merge' })]);
    expect(snapshotAt(marks.approvalAccepted!).pendingApprovals).toEqual([]);

    expect(run(marks.teamProposed!).team.map((p) => p.agent)).toEqual(['codex-gpt', 'claude-sonnet', 'codex-gpt', 'claude-sonnet']);
    expect(run(marks.teamChanged!).team.find((p) => p.id === 'test-engineer')).toMatchObject({ agent: 'claude-sonnet', effort: 'medium', tasks: ['TASK-3'] });
    const seats = run(marks.workersRunning!);
    expect(seats.council.map((s) => s.id)).toEqual(['sup-1', 'sup-2']);
    expect(seats.leads.map((s) => [s.id, s.area])).toEqual([['lead-1', null], ['lead-2', 'frontend']]);
    expect(seats.team.find((p) => p.id === 'backend-dev')!.state).toBe('working on TASK-1');

    expect(snapshotAt(1).limits).toEqual({});
    expect(snapshotAt(MISSION_LAST_SEQ).limits.claude!.windows[0]!.usedPercent).toBe(41.8);
    expect(snapshotAt(marks.runStarted! + 5).limits.claude!.windows[0]!.usedPercent).toBe(23.4);
  });

  it('adds up telemetry per agent from usage.recorded', () => {
    const t = run(MISSION_LAST_SEQ).telemetry;
    const calls = events.filter((e) => e.type === 'usage.recorded');
    expect(t.calls).toBe(calls.length);
    expect(t.byAgent.map((a) => a.agentId)).toEqual(['claude-opus', 'claude-sonnet', 'codex-gpt']);
    expect(t.byAgent.reduce((n, a) => n + a.inputTokens, 0)).toBe(t.inputTokens);
    expect(t.byAgent.find((a) => a.agentId === 'codex-gpt')!.costUsd).toBe(0);
    expect(t.byAgent.every((a) => a.inputTokens > 0 && a.outputTokens > 0)).toBe(true);
  });

  it('scanWindow drops a session\'s tool record that fell out of the window, seat and contract with it', () => {
    const at = marks.thinkingThenSilence!;
    expect(run(at).activeSessions[0]).toMatchObject({ seat: 'sup-1', lastOutput: { kind: 'thinking' }, lastTool: null });
    const seq = marks.workersRunning! + 6;
    const full = run(seq).activeSessions.find((s) => s.sessionId === 'ses_rate1')!;
    expect(full.lastTool).not.toBeNull();
    const narrow = snapshotAt(seq, { scanWindow: 2 }).runs[0]!.activeSessions.find((s) => s.sessionId === 'ses_rate1')!;
    expect(narrow).toMatchObject({ seat: null, contract: null, lastTool: null, lastOutput: null });
  });

  it('leaves a long silence after thinking for the 20 s rule', () => {
    const think = marks.thinkingThenSilence!;
    const next = events.find((e) => e.seq > think)!;
    expect(Date.parse(next.ts) - tsOf(think)).toBeGreaterThanOrEqual(30_000);
  });

  it('feeds real text views: recentEvents are capped and minds carry the activity', () => {
    const v = run(MISSION_LAST_SEQ);
    expect(v.recentEvents).toHaveLength(40);
    expect(v.recentEvents.at(-1)!.type).toBe('run.completed');
    expect(v.minds.length).toBeGreaterThan(0);
    expect(v.minds.some((m) => m.activity.some((a) => a.kind === 'tool' && /^[A-Za-z_]+: /.test(a.text)))).toBe(true);
    // Worktree files come from what the task's workers edited.
    expect(run(marks.rateCompleted!).tasks.find((t) => t.key === 'TASK-1')!.live!.files.map((f) => f.path)).toEqual(['api/src/middleware/rate-limit.ts']);
  });
});
