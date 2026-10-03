import { expect, test } from 'claude-code/testing'

import * as r from '../hooks/raster'

// The test runtime may lack Uint8Array.prototype.toBase64 (the plugin host has it); shim, as in raster.test.ts.
const u8 = Uint8Array.prototype as unknown as { toBase64?: () => string }
u8.toBase64 ??= function (this: Uint8Array) {
  let s = ''
  for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]!)
  return btoa(s)
}

const steps = ['architect', 'debate', 'plan', 'build', 'integrate', 'validate', 'approve', 'merge']
const values = Array.from({ length: 61 }, (_, i) => (i * 7) % 5)
const mv = [0.9, 0.6, 0.3]
const cyan = r.hex('#22d3ee')

// The live fixture's mount at 140 columns (sizes as in scripts/bench.ts and tests/evidence/after/live-140.json).
const paintAll = (t: number) => [
  r.hero({ cols: 140, rows: 4 }, t, { online: true, left: 'opus ▸ codex ▸ workers', right: 'online :4317  00:00:00', alert: true }),
  r.divider({ cols: 72, rows: 1 }, t, { color: cyan, active: true }),
  r.pipeline({ cols: 70, rows: 2 }, t, { steps, phase: 3, fill: 0.5, failed: false, color: cyan }),
  r.progress({ cols: 64, rows: 1 }, t, { frac: 0.75, live: true }),
  r.spark({ cols: 61, rows: 1 }, t, { values, live: true }),
  r.underline({ cols: 70, rows: 1 }, t, { tabs: [12, 12, 8], active: 1.4, color: cyan }),
  r.meters({ cols: 34, rows: 3 }, t, { values: mv, colors: mv.map(() => cyan), labels: ['sup 3', 'lead 2', 'w0 1'] }),
  ...[0, 1, 2].map(i => r.orb({ cols: 4, rows: 2 }, t, { color: cyan, active: true, seed: i })),
]

test('bench: all live rasters at 140 columns paint in < 4 ms mean per frame', () => {
  for (let i = 0; i < 300; i++) paintAll(i * 16) // warm-up
  const N = 1000
  const t0 = performance.now()
  let bytes = 0
  for (let i = 0; i < N; i++) bytes += paintAll((300 + i) * 16).reduce((a, s) => a + s.length, 0)
  const mean = (performance.now() - t0) / N
  expect(bytes).toBeGreaterThan(0)
  expect(mean).toBeLessThan(4)
})
