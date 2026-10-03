import {
  matchGlob,
  normalizePattern,
  scopePatterns,
  scopedPatternsOverlap,
  type FileLease,
  type Task,
} from '@cockpit/core';
import type { Store } from '@cockpit/persistence';

export interface LeaseConflict {
  pattern: string;
  heldBy: string;
  leaseId: string;
}

/**
 * Lightweight file/module/resource leases. Predicted scope is leased before a task
 * starts; files touched outside it are checked again on submission. A file owned by
 * another active task is a conflict that Codex must resolve.
 */
export class LeaseManager {
  constructor(private readonly store: Store) {}

  private conflictsFor(task: Pick<Task, 'id' | 'repoId'>, wanted: { kind: FileLease['kind']; pattern: string }[]): LeaseConflict[] {
    const out: LeaseConflict[] = [];
    for (const lease of this.store.activeLeases()) {
      if (lease.taskId === task.id) continue;
      if (lease.kind !== 'resource' && lease.repoId !== task.repoId) continue;
      for (const w of wanted) {
        if (scopedPatternsOverlap(w, { kind: lease.kind, pattern: lease.pattern })) {
          out.push({ pattern: w.pattern, heldBy: lease.taskId, leaseId: lease.id });
        }
      }
    }
    return out;
  }

  /** Atomically acquire the predicted scope of a task, or nothing. */
  acquireScope(task: Task): { ok: true; leases: FileLease[] } | { ok: false; conflicts: LeaseConflict[] } {
    return this.store.tx(() => {
      const wanted = scopePatterns(task.scope);
      const conflicts = this.conflictsFor(task, wanted);
      if (conflicts.length) return { ok: false as const, conflicts };
      const held = new Set(this.store.taskLeases(task.id).map((l) => `${l.kind}:${l.pattern}`));
      const leases = wanted
        .filter((w) => !held.has(`${w.kind}:${w.pattern}`))
        .map((w) => this.store.insertLease({ runId: task.runId, taskId: task.id, repoId: task.repoId, pattern: w.pattern, kind: w.kind }));
      return { ok: true as const, leases };
    });
  }

  /**
   * Check files a task actually touched. Files outside its leases are acquired if free;
   * files held by another active task are returned as conflicts.
   */
  claimFiles(task: Task, files: string[]): { acquired: string[]; conflicts: LeaseConflict[] } {
    return this.store.tx(() => {
      const mine = this.store.taskLeases(task.id).filter((l) => l.kind !== 'resource');
      const uncovered = files.map(normalizePattern).filter((f) => !mine.some((l) => matchGlob(l.pattern, f) || l.pattern.toLowerCase() === f.toLowerCase()));
      const conflicts = this.conflictsFor(task, uncovered.map((pattern) => ({ kind: 'file' as const, pattern })));
      const blocked = new Set(conflicts.map((c) => c.pattern));
      const acquired = uncovered.filter((f) => !blocked.has(f));
      for (const pattern of acquired) this.store.insertLease({ runId: task.runId, taskId: task.id, repoId: task.repoId, pattern, kind: 'file' });
      return { acquired, conflicts };
    });
  }

  transfer(conflicts: LeaseConflict[], toTaskId: string): void {
    this.store.tx(() => {
      for (const c of conflicts) this.store.transferLease(c.leaseId, toTaskId);
    });
  }

  release(taskId: string): number {
    return this.store.releaseLeases(taskId);
  }
}
