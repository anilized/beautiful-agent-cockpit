// Cell-grid painters for the terminal's Raster element. Each painter returns the
// base64 `cells` for a fixed columns×rows box and is pure in (size, frame, data),
// so the pane draws it once and the animation clock re-blits it every frame.

const DEFAULT = 0x01000000

export function hex(c: string): number {
  return parseInt(c.slice(1), 16)
}
function lerp(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t))
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}
function ramp(stops: number[], t: number): number {
  const x = (((t % 1) + 1) % 1) * (stops.length - 1)
  const i = Math.floor(x)
  return lerp(stops[i]!, stops[Math.min(i + 1, stops.length - 1)]!, x - i)
}
const scale = (c: number, k: number) => lerp(0, c, k)

class Cells {
  readonly words: Uint32Array
  constructor(readonly cols: number, readonly rows: number) {
    this.words = new Uint32Array(cols * rows * 3)
    for (let i = 0; i < cols * rows; i++) this.words.set([0x20, DEFAULT, DEFAULT], i * 3)
  }
  set(x: number, y: number, ch: string | number, fg: number, bg = DEFAULT) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.words.set([typeof ch === 'number' ? ch : ch.codePointAt(0)!, fg, bg], (y * this.cols + x) * 3)
  }
  text(x: number, y: number, s: string, fg: number, bg: (x: number) => number = () => DEFAULT) {
    ;[...s].forEach((ch, i) => this.set(x + i, y, ch, fg, bg(x + i)))
  }
  encode(): string {
    return (new Uint8Array(this.words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
  }
}

/** Two square-ish pixels per cell via the upper half block. */
class Pixels {
  readonly px: number[]
  constructor(readonly cols: number, readonly rows: number) {
    this.px = new Array(cols * rows * 2).fill(0)
  }
  get(x: number, y: number) {
    return this.px[y * this.cols + x] ?? 0
  }
  put(x: number, y: number, c: number) {
    if (x >= 0 && y >= 0 && x < this.cols && y < this.rows * 2) this.px[y * this.cols + x] = c
  }
  toCells(): Cells {
    const out = new Cells(this.cols, this.rows)
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++) out.set(x, y, '▀', this.get(x, y * 2), this.get(x, y * 2 + 1))
    return out
  }
}

// ── 3×5 pixel font ─────────────────────────────────────────────────────────────

const FONT: Record<string, string> = {
  A: '010101111101101', C: '111100100100111', E: '111100110100111', G: '111100101101111', I: '111010010010111',
  K: '101101110101101', N: '101111111111101', O: '111101101101111', P: '111101111100100', T: '111010010010010',
  ' ': '000000000000000',
}
function glyphPixels(word: string): [number, number][] {
  const out: [number, number][] = []
  ;[...word].forEach((ch, i) => {
    const bits = FONT[ch] ?? FONT[' ']!
    for (let k = 0; k < 15; k++) if (bits[k] === '1') out.push([i * 4 + (k % 3), Math.floor(k / 3)])
  })
  return out
}

// ── hero ───────────────────────────────────────────────────────────────────────

const AURORA = [0x07070d, 0x14112e, 0x241b52, 0x0c3a4a, 0x0a2230, 0x07070d].map(c => c)
const LETTERS = [0x22d3ee, 0xa78bfa, 0xf472b6, 0xff8a3d, 0xfbbf24, 0x22d3ee]

export type HeroInfo = { online: boolean; left: string; right: string; alert: boolean }

export function hero(cols: number, rows: number, f: number, info: HeroInfo): string {
  const p = new Pixels(cols, rows)
  const H = rows * 2
  for (let y = 0; y < H; y++)
    for (let x = 0; x < cols; x++) {
      const v =
        Math.sin(x * 0.07 + f * 0.045) + Math.sin(y * 0.55 - f * 0.06 + x * 0.025) + Math.sin((x - y * 3) * 0.04 + f * 0.03)
      const fade = 1 - Math.abs(y - H / 2) / H
      let c = ramp(AURORA, (v + 3) / 6)
      if (info.alert) c = lerp(c, 0x3a2208, 0.35 + 0.25 * Math.sin(f * 0.25))
      p.put(x, y, scale(c, 0.55 + 0.45 * fade))
    }
  const word = cols >= 64 ? 'AGENT COCKPIT' : 'COCKPIT'
  const ink = glyphPixels(word)
  const ox = 2
  const oy = Math.max(0, Math.floor((H - 2 - 5) / 2))
  const sweep = (f * 0.9) % (word.length * 4 + 30) - 10
  // soft glow behind the letters
  for (const [gx, gy] of ink)
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
      p.put(ox + gx + dx, oy + gy + dy, lerp(p.get(ox + gx + dx, oy + gy + dy), 0x3b2f7a, 0.5))
  for (const [gx, gy] of ink) {
    const base = ramp(LETTERS, gx / (word.length * 4) - f / 160)
    const shine = Math.max(0, 1 - Math.abs(gx - sweep) / 4)
    p.put(ox + gx, oy + gy, lerp(base, 0xffffff, shine * 0.75))
  }
  const cells = p.toCells()
  // status line on the last row, over the aurora
  const y = rows - 1
  const bgAt = (x: number) => lerp(p.get(x, y * 2), p.get(x, y * 2 + 1), 0.5)
  cells.text(2, y, info.left.slice(0, Math.max(0, cols - info.right.length - 6)), 0xc4b5fd, bgAt)
  const dot = info.online ? lerp(0x34d399, 0x065f46, (Math.sin(f * 0.2) + 1) / 2) : lerp(0xf87171, 0x4c1d1d, (Math.sin(f * 0.3) + 1) / 2)
  const rx = cols - info.right.length - 2
  cells.set(rx - 2, y, '●', dot, bgAt(rx - 2))
  cells.text(rx, y, info.right, 0xe5e7eb, bgAt)
  return cells.encode()
}

// ── pipeline ───────────────────────────────────────────────────────────────────

export type PipelineInfo = { steps: string[]; phase: number; failed: boolean; color: number }

export function pipeline(cols: number, f: number, info: PipelineInfo): string {
  const c = new Cells(cols, 2)
  const n = info.steps.length
  const pad = 3
  const at = (i: number) => Math.round(pad + (i * (cols - 1 - pad * 2)) / (n - 1))
  const GREEN = 0x34d399, FAINT = 0x3f3f46, WHITE = 0xffffff
  for (let i = 0; i < n - 1; i++) {
    const a = at(i), b = at(i + 1)
    for (let x = a + 1; x < b; x++) {
      let col = FAINT
      if (i < info.phase - 1 || (i === info.phase - 1 && info.phase > 0)) col = lerp(0x0f766e, GREEN, (x - a) / (b - a))
      if (i === info.phase && !info.failed) {
        // particles flowing toward the next step
        const span = b - a
        const head = (f * 0.5) % span
        const d = (head - (x - a) + span) % span
        col = d < 4 ? lerp(info.color, FAINT, d / 4) : FAINT
      }
      c.set(x, 0, '━', col)
    }
  }
  for (let i = 0; i < n; i++) {
    const x = at(i)
    const done = i < info.phase
    const now = i === info.phase
    const glyph = done ? '●' : now ? (info.failed ? '✗' : '◉') : '○'
    const col = done ? GREEN : now ? (info.failed ? 0xf87171 : lerp(info.color, WHITE, (Math.sin(f * 0.35) + 1) / 2 * 0.6)) : 0x52525b
    c.set(x, 0, glyph, col)
    const label = info.steps[i]!.slice(0, Math.max(3, Math.floor((cols - pad * 2) / n) - 1))
    const lx = Math.min(cols - label.length, Math.max(0, x - Math.floor(label.length / 2)))
    c.text(lx, 1, label, done ? 0x6ee7b7 : now ? (info.failed ? 0xf87171 : 0xffffff) : 0x71717a)
  }
  return c.encode()
}

// ── progress ───────────────────────────────────────────────────────────────────

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const BAR = [0x8b5cf6, 0x22d3ee, 0x34d399]

export function progress(cols: number, f: number, frac: number, live: boolean): string {
  const c = new Cells(cols, 1)
  const exact = Math.min(1, Math.max(0, frac)) * cols
  const full = Math.floor(exact)
  const part = Math.floor((exact - full) * 8)
  const shine = live ? (f * 0.7) % (cols + 16) - 8 : -99
  for (let x = 0; x < cols; x++) {
    const base = ramp(BAR, cols > 1 ? (x / (cols - 1)) * 0.999 : 0)
    const glow = Math.max(0, 1 - Math.abs(x - shine) / 5)
    const col = lerp(base, 0xffffff, glow * 0.6)
    if (x < full) c.set(x, 0, '█', col, 0x1f1f26)
    else if (x === full && part) c.set(x, 0, EIGHTHS[part]!, col, 0x1f1f26)
    else c.set(x, 0, ' ', DEFAULT, 0x1f1f26)
  }
  return c.encode()
}

// ── sparkline ──────────────────────────────────────────────────────────────────

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export function spark(cols: number, rows: number, f: number, values: number[], live: boolean): string {
  const c = new Cells(cols, rows)
  const max = Math.max(1, ...values)
  const steps = rows * 8
  for (let x = 0; x < cols; x++) {
    const v = values[Math.floor((x * values.length) / cols)] ?? 0
    const h = v > 0 ? Math.max(1, Math.round((v / max) * steps)) : 0
    const last = x === cols - 1
    const col = lerp(ramp([0x6366f1, 0x22d3ee, 0x34d399], h / steps), 0xffffff, last && live ? (Math.sin(f * 0.4) + 1) / 4 : 0)
    for (let r = 0; r < rows; r++) {
      const fill = h - (rows - 1 - r) * 8
      if (fill >= 8) c.set(x, r, '█', col)
      else if (fill > 0) c.set(x, r, LEVELS[fill - 1]!, col)
      else if (r === rows - 1) c.set(x, r, '▁', 0x27272a)
    }
  }
  return c.encode()
}

// ── orb (an agent's avatar) ────────────────────────────────────────────────────

export function orb(f: number, color: number, active: boolean, seed: number): string {
  const p = new Pixels(4, 2)
  const k = active ? 0.55 + 0.45 * Math.sin(f * 0.3 + seed) : 0.35
  const core = lerp(scale(color, 0.4), color, k)
  const rim = scale(color, active ? 0.35 + 0.2 * Math.sin(f * 0.3 + seed + 1) : 0.18)
  const shape = ['0110', '1221', '1221', '0110']
  shape.forEach((row, y) => [...row].forEach((v, x) => p.put(x, y, v === '2' ? core : v === '1' ? rim : 0)))
  if (active) p.put(1 + Math.floor((f / 3 + seed) % 2), 1, lerp(core, 0xffffff, 0.6))
  const cells = p.toCells()
  // corners stay transparent
  for (const [x, y] of [[0, 0], [3, 0], [0, 1], [3, 1]] as const) {
    const top = p.get(x, y * 2), bottom = p.get(x, y * 2 + 1)
    if (!top && !bottom) cells.set(x, y, ' ', DEFAULT, DEFAULT)
    else if (!top) cells.set(x, y, '▄', bottom, DEFAULT)
    else if (!bottom) cells.set(x, y, '▀', top, DEFAULT)
  }
  return cells.encode()
}
