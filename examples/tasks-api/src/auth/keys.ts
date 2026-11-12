import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import type { KeyPairSettings } from '@dotpress/auth'
import type { Config } from '../config.ts'

/** An RSA key pair, PEM encoded as @dotpress/auth expects it. */
export const generateKeys = (): KeyPairSettings => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { secretKey: privateKey, publicKey }
}

/** Platforms storing a PEM in one line escape its line breaks. */
const pem = (value: string) => value.replaceAll('\\n', '\n')

/**
 * The keys signing the access tokens: from the environment, or, in
 * development, a pair generated once in `data/` (next to the database,
 * ignored by git), so that tokens survive restarts.
 */
export const loadKeys = (
  config: Pick<Config, 'JWT_PRIVATE_KEY' | 'JWT_PUBLIC_KEY'>,
  devKeysPath = 'data/dev-keys.json'
): KeyPairSettings => {
  if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
    return {
      secretKey: pem(config.JWT_PRIVATE_KEY),
      publicKey: pem(config.JWT_PUBLIC_KEY),
    }
  }
  if (existsSync(devKeysPath)) {
    return JSON.parse(readFileSync(devKeysPath, 'utf8')) as KeyPairSettings
  }
  const keys = generateKeys()
  mkdirSync(dirname(devKeysPath), { recursive: true })
  writeFileSync(devKeysPath, JSON.stringify(keys), { mode: 0o600 })
  return keys
}
