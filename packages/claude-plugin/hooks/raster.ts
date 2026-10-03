// Cell-grid painters for the terminal's Raster element. Each painter is a pure function of
// (cols, rows, timeMs, data) → base64 `cells` (exactly cols*rows*3 uint32 words); every speed is per second,
// so output depends only on the clock value, never on how often it is sampled. Colours come from
// theme.ts and are quantized to a few levels so a frame holds ≤512 distinct fg/bg pairs (the host paints 1024).
//
// Signatures (t = elapsed ms; data in braces):
//   hero(cols, rows, t, {online, left, right, alert})                rows ≥ 2 (4 live)
//   pipeline(cols, rows, t, {steps, phase, fill, failed, color})     rows 2; phase = discrete step, fill 0..1 = tweened connector
//   progress(cols, rows, t, {frac, live})                            rows 1; frac 0..1 tweened
//   spark(cols, rows, t, {values, live})                             rows ≥ 1
//   orb(cols, rows, t, {color, active, seed})                        any size (4x2 live)
//   divider(cols, rows, t, {color, active})                          rows ≥ 1, line on the middle row
//   underline(cols, rows, t, {tabs, active, color})                  tabs = cell widths, active may be fractional; line on last row
//   meters(cols, rows, t, {values, colors, labels})                  one bar per row; values 0..1 tweened
//   hex(css) → 0xRRGGBB; pairCount(cells) → distinct fg/bg pairs in a frame

import { AURORA, BAR, K, LETTERS, SPARK, cycle, hex, lerpRgb, quant, ramp, scale } from './theme'

export { hex }

/** Distinct (fg, bg) pairs in a base64 cells string. */
export function pairCount(cells: string): number {
  const bin = atob(cells), seen = new Set<string>()
  const word = (i: number) => (bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24)) >>> 0
  for (let i = 0; i < bin.length; i += 12) seen.add(word(i + 4) + '/' + word(i + 8))
  return seen.size
}

export type Size = { cols: number; rows: number }

const DEFAULT = 0x01000000
const WHITE = 0xffffff
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)
const wave = (rate: number, s: number, phase = 0) => (Math.sin(s * rate + phase) + 1) / 2

class Cells {
  readonly words: Uint32Array
  constructor(readonly cols: number, readonly rows: number) {
    const w = (this.words = new Uint32Array(Math.max(0, cols * rows) * 3))
    for (let i = 0; i < w.length; i += 3) {
      w[i] = 0x20
      w[i + 1] = DEFAULT
      w[i + 2] = DEFAULT
    }
  }
  set(x: number, y: number, ch: string | number, fg: number, bg = DEFAULT) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = (y * this.cols + x) * 3
    this.words[i] = typeof ch === 'number' ? ch : ch.codePointAt(0)!
    this.words[i + 1] = fg
    this.words[i + 2] = bg
  }
  text(x: number, y: number, s: string, fg: number, bg: (x: number) => number = () => DEFAULT) {
    let i = 0
    for (const ch of s) {
      this.set(x + i, y, ch, fg, bg(x + i))
      i++
    }
  }
  encode(): string {
    return (new Uint8Array(this.words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
  }
}

/** Two square-ish pixels per cell via the upper half block; colour 0 means transparent. */
class Pixels {
  readonly px: Uint32Array
  constructor(readonly cols: number, readonly rows: number) {
    this.px = new Uint32Array(Math.max(0, cols * rows) * 2)
  }
  get(x: number, y: number) {
    return this.px[y * this.cols + x] ?? 0
  }
  put(x: number, y: number, c: number) {
    if (x >= 0 && y >= 0 && x < this.cols && y < this.rows * 2) this.px[y * this.cols + x] = c
  }
  toCells(transparent = false): Cells {
    const out = new Cells(this.cols, this.rows), { cols, px } = this
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < cols; x++) {
        const top = px[y * 2 * cols + x]!, bottom = px[(y * 2 + 1) * cols + x]!
        if (!transparent || (top && bottom)) out.set(x, y, 0x2580, top, bottom)
        else if (bottom) out.set(x, y, 0x2584, bottom)
        else if (top) out.set(x, y, 0x2580, top)
      }
    return out
  }
}

// ── 3×5 pixel font ─────────────────────────────────────────────────────────────

const FONT: Record<string, string> = {
  A: '010101111101101', C: '111100100100111', E: '111100110100111', G: '111100101101111', I: '111010010010111',
  K: '101101110101101', N: '101111111111101', O: '111101101101111', P: '111101111100100', T: '111010010010010',
  ' ': '000000000000000',
}
/** Ink mask of a word, `word.length*4` wide and 5 high. */
function inkMask(word: string): Uint8Array {
  const w = word.length * 4
  const m = new Uint8Array(w * 5)
  for (let i = 0; i < word.length; i++) {
    const bits = FONT[word[i]!] ?? FONT[' ']!
    for (let k = 0; k < 15; k++) if (bits.charCodeAt(k) === 49) m[((k / 3) | 0) * w + i * 4 + (k % 3)] = 1
  }
  return m
}

// ── hero ───────────────────────────────────────────────────────────────────────

// Per-second rates (old per-frame values × ~16.7 fps).
const AURORA_RATE = [0.75, 1, 0.5] // rad/s
const ALERT_RATE = 4.17 // rad/s
const LETTER_DRIFT = 0.104 // gradient cycles/s
const SWEEP_SPEED = 15 // pixels/s
const DOT_RATE = { online: 3.33, offline: 5 } // rad/s
const STAR_RATE = 1.3 // rad/s, ambient twinkle
const AURORA_LEVELS = 12
/** Integer hash of a pixel: fixed star positions without module state. */
const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}
const FADE_LEVELS = 4

/** `brand`, when set, is drawn in the letter gradient before `left` (the one-row header has no room for the pixel word). */
export type HeroData = { online: boolean; left: string; right: string; alert: boolean; brand?: string }

function paintHero(cols: number, rows: number, t: number, d: HeroData): string {
  const s = t / 1000
  const p = new Pixels(cols, rows)
  const H = rows * 2
  const word = cols >= 64 ? 'AGENT COCKPIT' : 'COCKPIT'
  const ww = word.length * 4
  const ink = inkMask(word)
  const ox = 2
  const oy = Math.max(0, Math.floor((H - 2 - 5) / 2))
  // soft glow around the letters: 2 = adjacent, 1 = one pixel further
  const glow = new Uint8Array(cols * H)
  for (let gy = 0; gy < 5; gy++)
    for (let gx = 0; gx < ww; gx++) {
      if (!ink[gy * ww + gx]) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const m = Math.abs(dx) + Math.abs(dy), x = ox + gx + dx, y = oy + gy + dy
          if (m > 2 || x < 0 || y < 0 || x >= cols || y >= H) continue
          const i = y * cols + x
          if (3 - m > glow[i]!) glow[i] = 3 - m
        }
    }
  const a = s * AURORA_RATE[0]!, b = s * AURORA_RATE[1]!, c = s * AURORA_RATE[2]!
  const tint = d.alert ? quant(0.35 + 0.25 * Math.sin(s * ALERT_RATE), 8) : 0
  for (let y = 0; y < H; y++) {
    const bright = 0.55 + 0.45 * quant(1 - Math.abs(y - H / 2) / H, FADE_LEVELS)
    for (let x = 0; x < cols; x++) {
      const v = Math.sin(x * 0.07 + a) + Math.sin(y * 0.55 - b + x * 0.025) + Math.sin((x - y * 3) * 0.04 + c)
      let col = ramp(AURORA, quant((v + 3) / 6, AURORA_LEVELS))
      if (tint) col = lerpRgb(col, K.alertTint, tint)
      col = scale(col, bright)
      const g = glow[y * cols + x]!
      if (g) col = lerpRgb(col, K.glow, g === 2 ? 0.5 : 0.22)
      else {
        const h = hash(x, y)
        if ((h & 63) === 0) col = lerpRgb(col, K.lavender, quant(wave(STAR_RATE, s, (h >>> 6 & 255) * 0.0246) * 0.45, 3))
      }
      p.put(x, y, col)
    }
  }
  const sweep = ((s * SWEEP_SPEED) % (ww + 30)) - 10
  if (rows < 3) return heroStrip(p, cols, rows, s, sweep, d)
  for (let gy = 0; gy < 5; gy++)
    for (let gx = 0; gx < ww; gx++) {
      if (!ink[gy * ww + gx]) continue
      const f = (gx / ww - s * LETTER_DRIFT) % 1
      const base = cycle(LETTERS, quant(f < 0 ? f + 1 : f, 16))
      const shine = quant(Math.max(0, 1 - Math.abs(gx - sweep) / 4), 4)
      p.put(ox + gx, oy + gy, scale(lerpRgb(base, WHITE, shine * 0.75), 1 - gy * 0.06))
    }
  const cells = p.toCells()
  // status line on the last row, over the aurora
  const y = rows - 1
  const bgAt = (x: number) => lerpRgb(p.get(x, y * 2), p.get(x, y * 2 + 1), 0.5)
  cells.text(2, y, d.left.slice(0, Math.max(0, cols - d.right.length - 6)), K.lavender, bgAt)
  const dot = d.online
    ? lerpRgb(K.green, K.greenDeep, quant(wave(DOT_RATE.online, s), 6))
    : lerpRgb(K.red, K.redDim, quant(wave(DOT_RATE.offline, s), 6))
  const rx = cols - d.right.length - 2
  cells.set(rx - 2, y, '●', dot, bgAt(rx - 2))
  cells.text(rx, y, d.right, K.text, bgAt)
  return cells.encode()
}

/** The one-row header: the aurora behind a gradient brand, `left` after it and the status on the right. */
function heroStrip(p: Pixels, cols: number, rows: number, s: number, sweep: number, d: HeroData): string {
  const cells = p.toCells()
  const y = rows - 1
  const bgAt = (x: number) => lerpRgb(p.get(x, y * 2), p.get(x, y * 2 + 1), 0.5)
  const brand = d.brand ?? ''
  for (let i = 0; i < brand.length && 1 + i < cols; i++) {
    const f = (i / Math.max(1, brand.length) - s * LETTER_DRIFT) % 1
    const base = cycle(LETTERS, quant(f < 0 ? f + 1 : f, 16))
    const shine = quant(Math.max(0, 1 - Math.abs(i * 4 - sweep) / 6), 4)
    cells.set(1 + i, y, brand[i]!, lerpRgb(base, WHITE, shine * 0.75), bgAt(1 + i))
  }
  const lx = brand ? brand.length + 3 : 1
  cells.text(lx, y, d.left.slice(0, Math.max(0, cols - lx - d.right.length - 5)), K.lavender, bgAt)
  const dot = d.online
    ? lerpRgb(K.green, K.greenDeep, quant(wave(DOT_RATE.online, s), 6))
    : lerpRgb(K.red, K.redDim, quant(wave(DOT_RATE.offline, s), 6))
  const rx = cols - d.right.length - 1
  cells.set(rx - 2, y, '●', dot, bgAt(rx - 2))
  cells.text(rx, y, d.right, K.text, bgAt)
  return cells.encode()
}

// ── pipeline ───────────────────────────────────────────────────────────────────

const PARTICLE_SPEED = 8.33 // cells/s
const PARTICLE_TRAIL = 5 // cells
const NODE_PULSE = 5.83 // rad/s

/** `phase` is the discrete current step; `fill` (0..1, tweened) is how far the connector after it is lit. */
export type PipelineData = { steps: string[]; phase: number; fill: number; failed: boolean; color: number }

function paintPipeline(cols: number, rows: number, t: number, d: PipelineData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  const n = d.steps.length
  const pad = 3
  const phase = Math.floor(d.phase)
  const fill = clamp01(d.fill)
  const at = (i: number) => (n > 1 ? Math.round(pad + (i * (cols - 1 - pad * 2)) / (n - 1)) : Math.floor(cols / 2))
  const head = (s * PARTICLE_SPEED)
  for (let i = 0; i < n - 1; i++) {
    const a = at(i), b = at(i + 1), span = b - a
    for (let x = a + 1; x < b; x++) {
      let col = K.faint
      if (i < phase) col = lerpRgb(K.teal, K.green, quant((x - a) / span, 6))
      else if (i === phase && !d.failed) {
        if (x - a <= fill * span) col = scale(d.color, 0.45)
        const dist = (((head % span) - (x - a)) % span + span) % span
        if (dist < PARTICLE_TRAIL) col = lerpRgb(col, d.color, quant(1 - dist / PARTICLE_TRAIL, 5))
      }
      c.set(x, 0, col === K.faint ? 0x254c : 0x2501, col)
    }
  }
  const pulse = quant(wave(NODE_PULSE, s), 6)
  for (let i = 0; i < n; i++) {
    const x = at(i)
    const done = i < phase
    const now = i === phase
    const glyph = done ? '●' : now ? (d.failed ? '✗' : '◉') : '○'
    const col = done ? K.green : now ? (d.failed ? K.red : lerpRgb(d.color, WHITE, pulse * 0.6)) : K.line
    c.set(x, 0, glyph, col)
    if (now && !d.failed) {
      const halo = lerpRgb(K.faint, d.color, 0.25 + pulse * 0.3)
      if (i > 0 && x - 1 > at(i - 1)) c.set(x - 1, 0, 0x2501, halo)
      if (i < n - 1 && x + 1 < at(i + 1)) c.set(x + 1, 0, 0x2501, halo)
    }
    const label = d.steps[i]!.slice(0, Math.max(3, Math.floor((cols - pad * 2) / n) - 1))
    const lx = Math.min(cols - label.length, Math.max(0, x - Math.floor(label.length / 2)))
    c.text(lx, 1, label, done ? K.mint : now ? (d.failed ? K.red : WHITE) : K.label)
  }
  return c.encode()
}

// ── progress ───────────────────────────────────────────────────────────────────

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const SHINE_SPEED = 11.67 // cells/s

export type ProgressData = { frac: number; live: boolean }

function paintProgress(cols: number, rows: number, t: number, d: ProgressData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  const exact = clamp01(d.frac) * cols
  const full = Math.floor(exact)
  const part = Math.floor((exact - full) * 8)
  const shine = d.live ? ((s * SHINE_SPEED) % (cols + 16)) - 8 : -99
  const edge = d.live ? quant(wave(NODE_PULSE, s) * 0.3, 3) : 0
  for (let x = 0; x < cols; x++) {
    const base = ramp(BAR, quant(cols > 1 ? x / (cols - 1) : 0, 12))
    const glow = quant(Math.max(0, 1 - Math.abs(x - shine) / 5), 4)
    let col = lerpRgb(base, WHITE, glow * 0.6)
    if (x === full - 1 && edge) col = lerpRgb(col, WHITE, edge)
    if (x < full) c.set(x, 0, '█', col, K.track)
    else if (x === full && part) c.set(x, 0, EIGHTHS[part]!, col, K.track)
    else c.set(x, 0, ' ', DEFAULT, K.track)
  }
  return c.encode()
}

// ── sparkline ──────────────────────────────────────────────────────────────────

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const SPARK_PULSE = 6.67 // rad/s

export type SparkData = { values: number[]; live: boolean }

function paintSpark(cols: number, rows: number, t: number, d: SparkData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  let max = 1
  for (const v of d.values) if (v > max) max = v
  const steps = rows * 8
  const tip = d.live ? quant(wave(SPARK_PULSE, s) / 2, 4) : 0
  for (let x = 0; x < cols; x++) {
    const v = d.values[Math.floor((x * d.values.length) / cols)] ?? 0
    const h = v > 0 ? Math.max(1, Math.round((v / max) * steps)) : 0
    const col = lerpRgb(ramp(SPARK, quant(h / steps, 8)), WHITE, x === cols - 1 ? tip : 0)
    for (let r = 0; r < rows; r++) {
      const fill = h - (rows - 1 - r) * 8
      if (fill >= 8) c.set(x, r, '█', col)
      else if (fill > 0) c.set(x, r, LEVELS[fill - 1]!, col)
      else if (r === rows - 1) c.set(x, r, '▁', K.baseline)
    }
  }
  return c.encode()
}

// ── orb (an agent's avatar) ────────────────────────────────────────────────────

const ORB_PULSE = 5 // rad/s
const ORB_ORBIT = 1.2 // rad/s, highlight travel

export type OrbData = { color: number; active: boolean; seed: number }

function paintOrb(cols: number, rows: number, t: number, d: OrbData): string {
  const s = t / 1000
  const p = new Pixels(cols, rows)
  const w = cols, h = rows * 2
  const k = d.active ? 0.55 + 0.45 * Math.sin(s * ORB_PULSE + d.seed) : 0.35
  const core = lerpRgb(scale(d.color, 0.4), d.color, quant(k, 8))
  const rim = scale(d.color, quant(d.active ? 0.35 + 0.2 * Math.sin(s * ORB_PULSE + d.seed + 1) : 0.18, 10))
  const R = Math.min(w, h) / 2, cx = (w - 1) / 2, cy = (h - 1) / 2
  const ang = s * ORB_ORBIT + d.seed, hx = cx + Math.cos(ang) * R * 0.4, hy = cy + Math.sin(ang) * R * 0.4
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))
      if (dist > R) continue
      let col = lerpRgb(core, rim, quant(dist / R, 4))
      if (d.active) col = lerpRgb(col, WHITE, quant(Math.max(0, 1 - Math.hypot(x - hx, y - hy) / (R * 0.8)), 3) * 0.45)
      p.put(x, y, col)
    }
  return p.toCells(true).encode()
}

// ── divider (shimmer line) ─────────────────────────────────────────────────────

const DIVIDER_SPEED = 30 // cells/s

export type DividerData = { color: number; active: boolean }

function paintDivider(cols: number, rows: number, t: number, d: DividerData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  const base = scale(d.color, 0.3)
  const sweep = d.active ? ((s * DIVIDER_SPEED) % (cols + 24)) - 12 : -99
  const y = Math.floor((rows - 1) / 2)
  for (let x = 0; x < cols; x++) {
    const g = quant(Math.max(0, 1 - Math.abs(x - sweep) / 6), 5)
    c.set(x, y, g > 0.5 ? '━' : '─', lerpRgb(base, d.color, g))
  }
  return c.encode()
}

// ── tab underline ──────────────────────────────────────────────────────────────

const UNDERLINE_SPEED = 18 // cells/s

/** `tabs` are the cell widths of the tabs laid out left to right; `active` may be fractional (tweened) to slide between tabs. */
export type UnderlineData = { tabs: number[]; active: number; color: number }

function paintUnderline(cols: number, rows: number, t: number, d: UnderlineData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  const y = rows - 1
  for (let x = 0; x < cols; x++) c.set(x, y, '─', K.baseline)
  const n = d.tabs.length
  if (n) {
    const start = (i: number) => {
      let x = 0
      for (let j = 0; j < i; j++) x += d.tabs[j]!
      return x
    }
    const i0 = Math.min(n - 1, Math.max(0, Math.floor(d.active))), i1 = Math.min(n - 1, i0 + 1)
    const f = clamp01(d.active - i0)
    const L = Math.round(start(i0) + (start(i1) - start(i0)) * f)
    const R = Math.round(start(i0) + d.tabs[i0]! + (start(i1) + d.tabs[i1]! - start(i0) - d.tabs[i0]!) * f)
    const len = R - L
    const sh = L + ((s * UNDERLINE_SPEED) % (len + 8)) - 4
    for (let x = L; x < R; x++) c.set(x, y, '━', lerpRgb(scale(d.color, 0.8), WHITE, quant(Math.max(0, 1 - Math.abs(x - sh) / 4), 4) * 0.5))
  }
  return c.encode()
}

// ── telemetry meters ───────────────────────────────────────────────────────────

/** One bar per row: `values` 0..1 (tweened), `colors` per bar, `labels` left-aligned. */
export type MetersData = { values: number[]; colors: number[]; labels: string[] }

function paintMeters(cols: number, rows: number, t: number, d: MetersData): string {
  const s = t / 1000
  const c = new Cells(cols, rows)
  let lw = 0
  for (const l of d.labels) if (l.length > lw) lw = l.length
  lw = Math.min(lw, Math.floor(cols / 3))
  const bx = lw + 1, bw = cols - bx
  for (let r = 0; r < Math.min(rows, d.values.length); r++) {
    const col = d.colors[r] ?? K.cyan
    c.text(0, r, (d.labels[r] ?? '').slice(0, lw), K.mute)
    const exact = clamp01(d.values[r]!) * Math.max(0, bw)
    const full = Math.floor(exact)
    const part = Math.floor((exact - full) * 8)
    const tip = quant(wave(3.3, s, r) * 0.4, 4)
    for (let x = 0; x < bw; x++) {
      let fg = lerpRgb(scale(col, 0.55), col, quant(bw > 1 ? x / (bw - 1) : 0, 6))
      if (x === full - 1) fg = lerpRgb(fg, WHITE, tip)
      if (x < full) c.set(bx + x, r, '█', fg, K.track)
      else if (x === full && part) c.set(bx + x, r, EIGHTHS[part]!, fg, K.track)
      else c.set(bx + x, r, ' ', DEFAULT, K.track)
    }
  }
  return c.encode()
}

// ── public API ─────────────────────────────────────────────────────────────────

export const hero = paintHero
export const pipeline = paintPipeline
export const progress = paintProgress
export const spark = paintSpark
export const orb = paintOrb
export const divider = paintDivider
export const underline = paintUnderline
export const meters = paintMeters
