import { describe, expect, it } from 'vitest'
import {
  ExpectationError,
  expectEventEmitted,
  expectEventNotEmitted,
  expectMailSent,
  expectNoMailSent,
  type Emission,
  type SentMail,
} from '../src/index.js'

const emission = (overrides: Partial<Emission> = {}): Emission => ({
  emissionId: 'emission-1',
  event: 'user.created',
  payload: { userId: '42', email: 'ada@example.com' },
  delay: undefined,
  metadata: { requestId: 'req-1' },
  emittedAt: new Date('2026-11-10T10:00:00.000Z'),
  ...overrides,
})

const userCreated = { name: 'user.created' }

describe('expectEventEmitted()', () => {
  const bus = {
    emitted: [
      emission(),
      emission({
        emissionId: 'emission-2',
        event: 'order.paid',
        payload: { orderId: 'A-1', amount: 30 },
        delay: 60,
        metadata: {},
      }),
      emission({ emissionId: 'emission-3', payload: { userId: '43' } }),
    ],
  }

  it('finds an emission by event, and returns the last one', () => {
    expect(expectEventEmitted(bus, userCreated)).toBe(bus.emitted[2])
    expect(expectEventEmitted(bus, 'order.paid')).toBe(bus.emitted[1])
    expect(expectEventEmitted(bus, userCreated, undefined, { times: 2 })).toBe(
      bus.emitted[2]
    )
  })

  it('matches the payload partially, with asymmetric matchers', () => {
    expect(expectEventEmitted(bus, userCreated, { userId: '42' })).toBe(
      bus.emitted[0]
    )
    expectEventEmitted(bus, 'order.paid', {
      orderId: expect.stringMatching(/^A-/),
      amount: expect.any(Number),
    })
    expectEventEmitted(
      bus,
      userCreated,
      expect.objectContaining({ userId: '43' })
    )
    expect(() =>
      expectEventEmitted(bus, userCreated, { userId: '44' })
    ).toThrow(ExpectationError)
  })

  it('matches payloads that are not objects exactly', () => {
    const source = {
      emitted: [
        emission({ payload: 'text' }),
        emission({ payload: null }),
        emission({ payload: ['a', 'b'] }),
      ],
    }
    expectEventEmitted(source, userCreated, 'text')
    expectEventEmitted(source, userCreated, null)
    expectEventEmitted(source, userCreated, ['a', 'b'])
    expect(() => expectEventEmitted(source, userCreated, 'tex')).toThrow(
      ExpectationError
    )
    expect(() => expectEventEmitted(source, userCreated, ['a'])).toThrow(
      ExpectationError
    )
    expect(() =>
      expectEventEmitted(
        { emitted: [emission({ payload: 'x' })] },
        userCreated,
        {}
      )
    ).toThrow(ExpectationError)
  })

  it('checks the number of emissions, the metadata and the delay', () => {
    expectEventEmitted(bus, userCreated, undefined, { times: 2 })
    expectEventEmitted(bus, userCreated, { userId: '42' }, { times: 1 })
    expectEventEmitted(bus, userCreated, undefined, {
      metadata: { requestId: 'req-1' },
      times: 2,
    })
    expectEventEmitted(bus, 'order.paid', undefined, { delay: 60 })
    expectEventEmitted(bus, userCreated, undefined, {
      delay: undefined,
      times: 2,
    })
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, { times: 3 })
    ).toThrow(ExpectationError)
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, {
        metadata: { requestId: 'req-2' },
      })
    ).toThrow(ExpectationError)
    expect(() =>
      expectEventEmitted(bus, 'order.paid', undefined, { delay: 30 })
    ).toThrow(ExpectationError)
  })

  it('explains what was emitted', () => {
    expect(() =>
      expectEventEmitted(
        bus,
        userCreated,
        { userId: '44' },
        {
          metadata: { requestId: 'req-1' },
          delay: 0,
        }
      )
    ).toThrow(
      new ExpectationError(
        [
          'Expected event "user.created" emitted with payload {"userId":"44"} and metadata {"requestId":"req-1"} and delay 0, found 0.',
          'Emitted events:',
          '  - user.created {"userId":"42","email":"ada@example.com"}',
          '  - order.paid {"orderId":"A-1","amount":30} (delay 60)',
          '  - user.created {"userId":"43"}',
        ].join('\n')
      )
    )
    expect(() =>
      expectEventEmitted({ emitted: [] }, userCreated, undefined, { times: 2 })
    ).toThrow(
      new ExpectationError(
        'Expected event "user.created" emitted 2 times, found 0.\nNo event was emitted.'
      )
    )
    expect(() =>
      expectEventEmitted(bus, 'order.paid', undefined, { times: 1 })
    ).not.toThrow()
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, { times: 1 })
    ).toThrow('Expected event "user.created" emitted once, found 2.')
    try {
      expectEventEmitted({ emitted: [] }, userCreated)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('AssertionError')
    }
  })

  it('shortens long payloads in messages', () => {
    const source = {
      emitted: [emission({ payload: { text: 'x'.repeat(400) } })],
    }
    const message = (() => {
      try {
        expectEventEmitted(source, 'other')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    const line = message.split('\n')[2] as string
    expect(line).toBe(`  - user.created {"text":"${'x'.repeat(288)}...`)
  })

  it('shows asymmetric matchers and values that are not JSON', () => {
    const messageOf = (run: () => unknown) => {
      try {
        run()
        return ''
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(
      messageOf(() =>
        expectEventEmitted(bus, userCreated, {
          userId: expect.any(Number),
          email: expect.stringContaining('@'),
        })
      )
    ).toContain(
      'with payload {"userId":"Any<Number>","email":"StringContaining"}'
    )
    const big = { emitted: [emission({ payload: { size: 1n } })] }
    expect(messageOf(() => expectEventEmitted(big, 'other'))).toContain(
      '  - user.created [object Object]'
    )
    // 300 characters are kept, 301 are cut.
    const sized = (length: number) => ({
      emitted: [emission({ payload: 'x'.repeat(length - 2) })],
    })
    expect(messageOf(() => expectEventEmitted(sized(300), 'other'))).toContain(
      `  - user.created "${'x'.repeat(298)}"`
    )
    expect(messageOf(() => expectEventEmitted(sized(301), 'other'))).toContain(
      `  - user.created "${'x'.repeat(296)}...`
    )
  })

  it('reads the envelopes of a memory transport, one emission per emissionId', () => {
    const envelope = {
      emissionId: 'emission-1',
      event: 'user.created',
      payload: { userId: '42' },
      metadata: { requestId: 'req-1' },
      emittedAt: '2026-11-10T10:00:00.000Z',
    }
    const transport = {
      sent: [
        { ...envelope, listener: 'a' },
        { ...envelope, listener: 'b' },
        { ...envelope, emissionId: 'emission-2', listener: 'a' },
      ],
    }
    expect(
      expectEventEmitted(transport, userCreated, { userId: '42' }, { times: 2 })
    ).toEqual({
      emissionId: 'emission-2',
      event: 'user.created',
      payload: { userId: '42' },
      delay: undefined,
      metadata: { requestId: 'req-1' },
      emittedAt: new Date('2026-11-10T10:00:00.000Z'),
    })
    expect(() =>
      expectEventEmitted(transport, userCreated, undefined, { delay: 10 })
    ).toThrow(
      new TypeError(
        'expectEventEmitted(): delay is only recorded by a fake event bus (createFakeEventBus()).'
      )
    )
  })

  it('checks its arguments', () => {
    const label = 'expectEventEmitted()'
    for (const source of [null, {}, 'bus', { emitted: 'x' }, { sent: {} }]) {
      expect(() => expectEventEmitted(source as never, userCreated)).toThrow(
        `${label}: expected a fake event bus (createFakeEventBus()) or a memory transport (createMemoryTransport()).`
      )
    }
    for (const event of [undefined, '', {}, { name: 42 }]) {
      expect(() => expectEventEmitted(bus, event as never)).toThrow(
        `${label}: expected an event created by defineEvent(), or its name.`
      )
    }
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, 'twice' as never)
    ).toThrow(`${label}: expected an object of options.`)
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, null as never)
    ).toThrow(`${label}: expected an object of options.`)
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, { count: 1 } as never)
    ).toThrow(`${label}: unknown option "count".`)
    for (const times of [-1, 1.5, '2']) {
      expect(() =>
        expectEventEmitted(bus, userCreated, undefined, { times } as never)
      ).toThrow(`${label}: times must be a non-negative integer.`)
    }
    expect(() =>
      expectEventEmitted(bus, userCreated, undefined, { times: 0 })
    ).toThrow(
      `${label}: times must be at least 1 (use expectEventNotEmitted()).`
    )
  })
})

describe('expectEventNotEmitted()', () => {
  const bus = { emitted: [emission()] }

  it('passes when no emission matches', () => {
    expectEventNotEmitted(bus, 'order.paid')
    expectEventNotEmitted(bus, userCreated, { userId: '43' })
    expectEventNotEmitted({ emitted: [] }, userCreated)
  })

  it('fails when an emission matches', () => {
    expect(() => expectEventNotEmitted(bus, userCreated)).toThrow(
      new ExpectationError(
        [
          'Expected no event "user.created" emitted, found 1.',
          'Emitted events:',
          '  - user.created {"userId":"42","email":"ada@example.com"}',
        ].join('\n')
      )
    )
    expect(() =>
      expectEventNotEmitted(bus, userCreated, { userId: '42' })
    ).toThrow(
      'Expected no event "user.created" emitted with payload {"userId":"42"}, found 1.'
    )
    expect(() => expectEventNotEmitted(bus, '')).toThrow(
      'expectEventNotEmitted(): expected an event created by defineEvent(), or its name.'
    )
  })
})

const ada = { name: 'Ada Lovelace', address: 'ada@example.com' }
const mail = (overrides: Partial<SentMail> & Record<string, unknown> = {}) => ({
  from: { address: 'noreply@example.com' },
  to: [ada],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Welcome Ada',
  html: '<p>Hello</p>',
  text: 'Hello',
  tags: ['welcome'],
  metadata: { userId: '42' },
  headers: {},
  attachments: [],
  template: 'welcome',
  locale: 'en',
  ...overrides,
})

describe('expectMailSent()', () => {
  const outbox = {
    sent: [
      mail(),
      mail({
        to: [
          { address: 'grace@example.com' },
          { address: 'Linus@Example.com' },
        ],
        cc: [{ address: 'team@example.com' }],
        bcc: [{ address: 'archive@example.com' }],
        replyTo: [{ address: 'support@example.com' }],
        from: { name: 'Acme', address: 'hello@example.com' },
        subject: 'Your invoice',
        template: 'invoice',
        locale: 'fr',
        tags: ['billing'],
      }),
      mail({ subject: 'Welcome back Ada' }),
    ],
  }

  it('finds a message, and returns the last matching one', () => {
    expect(expectMailSent(outbox)).toBe(outbox.sent[2])
    expect(expectMailSent(outbox, { to: 'ada@example.com' })).toBe(
      outbox.sent[2]
    )
    expect(expectMailSent(outbox, { subject: 'Welcome Ada' })).toBe(
      outbox.sent[0]
    )
    expect(expectMailSent(outbox, {}, { times: 3 })).toBe(outbox.sent[2])
  })

  it('compares recipients by address, in any case', () => {
    expectMailSent(
      outbox,
      { to: 'ADA@example.com ', template: 'welcome' },
      { times: 2 }
    )
    expectMailSent(outbox, {
      to: ['linus@example.com', 'grace@example.com'],
      cc: 'team@example.com',
      bcc: ['archive@example.com'],
      replyTo: 'support@example.com',
      from: 'Hello@example.com',
    })
    expect(() =>
      expectMailSent(outbox, { to: ['grace@example.com', 'ada@example.com'] })
    ).toThrow(ExpectationError)
    expect(() => expectMailSent(outbox, { cc: 'ada@example.com' })).toThrow(
      ExpectationError
    )
    expect(() => expectMailSent(outbox, { bcc: 'team@example.com' })).toThrow(
      ExpectationError
    )
    expect(() =>
      expectMailSent(outbox, { replyTo: 'team@example.com' })
    ).toThrow(ExpectationError)
    expect(() => expectMailSent(outbox, { from: 'acme@example.com' })).toThrow(
      ExpectationError
    )
  })

  it('matches the template by name or definition', () => {
    expectMailSent(outbox, { template: { name: 'invoice' } })
    expect(() =>
      expectMailSent(outbox, { template: 'reset-password' })
    ).toThrow(ExpectationError)
  })

  it('matches the other properties like toMatchObject()', () => {
    expectMailSent(outbox, {
      subject: expect.stringContaining('invoice'),
      locale: 'fr',
      tags: ['billing'],
      metadata: { userId: '42' },
      html: expect.stringContaining('Hello'),
      text: 'Hello',
      headers: {},
      attachments: [],
    })
    expect(() => expectMailSent(outbox, { locale: 'de' })).toThrow(
      ExpectationError
    )
    expect(() => expectMailSent(outbox, { tags: ['other'] })).toThrow(
      ExpectationError
    )
    expect(() =>
      expectMailSent(outbox, { metadata: { userId: '43' } })
    ).toThrow(ExpectationError)
    expect(() => expectMailSent(outbox, { html: '<p>Hello' })).toThrow(
      ExpectationError
    )
    expect(() =>
      expectMailSent(outbox, { subject: 'Welcome Ada', template: 'invoice' })
    ).toThrow(ExpectationError)
  })

  it('explains what was sent', () => {
    expect(() =>
      expectMailSent(outbox, { to: 'zoe@example.com', template: 'welcome' })
    ).toThrow(
      new ExpectationError(
        [
          'Expected a message {"to":"zoe@example.com","template":"welcome"} sent, found 0.',
          'Sent messages:',
          '  - to ada@example.com: "Welcome Ada" (template welcome)',
          '  - to grace@example.com, Linus@Example.com: "Your invoice" (template invoice)',
          '  - to ada@example.com: "Welcome back Ada" (template welcome)',
        ].join('\n')
      )
    )
    expect(() => expectMailSent({ sent: [] })).toThrow(
      new ExpectationError(
        'Expected a message sent, found 0.\nNo message was sent.'
      )
    )
    expect(() =>
      expectMailSent(
        { sent: [mail({ template: undefined })] },
        { subject: 'x' }
      )
    ).toThrow('  - to ada@example.com: "Welcome Ada"\n'.trimEnd())
    expect(() =>
      expectMailSent(outbox, { template: 'welcome' }, { times: 1 })
    ).toThrow('Expected a message {"template":"welcome"} sent once, found 2.')
    expect(() =>
      expectMailSent(outbox, { template: 'welcome' }, { times: 3 })
    ).toThrow(
      'Expected a message {"template":"welcome"} sent 3 times, found 2.'
    )
  })

  it('checks its arguments', () => {
    const label = 'expectMailSent()'
    for (const target of [null, {}, { sent: 'x' }]) {
      expect(() => expectMailSent(target as never)).toThrow(
        `${label}: expected the memory provider of the mailer (createMemoryProvider()).`
      )
    }
    expect(() => expectMailSent(outbox, null as never)).toThrow(
      `${label}: expected an object of criteria.`
    )
    expect(() => expectMailSent(outbox, 'ada@example.com' as never)).toThrow(
      `${label}: expected an object of criteria.`
    )
    expect(() => expectMailSent(outbox, { recipient: 'x' } as never)).toThrow(
      `${label}: unknown criterion "recipient".`
    )
    for (const to of ['', ' ', [], [''], [42], 42]) {
      expect(() => expectMailSent(outbox, { to } as never)).toThrow(
        `${label}: to must be an email address, or a non-empty array of them.`
      )
    }
    expect(() => expectMailSent(outbox, { cc: [] })).toThrow(
      `${label}: cc must be an email address`
    )
    for (const from of ['', 42]) {
      expect(() => expectMailSent(outbox, { from } as never)).toThrow(
        `${label}: from must be an email address.`
      )
    }
    for (const template of [42, {}, null]) {
      expect(() => expectMailSent(outbox, { template } as never)).toThrow(
        `${label}: template must be a template, or its name.`
      )
    }
    expect(() => expectMailSent(outbox, {}, 'twice' as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(() => expectMailSent(outbox, {}, null as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(() => expectMailSent(outbox, {}, { count: 1 } as never)).toThrow(
      `${label}: unknown option "count".`
    )
    expect(() => expectMailSent(outbox, {}, { times: -1 })).toThrow(
      `${label}: times must be a non-negative integer.`
    )
    expect(() => expectMailSent(outbox, {}, { times: 0 })).toThrow(
      `${label}: times must be at least 1 (use expectNoMailSent()).`
    )
    expectMailSent(outbox, { to: undefined, subject: undefined })
  })
})

describe('expectNoMailSent()', () => {
  it('passes when no message matches', () => {
    expectNoMailSent({ sent: [] })
    expectNoMailSent({ sent: [mail()] }, { to: 'grace@example.com' })
  })

  it('fails when a message matches', () => {
    expect(() => expectNoMailSent({ sent: [mail()] })).toThrow(
      new ExpectationError(
        [
          'Expected no message sent, found 1.',
          'Sent messages:',
          '  - to ada@example.com: "Welcome Ada" (template welcome)',
        ].join('\n')
      )
    )
    expect(() =>
      expectNoMailSent({ sent: [] }, { subjet: 'x' } as never)
    ).toThrow('expectNoMailSent(): unknown criterion "subjet".')
    expect(() => expectNoMailSent(null as never)).toThrow(
      'expectNoMailSent(): expected the memory provider'
    )
  })
})
