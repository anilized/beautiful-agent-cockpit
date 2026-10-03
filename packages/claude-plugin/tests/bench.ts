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
const pipe = { steps, phase: 6, fill: 0.5, failed: false, color: r.hex('#22d3ee') }
const mv = [0.9, 0.6, 0.3, 0.1]
// Time-based painters: `f` is the iteration, elapsed ms = f * 16.
const cases: [string, (f: number) => string][] = [
  ['hero 140x4', f => r.hero(COLS, 4, f * 16, hero)],
  ['pipeline 136x2', f => r.pipeline(COLS - 4, 2, f * 16, pipe)],
  ['progress 100x1', f => r.progress(100, 1, f * 16, { frac: 0.75, live: true })],
  ['spark 60x1', f => r.spark(60, 1, f * 16, { values, live: true })],
  ['divider 138x1', f => r.divider(COLS - 2, 1, f * 16, { color: r.hex('#22d3ee'), active: true })],
  ['underline 136x1', f => r.underline(COLS - 4, 1, f * 16, { tabs: [12, 12, 8], active: 1.4, color: r.hex('#ff8a3d') })],
  ['meters 40x4', f => r.meters(40, 4, f * 16, { values: mv, colors: mv.map(() => r.hex('#34d399')), labels: mv.map((_, i) => `agent${i} ${i}`) })],
  ...[0, 1, 2, 3].map((i): [string, (f: number) => string] => [`orb ${i} 4x2`, f => r.orb(4, 2, f * 16, { color: r.hex('#a78bfa'), active: true, seed: i })]),
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
