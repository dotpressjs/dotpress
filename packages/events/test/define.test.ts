import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEvent, defineListener } from '../src/index.js'
import { userCreated } from './support.js'

const handle = () => undefined

describe('defineEvent()', () => {
  it('returns a frozen event', () => {
    const schema = z.object({ id: z.string() })
    const event = defineEvent({ name: 'user.created', schema })
    expect(event).toEqual({
      name: 'user.created',
      schema,
      transport: undefined,
    })
    expect(Object.isFrozen(event)).toBe(true)
    expect(
      defineEvent({ name: 'a', schema, transport: 'edge' as never }).transport
    ).toBe('edge')
  })

  it.each(['a', 'user.created', 'Billing:invoice_paid-v2', 'x'.repeat(128)])(
    'accepts the name %s',
    (name) => {
      expect(defineEvent({ name, schema: z.object({}) }).name).toBe(name)
    }
  )

  it.each([
    ['not an object', null, 'defineEvent(): expected an object.'],
    [
      'an unknown option',
      { name: 'a', schema: z.object({}), listeners: [] },
      'defineEvent("a"): unknown option "listeners".',
    ],
    [
      'no name',
      { schema: z.object({}) },
      'defineEvent(): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.',
    ],
    [
      'a name with a space',
      { name: 'user created', schema: z.object({}) },
      'defineEvent("user created"): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.',
    ],
    [
      'a name starting with a dot',
      { name: '.a', schema: z.object({}) },
      'defineEvent(".a"): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.',
    ],
    [
      'a long name',
      { name: 'x'.repeat(129), schema: z.object({}) },
      `defineEvent("${'x'.repeat(129)}"): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.`,
    ],
    [
      'no schema',
      { name: 'a' },
      'defineEvent("a"): schema must be a Zod schema.',
    ],
    [
      'a schema without safeParseAsync()',
      { name: 'a', schema: { parse: () => ({}) } },
      'defineEvent("a"): schema must be a Zod schema.',
    ],
    [
      'an empty transport',
      { name: 'a', schema: z.object({}), transport: '' },
      'defineEvent("a"): transport must be a non-empty string.',
    ],
    [
      'a transport that is not a string',
      { name: 'a', schema: z.object({}), transport: 1 },
      'defineEvent("a"): transport must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => defineEvent(options as never)).toThrow(new TypeError(message))
  })
})

describe('defineListener()', () => {
  it('returns a frozen listener', () => {
    const listener = defineListener(userCreated, {
      name: 'send-welcome-mail',
      handle,
    })
    expect(listener).toEqual({
      name: 'send-welcome-mail',
      event: userCreated,
      transport: undefined,
    })
    expect(Object.isFrozen(listener)).toBe(true)
    expect(
      defineListener(userCreated, {
        name: 'b',
        transport: 'edge' as never,
        load: async () => ({ default: handle }),
      }).transport
    ).toBe('edge')
  })

  it.each([
    [
      'an event not created by defineEvent()',
      { name: 'a' },
      { name: 'a', handle },
      'defineListener("a"): expected an event created by defineEvent().',
    ],
    [
      'options that are not an object',
      userCreated,
      'a',
      'defineListener(): expected an object.',
    ],
    [
      'an unknown option',
      userCreated,
      { name: 'a', handle, retries: 3 },
      'defineListener("a"): unknown option "retries".',
    ],
    [
      'an invalid name',
      userCreated,
      { name: 'send mail', handle },
      'defineListener("send mail"): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.',
    ],
    [
      'no handler',
      userCreated,
      { name: 'a' },
      'defineListener("a"): set exactly one of handle and load.',
    ],
    [
      'handle and load',
      userCreated,
      { name: 'a', handle, load: handle },
      'defineListener("a"): set exactly one of handle and load.',
    ],
    [
      'a handle that is not a function',
      userCreated,
      { name: 'a', handle: 'x' },
      'defineListener("a"): handle must be a function.',
    ],
    [
      'a load that is not a function',
      userCreated,
      { name: 'a', load: {} },
      'defineListener("a"): load must be a function.',
    ],
    [
      'an invalid transport',
      userCreated,
      { name: 'a', handle, transport: '' },
      'defineListener("a"): transport must be a non-empty string.',
    ],
  ])('rejects %s', (_, event, options, message) => {
    expect(() => defineListener(event as never, options as never)).toThrow(
      new TypeError(message)
    )
  })
})
