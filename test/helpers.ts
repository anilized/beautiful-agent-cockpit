import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentsConfig,
  EngineConfig,
  PermissionsConfig,
  RoutingConfig,
  type CockpitConfig,
} from '@cockpit/core';
import { FakeAdapter, type FakeHandler } from '@cockpit/agents';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { Telemetry } from '@cockpit/telemetry';
import { createEngine, type Orchestrator } from '@cockpit/orchestrator';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cockpit-${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

/** A repo whose test command fails if any file under src/ contains the word "bug". */
export function makeRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'src', '.keep'), '');
  writeFileSync(
    join(dir, 'check.js'),
    `const fs=require('fs');const p=require('path');let bad=[];(function w(d){for(const f of fs.readdirSync(d)){const x=p.join(d,f);if(fs.statSync(x).isDirectory())w(x);else if(fs.readFileSync(x,'utf8').includes('bug'))bad.push(x)}})('src');if(bad.length){console.error('bug found in',bad.join(','));process.exit(1)}console.log('ok')\n`,
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function testConfig(dataDir: string, overrides: Partial<CockpitConfig['engine']> = {}): CockpitConfig {
  return {
    engine: EngineConfig.parse({ dataDir, maxParallelTasks: 4, telemetry: { fileExport: false, otlpEndpoint: null }, ...overrides }),
    agents: AgentsConfig.parse({
      hierarchy: { supervisor: 'opus', lead: 'codex' },
      agents: [
        { id: 'opus', adapter: 'fake', model: 'opus', roles: ['supervisor'] },
        { id: 'codex', adapter: 'fake', model: 'codex', roles: ['lead'] },
        { id: 'sonnet', adapter: 'fake', model: 'sonnet', roles: ['worker'] },
      ],
    }),
    routing: RoutingConfig.parse({ fallback: ['sonnet'] }),
    permissions: PermissionsConfig.parse({}),
  };
}

export async function fakeEngine(config: CockpitConfig, handler: FakeHandler, exporter = new InMemorySpanExporter()): Promise<{ engine: Orchestrator; exporter: InMemorySpanExporter }> {
  const telemetry = await Telemetry.init({ dataDir: config.engine.dataDir, fileExport: false, otlpEndpoint: null, exporter });
  const engine = await createEngine(config, {
    telemetry,
    configureRegistry: (r) => r.register('fake', (p) => new FakeAdapter(p, handler)),
  });
  return { engine, exporter };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
