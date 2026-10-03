import { expect, test } from 'claude-code/testing'

import { CADENCE, HOST_LIMITS, createTrace, readGates, resolveCadence, writeTrace, type TraceDump, type TraceKind } from '../hooks/limits'

const env = (m: Record<string, string>) => (n: string) => m[n]

test('resolveCadence: unset, invalid and valid values', () => {
  expect(resolveCadence(undefined).name).toBe('conservative')
  expect(resolveCadence(null).name).toBe('conservative')
  expect(resolveCadence({}).name).toBe('conservative')
  expect(resolveCadence('turbo').name).toBe('conservative')
  expect(resolveCadence('').name).toBe('conservative')
  expect(resolveCadence({ COCKPIT_CADENCE: 'nope' }).name).toBe('conservative')
  expect(resolveCadence('full').name).toBe('full')
  expect(resolveCadence('conservative')).toEqual({ name: 'conservative', ...CADENCE.conservative })
  expect(CADENCE.conservative).toEqual({ totalPerSec: 60, tierAFps: 30, tierBFps: 15, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 })
})

test('readGates: all off by default, read once through the injected accessor', async () => {
  const g = await readGates(env({}))
  expect(g.trace).toBe(false)
  expect(g.reducedMotion).toBe(false)
  expect(g.cadence.name).toBe('conservative')
  const on = await readGates(env({ COCKPIT_TRACE: '1', COCKPIT_REDUCED_MOTION: 'true', COCKPIT_CADENCE: 'full' }))
  expect([on.trace, on.reducedMotion, on.cadence.name]).toEqual([true, true, 'full'])
})

test('trace off: no recording, no export, no file, no output', async () => {
  const t = createTrace((await readGates(env({}))).trace)
  expect(t.on).toBe(false)
  t.record('hero', 'start', 1, 2)
  const dump = t.exportTrace(10)
  expect(dump).toBe(null)
  const writes: string[] = []
  const r = await writeTrace({ dataDir: 'data', write: async p => void writes.push(p) }, dump)
  expect(r).toBe(null)
  expect(writes.length).toBe(0)
})

test('export round-trip: mock host events over several keys, ring wrap keeps chronological order', async () => {
  const ring = 4, cad = resolveCadence('conservative')
  const t = createTrace(true, cad, ring)
  const kinds: TraceKind[] = ['start', 'resolve', 'skip', 'deny']
  const expected: Record<string, { t: number; kind: TraceKind; paintMs: number }[]> = { hero: [], pipeline: [], divider: [] }
  const counts: Record<string, number> = { hero: 10, pipeline: 4, divider: 2 } // wraps, exactly full, not full
  let clock = 0
  for (const key of Object.keys(expected))
    for (let i = 0; i < counts[key]!; i++) {
      const e = { t: (clock += 7), kind: kinds[i % 4]!, paintMs: i / 4 }
      t.record(key, e.kind, e.t, e.paintMs)
      expected[key]!.push(e)
    }
  for (const k of Object.keys(expected)) expected[k] = expected[k]!.slice(-ring)
  const writes: { path: string; text: string }[] = []
  const out = await writeTrace({ dataDir: 'data', write: async (path, text) => void writes.push({ path, text }) }, t.exportTrace(clock))
  expect(out).toEqual({ path: 'data/trace.json' })
  const parsed = JSON.parse(writes[0]!.text) as TraceDump
  expect(parsed.version).toBe(1)
  expect(parsed.cadence).toEqual(cad)
  expect(parsed.hostLimits).toEqual(JSON.parse(JSON.stringify(HOST_LIMITS)))
  expect(parsed.keys).toEqual(expected)
  const ts = parsed.keys.hero!.map(e => e.t)
  expect(ts).toEqual([...ts].sort((a, b) => a - b))
})

test('writeTrace without a data-dir write API returns the serialized dump', async () => {
  const t = createTrace(true)
  t.record('hero', 'start', 1, 0.5)
  const r = await writeTrace({}, t.exportTrace())
  expect(r && 'text' in r ? JSON.parse(r.text).keys.hero : null).toEqual([{ t: 1, kind: 'start', paintMs: 0.5 }])
})

test('HOST_LIMITS: exactly 7 tagged fields, each with a cite or none', () => {
  const f = Object.entries(HOST_LIMITS) as [string, { tag: string; cite: string }][]
  expect(f.map(([k]) => k)).toEqual(['blitRateCap', 'framesShownPerSec', 'payloadCapBytes', 'colorPairCap', 'clockMinPeriodMs', 'panesCostMs', 'realTerminalFps'])
  for (const [k, v] of f) {
    expect(['documented', 'default', 'unverified'], k).toContain(v.tag)
    expect(v.cite.length, k).toBeGreaterThan(0)
    if (v.tag === 'documented') expect(v.cite, k).toMatch(/d\.ts:\d+/)
  }
})
