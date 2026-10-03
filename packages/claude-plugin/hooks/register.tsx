import { atom, read, update } from 'claude-code'
import type { EngineInterface, InputProps, Register, RenderChildren } from 'claude-code'

import type { CockpitApproval, CockpitRun, CockpitSnapshot, CockpitTab, CockpitTask, CockpitUi, CockpitView } from '../types'
import { enableTrace, resolveCadence } from './limits'
import * as paint from './raster'
import { COCKPIT_ROOT } from './root'
import { createScheduler, type KeySpec, type Scheduler } from './scheduler'
import { C, K, LOGO_GRADIENT } from './theme'
import { createTweens, type Tweens } from './tween'

// Presentation only: the orchestrator owns all workflow state. This mod reads the
// snapshot the orchestrator projects to <dataDir>/snapshot.json and sends human
// decisions through the cockpit CLI, which talks to the orchestrator service.

const PANE = 'agent-cockpit'
const EMPTY: CockpitView = { snapshot: null, error: null, message: null }
const UI0: CockpitUi = { selectedRun: null, tab: 'tasks', composing: null, nonce: 0, busy: null, report: null, failure: null }
const view = atom({ plugin: 'agent-cockpit', key: 'view' } as const, EMPTY)
const ui = atom({ plugin: 'agent-cockpit', key: 'ui' } as const, UI0)
const tickAtom = atom({ plugin: 'agent-cockpit', key: 'tick' } as const, 0)

// ── palette ──────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  running: C.cyan, needs_input: C.yellow, validating: C.blue, in_review: C.violet, changes_requested: C.yellow,
  lease_conflict: C.red, approved: C.green, integrated: C.green, escalated: C.yellow, failed: C.red, cancelled: C.dim,
  pending: C.dim, ready: C.text, created: C.mute, architecting: C.violet, proposing: C.violet, deciding: C.violet,
  planning: C.blue, executing: C.cyan, integrating: C.cyan, merging: C.green, awaiting_approval: C.yellow,
  awaiting_human_decision: C.yellow, completed: C.green, rejected: C.red, passed: C.green, started: C.cyan,
}
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

// ── orchestrator I/O ─────────────────────────────────────────────────────────

let lastGenerated = ''

// One lifecycle per session: scheduler, tweens, text tick. Animation time (`anim`) is monotonic from creation and
// frozen under COCKPIT_REDUCED_MOTION; wall time only ever feeds the clock string. `T` is the last wall reading, kept
// sync because the scheduler's clock is: every timer callback refreshes it before running.
type Life = {
  sched: Scheduler
  tweens: Tweens
  open: boolean
  T: number
  epoch: number
  frozenAt: number | null
  motion: boolean
  seen: number
  tick: (() => void) | null
  cancels: (() => void)[]
  anim: () => number
  freeze: (on: boolean) => void
  arm: () => void
  setMotion: (on: boolean) => void
  close: () => void
}
let life: Promise<Life> | null = null
let stopPoll: (() => void) | null = null
const TICK_MS = 125 // text spinners and pulses: <=10 fps with motion
const IDLE_TICK_MS = 1000
const STALE_MS = 1500 // the host has no unmount event: no render for longer than the 1 s idle beat means the pane was gone, tweens snap

async function createLife($: EngineInterface): Promise<Life> {
  const T0 = await $.clock.now()
  enableTrace(await $.env.get('COCKPIT_TRACE'))
  const cadence = resolveCadence({ COCKPIT_CADENCE: await $.env.get('COCKPIT_CADENCE') })
  const l: Life = {
    sched: null as never, tweens: createTweens(), open: true, T: T0, epoch: T0, frozenAt: null, motion: false, seen: T0, tick: null, cancels: [],
    anim: () => l.frozenAt ?? l.T - l.epoch,
    freeze(on) {
      if (on && l.frozenAt === null) l.frozenAt = l.T - l.epoch
      else if (!on && l.frozenAt !== null) l.epoch = l.T - l.frozenAt, l.frozenAt = null
      l.tweens.setMotion(!on && l.motion)
    },
    setMotion(on) {
      if (on === l.motion || !l.open) return
      l.motion = on
      l.sched.setMotion(on)
      l.tweens.setMotion(on)
      l.arm()
    },
    close() {
      l.open = false
      l.sched.close()
      l.tick?.()
      l.tick = null
      for (const c of l.cancels.splice(0)) c()
      l.tweens.reset()
    },
    arm() {
      l.tick?.()
      const t = $.clock.every(l.motion ? TICK_MS : IDLE_TICK_MS, () => void update($, tickAtom, n => n + 1))
      l.tick = () => t.cancel()
    },
  }
  // Every timer callback first reads the wall clock, so the scheduler's sync `now` is never older than one period.
  const stamp = (fn: () => void) => () => void $.clock.now().then(t => {
    if (!l.open) return
    l.T = Math.max(l.T, t)
    fn()
  })
  l.sched = createScheduler({
    cadence,
    clock: {
      now: () => l.T,
      every: (ms, fn) => { const t = $.clock.every(ms, stamp(fn)); return () => t.cancel() },
      after: (ms, fn) => { const t = $.clock.after(ms, stamp(fn)); return () => t.cancel() },
    },
    blit: (key, cells) => $.ui.blit({ requestId: PANE, key, cells }),
  })
  l.sched.setMotion(false)
  l.tweens.setMotion(false)
  l.arm()
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
  if (l?.open) l.freeze((await $.env.get('COCKPIT_REDUCED_MOTION')) === '1')
  let snapshot: CockpitSnapshot | null = null
  try {
    snapshot = JSON.parse(await $.fs.read(`${dataDir}/snapshot.json`)) as CockpitSnapshot
  } catch {
    if (lastGenerated !== 'missing') {
      lastGenerated = 'missing'
      await update($, view, v => ({ ...v, snapshot: null, error: 'Orchestrator not started' }))
      $.ui.status(undefined)
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
  const run = activeRun(snapshot)
  if (!run || snapshot.daemon.port === null) {
    $.ui.status(snapshot.daemon.port === null ? 'cockpit ○ offline' : undefined)
    return
  }
  const done = run.tasks.filter(isDone).length
  const approvals = snapshot.pendingApprovals.length
  $.ui.status(`cockpit ◆ ${run.status} ${done}/${run.tasks.length}${run.workers.length ? ` · ${run.workers.length} working` : ''}${approvals ? ` · ${approvals} awaiting you` : ''}`)
}

function patchUi($: EngineInterface, patch: Partial<CockpitUi> | ((u: CockpitUi) => Partial<CockpitUi>)) {
  return update($, ui, (u): CockpitUi => ({ ...u, ...(typeof patch === 'function' ? patch(u) : patch) }))
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
  const res = await busy($, 'launching run…', () => cli($, ['run', request, ...repo, ...flags]))
  if (res.ok) {
    await say($, res.text)
    await patchUi($, { selectedRun: null, tab: 'tasks', failure: null })
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

async function initialCommitAndRetry($: EngineInterface) {
  const f = (await read($, ui)).failure
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

const openPane = ($: EngineInterface, focus = false) =>
  $.ui.open({ id: PANE, title: '◆ Cockpit', ...(focus ? { focus: true as const } : {}) })

// ── plugin ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cockpit',
      description: 'Agent cockpit: /cockpit [start|stop|run <request>|status|approve|changes <text>|reject|report]',
    })
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
    if (e.id === PANE) closeLife()
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
      case 'open':
        await openPane($, true)
        return { text: 'Cockpit opened.' }
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
      case 'approve':
      case 'reject':
      case 'changes': {
        const target = rest[0]?.startsWith('apr_') || rest[0]?.startsWith('run_') ? rest[0]! : null
        const note = (target ? rest.slice(1) : rest).join(' ')
        return { text: await decide($, sub, target, note) }
      }
      default:
        return { text: 'Usage: /cockpit [start|stop|run <request>|status|approve [note]|changes <text>|reject [note]|report]' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const T = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = T
    // Surfaces without text fields (mobile) get a hint to use the slash command instead.
    const Input = 'Input' in T ? T.Input : (_: InputProps) => Text({ color: C.dim, children: 'type it as /cockpit run … or /cockpit changes …' })
    // Desktop and mobile draw no cell grid: they get the designed text fallbacks instead.
    const RasterEl = e.surface === 'terminal' && 'Raster' in T ? T.Raster : null
    const v = await read($, view)
    const u = await read($, ui)
    await read($, tickAtom)
    const l = await getLife($)
    const wall = await $.clock.now()
    if (wall - l.seen > STALE_MS) l.tweens.reset() // the pane was gone: nothing eases across the gap
    l.seen = l.T = Math.max(l.T, wall)
    const now = wall
    const anim = l.anim()
    const n = Math.floor(anim / TICK_MS) // text beat: derived from animation time, so it stops with it
    const s = v.snapshot
    const cols = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 100)
    const rows = e.viewport?.rows ?? 40
    const online = !!s && s.daemon.port !== null
    const specs = new Map<string, KeySpec>()

    // A Raster that keeps animating: drawn now at the current animation time, repainted by the scheduler afterwards.
    const raster = (key: string, columns: number, height: number, tier: 'A' | 'B', fn: (t: number) => string, fallback: RenderChildren = null) => {
      if (!RasterEl || columns < 1) return fallback
      // At rest only the hero (wall clock) is repainted by the scheduler (<=2 fps); the rest are redrawn by the 1 Hz render.
      if (l.motion || key === 'hero') specs.set(key, { tier, id: `${columns}x${height}`, paint: () => fn(l.anim()) })
      return RasterEl({ key, columns, rows: height, cells: fn(anim) })
    }
    // Every return path reports the mounted raster keys; text-only surfaces have none and leave the scheduler alone.
    const out = <R,>(el: R): R => (RasterEl && l.open && l.sched.sync(specs), el)
    // Tweens: retarget at render, sampled at paint time so the ease runs between renders.
    const run0 = online ? (u.selectedRun && s.runs.find(r => r.id === u.selectedRun)) || activeRun(s) : null
    const viewing = !!run0 && !TERMINAL.includes(run0.status)
    l.setMotion(!!online && l.frozenAt === null && viewing)
    if (!run0) l.tweens.reset()
    else if (l.tweens.active() !== run0.id) l.tweens.switchRun(run0.id)
    const ease = (el: string, target: number, ms = 600) => {
      if (!run0) return () => target
      l.tweens.target(run0.id, el, target, anim, ms)
      return (t: number) => (l.tweens.sample(run0.id, el, t) as number | undefined) ?? target
    }

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

    const clock = new Date(now).toISOString().slice(11, 19)
    const chain = s ? `${s.hierarchy.supervisor} ▸ ${s.hierarchy.lead} ▸ workers` : 'opus ▸ codex ▸ workers'
    const attention = !!s?.pendingApprovals.length
    const heroInfo = (): paint.HeroData => ({
      online,
      alert: attention,
      left: chain,
      right: `${online ? `online :${s!.daemon.port}` : 'offline'}  ${clock}`,
    })
    const hero = raster('hero', cols, 4, 'A', t => paint.hero({ cols, rows: 4 }, t, heroInfo()), (
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold>{[...'◆ AGENT COCKPIT'].map((ch, i) => <Text color={gradient(LOGO_GRADIENT, i / 22 - n / 40)}>{ch}</Text>)}</Text>
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
        <Box>
          <Text color={C.dim}>runs in this session's folder unless --repo is given · </Text>
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
              </Box>
            )}
          </Box>
          {keybar([['n', 'new mission'], ['x', 'stop']])}
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

    const wide = cols >= 120
    const runsW = 28
    const sideW = 38
    const centerW = wide ? cols - runsW - sideW : cols
    const inner = centerW - 4
    const runIdx = s.runs.findIndex(r => r.id === run.id)
    const select = (id: string | null) => void patchUi($, x => ({ selectedRun: id, report: x.report?.runId === id ? x.report : null }))

    // activity: events bucketed across the run's own time span
    const times = run.recentEvents.map(ev => Date.parse(ev.ts)).filter(t => !Number.isNaN(t))
    const t0 = Math.min(...times, now), t1 = live ? now : Math.max(...times, t0 + 1)
    const buckets = new Array(48).fill(0) as number[]
    for (const t of times) buckets[Math.min(47, Math.floor(((t - t0) / Math.max(1, t1 - t0)) * 48))]!++
    const bucketE = buckets.map((b, i) => ease(`spark${i}`, b))

    // ── run list (wide: left column) ──

    const RunRow = ({ r }: { r: CockpitRun }) => {
      const picked = r.id === run.id
      const rc = STATUS_COLOR[r.status] ?? C.text
      const rd = r.tasks.filter(isDone).length
      const waits = s.pendingApprovals.some(a => a.runId === r.id)
      return (
        <Box key={`row-${r.id}`} flexDirection="column" hover={{ backgroundColor: C.hover }}>
          <Box>
            <Text color={picked ? C.accent : C.hover}>▌</Text>
            <Text color={rc}>{glyph(r.status, n)} </Text>
            <Button plain dimColor={!picked} key={`pick-${r.id}`} label={clip(firstLine(r.request), runsW - 9)} onPress={() => select(r.id)} />
          </Box>
          <Text color={C.dim} wrap="truncate-end">
            {'   '}{r.status.replace(/_/g, ' ')}{r.tasks.length ? ` · ${rd}/${r.tasks.length}` : ''}
            {waits ? <Text color={pulse(n, C.yellow, C.accent, 0.5)}> ● needs you</Text> : null}
          </Text>
        </Box>
      )
    }
    const runList = (
      <Card title="MISSIONS" right={<Text color={C.dim}>{s.runs.length}</Text>} width={runsW}>
        {s.runs.slice(0, Math.max(3, Math.floor((rows - 14) / 2))).map(r => <RunRow r={r} />)}
        <Text> </Text>
        <Button hotkey="n" variant="primary" label="n · New mission" onPress={() => void patchUi($, { composing: { kind: 'run' } })} />
      </Card>
    )

    // ── mission header + lifecycle ──

    const missionHead = (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Pill label={`${glyph(run.status, n)} ${run.status.replace(/_/g, ' ').toUpperCase()}`} bg={runColor} />
            <Text color={C.dim}>  round {run.round} · {run.id.slice(-8)}{run.createdAt ? ` · ${ago(now - Date.parse(run.createdAt))} ago` : ''}</Text>
          </Text>
          {s.runs.length > 1 ? (
            <Box>
              <Button plain dimColor hotkey="k" key="prev" label="◂" onPress={() => select(s.runs[Math.max(0, runIdx - 1)]!.id)} />
              <Text color={C.dim}> {runIdx + 1}/{s.runs.length} </Text>
              <Button plain dimColor hotkey="j" key="next" label="▸" onPress={() => select(s.runs[Math.min(s.runs.length - 1, runIdx + 1)]!.id)} />
            </Box>
          ) : null}
        </Box>
        <Text color={C.ink} bold wrap="wrap">{clip(firstLine(run.request), inner * 2)}</Text>
        {run.error ? <Text color={C.red} wrap="truncate-end">✗ {run.error}</Text> : null}
      </Box>
    )

    const dividerW = Math.max(1, centerW - 2)
    const divider = (
      <Box paddingX={1}>
        {raster('divider', dividerW, 1, 'B', t => paint.divider({ cols: dividerW, rows: 1 }, t, { color: paint.hex(runColor), active: live }), <Text color={C.borderDim}>{'─'.repeat(dividerW)}</Text>)}
      </Box>
    )

    const Tile = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.borderDim} paddingX={1} flexGrow={1}>
        <Text color={C.dim}>{label}</Text>
        <Text color={color} bold>{value}</Text>
        {sub ? <Text color={C.dim} wrap="truncate-end">{sub}</Text> : null}
      </Box>
    )
    const tel = run.telemetry
    const tiles = (
      <Box gap={1} flexWrap="wrap">
        <Tile label="PROGRESS" value={`${pct}%`} sub={run.status === 'completed' ? 'shipped' : STEPS[Math.max(0, phase)]?.[0] ?? run.status} color={C.cyan} />
        <Tile label="TASKS" value={`${done}/${run.tasks.length}`} sub={run.tasks.length ? `${run.tasks.filter(t => MOVING.has(t.status)).length} moving` : 'planning'} color={C.green} />
        <Tile label="AGENTS" value={`${run.workers.length + [run.leadership.supervisor, run.leadership.lead].filter(x => x !== 'idle').length}`} sub="live now" color={C.violet} />
        <Tile label="SPEND" value={tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : '—'} sub={`${compact(tel.inputTokens + tel.outputTokens)} tok`} color={C.yellow} />
      </Box>
    )

    const stepNames = STEPS.map(([name]) => name)
    const textStepper = (
      <Text wrap="truncate-end">
        {STEPS.map(([name], i) => (
          <Text color={i < phase ? C.green : i === phase ? runColor : C.faint}>{i < phase ? '●' : i === phase ? '◉' : '○'} {name}{i < STEPS.length - 1 ? ' ─ ' : ''}</Text>
        ))}
      </Text>
    )
    const barW = Math.max(8, inner - 6)
    const sparkW = Math.max(8, inner - 9)
    const lifecycle = (
      <Card
        title="LIFECYCLE"
        right={<Text color={C.dim}>{run.tasks.length ? `${done} of ${run.tasks.length} tasks` : ''}</Text>}
        color={runAttention ? pulse(n, C.yellow, C.yellowDeep, 0.35) : live ? pulse(n, C.violetDeep, C.border, 0.2) : C.border}
      >
        <Text> </Text>
        {raster('pipeline', inner, 2, 'A', t => paint.pipeline({ cols: inner, rows: 2 }, t, { steps: stepNames, phase, fill: fillE(t), failed, color: paint.hex(runColor) }), textStepper)}
        <Text> </Text>
        <Box>
          {raster('progress', barW, 1, 'B', t => paint.progress({ cols: barW, rows: 1 }, t, { frac: fracE(t), live }), <Text color={C.cyan}>{'█'.repeat(Math.round(fracE(anim) * barW))}</Text>)}
          <Text color={C.ink} bold> {String(pct).padStart(3)}%</Text>
        </Box>
        {times.length > 1 && RasterEl ? (
          <Box>
            <Text color={C.dim}>activity </Text>
            {raster('spark', sparkW, 1, 'B', t => paint.spark({ cols: sparkW, rows: 1 }, t, { values: bucketE.map(f => f(t)), live }))}
          </Box>
        ) : null}
      </Card>
    )

    // ── approval ──

    const ApprovalCard = ({ a }: { a: CockpitApproval }) => {
      const writing = u.composing?.kind === 'changes' && u.composing.approvalId === a.id
      return (
        <Box flexDirection="column" borderStyle="double" borderColor={pulse(n, C.yellow, C.accent, 0.5)} paddingX={1}>
          <Box justifyContent="space-between">
            <Text><Pill label={`${n % 8 < 4 ? '◆' : '◇'} YOUR CALL`} bg={C.yellow} /> <Text color={C.dim}>{a.kind}{a.operation ? `/${a.operation}` : ''}</Text></Text>
            <Text color={C.dim}>{a.id.slice(-6)}</Text>
          </Box>
          <Text color={C.ink} bold wrap="wrap">{clip(a.summary, inner * 3)}</Text>
          {writing ? (
            <Box flexDirection="column">
              <Input
                key={`changes-${a.id}-${u.nonce}`}
                label="changes › "
                placeholder="What should the team change?"
                submitLabel="send back"
                autoFocus
                onSubmit={(text: string) => {
                  if (!text.trim()) return
                  void patchUi($, x => ({ composing: null, nonce: x.nonce + 1 })).then(() => decide($, 'changes', a.id, text))
                }}
              />
              <Button plain dimColor key="cancel-changes" label="cancel" onPress={() => void patchUi($, { composing: null })} />
            </Box>
          ) : (
            <Box gap={1}>
              <Button variant="primary" hotkey="a" key={`approve-${a.id}`} label="a · Approve" autoFocus onPress={() => void decide($, 'approve', a.id, '')} />
              <Button hotkey="c" key={`changes-${a.id}`} label="c · Changes" onPress={() => void patchUi($, { composing: { kind: 'changes', approvalId: a.id } })} />
              <Button hotkey="r" key={`reject-${a.id}`} label="r · Reject" onPress={() => void decide($, 'reject', a.id, '')} />
            </Box>
          )}
        </Box>
      )
    }

    // ── tabs ──

    const Tab = ({ id, label, hotkey, badge }: { id: CockpitTab; label: string; hotkey: string; badge?: string }) => (
      <Box backgroundColor={u.tab === id ? C.tabActive : undefined} paddingX={1}>
        <Button
          plain
          hotkey={hotkey}
          key={`tab-${id}`}
          dimColor={u.tab !== id}
          label={`${label}${badge ? ` ${badge}` : ''}`}
          onPress={() => (id === 'report' && u.report?.runId !== run.id ? void loadReport($, run.id) : void patchUi($, { tab: id }))}
        />
      </Box>
    )

    const fixed = 27 + approvals.length * 5 + (u.composing?.kind === 'run' ? 5 : 0)
    const room = Math.max(4, rows - fixed)

    const TaskRow = ({ t }: { t: CockpitTask }) => {
      const color = STATUS_COLOR[t.status] ?? C.text
      const moving = MOVING.has(t.status)
      const fin = isDone(t)
      const meta = [t.agentId, t.iteration > 1 ? `it${t.iteration}` : '', t.dependsOn.length ? `⇠ ${t.dependsOn.join(',')}` : ''].filter(Boolean).join(' · ')
      return (
        <Box key={`task-${t.key}`} flexDirection="column" hover={{ backgroundColor: C.hover }}>
          <Box justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={color}>▎</Text>
                <Text color={moving ? pulse(n, color, C.white, 0.5) : color}>{glyph(t.status, n)} </Text>
                <Text color={fin ? C.dim : C.ink} bold>{t.key}</Text>
                <Text color={fin ? C.dim : C.text}>  {t.title}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text>
                <Text color={C.dim}>{meta ? ` ${meta} ` : ' '}</Text>
                {fin ? <Text color={C.green}>✓ {t.status}</Text> : <Pill label={t.status.replace(/_/g, ' ')} bg={color} />}
              </Text>
            </Box>
          </Box>
          {t.blockedReason ? <Text color={C.yellow} wrap="truncate-end">   ↳ {t.blockedReason}</Text> : null}
        </Box>
      )
    }

    let tabBody: RenderChildren
    if (u.tab === 'events') {
      const evs = run.recentEvents.slice(-room).reverse()
      tabBody = evs.length ? (
        evs.map((ev, i) => {
          const fresh = Math.max(0, 1 - (now - Date.parse(ev.ts)) / 6000)
          const c = eventColor(ev.type)
          return (
            <Text wrap="truncate-end">
              <Text color={mix(C.dim, C.white, fresh)}>{ev.ts.slice(11, 19)} </Text>
              <Text color={mix(c, C.white, fresh * 0.6)}>{i === 0 && live ? glyph('running', n) : '●'}</Text>
              <Text color={C.faint}>─ </Text>
              <Text color={mix(c, C.white, fresh * 0.6)} bold>{ev.type}</Text>
              <Text color={mix(C.mute, C.text, fresh)}>  {ev.text === ev.type ? '' : ev.text}</Text>
            </Text>
          )
        })
      ) : <Text color={C.dim}>No events yet.</Text>
    } else if (u.tab === 'report') {
      tabBody = u.report?.runId === run.id
        ? <Markdown text={u.report.text} />
        : <Text color={C.cyan}>{SPIN[n % SPIN.length]} fetching report…</Text>
    } else {
      const order = (t: CockpitTask) => (MOVING.has(t.status) ? 0 : isDone(t) ? 3 : ['failed', 'lease_conflict', 'needs_input', 'escalated'].includes(t.status) ? 1 : 2)
      const tasks = [...run.tasks].sort((a, b) => order(a) - order(b))
      tabBody = tasks.length === 0 ? (
        <Text color={C.violet}>{ORBIT[Math.floor(n / 2) % 4]} {live ? 'the lead is drafting the task graph…' : 'no tasks'}</Text>
      ) : (
        <Box flexDirection="column">
          {tasks.slice(0, room).map(t => <TaskRow t={t} />)}
          {tasks.length > room ? <Text color={C.dim}>   … {tasks.length - room} more</Text> : null}
        </Box>
      )
    }

    const tabs: [CockpitTab, string][] = [['tasks', `Tasks ${done}/${run.tasks.length}`], ['events', `Events ${run.recentEvents.length}`], ['report', 'Report']]
    const tabW = tabs.map(([, label]) => label.length + 2)
    const tabIdx = Math.max(0, tabs.findIndex(([id]) => id === u.tab))
    const tabE = ease('tab', tabIdx, 220)
    // Text fallback: ▔ under the active tab, a dim rule under the rest.
    let used = 0
    const underlineText = (
      <Text>
        {tabs.map(([id], i) => {
          const w = Math.max(0, Math.min(tabW[i]!, inner - used))
          used += w
          return <Text color={id === u.tab ? C.accent : C.borderDim}>{'▔'.repeat(w)}</Text>
        })}
        <Text color={C.borderDim}>{'▔'.repeat(Math.max(0, inner - used))}</Text>
      </Text>
    )
    const underline = raster('underline', inner, 1, 'B', t => paint.underline({ cols: inner, rows: 1 }, t, { tabs: tabW, active: tabE(t), color: K.accent }), underlineText)

    const work = (
      <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} flexGrow={1}>
        <Box justifyContent="space-between">
          <Box>
            <Tab id="tasks" label="Tasks" hotkey="1" badge={`${done}/${run.tasks.length}`} />
            <Tab id="events" label="Events" hotkey="2" badge={`${run.recentEvents.length}`} />
            <Tab id="report" label="Report" hotkey="3" />
          </Box>
          <Box gap={1}>
            {!wide ? <Button hotkey="n" plain dimColor key="new" label="n new" onPress={() => void patchUi($, { composing: { kind: 'run' } })} /> : null}
            {failed ? <Button hotkey="t" plain key="retry" label="t retry" onPress={() => void busy($, 'retrying…', () => cli($, ['retry', run.id])).then(r => say($, r.text))} /> : null}
            <Button hotkey="p" plain dimColor key="report" label="p report" onPress={() => void loadReport($, run.id)} />
            <Button hotkey="x" plain dimColor key="stop" label="x stop" onPress={() => void daemon($, false)} />
          </Box>
        </Box>
        {underline}
        {tabBody}
      </Box>
    )

    const center = (
      <Box flexDirection="column" width={wide ? centerW : undefined} flexGrow={wide ? 0 : 1}>
        {missionHead}
        {divider}
        {centerW >= 56 ? tiles : null}
        {lifecycle}
        {failureCard}
        {approvals.map(a => <ApprovalCard a={a} />)}
        {u.composing?.kind === 'run' ? composer : null}
        {work}
      </Box>
    )

    // ── crew & instruments ──

    const sideCols = wide ? sideW : cols >= 84 ? Math.floor(cols / 2) : cols
    const Agent = ({ id, name, role, state, color, seed }: { id: string; name: string; role: string; state: string; color: string; seed: number }) => {
      const active = state !== 'idle'
      return (
        <Box gap={1}>
          {raster(`orb-${id}`, 4, 2, 'B', t => paint.orb({ cols: 4, rows: 2 }, t, { color: paint.hex(color), active, seed }), <Text color={active ? pulse(n, color, C.white, 0.4) : C.faint}>◉</Text>)}
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="truncate-end"><Text color={C.ink} bold>{name}</Text><Text color={C.dim}>  {role}</Text></Text>
            <Text color={active ? color : C.dim} wrap="truncate-end">{active ? `${SPIN[(n + seed) % SPIN.length]} ` : ''}{state}</Text>
          </Box>
        </Box>
      )
    }
    const crew = (
      <Card title="CREW" right={<Text color={C.dim}>{run.workers.length} on the floor</Text>} width={sideCols}>
        <Agent id="sup" name={s.hierarchy.supervisor} role="supervisor" state={run.leadership.supervisor} color={C.violet} seed={0} />
        <Agent id="lead" name={s.hierarchy.lead} role="engineering lead" state={run.leadership.lead} color={C.cyan} seed={2} />
        {run.workers.map((w, i) => (
          <Agent id={`w${i}`} name={w.agentId} role={`worker · ${ago(now - Date.parse(w.since))}`} state={`on ${w.task ?? '?'}`} color={C.green} seed={4 + i} />
        ))}
      </Card>
    )
    // The orchestrator logs a test's start and its outcome as separate entries: keep the latest per test.
    const latest = new Map<string, CockpitRun['tests'][number]>()
    for (const t of run.tests) {
      const id = `${t.task ?? t.scope}|${t.command}`
      latest.delete(id)
      latest.set(id, t)
    }
    const testList = [...latest.values()]
    const lastTests = testList.slice(-5).reverse()
    const passed = testList.filter(t => t.status === 'passed').length
    const failedTests = testList.filter(t => t.status === 'failed').length
    const tests = (
      <Card title="TESTS" right={<Text><Text color={C.green}>{passed} ✓</Text><Text color={failedTests ? C.red : C.dim}>  {failedTests} ✗</Text></Text>} width={sideCols}>
        {lastTests.length === 0 ? <Text color={C.dim}>— none yet</Text> : lastTests.map(t => (
          <Text wrap="truncate-end">
            <Text color={STATUS_COLOR[t.status] ?? C.text}>{glyph(t.status, n)} </Text>
            <Text color={C.text}>{t.task ?? t.scope}</Text>
            <Text color={C.dim}>  {t.command}</Text>
          </Text>
        ))}
      </Card>
    )
    const repos = (
      <Card title="REPOSITORIES" width={sideCols}>
        {run.repositories.map(r => (
          <Text wrap="truncate-end">
            <Text color={r.integration ? (r.integration.passed ? C.green : C.red) : C.dim}>{r.integration ? (r.integration.passed ? '✓' : '✗') : '○'} </Text>
            <Text color={C.text} bold>{r.name}</Text>
            <Text color={C.dim}>  ⎇ {r.integration ? r.integration.branch.split('/').pop() : r.baseBranch}</Text>
          </Text>
        ))}
        {run.conflicts.map(c => (
          <Text color={pulse(n, C.red, C.redDark, 0.4)} wrap="truncate-end">⚠ {c.task} ⟂ {c.heldBy}  <Text color={C.dim}>{c.pattern}</Text></Text>
        ))}
      </Card>
    )
    const byAgent = tel.byAgent ?? []
    const maxCalls = Math.max(1, ...byAgent.map(a => a.calls))
    const meterW = Math.max(4, sideCols - 20)
    const meterColors = [K.cyan, K.violet, K.green, K.yellow, K.pink]
    const meterE = byAgent.map((a, i) => ease(`meter${i}`, a.calls / maxCalls))
    const meterFall = byAgent.map((a, i) => {
      const w = Math.max(1, Math.round(meterE[i]!(anim) * meterW))
      return (
        <Text wrap="truncate-end">
          <Text color={C.mute}>{a.agentId.padEnd(7).slice(0, 7)} </Text>
          <Text color={C.faint}>▕</Text>
          {Array.from({ length: w }, (_, k) => <Text color={gradient(LOGO_GRADIENT, i / 5 + k / (meterW * 4))}>█</Text>)}
          <Text color={C.borderDim}>{'█'.repeat(Math.max(0, meterW - w))}</Text>
          <Text color={C.faint}>▏</Text>
          <Text color={C.dim}> {a.calls}</Text>
        </Text>
      )
    })
    const meterBars = byAgent.length && RasterEl ? raster('meters', Math.max(1, sideCols - 4), byAgent.length, 'B', t => paint.meters({ cols: Math.max(1, sideCols - 4), rows: byAgent.length }, t, {
      values: meterE.map(f => f(t)), colors: byAgent.map((_, i) => meterColors[i % meterColors.length]!), labels: byAgent.map(a => `${a.agentId.slice(0, 7)} ${a.calls}`),
    })) : meterFall
    const meter = (
      <Card title="TELEMETRY" right={<Text color={C.yellow} bold>{tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : ''}</Text>} width={sideCols}>
        <Text>
          <Text color={C.ink} bold>{tel.calls}</Text><Text color={C.dim}> calls   </Text>
          <Text color={C.cyan}>↓ {compact(tel.inputTokens)}</Text><Text color={C.dim}>   </Text>
          <Text color={C.violet}>↑ {compact(tel.outputTokens)}</Text>
        </Text>
        {meterBars}
      </Card>
    )
    const side = wide ? (
      <Box flexDirection="column" width={sideW}>
        {crew}{tests}{repos}{meter}
      </Box>
    ) : (
      <Box flexWrap="wrap">
        {crew}{tests}{repos}{meter}
      </Box>
    )

    const keys: [string, string][] = [
      ...(runAttention ? ([['a', 'approve'], ['c', 'changes'], ['r', 'reject']] as [string, string][]) : []),
      ['n', 'new'], ['1 2 3', 'tabs'], ...(s.runs.length > 1 ? ([['j k', 'missions']] as [string, string][]) : []),
      ['p', 'report'], ['x', 'stop'],
    ]
    return out(
      <Box flexDirection="column">
        {hero}
        {wide ? (
          <Box>
            {runList}
            {center}
            {side}
          </Box>
        ) : (
          <Box flexDirection="column">
            {center}
            {side}
          </Box>
        )}
        {keybar(keys)}
      </Box>
    )
  })
}
