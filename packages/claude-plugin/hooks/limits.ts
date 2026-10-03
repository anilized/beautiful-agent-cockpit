// Host limits, blit cadence profiles and the opt-in blit trace. No host calls here: gates come in through an injected accessor,
// export only runs on an explicit trigger (never on the paint/blit path). Each HOST_LIMITS field maps 1:1 to a GATE0.md entry.

export type Tag = 'documented' | 'default' | 'unverified'
export type Limit<T> = { value: T; tag: Tag; cite: string; note?: string }

export const HOST_LIMITS = {
  // d.ts:2178-2180 "up to 120 a second taken"; per plugin / key / global is not stated, so the scope is assumed.
  blitRateCap: { value: 120, tag: 'default', cite: 'd.ts:2178-2180', note: 'per second; scope assumed per plugin' },
  // d.ts:2178-2180 "some sixty shown".
  framesShownPerSec: { value: 60, tag: 'documented', cite: 'd.ts:2178-2180' },
  // No byte cap documented; the cols*rows*3 uint32-words contract stays binding.
  payloadCapBytes: { value: null, tag: 'unverified', cite: 'none', note: 'cols*rows*3 words contract binding' },
  // d.ts:8429 "paints 1024 distinct color pairs at once and the rest as their nearest"; per raster / pane / terminal not stated.
  colorPairCap: { value: 1024, tag: 'unverified', cite: 'd.ts:8429', note: 'scope unverified' },
  // d.ts:3228-3231 "at least 1 ms ... a refused period ends the interval".
  clockMinPeriodMs: { value: 1, tag: 'documented', cite: 'd.ts:3228-3231', note: 'a refused period ends the interval' },
  // d.ts:2308-2319 documents $.ui.panes() and states no cost; to be measured.
  panesCostMs: { value: null, tag: 'unverified', cite: 'd.ts:2308-2319', note: 'cost unstated' },
  // Whether >=30 fps is achievable on the real terminal is unknown until measured.
  realTerminalFps: { value: 30, tag: 'unverified', cite: 'none', note: 'target, >=30' },
} as const satisfies Record<string, Limit<number | null>>

/** Our own ceiling for the $.ui.panes() liveness probe (its cost is unstated, see HOST_LIMITS.panesCostMs). */
export const PANES_POLL_MAX_HZ = 1

export type CadenceName = 'conservative' | 'full'
export type Cadence = { totalPerSec: number; tierAFps: number; tierBFps: number; urgentReserve: number; framePeriodMs: number; idlePeriodMs: number }

export const CADENCE: Record<CadenceName, Cadence> = {
  conservative: { totalPerSec: 60, tierAFps: 30, tierBFps: 15, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 },
  // Not the default: only once every GATE0 item is filled in or waived.
  full: { totalPerSec: 100, tierAFps: 60, tierBFps: 30, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 },
}
export const DEFAULT_CADENCE: CadenceName = 'conservative'

export const resolveCadenceName = (raw: string | null | undefined): CadenceName => (raw === 'full' || raw === 'conservative' ? raw : DEFAULT_CADENCE)

/** `raw` is the COCKPIT_CADENCE value, or an env-like object holding it; unset or invalid gives 'conservative'. */
export const resolveCadence = (raw?: string | { COCKPIT_CADENCE?: string } | null): Cadence & { name: CadenceName } => {
  const name = resolveCadenceName(typeof raw === 'string' ? raw : raw?.COCKPIT_CADENCE)
  return { name, ...CADENCE[name] }
}

export type Accessor = (name: string) => string | undefined | Promise<string | undefined>
export type Gates = { trace: boolean; reducedMotion: boolean; cadence: Cadence & { name: CadenceName } }
const truthy = (v: string | undefined) => v === '1' || v === 'true'

/** Reads COCKPIT_TRACE, COCKPIT_REDUCED_MOTION and COCKPIT_CADENCE once. The host accessor is `$.env.get(name)` (d.ts:3360-3370); all gates are off by default. */
export const readGates = async (get: Accessor): Promise<Gates> => ({
  trace: truthy(await get('COCKPIT_TRACE')),
  reducedMotion: truthy(await get('COCKPIT_REDUCED_MOTION')),
  cadence: resolveCadence(await get('COCKPIT_CADENCE')),
})

export type TraceKind = 'start' | 'resolve' | 'skip' | 'deny'
export const TRACE_KINDS: readonly TraceKind[] = ['start', 'resolve', 'skip', 'deny']
export const TRACE_RING = 256
const STRIDE = 3
export type TraceEvent = { t: number; kind: TraceKind; paintMs: number }
export type TraceDump = { version: 1; cadence: Cadence & { name: CadenceName }; hostLimits: typeof HOST_LIMITS; keys: Record<string, TraceEvent[]> }

export type Trace = {
  readonly on: boolean
  record: (key: string, kind: TraceKind, t: number, paintMs?: number) => void
  /** Null with trace off. Only called by an explicit trigger (command, ui.close, session.end). */
  exportTrace: (nowMs?: number) => TraceDump | null
}

const OFF: Trace = { on: false, record: () => {}, exportTrace: () => null }

// Per key one preallocated Float64Array ring of [t, kind, paintMs]; off => record returns before touching anything.
export const createTrace = (on: boolean, cadence: Cadence & { name: CadenceName } = resolveCadence(), ring = TRACE_RING): Trace => {
  if (!on) return OFF
  const bufs = new Map<string, { a: Float64Array; n: number }>()
  return {
    on,
    record(key, kind, t, paintMs = 0) {
      let b = bufs.get(key)
      if (!b) bufs.set(key, (b = { a: new Float64Array(ring * STRIDE), n: 0 }))
      const o = (b.n++ % ring) * STRIDE
      b.a[o] = t, b.a[o + 1] = TRACE_KINDS.indexOf(kind), b.a[o + 2] = paintMs
    },
    exportTrace() {
      const keys: Record<string, TraceEvent[]> = {}
      for (const [key, b] of bufs) {
        const n = Math.min(b.n, ring), evs: TraceEvent[] = []
        for (let i = 0; i < n; i++) {
          const o = ((b.n - n + i) % ring) * STRIDE // oldest first after wrap
          evs.push({ t: b.a[o]!, kind: TRACE_KINDS[b.a[o + 1]!]!, paintMs: b.a[o + 2]! })
        }
        keys[key] = evs
      }
      return { version: 1, cadence, hostLimits: HOST_LIMITS, keys }
    },
  }
}

/** Process-wide trace: off until enableTrace(gate) is called with a truthy COCKPIT_TRACE. */
export let trace: Trace = OFF
export const enableTrace = (v: string | undefined | null, cadence?: Cadence & { name: CadenceName }) => { if (!trace.on && truthy(v ?? undefined)) trace = createTrace(true, cadence) }
export const exportTrace = (nowMs?: number): TraceDump | null => trace.exportTrace(nowMs)

export type WriteApi = { dataDir?: string; write?: (path: string, text: string) => Promise<void> }
/** No plugin data-dir API is documented (d.ts has `$.fs.write` for any path but no data dir), so without `dataDir` + `write` the serialized JSON is returned. Null when there is no dump. */
export const writeTrace = async (api: WriteApi, dump: TraceDump | null): Promise<{ path: string } | { text: string } | null> => {
  if (!dump) return null
  const text = JSON.stringify(dump)
  if (!api.dataDir || !api.write) return { text }
  const path = `${api.dataDir}/trace.json`
  await api.write(path, text)
  return { path }
}
