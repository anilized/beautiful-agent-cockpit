export type CockpitTask = {
  key: string
  title: string
  status: string
  agentId: string | null
  repo: string
  iteration: number
  dependsOn: string[]
  blockedReason: string | null
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

export type CockpitMind = {
  sessionId: string
  agentId: string
  role: string
  task: string | null
  contract: string | null
  effort: string | null
  status: string
  startedAt: string
  endedAt: string | null
  activity: { ts: string; kind: 'text' | 'thinking' | 'tool'; text: string }[]
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
}

export type CockpitView = { snapshot: CockpitSnapshot | null; error: string | null; message: string | null }

export type CockpitTab = 'tasks' | 'events' | 'minds' | 'report'

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
  /** The seats picked for the next run; null keeps the configured default. */
  seats: { supervisor: string | null; lead: string | null }
  /** Effort per agent id picked for the next run; absent agents keep their default. */
  efforts: Record<string, string>
  /** Session followed in the Minds tab; null follows the most recently active one. */
  mind: string | null
  /** Rows opened to show what their one line cuts off (tasks, events, Minds entries). */
  open: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-cockpit': { view: CockpitView; ui: CockpitUi; tick: number }
  }
}
