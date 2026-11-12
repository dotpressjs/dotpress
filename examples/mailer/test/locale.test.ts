import { expect, it } from 'vitest'
import { negotiateLocale } from '../src/locale.ts'

const supported = ['en', 'fr']

it.each([
  ['fr', 'fr'],
  ['fr-CA', 'fr'],
  ['FR-ca,en;q=0.5', 'fr'],
  ['de-DE,de;q=0.9,fr;q=0.8,en;q=0.7', 'fr'],
  ['en;q=0.5,fr;q=0.8', 'fr'],
  ['fr;q=0,en', 'en'],
  ['de, *', undefined],
  ['', undefined],
  [undefined, undefined],
])('picks a supported locale for %j', (header, expected) => {
  expect(negotiateLocale(header, supported)).toBe(expected)
})
