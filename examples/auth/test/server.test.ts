import { expressAdapter } from '@dotpress/adapter-express'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createNotesApp } from '../src/app.ts'
import { generateKeys } from '../src/keys.ts'
import { createStore } from '../src/store.ts'
import {
  bearer,
  cookieHeader,
  cookiesOf,
  PASSWORD,
  type Tokens,
} from './support.ts'

// The same app on a real Express server, reached over HTTP.
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  const adapter = expressAdapter()
  const app = await createNotesApp({
    adapter,
    keys: generateKeys(),
    store: createStore(),
    issuer: 'https://api.example.com',
    passwordHashRounds: 4,
    logger: createMemoryLogger(),
  })
  const { port } = await app.listen(0, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

it('signs up, and logs in with the tokens in the body', async () => {
  const signUp = await post('/users', { username: 'alice', password: PASSWORD })
  expect(signUp.status).toBe(201)

  const login = await post('/auth/login', {
    username: 'alice',
    password: PASSWORD,
  })
  const { accessToken } = (await login.json()) as Tokens

  const me = await fetch(`${baseUrl}/auth/me`, { headers: bearer(accessToken) })
  expect(await me.json()).toMatchObject({ username: 'alice' })
})

it('logs in with cookies', async () => {
  await post('/users', { username: 'bob', password: PASSWORD })

  const login = await post('/auth/login', {
    username: 'bob',
    password: PASSWORD,
    mode: 'cookie',
  })
  const cookies = cookiesOf(login)
  const headers = {
    cookie: cookieHeader(cookies),
    'sec-fetch-site': 'same-origin',
  }

  const created = await post('/notes', { text: 'Hello' }, headers)
  expect(created.status).toBe(201)

  const refreshed = await post('/auth/refresh', {}, headers)
  expect(refreshed.status).toBe(200)
})

it('serves the documentation', async () => {
  expect((await fetch(`${baseUrl}/openapi.json`)).status).toBe(200)
  expect((await fetch(`${baseUrl}/docs`)).status).toBe(200)
})
