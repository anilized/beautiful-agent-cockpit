import { errorMessage, parseContract, type ContractName, type ContractOf, type Role } from '@cockpit/core';
import type { AdapterRegistry, AgentSession, UsageReport } from '@cockpit/agents';
import type { Store } from '@cockpit/persistence';
import type { Telemetry } from '@cockpit/telemetry';
import type { EventBus } from './event-bus';
import { describeOutcome } from './outcome';

/** Longest model message or reasoning block kept per event. */
const MAX_OUTPUT = 4000;

export interface AgentCall<N extends ContractName> {
  runId: string;
  taskId?: string | null;
  agentId: string;
  role: Role;
  contract: N;
  prompt: string;
  cwd: string;
  readOnly: boolean;
  additionalDirs?: string[];
  /** Provider session to continue (worker corrections). Falls back to a fresh session if resuming fails. */
  resumeExternalId?: string | null;
  /** Used for the fresh-session fallback when a resume fails (full context instead of a delta). */
  freshPrompt?: string;
  timeoutMs: number;
  spanName: string;
}

export interface AgentCallResult<N extends ContractName> {
  output: ContractOf<N>;
  externalId: string | null;
  usage: UsageReport | null;
}

/**
 * Runs one agent invocation: session bookkeeping, events, telemetry, usage accounting,
 * contract validation, and one corrective retry when the output is malformed.
 */
export class AgentRunner {
  private readonly cancels = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly telemetry: Telemetry,
    private readonly registry: AdapterRegistry,
  ) {}

  cancelRun(runId: string): void {
    for (const [key, c] of this.cancels) if (key.startsWith(`${runId}:`)) c.abort();
  }

  async call<N extends ContractName>(call: AgentCall<N>): Promise<AgentCallResult<N>> {
    const profile = this.registry.profile(call.agentId);
    return this.telemetry.span(
      call.spanName,
      {
        'cockpit.run_id': call.runId,
        'cockpit.task_id': call.taskId ?? undefined,
        'cockpit.agent_id': call.agentId,
        'cockpit.role': call.role,
        'cockpit.model': profile.model ?? profile.adapter,
        'cockpit.contract': call.contract,
      },
      async (span) => {
        let attempt = 0;
        let lastError = '';
        let resumeId = call.resumeExternalId ?? null;
        let prompt = call.prompt;
        while (attempt < 2) {
          attempt++;
          span.setAttribute('cockpit.retry_count', attempt - 1);
          try {
            const res = await this.once(call, prompt, resumeId);
            const usage = res.usage;
            if (usage) {
              span.setAttributes({ 'gen_ai.usage.input_tokens': usage.inputTokens, 'gen_ai.usage.output_tokens': usage.outputTokens });
            }
            try {
              const output = parseContract(call.contract, res.output);
              // What the call concluded, for the Live view: a plan, a verdict, a ruling.
              this.bus.emit('agent.output', call.runId, {
                agentId: call.agentId, role: call.role, sessionId: res.sessionId, taskId: call.taskId ?? null, kind: 'result',
                text: describeOutcome(call.contract, output).slice(0, MAX_OUTPUT),
              });
              return { output, externalId: res.externalId, usage };
            } catch (err) {
              lastError = `output did not match ${call.contract}: ${errorMessage(err).slice(0, 1500)}`;
              resumeId = null;
              prompt = `${call.freshPrompt ?? call.prompt}\n\nIMPORTANT: a previous attempt returned invalid structured output (${lastError}). Return valid output.`;
            }
          } catch (err) {
            lastError = errorMessage(err);
            if (resumeId && call.freshPrompt) {
              // The provider session could not be resumed: start fresh with full context.
              resumeId = null;
              prompt = call.freshPrompt;
              continue;
            }
            if (!(err as { retryable?: boolean }).retryable) break;
          }
        }
        this.bus.emit('agent.failed', call.runId, { agentId: call.agentId, taskId: call.taskId ?? null, error: lastError });
        throw new Error(`${call.agentId} (${call.role}) failed: ${lastError}`);
      },
    );
  }

  private async once<N extends ContractName>(call: AgentCall<N>, prompt: string, resumeId: string | null) {
    const adapter = this.registry.get(call.agentId);
    // Effort: the run's choice for this seat, then for this agent (read per attempt, so a live change applies), else its default.
    const efforts = this.store.runMeta<{ efforts?: Record<string, string> }>(call.runId).efforts ?? {};
    const effort = efforts[`${call.role}:${call.agentId}`] ?? efforts[call.agentId] ?? this.registry.profile(call.agentId).effort ?? null;
    const config = { agentId: call.agentId, role: call.role, cwd: call.cwd, readOnly: call.readOnly, additionalDirs: call.additionalDirs };
    const session: AgentSession = resumeId ? await adapter.resume(resumeId, config) : await adapter.startSession(config);
    const record = this.store.insertSession({
      runId: call.runId, taskId: call.taskId ?? null, agentId: call.agentId, role: call.role, externalId: resumeId, status: 'active', cwd: call.cwd,
    });
    this.bus.emit('agent.started', call.runId, { agentId: call.agentId, role: call.role, sessionId: record.id, taskId: call.taskId ?? null, contract: call.contract, effort });
    const said = (kind: 'text' | 'thinking' | 'tool', text: string) =>
      this.bus.emit('agent.output', call.runId, { agentId: call.agentId, role: call.role, sessionId: record.id, taskId: call.taskId ?? null, kind, text: text.slice(0, MAX_OUTPUT) });
    const abort = new AbortController();
    const key = `${call.runId}:${record.id}`;
    this.cancels.set(key, abort);
    const started = Date.now();
    let output: unknown;
    let gotOutput = false;
    let usage: UsageReport | null = null;
    let error: { message: string; retryable: boolean } | null = null;
    try {
      for await (const ev of adapter.execute(session, { prompt, contract: call.contract, timeoutMs: call.timeoutMs, signal: abort.signal, effort })) {
        switch (ev.type) {
          case 'session':
            this.store.updateSession(record.id, { externalId: ev.externalId });
            break;
          case 'text':
          case 'thinking':
            // Whole messages (the CLIs stream no token deltas here), kept for the cockpit's Minds view.
            said(ev.type, ev.text);
            break;
          case 'tool':
            said('tool', `${ev.name}: ${ev.detail}`);
            break;
          case 'usage':
            usage = ev.usage;
            break;
          case 'result':
            output = ev.output;
            gotOutput = true;
            break;
          case 'error':
            error = { message: ev.error, retryable: ev.retryable };
            break;
        }
      }
    } finally {
      this.cancels.delete(key);
    }
    const u = usage as UsageReport | null;
    if (u) {
      this.store.insertUsage({
        runId: call.runId, taskId: call.taskId ?? null, agentId: call.agentId, role: call.role, model: u.model,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, costUsd: u.costUsd, durationMs: Date.now() - started,
      });
      this.bus.emit('usage.recorded', call.runId, { agentId: call.agentId, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd });
    }
    if (!gotOutput) {
      this.store.updateSession(record.id, { status: 'failed' });
      const e = error as { message: string; retryable: boolean } | null;
      throw Object.assign(new Error(e?.message ?? 'agent produced no result'), { retryable: e?.retryable ?? true });
    }
    this.store.updateSession(record.id, { status: 'completed' });
    this.bus.emit('agent.completed', call.runId, { agentId: call.agentId, sessionId: record.id, taskId: call.taskId ?? null });
    return { output, externalId: session.externalId, usage: u, sessionId: record.id };
  }
}
