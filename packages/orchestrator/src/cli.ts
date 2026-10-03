import { spawn, spawnSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type CockpitConfig } from '@cockpit/core';
import { discoverCodexBinary } from '@cockpit/agents';
import { findExecutable, resolveLaunch } from '@cockpit/workspace';
import { CockpitClient, readDaemonInfo } from '@cockpit/transport';
import { startDaemon } from './service';
import type { RunView } from './snapshot';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const USAGE = `cockpit - hierarchical multi-agent coding cockpit

  cockpit daemon [--detach]                 start the orchestrator service
  cockpit stop                              stop the orchestrator service
  cockpit doctor                            check local Claude Code / Codex / git integration
  cockpit run "<request>" --repo <path> [--test "<cmd>"] [--base <branch>] [--repo ...] [--project <name>] [--follow]
  cockpit status [<runId>] [--json]         leadership, tasks, workers, conflicts, tests
  cockpit approvals                         pending human approvals
  cockpit approve <runId|approvalId> [note]
  cockpit changes <runId> "<what to change>"
  cockpit reject <runId|approvalId> [note]
  cockpit report <runId>                    final engineering report
  cockpit events [<runId>] [--follow]
  cockpit retry <runId>                     retry a failed run from the phase it failed in

Options: --config <dir> (default: ${join(ROOT, 'config')}; env COCKPIT_CONFIG)`;

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const repoGroups: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const boolean = ['follow', 'json', 'detach', 'help'].includes(key);
      const value = boolean ? 'true' : (argv[++i] ?? '');
      // --test / --base attach to the most recent --repo
      if ((key === 'test' || key === 'base') && repoGroups.length) {
        flags.set(`${key}@${repoGroups.length - 1}`, [value]);
        continue;
      }
      if (key === 'repo') repoGroups.push(value);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

function config(args: Args): CockpitConfig {
  const dir = args.flags.get('config')?.[0] ?? process.env.COCKPIT_CONFIG ?? join(ROOT, 'config');
  return loadConfig(resolve(dir));
}

function client(cfg: CockpitConfig): CockpitClient {
  return CockpitClient.fromDataDir(cfg.engine.dataDir);
}

const ICON: Record<string, string> = {
  pending: '·', ready: '○', running: '▶', needs_input: '?', validating: '⚙', in_review: '◎', changes_requested: '↺',
  lease_conflict: '⚠', approved: '✔', integrated: '✔✔', escalated: '⇧', failed: '✖', cancelled: '–',
};

function printRun(r: RunView & { report?: string | null }): void {
  console.log(`\n${r.id}  [${r.status}]  round ${r.round}${r.error ? `  error: ${r.error}` : ''}`);
  console.log(`  request:    ${r.request.split('\n')[0]!.slice(0, 100)}`);
  console.log(`  supervisor: ${r.leadership.supervisor}   lead: ${r.leadership.lead}`);
  for (const repo of r.repositories) console.log(`  repo ${repo.name}: ${repo.path} (${repo.baseBranch})${repo.integration ? ` -> ${repo.integration.branch} tests ${repo.integration.passed ? 'passed' : 'FAILED'}` : ''}`);
  if (r.tasks.length) {
    console.log('  tasks:');
    for (const t of r.tasks) {
      console.log(`    ${ICON[t.status] ?? ' '} ${t.key.padEnd(9)} ${t.status.padEnd(17)} ${String(t.agentId ?? '-').padEnd(14)} ${t.repo.padEnd(12)} it${t.iteration} ${t.title.slice(0, 50)}${t.dependsOn.length ? ` <- ${t.dependsOn.join(',')}` : ''}`);
      if (t.blockedReason && ['escalated', 'failed', 'cancelled', 'lease_conflict'].includes(t.status)) console.log(`        ${t.blockedReason.slice(0, 140)}`);
    }
  }
  if (r.workers.length) console.log(`  workers: ${r.workers.map((w) => `${w.agentId}@${w.task}`).join(', ')}`);
  for (const c of r.conflicts) console.log(`  conflict: ${c.task} wants ${c.pattern} held by ${c.heldBy}`);
  if (r.tests.length) console.log(`  tests: ${r.tests.slice(-4).map((t) => `${t.scope}${t.task ? `/${t.task}` : ''}:${t.status}`).join('  ')}`);
  console.log(`  usage: ${r.telemetry.calls} calls, ${r.telemetry.inputTokens} in / ${r.telemetry.outputTokens} out tokens${r.telemetry.costUsd ? `, $${r.telemetry.costUsd.toFixed(3)}` : ''}`);
}

async function resolveApprovalTarget(c: CockpitClient, id: string): Promise<{ path: string }> {
  if (id.startsWith('apr_')) return { path: `/approvals/${id}` };
  return { path: `/runs/${id}/decision` };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args.positional;
  if (!cmd || args.flags.has('help')) return void console.log(USAGE);
  const cfg = config(args);

  switch (cmd) {
    case 'daemon': {
      const existing = readDaemonInfo(cfg.engine.dataDir);
      if (existing) {
        try {
          await new CockpitClient(existing).request('GET', '/health');
          return void console.log(`orchestrator already running (pid ${existing.pid}, port ${existing.port})`);
        } catch {
          /* stale daemon.json */
        }
      }
      if (args.flags.has('detach')) {
        mkdirSync(cfg.engine.dataDir, { recursive: true });
        const log = openSync(join(cfg.engine.dataDir, 'daemon.log'), 'a');
        const argvOut = [join(ROOT, 'bin', 'cockpit.mjs'), 'daemon', ...(args.flags.get('config') ? ['--config', args.flags.get('config')![0]!] : [])];
        const child = spawn(process.execPath, argvOut, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
        child.unref();
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const info = readDaemonInfo(cfg.engine.dataDir);
          if (info && info.pid === child.pid) return void console.log(`orchestrator started (pid ${info.pid}, port ${info.port})`);
        }
        throw new Error(`daemon did not start; see ${join(cfg.engine.dataDir, 'daemon.log')}`);
      }
      const d = await startDaemon(cfg);
      console.log(`orchestrator listening on 127.0.0.1:${d.info.port} (pid ${process.pid}); data in ${cfg.engine.dataDir}`);
      const stop = () => void d.stop().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'stop':
      await client(cfg).request('POST', '/shutdown');
      return void console.log('orchestrator stopping');
    case 'doctor': {
      const claude = findExecutable('claude');
      const codex = discoverCodexBinary();
      const git = findExecutable('git');
      const v = (bin: string | null, a: string[]) => {
        if (!bin) return 'NOT FOUND';
        const l = resolveLaunch(bin);
        const r = spawnSync(l.command, [...l.prefixArgs, ...a], { encoding: 'utf8', windowsHide: true });
        return (r.stdout || r.stderr || String(r.error ?? '')).trim().split('\n')[0];
      };
      console.log(`node    ${process.version}`);
      console.log(`git     ${git ?? 'NOT FOUND'}  ${v(git, ['--version'])}`);
      console.log(`claude  ${claude ?? 'NOT FOUND'}  ${v(claude, ['--version'])}`);
      console.log(`codex   ${codex ?? 'NOT FOUND'}  ${v(codex, ['--version'])}  ${codex ? v(codex, ['login', 'status']) : ''}`);
      console.log(`hierarchy: supervisor=${cfg.agents.hierarchy.supervisor} lead=${cfg.agents.hierarchy.lead}`);
      console.log(`workers: ${cfg.agents.agents.filter((a) => a.enabled && a.roles.includes('worker')).map((a) => a.id).join(', ')}`);
      console.log(`data dir: ${cfg.engine.dataDir}`);
      const info = readDaemonInfo(cfg.engine.dataDir);
      console.log(`daemon: ${info ? `pid ${info.pid} port ${info.port}` : 'not running'}`);
      return;
    }
    case 'run': {
      const request = rest.join(' ');
      const repoPaths = args.flags.get('repo') ?? [];
      if (!request || !repoPaths.length) throw new Error('usage: cockpit run "<request>" --repo <path> [--test "<cmd>"]');
      const repos = repoPaths.map((p, i) => ({
        path: resolve(p),
        testCommand: args.flags.get(`test@${i}`)?.[0] ?? null,
        baseBranch: args.flags.get(`base@${i}`)?.[0],
      }));
      const c = client(cfg);
      const run = await c.request<{ id: string }>('POST', '/runs', { request, repos, project: args.flags.get('project')?.[0] });
      console.log(`run ${run.id} started`);
      if (args.flags.has('follow')) await follow(c, run.id);
      return;
    }
    case 'status': {
      const c = client(cfg);
      if (rest[0]) {
        const r = await c.request<RunView & { report: string | null }>('GET', `/runs/${rest[0]}`);
        return args.flags.has('json') ? console.log(JSON.stringify(r, null, 2)) : printRun(r);
      }
      const snap = await c.request<{ runs: RunView[]; pendingApprovals: { id: string; runId: string; kind: string; summary: string }[] }>('GET', '/snapshot');
      if (args.flags.has('json')) return console.log(JSON.stringify(snap, null, 2));
      if (!snap.runs.length) console.log('no runs');
      for (const r of snap.runs) printRun(r);
      if (snap.pendingApprovals.length) {
        console.log('\npending approvals:');
        for (const a of snap.pendingApprovals) console.log(`  ${a.id} [${a.kind}] run ${a.runId}: ${a.summary.slice(0, 140)}`);
      }
      return;
    }
    case 'approvals': {
      const list = await client(cfg).request<{ id: string; runId: string; kind: string; operation: string | null; summary: string }[]>('GET', '/approvals?status=pending');
      if (!list.length) return void console.log('no pending approvals');
      for (const a of list) console.log(`${a.id} [${a.kind}${a.operation ? `/${a.operation}` : ''}] run ${a.runId}\n  ${a.summary}`);
      return;
    }
    case 'approve':
    case 'reject':
    case 'changes': {
      const id = rest[0];
      if (!id) throw new Error(`usage: cockpit ${cmd} <runId|approvalId> [note]`);
      const c = client(cfg);
      const target = await resolveApprovalTarget(c, id);
      const decision = cmd === 'approve' ? 'approve' : cmd === 'reject' ? 'reject' : 'request_changes';
      await c.request('POST', target.path, { decision, response: rest.slice(1).join(' ') || null });
      return void console.log(`${decision} recorded`);
    }
    case 'report': {
      const r = await client(cfg).request<{ report: string | null }>('GET', `/runs/${rest[0]}/report`);
      return void console.log(r.report ?? 'no report yet');
    }
    case 'events': {
      const c = client(cfg);
      if (args.flags.has('follow')) return follow(c, rest[0]);
      const events = await c.request<{ ts: string; type: string; data: unknown }[]>('GET', `/events${rest[0] ? `?runId=${rest[0]}` : ''}`);
      for (const e of events) console.log(`${e.ts.slice(11, 19)} ${e.type.padEnd(24)} ${JSON.stringify(e.data).slice(0, 160)}`);
      return;
    }
    case 'retry':
      await client(cfg).request('POST', `/runs/${rest[0]}/retry`);
      return void console.log('retrying');
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

async function follow(c: CockpitClient, runId?: string): Promise<void> {
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  await c.follow(`/events${runId ? `?runId=${runId}` : ''}`, (type, data) => {
    const e = data as { ts: string; data: unknown };
    console.log(`${e.ts.slice(11, 19)} ${type.padEnd(24)} ${JSON.stringify(e.data).slice(0, 160)}`);
    if (type === 'approval.requested' || type === 'run.completed') {
      console.log(type === 'run.completed' ? '\nrun finished.' : `\nhuman input needed: cockpit approvals`);
      if (type === 'run.completed') ac.abort();
    }
  }, ac.signal);
}
