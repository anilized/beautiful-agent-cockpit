import {
  assertTaskTransition,
  type ArchitectureOutput,
  type CockpitConfig,
  type Repository,
  type Run,
  type Task,
  type TaskStatus,
  type ValidationResult,
} from '@cockpit/core';
import type { AdapterRegistry, AgentRouter } from '@cockpit/agents';
import type { Store } from '@cockpit/persistence';
import type { Telemetry } from '@cockpit/telemetry';
import type { LeaseConflict, LeaseManager, WorkspaceManager } from '@cockpit/workspace';
import type { AgentRunner } from './agent-runner';
import type { EventBus } from './event-bus';
import type { PermissionEngine } from './permission-engine';

export interface EngineContext {
  config: CockpitConfig;
  store: Store;
  bus: EventBus;
  telemetry: Telemetry;
  registry: AdapterRegistry;
  router: AgentRouter;
  runner: AgentRunner;
  leases: LeaseManager;
  workspaces: WorkspaceManager;
  permissions: PermissionEngine;
}

/** Durable per-run metadata (stored in runs.meta). */
export interface RunMeta {
  repoIds: string[];
  decisionRound?: number;
  assessment?: string;
  routingStrategy?: 'balanced' | 'prefer_quality' | 'prefer_cost' | 'prefer_speed';
  revisions?: number;
  pendingRevision?: string | null;
  validation?: unknown;
  integration?: Record<string, { branch: string; path: string; passed: boolean; output: string; command: string | null }>;
  failedFrom?: string;
  mergeError?: string | null;
  [k: string]: unknown;
}

/** Durable per-task working context (stored in tasks.context). */
export interface TaskContext {
  baseCommit?: string;
  started?: boolean;
  questions?: string[];
  pendingAnswers?: { question: string; answer: string }[];
  reviewFeedbackId?: string | null;
  validation?: ValidationResult | null;
  feedValidationFailure?: boolean;
  guidance?: string | null;
  extraIterations?: number;
  escalationReason?: string | null;
  awaitingApprovalId?: string | null;
  onApprove?: 'validating' | 'running';
  approvedCommands?: string[];
  leaseConflicts?: LeaseConflict[];
  leaseDecision?: 'wait' | 'serialize' | null;
  mergeIntegration?: boolean;
  integrationConflict?: string[];
  lastWorkerSummary?: string;
  [k: string]: unknown;
}

export function arch(run: Run): ArchitectureOutput | null {
  return (run.architecture as ArchitectureOutput | null) ?? null;
}

export function runRepos(ctx: EngineContext, run: Run): Repository[] {
  const meta = ctx.store.runMeta<RunMeta>(run.id);
  return meta.repoIds.map((id) => ctx.store.repository(id)!).filter(Boolean);
}

export type TaskPatch = Parameters<Store['updateTask']>[1];

export function setTaskStatus(ctx: EngineContext, task: Task, to: TaskStatus, patch: TaskPatch = {}): Task {
  assertTaskTransition(task.status, to);
  const updated = ctx.store.updateTask(task.id, { ...patch, status: to });
  ctx.bus.emit('task.status_changed', task.runId, { taskId: task.id, from: task.status, to });
  return updated;
}
