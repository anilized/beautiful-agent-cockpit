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
/** A team zone, back to front: its wall row, row A's chairs, row A's desks, row B's desks, row B's chairs, an aisle. */
const ZONE_H = 6;
/** A team of one or two: desks in a row against the zone's back wall, their chairs, an aisle. */
const SMALL_ZONE_H = 4;
/** Columns a pod of four desks takes (two desks of two tiles, and a walkway). */
const POD_W = 5;
const POD_SEATS = 4;
/** The lounge, at the back right beside the loft and the lead desks, is at least this wide. */
const LOUNGE_W = 8;
/** Room the loft's stairs need to its right. */
const STAIRS_W = 5;

export const BOARD_COLUMNS = ['TODO', 'DOING', 'REVIEW', 'DONE'] as const;

// ---------- spec ----------

export interface BaySpec {
  id: BayId;
  task?: TaskKey | null;
  repo?: RepoId | null;
  /** The team whose zone the bay sits in (the task's persona specialty); none: a hot desk. */
  team?: string | null;
  /** Whose desk it is, for the things on it (the task's persona); defaults to the bay. */
  owner?: string | null;
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
  /** Minimum waiting places at the entrance. The layout always has at least max(this, `waiting`, 6) slots. */
  queueSlots?: number;
  /** Workers that have no bay and wait at the entrance; each gets its own slot. Unused bays do not reduce it. */
  waiting?: number;
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
  id: 'wall' | 'board' | 'loft' | 'lounge';
  gx: number;
  gy: number;
  w: number;
  h: number;
}

/** A team's corner: a wall row at the back (open at `door`), a wall column on the left, pods of desks inside. */
export interface Zone {
  id: string;
  /** The specialty (backend, frontend ...); null for the hot desks. */
  team: string | null;
  label: string;
  gx: number;
  gy: number;
  w: number;
  h: number;
  /** The gap in the back wall. */
  door: Point;
}

export type LoungeAct = 'couch' | 'beanbag' | 'foosball' | 'coffee' | 'chat' | 'arcade' | 'phone';

/** Where someone with nothing to do hangs out, and what they do there. */
export interface LoungeSpot {
  /** The walkable tile they walk to. */
  tile: Point;
  /** From that tile to where they settle (a couch seat is on blocked tiles). */
  dx: number;
  dy: number;
  /** Which way they face, radians about the vertical: 0 faces the front of the room (+gy), π the back wall. */
  yaw: number;
  act: LoungeAct;
}

export interface LoungeProp {
  kind: 'kitchen' | 'couch' | 'arcade' | 'foosball' | 'beanbag';
  /** Centre, in tiles (fractional: the kitchen, couch and arcade stand against the back wall). */
  gx: number;
  gy: number;
}

export interface Lounge {
  gx: number;
  gy: number;
  w: number;
  h: number;
  props: LoungeProp[];
  spots: LoungeSpot[];
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
  /** The team zones the bays are grouped into, back to front, left to right. */
  zones: Zone[];
  lounge: Lounge;
  /** The `i`th place in the lounge (never throws; wraps past the last). */
  loungeSpot(i: number): LoungeSpot;
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

/** A persona's team: the head of its id (backend-dev -> backend), as the cockpit names specialties. */
export function teamOf(persona: string | null | undefined): string | null {
  const head = persona ? persona.split('-')[0] : '';
  return head ? head : null;
}

const TEAM_ORDER = ['backend', 'api', 'database', 'db', 'frontend', 'ui', 'test', 'qa', 'docs', 'documentation', 'research'];
const TEAM_LABEL: Record<string, string> = {
  backend: 'BACKEND', api: 'API', database: 'DATABASE', db: 'DATABASE', frontend: 'FRONTEND', ui: 'FRONTEND', test: 'QA', qa: 'QA',
  docs: 'DOCS', documentation: 'DOCS', research: 'RESEARCH', security: 'SECURITY', performance: 'PERF', refactoring: 'REFACTOR', generalist: 'GENERAL',
};
/** What a team's sign says. */
export const teamLabel = (team: string | null): string => (team === null ? 'HOT DESKS' : (TEAM_LABEL[team] ?? team.toUpperCase()));
const teamRank = (team: string | null): number => (team === null ? 1e6 : TEAM_ORDER.includes(team) ? TEAM_ORDER.indexOf(team) : 1e3);

/**
 * Bays grouped by team, in a fixed order (hot desks last). Placeholder bays (no task, no team) first fill the teams'
 * half-empty pods, then sit together as hot desks.
 */
function teamGroups(bays: BaySpec[]): Array<{ team: string | null; bays: BaySpec[] }> {
  const free = bays.filter((b) => !b.task && !b.team);
  const byTeam = new Map<string | null, BaySpec[]>();
  for (const b of bays) {
    if (free.includes(b)) continue;
    const t = b.team ?? null;
    (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(b);
  }
  const teams = [...byTeam.keys()].sort((a, b) => teamRank(a) - teamRank(b) || String(a).localeCompare(String(b)));
  const out = teams.map((team) => ({ team, bays: byTeam.get(team)! }));
  for (const g of out) {
    if (g.team === null) continue;
    while (free.length && g.bays.length % POD_SEATS) g.bays.push(free.shift()!);
  }
  if (free.length) {
    const hot = out.find((g) => g.team === null);
    if (hot) hot.bays.push(...free);
    else out.push({ team: null, bays: free });
  }
  return out;
}

function bayLabel(b: BaySpec, index: number): string {
  const letter = /^[A-Za-z]$/.test(b.id) ? b.id.toUpperCase() : letterOf(index);
  return ['BAY ' + letter, b.task ?? null, b.repo ?? null].filter((p): p is string => !!p).join(' — ');
}

/** Lay items left to right, wrapping before column `right`. Returns each item's top-left cell and the next free row. */
function flow(items: Item[], y0: number, right: number): { at: Array<{ item: Item; x: number; y: number }>; endY: number } {
  const at: Array<{ item: Item; x: number; y: number }> = [];
  let x = 1;
  let y = y0;
  for (const item of items) {
    if (x > 1 && x + item.w > right) {
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

/**
 * The lounge's furniture and its places, in a region whose back edge is the back wall. Blocks the foosball table's tiles.
 * The kitchen, couch and arcade stand on the wall rows (already blocked); their users reach them from the first floor row.
 */
function buildLounge(gx: number, gy: number, w: number, h: number, block: (gx: number, gy: number) => void): Lounge {
  const props: LoungeProp[] = [];
  const spots: LoungeSpot[] = [];
  const wallZ = gy - 1.3;
  const arcade = w >= 8;
  const couchX = gx + w - (arcade ? 3.8 : 2.4);
  props.push({ kind: 'kitchen', gx: gx + 0.9, gy: wallZ }, { kind: 'couch', gx: couchX, gy: wallZ });
  if (arcade) props.push({ kind: 'arcade', gx: gx + w - 1.1, gy: wallZ });
  const seat = (x: number): LoungeSpot => {
    const t = Math.round(x);
    return { tile: { gx: t, gy }, dx: x - t, dy: wallZ + 0.15 - gy, yaw: 0, act: 'couch' };
  };
  spots.push(seat(couchX - 0.55));
  if (arcade) spots.push({ tile: { gx: gx + w - 1, gy }, dx: -0.1, dy: -0.2, yaw: Math.PI, act: 'arcade' });
  if (h >= 4 && w >= 6) {
    // Foosball across two tiles, a player at each end.
    const fy = gy + 2;
    block(gx + 2, fy);
    block(gx + 3, fy);
    props.push({ kind: 'foosball', gx: gx + 2.5, gy: fy });
    spots.push({ tile: { gx: gx + 1, gy: fy }, dx: 0.25, dy: 0, yaw: Math.PI / 2, act: 'foosball' }, { tile: { gx: gx + 4, gy: fy }, dx: -0.25, dy: 0, yaw: -Math.PI / 2, act: 'foosball' });
  }
  spots.push({ tile: { gx: gx + 1, gy }, dx: 0, dy: -0.25, yaw: Math.PI, act: 'coffee' });
  spots.push(seat(couchX + 0.55));
  spots.push({ tile: { gx: gx + 2, gy }, dx: -0.2, dy: 0.25, yaw: Math.atan2(-0.8, -0.5), act: 'chat' });
  if (h >= 4) {
    const bx = gx + w - 2;
    props.push({ kind: 'beanbag', gx: bx, gy: gy + 2 });
    spots.push({ tile: { gx: bx, gy: gy + 2 }, dx: 0, dy: 0, yaw: -0.5, act: 'beanbag' });
  }
  return { gx, gy, w, h, props, spots };
}

export function buildLayout(input: Partial<LayoutSpec> = {}): Layout {
  const spec: LayoutSpec = {
    council: input.council ?? [],
    chair: input.chair ?? null,
    leads: input.leads ?? [],
    head: input.head ?? null,
    bays: padBays(input.bays ?? []),
    repos: [...(input.repos ?? [])],
    queueSlots: input.queueSlots,
    waiting: input.waiting,
    extensions: input.extensions ?? [],
  };
  const chair = spec.chair && spec.council.includes(spec.chair) ? spec.chair : (spec.council[0] ?? null);
  const head = spec.head && spec.leads.some((l) => l.id === spec.head) ? spec.head : (spec.leads[0]?.id ?? null);

  const cols = Math.max(MIN_COLS, spec.council.length * 2 + 3);
  // The loft and the lead desks keep to the left; the lounge takes the back right.
  const backRight = cols - LOUNGE_W - 1;

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
  const loft = flow(loftItems, loftY, backRight - STAIRS_W + 1);
  const desks = flow(deskItems, Math.max(loft.endY, loftY), backRight);

  // Team zones: each a block of pods, flowed left to right and wrapped like everything else.
  const maxPods = Math.max(1, Math.floor((cols - 1) / POD_W));
  const blocks: Array<{ team: string | null; bays: BaySpec[]; part: number }> = [];
  for (const g of teamGroups(spec.bays)) {
    for (let i = 0, part = 0; i < g.bays.length; i += maxPods * POD_SEATS, part++) blocks.push({ team: g.team, bays: g.bays.slice(i, i + maxPods * POD_SEATS), part });
  }
  const zones: Zone[] = [];
  const zoneBays: Array<{ zone: Zone; bays: BaySpec[] }> = [];
  let zonesEndY = desks.endY;
  {
    let x = 0;
    let y = desks.endY;
    for (const b of blocks) {
      const small = b.bays.length <= 2;
      const w = small ? 2 + b.bays.length * 2 : 1 + Math.ceil(b.bays.length / POD_SEATS) * POD_W;
      const h = small ? SMALL_ZONE_H : ZONE_H;
      if (x > 0 && x + w > cols) {
        x = 0;
        y = zonesEndY;
      }
      const zone: Zone = { id: `zone:${b.team ?? 'hot'}:${b.part}`, team: b.team, label: teamLabel(b.team), gx: x, gy: y, w, h, door: { gx: x + w - 1, gy: y } };
      zones.push(zone);
      zoneBays.push({ zone, bays: b.bays });
      zonesEndY = Math.max(zonesEndY, y + h);
      x += w;
    }
  }
  const services = flow(serviceItems, zonesEndY, cols - 1);
  const crates = flow(crateItems, services.endY, cols - 1);

  const entranceY = crates.endY;
  const entranceX = Math.floor(cols / 2);
  const perRow = cols - 2;
  const queueSlots = Math.max(
    spec.queueSlots ?? 0,
    MIN_QUEUE_SLOTS,
    Math.max(0, Math.floor(spec.waiting ?? 0)),
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

  const placeFlow = (section: { at: Array<{ item: Item; x: number; y: number }> }) => {
    for (const { item, x, y } of section.at) {
      const footprint = item.blocked.map(([dx, dy]): Point => ({ gx: x + dx, gy: y + dy }));
      for (const t of footprint) block(t.gx, t.gy);
      place(item.id, item.kind, item.label, x + item.stand[0], y + item.stand[1], item.elevation, footprint, item.meta);
    }
  };
  placeFlow(loft);
  placeFlow(desks);

  // The zones: walls (the back row but its door, the left column but the aisle), then the desks, each two tiles wide with
  // its sitter centred on it. In a pod row A sits facing the front of the room and row B faces the back; a small team sits
  // in one row facing its back wall.
  let bayIndex = 0;
  for (const { zone: z, bays } of zoneBays) {
    for (let gx = z.gx; gx < z.gx + z.w - 1; gx++) block(gx, z.gy);
    for (let gy = z.gy; gy < z.gy + z.h - 1; gy++) block(z.gx, gy);
    const small = z.h === SMALL_ZONE_H;
    bays.forEach((b, k) => {
      const s = k % POD_SEATS;
      const deskX = small ? z.gx + 1 + k * 2 : z.gx + 1 + Math.floor(k / POD_SEATS) * POD_W + (s % 2) * 2;
      const rowA = !small && s < 2;
      const deskY = small ? z.gy + 1 : z.gy + (rowA ? 2 : 3);
      const footprint: Point[] = [{ gx: deskX, gy: deskY }, { gx: deskX + 1, gy: deskY }];
      for (const t of footprint) block(t.gx, t.gy);
      place(`bay:${b.id}`, 'bay', bayLabel(b, bayIndex++), deskX, rowA ? deskY - 1 : deskY + 1, 0, footprint, {
        bay: b.id, task: b.task ?? null, repo: b.repo ?? null, team: z.team, owner: b.owner ?? `bay:${b.id}`, zone: z.id, face: rowA ? 1 : -1, seatDx: 0.5,
      });
    });
  }

  placeFlow(services);
  placeFlow(crates);

  // The lounge: whatever the loft (and its stairs) and the lead desks leave at the back right, between the back wall and
  // the zones. Kitchen, couch and arcade stand against the back wall; foosball on the floor.
  const rightOf = (section: { at: Array<{ item: Item; x: number }> }, extra: number) => Math.max(0, ...section.at.map(({ item, x }) => x + item.w + extra));
  const lx = Math.min(cols - LOUNGE_W, Math.max(rightOf(loft, STAIRS_W - 1), rightOf(desks, 0)));
  const lounge = buildLounge(lx, WALL_ROWS, cols - lx, Math.max(CELL_H, desks.endY - WALL_ROWS), block);
  place('entrance', 'entrance', 'ENTRANCE', entranceX, entranceY, 0, [], {});

  const walkable = (gx: number, gy: number): boolean => gx >= 0 && gy >= 0 && gx < cols && gy < rows && blockedTiles[gy * cols + gx] === 0;
  // The rest of the lounge floor: people stand there with their phones.
  const taken = new Set(lounge.spots.map((p) => `${p.tile.gx},${p.tile.gy}`));
  for (let gy = lounge.gy + 1; gy < lounge.gy + lounge.h; gy++) {
    for (let gx = lounge.gx; gx < lounge.gx + lounge.w - 1; gx++) {
      if (!walkable(gx, gy) || taken.has(`${gx},${gy}`)) continue;
      const k = lounge.spots.length;
      lounge.spots.push({ tile: { gx, gy }, dx: k % 2 ? 0.2 : -0.2, dy: 0, yaw: [0.4, -0.5, 0.9, -0.2][k % 4]!, act: 'phone' });
    }
  }

  const slotAt = (i: number): Point => {
    // Past the last slot the queue wraps, so the answer is always a real, walkable tile.
    const n = Math.max(0, Math.floor(i)) % queueSlots;
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
      { id: 'lounge', gx: lounge.gx, gy: lounge.gy, w: lounge.w, h: lounge.h },
    ],
    zones,
    lounge,
    loungeSpot: (i) => lounge.spots[Math.max(0, Math.floor(i)) % lounge.spots.length]!,
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
  let waiting = 0;
  for (const c of Object.values(state.characters)) {
    if (c.kind === 'council') council.add(c.seat ?? c.id);
    else if (c.kind === 'lead') leads.add(c.seat ?? c.id);
    else if (!c.station.startsWith('bay:') && !(c.task && state.bayOf[c.task])) waiting++;
    ids.push(c.home, c.station);
  }
  ids.push(...(Object.keys(state.stations) as StationId[]));
  const extensions = [...(extras.extensions ?? [])];
  for (const id of uniqSorted(ids)) {
    if (id.startsWith('ext:') && !extensions.some((e) => e.id === id)) {
      // Named by the state but never defined: a plain prop at a reachable fallback spot.
      extensions.push({ id: id as `ext:${string}`, kind: 'prop', label: id.slice(4) });
    }
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
    const persona = key ? (state.taskIndex.tasks[key]?.persona ?? null) : null;
    return { id, task: key ?? null, repo: key ? (state.crateOf[key] ?? state.taskIndex.tasks[key]?.repo ?? null) : null, team: teamOf(persona), owner: persona };
  });
  return {
    council: uniqSorted(council),
    chair: extras.chair ?? null,
    leads: uniqSorted(leads).map((id) => ({ id })),
    head: extras.head ?? null,
    bays,
    repos: uniqSorted(repos),
    waiting,
    extensions,
  };
}

export function layoutFromState(state: GarageState, extras?: Pick<LayoutSpec, 'chair' | 'head' | 'extensions'>): Layout {
  return buildLayout(layoutSpecFromState(state, extras));
}
