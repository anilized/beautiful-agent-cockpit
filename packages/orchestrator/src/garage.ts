import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pixel Garage's static side: the page and its modules. The garage is a no-build package of TypeScript
 * (packages/garage/src); each module is transpiled on request by esbuild, loaded lazily on the first one,
 * and cached by file and mtime. Presentation only: nothing here touches a run.
 */

/** The page's Content-Security-Policy: same-origin scripts and data, inline styles allowed, no inline scripts. */
export const GARAGE_CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";

/** Where the garage sources live; tests inject a temp directory instead. */
export interface GarageOptions {
  srcDir?: string;
}

export interface GarageResponse {
  status: 200 | 404 | 500;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'garage', 'src');

/** The only module names served: a bare file name ending in .js, which maps to the .ts beside it. */
const MODULE_NAME = /^[A-Za-z0-9_-]+\.js$/;

const NO_STORE = 'no-store';

function text(status: 404 | 500, body: string): GarageResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE }, body };
}

/** The page, read from index.html in the garage sources on each request: an edit shows on reload. */
export function garageHtml(opts: GarageOptions = {}): GarageResponse {
  let body: string;
  try {
    body = readFileSync(join(opts.srcDir ?? DEFAULT_SRC_DIR, 'index.html'), 'utf8');
  } catch {
    return text(404, 'not found');
  }
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE, 'content-security-policy': GARAGE_CSP }, body };
}

type Transform = (code: string, options: Record<string, unknown>) => Promise<{ code: string }>;
let transform: Transform | undefined;

/** esbuild is imported on the first module request, never at load. */
async function esbuildTransform(): Promise<Transform> {
  transform ??= (await import('esbuild')).transform as Transform;
  return transform;
}

const cache = new Map<string, { mtimeMs: number; code: string }>();

/**
 * three.js, the 3D garage's one dependency, served from its package as built (no transpile) under fixed names: `three.js`
 * is its module entry, which imports `./three.core.js` beside it. Same origin, so the page's CSP holds.
 */
const VENDOR: Record<string, string> = { 'three.js': 'three.module.js', 'three.core.js': 'three.core.js' };
let threeBuild: string | null | undefined;
const vendorCache = new Map<string, { mtimeMs: number; code: string }>();

async function vendorModule(file: string): Promise<GarageResponse> {
  try {
    // `three` resolves to build/three.cjs: its build directory holds the module files.
    threeBuild ??= dirname(createRequire(import.meta.url).resolve('three'));
  } catch {
    threeBuild = null;
  }
  if (!threeBuild) return text(404, 'not found');
  try {
    const path = join(threeBuild, file);
    const { mtimeMs } = await stat(path);
    const hit = vendorCache.get(path);
    const code = hit && hit.mtimeMs === mtimeMs ? hit.code : await readFile(path, 'utf8');
    vendorCache.set(path, { mtimeMs, code });
    // A library build, not a garage source: it changes only with the package, so the browser may keep it for an hour.
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=3600' }, body: code };
  } catch {
    return text(404, 'not found');
  }
}

/**
 * One garage module as JavaScript. This is the single authority on module names: the name must be
 * `<name>.js`, and after resolving links the matching `<name>.ts` must sit directly in the garage
 * source directory. Anything else (traversal, links out, absolute paths, missing files) is a 404.
 */
export async function garageModule(name: string, opts: GarageOptions = {}): Promise<GarageResponse> {
  if (typeof name === 'string' && Object.hasOwn(VENDOR, name)) return vendorModule(VENDOR[name]!);
  if (typeof name !== 'string' || !MODULE_NAME.test(name)) return text(404, 'not found');
  let path: string;
  let mtimeMs: number;
  try {
    const root = await realpath(opts.srcDir ?? DEFAULT_SRC_DIR);
    path = await realpath(join(root, `${name.slice(0, -3)}.ts`));
    if (dirname(path) !== root) return text(404, 'not found');
    const info = await stat(path);
    if (!info.isFile()) return text(404, 'not found');
    mtimeMs = info.mtimeMs;
  } catch {
    return text(404, 'not found');
  }
  const hit = cache.get(path);
  let code = hit && hit.mtimeMs === mtimeMs ? hit.code : undefined;
  if (code === undefined) {
    try {
      const source = await readFile(path, 'utf8');
      code = (await (await esbuildTransform())(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: 'inline' })).code;
    } catch (e) {
      return text(500, `transpile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    cache.set(path, { mtimeMs, code });
  }
  return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': NO_STORE }, body: code };
}
