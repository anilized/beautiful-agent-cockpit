import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CockpitConfig } from '@cockpit/core';
import type { Store } from '@cockpit/persistence';
import type { Limits } from './limits';
import { describe, detailOf, minds, runView, type MindView, type RunView } from './snapshot';

/**
 * The telemetry dashboard's data: every model call, span and event of one run, read
 * from the store and the local trace files. Presentation only, like the snapshot.
 */
export interface TelemetryView {
  generatedAt: string;
  runs: { id: string; request: string; status: string; createdAt: string }[];
  run: { id: string; request: string; status: string; createdAt: string; updatedAt: string } | null;
  calls: { ts: string; agentId: string; role: string; model: string; task: string | null; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null; durationMs: number }[];
  tasks: { key: string; title: string; status: string; iteration: number; agentId: string | null; description: string; dependsOn: string[]; round: number; specialty: string; persona: string | null; lead: string | null }[];
  /** Every model session of the run, newest first, with what it said, reasoned and ran. */
  minds: MindView[];
  spans: { name: string; start: string; durationMs: number; status: string; error: string | null; role: string | null; agentId: string | null; task: string | null; contract: string | null; inputTokens: number | null; outputTokens: number | null }[];
  events: { seq: number; ts: string; type: string; task: string | null; agentId: string | null; text: string; detail: string }[];
  /** The council, the leads and the worker personas (with what each is doing), as the cockpit shows them. */
  crew: { council: RunView['council']; leads: RunView['leads']; team: RunView['team'] } | null;
  /** What is left of each subscription window. */
  limits: Limits;
  /** The cockpit's look: its name in the header and the palette (phosphor or neon). */
  brand: string;
  theme: string;
}

/** What the daemon adds to the store's view: the config (for the crew) and the latest subscription limits. */
export interface TelemetryContext {
  config: CockpitConfig;
  limits: Limits;
}

/** Events and spans sent per request; the page shows the newest. */
const MAX_EVENTS = 3000;
const MAX_SPANS = 3000;
/** The dashboard shows every session of the run and a long stream for each. */
const MIND_LIMITS = { sessions: 200, activity: 400, text: 6000 };

export function telemetryView(store: Store, dataDir: string, runId: string | null, ctx?: TelemetryContext): TelemetryView {
  const runs = store.runs(50);
  const run = (runId ? store.runById(runId) : null) ?? runs.find((r) => !['completed', 'rejected', 'failed'].includes(r.status)) ?? runs[0] ?? null;
  const base: TelemetryView = {
    generatedAt: new Date().toISOString(),
    runs: runs.map((r) => ({ id: r.id, request: r.request, status: r.status, createdAt: r.createdAt })),
    run: null, calls: [], tasks: [], spans: [], events: [], minds: [],
    crew: null, limits: ctx?.limits ?? {},
    brand: process.env.COCKPIT_BRAND || 'ANILDEV', theme: process.env.COCKPIT_THEME === 'neon' ? 'neon' : 'phosphor',
  };
  if (!run) return base;
  const tasks = store.tasks(run.id);
  const keyById = new Map(tasks.map((t) => [t.id, t.key]));
  const keyOf = (id: unknown) => (id ? keyById.get(String(id)) ?? String(id) : '');
  const all = store.events({ runId: run.id, limit: 1_000_000 });
  const events = all.slice(-MAX_EVENTS);
  const deps = store.dependencies(run.id);
  const view = ctx ? runView(store, ctx.config, run) : null;
  const byKey = new Map((view?.tasks ?? []).map((t) => [t.key, t]));
  return {
    ...base,
    run: { id: run.id, request: run.request, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt },
    calls: store.usage(run.id).map((u) => ({
      ts: u.createdAt, agentId: u.agentId, role: u.role, model: u.model, task: u.taskId ? keyOf(u.taskId) : null,
      inputTokens: u.inputTokens, cachedTokens: u.cachedTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, durationMs: u.durationMs,
    })),
    tasks: tasks.map((t) => ({
      key: t.key, title: t.title, status: t.status, iteration: t.iteration, agentId: t.agentId, description: t.description, round: t.round,
      specialty: t.specialty, persona: byKey.get(t.key)?.persona ?? null, lead: byKey.get(t.key)?.lead ?? null,
      dependsOn: deps.filter((d) => d.taskId === t.id).map((d) => keyOf(d.dependsOn)),
    })),
    minds: minds(store.sessions(run.id), all, keyOf, MIND_LIMITS),
    crew: view ? { council: view.council, leads: view.leads, team: view.team } : null,
    spans: readSpans(dataDir, run.id, keyOf),
    events: events.map((e) => {
      const d = e.data as { taskId?: string; agentId?: string };
      return { seq: e.seq, ts: e.ts, type: e.type, task: d.taskId ? keyOf(d.taskId) : null, agentId: d.agentId ?? null, text: describe(e, keyOf), detail: detailOf(e, keyOf) };
    }),
  };
}

/** The run's spans from <dataDir>/traces/spans-*.jsonl (written by the file exporter). */
function readSpans(dataDir: string, runId: string, keyOf: (id: unknown) => string): TelemetryView['spans'] {
  const dir = join(dataDir, 'traces');
  if (!existsSync(dir)) return [];
  const out: TelemetryView['spans'] = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith('spans-') && n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.includes(runId)) continue;
      try {
        const s = JSON.parse(line) as { name: string; start: string; durationMs: number; status: string; error: string | null; attributes: Record<string, unknown> };
        const a = s.attributes ?? {};
        if (a['cockpit.run_id'] !== runId) continue;
        const num = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : null);
        out.push({
          name: s.name, start: s.start, durationMs: s.durationMs, status: s.status, error: s.error,
          role: (a['cockpit.role'] as string) ?? null, agentId: (a['cockpit.agent_id'] as string) ?? null,
          task: a['cockpit.task_id'] ? keyOf(a['cockpit.task_id']) : null, contract: (a['cockpit.contract'] as string) ?? null,
          inputTokens: num('gen_ai.usage.input_tokens'), outputTokens: num('gen_ai.usage.output_tokens'),
        });
      } catch {
        /* a partly written line */
      }
    }
  }
  return out.sort((x, y) => x.start.localeCompare(y.start)).slice(-MAX_SPANS);
}

/** The page, read from dashboard.html beside this module on each request: an edit shows on reload, no daemon restart. */
export function dashboardHtml(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8');
}
