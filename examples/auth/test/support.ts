import { generatePasswordHash } from '@dotpress/auth'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { createNotesApp } from '../src/app.ts'
import { generateKeys } from '../src/keys.ts'
import { createStore, type Role } from '../src/store.ts'

/** One key pair per test file: generating one takes about 100 ms. */
const keys = generateKeys()

/** Low bcrypt cost: fast tests. Production keeps the default, 12. */
const HASH_ROUNDS = 4

export const PASSWORD = 'correct horse battery staple'

/** Default cookie names, with the default secure attributes. */
export const ACCESS_COOKIE = '__Host-dotpress_access_token'
export const REFRESH_COOKIE = '__Secure-dotpress_refresh_token'

/** Login and refresh response, in body mode. */
export interface Tokens {
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  expiresAt: string
}

/**
 * The app on the memory adapter of `@dotpress/testing`: requests run in
 * memory, without opening a port.
 */
export const startApp = async () => {
  const adapter = memoryAdapter()
  const store = createStore()
  const app = await createNotesApp({
    adapter,
    keys,
    store,
    issuer: 'https://api.example.com',
    passwordHashRounds: HASH_ROUNDS,
    logger: createMemoryLogger(),
  })

  const request = (path: string, init?: RequestInit) =>
    adapter.fetch(new Request(`https://api.example.com${path}`, init))

  const post = (
    path: string,
    body: unknown = {},
    headers: Record<string, string> = {}
  ) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  /** Creates an account in the store: admins do not sign up. */
  const createUser = async (username: string, role: Role = 'user') =>
    store.users.create({
      username,
      role,
      passwordHash: await generatePasswordHash(PASSWORD, {
        rounds: HASH_ROUNDS,
      }),
    })

  const login = (username: string, options: Record<string, unknown> = {}) =>
    post('/auth/login', { username, password: PASSWORD, ...options })

  /** Logs in in body mode, and returns the token pair. */
  const loginTokens = async (username: string) =>
    (await (await login(username)).json()) as Tokens

  return {
    store,
    request,
    post,
    createUser,
    login,
    loginTokens,
    close: () => app.close(),
  }
}

export type TestApi = Awaited<ReturnType<typeof startApp>>

export const bearer = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
})

/** Cookies set by a response, by name. */
export const cookiesOf = (res: Response) =>
  Object.fromEntries(
    res.headers.getSetCookie().map((cookie) => {
      const [pair = ''] = cookie.split(';')
      const index = pair.indexOf('=')
      return [
        pair.slice(0, index),
        { value: pair.slice(index + 1), raw: cookie },
      ]
    })
  )

/** `Cookie` header sending the cookies a browser keeps. */
export const cookieHeader = (cookies: Record<string, { value: string }>) =>
  Object.entries(cookies)
    .map(([name, { value }]) => `${name}=${value}`)
    .join('; ')
