// HARNESS SNAPSHOT (the tree the mod returns under the test kit at mock t=0, then at later mock times to show motion), not a terminal paint, of the pane at 60 and 140 columns.
// Every element's props are dumped as JSON; every Raster keeps its full base64 payload plus each decoded [glyph fg bg] triplet. Run by `npm run capture` (scratch copy as capture.test.tsx; tests have no fs).
import { test } from 'claude-code/testing'

import { LIVE, OFFLINE } from './fixture'

// Mock times in ms; t=0 is the primary dump, the rest show motion.
const STAMPS = [0, 500, 1056]

declare const console: { log(...a: unknown[]): void }

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

type N = string | { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

const hex = (n: number) => (n & 0x01000000 ? 'dflt' : (n & 0xffffff).toString(16).padStart(6, '0'))

function raster(p: Record<string, unknown>) {
  const cols = p.columns as number, rows = p.rows as number
  const bin = atob(p.cells as string)
  const w = new Uint32Array(cols * rows * 3)
  const u8 = new Uint8Array(w.buffer)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  const pairs = new Set<number | string>()
  const lines: string[] = []
  const trip: string[] = []
  for (let y = 0; y < rows; y++) {
    let s = ''
    let t = ''
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 3
      s += String.fromCodePoint(w[i]!)
      pairs.add(`${w[i + 1]}/${w[i + 2]}`)
      t += `${w[i]!.toString(16)}:${hex(w[i + 1]!)}:${hex(w[i + 2]!)} `
    }
    lines.push(s)
    trip.push(t.trimEnd())
  }
  const first = 0
  return { lines, trip, pairs: pairs.size, sample: `${hex(w[first + 1]!)}/${hex(w[first + 2]!)}` }
}

function walk(n: N, d: number, out: string[], pairs: { total: Set<string>; per: string[] }) {
  if (typeof n === 'string') return void (n.trim() && out.push(`${' '.repeat(d)}"${n}"`))
  if (!n || typeof n !== 'object') return
  const pad = ' '.repeat(d)
  const props = n.props ?? {}
  if (n.type === 'Raster') {
    const r = raster(props)
    out.push(`${pad}Raster#${n.key ?? props.key} ${props.columns}x${props.rows} pairs=${r.pairs} c0=${r.sample}`)
    out.push(`${pad}  props ${JSON.stringify({ ...props, cells: undefined })}`)
    out.push(`${pad}  cells.base64 ${props.cells}`)
    r.lines.forEach((l, y) => {
      out.push(`${pad}  |${l}|`)
      out.push(`${pad}  row${y} cp:fg:bg ${r.trip[y]}`)
    })
    pairs.per.push(`${n.key ?? props.key}:${r.pairs}`)
    return
  }
  const tag = [n.type, n.key ?? props.key].filter(Boolean).join('#')
  const { children: _c, ...rest } = props
  out.push(`${pad}<${tag}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}>`)
  for (const c of n.children ?? (props.children as unknown[]) ?? []) walk(c as N, d + 1, out, pairs)
}

for (const [name, snap] of [['live', LIVE], ['offline', OFFLINE]] as const) {
  test(`capture ${name}`, async ($, on) => {
    const { mock } = await import('claude-code/testing')
    on('fs.read', async () => ({ value: snap }))
    const clock = mock.clock(on)
    mock.env(on, { COCKPIT_DATA_DIR: '/data' })
    on('command.register', async () => ({ value: undefined }) as never)
    on('session.start', async (_, e) => ({ cwd: e.cwd }))
    on('ui.blit', async () => ({ value: {} }) as never)
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
    for (const cols of [60, 140]) {
      const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
      let t = 0
      for (const at of STAMPS) {
        if (at > t) await clock.advance(at - t)
        t = at
        const out: string[] = []
        const pairs = { total: new Set<string>(), per: [] as string[] }
        walk((await ui.drawn()) as unknown as N, 0, out, pairs)
        out.push(`## raster colour pairs (per raster): ${pairs.per.join(' ')}`)
        console.log(`CAP${cols}|=== ${name} @ ${cols} cols (mock t=${at}) ===`)
        for (const l of out) console.log(`CAP${cols}|${l}`)
      }
      await ui.unmount()
    }
  })
}
