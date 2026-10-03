// Text fallbacks, hotkeys, backpressure through the real wiring, close/end and the opt-in trace export.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE, OFFLINE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

type Snap = Record<string, any>
type Node = { type: string; props?: Record<string, unknown>; children?: (string | Node)[] }
let gen = 0
const snapJson = (s: Snap) => JSON.stringify({ ...s, generatedAt: `f${++gen}` })
const live = () => JSON.parse(LIVE) as Snap
const textOf = (n: string | Node): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))
const width = (s: string) => [...s].length // the fallbacks use single-cell glyphs only

async function boot($: any, on: any, snap: Snap, opts: { blit?: (key: string) => Promise<unknown>; env?: Record<string, string> } = {}) {
  const clock = mock.clock(on)
  const st = { snap: snapJson(snap), blits: [] as string[], procs: [] as string[][], writes: [] as { path: string; text: string }[], proc: { exitCode: 0, stdout: 'ok', stderr: '' } }
  on('fs.read', async () => ({ value: st.snap }))
  on('fs.write', async (_: unknown, e: { path: string; text: string }) => (st.writes.push({ path: e.path, text: e.text }), { value: undefined }) as never)
  mock.env(on, { COCKPIT_DATA_DIR: '/data', ...opts.env })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('session.end', async (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: undefined }) as never)
  on('process.run', async (_: unknown, e: { argv: string[] }) => (st.procs.push(e.argv), { value: st.proc }) as never)
  on('ui.blit', async (_: unknown, e: { key: string }) => (st.blits.push(e.key), (opts.blit ? opts.blit(e.key) : { value: {} }) as never))
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  return { clock, st, set: (s: Snap) => (st.snap = snapJson(s)) }
}

const mountTerminal = ($: any, cols = 140) => $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
const cmd = ($: any, args: string) => $.command.run({ command: 'cockpit', args } as never)
const endSession = ($: any) => $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
const lastArgs =(st: { procs: string[][] }) => st.procs.at(-1)?.slice(2) ?? []

test('hotkeys s n a c r e i 1 2 3 j k p t x each stay bound to their action', async ($, on) => {
  const withApproval = () => {
    const s = live()
    const b = structuredClone(s.runs[0])
    b.id = 'run_b'
    s.runs = [s.runs[0], b]
    return s
  }
  const { clock, st, set } = await boot($, on, JSON.parse(OFFLINE))
  let ui = await mountTerminal($)
  // s: offline start
  const start = await ui.find({ type: 'Button', text: /s · Start/ })
  expect(start?.props.hotkey).toBe('s')
  await ui.press({ key: String(start?.props.key ?? (start as any)?.key) })
  expect(lastArgs(st)).toEqual(expect.arrayContaining(['daemon']))
  await ui.unmount()

  set(withApproval())
  await clock.advance(1100)
  ui = await mountTerminal($)
  const hot = async (key: string, hotkey: string) => {
    const b = await ui.find({ key })
    expect([key, b?.props.hotkey]).toEqual([key, hotkey])
  }
  await hot('approve-apr_1', 'a')
  await hot('changes-apr_1', 'c')
  await hot('reject-apr_1', 'r')
  await hot('n · New mission', 'n')
  await hot('tab-tasks', '1')
  await hot('tab-events', '2')
  await hot('tab-report', '3')
  await hot('prev', 'k')
  await hot('next', 'j')
  await hot('report', 'p')
  await hot('stop', 'x')

  await ui.press({ key: 'approve-apr_1' })
  expect(lastArgs(st)).toEqual(expect.arrayContaining(['approve', 'apr_1']))
  await ui.press({ key: 'reject-apr_1' })
  expect(lastArgs(st)).toEqual(expect.arrayContaining(['reject', 'apr_1']))
  await ui.press({ key: 'changes-apr_1' })
  expect(await ui.find({ key: 'changes-apr_1-0' })).toBeDefined()
  await ui.press({ key: 'cancel-changes' })
  await ui.press({ key: 'tab-events' })
  expect(await ui.find({ type: 'Text', text: /\d\d:\d\d:\d\d / })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /2\/2/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await ui.press({ key: 'report' })
  expect(lastArgs(st)).toEqual(expect.arrayContaining(['report']))
  await ui.press({ key: 'n · New mission' })
  expect(await ui.find({ key: 'compose-0' })).toBeDefined()
  await ui.press({ key: 'cancel-run' })
  await ui.press({ key: 'stop' })
  expect(lastArgs(st)).toEqual(['stop'])
  await ui.unmount()

  // t: retry, offered on a failed run
  const failed = withApproval()
  failed.runs[0].status = 'failed'
  failed.pendingApprovals = []
  set(failed)
  await clock.advance(1100)
  ui = await mountTerminal($)
  await hot('retry', 't')
  await ui.press({ key: 'retry' })
  expect(lastArgs(st)).toEqual(expect.arrayContaining(['retry']))
  await ui.unmount()

  // e / i: the launch failure card
  set(live())
  st.proc = { exitCode: 1, stdout: '', stderr: 'error: /repo has no commits yet; commit something first' }
  await clock.advance(1100)
  ui = await mountTerminal($, 100)
  await ui.press({ key: 'new' })
  await ui.input({ key: 'compose-0', text: 'add a readme' })
  expect((await ui.find({ key: 'init-commit' }))?.props.hotkey).toBe('i')
  expect((await ui.find({ key: 'edit-failed' }))?.props.hotkey).toBe('e')
  st.procs.length = 0
  await ui.press({ key: 'init-commit' })
  expect(st.procs.length).toBeGreaterThan(0)
  await ui.press({ key: 'edit-failed' })
  expect(await ui.find({ key: 'compose-1' })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`text fallbacks stay within bodyColumns (${surface}): ▔ underline, ▕ meters, divider rule`, async ($, on) => {
    await boot($, on, live())
    let fallback = 0
    for (const cols of [60, 100, 140]) {
      const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface, ...pane(cols) })
      const texts: Node[] = []
      const walk = (n: string | Node) => typeof n !== 'string' && (n.type === 'Text' ? texts.push(n) : n.children?.forEach(walk))
      walk((await ui.drawn()) as Node)
      for (const t of texts) {
        const wrap = String(t.props?.wrap)
        for (const line of textOf(t).split('\n')) {
          const glyphs = /[▔▕]/.test(line) || /^─+$/.test(line.trim())
          if (glyphs) fallback++
          if (wrap.startsWith('truncate') && !glyphs) continue // the host clips it
          const w = glyphs || wrap !== 'wrap' ? width(line) : Math.max(0, ...line.split(/\s+/).map(width)) // wrapped prose breaks at spaces
          expect([surface, cols, line.slice(0, 40), w <= cols]).toEqual([surface, cols, line.slice(0, 40), true])
        }
      }
      if (surface !== 'terminal') expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      if (surface === 'desktop') expect(texts.some(t => textOf(t).includes('▔'))).toBe(true) // the tab underline has a designed text form
      await ui.unmount()
    }
    if (surface === 'desktop') expect(fallback).toBeGreaterThan(0)
  })
}

test('desktop: no raster, no blits, hero and telemetry as text', async ($, on) => {
  const { clock, st } = await boot($, on, live())
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(100) })
  await clock.advance(3000)
  expect(st.blits).toEqual([])
  expect(await ui.find({ type: 'Text', text: /AGENT COCKPIT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▕/ })).toBeDefined() // telemetry bars
  await ui.unmount()
})

test('a blit the host denies unregisters its key and is not hammered; a never-resolving blit is skipped', async ($, on) => {
  const { clock, st } = await boot($, on, live(), { blit: async key => (key === 'hero' ? ({ value: { deny: 'full' } } as never) : new Promise(() => {})) })
  const ui = await mountTerminal($)
  await clock.advance(5000)
  const by = st.blits.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {} as Record<string, number>)
  for (const [k, n] of Object.entries(by)) if (k !== 'hero') expect([k, n]).toEqual([k, 1]) // never resolved: one in flight, the rest skipped
  // denied: unregistered and held for DENY_HOLD_MS (2 s), then retried: ~3 blits in 5 s, not the tier rate
  expect(by.hero).toBeGreaterThanOrEqual(2)
  expect(by.hero).toBeLessThanOrEqual(4)
  const n = by.hero!
  await clock.advance(1000)
  expect(st.blits.filter(k => k === 'hero').length).toBeLessThanOrEqual(n + 1)
  await ui.unmount()
})

test('a late deny after session.end has no effect (no blits, no throw)', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  const { clock, st } = await boot($, on, live(), { blit: key => (key === 'hero' ? new Promise(r => (release = r)) : Promise.resolve({ value: {} })) })
  const ui = await mountTerminal($)
  await clock.advance(300)
  await ui.unmount()
  await endSession($)
  st.blits.length = 0
  release({ value: { deny: 'full' } })
  await clock.advance(3000)
  expect(st.blits).toEqual([])
})

test('trace off: no file and no output from session.end or the command', async ($, on) => {
  const { clock, st } = await boot($, on, live())
  const ui = await mountTerminal($)
  await clock.advance(1000)
  await ui.unmount()
  expect((await cmd($, 'trace')) as any).toMatchObject({ text: expect.stringContaining('off') })
  await endSession($)
  expect(st.writes).toEqual([])
})

test('trace on: nothing is written while running; session.end exports chronological ring buffers; the command returns the dump', async ($, on) => {
  const { clock, st } = await boot($, on, live(), { env: { COCKPIT_TRACE: '1' } })
  const ui = await mountTerminal($)
  await clock.advance(20_000) // > 256 hero events: the ring wraps
  expect(st.writes).toEqual([])
  const dumped = (await cmd($, 'trace')) as { text: string }
  await ui.unmount()
  await endSession($)
  expect(st.writes).toHaveLength(1)
  expect(st.writes[0]!.path.split('\\').join('/')).toMatch(/data\/trace\.json$/)
  const dump = JSON.parse(st.writes[0]!.text)
  expect(dump).toMatchObject({ version: 1, cadence: { name: 'conservative' } })
  expect(dump.hostLimits.blitRateCap).toBeDefined()
  const hero = dump.keys.hero as { t: number; kind: string; paintMs: number }[]
  expect(hero.length).toBe(256)
  expect(hero.every((e, i) => i === 0 || e.t >= hero[i - 1]!.t)).toBe(true)
  expect(hero.every(e => ['start', 'resolve', 'skip', 'deny'].includes(e.kind))).toBe(true)
  expect(JSON.parse(dumped.text).version).toBe(1)
  const n = st.writes.length
  await clock.advance(5000)
  expect(st.writes.length).toBe(n) // no periodic export
})
