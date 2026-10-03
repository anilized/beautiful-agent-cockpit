import type { AgentCapabilities, AgentProfile, ContractName, Role } from '@cockpit/core';

export interface SessionConfig {
  agentId: string;
  role: Role;
  cwd: string;
  /** Read-only sessions may inspect but never modify files (supervision, review, planning). */
  readOnly: boolean;
  /** Extra directories the agent may read (other repositories in a multi-repo run). */
  additionalDirs?: string[];
}

export interface AgentSession {
  id: string;
  agentId: string;
  /** Provider-side session/thread id, used to resume. */
  externalId: string | null;
  config: SessionConfig;
}

export interface Assignment {
  prompt: string;
  /** Structured output contract the agent must return. */
  contract: ContractName;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Reasoning effort for this call (a level the adapter's CLI accepts); absent, the CLI's default. */
  effort?: string | null;
}

export interface UsageReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
}

export type AgentEvent =
  | { type: 'session'; externalId: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'usage'; usage: UsageReport }
  /** The provider's subscription limits as the CLI reported them (raw, read by the orchestrator). */
  | { type: 'limits'; provider: 'claude' | 'codex'; raw: Record<string, unknown> }
  | { type: 'result'; output: unknown }
  | { type: 'error'; error: string; retryable: boolean };

/**
 * The adapter contract. Roles are never tied to a provider: any adapter can back
 * a supervisor, lead or worker profile if its capabilities allow.
 */
export interface AgentAdapter {
  readonly name: string;
  capabilities(): AgentCapabilities;
  startSession(config: SessionConfig): Promise<AgentSession>;
  execute(session: AgentSession, assignment: Assignment): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
  resume(externalId: string, config: SessionConfig): Promise<AgentSession>;
}

export type AdapterFactory = (profile: AgentProfile) => AgentAdapter;

export class AgentExecutionError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}
