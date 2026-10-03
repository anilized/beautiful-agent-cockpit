// Exercises the real Claude Code and Codex CLIs through the adapters (uses your existing logins).
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, parseContract } from '@cockpit/core';
import { AdapterRegistry } from '@cockpit/agents';

const config = loadConfig(resolve('config'));
const registry = new AdapterRegistry(config);

async function call(agentId: string, contract: any, prompt: string, cwd: string, readOnly: boolean) {
  const adapter = registry.get(agentId);
  const session = await adapter.startSession({ agentId, role: 'worker', cwd, readOnly });
  const started = Date.now();
  let result: unknown;
  for await (const ev of adapter.execute(session, { prompt, contract, timeoutMs: 300_000 })) {
    if (ev.type === 'result') result = ev.output;
    else if (ev.type === 'error') console.log(`  [${agentId}] error: ${ev.error}`);
    else if (ev.type === 'usage') console.log(`  [${agentId}] usage`, ev.usage);
    else if (ev.type === 'tool') console.log(`  [${agentId}] tool ${ev.name}: ${ev.detail}`);
  }
  console.log(`  [${agentId}] ${Date.now() - started}ms session=${session.externalId}`);
  return { output: parseContract(contract, result), session };
}

const dir = mkdtempSync(join(tmpdir(), 'cockpit-smoke-'));
const which = process.argv[2] ?? 'all';
if (which === 'all' || which === 'codex') {
  console.log('codex (lead, read-only):');
  const r = await call('codex', 'LeadAnswer', 'A worker asks: should a JS function that adds two numbers be named add or sum? Answer briefly.', dir, true);
  console.log('  ->', r.output);
}
if (which === 'all' || which === 'claude') {
  console.log('sonnet (worker, edits):');
  const r = await call('sonnet', 'WorkerResult', 'Create a file add.js in the current directory exporting function add(a,b) returning a+b. Do not run anything else. Then return your structured result with status completed.', dir, false);
  console.log('  ->', r.output.status, r.output.summary);
  console.log('  file exists:', existsSync(join(dir, 'add.js')), existsSync(join(dir, 'add.js')) ? readFileSync(join(dir, 'add.js'), 'utf8').slice(0, 120) : '');
  console.log('sonnet (resume same session):');
  const adapter = registry.get('sonnet');
  const s2 = await adapter.resume(r.session.externalId!, { agentId: 'sonnet', role: 'worker', cwd: dir, readOnly: false });
  for await (const ev of adapter.execute(s2, { prompt: 'What file did you just create? Return structured result with status completed and that file in filesChanged.', contract: 'WorkerResult', timeoutMs: 300_000 })) {
    if (ev.type === 'result') console.log('  ->', (ev.output as any).filesChanged);
    if (ev.type === 'error') console.log('  error', ev.error);
  }
}
