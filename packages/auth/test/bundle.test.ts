import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bundle = new URL('../dist/index.js', import.meta.url)

// The CI builds the packages before testing them.
describe.skipIf(!existsSync(bundle))('published bundle', () => {
  it('keeps the context key declarations (module side effects)', () => {
    const source = readFileSync(bundle, 'utf8')

    expect(source).toContain('declareContextKey("user", "authPlugin")')
    expect(source).toContain('declareContextKey("auth", "authPlugin")')
  })
})
