import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCall } from '@cockpit/agents';
import { AgentsConfig, resolveRoles, type LeadPlan } from '@cockpit/core';
import { fakeEngine, makeRepo, tempDir, testConfig } from './helpers';
import { LocalServer } from '@cockpit/transport';
import { telemetryView } from '../packages/orchestrator/src/dashboard';

// Any agent tagged for a role may take its seat; the human picks per run, and
// may hand a seat to another agent while the run is live.
function rolesConfig(dataDir: string) {
  const config = testConfig(dataDir);
  config.agents = AgentsConfig.parse({
    hierarchy: { supervisor: 'opus', lead: 'codex' },
    agents: [
      { id: 'opus', adapter: 'fake', model: 'opus', roles: ['supervisor', 'lead'] },
      { id: 'codex', adapter: 'fake', model: 'codex', roles: ['lead', 'supervisor'] },
      { id: 'sonnet', adapter: 'fake', model: 'sonnet', roles: ['worker'] },
      { id: 'haiku', adapter: 'fake', model: 'haiku', roles: ['worker'], effort: 'low' },
      { id: 'off', adapter: 'fake', model: 'x', roles: ['lead'], enabled: false },
    ],
  });
  return config;
}

const PLAN: LeadPlan = {
  notes: 'one task',
  tasks: [
    {
      key: 'TASK-101', title: 'alpha', description: 'create src/alpha.js', kind: 'implementation', repository: 'svc', specialty: 'backend',
      risk: 'low', complexity: 'low', worker: 'haiku', files: ['src/alpha.js'], modules: [], resources: [], dependsOn: [],
      acceptanceCriteria: ['exports alpha'], testsRequired: true, testCommand: null,
    },
  ],
};

function handler(plan: LeadPlan) {
  return (call: FakeCall) => {
    switch (call.contract) {
      case 'ArchitectureOutput':
        return { summary: 's', architecture: 'a', constraints: [], acceptanceCriteria: [], risks: [], repositoriesInScope: ['svc'], guidanceForLead: '' };
      case 'LeadArchitectureReview':
        return { assessment: 'ok', proposals: [] };
      case 'LeadPlan':
        return plan;
      case 'WorkerResult':
        writeFileSync(join(call.cwd, 'src', 'alpha.js'), "module.exports.alpha = () => 'alpha';\n");
        return { status: 'completed', summary: 'done', filesChanged: ['src/alpha.js'], testsAdded: [], testsRun: [], questions: [], leaseRequests: [], notes: null };
      case 'LeadReview':
        return { verdict: 'approve', summary: 'clean', issues: [], testsAdequate: true, proposals: [] };
      case 'SupervisorValidation':
        return { verdict: 'accept', summary: 'ok', reportDepth: 'brief', architectureDecisions: [], findings: [], requiredChanges: [], remainingRisks: [], knownLimitations: [], followUps: [], proposalDecisions: [] };
      default:
        throw new Error(`unexpected contract ${call.contract}`);
    }
  };
}

describe('human-chosen roles', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('resolves defaults and refuses agents that may not take a seat', () => {
    const config = rolesConfig(tempDir('roles-cfg'));
    expect(resolveRoles(config, {})).toEqual({ supervisor: 'opus', lead: 'codex' });
    expect(resolveRoles(config, { supervisor: 'codex', lead: 'opus' })).toEqual({ supervisor: 'codex', lead: 'opus' });
    expect(() => resolveRoles(config, { lead: 'sonnet' })).toThrow(/may not act as lead/);
    expect(() => resolveRoles(config, { lead: 'off' })).toThrow(/disabled/);
    expect(() => resolveRoles(config, { lead: 'nope' })).toThrow(/not a configured agent/);
    expect(() => resolveRoles(config, { supervisor: 'codex' })).toThrow(/distinct/);
  });

  it('runs with the chosen seats, staffs the worker the lead picked, and swaps a seat live', async () => {
    const root = tempDir('roles');
    const svc = makeRepo(root, 'svc');
    const { engine } = await fakeEngine(rolesConfig(join(root, 'data')), handler(PLAN));
    const { store } = engine.ctx;

    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }], supervisor: 'codex', lead: 'opus' });
    const r = await engine.settled(run.id);
    expect(r.error).toBeNull();
    expect(r.status).toBe('awaiting_approval');

    const by = (contract: string) => FakeAdapter.calls.filter((c) => c.contract === contract).map((c) => c.agentId);
    expect(new Set(by('ArchitectureOutput'))).toEqual(new Set(['codex']));
    expect(new Set(by('SupervisorValidation'))).toEqual(new Set(['codex']));
    expect(new Set(by('LeadPlan'))).toEqual(new Set(['opus']));
    expect(new Set(by('LeadReview'))).toEqual(new Set(['opus']));
    // The lead saw the roster and its pick was honoured over the router's fallback.
    expect(FakeAdapter.calls.find((c) => c.contract === 'LeadPlan')!.prompt).toContain('- haiku:');
    expect(store.tasks(run.id)[0]!.agentId).toBe('haiku');
    expect(new Set(by('WorkerResult'))).toEqual(new Set(['haiku']));

    // A seat changes hands while the run is live; an invalid swap is refused.
    expect(engine.setRoles(run.id, { lead: 'codex', supervisor: 'opus' })).toEqual({ supervisor: 'opus', lead: 'codex' });
    expect(() => engine.setRoles(run.id, { lead: 'opus' })).toThrow(/distinct/);
    expect(store.events({ runId: run.id, limit: 1000 }).filter((e) => e.type === 'run.roles_changed')).toHaveLength(2);
  });

  it('re-plans when the lead names a worker that does not exist', async () => {
    const root = tempDir('roles-bad');
    const svc = makeRepo(root, 'svc');
    let plans = 0;
    const bad: LeadPlan = { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, worker: 'gpt-9' }] };
    const base = handler(PLAN);
    const { engine } = await fakeEngine(rolesConfig(join(root, 'data')), (call) => {
      if (call.contract === 'LeadPlan') return ++plans === 1 ? bad : PLAN;
      return base(call);
    });
    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }] });
    const r = await engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    expect(plans).toBe(2);
    expect(FakeAdapter.calls.filter((c) => c.contract === 'LeadPlan')[1]!.prompt).toContain('unknown or disabled worker "gpt-9"');
  });

  it('sends each agent the effort the run chose, else its default, and takes a live change', async () => {
    const root = tempDir('effort');
    const svc = makeRepo(root, 'svc');
    const { engine } = await fakeEngine(rolesConfig(join(root, 'data')), handler(PLAN));
    await expect(engine.startRun({ request: 'x', repos: [{ path: svc }], efforts: { opus: 'turbo' } })).rejects.toThrow(/not an effort/);
    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }], efforts: { opus: 'max', codex: 'xhigh' } });
    const r = await engine.settled(run.id);
    expect(r.status).toBe('awaiting_approval');
    const effortOf = (agent: string) => new Set(FakeAdapter.calls.filter((c) => c.agentId === agent).map((c) => c.effort));
    expect(effortOf('opus')).toEqual(new Set(['max']));
    expect(effortOf('codex')).toEqual(new Set(['xhigh']));
    expect(effortOf('haiku')).toEqual(new Set(['low'])); // its agents.yaml default
    expect(engine.setEfforts(run.id, { haiku: 'high' })).toEqual({ opus: 'max', codex: 'xhigh', haiku: 'high' });
    expect(() => engine.setEfforts(run.id, { haiku: 'minimal' })).toThrow(/not an effort/);
  });

  it('defers proposals from task reviews to the final validation instead of a supervisor call per review', async () => {
    const root = tempDir('defer');
    const svc = makeRepo(root, 'svc');
    const base = handler(PLAN);
    const proposal = { kind: 'risk', title: 'Shared cache', rationale: 'two tasks build one', suggestion: 'extract it' };
    let validationPrompt = '';
    const { engine } = await fakeEngine(rolesConfig(join(root, 'data')), (call) => {
      if (call.contract === 'LeadReview') return { verdict: 'approve', summary: 'clean', issues: [], testsAdequate: true, proposals: [proposal] };
      if (call.contract === 'SupervisorValidation') {
        validationPrompt = call.prompt;
        return { ...(base(call) as object), proposalDecisions: [{ proposalIndex: 0, outcome: 'accept', rationale: 'worth a follow-up' }] };
      }
      return base(call);
    });
    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }] });
    expect((await engine.settled(run.id)).status).toBe('awaiting_approval');
    expect(FakeAdapter.calls.filter((c) => c.contract === 'SupervisorDecisions')).toHaveLength(0);
    expect(validationPrompt).toContain('0. [risk] Shared cache');
    const { store } = engine.ctx;
    expect(store.proposals(run.id).map((p) => p.status)).toEqual(['accepted']);
    expect(store.decisions(run.id).map((d) => d.rationale)).toEqual(['worth a follow-up']);
  });

  it('serves the telemetry dashboard: a public page, data behind a read-only token', async () => {
    const root = tempDir('dash');
    const svc = makeRepo(root, 'svc');
    const config = rolesConfig(join(root, 'data'));
    const { engine } = await fakeEngine(config, handler(PLAN));
    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }] });
    expect((await engine.settled(run.id)).status).toBe('awaiting_approval');
    const view = telemetryView(engine.ctx.store, config.engine.dataDir, run.id);
    expect(view.run?.id).toBe(run.id);
    expect(view.calls.length).toBeGreaterThan(0);
    expect(new Set(view.calls.map((c) => c.role))).toEqual(new Set(['supervisor', 'lead', 'worker']));
    expect(view.calls.find((c) => c.role === 'worker')?.task).toBe('TASK-101');
    expect(view.events.some((e) => e.type === 'approval.requested' && e.detail.includes('approvalId'))).toBe(true);
    expect(view.minds.length).toBe(view.calls.length);
    expect(view.minds.every((m) => m.status === 'completed' && m.contract)).toBe(true);
    // Every call reads back what it concluded.
    expect(view.minds.every((m) => m.activity.some((a) => a.kind === 'result'))).toBe(true);
    expect(view.minds.find((m) => m.contract === 'LeadPlan')?.activity.find((a) => a.kind === 'result')?.text).toMatch(/^Planned 1 task/);
    expect(view.tasks[0]?.description).toContain('alpha');

    const server = new LocalServer()
      .route('GET', '/dashboard', ({ res }) => (res.end('<html>'), undefined), { public: true })
      .route('GET', '/telemetry', () => view)
      .route('POST', '/shutdown', () => ({ ok: true }));
    const info = await server.listen(0, join(root, 'srv'));
    const url = (p: string) => `http://127.0.0.1:${info.port}${p}`;
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    try {
      expect((await fetch(url('/dashboard'))).status).toBe(200);
      expect((await fetch(url('/telemetry'))).status).toBe(401);
      expect((await fetch(url('/telemetry'), { headers: auth(info.readToken!) })).status).toBe(200);
      expect((await fetch(url('/shutdown'), { method: 'POST', headers: auth(info.readToken!) })).status).toBe(401);
      expect((await fetch(url('/shutdown'), { method: 'POST', headers: auth(info.token) })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('keeps a separate effort per seat when one agent both leads and works', async () => {
    const root = tempDir('effort-seat');
    const svc = makeRepo(root, 'svc');
    const config = rolesConfig(join(root, 'data'));
    config.agents.agents.find((a) => a.id === 'sonnet')!.roles.push('lead');
    const { engine } = await fakeEngine(config, handler({ ...PLAN, tasks: PLAN.tasks.map((t) => ({ ...t, worker: 'sonnet' })) }));
    await expect(engine.startRun({ request: 'x', repos: [{ path: svc }], efforts: { 'boss:sonnet': 'high' } })).rejects.toThrow(/not a role/);
    const run = await engine.startRun({
      request: 'add alpha', repos: [{ path: svc, testCommand: 'node check.js' }], lead: 'sonnet',
      efforts: { sonnet: 'low', 'lead:sonnet': 'high', 'worker:sonnet': 'medium' },
    });
    expect((await engine.settled(run.id)).status).toBe('awaiting_approval');
    const effortOf = (contract: string) => new Set(FakeAdapter.calls.filter((c) => c.agentId === 'sonnet' && c.contract === contract).map((c) => c.effort));
    expect(effortOf('LeadPlan')).toEqual(new Set(['high']));
    expect(effortOf('WorkerResult')).toEqual(new Set(['medium']));
  });
});
