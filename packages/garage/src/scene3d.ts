// The garage in 3D: the same renderer contract as the Canvas2D one (renderer.ts), drawn with three.js as an isometric diorama.
// The room comes from room3d.ts, the people from people3d.ts; this file owns the camera, who walks where, stamps and
// confetti, and the frame. three.js and the WebGL context are handed in, so a test drives it all under node.
import type * as THREE from 'three';
import { layoutFromState, type Layout, type LayoutSpec } from './layout.js';
import type { AnimationName, CharacterId, CharacterKind, GarageState, SceneIntent, StampKind, StationId, StationKind, StationStateName, TaskKey } from './model.js';
import { theme as sharedTheme, type ThemeSource } from './palette.js';
import { DEFAULT_HOP_TILES, planWalk, type Point } from './path.js';
import {
  CELEBRATE_MS, HOP_MAX_MS, HOP_MIN_MS, HOP_PER_TILE_MS, MIN_MOVE_MS, SPAWN_FADE_MS, STAMP_MS, WALK_TILES_PER_SEC, specialtyOf,
  type Anchor, type AgentView, type CanvasRenderer, type ExtraDrawable, type FrameStats,
} from './renderer.js';
import { Kit, hash01, type CanvasMaker, type Three } from './kit3d.js';
import { buildRoom, ELEV_K, type RoomBuild } from './room3d.js';
import { makeRig, pose, type Rig } from './people3d.js';

/** What the 3D renderer needs of the page's canvas: its size, its style, and pointer and wheel events for the camera. */
export interface Canvas3D {
  width: number;
  height: number;
  style?: { width: string; height: string; imageRendering?: string; cursor?: string };
  addEventListener(type: string, listener: (ev: never) => void, opts?: boolean | { passive?: boolean; capture?: boolean }): void;
  removeEventListener(type: string, listener: (ev: never) => void, opts?: boolean | { capture?: boolean }): void;
}

/** The part of three's WebGLRenderer this file uses; a test passes a stub. */
export interface GL {
  setPixelRatio(r: number): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: string;
}

export interface Scene3DOptions {
  three: Three;
  canvas: Canvas3D;
  /** Default: a WebGLRenderer on the canvas, antialiased, with soft shadows. */
  createGL?: (canvas: Canvas3D) => GL;
  /** For text and surface textures; null leaves them out (node). Default: `document.createElement('canvas')`. */
  makeCanvas?: CanvasMaker | null;
  layout?: Layout;
  layoutFor?: (state: GarageState) => Layout;
  extras?: Pick<LayoutSpec, 'chair' | 'head' | 'extensions'>;
  theme?: ThemeSource;
  clock?: () => number;
  hopTiles?: number;
  onFrame?: (stats: FrameStats) => void;
  view?: { width: number; height: number; dpr?: number };
}

const SEAT_KINDS: ReadonlySet<StationKind> = new Set<StationKind>(['loft', 'desk', 'bay']);
const SLOT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0.32, 0.32], [-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.4, 0], [-0.4, 0], [0, 0.4],
];
const HOP_LIFT = 1.4;
/** How the camera looks at the room: from the front-right corner, 30° down (2:1 iso). */
const VIEW_DIR: readonly [number, number, number] = [1, 0.8165, 1];
/** CSS pixels the framed room keeps clear: the theme button and hint above, the HUD below. */
const FIT_TOP = 44;
const FIT_BOTTOM = 150;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 4.5;
const MAX_STAMPS = 16;
const CONFETTI = 26;
const CONFETTI_MS = 1800;

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);
const easeInOutSine = (u: number): number => -(Math.cos(Math.PI * clamp01(u)) - 1) / 2;
const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

interface Waypoint {
  gx: number;
  gy: number;
  elev: number;
}

interface Motion {
  pts: Waypoint[];
  cum: number[];
  length: number;
  duration: number;
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
  yaw: number;
  anim: AnimationName;
  celebrate: { t0: number | null } | null;
  motion: Motion | null;
  born: number | null;
  alpha: number;
  leaving: boolean;
  fadeOut: { t0: number | null } | null;
  stride: number;
  rig: Rig;
}

interface Stamp {
  kind: StampKind;
  at: StationId;
  t0: number | null;
  sprite: THREE.Sprite;
}

interface Piece {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  t0: number | null;
}

const defaultClock = (): number => {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
};

const defaultCanvasMaker = (): CanvasMaker | null => {
  const doc = (globalThis as { document?: { createElement(tag: 'canvas'): HTMLCanvasElement } }).document;
  if (!doc) return null;
  return (w, h) => {
    const c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
};

class Scene3D implements CanvasRenderer {
  layout: Layout;
  zoom = 1;
  dirty = true;

  private readonly T: Three;
  private readonly canvas: Canvas3D;
  private readonly gl: GL;
  private readonly kit: Kit;
  private readonly theme: ThemeSource;
  private readonly clock: () => number;
  private readonly layoutFor: (state: GarageState) => Layout;
  private readonly onFrame: ((s: FrameStats) => void) | undefined;
  private readonly hopTiles: number;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private room: RoomBuild | null = null;
  private readonly agents = new Map<CharacterId, Agent>();
  private readonly stationStates = new Map<StationId, StationStateName>();
  private stamps: Stamp[] = [];
  private confetti: Piece[] = [];
  private readonly extras = new Map<string, ExtraDrawable>();
  private board = '';
  private lastState: GarageState | null = null;
  private synced = false;
  private disposed = false;
  private viewCss = { w: 1, h: 1, dpr: 1 };
  /** The camera: what it looks at (fit to the room), the person's zoom and pan on top. */
  private fitZoom = 1;
  private fitCenter: THREE.Vector3;
  private userZoom = 1;
  private pan: THREE.Vector3;
  private lastNow: number | null = null;
  private frames = 0;
  private costs: number[] = [];
  private intervals: number[] = [];
  private last: FrameStats = { frames: 0, frameMs: 0, avgMs: 0, intervalMs: 0, fps: 0, drawn: 0 };
  private unsubscribe: (() => void) | null;
  private readonly listeners: Array<[string, (ev: never) => void, boolean | { passive?: boolean; capture?: boolean }]> = [];

  constructor(o: Scene3DOptions) {
    const T = (this.T = o.three);
    this.canvas = o.canvas;
    this.theme = o.theme ?? sharedTheme;
    this.clock = o.clock ?? defaultClock;
    this.onFrame = o.onFrame;
    this.hopTiles = o.hopTiles ?? DEFAULT_HOP_TILES;
    this.layoutFor = o.layoutFor ?? ((s) => layoutFromState(s, o.extras));
    this.layout = o.layout ?? layoutFromState(emptyState(), o.extras);
    this.kit = new Kit(T, o.makeCanvas === undefined ? defaultCanvasMaker() : o.makeCanvas);
    this.gl = (o.createGL ?? ((c) => {
      const r = new T.WebGLRenderer({ canvas: c as unknown as HTMLCanvasElement, antialias: true, alpha: true, powerPreference: 'high-performance' });
      return r as unknown as GL;
    }))(this.canvas);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = T.PCFShadowMap;
    this.gl.toneMapping = T.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.outputColorSpace = T.SRGBColorSpace;
    this.gl.setClearColor(0, 0);
    if (this.canvas.style) this.canvas.style.imageRendering = 'auto';

    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.fitCenter = new T.Vector3();
    this.pan = new T.Vector3();
    this.buildRoom();
    this.unsubscribe = this.theme.subscribe(() => this.rebuild());
    const v = o.view ?? { width: this.canvas.width, height: this.canvas.height, dpr: 1 };
    this.resize(v.width, v.height, v.dpr ?? 1);
    this.listenControls();
  }

  // ---------- the room ----------

  private buildRoom(): void {
    if (this.room) this.scene.remove(this.room.root);
    this.room = buildRoom(this.kit, this.layout, this.theme.palette());
    this.scene.add(this.room.root);
    for (const [id, s] of this.stationStates) this.room.stations.get(id)?.set(s);
    if (this.lastState) this.room.setBoard(this.lastState.board);
    this.fit();
  }

  /** A theme switch: new materials everywhere, the people redressed where they stand. */
  private rebuild(): void {
    if (this.disposed) return;
    for (const a of this.agents.values()) this.scene.remove(a.rig.root);
    this.kit.dispose();
    this.room = null;
    this.buildRoom();
    for (const a of this.agents.values()) {
      a.rig = this.rigFor(a.id, a.kind, a.specialty);
      this.scene.add(a.rig.root);
    }
    this.dirty = true;
  }

  private rigFor(id: CharacterId, kind: CharacterKind, specialty: string | null): Rig {
    const chair = kind === 'council' && (this.layout.resolve(`loft:${id}` as StationId)?.meta.chair === true);
    return makeRig(this.kit, this.theme.palette(), id, kind, specialty, { chair });
  }

  // ---------- GarageRenderer ----------

  spawnAgent(id: CharacterId, kind: CharacterKind, at: StationId, look?: { specialty?: string | null; task?: TaskKey | null }): void {
    if (this.disposed) return;
    const known = this.agents.get(id);
    if (known) {
      const specialty = look?.specialty !== undefined ? look.specialty : known.specialty;
      if (kind !== known.kind || specialty !== known.specialty) {
        this.scene.remove(known.rig.root);
        known.rig = this.rigFor(id, kind, specialty);
        this.scene.add(known.rig.root);
      }
      known.kind = kind;
      known.specialty = specialty;
      if (look?.task !== undefined) known.task = look.task;
      if (known.leaving) this.unretire(known);
      this.dirty = true;
      return;
    }
    const station: StationId = this.layout.resolve(at) ? at : 'entrance';
    const slot = this.freeSlot(station, id);
    const t = this.targetFor(station, slot);
    const specialty = look?.specialty ?? null;
    const rig = this.rigFor(id, kind, specialty);
    this.scene.add(rig.root);
    this.agents.set(id, {
      id, kind, specialty, task: look?.task ?? null, at: station, slot, pos: t ? { ...t.wp } : { gx: 0, gy: 0, elev: 0 }, lift: 0,
      yaw: Math.PI, anim: 'idle', celebrate: null, motion: null, born: null, alpha: 0, leaving: false, fadeOut: null, stride: 0, rig,
    });
    this.dirty = true;
  }

  moveAgent(id: CharacterId, to: StationId): void {
    const a = this.agents.get(id);
    if (this.disposed || !a || !this.layout.resolve(to)) return;
    if (a.leaving) this.unretire(a);
    a.at = to;
    a.slot = this.freeSlot(to, id);
    this.reroute(a);
    this.dirty = true;
  }

  playAnimation(id: CharacterId, animation: AnimationName): void {
    const a = this.agents.get(id);
    if (this.disposed || !a) return;
    if (animation === 'celebrate') {
      a.celebrate = { t0: null };
      this.throwConfetti(a);
    } else a.anim = animation;
    this.dirty = true;
  }

  updateStation(id: StationId, state: StationStateName): void {
    if (this.disposed || this.stationStates.get(id) === state) return;
    this.stationStates.set(id, state);
    this.room?.stations.get(id)?.set(state);
    this.dirty = true;
  }

  syncState(state: GarageState): void {
    if (this.disposed) return;
    this.lastState = state;
    const next = this.layoutFor(state);
    if (JSON.stringify(next.spec) !== JSON.stringify(this.layout.spec)) this.setLayout(next);
    const board = JSON.stringify(state.board);
    if (board !== this.board) {
      this.board = board;
      this.room?.setBoard(state.board);
    }
    const first = !this.synced;
    this.synced = true;
    for (const c of Object.values(state.characters)) {
      const look = { specialty: specialtyOf(c.persona), task: c.task };
      const known = this.agents.get(c.id);
      if (!known) {
        this.spawnAgent(c.id, c.kind, first ? c.station : 'entrance', look);
        if (!first && c.station !== 'entrance') this.moveAgent(c.id, c.station);
      } else {
        this.spawnAgent(c.id, c.kind, known.at, look);
        if (known.at !== c.station) this.moveAgent(c.id, c.station);
      }
      const a = this.agents.get(c.id)!;
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
    this.layout = layout;
    this.buildRoom();
    // World coordinates are grid coordinates, so nobody jumps: everyone walks from where they stand to where their station is now.
    for (const a of this.agents.values()) this.reroute(a);
    this.dirty = true;
  }

  // ---------- the camera ----------

  resize(cssWidth: number, cssHeight: number, dpr = 1): void {
    if (this.disposed) return;
    const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 2) : 1;
    this.viewCss = { w: Math.max(1, cssWidth), h: Math.max(1, cssHeight), dpr: ratio };
    this.gl.setPixelRatio(ratio);
    this.gl.setSize(this.viewCss.w, this.viewCss.h, false);
    if (this.canvas.style) {
      this.canvas.style.width = `${this.viewCss.w}px`;
      this.canvas.style.height = `${this.viewCss.h}px`;
    }
    this.fit();
    this.dirty = true;
  }

  /** Frame the whole room: its corners, seen from the view direction, sized into the viewport with a margin. */
  private fit(): void {
    const T = this.T;
    const b = this.room?.bounds ?? { x0: -1, x1: this.layout.cols, z0: -1, z1: this.layout.rows, y0: 0, y1: 3 };
    const dir = new T.Vector3(...VIEW_DIR).normalize();
    const center = new T.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    cam.position.copy(center).addScaledVector(dir, 100);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
      const p = new T.Vector3(x, y, z).applyMatrix4(inv);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // The room fits between the top bar (theme, hint) and the HUD at the bottom, never in less than half the height.
    const H = this.viewCss.h;
    const top = Math.min(FIT_TOP, H * 0.15);
    const bottom = Math.min(FIT_BOTTOM, H * 0.35);
    const usable = (H - top - bottom) / H;
    const aspect = this.viewCss.w / H;
    const w = (maxX - minX) * 1.04;
    const h = (maxY - minY) * 1.04;
    this.fitZoom = Math.min((2 * aspect) / w, (2 * usable) / h);
    // The view-space centre of the extents, back in the world, then shifted so it lands in the middle of the usable band.
    const mid = new T.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0).applyMatrix4(cam.matrixWorld);
    this.fitCenter.copy(mid).addScaledVector(dir, -dir.dot(mid.clone().sub(center)));
    const up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    this.fitCenter.addScaledVector(up, -((bottom - top) / H) / this.fitZoom);
    this.applyCamera();
  }

  private applyCamera(): void {
    const T = this.T;
    const aspect = this.viewCss.w / this.viewCss.h;
    const c = this.camera;
    c.left = -aspect;
    c.right = aspect;
    c.top = 1;
    c.bottom = -1;
    c.zoom = this.fitZoom * this.userZoom;
    this.zoom = c.zoom;
    const dir = new T.Vector3(...VIEW_DIR).normalize();
    const target = this.fitCenter.clone().add(this.pan);
    c.position.copy(target).addScaledVector(dir, 120);
    c.lookAt(target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  /** Wheel zooms toward the pointer, a drag pans, a double click frames the room again. */
  private listenControls(): void {
    const T = this.T;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    let swallowClick = false;
    const on = (type: string, fn: (ev: never) => void, opts: boolean | { passive?: boolean; capture?: boolean } = false) => {
      this.canvas.addEventListener(type, fn, opts);
      this.listeners.push([type, fn, opts]);
    };
    const screenToWorldDelta = (dx: number, dy: number): THREE.Vector3 => {
      // A pixel is (2 / height / zoom) world units on the view plane.
      const k = 2 / this.viewCss.h / this.camera.zoom;
      const right = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      return right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
    };
    on('wheel', ((ev: WheelEvent) => {
      ev.preventDefault();
      const before = this.userZoom;
      this.userZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.userZoom * Math.exp(-ev.deltaY * 0.0015)));
      // Keep the point under the pointer where it is.
      const r = (ev.currentTarget as HTMLElement | null)?.getBoundingClientRect?.();
      if (r) {
        const ox = ev.clientX - r.left - this.viewCss.w / 2;
        const oy = ev.clientY - r.top - this.viewCss.h / 2;
        const k = 1 - before / this.userZoom;
        this.pan.add(screenToWorldDelta(-ox * k, -oy * k));
      }
      this.applyCamera();
      this.dirty = true;
    }) as (ev: never) => void, { passive: false });
    on('pointerdown', ((ev: PointerEvent) => {
      if (ev.button !== 0 && ev.button !== 1) return;
      drag = { x: ev.clientX, y: ev.clientY, moved: false };
    }) as (ev: never) => void);
    on('pointermove', ((ev: PointerEvent) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      if (this.canvas.style) this.canvas.style.cursor = 'grabbing';
      this.pan.add(screenToWorldDelta(dx, dy));
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      this.applyCamera();
      this.dirty = true;
    }) as (ev: never) => void);
    const end = () => {
      if (drag?.moved) swallowClick = true;
      drag = null;
      if (this.canvas.style) this.canvas.style.cursor = '';
    };
    on('pointerup', end as (ev: never) => void);
    on('pointerleave', end as (ev: never) => void);
    // A drag ends in a click: it must not also select whoever is under the pointer.
    on('click', ((ev: MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        ev.stopImmediatePropagation();
      }
    }) as (ev: never) => void, true);
    on('dblclick', (() => {
      this.userZoom = 1;
      this.pan.set(0, 0, 0);
      this.applyCamera();
      this.dirty = true;
    }) as (ev: never) => void);
  }

  // ---------- queries ----------

  private world(a: Agent): THREE.Vector3 {
    return new this.T.Vector3(a.pos.gx, a.pos.elev * ELEV_K + a.lift, a.pos.gy);
  }

  /** A world point in CSS pixels on the canvas. */
  private project(p: THREE.Vector3): Anchor {
    const v = p.clone().project(this.camera);
    const x = ((v.x + 1) / 2) * this.viewCss.w;
    const y = ((1 - v.y) / 2) * this.viewCss.h;
    return { x, y, visible: x >= 0 && y >= 0 && x <= this.viewCss.w && y <= this.viewCss.h && v.z >= -1 && v.z <= 1 };
  }

  inspect(id: CharacterId): AgentView | null {
    const a = this.agents.get(id);
    if (!a) return null;
    const p = this.project(this.world(a));
    const facing: 'left' | 'right' = Math.sin(a.yaw) - Math.cos(a.yaw) >= 0 ? 'right' : 'left';
    return {
      id, kind: a.kind, station: a.at, gx: a.pos.gx, gy: a.pos.gy, elevation: a.pos.elev, x: p.x, y: p.y,
      device: { x: p.x * this.viewCss.dpr, y: p.y * this.viewCss.dpr }, moving: !!a.motion, hopping: !!a.motion?.hop, facing,
      pose: a.motion ? 'walkA' : this.isSeated(a) ? 'sit' : 'stand', alpha: a.alpha, anim: a.anim, leaving: a.leaving,
    };
  }

  anchorOf(id: CharacterId | StationId): Anchor | null {
    const a = this.agents.get(id);
    if (a) {
      const p = this.world(a);
      p.y += a.rig.height + 0.1;
      return this.project(p);
    }
    const st = this.layout.resolve(id as StationId);
    if (!st) return null;
    return this.project(new this.T.Vector3(st.grid.gx, st.elevation * ELEV_K + 1.4, st.grid.gy - 0.5));
  }

  anchors(): Record<CharacterId, Anchor> {
    const out: Record<CharacterId, Anchor> = {};
    for (const id of this.agents.keys()) out[id] = this.anchorOf(id)!;
    return out;
  }

  needsFrame(): boolean {
    // The room is alive (steam, string lights, the clock): every visible frame is drawn.
    return !this.disposed;
  }

  stats(): FrameStats {
    return { ...this.last };
  }

  /** 2D drawables (renderer.ts) have no place in the 3D room: kept for the contract, never drawn. */
  addDrawable(d: ExtraDrawable): () => void {
    this.extras.set(d.id, d);
    return () => void this.extras.delete(d.id);
  }

  // ---------- movement ----------

  private isSeated(a: Agent): boolean {
    const st = this.layout.resolve(a.at);
    return !!st && SEAT_KINDS.has(st.kind) && !a.motion && a.slot === 0 && !a.leaving;
  }

  private freeSlot(at: StationId, self: CharacterId): number {
    const used = new Set<number>();
    for (const o of this.agents.values()) if (o.id !== self && o.at === at) used.add(o.slot);
    let k = 0;
    while (used.has(k)) k++;
    return k;
  }

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
        oy = o[1] + 0.35;
      }
    }
    // A seated person sits on the chair, a hand's breadth back from the stand tile's centre.
    const seat = slot === 0 && SEAT_KINDS.has(st.kind) ? 0.08 : 0;
    return { tile, wp: { gx: tile.gx + ox, gy: tile.gy + oy + seat, elev } };
  }

  private reroute(a: Agent): void {
    const t = this.targetFor(a.at, a.slot);
    if (!t) return;
    const L = this.layout;
    const from = { ...a.pos };
    const start: Point = { gx: clampInt(Math.round(from.gx), 0, L.cols - 1), gy: clampInt(Math.round(from.gy), 0, L.rows - 1) };
    const plan = planWalk(L, start, t.tile, this.hopTiles);
    let pts: Waypoint[];
    let hop = false;
    if (!plan || plan.hop) {
      pts = [from, t.wp];
      hop = true;
    } else {
      pts = [from];
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
    const duration = hop ? Math.min(HOP_MAX_MS, HOP_MIN_MS + HOP_PER_TILE_MS * length) * 1.4 : Math.max(MIN_MOVE_MS, (length / WALK_TILES_PER_SEC) * 1000);
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

  // ---------- stamps and confetti ----------

  private stamp(kind: StampKind, at: StationId): void {
    if (this.disposed || !this.layout.resolve(at)) return;
    const R = this.theme.palette().room;
    const good = kind === 'approved' || kind === 'passed' || kind === 'merged';
    const color = good ? R.ok : kind === 'changes' ? R.alert : R.failed;
    const sprite = this.kit.labelSprite(kind.toUpperCase(), 0.42, { fg: R.paper, bg: color, px: 52, bold: true });
    if (!sprite) return;
    sprite.visible = false;
    this.scene.add(sprite);
    this.stamps.push({ kind, at, t0: null, sprite });
    while (this.stamps.length > MAX_STAMPS) this.dropStamp(this.stamps.shift()!);
    this.dirty = true;
  }

  private dropStamp(s: Stamp): void {
    this.scene.remove(s.sprite);
    s.sprite.material.dispose();
  }

  private throwConfetti(a: Agent): void {
    const T = this.T;
    const b = this.theme.palette().base;
    const colors = [b.accent, b.cyan, b.yellow, b.pink, b.violet, b.green];
    const origin = this.world(a);
    origin.y += a.rig.height + 0.2;
    for (let i = 0; i < CONFETTI; i++) {
      const h = hash01(`${a.id}:${i}:${this.frames}`);
      const h2 = hash01(`${i}:${a.id}`);
      const mesh = this.kit.mesh(this.kit.boxGeo(0.07, 0.012, 0.045), this.kit.mat(colors[i % colors.length]!, { double: true }), origin.x, origin.y, origin.z, 'none');
      this.scene.add(mesh);
      const ang = h * Math.PI * 2;
      const sp = 0.8 + h2 * 1.4;
      this.confetti.push({ mesh, v: new T.Vector3(Math.cos(ang) * sp, 3.2 + h2 * 2.2, Math.sin(ang) * sp), spin: new T.Vector3(h * 9, h2 * 9, (h + h2) * 5), t0: null });
    }
  }

  // ---------- the frame ----------

  frame(now: number): void {
    if (this.disposed || !Number.isFinite(now)) return;
    const started = this.clock();
    const dt = this.lastNow === null ? 16 : Math.max(0, Math.min(100, now - this.lastNow));
    const pal = this.theme.palette();
    this.room?.tick(now, dt);

    for (const a of [...this.agents.values()]) {
      this.advance(a, now, dt);
      if (!this.agents.has(a.id)) continue;
      const seated = this.isSeated(a);
      pose(a.rig, {
        anim: a.anim, seated, walking: !!a.motion && !a.motion.hop, hopping: !!a.motion?.hop, celebrating: !!a.celebrate,
        stride: a.stride, now, alpha: a.alpha,
      }, dt, pal);
      const p = this.world(a);
      a.rig.root.position.copy(p);
      a.rig.root.rotation.y = a.yaw;
    }

    // Stamps rise and fade over their station; confetti falls.
    this.stamps = this.stamps.filter((s) => {
      if (s.t0 === null) s.t0 = now;
      const u = clamp01((now - s.t0) / STAMP_MS);
      const st = this.layout.resolve(s.at);
      if (!st || u >= 1) {
        this.dropStamp(s);
        return false;
      }
      const pop = u < 0.12 ? 0.6 + (u / 0.12) * 0.5 : u < 0.2 ? 1.1 - ((u - 0.12) / 0.08) * 0.1 : 1;
      s.sprite.visible = true;
      s.sprite.position.set(st.grid.gx, st.elevation * ELEV_K + 1.9 + u * 0.5, st.grid.gy - 0.4);
      const base = (s.sprite.userData.base as [number, number] | undefined) ?? (s.sprite.userData.base = [s.sprite.scale.x, s.sprite.scale.y]);
      s.sprite.scale.set(base[0] * pop, base[1] * pop, 1);
      s.sprite.material.opacity = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1;
      return true;
    });
    this.confetti = this.confetti.filter((c) => {
      if (c.t0 === null) c.t0 = now;
      const t = now - c.t0;
      if (t > CONFETTI_MS) {
        this.scene.remove(c.mesh);
        return false;
      }
      const s = dt / 1000;
      c.v.y -= 7 * s;
      c.v.multiplyScalar(0.985);
      c.mesh.position.addScaledVector(c.v, s);
      if (c.mesh.position.y < 0.02) {
        c.mesh.position.y = 0.02;
        c.v.set(0, 0, 0);
      }
      c.mesh.rotation.x += c.spin.x * s;
      c.mesh.rotation.y += c.spin.y * s;
      c.mesh.rotation.z += c.spin.z * s;
      return true;
    });

    this.gl.render(this.scene, this.camera);
    this.dirty = false;
    this.record(now, this.clock() - started, this.agents.size);
  }

  private advance(a: Agent, now: number, dt: number): void {
    const m = a.motion;
    if (m) {
      if (m.t0 === null) m.t0 = now;
      const u = clamp01((now - m.t0) / m.duration);
      const d = m.length * (m.hop ? u : easeInOutSine(u));
      let i = 1;
      while (i < m.pts.length - 1 && m.cum[i]! < d) i++;
      const p = m.pts[i - 1]!;
      const q = m.pts[i]!;
      const span = m.cum[i]! - m.cum[i - 1]!;
      const f = span > 1e-9 ? clamp01((d - m.cum[i - 1]!) / span) : 1;
      const dx = q.gx - p.gx;
      const dz = q.gy - p.gy;
      if (Math.hypot(dx, dz) > 1e-6) a.yaw = turn(a.yaw, Math.atan2(dx, dz), dt);
      a.pos = u >= 1 ? { ...m.pts[m.pts.length - 1]! } : { gx: p.gx + dx * f, gy: p.gy + dz * f, elev: p.elev + (q.elev - p.elev) * f };
      a.lift = m.hop && u < 1 ? Math.sin(Math.PI * u) * HOP_LIFT : 0;
      a.stride += (dt / 1000) * (WALK_TILES_PER_SEC / 1.6);
      if (u >= 1) a.motion = null;
    } else {
      // At rest everyone faces their station's furniture (it is behind the stand tile), or into the room at the door.
      a.yaw = turn(a.yaw, Math.PI, dt);
    }
    if (a.leaving && !a.motion && !a.fadeOut) a.fadeOut = { t0: null };
    if (a.fadeOut) {
      if (a.fadeOut.t0 === null) a.fadeOut.t0 = now;
      const u = clamp01((now - a.fadeOut.t0) / SPAWN_FADE_MS);
      a.alpha = 1 - u;
      if (u >= 1) {
        this.scene.remove(a.rig.root);
        this.agents.delete(a.id);
        return;
      }
    } else {
      if (a.born === null) a.born = now;
      a.alpha = clamp01((now - a.born) / SPAWN_FADE_MS);
    }
    if (a.celebrate) {
      if (a.celebrate.t0 === null) a.celebrate.t0 = now;
      if (now - a.celebrate.t0 >= CELEBRATE_MS) a.celebrate = null;
    }
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [type, fn, opts] of this.listeners) this.canvas.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    for (const s of this.stamps) this.dropStamp(s);
    this.stamps = [];
    for (const c of this.confetti) this.scene.remove(c.mesh);
    this.confetti = [];
    this.agents.clear();
    this.stationStates.clear();
    this.extras.clear();
    this.scene.clear();
    this.kit.dispose();
    this.gl.dispose();
    this.dirty = false;
  }
}

/** Turn toward `target` along the short way, quickly but not instantly. */
function turn(cur: number, target: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const k = 1 - Math.pow(0.001, dt / 1000 * 4);
  return cur + d * k;
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

/** True where WebGL can draw (the page falls back to the Canvas2D garage elsewhere). */
export function webglAvailable(make: () => { getContext(id: string): unknown } | null): boolean {
  try {
    const c = make();
    return !!(c && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

/** Make the 3D renderer. Nothing is drawn until `frame(now)`; `dispose()` releases the GPU and every listener. */
export function createScene3D(o: Scene3DOptions): CanvasRenderer {
  return new Scene3D(o);
}
