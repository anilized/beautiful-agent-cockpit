// Paint micro-benchmark: every raster painter at 140 columns, per painter and combined. Budget: combined mean < 4 ms.
// Run by `npm run bench` (node --experimental-transform-types). BENCH_N overrides iterations.
import * as r from '../hooks/raster.ts'

// Node 22.14 lacks Uint8Array.prototype.toBase64 (the plugin host has it); shim with Buffer for timing only.
const u8 = Uint8Array.prototype as unknown as { toBase64?: () => string }
u8.toBase64 ??= function (this: Uint8Array) { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64') }

const COLS = 140
const N = Number(process.env.BENCH_N ?? 2000)
const steps = ['architect', 'debate', 'plan', 'build', 'integrate', 'validate', 'approve', 'merge']
const values = Array.from({ length: COLS - 80 }, (_, i) => (i * 7) % 5)
const hero = { online: true, left: 'opus ▸ codex ▸ workers', right: 'online :4317  00:00:00', alert: true }
const pipe = { steps, phase: 6, failed: false, color: r.hex('#22d3ee') }
// Painters take a frame counter today; the time-based API replaces `f` with elapsed ms (f = t / 60 ms here).
const cases: [string, (f: number) => string][] = [
  ['hero 140x4', f => r.hero(COLS, 4, f, hero)],
  ['pipeline 136x2', f => r.pipeline(COLS - 4, f, pipe)],
  ['progress 100x1', f => r.progress(100, f, 0.75, true)],
  ['spark 60x1', f => r.spark(60, 1, f, values, true)],
  ...[0, 1, 2, 3].map((i): [string, (f: number) => string] => [`orb ${i} 4x2`, f => r.orb(f, r.hex('#a78bfa'), true, i)]),
]

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]! }
}
const fmt = (ms: number) => ms.toFixed(3).padStart(8)
let sink = 0
for (let i = 0; i < 300; i++) for (const [, fn] of cases) sink += fn(i).length // warm-up

console.log(`bench: ${N} iterations, node ${process.version}, ${COLS} columns`)
console.log(`${'painter'.padEnd(16)}${'mean ms'.padStart(9)}${'p95 ms'.padStart(9)}${'max ms'.padStart(9)}  bytes(b64)`)
const frames: number[] = Array(N).fill(0)
for (const [name, fn] of cases) {
  const xs: number[] = []
  let bytes = 0
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const out = fn(i)
    const dt = performance.now() - t0
    xs.push(dt)
    frames[i]! += dt
    bytes = out.length
    sink += bytes
  }
  const s = stats(xs)
  console.log(`${name.padEnd(16)}${fmt(s.mean)} ${fmt(s.p95)} ${fmt(s.max)}  ${bytes}`)
}
const c = stats(frames)
console.log(`${'COMBINED'.padEnd(16)}${fmt(c.mean)} ${fmt(c.p95)} ${fmt(c.max)}  (budget: mean < 4 ms) ${c.mean < 4 ? 'PASS' : 'FAIL'}`)
if (sink < 0) console.log(sink)
process.exitCode = c.mean < 4 ? 0 : 1
