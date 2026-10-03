// Raster blit scheduler: one pending {token, gen} slot per key, token buckets, watchdog, degrade, idle timer. Pure logic: no host
// imports; clock, blit and panes() probe are injected. Nothing is queued: a key with a pending slot or without a token is skipped
// this tick (trace 'skip') and judged again on the next.
//
// Host facts (plugin-authoring d.ts): blit is limited to ~120/s taken, ~60 shown, and can be denied (d.ts:2178-2187); $.clock.every
// takes >= 1 ms and a refused period ends the interval (d.ts:3228-3231), hence the watchdog; $.ui.panes() has an unstated cost
// (d.ts:2308-2319), hence a <=1 Hz probe that is never on the main path.
//
// API (TASK-306 integrates against this):
//   createScheduler({ clock, blit, probeLive?, cadence?, trace? }) -> Scheduler
//     clock.every(ms, fn) / clock.after(ms, fn) -> cancel;  clock.now() MUST be synchronous (see makeSyncClock).
//     blit(key, cells) -> Promise<{ deny? } | void>; a rejection counts as a failure, a truthy `deny` unregisters the key.
//     probeLive?() -> Promise<Set<key>>: optional $.ui.panes() adapter, polled <=1 Hz only while idle or degraded.
//     cadence defaults to CADENCE.conservative; trace defaults to the limits.ts recorder (no-op while the gate is off).
//   sync(keys: Map<key, {tier:'A'|'B', paint(timeMs)->cells, id?}>) call from every render: keys missing are dropped before the next
//     tick; a changed `id` under the same key is a replacement (gen bump, fresh entry). Tier A (hero, pipeline) <=30 fps, B <=15 fps.
//   setMotion(on)  false when idle/offline/reduced motion: timer <=500 ms, only HERO_KEY paints, <=2 blits/s.
//   urgent(key)    approval/failure pulse from the ~10% reserve; false when pending, tokenless or unknown.
//   close() / end() for ui.close / session.end: synchronously clear timers, keys, slots, bump gen; zero blits afterwards.
//   stats()        { gen, live, pending, degraded, timerMs, motion } for tests and diagnostics.
// The timer runs at framePeriodMs (16) only while live keys exist and motion is on; it is cancelled when no keys are live.
// Invariant "one in-flight blit per key" is counted host side: a pending slot is freed only by its own resolve/deny (token match);
// a generation bump merely discards that late resolve's effects. A stalled blit keeps its slot, so nothing new is sent for the key.
import { CADENCE, HOST_LIMITS, PANES_POLL_MAX_HZ, trace as globalTrace, type Cadence, type Trace } from './limits'

/** The one key that keeps painting while motion is off. */
export const HERO_KEY = 'hero'
export type Tier = 'A' | 'B'
/** `id` marks the raster instance: a changed id under the same key is a replacement (gen bump, fresh entry). */
export type KeySpec = { tier: Tier; paint: (timeMs: number) => string; id?: string | number }
export type BlitResult = { deny?: unknown } | void | undefined
export type Cancel = () => void
export type SchedulerDeps = {
  clock: { every: (ms: number, fn: () => void) => Cancel; after: (ms: number, fn: () => void) => Cancel; now: () => number }
  blit: (key: string, cells: string) => Promise<BlitResult>
  /** Optional $.ui.panes() adapter; polled <=1 Hz, only while idle or degraded, and never the main liveness path. */
  probeLive?: () => Promise<Set<string>>
  cadence?: Cadence
  trace?: Trace
}
export type Scheduler = {
  sync: (keys: Map<string, KeySpec>) => void
  setMotion: (on: boolean) => void
  urgent: (key: string) => boolean
  close: () => void
  end: () => void
  stats: () => { gen: number; live: number; pending: number; degraded: boolean; timerMs: number; motion: boolean }
}

type Entry = { uid: number; id: string | number | undefined; tier: Tier; paint: (t: number) => string; last: number; visible: boolean }
type Slot = { token: number; gen: number; uid: number; t: number }

const WATCH_MS = 100 // watchdog poll, deliberately slow
const WATCH_PERIODS = 3 // no tick for this many periods => interval presumed dead
const HEALTHY_MS = 2000 // degrade restores after this long without a stall or deny
const DENY_WINDOW_MS = 2000
const DENY_LIMIT = 2
const BUCKET_MIN = 2

export const createScheduler = (deps: SchedulerDeps): Scheduler => {
  const { clock } = deps
  const cad = deps.cadence ?? CADENCE.conservative
  const tr = () => deps.trace ?? globalTrace
  const minMs = HOST_LIMITS.clockMinPeriodMs.value
  const frameMs = Math.max(minMs, cad.framePeriodMs)
  const idleMs = Math.max(minMs, cad.idlePeriodMs)
  const mainRate = (cad.totalPerSec * (1 - cad.urgentReserve)) / 1000
  const resRate = (cad.totalPerSec * cad.urgentReserve) / 1000

  const entries = new Map<string, Entry>()
  const slots = new Map<string, Slot>() // exactly one pending slot per key
  let gen = 0, uid = 0, seq = 0
  let motion = true
  let cancelEvery: Cancel | null = null, cancelWatch: Cancel | null = null, timerMs = 0
  let lastTick = 0, lastRefill = 0, main = 0, reserve = 0
  let degraded = false, lastBad = 0, denyN = 0, denyAt = 0
  let epoch: number | null = null
  let probing = false, lastProbe = -Infinity

  const animMs = (t: number) => t - (epoch ??= t)
  const tierCap = (tier: Tier) => (tier === 'A' ? (degraded ? cad.tierAFps / 2 : cad.tierAFps) : cad.tierBFps)

  const bad = (t: number) => { degraded = true, lastBad = t }

  const stopTimers = () => {
    cancelEvery?.(), cancelWatch?.()
    cancelEvery = cancelWatch = null, timerMs = 0
  }

  const start = (key: string, e: Entry, t: number, fromReserve: boolean) => {
    const t0 = clock.now()
    const cells = e.paint(animMs(t))
    const paintMs = clock.now() - t0
    const slot: Slot = { token: ++seq, gen, uid: e.uid, t }
    slots.set(key, slot)
    e.last = t
    if (fromReserve && reserve >= 1) reserve--
    else main--
    tr().record(key, 'start', t, paintMs)
    let p: Promise<BlitResult>
    try { p = deps.blit(key, cells) } catch { p = Promise.reject() }
    void p.then(r => settle(key, slot, r ?? undefined), () => settle(key, slot, undefined, true))
  }

  // A resolve frees the key only when its token still owns the slot. A deny unregisters whenever the raster (uid) is
  // still the one that was blitted; other effects apply only for the current generation.
  const settle = (key: string, slot: Slot, r: BlitResult, failed = false) => {
    if (slots.get(key)?.token !== slot.token) return
    slots.delete(key)
    const t = clock.now()
    const denied = !!(r && 'deny' in r && r.deny)
    if (denied && entries.get(key)?.uid === slot.uid) {
      tr().record(key, 'deny', t)
      if (t - denyAt > DENY_WINDOW_MS) denyN = 0
      denyAt = t
      if (++denyN >= DENY_LIMIT) bad(t)
      entries.delete(key), gen++, refresh()
      return
    }
    if (slot.gen !== gen || denied) return
    {
      if (failed) bad(t)
      tr().record(key, 'resolve', t)
    }
  }

  const probe = (t: number) => {
    // $.ui.panes() (d.ts:2308-2319) cost is undocumented: poll <=1 Hz, only idle or degraded, advisory visibility only.
    if (!deps.probeLive || probing || t - lastProbe < 1000 / PANES_POLL_MAX_HZ) return
    probing = true, lastProbe = t
    const g = gen
    deps.probeLive().then(live => {
      probing = false
      if (g !== gen) return
      for (const [k, e] of entries) e.visible = live.size === 0 || live.has(k)
    }, () => { probing = false })
  }

  const tick = () => {
    if (!entries.size) return
    const t = clock.now()
    lastTick = t
    // Burst cap covers what one period earns, so the refill rate is realised at any cadence (idle ticks refill ~27).
    main = Math.min(Math.max(BUCKET_MIN, Math.ceil(mainRate * timerMs)), main + (t - lastRefill) * mainRate)
    reserve = Math.min(Math.max(BUCKET_MIN, Math.ceil(resRate * timerMs)), reserve + (t - lastRefill) * resRate)
    lastRefill = t
    for (const s of slots.values()) if (t - s.t > 2 * frameMs) bad(t)
    if (degraded && t - lastBad >= HEALTHY_MS) degraded = false
    if (!motion || degraded) probe(t)
    else for (const e of entries.values()) e.visible = true
    const due: [string, Entry, number][] = []
    for (const [key, e] of entries) {
      if (!e.visible || (!motion && key !== HERO_KEY)) continue
      if (slots.has(key)) { tr().record(key, 'skip', t); continue }
      const per = 1000 / tierCap(e.tier)
      if (t - e.last >= per) due.push([key, e, ((t - e.last) / per) * (e.tier === 'A' ? 2 : 1)])
    }
    due.sort((a, b) => b[2] - a[2])
    for (const [key, e] of due) {
      if (main < 1) { tr().record(key, 'skip', t); continue }
      start(key, e, t, false)
    }
  }

  const watch = () => {
    cancelWatch = clock.after(WATCH_MS, () => {
      cancelWatch = null
      if (!entries.size) return
      const t = clock.now()
      if (motion && t - lastTick > WATCH_PERIODS * frameMs) rearm(t)
      if (entries.size) watch()
    })
  }

  // A refused period ends the interval (d.ts:3228-3231): new generation, new interval. Slots stay: their blits are still in flight host side.
  const rearm = (t: number) => {
    cancelEvery?.()
    gen++
    arm(t)
  }

  const arm = (t: number) => {
    timerMs = motion ? frameMs : idleMs
    lastTick = lastRefill = t
    cancelEvery = clock.every(timerMs, tick)
  }

  // Timer exists only while keys are live; period follows motion.
  const refresh = () => {
    if (!entries.size) return stopTimers()
    const want = motion ? frameMs : idleMs
    if (cancelEvery && timerMs === want) return
    const t = clock.now()
    if (cancelEvery) cancelEvery(), gen++
    arm(t)
    if (!cancelWatch) watch()
  }

  const clear = () => {
    stopTimers()
    entries.clear(), slots.clear()
    gen++
    main = reserve = 0, degraded = false, denyN = 0, probing = false
  }

  return {
    sync(keys) {
      let dropped = false
      for (const [k, e] of entries) {
        const s = keys.get(k)
        if (!s || (s.id !== undefined && s.id !== e.id)) entries.delete(k), dropped = true
      }
      for (const [k, s] of keys) {
        const e = entries.get(k)
        if (e) e.tier = s.tier, e.paint = s.paint
        else entries.set(k, { uid: ++uid, id: s.id, tier: s.tier, paint: s.paint, last: -1e12, visible: true })
      }
      if (dropped) gen++
      refresh()
    },
    setMotion(on) {
      if (on === motion) return
      motion = on
      refresh()
    },
    urgent(key) {
      const e = entries.get(key)
      if (!e) return false
      const t = clock.now()
      if (slots.has(key) || (reserve < 1 && main < 1)) return tr().record(key, 'skip', t), false
      start(key, e, t, reserve >= 1)
      return true
    },
    close: clear,
    end: clear,
    stats: () => ({ gen, live: entries.size, pending: slots.size, degraded, timerMs, motion }),
  }
}

/**
 * Sync clock adapter: the host $.clock.now() is async, so the integration calls `refresh()` off the paint path (e.g. from a slow
 * after/every) and the scheduler reads `now()` synchronously. With `local` (any sync monotonic source) now() advances between
 * refreshes; without it, it returns the last fetched value. At most one prefetch is in flight.
 */
export const makeSyncClock = (prefetch: () => Promise<number>, local?: () => number) => {
  let wall = 0, at = local?.() ?? 0, busy = false
  return {
    now: () => wall + (local ? local() - at : 0),
    refresh: async () => {
      if (busy) return
      busy = true
      try { const w = await prefetch(); wall = w, at = local?.() ?? 0 } catch {} finally { busy = false }
    },
  }
}
