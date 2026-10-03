import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Repository, Task } from '@cockpit/core';
import { addWorktree, removeWorktree, revParse } from './git';

export function slug(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, max)
      .replace(/-$/, '') || 'task'
  );
}

export function shortRunId(runId: string): string {
  return runId.replace(/^run_/, '').slice(0, 8);
}

/**
 * Creates isolated git worktrees for tasks and for per-repository integration.
 * Workers never touch the human's working tree: everything happens under
 * <dataDir>/worktrees/<run>/<repo>/<TASK-key>.
 */
export class WorkspaceManager {
  constructor(private readonly root: string) {}

  taskBranch(runId: string, task: Pick<Task, 'key' | 'title'>): string {
    return `agent/${shortRunId(runId)}/${task.key}-${slug(task.title, 24)}`;
  }

  integrationBranch(runId: string): string {
    return `agent/${shortRunId(runId)}/integration`;
  }

  taskPath(runId: string, repo: Repository, taskKey: string): string {
    return join(this.root, shortRunId(runId), slug(repo.name, 40), taskKey);
  }

  integrationPath(runId: string, repo: Repository): string {
    return join(this.root, shortRunId(runId), slug(repo.name, 40), '_integration');
  }

  /** Create (or reuse after restart) a worktree on `branch` starting from `base`. */
  async ensure(repo: Repository, path: string, branch: string, base: string): Promise<{ path: string; baseCommit: string; created: boolean }> {
    const baseCommit = await revParse(repo.path, base);
    if (existsSync(join(path, '.git'))) return { path, baseCommit, created: false };
    mkdirSync(join(path, '..'), { recursive: true });
    await addWorktree(repo.path, path, branch, baseCommit);
    return { path, baseCommit, created: true };
  }

  async remove(repo: Repository, path: string): Promise<void> {
    await removeWorktree(repo.path, path);
  }
}
