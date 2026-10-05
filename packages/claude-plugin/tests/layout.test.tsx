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

const rasterKeys = (n: string | Node): string[] => (typeof n === 'string' ? [] : [...(n.type === 'Raster' ? [String(n.props?.key)] : []), ...(n.children ?? []).flatMap(rasterKeys)])

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
      // A one-line row (truncating) must hold one line: a newline in it pushes every row below it down.
      if (wrap?.startsWith('truncate') && /\n/.test(textOf(n))) bad.push(`newline in a one-line row: ${textOf(n).slice(0, 60)}`)
      for (const line of textOf(n).split('\n')) {
        const fallback = /[▔▕]/.test(line) // underline and meter fallbacks are ours to fit, truncating or not
        const w = fallback ? width(line) : wrap === 'wrap' ? Math.max(0, ...line.split(/\s+/).map(width)) : wrap?.startsWith('truncate') ? 0 : width(line)
        if (w > cols) bad.push(`${w} > ${cols}: ${line.slice(0, 60)}`)
      }
      return
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return { bad, texts, keys: rasterKeys(root), text: textOf(root) }
}

test('width() counts wide characters as two cells', () => {
  expect(width('abc')).toBe(3)
  expect(width('世界')).toBe(4)
  expect(width('á')).toBe(1)
  expect(width('🚀')).toBe(2)
})

// home: nothing under way, so the overview draws
const HOME_SNAP = (() => {
  const h = JSON.parse(LIVE)
  for (const r of h.runs) r.status = 'completed'
  h.pendingApprovals = []
  h.limits = { claude: { windows: [{ name: '5h', usedPercent: 14, resetsAt: null }, { name: '7d', usedPercent: 40, resetsAt: null }], at: '' }, codex: { windows: [{ name: '7d', usedPercent: 16, resetsAt: null }], at: '' } }
  return JSON.stringify(h)
})()

// rich: what a real mission carries — multi-line task text, a crew, a team, limits, long agent output
const RICH_SNAP = (() => {
  const h = JSON.parse(LIVE)
  const r = h.runs[0]
  const t = r.tasks[1]
  t.specialty = 'backend'
  t.persona = 'backend-dev'
  t.detail = {
    description: 'Verification-only run.\nDo NOT edit any file.\n\nStage 2: `npm run typecheck` (root). Report\nexit code, duration, tsc errors as file:line.\n' + 'a long line that keeps going '.repeat(12),
    kind: 'implementation', risk: 'low', complexity: 'low', acceptanceCriteria: ['passes\nwith a second line'], scope: { files: ['src/strings.js'], modules: [], resources: [] },
    testsRequired: true, testCommand: 'node --test', summary: 'done\nand more', review: { iteration: 1, verdict: 'approve', summary: 'clean\nreally', issues: [] },
    validation: { command: 'node --test', passed: true, skipped: false, output: 'TAP version 13\nok 1 - slugify\n# pass 1' },
  }
  r.council = [{ id: 'sup-1', agent: 'opus', effort: 'high', area: null, state: 'idle' }, { id: 'sup-2', agent: 'codex', effort: 'low', area: null, state: 'working' }]
  r.leads = [{ id: 'lead-1', agent: 'codex', effort: 'xhigh', area: 'tests', state: 'working on TASK-102' }, { id: 'lead-2', agent: 'sonnet', effort: 'medium', area: 'frontend', state: 'idle' }]
  r.team = [{ id: 'backend-dev', title: 'Backend developer', specialty: 'backend', agent: 'sonnet', effort: 'high', tasks: ['TASK-102'], state: 'working on TASK-102' }]
  r.minds = [{
    sessionId: 'ses_s', agentId: 'opus', role: 'supervisor', seat: 'sup-1', task: null, contract: 'SupervisorValidation', effort: 'high', status: 'completed',
    startedAt: '2026-10-03T13:23:00.000Z', endedAt: '2026-10-03T13:23:39.000Z',
    activity: [{ ts: '2026-10-03T13:23:31.000Z', kind: 'text', text: "I'll check whether any plugin test\nreads the pane baseline file." }, { ts: '2026-10-03T13:23:32.000Z', kind: 'tool', text: 'Grep: packages\\claude-plugin' }],
  }]
  h.limits = { claude: { windows: [{ name: '5h', usedPercent: 21, resetsAt: '2026-10-04T03:00:00.000Z' }, { name: '7d', usedPercent: 16, resetsAt: '2026-10-10T12:00:00.000Z' }], at: '' }, codex: { windows: [{ name: '5h', usedPercent: 0, resetsAt: null }], at: '' } }
  return JSON.stringify(h)
})()

for (const [name, snap] of [['live', LIVE], ['offline', OFFLINE], ['home', HOME_SNAP], ['rich', RICH_SNAP]] as const) {
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
        const tabs = name === 'live' || name === 'rich' ? (surface === 'terminal' ? ['tab-live', 'tab-task', 'tab-events', 'tab-report'] : ['tab-activity', 'tab-tasks', 'tab-changes', 'tab-events', 'tab-report']) : ['']
        for (const tab of tabs) {
          if (tab) await ui.press({ key: tab })
          const { bad, texts, keys, text } = audit((await ui.drawn()) as Node, cols)
          seen += texts
          if (surface === 'terminal') expect(keys).toEqual(expect.arrayContaining(name === 'live' || name === 'rich' ? ['hero', 'pipeline', 'divider', 'progress', 'tab-underline'] : ['hero']))
          else {
            expect(keys).toEqual([])
            // The app draws its meters as boxes and marks the tab by its fill: no cell-art underline or bar glyphs.
            expect([/▔/.test(text), /▕/.test(text)]).toEqual([false, false])
          }
          expect([surface, cols, tab, bad]).toEqual([surface, cols, tab, []])
        }
        await ui.unmount()
      }
    expect(seen).toBeGreaterThan(name === 'live' || name === 'rich' ? 100 : 30)
  })
}
