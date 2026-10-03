import { expect, test } from 'claude-code/testing'

import { createTweens, easeOutCubic, hexToRgb, lerpRgb, rgbToHex } from '../hooks/tween'

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
