// Raster blit scheduler: one interval drives every animated raster of the pane. Pure logic: the clock and blit are injected.
// Nothing is queued: a key with a blit in flight is skipped this tick and judged again on the next.
//
// Host facts (plugin-authoring d.ts): blit is limited to ~120/s taken, ~60 shown, and can be denied; $.clock.every takes >= 1 ms
// and a refused period ends the interval, hence rearm().
//
// Budget while moving: the hero (it carries the wall clock and the big art) at the 16 ms frame, every other animated key at most
// once per SECONDARY_MS, and all keys together at most MAX_BLITS_PER_S, the most overdue key first. Idle: animated keys every
// IDLE_MS (<= 2 blits/s). A deny unregisters the key; more than half of a window's blits unresolved drops to 33 ms.

/** The key that keeps the frame rate; the rest share what the budget leaves. */
export const HERO_KEY = 'hero'
export type BlitResult = { deny?: unknown } | void | undefined
export type Cancel = () => void

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
/** Shortest gap between two blits of one non-hero key while moving (<= ~15/s each). */
export const SECONDARY_MS = 66
/** All keys together while moving: under the host's ~120/s intake. */
export const MAX_BLITS_PER_S = 100
const BURST = 3 // budget tokens that may pile up across a slow tick
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
  let tokens = 0, filledAt = -1
  const gap = (key: string) => (key === HERO_KEY ? ACTIVE_MS : SECONDARY_MS)

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
    if (!motion) {
      for (const [key, s] of live) if (!inFlight.has(key) && s.animated && t - s.last >= IDLE_MS) send(key, s, t)
      return
    }
    // The budget refills at MAX_BLITS_PER_S; due keys go most overdue first (lateness relative to their own gap).
    // Refill at the cap less the burst: any one-second window then holds at most MAX_BLITS_PER_S.
    tokens = filledAt < 0 ? 1 : Math.min(BURST, tokens + ((t - filledAt) * (MAX_BLITS_PER_S - BURST)) / 1000)
    filledAt = t
    // The hero first, every frame; the others by how late they are against their own gap.
    const due = [...live].filter(([key, s]) => !inFlight.has(key) && (key === HERO_KEY || t - s.last >= SECONDARY_MS))
    due.sort((a, b) => Number(b[0] === HERO_KEY) - Number(a[0] === HERO_KEY) || (t - b[1].last) / gap(b[0]) - (t - a[1].last) / gap(a[0]))
    for (const [key, s] of due) {
      if (tokens < 1) break
      tokens -= 1
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
      era++, slow = false, issued = 0, tokens = 0, filledAt = -1
    },
    mode: () => (motion ? 'active' : 'idle'),
    stats: () => ({ live: live.size, inFlight: inFlight.size, periodMs: period, slow, motion }),
  }
}

/** The pane's raster scheduler: `sync` from every render, `setMotion` from the run state. */
export function createScheduler(host: RasterHost): RasterScheduler {
  return createRasterScheduler(host)
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
