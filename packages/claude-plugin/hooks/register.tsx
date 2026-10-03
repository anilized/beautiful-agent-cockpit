import { atom, read, update } from 'claude-code'
import type { EngineInterface, InputProps, Register, RenderChildren, RenderInput } from 'claude-code'

import type { CockpitApproval, CockpitMind, CockpitRun, CockpitSnapshot, CockpitTab, CockpitTask, CockpitUi, CockpitView } from '../types'
import * as paint from './raster'
import { COCKPIT_ROOT } from './root'
import { createScheduler, makeClock, type RasterScheduler, type RasterSpec } from './scheduler'
import { C, K, LOGO_GRADIENT, onTheme, useTheme } from './theme'
import { createTweens, type Tweens } from './tween'

// Presentation only: the orchestrator owns all workflow state. This mod reads the
// snapshot the orchestrator projects to <dataDir>/snapshot.json and sends human
// decisions through the cockpit CLI, which talks to the orchestrator service.

const PANE = 'agent-cockpit'
const EMPTY: CockpitView = { snapshot: null, error: null, message: null }
const UI0: CockpitUi = { selectedRun: null, tab: 'live', composing: null, nonce: 0, busy: null, report: null, failure: null, seats: { supervisor: null, lead: null }, efforts: {}, mind: null, open: [], focus: 'tasks', task: null }
const view = atom({ plugin: 'agent-cockpit', key: 'view' } as const, EMPTY)
const ui = atom({ plugin: 'agent-cockpit', key: 'ui' } as const, UI0)
const tickAtom = atom({ plugin: 'agent-cockpit', key: 'tick' } as const, 0)

// ── palette ──────────────────────────────────────────────────────────────────

// Built from the palette, and rebuilt when the theme switches.
const STATUS_COLOR: Record<string, string> = {}
onTheme(() => Object.assign(STATUS_COLOR, {
  running: C.cyan, needs_input: C.yellow, validating: C.blue, in_review: C.violet, changes_requested: C.yellow,
  lease_conflict: C.red, approved: C.green, integrated: C.green, escalated: C.yellow, failed: C.red, cancelled: C.dim,
  pending: C.dim, ready: C.text, created: C.mute, architecting: C.violet, proposing: C.violet, deciding: C.violet,
  planning: C.blue, executing: C.cyan, integrating: C.cyan, merging: C.green, awaiting_approval: C.yellow,
  awaiting_human_decision: C.yellow, completed: C.green, rejected: C.red, passed: C.green, started: C.cyan,
}))
const ICON: Record<string, string> = {
  pending: '·', ready: '○', needs_input: '?', in_review: '◎', changes_requested: '↺', lease_conflict: '⚠',
  approved: '✓', integrated: '✓', escalated: '⇧', failed: '✗', cancelled: '–', passed: '✓', completed: '✓', rejected: '✗',
}
const MOVING = new Set(['running', 'validating', 'started', 'architecting', 'proposing', 'deciding', 'planning', 'executing', 'integrating', 'merging'])
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ORBIT = ['◐', '◓', '◑', '◒']

// The run lifecycle as a stepper: each step and the run statuses that sit on it.
const STEPS: [string, string[]][] = [
  ['architect', ['created', 'architecting']],
  ['debate', ['proposing', 'deciding', 'awaiting_human_decision']],
  ['plan', ['planning']],
  ['build', ['executing']],
  ['integrate', ['integrating']],
  ['validate', ['validating']],
  ['approve', ['awaiting_approval']],
  ['merge', ['merging']],
]
const TERMINAL = ['completed', 'rejected', 'failed']

// ── color math ───────────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b)
  const k = Math.min(1, Math.max(0, t))
  const c = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0')
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}
function gradient(stops: string[], t: number): string {
  const x = (((t % 1) + 1) % 1) * (stops.length - 1)
  const i = Math.floor(x)
  return mix(stops[i]!, stops[Math.min(i + 1, stops.length - 1)]!, x - i)
}
const pulse = (n: number, a: string, b: string, speed = 0.3) => mix(a, b, (Math.sin(n * speed) + 1) / 2)

// ── helpers ──────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

function activeRun(s: CockpitSnapshot | null): CockpitRun | null {
  if (!s?.runs.length) return null
  return s.runs.find(r => !TERMINAL.includes(r.status)) ?? s.runs[0]!
}

/** Lines of an approval shown before "show all". */
const APPROVAL_PREVIEW = 6
const wrapped = (text: string, width: number) => text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / Math.max(1, width))), 0)
/**
 * A Markdown element holds at most 10000 characters (a longer one makes the engine refuse the
 * whole pane): split at blank lines outside code fences into pieces under the cap.
 */
function markdownChunks(text: string, max = 9000): string[] {
  const out: string[] = []
  let cur = ''
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (!fenced && line.trim() === '' && cur.length > max * 0.6) (out.push(cur), (cur = ''))
    for (let rest = line; ; ) {
      // A single line longer than the cap is cut where it must be.
      const room = max - cur.length - 1
      if (rest.length <= room) { cur += (cur ? '\n' : '') + rest; break }
      if (cur) (out.push(cur), (cur = ''))
      else (out.push(rest.slice(0, max)), (rest = rest.slice(max)))
    }
  }
  if (cur) out.push(cur)
  return out
}
/** A bar of `w` cells filled to `frac` in eighths: smooth at any width, no raster needed. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const smoothBar = (frac: number, w: number) => {
  const eighths = Math.round(Math.min(1, Math.max(0, frac)) * w * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return { fill: '█'.repeat(full) + part, rest: ' '.repeat(Math.max(0, w - full - (part ? 1 : 0))) }
}
const isDone = (t: CockpitTask) => t.status === 'approved' || t.status === 'integrated'
const clip = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = (s: string) => s.split('\n')[0]!.trim()
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
function glyph(status: string, n: number): string {
  return MOVING.has(status) ? SPIN[n % SPIN.length]! : (ICON[status] ?? '●')
}
function eventColor(type: string): string {
  if (/fail|error|conflict|reject/.test(type)) return C.red
  if (type.startsWith('approval') || type.includes('escalat')) return C.yellow
  if (/merge|complet|pass|approved|integrated/.test(type)) return C.green
  if (type.startsWith('task')) return C.cyan
  if (type.startsWith('test')) return C.blue
  return C.violet
}

// What a model is doing, by the structured answer its call must produce.
const DOING: Record<string, string> = {
  ArchitectureOutput: 'designing the architecture', LeadArchitectureReview: 'reviewing the architecture', SupervisorDecisions: 'ruling on proposals',
  LeadPlan: 'planning the tasks', WorkerResult: 'implementing', LeadAnswer: "answering a worker's question", SupervisorEscalation: 'handling an escalation',
  LeadReview: 'reviewing the work', LeadLeaseDecision: 'settling a file conflict', LeadIntegrationResult: 'resolving merge conflicts',
  SupervisorValidation: 'validating the result', SupervisorRevision: 'revising the direction',
}
const ROLE_COLOR: Record<string, string> = {}
onTheme(() => Object.assign(ROLE_COLOR, { supervisor: C.violet, lead: C.cyan, worker: C.orange }))
// A tool's argument on one line: a heredoc shows its first line, a path inside a task worktree its repo-relative part.
const toolDetail = (detail: string) => {
  const lines = detail.split('\n')
  const head = lines[0]!.replace(/^.*[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]/, '')
  return lines.length > 1 ? `${head} ⏎ +${lines.length - 1} lines` : head
}
const doing = (m: CockpitMind) => (m.contract ? DOING[m.contract] ?? m.contract : m.role === 'worker' ? 'implementing' : 'working')

// ── orchestrator I/O ─────────────────────────────────────────────────────────

let lastGenerated = ''

// One lifecycle per session: scheduler, clock, tweens, text tick. `clock` is elapsed animation time (frozen under COCKPIT_REDUCED_MOTION,
// read once at session.start); wall time only feeds the clock strings. Exactly one timer advances it: the scheduler's loop while it runs,
// else the text tick, re-anchored from the prefetched $.clock.now() about once a second. No per-tick awaits.
type Life = {
  /** The name in the header: COCKPIT_BRAND, else ANILDEV. */
  brand: string
  sched: RasterScheduler
  clock: ReturnType<typeof makeClock>
  tweens: Tweens
  open: boolean
  reduced: boolean
  motion: boolean
  run: string
  wall: number
  seen: number
  tick: (() => void) | null
  setMotion: (on: boolean) => void
  arm: () => void
  close: () => void
}
let life: Promise<Life> | null = null
let stopPoll: (() => void) | null = null
const TICK_MS = 125 // text spinners and pulses: <=10 fps with motion
const IDLE_TICK_MS = 1000
const STALE_MS = 1500 // the host has no unmount event: no render for longer than ~1.5x the idle beat means the pane was gone, tweens snap

async function createLife($: EngineInterface): Promise<Life> {
  const reduced = (await $.env.get('COCKPIT_REDUCED_MOTION')) === '1'
  useTheme(await $.env.get('COCKPIT_THEME')) // phosphor unless COCKPIT_THEME=neon
  const brand = (await $.env.get('COCKPIT_BRAND')) || 'ANILDEV'
  const wall = await $.clock.now()
  const clock = makeClock({ fetch: () => $.clock.now() })
  if (reduced) clock.freeze(true)
  const l: Life = {
    sched: null as never, clock, tweens: createTweens(), open: true, reduced, motion: false, run: '', wall, seen: wall, tick: null, brand,
    setMotion(on) {
      if (on === l.motion || !l.open) return
      l.motion = on
      l.sched.setMotion(on)
      l.arm()
    },
    arm() {
      l.tick?.()
      const ms = l.motion ? TICK_MS : IDLE_TICK_MS
      const t = $.clock.every(ms, () => {
        if (!l.sched.stats().periodMs) clock.tick(ms) // the scheduler's loop owns the clock while it runs
        void update($, tickAtom, n => n + 1)
      })
      l.tick = () => t.cancel()
    },
    close() {
      l.open = false
      l.sched.stop()
      l.tick?.()
      l.tick = null
      l.tweens.reset()
    },
  }
  l.sched = createScheduler({
    now: clock.now,
    every: (ms, fn) => { const t = $.clock.every(ms, () => (clock.tick(ms), fn())); return () => t.cancel() },
    blit: (key, cells) => $.ui.blit({ requestId: PANE, key, cells }), // {} when taken, else { deny } (d.ts)
  })
  l.sched.setMotion(false)
  l.arm()
  clock.refresh()
  return l
}
let ended = false // a render after session.end gets an inert Life: no timers, no blits
const getLife = ($: EngineInterface) => (life ??= createLife($).then(l => (ended && l.close(), l)))
function closeLife() {
  const p = life
  life = null
  void p?.then(l => l.close())
}
const seenApprovals = new Set<string>()
let paths: { root: string; dataDir: string } | null = null

async function locate($: EngineInterface) {
  if (paths) return paths
  const root = COCKPIT_ROOT || `${$.plugin.root}/../..`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const dataDir = (await $.env.get('COCKPIT_DATA_DIR')) ?? `${home}/.agent-cockpit`
  paths = { root, dataDir }
  return paths
}

async function cli($: EngineInterface, args: string[], timeoutMs = 60_000) {
  const { root } = await locate($)
  const res = await $.process.run(['node', `${root}/bin/cockpit.mjs`, ...args], { timeoutMs })
  const text = `${res.stdout}${res.stderr}`.trim()
  return { ok: res.exitCode === 0, text }
}

async function refresh($: EngineInterface) {
  const { dataDir } = await locate($)
  const l = await life
  if (l?.open) l.wall = await $.clock.now(), l.clock.refresh() // 1 Hz poll: re-anchor elapsed time
  let snapshot: CockpitSnapshot | null = null
  try {
    snapshot = JSON.parse(await $.fs.read(`${dataDir}/snapshot.json`)) as CockpitSnapshot
  } catch {
    if (lastGenerated !== 'missing') {
      lastGenerated = 'missing'
      await update($, view, v => ({ ...v, snapshot: null, error: 'Orchestrator not started' }))
    }
    return
  }
  if (snapshot.generatedAt === lastGenerated) return
  lastGenerated = snapshot.generatedAt
  await update($, view, v => ({ ...v, snapshot, error: null }))

  for (const a of snapshot.pendingApprovals) {
    if (seenApprovals.has(a.id)) continue
    seenApprovals.add(a.id)
    $.ui.toast(`◆ Cockpit needs your decision (${a.kind}): ${a.summary.slice(0, 80)}`)
  }
  // The run's one-line summary is drawn by the HUD mod's band, which reads the same snapshot.
  const run = activeRun(snapshot)
}

// $.state outlives a reload, so a value saved by an older build may lack newer fields.
const PANES: CockpitTab[] = ['live', 'task', 'events', 'report']
const withDefaults = (u: Partial<CockpitUi> | undefined): CockpitUi => {
  const x = { ...UI0, ...u }
  // A build before the overhaul stored tab names that no longer exist ('tasks', 'minds').
  return PANES.includes(x.tab) ? x : { ...x, tab: 'live' }
}
const readUi = async ($: EngineInterface) => withDefaults(await read($, ui))

function patchUi($: EngineInterface, patch: Partial<CockpitUi> | ((u: CockpitUi) => Partial<CockpitUi>)) {
  return update($, ui, (stored): CockpitUi => {
    const u = withDefaults(stored)
    return { ...u, ...(typeof patch === 'function' ? patch(u) : patch) }
  })
}

async function say($: EngineInterface, message: string | null) {
  await update($, view, v => ({ ...v, message }))
}

async function busy<T>($: EngineInterface, label: string, work: () => Promise<T>): Promise<T> {
  await patchUi($, () => ({ busy: label }))
  try {
    return await work()
  } finally {
    await patchUi($, () => ({ busy: null }))
  }
}

async function decide($: EngineInterface, decision: 'approve' | 'reject' | 'changes', target: string | null, note: string) {
  const snap = (await read($, view)).snapshot
  let id = target
  if (!id) {
    const pending = snap?.pendingApprovals ?? []
    const final = pending.find(a => a.kind === 'final') ?? pending[0]
    if (!final) return 'Nothing is awaiting your decision.'
    id = final.id
  }
  if (decision === 'changes' && !note) return 'Describe the changes: /cockpit changes <what to change>'
  const res = await busy($, `${decision}…`, () => cli($, [decision, id!, ...(note ? [note] : [])]))
  await say($, res.text)
  await refresh($)
  return res.text
}

async function gitRoot($: EngineInterface, dir: string) {
  const res = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : dir
}

async function startRun($: EngineInterface, text: string) {
  const rest = tokenize(text)
  const flagAt = rest.findIndex(t => t.startsWith('--'))
  const request = (flagAt === -1 ? rest : rest.slice(0, flagAt)).join(' ')
  const flags = flagAt === -1 ? [] : rest.slice(flagAt)
  if (!request) return 'Usage: /cockpit run <request> [--test "<cmd>"] [--repo <path> ...]'
  // Default target: the repository the session sits in, at its root.
  const repo = rest.includes('--repo') ? [] : ['--repo', await gitRoot($, await $.session.cwd())]
  // The seats picked in the composer, unless the request names them itself.
  const { seats } = await readUi($)
  const picked = [
    ...(seats.supervisor && !rest.includes('--supervisor') ? ['--supervisor', seats.supervisor] : []),
    ...(seats.lead && !rest.includes('--lead') ? ['--lead', seats.lead] : []),
  ]
  const { efforts } = await readUi($)
  for (const [agent, level] of Object.entries(efforts)) if (!flags.some(f => f.startsWith(`${agent}=`))) picked.push('--effort', `${agent}=${level}`)
  const res = await busy($, 'launching run…', () => cli($, ['run', request, ...repo, ...flags, ...picked]))
  if (res.ok) {
    await say($, res.text)
    await patchUi($, { selectedRun: null, tab: 'live', failure: null })
  } else {
    const detail = res.text.split('\n').map(l => l.trim()).filter(Boolean)
    const reason = detail.find(l => /error|has no commits|not a git|usage/i.test(l)) ?? detail[0] ?? 'the orchestrator refused the run'
    const empty = /^(?:error:\s*)?(.+?) has no commits yet/i.exec(reason)
    await say($, null)
    await patchUi($, { failure: { text: reason.replace(/^error:\s*/i, ''), request: text, uninitializedRepo: empty ? empty[1]! : null } })
  }
  await refresh($)
  return res.text
}

async function setEffort($: EngineInterface, runId: string, efforts: Record<string, string>) {
  const pairs = Object.entries(efforts).map(([a, l]) => `${a}=${l}`)
  if (!pairs.length) return
  const res = await busy($, `effort ${pairs.join(' ')}…`, () => cli($, ['effort', runId, ...pairs]))
  await say($, res.text)
  lastGenerated = ''
  await refresh($)
}

async function setSeat($: EngineInterface, runId: string, role: 'supervisor' | 'lead', agent: string) {
  const res = await busy($, `handing the ${role} seat to ${agent}…`, () => cli($, ['roles', runId, `--${role}`, agent]))
  await say($, res.text)
  lastGenerated = ''
  await refresh($)
}

async function initialCommitAndRetry($: EngineInterface) {
  const f = (await readUi($)).failure
  if (!f?.uninitializedRepo) return
  const dir = f.uninitializedRepo
  const ok = await busy($, `initial commit in ${dir}…`, async () => {
    const add = await $.process.run(['git', '-C', dir, 'add', '-A'], { timeoutMs: 60_000 })
    if (add.exitCode !== 0) return `${add.stdout}${add.stderr}`.trim()
    const commit = await $.process.run(['git', '-C', dir, 'commit', '-m', 'Initial commit'], { timeoutMs: 60_000 })
    return commit.exitCode === 0 ? '' : `${commit.stdout}${commit.stderr}`.trim()
  })
  if (ok) return void patchUi($, { failure: { ...f, text: ok, uninitializedRepo: null } })
  await patchUi($, { failure: null })
  await startRun($, f.request)
}

async function daemon($: EngineInterface, start: boolean) {
  const res = await busy($, start ? 'starting orchestrator…' : 'stopping orchestrator…', () => cli($, start ? ['daemon', '--detach'] : ['stop']))
  await say($, res.text)
  lastGenerated = ''
  await refresh($)
  return res.text
}

async function loadReport($: EngineInterface, runId: string) {
  await patchUi($, { tab: 'report', report: null })
  const res = await busy($, 'fetching report…', () => cli($, ['report', runId]))
  await patchUi($, { report: { runId, text: res.text || 'No report yet.' } })
}

type PaneRender = RenderInput<'Pane'>

const openPane = ($: EngineInterface, focus = false) =>
  $.ui.open({ id: PANE, title: '◆ Cockpit', ...(focus ? { focus: true as const } : {}) })

// ── plugin ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cockpit',
      description: 'Agent cockpit: /cockpit [start|stop|run <request>|status|approve|changes <text>|reject|report|dashboard]',
    })
    $.ui.status(undefined) // no text status line: the HUD band draws it
    ended = false
    closeLife()
    await getLife($)
    await refresh($)
    stopPoll?.()
    const poll = $.clock.every(1000, () => void refresh($))
    stopPoll = () => poll.cancel()
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e) // a hook may keep the pane open: tear down only after it is really closing
    if (e.id === PANE) {
      closeLife()
    }
    return r
  })
  on('session.end', async ($, e, next) => {
    ended = true
    closeLife()
    stopPoll?.()
    stopPoll = null
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [sub = 'open', ...rest] = tokenize(e.args)
    switch (sub) {
      case 'open': {
        const placed = await openPane($, true)
        return { text: placed.isPlaced ? 'Cockpit opened.' : `Cockpit is open but not drawn: ${placed.reason}` }
      }
      case 'start': {
        await openPane($)
        return { text: await daemon($, true) }
      }
      case 'stop':
        return { text: await daemon($, false) }
      case 'run': {
        await openPane($)
        return { text: await startRun($, e.args.replace(/^\s*run\s*/, '')) }
      }
      case 'status':
        return { text: (await cli($, ['status'])).text }
      case 'report': {
        const run = rest[0] ?? activeRun((await read($, view)).snapshot)?.id
        if (!run) return { text: 'No run yet.' }
        return { text: (await cli($, ['report', run])).text }
      }
      case 'dashboard': {
        const run = rest[0] ?? activeRun((await read($, view)).snapshot)?.id
        return { text: (await cli($, ['dashboard', ...(run ? [run] : [])])).text }
      }
      case 'approve':
      case 'reject':
      case 'changes': {
        const target = rest[0]?.startsWith('apr_') || rest[0]?.startsWith('run_') ? rest[0]! : null
        const note = (target ? rest.slice(1) : rest).join(' ')
        return { text: await decide($, sub, target, note) }
      }
      default:
        return { text: 'Usage: /cockpit [start|stop|run <request>|status|approve [note]|changes <text>|reject [note]|report|dashboard]' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      return await drawPane($, e)
    } catch (err) {
      // Show the failure in the pane instead of letting the engine draw an empty one.
      const { Box, Text } = $.ui.resolve(e)
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={C.red} bold>✗ cockpit could not draw</Text>
          <Text color={C.text} wrap="wrap">{message}</Text>
          <Text color={C.dim} wrap="wrap">{err instanceof Error && err.stack ? err.stack.split('\n').slice(1, 4).join(' · ') : ''}</Text>
        </Box>
      )
    }
  })
}

async function drawPane($: EngineInterface, e: PaneRender) {
  {
    const T = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = T
    // Surfaces without text fields (mobile) get a hint to use the slash command instead.
    const Input = 'Input' in T ? T.Input : (_: InputProps) => Text({ color: C.dim, children: 'type it as /cockpit run … or /cockpit changes …' })
    // Desktop and mobile draw no cell grid: they get the designed text fallbacks instead.
    const RasterEl = e.surface === 'terminal' && 'Raster' in T ? T.Raster : null
    const v = await read($, view)
    const u = await readUi($)
    await read($, tickAtom)
    const l = await getLife($)
    const wall = await $.clock.now()
    if (wall - l.seen > STALE_MS) l.tweens.reset(), (l.run = '') // the pane was gone: nothing eases across the gap
    l.seen = l.wall = wall
    const now = wall
    const anim = l.clock.now()
    const n = Math.floor(anim / TICK_MS) // text beat: derived from animation time, so it stops with it
    const s = v.snapshot
    const cols = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 100)
    const rows = Math.max(e.props.scroll?.bodyRows ?? 0, (e.viewport?.rows ?? 40) - 8)
    const online = !!s && s.daemon.port !== null
    const specs = new Map<string, RasterSpec>()

    // A Raster drawn now at the current elapsed time; `animated` ones are repainted by the scheduler afterwards.
    const raster = (key: string, columns: number, height: number, animated: boolean, fn: (t: number) => string, fallback: RenderChildren = null) => {
      if (!RasterEl || columns < 1) return fallback
      // At rest only the hero (it carries the wall clock) is repainted by the scheduler; the rest are redrawn by the 1 Hz render.
      if (animated && (l.motion || key === 'hero')) specs.set(key, { animated: true, paint: fn })
      return RasterEl({ key, columns, rows: height, cells: fn(anim) })
    }
    // Every return path reports the mounted raster keys; text-only surfaces have none and leave the scheduler alone.
    const out = <R,>(el: R): R => (RasterEl && l.open && l.sched.sync(specs), el)
    // Tweens: retarget at render, sampled at paint time so the ease runs between renders.
    const run0 = online ? (u.selectedRun && s.runs.find(r => r.id === u.selectedRun)) || activeRun(s) : null
    const viewing = !!run0 && !TERMINAL.includes(run0.status)
    l.setMotion(!!online && !l.reduced && viewing)
    if ((run0?.id ?? '') !== l.run) l.tweens.reset(), (l.run = run0?.id ?? '') // run switch (user pick or auto): nothing eases across it
    const snap = !l.motion // reduced motion and idle: values jump
    const ease = (el: string, target: number, ms = 600) => {
      const id = run0?.id
      if (!id) return () => target
      return (t: number) => (l.run === id ? l.tweens.sample(id, el, target, t, { durMs: ms, snap }) : target)
    }
    const easing = (el: string) => !!run0 && l.motion && !l.tweens.settled(run0.id, el, anim)

    // ── small pieces ──

    const Pill = ({ label, bg, fg }: { label: string; bg: string; fg?: string }) => (
      <Text backgroundColor={bg} color={fg ?? C.bgDeep} bold> {label} </Text>
    )
    const Key = ({ k, label }: { k: string; label: string }) => (
      <Text>
        <Text backgroundColor={C.chip} color={C.text} bold> {k} </Text>
        <Text color={C.dim}> {label}   </Text>
      </Text>
    )
    const Title = ({ label, right, color }: { label: string; right?: RenderChildren; color?: string }) => (
      <Box justifyContent="space-between">
        <Text color={color ?? C.mute} bold>{label}</Text>
        {right ?? null}
      </Box>
    )
    const Card = ({ title, right, children, color, width, grow }: { title: string; right?: RenderChildren; children: RenderChildren; color?: string; width?: number; grow?: boolean }) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color ?? C.border} paddingX={1} width={width} flexGrow={grow ? 1 : 0}>
        <Title label={title} right={right} />
        {children}
      </Box>
    )

    const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19)
    const clock = hms(now)
    const seated = (s && activeRun(s)?.roles) ?? s?.hierarchy
    const chain = seated ? `${seated.supervisor} ▸ ${seated.lead} ▸ workers` : 'opus ▸ codex ▸ workers'
    const attention = !!s?.pendingApprovals.length
    const heroInfo = (): paint.HeroData => ({
      online,
      alert: attention,
      left: chain,
      right: `${online ? `online :${s!.daemon.port}` : 'offline'}  ${hms(l.wall)}`,
    })
    const hero = raster('hero', cols, 1, true, t => paint.hero(cols, 1, t, { ...heroInfo(), brand: `◎ ${l.brand}` }), (
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold wrap="truncate-end">{[...`◎ ${l.brand}`].map((ch, i) => <Text color={gradient(LOGO_GRADIENT, i / 22 - n / 40)}>{ch}</Text>)}<Text color={C.dim}>  // MULTI-AGENT CODING COCKPIT</Text><Text color={C.lavender}>  {chain}</Text></Text>
        <Text color={C.mute}>{online ? '● online' : '○ offline'}  {clock}</Text>
      </Box>
    ))

    const keybar = (keys: [string, string][]) => (
      <Box flexDirection="column" paddingX={1}>
        {u.busy ? (
          <Text color={C.cyan}>{SPIN[n % SPIN.length]} {u.busy}</Text>
        ) : v.message ? (
          <Text color={C.mute} wrap="truncate-end">↳ {firstLine(v.message)}</Text>
        ) : null}
        <Text wrap="truncate-end">
          {e.props.isFocused ? keys.map(([k, l]) => <Key k={k} label={l} />) : <Text color={C.dim}>ctrl+x tab  focus the cockpit — every action is one key away</Text>}
        </Text>
      </Box>
    )

    const failureCard = u.failure ? (
      <Box flexDirection="column" borderStyle="round" borderColor={pulse(n, C.red, C.redDeep, 0.35)} paddingX={1}>
        <Box justifyContent="space-between">
          <Text><Pill label="✗ LAUNCH FAILED" bg={C.red} /> <Text color={C.dim}>{clip(firstLine(u.failure.request), 40)}</Text></Text>
        </Box>
        <Text color={C.red} bold wrap="wrap">{u.failure.text}</Text>
        <Box gap={1}>
          {u.failure.uninitializedRepo ? (
            <Button variant="primary" hotkey="i" key="init-commit" autoFocus label="i · Initial commit & retry" onPress={() => void initialCommitAndRetry($)} />
          ) : null}
          <Button hotkey="e" key="edit-failed" label="e · Edit request" onPress={() => void patchUi($, { failure: null, composing: { kind: 'run' } })} />
          <Button plain dimColor key="dismiss-failure" label="dismiss" onPress={() => void patchUi($, { failure: null })} />
        </Box>
      </Box>
    ) : null

    // Seats: every enabled agent tagged for a role is a chip; a click seats it, and
    // a hotkey cycles to the next one. The other seat's holder is skipped (they must differ).
    type Seats = { supervisor: string; lead: string }
    type Role = keyof Seats
    const eligible = (role: Role) => (s?.agents ?? []).filter(a => a.enabled && a.roles.includes(role))
    const nextSeats: Seats | null = s ? { supervisor: u.seats.supervisor ?? s.hierarchy.supervisor, lead: u.seats.lead ?? s.hierarchy.lead } : null
    const pickNext = (role: Role, agent: string) => void patchUi($, x => ({ seats: { ...x.seats, [role]: agent } }))
    const effortNext = (changes: Record<string, string | null>) =>
      void patchUi($, x => {
        const efforts = { ...x.efforts }
        for (const [agent, level] of Object.entries(changes)) if (level === null) delete efforts[agent]; else efforts[agent] = level
        return { efforts }
      })
    // Effort: each agent's levels come from the snapshot; null means the CLI's own default.
    const agentInfo = (id: string) => (s?.agents ?? []).find(a => a.id === id)
    const levelsOf = (id: string) => agentInfo(id)?.efforts ?? []
    const EffortChip = ({ id, keyId, level, live, hotkey, onCycle }: { id: string; keyId: string; level: string | null; live: boolean; hotkey?: string; onCycle: (next: string | null) => void }) => {
      const levels = levelsOf(id)
      if (!levels.length) return null
      const ring: (string | null)[] = live ? levels : [null, ...levels]
      const next = ring[(ring.indexOf(level) + 1) % ring.length] ?? null
      const at = level ? levels.indexOf(level) : -1
      const meter = levels.map((_, i) => (i <= at ? '▮' : '▯')).join('')
      const heat = at < 0 ? C.dim : gradient([C.cyan, C.violet, C.pink, C.accent], at / Math.max(1, levels.length - 1))
      return (
        <Box marginLeft={1} key={`effort-box-${keyId}`} hover={{ backgroundColor: C.baseline }}>
          <Text color={heat}>⚡{meter} </Text>
          <Button plain hotkey={hotkey} dimColor={!level} key={`effort-${keyId}`} label={level ?? 'default'} onPress={() => onCycle(next)} />
        </Box>
      )
    }
    const SeatBar = ({ seats, onPick, keys, note, efforts, live, onEffort, compact }: { seats: Seats; onPick: (role: Role, agent: string) => void; keys: boolean; note: string; efforts: Record<string, string>; live: boolean; onEffort: (changes: Record<string, string | null>) => void; compact?: boolean }) => {
      // Keyed by seat (`lead:sonnet`), so one agent in two seats keeps two levels; a bare id is the fallback.
      const levelOf = (role: Role | 'worker', id: string) => efforts[`${role}:${id}`] ?? efforts[id] ?? agentInfo(id)?.effort ?? null
      const row = (role: Role) => {
        const current = seats[role]
        const other = seats[role === 'supervisor' ? 'lead' : 'supervisor']
        const list = eligible(role)
        const tone = role === 'supervisor' ? C.violet : C.cyan
        const choices = list.map(a => a.id).filter(id => id !== other)
        const next = choices[(choices.indexOf(current) + 1) % Math.max(1, choices.length)]
        return (
          <Box>
            <Box width={15}><Text color={tone} bold>{role === 'supervisor' ? '◆ SUPERVISOR' : '◇ LEAD'}</Text></Box>
            {list.length === 0 ? <Text color={C.text} bold> {current}</Text> : list.map(a => {
              const on = a.id === current
              if (a.id === other && !on) return <Text color={C.faint} strikethrough> {a.id} </Text>
              return (
                <Box key={`chip-${role}-${a.id}`} backgroundColor={on ? (role === 'supervisor' ? C.seatSupervisor : C.seatLead) : undefined} paddingX={1} hover={{ backgroundColor: C.baseline }}>
                  <Button plain dimColor={!on} key={`seat-${role}-${a.id}`} label={`${on ? '● ' : ''}${a.id}`} onPress={() => { if (!on) onPick(role, a.id) }} />
                </Box>
              )
            })}
            {keys && next && next !== current ? (
              <Box marginLeft={1}><Button plain dimColor hotkey={role === 'supervisor' ? 'v' : 'b'} key={`cycle-${role}`} label={`→ ${next}`} onPress={() => onPick(role, next)} /></Box>
            ) : null}
            <EffortChip id={current} keyId={`${role}:${current}`} level={levelOf(role, current)} live={live} hotkey={keys ? (role === 'supervisor' ? 'f' : 'g') : undefined} onCycle={lv => onEffort({ [`${role}:${current}`]: lv })} />
          </Box>
        )
      }
      // Workers: one control for every enabled worker (each takes the level if its CLI accepts it).
      const workers = eligible('worker' as Role)
      const lead = workers[0]
      const workersRow = lead ? (
        <Box>
          <Box width={15}><Text color={C.green} bold>◈ WORKERS</Text></Box>
          <Text color={C.dim}>{workers.map(w => w.id).join(' · ')} </Text>
          <EffortChip id={lead.id} keyId={`worker:${lead.id}`} level={levelOf('worker', lead.id)} live={live} hotkey={keys ? 'w' : undefined} onCycle={lv => onEffort(Object.fromEntries(workers.filter(w => lv === null || levelsOf(w.id).includes(lv)).map(w => [`worker:${w.id}`, lv])))} />
          <Text color={C.dim}>  staffed by the lead</Text>
        </Box>
      ) : null
      if (compact) {
        // One line: each seat's holder (press to hand it to the next eligible agent) and its effort.
        const seat = (role: Role, glyphs: string, tone: string) => {
          const current = seats[role]
          const other = seats[role === 'supervisor' ? 'lead' : 'supervisor']
          const choices = eligible(role).map(a => a.id).filter(id => id !== other)
          const next = choices[(choices.indexOf(current) + 1) % Math.max(1, choices.length)]
          return (
            <Box marginRight={2}>
              <Text color={tone} bold>{glyphs} </Text>
              {keys && next && next !== current
                ? <Button plain hotkey={role === 'supervisor' ? 'v' : 'b'} key={`cycle-${role}`} label={current} onPress={() => onPick(role, next)} />
                : <Text color={C.text} bold>{current}</Text>}
              <EffortChip id={current} keyId={`${role}:${current}`} level={levelOf(role, current)} live={live} hotkey={keys ? (role === 'supervisor' ? 'f' : 'g') : undefined} onCycle={lv => onEffort({ [`${role}:${current}`]: lv })} />
            </Box>
          )
        }
        return (
          <Box flexWrap="wrap">
            {seat('supervisor', '◆', C.violet)}
            {seat('lead', '◇', C.cyan)}
            {lead ? (
              <Box>
                <Text color={C.green} bold>◈ </Text>
                <Text color={C.text}>{workers.map(w => w.id).join('·')}</Text>
                <EffortChip id={lead.id} keyId={`worker:${lead.id}`} level={levelOf('worker', lead.id)} live={live} hotkey={keys ? 'w' : undefined} onCycle={lv => onEffort(Object.fromEntries(workers.filter(w => lv === null || levelsOf(w.id).includes(lv)).map(w => [`worker:${w.id}`, lv])))} />
              </Box>
            ) : null}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {row('supervisor')}
          {row('lead')}
          {workersRow}
          <Text color={C.dim} wrap="truncate-end">{note}</Text>
        </Box>
      )
    }

    const composer = (
      <Box flexDirection="column" borderStyle="round" borderColor={pulse(n, C.accent, C.violet, 0.2)} paddingX={1}>
        <Title label="✦ NEW MISSION" color={C.accent} right={<Text color={C.dim}>enter to launch</Text>} />
        <Input
          key={`compose-${u.nonce}`}
          label="› "
          placeholder='What should the team build? (optional: --test "npm test" --repo ../other)'
          submitLabel="launch"
          autoFocus
          onSubmit={(text: string) => {
            if (!text.trim()) return
            void patchUi($, x => ({ composing: null, nonce: x.nonce + 1 })).then(() => startRun($, text))
          }}
        />
        {nextSeats ? <SeatBar seats={nextSeats} onPick={pickNext} keys={false} efforts={u.efforts} live={false} onEffort={effortNext} note="click a chip to change a seat or an effort for this mission" /> : null}
        <Box>
          <Text color={C.dim}>workers are staffed by the lead · runs in this session's folder unless --repo is given · </Text>
          <Button plain dimColor key="cancel-run" label="cancel" onPress={() => void patchUi($, { composing: null })} />
        </Box>
      </Box>
    )

    // ── offline ──

    if (!s || !online) {
      return out(
        <Box flexDirection="column">
          {hero}
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Text color={C.text} bold>The orchestrator is asleep.</Text>
            <Text color={C.dim}>Wake it and Opus, Codex and the workers report for duty.</Text>
            <Text> </Text>
            <Button variant="primary" hotkey="s" label="  s · Start orchestrator  " autoFocus onPress={() => void daemon($, true)} />
            <Text> </Text>
            {s && s.runs.length ? <Text color={C.dim}>{s.runs.length} past run{s.runs.length > 1 ? 's' : ''} on record</Text> : null}
          </Box>
          {keybar([['s', 'start']])}
        </Box>
      )
    }

    const run = (u.selectedRun && s.runs.find(r => r.id === u.selectedRun)) || activeRun(s)
    if (!run) {
      return out(
        <Box flexDirection="column">
          {hero}
          <Box flexDirection="column" paddingY={1} paddingX={1}>
            {failureCard}
            {u.composing?.kind === 'run' ? composer : (
              <Box flexDirection="column" alignItems="center">
                <Text color={C.text} bold>Ready for a mission.</Text>
                <Text color={C.dim}>One request in — an engineering org of agents takes it from there.</Text>
                <Text> </Text>
                <Button variant="primary" hotkey="n" label="  n · New mission  " autoFocus onPress={() => void patchUi($, { composing: { kind: 'run' } })} />
                <Text> </Text>
                {nextSeats ? <SeatBar seats={nextSeats} onPick={pickNext} keys efforts={u.efforts} live={false} onEffort={effortNext} note="v / b seats · f / g / w effort · or click" /> : null}
              </Box>
            )}
          </Box>
          {keybar([['n', 'new mission'], ['v b', 'seats'], ['f g w', 'effort'], ['x', 'stop']])}
        </Box>
      )
    }

    // ── run data ──

    const approvals = s.pendingApprovals.filter(a => a.runId === run.id)
    const done = run.tasks.filter(isDone).length
    const live = !TERMINAL.includes(run.status)
    const failed = run.status === 'failed' || run.status === 'rejected'
    const phase = run.status === 'completed' ? STEPS.length : STEPS.findIndex(([, st]) => st.includes(run.status))
    const frac = run.status === 'completed' ? 1 : run.tasks.length ? done / run.tasks.length : phase >= 0 ? phase / STEPS.length : 0
    const runColor = STATUS_COLOR[run.status] ?? C.text
    const fracE = ease('frac', frac)
    const fillE = ease('fill', run.tasks.length ? done / run.tasks.length : 0)
    const pct = Math.round(fracE(anim) * 100)
    const runAttention = approvals.length > 0

    // ── layout: wide = agents | tasks | right; medium = agents strip over tasks | right; narrow = stacked ──

    // wide: projects+agents | mission+log | tasks+focus, then code | terminal | output; medium: two columns; narrow: stacked
    const wide = cols >= 130
    const medium = !wide && cols >= 90
    const agentsW = wide ? 30 : cols
    const rightW = wide ? Math.max(46, Math.floor(cols * 0.3)) : medium ? Math.floor(cols * 0.45) : cols
    const tasksW = wide ? cols - agentsW - rightW : medium ? cols - rightW : cols // the centre column
    const inner = cols - 4 // full-width cards: approvals, the composer
    const tasksIn = tasksW - 4
    const rightIn = rightW - 4
    const runIdx = s.runs.findIndex(r => r.id === run.id)
    const select = (id: string | null) => void patchUi($, x => ({ selectedRun: id, report: x.report?.runId === id ? x.report : null, task: null, mind: null }))
    const tel = run.telemetry

    // activity: events bucketed across the run's own time span
    const times = run.recentEvents.map(ev => Date.parse(ev.ts)).filter(t => !Number.isNaN(t))
    const t0 = Math.min(...times, now), t1 = live ? now : Math.max(...times, t0 + 1)
    const buckets = new Array(32).fill(0) as number[]
    for (const t of times) buckets[Math.min(31, Math.floor(((t - t0) / Math.max(1, t1 - t0)) * 32))]!++
    const bucketE = buckets.map((b, i) => ease(`spark${i}`, b))

    // ── header: one row of aurora, the mission and its vitals ──

    const vitals = () => `⎇ ${run.repositories[0]?.name ?? 'workspace'}   ● ${run.status.replace(/_/g, ' ')}   ${(run.minds ?? []).filter(m => m.status === 'active').length || run.workers.length} agents   ${tel.costUsd ? `$${tel.costUsd.toFixed(2)}   ` : ''}${hms(l.wall)}`
    const header = raster('hero', cols, 1, true, t => paint.hero(cols, 1, t, { online, alert: runAttention, brand: `◎ ${l.brand}`, left: '// MULTI-AGENT CODING COCKPIT', right: vitals() }), (
      <Box justifyContent="space-between" paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold>{[...`◎ ${l.brand}`].map((ch, i) => <Text color={gradient(LOGO_GRADIENT, i / 22 - n / 40)}>{ch}</Text>)}</Text>
          <Text color={C.dim}>  // MULTI-AGENT CODING COCKPIT</Text>
        </Text>
        <Box flexShrink={0}><Text color={C.mute} wrap="truncate-end">{clip(vitals(), Math.max(10, cols - 34))}</Text></Box>
      </Box>
    ))

    const stepNames = STEPS.map(([name]) => name)
    const textStepper = (
      <Text wrap="truncate-end">
        {STEPS.map(([name], i) => (
          <Text color={i < phase ? C.green : i === phase ? runColor : C.faint}>{i < phase ? '●' : i === phase ? '◉' : '○'} {name}{i < STEPS.length - 1 ? ' ─ ' : ''}</Text>
        ))}
      </Text>
    )
    const dividerW = Math.max(1, tasksW - 4)
    const divider = raster('divider', dividerW, 1, live, t => paint.divider(dividerW, 1, t, { color: paint.hex(runAttention ? C.yellow : runColor), active: live || runAttention }), <Text color={C.borderDim}>{'─'.repeat(dividerW)}</Text>)

    // ── approval: the NEEDS YOU strip ──

    const ApprovalCard = ({ a }: { a: CockpitApproval }) => {
      const writing = u.composing?.kind === 'changes' && u.composing.approvalId === a.id
      const text = a.text ?? a.summary
      const total = wrapped(text, inner - 2)
      const opened = u.open.includes(`apr-${a.id}`)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={pulse(n, C.yellow, C.accent, 0.5)} paddingX={1}>
          <Box justifyContent="space-between">
            <Text><Pill label={`${n % 8 < 4 ? '◆' : '◇'} NEEDS YOU`} bg={C.yellow} /> <Text color={C.dim}>{a.kind}{a.operation ? ` · ${a.operation.replace(/_/g, ' ')}` : ''}</Text></Text>
            {writing ? null : (
              <Box gap={1}>
                <Button variant="primary" hotkey="a" key={`approve-${a.id}`} label="a · Approve" autoFocus onPress={() => void decide($, 'approve', a.id, '')} />
                <Button hotkey="c" key={`changes-${a.id}`} label="c · Changes" onPress={() => void patchUi($, { composing: { kind: 'changes', approvalId: a.id } })} />
                <Button hotkey="r" key={`reject-${a.id}`} label="r · Reject" onPress={() => void decide($, 'reject', a.id, '')} />
              </Box>
            )}
          </Box>
          <Text color={C.text} wrap="wrap">{opened || total <= APPROVAL_PREVIEW ? text : clip(text, (inner - 2) * APPROVAL_PREVIEW)}</Text>
          {total > APPROVAL_PREVIEW ? (
            <Button plain dimColor key={`open-apr-${a.id}`} label={opened ? '▴ show less' : `▾ show all (${total - APPROVAL_PREVIEW} more lines)`} onPress={() => void patchUi($, x => ({ open: x.open.includes(`apr-${a.id}`) ? x.open.filter(k => k !== `apr-${a.id}`) : [...x.open, `apr-${a.id}`] }))} />
          ) : null}
          {writing ? (
            <Box flexDirection="column">
              <Input
                key={`changes-${a.id}-${u.nonce}`}
                label="changes › "
                placeholder="What should the team change?"
                submitLabel="send back"
                autoFocus
                onSubmit={(t: string) => {
                  if (!t.trim()) return
                  void patchUi($, x => ({ composing: null, nonce: x.nonce + 1 })).then(() => decide($, 'changes', a.id, t))
                }}
              />
              <Button plain dimColor key="cancel-changes" label="cancel" onPress={() => void patchUi($, { composing: null })} />
            </Box>
          ) : null}
        </Box>
      )
    }
    const approvalRows = approvals.reduce((acc, a) => {
      const total = wrapped(a.text ?? a.summary, inner - 2)
      return acc + 3 + (u.open.includes(`apr-${a.id}`) ? total : Math.min(total, APPROVAL_PREVIEW)) + (total > APPROVAL_PREVIEW ? 1 : 0)
    }, 0)

    // ── open/close rows, shared by every list ──

    const isOpen = (id: string) => u.open.includes(id)
    const toggle = (id: string) => void patchUi($, x => ({ open: x.open.includes(id) ? x.open.filter(k => k !== id) : [...x.open.slice(-40), id] }))
    const Fold = ({ id }: { id: string }) => (
      <Box flexShrink={0} marginRight={1}>
        <Button plain dimColor={!isOpen(id)} key={`open-${id}`} label={isOpen(id) ? '▾' : '▸'} onPress={() => toggle(id)} />
      </Box>
    )

    // ── agents: the seats and the workers, each with what it is doing now ──

    const roles = run.roles ?? s.hierarchy
    const minds = run.minds ?? []
    type AgentRow = { id: string; orb: string | null; name: string; role: 'supervisor' | 'lead' | 'worker'; active: boolean; mind: CockpitMind | null; task: string | null; since: string | null }
    const latestOf = (role: string, agent: string) => minds.find(m => m.role === role && m.agentId === agent && m.status === 'active') ?? minds.find(m => m.role === role && m.agentId === agent) ?? null
    const supMind = latestOf('supervisor', roles.supervisor)
    const leadMind = latestOf('lead', roles.lead)
    const agentRows: AgentRow[] = [
      { id: 'sup', orb: 'orb-sup', name: roles.supervisor, role: 'supervisor', active: run.leadership.supervisor !== 'idle', mind: supMind, task: supMind?.status === 'active' ? supMind.task : null, since: supMind?.status === 'active' ? supMind.startedAt : null },
      { id: 'lead', orb: 'orb-lead', name: roles.lead, role: 'lead', active: run.leadership.lead !== 'idle', mind: leadMind, task: leadMind?.status === 'active' ? leadMind.task : null, since: leadMind?.status === 'active' ? leadMind.startedAt : null },
      ...run.workers.map((w, i): AgentRow => {
        const m = minds.find(x => x.role === 'worker' && x.status === 'active' && x.task === w.task) ?? null
        return { id: `w${i}`, orb: `orb-w${i}`, name: w.agentId, role: 'worker', active: true, mind: m, task: w.task, since: w.since }
      }),
    ]
    // Earlier sessions, newest first: selectable to read back what they did.
    const shownMinds = new Set(agentRows.map(r => r.mind?.sessionId).filter(Boolean))
    const earlier = minds.filter(m => m.status !== 'active' && !shownMinds.has(m.sessionId)).slice(0, 6)
    const pickable: { mind: CockpitMind | null; id: string }[] = [...agentRows.map(r => ({ mind: r.mind, id: r.id })), ...earlier.map(m => ({ mind: m, id: m.sessionId }))].filter(p => p.mind)
    const followed = minds.find(m => m.sessionId === u.mind) ?? minds.find(m => m.status === 'active') ?? minds[0] ?? null
    const selAgent = Math.max(0, pickable.findIndex(p => p.mind && p.mind.sessionId === followed?.sessionId))
    const followMind = (m: CockpitMind | null) => void patchUi($, { mind: m?.sessionId ?? null, focus: 'agents' })

    const AgentCard = ({ r, compactCard }: { r: AgentRow; compactCard?: boolean }) => {
      const color = ROLE_COLOR[r.role] ?? C.text
      const picked = !!r.mind && r.mind.sessionId === followed?.sessionId
      const focused = picked && u.focus === 'agents'
      const doingNow = r.mind && r.mind.status === 'active' ? `${doing(r.mind)}${r.task ? ` ${r.task}` : ''}` : r.active ? `working${r.task ? ` on ${r.task}` : ''}` : 'idle'
      const lastWords = r.mind ? [...r.mind.activity].reverse().find(a => a.kind !== 'tool')?.text : undefined
      return (
        <Box key={`agent-${r.id}`} width={compactCard ? 30 : undefined} hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Text color={focused ? C.accent : picked ? C.dim : C.bgDeep}>▌</Text>
          <Box flexDirection="column" marginRight={1}>
            <Text backgroundColor={r.active ? pulse(n, color, C.white, 0.25) : C.chip} color={r.active ? C.bgDeep : color} bold> {r.role === 'supervisor' ? 'S' : r.role === 'lead' ? 'L' : 'W'} </Text>
            <Text color={r.active ? color : C.faint}>{r.active ? ` ${SPIN[(n + agentRows.indexOf(r)) % SPIN.length]} ` : ' · '}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            <Box justifyContent="space-between">
              <Button plain dimColor={!picked} key={`agent-pick-${r.id}`} label={`${r.name} · ${r.role}`} onPress={() => followMind(r.mind)} />
              <Text color={r.active ? color : C.faint}>{r.since ? ago(now - Date.parse(r.since)) : ''}</Text>
            </Box>
            <Text color={r.active ? color : C.dim} wrap="truncate-end">{compactCard || !lastWords ? doingNow : `${doingNow} · ${firstLine(lastWords)}`}</Text>
          </Box>
        </Box>
      )
    }
    const EarlierRow = ({ m }: { m: CockpitMind }) => {
      const picked = m.sessionId === followed?.sessionId
      return (
        <Box key={`earlier-${m.sessionId}`} hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Text color={picked && u.focus === 'agents' ? C.accent : C.bgDeep}>▌</Text>
          <Text color={m.status === 'failed' ? C.red : C.faint}>{m.status === 'failed' ? '✗' : '✓'} </Text>
          <Button plain dimColor key={`agent-pick-${m.sessionId}`} label={clip(`${m.agentId} ${m.role} ${m.task ?? ''} ${doing(m)}`, agentsW - 8)} onPress={() => followMind(m)} />
        </Box>
      )
    }
    const SeatLines = ({ seats, isLive }: { seats: Seats; isLive: boolean }) => {
      const efforts = isLive ? run.efforts ?? {} : u.efforts
      const levelOf = (role: Role | 'worker', id: string) => efforts[`${role}:${id}`] ?? efforts[id] ?? agentInfo(id)?.effort ?? null
      const ring = (id: string, level: string | null) => {
        const levels = levelsOf(id)
        const all: (string | null)[] = isLive ? levels : [null, ...levels]
        return all[(all.indexOf(level) + 1) % Math.max(1, all.length)] ?? null
      }
      const setLevel = (changes: Record<string, string | null>) =>
        isLive ? void setEffort($, run.id, Object.fromEntries(Object.entries(changes).filter((kv): kv is [string, string] => kv[1] !== null))) : effortNext(changes)
      const pick = (role: Role, agent: string) => (isLive ? void setSeat($, run.id, role, agent) : pickNext(role, agent))
      const line = (role: Role, glyphs: string, tone: string, seatKey: string, effortKey: string) => {
        const current = seats[role]
        const other = seats[role === 'supervisor' ? 'lead' : 'supervisor']
        const choices = eligible(role).map(a => a.id).filter(id => id !== other)
        const next = choices[(choices.indexOf(current) + 1) % Math.max(1, choices.length)]
        const level = levelOf(role, current)
        return (
          <Box>
            <Text color={tone} bold>{glyphs} </Text>
            {next && next !== current
              ? <Button plain hotkey={seatKey} key={`cycle-${role}`} label={current} onPress={() => pick(role, next)} />
              : <Text color={C.text}>{current}</Text>}
            <Text color={C.faint}>  </Text>
            {levelsOf(current).length ? <Button plain hotkey={effortKey} dimColor={!level} key={`effort-${role}:${current}`} label={level ?? 'default'} onPress={() => setLevel({ [`${role}:${current}`]: ring(current, level) })} /> : null}
          </Box>
        )
      }
      const workers = eligible('worker' as Role)
      const w0 = workers[0]
      const wLevel = w0 ? levelOf('worker', w0.id) : null
      return (
        <Box flexDirection="column">
          {line('supervisor', '◆', C.violet, 'v', 'f')}
          {line('lead', '◇', C.cyan, 'b', 'g')}
          {w0 ? (
            <Box>
              <Text color={C.green} bold>◈ </Text>
              <Text color={C.text}>{clip(workers.map(w => w.id).join('·'), 12)}</Text>
              <Text color={C.faint}>  </Text>
              <Button plain hotkey="w" dimColor={!wLevel} key={`effort-worker:${w0.id}`} label={wLevel ?? 'default'} onPress={() => {
                const lv = ring(w0.id, wLevel)
                setLevel(Object.fromEntries(workers.filter(w => lv === null || levelsOf(w.id).includes(lv)).map(w => [`worker:${w.id}`, lv])))
              }} />
            </Box>
          ) : null}
        </Box>
      )
    }
    const seatsLive = (
      <SeatBar
        compact
        seats={roles}
        onPick={(role, agent) => void setSeat($, run.id, role, agent)}
        keys
        efforts={run.efforts ?? {}}
        live={live}
        onEffort={changes => void setEffort($, run.id, Object.fromEntries(Object.entries(changes).filter((kv): kv is [string, string] => kv[1] !== null)))}
        note=""
      />
    )
    const byAgent = tel.byAgent ?? []
    const maxCost = Math.max(0.01, ...byAgent.map(a => a.costUsd || a.calls / 100))
    const meterW = Math.max(4, Math.min(agentsW, 44) - 6)
    const meterColors = [K.cyan, K.violet, K.green, K.yellow, K.pink]
    const meterE = byAgent.map((a, i) => ease(`meter${i}`, (a.costUsd || a.calls / 100) / maxCost))
    const meterText = byAgent.map((a, i) => {
      const w = Math.max(1, Math.round(meterE[i]!(anim) * (meterW - 16)))
      return (
        <Text wrap="truncate-end">
          <Text color={C.mute}>{a.agentId.padEnd(7).slice(0, 7)} </Text>
          <Text color={C.faint}>▕</Text>
          {Array.from({ length: w }, (_, k) => <Text color={gradient(LOGO_GRADIENT, i / 5 + k / (meterW * 4))}>█</Text>)}
          <Text color={C.borderDim}>{'█'.repeat(Math.max(0, meterW - 16 - w))}</Text>
          <Text color={C.faint}>▏</Text>
          <Text color={C.dim}> {a.costUsd ? `$${a.costUsd.toFixed(2)}` : `${a.calls}`}</Text>
        </Text>
      )
    })
    const barColors = [C.cyan, C.violet, C.green, C.yellow, C.pink]
    const meterBars = byAgent.map((a, i) => {
      const w = Math.max(4, meterW - 15)
      const bar = smoothBar(meterE[i]!(anim), w)
      return (
        <Text wrap="truncate-end">
          <Text color={C.mute}>{a.agentId.padEnd(7).slice(0, 7)} </Text>
          <Text color={C.faint}>▕</Text>
          <Text color={barColors[i % barColors.length]}>{bar.fill}</Text>
          <Text color={C.track}>{bar.rest}</Text>
          <Text color={C.faint}>▏</Text>
          <Text color={C.dim}> {a.costUsd ? `$${a.costUsd.toFixed(2)}` : `${a.calls} calls`}</Text>
        </Text>
      )
    })
    const Section = ({ title, right }: { title: string; right?: RenderChildren }) => (
      <Box justifyContent="space-between" marginTop={1}>
        <Text color={C.mute} bold>{title}</Text>
        {right ?? null}
      </Box>
    )

    // ── missions: every run at a glance; a press (or m) switches ──

    const MISSION_ROWS = 6
    const missionRows = s.runs.slice(0, MISSION_ROWS)
    const waiting = (id: string) => s.pendingApprovals.some(a => a.runId === id)
    const missionTitle = (
      <Box justifyContent="space-between">
        <Text color={C.mute} bold>MISSIONS <Text color={C.dim}>mission {runIdx + 1}/{s.runs.length}</Text></Text>
        {s.runs.length > 1 ? <Button plain dimColor hotkey="m" key="next" label="next" onPress={() => select(s.runs[(runIdx + 1) % s.runs.length]!.id)} /> : null}
      </Box>
    )
    const MissionRow = ({ r }: { r: CockpitRun }) => {
      const picked = r.id === run.id
      const rc = STATUS_COLOR[r.status] ?? C.text
      const rd = r.tasks.filter(isDone).length
      const meta = `${r.tasks.length ? `${rd}/${r.tasks.length}` : r.status.replace(/_/g, ' ')}`
      return (
        <Box key={`row-${r.id}`} justifyContent="space-between" hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Box flexShrink={1}>
            <Text color={picked ? C.accent : C.bgDeep}>▌</Text>
            <Text color={MOVING.has(r.status) ? pulse(n, rc, C.white, 0.4) : rc}>{glyph(r.status, n)} </Text>
            <Button plain dimColor={!picked} key={`pick-${r.id}`} label={clip(firstLine(r.request), Math.max(8, agentsW - 14 - meta.length))} onPress={() => select(r.id)} />
          </Box>
          <Text>
            {waiting(r.id) ? <Text color={pulse(n, C.yellow, C.accent, 0.5)}>● </Text> : null}
            <Text color={C.dim}>{meta}</Text>
          </Text>
        </Box>
      )
    }
    const missionsH = wide ? Math.min(s.runs.length, MISSION_ROWS) + (s.runs.length > MISSION_ROWS ? 1 : 0) + 3 : 0
    const missionsPanel = wide ? (
      <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} width={agentsW} height={missionsH} overflow="hidden">
        {missionTitle}
        {missionRows.map(r => <MissionRow r={r} />)}
        {s.runs.length > MISSION_ROWS ? <Text color={C.dim}>  … {s.runs.length - MISSION_ROWS} older (dashboard lists all)</Text> : null}
      </Box>
    ) : (
      <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1}>
        {missionTitle}
        <Box flexWrap="wrap" gap={1}>
          {missionRows.map(r => {
            const picked = r.id === run.id
            return (
              <Box key={`chip-${r.id}`} backgroundColor={picked ? C.chipOn : undefined} paddingX={1} hover={{ backgroundColor: C.hover }}>
                <Text color={STATUS_COLOR[r.status] ?? C.text}>{glyph(r.status, n)} </Text>
                <Button plain dimColor={!picked} key={`pick-${r.id}`} label={clip(firstLine(r.request), 26)} onPress={() => select(r.id)} />
                {waiting(r.id) ? <Text color={pulse(n, C.yellow, C.accent, 0.5)}> ●</Text> : null}
              </Box>
            )
          })}
        </Box>
      </Box>
    )

    // ── body height: what the header, the strips and the footer leave ──

    const chrome = 1 + 2 + 1 + 2 + approvalRows + (u.failure ? 5 : 0) + (u.composing?.kind === 'run' ? 9 : 0) + (run.error ? 1 : 0)
    const agentsStripH = wide ? 0 : 4 + (agentRows.length > Math.max(1, Math.floor((cols - 4) / 30)) ? 2 : 0) + (tel.byAgent?.length ?? 0)
    const missionsStripH = wide ? 0 : 3 + Math.ceil(missionRows.length / Math.max(1, Math.floor((cols - 4) / 32)))
    const bodyH = Math.max(12, rows - chrome - agentsStripH - missionsStripH)

    const agentsStrip = (
      <Box flexDirection="column" borderStyle="round" borderColor={u.focus === 'agents' ? C.violet : C.border} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={u.focus === 'agents' ? C.violet : C.accent} bold>AGENTS</Text>
          <Text color={C.yellow} bold>{tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : ''}</Text>
        </Box>
        <Box flexWrap="wrap">{agentRows.map(r => <AgentCard r={r} compactCard />)}</Box>
        {live && u.composing?.kind !== 'run' ? seatsLive : null}
        {byAgent.length ? <Box flexDirection="column" width={Math.min(cols - 4, meterW + 2)}>{meterBars}</Box> : null}
      </Box>
    )

    // ── tasks: grouped by what they need, the selected one always in view ──

    const GROUPS: [string, string, (t: CockpitTask) => boolean, boolean][] = [
      ['attention', 'NEEDS ATTENTION', t => ['failed', 'lease_conflict', 'needs_input', 'escalated', 'changes_requested'].includes(t.status), false],
      ['running', 'RUNNING', t => t.status === 'running' || t.status === 'validating', false],
      ['review', 'IN REVIEW', t => t.status === 'in_review', false],
      ['queued', 'QUEUED', t => t.status === 'pending' || t.status === 'ready', false],
      ['done', 'DONE', t => isDone(t), true],
      ['cancelled', 'CANCELLED', t => t.status === 'cancelled', true],
    ]
    type Item = { kind: 'group'; id: string; label: string; count: number; folded: boolean } | { kind: 'task'; t: CockpitTask }
    const items: Item[] = []
    const ordered: CockpitTask[] = []
    for (const [id, label, test, foldable] of GROUPS) {
      // Keys carry the round (TASK-3xx): finished work newest first, the rest in plan order.
      const list = run.tasks.filter(test).sort((a, b) => (foldable ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)))
      if (!list.length) continue
      const folded = foldable && !isOpen(`grp-${id}`)
      items.push({ kind: 'group', id, label, count: list.length, folded })
      if (!folded) for (const t of list) items.push({ kind: 'task', t }), ordered.push(t)
    }
    const selTask = run.tasks.find(t => t.key === u.task) ?? ordered[0] ?? run.tasks[0] ?? null
    const pickTask = (t: CockpitTask | undefined) => t && void patchUi($, { task: t.key, focus: 'tasks' })
    const listH = bodyH - 3
    const selRow = Math.max(0, items.findIndex(i => i.kind === 'task' && i.t.key === selTask?.key))
    const start = Math.max(0, Math.min(selRow - Math.floor(listH / 2), items.length - listH))
    const visible = items.slice(start, start + listH)
    const TaskLine = ({ t }: { t: CockpitTask }) => {
      const color = STATUS_COLOR[t.status] ?? C.text
      const moving = MOVING.has(t.status)
      const fin = isDone(t) || t.status === 'cancelled'
      const picked = t.key === selTask?.key
      const meta = [t.agentId, t.iteration > 1 ? `↺${t.iteration}` : '', t.dependsOn.length && !fin ? `⇠${t.dependsOn.join(',')}` : ''].filter(Boolean).join(' ')
      return (
        <Box key={`task-${t.key}`} justifyContent="space-between" hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Box flexShrink={1}>
            <Text color={picked && u.focus === 'tasks' ? C.accent : picked ? C.dim : C.bgDeep}>▌</Text>
            <Text color={moving ? pulse(n, color, C.white, 0.5) : color}>{glyph(t.status, n)} </Text>
            <Button plain dimColor={fin && !picked} key={`task-pick-${t.key}`} label={clip(`${t.key}  ${t.title}`, Math.max(12, tasksIn - 6 - Math.min(22, meta.length + 1)))} onPress={() => pickTask(t)} />
          </Box>
          <Text color={C.dim}>{meta ? ` ${clip(meta, 22)}` : ''}</Text>
        </Box>
      )
    }
    // ── right panel: the followed agent live, the selected task, the event log or the report ──

    const Label = ({ text }: { text: string }) => <Text color={C.dim} bold>{text}</Text>
    const TaskDetail = ({ t }: { t: CockpitTask }) => {
      const d = t.detail
      const color = STATUS_COLOR[t.status] ?? C.text
      const verdictColor = d?.review ? (d.review.verdict === 'approve' ? C.green : d.review.verdict === 'escalate' ? C.yellow : C.red) : C.dim
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end"><Pill label={t.status.replace(/_/g, ' ')} bg={color} /><Text color={C.ink} bold> {t.key}</Text><Text color={C.dim}>  {[t.agentId, t.iteration > 1 ? `${t.iteration} tries` : '', t.repo].filter(Boolean).join(' · ')}</Text></Text>
          <Text color={C.ink} bold wrap="wrap">{t.title}</Text>
          {t.dependsOn.length ? <Text color={C.dim} wrap="truncate-end">after {t.dependsOn.join(', ')}</Text> : null}
          {t.blockedReason ? <Text color={C.yellow} wrap="wrap">↳ {t.blockedReason}</Text> : null}
          {!d ? <Text color={C.dim}>No details for this task yet.</Text> : (
            <Box flexDirection="column">
              <Text> </Text>
              <Text color={C.text} wrap="wrap">{d.description}</Text>
              <Text color={C.dim} wrap="wrap">{d.kind} · risk {d.risk} · complexity {d.complexity} · tests {d.testsRequired ? (d.testCommand ?? 'repo default') : 'not required'}</Text>
              {d.acceptanceCriteria.length ? <Section title="ACCEPTANCE" /> : null}
              {d.acceptanceCriteria.map(c => <Box><Text color={C.green}>✓ </Text><Box flexShrink={1}><Text color={C.text} wrap="wrap">{c}</Text></Box></Box>)}
              {d.scope.files.length + d.scope.modules.length + d.scope.resources.length ? <Section title="SCOPE" /> : null}
              {d.scope.files.map(f => <Text color={C.mute} wrap="truncate-end">◦ {f}</Text>)}
              {d.scope.modules.map(m => <Text color={C.mute} wrap="truncate-end">▣ {m}</Text>)}
              {d.scope.resources.map(r => <Text color={C.yellow} wrap="truncate-end">⛁ {r}</Text>)}
              {d.summary ? <Section title="WORKER" /> : null}
              {d.summary ? <Text color={C.text} wrap="wrap">{d.summary}</Text> : null}
              {d.review ? <Box marginTop={1}><Label text={`REVIEW it${d.review.iteration} `} /><Text color={verdictColor} bold>{d.review.verdict.replace(/_/g, ' ')}</Text></Box> : null}
              {d.review ? <Text color={C.text} wrap="wrap">{d.review.summary}</Text> : null}
              {d.review?.issues.map(i => (
                <Box>
                  <Text color={i.severity === 'blocker' ? C.red : i.severity === 'major' ? C.yellow : C.dim}>✗ {i.severity.padEnd(7)} </Text>
                  <Box flexShrink={1}><Text color={C.text} wrap="wrap">{i.file ? `${i.file}: ` : ''}{i.description}</Text></Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const thinkingNow = minds.filter(m => m.status === 'active').length
    const liveView = (): RenderChildren => {
      if (!followed) return <Text color={C.dim}>{live ? `${SPIN[n % SPIN.length]} no model has spoken yet…` : 'No model ran in this mission.'}</Text>
      const color = ROLE_COLOR[followed.role] ?? C.text
      const active = followed.status === 'active'
      const end = followed.endedAt ? Date.parse(followed.endedAt) : now
      const width = Math.max(20, rightIn - 14)
      const cap = { thinking: 4, text: 6, tool: 1, result: 10 } as const
      const entryId = (e: CockpitMind['activity'][number]) => `mind-${followed.sessionId}-${e.ts}-${e.kind}-${e.text.length}`
      const entries = [...followed.activity].reverse()
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Pill label={followed.role.toUpperCase()} bg={color} />
              <Text color={C.ink} bold> {followed.agentId}</Text>
              <Text color={C.text}>  {doing(followed)}{followed.task ? ` ${followed.task}` : ''}</Text>
              {followed.effort ? <Text color={C.dim}>  ⚡{followed.effort}</Text> : null}
            </Text>
            <Text color={active ? color : C.dim}>{active ? `${SPIN[n % SPIN.length]} live ` : `${followed.status} `}{ago(end - Date.parse(followed.startedAt))}</Text>
          </Box>
          {entries.length ? entries.map((e, k) => {
            const fresh = Math.max(0, 1 - (now - Date.parse(e.ts)) / 8000)
            const opened = isOpen(entryId(e))
            const lines = opened ? 999 : e.kind === 'tool' ? 1 : cap[e.kind]
            const stamp = <Box flexShrink={0}><Fold id={entryId(e)} /><Text color={C.faint}>{e.ts.slice(11, 19)} </Text></Box>
            if (e.kind === 'tool') {
              const at = e.text.indexOf(': ')
              const name = at > 0 ? e.text.slice(0, at) : e.text
              const arg = at > 0 ? e.text.slice(at + 2) : ''
              return opened ? (
                <Box>{stamp}<Text color={mix(C.cyan, C.white, fresh * 0.6)}>{name} </Text><Box flexShrink={1}><Text color={C.text} wrap="wrap">{arg}</Text></Box></Box>
              ) : (
                <Box>{stamp}<Text wrap="truncate-end"><Text color={mix(C.cyan, C.white, fresh * 0.6)}>{name}</Text><Text color={C.mute}>  {toolDetail(arg)}</Text></Text></Box>
              )
            }
            if (e.kind === 'result') {
              // The call's conclusion keeps its own line breaks: a plan's tasks, a review's issues.
              const shown = opened ? e.text.trim().split('\n') : e.text.trim().split('\n').slice(0, lines)
              const more = e.text.trim().split('\n').length - shown.length
              return (
                <Box flexDirection="column" marginBottom={1}>
                  <Box>{stamp}<Text color={C.accent} bold>✦ </Text><Box flexShrink={1}><Text color={C.ink} bold wrap="wrap">{shown[0]}</Text></Box></Box>
                  {shown.slice(1).map(l => <Box paddingLeft={14}><Text color={C.text} wrap="wrap">{l}</Text></Box>)}
                  {more > 0 ? <Box paddingLeft={14}><Text color={C.dim}>… {more} more (▸ opens)</Text></Box> : null}
                </Box>
              )
            }
            const body = opened ? e.text.trim() : clip(e.text.trim().replace(/\s*\n\s*/g, ' ⏎ '), lines * width)
            return e.kind === 'thinking' ? (
              <Box>{stamp}<Text color={mix(C.violet, C.white, fresh * 0.5)}>{k === 0 && active ? ORBIT[Math.floor(n / 2) % 4] : '∴'} </Text><Box flexShrink={1}><Text color={mix(C.thinkDim, C.violet, fresh)} italic wrap="wrap">{body}</Text></Box></Box>
            ) : (
              <Box>{stamp}<Text color={color}>▍ </Text><Box flexShrink={1}><Text color={mix(C.text, C.white, fresh)} wrap="wrap">{body}</Text></Box></Box>
            )
          }) : <Text color={C.dim}>{active ? `${SPIN[n % SPIN.length]} waiting for the first words…` : 'It produced no visible output.'}</Text>}
        </Box>
      )
    }
    const eventsView = (): RenderChildren => {
      const evId = (ev: CockpitRun['recentEvents'][number]) => `ev-${ev.ts}-${ev.type}`
      const evs = [...run.recentEvents].reverse()
      return evs.length ? evs.map((ev, i) => {
        const fresh = Math.max(0, 1 - (now - Date.parse(ev.ts)) / 6000)
        const c = eventColor(ev.type)
        return (
          <Box flexDirection="column" key={evId(ev)}>
            <Box>
              <Fold id={evId(ev)} />
              <Text wrap="truncate-end">
                <Text color={mix(C.dim, C.white, fresh)}>{ev.ts.slice(11, 19)} </Text>
                <Text color={mix(c, C.white, fresh * 0.6)}>{i === 0 && live ? glyph('running', n) : '●'} </Text>
                <Text color={mix(c, C.white, fresh * 0.6)} bold>{ev.type}</Text>
                <Text color={mix(C.mute, C.text, fresh)}>  {ev.text === ev.type ? '' : ev.text}</Text>
              </Text>
            </Box>
            {isOpen(evId(ev)) ? <Box paddingLeft={13}><Text color={C.text} wrap="wrap">{ev.detail ?? ev.text}</Text></Box> : null}
          </Box>
        )
      }) : <Text color={C.dim}>No events yet.</Text>
    }

    const views: [CockpitTab, string, string][] = [
      ['live', 'Log', thinkingNow ? ` ${SPIN[n % SPIN.length]}${thinkingNow}` : ''],
      ['task', 'Task', selTask ? ` ${selTask.key}` : ''],
      ['events', 'Events', ` ${run.recentEvents.length}`],
      ['report', 'Report', ''],
    ]
    const showView = (id: CockpitTab) => (id === 'report' && u.report?.runId !== run.id ? void loadReport($, run.id) : void patchUi($, { tab: id }))
    const tabW = views.map(([, label, badge]) => label.length + badge.length + 5)
    const tabIdx = Math.max(0, views.findIndex(([id]) => id === u.tab))
    const tabE = ease('tab', tabIdx, 220)
    tabE(anim) // retarget now so `easing` sees it
    let used = 0
    const underlineText = (
      <Text>
        {views.map(([id], i) => {
          const w = Math.max(0, Math.min(tabW[i]!, tasksIn - used))
          used += w
          return <Text color={id === u.tab ? C.accent : C.borderDim}>{'▔'.repeat(w)}</Text>
        })}
        <Text color={C.borderDim}>{'▔'.repeat(Math.max(0, tasksIn - used))}</Text>
      </Text>
    )
    const underline = raster('tab-underline', tasksIn, 1, easing('tab'), t => paint.underline(tasksIn, 1, t, { tabs: tabW, active: tabE(t), color: K.accent }), underlineText)
    // ── the mockup's panels: mission header + unified log, task list with stages, agent focus, code, terminal, output ──

    const SPEC_COLOR: Record<string, string> = {
      backend: C.orange, frontend: C.blue, test: C.pink, database: C.yellow, security: C.red, performance: C.yellow,
      documentation: C.text, refactoring: C.violet, research: C.cyan, generalist: C.mint,
    }
    const specOf = (key: string | null | undefined) => run.tasks.find(t => t.key === key)?.specialty ?? null
    const tagOf = (role: string, task: string | null) => (role === 'supervisor' ? 'SUPER' : role === 'lead' ? 'LEAD' : (specOf(task) ?? 'worker').toUpperCase().slice(0, 8))
    const tagColor = (role: string, task: string | null) => (role === 'supervisor' ? C.violet : role === 'lead' ? C.cyan : SPEC_COLOR[specOf(task) ?? ''] ?? C.orange)
    const toolIcon = (name: string) => (/^(read|glob|grep|ls)$/i.test(name) ? '◎' : /^(edit|write|multiedit|apply_patch)$/i.test(name) ? '✎' : /^(bash|shell|powershell)$/i.test(name) ? '❯' : /^web/i.test(name) ? '⌕' : '•')
    const Panel = ({ title, right, children, width, height, color, grow }: { title: RenderChildren; right?: RenderChildren; children: RenderChildren; width?: number; height?: number; color?: string; grow?: boolean }) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color ?? C.border} paddingX={1} width={width} height={height} flexGrow={grow ? 1 : 0} overflow="hidden">
        <Box justifyContent="space-between">
          {typeof title === 'string' ? <Text color={C.accent} bold>{title}</Text> : title}
          {right ?? null}
        </Box>
        {children}
      </Box>
    )

    // The unified log: every session's words, tools and outcomes with the orchestrator's milestones, newest on top.
    type LogLine = { ts: string; tag: string; color: string; text: string; tone: 'text' | 'thinking' | 'tool' | 'result' | 'ok' | 'bad' | 'sys' }
    const MILESTONES = /^(task\.(created|assigned|blocked|completed|failed)|test\.(passed|failed)|review\.(passed|issue_found)|integration\.|merge\.|approval\.|escalation\.|proposal\.|validation\.|plan\.|run\.(started|completed))/
    const logLines: LogLine[] = []
    for (const m of minds) {
      const tag = tagOf(m.role, m.task), color = tagColor(m.role, m.task)
      for (const a of m.activity) {
        if (a.kind === 'tool') {
          const at = a.text.indexOf(': ')
          const name = at > 0 ? a.text.slice(0, at) : a.text
          logLines.push({ ts: a.ts, tag, color, tone: 'tool', text: `${toolIcon(name)} ${name} ${toolDetail(at > 0 ? a.text.slice(at + 2) : '')}` })
        } else logLines.push({ ts: a.ts, tag, color, tone: a.kind, text: a.text.trim().replace(/\s*\n\s*/g, ' ⏎ ') })
      }
    }
    for (const ev of run.recentEvents) {
      if (!MILESTONES.test(ev.type)) continue
      const tone: LogLine['tone'] = /passed|completed|accepted|merge\./.test(ev.type) ? 'ok' : /failed|issue_found|blocked|rejected/.test(ev.type) ? 'bad' : 'sys'
      logLines.push({ ts: ev.ts, tag: 'ORCH', color: C.accent, tone, text: ev.text })
    }
    logLines.sort((a, b) => b.ts.localeCompare(a.ts))
    const LogView = ({ max }: { max: number }) => (
      <Box flexDirection="column">
        {logLines.length ? logLines.slice(0, max).map((ln, i) => {
          const fresh = Math.max(0, 1 - (now - Date.parse(ln.ts)) / 8000)
          const mark = ln.tone === 'ok' || ln.tone === 'result' ? '✔ ' : ln.tone === 'bad' ? '✗ ' : ln.tone === 'thinking' ? '∴ ' : ''
          const color = ln.tone === 'ok' || ln.tone === 'result' ? C.green : ln.tone === 'bad' ? C.red : ln.tone === 'thinking' ? C.thinkDim : ln.tone === 'tool' ? C.mute : ln.tone === 'sys' ? C.text : mix(C.text, C.white, fresh)
          return (
            <Text wrap="truncate-end">
              <Text color={i === 0 && live ? C.accent : C.dim}>{ln.ts.slice(11, 19)} </Text>
              <Text color={ln.color}>[{ln.tag.padEnd(8)}]</Text>
              <Text color={color} italic={ln.tone === 'thinking'} bold={ln.tone === 'result'}> {mark}{ln.text}</Text>
            </Text>
          )
        }) : <Text color={C.dim}>{live ? `${SPIN[n % SPIN.length]} waiting for the first move…` : 'Nothing logged for this mission.'}</Text>}
      </Box>
    )

    // Which task the focus, code and terminal panels show: the followed agent's, else the selected one.
    const focusTask = run.tasks.find(t => t.key === (u.focus === 'tasks' ? selTask?.key : followed?.task ?? selTask?.key)) ?? selTask

    // Task rows: the specialty's ring, the title, its tag and how far through the pipeline it is.
    const STAGE: Record<string, [number, string]> = {
      pending: [0, 'queued'], ready: [0.05, 'ready'], running: [0.35, 'build'], needs_input: [0.35, 'asks'], lease_conflict: [0.35, 'conflict'],
      changes_requested: [0.45, 'rework'], escalated: [0.5, 'escalated'], validating: [0.6, 'test'], in_review: [0.8, 'review'],
      approved: [0.95, 'approved'], integrated: [1, 'done'], failed: [1, 'failed'], cancelled: [0, 'cancelled'],
    }
    const TaskRow = ({ t, w }: { t: CockpitTask; w: number }) => {
      const spec = t.specialty ?? 'task'
      const color = SPEC_COLOR[spec] ?? C.text
      const [frac, stage] = STAGE[t.status] ?? [0, t.status]
      const picked = t.key === selTask?.key
      const moving = MOVING.has(t.status)
      const ring = isDone(t) ? '✓' : t.status === 'failed' ? '✗' : t.status === 'cancelled' ? '–' : moving ? '●' : t.status === 'in_review' ? '◉' : '○'
      const barW = 8
      const bar = smoothBar(frac, barW)
      const barColor = t.status === 'failed' ? C.red : isDone(t) ? C.green : moving ? pulse(n, C.accent, C.mint, 0.4) : C.accent
      const titleW = Math.max(8, w - barW - spec.length - 17)
      return (
        <Box key={`task-${t.key}`} justifyContent="space-between" hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Box flexShrink={1}>
            <Text color={picked && u.focus === 'tasks' ? C.accent : C.bgDeep}>▌</Text>
            <Text color={t.status === 'failed' ? C.red : isDone(t) ? C.green : moving ? pulse(n, color, C.white, 0.4) : color}>{ring} </Text>
            <Button plain dimColor={(isDone(t) || t.status === 'cancelled') && !picked} key={`task-pick-${t.key}`} label={clip(t.title, titleW)} onPress={() => pickTask(t)} />
          </Box>
          <Text>
            <Text color={color}> {spec} </Text>
            <Text color={C.faint}>▕</Text><Text color={barColor}>{bar.fill}</Text><Text color={C.track}>{bar.rest}</Text><Text color={C.faint}>▏</Text>
            <Text color={C.dim}> {stage.padEnd(8).slice(0, 8)}</Text>
          </Text>
        </Box>
      )
    }
    const taskOrder = [
      ...run.tasks.filter(t => ['failed', 'lease_conflict', 'needs_input', 'escalated', 'changes_requested'].includes(t.status)),
      ...run.tasks.filter(t => t.status === 'running' || t.status === 'validating'),
      ...run.tasks.filter(t => t.status === 'in_review'),
      ...run.tasks.filter(t => t.status === 'pending' || t.status === 'ready'),
    ]
    const finished = run.tasks.filter(t => isDone(t) || t.status === 'cancelled').sort((a, b) => b.key.localeCompare(a.key))
    const showDone = isOpen('grp-done')
    const TaskList = ({ w, max }: { w: number; max: number }) => {
      const rows = [...taskOrder, ...(showDone ? finished : finished.slice(0, Math.max(0, max - taskOrder.length - 1)))]
      const selAt = Math.max(0, rows.findIndex(t => t.key === selTask?.key))
      const begin = Math.max(0, Math.min(selAt - Math.floor(max / 2), rows.length - max))
      const hidden = finished.length - (showDone ? finished.length : Math.max(0, max - taskOrder.length - 1))
      return (
        <Box flexDirection="column">
          {run.tasks.length === 0 ? <Text color={C.violet}>{ORBIT[Math.floor(n / 2) % 4]} {live ? 'the lead is drafting the task graph…' : 'no tasks'}</Text> : null}
          {rows.slice(begin, begin + max).map(t => <TaskRow t={t} w={w} />)}
          {finished.length && (hidden > 0 || showDone) ? <Button plain dimColor key="open-grp-done" label={showDone ? '▾ hide finished' : `▸ ${hidden} more finished`} onPress={() => toggle('grp-done')} /> : null}
        </Box>
      )
    }

    // Agent focus: the followed agent's state and the files its task changed (M / A / D from the worktree).
    const FILE_COLOR: Record<string, string> = { M: C.yellow, A: C.green, D: C.red, R: C.cyan }
    const shortPath = (p: string, w: number) => (p.length <= w ? p : `…${p.slice(p.length - w + 1)}`)
    const FocusBody = ({ w, max }: { w: number; max: number }) => {
      const files = focusTask?.live?.files ?? []
      const scope = focusTask?.detail?.scope.files ?? []
      return (
        <Box flexDirection="column">
          {focusTask ? <Text color={C.dim} wrap="truncate-end">{focusTask.key} · {focusTask.title}</Text> : <Text color={C.dim}>No task in focus.</Text>}
          {files.length ? files.slice(0, max).map(f => (
            <Box justifyContent="space-between">
              <Text color={C.text}>{shortPath(f.path, w - 4)}</Text>
              <Text color={FILE_COLOR[f.status] ?? C.text} bold>{f.status}</Text>
            </Box>
          )) : scope.slice(0, max).map(f => <Text color={C.faint} wrap="truncate-end">· {shortPath(f, w - 4)}</Text>)}
          {!files.length && focusTask ? <Text color={C.dim}>{scope.length ? 'planned files; no change on disk yet' : 'no changes yet'}</Text> : null}
          {files.length > max ? <Text color={C.dim}>… {files.length - max} more</Text> : null}
        </Box>
      )
    }

    // Code preview: the biggest change of the focus task, old and new line numbers like a review tool.
    const DiffView = ({ diff, max }: { diff: string; max: number }) => {
      const rowsOut: { a: string; b: string; k: 'add' | 'del' | 'ctx' | 'hunk'; text: string }[] = []
      let o = 0, nw = 0
      for (const line of diff.split('\n')) {
        const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
        if (h) { o = Number(h[1]); nw = Number(h[2]); rowsOut.push({ a: '', b: '', k: 'hunk', text: line }); continue }
        if (line.startsWith('\\') || line === '…') continue
        const text = line.slice(1).replace(/\t/g, '  ')
        if (line.startsWith('+')) rowsOut.push({ a: '', b: String(nw++), k: 'add', text })
        else if (line.startsWith('-')) rowsOut.push({ a: String(o++), b: '', k: 'del', text })
        else rowsOut.push({ a: String(o++), b: String(nw++), k: 'ctx', text })
      }
      return (
        <Box flexDirection="column">
          {rowsOut.slice(0, max).map(r => (
            <Text wrap="truncate-end">
              <Text color={C.faint}>{r.a.padStart(4)} {r.b.padStart(4)} </Text>
              <Text color={r.k === 'add' ? C.green : r.k === 'del' ? C.red : C.faint}>{r.k === 'add' ? '+' : r.k === 'del' ? '-' : ' '} </Text>
              <Text color={r.k === 'add' ? C.green : r.k === 'del' ? C.red : r.k === 'hunk' ? C.cyan : C.text} backgroundColor={r.k === 'add' ? C.greenDeep : r.k === 'del' ? C.redDim : undefined}>{r.text || ' '}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    // Terminal: the orchestrator's last test run of the focus task, then its git status.
    const TerminalBody = ({ max }: { max: number }) => {
      const v = focusTask?.detail?.validation
      const files = focusTask?.live?.files ?? []
      const outLines = v && !v.skipped ? v.output.trim().split('\n').filter(Boolean).slice(-Math.max(2, max - files.length - 5)) : []
      const label: Record<string, string> = { M: 'modified:', A: 'new file:', D: 'deleted: ', R: 'renamed: ' }
      return (
        <Box flexDirection="column">
          {v && !v.skipped ? <Text color={C.text} wrap="truncate-end"><Text color={C.accent}>$ </Text>{v.command}</Text> : <Text color={C.dim}>{focusTask ? 'no test run yet' : 'no task in focus'}</Text>}
          {outLines.map(l => <Text color={/fail|error|✗/i.test(l) ? C.red : /pass|ok|✓|success/i.test(l) ? C.green : C.mute} wrap="truncate-end">{l}</Text>)}
          {v && !v.skipped ? <Text color={v.passed ? C.green : C.red} bold>{v.passed ? '✔ passed' : '✗ failed'}</Text> : null}
          {files.length ? <Text color={C.text}><Text color={C.accent}>$ </Text>git status</Text> : null}
          {files.length && focusTask?.branch ? <Text color={C.dim} wrap="truncate-end">On branch {focusTask.branch.split('/').slice(-1)[0]}</Text> : null}
          {files.slice(0, Math.max(0, max - outLines.length - 5)).map(f => <Text color={FILE_COLOR[f.status] ?? C.text} wrap="truncate-end">    {label[f.status] ?? f.status.padEnd(9)} {f.path}</Text>)}
        </Box>
      )
    }

    const brand = l.brand || 'ANILDEV'
    const repoName = run.repositories[0]?.name ?? 'workspace'
    const working = minds.filter(m => m.status === 'active').length || run.workers.length

    // ── sizes: the top band takes ~60% of the body, the code / terminal / output band the rest ──

    const topH = Math.max(16, Math.round(bodyH * 0.6))
    const botH = Math.max(8, bodyH - topH)
    const tasksH = Math.max(7, Math.min(taskOrder.length + Math.min(finished.length, 3) + 5, Math.floor(topH * 0.6)))
    const focusH = Math.max(6, topH - tasksH)
    const codeW = Math.floor(tasksW * 0.58)
    const termW = tasksW - codeW
    const sized = wide // only the grid pins heights; narrower panes grow with their content and scroll

    const centreBody: RenderChildren =
      u.tab === 'task' ? (selTask ? <TaskDetail t={selTask} /> : <Text color={C.dim}>No task selected.</Text>)
      : u.tab === 'events' ? eventsView()
      : u.tab === 'report' ? (u.report?.runId === run.id
        ? <Box flexDirection="column">{markdownChunks(u.report.text).map(part => <Markdown text={part} />)}</Box>
        : <Text color={C.cyan}>{SPIN[n % SPIN.length]} fetching report…</Text>)
      : <LogView max={Math.max(6, topH - 11)} />
    const branch = run.repositories[0]?.integration?.branch.split('/').slice(-1)[0] ?? run.repositories[0]?.baseBranch ?? ''
    const centrePanel = (
      <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} width={wide || medium ? tasksW : undefined} height={sized ? topH : undefined} overflow="hidden">
        <Box justifyContent="space-between">
          <Text wrap="truncate-end"><Text color={C.accent} bold>{repoName.toUpperCase()}</Text><Text color={C.dim}>  /  </Text><Text color={C.ink} bold>{firstLine(run.request).toUpperCase()}</Text></Text>
          <Box flexShrink={0} gap={1}>
            {branch ? <Text color={C.cyan}>⎇ {branch}</Text> : null}
            <Text color={C.accent}>#{run.id.slice(-6)}</Text>
            <Pill label={`${glyph(run.status, n)} ${run.status.replace(/_/g, ' ')}`} bg={runAttention ? pulse(n, C.yellow, C.accent, 0.5) : runColor} />
            <Text color={C.yellow} bold>{run.createdAt ? ago(now - Date.parse(run.createdAt)) : ''}</Text>
          </Box>
        </Box>
        {raster('pipeline', tasksIn, 2, live, t => paint.pipeline(tasksIn, 2, t, { steps: stepNames, phase, fill: fillE(t), failed, color: paint.hex(runColor) }), textStepper)}
        <Box>
          {raster('progress', Math.max(8, tasksIn - 18), 1, live, t => paint.progress(Math.max(8, tasksIn - 18), 1, t, { frac: fracE(t), live }), <Text color={C.accent}>{smoothBar(fracE(anim), Math.max(8, tasksIn - 18)).fill}<Text color={C.track}>{smoothBar(fracE(anim), Math.max(8, tasksIn - 18)).rest}</Text></Text>)}
          <Text color={C.ink} bold> {String(pct).padStart(3)}%</Text>
          <Text color={C.dim}>{run.round ? `  round ${run.round}` : ''}</Text>
        </Box>
        {divider}
        <Box>
          {views.map(([id, label, badge], i) => (
            <Box backgroundColor={u.tab === id ? C.tabActive : undefined} paddingX={1}>
              <Button plain hotkey={String(i + 1)} key={`tab-${id}`} dimColor={u.tab !== id} label={`${label}${badge}`} onPress={() => showView(id)} />
            </Box>
          ))}
        </Box>
        {underline}
        {centreBody}
      </Box>
    )
    const tasksPanel = (
      <Panel
        title={<Text color={u.focus === 'tasks' ? C.accent : C.mute} bold>TASKS <Text color={C.dim}>({run.tasks.length})  {done} done</Text></Text>}
        right={<Button plain dimColor key="new-task" label="+ New mission" onPress={() => void patchUi($, { composing: { kind: 'run' } })} />}
        width={wide || medium ? rightW : undefined} height={sized ? tasksH : undefined} color={u.focus === 'tasks' ? C.accent : C.border}
      >
        <TaskList w={rightW - 4} max={sized ? tasksH - 3 : 40} />
      </Panel>
    )
    const focusRole = followed ? tagOf(followed.role, followed.task) : 'AGENT'
    const focusState = followed?.status === 'active' ? (followed.activity.at(-1)?.kind === 'thinking' ? 'thinking' : 'working') : followed ? followed.status : 'idle'
    const focusPanel = (
      <Panel
        title={<Text color={followed ? tagColor(followed.role, followed.task) : C.accent} bold>AGENT: {focusRole}</Text>}
        right={<Text color={focusState === 'working' ? C.green : focusState === 'thinking' ? C.cyan : C.dim}>● {focusState}{followed ? `  ${ago((followed.endedAt ? Date.parse(followed.endedAt) : now) - Date.parse(followed.startedAt))}` : ''}</Text>}
        width={wide || medium ? rightW : undefined} height={sized ? focusH : undefined}
      >
        <FocusBody w={rightW - 4} max={sized ? focusH - 4 : 12} />
      </Panel>
    )
    const preview = focusTask?.live?.preview
    const codePanel = (
      <Panel title={<Text><Text color={C.accent} bold>CODE PREVIEW</Text><Text color={C.mute}>  {preview ? shortPath(preview.file, codeW - 18) : ''}</Text></Text>} width={wide ? codeW : undefined} height={sized ? botH : undefined}>
        {preview ? <DiffView diff={preview.diff} max={sized ? botH - 3 : 30} /> : <Text color={C.dim}>{focusTask ? 'No change on disk yet for ' + focusTask.key + '.' : 'No task in focus.'}</Text>}
      </Panel>
    )
    const terminalPanel = (
      <Panel title="TERMINAL" right={<Text color={C.dim}>{focusTask?.key ?? ''}</Text>} width={wide ? termW : undefined} height={sized ? botH : undefined}>
        <TerminalBody max={sized ? botH - 3 : 24} />
      </Panel>
    )
    const outputPanel = (
      <Panel title={<Text><Text color={C.accent} bold>AGENT OUTPUT</Text><Text color={C.mute}>  {followed ? `(${focusRole.toLowerCase()})` : ''}</Text></Text>} width={wide || medium ? rightW : undefined} height={sized ? botH : undefined}>
        {liveView()}
      </Panel>
    )

    // Agents, one line each: the role's ring, who holds it, and whether it is running, thinking or idle.
    const AgentLine = ({ r }: { r: AgentRow }) => {
      const color = r.role === 'worker' ? SPEC_COLOR[specOf(r.task) ?? ''] ?? C.orange : ROLE_COLOR[r.role] ?? C.text
      const picked = !!r.mind && r.mind.sessionId === followed?.sessionId
      const state = !r.active ? 'idle' : r.mind?.status === 'active' && (r.mind.activity.at(-1)?.kind === 'thinking' || !r.mind.activity.length) ? 'thinking' : 'running'
      return (
        <Box key={`agent-${r.id}`} justifyContent="space-between" hover={{ backgroundColor: C.hover }} backgroundColor={picked ? C.chipOn : undefined}>
          <Box flexShrink={1}>
            <Text color={picked && u.focus === 'agents' ? C.accent : C.bgDeep}>▌</Text>
            <Text color={r.active ? pulse(n, color, C.white, 0.35) : color}>{r.active ? '◉' : '○'} </Text>
            <Button plain dimColor={!picked} key={`agent-pick-${r.id}`} label={clip(`${tagOf(r.role, r.task).toLowerCase()} ${r.name}`, agentsW - 16)} onPress={() => followMind(r.mind)} />
          </Box>
          <Text color={state === 'running' ? C.green : state === 'thinking' ? C.cyan : C.dim}>{state}</Text>
        </Box>
      )
    }
    const agentsPanel = (
      <Panel title={<Text color={u.focus === 'agents' ? C.accent : C.mute} bold>AGENTS</Text>} right={<Text color={C.dim}>{working} working</Text>} width={agentsW} height={Math.max(8, bodyH - missionsH)} color={u.focus === 'agents' ? C.accent : C.border}>
        {agentRows.map(r => <AgentLine r={r} />)}
        {earlier.length ? <Section title="EARLIER" right={<Text color={C.dim}>{minds.length} sessions</Text>} /> : null}
        {earlier.map(m => <EarlierRow m={m} />)}
        {u.composing?.kind === 'run' ? null : <Section title="SEATS" right={<Text color={C.dim}>{live ? 'live' : 'next run'}</Text>} />}
        {u.composing?.kind === 'run' ? null : <SeatLines seats={live ? roles : nextSeats!} isLive={live} />}
        <Section title="SPEND" right={<Text color={C.yellow} bold>{tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : '—'}</Text>} />
        <Text color={C.dim} wrap="truncate-end">{tel.calls} calls · ↓{compact(tel.inputTokens)} ↑{compact(tel.outputTokens)}</Text>
        {meterBars}
      </Panel>
    )

    // ── keys: j/k move in the focused list, h/l switch it; the footer shows what the focus offers ──

    const move = (d: 1 | -1) => {
      if (u.focus === 'agents') {
        const next = pickable[(selAgent + d + pickable.length) % Math.max(1, pickable.length)]
        if (next) followMind(next.mind)
        return
      }
      if (!ordered.length) return
      const at = ordered.findIndex(t => t.key === selTask?.key)
      pickTask(ordered[(at + d + ordered.length) % ordered.length])
    }
    const nav: [string, string, () => void][] = [
      ['j', 'down', () => move(1)],
      ['k', 'up', () => move(-1)],
      ['h', 'agents', () => void patchUi($, { focus: 'agents', tab: 'live' })],
      ['l', 'tasks', () => void patchUi($, { focus: 'tasks', tab: 'task' })],
      ...(u.focus === 'tasks' && GROUPS.some(g => g[3] && run.tasks.some(g[2])) ? ([['o', isOpen('grp-done') ? 'hide done' : 'show done', () => toggle('grp-done')]] as [string, string, () => void][]) : []),
    ]
    const actions: [string, string, () => void][] = [
      ['n', 'new', () => void patchUi($, { composing: { kind: 'run' } })],
      ...(failed ? ([['t', 'retry', () => void busy($, 'retrying…', () => cli($, ['retry', run.id])).then(r => say($, r.text))]] as [string, string, () => void][]) : []),
      ['p', 'report', () => void loadReport($, run.id)],
      ['d', 'dashboard', () => void busy($, 'opening the dashboard…', () => cli($, ['dashboard', run.id])).then(r => say($, r.text))],
      ['x', 'stop', () => void daemon($, false)],
    ]
    const keyName: Record<string, string> = { p: 'report', d: 'dashboard', x: 'stop', t: 'retry', n: 'new' }
    const footer = (
      <Box flexDirection="column" paddingX={1}>
        {u.busy ? (
          <Text color={C.cyan}>{SPIN[n % SPIN.length]} {u.busy}</Text>
        ) : v.message ? (
          <Text color={C.mute} wrap="truncate-end">↳ {firstLine(v.message)}</Text>
        ) : null}
        {e.props.isFocused ? (
          <Box flexWrap="wrap" gap={2}>
            {nav.map(([k, label, fn]) => <Button plain hotkey={k} key={`nav-${k}`} label={label} onPress={fn} />)}
            <Text color={C.faint}>│</Text>
            {u.focus === 'agents' ? <Text color={C.dim}>v b seats · f g w effort</Text> : <Text color={C.dim}>1-4 view</Text>}
            <Text color={C.faint}>│</Text>
            {actions.map(([k, label, fn]) => <Button plain hotkey={k} key={keyName[k] ?? `act-${k}`} label={label} onPress={fn} />)}
          </Box>
        ) : <Text color={C.dim}>ctrl+x tab  focus the cockpit — every action is one key away</Text>}
      </Box>
    )

    const body = wide ? (
      <Box flexDirection="column">
        <Box>
          <Box flexDirection="column" width={agentsW}>
            {missionsPanel}
            {agentsPanel}
          </Box>
          <Box flexDirection="column">
            <Box>
              {centrePanel}
              <Box flexDirection="column" width={rightW}>
                {tasksPanel}
                {focusPanel}
              </Box>
            </Box>
            <Box>
              {codePanel}
              {terminalPanel}
              {outputPanel}
            </Box>
          </Box>
        </Box>
      </Box>
    ) : medium ? (
      <Box flexDirection="column">
        {missionsPanel}
        {agentsStrip}
        <Box>
          <Box flexDirection="column" width={tasksW}>{centrePanel}{codePanel}{terminalPanel}</Box>
          <Box flexDirection="column" width={rightW}>{tasksPanel}{focusPanel}{outputPanel}</Box>
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        {missionsPanel}
        {agentsStrip}
        {centrePanel}
        {tasksPanel}
        {focusPanel}
        {codePanel}
        {terminalPanel}
        {outputPanel}
      </Box>
    )

    return out(
      <Box flexDirection="column">
        {header}
        {run.error ? <Box paddingX={1}><Text color={C.red} wrap="truncate-end">✗ {run.error}</Text></Box> : null}
        {failureCard}
        {approvals.map(a => <ApprovalCard a={a} />)}
        {u.composing?.kind === 'run' ? composer : null}
        {body}
        {footer}
      </Box>
    )
  }
}
