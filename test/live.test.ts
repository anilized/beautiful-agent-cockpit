import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorktree } from '../packages/orchestrator/src/live';
import { makeRepo, tempDir } from './helpers';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('live worktree read', () => {
  it('lists changed and new files against the base and previews the biggest change', async () => {
    const repo = makeRepo(tempDir('live'), 'svc');
    writeFileSync(join(repo, 'src', 'a.js'), 'one\n');
    writeFileSync(join(repo, 'src', 'b.js'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base files');
    const base = git(repo, 'rev-parse', 'HEAD');
    // uncommitted work: a small edit, a large edit and a new file
    writeFileSync(join(repo, 'src', 'a.js'), 'one\ntwo\n');
    writeFileSync(join(repo, 'src', 'b.js'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    writeFileSync(join(repo, 'src', 'c.js'), 'fresh\n');

    const live = await readWorktree(repo, base);
    expect(live.files).toEqual(expect.arrayContaining([
      { status: 'M', path: 'src/a.js' },
      { status: 'M', path: 'src/b.js' },
      { status: 'A', path: 'src/c.js' },
    ]));
    expect(live.preview?.file).toBe('src/b.js');
    expect(live.preview?.diff.startsWith('@@')).toBe(true);
    expect(live.preview?.diff).toContain('+line 29');
  });

  it('previews a new file as added lines when nothing tracked changed', async () => {
    const repo = makeRepo(tempDir('live-new'), 'svc');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'new.js'), 'export const a = 1\n');
    const live = await readWorktree(repo, base);
    expect(live.files).toEqual([{ status: 'A', path: 'src/new.js' }]);
    expect(live.preview).toEqual({ file: 'src/new.js', diff: expect.stringContaining('+export const a = 1') });
  });
});
