import { expect, test } from 'claude-code/testing'

import { CADENCE } from '../hooks/limits'
import { createScheduler, type BlitResult, type KeySpec } from '../hooks/scheduler'

type Timer = { at: number; period?: number; fn: () => void }
// Deterministic fake clock: kill() ends every() the way a refused period does (d.ts:3228-3231).
const fakeClock = () => {
  let time = 0
  const timers = new Set<Timer>()
  const add = (ms: number, fn: () => void, period?: number): (() => void) => {
    const t: Timer = { at: time + ms, period, fn }
    timers.add(t)
    return () => void timers.delete(t)
  }
  return {
    now: () => time,
    every: (ms: number, fn: () => void) => add(ms, fn, ms),
    after: (ms: number, fn: () => void) => add(ms, fn),
    everyActive: () => [...timers].filter(t => t.period).length,
    kill() { for (const t of [...timers]) if (t.period) timers.delete(t) },
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        let next: Timer | undefined
        for (const t of timers) if (t.at <= end && (!next || t.at < next.at)) next = t
        if (!next) break
        time = next.at
        if (next.period) next.at += next.period
        else timers.delete(next)
        next.fn()
        for (let i = 0; i < 4; i++) await Promise.resolve()
      }
      time = end
    },
  }
}

type Pending = { key: string; res: (r: BlitResult) => void; t: number }
// instant resolves at once, never leaves blits unresolved, manual lets the test resolve them.
const fakeHost = (clock: ReturnType<typeof fakeClock>, mode: 'instant' | 'never' | 'manual' = 'instant') => {
  const log: { key: string; t: number }[] = []
  const pending: Pending[] = []
  let deny = false
  const h = {
    mode, log, pending, setDeny: (d: boolean) => (deny = d),
    blit: (key: string): Promise<BlitResult> => {
      log.push({ key, t: clock.now() })
      if (h.mode === 'instant') return Promise.resolve(deny ? { deny: true } : {})
      return new Promise(res => { if (h.mode === 'manual') pending.push({ key, res, t: clock.now() }) })
    },
    count: (key?: string) => log.filter(l => !key || l.key === key).length,
  }
  return h
}

const spec = (tier: 'A' | 'B', id?: number): KeySpec => ({ tier, paint: t => `cells@${t}`, id })
const live140 = () => new Map<string, KeySpec>([
  ['hero', spec('A')], ['pipeline', spec('A')], ['progress', spec('B')], ['spark', spec('B')], ['divider', spec('B')],
  ['underline', spec('B')], ['telemetry', spec('B')], ['orb0', spec('B')], ['orb1', spec('B')], ['orb2', spec('B')],
])
const setup = (mode: 'instant' | 'never' | 'manual' = 'instant') => {
  const clock = fakeClock()
  const host = fakeHost(clock, mode)
  const s = createScheduler({ clock, blit: host.blit })
  return { clock, host, s }
}
const flush = (host: ReturnType<typeof fakeHost>) => host.pending.splice(0).forEach(p => p.res({}))

test('(a) never-resolving host: in-flight <=1 per key over 5 s, skipped not queued', async () => {
  const { clock, host, s } = setup('never')
  s.sync(live140())
  await clock.advance(5000)
  const keys = new Set(host.log.map(l => l.key))
  expect(keys.size).toBe(10)
  for (const k of keys) expect(host.count(k)).toBe(1)
  expect(s.stats().pending).toBe(10)
})

test('deny still unregisters the key', async () => {
  const { clock, host, s } = setup()
  host.setDeny(true)
  s.sync(new Map([['hero', spec('A')]]))
  await clock.advance(200)
  expect(host.count('hero')).toBe(1)
  expect(s.stats().live).toBe(0)
  expect(clock.everyActive()).toBe(0)
})

test('(b) zero blits after close and after end', async () => {
  for (const stop of ['close', 'end'] as const) {
    const { clock, host, s } = setup('manual')
    s.sync(live140())
    await clock.advance(100)
    const n = host.count()
    expect(n).toBeGreaterThan(0)
    s[stop]()
    flush(host)
    await clock.advance(2000)
    expect(host.count()).toBe(n)
    expect(s.stats()).toMatchObject({ live: 0, pending: 0 })
  }
})

test('(c) dropped key is not blitted from the next tick', async () => {
  const { clock, host, s } = setup()
  s.sync(live140())
  await clock.advance(500)
  const m = live140()
  m.delete('orb2')
  s.sync(m)
  const n = host.count('orb2')
  await clock.advance(1000)
  expect(host.count('orb2')).toBe(n)
  expect(host.count('hero')).toBeGreaterThan(8)
})

test('(d) timer stops when there are no live keys', async () => {
  const { clock, host, s } = setup()
  s.sync(new Map([['hero', spec('A')]]))
  expect(clock.everyActive()).toBe(1)
  s.sync(new Map())
  expect(clock.everyActive()).toBe(0)
  const n = host.count()
  await clock.advance(1000)
  expect(host.count()).toBe(n)
})

test('(e) 140-col live set for 10 s: <=60 blits/s total, Tier A <=30 fps, far below 112', async () => {
  const { clock, host, s } = setup()
  s.sync(live140())
  await clock.advance(10_000)
  expect(host.count() / 10).toBeLessThanOrEqual(CADENCE.conservative.totalPerSec)
  expect(host.count() / 10).toBeLessThan(112)
  expect(host.count('hero') / 10).toBeLessThanOrEqual(30)
  expect(host.count('pipeline') / 10).toBeLessThanOrEqual(30)
  for (const k of ['progress', 'spark', 'divider', 'underline', 'telemetry', 'orb0', 'orb1', 'orb2']) {
    expect(host.count(k) / 10).toBeLessThanOrEqual(15)
    expect(host.count(k)).toBeGreaterThan(0)
  }
  for (let sec = 0; sec < 10; sec++) expect(host.log.filter(l => l.t > sec * 1000 && l.t <= (sec + 1) * 1000).length).toBeLessThanOrEqual(61)
})

test('(f) watchdog: refused period kills the interval, re-arm, late old-gen resolve ignored', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A')]]))
  await clock.advance(100)
  const old = host.pending.filter(p => p.key === 'hero')
  expect(old.length).toBe(1)
  const g0 = s.stats().gen
  clock.kill()
  expect(clock.everyActive()).toBe(0)
  await clock.advance(400)
  expect(clock.everyActive()).toBe(1)
  expect(s.stats().gen).toBeGreaterThan(g0)
  // the stuck old blit was aborted: hero has a fresh blit holding the new slot
  const fresh = host.pending.filter(p => p.key === 'hero' && p !== old[0])
  expect(fresh.length).toBe(1)
  const n = host.count('hero')
  old[0]!.res({}) // late resolve from the old generation
  await clock.advance(100)
  expect(host.count('hero')).toBe(n) // did not free the new slot: still skipped, in-flight <=1
  expect(s.stats().pending).toBe(1)
  fresh[0]!.res({})
  await clock.advance(100)
  expect(host.count('hero')).toBeGreaterThan(n)
})

test('(g) stale deny does not unregister the replacement', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A', 1)]]))
  await clock.advance(50)
  const stale = host.pending.find(p => p.key === 'hero')!
  s.sync(new Map([['hero', spec('A', 2)]])) // replaced raster
  stale.res({ deny: true })
  await clock.advance(100)
  expect(s.stats().live).toBe(1)
  expect(clock.everyActive()).toBe(1)
  const n = host.count('hero')
  await clock.advance(100)
  expect(host.count('hero')).toBeGreaterThanOrEqual(n)
  flush(host)
  host.mode = 'instant'
  await clock.advance(200)
  expect(host.count('hero')).toBeGreaterThan(n)
})

test('(h) degrade halves Tier A and restores after 2 s healthy', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A')]]))
  await clock.advance(100) // first blit unresolved >2 frame budgets
  expect(s.stats().degraded).toBe(true)
  flush(host)
  host.mode = 'instant'
  await clock.advance(100)
  const t0 = clock.now()
  await clock.advance(1000)
  const degradedN = host.log.filter(l => l.t > t0).length
  expect(degradedN).toBeLessThanOrEqual(CADENCE.conservative.tierAFps / 2 + 1)
  await clock.advance(1500)
  expect(s.stats().degraded).toBe(false)
  const t1 = clock.now()
  await clock.advance(1000)
  const restored = host.log.filter(l => l.t > t1).length
  expect(restored).toBeGreaterThan(degradedN)
  expect(restored).toBeLessThanOrEqual(CADENCE.conservative.tierAFps)
})

test('(i) idle: <=2 fps per key with motion off, back to frame rate on motion', async () => {
  const { clock, host, s } = setup()
  s.setMotion(false)
  s.sync(live140())
  expect(s.stats().timerMs).toBeGreaterThanOrEqual(500)
  await clock.advance(10_000)
  for (const k of ['hero', 'orb0', 'spark']) expect(host.count(k) / 10).toBeLessThanOrEqual(2)
  expect(host.count('hero')).toBeGreaterThan(0)
  s.setMotion(true)
  expect(s.stats().timerMs).toBe(16)
  s.sync(new Map())
  expect(clock.everyActive()).toBe(0)
})

test('panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving', async () => {
  const clock = fakeClock()
  const host = fakeHost(clock)
  let polls = 0
  const s = createScheduler({ clock, blit: host.blit, probeLive: async () => (polls++, new Set(['hero'])) })
  s.sync(new Map([['hero', spec('A')], ['spark', spec('B')]]))
  await clock.advance(3000)
  expect(polls).toBe(0)
  s.setMotion(false)
  await clock.advance(10_000)
  expect(polls).toBeGreaterThan(0)
  expect(polls).toBeLessThanOrEqual(11)
  const n = host.count('spark')
  await clock.advance(2000) // spark is not in the live set: not painted
  expect(host.count('spark')).toBe(n)
})

test('urgent repaint uses the reserve and still respects one pending slot', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A')]]))
  await clock.advance(1000)
  flush(host)
  await clock.advance(1)
  flush(host)
  const n = host.count('hero')
  expect(s.urgent('hero')).toBe(true)
  expect(host.count('hero')).toBe(n + 1)
  expect(s.urgent('hero')).toBe(false) // pending
  expect(s.urgent('nope')).toBe(false)
})
