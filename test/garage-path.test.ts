import { describe, expect, it } from 'vitest';
import { DEFAULT_HOP_TILES, findPath, isReachable, planWalk, type Point, type WalkGrid } from '../packages/garage/src/path.js';

/** Build a grid from rows of text: `#` is blocked, anything else walkable. */
function grid(...rows: string[]): WalkGrid {
  return {
    cols: rows[0]!.length,
    rows: rows.length,
    walkable: (gx, gy) => rows[gy]?.[gx] !== undefined && rows[gy]![gx] !== '#',
  };
}
const p = (gx: number, gy: number): Point => ({ gx, gy });

describe('findPath', () => {
  it('walks a straight line, both ends included', () => {
    const path = findPath(grid('.....'), p(0, 0), p(4, 0))!;
    expect(path).toHaveLength(5);
    expect(path[0]).toEqual(p(0, 0));
    expect(path[4]).toEqual(p(4, 0));
  });

  it('returns a one-tile path when already there', () => {
    expect(findPath(grid('...'), p(1, 0), p(1, 0))).toEqual([p(1, 0)]);
  });

  it('goes around a wall', () => {
    const g = grid('..#..', '..#..', '.....');
    const path = findPath(g, p(0, 0), p(4, 0))!;
    expect(path.length - 1).toBe(8);
    for (const t of path) expect(g.walkable(t.gx, t.gy)).toBe(true);
  });

  it('returns null when the route is fully blocked', () => {
    const g = grid('..#..', '..#..', '..#..');
    expect(findPath(g, p(0, 0), p(4, 0))).toBeNull();
    expect(isReachable(g, p(0, 0), p(4, 0))).toBe(false);
  });

  it('becomes reachable once the block is lifted', () => {
    const blocked = new Set(['2,0', '2,1', '2,2']);
    const g: WalkGrid = { cols: 5, rows: 3, walkable: (x, y) => !blocked.has(`${x},${y}`) };
    expect(isReachable(g, p(0, 0), p(4, 2))).toBe(false);
    blocked.delete('2,1');
    expect(isReachable(g, p(0, 0), p(4, 2))).toBe(true);
  });

  it('refuses a blocked or out-of-room target, but may start on a blocked tile', () => {
    const g = grid('.#.', '...');
    expect(findPath(g, p(0, 0), p(1, 0))).toBeNull();
    expect(findPath(g, p(0, 0), p(9, 9))).toBeNull();
    expect(findPath(g, p(-1, 0), p(0, 0))).toBeNull();
    expect(findPath(g, p(1, 0), p(2, 0))).not.toBeNull();
  });

  it('is deterministic and picks the same route among equals', () => {
    const open = grid('.......', '.......', '.......', '.......');
    const a = findPath(open, p(0, 0), p(6, 3));
    const b = findPath(open, p(0, 0), p(6, 3));
    expect(a).toEqual(b);
    expect(a!.length - 1).toBe(9);
  });

  it('does not mutate the grid or the points it is given', () => {
    const from = p(0, 0);
    const to = p(2, 0);
    findPath(grid('...'), from, to);
    expect(from).toEqual(p(0, 0));
    expect(to).toEqual(p(2, 0));
  });
});

describe('planWalk', () => {
  const row = (n: number): WalkGrid => grid('.'.repeat(n));

  it('walks when the path is at the threshold and hops when it is longer', () => {
    expect(planWalk(row(6), p(0, 0), p(5, 0), 5)).toMatchObject({ steps: 5, hop: false });
    expect(planWalk(row(7), p(0, 0), p(6, 0), 5)).toMatchObject({ steps: 6, hop: true });
  });

  it('uses the default threshold', () => {
    const n = DEFAULT_HOP_TILES + 2;
    expect(planWalk(row(n), p(0, 0), p(DEFAULT_HOP_TILES, 0))!.hop).toBe(false);
    expect(planWalk(row(n), p(0, 0), p(DEFAULT_HOP_TILES + 1, 0))!.hop).toBe(true);
  });

  it('is null when there is no route', () => {
    expect(planWalk(grid('.#.'), p(0, 0), p(2, 0))).toBeNull();
  });
});

describe('no DOM', () => {
  it('path.ts imports nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../packages/garage/src/path.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\b(document|window|HTMLElement|canvas)\b/i);
  });
});
