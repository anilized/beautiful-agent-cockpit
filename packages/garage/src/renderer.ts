// The Canvas2D GarageRenderer: draws the room from layout.ts, the sprites from sprites.ts and walks characters along
// path.ts routes. No DOM, no node, no timers of its own: the canvas, the surface factory and the clock are injected, and
// nothing happens until the owner calls `frame(now)`.
//
// Layers: the static room (floor, back and left walls, the board) is drawn once into one offscreen layer and blitted per
// frame. Everything else (furniture, chairs, characters, extra drawables) is a sprite, sorted by iso depth each frame,
// so a lamp changing colour is just another sprite. Stamps, confetti and the mood pips are drawn on top.
//
// Zoom is an integer number of device pixels per art pixel (devicePixelRatio aware); sprites are blitted nearest-neighbour.
// Layout pixels are two art pixels wide (layout.TILE_W / sprites.TILE_W), so sprites are blitted at `ART * zoom`.
//
// Characters never teleport: every change of place is a walk along the walk grid, or an eased hop when the walk is long.
// `syncState` diffs the logical state a reconcile rebase produced against what is on screen and animates the difference.
import type {
  AnimationName, CharacterId, CharacterKind, CharacterStateName, GarageRenderer, GarageState, SceneIntent, StampKind,
  StationId, StationKind, StationStateName, TaskKey,
} from './model.js';
import { layoutFromState, TILE_W as LAYOUT_TILE_W, type Layout, type LayoutSpec } from './layout.js';
import { DEFAULT_HOP_TILES, planWalk, type Point } from './path.js';
import { theme as sharedTheme, type GaragePalette, type ThemeSource } from './palette.js';
import {
  characterParts, createSpriteCache, defaultCanvasFactory, drawSprite, fitZoom, TILE_W as ART_TILE_W,
  type BlitCtx, type PixelCtx, type Pose, type PropKind, type Sprite, type SpriteCache, type SpriteSurface,
} from './sprites.js';

// ---------- injected canvas ----------

/** The part of a 2D context the renderer draws with. A real CanvasRenderingContext2D satisfies it. */
export interface RenderCtx extends BlitCtx, PixelCtx {
  globalAlpha: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** A canvas element, or an OffscreenCanvas. `style` is set only when present. */
export interface RenderSurface extends SpriteSurface {
  style?: { width: string; height: string };
  getContext(id: '2d'): RenderCtx | null;
}

/** Makes the offscreen surfaces (the room layer and the sprites). Defaults to an OffscreenCanvas, else a canvas element. */
export interface SurfaceFactory {
  create(width: number, height: number): RenderSurface;
}

export interface FrameStats {
  frames: number;
  /** CPU time of the last `frame()` on the injected clock, ms. */
  frameMs: number;
  /** Mean of the last frames' CPU time, ms. */
  avgMs: number;
  /** Mean time between the last frames' `now`, ms, and the frame rate it implies. */
  intervalMs: number;
  fps: number;
  /** Sprites blitted in the last frame. */
  drawn: number;
}

export interface Anchor {
  /** CSS pixels from the canvas's top-left corner: feed it to `transform: translate(x, y)`. */
  x: number;
  y: number;
  /** Inside the canvas. */
  visible: boolean;
}

/** What an extra sprite (a pet, a cable end, a prop for an `ext:*` station) is given to draw itself. */
export interface DrawView {
  ctx: RenderCtx;
  sprites: SpriteCache;
  palette: GaragePalette;
  layout: Layout;
  /** Device pixels per art pixel (an integer). */
  zoom: number;
  now: number;
  /** A tile position (fractional is fine) to a device pixel. */
  toDevice(gx: number, gy: number, elevation?: number): { x: number; y: number };
  /** Blit a sprite with its origin at a tile position, at the right integer scale. */
  blit(sprite: Sprite, gx: number, gy: number, elevation?: number): void;
}

/** The extension point for pets and the like: sorted with the characters by `depth`, drawn by `draw`. */
export interface ExtraDrawable {
  id: string;
  /** gx + gy of where it stands; ties draw after furniture and before nothing else. */
  depth(now: number): number;
  draw(view: DrawView): void;
}

export interface RendererOptions {
  canvas: RenderSurface;
  /** The first layout; `syncState` replaces it when the state calls for a different one. Default: an empty room. */
  layout?: Layout;
  /** How a state becomes a layout. Default `layoutFromState` with `extras`. */
  layoutFor?: (state: GarageState) => Layout;
  extras?: Pick<LayoutSpec, 'chair' | 'head' | 'extensions'>;
  surfaces?: SurfaceFactory;
  /** Share a cache (it must use the same theme); otherwise the renderer makes and disposes its own. */
  sprites?: SpriteCache;
  theme?: ThemeSource;
  /** Monotonic ms for frame timing. Default `performance.now`, else `Date.now`. */
  clock?: () => number;
  /** Walks longer than this many tiles become hops. */
  hopTiles?: number;
  /** Called after every frame with the frame-time numbers (the `#fps` hash flag). */
  onFrame?: (stats: FrameStats) => void;
  /** Viewport in CSS pixels and device pixel ratio; default is the canvas's own size at ratio 1. */
  view?: { width: number; height: number; dpr?: number };
  /** Pin the zoom instead of fitting the room (still a whole number >= 1). */
  zoom?: number;
}

export interface AgentView {
  id: CharacterId;
  kind: CharacterKind;
  /** Where it is, or is walking to. */
  station: StationId;
  gx: number;
  gy: number;
  /** Raised floors (the loft), in layout pixels. */
  elevation: number;
  /** Layout pixels at zoom 1 (feet), hop lift and any settling offset included. */
  x: number;
  y: number;
  /** The same point on the canvas, in device pixels. */
  device: { x: number; y: number };
  moving: boolean;
  hopping: boolean;
  facing: 'left' | 'right';
  pose: Pose;
  alpha: number;
  anim: AnimationName;
  leaving: boolean;
  /** 3D only: what they do while not working (on the phone, perched on the desk, at the foosball table ...). */
  act?: string | null;
}

export interface CanvasRenderer extends GarageRenderer {
  /** `look` carries what the intent does not: the worker's specialty (shirt colour) and its task. */
  spawnAgent(id: CharacterId, kind: CharacterKind, at: StationId, look?: { specialty?: string | null; task?: TaskKey | null }): void;
  /** Diff a logical state against the screen and animate the differences (spawns, walks, poses, lamps). */
  syncState(state: GarageState): void;
  /** Apply what the mapper emitted; bubbles are the overlays' business and are ignored here. */
  applyIntent(intent: SceneIntent): void;
  setLayout(layout: Layout): void;
  readonly layout: Layout;
  /** Viewport change; sizes the canvas in device pixels and picks the integer zoom. */
  resize(cssWidth: number, cssHeight: number, dpr?: number): void;
  readonly zoom: number;
  anchorOf(id: CharacterId | StationId): Anchor | null;
  anchors(): Record<CharacterId, Anchor>;
  inspect(id: CharacterId): AgentView | null;
  /** True while something would look different at a later `now` (a walk, a blink, a stamp); else only `dirty` redraws matter. */
  needsFrame(): boolean;
  readonly dirty: boolean;
  stats(): FrameStats;
  addDrawable(d: ExtraDrawable): () => void;
}

// ---------- constants ----------

/** Layout pixels per art pixel. */
const ART = LAYOUT_TILE_W / ART_TILE_W;
/** Room above the layout for tall things (the back wall, characters in the loft, stamps), in layout pixels. */
export const ROOM_PAD_TOP = 32;
const PAD_TOP = ROOM_PAD_TOP;
export const WALK_TILES_PER_SEC = 4;
export const MIN_MOVE_MS = 160;
export const HOP_MIN_MS = 500;
export const HOP_PER_TILE_MS = 8;
export const HOP_MAX_MS = 900;
/** Peak height of a hop, in layout pixels. */
const HOP_LIFT = 24;
export const SPAWN_FADE_MS = 350;
/** How long a displaced character takes to settle onto its new trajectory (a layout change, a mid-hop order). */
export const SLIP_MS = 400;
export const STAMP_MS = 2600;
export const CELEBRATE_MS = 2400;
const MAX_STAMPS = 32;
const CONFETTI_PER_AGENT = 8;
const CONFETTI_MS = 1600;
const STEP_MS = 140;
const TYPE_MS = 180;
const BLINK_MS = 450;

/** Where the 2nd, 3rd ... character at one station stands (tile units from the stand tile); the 1st stands on it. */
const SLOT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.35, 0], [-0.35, 0], [0, 0.35],
];

const SEAT_KINDS: ReadonlySet<StationKind> = new Set<StationKind>(['loft', 'desk', 'bay']);

type PropMode = 'each' | 'center';
/** How a station kind is furnished: which prop, and whether one per footprint tile or one at its centre. */
const FURNITURE: Partial<Record<StationKind, { prop: PropKind; mode: PropMode }>> = {
  loft: { prop: 'loft', mode: 'center' },
  desk: { prop: 'desk', mode: 'each' },
  bay: { prop: 'bay', mode: 'center' },
  crate: { prop: 'crate', mode: 'each' },
  lab: { prop: 'lab', mode: 'center' },
  bench: { prop: 'bench', mode: 'center' },
  terminal: { prop: 'terminal', mode: 'center' },
  outbox: { prop: 'outbox', mode: 'center' },
  entrance: { prop: 'entrance', mode: 'center' },
};

// ---------- small pure helpers ----------

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);
const easeInOutSine = (u: number): number => -(Math.cos(Math.PI * clamp01(u)) - 1) / 2;
const easeOut = (u: number): number => 1 - (1 - clamp01(u)) * (1 - clamp01(u));
const beat = (now: number, ms: number): boolean => Math.floor(now / ms) % 2 === 1;
const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const fnv = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

/** True for a location hash that asks for the frame-time readout: `#fps`, `#fps=1`, `#run=x&fps`. */
export function wantsFps(hash: string): boolean {
  return /(^|[#&])fps(=(1|true))?(&|$)/.test(hash);
}

/** A worker persona (`backend-dev`) to the specialty that colours its shirt (`backend`). */
export function specialtyOf(persona: string | null | undefined): string | null {
  if (!persona) return null;
  const head = persona.split('-')[0];
  return head ? head : null;
}

export interface PoseInput {
  anim: AnimationName;
  /** Sitting at a loft, desk or bay. */
  seated: boolean;
  walking: boolean;
  hopping: boolean;
  celebrating: boolean;
}

/** The pose a character strikes: a function of what it is doing and the time, nothing else. */
export function poseFor(a: PoseInput, now: number): Pose {
  if (a.hopping) return 'stand';
  if (a.walking) return beat(now, STEP_MS) ? 'walkA' : 'walkB';
  if (a.celebrating || a.anim === 'celebrate') return beat(now, 220) ? 'cheer' : 'stand';
  switch (a.anim) {
    case 'failed':
    case 'blocked':
      return 'slump';
    case 'implementing':
      return a.seated ? (beat(now, TYPE_MS) ? 'workA' : 'workB') : 'stand';
    case 'review':
    case 'researching':
    case 'thinking':
    case 'waiting':
    case 'idle':
      return a.seated ? 'sit' : 'stand';
    default:
      return 'stand';
  }
}

/** How a station is shown at `now`: a blinking `alert` alternates with idle; a jammed bench shakes. */
export function stationLook(id: StationId, state: StationStateName, now: number): { state: StationStateName; dx: number } {
  if (state === 'alert') return { state: beat(now, BLINK_MS) ? 'alert' : 'idle', dx: 0 };
  if (state === 'failed' && id === 'bench') return { state: 'failed', dx: Math.floor(now / 60) % 2 ? 1 : -1 };
  return { state, dx: 0 };
}

// ---------- agents ----------

interface Waypoint {
  gx: number;
  gy: number;
  elev: number;
}

interface Motion {
  pts: Waypoint[];
  /** Cumulative length at each point, in tiles. */
  cum: number[];
  length: number;
  duration: number;
  /** Set by the first frame after the move was asked for, so the clock that calls `frame` is the only clock. */
  t0: number | null;
  hop: boolean;
}

interface Agent {
  id: CharacterId;
  kind: CharacterKind;
  specialty: string | null;
  task: TaskKey | null;
  at: StationId;
  slot: number;
  pos: Waypoint;
  lift: number;
  /**
   * A screen-space offset (layout pixels) that eases to zero: what keeps the picture continuous when the trajectory
   * underneath changes (the room was re-laid, or a new order arrived mid-hop). `slipK` is its current weight, 1 to 0.
   */
  slip: { x: number; y: number; t0: number | null } | null;
  slipK: number;
  facing: 'left' | 'right';
  anim: AnimationName;
  celebrate: { t0: number | null } | null;
  motion: Motion | null;
  born: number | null;
  alpha: number;
  leaving: boolean;
  fadeOut: { t0: number | null } | null;
  pose: Pose;
}

interface Stamp {
  kind: StampKind;
  at: StationId;
  t0: number | null;
}

interface Item {
  key: number;
  /** 0 furniture, 1 characters and extras at the same depth. */
  tie: number;
  id: string;
  draw: () => void;
}

const defaultSurfaces = (): SurfaceFactory => {
  const inner = defaultCanvasFactory();
  return { create: (w, h) => inner.create(w, h) as RenderSurface };
};

const defaultClock = (): number => {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
};

// ---------- the renderer ----------

class Renderer implements CanvasRenderer {
  layout: Layout;
  zoom = 1;
  dirty = true;

  private readonly canvas: RenderSurface;
  private readonly surfaces: SurfaceFactory;
  private readonly sprites: SpriteCache;
  private readonly ownSprites: boolean;
  private readonly theme: ThemeSource;
  private readonly clock: () => number;
  private readonly layoutFor: (state: GarageState) => Layout;
  private readonly onFrame: ((s: FrameStats) => void) | undefined;
  private hopTiles: number;
  private pinnedZoom: number | null;

  private agents = new Map<CharacterId, Agent>();
  private stationStates = new Map<StationId, StationStateName>();
  private stamps: Stamp[] = [];
  private extras = new Map<string, ExtraDrawable>();
  private layer: RenderSurface | null = null;
  private layerKey = '';
  private layerEpoch = 0;
  private unsubscribe: (() => void) | null;
  private ctx: RenderCtx | null = null;
  private viewCss = { w: 0, h: 0, dpr: 1 };
  private off = { x: 0, y: 0 };
  private synced = false;
  private disposed = false;

  private frames = 0;
  private costs: number[] = [];
  private intervals: number[] = [];
  private lastNow: number | null = null;
  private last: FrameStats = { frames: 0, frameMs: 0, avgMs: 0, intervalMs: 0, fps: 0, drawn: 0 };

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas;
    this.surfaces = opts.surfaces ?? defaultSurfaces();
    this.theme = opts.theme ?? sharedTheme;
    this.clock = opts.clock ?? defaultClock;
    this.hopTiles = opts.hopTiles ?? DEFAULT_HOP_TILES;
    this.onFrame = opts.onFrame;
    this.pinnedZoom = opts.zoom === undefined ? null : Math.max(1, Math.floor(opts.zoom));
    const extras = opts.extras;
    this.layoutFor = opts.layoutFor ?? ((s) => layoutFromState(s, extras));
    this.ownSprites = !opts.sprites;
    this.sprites = opts.sprites ?? createSpriteCache({ canvas: this.surfaces, theme: this.theme });
    this.layout = opts.layout ?? layoutFromState(emptyState());
    // A theme change drops the sprites, and the room layer is made of sprites.
    this.unsubscribe = this.sprites.onInvalidate(() => {
      this.layerEpoch++;
      this.dirty = true;
    });
    const v = opts.view ?? { width: this.canvas.width, height: this.canvas.height, dpr: 1 };
    this.resize(v.width, v.height, v.dpr ?? 1);
  }

  // ----- GarageRenderer -----

  spawnAgent(id: CharacterId, kind: CharacterKind, at: StationId, look?: { specialty?: string | null; task?: TaskKey | null }): void {
    if (this.disposed) return;
    const known = this.agents.get(id);
    if (known) {
      known.kind = kind;
      if (look?.specialty !== undefined) known.specialty = look.specialty;
      if (look?.task !== undefined) known.task = look.task;
      if (known.leaving) this.unretire(known);
      this.dirty = true;
      return;
    }
    const station: StationId = this.layout.resolve(at) ? at : 'entrance';
    const slot = this.freeSlot(station, id);
    const t = this.targetFor(station, slot);
    const wp: Waypoint = t ? { ...t.wp } : { gx: 0, gy: 0, elev: 0 };
    this.agents.set(id, {
      id, kind, specialty: look?.specialty ?? null, task: look?.task ?? null, at: station, slot, pos: wp, lift: 0, slip: null, slipK: 0,
      facing: 'right', anim: 'idle', celebrate: null, motion: null, born: null, alpha: 0, leaving: false, fadeOut: null,
      pose: 'stand',
    });
    this.dirty = true;
  }

  moveAgent(id: CharacterId, to: StationId): void {
    const a = this.agents.get(id);
    if (this.disposed || !a) return;
    if (!this.layout.resolve(to)) return;
    if (a.leaving) this.unretire(a);
    a.at = to;
    a.slot = this.freeSlot(to, id);
    this.reroute(a);
    this.dirty = true;
  }

  playAnimation(id: CharacterId, animation: AnimationName): void {
    const a = this.agents.get(id);
    if (this.disposed || !a) return;
    if (animation === 'celebrate') a.celebrate = { t0: null };
    else a.anim = animation;
    this.dirty = true;
  }

  updateStation(id: StationId, state: StationStateName): void {
    if (this.disposed) return;
    if (this.stationStates.get(id) === state) return;
    this.stationStates.set(id, state);
    this.dirty = true;
  }

  frame(now: number): void {
    if (this.disposed || !Number.isFinite(now)) return;
    const ctx = (this.ctx ??= this.canvas.getContext('2d'));
    if (!ctx) return;
    const started = this.clock();
    this.advance(now);
    this.ensureLayer();

    const pal = this.theme.palette();
    const z = this.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pal.base.bgDeep;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    let drawn = 0;
    if (this.layer) {
      ctx.drawImage(this.layer, 0, 0, this.layer.width, this.layer.height, this.off.x, this.off.y, this.layer.width, this.layer.height);
      drawn++;
    }

    const items = this.collect(ctx, pal, now);
    items.sort((a, b) => a.key - b.key || a.tie - b.tie || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of items) it.draw();
    drawn += items.length;

    this.drawConfetti(ctx, pal, now);
    this.drawStamps(ctx, now);
    for (const a of this.agents.values()) this.drawPip(ctx, pal, a, now);
    ctx.globalAlpha = 1;

    this.dirty = false;
    this.record(now, this.clock() - started, drawn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.ownSprites) this.sprites.dispose();
    this.agents.clear();
    this.stationStates.clear();
    this.stamps = [];
    this.extras.clear();
    if (this.layer) this.layer.width = 0;
    this.layer = null;
    this.ctx = null;
    this.costs = [];
    this.intervals = [];
    this.dirty = false;
  }

  // ----- the diff -----

  syncState(state: GarageState): void {
    if (this.disposed) return;
    const next = this.layoutFor(state);
    if (JSON.stringify(next.spec) !== JSON.stringify(this.layout.spec)) this.setLayout(next);

    const first = !this.synced;
    this.synced = true;
    for (const c of Object.values(state.characters)) {
      const look = { specialty: specialtyOf(c.persona), task: c.task };
      const known = this.agents.get(c.id);
      if (!known) {
        // The first state places everyone where they are; later arrivals walk in through the entrance.
        this.spawnAgent(c.id, c.kind, first ? c.station : 'entrance', look);
        if (!first && c.station !== 'entrance') this.moveAgent(c.id, c.station);
      } else {
        this.spawnAgent(c.id, c.kind, known.at, look);
        if (known.at !== c.station) this.moveAgent(c.id, c.station);
      }
      const a = this.agents.get(c.id)!;
      // Reconcile against what is playing now, not what the last sync said: an intent may have changed it since.
      if (a.anim !== c.state) this.playAnimation(c.id, c.state);
    }
    for (const a of this.agents.values()) if (!state.characters[a.id] && !a.leaving) this.retire(a);

    for (const [id, st] of Object.entries(state.stations) as Array<[StationId, { state: StationStateName }]>) this.updateStation(id, st.state);
    for (const id of [...this.stationStates.keys()]) if (!state.stations[id]) this.updateStation(id, 'idle');
  }

  applyIntent(intent: SceneIntent): void {
    switch (intent.type) {
      case 'spawn': this.spawnAgent(intent.character, intent.kind, intent.at); break;
      case 'move': this.moveAgent(intent.character, intent.to); break;
      case 'animate': this.playAnimation(intent.character, intent.animation); break;
      case 'station': this.updateStation(intent.id, intent.state); break;
      case 'stamp': this.stamp(intent.kind, intent.at); break;
      case 'celebrate':
        for (const a of this.agents.values()) if (intent.scope === 'run' || (intent.task !== null && a.task === intent.task)) this.playAnimation(a.id, 'celebrate');
        break;
      case 'bubble': break; // an overlay concern: bubbles anchor to `anchorOf`
    }
  }

  setLayout(layout: Layout): void {
    if (this.disposed) return;
    // Where everyone is drawn now, on the canvas; the new projection must not move them.
    const drawn = new Map<CharacterId, { x: number; y: number }>();
    for (const a of this.agents.values()) {
      const s = this.screenOf(a);
      drawn.set(a.id, this.dev(s.x, s.y));
    }
    this.layout = layout;
    this.layerKey = '';
    this.fit();
    // The furniture moved: everyone keeps their drawn spot, settles onto the new projection, and walks to where
    // their station is now, from where they stand.
    for (const a of this.agents.values()) {
      const was = drawn.get(a.id)!;
      const s = this.layout.toScreen(a.pos.gx, a.pos.gy, a.pos.elev);
      const now = this.dev(s.x, s.y);
      a.lift = 0;
      a.slip = { x: (was.x - now.x) / this.zoom, y: (was.y - now.y) / this.zoom, t0: null };
      a.slipK = 1;
      this.reroute(a);
    }
    this.dirty = true;
  }

  // ----- viewport -----

  resize(cssWidth: number, cssHeight: number, dpr = 1): void {
    if (this.disposed) return;
    const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.viewCss = { w: Math.max(1, cssWidth), h: Math.max(1, cssHeight), dpr: ratio };
    // Resizing a canvas resets its context state, which is why `frame` sets everything it needs.
    this.canvas.width = Math.max(1, Math.round(this.viewCss.w * ratio));
    this.canvas.height = Math.max(1, Math.round(this.viewCss.h * ratio));
    if (this.canvas.style) {
      this.canvas.style.width = `${this.viewCss.w}px`;
      this.canvas.style.height = `${this.viewCss.h}px`;
    }
    this.fit();
    this.dirty = true;
  }

  private fit(): void {
    const roomW = this.layout.width;
    const roomH = this.layout.height + PAD_TOP;
    this.zoom = this.pinnedZoom ?? fitZoom(this.canvas.width, this.canvas.height, roomW, roomH);
    this.off = {
      x: Math.max(0, Math.floor((this.canvas.width - roomW * this.zoom) / 2)),
      y: Math.max(0, Math.floor((this.canvas.height - roomH * this.zoom) / 2)),
    };
  }

  // ----- queries -----

  inspect(id: CharacterId): AgentView | null {
    const a = this.agents.get(id);
    if (!a) return null;
    const s = this.screenOf(a);
    return {
      id, kind: a.kind, station: a.at, gx: a.pos.gx, gy: a.pos.gy, elevation: a.pos.elev, x: s.x, y: s.y, device: this.dev(s.x, s.y),
      moving: !!a.motion, hopping: !!a.motion?.hop, facing: a.facing, pose: a.pose, alpha: a.alpha, anim: a.anim, leaving: a.leaving,
    };
  }

  anchorOf(id: CharacterId | StationId): Anchor | null {
    const a = this.agents.get(id);
    if (a) {
      const s = this.screenOf(a);
      const sprite = this.sprites.character({ ...this.partsOf(a), pose: a.pose, facing: a.facing });
      return this.cssAnchor(s.x, s.y - sprite.anchorY * ART);
    }
    const st = this.layout.resolve(id as StationId);
    if (!st) return null;
    return this.cssAnchor(st.screen.x, st.screen.y - 14 * ART);
  }

  anchors(): Record<CharacterId, Anchor> {
    const out: Record<CharacterId, Anchor> = {};
    for (const id of this.agents.keys()) out[id] = this.anchorOf(id)!;
    return out;
  }

  private cssAnchor(lx: number, ly: number): Anchor {
    const { dpr, w, h } = this.viewCss;
    const x = (this.off.x + lx * this.zoom) / dpr;
    const y = (this.off.y + (ly + PAD_TOP) * this.zoom) / dpr;
    return { x, y, visible: x >= 0 && y >= 0 && x <= w && y <= h };
  }

  needsFrame(): boolean {
    if (this.disposed) return false;
    if (this.dirty || this.stamps.length > 0 || this.extras.size > 0) return true;
    for (const a of this.agents.values()) {
      if (a.motion || a.celebrate || a.fadeOut || a.leaving || a.slip || a.alpha < 1 || a.anim === 'implementing' || a.anim === 'awaitingHuman') return true;
    }
    for (const [id, st] of this.stationStates) if (st === 'alert' || (st === 'failed' && id === 'bench')) return true;
    return false;
  }

  stats(): FrameStats {
    return { ...this.last };
  }

  addDrawable(d: ExtraDrawable): () => void {
    if (this.disposed) return () => {};
    this.extras.set(d.id, d);
    this.dirty = true;
    return () => {
      this.extras.delete(d.id);
      this.dirty = true;
    };
  }

  // ----- movement -----

  private partsOf(a: Agent) {
    return characterParts(a.id, a.kind, a.specialty);
  }

  private freeSlot(at: StationId, self: CharacterId): number {
    const used = new Set<number>();
    for (const o of this.agents.values()) if (o.id !== self && o.at === at) used.add(o.slot);
    let k = 0;
    while (used.has(k)) k++;
    return k;
  }

  /** The tile a character at `at` in `slot` stands on, and the exact spot. The entrance's queue is the layout's queue slots. */
  private targetFor(at: StationId, slot: number): { tile: Point; wp: Waypoint } | null {
    const st = this.layout.resolve(at);
    if (!st) return null;
    let tile = st.grid;
    let ox = 0;
    let oy = 0;
    let elev = st.elevation;
    if (slot > 0) {
      if (at === 'entrance') {
        tile = this.layout.queueSlot(slot - 1);
        elev = 0;
      } else {
        const o = SLOT_OFFSETS[(slot - 1) % SLOT_OFFSETS.length]!;
        ox = o[0];
        oy = o[1];
      }
    }
    return { tile, wp: { gx: tile.gx + ox, gy: tile.gy + oy, elev } };
  }

  /** Where a character is drawn, in layout pixels: its tile, minus any hop lift, plus the settling offset. */
  private screenOf(a: Agent): { x: number; y: number } {
    const s = this.layout.toScreen(a.pos.gx, a.pos.gy, a.pos.elev);
    const k = a.slip ? a.slipK : 0;
    return { x: s.x + (a.slip ? a.slip.x * k : 0), y: s.y - a.lift + (a.slip ? a.slip.y * k : 0) };
  }

  /**
   * Fold the hop lift and the current settling offset into a fresh offset, so that whatever replaces the trajectory
   * starts exactly where the character is drawn now and eases from there.
   */
  private captureSlip(a: Agent): void {
    const k = a.slip ? a.slipK : 0;
    const x = a.slip ? a.slip.x * k : 0;
    const y = (a.slip ? a.slip.y * k : 0) - a.lift;
    a.lift = 0;
    a.slip = Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 ? null : { x, y, t0: null };
    a.slipK = 1;
  }

  /** Walk (or hop) from wherever it stands now to where its station is. Never moves the character itself. */
  private reroute(a: Agent): void {
    const t = this.targetFor(a.at, a.slot);
    if (!t) return;
    this.captureSlip(a);
    const L = this.layout;
    const from = a.pos;
    const start: Point = { gx: clampInt(Math.round(from.gx), 0, L.cols - 1), gy: clampInt(Math.round(from.gy), 0, L.rows - 1) };
    const plan = planWalk(L, start, t.tile, this.hopTiles);

    let pts: Waypoint[];
    let hop = false;
    if (!plan || plan.hop) {
      pts = [{ ...from }, t.wp];
      hop = true;
    } else {
      pts = [{ ...from }];
      for (let i = 1; i < plan.path.length - 1; i++) pts.push({ gx: plan.path[i]!.gx, gy: plan.path[i]!.gy, elev: 0 });
      pts.push(t.wp);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.gx - pts[i - 1]!.gx, pts[i]!.gy - pts[i - 1]!.gy));
    const length = cum[cum.length - 1]!;
    if (length < 1e-6 && Math.abs(from.elev - t.wp.elev) < 1e-6) {
      a.motion = null;
      a.lift = 0;
      return;
    }
    const duration = hop
      ? Math.min(HOP_MAX_MS, HOP_MIN_MS + HOP_PER_TILE_MS * length)
      : Math.max(MIN_MOVE_MS, (length / WALK_TILES_PER_SEC) * 1000);
    a.motion = { pts, cum, length, duration, t0: null, hop };
  }

  private retire(a: Agent): void {
    a.leaving = true;
    a.at = 'entrance';
    a.slot = this.freeSlot('entrance', a.id);
    this.reroute(a);
    this.dirty = true;
  }

  private unretire(a: Agent): void {
    a.leaving = false;
    a.fadeOut = null;
    a.alpha = 1;
  }

  private stamp(kind: StampKind, at: StationId): void {
    if (this.disposed || !this.layout.resolve(at)) return;
    this.stamps.push({ kind, at, t0: null });
    while (this.stamps.length > MAX_STAMPS) this.stamps.shift();
    this.dirty = true;
  }

  // ----- per-frame advance -----

  private advance(now: number): void {
    for (const a of [...this.agents.values()]) {
      const m = a.motion;
      if (m) {
        if (m.t0 === null) m.t0 = now;
        const u = clamp01((now - m.t0) / m.duration);
        const d = m.length * easeInOutSine(u);
        let i = 1;
        while (i < m.pts.length - 1 && m.cum[i]! < d) i++;
        const p = m.pts[i - 1]!;
        const q = m.pts[i]!;
        const span = m.cum[i]! - m.cum[i - 1]!;
        const f = span > 1e-9 ? clamp01((d - m.cum[i - 1]!) / span) : 1;
        const dx = (q.gx - p.gx) - (q.gy - p.gy);
        if (dx > 1e-6) a.facing = 'right';
        else if (dx < -1e-6) a.facing = 'left';
        a.pos = u >= 1 ? { ...m.pts[m.pts.length - 1]! } : { gx: p.gx + (q.gx - p.gx) * f, gy: p.gy + (q.gy - p.gy) * f, elev: p.elev + (q.elev - p.elev) * f };
        a.lift = m.hop && u < 1 ? Math.sin(Math.PI * u) * HOP_LIFT : 0;
        if (u >= 1) a.motion = null;
      }
      if (a.slip) {
        if (a.slip.t0 === null) a.slip.t0 = now;
        const u = clamp01((now - a.slip.t0) / SLIP_MS);
        a.slipK = 1 - easeInOutSine(u);
        if (u >= 1) {
          a.slip = null;
          a.slipK = 0;
        }
      }
      // A character that is leaving fades once it has nowhere left to walk, including when it was already at the door.
      if (a.leaving && !a.motion && !a.fadeOut) a.fadeOut = { t0: null };
      if (a.fadeOut) {
        if (a.fadeOut.t0 === null) a.fadeOut.t0 = now;
        const u = clamp01((now - a.fadeOut.t0) / SPAWN_FADE_MS);
        a.alpha = 1 - u;
        if (u >= 1) {
          this.agents.delete(a.id);
          continue;
        }
      } else {
        if (a.born === null) a.born = now;
        a.alpha = clamp01((now - a.born) / SPAWN_FADE_MS);
      }
      if (a.celebrate) {
        if (a.celebrate.t0 === null) a.celebrate.t0 = now;
        if (now - a.celebrate.t0 >= CELEBRATE_MS) a.celebrate = null;
      }
      const st = this.layout.resolve(a.at);
      a.pose = poseFor(
        { anim: a.anim, seated: !!st && SEAT_KINDS.has(st.kind) && !a.motion, walking: !!a.motion && !a.motion.hop, hopping: !!a.motion?.hop, celebrating: !!a.celebrate },
        now,
      );
    }
    this.stamps = this.stamps.filter((s) => {
      if (s.t0 === null) s.t0 = now;
      return now - s.t0 < STAMP_MS;
    });
  }

  // ----- drawing -----

  /** Device pixel of a layout-space point. */
  private dev(lx: number, ly: number): { x: number; y: number } {
    return { x: this.off.x + lx * this.zoom, y: this.off.y + (ly + PAD_TOP) * this.zoom };
  }

  private blit(ctx: RenderCtx, sprite: Sprite, gx: number, gy: number, elev: number, dxLayout = 0, dyLayout = 0): void {
    const s = this.layout.toScreen(gx, gy, elev);
    const d = this.dev(s.x + dxLayout, s.y + dyLayout);
    drawSprite(ctx, sprite, d.x, d.y, ART * this.zoom);
  }

  private collect(ctx: RenderCtx, pal: GaragePalette, now: number): Item[] {
    const items: Item[] = [];
    const L = this.layout;
    for (const id of L.ids()) {
      const st = L.resolve(id)!;
      const shown = stationLook(id, this.stationStates.get(id) ?? 'idle', now);
      const fur = FURNITURE[st.kind];
      if (SEAT_KINDS.has(st.kind)) {
        items.push({
          key: st.grid.gx + st.grid.gy, tie: 0, id: `chair|${id}`,
          draw: () => this.blit(ctx, this.sprites.prop({ kind: 'chair' }), st.grid.gx, st.grid.gy, st.elevation),
        });
      }
      if (!fur) continue;
      const spots = fur.mode === 'each' && st.footprint.length ? st.footprint : [centreOf(st.footprint, st.grid)];
      spots.forEach((p, i) => {
        items.push({
          key: p.gx + p.gy, tie: 0, id: `prop|${id}|${i}`,
          draw: () => {
            this.blit(ctx, this.sprites.prop({ kind: fur.prop, state: shown.state, variant: i % 2 }), p.gx, p.gy, st.elevation, shown.dx * ART);
            if (shown.dx !== 0) this.drawSmoke(ctx, pal, p.gx, p.gy, st.elevation, now);
          },
        });
      });
    }
    for (const a of this.agents.values()) {
      items.push({
        key: a.pos.gx + a.pos.gy, tie: 1, id: `char|${a.id}`,
        draw: () => {
          ctx.globalAlpha = a.alpha;
          const k = a.slip ? a.slipK : 0;
          this.blit(ctx, this.sprites.character({ ...this.partsOf(a), pose: a.pose, facing: a.facing }), a.pos.gx, a.pos.gy, a.pos.elev, a.slip ? a.slip.x * k : 0, (a.slip ? a.slip.y * k : 0) - a.lift);
          ctx.globalAlpha = 1;
        },
      });
    }
    const view: DrawView = {
      ctx, sprites: this.sprites, palette: pal, layout: L, zoom: this.zoom, now,
      toDevice: (gx, gy, elev = 0) => {
        const s = L.toScreen(gx, gy, elev);
        return this.dev(s.x, s.y);
      },
      blit: (sprite, gx, gy, elev = 0) => this.blit(ctx, sprite, gx, gy, elev),
    };
    for (const e of this.extras.values()) items.push({ key: e.depth(now), tie: 1, id: `extra|${e.id}`, draw: () => e.draw(view) });
    return items;
  }

  /** Wisps over a jammed bench: three squares rising and fading, placed by the clock alone. */
  private drawSmoke(ctx: RenderCtx, pal: GaragePalette, gx: number, gy: number, elev: number, now: number): void {
    const s = this.layout.toScreen(gx, gy, elev);
    const size = ART * this.zoom;
    for (let k = 0; k < 3; k++) {
      const phase = (now / 900 + k / 3) % 1;
      const d = this.dev(s.x + (k - 1) * 6 * ART, s.y - (14 + phase * 14) * ART);
      ctx.globalAlpha = 1 - phase;
      ctx.fillStyle = pal.base.mute;
      ctx.fillRect(Math.round(d.x), Math.round(d.y), size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawStamps(ctx: RenderCtx, now: number): void {
    for (const s of this.stamps) {
      const st = this.layout.resolve(s.at);
      if (!st || s.t0 === null) continue;
      const u = clamp01((now - s.t0) / STAMP_MS);
      const drop = (1 - easeOut(u / 0.15)) * -12;
      const d = this.dev(st.screen.x, st.screen.y - 26 + drop - 6 * u);
      ctx.globalAlpha = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1;
      drawSprite(ctx, this.sprites.stamp(s.kind), d.x, d.y, ART * this.zoom);
    }
    ctx.globalAlpha = 1;
  }

  /** Confetti over a celebrating character: pieces thrown by a hash of its id, so the same celebration looks the same. */
  private drawConfetti(ctx: RenderCtx, pal: GaragePalette, now: number): void {
    const b = pal.base;
    const colors = [b.accent, b.cyan, b.yellow, b.pink, b.violet, b.green];
    const size = ART * this.zoom;
    for (const a of this.agents.values()) {
      if (!a.celebrate || a.celebrate.t0 === null) continue;
      const t = (now - a.celebrate.t0) / 1000;
      if (t < 0 || t * 1000 > CONFETTI_MS) continue;
      const s = this.screenOf(a);
      for (let i = 0; i < CONFETTI_PER_AGENT; i++) {
        const h = fnv(`${a.id}:${i}`);
        const vx = ((h & 255) / 255 - 0.5) * 60;
        const vy = -(40 + ((h >>> 8) & 63));
        const d = this.dev(s.x + vx * t, s.y - 30 + vy * t + 0.5 * 140 * t * t);
        ctx.globalAlpha = 1 - (t * 1000) / CONFETTI_MS;
        ctx.fillStyle = colors[(h >>> 16) % colors.length]!;
        ctx.fillRect(Math.round(d.x), Math.round(d.y), size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A lamp over the head for the states people must notice; colour from the palette, never from prose. */
  private drawPip(ctx: RenderCtx, pal: GaragePalette, a: Agent, now: number): void {
    const b = pal.base;
    const color = a.anim === 'failed' ? b.red : a.anim === 'blocked' ? b.orange : a.anim === 'awaitingHuman' ? b.yellow : a.anim === 'review' ? b.violet : null;
    if (!color || a.alpha <= 0) return;
    if (a.anim === 'awaitingHuman' && !beat(now, BLINK_MS)) return;
    const sprite = this.sprites.character({ ...this.partsOf(a), pose: a.pose, facing: a.facing });
    const s = this.screenOf(a);
    const d = this.dev(s.x - ART, s.y - (sprite.anchorY + 4) * ART);
    const size = ART * this.zoom;
    ctx.globalAlpha = a.alpha;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(d.x), Math.round(d.y), size * 2, size * 2);
    ctx.globalAlpha = 1;
  }

  /** The static room: floor, back and left walls, the board. Rebuilt when the layout, zoom or theme changes. */
  private ensureLayer(): void {
    const L = this.layout;
    const z = this.zoom;
    const key = `${L.cols}x${L.rows}|${z}|${this.layerEpoch}|${this.theme.name()}`;
    if (this.layer && this.layerKey === key) return;
    const w = Math.round(L.width * z);
    const h = Math.round((L.height + PAD_TOP) * z);
    if (this.layer) this.layer.width = 0;
    const surface = this.surfaces.create(w, h);
    const ctx = surface.getContext('2d');
    this.layer = surface;
    this.layerKey = key;
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const put = (kind: PropKind, gx: number, gy: number, variant = 0): void => {
      const s = L.toScreen(gx, gy);
      drawSprite(ctx, this.sprites.prop({ kind, variant }), s.x * z, (s.y + PAD_TOP) * z, ART * z);
    };
    for (let gy = 0; gy < L.rows; gy++) for (let gx = 0; gx < L.cols; gx++) put('tile', gx, gy, (gx + gy) % 2);
    for (let gx = 0; gx < L.cols; gx++) put('wallL', gx, 0);
    for (let gy = 0; gy < L.rows; gy++) put('wallR', 0, gy);
    const board = L.regions.find((r) => r.id === 'board');
    if (board) put('board', board.gx + (board.w - 1) / 2, board.gy + board.h - 1);
  }

  private record(now: number, cost: number, drawn: number): void {
    this.frames++;
    const keep = 60;
    this.costs.push(cost);
    if (this.costs.length > keep) this.costs.shift();
    if (this.lastNow !== null) {
      this.intervals.push(Math.max(0, now - this.lastNow));
      if (this.intervals.length > keep) this.intervals.shift();
    }
    this.lastNow = now;
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const intervalMs = mean(this.intervals);
    this.last = { frames: this.frames, frameMs: cost, avgMs: mean(this.costs), intervalMs, fps: intervalMs > 0 ? 1000 / intervalMs : 0, drawn };
    this.onFrame?.({ ...this.last });
  }
}

/** The tile centre of a footprint (fractional), or `fallback` when there is none. */
function centreOf(footprint: Point[], fallback: Point): Point {
  if (!footprint.length) return fallback;
  let x = 0;
  let y = 0;
  for (const p of footprint) {
    x += p.gx;
    y += p.gy;
  }
  return { gx: x / footprint.length, gy: y / footprint.length };
}

function emptyState(): GarageState {
  return {
    run: { runId: '', lastSeq: 0, phase: '', status: '' },
    characters: {}, sessions: {}, taskIndex: { keyOfId: {}, idOfKey: {}, tasks: {} }, bayOf: {}, crateOf: {},
    stations: {} as GarageState['stations'],
    board: [], outbox: [], approval: null, log: [],
    spend: { total: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byAgent: {} },
    limits: {} as GarageState['limits'],
  };
}

/** Make the Canvas2D renderer. Nothing runs until `frame(now)` is called; `dispose()` releases everything it made. */
export function createRenderer(opts: RendererOptions): CanvasRenderer {
  return new Renderer(opts);
}
