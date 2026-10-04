// Pathing on the walk grid: pure and deterministic, no DOM, no randomness.
// Moves are 4-directional (the natural fit for a 2:1 iso grid); ties break the same way every run.

export interface Point {
  gx: number;
  gy: number;
}

/** What the pathfinder needs to know about the room: its size and which tiles can be stood on. */
export interface WalkGrid {
  cols: number;
  rows: number;
  walkable(gx: number, gy: number): boolean;
}

/** A walk longer than this many steps becomes a hop (the renderer eases across instead of walking the whole way). */
export const DEFAULT_HOP_TILES = 24;

export interface WalkPlan {
  /** Tiles from `from` to `to`, both included. */
  path: Point[];
  /** Moves along the path (`path.length - 1`). */
  steps: number;
  /** True when the walk is longer than the hop threshold. */
  hop: boolean;
}

// Fixed neighbour order: the tie-break that makes equal-cost paths come out the same every time.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function inside(grid: WalkGrid, gx: number, gy: number): boolean {
  return Number.isInteger(gx) && Number.isInteger(gy) && gx >= 0 && gy >= 0 && gx < grid.cols && gy < grid.rows;
}

interface Node {
  idx: number;
  g: number;
  f: number;
  order: number;
}

/** Binary min-heap ordered by (f, order): insertion order breaks ties, so the search is deterministic. */
class Heap {
  private items: Node[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(a: Node, b: Node): boolean {
    return a.f < b.f || (a.f === b.f && a.order < b.order);
  }
  push(n: Node): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest 4-directional path from `from` to `to` (A*, Manhattan heuristic), or null when the target is
 * blocked or out of the room, or no route exists. The start tile is always allowed, so a character standing
 * on a tile that was just blocked can still walk off it.
 */
export function findPath(grid: WalkGrid, from: Point, to: Point): Point[] | null {
  if (!inside(grid, from.gx, from.gy) || !inside(grid, to.gx, to.gy)) return null;
  if (!grid.walkable(to.gx, to.gy)) return null;
  const { cols } = grid;
  const start = from.gy * cols + from.gx;
  const goal = to.gy * cols + to.gx;
  if (start === goal) return [{ gx: from.gx, gy: from.gy }];

  const h = (idx: number): number => Math.abs((idx % cols) - to.gx) + Math.abs(Math.floor(idx / cols) - to.gy);
  const best = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  let order = 0;
  open.push({ idx: start, g: 0, f: h(start), order: order++ });

  while (open.size > 0) {
    const cur = open.pop()!;
    if (closed.has(cur.idx)) continue;
    if (cur.idx === goal) {
      const out: Point[] = [];
      for (let i: number | undefined = goal; i !== undefined; i = prev.get(i)) {
        out.push({ gx: i % cols, gy: Math.floor(i / cols) });
        if (i === start) break;
      }
      return out.reverse();
    }
    closed.add(cur.idx);
    const cx = cur.idx % cols;
    const cy = Math.floor(cur.idx / cols);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inside(grid, nx, ny) || !grid.walkable(nx, ny)) continue;
      const ni = ny * cols + nx;
      if (closed.has(ni)) continue;
      const g = cur.g + 1;
      if (g >= (best.get(ni) ?? Infinity)) continue;
      best.set(ni, g);
      prev.set(ni, cur.idx);
      open.push({ idx: ni, g, f: g + h(ni), order: order++ });
    }
  }
  return null;
}

/** Whether a route exists at all. */
export function isReachable(grid: WalkGrid, from: Point, to: Point): boolean {
  return findPath(grid, from, to) !== null;
}

/** A path plus the walk-or-hop decision; null when there is no route. `hopOver` is the longest walk, in steps. */
export function planWalk(grid: WalkGrid, from: Point, to: Point, hopOver: number = DEFAULT_HOP_TILES): WalkPlan | null {
  const path = findPath(grid, from, to);
  if (!path) return null;
  const steps = path.length - 1;
  return { path, steps, hop: steps > hopOver };
}
