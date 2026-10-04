// The Pixel Garage contract: types only, no values, no DOM, no node.
// Every other garage module (mapper, tools, layout, path, renderer, overlays, stream) is written against these.
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';

// ---------- ids ----------

/** A seat id (sup-1, lead-1), a persona id (backend-dev), or `session:<sessionId>` when a session names neither. */
export type CharacterId = string;
export type SeatId = string;
export type PersonaId = string;
/** The human-facing task key (TASK-101), never the task's uuid. */
export type TaskKey = string;
export type SessionId = string;
export type BayId = string;
export type RepoId = string;

/** Council members sit in the loft, Leads at their desks, workers in a bay. */
export type CharacterKind = 'council' | 'lead' | 'worker';

export type StationId =
  | `loft:${SeatId}`
  | `desk:${SeatId}`
  | `bay:${BayId}`
  | `crate:${RepoId}`
  | 'lab'
  | 'bench'
  | 'terminal'
  | 'entrance'
  | 'outbox'
  | `ext:${string}`;

export type StationKind = 'loft' | 'desk' | 'bay' | 'crate' | 'lab' | 'bench' | 'terminal' | 'entrance' | 'outbox' | 'ext';

/**
 * The extension point for props, pets, cables and the like: an extra station the layout places next to an
 * existing one and the renderer draws. It never grants permissions (`canVisit` stays the only authority).
 */
export interface StationExtension {
  id: `ext:${string}`;
  /** What it is, for the layout and sprite registries (`prop`, `pet`, `cable`, ...). */
  kind: string;
  label: string;
  /** The station it sits beside, in tiles from that station's anchor. */
  near?: { station: StationId; dx: number; dy: number };
  /** Anything else a future feature needs; opaque to the mapper. */
  data?: Record<string, string | number | boolean | null>;
}

// ---------- character state ----------

/**
 * What a character is doing, in priority order: when several apply, the first one listed wins.
 * `failed > blocked > awaitingHuman > review > testing > implementing > researching > thinking > waiting > idle`.
 * A character with no live session never resolves to testing, implementing, researching or thinking.
 */
export type CharacterStateName =
  | 'failed'
  | 'blocked'
  | 'awaitingHuman'
  | 'review'
  | 'testing'
  | 'implementing'
  | 'researching'
  | 'thinking'
  | 'waiting'
  | 'idle';

/** What an animation can play: a character state, or a one-off. */
export type AnimationName = CharacterStateName | 'celebrate';

/** The coarse, structured conditions the resolver ranks (set from task status and events, never from prose). */
export interface CharacterFlags {
  failed: boolean;
  blocked: boolean;
  awaitingHuman: boolean;
  review: boolean;
}

export interface Character {
  id: CharacterId;
  kind: CharacterKind;
  label: string;
  agentId: string | null;
  seat: SeatId | null;
  persona: PersonaId | null;
  /** The Lead seat that owns this character (workers), or itself (leads); null for the council. */
  lead: SeatId | null;
  /** Where it sits when it has nothing to do. */
  home: StationId;
  /** Where it is, or is walking to: always a station `canVisit` allows. */
  station: StationId;
  /** The task it is on, when it has one. */
  task: TaskKey | null;
  flags: CharacterFlags;
  /** The state as last resolved; `resolveState` is the authority. */
  state: CharacterStateName;
}

export type OutputKind = 'text' | 'thinking' | 'tool' | 'result';

/** A model session: one call. Times are epoch milliseconds, seqs are event seqs (0 = none yet). */
export interface SessionInfo {
  characterId: CharacterId;
  agentId: string;
  task: TaskKey | null;
  contract: string | null;
  live: boolean;
  /** The latest `Tool: detail` line (at most 200 chars) and when/at which seq it was seen. */
  lastTool: string | null;
  lastToolAt: number | null;
  lastToolSeq: number;
  lastOutputKind: OutputKind | null;
  lastOutputAt: number | null;
  lastOutputSeq: number;
  /** Display only (bubbles, detail panel): never an input to state. */
  lastNarration: string | null;
}

// ---------- tasks, repos, bays ----------

export interface TaskInfo {
  id: string;
  key: TaskKey;
  title: string;
  status: string;
  persona: PersonaId | null;
  lead: SeatId | null;
  testCommand: string | null;
  repo: RepoId;
  worktree: string | null;
  branch: string | null;
}

/** Task ids (what events carry) and keys (what people read), with everything the classifier and `canVisit` need. */
export interface TaskIndex {
  keyOfId: Record<string, TaskKey>;
  idOfKey: Record<TaskKey, string>;
  tasks: Record<TaskKey, TaskInfo>;
}

// ---------- stations, board, outbox, display ----------

export type StationStateName = 'idle' | 'busy' | 'ok' | 'failed' | 'alert';

export interface StationState {
  id: StationId;
  kind: StationKind;
  state: StationStateName;
}

export type BoardColumn = 'backlog' | 'active' | 'review' | 'testing' | 'blocked' | 'done' | 'failed';

export interface BoardCard {
  key: TaskKey;
  title: string;
  persona: PersonaId | null;
  column: BoardColumn;
}

/** A proposal on its way to the Lead or the human: the garage's outbox. */
export interface OutboxItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  task: TaskKey | null;
}

/** A pending human approval, shown read-only: "approve in the cockpit (`a`) or `/cockpit approve`". */
export interface ApprovalCard {
  id: string;
  kind: string;
  summary: string;
  /** The whole question, when the snapshot carried it (an event gives the summary only). */
  text: string | null;
}

export interface LogEntry {
  seq: number | null;
  at: number;
  type: string;
  text: string;
}

export interface SpendEntry {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GarageState {
  run: { runId: string; lastSeq: number; phase: string; status: string };
  characters: Record<CharacterId, Character>;
  sessions: Record<SessionId, SessionInfo>;
  taskIndex: TaskIndex;
  bayOf: Record<TaskKey, BayId>;
  crateOf: Record<TaskKey, RepoId>;
  stations: Record<StationId, StationState>;
  board: BoardCard[];
  outbox: OutboxItem[];
  approval: ApprovalCard | null;
  log: LogEntry[];
  /** Totals plus per agent. Event-derived spend is provisional: every snapshot replaces it. */
  spend: { total: SpendEntry; byAgent: Record<string, SpendEntry> };
  limits: Snapshot['limits'];
}

// ---------- scene intents ----------

export type StampKind = 'approved' | 'changes' | 'passed' | 'failed' | 'rejected' | 'merged';
export type BubbleTone = 'say' | 'think' | 'tool';

/** What the renderer and overlays are asked to show; the mapper emits these, never the DOM. */
export type SceneIntent =
  | { type: 'spawn'; character: CharacterId; kind: CharacterKind; at: StationId }
  | { type: 'move'; character: CharacterId; to: StationId }
  | { type: 'animate'; character: CharacterId; animation: AnimationName }
  | { type: 'station'; id: StationId; state: StationStateName }
  | { type: 'stamp'; kind: StampKind; at: StationId; task: TaskKey | null }
  | { type: 'bubble'; character: CharacterId; text: string; tone: BubbleTone }
  | { type: 'celebrate'; scope: 'task' | 'run'; task: TaskKey | null };

// ---------- renderer ----------

/** Canvas2D today; anything that can draw the room behind this later. Stamps, bubbles and celebrations route via `updateStation`, `playAnimation` and the overlays. */
export interface GarageRenderer {
  spawnAgent(id: CharacterId, kind: CharacterKind, at: StationId): void;
  /** Eased, never a teleport; the renderer hops when the walk is long. */
  moveAgent(id: CharacterId, to: StationId): void;
  playAnimation(id: CharacterId, animation: AnimationName): void;
  updateStation(id: StationId, state: StationStateName): void;
  /** Draw one frame at `now` (epoch ms). */
  frame(now: number): void;
  dispose(): void;
}

// ---------- mapper entry points (declared here, implemented in mapper.ts) ----------

export interface MapResult {
  state: GarageState;
  intents: SceneIntent[];
}

/** Pure: durable and fine state come only from structured snapshot fields. `now` is epoch ms. */
export type FromSnapshot = (snap: Snapshot, runId: string, now: number) => GarageState;
/** Pure and idempotent: sets values, never toggles or increments (except provisional spend). */
export type ApplyEvent = (state: GarageState, ev: CockpitEvent, now: number) => MapResult;
/** Applies the priority order and the 20 s thinking rule. */
export type ResolveState = (char: Character, state: GarageState, now: number) => CharacterStateName;
/** The ownership-aware permission check: own lead, own bay, own repo; only leads and the council enter the loft. */
export type CanVisit = (char: Character, station: StationId, state: GarageState) => boolean;

// ---------- tools.ts classifier ----------

/** The states a tool call can put a character in. */
export type ToolState = 'researching' | 'implementing' | 'testing';
export type ToolKind = 'read' | 'edit' | 'test' | 'shell';

/** What the classifier knows about the task the tool ran for. */
export interface ToolContext {
  bay: BayId | null;
  repo: RepoId | null;
  testCommand: string | null;
}

export interface ToolClassification {
  kind: ToolKind;
  state: ToolState;
  station: StationId;
}

/** Classifies a `Tool: detail` line; null when it is not a tool the garage draws. Shared by `applyEvent` and `fromSnapshot`. */
export type ClassifyTool = (line: string, ctx: ToolContext) => ToolClassification | null;
