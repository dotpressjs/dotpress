import type {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from '@azure/service-bus'
import type { Envelope } from '../envelope.js'
import { PartialSendError } from '../errors.js'
import type { Source, Transport } from '../transport.js'
import type { HandleResult, Worker } from '../worker.js'

/** Connection to a namespace: a client, or a connection string. */
export type ServiceBusConnection =
  | {
      /** A client created by you (Microsoft Entra ID credentials…). */
      client: ServiceBusClient
      connectionString?: never
    }
  | {
      /** Connection string of the namespace, or of the queue. */
      connectionString: string
      client?: never
    }

/** Options of `createServiceBusTransport()`. */
export type ServiceBusTransportOptions = ServiceBusConnection & {
  /** Name of the queue. */
  queue: string
}

/** Options of `createServiceBusSource()`. */
export type ServiceBusSourceOptions = ServiceBusConnection & {
  /** Name of the queue. */
  queue: string
  /** Messages handled at the same time. Defaults to 1. */
  maxConcurrentCalls?: number | undefined
  /**
   * How long the lock of a message in progress is renewed, in
   * milliseconds. Defaults to 5 minutes (the default of the SDK).
   */
  maxAutoLockRenewalDurationInMs?: number | undefined
  /**
   * On stop, how long to wait for the messages in progress, in
   * milliseconds. Defaults to 30 seconds.
   */
  closeTimeout?: number | undefined
}

/** Options of `createServiceBusFunctionHandler()`. */
export interface ServiceBusFunctionHandlerOptions {
  /**
   * Queue where messages that can never be handled are sent at once,
   * instead of failing until `maxDeliveryCount`.
   */
  deadLetter?: ServiceBusTransportOptions | undefined
}

/** Service Bus transport: close it to close the client it created. */
export interface ServiceBusTransport extends Transport {
  /** Closes the sender, and the client if the transport created it. */
  close(): Promise<void>
}

/** Invocation context of Azure Functions (the fields used here). */
export interface ServiceBusInvocationContext {
  triggerMetadata?: Record<string, unknown> | undefined
}

// Dead-letter descriptions are kept short: they are message properties.
const MAX_DESCRIPTION = 1024
// Batches: 256 KB in the Standard tier, 1 MB in the Premium tier.
const MAX_BATCH_BYTES = 1_048_576

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkOptions = (
  label: string,
  options: unknown,
  allowed: readonly string[]
): Record<string, unknown> => {
  if (!isRecord(options)) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  return options
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** The client of the options, created on first use when not given. */
const connectionOf = (label: string, values: Record<string, unknown>) => {
  const { client, connectionString, queue } = values
  if ((client === undefined) === (connectionString === undefined)) {
    throw new TypeError(`${label}: set client or connectionString.`)
  }
  if (
    client !== undefined &&
    typeof (client as ServiceBusClient | null)?.createSender !== 'function'
  ) {
    throw new TypeError(`${label}: client must be a ServiceBusClient.`)
  }
  if (
    connectionString !== undefined &&
    (typeof connectionString !== 'string' || connectionString === '')
  ) {
    throw new TypeError(
      `${label}: connectionString must be a non-empty string.`
    )
  }
  if (typeof queue !== 'string' || queue === '') {
    throw new TypeError(`${label}: queue must be a non-empty string.`)
  }

  let created: Promise<ServiceBusClient> | undefined
  return {
    queue,
    owned: client === undefined,
    client: (): Promise<ServiceBusClient> =>
      client !== undefined
        ? Promise.resolve(client as ServiceBusClient)
        : (created ??= import('@azure/service-bus').then(
            ({ ServiceBusClient: Client }) =>
              new Client(connectionString as string),
            (error: unknown) => {
              created = undefined
              throw new Error(
                'Install @azure/service-bus to use Azure Service Bus.',
                { cause: error }
              )
            }
          )),
    /** Closes the client, if created here. */
    close: async () => {
      await (await created)?.close()
    },
  }
}

/** Sends envelopes in batches: a sender of the queue, created once. */
const senderOf = (label: string, values: Record<string, unknown>) => {
  const connection = connectionOf(label, values)
  let sender: Promise<ServiceBusSender> | undefined
  const senderOnce = () =>
    (sender ??= connection
      .client()
      .then((client) => client.createSender(connection.queue))
      .catch((error: unknown) => {
        sender = undefined
        throw error
      }))

  const send = async (
    messages: { id: string; message: ServiceBusMessage }[]
  ) => {
    const failed: { id: string; error: unknown }[] = []
    const attempt = async (ids: string[], sending: () => Promise<void>) => {
      try {
        await sending()
      } catch (error) {
        for (const id of ids) failed.push({ id, error })
      }
    }
    const output = await senderOnce()
    let batch = await output.createMessageBatch()
    // Largest message of the queue: Premium queues accept more than a batch.
    const maxMessageSize = batch.maxSizeInBytes
    const options =
      maxMessageSize > MAX_BATCH_BYTES
        ? { maxSizeInBytes: MAX_BATCH_BYTES }
        : undefined
    if (options) batch = await output.createMessageBatch(options)
    let ids: string[] = []

    for (const { id, message } of messages) {
      if (batch.tryAddMessage(message)) {
        ids.push(id)
        continue
      }
      if (ids.length > 0) {
        const full = batch
        await attempt(ids, () => output.sendMessages(full))
        batch = await output.createMessageBatch(options)
        ids = []
        if (batch.tryAddMessage(message)) {
          ids.push(id)
          continue
        }
      }
      if (maxMessageSize > batch.maxSizeInBytes) {
        // Larger than a batch: sent alone.
        await attempt([id], () => output.sendMessages(message))
      } else {
        failed.push({
          id,
          error: new RangeError(
            `Service Bus accepts messages of at most ${maxMessageSize} bytes on this queue (256 KB in the Standard tier).`
          ),
        })
      }
    }
    if (ids.length > 0) {
      const last = batch
      await attempt(ids, () => output.sendMessages(last))
    }
    return failed
  }

  return {
    send,
    close: async () => {
      await (await sender)?.close()
      await connection.close()
    },
  }
}

const messageOf = (
  envelope: Envelope,
  delay: number | undefined
): ServiceBusMessage => ({
  body: envelope,
  contentType: 'application/json',
  messageId: envelope.id,
  subject: envelope.event,
  applicationProperties: { event: envelope.event, listener: envelope.listener },
  ...(delay
    ? { scheduledEnqueueTimeUtc: new Date(Date.now() + delay * 1000) }
    : {}),
})

/**
 * Creates a transport that sends messages to an Azure Service Bus queue
 * (`@azure/service-bus`, peer dependency; Node.js). The message id is the
 * id of the envelope: with duplicate detection on the queue, emitting again
 * is ignored.
 *
 * ```ts
 * const transport = createServiceBusTransport({
 *   connectionString: process.env.SERVICE_BUS_CONNECTION!,
 *   queue: 'events',
 * })
 * ```
 */
export const createServiceBusTransport = (
  options: ServiceBusTransportOptions
): ServiceBusTransport => {
  const label = 'createServiceBusTransport()'
  const values = checkOptions(label, options, [
    'client',
    'connectionString',
    'queue',
  ])
  const sender = senderOf(label, values)

  return {
    kind: 'azure-service-bus',
    send: async (envelopes, { delay }) => {
      const failed = await sender.send(
        envelopes.map((envelope) => ({
          id: envelope.id,
          message: messageOf(envelope, delay),
        }))
      )
      if (failed.length > 0) throw new PartialSendError(failed)
    },
    close: sender.close,
  }
}

const deadLetterProperties = (result: HandleResult & { status: 'dead' }) => ({
  deadLetterReason: result.reason,
  deadLetterErrorDescription: describe(result.error).slice(0, MAX_DESCRIPTION),
})

/**
 * Creates a source that receives the messages of a queue, for
 * `startWorker()` and `dotpress-events work` (Node.js). Handled messages
 * are completed, failed ones abandoned (delivered again until the
 * `maxDeliveryCount` of the queue), and messages that can never be handled
 * moved to the dead-letter queue at once.
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners, maxAttempts: 10 }),
 *   source: createServiceBusSource({ connectionString, queue: 'events' }),
 * }
 * ```
 */
export const createServiceBusSource = (
  options: ServiceBusSourceOptions
): Source => {
  const label = 'createServiceBusSource()'
  const values = checkOptions(label, options, [
    'client',
    'connectionString',
    'queue',
    'maxConcurrentCalls',
    'maxAutoLockRenewalDurationInMs',
    'closeTimeout',
  ])
  const connection = connectionOf(label, values)
  const {
    maxConcurrentCalls = 1,
    maxAutoLockRenewalDurationInMs,
    closeTimeout = 30_000,
  } = values
  if (
    !Number.isInteger(maxConcurrentCalls) ||
    (maxConcurrentCalls as number) < 1
  ) {
    throw new TypeError(
      `${label}: maxConcurrentCalls must be a positive integer.`
    )
  }
  if (
    maxAutoLockRenewalDurationInMs !== undefined &&
    (!Number.isInteger(maxAutoLockRenewalDurationInMs) ||
      (maxAutoLockRenewalDurationInMs as number) < 0)
  ) {
    throw new TypeError(
      `${label}: maxAutoLockRenewalDurationInMs must be a non-negative integer (milliseconds).`
    )
  }
  if (!Number.isInteger(closeTimeout) || (closeTimeout as number) < 0) {
    throw new TypeError(
      `${label}: closeTimeout must be a non-negative integer (milliseconds).`
    )
  }

  return {
    kind: 'azure-service-bus',
    consume: async (worker, { signal, logger }) => {
      const client = await connection.client()
      const receiver = client.createReceiver(connection.queue, {
        receiveMode: 'peekLock',
        ...(maxAutoLockRenewalDurationInMs === undefined
          ? {}
          : {
              maxAutoLockRenewalDurationInMs:
                maxAutoLockRenewalDurationInMs as number,
            }),
      })
      const inProgress = new Set<Promise<void>>()

      const settle = async (message: ServiceBusReceivedMessage) => {
        const result = await worker.handle(message.body, {
          // The SDK counts the deliveries before this one.
          attempt: (message.deliveryCount ?? 0) + 1,
        })
        if (result.status === 'success') {
          await receiver.completeMessage(message)
        } else if (result.status === 'dead') {
          await receiver.deadLetterMessage(
            message,
            deadLetterProperties(result)
          )
        } else {
          await receiver.abandonMessage(message)
        }
      }

      const subscription = receiver.subscribe(
        {
          processMessage: async (message) => {
            const handling = settle(message)
            inProgress.add(handling)
            try {
              await handling
            } finally {
              inProgress.delete(handling)
            }
          },
          processError: async ({ error, errorSource }) => {
            logger.error(
              {
                queue: connection.queue,
                source: errorSource,
                error: error.message,
              },
              'Service Bus receiver error'
            )
          },
        },
        {
          autoCompleteMessages: false,
          maxConcurrentCalls: maxConcurrentCalls as number,
        }
      )

      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      // Stop receiving, then let the messages in progress settle.
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopped = await Promise.race([
        (async () => {
          await subscription.close()
          await Promise.allSettled([...inProgress])
          return true
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), closeTimeout as number)
        }),
      ])
      clearTimeout(timer)
      if (!stopped) {
        logger.warn(
          { queue: connection.queue, closeTimeout },
          'Service Bus receiver not closed in time: stopped without waiting'
        )
      }
      await receiver.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
    },
  }
}

/**
 * Creates the handler of an Azure Functions Service Bus trigger (one
 * message per invocation). A failure throws, so that the message is
 * delivered again until the `maxDeliveryCount` of the queue.
 *
 * ```ts
 * app.serviceBusQueue('events', {
 *   connection: 'SERVICE_BUS_CONNECTION',
 *   queueName: 'events',
 *   handler: createServiceBusFunctionHandler(createWorker({ listeners, maxAttempts: 10 })),
 * })
 * ```
 */
export const createServiceBusFunctionHandler = (
  worker: Worker,
  options: ServiceBusFunctionHandlerOptions = {}
): ((
  message: unknown,
  context?: ServiceBusInvocationContext
) => Promise<void>) => {
  const label = 'createServiceBusFunctionHandler()'
  if (typeof worker?.handle !== 'function') {
    throw new TypeError(
      `${label}: expected a worker created by createWorker().`
    )
  }
  const { deadLetter } = checkOptions(label, options, ['deadLetter'])
  const deadSender =
    deadLetter === undefined
      ? undefined
      : senderOf(
          `${label}: deadLetter`,
          checkOptions(`${label}: deadLetter`, deadLetter, [
            'client',
            'connectionString',
            'queue',
          ])
        )

  return async (message, context) => {
    if (Array.isArray(message)) {
      throw new TypeError(
        `${label}: expected one message per invocation (cardinality "one").`
      )
    }
    const deliveryCount = context?.triggerMetadata?.deliveryCount
    const result = await worker.handle(message, {
      attempt: typeof deliveryCount === 'number' ? deliveryCount : 1,
    })
    if (result.status === 'success') return
    if (result.status === 'dead' && deadSender) {
      const { deadLetterReason, deadLetterErrorDescription } =
        deadLetterProperties(result)
      const failed = await deadSender.send([
        {
          id: '',
          message: {
            body: message,
            contentType: 'application/json',
            applicationProperties: {
              reason: deadLetterReason,
              error: deadLetterErrorDescription,
            },
          },
        },
      ])
      if (failed.length === 0) return
      throw new Error('Cannot send the message to the dead-letter queue.', {
        cause: failed[0]?.error,
      })
    }
    throw result.error instanceof Error
      ? result.error
      : new Error(describe(result.error))
  }
}
