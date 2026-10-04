// HTML overlays: bubbles, HUD, detail panel, read-only approval card, theme toggle, banner.
// Data reaches the DOM only through textContent and attribute setters (no HTML parsing), and an element is touched
// only when what it shows has changed. The document is injected, so tests run against a stub.
import type { Character, CharacterId, GarageState, SessionInfo } from './model.js';
import { applyCssVars, theme as sharedTheme, THEME_NAMES, type Theme } from './palette.js';

export const APPROVE_HINT = 'approve in the cockpit (a) or /cockpit approve';
export const AUTH_BANNER_TEXT = 'Session expired or token missing — reopen with `cockpit garage` or `/cockpit garage`';

// ---------- the slice of the DOM the overlays use ----------

export interface OverlayElement {
  textContent: string | null;
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  append(...nodes: OverlayElement[]): void;
  replaceChildren(...nodes: OverlayElement[]): void;
  addEventListener(type: string, fn: () => void): void;
  remove(): void;
}

export interface OverlayDocument {
  createElement(tag: string): OverlayElement;
  getElementById(id: string): OverlayElement | null;
  documentElement: { style: { setProperty(name: string, value: string): void } };
}

/** Container ids in index.html. */
export const IDS = {
  bubbles: 'g-bubbles',
  hud: 'g-hud',
  detail: 'g-detail',
  approval: 'g-approval',
  banner: 'g-banner',
  toggle: 'g-theme',
} as const;

// ---------- view-model helpers ----------

export const BUBBLE_NARRATION_MAX = 90;
export const BUBBLE_TOOL_MAX = 60;
export const LOG_ROWS = 8;
export const QUEUE_ROWS = 8;
export const DETAIL_ACTIVITY_ROWS = 5;

export function truncate(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

const LIVE_ONLY = new Set(['implementing', 'researching', 'testing', 'thinking']);
const QUIET = new Set(['idle', 'waiting']);

export function liveSession(state: GarageState, id: CharacterId): SessionInfo | null {
  let found: SessionInfo | null = null;
  for (const s of Object.values(state.sessions)) {
    if (s.characterId === id && s.live && (!found || s.lastOutputSeq >= found.lastOutputSeq)) found = s;
  }
  return found;
}

export interface BubbleView { id: CharacterId; title: string; narration: string; tool: string }

/** A bubble for a working character; null for idle (and waiting) ones, and for a live-only state with no live session. */
export function bubbleFor(char: Character, state: GarageState): BubbleView | null {
  if (QUIET.has(char.state)) return null;
  const session = liveSession(state, char.id);
  if (LIVE_ONLY.has(char.state) && !session) return null;
  const detail = [session?.contract ?? null, char.task].filter((x): x is string => !!x).join(' · ');
  return {
    id: char.id,
    title: detail ? `${char.label} · ${detail}` : char.label,
    narration: truncate(session?.lastNarration, BUBBLE_NARRATION_MAX),
    tool: truncate(session?.lastTool, BUBBLE_TOOL_MAX),
  };
}

/** A newest-first copy of the log (state.log is never mutated). */
const newestFirst = (log: GarageState['log']) => [...log].sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0));

const money = (n: number) => `$${n.toFixed(2)}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const spendLine = (e: { calls: number; inputTokens: number; outputTokens: number; costUsd: number }) =>
  `${e.calls} calls · ${tokens(e.inputTokens + e.outputTokens)} tok · ${money(e.costUsd)}`;

export interface AgentInfo { model?: string | null; effort?: string | null; filesChanged?: number | null }

export interface HudView {
  queue: string[];
  log: string[];
  status: string;
  spend: string[];
  limits: string[];
}

export function hudView(state: GarageState): HudView {
  const chars = Object.values(state.characters);
  const council = chars.filter(c => c.kind === 'council').length;
  const leads = chars.filter(c => c.kind === 'lead').length;
  const queue = state.board.slice(0, QUEUE_ROWS).map(c => `${c.key} · ${truncate(c.title, 40)} · ${c.persona ?? '—'} · ${c.column}`);
  const log = newestFirst(state.log).slice(0, LOG_ROWS)
    .map(e => `${new Date(e.at).toISOString().slice(11, 19)} ${e.type} ${truncate(e.text, 80)}`);
  const status = `${state.run.status} · council ${council} · leads ${leads} · plan ${state.run.phase}`;
  const spend = [`total ${spendLine(state.spend.total)}`,
    ...Object.entries(state.spend.byAgent).map(([id, e]) => `${id} ${spendLine(e)}`)];
  const limits: string[] = [];
  for (const [provider, p] of Object.entries(state.limits ?? {})) {
    if (!p) continue;
    limits.push(`${provider} ${p.windows.map(w => `${w.name} ${Math.round(w.usedPercent)}%`).join(' ') || '—'}`);
  }
  return { queue, log, status, spend, limits };
}

export interface DetailView { title: string; rows: string[] }

export function detailView(state: GarageState, id: CharacterId, info?: AgentInfo | null): DetailView | null {
  const c = state.characters[id];
  if (!c) return null;
  const s = liveSession(state, id);
  const task = c.task ? state.taskIndex.tasks[c.task] : undefined;
  const recent: string[] = [];
  if (s?.lastTool) recent.push(`tool: ${truncate(s.lastTool, 80)}`);
  if (s?.lastNarration) recent.push(`said: ${truncate(s.lastNarration, 80)}`);
  for (const e of newestFirst(state.log)) {
    if (recent.length >= DETAIL_ACTIVITY_ROWS) break;
    if ((c.agentId && e.text.includes(c.agentId)) || (c.task && e.text.includes(c.task))) recent.push(`${e.type} ${truncate(e.text, 80)}`);
  }
  const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v));
  return {
    title: c.label,
    rows: [
      `seat: ${dash(c.seat)} · persona: ${dash(c.persona)}`,
      `model: ${dash(info?.model)} · effort: ${dash(info?.effort)}`,
      `status: ${c.state}`,
      `task: ${dash(c.task)}${task ? ` · ${truncate(task.title, 40)}` : ''}`,
      `branch: ${dash(task?.branch)}`,
      `worktree: ${dash(task?.worktree)}`,
      `files changed: ${dash(info?.filesChanged)}`,
      ...(recent.length ? recent.map(r => `recent: ${r}`) : ['recent: —']),
    ],
  };
}

// ---------- the overlays ----------

export interface OverlayOptions {
  doc: OverlayDocument;
  theme?: Theme;
}

export interface RenderInput {
  state: GarageState;
  /** Screen position (CSS px, over the canvas) of a character's head, or null when it is off screen. */
  anchor?: (id: CharacterId) => { x: number; y: number } | null;
  /** Detail the state does not carry (model, effort, files changed). */
  agentInfo?: (agentId: string) => AgentInfo | null;
}

export interface Overlays {
  render(input: RenderInput): void;
  /** Open the detail panel for a character (what a canvas click does); null closes it. */
  select(id: CharacterId | null): void;
  /** The auth/error banner; null hides it. */
  banner(text: string | null): void;
  authExpired(): void;
  dispose(): void;
}

export function createOverlays(opts: OverlayOptions): Overlays {
  const { doc } = opts;
  const theme = opts.theme ?? sharedTheme;
  const must = (id: string): OverlayElement => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`garage overlay container #${id} is missing`);
    return el;
  };
  const roots = {
    bubbles: must(IDS.bubbles), hud: must(IDS.hud), detail: must(IDS.detail), approval: must(IDS.approval),
    banner: must(IDS.banner), toggle: must(IDS.toggle),
  };
  const el = (tag: string, cls: string, text?: string): OverlayElement => {
    const e = doc.createElement(tag);
    e.setAttribute('class', cls);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // A cached text/attribute write: the DOM is touched only when the value differs from the last one written.
  const setText = (e: OverlayElement, text: string) => {
    if (cache.get(e) !== text) { cache.set(e, text); e.textContent = text; }
  };
  const setHidden = (e: OverlayElement, hidden: boolean) => {
    const key = hiddenCache.get(e);
    if (key === hidden) return;
    hiddenCache.set(e, hidden);
    if (hidden) e.setAttribute('hidden', ''); else e.removeAttribute('hidden');
  };
  const cache = new WeakMap<OverlayElement, string>();
  const hiddenCache = new WeakMap<OverlayElement, boolean>();

  // A list region: rebuilt only when its lines change.
  const listSig = new WeakMap<OverlayElement, string>();
  const setLines = (root: OverlayElement, cls: string, lines: string[]) => {
    const sig = JSON.stringify(lines);
    if (listSig.get(root) === sig) return;
    listSig.set(root, sig);
    root.replaceChildren(...lines.map(l => el('div', cls, l)));
  };

  // theme toggle
  const applyTheme = () => {
    applyCssVars(doc.documentElement, theme.palette());
    setText(roots.toggle, `theme: ${theme.name()}`);
  };
  roots.toggle.setAttribute('type', 'button');
  roots.toggle.addEventListener('click', () => {
    const i = THEME_NAMES.indexOf(theme.name());
    theme.set(THEME_NAMES[(i + 1) % THEME_NAMES.length]);
  });
  const unsubTheme = theme.subscribe(applyTheme);
  applyTheme();

  // HUD regions (built once)
  const hudStatus = el('div', 'g-status');
  const hudQueue = el('div', 'g-queue');
  const hudLog = el('div', 'g-log');
  const hudSpend = el('div', 'g-spend');
  const hudLimits = el('div', 'g-limits');
  roots.hud.replaceChildren(hudStatus, hudQueue, hudLog, hudSpend, hudLimits);

  // detail panel (built once)
  const detailTitle = el('div', 'g-detail-title');
  const detailBody = el('div', 'g-detail-body');
  const detailClose = el('button', 'g-detail-close', 'close');
  detailClose.setAttribute('type', 'button');
  roots.detail.replaceChildren(detailTitle, detailBody, detailClose);
  let selected: CharacterId | null = null;
  let last: RenderInput | null = null;
  detailClose.addEventListener('click', () => api.select(null));

  // approval card (read-only: text only, no controls)
  const approvalTitle = el('div', 'g-approval-title');
  const approvalText = el('div', 'g-approval-text');
  const approvalHint = el('div', 'g-approval-hint', APPROVE_HINT);
  roots.approval.replaceChildren(approvalTitle, approvalText, approvalHint);

  // bubbles
  interface Bubble { root: OverlayElement; title: OverlayElement; narration: OverlayElement; tool: OverlayElement; pos: string }
  const bubbles = new Map<CharacterId, Bubble>();

  const renderBubbles = (input: RenderInput) => {
    const wanted = new Map<CharacterId, BubbleView>();
    for (const c of Object.values(input.state.characters)) {
      const v = bubbleFor(c, input.state);
      if (v) wanted.set(c.id, v);
    }
    for (const [id, b] of bubbles) {
      if (!wanted.has(id)) { b.root.remove(); bubbles.delete(id); }
    }
    for (const [id, v] of wanted) {
      let b = bubbles.get(id);
      if (!b) {
        const root = el('div', 'g-bubble');
        const title = el('div', 'g-bubble-title');
        const narration = el('div', 'g-bubble-narration');
        const tool = el('div', 'g-bubble-tool');
        root.append(title, narration, tool);
        roots.bubbles.append(root);
        b = { root, title, narration, tool, pos: '' };
        bubbles.set(id, b);
      }
      setText(b.title, v.title);
      setText(b.narration, v.narration);
      setText(b.tool, v.tool);
      setHidden(b.narration, !v.narration);
      setHidden(b.tool, !v.tool);
      const a = input.anchor?.(id) ?? null;
      const pos = a ? `${Math.round(a.x)},${Math.round(a.y)}` : '';
      if (pos !== b.pos) {
        b.pos = pos;
        if (a) {
          b.root.style.setProperty('left', `${Math.round(a.x)}px`);
          b.root.style.setProperty('top', `${Math.round(a.y)}px`);
        }
      }
      setHidden(b.root, !a);
    }
  };

  const renderDetail = (input: RenderInput) => {
    const c = selected ? input.state.characters[selected] : undefined;
    const view = selected && c ? detailView(input.state, selected, c.agentId ? input.agentInfo?.(c.agentId) : null) : null;
    setHidden(roots.detail, !view);
    if (!view) return;
    setText(detailTitle, view.title);
    setLines(detailBody, 'g-detail-row', view.rows);
  };

  const api: Overlays = {
    render(input) {
      last = input;
      const hud = hudView(input.state);
      setText(hudStatus, hud.status);
      setLines(hudQueue, 'g-queue-row', hud.queue);
      setLines(hudLog, 'g-log-row', hud.log);
      setLines(hudSpend, 'g-spend-row', hud.spend);
      setLines(hudLimits, 'g-limits-row', hud.limits);
      const ap = input.state.approval;
      setHidden(roots.approval, !ap);
      if (ap) {
        setText(approvalTitle, `approval needed · ${ap.kind}`);
        setText(approvalText, truncate(ap.text ?? ap.summary, 400));
      }
      renderBubbles(input);
      renderDetail(input);
    },
    select(id) {
      selected = id;
      if (last) renderDetail(last); else setHidden(roots.detail, true);
    },
    banner(text) {
      setText(roots.banner, text ?? '');
      setHidden(roots.banner, !text);
    },
    authExpired() {
      api.banner(AUTH_BANNER_TEXT);
    },
    dispose() {
      unsubTheme();
      for (const b of bubbles.values()) b.root.remove();
      bubbles.clear();
    },
  };
  setHidden(roots.detail, true);
  setHidden(roots.approval, true);
  setHidden(roots.banner, true);
  return api;
}
