// The garage's design tokens: the only file with colour literals. Dependency-free (no DOM, no node).
// `base` mirrors packages/claude-plugin/hooks/theme.ts (phosphor default, neon); test/garage-sprites.test.ts keeps the two in step.
// Scene tokens (floor, wood, skin, hair ...) are the garage's own.

/** The cockpit palette, key for key as in theme.ts. */
export interface BasePalette {
  accent: string; violet: string; cyan: string; blue: string; green: string; yellow: string; red: string; pink: string;
  text: string; mute: string; dim: string; faint: string; line: string; white: string; ink: string; bgDeep: string;
  chip: string; border: string; borderDim: string; hover: string; tabActive: string; redDeep: string; redDark: string;
  redDim: string; yellowDeep: string; violetDeep: string; track: string; baseline: string; label: string; teal: string;
  mint: string; greenDeep: string; lavender: string; glow: string; alertTint: string; indigo: string; chipOn: string;
  seatSupervisor: string; seatLead: string; thinkDim: string; orange: string;
}

/** What only the room needs: surfaces, materials, people. */
export interface ScenePalette {
  floorA: string; floorB: string; floorLine: string; wall: string; wallTop: string;
  wood: string; metal: string; cardboard: string; pants: string; shoe: string; shadow: string;
  skin: string[]; hair: string[];
}

/**
 * The 3D garage's materials and light (scene3d.ts): a real room, so mostly real-world colours; the theme changes the mood
 * (night sky, light temperature, the neon) more than the furniture.
 */
export interface RoomPalette {
  /** Behind the diorama, and the fog that fades its far edge. */
  sky: string; fog: string;
  /** Hemisphere light, the cool key light through the window, warm lamps and string-light bulbs. */
  hemiSky: string; hemiGround: string; sun: string; lamp: string; bulb: string;
  concrete: string; concreteDark: string; slab: string; wall: string; wallTrim: string; brick: string;
  plywood: string; wood: string; woodDark: string; metal: string; metalDark: string; plastic: string;
  fabric: string; fabricAlt: string; rug: string; rugAlt: string; cork: string; paper: string;
  screenOff: string; plant: string; plantDark: string; pot: string;
  cardboard: string; crate: string; tape: string; tapeDark: string; window: string; moon: string; mug: string;
  /** The sign on the back wall. */
  neon: string;
  /** Status lights and screens: what a station shows when busy, fine, failed, or calling for attention. */
  busy: string; ok: string; failed: string; alert: string;
}

export type ThemeName = 'phosphor' | 'neon';

export interface GaragePalette {
  name: ThemeName;
  base: BasePalette;
  aurora: string[];
  scene: ScenePalette;
  room: RoomPalette;
}

/** Furniture, walls and floor shared by both moods. */
const ROOM_COMMON = {
  concrete: '#8a8d8f', concreteDark: '#6c6f72', slab: '#3a3c40', wall: '#cbbfa8', wallTrim: '#8f8471', brick: '#8f4c38',
  plywood: '#c9a274', wood: '#9c6b43', woodDark: '#4b3528', metal: '#9aa1a8', metalDark: '#3b4047', plastic: '#2b2f36',
  fabricAlt: '#d0703f', rug: '#7d3c3c', rugAlt: '#2f5d6b', cork: '#b98a57', paper: '#f3eee2', screenOff: '#14171c',
  plant: '#4a9a52', plantDark: '#2f6e3a', pot: '#b9673e', cardboard: '#bd8d58', crate: '#a8743f', tape: '#f2c230',
  tapeDark: '#26262a', moon: '#f6f1d8', mug: '#ebe6da', ok: '#4ade80', failed: '#f87171', alert: '#fbbf24',
} as const;

const NEON: BasePalette = {
  accent: '#ff8a3d', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24',
  red: '#f87171', pink: '#f472b6', text: '#e5e7eb', mute: '#9ca3af', dim: '#6b7280', faint: '#3f3f46', line: '#52525b',
  white: '#ffffff', ink: '#fafafa', bgDeep: '#0b0b0f', chip: '#2a2a33', border: '#2e2e36', borderDim: '#26262e',
  hover: '#1f1f27', tabActive: '#3a2412', redDeep: '#5b1d1d', redDark: '#7f1d1d', redDim: '#4c1d1d', yellowDeep: '#3a2a0a',
  violetDeep: '#3b2a55', track: '#1f1f26', baseline: '#27272a', label: '#71717a', teal: '#0f766e', mint: '#6ee7b7',
  greenDeep: '#065f46', lavender: '#c4b5fd', glow: '#3b2f7a', alertTint: '#3a2208', indigo: '#6366f1',
  chipOn: '#23232c', seatSupervisor: '#3b1d6e', seatLead: '#0e3a4a', thinkDim: '#8b80b8', orange: '#fb923c',
};

/** Phosphor: black glass, green frames and headings; roles keep their own hues. */
const PHOSPHOR: BasePalette = {
  accent: '#4ade80', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#4ade80', yellow: '#facc15',
  red: '#f87171', pink: '#f472b6', text: '#cfe3d6', mute: '#8aa595', dim: '#5f7a6a', faint: '#2f4a3a', line: '#3b5a47',
  white: '#ffffff', ink: '#eafff2', bgDeep: '#060a08', chip: '#12251a', border: '#1f4a30', borderDim: '#163524',
  hover: '#0f2016', tabActive: '#123d24', redDeep: '#5b1d1d', redDark: '#7f1d1d', redDim: '#4c1d1d', yellowDeep: '#3a3008',
  violetDeep: '#2a2550', track: '#10201a', baseline: '#1d2f24', label: '#6f8a7a', teal: '#0f766e', mint: '#86efac',
  greenDeep: '#14532d', lavender: '#a7e8bd', glow: '#1f6b3a', alertTint: '#3a2a08', indigo: '#34d399',
  chipOn: '#163a24', seatSupervisor: '#2e2160', seatLead: '#0c3a44', thinkDim: '#7aa38a', orange: '#fb923c',
};

const SKIN = ['#f2c9a0', '#e0a878', '#b9814f', '#8a5a36', '#5e3b24'];
const HAIR = ['#1c1917', '#4a2f1a', '#a8642b', '#d6b25e', '#b8bcc4', '#c2410c'];

export const PALETTES: Record<ThemeName, GaragePalette> = {
  phosphor: {
    name: 'phosphor',
    base: PHOSPHOR,
    aurora: ['#050906', '#0a1a10', '#0f2e1a', '#0a2a2a', '#06140c', '#050906'],
    scene: {
      floorA: '#0b1510', floorB: '#0e1b14', floorLine: '#163524', wall: '#12281c', wallTop: '#1f4a30',
      wood: '#3b5a46', metal: '#5f7a6a', cardboard: '#7c6a3a', pants: '#24402f', shoe: '#060a08',
      shadow: 'rgba(0,0,0,0.4)', skin: SKIN, hair: HAIR,
    },
    // Late night, warm lamps, a green neon: the hacker's hours.
    room: {
      ...ROOM_COMMON, sky: '#0c120f', fog: '#0c120f', hemiSky: '#d9e6dc', hemiGround: '#2a2219', sun: '#a9c4ff', lamp: '#ffb46e',
      bulb: '#ffd590', fabric: '#3f5c78', window: '#13233d', neon: '#4ade80', busy: '#7dd3fc',
    },
  },
  neon: {
    name: 'neon',
    base: NEON,
    aurora: ['#07070d', '#14112e', '#241b52', '#0c3a4a', '#0a2230', '#07070d'],
    scene: {
      floorA: '#101018', floorB: '#14141e', floorLine: '#26262e', wall: '#1b1b27', wallTop: '#2e2e3a',
      wood: '#5a4636', metal: '#6b7280', cardboard: '#b07a3a', pants: '#33384a', shoe: '#0b0b0f',
      shadow: 'rgba(0,0,0,0.4)', skin: SKIN, hair: HAIR,
    },
    // Synthwave dusk: violet sky, pink neon, the lamps a little hotter.
    room: {
      ...ROOM_COMMON, sky: '#130d22', fog: '#130d22', hemiSky: '#d7c8ff', hemiGround: '#24162a', sun: '#b9a2ff', lamp: '#ff9d63',
      bulb: '#ffc58a', fabric: '#5d3f7a', window: '#2a1747', neon: '#f472b6', busy: '#a78bfa',
    },
  },
};
export const THEME_NAMES: ThemeName[] = ['phosphor', 'neon'];

/** Unknown names fall back to phosphor, as in theme.ts. */
export function themeName(name: string | null | undefined): ThemeName {
  return name === 'neon' ? 'neon' : 'phosphor';
}
export const paletteFor = (name: string | null | undefined): GaragePalette => PALETTES[themeName(name)];

// ---------- roles ----------

export type SpriteRole = 'supervisor' | 'lead' | 'worker';

/** Worker specialty -> palette key, as the cockpit's team view colours them (register.tsx SPEC_COLOR). */
const SPECIALTY_COLOR: Record<string, keyof BasePalette> = {
  backend: 'orange', frontend: 'blue', test: 'pink', database: 'yellow', security: 'red', performance: 'yellow',
  documentation: 'text', refactoring: 'violet', research: 'cyan', generalist: 'mint',
};

/** A role's colour in `pal`: supervisor (and the council) violet, lead cyan, workers by specialty (orange when unknown). */
export function roleColor(pal: GaragePalette, role: SpriteRole | 'council', specialty?: string | null): string {
  if (role === 'supervisor' || role === 'council') return pal.base.violet;
  if (role === 'lead') return pal.base.cyan;
  return pal.base[SPECIALTY_COLOR[specialty ?? ''] ?? 'orange'];
}

// ---------- colour maths ----------

function rgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const h2 = (v: number) => v.toString(16).padStart(2, '0');

/** Channel-wise blend of two #rrggbb colours; t is clamped to 0..1. */
export function mix(a: string, b: string, t: number): string {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const ch = (x: number, y: number) => h2(Math.round(x + (y - x) * k));
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** Brightness: k < 1 darkens towards black, k > 1 lightens towards white, 1 is the colour itself. */
export function shade(c: string, k: number): string {
  return k <= 1 ? mix('#000000', c, k) : mix(c, '#ffffff', k - 1);
}

/** One light direction (from the top left): how bright each face of a box is. */
export const LIGHT = { top: 1.15, left: 0.88, right: 0.62 } as const;

// ---------- the active theme ----------

/** What the sprite cache and the renderer read: the current palette, and a way to hear about switches. */
export interface ThemeSource {
  name(): ThemeName;
  palette(): GaragePalette;
  /** Called after every switch (to a different theme); returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}
export interface Theme extends ThemeSource {
  /** Switch (unknown names fall back to phosphor); returns the theme in use. Listeners run only when it changed. */
  set(name: string | null | undefined): ThemeName;
}

/** A separate theme instance (tests, or a second view); `theme` below is the shared one. */
export function createTheme(initial: string | null | undefined = 'phosphor'): Theme {
  let current = themeName(initial);
  const listeners = new Set<() => void>();
  return {
    name: () => current,
    palette: () => PALETTES[current],
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    set(name) {
      const next = themeName(name);
      if (next !== current) {
        current = next;
        for (const fn of [...listeners]) fn();
      }
      return current;
    },
  };
}

export const theme: Theme = createTheme('phosphor');
export const setTheme = (name: string | null | undefined): ThemeName => theme.set(name);
export const currentTheme = (): ThemeName => theme.name();
export const currentPalette = (): GaragePalette => theme.palette();
export const onTheme = (fn: () => void): (() => void) => theme.subscribe(fn);

// ---------- CSS custom properties ----------

const kebab = (s: string) => s.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);

/** Every colour as a `--g-*` custom property (bgDeep -> --g-bg-deep, skin[0] -> --g-skin-0). */
export function cssVars(pal: GaragePalette = currentPalette()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pal.base)) out[`--g-${kebab(k)}`] = v;
  pal.aurora.forEach((v, i) => (out[`--g-aurora-${i}`] = v));
  for (const [k, v] of Object.entries(pal.scene) as [string, string | string[]][]) {
    if (typeof v === 'string') out[`--g-${kebab(k)}`] = v;
    else v.forEach((c, i) => (out[`--g-${kebab(k)}-${i}`] = c));
  }
  return out;
}

/** The properties as one rule, e.g. for a <style> element: `:root{--g-accent:...;...}`. */
export function cssText(pal: GaragePalette = currentPalette(), selector = ':root'): string {
  return `${selector}{${Object.entries(cssVars(pal)).map(([k, v]) => `${k}:${v}`).join(';')}}`;
}

/** Writes the properties onto an element's style (`document.documentElement`), nothing else. */
export function applyCssVars(
  target: { style: { setProperty(name: string, value: string): void } },
  pal: GaragePalette = currentPalette(),
): void {
  for (const [k, v] of Object.entries(cssVars(pal))) target.style.setProperty(k, v);
}
