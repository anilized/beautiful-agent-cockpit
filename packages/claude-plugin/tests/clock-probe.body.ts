import { expect, mock, test } from 'claude-code/testing'

declare const console: { log(...a: unknown[]): void }

test('clock.every minimum period, performance.now', async ($, on) => {
  const clock = mock.clock(on)
  const seen: string[] = []
  on('ui.status', async (_, e) => (seen.push(String((e as { text?: string }).text ?? JSON.stringify(e))), { value: undefined }) as never)
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)
  await clock.advance(200)
  for (const s of seen) console.log(`PROBE ${s}`)
  expect(seen.some(s => s.startsWith('every1='))).toBe(true)
})
