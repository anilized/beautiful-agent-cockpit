// The room: geometry computed from data on a 2:1 iso projection, plus the station registry.
// Pure and DOM-free. The layout says where things are; it never decides who may go there (`canVisit` does).
import type { BayId, GarageState, RepoId, SeatId, StationExtension, StationId, StationKind, TaskKey } from './model.js';
import type { Point, WalkGrid } from './path.js';

// ---------- projection ----------

/** Tile size in screen pixels (2:1). Pixel art: the renderer scales by an integer zoom. */
export const TILE_W = 32;
export const TILE_H = 16;
/** How far the council loft is raised, in screen pixels. */
export const LOFT_ELEVATION = 12;
const MARGIN = 16;
/** The room is at least this wide, in tiles. */
const MIN_COLS = 22;
export const MIN_BAYS = 6;
export const MIN_QUEUE_SLOTS = 6;
/** The back wall (task board) takes this many rows above the loft. */
const WALL_ROWS = 2;
const CELL_H = 3;

export const BOARD_COLUMNS = ['TODO', 'DOING', 'REVIEW', 'DONE'] as const;

// ---------- spec ----------

export interface BaySpec {
  id: BayId;
  task?: TaskKey | null;
  repo?: RepoId | null;
}

export interface LeadSpec {
  id: SeatId;
  /** Display only (the areas this lead owns). */
  areas?: string[];
}

export interface LayoutSpec {
  /** Council seat ids, in loft order. */
  council: SeatId[];
  /** The council seat that chairs (gets the ★); defaults to the first. */
  chair?: SeatId | null;
  leads: LeadSpec[];
  /** The head Lead (biggest desk, owns the outbox); defaults to the first lead. */
  head?: SeatId | null;
  /** Bays in use; the layout pads to at least {@link MIN_BAYS}. */
  bays: BaySpec[];
  repos: RepoId[];
  /** Waiting places at the entrance; raised to fit `workers` that have no bay. */
  queueSlots?: number;
  /** Worker count, used to size the entrance queue. */
  workers?: number;
  extensions?: StationExtension[];
}

// ---------- layout ----------

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface StationPlacement {
  id: StationId;
  kind: StationKind;
  label: string;
  /** The tile a character stands on at this station. */
  grid: Point;
  /** Screen position of that tile's centre (elevation applied). */
  screen: ScreenPoint;
  elevation: number;
  /** Tiles the furniture occupies (not walkable). */
  footprint: Point[];
  meta: Record<string, string | number | boolean | null>;
}

export interface Region {
  id: 'wall' | 'board' | 'loft';
  gx: number;
  gy: number;
  w: number;
  h: number;
}

export interface Layout extends WalkGrid {
  spec: LayoutSpec;
  /** Room size in tiles. */
  cols: number;
  rows: number;
  /** Size of the drawn room in screen pixels at zoom 1. */
  width: number;
  height: number;
  regions: Region[];
  boardColumns: readonly string[];
  stations: Record<string, StationPlacement>;
  /** Every registered station id, in registration order. */
  ids(): StationId[];
  resolve(id: StationId): StationPlacement | null;
  /** Tile centre in screen pixels. */
  toScreen(gx: number, gy: number, elevation?: number): ScreenPoint;
  /** Which tile a screen point is over (ignores elevation). */
  toGrid(x: number, y: number): Point;
  /** The `i`th waiting place at the entrance (never throws; grows past the configured count). */
  queueSlot(i: number): Point;
  readonly queueSlots: number;
  /** Add an extension station beside an existing one. Replaces an extension with the same id. */
  register(ext: StationExtension): StationPlacement;
  /** The biggest integer zoom that fits the room in a viewport (at least 1). */
  fitZoom(viewW: number, viewH: number): number;
}

interface Item {
  id: StationId;
  kind: StationKind;
  label: string;
  w: number;
  blocked: Array<[number, number]>;
  stand: [number, number];
  elevation: number;
  meta: Record<string, string | number | boolean | null>;
}

const letterOf = (i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/** The bays to draw: those in use plus placeholders (A, B, ...) until there are {@link MIN_BAYS}. */
export function padBays(bays: BaySpec[]): BaySpec[] {
  const out = [...bays].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set(out.map((b) => b.id));
  for (let i = 0; out.length < MIN_BAYS; i++) {
    const id = letterOf(i);
    if (!used.has(id)) {
      used.add(id);
      out.push({ id });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function bayLabel(b: BaySpec, index: number): string {
  const letter = /^[A-Za-z]$/.test(b.id) ? b.id.toUpperCase() : letterOf(index);
  return ['BAY ' + letter, b.task ?? null, b.repo ?? null].filter((p): p is string => !!p).join(' — ');
}

/** Lay items left to right, wrapping at the room width. Returns each item's top-left cell and the next free row. */
function flow(items: Item[], y0: number, cols: number): { at: Array<{ item: Item; x: number; y: number }>; endY: number } {
  const at: Array<{ item: Item; x: number; y: number }> = [];
  let x = 1;
  let y = y0;
  for (const item of items) {
    if (x > 1 && x + item.w > cols - 1) {
      x = 1;
      y += CELL_H;
    }
    at.push({ item, x, y });
    x += item.w;
  }
  return { at, endY: items.length ? y + CELL_H : y0 };
}

const tableItem = (id: StationId, kind: StationKind, label: string, w: number, tableW: number, elevation = 0): Item => ({
  id,
  kind,
  label,
  w,
  blocked: Array.from({ length: tableW }, (_, i): [number, number] => [i, 0]),
  stand: [Math.min(Math.floor((tableW - 1) / 2), w - 1), 1],
  elevation,
  meta: {},
});

export function buildLayout(input: Partial<LayoutSpec> = {}): Layout {
  const spec: LayoutSpec = {
    council: input.council ?? [],
    chair: input.chair ?? null,
    leads: input.leads ?? [],
    head: input.head ?? null,
    bays: padBays(input.bays ?? []),
    repos: [...(input.repos ?? [])],
    queueSlots: input.queueSlots,
    workers: input.workers,
    extensions: input.extensions ?? [],
  };
  const chair = spec.chair && spec.council.includes(spec.chair) ? spec.chair : (spec.council[0] ?? null);
  const head = spec.head && spec.leads.some((l) => l.id === spec.head) ? spec.head : (spec.leads[0]?.id ?? null);

  const cols = Math.max(MIN_COLS, spec.council.length * 2 + 3);

  // Sections, back to front: wall (board), loft, lead desks + outbox, bays, lab/bench/terminal, crates, entrance.
  const loftItems: Item[] = spec.council.map((seat) => {
    const isChair = seat === chair;
    const it = tableItem(`loft:${seat}`, 'loft', (isChair ? '★ ' : '') + seat, 2, 2, LOFT_ELEVATION);
    it.meta = { seat, chair: isChair };
    return it;
  });

  const deskItems: Item[] = [];
  const ordered = [...spec.leads].sort((a, b) => (a.id === head ? -1 : b.id === head ? 1 : 0));
  for (const lead of ordered) {
    const isHead = lead.id === head;
    const it = tableItem(`desk:${lead.id}`, 'desk', lead.id, isHead ? 6 : 4, isHead ? 5 : 3);
    it.meta = { seat: lead.id, head: isHead, areas: (lead.areas ?? []).join(', ') };
    deskItems.push(it);
    if (isHead) deskItems.push(tableItem('outbox', 'outbox', 'OUTBOX', 2, 1));
  }
  if (!deskItems.some((i) => i.id === 'outbox')) deskItems.push(tableItem('outbox', 'outbox', 'OUTBOX', 2, 1));

  const bayItems: Item[] = spec.bays.map((b, i) => {
    const it = tableItem(`bay:${b.id}`, 'bay', bayLabel(b, i), 3, 2);
    it.meta = { bay: b.id, task: b.task ?? null, repo: b.repo ?? null };
    return it;
  });

  const serviceItems: Item[] = [
    tableItem('lab', 'lab', 'TEST LAB', 4, 3),
    tableItem('bench', 'bench', 'INTEGRATION BENCH', 4, 3),
    tableItem('terminal', 'terminal', 'TERMINAL', 3, 2),
  ];

  const crateItems: Item[] = spec.repos.map((repo) => {
    const it = tableItem(`crate:${repo}`, 'crate', repo, 3, 2);
    it.meta = { repo };
    return it;
  });

  const loftY = WALL_ROWS;
  const loft = flow(loftItems, loftY, cols);
  const desks = flow(deskItems, Math.max(loft.endY, loftY), cols);
  const bays = flow(bayItems, desks.endY, cols);
  const services = flow(serviceItems, bays.endY, cols);
  const crates = flow(crateItems, services.endY, cols);

  const entranceY = crates.endY;
  const entranceX = Math.floor(cols / 2);
  const perRow = cols - 2;
  const queueSlots = Math.max(
    spec.queueSlots ?? 0,
    MIN_QUEUE_SLOTS,
    Math.max(0, (spec.workers ?? 0) - spec.bays.length),
  );
  const queueRows = Math.ceil(queueSlots / perRow);
  const rows = entranceY + 1 + queueRows + 1;

  // Walk grid.
  const blockedTiles = new Uint8Array(cols * rows);
  const block = (gx: number, gy: number): void => {
    if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) blockedTiles[gy * cols + gx] = 1;
  };
  for (let gy = 0; gy < WALL_ROWS; gy++) for (let gx = 0; gx < cols; gx++) block(gx, gy);

  const maxElev = spec.council.length ? LOFT_ELEVATION : 0;
  const originX = rows * (TILE_W / 2) + MARGIN;
  const originY = MARGIN + maxElev;
  const toScreen = (gx: number, gy: number, elevation = 0): ScreenPoint => ({
    x: (gx - gy) * (TILE_W / 2) + originX,
    y: (gx + gy + 1) * (TILE_H / 2) + originY - elevation,
  });
  const toGrid = (x: number, y: number): Point => {
    const a = (x - originX) / (TILE_W / 2);
    const b = (y - originY) / (TILE_H / 2);
    return { gx: Math.floor((a + b) / 2), gy: Math.floor((b - a) / 2) };
  };

  const stations: Record<string, StationPlacement> = {};
  const order: StationId[] = [];
  const place = (id: StationId, kind: StationKind, label: string, gx: number, gy: number, elevation: number, footprint: Point[], meta: StationPlacement['meta']): StationPlacement => {
    const p: StationPlacement = { id, kind, label, grid: { gx, gy }, screen: toScreen(gx, gy, elevation), elevation, footprint, meta };
    if (!stations[id]) order.push(id);
    stations[id] = p;
    return p;
  };

  for (const section of [loft, desks, bays, services, crates]) {
    for (const { item, x, y } of section.at) {
      const footprint = item.blocked.map(([dx, dy]): Point => ({ gx: x + dx, gy: y + dy }));
      for (const t of footprint) block(t.gx, t.gy);
      place(item.id, item.kind, item.label, x + item.stand[0], y + item.stand[1], item.elevation, footprint, item.meta);
    }
  }
  place('entrance', 'entrance', 'ENTRANCE', entranceX, entranceY, 0, [], {});

  const walkable = (gx: number, gy: number): boolean => gx >= 0 && gy >= 0 && gx < cols && gy < rows && blockedTiles[gy * cols + gx] === 0;

  const slotAt = (i: number): Point => {
    const n = Math.max(0, Math.floor(i));
    return { gx: 1 + (n % perRow), gy: entranceY + 1 + Math.floor(n / perRow) };
  };

  /** The walkable tile closest to (gx, gy), searching outward ring by ring in a fixed order. */
  const nearestWalkable = (gx: number, gy: number): Point => {
    const cx = Math.min(Math.max(gx, 0), cols - 1);
    const cy = Math.min(Math.max(gy, 0), rows - 1);
    for (let r = 0; r <= cols + rows; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walkable(cx + dx, cy + dy)) return { gx: cx + dx, gy: cy + dy };
        }
      }
    }
    return { gx: entranceX, gy: entranceY };
  };

  const register = (ext: StationExtension): StationPlacement => {
    if (!ext.id.startsWith('ext:')) throw new Error(`extension id must start with "ext:": ${ext.id}`);
    let target: Point;
    let elevation = 0;
    if (ext.near) {
      const anchor = stations[ext.near.station];
      if (!anchor) throw new Error(`extension ${ext.id} sits beside unknown station ${ext.near.station}`);
      target = { gx: anchor.grid.gx + ext.near.dx, gy: anchor.grid.gy + ext.near.dy };
      elevation = anchor.elevation;
    } else {
      target = slotAt(0);
    }
    // An extension is always standable and reachable: a blocked or off-room spot slides to the nearest free tile.
    const at = nearestWalkable(target.gx, target.gy);
    return place(ext.id, 'ext', ext.label, at.gx, at.gy, elevation, [], { extKind: ext.kind, ...(ext.data ?? {}) });
  };

  const width = (cols + rows) * (TILE_W / 2) + 2 * MARGIN;
  const height = (cols + rows) * (TILE_H / 2) + 2 * MARGIN + maxElev;
  const layout: Layout = {
    spec,
    cols,
    rows,
    width,
    height,
    walkable,
    regions: [
      { id: 'wall', gx: 0, gy: 0, w: cols, h: WALL_ROWS },
      { id: 'board', gx: 1, gy: 0, w: cols - 2, h: WALL_ROWS },
      { id: 'loft', gx: 0, gy: loftY, w: cols, h: Math.max(loft.endY - loftY, 0) },
    ],
    boardColumns: BOARD_COLUMNS,
    stations,
    queueSlots,
    queueSlot: slotAt,
    toScreen,
    toGrid,
    ids: () => [...order],
    resolve: (id) => stations[id] ?? null,
    register,
    fitZoom: (viewW, viewH) => Math.max(1, Math.floor(Math.min(viewW / width, viewH / height))),
  };
  for (const ext of spec.extensions ?? []) register(ext);
  return layout;
}

// ---------- from state ----------

const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** The layout spec a game state calls for: council, leads, bays and repos it mentions, and the workers waiting. */
export function layoutSpecFromState(state: GarageState, extras: Pick<LayoutSpec, 'chair' | 'head' | 'extensions'> = {}): LayoutSpec {
  const council = new Set<string>();
  const leads = new Set<string>();
  const bayIds = new Set<string>();
  const repos = new Set<string>();
  const ids: StationId[] = [];
  let workers = 0;
  for (const c of Object.values(state.characters)) {
    if (c.kind === 'council') council.add(c.seat ?? c.id);
    else if (c.kind === 'lead') leads.add(c.seat ?? c.id);
    else workers++;
    ids.push(c.home, c.station);
  }
  ids.push(...(Object.keys(state.stations) as StationId[]));
  for (const id of ids) {
    if (id.startsWith('loft:')) council.add(id.slice(5));
    else if (id.startsWith('desk:')) leads.add(id.slice(5));
    else if (id.startsWith('bay:')) bayIds.add(id.slice(4));
    else if (id.startsWith('crate:')) repos.add(id.slice(6));
  }
  for (const b of Object.values(state.bayOf)) bayIds.add(b);
  for (const r of Object.values(state.crateOf)) repos.add(r);
  for (const t of Object.values(state.taskIndex.tasks)) if (t.repo) repos.add(t.repo);

  const bays: BaySpec[] = uniqSorted(bayIds).map((id) => {
    const key = Object.keys(state.bayOf).sort().find((k) => state.bayOf[k] === id);
    return { id, task: key ?? null, repo: key ? (state.crateOf[key] ?? state.taskIndex.tasks[key]?.repo ?? null) : null };
  });
  return {
    council: uniqSorted(council),
    chair: extras.chair ?? null,
    leads: uniqSorted(leads).map((id) => ({ id })),
    head: extras.head ?? null,
    bays,
    repos: uniqSorted(repos),
    workers,
    extensions: extras.extensions ?? [],
  };
}

export function layoutFromState(state: GarageState, extras?: Pick<LayoutSpec, 'chair' | 'head' | 'extensions'>): Layout {
  return buildLayout(layoutSpecFromState(state, extras));
}
