import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCall } from '@cockpit/agents';
import { AgentsConfig, type LeadPlan } from '@cockpit/core';
import { buildSnapshot } from '../packages/orchestrator/src/snapshot';
import { fakeEngine, makeRepo, tempDir, testConfig } from './helpers';

// A council of supervisors, leads that own areas, and a team of named workers the human approves.
function teamConfig(dataDir: string) {
  const config = testConfig(dataDir);
  config.agents = AgentsConfig.parse({
    hierarchy: { supervisor: 'opus', lead: 'codex' },
    agents: [
      { id: 'opus', adapter: 'fake', model: 'opus', roles: ['supervisor', 'lead'] },
      { id: 'codex', adapter: 'fake', model: 'codex', roles: ['lead', 'supervisor'] },
      { id: 'sonnet', adapter: 'fake', model: 'sonnet', roles: ['worker'] },
      { id: 'haiku', adapter: 'fake', model: 'haiku', roles: ['worker'] },
    ],
  });
  return config;
}

const task = (key: string, title: string, file: string, role: string, lead: string): LeadPlan['tasks'][number] => ({
  key, title, description: `create ${file}`, kind: 'implementation', repository: 'svc', specialty: 'backend', risk: 'low', complexity: 'low',
  worker: null, role, lead, files: [file], modules: [], resources: [], dependsOn: [], acceptanceCriteria: ['exists'], testsRequired: false, testCommand: null,
});

const PLAN: LeadPlan = {
  notes: 'two jobs',
  tasks: [task('TASK-101', 'alpha module', 'src/alpha.js', 'backend-dev', 'lead-1'), task('TASK-102', 'alpha tests', 'test/alpha.test.js', 'tester', 'lead-2')],
  team: [
    { id: 'backend-dev', title: 'Backend developer', specialty: 'backend', worker: 'sonnet', effort: 'high', rationale: 'core code' },
    { id: 'tester', title: 'Test engineer', specialty: 'test', worker: 'haiku', effort: null, rationale: 'cheap and enough' },
  ],
};

function handler(opts: { plans: () => LeadPlan; councilRevisesArchitecture?: boolean }) {
  let archReviews = 0;
  return (call: FakeCall) => {
    switch (call.contract) {
      case 'ArchitectureOutput':
        return { summary: 's', architecture: 'a', constraints: [], acceptanceCriteria: [], risks: [], repositoriesInScope: ['svc'], guidanceForLead: '' };
      case 'CouncilReview':
        if (call.prompt.includes('Review the architecture above') && opts.councilRevisesArchitecture && archReviews++ === 0) {
          return { verdict: 'revise', summary: 'missing a cache', concerns: ['add a read-through cache'] };
        }
        return { verdict: 'approve', summary: 'fine', concerns: [] };
      case 'LeadArchitectureReview':
        return { assessment: 'ok', proposals: [] };
      case 'LeadPlan':
        return opts.plans();
      case 'WorkerResult': {
        const tester = call.prompt.includes('You are tester');
        const file = tester ? join(call.cwd, 'test', 'alpha.test.js') : join(call.cwd, 'src', 'alpha.js');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, tester ? '// test\n' : "module.exports.alpha = () => 'alpha';\n");
        return { status: 'completed', summary: 'done', filesChanged: [tester ? 'test/alpha.test.js' : 'src/alpha.js'], testsAdded: [], testsRun: [], questions: [], leaseRequests: [], notes: null };
      }
      case 'LeadReview':
        return { verdict: 'approve', summary: 'clean', issues: [], testsAdequate: true, proposals: [] };
      case 'SupervisorValidation':
        return { verdict: 'accept', summary: 'ok', reportDepth: 'brief', architectureDecisions: [], findings: [], requiredChanges: [], remainingRisks: [], knownLimitations: [], followUps: [], proposalDecisions: [] };
      default:
        throw new Error(`unexpected contract ${call.contract}`);
    }
  };
}

const START = {
  request: 'add alpha',
  council: [{ agent: 'opus', effort: 'high' }, { agent: 'codex', effort: 'low' }],
  leads: [{ agent: 'codex', effort: 'medium', area: 'backend' }, { agent: 'opus', effort: 'low', area: 'tests' }],
};

describe('councils, area leads and an approved team', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('the council revises the architecture, the team waits for the human, and every seat runs at its own effort', async () => {
    const root = tempDir('team');
    const svc = makeRepo(root, 'svc');
    const config = teamConfig(join(root, 'data'));
    const { engine } = await fakeEngine(config, handler({ plans: () => PLAN, councilRevisesArchitecture: true }));
    const { store } = engine.ctx;

    const run = await engine.startRun({ ...START, repos: [{ path: svc, testCommand: 'node check.js' }] });
    let r = await engine.settled(run.id);
    expect(r.error).toBeNull();
    // The chair drafted twice: the second time with the member's concern.
    const drafts = FakeAdapter.calls.filter((c) => c.contract === 'ArchitectureOutput');
    expect(drafts.map((c) => [c.agentId, c.effort])).toEqual([['opus', 'high'], ['opus', 'high']]);
    expect(drafts[1]!.prompt).toContain('add a read-through cache');
    expect(FakeAdapter.calls.filter((c) => c.contract === 'CouncilReview').every((c) => c.agentId === 'codex' && c.effort === 'low')).toBe(true);

    // No worker starts before the human approves the team.
    expect(r.status).toBe('awaiting_human_decision');
    expect(FakeAdapter.calls.some((c) => c.contract === 'WorkerResult')).toBe(false);
    const gate = store.approvals({ runId: run.id, status: 'pending' }).find((a) => a.kind === 'team')!;
    expect((gate.details as { text: string }).text).toMatch(/backend-dev — Backend developer: sonnet @ high[\s\S]*TASK-101/);

    // The snapshot shows the seats and the team the human is about to approve.
    let view = buildSnapshot(store, config, { pid: 1, port: null }).runs.find((x) => x.id === run.id)!;
    expect(view.council.map((s) => `${s.id}:${s.agent}:${s.effort}`)).toEqual(['sup-1:opus:high', 'sup-2:codex:low']);
    expect(view.leads.map((s) => `${s.id}:${s.agent}:${s.area}`)).toEqual(['lead-1:codex:backend', 'lead-2:opus:tests']);
    expect(view.team.map((p) => `${p.id}:${p.agent}:${p.tasks.join('+')}`)).toEqual(['backend-dev:sonnet:TASK-101', 'tester:haiku:TASK-102']);
    expect(view.tasks.map((t) => `${t.key}:${t.persona}:${t.lead}`)).toEqual(['TASK-101:backend-dev:lead-1', 'TASK-102:tester:lead-2']);

    // The human revises the tester before approving: another model, its own effort.
    expect(() => engine.setTeam(run.id, [{ ...view.team[0]!, agent: 'gpt-9' }])).toThrow(/not an enabled worker/);
    engine.setTeam(run.id, [view.team[0]!, { ...view.team[1]!, agent: 'sonnet', effort: 'low' }]);
    engine.resolveApproval(gate.id, 'approve');
    r = await engine.settled(run.id);
    expect(r.error).toBeNull();
    expect(r.status).toBe('awaiting_approval');

    const of = (contract: string, needle: string) => FakeAdapter.calls.filter((c) => c.contract === contract && c.prompt.includes(needle)).map((c) => `${c.agentId}@${c.effort}`);
    // Same model, two personas, two efforts: nothing shared.
    expect(of('WorkerResult', 'You are backend-dev')).toEqual(['sonnet@high']);
    expect(of('WorkerResult', 'You are tester')).toEqual(['sonnet@low']);
    // Each task's own lead reviewed it.
    expect(of('LeadReview', 'alpha module')).toEqual(['codex@medium']);
    expect(of('LeadReview', 'alpha tests')).toEqual(['opus@low']);
    // The whole council judged the result.
    expect(FakeAdapter.calls.filter((c) => c.contract === 'SupervisorValidation').map((c) => `${c.agentId}@${c.effort}`)).toEqual(['opus@high']);
    expect(store.events({ runId: run.id, limit: 1000 }).filter((e) => e.type === 'council.reviewed').map((e) => (e.data as { subject: string }).subject)).toEqual(['architecture', 'result']);

    view = buildSnapshot(store, config, { pid: 1, port: null }).runs.find((x) => x.id === run.id)!;
    expect(view.minds.filter((m) => m.seat === 'tester').every((m) => m.agentId === 'sonnet' && m.effort === 'low')).toBe(true);
  });

  it('sends the team back with a note: the unstarted tasks go, the head lead plans again with the note', async () => {
    const root = tempDir('team-back');
    const svc = makeRepo(root, 'svc');
    const config = teamConfig(join(root, 'data'));
    let plans = 0;
    const second: LeadPlan = { ...PLAN, team: [PLAN.team[0]!, { ...PLAN.team[1]!, worker: 'sonnet', effort: 'medium' }] };
    const { engine } = await fakeEngine(config, handler({ plans: () => (++plans === 1 ? PLAN : second) }));
    const { store } = engine.ctx;

    const run = await engine.startRun({ ...START, repos: [{ path: svc, testCommand: 'node check.js' }] });
    await engine.settled(run.id);
    const first = store.approvals({ runId: run.id, status: 'pending' }).find((a) => a.kind === 'team')!;
    expect(() => engine.resolveApproval(first.id, 'request_changes')).toThrow(/needs a description/);
    engine.resolveApproval(first.id, 'request_changes', 'tests need sonnet, not haiku');
    let r = await engine.settled(run.id);
    expect(plans).toBe(2);
    expect(FakeAdapter.calls.filter((c) => c.contract === 'LeadPlan')[1]!.prompt).toContain('tests need sonnet, not haiku');
    expect(store.tasks(run.id).map((t) => t.key)).toEqual(['TASK-101', 'TASK-102']);
    expect(r.round).toBe(0);

    const again = store.approvals({ runId: run.id, status: 'pending' }).find((a) => a.kind === 'team')!;
    expect(again.id).not.toBe(first.id);
    engine.resolveApproval(again.id, 'approve');
    r = await engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    expect(FakeAdapter.calls.filter((c) => c.contract === 'WorkerResult' && c.prompt.includes('You are tester')).map((c) => `${c.agentId}@${c.effort}`)).toEqual(['sonnet@medium']);
  });

  it('with team approval off, the staffed team starts right away', async () => {
    const root = tempDir('team-off');
    const svc = makeRepo(root, 'svc');
    const config = teamConfig(join(root, 'data'));
    config.engine.team.approval = false;
    const { engine } = await fakeEngine(config, handler({ plans: () => PLAN }));
    const run = await engine.startRun({ ...START, repos: [{ path: svc, testCommand: 'node check.js' }] });
    const r = await engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    expect(engine.ctx.store.approvals({ runId: run.id }).some((a) => a.kind === 'team')).toBe(false);
  });
});
