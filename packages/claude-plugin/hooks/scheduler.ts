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

const createLegacyScheduler = (deps: SchedulerDeps): Scheduler => {
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

// ---- Pure raster scheduler: 16 ms time-based loop, per-key in-flight guard, idle mode, 33 ms fallback. Host-agnostic. ----
// Host facts (plugin-authoring d.ts, CC 2.1.286): blit ~120/s taken, ~60 shown, blits between frames fold, resolves {} or {deny} (d.ts:2178-2187);
// clock.every >= 1 ms, one dispatch per period, a refused period ends the interval (d.ts:3231-3234), hence sync()'s watchdog and rearm();
// invalidate <= 10/s, 30/s for the shown pane (d.ts:2163-2169), so 60 fps effects are rasters only; env.get (d.ts:3370) and clock.now (d.ts:3205) are async.
// Nothing is queued: a key with an unresolved blit is skipped this tick and judged again on the next.
export type RasterSpec = { paint: (tMs: number) => string; animated: boolean }
export type RasterHost = {
  now: () => number
  every: (ms: number, fn: () => void) => Cancel
  blit: (key: string, cells: string) => Promise<BlitResult>
}
export type RasterScheduler = {
  /** Call from every render with the keys drawn; keys missing are dropped before the next tick. */
  sync: (keys: Map<string, RasterSpec>) => void
  /** false when no active viewed run, offline or reduced motion: idle mode. */
  setMotion: (on: boolean) => void
  /** Re-arm the interval (a refused period ends it). */
  rearm: () => void
  stop: () => void
  /** For the text-tick consumer. */
  mode: () => 'active' | 'idle'
  stats: () => { live: number; inFlight: number; periodMs: number; slow: boolean; motion: boolean }
}

export const ACTIVE_MS = 16
export const SLOW_MS = 33 // fallback period while blits pile up unresolved
export const IDLE_MS = 500 // idle tick and per-key gap: <= 2 blits/s
const WINDOW_MS = 1000 // backpressure window
const RESTORE_MS = 2000 // healthy time before 16 ms returns
const STALE_PERIODS = 3 // no tick for this many periods => interval presumed dead
const HOLD_MS = 1000 // a denied key stays unregistered this long even if the next render redraws it

type Live = RasterSpec & { last: number }

const createRasterScheduler = (host: RasterHost): RasterScheduler => {
  const live = new Map<string, Live>()
  const inFlight = new Set<string>() // outlives renders: the render rebuilds its raster map every text tick
  const held = new Map<string, number>() // denied key -> re-register allowed at
  let era = 0, motion = true, slow = false
  let cancel: Cancel | null = null, period = 0
  let lastTick = 0, winAt = 0, issued = 0, healthyAt = 0

  const want = () => (motion ? (slow ? SLOW_MS : ACTIVE_MS) : IDLE_MS)
  const eligible = () => {
    if (motion) return live.size > 0
    for (const s of live.values()) if (s.animated) return true
    return false
  }
  const arm = () => {
    cancel?.()
    period = want(), lastTick = host.now()
    cancel = host.every(period, tick)
  }
  const refresh = () => {
    if (!eligible()) return cancel?.(), (cancel = null), void (period = 0)
    if (!cancel || period !== want() || host.now() - lastTick > STALE_PERIODS * period) arm()
  }

  // A resolve frees its key; a deny also unregisters it, but only if the entry is the one that was blitted.
  const done = (key: string, s: Live, e: number, r?: BlitResult) => {
    if (e !== era) return // stop() ran meanwhile
    inFlight.delete(key)
    if (r && r.deny && live.get(key) === s) live.delete(key), held.set(key, host.now() + HOLD_MS), refresh()
  }
  const send = (key: string, s: Live, t: number) => {
    let cells: string
    try { cells = s.paint(t) } catch { return }
    const e = era
    inFlight.add(key), issued++, s.last = t
    let p: Promise<BlitResult>
    try { p = host.blit(key, cells) } catch { p = Promise.reject() }
    void p.then(r => done(key, s, e, r), () => done(key, s, e))
  }

  const tick = () => {
    const t = host.now()
    lastTick = t
    if (!eligible()) return refresh()
    if (t - winAt >= WINDOW_MS) winAt = t, issued = 0
    if (motion) {
      // More than half of this window's blits still unresolved: 33 ms until 2 s of healthy ticks.
      if (inFlight.size * 2 > Math.max(issued, inFlight.size)) {
        healthyAt = t
        if (!slow) slow = true, arm()
      } else if (slow && t - healthyAt >= RESTORE_MS) slow = false, arm()
    }
    for (const [key, s] of live) {
      if (inFlight.has(key)) continue
      if (!motion && (!s.animated || t - s.last < IDLE_MS)) continue
      send(key, s, t)
    }
  }

  return {
    sync(keys) {
      const t = host.now()
      for (const k of live.keys()) if (!keys.has(k)) live.delete(k)
      for (const k of held.keys()) if (!keys.has(k) || held.get(k)! <= t) held.delete(k)
      for (const [k, v] of keys) {
        const s = live.get(k)
        if (s) s.paint = v.paint, s.animated = v.animated
        else if (!held.has(k)) live.set(k, { paint: v.paint, animated: v.animated, last: -Infinity })
      }
      refresh()
    },
    setMotion(on) {
      if (on === motion) return
      motion = on
      refresh()
    },
    rearm: () => void (eligible() && arm()),
    stop() {
      cancel?.(), (cancel = null), (period = 0)
      live.clear(), inFlight.clear(), held.clear()
      era++, slow = false, issued = 0
    },
    mode: () => (motion ? 'active' : 'idle'),
    stats: () => ({ live: live.size, inFlight: inFlight.size, periodMs: period, slow, motion }),
  }
}

export function createScheduler(host: RasterHost): RasterScheduler
/** @deprecated gate/cadence scheduler still used by register.tsx until it migrates. */
export function createScheduler(deps: SchedulerDeps): Scheduler
export function createScheduler(h: RasterHost | SchedulerDeps): RasterScheduler | Scheduler {
  return 'every' in h ? createRasterScheduler(h) : createLegacyScheduler(h)
}

/**
 * Elapsed-ms clock for painters. `real` is a sync monotonic source if the host has one (Date.now / performance.now); otherwise time is
 * advanced by `tick(dtMs)` (the measured delta between ticks) and re-anchored from the async `fetch` ($.clock.now) about once a second.
 * Never frameCount * period. `freeze(true)` holds time still (reduced motion) and resumes without a jump.
 */
export type ClockSources = { real?: () => number; fetch?: () => Promise<number> }
export const SYNC_MS = 1000
export const makeClock = (src: ClockSources) => {
  const base0 = src.real?.() ?? 0
  let est = 0, base: number | null = null, lastSync = -Infinity, busy = false
  let frozenAt: number | null = null, skew = 0
  const raw = () => (src.real ? src.real() - base0 : est)
  const fetchNow = () => {
    if (src.real || !src.fetch || busy) return
    busy = true, lastSync = est
    const at = est
    src.fetch().then(w => {
      base ??= w - at
      est = w - base
    }, () => {}).finally(() => { busy = false })
  }
  return {
    now: () => frozenAt ?? raw() - skew,
    /** Call from each loop tick with the measured delta since the previous one. */
    tick(dtMs: number) {
      if (!src.real) est += dtMs
      if (est - lastSync >= SYNC_MS) fetchNow()
    },
    /** Force a re-anchor now (session start). */
    refresh: fetchNow,
    freeze(on: boolean) {
      if (on && frozenAt === null) frozenAt = raw() - skew
      else if (!on && frozenAt !== null) skew = raw() - frozenAt, (frozenAt = null)
    },
    frozen: () => frozenAt !== null,
  }
}
