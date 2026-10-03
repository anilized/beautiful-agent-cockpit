import { expect, test } from 'claude-code/testing'

import { C, K, LETTERS, LOGO_GRADIENT, THEMES, hex, onTheme, useTheme } from '../hooks/theme'
import { hero, pairCount } from '../hooks/raster'

test('phosphor is the default; neon switches every palette view in place, listeners included', () => {
  expect(useTheme(undefined)).toBe('phosphor')
  expect(C.accent).toBe(THEMES.phosphor.c.accent)
  const seen: string[] = []
  onTheme(() => seen.push(C.accent))
  expect(useTheme('neon')).toBe('neon')
  expect([C.accent, K.accent, LETTERS[0], LOGO_GRADIENT[0]]).toEqual([THEMES.neon.c.accent, hex(THEMES.neon.c.accent), hex(C.cyan), C.cyan])
  expect(seen).toEqual([THEMES.phosphor.c.accent, THEMES.neon.c.accent])
  expect(useTheme('nonsense')).toBe('phosphor')
  expect(K.border).toBe(hex(THEMES.phosphor.c.border))
})

test('both themes keep the hero under 512 colour pairs, one row and four', () => {
  for (const name of ['phosphor', 'neon'] as const) {
    useTheme(name)
    for (const rows of [1, 4]) {
      for (const t of [0, 750, 3100]) {
        const cells = hero(140, rows, t, { online: true, alert: t > 1000, left: 'mission', right: 'executing · 3/9', brand: '◎ ANILDEV' })
        expect([name, rows, pairCount(cells) <= 512]).toEqual([name, rows, true])
      }
    }
  }
  useTheme('phosphor')
})
