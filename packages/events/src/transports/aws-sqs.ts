import { retryDelayOf, toSeconds, type Duration } from '../duration.js'
import { queueUrlOf } from './aws-sqs-internal.js'
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
  type MessageAttributeValue,
  type SQSClientConfig,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs'
import type { Envelope } from '../envelope.js'
import { PartialSendError } from '../errors.js'
import { checkLogger, consoleLogger, type EventsLogger } from '../logger.js'
import type { Source, Transport } from '../transport.js'
import type { HandleResult, Worker } from '../worker.js'

/** An SQS client, or any object with the same `send()` method. */
export interface SqsClient {
  send(
    command: object,
    options?: { abortSignal?: AbortSignal }
  ): Promise<unknown>
}

/** Client options shared by the transport, the handler and the source. */
export interface SqsClientOptions {
  /** Existing client. Defaults to a client created with `clientConfig`. */
  client?: SqsClient | undefined
  /** Configuration of the created client: `region`, `credentials`… */
  clientConfig?: SQSClientConfig | undefined
}

/** Options of `createSqsTransport()`. */
export interface SqsTransportOptions extends SqsClientOptions {
  /** URL of the queue. A `.fifo` URL makes a FIFO queue. */
  queueUrl: string
  /**
   * FIFO queues: message group of a message, ordered within its group.
   * Defaults to the listener: messages of a listener are handled in order.
   */
  messageGroupId?: ((envelope: Envelope) => string) | undefined
}

/** How failed messages are handled, by the Lambda handler and the source. */
export interface SqsFailureOptions extends SqsClientOptions {
  /**
   * URL of the dead-letter queue of the queue: messages that can never be
   * handled (invalid payload, unknown listener) are copied there at once,
   * instead of failing until the `maxReceiveCount` of the queue.
   */
  deadLetter?: string | undefined
  /**
   * Delay before a failed message is delivered again, given its attempt
   * number: a number of seconds, or a duration like `'30s'`, rounded up to
   * the second. Defaults to the visibility timeout of the queue.
   */
  retryDelay?: ((attempt: number) => Duration) | undefined
  logger?: EventsLogger | undefined
}

/** Options of `createSqsHandler()`. */
export interface SqsHandlerOptions extends SqsFailureOptions {
  /**
   * URL of the queue, for `retryDelay`. Defaults to the URL derived from
   * the ARN of the records.
   */
  queueUrl?: string | undefined
}

/** Options of `createSqsSource()`. */
export interface SqsSourceOptions extends SqsFailureOptions {
  queueUrl: string
  /** Long polling, from 0 to 20 seconds. Defaults to 20 seconds. */
  waitTime?: Duration | undefined
  /**
   * Messages received per request and handled at once (1 to 10). Defaults
   * to 10.
   */
  concurrency?: number | undefined
  /**
   * Visibility timeout of the received messages, rounded up to the second.
   * When set, the source extends it while a message is being handled, so
   * that a long listener is not delivered twice. Defaults to the one of the
   * queue.
   */
  visibilityTimeout?: Duration | undefined
  /**
   * Warns at startup when the queue has no dead-letter queue (redrive
   * policy). Defaults to true; needs `sqs:GetQueueAttributes`.
   */
  checkRedrivePolicy?: boolean | undefined
}

/** Record of an SQS event received by a Lambda function. */
export interface SqsRecord {
  readonly messageId: string
  readonly receiptHandle: string
  readonly body: string
  readonly attributes: { readonly ApproximateReceiveCount?: string }
  readonly eventSourceARN?: string
}

/** SQS event received by a Lambda function. */
export interface SqsEvent {
  readonly Records: readonly SqsRecord[]
}

/** Response of the Lambda handler (`ReportBatchItemFailures`). */
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[]
}

// Limits of SQS.
const MAX_BATCH_ENTRIES = 10
const MAX_MESSAGE_BYTES = 1_048_576
const MAX_DELAY_SECONDS = 900
const MAX_VISIBILITY_SECONDS = 43_200
const MAX_WAIT_SECONDS = 20

const encoder = new TextEncoder()
const bytesOf = (text: string) => encoder.encode(text).byteLength

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

const checkUrl = (label: string, key: string, value: unknown) => {
  if (typeof value !== 'string' || !/^https?:\/\/[^/]/.test(value)) {
    throw new TypeError(`${label}: ${key} must be the URL of an SQS queue.`)
  }
  return value
}

const checkInteger = (
  label: string,
  key: string,
  value: unknown,
  min: number,
  max: number
) => {
  if (
    value !== undefined &&
    (!Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max)
  ) {
    throw new TypeError(
      `${label}: ${key} must be an integer from ${min} to ${max}.`
    )
  }
  return value as number | undefined
}

/** A duration option in whole seconds (rounded up), within bounds. */
const checkSeconds = (
  label: string,
  key: string,
  value: unknown,
  min: number,
  max: number
) => {
  if (value === undefined) return undefined
  const seconds = toSeconds(value, `${label}: ${key}`)
  if (seconds < min || seconds > max) {
    throw new TypeError(
      `${label}: ${key} must be from ${min} to ${max} seconds.`
    )
  }
  return seconds
}

const checkFunction = (label: string, key: string, value: unknown) => {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${label}: ${key} must be a function.`)
  }
}

/** Client of the options, created on first use. */
const clientOf = (label: string, values: Record<string, unknown>) => {
  const { client, clientConfig } = values
  if (client !== undefined && clientConfig !== undefined) {
    throw new TypeError(`${label}: set client or clientConfig, not both.`)
  }
  if (
    client !== undefined &&
    typeof (client as SqsClient | null)?.send !== 'function'
  ) {
    throw new TypeError(`${label}: client must have a send() method.`)
  }
  let created: SqsClient | undefined
  return () =>
    (client as SqsClient | undefined) ??
    (created ??= new SQSClient((clientConfig as SQSClientConfig) ?? {}))
}

const attributesOf = (
  envelope: Envelope
): Record<string, MessageAttributeValue> => ({
  event: { DataType: 'String', StringValue: envelope.event },
  listener: { DataType: 'String', StringValue: envelope.listener },
})

/** Size of a message for SQS: body and attributes. */
const sizeOf = (
  body: string,
  attributes: Record<string, MessageAttributeValue>
) =>
  Object.entries(attributes).reduce(
    (total, [name, { DataType = '', StringValue = '' }]) =>
      total + bytesOf(name) + bytesOf(DataType) + bytesOf(StringValue),
    bytesOf(body)
  )

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Creates a transport that sends messages to an Amazon SQS queue, through
 * the AWS SDK (`@aws-sdk/client-sqs`, peer dependency). Messages are sent
 * in batches of 10; each one carries `event` and `listener` attributes.
 *
 * ```ts
 * const transport = createSqsTransport({ queueUrl: process.env.EVENTS_QUEUE_URL! })
 * ```
 */
export const createSqsTransport = (options: SqsTransportOptions): Transport => {
  const label = 'createSqsTransport()'
  const values = checkOptions(label, options, [
    'queueUrl',
    'client',
    'clientConfig',
    'messageGroupId',
  ])
  const queueUrl = checkUrl(label, 'queueUrl', values.queueUrl)
  checkFunction(label, 'messageGroupId', values.messageGroupId)
  const client = clientOf(label, values)
  const fifo = queueUrl.endsWith('.fifo')
  const groupOf =
    (values.messageGroupId as SqsTransportOptions['messageGroupId']) ??
    ((envelope: Envelope) => envelope.listener)

  return {
    kind: 'aws-sqs',
    send: async (envelopes, { delay, signal }) => {
      if (delay !== undefined && delay > MAX_DELAY_SECONDS) {
        throw new RangeError(
          `SQS accepts delays of at most ${MAX_DELAY_SECONDS} seconds, got ${delay}.`
        )
      }
      if (fifo && delay !== undefined && delay > 0) {
        throw new RangeError(
          'SQS FIFO queues do not accept per-message delays.'
        )
      }

      const failed: { id: string; error: unknown }[] = []
      const batches: {
        entries: SendMessageBatchRequestEntry[]
        size: number
      }[] = []
      for (const envelope of envelopes) {
        const body = JSON.stringify(envelope)
        const attributes = attributesOf(envelope)
        const size = sizeOf(body, attributes)
        if (size > MAX_MESSAGE_BYTES) {
          failed.push({
            id: envelope.id,
            error: new RangeError(
              `SQS accepts messages of at most ${MAX_MESSAGE_BYTES} bytes (attributes included), got ${size}.`
            ),
          })
          continue
        }
        const entry: SendMessageBatchRequestEntry = {
          Id: envelope.id,
          MessageBody: body,
          MessageAttributes: attributes,
          ...(fifo
            ? {
                MessageGroupId: groupOf(envelope),
                // Duplicates of a message are dropped within 5 minutes.
                MessageDeduplicationId: envelope.id,
              }
            : delay === undefined
              ? {}
              : { DelaySeconds: delay }),
        }
        const last = batches.at(-1)
        if (
          last &&
          last.entries.length < MAX_BATCH_ENTRIES &&
          last.size + size <= MAX_MESSAGE_BYTES
        ) {
          last.entries.push(entry)
          last.size += size
        } else {
          batches.push({ entries: [entry], size })
        }
      }

      for (const { entries } of batches) {
        try {
          const result = (await client().send(
            new SendMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: entries,
            }),
            ...(signal ? [{ abortSignal: signal }] : [])
          )) as { Failed?: { Id?: string; Code?: string; Message?: string }[] }
          for (const { Id, Code, Message } of result.Failed ?? []) {
            failed.push({
              id: Id as string,
              error: new Error(`${Code}${Message ? `: ${Message}` : ''}`),
            })
          }
        } catch (error) {
          for (const { Id } of entries) failed.push({ id: Id as string, error })
        }
      }
      if (failed.length > 0) throw new PartialSendError(failed)
    },
  }
}

/** Applies the result of a message: whether to delete it from its queue. */
const settle = async (
  result: HandleResult,
  message: {
    body: string
    receiptHandle: string
    attempt: number
    queueUrl: string | undefined
  },
  context: {
    label: string
    client: () => SqsClient
    deadLetter: string | undefined
    retryDelay: ((attempt: number) => Duration) | undefined
    logger: EventsLogger
  }
): Promise<boolean> => {
  if (result.status === 'success') return true

  if (result.status === 'dead' && context.deadLetter) {
    try {
      await context.client().send(
        new SendMessageCommand({
          QueueUrl: context.deadLetter,
          MessageBody: message.body,
          MessageAttributes: {
            reason: { DataType: 'String', StringValue: result.reason },
            error: {
              DataType: 'String',
              StringValue: describe(result.error).slice(0, 1024),
            },
          },
        })
      )
      return true
    } catch (error) {
      context.logger.error(
        {
          deadLetter: context.deadLetter,
          error: describe(error),
        },
        'Cannot copy the message to the dead-letter queue'
      )
      return false
    }
  }

  if (result.status === 'retry' && context.retryDelay && message.queueUrl) {
    try {
      const delay = Math.min(
        MAX_VISIBILITY_SECONDS,
        Math.ceil(
          retryDelayOf(context.label, context.retryDelay, message.attempt) /
            1000
        )
      )
      await context.client().send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: message.queueUrl,
          ReceiptHandle: message.receiptHandle,
          VisibilityTimeout: delay,
        })
      )
    } catch (error) {
      context.logger.warn(
        { queueUrl: message.queueUrl, error: describe(error) },
        'Cannot delay the retry of the message'
      )
    }
  }
  return false
}

const failureOptions = (label: string, values: Record<string, unknown>) => {
  const deadLetter =
    values.deadLetter === undefined
      ? undefined
      : checkUrl(label, 'deadLetter', values.deadLetter)
  checkFunction(label, 'retryDelay', values.retryDelay)
  return {
    label,
    client: clientOf(label, values),
    deadLetter,
    retryDelay: values.retryDelay as
      ((attempt: number) => Duration) | undefined,
    logger:
      values.logger === undefined
        ? consoleLogger
        : checkLogger(label, values.logger),
  }
}

const FAILURE_OPTIONS = [
  'client',
  'clientConfig',
  'deadLetter',
  'retryDelay',
  'logger',
]

/**
 * Creates the handler of a Lambda function triggered by the SQS queue.
 * Enable `ReportBatchItemFailures` on the event source mapping: only the
 * failed messages are retried.
 *
 * ```ts
 * export const handler = createSqsHandler(createWorker({ listeners }))
 * ```
 */
export const createSqsHandler = (
  worker: Worker,
  options: SqsHandlerOptions = {}
) => {
  const label = 'createSqsHandler()'
  if (typeof worker?.handle !== 'function') {
    throw new TypeError(
      `${label}: expected a worker created by createWorker().`
    )
  }
  const values = checkOptions(label, options, [...FAILURE_OPTIONS, 'queueUrl'])
  const queueUrl =
    values.queueUrl === undefined
      ? undefined
      : checkUrl(label, 'queueUrl', values.queueUrl)
  const context = failureOptions(label, values)

  const handleRecord = async (record: SqsRecord) => {
    const attempt = Number(record.attributes?.ApproximateReceiveCount) || 1
    const result = await worker.handle(record.body, { attempt })
    return settle(
      result,
      {
        body: record.body,
        receiptHandle: record.receiptHandle,
        attempt,
        queueUrl:
          queueUrl ??
          (record.eventSourceARN
            ? queueUrlOf(record.eventSourceARN)
            : undefined),
      },
      context
    )
  }

  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const records = event?.Records ?? []
    const failures: { itemIdentifier: string }[] = []
    const fifo = records.some(({ eventSourceARN }) =>
      eventSourceARN?.endsWith('.fifo')
    )
    if (fifo) {
      // Order matters: stop at the first failure, retry the rest.
      for (const [index, record] of records.entries()) {
        if (!(await handleRecord(record))) {
          for (const rest of records.slice(index)) {
            failures.push({ itemIdentifier: rest.messageId })
          }
          break
        }
      }
    } else {
      const deleted = await Promise.all(records.map(handleRecord))
      records.forEach(({ messageId }, index) => {
        if (!deleted[index]) failures.push({ itemIdentifier: messageId })
      })
    }
    return { batchItemFailures: failures }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

interface ReceivedMessage {
  Body?: string
  ReceiptHandle?: string
  Attributes?: Record<string, string>
}

/**
 * Creates a source that reads the SQS queue by long polling, for
 * `startWorker()` and `dotpress-events work`: a container, a VM, or your
 * machine reading a development queue.
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners }),
 *   source: createSqsSource({ queueUrl: process.env.EVENTS_QUEUE_URL! }),
 * }
 * ```
 */
export const createSqsSource = (options: SqsSourceOptions): Source => {
  const label = 'createSqsSource()'
  const values = checkOptions(label, options, [
    ...FAILURE_OPTIONS,
    'queueUrl',
    'waitTime',
    'concurrency',
    'visibilityTimeout',
    'checkRedrivePolicy',
  ])
  const queueUrl = checkUrl(label, 'queueUrl', values.queueUrl)
  const waitTimeSeconds =
    checkSeconds(label, 'waitTime', values.waitTime, 0, MAX_WAIT_SECONDS) ??
    MAX_WAIT_SECONDS
  const batchSize =
    checkInteger(
      label,
      'concurrency',
      values.concurrency,
      1,
      MAX_BATCH_ENTRIES
    ) ?? MAX_BATCH_ENTRIES
  const visibilityTimeout = checkSeconds(
    label,
    'visibilityTimeout',
    values.visibilityTimeout,
    1,
    MAX_VISIBILITY_SECONDS
  )
  if (
    values.checkRedrivePolicy !== undefined &&
    typeof values.checkRedrivePolicy !== 'boolean'
  ) {
    throw new TypeError(`${label}: checkRedrivePolicy must be a boolean.`)
  }
  const failure = failureOptions(label, values)
  const { client } = failure

  return {
    kind: 'aws-sqs',
    consume: async (worker, { signal, logger }) => {
      const context = {
        ...failure,
        logger: values.logger ? failure.logger : logger,
      }

      if (values.checkRedrivePolicy !== false) {
        try {
          const result = (await client().send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['RedrivePolicy'],
            })
          )) as { Attributes?: Record<string, string> }
          if (!result.Attributes?.RedrivePolicy) {
            context.logger.warn(
              { queueUrl },
              'The SQS queue has no dead-letter queue: failed messages are retried until they expire'
            )
          }
        } catch (error) {
          context.logger.warn(
            { queueUrl, error: describe(error) },
            'Cannot read the redrive policy of the SQS queue'
          )
        }
      }

      const handleMessage = async (message: ReceivedMessage) => {
        const attempt = Number(message.Attributes?.ApproximateReceiveCount) || 1
        const receiptHandle = message.ReceiptHandle as string
        // Keeps the message invisible while its listener runs.
        const heartbeat =
          visibilityTimeout === undefined
            ? undefined
            : setInterval(
                () => {
                  client()
                    .send(
                      new ChangeMessageVisibilityCommand({
                        QueueUrl: queueUrl,
                        ReceiptHandle: receiptHandle,
                        VisibilityTimeout: visibilityTimeout,
                      })
                    )
                    .catch((error: unknown) => {
                      context.logger.warn(
                        { queueUrl, error: describe(error) },
                        'Cannot extend the visibility of the message'
                      )
                    })
                },
                (visibilityTimeout * 1000) / 2
              )
        try {
          const result = await worker.handle(message.Body ?? '', { attempt })
          return await settle(
            result,
            { body: message.Body ?? '', receiptHandle, attempt, queueUrl },
            context
          )
        } finally {
          clearInterval(heartbeat)
        }
      }

      let errorDelay = 0
      while (!signal.aborted) {
        let messages: ReceivedMessage[]
        try {
          const result = (await client().send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: batchSize,
              WaitTimeSeconds: waitTimeSeconds,
              MessageSystemAttributeNames: ['ApproximateReceiveCount'],
              ...(visibilityTimeout === undefined
                ? {}
                : { VisibilityTimeout: visibilityTimeout }),
            }),
            { abortSignal: signal }
          )) as { Messages?: ReceivedMessage[] }
          messages = result.Messages ?? []
          errorDelay = 0
        } catch (error) {
          if (signal.aborted) break
          errorDelay = Math.min(30_000, Math.max(1000, errorDelay * 2))
          context.logger.error(
            { queueUrl, error: describe(error), retryInMs: errorDelay },
            'Cannot receive SQS messages'
          )
          await sleep(errorDelay, signal)
          continue
        }

        const deleted = await Promise.all(messages.map(handleMessage))
        const entries = messages
          .filter((_, index) => deleted[index])
          .map(({ ReceiptHandle }, index) => ({
            Id: String(index),
            ReceiptHandle: ReceiptHandle as string,
          }))
        if (entries.length === 0) continue
        try {
          const result = (await client().send(
            new DeleteMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: entries,
            })
          )) as { Failed?: { Id?: string; Message?: string }[] }
          if (result.Failed?.length) {
            context.logger.error(
              { queueUrl, failed: result.Failed.length },
              'Cannot delete handled SQS messages: they will be delivered again'
            )
          }
        } catch (error) {
          context.logger.error(
            { queueUrl, error: describe(error) },
            'Cannot delete handled SQS messages: they will be delivered again'
          )
        }
      }
    },
  }
}
