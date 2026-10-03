import type { RunStatus, TaskStatus } from './domain';

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const TERMINAL_RUN: RunStatus[] = ['completed', 'rejected', 'failed'];

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ['architecting'],
  architecting: ['proposing'],
  // Codex reviews the architecture; with no proposals it goes straight to planning.
  proposing: ['deciding', 'planning'],
  // Opus may ask Codex for more analysis (back to proposing) or need the human.
  deciding: ['proposing', 'planning', 'awaiting_human_decision'],
  awaiting_human_decision: ['deciding', 'planning', 'executing'],
  // A plan with a team waits for the human to approve or revise the team.
  planning: ['executing', 'awaiting_human_decision'],
  executing: ['integrating', 'awaiting_human_decision', 'planning'],
  integrating: ['validating', 'executing'],
  // Opus may send the run back for more work.
  validating: ['awaiting_approval', 'planning'],
  // REQUEST CHANGES continues the managed run from planning.
  awaiting_approval: ['merging', 'planning', 'rejected'],
  merging: ['completed', 'awaiting_approval'],
  completed: [],
  rejected: [],
  failed: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (to === 'failed') return !TERMINAL_RUN.includes(from);
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new InvalidTransitionError('run', from, to);
}

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN.includes(status);
}

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['ready', 'cancelled'],
  ready: ['running', 'cancelled', 'pending'],
  running: ['needs_input', 'validating', 'escalated', 'failed', 'ready'],
  needs_input: ['running', 'escalated', 'failed'],
  validating: ['in_review', 'changes_requested', 'lease_conflict', 'failed', 'escalated'],
  lease_conflict: ['ready', 'running', 'validating', 'escalated', 'cancelled'],
  in_review: ['approved', 'changes_requested', 'escalated', 'failed'],
  changes_requested: ['running', 'escalated', 'failed', 'ready'],
  escalated: ['ready', 'running', 'validating', 'failed', 'cancelled', 'approved'],
  approved: ['integrated', 'changes_requested', 'ready'],
  integrated: [],
  failed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError('task', from, to);
}

/** Tasks in these states hold leases and occupy an execution slot. */
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'needs_input',
  'validating',
  'in_review',
  'changes_requested',
  'lease_conflict',
  'escalated',
]);

export const DONE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['approved', 'integrated']);

export const FINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['integrated', 'failed', 'cancelled']);
