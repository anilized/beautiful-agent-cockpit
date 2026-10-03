# beautiful-agent-cockpit

A local-first, hierarchical multi-agent software engineering system hosted in Claude Code,
with a live command-center pane in the terminal and a telemetry dashboard in the browser.
One high-level request goes in; an event-driven workflow engine runs an engineering
organization whose compute nodes are AI agents:

```
Human ─► Opus (Supervisor / Architect) ◄─► Codex (Engineering Lead) ─► Workers (Sonnet, ...)
                                                     ▲                       │
                                                     └── review / answers ◄──┘
Codex integration ─► Opus final validation ─► Human: APPROVE / REQUEST CHANGES / REJECT
```

Agents reason. The orchestrator coordinates. Git isolates. The Lead manages engineering.
The Supervisor governs architecture. The human retains final authority. Opus and Codex are the
default seats; any configured agent can take either one (see [Choosing who leads](#choosing-who-leads)).

## Quick start

```bash
npm install
node bin/cockpit.mjs doctor              # finds claude, codex, git; checks logins
node bin/cockpit.mjs daemon --detach     # start the orchestrator service
node bin/cockpit.mjs run "Add rate limiting to the API" --repo ../api --test "npm test" --repo ../gateway --test "go test ./..." --follow
node bin/cockpit.mjs status
node bin/cockpit.mjs approve <runId>     # or: changes <runId> "..." / reject <runId>
node bin/cockpit.mjs dashboard           # telemetry dashboard in the browser
```

No API keys: the adapters drive your already-authenticated `claude` and `codex` CLIs.

### In Claude Code (the cockpit)

Load the mod in `packages/claude-plugin` (`claude --plugin-dir packages/claude-plugin`, or
install it as a plugin). Then:

| Command | |
|---|---|
| `/cockpit` | open the cockpit pane (focused) |
| `/cockpit start` / `stop` | start / stop the orchestrator service |
| `/cockpit run <request> [--test "<cmd>"] [--repo <path> ...]` | start a mission (defaults to the session's directory) |
| `/cockpit approve [note]` · `changes <text>` · `reject [note]` | decide the pending approval |
| `/cockpit report` · `status` | final engineering report · textual status |
| `/cockpit dashboard` | open the telemetry dashboard in the browser (prints the link too) |

#### The pane: a command center

Modelled on lazygit-style persistent panels and agent managers such as Claude Squad: everything
that matters is on screen at once, in the same place every time.

```
◆ AGENT COCKPIT  <mission>                         executing · 13/27 · $36.20 · 3h21m  ● 16:12:35
◉ EXECUTING   ● architect ─ ● debate ─ ● plan ─ ◉ build ─ ○ integrate ─ ○ validate ─ ○ approve ─ ○ merge
┌ NEEDS YOU ─────────────────────────────────────────────────── a · Approve  c · Changes  r · Reject ┐
┌ MISSIONS ────────┐┌ TASKS 13/27 ▕██████████▏ 48% ┐┌ 1 Live  2 Task  3 Events  4 Report ─────────────┐
│ ▌⠋ Modernize UI  ││ NEEDS ATTENTION               ││ WORKER sonnet  implementing TASK-305  ⠋ 2m13s   │
│   ✓ Add utils 4/4││ RUNNING                       ││ 16:50 ✦ completed: theme tokens in theme.ts…    │
┌ AGENTS ──────────┐│ ▌⠋ TASK-305 theme tokens   ↺2 ││ 16:50 ▍ Fixing the empty-input case next…      │
│ S opus     idle  ││ IN REVIEW                     ││ 16:49 ✎ hooks/theme.ts                          │
│ L sonnet   ⠙ 302 ││ ◎ TASK-302 limits.ts          ││ 16:49 ❯ npm test 2>&1 | tail -15                │
│ W sonnet   ⠋ 305 ││ QUEUED · DONE ▸ 13            ││                                                 │
└──────────────────┘└───────────────────────────────┘└─────────────────────────────────────────────────┘
 j: down  k: up  h: agents  l: tasks  │ 1-4 view │  n: new  p: report  d: dashboard  x: stop
```

- **Header:** one animated row with the mission and its vitals; below it the run's status and the
  lifecycle stepper.
- **NEEDS YOU:** shows only while a decision waits on you; long texts open with *show all*.
- **MISSIONS:** every run with its progress; a press switches (`m` cycles).
- **AGENTS:** the Supervisor and Lead seats and every working worker: what each is doing and its
  last words; earlier sessions to read back; the seats and their efforts (`v`/`b` seats,
  `f`/`g`/`w` effort, live on a running mission); spend per agent.
- **TASKS:** grouped by what they need (attention, running, review, queued; done and cancelled
  folded, `o` opens them), the selection always in view; a press opens the task.
- **Right panel:** `1` **Live** — the followed agent's stream, newest on top: `▍` what it says it is
  doing (every model narrates one line per step), `∴` reasoning where the model publishes it
  (Codex), tool calls (`◎` read, `✎` edit, `❯` shell; ▸ opens the whole call) and `✦` what the
  call concluded (a plan's tasks, a review's verdict and issues, a ruling); `2` **Task** — the
  whole task: description, acceptance criteria, scope, worker summary, latest review; `3`
  **Events**; `4` **Report** (long reports render in parts).
- **Keys:** `j`/`k` move in the focused list, `h`/`l` switch between agents and tasks, `n` new
  mission, `a`/`c`/`r` decide, `p` report, `d` dashboard, `t` retry a failed mission, `s`/`x`
  start/stop the orchestrator. The footer shows what the focus offers.
- **Motion:** 60 fps while a mission runs (the header at the 16 ms frame; the other animated
  rasters every ≥ 66 ms; all of them under 100 blits/s, below the host's ~120/s intake), 1/s at
  rest, frozen with `COCKPIT_REDUCED_MOTION=1`. Narrower panes put the missions and agents in
  strips above the tasks and the right panel.

A toast announces every new decision request. The cockpit is presentation only: it reads the
snapshot the orchestrator writes and sends decisions through the CLI.
`claude plugin test packages/claude-plugin` renders it against recorded snapshots.

### Telemetry dashboard

`cockpit dashboard` (or `d` in the pane) opens a page the daemon serves on 127.0.0.1: spend,
tokens and cache rate, the lifecycle, a live **Minds** view of every model session (narration,
reasoning, tools, outcomes), a task board, cumulative cost per role, input tokens per call, cost
per task, a span timeline, a sortable calls table and a searchable event log. It refreshes
every few seconds. The page itself is public; its data needs a read-only token that the link
carries in its fragment (never sent to a server or logged) and that allows GETs only.

## Choosing who leads

You seat the Supervisor and the Lead; the Lead staffs the workers.

- **Per run:** pick them in the cockpit's NEW MISSION form, or `cockpit run "..." --supervisor opus --lead sonnet`.
  Unset, the run takes `hierarchy` from `config/agents.yaml`.
- **Mid-run** (a limit ran out): the seats in the AGENTS panel (`v` / `b`), or `cockpit roles <runId> --lead opus`.
  Later calls of that role go to the new agent; a call already in flight finishes where it started.
- **Effort** is chosen per seat, so one model can lead at `high` and work at `medium`:
  `cockpit run "..." --effort lead:sonnet=high --effort worker:sonnet=medium` (a bare `sonnet=high`
  sets both), or `f` / `g` / `w` in the pane; on a live mission `cockpit effort <runId> lead:sonnet=high`.
- **Who may sit where:** an agent takes a seat only if the role is in its `roles` list in `agents.yaml`
  (`cockpit agents` lists them). Supervisor and Lead must differ.
- **Workers:** the Lead names a worker per task in its plan (`worker`), chosen from the enabled workers it is shown.
  If that worker is at capacity or unknown, or the Lead leaves it null, `routing.yaml` decides.



```
packages/
  core/          domain model, event contracts, state machines, task + conflict graphs, agent output contracts, config schemas
  persistence/   SQLite store (node:sqlite) — the authoritative workflow state
  telemetry/     OpenTelemetry tracer; local JSONL span export, optional OTLP (Tempo/Jaeger)
  workspace/     platform layer (process/tree-kill/shims), git worktrees, file/module/resource leases
  agents/        AgentAdapter contract, ClaudeAdapter, CodexAdapter, FakeAdapter, router, role prompts
  transport/     127.0.0.1 HTTP + SSE with a per-daemon bearer token
  orchestrator/  engine (run phases), task pipeline, scheduler, review engine, permission engine, event bus, service,
                 CLI, telemetry dashboard (dashboard.ts / dashboard.html)
  claude-plugin/ the Claude Code mod (cockpit pane, /cockpit command; raster painters, blit scheduler, tweens, theme)
config/          cockpit.yaml · agents.yaml · routing.yaml · permissions.yaml
```

### Keeping tokens down

- **Supervisor at the end, not per task:** proposals the Lead raises while reviewing tasks are
  deferred to final validation and ruled on there in one call (`decisions.duringTasks: defer` in
  `cockpit.yaml`; `immediate` restores a Supervisor call per review). Escalations of a blocked task
  still reach the Supervisor at once.
- **Narrow hand-offs:** the Lead reviews from the diff and the orchestrator's test result (diffs
  past 60k characters are cut and opened on demand); the Supervisor validates from the report and
  inspects worktrees only to settle a specific doubt.
- **Parallel by default:** a module claim that the task's own file list already narrows is not
  leased, so tasks naming the same package but disjoint files run side by side
  (`maxParallelTasks`, default 4).

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

cd packages/claude-plugin
npm run check                             # palette (colours live in theme.ts only), typecheck, pane tests
npm run bench                             # painter cost per frame (budget: mean < 4 ms)
npm run blitrate                          # blits per second under the mock clock
```

What still needs a live terminal (frame rate, input latency, CPU) is listed in
`packages/claude-plugin/GATE0.md`.

## License

[MIT](LICENSE)
