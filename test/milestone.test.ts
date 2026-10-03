import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCall } from '@cockpit/agents';
import type { LeadPlan } from '@cockpit/core';
import { fakeEngine, git, makeRepo, sleep, tempDir, testConfig } from './helpers';

const ARCH = {
  summary: 'Add alpha/beta modules to svc-a and gamma to svc-b',
  architecture: 'Plain modules, each with its own file.',
  constraints: ['no new dependencies'],
  acceptanceCriteria: ['all modules exist', 'check.js passes'],
  risks: [{ risk: 'cross-service drift', mitigation: 'gamma depends on alpha' }],
  repositoriesInScope: ['svc-a', 'svc-b'],
  guidanceForLead: 'Parallelize alpha and beta.',
};

const PLAN: LeadPlan = {
  notes: 'three tasks',
  tasks: [
    { key: 'TASK-101', title: 'alpha module', description: 'create src/alpha.js', kind: 'implementation', repository: 'svc-a', specialty: 'backend', risk: 'low', complexity: 'low', worker: null, files: ['src/alpha.js'], modules: [], resources: [], dependsOn: [], acceptanceCriteria: ['exports alpha'], testsRequired: true, testCommand: null },
    { key: 'TASK-102', title: 'beta module', description: 'create src/beta.js', kind: 'implementation', repository: 'svc-a', specialty: 'backend', risk: 'low', complexity: 'low', worker: null, files: ['src/beta.js'], modules: [], resources: [], dependsOn: [], acceptanceCriteria: ['exports beta'], testsRequired: true, testCommand: null },
    { key: 'TASK-103', title: 'gamma client', description: 'create src/gamma.js in svc-b', kind: 'implementation', repository: 'svc-b', specialty: 'backend', risk: 'medium', complexity: 'low', worker: null, files: ['src/gamma.js'], modules: [], resources: [], dependsOn: ['TASK-101'], acceptanceCriteria: ['exports gamma'], testsRequired: true, testCommand: null },
  ],
};

interface Script {
  running: number;
  maxRunning: number;
  workerCalls: Map<string, number>;
  plan: LeadPlan;
  extraWorker?: (key: string, call: FakeCall, n: number) => unknown | undefined;
}

function handler(s: Script) {
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
        return s.plan;
      case 'WorkerResult': {
        const key = basename(call.cwd);
        const count = (s.workerCalls.get(key) ?? 0) + 1;
        s.workerCalls.set(key, count);
        s.running++;
        s.maxRunning = Math.max(s.maxRunning, s.running);
        await sleep(150);
        s.running--;
        const custom = s.extraWorker?.(key, call, count);
        if (custom !== undefined) return custom;
        if (key === 'TASK-103' && count === 1) {
          return { status: 'needs_input', summary: 'unclear export name', filesChanged: [], testsAdded: [], testsRun: [], questions: ['Should gamma be default export?'], leaseRequests: [], notes: null };
        }
        const name = key === 'TASK-101' ? 'alpha' : key === 'TASK-102' ? 'beta' : 'gamma';
        // TASK-102's first attempt contains a bug the test command catches.
        const body = key === 'TASK-102' && count === 1 ? `module.exports.${name} = 'bug';\n` : `module.exports.${name} = () => '${name}';\n`;
        writeFileSync(join(call.cwd, 'src', `${name}.js`), body);
        return { status: 'completed', summary: `implemented ${name}`, filesChanged: [`src/${name}.js`], testsAdded: ['check.js'], testsRun: [{ command: 'node check.js', passed: true }], questions: [], leaseRequests: [], notes: null };
      }
      case 'LeadAnswer':
        return { answer: 'Use a named export.', escalateToSupervisor: false, escalationQuestion: null };
      case 'LeadReview': {
        const anyBug = ['alpha', 'beta', 'gamma'].some((m) => existsSync(join(call.cwd, 'src', `${m}.js`)) && readFileSync(join(call.cwd, 'src', `${m}.js`), 'utf8').includes('bug'));
        // The fake lead approves even with the bug: the orchestrator's test policy must override it.
        return { verdict: 'approve', summary: anyBug ? 'looks fine' : 'clean', issues: [], testsAdequate: true, proposals: [] };
      }
      case 'LeadLeaseDecision':
        return { action: 'wait', rationale: 'owner is nearly done' };
      case 'SupervisorValidation':
        return {
          verdict: 'accept', summary: 'All modules delivered', reportDepth: 'standard', architectureDecisions: ['modules per file'],
          findings: [], requiredChanges: [], remainingRisks: ['none significant'], knownLimitations: [], followUps: ['add docs'], proposalDecisions: [],
        };
      case 'SupervisorRevision':
        return { guidance: 'add a delta module', architectureUpdate: null };
      default:
        throw new Error(`unexpected contract ${call.contract}`);
    }
  };
}

describe('first vertical milestone', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('runs the full hierarchy with parallel isolated workers, review correction, integration and approval', async () => {
    const root = tempDir('e2e');
    const svcA = makeRepo(root, 'svc-a');
    const svcB = makeRepo(root, 'svc-b');
    const config = testConfig(join(root, 'data'));
    const script: Script = { running: 0, maxRunning: 0, workerCalls: new Map(), plan: PLAN };
    const { engine, exporter } = await fakeEngine(config, handler(script));
    const { store } = engine.ctx;

    const run = await engine.startRun({
      request: 'Add alpha, beta and gamma modules',
      repos: [
        { path: svcA, testCommand: 'node check.js' },
        { path: svcB, testCommand: 'node check.js' },
      ],
    });
    let r = await engine.settled(run.id);
    expect(r.error).toBeNull();
    expect(r.status).toBe('awaiting_approval');

    // Parallelism: alpha and beta ran at the same time in separate worktrees.
    expect(script.maxRunning).toBeGreaterThanOrEqual(2);
    // Opus <-> Codex proposal loop happened and was decided by Opus.
    expect(store.decisions(run.id)).toHaveLength(1);
    expect(store.proposals(run.id)[0]!.status).toBe('accepted');

    const tasks = store.tasks(run.id);
    expect(tasks.map((t) => t.status)).toEqual(['integrated', 'integrated', 'integrated']);
    // TASK-102: buggy first attempt -> test failure -> orchestrator overrode the approving review -> corrected.
    const t102 = tasks.find((t) => t.key === 'TASK-102')!;
    expect(store.reviews(t102.id).map((x) => x.verdict)).toEqual(['changes_requested', 'approve']);
    expect(t102.iteration).toBe(2);
    expect(script.workerCalls.get('TASK-102')).toBe(2);
    // The correction resumed the worker's own session.
    const resumed = FakeAdapter.calls.filter((c) => c.contract === 'WorkerResult' && basename(c.cwd) === 'TASK-102');
    expect(resumed[1]!.resumed).toBe(true);
    // TASK-103 asked a question; it went to the lead, not the supervisor.
    const asked = FakeAdapter.calls.filter((c) => c.contract === 'LeadAnswer');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.agentId).toBe('codex');

    // Workers never touched the human's working tree.
    expect(existsSync(join(svcA, 'src', 'alpha.js'))).toBe(false);
    expect(git(svcA, 'status', '--porcelain')).toBe('');
    // Workers ran in their own worktrees; reviews were read-only.
    const workerCwds = FakeAdapter.calls.filter((c) => c.contract === 'WorkerResult').map((c) => c.cwd);
    expect(workerCwds.every((c) => c.includes(join('data', 'worktrees')))).toBe(true);
    expect(FakeAdapter.calls.filter((c) => c.contract === 'LeadReview').every((c) => c.readOnly)).toBe(true);
    expect(FakeAdapter.calls.filter((c) => c.agentId === 'opus').every((c) => c.readOnly)).toBe(true);

    // Report + approval
    expect(r.report).toContain('Engineering report');
    expect(r.report).toContain('TASK-102');
    const types = new Set(store.events({ runId: run.id, limit: 100_000 }).map((e) => e.type));
    for (const t of ['run.started', 'proposal.created', 'proposal.accepted', 'task.created', 'task.assigned', 'task.started', 'agent.started', 'agent.waiting', 'file.lease.acquired', 'review.started', 'review.issue_found', 'review.passed', 'test.started', 'test.failed', 'test.passed', 'approval.requested', 'integration.started', 'integration.completed', 'task.completed']) {
      expect(types, t).toContain(t);
    }

    engine.decideRun(run.id, 'approve', 'ship it');
    r = await engine.settled(run.id);
    expect(r.status).toBe('completed');
    // Final merge reached the base branches.
    expect(readFileSync(join(svcA, 'src', 'alpha.js'), 'utf8')).toContain('alpha');
    expect(readFileSync(join(svcA, 'src', 'beta.js'), 'utf8')).not.toContain('bug');
    expect(readFileSync(join(svcB, 'src', 'gamma.js'), 'utf8')).toContain('gamma');

    // Telemetry spans for each level of the hierarchy.
    await engine.ctx.telemetry.flush();
    const spans = new Set(exporter.getFinishedSpans().map((s) => s.name));
    for (const n of ['opus.architecture', 'codex.architecture_review', 'opus.decisions', 'codex.planning', 'worker.execute', 'codex.review', 'test.run', 'phase.integration', 'opus.validation', 'approval.wait']) {
      expect(spans, n).toContain(n);
    }
    expect(store.usageSummary(run.id).length).toBe(3);
    await engine.shutdown();
    engine.ctx.store.close();
  });

  it('REQUEST CHANGES continues the same run with a new planning round', async () => {
    const root = tempDir('changes');
    const svcA = makeRepo(root, 'svc-a');
    const script: Script = { running: 0, maxRunning: 0, workerCalls: new Map(), plan: { notes: '', tasks: [PLAN.tasks[0]!] } };
    const { engine } = await fakeEngine(testConfig(join(root, 'data')), handler(script));
    const run = await engine.startRun({ request: 'alpha', repos: [{ path: svcA, testCommand: 'node check.js' }] });
    expect((await engine.settled(run.id)).status).toBe('awaiting_approval');

    script.plan = {
      notes: '',
      tasks: [{ ...PLAN.tasks[1]!, key: 'TASK-201', title: 'delta module', files: ['src/beta.js'] }],
    };
    engine.decideRun(run.id, 'request_changes', 'also add a second module');
    const r = await engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    expect(r.round).toBe(1);
    expect(engine.ctx.store.tasks(run.id).map((t) => `${t.key}:${t.status}:${t.round}`)).toEqual(['TASK-101:integrated:0', 'TASK-201:integrated:1']);
    expect(FakeAdapter.calls.some((c) => c.contract === 'SupervisorRevision')).toBe(true);
    engine.decideRun(run.id, 'approve');
    expect((await engine.settled(run.id)).status).toBe('completed');
    expect(existsSync(join(svcA, 'src', 'alpha.js')) && existsSync(join(svcA, 'src', 'gamma.js'))).toBe(true);
    await engine.shutdown();
    engine.ctx.store.close();
  });

  it('survives an orchestrator restart and resumes from the database', async () => {
    const root = tempDir('restart');
    const svcA = makeRepo(root, 'svc-a');
    const config = testConfig(join(root, 'data'));
    const script: Script = { running: 0, maxRunning: 0, workerCalls: new Map(), plan: { notes: '', tasks: [PLAN.tasks[0]!, PLAN.tasks[1]!] } };
    const first = await fakeEngine(config, handler(script));
    const run = await first.engine.startRun({ request: 'alpha+beta', repos: [{ path: svcA, testCommand: 'node check.js' }] });
    // Stop in the middle of execution.
    for (let i = 0; i < 200 && first.engine.ctx.store.runById(run.id)!.status !== 'executing'; i++) await sleep(25);
    await sleep(50);
    await first.engine.shutdown();
    first.engine.ctx.store.close();

    const second = await fakeEngine(config, handler(script));
    expect(second.engine.recover()).toContain(run.id);
    const r = await second.engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    expect(second.engine.ctx.store.tasks(run.id).every((t) => t.status === 'integrated')).toBe(true);
    await second.engine.shutdown();
    second.engine.ctx.store.close();
  });

  it('detects an undeclared file overlap at runtime and lets the lead resolve it', async () => {
    const root = tempDir('lease');
    const svcA = makeRepo(root, 'svc-a');
    const script: Script = {
      running: 0,
      maxRunning: 0,
      workerCalls: new Map(),
      plan: { notes: '', tasks: [PLAN.tasks[0]!, PLAN.tasks[1]!] },
      // TASK-102 also edits alpha.js, which TASK-101 owns.
      extraWorker: (key, call, n) => {
        if (key !== 'TASK-102' || n > 1) return undefined;
        writeFileSync(join(call.cwd, 'src', 'beta.js'), "module.exports.beta = () => 'beta';\n");
        writeFileSync(join(call.cwd, 'src', 'alpha.js'), "module.exports.alpha = () => 'alpha';\n");
        return { status: 'completed', summary: 'beta + touched alpha', filesChanged: ['src/beta.js', 'src/alpha.js'], testsAdded: [], testsRun: [], questions: [], leaseRequests: [{ path: 'src/alpha.js', reason: 'shared helper' }], notes: null };
      },
    };
    const original = script.extraWorker!;
    // Make TASK-101 slower so it still owns alpha.js when TASK-102 submits.
    script.extraWorker = (key, call, n) => (key === 'TASK-101' && n === 1 ? undefined : original(key, call, n));
    const { engine } = await fakeEngine(testConfig(join(root, 'data')), async (call, n) => {
      if (call.contract === 'WorkerResult' && basename(call.cwd) === 'TASK-101') await sleep(400);
      return handler(script)(call, n);
    });
    const run = await engine.startRun({ request: 'alpha+beta', repos: [{ path: svcA, testCommand: 'node check.js' }] });
    const r = await engine.settled(run.id);
    expect(r.error).toBeNull();
    const events = engine.ctx.store.events({ runId: run.id, limit: 100_000 }).map((e) => e.type);
    expect(events).toContain('file.lease.conflict');
    expect(events).toContain('file.lease.resolved');
    expect(FakeAdapter.calls.some((c) => c.contract === 'LeadLeaseDecision' && c.agentId === 'codex')).toBe(true);
    expect(r.status).toBe('awaiting_approval');
    await engine.shutdown();
    engine.ctx.store.close();
  });
});
