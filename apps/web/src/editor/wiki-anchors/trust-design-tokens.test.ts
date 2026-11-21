import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// The trust UI draws only with the design system's tokens, so light, dark,
// and any future theme stay consistent without per-component colors.
const FILES = [
  './wiki-claim-trust-card.tsx',
  './wiki-trust-summary.tsx',
  './wiki-article-plugin.tsx',
  '../../components/settings/wiki-trust-display-field.tsx',
  '../../components/settings/wiki-trust-display-preview.tsx',
  '../../components/settings/wiki-trust-report-field.tsx',
]

it.each(FILES)('%s uses tokens, not raw colors', (file) => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
})
