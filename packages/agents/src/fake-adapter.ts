import { newId, type AgentCapabilities, type AgentProfile, type ContractName } from '@cockpit/core';
import type { AgentAdapter, AgentEvent, AgentSession, Assignment, SessionConfig } from './adapter';

export interface FakeCall {
  agentId: string;
  contract: ContractName;
  prompt: string;
  cwd: string;
  readOnly: boolean;
  resumed: boolean;
  effort: string | null;
}

/**
 * A scripted handler answers each call. It may also act on the session's cwd (e.g.
 * write files in a worker's worktree) to simulate real work in end-to-end tests.
 */
export type FakeHandler = (call: FakeCall, n: number) => unknown | Promise<unknown>;

/** Deterministic adapter for tests and offline dry-runs. */
export class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  static readonly calls: FakeCall[] = [];

  constructor(private readonly profile: AgentProfile, private readonly handler: FakeHandler) {}

  capabilities(): AgentCapabilities {
    return this.profile.capabilities;
  }

  async startSession(config: SessionConfig): Promise<AgentSession> {
    return { id: newId('fks'), agentId: this.profile.id, externalId: null, config };
  }

  async resume(externalId: string, config: SessionConfig): Promise<AgentSession> {
    return { id: newId('fks'), agentId: this.profile.id, externalId, config };
  }

  async cancel(): Promise<void> {}

  async *execute(session: AgentSession, assignment: Assignment): AsyncIterable<AgentEvent> {
    const resumed = session.externalId !== null;
    if (!session.externalId) {
      session.externalId = newId('fake-thread');
      yield { type: 'session', externalId: session.externalId };
    }
    const call: FakeCall = {
      agentId: this.profile.id,
      contract: assignment.contract,
      prompt: assignment.prompt,
      cwd: session.config.cwd,
      readOnly: session.config.readOnly,
      resumed,
      effort: assignment.effort ?? null,
    };
    FakeAdapter.calls.push(call);
    try {
      const output = await this.handler(call, FakeAdapter.calls.filter((c) => c.agentId === call.agentId && c.contract === call.contract).length);
      yield { type: 'usage', usage: { model: this.profile.model ?? 'fake', inputTokens: assignment.prompt.length, outputTokens: 100, cachedTokens: 0, costUsd: 0 } };
      yield { type: 'result', output };
    } catch (err) {
      yield { type: 'error', error: (err as Error).message, retryable: false };
    }
  }
}
