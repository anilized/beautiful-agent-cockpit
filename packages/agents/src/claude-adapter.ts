import { randomUUID } from 'node:crypto';
import { contractJsonSchema, newId, type AgentCapabilities, type AgentProfile } from '@cockpit/core';
import { findExecutable, spawnProcess } from '@cockpit/workspace';
import type { AgentAdapter, AgentEvent, AgentSession, Assignment, SessionConfig } from './adapter';
import { EventQueue } from './event-queue';

export interface ClaudeAdapterOptions {
  binary?: string;
  /** Permission mode for sessions that may edit files. */
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraArgs?: string[];
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)', 'Bash(ls:*)'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/**
 * Drives the locally installed, already-authenticated Claude Code CLI in headless
 * mode (`claude -p --output-format stream-json --json-schema`). No API key needed;
 * an API-key or SDK transport can replace the spawn later behind the same contract.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  private readonly running = new Map<string, AbortController>();
  private readonly opts: ClaudeAdapterOptions;

  constructor(private readonly profile: AgentProfile, defaults: ClaudeAdapterOptions = {}) {
    this.opts = { ...defaults, ...(profile.options as ClaudeAdapterOptions) };
  }

  capabilities(): AgentCapabilities {
    return this.profile.capabilities;
  }

  private binary(): string {
    const bin = this.opts.binary ?? process.env.COCKPIT_CLAUDE_BIN ?? findExecutable('claude');
    if (!bin) throw new Error('Claude Code CLI not found on PATH; set options.binary in agents.yaml or COCKPIT_CLAUDE_BIN');
    return bin;
  }

  async startSession(config: SessionConfig): Promise<AgentSession> {
    return { id: newId('cls'), agentId: this.profile.id, externalId: null, config };
  }

  async resume(externalId: string, config: SessionConfig): Promise<AgentSession> {
    return { id: newId('cls'), agentId: this.profile.id, externalId, config };
  }

  async cancel(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.abort();
  }

  buildArgs(session: AgentSession, assignment: Assignment, newSessionId: string | null): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(contractJsonSchema(assignment.contract))];
    if (this.profile.model) args.push('--model', this.profile.model);
    if (assignment.effort) args.push('--effort', assignment.effort);
    if (session.externalId) args.push('--resume', session.externalId);
    else if (newSessionId) args.push('--session-id', newSessionId);
    if (session.config.readOnly) {
      args.push('--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS.join(','), '--disallowedTools', WRITE_TOOLS.join(','));
    } else {
      args.push('--permission-mode', this.opts.permissionMode ?? 'acceptEdits');
      if (this.opts.allowedTools?.length) args.push('--allowedTools', this.opts.allowedTools.join(','));
      if (this.opts.disallowedTools?.length) args.push('--disallowedTools', this.opts.disallowedTools.join(','));
    }
    for (const d of session.config.additionalDirs ?? []) args.push('--add-dir', d);
    args.push(...(this.opts.extraArgs ?? []));
    return args;
  }

  execute(session: AgentSession, assignment: Assignment): AsyncIterable<AgentEvent> {
    const queue = new EventQueue<AgentEvent>();
    const abort = new AbortController();
    assignment.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    this.running.set(session.id, abort);
    const newSessionId = session.externalId ? null : randomUUID();
    if (newSessionId) {
      session.externalId = newSessionId;
      queue.push({ type: 'session', externalId: newSessionId });
    }
    const args = this.buildArgs({ ...session, externalId: newSessionId ? null : session.externalId }, assignment, newSessionId);
    let gotResult = false;

    spawnProcess(this.binary(), args, {
      cwd: session.config.cwd,
      stdin: assignment.prompt,
      timeoutMs: assignment.timeoutMs,
      signal: abort.signal,
      onStdoutLine: (line) => {
        const msg = safeJson(line);
        if (!msg) return;
        for (const ev of translate(msg, this.profile.model ?? 'claude')) {
          if (ev.type === 'result') gotResult = true;
          queue.push(ev);
        }
      },
    })
      .then((res) => {
        if (res.timedOut) queue.push({ type: 'error', error: `claude timed out after ${assignment.timeoutMs}ms`, retryable: true });
        else if (res.aborted) queue.push({ type: 'error', error: 'cancelled', retryable: false });
        else if (!gotResult) queue.push({ type: 'error', error: `claude exited ${res.exitCode} without a structured result: ${res.stderr.slice(-1500)}`, retryable: true });
      })
      .catch((err) => queue.push({ type: 'error', error: String(err?.message ?? err), retryable: false }))
      .finally(() => {
        this.running.delete(session.id);
        queue.close();
      });
    return queue;
  }
}

function safeJson(line: string): Record<string, any> | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Translate one stream-json message from Claude Code into adapter events. */
export function translate(msg: Record<string, any>, model: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text?.trim()) out.push({ type: 'text', text: block.text });
      else if (block.type === 'thinking' && block.thinking?.trim()) out.push({ type: 'thinking', text: block.thinking });
      else if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
        out.push({ type: 'tool', name: block.name, detail: summarizeInput(block.input) });
      }
    }
  } else if (msg.type === 'rate_limit_event') {
    out.push({ type: 'limits', provider: 'claude', raw: msg });
  } else if (msg.type === 'result') {
    const u = msg.usage ?? {};
    const models = Object.keys(msg.modelUsage ?? {});
    out.push({
      type: 'usage',
      usage: {
        model: models[0] ?? model,
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      },
    });
    let output = msg.structured_output;
    if (output === undefined && typeof msg.result === 'string') output = extractJson(msg.result);
    if (msg.is_error || output === undefined || output === null) {
      out.push({ type: 'error', error: `claude result error (${msg.subtype}): ${String(msg.result ?? '').slice(0, 1500)}`, retryable: true });
    } else out.push({ type: 'result', output });
  }
  return out;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  return String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? '').slice(0, 200);
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fence) {
      try {
        return JSON.parse(fence[1]!);
      } catch {
        /* fall through */
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}
