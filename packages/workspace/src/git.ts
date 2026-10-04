import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess } from './platform';

export class GitError extends Error {
  constructor(args: string[], public readonly stderr: string, public readonly exitCode: number | null) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim().slice(0, 2000)}`);
    this.name = 'GitError';
  }
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'agent-cockpit',
  GIT_AUTHOR_EMAIL: 'agent-cockpit@localhost',
  GIT_COMMITTER_NAME: 'agent-cockpit',
  GIT_COMMITTER_EMAIL: 'agent-cockpit@localhost',
};

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const res = await spawnProcess('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, timeoutMs: 5 * 60_000 });
  if (res.exitCode !== 0 && !opts.allowFail) throw new GitError(args, res.stderr || res.stdout, res.exitCode);
  return { stdout: res.stdout, stderr: res.stderr, code: res.exitCode };
}

export async function isGitRepo(path: string): Promise<boolean> {
  const r = await git(path, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', ref])).stdout.trim();
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).stdout.trim() === '';
}

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', path, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

/**
 * Removes a worktree. Every symbolic link and junction inside it goes first, as a link: on Windows
 * a forced `git worktree remove` deletes *through* a junction, emptying whatever it points at (an
 * agent that linked `node_modules` to the main checkout once wiped that checkout's packages). If a
 * link cannot be removed, the worktree stays on disk rather than risk it.
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  const left = unlinkLinks(path);
  if (left.length) throw new Error(`kept the worktree ${path}: could not remove the link(s) ${left.join(', ')} safely`);
  await git(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

/** Removes every symbolic link and junction under `dir` without following any; returns those it could not remove. */
export function unlinkLinks(dir: string): string[] {
  const left: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return left; // gone, or not a directory
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // Node reports a Windows junction as a symbolic link; unlink removes the link, never its target.
      try {
        unlinkSync(p);
      } catch {
        try {
          rmdirSync(p);
        } catch {
          left.push(p);
        }
      }
    } else if (st.isDirectory()) {
      left.push(...unlinkLinks(p));
    }
  }
  return left;
}

/** Stage everything and commit if there is anything to commit. Returns the new HEAD or null. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  if ((await git(cwd, ['diff', '--cached', '--quiet'], { allowFail: true })).code === 0) return null;
  await git(cwd, ['commit', '-q', '--no-verify', '-m', message]);
  return revParse(cwd, 'HEAD');
}

/** Files changed between `base` and the working tree (committed + uncommitted + untracked). */
export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const committed = (await git(cwd, ['diff', '--name-only', `${base}...HEAD`])).stdout;
  const status = (await git(cwd, ['status', '--porcelain', '-uall'])).stdout;
  const files = new Set<string>();
  for (const l of committed.split('\n')) if (l.trim()) files.add(l.trim());
  for (const l of status.split('\n')) {
    if (!l.trim()) continue;
    const path = l.slice(3).trim();
    const renamed = path.split(' -> ');
    files.add((renamed[1] ?? renamed[0]!).replace(/^"|"$/g, ''));
  }
  return [...files].sort();
}

export async function diffStat(cwd: string, base: string): Promise<string> {
  return (await git(cwd, ['diff', '--stat', `${base}...HEAD`])).stdout;
}

export async function diff(cwd: string, base: string, maxBytes = 200_000): Promise<string> {
  const d = (await git(cwd, ['diff', `${base}...HEAD`])).stdout;
  return d.length > maxBytes ? `${d.slice(0, maxBytes)}\n... [diff truncated at ${maxBytes} bytes]` : d;
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
}

export async function merge(cwd: string, branch: string, message: string): Promise<MergeResult> {
  const r = await git(cwd, ['merge', '--no-ff', '--no-edit', '-m', message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, conflicts: [] };
  const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  if (!conflicts.length) throw new GitError(['merge', branch], r.stderr || r.stdout, r.code);
  return { ok: false, conflicts };
}

export async function unresolvedConflicts(cwd: string): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
}

export async function abortMerge(cwd: string): Promise<void> {
  await git(cwd, ['merge', '--abort'], { allowFail: true });
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })).code === 0;
}

export async function deleteBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['branch', '-D', branch], { allowFail: true });
}
