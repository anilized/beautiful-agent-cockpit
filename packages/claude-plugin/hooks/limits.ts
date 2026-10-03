// Single source for host limits, blit cadence profiles and the opt-in blit trace. Pure data + tiny helpers; imports nothing.
// Every HOST_LIMITS field is tagged documented | default | measured and maps 1:1 to a GATE0.md entry.

export type Source = 'documented' | 'default' | 'measured'
export type Limit<T> = { value: T; source: Source; cite: string; scope?: string }

export const HOST_LIMITS = {
  // d.ts:2178-2180 "up to 120 a second taken": scope (per plugin / per key / global) not stated, so the value is a default.
  blitRate: { value: 120, source: 'default', cite: 'd.ts:2178-2180 (scope unstated)', scope: 'plugin' },
  // d.ts:2178-2180 "some sixty shown".
  shownFps: { value: 60, source: 'documented', cite: 'd.ts:2178-2180' },
  // No byte cap documented; the cols*rows*3 words contract stays binding, deny reasons are d.ts:2184-2187.
  payloadCap: { value: null, source: 'default', cite: 'd.ts:2184-2187 (deny reasons only; no cap stated)', scope: 'cols*rows*3 words' },
  // Colour-pair cap and its scope (per raster / pane / terminal) are unverified.
  colorPairCap: { value: 1024, source: 'default', cite: 'none', scope: 'unverified' },
  // d.ts:3228-3231 "at least 1 ms ... a refused period ends the interval".
  clockMinMs: { value: 1, source: 'documented', cite: 'd.ts:3228-3231' },
  // d.ts:2308-2319 documents $.ui.panes(); no cost is stated, so the ≤1 Hz ceiling is ours.
  panesPollMaxHz: { value: 1, source: 'default', cite: 'd.ts:2308-2319 (cost unstated)' },
  // Whether ≥30 fps is actually achievable on the real terminal is unknown until measured.
  fps30Achievable: { value: null, source: 'default', cite: 'none' },
} as const satisfies Record<string, Limit<number | boolean | null>>

export type CadenceName = 'conservative' | 'full'
export type Cadence = { totalPerSec: number; tierAFps: number; tierBFps: number; urgentReserve: number; framePeriodMs: number; idlePeriodMs: number }

export const CADENCE: Record<CadenceName, Cadence> = {
  conservative: { totalPerSec: 60, tierAFps: 30, tierBFps: 15, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 },
  // Not the default: only after every GATE0 item is filled in or waived.
  full: { totalPerSec: 100, tierAFps: 60, tierBFps: 30, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 },
}
export const DEFAULT_CADENCE: CadenceName = 'conservative'

export const resolveCadence = (env?: Record<string, string | undefined> | null): Cadence & { name: CadenceName } => {
  const v = env?.COCKPIT_CADENCE
  const name: CadenceName = v === 'full' || v === 'conservative' ? v : DEFAULT_CADENCE
  return { name, ...CADENCE[name] }
}

// Trace ring: per key, RING events of [t, kind, paintMs] in one preallocated Float64Array. Off => record() returns before touching anything.
export type TraceKind = 'start' | 'resolve' | 'skip' | 'deny'
export const TRACE_KINDS: readonly TraceKind[] = ['start', 'resolve', 'skip', 'deny']
export const TRACE_RING = 256
const STRIDE = 3

export type Trace = {
  readonly on: boolean
  record: (key: string, kind: TraceKind, t: number, paintMs?: number) => void
  dump: () => string
}

export const createTrace = (on: boolean, ring = TRACE_RING): Trace => {
  if (!on) return { on, record: () => {}, dump: () => '' }
  const bufs = new Map<string, { a: Float64Array; n: number }>()
  return {
    on,
    record(key, kind, t, paintMs = 0) {
      let b = bufs.get(key)
      if (!b) bufs.set(key, (b = { a: new Float64Array(ring * STRIDE), n: 0 }))
      const o = (b.n++ % ring) * STRIDE
      b.a[o] = t, b.a[o + 1] = TRACE_KINDS.indexOf(kind), b.a[o + 2] = paintMs
    },
    // One line per event, oldest first: `key kind t paintMs`. Pastes into GATE0.md.
    dump() {
      const out: string[] = []
      for (const [key, b] of bufs) {
        const n = Math.min(b.n, ring)
        for (let i = 0; i < n; i++) {
          const o = ((b.n - n + i) % ring) * STRIDE
          out.push(`${key} ${TRACE_KINDS[b.a[o + 1]!]} ${b.a[o]!.toFixed(2)} ${b.a[o + 2]!.toFixed(3)}`)
        }
      }
      return out.join('\n')
    },
  }
}

// COCKPIT_TRACE is read once at module init; the plugin host has no process, so it is off there unless the module calls enableTrace().
const flag = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.COCKPIT_TRACE
const on = flag === '1' || flag === 'true'
export let trace: Trace = createTrace(on)
/** Host path: after `await $.env.get('COCKPIT_TRACE')`, call once; ignored when already on. */
export const enableTrace = (v: string | undefined | null) => { if (!trace.on && (v === '1' || v === 'true')) trace = createTrace(true) }
