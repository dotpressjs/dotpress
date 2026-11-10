import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createScalewayProvider } from '../src/providers/scaleway.js'
import {
  bodyOf,
  fullMessage,
  json,
  minimalMessage,
  mockFetch,
} from './fetch-mock.js'
import { startHttpServer, type Reply } from './http-server.js'

const PROJECT_ID = '11111111-2222-3333-4444-555555555555'

const created = () =>
  json(200, {
    emails: [
      { id: 'email-1', message_id: 'msg-1', mail_rcpt: 'a@example.com' },
      { id: 'email-2', message_id: 'msg-1', mail_rcpt: 'b@example.com' },
    ],
  })

const setup = (response: () => Response = created) => {
  const fetchMock = mockFetch(response)
  const mailer = createMailer({
    provider: createScalewayProvider({
      secretKey: 'secret-key',
      projectId: PROJECT_ID,
      fetch: fetchMock,
    }),
    from: 'Example <noreply@example.com>',
  })
  return { fetchMock, mailer }
}

describe('Scaleway provider', () => {
  it('posts the message to the Transactional Email API', async () => {
    const { fetchMock, mailer } = setup()
    const result = await mailer.sendMessage({
      ...fullMessage,
      replyTo: ['support@example.com', 'Sales <sales@example.com>'],
    })
    expect(result).toEqual({ messageId: 'email-1' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'
    )
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': 'secret-key',
      },
    })
    // Scaleway has no tags nor metadata: they are ignored.
    expect(bodyOf(fetchMock)).toStrictEqual({
      from: { email: 'noreply@example.com', name: 'Example' },
      to: [
        { email: 'ada@example.com', name: 'Ada Lovelace' },
        { email: 'grace@example.com' },
      ],
      cc: [{ email: 'charles@example.com', name: 'Charles' }],
      bcc: [{ email: 'archive@example.com' }],
      subject: 'Your invoice',
      text: 'Hello',
      html: '<p>Hello</p>',
      project_id: PROJECT_ID,
      attachments: [
        { name: 'invoice.pdf', type: 'application/pdf', content: 'AQID' },
        {
          name: 'notes.txt',
          type: 'application/octet-stream',
          content: 'Tm90ZXMgw6k=',
        },
      ],
      additional_headers: [
        {
          key: 'Reply-To',
          value: 'support@example.com, "Sales" <sales@example.com>',
        },
        { key: 'X-Campaign', value: 'spring' },
      ],
    })
  })

  it('sends the required fields only', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage(minimalMessage)
    expect(bodyOf(fetchMock)).toStrictEqual({
      from: { email: 'noreply@example.com', name: 'Example' },
      to: [{ email: 'a@example.com' }],
      subject: 'Hi',
      text: 'Hi',
      html: '',
      project_id: PROJECT_ID,
    })
  })

  it('uses the region and the base URL', async () => {
    const fetchMock = mockFetch(created)
    await createMailer({
      provider: createScalewayProvider({
        secretKey: 'secret-key',
        projectId: PROJECT_ID,
        region: 'nl-ams',
        baseUrl: 'https://proxy.example.com/',
        fetch: fetchMock,
      }),
      from: 'noreply@example.com',
    }).sendMessage(minimalMessage)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://proxy.example.com/transactional-email/v1alpha1/regions/nl-ams/emails'
    )
  })

  it.each([
    ['no emails', {}],
    ['an empty list', { emails: [] }],
    ['an email without ID', { emails: [{ message_id: 'msg-1' }] }],
  ])('returns no message ID for %s', async (_, body) => {
    const { mailer } = setup(() => json(200, body))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({
      messageId: undefined,
    })
  })

  it('accepts subjects of 998 characters', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({ ...minimalMessage, subject: 'x'.repeat(998) })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'an inline attachment',
      {
        attachments: [
          {
            filename: 'logo.png',
            content: new Uint8Array([9]),
            contentId: 'logo',
          },
        ],
      },
      'Scaleway does not support inline attachments (logo.png has a contentId).',
    ],
    [
      'a long subject',
      { subject: 'x'.repeat(999) },
      'Scaleway accepts subjects of at most 998 characters, got 999.',
    ],
    [
      'an empty header value',
      { headers: { 'X-A': 'a', 'X-Empty': '' } },
      'Scaleway does not accept empty header values (X-Empty).',
    ],
  ])('rejects %s', async (_, extra, text) => {
    const { fetchMock, mailer } = setup()
    await expect(
      mailer.sendMessage({ ...minimalMessage, ...extra } as MessageOptions)
    ).rejects.toThrow(new MailMessageError(text))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an error with invalid fields',
      () =>
        json(400, {
          message: 'invalid argument(s)',
          type: 'invalid_arguments',
          fields: {
            from: ['domain not verified'],
            subject: ['too long', 'empty'],
          },
        }),
      400,
      '400 invalid argument(s): from (domain not verified), subject (too long, empty)',
    ],
    [
      'an error with fields that are not lists',
      () =>
        json(400, { message: 'invalid argument(s)', fields: { from: 'x' } }),
      400,
      '400 invalid argument(s)',
    ],
    [
      'an error without fields',
      () => json(404, { message: 'resource not found', type: 'not_found' }),
      404,
      '404 resource not found',
    ],
    [
      'an error with null fields',
      () => json(403, { message: 'permission denied', fields: null }),
      403,
      '403 permission denied',
    ],
    [
      'an error without message',
      () => json(500, { fields: { a: ['b'] } }, 'Internal Server Error'),
      500,
      '500 Internal Server Error',
    ],
  ])('reports %s', async (_, response, status, text) => {
    const { mailer } = setup(response)
    const error = await mailer
      .sendMessage(minimalMessage)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the scaleway provider: ${text}`,
      provider: 'scaleway',
      status,
    })
  })

  it.each([
    [
      'no project',
      { secretKey: 'k' },
      'createScalewayProvider(): projectId must be a non-empty string.',
    ],
    [
      'no secret key',
      { projectId: PROJECT_ID },
      'createScalewayProvider(): secretKey must be a non-empty string.',
    ],
    [
      'an invalid region',
      { secretKey: 'k', projectId: PROJECT_ID, region: 'paris' },
      'createScalewayProvider(): region must be a Scaleway region, like fr-par.',
    ],
    [
      'a region that is not a string',
      { secretKey: 'k', projectId: PROJECT_ID, region: 1 },
      'createScalewayProvider(): region must be a Scaleway region, like fr-par.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createScalewayProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Scaleway provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              message: 'invalid argument(s)',
              fields: { to: ['blocked'] },
            }),
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ emails: [{ id: 'email-server-1' }] }),
          }
    )
  })

  afterAll(() => server.close())

  const mailer = () =>
    createMailer({
      provider: createScalewayProvider({
        secretKey: 'secret-key',
        projectId: PROJECT_ID,
        baseUrl: server.url,
      }),
      from: 'noreply@example.com',
    })

  it('sends the request over HTTP', async () => {
    expect(await mailer().sendMessage(fullMessage)).toEqual({
      messageId: 'email-server-1',
    })
    const request = server.requests.at(-1)!
    expect(request.url).toBe(
      '/transactional-email/v1alpha1/regions/fr-par/emails'
    )
    expect(request.headers['x-auth-token']).toBe('secret-key')
    expect(JSON.parse(request.body)).toMatchObject({ project_id: PROJECT_ID })
  })

  it('reports API errors', async () => {
    await expect(
      mailer().sendMessage({ ...minimalMessage, to: 'rejected@example.com' })
    ).rejects.toMatchObject({
      message:
        'Mail not sent by the scaleway provider: 400 invalid argument(s): to (blocked)',
      status: 400,
    })
  })
})
