import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_BAYS, TILE_H, TILE_W, buildLayout, layoutFromState, padBays, type Layout, type LayoutSpec } from '../packages/garage/src/layout.js';
import type { Character, GarageState, StationId } from '../packages/garage/src/model.js';
import { findPath } from '../packages/garage/src/path.js';

const spec = (over: Partial<LayoutSpec> = {}): Partial<LayoutSpec> => ({
  council: ['sup-1', 'sup-2'],
  leads: [{ id: 'lead-1' }, { id: 'lead-2' }],
  bays: [{ id: 'A', task: 'TASK-101', repo: 'agent-cockpit' }],
  repos: ['agent-cockpit', 'docs'],
  ...over,
});

/** Every station can be reached on foot from the entrance (and back). */
function expectAllReachable(layout: Layout): void {
  const door = layout.resolve('entrance')!.grid;
  expect(layout.walkable(door.gx, door.gy)).toBe(true);
  for (const id of layout.ids()) {
    const st = layout.resolve(id)!;
    expect(layout.walkable(st.grid.gx, st.grid.gy), `${id} stands on a walkable tile`).toBe(true);
    expect(findPath(layout, door, st.grid), `entrance -> ${id}`).not.toBeNull();
    expect(findPath(layout, st.grid, door), `${id} -> entrance`).not.toBeNull();
  }
}

describe('buildLayout zones and registry', () => {
  it('places every zone and resolves each station id', () => {
    const l = buildLayout(spec());
    const want: StationId[] = ['loft:sup-1', 'loft:sup-2', 'desk:lead-1', 'desk:lead-2', 'outbox', 'bay:A', 'crate:agent-cockpit', 'crate:docs', 'lab', 'bench', 'terminal', 'entrance'];
    for (const id of want) expect(l.resolve(id), id).not.toBeNull();
    expect(l.resolve('crate:nope')).toBeNull();
    expect(l.regions.map((r) => r.id)).toEqual(expect.arrayContaining(['board', 'wall', 'loft']));
    expect(l.boardColumns).toEqual(['TODO', 'DOING', 'REVIEW', 'DONE']);
    expectAllReachable(l);
  });

  it('raises the loft, marks the chair with a star, and makes the head lead biggest with the outbox', () => {
    const l = buildLayout(spec({ chair: 'sup-2' }));
    expect(l.resolve('loft:sup-1')!.elevation).toBeGreaterThan(0);
    expect(l.resolve('desk:lead-1')!.elevation).toBe(0);
    expect(l.resolve('loft:sup-2')!.label).toBe('★ sup-2');
    expect(l.resolve('loft:sup-1')!.label).toBe('sup-1');
    const head = l.resolve('desk:lead-1')!;
    const other = l.resolve('desk:lead-2')!;
    expect(head.footprint.length).toBeGreaterThan(other.footprint.length);
    expect(Math.abs(l.resolve('outbox')!.grid.gx - head.grid.gx)).toBeLessThanOrEqual(5);
    expect(l.resolve('outbox')!.grid.gy).toBe(head.grid.gy);
    // the loft is behind (smaller gy than) the desks, which are behind the bays
    expect(l.resolve('loft:sup-1')!.grid.gy).toBeLessThan(head.grid.gy);
    expect(head.grid.gy).toBeLessThan(l.resolve('bay:A')!.grid.gy);
  });

  it('defaults the chair to the first council seat and honours an explicit head lead', () => {
    const l = buildLayout(spec({ head: 'lead-2' }));
    expect(l.resolve('loft:sup-1')!.label).toBe('★ sup-1');
    expect(l.resolve('desk:lead-2')!.meta.head).toBe(true);
    expect(l.resolve('desk:lead-1')!.meta.head).toBe(false);
  });

  it('has at least 6 bays, labelled BAY A — TASK-101 — repo', () => {
    const l = buildLayout(spec());
    const bays = l.ids().filter((id) => id.startsWith('bay:'));
    expect(bays.length).toBeGreaterThanOrEqual(MIN_BAYS);
    expect(l.resolve('bay:A')!.label).toBe('BAY A — TASK-101 — agent-cockpit');
    expect(l.resolve('bay:B')!.label).toBe('BAY B');
    expect(buildLayout().ids().filter((id) => id.startsWith('bay:'))).toHaveLength(MIN_BAYS);
  });

  it('keeps more than 6 bays when more are in use, without placeholders colliding', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: String.fromCharCode(65 + i) }));
    const l = buildLayout(spec({ bays: many }));
    expect(l.ids().filter((id) => id.startsWith('bay:'))).toHaveLength(9);
    expect(padBays([{ id: 'C' }]).map((b) => b.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expectAllReachable(l);
  });

  it('does not collide tiles: stations are unique and not on furniture', () => {
    const l = buildLayout(spec({ bays: Array.from({ length: 8 }, (_, i) => ({ id: String.fromCharCode(65 + i) })) }));
    const seen = new Set<string>();
    for (const id of l.ids()) {
      const k = `${l.resolve(id)!.grid.gx},${l.resolve(id)!.grid.gy}`;
      expect(seen.has(k), `${id} shares a tile`).toBe(false);
      seen.add(k);
    }
    for (const id of l.ids()) for (const t of l.resolve(id)!.footprint) expect(l.walkable(t.gx, t.gy)).toBe(false);
  });
});

describe('layout scales with data', () => {
  it('grows with leads, repos and council, staying reachable', () => {
    const small = buildLayout(spec());
    const big = buildLayout(
      spec({
        council: Array.from({ length: 12 }, (_, i) => `sup-${i + 1}`),
        leads: Array.from({ length: 6 }, (_, i) => ({ id: `lead-${i + 1}` })),
        repos: Array.from({ length: 12 }, (_, i) => `repo-${i}`),
      }),
    );
    expect(big.cols).toBeGreaterThan(small.cols);
    expect(big.rows).toBeGreaterThan(small.rows);
    expect(big.ids().length).toBeGreaterThan(small.ids().length);
    expectAllReachable(big);
  });

  it('adds rows for more leads and repos without hard-coded positions', () => {
    const base = buildLayout(spec({ leads: [{ id: 'lead-1' }], repos: ['r0'] }));
    const more = buildLayout(spec({ leads: Array.from({ length: 8 }, (_, i) => ({ id: `lead-${i + 1}` })), repos: Array.from({ length: 14 }, (_, i) => `r${i}`) }));
    expect(more.rows).toBeGreaterThan(base.rows);
    expectAllReachable(more);
  });

  it('is deterministic: the same spec gives the same room', () => {
    const a = buildLayout(spec());
    const b = buildLayout(spec());
    expect(a.ids()).toEqual(b.ids());
    for (const id of a.ids()) expect(a.resolve(id)).toEqual(b.resolve(id));
  });

  it('fits 1280x720 at an integer zoom of at least 1', () => {
    const l = buildLayout(spec());
    expect(l.width).toBeLessThanOrEqual(1280);
    expect(l.height).toBeLessThanOrEqual(720);
    expect(Number.isInteger(l.fitZoom(1280, 720))).toBe(true);
    expect(l.fitZoom(1280, 720)).toBeGreaterThanOrEqual(1);
    expect(l.fitZoom(10, 10)).toBe(1);
  });
});

describe('entrance queue', () => {
  it('queues workers beyond the bays at the entrance', () => {
    const l = buildLayout(spec({ waiting: 20 }));
    const door = l.resolve('entrance')!.grid;
    expect(l.queueSlots).toBeGreaterThanOrEqual(20);
    const seen = new Set<string>();
    for (let i = 0; i < l.queueSlots; i++) {
      const s = l.queueSlot(i);
      expect(l.walkable(s.gx, s.gy), `slot ${i}`).toBe(true);
      expect(s.gy).toBeGreaterThan(door.gy);
      expect(findPath(l, door, s)).not.toBeNull();
      seen.add(`${s.gx},${s.gy}`);
    }
    expect(seen.size).toBe(l.queueSlots);
  });

  it('has a few slots even with no workers', () => {
    const l = buildLayout(spec());
    expect(l.queueSlots).toBeGreaterThanOrEqual(6);
  });
});

describe('extensions', () => {
  it('registers beside an existing station without touching layout internals', () => {
    const l = buildLayout(spec());
    const lab = l.resolve('lab')!;
    const placed = l.register({ id: 'ext:pet-1', kind: 'pet', label: 'Rex', near: { station: 'lab', dx: 1, dy: 1 }, data: { species: 'dog' } });
    expect(l.resolve('ext:pet-1')).toBe(placed);
    expect(placed.kind).toBe('ext');
    expect(placed.meta).toMatchObject({ extKind: 'pet', species: 'dog' });
    expect(Math.abs(placed.grid.gx - lab.grid.gx)).toBeLessThanOrEqual(2);
    expect(l.ids()).toContain('ext:pet-1');
    expectAllReachable(l);
  });

  it('slides a blocked spot to a reachable tile, and takes extensions from the spec', () => {
    const l = buildLayout(spec({ extensions: [{ id: 'ext:cable', kind: 'cable', label: 'cable', near: { station: 'bay:A', dx: 0, dy: -1 } }] }));
    const c = l.resolve('ext:cable')!;
    expect(l.walkable(c.grid.gx, c.grid.gy)).toBe(true);
    expectAllReachable(l);
  });

  it('re-registering replaces rather than duplicates; bad ids and anchors throw', () => {
    const l = buildLayout(spec());
    l.register({ id: 'ext:x', kind: 'prop', label: 'one' });
    l.register({ id: 'ext:x', kind: 'prop', label: 'two', near: { station: 'terminal', dx: 0, dy: 1 } });
    expect(l.ids().filter((i) => i === 'ext:x')).toHaveLength(1);
    expect(l.resolve('ext:x')!.label).toBe('two');
    expect(() => l.register({ id: 'ext:y', kind: 'prop', label: 'y', near: { station: 'lab:none' as StationId, dx: 0, dy: 0 } })).toThrow();
    expect(() => l.register({ id: 'nope' as `ext:${string}`, kind: 'prop', label: 'z' })).toThrow();
  });
});

describe('projection', () => {
  it('is 2:1 and toGrid inverts toScreen', () => {
    const l = buildLayout(spec());
    expect(TILE_W / TILE_H).toBe(2);
    for (const [gx, gy] of [[3, 4], [10, 12], [0, 2]] as const) {
      const s = l.toScreen(gx, gy);
      expect(l.toGrid(s.x, s.y)).toEqual({ gx, gy });
    }
    const a = l.toScreen(5, 5);
    const b = l.toScreen(6, 5);
    expect(b.x - a.x).toBe(TILE_W / 2);
    expect(b.y - a.y).toBe(TILE_H / 2);
    for (const id of l.ids()) {
      const { screen } = l.resolve(id)!;
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(l.width);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeLessThanOrEqual(l.height);
    }
  });
});

function char(over: Partial<Character> & Pick<Character, 'id' | 'kind' | 'home'>): Character {
  return { label: over.id, agentId: null, seat: null, persona: null, lead: null, station: over.home, task: null, flags: { failed: false, blocked: false, awaitingHuman: false, review: false }, state: 'idle', ...over };
}

describe('layoutFromState', () => {
  it('resolves every station id a state mentions', () => {
    const characters: Record<string, Character> = {};
    for (const c of [
      char({ id: 'sup-1', kind: 'council', seat: 'sup-1', home: 'loft:sup-1' }),
      char({ id: 'sup-2', kind: 'council', seat: 'sup-2', home: 'loft:sup-2' }),
      char({ id: 'lead-1', kind: 'lead', seat: 'lead-1', lead: 'lead-1', home: 'desk:lead-1' }),
      char({ id: 'lead-2', kind: 'lead', seat: 'lead-2', lead: 'lead-2', home: 'desk:lead-2', station: 'loft:sup-1' }),
      char({ id: 'backend-dev', kind: 'worker', persona: 'backend-dev', lead: 'lead-1', home: 'entrance', station: 'bay:B', task: 'TASK-101' }),
      char({ id: 'fe', kind: 'worker', persona: 'fe', lead: 'lead-2', home: 'entrance', station: 'crate:ui' }),
    ])
      characters[c.id] = c;
    const state = {
      characters,
      stations: { 'bay:G': { id: 'bay:G', kind: 'bay', state: 'idle' } },
      bayOf: { 'TASK-101': 'B', 'TASK-102': 'H' },
      crateOf: { 'TASK-101': 'agent-cockpit' },
      taskIndex: { keyOfId: {}, idOfKey: {}, tasks: { 'TASK-102': { repo: 'docs' } } },
    } as unknown as GarageState;
    const l = layoutFromState(state);
    const ids: StationId[] = [];
    for (const c of Object.values(characters)) ids.push(c.home, c.station);
    ids.push('bay:G', 'bay:H', 'crate:agent-cockpit', 'crate:docs', 'lab', 'bench', 'terminal', 'outbox');
    for (const id of ids) expect(l.resolve(id), id).not.toBeNull();
    expect(l.resolve('bay:B')!.label).toBe('BAY B — TASK-101 — agent-cockpit');
    expect(l.spec.waiting).toBe(1);
    expectAllReachable(l);
  });
});

describe('layoutFromState: extensions and waiting workers', () => {
  const base = (characters: Character[], extra: Record<string, unknown> = {}): GarageState =>
    ({
      characters: Object.fromEntries(characters.map((c) => [c.id, c])),
      stations: {},
      bayOf: {},
      crateOf: {},
      taskIndex: { keyOfId: {}, idOfKey: {}, tasks: {} },
      ...extra,
    }) as unknown as GarageState;

  it('resolves ext ids from stations and characters, preserving supplied definitions', () => {
    const state = base(
      [char({ id: 'rex', kind: 'worker', home: 'ext:pet', station: 'ext:ghost' }), char({ id: 'sup-1', kind: 'council', seat: 'sup-1', home: 'loft:sup-1' })],
      { stations: { 'ext:cable': { id: 'ext:cable', kind: 'ext', state: 'idle' } } },
    );
    const l = layoutFromState(state, { extensions: [{ id: 'ext:pet', kind: 'pet', label: 'Rex', near: { station: 'lab', dx: 1, dy: 0 }, data: { species: 'dog' } }] });
    for (const id of ['ext:pet', 'ext:ghost', 'ext:cable'] as StationId[]) expect(l.resolve(id), id).not.toBeNull();
    expect(l.resolve('ext:pet')!.label).toBe('Rex');
    expect(l.resolve('ext:pet')!.meta).toMatchObject({ species: 'dog' });
    expect(l.resolve('ext:ghost')!.kind).toBe('ext');
    expectAllReachable(l);
  });

  it('gives every waiting worker its own walkable, reachable slot even with unused bays', () => {
    const workers = Array.from({ length: 20 }, (_, i) => char({ id: `w${i}`, kind: 'worker', home: 'entrance' }));
    const state = base(workers, { bayOf: { 'TASK-1': 'A' } });
    const l = layoutFromState(state);
    expect(l.spec.waiting).toBe(20);
    expect(l.queueSlots).toBeGreaterThanOrEqual(20);
    const door = l.resolve('entrance')!.grid;
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = l.queueSlot(i);
      expect(l.walkable(s.gx, s.gy), `slot ${i}`).toBe(true);
      expect(findPath(l, door, s), `slot ${i}`).not.toBeNull();
      seen.add(`${s.gx},${s.gy}`);
    }
    expect(seen.size).toBe(20);
  });

  it('does not count workers that have a bay, and wraps past the last slot instead of leaving the room', () => {
    const state = base(
      [char({ id: 'a', kind: 'worker', home: 'entrance', station: 'bay:A' }), char({ id: 'b', kind: 'worker', home: 'entrance', station: 'lab', task: 'TASK-1' })],
      { bayOf: { 'TASK-1': 'B' } },
    );
    const l = layoutFromState(state);
    expect(l.spec.waiting).toBe(0);
    const s = l.queueSlot(10_000);
    expect(l.walkable(s.gx, s.gy)).toBe(true);
  });
});

describe('no DOM', () => {
  it('layout.ts only imports relative modules, and nothing DOM-ish', () => {
    const src = readFileSync(new URL('../packages/garage/src/layout.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]!);
    for (const i of imports) expect(i).toMatch(/^\.\/[a-z]+\.js$/);
    expect(src).not.toMatch(/\b(document|window|HTMLElement|OffscreenCanvas|CanvasRenderingContext2D)\b/);
  });
});
