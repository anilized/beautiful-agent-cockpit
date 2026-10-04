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

A dense, panel-per-concern layout after lazygit and agent managers such as Claude Squad: every
agent, task and change is on screen at once, in the same place every time.

```
◎ ANILDEV  // MULTI-AGENT CODING COCKPIT                ⎇ api   ● executing   3 agents   $12.40   15:24:36
┌ MISSIONS ──────────┐┌ API / ADD JOB RETRY ENDPOINT   ⎇ main  #a1b2c3  ● executing  12m ┐┌ TASKS (8)  3 done ────── + New mission ┐
│ ▌● Job retry  3/8  ││ ● architect ─ ● debate ─ ● plan ─ ◉ build ─ ○ integrate …          ││ ● Implement retry endpoint backend ▕████▏ build │
│   ✓ Audit log 4/4  ││ ▕████████████▏ 38%                                                 ││ ◉ Retry button UI      frontend ▕█████▏ review│
├ AGENTS ── 3 working┤│ 1 Log  2 Task  3 Events  4 Report                                   ││ ○ Integration tests    test     ▕     ▏ queued│
│ ○ opus · chair  idle││ 15:24:20 [BACKEND-DEV] ✔ completed: JobRetryController + tests     │├ AGENT: BACKEND-DEV ──── ● working 2m18s ┤
│ ◉ codex · head think││ 15:24:12 [ORCH       ] ✔ test.passed task TASK-101                 ││ src/…/JobRetryService.java            M │
│ ◉ backend-dev   run ││ 15:23:58 [LEAD       ] ◎ Read src/…/JobRetryService.java           ││ src/…/JobRetryRequest.java            A │
│ CREW               ││ 15:23:31 [BACKEND-DEV] ✎ Edit src/…/JobRetryController.java       ││                                         │
├────────────────────┤└─────────────────────────────────────────────────────────────────────┘└─────────────────────────────────────────┘
│                    │┌ CODE PREVIEW  …/JobRetryController.java ──┐┌ TEAM ──────── 2 workers ┐┌ AGENT OUTPUT (backend) ────────────────┐
│                    ││   12   12   @RestController                ││ ◉ YOU     approve · merge││ 15:24 ✦ completed: endpoint + 12 tests  │
│                    ││        15 + @PostMapping("/{id}/retry")    ││ ◆ COUNCIL ○ ★opus ⚡high  ││ 15:23 ▍ Writing the audit test next…    │
└────────────────────┘└────────────────────────────────────────────┘└──────────────────────────┘└─────────────────────────────────────────┘
 j: down  k: up  h: agents  l: tasks  │ 1-4 view │  n: new  p: report  d: dashboard  x: stop
```

- **Home:** with nothing under way (or `0` / `◂ home` from a mission) the cockpit opens on an
  overview: missions, running, waiting on you, spend, calls and what is left of each subscription;
  every mission with its status and progress (a press or `1`–`9` opens it); the latest mission's team;
  recent milestones across missions; and the crew for the next mission with `n`. A mission under way
  opens by itself.
- **Header:** the brand, and the mission's repository, status, working agents, spend, what is left
  of each subscription (`◔ claude 86% · codex 100%`) and the clock.
- **NEEDS YOU:** shows only while a decision waits on you (`a` approve, `c` changes, `r` reject).
  For a **team** it lists each worker by name with its model and effort: press either to change
  it, `⧉` adds a second one for parallel work, `×` drops one; `c` sends the plan back with a note.
- **MISSIONS:** every run with its progress; a press switches (`m` cycles).
- **AGENTS:** every council seat, every lead and every worker by its name (backend-dev, tester…),
  each `running`, `thinking` or `idle`; earlier sessions to read back; the **CREW** (council and
  leads with their efforts, editable live: `v`/`b` the chair / head lead, `f`/`g` their effort, or
  press any chip).
- **PLAN LEFT** (bottom left, out of the way): each subscription window's remaining share and when
  it resets, then the mission's **SPEND** per agent.
- **Centre:** the mission (repository / request, branch, run, status, elapsed), the animated
  lifecycle and progress, then `1` **Log** — one feed of every agent and the orchestrator, newest
  on top: what each model says it is doing, tools (`◎` read, `✎` edit, `❯` shell), reasoning
  where the model publishes it (`∴`, Codex), `✔` outcomes (a plan, a verdict, a ruling) and
  milestones (tests, reviews, integration); `2` **Task** — the selected task in full; `3`
  **Events**; `4` **Report** (long reports render in parts).
- **TASKS:** each task's specialty, title and how far through the pipeline it is (queued, build,
  test, review, done); finished work folds (`o`). A press selects it.
- **AGENT:** the followed agent's state and the files its task changed in its worktree (`M`/`A`/`D`).
- **CODE PREVIEW:** the biggest change of the task in focus, with old and new line numbers.
- **TEAM:** the mission's hierarchy in tiers — YOU, COUNCIL, LEADS, WORKERS — each tier's name in a
  fixed column so depth never shifts a row; every worker (by name, model and effort) carries the
  number of the lead that owns it; a working seat pulses. The task's last test run is in its Task view.
- **AGENT OUTPUT:** the followed agent's own stream (▸ opens a tool call or an outcome whole).
- **Keys:** `j`/`k` move in the focused list, `h`/`l` switch between agents and tasks, `1`–`4`
  pick the centre view, `n` new mission, `p` report, `d` dashboard, `t` retry a failed mission,
  `s`/`x` start/stop the orchestrator.
- **Look:** phosphor green by default; `COCKPIT_THEME=neon` for the violet/cyan/pink palette.
  `COCKPIT_BRAND` sets the name in the header (default `ANILDEV`).
- **Motion:** 60 fps while a mission runs (the header at the 16 ms frame; the other animated
  rasters every ≥ 66 ms; all of them under 100 blits/s, below the host's ~120/s intake), 1/s at
  rest, frozen with `COCKPIT_REDUCED_MOTION=1`. From 130 columns the pane is the grid above;
  narrower, it becomes two columns, then one.

The worktree data (changed files, code preview) is read by the daemon every 3 s for tasks in
progress; the rest comes from the snapshot it writes on every event.

A toast announces every new decision request. The cockpit is presentation only: it reads the
snapshot the orchestrator writes and sends decisions through the CLI.
`claude plugin test packages/claude-plugin` renders it against recorded snapshots.

### Telemetry dashboard

`cockpit dashboard` (or `d` in the pane) opens a page the daemon serves on 127.0.0.1, in the
cockpit's look (phosphor by default, neon a click away; `COCKPIT_THEME` / `COCKPIT_BRAND` apply): the
mission and its lifecycle, the team in tiers, what is left of each subscription, spend,
tokens and cache rate, the lifecycle, a live **Minds** view of every model session (narration,
reasoning, tools, outcomes), a task board, cumulative cost per role, input tokens per call, cost
per task, a span timeline, a sortable calls table and a searchable event log. It refreshes
every few seconds. The page itself is public; its data needs a read-only token that the link
carries in its fragment (never sent to a server or logged) and that allows GETs only.

## Choosing who leads

You seat a council of Supervisors and one or more Leads; the head Lead staffs the workers, and you
approve the team before any of them starts.

- **Per mission:** `n` opens the NEW MISSION screen. The **brief** is Markdown of any length: type it
  line by line (enter adds a line, an empty one a paragraph break), or press `e` to write it in your
  editor (`COCKPIT_EDITOR`, default VS Code; the file is `<dataDir>/drafts/mission.md`) and `l` to
  load it back. Below it the **council** and the **leads**: press a model to change it, `⚡` for its
  effort, `@` for a lead's area (backend, frontend, tests, …); `+ add` seats another, `×` removes one.
  Options take `--test` / `--repo`; `s` starts the mission (the brief goes to `cockpit run --file`),
  `q` goes back and keeps the brief. The first of each list (★) chairs the council / is the head lead. From the
  CLI: `cockpit run "..." --council opus:high,codex:low --leads codex:medium@backend,sonnet:low@frontend`.
  Unset, the run takes `hierarchy` from `config/agents.yaml` (`--supervisor` / `--lead` still work).
- **The council:** the chair writes the architecture; the other members review it in parallel and
  any "revise" makes the chair answer their concerns once. Before the chair rules on the Lead's
  proposals the members give their view; at the end they judge the result with the chair, and a
  member's "revise" sends the work back. A council of one costs nothing extra.
- **The leads:** the head lead reviews the architecture, plans and integrates; each task names the
  lead that owns it (by area), and that lead answers its worker and reviews its work.
- **The team:** the head lead's plan names its workers after their jobs (`backend-dev`, `tester`,
  `db-engineer`, …), each a worker model at an effort, and gives every task one. The mission waits
  in NEEDS YOU until you approve the team (`engine.team.approval: false` in `cockpit.yaml` skips it);
  edit it there, or `cockpit team <runId> '<json>'`. Sending it back drops the unstarted tasks and
  the head lead plans again with your note. A later round only asks again for new or changed workers.
- **Efforts are never shared:** every seat and every worker carries its own level, so one model can
  chair at `high`, lead at `medium` and work as `tester` at `low`.
- **Mid-run** (a limit ran out): edit the CREW in the AGENTS panel, or
  `cockpit seats <runId> --council opus,sonnet --leads codex:high`. Later calls use the new seats; a
  call already in flight finishes where it started.
- **Who may sit where:** an agent takes a seat only if the role is in its `roles` list in `agents.yaml`
  (`cockpit agents` lists them); workers come from the enabled `worker` agents.
- **Subscription limits:** the cockpit takes Claude's five-hour and weekly windows from the Claude
  Code session it runs in (pushed after every turn), and the daemon's Claude calls report them too;
  Codex's come from its own session logs (`~/.codex/sessions`), re-read every minute. The latest
  is kept in `<dataDir>/limits.json`, so the cockpit shows them before the first call of a day.

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
