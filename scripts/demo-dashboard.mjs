#!/usr/bin/env node
// Serves the telemetry dashboard with a made-up mission, no daemon or agents needed:
// for working on the page and for the README's screenshots.
//
//   node scripts/demo-dashboard.mjs              → http://127.0.0.1:4777/dashboard#token=c0ffee
//   DEMO_THEME=neon node scripts/demo-dashboard.mjs
//   PORT=5000 node scripts/demo-dashboard.mjs
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = () => readFileSync(join(root, 'packages', 'orchestrator', 'src', 'dashboard.html'), 'utf8');
const port = Number(process.env.PORT ?? 4777);

function telemetry() {
  const now = Date.now();
  const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const start = at(47);
  const request = '# Add rate limiting to the public API\n\nToken bucket per API key, 429 with Retry-After, limits configurable per plan, and an admin view of current usage.';
  const council = [
    { id: 'sup-1', agent: 'opus', effort: 'high', area: null, state: 'idle' },
    { id: 'sup-2', agent: 'codex', effort: 'medium', area: null, state: 'idle' },
  ];
  const leads = [
    { id: 'lead-1', agent: 'codex', effort: 'high', area: 'backend', state: 'working on TASK-102' },
    { id: 'lead-2', agent: 'sonnet', effort: 'medium', area: 'frontend', state: 'idle' },
  ];
  const team = [
    { id: 'backend-dev', title: 'Backend developer', specialty: 'backend', agent: 'sonnet', effort: 'high', tasks: ['TASK-101', 'TASK-103'], state: 'working on TASK-103' },
    { id: 'tester', title: 'Test engineer', specialty: 'test', agent: 'haiku', effort: 'low', tasks: ['TASK-104'], state: 'idle' },
    { id: 'ui-dev', title: 'Frontend developer', specialty: 'frontend', agent: 'sonnet', effort: 'medium', tasks: ['TASK-105'], state: 'working on TASK-105' },
  ];
  const task = (key, title, status, specialty, persona, lead, agentId, round, iteration, dependsOn, description) => ({ key, title, status, iteration, agentId, description, dependsOn, round, specialty, persona, lead });
  const tasks = [
    task('TASK-101', 'Token bucket store in Redis', 'integrated', 'backend', 'backend-dev', 'lead-1', 'sonnet', 0, 1, [], 'A token bucket per API key in Redis (atomic Lua script), refill rate and burst from the key\'s plan.'),
    task('TASK-102', 'Rate-limit middleware with 429 + Retry-After', 'in_review', 'backend', 'backend-dev', 'lead-1', 'sonnet', 0, 2, ['TASK-101'], 'Express middleware: consume a token per request; on empty bucket answer 429 with Retry-After and X-RateLimit-* headers.'),
    task('TASK-103', 'Per-plan limits in config', 'running', 'backend', 'backend-dev', 'lead-1', 'sonnet', 0, 1, ['TASK-101'], 'Limits per plan (free / pro / enterprise) in config/limits.yaml, hot-reloaded.'),
    task('TASK-104', 'Load tests for the limiter', 'pending', 'test', 'tester', 'lead-1', null, 0, 0, ['TASK-102'], 'k6 scenario: a burst over the limit gets 429s, steady traffic under it never does.'),
    task('TASK-105', 'Admin usage view', 'running', 'frontend', 'ui-dev', 'lead-2', 'sonnet', 0, 1, [], 'A table of keys with their plan, tokens left and 429s in the last hour.'),
  ];
  const mind = (sessionId, agentId, role, seat, task, contract, effort, status, startMin, endMin, activity) => ({
    sessionId, agentId, role, seat, task, contract, effort, status, startedAt: at(startMin), endedAt: endMin === null ? null : at(endMin),
    activity: activity.map(([min, kind, text]) => ({ ts: at(min), kind, text })),
  });
  const minds = [
    mind('s9', 'sonnet', 'worker', 'ui-dev', 'TASK-105', 'WorkerResult', 'medium', 'active', 6, null, [
      [5.8, 'text', 'Reading the admin layout to match the existing tables.'],
      [5.6, 'tool', 'Read: src/admin/KeysTable.tsx'],
      [4.1, 'text', 'Adding a UsageTable with plan, tokens left and recent 429s; polling every 10 s.'],
      [3.9, 'tool', 'Write: src/admin/UsageTable.tsx'],
      [1.2, 'tool', 'Bash: npm test -- UsageTable'],
    ]),
    mind('s8', 'sonnet', 'worker', 'backend-dev', 'TASK-103', 'WorkerResult', 'high', 'active', 9, null, [
      [8.7, 'text', 'Limits move out of code into config/limits.yaml, watched for changes.'],
      [8.2, 'tool', 'Edit: src/limits/plans.ts'],
      [5.0, 'tool', 'Write: config/limits.yaml'],
      [0.6, 'text', 'Hot reload works; adding a test that a changed limit applies to the next request.'],
    ]),
    mind('s7', 'codex', 'lead', 'lead-1', 'TASK-102', 'LeadReview', 'high', 'active', 3, null, [
      [2.9, 'thinking', 'The middleware consumes before auth runs, so anonymous floods spend a real key\'s bucket. Check the order in app.ts.'],
      [2.4, 'tool', 'shell: rg -n "rateLimit" src/app.ts'],
      [1.0, 'thinking', 'Order is wrong: limiter is mounted before authenticate(). Retry-After is right; header names follow the draft RFC.'],
    ]),
    mind('s6', 'sonnet', 'worker', 'backend-dev', 'TASK-102', 'WorkerResult', 'high', 'completed', 19, 12, [
      [18.5, 'text', 'Middleware first, then headers; the Lua script from TASK-101 does the atomic part.'],
      [16.0, 'tool', 'Write: src/middleware/rateLimit.ts'],
      [13.1, 'tool', 'Bash: npm test -- rateLimit'],
      [12.1, 'result', 'completed: 429 with Retry-After and X-RateLimit-* headers\n12 tests added, all pass'],
    ]),
    mind('s3', 'codex', 'lead', 'lead-1', null, 'LeadPlan', 'high', 'completed', 37, 33, [
      [36.0, 'thinking', 'Five tasks; the store first, middleware and config in parallel on top of it, the UI on its own.'],
      [33.2, 'result', 'Plan: 5 tasks · team backend-dev (sonnet high), tester (haiku low), ui-dev (sonnet medium)'],
    ]),
    mind('s2', 'codex', 'supervisor', 'sup-2', null, 'CouncilReview', 'medium', 'completed', 43, 41, [
      [41.2, 'result', 'approve: sound design\nconcern: decide whether limits apply per key or per account'],
    ]),
    mind('s1', 'opus', 'supervisor', 'sup-1', null, 'ArchitectureOutput', 'high', 'completed', 47, 43, [
      [46.5, 'text', 'Reading the API gateway and the auth flow before drawing the limiter in.'],
      [45.0, 'tool', 'Read: src/app.ts'],
      [43.1, 'result', 'Architecture: Redis token bucket per key, Express middleware after auth, limits per plan in config'],
    ]),
  ];
  const call = (min, agentId, role, model, task, input, cached, output, cost, secs) => ({ ts: at(min), agentId, role, model, task, inputTokens: input, cachedTokens: cached, outputTokens: output, costUsd: cost, durationMs: secs * 1000 });
  const calls = [
    call(43, 'opus', 'supervisor', 'opus', null, 182_000, 120_000, 4_100, 0.61, 240),
    call(41, 'codex', 'supervisor', 'gpt-5', null, 64_000, 41_000, 1_200, 0.12, 95),
    call(39, 'codex', 'lead', 'gpt-5', null, 98_000, 70_000, 2_300, 0.18, 130),
    call(36, 'opus', 'supervisor', 'opus', null, 120_000, 98_000, 2_000, 0.33, 80),
    call(33, 'codex', 'lead', 'gpt-5', null, 110_000, 82_000, 3_600, 0.21, 240),
    call(26, 'sonnet', 'worker', 'sonnet', 'TASK-101', 420_000, 360_000, 5_800, 0.42, 410),
    call(24, 'codex', 'lead', 'gpt-5', 'TASK-101', 58_000, 30_000, 1_400, 0.09, 70),
    call(12, 'sonnet', 'worker', 'sonnet', 'TASK-102', 510_000, 455_000, 6_200, 0.47, 420),
    call(10, 'codex', 'lead', 'gpt-5', 'TASK-102', 61_000, 32_000, 1_600, 0.1, 85),
    call(7, 'sonnet', 'worker', 'sonnet', 'TASK-102', 230_000, 214_000, 2_900, 0.19, 180),
  ];
  const span = (name, startMin, secs, role, agentId, taskKey, contract) => ({ name, start: at(startMin), durationMs: secs * 1000, status: 'ok', error: null, role, agentId, task: taskKey, contract, inputTokens: null, outputTokens: null });
  const spans = [
    span('phase.architecture', 47, 360, null, null, null, null), span('opus.architecture', 47, 240, 'supervisor', 'opus', null, 'ArchitectureOutput'),
    span('council.architecture', 43, 95, 'supervisor', 'codex', null, 'CouncilReview'),
    span('phase.proposals', 41, 140, null, null, null, null), span('codex.architecture_review', 41, 130, 'lead', 'codex', null, 'LeadArchitectureReview'),
    span('phase.planning', 37, 260, null, null, null, null), span('codex.planning', 37, 240, 'lead', 'codex', null, 'LeadPlan'),
    span('phase.execution', 33, 1980, null, null, null, null),
    span('worker.execute', 33, 410, 'worker', 'sonnet', 'TASK-101', 'WorkerResult'), span('codex.review', 25, 70, 'lead', 'codex', 'TASK-101', 'LeadReview'),
    span('worker.execute', 19, 420, 'worker', 'sonnet', 'TASK-102', 'WorkerResult'), span('codex.review', 11, 85, 'lead', 'codex', 'TASK-102', 'LeadReview'),
    span('worker.execute', 9, 540, 'worker', 'sonnet', 'TASK-103', 'WorkerResult'), span('worker.execute', 6, 360, 'worker', 'sonnet', 'TASK-105', 'WorkerResult'),
  ];
  const ev = (seq, min, type, text, taskKey = null) => ({ seq, ts: at(min), type, task: taskKey, agentId: null, text, detail: text });
  const events = [
    ev(1, 47, 'run.started', 'mission started: Add rate limiting to the public API'),
    ev(2, 43, 'architecture.defined', 'Redis token bucket per key, middleware after auth, limits per plan'),
    ev(3, 41, 'council.reviewed', 'sup-2 codex: approve — decide per key or per account'),
    ev(4, 33, 'plan.created', '5 tasks, round 0'),
    ev(5, 33, 'team.proposed', 'backend-dev sonnet high · tester haiku low · ui-dev sonnet medium'),
    ev(6, 32, 'approval.accepted', 'team approved'),
    ev(7, 24, 'review.passed', 'TASK-101 approved by lead-1', 'TASK-101'),
    ev(8, 21, 'task.status_changed', 'TASK-101 approved -> integrated', 'TASK-101'),
    ev(9, 10, 'review.issue_found', 'TASK-102: limiter mounted before authenticate()', 'TASK-102'),
    ev(10, 7, 'test.passed', 'npm test -- rateLimit', 'TASK-102'),
  ];
  return {
    generatedAt: new Date().toISOString(),
    runs: [
      { id: 'run_demo000000000001', request, status: 'executing', createdAt: start },
      { id: 'run_demo000000000000', request: 'Add an audit log for admin actions', status: 'completed', createdAt: at(300) },
    ],
    run: { id: 'run_demo000000000001', request, status: 'executing', createdAt: start, updatedAt: at(0) },
    calls, tasks, minds, spans, events,
    crew: { council, leads, team },
    limits: {
      claude: { windows: [{ name: '5h', usedPercent: 21, resetsAt: new Date(now + 3 * 3600_000).toISOString() }, { name: '7d', usedPercent: 38, resetsAt: new Date(now + 4 * 86400_000).toISOString() }], at: at(0) },
      codex: { windows: [{ name: '5h', usedPercent: 9, resetsAt: new Date(now + 4 * 3600_000).toISOString() }, { name: '7d', usedPercent: 16, resetsAt: new Date(now + 6 * 86400_000).toISOString() }], at: at(0) },
    },
    brand: process.env.COCKPIT_BRAND || 'ANILDEV',
    theme: process.env.DEMO_THEME === 'neon' ? 'neon' : 'phosphor',
  };
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/dashboard' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(page());
  }
  if (url.pathname === '/telemetry') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify(telemetry()));
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`demo dashboard: http://127.0.0.1:${port}/dashboard#token=c0ffee`));
