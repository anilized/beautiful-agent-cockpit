// Structured event contracts. Every meaningful state change emits one of these;
// the cockpit and any other observer subscribe to them, they never drive state.

export interface EventPayloads {
  'run.started': { request: string; repositories: string[] };
  'run.status_changed': { from: string; to: string };
  'run.completed': { outcome: 'approved' | 'rejected' | 'failed'; reason?: string };
  'architecture.defined': { summary: string };
  'proposal.created': { proposalId: string; kind: string; title: string; taskId?: string | null };
  'proposal.accepted': { proposalId: string; withChanges: boolean; rationale: string };
  'proposal.rejected': { proposalId: string; rationale: string };
  'proposal.escalated': { proposalId: string; rationale: string };
  'plan.created': { taskCount: number; round: number };
  'task.created': { taskId: string; key: string; title: string; repoId: string; dependsOn: string[] };
  'task.assigned': { taskId: string; agentId: string; reason: string };
  'task.started': { taskId: string; iteration: number; branch: string; worktreePath: string };
  'task.status_changed': { taskId: string; from: string; to: string };
  'task.blocked': { taskId: string; reason: string };
  'task.completed': { taskId: string; summary: string };
  'task.failed': { taskId: string; reason: string };
  'agent.started': { agentId: string; role: string; sessionId: string; taskId?: string | null };
  'agent.waiting': { agentId: string; taskId?: string | null; question: string };
  'agent.output': { agentId: string; taskId?: string | null; text: string };
  'agent.completed': { agentId: string; sessionId: string; taskId?: string | null };
  'agent.failed': { agentId: string; taskId?: string | null; error: string };
  'question.asked': { taskId: string; questions: string[] };
  'question.answered': { taskId: string; answeredBy: 'lead' | 'supervisor'; answer: string };
  'file.lease.acquired': { taskId: string; pattern: string; kind: string };
  'file.lease.released': { taskId: string; count: number };
  'file.lease.conflict': { taskId: string; pattern: string; heldBy: string };
  'file.lease.resolved': { taskId: string; action: string; rationale: string };
  'review.started': { taskId: string; iteration: number };
  'review.issue_found': { taskId: string; iteration: number; issues: number; summary: string };
  'review.passed': { taskId: string; iteration: number; summary: string };
  'test.started': { taskId?: string | null; command: string; scope: 'task' | 'integration' };
  'test.passed': { taskId?: string | null; command: string; scope: 'task' | 'integration' };
  'test.failed': { taskId?: string | null; command: string; scope: 'task' | 'integration'; output: string };
  'escalation.requested': { from: 'worker' | 'lead'; to: 'lead' | 'supervisor' | 'human'; taskId?: string | null; reason: string };
  'escalation.resolved': { taskId?: string | null; action: string; guidance: string };
  'approval.requested': { approvalId: string; kind: string; summary: string; operation?: string | null };
  'approval.accepted': { approvalId: string; response?: string | null };
  'approval.rejected': { approvalId: string; response?: string | null };
  'approval.changes_requested': { approvalId: string; response: string };
  'integration.started': { repoId: string; branch: string; tasks: string[] };
  'integration.conflict': { repoId: string; taskId: string; files: string[] };
  'integration.completed': { repoId: string; branch: string; passed: boolean };
  'validation.completed': { verdict: string; summary: string };
  'merge.completed': { repoId: string; branch: string; into: string };
  'usage.recorded': { agentId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null };
}

export type EventType = keyof EventPayloads;

export interface CockpitEvent<T extends EventType = EventType> {
  seq: number;
  id: string;
  runId: string | null;
  type: T;
  ts: string;
  data: EventPayloads[T];
}

export type NewEvent<T extends EventType = EventType> = Omit<CockpitEvent<T>, 'seq' | 'id' | 'ts'>;
