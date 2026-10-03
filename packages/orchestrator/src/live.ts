import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOps } from '@cockpit/workspace';
import type { Store } from '@cockpit/persistence';
import type { TaskContext } from './context';

/** What a task's worktree holds right now: the files it changed and a look at the biggest change. */
export interface TaskLive {
  files: { status: string; path: string }[];
  /** One file's unified diff (hunks only), capped; a new file shows as all added lines. */
  preview: { file: string; diff: string } | null;
}

/** Tasks whose worktree is worth reading: work in progress, and approved work not yet integrated. */
const LIVE_STATUSES = new Set(['running', 'needs_input', 'validating', 'in_review', 'changes_requested', 'lease_conflict', 'escalated', 'approved']);
const PREVIEW_CHARS = 6000;
const NEW_FILE_LINES = 80;

/**
 * Reads the worktrees of a run's live tasks every few seconds (git is too slow to run on every
 * snapshot) and keeps the result for the snapshot. Presentation only: a failed read leaves the
 * last good value.
 */
export class LiveWorkspaces {
  private readonly cache = new Map<string, TaskLive>();
  private busy = false;

  constructor(private readonly store: Store, private readonly onChange: () => void) {}

  get(taskId: string): TaskLive | undefined {
    return this.cache.get(taskId);
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let changed = false;
      const seen = new Set<string>();
      for (const run of this.store.runs(10).filter((r) => !['completed', 'rejected', 'failed'].includes(r.status))) {
        for (const t of this.store.tasks(run.id)) {
          if (!LIVE_STATUSES.has(t.status) || !t.worktreePath || !existsSync(t.worktreePath)) continue;
          const base = this.store.taskContext<TaskContext>(t.id).baseCommit;
          if (!base) continue;
          seen.add(t.id);
          const next = await readWorktree(t.worktreePath, base).catch(() => null);
          if (!next) continue;
          if (JSON.stringify(next) !== JSON.stringify(this.cache.get(t.id))) this.cache.set(t.id, next), (changed = true);
        }
      }
      for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id), (changed = true);
      if (changed) this.onChange();
    } finally {
      this.busy = false;
    }
  }
}

/** Exported for tests. */
export async function readWorktree(path: string, base: string): Promise<TaskLive> {
  // The working tree against the task's base: committed and uncommitted work alike.
  const nameStatus = (await gitOps.git(path, ['diff', '--name-status', base], { allowFail: true })).stdout;
  const untracked = (await gitOps.git(path, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).stdout;
  const files: TaskLive['files'] = [];
  for (const line of nameStatus.split('\n')) {
    const [status, ...rest] = line.split('\t');
    if (status && rest.length) files.push({ status: status[0]!, path: rest[rest.length - 1]! });
  }
  for (const p of untracked.split('\n')) if (p.trim()) files.push({ status: 'A', path: p.trim() });

  // Preview the tracked file with the most changed lines; else the first new file.
  const numstat = (await gitOps.git(path, ['diff', '--numstat', base], { allowFail: true })).stdout;
  let best: { file: string; lines: number } | null = null;
  for (const line of numstat.split('\n')) {
    const [a, d, file] = line.split('\t');
    const lines = Number(a) + Number(d);
    if (file && Number.isFinite(lines) && (!best || lines > best.lines)) best = { file, lines };
  }
  let preview: TaskLive['preview'] = null;
  if (best) {
    const d = (await gitOps.git(path, ['diff', base, '--', best.file], { allowFail: true })).stdout;
    const hunks = d.slice(Math.max(0, d.indexOf('@@')));
    preview = { file: best.file, diff: hunks.length > PREVIEW_CHARS ? `${hunks.slice(0, PREVIEW_CHARS)}\n…` : hunks };
  } else {
    const fresh = files.find((f) => f.status === 'A')?.path;
    if (fresh && existsSync(join(path, fresh))) {
      const lines = readFileSync(join(path, fresh), 'utf8').split('\n').slice(0, NEW_FILE_LINES);
      preview = { file: fresh, diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`.slice(0, PREVIEW_CHARS) };
    }
  }
  return { files, preview };
}
