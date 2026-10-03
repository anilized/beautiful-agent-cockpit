// Raster scheduling, text tick and easing as the host sees them: mock clock, stubbed ui.blit, no real timers.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE, OFFLINE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

type Blit = { requestId: string; key: string; cells: string }
type Snap = Record<string, any>

let gen = 0
const snapJson = (s: Snap) => JSON.stringify({ ...s, generatedAt: `g${++gen}` })
const live = () => JSON.parse(LIVE) as Snap
const offline = () => JSON.parse(OFFLINE) as Snap
// A second live run, 1 of 4 tasks done, next to the 3-of-4 one in the fixture.
const twoLive = () => {
  const s = live()
  const b = structuredClone(s.runs[0])
  b.id = 'run_b'
  b.status = 'executing'
  b.tasks.forEach((t: Snap, i: number) => (t.status = i === 0 ? 'integrated' : 'running'))
  s.runs = [s.runs[0], b]
  s.pendingApprovals = []
  return s
}

async function boot($: any, on: any, snap: Snap, opts: { hold?: number; deny?: string[]; env?: Record<string, string> } = {}) {
  // The kit redraws lazily and offers no render hook, so the text tick is counted where it fires: one clock.every dispatch per period.
  const every: number[] = []
  const spy = ((name: string, ...rest: any[]) => {
    const h = rest.pop()
    return (on as any)(name, ...rest, name === 'clock.every' ? (c: unknown, e: { ms: number }, ...r: unknown[]) => (every.push(e.ms), h(c, e, ...r)) : h)
  }) as typeof on
  const clock = mock.clock(spy)
  const st = { snap: snapJson(snap), blits: [] as { t: number; key: string; cells: string }[], inflight: {} as Record<string, number>, maxInflight: {} as Record<string, number>, every }
  on('fs.read', async () => ({ value: st.snap }))
  mock.env(on, { COCKPIT_DATA_DIR: '/data', ...opts.env })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', async (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('ui.blit', async (_: unknown, e: Blit) => {
    st.blits.push({ t: await clock.now(), key: e.key, cells: e.cells })
    st.maxInflight[e.key] = Math.max(st.maxInflight[e.key] ?? 0, (st.inflight[e.key] = (st.inflight[e.key] ?? 0) + 1))
    try {
      if (opts.hold) await clock.sleep(opts.hold)
      return { value: opts.deny?.includes(e.key) ? { deny: 'full' } : {} } as never
    } finally {
      st.inflight[e.key]!--
    }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  return { clock, st, set: (s: Snap) => (st.snap = snapJson(s)) }
}

const perKey = (bl: { key: string }[]) => bl.reduce((m, b) => ((m[b.key] = (m[b.key] ?? 0) + 1), m), {} as Record<string, number>)
const pcts = async (ui: any) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).flatMap(x => /^\s*(\d+)%$/.exec(x.text)?.[1] ?? []).map(Number)

test('live @140: 16 ms raster loop, every key <=62 blits/s, text tick <=10 fps', async ($, on) => {
  const { clock, st } = await boot($, on, live())
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(1000)
  st.blits.length = 0
  st.every.length = 0
  await clock.advance(5000)
  const by = perKey(st.blits)
  expect(Object.keys(by)).toEqual(expect.arrayContaining(['hero', 'pipeline', 'progress', 'divider', 'orb-w0']))
  for (const [k, n] of Object.entries(by)) expect([k, n / 5 <= 63, n / 5 >= 30]).toEqual([k, true, true]) // ~60 fps, never faster than the 16 ms loop
  const text = st.every.filter(ms => ms === 125).length / 5 // the text tick fires once per period
  expect(text).toBeLessThanOrEqual(10)
  expect(text).toBeGreaterThanOrEqual(6) // and it does tick
  expect(st.every.filter(ms => ms === 16).length / 5).toBeGreaterThan(55)
  expect(st.every.filter(ms => ms > 16 && ms < 125)).toEqual([]) // no other fast timer
  await ui.unmount()
})

test('a denied key is unregistered while the others keep painting', async ($, on) => {
  const { clock, st } = await boot($, on, live(), { deny: ['pipeline'] })
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(800) // held 1 s after the deny, though every render redraws it
  const by = perKey(st.blits)
  expect(by.pipeline).toBe(1)
  expect(by.hero!).toBeGreaterThan(30)
  await ui.unmount()
})

test('a host that never resolves: at most one blit in flight per key', async ($, on) => {
  const { clock, st } = await boot($, on, live(), { hold: 1e9 })
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(5000)
  expect(Object.keys(st.maxInflight).length).toBeGreaterThan(3)
  for (const [k, n] of Object.entries(st.maxInflight)) expect([k, n]).toEqual([k, 1])
  expect(st.blits.length).toBeLessThanOrEqual(Object.keys(st.maxInflight).length)
  await ui.unmount()
})

test('zero blits after session.end', async ($, on) => {
  const { clock, st } = await boot($, on, live())
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(500)
  expect(st.blits.length).toBeGreaterThan(0)
  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
  st.blits.length = 0
  await clock.advance(1000)
  expect(st.blits.length).toBe(0)
  await ui.unmount()
})

test('a key that leaves the render is not blitted from the next tick', async ($, on) => {
  const { clock, st, set } = await boot($, on, live())
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(500)
  expect(perKey(st.blits).pipeline).toBeGreaterThan(0)
  set(offline()) // offline: only the hero remains
  await clock.advance(1100)
  st.blits.length = 0
  await clock.advance(1000)
  const by = perKey(st.blits)
  expect(by.hero).toBeGreaterThan(0)
  expect(Object.keys(by)).toEqual(['hero'])
  await ui.unmount()
})

for (const [name, snap] of [['offline', offline], ['no active run', () => ({ ...live(), runs: live().runs.map((r: Snap) => ({ ...r, status: 'completed' })), pendingApprovals: [] })]] as const) {
  test(`idle (${name}): <=2 blits/s in total, text tick <=1 fps`, async ($, on) => {
    const { clock, st } = await boot($, on, snap())
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
    await clock.advance(2000)
    st.blits.length = 0
    await clock.advance(10_000)
    // At rest only the hero (it carries the wall clock) is repainted by the scheduler: <=2 blits/s in total.
    expect(Object.keys(perKey(st.blits))).toEqual(['hero'])
    expect(st.blits.length / 10).toBeLessThanOrEqual(2.1)
    // No fast text tick: only the 1 s poll and the 1 s idle beat remain (>=1000 ms periods), plus the scheduler's slow 500 ms idle timer.
    st.every.length = 0
    await clock.advance(10_000)
    expect(st.every.filter(ms => ms < 500)).toEqual([]) // no 16 ms loop, no 125 ms text tick
    expect(st.every.filter(ms => ms === 1000).length / 10).toBeLessThanOrEqual(2)
    await ui.unmount()
  })
}

test('COCKPIT_REDUCED_MOTION=1: animation time frozen, status changes still render', async ($, on) => {
  const { clock, st, set } = await boot($, on, live(), { env: { COCKPIT_REDUCED_MOTION: '1' } })
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(1100)
  const cellsOf = async () => {
    const m = new Map<string, string>()
    const walk = (n: any) => {
      if (n?.type === 'Raster') m.set(n.props.key, n.props.cells)
      for (const c of n?.children ?? []) if (typeof c !== 'string') walk(c)
    }
    walk(await ui.drawn())
    return m
  }
  const a = await cellsOf()
  expect(a.size).toBeGreaterThan(5)
  st.blits.length = 0
  await clock.advance(5000)
  expect(Object.keys(perKey(st.blits)).filter(k => k !== 'hero')).toEqual([]) // nothing but the clock-bearing hero is repainted
  expect(st.blits.length / 5).toBeLessThanOrEqual(2.1)
  const b = await cellsOf()
  for (const [k, cells] of a) if (k !== 'hero') expect([k, b.get(k)]).toEqual([k, cells]) // hero carries the wall clock string
  expect(await ui.find({ type: 'Text', text: /AWAITING APPROVAL/ })).toBeDefined()
  const next = live()
  next.runs[0].status = 'executing'
  set(next)
  await clock.advance(1200)
  expect(await ui.find({ type: 'Text', text: /EXECUTING/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /AWAITING APPROVAL/ })).toBeUndefined()
  await ui.unmount()
})

test('progress eases between snapshots of one run, snaps on a run switch', async ($, on) => {
  const { clock, set } = await boot($, on, twoLive())
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(1000)
  expect((await pcts(ui))[0]).toBe(75)
  await ui.press({ key: 'next' }) // run_b: 25%, no easing from run A's 75
  expect((await pcts(ui))[0]).toBe(25)
  await clock.advance(1000)
  expect((await pcts(ui))[0]).toBe(25)
  const s = twoLive()
  s.runs[1].tasks.forEach((t: Snap) => (t.status = 'integrated'))
  set(s)
  await clock.advance(1100) // snapshot lands on the next poll, then the ease starts
  await clock.advance(150)
  const mid = (await pcts(ui))[0]!
  expect(mid).toBeGreaterThan(25)
  expect(mid).toBeLessThan(100)
  await clock.advance(1500)
  expect((await pcts(ui))[0]).toBe(100)
  await ui.unmount()
})

test('tweens snap on remount (no host unmount event: a render gap past the idle beat resets them)', async ($, on) => {
  const { clock, set } = await boot($, on, twoLive())
  let ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await clock.advance(1000)
  expect((await pcts(ui))[0]).toBe(75)
  await ui.unmount()
  const s = twoLive()
  s.runs[0].tasks.forEach((t: Snap) => (t.status = 'integrated'))
  set(s)
  await clock.advance(2000) // snapshot lands while unmounted; the gap exceeds the stale window
  ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  expect((await pcts(ui))[0]).toBe(100)
  await ui.unmount()
})
