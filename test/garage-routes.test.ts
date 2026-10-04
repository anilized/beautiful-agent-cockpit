import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAdapter } from '@cockpit/agents';
import { startDaemon, type Daemon } from '@cockpit/orchestrator';
import { GARAGE_CSP } from '../packages/orchestrator/src/garage';
import { testConfig, tempDir } from './helpers';

let daemon: Daemon;
let readToken: string;
let base: string;

beforeAll(async () => {
  const root = tempDir('garage-routes');
  const srcDir = join(root, 'garage-src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'index.html'), '<!doctype html><title>garage</title>');
  writeFileSync(join(srcDir, 'mapper.ts'), 'export const answer: number = 42;\n');
  // A sibling of the source directory: what a traversal would reach.
  writeFileSync(join(root, 'secret.ts'), 'export const secret = 1;\n');
  daemon = await startDaemon(testConfig(join(root, 'data')), {
    dbPath: ':memory:',
    garageSrcDir: srcDir,
    configureRegistry: (r) => r.register('fake', (p) => new FakeAdapter(p, async () => ({ text: '' }))),
  });
  readToken = daemon.info.readToken!;
  base = `http://127.0.0.1:${daemon.info.port}`;
});

afterAll(async () => {
  await daemon.stop();
});

/** A request with the path exactly as written (fetch would normalise dot segments and some escapes). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: daemon.info.port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('garage routes', () => {
  it('serves the page publicly with the CSP', async () => {
    const res = await raw('/garage');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(GARAGE_CSP);
    expect(res.body).toContain('<title>garage</title>');
  });

  it('serves a real module as transpiled JavaScript without a token', async () => {
    const res = await raw('/garage/mapper.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('export');
    expect(res.body).not.toContain(': number');
  });

  it('404s a missing module and every traversal or non-module name', async () => {
    const names = [
      'missing.js',
      'mapper.ts', // only <name>.js is a module name
      'mapper.js.map',
      '..%2Fsecret.js',
      '%2e%2e%2fsecret.js',
      '..%5Csecret.js',
      'sub%2Fmapper.js',
      '%2Fetc%2Fpasswd.js',
      'C%3A%5Cwindows%5Cwin.js',
      'mapper.js%00.png',
    ];
    for (const n of names) {
      const res = await raw(`/garage/${n}`);
      expect(res.status, n).toBe(404);
    }
    // Dot segments are collapsed by the server's URL parsing: the path no longer matches a garage route,
    // so it is the 401 of any unknown path without a token, and a plain 404 with one.
    for (const p of ['/garage/../secret.js', '/garage/%2e%2e/secret.js', '/garage/./../secret.js']) {
      expect((await raw(p)).status, p).toBe(401);
      expect((await raw(p, { authorization: `Bearer ${readToken}` })).status, p).toBe(404);
    }
  });

  it('keeps the transport semantics: unknown unauthenticated paths are 401, malformed escapes 400', async () => {
    expect((await raw('/nope')).status).toBe(401);
    expect((await raw('/garage/mapper.js/extra')).status).toBe(401);
    expect((await raw('/nope', { authorization: `Bearer ${readToken}` })).status).toBe(404);
    expect((await raw('/garage/%E0%A4%A')).status).toBe(400);
    expect((await raw('/garage/%')).status).toBe(400);
  });

  it('keeps the data routes behind the token', async () => {
    for (const p of ['/snapshot', '/events', '/runs', '/approvals', '/telemetry', '/snapshot?runId=x', '/events?catchup=1']) {
      expect((await raw(p)).status, p).toBe(401);
      expect((await raw(p, { authorization: 'Bearer wrong' })).status, p).toBe(401);
    }
    const ok = await raw('/snapshot', { authorization: `Bearer ${readToken}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).lastSeq).toBeTypeOf('number');
  });

  it('the read token cannot POST', async () => {
    const res = await fetch(`${base}/garage`, { method: 'POST', headers: { authorization: `Bearer ${readToken}` } });
    expect(res.status).toBe(401);
  });
});
