import { expect, test } from 'claude-code/testing'

import { CADENCE, HOST_LIMITS, TRACE_RING, createTrace, resolveCadence } from '../hooks/limits'

test('resolveCadence: unset, invalid and valid COCKPIT_CADENCE', () => {
  expect(resolveCadence(undefined).name).toBe('conservative')
  expect(resolveCadence({}).name).toBe('conservative')
  expect(resolveCadence({ COCKPIT_CADENCE: 'turbo' }).name).toBe('conservative')
  expect(resolveCadence({ COCKPIT_CADENCE: '' }).name).toBe('conservative')
  expect(resolveCadence({ COCKPIT_CADENCE: 'full' }).name).toBe('full')
  expect(resolveCadence({ COCKPIT_CADENCE: 'conservative' })).toEqual({ name: 'conservative', ...CADENCE.conservative })
  expect(CADENCE.conservative).toEqual({ totalPerSec: 60, tierAFps: 30, tierBFps: 15, urgentReserve: 0.1, framePeriodMs: 16, idlePeriodMs: 500 })
})

test('trace off: record is a no-op and dump is empty', () => {
  const t = createTrace(false)
  expect(t.on).toBe(false)
  t.record('hero', 'start', 1, 2)
  expect(t.dump()).toBe('')
})

test('trace on: fixed-size per-key ring wraps and keeps the newest events', () => {
  const t = createTrace(true, 4)
  for (let i = 0; i < 10; i++) t.record('hero', 'start', i, 0.5)
  t.record('orb0', 'deny', 99)
  const lines = t.dump().split('\n')
  const hero = lines.filter(l => l.startsWith('hero '))
  expect(hero.length).toBe(4)
  expect(hero[0]).toBe('hero start 6.00 0.500')
  expect(hero[3]).toBe('hero start 9.00 0.500')
  expect(lines.filter(l => l.startsWith('orb0 ')).length).toBe(1)
  expect(TRACE_RING).toBeGreaterThan(0)
})

test('HOST_LIMITS: every field tagged, documented fields cited', () => {
  for (const [name, f] of Object.entries(HOST_LIMITS) as [string, { source: string; cite: string }][]) {
    expect(['documented', 'default', 'measured']).toContain(f.source)
    if (f.source === 'documented') expect(f.cite).toMatch(/d\.ts:\d+/)
    expect(f.cite.length, name).toBeGreaterThan(0)
  }
  expect(Object.keys(HOST_LIMITS).length).toBe(7)
})
