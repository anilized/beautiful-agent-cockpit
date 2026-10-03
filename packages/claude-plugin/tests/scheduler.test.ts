import { expect, test } from 'claude-code/testing'

import { CADENCE } from '../hooks/limits'
import { createScheduler, makeClock, makeSyncClock, type BlitResult, type KeySpec, type RasterSpec } from '../hooks/scheduler'

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
  expect(host.count() / 10).toBeGreaterThanOrEqual(45) // budget is realised, not truncated
  expect(host.count('hero') / 10).toBeGreaterThanOrEqual(10)
  expect(host.count('pipeline') / 10).toBeGreaterThanOrEqual(10)
  expect(host.count('hero') / 10).toBeLessThanOrEqual(30)
  expect(host.count('pipeline') / 10).toBeLessThanOrEqual(30)
  for (const k of ['progress', 'spark', 'divider', 'underline', 'telemetry', 'orb0', 'orb1', 'orb2']) {
    expect(host.count(k) / 10).toBeLessThanOrEqual(15)
    expect(host.count(k) / 10).toBeGreaterThanOrEqual(2)
  }
  for (let sec = 0; sec < 10; sec++) expect(host.log.filter(l => l.t > sec * 1000 && l.t <= (sec + 1) * 1000).length).toBeLessThanOrEqual(61)
})

test('(f) watchdog: refused period kills the interval, re-arm, late old-gen resolve does not clear the new slot', async () => {
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
  // F2: the old blit is still in flight host side, so no second blit is sent for the key
  expect(host.count('hero')).toBe(1)
  expect(s.stats().pending).toBe(1)
  old[0]!.res({}) // late resolve from the old generation: frees only its own slot, no other effect
  await clock.advance(100)
  expect(host.count('hero')).toBeGreaterThan(1)
  expect(host.pending.filter(p => p.key === 'hero' && p !== old[0]).length).toBe(1) // in-flight <=1
  const g1 = s.stats().gen
  const fresh = host.pending.find(p => p.key === 'hero' && p !== old[0])!
  const n = host.count('hero')
  fresh.res({})
  old[0]!.res({}) // double resolve of a dead token is dropped
  await clock.advance(50)
  expect(s.stats().gen).toBe(g1)
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

test('(i) idle: total <=2/s, hero only, back to frame rate on motion', async () => {
  const { clock, host, s } = setup()
  s.setMotion(false)
  s.sync(live140())
  expect(s.stats().timerMs).toBeLessThanOrEqual(500)
  await clock.advance(10_000)
  expect(host.count() / 10).toBeLessThanOrEqual(2)
  expect(host.count('hero')).toBe(host.count())
  expect(host.count('hero')).toBeGreaterThan(0)
  s.setMotion(true)
  expect(s.stats().timerMs).toBe(16)
  s.sync(new Map())
  expect(clock.everyActive()).toBe(0)
})

test('deny unregisters even after an unrelated generation bump', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A', 1)], ['spark', spec('B', 1)]]))
  await clock.advance(50)
  const d = host.pending.find(p => p.key === 'hero')!
  s.sync(new Map([['hero', spec('A', 1)]])) // spark dropped: gen bump, hero unchanged
  d.res({ deny: true })
  await clock.advance(10)
  expect(s.stats().live).toBe(0)
})

test('a stalled blit keeps its slot: no second blit until it resolves', async () => {
  const { clock, host, s } = setup('manual')
  s.sync(new Map([['hero', spec('A')]]))
  await clock.advance(10_000)
  expect(host.count('hero')).toBe(1)
  expect(s.stats().pending).toBe(1)
  flush(host)
  await clock.advance(100)
  expect(host.count('hero')).toBeGreaterThan(1)
})

test('burst cap: throughput near the refill rate at 16 ms and in idle at 500 ms', async () => {
  const { clock, host, s } = setup()
  s.sync(live140())
  await clock.advance(10_000)
  expect(host.count() / 10).toBeGreaterThanOrEqual(0.8 * CADENCE.conservative.totalPerSec * (1 - CADENCE.conservative.urgentReserve))
  const idle = setup()
  idle.s.setMotion(false)
  idle.s.sync(new Map([['hero', spec('A')]]))
  await idle.clock.advance(10_000)
  expect(idle.host.count() / 10).toBeGreaterThanOrEqual(1.8)
})

test('makeSyncClock: sync reads, one prefetch in flight, local source advances', async () => {
  let wall = 1000, calls = 0, local = 0
  const c = makeSyncClock(async () => (calls++, wall), () => local)
  expect(c.now()).toBe(0)
  const a = c.refresh(), b = c.refresh()
  await Promise.all([a, b])
  expect(calls).toBe(1)
  local = 16
  expect(c.now()).toBe(1016)
  wall = 5000
  await c.refresh()
  expect(c.now()).toBe(5000)
})

test('panes() polling: <=1 Hz, only idle or degraded, never while healthy and moving', async () => {
  const clock = fakeClock()
  const host = fakeHost(clock)
  let polls = 0
  const s = createScheduler({ clock, blit: host.blit, probeLive: async () => (polls++, new Set(['spark'])) })
  s.sync(new Map([['hero', spec('A')], ['spark', spec('B')]]))
  await clock.advance(3000)
  expect(polls).toBe(0)
  s.setMotion(false)
  await clock.advance(10_000)
  expect(polls).toBeGreaterThan(0)
  expect(polls).toBeLessThanOrEqual(11)
  const n = host.count('hero')
  await clock.advance(2000) // hero is not in the live set: not painted
  expect(host.count('hero')).toBe(n)
  s.setMotion(true) // probing stops: hidden key paints again
  await clock.advance(1000)
  expect(host.count('hero')).toBeGreaterThan(n)
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

// ---- pure raster scheduler (createScheduler(host)) ----
const rsSetup = (mode: 'instant' | 'never' | 'manual' = 'instant') => {
  const clock = fakeClock()
  const host = fakeHost(clock, mode)
  const s = createScheduler({ now: clock.now, every: clock.every, blit: host.blit })
  return { clock, host, s }
}
const rs = (animated = true): RasterSpec => ({ paint: t => `cells@${t}`, animated })
const rsKeys = (...ks: string[]) => new Map(ks.map(k => [k, rs()] as const))
const perSecondMax = (log: { t: number }[]) => {
  let max = 0
  for (const a of log) max = Math.max(max, log.filter(b => b.t >= a.t && b.t < a.t + 1000).length)
  return max
}

test('rs: active loop runs at 16 ms and paints with the host clock, not a frame count', async () => {
  const { clock, host, s } = rsSetup()
  s.sync(rsKeys('hero'))
  expect(s.stats().periodMs).toBe(16)
  await clock.advance(160)
  expect(host.log.map(l => l.t)).toEqual([16, 32, 48, 64, 80, 96, 112, 128, 144, 160])
})

test('rs: unresolved blit is skipped not queued: <=1 in flight per key', async () => {
  const { clock, host, s } = rsSetup('never')
  s.sync(rsKeys('hero', 'pipeline', 'spark'))
  await clock.advance(5000)
  for (const k of ['hero', 'pipeline', 'spark']) expect(host.count(k)).toBe(1)
  expect(s.stats().inFlight).toBe(3)
})

test('rs: a resolve frees the key for the next tick', async () => {
  const { clock, host, s } = rsSetup('manual')
  s.sync(rsKeys('hero'))
  await clock.advance(100)
  expect(host.count('hero')).toBe(1)
  flush(host)
  for (let i = 0; i < 4; i++) await Promise.resolve() // resolve callbacks
  await clock.advance(40) // one stuck blit of one is >half: period is now 33
  expect(host.count('hero')).toBe(2)
  expect(s.stats().inFlight).toBe(1)
})

test('rs: in-flight guard survives renders that rebuild the map', async () => {
  const { clock, host, s } = rsSetup('never')
  for (let i = 0; i < 20; i++) {
    s.sync(rsKeys('hero'))
    await clock.advance(50)
  }
  expect(host.count('hero')).toBe(1)
})

test('rs: deny unregisters the key and stops the timer', async () => {
  const { clock, host, s } = rsSetup()
  host.setDeny(true)
  s.sync(rsKeys('hero'))
  await clock.advance(200)
  expect(host.count('hero')).toBe(1)
  expect(s.stats().live).toBe(0)
  expect(clock.everyActive()).toBe(0)
  s.sync(rsKeys('hero')) // the next render still draws it: held off briefly, no deny flood
  await clock.advance(200)
  expect(host.count('hero')).toBe(1)
})

test('rs: a stale deny from a replaced entry does not drop its replacement', async () => {
  const { clock, host, s } = rsSetup('manual')
  s.sync(rsKeys('hero'))
  await clock.advance(16)
  expect(host.pending.length).toBe(1)
  s.sync(new Map()) // dropped ...
  s.sync(rsKeys('hero')) // ... and redrawn: a new entry
  host.pending.splice(0).forEach(p => p.res({ deny: 'old' }))
  for (let i = 0; i < 4; i++) await Promise.resolve()
  expect(s.stats().live).toBe(1)
  await clock.advance(16)
  expect(host.count('hero')).toBe(2) // replacement blits once the old one has resolved
})

test('rs: key dropped by sync is not blitted from the next tick', async () => {
  const { clock, host, s } = rsSetup()
  s.sync(rsKeys('a', 'b'))
  await clock.advance(100)
  const nb = host.count('b')
  s.sync(rsKeys('a'))
  await clock.advance(500)
  expect(host.count('b')).toBe(nb)
  expect(host.count('a')).toBeGreaterThan(nb)
})

test('rs: timer exists only while keys are live; stop() cancels it and ignores late resolves', async () => {
  const { clock, host, s } = rsSetup('manual')
  expect(clock.everyActive()).toBe(0)
  s.sync(rsKeys('hero'))
  expect(clock.everyActive()).toBe(1)
  s.sync(new Map())
  expect(clock.everyActive()).toBe(0)
  s.sync(rsKeys('hero'))
  await clock.advance(32)
  s.stop()
  expect(clock.everyActive()).toBe(0)
  const n = host.count()
  s.sync(rsKeys('hero')) // restart: a late resolve of the pre-stop blit must not free the new slot
  await clock.advance(100)
  expect(host.count()).toBe(n + 1)
  host.pending.splice(0, 1).forEach(p => p.res({}))
  await clock.advance(100)
  expect(host.count()).toBe(n + 1)
})

for (const why of ['no active run', 'offline', 'reduced motion']) {
  test(`rs: idle (${why}): <=2 blits/s per animated key, static keys never, mode readable`, async () => {
    const { clock, host, s } = rsSetup()
    s.sync(new Map([['hero', rs()], ['divider', rs()], ['frame', rs(false)]]))
    await clock.advance(300)
    expect(s.mode()).toBe('active')
    s.setMotion(false)
    expect(s.mode()).toBe('idle')
    expect(s.stats().periodMs).toBe(500)
    const from = host.log.length
    await clock.advance(5000)
    const idle = host.log.slice(from)
    expect(idle.some(l => l.key === 'frame')).toBe(false)
    for (const k of ['hero', 'divider']) {
      expect(perSecondMax(idle.filter(l => l.key === k))).toBeLessThanOrEqual(2)
      expect(idle.filter(l => l.key === k).length).toBeGreaterThanOrEqual(8)
    }
    s.setMotion(true)
    expect(s.stats().periodMs).toBe(16)
  })
}

test('rs: idle with only static keys runs no timer and blits nothing', async () => {
  const { clock, host, s } = rsSetup()
  s.setMotion(false)
  s.sync(new Map([['frame', rs(false)]]))
  expect(clock.everyActive()).toBe(0)
  await clock.advance(3000)
  expect(host.count()).toBe(0)
})

test('rs: >half unresolved falls back to 33 ms, restores to 16 ms after 2 s healthy', async () => {
  const { clock, host, s } = rsSetup('manual')
  s.sync(rsKeys('hero', 'pipeline', 'spark'))
  await clock.advance(100)
  expect(s.stats()).toMatchObject({ slow: true, periodMs: 33 })
  host.mode = 'instant'
  flush(host)
  await clock.advance(1900)
  expect(s.stats().slow).toBe(true)
  await clock.advance(400)
  expect(s.stats()).toMatchObject({ slow: false, periodMs: 16 })
})

test('rs: healthy host never degrades', async () => {
  const { clock, s } = rsSetup('instant')
  s.sync(rsKeys('hero', 'pipeline', 'spark'))
  await clock.advance(3000)
  expect(s.stats().slow).toBe(false)
})

test('rs: watchdog re-arms an interval the host ended', async () => {
  const { clock, host, s } = rsSetup()
  s.sync(rsKeys('hero'))
  await clock.advance(100)
  clock.kill() // refused period
  const n = host.count()
  await clock.advance(200)
  expect(host.count()).toBe(n)
  s.sync(rsKeys('hero')) // next render notices the stall
  expect(clock.everyActive()).toBe(1)
  await clock.advance(100)
  expect(host.count()).toBeGreaterThan(n)
  clock.kill()
  s.rearm()
  expect(clock.everyActive()).toBe(1)
})

// ---- makeClock ----
test('rs clock: identical time across simulated tick rates (real source and async-anchored fallback)', async () => {
  for (const dt of [4, 8, 16, 32, 100]) {
    const T = { v: 5000 }
    const real = makeClock({ real: () => T.v })
    const fb = makeClock({ fetch: async () => T.v })
    for (let i = 0; i < 3200 / dt; i++) {
      T.v += dt
      real.tick(dt), fb.tick(dt)
      await Promise.resolve(), await Promise.resolve()
    }
    expect(real.now()).toBe(3200)
    expect(fb.now()).toBe(3200)
  }
})

test('rs clock: fallback follows measured deltas and re-anchors (not frames * period)', async () => {
  const T = { v: 1000 }
  const fetches: number[] = []
  const c = makeClock({ fetch: async () => (fetches.push(T.v), T.v) })
  let frames = 0
  for (const dt of [16, 50, 16, 120, 16, 16, 33, 400, 16, 16]) {
    T.v += dt, frames++
    c.tick(dt)
    await Promise.resolve(), await Promise.resolve()
  }
  expect(c.now()).toBe(T.v - 1000)
  expect(c.now()).not.toBe(frames * 16)
  // a tick that under-reports its delta is corrected at the ~1 s anchor
  for (let i = 0; i < 70; i++) {
    T.v += 16, c.tick(15)
    await Promise.resolve(), await Promise.resolve()
  }
  expect(Math.abs(c.now() - (T.v - 1000))).toBeLessThan(70)
  expect(fetches.length).toBeGreaterThanOrEqual(2)
  expect(fetches.length).toBeLessThanOrEqual(4)
})

test('rs clock: frozen mode holds time and resumes without a jump', () => {
  const T = { v: 0 }
  const c = makeClock({ real: () => T.v })
  T.v = 1000
  c.freeze(true)
  expect(c.frozen()).toBe(true)
  T.v = 1500
  expect(c.now()).toBe(1000)
  c.freeze(false)
  expect(c.now()).toBe(1000)
  T.v = 1600
  expect(c.now()).toBe(1100)
})
