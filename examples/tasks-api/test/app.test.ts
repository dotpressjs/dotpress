import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadKeys } from '../src/auth/keys.ts'
import { loadConfig, requireInProduction } from '../src/config.ts'
import { openDatabase } from '../src/db/database.ts'
import { DEMO_PASSWORD, seedDemo } from '../src/demo-data.ts'
import { startApp, type TestApi } from './support.ts'

describe('the app', () => {
  let api: TestApi

  beforeEach(async () => {
    api = await startApp()
  })

  afterEach(() => api.close())

  it('answers the health check', async () => {
    const res = await api.request('/health')
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('documents the API, with the secured routes', async () => {
    const res = await api.request('/openapi.json')
    const document = (await res.json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>
      components: { securitySchemes: Record<string, unknown> }
    }

    expect(document.components.securitySchemes).toHaveProperty('bearerAuth')
    expect(document.paths['/projects']?.get?.security).toEqual([
      { bearerAuth: [] },
    ])
    expect(document.paths['/users']?.post?.security).toBeUndefined()
    expect((await api.request('/docs')).status).toBe(200)
  })

  it('refuses an email address already used, whatever the letter case', async () => {
    await api.signUp('Alice')
    const res = await api.send('POST', '/users', {
      email: 'ALICE@example.com',
      name: 'Alice',
      password: DEMO_PASSWORD,
    })
    expect(res.status).toBe(409)
  })
})

describe('configuration', () => {
  it('has defaults for development', () => {
    expect(loadConfig({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_PATH: 'data/tasks.db',
      publicUrl: 'http://localhost:3000',
      production: false,
    })
  })

  it('lists the invalid variables', () => {
    expect(() => loadConfig({ PORT: 'eighty', REDIS_URL: 'nope' })).toThrow(
      /Invalid configuration:[\s\S]*PORT[\s\S]*REDIS_URL/
    )
  })

  it('requires other variables in production, by process', () => {
    const config = loadConfig({ NODE_ENV: 'production' })
    expect(() =>
      requireInProduction(config, ['PUBLIC_URL', 'SMTP_URL'])
    ).toThrow('Required in production: PUBLIC_URL, SMTP_URL.')
    // Not in development.
    expect(() =>
      requireInProduction(loadConfig({}), ['PUBLIC_URL'])
    ).not.toThrow()
  })
})

describe('files', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tasks-api-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('generates the development keys once, in the data directory', () => {
    const path = join(dir, 'data/dev-keys.json')
    const first = loadKeys({}, path)
    expect(first.secretKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(loadKeys({}, path)).toEqual(first)
  })

  it('seeds the demo data once', async () => {
    const db = openDatabase(join(dir, 'tasks.db'))
    expect(await seedDemo(db, 4)).toMatchObject({ created: true })
    expect(await seedDemo(db, 4)).toEqual({ created: false })
    const tasks = db.prepare('SELECT COUNT(*) AS count FROM tasks').get()
    expect(tasks).toEqual({ count: 3 })
    db.close()
  })
})
