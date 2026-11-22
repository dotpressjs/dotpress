import {
  optionalMilliseconds,
  retryDelayOf,
  type Duration,
} from '../duration.js'
import type { Envelope } from '../envelope.js'
import { PartialSendError } from '../errors.js'
import { checkLogger, consoleLogger, type EventsLogger } from '../logger.js'
import { decodePulledBody } from './cloudflare-queues-internal.js'
import type { Source, Transport } from '../transport.js'
import type { HandleResult, Worker } from '../worker.js'

/** Producer binding of a queue (`env.EVENTS_QUEUE` in a Worker). */
export interface CloudflareQueueBinding {
  sendBatch(
    messages: Iterable<{
      body: unknown
      contentType?: 'json'
      delaySeconds?: number
    }>
  ): Promise<unknown>
}

/** A message received by the `queue()` handler of a Worker. */
export interface CloudflareQueueMessage {
  readonly id: string
  readonly body: unknown
  /** Attempt number, from 1. */
  readonly attempts: number
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

/** The batch received by the `queue()` handler of a Worker. */
export interface CloudflareMessageBatch {
  readonly queue: string
  readonly messages: readonly CloudflareQueueMessage[]
}

/** REST API access, to use a queue from outside Cloudflare Workers. */
export interface CloudflareApiOptions {
  accountId: string
  /** Queue ID (not its name). */
  queueId: string
  /** API token with Queues permissions (read and write to pull). */
  apiToken: string
  /** Base URL of the API. Defaults to `https://api.cloudflare.com/client/v4`. */
  baseUrl?: string | undefined
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
}

/** Options of `createCloudflareQueueTransport()`. */
export type CloudflareQueueTransportOptions =
  | {
      /**
       * Producer binding of the queue, or a function returning it (when the
       * bus is created before the `env` of the Worker is available).
       */
      queue: CloudflareQueueBinding | (() => CloudflareQueueBinding)
    }
  | CloudflareApiOptions

/** Options of `createCloudflareQueueHandler()`. */
export interface CloudflareQueueHandlerOptions {
  /**
   * Producer binding of the dead-letter queue: messages that can never be
   * handled are sent there at once, instead of failing until `max_retries`.
   */
  deadLetter?:
    CloudflareQueueBinding | (() => CloudflareQueueBinding) | undefined
  /**
   * Delay before a retry, given the attempt number: a number of seconds,
   * or a duration like `'30s'`, rounded up to the second.
   */
  retryDelay?: ((attempt: number) => Duration) | undefined
  logger?: EventsLogger | undefined
}

/** Options of `createCloudflareQueueSource()`. */
export interface CloudflareQueueSourceOptions extends CloudflareApiOptions {
  /** Messages pulled at once and handled together (1 to 100). Defaults to 10. */
  concurrency?: number | undefined
  /**
   * Lease of the pulled messages (up to 12 hours): longer than your slowest
   * listener, since it cannot be extended. Defaults to 30 seconds.
   */
  visibilityTimeout?: Duration | undefined
  /** Wait before pulling again an empty queue. Defaults to 1 second. */
  pollInterval?: Duration | undefined
  /**
   * Delay before a retry, given the attempt number: a number of seconds,
   * or a duration like `'30s'`, rounded up to the second.
   */
  retryDelay?: ((attempt: number) => Duration) | undefined
  /**
   * Queue ID of the dead-letter queue: messages that can never be handled
   * are pushed there at once, instead of failing until `max_retries`.
   */
  deadLetter?: string | undefined
}

// Limits of Cloudflare Queues (1 KB = 1000 bytes). Messages also carry
// about 100 bytes of internal metadata.
const MAX_MESSAGE_BYTES = 128_000 - 100
const MAX_BATCH_MESSAGES = 100
const MAX_BATCH_BYTES = 256_000
const MAX_DELAY_SECONDS = 86_400
const MAX_PULL_BATCH = 100
const MAX_VISIBILITY_MS = 43_200_000
const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'

const encoder = new TextEncoder()

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

const checkString = (label: string, key: string, value: unknown) => {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}: ${key} must be a non-empty string.`)
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

const checkFunction = (label: string, key: string, value: unknown) => {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${label}: ${key} must be a function.`)
  }
}

/** A binding, or the function returning it. */
const bindingOf = (label: string, key: string, value: unknown) => {
  if (
    typeof value !== 'function' &&
    typeof (value as CloudflareQueueBinding | null)?.sendBatch !== 'function'
  ) {
    throw new TypeError(
      `${label}: ${key} must be a queue binding, or a function returning it.`
    )
  }
  return () =>
    typeof value === 'function'
      ? (value as () => CloudflareQueueBinding)()
      : (value as CloudflareQueueBinding)
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Client of the REST API of a queue. */
const apiOf = (label: string, values: Record<string, unknown>) => {
  const accountId = checkString(label, 'accountId', values.accountId)
  const queueId = checkString(label, 'queueId', values.queueId)
  const apiToken = checkString(label, 'apiToken', values.apiToken)
  const { baseUrl = DEFAULT_BASE_URL, fetch: fetchFn = globalThis.fetch } =
    values
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(baseUrl)) {
    throw new TypeError(`${label}: baseUrl must be an http(s) URL.`)
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError(`${label}: fetch must be a function.`)
  }
  const base = baseUrl.replace(/\/+$/, '')

  return async (path: string, body: unknown, queue = queueId) => {
    const response = await (fetchFn as typeof fetch)(
      `${base}/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queue)}/messages${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    )
    let result: {
      success?: unknown
      errors?: { code?: unknown; message?: unknown }[]
      result?: unknown
    } = {}
    try {
      result = (await response.json()) as typeof result
    } catch {
      // Not JSON: reported with the status below.
    }
    if (!response.ok || result.success === false) {
      const errors = (Array.isArray(result.errors) ? result.errors : [])
        .map(({ code, message }) => `${code}: ${message}`)
        .join('; ')
      throw new Error(
        `Cloudflare Queues API: ${response.status} ${errors || response.statusText}`.trim()
      )
    }
    return result.result
  }
}

/** Batches within the limits of Cloudflare Queues; oversized ones fail. */
const batchesOf = (envelopes: readonly Envelope[]) => {
  const failed: { id: string; error: unknown }[] = []
  const batches: { envelopes: Envelope[]; size: number }[] = []
  for (const envelope of envelopes) {
    const size = encoder.encode(JSON.stringify(envelope)).byteLength
    if (size > MAX_MESSAGE_BYTES) {
      failed.push({
        id: envelope.id,
        error: new RangeError(
          `Cloudflare Queues accepts messages of at most ${MAX_MESSAGE_BYTES} bytes (128 KB with its metadata), got ${size}.`
        ),
      })
      continue
    }
    const last = batches.at(-1)
    if (
      last &&
      last.envelopes.length < MAX_BATCH_MESSAGES &&
      last.size + size <= MAX_BATCH_BYTES
    ) {
      last.envelopes.push(envelope)
      last.size += size
    } else {
      batches.push({ envelopes: [envelope], size })
    }
  }
  return { batches, failed }
}

/**
 * Creates a transport that sends messages to a Cloudflare Queue: through
 * its producer binding inside a Worker, or through the REST API from
 * anywhere else (Node.js, Lambda…).
 *
 * ```ts
 * // In a Worker
 * import { env } from 'cloudflare:workers'
 * const transport = createCloudflareQueueTransport({ queue: () => env.EVENTS_QUEUE })
 *
 * // Elsewhere
 * const transport = createCloudflareQueueTransport({ accountId, queueId, apiToken })
 * ```
 */
export const createCloudflareQueueTransport = (
  options: CloudflareQueueTransportOptions
): Transport => {
  const label = 'createCloudflareQueueTransport()'
  const values = checkOptions(label, options, [
    'queue',
    'accountId',
    'queueId',
    'apiToken',
    'baseUrl',
    'fetch',
  ])
  let sendBatch: (
    envelopes: Envelope[],
    delay: number | undefined
  ) => Promise<unknown>
  if (values.queue !== undefined) {
    if (Object.keys(values).some((key) => key !== 'queue')) {
      throw new TypeError(
        `${label}: set queue, or the REST API options, not both.`
      )
    }
    const binding = bindingOf(label, 'queue', values.queue)
    sendBatch = (envelopes, delay) =>
      binding().sendBatch(
        envelopes.map((body) => ({
          body,
          contentType: 'json' as const,
          ...(delay === undefined ? {} : { delaySeconds: delay }),
        }))
      )
  } else {
    const api = apiOf(label, values)
    sendBatch = (envelopes, delay) =>
      api('/batch', {
        messages: envelopes.map((body) => ({
          body,
          content_type: 'json',
          ...(delay === undefined ? {} : { delay_seconds: delay }),
        })),
      })
  }

  return {
    kind: 'cloudflare-queues',
    send: async (envelopes, { delay }) => {
      if (delay !== undefined && delay > MAX_DELAY_SECONDS) {
        throw new RangeError(
          `Cloudflare Queues accepts delays of at most ${MAX_DELAY_SECONDS} seconds, got ${delay}.`
        )
      }
      const { batches, failed } = batchesOf(envelopes)
      for (const batch of batches) {
        try {
          await sendBatch(batch.envelopes, delay)
        } catch (error) {
          for (const { id } of batch.envelopes) failed.push({ id, error })
        }
      }
      if (failed.length > 0) throw new PartialSendError(failed)
    },
  }
}

/** Delay of a retry, in whole seconds; undefined without `retryDelay`. */
const delayOf = (
  label: string,
  retryDelay: ((attempt: number) => Duration) | undefined,
  attempt: number,
  logger: EventsLogger
) => {
  if (retryDelay === undefined) return undefined
  try {
    return Math.min(
      MAX_DELAY_SECONDS,
      Math.ceil(retryDelayOf(label, retryDelay, attempt) / 1000)
    )
  } catch (error) {
    logger.error({ error: describe(error) }, 'Invalid retry delay')
    return undefined
  }
}

/**
 * Creates the `queue()` handler of a Worker consuming the queue. Each
 * message is acknowledged or retried on its own: a failure does not retry
 * the whole batch. Configure `max_retries` and `dead_letter_queue` in the
 * consumer settings (Wrangler).
 *
 * ```ts
 * export default {
 *   queue: createCloudflareQueueHandler(createWorker({ listeners })),
 * }
 * ```
 */
export const createCloudflareQueueHandler = (
  worker: Worker,
  options: CloudflareQueueHandlerOptions = {}
) => {
  const label = 'createCloudflareQueueHandler()'
  if (typeof worker?.handle !== 'function') {
    throw new TypeError(
      `${label}: expected a worker created by createWorker().`
    )
  }
  const values = checkOptions(label, options, [
    'deadLetter',
    'retryDelay',
    'logger',
  ])
  checkFunction(label, 'retryDelay', values.retryDelay)
  const retryDelay =
    values.retryDelay as CloudflareQueueHandlerOptions['retryDelay']
  const deadLetter =
    values.deadLetter === undefined
      ? undefined
      : bindingOf(label, 'deadLetter', values.deadLetter)
  const logger =
    values.logger === undefined
      ? consoleLogger
      : checkLogger(label, values.logger)

  const settle = async (
    message: CloudflareQueueMessage,
    result: HandleResult
  ) => {
    if (result.status === 'success') return message.ack()
    if (result.status === 'dead' && deadLetter) {
      try {
        await deadLetter().sendBatch([
          { body: message.body, contentType: 'json' },
        ])
        return message.ack()
      } catch (error) {
        // Retried: it reaches the dead-letter queue after max_retries.
        logger.error(
          { messageId: message.id, error: describe(error) },
          'Cannot send the message to the dead-letter queue'
        )
      }
    }
    const delaySeconds = delayOf(label, retryDelay, message.attempts, logger)
    message.retry(delaySeconds === undefined ? undefined : { delaySeconds })
  }

  return async (batch: CloudflareMessageBatch): Promise<void> => {
    await Promise.all(
      (batch?.messages ?? []).map(async (message) => {
        const result = await worker.handle(message.body, {
          attempt: message.attempts,
        })
        await settle(message, result)
      })
    )
  }
}

interface PulledMessage {
  body?: unknown
  attempts?: unknown
  lease_id?: unknown
  metadata?: unknown
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

/**
 * Creates a source that pulls the queue over HTTP, for `startWorker()` and
 * `dotpress-events work`: a worker outside Cloudflare, or your machine.
 * Enable an HTTP pull consumer on the queue first
 * (`wrangler queues consumer http add <queue>`).
 */
export const createCloudflareQueueSource = (
  options: CloudflareQueueSourceOptions
): Source => {
  const label = 'createCloudflareQueueSource()'
  const values = checkOptions(label, options, [
    'accountId',
    'queueId',
    'apiToken',
    'baseUrl',
    'fetch',
    'concurrency',
    'visibilityTimeout',
    'pollInterval',
    'retryDelay',
    'deadLetter',
  ])
  const api = apiOf(label, values)
  const batchSize =
    checkInteger(label, 'concurrency', values.concurrency, 1, MAX_PULL_BATCH) ??
    10
  const visibilityTimeoutMs = optionalMilliseconds(
    values.visibilityTimeout,
    `${label}: visibilityTimeout`,
    30_000
  )
  if (visibilityTimeoutMs < 1 || visibilityTimeoutMs > MAX_VISIBILITY_MS) {
    throw new TypeError(
      `${label}: visibilityTimeout must be from 1 millisecond to 12 hours.`
    )
  }
  const pollInterval = optionalMilliseconds(
    values.pollInterval,
    `${label}: pollInterval`,
    1000
  )
  if (pollInterval > 3_600_000) {
    throw new TypeError(`${label}: pollInterval must be 1 hour at most.`)
  }
  checkFunction(label, 'retryDelay', values.retryDelay)
  const retryDelay =
    values.retryDelay as CloudflareQueueSourceOptions['retryDelay']
  const deadLetterQueueId =
    values.deadLetter === undefined
      ? undefined
      : checkString(label, 'deadLetter', values.deadLetter)

  return {
    kind: 'cloudflare-queues',
    consume: async (worker, { signal, logger }) => {
      let errorDelay = 0
      while (!signal.aborted) {
        let messages: PulledMessage[]
        try {
          const result = (await api('/pull', {
            batch_size: batchSize,
            visibility_timeout_ms: visibilityTimeoutMs,
          })) as { messages?: PulledMessage[] } | undefined
          messages = result?.messages ?? []
          errorDelay = 0
        } catch (error) {
          errorDelay = Math.min(30_000, Math.max(1000, errorDelay * 2))
          logger.error(
            { error: describe(error), retryInMs: errorDelay },
            'Cannot pull Cloudflare Queues messages'
          )
          await sleep(errorDelay, signal)
          continue
        }
        if (messages.length === 0) {
          await sleep(pollInterval, signal)
          continue
        }

        const acks: { lease_id: string }[] = []
        const retries: { lease_id: string; delay_seconds?: number }[] = []
        await Promise.all(
          messages.map(async (message) => {
            const leaseId = String(message.lease_id)
            const attempt = Number(message.attempts) || 1
            const body = decodePulledBody(message.body)
            const result = await worker.handle(body, { attempt })
            if (result.status === 'success') {
              acks.push({ lease_id: leaseId })
              return
            }
            if (result.status === 'dead' && deadLetterQueueId) {
              try {
                const envelope =
                  typeof body === 'string'
                    ? (JSON.parse(body) as unknown)
                    : body
                await api(
                  '/batch',
                  { messages: [{ body: envelope, content_type: 'json' }] },
                  deadLetterQueueId
                )
                acks.push({ lease_id: leaseId })
                return
              } catch (error) {
                logger.error(
                  { deadLetter: deadLetterQueueId, error: describe(error) },
                  'Cannot copy the message to the dead-letter queue'
                )
              }
            }
            const delay = delayOf(label, retryDelay, attempt, logger)
            retries.push({
              lease_id: leaseId,
              ...(delay === undefined ? {} : { delay_seconds: delay }),
            })
          })
        )
        try {
          await api('/ack', { acks, retries })
        } catch (error) {
          logger.error(
            { error: describe(error) },
            'Cannot acknowledge Cloudflare Queues messages: they will be delivered again'
          )
        }
      }
    },
  }
}
