// Paint micro-benchmark at 140 columns: every raster register.tsx mounts for the LIVE fixture (sizes from tests/evidence/after/live-140.json),
// new painters (hooks/raster.ts) and, for the before number, the baseline painters (compiled from the .txt to a temp .ts at run time, removed after).
// Run by `npm run bench` (node --experimental-transform-types). BENCH_N overrides the frame count (default 2000, after 300 warm-up frames).
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as r from '../hooks/raster.ts'

// Node 22.14 lacks Uint8Array.prototype.toBase64 (the plugin host has it); shim with Buffer for timing only.
const u8 = Uint8Array.prototype as unknown as { toBase64?: () => string }
u8.toBase64 ??= function (this: Uint8Array) { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64') }

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const N = Number(process.env.BENCH_N ?? 2000)
const BUDGET_MS = 4
const steps = ['architect', 'debate', 'plan', 'build', 'integrate', 'validate', 'approve', 'merge']
const values = Array.from({ length: 61 }, (_, i) => (i * 7) % 5)
const mv = [0.9, 0.6, 0.3]
const cyan = r.hex('#22d3ee')

type Case = [name: string, paint: (f: number) => string]
const ms = (f: number) => f * 16 // frame f at 16 ms
const after: Case[] = [
  ['hero 140x4', f => r.hero(140, 4, ms(f), { online: true, left: 'opus ▸ codex ▸ workers', right: 'online :4317  00:00:00', alert: true })],
  ['divider 72x1', f => r.divider(72, 1, ms(f), { color: cyan, active: true })],
  ['pipeline 70x2', f => r.pipeline(70, 2, ms(f), { steps, phase: 3, fill: 0.5, failed: false, color: cyan })],
  ['progress 64x1', f => r.progress(64, 1, ms(f), { frac: 0.75, live: true })],
  ['spark 61x1', f => r.spark(61, 1, ms(f), { values, live: true })],
  ['underline 70x1', f => r.underline(70, 1, ms(f), { tabs: [12, 12, 8], active: 1.4, color: r.hex('#ff8a3d') })],
  ['meters 34x3', f => r.meters(34, 3, ms(f), { values: mv, colors: mv.map(() => r.hex('#34d399')), labels: ['sup 3', 'lead 2', 'w0 1'] })],
  ...(['sup', 'lead', 'w0'] as const).map((k, i): Case => [`orb-${k} 4x2`, f => r.orb(4, 2, ms(f), { color: r.hex('#a78bfa'), active: true, seed: i })]),
]

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]! }
}
const fmt = (x: number) => x.toFixed(3).padStart(8)
let sink = 0

function run(title: string, cases: Case[]) {
  for (let i = 0; i < 300; i++) for (const [, fn] of cases) sink += fn(i).length // warm-up
  console.log(`\n${title}: ${N} frames after 300 warm-up, 140 columns`)
  console.log(`${'painter'.padEnd(16)}${'mean ms'.padStart(9)}${'p95 ms'.padStart(9)}${'max ms'.padStart(9)}  bytes(b64)`)
  const frames: number[] = Array(N).fill(0)
  for (const [name, fn] of cases) {
    const xs: number[] = []
    let bytes = 0
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      const out = fn(i + 300)
      const dt = performance.now() - t0
      xs.push(dt), (frames[i] = frames[i]! + dt), (bytes = out.length), (sink += bytes)
    }
    const s = stats(xs)
    console.log(`${name.padEnd(16)}${fmt(s.mean)} ${fmt(s.p95)} ${fmt(s.max)}  ${bytes}`)
  }
  const c = stats(frames)
  console.log(`${'COMBINED'.padEnd(16)}${fmt(c.mean)} ${fmt(c.p95)} ${fmt(c.max)}  (budget: mean < ${BUDGET_MS} ms) ${c.mean < BUDGET_MS ? 'PASS' : 'FAIL'}`)
  return c
}

console.log(`bench: node ${process.version}, ${process.platform}/${process.arch}, BENCH_N=${N}`)
const a = run('AFTER (hooks/raster.ts)', after)

// BEFORE: baseline painters take frame counters at 16 fps and have different signatures; only the 7 rasters the old pane mounted.
const tmp = join(pkg, 'tests', 'evidence', 'baseline', 'raster.baseline.run.ts')
let b: ReturnType<typeof stats> | undefined
try {
  writeFileSync(tmp, readFileSync(join(pkg, 'tests', 'evidence', 'baseline', 'raster.baseline.txt'), 'utf8'))
  const o = (await import(pathToFileURL(tmp).href)) as Record<string, (...a: any[]) => string>
  const hexb = o.hex!
  const before: Case[] = [
    ['hero 140x4', f => o.hero!(140, 4, f, { online: true, left: 'opus ▸ codex ▸ workers', right: 'online :4317  00:00:00', alert: true })],
    ['pipeline 70x2', f => o.pipeline!(70, f, { steps, phase: 3, failed: false, color: hexb('#22d3ee') })],
    ['progress 64x1', f => o.progress!(64, f, 0.75, true)],
    ['spark 61x1', f => o.spark!(61, 1, f, values, true)],
    ...[0, 1, 2].map((i): Case => [`orb-${['sup', 'lead', 'w0'][i]} 4x2`, f => o.orb!(f, hexb('#a78bfa'), true, i)]),
  ]
  b = run('BEFORE (baseline raster, frame-counter API)', before)
} finally { rmSync(tmp, { force: true }) }
if (b) console.log(`\nbefore combined mean ${b.mean.toFixed(3)} ms (7 rasters) vs after ${a.mean.toFixed(3)} ms (10 rasters)`)
if (sink < 0) console.log(sink)
process.exitCode = a.mean < BUDGET_MS ? 0 : 1
