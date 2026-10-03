import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, type Run, type Task, type ValidationResult } from '@cockpit/core';
import {
  leadAnswerPrompt,
  leadLeaseDecisionPrompt,
  leadReviewPrompt,
  supervisorEscalationPrompt,
  workerPrompt,
  type WorkerContext,
} from '@cockpit/agents';
import { gitOps, runShell } from '@cockpit/workspace';
import { arch, councilOf, leadForTask, personaOf, seatCall, setTaskStatus, type EngineContext, type RunMeta, type TaskContext } from './context';
import { decideProposals } from './proposals';

/**
 * Drives one task through its lifecycle. Every step reads the persisted task status
 * and context, so after a restart the pipeline continues where it stopped.
 * Communication stays hierarchical: worker <-> lead, lead <-> supervisor.
 */
export class TaskPipeline {
  constructor(
    private readonly ctx: EngineContext,
    private readonly onChange: () => void,
    private readonly isStopping: () => boolean = () => false,
  ) {}

  private task(id: string): Task {
    return this.ctx.store.task(id)!;
  }

  private tctx(id: string): TaskContext {
    return this.ctx.store.taskContext<TaskContext>(id);
  }

  private setCtx(id: string, patch: Partial<TaskContext>): void {
    this.ctx.store.setTaskContext(id, patch);
  }

  private run(t: Task): Run {
    return this.ctx.store.runById(t.runId)!;
  }

  /** The Lead seat that owns the task: its agent, effort and seat id for the call. */
  private lead(t: Task) {
    return seatCall(leadForTask(this.ctx, t));
  }

  /** The council's chair. */
  private supervisor(t: Task) {
    return seatCall(councilOf(this.ctx, t.runId)[0]!);
  }

  async drive(taskId: string): Promise<void> {
    for (let guard = 0; guard < 200; guard++) {
      if (this.isStopping()) return;
      const t = this.task(taskId);
      const before = t.status;
      try {
        switch (t.status) {
          case 'ready':
            if (!(await this.start(t))) return;
            break;
          case 'running':
            await this.execute(t);
            break;
          case 'needs_input':
            await this.answer(t);
            break;
          case 'validating':
            await this.validate(t);
            break;
          case 'lease_conflict':
            if (!(await this.resolveLeaseConflict(t))) return;
            break;
          case 'in_review':
            await this.review(t);
            break;
          case 'changes_requested':
            this.afterChangesRequested(t);
            break;
          case 'escalated':
            if (!(await this.escalate(t))) return;
            break;
          default:
            return;
        }
      } catch (err) {
        // Interrupted by shutdown: leave the persisted status alone so a restart resumes it.
        if (this.isStopping()) return;
        const fresh = this.task(taskId);
        const reason = errorMessage(err);
        this.ctx.leases.release(fresh.id);
        this.ctx.store.updateTask(fresh.id, { status: 'failed', blockedReason: reason });
        this.ctx.bus.emit('task.status_changed', fresh.runId, { taskId: fresh.id, from: fresh.status, to: 'failed' });
        this.ctx.bus.emit('task.failed', fresh.runId, { taskId: fresh.id, reason });
        this.onChange();
        return;
      }
      if (this.task(taskId).status !== before) this.onChange();
    }
  }

  // ---------- start: route, lease, isolate ----------

  private async start(t: Task): Promise<boolean> {
    const { store, bus, leases, workspaces, router } = this.ctx;
    const lease = leases.acquireScope(t);
    if (!lease.ok) {
      for (const c of lease.conflicts) bus.emit('file.lease.conflict', t.runId, { taskId: t.id, pattern: c.pattern, heldBy: c.heldBy });
      return false;
    }
    for (const l of lease.leases) bus.emit('file.lease.acquired', t.runId, { taskId: t.id, pattern: l.pattern, kind: l.kind });

    let agentId = t.agentId;
    if (!agentId) {
      const meta = store.runMeta<RunMeta>(t.runId);
      const load = new Map<string, number>();
      for (const other of store.tasks(t.runId)) {
        if (other.agentId && ['running', 'needs_input', 'validating', 'in_review', 'changes_requested'].includes(other.status)) {
          load.set(other.agentId, (load.get(other.agentId) ?? 0) + 1);
        }
      }
      const persona = personaOf(this.ctx, t);
      const preferred = persona?.agent ?? this.tctx(t.id).preferredWorker;
      const chosen = preferred ? router.workers().find((w) => w.id === preferred) : undefined;
      if (persona && chosen && (load.get(chosen.id) ?? 0) >= chosen.maxConcurrent) {
        // The human approved this persona's model: wait for a free slot rather than swap it.
        leases.release(t.id);
        return false;
      }
      if (chosen && (load.get(chosen.id) ?? 0) < chosen.maxConcurrent) {
        agentId = chosen.id;
        bus.emit('task.assigned', t.runId, { taskId: t.id, agentId, reason: persona ? `${persona.id} (${persona.title})` : `chosen by the lead (${leadForTask(this.ctx, t).agent})` });
      } else {
        const decision = router.route(t, { strategy: meta.routingStrategy, load });
        agentId = decision.agentId;
        const why = preferred ? `lead chose ${preferred} but it is ${chosen ? 'at capacity' : 'unavailable'}; ` : '';
        bus.emit('task.assigned', t.runId, { taskId: t.id, agentId, reason: `${why}${decision.reason}` });
      }
    }

    const repo = store.repository(t.repoId)!;
    const integrationBranch = workspaces.integrationBranch(t.runId);
    const base = (await gitOps.branchExists(repo.path, integrationBranch)) ? integrationBranch : repo.baseBranch;
    const branch = t.branch ?? workspaces.taskBranch(t.runId, t);
    const path = t.worktreePath ?? workspaces.taskPath(t.runId, repo, t.key);
    const wt = await workspaces.ensure(repo, path, branch, base);
    if (wt.created) {
      store.insertWorktree({ runId: t.runId, taskId: t.id, repoId: repo.id, path, branch, baseCommit: wt.baseCommit, status: 'active' });
      // Build on approved prerequisite work in the same repository.
      const deps = store.dependencies(t.runId).filter((d) => d.taskId === t.id).map((d) => store.task(d.dependsOn)!);
      for (const dep of deps) {
        if (dep.repoId !== t.repoId || !dep.branch || dep.status === 'integrated') continue;
        const res = await gitOps.merge(path, dep.branch, `Merge prerequisite ${dep.key} into ${t.key}`);
        if (!res.ok) {
          await gitOps.abortMerge(path);
          this.setCtx(t.id, { guidance: `Prerequisite ${dep.key} could not be merged automatically (conflicts in ${res.conflicts.join(', ')}). Coordinate with its changes.` });
        }
      }
      this.setCtx(t.id, { baseCommit: await gitOps.revParse(path, 'HEAD') });
    }
    const updated = setTaskStatus(this.ctx, t, 'running', { agentId, branch, worktreePath: path, iteration: Math.max(1, t.iteration) });
    bus.emit('task.started', t.runId, { taskId: t.id, iteration: updated.iteration, branch, worktreePath: path });
    return true;
  }

  // ---------- worker execution ----------

  private async execute(t: Task): Promise<void> {
    const { store, bus, runner, config } = this.ctx;
    const repo = store.repository(t.repoId)!;
    const run = this.run(t);
    const c = this.tctx(t.id);

    if (c.mergeIntegration) {
      // Integration found conflicts: bring the integration branch in so the worker resolves them here.
      const res = await gitOps.merge(t.worktreePath!, this.ctx.workspaces.integrationBranch(t.runId), `Merge integration branch into ${t.key}`);
      this.setCtx(t.id, { mergeIntegration: false });
      if (!res.ok) {
        this.setCtx(t.id, {
          guidance: `${c.guidance ? `${c.guidance}\n` : ''}The integration branch was merged into your branch and conflicts remain in: ${res.conflicts.join(', ')}. Resolve every conflict (remove all markers) preserving both sides' intent.`,
        });
      }
    }

    const fresh = this.tctx(t.id);
    const review = fresh.reviewFeedbackId ? store.reviews(t.id).find((r) => r.id === fresh.reviewFeedbackId) ?? null : null;
    const deps = store
      .dependencies(t.runId)
      .filter((d) => d.taskId === t.id)
      .map((d) => store.task(d.dependsOn)!)
      .map((d) => ({ key: d.key, title: d.title, summary: d.summary ?? '' }));
    const persona = personaOf(this.ctx, t);
    const wctx: WorkerContext = {
      persona: persona?.id ?? null,
      answers: fresh.pendingAnswers ?? [],
      reviewFeedback: review,
      validationFailure: fresh.feedValidationFailure ? (fresh.validation ?? null) : null,
      guidance: fresh.guidance ?? null,
      dependencySummaries: deps,
    };
    const resumeId = fresh.started ? (store.latestTaskSession(t.id, t.agentId!)?.externalId ?? null) : null;
    const fullPrompt = workerPrompt(t, repo, arch(run), wctx, false);

    const res = await runner.call({
      runId: t.runId,
      taskId: t.id,
      agentId: t.agentId!,
      role: 'worker',
      contract: 'WorkerResult',
      prompt: resumeId ? workerPrompt(t, repo, arch(run), wctx, true) : fullPrompt,
      freshPrompt: fullPrompt,
      resumeExternalId: resumeId,
      cwd: t.worktreePath!,
      readOnly: false,
      timeoutMs: config.engine.agentTimeoutMs,
      spanName: 'worker.execute',
      ...(persona ? { seat: persona.id, effort: persona.agent === t.agentId ? persona.effort : undefined } : {}),
    });
    const out = res.output;
    this.setCtx(t.id, {
      started: true,
      pendingAnswers: [],
      reviewFeedbackId: null,
      feedValidationFailure: false,
      guidance: null,
      lastWorkerSummary: out.summary,
      workerResult: out,
    });

    if (out.status === 'needs_input' || out.status === 'blocked') {
      const questions = out.status === 'blocked' ? [`BLOCKED: ${out.summary}`, ...out.questions] : out.questions.length ? out.questions : [out.summary];
      this.setCtx(t.id, { questions });
      bus.emit('agent.waiting', t.runId, { agentId: t.agentId!, taskId: t.id, question: questions.join(' | ').slice(0, 500) });
      bus.emit('question.asked', t.runId, { taskId: t.id, questions });
      if (out.status === 'blocked') bus.emit('task.blocked', t.runId, { taskId: t.id, reason: out.summary });
      setTaskStatus(this.ctx, t, 'needs_input');
      return;
    }

    await gitOps.commitAll(t.worktreePath!, `${t.key}: ${t.title}\n\n${out.summary}`.slice(0, 4000));
    setTaskStatus(this.ctx, t, 'validating', { summary: out.summary });
  }

  // ---------- worker questions go to the lead ----------

  private async answer(t: Task): Promise<void> {
    const { bus, runner, config } = this.ctx;
    const c = this.tctx(t.id);
    const questions = c.questions ?? [];
    const run = this.run(t);
    const res = await runner.call({
      runId: t.runId, taskId: t.id, ...this.lead(t), role: 'lead', contract: 'LeadAnswer',
      prompt: leadAnswerPrompt(t, arch(run), questions, c.lastWorkerSummary ?? ''),
      cwd: t.worktreePath!, readOnly: true, timeoutMs: config.engine.agentTimeoutMs, spanName: 'codex.answer',
    });
    let answer = res.output.answer;
    let answeredBy: 'lead' | 'supervisor' = 'lead';
    if (res.output.escalateToSupervisor) {
      bus.emit('escalation.requested', t.runId, { from: 'lead', to: 'supervisor', taskId: t.id, reason: res.output.escalationQuestion ?? questions.join('; ') });
      const sup = await runner.call({
        runId: t.runId, taskId: t.id, ...this.supervisor(t), role: 'supervisor', contract: 'SupervisorEscalation',
        prompt: supervisorEscalationPrompt(t, res.output.escalationQuestion ?? questions.join('; '), `Worker questions: ${questions.join(' | ')}\nLead interim answer: ${answer}`),
        cwd: t.worktreePath!, readOnly: true, timeoutMs: config.engine.agentTimeoutMs, spanName: 'opus.escalation',
      });
      bus.emit('escalation.resolved', t.runId, { taskId: t.id, action: sup.output.action, guidance: sup.output.guidance });
      if (sup.output.action === 'abandon_task') {
        this.ctx.leases.release(t.id);
        setTaskStatus(this.ctx, t, 'escalated', { blockedReason: sup.output.guidance });
        this.cancel(this.task(t.id), sup.output.guidance);
        return;
      }
      if (sup.output.action === 'escalate_human') {
        this.requestHuman(t, sup.output.guidance, 'running');
        setTaskStatus(this.ctx, t, 'escalated', { blockedReason: sup.output.guidance });
        return;
      }
      answer = `${answer}\nSupervisor guidance: ${sup.output.guidance}`;
      answeredBy = 'supervisor';
    }
    const answers = [...(c.pendingAnswers ?? []), { question: questions.join('\n'), answer }];
    this.setCtx(t.id, { pendingAnswers: answers, questions: [] });
    bus.emit('question.answered', t.runId, { taskId: t.id, answeredBy, answer: answer.slice(0, 1000) });
    setTaskStatus(this.ctx, t, 'running');
  }

  // ---------- leases + validation ----------

  private async validate(t: Task): Promise<void> {
    const { store, bus, leases, permissions, config, telemetry } = this.ctx;
    const c = this.tctx(t.id);
    const files = await gitOps.changedFiles(t.worktreePath!, c.baseCommit!);
    const claim = leases.claimFiles(t, files);
    for (const f of claim.acquired) bus.emit('file.lease.acquired', t.runId, { taskId: t.id, pattern: f, kind: 'file' });
    if (claim.conflicts.length) {
      for (const cf of claim.conflicts) bus.emit('file.lease.conflict', t.runId, { taskId: t.id, pattern: cf.pattern, heldBy: cf.heldBy });
      this.setCtx(t.id, { leaseConflicts: claim.conflicts, leaseDecision: null });
      setTaskStatus(this.ctx, t, 'lease_conflict');
      return;
    }

    const repo = store.repository(t.repoId)!;
    const command = t.testCommand ?? repo.testCommand;
    let validation: ValidationResult;
    if (!command) {
      validation = { command: null, passed: true, skipped: true, exitCode: null, output: '' };
    } else {
      const check = permissions.checkCommand(command);
      if (check.requiresApproval && !(c.approvedCommands ?? []).includes(command)) {
        this.requestHuman(t, `Validation command for ${t.key} is classified as ${check.operations.join(', ')}: \`${command}\`. Allow it to run?`, 'validating', check.operations[0] ?? null);
        setTaskStatus(this.ctx, t, 'escalated', { blockedReason: `awaiting approval to run \`${command}\`` });
        return;
      }
      bus.emit('test.started', t.runId, { taskId: t.id, command, scope: 'task' });
      const res = await telemetry.span('test.run', { 'cockpit.run_id': t.runId, 'cockpit.task_id': t.id, 'cockpit.command': command }, () =>
        runShell(command, t.worktreePath!, config.engine.testTimeoutMs),
      );
      const output = `${res.stdout}\n${res.stderr}`.trim();
      validation = { command, passed: res.exitCode === 0, skipped: false, exitCode: res.exitCode, output: output.slice(-20_000) };
      if (validation.passed) bus.emit('test.passed', t.runId, { taskId: t.id, command, scope: 'task' });
      else bus.emit('test.failed', t.runId, { taskId: t.id, command, scope: 'task', output: output.slice(-2000) });
    }
    this.setCtx(t.id, { validation });
    setTaskStatus(this.ctx, t, 'in_review');
  }

  /** Returns false when the task must wait for another task to finish. */
  private async resolveLeaseConflict(t: Task): Promise<boolean> {
    const { store, bus, runner, leases, config } = this.ctx;
    const c = this.tctx(t.id);
    const conflicts = c.leaseConflicts ?? [];
    const holders = [...new Set(conflicts.map((x) => x.heldBy))].map((id) => store.task(id)!);
    const holdersDone = holders.every((h) => ['approved', 'integrated', 'cancelled', 'failed'].includes(h.status));

    if (holdersDone) {
      // Build on top of the owners' finished work, then validate again.
      for (const h of holders) {
        if (h.repoId === t.repoId && h.branch && ['approved', 'integrated'].includes(h.status)) {
          const res = await gitOps.merge(t.worktreePath!, h.branch, `Merge ${h.key} into ${t.key} after lease wait`);
          if (!res.ok) await gitOps.abortMerge(t.worktreePath!);
        }
      }
      const decision = c.leaseDecision;
      this.setCtx(t.id, { leaseConflicts: [], leaseDecision: null, baseCommit: c.baseCommit });
      if (decision === 'serialize') {
        this.setCtx(t.id, { started: false, guidance: `Re-run ${t.key} on top of ${holders.map((h) => h.key).join(', ')}, which now own the overlapping files.` });
        setTaskStatus(this.ctx, t, 'running');
      } else setTaskStatus(this.ctx, t, 'validating');
      return true;
    }
    if (c.leaseDecision) return false; // still waiting

    const res = await runner.call({
      runId: t.runId, taskId: t.id, ...this.lead(t), role: 'lead', contract: 'LeadLeaseDecision',
      prompt: leadLeaseDecisionPrompt(t, conflicts.map((x) => ({ pattern: x.pattern, holder: store.task(x.heldBy)! }))),
      cwd: t.worktreePath!, readOnly: true, timeoutMs: config.engine.agentTimeoutMs, spanName: 'codex.lease_decision',
    });
    const { action, rationale } = res.output;
    bus.emit('file.lease.resolved', t.runId, { taskId: t.id, action, rationale });
    switch (action) {
      case 'transfer':
        leases.transfer(conflicts, t.id);
        this.setCtx(t.id, { leaseConflicts: [] });
        setTaskStatus(this.ctx, t, 'validating');
        return true;
      case 'wait':
        this.setCtx(t.id, { leaseDecision: 'wait' });
        return false;
      case 'serialize':
        await gitOps.git(t.worktreePath!, ['reset', '--hard', c.baseCommit!]);
        await gitOps.git(t.worktreePath!, ['clean', '-fd']);
        this.setCtx(t.id, { leaseDecision: 'serialize' });
        return false;
      case 'escalate':
        this.setCtx(t.id, { escalationReason: `Lease conflict: ${rationale}` });
        setTaskStatus(this.ctx, t, 'escalated', { blockedReason: rationale });
        return true;
    }
  }

  // ---------- review loop ----------

  private async review(t: Task): Promise<void> {
    const { store, bus, runner, config } = this.ctx;
    const c = this.tctx(t.id);
    const validation = c.validation ?? { command: null, passed: true, skipped: true, exitCode: null, output: '' };
    bus.emit('review.started', t.runId, { taskId: t.id, iteration: t.iteration });
    const run = this.run(t);
    const res = await runner.call({
      runId: t.runId, taskId: t.id, ...this.lead(t), role: 'lead', contract: 'LeadReview',
      prompt: leadReviewPrompt({
        task: t,
        arch: arch(run),
        diff: await gitOps.diff(t.worktreePath!, c.baseCommit!),
        diffStat: await gitOps.diffStat(t.worktreePath!, c.baseCommit!),
        validation,
        worker: (c.workerResult as never) ?? { summary: t.summary ?? '', testsAdded: [] },
        iteration: t.iteration,
        maxIterations: config.engine.review.maxIterations + (c.extraIterations ?? 0),
      }),
      cwd: t.worktreePath!, readOnly: true, timeoutMs: config.engine.agentTimeoutMs, spanName: 'codex.review',
    });
    const out = { ...res.output, issues: [...res.output.issues] };
    // Policy is enforced by the orchestrator, not left to model judgement.
    if (out.verdict === 'approve' && !validation.passed && !validation.skipped) {
      out.verdict = 'changes_requested';
      out.issues.push({ severity: 'blocker', file: null, description: `Validation \`${validation.command}\` is failing; a code task cannot complete with failing validation.`, suggestion: 'Fix the failures.' });
    }
    if (out.verdict === 'approve' && t.testsRequired && !out.testsAdequate) {
      out.verdict = 'changes_requested';
      out.issues.push({ severity: 'blocker', file: null, description: 'Tests are required for executable code changes and are not adequate.', suggestion: 'Add or extend automated tests.' });
    }
    const review = store.insertReview({ taskId: t.id, iteration: t.iteration, verdict: out.verdict, summary: out.summary, issues: out.issues, validation });

    if (out.proposals.length) {
      const created = out.proposals.map((p) => store.insertProposal({ runId: t.runId, taskId: t.id, ...p }));
      for (const p of created) bus.emit('proposal.created', t.runId, { proposalId: p.id, kind: p.kind, title: p.title, taskId: t.id });
      // Deferred proposals stay open; the Supervisor rules on them all at final validation.
      if (config.engine.decisions.duringTasks === 'immediate') await decideProposals(this.ctx, run, out.summary, created);
    }

    if (out.verdict === 'approve') {
      const released = this.ctx.leases.release(t.id);
      bus.emit('file.lease.released', t.runId, { taskId: t.id, count: released });
      bus.emit('review.passed', t.runId, { taskId: t.id, iteration: t.iteration, summary: out.summary });
      setTaskStatus(this.ctx, t, 'approved');
      bus.emit('task.completed', t.runId, { taskId: t.id, summary: t.summary ?? out.summary });
    } else if (out.verdict === 'changes_requested') {
      bus.emit('review.issue_found', t.runId, { taskId: t.id, iteration: t.iteration, issues: out.issues.length, summary: out.summary });
      this.setCtx(t.id, { reviewFeedbackId: review.id, feedValidationFailure: !validation.passed && !validation.skipped });
      setTaskStatus(this.ctx, t, 'changes_requested');
    } else {
      this.setCtx(t.id, { escalationReason: `Lead escalated during review: ${out.summary}` });
      bus.emit('escalation.requested', t.runId, { from: 'lead', to: 'supervisor', taskId: t.id, reason: out.summary });
      setTaskStatus(this.ctx, t, 'escalated', { blockedReason: out.summary });
    }
  }

  private afterChangesRequested(t: Task): void {
    const c = this.tctx(t.id);
    const limit = this.ctx.config.engine.review.maxIterations + (c.extraIterations ?? 0);
    if (t.iteration >= limit) {
      const reason = `Review failed ${t.iteration} iterations (limit ${limit})`;
      this.setCtx(t.id, { escalationReason: reason });
      this.ctx.bus.emit('escalation.requested', t.runId, { from: 'lead', to: 'supervisor', taskId: t.id, reason });
      setTaskStatus(this.ctx, t, 'escalated', { blockedReason: reason });
      return;
    }
    setTaskStatus(this.ctx, t, 'running', { iteration: t.iteration + 1 });
  }

  // ---------- escalation: lead -> supervisor -> human ----------

  /** Returns false while waiting on the human. */
  private async escalate(t: Task): Promise<boolean> {
    const { store, bus, runner, config } = this.ctx;
    const c = this.tctx(t.id);
    if (c.awaitingApprovalId) {
      const a = store.approval(c.awaitingApprovalId);
      if (a?.status === 'pending') return false;
    }
    const history = store
      .reviews(t.id)
      .map((r) => `review ${r.iteration}: ${r.verdict} - ${r.summary}${r.issues.map((i) => `\n  - [${i.severity}] ${i.description}`).join('')}`)
      .join('\n');
    const res = await runner.call({
      runId: t.runId, taskId: t.id, ...this.supervisor(t), role: 'supervisor', contract: 'SupervisorEscalation',
      prompt: supervisorEscalationPrompt(t, c.escalationReason ?? t.blockedReason ?? 'unspecified', history || '(no reviews)'),
      cwd: t.worktreePath ?? store.repository(t.repoId)!.path, readOnly: true, timeoutMs: config.engine.agentTimeoutMs, spanName: 'opus.escalation',
    });
    const { action, guidance } = res.output;
    bus.emit('escalation.resolved', t.runId, { taskId: t.id, action, guidance });
    if (action === 'retry_with_guidance') {
      this.setCtx(t.id, { guidance, extraIterations: (c.extraIterations ?? 0) + config.engine.review.maxIterations, escalationReason: null });
      setTaskStatus(this.ctx, t, 'running', { iteration: t.iteration + 1, blockedReason: null });
      return true;
    }
    if (action === 'abandon_task') {
      this.cancel(t, guidance);
      return true;
    }
    this.requestHuman(t, guidance, 'running');
    return false;
  }

  private cancel(t: Task, reason: string): void {
    this.ctx.leases.release(t.id);
    setTaskStatus(this.ctx, t, 'cancelled', { blockedReason: reason });
    this.ctx.bus.emit('task.failed', t.runId, { taskId: t.id, reason: `cancelled: ${reason}` });
  }

  private requestHuman(t: Task, question: string, onApprove: 'validating' | 'running', operation: import('@cockpit/core').HighRiskOperation | null = null): void {
    const { store, bus } = this.ctx;
    const approval = store.insertApproval({
      runId: t.runId,
      kind: operation ? 'operation' : 'decision',
      operation,
      summary: `${t.key}: ${question}`.slice(0, 2000),
      details: { taskId: t.id, question },
    });
    this.setCtx(t.id, { awaitingApprovalId: approval.id, onApprove });
    bus.emit('escalation.requested', t.runId, { from: 'lead', to: 'human', taskId: t.id, reason: question });
    bus.emit('approval.requested', t.runId, { approvalId: approval.id, kind: approval.kind, summary: approval.summary, operation });
  }

  /** Apply a human answer to a task waiting in `escalated`. */
  applyHumanAnswer(taskId: string, approved: boolean, response: string | null): void {
    const t = this.task(taskId);
    const c = this.tctx(taskId);
    if (t.status !== 'escalated') return;
    if (!approved) {
      this.cancel(t, response ?? 'rejected by human');
      return;
    }
    if (c.onApprove === 'validating') {
      const command = t.testCommand ?? this.ctx.store.repository(t.repoId)!.testCommand;
      this.setCtx(taskId, { awaitingApprovalId: null, approvedCommands: [...(c.approvedCommands ?? []), command ?? ''] });
      setTaskStatus(this.ctx, t, 'validating', { blockedReason: null });
      return;
    }
    this.setCtx(taskId, { awaitingApprovalId: null, guidance: `Human decision: ${response ?? 'approved'}`, escalationReason: null });
    setTaskStatus(this.ctx, t, 'running', { blockedReason: null });
  }
}

export function readConflictMarkers(dir: string, files: string[]): string[] {
  return files.filter((f) => {
    try {
      return /^(<{7}|>{7}) /m.test(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return false;
    }
  });
}
