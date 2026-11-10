import { describe, expect, it, vi } from 'vitest'
import { createUpstashStore } from '../src/stores/upstash.js'
import { storeContract } from './store-contract.js'

/** A fetch answering each command with the next result. */
const fetchOf = (...replies: (Response | (() => Response))[]) =>
  vi.fn<typeof fetch>(async () => {
    const reply = replies.shift() ?? Response.json({ result: 'OK' })
    return typeof reply === 'function' ? reply() : reply
  })

const commandsOf = (fetchFn: ReturnType<typeof fetchOf>) =>
  fetchFn.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)) as unknown
  )

describe('createUpstashStore() with a mocked fetch', () => {
  it('sends each command as a JSON array, with the token', async () => {
    const fetchFn = fetchOf(
      Response.json({ result: 'value' }),
      Response.json({ result: ['a', null] }),
      Response.json({ result: null })
    )
    const store = createUpstashStore({
      url: 'https://eu1-example.upstash.io/',
      token: 'secret',
      fetch: fetchFn,
    })
    expect(store.name).toBe('upstash')
    expect(await store.get('k')).toBe('value')
    expect(await store.getMany?.(['a', 'b'])).toEqual(['a', undefined])
    expect(await store.get('missing')).toBeUndefined()
    await store.set('k', 'v', 1500.2)
    await store.delete('k')
    expect(fetchFn.mock.calls[0]).toEqual([
      'https://eu1-example.upstash.io',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: '["GET","k"]',
      },
    ])
    expect(commandsOf(fetchFn)).toEqual([
      ['GET', 'k'],
      ['MGET', 'a', 'b'],
      ['GET', 'missing'],
      ['SET', 'k', 'v', 'PX', '1501'],
      ['DEL', 'k'],
    ])
    expect(await store.getMany?.([])).toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(5)
  })

  it('takes and releases locks', async () => {
    const fetchFn = fetchOf(
      Response.json({ result: 'OK' }),
      Response.json({ result: null }),
      Response.json({ result: 1 })
    )
    const store = createUpstashStore({
      url: 'https://example.upstash.io',
      token: 't',
      fetch: fetchFn,
      name: 'edge-cache',
    })
    expect(store.name).toBe('edge-cache')
    const token = await store.lock?.('l', 2000)
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(await store.lock?.('l', 2000)).toBeUndefined()
    await store.unlock?.('l', token as string)
    expect(commandsOf(fetchFn)).toEqual([
      ['SET', 'l', token, 'NX', 'PX', '2000'],
      ['SET', 'l', expect.any(String), 'NX', 'PX', '2000'],
      [
        'EVAL',
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        '1',
        'l',
        token,
      ],
    ])
  })

  it('reports the errors of Upstash', async () => {
    const store = createUpstashStore({
      url: 'https://example.upstash.io',
      token: 't',
      fetch: fetchOf(
        Response.json({ error: 'Unauthorized' }, { status: 401 }),
        Response.json(
          { error: 'ERR max request size exceeded' },
          { status: 400 }
        ),
        new Response('<html>', { status: 502, statusText: 'Bad Gateway' }),
        new Response('', { status: 503 }),
        Response.json({}, { status: 500, statusText: 'Internal Server Error' }),
        Response.json({ error: 'ERR something' }),
        new Response('not json'),
        Response.json({ result: 42 }),
        Response.json({ result: ['only-one'] }),
        Response.json({ result: 'x' })
      ),
    })
    await expect(store.get('k')).rejects.toThrow(
      new Error('Upstash: 401 Unauthorized')
    )
    await expect(store.set('k', 'v', 1)).rejects.toThrow(
      'Upstash: 400 ERR max request size exceeded'
    )
    await expect(store.get('k')).rejects.toThrow('Upstash: 502 Bad Gateway')
    await expect(store.get('k')).rejects.toThrow(new Error('Upstash: 503'))
    await expect(store.get('k')).rejects.toThrow(
      new Error('Upstash: 500 Internal Server Error')
    )
    await expect(store.get('k')).rejects.toThrow('Upstash: 200 ERR something')
    await expect(store.get('k')).rejects.toThrow('Upstash: 200')
    await expect(store.get('k')).rejects.toThrow(
      new TypeError('Unexpected result from Upstash (number).')
    )
    await expect(store.getMany?.(['a', 'b'])).rejects.toThrow(
      new TypeError('Unexpected result from Upstash to MGET.')
    )
    await expect(store.getMany?.(['a'])).rejects.toThrow(
      'Unexpected result from Upstash to MGET.'
    )
  })

  it('checks its options', () => {
    const label = 'createUpstashStore()'
    const valid = { url: 'https://example.upstash.io', token: 't' }
    const create = (options: unknown) => () =>
      createUpstashStore(options as never)
    expect(create(null)).toThrow(`${label}: expected an object of options.`)
    expect(create('https://')).toThrow(
      `${label}: expected an object of options.`
    )
    expect(create({ ...valid, region: 'eu' })).toThrow(
      `${label}: unknown option "region".`
    )
    for (const url of [undefined, '', 'example.upstash.io', 'https:///x']) {
      expect(create({ ...valid, url })).toThrow(
        `${label}: url must be the REST URL of the database (UPSTASH_REDIS_REST_URL).`
      )
    }
    for (const token of [undefined, '', 42]) {
      expect(create({ ...valid, token })).toThrow(
        `${label}: token must be the REST token of the database (UPSTASH_REDIS_REST_TOKEN).`
      )
    }
    expect(create({ ...valid, fetch: 'fetch' })).toThrow(
      `${label}: fetch must be a function.`
    )
    expect(create({ ...valid, name: '' })).toThrow(
      `${label}: name must be a non-empty string.`
    )
    expect(Object.isFrozen(createUpstashStore(valid))).toBe(true)
    expect(create({ ...valid, url: 'http://localhost:8079' })).not.toThrow()
  })
})

// Against an Upstash database, or serverless-redis-http (SRH) in front of
// Redis: UPSTASH_URL and UPSTASH_TOKEN.
const url = process.env.UPSTASH_URL
const token = process.env.UPSTASH_TOKEN

describe.skipIf(!url || !token)('Upstash REST API', () => {
  // Created by the tests only: skipped suites are still collected.
  storeContract(() =>
    createUpstashStore({ url: url as string, token: token as string })
  )
})
