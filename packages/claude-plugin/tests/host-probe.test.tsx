// Host capability probe, run by `claude plugin test` (and `npm run probe`, which keeps the PROBE lines in tests/evidence).
// Everything here runs on the mocked clock: counts are deterministic scheduler behaviour, timings are harness CPU,
// never terminal delivery (the kit "exercises the mod, never a surface's paint").
import { expect, mock, test } from 'claude-code/testing'

import { LIVE } from './fixture'

declare const console: { log(...a: unknown[]): void }
const log = (k: string, v: unknown) => console.log(`PROBE ${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

type Blit = { requestId: string; key: string; cells: string; columns?: number; rows?: number }

async function boot($: any, on: any, hold = 0, deny?: (b: Blit) => boolean) {
  const clock = mock.clock(on)
  const stats = { total: 0, inflight: 0, maxInflight: 0, byKey: {} as Record<string, number>, denied: 0 }
  on('fs.read', async () => ({ value: LIVE }))
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('ui.blit', async (_: unknown, e: Blit) => {
    stats.total++
    stats.byKey[e.key] = (stats.byKey[e.key] ?? 0) + 1
    stats.maxInflight = Math.max(stats.maxInflight, ++stats.inflight)
    try {
      if (hold) await clock.sleep(hold)
      if (deny?.(e)) return (stats.denied++, { value: { deny: 'probe' } }) as never
      return { value: {} } as never
    } finally {
      stats.inflight--
    }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  return { clock, stats }
}

for (const cols of [60, 140]) {
  test(`blit cadence, backpressure and latency @${cols} cols (current code)`, async ($, on) => {
    const { clock, stats } = await boot($, on)
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
    const rasters = await ui.findAll({ type: 'Raster' })
    const keys = rasters.map(r => `${r.key}:${r.props.columns}x${r.props.rows}`)
    log(`rasters@${cols}`, { count: rasters.length, keys })
    stats.total = 0
    stats.byKey = {}
    const t0 = performance.now()
    await clock.advance(1000)
    const cpu = performance.now() - t0
    log(`1s mock, instant blits @${cols}`, { blitsPerSec: stats.total, perKey: stats.byKey, maxInflight: stats.maxInflight, harnessMsFor1s: +cpu.toFixed(1) })
    expect(stats.total).toBeGreaterThan(0)

    // Input latency (harness wall time of one press, instant blit hook).
    const lat: number[] = []
    for (let i = 0; i < 20; i++) {
      const p = performance.now()
      await ui.press({ key: i % 2 ? 'tab-events' : 'tab-tasks' })
      lat.push(performance.now() - p)
    }
    lat.sort((a, b) => a - b)
    log(`press latency ms @${cols} (instant blits)`, { p50: +lat[10]!.toFixed(2), p95: +lat[18]!.toFixed(2), max: +lat[19]!.toFixed(2) })
    await ui.unmount()
  })

  test(`unresolved blits pile up @${cols} cols (current code has no backpressure)`, async ($, on) => {
    const { clock, stats } = await boot($, on, 500)
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
    stats.total = 0
    await clock.advance(1000)
    log(`slow host (500ms/blit) 1s @${cols}`, { started: stats.total, maxInflight: stats.maxInflight, inflightAtEnd: stats.inflight })
    expect(stats.maxInflight).toBeGreaterThan(1)
    const p = performance.now()
    await ui.press({ key: 'tab-events' })
    log(`press with ${stats.inflight} blits pending @${cols} (harness ms)`, +(performance.now() - p).toFixed(2))
    await ui.unmount()
  })
}

test('deny semantics: current code unregisters on any deny, stale or not', async ($, on) => {
  let denyHero = true
  const { clock, stats } = await boot($, on, 0, b => denyHero && b.key === 'hero')
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  stats.total = 0
  stats.byKey = {}
  await clock.advance(500)
  const afterDeny = stats.byKey.hero ?? 0
  denyHero = false
  await clock.advance(500)
  log('hero blits during 500ms with deny, then 500ms accepting', { duringDeny: afterDeny, total: stats.byKey.hero ?? 0, note: 'a deny drops the key, but the next 125 ms text render re-registers it: stale-deny guard needed' })
  await ui.unmount()
})
