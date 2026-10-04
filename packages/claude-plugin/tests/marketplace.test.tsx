// A marketplace install: Claude Code copies only this plugin into its cache and keeps the whole
// repository as the marketplace's clone. The cockpit finds that clone, installs its dependencies
// once, and runs the orchestrator from there.
import { expect, mock, test } from 'claude-code/testing'

import { OFFLINE } from './fixture'

const pane = (cols: number) => ({
  component: 'Pane' as const,
  requestId: 'agent-cockpit',
  props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: cols, rows: 45 },
})

test('a marketplace install finds the repository in the marketplace clone and installs it once', async ($, on) => {
  const CLONE = '/cfg/plugins/marketplaces/beautiful-agent-cockpit'
  let installed = false
  const runs: string[] = []
  on('fs.read', async (_, e) => {
    const path = String((e as unknown as { path: string }).path).split(String.fromCharCode(92)).join('/')
    if (path.endsWith('/cfg/plugins/known_marketplaces.json')) return { value: JSON.stringify({ 'beautiful-agent-cockpit': { installLocation: CLONE } }) }
    if (path.endsWith(`${CLONE}/bin/cockpit.mjs`)) return { value: '// cli' }
    if (path.endsWith(`${CLONE}/node_modules/zod/package.json`) && installed) return { value: '{}' }
    if (path.endsWith('/data/snapshot.json')) return { value: OFFLINE }
    throw new Error(`ENOENT: ${path}`)
  })
  on('process.run', async (_, e) => {
    const call = JSON.stringify(e)
    runs.push(call)
    if (call.includes('"install"')) installed = true
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } } as never
  })
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data', CLAUDE_CONFIG_DIR: '/cfg' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  await ui.advance(200)

  // a fresh clone: the install comes first, in the clone
  expect((await ui.find({ key: 'install-deps' }))?.props.hotkey).toBe('i')
  expect(await ui.find({ key: '  s · Start orchestrator  ' })).toBeUndefined()
  await ui.press({ key: 'install-deps' })
  const install = runs.find(r => r.includes('"install"'))!
  expect(install).toContain('npm')
  expect(install).toContain(CLONE)

  // installed: starting runs the clone's CLI
  await ui.advance(200)
  expect(await ui.find({ key: 'install-deps' })).toBeUndefined()
  await ui.press({ key: '  s · Start orchestrator  ' })
  expect(runs.some(r => r.includes(`${CLONE}/bin/cockpit.mjs`) && r.includes('daemon'))).toBe(true)
  await ui.unmount()
})
