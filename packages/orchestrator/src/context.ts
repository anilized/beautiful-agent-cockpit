import {
  assertTaskTransition,
  type ArchitectureOutput,
  type CockpitConfig,
  type Repository,
  type Persona,
  type Run,
  type Seat,
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
  /** The human's choice of Supervisor and Lead for this run (absent: the configured hierarchy). */
  supervisor?: string;
  lead?: string;
  /** The human's reasoning-effort choice per agent for this run (absent: the agent's default). */
  efforts?: Record<string, string>;
  /** The Supervisor council (the first is the chair); absent on runs from before councils: `supervisor`. */
  council?: Seat[];
  /** The Leads (the first is the head lead); absent on older runs: `lead`. */
  leads?: Seat[];
  /** The worker personas the human approved (or the head Lead proposed, while awaiting approval). */
  team?: Persona[];
  /** The human's notes when they sent the proposed team back: the next plan answers them. */
  teamRevision?: string | null;
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
  /** The persona (team id) doing the task, and the Lead seat owning it. */
  persona?: string | null;
  lead?: string | null;
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
  /** The worker the Lead assigned in its plan, honoured by the scheduler when it can be. */
  preferredWorker?: string | null;
  [k: string]: unknown;
}

export function arch(run: Run): ArchitectureOutput | null {
  return (run.architecture as ArchitectureOutput | null) ?? null;
}

/** Who supervises and who leads this run: the run's own choice, else the configured hierarchy. */
/** The chair and the head lead's agents (one-seat views of the council and the leads). */
export function rolesOf(ctx: EngineContext, runId: string): { supervisor: string; lead: string } {
  return { supervisor: councilOf(ctx, runId)[0]!.agent, lead: leadsOf(ctx, runId)[0]!.agent };
}

/** The council, chair first; an older run's single supervisor as a council of one. */
export function councilOf(ctx: EngineContext, runId: string): Seat[] {
  const meta = ctx.store.runMeta<RunMeta>(runId);
  if (meta.council?.length) return meta.council;
  const agent = meta.supervisor ?? ctx.config.agents.hierarchy.supervisor;
  return [{ id: 'sup-1', agent, effort: meta.efforts?.[`supervisor:${agent}`] ?? meta.efforts?.[agent] ?? null }];
}

/** The leads, head first; an older run's single lead as one. */
export function leadsOf(ctx: EngineContext, runId: string): Seat[] {
  const meta = ctx.store.runMeta<RunMeta>(runId);
  if (meta.leads?.length) return meta.leads;
  const agent = meta.lead ?? ctx.config.agents.hierarchy.lead;
  return [{ id: 'lead-1', agent, effort: meta.efforts?.[`lead:${agent}`] ?? meta.efforts?.[agent] ?? null, area: null }];
}

/** What a call needs from a seat: the agent, its effort and the seat's id. */
export const seatCall = (s: Seat) => ({ agentId: s.agent, effort: s.effort, seat: s.id });

/** The Lead that owns a task (its plan's `lead`), else the head lead. */
export function leadForTask(ctx: EngineContext, task: Task): Seat {
  const leads = leadsOf(ctx, task.runId);
  const id = ctx.store.taskContext<TaskContext>(task.id).lead;
  return leads.find((l) => l.id === id) ?? leads[0]!;
}

/** The persona that does a task, if the plan named one. */
export function personaOf(ctx: EngineContext, task: Task): Persona | null {
  const id = ctx.store.taskContext<TaskContext>(task.id).persona;
  return (id && ctx.store.runMeta<RunMeta>(task.runId).team?.find((p) => p.id === id)) || null;
}

export function runRepos(ctx: EngineContext, run: Run): Repository[] {
  const meta = ctx.store.runMeta<RunMeta>(run.id);
  return meta.repoIds.map((id) => ctx.store.repository(id)!).filter(Boolean);
}

export type TaskPatch = Parameters<Store['updateTask']>[1];

export function setTaskStatus(ctx: EngineContext, task: Task, to: TaskStatus, patch: TaskPatch = {}): Task {
  // A step still holding the task from before its mission was cancelled cannot move it: cancelled is final.
  if (ctx.store.task(task.id)?.status === 'cancelled') assertTaskTransition('cancelled', to);
  assertTaskTransition(task.status, to);
  const updated = ctx.store.updateTask(task.id, { ...patch, status: to });
  ctx.bus.emit('task.status_changed', task.runId, { taskId: task.id, from: task.status, to });
  return updated;
}
