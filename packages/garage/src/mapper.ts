// The Pixel Garage state mapper: pure and deterministic. No DOM, no node, no clock, no randomness: `now` is a parameter.
//
// Two ways in, one state out:
//   fromSnapshot(snap, runId, now)  a whole GarageState from the structured snapshot fields only
//   applyEvent(state, ev, now)      one more event folded in; returns the next state and the scene intents it caused
//
// Everything a character is doing is DERIVED from a few stored facts by one function (`settle`): task statuses, live sessions
// with their latest tool/output records, the pending approval and proposals. Because both entry points end in `settle`, a
// state rebuilt from a snapshot and a state folded from events agree whenever those facts agree. Intents are the diff of the
// settled state before and after the event (spawn, move, animate, station), plus the one-off things only an event can say
// (stamps, bubbles, celebrations, errands).
//
// Truthfulness: states come only from structured events and fields. Model prose reaches `log`, bubbles and `lastNarration`
// (display), never a state. A character with no live session never resolves to testing, implementing, researching or thinking.
//
// Event -> scene (the MVP table). "diff" = the move/animate/station intents that the changed state implies.
//   run.started             log
//   run.status_changed      run status and phase; bench station (busy while integrating or merging, ok after)         diff
//   run.roles_changed       council and lead characters (agent)                                                        spawn
//   council.reviewed        log                                                   bubble, stamp approved|changes at the seat's loft
//   team.proposed|changed   worker persona characters (agent)                                                          spawn
//   run.efforts_changed     log
//   run.completed           status approved -> completed, rejected, failed       celebrate(run) | stamp rejected|failed at the entrance
//   architecture.defined    log                                                   bubble from the chair
//   proposal.created        outbox gains the proposal; outbox station busy        errand: proposer -> outbox (a worker stops at its lead's desk)
//   proposal.accepted|rejected|escalated   outbox item removed or escalated      stamp approved|changes|rejected at the outbox
//   plan.created            log
//   task.created            task index, bay, crate, board card (a provisional task has no repo, persona or lead until a snapshot)
//   task.assigned           log
//   task.started            branch, worktree
//   task.status_changed     status -> flags, board, bay station: blocked/review/failed states; a worker needing input or review goes to its lead's desk   diff
//   task.blocked            log                                                   bubble from the worker
//   task.completed          log                                                   celebrate(task)
//   task.failed             status failed                                         stamp failed at the bay
//   agent.started           session live, mapped to a character                   diff (spawn when new)
//   agent.waiting           log                                                   bubble from the worker
//   agent.output            session tool/output record (only when seq is newer)   bubble; diff (tool -> researching/implementing/testing and its station)
//   agent.completed         session closed by sessionId                           diff
//   agent.failed            sessions with that (agent, task) closed               animate failed, stamp failed
//   question.asked          log                                                   bubble from the worker
//   question.answered       log                                                   bubble from the answerer
//   file.lease.acquired|released   log
//   file.lease.conflict     log                                                   bubble from the worker
//   file.lease.resolved     log                                                   bubble from the lead
//   review.started          log (the lead is in `review` from the in_review status)
//   review.issue_found      log                                                   stamp changes at the lead's desk, bubble
//   review.passed           log                                                   stamp approved at the lead's desk
//   test.started            lab station busy                                      diff
//   test.passed|failed      lab station ok|failed                                 stamp passed|failed at the lab
//   escalation.requested    log                                                   bubble from the asker
//   escalation.resolved     log
//   approval.requested      approval card                                         diff (the owner is awaitingHuman)
//   approval.accepted|rejected|changes_requested   approval cleared               stamp approved|rejected|changes at the owner
//   integration.started     log
//   integration.conflict    log                                                   bubble from the task's lead
//   integration.completed   log                                                   stamp passed|failed at the bench
//   validation.completed    log                                                   stamp passed|failed at the chair's loft
//   merge.completed         log                                                   stamp merged at the bench
//   usage.limits            limits
//   usage.recorded          spend (provisional: every snapshot replaces it)
//
// Spatial hierarchy (`canVisit`): a worker visits only its bay(s), its repo crate(s), the lab, the terminal, the entrance and its
// own lead's desk; only leads and the council enter the loft. Escalation is worker -> own lead's desk (the task needs input),
// then that lead -> the loft (the task is escalated, or a council session is working on it).
import type { CockpitEvent } from '@cockpit/core';
import type { Snapshot } from '@cockpit/orchestrator';
import type {
  BoardCard,
  BoardColumn,
  Character,
  CharacterFlags,
  CharacterId,
  CharacterKind,
  CharacterStateName,
  GarageState,
  LogEntry,
  MapResult,
  SceneIntent,
  SessionInfo,
  SpendEntry,
  StampKind,
  StationId,
  StationState,
  StationStateName,
  TaskInfo,
  TaskKey,
  ToolContext,
} from './model.js';
import { classifyTool } from './tools.js';

type RunView = Snapshot['runs'][number];
type Rec = Record<string, any>;

/** A session that said nothing for this long is no longer "thinking". */
export const THINKING_WINDOW_MS = 20_000;
/** The head Lead: owner of every task whose plan named no Lead. */
export const HEAD_LEAD = 'lead-1';

const LOG_CAP = 200;
const CLOSED_SESSION_CAP = 200;
const BUBBLE_CHARS = 120;
const TOOL_CHARS = 200;

/** First listed wins. */
export const STATE_PRIORITY: readonly CharacterStateName[] = [
  'failed', 'blocked', 'awaitingHuman', 'review', 'testing', 'implementing', 'researching', 'thinking', 'waiting', 'idle',
];
const rank = (n: CharacterStateName): number => STATE_PRIORITY.indexOf(n);

/** Task statuses in which a worker is on the task even though no session is live. */
const IN_FLIGHT = new Set(['running', 'needs_input', 'validating', 'in_review', 'changes_requested', 'lease_conflict', 'escalated']);
const BLOCKED = new Set(['needs_input', 'lease_conflict', 'escalated']);
const PENDING_PROPOSAL = new Set(['open', 'needs_analysis', 'escalated']);

// ---------- small helpers ----------

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const zeroSpend = (): SpendEntry => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

function phaseOf(status: string): string {
  switch (status) {
    case 'architecting': case 'proposing': case 'deciding': return 'architecture';
    case 'planning': case 'awaiting_human_decision': return 'planning';
    case 'executing': return 'execution';
    case 'integrating': case 'validating': return 'integration';
    case 'awaiting_approval': case 'merging': return 'approval';
    case 'completed': case 'rejected': case 'failed': return 'done';
    default: return 'setup';
  }
}

function emptyState(runId: string, lastSeq: number, limits: GarageState['limits']): GarageState {
  return {
    run: { runId, lastSeq, phase: 'setup', status: 'created' },
    characters: {},
    sessions: {},
    taskIndex: { keyOfId: {}, idOfKey: {}, tasks: {} },
    bayOf: {},
    crateOf: {},
    stations: {} as GarageState['stations'],
    board: [],
    outbox: [],
    approval: null,
    log: [],
    spend: { total: zeroSpend(), byAgent: {} },
    limits: structuredClone(limits ?? {}),
  };
}

const taskRef = (s: GarageState, id: string | null | undefined): TaskKey | null => (id ? s.taskIndex.keyOfId[id] ?? id : null);
const taskOf = (s: GarageState, key: TaskKey | null): TaskInfo | undefined => (key ? s.taskIndex.tasks[key] : undefined);
const councilIds = (s: GarageState): CharacterId[] => Object.values(s.characters).filter((c) => c.kind === 'council').map((c) => c.id);
const chairOf = (s: GarageState): CharacterId => councilIds(s)[0] ?? 'sup-1';
const headLeadOf = (s: GarageState): CharacterId | null =>
  s.characters[HEAD_LEAD] ? HEAD_LEAD : Object.values(s.characters).find((c) => c.kind === 'lead')?.id ?? null;
const liveSessionsOf = (s: GarageState, id: CharacterId): SessionInfo[] => Object.values(s.sessions).filter((x) => x.live && x.characterId === id);

function addTask(s: GarageState, t: TaskInfo): void {
  s.taskIndex.tasks[t.key] = t;
  s.taskIndex.keyOfId[t.id] = t.key;
  s.taskIndex.idOfKey[t.key] = t.id;
  if (!(t.key in s.bayOf)) s.bayOf[t.key] = String(Object.keys(s.bayOf).length + 1);
  if (t.repo) s.crateOf[t.key] = t.repo;
}

// ---------- characters ----------

const kindOfRole = (role: string | undefined): CharacterKind => (role === 'supervisor' ? 'council' : role === 'lead' ? 'lead' : 'worker');

/** Creates the character if it is new; an existing one only learns its agent and label. Placement is `settle`'s job. */
function ensureChar(s: GarageState, id: CharacterId, kind: CharacterKind, init: { agentId?: string | null; label?: string | null; seated?: boolean } = {}): Character {
  const seated = init.seated ?? !id.startsWith('session:');
  let c = s.characters[id];
  if (!c) {
    c = {
      id, kind, label: init.label ?? id, agentId: init.agentId ?? null, seat: seated ? id : null, persona: seated && kind === 'worker' ? id : null,
      lead: seated && kind === 'lead' ? id : null, home: 'entrance', station: 'entrance', task: null,
      flags: { failed: false, blocked: false, awaitingHuman: false, review: false }, state: 'idle',
    };
    s.characters[id] = c;
  } else {
    if (init.agentId) c.agentId = init.agentId;
    if (init.label) c.label = init.label;
  }
  return c;
}

interface Started { sessionId: string; agentId: string; role: string; seat: string | null; task: TaskKey | null }

/** The character a session belongs to: its seat, else the task's persona, else `session:<id>`. */
function characterOfSession(s: GarageState, d: Started): CharacterId {
  if (d.seat) {
    ensureChar(s, d.seat, s.characters[d.seat]?.kind ?? kindOfRole(d.role), { agentId: d.agentId });
    return d.seat;
  }
  const persona = d.role === 'worker' ? taskOf(s, d.task)?.persona ?? null : null;
  if (persona) {
    ensureChar(s, persona, 'worker', { agentId: d.agentId });
    return persona;
  }
  const id = `session:${d.sessionId}`;
  ensureChar(s, id, kindOfRole(d.role), { agentId: d.agentId });
  return id;
}

/** Sessions that map to no seat are one-offs: a retry is the same slot if it is another one-off of the same agent and task. */
const sameSlot = (a: CharacterId, b: CharacterId): boolean => a === b || (a.startsWith('session:') && b.startsWith('session:'));

// ---------- resolving a character ----------

const ctxOfTask = (s: GarageState, key: TaskKey | null): ToolContext => ({
  bay: key ? s.bayOf[key] ?? null : null,
  repo: key ? s.crateOf[key] || null : null,
  testCommand: taskOf(s, key)?.testCommand ?? null,
});

interface Fine {
  name: 'testing' | 'implementing' | 'researching' | 'thinking' | 'waiting';
  station: StationId | null;
}

/**
 * What one live session is doing. A thinking record is the whole story while it is fresh (and "waiting" once stale);
 * otherwise the session's latest tool says, and a session with no usable tool is thinking while it is recently active.
 */
function fineOfSession(s: GarageState, x: SessionInfo, now: number): Fine {
  const activeAt = x.lastOutputAt === null && x.lastToolAt === null ? null : Math.max(x.lastOutputAt ?? -Infinity, x.lastToolAt ?? -Infinity);
  const fresh = activeAt === null || now - activeAt <= THINKING_WINDOW_MS;
  if (x.lastOutputKind === 'thinking') return { name: fresh ? 'thinking' : 'waiting', station: null };
  const tool = x.lastTool === null ? null : classifyTool(x.lastTool, ctxOfTask(s, x.task));
  if (tool) return { name: tool.state, station: tool.station };
  return { name: fresh ? 'thinking' : 'waiting', station: null };
}

/** The best of a character's live sessions (ties go to the later session), or null when it has none. */
function fineOf(s: GarageState, c: Character, now: number): Fine | null {
  let best: Fine | null = null;
  for (const x of liveSessionsOf(s, c.id)) {
    const f = fineOfSession(s, x, now);
    if (!best || rank(f.name) <= rank(best.name)) best = f;
  }
  return best;
}

/** The priority order, the 20 s thinking rule, and the hard rule: no live session, no working state. */
export function resolveState(char: Character, state: GarageState, now: number): CharacterStateName {
  const candidates: CharacterStateName[] = [];
  if (char.flags.failed) candidates.push('failed');
  if (char.flags.blocked) candidates.push('blocked');
  if (char.flags.awaitingHuman) candidates.push('awaitingHuman');
  if (char.flags.review) candidates.push('review');
  const fine = fineOf(state, char, now);
  if (fine) candidates.push(fine.name);
  candidates.push(char.task !== null ? 'waiting' : 'idle');
  return candidates.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

// ---------- ownership and the spatial hierarchy ----------

/** The tasks a character may stand at the bay or crate of: its current one, its live sessions' ones, its persona's. */
function ownTasks(s: GarageState, c: Character): Set<TaskKey> {
  const keys = new Set<TaskKey>();
  if (c.task) keys.add(c.task);
  for (const x of liveSessionsOf(s, c.id)) if (x.task) keys.add(x.task);
  if (c.persona) for (const t of Object.values(s.taskIndex.tasks)) if (t.persona === c.persona) keys.add(t.key);
  return keys;
}

/** A worker's own Lead: its task's Lead, else the head Lead. A Lead is its own. */
function ownLeadOf(s: GarageState, c: Character): string | null {
  if (c.kind === 'lead') return c.lead ?? c.id;
  if (c.kind === 'council') return null;
  return taskOf(s, c.task)?.lead ?? HEAD_LEAD;
}

const split = (st: StationId): [string, string] => {
  const i = st.indexOf(':');
  return i < 0 ? [st, ''] : [st.slice(0, i), st.slice(i + 1)];
};

/**
 * The only authority on who may stand where. The council may go anywhere; a Lead anywhere except another Lead's desk;
 * a worker only to its own bay or crate, the lab, the terminal, the entrance and its own Lead's desk. Only Leads and the
 * council enter the loft.
 */
export function canVisit(char: Character, target: StationId, state: GarageState): boolean {
  if (char.kind === 'council') return true;
  const [kind, rest] = split(target);
  if (char.kind === 'lead') return kind === 'desk' ? rest === (char.lead ?? char.id) : true;
  switch (kind) {
    case 'entrance': case 'lab': case 'terminal': return true;
    case 'desk': return rest === ownLeadOf(state, char);
    case 'bay': return [...ownTasks(state, char)].some((k) => state.bayOf[k] === rest);
    case 'crate': return [...ownTasks(state, char)].some((k) => state.crateOf[k] === rest);
    default: return false;
  }
}

/** The stations a character climbs through when it cannot go where it wanted: worker -> own Lead's desk, Lead -> its desk, then the chair's loft. */
function escalationPath(s: GarageState, c: Character): StationId[] {
  const chair = `loft:${chairOf(s)}` as StationId;
  if (c.kind === 'council') return [`loft:${c.id}`];
  const lead = ownLeadOf(s, c);
  return [`desk:${lead}` as StationId, chair];
}

/** `wanted` if the character may go there, else the nearest allowed station on its escalation path (never the loft for a worker). */
export function resolveTarget(char: Character, wanted: StationId, state: GarageState): StationId {
  if (canVisit(char, wanted, state)) return wanted;
  for (const st of escalationPath(state, char)) if (canVisit(char, st, state)) return st;
  return canVisit(char, char.home, state) ? char.home : 'entrance';
}

// ---------- settle: everything derived ----------

const approvalOwnerOf = (s: GarageState): CharacterId | null => (s.approval ? (s.approval.kind === 'team' ? headLeadOf(s) : chairOf(s)) : null);

/** The task a character is on: its newest live session's task; for a worker, else its persona's first task in flight (a failed one last). */
function currentTask(s: GarageState, c: Character): TaskKey | null {
  const live = liveSessionsOf(s, c.id).filter((x) => x.task !== null);
  if (live.length) return live[live.length - 1]!.task;
  if (c.kind !== 'worker' || !c.persona) return null;
  const mine = Object.values(s.taskIndex.tasks).filter((t) => t.persona === c.persona);
  return (mine.find((t) => IN_FLIGHT.has(t.status)) ?? mine.find((t) => t.status === 'failed'))?.key ?? null;
}

function flagsOf(s: GarageState, c: Character): CharacterFlags {
  const flags: CharacterFlags = { failed: false, blocked: false, awaitingHuman: false, review: false };
  const t = taskOf(s, c.task);
  if (c.kind === 'worker' && t) {
    flags.failed = t.status === 'failed';
    flags.blocked = BLOCKED.has(t.status);
    flags.review = t.status === 'in_review';
  }
  if (c.kind === 'lead') {
    const mine = Object.values(s.taskIndex.tasks).filter((x) => (x.lead ?? HEAD_LEAD) === c.id);
    flags.review = mine.some((x) => x.status === 'in_review');
    flags.awaitingHuman = mine.some((x) => x.status === 'escalated');
  }
  if (approvalOwnerOf(s) === c.id) flags.awaitingHuman = true;
  return flags;
}

function homeOf(s: GarageState, c: Character): StationId {
  if (c.seat === null) return 'entrance';
  if (c.kind === 'council') return `loft:${c.id}`;
  if (c.kind === 'lead') return `desk:${c.id}`;
  const bay = c.task ? s.bayOf[c.task] : undefined;
  return bay ? `bay:${bay}` : 'entrance';
}

/** Where a character wants to be before `canVisit` has its say. */
function desiredStation(s: GarageState, c: Character, now: number): StationId {
  const working = c.state === 'testing' || c.state === 'implementing' || c.state === 'researching';
  const at = working ? fineOf(s, c, now)?.station ?? null : null;
  if (c.kind === 'worker') {
    const t = taskOf(s, c.task);
    if (c.state === 'review' || (c.state === 'blocked' && t && (t.status === 'needs_input' || t.status === 'escalated'))) return `desk:${ownLeadOf(s, c)}`;
    return at ?? c.home;
  }
  if (c.kind === 'lead') {
    const mine = Object.values(s.taskIndex.tasks).filter((x) => (x.lead ?? HEAD_LEAD) === c.id);
    if (mine.some((x) => x.status === 'escalated')) return `loft:${chairOf(s)}`;
    for (const x of mine.filter((y) => y.status === 'needs_input')) {
      const council = Object.values(s.sessions).find((y) => y.live && y.task === x.key && s.characters[y.characterId]?.kind === 'council');
      if (council) return `loft:${council.characterId}`;
    }
    return c.state === 'review' ? c.home : at ?? c.home;
  }
  return at ?? c.home;
}

const bayState = (status: string): StationStateName => {
  switch (status) {
    case 'running': case 'changes_requested': case 'validating': case 'in_review': return 'busy';
    case 'needs_input': case 'lease_conflict': case 'escalated': return 'alert';
    case 'approved': case 'integrated': return 'ok';
    case 'failed': case 'cancelled': return 'failed';
    default: return 'idle';
  }
};
const columnOf = (status: string): BoardColumn => {
  switch (status) {
    case 'running': case 'changes_requested': return 'active';
    case 'in_review': return 'review';
    case 'validating': return 'testing';
    case 'needs_input': case 'lease_conflict': case 'escalated': return 'blocked';
    case 'approved': case 'integrated': return 'done';
    case 'failed': case 'cancelled': return 'failed';
    default: return 'backlog';
  }
};
const benchState = (status: string): StationStateName => {
  if (status === 'integrating' || status === 'merging') return 'busy';
  return status === 'validating' || status === 'awaiting_approval' || status === 'completed' ? 'ok' : 'idle';
};

function settleStations(s: GarageState): void {
  const next = {} as GarageState['stations'];
  const put = (id: StationId, kind: StationState['kind'], state: StationStateName) => {
    next[id] = { id, kind, state };
  };
  for (const t of Object.values(s.taskIndex.tasks)) put(`bay:${s.bayOf[t.key]}`, 'bay', bayState(t.status));
  put('lab', 'lab', s.stations['lab']?.state ?? 'idle');
  put('bench', 'bench', benchState(s.run.status));
  put('outbox', 'outbox', s.outbox.some((o) => o.status === 'escalated') ? 'alert' : s.outbox.length ? 'busy' : 'idle');
  s.stations = next;
}

/** Recomputes everything derived from the stored facts. The only place a character's task, flags, state and station are written. */
function settle(s: GarageState, now: number): void {
  const closed = Object.keys(s.sessions).filter((id) => !s.sessions[id]!.live);
  for (const id of closed.slice(0, Math.max(0, closed.length - CLOSED_SESSION_CAP))) delete s.sessions[id];
  for (const c of Object.values(s.characters)) {
    c.task = currentTask(s, c);
    c.lead = c.kind === 'worker' ? ownLeadOf(s, c) : c.lead;
    c.flags = flagsOf(s, c);
    c.home = homeOf(s, c);
    c.state = resolveState(c, s, now);
    c.station = resolveTarget(c, desiredStation(s, c, now), s);
  }
  settleStations(s);
  s.board = Object.values(s.taskIndex.tasks).map((t): BoardCard => ({ key: t.key, title: t.title, persona: t.persona, column: columnOf(t.status) }));
}

// ---------- from a snapshot ----------

/** A whole state from the structured snapshot fields. `recentEvents` and `minds` feed only `log` and `lastNarration`. */
export function fromSnapshot(snap: Snapshot, runId: string, now: number): GarageState {
  const s = emptyState(runId, snap.lastSeq, snap.limits);
  const run: RunView | undefined = snap.runs.find((r) => r.id === runId);
  if (!run) return s;
  s.run.status = run.status;
  s.run.phase = phaseOf(run.status);

  for (const seat of run.council) ensureChar(s, seat.id, 'council', { agentId: seat.agent });
  for (const seat of run.leads) ensureChar(s, seat.id, 'lead', { agentId: seat.agent });
  for (const p of run.team) ensureChar(s, p.id, 'worker', { agentId: p.agent, label: p.title });

  for (const t of run.tasks) {
    addTask(s, {
      id: t.id, key: t.key, title: t.title, status: t.status, persona: t.persona, lead: t.lead, testCommand: t.detail.testCommand,
      repo: t.repo, worktree: t.worktree, branch: t.branch,
    });
  }

  const narration = new Map<string, string>();
  for (const m of run.minds) {
    const prose = m.activity.filter((a) => a.kind !== 'tool').at(-1);
    if (prose) narration.set(m.sessionId, clip(prose.text, TOOL_CHARS));
  }
  for (const a of run.activeSessions) {
    const characterId = characterOfSession(s, { sessionId: a.sessionId, agentId: a.agentId, role: a.role, seat: a.seat, task: a.task });
    s.sessions[a.sessionId] = {
      characterId, agentId: a.agentId, task: a.task, contract: a.contract, live: true,
      lastTool: a.lastTool ? a.lastTool.text.slice(0, TOOL_CHARS) : null, lastToolAt: ms(a.lastTool?.at), lastToolSeq: a.lastTool?.seq ?? 0,
      lastOutputKind: a.lastOutput?.kind ?? null, lastOutputAt: ms(a.lastOutput?.at), lastOutputSeq: a.lastOutput?.seq ?? 0,
      lastNarration: narration.get(a.sessionId) ?? null,
    };
  }

  s.outbox = run.proposals
    .filter((p) => PENDING_PROPOSAL.has(p.status))
    .map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, task: p.task }));
  const pending = snap.pendingApprovals.filter((a) => a.runId === runId);
  const latest = pending.reduce<(typeof pending)[number] | null>((best, a) => (best === null || a.createdAt >= best.createdAt ? a : best), null);
  s.approval = latest ? { id: latest.id, kind: latest.kind, summary: latest.summary, text: latest.text } : null;

  const lastTest = run.tests.at(-1);
  if (lastTest) s.stations['lab'] = { id: 'lab', kind: 'lab', state: lastTest.status === 'started' ? 'busy' : lastTest.status === 'passed' ? 'ok' : 'failed' };

  s.log = run.recentEvents.map((e): LogEntry => ({ seq: null, at: ms(e.ts) ?? now, type: e.type, text: e.text }));
  s.spend = {
    total: { calls: run.telemetry.calls, inputTokens: run.telemetry.inputTokens, outputTokens: run.telemetry.outputTokens, costUsd: run.telemetry.costUsd },
    byAgent: Object.fromEntries(run.telemetry.byAgent.map((a) => [a.agentId, { calls: a.calls, inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd }])),
  };
  settle(s, now);
  return s;
}

// ---------- applying an event ----------

interface Ctx {
  s: GarageState;
  ev: CockpitEvent;
  d: Rec;
  /** The event's own time (epoch ms). */
  at: number;
  /** One-off intents only an event can say, appended after the diff. */
  out: SceneIntent[];
  /** A visit that ends where it began: go to `to` (as far as `canVisit` allows), then come back. */
  errands: { character: CharacterId; to: StationId }[];
}

const bubble = (c: Ctx, character: CharacterId | null, text: string, tone: 'say' | 'think' | 'tool' = 'say') => {
  if (character && c.s.characters[character] && text.trim()) c.out.push({ type: 'bubble', character, text: clip(text, BUBBLE_CHARS), tone });
};
const stamp = (c: Ctx, kind: StampKind, at: StationId, task: TaskKey | null = null) => c.out.push({ type: 'stamp', kind, at, task });
const bayStation = (s: GarageState, key: TaskKey | null): StationId => (key && s.bayOf[key] ? `bay:${s.bayOf[key]}` : 'entrance');

/** The persona (or one-off) character working a task: its live worker session's, else its persona's. */
function workerOf(s: GarageState, key: TaskKey | null): CharacterId | null {
  if (!key) return null;
  const persona = taskOf(s, key)?.persona;
  if (persona && s.characters[persona]) return persona;
  const live = Object.values(s.sessions).find((x) => x.live && x.task === key && s.characters[x.characterId]?.kind === 'worker');
  return live?.characterId ?? null;
}
function leadOfTask(s: GarageState, key: TaskKey | null): CharacterId | null {
  const lead = taskOf(s, key)?.lead ?? HEAD_LEAD;
  return s.characters[lead] ? lead : headLeadOf(s);
}
const homeStation = (s: GarageState, id: CharacterId | null): StationId => (id && s.characters[id] ? s.characters[id]!.home : 'entrance');

function pushLog(c: Ctx, text: string): void {
  if (c.s.log.slice(-5).some((e) => e.seq === c.ev.seq)) return;
  c.s.log.push({ seq: c.ev.seq, at: c.at, type: c.ev.type, text });
  if (c.s.log.length > LOG_CAP) c.s.log.splice(0, c.s.log.length - LOG_CAP);
}

/** A short line for the log: the one-liner a person reads, from structured fields only. */
function describeEvent(s: GarageState, ev: CockpitEvent): string {
  const d = ev.data as Rec;
  const key = (id: unknown) => taskRef(s, typeof id === 'string' ? id : null) ?? '';
  const task = d.taskId ? ` ${key(d.taskId)}` : '';
  switch (ev.type) {
    case 'run.status_changed': return `run ${d.from} → ${d.to}`;
    case 'task.status_changed': return `${key(d.taskId)} ${d.from} → ${d.to}`;
    case 'task.created': return `${d.key} created: ${d.title}`;
    case 'agent.started': return `${d.seat ?? d.agentId} started${task}`;
    case 'agent.completed': return `${d.agentId} finished${task}`;
    case 'agent.failed': return `${d.agentId} failed${task}: ${clip(String(d.error ?? ''), 80)}`;
    case 'test.started': case 'test.passed': case 'test.failed': return `${ev.type.slice(5)}${task}: ${d.command}`;
    case 'review.started': case 'review.passed': case 'review.issue_found': return `${ev.type.slice(7)}${task} (round ${d.iteration})`;
    case 'proposal.created': return `proposal: ${d.title}`;
    case 'approval.requested': return `approval requested: ${d.summary}`;
    case 'run.completed': return `run ${d.outcome}`;
    case 'escalation.requested': return `${d.from} → ${d.to}${task}: ${clip(String(d.reason ?? ''), 80)}`;
    default: return `${ev.type}${task}`;
  }
}

function openSession(c: Ctx): void {
  const { s, d } = c;
  const task = taskRef(s, d.taskId);
  const t = taskOf(s, task);
  if (t && d.role === 'worker' && d.seat && t.persona === null) t.persona = d.seat;
  const characterId = characterOfSession(s, { sessionId: d.sessionId, agentId: d.agentId, role: d.role, seat: d.seat ?? null, task });
  // A retry of a failed attempt: any earlier live session of the same agent, task and seat is over.
  for (const [id, x] of Object.entries(s.sessions)) {
    if (id !== d.sessionId && x.live && x.agentId === d.agentId && x.task === task && sameSlot(x.characterId, characterId)) x.live = false;
  }
  const prev: SessionInfo = s.sessions[d.sessionId] ?? {
    characterId, agentId: d.agentId, task, contract: null, live: true, lastTool: null, lastToolAt: null, lastToolSeq: 0,
    lastOutputKind: null, lastOutputAt: null, lastOutputSeq: 0, lastNarration: null,
  };
  s.sessions[d.sessionId] = { ...prev, characterId, agentId: d.agentId, task, contract: d.contract ?? prev.contract, live: true };
}

function recordOutput(c: Ctx): void {
  const { s, d, ev } = c;
  let id: string | undefined = d.sessionId;
  const task = taskRef(s, d.taskId);
  // Output from before sessions were named on it goes to the live session of that agent and task.
  if (!id) id = Object.entries(s.sessions).find(([, x]) => x.live && x.agentId === d.agentId && x.task === task)?.[0];
  if (!id) return;
  if (!s.sessions[id]) {
    // A session whose start we never saw (the stream joined mid-run): adopt it as live until a snapshot says otherwise.
    const role = String(d.role ?? 'worker');
    const characterId = characterOfSession(s, { sessionId: id, agentId: d.agentId, role, seat: null, task });
    s.sessions[id] = {
      characterId, agentId: d.agentId, task, contract: null, live: true, lastTool: null, lastToolAt: null, lastToolSeq: 0,
      lastOutputKind: null, lastOutputAt: null, lastOutputSeq: 0, lastNarration: null,
    };
  }
  const x = s.sessions[id]!;
  if (ev.seq <= x.lastOutputSeq) return;
  const kind = (d.kind ?? 'text') as NonNullable<SessionInfo['lastOutputKind']>;
  const text = String(d.text ?? '');
  x.lastOutputKind = kind;
  x.lastOutputAt = c.at;
  x.lastOutputSeq = ev.seq;
  if (kind === 'tool') {
    if (ev.seq > x.lastToolSeq) {
      x.lastTool = text.slice(0, TOOL_CHARS);
      x.lastToolAt = c.at;
      x.lastToolSeq = ev.seq;
    }
    bubble(c, x.characterId, text, 'tool');
  } else {
    x.lastNarration = clip(text, TOOL_CHARS);
    bubble(c, x.characterId, text, kind === 'thinking' ? 'think' : 'say');
  }
}

function closeFailed(c: Ctx): void {
  const { s, d } = c;
  const task = taskRef(s, d.taskId);
  const hit = new Set<CharacterId>();
  for (const x of Object.values(s.sessions)) {
    if (!x.live || x.agentId !== d.agentId || x.task !== task) continue;
    x.live = false;
    hit.add(x.characterId);
  }
  for (const id of hit) {
    c.out.push({ type: 'animate', character: id, animation: 'failed' });
    stamp(c, 'failed', c.s.characters[id]?.station ?? bayStation(s, task), task);
  }
}

function setStatus(s: GarageState, status: string): void {
  s.run.status = status;
  s.run.phase = phaseOf(status);
}

function handle(c: Ctx): void {
  const { s, d, ev } = c;
  const key = (id: unknown) => taskRef(s, typeof id === 'string' ? id : null);
  switch (ev.type) {
    case 'run.status_changed':
      setStatus(s, d.to);
      break;
    case 'run.roles_changed':
      for (const m of d.council ?? []) ensureChar(s, m.id, 'council', { agentId: m.agent });
      for (const m of d.leads ?? []) ensureChar(s, m.id, 'lead', { agentId: m.agent });
      break;
    case 'council.reviewed': {
      const verdict = String(d.verdict);
      bubble(c, d.seat, d.summary);
      stamp(c, verdict === 'approve' ? 'approved' : 'changes', `loft:${d.seat}`);
      break;
    }
    case 'team.proposed':
    case 'team.changed':
      for (const p of d.personas ?? []) ensureChar(s, p.id, 'worker', { agentId: p.agent });
      break;
    case 'run.completed':
      if (d.outcome === 'rejected') setStatus(s, 'rejected');
      else if (d.outcome === 'failed') setStatus(s, 'failed');
      else setStatus(s, 'completed');
      if (d.outcome === 'approved') c.out.push({ type: 'celebrate', scope: 'run', task: null });
      else stamp(c, d.outcome === 'failed' ? 'failed' : 'rejected', 'entrance');
      break;
    case 'architecture.defined':
      bubble(c, chairOf(s), d.summary);
      break;
    case 'proposal.created': {
      const task = key(d.taskId);
      if (!s.outbox.some((o) => o.id === d.proposalId)) s.outbox.push({ id: d.proposalId, kind: d.kind, title: d.title, status: 'open', task });
      const proposer = task ? workerOf(s, task) : headLeadOf(s);
      if (proposer) c.errands.push({ character: proposer, to: 'outbox' });
      break;
    }
    case 'proposal.accepted':
    case 'proposal.rejected':
    case 'proposal.escalated': {
      const i = s.outbox.findIndex((o) => o.id === d.proposalId);
      if (ev.type === 'proposal.escalated') {
        if (i >= 0) s.outbox[i]!.status = 'escalated';
        break;
      }
      if (i >= 0) s.outbox.splice(i, 1);
      stamp(c, ev.type === 'proposal.rejected' ? 'rejected' : d.withChanges ? 'changes' : 'approved', 'outbox');
      break;
    }
    case 'task.created': {
      if (s.taskIndex.tasks[d.key]) break;
      addTask(s, { id: d.taskId, key: d.key, title: d.title, status: 'pending', persona: null, lead: null, testCommand: null, repo: '', worktree: null, branch: null });
      break;
    }
    case 'task.started': {
      const t = taskOf(s, key(d.taskId));
      if (t) {
        t.branch = d.branch;
        t.worktree = d.worktreePath;
      }
      break;
    }
    case 'task.status_changed': {
      const t = taskOf(s, key(d.taskId));
      if (t) t.status = d.to;
      break;
    }
    case 'task.blocked':
      bubble(c, workerOf(s, key(d.taskId)), `Blocked: ${d.reason}`);
      break;
    case 'task.completed':
      c.out.push({ type: 'celebrate', scope: 'task', task: key(d.taskId) });
      break;
    case 'task.failed': {
      const t = taskOf(s, key(d.taskId));
      if (t) t.status = 'failed';
      stamp(c, 'failed', bayStation(s, key(d.taskId)), key(d.taskId));
      break;
    }
    case 'agent.started':
      openSession(c);
      break;
    case 'agent.waiting': {
      const task = key(d.taskId);
      const live = Object.values(s.sessions).find((x) => x.live && x.agentId === d.agentId && x.task === task);
      bubble(c, live?.characterId ?? workerOf(s, task), String(d.question ?? ''));
      break;
    }
    case 'agent.output':
      recordOutput(c);
      break;
    case 'agent.completed': {
      const x = s.sessions[d.sessionId];
      if (x) x.live = false;
      break;
    }
    case 'agent.failed':
      closeFailed(c);
      break;
    case 'question.asked':
      bubble(c, workerOf(s, key(d.taskId)), String((d.questions as string[]).at(-1) ?? ''));
      break;
    case 'question.answered': {
      const task = key(d.taskId);
      bubble(c, d.answeredBy === 'supervisor' ? chairOf(s) : leadOfTask(s, task), d.answer);
      break;
    }
    case 'file.lease.conflict':
      bubble(c, workerOf(s, key(d.taskId)), `Lease conflict on ${d.pattern}`);
      break;
    case 'file.lease.resolved':
      bubble(c, leadOfTask(s, key(d.taskId)), `Lease: ${d.action}`);
      break;
    case 'review.issue_found': {
      const task = key(d.taskId);
      const lead = leadOfTask(s, task);
      stamp(c, 'changes', homeStation(s, lead), task);
      bubble(c, lead, d.summary);
      break;
    }
    case 'review.passed': {
      const task = key(d.taskId);
      stamp(c, 'approved', homeStation(s, leadOfTask(s, task)), task);
      break;
    }
    case 'test.started':
      s.stations['lab'] = { id: 'lab', kind: 'lab', state: 'busy' };
      break;
    case 'test.passed':
    case 'test.failed': {
      const passed = ev.type === 'test.passed';
      s.stations['lab'] = { id: 'lab', kind: 'lab', state: passed ? 'ok' : 'failed' };
      stamp(c, passed ? 'passed' : 'failed', 'lab', key(d.taskId));
      break;
    }
    case 'escalation.requested': {
      const task = key(d.taskId);
      const asker = d.from === 'worker' ? workerOf(s, task) : leadOfTask(s, task);
      bubble(c, asker, `Escalating to ${d.to}: ${d.reason}`);
      break;
    }
    case 'approval.requested':
      if (s.approval?.id !== d.approvalId) s.approval = { id: d.approvalId, kind: d.kind, summary: d.summary, text: null };
      break;
    case 'approval.accepted':
    case 'approval.rejected':
    case 'approval.changes_requested':
      if (s.approval?.id === d.approvalId) {
        stamp(c, ev.type === 'approval.accepted' ? 'approved' : ev.type === 'approval.rejected' ? 'rejected' : 'changes', homeStation(s, approvalOwnerOf(s)));
        s.approval = null;
      }
      break;
    case 'integration.conflict':
      bubble(c, leadOfTask(s, key(d.taskId)), `Merge conflict in ${(d.files as string[]).join(', ')}`);
      break;
    case 'integration.completed':
      stamp(c, d.passed ? 'passed' : 'failed', 'bench');
      break;
    case 'validation.completed':
      stamp(c, d.verdict === 'pass' ? 'passed' : 'failed', `loft:${chairOf(s)}`);
      break;
    case 'merge.completed':
      stamp(c, 'merged', 'bench');
      break;
    case 'usage.limits':
      s.limits[d.provider as 'claude' | 'codex'] = { windows: structuredClone(d.windows), at: ev.ts };
      break;
    case 'usage.recorded': {
      const add = (e: SpendEntry) => {
        e.calls += 1;
        e.inputTokens += d.inputTokens;
        e.outputTokens += d.outputTokens;
        e.costUsd += d.costUsd ?? 0;
      };
      add(s.spend.total);
      add((s.spend.byAgent[d.agentId] ??= zeroSpend()));
      break;
    }
    default:
      break;
  }
}

/** Spawn, move, animate and station intents: what the settled state differs by. */
function diffIntents(prev: GarageState, next: GarageState): SceneIntent[] {
  const out: SceneIntent[] = [];
  for (const c of Object.values(next.characters)) {
    const p = prev.characters[c.id];
    if (!p) {
      out.push({ type: 'spawn', character: c.id, kind: c.kind, at: c.station });
      if (c.state !== 'idle') out.push({ type: 'animate', character: c.id, animation: c.state });
      continue;
    }
    if (p.station !== c.station) out.push({ type: 'move', character: c.id, to: c.station });
    if (p.state !== c.state) out.push({ type: 'animate', character: c.id, animation: c.state });
  }
  for (const st of Object.values(next.stations)) {
    if ((prev.stations[st.id]?.state ?? 'idle') !== st.state) out.push({ type: 'station', id: st.id, state: st.state });
  }
  return out;
}

/**
 * Folds one event into the state. Pure and idempotent: values are set, never toggled or advanced (provisional spend aside),
 * an event at or below the state's `lastSeq` changes nothing, and another run's event is ignored.
 */
export function applyEvent(state: GarageState, ev: CockpitEvent, now: number): MapResult {
  if (ev.runId !== null && ev.runId !== state.run.runId) return { state, intents: [] };
  if (ev.seq <= state.run.lastSeq) return { state, intents: [] };
  const s = structuredClone(state);
  const c: Ctx = { s, ev, d: ev.data as Rec, at: ms(ev.ts) ?? now, out: [], errands: [] };
  handle(c);
  if (ev.type !== 'agent.output' && ev.type !== 'usage.recorded' && ev.type !== 'usage.limits') pushLog(c, describeEvent(s, ev));
  s.run.lastSeq = ev.seq;
  settle(s, now);
  const errands = c.errands.flatMap(({ character, to }): SceneIntent[] => {
    const ch = s.characters[character];
    if (!ch) return [];
    const away = resolveTarget(ch, to, s);
    return away === ch.station ? [] : [{ type: 'move', character, to: away }, { type: 'move', character, to: ch.station }];
  });
  return { state: s, intents: [...diffIntents(state, s), ...errands, ...c.out] };
}
