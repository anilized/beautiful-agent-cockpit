# agent-cockpit

A local-first, hierarchical multi-agent software engineering system hosted in Claude Code.
One high-level request goes in; an event-driven workflow engine runs an engineering
organization whose compute nodes are AI agents:

```
Human ─► Opus (Supervisor / Architect) ◄─► Codex (Engineering Lead) ─► Workers (Sonnet, ...)
                                                     ▲                       │
                                                     └── review / answers ◄──┘
Codex integration ─► Opus final validation ─► Human: APPROVE / REQUEST CHANGES / REJECT
```

Agents reason. The orchestrator coordinates. Git isolates. Codex manages engineering.
Opus governs architecture. The human retains final authority.

## Quick start

```bash
npm install
node bin/cockpit.mjs doctor              # finds claude, codex, git; checks logins
node bin/cockpit.mjs daemon --detach     # start the orchestrator service
node bin/cockpit.mjs run "Add rate limiting to the API" --repo ../api --test "npm test" --repo ../gateway --test "go test ./..." --follow
node bin/cockpit.mjs status
node bin/cockpit.mjs approve <runId>     # or: changes <runId> "..." / reject <runId>
```

No API keys: the adapters drive your already-authenticated `claude` and `codex` CLIs.

### In Claude Code (the cockpit)

Load the mod in `packages/claude-plugin` (`claude --plugin-dir packages/claude-plugin`, or
install it as a plugin). Then:

| Command | |
|---|---|
| `/cockpit` | open the cockpit pane: leadership state, task graph, workers, conflicts, tests, approvals (with Approve / Reject buttons), telemetry, recent events |
| `/cockpit start` / `stop` | start / stop the orchestrator service |
| `/cockpit run <request> [--test "<cmd>"] [--repo <path> ...]` | start a run (defaults to the session's directory) |
| `/cockpit approve [note]` · `changes <text>` · `reject [note]` | decide the pending approval |
| `/cockpit report` · `status` | final engineering report · textual status |

The pane is a full control surface: runs list, animated lifecycle stepper and progress bar,
tasks / events / report tabs, workers, tests, conflicts, repos and telemetry. Focus it
(ctrl+x tab, or `/cockpit` opens it focused) and drive it by hotkeys: `n` new run (inline
prompt), `a` approve, `c` request changes (inline notes), `r` reject, `p` report, `t` retry,
`1`/`2`/`3` tabs, `j`/`k` next/previous run, `s`/`x` start/stop the orchestrator.
`claude plugin test packages/claude-plugin` renders it against a recorded snapshot.

The status line shows `cockpit: <run status> <done>/<total> · N working · N awaiting you`,
and a toast announces every new decision request. The cockpit is presentation only: it reads
the snapshot the orchestrator writes and sends decisions through the CLI.

## Architecture

```
packages/
  core/          domain model, event contracts, state machines, task + conflict graphs, agent output contracts, config schemas
  persistence/   SQLite store (node:sqlite) — the authoritative workflow state
  telemetry/     OpenTelemetry tracer; local JSONL span export, optional OTLP (Tempo/Jaeger)
  workspace/     platform layer (process/tree-kill/shims), git worktrees, file/module/resource leases
  agents/        AgentAdapter contract, ClaudeAdapter, CodexAdapter, FakeAdapter, router, role prompts
  transport/     127.0.0.1 HTTP + SSE with a per-daemon bearer token
  orchestrator/  engine (run phases), task pipeline, scheduler, review engine, permission engine, event bus, service, CLI
  claude-plugin/ the Claude Code mod (cockpit pane, status line, /cockpit command)
config/          cockpit.yaml · agents.yaml · routing.yaml · permissions.yaml
```

### Run lifecycle

```
created → architecting (Opus) → proposing (Codex challenges with evidence)
        ⇄ deciding (Opus: accept / amend / reject / request analysis / escalate to human)
        → planning (Codex: task DAG with repo, files/modules/resources, deps, tests)
        → executing (scheduler: parallel, conflict-aware, leased, isolated)
        → integrating (merge queue per repo + integration tests; conflicts → Codex, else back to the worker)
        → validating (Opus) → awaiting_approval (human)
        → merging → completed          | REQUEST CHANGES → planning (round + 1) | REJECT → rejected
```

### Task lifecycle

```
pending → ready → running ─► needs_input ─► (Codex answers; may escalate to Opus) ─► running
                    │
                    ▼ commit in worktree
               validating (leases re-checked on the real diff; test command run)
                    │                          └► lease_conflict ─► Codex: wait / transfer / serialize / escalate
                    ▼
               in_review (Codex, read-only) ─► changes_requested ─► running (same worker session resumed)
                    │                                  └ after N iterations ─► escalated ─► Opus ─► (human)
                    ▼
               approved ─► integrated
```

Hierarchy rules are structural, not prompt-level: workers' questions, blockers and submissions
are routed only to the lead; only the lead's escalations reach the supervisor; only the
supervisor (or a high-risk operation) reaches the human.

### Guarantees enforced by the orchestrator (not by model judgement)

- Every implementation task gets its own worktree + branch (`agent/<run>/<TASK>-<slug>`) under
  `<dataDir>/worktrees`; the human's working tree is never touched until the approved final merge.
- Predicted scope is leased before a task starts; the actual diff is re-leased at submission.
- A code task cannot be approved while its validation command fails, or without adequate tests —
  even if the reviewer approves.
- Failing integration tests are never presented as accepted.
- Final merge into the base branch happens only after human approval; a dirty or diverged
  base branch blocks the merge and asks again.
- High-risk commands (destructive shell, pushes, production, migrations, secrets, cloud, external
  side effects) are classified by `permissions.yaml` and require approval.
- The review → retry loop is bounded (`review.maxIterations`, default 3), then escalates
  Worker → Codex → Opus → human.

### Persistence and resumability

SQLite (`<dataDir>/cockpit.db`) holds projects, repositories, runs, tasks, dependencies, agents,
agent sessions (with provider session ids for resume), worktrees, leases, reviews, proposals,
decisions, approvals, events and model usage. Every step reads persisted status, so restarting
Claude Code, the cockpit or the orchestrator resumes active runs (`recover()` on daemon start).
`cockpit retry <run>` re-enters a failed run at the phase it failed in.

### Events and telemetry

All state changes are structured events (`run.started`, `proposal.created`, `task.assigned`,
`file.lease.conflict`, `review.issue_found`, `test.failed`, `escalation.requested`,
`approval.requested`, `integration.completed`, …) persisted in order and streamed over SSE
(`GET /events`). OpenTelemetry spans cover every phase, every agent call (role, model, tokens,
retries), tests, integration and human-approval waits; spans go to
`<dataDir>/traces/*.jsonl` and, if `telemetry.otlpEndpoint` is set, to any OTLP backend.

### Adapters and routing

`AgentAdapter` (`capabilities / startSession / execute / cancel / resume`) has Claude, Codex and
Fake implementations. Roles are bound to profiles in `agents.yaml`, not to model names; add a
provider by registering an adapter factory. The router scores workers from task metadata
(kind, specialty, risk, complexity) against capability profiles, routing rules and load; the
supervisor can switch the strategy for a run (`prefer_quality / prefer_cost / prefer_speed`).

## Integration notes (verified against the installed CLIs)

- Claude Code 2.1.x: `claude -p --output-format stream-json --json-schema …`, `--session-id` /
  `--resume`; read-only roles run with `--permission-mode dontAsk` and read-only tools; workers
  with `acceptEdits` plus the allow/deny lists in `permissions.yaml`.
- Codex CLI 0.15x/0.16x: `codex exec --json --output-schema …`, `-c sandbox_mode=…`,
  `codex exec resume <thread>`. The binary is found on PATH (npm `.cmd` shims are resolved to
  `node <script>` on Windows) or in the desktop app bundle; override with `COCKPIT_CODEX_BIN`.
- Headless agents cannot ask mid-turn, so a worker ends its turn with `needs_input`; the
  orchestrator routes the question to Codex and resumes the worker's session with the answer.
- The Claude Code mod runtime has no Node or network access; the cockpit therefore renders a
  snapshot file the orchestrator writes and acts through the CLI.

## Development

```bash
npm run typecheck
npm test                                  # unit + end-to-end (fake agents, real git worktrees)
node --import tsx scripts/smoke-adapters.ts   # exercises the real claude/codex CLIs
```
