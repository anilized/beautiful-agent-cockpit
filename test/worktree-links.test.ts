import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitOps } from '@cockpit/workspace';
import { makeRepo, tempDir } from './helpers';

// An agent once linked its worktree's node_modules to the main checkout's (a Windows junction);
// removing the worktree deleted through the link and emptied the main checkout. Never again.
describe('removing a worktree', () => {
  it('removes links inside it as links and leaves what they point at alone', async () => {
    const root = tempDir('wt-links');
    const repo = makeRepo(root, 'svc');
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'pkg'), { recursive: true });
    writeFileSync(join(outside, 'pkg', 'precious.txt'), 'keep me');
    writeFileSync(join(outside, 'file.txt'), 'keep me too');

    const wt = join(root, 'wt');
    await gitOps.addWorktree(repo, wt, 'agent/test', 'main');
    // a directory junction at the root and one nested, and a file link
    symlinkSync(outside, join(wt, 'node_modules'), 'junction');
    mkdirSync(join(wt, 'deep', 'er'), { recursive: true });
    symlinkSync(join(outside, 'pkg'), join(wt, 'deep', 'er', 'linked'), 'junction');
    try {
      symlinkSync(join(outside, 'file.txt'), join(wt, 'alias.txt'), 'file');
    } catch {
      /* file symlinks need a privilege on some Windows setups; the junctions are the case that matters */
    }

    await gitOps.removeWorktree(repo, wt);

    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(outside, 'pkg', 'precious.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('keep me too');
  });

  it('unlinkLinks finds nothing to do in a tree without links', () => {
    const dir = tempDir('wt-plain');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'x.txt'), 'x');
    expect(gitOps.unlinkLinks(dir)).toEqual([]);
    expect(existsSync(join(dir, 'a', 'b', 'x.txt'))).toBe(true);
  });
});
