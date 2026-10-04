import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLayout, type Layout, type LayoutSpec } from '../packages/garage/src/layout.js';
import type { Character, CharacterStateName, GarageState, StationId } from '../packages/garage/src/model.js';
import { PALETTES, createTheme, type ThemeSource } from '../packages/garage/src/palette.js';
import {
  CELEBRATE_MS, ROOM_PAD_TOP, STAMP_MS, createRenderer, poseFor, specialtyOf, stationLook, wantsFps,
  type CanvasRenderer, type RenderCtx, type RenderSurface, type RendererOptions, type SurfaceFactory,
} from '../packages/garage/src/renderer.js';
import { createSpriteCache, type Sprite, type SpriteCache } from '../packages/garage/src/sprites.js';

// ---------- stubs ----------

type Op =
  | { op: 'blit'; image: unknown; dx: number; dy: number; dw: number; dh: number; alpha: number; smoothing: boolean }
  | { op: 'fill'; x: number; y: number; w: number; h: number; color: string; alpha: number }
  | { op: 'transform' };

/** A canvas that records what was drawn on it. It is its own 2D context. */
class StubSurface implements RenderSurface, RenderCtx {
  ops: Op[] = [];
  fillStyle: string | object = '';
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  style = { width: '', height: '' };
  constructor(public width: number, public height: number) {}
  getContext(): RenderCtx {
    return this;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fill', x, y, w, h, color: String(this.fillStyle), alpha: this.globalAlpha });
  }
  drawImage(image: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.ops.push({ op: 'blit', image, dx, dy, dw, dh, alpha: this.globalAlpha, smoothing: this.imageSmoothingEnabled });
  }
  setTransform(): void {
    this.ops.push({ op: 'transform' });
  }
}

interface Tag {
  label: string;
  sprite: Sprite;
}

const SPEC: Partial<LayoutSpec> = {
  council: ['sup-1'],
  leads: [{ id: 'lead-1' }],
  bays: [{ id: 'A', task: 'TASK-1', repo: 'api' }],
  repos: ['api'],
};

interface Rig {
  r: CanvasRenderer;
  canvas: StubSurface;
  layout: Layout;
  theme: ThemeSource & { set(n: string): unknown };
  surfaces: StubSurface[];
  cache: SpriteCache;
  subs: { count: number };
  /** The blits of the last frame, in draw order, with what each one is. */
  blits(): Array<{ label: string; x: number; y: number; dw: number; alpha: number; smoothing: boolean }>;
  /** Device feet position of a character at zoom 1 with the room filling the canvas. */
  feet(id: string): { x: number; y: number };
  /** Every op of the last frame in order: a blit's label, or `fill:<colour>`. */
  sequence(): string[];
  frame(now: number): void;
}

function rig(over: Partial<RendererOptions> = {}, layoutSpec: Partial<LayoutSpec> = SPEC): Rig {
  const base = createTheme('phosphor');
  const subs = { count: 0 };
  const theme = {
    name: base.name,
    palette: base.palette,
    set: base.set,
    subscribe(fn: () => void) {
      subs.count++;
      const off = base.subscribe(fn);
      return () => {
        subs.count--;
        off();
      };
    },
  };
  const surfaces: StubSurface[] = [];
  const factory: SurfaceFactory = {
    create(w, h) {
      const s = new StubSurface(w, h);
      surfaces.push(s);
      return s;
    },
  };
  const real = createSpriteCache({ canvas: factory, theme });
  const tags = new Map<unknown, Tag>();
  const tag = (s: Sprite, label: string): Sprite => (tags.set(s.surface, { label, sprite: s }), s);
  const cache: SpriteCache = {
    ...real,
    character: (p) => tag(real.character(p), `char:${p.pose ?? 'stand'}:${p.facing ?? 'right'}`),
    prop: (p) => tag(real.prop(p), `prop:${p.kind}:${p.state ?? 'idle'}`),
    stamp: (k) => tag(real.stamp(k), `stamp:${k}`),
  };
  const layout = buildLayout(layoutSpec);
  const canvas = new StubSurface(layout.width, layout.height + ROOM_PAD_TOP);
  const r = createRenderer({ canvas, layout, surfaces: factory, sprites: cache, theme, clock: () => 0, ...over });
  const blits = () =>
    canvas.ops
      .filter((o): o is Extract<Op, { op: 'blit' }> => o.op === 'blit')
      .map((o) => {
        const t = tags.get(o.image);
        const z = 2 * r.zoom;
        return {
          label: t?.label ?? 'layer',
          x: o.dx + (t ? t.sprite.anchorX * z : 0),
          y: o.dy + (t ? t.sprite.anchorY * z : 0),
          dw: o.dw,
          alpha: o.alpha,
          smoothing: o.smoothing,
        };
      });
  const sequence = () => canvas.ops.flatMap((o) => (o.op === 'blit' ? [tags.get(o.image)?.label ?? 'layer'] : o.op === 'fill' ? [`fill:${o.color}`] : []));
  return {
    r, canvas, layout, theme, surfaces, cache, subs, blits, sequence,
    feet(id) {
      const v = r.inspect(id)!;
      return { x: v.x, y: v.y + ROOM_PAD_TOP };
    },
    frame(now) {
      canvas.ops.length = 0;
      r.frame(now);
    },
  };
}

const ch = (id: string, kind: Character['kind'], station: StationId, over: Partial<Character> = {}): Character => ({
  id, kind, label: id, agentId: id, seat: id, persona: kind === 'worker' ? 'backend-dev' : null, lead: 'lead-1', home: station, station,
  task: null, flags: { failed: false, blocked: false, awaitingHuman: false, review: false }, state: 'idle', ...over,
});

function stateOf(chars: Character[], stations: GarageState['stations'] = {} as GarageState['stations']): GarageState {
  return {
    run: { runId: 'r1', lastSeq: 1, phase: 'build', status: 'running' },
    characters: Object.fromEntries(chars.map((c) => [c.id, c])),
    sessions: {}, taskIndex: { keyOfId: {}, idOfKey: {}, tasks: {} }, bayOf: {}, crateOf: {}, stations,
    board: [], outbox: [], approval: null, log: [],
    spend: { total: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byAgent: {} },
    limits: {} as GarageState['limits'],
  };
}

/** Frames at `step` ms from `from` (inclusive) to `to` (inclusive); returns each frame's agent view. */
function run(t: Rig, id: string, from: number, to: number, step = 16) {
  const out: Array<{ now: number; x: number; y: number; gx: number; gy: number; moving: boolean; hopping: boolean; pose: string }> = [];
  for (let now = from; now <= to; now += step) {
    t.frame(now);
    const v = t.r.inspect(id);
    if (!v) break;
    out.push({ now, x: v.x, y: v.y, gx: v.gx, gy: v.gy, moving: v.moving, hopping: v.hopping, pose: v.pose });
  }
  return out;
}

const maxStep = (xs: Array<{ x: number; y: number }>): number => {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.hypot(xs[i]!.x - xs[i - 1]!.x, xs[i]!.y - xs[i - 1]!.y));
  return m;
};

afterEach(() => vi.restoreAllMocks());

// ---------- pure helpers ----------

describe('pure helpers', () => {
  it('poseFor: walking alternates legs, hopping stands, failures slump, typing needs a seat', () => {
    const base = { anim: 'idle', seated: false, walking: false, hopping: false, celebrating: false } as const;
    expect(new Set([0, 140].map((n) => poseFor({ ...base, walking: true }, n)))).toEqual(new Set(['walkA', 'walkB']));
    expect(poseFor({ ...base, walking: true, hopping: true }, 0)).toBe('stand');
    expect(poseFor({ ...base, anim: 'failed' }, 0)).toBe('slump');
    expect(poseFor({ ...base, anim: 'blocked', seated: true }, 0)).toBe('slump');
    expect(new Set([0, 180].map((n) => poseFor({ ...base, anim: 'implementing', seated: true }, n)))).toEqual(new Set(['workA', 'workB']));
    expect(poseFor({ ...base, anim: 'implementing' }, 0)).toBe('stand');
    expect(poseFor({ ...base, anim: 'thinking', seated: true }, 0)).toBe('sit');
    expect(poseFor({ ...base, celebrating: true }, 0)).not.toBe('slump');
    expect(new Set([0, 220].map((n) => poseFor({ ...base, celebrating: true }, n)))).toEqual(new Set(['cheer', 'stand']));
  });

  it('stationLook: alert blinks, a jammed bench shakes, everything else is steady', () => {
    expect(new Set([0, 450].map((n) => stationLook('desk:lead-1', 'alert', n).state))).toEqual(new Set(['alert', 'idle']));
    expect(new Set([0, 60].map((n) => stationLook('bench', 'failed', n).dx))).toEqual(new Set([-1, 1]));
    expect(stationLook('bench', 'failed', 0).state).toBe('failed');
    expect(stationLook('lab', 'failed', 60)).toEqual({ state: 'failed', dx: 0 });
    expect(stationLook('lab', 'ok', 60)).toEqual({ state: 'ok', dx: 0 });
  });

  it('wantsFps and specialtyOf', () => {
    expect(wantsFps('#fps')).toBe(true);
    expect(wantsFps('#run=abc&fps')).toBe(true);
    expect(wantsFps('#fps=1')).toBe(true);
    expect(wantsFps('#token=x')).toBe(false);
    expect(wantsFps('#fpsx')).toBe(false);
    expect(wantsFps('')).toBe(false);
    expect(specialtyOf('backend-dev')).toBe('backend');
    expect(specialtyOf('frontend')).toBe('frontend');
    expect(specialtyOf(null)).toBeNull();
  });
});

// ---------- spawn, move, depth ----------

describe('spawn and place', () => {
  it('does nothing until frame() is asked for: no draw calls, no surfaces, no timers', () => {
    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval')];
    const raf = vi.fn();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    try {
      const t = rig();
      t.r.spawnAgent('w1', 'worker', 'entrance');
      t.r.moveAgent('w1', 'lab');
      t.r.playAnimation('w1', 'testing');
      t.r.updateStation('lab', 'busy');
      t.r.syncState(stateOf([ch('w1', 'worker', 'lab')]));
      t.r.resize(800, 600, 2);
      t.r.applyIntent({ type: 'stamp', kind: 'approved', at: 'desk:lead-1', task: null });
      expect(t.canvas.ops).toEqual([]);
      expect(t.surfaces).toHaveLength(0);
      expect(t.r.stats().frames).toBe(0);
      for (const s of timers) expect(s).not.toHaveBeenCalled();
      expect(raf).not.toHaveBeenCalled();
      t.frame(0);
      expect(t.canvas.ops.length).toBeGreaterThan(0);
      t.r.dispose();
      for (const s of timers) expect(s).not.toHaveBeenCalled();
      expect(raf).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
  });

  it('spawns on the station tile and fades in', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'crate:api');
    const spot = t.layout.resolve('crate:api')!;
    const v0 = t.r.inspect('w1')!;
    expect([v0.gx, v0.gy]).toEqual([spot.grid.gx, spot.grid.gy]);
    expect(v0.x).toBeCloseTo(spot.screen.x);
    expect(v0.y).toBeCloseTo(spot.screen.y);
    t.frame(1000);
    expect(t.r.inspect('w1')!.alpha).toBe(0);
    t.frame(1175);
    expect(t.r.inspect('w1')!.alpha).toBeGreaterThan(0.3);
    expect(t.r.inspect('w1')!.alpha).toBeLessThan(0.8);
    t.frame(2000);
    expect(t.r.inspect('w1')!.alpha).toBe(1);
  });

  it('spawn is idempotent and falls back to the entrance for a station that does not exist', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    t.r.spawnAgent('w1', 'worker', 'bench');
    expect(t.r.inspect('w1')!.station).toBe('lab');
    t.r.spawnAgent('w2', 'worker', 'crate:nope');
    expect(t.r.inspect('w2')!.station).toBe('entrance');
    t.r.moveAgent('w2', 'bay:Z');
    expect(t.r.inspect('w2')!.station).toBe('entrance');
    t.r.moveAgent('ghost', 'lab');
    expect(t.r.inspect('ghost')).toBeNull();
  });

  it('two characters at one station stand apart; at the entrance they queue in the layout slots', () => {
    const t = rig();
    t.r.spawnAgent('a', 'worker', 'lab');
    t.r.spawnAgent('b', 'worker', 'lab');
    const [a, b] = [t.r.inspect('a')!, t.r.inspect('b')!];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(4);
    t.r.spawnAgent('c', 'worker', 'entrance');
    t.r.spawnAgent('d', 'worker', 'entrance');
    const slot = t.layout.queueSlot(0);
    expect([t.r.inspect('d')!.gx, t.r.inspect('d')!.gy]).toEqual([slot.gx, slot.gy]);
    expect(t.layout.walkable(slot.gx, slot.gy)).toBe(true);
  });
});

describe('depth sorting', () => {
  it('draws characters back to front: farther from the viewer first', () => {
    const t = rig();
    const spots: Array<[string, StationId]> = [['d', 'entrance'], ['a', 'desk:lead-1'], ['c', 'crate:api'], ['b', 'bay:A'], ['e', 'lab']];
    for (const [id, at] of spots) t.r.spawnAgent(id, 'worker', at);
    t.frame(0);
    t.frame(1000);
    const ys = t.blits().filter((b) => b.label.startsWith('char:')).map((b) => Math.round(b.y));
    expect(ys).toHaveLength(spots.length);
    expect(ys).toEqual([...ys].sort((p, q) => p - q));
    // and the order is by gx + gy, which is what the screen y encodes
    const depth = (id: string) => t.r.inspect(id)!.gx + t.r.inspect(id)!.gy;
    const order = t.blits().filter((b) => b.label.startsWith('char:')).map((b) => spots.find(([id]) => Math.abs(t.feet(id).y - b.y) < 1 && Math.abs(t.feet(id).x - b.x) < 1)![0]);
    expect(order.map(depth)).toEqual([...order.map(depth)].sort((p, q) => p - q));
  });

  it('puts a character in front of the furniture at its own station, and extras on either side of it', () => {
    const t = rig();
    t.r.spawnAgent('a', 'lead', 'desk:lead-1');
    const desk = t.layout.resolve('desk:lead-1')!;
    // the desk's footprint is the row behind the stand tile
    const keys = desk.footprint.map((p) => p.gx + p.gy);
    const [near, far] = [Math.min(...keys), Math.max(...keys)];
    const mark = (name: string, depth: number) =>
      t.r.addDrawable({ id: name, depth: () => depth, draw: (v) => { v.ctx.fillStyle = name; v.ctx.fillRect(0, 0, 1, 1); } });
    mark('behind-desk', near - 0.5);
    mark('in-front-of-desk', far + 0.5);
    t.frame(0);
    t.frame(1000);
    const seq = t.sequence();
    const desks = seq.flatMap((l, i) => (l === 'prop:desk:idle' ? [i] : []));
    const chars = seq.flatMap((l, i) => (l.startsWith('char:') ? [i] : []));
    expect(desks).toHaveLength(keys.length);
    expect(chars).toHaveLength(1);
    expect(seq.indexOf('fill:behind-desk')).toBeLessThan(desks[0]!);
    expect(seq.indexOf('fill:in-front-of-desk')).toBeGreaterThan(desks[desks.length - 1]!);
    // desk pieces at or behind the character's depth draw first, the ones in front of it after
    const charKey = t.r.inspect('a')!.gx + t.r.inspect('a')!.gy;
    const sorted = [...keys].sort((p, q) => p - q);
    const before = sorted.filter((k) => k <= charKey).length;
    expect(before).toBeGreaterThan(0);
    expect(chars[0]!).toBeGreaterThan(desks[before - 1]!);
    if (before < desks.length) expect(chars[0]!).toBeLessThan(desks[before]!);
  });

  it('draws furniture of equal depth before characters', () => {
    const t = rig();
    t.r.spawnAgent('a', 'worker', 'entrance');
    t.frame(0);
    const labels = t.blits().map((b) => b.label);
    expect(labels.lastIndexOf('prop:entrance:idle')).toBeLessThan(labels.findIndex((l) => l.startsWith('char:')));
  });
});

// ---------- movement ----------

describe('movement never teleports', () => {
  it('walks tile by tile along the walk grid, in small steps, and ends exactly on the station', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    const before = t.r.inspect('w1')!;
    t.r.moveAgent('w1', 'lab');
    const goal = t.layout.resolve('lab')!;
    const samples = run(t, 'w1', 100, 8000);
    expect(samples.length).toBeGreaterThan(20);
    // first frame after the order: still where it was
    expect(Math.hypot(samples[0]!.x - before.x, samples[0]!.y - before.y)).toBeLessThan(0.5);
    // the fastest the easing goes is pi/2 times the walking speed: 4 tiles/s, at most ~18 px a tile
    expect(maxStep(samples)).toBeLessThan(2.5);
    for (const s of samples) expect(t.layout.walkable(Math.round(s.gx), Math.round(s.gy)), `(${s.gx},${s.gy})`).toBe(true);
    expect(samples.some((s) => s.moving && s.pose.startsWith('walk'))).toBe(true);
    const end = samples[samples.length - 1]!;
    expect(end.moving).toBe(false);
    expect([end.gx, end.gy]).toEqual([goal.grid.gx, goal.grid.gy]);
    expect(end.x).toBeCloseTo(goal.screen.x);
    expect(end.y).toBeCloseTo(goal.screen.y);
  });

  it('eases: slow at both ends, faster in the middle', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'bay:A');
    const s = run(t, 'w1', 0, 8000);
    const steps = s.slice(1).map((p, i) => Math.hypot(p.x - s[i]!.x, p.y - s[i]!.y)).filter((d, i) => s[i]!.moving);
    const mid = steps[Math.floor(steps.length / 2)]!;
    expect(steps[0]!).toBeLessThan(mid / 2);
    expect(steps[steps.length - 1]!).toBeLessThan(mid / 2);
  });

  it('a long walk becomes a hop: still eased, arcing, no walk cycle', () => {
    const t = rig({ hopTiles: 3 });
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'loft:sup-1');
    const goal = t.layout.resolve('loft:sup-1')!;
    const s = run(t, 'w1', 100, 3000);
    expect(s.some((p) => p.hopping)).toBe(true);
    expect(s.filter((p) => p.hopping).every((p) => !p.pose.startsWith('walk'))).toBe(true);
    expect(s.length).toBeGreaterThan(20);
    expect(maxStep(s)).toBeLessThan(26);
    const end = s[s.length - 1]!;
    expect(end.hopping).toBe(false);
    expect(end.x).toBeCloseTo(goal.screen.x);
    expect(end.y).toBeCloseTo(goal.screen.y);
    // the hop arcs over a straight line from start to goal
    const air = s.filter((p) => p.hopping);
    const mid = air[Math.floor(air.length / 2)]!;
    const u = (mid.gx - air[0]!.gx) / (goal.grid.gx - air[0]!.gx);
    const straightY = air[0]!.y + (goal.screen.y - air[0]!.y) * u;
    expect(mid.y).toBeLessThan(straightY - 10);
  });

  it('climbs to the loft over the last tile instead of jumping up', () => {
    const t = rig();
    t.r.spawnAgent('c', 'council', 'entrance');
    t.frame(0);
    t.r.moveAgent('c', 'loft:sup-1');
    const s = run(t, 'c', 0, 12000);
    expect(maxStep(s)).toBeLessThan(4);
    expect(t.r.inspect('c')!.elevation).toBe(t.layout.resolve('loft:sup-1')!.elevation);
  });

  it('a new order mid-walk starts from where the character is, not from the old goal or the start', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'lab');
    const before = run(t, 'w1', 0, 700);
    expect(before[before.length - 1]!.moving).toBe(true);
    const at = before[before.length - 1]!;
    t.r.moveAgent('w1', 'crate:api');
    const after = run(t, 'w1', 716, 9000);
    expect(Math.hypot(after[0]!.x - at.x, after[0]!.y - at.y)).toBeLessThan(2.5);
    expect(maxStep([at, ...after])).toBeLessThan(2.5);
    expect(after[after.length - 1]!.moving).toBe(false);
    expect(t.r.inspect('w1')!.station).toBe('crate:api');
  });

  it('is a function of the frame clock only: jumping `now` ahead lands on the goal, going back does not undo it', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'terminal');
    t.frame(100);
    t.frame(100000);
    const goal = t.layout.resolve('terminal')!;
    expect(t.r.inspect('w1')!.moving).toBe(false);
    expect(t.r.inspect('w1')!.x).toBeCloseTo(goal.screen.x);
    t.frame(50);
    expect(t.r.inspect('w1')!.x).toBeCloseTo(goal.screen.x);
  });

  it('faces the way it walks', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    t.frame(0);
    t.r.moveAgent('w1', 'entrance');
    let checked = 0;
    let prev = t.r.inspect('w1')!;
    for (let now = 16; now <= 4000; now += 16) {
      t.frame(now);
      const v = t.r.inspect('w1')!;
      if (Math.abs(v.x - prev.x) > 0.3) {
        expect(v.facing).toBe(v.x > prev.x ? 'right' : 'left');
        checked++;
      }
      prev = v;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

// ---------- diffing state ----------

describe('syncState diffs logical state and animates the differences', () => {
  const stations = (m: Record<string, 'ok' | 'failed' | 'busy' | 'idle' | 'alert'>) =>
    Object.fromEntries(Object.entries(m).map(([id, state]) => [id, { id, kind: 'lab', state }])) as unknown as GarageState['stations'];

  it('places the first state where it is, without walking', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('sup-1', 'council', 'loft:sup-1'), ch('w1', 'worker', 'bay:A', { task: 'TASK-1' })]));
    for (const id of ['sup-1', 'w1']) {
      expect(t.r.inspect(id)!.moving).toBe(false);
      const st = t.r.layout.resolve(t.r.inspect(id)!.station)!;
      expect(t.r.inspect(id)!.x).toBeCloseTo(st.screen.x);
    }
  });

  it('a station change after a rebase is a walk from the old spot', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A')]));
    t.frame(0);
    const was = t.r.inspect('w1')!;
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab')]));
    expect(t.r.inspect('w1')!.x).toBeCloseTo(was.x);
    expect(t.r.inspect('w1')!.moving).toBe(true);
    const s = run(t, 'w1', 16, 9000);
    expect(maxStep(s)).toBeLessThan(2.5);
    expect(t.r.inspect('w1')!.station).toBe('lab');
    expect(t.r.inspect('w1')!.moving).toBe(false);
    // the same state again changes nothing
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab')]));
    expect(t.r.inspect('w1')!.moving).toBe(false);
  });

  it('a worker that appears later walks in from the entrance', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab')]));
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab'), ch('w2', 'worker', 'bay:A')]));
    const door = t.r.layout.resolve('entrance')!;
    expect(t.r.inspect('w2')!.x).toBeCloseTo(door.screen.x);
    expect(t.r.inspect('w2')!.moving).toBe(true);
    const s = run(t, 'w2', 0, 9000);
    expect(maxStep(s)).toBeLessThan(2.5);
    expect(t.r.inspect('w2')!.station).toBe('bay:A');
  });

  it('a character that leaves the state walks out the entrance, fades, and is gone', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A'), ch('w2', 'worker', 'lab')]));
    t.frame(0);
    t.r.syncState(stateOf([ch('w2', 'worker', 'lab')]));
    expect(t.r.inspect('w1')!.leaving).toBe(true);
    const s = run(t, 'w1', 16, 12000);
    expect(maxStep(s)).toBeLessThan(2.5);
    expect(t.r.inspect('w1')).toBeNull();
    expect(t.r.inspect('w2')).not.toBeNull();
    expect(t.r.anchorOf('w1')).toBeNull();
  });

  it('a character that comes back while leaving is welcomed back, not removed', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A')]));
    t.frame(0);
    t.r.syncState(stateOf([]));
    run(t, 'w1', 16, 200);
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A')]));
    run(t, 'w1', 216, 12000);
    const v = t.r.inspect('w1')!;
    expect(v.leaving).toBe(false);
    expect(v.alpha).toBe(1);
    expect(v.station).toBe('bay:A');
  });

  it('a layout change makes characters walk to the new furniture from where they stand, never reset', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'crate:api')]));
    t.frame(0);
    const was = t.r.inspect('w1')!;
    // a new lead desk and a second repo move everything below the desks
    t.r.syncState(stateOf([ch('w1', 'worker', 'crate:api'), ch('lead-2', 'lead', 'desk:lead-2'), ch('w3', 'worker', 'crate:docs')]));
    const now = t.r.inspect('w1')!;
    expect([now.gx, now.gy]).toEqual([was.gx, was.gy]);
    expect(t.r.layout.resolve('desk:lead-2')).not.toBeNull();
    const goal = t.r.layout.resolve('crate:api')!;
    const s = run(t, 'w1', 16, 12000);
    expect(maxStep(s)).toBeLessThan(26);
    expect(s[s.length - 1]!.x).toBeCloseTo(goal.screen.x);
  });

  it('keeps everyone where they are drawn when a reconcile re-lays the room, then eases onto the new projection', () => {
    const t = rig();
    const lead = ch('lead-1', 'lead', 'desk:lead-1');
    t.r.syncState(stateOf([lead, ch('w1', 'worker', 'crate:api'), ch('w2', 'worker', 'entrance')]));
    t.frame(0);
    t.frame(1000);
    const first = t.r.layout;
    const spots = Object.fromEntries(['lead-1', 'w1', 'w2'].map((id) => [id, t.r.inspect(id)!.device]));
    // the first council seat raises the loft and the room grows: the projection's origin moves
    t.r.syncState(stateOf([lead, ch('sup-1', 'council', 'loft:sup-1'), ch('w1', 'worker', 'crate:api'), ch('w2', 'worker', 'entrance'), ch('w3', 'worker', 'crate:docs'), ch('w4', 'worker', 'bay:B')]));
    expect(t.r.layout).not.toBe(first);
    expect(t.r.layout.toScreen(3, 3)).not.toEqual(first.toScreen(3, 3));
    // immediately after the sync, before any frame: nobody has moved on the canvas
    for (const id of ['lead-1', 'w1', 'w2']) expect(t.r.inspect(id)!.device, id).toEqual(spots[id]);
    t.frame(1016);
    for (const id of ['lead-1', 'w1', 'w2']) {
      const d = t.r.inspect(id)!.device;
      expect(Math.hypot(d.x - spots[id]!.x, d.y - spots[id]!.y), id).toBeLessThan(14 * t.r.zoom);
    }
  });

  it('a re-laid room never shifts a character on the canvas between the frame before and the frame after', () => {
    const t = rig();
    const lead = ch('lead-1', 'lead', 'desk:lead-1');
    t.r.syncState(stateOf([lead, ch('w1', 'worker', 'crate:api')]));
    t.frame(0);
    t.frame(1000);
    const was = t.r.inspect('w1')!.device;
    const oldOrigin = t.r.layout.toScreen(0, 0);
    t.r.syncState(stateOf([lead, ch('sup-1', 'council', 'loft:sup-1'), ch('w1', 'worker', 'crate:api'), ch('x', 'worker', 'crate:docs')]));
    expect(t.r.layout.toScreen(0, 0)).not.toEqual(oldOrigin);
    expect(t.r.inspect('w1')!.device).toEqual(was);
    const samples: Array<{ x: number; y: number }> = [was];
    for (let now = 1016; now <= 6000; now += 16) {
      t.frame(now);
      samples.push(t.r.inspect('w1')!.device);
    }
    expect(maxStep(samples)).toBeLessThan(14 * t.r.zoom);
    const goal = t.r.layout.resolve('crate:api')!;
    expect(t.r.inspect('w1')!.moving).toBe(false);
    expect(t.r.inspect('w1')!.x).toBeCloseTo(goal.screen.x);
    expect(t.r.inspect('w1')!.y).toBeCloseTo(goal.screen.y);
  });

  it('a new order near the peak of a hop keeps the hop height and eases down from it', () => {
    const t = rig({ hopTiles: 3 });
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'loft:sup-1');
    for (let now = 100; now <= 100 + 330; now += 16) t.frame(now);
    expect(t.r.inspect('w1')!.hopping).toBe(true);
    const before = t.r.inspect('w1')!;
    t.r.moveAgent('w1', 'desk:lead-1');
    // the order itself moves nothing on screen
    expect(t.r.inspect('w1')!.device).toEqual(before.device);
    expect(t.r.inspect('w1')!.y).toBeCloseTo(before.y);
    const samples: Array<{ x: number; y: number }> = [before];
    for (let now = 446; now <= 5000; now += 16) {
      t.frame(now);
      samples.push(t.r.inspect('w1')!);
    }
    // no drop of the whole hop lift (24 px) in one frame
    expect(maxStep(samples)).toBeLessThan(20);
    const goal = t.r.layout.resolve('desk:lead-1')!;
    expect(t.r.inspect('w1')!.x).toBeCloseTo(goal.screen.x);
    expect(t.r.inspect('w1')!.y).toBeCloseTo(goal.screen.y);
  });

  it('a hop redirected mid-air is drawn at the same height on the next frame (no lift reset)', () => {
    const t = rig({ hopTiles: 3 });
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.r.moveAgent('w1', 'loft:sup-1');
    for (let now = 100; now <= 100 + 320; now += 16) t.frame(now);
    const air = t.r.inspect('w1')!;
    expect(air.hopping).toBe(true);
    t.r.moveAgent('w1', 'crate:api');
    // the same instant again: the new motion has only just begun, so nothing but the offset is in play
    t.frame(100 + 320);
    const next = t.r.inspect('w1')!;
    expect(Math.abs(next.y - air.y)).toBeLessThan(1);
    expect(Math.abs(next.x - air.x)).toBeLessThan(1);
  });

  it('removes a character that leaves while already standing at the entrance, and stops asking for frames', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'entrance'), ch('w2', 'worker', 'lab')]));
    t.frame(0);
    t.frame(1000);
    t.r.syncState(stateOf([ch('w2', 'worker', 'lab')]));
    expect(t.r.inspect('w1')!.leaving).toBe(true);
    expect(t.r.inspect('w1')!.moving).toBe(false);
    expect(t.r.needsFrame()).toBe(true);
    let now = 1016;
    for (; now < 3000 && t.r.inspect('w1'); now += 16) t.frame(now);
    expect(t.r.inspect('w1')).toBeNull();
    expect(now).toBeLessThan(1016 + 800);
    t.frame(now);
    expect(t.r.inspect('w2')).not.toBeNull();
    expect(t.r.needsFrame()).toBe(false);
  });

  it('keeps asking for frames while an awaiting-human lamp blinks, once the spawn fade is over', () => {
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A', { state: 'awaitingHuman' })]));
    for (const now of [0, 200, 400, 600, 800, 1000]) t.frame(now);
    expect(t.r.inspect('w1')!.alpha).toBe(1);
    expect(t.r.needsFrame()).toBe(true);
    const yellow = (now: number) => {
      t.frame(now);
      return t.canvas.ops.some((o) => o.op === 'fill' && o.color === PALETTES.phosphor.base.yellow);
    };
    expect(new Set([yellow(1800), yellow(2250)])).toEqual(new Set([true, false]));
    expect(t.r.needsFrame()).toBe(true);
    // a steady lamp does not
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A', { state: 'failed' })]));
    t.frame(3000);
    expect(t.r.needsFrame()).toBe(false);
  });

  it('sets poses from the resolved state: typing needs a seat, a failure slumps', () => {
    const t = rig();
    const at = (state: CharacterStateName, station: StationId = 'bay:A') => stateOf([ch('w1', 'worker', station, { state })]);
    t.r.syncState(at('implementing'));
    const poses = new Set<string>();
    for (const now of [0, 90, 180, 270, 360]) {
      t.frame(now);
      poses.add(t.r.inspect('w1')!.pose);
    }
    expect(poses).toEqual(new Set(['workA', 'workB']));
    t.r.syncState(at('failed'));
    t.frame(1000);
    expect(t.r.inspect('w1')!.pose).toBe('slump');
    t.r.syncState(at('implementing', 'terminal'));
    run(t, 'w1', 1016, 9000);
    expect(t.r.inspect('w1')!.pose).toBe('stand');
  });

  it('lights stations from the state and puts them out when they leave it', () => {
    const t = rig();
    t.r.syncState(stateOf([], stations({ lab: 'ok' })));
    t.frame(0);
    expect(t.blits().map((b) => b.label)).toContain('prop:lab:ok');
    t.r.syncState(stateOf([], stations({ lab: 'failed' })));
    t.frame(16);
    expect(t.blits().map((b) => b.label)).toContain('prop:lab:failed');
    t.r.syncState(stateOf([], stations({})));
    t.frame(32);
    expect(t.blits().map((b) => b.label)).toContain('prop:lab:idle');
    expect(t.blits().map((b) => b.label)).not.toContain('prop:lab:failed');
  });
});

// ---------- intents ----------

describe('scene intents', () => {
  it('stamps APPROVED and CHANGES over a station, then lets them go', () => {
    const t = rig();
    t.r.applyIntent({ type: 'stamp', kind: 'approved', at: 'desk:lead-1', task: 'TASK-1' });
    t.r.applyIntent({ type: 'stamp', kind: 'changes', at: 'desk:lead-1', task: 'TASK-1' });
    t.r.applyIntent({ type: 'stamp', kind: 'merged', at: 'nowhere' as StationId, task: null });
    t.frame(0);
    expect(t.blits().map((b) => b.label)).toEqual(expect.arrayContaining(['stamp:approved', 'stamp:changes']));
    expect(t.blits().map((b) => b.label)).not.toContain('stamp:merged');
    t.frame(STAMP_MS * 0.9);
    const fading = t.blits().filter((b) => b.label.startsWith('stamp:'));
    expect(fading.length).toBe(2);
    expect(fading.every((b) => b.alpha < 1 && b.alpha > 0)).toBe(true);
    t.frame(STAMP_MS + 100);
    expect(t.blits().filter((b) => b.label.startsWith('stamp:'))).toEqual([]);
    expect(t.r.needsFrame()).toBe(false);
  });

  it('stamps rise over the station and never sit below it', () => {
    const t = rig();
    t.r.applyIntent({ type: 'stamp', kind: 'approved', at: 'desk:lead-1', task: null });
    t.frame(0);
    const desk = t.layout.resolve('desk:lead-1')!;
    const s = t.blits().find((b) => b.label === 'stamp:approved')!;
    expect(s.y).toBeLessThan(desk.screen.y + ROOM_PAD_TOP);
  });

  it('shows the lab light green or red, and jams the bench', () => {
    const t = rig();
    t.r.applyIntent({ type: 'station', id: 'lab', state: 'ok' });
    t.frame(0);
    expect(t.blits().map((b) => b.label)).toContain('prop:lab:ok');
    t.r.applyIntent({ type: 'station', id: 'lab', state: 'failed' });
    t.frame(16);
    expect(t.blits().map((b) => b.label)).toContain('prop:lab:failed');

    t.r.applyIntent({ type: 'station', id: 'bench', state: 'failed' });
    const benchX = (now: number) => {
      t.frame(now);
      return t.blits().find((b) => b.label.startsWith('prop:bench:'))!.x;
    };
    expect(new Set([benchX(0), benchX(60)]).size).toBe(2);
    // smoke rises while it is jammed
    t.frame(0);
    expect(t.canvas.ops.some((o) => o.op === 'fill' && o.color === PALETTES.phosphor.base.mute)).toBe(true);
    expect(t.r.needsFrame()).toBe(true);
    t.r.applyIntent({ type: 'station', id: 'bench', state: 'ok' });
    const steady = new Set([benchX(0), benchX(60)]);
    expect(steady.size).toBe(1);
  });

  it('blinks an alert and is steady otherwise', () => {
    const t = rig();
    t.r.updateStation('outbox', 'alert');
    const seen = new Set<string>();
    for (const now of [0, 450, 900, 1350]) {
      t.frame(now);
      for (const b of t.blits()) if (b.label.startsWith('prop:outbox')) seen.add(b.label);
    }
    expect(seen).toEqual(new Set(['prop:outbox:alert', 'prop:outbox:idle']));
  });

  it('celebrates: arms up, confetti in palette colours, then back to work', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'bay:A', { task: 'TASK-1' });
    t.r.spawnAgent('w2', 'worker', 'lab', { task: 'TASK-2' });
    t.r.applyIntent({ type: 'celebrate', scope: 'task', task: 'TASK-1' });
    t.frame(0);
    t.frame(220);
    const posesA = new Set<string>();
    const posesB = new Set<string>();
    for (const now of [220, 440, 660]) {
      t.frame(now);
      posesA.add(t.r.inspect('w1')!.pose);
      posesB.add(t.r.inspect('w2')!.pose);
    }
    expect(posesA.has('cheer')).toBe(true);
    expect(posesB.has('cheer')).toBe(false);
    t.frame(500);
    const pal = PALETTES.phosphor.base;
    const colors = new Set(t.canvas.ops.filter((o): o is Extract<Op, { op: 'fill' }> => o.op === 'fill' && o.color !== pal.bgDeep).map((o) => o.color));
    expect(colors.size).toBeGreaterThan(0);
    const allowed = new Set<string>(Object.values(pal));
    for (const c of colors) expect(allowed.has(c), c).toBe(true);
    // deterministic: the same moment draws the same confetti
    const fills = () => JSON.stringify(t.canvas.ops.filter((o) => o.op === 'fill'));
    t.frame(500);
    const again = fills();
    t.frame(500);
    expect(fills()).toBe(again);
    t.frame(CELEBRATE_MS + 300);
    expect(t.r.inspect('w1')!.pose).not.toBe('cheer');
    expect(t.r.needsFrame()).toBe(false);
  });

  it('a run celebration is for everyone', () => {
    const t = rig();
    t.r.spawnAgent('a', 'worker', 'bay:A');
    t.r.spawnAgent('b', 'lead', 'desk:lead-1');
    t.r.applyIntent({ type: 'celebrate', scope: 'run', task: null });
    t.frame(0);
    t.frame(220);
    expect(t.r.inspect('a')!.pose).toBe('cheer');
    expect(t.r.inspect('b')!.pose).toBe('cheer');
  });

  it('plays animations by name, and ignores intents for characters or stations it does not know', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'bay:A');
    t.r.applyIntent({ type: 'animate', character: 'w1', animation: 'blocked' });
    t.frame(0);
    expect(t.r.inspect('w1')!.anim).toBe('blocked');
    expect(t.r.inspect('w1')!.pose).toBe('slump');
    t.r.applyIntent({ type: 'animate', character: 'ghost', animation: 'failed' });
    t.r.applyIntent({ type: 'move', character: 'ghost', to: 'lab' });
    t.r.applyIntent({ type: 'bubble', character: 'w1', text: 'hi', tone: 'say' });
    t.r.applyIntent({ type: 'spawn', character: 'w9', kind: 'worker', at: 'terminal' });
    t.r.applyIntent({ type: 'move', character: 'w9', to: 'lab' });
    expect(t.r.inspect('w9')!.station).toBe('lab');
    expect(() => t.frame(16)).not.toThrow();
  });

  it('a failed or blocked worker shows a red or orange lamp over its head, from the palette', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'bay:A');
    t.r.playAnimation('w1', 'failed');
    t.frame(0);
    t.frame(1000);
    const pal = PALETTES.phosphor.base;
    expect(t.canvas.ops.some((o) => o.op === 'fill' && o.color === pal.red)).toBe(true);
  });
});

// ---------- the room, zoom, dpr ----------

describe('static layer, zoom and device pixel ratio', () => {
  it('draws the room once into one layer and blits it first each frame', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    t.frame(0);
    expect(t.surfaces.length).toBeGreaterThan(0);
    const layers = t.surfaces.filter((s) => s.width === Math.round(t.layout.width) && s.height === Math.round(t.layout.height + ROOM_PAD_TOP));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.ops.length).toBeGreaterThan(t.layout.cols * t.layout.rows);
    const first = t.canvas.ops.find((o) => o.op === 'blit')!;
    expect(first.op === 'blit' && first.image).toBe(layers[0]);
    const made = t.surfaces.length;
    t.frame(16);
    t.frame(32);
    expect(t.surfaces.length).toBe(made);
    expect(layers[0]!.ops.length).toBeGreaterThan(0);
  });

  it('each frame draws only sprites: the layer is not redrawn', () => {
    const t = rig();
    t.frame(0);
    const layer = t.surfaces.find((s) => s.ops.length > 100)!;
    const n = layer.ops.length;
    t.frame(16);
    t.frame(32);
    expect(layer.ops.length).toBe(n);
    const blits = t.canvas.ops.filter((o) => o.op === 'blit');
    expect(blits.length).toBeGreaterThan(5);
  });

  it('blits nearest-neighbour at whole multiples of the art scale, at any device pixel ratio', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const t = rig({ view: { width: 1900, height: 1100, dpr } });
      t.r.spawnAgent('w1', 'worker', 'lab');
      t.frame(0);
      t.frame(500);
      expect(t.canvas.width).toBe(Math.round(1900 * dpr));
      expect(t.canvas.height).toBe(Math.round(1100 * dpr));
      expect(t.canvas.style).toEqual({ width: '1900px', height: '1100px' });
      expect(Number.isInteger(t.r.zoom) && t.r.zoom >= 1).toBe(true);
      for (const o of t.canvas.ops) {
        if (o.op !== 'blit') continue;
        expect(o.smoothing).toBe(false);
        expect(Number.isInteger(o.dx) && Number.isInteger(o.dy)).toBe(true);
        if (o.image !== t.surfaces[0]) expect(o.dw % (2 * t.r.zoom)).toBe(0);
      }
    }
  });

  it('picks the biggest integer zoom that fits the room, and lets the caller pin one', () => {
    const t = rig();
    const w = t.layout.width;
    const h = t.layout.height + ROOM_PAD_TOP;
    t.r.resize(w * 3, h * 3 + 5, 1);
    expect(t.r.zoom).toBe(3);
    t.r.resize(w * 3 - 1, h * 3, 1);
    expect(t.r.zoom).toBe(2);
    t.r.resize(w * 3 - 1, h * 3, 1.5);
    expect(t.r.zoom).toBe(Math.floor(Math.min((w * 3 - 1) * 1.5 / w, (h * 3) * 1.5 / h)));
    const pinned = rig({ zoom: 2.9 });
    expect(pinned.r.zoom).toBe(2);
  });

  it('centres the room in a bigger canvas on whole pixels', () => {
    const t = rig({ view: { width: 2000, height: 1500, dpr: 1 } });
    t.frame(0);
    const layerBlit = t.canvas.ops.find((o) => o.op === 'blit')!;
    expect(layerBlit.op === 'blit' && Number.isInteger(layerBlit.dx) && Number.isInteger(layerBlit.dy)).toBe(true);
    expect(layerBlit.op === 'blit' && layerBlit.dx).toBeGreaterThanOrEqual(0);
    expect(layerBlit.op === 'blit' && layerBlit.dy).toBeGreaterThanOrEqual(0);
  });

  it('rebuilds the layer, and recolours everything, when the theme changes', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    t.frame(0);
    expect(t.canvas.ops.find((o) => o.op === 'fill')).toMatchObject({ color: PALETTES.phosphor.base.bgDeep });
    const made = t.surfaces.length;
    t.theme.set('neon');
    expect(t.r.needsFrame()).toBe(true);
    t.frame(16);
    expect(t.surfaces.length).toBeGreaterThan(made);
    expect(t.canvas.ops.find((o) => o.op === 'fill')).toMatchObject({ color: PALETTES.neon.base.bgDeep });
  });

  it('resizing re-lays the room without moving anyone in tile space', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    t.frame(0);
    const was = t.r.inspect('w1')!;
    t.r.resize(3000, 2000, 2);
    t.frame(16);
    const now = t.r.inspect('w1')!;
    expect([now.gx, now.gy, now.station]).toEqual([was.gx, was.gy, was.station]);
  });
});

// ---------- anchors for the overlays ----------

describe('bubble anchors', () => {
  it('exposes where a character is on screen in CSS pixels, above its head, following it as it walks', () => {
    const t = rig({ view: { width: 1900, height: 1100, dpr: 2 } });
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    t.frame(1000);
    const a = t.r.anchorOf('w1')!;
    const feet = t.r.inspect('w1')!;
    // CSS px = device px / dpr; the anchor is above the feet
    const feetCss = { x: (t.canvas.width / 2 - (t.layout.width * t.r.zoom) / 2 + feet.x * t.r.zoom) / 2, y: 0 };
    expect(Math.abs(a.x - feetCss.x)).toBeLessThan(1.5);
    expect(a.y).toBeGreaterThan(0);
    expect(a.visible).toBe(true);
    t.r.moveAgent('w1', 'lab');
    t.frame(1016);
    t.frame(1500);
    const b = t.r.anchorOf('w1')!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1);
    expect(Object.keys(t.r.anchors())).toEqual(['w1']);
    const room = t.r.anchorOf('lab')!;
    expect(room.x).toBeGreaterThan(0);
    expect(t.r.anchorOf('crate:nope')).toBeNull();
    expect(t.r.anchorOf('nobody')).toBeNull();
  });

  it('marks an anchor outside the canvas as not visible', () => {
    const t = rig({ view: { width: 200, height: 100, dpr: 1 } });
    t.r.spawnAgent('w1', 'worker', 'entrance');
    t.frame(0);
    expect(t.r.anchorOf('w1')!.visible).toBe(false);
  });
});

// ---------- frame time ----------

describe('#fps frame-time hook', () => {
  it('reports frame cost from the injected clock and the interval between frames', () => {
    let tick = 0;
    const seen: Array<ReturnType<CanvasRenderer['stats']>> = [];
    const t = rig({ clock: () => (tick += 5), onFrame: (s) => seen.push(s) });
    for (const now of [0, 20, 40, 60]) t.frame(now);
    expect(seen).toHaveLength(4);
    const last = seen[3]!;
    expect(last.frames).toBe(4);
    expect(last.frameMs).toBe(5);
    expect(last.avgMs).toBe(5);
    expect(last.intervalMs).toBe(20);
    expect(last.fps).toBeCloseTo(50);
    expect(last.drawn).toBeGreaterThan(0);
    expect(t.r.stats()).toEqual(last);
  });

  it('costs nothing when nobody listens', () => {
    const t = rig();
    expect(() => t.frame(0)).not.toThrow();
    expect(t.r.stats().frames).toBe(1);
  });
});

// ---------- extension point ----------

describe('extra drawables (pets, cables)', () => {
  it('draws extras sorted with the characters, and stops when removed', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'lab');
    const feet = () => t.r.inspect('w1')!.gx + t.r.inspect('w1')!.gy;
    const order: string[] = [];
    const off = t.r.addDrawable({ id: 'pet', depth: () => feet() - 1, draw: () => order.push('pet-behind') });
    t.r.addDrawable({ id: 'cable', depth: () => feet() + 1, draw: () => order.push('cable-front') });
    t.frame(0);
    expect(order).toEqual(['pet-behind', 'cable-front']);
    expect(t.r.needsFrame()).toBe(true);
    off();
    order.length = 0;
    t.frame(16);
    expect(order).toEqual(['cable-front']);
  });

  it('gives extras the integer zoom and a tile-to-device mapping', () => {
    const t = rig({ view: { width: 1900, height: 1100, dpr: 2 } });
    let seen: { zoom: number; at: { x: number; y: number } } | null = null;
    t.r.addDrawable({ id: 'p', depth: () => 0, draw: (v) => (seen = { zoom: v.zoom, at: v.toDevice(3, 4) }) });
    t.frame(0);
    expect(seen!.zoom).toBe(t.r.zoom);
    const s = t.layout.toScreen(3, 4);
    expect(seen!.at.x).toBeGreaterThan(s.x * t.r.zoom - 1);
  });
});

// ---------- dispose ----------

describe('dispose', () => {
  it('releases the sprite cache, the theme subscription, the layer and every character, and draws nothing after', () => {
    const t = rig({ sprites: undefined });
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab')], {} as GarageState['stations']));
    t.r.applyIntent({ type: 'stamp', kind: 'passed', at: 'lab', task: null });
    t.frame(0);
    // the rig's own tagging cache listens too; the renderer's own makes two
    expect(t.subs.count).toBe(2);
    const layer = t.surfaces.find((s) => s.width === Math.round(t.r.layout.width * t.r.zoom))!;
    t.r.dispose();
    expect(t.subs.count).toBe(1);
    expect(layer.width).toBe(0);
    expect(t.r.inspect('w1')).toBeNull();
    expect(t.r.anchors()).toEqual({});
    expect(t.r.needsFrame()).toBe(false);
    t.canvas.ops.length = 0;
    t.r.frame(100);
    t.r.spawnAgent('w2', 'worker', 'lab');
    t.r.moveAgent('w2', 'bench');
    t.r.syncState(stateOf([ch('w2', 'worker', 'lab')]));
    t.r.resize(10, 10);
    t.r.updateStation('lab', 'failed');
    t.r.applyIntent({ type: 'stamp', kind: 'passed', at: 'lab', task: null });
    t.r.frame(200);
    expect(t.canvas.ops).toEqual([]);
    expect(t.r.inspect('w2')).toBeNull();
    // idempotent
    expect(() => t.r.dispose()).not.toThrow();
    // a later theme change reaches nobody
    t.theme.set('neon');
    expect(t.canvas.ops).toEqual([]);
  });

  it('leaves a shared sprite cache alone but stops listening to it', () => {
    const t = rig();
    let listeners = 0;
    const shared: SpriteCache = {
      ...t.cache,
      onInvalidate(fn) {
        listeners++;
        const off = t.cache.onInvalidate(fn);
        return () => {
          listeners--;
          off();
        };
      },
    };
    const disposeSpy = vi.spyOn(shared, 'dispose');
    const u = rig({ sprites: shared });
    expect(listeners).toBe(1);
    u.r.dispose();
    expect(listeners).toBe(0);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('sets no timers and no animation frames over a whole life', () => {
    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval'), vi.spyOn(globalThis, 'queueMicrotask')];
    const t = rig();
    t.r.syncState(stateOf([ch('w1', 'worker', 'bay:A')]));
    t.r.syncState(stateOf([ch('w1', 'worker', 'lab')]));
    run(t, 'w1', 0, 3000);
    t.r.dispose();
    for (const s of timers) expect(s).not.toHaveBeenCalled();
  });
});

// ---------- source rules ----------

describe('source rules', () => {
  const raw = readFileSync(new URL('../packages/garage/src/renderer.ts', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('has no colour literals: every colour comes from the palette', () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(rgb|rgba|hsl|hsla)\s*\(/);
  });
  it('imports only relative .js modules, no node: and no DOM globals', () => {
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1]!.startsWith('./') && m[1]!.endsWith('.js'), m[1]).toBe(true);
    expect(src).not.toMatch(/\bnode:/);
    expect(src).not.toMatch(/\b(document|window|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|Math\.random)\b/);
  });
  it('draws every colour it fills with from the palette, never a literal', () => {
    const t = rig();
    t.r.spawnAgent('w1', 'worker', 'bay:A');
    t.r.playAnimation('w1', 'awaitingHuman');
    t.r.updateStation('bench', 'failed');
    t.r.applyIntent({ type: 'celebrate', scope: 'run', task: null });
    for (const now of [0, 450, 600, 900]) t.frame(now);
    const allowed = new Set<string>([...Object.values(PALETTES.phosphor.base), ...PALETTES.phosphor.aurora]);
    for (const o of t.canvas.ops) if (o.op === 'fill') expect(allowed.has(o.color), o.color).toBe(true);
  });
});
