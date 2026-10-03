import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  assertRunTransition,
  ConflictGraph,
  errorMessage,
  isTerminalRun,
  TaskGraph,
  ACTIVE_TASK_STATUSES,
  type Approval,
  type LeadPlan,
  type Repository,
  type Run,
  type RunStatus,
  type SupervisorValidation,
  type Task,
} from '@cockpit/core';
import {
  architecturePrompt,
  leadArchitectureReviewPrompt,
  leadIntegrationPrompt,
  leadPlanPrompt,
  supervisorRevisionPrompt,
  supervisorValidationPrompt,
} from '@cockpit/agents';
import { gitOps, runShell } from '@cockpit/workspace';
import type { Span } from '@cockpit/telemetry';
import { arch, runRepos, setTaskStatus, type EngineContext, type RunMeta, type TaskContext } from './context';
import { decideProposals } from './proposals';
import { buildReport } from './report';
import { readConflictMarkers, TaskPipeline } from './task-pipeline';

export interface RepoInput {
  path: string;
  name?: string;
  baseBranch?: string;
  testCommand?: string | null;
}

export interface StartRunInput {
  request: string;
  project?: string;
  repos: RepoInput[];
}

export type HumanDecision = 'approve' | 'reject' | 'request_changes';

/**
 * The workflow engine. Agents reason; this coordinates. Each run is driven by a
 * loop over its persisted status, so any process restart resumes it from the database.
 */
export class Orchestrator {
  private readonly drivers = new Map<string, Promise<void>>();
  private readonly wakers = new Map<string, () => void>();
  private readonly approvalSpans = new Map<string, Span>();
  readonly pipeline: TaskPipeline;
  private stopping = false;

  constructor(readonly ctx: EngineContext) {
    this.pipeline = new TaskPipeline(ctx, () => {}, () => this.stopping);
    for (const a of ctx.config.agents.agents) ctx.store.upsertAgent({ id: a.id, adapter: a.adapter, model: a.model, roles: a.roles, profile: a });
  }

  // ---------- public API ----------

  async startRun(input: StartRunInput): Promise<Run> {
    const { store, bus } = this.ctx;
    if (!input.request.trim()) throw new Error('request is empty');
    if (!input.repos.length) throw new Error('at least one repository is required');
    const repos: Repository[] = [];
    const resolved: RepoInput[] = [];
    for (const r of input.repos) {
      const path = resolve(r.path);
      if (!existsSync(path) || !(await gitOps.isGitRepo(path))) throw new Error(`${path} is not a git repository`);
      const head = await gitOps.git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
      if (head.code !== 0) throw new Error(`${path} has no commits yet; commit something first`);
      resolved.push({ ...r, path });
    }
    const project = store.ensureProject(input.project ?? basename(resolved[0]!.path));
    for (const r of resolved) {
      const baseBranch = r.baseBranch ?? (await gitOps.currentBranch(r.path)) ?? 'main';
      repos.push(
        store.upsertRepository({
          projectId: project.id,
          name: r.name ?? basename(r.path),
          path: r.path,
          baseBranch,
          testCommand: r.testCommand ?? null,
          protectedBranches: [],
        }),
      );
    }
    const run = store.createRun(project.id, input.request);
    store.setRunMeta(run.id, { repoIds: repos.map((r) => r.id) } satisfies RunMeta);
    bus.emit('run.started', run.id, { request: input.request, repositories: repos.map((r) => r.name) });
    this.drive(run.id);
    return run;
  }

  /** Resume every non-terminal run after a restart. */
  recover(): string[] {
    const failed = this.ctx.store.failActiveSessions();
    const runs = this.ctx.store.activeRuns();
    for (const r of runs) this.drive(r.id);
    if (failed) this.ctx.bus.emit('agent.failed', null, { agentId: 'orchestrator', error: `${failed} agent session(s) interrupted by restart; resuming` });
    return runs.map((r) => r.id);
  }

  drive(runId: string): Promise<void> {
    const existing = this.drivers.get(runId);
    if (existing) {
      this.wake(runId);
      return existing;
    }
    const p = this.loop(runId).finally(() => this.drivers.delete(runId));
    this.drivers.set(runId, p);
    return p;
  }

  /** Resolves when the run's driver stops (waiting for a human or terminal). */
  async settled(runId: string): Promise<Run> {
    while (this.drivers.has(runId)) await this.drivers.get(runId);
    return this.ctx.store.runById(runId)!;
  }

  wake(runId: string): void {
    this.wakers.get(runId)?.();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const r of this.drivers.keys()) {
      this.ctx.runner.cancelRun(r);
      this.wake(r);
    }
    await Promise.allSettled([...this.drivers.values()]);
  }

  /** Retry a failed run from the phase it failed in. */
  retry(runId: string): void {
    const run = this.ctx.store.runById(runId);
    if (!run || run.status !== 'failed') throw new Error('only failed runs can be retried');
    const meta = this.ctx.store.runMeta<RunMeta>(runId);
    const from = (meta.failedFrom as RunStatus) ?? 'planning';
    this.ctx.store.updateRun(runId, { status: from, error: null });
    for (const t of this.ctx.store.tasks(runId)) {
      if (t.status === 'failed') this.ctx.store.updateTask(t.id, { status: t.worktreePath ? 'running' : 'ready', blockedReason: null });
    }
    this.ctx.bus.emit('run.status_changed', runId, { from: 'failed', to: from });
    this.drive(runId);
  }

  /** Human answer to any pending approval (final result, high-risk operation, or decision). */
  resolveApproval(approvalId: string, decision: HumanDecision, response: string | null = null): Approval {
    const { store, bus } = this.ctx;
    const approval = store.approval(approvalId);
    if (!approval) throw new Error(`unknown approval ${approvalId}`);
    if (approval.status !== 'pending') throw new Error(`approval ${approvalId} is already ${approval.status}`);
    if (decision === 'request_changes' && approval.kind !== 'final') throw new Error('request_changes applies only to the final result');
    if (decision === 'request_changes' && !response?.trim()) throw new Error('request_changes needs a description of the changes');
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    const resolved = store.resolveApproval(approvalId, status, response);
    this.approvalSpans.get(approvalId)?.setAttribute('cockpit.approval_status', status);
    this.approvalSpans.get(approvalId)?.end();
    this.approvalSpans.delete(approvalId);
    if (decision === 'approve') bus.emit('approval.accepted', approval.runId, { approvalId, response });
    else if (decision === 'reject') bus.emit('approval.rejected', approval.runId, { approvalId, response });
    else bus.emit('approval.changes_requested', approval.runId, { approvalId, response: response! });

    const run = store.runById(approval.runId)!;
    const details = (approval.details ?? {}) as { taskId?: string; proposalIds?: string[]; question?: string };
    if (approval.kind === 'final') {
      if (decision === 'approve') this.transition(run, 'merging');
      else if (decision === 'reject') {
        this.transition(run, 'rejected');
        bus.emit('run.completed', run.id, { outcome: 'rejected', reason: response ?? undefined });
        void this.cleanup(run.id, true);
      } else {
        store.updateRun(run.id, { feedback: [...run.feedback, response!] });
        store.setRunMeta(run.id, { pendingRevision: response } satisfies Partial<RunMeta>);
        this.transition(run, 'planning');
      }
    } else if (details.taskId) {
      this.pipeline.applyHumanAnswer(details.taskId, decision === 'approve', response);
      if (run.status === 'awaiting_human_decision') this.transition(run, 'executing');
    } else {
      // Escalated architectural decision.
      for (const pid of details.proposalIds ?? []) {
        store.insertDecision({
          runId: run.id, proposalId: pid, decidedBy: 'human', outcome: decision === 'approve' ? 'accept' : 'reject',
          rationale: response ?? (decision === 'approve' ? 'approved by human' : 'rejected by human'), changes: null,
        });
        store.setProposalStatus(pid, decision === 'approve' ? 'accepted' : 'rejected');
      }
      store.updateRun(run.id, { feedback: [...run.feedback, `Human decision on "${details.question ?? approval.summary}": ${decision}${response ? ` - ${response}` : ''}`] });
      if (run.status === 'awaiting_human_decision') this.transition(store.runById(run.id)!, 'planning');
    }
    this.drive(run.id);
    return resolved;
  }

  /** Convenience: resolve the pending final approval of a run. */
  decideRun(runId: string, decision: HumanDecision, response: string | null = null): Approval {
    const pending = this.ctx.store.approvals({ runId, status: 'pending' }).find((a) => a.kind === 'final');
    if (!pending) throw new Error(`run ${runId} has no pending final approval`);
    return this.resolveApproval(pending.id, decision, response);
  }

  // ---------- driver ----------

  private transition(run: Run, to: RunStatus): Run {
    assertRunTransition(run.status, to);
    const updated = this.ctx.store.updateRun(run.id, { status: to });
    this.ctx.bus.emit('run.status_changed', run.id, { from: run.status, to });
    return updated;
  }

  private async loop(runId: string): Promise<void> {
    const { store, bus, telemetry } = this.ctx;
    for (;;) {
      if (this.stopping) return;
      const run = store.runById(runId);
      if (!run || isTerminalRun(run.status)) return;
      try {
        const attrs = { 'cockpit.run_id': run.id, 'cockpit.round': run.round, 'cockpit.status': run.status };
        switch (run.status) {
          case 'created':
            this.transition(run, 'architecting');
            break;
          case 'architecting':
            await telemetry.span('phase.architecture', attrs, () => this.architecture(run));
            break;
          case 'proposing':
            await telemetry.span('phase.proposals', attrs, () => this.proposing(run));
            break;
          case 'deciding':
            await telemetry.span('phase.decisions', attrs, () => this.deciding(run));
            break;
          case 'planning':
            await telemetry.span('phase.planning', attrs, () => this.planning(run));
            break;
          case 'executing':
            if ((await this.executing(run)) === 'paused') return;
            break;
          case 'integrating':
            await telemetry.span('phase.integration', attrs, () => this.integrating(run));
            break;
          case 'validating':
            await telemetry.span('phase.validation', attrs, () => this.validating(run));
            break;
          case 'merging':
            await telemetry.span('phase.merge', attrs, () => this.merging(run));
            break;
          case 'awaiting_approval':
          case 'awaiting_human_decision':
            return;
        }
      } catch (err) {
        if (this.stopping) return;
        const fresh = store.runById(runId)!;
        const message = errorMessage(err);
        store.setRunMeta(runId, { failedFrom: fresh.status } satisfies Partial<RunMeta>);
        store.updateRun(runId, { status: 'failed', error: message });
        bus.emit('run.status_changed', runId, { from: fresh.status, to: 'failed' });
        bus.emit('run.completed', runId, { outcome: 'failed', reason: message });
        return;
      }
    }
  }

  private common(run: Run) {
    const repos = runRepos(this.ctx, run);
    return {
      repos,
      cwd: repos[0]!.path,
      additionalDirs: repos.slice(1).map((r) => r.path),
      timeoutMs: this.ctx.config.engine.agentTimeoutMs,
      supervisor: this.ctx.config.agents.hierarchy.supervisor,
      lead: this.ctx.config.agents.hierarchy.lead,
    };
  }

  // ---------- phases ----------

  private async architecture(run: Run): Promise<void> {
    const c = this.common(run);
    const res = await this.ctx.runner.call({
      runId: run.id, agentId: c.supervisor, role: 'supervisor', contract: 'ArchitectureOutput',
      prompt: architecturePrompt(run.request, c.repos, run.feedback),
      cwd: c.cwd, additionalDirs: c.additionalDirs, readOnly: true, timeoutMs: c.timeoutMs, spanName: 'opus.architecture',
    });
    this.ctx.store.updateRun(run.id, { architecture: res.output });
    this.ctx.store.setRunMeta(run.id, { decisionRound: 0 });
    this.ctx.bus.emit('architecture.defined', run.id, { summary: res.output.summary });
    this.transition(this.ctx.store.runById(run.id)!, 'proposing');
  }

  private async proposing(run: Run): Promise<void> {
    const { store, bus, runner } = this.ctx;
    const c = this.common(run);
    const prior = store
      .decisions(run.id)
      .map((d) => `- ${d.outcome}: ${d.rationale}${d.changes ? ` (${d.changes})` : ''}`)
      .join('\n');
    const res = await runner.call({
      runId: run.id, agentId: c.lead, role: 'lead', contract: 'LeadArchitectureReview',
      prompt: leadArchitectureReviewPrompt(run.request, arch(run)!, c.repos, prior || '(none)'),
      cwd: c.cwd, additionalDirs: c.additionalDirs, readOnly: true, timeoutMs: c.timeoutMs, spanName: 'codex.architecture_review',
    });
    store.setRunMeta(run.id, { assessment: res.output.assessment });
    if (!res.output.proposals.length) {
      this.transition(run, 'planning');
      return;
    }
    for (const p of res.output.proposals) {
      const rec = store.insertProposal({ runId: run.id, taskId: null, ...p });
      bus.emit('proposal.created', run.id, { proposalId: rec.id, kind: rec.kind, title: rec.title, taskId: null });
    }
    this.transition(run, 'deciding');
  }

  private async deciding(run: Run): Promise<void> {
    const { store, config } = this.ctx;
    const meta = store.runMeta<RunMeta>(run.id);
    const open = store.proposals(run.id, 'open');
    const outcome = await decideProposals(this.ctx, run, meta.assessment ?? '', open);
    const fresh = store.runById(run.id)!;
    if (outcome.humanApprovalId) {
      this.trackApproval(outcome.humanApprovalId, run.id);
      this.transition(fresh, 'awaiting_human_decision');
      return;
    }
    const round = meta.decisionRound ?? 0;
    if (outcome.requestAnalysis && round + 1 < config.engine.decisions.maxRounds) {
      store.setRunMeta(run.id, { decisionRound: round + 1 });
      this.transition(fresh, 'proposing');
      return;
    }
    this.transition(fresh, 'planning');
  }

  private async planning(run: Run): Promise<void> {
    const { store, bus, runner } = this.ctx;
    const c = this.common(run);
    const meta = store.runMeta<RunMeta>(run.id);
    const existing = store.tasks(run.id);
    let round = run.round;

    if (meta.pendingRevision) {
      // REQUEST CHANGES (or a validation revision) continues the managed run.
      const rev = await runner.call({
        runId: run.id, agentId: c.supervisor, role: 'supervisor', contract: 'SupervisorRevision',
        prompt: supervisorRevisionPrompt(arch(run), meta.pendingRevision),
        cwd: c.cwd, additionalDirs: c.additionalDirs, readOnly: true, timeoutMs: c.timeoutMs, spanName: 'opus.revision',
      });
      const a = arch(run);
      if (rev.output.architectureUpdate && a) store.updateRun(run.id, { architecture: { ...a, architecture: rev.output.architectureUpdate } });
      const fb = store.runById(run.id)!.feedback;
      round = run.round + 1;
      store.updateRun(run.id, { round, feedback: [...fb, `Supervisor guidance: ${rev.output.guidance}`] });
      store.setRunMeta(run.id, { pendingRevision: null });
    } else if (existing.length) {
      round = run.round + 1;
      store.updateRun(run.id, { round });
    }
    const current = store.runById(run.id)!;
    const decisions = store.decisions(run.id);
    const proposals = store.proposals(run.id);
    const decisionText = decisions.length
      ? decisions.map((d) => `- ${proposals.find((p) => p.id === d.proposalId)?.title ?? 'decision'}: ${d.outcome} by ${d.decidedBy} - ${d.rationale}`).join('\n')
      : '(none)';
    const feedback = round > 0 ? current.feedback : [];

    let lastError = '';
    let plan: LeadPlan | null = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const res = await runner.call({
        runId: run.id, agentId: c.lead, role: 'lead', contract: 'LeadPlan',
        prompt:
          leadPlanPrompt({ request: run.request, arch: arch(current)!, decisions: decisionText, repos: c.repos, existingTasks: existing, feedback, round }) +
          (lastError ? `\n\nYour previous plan was invalid: ${lastError}. Fix it.` : ''),
        cwd: c.cwd, additionalDirs: c.additionalDirs, readOnly: true, timeoutMs: c.timeoutMs, spanName: 'codex.planning',
      });
      try {
        this.validatePlan(res.output, c.repos, existing);
        plan = res.output;
      } catch (err) {
        lastError = errorMessage(err);
      }
    }
    if (!plan) throw new Error(`Lead produced an invalid plan twice: ${lastError}`);

    store.tx(() => {
      const byKey = new Map(existing.map((t) => [t.key, t]));
      for (const p of plan!.tasks) {
        const repo = c.repos.find((r) => r.name === p.repository)!;
        const task = store.insertTask({
          runId: run.id, key: p.key, title: p.title, description: p.description, kind: p.kind, repoId: repo.id,
          specialty: p.specialty, risk: p.risk, complexity: p.complexity,
          scope: { files: p.files, modules: p.modules, resources: p.resources },
          acceptanceCriteria: p.acceptanceCriteria, testsRequired: p.testsRequired || isExecutable(p.kind),
          testCommand: p.testCommand, status: 'pending', agentId: null, iteration: 0, branch: null, worktreePath: null,
          summary: null, blockedReason: null, round,
        });
        byKey.set(p.key, task);
      }
      for (const p of plan!.tasks) {
        const task = byKey.get(p.key)!;
        for (const d of p.dependsOn) store.addDependency(task.id, byKey.get(d)!.id);
        bus.emit('task.created', run.id, { taskId: task.id, key: task.key, title: task.title, repoId: task.repoId, dependsOn: p.dependsOn });
      }
      bus.emit('plan.created', run.id, { taskCount: plan!.tasks.length, round });
      // Same transaction: a crash can never leave tasks inserted but the run still "planning".
      this.transition(store.runById(run.id)!, 'executing');
    });
  }

  private validatePlan(plan: LeadPlan, repos: Repository[], existing: Task[]): void {
    if (!plan.tasks.length) throw new Error('plan has no tasks');
    const keys = new Set(existing.map((t) => t.key));
    for (const t of plan.tasks) {
      if (keys.has(t.key)) throw new Error(`duplicate task key ${t.key}`);
      keys.add(t.key);
      if (!repos.some((r) => r.name === t.repository)) throw new Error(`task ${t.key} uses unknown repository "${t.repository}" (known: ${repos.map((r) => r.name).join(', ')})`);
    }
    const graph = new TaskGraph(keys);
    for (const t of plan.tasks) {
      for (const d of t.dependsOn) {
        if (!keys.has(d)) throw new Error(`task ${t.key} depends on unknown task ${d}`);
        graph.addEdge(t.key, d);
      }
    }
    graph.validate();
  }

  /** Scheduler: runs independent, non-conflicting tasks in parallel. */
  private async executing(run: Run): Promise<'done' | 'paused'> {
    const { store, bus, config } = this.ctx;
    const inflight = new Map<string, Promise<void>>();
    // Tasks whose pipeline returned without progress (waiting on a lease or another task)
    // stay parked until the state of the run changes.
    const parked = new Map<string, string>();
    const fingerprint = () => store.tasks(run.id).map((t) => `${t.id}:${t.status}`).join(',') + `|${store.approvals({ runId: run.id, status: 'pending' }).length}`;
    const launch = (t: Task) => {
      const before = t.status;
      const p = this.pipeline.drive(t.id).finally(() => {
        inflight.delete(t.id);
        if (store.task(t.id)!.status === before) parked.set(t.id, fingerprint());
        this.wake(run.id);
      });
      inflight.set(t.id, p);
    };
    for (;;) {
      if (this.stopping) {
        await Promise.allSettled([...inflight.values()]);
        return 'paused';
      }
      const tasks = store.tasks(run.id);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const deps = store.dependencies(run.id);
      const graph = new TaskGraph(tasks.map((t) => t.id), deps);
      const done = new Set(tasks.filter((t) => t.status === 'approved' || t.status === 'integrated').map((t) => t.id));

      // Cascade: a task whose prerequisite was cancelled/failed cannot proceed.
      for (const t of tasks) {
        if (t.status !== 'pending') continue;
        const broken = graph.dependenciesOf(t.id).map((d) => byId.get(d)!).find((d) => d.status === 'cancelled' || d.status === 'failed');
        if (broken) {
          setTaskStatus(this.ctx, t, 'cancelled', { blockedReason: `prerequisite ${broken.key} ${broken.status}` });
          bus.emit('task.failed', run.id, { taskId: t.id, reason: `prerequisite ${broken.key} ${broken.status}` });
        } else if (graph.dependenciesOf(t.id).every((d) => done.has(d))) {
          setTaskStatus(this.ctx, t, 'ready');
        }
      }

      const fresh = store.tasks(run.id);
      const active = fresh.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
      const conflicts = new ConflictGraph(fresh.map((t) => ({ id: t.id, repoId: t.repoId, scope: t.scope })));
      const waitingHuman = new Set(
        fresh.filter((t) => t.status === 'escalated' && store.taskContext<TaskContext>(t.id).awaitingApprovalId && store.approval(store.taskContext<TaskContext>(t.id).awaitingApprovalId!)?.status === 'pending').map((t) => t.id),
      );

      const fp = fingerprint();
      const isParked = (id: string) => parked.get(id) === fp;
      // Resume active tasks that have no pipeline running (after restart, or waiting on leases).
      for (const t of active) {
        if (inflight.has(t.id) || waitingHuman.has(t.id) || isParked(t.id)) continue;
        launch(t);
      }
      // Start ready tasks that do not conflict with running ones, up to the parallelism limit.
      for (const t of fresh.filter((x) => x.status === 'ready').sort((a, b) => a.key.localeCompare(b.key))) {
        if (inflight.size >= config.engine.maxParallelTasks) break;
        if (inflight.has(t.id) || isParked(t.id)) continue;
        const activeIds = [...new Set([...inflight.keys(), ...active.map((a) => a.id)])];
        if (!conflicts.compatibleWith(t.id, activeIds)) continue;
        launch(t);
      }

      if (inflight.size === 0) {
        const latest = store.tasks(run.id);
        const open = latest.filter((t) => !['approved', 'integrated', 'cancelled', 'failed'].includes(t.status));
        if (!open.length) {
          if (!latest.some((t) => t.status === 'approved' || t.status === 'integrated')) throw new Error('all tasks failed or were cancelled');
          this.transition(store.runById(run.id)!, 'integrating');
          return 'done';
        }
        if (open.some((t) => waitingHuman.has(t.id))) {
          for (const t of open) {
            const id = store.taskContext<TaskContext>(t.id).awaitingApprovalId;
            if (id) this.trackApproval(id, run.id);
          }
          this.transition(store.runById(run.id)!, 'awaiting_human_decision');
          return 'paused';
        }
        const stuck = open.filter((t) => t.status === 'pending' || t.status === 'ready' || t.status === 'lease_conflict');
        if (stuck.length === open.length) {
          throw new Error(`scheduler deadlock: ${stuck.map((t) => `${t.key}[${t.status}]`).join(', ')} cannot make progress`);
        }
      }
      await this.waitForChange(run.id, [...inflight.values()]);
    }
  }

  private waitForChange(runId: string, pending: Promise<void>[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wakers.delete(runId);
        resolve();
      };
      this.wakers.set(runId, done);
      if (pending.length) void Promise.race(pending).then(done, done);
    });
  }

  private async integrating(run: Run): Promise<void> {
    const { store, bus, runner, workspaces, config, telemetry } = this.ctx;
    const c = this.common(run);
    const tasks = store.tasks(run.id);
    const graph = new TaskGraph(tasks.map((t) => t.id), store.dependencies(run.id));
    const order = graph.topologicalOrder();
    const integration = { ...(store.runMeta<RunMeta>(run.id).integration ?? {}) };
    let bounced = false;

    for (const repo of c.repos) {
      const repoTasks = order.map((id) => store.task(id)!).filter((t) => t.repoId === repo.id && t.status === 'approved');
      const branch = workspaces.integrationBranch(run.id);
      const path = workspaces.integrationPath(run.id, repo);
      if (!repoTasks.length && !integration[repo.id]) continue;
      const wt = await workspaces.ensure(repo, path, branch, repo.baseBranch);
      if (wt.created) store.insertWorktree({ runId: run.id, taskId: null, repoId: repo.id, path, branch, baseCommit: wt.baseCommit, status: 'active' });
      bus.emit('integration.started', run.id, { repoId: repo.id, branch, tasks: repoTasks.map((t) => t.key) });

      for (const t of repoTasks) {
        const res = await gitOps.merge(path, t.branch!, `Integrate ${t.key}: ${t.title}`);
        if (!res.ok) {
          bus.emit('integration.conflict', run.id, { repoId: repo.id, taskId: t.id, files: res.conflicts });
          let resolved = false;
          try {
            const out = await runner.call({
              runId: run.id, taskId: t.id, agentId: c.lead, role: 'lead', contract: 'LeadIntegrationResult',
              prompt: leadIntegrationPrompt(repo, t, res.conflicts), cwd: path, readOnly: false, timeoutMs: c.timeoutMs, spanName: 'codex.integration_resolve',
            });
            const remaining = [...(await gitOps.unresolvedConflicts(path)), ...readConflictMarkers(path, res.conflicts)];
            resolved = out.output.resolved && remaining.length === 0;
          } catch {
            resolved = false;
          }
          if (resolved) {
            await gitOps.git(path, ['add', '-A']);
            await gitOps.git(path, ['commit', '-q', '--no-verify', '--no-edit']);
          } else {
            await gitOps.abortMerge(path);
            // Send the task back to its worker to resolve against the integration branch.
            store.setTaskContext(t.id, { mergeIntegration: true, integrationConflict: res.conflicts } satisfies Partial<TaskContext>);
            setTaskStatus(this.ctx, t, 'changes_requested', { blockedReason: `integration conflict in ${res.conflicts.join(', ')}` });
            bounced = true;
            continue;
          }
        }
        setTaskStatus(this.ctx, t, 'integrated');
      }

      const command = repo.testCommand;
      let passed = true;
      let output = '';
      if (command) {
        bus.emit('test.started', run.id, { command, scope: 'integration' });
        const res = await telemetry.span('test.integration', { 'cockpit.run_id': run.id, 'cockpit.repository': repo.name, 'cockpit.command': command }, () =>
          runShell(command, path, config.engine.testTimeoutMs),
        );
        passed = res.exitCode === 0;
        output = `${res.stdout}\n${res.stderr}`.trim().slice(-20_000);
        if (passed) bus.emit('test.passed', run.id, { command, scope: 'integration' });
        else bus.emit('test.failed', run.id, { command, scope: 'integration', output: output.slice(-2000) });
      }
      integration[repo.id] = { branch, path, passed, output, command };
      bus.emit('integration.completed', run.id, { repoId: repo.id, branch, passed });
    }
    store.setRunMeta(run.id, { integration });
    this.transition(store.runById(run.id)!, bounced ? 'executing' : 'validating');
  }

  private async validating(run: Run): Promise<void> {
    const { store, bus, runner, config } = this.ctx;
    const c = this.common(run);
    const meta = store.runMeta<RunMeta>(run.id);
    const tasks = store.tasks(run.id);
    const reviews = new Map(tasks.map((t) => [t.id, store.reviews(t.id)]));
    const integ = meta.integration ?? {};
    const diffStats: Record<string, string> = {};
    for (const repo of c.repos) {
      const i = integ[repo.id];
      if (i) diffStats[repo.id] = (await gitOps.git(i.path, ['diff', '--stat', `${repo.baseBranch}...HEAD`])).stdout;
    }
    const paths = c.repos.map((r) => integ[r.id]?.path ?? r.path);
    const res = await runner.call({
      runId: run.id, agentId: c.supervisor, role: 'supervisor', contract: 'SupervisorValidation',
      prompt: supervisorValidationPrompt({
        request: run.request, arch: arch(run), tasks, reviews,
        integration: c.repos.filter((r) => integ[r.id]).map((r) => ({ repo: r.name, branch: integ[r.id]!.branch, passed: integ[r.id]!.passed, output: integ[r.id]!.output })),
        proposals: store.proposals(run.id), decisions: store.decisions(run.id),
        diffStats: Object.entries(diffStats).map(([id, s]) => `${c.repos.find((r) => r.id === id)?.name}:\n${s}`).join('\n'),
      }),
      cwd: paths[0]!, additionalDirs: paths.slice(1), readOnly: true, timeoutMs: c.timeoutMs, spanName: 'opus.validation',
    });
    let v: SupervisorValidation = res.output;
    // Failing integration tests can never be accepted silently.
    const failing = c.repos.filter((r) => integ[r.id] && !integ[r.id]!.passed);
    if (v.verdict === 'accept' && failing.length) {
      v = { ...v, verdict: 'revise', requiredChanges: [...v.requiredChanges, ...failing.map((r) => `Integration tests fail in ${r.name}`)] };
    }
    store.setRunMeta(run.id, { validation: v });
    bus.emit('validation.completed', run.id, { verdict: v.verdict, summary: v.summary });

    const revisions = meta.revisions ?? 0;
    if (v.verdict === 'revise' && revisions < config.engine.validation.maxRevisions) {
      store.setRunMeta(run.id, { revisions: revisions + 1, pendingRevision: `Supervisor validation requires: ${v.requiredChanges.join('; ') || v.summary}` });
      this.transition(run, 'planning');
      return;
    }
    const report = buildReport({
      run: store.runById(run.id)!, repos: c.repos, tasks: store.tasks(run.id), reviews, proposals: store.proposals(run.id),
      decisions: store.decisions(run.id), validation: v, meta: store.runMeta<RunMeta>(run.id), usage: store.usageSummary(run.id), diffStats,
    });
    store.updateRun(run.id, { report });
    const merges = c.repos
      .filter((r) => integ[r.id])
      .map((r) => ({ repo: r.name, from: integ[r.id]!.branch, into: r.baseBranch, protected: this.ctx.permissions.checkMerge(r.baseBranch, r.protectedBranches).requiresApproval }));
    const approval = store.insertApproval({
      runId: run.id, kind: 'final', operation: merges.some((m) => m.protected) ? 'merge_protected' : null,
      summary: `Final result: ${v.summary}`.slice(0, 2000),
      details: { verdict: v.verdict, merges, finalMerge: config.engine.finalMerge },
    });
    this.trackApproval(approval.id, run.id);
    bus.emit('approval.requested', run.id, { approvalId: approval.id, kind: 'final', summary: approval.summary, operation: approval.operation });
    this.transition(store.runById(run.id)!, 'awaiting_approval');
  }

  private async merging(run: Run): Promise<void> {
    const { store, bus, config } = this.ctx;
    const c = this.common(run);
    const integ = store.runMeta<RunMeta>(run.id).integration ?? {};
    if (config.engine.finalMerge === 'merge') {
      for (const repo of c.repos) {
        const i = integ[repo.id];
        if (!i) continue;
        const error = await this.mergeIntoBase(repo, i.branch, i.path);
        if (error) {
          store.setRunMeta(run.id, { mergeError: error });
          const approval = store.insertApproval({
            runId: run.id, kind: 'final', operation: 'merge_protected',
            summary: `Merge into ${repo.baseBranch} of ${repo.name} blocked: ${error}. Fix it and approve again.`, details: { retry: true },
          });
          bus.emit('approval.requested', run.id, { approvalId: approval.id, kind: 'final', summary: approval.summary, operation: 'merge_protected' });
          this.transition(run, 'awaiting_approval');
          return;
        }
        bus.emit('merge.completed', run.id, { repoId: repo.id, branch: i.branch, into: repo.baseBranch });
      }
    }
    await this.cleanup(run.id, false);
    this.transition(store.runById(run.id)!, 'completed');
    bus.emit('run.completed', run.id, { outcome: 'approved' });
  }

  /** Merge the integration branch into the base branch without touching unrelated local changes. Returns an error or null. */
  private async mergeIntoBase(repo: Repository, branch: string, integrationPath: string): Promise<string | null> {
    const checkedOut = (await gitOps.currentBranch(repo.path)) === repo.baseBranch;
    if (checkedOut) {
      if (!(await gitOps.isClean(repo.path))) return `the working tree of ${repo.path} has uncommitted changes`;
      const res = await gitOps.merge(repo.path, branch, `Merge ${branch} (approved by human)`);
      if (!res.ok) {
        await gitOps.abortMerge(repo.path);
        return `merge conflicts in ${res.conflicts.join(', ')}`;
      }
      return null;
    }
    if (!(await gitOps.isAncestor(repo.path, repo.baseBranch, branch))) {
      // The base moved since integration started: bring it into the integration branch first.
      const res = await gitOps.merge(integrationPath, repo.baseBranch, `Merge ${repo.baseBranch} into ${branch}`);
      if (!res.ok) {
        await gitOps.abortMerge(integrationPath);
        return `${repo.baseBranch} moved and conflicts with the integration branch (${res.conflicts.join(', ')})`;
      }
    }
    const oldBase = await gitOps.revParse(repo.path, repo.baseBranch);
    const target = await gitOps.revParse(repo.path, branch);
    await gitOps.git(repo.path, ['update-ref', `refs/heads/${repo.baseBranch}`, target, oldBase]);
    return null;
  }

  private async cleanup(runId: string, keepIntegration: boolean): Promise<void> {
    const { store, workspaces, leases } = this.ctx;
    for (const t of store.tasks(runId)) leases.release(t.id);
    for (const w of store.worktrees(runId)) {
      if (w.status !== 'active') continue;
      if (keepIntegration && !w.taskId) continue;
      const repo = store.repository(w.repoId);
      if (repo) await workspaces.remove(repo, w.path).catch(() => {});
      store.setWorktreeStatus(w.id, 'removed');
    }
  }

  private trackApproval(approvalId: string, runId: string): void {
    if (this.approvalSpans.has(approvalId)) return;
    this.approvalSpans.set(approvalId, this.ctx.telemetry.start('approval.wait', { 'cockpit.run_id': runId, 'cockpit.approval_id': approvalId }));
  }
}

function isExecutable(kind: string): boolean {
  return ['implementation', 'bugfix', 'refactor', 'test', 'database', 'api', 'security', 'performance'].includes(kind);
}
