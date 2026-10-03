import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One rate-limit window of a subscription: how much of it is used, and when it resets. */
export interface LimitWindow {
  /** `5h`, `7d`, … from the window's length. */
  name: string;
  usedPercent: number;
  resetsAt: string | null;
}
export interface ProviderLimits {
  windows: LimitWindow[];
  /** When the figures were read. */
  at: string;
}
export type Limits = Partial<Record<'claude' | 'codex', ProviderLimits>>;

const windowName = (minutes: number | null, fallback: string) =>
  minutes === null ? fallback : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
const iso = (unixSeconds: unknown) => (typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000).toISOString() : null);

/** Claude Code's `rate_limit_event` (stream-json): utilization 0..1 per unified window. */
export function claudeLimits(event: Record<string, any>, at = new Date().toISOString()): ProviderLimits | null {
  const w = event?.rate_limit_info?.unifiedWindows;
  if (!w || typeof w !== 'object') return null;
  const windows = Object.entries(w as Record<string, { utilization?: number; resetsAt?: number }>)
    .filter(([, v]) => typeof v?.utilization === 'number')
    .map(([k, v]) => ({ name: k === 'five_hour' ? '5h' : k === 'seven_day' ? '7d' : k.replace(/_/g, ' '), usedPercent: Math.round(v.utilization! * 1000) / 10, resetsAt: iso(v.resetsAt) }));
  return windows.length ? { windows, at } : null;
}

/** Codex's `rate_limits` (session logs): used_percent per primary / secondary window. */
export function codexLimits(rl: Record<string, any>, at: string): ProviderLimits | null {
  const windows = (['primary', 'secondary'] as const)
    .map((k) => rl?.[k])
    .filter((v) => v && typeof v.used_percent === 'number')
    .map((v: any, i) => ({ name: windowName(typeof v.window_minutes === 'number' ? v.window_minutes : null, i ? 'week' : 'session'), usedPercent: v.used_percent, resetsAt: iso(v.resets_at) }));
  return windows.length ? { windows, at } : null;
}

/** The newest Codex session log (sessions/YYYY/MM/DD/rollout-*.jsonl) and the last rate limits in it. */
export function readCodexLimits(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): ProviderLimits | null {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  const newest = (dir: string) => readdirSync(dir).filter((n) => !n.startsWith('.')).sort().reverse();
  // Walk the newest day first; a day's files sorted by modification time.
  for (const y of newest(root)) for (const m of newest(join(root, y))) for (const d of newest(join(root, y, m))) {
    const dir = join(root, y, m, d);
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f, t } of files) {
      const found = lastRateLimits(join(dir, f));
      if (found) return codexLimits(found, new Date(t).toISOString());
    }
  }
  return null;
}

/** Reads the file's tail and returns the last `rate_limits` object in it. */
function lastRateLimits(file: string): Record<string, any> | null {
  const size = statSync(file).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(line);
      const rl = o?.payload?.rate_limits ?? o?.rate_limits ?? o?.msg?.rate_limits;
      if (rl) return rl;
    } catch {
      /* a line cut by the tail window */
    }
  }
  return null;
}

/** The latest limits per provider, kept in <dataDir>/limits.json so a restart still shows them. */
export class LimitsStore {
  private current: Limits;
  constructor(private readonly file: string) {
    try {
      this.current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Limits) : {};
    } catch {
      this.current = {};
    }
  }
  get(): Limits {
    return this.current;
  }
  set(provider: 'claude' | 'codex', value: ProviderLimits | null): boolean {
    if (!value || JSON.stringify(value.windows) === JSON.stringify(this.current[provider]?.windows)) return false;
    this.current = { ...this.current, [provider]: value };
    try {
      writeFileSync(this.file, JSON.stringify(this.current, null, 1));
    } catch {
      /* presentation only */
    }
    return true;
  }
}
