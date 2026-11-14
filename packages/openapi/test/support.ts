import { createRouter, type Router } from '@dotpress/core'
import { createTestApp, type TestAppOptions } from '@dotpress/testing'
import { Validator } from '@seriousme/openapi-schema-validator'
import { expect } from 'vitest'
import {
  generateOpenApi,
  type OpenApiDocument,
  type OpenApiOptions,
} from '../src/index.js'

const pem = (label: string, key: ArrayBuffer) =>
  [
    `-----BEGIN ${label}-----`,
    ...(Buffer.from(key)
      .toString('base64')
      .match(/.{1,64}/g) ?? []),
    `-----END ${label}-----`,
  ].join('\n')

/** RSA key pair for `createAuth()`. */
export const createKeys = async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
  return {
    privateKey: pem(
      'PRIVATE KEY',
      await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    ),
    publicKey: pem(
      'PUBLIC KEY',
      await crypto.subtle.exportKey('spki', pair.publicKey)
    ),
  }
}

export const INFO = { title: 'Test API', version: '1.0.0' }

/** Checks a document against the OpenAPI 3.1 schema. */
export const expectValid = async (document: OpenApiDocument) => {
  const result = await new Validator().validate(
    structuredClone(document) as never
  )
  expect(result.errors ?? []).toEqual([])
  expect(result.valid).toBe(true)
}

/**
 * Generates the document of an app with the routes of `define`, checks it,
 * and returns it with the warnings.
 */
export const generate = async (
  define: (router: Router) => void,
  options: Partial<OpenApiOptions> = {},
  appOptions: Omit<TestAppOptions, 'routers'> = {}
) => {
  const router = createRouter()
  define(router)
  const { app } = await createTestApp({ ...appOptions, routers: [router] })
  const warnings: string[] = []
  const document = generateOpenApi(app, {
    info: INFO,
    onWarning: (message) => warnings.push(message),
    ...options,
  })
  await expectValid(document)
  return { document, warnings, app }
}

/** Operation of a generated document. */
export const operation = (
  document: OpenApiDocument,
  method: string,
  path: string
) => {
  const item = document.paths[path] as Record<string, unknown> | undefined
  const found = item?.[method]
  if (!found) throw new Error(`No operation ${method} ${path}`)
  return found as Record<string, unknown> & {
    parameters?: Record<string, unknown>[]
    requestBody?: Record<string, unknown>
    responses: Record<string, unknown>
  }
}
