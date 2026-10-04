import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GARAGE_CSP, garageHtml, garageModule } from '../packages/orchestrator/src/garage';
import { tempDir } from './helpers';

// garageModule is tested directly with an injected source directory; the real garage sources are not involved.
let srcDir: string;
let outside: string;

beforeEach(() => {
  const root = tempDir('garage-mod');
  srcDir = join(root, 'src');
  outside = join(root, 'outside');
  mkdirSync(srcDir);
  mkdirSync(outside);
  writeFileSync(join(srcDir, 'main.ts'), 'export const n: number = 1;\n');
  writeFileSync(join(outside, 'secret.ts'), 'export const secret: string = "x";\n');
});

const notFound = async (name: string) => {
  const res = await garageModule(name, { srcDir });
  expect(res.status, name).toBe(404);
  expect(res.body).not.toContain('secret');
};

describe('garageModule', () => {
  it('serves an existing module as transpiled JavaScript', async () => {
    const res = await garageModule('main.js', { srcDir });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('const n = 1');
    expect(res.body).not.toContain(': number');
    expect(res.body).toContain('sourceMappingURL=data:application/json');
  });

  it('refuses traversal, encoded traversal and absolute paths', async () => {
    for (const name of [
      '../outside/secret.js', '..\\outside\\secret.js', '../src/main.js', '..%2foutside%2fsecret.js', '%2e%2e%2foutside%2fsecret.js',
      '%2e%2e/secret.js', '..', '../', '.js', '/main.js', join(srcDir, 'main.js'), join(outside, 'secret.js'), 'C:\\secret.js', 'sub/main.js',
    ]) await notFound(name);
  });

  it('refuses names that are not <name>.js', async () => {
    writeFileSync(join(srcDir, 'data.json'), '{}');
    writeFileSync(join(srcDir, 'index.html'), '<p>x</p>');
    for (const name of ['main.ts', 'main', 'main.js.map', 'main.mjs', 'data.json', 'index.html', 'main.js/', 'main.js\0', 'main .js', '', 'ma.in.js']) await notFound(name);
  });

  it('refuses a missing module and a directory named like one', async () => {
    mkdirSync(join(srcDir, 'dir.ts'));
    await notFound('missing.js');
    await notFound('dir.js');
    expect((await garageModule('main.js', { srcDir: join(srcDir, 'nope') })).status).toBe(404);
  });

  it('refuses a link that leads out of the source directory', async () => {
    try {
      symlinkSync(join(outside, 'secret.ts'), join(srcDir, 'evil.ts'), 'file');
    } catch {
      return; // links need privileges on some platforms; the dirname check is the same either way
    }
    await notFound('evil.js');
  });

  it('refuses a link to a file in another directory of the source tree', async () => {
    mkdirSync(join(srcDir, 'sub'));
    writeFileSync(join(srcDir, 'sub', 'deep.ts'), 'export const d = 1;\n');
    try {
      symlinkSync(join(srcDir, 'sub', 'deep.ts'), join(srcDir, 'alias.ts'), 'file');
    } catch {
      return;
    }
    await notFound('alias.js');
    await notFound('deep.js');
  });

  it('re-transpiles after the file changes', async () => {
    const file = join(srcDir, 'main.ts');
    const first = await garageModule('main.js', { srcDir });
    expect(first.body).toContain('const n = 1');
    // the same mtime is served from the cache, even if the file differs (it cannot, in practice)
    const t0 = new Date(Date.now() - 60_000);
    utimesSync(file, t0, t0);
    const stale = await garageModule('main.js', { srcDir });
    writeFileSync(file, 'export const n: number = 2;\n');
    utimesSync(file, t0, t0);
    expect((await garageModule('main.js', { srcDir })).body).toBe(stale.body);
    const t1 = new Date(t0.getTime() + 5_000);
    utimesSync(file, t1, t1);
    const second = await garageModule('main.js', { srcDir });
    expect(second.status).toBe(200);
    expect(second.body).toContain('const n = 2');
  });

  it('answers 500 when the module does not transpile', async () => {
    writeFileSync(join(srcDir, 'broken.ts'), 'export const = ;\n');
    const res = await garageModule('broken.js', { srcDir });
    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('garageHtml', () => {
  it('reads index.html on each request and carries the page CSP', () => {
    writeFileSync(join(srcDir, 'index.html'), '<p>one</p>');
    const one = garageHtml({ srcDir });
    expect(one.status).toBe(200);
    expect(one.body).toBe('<p>one</p>');
    expect(one.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(one.headers['content-security-policy']).toBe(GARAGE_CSP);
    writeFileSync(join(srcDir, 'index.html'), '<p>two</p>');
    expect(garageHtml({ srcDir }).body).toBe('<p>two</p>');
  });

  it('answers 404 without an index.html, and the CSP is the agreed one', () => {
    expect(garageHtml({ srcDir }).status).toBe(404);
    expect(GARAGE_CSP).toBe("default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:");
  });
});
