import { expect, it } from 'vitest'
import { generateKeys, loadKeys } from '../src/keys.ts'

const { privateKey, publicKey } = generateKeys()

it('reads the keys from the environment', () => {
  const keys = loadKeys({
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
  })

  expect(keys).toEqual({ privateKey, publicKey, generated: false })
})

it('accepts keys stored in one line, with escaped line breaks', () => {
  const keys = loadKeys({
    JWT_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n'),
    JWT_PUBLIC_KEY: publicKey.replaceAll('\n', '\\n'),
  })

  expect(keys).toEqual({ privateKey, publicKey, generated: false })
})

it('generates a temporary pair in development', () => {
  const keys = loadKeys({})

  expect(keys.generated).toBe(true)
  expect(keys.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
  expect(keys.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/)
})

it('requires the keys in production', () => {
  expect(() => loadKeys({ NODE_ENV: 'production' })).toThrow(
    'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required.'
  )
})
