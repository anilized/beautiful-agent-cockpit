// The shared Pixel Garage mission: one scripted run as real CockpitEvents, and `snapshotAt(seq)`, the
// Snapshot the daemon would have served right after that event. Mapper tests, the e2e test and the demo
// all play this same mission.
//
// Deterministic: every timestamp is an offset from MISSION_START_MS, every seq is counted, nothing reads
// the clock or a random source. The snapshot is folded from the events by a small independent model (the
// oracle), using the daemon's own `describe` / `detailOf` / `minds` for the text views, so what a viewer
// sees from `snapshotAt(n)` is what `buildSnapshot` would produce for the same history.
//
// The cast: council sup-1 (chair) and sup-2; leads lead-1 (head) and lead-2 (area: frontend); worker
// personas backend-dev, frontend-dev, test-engineer and docs-writer; repositories `api` and `web`.
// Repository ids equal their names here, so a task's repo reads the same in an event (`repoId`) and in the
// snapshot (`repo`). The real daemon differs: `repoId` is opaque and the snapshot's `repo` is the name, and
// events carry no id-to-name map. Mapper authors must not rely on `repoId === repo` outside this fixture.
// Likewise `blockedReason` is cleared here when a task leaves `lease_conflict`; this is assumed, not confirmed
// against the engine.
//
// What happens, in seq order (the `marks` export names the moments):
//   council architecture -> lead review + proposals -> decisions (accept / reject) -> plan, team proposed,
//   human asks for a change -> team changed -> approved -> workers run in parallel
//   TASK-1  tool use (Codex style `shell:`/`edit:`), a FAILED test, a fix, a PASSING test, review passes
//   TASK-2  worker question -> escalation worker -> lead -> supervisor -> answer, a proposal accepted with changes
//   TASK-3  starts when TASK-1 is approved; review CHANGES, then APPROVED
//   TASK-4  first session fails (agent.failed), retry, file lease conflict with TASK-2, resolved
//   integration (one conflict), validation, approval card, merge, run completed.
import { ACTIVE_TASK_STATUSES } from '@cockpit/core';
import type { AgentSessionRecord, CockpitEvent, EventPayloads, EventType, Role } from '@cockpit/core';
import type { ActiveSessionView, ProposalView, RunView, SeatView, Snapshot } from '@cockpit/orchestrator';
import { describe, detailOf, minds } from '../packages/orchestrator/src/snapshot';

export const MISSION_RUN_ID = 'run_garage01';
export const MISSION_START_MS = Date.parse('2026-03-02T09:00:00.000Z');
export const MISSION_REQUEST = 'Add rate limiting to the API and a usage meter to the web app.';

type TaskView = RunView['tasks'][number];
type Limits = Snapshot['limits'];

// ---------- the cast ----------

const MODEL: Record<string, string> = { 'claude-opus': 'claude-opus-5-5', 'claude-sonnet': 'claude-sonnet-5-5', 'codex-gpt': 'gpt-5-codex' };

const COUNCIL = [
  { id: 'sup-1', agent: 'claude-opus', effort: 'high' },
  { id: 'sup-2', agent: 'codex-gpt', effort: 'medium' },
];
const LEADS = [
  { id: 'lead-1', agent: 'codex-gpt', effort: 'high', area: null as string | null },
  { id: 'lead-2', agent: 'claude-sonnet', effort: 'medium', area: 'frontend' as string | null },
];
const PERSONAS: Record<string, { title: string; specialty: string; agent: string; effort: string | null }> = {
  'backend-dev': { title: 'Backend developer', specialty: 'backend', agent: 'codex-gpt', effort: 'medium' },
  'frontend-dev': { title: 'Frontend developer', specialty: 'frontend', agent: 'claude-sonnet', effort: 'medium' },
  'test-engineer': { title: 'Test engineer', specialty: 'test', agent: 'codex-gpt', effort: 'low' },
  'docs-writer': { title: 'Documentation writer', specialty: 'docs', agent: 'claude-sonnet', effort: 'low' },
};
/** What the human changed in the team: the test engineer moves to Claude Sonnet at a higher effort. */
const TEAM_REVISION: Record<string, { agent: string; effort: string | null }> = { 'test-engineer': { agent: 'claude-sonnet', effort: 'medium' } };

const REPOS = [
  { name: 'api', path: '/work/api', baseBranch: 'main' },
  { name: 'web', path: '/work/web', baseBranch: 'main' },
];

const AGENTS: Snapshot['agents'] = [
  { id: 'claude-opus', adapter: 'claude', model: 'claude-opus-5-5', roles: ['supervisor', 'lead', 'worker'], enabled: true, effort: 'high', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet', adapter: 'claude', model: 'claude-sonnet-5-5', roles: ['lead', 'worker'], enabled: true, effort: 'medium', efforts: ['low', 'medium', 'high'] },
  { id: 'codex-gpt', adapter: 'codex', model: 'gpt-5-codex', roles: ['supervisor', 'lead', 'worker'], enabled: true, effort: 'medium', efforts: ['low', 'medium', 'high'] },
];

interface TaskSpec {
  id: string;
  key: string;
  title: string;
  repo: string;
  specialty: string;
  persona: string;
  lead: string;
  dependsOn: string[];
  description: string;
  kind: string;
  risk: string;
  complexity: string;
  criteria: string[];
  files: string[];
  testCommand: string | null;
  testsRequired: boolean;
}

/** Task ids differ from keys on purpose: events name tasks by id, people by key. */
export const TASKS: readonly TaskSpec[] = [
  {
    id: 'task_rate', key: 'TASK-1', title: 'Add rate-limit middleware', repo: 'api', specialty: 'backend', persona: 'backend-dev', lead: 'lead-1', dependsOn: [],
    description: 'A token-bucket rate limiter in front of every API route, keyed by API token.', kind: 'feature', risk: 'medium', complexity: 'medium',
    criteria: ['Requests over the limit get 429 with Retry-After', 'Limits are configurable per token'], files: ['api/src/middleware/**'],
    testCommand: 'npm test -- rate-limit', testsRequired: true,
  },
  {
    id: 'task_meter', key: 'TASK-2', title: 'Build the usage meter widget', repo: 'web', specialty: 'frontend', persona: 'frontend-dev', lead: 'lead-2', dependsOn: [],
    description: 'A header widget that shows how much of the rate limit is used.', kind: 'feature', risk: 'low', complexity: 'medium',
    criteria: ['Shows used / limit', 'Turns amber over 80%'], files: ['web/src/meter/**'],
    testCommand: 'npm run test:ui', testsRequired: true,
  },
  {
    id: 'task_contract', key: 'TASK-3', title: 'Contract tests for rate limiting', repo: 'api', specialty: 'test', persona: 'test-engineer', lead: 'lead-1', dependsOn: ['task_rate'],
    description: 'Black-box tests that pin the 429 contract and the Retry-After header.', kind: 'test', risk: 'low', complexity: 'low',
    criteria: ['Covers the 429 contract', 'Covers per-token limits'], files: ['api/test/**'],
    testCommand: 'npm test -- contract', testsRequired: true,
  },
  {
    id: 'task_docs', key: 'TASK-4', title: 'Document the usage meter', repo: 'web', specialty: 'docs', persona: 'docs-writer', lead: 'lead-2', dependsOn: [],
    description: 'A README for the meter widget: props, states, how it reads the limit.', kind: 'docs', risk: 'low', complexity: 'low',
    criteria: ['README explains every prop'], files: ['web/src/meter/README.md'],
    testCommand: null, testsRequired: false,
  },
];
const spec = (id: string) => TASKS.find((t) => t.id === id)!;

/** The issues the lead's review raised, keyed `<taskId>:<iteration>`. */
const REVIEW_ISSUES: Record<string, NonNullable<TaskView['detail']['review']>['issues']> = {
  'task_contract:1': [
    { severity: 'major', file: 'api/test/rate-limit.contract.test.ts', description: 'No test for the Retry-After header.' },
    { severity: 'minor', file: 'api/test/rate-limit.contract.test.ts', description: 'Magic number 61 should come from the config.' },
  ],
};

/** What the human reads on an approval card: the whole question or result (the event keeps the one-line summary). */
const APPROVAL_TEXT: Record<string, string> = {
  appr_final: 'Rate limiting and the usage meter are ready to merge.\n\napi: token-bucket middleware, per-token limits, contract tests.\nweb: usage meter widget with README.\nIntegration and validation passed.',
};

// ---------- the script ----------

const all: CockpitEvent[] = [];
export const marks: Record<string, number> = {};
let seq = 0;
let clock = MISSION_START_MS;

/** Appends one event: counted seq, a clock that only moves forward by `dt` ms. */
function emit<T extends EventType>(type: T, data: EventPayloads[T], o: { dt?: number; runId?: string | null } = {}): CockpitEvent<T> {
  seq += 1;
  clock += o.dt ?? 1200;
  const e: CockpitEvent<T> = {
    seq, id: `evt_${String(seq).padStart(4, '0')}`, runId: o.runId === undefined ? MISSION_RUN_ID : o.runId, type, ts: new Date(clock).toISOString(), data,
  };
  all.push(e as unknown as CockpitEvent);
  return e;
}
/** Seqs taken by other runs' events: the stream filtered to this run is never contiguous. */
const otherRuns = (n: number) => {
  seq += n;
  clock += n * 300;
};
const mark = (name: string) => {
  marks[name] = seq;
};
const iso = (ms: number) => new Date(ms).toISOString();

interface Sess {
  id: string;
  agentId: string;
  role: Role;
  seat: string | null;
  taskId: string | null;
  contract: string;
  effort: string | null;
}
const sess = (id: string, agentId: string, role: Role, seat: string | null, contract: string, effort: string | null, taskId: string | null = null): Sess =>
  ({ id, agentId, role, seat, taskId, contract, effort });
const seatSess = (id: string, seat: { id: string; agent: string; effort: string | null }, role: Role, contract: string, taskId: string | null = null) =>
  sess(id, seat.agent, role, seat.id, contract, seat.effort, taskId);
const workerSess = (id: string, taskId: string) => {
  const t = spec(taskId);
  const live = { ...PERSONAS[t.persona]!, ...(t.persona in TEAM_REVISION && marks.teamChanged ? TEAM_REVISION[t.persona] : {}) };
  return sess(id, live.agent, 'worker', t.persona, 'WorkerResult', live.effort, taskId);
};

const start = (s: Sess, dt?: number) =>
  emit('agent.started', { agentId: s.agentId, role: s.role, sessionId: s.id, taskId: s.taskId, contract: s.contract, effort: s.effort, seat: s.seat }, { dt });
const say = (s: Sess, kind: 'text' | 'thinking' | 'tool' | 'result', text: string, dt?: number) =>
  emit('agent.output', { agentId: s.agentId, taskId: s.taskId, text, kind, role: s.role, sessionId: s.id }, { dt });
const tool = (s: Sess, name: string, detail: string, dt?: number) => say(s, 'tool', `${name}: ${detail}`, dt);
/** The session ends and its model call is billed (tokens derive from the seq; Codex calls carry no dollar cost). */
function end(s: Sess, dt?: number) {
  emit('agent.completed', { agentId: s.agentId, sessionId: s.id, taskId: s.taskId }, { dt });
  const inputTokens = 8000 + (seq % 7) * 1500;
  const outputTokens = 900 + (seq % 5) * 350;
  const costUsd = s.agentId.startsWith('codex') ? null : Math.round(((inputTokens * 15 + outputTokens * 75) / 1_000_000) * 10_000) / 10_000;
  emit('usage.recorded', { agentId: s.agentId, model: MODEL[s.agentId]!, inputTokens, outputTokens, costUsd }, { dt: 100 });
}
const taskStatus = (taskId: string, from: string, to: string, dt?: number) => emit('task.status_changed', { taskId, from, to }, { dt });
const runStatus = (from: string, to: string, dt?: number) => emit('run.status_changed', { from, to }, { dt });
const taskStart = (taskId: string, iteration: number) =>
  emit('task.started', { taskId, iteration, branch: `cockpit/${spec(taskId).key}`, worktreePath: `/work/.worktrees/${MISSION_RUN_ID}/${spec(taskId).key}` });

function buildMission(): void {
  // --- run, roles, limits ---
  emit('run.started', { request: MISSION_REQUEST, repositories: REPOS.map((r) => r.name) });
  mark('runStarted');
  emit('run.roles_changed', { supervisor: 'claude-opus', lead: 'codex-gpt', council: COUNCIL, leads: LEADS.map((l) => ({ ...l })) });
  emit('run.efforts_changed', { efforts: { 'claude-opus': 'high', 'codex-gpt': 'high', 'claude-sonnet': 'medium' } });
  emit('usage.limits', { provider: 'claude', windows: [{ name: '5h', usedPercent: 23.4, resetsAt: iso(MISSION_START_MS + 3 * 3_600_000) }, { name: '7d', usedPercent: 61, resetsAt: iso(MISSION_START_MS + 2 * 86_400_000) }] }, { runId: null });
  emit('usage.limits', { provider: 'codex', windows: [{ name: 'session', usedPercent: 12.5, resetsAt: iso(MISSION_START_MS + 4 * 3_600_000) }] }, { runId: null });
  otherRuns(3);

  // --- architecture (council chair), with a long silence after thinking ---
  runStatus('created', 'architecting');
  const arch = seatSess('ses_arch', COUNCIL[0]!, 'supervisor', 'ArchitectureOutput');
  start(arch);
  say(arch, 'thinking', 'Rate limiting belongs at the edge of the API; the meter only needs the used / limit pair.');
  mark('thinkingThenSilence');
  tool(arch, 'Read', 'api/src/server.ts', 45_000); // 45 s of silence after the thinking record
  tool(arch, 'Grep', 'router api/src');
  tool(arch, 'Glob', 'web/src/**/*.tsx');
  say(arch, 'text', 'Two repositories: api gets a middleware, web gets a header widget.');
  say(arch, 'result', 'ArchitectureOutput: middleware in api, widget in web');
  end(arch);
  emit('architecture.defined', { summary: 'Token-bucket middleware in api; usage meter widget in web.' });
  mark('architectureDefined');

  // --- proposing: the head lead reviews the architecture while sup-2 reviews it too ---
  runStatus('architecting', 'proposing');
  const leadRev = seatSess('ses_leadarch', LEADS[0]!, 'lead', 'LeadArchitectureReview');
  const councilRev = seatSess('ses_council1', COUNCIL[1]!, 'supervisor', 'CouncilReview');
  start(leadRev);
  start(councilRev);
  tool(leadRev, 'shell', 'cat api/src/server.ts');
  tool(councilRev, 'Read', 'api/src/server.ts');
  say(leadRev, 'thinking', 'A sliding window is simpler to explain, but a token bucket handles bursts.');
  say(councilRev, 'text', 'The split across two repositories is sound.');
  emit('proposal.created', { proposalId: 'prop_bucket', kind: 'alternative', title: 'Use a token bucket, not a sliding window', taskId: null });
  emit('proposal.created', { proposalId: 'prop_redis', kind: 'resource', title: 'Add Redis for shared counters', taskId: null });
  mark('proposalsPending');
  say(councilRev, 'result', 'CouncilReview: approve');
  emit('council.reviewed', { seat: 'sup-2', agentId: 'codex-gpt', subject: 'architecture', verdict: 'approve', summary: 'Sound; keep the middleware small.' });
  end(councilRev);
  say(leadRev, 'result', 'LeadArchitectureReview: 2 proposals');
  end(leadRev);
  mark('councilReviewed');

  // --- deciding: the chair accepts one proposal and rejects the other ---
  runStatus('proposing', 'deciding');
  const decide = seatSess('ses_decide', COUNCIL[0]!, 'supervisor', 'SupervisorDecisions');
  start(decide);
  tool(decide, 'Read', 'api/package.json');
  say(decide, 'text', 'The bucket is fine; Redis is not needed for one process.');
  say(decide, 'result', 'SupervisorDecisions: accept 1, reject 1');
  emit('proposal.accepted', { proposalId: 'prop_bucket', withChanges: false, rationale: 'Handles bursts without extra state.' });
  emit('proposal.rejected', { proposalId: 'prop_redis', rationale: 'One process; counters stay in memory.' });
  end(decide);
  mark('proposalsDecided');

  // --- planning: tasks, the team, the human's change ---
  runStatus('deciding', 'planning');
  const plan = seatSess('ses_plan', LEADS[0]!, 'lead', 'LeadPlan');
  start(plan);
  say(plan, 'thinking', 'Four tasks; the contract tests wait for the middleware.');
  tool(plan, 'shell', 'ls api/src');
  say(plan, 'result', 'LeadPlan: 4 tasks, 4 personas');
  emit('plan.created', { taskCount: TASKS.length, round: 1 });
  mark('planCreated');
  for (const t of TASKS) emit('task.created', { taskId: t.id, key: t.key, title: t.title, repoId: t.repo, dependsOn: t.dependsOn });
  mark('tasksCreated');
  emit('team.proposed', { personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, agent: p.agent, effort: p.effort })), approvalId: 'appr_team1' });
  mark('teamProposed');
  end(plan);
  runStatus('planning', 'awaiting_human_decision');
  emit('approval.requested', { approvalId: 'appr_team1', kind: 'team', summary: 'Approve the worker team: 4 personas', operation: null });
  mark('teamApprovalPending');
  emit('approval.changes_requested', { approvalId: 'appr_team1', response: 'Run the test engineer on Claude Sonnet.' }, { dt: 60_000 });
  mark('teamChangeRequested');
  emit('team.changed', { personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, agent: TEAM_REVISION[id]?.agent ?? p.agent, effort: TEAM_REVISION[id] ? TEAM_REVISION[id]!.effort : p.effort })) });
  mark('teamChanged');
  emit('approval.requested', { approvalId: 'appr_team2', kind: 'team', summary: 'Approve the revised team: 4 personas', operation: null });
  emit('approval.accepted', { approvalId: 'appr_team2', response: null }, { dt: 20_000 });
  mark('teamApproved');
  runStatus('awaiting_human_decision', 'executing');

  // --- execution begins: TASK-1, TASK-2 and TASK-4 run in parallel; TASK-3 waits for TASK-1 ---
  for (const id of ['task_rate', 'task_meter', 'task_docs']) {
    emit('task.assigned', { taskId: id, agentId: workerSess('x', id).agentId, reason: `${spec(id).persona} fits ${spec(id).specialty} work` });
    taskStatus(id, 'pending', 'ready', 200);
  }
  for (const id of ['task_rate', 'task_meter', 'task_docs']) {
    taskStatus(id, 'ready', 'running', 200);
    taskStart(id, 1);
    emit('file.lease.acquired', { taskId: id, pattern: spec(id).files[0]!, kind: 'write' }, { dt: 100 });
  }
  const rate1 = workerSess('ses_rate1', 'task_rate');
  const meter1 = workerSess('ses_meter1', 'task_meter');
  const docs1 = workerSess('ses_docs1', 'task_docs');
  start(rate1);
  start(meter1);
  start(docs1);
  mark('workersRunning');
  say(rate1, 'thinking', 'Token bucket per API token; refill on read, no timers.');
  tool(meter1, 'Read', 'web/src/header/Header.tsx');
  tool(docs1, 'Read', 'web/src/meter/index.ts');
  tool(rate1, 'shell', 'cat api/src/server.ts');
  tool(meter1, 'Grep', 'useLimit web/src');
  // TASK-4's first session dies; the task goes back to ready and a second session takes it.
  emit('agent.failed', { agentId: docs1.agentId, taskId: 'task_docs', error: 'adapter timed out after 600s' }, { dt: 3000 });
  mark('docsFailed');
  taskStatus('task_docs', 'running', 'ready');
  taskStatus('task_docs', 'ready', 'running', 800);
  taskStart('task_docs', 1);
  const docs2 = workerSess('ses_docs2', 'task_docs');
  start(docs2);
  tool(docs2, 'Read', 'web/src/meter/index.ts');

  // --- TASK-1: edits, a failing test, a fix, a passing test, review passes ---
  tool(rate1, 'edit', 'api/src/middleware/rate-limit.ts');
  tool(meter1, 'Glob', 'web/src/**/*.test.tsx');
  tool(rate1, 'apply_patch', 'api/src/middleware/rate-limit.ts');
  tool(docs2, 'Write', 'web/src/meter/README.md');
  tool(rate1, 'shell', 'npm test -- rate-limit');
  say(rate1, 'text', 'Wrote the middleware and ran the rate-limit tests.');
  say(rate1, 'result', 'WorkerResult: middleware added');
  end(rate1);
  mark('rateCompleted');
  taskStatus('task_rate', 'running', 'validating');
  emit('test.started', { taskId: 'task_rate', command: 'npm test -- rate-limit', scope: 'task' });
  emit('test.failed', { taskId: 'task_rate', command: 'npm test -- rate-limit', scope: 'task', output: 'FAIL api/test/rate-limit.test.ts\n  expected 429, received 200 on the 101st request' }, { dt: 4000 });
  mark('rateTestFailed');
  taskStatus('task_rate', 'validating', 'changes_requested');
  taskStatus('task_rate', 'changes_requested', 'running', 600);
  taskStart('task_rate', 2);
  const rate2 = workerSess('ses_rate2', 'task_rate');
  start(rate2);
  tool(meter1, 'Edit', 'web/src/meter/Meter.tsx');
  tool(rate2, 'shell', 'cat api/test/rate-limit.test.ts');
  say(rate2, 'thinking', 'The bucket refills before it is checked; check first.');
  tool(rate2, 'edit', 'api/src/middleware/rate-limit.ts');
  tool(rate2, 'shell', 'npm test -- rate-limit');
  say(rate2, 'result', 'WorkerResult: fixed the refill order');
  end(rate2);
  taskStatus('task_rate', 'running', 'validating');
  emit('test.started', { taskId: 'task_rate', command: 'npm test -- rate-limit', scope: 'task' });
  emit('test.passed', { taskId: 'task_rate', command: 'npm test -- rate-limit', scope: 'task' }, { dt: 4000 });
  mark('rateTestPassed');
  taskStatus('task_rate', 'validating', 'in_review');
  const rev1 = seatSess('ses_rev1', LEADS[0]!, 'lead', 'LeadReview', 'task_rate');
  emit('review.started', { taskId: 'task_rate', iteration: 2 });
  start(rev1);
  tool(rev1, 'shell', 'git diff main -- api/src/middleware');
  say(rev1, 'result', 'LeadReview: approve');
  end(rev1);
  emit('review.passed', { taskId: 'task_rate', iteration: 2, summary: 'Clean and covered by tests.' });
  taskStatus('task_rate', 'in_review', 'approved');
  emit('task.completed', { taskId: 'task_rate', summary: 'Token-bucket rate limiting with per-token limits.' });
  emit('file.lease.released', { taskId: 'task_rate', count: 1 });
  mark('rateApproved');

  // --- TASK-2: a question climbs worker -> lead -> supervisor; TASK-3 starts meanwhile ---
  tool(meter1, 'Edit', 'web/src/meter/useLimit.ts');
  emit('question.asked', { taskId: 'task_meter', questions: ['Should the meter poll the limit or subscribe to a stream?'] });
  emit('agent.waiting', { agentId: meter1.agentId, taskId: 'task_meter', question: 'Should the meter poll the limit or subscribe to a stream?' });
  mark('workerAsks');
  taskStatus('task_meter', 'running', 'needs_input');
  end(meter1);
  emit('escalation.requested', { from: 'worker', to: 'lead', taskId: 'task_meter', reason: 'Poll or stream is a design choice.' });
  mark('escalationToLead');
  taskStatus('task_contract', 'pending', 'ready');
  const ans = seatSess('ses_answer', LEADS[1]!, 'lead', 'LeadAnswer', 'task_meter');
  start(ans);
  say(ans, 'thinking', 'The API has no stream; polling is the only option without new server work.');
  tool(ans, 'Read', 'web/src/meter/useLimit.ts');
  emit('task.assigned', { taskId: 'task_contract', agentId: workerSess('x', 'task_contract').agentId, reason: 'test-engineer owns contract tests' });
  taskStatus('task_contract', 'ready', 'running', 200);
  taskStart('task_contract', 1);
  emit('file.lease.acquired', { taskId: 'task_contract', pattern: 'api/test/**', kind: 'write' }, { dt: 100 });
  const contract1 = workerSess('ses_contract1', 'task_contract');
  start(contract1);
  say(ans, 'text', 'Polling would add load on the very endpoint being limited; this needs the supervisor.');
  emit('escalation.requested', { from: 'lead', to: 'supervisor', taskId: 'task_meter', reason: 'Polling loads the limited endpoint; needs an architectural call.' });
  mark('escalationToSupervisor');
  end(ans);
  const esc = seatSess('ses_escalate', COUNCIL[0]!, 'supervisor', 'SupervisorEscalation', 'task_meter');
  start(esc);
  tool(contract1, 'Read', 'api/src/middleware/rate-limit.ts');
  tool(esc, 'Read', 'api/src/server.ts');
  say(esc, 'thinking', 'Poll every 5 s and exempt the limits endpoint from the bucket.');
  tool(contract1, 'Write', 'api/test/rate-limit.contract.test.ts');
  say(esc, 'result', 'SupervisorEscalation: poll every 5 s');
  emit('question.answered', { taskId: 'task_meter', answeredBy: 'supervisor', answer: 'Poll every 5 s; the limits endpoint is exempt from the bucket.' });
  emit('escalation.resolved', { taskId: 'task_meter', action: 'answer', guidance: 'Poll every 5 s; exempt the limits endpoint.' });
  end(esc);
  mark('escalationResolved');
  taskStatus('task_meter', 'needs_input', 'running');
  const meter2 = workerSess('ses_meter2', 'task_meter');
  start(meter2);
  emit('proposal.created', { proposalId: 'prop_poll', kind: 'implementation', title: 'Poll every 5 s with backoff on 429', taskId: 'task_meter' });
  mark('proposalPollPending');
  tool(contract1, 'shell', 'npm test -- contract');
  say(contract1, 'result', 'WorkerResult: contract tests written');
  end(contract1);
  taskStatus('task_contract', 'running', 'validating');
  emit('test.started', { taskId: 'task_contract', command: 'npm test -- contract', scope: 'task' });
  emit('test.passed', { taskId: 'task_contract', command: 'npm test -- contract', scope: 'task' }, { dt: 3500 });
  taskStatus('task_contract', 'validating', 'in_review');
  // Review of TASK-3: CHANGES first.
  const rev3a = seatSess('ses_rev3a', LEADS[0]!, 'lead', 'LeadReview', 'task_contract');
  emit('review.started', { taskId: 'task_contract', iteration: 1 });
  start(rev3a);
  tool(meter2, 'Edit', 'web/src/meter/useLimit.ts');
  tool(rev3a, 'shell', 'git diff main -- api/test');
  say(rev3a, 'result', 'LeadReview: changes requested');
  emit('review.issue_found', { taskId: 'task_contract', iteration: 1, issues: 2, summary: 'The Retry-After header is not covered.' });
  mark('reviewChanges');
  end(rev3a);
  taskStatus('task_contract', 'in_review', 'changes_requested');
  taskStatus('task_contract', 'changes_requested', 'running', 500);
  taskStart('task_contract', 2);
  const contract2 = workerSess('ses_contract2', 'task_contract');
  start(contract2);
  // The chair decides the poll proposal while the workers keep going.
  const decide2 = seatSess('ses_decide2', COUNCIL[0]!, 'supervisor', 'SupervisorDecisions');
  start(decide2);
  tool(contract2, 'Edit', 'api/test/rate-limit.contract.test.ts');
  say(decide2, 'result', 'SupervisorDecisions: accept with changes');
  emit('proposal.accepted', { proposalId: 'prop_poll', withChanges: true, rationale: 'Poll, but back off on 429 and cap at 30 s.' });
  mark('proposalPollAccepted');
  end(decide2);
  tool(contract2, 'Bash', 'npm test -- contract');
  say(contract2, 'result', 'WorkerResult: Retry-After covered');
  end(contract2);
  taskStatus('task_contract', 'running', 'validating');
  emit('test.started', { taskId: 'task_contract', command: 'npm test -- contract', scope: 'task' });
  emit('test.passed', { taskId: 'task_contract', command: 'npm test -- contract', scope: 'task' }, { dt: 3500 });
  taskStatus('task_contract', 'validating', 'in_review');
  const rev3b = seatSess('ses_rev3b', LEADS[0]!, 'lead', 'LeadReview', 'task_contract');
  emit('review.started', { taskId: 'task_contract', iteration: 2 });
  start(rev3b);
  tool(rev3b, 'shell', 'git diff main -- api/test');
  say(rev3b, 'result', 'LeadReview: approve');
  emit('review.passed', { taskId: 'task_contract', iteration: 2, summary: 'Retry-After is covered now.' });
  mark('reviewApproved');
  end(rev3b);
  taskStatus('task_contract', 'in_review', 'approved');
  emit('task.completed', { taskId: 'task_contract', summary: 'Contract tests for 429 and Retry-After.' });
  emit('file.lease.released', { taskId: 'task_contract', count: 1 });

  // --- TASK-4 finishes first and collides with TASK-2's lease ---
  tool(meter2, 'Edit', 'web/src/meter/Meter.tsx');
  tool(docs2, 'Edit', 'web/src/meter/README.md');
  say(docs2, 'result', 'WorkerResult: README written');
  end(docs2);
  taskStatus('task_docs', 'running', 'validating');
  emit('file.lease.conflict', { taskId: 'task_docs', pattern: 'web/src/meter/**', heldBy: 'task_meter' });
  emit('task.blocked', { taskId: 'task_docs', reason: 'web/src/meter/** is leased by TASK-2' });
  taskStatus('task_docs', 'validating', 'lease_conflict');
  mark('leaseConflict');
  const lease = seatSess('ses_lease', LEADS[1]!, 'lead', 'LeadLeaseDecision', 'task_docs');
  start(lease);
  say(lease, 'text', 'TASK-2 is nearly done; TASK-4 can wait for it.');
  say(lease, 'result', 'LeadLeaseDecision: wait');
  emit('file.lease.resolved', { taskId: 'task_docs', action: 'wait', rationale: 'TASK-2 finishes soon and owns the meter files.' });
  end(lease);

  // --- TASK-2 tests and review; its lease release frees TASK-4 ---
  tool(meter2, 'Bash', 'npm run test:ui');
  say(meter2, 'result', 'WorkerResult: meter polls every 5 s');
  end(meter2);
  taskStatus('task_meter', 'running', 'validating');
  emit('test.started', { taskId: 'task_meter', command: 'npm run test:ui', scope: 'task' });
  emit('test.passed', { taskId: 'task_meter', command: 'npm run test:ui', scope: 'task' }, { dt: 4000 });
  taskStatus('task_meter', 'validating', 'in_review');
  const rev2 = seatSess('ses_rev2', LEADS[1]!, 'lead', 'LeadReview', 'task_meter');
  emit('review.started', { taskId: 'task_meter', iteration: 1 });
  start(rev2);
  tool(rev2, 'Read', 'web/src/meter/Meter.tsx');
  say(rev2, 'result', 'LeadReview: approve');
  emit('review.passed', { taskId: 'task_meter', iteration: 1, summary: 'Meter polls with backoff as decided.' });
  end(rev2);
  taskStatus('task_meter', 'in_review', 'approved');
  emit('task.completed', { taskId: 'task_meter', summary: 'Usage meter widget polling every 5 s.' });
  emit('file.lease.released', { taskId: 'task_meter', count: 1 });
  mark('meterApproved');
  taskStatus('task_docs', 'lease_conflict', 'validating');
  taskStatus('task_docs', 'validating', 'in_review');
  const rev4 = seatSess('ses_rev4', LEADS[1]!, 'lead', 'LeadReview', 'task_docs');
  emit('review.started', { taskId: 'task_docs', iteration: 1 });
  start(rev4);
  tool(rev4, 'Read', 'web/src/meter/README.md');
  say(rev4, 'result', 'LeadReview: approve');
  emit('review.passed', { taskId: 'task_docs', iteration: 1, summary: 'Accurate and short.' });
  end(rev4);
  taskStatus('task_docs', 'in_review', 'approved');
  emit('task.completed', { taskId: 'task_docs', summary: 'README for the usage meter.' });
  emit('file.lease.released', { taskId: 'task_docs', count: 1 });
  mark('allApproved');

  // --- integration: api clean, web with one conflict ---
  runStatus('executing', 'integrating');
  emit('integration.started', { repoId: 'api', branch: `cockpit/integration/${MISSION_RUN_ID}`, tasks: ['task_rate', 'task_contract'] });
  emit('integration.completed', { repoId: 'api', branch: `cockpit/integration/${MISSION_RUN_ID}`, passed: true }, { dt: 2500 });
  for (const id of ['task_rate', 'task_contract']) taskStatus(id, 'approved', 'integrated', 200);
  emit('integration.started', { repoId: 'web', branch: `cockpit/integration/${MISSION_RUN_ID}`, tasks: ['task_meter', 'task_docs'] });
  emit('integration.conflict', { repoId: 'web', taskId: 'task_docs', files: ['web/src/meter/README.md'] }, { dt: 2000 });
  mark('integrationConflict');
  const integ = seatSess('ses_integrate', LEADS[0]!, 'lead', 'LeadIntegrationResult', 'task_docs');
  start(integ);
  tool(integ, 'shell', 'git merge --no-commit cockpit/TASK-4');
  tool(integ, 'apply_patch', 'web/src/meter/README.md');
  say(integ, 'result', 'LeadIntegrationResult: resolved');
  end(integ);
  emit('integration.completed', { repoId: 'web', branch: `cockpit/integration/${MISSION_RUN_ID}`, passed: true }, { dt: 2500 });
  for (const id of ['task_meter', 'task_docs']) taskStatus(id, 'approved', 'integrated', 200);
  mark('integrationDone');

  // --- validation: an integration test, the chair's verdict, the council's view ---
  runStatus('integrating', 'validating');
  emit('test.started', { taskId: null, command: 'npm test', scope: 'integration' });
  emit('test.passed', { taskId: null, command: 'npm test', scope: 'integration' }, { dt: 6000 });
  const val = seatSess('ses_validate', COUNCIL[0]!, 'supervisor', 'SupervisorValidation');
  const councilFinal = seatSess('ses_council2', COUNCIL[1]!, 'supervisor', 'CouncilReview');
  start(val);
  start(councilFinal);
  tool(val, 'Read', 'api/src/middleware/rate-limit.ts');
  tool(councilFinal, 'Read', 'web/src/meter/Meter.tsx');
  say(val, 'text', 'Both repositories integrate and the whole suite passes.');
  say(councilFinal, 'result', 'CouncilReview: approve');
  emit('council.reviewed', { seat: 'sup-2', agentId: 'codex-gpt', subject: 'result', verdict: 'approve', summary: 'The result matches the architecture.' });
  end(councilFinal);
  say(val, 'result', 'SupervisorValidation: pass');
  emit('validation.completed', { verdict: 'pass', summary: 'Rate limiting and the usage meter work end to end.' });
  mark('validationDone');
  end(val);
  runStatus('validating', 'awaiting_approval');
  emit('approval.requested', { approvalId: 'appr_final', kind: 'result', summary: 'Merge rate limiting and the usage meter', operation: 'merge' });
  mark('approvalPending');
  emit('approval.accepted', { approvalId: 'appr_final', response: null }, { dt: 90_000 });
  mark('approvalAccepted');
  runStatus('awaiting_approval', 'merging');
  emit('merge.completed', { repoId: 'api', branch: `cockpit/integration/${MISSION_RUN_ID}`, into: 'main' });
  emit('merge.completed', { repoId: 'web', branch: `cockpit/integration/${MISSION_RUN_ID}`, into: 'main' });
  mark('merged');
  runStatus('merging', 'completed');
  emit('run.completed', { outcome: 'approved' });
  mark('completed');
  emit('usage.limits', { provider: 'claude', windows: [{ name: '5h', usedPercent: 41.8, resetsAt: iso(MISSION_START_MS + 3 * 3_600_000) }, { name: '7d', usedPercent: 63.2, resetsAt: iso(MISSION_START_MS + 2 * 86_400_000) }] }, { runId: null });
}
buildMission();

/** Every event of the mission by seq, including the ones that belong to no run (`usage.limits`). Seqs are not contiguous. */
export const events: readonly CockpitEvent[] = all;
/** What `GET /events?runId=` would deliver: this run's events only. */
export const runEvents: readonly CockpitEvent[] = all.filter((e) => e.runId === MISSION_RUN_ID);
export const MISSION_LAST_SEQ = all[all.length - 1]!.seq;
/** The event with this seq, or undefined where the seq belongs to another run. */
export const eventAt = (s: number): CockpitEvent | undefined => all.find((e) => e.seq === s);
/** The mission clock (ms since epoch) at an event, for the `now` of mapper tests. */
export const tsOf = (s: number): number => Date.parse(eventAt(s)!.ts);

// ---------- snapshotAt: the oracle ----------

interface TaskRt {
  status: string;
  agentId: string | null;
  iteration: number;
  branch: string | null;
  worktree: string | null;
  blockedReason: string | null;
  summary: string | null;
  review: TaskView['detail']['review'];
  validation: TaskView['detail']['validation'];
  edited: Map<string, 'A' | 'M'>;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'apply_patch']);
/** What the Lead task list reads from an `agent.output` tool line: `Tool: detail`. */
const toolLine = (text: string) => {
  const i = text.indexOf(': ');
  return i < 0 ? { name: text, detail: '' } : { name: text.slice(0, i), detail: text.slice(i + 2) };
};

export interface SnapshotOptions {
  /**
   * Only the last N events of the run are scanned for each session's seat, contract and latest tool/output,
   * as the daemon's scan has a window. A session whose last tool call fell outside it reports `lastTool: null`.
   */
  scanWindow?: number;
}

/** The Snapshot the daemon would serve right after event `upToSeq` (clamped to the mission). */
export function snapshotAt(upToSeq: number, opts: SnapshotOptions = {}): Snapshot {
  const lastSeq = Math.min(upToSeq, MISSION_LAST_SEQ);
  const upTo = all.filter((e) => e.seq <= lastSeq);
  const run = upTo.filter((e) => e.runId === MISSION_RUN_ID);
  const generatedAt = upTo.length ? upTo[upTo.length - 1]!.ts : iso(MISSION_START_MS);
  const keyOf = (id: unknown) => TASKS.find((t) => t.id === id)?.key ?? String(id ?? '');

  // Folded state.
  let created = false;
  let status = 'created';
  let round = 0;
  let error: string | null = null;
  let supervisor = 'claude-opus';
  let lead = 'codex-gpt';
  let council: { id: string; agent: string; effort: string | null }[] = [COUNCIL[0]!];
  let leads: { id: string; agent: string; effort: string | null; area?: string | null }[] = [{ id: 'lead-1', agent: 'codex-gpt', effort: 'high' }];
  let efforts: Record<string, string> = {};
  let team: { id: string; agent: string; effort: string | null }[] = [];
  const integration = new Map<string, { branch: string; passed: boolean }>();
  const taskIds: string[] = [];
  const rt = new Map<string, TaskRt>();
  const sessions: AgentSessionRecord[] = [];
  const proposals = new Map<string, ProposalView>();
  const approvals = new Map<string, { id: string; kind: string; operation: string | null; summary: string; createdAt: string; status: string }>();
  const leaseConflicts: { task: string; pattern: string; heldBy: string; ts: string }[] = [];
  const usage = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
  const limits: Limits = {};

  for (const e of upTo) {
    const d = e.data as Record<string, any>;
    switch (e.type) {
      case 'run.started':
        created = true;
        break;
      case 'run.status_changed':
        status = d.to;
        break;
      case 'run.roles_changed':
        supervisor = d.supervisor;
        lead = d.lead;
        if (d.council) council = d.council;
        if (d.leads) leads = d.leads;
        break;
      case 'run.efforts_changed':
        efforts = d.efforts;
        break;
      case 'run.completed':
        if (d.outcome === 'failed') error = d.reason ?? 'failed';
        break;
      case 'plan.created':
        round = d.round;
        break;
      case 'team.proposed':
      case 'team.changed':
        team = d.personas;
        break;
      case 'task.created':
        taskIds.push(d.taskId);
        rt.set(d.taskId, { status: 'pending', agentId: null, iteration: 0, branch: null, worktree: null, blockedReason: null, summary: null, review: null, validation: null, edited: new Map() });
        break;
      case 'task.assigned':
        rt.get(d.taskId)!.agentId = d.agentId;
        break;
      case 'task.started': {
        const t = rt.get(d.taskId)!;
        t.iteration = d.iteration;
        t.branch = d.branch;
        t.worktree = d.worktreePath;
        break;
      }
      case 'task.status_changed': {
        const t = rt.get(d.taskId)!;
        t.status = d.to;
        if (d.to === 'running' || d.to === 'ready' || d.from === 'lease_conflict') t.blockedReason = null;
        // A task that needs no tests passes validation as skipped.
        if (d.to === 'in_review' && !t.validation && !spec(d.taskId).testCommand) t.validation = { command: null, passed: true, skipped: true, output: '' };
        break;
      }
      case 'task.blocked':
        rt.get(d.taskId)!.blockedReason = d.reason;
        break;
      case 'task.completed':
        rt.get(d.taskId)!.summary = d.summary;
        break;
      case 'review.issue_found':
        rt.get(d.taskId)!.review = { iteration: d.iteration, verdict: 'changes_requested', summary: d.summary, issues: REVIEW_ISSUES[`${d.taskId}:${d.iteration}`] ?? [] };
        break;
      case 'review.passed':
        rt.get(d.taskId)!.review = { iteration: d.iteration, verdict: 'approve', summary: d.summary, issues: [] };
        break;
      case 'test.passed':
      case 'test.failed':
        if (d.scope === 'task' && d.taskId) {
          rt.get(d.taskId)!.validation = { command: d.command, passed: e.type === 'test.passed', skipped: false, output: e.type === 'test.failed' ? String(d.output) : 'ok' };
        }
        break;
      case 'file.lease.conflict':
        leaseConflicts.push({ task: keyOf(d.taskId), pattern: d.pattern, heldBy: keyOf(d.heldBy), ts: e.ts });
        break;
      case 'integration.completed':
        integration.set(d.repoId, { branch: d.branch, passed: d.passed });
        break;
      case 'agent.started':
        sessions.push({ id: d.sessionId, runId: MISSION_RUN_ID, taskId: d.taskId ?? null, agentId: d.agentId, role: d.role, externalId: null, status: 'active', cwd: '', startedAt: e.ts, endedAt: null });
        break;
      case 'agent.completed': {
        const s = sessions.find((x) => x.id === d.sessionId);
        if (s) {
          s.status = 'completed';
          s.endedAt = e.ts;
        }
        break;
      }
      case 'agent.failed':
        for (const s of sessions) {
          if (s.status !== 'active' || s.agentId !== d.agentId || s.taskId !== (d.taskId ?? null)) continue;
          s.status = 'failed';
          s.endedAt = e.ts;
        }
        break;
      case 'agent.output': {
        // The worktree's changed files: what the task's workers edited.
        const t = d.taskId ? rt.get(d.taskId) : undefined;
        const { name, detail } = toolLine(String(d.text));
        if (t && d.kind === 'tool' && d.role === 'worker' && EDIT_TOOLS.has(name)) t.edited.set(detail, name === 'Write' && !t.edited.has(detail) ? 'A' : t.edited.get(detail) ?? 'M');
        break;
      }
      case 'proposal.created':
        proposals.set(d.proposalId, { id: d.proposalId, kind: d.kind, title: d.title, status: 'open', task: d.taskId ? keyOf(d.taskId) : null });
        break;
      case 'proposal.accepted':
        proposals.get(d.proposalId)!.status = d.withChanges ? 'accepted_with_changes' : 'accepted';
        break;
      case 'proposal.rejected':
        proposals.get(d.proposalId)!.status = 'rejected';
        break;
      case 'proposal.escalated':
        proposals.get(d.proposalId)!.status = 'escalated';
        break;
      case 'approval.requested':
        approvals.set(d.approvalId, { id: d.approvalId, kind: d.kind, operation: d.operation ?? null, summary: d.summary, createdAt: e.ts, status: 'pending' });
        break;
      case 'approval.accepted':
        approvals.get(d.approvalId)!.status = 'accepted';
        break;
      case 'approval.rejected':
        approvals.get(d.approvalId)!.status = 'rejected';
        break;
      case 'approval.changes_requested':
        approvals.get(d.approvalId)!.status = 'changes_requested';
        break;
      case 'usage.recorded': {
        const u = usage.get(d.agentId) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        u.calls += 1;
        u.inputTokens += d.inputTokens;
        u.outputTokens += d.outputTokens;
        u.costUsd += d.costUsd ?? 0;
        usage.set(d.agentId, u);
        break;
      }
      case 'usage.limits':
        limits[d.provider as 'claude' | 'codex'] = { windows: d.windows, at: e.ts };
        break;
      default:
        break;
    }
  }

  // The daemon's scan: seat, contract and effort from agent.started; latest tool and output per session.
  const scanned = opts.scanWindow === undefined ? run : run.slice(-opts.scanWindow);
  const started = new Map<string, { seat: string | null; contract: string | null; effort: string | null }>();
  const lastTool = new Map<string, NonNullable<ActiveSessionView['lastTool']>>();
  const lastOutput = new Map<string, NonNullable<ActiveSessionView['lastOutput']>>();
  for (const e of scanned) {
    const d = e.data as Record<string, any>;
    if (e.type === 'agent.started') started.set(d.sessionId, { seat: d.seat ?? null, contract: d.contract ?? null, effort: d.effort ?? null });
    if (e.type === 'agent.output' && d.sessionId) {
      lastOutput.set(d.sessionId, { kind: d.kind ?? 'text', at: e.ts, seq: e.seq });
      if (d.kind === 'tool') lastTool.set(d.sessionId, { text: String(d.text).slice(0, 200), at: e.ts, seq: e.seq });
    }
  }
  const active = sessions.filter((s) => s.status === 'active');
  const seatOfSession = new Map([...started].filter(([, v]) => v.seat).map(([id, v]) => [id, v.seat!]));
  const stateOf = (pred: (s: AgentSessionRecord) => boolean) => {
    const s = active.find(pred);
    return s ? `working${s.taskId ? ` on ${keyOf(s.taskId)}` : ''}` : 'idle';
  };
  const seatView = (s: { id: string; agent: string; effort: string | null; area?: string | null }): SeatView => ({
    id: s.id, agent: s.agent, effort: s.effort, area: s.area ?? null, state: stateOf((x) => seatOfSession.get(x.id) === s.id),
  });
  const roleState = (agentId: string, role: Role) => stateOf((x) => x.agentId === agentId && x.role === role);

  const taskViews: TaskView[] = taskIds.map((id) => {
    const s = spec(id);
    const t = rt.get(id)!;
    const live = ['running', 'needs_input', 'validating', 'in_review', 'changes_requested', 'lease_conflict', 'escalated', 'approved'].includes(t.status) && t.edited.size
      ? { files: [...t.edited].map(([path, st]) => ({ status: st, path })), preview: null }
      : null;
    return {
      id, worktree: t.worktree, key: s.key, title: s.title, status: t.status, specialty: s.specialty, agentId: t.agentId, repo: s.repo,
      iteration: t.iteration, branch: t.branch, dependsOn: s.dependsOn.map(keyOf), blockedReason: t.blockedReason,
      detail: {
        description: s.description, kind: s.kind, risk: s.risk, complexity: s.complexity, acceptanceCriteria: s.criteria,
        scope: { files: s.files, modules: [], resources: [] }, testsRequired: s.testsRequired, testCommand: s.testCommand,
        summary: t.summary, review: t.review, validation: t.validation,
      },
      live, persona: s.persona, lead: s.lead,
    };
  });

  const view: RunView = {
    id: MISSION_RUN_ID, request: MISSION_REQUEST, status, round, error, createdAt: iso(MISSION_START_MS + 1200),
    roles: { supervisor, lead }, efforts,
    leadership: { supervisor: roleState(supervisor, 'supervisor'), lead: roleState(lead, 'lead') },
    council: council.map(seatView), leads: leads.map(seatView),
    team: team.map((p) => {
      const busy = active.filter((x) => seatOfSession.get(x.id) === p.id).map((x) => keyOf(x.taskId));
      const mine = taskViews.filter((t) => t.persona === p.id).map((t) => t.key);
      return { id: p.id, title: PERSONAS[p.id]!.title, specialty: PERSONAS[p.id]!.specialty, agent: p.agent, effort: p.effort, tasks: mine, state: busy.length ? `working on ${busy.join(', ')}` : 'idle' };
    }),
    repositories: created ? REPOS.map((r) => ({ ...r, integration: integration.get(r.name) ?? null })) : [],
    tasks: taskViews,
    workers: active.filter((s) => s.role === 'worker').map((s) => ({ agentId: s.agentId, role: s.role, task: s.taskId ? keyOf(s.taskId) : null, since: s.startedAt })),
    conflicts: leaseConflicts.filter((c) => {
      const t = taskViews.find((x) => x.key === c.task);
      return t && (t.status === 'lease_conflict' || ACTIVE_TASK_STATUSES.has(t.status as never));
    }),
    tests: run.filter((e) => e.type.startsWith('test.')).slice(-10).map((e) => {
      const d = e.data as { scope: string; command: string; taskId?: string | null };
      return { scope: d.scope, command: d.command, status: e.type.slice(5), task: d.taskId ? keyOf(d.taskId) : null, ts: e.ts };
    }),
    telemetry: (() => {
      const by = [...usage].sort(([a], [b]) => a.localeCompare(b)).map(([agentId, u]) => ({ agentId, ...u }));
      return {
        calls: by.reduce((n, u) => n + u.calls, 0), inputTokens: by.reduce((n, u) => n + u.inputTokens, 0),
        outputTokens: by.reduce((n, u) => n + u.outputTokens, 0), costUsd: by.reduce((n, u) => n + u.costUsd, 0), byAgent: by,
      };
    })(),
    recentEvents: scanned.slice(-40).map((e) => ({ ts: e.ts, type: e.type, text: describe(e, keyOf), detail: detailOf(e, keyOf) })),
    minds: minds(sessions, [...scanned], keyOf),
    activeSessions: active.map((s): ActiveSessionView => ({
      sessionId: s.id, agentId: s.agentId, role: s.role, seat: started.get(s.id)?.seat ?? null, contract: started.get(s.id)?.contract ?? null,
      effort: started.get(s.id)?.effort ?? null, task: s.taskId ? keyOf(s.taskId) : null, startedAt: s.startedAt,
      lastTool: lastTool.get(s.id) ?? null, lastOutput: lastOutput.get(s.id) ?? null,
    })),
    // Pending ones, and the last ten decided (the fixture never has more than ten).
    proposals: [...proposals.values()],
  };

  return {
    lastSeq,
    generatedAt,
    daemon: { pid: 4242, port: 7788 },
    hierarchy: { supervisor: 'claude-opus', lead: 'codex-gpt' },
    agents: AGENTS,
    runs: created ? [view] : [],
    pendingApprovals: [...approvals.values()].filter((a) => a.status === 'pending').map((a) => ({
      id: a.id, runId: MISSION_RUN_ID, kind: a.kind, operation: a.operation, summary: a.summary, text: APPROVAL_TEXT[a.id] ?? a.summary, createdAt: a.createdAt,
    })),
    limits,
  };
}
