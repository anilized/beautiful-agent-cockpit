import { join } from 'node:path';
import type { CockpitConfig } from '@cockpit/core';
import { AdapterRegistry, AgentRouter } from '@cockpit/agents';
import { Store } from '@cockpit/persistence';
import { Telemetry } from '@cockpit/telemetry';
import { LeaseManager, WorkspaceManager } from '@cockpit/workspace';
import { HttpError, LocalServer, sse, type DaemonInfo } from '@cockpit/transport';
import { AgentRunner } from './agent-runner';
import type { EngineContext } from './context';
import { Orchestrator, type HumanDecision, type StartRunInput } from './engine';
import { EventBus } from './event-bus';
import { PermissionEngine } from './permission-engine';
import { buildSnapshot, runView, writeSnapshot } from './snapshot';
import { dashboardHtml, telemetryView } from './dashboard';
import { LiveWorkspaces } from './live';

export interface EngineOptions {
  /** Register extra adapter factories (tests use the fake adapter). */
  configureRegistry?: (registry: AdapterRegistry) => void;
  telemetry?: Telemetry;
  dbPath?: string;
}

/** Compose the orchestrator from its modules. */
export async function createEngine(config: CockpitConfig, opts: EngineOptions = {}): Promise<Orchestrator> {
  const dataDir = config.engine.dataDir;
  const store = new Store(opts.dbPath ?? join(dataDir, 'cockpit.db'));
  const bus = new EventBus(store);
  const telemetry =
    opts.telemetry ??
    (await Telemetry.init({ dataDir, fileExport: config.engine.telemetry.fileExport, otlpEndpoint: config.engine.telemetry.otlpEndpoint }));
  const registry = new AdapterRegistry(config);
  opts.configureRegistry?.(registry);
  const ctx: EngineContext = {
    config,
    store,
    bus,
    telemetry,
    registry,
    router: new AgentRouter(config.agents.agents, config.routing),
    runner: new AgentRunner(store, bus, telemetry, registry),
    leases: new LeaseManager(store),
    workspaces: new WorkspaceManager(join(dataDir, 'worktrees')),
    permissions: new PermissionEngine(config.permissions),
  };
  return new Orchestrator(ctx);
}

export interface Daemon {
  engine: Orchestrator;
  info: DaemonInfo;
  stop(): Promise<void>;
}

/** The orchestrator service: engine + local transport + snapshot projection for the cockpit. */
/** How often the worktrees of live tasks are re-read for the cockpit. */
const LIVE_REFRESH_MS = 3000;

export async function startDaemon(config: CockpitConfig, opts: EngineOptions = {}): Promise<Daemon> {
  const engine = await createEngine(config, opts);
  const { store, bus, telemetry } = engine.ctx;
  const dataDir = config.engine.dataDir;
  const server = new LocalServer();
  let port: number | null = null;

  let timer: NodeJS.Timeout | null = null;
  const refreshSnapshot = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        writeSnapshot(dataDir, buildSnapshot(store, config, { pid: process.pid, port }, (id) => live.get(id)));
      } catch {
        /* presentation only */
      }
    }, 300);
  };
  const unsubscribe = bus.subscribe(refreshSnapshot);
  // The worktrees of live tasks, read every few seconds: the cockpit's changed files and code preview.
  const live = new LiveWorkspaces(store, refreshSnapshot);
  const liveTimer = setInterval(() => void live.refresh().catch(() => {}), LIVE_REFRESH_MS);

  const decision = (body: unknown): { decision: HumanDecision; response: string | null } => {
    const b = (body ?? {}) as { decision?: string; response?: string };
    if (!['approve', 'reject', 'request_changes'].includes(b.decision ?? '')) throw new HttpError(400, 'decision must be approve | reject | request_changes');
    return { decision: b.decision as HumanDecision, response: b.response ?? null };
  };

  server
    .route('GET', '/health', () => ({ ok: true, pid: process.pid }))
    .route('GET', '/snapshot', () => buildSnapshot(store, config, { pid: process.pid, port }, (id) => live.get(id)))
    .route('GET', '/runs', () => store.runs(50))
    .route('POST', '/runs', async ({ body }) => engine.startRun(body as StartRunInput))
    .route('GET', '/runs/:id', ({ params }) => {
      const run = store.runById(params.id!);
      if (!run) throw new HttpError(404, 'unknown run');
      return { ...runView(store, config, run), report: run.report, architecture: run.architecture };
    })
    .route('GET', '/runs/:id/report', ({ params }) => ({ report: store.runById(params.id!)?.report ?? null }))
    .route('POST', '/runs/:id/efforts', ({ params, body }) => engine.setEfforts(params.id!, (body ?? {}) as Record<string, string>))
    .route('POST', '/runs/:id/roles', ({ params, body }) => engine.setRoles(params.id!, (body ?? {}) as { supervisor?: string; lead?: string }))
    .route('POST', '/runs/:id/retry', ({ params }) => (engine.retry(params.id!), { ok: true }))
    .route('POST', '/runs/:id/decision', ({ params, body }) => {
      const d = decision(body);
      return engine.decideRun(params.id!, d.decision, d.response);
    })
    .route('GET', '/approvals', ({ query }) => store.approvals({ status: (query.get('status') as 'pending') ?? undefined, runId: query.get('runId') ?? undefined }))
    .route('POST', '/approvals/:id', ({ params, body }) => {
      const d = decision(body);
      return engine.resolveApproval(params.id!, d.decision, d.response);
    })
    .route('GET', '/events', ({ query, req, res }) => {
      const runId = query.get('runId') ?? undefined;
      const since = Number(query.get('since') ?? 0);
      if (!String(req.headers.accept).includes('text/event-stream')) return store.events({ runId, since, limit: Number(query.get('limit') ?? 500) });
      let off = () => {};
      const send = sse(res, () => off());
      for (const e of store.events({ runId, since, limit: 1000 })) send(e.type, e, e.seq);
      off = bus.subscribe((e) => {
        if (!runId || e.runId === runId) send(e.type, e, e.seq);
      });
      return undefined;
    })
    // The telemetry dashboard: a static page (public) that reads /telemetry with the read-only token.
    .route('GET', '/dashboard', ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dashboardHtml());
      return undefined;
    }, { public: true })
    .route('GET', '/telemetry', ({ query }) => telemetryView(store, dataDir, query.get('runId')))
    .route('POST', '/shutdown', () => {
      setTimeout(() => void stop().then(() => process.exit(0)), 50);
      return { ok: true };
    });

  const info = await server.listen(config.engine.transport.port, dataDir);
  port = info.port;
  const resumed = engine.recover();
  refreshSnapshot();

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    clearInterval(liveTimer);
    await engine.shutdown();
    await server.close(dataDir);
    if (timer) clearTimeout(timer);
    writeSnapshot(dataDir, buildSnapshot(store, config, { pid: process.pid, port: null }));
    await telemetry.shutdown();
    store.close();
  }
  if (resumed.length) console.log(`resumed ${resumed.length} active run(s): ${resumed.join(', ')}`);
  return { engine, info, stop };
}
