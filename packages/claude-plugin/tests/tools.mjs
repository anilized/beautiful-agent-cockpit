// Plugin-local runner for typecheck / capture / probe. No dependencies; tsc and `claude` are looked up, never installed.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
if (cmd === 'typecheck') {
  const tsc = findTsc() ?? die('typescript not found (npm install at the repo root, or set TSC=/path/to/tsc)')
  ensureTypes()
  process.exit(run(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.json')]).status ?? 1)
} else if (cmd === 'palette') {
  // theme.ts is the only module with colour literals. Tests have no fs, so the grep runs here.
  // TASK-204 migrates register.tsx: set REGISTER_STRICT = true then and the warning becomes a failure.
  const REGISTER_STRICT = false
  const HEX = /#[0-9a-fA-F]{6}/
  const dir = join(pkg, 'hooks')
  const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f))
  let bad = 0
  for (const f of files) {
    const has = HEX.test(readFileSync(join(dir, f), 'utf8'))
    if (f === 'theme.ts') { if (!has) (console.error('FAIL theme.ts has no palette literals'), bad++) }
    else if (has && f === 'register.tsx' && !REGISTER_STRICT) console.warn("WARN 'register.tsx has no palette literals' pending TASK-204")
    else if (has) (console.error(`FAIL ${f} has palette literals`), bad++)
  }
  if (!files.includes('theme.ts')) (console.error('FAIL hooks/theme.ts missing'), bad++)
  if (!files.includes('raster.ts')) (console.error('FAIL hooks/raster.ts missing'), bad++)
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
