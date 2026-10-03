// Before/after raster dumps of the LIVE fixture at 60 and 140 columns, decoded to a text grid plus a .json cells dump.
// Run by `npm run capture` (node --experimental-transform-types). Rasters come from the harness tree (tests/capture.ts under `claude plugin test`, mock t=0),
// so they are exactly what register.tsx mounts. BEFORE = baseline register+raster compiled in a scratch dir only; AFTER = current hooks. Not a terminal screenshot.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ev = join(pkg, 'tests', 'evidence')
const DFLT = 0x01000000

function harness(baseline: boolean): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'cockpit-capture-'))
  try {
    for (const d of ['hooks', 'types', '.claude-plugin']) cpSync(join(pkg, d), join(tmp, d), { recursive: true })
    if (baseline) {
      writeFileSync(join(tmp, 'hooks', 'register.tsx'), readFileSync(join(ev, 'baseline', 'register.baseline.txt'), 'utf8'))
      writeFileSync(join(tmp, 'hooks', 'raster.ts'), readFileSync(join(ev, 'baseline', 'raster.baseline.txt'), 'utf8'))
    }
    mkdirSync(join(tmp, 'tests'))
    cpSync(join(pkg, 'tests', 'fixture.ts'), join(tmp, 'tests', 'fixture.ts'))
    writeFileSync(join(tmp, 'tests', 'capture.test.tsx'), readFileSync(join(pkg, 'tests', 'capture.ts'), 'utf8'))
    const r = spawnSync('claude', ['plugin', 'test', tmp], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28 })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    if (r.status !== 0) throw new Error(`claude plugin test failed (exit ${r.status})\n${out}`)
    return out.split(/\r?\n/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

type Dump = { key: string; columns: number; rows: number; props: Record<string, unknown>; cells: number[][][]; base64: string }

// Parses the CAP<cols>| lines of the `live` scenario into rasters.
function parse(lines: string[], cols: number): Dump[] {
  const mine = lines.filter(l => l.startsWith(`CAP${cols}|`)).map(l => l.slice(l.indexOf('|') + 1))
  const start = mine.findIndex(l => l.startsWith('=== live @'))
  const end = mine.findIndex((l, i) => i > start && l.startsWith('=== '))
  const live = mine.slice(start, end < 0 ? undefined : end)
  const out: Dump[] = []
  for (let i = 0; i < live.length; i++) {
    const m = /^\s*Raster#(\S+) (\d+)x(\d+)/.exec(live[i]!)
    if (!m) continue
    const props = JSON.parse(live[i + 1]!.trim().slice('props '.length))
    const base64 = live[i + 2]!.trim().slice('cells.base64 '.length)
    const columns = +m[2]!, rows = +m[3]!
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length !== columns * rows * 12) throw new Error(`${m[1]}: ${bytes.length} bytes, want ${columns * rows * 12}`)
    const w = new Uint32Array(bytes.buffer, bytes.byteOffset, columns * rows * 3)
    const cells = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => [w[(y * columns + x) * 3]!, w[(y * columns + x) * 3 + 1]!, w[(y * columns + x) * 3 + 2]!]))
    out.push({ key: m[1]!, columns, rows, props, cells, base64 })
  }
  return out
}

const hx = (n: number) => (n & DFLT ? 'dflt  ' : (n & 0xffffff).toString(16).padStart(6, '0'))
const pairsOf = (d: Dump) => new Set(d.cells.flat().map(c => `${c[1]}/${c[2]}`)).size

function grid(label: string, cols: number, ds: Dump[]) {
  const o = [`# ${label} @ ${cols} columns, LIVE fixture, harness mock t=0 (decoded Raster cells; not a terminal screenshot)`, '']
  for (const d of ds) {
    o.push(`## ${d.key} ${d.columns}x${d.rows} colour-pairs=${pairsOf(d)}`)
    d.cells.forEach((row, y) => {
      o.push(`row${y} chars |${row.map(c => String.fromCodePoint(c[0]!)).join('')}|`)
      o.push(`row${y} fg    ${row.map(c => hx(c[1]!)).join(' ')}`)
      o.push(`row${y} bg    ${row.map(c => hx(c[2]!)).join(' ')}`)
    })
    o.push('')
  }
  return o.join('\n')
}

for (const [label, baseline] of [['before', true], ['after', false]] as const) {
  const lines = harness(baseline)
  const dir = join(ev, label)
  mkdirSync(dir, { recursive: true })
  for (const cols of [60, 140]) {
    const ds = parse(lines, cols)
    if (!ds.length) throw new Error(`no rasters captured for ${label} @ ${cols}`)
    writeFileSync(join(dir, `live-${cols}.txt`), grid(label, cols, ds) + '\n')
    writeFileSync(join(dir, `live-${cols}.json`), JSON.stringify({ scenario: 'live', label, columns: cols, note: 'cells[row][col] = [codepoint, fg, bg]; 0x01000000 = default colour', rasters: ds.map(({ cells, ...d }) => ({ ...d, cells })) }) + '\n')
    console.log(`wrote tests/evidence/${label}/live-${cols}.txt and .json: ${ds.map(d => `${d.key}(${d.columns}x${d.rows},${pairsOf(d)} pairs)`).join(' ')}`)
  }
}
