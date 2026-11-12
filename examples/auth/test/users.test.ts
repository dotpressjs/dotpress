import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bearer, PASSWORD, startApp, type TestApi } from './support.ts'

let api: TestApi

beforeEach(async () => {
  api = await startApp()
})

afterEach(() => api.close())

describe('sign-up', () => {
  it('rejects a username already taken, whatever the letter case', async () => {
    await api.createUser('alice')

    const res = await api.post('/users', {
      username: 'ALICE',
      password: PASSWORD,
    })
    expect(res.status).toBe(409)
  })

  it('rejects short passwords, and passwords bcrypt would truncate', async () => {
    const short = await api.post('/users', {
      username: 'alice',
      password: 'short',
    })
    expect(short.status).toBe(400)

    // 37 characters, but 74 bytes in UTF-8: bcrypt reads 72 bytes at most.
    const long = await api.post('/users', {
      username: 'alice',
      password: 'é'.repeat(37),
    })
    expect(long.status).toBe(400)
    expect(await long.json()).toMatchObject({
      error: 'VALIDATION_FAILED',
      data: {
        issues: [{ path: ['password'], message: 'Password too long' }],
      },
    })
  })
})

describe('password change', () => {
  it('requires the current password', async () => {
    await api.createUser('alice')
    const { accessToken } = await api.loginTokens('alice')

    const res = await api.request('/users/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(accessToken) },
      body: JSON.stringify({
        currentPassword: 'not the password',
        newPassword: 'a brand new passphrase',
      }),
    })
    expect(res.status).toBe(403)
  })

  it('logs out every device', async () => {
    await api.createUser('alice')
    const phone = await api.loginTokens('alice')
    const laptop = await api.loginTokens('alice')

    const changed = await api.request('/users/me/password', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...bearer(laptop.accessToken),
      },
      body: JSON.stringify({
        currentPassword: PASSWORD,
        newPassword: 'a brand new passphrase',
      }),
    })
    expect(changed.status).toBe(204)

    for (const device of [phone, laptop]) {
      const notes = await api.request('/notes', {
        headers: bearer(device.accessToken),
      })
      expect(notes.status).toBe(401)
    }

    expect((await api.login('alice')).status).toBe(401)
    const login = await api.post('/auth/login', {
      username: 'alice',
      password: 'a brand new passphrase',
    })
    expect(login.status).toBe(200)
  })
})

describe('authorization', () => {
  it('keeps the notes of each user private', async () => {
    await api.createUser('alice')
    await api.createUser('bob')
    const alice = await api.loginTokens('alice')
    const bob = await api.loginTokens('bob')

    const created = await api.post(
      '/notes',
      { text: 'Private' },
      bearer(alice.accessToken)
    )
    const note = (await created.json()) as { id: string }

    // 404, not 403: the note of another user does not exist for bob.
    const read = await api.request(`/notes/${note.id}`, {
      headers: bearer(bob.accessToken),
    })
    expect(read.status).toBe(404)

    const list = await api.request('/notes', {
      headers: bearer(bob.accessToken),
    })
    expect(await list.json()).toEqual([])
  })

  it('reserves the admin routes to the admin role', async () => {
    await api.createUser('alice')
    await api.createUser('root', 'admin')
    const user = await api.loginTokens('alice')
    const admin = await api.loginTokens('root')

    expect((await api.request('/admin/users')).status).toBe(401)

    const forbidden = await api.request('/admin/users', {
      headers: bearer(user.accessToken),
    })
    expect(forbidden.status).toBe(403)

    const allowed = await api.request('/admin/users', {
      headers: bearer(admin.accessToken),
    })
    expect(allowed.status).toBe(200)
    const users = (await allowed.json()) as Record<string, unknown>[]
    expect(users.map((item) => item.username).sort()).toEqual(['alice', 'root'])
    // The response schema never returns the password hashes.
    expect(users[0]).not.toHaveProperty('passwordHash')
  })
})

describe('documentation', () => {
  it('documents the guarded routes as secured by a bearer token', async () => {
    const res = await api.request('/openapi.json')
    const document = (await res.json()) as {
      components: { securitySchemes: Record<string, unknown> }
      paths: Record<string, Record<string, { security?: unknown }>>
    }

    expect(document.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    })
    expect(document.paths['/notes']?.get?.security).toEqual([
      { bearerAuth: [] },
    ])
    expect(document.paths['/users']?.post?.security).toBeUndefined()
  })
})
