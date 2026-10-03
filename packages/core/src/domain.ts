// Domain model. Everything the workflow needs to resume lives in these records;
// model conversation history is never treated as workflow state.

export type Role = 'supervisor' | 'lead' | 'worker';

export type WorkerSpecialty =
  | 'backend'
  | 'frontend'
  | 'test'
  | 'database'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'refactoring'
  | 'research'
  | 'generalist';

export type TaskKind =
  | 'implementation'
  | 'bugfix'
  | 'refactor'
  | 'test'
  | 'database'
  | 'api'
  | 'docs'
  | 'analysis'
  | 'research'
  | 'security'
  | 'performance';

/** Task kinds that change executable code: tests are mandatory for these. */
export const EXECUTABLE_TASK_KINDS: ReadonlySet<TaskKind> = new Set([
  'implementation',
  'bugfix',
  'refactor',
  'test',
  'database',
  'api',
  'security',
  'performance',
]);

export type Level = 'low' | 'medium' | 'high';

export type RunStatus =
  | 'created'
  | 'architecting'
  | 'proposing'
  | 'deciding'
  | 'planning'
  | 'executing'
  | 'integrating'
  | 'validating'
  | 'awaiting_approval'
  | 'awaiting_human_decision'
  | 'merging'
  | 'completed'
  | 'rejected'
  | 'failed';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'needs_input'
  | 'validating'
  | 'in_review'
  | 'changes_requested'
  | 'lease_conflict'
  | 'approved'
  | 'integrated'
  | 'escalated'
  | 'failed'
  | 'cancelled';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  path: string;
  baseBranch: string;
  testCommand: string | null;
  protectedBranches: string[];
}

export interface Scope {
  files: string[];
  modules: string[];
  resources: string[];
}

export interface Run {
  id: string;
  projectId: string;
  request: string;
  status: RunStatus;
  architecture: unknown | null;
  report: string | null;
  feedback: string[];
  round: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  runId: string;
  key: string;
  title: string;
  description: string;
  kind: TaskKind;
  repoId: string;
  specialty: WorkerSpecialty;
  risk: Level;
  complexity: Level;
  scope: Scope;
  acceptanceCriteria: string[];
  testsRequired: boolean;
  testCommand: string | null;
  status: TaskStatus;
  agentId: string | null;
  iteration: number;
  branch: string | null;
  worktreePath: string | null;
  summary: string | null;
  blockedReason: string | null;
  round: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOn: string;
}

export interface AgentSessionRecord {
  id: string;
  runId: string;
  taskId: string | null;
  agentId: string;
  role: Role;
  externalId: string | null;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  cwd: string;
  startedAt: string;
  endedAt: string | null;
}

export interface WorktreeRecord {
  id: string;
  runId: string;
  taskId: string | null;
  repoId: string;
  path: string;
  branch: string;
  baseCommit: string;
  status: 'active' | 'removed';
}

export type LeaseKind = 'file' | 'module' | 'resource';

export interface FileLease {
  id: string;
  runId: string;
  taskId: string;
  repoId: string;
  pattern: string;
  kind: LeaseKind;
  status: 'active' | 'released';
  acquiredAt: string;
}

export interface ReviewIssue {
  severity: 'blocker' | 'major' | 'minor';
  file: string | null;
  description: string;
  suggestion: string | null;
}

export interface ReviewRecord {
  id: string;
  taskId: string;
  iteration: number;
  verdict: 'approve' | 'changes_requested' | 'escalate';
  summary: string;
  issues: ReviewIssue[];
  validation: ValidationResult | null;
  createdAt: string;
}

export interface ValidationResult {
  command: string | null;
  passed: boolean;
  skipped: boolean;
  exitCode: number | null;
  output: string;
}

export type ProposalKind = 'architecture' | 'scope' | 'risk' | 'alternative' | 'resource' | 'plan_revision' | 'implementation';
export type ProposalStatus = 'open' | 'accepted' | 'accepted_with_changes' | 'rejected' | 'needs_analysis' | 'escalated';

export interface Proposal {
  id: string;
  runId: string;
  taskId: string | null;
  kind: ProposalKind;
  title: string;
  rationale: string;
  suggestion: string;
  status: ProposalStatus;
  createdAt: string;
}

export type DecisionOutcome = 'accept' | 'accept_with_changes' | 'reject' | 'request_analysis' | 'escalate_human';

export interface Decision {
  id: string;
  runId: string;
  proposalId: string | null;
  decidedBy: 'supervisor' | 'human';
  outcome: DecisionOutcome;
  rationale: string;
  changes: string | null;
  createdAt: string;
}

export type ApprovalKind = 'final' | 'operation' | 'decision';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export type HighRiskOperation =
  | 'merge_protected'
  | 'protected_push'
  | 'production'
  | 'destructive_migration'
  | 'secret_access'
  | 'cloud_infrastructure'
  | 'destructive_shell'
  | 'external_side_effect';

export interface Approval {
  id: string;
  runId: string;
  kind: ApprovalKind;
  operation: HighRiskOperation | null;
  summary: string;
  details: unknown;
  status: ApprovalStatus;
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ModelUsage {
  id: string;
  runId: string;
  taskId: string | null;
  agentId: string;
  role: Role;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  durationMs: number;
  createdAt: string;
}
