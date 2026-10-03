import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const isWindows = process.platform === 'win32';

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run through the platform shell (cmd.exe / sh). Only for configured commands like test runners. */
  shell?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Cap captured output (bytes, per stream) to keep memory bounded. */
  maxCapture?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * Windows npm installs expose CLIs as .cmd shims, which cannot be spawned without a
 * shell (and shell quoting of JSON arguments is unsafe). Resolve the shim to the
 * underlying `node <script>.js` invocation instead.
 */
export function resolveLaunch(command: string): { command: string; prefixArgs: string[] } {
  if (!isWindows || !/\.(cmd|bat)$/i.test(command)) return { command, prefixArgs: [] };
  try {
    const text = readFileSync(command, 'utf8');
    const m = /"%(?:dp0|~dp0)%\\?([^"]+\.(?:js|cjs|mjs))"/i.exec(text);
    if (m) {
      const script = join(dirname(command), m[1]!.replace(/^\\/, ''));
      if (existsSync(script)) return { command: process.execPath, prefixArgs: [script] };
    }
  } catch {
    /* fall through */
  }
  throw new Error(`${command} is a batch shim that cannot be launched safely; point the config at the real executable`);
}

/** Cross-platform process execution with line streaming, timeouts and tree kill. */
export function spawnProcess(rawCommand: string, rawArgs: string[], opts: SpawnOptions): Promise<SpawnResult> {
  const started = Date.now();
  const launch = opts.shell ? { command: rawCommand, prefixArgs: [] } : resolveLaunch(rawCommand);
  const command = launch.command;
  const args = [...launch.prefixArgs, ...rawArgs];
  const max = opts.maxCapture ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: opts.shell ?? false,
        windowsHide: true,
        // POSIX: own process group so the whole tree can be killed.
        detached: !isWindows,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const lineSplitter = (cb?: (l: string) => void) => {
      let buf = '';
      return {
        push(chunk: string) {
          if (!cb) return;
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n')) !== -1) {
            cb(buf.slice(0, i).replace(/\r$/, ''));
            buf = buf.slice(i + 1);
          }
        },
        end() {
          if (cb && buf) cb(buf.replace(/\r$/, ''));
          buf = '';
        },
      };
    };
    const outLines = lineSplitter(opts.onStdoutLine);
    const errLines = lineSplitter(opts.onStderrLine);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
      outLines.push(d);
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < max) stderr += d;
      errLines.push(d);
    });
    child.stdin!.on('error', () => {});
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    else child.stdin!.end();

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      outLines.end();
      errLines.end();
      resolve({ exitCode: code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    });
  });
}

/** Kill a process and all of its descendants. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

/** Run a configured shell command (e.g. a test command) in a directory. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<SpawnResult> {
  return spawnProcess(command, [], { cwd, shell: true, timeoutMs, signal, env: { ...process.env, CI: '1' } });
}

/** Locate an executable on PATH (honouring PATHEXT on Windows), then in extra candidate paths. */
export function findExecutable(name: string, candidates: string[] = []): string | null {
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWindows ? ['', ...exts] : ['']) {
      const p = join(dir, name + ext);
      if (isFile(p) && (!isWindows || ext !== '' || /\.(exe|cmd|bat)$/i.test(name))) return p;
    }
  }
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

/** Newest file matching <root>/<any subdir>/<file>: used for app-bundled CLIs with hashed folders. */
export function newestInSubdirs(root: string, file: string): string | null {
  if (!existsSync(root)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, file);
    if (isFile(p)) {
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
  }
  return best?.path ?? null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Forward-slash, repo-relative path for comparisons and leases. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
