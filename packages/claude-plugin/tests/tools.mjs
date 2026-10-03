// Plugin-local runner for typecheck / capture / probe. No dependencies; tsc and `claude` are looked up, never installed.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const die = msg => (console.error(`BLOCKED: ${msg}`), process.exit(2))
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'claude', ...opts })

function findTsc() {
  if (process.env.TSC) return process.env.TSC
  const roots = [pkg]
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: pkg, encoding: 'utf8' }).stdout?.trim()
  if (common) roots.push(resolve(pkg, common, '..'))
  for (let r of roots) for (; ; r = dirname(r)) {
    const p = join(r, 'node_modules', 'typescript', 'bin', 'tsc')
    if (existsSync(p)) return p
    if (dirname(r) === r) break
  }
}

// The engine's declarations are written per session by the plugin-authoring skill or /plugin-types.
function ensureTypes() {
  const dest = join(pkg, '.claude', 'types', 'claude-code.d.ts')
  if (existsSync(dest)) return
  const src = process.env.CLAUDE_CODE_DTS
  if (!src || !existsSync(src)) die(`${dest} missing: run /plugin-types in Claude Code, or set CLAUDE_CODE_DTS to the skill's types/claude-code.d.ts`)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest)
}

const cmd = process.argv[2]
if (cmd === 'sha') {
  const f = process.argv[3] ?? die('usage: tools.mjs sha <file>')
  console.log(createHash('sha256').update(readFileSync(resolve(f))).digest('hex'))
} else if (cmd === 'typecheck') {
  const tsc = findTsc() ?? die('typescript not found (npm install at the repo root, or set TSC=/path/to/tsc)')
  ensureTypes()
  process.exit(run(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.json')]).status ?? 1)
} else if (cmd === 'palette') {
  // theme.ts is the only module with colour literals. Tests have no fs, so the grep runs here.
  const HEX = /#[0-9a-fA-F]{6}\b/
  const dir = join(pkg, 'hooks')
  const args = process.argv.slice(3)
  let bad = 0
  const fail = m => (console.error(`FAIL ${m}`), bad++)
  if (args.length) {
    for (const f of args) if (basename(f) !== 'theme.ts' && HEX.test(readFileSync(resolve(f), 'utf8'))) fail(`${f} has palette literals (theme.ts only)`)
  } else {
    const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f))
    for (const f of files) {
      const has = HEX.test(readFileSync(join(dir, f), 'utf8'))
      if (f === 'theme.ts') { if (!has) fail('theme.ts has no palette literals') }
      else if (has) fail(`${f} has palette literals (theme.ts only)`)
    }
    for (const f of ['theme.ts', 'raster.ts', 'register.tsx']) if (!files.includes(f)) fail(`hooks/${f} missing`)
  }
  process.exit(bad ? 1 : 0)
} else if (cmd === 'capture' || cmd === 'probe') {
  // Tests have no fs: run generated tests in scratch copies and keep what they print in tests/evidence.
  const label = process.argv[3] ?? 'before'
  const scratch = (files, plugin) => {
    const tmp = mkdtempSync(join(tmpdir(), 'cockpit-plugin-'))
    for (const d of ['hooks', 'types', '.claude-plugin']) cpSync(join(pkg, d), join(tmp, d), { recursive: true })
    if (plugin) writeFileSync(join(tmp, 'hooks', 'register.tsx'), readFileSync(join(pkg, 'tests', plugin), 'utf8'))
    mkdirSync(join(tmp, 'tests'))
    cpSync(join(pkg, 'tests', 'fixture.ts'), join(tmp, 'tests', 'fixture.ts'))
    for (const [src, dst] of files) writeFileSync(join(tmp, 'tests', dst), readFileSync(join(pkg, 'tests', src), 'utf8'))
    const r = spawnSync('claude', ['plugin', 'test', tmp], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28 })
    rmSync(tmp, { recursive: true, force: true })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    if (r.status !== 0) { console.error(out); die(`claude plugin test failed (exit ${r.status})`) }
    return out.split(/\r?\n/)
  }
  const ev = join(pkg, 'tests', 'evidence')
  mkdirSync(ev, { recursive: true })
  if (cmd === 'capture') {
    const out = scratch([['capture.ts', 'capture.test.tsx']])
    for (const cols of [60, 140]) {
      const lines = out.filter(l => l.startsWith(`CAP${cols}|`)).map(l => l.slice(l.indexOf('|') + 1))
      if (!lines.length) die(`no capture output for ${cols} columns`)
      writeFileSync(join(ev, `${label}-${cols}.txt`), lines.join('\n') + '\n')
      console.log(`wrote tests/evidence/${label}-${cols}.txt (${lines.length} lines)`)
    }
  } else {
    const keep = l => /^(PROBE|\(pass\)|\(fail\))/.test(l)
    const lines = [
      ...scratch([['host-probe.test.tsx', 'host-probe.test.tsx']]).filter(keep),
      ...scratch([['clock-probe.body.ts', 'clock-probe.test.ts']], 'clock-probe.ts').filter(keep),
    ]
    writeFileSync(join(ev, 'host-probe.txt'), lines.join('\n') + '\n')
    console.log(lines.join('\n'))
  }
} else die(`unknown command ${cmd}`)
