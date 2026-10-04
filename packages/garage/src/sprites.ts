// Code-drawn sprites: characters from parts, props from boxes and decals. No image assets, no colour literals
// (every colour comes from palette.ts).
//
// One 2:1 iso grid: a tile is TILE_W x TILE_H pixels, 8 x 8 world units; screen = (x - y, (x + y) / 2 - z).
// One light direction, from the top left: a box's top is brightest, its left face (+y) mid, its right face (+x) darkest.
// Each sprite is drawn once, 1 pixel per art pixel, onto an offscreen surface and cached by parts + palette; the
// renderer blits it with `drawSprite`, at an integer zoom with smoothing off. A theme change drops the cache.
// The canvas is injected, so tests run in node with a stub.
import type { CharacterKind, StampKind, StationStateName } from './model.js';
import {
  LIGHT, roleColor, shade, theme as sharedTheme,
  type GaragePalette, type SpriteRole, type ThemeSource,
} from './palette.js';

export const TILE_W = 16;
export const TILE_H = 8;
export const UNITS_PER_TILE = 8;

// ---------- canvas access (injectable) ----------

/** The part of a 2D context the sprites are drawn with. Real canvas contexts satisfy it. */
export interface PixelCtx {
  fillStyle: string | object;
  fillRect(x: number, y: number, w: number, h: number): void;
}
/** The part of a 2D context a sprite is blitted with. */
export interface BlitCtx {
  imageSmoothingEnabled: boolean;
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}
/** An OffscreenCanvas or a canvas element. */
export interface SpriteSurface {
  width: number;
  height: number;
  getContext(id: '2d'): PixelCtx | null;
}
export interface CanvasFactory {
  create(width: number, height: number): SpriteSurface;
}

export interface CanvasEnv {
  OffscreenCanvas?: (new (width: number, height: number) => SpriteSurface) | undefined;
  document?: { createElement(tag: 'canvas'): SpriteSurface } | undefined;
}

/** An OffscreenCanvas when the environment has one, else a canvas element. `env` defaults to the global scope. */
export function defaultCanvasFactory(env: CanvasEnv = globalThis as unknown as CanvasEnv): CanvasFactory {
  return {
    create(width, height) {
      if (env.OffscreenCanvas) return new env.OffscreenCanvas(width, height);
      if (env.document) {
        const el = env.document.createElement('canvas');
        el.width = width;
        el.height = height;
        return el;
      }
      throw new Error('no canvas available: need OffscreenCanvas or a document');
    },
  };
}

// ---------- zoom and blitting ----------

/** Zoom is always a whole number >= 1: a fractional zoom would smear the pixels. */
export function integerZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(1, Math.floor(zoom + 1e-9)) : 1;
}

/** The largest integer zoom (1..max) at which `content` still fits `avail`; `max` is itself floored to a whole number >= 1. */
export function fitZoom(availW: number, availH: number, contentW: number, contentH: number, max = 8): number {
  if (!(contentW > 0 && contentH > 0)) return 1;
  const cap = max === Infinity ? Infinity : integerZoom(max);
  return Math.min(cap, integerZoom(Math.min(availW / contentW, availH / contentH)));
}

export interface Sprite {
  surface: SpriteSurface;
  width: number;
  height: number;
  /** The sprite's origin (feet or the footprint centre on the ground), in sprite pixels. */
  anchorX: number;
  anchorY: number;
}

/** Blit with the sprite's origin at (x, y) on the target: whole-pixel position, integer zoom, nearest-neighbour. */
export function drawSprite(ctx: BlitCtx, sprite: Sprite, x: number, y: number, zoom = 1): void {
  const z = integerZoom(zoom);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sprite.surface, 0, 0, sprite.width, sprite.height,
    Math.round(x) - sprite.anchorX * z, Math.round(y) - sprite.anchorY * z, sprite.width * z, sprite.height * z,
  );
}

// ---------- parts ----------

export type Pose = 'stand' | 'walkA' | 'walkB' | 'sit' | 'workA' | 'workB' | 'cheer' | 'slump';
export const POSES: readonly Pose[] = ['stand', 'walkA', 'walkB', 'sit', 'workA', 'workB', 'cheer', 'slump'];
export type HairStyle = 'short' | 'long' | 'bun' | 'cap' | 'bald';
export const HAIR_STYLES: readonly HairStyle[] = ['short', 'long', 'bun', 'cap', 'bald'];

/** What a character is built from. Omitted fields take the defaults shown in `normalizeCharacter`. */
export interface CharacterParts {
  /** The shirt colour: violet (supervisor), cyan (lead), or by specialty (worker). */
  role: SpriteRole;
  specialty?: string | null;
  skin?: number;
  hairStyle?: HairStyle;
  hairColor?: number;
  pose?: Pose;
  facing?: 'right' | 'left';
}
export type NormalCharacter = Required<CharacterParts> & { specialty: string | null };

const wholeIndex = (n: number | undefined) => (Number.isFinite(n) ? Math.abs(Math.trunc(n!)) : 0);

export function normalizeCharacter(parts: CharacterParts): NormalCharacter {
  return {
    role: parts.role,
    specialty: parts.role === 'worker' ? (parts.specialty ?? null) : null,
    skin: wholeIndex(parts.skin),
    hairStyle: parts.hairStyle ?? 'short',
    hairColor: wholeIndex(parts.hairColor),
    pose: parts.pose ?? 'stand',
    facing: parts.facing ?? 'right',
  };
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

/** A stable look for a character id: the same id always gets the same skin, hair and style. */
export function characterParts(id: string, kind: CharacterKind, specialty?: string | null): CharacterParts {
  const h = fnv(id);
  return {
    role: kind === 'council' ? 'supervisor' : kind,
    specialty: kind === 'worker' ? (specialty ?? null) : null,
    skin: h % 5,
    hairStyle: HAIR_STYLES[(h >>> 3) % HAIR_STYLES.length]!,
    hairColor: (h >>> 7) % 6,
  };
}

export type PropKind =
  | 'tile' | 'wallL' | 'wallR' | 'desk' | 'chair' | 'bay' | 'crate' | 'lab' | 'bench' | 'loft' | 'board'
  | 'entrance' | 'outbox' | 'terminal';
export const PROP_KINDS: readonly PropKind[] = [
  'tile', 'wallL', 'wallR', 'desk', 'chair', 'bay', 'crate', 'lab', 'bench', 'loft', 'board', 'entrance', 'outbox', 'terminal',
];
export type StampSprite = `stamp:${StampKind}`;
export const STAMP_KINDS: readonly StampKind[] = ['approved', 'changes', 'passed', 'failed', 'rejected', 'merged'];

export interface PropParts {
  kind: PropKind | StampSprite;
  /** Tints the prop's lamp or screen. Default `idle`. */
  state?: StationStateName;
  /** Tile: checker 0 or 1. Crate: 1 is a stack. Ignored elsewhere. */
  variant?: number;
}
export type NormalProp = Required<PropParts>;

export function normalizeProp(parts: PropParts): NormalProp {
  return { kind: parts.kind, state: parts.state ?? 'idle', variant: wholeIndex(parts.variant) };
}

// ---------- painters ----------

/** Integer pixel rectangles; the one primitive everything is built on. */
interface Painter {
  rect(x: number, y: number, w: number, h: number, color: string): void;
}
type Pt = readonly [number, number];

/** Fill a convex polygon with whole-pixel scanlines: crisp edges, no anti-aliasing. */
function poly(p: Painter, pts: Pt[], color: string): void {
  let lo = Infinity, hi = -Infinity;
  for (const q of pts) {
    lo = Math.min(lo, q[1]);
    hi = Math.max(hi, q[1]);
  }
  for (let y = Math.floor(lo); y < Math.ceil(hi); y++) {
    const yc = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if ((a[1] <= yc && yc < b[1]) || (b[1] <= yc && yc < a[1])) {
        const x = a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        xl = Math.min(xl, x);
        xr = Math.max(xr, x);
      }
    }
    const l = Math.round(xl), r = Math.round(xr);
    if (r > l) p.rect(l, y, r - l, 1, color);
  }
}

const pr = (x: number, y: number, z: number): Pt => [x - y, (x + y) / 2 - z];

/** A box over x0..x0+w, y0..y0+d, z0..z0+h in world units, lit from the top left. */
function box(p: Painter, x0: number, y0: number, z0: number, w: number, d: number, h: number, c: string): void {
  const x1 = x0 + w, y1 = y0 + d, z1 = z0 + h;
  poly(p, [pr(x0, y1, z0), pr(x1, y1, z0), pr(x1, y1, z1), pr(x0, y1, z1)], shade(c, LIGHT.left));
  poly(p, [pr(x1, y0, z0), pr(x1, y1, z0), pr(x1, y1, z1), pr(x1, y0, z1)], shade(c, LIGHT.right));
  poly(p, [pr(x0, y0, z1), pr(x1, y0, z1), pr(x1, y1, z1), pr(x0, y1, z1)], shade(c, LIGHT.top));
}
/** A flat colour on the plane y (the left-facing side), x0..x1 by z0..z1. Pass shaded colours for non-glowing things. */
const faceL = (p: Painter, x0: number, x1: number, y: number, z0: number, z1: number, c: string) =>
  poly(p, [pr(x0, y, z0), pr(x1, y, z0), pr(x1, y, z1), pr(x0, y, z1)], c);
/** The same on the plane x (the right-facing side), y0..y1 by z0..z1. */
const faceR = (p: Painter, x: number, y0: number, y1: number, z0: number, z1: number, c: string) =>
  poly(p, [pr(x, y0, z0), pr(x, y1, z0), pr(x, y1, z1), pr(x, y0, z1)], c);
/** A flat colour on the horizontal plane z. */
const flat = (p: Painter, x0: number, y0: number, x1: number, y1: number, z: number, c: string) =>
  poly(p, [pr(x0, y0, z), pr(x1, y0, z), pr(x1, y1, z), pr(x0, y1, z)], c);

const lit = (pal: GaragePalette, state: StationStateName): string => {
  const b = pal.base;
  return state === 'busy' ? b.cyan : state === 'ok' ? b.green : state === 'failed' ? b.red : state === 'alert' ? b.yellow : b.dim;
};

// ---------- characters ----------

interface PoseShape {
  /** How far the body sits lower than standing. */
  drop: number;
  legs: 'stand' | 'walkA' | 'walkB' | 'apart' | 'sit';
  arms: 'down' | 'swingA' | 'swingB' | 'typeA' | 'typeB' | 'up';
  headDy: number;
}
const POSE_SHAPE: Record<Pose, PoseShape> = {
  stand: { drop: 0, legs: 'stand', arms: 'down', headDy: 0 },
  walkA: { drop: 0, legs: 'walkA', arms: 'swingA', headDy: 0 },
  walkB: { drop: 0, legs: 'walkB', arms: 'swingB', headDy: 0 },
  sit: { drop: 2, legs: 'sit', arms: 'down', headDy: 0 },
  workA: { drop: 2, legs: 'sit', arms: 'typeA', headDy: 0 },
  workB: { drop: 2, legs: 'sit', arms: 'typeB', headDy: 0 },
  cheer: { drop: 0, legs: 'apart', arms: 'up', headDy: 0 },
  slump: { drop: 2, legs: 'sit', arms: 'down', headDy: 1 },
};

/**
 * Origin at the feet, 20 px tall. Facing only mirrors the geometry that points somewhere (legs, swinging, raised and
 * typing arms, the cap brim); `p` draws that. Everything that carries light (torso, head, hair, shadow) is drawn
 * straight to the screen with `out`, so both facings stay lit from the top left.
 */
function drawCharacter(out: Painter, pal: GaragePalette, c: NormalCharacter): void {
  const p: Painter = c.facing === 'left' ? { rect: (x, y, w, h, col) => out.rect(-x - w, y, w, h, col) } : out;
  const b = pal.base, s = pal.scene;
  const shirt = roleColor(pal, c.role, c.specialty);
  const skin = s.skin[c.skin % s.skin.length]!;
  const hair = s.hair[c.hairColor % s.hair.length]!;
  const { drop, legs, arms, headDy } = POSE_SHAPE[c.pose];
  const hd = drop + headDy;

  out.rect(-4, 0, 8, 1, s.shadow);

  // legs and shoes
  const leg = (x: number, h: number) => p.rect(x, -6, 2, h, s.pants);
  if (legs === 'sit') {
    p.rect(-2, -4, 6, 2, s.pants);
    p.rect(3, -2, 2, 1, s.pants);
    p.rect(3, -1, 3, 1, s.shoe);
  } else {
    const [lh, rh] = legs === 'walkA' ? [5, 6] : legs === 'walkB' ? [6, 5] : [6, 6];
    const [lx, rx] = legs === 'apart' ? [-3, 1] : [-2, 0];
    leg(lx, lh);
    leg(rx, rh);
    p.rect(lx, -1 - (6 - lh), 2, 1, s.shoe);
    p.rect(rx, -1 - (6 - rh), 2, 1, s.shoe);
  }

  // torso, lit from the left
  const ty = -12 + drop;
  out.rect(-3, ty, 4, 6, shirt);
  out.rect(1, ty, 2, 6, shade(shirt, LIGHT.right));
  out.rect(-3, ty, 6, 1, shade(shirt, LIGHT.top));
  if (c.role === 'lead') out.rect(-1, ty + 1, 1, 4, b.ink);

  // arms
  const sleeve = (x: number, y: number, h: number) => {
    p.rect(x, y, 1, h, shirt);
    p.rect(x, y + h, 1, 1, skin);
  };
  switch (arms) {
    case 'down': sleeve(-4, ty, 3); sleeve(3, ty, 3); break;
    case 'swingA': sleeve(-4, ty + 1, 3); sleeve(3, ty - 1, 3); break;
    case 'swingB': sleeve(-4, ty - 1, 3); sleeve(3, ty + 1, 3); break;
    case 'up': sleeve(-4, ty - 5, 4); sleeve(3, ty - 5, 4); break;
    case 'typeA':
    case 'typeB': {
      const [ya, yb] = arms === 'typeA' ? [0, 1] : [1, 0];
      p.rect(3, ty + 3 + ya, 3, 1, shirt);
      p.rect(6, ty + 3 + ya, 1, 1, skin);
      p.rect(2, ty + 4 + yb, 3, 1, shade(shirt, LIGHT.right));
      p.rect(5, ty + 4 + yb, 1, 1, skin);
      sleeve(-4, ty, 3);
      break;
    }
  }

  // head, hair, face
  const hy = -18 + hd;
  out.rect(-3, hy, 6, 6, skin);
  out.rect(2, hy + 2, 1, 4, shade(skin, LIGHT.right));
  out.rect(-2, hy + 4, 1, 1, s.shoe);
  out.rect(1, hy + 4, 1, 1, s.shoe);
  switch (c.hairStyle) {
    case 'short': case 'long': case 'bun':
      out.rect(-3, hy, 6, 2, hair);
      out.rect(-3, hy + 2, 1, 1, hair);
      out.rect(2, hy + 2, 1, 1, hair);
      if (c.hairStyle === 'long') {
        out.rect(-3, hy + 2, 1, 5, hair);
        out.rect(2, hy + 2, 1, 5, shade(hair, LIGHT.right));
      }
      if (c.hairStyle === 'bun') out.rect(-1, hy - 2, 2, 2, hair);
      break;
    case 'cap':
      out.rect(-3, hy, 6, 2, shade(shirt, LIGHT.left));
      p.rect(1, hy + 2, 3, 1, shade(shirt, LIGHT.right));
      break;
    case 'bald':
      break;
  }
  if (c.role === 'supervisor') for (const x of [-3, -1, 1]) out.rect(x, hy - 1, 1, 1, b.yellow);
}

// ---------- props ----------

type PropDraw = (p: Painter, pal: GaragePalette, state: StationStateName, variant: number) => void;

function monitor(p: Painter, pal: GaragePalette, x: number, y: number, z: number, w: number, glow: string): void {
  box(p, x + 1, y, z, w - 2, 1, 1, pal.scene.metal);
  box(p, x, y, z + 1, w, 1, 5, pal.scene.metal);
  faceL(p, x + 1, x + w - 1, y + 1, z + 2, z + 5, glow);
}

const PROPS: Record<PropKind, PropDraw> = {
  tile(p, pal, _s, v) {
    flat(p, -4, -4, 4, 4, 0, pal.scene.floorLine);
    flat(p, -3.5, -3.5, 3.5, 3.5, 0, v % 2 ? pal.scene.floorB : pal.scene.floorA);
  },
  wallL(p, pal) {
    box(p, -4, -5, 0, 8, 1, 20, pal.scene.wall);
    box(p, -4, -5, 20, 8, 1, 1, pal.scene.wallTop);
  },
  wallR(p, pal) {
    box(p, -5, -4, 0, 1, 8, 20, pal.scene.wall);
    box(p, -5, -4, 20, 1, 8, 1, pal.scene.wallTop);
  },
  desk(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -6, -4, 0, 12, 8, 6, s.wood);
    monitor(p, pal, -5, -2, 6, 7, lit(pal, state));
    flat(p, 2, 0, 5, 3, 6, shade(b.text, LIGHT.top));
    flat(p, -3, 1.5, 1, 3.5, 6, shade(s.metal, LIGHT.top));
  },
  chair(p, pal) {
    const t = pal.base.teal;
    box(p, -1, -1, 0, 2, 2, 3, pal.scene.metal);
    box(p, -3, -3, 3, 6, 6, 1, t);
    box(p, -3, -3, 4, 1, 6, 5, t);
  },
  bay(p, pal, state) {
    const { scene: s, base: b } = pal;
    flat(p, -8, -6, 8, 6, 0, b.chip);
    flat(p, -8, 5, 8, 6, 0, lit(pal, state));
    box(p, -6, -5, 0, 12, 5, 5, s.wood);
    monitor(p, pal, -6, -4, 5, 5, lit(pal, state));
    monitor(p, pal, 0, -4, 5, 5, lit(pal, state));
    flat(p, -2, -1, 3, 1, 5, shade(s.metal, LIGHT.top));
    box(p, 4, -4, 5, 1, 1, 3, s.metal);
  },
  crate(p, pal, state, v) {
    const c = pal.scene.cardboard;
    box(p, -4, -4, 0, 8, 8, 6, c);
    flat(p, -1, -4, 1, 4, 6, shade(c, 0.7));
    faceL(p, -3, 0, 4, 2, 4, shade(pal.base.text, LIGHT.left));
    faceL(p, 1, 3, 4, 2, 4, lit(pal, state));
    if (v % 2) box(p, -3, -3, 6, 6, 6, 4, shade(c, 1.05));
  },
  lab(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -6, -4, 0, 12, 8, 5, b.mute);
    box(p, -5, -3, 5, 5, 4, 5, s.metal);
    faceL(p, -4, -1, 1, 6, 9, lit(pal, state));
    box(p, 2, -2, 5, 3, 3, 4, b.teal);
    flat(p, 2, -2, 5, 1, 9, b.mint);
  },
  bench(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -6, -4, 4, 12, 1, 8, shade(s.wood, 0.8));
    faceL(p, -5, -3, -3, 8, 10, b.orange);
    faceL(p, -2, 0, -3, 8, 11, b.cyan);
    faceL(p, 1, 3, -3, 8, 10, b.yellow);
    box(p, -6, -3, 0, 12, 6, 4, s.wood);
    box(p, 3, -3, 4, 2, 2, 2, s.metal);
    flat(p, -6, 2, 6, 3, 4, lit(pal, state));
  },
  loft(p, pal, state) {
    const { base: b } = pal;
    box(p, -5, -5, 0, 10, 10, 3, b.violetDeep);
    flat(p, -5, -5, 5, 5, 3, shade(b.violet, LIGHT.top));
    flat(p, -4, -4, 4, 4, 3, shade(b.violetDeep, LIGHT.top));
    box(p, -2, -2, 3, 4, 4, 3, b.seatSupervisor);
    box(p, -1, -1, 6, 2, 2, 2, b.lavender);
    faceL(p, -1, 1, 2, 4, 5, lit(pal, state));
  },
  board(p, pal) {
    const { scene: s, base: b } = pal;
    box(p, -7, -1, 0, 1, 1, 6, s.metal);
    box(p, 6, -1, 0, 1, 1, 6, s.metal);
    box(p, -8, -1, 6, 16, 1, 14, s.wood);
    faceL(p, -7, 7, 0, 7, 19, b.chip);
    const cols: [number, string, string[]][] = [[-7, b.accent, [b.text, b.pink]], [-2, b.yellow, [b.cyan]], [3, b.green, [b.text, b.violet, b.cyan]]];
    for (const [x, head, cards] of cols) {
      faceL(p, x, x + 4, 0, 17, 18, head);
      cards.forEach((c, i) => faceL(p, x, x + 4, 0, 14 - i * 3, 16 - i * 3, c));
    }
  },
  entrance(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -5, -1, 0, 10, 1, 18, s.wall);
    faceL(p, -3, 3, 0, 0, 14, b.bgDeep);
    faceL(p, -3, 3, 0, 14, 15, lit(pal, state));
    flat(p, -3, 0, 3, 3, 0, b.chip);
  },
  outbox(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -3, -3, 0, 6, 6, 4, s.metal);
    faceL(p, -2, 2, 3, 2, 3, b.bgDeep);
    flat(p, -2, -2, 2, 2, 4, shade(b.text, LIGHT.top));
    if (state !== 'idle') {
      box(p, 3, -2, 4, 1, 1, 6, s.metal);
      box(p, 3, -1, 8, 1, 3, 2, lit(pal, state));
    }
  },
  terminal(p, pal, state) {
    const { scene: s, base: b } = pal;
    box(p, -3, -3, 0, 6, 6, 6, b.faint);
    faceL(p, -2, 2, 3, 2, 5, b.bgDeep);
    faceL(p, -2, -1, 3, 3, 4, lit(pal, state));
    faceL(p, 0, 1, 3, 2, 3, lit(pal, state));
    flat(p, -2, -3, 2, -1, 6, shade(s.metal, LIGHT.top));
  },
};

// 7 x 7 glyphs for the stamps: X is ink.
const GLYPH: Record<StampKind, string[]> = {
  approved: ['.......', '......X', '.....XX', 'X...XX.', 'XX.XX..', '.XXX...', '..X....'],
  passed: ['.......', '......X', '.....XX', 'X...XX.', 'XX.XX..', '.XXX...', '..X....'],
  changes: ['...X...', '...X...', '...X...', '...X...', '...X...', '.......', '...X...'],
  failed: ['X.....X', '.X...X.', '..X.X..', '...X...', '..X.X..', '.X...X.', 'X.....X'],
  rejected: ['X.....X', '.X...X.', '..X.X..', '...X...', '..X.X..', '.X...X.', 'X.....X'],
  merged: ['X.....X', 'X.....X', '.X...X.', '..X.X..', '...X...', '...X...', '...X...'],
};
type StampLook = { color: (b: GaragePalette['base']) => string; ring: boolean };
const STAMP_LOOK: Record<StampKind, StampLook> = {
  approved: { color: b => b.green, ring: false },
  changes: { color: b => b.yellow, ring: false },
  passed: { color: b => b.green, ring: true },
  failed: { color: b => b.red, ring: true },
  rejected: { color: b => b.red, ring: false },
  merged: { color: b => b.violet, ring: false },
};

/** An 11 x 11 badge standing on its origin (bottom centre); filled or ringed, with a glyph. */
function drawStamp(p: Painter, pal: GaragePalette, kind: StampKind): void {
  const look = STAMP_LOOK[kind];
  const color = look.color(pal.base);
  const plate = (inset: number, c: string) => {
    p.rect(-4 + inset, -11 + inset, 9 - 2 * inset, 1, c);
    p.rect(-5 + inset, -10 + inset, 11 - 2 * inset, 9 - 2 * inset, c);
    p.rect(-4 + inset, -1 - inset, 9 - 2 * inset, 1, c);
  };
  plate(0, color);
  if (look.ring) plate(1, pal.base.bgDeep);
  const ink = look.ring ? color : pal.base.bgDeep;
  GLYPH[kind].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === 'X') p.rect(x - 3, y - 9, 1, 1, ink);
  });
}

// ---------- rendering one sprite ----------

function render(factory: CanvasFactory, draw: (p: Painter) => void): Sprite {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  draw({
    rect(x, y, w, h) {
      if (w <= 0 || h <= 0) return;
      x0 = Math.min(x0, Math.round(x));
      y0 = Math.min(y0, Math.round(y));
      x1 = Math.max(x1, Math.round(x) + Math.round(w));
      y1 = Math.max(y1, Math.round(y) + Math.round(h));
    },
  });
  if (x0 > x1) [x0, y0, x1, y1] = [0, 0, 1, 1];
  const width = x1 - x0, height = y1 - y0;
  const surface = factory.create(width, height);
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  let last = '';
  draw({
    rect(x, y, w, h, color) {
      if (w <= 0 || h <= 0) return;
      if (color !== last) {
        ctx.fillStyle = color;
        last = color;
      }
      ctx.fillRect(Math.round(x) - x0, Math.round(y) - y0, Math.round(w), Math.round(h));
    },
  });
  return { surface, width, height, anchorX: -x0, anchorY: -y0 };
}

// ---------- the cache ----------

export interface SpriteCacheStats {
  /** Sprites held right now. */
  size: number;
  /** Sprites drawn since creation (a hit never draws). */
  renders: number;
  hits: number;
  /** Times the theme changed and the cache was dropped. */
  invalidations: number;
  theme: string;
}

export interface SpriteCache {
  character(parts: CharacterParts): Sprite;
  prop(parts: PropParts): Sprite;
  stamp(kind: StampKind): Sprite;
  stats(): SpriteCacheStats;
  /** Called after a theme change dropped the cache (rebuild any layer made from sprites); returns an unsubscribe. */
  onInvalidate(fn: () => void): () => void;
  /** Stops listening to the theme and drops the sprites. */
  dispose(): void;
}

export interface SpriteCacheOptions {
  /** Defaults to an OffscreenCanvas, else a canvas element. */
  canvas?: CanvasFactory;
  /** Defaults to the shared theme from palette.ts. */
  theme?: ThemeSource;
}

/**
 * Sprites are keyed by palette name plus normalised parts, so an equivalent request is a hit and a request under
 * another palette can never return a stale sprite. A theme change also drops everything, so memory does not grow.
 */
export function createSpriteCache(opts: SpriteCacheOptions = {}): SpriteCache {
  const source = opts.theme ?? sharedTheme;
  let factory = opts.canvas;
  const sprites = new Map<string, Sprite>();
  const listeners = new Set<() => void>();
  let renders = 0, hits = 0, invalidations = 0;

  const unsubscribe = source.subscribe(() => {
    sprites.clear();
    invalidations++;
    for (const fn of [...listeners]) fn();
  });

  function get(key: string, draw: (p: Painter, pal: GaragePalette) => void): Sprite {
    const pal = source.palette();
    const full = `${pal.name}|${key}`;
    const hit = sprites.get(full);
    if (hit) {
      hits++;
      return hit;
    }
    const sprite = render((factory ??= defaultCanvasFactory()), p => draw(p, pal));
    renders++;
    sprites.set(full, sprite);
    return sprite;
  }

  const prop = (parts: PropParts): Sprite => {
    const n = normalizeProp(parts);
    if (n.kind.startsWith('stamp:')) {
      const kind = n.kind.slice(6) as StampKind;
      return get(`s|${kind}`, (p, pal) => drawStamp(p, pal, kind));
    }
    const draw = PROPS[n.kind as PropKind];
    if (!draw) throw new Error(`unknown prop kind: ${n.kind}`);
    return get(`p|${n.kind}|${n.state}|${n.variant}`, (p, pal) => draw(p, pal, n.state, n.variant));
  };

  return {
    character(parts) {
      const n = normalizeCharacter(parts);
      const key = `c|${n.role}|${n.specialty ?? ''}|${n.skin}|${n.hairStyle}|${n.hairColor}|${n.pose}|${n.facing}`;
      return get(key, (p, pal) => drawCharacter(p, pal, n));
    },
    prop,
    stamp: kind => prop({ kind: `stamp:${kind}` }),
    stats: () => ({ size: sprites.size, renders, hits, invalidations, theme: source.name() }),
    onInvalidate(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    dispose() {
      unsubscribe();
      listeners.clear();
      sprites.clear();
    },
  };
}
