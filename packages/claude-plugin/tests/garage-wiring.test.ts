// /cockpit garage and the footer's y both run `cockpit garage <run>`, the same way the dashboard does.
import { expect, mock, test } from 'claude-code/testing'

import { LIVE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

async function boot($: any, on: any) {
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
  on('process.run', async (_: unknown, e: { argv: string[] }) => (procs.push(e.argv), { value: { exitCode: 0, stdout: 'http://127.0.0.1:1/garage', stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  return procs
}

const run = JSON.parse(LIVE).runs[0].id as string
const garageArgs = (procs: string[][]) => procs.map(a => a.slice(2)).filter(a => a[0] === 'garage')

test('footer key y is bound to the garage and runs `cockpit garage <run>`', async ($, on) => {
  const procs = await boot($, on)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await ui.advance(1100)
  expect((await ui.find({ key: 'garage' }))?.props.hotkey).toBe('y')
  expect((await ui.find({ key: 'dashboard' }))?.props.hotkey).toBe('d') // neighbours unchanged
  await ui.press({ key: 'garage' })
  expect(garageArgs(procs)).toEqual([['garage', run]])
  await ui.unmount()
})

test('/cockpit garage opens the garage for the given or the active run', async ($, on) => {
  const procs = await boot($, on)
  await $.command.run({ command: 'cockpit', args: 'garage run_x' } as never)
  expect(garageArgs(procs).at(-1)).toEqual(['garage', 'run_x'])
  await $.command.run({ command: 'cockpit', args: 'garage' } as never)
  expect(garageArgs(procs).at(-1)?.[0]).toBe('garage')
})
