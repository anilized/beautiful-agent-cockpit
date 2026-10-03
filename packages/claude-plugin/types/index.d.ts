export type CockpitTask = {
  key: string
  title: string
  status: string
  agentId: string | null
  repo: string
  iteration: number
  dependsOn: string[]
  blockedReason: string | null
}

export type CockpitRun = {
  id: string
  request: string
  status: string
  round: number
  error: string | null
  createdAt?: string
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
  recentEvents: { ts: string; type: string; text: string }[]
}

export type CockpitApproval = { id: string; runId: string; kind: string; operation: string | null; summary: string }

export type CockpitSnapshot = {
  generatedAt: string
  daemon: { pid: number; port: number | null }
  hierarchy: { supervisor: string; lead: string }
  runs: CockpitRun[]
  pendingApprovals: CockpitApproval[]
}

export type CockpitView = { snapshot: CockpitSnapshot | null; error: string | null; message: string | null }

export type CockpitTab = 'tasks' | 'events' | 'report'

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
}

declare module 'claude-code' {
  interface PluginState {
    'agent-cockpit': { view: CockpitView; ui: CockpitUi; tick: number }
  }
}
