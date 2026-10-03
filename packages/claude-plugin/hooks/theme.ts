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

export const C = {
  accent: '#ff8a3d', violet: '#a78bfa', cyan: '#22d3ee', blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24',
  red: '#f87171', pink: '#f472b6', text: '#e5e7eb', mute: '#9ca3af', dim: '#6b7280', faint: '#3f3f46', line: '#52525b',
  white: '#ffffff', ink: '#fafafa', bgDeep: '#0b0b0f', chip: '#2a2a33', border: '#2e2e36', borderDim: '#26262e',
  hover: '#1f1f27', tabActive: '#3a2412', redDeep: '#5b1d1d', redDark: '#7f1d1d', redDim: '#4c1d1d', yellowDeep: '#3a2a0a',
  violetDeep: '#3b2a55', track: '#1f1f26', baseline: '#27272a', label: '#71717a', teal: '#0f766e', mint: '#6ee7b7',
  greenDeep: '#065f46', lavender: '#c4b5fd', glow: '#3b2f7a', alertTint: '#3a2208', indigo: '#6366f1',
  chipOn: '#23232c', seatSupervisor: '#3b1d6e', seatLead: '#0e3a4a', thinkDim: '#8b80b8',
} as const

/** The same palette as 0xRRGGBB numbers, for the painters. */
export const K = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, hex(v)])) as { [P in keyof typeof C]: number }

const nums = (xs: readonly string[]) => xs.map(hex)
export const AURORA = nums(['#07070d', '#14112e', '#241b52', '#0c3a4a', '#0a2230', '#07070d'])
export const LETTERS = nums([C.cyan, C.violet, C.pink, C.accent, C.yellow, C.cyan])
export const BAR = nums([C.violet, C.cyan, C.green])
export const SPARK = nums([C.indigo, C.cyan, C.green])
/** String gradients for Text colours. */
export const LOGO_GRADIENT = [C.cyan, C.violet, C.pink, C.accent, C.yellow, C.cyan]
export const BAR_GRADIENT = [C.violet, C.cyan, C.green]
