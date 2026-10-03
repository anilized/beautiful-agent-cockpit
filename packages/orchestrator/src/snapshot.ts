import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_TASK_STATUSES, type CockpitEvent, type Run } from '@cockpit/core';
import type { Store } from '@cockpit/persistence';
import type { CockpitConfig } from '@cockpit/core';
import type { RunMeta } from './context';

/**
 * Read-only projection of workflow state for presentation layers. The cockpit
 * renders this; it never owns or mutates state.
 */
export interface Snapshot {
  generatedAt: string;
  daemon: { pid: number; port: number | null };
  hierarchy: { supervisor: string; lead: string };
  runs: RunView[];
  pendingApprovals: { id: string; runId: string; kind: string; operation: string | null; summary: string; createdAt: string }[];
}

export interface RunView {
  id: string;
  request: string;
  status: string;
  round: number;
  error: string | null;
  createdAt: string;
  leadership: { supervisor: string; lead: string };
  repositories: { name: string; path: string; baseBranch: string; integration: { branch: string; passed: boolean } | null }[];
  tasks: {
    key: string;
    title: string;
    status: string;
    agentId: string | null;
    repo: string;
    iteration: number;
    branch: string | null;
    dependsOn: string[];
    blockedReason: string | null;
  }[];
  workers: { agentId: string; role: string; task: string | null; since: string }[];
  conflicts: { task: string; pattern: string; heldBy: string; ts: string }[];
  tests: { scope: string; command: string; status: string; task: string | null; ts: string }[];
  telemetry: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; byAgent: { agentId: string; calls: number; costUsd: number }[] };
  recentEvents: { ts: string; type: string; text: string }[];
}

function describe(e: CockpitEvent, keyOf: (id: unknown) => string): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'task.status_changed':
      return `${keyOf(d.taskId)} ${d.from} -> ${d.to}`;
    case 'run.status_changed':
      return `run ${d.from} -> ${d.to}`;
    case 'task.assigned':
      return `${keyOf(d.taskId)} -> ${d.agentId}`;
    case 'agent.started':
      return `${d.agentId} (${d.role}) started${d.taskId ? ` on ${keyOf(d.taskId)}` : ''}`;
    case 'agent.output':
      return `${d.agentId}${d.taskId ? `@${keyOf(d.taskId)}` : ''}: ${String(d.text).slice(0, 80)}`;
    case 'proposal.created':
      return `proposal: ${d.title}`;
    case 'review.issue_found':
      return `${keyOf(d.taskId)} review: ${d.issues} issue(s)`;
    case 'review.passed':
      return `${keyOf(d.taskId)} review passed`;
    case 'test.failed':
    case 'test.passed':
      return `${e.type} ${d.scope}${d.taskId ? ` ${keyOf(d.taskId)}` : ''}`;
    default: {
      const t = d.taskId ? keyOf(d.taskId) + ' ' : '';
      const s = d.summary ?? d.reason ?? d.title ?? d.question ?? '';
      return `${e.type} ${t}${String(s).slice(0, 80)}`.trim();
    }
  }
}

export function buildSnapshot(store: Store, config: CockpitConfig, daemon: { pid: number; port: number | null }): Snapshot {
  const runs = store.runs(10);
  const visible = runs.filter((r, i) => i < 3 || !['completed', 'rejected', 'failed'].includes(r.status));
  return {
    generatedAt: new Date().toISOString(),
    daemon,
    hierarchy: config.agents.hierarchy,
    runs: visible.map((r) => runView(store, config, r)),
    pendingApprovals: store.approvals({ status: 'pending' }).map((a) => ({
      id: a.id, runId: a.runId, kind: a.kind, operation: a.operation, summary: a.summary, createdAt: a.createdAt,
    })),
  };
}

export function runView(store: Store, config: CockpitConfig, run: Run): RunView {
  const tasks = store.tasks(run.id);
  const keyById = new Map(tasks.map((t) => [t.id, t.key]));
  const keyOf = (id: unknown) => keyById.get(String(id)) ?? String(id ?? '');
  const deps = store.dependencies(run.id);
  const meta = store.runMeta<RunMeta>(run.id);
  const repos = (meta.repoIds ?? []).map((id) => store.repository(id)!).filter(Boolean);
  const sessions = store.sessions(run.id).filter((s) => s.status === 'active');
  const roleState = (agentId: string, role: string) => {
    const s = sessions.find((x) => x.agentId === agentId && x.role === role);
    return s ? `working${s.taskId ? ` on ${keyOf(s.taskId)}` : ''}` : 'idle';
  };
  const events = store.events({ runId: run.id, limit: 100_000 });
  const conflicts = events
    .filter((e) => e.type === 'file.lease.conflict')
    .map((e) => {
      const d = e.data as { taskId: string; pattern: string; heldBy: string };
      return { task: keyOf(d.taskId), pattern: d.pattern, heldBy: keyOf(d.heldBy), ts: e.ts };
    })
    .filter((c) => {
      const t = tasks.find((x) => x.key === c.task);
      return t && (t.status === 'lease_conflict' || ACTIVE_TASK_STATUSES.has(t.status));
    });
  const tests = events
    .filter((e) => e.type.startsWith('test.'))
    .slice(-10)
    .map((e) => {
      const d = e.data as { scope: string; command: string; taskId?: string | null };
      return { scope: d.scope, command: d.command, status: e.type.slice(5), task: d.taskId ? keyOf(d.taskId) : null, ts: e.ts };
    });
  const usage = store.usageSummary(run.id);
  return {
    id: run.id,
    request: run.request,
    status: run.status,
    round: run.round,
    error: run.error,
    createdAt: run.createdAt,
    leadership: {
      supervisor: roleState(config.agents.hierarchy.supervisor, 'supervisor'),
      lead: roleState(config.agents.hierarchy.lead, 'lead'),
    },
    repositories: repos.map((r) => ({
      name: r.name, path: r.path, baseBranch: r.baseBranch,
      integration: meta.integration?.[r.id] ? { branch: meta.integration[r.id]!.branch, passed: meta.integration[r.id]!.passed } : null,
    })),
    tasks: tasks.map((t) => ({
      key: t.key, title: t.title, status: t.status, agentId: t.agentId, repo: repos.find((r) => r.id === t.repoId)?.name ?? t.repoId,
      iteration: t.iteration, branch: t.branch, dependsOn: deps.filter((d) => d.taskId === t.id).map((d) => keyOf(d.dependsOn)), blockedReason: t.blockedReason,
    })),
    workers: sessions.filter((s) => s.role === 'worker').map((s) => ({ agentId: s.agentId, role: s.role, task: s.taskId ? keyOf(s.taskId) : null, since: s.startedAt })),
    conflicts,
    tests,
    telemetry: {
      calls: usage.reduce((a, u) => a + u.calls, 0),
      inputTokens: usage.reduce((a, u) => a + u.inputTokens, 0),
      outputTokens: usage.reduce((a, u) => a + u.outputTokens, 0),
      costUsd: usage.reduce((a, u) => a + u.costUsd, 0),
      byAgent: usage.map((u) => ({ agentId: u.agentId, calls: u.calls, costUsd: u.costUsd })),
    },
    recentEvents: events.slice(-12).map((e) => ({ ts: e.ts, type: e.type, text: describe(e, keyOf) })),
  };
}

/** Write the snapshot atomically so readers never see a partial file. */
export function writeSnapshot(dataDir: string, snapshot: Snapshot): void {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'snapshot.json');
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  renameSync(tmp, target);
}
