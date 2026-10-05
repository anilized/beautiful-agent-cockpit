// The things that make a desk someone's: screens with something on them, a chair, a keyboard, and the little objects people
// keep on their desks. Everything about a desk follows from its owner's id, so the same agent always gets the same desk.
// Built through the kit (kit3d.ts) from the palette; nothing here knows about stations or state.
import type * as THREE from 'three';
import { mix, roleColor, type GaragePalette } from './palette.js';
import { hash01, type Kit } from './kit3d.js';

export const DESK_Y = 0.74;

/** Runs every frame: blinks, scrolling screens, steam. */
export type Ticker = (now: number, dt: number) => void;

// ---------- screens ----------

export type ScreenKind = 'code' | 'design' | 'terminal' | 'docs' | 'graph' | 'tests' | 'papers' | 'merge';

/** What a team's screens show. */
export function screenFor(team: string | null): ScreenKind {
  switch (team) {
    case 'frontend': case 'ui': return 'design';
    case 'test': case 'qa': return 'tests';
    case 'docs': case 'documentation': return 'docs';
    case 'research': return 'papers';
    default: return 'code';
  }
}

const bases = new WeakMap<Kit, Map<string, THREE.CanvasTexture | null>>();

/** A fresh texture of `kind` in `accent` (its own offset, so it scrolls on its own); null without a canvas. */
export function screenTexture(kit: Kit, pal: GaragePalette, kind: ScreenKind, accent: string): THREE.CanvasTexture | null {
  const R = pal.room;
  const B = pal.base;
  const key = kind + accent;
  let cache = bases.get(kit);
  if (!cache) bases.set(kit, (cache = new Map()));
  if (!cache.has(key)) {
    cache.set(key, kit.texture(256, 160, (ctx, w, h) => {
      let s = Math.floor(hash01(key) * 1e6) + 1;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const dark = mix(R.screenOff, B.bgDeep, 0.3);
      if (kind === 'design') {
        ctx.fillStyle = mix(R.paper, R.metal, 0.25);
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = mix(R.paper, R.metal, 0.5);
        ctx.fillRect(0, 0, 40, h);
        ctx.fillRect(w - 46, 0, 46, h);
        ctx.fillStyle = R.paper;
        ctx.fillRect(56, 14, 140, 132);
        ctx.fillStyle = accent;
        ctx.fillRect(64, 22, 124, 26);
        [B.pink, B.yellow, B.violet].forEach((c, i) => {
          ctx.fillStyle = c;
          ctx.fillRect(64 + i * 42, 58, 36, 36);
        });
        ctx.fillStyle = mix(R.paper, R.metalDark, 0.5);
        for (let i = 0; i < 4; i++) ctx.fillRect(64, 104 + i * 9, 60 + rnd() * 60, 4);
        for (let i = 0; i < 8; i++) {
          ctx.fillStyle = [accent, B.pink, B.yellow, B.green][i % 4]!;
          ctx.fillRect(w - 38, 10 + i * 17, 30, 10);
        }
      } else if (kind === 'docs' || kind === 'papers') {
        ctx.fillStyle = R.paper;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = accent;
        ctx.fillRect(20, 12, 120, 12);
        ctx.fillStyle = mix(R.paper, R.metalDark, 0.6);
        for (let y = 36; y < h; y += 9) ctx.fillRect(20, y, 80 + rnd() * 140, 4);
        if (kind === 'papers') {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 3;
          ctx.strokeRect(150, 30, 90, 60);
          ctx.beginPath();
          ctx.moveTo(155, 85);
          for (let i = 0; i < 8; i++) ctx.lineTo(155 + i * 11, 85 - rnd() * 50);
          ctx.stroke();
        }
      } else if (kind === 'graph') {
        ctx.fillStyle = dark;
        ctx.fillRect(0, 0, w, h);
        [accent, B.violet, B.green].forEach((c, off) => {
          ctx.strokeStyle = c;
          ctx.lineWidth = 3;
          ctx.beginPath();
          for (let x = 0; x <= w; x += 16) ctx.lineTo(x, 110 - off * 20 - Math.sin(x / 30 + off * 2) * 18 - rnd() * 14);
          ctx.stroke();
        });
        [accent, B.violet, B.green, B.yellow].forEach((c, i) => {
          ctx.fillStyle = c;
          ctx.fillRect(10 + i * 62, 10, 52, 22);
        });
      } else {
        ctx.fillStyle = dark;
        ctx.fillRect(0, 0, w, h);
        const colors = kind === 'terminal' ? [B.green, B.green, R.paper, B.mint]
          : kind === 'tests' ? [B.green, B.green, B.green, B.red, R.paper]
          : kind === 'merge' ? [B.green, B.red, B.cyan, R.paper]
          : [accent, B.violet, R.paper, B.yellow, B.green, B.cyan];
        if (kind === 'code') {
          ctx.fillStyle = mix(dark, R.paper, 0.06);
          ctx.fillRect(0, 0, 34, h);
        }
        let indent = 0;
        for (let y = 6; y < h; y += 9) {
          if (rnd() > 0.85) continue;
          indent = Math.max(0, Math.min(4, indent + (rnd() > 0.6 ? 1 : rnd() > 0.5 ? -1 : 0)));
          let x = (kind === 'code' ? 42 : 8) + indent * 12;
          const parts = 1 + Math.floor(rnd() * 3);
          for (let p = 0; p < parts; p++) {
            const len = 14 + rnd() * 50;
            ctx.fillStyle = colors[Math.floor(rnd() * colors.length)]!;
            ctx.fillRect(x, y, len, 4);
            x += len + 6;
          }
        }
      }
    }, [1, 1]));
  }
  const base = cache.get(key);
  if (!base) return null;
  const t = kit.own(base.clone());
  t.needsUpdate = true;
  return t;
}

/** A screen: an unlit plane whose texture (when there is one) scrolls while `scroll()` says so. */
export interface Screen {
  mat: THREE.MeshBasicMaterial;
  tex: THREE.CanvasTexture | null;
}

export function screen(kit: Kit, pal: GaragePalette, kind: ScreenKind, accent: string): Screen {
  const tex = screenTexture(kit, pal, kind, accent);
  const mat = kit.own(new kit.T.MeshBasicMaterial({ map: tex, color: new kit.T.Color(pal.room.screenOff), toneMapped: false }));
  return { mat, tex };
}

export function monitor(kit: Kit, pal: GaragePalette, w: number, h: number, mat: THREE.Material, stand = 0.14): THREE.Group {
  const R = pal.room;
  const g = new kit.T.Group();
  g.add(kit.box(0.2, 0.02, 0.14, R.metalDark, 0, 0, 0, { metal: 0.6 }));
  g.add(kit.box(0.04, stand + 0.02, 0.03, R.metalDark, 0, 0.02, -0.03, { metal: 0.6 }));
  g.add(kit.box(w, h, 0.035, R.plastic, 0, stand, 0));
  g.add(kit.mesh(kit.planeGeo(w - 0.035, h - 0.035), mat, 0, stand + h / 2, 0.0185, 'none'));
  return g;
}

// ---------- chairs ----------

export type ChairStyle = 'office' | 'gaming' | 'stool' | 'arm';

/** A chair whose sitter faces -z (its back is at +z). */
export function chair(kit: Kit, pal: GaragePalette, style: ChairStyle, color: string, accent: string = color): THREE.Group {
  const R = pal.room;
  const g = new kit.T.Group();
  if (style === 'office' || style === 'gaming') {
    g.add(kit.box(0.46, 0.07, 0.44, color, 0, 0.42, 0, { rough: 0.7 }));
    const backH = style === 'gaming' ? 0.78 : 0.52;
    g.add(kit.box(0.44, backH, 0.06, color, 0, 0.5, 0.21, { rough: 0.7 }));
    if (style === 'gaming') {
      g.add(kit.box(0.06, backH - 0.08, 0.065, accent, -0.17, 0.54, 0.21, { rough: 0.6 }), kit.box(0.06, backH - 0.08, 0.065, accent, 0.17, 0.54, 0.21, { rough: 0.6 }));
      g.add(kit.box(0.3, 0.12, 0.07, accent, 0, 0.5 + backH - 0.2, 0.235));
      g.add(kit.box(0.06, 0.2, 0.3, R.plastic, -0.25, 0.42, -0.02), kit.box(0.06, 0.2, 0.3, R.plastic, 0.25, 0.42, -0.02));
    }
    g.add(kit.cyl(0.03, 0.36, R.metalDark, 0, 0.06, 0, { metal: 0.7 }));
    g.add(kit.box(0.56, 0.035, 0.06, R.metalDark, 0, 0.04, 0, { metal: 0.7 }), kit.box(0.06, 0.035, 0.56, R.metalDark, 0, 0.04, 0, { metal: 0.7 }));
  } else if (style === 'arm') {
    g.add(kit.box(0.66, 0.24, 0.62, color, 0, 0.18, 0));
    g.add(kit.box(0.66, 0.6, 0.18, color, 0, 0.18, 0.24));
    g.add(kit.box(0.13, 0.36, 0.62, color, -0.33, 0.18, 0), kit.box(0.13, 0.36, 0.62, color, 0.33, 0.18, 0));
    g.add(kit.box(0.5, 0.06, 0.46, mix(color, R.paper, 0.12), 0, 0.42, -0.02));
    for (const [dx, dz] of [[-0.28, -0.25], [0.28, -0.25], [-0.28, 0.25], [0.28, 0.25]] as const) g.add(kit.box(0.05, 0.18, 0.05, R.woodDark, dx, 0, dz));
  } else {
    g.add(kit.cyl(0.2, 0.06, color, 0, 0.6, 0));
    g.add(kit.cyl(0.03, 0.6, R.metalDark, 0, 0, 0, { metal: 0.7 }));
    g.add(kit.cyl(0.18, 0.03, R.metalDark, 0, 0, 0, { metal: 0.7 }));
  }
  return g;
}

// ---------- the things on a desk ----------

type Item = (x: number, z: number, color: string) => THREE.Object3D;

/** Desk-top things, placed at (x, z) on a desk whose top is at DESK_Y. */
function items(kit: Kit, pal: GaragePalette, tickers: Ticker[]): Record<string, Item> {
  const R = pal.room;
  const B = pal.base;
  const Y = DESK_Y;
  return {
    cactus: (x, z) => {
      const arm = kit.mesh(kit.capsuleGeo(0.016, 0.03), kit.mat(R.plant), x + 0.04, Y + 0.15, z);
      arm.rotation.z = -0.6;
      return kit.group(kit.cyl(0.05, 0.07, R.pot, x, Y, z, { rTop: 0.06 }), kit.mesh(kit.capsuleGeo(0.03, 0.08), kit.mat(R.plant), x, Y + 0.14, z), arm);
    },
    duck: (x, z) => kit.group(kit.ball(0.045, B.yellow, x, Y + 0.04, z, { rough: 0.4 }), kit.ball(0.03, B.yellow, x, Y + 0.1, z + 0.025, { rough: 0.4 }), kit.box(0.03, 0.012, 0.03, B.orange, x, Y + 0.09, z + 0.06)),
    figure: (x, z, color) => kit.group(kit.cyl(0.035, 0.012, R.plastic, x, Y, z), kit.mesh(kit.capsuleGeo(0.022, 0.04), kit.mat(color, { rough: 0.4 }), x, Y + 0.05, z), kit.ball(0.024, pal.scene.skin[1]!, x, Y + 0.11, z)),
    lava: (x, z, color) => {
      const blob = kit.ball(0.02, kit.mat(color, { basic: true }), x, Y + 0.1, z);
      const s = hash01(color + x) * 9;
      tickers.push((now) => (blob.position.y = Y + 0.1 + Math.sin(now / 1300 + s) * 0.04));
      return kit.group(
        kit.cyl(0.045, 0.05, R.metalDark, x, Y, z, { rTop: 0.03, metal: 0.6 }),
        kit.cyl(0.04, 0.16, color, x, Y + 0.05, z, { rTop: 0.026, glow: color, glowK: 0.9, opacity: 0.85 }),
        kit.cyl(0.026, 0.03, R.metalDark, x, Y + 0.21, z, { metal: 0.6 }),
        blob,
      );
    },
    photo: (x, z, color) => {
      const g = kit.group(kit.box(0.13, 0.1, 0.012, R.woodDark, 0, 0, 0), kit.box(0.11, 0.08, 0.004, mix(color, R.paper, 0.4), 0, 0.01, 0.007, { rough: 0.5 }), kit.ball(0.018, pal.scene.skin[2]!, -0.02, 0.055, 0.01), kit.ball(0.018, pal.scene.skin[0]!, 0.025, 0.05, 0.01));
      g.position.set(x, Y, z);
      g.rotation.set(-0.2, 0.4, 0);
      return g;
    },
    cans: (x, z, color) => {
      const down = kit.cyl(0.03, 0.1, B.mint, 0, 0, 0, { metal: 0.6, rough: 0.35 });
      down.rotation.z = Math.PI / 2;
      down.position.set(x - 0.02, Y + 0.03, z + 0.07);
      return kit.group(kit.cyl(0.03, 0.1, color, x, Y, z, { metal: 0.6, rough: 0.35 }), kit.cyl(0.03, 0.1, color, x + 0.07, Y, z - 0.02, { metal: 0.6, rough: 0.35 }), down);
    },
    books: (x, z) => {
      const b = kit.box(0.16, 0.03, 0.22, B.orange, x, Y + 0.035, z);
      b.rotation.y = 0.15;
      const c = kit.box(0.17, 0.035, 0.23, B.teal, x, Y + 0.065, z);
      c.rotation.y = -0.1;
      return kit.group(kit.box(0.18, 0.035, 0.24, B.violet, x, Y, z), b, c);
    },
    headphones: (x, z, color) => {
      const band = kit.mesh(kit.torusGeo(0.07, 0.014, Math.PI), kit.mat(R.plastic), 0, 0.18, 0);
      band.rotation.y = Math.PI / 2;
      const g = kit.group(kit.cyl(0.05, 0.012, R.metalDark, 0, 0, 0), kit.box(0.015, 0.2, 0.015, R.metalDark, 0, 0, 0), band, kit.box(0.04, 0.07, 0.06, color, 0, 0.12, 0.07), kit.box(0.04, 0.07, 0.06, color, 0, 0.12, -0.07));
      g.position.set(x, Y, z);
      return g;
    },
    rubik: (x, z) => {
      const g = kit.group(kit.box(0.06, 0.06, 0.06, R.plastic, 0, 0, 0));
      for (const [c, px, py, pz, rx, ry] of [[B.red, 0, 0.061, 0, -Math.PI / 2, 0], [B.green, 0, 0.03, 0.031, 0, 0], [B.yellow, 0.031, 0.03, 0, 0, Math.PI / 2]] as const) {
        const p = kit.mesh(kit.planeGeo(0.054, 0.054), kit.mat(c, { rough: 0.3 }), px, py, pz, 'none');
        p.rotation.set(rx, ry, 0);
        g.add(p);
      }
      g.position.set(x, Y, z);
      g.rotation.y = 0.5;
      return g;
    },
    succulent: (x, z) => {
      const g = kit.group(kit.cyl(0.055, 0.05, R.mug, 0, 0, 0, { rTop: 0.065 }));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const l = kit.ball(0.03, i % 2 ? R.plant : B.mint, Math.cos(a) * 0.03, 0.07, Math.sin(a) * 0.03);
        l.scale.set(1, 0.6, 0.6);
        l.rotation.y = -a;
        g.add(l);
      }
      g.position.set(x, Y, z);
      return g;
    },
    speaker: (x, z) => {
      const cone = kit.cyl(0.03, 0.01, R.metalDark, 0, 0, 0);
      cone.rotation.x = Math.PI / 2;
      cone.position.set(0, 0.09, 0.046);
      const g = kit.group(kit.box(0.09, 0.15, 0.09, R.plastic, 0, 0, 0), cone);
      g.position.set(x, Y, z);
      return g;
    },
    trophy: (x, z) => kit.group(kit.box(0.06, 0.03, 0.06, R.woodDark, x, Y, z), kit.cyl(0.012, 0.05, R.alert, x, Y + 0.03, z, { metal: 0.8, rough: 0.3 }), kit.cyl(0.04, 0.06, R.alert, x, Y + 0.08, z, { rTop: 0.05, metal: 0.8, rough: 0.3 })),
    plant: (x, z) => {
      const g = kit.group(kit.cyl(0.06, 0.08, R.pot, 0, 0, 0, { rTop: 0.07 }));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const leaf = kit.ball(0.06, i % 2 ? R.plant : R.plantDark, Math.cos(a) * 0.05, 0.16 + (i % 3) * 0.03, Math.sin(a) * 0.05);
        leaf.scale.set(1.2, 0.35, 0.7);
        leaf.rotation.set(0, -a, 0.5);
        g.add(leaf);
      }
      g.position.set(x, Y, z);
      return g;
    },
    mug: (x, z, color) => kit.group(kit.cyl(0.045, 0.1, color, x, Y, z), kit.mesh(kit.torusGeo(0.03, 0.008), kit.mat(color), x + 0.05, Y + 0.05, z)),
    // A team's things.
    server: (x, z) => {
      const g = kit.group(kit.box(0.16, 0.22, 0.2, R.plastic, 0, 0, 0));
      for (let i = 0; i < 4; i++) g.add(kit.box(0.012, 0.012, 0.005, i % 2 ? B.green : B.cyan, -0.05 + i * 0.03, 0.17, 0.101, { basic: true }));
      g.position.set(x, Y, z);
      return g;
    },
    tablet: (x, z) => {
      const pen = kit.box(0.012, 0.012, 0.16, R.paper, x + 0.18, Y + 0.012, z);
      pen.rotation.y = 0.3;
      return kit.group(kit.box(0.3, 0.012, 0.2, R.plastic, x, Y, z), kit.box(0.24, 0.002, 0.15, R.metalDark, x, Y + 0.012, z), pen);
    },
    swatches: (x, z) => kit.group(...[B.pink, B.blue, B.yellow, B.violet].map((c, i) => {
      const card = kit.box(0.05, 0.004, 0.09, c, x + i * 0.012, Y + i * 0.004, z + i * 0.01);
      card.rotation.y = i * 0.2;
      return card;
    })),
    bugjar: (x, z) => kit.group(kit.cyl(0.05, 0.11, kit.mat(R.window, { opacity: 0.35, rough: 0.1 }), x, Y, z), kit.cyl(0.052, 0.02, R.metal, x, Y + 0.11, z, { metal: 0.7 }), kit.ball(0.02, B.red, x, Y + 0.03, z), kit.ball(0.012, R.plastic, x + 0.018, Y + 0.035, z + 0.01)),
    clipboard: (x, z) => {
      const g = kit.group(kit.box(0.17, 0.008, 0.23, R.cardboard, 0, 0, 0), kit.box(0.14, 0.004, 0.18, R.paper, 0, 0.008, 0.01), kit.box(0.06, 0.012, 0.025, R.metal, 0, 0.01, -0.1));
      g.position.set(x, Y, z);
      g.rotation.y = -0.2;
      return g;
    },
    papers: (x, z) => kit.group(...[0, 1, 2, 3].map((i) => {
      const p = kit.box(0.2, 0.006, 0.27, R.paper, x + i * 0.01, Y + i * 0.006, z);
      p.rotation.y = (hash01('p' + i + x) - 0.5) * 0.5;
      return p;
    })),
    magnifier: (x, z) => {
      const ring = kit.mesh(kit.torusGeo(0.04, 0.008), kit.mat(R.metalDark), x, Y + 0.008, z);
      ring.rotation.x = Math.PI / 2;
      const handle = kit.box(0.015, 0.012, 0.09, R.woodDark, x + 0.05, Y, z + 0.05);
      handle.rotation.y = -0.7;
      return kit.group(ring, handle);
    },
  };
}

const TEAM_ITEMS: Record<string, string[]> = {
  backend: ['server', 'mug'], api: ['server', 'mug'], database: ['server', 'clipboard'], db: ['server', 'clipboard'],
  frontend: ['tablet', 'swatches'], ui: ['tablet', 'swatches'], test: ['bugjar', 'clipboard'], qa: ['bugjar', 'clipboard'],
  docs: ['books', 'papers'], documentation: ['books', 'papers'], research: ['papers', 'magnifier'], lead: ['mug', 'clipboard'],
};
const PERSONAL = ['cactus', 'duck', 'figure', 'lava', 'photo', 'cans', 'headphones', 'rubik', 'succulent', 'speaker', 'trophy', 'plant'];

// ---------- a desk ----------

export interface DeskOptions {
  /** Whose desk: decides finish, screens, chair and things. */
  owner: string;
  team: string | null;
  /** The team's colour: the divider, a gaming chair's stripes. */
  color: string;
  /** No one works here: the chair is pushed in. */
  empty: boolean;
}

export interface DeskBuild {
  /** In its own frame: the desk's centre at the origin, its sitter on the +z side, facing -z. */
  group: THREE.Group;
  chair: THREE.Group;
  /** The screens that follow the station's state; the first is the main one. */
  screens: Screen[];
}

/**
 * A personal desk: finish, legs, a divider in the team's colour on its back edge, a desk mat and keyboard (lit for some),
 * one wide or two screens or a portrait one or a laptop, a chair, and a team thing plus two or three of the owner's own.
 */
export function personalDesk(kit: Kit, pal: GaragePalette, o: DeskOptions, tickers: Ticker[]): DeskBuild {
  const R = pal.room;
  const B = pal.base;
  const T = kit.T;
  const h = (s: string) => hash01(`${o.owner}:${s}`);
  const colors = [B.pink, B.cyan, B.violet, B.orange, B.green, B.yellow, B.blue];
  const g = new T.Group();
  const finish = [R.wood, R.plywood, mix(R.paper, R.metal, 0.25), R.plastic][Math.floor(h('finish') * 4)]!;
  g.add(kit.box(1.5, 0.05, 0.8, finish, 0, DESK_Y - 0.05, 0, { rough: 0.55 }));
  if (h('legs') > 0.5) {
    g.add(kit.box(0.05, DESK_Y - 0.05, 0.74, R.metalDark, -0.7, 0, 0, { metal: 0.6 }), kit.box(0.05, DESK_Y - 0.05, 0.74, R.metalDark, 0.7, 0, 0, { metal: 0.6 }));
  } else {
    for (const [lx, lz] of [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]] as const) g.add(kit.box(0.045, DESK_Y - 0.05, 0.045, R.metalDark, lx, 0, lz, { metal: 0.6 }));
  }
  g.add(kit.box(0.38, 0.55, 0.6, mix(finish, R.plastic, 0.3), 0.5, 0, -0.05));
  g.add(kit.box(1.5, 0.36, 0.04, mix(o.color, R.fabric, 0.35), 0, DESK_Y, -0.39, { rough: 1 }));
  g.add(kit.box(0.7, 0.004, 0.32, mix(colors[Math.floor(h('mat') * colors.length)]!, R.plastic, 0.55), -0.05, DESK_Y, 0.15, { rough: 1 }));
  g.add(kit.box(0.46, 0.025, 0.15, R.plastic, -0.1, DESK_Y + 0.004, 0.15), kit.box(0.06, 0.022, 0.1, R.plastic, 0.22, DESK_Y + 0.004, 0.17));
  if (h('rgb') > 0.5) {
    const m = kit.ownMat(o.color, { basic: true }) as THREE.MeshBasicMaterial;
    g.add(kit.mesh(kit.boxGeo(0.47, 0.006, 0.155), m, -0.1, DESK_Y + 0.006, 0.15, 'none'));
    const hues = [B.pink, B.cyan, B.violet, B.green, B.orange];
    const k = h('rgb') * 9;
    tickers.push((now) => void m.color.set(hues[Math.floor(now / 700 + k) % hues.length]!));
  }

  const main = screenFor(o.team);
  const screens: Screen[] = [];
  const setup = Math.floor(h('setup') * 4);
  const place = (m: THREE.Group, x: number, z: number, ry: number) => {
    m.position.set(x, DESK_Y, z);
    m.rotation.y = ry;
    g.add(m);
    if (h(`sticky${x}`) > 0.55) {
      const n = kit.box(0.06, 0.06, 0.003, [B.yellow, B.pink, B.mint][Math.floor(h(`sc${x}`) * 3)]!, 0.2, 0.42, 0.02, { rough: 0.9 });
      n.rotation.z = (h(`rot${x}`) - 0.5) * 0.4;
      m.add(n);
    }
  };
  const scr = (kind: ScreenKind) => {
    const s = screen(kit, pal, kind, o.color);
    screens.push(s);
    return s.mat;
  };
  if (setup === 0) place(monitor(kit, pal, 0.95, 0.42, scr(main)), -0.1, -0.2, 0);
  else if (setup === 1) {
    place(monitor(kit, pal, 0.58, 0.36, scr(main)), -0.42, -0.2, 0.25);
    place(monitor(kit, pal, 0.58, 0.36, scr(main === 'code' ? 'terminal' : 'graph')), 0.2, -0.2, -0.25);
  } else if (setup === 2) {
    place(monitor(kit, pal, 0.66, 0.38, scr(main)), -0.25, -0.2, 0.1);
    place(monitor(kit, pal, 0.34, 0.56, scr('docs'), 0.1), 0.35, -0.2, -0.3);
  } else {
    place(monitor(kit, pal, 0.66, 0.38, scr(main)), -0.25, -0.2, 0);
    const lid = kit.group(kit.box(0.34, 0.22, 0.012, R.metal, 0, 0, 0, { metal: 0.6 }), kit.mesh(kit.planeGeo(0.3, 0.18), scr('terminal'), 0, 0.11, 0.007, 'none'));
    lid.position.set(0, 0.015, -0.11);
    lid.rotation.x = -0.25;
    const lap = kit.group(kit.box(0.34, 0.015, 0.24, R.metal, 0, 0, 0, { metal: 0.6 }), lid);
    lap.position.set(0.42, DESK_Y, -0.02);
    lap.rotation.y = -0.4;
    g.add(lap);
  }

  const all = items(kit, pal, tickers);
  const team = TEAM_ITEMS[o.team ?? ''] ?? [];
  const slots: Array<[number, number]> = [[-0.6, -0.22], [0.62, 0.22], [-0.62, 0.22], [0.12, -0.25]];
  const mine = [...PERSONAL].sort((a, b) => h(a) - h(b)).slice(0, 2 + Math.floor(h('n') * 2));
  const things = [...(team.length ? [team[Math.floor(h('team') * team.length)]!] : []), ...mine].slice(0, slots.length);
  things.forEach((name, i) => {
    const [sx, sz] = slots[i]!;
    g.add(all[name]!(sx, sz, colors[Math.floor(h(`c${name}`) * colors.length)]!));
  });

  const c = chair(kit, pal, h('chair') > 0.45 ? 'gaming' : 'office', h('chairc') > 0.5 ? R.plastic : mix(o.color, R.plastic, 0.55), o.color);
  c.position.set(0, 0, o.empty ? 0.62 : 0.9);
  c.rotation.y = o.empty ? (h('tuck') - 0.5) * 0.6 : 0;
  g.add(c);
  return { group: g, chair: c, screens };
}

/** A few of the owner's own things for a desk built elsewhere (the leads'), at the given spots. */
export function personalThings(kit: Kit, pal: GaragePalette, owner: string, spots: Array<[number, number]>, tickers: Ticker[]): THREE.Object3D[] {
  const B = pal.base;
  const colors = [B.pink, B.cyan, B.violet, B.orange, B.green, B.yellow, B.blue];
  const h = (s: string) => hash01(`${owner}:${s}`);
  const all = items(kit, pal, tickers);
  return [...PERSONAL].sort((a, b) => h(a) - h(b)).slice(0, spots.length).map((name, i) => all[name]!(spots[i]![0], spots[i]![1], colors[Math.floor(h(`c${name}`) * colors.length)]!));
}

/** A team's colour (the cockpit's specialty colours; the hot desks are the accent). */
export const teamColor = (pal: GaragePalette, team: string | null): string => (team ? roleColor(pal, 'worker', team) : pal.base.accent);
