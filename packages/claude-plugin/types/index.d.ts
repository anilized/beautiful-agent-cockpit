export type CockpitTask = {
  key: string
  title: string
  status: string
  agentId: string | null
  repo: string
  iteration: number
  /** The task's branch in its worktree, once it started. */
  branch?: string | null
  dependsOn: string[]
  blockedReason: string | null
  /** The kind of worker the task asks for (backend, frontend, test, ...); absent from an older orchestrator. */
  specialty?: string
  /** The worktree as it stands: changed files and a preview of the biggest change. */
  live?: { files: { status: string; path: string }[]; preview: { file: string; diff: string } | null } | null
  /** The persona doing the task (backend-dev, tester) and the Lead seat owning it, when the plan named them. */
  persona?: string | null
  lead?: string | null
  /** The whole task, shown when its row is opened; absent from an older orchestrator. */
  detail?: {
    description: string
    kind: string
    risk: string
    complexity: string
    acceptanceCriteria: string[]
    scope: { files: string[]; modules: string[]; resources: string[] }
    testsRequired: boolean
    testCommand: string | null
    summary: string | null
    review: { iteration: number; verdict: string; summary: string; issues: { severity: string; file: string | null; description: string }[] } | null
    /** The orchestrator's last run of the task's test command. */
    validation?: { command: string | null; passed: boolean; skipped: boolean; output: string } | null
  }
}

export type CockpitRun = {
  id: string
  request: string
  status: string
  round: number
  error: string | null
  createdAt?: string
  /** Who holds the Supervisor and Lead seats of this run. */
  roles?: { supervisor: string; lead: string }
  /** The run's effort choice per agent id; agents absent here use their default. */
  efforts?: Record<string, string>
  leadership: { supervisor: string; lead: string }
  /** The Supervisor council (the first chairs) and the Leads (the first is the head); absent from an older orchestrator. */
  council?: CockpitSeat[]
  leads?: CockpitSeat[]
  /** The worker personas the head lead staffed, each a model at its own effort. */
  team?: CockpitPersona[]
  repositories: { name: string; baseBranch: string; integration: { branch: string; passed: boolean } | null }[]
  tasks: CockpitTask[]
  workers: { agentId: string; task: string | null; since: string }[]
  conflicts: { task: string; pattern: string; heldBy: string }[]
  tests: { scope: string; command: string; status: string; task: string | null; ts?: string }[]
  telemetry: {
    calls: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    byAgent?: { agentId: string; calls: number; costUsd: number }[]
  }
  recentEvents: { ts: string; type: string; text: string; detail?: string }[]
  /** The latest model sessions and their streams of text, reasoning and tool calls. */
  minds?: CockpitMind[]
}

/** One seat of a run's leadership, at its own effort; `state` is "idle" or what it is working on. */
export type CockpitSeat = { id: string; agent: string; effort: string | null; area: string | null; state: string }

/** A worker persona: a job name, the model doing it at an effort, and its tasks. */
export type CockpitPersona = { id: string; title: string; specialty: string; agent: string; effort: string | null; tasks: string[]; state: string }

/** A seat as picked for the next mission (or edited on a live one). */
export type CockpitSeatPick = { agent: string; effort: string | null; area: string | null }

/** A subscription's rate-limit windows as last reported: how much of each is used and when it resets. */
export type CockpitLimits = Partial<Record<'claude' | 'codex', { windows: { name: string; usedPercent: number; resetsAt: string | null }[]; at: string }>>

export type CockpitMind = {
  sessionId: string
  agentId: string
  role: string
  /** The seat or persona that made the call (sup-2, lead-1, backend-dev). */
  seat?: string | null
  task: string | null
  contract: string | null
  effort: string | null
  status: string
  startedAt: string
  endedAt: string | null
  activity: { ts: string; kind: 'text' | 'thinking' | 'tool' | 'result'; text: string }[]
}

/** `text` is the whole question or result; `summary` is capped (and all an older orchestrator sends). */
export type CockpitApproval = { id: string; runId: string; kind: string; operation: string | null; summary: string; text?: string }

export type CockpitSnapshot = {
  generatedAt: string
  daemon: { pid: number; port: number | null }
  hierarchy: { supervisor: string; lead: string }
  /** Every configured agent and the roles it may take. */
  agents?: { id: string; adapter: string; model: string | null; roles: string[]; enabled: boolean; effort?: string | null; efforts?: string[] }[]
  runs: CockpitRun[]
  pendingApprovals: CockpitApproval[]
  limits?: CockpitLimits
}

export type CockpitView = { snapshot: CockpitSnapshot | null; error: string | null; message: string | null }

/** What the right-hand panel shows: the followed agent's stream, the selected task, the event log, or the report. */
export type CockpitTab = 'live' | 'task' | 'events' | 'report'

/** Pane-local interaction state: what the person has selected and is composing. */
export type CockpitUi = {
  /** Run shown in the main column; null follows the active run. */
  selectedRun: string | null
  tab: CockpitTab
  /** Which inline field is open: a new run request, or change notes for an approval id. */
  composing: { kind: 'run' } | { kind: 'changes'; approvalId: string } | null
  /** Bumped to remount a field (clears its text) after a submit. */
  nonce: number
  busy: string | null
  report: { runId: string; text: string } | null
  /** A launch the orchestrator refused, kept on screen with a fix when one is known. */
  failure: { text: string; request: string; uninitializedRepo: string | null } | null
  /** The council and the leads picked for the next mission, each at its own effort; null keeps the configured default. */
  crew: { council: CockpitSeatPick[]; leads: CockpitSeatPick[] } | null
  /** The next mission's brief (Markdown), its extra flags, and whether it was opened in an editor (then the file wins). */
  draft: string
  draftFlags: string
  draftInEditor: boolean
  /** Session followed in the Minds tab; null follows the most recently active one. */
  mind: string | null
  /** Rows opened to show what their one line cuts off (tasks, events, Minds entries). */
  open: string[]
  /** What j/k act on: the agents list, the tasks list, or the centre view (scrolls). */
  focus: 'agents' | 'tasks' | 'centre'
  /** Rows (or entries) scrolled off the top of a box that scrolls on its own: centre, output. */
  scroll: Record<string, number>
  /** The selected task (its key); null picks the first that needs attention or is running. */
  task: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-cockpit': { view: CockpitView; ui: CockpitUi; tick: number }
  }
}
