import { createMemoryStore, type CacheStore } from '@dotpress/cache'
import {
  createMemoryTransport,
  type EventBus,
  type Transport,
} from '@dotpress/events'
import { createMemoryProvider, type MailProvider } from '@dotpress/mailer'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { createTasksApp } from '../src/http/app.ts'
import { generateKeys } from '../src/features/auth/keys.ts'
import { createBus } from '../src/services/bus.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepositories } from '../src/services/index.ts'
import { createNotifications } from '../src/features/notifications/listeners.ts'
import { createAppMailer } from '../src/services/mailer.ts'

/** One key pair per test file: generating one takes about 100 ms. */
const keys = generateKeys()

export const PASSWORD = 'correct horse battery staple'

export interface Session {
  userId: string
  /** Headers of the requests of this user. */
  headers: Record<string, string>
}

/**
 * The app on the memory adapter, with an in-memory SQLite database: each
 * test starts from an empty database. The events go through an in-memory
 * queue (no wait between attempts), and the emails to `outbox`.
 */
export const startApp = async (
  options: {
    cacheStore?: CacheStore
    events?: EventBus
    /** Defaults to `outbox`. */
    mailProvider?: MailProvider
    /** Defaults to an in-memory queue. */
    transport?: Transport
  } = {}
) => {
  const adapter = memoryAdapter()
  const repositories = createRepositories(openDatabase(':memory:'))
  const { db } = repositories
  const logger = createMemoryLogger()
  const outbox = createMemoryProvider()
  const transport = createMemoryTransport({ retryDelay: () => 0 })
  const listeners = createNotifications({
    repositories,
    mailer: createAppMailer(
      options.mailProvider ?? outbox,
      'Tasks <noreply@example.com>'
    ),
  })
  const app = await createTasksApp({
    adapter,
    repositories,
    keys,
    publicUrl: 'https://tasks.example.com',
    cacheStore: options.cacheStore ?? createMemoryStore(),
    events:
      options.events ??
      createBus(options.transport ?? transport, listeners, { logger }),
    passwordHashRounds: 4, // fast tests; production keeps 12
    logger,
  })

  const request = (path: string, init: RequestInit = {}) =>
    adapter.fetch(new Request(`http://localhost${path}`, init))

  const send = (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ) =>
    request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  /** Signs up and logs in. */
  const signUp = async (
    name: string,
    options: { language?: string } = {}
  ): Promise<Session> => {
    const email = `${name.toLowerCase()}@example.com`
    const created = await send(
      'POST',
      '/users',
      { email, name, password: PASSWORD },
      options.language ? { 'accept-language': options.language } : {}
    )
    if (created.status !== 201) {
      throw new Error(`Sign-up failed: ${await created.text()}`)
    }
    const login = await send('POST', '/auth/login', {
      username: email,
      password: PASSWORD,
    })
    const { userId, accessToken } = (await login.json()) as {
      userId: string
      accessToken: string
    }
    return { userId, headers: { authorization: `Bearer ${accessToken}` } }
  }

  /** A project of `owner`, with the other users as members. */
  const createProject = async (owner: Session, ...members: string[]) => {
    const res = await send(
      'POST',
      '/projects',
      { name: 'Launch' },
      owner.headers
    )
    const project = (await res.json()) as { id: string }
    for (const name of members) {
      await send(
        'POST',
        `/projects/${project.id}/members`,
        { email: `${name.toLowerCase()}@example.com` },
        owner.headers
      )
    }
    return project.id
  }

  /**
   * The SQL statements prepared while `run` runs: the queries of the
   * request, as a database log would show them.
   */
  const queriesOf = async (run: () => Promise<unknown>) => {
    const queries: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      queries.push(sql)
      return prepare(sql)
    }
    try {
      await run()
    } finally {
      db.prepare = prepare
    }
    return queries
  }

  return {
    db,
    logger,
    outbox,
    transport,
    listeners,
    /** Waits for the listeners of the emitted events. */
    drain: () => transport.drain(),
    request,
    queriesOf,
    send,
    signUp,
    createProject,
    close: async () => {
      await app.close()
      db.close()
    },
  }
}

export type TestApi = Awaited<ReturnType<typeof startApp>>
