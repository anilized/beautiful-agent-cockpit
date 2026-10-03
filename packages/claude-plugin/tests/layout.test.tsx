// No Text line may be wider than the pane body, on either surface, in either state, at the three widths the layout is tuned for.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE, OFFLINE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

type Node = { type: string; props?: Record<string, unknown>; children?: (string | Node)[] }

// Terminal cell width: wide (CJK, emoji) = 2, combining and zero-width = 0, the rest 1.
export function width(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) continue
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1
  }
  return w
}
const textOf = (n: string | Node): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

// Outermost Text elements: a Text that wraps or truncates is the host's to fit, so its longest word is what must fit; the rest must fit whole.
function audit(root: Node, cols: number) {
  const bad: string[] = []
  let texts = 0
  const walk = (n: string | Node) => {
    if (typeof n === 'string') return
    const p = n.props ?? {}
    if (n.type === 'Box' && typeof p.width === 'number' && p.width > cols) bad.push(`Box width ${p.width}`)
    if (n.type === 'Raster' && (p.columns as number) > cols) bad.push(`Raster ${p.key} ${p.columns} cols`)
    if (n.type === 'Text') {
      texts++
      const wrap = p.wrap as string | undefined
      for (const line of textOf(n).split('\n')) {
        const w = wrap === 'wrap' ? Math.max(0, ...line.split(/\s+/).map(width)) : wrap?.startsWith('truncate') ? 0 : width(line)
        if (w > cols) bad.push(`${w} > ${cols}: ${line.slice(0, 60)}`)
      }
      return
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return { bad, texts }
}

test('width() counts wide characters as two cells', () => {
  expect(width('abc')).toBe(3)
  expect(width('世界')).toBe(4)
  expect(width('á')).toBe(1)
  expect(width('🚀')).toBe(2)
})

for (const [name, snap] of [['live', LIVE], ['offline', OFFLINE]] as const) {
  test(`no Text line exceeds bodyColumns: ${name}, terminal and desktop, 60/100/140`, async ($, on) => {
    on('fs.read', async () => ({ value: snap }))
    mock.clock(on)
    mock.env(on, { COCKPIT_DATA_DIR: '/data' })
    on('command.register', async () => ({ value: undefined }) as never)
    on('session.start', async (_, e) => ({ cwd: e.cwd }))
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
    on('ui.blit', async () => ({ value: {} }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
    let seen = 0
    for (const surface of ['terminal', 'desktop'] as const)
      for (const cols of [60, 100, 140]) {
        const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface, ...pane(cols) })
        const tabs = name === 'live' ? ['tab-tasks', 'tab-events'] : ['']
        for (const tab of tabs) {
          if (tab) await ui.press({ key: tab })
          const { bad, texts } = audit((await ui.drawn()) as Node, cols)
          seen += texts
          expect([surface, cols, tab, bad]).toEqual([surface, cols, tab, []])
        }
        await ui.unmount()
      }
    expect(seen).toBeGreaterThan(name === 'live' ? 100 : 30)
  })
}
