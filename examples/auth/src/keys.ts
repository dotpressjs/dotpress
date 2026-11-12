import { generateKeyPairSync } from 'node:crypto'
import type { KeyPairSettings } from '@dotpress/auth'

/**
 * Generates an RSA key pair, PEM encoded as `@dotpress/auth` expects it:
 * PKCS#8 private key, SPKI public key. Same as:
 *
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
 *   openssl pkey -in private.pem -pubout -out public.pem
 */
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
 * Keys signing the access tokens, from `JWT_PRIVATE_KEY` and
 * `JWT_PUBLIC_KEY`. In development only, a missing pair is generated at
 * startup: the tokens then stop working at each restart.
 */
export const loadKeys = (
  env: Record<string, string | undefined> = process.env
): KeyPairSettings & { generated: boolean } => {
  const { JWT_PRIVATE_KEY, JWT_PUBLIC_KEY } = env
  if (JWT_PRIVATE_KEY && JWT_PUBLIC_KEY) {
    return {
      secretKey: pem(JWT_PRIVATE_KEY),
      publicKey: pem(JWT_PUBLIC_KEY),
      generated: false,
    }
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required.')
  }
  return { ...generateKeys(), generated: true }
}
