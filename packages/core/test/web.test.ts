import { describe, expect, it } from 'vitest'
import { type NormalizedResponse } from '../src/index.js'
import {
  fromWebRequest,
  readRequestBody,
  toWebResponse,
} from '../src/adapter-api.js'
import { fromWebHeaders } from '../src/web.js'

const encoder = new TextEncoder()

/** Body stream sending the chunks one by one, recording its cancellation. */
const chunked = (chunks: string[]) => {
  const state = { cancelled: false, pulled: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { body, state }
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/upload', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit)

describe('fromWebRequest()', () => {
  it('normalizes a Web request, without its body', () => {
    const request = new Request('http://localhost/users/1?tag=a&tag=b&q=x', {
      headers: [
        ['X-Custom', 'one'],
        ['x-custom', 'two'],
        ['Cookie', 'a=1'],
      ],
    })

    expect(fromWebRequest(request)).toEqual({
      method: 'GET',
      path: '/users/1',
      url: 'http://localhost/users/1?tag=a&tag=b&q=x',
      params: {},
      query: { tag: ['a', 'b'], q: 'x' },
      headers: { 'x-custom': 'one, two', cookie: 'a=1' },
      body: undefined,
      signal: request.signal,
      ip: undefined,
      raw: request,
    })
  })

  it('takes the IP address, the signal and the native request', () => {
    const request = new Request('http://localhost/')
    const signal = new AbortController().signal
    const raw = { native: true }

    const normalized = fromWebRequest(request, { ip: '10.0.0.1', signal, raw })

    expect(normalized.ip).toBe('10.0.0.1')
    expect(normalized.signal).toBe(signal)
    expect(normalized.raw).toBe(raw)
  })

  it('keeps the encoded path', () => {
    expect(
      fromWebRequest(new Request('http://localhost/files/a%20b')).path
    ).toBe('/files/a%20b')
  })
})

describe('fromWebHeaders()', () => {
  it('lowercases the names', () => {
    expect(
      fromWebHeaders(new Headers({ 'Content-Type': 'text/plain' }))
    ).toEqual({ 'content-type': 'text/plain' })
  })
})

describe('readRequestBody()', () => {
  it('returns no body for requests without one', async () => {
    expect(await readRequestBody(new Request('http://localhost/'), 10)).toEqual(
      { body: undefined, files: undefined, rawBody: undefined }
    )
  })

  it('parses the body, and keeps the raw bytes', async () => {
    const result = await readRequestBody(
      post(JSON.stringify({ a: 1 }), { 'content-type': 'application/json' }),
      100
    )

    expect(result.body).toEqual({ a: 1 })
    expect(result.files).toBeUndefined()
    expect(new TextDecoder().decode(result.rawBody)).toBe('{"a":1}')
  })

  it('joins the chunks of a streamed body', async () => {
    const { body } = chunked(['hel', 'lo ', 'world'])
    const result = await readRequestBody(
      post(body, { 'content-type': 'text/plain' }),
      11
    )

    expect(result.body).toBe('hello world')
    expect(result.rawBody?.byteLength).toBe(11)
  })

  it('rejects a declared length beyond the limit, without reading', async () => {
    const { body, state } = chunked(['01234', '56789'])
    const request = post(body, { 'content-length': '10' })

    await expect(readRequestBody(request, 9)).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    })
    // At most the chunk pulled when the stream is created.
    expect(state.pulled).toBeLessThanOrEqual(1)
    expect(state.cancelled).toBe(true)
  })

  it('stops reading beyond the limit', async () => {
    const { body, state } = chunked(['01234', '56789', 'abcde', 'fghij'])

    await expect(readRequestBody(post(body), 9)).rejects.toMatchObject({
      status: 413,
    })
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBe(2)
  })

  it('accepts a body of exactly the limit', async () => {
    const result = await readRequestBody(
      post('0123456789', { 'content-length': '10' }),
      10
    )
    expect(result.rawBody?.byteLength).toBe(10)
  })

  it('rejects encoded bodies', async () => {
    const { body, state } = chunked(['x'])
    const request = post(body, { 'content-encoding': ' GZip ' })

    await expect(readRequestBody(request, 100)).rejects.toMatchObject({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported content encoding "gzip"',
    })
    expect(state.cancelled).toBe(true)

    await expect(
      readRequestBody(post('x', { 'content-encoding': 'br' }), 100)
    ).rejects.toMatchObject({ status: 415 })

    const identity = await readRequestBody(
      post('x', { 'content-encoding': 'Identity' }),
      100
    )
    expect(identity.rawBody?.byteLength).toBe(1)
  })

  it('reports malformed bodies', async () => {
    await expect(
      readRequestBody(post('{', { 'content-type': 'application/json' }), 100)
    ).rejects.toMatchObject({ status: 400, code: 'MALFORMED_BODY' })
  })
})

describe('toWebResponse()', () => {
  const response = (
    init: Partial<NormalizedResponse> = {}
  ): NormalizedResponse => ({
    status: 200,
    headers: {},
    body: null,
    ...init,
  })

  it('converts the status, the headers and the body', async () => {
    const res = await toWebResponse(
      response({
        status: 201,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'set-cookie': ['a=1', 'b=2'],
        },
        body: 'created',
      }),
      'POST'
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(await res.text()).toBe('created')
  })

  it('sends binary and streamed bodies', async () => {
    const binary = await toWebResponse(
      response({ body: new Uint8Array([1, 2, 3]) }),
      'GET'
    )
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    )

    const { body } = chunked(['a', 'b'])
    const streamed = await toWebResponse(response({ body }), 'GET')
    expect(await streamed.text()).toBe('ab')
  })

  it('drops the body of HEAD requests and null-body statuses', async () => {
    for (const [status, method] of [
      [200, 'HEAD'],
      [200, 'head'],
      [204, 'GET'],
      [205, 'GET'],
      [304, 'GET'],
    ] as const) {
      const { body, state } = chunked(['data'])
      const res = await toWebResponse(response({ status, body }), method)

      expect(res.body).toBeNull()
      expect(state.cancelled).toBe(true)
    }

    const head = await toWebResponse(
      response({ body: 'text', headers: { 'content-length': '4' } }),
      'HEAD'
    )
    expect(head.body).toBeNull()
    expect(head.headers.get('content-length')).toBe('4')
  })
})
