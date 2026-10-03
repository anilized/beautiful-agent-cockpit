import { expect, test } from 'claude-code/testing'

import { createPhaseFill, createTweens, easeOutCubic, hexToRgb, lerpRgb, rgbToHex } from '../hooks/tween'

const seed = () => { const t = createTweens(); t.target('r1', 'bar', 0, 0, 0); return t }

test('endpoints and monotonic easing', () => {
  const t = seed()
  t.target('r1', 'bar', 100, 0, 200)
  expect(t.sample('r1', 'bar', 0)).toBe(0)
  expect(t.sample('r1', 'bar', 200)).toBe(100)
  expect(t.sample('r1', 'bar', 999)).toBe(100)
  let prev = -1
  for (let ms = 0; ms <= 200; ms += 10) {
    const v = t.sample('r1', 'bar', ms) as number
    expect(v).toBeGreaterThanOrEqual(prev)
    prev = v
  }
  expect(easeOutCubic(0)).toBe(0)
  expect(easeOutCubic(1)).toBe(1)
  expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
})

test('retarget starts from the sampled value, not the old target', () => {
  const t = seed()
  t.target('r1', 'bar', 100, 0, 200)
  const mid = t.sample('r1', 'bar', 100) as number
  expect(mid).toBeGreaterThan(0)
  expect(mid).toBeLessThan(100)
  t.target('r1', 'bar', 0, 100, 200)
  expect(Math.abs((t.sample('r1', 'bar', 100) as number) - mid)).toBeLessThan(1e-9)
  expect(t.sample('r1', 'bar', 300)).toBe(0)
  const before = t.sample('r1', 'bar', 150)
  t.target('r1', 'bar', 0, 150, 200) // same target: no restart
  expect(t.sample('r1', 'bar', 150)).toBe(before)
})

test('per-channel colour: red -> blue midpoint', () => {
  expect(lerpRgb([255, 0, 0], [0, 0, 255], 0.5)).toEqual([128, 0, 128])
  expect(lerpRgb([255, 0, 0], [0, 0, 255], 0)).toEqual([255, 0, 0])
  expect(lerpRgb([255, 0, 0], [0, 0, 255], 1)).toEqual([0, 0, 255])
  expect(rgbToHex(hexToRgb('#ff0000'))).toBe('#ff0000')
  const t = createTweens()
  t.target('r1', 'c', [255, 0, 0], 0, 0)
  t.target('r1', 'c', [0, 0, 255], 0, 100)
  expect(t.sample('r1', 'c', 100)).toEqual([0, 0, 255])
  const m = t.sample('r1', 'c', 50) as number[]
  expect(m[0]).toBeGreaterThan(0)
  expect(m[2]).toBeGreaterThan(0)
  expect(m[1]).toBe(0)
})

test('run-id isolation, run switch snap, reset, motion off snap', () => {
  const t = createTweens()
  t.target('a', 'bar', 10, 0, 0)
  t.target('b', 'bar', 90, 0, 0)
  t.target('a', 'bar', 50, 0, 100)
  expect(t.sample('b', 'bar', 50)).toBe(90)
  expect(t.sample('a', 'bar', 50)).not.toBe(90)
  t.switchRun('a')
  expect(t.sample('a', 'bar', 1)).toBe(50) // snapped
  expect(t.sample('b', 'bar', 1)).toBeUndefined()
  t.target('c', 'bar', 5, 0, 100) // new run: first sight, no animation from a's value
  expect(t.sample('c', 'bar', 0)).toBe(5)
  t.setMotion(false)
  t.target('a', 'bar', 0, 10, 500)
  expect(t.sample('a', 'bar', 10)).toBe(0)
  t.reset()
  expect(t.sample('a', 'bar', 10)).toBeUndefined()
  expect(t.active()).toBe('')
})

test('settled / idle detection', () => {
  const t = seed()
  expect(t.state(0)).toBe('idle')
  t.target('r1', 'bar', 100, 10, 200)
  expect(t.settled('r1', 'bar', 100)).toBe(false)
  expect(t.state(100)).toBe('moving')
  expect(t.settled('r1', 'bar', 210)).toBe(true)
  expect(t.state(210)).toBe('idle')
  expect(t.settled('r1', 'nope', 0)).toBe(true)
})

test('easing is monotonic over a dense sweep', () => {
  let prev = -1
  for (let i = 0; i <= 1000; i++) {
    const v = easeOutCubic(i / 1000)
    expect(v).toBeGreaterThanOrEqual(prev)
    prev = v
  }
  expect(easeOutCubic(-1)).toBe(0)
  expect(easeOutCubic(5)).toBe(1)
})

test('discrete phase stays integer while fill interpolates', () => {
  const p = createPhaseFill(200)
  p.set(2, 0.5, 0)
  expect(p.fill(0)).toBe(0.5) // first sight snaps
  p.set(3, 0, 0)
  expect(p.settled(100)).toBe(false)
  for (let ms = 0; ms <= 200; ms += 10) expect(Number.isInteger(p.phase())).toBe(true)
  expect(p.phase()).toBe(3)
  const mid = p.fill(100)
  expect(mid).toBeGreaterThan(0)
  expect(mid).toBeLessThan(0.5)
  p.set(3, 1, 100) // retarget from the sampled fill
  expect(Math.abs(p.fill(100) - mid)).toBeLessThan(1e-9)
  expect(p.fill(300)).toBe(1)
  expect(p.settled(300)).toBe(true)
  p.set(4, 0, 300, true) // snap
  expect(p.fill(300)).toBe(0)
  p.reset()
  expect(p.phase()).toBe(0)
})

// ---- sample(runId, element, target, nowMs, opts) ----
test('sample: first sight and snap jump immediately; endpoints are exact', () => {
  const t = createTweens()
  expect(t.sample('r1', 'bar', 40, 0)).toBe(40) // first sight
  expect(t.sample('r1', 'bar', 100, 0, { durMs: 200 })).toBe(40)
  expect(t.sample('r1', 'bar', 100, 200, { durMs: 200 })).toBe(100)
  expect(t.sample('r1', 'bar', 100, 9999, { durMs: 200 })).toBe(100)
  expect(t.sample('r1', 'bar', 0, 300, { durMs: 200, snap: true })).toBe(0)
  expect(t.sample('r1', 'bar', 0, 301, { durMs: 200 })).toBe(0)
})

test('sample: dense sweep is monotonic and eases out', () => {
  const t = createTweens()
  t.sample('r1', 'bar', 0, 0)
  let prev = 0
  for (let ms = 0; ms <= 400; ms++) {
    const v = t.sample('r1', 'bar', 100, ms, { durMs: 300 })
    expect(v).toBeGreaterThanOrEqual(prev)
    expect(v).toBeLessThanOrEqual(100)
    prev = v
  }
  expect(prev).toBe(100)
  const u = createTweens()
  u.sample('r1', 'bar', 0, 0)
  u.sample('r1', 'bar', 100, 0, { durMs: 300 })
  expect(u.sample('r1', 'bar', 100, 150, { durMs: 300 })).toBeGreaterThan(50)
})

test('sample: retargets from the sampled value, not the old target', () => {
  const t = createTweens()
  t.sample('r1', 'bar', 0, 0)
  t.sample('r1', 'bar', 100, 0, { durMs: 200 })
  const mid = t.sample('r1', 'bar', 100, 80, { durMs: 200 })
  expect(mid).toBeGreaterThan(0)
  expect(mid).toBeLessThan(100)
  expect(Math.abs(t.sample('r1', 'bar', 0, 80, { durMs: 200 }) - mid)).toBeLessThan(1e-9)
  expect(t.sample('r1', 'bar', 0, 280, { durMs: 200 })).toBe(0)
})

test('sample: colours ease per RGB channel', () => {
  const red: [number, number, number] = [255, 0, 0]
  const blue: [number, number, number] = [0, 0, 255]
  const t = createTweens()
  expect(t.sample('r1', 'c', red, 0)).toEqual(red)
  t.sample('r1', 'c', blue, 0, { durMs: 100 })
  const [r, g, b] = t.sample('r1', 'c', blue, 30, { durMs: 100 })
  expect(g).toBe(0)
  expect(r).toBeLessThan(255)
  expect(r).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(0)
  expect(b).toBeLessThan(255)
  expect(t.sample('r1', 'c', blue, 100, { durMs: 100 })).toEqual(blue)
})

test('sample: runs are isolated; resetRun and reset drop state so a switch never eases', () => {
  const t = createTweens()
  t.sample('r1', 'bar', 10, 0)
  t.sample('r2', 'bar', 90, 0)
  t.sample('r1', 'bar', 50, 0, { durMs: 100 })
  expect(t.sample('r2', 'bar', 90, 50, { durMs: 100 })).toBe(90) // r1 moving never affects r2
  t.resetRun('r1')
  expect(t.sample('r1', 'bar', 77, 60, { durMs: 100 })).toBe(77) // first sight again: no ease from the old value
  expect(t.sample('r2', 'bar', 90, 60, { durMs: 100 })).toBe(90)
  t.reset()
  expect(t.sample('r2', 'bar', 5, 70, { durMs: 100 })).toBe(5)
  expect(t.sample('r2', 'bar', 5, 70)).toBe(5)
})

test('sample: motion off snaps every target', () => {
  const t = createTweens()
  t.setMotion(false)
  t.sample('r1', 'bar', 0, 0)
  expect(t.sample('r1', 'bar', 100, 1, { durMs: 500 })).toBe(100)
})
