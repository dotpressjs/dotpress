import { describe, expect, it, vi } from 'vitest'
import {
  createLambdaTarget,
  fromLambdaResult,
  toLambdaEvent,
} from '../src/index.js'

const request = (path: string, init?: RequestInit) =>
  new Request(new URL(path, 'https://api.example.com'), init)

describe('toLambdaEvent()', () => {
  it('creates API Gateway REST API events (payload v1)', async () => {
    const event = await toLambdaEvent(
      request('/users/a%20b?tag=x&tag=y%20z', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'a=1; b=2' },
        body: '{"a":1}',
      }),
      'v1',
      '203.0.113.9'
    )

    expect(event).toMatchObject({
      httpMethod: 'POST',
      path: '/users/a%20b',
      headers: {
        host: 'api.example.com',
        'content-type': 'application/json',
        cookie: 'a=1; b=2',
      },
      multiValueHeaders: { 'content-type': ['application/json'] },
      queryStringParameters: { tag: 'y z' },
      multiValueQueryStringParameters: { tag: ['x', 'y z'] },
      requestContext: {
        domainName: 'api.example.com',
        identity: { sourceIp: '203.0.113.9' },
      },
      body: '{"a":1}',
      isBase64Encoded: false,
    })

    expect(await toLambdaEvent(request('/'), 'v1')).toMatchObject({
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: null,
      requestContext: { identity: { sourceIp: '127.0.0.1' } },
    })
  })

  it('creates HTTP API events (payload v2), with separate cookies', async () => {
    const event = await toLambdaEvent(
      request('/search?q=a%20b&q=c', { headers: { cookie: 'a=1; b=2' } }),
      'v2'
    )

    expect(event).toMatchObject({
      version: '2.0',
      rawPath: '/search',
      rawQueryString: 'q=a%20b&q=c',
      cookies: ['a=1', 'b=2'],
      requestContext: {
        domainName: 'api.example.com',
        http: { method: 'GET', path: '/search', sourceIp: '127.0.0.1' },
      },
      isBase64Encoded: false,
    })
    expect(event.headers).not.toHaveProperty('cookie')
    expect(event).not.toHaveProperty('body')
    expect(await toLambdaEvent(request('/'), 'v2')).not.toHaveProperty(
      'cookies'
    )
  })

  it('creates load balancer events, with the raw query', async () => {
    const event = await toLambdaEvent(
      request('/search?q=a%20b&q=c&flag', {
        headers: { 'x-forwarded-for': '198.51.100.1' },
      }),
      'alb',
      '203.0.113.9'
    )

    expect(event).toMatchObject({
      requestContext: { elb: { targetGroupArn: expect.any(String) } },
      httpMethod: 'GET',
      path: '/search',
      multiValueQueryStringParameters: { q: ['a%20b', 'c'], flag: [''] },
      multiValueHeaders: {
        host: ['api.example.com'],
        'x-forwarded-for': ['198.51.100.1, 203.0.113.9'],
        'x-forwarded-proto': ['https'],
      },
      body: '',
      isBase64Encoded: false,
    })

    const bare = await toLambdaEvent(request('/?a=1&&b'), 'alb')
    expect(bare).toMatchObject({
      multiValueHeaders: { 'x-forwarded-for': ['127.0.0.1'] },
    })
    expect(bare.multiValueQueryStringParameters).toEqual({ a: ['1'], b: [''] })
    expect(
      (await toLambdaEvent(request('/'), 'alb')).multiValueQueryStringParameters
    ).toEqual({})
  })

  it('creates load balancer events without multi-value headers', async () => {
    const event = await toLambdaEvent(
      request('/search?q=a%20b&q=c&flag', {
        headers: { 'x-forwarded-for': '198.51.100.1' },
      }),
      'alb-single-value',
      '203.0.113.9'
    )

    // One value per key: the last one, as sent.
    expect(event).toEqual({
      requestContext: { elb: { targetGroupArn: expect.any(String) } },
      httpMethod: 'GET',
      path: '/search',
      queryStringParameters: { q: 'c', flag: '' },
      headers: {
        host: 'api.example.com',
        'x-forwarded-for': '198.51.100.1, 203.0.113.9',
        'x-forwarded-proto': 'https',
      },
      body: '',
      isBase64Encoded: false,
    })
  })

  it('encodes binary bodies in base64', async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256)
    const binary = await toLambdaEvent(
      request('/upload', { method: 'POST', body: bytes }),
      'v2'
    )
    expect(binary.isBase64Encoded).toBe(true)
    expect(
      Uint8Array.from(atob(binary.body as string), (char) => char.charCodeAt(0))
    ).toEqual(bytes)

    // Invalid UTF-8 in a text body.
    const invalid = await toLambdaEvent(
      request('/upload', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Uint8Array.from([0xff]),
      }),
      'v1'
    )
    expect(invalid).toMatchObject({ body: '/w==', isBase64Encoded: true })

    for (const type of [
      'text/csv',
      'application/x-www-form-urlencoded',
      'application/problem+json; charset=utf-8',
    ]) {
      const text = await toLambdaEvent(
        request('/upload', {
          method: 'POST',
          headers: { 'content-type': type },
          body: 'a=1',
        }),
        'v1'
      )
      expect(text).toMatchObject({ body: 'a=1', isBase64Encoded: false })
    }
  })
})

describe('fromLambdaResult()', () => {
  it('converts headers, cookies and bodies', async () => {
    const res = fromLambdaResult({
      statusCode: 201,
      headers: { 'content-type': 'text/plain', vary: ['a', 'b'] },
      multiValueHeaders: { 'set-cookie': ['a=1', 'b=2'] },
      cookies: ['c=3'],
      body: 'created',
      isBase64Encoded: false,
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('vary')).toBe('a, b')
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2', 'c=3'])
    expect(await res.text()).toBe('created')
  })

  it('reads only `headers` for a load balancer without multi-value headers', async () => {
    const result = {
      statusCode: 200,
      headers: { 'content-type': 'text/plain', vary: ['a', 'b'] },
      multiValueHeaders: { 'set-cookie': ['a=1', 'b=2'] },
      cookies: ['c=3'],
      body: 'ok',
    }

    const res = fromLambdaResult(result, 'alb-single-value')
    expect(res.headers.get('content-type')).toBe('text/plain')
    // Ignored by the load balancer: arrays, multi-value headers, cookies.
    expect(res.headers.get('vary')).toBeNull()
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('decodes base64 bodies, and drops the body of null-body statuses', async () => {
    const binary = fromLambdaResult({
      statusCode: 200,
      body: 'AAEC/w==',
      isBase64Encoded: true,
    })
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(
      Uint8Array.from([0, 1, 2, 255])
    )

    for (const statusCode of [204, 304]) {
      const res = fromLambdaResult({ statusCode, body: 'ignored' })
      expect(res.body).toBeNull()
    }
    expect(fromLambdaResult({ statusCode: 200, body: '' }).body).toBeNull()
  })
})

describe('createLambdaTarget()', () => {
  it('rejects unknown options, and closes nothing by default', async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 204, body: '' })
    expect(() =>
      createLambdaTarget(handler, { format: 'v2', sourceIP: '1' } as never)
    ).toThrow(new TypeError('createLambdaTarget(): unknown option "sourceIP".'))

    const target = createLambdaTarget(handler, { format: 'v2' })
    expect((await target.fetch('/')).status).toBe(204)
    await expect(target.close()).resolves.toBeUndefined()
  })

  it('sends events to the handler, and answers 502 when it fails', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, body: 'ok' })
      .mockRejectedValueOnce(new Error('Crash'))
    const close = vi.fn(async () => {})
    const target = createLambdaTarget(handler, {
      format: 'v2',
      close,
      sourceIp: '203.0.113.9',
    })

    expect(await (await target.fetch('/a?b=1')).text()).toBe('ok')
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        rawPath: '/a',
        rawQueryString: 'b=1',
        requestContext: expect.objectContaining({
          http: expect.objectContaining({ sourceIp: '203.0.113.9' }),
        }),
      }),
      expect.objectContaining({ awsRequestId: expect.any(String) })
    )

    const failed = await target.fetch('/a')
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ message: 'Internal server error' })

    await target.close()
    expect(close).toHaveBeenCalledOnce()
  })
})
