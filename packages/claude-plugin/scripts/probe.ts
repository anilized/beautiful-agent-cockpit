// Gate 0 probe: prints HOST_LIMITS and the COCKPIT_TRACE ring in a form that pastes into GATE0.md.
// Run by `npm run probe` (node --experimental-transform-types). Trace lines only exist when the process that blits ran with COCKPIT_TRACE=1;
// in a live host, call `trace.dump()` from the mod (after enableTrace) and paste it here.
import { CADENCE, HOST_LIMITS, resolveCadence, trace } from '../hooks/limits.ts'

const p = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!
const out: string[] = ['## HOST_LIMITS']
for (const [k, f] of Object.entries(HOST_LIMITS) as [string, { value: unknown; source: string; cite: string; scope?: string }][])
  out.push(`- ${k}: ${JSON.stringify(f.value)} [${f.source}] ${f.cite}${f.scope ? ` scope=${f.scope}` : ''}`)
const c = resolveCadence(p.env)
out.push('', `## CADENCE ${c.name}`, JSON.stringify(CADENCE[c.name]), '', `## TRACE (on=${trace.on})`)
out.push(trace.on ? trace.dump() || '(no events recorded in this process)' : '(off: run the blitting process with COCKPIT_TRACE=1)')
console.log(out.join('\n'))
