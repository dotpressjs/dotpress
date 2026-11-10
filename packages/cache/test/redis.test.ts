import { Redis } from 'ioredis'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CacheStore } from '../src/index.js'
import { createRedisStore } from '../src/stores/redis.js'
import { storeContract } from './store-contract.js'

describe('createRedisStore() with fake clients', () => {
  it('sends commands through ioredis call()', async () => {
    const call = vi.fn(async (command: string) =>
      command === 'GET' ? 'value' : command === 'MGET' ? ['a', null] : 'OK'
    )
    const store = createRedisStore({ client: { call } })
    expect(store.name).toBe('redis')
    expect(await store.get('k')).toBe('value')
    expect(await store.getMany?.(['a', 'b'])).toEqual(['a', undefined])
    await store.set('k', 'v', 1500.2)
    await store.set('k', 'v', 0.3)
    await store.delete('k')
    expect(call.mock.calls).toEqual([
      ['GET', 'k'],
      ['MGET', 'a', 'b'],
      ['SET', 'k', 'v', 'PX', '1501'],
      ['SET', 'k', 'v', 'PX', '1'],
      ['DEL', 'k'],
    ])
  })

  it('sends commands through node-redis sendCommand()', async () => {
    const sendCommand = vi.fn(async (args: string[]) =>
      args[0] === 'GET' ? null : 'OK'
    )
    const store = createRedisStore({ client: { sendCommand }, name: 'valkey' })
    expect(store.name).toBe('valkey')
    expect(await store.get('k')).toBeUndefined()
    await store.delete('k')
    expect(sendCommand.mock.calls).toEqual([[['GET', 'k']], [['DEL', 'k']]])
  })

  it('takes and releases locks', async () => {
    const sendCommand = vi
      .fn<(args: string[]) => Promise<unknown>>()
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(1)
    const store = createRedisStore({ client: { sendCommand } })
    const token = await store.lock?.('l', 2000)
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(await store.lock?.('l', 2000)).toBeUndefined()
    await store.unlock?.('l', token as string)
    expect(sendCommand.mock.calls).toEqual([
      [['SET', 'l', token, 'NX', 'PX', '2000']],
      [['SET', 'l', expect.any(String), 'NX', 'PX', '2000']],
      [
        [
          'EVAL',
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          '1',
          'l',
          token,
        ],
      ],
    ])
  })

  it('refuses unexpected replies', async () => {
    const store = createRedisStore({
      client: {
        call: async (command: string) =>
          command === 'GET' ? Buffer.from('v') : ['only-one'],
      },
    })
    await expect(store.get('k')).rejects.toThrow(
      new TypeError(
        'Unexpected reply from Redis (object): use a client that returns strings.'
      )
    )
    await expect(store.getMany?.(['a', 'b'])).rejects.toThrow(
      new TypeError('Unexpected reply from Redis to MGET.')
    )
    const notArray = createRedisStore({ client: { call: async () => 'x' } })
    await expect(notArray.getMany?.(['a'])).rejects.toThrow(
      'Unexpected reply from Redis to MGET.'
    )
    expect(await notArray.getMany?.([])).toEqual([])
  })

  it('checks its options', () => {
    const label = 'createRedisStore()'
    const create = (options: unknown) => () =>
      createRedisStore(options as never)
    expect(create(null)).toThrow(`${label}: expected an object of options.`)
    expect(create('redis://')).toThrow(
      `${label}: expected an object of options.`
    )
    expect(create({ client: { call() {} }, url: 'redis://' })).toThrow(
      `${label}: unknown option "url".`
    )
    for (const client of [undefined, null, {}, { get() {} }]) {
      expect(create({ client })).toThrow(
        `${label}: client must be a node-redis or an ioredis client.`
      )
    }
    for (const client of [
      { isCluster: true, call() {} },
      { getMasters() {}, sendCommand() {} },
    ]) {
      expect(create({ client })).toThrow(
        `${label}: Redis Cluster clients are not supported: use a client of a standalone server (or of the primary).`
      )
    }
    for (const name of ['', 42]) {
      expect(create({ client: { call() {} }, name })).toThrow(
        `${label}: name must be a non-empty string.`
      )
    }
    expect(
      Object.isFrozen(createRedisStore({ client: { call() {} } as never }))
    ).toBe(true)
  })
})

// Against real servers: REDIS_URL (redis://localhost:6379) and VALKEY_URL.
const servers = [
  ['Redis', process.env.REDIS_URL],
  ['Valkey', process.env.VALKEY_URL],
] as const

for (const [server, url] of servers) {
  for (const library of ['node-redis', 'ioredis'] as const) {
    describe.skipIf(!url)(`${server} with ${library}`, () => {
      let store: CacheStore
      let close: () => Promise<unknown>
      const prefix = `test-${library}-${Date.now().toString(36)}`

      beforeAll(async () => {
        if (library === 'ioredis') {
          const client = new Redis(url as string)
          store = createRedisStore({ client })
          close = async () => client.disconnect()
        } else {
          const client = createClient({ url: url as string })
          await client.connect()
          store = createRedisStore({ client })
          close = () => client.close()
        }
      })
      afterAll(() => close())

      storeContract(() => store, prefix)
    })
  }
}
