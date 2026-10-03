import { describe, expect, it } from 'vitest';
import {
  canTransitionRun,
  canTransitionTask,
  ConflictGraph,
  contractJsonSchema,
  Contracts,
  CycleError,
  matchGlob,
  patternsOverlap,
  RoutingConfig,
  TaskGraph,
  type AgentProfile,
  type ContractName,
} from '@cockpit/core';
import { AgentRouter, translate } from '@cockpit/agents';
import { PermissionEngine } from '@cockpit/orchestrator';
import { PermissionsConfig, AgentProfile as AgentProfileSchema } from '@cockpit/core';
import { Store } from '@cockpit/persistence';
import { LeaseManager } from '@cockpit/workspace';

describe('task graph', () => {
  it('orders dependencies first and detects cycles', () => {
    const g = new TaskGraph(['a', 'b', 'c'], [{ taskId: 'c', dependsOn: 'b' }, { taskId: 'b', dependsOn: 'a' }]);
    expect(g.topologicalOrder()).toEqual(['a', 'b', 'c']);
    expect(g.readyNodes(['a', 'b', 'c'], new Set(['a']))).toEqual(['a', 'b']);
    g.addEdge('a', 'c');
    expect(() => g.validate()).toThrow(CycleError);
  });
});

describe('scope overlap', () => {
  it('handles files, directories and globs', () => {
    expect(patternsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(patternsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
    expect(patternsOverlap('src/auth/', 'src/auth/login.ts')).toBe(true);
    expect(patternsOverlap('src/auth/**', 'src/api/**')).toBe(false);
    expect(patternsOverlap('src/*.ts', 'src/x.ts')).toBe(true);
    expect(patternsOverlap('src/*.ts', 'src/sub/x.ts')).toBe(false);
    expect(patternsOverlap('SRC\\A.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/**', 'src/a/b/c.ts')).toBe(true);
  });

  it('builds a conflict graph across repositories and shared resources', () => {
    const g = new ConflictGraph([
      { id: 't1', repoId: 'r1', scope: { files: ['src/a.ts'], modules: [], resources: [] } },
      { id: 't2', repoId: 'r1', scope: { files: [], modules: ['src'], resources: [] } },
      { id: 't3', repoId: 'r2', scope: { files: ['src/a.ts'], modules: [], resources: ['db:users'] } },
      { id: 't4', repoId: 'r3', scope: { files: [], modules: [], resources: ['DB:users'] } },
    ]);
    expect(g.conflictsOf('t1')).toEqual(['t2']);
    expect(g.compatibleWith('t3', ['t1', 't2'])).toBe(true);
    expect(g.compatibleWith('t3', ['t4'])).toBe(false);
  });
});

describe('state machines', () => {
  it('enforces run and task transitions', () => {
    expect(canTransitionRun('created', 'architecting')).toBe(true);
    expect(canTransitionRun('created', 'executing')).toBe(false);
    expect(canTransitionRun('awaiting_approval', 'planning')).toBe(true);
    expect(canTransitionRun('completed', 'failed')).toBe(false);
    expect(canTransitionTask('in_review', 'approved')).toBe(true);
    expect(canTransitionTask('pending', 'approved')).toBe(false);
  });
});

describe('contracts', () => {
  it('produce strict JSON schemas accepted by both CLIs', () => {
    for (const name of Object.keys(Contracts) as ContractName[]) {
      const check = (node: any): void => {
        if (node?.type === 'object') {
          expect(node.additionalProperties).toBe(false);
          expect(new Set(node.required)).toEqual(new Set(Object.keys(node.properties)));
        }
        for (const v of Object.values(node ?? {})) if (v && typeof v === 'object') check(v);
      };
      check(contractJsonSchema(name));
    }
  });
});

describe('router', () => {
  const p = (x: Partial<AgentProfile> & { id: string }) => AgentProfileSchema.parse({ adapter: 'fake', roles: ['worker'], ...x });
  const router = new AgentRouter(
    [
      p({ id: 'sonnet', capabilities: { reasoningDepth: 'high', costTier: 'medium' } as any }),
      p({ id: 'haiku', specialties: ['documentation'], capabilities: { reasoningDepth: 'low', costTier: 'low' } as any }),
      p({ id: 'off', enabled: false }),
    ],
    RoutingConfig.parse({ rules: [{ name: 'docs', when: { kind: ['docs'] }, prefer: ['haiku'] }], fallback: ['sonnet'] }),
  );
  it('routes by rules, specialty and depth', () => {
    expect(router.route({ kind: 'docs', specialty: 'documentation', risk: 'low', complexity: 'low' }).agentId).toBe('haiku');
    expect(router.route({ kind: 'implementation', specialty: 'backend', risk: 'high', complexity: 'high' }).agentId).toBe('sonnet');
    expect(router.route({ kind: 'docs', specialty: 'documentation', risk: 'high', complexity: 'high' }, { strategy: 'prefer_quality' }).agentId).toBe('sonnet');
  });
});

describe('permission engine', () => {
  const pe = new PermissionEngine(PermissionsConfig.parse({}));
  it('classifies high-risk commands and protected branches', () => {
    expect(pe.checkCommand('npm test').requiresApproval).toBe(false);
    expect(pe.classifyCommand('rm -rf /')).toContain('destructive_shell');
    expect(pe.classifyCommand('git push origin main')).toContain('protected_push');
    expect(pe.classifyCommand('terraform apply -auto-approve')).toContain('cloud_infrastructure');
    expect(pe.checkMerge('main').requiresApproval).toBe(true);
    expect(pe.checkMerge('release/1.2').requiresApproval).toBe(true);
    expect(pe.checkMerge('feature/x').requiresApproval).toBe(false);
  });
});

describe('leases', () => {
  it('acquires scope atomically and reports conflicts with owners', () => {
    const store = new Store(':memory:');
    const prj = store.ensureProject('p');
    const repo = store.upsertRepository({ projectId: prj.id, name: 'r', path: '/r', baseBranch: 'main', testCommand: null, protectedBranches: [] });
    const run = store.createRun(prj.id, 'x');
    const mk = (key: string, files: string[]) =>
      store.insertTask({
        runId: run.id, key, title: key, description: '', kind: 'implementation', repoId: repo.id, specialty: 'backend', risk: 'low',
        complexity: 'low', scope: { files, modules: [], resources: [] }, acceptanceCriteria: [], testsRequired: true, testCommand: null,
        status: 'ready', agentId: null, iteration: 0, branch: null, worktreePath: null, summary: null, blockedReason: null, round: 0,
      });
    const a = mk('A', ['src/a.ts']);
    const b = mk('B', ['src/b.ts']);
    const leases = new LeaseManager(store);
    expect(leases.acquireScope(a).ok).toBe(true);
    expect(leases.acquireScope(b).ok).toBe(true);
    const claim = leases.claimFiles(b, ['src/b.ts', 'src/a.ts', 'src/c.ts']);
    expect(claim.acquired).toEqual(['src/c.ts']);
    expect(claim.conflicts.map((c) => c.heldBy)).toEqual([a.id]);
    leases.release(a.id);
    expect(leases.claimFiles(b, ['src/a.ts']).conflicts).toEqual([]);
  });
});

describe('claude stream translation', () => {
  it('extracts structured output and usage from a result message', () => {
    const evs = translate(
      { type: 'result', subtype: 'success', is_error: false, structured_output: { ok: 1 }, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, modelUsage: { 'claude-sonnet': {} } },
      'sonnet',
    );
    expect(evs).toEqual([
      { type: 'usage', usage: { model: 'claude-sonnet', inputTokens: 15, outputTokens: 3, cachedTokens: 5, costUsd: 0.01 } },
      { type: 'result', output: { ok: 1 } },
    ]);
  });
});
