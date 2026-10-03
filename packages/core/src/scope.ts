import type { LeaseKind, Scope } from './domain';

/**
 * Path patterns used for leases: exact paths ("src/a.ts"), directory prefixes
 * ("src/auth/" or "src/auth/**") and simple globs ("src/*.ts"). Overlap is decided
 * conservatively on the literal prefix before the first wildcard: two patterns
 * overlap unless their literal parts provably diverge.
 */
export function normalizePattern(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (p.endsWith('/')) p += '**';
  return p;
}

function literalPrefix(pattern: string): { prefix: string; wildcard: boolean } {
  const i = pattern.search(/[*?[{]/);
  if (i === -1) return { prefix: pattern, wildcard: false };
  return { prefix: pattern.slice(0, i), wildcard: true };
}

export function patternsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(normalizePattern(a).toLowerCase());
  const pb = literalPrefix(normalizePattern(b).toLowerCase());
  if (!pa.wildcard && !pb.wildcard) return pa.prefix === pb.prefix;
  if (pa.wildcard && pb.wildcard) return pa.prefix.startsWith(pb.prefix) || pb.prefix.startsWith(pa.prefix);
  const [exact, glob] = pa.wildcard ? [pb.prefix, pa] : [pa.prefix, pb];
  return exact.startsWith(glob.prefix) && matchGlob(normalizePattern(pa.wildcard ? a : b).toLowerCase(), exact);
}

/** Minimal glob matcher: `**` crosses directories, `*` and `?` do not. */
export function matchGlob(pattern: string, path: string): boolean {
  let re = '';
  const p = normalizePattern(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(path.replace(/\\/g, '/'));
}

export interface ScopedPattern {
  kind: LeaseKind;
  pattern: string;
}

/** Flatten a predicted scope into lease patterns. Modules are treated as directory prefixes. */
export function scopePatterns(scope: Scope): ScopedPattern[] {
  return [
    ...scope.files.map((pattern) => ({ kind: 'file' as const, pattern: normalizePattern(pattern) })),
    ...scope.modules.map((m) => ({ kind: 'module' as const, pattern: normalizePattern(/[*?]/.test(m) ? m : `${m.replace(/\/+$/, '')}/**`) })),
    ...scope.resources.map((r) => ({ kind: 'resource' as const, pattern: r.trim().toLowerCase() })),
  ];
}

export function scopedPatternsOverlap(a: ScopedPattern, b: ScopedPattern): boolean {
  if ((a.kind === 'resource') !== (b.kind === 'resource')) return false;
  if (a.kind === 'resource') return a.pattern === b.pattern;
  return patternsOverlap(a.pattern, b.pattern);
}
