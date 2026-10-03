// Scratch plugin for `npm run probe` (copied over hooks/register.tsx in a temp dir; never loaded in the real plugin).
// Reports through $.ui.status because tests cannot call $.clock directly.
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const say = (k: string, v: unknown) => void $.ui.status(`${k}=${JSON.stringify(v)}`)
    let n1 = 0
    let last = performance.now()
    let monotonic = true
    let maxStep = 0
    const w0 = await $.clock.now()
    const p0 = performance.now()
    const c1 = $.clock.every(1, () => {
      n1++
      const p = performance.now()
      if (p < last) monotonic = false
      maxStep = Math.max(maxStep, p - last)
      last = p
      if (n1 === 100) {
        c1.cancel()
        void $.clock.now().then(w => say('every1', { fires: n1, perfMonotonic: monotonic, perfDeltaMs: +(p - p0).toFixed(2), maxStepMs: +maxStep.toFixed(2), wallDeltaMs: w - w0 }))
      }
    })
    let n0 = 0
    try {
      const c0 = $.clock.every(0, () => {
        n0++
        if (n0 === 10) { c0.cancel(); say('every0', { fires: n0 }) }
      })
    } catch (err) {
      say('every0', { throws: String(err).slice(0, 80) })
    }
    return next(e)
  })
}
