import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Character, GarageState, SessionInfo } from '../packages/garage/src/model';
import {
  APPROVE_HINT, AUTH_BANNER_TEXT, IDS, bubbleFor, createOverlays, detailView, hudView, truncate,
  type OverlayDocument, type OverlayElement,
} from '../packages/garage/src/overlays';
import { createTheme } from '../packages/garage/src/palette';

class StubEl implements OverlayElement {
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  styles: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  parent: StubEl | null = null;
  textWrites = 0;
  private text: string | null = '';
  constructor(public tag: string) {}
  get textContent() { return this.text; }
  set textContent(v: string | null) { this.textWrites++; this.text = v; this.children = []; }
  // there is deliberately no innerHTML: any assignment would be a type error, and this setter fails the test at runtime.
  set innerHTML(_v: string) { throw new Error('innerHTML assigned'); }
  style = { setProperty: (k: string, v: string) => void (this.styles[k] = v) };
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  append(...n: StubEl[]) { for (const c of n) { c.parent = this; this.children.push(c); } }
  replaceChildren(...n: StubEl[]) { this.children = []; this.text = ''; this.append(...n); }
  addEventListener(t: string, fn: () => void) { this.listeners[t] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  get hidden() { return 'hidden' in this.attrs; }
  all(): StubEl[] { return [this, ...this.children.flatMap(c => c.all())]; }
  texts(): string[] { return this.all().map(e => e.text ?? '').filter(Boolean); }
}

function makeDoc() {
  const byId = new Map<string, StubEl>();
  for (const id of Object.values(IDS)) byId.set(id, new StubEl(id === IDS.toggle ? 'button' : 'div'));
  const rootStyles: Record<string, string> = {};
  const doc: OverlayDocument = {
    createElement: tag => new StubEl(tag),
    getElementById: id => byId.get(id) ?? null,
    documentElement: { style: { setProperty: (k, v) => void (rootStyles[k] = v) } },
  };
  return { doc, byId, rootStyles, el: (id: string) => byId.get(id)! };
}

const char = (over: Partial<Character>): Character => ({
  id: 'backend-dev', kind: 'worker', label: 'Backend Dev', agentId: 'backend-dev', seat: null, persona: 'backend-dev',
  lead: 'lead-1', home: 'bay:b1', station: 'bay:b1', task: 'TASK-1',
  flags: { failed: false, blocked: false, awaitingHuman: false, review: false }, state: 'implementing', ...over,
});
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  characterId: 'backend-dev', agentId: 'backend-dev', task: 'TASK-1', contract: 'implement', live: true,
  lastTool: 'Edit: src/a.ts', lastToolAt: 1, lastToolSeq: 5, lastOutputKind: 'tool', lastOutputAt: 1, lastOutputSeq: 5,
  lastNarration: 'Fixing the parser', ...over,
});
const baseState = (over: Partial<GarageState> = {}): GarageState => ({
  run: { runId: 'r1', lastSeq: 9, phase: 'implementation', status: 'running' },
  characters: {
    'sup-1': char({ id: 'sup-1', kind: 'council', label: 'Sup 1', state: 'idle', task: null, seat: 'sup-1', agentId: 'sup-1' }),
    'lead-1': char({ id: 'lead-1', kind: 'lead', label: 'Lead 1', state: 'idle', task: null, seat: 'lead-1', agentId: 'lead-1' }),
    'backend-dev': char({}),
  },
  sessions: { s1: session() },
  taskIndex: { keyOfId: { t1: 'TASK-1' }, idOfKey: { 'TASK-1': 't1' }, tasks: { 'TASK-1': {
    id: 't1', key: 'TASK-1', title: 'Parser fix', status: 'running', persona: 'backend-dev', lead: 'lead-1', testCommand: null,
    repo: 'app', worktree: '/w/t1', branch: 'agent/t1' } } },
  bayOf: {}, crateOf: {}, stations: {} as GarageState["stations"],
  board: [{ key: 'TASK-1', title: 'Parser fix', persona: 'backend-dev', column: 'active' }],
  outbox: [], approval: null,
  log: [{ seq: 1, at: 1000, type: 'task.created', text: 'TASK-1 created' }, { seq: 2, at: 2000, type: 'agent.started', text: 'backend-dev started TASK-1' }],
  spend: { total: { calls: 3, inputTokens: 1500, outputTokens: 500, costUsd: 0.5 }, byAgent: { 'backend-dev': { calls: 3, inputTokens: 1500, outputTokens: 500, costUsd: 0.5 } } },
  limits: { claude: { windows: [{ name: '5h', usedPercent: 42.4, resetsAt: null }], at: 'x' } },
  ...over,
});

const anchor = () => ({ x: 100, y: 50 });

describe('bubbles', () => {
  it('shows one for a working character with title, narration and tool', () => {
    const b = bubbleFor(baseState().characters['backend-dev'], baseState())!;
    expect(b.title).toBe('Backend Dev · implement · TASK-1');
    expect(b.narration).toBe('Fixing the parser');
    expect(b.tool).toBe('Edit: src/a.ts');
  });

  it('never shows one for idle (or waiting) characters, even with a live session', () => {
    const s = baseState();
    for (const st of ['idle', 'waiting'] as const) {
      expect(bubbleFor(char({ state: st }), s)).toBeNull();
    }
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    o.render({ state: baseState({ characters: { 'backend-dev': char({ state: 'idle' }) } }), anchor });
    expect(h.el(IDS.bubbles).children).toHaveLength(0);
  });

  it('a live-only state without a live session shows nothing', () => {
    const s = baseState({ sessions: { s1: session({ live: false }) } });
    expect(bubbleFor(char({ state: 'implementing' }), s)).toBeNull();
    expect(bubbleFor(char({ state: 'failed' }), s)).not.toBeNull();
  });

  it('truncates long text and removes the bubble when the character goes idle', () => {
    expect(truncate('x'.repeat(200), 10)).toHaveLength(10);
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    o.render({ state: baseState({ sessions: { s1: session({ lastNarration: 'n'.repeat(500) }) } }), anchor });
    const bubble = h.el(IDS.bubbles).children[0];
    expect(bubble.texts().every(t => t.length <= 110)).toBe(true);
    expect(bubble.styles.left).toBe('100px');
    const s2 = baseState(); s2.characters['backend-dev'] = char({ state: 'idle' });
    o.render({ state: s2, anchor });
    expect(h.el(IDS.bubbles).children).toHaveLength(0);
  });
});

describe('DOM discipline', () => {
  it('writes data only via textContent: no innerHTML, and markup stays text', () => {
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    const evil = '<img src=x onerror=alert(1)>';
    const s = baseState({ sessions: { s1: session({ lastNarration: evil }) } });
    s.log.push({ seq: 3, at: 3000, type: 'x', text: evil });
    s.approval = { id: 'p', kind: 'plan', summary: evil, text: null };
    o.render({ state: s, anchor });
    for (const root of Object.values(IDS)) expect(h.el(root).all().every(e => e.tag !== 'img')).toBe(true);
    expect(h.el(IDS.bubbles).texts()).toContain(evil);
    const src = readFileSync('packages/garage/src/overlays.ts', 'utf8');
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('does not touch the DOM when nothing changed', () => {
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    const s = baseState();
    o.render({ state: s, anchor });
    const snapshot = () => Object.values(IDS).flatMap(id => h.el(id).all()).map(e => e.textWrites + JSON.stringify(e.attrs) + JSON.stringify(e.styles));
    const kids = h.el(IDS.hud).children.map(c => c.children.slice());
    const before = snapshot();
    o.render({ state: structuredClone(s), anchor });
    expect(snapshot()).toEqual(before);
    expect(h.el(IDS.hud).children.map(c => c.children)).toEqual(kids);
    h.el(IDS.hud).children.forEach((c, i) => c.children.forEach((k, j) => expect(k).toBe(kids[i][j])));
  });
});

describe('approval card', () => {
  it('is hidden without an approval and shows the exact read-only hint with no acting controls', () => {
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    o.render({ state: baseState(), anchor });
    expect(h.el(IDS.approval).hidden).toBe(true);
    o.render({ state: baseState({ approval: { id: 'p1', kind: 'plan', summary: 'Approve the plan?', text: null } }), anchor });
    const card = h.el(IDS.approval);
    expect(card.hidden).toBe(false);
    expect(card.texts()).toContain('approve in the cockpit (a) or /cockpit approve');
    expect(APPROVE_HINT).toBe('approve in the cockpit (a) or /cockpit approve');
    expect(card.texts().join(' ')).toContain('Approve the plan?');
    for (const e of card.all()) {
      expect(['button', 'a', 'input', 'form', 'select']).not.toContain(e.tag);
      expect(Object.keys(e.listeners)).toHaveLength(0);
    }
    o.render({ state: baseState(), anchor });
    expect(card.hidden).toBe(true);
  });
});

describe('HUD', () => {
  it('lists the queue, the log newest first, status, spend and limits', () => {
    const v = hudView(baseState());
    expect(v.queue[0]).toBe('TASK-1 · Parser fix · backend-dev · active');
    expect(v.log[0]).toContain('agent.started');
    expect(v.log[1]).toContain('task.created');
    expect(v.status).toBe('running · council 1 · leads 1 · plan implementation');
    expect(v.spend[0]).toBe('total 3 calls · 2.0k tok · $0.50');
    expect(v.spend[1]).toContain('backend-dev');
    expect(v.limits).toEqual(['claude 5h 42%']);
  });
});

describe('detail panel', () => {
  it('opens on select with seat, model, status, task, branch, files and recent activity', () => {
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    const input = { state: baseState(), anchor, agentInfo: () => ({ model: 'opus', effort: 'high', filesChanged: 4 }) };
    o.render(input);
    expect(h.el(IDS.detail).hidden).toBe(true);
    o.select('backend-dev');
    const t = h.el(IDS.detail).texts().join('\n');
    for (const want of ['persona: backend-dev', 'model: opus', 'effort: high', 'status: implementing', 'task: TASK-1', 'branch: agent/t1', 'worktree: /w/t1', 'files changed: 4', 'recent: tool: Edit: src/a.ts'])
      expect(t).toContain(want);
    o.select(null);
    expect(h.el(IDS.detail).hidden).toBe(true);
    expect(detailView(baseState(), 'nobody')).toBeNull();
  });
});

describe('banner and theme', () => {
  it('shows the auth text and hides it again', () => {
    const h = makeDoc();
    const o = createOverlays({ doc: h.doc, theme: createTheme() });
    expect(h.el(IDS.banner).hidden).toBe(true);
    o.authExpired();
    expect(h.el(IDS.banner).textContent).toBe(AUTH_BANNER_TEXT);
    expect(AUTH_BANNER_TEXT).toBe('Session expired or token missing — reopen with `cockpit garage` or `/cockpit garage`');
    expect(h.el(IDS.banner).hidden).toBe(false);
    o.banner(null);
    expect(h.el(IDS.banner).hidden).toBe(true);
  });

  it('toggles phosphor/neon and rewrites the custom properties', () => {
    const h = makeDoc();
    const theme = createTheme('phosphor');
    createOverlays({ doc: h.doc, theme });
    expect(h.el(IDS.toggle).textContent).toBe('theme: phosphor');
    const green = h.rootStyles['--g-accent'];
    h.el(IDS.toggle).listeners.click();
    expect(theme.name()).toBe('neon');
    expect(h.el(IDS.toggle).textContent).toBe('theme: neon');
    expect(h.rootStyles['--g-accent']).not.toBe(green);
  });
});

describe('index.html', () => {
  const html = readFileSync('packages/garage/src/index.html', 'utf8');
  it('has no colour literals', () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(html).not.toMatch(/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix)\(/i);
    expect(html).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|magenta|transparent)\b/i);
  });
  it('has the module script, no inline script, no inline handlers, and a strict CSP', () => {
    expect(html).toContain('<script type="module" src="/garage/main.js"></script>');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1].trim()).toBe('');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).toContain("script-src 'self'");
  });
  it('has a canvas and every overlay container', () => {
    expect(html).toContain('<canvas id="g-canvas"');
    for (const id of Object.values(IDS)) expect(html).toContain(`id="${id}"`);
  });
});
