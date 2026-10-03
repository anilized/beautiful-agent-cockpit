// Raster blit scheduler: one pending {token, gen} slot per key, token buckets, watchdog, degrade. Pure logic; clock and blit are injected.
// Nothing is queued: a key with a pending slot or without a token is skipped this tick and judged again on the next.
import { CADENCE, HOST_LIMITS, PANES_POLL_MAX_HZ, trace as globalTrace, type Cadence, type Trace } from './limits'

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
const STALL_MS = 6000 // a blit pending this long is aborted by the watchdog so the key can paint again

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
      if (!e.visible) continue
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
      for (const [k, s] of slots) if (t - s.t > STALL_MS) slots.delete(k)
      if (motion && t - lastTick > WATCH_PERIODS * frameMs) rearm(t)
      if (entries.size) watch()
    })
  }

  // A refused period ends the interval (d.ts:3228-3231): new generation, abort slots stuck since before the death, new interval.
  const rearm = (t: number) => {
    cancelEvery?.()
    gen++
    for (const [k, s] of slots) if (t - s.t > WATCH_PERIODS * frameMs) slots.delete(k)
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
