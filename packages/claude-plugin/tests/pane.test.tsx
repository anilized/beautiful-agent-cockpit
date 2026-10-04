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
          await ui.press({ key: 'new' })
          expect(await ui.find({ key: 'compose-0' })).toBeDefined()
          await ui.press({ key: 'cancel-run' })
          await ui.press({ key: 'tab-live' })
        }
        await ui.unmount()
      }
    }
  })
}

test('a refused launch shows a failure card with the fix', async ($, on) => {
  on('fs.read', async () => ({ value: LIVE }))
  on('fs.write', async () => ({ value: undefined }) as never)
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
  await ui.press({ key: 'brief-start' })
  expect(await ui.find({ key: 'init-commit' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /has no commits yet/ })).toBeDefined()
  await ui.press({ key: 'dismiss-failure' })
  expect(await ui.find({ key: 'init-commit' })).toBeUndefined()
  await ui.unmount()
})

test('the mission form takes a council and leads at their own efforts; a live run re-seats; the team waits for approval', async ($, on) => {
  const snap = JSON.parse(LIVE)
  snap.agents = [
    { id: 'opus', adapter: 'claude', model: 'opus', roles: ['supervisor', 'lead'], enabled: true, effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'codex', adapter: 'codex', model: null, roles: ['lead', 'supervisor'], enabled: true, effort: 'medium', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
    { id: 'sonnet', adapter: 'claude', model: 'sonnet', roles: ['worker', 'lead', 'supervisor'], enabled: true, effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', adapter: 'claude', model: 'haiku', roles: ['worker'], enabled: true, effort: null, efforts: ['low', 'medium', 'high'] },
  ]
  const r = snap.runs[0]
  r.roles = { supervisor: 'opus', lead: 'codex' }
  r.status = 'awaiting_human_decision'
  r.council = [{ id: 'sup-1', agent: 'opus', effort: 'high', area: null, state: 'idle' }, { id: 'sup-2', agent: 'codex', effort: 'low', area: null, state: 'idle' }]
  r.leads = [{ id: 'lead-1', agent: 'codex', effort: 'medium', area: 'backend', state: 'idle' }]
  r.team = [
    { id: 'backend-dev', title: 'Backend developer', specialty: 'backend', agent: 'sonnet', effort: 'high', tasks: ['TASK-102'], state: 'idle' },
    { id: 'tester', title: 'Test engineer', specialty: 'test', agent: 'haiku', effort: null, tasks: [], state: 'idle' },
  ]
  r.tasks[1].persona = 'backend-dev'
  snap.pendingApprovals = [{ id: 'apr_team', runId: r.id, kind: 'team', operation: null, summary: 'Team for round 1', text: 'Proposed team' }]
  // Codex from the daemon; Claude straight from this Claude Code session
  snap.limits = { codex: { windows: [{ name: '5h', usedPercent: 0, resetsAt: null }], at: 'now' } }
  const calls: string[][] = []
  const writes: [string, string][] = []
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  on('fs.write', async (_, e) => (writes.push([(e as unknown as { path: string }).path, (e as unknown as { text: string }).text]), { value: undefined }) as never)
  on('process.run', async (_, e) => {
    calls.push([...(e as unknown as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } } as never
  })
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('session.measure', async (_, e) => ({ changed: (e as { changed: string[] }).changed }) as never) // the engine's echo
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  const last = (cmd: string) => [...calls].reverse().find(c => c.includes(cmd))!

  // what is left of each subscription, the tightest window per provider in the header
  await ($ as any).session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 14 }, { kind: 'seven_day', percentUsed: 40 }], changed: ['rateLimits'] })
  await ui.advance(500)
  expect(await ui.find({ type: 'Text', text: /claude 7d.*60%/ })).toBeDefined()
  // the team card: personas by name, with their models and efforts, editable before approving
  expect(await ui.find({ key: 'approve-apr_team' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /backend-dev/ })).toBeDefined()
  await ui.press({ key: 'team-effort-tester' }) // default -> low
  let team = JSON.parse(last('team').at(-1)!)
  expect(team.map((p: { id: string; agent: string; effort: string | null }) => `${p.id}:${p.agent}:${p.effort}`)).toEqual(['backend-dev:sonnet:high', 'tester:haiku:low'])
  await ui.press({ key: 'team-clone-backend-dev' })
  team = JSON.parse(last('team').at(-1)!)
  expect(team.map((p: { id: string }) => p.id)).toEqual(['backend-dev', 'backend-dev-2', 'tester'])
  await ui.press({ key: 'approve-apr_team' })
  expect(calls.some(c => c.includes('approve') && c.includes('apr_team'))).toBe(true)

  // the live crew: the second council seat steps its effort; the run is re-seated with both
  await ui.press({ key: 'effort-council-1' }) // low -> medium
  const seats = last('seats')
  expect(seats.slice(seats.indexOf('--council'), seats.indexOf('--council') + 2)).toEqual(['--council', 'opus:high,codex:medium'])
  expect(seats.slice(seats.indexOf('--leads'), seats.indexOf('--leads') + 2)).toEqual(['--leads', 'codex:medium@backend'])

  // the next mission: two leads, each at its own level, one model in two seats
  await ui.press({ key: 'new' })
  await ui.press({ key: 'add-leads' }) // + opus
  await ui.press({ key: 'effort-leads-1' }) // default -> low
  await ui.press({ key: 'area-1' }) // any -> backend
  await ui.press({ key: 'area-1' }) // -> frontend
  await ui.press({ key: 'add-council' }) // + codex
  await ui.press({ key: 'effort-council-1' }) // default -> minimal
  // a long brief, line by line; it reaches the CLI as a file
  await ui.input({ key: 'compose-0', text: '# Readme' })
  await ui.input({ key: 'compose-1', text: '' })
  await ui.input({ key: 'compose-2', text: '- explain the cockpit' })
  expect(await ui.find({ type: 'Text', text: /README/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /• explain the cockpit/ })).toBeDefined()
  await ui.press({ key: 'brief-start' })
  expect(writes.at(-1)![0]).toMatch(/drafts[\\/]mission\.md$/)
  expect(writes.at(-1)![1]).toBe('# Readme\n\n- explain the cockpit\n')
  const run = last('run')
  expect(run.slice(run.indexOf('--file'), run.indexOf('--file') + 2)).toEqual(['--file', '/data/drafts/mission.md'])
  expect(run.slice(run.indexOf('--council'), run.indexOf('--council') + 2)).toEqual(['--council', 'opus,codex:minimal'])
  expect(run.slice(run.indexOf('--leads'), run.indexOf('--leads') + 2)).toEqual(['--leads', 'codex,opus:low@frontend'])
  expect(run.includes('--supervisor')).toBe(false)
  await ui.unmount()
})

test('the Minds tab follows each model and streams its reasoning, words and tools', async ($, on) => {
  const snap = JSON.parse(LIVE)
  snap.runs[0].minds = [
    {
      sessionId: 'ses_w', agentId: 'sonnet', role: 'worker', task: 'TASK-102', contract: 'WorkerResult', effort: 'medium', status: 'active',
      startedAt: '2026-10-03T13:23:33.674Z', endedAt: null,
      activity: [
        { ts: '2026-10-03T13:23:40.000Z', kind: 'thinking', text: 'slugify must collapse repeated dashes before trimming them' },
        { ts: '2026-10-03T13:23:41.000Z', kind: 'tool', text: 'Read: src/strings.js' },
        { ts: '2026-10-03T13:23:45.000Z', kind: 'text', text: 'Adding the slugify tests next.' },
      ],
    },
    { sessionId: 'ses_l', agentId: 'codex', role: 'lead', task: 'TASK-101', contract: 'LeadReview', effort: null, status: 'completed', startedAt: '2026-10-03T13:10:00.000Z', endedAt: '2026-10-03T13:11:00.000Z', activity: [] },
    { sessionId: 'ses_p', agentId: 'codex', role: 'lead', task: null, contract: 'LeadPlan', effort: null, status: 'completed', startedAt: '2026-10-03T13:01:00.000Z', endedAt: '2026-10-03T13:02:00.000Z',
      activity: [{ ts: '2026-10-03T13:02:00.000Z', kind: 'result', text: 'Planned 2 tasks: strings first\nTASK-101 strings → sonnet\nTASK-102 math (after TASK-101)' }] },
  ]
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  for (const cols of [60, 100, 140]) {
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
    await ui.press({ key: 'tab-live' })
    await ui.press({ key: 'agent-pick-w0' }) // the selection outlives a remount: start each width on the worker
    expect(['/implementing/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /implementing/ }))]).toEqual(['/implementing/'.toString(), cols, true])
    expect(['/collapse repeated dashes/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /collapse repeated dashes/ }))]).toEqual(['/collapse repeated dashes/'.toString(), cols, true])
    expect(await ui.find({ type: 'Text', text: /src\/strings\.js/ })).toBeDefined()
    // j/k on the agents panel walk the sessions that have a stream: the lead's review above the worker, the plan below.
    await ui.press({ key: 'nav-h' })
    await ui.press({ key: 'nav-k' })
    expect(['/reviewing the work/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /reviewing the work/ }))]).toEqual(['/reviewing the work/'.toString(), cols, true])
    expect(['/no visible output/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /no visible output/ }))]).toEqual(['/no visible output/'.toString(), cols, true])
    await ui.press({ key: 'agent-pick-w0' })
    expect(['/collapse repeated dashes/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /collapse repeated dashes/ }))]).toEqual(['/collapse repeated dashes/'.toString(), cols, true])
    // An earlier session reads back what it concluded, line by line.
    await ui.press({ key: 'nav-j' })
    expect(['/Planned 2 tasks/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /Planned 2 tasks/ }))]).toEqual(['/Planned 2 tasks/'.toString(), cols, true])
    expect(['/TASK-102 math/'.toString(), cols, !!(await ui.find({ type: 'Text', text: /TASK-102 math/ }))]).toEqual(['/TASK-102 math/'.toString(), cols, true])
    await ui.unmount()
  }
})

test('rows open to show the whole task, event or Minds entry', async ($, on) => {
  const snap = JSON.parse(LIVE)
  const run = snap.runs[0]
  run.tasks[1].detail = {
    description: 'Implement capitalize and slugify in src/strings.js with node:test coverage.', kind: 'implementation', risk: 'low', complexity: 'low',
    acceptanceCriteria: ['slugify collapses repeated dashes'], scope: { files: ['src/strings.js', 'test/strings.test.js'], modules: [], resources: [] },
    testsRequired: true, testCommand: 'node --test', summary: 'implemented strings',
    review: { iteration: 1, verdict: 'changes_requested', summary: 'missing edge cases', issues: [{ severity: 'major', file: 'src/strings.js', description: 'empty input throws' }] },
  }
  run.recentEvents[run.recentEvents.length - 1].detail = 'outcome: approved\nreason: every criterion met'
  run.minds = [{
    sessionId: 'ses_w', agentId: 'sonnet', role: 'worker', task: 'TASK-102', contract: 'WorkerResult', effort: null, status: 'active',
    startedAt: '2026-10-03T13:23:33.674Z', endedAt: null,
    activity: [{ ts: '2026-10-03T13:23:41.000Z', kind: 'tool', text: "Bash: cat > /tmp/a.py <<'EOF'\nprint('hidden second line')\nEOF" }],
  }]
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  expect(await ui.find({ type: 'Text', text: /collapses repeated dashes/ })).toBeUndefined()
  await ui.press({ key: 'task-pick-TASK-102' })
  await ui.press({ key: 'tab-task' })
  expect(await ui.find({ type: 'Text', text: /collapses repeated dashes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /empty input throws/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /test\/strings\.test\.js/ })).toBeDefined()
  await ui.press({ key: 'tab-live' })
  expect(await ui.find({ type: 'Text', text: /collapses repeated dashes/ })).toBeUndefined()

  await ui.press({ key: 'tab-events' })
  const last = run.recentEvents[run.recentEvents.length - 1]
  await ui.press({ key: `open-ev-${last.ts}-${last.type}` })
  expect(await ui.find({ type: 'Text', text: /every criterion met/ })).toBeDefined()

  await ui.press({ key: 'tab-live' })
  expect(await ui.find({ type: 'Text', text: /hidden second line/ })).toBeUndefined()
  const entry = run.minds[0].activity[0]
  await ui.press({ key: `open-mind-ses_w-${entry.ts}-tool-${entry.text.length}` })
  expect(await ui.find({ type: 'Text', text: /hidden second line/ })).toBeDefined()
  await ui.unmount()
})

test('a long approval shows its first lines and opens to the whole text', async ($, on) => {
  const snap = JSON.parse(LIVE)
  snap.pendingApprovals[0].text = `Final result: ${'every task is integrated and the suite passes. '.repeat(30)}TAIL-MARKER remaining risk: none.`
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  expect(await ui.find({ type: 'Text', text: /TAIL-MARKER/ })).toBeUndefined()
  expect(await ui.find({ key: 'approve-apr_1' })).toBeDefined()
  await ui.press({ key: 'open-apr-apr_1' })
  expect(await ui.find({ type: 'Text', text: /TAIL-MARKER/ })).toBeDefined()
  expect(await ui.find({ key: 'approve-apr_1' })).toBeDefined()
  await ui.unmount()
})

test('a long report scrolls inside the centre box instead of spilling over it', async ($, on) => {
  const report = `# Report\n\n${Array.from({ length: 400 }, (_, i) => `- finding ${i}: ${'detail '.repeat(8)}`).join('\n')}\n\nEND-OF-REPORT`
  on('fs.read', async () => ({ value: LIVE }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: report, stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  // narrow: no fixed boxes, the whole report is drawn and the pane scrolls
  let ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(100) })
  await ui.press({ key: 'tab-report' })
  await ui.advance(500)
  expect(report.length).toBeGreaterThan(20000)
  expect(await ui.find({ type: 'Text', text: /END-OF-REPORT/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
  await ui.unmount()
  // the grid: the box shows what fits, says how much is below, and j walks down to the end
  ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
  await ui.press({ key: 'tab-report' })
  await ui.advance(500)
  expect(await ui.find({ type: 'Text', text: /END-OF-REPORT/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↓ \d+ more/ })).toBeDefined()
  for (let i = 0; i < 300 && !(await ui.find({ type: 'Text', text: /END-OF-REPORT/ })); i++) await ui.press({ key: 'nav-j' })
  expect(await ui.find({ type: 'Text', text: /END-OF-REPORT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ more/ })).toBeDefined()
  expect(await ui.find({ key: 'tab-live' })).toBeDefined() // the box never pushes its own header away
  await ui.unmount()
})

test('every mission is listed and a press switches to it, at every width', async ($, on) => {
  on('fs.read', async () => ({ value: LIVE }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  for (const cols of [60, 100, 140]) {
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
    expect(await ui.find({ key: 'pick-run_41bbf3a0c6ee44bf' })).toBeDefined()
    expect(await ui.find({ key: 'pick-run_older0000000001' })).toBeDefined()
    await ui.press({ key: 'pick-run_older0000000001' })
    expect([cols, !!(await ui.find({ type: 'Text', text: /MISSIONS 2\/2/ }))]).toEqual([cols, true])
    await ui.press({ key: 'pick-run_41bbf3a0c6ee44bf' })
    expect([cols, !!(await ui.find({ type: 'Text', text: /MISSIONS 1\/2/ }))]).toEqual([cols, true])
    await ui.unmount()
  }
})

test('the grid shows the unified log, the agent focus files, a code preview and the team tree', async ($, on) => {
  const snap = JSON.parse(LIVE)
  const run = snap.runs[0]
  const t = run.tasks[1] // TASK-102, running
  t.specialty = 'backend'
  t.live = {
    files: [{ status: 'M', path: 'src/strings.js' }, { status: 'A', path: 'test/strings.test.js' }],
    preview: { file: 'src/strings.js', diff: '@@ -1,2 +1,3 @@\n export const a = 1\n-export const slug = s => s\n+export const slug = s => s.toLowerCase()\n+export const cap = s => s' },
  }
  t.detail = {
    description: 'strings', kind: 'implementation', risk: 'low', complexity: 'low', acceptanceCriteria: [], scope: { files: ['src/strings.js'], modules: [], resources: [] },
    testsRequired: true, testCommand: 'node --test', summary: null, review: null,
    validation: { command: 'node --test test/strings.test.js', passed: true, skipped: false, output: 'TAP version 13\nok 1 - slugify\n# pass 1' },
  }
  run.minds = [{
    sessionId: 'ses_w', agentId: 'sonnet', role: 'worker', task: 'TASK-102', contract: 'WorkerResult', effort: null, status: 'active',
    startedAt: '2026-10-03T13:23:33.674Z', endedAt: null,
    activity: [
      { ts: '2026-10-03T13:23:40.000Z', kind: 'text', text: 'Writing the slugify edge cases first.' },
      { ts: '2026-10-03T13:23:41.000Z', kind: 'tool', text: 'Edit: src/strings.js' },
    ],
  }]
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data', COCKPIT_THEME: 'neon', COCKPIT_BRAND: 'TESTCO' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  for (const cols of [60, 140]) {
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: cols === 60 ? 'desktop' : 'terminal', ...pane(cols) })
    const has = async (re: RegExp) => expect([String(re), cols, !!(await ui.find({ type: 'Text', text: re }))]).toEqual([String(re), cols, true])
    await has(/\[BACKEND +\]/) // the worker's tag comes from its task's specialty
    await has(/Writing the slugify edge cases/)
    await has(/\[ORCH +\]/) // orchestrator milestones join the log
    await has(/AGENT: BACKEND/)
    await has(/test\/strings\.test\.js/) // focus files
    await has(/toLowerCase/) // code preview
    await has(/◉ YOU/) // the team tiers took the terminal's place
    await has(/◆ COUNCIL/)
    await has(/◇ LEADS/)
    await has(/1 decision waiting/)
    expect([cols, !!(await ui.find({ type: 'Text', text: /object Object/ }))]).toEqual([cols, false])
    await has(/1 codex/)
    await ui.unmount()
  }
  // the brand and theme came from the environment
  const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'desktop', ...pane(140) })
  expect(await ui.find({ type: 'Text', text: /TESTCO/ })).toBeDefined()
  await ui.unmount()
})

test('home is an overview of every mission; a mission opens from it and 0 comes back', async ($, on) => {
  const snap = JSON.parse(LIVE)
  for (const r of snap.runs) r.status = 'completed'
  snap.pendingApprovals = []
  snap.runs[0].team = [{ id: 'backend-dev', title: 'Backend developer', specialty: 'backend', agent: 'sonnet', effort: 'high', tasks: ['TASK-102'], state: 'idle' }]
  snap.runs[0].tasks[1].persona = 'backend-dev'
  snap.limits = { codex: { windows: [{ name: '7d', usedPercent: 16, resetsAt: null }], at: 'now' } }
  on('fs.read', async () => ({ value: JSON.stringify(snap) }))
  mock.clock(on)
  mock.env(on, { COCKPIT_DATA_DIR: '/data' })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  for (const cols of [60, 140]) {
    const ui = await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(cols) })
    // nothing under way: the overview, not a mission form
    expect(await ui.find({ type: 'Text', text: /MISSIONS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 backend-dev/ })).toBeDefined() // the latest mission's team, under lead 1
    expect(await ui.find({ type: 'Text', text: /codex 7d/ })).toBeDefined()
    expect(await ui.find({ key: `home-open-${snap.runs[1].id}` })).toBeDefined()
    expect((await ui.find({ key: `home-open-${snap.runs[0].id}` }))?.props.hotkey).toBe('1')
    expect(await ui.find({ key: 'compose-0' })).toBeUndefined()
    await ui.press({ key: `home-open-${snap.runs[0].id}` })
    expect(await ui.find({ key: 'tab-live' })).toBeDefined()
    await ui.press({ key: 'home' })
    expect(await ui.find({ key: 'tab-live' })).toBeUndefined()
    expect(await ui.find({ key: `home-open-${snap.runs[0].id}` })).toBeDefined()
    await ui.unmount()
  }
})
