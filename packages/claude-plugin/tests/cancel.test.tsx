// Cancelling one mission: asked first, then `cockpit cancel <run>`; the orchestrator itself keeps running.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

async function boot($: any, on: any, stdout = 'mission cancelled') {
  const procs: string[][] = []
  mock.clock(on)
  on('fs.read', async () => ({ value: LIVE }))
  on('fs.write', async () => ({ value: undefined }) as never)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: undefined }) as never)
  on('process.run', async (_: unknown, e: { argv: string[] }) => (procs.push(e.argv), { value: { exitCode: 0, stdout, stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  return procs
}

const run = JSON.parse(LIVE).runs[0].id as string
const cli = (procs: string[][]) => procs.map(a => a.slice(2))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`cancel asks first, then ends only the mission (${surface})`, async ($, on) => {
    const procs = await boot($, on)
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface, ...pane(140) })
    // The terminal asks from its footer (q); the app from a button in the mission's header.
    const ask = surface === 'terminal' ? 'cancel-mission' : 'cancel-mission-head'
    if (surface === 'terminal') expect((await ui.find({ key: ask }))?.props.hotkey).toBe('q')
    expect(await ui.find({ key: ask })).toBeDefined()
    expect(await ui.find({ key: 'cancel-yes' })).toBeUndefined()

    // Asking runs nothing; keep it running closes the question.
    await ui.press({ key: ask })
    expect(cli(procs).filter(a => a[0] === 'cancel')).toEqual([])
    expect(await ui.find({ key: 'cancel-yes' })).toBeDefined()
    await ui.press({ key: 'cancel-keep' })
    expect(await ui.find({ key: 'cancel-yes' })).toBeUndefined()

    // Asked again: a second q (the terminal) or the card's button cancels.
    await ui.press({ key: ask })
    if (surface === 'terminal') expect((await ui.find({ key: 'cancel-mission' }))?.props.label).toBe('confirm cancel')
    await ui.press({ key: surface === 'terminal' ? 'cancel-mission' : 'cancel-yes' })
    expect(cli(procs).filter(a => a[0] === 'cancel')).toEqual([['cancel', run]])
    expect(cli(procs).some(a => a[0] === 'stop')).toBe(false) // the orchestrator is not stopped
    expect(await ui.find({ key: 'cancel-yes' })).toBeUndefined()
    await ui.unmount()
  })
}

test('/cockpit cancel ends the mission under way, or the one named, with a reason', async ($, on) => {
  const procs = await boot($, on)
  await $.command.run({ command: 'cockpit', args: 'cancel wrong idea' } as never)
  expect(cli(procs).at(-1)).toEqual(['cancel', run, 'wrong idea'])
  await $.command.run({ command: 'cockpit', args: 'cancel run_x' } as never)
  expect(cli(procs).at(-1)).toEqual(['cancel', 'run_x'])
})
