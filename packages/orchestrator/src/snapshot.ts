import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_TASK_STATUSES, effortLevels, type AgentSessionRecord, type Approval, type CockpitEvent, type Run, type Task } from '@cockpit/core';
import type { Store } from '@cockpit/persistence';
import type { CockpitConfig } from '@cockpit/core';
import type { RunMeta, TaskContext } from './context';
import type { TaskLive } from './live';
import type { Limits } from './limits';

/**
 * Read-only projection of workflow state for presentation layers. The cockpit
 * renders this; it never owns or mutates state.
 */
export interface Snapshot {
  generatedAt: string;
  daemon: { pid: number; port: number | null };
  /** The configured default Supervisor and Lead (each run carries its own in `roles`). */
  hierarchy: { supervisor: string; lead: string };
  /** Every configured agent and the roles it may take: what the human picks from. */
  agents: { id: string; adapter: string; model: string | null; roles: string[]; enabled: boolean; effort: string | null; efforts: string[] }[];
  runs: RunView[];
  /** `summary` is capped where it is stored; `text` is the whole question or result the human decides on. */
  pendingApprovals: { id: string; runId: string; kind: string; operation: string | null; summary: string; text: string; createdAt: string }[];
  /** Subscription rate limits per provider, as last reported (Claude per call, Codex from its session logs). */
  limits: Limits;
}

export interface RunView {
  id: string;
  request: string;
  status: string;
  round: number;
  error: string | null;
  createdAt: string;
  /** Who holds the Supervisor and Lead seats of this run. */
  roles: { supervisor: string; lead: string };
  /** The run's effort choice per agent id (agents absent here use their default). */
  efforts: Record<string, string>;
  leadership: { supervisor: string; lead: string };
  repositories: { name: string; path: string; baseBranch: string; integration: { branch: string; passed: boolean } | null }[];
  tasks: {
    key: string;
    title: string;
    status: string;
    /** The kind of worker the task asks for (backend, frontend, test, ...). */
    specialty: string;
    agentId: string | null;
    repo: string;
    iteration: number;
    branch: string | null;
    dependsOn: string[];
    blockedReason: string | null;
    /** The whole task as the Lead wrote it, and where it stands: what the cockpit shows when a row is opened. */
    detail: TaskDetail;
    /** The worktree as it stands (changed files, a preview of the biggest change); null when there is none to read. */
    live: TaskLive | null;
  }[];
  workers: { agentId: string; role: string; task: string | null; since: string }[];
  conflicts: { task: string; pattern: string; heldBy: string; ts: string }[];
  tests: { scope: string; command: string; status: string; task: string | null; ts: string }[];
  telemetry: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; byAgent: { agentId: string; calls: number; costUsd: number }[] };
  /** `text` is the one-line summary; `detail` everything the event carries, for an opened row. */
  recentEvents: { ts: string; type: string; text: string; detail: string }[];
  /** The latest model sessions of the run and what each said, reasoned and ran: the cockpit's Minds view. */
  minds: MindView[];
}

export interface TaskDetail {
  description: string;
  kind: string;
  risk: string;
  complexity: string;
  acceptanceCriteria: string[];
  scope: { files: string[]; modules: string[]; resources: string[] };
  testsRequired: boolean;
  testCommand: string | null;
  summary: string | null;
  /** The latest review, if any. */
  review: { iteration: number; verdict: string; summary: string; issues: { severity: string; file: string | null; description: string }[] } | null;
  /** The orchestrator's last run of the task's test command, its output's tail. */
  validation: { command: string | null; passed: boolean; skipped: boolean; output: string } | null;
}

export interface MindView {
  sessionId: string;
  agentId: string;
  role: string;
  task: string | null;
  /** The structured answer the call must produce (LeadPlan, WorkerResult, ...). */
  contract: string | null;
  effort: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  activity: { ts: string; kind: 'text' | 'thinking' | 'tool' | 'result'; text: string }[];
}

/** Sessions shown in the Minds view, and how much of each one's stream. */
const MIND_SESSIONS = 8;
const MIND_ACTIVITY = 80;
const MIND_TEXT = 3000;
/** Events kept in the snapshot, and the longest field an opened event row shows. */
const RECENT_EVENTS = 40;
const DETAIL_FIELD = 2000;

/** Every field an event carries, one per line, ids turned into task keys. */
export function detailOf(e: CockpitEvent, keyOf: (id: unknown) => string): string {
  return Object.entries(e.data as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const value = k === 'taskId' || k === 'heldBy' ? keyOf(v) : typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${value.length > DETAIL_FIELD ? `${value.slice(0, DETAIL_FIELD)}…` : value}`;
    })
    .join('\n');
}

/**
 * Groups agent output under the session that produced it. Events from before sessions were
 * named on them fall to the latest session of the same agent and task started by then.
 */
export function minds(
  sessions: AgentSessionRecord[], events: CockpitEvent[], keyOf: (id: unknown) => string,
  limits: { sessions: number; activity: number; text: number } = { sessions: MIND_SESSIONS, activity: MIND_ACTIVITY, text: MIND_TEXT },
): MindView[] {
  const started = new Map<string, { contract?: string; effort?: string | null }>();
  for (const e of events) if (e.type === 'agent.started') started.set(String((e.data as { sessionId: string }).sessionId), e.data as never);
  const chosen = [...sessions]
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.startedAt.localeCompare(a.startedAt))
    .slice(0, limits.sessions);
  const byId = new Map(chosen.map((s) => [s.id, [] as MindView['activity']]));
  for (const e of events) {
    if (e.type !== 'agent.output') continue;
    const d = e.data as { agentId: string; taskId?: string | null; text: string; kind?: 'text' | 'thinking' | 'tool' | 'result'; sessionId?: string };
    const owner = d.sessionId
      ?? sessions.filter((s) => s.agentId === d.agentId && (s.taskId ?? null) === (d.taskId ?? null) && s.startedAt <= e.ts).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id;
    const list = owner ? byId.get(owner) : undefined;
    if (!list) continue;
    // Old events carry no kind: a "Tool: detail" line (Claude's tools are capitalized, Codex's are shell/edit) was a tool call.
    const kind = d.kind ?? (/^(?:[A-Z]\w*|shell|edit): /.test(d.text) ? 'tool' : 'text');
    list.push({ ts: e.ts, kind, text: d.text.length > limits.text ? `${d.text.slice(0, limits.text)}…` : d.text });
  }
  return chosen.map((s) => ({
    sessionId: s.id, agentId: s.agentId, role: s.role, task: s.taskId ? keyOf(s.taskId) : null,
    contract: started.get(s.id)?.contract ?? null, effort: started.get(s.id)?.effort ?? null,
    status: s.status, startedAt: s.startedAt, endedAt: s.endedAt,
    activity: byId.get(s.id)!.slice(-limits.activity),
  }));
}

export function describe(e: CockpitEvent, keyOf: (id: unknown) => string): string {
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

export function buildSnapshot(store: Store, config: CockpitConfig, daemon: { pid: number; port: number | null }, live?: (taskId: string) => TaskLive | undefined, limits: Limits = {}): Snapshot {
  const runs = store.runs(10);
  const visible = runs.filter((r, i) => i < 3 || !['completed', 'rejected', 'failed'].includes(r.status));
  return {
    generatedAt: new Date().toISOString(),
    daemon,
    hierarchy: config.agents.hierarchy,
    agents: config.agents.agents.map((a) => ({ id: a.id, adapter: a.adapter, model: a.model, roles: [...a.roles], enabled: a.enabled, effort: a.effort, efforts: effortLevels(a.adapter) })),
    runs: visible.map((r) => runView(store, config, r, live)),
    limits,
    pendingApprovals: store.approvals({ status: 'pending' }).map((a) => ({
      id: a.id, runId: a.runId, kind: a.kind, operation: a.operation, summary: a.summary, text: approvalText(store, a), createdAt: a.createdAt,
    })),
  };
}

export function runView(store: Store, config: CockpitConfig, run: Run, live?: (taskId: string) => TaskLive | undefined): RunView {
  const tasks = store.tasks(run.id);
  const keyById = new Map(tasks.map((t) => [t.id, t.key]));
  const keyOf = (id: unknown) => keyById.get(String(id)) ?? String(id ?? '');
  const deps = store.dependencies(run.id);
  const meta = store.runMeta<RunMeta>(run.id);
  const roles = { supervisor: meta.supervisor ?? config.agents.hierarchy.supervisor, lead: meta.lead ?? config.agents.hierarchy.lead };
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
    roles,
    efforts: meta.efforts ?? {},
    leadership: {
      supervisor: roleState(roles.supervisor, 'supervisor'),
      lead: roleState(roles.lead, 'lead'),
    },
    repositories: repos.map((r) => ({
      name: r.name, path: r.path, baseBranch: r.baseBranch,
      integration: meta.integration?.[r.id] ? { branch: meta.integration[r.id]!.branch, passed: meta.integration[r.id]!.passed } : null,
    })),
    tasks: tasks.map((t) => ({
      key: t.key, title: t.title, status: t.status, agentId: t.agentId, repo: repos.find((r) => r.id === t.repoId)?.name ?? t.repoId,
      iteration: t.iteration, branch: t.branch, dependsOn: deps.filter((d) => d.taskId === t.id).map((d) => keyOf(d.dependsOn)), blockedReason: t.blockedReason,
      detail: taskDetail(store, t),
      specialty: t.specialty,
      live: live?.(t.id) ?? null,
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
    recentEvents: events.slice(-RECENT_EVENTS).map((e) => ({ ts: e.ts, type: e.type, text: describe(e, keyOf), detail: detailOf(e, keyOf) })),
    minds: minds(store.sessions(run.id), events, keyOf),
  };
}

/** The whole text behind an approval: a task's or a decision's question, the final result, else the stored summary. */
function approvalText(store: Store, a: Approval): string {
  const d = (a.details ?? {}) as { question?: string; taskId?: string; text?: string };
  if (d.question) return d.taskId ? `${store.task(d.taskId)?.key ?? d.taskId}: ${d.question}` : d.question;
  return d.text ?? a.summary;
}

/** The tail of a test run kept for the cockpit's terminal view. */
const VALIDATION_TAIL = 3000;

function taskDetail(store: Store, t: Task): TaskDetail {
  const last = store.reviews(t.id).at(-1);
  const v = store.taskContext<TaskContext>(t.id).validation;
  return {
    description: t.description, kind: t.kind, risk: t.risk, complexity: t.complexity, acceptanceCriteria: t.acceptanceCriteria,
    scope: { files: t.scope.files, modules: t.scope.modules, resources: t.scope.resources },
    testsRequired: t.testsRequired, testCommand: t.testCommand, summary: t.summary,
    review: last ? { iteration: last.iteration, verdict: last.verdict, summary: last.summary, issues: last.issues.map((i) => ({ severity: i.severity, file: i.file, description: i.description })) } : null,
    validation: v ? { command: v.command, passed: v.passed, skipped: v.skipped, output: v.output.slice(-VALIDATION_TAIL) } : null,
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
