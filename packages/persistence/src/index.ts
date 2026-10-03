import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  newId,
  nowIso,
  type AgentSessionRecord,
  type Approval,
  type ApprovalStatus,
  type CockpitEvent,
  type Decision,
  type EventType,
  type FileLease,
  type ModelUsage,
  type NewEvent,
  type Project,
  type Proposal,
  type ProposalStatus,
  type Repository,
  type ReviewRecord,
  type Run,
  type Task,
  type TaskDependency,
  type WorktreeRecord,
} from '@cockpit/core';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE repositories (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, path TEXT NOT NULL,
    base_branch TEXT NOT NULL, test_command TEXT, protected_branches TEXT NOT NULL DEFAULT '[]',
    UNIQUE(project_id, name)
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request TEXT NOT NULL, status TEXT NOT NULL,
    architecture TEXT, report TEXT, feedback TEXT NOT NULL DEFAULT '[]', round INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL, kind TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES repositories(id), specialty TEXT NOT NULL,
    risk TEXT NOT NULL, complexity TEXT NOT NULL, scope TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
    tests_required INTEGER NOT NULL, test_command TEXT, status TEXT NOT NULL, agent_id TEXT, iteration INTEGER NOT NULL DEFAULT 0,
    branch TEXT, worktree_path TEXT, summary TEXT, blocked_reason TEXT, round INTEGER NOT NULL DEFAULT 0,
    context TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(run_id, key)
  );
  CREATE TABLE dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on));
  CREATE TABLE agents (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, model TEXT, roles TEXT NOT NULL, profile TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, agent_id TEXT NOT NULL, role TEXT NOT NULL, external_id TEXT,
    status TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, repo_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
    base_commit TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE file_leases (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, repo_id TEXT NOT NULL, pattern TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, acquired_at TEXT NOT NULL
  );
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, iteration INTEGER NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL,
    issues TEXT NOT NULL, validation TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL,
    suggestion TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, proposal_id TEXT, decided_by TEXT NOT NULL, outcome TEXT NOT NULL,
    rationale TEXT NOT NULL, changes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, operation TEXT, summary TEXT NOT NULL, details TEXT NOT NULL,
    status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT, type TEXT NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, agent_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, cost_usd REAL,
    duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_run ON tasks(run_id);
  CREATE INDEX idx_events_run ON events(run_id, seq);
  CREATE INDEX idx_leases_active ON file_leases(status, repo_id);
  CREATE INDEX idx_approvals_status ON approvals(status);
  `,
];

type Row = Record<string, SQLInputValue>;

const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : fallback);

/**
 * SQLite-backed store: the authoritative workflow state. Synchronous (node:sqlite),
 * which keeps state transitions atomic within the single orchestrator process.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      });
      version++;
    }
  }

  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  // ---------- projects / repositories ----------

  ensureProject(name: string): Project {
    const existing = this.get('SELECT * FROM projects WHERE name = ?', name);
    if (existing) return { id: String(existing.id), name: String(existing.name), createdAt: String(existing.created_at) };
    const p: Project = { id: newId('prj'), name, createdAt: nowIso() };
    this.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', p.id, p.name, p.createdAt);
    return p;
  }

  upsertRepository(r: Omit<Repository, 'id'> & { id?: string }): Repository {
    const existing = this.get('SELECT id FROM repositories WHERE project_id = ? AND name = ?', r.projectId, r.name);
    const id = existing ? String(existing.id) : (r.id ?? newId('repo'));
    this.run(
      `INSERT INTO repositories (id, project_id, name, path, base_branch, test_command, protected_branches) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, base_branch = excluded.base_branch, test_command = excluded.test_command, protected_branches = excluded.protected_branches`,
      id, r.projectId, r.name, r.path, r.baseBranch, r.testCommand, json(r.protectedBranches),
    );
    return this.repository(id)!;
  }

  repository(id: string): Repository | undefined {
    const r = this.get('SELECT * FROM repositories WHERE id = ?', id);
    return r && toRepository(r);
  }

  repositories(projectId: string): Repository[] {
    return this.all('SELECT * FROM repositories WHERE project_id = ? ORDER BY name', projectId).map(toRepository);
  }

  // ---------- runs ----------

  createRun(projectId: string, request: string): Run {
    const ts = nowIso();
    const id = newId('run');
    this.run('INSERT INTO runs (id, project_id, request, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, projectId, request, 'created', ts, ts);
    return this.runById(id)!;
  }

  runById(id: string): Run | undefined {
    const r = this.get('SELECT * FROM runs WHERE id = ?', id);
    return r && toRun(r);
  }

  runs(limit = 50): Run[] {
    return this.all('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?', limit).map(toRun);
  }

  activeRuns(): Run[] {
    return this.all(`SELECT * FROM runs WHERE status NOT IN ('completed','rejected','failed') ORDER BY created_at`).map(toRun);
  }

  updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'architecture' | 'report' | 'feedback' | 'round' | 'error'>>): Run {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    const map: Record<string, [string, (v: unknown) => SQLInputValue]> = {
      status: ['status', (v) => v as string],
      architecture: ['architecture', json],
      report: ['report', (v) => (v as string | null) ?? null],
      feedback: ['feedback', json],
      round: ['round', (v) => v as number],
      error: ['error', (v) => (v as string | null) ?? null],
    };
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v));
    }
    sets.push('updated_at = ?');
    vals.push(nowIso());
    this.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    return this.runById(id)!;
  }

  runMeta<T extends Record<string, unknown>>(id: string): T {
    return parse<T>(this.get('SELECT meta FROM runs WHERE id = ?', id)?.meta, {} as T);
  }

  setRunMeta(id: string, patch: Record<string, unknown>): void {
    this.run('UPDATE runs SET meta = ?, updated_at = ? WHERE id = ?', json({ ...this.runMeta(id), ...patch }), nowIso(), id);
  }

  // ---------- tasks ----------

  insertTask(t: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Task {
    const ts = nowIso();
    const id = t.id ?? newId('task');
    this.run(
      `INSERT INTO tasks (id, run_id, key, title, description, kind, repo_id, specialty, risk, complexity, scope, acceptance_criteria,
        tests_required, test_command, status, agent_id, iteration, branch, worktree_path, summary, blocked_reason, round, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, t.runId, t.key, t.title, t.description, t.kind, t.repoId, t.specialty, t.risk, t.complexity, json(t.scope),
      json(t.acceptanceCriteria), t.testsRequired ? 1 : 0, t.testCommand, t.status, t.agentId, t.iteration, t.branch,
      t.worktreePath, t.summary, t.blockedReason, t.round, ts, ts,
    );
    return this.task(id)!;
  }

  task(id: string): Task | undefined {
    const r = this.get('SELECT * FROM tasks WHERE id = ?', id);
    return r && toTask(r);
  }

  tasks(runId: string): Task[] {
    return this.all('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, key', runId).map(toTask);
  }

  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'runId' | 'createdAt' | 'updatedAt'>>): Task {
    const cols: Record<string, [string, (v: unknown) => SQLInputValue]> = {
      status: ['status', (v) => v as string],
      agentId: ['agent_id', (v) => (v as string | null) ?? null],
      iteration: ['iteration', (v) => v as number],
      branch: ['branch', (v) => (v as string | null) ?? null],
      worktreePath: ['worktree_path', (v) => (v as string | null) ?? null],
      summary: ['summary', (v) => (v as string | null) ?? null],
      blockedReason: ['blocked_reason', (v) => (v as string | null) ?? null],
      scope: ['scope', json],
      description: ['description', (v) => v as string],
      round: ['round', (v) => v as number],
      testCommand: ['test_command', (v) => (v as string | null) ?? null],
    };
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = cols[k];
      if (!c) throw new Error(`updateTask: unsupported field ${k}`);
      sets.push(`${c[0]} = ?`);
      vals.push(c[1](v));
    }
    sets.push('updated_at = ?');
    vals.push(nowIso());
    this.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    return this.task(id)!;
  }

  /** Free-form per-task context the engine must not lose across restarts (pending answers, review feedback). */
  taskContext<T extends Record<string, unknown>>(id: string): T {
    return parse<T>(this.get('SELECT context FROM tasks WHERE id = ?', id)?.context, {} as T);
  }

  setTaskContext(id: string, patch: Record<string, unknown>): void {
    this.run('UPDATE tasks SET context = ? WHERE id = ?', json({ ...this.taskContext(id), ...patch }), id);
  }

  addDependency(taskId: string, dependsOn: string): void {
    this.run('INSERT OR IGNORE INTO dependencies (task_id, depends_on) VALUES (?, ?)', taskId, dependsOn);
  }

  dependencies(runId: string): TaskDependency[] {
    return this.all(
      'SELECT d.task_id, d.depends_on FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.run_id = ?',
      runId,
    ).map((r) => ({ taskId: String(r.task_id), dependsOn: String(r.depends_on) }));
  }

  // ---------- agents / sessions ----------

  upsertAgent(a: { id: string; adapter: string; model: string | null; roles: string[]; profile: unknown }): void {
    this.run(
      `INSERT INTO agents (id, adapter, model, roles, profile, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET adapter = excluded.adapter, model = excluded.model, roles = excluded.roles, profile = excluded.profile, updated_at = excluded.updated_at`,
      a.id, a.adapter, a.model, json(a.roles), json(a.profile), nowIso(),
    );
  }

  insertSession(s: Omit<AgentSessionRecord, 'id' | 'startedAt' | 'endedAt'>): AgentSessionRecord {
    const rec: AgentSessionRecord = { ...s, id: newId('ses'), startedAt: nowIso(), endedAt: null };
    this.run(
      'INSERT INTO agent_sessions (id, run_id, task_id, agent_id, role, external_id, status, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.taskId, rec.agentId, rec.role, rec.externalId, rec.status, rec.cwd, rec.startedAt,
    );
    return rec;
  }

  updateSession(id: string, patch: { externalId?: string | null; status?: AgentSessionRecord['status'] }): void {
    if (patch.externalId !== undefined) this.run('UPDATE agent_sessions SET external_id = ? WHERE id = ?', patch.externalId, id);
    if (patch.status) {
      const ended = patch.status === 'active' ? null : nowIso();
      this.run('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?', patch.status, ended, id);
    }
  }

  sessions(runId: string): AgentSessionRecord[] {
    return this.all('SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY started_at', runId).map(toSession);
  }

  /** Latest session with an external id for a task + agent: used to resume a worker. */
  latestTaskSession(taskId: string, agentId: string): AgentSessionRecord | undefined {
    const r = this.get(
      'SELECT * FROM agent_sessions WHERE task_id = ? AND agent_id = ? AND external_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      taskId, agentId,
    );
    return r && toSession(r);
  }

  failActiveSessions(): number {
    const res = this.db.prepare(`UPDATE agent_sessions SET status = 'failed', ended_at = ? WHERE status = 'active'`).run(nowIso());
    return Number(res.changes);
  }

  // ---------- worktrees ----------

  insertWorktree(w: Omit<WorktreeRecord, 'id'>): WorktreeRecord {
    const rec = { ...w, id: newId('wt') };
    this.run(
      'INSERT INTO worktrees (id, run_id, task_id, repo_id, path, branch, base_commit, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.taskId, rec.repoId, rec.path, rec.branch, rec.baseCommit, rec.status,
    );
    return rec;
  }

  worktrees(runId: string): WorktreeRecord[] {
    return this.all('SELECT * FROM worktrees WHERE run_id = ?', runId).map((r) => ({
      id: String(r.id), runId: String(r.run_id), taskId: (r.task_id as string) ?? null, repoId: String(r.repo_id),
      path: String(r.path), branch: String(r.branch), baseCommit: String(r.base_commit), status: r.status as WorktreeRecord['status'],
    }));
  }

  setWorktreeStatus(id: string, status: WorktreeRecord['status']): void {
    this.run('UPDATE worktrees SET status = ? WHERE id = ?', status, id);
  }

  // ---------- leases ----------

  insertLease(l: Omit<FileLease, 'id' | 'acquiredAt' | 'status'>): FileLease {
    const rec: FileLease = { ...l, id: newId('lease'), status: 'active', acquiredAt: nowIso() };
    this.run(
      'INSERT INTO file_leases (id, run_id, task_id, repo_id, pattern, kind, status, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.taskId, rec.repoId, rec.pattern, rec.kind, rec.status, rec.acquiredAt,
    );
    return rec;
  }

  activeLeases(): FileLease[] {
    return this.all(`SELECT * FROM file_leases WHERE status = 'active'`).map(toLease);
  }

  taskLeases(taskId: string): FileLease[] {
    return this.all(`SELECT * FROM file_leases WHERE task_id = ? AND status = 'active'`, taskId).map(toLease);
  }

  releaseLeases(taskId: string): number {
    return Number(this.db.prepare(`UPDATE file_leases SET status = 'released' WHERE task_id = ? AND status = 'active'`).run(taskId).changes);
  }

  transferLease(leaseId: string, toTaskId: string): void {
    this.run('UPDATE file_leases SET task_id = ? WHERE id = ?', toTaskId, leaseId);
  }

  // ---------- reviews / proposals / decisions ----------

  insertReview(r: Omit<ReviewRecord, 'id' | 'createdAt'>): ReviewRecord {
    const rec: ReviewRecord = { ...r, id: newId('rev'), createdAt: nowIso() };
    this.run(
      'INSERT INTO reviews (id, task_id, iteration, verdict, summary, issues, validation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.taskId, rec.iteration, rec.verdict, rec.summary, json(rec.issues), json(rec.validation), rec.createdAt,
    );
    return rec;
  }

  reviews(taskId: string): ReviewRecord[] {
    return this.all('SELECT * FROM reviews WHERE task_id = ? ORDER BY iteration, created_at', taskId).map((r) => ({
      id: String(r.id), taskId: String(r.task_id), iteration: Number(r.iteration), verdict: r.verdict as ReviewRecord['verdict'],
      summary: String(r.summary), issues: parse(r.issues, []), validation: parse(r.validation, null), createdAt: String(r.created_at),
    }));
  }

  insertProposal(p: Omit<Proposal, 'id' | 'createdAt' | 'status'>): Proposal {
    const rec: Proposal = { ...p, id: newId('prop'), status: 'open', createdAt: nowIso() };
    this.run(
      'INSERT INTO proposals (id, run_id, task_id, kind, title, rationale, suggestion, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.taskId, rec.kind, rec.title, rec.rationale, rec.suggestion, rec.status, rec.createdAt,
    );
    return rec;
  }

  proposals(runId: string, status?: ProposalStatus): Proposal[] {
    const rows = status
      ? this.all('SELECT * FROM proposals WHERE run_id = ? AND status = ? ORDER BY created_at', runId, status)
      : this.all('SELECT * FROM proposals WHERE run_id = ? ORDER BY created_at', runId);
    return rows.map((r) => ({
      id: String(r.id), runId: String(r.run_id), taskId: (r.task_id as string) ?? null, kind: r.kind as Proposal['kind'],
      title: String(r.title), rationale: String(r.rationale), suggestion: String(r.suggestion), status: r.status as ProposalStatus,
      createdAt: String(r.created_at),
    }));
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    this.run('UPDATE proposals SET status = ? WHERE id = ?', status, id);
  }

  insertDecision(d: Omit<Decision, 'id' | 'createdAt'>): Decision {
    const rec: Decision = { ...d, id: newId('dec'), createdAt: nowIso() };
    this.run(
      'INSERT INTO decisions (id, run_id, proposal_id, decided_by, outcome, rationale, changes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.proposalId, rec.decidedBy, rec.outcome, rec.rationale, rec.changes, rec.createdAt,
    );
    return rec;
  }

  decisions(runId: string): Decision[] {
    return this.all('SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at', runId).map((r) => ({
      id: String(r.id), runId: String(r.run_id), proposalId: (r.proposal_id as string) ?? null, decidedBy: r.decided_by as Decision['decidedBy'],
      outcome: r.outcome as Decision['outcome'], rationale: String(r.rationale), changes: (r.changes as string) ?? null, createdAt: String(r.created_at),
    }));
  }

  // ---------- approvals ----------

  insertApproval(a: Omit<Approval, 'id' | 'createdAt' | 'resolvedAt' | 'status' | 'response'>): Approval {
    const rec: Approval = { ...a, id: newId('apr'), status: 'pending', response: null, createdAt: nowIso(), resolvedAt: null };
    this.run(
      'INSERT INTO approvals (id, run_id, kind, operation, summary, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.runId, rec.kind, rec.operation, rec.summary, json(rec.details), rec.status, rec.createdAt,
    );
    return rec;
  }

  approval(id: string): Approval | undefined {
    const r = this.get('SELECT * FROM approvals WHERE id = ?', id);
    return r && toApproval(r);
  }

  approvals(filter: { runId?: string; status?: ApprovalStatus } = {}): Approval[] {
    const where: string[] = [];
    const vals: SQLInputValue[] = [];
    if (filter.runId) (where.push('run_id = ?'), vals.push(filter.runId));
    if (filter.status) (where.push('status = ?'), vals.push(filter.status));
    const sql = `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
    return this.all(sql, ...vals).map(toApproval);
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, 'pending'>, response: string | null): Approval {
    this.run(`UPDATE approvals SET status = ?, response = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`, status, response, nowIso(), id);
    return this.approval(id)!;
  }

  // ---------- events ----------

  appendEvent<T extends EventType>(e: NewEvent<T>): CockpitEvent<T> {
    const id = newId('evt');
    const ts = nowIso();
    const res = this.db
      .prepare('INSERT INTO events (id, run_id, type, ts, data) VALUES (?, ?, ?, ?, ?)')
      .run(id, e.runId, e.type, ts, json(e.data));
    return { seq: Number(res.lastInsertRowid), id, ts, runId: e.runId, type: e.type, data: e.data };
  }

  events(filter: { runId?: string; since?: number; limit?: number } = {}): CockpitEvent[] {
    const where = ['seq > ?'];
    const vals: SQLInputValue[] = [filter.since ?? 0];
    if (filter.runId) (where.push('run_id = ?'), vals.push(filter.runId));
    return this.all(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`, ...vals, filter.limit ?? 1000).map((r) => ({
      seq: Number(r.seq), id: String(r.id), runId: (r.run_id as string) ?? null, type: r.type as EventType, ts: String(r.ts), data: parse(r.data, {}),
    })) as CockpitEvent[];
  }

  // ---------- usage ----------

  insertUsage(u: Omit<ModelUsage, 'id' | 'createdAt'>): ModelUsage {
    const rec: ModelUsage = { ...u, id: newId('use'), createdAt: nowIso() };
    this.run(
      `INSERT INTO model_usage (id, run_id, task_id, agent_id, role, model, input_tokens, output_tokens, cached_tokens, cost_usd, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.runId, rec.taskId, rec.agentId, rec.role, rec.model, rec.inputTokens, rec.outputTokens, rec.cachedTokens, rec.costUsd, rec.durationMs, rec.createdAt,
    );
    return rec;
  }

  /** Every recorded model call of a run, oldest first. */
  usage(runId: string): ModelUsage[] {
    return this.all(`SELECT * FROM model_usage WHERE run_id = ? ORDER BY created_at`, runId).map((r) => ({
      id: String(r.id), runId: String(r.run_id), taskId: (r.task_id as string) ?? null, agentId: String(r.agent_id), role: r.role as ModelUsage['role'],
      model: String(r.model), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), cachedTokens: Number(r.cached_tokens ?? 0),
      costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd), durationMs: Number(r.duration_ms ?? 0), createdAt: String(r.created_at),
    }));
  }

  usageSummary(runId: string): { agentId: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[] {
    return this.all(
      `SELECT agent_id, model, COUNT(*) calls, SUM(input_tokens) i, SUM(output_tokens) o, COALESCE(SUM(cost_usd), 0) c
       FROM model_usage WHERE run_id = ? GROUP BY agent_id, model ORDER BY agent_id`,
      runId,
    ).map((r) => ({ agentId: String(r.agent_id), model: String(r.model), calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o), costUsd: Number(r.c) }));
  }
}

function toRepository(r: Row): Repository {
  return {
    id: String(r.id), projectId: String(r.project_id), name: String(r.name), path: String(r.path), baseBranch: String(r.base_branch),
    testCommand: (r.test_command as string) ?? null, protectedBranches: parse(r.protected_branches, []),
  };
}

function toRun(r: Row): Run {
  return {
    id: String(r.id), projectId: String(r.project_id), request: String(r.request), status: r.status as Run['status'],
    architecture: parse(r.architecture, null), report: (r.report as string) ?? null, feedback: parse(r.feedback, []),
    round: Number(r.round), error: (r.error as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: String(r.id), runId: String(r.run_id), key: String(r.key), title: String(r.title), description: String(r.description),
    kind: r.kind as Task['kind'], repoId: String(r.repo_id), specialty: r.specialty as Task['specialty'], risk: r.risk as Task['risk'],
    complexity: r.complexity as Task['complexity'], scope: parse(r.scope, { files: [], modules: [], resources: [] }),
    acceptanceCriteria: parse(r.acceptance_criteria, []), testsRequired: Number(r.tests_required) === 1,
    testCommand: (r.test_command as string) ?? null, status: r.status as Task['status'], agentId: (r.agent_id as string) ?? null,
    iteration: Number(r.iteration), branch: (r.branch as string) ?? null, worktreePath: (r.worktree_path as string) ?? null,
    summary: (r.summary as string) ?? null, blockedReason: (r.blocked_reason as string) ?? null, round: Number(r.round),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function toSession(r: Row): AgentSessionRecord {
  return {
    id: String(r.id), runId: String(r.run_id), taskId: (r.task_id as string) ?? null, agentId: String(r.agent_id), role: r.role as AgentSessionRecord['role'],
    externalId: (r.external_id as string) ?? null, status: r.status as AgentSessionRecord['status'], cwd: String(r.cwd),
    startedAt: String(r.started_at), endedAt: (r.ended_at as string) ?? null,
  };
}

function toLease(r: Row): FileLease {
  return {
    id: String(r.id), runId: String(r.run_id), taskId: String(r.task_id), repoId: String(r.repo_id), pattern: String(r.pattern),
    kind: r.kind as FileLease['kind'], status: r.status as FileLease['status'], acquiredAt: String(r.acquired_at),
  };
}

function toApproval(r: Row): Approval {
  return {
    id: String(r.id), runId: String(r.run_id), kind: r.kind as Approval['kind'], operation: (r.operation as Approval['operation']) ?? null,
    summary: String(r.summary), details: parse(r.details, null), status: r.status as ApprovalStatus, response: (r.response as string) ?? null,
    createdAt: String(r.created_at), resolvedAt: (r.resolved_at as string) ?? null,
  };
}
