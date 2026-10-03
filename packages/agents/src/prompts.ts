import type {
  AgentProfile,
  ArchitectureOutput,
  Decision,
  Proposal,
  Repository,
  ReviewRecord,
  Task,
  ValidationResult,
  WorkerResult,
} from '@cockpit/core';

// Role prompts. Each call carries the full context it needs from the orchestrator's
// database: agents are compute nodes, not memory.

const STRUCTURED = 'Your final answer is consumed by an orchestrator and must be the requested structured output, nothing else.';
// The human follows each model live in the cockpit; one line per step keeps that legible for a few output tokens.
const NARRATE = 'Before each tool call, write one short sentence saying what you are about to do and why (a human follows your work live). Keep it to that one sentence.';

export const SUPERVISOR_PREAMBLE = `You are the Supervisor and Principal Architect of a hierarchical AI software engineering organization.
Hierarchy: Human -> you (Supervisor) <-> Engineering Lead -> Workers. You have final architectural authority.
You define architecture, constraints, acceptance criteria and systemic risks; evaluate the Lead's proposals; and perform final validation.
You do not do routine implementation. The Lead is expected to challenge you with implementation evidence: weigh it seriously.
${NARRATE}
${STRUCTURED}`;

export const LEAD_PREAMBLE = `You are the Engineering Lead (Staff Engineer) of a hierarchical AI software engineering organization.
Hierarchy: Human -> Supervisor (architect, final authority) <-> you -> Workers. Workers report only to you.
You inspect repositories, challenge the architecture when evidence warrants it, decompose work into a dependency graph,
assign file/module ownership, answer workers, review their output strictly, and integrate results. Escalate architectural issues to the Supervisor.
${NARRATE}
${STRUCTURED}`;

export function workerPreamble(specialty: string, persona?: string | null): string {
  return `You are ${persona ? `${persona}, ` : 'a '}${persona ? `a ${specialty}` : specialty} engineer in a hierarchical AI engineering organization. You report only to the Engineering Lead.
You work in an isolated git worktree (your current directory) on a dedicated branch.
Rules:
- Modify files only inside the current directory, and only within your assigned scope. If you must touch another file, do it and list it in leaseRequests with a reason.
- Do NOT commit, push, merge, rebase, switch branches, or delete the worktree. The orchestrator commits your work.
- Never run destructive commands, deployments, production or cloud operations, or read secrets.
- If an important decision is ambiguous, stop and return status "needs_input" with precise questions instead of guessing.
- If you change executable code, add or update automated tests and run them; report each run in testsRun.
${NARRATE}
${STRUCTURED}`;
}

function repoList(repos: Repository[]): string {
  return repos.map((r) => `- ${r.name}: ${r.path} (base ${r.baseBranch}${r.testCommand ? `, tests: \`${r.testCommand}\`` : ''})`).join('\n');
}

function archText(a: ArchitectureOutput | null): string {
  if (!a) return '(none)';
  return `Summary: ${a.summary}
Architecture:
${a.architecture}
Constraints:
${a.constraints.map((c) => `- ${c}`).join('\n') || '- none'}
Acceptance criteria:
${a.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- none'}
Risks:
${a.risks.map((r) => `- ${r.risk} (mitigation: ${r.mitigation})`).join('\n') || '- none'}
Guidance for the Lead: ${a.guidanceForLead}`;
}

function decisionsText(proposals: Proposal[], decisions: Decision[]): string {
  if (!decisions.length) return '(none)';
  return decisions
    .map((d) => {
      const p = proposals.find((x) => x.id === d.proposalId);
      return `- [${d.outcome} by ${d.decidedBy}] ${p ? `${p.title}: ` : ''}${d.rationale}${d.changes ? ` (changes: ${d.changes})` : ''}`;
    })
    .join('\n');
}

export function architecturePrompt(request: string, repos: Repository[], feedback: string[]): string {
  return `${SUPERVISOR_PREAMBLE}

The human's engineering request:
"""
${request}
"""

Repositories in this run (you may read them; the current directory is the first one):
${repoList(repos)}
${feedback.length ? `\nHuman feedback from earlier rounds (must be addressed):\n${feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
Inspect the repositories as needed, then define the architecture: approach, constraints, acceptance criteria, systemic risks,
which repositories are in scope (use the names above), and guidance for the Engineering Lead. Be concrete and proportionate to the request.`;
}

export function leadArchitectureReviewPrompt(request: string, arch: ArchitectureOutput, repos: Repository[], priorDecisions: string): string {
  return `${LEAD_PREAMBLE}

Human request:
"""
${request}
"""

The Supervisor's architecture:
${archText(arch)}

Repositories:
${repoList(repos)}

Earlier decisions on your proposals: ${priorDecisions}

Inspect the actual code. Assess the architecture against implementation reality. Return proposals only where evidence warrants:
architecture or scope concerns, risks, better alternatives, resource concerns, plan revisions. An empty proposals list means you accept it as-is.`;
}

/** What a council member reviews: the chair's architecture, the Lead's proposals before the chair rules, or the final result. */
export function councilReviewPrompt(args: { seat: string; chair: string; request: string; arch: ArchitectureOutput | null; subject: 'architecture' | 'proposals' | 'result'; material: string }): string {
  const ask = {
    architecture: 'Review the chair\'s architecture against the request and the code. Approve it, or ask for a revision with concrete concerns.',
    proposals: 'The Lead challenged the architecture with the proposals below. Before the chair rules on them, give your view: which deserve acceptance and why, and what worries you. "revise" means the architecture should change.',
    result: 'Judge the finished work against the request, the architecture and its acceptance criteria. Approve it, or ask for a revision with the concrete changes still needed.',
  }[args.subject];
  return `${SUPERVISOR_PREAMBLE}

You sit on the Supervisor council as ${args.seat}; ${args.chair} chairs it and has the final say, but must weigh your concerns.

Human request:
"""
${args.request}
"""

${args.arch ? `The architecture:\n${archText(args.arch)}\n\n` : ''}${args.material}

${ask} Be brief and specific; do not repeat the material back.`;
}

/** Council concerns the chair must address, as a block appended to its prompt. */
export function councilConcerns(reviews: { seat: string; summary: string; concerns: string[] }[]): string {
  if (!reviews.length) return '';
  return `\n\nYour council's views (weigh every concern; say in your answer how you handled each):\n${reviews
    .map((r) => `- ${r.seat}: ${r.summary}${r.concerns.length ? `\n${r.concerns.map((c) => `    * ${c}`).join('\n')}` : ''}`)
    .join('\n')}`;
}

export function supervisorDecisionPrompt(arch: ArchitectureOutput, assessment: string, proposals: Proposal[]): string {
  return `${SUPERVISOR_PREAMBLE}

Your current architecture:
${archText(arch)}

The Engineering Lead's assessment: ${assessment}

Proposals from the Lead (index: kind - title):
${proposals.map((p, i) => `${i}: ${p.kind} - ${p.title}\n   rationale: ${p.rationale}\n   suggestion: ${p.suggestion}`).join('\n')}

Decide each proposal by index: accept, accept_with_changes (describe changes), reject, request_analysis (the Lead must investigate further),
or escalate_human (only for decisions that genuinely need the human: product direction, irreversible trade-offs).
If decisions change the architecture, put the full revised architecture text in architectureUpdate. Set questionForHuman only when escalating.
Optionally set routingStrategy (balanced / prefer_quality / prefer_cost / prefer_speed) if the work warrants a different worker routing.`;
}

export function leadPlanPrompt(args: {
  request: string;
  arch: ArchitectureOutput;
  decisions: string;
  repos: Repository[];
  existingTasks: Task[];
  feedback: string[];
  round: number;
  workers: AgentProfile[];
  /** The run's Leads (id, agent, area); with more than one, each task names the one that owns it. */
  leads?: { id: string; agent: string; area: string | null }[];
  /** Personas already approved in earlier rounds; reuse them where they fit. */
  team?: { id: string; title: string; agent: string; effort: string | null }[];
}): string {
  const workers = args.workers
    .map((w) => `- ${w.id}: ${w.adapter}${w.model ? `/${w.model}` : ''}; reasoning ${w.capabilities.reasoningDepth}, cost ${w.capabilities.costTier}, speed ${w.capabilities.latencyTier}; specialties ${w.specialties.join(', ')}; up to ${w.maxConcurrent} at once`)
    .join('\n');
  const leads = args.leads ?? [];
  const team = args.team ?? [];
  const existing = args.existingTasks.length
    ? args.existingTasks.map((t) => `- ${t.key} [${t.status}] ${t.title} (${t.kind}): ${t.summary ?? ''}`).join('\n')
    : '(none)';
  return `${LEAD_PREAMBLE}

Human request:
"""
${args.request}
"""

Architecture (authoritative):
${archText(args.arch)}

Decisions so far:
${args.decisions}

Repositories (use these exact names in "repository"):
${args.repos.map((r) => `- ${r.name}: ${r.path}${r.testCommand ? ` (tests: \`${r.testCommand}\`)` : ''}`).join('\n')}

Existing tasks from earlier rounds (already done work stays; do not repeat it):
${existing}
${args.feedback.length ? `\nChanges requested in this round (round ${args.round}) that the new tasks must address:\n${args.feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
Decompose the work into tasks for workers. For each task:
- key: unique, like TASK-${100 + args.round * 100 + 1}, TASK-${100 + args.round * 100 + 2}, ...
- one repository; precise files/modules it will own (repo-relative paths; directories end with "/"); shared resources (ports, DB schemas, lockfiles)
- dependsOn: keys of tasks it needs first (may cross repositories). Keep the graph shallow so independent work runs in parallel.
- tasks whose files/modules overlap will be serialized; split ownership cleanly to maximize parallelism.
- modules: only a directory the task owns outright and whose files you cannot list. Never the package or repo root shared with sibling tasks; when you list files, leave modules empty.
- testsRequired must be true for any change to executable code. testCommand: the command to validate this task, or null to use the repository default.
- role: the persona from your team that does the task (its id). worker: that persona's model id (or null).
${leads.length > 1 ? `- lead: the Lead that owns the task (answers its worker, reviews it), by id, matching its area; null for the head lead.\n` : '- lead: null.\n'}
Staff a team before the work starts (the human approves it): in "team", name each persona after its job, like backend-dev,
frontend-dev, db-engineer, tester, security-reviewer, docs-writer (lowercase, dash-separated, unique). Give each a specialty,
the worker model from the list below that fits (match depth to risk and complexity; spend the cheaper ones where they suffice),
an effort level that model accepts (or null for its default), and a one-line rationale. Several tasks may share a persona;
create two personas with distinct names (backend-dev, backend-dev-2) when the same job runs in parallel.
${team.length ? `\nPersonas already approved (reuse them by id where they fit; add new ones only when needed):\n${team.map((p) => `- ${p.id}: ${p.title} (${p.agent}${p.effort ? `, ${p.effort}` : ''})`).join('\n')}\n` : ''}${leads.length > 1 ? `\nLeads:\n${leads.map((l, i) => `- ${l.id}${i === 0 ? ' (head)' : ''}: ${l.agent}${l.area ? `, owns ${l.area}` : ''}`).join('\n')}\n` : ''}
Available worker models:
${workers}`;
}

export interface WorkerContext {
  /** The persona's name (backend-dev, tester) when the plan staffed one. */
  persona?: string | null;
  answers: { question: string; answer: string }[];
  reviewFeedback: ReviewRecord | null;
  validationFailure: ValidationResult | null;
  dependencySummaries: { key: string; title: string; summary: string }[];
  guidance: string | null;
}

export function workerPrompt(task: Task, repo: Repository, arch: ArchitectureOutput | null, ctx: WorkerContext, resumed: boolean): string {
  const parts: string[] = [];
  if (!resumed) {
    parts.push(workerPreamble(task.specialty, ctx.persona));
    parts.push(`Overall architecture (from the Supervisor):\n${arch ? `${arch.summary}\n${arch.architecture}\nConstraints:\n${arch.constraints.map((c) => `- ${c}`).join('\n')}` : '(none)'}`);
    parts.push(`Your assignment ${task.key} in repository "${repo.name}": ${task.title}
${task.description}

Kind: ${task.kind}. Owned scope: files ${JSON.stringify(task.scope.files)}, modules ${JSON.stringify(task.scope.modules)}.
Acceptance criteria:
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (see description)'}
Tests required: ${task.testsRequired ? `yes${task.testCommand ?? repo.testCommand ? ` (validated with \`${task.testCommand ?? repo.testCommand}\`)` : ''}` : 'no'}.`);
    if (ctx.dependencySummaries.length) {
      parts.push(`Completed prerequisite tasks (already merged into your branch):\n${ctx.dependencySummaries.map((d) => `- ${d.key} ${d.title}: ${d.summary}`).join('\n')}`);
    }
  } else {
    parts.push('Continue your assignment with the following input from the Engineering Lead.');
  }
  if (ctx.answers.length) parts.push(`Answers from the Engineering Lead:\n${ctx.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n')}`);
  if (ctx.guidance) parts.push(`Guidance from leadership:\n${ctx.guidance}`);
  if (ctx.reviewFeedback) {
    parts.push(`The Engineering Lead requested changes (review iteration ${ctx.reviewFeedback.iteration}): ${ctx.reviewFeedback.summary}
${ctx.reviewFeedback.issues.map((i) => `- [${i.severity}] ${i.file ?? ''} ${i.description}${i.suggestion ? ` -> ${i.suggestion}` : ''}`).join('\n')}`);
  }
  if (ctx.validationFailure) {
    parts.push(`Validation failed: \`${ctx.validationFailure.command}\` exited ${ctx.validationFailure.exitCode}.\nOutput (tail):\n${ctx.validationFailure.output.slice(-4000)}`);
  }
  parts.push('When done, return your structured result (status completed), or needs_input with questions, or blocked with the reason in summary.');
  return parts.join('\n\n');
}

export function leadAnswerPrompt(task: Task, arch: ArchitectureOutput | null, questions: string[], workerSummary: string): string {
  return `${LEAD_PREAMBLE}

Worker on ${task.key} "${task.title}" asks (worker summary so far: ${workerSummary}):
${questions.map((q) => `- ${q}`).join('\n')}

Task description: ${task.description}
Architecture summary: ${arch?.summary ?? '(none)'}

Answer precisely so the worker can proceed. If the question is architectural and beyond your authority, set escalateToSupervisor with a precise escalationQuestion (still give your best interim answer).`;
}

/** Largest diff handed over inline; past it the reviewer opens files for the rest. */
const MAX_REVIEW_DIFF = 60_000;

export function leadReviewPrompt(args: {
  task: Task;
  arch: ArchitectureOutput | null;
  diff: string;
  diffStat: string;
  validation: ValidationResult;
  worker: WorkerResult;
  iteration: number;
  maxIterations: number;
}): string {
  const { task, validation } = args;
  return `${LEAD_PREAMBLE}

Review worker submission for ${task.key} "${task.title}" (iteration ${args.iteration}/${args.maxIterations}). The current directory is the worker's worktree.
Task: ${task.description}
Acceptance criteria:
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (see description)'}
Tests required: ${task.testsRequired}
Architecture constraints: ${args.arch?.constraints.join('; ') || '(none)'}

Worker report: ${args.worker.summary}
Tests the worker added: ${args.worker.testsAdded.join(', ') || 'none'}

Orchestrator validation: ${validation.skipped ? 'skipped (no test command)' : `\`${validation.command}\` ${validation.passed ? 'PASSED' : `FAILED (exit ${validation.exitCode})`}`}
${!validation.passed && !validation.skipped ? `Output tail:\n${validation.output.slice(-3000)}` : ''}

Diff stat:
${args.diffStat}

Diff:
${args.diff.length > MAX_REVIEW_DIFF ? `${args.diff.slice(0, MAX_REVIEW_DIFF)}\n... (diff truncated at ${MAX_REVIEW_DIFF} chars; open the remaining files in the stat above)` : args.diff}

Review from the diff and the validation result above: they are the complete change. Open other files only for context the diff lacks; do not re-run the tests.
Verdict: approve only if the change is correct, meets the acceptance criteria, stays within scope, and (for executable code) has adequate passing tests.
Otherwise changes_requested with actionable issues. Use escalate only for architectural problems the Supervisor must decide.
Add proposals only for something the Supervisor must reconsider for the whole project; they are reviewed together at final validation, not now.`;
}

export function leadLeaseDecisionPrompt(task: Task, conflicts: { pattern: string; holder: Task }[]): string {
  return `${LEAD_PREAMBLE}

Worker on ${task.key} "${task.title}" modified files owned by other active tasks:
${conflicts.map((c) => `- ${c.pattern} is owned by ${c.holder.key} "${c.holder.title}" [${c.holder.status}]`).join('\n')}

Decide: wait (hold ${task.key} until the owner finishes, then re-validate on top of its work), transfer (move ownership to ${task.key}; only if the owner no longer needs these files),
serialize (re-run ${task.key} after the owner, discarding the overlapping edits), or escalate (needs re-planning by the Supervisor).`;
}

export function leadIntegrationPrompt(repo: Repository, task: Task, files: string[]): string {
  return `${LEAD_PREAMBLE}

You are integrating approved work into the integration branch of repository "${repo.name}" (current directory).
Merging ${task.key} "${task.title}" produced conflicts in:
${files.map((f) => `- ${f}`).join('\n')}

Resolve every conflict so both sides' intent is preserved, remove all conflict markers, and stage the files with \`git add\`.
Do not commit and do not touch other files. Report resolved=false if a correct resolution needs a decision you cannot make.`;
}

export function supervisorValidationPrompt(args: {
  request: string;
  arch: ArchitectureOutput | null;
  tasks: Task[];
  reviews: Map<string, ReviewRecord[]>;
  integration: { repo: string; branch: string; passed: boolean; output: string }[];
  proposals: Proposal[];
  decisions: Decision[];
  /** Open proposals from task reviews, deferred to this validation. */
  deferred: Proposal[];
  diffStats: string;
}): string {
  return `${SUPERVISOR_PREAMBLE}

Final architectural validation. Human request:
"""
${args.request}
"""

Architecture:
${archText(args.arch)}

Tasks:
${args.tasks.map((t) => `- ${t.key} [${t.status}] ${t.title} (${t.kind}, iterations ${t.iteration}): ${t.summary ?? ''}${(args.reviews.get(t.id) ?? []).map((r) => `\n    review ${r.iteration}: ${r.verdict} - ${r.summary}`).join('')}`).join('\n')}

Proposals and decisions:
${decisionsText(args.proposals, args.decisions)}

Integration results (the orchestrator ran these test commands itself on the integration branch; treat them as authoritative, you do not need shell access to re-run them):
${args.integration.map((i) => `- ${i.repo} on ${i.branch}: ${i.passed ? 'tests passed' : 'TESTS FAILED'}\n${i.passed ? '' : i.output.slice(-1500)}`).join('\n')}

Proposals the Lead raised during task reviews, deferred to you (rule on each in proposalDecisions by its index; fold accepted work into requiredChanges or followUps):
${args.deferred.map((p, i) => `${i}. [${p.kind}] ${p.title}: ${p.rationale} Suggestion: ${p.suggestion}`).join('\n') || '(none)'}

Combined diff stat:
${args.diffStats}

Judge from this report: the Lead reviewed every task's diff and the orchestrator ran the tests. Inspect the integration worktrees (current directory and added dirs) only to settle a specific doubt. Verdict accept if the result satisfies the architecture and acceptance criteria;
revise with requiredChanges if more work is needed before the human sees it. Choose reportDepth proportionate to the work and fill the report fields.`;
}

export function supervisorEscalationPrompt(task: Task, reason: string, history: string): string {
  return `${SUPERVISOR_PREAMBLE}

The Engineering Lead escalated ${task.key} "${task.title}": ${reason}
History:
${history}

Decide: retry_with_guidance (give the precise guidance the worker and Lead need), abandon_task (it is not needed or must be re-planned later),
or escalate_human (only when a human decision is genuinely required; put the question in guidance).`;
}

export function supervisorRevisionPrompt(arch: ArchitectureOutput | null, feedback: string): string {
  return `${SUPERVISOR_PREAMBLE}

The run is being revised. Feedback:
${feedback}

Current architecture:
${archText(arch)}

Give guidance for the Engineering Lead's next planning round. If the architecture must change, put the full revised architecture text in architectureUpdate.`;
}
