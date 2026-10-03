import { atom, read, update } from 'claude-code'
import type { EngineInterface, InputProps, Register, RenderChildren, RenderInput } from 'claude-code'

import type { CockpitApproval, CockpitMind, CockpitRun, CockpitSnapshot, CockpitTab, CockpitTask, CockpitUi, CockpitView } from '../types'
import * as paint from './raster'
import { COCKPIT_ROOT } from './root'

// Presentation only: the orchestrator owns all workflow state. This mod reads the
// snapshot the orchestrator projects to <dataDir>/snapshot.json and sends human
// decisions through the cockpit CLI, which talks to the orchestrator service.

const PANE = 'agent-cockpit'
const EMPTY: CockpitView = { snapshot: null, error: null, message: null }
const UI0: CockpitUi = { selectedRun: null, tab: 'tasks', composing: null, nonce: 0, busy: null, report: null, failure: null, seats: { supervisor: null, lead: null }, efforts: {}, mind: null, open: [] }
const view = atom({ plugin: 'agent-cockpit', key: 'view' } as const, EMPTY)
const ui = atom({ plugin: 'agent-cockpit', key: 'ui' } as const, UI0)
const tick = atom({ plugin: 'agent-cockpit', key: 'tick' } as const, 0)

// ── palette ──────────────────────────────────────────────────────────────────

const C = {
  accent: '#ff8a3d', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24',
  red: '#f87171', pink: '#f472b6', text: '#e5e7eb', mute: '#9ca3af', dim: '#6b7280', faint: '#3f3f46', line: '#52525b',
}
const LOGO_GRADIENT = [C.cyan, C.violet, C.pink, C.accent, C.yellow, C.cyan]
const BAR_GRADIENT = [C.violet, C.cyan, C.green]

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
const ROLE_COLOR: Record<string, string> = { supervisor: C.violet, lead: C.cyan, worker: C.green }
// A tool's argument on one line: a heredoc shows its first line, a path inside a task worktree its repo-relative part.
const toolDetail = (detail: string) => {
  const lines = detail.split('\n')
  const head = lines[0]!.replace(/^.*[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]/, '')
  return lines.length > 1 ? `${head} ⏎ +${lines.length - 1} lines` : head
}
const doing = (m: CockpitMind) => (m.contract ? DOING[m.contract] ?? m.contract : m.role === 'worker' ? 'implementing' : 'working')

// ── orchestrator I/O ─────────────────────────────────────────────────────────

let lastGenerated = ''
// Rasters drawn by the last render, repainted by the animation clock until a blit is refused.
const rasters = new Map<string, { paint: (f: number) => string }>()
let frame = 0
let nowMs = 0
let motion = false
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
  let snapshot: CockpitSnapshot | null = null
  try {
    snapshot = JSON.parse(await $.fs.read(`${dataDir}/snapshot.json`)) as CockpitSnapshot
  } catch {
    if (lastGenerated !== 'missing') {
      lastGenerated = 'missing'
      motion = false
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
  motion = snapshot.daemon.port !== null && (snapshot.pendingApprovals.length > 0 || (!!run && !TERMINAL.includes(run.status)))
}

// $.state outlives a reload, so a value saved by an older build may lack newer fields.
const withDefaults = (u: Partial<CockpitUi> | undefined): CockpitUi => ({ ...UI0, ...u })
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
    await refresh($)
    $.clock.every(1000, () => void refresh($))
    // Text animation (spinners, pulses): ~8 fps while something moves, one beat a second at rest.
    let beat = 0
    $.clock.every(125, () => {
      beat++
      if (motion || beat % 8 === 0) void update($, tick, n => n + 1)
    })
    // Raster animation: every mounted Raster is repainted in place at ~16 fps, no render pass.
    $.clock.every(60, () => {
      frame++
      if (frame % 20 === 0) void $.clock.now().then(t => (nowMs = t))
      for (const [key, r] of rasters)
        void $.ui.blit({ requestId: PANE, key, cells: r.paint(frame) }).then(res => {
          if ('deny' in res && res.deny && rasters.get(key) === r) rasters.delete(key)
        })
    })
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
    const Input = e.surface !== 'mobile' ? $.ui.resolve(e).Input : (_: InputProps) => Text({ color: C.dim, children: 'type it as /cockpit run … or /cockpit changes …' })
    // Every table names every element (a missing one draws a fragment): ask the surface.
    const RasterEl = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const v = await read($, view)
    const u = await readUi($)
    const n = await read($, tick)
    const now = (nowMs = await $.clock.now())
    const s = v.snapshot
    const cols = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 100)
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const online = !!s && s.daemon.port !== null
    rasters.clear()

    // A Raster that keeps animating: drawn now, repainted by the clock afterwards.
    const raster = (key: string, columns: number, height: number, fn: (f: number) => string, fallback: RenderChildren = null) => {
      if (!RasterEl || columns < 1) return fallback
      rasters.set(key, { paint: fn })
      return RasterEl({ key, columns, rows: height, cells: fn(frame) })
    }

    // ── small pieces ──

    const Pill = ({ label, bg, fg }: { label: string; bg: string; fg?: string }) => (
      <Text backgroundColor={bg} color={fg ?? '#0b0b0f'} bold> {label} </Text>
    )
    const Key = ({ k, label }: { k: string; label: string }) => (
      <Text>
        <Text backgroundColor="#2a2a33" color={C.text} bold> {k} </Text>
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
      <Box flexDirection="column" borderStyle="round" borderColor={color ?? '#2e2e36'} paddingX={1} width={width} flexGrow={grow ? 1 : 0}>
        <Title label={title} right={right} />
        {children}
      </Box>
    )

    const clock = new Date(now).toISOString().slice(11, 19)
    const seated = (s && activeRun(s)?.roles) ?? s?.hierarchy
    const chain = seated ? `${seated.supervisor} ▸ ${seated.lead} ▸ workers` : 'opus ▸ codex ▸ workers'
    const attention = !!s?.pendingApprovals.length
    const heroInfo = (): paint.HeroInfo => ({
      online,
      alert: attention,
      left: chain,
      right: `${online ? `online :${s!.daemon.port}` : 'offline'}  ${new Date(nowMs || now).toISOString().slice(11, 19)}`,
    })
    const hero = raster('hero', cols, 4, f => paint.hero(cols, 4, f, heroInfo()), (
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
      <Box flexDirection="column" borderStyle="round" borderColor={pulse(n, C.red, '#5b1d1d', 0.35)} paddingX={1}>
        <Box justifyContent="space-between">
          <Text><Pill label="✗ LAUNCH FAILED" bg={C.red} /> <Text color={C.dim}>{clip(firstLine(u.failure.request), 40)}</Text></Text>
        </Box>
        <Text color={C.text} wrap="wrap">{u.failure.text}</Text>
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
        <Box marginLeft={1} key={`effort-box-${keyId}`} hover={{ backgroundColor: '#27272a' }}>
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
                <Box key={`chip-${role}-${a.id}`} backgroundColor={on ? (role === 'supervisor' ? '#3b1d6e' : '#0e3a4a') : undefined} paddingX={1} hover={{ backgroundColor: '#27272a' }}>
                  <Button plain dimColor={!on} key={`seat-${role}-${a.id}`} label={`${on ? '● ' : ''}${a.id}`} onPress={() => { if (!on) onPick(role, a.id) }} />
                </Box>
              )
            })}
            {keys && next && next !== current ? (
              <Box marginLeft={1}><Button plain dimColor hotkey={role === 'supervisor' ? 'v' : 'l'} key={`cycle-${role}`} label={`→ ${next}`} onPress={() => onPick(role, next)} /></Box>
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
                ? <Button plain hotkey={role === 'supervisor' ? 'v' : 'l'} key={`cycle-${role}`} label={current} onPress={() => onPick(role, next)} />
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
      return (
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
      return (
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
                {nextSeats ? <SeatBar seats={nextSeats} onPick={pickNext} keys efforts={u.efforts} live={false} onEffort={effortNext} note="v / l seats · f / g / w effort · or click" /> : null}
              </Box>
            )}
          </Box>
          {keybar([['n', 'new mission'], ['v l', 'seats'], ['f g w', 'effort'], ['x', 'stop']])}
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

    // ── run list (wide: left column) ──

    const RunRow = ({ r }: { r: CockpitRun }) => {
      const picked = r.id === run.id
      const rc = STATUS_COLOR[r.status] ?? C.text
      const rd = r.tasks.filter(isDone).length
      const waits = s.pendingApprovals.some(a => a.runId === r.id)
      return (
        <Box key={`row-${r.id}`} flexDirection="column" hover={{ backgroundColor: '#1f1f27' }}>
          <Box>
            <Text color={picked ? C.accent : '#1f1f27'}>▌</Text>
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
        <Text color="#fafafa" bold wrap="wrap">{clip(firstLine(run.request), inner * 2)}</Text>
        {run.error ? <Text color={C.red} wrap="truncate-end">✗ {run.error}</Text> : null}
        {/* while the composer is open it carries the seat chips itself */}
        {u.composing?.kind === 'run' ? null : <Box>
          {live ? (
            <SeatBar
              compact
              seats={run.roles ?? s.hierarchy}
              onPick={(role, agent) => void setSeat($, run.id, role, agent)}
              keys
              efforts={run.efforts ?? {}}
              live
              onEffort={changes => void setEffort($, run.id, Object.fromEntries(Object.entries(changes).filter((kv): kv is [string, string] => kv[1] !== null)))}
              note="live: changes apply to the next call (v / l seats · f / g / w effort)"
            />
          ) : (
            <SeatBar compact seats={nextSeats!} onPick={pickNext} keys efforts={u.efforts} live={false} onEffort={effortNext} note="" />
          )}
        </Box>}
      </Box>
    )

    const tel = run.telemetry
    const Stat = ({ value, sub, color }: { value: string; sub: string; color: string }) => (
      <Text><Text color={color} bold>{value}</Text><Text color={C.dim}> {sub}    </Text></Text>
    )
    const tiles = (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Stat value={`${Math.round(frac * 100)}%`} sub={run.status === 'completed' ? 'shipped' : STEPS[Math.max(0, phase)]?.[0] ?? run.status} color={C.cyan} />
          <Stat value={`${done}/${run.tasks.length}`} sub={run.tasks.length ? `tasks · ${run.tasks.filter(t => MOVING.has(t.status)).length} moving` : 'tasks · planning'} color={C.green} />
          <Stat value={`${run.workers.length + [run.leadership.supervisor, run.leadership.lead].filter(x => x !== 'idle').length}`} sub="agents live" color={C.violet} />
          <Stat value={tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : '—'} sub={`${compact(tel.inputTokens + tel.outputTokens)} tok`} color={C.yellow} />
        </Text>
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
        color={runAttention ? pulse(n, C.yellow, '#3a2a0a', 0.35) : live ? pulse(n, '#3b2a55', '#2e2e36', 0.2) : '#2e2e36'}
      >
        {raster('pipeline', inner, 2, f => paint.pipeline(inner, f, { steps: stepNames, phase, failed, color: paint.hex(runColor) }), textStepper)}
        <Box>
          {raster('progress', barW, 1, f => paint.progress(barW, f, frac, live), <Text color={C.cyan}>{'█'.repeat(Math.round(frac * barW))}</Text>)}
          <Text color="#fafafa" bold> {String(Math.round(frac * 100)).padStart(3)}%</Text>
        </Box>
        {times.length > 1 && RasterEl ? (
          <Box>
            <Text color={C.dim}>activity </Text>
            {raster('spark', sparkW, 1, f => paint.spark(sparkW, 1, f, buckets, live))}
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
          {(() => {
            // The first lines always; the rest behind a toggle, so a long call never pushes the buttons off screen.
            const text = a.text ?? a.summary
            const total = wrapped(text, inner - 2)
            const open = u.open.includes(`apr-${a.id}`)
            return (
              <Box flexDirection="column">
                <Text color={C.text} wrap="wrap">{open || total <= APPROVAL_PREVIEW ? text : clip(text, (inner - 2) * APPROVAL_PREVIEW)}</Text>
                {total > APPROVAL_PREVIEW ? (
                  <Button plain dimColor key={`open-apr-${a.id}`} label={open ? '▴ show less' : `▾ show all (${total - APPROVAL_PREVIEW} more lines)`} onPress={() => void patchUi($, x => ({ open: x.open.includes(`apr-${a.id}`) ? x.open.filter(k => k !== `apr-${a.id}`) : [...x.open, `apr-${a.id}`] }))} />
                ) : null}
              </Box>
            )
          })()}
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
      <Box backgroundColor={u.tab === id ? '#3a2412' : undefined} paddingX={1}>
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

    const approvalRows = approvals.reduce((acc, a) => {
      const total = wrapped(a.text ?? a.summary, inner - 2)
      return acc + 4 + (u.open.includes(`apr-${a.id}`) ? total : Math.min(total, APPROVAL_PREVIEW)) + (total > APPROVAL_PREVIEW ? 1 : 0)
    }, 0)
    const fixed = 20 + (run.error ? 1 : 0) + (firstLine(run.request).length > inner ? 1 : 0) + approvalRows + (u.failure ? 5 : 0) + (u.composing?.kind === 'run' ? 9 : 0)
    const room = Math.max(4, rows - fixed)

    // Any row may be opened to show what its one line cuts off; a press toggles it.
    const isOpen = (id: string) => u.open.includes(id)
    const toggle = (id: string) => void patchUi($, x => ({ open: x.open.includes(id) ? x.open.filter(k => k !== id) : [...x.open.slice(-40), id] }))
    const Fold = ({ id }: { id: string }) => (
      <Box flexShrink={0} marginRight={1}>
        <Button plain dimColor={!isOpen(id)} key={`open-${id}`} label={isOpen(id) ? '▾' : '▸'} onPress={() => toggle(id)} />
      </Box>
    )
    const bodyW = Math.max(20, inner - 6)

    // The whole task as the Lead wrote it, and its latest review.
    const taskLines = (t: CockpitTask) => {
      const d = t.detail
      if (!d) return 1
      const sc = d.scope
      return wrapped(d.description, bodyW) + 1 + (d.acceptanceCriteria.length ? 1 + d.acceptanceCriteria.reduce((a, c) => a + wrapped(c, bodyW - 2), 0) : 0)
        + (sc.files.length + sc.modules.length + sc.resources.length ? 1 + sc.files.length + sc.modules.length + sc.resources.length : 0)
        + (d.summary ? 1 + wrapped(d.summary, bodyW) : 0)
        + (d.review ? 1 + wrapped(d.review.summary, bodyW) + d.review.issues.reduce((a, i) => a + wrapped(i.description, bodyW - 12), 0) : 0)
    }
    const Label = ({ text }: { text: string }) => <Text color={C.dim} bold>{text}</Text>
    const TaskDetailView = ({ t }: { t: CockpitTask }) => {
      const d = t.detail
      if (!d) return <Box paddingLeft={4}><Text color={C.dim}>No details for this task yet (the orchestrator is older than the cockpit).</Text></Box>
      const verdictColor = d.review ? (d.review.verdict === 'approve' ? C.green : d.review.verdict === 'escalate' ? C.yellow : C.red) : C.dim
      return (
        <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
          <Text color={C.text} wrap="wrap">{d.description}</Text>
          <Text color={C.dim}>{d.kind} · risk {d.risk} · complexity {d.complexity} · tests {d.testsRequired ? (d.testCommand ?? 'repo default') : 'not required'}</Text>
          {d.acceptanceCriteria.length ? <Label text="ACCEPTANCE" /> : null}
          {d.acceptanceCriteria.map(c => <Box><Text color={C.green}>✓ </Text><Box flexShrink={1}><Text color={C.text} wrap="wrap">{c}</Text></Box></Box>)}
          {d.scope.files.length + d.scope.modules.length + d.scope.resources.length ? <Label text="SCOPE" /> : null}
          {d.scope.files.map(f => <Text color={C.mute} wrap="truncate-end">◦ {f}</Text>)}
          {d.scope.modules.map(m => <Text color={C.mute} wrap="truncate-end">▣ {m}</Text>)}
          {d.scope.resources.map(r => <Text color={C.yellow} wrap="truncate-end">⛁ {r}</Text>)}
          {d.summary ? <Label text="WORKER" /> : null}
          {d.summary ? <Text color={C.text} wrap="wrap">{d.summary}</Text> : null}
          {d.review ? <Text><Label text={`REVIEW it${d.review.iteration} `} /><Text color={verdictColor} bold>{d.review.verdict.replace(/_/g, ' ')}</Text></Text> : null}
          {d.review ? <Text color={C.text} wrap="wrap">{d.review.summary}</Text> : null}
          {d.review?.issues.map(i => (
            <Box>
              <Text color={i.severity === 'blocker' ? C.red : i.severity === 'major' ? C.yellow : C.dim}>✗ {i.severity.padEnd(7)} </Text>
              <Box flexShrink={1}><Text color={C.text} wrap="wrap">{i.file ? `${i.file}: ` : ''}{i.description}</Text></Box>
            </Box>
          ))}
        </Box>
      )
    }

    const TaskRow = ({ t }: { t: CockpitTask }) => {
      const color = STATUS_COLOR[t.status] ?? C.text
      const moving = MOVING.has(t.status)
      const fin = isDone(t)
      const meta = [t.agentId, t.iteration > 1 ? `it${t.iteration}` : '', t.dependsOn.length ? `⇠ ${t.dependsOn.join(',')}` : ''].filter(Boolean).join(' · ')
      return (
        <Box key={`task-${t.key}`} flexDirection="column" hover={{ backgroundColor: '#1f1f27' }}>
          <Box justifyContent="space-between">
            <Box flexShrink={1}>
              <Fold id={`task-${t.key}`} />
              <Text wrap="truncate-end">
                <Text color={color}>▎</Text>
                <Text color={moving ? pulse(n, color, '#ffffff', 0.5) : color}>{glyph(t.status, n)} </Text>
                <Text color={fin ? C.dim : '#fafafa'} bold>{t.key}</Text>
                <Text color={fin ? C.dim : C.text}>  {t.title}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text>
                <Text color={C.dim}>{meta ? ` ${meta} ` : ' '}</Text>
                {fin ? <Text color={C.green}>✓ {t.status}</Text> : <Pill label={t.status.replace(/_/g, ' ')} bg={moving ? pulse(n, color, '#ffffff', 0.3) : color} />}
              </Text>
            </Box>
          </Box>
          {t.blockedReason ? <Text color={C.yellow} wrap={isOpen(`task-${t.key}`) ? 'wrap' : 'truncate-end'}>     ↳ {t.blockedReason}</Text> : null}
          {isOpen(`task-${t.key}`) ? <TaskDetailView t={t} /> : null}
        </Box>
      )
    }

    // Minds: one chip per recent model session; the followed one streams its text, reasoning and tools.
    const minds = run.minds ?? []
    const followed = minds.find(m => m.sessionId === u.mind) ?? minds.find(m => m.status === 'active') ?? minds[0] ?? null
    const thinkingNow = minds.filter(m => m.status === 'active').length
    const mindsBody = (): RenderChildren => {
      if (!followed) return <Text color={C.dim}>No model has run yet.</Text>
      const nextMind = minds[(minds.indexOf(followed) + 1) % minds.length]!
      const chips = (
        <Box flexWrap="wrap">
          {minds.map(m => {
            const on = m === followed
            const color = ROLE_COLOR[m.role] ?? C.text
            const active = m.status === 'active'
            return (
              <Box key={`mind-${m.sessionId}`} backgroundColor={on ? '#23232c' : undefined} paddingX={1} hover={{ backgroundColor: '#1f1f27' }}>
                <Text color={active ? pulse(n, color, '#ffffff', 0.4) : m.status === 'failed' ? C.red : C.dim}>{active ? SPIN[n % SPIN.length] : m.status === 'failed' ? '✗' : '✓'} </Text>
                <Button plain dimColor={!on} key={`mind-pick-${m.sessionId}`} label={`${m.agentId}·${m.role}${m.task ? ` ${m.task}` : ''}`} onPress={() => void patchUi($, { mind: m.sessionId })} />
              </Box>
            )
          })}
          {minds.length > 1 ? <Box paddingX={1}><Button plain dimColor hotkey="o" key="mind-next" label={`o → ${nextMind.agentId}·${nextMind.role}`} onPress={() => void patchUi($, { mind: nextMind.sessionId })} /></Box> : null}
        </Box>
      )
      const color = ROLE_COLOR[followed.role] ?? C.text
      const active = followed.status === 'active'
      const end = followed.endedAt ? Date.parse(followed.endedAt) : now
      const head = (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Pill label={followed.role.toUpperCase()} bg={color} />
            <Text color="#fafafa" bold> {followed.agentId}</Text>
            <Text color={C.text}>  {doing(followed)}{followed.task ? ` ${followed.task}` : ''}</Text>
            {followed.effort ? <Text color={C.dim}>  ⚡{followed.effort}</Text> : null}
          </Text>
          <Text color={active ? color : C.dim}>{active ? `${SPIN[n % SPIN.length]} live ` : `${followed.status} `}{ago(end - Date.parse(followed.startedAt))}</Text>
        </Box>
      )
      // Newest first (top down): fill from the newest entry back until the room runs out; each kind has a line budget.
      const width = Math.max(20, inner - 14)
      const chipCols = minds.reduce((a, m) => a + `${m.agentId}·${m.role}${m.task ? ` ${m.task}` : ''}`.length + 4, minds.length > 1 ? 24 : 0)
      const budget = Math.max(3, room - Math.ceil(chipCols / Math.max(20, inner)) - 2)
      const cap = { thinking: 4, text: 6, tool: 1 } as const
      const entryId = (e: CockpitMind['activity'][number]) => `mind-${followed.sessionId}-${e.ts}-${e.kind}-${e.text.length}`
      const shown: { e: CockpitMind['activity'][number]; lines: number }[] = []
      let used = 0
      for (let k = followed.activity.length - 1; k >= 0 && used < budget; k--) {
        const e = followed.activity[k]!
        const want = isOpen(entryId(e)) ? wrapped(e.text.trim(), width) : e.kind === 'tool' ? 1 : Math.min(cap[e.kind], Math.ceil(e.text.trim().length / width))
        const lines = Math.max(1, Math.min(want, budget - used))
        shown.push({ e, lines })
        used += lines
      }
      const stream = shown.length ? shown.map(({ e, lines }, k) => {
        const fresh = Math.max(0, 1 - (now - Date.parse(e.ts)) / 8000)
        const last = k === 0
        const open = isOpen(entryId(e))
        const stamp = <Box flexShrink={0}><Fold id={entryId(e)} /><Text color={C.faint}>{e.ts.slice(11, 19)} </Text></Box>
        if (e.kind === 'tool') {
          const at = e.text.indexOf(': ')
          const name = at > 0 ? e.text.slice(0, at) : e.text
          const arg = at > 0 ? e.text.slice(at + 2) : ''
          return open ? (
            <Box>
              {stamp}
              <Text color={mix(C.cyan, '#ffffff', fresh * 0.6)}>{name} </Text>
              <Box flexShrink={1}><Text color={C.text} wrap="wrap">{arg}</Text></Box>
            </Box>
          ) : (
            <Box>
              {stamp}
              <Text wrap="truncate-end">
                <Text color={mix(C.cyan, '#ffffff', fresh * 0.6)}>{name}</Text>
                <Text color={C.mute}>  {toolDetail(arg)}</Text>
              </Text>
            </Box>
          )
        }
        const body = open ? e.text.trim() : clip(e.text.trim().replace(/\s*\n\s*/g, ' ⏎ '), lines * width)
        return e.kind === 'thinking' ? (
          <Box>
            {stamp}
            <Text color={mix(C.violet, '#ffffff', fresh * 0.5)}>{last && active ? ORBIT[Math.floor(n / 2) % 4] : '∴'} </Text>
            <Box flexShrink={1}><Text color={mix('#8b80b8', C.violet, fresh)} italic wrap="wrap">{body}</Text></Box>
          </Box>
        ) : (
          <Box>
            {stamp}
            <Text color={color}>▍ </Text>
            <Box flexShrink={1}><Text color={mix(C.text, '#ffffff', fresh)} wrap="wrap">{body}</Text></Box>
          </Box>
        )
      }) : <Text color={C.dim}>{active ? `${SPIN[n % SPIN.length]} waiting for the first words…` : 'It produced no visible output.'}</Text>
      return (
        <Box flexDirection="column">
          {chips}
          {head}
          <Text color="#26262e">{'┄'.repeat(Math.max(1, inner))}</Text>
          {stream}
        </Box>
      )
    }

    let tabBody: RenderChildren
    if (u.tab === 'minds') {
      tabBody = mindsBody()
    } else if (u.tab === 'events') {
      const evId = (ev: CockpitRun['recentEvents'][number]) => `ev-${ev.ts}-${ev.type}`
      const evs: CockpitRun['recentEvents'] = []
      let used = 0
      for (const ev of [...run.recentEvents].reverse()) {
        const h = 1 + (isOpen(evId(ev)) ? wrapped(ev.detail ?? ev.text, bodyW - 8) : 0)
        if (used > 0 && used + h > room) break
        evs.push(ev)
        used += h
      }
      tabBody = evs.length ? (
        evs.map((ev, i) => {
          const fresh = Math.max(0, 1 - (now - Date.parse(ev.ts)) / 6000)
          const c = eventColor(ev.type)
          const open = isOpen(evId(ev))
          return (
            <Box flexDirection="column" key={evId(ev)}>
              <Box>
                <Fold id={evId(ev)} />
                <Text wrap="truncate-end">
                  <Text color={mix(C.dim, '#ffffff', fresh)}>{ev.ts.slice(11, 19)} </Text>
                  <Text color={mix(c, '#ffffff', fresh * 0.6)}>{i === 0 && live ? glyph('running', n) : '●'}</Text>
                  <Text color={C.faint}>─ </Text>
                  <Text color={mix(c, '#ffffff', fresh * 0.6)} bold>{ev.type}</Text>
                  <Text color={mix(C.mute, C.text, fresh)}>  {ev.text === ev.type ? '' : ev.text}</Text>
                </Text>
              </Box>
              {open ? <Box paddingLeft={13}><Text color={C.text} wrap="wrap">{ev.detail ?? ev.text}</Text></Box> : null}
            </Box>
          )
        })
      ) : <Text color={C.dim}>No events yet.</Text>
    } else if (u.tab === 'report') {
      tabBody = u.report?.runId === run.id
        ? <Box flexDirection="column">{markdownChunks(u.report.text).map(part => <Markdown text={part} />)}</Box>
        : <Text color={C.cyan}>{SPIN[n % SPIN.length]} fetching report…</Text>
    } else {
      const order = (t: CockpitTask) => (MOVING.has(t.status) ? 0 : isDone(t) ? 3 : ['failed', 'lease_conflict', 'needs_input', 'escalated'].includes(t.status) ? 1 : 2)
      const tasks = [...run.tasks].sort((a, b) => order(a) - order(b))
      tabBody = tasks.length === 0 ? (
        <Text color={C.violet}>{ORBIT[Math.floor(n / 2) % 4]} {live ? 'the lead is drafting the task graph…' : 'no tasks'}</Text>
      ) : (
        <Box flexDirection="column">
          {(() => {
            let used = 0
            const fit = tasks.filter(t => {
              const h = 1 + (t.blockedReason ? 1 : 0) + (isOpen(`task-${t.key}`) ? taskLines(t) + 1 : 0)
              if (used > 0 && used + h > room - 1) return false
              used += h
              return true
            })
            return [
              ...fit.map(t => <TaskRow t={t} />),
              fit.length < tasks.length ? <Text color={C.dim}>   … {tasks.length - fit.length} more (close an open task to see them)</Text> : null,
            ]
          })()}
        </Box>
      )
    }

    const work = (
      <Box flexDirection="column" borderStyle="round" borderColor="#2e2e36" paddingX={1} flexGrow={1} minHeight={room + 4} overflow="hidden">
        <Box justifyContent="space-between">
          <Box>
            <Tab id="tasks" label="Tasks" hotkey="1" badge={`${done}/${run.tasks.length}`} />
            <Tab id="events" label="Events" hotkey="2" badge={`${run.recentEvents.length}`} />
            <Tab id="report" label="Report" hotkey="3" />
            <Tab id="minds" label="Minds" hotkey="4" badge={thinkingNow ? `${SPIN[n % SPIN.length]}${thinkingNow}` : undefined} />
          </Box>
          <Box gap={1}>
            {!wide ? <Button hotkey="n" plain dimColor key="new" label="n new" onPress={() => void patchUi($, { composing: { kind: 'run' } })} /> : null}
            {failed ? <Button hotkey="t" plain key="retry" label="t retry" onPress={() => void busy($, 'retrying…', () => cli($, ['retry', run.id])).then(r => say($, r.text))} /> : null}
            <Button hotkey="p" plain dimColor key="report" label="p report" onPress={() => void loadReport($, run.id)} />
            <Button hotkey="d" plain dimColor key="dashboard" label="d dashboard" onPress={() => void busy($, 'opening the dashboard…', () => cli($, ['dashboard', run.id])).then(r => say($, r.text))} />
            <Button hotkey="x" plain dimColor key="stop" label="x stop" onPress={() => void daemon($, false)} />
          </Box>
        </Box>
        <Text color="#26262e">{'─'.repeat(Math.max(1, inner))}</Text>
        {tabBody}
      </Box>
    )

    const center = (
      <Box flexDirection="column" width={wide ? centerW : undefined} flexGrow={wide ? 0 : 1}>
        {missionHead}
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
          {raster(`orb-${id}`, 4, 2, f => paint.orb(f, paint.hex(color), active, seed), <Text color={active ? pulse(n, color, '#ffffff', 0.4) : C.faint}>◉</Text>)}
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="truncate-end"><Text color="#fafafa" bold>{name}</Text><Text color={C.dim}>  {role}</Text></Text>
            <Text color={active ? color : C.dim} wrap="truncate-end">{active ? `${SPIN[(n + seed) % SPIN.length]} ` : ''}{state}</Text>
          </Box>
        </Box>
      )
    }
    const roles = run.roles ?? s.hierarchy
    const crew = (
      <Card title="CREW" right={<Text color={C.dim}>{run.workers.length} on the floor</Text>} width={sideCols}>
        <Agent id="sup" name={roles.supervisor} role="supervisor" state={run.leadership.supervisor} color={C.violet} seed={0} />
        <Agent id="lead" name={roles.lead} role="engineering lead" state={run.leadership.lead} color={C.cyan} seed={2} />
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
          <Text color={pulse(n, C.red, '#7f1d1d', 0.4)} wrap="truncate-end">⚠ {c.task} ⟂ {c.heldBy}  <Text color={C.dim}>{c.pattern}</Text></Text>
        ))}
      </Card>
    )
    const byAgent = tel.byAgent ?? []
    const maxCalls = Math.max(1, ...byAgent.map(a => a.calls))
    const meterW = Math.max(4, sideCols - 18)
    const meter = (
      <Card title="TELEMETRY" right={<Text color={C.yellow} bold>{tel.costUsd ? `$${tel.costUsd.toFixed(2)}` : ''}</Text>} width={sideCols}>
        <Text>
          <Text color="#fafafa" bold>{tel.calls}</Text><Text color={C.dim}> calls   </Text>
          <Text color={C.cyan}>↓ {compact(tel.inputTokens)}</Text><Text color={C.dim}>   </Text>
          <Text color={C.violet}>↑ {compact(tel.outputTokens)}</Text>
        </Text>
        {byAgent.map((a, i) => {
          const w = Math.max(1, Math.round((a.calls / maxCalls) * meterW))
          return (
            <Text wrap="truncate-end">
              <Text color={C.mute}>{a.agentId.padEnd(7).slice(0, 7)} </Text>
              {Array.from({ length: w }, (_, k) => <Text color={gradient(LOGO_GRADIENT, i / 5 + k / (meterW * 4))}>█</Text>)}
              <Text color="#26262e">{'█'.repeat(Math.max(0, meterW - w))}</Text>
              <Text color={C.dim}> {a.calls}</Text>
            </Text>
          )
        })}
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
      ['n', 'new'], ['v l', 'seats'], ['f g w', 'effort'], ['1-4', 'tabs'], ...(u.tab === 'minds' && minds.length > 1 ? ([['o', 'next mind']] as [string, string][]) : []), ...(s.runs.length > 1 ? ([['j k', 'missions']] as [string, string][]) : []),
      ['p', 'report'], ['d', 'dashboard'], ['x', 'stop'],
    ]
    return (
      <Box flexDirection="column">
        {hero}
        {wide ? (
          <Box minHeight={Math.max(10, rows - 6)}>
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
  }
}
