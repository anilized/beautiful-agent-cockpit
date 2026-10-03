// Value easing keyed `${runId}:${element}`. Pure; time is passed in (ms), never counted in frames.
export type Rgb = [number, number, number]
type Val = number | Rgb
type Tween = { run: string; from: Val; to: Val; t0: number; dur: number }

export const easeOutCubic = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3

/** Per-channel blend; packed ints must never be lerped. */
export const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb
export const hexToRgb = (h: string): Rgb => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb
export const rgbToHex = (c: Rgb) => '#' + c.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')

const mix = (a: Val, b: Val, t: number): Val => (typeof a === 'number' && typeof b === 'number' ? a + (b - a) * t : lerpRgb(a as Rgb, b as Rgb, t))
const same = (a: Val, b: Val) => (typeof a === 'number' ? a === b : (b as Rgb).every((v, i) => v === a[i]))

export const createTweens = () => {
  const m = new Map<string, Tween>()
  let run = ''
  let motion = true
  const k = (r: string, el: string) => `${r}:${el}`
  const at = (e: Tween, now: number): Val => mix(e.from, e.to, e.dur > 0 ? easeOutCubic((now - e.t0) / e.dur) : 1)
  const sample = (r: string, el: string, now: number): Val | undefined => {
    const e = m.get(k(r, el))
    return e && at(e, now)
  }
  return {
    sample,
    /** Retargets from the currently sampled value. First sight of an element, motion off or zero duration snaps. */
    target(r: string, el: string, value: Val, now: number, durMs: number) {
      const e = m.get(k(r, el))
      if (!e || !motion || durMs <= 0) return void m.set(k(r, el), { run: r, from: value, to: value, t0: now, dur: 0 })
      if (same(e.to, value)) return
      m.set(k(r, el), { run: r, from: at(e, now), to: value, t0: now, dur: durMs })
    },
    /** Another run's values never animate into this one: drop them, snap the rest. */
    switchRun(r: string) {
      run = r
      for (const [key, e] of m) if (e.run !== r) m.delete(key)
      else e.from = e.to, e.dur = 0
    },
    setMotion(on: boolean) {
      motion = on
      if (!on) for (const e of m.values()) e.from = e.to, e.dur = 0
    },
    active: () => run,
    reset() { m.clear(), run = '' },
  }
}
export type Tweens = ReturnType<typeof createTweens>
