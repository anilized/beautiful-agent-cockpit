// Design tokens: the only module with colour literals. Dependency-free; shared by register.tsx and raster.ts.

export function hex(c: string): number {
  return parseInt(c.slice(1), 16)
}
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)

/** Channel-wise blend of two 0xRRGGBB colours; t is clamped to 0..1. Integer maths, no allocation. */
export function lerpRgb(a: number, b: number, t: number): number {
  const k = clamp01(t)
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const r = Math.round(ar + (((b >> 16) & 255) - ar) * k)
  const g = Math.round(ag + (((b >> 8) & 255) - ag) * k)
  const bl = Math.round(ab + ((b & 255) - ab) * k)
  return (r << 16) | (g << 8) | bl
}
/** Brightness scale towards black. */
export const scale = (c: number, k: number) => lerpRgb(0, c, k)
/** Gradient lookup, t clamped to 0..1. */
export function ramp(stops: readonly number[], t: number): number {
  const x = clamp01(t) * (stops.length - 1)
  const i = Math.floor(x)
  return lerpRgb(stops[i]!, stops[Math.min(i + 1, stops.length - 1)]!, x - i)
}
/** Gradient lookup that wraps (t mod 1); stops should start and end on the same colour. */
export const cycle = (stops: readonly number[], t: number) => ramp(stops, (((t % 1) + 1) % 1))
/** Snap t (0..1) to n levels; painters quantize before blending to bound distinct colours per frame. */
export const quant = (t: number, n: number) => Math.round(clamp01(t) * n) / n

const NEON = {
  accent: '#ff8a3d', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24',
  red: '#f87171', pink: '#f472b6', text: '#e5e7eb', mute: '#9ca3af', dim: '#6b7280', faint: '#3f3f46', line: '#52525b',
  white: '#ffffff', ink: '#fafafa', bgDeep: '#0b0b0f', chip: '#2a2a33', border: '#2e2e36', borderDim: '#26262e',
  hover: '#1f1f27', tabActive: '#3a2412', redDeep: '#5b1d1d', redDark: '#7f1d1d', redDim: '#4c1d1d', yellowDeep: '#3a2a0a',
  violetDeep: '#3b2a55', track: '#1f1f26', baseline: '#27272a', label: '#71717a', teal: '#0f766e', mint: '#6ee7b7',
  greenDeep: '#065f46', lavender: '#c4b5fd', glow: '#3b2f7a', alertTint: '#3a2208', indigo: '#6366f1',
  chipOn: '#23232c', seatSupervisor: '#3b1d6e', seatLead: '#0e3a4a', thinkDim: '#8b80b8', orange: '#fb923c',
}
export type Palette = Record<keyof typeof NEON, string>

/** Phosphor: black glass, green frames and headings; roles keep their own hues. */
const PHOSPHOR: Palette = {
  accent: '#4ade80', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#4ade80', yellow: '#facc15',
  red: '#f87171', pink: '#f472b6', text: '#cfe3d6', mute: '#8aa595', dim: '#5f7a6a', faint: '#2f4a3a', line: '#3b5a47',
  white: '#ffffff', ink: '#eafff2', bgDeep: '#060a08', chip: '#12251a', border: '#1f4a30', borderDim: '#163524',
  hover: '#0f2016', tabActive: '#123d24', redDeep: '#5b1d1d', redDark: '#7f1d1d', redDim: '#4c1d1d', yellowDeep: '#3a3008',
  violetDeep: '#2a2550', track: '#10201a', baseline: '#1d2f24', label: '#6f8a7a', teal: '#0f766e', mint: '#86efac',
  greenDeep: '#14532d', lavender: '#a7e8bd', glow: '#1f6b3a', alertTint: '#3a2a08', indigo: '#34d399',
  chipOn: '#163a24', seatSupervisor: '#2e2160', seatLead: '#0c3a44', thinkDim: '#7aa38a', orange: '#fb923c',
}

type Theme = { c: Palette; aurora: string[]; letters: (c: Palette) => string[]; bar: (c: Palette) => string[]; spark: (c: Palette) => string[]; logo: (c: Palette) => string[] }
export const THEMES: Record<'phosphor' | 'neon', Theme> = {
  phosphor: {
    c: PHOSPHOR,
    aurora: ['#050906', '#0a1a10', '#0f2e1a', '#0a2a2a', '#06140c', '#050906'],
    letters: c => [c.mint, c.green, c.teal, c.cyan, c.mint],
    bar: c => [c.teal, c.green, c.mint],
    spark: c => [c.teal, c.green, c.mint],
    logo: c => [c.mint, c.green, c.cyan, c.green, c.mint],
  },
  neon: {
    c: NEON,
    aurora: ['#07070d', '#14112e', '#241b52', '#0c3a4a', '#0a2230', '#07070d'],
    letters: c => [c.cyan, c.violet, c.pink, c.accent, c.yellow, c.cyan],
    bar: c => [c.violet, c.cyan, c.green],
    spark: c => [c.indigo, c.cyan, c.green],
    logo: c => [c.cyan, c.violet, c.pink, c.accent, c.yellow, c.cyan],
  },
}
export type ThemeName = keyof typeof THEMES

/** The active palette. Mutated in place by useTheme, so every importer sees the switch. */
export const C: Palette = { ...PHOSPHOR }
/** The same palette as 0xRRGGBB numbers, for the painters. */
export const K = {} as { [P in keyof Palette]: number }
export const AURORA: number[] = []
export const LETTERS: number[] = []
export const BAR: number[] = []
export const SPARK: number[] = []
/** String gradients for Text colours. */
export const LOGO_GRADIENT: string[] = []
export const BAR_GRADIENT: string[] = []

const listeners: (() => void)[] = []
/** Run `fn` now and after every theme switch (for maps built from the palette). */
export function onTheme(fn: () => void): void {
  listeners.push(fn)
  fn()
}
const refill = <T,>(xs: T[], next: T[]) => void xs.splice(0, xs.length, ...next)

/** Switch the palette (unknown names fall back to phosphor); returns the theme in use. */
export function useTheme(name: string | null | undefined): ThemeName {
  const key: ThemeName = name === 'neon' ? 'neon' : 'phosphor'
  const t = THEMES[key]
  Object.assign(C, t.c)
  for (const k of Object.keys(C) as (keyof Palette)[]) K[k] = hex(C[k])
  refill(AURORA, t.aurora.map(hex))
  refill(LETTERS, t.letters(C).map(hex))
  refill(BAR, t.bar(C).map(hex))
  refill(SPARK, t.spark(C).map(hex))
  refill(LOGO_GRADIENT, t.logo(C))
  refill(BAR_GRADIENT, t.bar(C))
  for (const fn of listeners) fn()
  return key
}
useTheme('phosphor')
