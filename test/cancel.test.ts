import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type FakeCall } from '@cockpit/agents';
import type { LeadPlan } from '@cockpit/core';
import { fakeEngine, makeRepo, sleep, tempDir, testConfig } from './helpers';

// The human cancels a mission: whatever phase it is in, it ends there and stays ended.

const PLAN: LeadPlan = {
  notes: 'one job',
  tasks: [{
    key: 'TASK-101', title: 'alpha module', description: 'create src/alpha.js', kind: 'implementation', repository: 'svc', specialty: 'backend', risk: 'low', complexity: 'low',
    worker: null, role: null, lead: null, files: ['src/alpha.js'], modules: [], resources: [], dependsOn: [], acceptanceCriteria: ['exists'], testsRequired: false, testCommand: null,
  }],
  team: [],
};

function handler(worker: (call: FakeCall) => Promise<void>) {
  return async (call: FakeCall) => {
    switch (call.contract) {
      case 'ArchitectureOutput':
        return { summary: 's', architecture: 'a', constraints: [], acceptanceCriteria: [], risks: [], repositoriesInScope: ['svc'], guidanceForLead: '' };
      case 'LeadArchitectureReview':
        return { assessment: 'ok', proposals: [] };
      case 'LeadPlan':
        return PLAN;
      case 'WorkerResult': {
        await worker(call);
        mkdirSync(join(call.cwd, 'src'), { recursive: true });
        writeFileSync(join(call.cwd, 'src', 'alpha.js'), "module.exports.alpha = () => 'alpha';\n");
        return { status: 'completed', summary: 'done', filesChanged: ['src/alpha.js'], testsAdded: [], testsRun: [], questions: [], leaseRequests: [], notes: null };
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

describe('cancelling a mission', () => {
  beforeEach(() => {
    FakeAdapter.calls.length = 0;
  });

  it('ends a mission mid-build: the worker finishing late changes nothing, nothing is reviewed', async () => {
    const root = tempDir('cancel');
    const svc = makeRepo(root, 'svc');
    let release!: () => void;
    let started!: () => void;
    const working = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    const { engine } = await fakeEngine(testConfig(join(root, 'data')), handler(async () => (started(), gate)));
    const { store } = engine.ctx;

    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: null }] });
    await working;
    expect(store.runById(run.id)!.status).toBe('executing');

    const ended = engine.cancel(run.id, 'wrong idea');
    expect(ended.status).toBe('rejected');
    expect(ended.error).toBe('wrong idea');
    expect(store.tasks(run.id).map((t) => [t.key, t.status, t.blockedReason])).toEqual([['TASK-101', 'cancelled', 'wrong idea']]);

    release(); // the worker answers after the cancel
    const r = await engine.settled(run.id);
    await sleep(50);
    expect(r.status).toBe('rejected');
    expect(store.runById(run.id)!.status).toBe('rejected');
    expect(store.tasks(run.id)[0]!.status).toBe('cancelled');
    expect(FakeAdapter.calls.some((c) => c.contract === 'LeadReview' || c.contract === 'SupervisorValidation')).toBe(false);
    const types = store.events({ runId: run.id, limit: 1000 }).map((e) => e.type);
    expect(types).toContain('run.completed');
    expect(types).not.toContain('task.failed');

    expect(() => engine.cancel(run.id)).toThrow(/already rejected/);
    expect(() => engine.cancel('run_missing')).toThrow(/unknown run/);
  });

  it('ends a mission waiting on the human: its pending approval is rejected', async () => {
    const root = tempDir('cancel');
    const svc = makeRepo(root, 'svc');
    const { engine } = await fakeEngine(testConfig(join(root, 'data')), handler(async () => {}));
    const { store } = engine.ctx;

    const run = await engine.startRun({ request: 'add alpha', repos: [{ path: svc, testCommand: null }] });
    expect((await engine.settled(run.id)).status).toBe('awaiting_approval');
    const pending = store.approvals({ runId: run.id, status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);

    engine.cancel(run.id);
    expect(store.runById(run.id)!.status).toBe('rejected');
    expect(store.runById(run.id)!.error).toBe('cancelled by the human');
    expect(store.approvals({ runId: run.id, status: 'pending' })).toEqual([]);
    for (const a of pending) expect(store.approval(a.id)!.status).toBe('rejected');
  });
});
