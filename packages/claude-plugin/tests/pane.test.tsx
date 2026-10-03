import { expect, mock, test } from 'claude-code/testing'

import { LIVE, OFFLINE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

for (const [name, snap] of [['offline', OFFLINE], ['live', LIVE]] as const) {
  test(`pane draws ${name} at every width`, async ($, on) => {
    on('fs.read', async () => ({ value: snap }))
    mock.clock(on)
    mock.env(on, { COCKPIT_DATA_DIR: '/data' })
    on('command.register', async () => ({ value: undefined }) as never)
    on('session.start', async (_, e) => ({ cwd: e.cwd }))
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
    on('process.run', async () => ({ exitCode: 0, stdout: '# Report\n\nok', stderr: '' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const cols of [60, 100, 140]) {
        const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface, ...pane(cols) })
        if (surface === 'terminal') expect(await ui.find({ key: 'hero' })).toBeDefined()
        if (name === 'live') {
          expect(await ui.find({ key: 'approve-apr_1' })).toBeDefined()
          await ui.press({ key: 'tab-events' })
          await ui.press({ key: 'changes-apr_1' })
          expect(await ui.find({ key: 'changes-apr_1-0' })).toBeDefined()
          await ui.advance(500)
          await ui.press({ key: 'cancel-changes' })
          await ui.press({ key: cols >= 120 ? 'n · New mission' : 'new' })
          expect(await ui.find({ key: 'compose-0' })).toBeDefined()
          await ui.press({ key: 'cancel-run' })
          await ui.press({ key: 'tab-tasks' })
        }
        await ui.unmount()
      }
    }
  })
}

test('a refused launch shows a failure card with the fix', async ($, on) => {
  on('fs.read', async () => ({ value: LIVE }))
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'error: /repo has no commits yet; commit something first' } }) as never)
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  await ui.press({ key: 'new' })
  await ui.input({ key: 'compose-0', text: 'add a readme' })
  expect(await ui.find({ key: 'init-commit' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /has no commits yet/ })).toBeDefined()
  await ui.press({ key: 'dismiss-failure' })
  expect(await ui.find({ key: 'init-commit' })).toBeUndefined()
  await ui.unmount()
})
