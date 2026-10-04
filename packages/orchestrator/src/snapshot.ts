import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_TASK_STATUSES, effortLevels, type AgentSessionRecord, type Approval, type CockpitEvent, type Proposal, type Run, type Task } from '@cockpit/core';
import type { Store } from '@cockpit/persistence';
import type { CockpitConfig } from '@cockpit/core';
import { councilOf, leadsOf, type EngineContext, type RunMeta, type TaskContext } from './context';
import type { TaskLive } from './live';
import type { Limits } from './limits';

/**
 * Read-only projection of workflow state for presentation layers. The cockpit
 * renders this; it never owns or mutates state.
 */
export interface Snapshot {
  /** The highest event seq at the moment the snapshot was built: where an observer resumes the event stream. */
  lastSeq: number;
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
  /** The Supervisor council (the first chairs) and the Leads (the first is the head), each seat at its own effort. */
  council: SeatView[];
  leads: SeatView[];
  /** The worker personas (backend-dev, tester, ...), their models and efforts, and the tasks each does. */
  team: { id: string; title: string; specialty: string; agent: string; effort: string | null; tasks: string[]; state: string }[];
  repositories: { name: string; path: string; baseBranch: string; integration: { branch: string; passed: boolean } | null }[];
  tasks: {
    /** The task's id, as events name it (`key` is the human-facing one). */
    id: string;
    /** Where the task's worktree lives, once it has started. */
    worktree: string | null;
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
    /** The persona doing the task and the Lead seat owning it, when the plan named them. */
    persona: string | null;
    lead: string | null;
  }[];
  workers: { agentId: string; role: string; task: string | null; since: string }[];
  conflicts: { task: string; pattern: string; heldBy: string; ts: string }[];
  tests: { scope: string; command: string; status: string; task: string | null; ts: string }[];
  telemetry: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; byAgent: { agentId: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[] };
  /** `text` is the one-line summary; `detail` everything the event carries, for an opened row. */
  recentEvents: { ts: string; type: string; text: string; detail: string }[];
  /** The latest model sessions of the run and what each said, reasoned and ran: the cockpit's Minds view. */
  minds: MindView[];
  /** Every session still active, uncapped (`minds` is capped): who is live right now and what it last did. */
  activeSessions: ActiveSessionView[];
  /** Pending proposals and the latest decided ones; the rationale stays out. */
  proposals: ProposalView[];
}

/** A live model session with the structured record of its latest tool call and output (no prose beyond the tool line). */
export interface ActiveSessionView {
  sessionId: string;
  agentId: string;
  role: string;
  seat: string | null;
  contract: string | null;
  effort: string | null;
  task: string | null;
  startedAt: string;
  /** The latest `agent.output` of kind `tool` for this session: its `Tool: detail` line (sliced to 200 chars), when and at which seq. */
  lastTool: { text: string; at: string; seq: number } | null;
  /** The latest `agent.output` of any kind for this session: its kind, when and at which seq, without the text. */
  lastOutput: { kind: 'text' | 'thinking' | 'tool' | 'result'; at: string; seq: number } | null;
}

export interface ProposalView {
  id: string;
  kind: string;
  title: string;
  status: string;
  task: string | null;
}

export interface SeatView {
  id: string;
  agent: string;
  effort: string | null;
  area: string | null;
  /** "idle", or "working" / "working on TASK-101". */
  state: string;
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
  /** The seat or persona that made the call (sup-2, lead-1, backend-dev), when it had one. */
  seat: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  activity: { ts: string; kind: 'text' | 'thinking' | 'tool' | 'result'; text: string }[];
}

/** Sessions shown in the Minds view, and how much of each one's stream. */
const MIND_SESSIONS = 8;
const MIND_ACTIVITY = 80;
const MIND_TEXT = 6000;
/** All Minds text in one snapshot, kept well under the 4 MiB a plugin may read: the longest entries give way first. */
const MIND_BUDGET = 1_500_000;
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
  const started = new Map<string, { contract?: string; effort?: string | null; seat?: string | null }>();
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
  const views = chosen.map((s) => ({
    sessionId: s.id, agentId: s.agentId, role: s.role, task: s.taskId ? keyOf(s.taskId) : null,
    contract: started.get(s.id)?.contract ?? null, effort: started.get(s.id)?.effort ?? null, seat: started.get(s.id)?.seat ?? null,
    status: s.status, startedAt: s.startedAt, endedAt: s.endedAt,
    activity: byId.get(s.id)!.slice(-limits.activity),
  }));
  // Over budget: cap every entry lower until the whole fits.
  const all = views.flatMap((v) => v.activity);
  for (let cap = Math.floor(limits.text / 2); all.reduce((n, a) => n + a.text.length, 0) > MIND_BUDGET && cap >= 200; cap = Math.floor(cap / 2)) {
    for (const a of all) if (a.text.length > cap) a.text = `${a.text.slice(0, cap)}…`;
  }
  return views;
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
  // Read before anything is projected (all synchronous): an observer resuming at lastSeq misses no event the projection lacks.
  const lastSeq = store.lastSeq();
  const runs = store.runs(10);
  const visible = runs.filter((r, i) => i < 3 || !['completed', 'rejected', 'failed'].includes(r.status));
  return {
    lastSeq,
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
  const ectx = { store, config } as EngineContext;
  const council = councilOf(ectx, run.id);
  const leadSeats = leadsOf(ectx, run.id);
  const roles = { supervisor: council[0]!.agent, lead: leadSeats[0]!.agent };
  const repos = (meta.repoIds ?? []).map((id) => store.repository(id)!).filter(Boolean);
  const sessions = store.sessions(run.id).filter((s) => s.status === 'active');
  const roleState = (agentId: string, role: string) => {
    const s = sessions.find((x) => x.agentId === agentId && x.role === role);
    return s ? `working${s.taskId ? ` on ${keyOf(s.taskId)}` : ''}` : 'idle';
  };
  const events = store.events({ runId: run.id, limit: 100_000 });
  // Which seat each session sat in (calls name it on agent.started).
  const seatOf = new Map<string, string>();
  for (const e of events) {
    const d = e.data as { sessionId?: string; seat?: string | null };
    if (e.type === 'agent.started' && d.seat && d.sessionId) seatOf.set(d.sessionId, d.seat);
  }
  const seatState = (id: string) => {
    const s = sessions.find((x) => seatOf.get(x.id) === id);
    return s ? `working${s.taskId ? ` on ${keyOf(s.taskId)}` : ''}` : 'idle';
  };
  const seatView = (s: { id: string; agent: string; effort: string | null; area?: string | null }): SeatView => ({ id: s.id, agent: s.agent, effort: s.effort, area: s.area ?? null, state: seatState(s.id) });
  const taskCtx = new Map(tasks.map((t) => [t.id, store.taskContext<TaskContext>(t.id)]));
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
    council: council.map(seatView),
    leads: leadSeats.map(seatView),
    team: (meta.team ?? []).map((p) => {
      const mine = tasks.filter((t) => taskCtx.get(t.id)?.persona === p.id);
      const busy = sessions.filter((x) => seatOf.get(x.id) === p.id).map((x) => keyOf(x.taskId));
      return { ...p, tasks: mine.map((t) => t.key), state: busy.length ? `working on ${busy.join(', ')}` : 'idle' };
    }),
    repositories: repos.map((r) => ({
      name: r.name, path: r.path, baseBranch: r.baseBranch,
      integration: meta.integration?.[r.id] ? { branch: meta.integration[r.id]!.branch, passed: meta.integration[r.id]!.passed } : null,
    })),
    tasks: tasks.map((t) => ({
      id: t.id, worktree: t.worktreePath,
      key: t.key, title: t.title, status: t.status, agentId: t.agentId, repo: repos.find((r) => r.id === t.repoId)?.name ?? t.repoId,
      iteration: t.iteration, branch: t.branch, dependsOn: deps.filter((d) => d.taskId === t.id).map((d) => keyOf(d.dependsOn)), blockedReason: t.blockedReason,
      detail: taskDetail(store, t),
      specialty: t.specialty,
      live: live?.(t.id) ?? null,
      persona: taskCtx.get(t.id)?.persona ?? null,
      lead: taskCtx.get(t.id)?.lead ?? null,
    })),
    workers: sessions.filter((s) => s.role === 'worker').map((s) => ({ agentId: s.agentId, role: s.role, task: s.taskId ? keyOf(s.taskId) : null, since: s.startedAt })),
    conflicts,
    tests,
    telemetry: {
      calls: usage.reduce((a, u) => a + u.calls, 0),
      inputTokens: usage.reduce((a, u) => a + u.inputTokens, 0),
      outputTokens: usage.reduce((a, u) => a + u.outputTokens, 0),
      costUsd: usage.reduce((a, u) => a + u.costUsd, 0),
      byAgent: usage.map((u) => ({ agentId: u.agentId, calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd })),
    },
    recentEvents: events.slice(-RECENT_EVENTS).map((e) => ({ ts: e.ts, type: e.type, text: describe(e, keyOf), detail: detailOf(e, keyOf) })),
    minds: minds(store.sessions(run.id), events, keyOf),
    activeSessions: activeSessions(sessions, events, keyOf),
    proposals: proposalViews(store.proposals(run.id), keyOf),
  };
}

/** Decided proposals kept in a snapshot besides the pending ones. */
const DECIDED_PROPOSALS = 10;
/** The longest `Tool: detail` line an active session carries. */
const TOOL_TEXT = 200;

/**
 * Every active session (uncapped) with the structured record of its latest tool call and latest output.
 * Only events that name their session and their kind count: nothing here is guessed from prose.
 */
function activeSessions(active: AgentSessionRecord[], events: CockpitEvent[], keyOf: (id: unknown) => string): ActiveSessionView[] {
  const started = new Map<string, { contract?: string; effort?: string | null; seat?: string | null }>();
  const lastTool = new Map<string, ActiveSessionView['lastTool']>();
  const lastOutput = new Map<string, ActiveSessionView['lastOutput']>();
  for (const e of events) {
    if (e.type === 'agent.started') {
      const d = e.data as { sessionId?: string };
      if (d.sessionId) started.set(d.sessionId, e.data as never);
    } else if (e.type === 'agent.output') {
      const d = e.data as { text?: string; kind?: 'text' | 'thinking' | 'tool' | 'result'; sessionId?: string };
      if (!d.sessionId || !d.kind) continue;
      lastOutput.set(d.sessionId, { kind: d.kind, at: e.ts, seq: e.seq });
      if (d.kind === 'tool') lastTool.set(d.sessionId, { text: String(d.text ?? '').slice(0, TOOL_TEXT), at: e.ts, seq: e.seq });
    }
  }
  return active.map((s) => ({
    sessionId: s.id, agentId: s.agentId, role: s.role,
    seat: started.get(s.id)?.seat ?? null, contract: started.get(s.id)?.contract ?? null, effort: started.get(s.id)?.effort ?? null,
    task: s.taskId ? keyOf(s.taskId) : null, startedAt: s.startedAt,
    lastTool: lastTool.get(s.id) ?? null, lastOutput: lastOutput.get(s.id) ?? null,
  }));
}

/** Everything still waiting on a decision, plus the latest decided ones, in the order they were made; no rationale. */
function proposalViews(all: Proposal[], keyOf: (id: unknown) => string): ProposalView[] {
  const decided = (p: Proposal) => p.status === 'accepted' || p.status === 'accepted_with_changes' || p.status === 'rejected';
  const recent = new Set(all.filter(decided).slice(-DECIDED_PROPOSALS).map((p) => p.id));
  return all
    .filter((p) => !decided(p) || recent.has(p.id))
    .map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, task: p.taskId ? keyOf(p.taskId) : null }));
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
