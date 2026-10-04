import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { THEMES } from '../packages/claude-plugin/hooks/theme';
import {
  LIGHT, PALETTES, THEME_NAMES, applyCssVars, createTheme, cssText, cssVars, currentPalette, currentTheme, mix, onTheme,
  paletteFor, roleColor, setTheme, shade, themeName,
} from '../packages/garage/src/palette';
import {
  HAIR_STYLES, POSES, PROP_KINDS, STAMP_KINDS, characterParts, createSpriteCache, defaultCanvasFactory, drawSprite,
  fitZoom, integerZoom, normalizeCharacter, type BlitCtx, type CanvasFactory, type CharacterParts, type PixelCtx, type Sprite,
  type SpriteSurface,
} from '../packages/garage/src/sprites';

interface Rect { x: number; y: number; w: number; h: number; color: string }

/** A canvas that records what was drawn on it instead of drawing. */
class StubSurface implements SpriteSurface {
  rects: Rect[] = [];
  fillStyle = '';
  constructor(public width: number, public height: number) {}
  getContext(): PixelCtx {
    const self = this;
    return {
      get fillStyle() { return self.fillStyle; },
      set fillStyle(v) { self.fillStyle = String(v); },
      fillRect(x, y, w, h) { self.rects.push({ x, y, w, h, color: self.fillStyle }); },
    };
  }
  colors = () => new Set(this.rects.map(r => r.color));
}

function stubCanvas() {
  const surfaces: StubSurface[] = [];
  const factory: CanvasFactory = { create: (w, h) => (surfaces[surfaces.length] = new StubSurface(w, h)) };
  return { factory, surfaces };
}

const worker: CharacterParts = { role: 'worker', specialty: 'frontend' };

afterEach(() => void setTheme('phosphor'));

describe('palette', () => {
  it('mirrors theme.ts for phosphor and neon, key for key', () => {
    for (const name of THEME_NAMES) {
      expect(PALETTES[name].base).toEqual(THEMES[name].c);
      expect(PALETTES[name].aurora).toEqual(THEMES[name].aurora);
    }
    expect(THEME_NAMES.sort()).toEqual(Object.keys(THEMES).sort());
  });

  it('colours roles: supervisor violet, lead cyan, workers by specialty', () => {
    for (const name of THEME_NAMES) {
      const pal = PALETTES[name], b = pal.base;
      expect(roleColor(pal, 'supervisor')).toBe(b.violet);
      expect(roleColor(pal, 'council')).toBe(b.violet);
      expect(roleColor(pal, 'lead')).toBe(b.cyan);
      expect(roleColor(pal, 'worker', 'backend')).toBe(b.orange);
      expect(roleColor(pal, 'worker', 'frontend')).toBe(b.blue);
      expect(roleColor(pal, 'worker', 'test')).toBe(b.pink);
      expect(roleColor(pal, 'worker', 'research')).toBe(b.cyan);
      expect(roleColor(pal, 'worker', 'refactoring')).toBe(b.violet);
      expect(roleColor(pal, 'worker', 'generalist')).toBe(b.mint);
      expect(roleColor(pal, 'worker', 'no-such-specialty')).toBe(b.orange);
      expect(roleColor(pal, 'worker', null)).toBe(b.orange);
    }
  });

  it('switches theme through the API; unknown names fall back to phosphor', () => {
    expect(currentTheme()).toBe('phosphor');
    const seen: string[] = [];
    const off = onTheme(() => seen.push(currentTheme()));
    expect(setTheme('neon')).toBe('neon');
    expect(currentPalette()).toBe(PALETTES.neon);
    expect(setTheme('neon')).toBe('neon');
    expect(setTheme('nonsense')).toBe('phosphor');
    off();
    setTheme('neon');
    expect(seen).toEqual(['neon', 'phosphor']);
    expect(themeName(undefined)).toBe('phosphor');
    expect(paletteFor('neon')).toBe(PALETTES.neon);
  });

  it('exports every colour as CSS custom properties that follow the theme', () => {
    const vars = cssVars(PALETTES.phosphor);
    expect(vars['--g-accent']).toBe(PALETTES.phosphor.base.accent);
    expect(vars['--g-bg-deep']).toBe(PALETTES.phosphor.base.bgDeep);
    expect(vars['--g-floor-a']).toBe(PALETTES.phosphor.scene.floorA);
    expect(vars['--g-skin-0']).toBe(PALETTES.phosphor.scene.skin[0]);
    expect(vars['--g-aurora-5']).toBe(PALETTES.phosphor.aurora[5]);
    expect(Object.keys(vars).filter(k => !/-\d$/.test(k) && !/^--g-(floor|wall|wood|metal|cardboard|pants|shoe|shadow)/.test(k))).toHaveLength(Object.keys(PALETTES.phosphor.base).length);

    setTheme('neon');
    expect(cssVars()['--g-accent']).toBe(PALETTES.neon.base.accent);
    expect(cssText().startsWith(':root{--g-accent:')).toBe(true);
    const set: Record<string, string> = {};
    applyCssVars({ style: { setProperty: (k, v) => void (set[k] = v) } });
    expect(set).toEqual(cssVars(PALETTES.neon));
  });

  it('shades towards black below 1 and towards white above 1', () => {
    const c = PALETTES.neon.base.cyan;
    expect(shade(c, 1)).toBe(c);
    expect(shade(c, 0)).toBe(shade(PALETTES.neon.base.white, 0));
    expect(mix(c, PALETTES.neon.base.white, 0)).toBe(c);
    expect(shade(c, 2)).toBe(PALETTES.neon.base.white);
    expect(LIGHT.top).toBeGreaterThan(LIGHT.left);
    expect(LIGHT.left).toBeGreaterThan(LIGHT.right);
  });
});

describe('integer zoom', () => {
  it('floors to a whole number of at least 1', () => {
    expect(integerZoom(1)).toBe(1);
    expect(integerZoom(3)).toBe(3);
    expect(integerZoom(2.9)).toBe(2);
    expect(integerZoom(0.4)).toBe(1);
    expect(integerZoom(0)).toBe(1);
    expect(integerZoom(-3)).toBe(1);
    expect(integerZoom(Number.NaN)).toBe(1);
    expect(integerZoom(Infinity)).toBe(1);
  });

  it('fits the largest whole zoom into a viewport', () => {
    expect(fitZoom(1000, 600, 200, 100)).toBe(5);
    expect(fitZoom(1000, 600, 200, 300)).toBe(2);
    expect(fitZoom(50, 50, 200, 100)).toBe(1);
    expect(fitZoom(10_000, 10_000, 10, 10)).toBe(8);
    expect(fitZoom(100, 100, 0, 0)).toBe(1);
  });

  it('blits at whole-pixel positions and sizes with smoothing off', () => {
    const { factory } = stubCanvas();
    const sprite = createSpriteCache({ canvas: factory, theme: createTheme() }).character(worker);
    const calls: unknown[][] = [];
    const ctx: BlitCtx = { imageSmoothingEnabled: true, drawImage: (...a) => void calls.push(a) };

    drawSprite(ctx, sprite, 10.6, 4.4, 2.7);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(calls[0]).toEqual([
      sprite.surface, 0, 0, sprite.width, sprite.height,
      11 - sprite.anchorX * 2, 4 - sprite.anchorY * 2, sprite.width * 2, sprite.height * 2,
    ]);

    for (const zoom of [1, 1.5, 2, 3.99, 4, 7.2]) {
      calls.length = 0;
      drawSprite(ctx, sprite, 3.5, 9.5, zoom);
      for (const n of calls[0]!.slice(1) as number[]) expect(Number.isInteger(n)).toBe(true);
    }
    calls.length = 0;
    drawSprite(ctx, sprite, 0, 0);
    expect(calls[0]!.slice(7)).toEqual([sprite.width, sprite.height]);
  });
});

describe('sprite cache', () => {
  it('renders a sprite once and returns it for equal parts', () => {
    const { factory, surfaces } = stubCanvas();
    const cache = createSpriteCache({ canvas: factory, theme: createTheme() });
    const a = cache.character(worker);
    const b = cache.character({ ...worker });
    expect(b).toBe(a);
    expect(surfaces).toHaveLength(1);
    expect(cache.stats()).toMatchObject({ size: 1, renders: 1, hits: 1 });
    expect(cache.prop({ kind: 'desk' })).toBe(cache.prop({ kind: 'desk', state: 'idle', variant: 0 }));
    expect(cache.stamp('approved')).toBe(cache.stamp('approved'));
    expect(surfaces).toHaveLength(3);
  });

  it('keys on every part that changes the picture, and on nothing else', () => {
    const { factory, surfaces } = stubCanvas();
    const cache = createSpriteCache({ canvas: factory, theme: createTheme() });
    const base = cache.character(worker);
    const differing: CharacterParts[] = [
      { ...worker, specialty: 'backend' },
      { ...worker, role: 'lead' },
      { ...worker, skin: 1 },
      { ...worker, hairStyle: 'long' },
      { ...worker, hairColor: 2 },
      { ...worker, pose: 'walkA' },
      { ...worker, facing: 'left' },
    ];
    for (const parts of differing) expect(cache.character(parts)).not.toBe(base);
    expect(new Set(differing.map(p => cache.character(p))).size).toBe(differing.length);

    // defaults spelled out, or a specialty on a role that ignores it: the same sprite
    expect(cache.character({ role: 'worker', specialty: 'frontend', skin: 0, hairStyle: 'short', hairColor: 0, pose: 'stand', facing: 'right' })).toBe(base);
    expect(cache.character({ role: 'lead', specialty: 'backend' })).toBe(cache.character({ role: 'lead', specialty: 'research' }));
    expect(surfaces).toHaveLength(1 + differing.length);
    expect(normalizeCharacter({ role: 'supervisor', specialty: 'backend' }).specialty).toBeNull();

    // props: kind, lamp state and variant each make a new sprite
    const desk = cache.prop({ kind: 'desk' });
    expect(cache.prop({ kind: 'desk', state: 'busy' })).not.toBe(desk);
    expect(cache.prop({ kind: 'crate', variant: 1 })).not.toBe(cache.prop({ kind: 'crate', variant: 0 }));
    expect(cache.prop({ kind: 'tile', variant: 1 })).not.toBe(cache.prop({ kind: 'tile', variant: 0 }));
    expect(cache.stamp('failed')).not.toBe(cache.stamp('rejected'));
  });

  it('rebuilds everything after a theme change, and tells listeners', () => {
    const { factory, surfaces } = stubCanvas();
    const theme = createTheme('phosphor');
    const cache = createSpriteCache({ canvas: factory, theme });
    let notified = 0;
    cache.onInvalidate(() => notified++);

    const before = cache.character(worker);
    const desk = cache.prop({ kind: 'desk' });
    expect(cache.stats().size).toBe(2);

    theme.set('neon');
    expect(notified).toBe(1);
    expect(cache.stats()).toMatchObject({ size: 0, invalidations: 1, theme: 'neon' });
    const after = cache.character(worker);
    expect(after).not.toBe(before);
    expect(cache.prop({ kind: 'desk' })).not.toBe(desk);
    expect(cache.character(worker)).toBe(after);
    expect(cache.stats().renders).toBe(4);

    // the new sprite is drawn in the new palette
    const [phosphorSprite, neonSprite] = [surfaces[0]!, surfaces[2]!];
    expect(neonSprite.colors().has(PALETTES.neon.scene.pants)).toBe(true);
    expect(phosphorSprite.colors().has(PALETTES.phosphor.scene.pants)).toBe(true);
    expect(neonSprite.colors().has(PALETTES.phosphor.scene.pants)).toBe(false);

    // same theme again: nothing to rebuild
    theme.set('neon');
    expect(notified).toBe(1);
    expect(cache.character(worker)).toBe(after);

    // and back: the phosphor sprite is rebuilt, not resurrected
    theme.set('phosphor');
    expect(cache.character(worker)).not.toBe(before);
    expect(notified).toBe(2);
  });

  it('follows the shared theme by default, and stops after dispose', () => {
    const { factory } = stubCanvas();
    const cache = createSpriteCache({ canvas: factory });
    const a = cache.character(worker);
    setTheme('neon');
    expect(cache.character(worker)).not.toBe(a);
    cache.dispose();
    expect(cache.stats().size).toBe(0);
    setTheme('phosphor');
    expect(cache.stats().invalidations).toBe(1);
  });

  it('draws only whole-pixel rectangles inside every surface, with the anchor on it', () => {
    const { factory, surfaces } = stubCanvas();
    for (const name of THEME_NAMES) {
      const cache = createSpriteCache({ canvas: factory, theme: createTheme(name) });
      const sprites: Sprite[] = [];
      for (const pose of POSES) for (const facing of ['right', 'left'] as const) {
        for (const role of ['supervisor', 'lead', 'worker'] as const) sprites.push(cache.character({ role, pose, facing, hairStyle: HAIR_STYLES[pose.length % HAIR_STYLES.length] }));
      }
      for (const hairStyle of HAIR_STYLES) sprites.push(cache.character({ role: 'worker', hairStyle }));
      for (const kind of PROP_KINDS) for (const state of ['idle', 'busy', 'ok', 'failed', 'alert'] as const) sprites.push(cache.prop({ kind, state }));
      for (const kind of STAMP_KINDS) sprites.push(cache.stamp(kind));

      for (const sprite of sprites) {
        const surface = sprite.surface as StubSurface;
        expect(surface.width).toBe(sprite.width);
        expect(surface.height).toBe(sprite.height);
        expect(sprite.width).toBeGreaterThan(0);
        expect(sprite.height).toBeGreaterThan(0);
        expect(sprite.anchorX).toBeGreaterThanOrEqual(0);
        expect(sprite.anchorX).toBeLessThanOrEqual(sprite.width);
        expect(sprite.anchorY).toBeGreaterThanOrEqual(0);
        expect(sprite.anchorY).toBeLessThanOrEqual(sprite.height);
        expect(surface.rects.length).toBeGreaterThan(0);
        for (const r of surface.rects) {
          expect([r.x, r.y, r.w, r.h].every(Number.isInteger)).toBe(true);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(sprite.width);
          expect(r.y + r.h).toBeLessThanOrEqual(sprite.height);
        }
      }
    }
    expect(surfaces.length).toBeGreaterThan(100);
  });

  it('puts the role colour on the shirt', () => {
    const { factory } = stubCanvas();
    const cache = createSpriteCache({ canvas: factory, theme: createTheme() });
    const pal = PALETTES.phosphor;
    const colours = (parts: CharacterParts) => (cache.character(parts).surface as StubSurface).colors();
    expect(colours({ role: 'supervisor' }).has(pal.base.violet)).toBe(true);
    expect(colours({ role: 'lead' }).has(pal.base.cyan)).toBe(true);
    expect(colours({ role: 'worker', specialty: 'frontend' }).has(pal.base.blue)).toBe(true);
    expect(colours({ role: 'worker', specialty: 'frontend' }).has(pal.base.orange)).toBe(false);
    expect(colours({ role: 'worker', specialty: 'database' }).has(pal.base.yellow)).toBe(true);
  });

  it('gives each character id a stable look, and the council the supervisor role', () => {
    expect(characterParts('backend-dev', 'worker', 'backend')).toEqual(characterParts('backend-dev', 'worker', 'backend'));
    expect(characterParts('sup-1', 'council').role).toBe('supervisor');
    expect(characterParts('lead-1', 'lead', 'backend').specialty).toBeNull();
    expect(characterParts('x', 'worker', 'test')).toMatchObject({ role: 'worker', specialty: 'test' });
    const looks = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(characterParts(`worker-${i}`, 'worker'))));
    expect(looks.size).toBeGreaterThan(5);
  });
});

describe('canvas access', () => {
  it('uses an OffscreenCanvas when there is one', () => {
    const made: StubSurface[] = [];
    class Off extends StubSurface { constructor(w: number, h: number) { super(w, h); made.push(this); } }
    const s = defaultCanvasFactory({ OffscreenCanvas: Off, document: { createElement: () => { throw new Error('unused'); } } }).create(5, 7);
    expect(made).toEqual([s]);
    expect([s.width, s.height]).toEqual([5, 7]);
  });

  it('falls back to a canvas element, sized after creation', () => {
    const tags: string[] = [];
    const el = new StubSurface(0, 0);
    const s = defaultCanvasFactory({ document: { createElement: tag => (tags.push(tag), el) } }).create(5, 7);
    expect(tags).toEqual(['canvas']);
    expect(s).toBe(el);
    expect([el.width, el.height]).toEqual([5, 7]);
    // and the cache can run on it end to end
    const cache = createSpriteCache({ canvas: defaultCanvasFactory({ document: { createElement: () => new StubSurface(0, 0) } }), theme: createTheme() });
    expect((cache.prop({ kind: 'lab' }).surface as StubSurface).rects.length).toBeGreaterThan(0);
  });

  it('says so when there is no canvas at all, only when a sprite is first drawn', () => {
    const cache = createSpriteCache({ canvas: defaultCanvasFactory({}), theme: createTheme() });
    expect(() => cache.character(worker)).toThrow(/no canvas available/);
    expect(() => createSpriteCache({ canvas: { create: () => ({ width: 1, height: 1, getContext: () => null }) }, theme: createTheme() }).character(worker)).toThrow(/2d canvas context/);
  });
});

describe('no colour literals outside palette.ts', () => {
  it('sprites.ts has none', () => {
    const src = readFileSync(new URL('../packages/garage/src/sprites.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\s*\(/);
    expect(src).not.toMatch(/['"`](?:red|green|blue|white|black|orange|yellow|violet|cyan|pink|gray|grey|transparent)['"`]/);
    expect(src).not.toMatch(/\.(?:png|jpe?g|gif|svg|webp)\b/);
    expect(src).not.toMatch(/from '@cockpit\//);
    expect(src).not.toMatch(/from 'node:/);
  });
});
