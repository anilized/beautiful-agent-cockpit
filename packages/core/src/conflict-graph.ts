import type { Scope } from './domain';
import { scopePatterns, scopedPatternsOverlap } from './scope';

export interface ConflictNode {
  id: string;
  repoId: string;
  scope: Scope;
}

export interface Conflict {
  a: string;
  b: string;
  reason: string;
}

/**
 * Undirected conflict graph: an edge means two tasks predict overlapping ownership
 * (same repository and overlapping files/modules, or the same shared resource in any
 * repository). Conflicting tasks must not run concurrently.
 */
export class ConflictGraph {
  private readonly edges = new Map<string, Map<string, string>>();

  constructor(nodes: ConflictNode[]) {
    for (const n of nodes) this.edges.set(n.id, new Map());
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const reason = conflictReason(nodes[i]!, nodes[j]!);
        if (reason) {
          this.edges.get(nodes[i]!.id)!.set(nodes[j]!.id, reason);
          this.edges.get(nodes[j]!.id)!.set(nodes[i]!.id, reason);
        }
      }
    }
  }

  conflictsOf(id: string): string[] {
    return [...(this.edges.get(id)?.keys() ?? [])];
  }

  conflicts(): Conflict[] {
    const out: Conflict[] = [];
    for (const [a, m] of this.edges) for (const [b, reason] of m) if (a < b) out.push({ a, b, reason });
    return out;
  }

  /** True if `id` conflicts with none of `active`. */
  compatibleWith(id: string, active: Iterable<string>): boolean {
    const mine = this.edges.get(id);
    if (!mine) return true;
    for (const a of active) if (mine.has(a)) return false;
    return true;
  }
}

export function conflictReason(a: ConflictNode, b: ConflictNode): string | null {
  for (const pa of scopePatterns(a.scope)) {
    for (const pb of scopePatterns(b.scope)) {
      if (pa.kind !== 'resource' && a.repoId !== b.repoId) continue;
      if (scopedPatternsOverlap(pa, pb)) return `${pa.kind} ${pa.pattern} overlaps ${pb.pattern}`;
    }
  }
  return null;
}
