// Blit-rate measurement under the mock clock: LIVE fixture at 140 columns, total and per key, vs the 112 blits/s pre-change baseline (16/s x 7 keys).
// Run by `npm run blitrate`. Tests have no fs/process, so the measuring test is written to a scratch plugin copy, run by `claude plugin test`,
// and its BLIT| lines are kept in tests/evidence/blitrate.txt. Harness numbers only: the mock clock is not a live terminal.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SECONDS = 10

const body = `
import { mock, test } from 'claude-code/testing'
import { LIVE, OFFLINE } from './fixture'
declare const console: { log(...a: unknown[]): void }
const pane = (cols: number) => ({ component: 'Pane' as const, requestId: 'agent-cockpit', props: { title: '◆ Cockpit', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: { columns: cols, rows: 45 } })
const cases: [string, string, Record<string, string>][] = [
  ['live', LIVE, {}],
  ['offline', OFFLINE, {}],
  ['live', LIVE, { COCKPIT_REDUCED_MOTION: '1' }],
]
for (const [name, snap, env] of cases) {
  test(\`blitrate \${name} \${JSON.stringify(env)}\`, async ($, on) => {
    const clock = mock.clock(on)
    const by: Record<string, number> = {}
    let n = 0
    on('fs.read', async () => ({ value: snap }))
    mock.env(on, { COCKPIT_DATA_DIR: '/data', ...env })
    on('command.register', async () => ({ value: undefined }) as never)
    on('session.start', async (_, e) => ({ cwd: e.cwd }))
    on('ui.status', async () => ({ value: undefined }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    on('ui.blit', async (_, e: { key: string }) => { by[e.key] = (by[e.key] ?? 0) + 1; n++; return { value: {} } as never })
    await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
    await $.ui.mount({ plugin: 'agent-cockpit', surface: 'terminal', ...pane(140) })
    await clock.advance(1000)
    for (const k of Object.keys(by)) delete by[k]
    n = 0
    await clock.advance(${SECONDS} * 1000)
    const per = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / ${SECONDS}).toFixed(2)]))
    console.log('BLIT|' + JSON.stringify({ scenario: name, env, windowS: ${SECONDS}, totalPerSec: +(n / ${SECONDS}).toFixed(2), perKeyPerSec: per }))
  })
}
`

const tmp = mkdtempSync(join(tmpdir(), 'cockpit-blit-'))
try {
  for (const d of ['hooks', 'types', '.claude-plugin']) cpSync(join(pkg, d), join(tmp, d), { recursive: true })
  mkdirSync(join(tmp, 'tests'))
  cpSync(join(pkg, 'tests', 'fixture.ts'), join(tmp, 'tests', 'fixture.ts'))
  writeFileSync(join(tmp, 'tests', 'blitrate.test.tsx'), body)
  const r = spawnSync('claude', ['plugin', 'test', tmp], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`claude plugin test failed (exit ${r.status})\n${out}`)
  const rows = out.split(/\r?\n/).filter(l => l.startsWith('BLIT|')).map(l => JSON.parse(l.slice(5)))
  const lines = [
    `blit-rate: mock clock, ${SECONDS} s window after 1 s settle, 140 columns, baseline before this work = 112 blits/s (16/s x 7 keys)`,
    ...rows.map(x => `${x.scenario} ${JSON.stringify(x.env)}: total ${x.totalPerSec}/s (${(x.totalPerSec / 112 * 100).toFixed(0)}% of 112) per key ${JSON.stringify(x.perKeyPerSec)}`),
  ]
  writeFileSync(join(pkg, 'tests', 'evidence', 'blitrate.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
} finally { rmSync(tmp, { recursive: true, force: true }) }
