// The garage as a 3D diorama: a concrete slab, two walls (the front ones cut away), the furniture each station needs, the
// decor that makes it an indie dev's garage, and the light. Built from a layout (where things are) and a palette (what they
// are made of); a station's look follows its state through `stations`. One world unit is one layout tile: x = gx, z = gy.
import type * as THREE from 'three';
import { LOFT_ELEVATION, type Layout, type LoungeAct, type StationPlacement, type Zone } from './layout.js';
import type { BoardCard, BoardColumn, StationId, StationStateName } from './model.js';
import { mix, roleColor, type GaragePalette } from './palette.js';
import { hash01, type Kit } from './kit3d.js';
import { chair as makeChair, monitor as makeMonitor, personalDesk, personalThings, screen, teamColor, type Screen } from './decor3d.js';

// ---------- dimensions ----------

/** Height of the council's mezzanine floor. */
export const LOFT_Y = 1.35;
/** World units per layout elevation pixel (the loft's 12 px is LOFT_Y). */
export const ELEV_K = LOFT_Y / LOFT_ELEVATION;
export const WALL_H = 3.4;
const WALL_T = 0.22;
const SLAB = 0.45;
const DESK_Y = 0.74;

/** What a station shows; `tick` runs every frame for the parts that move (blinks, smoke, LEDs). */
export interface StationVisual {
  id: StationId;
  set(state: StationStateName): void;
  tick(now: number, dt: number): void;
  /** A chair someone can push back (to perch on the desk); `home` and `away` (where it slides) are in its parent's frame. */
  seat?: { chair: THREE.Object3D; home: THREE.Vector3; away: THREE.Vector3 };
}

export interface RoomBuild {
  root: THREE.Group;
  stations: Map<StationId, StationVisual>;
  /** Ambient life: steam, twinkling bulbs, the clock, the neon's flicker. */
  tick(now: number, dt: number): void;
  setBoard(cards: BoardCard[]): void;
  /** What the lounge is up to (the foosball rods spin while someone plays). */
  setLounge(acts: ReadonlySet<LoungeAct>): void;
  /** The room's extent, for the camera. */
  bounds: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number };
}

/** Board columns as the wall shows them: TODO, DOING, REVIEW, DONE. */
const COLUMN_OF: Record<BoardColumn, number> = { backlog: 0, active: 1, blocked: 1, review: 2, testing: 2, failed: 1, done: 3 };
const COLUMN_NAMES = ['TODO', 'DOING', 'REVIEW', 'DONE'];

export function buildRoom(kit: Kit, L: Layout, pal: GaragePalette): RoomBuild {
  const T = kit.T;
  const R = pal.room;
  const B = pal.base;
  const root = new T.Group();
  const stations = new Map<StationId, StationVisual>();
  const tickers: Array<(now: number, dt: number) => void> = [];
  const cols = L.cols;
  const rows = L.rows;
  const add = (...o: THREE.Object3D[]) => root.add(...o);

  // A soft round dot: steam, smoke, dust and glows are made of it.
  const dotTex = kit.texture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, R.paper);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const glowSprite = (color: string, size: number, opacity = 0.55): THREE.Sprite | null => {
    if (!dotTex) return null;
    const m = kit.own(new T.SpriteMaterial({ map: dotTex, color: new T.Color(color), transparent: true, opacity, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
    const s = new T.Sprite(m);
    s.scale.set(size, size, 1);
    return s;
  };

  // A rising stream of puffs (steam over a mug, smoke over a jammed bench), drawn only while `on()`.
  const puffs = (parent: THREE.Object3D, x: number, y: number, z: number, color: string, on: () => boolean, o: { n?: number; rise?: number; size?: number; period?: number; opacity?: number } = {}) => {
    const n = o.n ?? 4;
    const rise = o.rise ?? 0.5;
    const size = o.size ?? 0.12;
    const period = o.period ?? 2400;
    const opacity = o.opacity ?? 0.35;
    const list: { s: THREE.Sprite | THREE.Mesh; m: THREE.SpriteMaterial | THREE.MeshBasicMaterial; k: number }[] = [];
    for (let i = 0; i < n; i++) {
      let s: THREE.Sprite | THREE.Mesh;
      let m: THREE.SpriteMaterial | THREE.MeshBasicMaterial;
      if (dotTex) {
        m = kit.own(new T.SpriteMaterial({ map: dotTex, color: new T.Color(color), transparent: true, opacity: 0, depthWrite: false }));
        s = new T.Sprite(m);
      } else {
        m = kit.own(new T.MeshBasicMaterial({ color: new T.Color(color), transparent: true, opacity: 0, depthWrite: false }));
        s = new T.Mesh(kit.sphereGeo(0.5, 8, 6), m);
      }
      parent.add(s);
      list.push({ s, m, k: i / n });
    }
    tickers.push((now) => {
      const visible = on();
      for (const p of list) {
        const u = ((now / period) + p.k) % 1;
        p.s.visible = visible;
        if (!visible) continue;
        const drift = Math.sin((now / 700) + p.k * 6) * 0.06;
        p.s.position.set(x + drift, y + u * rise, z + drift * 0.5);
        const sc = size * (0.6 + u * 1.4);
        p.s.scale.set(sc, sc, sc);
        p.m.opacity = opacity * Math.sin(Math.PI * u);
      }
    });
  };

  // ---------- the slab and the floor ----------

  const floorTex = kit.texture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = R.concrete;
    ctx.fillRect(0, 0, w, h);
    // Speckle and stains, placed by a fixed sequence so every garage looks the same.
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2600; i++) {
      ctx.globalAlpha = 0.05 + rnd() * 0.08;
      ctx.fillStyle = rnd() > 0.5 ? R.concreteDark : R.paper;
      ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = R.concreteDark;
      ctx.beginPath();
      ctx.ellipse(rnd() * w, rnd() * h, 20 + rnd() * 50, 12 + rnd() * 30, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Saw cuts every two tiles (the texture spans four).
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = R.concreteDark;
    for (const k of [0, w / 2]) {
      ctx.fillRect(k, 0, 2, h);
      ctx.fillRect(0, k, w, 2);
    }
    ctx.globalAlpha = 1;
  }, [cols / 4, rows / 4]);
  const floorMat = kit.own(new T.MeshStandardMaterial({ color: new T.Color(floorTex ? R.paper : R.concrete), map: floorTex, roughness: 0.92 }));
  const floor = kit.mesh(kit.planeGeo(cols, rows), floorMat, (cols - 1) / 2, 0, (rows - 1) / 2, 'receive');
  floor.rotation.x = -Math.PI / 2;
  add(floor);
  // The slab under it: the diorama's cut edge.
  add(kit.box(cols + WALL_T, SLAB, rows + WALL_T, R.slab, (cols - 1) / 2 - WALL_T / 2, -SLAB - 0.002, (rows - 1) / 2 - WALL_T / 2, { rough: 0.95 }));

  // ---------- walls ----------

  const brickTex = kit.texture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = R.wallTrim;
    ctx.fillRect(0, 0, w, h);
    const bh = h / 8;
    const bw = w / 4;
    let s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let r = 0; r < 8; r++) {
      for (let c = -1; c < 5; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0);
        ctx.fillStyle = mix(R.brick, R.woodDark, rnd() * 0.35);
        ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
  }, [rows / 2, WALL_H / 1.4]);
  const backMat = kit.mat(R.wall, { rough: 0.95 });
  const leftMat = brickTex ? kit.own(new T.MeshStandardMaterial({ map: brickTex, roughness: 0.95 })) : kit.mat(R.brick, { rough: 0.95 });
  const back = kit.box(cols + WALL_T, WALL_H + SLAB, WALL_T, backMat, (cols - 1) / 2 - WALL_T / 2, -SLAB, -0.5 - WALL_T / 2);
  const left = kit.box(WALL_T, WALL_H + SLAB, rows, leftMat, -0.5 - WALL_T / 2, -SLAB, (rows - 1) / 2);
  add(back, left);
  // Trim: skirting along the floor and a cap along the cut top edge.
  add(kit.box(cols, 0.12, 0.04, R.wallTrim, (cols - 1) / 2, 0, -0.48));
  add(kit.box(0.04, 0.12, rows, R.wallTrim, -0.48, 0, (rows - 1) / 2));
  add(kit.box(cols + WALL_T, 0.06, WALL_T + 0.04, R.woodDark, (cols - 1) / 2 - WALL_T / 2, WALL_H, -0.5 - WALL_T / 2));
  add(kit.box(WALL_T + 0.04, 0.06, rows + WALL_T, R.woodDark, -0.5 - WALL_T / 2, WALL_H, (rows - 1) / 2 - WALL_T / 2));

  // ---------- the council's mezzanine ----------

  const loftStations = L.ids().map((id) => L.resolve(id)!).filter((s) => s.kind === 'loft');
  const loftRegion = L.regions.find((r) => r.id === 'loft');
  let mezzX1 = -0.5;
  if (loftStations.length && loftRegion && loftRegion.h > 0) {
    const maxX = Math.max(...loftStations.flatMap((s) => s.footprint.map((p) => p.gx)), ...loftStations.map((s) => s.grid.gx));
    mezzX1 = Math.min(cols - 0.5, maxX + 1.5);
    const z0 = loftRegion.gy - 0.5;
    const z1 = loftRegion.gy + loftRegion.h - 0.5;
    const w = mezzX1 + 0.5;
    const d = z1 - z0;
    const cx = mezzX1 - w / 2;
    const cz = (z0 + z1) / 2;
    add(kit.box(w, 0.16, d, R.wood, cx, LOFT_Y - 0.16, cz, { rough: 0.7 }));
    // Plank seams on top.
    for (let x = -0.5 + 0.5; x < mezzX1; x += 0.5) add(kit.box(0.012, 0.004, d, R.woodDark, x, LOFT_Y, cz));
    // Posts and a steel beam under the front edge.
    add(kit.box(w, 0.14, 0.12, R.metalDark, cx, LOFT_Y - 0.3, z1 - 0.06, { metal: 0.6, rough: 0.5 }));
    for (let x = 0; x <= mezzX1 + 0.01; x += 3) add(kit.box(0.1, LOFT_Y - 0.16, 0.1, R.metalDark, Math.min(x, mezzX1 - 0.06), 0, z1 - 0.06, { metal: 0.6, rough: 0.5 }));
    // Railing along the front, open where the stairs come up.
    const stairsRight = mezzX1 + 3 <= cols - 0.5;
    const railTo = stairsRight ? mezzX1 : mezzX1 - 1.2;
    add(kit.box(railTo + 0.5, 0.05, 0.05, R.woodDark, (railTo - 0.5) / 2, LOFT_Y + 0.88, z1 - 0.04));
    for (let x = -0.4; x < railTo; x += 0.32) add(kit.box(0.025, 0.88, 0.025, R.metalDark, x, LOFT_Y, z1 - 0.04, { metal: 0.5 }));
    if (stairsRight) {
      // A side rail, and steps down to the right.
      add(kit.box(0.05, 0.05, d, R.woodDark, mezzX1 - 0.02, LOFT_Y + 0.88, cz));
      for (let z = z0 + 0.1; z < z1 - 1.1; z += 0.32) add(kit.box(0.025, 0.88, 0.025, R.metalDark, mezzX1 - 0.02, LOFT_Y, z, { metal: 0.5 }));
      const steps = 7;
      for (let i = 0; i < steps; i++) {
        const top = LOFT_Y * (1 - (i + 1) / (steps + 1));
        add(kit.box(0.36, 0.06, 0.9, R.wood, mezzX1 + 0.18 + i * 0.36, top, z1 - 0.55));
      }
      add(kit.box(steps * 0.36, 0.06, 0.04, R.metalDark, mezzX1 + (steps * 0.36) / 2, LOFT_Y * 0.55, z1 - 0.08, { metal: 0.5 }));
    } else {
      const steps = 7;
      for (let i = 0; i < steps; i++) add(kit.box(1.0, 0.06, 0.36, R.wood, mezzX1 - 0.6, LOFT_Y * (1 - (i + 1) / (steps + 1)), z1 + 0.18 + i * 0.36));
    }
    // A rug and a floor lamp up there: the council's lounge.
    const rug = kit.mesh(kit.planeGeo(Math.max(1, w - 0.8), Math.max(1, d - 0.8)), kit.mat(R.rugAlt, { rough: 1 }), cx, LOFT_Y + 0.004, cz, 'receive');
    rug.rotation.x = -Math.PI / 2;
    add(rug);
  }

  // ---------- the back strip: a bookshelf and a guitar at the left; the lounge takes the right ----------

  const stripZ = 0.05; // the two wall rows: z from -0.5 to 1.5
  const LG = L.lounge;
  const boardX0 = Math.max(3.2, mezzX1 + 1);
  const boardX1 = Math.max(boardX0 + 3, LG.gx - 0.8);

  const shelfX = 1.0;
  const shelf = kit.group(kit.box(1.5, 2.0, 0.42, R.woodDark, 0, 0, 0));
  const bookColors = [B.cyan, B.violet, B.orange, B.green, B.pink, B.yellow, B.blue, R.paper];
  for (let s = 0; s < 4; s++) {
    shelf.add(kit.box(1.42, 0.03, 0.38, R.wood, 0, 0.12 + s * 0.48, 0.02));
    let x = -0.64;
    let k = 0;
    while (x < 0.55) {
      const bw = 0.06 + hash01(`book${s}${k}`) * 0.07;
      const bh = 0.26 + hash01(`bookh${s}${k}`) * 0.14;
      if (hash01(`gap${s}${k}`) > 0.86) x += 0.12;
      else shelf.add(kit.box(bw, bh, 0.28, bookColors[(s * 3 + k) % bookColors.length]!, x + bw / 2, 0.15 + s * 0.48, 0.03, { rough: 0.7 }));
      x += bw + 0.008;
      k++;
    }
  }
  shelf.add(kit.box(0.3, 0.22, 0.3, R.cardboard, 0.45, 2.0, 0));
  shelf.position.set(shelfX, 0, stripZ - 0.22);
  add(shelf);
  const guitar = kit.group(
    kit.cyl(0.2, 0.08, R.fabricAlt, 0, 0.32, 0, { seg: 20 }),
    kit.cyl(0.15, 0.08, R.fabricAlt, 0, 0.6, 0, { seg: 20 }),
    kit.cyl(0.05, 0.081, R.woodDark, 0, 0.42, 0.001),
    kit.box(0.06, 0.62, 0.04, R.woodDark, 0, 0.66, 0),
    kit.box(0.09, 0.14, 0.04, R.woodDark, 0, 1.28, 0),
    kit.box(0.3, 0.04, 0.2, R.metalDark, 0, 0, 0.05),
  );
  guitar.children.slice(0, 3).forEach((c) => (c.rotation.x = Math.PI / 2));
  guitar.position.set(shelfX + 1.15, 0, stripZ + 0.1);
  guitar.rotation.set(-0.18, -0.3, 0);
  add(guitar);

  const plant = (x: number, z: number, scale: number, seed: string): THREE.Group => {
    const g = kit.group(kit.cyl(0.2, 0.36, R.pot, 0, 0, 0, { rTop: 0.24 }), kit.cyl(0.21, 0.02, R.woodDark, 0, 0.35, 0));
    const leaves = 7;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2 + hash01(seed + i) * 0.6;
      const leaf = kit.ball(0.2, i % 2 ? R.plant : R.plantDark, Math.cos(a) * 0.2, 0.62 + hash01(seed + 'h' + i) * 0.35, Math.sin(a) * 0.2);
      leaf.scale.set(1.2, 0.35, 0.7);
      leaf.rotation.set(0, -a, 0.5);
      g.add(leaf);
    }
    g.add(kit.cyl(0.02, 0.5, R.plantDark, 0, 0.35, 0));
    g.scale.setScalar(scale);
    g.position.set(x, 0, z);
    const sway = hash01(seed) * 6;
    tickers.push((now) => (g.rotation.z = Math.sin(now / 1900 + sway) * 0.015));
    return g;
  };
  add(plant(shelfX + 1.9, stripZ + 0.45, 0.8, 'nook'));

  // ---------- the lounge: kitchen, couch, arcade, foosball, a beanbag ----------

  const foosRods: THREE.Object3D[] = [];
  let foosball = false;
  {
    const lx0 = LG.gx - 0.5;
    const lx1 = LG.gx + LG.w - 0.5;
    const lz1 = LG.gy + LG.h - 0.5;
    const warm = R.lamp;
    const floorTint = kit.mesh(kit.planeGeo(lx1 - lx0 - 0.1, lz1 + 0.45), kit.mat(mix(warm, R.concreteDark, 0.82), { rough: 0.95 }), (lx0 + lx1) / 2, 0.003, (lz1 - 0.5) / 2, 'receive');
    floorTint.rotation.x = -Math.PI / 2;
    add(floorTint);
    const edge = kit.mat(warm, { basic: true });
    add(kit.mesh(kit.boxGeo(lx1 - lx0 - 0.1, 0.012, 0.04), edge, (lx0 + lx1) / 2, 0.008, lz1 - 0.05, 'none'));
    add(kit.mesh(kit.boxGeo(0.04, 0.012, lz1 + 0.45), edge, lx0 + 0.05, 0.008, (lz1 - 0.5) / 2, 'none'));
    for (const p of LG.props) {
      switch (p.kind) {
        case 'kitchen': {
          const fridge = kit.group(
            kit.box(0.72, 1.6, 0.66, R.mug, 0, 0, 0, { rough: 0.4 }),
            kit.box(0.72, 0.012, 0.67, R.metal, 0, 1.06, 0),
            kit.box(0.04, 0.38, 0.04, R.metal, 0.28, 1.12, 0.35, { metal: 0.8, rough: 0.3 }),
            kit.box(0.04, 0.5, 0.04, R.metal, 0.28, 0.35, 0.35, { metal: 0.8, rough: 0.3 }),
          );
          [B.cyan, B.pink, B.yellow, B.green, B.violet].forEach((c, i) => fridge.add(kit.box(0.1, 0.07, 0.01, c, -0.2 + (i % 2) * 0.16, 1.15 + Math.floor(i / 2) * 0.12, 0.335)));
          fridge.position.set(p.gx - 0.75, 0, stripZ - 0.1);
          add(fridge);
          const counter = kit.group(
            kit.box(1.2, 0.86, 0.6, R.plywood, 0, 0, 0),
            kit.box(1.24, 0.05, 0.64, R.woodDark, 0, 0.86, 0),
            kit.box(0.34, 0.36, 0.3, R.metalDark, -0.25, 0.91, -0.05, { metal: 0.5, rough: 0.4 }),
            kit.box(0.08, 0.05, 0.08, R.metal, -0.25, 1.05, 0.12, { metal: 0.8 }),
            kit.cyl(0.04, 0.07, R.mug, -0.25, 0.91, 0.12),
            kit.cyl(0.05, 0.11, R.mug, 0.18, 0.91, 0.05),
            kit.cyl(0.05, 0.11, B.accent, 0.34, 0.91, -0.08),
            kit.box(0.28, 0.2, 0.2, R.cardboard, 0.3, 0.91, -0.15),
          );
          counter.position.set(p.gx + 0.35, 0, stripZ - 0.1);
          add(counter);
          puffs(root, p.gx + 0.1, 1.03, stripZ + 0.02, R.paper, () => true, { n: 5, rise: 0.6, size: 0.1, period: 3200, opacity: 0.25 });
          break;
        }
        case 'couch': {
          const couch = kit.group(
            kit.box(2.3, 0.42, 0.85, R.fabric, 0, 0.08, 0),
            kit.box(2.3, 0.55, 0.2, R.fabric, 0, 0.35, -0.33),
            kit.box(0.2, 0.62, 0.85, R.fabric, -1.15, 0.08, 0),
            kit.box(0.2, 0.62, 0.85, R.fabric, 1.15, 0.08, 0),
            kit.box(1.0, 0.1, 0.62, mix(R.fabric, R.paper, 0.08), -0.52, 0.5, 0.05),
            kit.box(1.0, 0.1, 0.62, mix(R.fabric, R.paper, 0.08), 0.52, 0.5, 0.05),
            kit.box(0.34, 0.3, 0.12, R.fabricAlt, 0.78, 0.6, -0.2),
            kit.box(0.06, 0.08, 0.06, R.woodDark, -1.1, 0, 0.35),
            kit.box(0.06, 0.08, 0.06, R.woodDark, 1.1, 0, 0.35),
          );
          couch.position.set(p.gx, 0, p.gy - 0.1);
          add(couch);
          const rug = kit.mesh(kit.planeGeo(3.2, 2.0), kit.mat(R.rug, { rough: 1 }), p.gx, 0.006, p.gy + 0.9, 'receive');
          rug.rotation.x = -Math.PI / 2;
          add(rug);
          break;
        }
        case 'arcade': {
          const cab = kit.group(
            kit.box(0.72, 1.7, 0.7, R.plastic, 0, 0, 0),
            kit.box(0.74, 0.08, 0.72, R.neon, 0, 1.7, 0, { basic: true }),
            kit.box(0.72, 0.18, 0.3, R.plastic, 0, 0.92, 0.42),
            kit.box(0.02, 1.5, 0.04, R.neon, -0.37, 0.1, 0.33, { basic: true }),
            kit.box(0.02, 1.5, 0.04, R.neon, 0.37, 0.1, 0.33, { basic: true }),
            kit.cyl(0.04, 0.03, B.red, -0.12, 1.1, 0.42), kit.cyl(0.04, 0.03, B.yellow, 0.06, 1.1, 0.46), kit.cyl(0.04, 0.03, B.cyan, 0.2, 1.1, 0.42),
          );
          const s = screen(kit, pal, 'design', B.pink);
          s.mat.color.set(B.white);
          if (s.tex) tickers.push((_now, dt) => void (s.tex!.offset.y = (s.tex!.offset.y + dt * 0.0003) % 1));
          const face = kit.mesh(kit.planeGeo(0.56, 0.44), s.mat, 0, 1.35, 0.352, 'none');
          face.rotation.x = -0.2;
          cab.add(face);
          cab.position.set(p.gx, 0, p.gy - 0.15);
          add(cab);
          break;
        }
        case 'foosball': {
          // An open box: the green field inside four walls, the rods across the top.
          const ft = kit.group(
            kit.box(1.3, 0.06, 0.75, R.woodDark, 0, 0.6, 0), kit.box(1.2, 0.01, 0.65, R.plant, 0, 0.66, 0),
            kit.box(1.3, 0.2, 0.05, R.woodDark, 0, 0.6, -0.35), kit.box(1.3, 0.2, 0.05, R.woodDark, 0, 0.6, 0.35),
            kit.box(0.05, 0.2, 0.75, R.woodDark, -0.63, 0.6, 0), kit.box(0.05, 0.2, 0.75, R.woodDark, 0.63, 0.6, 0),
          );
          for (const [a, b] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]] as const) ft.add(kit.box(0.08, 0.62, 0.08, R.woodDark, a, 0, b));
          for (let i = 0; i < 4; i++) {
            // A rod across the table (its axis is the spinner's y), three little players hanging from it.
            const rod = new T.Group();
            const spin = new T.Group();
            spin.add(kit.cyl(0.012, 1.7, R.metal, 0, -0.85, 0, { metal: 0.8 }));
            for (let k = -1; k <= 1; k++) spin.add(kit.box(0.12, 0.04, 0.04, i % 2 ? B.red : B.blue, -0.06, k * 0.2, 0));
            rod.add(spin);
            rod.rotation.z = Math.PI / 2;
            rod.position.set(0, 0.8, -0.27 + i * 0.18);
            ft.add(rod);
            foosRods.push(spin);
          }
          ft.position.set(p.gx, 0, p.gy);
          add(ft);
          break;
        }
        case 'beanbag': {
          const bean = kit.ball(0.42, R.fabricAlt, p.gx, 0.26, p.gy - 0.05, { rough: 1 });
          bean.scale.set(1, 0.62, 1);
          add(bean);
          break;
        }
      }
    }
    const couch = LG.props.find((p) => p.kind === 'couch');
    const sx = couch ? couch.gx : (lx0 + lx1) / 2;
    const sign = kit.labelPlane('LOUNGE', 0.5, { fg: R.paper, halo: B.pink, px: 72, bold: true, font: 'mono' });
    if (sign) {
      const w = (sign.geometry as THREE.PlaneGeometry).parameters.width;
      add(kit.box(w + 0.1, 0.6, 0.05, R.plastic, sx, 2.25, -0.47));
      sign.position.set(sx, 2.55, -0.44);
      add(sign);
    }
    add(new T.PointLight(new T.Color(B.pink), 2.2, 5, 1.6).translateX(sx).translateY(2.3).translateZ(0.9));
    add(plant(lx1 - 0.4, lz1 - 0.45, 0.9, 'lounge'));
    tickers.push((now) => {
      for (let i = 0; i < foosRods.length; i++) {
        const r = foosRods[i]!;
        r.rotation.y = foosball ? Math.sin(now / (170 + i * 37)) * 0.9 : r.rotation.y * 0.95;
      }
    });
  }

  // ---------- the back wall: the kanban board, the neon, the clock, posters ----------

  const boardY0 = 1.55;
  const boardH = 1.45;
  const boardW = boardX1 - boardX0;
  const boardCx = (boardX0 + boardX1) / 2;
  const wallZ = -0.5 + 0.005;
  add(kit.box(boardW + 0.12, boardH + 0.12, 0.05, R.woodDark, boardCx, boardY0 - 0.06, wallZ + 0.025));
  add(kit.box(boardW, boardH, 0.03, R.cork, boardCx, boardY0, wallZ + 0.06, { rough: 1 }));
  const colW = boardW / 4;
  const boardFace = wallZ + 0.08;
  COLUMN_NAMES.forEach((name, i) => {
    const lab = kit.labelPlane(name, 0.14, { fg: R.woodDark, bg: R.paper, px: 40, bold: true });
    if (lab) {
      lab.position.set(boardX0 + colW * (i + 0.5), boardY0 + boardH - 0.13, boardFace + 0.002);
      add(lab);
    }
    if (i > 0) add(kit.box(0.015, boardH - 0.3, 0.005, R.woodDark, boardX0 + colW * i, boardY0 + 0.08, boardFace));
  });
  const notes = new T.Group();
  add(notes);
  const setBoard = (cards: BoardCard[]): void => {
    for (const c of [...notes.children]) {
      notes.remove(c);
      const m = c as THREE.Mesh;
      (m.material as THREE.Material).dispose();
      const map = (m.material as THREE.MeshStandardMaterial).map;
      map?.dispose();
    }
    const perCol: BoardCard[][] = [[], [], [], []];
    for (const c of cards) perCol[COLUMN_OF[c.column] ?? 0]!.push(c);
    const noteW = Math.min(0.32, colW / 2.6);
    const noteH = noteW * 0.82;
    perCol.forEach((list, ci) => {
      const perRow = Math.max(1, Math.floor((colW - 0.1) / (noteW + 0.06)));
      list.slice(0, perRow * 4).forEach((c, k) => {
        const failed = c.column === 'failed' || c.column === 'blocked';
        const color = failed ? R.failed : roleColor(pal, 'worker', c.persona ? c.persona.split('-')[0] : null);
        const tex = kit.texture(128, 104, (ctx, w, h) => {
          ctx.fillStyle = mix(color, R.paper, 0.35);
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = mix(color, R.woodDark, 0.5);
          ctx.fillRect(0, 0, w, 14);
          ctx.fillStyle = R.woodDark;
          ctx.font = '700 26px ui-monospace, Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(c.key.replace(/^TASK-/, '#'), w / 2, h / 2 + 12);
        });
        const mat = new T.MeshStandardMaterial({ color: new T.Color(tex ? R.paper : mix(color, R.paper, 0.35)), map: tex, roughness: 0.9 });
        const note = new T.Mesh(kit.planeGeo(noteW, noteH), mat);
        const r = Math.floor(k / perRow);
        const q = k % perRow;
        const x0 = boardX0 + colW * ci + 0.08 + noteW / 2;
        note.position.set(x0 + q * (noteW + 0.06), boardY0 + boardH - 0.38 - r * (noteH + 0.07), boardFace + 0.003 + k * 0.0005);
        note.rotation.z = (hash01(c.key) - 0.5) * 0.18;
        note.receiveShadow = true;
        notes.add(note);
        // A pin.
        const pin = kit.ball(0.022, failed ? R.failed : B.red, note.position.x, note.position.y + noteH / 2 - 0.04, note.position.z + 0.01);
        pin.castShadow = false;
        notes.add(pin);
      });
    });
  };

  // The neon sign: over the mezzanine (or the kitchen corner), with its own coloured light.
  const neonX = mezzX1 > 0 ? Math.max(1.4, mezzX1 / 2) : 1.6;
  const neon = kit.labelPlane('ship it', 0.55, { fg: R.paper, halo: R.neon, px: 72, bold: true, font: 'mono' });
  const neonLight = new T.PointLight(new T.Color(R.neon), 3.5, 5, 1.6);
  neonLight.position.set(neonX, 2.75, 0.2);
  add(neonLight);
  if (neon) {
    neon.position.set(neonX, 2.85, wallZ + 0.03);
    add(neon);
    const nm = neon.material as THREE.MeshBasicMaterial;
    tickers.push((now) => {
      // A neon that has seen things: a stutter every few seconds.
      const t = now % 7000;
      const flick = t > 6700 && t < 6900 && Math.floor(t / 45) % 2 === 0;
      nm.opacity = flick ? 0.35 : 1;
      neonLight.intensity = flick ? 1 : 3.5;
    });
  }

  // The clock, on real time.
  const clockX = LG.gx + 0.4;
  const clock = kit.group(
    kit.cyl(0.32, 0.05, R.woodDark, 0, 0, 0, { seg: 32 }),
    kit.cyl(0.29, 0.052, R.paper, 0, 0.001, 0, { seg: 32 }),
  );
  clock.rotation.x = Math.PI / 2;
  clock.position.set(clockX, 2.65, wallZ + 0.03);
  add(clock);
  const hand = (len: number, w: number, color: string) => {
    const pivot = new T.Group();
    pivot.add(kit.box(w, len, 0.012, color, 0, 0, 0));
    pivot.position.set(clockX, 2.65, wallZ + 0.085);
    add(pivot);
    return pivot;
  };
  const hourHand = hand(0.17, 0.035, R.woodDark);
  const minHand = hand(0.24, 0.022, R.woodDark);
  const secHand = hand(0.26, 0.008, R.failed);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    add(kit.box(0.015, i % 3 ? 0.03 : 0.06, 0.005, R.woodDark, clockX + Math.sin(a) * 0.24, 2.65 + Math.cos(a) * 0.24 - 0.015, wallZ + 0.085));
  }
  tickers.push((now) => {
    const d = new Date(now);
    const s = d.getSeconds() + d.getMilliseconds() / 1000;
    const m = d.getMinutes() + s / 60;
    const h = (d.getHours() % 12) + m / 60;
    secHand.rotation.z = -(s / 60) * Math.PI * 2;
    minHand.rotation.z = -(m / 60) * Math.PI * 2;
    hourHand.rotation.z = -(h / 12) * Math.PI * 2;
  });

  // Two posters: a game you are making, a launch you are planning.
  const poster = (x: number, y: number, w: number, h: number, a: string, b: string, c: string) => {
    add(kit.box(w + 0.06, h + 0.06, 0.02, R.woodDark, x, y - 0.03, wallZ + 0.01));
    add(kit.box(w, h, 0.01, a, x, y, wallZ + 0.025, { rough: 0.6 }));
    add(kit.box(w, h * 0.38, 0.012, b, x, y, wallZ + 0.03, { rough: 0.6 }));
    const sun = kit.cyl(w * 0.22, 0.014, c, x, y + h * 0.55, wallZ + 0.035, { basic: true, seg: 24 });
    sun.rotation.x = Math.PI / 2;
    sun.castShadow = false;
    add(sun);
  };
  // One over the kitchen counter's end, one between the board and the lounge when there is room.
  const couchProp = LG.props.find((p) => p.kind === 'couch');
  if (couchProp && couchProp.gx - 1.2 - (LG.gx + 1.2) > 0.9) poster((couchProp.gx - 1.2 + LG.gx + 1.2) / 2 + 0.15, 1.5, 0.55, 0.78, B.greenDeep, B.teal, B.mint);
  if (LG.gx - 0.5 - boardX1 > 0.9) poster((boardX1 + LG.gx - 0.5) / 2, 1.3, 0.6, 0.85, B.violetDeep, B.pink, B.yellow);

  // ---------- the left wall: window, pegboard, the roll-up door ----------

  const wallX = -0.5 + 0.005;
  const winZ = Math.min(rows - 6, Math.max(3.5, rows * 0.32));
  const win = kit.group(
    kit.box(0.06, 1.2, 1.7, R.woodDark, 0, 0, 0),
    kit.box(0.02, 1.08, 1.58, R.window, 0.035, 0.06, 0, { basic: true }),
    kit.box(0.04, 1.08, 0.04, R.woodDark, 0.05, 0.06, 0),
    kit.box(0.04, 0.04, 1.58, R.woodDark, 0.05, 0.58, 0),
    kit.box(0.2, 0.05, 1.8, R.wallTrim, 0.1, -0.05, 0),
  );
  const moon = kit.ball(0.13, R.moon, 0.05, 0.92, 0.42, { basic: true });
  moon.scale.set(0.2, 1, 1);
  moon.castShadow = false;
  win.add(moon);
  for (let i = 0; i < 9; i++) {
    const star = kit.box(0.005, 0.02, 0.02, R.moon, 0.048, 0.2 + hash01(`star${i}`) * 0.95, -0.7 + hash01(`starz${i}`) * 1.3, { basic: true });
    star.castShadow = false;
    win.add(star);
  }
  win.position.set(wallX, 1.05, winZ);
  add(win);
  add(plant(0.1, winZ + 0.55, 0.55, 'sill').translateY(0).translateZ(0));

  const pegZ = winZ + 2.6;
  if (pegZ + 1 < rows - 5) {
    const peg = kit.group(kit.box(0.04, 1.0, 1.7, R.plywood, 0, 0, 0));
    for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) peg.add(kit.box(0.005, 0.02, 0.02, R.woodDark, 0.022, 0.08 + r * 0.17, -0.76 + c * 0.17));
    // Tools: a hammer, a wrench, a saw, pliers, a tape roll.
    peg.add(kit.box(0.05, 0.36, 0.05, R.woodDark, 0.05, 0.4, -0.6), kit.box(0.06, 0.08, 0.2, R.metalDark, 0.05, 0.76, -0.6, { metal: 0.7 }));
    peg.add(kit.box(0.03, 0.42, 0.06, R.metal, 0.05, 0.3, -0.25, { metal: 0.8, rough: 0.3 }));
    peg.add(kit.box(0.02, 0.18, 0.55, R.metal, 0.05, 0.25, 0.25, { metal: 0.8, rough: 0.3 }), kit.box(0.04, 0.08, 0.16, B.red, 0.05, 0.25, 0.6));
    const roll = kit.cyl(0.11, 0.06, R.tape, 0.06, 0.72, 0.5, { seg: 20 });
    roll.rotation.z = Math.PI / 2;
    peg.add(roll);
    peg.position.set(wallX + 0.02, 1.15, pegZ);
    add(peg);
    // A shelf with paint cans and boxes above the bench end.
    add(kit.box(0.4, 0.04, 1.6, R.wood, wallX + 0.2, 2.35, pegZ));
    [B.cyan, B.orange, R.paper].forEach((c, i) => add(kit.cyl(0.09, 0.2, c, wallX + 0.2, 2.39, pegZ - 0.55 + i * 0.25, { metal: 0.4, rough: 0.5 })));
    add(kit.box(0.34, 0.26, 0.4, R.cardboard, wallX + 0.2, 2.39, pegZ + 0.5));
  }

  // The garage door near the front: rolled half up, the street dark outside, a little cold light spilling in.
  const doorZ = rows - 3.2;
  if (doorZ > winZ + 2) {
    const doorW = 2.6;
    const opening = kit.box(0.02, 1.0, doorW, R.window, wallX + 0.004, 0, doorZ, { basic: true });
    add(opening);
    const door = kit.group();
    for (let i = 0; i < 8; i++) door.add(kit.box(0.05, 0.16, doorW, i % 2 ? R.metal : mix(R.metal, R.metalDark, 0.25), 0, i * 0.165, 0, { metal: 0.5, rough: 0.45 }));
    door.add(kit.box(0.08, 0.06, 0.4, R.metalDark, 0.03, 0.02, 0));
    door.position.set(wallX + 0.04, 1.0, doorZ);
    add(door);
    add(kit.box(0.12, 2.4, 0.12, R.metalDark, wallX + 0.06, 0, doorZ - doorW / 2 - 0.06), kit.box(0.12, 2.4, 0.12, R.metalDark, wallX + 0.06, 0, doorZ + doorW / 2 + 0.06));
    add(kit.box(0.3, 0.3, doorW + 0.4, R.metalDark, wallX + 0.15, 2.4, doorZ));
    const spill = glowSprite(R.sun, 2.4, 0.18);
    if (spill) {
      spill.position.set(0.4, 0.4, doorZ);
      add(spill);
    }
  }

  // ---------- string lights along the top of both walls ----------

  const bulbs: THREE.Mesh[] = [];
  const bulbMat = kit.ownMat(R.bulb, { basic: true });
  const wireMat = kit.own(new T.LineBasicMaterial({ color: new T.Color(R.plastic) }));
  const strand = (from: THREE.Vector3, to: THREE.Vector3, sag: number, spacing: number) => {
    const len = from.distanceTo(to);
    const n = Math.max(2, Math.round(len / spacing));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n * 4; i++) {
      const u = i / (n * 4);
      const p = from.clone().lerp(to, u);
      p.y -= Math.sin(Math.PI * u) * sag;
      pts.push(p);
    }
    const geo = kit.own(new T.BufferGeometry().setFromPoints(pts));
    add(new T.Line(geo, wireMat));
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const p = from.clone().lerp(to, u);
      p.y -= Math.sin(Math.PI * u) * sag + 0.05;
      const b = kit.mesh(kit.sphereGeo(0.045, 10, 8), bulbMat, p.x, p.y, p.z, 'none');
      bulbs.push(b);
      add(b);
      const g = glowSprite(R.bulb, 0.35, 0.35);
      if (g) {
        g.position.copy(p);
        add(g);
      }
    }
  };
  const top = WALL_H - 0.15;
  for (let x = 0; x < cols - 1; x += 4) strand(new T.Vector3(x - 0.4, top, -0.38), new T.Vector3(Math.min(cols - 0.6, x + 3.6), top, -0.38), 0.32, 0.55);
  for (let z = 0; z < rows - 1; z += 4) strand(new T.Vector3(-0.38, top, z - 0.4), new T.Vector3(-0.38, top, Math.min(rows - 0.6, z + 3.6)), 0.32, 0.55);
  tickers.push((now) => {
    // A slow shimmer along the strand.
    const k = 0.9 + Math.sin(now / 900) * 0.06;
    (bulbMat as THREE.MeshBasicMaterial).color.set(R.bulb).multiplyScalar(k);
  });

  // ---------- light ----------

  const hemi = new T.HemisphereLight(new T.Color(R.hemiSky), new T.Color(R.hemiGround), 1.1);
  add(hemi);
  const key = new T.DirectionalLight(new T.Color(R.sun), 1.25);
  const span = Math.max(cols, rows);
  key.position.set(-span * 0.55, span * 0.9, rows * 0.25);
  key.target.position.set((cols - 1) / 2, 0, (rows - 1) / 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera as THREE.OrthographicCamera;
  sc.left = -span;
  sc.right = span;
  sc.top = span;
  sc.bottom = -span;
  sc.near = 0.5;
  sc.far = span * 3;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  add(key, key.target);
  // A warm fill from the front, so faces read.
  const fill = new T.DirectionalLight(new T.Color(R.lamp), 0.55);
  fill.position.set(cols * 1.2, span * 0.7, rows * 1.4);
  fill.target.position.set((cols - 1) / 2, 0, (rows - 1) / 2);
  add(fill, fill.target);
  // The string lights' warmth, as a few point lights along each wall.
  for (let x = 2; x < cols; x += Math.max(5, cols / 3)) {
    const p = new T.PointLight(new T.Color(R.bulb), 5, 9, 1.4);
    p.position.set(x, WALL_H - 0.6, 0.4);
    add(p);
  }
  for (let z = 4; z < rows; z += Math.max(6, rows / 2)) {
    const p = new T.PointLight(new T.Color(R.bulb), 4, 8, 1.4);
    p.position.set(0.3, WALL_H - 0.6, z);
    add(p);
  }

  // ---------- team zones ----------

  /** A team-tinted floor from (x0, z0) to (x1, z1), with a glowing edge along the front and the right. */
  const teamFloor = (x0: number, z0: number, x1: number, z1: number, color: string) => {
    const f = kit.mesh(kit.planeGeo(x1 - x0 - 0.06, z1 - z0 - 0.06), kit.mat(mix(color, R.concreteDark, 0.8), { rough: 0.95 }), (x0 + x1) / 2, 0.003, (z0 + z1) / 2, 'receive');
    f.rotation.x = -Math.PI / 2;
    add(f);
    const edge = kit.mat(color, { basic: true });
    add(kit.mesh(kit.boxGeo(x1 - x0 - 0.06, 0.012, 0.04), edge, (x0 + x1) / 2, 0.008, z1 - 0.05, 'none'));
    add(kit.mesh(kit.boxGeo(0.04, 0.012, z1 - z0 - 0.06), edge, x1 - 0.05, 0.008, (z0 + z1) / 2, 'none'));
  };

  /** A low wall along x or along z: plywood, a dark cap, and a strip of the team's colour. */
  const lowWall = (x0: number, z0: number, x1: number, z1: number, color: string) => {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const len = Math.max(0.1, alongX ? x1 - x0 : z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const w = alongX ? len : 0.1;
    const d = alongX ? 0.1 : len;
    add(kit.box(w, 0.95, d, mix(R.plywood, R.woodDark, 0.25), cx, 0, cz, { rough: 0.8 }));
    add(kit.box(alongX ? len : 0.13, 0.05, alongX ? 0.13 : len, R.woodDark, cx, 0.95, cz));
    add(kit.mesh(kit.boxGeo(alongX ? len : 0.135, 0.025, alongX ? 0.135 : len), kit.mat(color, { basic: true }), cx, 0.9125, cz, 'none'));
  };

  /** A neon sign on a feature wall in the team's colour, its back at z, starting at x; its own light. Returns its width. */
  const featureSign = (text: string, x: number, z: number, color: string, maxW: number): number => {
    const sign = kit.labelPlane(text, 0.55, { fg: R.paper, halo: color, px: 72, bold: true, font: 'mono' });
    const sw = sign ? Math.min((sign.geometry as THREE.PlaneGeometry).parameters.width, maxW - 0.4) : 1.6;
    const fw = sw + 0.4;
    const fx = x + fw / 2;
    add(kit.box(fw, 1.95, 0.14, mix(color, R.plastic, 0.78), fx, 0, z, { rough: 0.9 }));
    add(kit.box(fw, 0.05, 0.16, R.woodDark, fx, 1.95, z));
    add(kit.mesh(kit.boxGeo(fw, 0.03, 0.15), kit.mat(color, { basic: true }), fx, 0.915, z, 'none'));
    const light = new T.PointLight(new T.Color(color), 2.0, 5.5, 1.6);
    light.position.set(fx, 1.5, z + 1.3);
    add(light);
    if (sign) {
      sign.scale.setScalar(sw / (sign.geometry as THREE.PlaneGeometry).parameters.width);
      sign.position.set(fx, 1.45, z + 0.075);
      add(sign);
      const m = sign.material as THREE.MeshBasicMaterial;
      const s = hash01(text) * 9000;
      tickers.push((now) => {
        const u = (now + s) % 9000;
        const flick = u > 8700 && u < 8850 && Math.floor(u / 40) % 2 === 0;
        m.opacity = flick ? 0.4 : 1;
        light.intensity = flick ? 0.8 : 2.0;
      });
    }
    return fw;
  };

  /** A neon sign on a dark board, up on two posts (over the test racks, the bench). */
  const hangingSign = (text: string, x: number, y: number, z: number, color: string) => {
    const sign = kit.labelPlane(text, 0.42, { fg: R.paper, halo: color, px: 72, bold: true, font: 'mono' });
    const w = sign ? (sign.geometry as THREE.PlaneGeometry).parameters.width : 1.6;
    add(kit.box(w + 0.1, 0.5, 0.05, R.plastic, x, y - 0.25, z - 0.03));
    add(kit.box(0.04, y - 0.25, 0.04, R.metalDark, x - w / 2 + 0.1, 0, z - 0.06), kit.box(0.04, y - 0.25, 0.04, R.metalDark, x + w / 2 - 0.1, 0, z - 0.06));
    if (sign) {
      sign.position.set(x, y, z + 0.001);
      add(sign);
    }
    const light = new T.PointLight(new T.Color(color), 1.6, 4.5, 1.6);
    light.position.set(x, y - 0.3, z + 1.1);
    add(light);
  };

  const zoneVisual = (z: Zone) => {
    const color = teamColor(pal, z.team);
    const x1 = z.gx + z.w - 0.5;
    const z1 = z.gy + z.h - 0.5;
    teamFloor(z.gx, z.gy, x1, z1, color);
    // The back wall runs to the door; the left wall stops short of the front aisle (none at the room's own wall).
    const doorX = z.door.gx - 0.5;
    const backX0 = z.gx === 0 ? -0.5 : z.gx;
    const fw = featureSign(z.label, backX0 + 0.1, z.gy, color, doorX - backX0 - 0.1);
    if (doorX - (backX0 + 0.1 + fw) > 0.1) lowWall(backX0 + 0.1 + fw, z.gy, doorX, z.gy, color);
    if (z.gx > 0) lowWall(z.gx, z.gy, z.gx, z.gy + z.h - 1.5, color);
  };
  for (const z of L.zones) zoneVisual(z);

  // ---------- stations ----------

  /** A lamp's (or an untextured screen's) colour for a station state. */
  const colorFor = (s: StationStateName, now: number, lit: number): string => {
    switch (s) {
      case 'busy': return mix(R.busy, R.paper, 0.1 + 0.08 * Math.sin(now / 160 + lit));
      case 'ok': return R.ok;
      case 'failed': return R.failed;
      case 'alert': return Math.floor(now / 450) % 2 ? R.alert : R.screenOff;
      default: return mix(R.screenOff, R.busy, 0.22);
    }
  };

  interface Indicator {
    mat: THREE.Material;
    set(s: StationStateName): void;
    tick(now: number, dt: number): void;
    readonly state: StationStateName;
  }

  /** A screen or lamp whose colour follows the station's state. */
  const indicator = (lit: number): Indicator => {
    const mat = kit.ownMat(R.screenOff, { basic: true });
    let state: StationStateName = 'idle';
    return {
      mat,
      set: (s: StationStateName) => (state = s),
      tick: (now: number) => void mat.color.set(colorFor(state, now, lit)),
      get state() {
        return state;
      },
    };
  };

  /**
   * A screen with something on it (decor3d): bright and scrolling while the station is busy, tinted when it is done,
   * failed or calling, dark when idle. Without a texture (no canvas) it is a plain state-coloured panel.
   */
  const screenIndicator = (s: Screen, lit: number): Indicator => {
    let state: StationStateName = 'idle';
    const speed = 0.00005 * (1 + (lit % 3) * 0.35);
    return {
      mat: s.mat,
      set: (x: StationStateName) => (state = x),
      tick: (now: number, dt: number) => {
        if (!s.tex) {
          s.mat.color.set(colorFor(state, now, lit));
          return;
        }
        const c = state === 'busy' ? B.white
          : state === 'ok' ? mix(B.white, R.ok, 0.35)
          : state === 'failed' ? mix(B.white, R.failed, 0.6)
          : state === 'alert' ? (Math.floor(now / 450) % 2 ? R.alert : mix(B.white, R.alert, 0.3))
          : mix(R.screenOff, B.white, 0.14);
        s.mat.color.set(c);
        if (state === 'busy') s.tex.offset.y = (s.tex.offset.y + dt * speed) % 1;
      },
      get state() {
        return state;
      },
    };
  };

  const chair = (x: number, z: number, y0: number, style: 'office' | 'arm' | 'stool', color: string): THREE.Group => {
    const g = new T.Group();
    if (style === 'office') {
      g.add(kit.box(0.46, 0.07, 0.44, color, 0, 0.42, 0, { rough: 0.7 }));
      g.add(kit.box(0.44, 0.52, 0.06, color, 0, 0.5, 0.21, { rough: 0.7 }));
      g.add(kit.cyl(0.03, 0.36, R.metalDark, 0, 0.06, 0, { metal: 0.7 }));
      g.add(kit.box(0.56, 0.035, 0.06, R.metalDark, 0, 0.04, 0, { metal: 0.7 }));
      g.add(kit.box(0.06, 0.035, 0.56, R.metalDark, 0, 0.04, 0, { metal: 0.7 }));
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
    g.position.set(x, y0, z + 0.08);
    return g;
  };

  const monitor = (w: number, h: number, scr: THREE.Material): THREE.Group => {
    const g = new T.Group();
    g.add(kit.box(0.2, 0.02, 0.14, R.metalDark, 0, 0, 0, { metal: 0.6 }));
    g.add(kit.box(0.04, 0.16, 0.03, R.metalDark, 0, 0.02, -0.02, { metal: 0.6 }));
    g.add(kit.box(w, h, 0.035, R.plastic, 0, 0.14, 0));
    const s = kit.mesh(kit.planeGeo(w - 0.04, h - 0.04), scr, 0, 0.14 + h / 2, 0.0185, 'none');
    g.add(s);
    return g;
  };

  const desk = (x0: number, x1: number, z: number, y0: number, color: string): THREE.Group => {
    const g = new T.Group();
    const w = x1 - x0 + 0.92;
    const cx = (x0 + x1) / 2;
    g.add(kit.box(w, 0.05, 0.8, color, cx, DESK_Y - 0.05, z, { rough: 0.6 }));
    g.add(kit.box(0.05, DESK_Y - 0.05, 0.74, R.woodDark, cx - w / 2 + 0.06, 0, z), kit.box(0.05, DESK_Y - 0.05, 0.74, R.woodDark, cx + w / 2 - 0.06, 0, z));
    g.add(kit.box(w - 0.12, 0.4, 0.03, R.woodDark, cx, DESK_Y - 0.5, z - 0.35));
    g.position.y = y0;
    return g;
  };

  /** A small card on the front of a desk with the station's name. */
  const nameplate = (text: string, x: number, y: number, z: number): void => {
    const p = kit.labelPlane(text, 0.13, { fg: R.paper, bg: R.woodDark, px: 34, bold: true, font: 'mono' });
    if (!p) return;
    p.position.set(x, y, z);
    add(p);
  };

  let bayIndex = 0;
  for (const id of L.ids()) {
    const st = L.resolve(id)!;
    const y0 = st.elevation * ELEV_K;
    const sx = st.grid.gx;
    const sz = st.grid.gy;
    const fx = st.footprint.map((p) => p.gx);
    const fz = st.footprint[0]?.gy ?? sz - 1;
    const x0 = fx.length ? Math.min(...fx) : sx;
    const x1 = fx.length ? Math.max(...fx) : sx;
    const cx = (x0 + x1) / 2;
    const v: StationVisual & { parts: Indicator[] } = {
      id, parts: [],
      set(s) {
        for (const p of this.parts) p.set(s);
      },
      tick(now, dt) {
        for (const p of this.parts) p.tick(now, dt);
      },
    };
    const short = st.label.split(' — ')[0]!;

    switch (st.kind) {
      case 'desk': {
        const head = st.meta.head === true;
        add(desk(x0, x1, fz, y0, R.wood));
        const offs = head ? [-0.64, 0, 0.64] : [-0.34, 0.34];
        const kinds = head ? (['graph', 'code', 'terminal'] as const) : (['code', 'merge'] as const);
        offs.forEach((o, i) => {
          const scr = screenIndicator(screen(kit, pal, kinds[i]!, B.cyan), i);
          v.parts.push(scr);
          const m = monitor(0.6, 0.36, scr.mat);
          m.position.set(sx + o, y0 + DESK_Y, fz - 0.16);
          m.rotation.y = head && i !== 1 ? -Math.sign(o) * 0.32 : 0;
          add(m);
        });
        add(kit.box(0.46, 0.025, 0.15, R.plastic, sx, y0 + DESK_Y, fz + 0.2), kit.box(0.07, 0.025, 0.1, R.plastic, sx + 0.36, y0 + DESK_Y, fz + 0.2));
        add(kit.cyl(0.045, 0.1, R.mug, x1 + 0.25, y0 + DESK_Y, fz + 0.12));
        puffs(root, x1 + 0.25, y0 + DESK_Y + 0.12, fz + 0.12, R.paper, () => v.parts[0]!.state === 'busy', { n: 3, rise: 0.3, size: 0.06, period: 2600, opacity: 0.3 });
        // The desk lamp: base, arm, shade, a warm bulb.
        const lamp = kit.group(
          kit.cyl(0.08, 0.02, R.metalDark, 0, 0, 0),
          kit.box(0.025, 0.42, 0.025, R.metalDark, 0, 0.02, 0),
          kit.cyl(0.11, 0.1, R.metalDark, 0, 0.36, 0.08, { rTop: 0.04, metal: 0.5 }),
          kit.ball(0.04, R.lamp, 0, 0.37, 0.08, { basic: true }),
        );
        lamp.position.set(x0 - 0.2, y0 + DESK_Y, fz - 0.15);
        add(lamp);
        add(plant(x1 + 0.3, fz - 0.2, 0.35, `desk${id}`).translateY(y0 + DESK_Y));
        if (head) add(kit.box(0.24, 0.02, 0.18, R.paper, x0 + 0.15, y0 + DESK_Y, fz + 0.15), kit.box(0.24, 0.02, 0.18, B.yellow, x0 + 0.18, y0 + DESK_Y + 0.02, fz + 0.12));
        // Their own things, like everyone's.
        for (const o of personalThings(kit, pal, id, [[head ? x0 + 0.65 : x0 - 0.05, fz + 0.28], [x1 + 0.05, fz + 0.32]], tickers)) add(o.translateY(y0));
        add(chair(sx, sz, y0, 'office', R.plastic));
        nameplate(short, cx, y0 + DESK_Y - 0.22, fz + 0.41);
        break;
      }
      case 'bay': {
        // A personal desk in a team's pod (decor3d), built with its sitter on +z and turned to the side its sitter is on:
        // row A (face +1) sits behind the desk looking at the room, row B in front of it with its back to us.
        const team = typeof st.meta.team === 'string' ? st.meta.team : null;
        const face = st.meta.face === 1 ? 1 : -1;
        const d = personalDesk(kit, pal, { owner: String(st.meta.owner ?? id), team, color: teamColor(pal, team), empty: !st.meta.task }, tickers);
        d.group.position.set(cx, y0, fz);
        d.group.rotation.y = face === 1 ? Math.PI : 0;
        add(d.group);
        d.screens.forEach((s, i) => v.parts.push(screenIndicator(s, bayIndex + i)));
        if (!d.screens.length) v.parts.push(indicator(bayIndex));
        v.seat = { chair: d.chair, home: d.chair.position.clone(), away: new T.Vector3(0, 0, 1) };
        bayIndex++;
        break;
      }
      case 'loft': {
        const chairColor = st.meta.chair === true ? B.violet : R.fabric;
        add(chair(sx, sz, y0, 'arm', mix(chairColor, R.woodDark, 0.25)));
        // A low table with a laptop and papers.
        const t = kit.group(
          kit.box(1.4, 0.05, 0.6, R.wood, 0, 0.42, 0),
          kit.box(0.05, 0.42, 0.05, R.woodDark, -0.62, 0, -0.24), kit.box(0.05, 0.42, 0.05, R.woodDark, 0.62, 0, -0.24),
          kit.box(0.05, 0.42, 0.05, R.woodDark, -0.62, 0, 0.24), kit.box(0.05, 0.42, 0.05, R.woodDark, 0.62, 0, 0.24),
          kit.box(0.4, 0.015, 0.28, R.metalDark, 0, 0.47, 0.06, { metal: 0.6 }),
          kit.box(0.3, 0.015, 0.22, R.paper, 0.48, 0.47, 0.0),
        );
        const scr = indicator(sx);
        v.parts.push(scr);
        const lid = kit.group(kit.box(0.4, 0.26, 0.012, R.metalDark, 0, 0, 0, { metal: 0.6 }), kit.mesh(kit.planeGeo(0.36, 0.22), scr.mat, 0, 0.13, 0.007, 'none'));
        lid.position.set(0, 0.475, -0.08);
        lid.rotation.x = -0.25;
        t.add(lid);
        t.position.set(cx, y0, fz);
        add(t);
        if (st.meta.chair === true) {
          const star = kit.labelSprite('★', 0.3, { fg: B.yellow, halo: B.yellow, px: 64 });
          if (star) {
            star.position.set(sx, y0 + 1.35, sz + 0.1);
            add(star);
          }
        }
        // A floor lamp beside the chair.
        add(kit.group(kit.cyl(0.12, 0.03, R.metalDark), kit.cyl(0.015, 1.3, R.metalDark), kit.cyl(0.2, 0.22, R.paper, 0, 1.25, 0, { rTop: 0.12, glow: R.lamp, glowK: 0.6 })).translateX(sx - 0.65).translateY(y0).translateZ(sz + 0.2));
        nameplate(st.label, cx, y0 + 0.3, fz + 0.31);
        break;
      }
      case 'outbox': {
        // A mailbox on a post: its flag goes up when something is on its way.
        const box = kit.group(
          kit.box(0.08, 0.95, 0.08, R.woodDark, 0, 0, 0),
          kit.box(0.34, 0.24, 0.5, B.blue, 0, 0.95, 0, { metal: 0.3, rough: 0.5 }),
        );
        const dome = kit.cyl(0.17, 0.5, B.blue, 0, 1.19, 0, { metal: 0.3, rough: 0.5, seg: 16 });
        dome.rotation.x = Math.PI / 2;
        dome.position.set(0, 1.19, 0);
        dome.scale.set(1, 1, 0.7);
        box.add(dome);
        const flag = new T.Group();
        flag.add(kit.box(0.02, 0.32, 0.02, R.failed, 0, 0, 0), kit.box(0.02, 0.1, 0.14, R.failed, 0, 0.22, 0.07));
        flag.position.set(0.18, 1.0, -0.1);
        box.add(flag);
        box.position.set(cx, y0, fz);
        add(box);
        const scr = indicator(1);
        v.parts.push(scr);
        add(kit.box(0.2, 0.25, 0.2, R.cardboard, cx + 0.42, y0, fz + 0.05), kit.box(0.16, 0.16, 0.16, R.cardboard, cx + 0.4, y0 + 0.25, fz + 0.06));
        tickers.push(() => {
          const up = scr.state === 'busy' || scr.state === 'alert';
          flag.rotation.x += ((up ? 0 : -Math.PI / 2) - flag.rotation.x) * 0.12;
        });
        nameplate('OUTBOX', cx, y0 + 0.75, fz + 0.27);
        break;
      }
      case 'lab': {
        // Two test racks with LED grids, a beacon on top.
        for (const [k, dx] of [[0, -0.55], [1, 0.55]] as const) {
          add(kit.box(0.82, 1.75, 0.7, R.metalDark, cx + dx, y0, fz, { metal: 0.5, rough: 0.45 }));
          for (let r = 0; r < 5; r++) add(kit.box(0.74, 0.015, 0.02, R.metal, cx + dx, y0 + 0.3 + r * 0.3, fz + 0.355, { metal: 0.7 }));
          const leds = new T.InstancedMesh(kit.boxGeo(0.05, 0.03, 0.01), kit.own(new T.MeshBasicMaterial({ toneMapped: false })), 24);
          const m4 = new T.Matrix4();
          for (let i = 0; i < 24; i++) {
            m4.makeTranslation(cx + dx - 0.3 + (i % 6) * 0.12, y0 + 0.42 + Math.floor(i / 6) * 0.3, fz + 0.36);
            leds.setMatrixAt(i, m4);
            leds.setColorAt(i, new T.Color(R.screenOff));
          }
          add(leds);
          const seed = k * 31;
          const c = new T.Color();
          tickers.push((now) => {
            const s = v.parts[0]?.state ?? 'idle';
            for (let i = 0; i < 24; i++) {
              const on = s === 'busy' ? hash01(`${seed}:${i}:${Math.floor(now / 140 + i)}`) > 0.45 : s === 'idle' ? i % 5 === 0 : true;
              c.set(!on ? R.screenOff : s === 'failed' ? R.failed : s === 'alert' ? R.alert : s === 'busy' ? (i % 3 ? R.ok : R.busy) : R.ok);
              leds.setColorAt(i, c);
            }
            if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
          });
        }
        const beacon = indicator(7);
        v.parts.push(beacon);
        add(kit.cyl(0.1, 0.06, R.metalDark, cx, y0 + 1.75, fz), kit.mesh(kit.sphereGeo(0.09, 14, 10, Math.PI / 2), beacon.mat, cx, y0 + 1.81, fz, 'none'));
        add(chair(sx, sz + 0.1, y0, 'stool', R.plastic));
        teamFloor(x0 - 0.5, fz - 0.5, x0 + 3.5, fz + 2.5, roleColor(pal, 'worker', 'test'));
        hangingSign('TEST LAB', cx, y0 + 2.15, fz, roleColor(pal, 'worker', 'test'));
        break;
      }
      case 'bench': {
        // The integration bench: a heavy workbench, a vise, and the merge press: two branches in, one out.
        add(kit.box(x1 - x0 + 0.9, 0.08, 0.85, R.woodDark, cx, y0 + 0.86, fz));
        for (const dx of [-1, 1]) for (const dz of [-0.32, 0.32]) add(kit.box(0.08, 0.86, 0.08, R.metalDark, cx + dx * ((x1 - x0) / 2 + 0.36), y0, fz + dz, { metal: 0.6 }));
        add(kit.box(x1 - x0 + 0.7, 0.04, 0.7, R.woodDark, cx, y0 + 0.2, fz));
        add(kit.box(0.24, 0.14, 0.18, R.metalDark, x0 - 0.2, y0 + 0.94, fz + 0.25, { metal: 0.6, rough: 0.4 }));
        const press = kit.group(
          kit.box(0.6, 0.5, 0.45, R.metal, 0, 0, 0, { metal: 0.6, rough: 0.35 }),
          kit.cyl(0.06, 0.5, B.cyan, -0.32, 0.25, -0.05, { metal: 0.4 }),
          kit.cyl(0.06, 0.5, B.violet, 0.32, 0.25, -0.05, { metal: 0.4 }),
          kit.cyl(0.07, 0.3, B.green, 0, 0.5, 0, { metal: 0.4 }),
        );
        press.children[1]!.rotation.z = Math.PI / 3;
        press.children[2]!.rotation.z = -Math.PI / 3;
        press.position.set(cx + 0.2, y0 + 0.94, fz - 0.05);
        add(press);
        const beacon = indicator(4);
        v.parts.push(beacon);
        add(kit.mesh(kit.sphereGeo(0.08, 14, 10, Math.PI / 2), beacon.mat, cx + 0.2, y0 + 1.74, fz - 0.05, 'none'));
        // Crates riding the belt while it merges.
        const belt = kit.box(1.2, 0.04, 0.3, R.plastic, cx - 0.35, y0 + 0.94, fz + 0.22);
        add(belt);
        const parcel = kit.box(0.16, 0.14, 0.16, R.cardboard, cx - 0.9, y0 + 0.98, fz + 0.22);
        add(parcel);
        tickers.push((now) => {
          const busy = beacon.state === 'busy';
          parcel.visible = busy;
          if (busy) parcel.position.x = cx - 0.9 + ((now / 2200) % 1) * 1.0;
          // A jammed bench shakes.
          press.position.x = cx + 0.2 + (beacon.state === 'failed' ? Math.sin(now / 30) * 0.015 : 0);
        });
        puffs(root, cx + 0.2, y0 + 1.5, fz - 0.05, R.concreteDark, () => beacon.state === 'failed', { n: 6, rise: 1.2, size: 0.3, period: 1800, opacity: 0.55 });
        add(chair(sx, sz + 0.1, y0, 'stool', R.plastic));
        teamFloor(x0 - 0.5, fz - 0.5, x0 + 3.5, fz + 2.5, B.green);
        hangingSign('INTEGRATION', cx, y0 + 2.15, fz, B.green);
        break;
      }
      case 'terminal': {
        // An arcade cabinet: the terminal everyone queues at.
        const cab = kit.group(
          kit.box(0.72, 1.7, 0.7, R.plastic, 0, 0, 0),
          kit.box(0.74, 0.08, 0.72, R.neon, 0, 1.7, 0, { basic: true }),
          kit.box(0.72, 0.18, 0.3, R.plastic, 0, 0.92, 0.42),
          kit.box(0.02, 1.5, 0.04, R.neon, -0.37, 0.1, 0.33, { basic: true }),
          kit.box(0.02, 1.5, 0.04, R.neon, 0.37, 0.1, 0.33, { basic: true }),
          kit.cyl(0.04, 0.03, B.red, -0.12, 1.1, 0.42), kit.cyl(0.04, 0.03, B.yellow, 0.06, 1.1, 0.46), kit.cyl(0.04, 0.03, B.cyan, 0.2, 1.1, 0.42),
        );
        const scr = indicator(2);
        v.parts.push(scr);
        const s = kit.mesh(kit.planeGeo(0.56, 0.44), scr.mat, 0, 1.35, 0.352, 'none');
        s.rotation.x = -0.2;
        cab.add(s);
        cab.position.set(cx, y0, fz);
        add(cab);
        add(chair(sx, sz + 0.05, y0, 'stool', R.fabricAlt));
        nameplate('TERMINAL', cx, y0 + 0.5, fz + 0.36);
        break;
      }
      case 'crate': {
        // The repository's crates, stencilled with its name, and a hand truck.
        add(kit.box(0.9, 0.62, 0.7, R.crate, cx - 0.35, y0, fz, { rough: 0.9 }));
        add(kit.box(0.7, 0.5, 0.6, R.crate, cx - 0.3, y0 + 0.62, fz - 0.02, { rough: 0.9 }));
        add(kit.box(0.6, 0.48, 0.55, R.cardboard, cx + 0.55, y0, fz + 0.04));
        add(kit.box(0.92, 0.03, 0.02, R.woodDark, cx - 0.35, y0 + 0.3, fz + 0.36));
        const stencil = kit.labelPlane(short.toUpperCase(), 0.16, { fg: R.woodDark, px: 44, bold: true, font: 'mono' });
        if (stencil) {
          stencil.position.set(cx - 0.35, y0 + 0.42, fz + 0.355);
          stencil.scale.setScalar(Math.min(1, 0.85 / (stencil.geometry as THREE.PlaneGeometry).parameters.width));
          add(stencil);
        }
        const scr = indicator(5);
        v.parts.push(scr);
        add(kit.mesh(kit.boxGeo(0.05, 0.05, 0.02), scr.mat, cx + 0.55, y0 + 0.36, fz + 0.32, 'none'));
        break;
      }
      case 'entrance': {
        // A doormat, and hazard tape fencing the queue.
        add(kit.box(1.4, 0.015, 0.8, R.plastic, sx, 0, sz + 0.05, { rough: 1 }));
        const hello = kit.labelPlane('HELLO', 0.22, { fg: R.cardboard, px: 40, bold: true });
        if (hello) {
          hello.rotation.x = -Math.PI / 2;
          hello.position.set(sx, 0.02, sz + 0.05);
          add(hello);
        }
        const tapeTex = kit.texture(128, 16, (ctx, w, h) => {
          ctx.fillStyle = R.tape;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = R.tapeDark;
          for (let x = -h; x < w; x += 24) {
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x + 12, 0);
            ctx.lineTo(x + 24, 0);
            ctx.lineTo(x + 12, h);
            ctx.fill();
          }
        }, [Math.max(1, (cols - 1) / 1.5), 1]);
        const tape = kit.mesh(kit.planeGeo(cols - 1, 0.12), tapeTex ? kit.own(new T.MeshStandardMaterial({ map: tapeTex, roughness: 0.6 })) : kit.mat(R.tape), (cols - 1) / 2, 0.006, sz + 0.5, 'receive');
        tape.rotation.x = -Math.PI / 2;
        add(tape);
        break;
      }
      case 'ext': {
        add(plant(sx, sz, 0.7, id));
        break;
      }
      default:
        break;
    }
    stations.set(id, v);
  }

  setBoard([]);
  return {
    root,
    stations,
    setBoard,
    setLounge(acts) {
      foosball = acts.has('foosball');
    },
    tick(now, dt) {
      for (const t of tickers) t(now, dt);
      for (const s of stations.values()) s.tick(now, dt);
    },
    bounds: { x0: -0.5 - WALL_T, x1: cols - 0.5, z0: -0.5 - WALL_T, z1: rows - 0.5, y0: -SLAB, y1: WALL_H },
  };
}

/** Where a placement's chair puts a sitter: the stand tile, at the station's height. */
export function seatOf(st: StationPlacement): { x: number; y: number; z: number } {
  return { x: st.grid.gx, y: st.elevation * ELEV_K, z: st.grid.gy + 0.08 };
}
