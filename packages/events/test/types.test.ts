import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createEventBus,
  createMemoryTransport,
  defineEvent,
  defineListener,
  type EventInput,
  type EventPayload,
} from '../src/index.js'

declare module '../src/index.js' {
  interface EventTransports {
    edge: true
  }
}

// Type-level tests, checked by `tsc -p tsconfig.test.json`.
describe('types', () => {
  const invoicePaid = defineEvent({
    name: 'invoice.paid',
    schema: z.object({
      invoiceId: z.string(),
      paidAt: z.iso.datetime().transform((value) => new Date(value)),
    }),
  })

  it('types the payload of emit() and of the listeners', () => {
    expectTypeOf<EventInput<typeof invoicePaid>>().toEqualTypeOf<{
      invoiceId: string
      paidAt: string
    }>()
    expectTypeOf<EventPayload<typeof invoicePaid>>().toEqualTypeOf<{
      invoiceId: string
      paidAt: Date
    }>()

    const listener = defineListener(invoicePaid, {
      name: 'record',
      handle: ({ payload }) => {
        expectTypeOf(payload.paidAt).toEqualTypeOf<Date>()
      },
    })
    const events = createEventBus({
      transport: createMemoryTransport(),
      listeners: [listener],
    })

    void (async () => {
      await events.emit(invoicePaid, {
        invoiceId: 'F-1',
        paidAt: '2026-11-10T10:00:00Z',
      })
      // @ts-expect-error: paidAt is a string before parsing
      await events.emit(invoicePaid, { invoiceId: 'F-1', paidAt: new Date() })
      // @ts-expect-error: missing field
      await events.emit(invoicePaid, { invoiceId: 'F-1' })
    })
  })

  it('types lazy listeners', () => {
    defineListener(invoicePaid, {
      name: 'lazy',
      load: async () => ({
        default: ({ payload }) => {
          expectTypeOf(payload.invoiceId).toEqualTypeOf<string>()
        },
      }),
    })
    void (() => {
      // @ts-expect-error: handle and load are exclusive
      defineListener(invoicePaid, {
        name: 'both',
        handle: () => {},
        load: async () => ({ default: () => {} }),
      })
      // @ts-expect-error: a handler is required
      defineListener(invoicePaid, { name: 'none' })
    })
  })

  it('types the transport names', () => {
    defineEvent({ name: 'a', schema: z.object({}), transport: 'edge' })
    defineEvent({ name: 'b', schema: z.object({}), transport: 'default' })
    createEventBus({
      transports: {
        default: createMemoryTransport(),
        edge: createMemoryTransport(),
      },
      listeners: [],
    })
    void (() => {
      // @ts-expect-error: unknown transport
      defineEvent({ name: 'c', schema: z.object({}), transport: 'egde' })
      createEventBus({
        // @ts-expect-error: unknown transport
        transports: { sqs: createMemoryTransport() },
        listeners: [],
      })
    })
  })
})
