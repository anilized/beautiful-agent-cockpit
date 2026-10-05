// The cockpit as the app draws it: the same missions, agents and decisions as the terminal pane, designed
// for a window instead of a cell grid. Cards, chips and dropdowns in a proportional font; no cell-art, no
// rasters, no pinned heights (the pane scrolls), every action a click. The terminal's drawing is register.tsx's.
import type { ElementTable, RenderChildren, RenderInput } from 'claude-code'

import type { CockpitApproval, CockpitDeskTab, CockpitLimits, CockpitMind, CockpitPersona, CockpitRun, CockpitSeat, CockpitSeatPick, CockpitSnapshot, CockpitTask, CockpitUi, CockpitView } from '../types'

export type Crew = { council: CockpitSeatPick[]; leads: CockpitSeatPick[] }
type Patch = Partial<CockpitUi> | ((u: CockpitUi) => Partial<CockpitUi>)

/** What the pane hands the app's drawing: the state as read, and every action already bound to `$`. */
export type DeskKit = {
  s: CockpitSnapshot | null
  v: CockpitView
  u: CockpitUi
  online: boolean
  /** Whether the orchestrator's dependencies are installed; null until checked. */
  depsReady: boolean | null
  limits: CockpitLimits
  now: number
  /** The text beat: spinners and pulses step on it. */
  n: number
  brand: string
  doing: (m: CockpitMind) => string
  toolDetail: (detail: string) => string
  chunks: (md: string) => string[]
  act: {
    patch: (p: Patch) => void
    /** Replaces the line under the top bar; null clears it. */
    say: (message: string | null) => void
    daemon: (start: boolean) => void
    install: () => void
    checkDeps: () => void
    decide: (d: 'approve' | 'reject' | 'changes', approvalId: string, note: string) => void
    cancel: (runId: string) => void
    retry: (runId: string) => void
    report: (runId: string) => void
    dashboard: (runId: string) => void
    garage: (runId: string) => void
    launch: () => void
    editor: () => void
    loadDraft: () => void
    initCommit: () => void
    /** The next mission's crew. */
    pickCrew: (change: (latest: Crew) => Crew) => void
    /** A live mission's crew, sent to the orchestrator. */
    reseat: (runId: string, seated: Crew, change: (latest: Crew) => Crew) => void
    /** A proposed team, while it waits for approval. */
    editTeam: (runId: string, base: CockpitPersona[], change: (latest: CockpitPersona[]) => CockpitPersona[]) => void
  }
}

// ── palette: neutral glass on the app's dark background, one accent, five tones ──

const P = {
  text: '#ececf1', sub: '#c3c3cc', mute: '#9696a3', faint: '#686874', line: '#34343e', lineSoft: '#2a2a32',
  card: '#1d1d22', raised: '#25252c', select: '#2b2e4a', track: '#2c2c35', ink: '#111114',
}
type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'info' | 'violet' | 'orange' | 'pink' | 'teal' | 'mute'
const TONE: Record<Tone, [string, string]> = {
  accent: ['#8b93ff', '#272a4d'], ok: ['#4ade80', '#15301f'], warn: ['#fbbf24', '#352a0d'], bad: ['#f87171', '#3a1c1c'],
  info: ['#38bdf8', '#0e2c3b'], violet: ['#a78bfa', '#2a2348'], orange: ['#fb923c', '#372313'], pink: ['#f472b6', '#381a2b'],
  teal: ['#2dd4bf', '#0e2f2b'], mute: ['#9696a3', '#26262d'],
}
const fg = (t: Tone) => TONE[t][0]
const bg = (t: Tone) => TONE[t][1]
/** Blend two #rrggbb colours: `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * Math.min(1, Math.max(0, t))).toString(16).padStart(2, '0')).join('')}`
}

const RUN_TONE: Record<string, Tone> = {
  created: 'mute', architecting: 'violet', proposing: 'violet', deciding: 'violet', awaiting_human_decision: 'warn', planning: 'info',
  executing: 'info', integrating: 'info', validating: 'teal', awaiting_approval: 'warn', merging: 'ok', completed: 'ok', rejected: 'bad', failed: 'bad',
}
const RUN_LABEL: Record<string, string> = {
  created: 'Starting', architecting: 'Designing', proposing: 'Debating', deciding: 'Deciding', awaiting_human_decision: 'Needs your decision',
  planning: 'Planning', executing: 'Building', integrating: 'Integrating', validating: 'Validating', awaiting_approval: 'Needs approval',
  merging: 'Merging', completed: 'Completed', rejected: 'Rejected', failed: 'Failed',
}
const TASK_TONE: Record<string, Tone> = {
  pending: 'mute', ready: 'mute', running: 'info', needs_input: 'warn', validating: 'teal', in_review: 'violet', changes_requested: 'warn',
  lease_conflict: 'bad', approved: 'ok', integrated: 'ok', escalated: 'warn', failed: 'bad', cancelled: 'mute',
}
const TASK_LABEL: Record<string, string> = {
  pending: 'Queued', ready: 'Ready', running: 'Building', needs_input: 'Has a question', validating: 'Testing', in_review: 'In review',
  changes_requested: 'Rework', lease_conflict: 'File conflict', approved: 'Approved', integrated: 'Done', escalated: 'Escalated', failed: 'Failed', cancelled: 'Cancelled',
}
const SPEC_TONE: Record<string, Tone> = {
  backend: 'orange', frontend: 'info', test: 'pink', database: 'warn', security: 'bad', performance: 'warn', documentation: 'mute', refactoring: 'violet', research: 'teal', generalist: 'ok',
}
const ROLE_TONE: Record<string, Tone> = { supervisor: 'violet', lead: 'info', worker: 'orange' }
const STEPS: [string, string[]][] = [
  ['Architect', ['created', 'architecting']], ['Debate', ['proposing', 'deciding', 'awaiting_human_decision']], ['Plan', ['planning']], ['Build', ['executing']],
  ['Integrate', ['integrating']], ['Validate', ['validating']], ['Approve', ['awaiting_approval']], ['Merge', ['merging']],
]
const TERMINAL = ['completed', 'rejected', 'failed']
const MOVING = new Set(['running', 'validating', 'architecting', 'proposing', 'deciding', 'planning', 'executing', 'integrating', 'merging'])
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const HOME = '~home'
const AREAS = ['backend', 'frontend', 'tests', 'data', 'infra', 'docs']
const TABS: [CockpitDeskTab, string][] = [['activity', 'Activity'], ['tasks', 'Tasks'], ['changes', 'Changes'], ['events', 'Events'], ['report', 'Report']]
/** Feed items shown before "Show older"; each long text is cut to its budget until opened. */
const FEED_PAGE = 40

// ── text ──

const firstLine = (s: string) => s.split('\n')[0]!.trim()
const title = (r: CockpitRun) => firstLine(r.request).replace(/^#+\s*/, '') || 'Untitled mission'
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s)
const isDone = (t: CockpitTask) => t.status === 'approved' || t.status === 'integrated'
const runLabel = (r: CockpitRun) => (r.status === 'rejected' && /cancel/i.test(r.error ?? '') ? 'Cancelled' : RUN_LABEL[r.status] ?? r.status.replace(/_/g, ' '))
const runTone = (r: CockpitRun): Tone => (r.status === 'rejected' && /cancel/i.test(r.error ?? '') ? 'mute' : RUN_TONE[r.status] ?? 'mute')
function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`
}
const money = (usd: number) => (usd ? `$${usd.toFixed(2)}` : '—')
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const clock = (ts: string) => ts.slice(11, 19)
/** What an orchestrator event means, said plainly: its headline and the rest of its text. */
const EVENT_SAY: [RegExp, string][] = [
  [/^run\.started$/, 'Mission started'], [/^run\.completed$/, 'Mission finished'], [/^merge\.completed$/, 'Merged'], [/^merge\./, 'Merging'],
  [/^approval\.requested$/, 'Waiting for your decision'], [/^approval\.accepted$/, 'You approved'], [/^approval\.rejected$/, 'You rejected'], [/^approval\.changes_requested$/, 'You asked for changes'],
  [/^task\.created$/, 'Task planned'], [/^task\.assigned$/, 'Task assigned'], [/^task\.completed$/, 'Task done'], [/^task\.failed$/, 'Task failed'], [/^task\.blocked$/, 'Task blocked'],
  [/^test\.passed$/, 'Tests passed'], [/^test\.failed$/, 'Tests failed'], [/^review\.passed$/, 'Review passed'], [/^review\.issue_found$/, 'Review found an issue'],
  [/^integration\.started$/, 'Integrating'], [/^integration\.completed$/, 'Integrated'], [/^validation\.completed$/, 'Validated'],
  [/^plan\./, 'Plan'], [/^team\./, 'Team'], [/^council\./, 'Council'], [/^escalation\./, 'Escalated'], [/^proposal\./, 'Proposal'],
]
function plain(ev: { type: string; text: string }): { head: string; rest: string } {
  const head = EVENT_SAY.find(([re]) => re.test(ev.type))?.[1] ?? ev.type.replace(/[._]/g, ' ')
  const rest = ev.text === ev.type ? '' : ev.text.startsWith(`${ev.type} `) ? ev.text.slice(ev.type.length + 1).trim() : ev.text
  return { head, rest }
}

/** A persona's avatar letters: the first and last words' initials (util-dev-strings: US). */
const initials = (id: string) => {
  const w = id.split(/[-_\s]+/).filter(Boolean)
  return (w.length > 1 ? w[0]![0]! + w.at(-1)![0]! : id.slice(0, 2)).toUpperCase()
}

/** "4d", "3h", "23m": one unit, for tight columns. */
function short(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const FONT = 'system-ui,-apple-system,Segoe UI,Inter,sans-serif'

/**
 * A progress ring: an image of fixed size, so the app never has to guess its width. `label` is drawn in the
 * middle (rings of 34 px and up); `spin` adds an arc orbiting the track while the work moves (SMIL, no script).
 */
function ring(frac: number, color: string, size: number, opts: { label?: string; spin?: boolean } = {}): string {
  const c = 94.25 // 2πr, r = 15
  const f = Math.min(1, Math.max(0, frac))
  const arc = f > 0 ? `<circle cx="18" cy="18" r="15" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(2)} ${c}" transform="rotate(-90 18 18)"/>` : ''
  const spin = opts.spin ? `<circle cx="18" cy="18" r="15" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="7 87.25"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1.8s" repeatCount="indefinite"/></circle>` : ''
  const label = opts.label && size >= 34 ? `<text x="18" y="21.4" text-anchor="middle" font-family="${FONT}" font-size="${opts.label.length > 3 ? 8.5 : 10}" font-weight="600" fill="${P.text}">${xml(opts.label)}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="${P.track}" stroke-width="3.5"/>${arc}${spin}${label}</svg>`
}

/** One sine band across `w`, closed to the bottom: `w` is a whole number of wavelengths, so a shift by half of it loops seamlessly. */
function wave(w: number, h: number, base: number, amp: number, len: number, phase: number): string {
  let d = `M0 ${h}`
  for (let x = 0; x <= w; x += 20) d += ` L${x} ${(base + amp * Math.sin((2 * Math.PI * x) / len + phase)).toFixed(1)}`
  return `${d} L${w} ${h} Z`
}

/**
 * The overview's hero: a slow aurora of three bands drifting at their own pace behind the title. Drawn wider
 * than any pane and sliced from the left, so the words stay put whatever width the app gives it.
 */
function hero(title: string, sub: string, live: boolean): string {
  const W = 1600, H = 128
  const band = (color: string, op: number, base: number, amp: number, len: number, phase: number, dur: number) =>
    `<g><path d="${wave(W * 2, H, base, amp, len, phase)}" fill="${color}" fill-opacity="${op}"/><animateTransform attributeName="transform" type="translate" from="0 0" to="-${W} 0" dur="${dur}s" repeatCount="indefinite"/></g>`
  const pulse = live ? `<circle cx="44" cy="40" r="5" fill="${TONE.ok[0]}"><animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite"/></circle><circle cx="44" cy="40" r="5" fill="none" stroke="${TONE.ok[0]}" stroke-width="1.5"><animate attributeName="r" values="5;12" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="1.6s" repeatCount="indefinite"/></circle>` : `<circle cx="44" cy="40" r="5" fill="${P.faint}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid slice">`
    + `<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#15162b"/><stop offset="0.55" stop-color="#1a1430"/><stop offset="1" stop-color="#0c2230"/></linearGradient>`
    + `<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#15162b" stop-opacity="0.92"/><stop offset="0.45" stop-color="#15162b" stop-opacity="0.35"/><stop offset="1" stop-color="#15162b" stop-opacity="0"/></linearGradient></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#sky)"/>`
    + band(TONE.accent[0], 0.16, 70, 16, 400, 0, 26) + band(TONE.violet[0], 0.13, 84, 12, 320, 1.7, 19) + band(TONE.teal[0], 0.1, 98, 9, 533.3, 3.1, 33)
    + `<rect width="${W}" height="${H}" fill="url(#fade)"/>`
    + pulse
    + `<text x="62" y="46" font-family="${FONT}" font-size="15" font-weight="500" fill="${P.mute}" letter-spacing="1.5">${xml(live ? 'LIVE' : 'IDLE')}</text>`
    + `<text x="36" y="84" font-family="${FONT}" font-size="30" font-weight="650" fill="#f3f3f8">${xml(title)}</text>`
    + `<text x="37" y="110" font-family="${FONT}" font-size="15" fill="#a7a7b8">${xml(sub)}</text>`
    + `</svg>`
}

/** Where a run is on the lifecycle; an ended one, the step it stopped on (its last move, from its events). */
function phaseOf(r: CockpitRun): { at: number; stopped: boolean } {
  if (r.status === 'completed') return { at: STEPS.length, stopped: false }
  const now = STEPS.findIndex(([, st]) => st.includes(r.status))
  if (now >= 0) return { at: now, stopped: false }
  for (const ev of [...r.recentEvents].reverse()) {
    const m = /run (\w+) -> (\w+)/.exec(ev.text)
    const at = m && !TERMINAL.includes(m[1]!) ? STEPS.findIndex(([, st]) => st.includes(m[1]!)) : -1
    if (at >= 0) return { at, stopped: true }
  }
  return { at: -1, stopped: true }
}

/** `T` is the surface's element table (`$.ui.resolve(e)`): `$` itself stays in the hooks module. */
export function drawDesk(T: ElementTable, e: RenderInput<'Pane'>, k: DeskKit) {
  const { Box, Text, Button, Markdown, Code } = T
  const Svg = 'Svg' in T ? T.Svg : null
  const Input = 'Input' in T ? T.Input : null
  const Select = 'Select' in T ? T.Select : null
  const { s, u, v, n, now, act, limits } = k
  const cols = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 120)
  const wide = cols >= 160
  const medium = !wide && cols >= 110

  // ── pieces ──

  const Chip = ({ text, tone, solid }: { text: string; tone: Tone; solid?: boolean }) => (
    <Box backgroundColor={solid ? fg(tone) : bg(tone)} paddingX={1} flexShrink={0}>
      <Text color={solid ? P.ink : fg(tone)} bold>{text}</Text>
    </Box>
  )
  const Card = ({ head, right, children, tone, grow, width, id }: { head?: RenderChildren; right?: RenderChildren; children: RenderChildren; tone?: Tone; grow?: boolean; width?: number; id?: string }) => (
    <Box key={id} flexDirection="column" borderStyle="round" borderColor={tone ? fg(tone) : P.line} backgroundColor={tone ? bg(tone) : P.card} paddingX={2} marginBottom={1} flexGrow={grow ? 1 : 0} flexShrink={grow ? 1 : 0} minWidth={grow ? 0 : undefined} width={width}>
      {head !== undefined ? (
        <Box justifyContent="space-between" alignItems="center">
          <Box flexShrink={1}>{typeof head === 'string' ? <Text color={tone ? fg(tone) : P.sub} bold wrap="truncate-end">{head}</Text> : head}</Box>
          {right !== undefined ? <Box flexShrink={0} marginLeft={2} gap={2} alignItems="center">{right}</Box> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  )
  const Label = ({ text, right }: { text: string; right?: RenderChildren }) => (
    <Box justifyContent="space-between" marginTop={1}>
      <Text color={P.faint} bold>{text.toUpperCase()}</Text>
      {right ?? null}
    </Box>
  )
  const Meter = ({ frac, tone, w, grow }: { frac: number; tone: Tone; w?: number; grow?: boolean }) => (
    <Box width={grow ? undefined : w} flexGrow={grow ? 1 : 0} flexShrink={grow ? 1 : 0} minWidth={grow ? 0 : undefined} height={1} backgroundColor={P.track}>
      <Box width={`${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`} height={1} backgroundColor={fg(tone)} />
    </Box>
  )
  const Ring = ({ frac, tone, size, label, spin }: { frac: number; tone: Tone; size: number; label?: string; spin?: boolean }) =>
    Svg ? <Box flexShrink={0}><Svg source={ring(frac, fg(tone), size, { label, spin })} alt={`${Math.round(frac * 100)}% done`} width={size} height={size} /></Box> : <Text color={fg(tone)} bold>{Math.round(frac * 100)}%</Text>
  /** Paragraphs as separate lines, so the app never has to honour a newline inside one span. */
  const Prose = ({ text, color, max, italic, bold }: { text: string; color?: string; max?: number; italic?: boolean; bold?: boolean }) => {
    const lines = text.replace(/\r/g, '').split('\n')
    const shown = max ? lines.slice(0, max) : lines
    return (
      <Box flexDirection="column">
        {shown.map(l => <Text color={color ?? P.sub} italic={italic} bold={bold} wrap="wrap">{l || ' '}</Text>)}
        {max && lines.length > max ? <Text color={P.faint}>… {lines.length - max} more lines</Text> : null}
      </Box>
    )
  }
  const isOpen = (id: string) => u.open.includes(id)
  /** A paragraph cut to `chars` until opened: the inspector stays a glance, the whole text a click away. */
  const Clamp = ({ id, text, chars, color }: { id: string; text: string; chars: number; color?: string }) => {
    const long = text.length > chars
    return (
      <Box flexDirection="column">
        <Prose text={isOpen(id) || !long ? text : cut(text.replace(/\s*\n+\s*/g, ' '), chars)} color={color} />
        <More id={id} more={long} />
      </Box>
    )
  }
  const toggle = (id: string) => act.patch(x => ({ open: x.open.includes(id) ? x.open.filter(o => o !== id) : [...x.open.slice(-40), id] }))
  const More = ({ id, more }: { id: string; more: boolean }) =>
    more || isOpen(id) ? <Button plain dimColor key={`more-${id}`} label={isOpen(id) ? 'Show less' : 'Show more'} onPress={() => toggle(id)} /> : null
  /** A one-of-several picker: the app's dropdown, a button that cycles where a surface has none. */
  const Pick = ({ id, value, options, onPick }: { id: string; value: string; options: { value: string; label: string }[]; onPick: (value: string) => void }) => {
    if (!options.length) return <Text color={P.mute}>{value}</Text>
    if (Select) return <Select key={id} options={options} value={options.some(o => o.value === value) ? value : options[0]!.value} onSelect={onPick} />
    const at = options.findIndex(o => o.value === value)
    const next = options[(at + 1) % options.length]!
    return <Button plain key={id} label={options[Math.max(0, at)]?.label ?? value} onPress={() => onPick(next.value)} />
  }

  // ── agents and the crew ──

  const agents = s?.agents ?? []
  const eligible = (role: string) => agents.filter(a => a.enabled && a.roles.includes(role)).map(a => a.id)
  const levelsOf = (id: string) => agents.find(a => a.id === id)?.efforts ?? []
  const defaultCrew = (): Crew => ({
    council: [{ agent: s?.hierarchy.supervisor ?? 'opus', effort: null, area: null }],
    leads: [{ agent: s?.hierarchy.lead ?? 'codex', effort: null, area: null }],
  })

  const CrewEditor = ({ crew, onChange, states, id }: { crew: Crew; onChange: (change: (latest: Crew) => Crew) => void; states?: Record<string, string>; id: string }) => {
    const group = (kind: 'council' | 'leads') => {
      const role = kind === 'council' ? 'supervisor' : 'lead'
      const tone: Tone = kind === 'council' ? 'violet' : 'info'
      const ids = eligible(role)
      const put = (i: number, change: (x: CockpitSeatPick) => CockpitSeatPick | null) =>
        onChange(c => {
          const list = c[kind].slice()
          if (!list[i]) return c
          const next = change(list[i]!)
          if (next) list[i] = next
          else if (list.length > 1) list.splice(i, 1)
          return { ...c, [kind]: list }
        })
      const add = () => onChange(c => {
        const fresh = ids.find(a => !c[kind].some(x => x.agent === a)) ?? ids[0]
        return fresh ? { ...c, [kind]: [...c[kind], { agent: fresh, effort: null, area: null }] } : c
      })
      return (
        <Box flexDirection="column">
          <Label text={kind === 'council' ? 'Council' : 'Leads'} right={ids.length ? <Button plain dimColor key={`${id}-add-${kind}`} label="+ Add" onPress={add} /> : null} />
          {crew[kind].map((x, i) => {
            const state = states?.[`${kind === 'council' ? 'sup' : 'lead'}-${i + 1}`]
            const working = !!state && state !== 'idle'
            const levels = levelsOf(x.agent)
            return (
              <Box key={`${id}-${kind}-${i}`} alignItems="center" gap={1} flexWrap="wrap">
                <Text color={working ? fg('ok') : i === 0 ? fg(tone) : P.faint}>{working ? SPIN[n % SPIN.length] : i === 0 ? '★' : `${i + 1}`}</Text>
                <Pick id={`${id}-${kind}-agent-${i}`} value={x.agent} options={ids.map(a => ({ value: a, label: a }))} onPick={a => put(i, y => ({ ...y, agent: a, effort: levelsOf(a).includes(y.effort ?? '') ? y.effort : null }))} />
                {levels.length ? <Pick id={`${id}-${kind}-effort-${i}`} value={x.effort ?? 'default'} options={[{ value: 'default', label: 'default effort' }, ...levels.map(l => ({ value: l, label: `${l} effort` }))]} onPick={l => put(i, y => ({ ...y, effort: l === 'default' ? null : l }))} /> : null}
                {kind === 'leads' ? <Pick id={`${id}-area-${i}`} value={x.area ?? 'any'} options={[{ value: 'any', label: 'any area' }, ...AREAS.map(a => ({ value: a, label: a }))]} onPick={a => put(i, y => ({ ...y, area: a === 'any' ? null : a }))} /> : null}
                {crew[kind].length > 1 ? <Button plain dimColor key={`${id}-drop-${kind}-${i}`} label="Remove" onPress={() => put(i, () => null)} /> : null}
              </Box>
            )
          })}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {group('council')}
        {group('leads')}
      </Box>
    )
  }

  // ── chrome: the top bar, messages, the footer ──

  const runs = s?.runs ?? []
  const liveRun = runs.find(r => !TERMINAL.includes(r.status)) ?? null
  const run = !s || !k.online || u.composing?.kind === 'run' ? null : u.selectedRun === HOME ? null : (u.selectedRun && runs.find(r => r.id === u.selectedRun)) || liveRun
  const openRun = (id: string) => act.patch({ selectedRun: id, task: null, mind: null, scroll: {}, report: null, confirmCancel: null })
  const goHome = () => act.patch({ selectedRun: HOME, composing: null, confirmCancel: null })
  const compose = () => act.patch({ composing: { kind: 'run' } })
  const leftOf = (p: 'claude' | 'codex') => {
    const w = limits[p]?.windows ?? []
    return w.length ? Math.round(Math.max(0, 100 - Math.max(...w.map(x => x.usedPercent)))) : null
  }
  const quota = (['claude', 'codex'] as const).map(p => [p, leftOf(p)] as const).filter(([, x]) => x !== null)

  const topBar = (
    <Box justifyContent="space-between" alignItems="center" marginBottom={1} flexWrap="wrap" gap={1}>
      <Box alignItems="center" gap={2} flexShrink={1} flexWrap="wrap">
        <Text color={fg('accent')} bold>◎ {k.brand}</Text>
        {k.online ? (
          <Box gap={1} flexWrap="wrap" alignItems="center">
            <Box backgroundColor={!run && !u.composing ? P.select : undefined} paddingX={1}>
              <Button plain dimColor={!!run || !!u.composing} key="d-home" label="Overview" onPress={goHome} />
            </Box>
            {runs.slice(0, wide ? 5 : 3).map(r => (
              <Box key={`d-tab-${r.id}`} backgroundColor={run?.id === r.id ? P.select : undefined} paddingX={1} alignItems="center">
                <Text color={fg(runTone(r))}>{MOVING.has(r.status) ? SPIN[n % SPIN.length] : '●'} </Text>
                <Button plain dimColor={run?.id !== r.id} key={`d-open-${r.id}`} label={cut(title(r), wide ? 30 : 20)} onPress={() => openRun(r.id)} />
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
      <Box alignItems="center" gap={2} flexShrink={0}>
        {quota.map(([p, left]) => <Text color={left! > 50 ? P.mute : fg(left! > 20 ? 'warn' : 'bad')}>{p === 'claude' ? 'Claude' : 'Codex'} {left}% left</Text>)}
        <Text color={k.online ? fg('ok') : P.faint}>● {k.online ? `Online :${s!.daemon.port}` : 'Offline'}</Text>
        {k.online ? <Button plain dimColor key="d-stop" label="Stop" onPress={() => act.daemon(false)} /> : null}
        {k.online && !u.composing && run ? <Button variant="primary" hotkey="n" key="new" label="New mission" onPress={compose} /> : null}
      </Box>
    </Box>
  )
  const status = u.busy ? (
    <Box marginBottom={1}><Text color={fg('info')}>{SPIN[n % SPIN.length]} {u.busy}</Text></Box>
  ) : v.message ? (
    <Box marginBottom={1} justifyContent="space-between">
      <Text color={P.mute} wrap="truncate-end">{firstLine(v.message)}</Text>
      <Button plain dimColor key="d-dismiss-msg" label="Dismiss" onPress={() => act.say(null)} />
    </Box>
  ) : null

  const failureCard = u.failure ? (
    <Card id="d-failure" tone="bad" head="The mission did not launch" right={<Button plain dimColor key="d-failure-x" label="Dismiss" onPress={() => act.patch({ failure: null })} />}>
      <Prose text={u.failure.text} color={P.text} />
      {u.failure.request ? <Text color={P.mute} wrap="truncate-end">{firstLine(u.failure.request)}</Text> : null}
      <Box gap={1} marginTop={1}>
        {u.failure.uninitializedRepo ? <Button variant="primary" key="init-commit" label="Make an initial commit and retry" onPress={act.initCommit} /> : null}
        <Button key="edit-failed" label="Edit the brief" onPress={() => act.patch({ failure: null, composing: { kind: 'run' } })} />
      </Box>
    </Card>
  ) : null

  const page = (...children: RenderChildren[]) => (
    <Box flexDirection="column" paddingX={1}>
      {topBar}
      {status}
      {children}
    </Box>
  )

  // ── offline ──

  if (!s || !k.online) {
    if (k.depsReady === null) act.checkDeps()
    const fresh = k.depsReady === false
    return page(
      <Box justifyContent="center" marginTop={2}>
        <Card id="d-offline" width={Math.min(70, cols - 4)}>
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Text color={P.text} bold>{fresh ? 'One step before the first mission' : 'The orchestrator is asleep'}</Text>
            <Text color={P.mute} wrap="wrap">{fresh ? "Its dependencies are not installed yet: npm install, once (about a minute)." : 'Start it and the council, the leads and the workers report for duty.'}</Text>
            <Box marginTop={1}>
              {fresh
                ? <Button variant="primary" hotkey="i" key="install-deps" autoFocus label="Install the orchestrator" onPress={act.install} />
                : <Button variant="primary" hotkey="s" key="d-start" autoFocus label="Start the orchestrator" onPress={() => act.daemon(true)} />}
            </Box>
            {s?.runs.length ? <Box marginTop={1}><Text color={P.faint} wrap="wrap">{s.runs.length} mission{s.runs.length > 1 ? 's' : ''} on record</Text></Box> : null}
          </Box>
        </Card>
      </Box>,
    )
  }

  // ── a new mission: the brief, the crew, the options ──

  if (u.composing?.kind === 'run') {
    const brief = u.draft
    const lines = brief ? brief.split('\n').length : 0
    const append = (line: string) => act.patch(x => ({ draft: x.draft ? `${x.draft}\n${line}` : line, nonce: x.nonce + 1 }))
    const undo = () => act.patch(x => ({ draft: x.draft.split('\n').slice(0, -1).join('\n') }))
    const target = s.runs[0]?.repositories[0]?.name
    const editor = (
      <Card id="d-brief" grow head="New mission" right={[
        <Button plain dimColor key="brief-edit" label="Open in editor" onPress={act.editor} />,
        <Button plain dimColor key="brief-load" label="Load saved" onPress={act.loadDraft} />,
        lines ? <Button plain dimColor key="brief-undo" label="Undo line" onPress={undo} /> : null,
        lines ? <Button plain dimColor key="brief-clear" label="Clear" onPress={() => act.patch({ draft: '', draftInEditor: false })} /> : null,
      ]}>
        <Text color={P.mute} wrap="wrap">Describe the mission in Markdown: the goal, the requirements, the constraints and how to tell it is done. Each Enter adds a line; an empty one starts a paragraph.{u.draftInEditor ? ' The brief is open in your editor: save it there, and the saved file is used.' : ''}</Text>
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={P.lineSoft} paddingX={2} minHeight={6}>
          {brief.trim()
            ? k.chunks(brief).map((c, i) => <Markdown key={`brief-md-${i}`} text={c} />)
            : <Box flexDirection="column" paddingY={1}><Text color={P.faint}>Your brief appears here as you write it.</Text><Text color={P.faint}>Start with a title line: # What to build</Text></Box>}
        </Box>
        <Box marginTop={1}>
          {Input
            ? <Input key={`compose-${u.nonce}`} placeholder={lines ? 'Next line…' : '# Mission title'} submitLabel="Add line" autoFocus onSubmit={(t: string) => append(t)} />
            : <Text color={P.mute} wrap="wrap">Write the brief with Open in editor.</Text>}
        </Box>
      </Card>
    )
    const side = (
      <Box flexDirection="column" width={wide || medium ? 52 : undefined} flexShrink={0}>
        <Card id="d-crew-next" head="Crew" right={<Text color={P.faint}>★ chairs / heads</Text>}>
          <CrewEditor id="next" crew={u.crew ?? defaultCrew()} onChange={act.pickCrew} />
          <Box marginTop={1}><Text color={P.mute} wrap="wrap">The head lead names the workers with the plan; you approve the team before any of them starts.</Text></Box>
        </Card>
        <Card id="d-options" head="Options">
          {Input
            ? <Input key={`flags-${u.nonce}`} value={u.draftFlags} placeholder={`--test "npm test"  --repo ../other`} submitLabel="Keep" onInput={(t: string) => act.patch({ draftFlags: t })} onSubmit={(t: string) => act.patch({ draftFlags: t })} />
            : <Text color={P.mute}>{u.draftFlags || 'none'}</Text>}
          <Text color={P.faint} wrap="wrap">Runs in {target ?? 'this folder'} unless --repo says otherwise.</Text>
        </Card>
        <Box gap={1} marginBottom={1}>
          <Button variant="primary" hotkey="s" key="brief-start" label="Start mission" onPress={act.launch} />
          <Button key="cancel-run" label="Back" onPress={() => act.patch({ composing: null })} />
        </Box>
      </Box>
    )
    return page(failureCard, <Box gap={1} flexDirection={wide || medium ? 'row' : 'column'}>{editor}{side}</Box>)
  }

  // ── usage: what is left of each subscription window, and what a mission spent ──

  const windows = (Object.entries(limits) as [string, NonNullable<CockpitLimits['claude']>][]).flatMap(([p, l]) => l.windows.map(w => ({ p, ...w, left: Math.max(0, 100 - w.usedPercent) })))
  const leftTone = (left: number): Tone => (left > 50 ? 'ok' : left > 20 ? 'warn' : 'bad')
  const provider = (p: string) => (p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : p)
  /** Every window as a ring of what is left in it, its name under it and when it refills. */
  const quotaRings = (id: string) => windows.length ? (
    <Box gap={2} flexWrap="wrap" marginTop={1}>
      {windows.map(w => {
        const resets = w.resetsAt ? Date.parse(w.resetsAt) - now : NaN
        return (
          <Box key={`${id}-${w.p}-${w.name}`} flexDirection="column" alignItems="center" minWidth={9}>
            <Ring frac={w.left / 100} tone={leftTone(w.left)} size={44} label={`${Math.round(w.left)}%`} />
            <Text color={P.sub}>{provider(w.p)} {w.name}</Text>
            <Text color={P.faint}>{resets > 0 ? `↻ ${short(resets)}` : ' '}</Text>
          </Box>
        )
      })}
    </Box>
  ) : <Text color={P.faint} wrap="wrap">No reading yet: it comes with the first call.</Text>
  const spendCard = (r: CockpitRun) => {
    const tel = r.telemetry
    const by = tel.byAgent ?? []
    const max = Math.max(0.01, ...by.map(b => b.costUsd || b.calls / 100))
    return (
      <Card id="d-usage" head="Usage" right={<Text color={fg('warn')} bold>{money(tel.costUsd)}</Text>}>
        {quotaRings('d-usage')}
        <Label text="This mission" right={<Text color={P.faint}>{tel.calls} calls</Text>} />
        {by.map((a, i) => (
          <Box key={`d-spend-${a.agentId}`} alignItems="center" gap={1}>
            <Box width={8} flexShrink={0}><Text color={P.sub} wrap="truncate-end">{a.agentId}</Text></Box>
            <Meter frac={(a.costUsd || a.calls / 100) / max} tone={(['accent', 'violet', 'teal', 'orange', 'pink'] as Tone[])[i % 5]!} grow />
            <Box width={7} flexShrink={0} justifyContent="flex-end"><Text color={P.mute}>{a.costUsd ? money(a.costUsd) : `${a.calls}×`}</Text></Box>
          </Box>
        ))}
        <Text color={P.faint}>{compact(tel.inputTokens)} tokens in · {compact(tel.outputTokens)} out</Text>
      </Card>
    )
  }

  // ── overview: a living hero, what is under way, every mission, the plan left ──

  if (!run) {
    const spend = runs.reduce((a, r) => a + (r.telemetry.costUsd || 0), 0)
    const running = runs.filter(r => !TERMINAL.includes(r.status))
    const waiting = s.pendingApprovals
    const heroTitle = waiting.length ? 'A decision is waiting on you' : running.length ? 'Your agents are at work' : runs.length ? 'All quiet. What should we build next?' : 'Welcome aboard. Let’s build something.'
    const sub = [
      `${runs.length} mission${runs.length === 1 ? '' : 's'}`,
      running.length ? `${running.length} running` : 'nothing running',
      waiting.length ? `${waiting.length} waiting on you` : null,
      spend ? `${money(spend)} spent` : null,
    ].filter(Boolean).join('   ·   ')
    const heroBox = Svg ? (
      <Box key="d-hero" borderStyle="round" borderColor={P.line} overflow="hidden" marginBottom={1} minWidth={0}>
        <Svg source={hero(heroTitle, sub, running.length > 0)} alt={`${heroTitle}. ${sub}`} height={112} />
      </Box>
    ) : <Card id="d-hero" head={heroTitle}><Text color={P.mute}>{sub}</Text></Card>

    const crew = u.crew ?? defaultCrew()
    const seatLine = (xs: CockpitSeatPick[]) => xs.map(x => `${x.agent}${x.effort ? ` ${x.effort}` : ''}${x.area ? ` @${x.area}` : ''}`).join(', ')
    const editing = isOpen('crew-edit')
    const firstWaiting = waiting[0] ? runs.find(r => r.id === waiting[0]!.runId) : null
    const cta = (
      <Box gap={2} marginBottom={1} alignItems="center" flexWrap="wrap">
        <Button variant="primary" hotkey="n" key="new" label="Start a new mission" onPress={compose} />
        {firstWaiting ? <Button key="d-review-waiting" label="Review what's waiting" onPress={() => openRun(firstWaiting.id)} /> : null}
        <Box flexShrink={1} minWidth={0}><Text color={P.faint} wrap="truncate-end">Crew  <Text color={P.sub}>{seatLine(crew.council)}</Text> chairs · <Text color={P.sub}>{seatLine(crew.leads)}</Text> leads</Text></Box>
        <Button plain dimColor key="d-crew-toggle" label={editing ? 'Done' : 'Change'} onPress={() => toggle('crew-edit')} />
      </Box>
    )
    const crewCard = editing ? (
      <Card id="d-crew-home" head="Crew for the next mission" right={<Button plain dimColor key="d-crew-done" label="Done" onPress={() => toggle('crew-edit')} />}>
        <CrewEditor id="home" crew={crew} onChange={act.pickCrew} />
      </Card>
    ) : null

    // What is under way, large: its ring turning, the step it is on, who is working now.
    const Spotlight = ({ r }: { r: CockpitRun }) => {
      const dn = r.tasks.filter(isDone).length
      const at = phaseOf(r).at
      const fr = r.tasks.length ? dn / r.tasks.length : Math.max(0, at) / STEPS.length
      const active = (r.minds ?? []).filter(m => m.status === 'active')
      const waits = waiting.filter(a => a.runId === r.id).length
      return (
        <Card id={`d-spot-${r.id}`} tone={waits ? 'warn' : undefined}>
          <Box gap={2} alignItems="center">
            <Ring frac={fr} tone={waits ? 'warn' : runTone(r)} size={56} label={`${Math.round(fr * 100)}%`} spin={MOVING.has(r.status)} />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color={P.text} bold wrap="truncate-end">{title(r)}</Text>
              <Text color={P.mute} wrap="truncate-end">{at >= 0 ? `${STEPS[at]![0]} step` : runLabel(r)} · {r.tasks.length ? `${dn} of ${r.tasks.length} tasks` : 'planning the tasks'} · {active.length || r.workers.length} working{r.createdAt ? ` · ${since(now - Date.parse(r.createdAt))}` : ''}</Text>
              {active.length ? (
                <Box gap={1} flexWrap="wrap">
                  {active.slice(0, 4).map(m => <Chip text={`${SPIN[(n + m.sessionId.length) % SPIN.length]} ${m.seat ?? m.role} · ${k.doing(m)}`} tone={ROLE_TONE[m.role] ?? 'mute'} />)}
                </Box>
              ) : null}
            </Box>
            <Chip text={waits ? 'Needs you' : runLabel(r)} tone={waits ? 'warn' : runTone(r)} solid />
            <Button variant="primary" key={`d-spot-open-${r.id}`} label={waits ? 'Review' : 'Open'} onPress={() => openRun(r.id)} />
          </Box>
        </Card>
      )
    }

    const rowTitle = Math.min(90, Math.max(24, Math.floor((wide || medium ? cols - 60 : cols - 24) * 1.1)))
    const missions = (
      <Card id="d-missions" grow head="Missions" right={<Text color={P.faint}>{runs.length} on record</Text>}>
        {runs.length ? runs.slice(0, 12).map(r => {
          const dn = r.tasks.filter(isDone).length
          const fr = r.status === 'completed' ? 1 : r.tasks.length ? dn / r.tasks.length : 0
          const waits = waiting.some(a => a.runId === r.id)
          const meta = [r.repositories[0]?.name ?? 'workspace', r.tasks.length ? `${dn}/${r.tasks.length} tasks` : 'no tasks yet', r.createdAt ? `${since(now - Date.parse(r.createdAt))} ago` : '', r.telemetry.costUsd ? money(r.telemetry.costUsd) : ''].filter(Boolean).join(' · ')
          return (
            <Box key={`d-home-${r.id}`} alignItems="center" gap={2} marginTop={1} hover={{ backgroundColor: P.raised }}>
              <Ring frac={fr} tone={runTone(r)} size={30} spin={MOVING.has(r.status)} />
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                <Button plain key={`home-open-${r.id}`} label={cut(title(r), rowTitle)} onPress={() => openRun(r.id)} />
                <Text color={P.faint} wrap="truncate-end">{meta}</Text>
              </Box>
              {waits ? <Chip text="Needs you" tone="warn" /> : null}
              <Chip text={runLabel(r)} tone={runTone(r)} />
            </Box>
          )
        }) : <Box marginY={1}><Text color={P.mute} wrap="wrap">No missions yet. Start the first one above: describe what to build and the crew takes it from there.</Text></Box>}
        {runs.length > 12 ? <Box marginTop={1}><Text color={P.faint} wrap="wrap">{runs.length - 12} older missions are in the dashboard.</Text></Box> : null}
      </Card>
    )
    const MILESTONE = /^(task\.(created|completed|failed)|test\.(passed|failed)|review\.|integration\.completed|merge\.|approval\.|validation\.|plan\.|team\.|council\.|run\.(started|completed))/
    const recent = runs.flatMap(r => r.recentEvents.filter(ev => MILESTONE.test(ev.type)).map(ev => ({ ...ev, r }))).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8)
    const recentCard = (
      <Card id="d-recent" head="Recent">
        {recent.length ? recent.map(ev => {
          const fresh = now - Date.parse(ev.ts) < 15_000
          return (
            <Box key={`d-recent-${ev.r.id}-${ev.ts}-${ev.type}`} gap={1} marginTop={1}>
              <Text color={/failed|rejected/.test(ev.type) ? fg('bad') : /passed|completed|accepted|merge\./.test(ev.type) ? fg('ok') : fresh ? fg('accent') : P.faint}>●</Text>
              <Box flexDirection="column" flexShrink={1} minWidth={0}>
                <Text color={fresh ? P.text : P.sub} wrap="truncate-end">{plain(ev).head}<Text color={P.mute}>{plain(ev).rest ? `  ${plain(ev).rest}` : ''}</Text></Text>
                <Text color={P.faint} wrap="truncate-end">{ev.ts.slice(11, 16)} · {title(ev.r)}</Text>
              </Box>
            </Box>
          )
        }) : <Text color={P.faint}>Quiet so far.</Text>}
      </Card>
    )
    const side = (
      <Box flexDirection="column" width={wide ? 50 : 44} flexShrink={0}>
        <Card id="d-plan-left" head="Plan left" right={<Text color={P.faint}>subscription</Text>}>{quotaRings('d-plan-left')}</Card>
        {recentCard}
      </Box>
    )
    return page(
      failureCard,
      heroBox,
      cta,
      crewCard,
      running.slice(0, 2).map(r => <Spotlight r={r} />),
      wide || medium
        ? <Box gap={1} alignItems="flex-start"><Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{missions}</Box>{side}</Box>
        : <Box flexDirection="column">{missions}{side}</Box>,
    )
  }

  // ── a mission ──

  const live = !TERMINAL.includes(run.status)
  const failed = run.status === 'failed'
  const tone = runTone(run)
  const approvals = s.pendingApprovals.filter(a => a.runId === run.id)
  const done = run.tasks.filter(isDone).length
  const { at: phase, stopped } = phaseOf(run)
  const frac = run.status === 'completed' ? 1 : run.tasks.length ? done / run.tasks.length : phase >= 0 ? phase / STEPS.length : 0
  const minds = run.minds ?? []
  const working = minds.filter(m => m.status === 'active').length || run.workers.length
  const team = (u.teamDraft?.runId === run.id ? u.teamDraft.team : run.team) ?? []
  const branch = run.repositories[0]?.integration?.branch.split('/').slice(-1)[0] ?? run.repositories[0]?.baseBranch ?? ''
  const confirming = live && u.confirmCancel === run.id

  const header = (
    <Card id="d-head">
      <Box justifyContent="space-between" alignItems="center" gap={2}>
        <Box alignItems="center" gap={2} flexShrink={1} minWidth={0}>
          <Ring frac={frac} tone={tone} size={46} label={`${Math.round(frac * 100)}%`} spin={MOVING.has(run.status)} />
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Text color={P.text} bold wrap="wrap">{title(run)}</Text>
            <Text color={P.mute} wrap="truncate-end">{run.repositories[0]?.name ?? 'workspace'}{branch ? ` · ⎇ ${branch}` : ''} · #{run.id.slice(-6)}{run.createdAt ? ` · started ${since(now - Date.parse(run.createdAt))} ago` : ''}{run.round ? ` · round ${run.round + 1}` : ''}</Text>
          </Box>
        </Box>
        <Box alignItems="center" gap={1} flexShrink={0}>
          <Chip text={`${MOVING.has(run.status) ? `${SPIN[n % SPIN.length]} ` : ''}${runLabel(run)}`} tone={tone} solid />
        </Box>
      </Box>
      <Box marginTop={1} gap={1}>
        {STEPS.map(([name], i) => {
          // Done, the step under way (it breathes), where an ended mission stopped, or still ahead.
          const state = i < phase ? 'done' : i === phase ? (stopped ? 'stopped' : 'now') : 'todo'
          const color = state === 'done' ? fg('ok') : state === 'now' ? mix(fg(tone), '#ffffff', ((Math.sin(n * 0.35) + 1) / 2) * 0.35) : state === 'stopped' ? fg(failed ? 'bad' : 'mute') : P.track
          return (
            <Box key={`d-step-${i}`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box height={1} backgroundColor={color} />
              <Text color={state === 'todo' ? P.faint : state === 'done' ? P.sub : color} bold={state === 'now' || state === 'stopped'} wrap="truncate-end">{state === 'done' ? '✓ ' : state === 'stopped' ? '✕ ' : ''}{name}</Text>
            </Box>
          )
        })}
      </Box>
      <Box justifyContent="space-between" alignItems="center" marginTop={1} flexWrap="wrap" gap={1}>
        <Text color={P.mute} wrap="wrap">{run.tasks.length ? `${done} of ${run.tasks.length} tasks done` : 'No tasks yet'} · {working} agent{working === 1 ? '' : 's'} working · {money(run.telemetry.costUsd)}</Text>
        <Box gap={1} flexWrap="wrap">
          {failed ? <Button variant="primary" hotkey="t" key="d-retry" label="Retry" onPress={() => act.retry(run.id)} /> : null}
          <Button key="d-report" label="Report" onPress={() => { act.patch({ deskTab: 'report' }); if (u.report?.runId !== run.id) act.report(run.id) }} />
          <Button key="d-dashboard" label="Dashboard" onPress={() => act.dashboard(run.id)} />
          <Button key="d-garage" label="Garage" onPress={() => act.garage(run.id)} />
          {live && !confirming ? <Button key="cancel-mission-head" label="Cancel mission" onPress={() => act.patch({ confirmCancel: run.id })} /> : null}
        </Box>
      </Box>
      {run.error && !/cancel/i.test(run.error) ? <Box marginTop={1}><Text color={fg('bad')} wrap="wrap">{run.error}</Text></Box> : null}
    </Card>
  )

  const cancelCard = confirming ? (
    <Card id="d-cancel" tone="bad" head="Cancel this mission?">
      <Text color={P.text} wrap="wrap">Its agents stop now, its open tasks and approvals close, and it ends as rejected. The orchestrator keeps running and the integration branch is kept.</Text>
      <Box gap={1} marginTop={1}>
        <Button variant="primary" key="cancel-yes" autoFocus label="Yes, cancel it" onPress={() => act.cancel(run.id)} />
        <Button key="cancel-keep" label="Keep it running" onPress={() => act.patch({ confirmCancel: null })} />
      </Box>
    </Card>
  ) : null

  // ── decisions waiting on the person ──

  const ApprovalCard = ({ a }: { a: CockpitApproval }) => {
    const writing = u.composing?.kind === 'changes' && u.composing.approvalId === a.id
    const isTeam = a.kind === 'team' && team.length > 0
    const text = a.text ?? a.summary
    const lines = text.split('\n')
    const id = `apr-${a.id}`
    const workers = eligible('worker')
    const edit = (change: (latest: CockpitPersona[]) => CockpitPersona[]) => act.editTeam(run.id, run.team ?? [], change)
    const put = (i: number, change: (p: CockpitPersona) => CockpitPersona | null) => edit(list => {
      const next = list.slice()
      if (!next[i]) return list
      const p = change(next[i]!)
      if (p) next[i] = p
      else if (next.length > 1) next.splice(i, 1)
      return next
    })
    return (
      <Card id={`d-${id}`} tone="warn" head={isTeam ? `Approve the team · ${team.length} workers` : a.kind === 'final' ? 'Ready to merge: your call' : `Needs your decision · ${a.kind}${a.operation ? ` · ${a.operation.replace(/_/g, ' ')}` : ''}`}>
        {isTeam ? team.map((p, i) => {
          const levels = levelsOf(p.agent)
          return (
            <Box key={`d-persona-${p.id}`} alignItems="center" gap={1} marginTop={1} flexWrap="wrap">
              <Chip text={p.id} tone={SPEC_TONE[p.specialty] ?? 'orange'} />
              <Pick id={`team-agent-${p.id}`} value={p.agent} options={workers.map(w => ({ value: w, label: w }))} onPick={w => put(i, x => ({ ...x, agent: w, effort: levelsOf(w).includes(x.effort ?? '') ? x.effort : null }))} />
              {levels.length ? <Pick id={`team-effort-${p.id}`} value={p.effort ?? 'default'} options={[{ value: 'default', label: 'default effort' }, ...levels.map(l => ({ value: l, label: `${l} effort` }))]} onPick={l => put(i, x => ({ ...x, effort: l === 'default' ? null : l }))} /> : null}
              <Box flexShrink={1} minWidth={0}><Text color={P.mute} wrap="truncate-end">{p.title !== p.id ? `${p.title} · ` : ''}{p.tasks.join(', ') || 'no task yet'}</Text></Box>
              <Button plain dimColor key={`team-clone-${p.id}`} label="Duplicate" onPress={() => edit(list => {
                const at = list.findIndex(x => x.id === p.id)
                if (at < 0) return list
                let c = 2
                while (list.some(x => x.id === `${p.id}-${c}`)) c++
                return [...list.slice(0, at + 1), { ...list[at]!, id: `${p.id}-${c}`, tasks: [] }, ...list.slice(at + 1)]
              })} />
              {team.length > 1 ? <Button plain dimColor key={`team-drop-${p.id}`} label="Remove" onPress={() => put(i, () => null)} /> : null}
            </Box>
          )
        }) : (
          <Box flexDirection="column" marginTop={1}>
            <Prose text={text} color={P.text} max={isOpen(id) ? undefined : 8} />
            <More id={id} more={lines.length > 8} />
          </Box>
        )}
        {writing ? (
          <Box flexDirection="column" marginTop={1}>
            {Input ? <Input key={`changes-${a.id}-${u.nonce}`} placeholder={isTeam ? 'What should the lead change in the team or the plan?' : 'What should the team change?'} submitLabel="Send back" autoFocus onSubmit={(t: string) => {
              if (!t.trim()) return
              act.patch(x => ({ composing: null, nonce: x.nonce + 1 }))
              act.decide('changes', a.id, t)
            }} /> : <Text color={P.mute} wrap="wrap">Type it as /cockpit changes …</Text>}
            <Box marginTop={1}><Button plain dimColor key="cancel-changes" label="Never mind" onPress={() => act.patch({ composing: null })} /></Box>
          </Box>
        ) : (
          <Box gap={1} marginTop={1}>
            <Button variant="primary" hotkey="a" key={`approve-${a.id}`} autoFocus label={isTeam ? 'Approve team' : 'Approve'} onPress={() => act.decide('approve', a.id, '')} />
            {a.kind === 'final' || isTeam ? <Button key={`changes-${a.id}`} label={isTeam ? 'Send back' : 'Request changes'} onPress={() => act.patch({ composing: { kind: 'changes', approvalId: a.id } })} /> : null}
            <Button key={`reject-${a.id}`} label="Reject" onPress={() => act.decide('reject', a.id, '')} />
          </Box>
        )}
      </Card>
    )
  }

  // ── the team: who holds each seat and what they are doing ──

  const council: CockpitSeat[] = run.council?.length ? run.council : [{ id: 'sup-1', agent: (run.roles ?? s.hierarchy).supervisor, effort: null, area: null, state: run.leadership.supervisor }]
  const leads: CockpitSeat[] = run.leads?.length ? run.leads : [{ id: 'lead-1', agent: (run.roles ?? s.hierarchy).lead, effort: null, area: null, state: run.leadership.lead }]
  const mindOf = (seat: string) => minds.find(m => m.seat === seat && m.status === 'active') ?? minds.find(m => m.seat === seat) ?? null
  const followed = u.mind ? minds.find(m => m.sessionId === u.mind) ?? null : null
  const follow = (m: CockpitMind | null) => act.patch({ mind: m && m.sessionId !== u.mind ? m.sessionId : null, deskTab: 'activity' })

  type Seat = { key: string; letter: string; name: string; sub: string; tone: Tone; busy: boolean; mind: CockpitMind | null; what: string }
  const seatRows: [string, Seat[]][] = [
    ['Council', council.map((x, i) => {
      const m = mindOf(x.id)
      return { key: x.id, letter: 'S', name: x.agent, sub: `${i === 0 ? 'chair' : `member ${i + 1}`}${x.effort ? ` · ${x.effort}` : ''}`, tone: 'violet' as Tone, busy: x.state !== 'idle', mind: m, what: x.state !== 'idle' ? (m?.status === 'active' ? k.doing(m) : x.state) : 'idle' }
    })],
    ['Leads', leads.map((x, i) => {
      const m = mindOf(x.id)
      return { key: x.id, letter: 'L', name: x.agent, sub: `${x.area ? `${x.area} lead` : i === 0 ? 'head lead' : `lead ${i + 1}`}${x.effort ? ` · ${x.effort}` : ''}`, tone: 'info' as Tone, busy: x.state !== 'idle', mind: m, what: x.state !== 'idle' ? (m?.status === 'active' ? k.doing(m) : x.state) : 'idle' }
    })],
    ['Workers', team.length ? team.map(p => {
      const m = mindOf(p.id)
      return { key: p.id, letter: initials(p.id), name: p.id, sub: `${p.agent}${p.effort ? ` · ${p.effort}` : ''}`, tone: SPEC_TONE[p.specialty] ?? 'orange', busy: p.state !== 'idle', mind: m, what: p.state !== 'idle' ? p.state : p.tasks.length ? `idle · ${p.tasks.join(', ')}` : 'idle' }
    }) : run.workers.map((w, i) => ({ key: `w${i}`, letter: 'W', name: w.agentId, sub: 'worker', tone: 'orange' as Tone, busy: true, mind: minds.find(m => m.role === 'worker' && m.status === 'active' && m.task === w.task) ?? null, what: `working${w.task ? ` on ${w.task}` : ''}` }))],
  ]
  const seated: Crew = { council: council.map(x => ({ agent: x.agent, effort: x.effort, area: null })), leads: leads.map(x => ({ agent: x.agent, effort: x.effort, area: x.area })) }
  const teamCard = (
    <Card id="d-team" head="Team" right={<Text color={P.faint}>{working} working</Text>}>
      {seatRows.map(([group, list]) => (
        <Box key={`d-group-${group}`} flexDirection="column">
          <Label text={group} />
          {list.length ? list.map(x => {
            const picked = !!x.mind && x.mind.sessionId === u.mind
            return (
              <Box key={`d-seat-${x.key}`} alignItems="center" gap={1} backgroundColor={picked ? P.select : undefined} hover={{ backgroundColor: P.raised }}>
                <Box backgroundColor={x.busy ? fg(x.tone) : bg(x.tone)} paddingX={1} flexShrink={0}><Text color={x.busy ? P.ink : fg(x.tone)} bold>{x.letter}</Text></Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Box justifyContent="space-between">
                    {x.mind ? <Button plain key={`agent-pick-${x.key}`} label={x.name} onPress={() => follow(x.mind)} /> : <Text color={P.text} bold>{x.name}</Text>}
                    <Text color={x.busy ? fg('ok') : P.faint}>{x.busy ? `${SPIN[(n + x.key.length) % SPIN.length]} working` : 'idle'}</Text>
                  </Box>
                  <Text color={P.mute} wrap="truncate-end">{x.sub}{x.busy && x.what !== 'idle' ? ` · ${x.what}` : ''}</Text>
                </Box>
              </Box>
            )
          }) : <Text color={P.faint} wrap="wrap">{group === 'Workers' ? 'Named by the head lead with the plan.' : 'None.'}</Text>}
        </Box>
      ))}
      {live && !isOpen('reseat') ? <Box marginTop={1}><Button plain dimColor key="d-reseat-open" label="Change crew" onPress={() => toggle('reseat')} /></Box> : null}
      {live && isOpen('reseat') ? (
        <Box flexDirection="column">
          <Label text="Change crew" right={<Button plain dimColor key="d-reseat-done" label="Done" onPress={() => toggle('reseat')} />} />
          <Text color={P.faint} wrap="wrap">Calls already running finish where they are; the next ones use this.</Text>
          <CrewEditor id="live" crew={u.seatDraft?.runId === run.id ? u.seatDraft.crew : seated} states={Object.fromEntries([...council, ...leads].map(x => [x.id, x.state]))} onChange={change => act.reseat(run.id, seated, change)} />
        </Box>
      ) : null}
    </Card>
  )

  // ── activity: every model's words, thoughts, tools and outcomes, with the orchestrator's milestones ──

  type Item = { id: string; ts: string; kind: 'text' | 'thinking' | 'tool' | 'result' | 'ok' | 'bad' | 'sys'; text: string }
  type Group = { sid: string; head: { tag: string; tone: Tone; who: string; what: string; active: boolean }; items: Item[] }
  const MILESTONES = /^(task\.(created|assigned|blocked|completed|failed)|test\.(passed|failed)|review\.(passed|issue_found)|integration\.|merge\.|approval\.|escalation\.|proposal\.|validation\.|plan\.|run\.(started|completed))/
  const tagOf = (m: CockpitMind) => (m.role === 'supervisor' ? 'Council' : m.role === 'lead' ? 'Lead' : m.seat ?? 'Worker')
  const flat: (Item & { sid: string })[] = []
  for (const m of minds) {
    if (followed && m.sessionId !== followed.sessionId) continue
    m.activity.forEach((a, i) => flat.push({ sid: m.sessionId, id: `${m.sessionId}-${i}`, ts: a.ts, kind: a.kind, text: a.text.trim() }))
  }
  if (!followed) for (const ev of run.recentEvents) {
    if (!MILESTONES.test(ev.type)) continue
    const kind = /passed|completed|accepted|merge\./.test(ev.type) ? 'ok' : /failed|issue_found|blocked|rejected/.test(ev.type) ? 'bad' : 'sys'
    const said = plain(ev)
    flat.push({ sid: '~orch', id: `ev-${ev.ts}-${ev.type}`, ts: ev.ts, kind, text: said.rest ? `${said.head} · ${said.rest}` : said.head })
  }
  flat.sort((a, b) => b.ts.localeCompare(a.ts))
  const limit = FEED_PAGE + (u.scroll.feed ?? 0)
  const groups: Group[] = []
  for (const it of flat.slice(0, limit)) {
    const last = groups.at(-1)
    if (last && last.sid === it.sid) { last.items.push(it); continue }
    const m = minds.find(x => x.sessionId === it.sid)
    groups.push({
      sid: it.sid,
      head: m
        ? { tag: tagOf(m), tone: m.role === 'worker' ? SPEC_TONE[run.tasks.find(t => t.key === m.task)?.specialty ?? ''] ?? 'orange' : ROLE_TONE[m.role] ?? 'mute', who: `${m.agentId}${m.effort ? ` · ${m.effort}` : ''}`, what: `${k.doing(m)}${m.task ? ` ${m.task}` : ''}`, active: m.status === 'active' }
        : { tag: 'Orchestrator', tone: 'accent', who: '', what: '', active: false },
      items: [it],
    })
  }
  // One line each until opened: the glyph says what it is (a thought, words, a result), the line what it says.
  const centreCols = wide ? cols - 38 - 46 - 8 : medium ? cols - 38 - 6 : cols - 6
  const lineChars = Math.max(30, Math.floor((centreCols - 10) * 1.3))
  const GROUP_SHOWN = 4
  // Groups newest first; inside one, oldest first, so an agent's turn reads as it happened.
  for (const g of groups) g.items.reverse()
  const FeedItem = ({ it }: { it: Item }) => {
    const opened = isOpen(it.id)
    const fresh = now - Date.parse(it.ts) < 10_000
    if (it.kind === 'tool') {
      const at = it.text.indexOf(': ')
      const name = at > 0 ? it.text.slice(0, at) : it.text
      const arg = at > 0 ? k.toolDetail(it.text.slice(at + 2)) : ''
      return (
        <Box key={`d-it-${it.id}`} gap={1}>
          <Text color={fresh ? fg('accent') : P.faint}>⚙</Text>
          <Box flexShrink={1} minWidth={0}><Text color={P.mute} wrap="truncate-end">{name}  <Text color={P.faint}>{arg}</Text></Text></Box>
        </Box>
      )
    }
    if (it.kind === 'ok' || it.kind === 'bad' || it.kind === 'sys') return (
      <Box key={`d-it-${it.id}`} gap={1}>
        <Text color={it.kind === 'ok' ? fg('ok') : it.kind === 'bad' ? fg('bad') : fresh ? fg('accent') : P.faint}>{it.kind === 'ok' ? '✓' : it.kind === 'bad' ? '✕' : '•'}</Text>
        <Box flexShrink={1} minWidth={0}><Text color={fresh ? P.text : it.kind === 'sys' ? P.mute : P.sub} wrap="truncate-end">{firstLine(it.text)}</Text></Box>
      </Box>
    )
    const glyph = it.kind === 'result' ? <Text color={fg('ok')}>✓</Text> : it.kind === 'thinking' ? <Text color={fresh ? fg('violet') : '#7f78a8'}>∴</Text> : <Text color={fresh ? fg('accent') : P.faint}>›</Text>
    const flat1 = it.text.replace(/\s*\n+\s*/g, ' ').replace(/[`*_#]+/g, '').trim()
    const long = flat1.length > lineChars || it.text.includes('\n')
    return (
      <Box key={`d-it-${it.id}`} flexDirection="column">
        <Box gap={1}>
          {glyph}
          <Box flexShrink={1} minWidth={0}>
            {opened
              ? <Prose text={it.text} color={it.kind === 'thinking' ? '#a59fc9' : P.sub} italic={it.kind === 'thinking'} />
              : long
                ? <Button plain dimColor={it.kind === 'thinking'} key={`more-${it.id}`} label={cut(flat1, lineChars)} onPress={() => toggle(it.id)} />
                : <Text color={it.kind === 'thinking' ? '#a59fc9' : fresh ? P.text : P.sub} italic={it.kind === 'thinking'} wrap="truncate-end">{flat1}</Text>}
          </Box>
        </Box>
        {opened ? <Box paddingLeft={2}><Button plain dimColor key={`less-${it.id}`} label="Show less" onPress={() => toggle(it.id)} /></Box> : null}
      </Box>
    )
  }
  const activity = (
    <Box flexDirection="column">
      {followed ? (
        <Box justifyContent="space-between" marginBottom={1} backgroundColor={P.raised} paddingX={1}>
          <Text color={P.mute} wrap="truncate-end">Only <Text color={P.text}>{followed.seat ?? followed.role} · {followed.agentId}</Text></Text>
          <Button plain key="d-follow-all" label="Show everyone" onPress={() => follow(null)} />
        </Box>
      ) : null}
      {groups.length ? groups.map((g, gi) => {
        const gid = `grp-${g.sid}-${g.items.at(-1)!.id}`
        const all = isOpen(gid)
        const shown = all ? g.items : g.items.slice(-GROUP_SHOWN)
        return (
          <Box key={`d-group-${g.sid}-${gi}`} flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between" alignItems="center">
              <Box gap={1} alignItems="center" flexShrink={1} minWidth={0}>
                <Chip text={g.head.tag} tone={g.head.tone} solid={g.head.active && n % 8 < 6} />
                {g.head.who ? <Text color={P.text}>{g.head.who}</Text> : null}
                {g.head.what ? <Box flexShrink={1} minWidth={0}><Text color={P.faint} wrap="truncate-end">{g.head.what}</Text></Box> : null}
              </Box>
              <Text color={P.faint}>{g.head.active && gi === 0 ? `${SPIN[n % SPIN.length]} ` : ''}{clock(g.items.at(-1)!.ts).slice(0, 5)}</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {g.items.length > GROUP_SHOWN ? <Button plain dimColor key={`more-${gid}`} label={all ? 'Fewer' : `+ ${g.items.length - GROUP_SHOWN} earlier`} onPress={() => toggle(gid)} /> : null}
              {shown.map(it => <FeedItem it={it} />)}
            </Box>
          </Box>
        )
      }) : <Text color={P.faint} wrap="wrap">{live ? `${SPIN[n % SPIN.length]} Waiting for the first move…` : 'Nothing was logged for this mission.'}</Text>}
      {flat.length > limit ? <Button key="d-older" label={`Show older (${flat.length - limit} more)`} onPress={() => act.patch(x => ({ scroll: { ...x.scroll, feed: (x.scroll.feed ?? 0) + FEED_PAGE } }))} /> : null}
    </Box>
  )

  // ── tasks, and the one selected ──

  const ORDER = ['failed', 'lease_conflict', 'needs_input', 'escalated', 'changes_requested', 'running', 'validating', 'in_review', 'ready', 'pending', 'approved', 'integrated', 'cancelled']
  const tasks = run.tasks.slice().sort((a, b) => (ORDER.indexOf(a.status) - ORDER.indexOf(b.status)) || a.key.localeCompare(b.key))
  const selTask = run.tasks.find(t => t.key === u.task) ?? tasks[0] ?? null
  const pickTask = (t: CockpitTask) => act.patch({ task: t.key })
  const taskList = (
    <Box flexDirection="column">
      {tasks.length ? tasks.map(t => {
        const picked = t.key === selTask?.key
        const tt = TASK_TONE[t.status] ?? 'mute'
        const spec = t.persona ?? t.specialty ?? null
        return (
          <Box key={`d-task-${t.key}`} alignItems="center" gap={1} backgroundColor={picked ? P.select : undefined} hover={{ backgroundColor: P.raised }} paddingX={1}>
            <Text color={fg(tt)}>{MOVING.has(t.status) ? SPIN[n % SPIN.length] : isDone(t) ? '✓' : t.status === 'failed' ? '✗' : '○'}</Text>
            <Box width={9} flexShrink={0}><Text color={P.faint}>{t.key}</Text></Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}><Button plain dimColor={!picked && (isDone(t) || t.status === 'cancelled')} key={`task-pick-${t.key}`} label={cut(t.title, 70)} onPress={() => pickTask(t)} /></Box>
            {spec ? <Chip text={spec} tone={SPEC_TONE[t.specialty ?? ''] ?? 'mute'} /> : null}
            <Chip text={TASK_LABEL[t.status] ?? t.status} tone={tt} />
          </Box>
        )
      }) : <Text color={P.faint} wrap="wrap">{live ? 'The lead is drafting the task graph…' : 'No tasks.'}</Text>}
    </Box>
  )
  const FILE_TONE: Record<string, Tone> = { M: 'warn', A: 'ok', D: 'bad', R: 'info' }
  const inspector = (t: CockpitTask | null) => {
    if (!t) return <Text color={P.faint} wrap="wrap">Select a task to see it here.</Text>
    const d = t.detail
    const tt = TASK_TONE[t.status] ?? 'mute'
    const files = t.live?.files ?? []
    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center" flexWrap="wrap"><Chip text={TASK_LABEL[t.status] ?? t.status} tone={tt} /><Text color={P.faint}>{t.key}</Text>{t.iteration > 1 ? <Text color={P.faint}>· try {t.iteration}</Text> : null}</Box>
        <Box marginTop={1}><Text color={P.text} bold wrap="wrap">{t.title}</Text></Box>
        <Text color={P.mute} wrap="wrap">{[t.persona ?? t.agentId, t.lead, t.repo, t.dependsOn.length ? `after ${t.dependsOn.join(', ')}` : ''].filter(Boolean).join(' · ')}</Text>
        {t.blockedReason ? <Box marginTop={1}><Text color={fg('warn')} wrap="wrap">{t.blockedReason}</Text></Box> : null}
        {d ? (
          <Box flexDirection="column">
            <Box marginTop={1}><Clamp id={`desc-${t.key}`} text={d.description} chars={240} /></Box>
            <Text color={P.faint} wrap="wrap">{d.kind} · {d.risk} risk · {d.complexity} complexity · tests {d.testsRequired ? d.testCommand ?? 'repo default' : 'not required'}</Text>
            {d.acceptanceCriteria.length ? <Label text="Acceptance" /> : null}
            {d.acceptanceCriteria.map(c => <Box gap={1}><Text color={isDone(t) ? fg('ok') : P.faint}>{isDone(t) ? '✓' : '○'}</Text><Box flexShrink={1} minWidth={0}><Text color={P.sub} wrap="wrap">{c}</Text></Box></Box>)}
            {files.length || d.scope.files.length ? <Label text={files.length ? 'Changed files' : 'Planned files'} /> : null}
            {files.length
              ? files.slice(0, 12).map(f => <Box gap={1}><Chip text={f.status} tone={FILE_TONE[f.status] ?? 'mute'} /><Box flexShrink={1} minWidth={0}><Text color={P.sub} wrap="truncate-start">{f.path}</Text></Box></Box>)
              : d.scope.files.slice(0, 12).map(f => <Text color={P.mute} wrap="truncate-start">{f}</Text>)}
            {d.validation && !d.validation.skipped ? <Label text="Tests" right={<Chip text={d.validation.passed ? 'Passed' : 'Failed'} tone={d.validation.passed ? 'ok' : 'bad'} />} /> : null}
            {d.validation && !d.validation.skipped && !d.validation.passed ? <Prose text={d.validation.output.trim().split('\n').slice(-8).join('\n')} color={P.mute} /> : null}
            {d.summary ? <Label text="Worker" /> : null}
            {d.summary ? <Clamp id={`sum-${t.key}`} text={d.summary} chars={200} /> : null}
            {d.review ? <Label text={`Review ${d.review.iteration}`} right={<Chip text={d.review.verdict.replace(/_/g, ' ')} tone={d.review.verdict === 'approve' ? 'ok' : d.review.verdict === 'escalate' ? 'warn' : 'bad'} />} /> : null}
            {d.review ? <Clamp id={`rev-${t.key}`} text={d.review.summary} chars={200} /> : null}
            {d.review?.issues.map(i => <Box gap={1}><Chip text={i.severity} tone={i.severity === 'blocker' ? 'bad' : i.severity === 'major' ? 'warn' : 'mute'} /><Box flexShrink={1} minWidth={0}><Text color={P.sub} wrap="wrap">{i.file ? `${i.file}: ` : ''}{i.description}</Text></Box></Box>)}
          </Box>
        ) : <Box marginTop={1}><Text color={P.faint} wrap="wrap">No details for this task yet.</Text></Box>}
      </Box>
    )
  }

  // ── changes: what each task's worktree holds now ──

  const changed = run.tasks.filter(t => t.live?.files.length)
  const focus = (selTask?.live?.files.length ? selTask : changed[0]) ?? null
  const changes = (
    <Box flexDirection="column">
      {changed.length ? (
        <Box gap={1} flexWrap="wrap" marginBottom={1}>
          {changed.map(t => (
            <Box key={`d-chg-${t.key}`} backgroundColor={t.key === focus?.key ? P.select : P.raised} paddingX={1}>
              <Button plain dimColor={t.key !== focus?.key} key={`chg-pick-${t.key}`} label={`${t.key} · ${t.live!.files.length} file${t.live!.files.length > 1 ? 's' : ''}`} onPress={() => pickTask(t)} />
            </Box>
          ))}
        </Box>
      ) : null}
      {focus?.live ? (
        <Box flexDirection="column">
          {focus.live.files.map(f => <Box key={`d-file-${f.path}`} gap={1}><Chip text={f.status} tone={FILE_TONE[f.status] ?? 'mute'} /><Text color={P.sub}>{f.path}</Text></Box>)}
          {focus.live.preview ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={P.mute} wrap="wrap">Biggest change · {focus.live.preview.file}</Text>
              <Code format="diff" path={focus.live.preview.file} wrap="truncate-end" source={focus.live.preview.diff.split('\n').filter(l => l !== '…').join('\n').slice(0, 12000)} />
            </Box>
          ) : null}
        </Box>
      ) : <Text color={P.faint} wrap="wrap">{live ? 'No changes on disk yet: they show here as the workers write them.' : 'The worktrees are gone; the report and the integration branch hold the result.'}</Text>}
    </Box>
  )

  // ── events and the report ──

  const events = (
    <Box flexDirection="column">
      {run.recentEvents.length ? [...run.recentEvents].reverse().slice(0, 80).map(ev => {
        const id = `ev-${ev.ts}-${ev.type}`
        const t: Tone = /fail|error|conflict|reject/.test(ev.type) ? 'bad' : ev.type.startsWith('approval') || ev.type.includes('escalat') ? 'warn' : /merge|complet|pass|approved|integrated/.test(ev.type) ? 'ok' : ev.type.startsWith('task') ? 'info' : 'violet'
        return (
          <Box key={`d-${id}`} flexDirection="column">
            <Box gap={1}>
              <Box width={9} flexShrink={0}><Text color={P.faint}>{clock(ev.ts)}</Text></Box>
              <Text color={fg(t)}>●</Text>
              <Box width={24} flexShrink={0}><Text color={fg(t)} bold wrap="truncate-end">{ev.type}</Text></Box>
              <Box flexShrink={1} minWidth={0}><Text color={P.sub} wrap="truncate-end">{ev.text === ev.type ? '' : ev.text}</Text></Box>
              {ev.detail ? <Button plain dimColor key={`open-${id}`} label={isOpen(id) ? 'Less' : 'More'} onPress={() => toggle(id)} /> : null}
            </Box>
            {isOpen(id) && ev.detail ? <Box paddingLeft={11}><Prose text={ev.detail} color={P.mute} /></Box> : null}
          </Box>
        )
      }) : <Text color={P.faint}>No events yet.</Text>}
    </Box>
  )
  const report = u.report?.runId === run.id
    ? <Box flexDirection="column">{k.chunks(u.report.text.slice(0, 40000)).map((c, i) => <Markdown key={`d-report-${i}`} text={c} />)}</Box>
    : <Box flexDirection="column" alignItems="flex-start"><Text color={P.mute} wrap="wrap">The report sums up the mission: the design, the work, the tests and the risks left.</Text><Box marginTop={1}><Button key="d-load-report" label="Load the report" onPress={() => act.report(run.id)} /></Box></Box>

  const tab = u.deskTab ?? 'activity'
  const counts: Record<CockpitDeskTab, string> = {
    activity: minds.some(m => m.status === 'active') ? SPIN[n % SPIN.length]! : '',
    tasks: run.tasks.length ? `${done}/${run.tasks.length}` : '',
    changes: changed.length ? String(changed.reduce((a, t) => a + t.live!.files.length, 0)) : '',
    events: String(run.recentEvents.length),
    report: '',
  }
  const tabs = (
    <Box gap={1} marginBottom={1} flexWrap="wrap">
      {TABS.map(([id, name], i) => (
        <Box key={`d-tab-box-${id}`} backgroundColor={tab === id ? P.select : undefined} paddingX={1}>
          <Button plain hotkey={String(i + 1)} dimColor={tab !== id} key={`tab-${id}`} label={counts[id] ? `${name}  ${counts[id]}` : name} onPress={() => act.patch({ deskTab: id })} />
        </Box>
      ))}
    </Box>
  )
  const body = tab === 'tasks' ? (wide ? taskList : <Box flexDirection="column">{taskList}<Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={P.lineSoft} paddingX={2}>{inspector(selTask)}</Box></Box>)
    : tab === 'changes' ? changes
      : tab === 'events' ? events
        : tab === 'report' ? report
          : activity
  const center = <Card id="d-center" grow>{tabs}{body}</Card>
  const right = (
    <Box flexDirection="column" width={46} flexShrink={0}>
      <Card id="d-inspector" head={selTask ? 'Task' : 'Tasks'} right={tab !== 'tasks' ? <Button plain dimColor key="d-all-tasks" label="All tasks" onPress={() => act.patch({ deskTab: 'tasks' })} /> : null}>
        {inspector(selTask)}
      </Card>
    </Box>
  )
  const left = (
    <Box flexDirection="column" width={38} flexShrink={0}>
      {teamCard}
      {spendCard(run)}
    </Box>
  )

  return page(
    failureCard,
    header,
    cancelCard,
    approvals.map(a => <ApprovalCard a={a} />),
    wide
      ? <Box gap={1} alignItems="flex-start">{left}{center}{right}</Box>
      : medium
        ? <Box gap={1} alignItems="flex-start">{left}{center}</Box>
        : <Box flexDirection="column">{center}{teamCard}{spendCard(run)}</Box>,
  )
}
