import { optionalMilliseconds, type Duration } from '../duration.js'
import type { PubSub } from '@google-cloud/pubsub'
import type { Envelope } from '../envelope.js'
import { PartialSendError } from '../errors.js'
import type { EventsLogger } from '../logger.js'
import type { Source, Transport } from '../transport.js'
import type { HandleResult, Worker } from '../worker.js'

/**
 * OAuth access token of the publisher, or `false` without authentication
 * (the Pub/Sub emulator). Defaults to Application Default Credentials,
 * through `google-auth-library`.
 */
export type AccessTokenOption = (() => Promise<string>) | false

/** Options to publish to a topic over the REST API. */
export interface PubSubPublishOptions {
  /** Full topic name: `projects/{project}/topics/{topic}`. */
  topic: string
  getAccessToken?: AccessTokenOption | undefined
  /** Base URL of the API. Defaults to `https://pubsub.googleapis.com`. */
  baseUrl?: string | undefined
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
}

/** Options of `createPubSubHandler()`. */
export interface PubSubHandlerOptions {
  /**
   * Checks the OIDC token of push requests (`Authorization: Bearer`).
   * Defaults to true; set `false` only behind a proxy that checks it.
   */
  verifyToken?: boolean | undefined
  /** Audience of the token, as configured on the push subscription. */
  audience?: string | undefined
  /** Expected service account of the push subscription (`email` claim). */
  serviceAccountEmail?: string | undefined
  /** Keys of the tokens. Defaults to the Google certificates. */
  certsUrl?: string | undefined
  /**
   * Topic where messages that can never be handled are published at once,
   * instead of failing until `maxDeliveryAttempts`.
   */
  deadLetter?: Omit<PubSubPublishOptions, 'fetch'> | undefined
  /** `fetch` implementation, for the dead-letter topic. */
  fetch?: typeof fetch | undefined
  logger?: EventsLogger | undefined
}

/** Push endpoint of a subscription. */
export interface PubSubHandler {
  /** Handles a push request (Web `Request`), and returns the response. */
  fetch(request: Request): Promise<Response>
  /**
   * Handles a push body (parsed JSON) with its `Authorization` header, for
   * frameworks without Web requests. Returns the HTTP status to answer.
   */
  handle(body: unknown, authorization: string | undefined): Promise<number>
}

/** Options of `createPubSubSource()`. */
export interface PubSubSourceOptions {
  /** Full subscription name: `projects/{project}/subscriptions/{name}`. */
  subscription: string
  /** Existing client. Defaults to a client created with `clientConfig`. */
  client?: PubSub | undefined
  /** Options of the created client (`projectId`, `credentials`…). */
  clientConfig?: ConstructorParameters<typeof PubSub>[0] | undefined
  /** Messages handled at the same time. Defaults to 10. */
  concurrency?: number | undefined
  /**
   * Topic where messages that can never be handled are published at once,
   * instead of failing until `maxDeliveryAttempts`: its full name.
   */
  deadLetter?: { topic: string } | undefined
  /**
   * On stop, how long to wait for the messages in progress. Defaults to 30
   * seconds.
   */
  closeTimeout?: Duration | undefined
}

// Limits of the publish API: 1,000 messages and 10 MB per request.
const MAX_MESSAGES = 1000
const MAX_REQUEST_BYTES = 10_000_000
const DEFAULT_BASE_URL = 'https://pubsub.googleapis.com'
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const SCOPE = 'https://www.googleapis.com/auth/pubsub'
const TOPIC = /^projects\/[^/]+\/topics\/[^/]+$/
const SUBSCRIPTION = /^projects\/[^/]+\/subscriptions\/[^/]+$/

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

const checkName = (
  label: string,
  key: string,
  value: unknown,
  kind: RegExp,
  example: string
) => {
  if (typeof value !== 'string' || !kind.test(value)) {
    throw new TypeError(
      `${label}: ${key} must be a full name, like ${example}.`
    )
  }
  return value
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const encoder = new TextEncoder()

/** Bytes turned into characters at once: below the argument limits. */
const CHUNK = 0x8000

/**
 * Base64 of the UTF-8 bytes of a text (Web APIs only): `Uint8Array#toBase64`
 * when the runtime has it, `btoa` by chunks otherwise.
 */
const base64 = (text: string) => {
  const bytes: Uint8Array & { toBase64?: () => string } = encoder.encode(text)
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let binary = ''
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  }
  return btoa(binary)
}

/** Decodes base64 data; data that is not base64 gives an empty string. */
const fromBase64 = (data: string) => {
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    )
  } catch {
    return ''
  }
}

let googleAuth:
  Promise<{ getAccessToken(): Promise<string | null | undefined> }> | undefined

/** Access token from Application Default Credentials. */
const defaultAccessToken = async () => {
  googleAuth ??= import('google-auth-library').then(
    ({ GoogleAuth }) => new GoogleAuth({ scopes: SCOPE }),
    (error: unknown) => {
      googleAuth = undefined
      throw new Error(
        'Install google-auth-library, or pass getAccessToken, to publish to Pub/Sub.',
        { cause: error }
      )
    }
  )
  const token = await (await googleAuth).getAccessToken()
  if (!token) throw new Error('No Google access token: check the credentials.')
  return token
}

/** Publishes JSON messages to a topic over the REST API. */
const publisherOf = (label: string, options: Record<string, unknown>) => {
  const topic = checkName(
    label,
    'topic',
    options.topic,
    TOPIC,
    'projects/my-project/topics/events'
  )
  const {
    getAccessToken = defaultAccessToken,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchFn = globalThis.fetch,
  } = options
  if (getAccessToken !== false && typeof getAccessToken !== 'function') {
    throw new TypeError(
      `${label}: getAccessToken must be a function, or false.`
    )
  }
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(baseUrl)) {
    throw new TypeError(`${label}: baseUrl must be an http(s) URL.`)
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError(`${label}: fetch must be a function.`)
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/${topic}:publish`

  return async (
    messages: { data: string; attributes: Record<string, string> }[]
  ) => {
    const token =
      getAccessToken === false
        ? undefined
        : await (getAccessToken as () => Promise<string>)()
    const response = await (fetchFn as typeof fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ messages }),
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as {
          error?: { status?: unknown; message?: unknown }
        }
        detail = [body.error?.status, body.error?.message]
          .filter(Boolean)
          .join(': ')
      } catch {
        // Not JSON.
      }
      throw new Error(
        `Pub/Sub API: ${response.status} ${detail || response.statusText}`.trim()
      )
    }
  }
}

const messageOf = (envelope: Envelope) => ({
  data: base64(JSON.stringify(envelope)),
  attributes: { event: envelope.event, listener: envelope.listener },
})

/**
 * Creates a transport that publishes messages to a Google Cloud Pub/Sub
 * topic, over the REST API with `fetch`: it also runs outside Node.js.
 * Pub/Sub has no delayed delivery: `delay` is refused.
 *
 * ```ts
 * const transport = createPubSubTransport({ topic: 'projects/my-project/topics/events' })
 * ```
 */
export const createPubSubTransport = (
  options: PubSubPublishOptions
): Transport => {
  const label = 'createPubSubTransport()'
  const values = checkOptions(label, options, [
    'topic',
    'getAccessToken',
    'baseUrl',
    'fetch',
  ])
  const publish = publisherOf(label, values)

  return {
    kind: 'google-pubsub',
    send: async (envelopes, { delay }) => {
      if (delay) {
        throw new RangeError(
          'Pub/Sub has no delayed delivery: emit without delay, or use another transport.'
        )
      }
      const failed: { id: string; error: unknown }[] = []
      const batches: {
        envelopes: Envelope[]
        messages: ReturnType<typeof messageOf>[]
        size: number
      }[] = []
      for (const envelope of envelopes) {
        const message = messageOf(envelope)
        // Base64 data, attributes and JSON overhead.
        const size = JSON.stringify(message).length + 1
        if (size + 20 > MAX_REQUEST_BYTES) {
          failed.push({
            id: envelope.id,
            error: new RangeError(
              `Pub/Sub accepts publish requests of at most ${MAX_REQUEST_BYTES} bytes (data base64-encoded), got ${size} for one message.`
            ),
          })
          continue
        }
        const last = batches.at(-1)
        if (
          last &&
          last.messages.length < MAX_MESSAGES &&
          last.size + size + 20 <= MAX_REQUEST_BYTES
        ) {
          last.envelopes.push(envelope)
          last.messages.push(message)
          last.size += size
        } else {
          batches.push({ envelopes: [envelope], messages: [message], size })
        }
      }
      for (const batch of batches) {
        try {
          await publish(batch.messages)
        } catch (error) {
          for (const { id } of batch.envelopes) failed.push({ id, error })
        }
      }
      if (failed.length > 0) throw new PartialSendError(failed)
    },
  }
}

type Verifier = (token: string) => Promise<Record<string, unknown>>

/** Verifier of Google OIDC tokens, with `jose` (peer dependency). */
const verifierOf = (audience: string, certsUrl: string): Verifier => {
  let loaded:
    | Promise<{
        jwks: unknown
        jwtVerify: typeof import('jose').jwtVerify
      }>
    | undefined
  return async (token) => {
    loaded ??= import('jose').then(
      ({ createRemoteJWKSet, jwtVerify }) => ({
        jwks: createRemoteJWKSet(new URL(certsUrl)),
        jwtVerify,
      }),
      (error: unknown) => {
        loaded = undefined
        throw new Error('Install jose to verify Pub/Sub push tokens.', {
          cause: error,
        })
      }
    )
    const { jwks, jwtVerify } = await loaded
    const { payload } = await jwtVerify(
      token,
      jwks as Parameters<typeof jwtVerify>[1],
      {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience,
      }
    )
    return payload
  }
}

/** Applies a dead-letter publication: true when the message was moved. */
const moveToDeadLetter = async (
  publish:
    | ((
        messages: { data: string; attributes: Record<string, string> }[]
      ) => Promise<void>)
    | undefined,
  data: string,
  result: HandleResult,
  logger: EventsLogger | undefined
) => {
  if (result.status !== 'dead' || !publish) return false
  try {
    await publish([
      {
        data,
        attributes: {
          reason: result.reason,
          error: describe(result.error).slice(0, 1024),
        },
      },
    ])
    return true
  } catch (error) {
    logger?.error(
      { error: describe(error) },
      'Cannot publish the message to the dead-letter topic'
    )
    return false
  }
}

/**
 * Creates the endpoint of a push subscription: Pub/Sub POSTs each message
 * to it, and an answer other than 2xx makes it deliver the message again.
 * Mount `fetch` on any Web-standard runtime (Cloudflare Workers, Hono,
 * Bun, Deno, Cloud Run), or call `handle` from another framework.
 *
 * ```ts
 * const push = createPubSubHandler(worker, {
 *   audience: 'https://api.example.com/pubsub',
 *   serviceAccountEmail: 'pubsub-push@my-project.iam.gserviceaccount.com',
 * })
 * app.post('/pubsub', (c) => push.fetch(c.req.raw))
 * ```
 */
export const createPubSubHandler = (
  worker: Worker,
  options: PubSubHandlerOptions = {}
): PubSubHandler => {
  const label = 'createPubSubHandler()'
  if (typeof worker?.handle !== 'function') {
    throw new TypeError(
      `${label}: expected a worker created by createWorker().`
    )
  }
  const values = checkOptions(label, options, [
    'verifyToken',
    'audience',
    'serviceAccountEmail',
    'certsUrl',
    'deadLetter',
    'fetch',
    'logger',
  ])
  const {
    verifyToken = true,
    audience,
    serviceAccountEmail,
    certsUrl = GOOGLE_CERTS,
  } = values
  if (typeof verifyToken !== 'boolean') {
    throw new TypeError(`${label}: verifyToken must be a boolean.`)
  }
  if (verifyToken && (typeof audience !== 'string' || audience === '')) {
    throw new TypeError(
      `${label}: audience is required to verify push tokens (or set verifyToken: false behind a proxy that checks them).`
    )
  }
  if (
    serviceAccountEmail !== undefined &&
    (typeof serviceAccountEmail !== 'string' || serviceAccountEmail === '')
  ) {
    throw new TypeError(
      `${label}: serviceAccountEmail must be a non-empty string.`
    )
  }
  if (typeof certsUrl !== 'string' || !/^https?:\/\/[^/]/.test(certsUrl)) {
    throw new TypeError(`${label}: certsUrl must be an http(s) URL.`)
  }
  if (values.deadLetter !== undefined) {
    checkOptions(`${label}: deadLetter`, values.deadLetter, [
      'topic',
      'getAccessToken',
      'baseUrl',
    ])
  }
  const logger = values.logger as EventsLogger | undefined
  const verify = verifyToken
    ? verifierOf(audience as string, certsUrl)
    : undefined
  const publishDead =
    values.deadLetter === undefined
      ? undefined
      : publisherOf(label, { ...values.deadLetter, fetch: values.fetch })

  const handle: PubSubHandler['handle'] = async (body, authorization) => {
    if (verify) {
      const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
      if (!token) return 401
      try {
        const claims = await verify(token)
        if (
          claims.email_verified !== true ||
          (serviceAccountEmail !== undefined &&
            claims.email !== serviceAccountEmail)
        ) {
          return 403
        }
      } catch (error) {
        logger?.warn({ error: describe(error) }, 'Invalid Pub/Sub push token')
        return 401
      }
    }
    const message =
      isRecord(body) && isRecord(body.message) ? body.message : undefined
    if (!message) return 400
    const deliveryAttempt = (body as { deliveryAttempt?: unknown })
      .deliveryAttempt
    const attempt = typeof deliveryAttempt === 'number' ? deliveryAttempt : 1
    // Messages without data (attributes only) are not envelopes: dead.
    const raw = typeof message.data === 'string' ? message.data : ''

    const result = await worker.handle(fromBase64(raw), { attempt })
    if (result.status === 'success') return 204
    if (await moveToDeadLetter(publishDead, raw, result, logger)) return 204
    // Any status but 102 and 2xx makes Pub/Sub deliver the message again.
    return 503
  }

  return {
    handle,
    fetch: async (request) => {
      const body: unknown = await request.json().catch(() => undefined)
      const status = await handle(
        body,
        request.headers.get('authorization') ?? undefined
      )
      return new Response(null, { status })
    },
  }
}

/**
 * Creates a source that pulls a subscription with the Pub/Sub client
 * (`@google-cloud/pubsub`, peer dependency; Node.js), for `startWorker()`
 * and `dotpress-events work`.
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners }),
 *   source: createPubSubSource({ subscription: 'projects/my-project/subscriptions/events' }),
 * }
 * ```
 */
export const createPubSubSource = (options: PubSubSourceOptions): Source => {
  const label = 'createPubSubSource()'
  const values = checkOptions(label, options, [
    'subscription',
    'client',
    'clientConfig',
    'concurrency',
    'deadLetter',
    'closeTimeout',
  ])
  const subscriptionName = checkName(
    label,
    'subscription',
    values.subscription,
    SUBSCRIPTION,
    'projects/my-project/subscriptions/events'
  )
  const { client, clientConfig, concurrency: maxMessages = 10 } = values
  const closeTimeout = optionalMilliseconds(
    values.closeTimeout,
    `${label}: closeTimeout`,
    30_000
  )
  if (client !== undefined && clientConfig !== undefined) {
    throw new TypeError(`${label}: set client or clientConfig, not both.`)
  }
  if (
    client !== undefined &&
    typeof (client as PubSub | null)?.subscription !== 'function'
  ) {
    throw new TypeError(`${label}: client must be a PubSub client.`)
  }
  if (!Number.isInteger(maxMessages) || (maxMessages as number) < 1) {
    throw new TypeError(`${label}: concurrency must be a positive integer.`)
  }
  let deadLetterTopic: string | undefined
  if (values.deadLetter !== undefined) {
    const deadLetter = checkOptions(`${label}: deadLetter`, values.deadLetter, [
      'topic',
    ])
    deadLetterTopic = checkName(
      label,
      'deadLetter.topic',
      deadLetter.topic,
      TOPIC,
      'projects/my-project/topics/events-dlq'
    )
  }

  return {
    kind: 'google-pubsub',
    consume: async (worker, { signal, logger }) => {
      const pubsub =
        (client as PubSub | undefined) ??
        new (await import('@google-cloud/pubsub')).PubSub(
          clientConfig as ConstructorParameters<typeof PubSub>[0]
        )
      const subscription = pubsub.subscription(subscriptionName, {
        flowControl: {
          maxMessages: maxMessages as number,
          allowExcessMessages: false,
        },
      })
      const deadTopic =
        deadLetterTopic === undefined
          ? undefined
          : pubsub.topic(deadLetterTopic)

      subscription.on('message', (message) => {
        void (async () => {
          const data = message.data.toString('utf8')
          const result = await worker.handle(data, {
            attempt: message.deliveryAttempt || 1,
          })
          if (result.status === 'success') return message.ack()
          if (result.status === 'dead' && deadTopic) {
            try {
              await deadTopic.publishMessage({
                data: message.data,
                attributes: {
                  reason: result.reason,
                  error: describe(result.error).slice(0, 1024),
                },
              })
              return message.ack()
            } catch (error) {
              logger.error(
                { error: describe(error) },
                'Cannot publish the message to the dead-letter topic'
              )
            }
          }
          message.nack()
        })()
      })
      subscription.on('error', (error: Error) => {
        logger.error(
          { subscription: subscriptionName, error: error.message },
          'Pub/Sub subscription error'
        )
      })

      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      // close() waits for the messages in progress, within closeTimeout.
      let timer: ReturnType<typeof setTimeout> | undefined
      const closed = await Promise.race([
        subscription.close().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), closeTimeout)
        }),
      ])
      clearTimeout(timer)
      if (!closed) {
        logger.warn(
          { subscription: subscriptionName, closeTimeout },
          'Pub/Sub subscription not closed in time: stopped without waiting'
        )
      }
      if (!client) await pubsub.close().catch(() => undefined)
    },
  }
}
