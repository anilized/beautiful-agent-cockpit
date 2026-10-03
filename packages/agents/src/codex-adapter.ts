import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contractJsonSchema, newId, type AgentCapabilities, type AgentProfile } from '@cockpit/core';
import { findExecutable, isWindows, newestInSubdirs, spawnProcess } from '@cockpit/workspace';
import type { AgentAdapter, AgentEvent, AgentSession, Assignment, SessionConfig } from './adapter';
import { extractJson } from './claude-adapter';
import { EventQueue } from './event-queue';

export interface CodexAdapterOptions {
  binary?: string;
  /** Sandbox for sessions that may edit files (integration conflict resolution, Codex-backed workers). */
  writeSandbox?: 'workspace-write' | 'danger-full-access';
  reasoningEffort?: string;
  extraArgs?: string[];
}

/** Find the Codex CLI: explicit option, env, PATH, then the binary bundled with the desktop app. */
export function discoverCodexBinary(explicit?: string): string | null {
  if (explicit) return explicit;
  if (process.env.COCKPIT_CODEX_BIN) return process.env.COCKPIT_CODEX_BIN;
  const onPath = findExecutable('codex');
  if (onPath) return onPath;
  if (isWindows && process.env.LOCALAPPDATA) return newestInSubdirs(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), 'codex.exe');
  if (process.platform === 'darwin') {
    const app = '/Applications/Codex.app/Contents/Resources/codex';
    return findExecutable('codex', [app]);
  }
  return null;
}

/**
 * Drives the locally installed, already-authenticated Codex CLI (`codex exec --json
 * --output-schema`). Prompts go through stdin to avoid command-line length limits.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  private readonly running = new Map<string, AbortController>();
  private readonly opts: CodexAdapterOptions;

  constructor(private readonly profile: AgentProfile) {
    this.opts = profile.options as CodexAdapterOptions;
  }

  capabilities(): AgentCapabilities {
    return this.profile.capabilities;
  }

  async startSession(config: SessionConfig): Promise<AgentSession> {
    return { id: newId('cxs'), agentId: this.profile.id, externalId: null, config };
  }

  async resume(externalId: string, config: SessionConfig): Promise<AgentSession> {
    return { id: newId('cxs'), agentId: this.profile.id, externalId, config };
  }

  async cancel(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.abort();
  }

  buildArgs(session: AgentSession, schemaFile: string, effort?: string | null): string[] {
    const sandbox = session.config.readOnly ? 'read-only' : (this.opts.writeSandbox ?? 'workspace-write');
    const common = ['--json', '--skip-git-repo-check', '--output-schema', schemaFile, '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"'];
    if (this.profile.model) common.push('-m', this.profile.model);
    const reasoning = effort ?? this.opts.reasoningEffort;
    if (reasoning) common.push('-c', `model_reasoning_effort="${reasoning}"`);
    common.push(...(this.opts.extraArgs ?? []));
    if (session.externalId) return ['exec', 'resume', ...common, session.externalId, '-'];
    const args = ['exec', ...common, '-C', session.config.cwd];
    for (const d of session.config.additionalDirs ?? []) args.push('--add-dir', d);
    return [...args, '-'];
  }

  execute(session: AgentSession, assignment: Assignment): AsyncIterable<AgentEvent> {
    const queue = new EventQueue<AgentEvent>();
    const bin = discoverCodexBinary(this.opts.binary);
    if (!bin) {
      queue.push({ type: 'error', error: 'Codex CLI not found; set options.binary in agents.yaml or COCKPIT_CODEX_BIN', retryable: false });
      queue.close();
      return queue;
    }
    const abort = new AbortController();
    assignment.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    this.running.set(session.id, abort);
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-'));
    const schemaFile = join(dir, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(contractJsonSchema(assignment.contract)));
    let lastMessage: string | null = null;
    let failure: string | null = null;

    spawnProcess(bin, this.buildArgs(session, schemaFile, assignment.effort), {
      cwd: session.config.cwd,
      stdin: assignment.prompt,
      timeoutMs: assignment.timeoutMs,
      signal: abort.signal,
      onStdoutLine: (line) => {
        if (!line.startsWith('{')) return;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'thread.started':
            session.externalId = msg.thread_id;
            queue.push({ type: 'session', externalId: msg.thread_id });
            break;
          case 'item.completed': {
            const item = msg.item ?? {};
            if (item.type === 'agent_message') {
              lastMessage = item.text ?? '';
              queue.push({ type: 'text', text: lastMessage! });
            } else if (item.type === 'reasoning' && item.text?.trim()) queue.push({ type: 'thinking', text: item.text });
            else if (item.type === 'command_execution') queue.push({ type: 'tool', name: 'shell', detail: String(item.command ?? '').slice(0, 200) });
            else if (item.type === 'file_change') queue.push({ type: 'tool', name: 'edit', detail: JSON.stringify(item.changes ?? []).slice(0, 200) });
            break;
          }
          case 'turn.completed': {
            const u = msg.usage ?? {};
            queue.push({
              type: 'usage',
              usage: {
                model: this.profile.model ?? 'codex-default',
                inputTokens: u.input_tokens ?? 0,
                outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
                cachedTokens: u.cached_input_tokens ?? 0,
                costUsd: null,
              },
            });
            break;
          }
          case 'turn.failed':
          case 'error':
            failure = String(msg.error?.message ?? msg.message ?? JSON.stringify(msg)).slice(0, 1500);
            break;
        }
      },
    })
      .then((res) => {
        if (res.timedOut) return queue.push({ type: 'error', error: `codex timed out after ${assignment.timeoutMs}ms`, retryable: true });
        if (res.aborted) return queue.push({ type: 'error', error: 'cancelled', retryable: false });
        const output = lastMessage !== null ? extractJson(lastMessage) : undefined;
        if (output !== undefined) queue.push({ type: 'result', output });
        else queue.push({ type: 'error', error: failure ?? `codex exited ${res.exitCode} without a structured result: ${res.stderr.slice(-1500)}`, retryable: true });
      })
      .catch((err) => queue.push({ type: 'error', error: String(err?.message ?? err), retryable: false }))
      .finally(() => {
        this.running.delete(session.id);
        rmSync(dir, { recursive: true, force: true });
        queue.close();
      });
    return queue;
  }
}
