// Gate 0 probe: prints HOST_LIMITS, the active cadence, and summarises an exported trace (path to the JSON written by `/cockpit trace`, or the JSON itself).
// Run: `npm run probe -- <trace.json>`. With no input it prints HOST_LIMITS and says 'no trace supplied'. Reads COCKPIT_CADENCE from this script's env.
import { existsSync, readFileSync } from 'node:fs'
import { CADENCE, HOST_LIMITS, resolveCadence, type TraceDump } from '../hooks/limits.ts'

const p = (globalThis as { process?: { env: Record<string, string | undefined>; argv: string[] } }).process!
const out: string[] = ['## HOST_LIMITS']
for (const [k, f] of Object.entries(HOST_LIMITS) as [string, { value: unknown; tag: string; cite: string; note?: string }][])
  out.push(`- ${k}: ${JSON.stringify(f.value)} [${f.tag}] ${f.cite}${f.note ? ` (${f.note})` : ''}`)
const c = resolveCadence(p.env.COCKPIT_CADENCE)
out.push('', `## CADENCE ${c.name}`, JSON.stringify(CADENCE[c.name]), '')

const arg = p.argv[2]
if (!arg) out.push('no trace supplied (usage: npm run probe -- <trace.json>)')
else {
  const dump = JSON.parse(existsSync(arg) ? readFileSync(arg, 'utf8') : arg) as TraceDump
  const ms = (n: number) => n.toFixed(2)
  let total = 0, resolved = 0, tMin = Infinity, tMax = -Infinity
  const rows: string[] = [], denyBy: string[] = [], gapBy: string[] = [], fpsBy: Record<string, string> = {}
  let denies = 0
  for (const [key, evs] of Object.entries(dump.keys)) {
    const count = { start: 0, resolve: 0, skip: 0, deny: 0 }, lat: number[] = [], paint: number[] = []
    let open: number | null = null
    for (const e of evs) {
      count[e.kind]++
      tMin = Math.min(tMin, e.t), tMax = Math.max(tMax, e.t)
      if (e.kind === 'start') open = e.t, paint.push(e.paintMs)
      else if (e.kind === 'resolve' && open !== null) lat.push(e.t - open), open = null
    }
    const span = evs.length > 1 ? (evs[evs.length - 1]!.t - evs[0]!.t) / 1000 : 0
    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
    total += count.start, resolved += count.resolve, denies += count.deny
    const starts = evs.filter(e => e.kind === 'start').map(e => e.t)
    const gap = starts.reduce((m, t, i) => (i ? Math.max(m, t - starts[i - 1]!) : m), 0)
    denyBy.push(`${key}=${count.deny}`), gapBy.push(`${key}=${ms(gap)}`)
    fpsBy[key] = span > 0 ? (count.resolve / span).toFixed(1) : 'n/a'
    rows.push(`- ${key}: delivered ${span > 0 ? (count.resolve / span).toFixed(1) : 'n/a'} fps, resolve latency avg ${ms(avg(lat))} ms max ${ms(Math.max(0, ...lat))} ms, paint avg ${ms(avg(paint))} ms, start ${count.start} resolve ${count.resolve} skip ${count.skip} deny ${count.deny}`)
  }
  const span = tMax > tMin ? (tMax - tMin) / 1000 : 0
  const rate = span > 0 ? (total / span).toFixed(1) : 'n/a'
  const ratio = total ? (resolved / total).toFixed(2) : 'n/a'
  out.push(`## TRACE (cadence ${dump.cadence.name}, ${Object.keys(dump.keys).length} keys, ${ms(span)} s window)`, ...rows, '',
    `total blits: ${span > 0 ? (total / span).toFixed(1) : 'n/a'}/s vs HOST_LIMITS.blitRateCap ${HOST_LIMITS.blitRateCap.value}`,
    '', '## Gate 0 items',
    `- blitRateCap: ${rate} blits/s, ${denies} deny total (any deny means the cap or its scope is lower than assumed)`,
    `- framesShownPerSec: resolve/start ${ratio}, delivered fps per key ${Object.entries(fpsBy).map(([k, v]) => `${k}=${v}`).join(' ') || 'n/a'}`,
    `- payloadCapBytes: deny per key ${denyBy.join(' ') || 'n/a'} (look at large rasters at 140 columns)`,
    `- colorPairCap: deny per key ${denyBy.join(' ') || 'n/a'} (or visible colour fallback as the palette grows)`,
    `- clockMinPeriodMs: largest gap between start events (ms) per key ${gapBy.join(' ') || 'n/a'}`,
    '- panesCostMs: not in the trace; time `await $.ui.panes()` in the host',
    `- realTerminalFps: delivered fps hero=${fpsBy.hero ?? 'n/a'} pipeline=${fpsBy.pipeline ?? 'n/a'} over ${ms(span)} s`)
}
console.log(out.join('\n'))
