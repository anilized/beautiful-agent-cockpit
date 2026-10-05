// The app's own design (hooks/desk.tsx): overview, a mission's views, decisions and the new-mission form, all by click.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: false, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})
type Node = { type: string; props?: Record<string, unknown>; children?: (string | Node)[] }
const AGENTS = [
  { id: 'opus', adapter: 'claude', model: 'opus', roles: ['supervisor', 'lead'], enabled: true, effort: null, efforts: ['low', 'medium', 'high'] },
  { id: 'codex', adapter: 'codex', model: null, roles: ['lead', 'supervisor'], enabled: true, effort: 'medium', efforts: ['low', 'medium', 'high'] },
  { id: 'sonnet', adapter: 'claude', model: 'sonnet', roles: ['worker', 'lead'], enabled: true, effort: null, efforts: ['low', 'medium', 'high'] },
]

async function boot($: any, on: any, edit: (snap: any) => void = () => {}) {
  const snap = JSON.parse(LIVE)
  snap.agents = AGENTS
  edit(snap)
  const procs: string[][] = []
  const files: Record<string, string> = {}
  mock.clock(on)
  on('fs.read', async (_: unknown, e: { path: string }) => ({ value: files[e.path] ?? JSON.stringify(snap) }))
  on('fs.write', async (_: unknown, e: { path: string; content: string }) => ((files[e.path] = e.content), { value: undefined }) as never)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: undefined }) as never)
  on('process.run', async (_: unknown, e: { argv: string[] }) => (procs.push(e.argv), { value: { exitCode: 0, stdout: e.argv.includes('report') ? '# Mission report\n\nAll good.' : 'ok', stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'desktop' } as never)
  return { procs, cli: () => procs.map(a => a.slice(2)) }
}
const textOf = (n: string | Node): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))
const all = (n: string | Node, type: string, out: Node[] = []): Node[] => (typeof n !== 'string' && (n.type === type && out.push(n), n.children?.forEach(c => all(c, type, out))), out)

test('a mission in the app: header, tabs, a task, the report, a decision; never a cell-art glyph', async ($, on) => {
  const { cli } = await boot($, on)
  for (const cols of [80, 130, 200]) {
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(cols) })
    const drawn = (await ui.drawn()) as Node
    expect([cols, /Add two independent utility modules/.test(textOf(drawn))]).toEqual([cols, true]) // the mission's title
    expect(all(drawn, 'Svg').length).toBeGreaterThan(0) // its progress ring
    expect(await ui.find({ type: 'Text', text: /[▕▔]/ })).toBeUndefined()

    // tabs: the task list, a task in the inspector, the worktree view, the events, the report
    await ui.press({ key: 'tab-tasks' })
    await ui.press({ key: 'task-pick-TASK-102' })
    expect(await ui.find({ type: 'Text', text: /^Implement and test string utilities$/ })).toBeDefined()
    await ui.press({ key: 'tab-changes' })
    await ui.press({ key: 'tab-events' })
    expect(await ui.find({ type: 'Text', text: /merge\.completed/ })).toBeDefined()
    await ui.press({ key: 'tab-report' })
    if (await ui.find({ key: 'd-load-report' })) await ui.press({ key: 'd-load-report' }) // loaded once, kept for the mission
    expect(all((await ui.drawn()) as Node, 'Markdown').some(m => /Mission report/.test(String(m.props?.text)))).toBe(true)
    await ui.press({ key: 'tab-activity' })
    await ui.unmount()
  }

  // the final approval is a card with real buttons
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(200) })
  await ui.press({ key: 'approve-apr_1' })
  expect(cli().filter(a => a[0] === 'approve')).toEqual([['approve', 'apr_1']])
  await ui.unmount()
})

test('a new mission in the app: the brief previews as Markdown, the crew picks from dropdowns, Start launches it', async ($, on) => {
  const { cli } = await boot($, on, s => (s.runs = s.runs.map((r: any) => ({ ...r, status: 'completed' })), (s.pendingApprovals = [])))
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(200) })
  // nothing under way: the overview, with every mission and a way in
  expect(await ui.find({ key: 'home-open-run_41bbf3a0c6ee44bf' })).toBeDefined()
  await ui.press({ key: 'new' })
  await ui.input({ key: 'compose-0', text: '# Add a readme' })
  await ui.input({ key: 'compose-1', text: 'Explain how to run the tests.' })
  expect(all((await ui.drawn()) as Node, 'Markdown').some(m => String(m.props?.text) === '# Add a readme\nExplain how to run the tests.')).toBe(true)
  // the council's chair is a dropdown of the agents that may chair; effort another
  const chair = await ui.find({ key: 'next-council-agent-0' })
  expect(chair?.type).toBe('Select')
  await ui.select({ key: 'next-council-agent-0', value: 'codex' })
  await ui.select({ key: 'next-council-effort-0', value: 'high' })
  await ui.press({ key: 'brief-start' })
  const run = cli().find(a => a[0] === 'run')!
  expect(run).toEqual(expect.arrayContaining(['--council', 'codex:high', '--leads', 'codex']))
  await ui.unmount()
})

test('the app offline: one card, one button to start the orchestrator', async ($, on) => {
  const { cli } = await boot($, on, s => (s.daemon.port = null))
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(120) })
  expect(await ui.find({ type: 'Text', text: /The orchestrator is asleep/ })).toBeDefined()
  await ui.press({ key: 'd-start' })
  expect(cli().some(a => a[0] === 'daemon')).toBe(true)
  await ui.unmount()
})
