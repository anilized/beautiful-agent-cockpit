import { expect, test } from 'claude-code/testing'

import * as r from '../hooks/raster'
import { K } from '../hooks/theme'

// The test runtime may lack Uint8Array.prototype.toBase64 (the plugin host has it); shim for decoding only.
const u8 = Uint8Array.prototype as unknown as { toBase64?: () => string }
u8.toBase64 ??= function (this: Uint8Array) {
  let s = ''
  for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]!)
  return btoa(s)
}

const steps = ['architect', 'debate', 'plan', 'build', 'integrate', 'validate', 'approve', 'merge']
const hdata = { online: true, left: 'opus ▸ codex ▸ workers', right: 'online :4317  00:00:00', alert: true }
const values = Array.from({ length: 60 }, (_, i) => (i * 7) % 5)
const tabs = [10, 12, 9, 8]
const meter = { values: [0.8, 0.35, 0.6], colors: [K.cyan, K.violet, K.green], labels: ['calls', 'tokens', 'cost'] }

type Case = [name: string, rows: number, paint: (size: r.Size, t: number) => string]
const cases: Case[] = [
  ['hero', 4, (z, t) => r.hero(z, t, hdata)],
  ['hero-offline', 4, (z, t) => r.hero(z, t, { ...hdata, online: false, alert: false })],
  ['pipeline', 2, (z, t) => r.pipeline(z, t, { steps, phase: 3, fill: 0.4, failed: false, color: K.cyan })],
  ['pipeline-failed', 2, (z, t) => r.pipeline(z, t, { steps, phase: 5, fill: 0.9, failed: true, color: K.cyan })],
  ['pipeline-one', 2, (z, t) => r.pipeline(z, t, { steps: ['solo'], phase: 0, fill: 0, failed: false, color: K.cyan })],
  ['pipeline-none', 2, (z, t) => r.pipeline(z, t, { steps: [], phase: 0, fill: 0, failed: false, color: K.cyan })],
  ['progress', 1, (z, t) => r.progress(z, t, { frac: 0.75, live: true })],
  ['progress-idle', 1, (z, t) => r.progress(z, t, { frac: 0, live: false })],
  ['spark', 1, (z, t) => r.spark(z, t, { values, live: true })],
  ['spark-3rows', 3, (z, t) => r.spark(z, t, { values, live: true })],
  ['spark-empty', 1, (z, t) => r.spark(z, t, { values: [], live: false })],
  ['orb', 2, (z, t) => r.orb(z, t, { color: K.violet, active: true, seed: 2 })],
  ['orb-idle', 2, (z, t) => r.orb(z, t, { color: K.violet, active: false, seed: 0 })],
  ['divider', 1, (z, t) => r.divider(z, t, { color: K.violet, active: true })],
  ['divider-idle', 1, (z, t) => r.divider(z, t, { color: K.violet, active: false })],
  ['underline', 1, (z, t) => r.underline(z, t, { tabs, active: 1.5, color: K.accent })],
  ['underline-none', 1, (z, t) => r.underline(z, t, { tabs: [], active: 0, color: K.accent })],
  ['meters', 3, (z, t) => r.meters(z, t, meter)],
  ['meters-none', 3, (z, t) => r.meters(z, t, { values: [], colors: [], labels: [] })],
]
const COLS = [1, 2, 40, 60, 100, 140]

const decode = (b64: string) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
// orb is a 4x2 avatar; every other painter takes the width under test.
const sizeFor = (name: string, rows: number, cols: number): r.Size => (name.startsWith('orb') ? { cols: 4, rows } : { cols, rows })

test('every painter returns exactly cols*rows*12 bytes at every width, deterministically', () => {
  for (const [name, rows, paint] of cases)
    for (const cols of COLS) {
      const z = sizeFor(name, rows, cols)
      const a = paint(z, 12345)
      expect(decode(a).length).toBe(z.cols * z.rows * 12)
      expect(paint(z, 12345)).toBe(a)
    }
})

test('orb paints any size, including 1x1 and 8x4', () => {
  for (const [cols, rows] of [[1, 1], [2, 1], [4, 2], [8, 4]] as const) {
    const out = r.orb({ cols, rows }, 777, { color: K.cyan, active: true, seed: 1 })
    expect(decode(out).length).toBe(cols * rows * 12)
  }
})

const pairCount = (b64: string) => {
  const w = new Uint32Array(decode(b64).buffer)
  const pairs = new Set<string>()
  for (let i = 0; i < w.length; i += 3) pairs.add(`${w[i + 1]}/${w[i + 2]}`)
  return pairs.size
}

test('frame-rate independence: 16 ms and 33 ms clocks give identical frames at shared instants', () => {
  // Simulated clocks accumulate ticks and paint each one; 1000 is not a multiple of 16, so the shared instants
  // are 528 ms apart: T and T+1056 (~1 s). Animated painters must also differ between them.
  const run = (step: number, to: number, paint: (t: number) => string) => {
    const out = new Map<number, string>()
    for (let t = 0; t <= to; t += step) if (t % 528 === 0) out.set(t, paint(t))
    return out
  }
  const T = 528 * 100, T2 = T + 1056
  const moving = new Set(['hero', 'pipeline', 'progress', 'divider'])
  for (const [name, rows, paint] of cases) {
    const z = sizeFor(name, rows, 100)
    const a = run(16, T2, t => paint(z, t)), b = run(33, T2, t => paint(z, t))
    for (const t of [T, T2]) {
      expect(a.get(t)).toBeDefined()
      expect(a.get(t)).toBe(b.get(t))
    }
    if (moving.has(name)) expect(a.get(T)).not.toBe(a.get(T2))
  }
})

test('animation depends on time: moving painters differ across a second, static ones do not', () => {
  const z = (rows: number) => ({ cols: 100, rows })
  expect(r.hero(z(4), 0, hdata)).not.toBe(r.hero(z(4), 400, hdata))
  expect(r.divider(z(1), 0, { color: K.cyan, active: true })).not.toBe(r.divider(z(1), 400, { color: K.cyan, active: true }))
  expect(r.divider(z(1), 0, { color: K.cyan, active: false })).toBe(r.divider(z(1), 400, { color: K.cyan, active: false }))
  expect(r.progress(z(1), 0, { frac: 0.5, live: false })).toBe(r.progress(z(1), 400, { frac: 0.5, live: false }))
})

test('<=512 distinct fg/bg pairs per frame at 140 columns', () => {
  const over: string[] = []
  for (const [name, rows, paint] of cases) {
    const z = sizeFor(name, rows, 140)
    for (const t of [0, 1500, 7777, 123457, 987654]) {
      const n = pairCount(paint(z, t))
      if (n > 512) over.push(`${name}@${t}: ${n}`)
    }
  }
  expect(over).toEqual([])
})

test('hero stays <=512 pairs over 200 timestamps, alert on/off, 4 and 6 rows', () => {
  let max = 0
  for (const alert of [true, false])
    for (const rows of [4, 6])
      for (let i = 0; i < 200; i++) max = Math.max(max, pairCount(r.hero({ cols: 140, rows }, i * 997, { ...hdata, alert })))
  expect(max).toBeLessThanOrEqual(512)
})

test('pipeline: integer phase drives glyphs, fractional fill only paints the connector', () => {
  const glyphs = (fill: number, failed = false) => {
    const w = new Uint32Array(decode(r.pipeline({ cols: 100, rows: 2 }, 5000, { steps, phase: 3, fill, failed, color: K.cyan })).buffer)
    const row: number[] = []
    for (let x = 0; x < 100; x++) row.push(w[x * 3]!)
    return row.filter(ch => ch !== 0x20 && ch !== 0x2501)
  }
  expect(glyphs(0)).toEqual(glyphs(0.77))
  expect(glyphs(0.5).map(c => String.fromCodePoint(c)).join('')).toBe('●●●◉○○○○')
  expect(glyphs(0.5, true).map(c => String.fromCodePoint(c)).join('')).toBe('●●●✗○○○○')
})

// Palette-literal greps (raster.ts has none, theme.ts owns them, 'register.tsx has no palette literals')
// run in `npm run palette` (tests/tools.mjs), since the plugin test host has no fs.
