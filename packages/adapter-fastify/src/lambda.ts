import {
  createConsoleLogger,
  internalError,
  toErrorBody,
  type App,
  type Logger,
} from '@dotpress/core'
import awsLambdaFastify from '@fastify/aws-lambda'
import Fastify, { type FastifyInstance } from 'fastify'
import { assertKnownOptions } from './options.js'

// The Lambda types are the same in @dotpress/adapter-hono/lambda and
// @dotpress/adapter-fastify/lambda: keep them in sync.
/**
 * Event of API Gateway REST APIs (payload v1), HTTP APIs and Function URLs
 * (payload v2), or Application Load Balancers. Read by the handler only:
 * the types of `@types/aws-lambda` fit.
 */
export type LambdaEvent = object

/** Context of the invocation, given by the Lambda runtime. */
export type LambdaContext = object

/** Result of the handler, in the format of the event. */
export interface LambdaResult {
  statusCode: number
  /** Application Load Balancers only. */
  statusDescription?: string
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  /** Payload v2 only. */
  cookies?: string[]
  body: string
  isBase64Encoded?: boolean
}

export interface LambdaHandlerOptions {
  /** Logs the failures to create the app. Defaults to a console logger. */
  logger?: Logger
  /**
   * Whether a response content type is binary (sent in base64). Defaults to
   * everything except text, JSON and XML.
   */
  isContentTypeBinary?: (contentType: string) => boolean
}

/**
 * AWS Lambda handler: API Gateway REST (payload v1) and HTTP APIs (payload
 * v2), Function URLs, Application Load Balancer.
 */
export type LambdaHandler = (
  event: LambdaEvent,
  context?: LambdaContext
) => Promise<LambdaResult>

/** App of the factory, created with `fastifyAdapter()`. */
export type LambdaApp = Pick<App<FastifyInstance>, 'native'>

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)$|[^;]*\+(json|xml)$)/

const isTextType = (contentType: string) =>
  TEXT_TYPES.test(contentType.split(';', 1)[0]!.trim().toLowerCase())

interface EventShape {
  version?: string
  path?: string
  rawPath?: string
  rawQueryString?: string
  headers?: Record<string, string | undefined> | null
  multiValueHeaders?: Record<string, string[] | undefined> | null
  queryStringParameters?: Record<string, string | undefined> | null
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null
  requestContext?: { elb?: unknown; identity?: object }
}

/** Query string of a load balancer event (not decoded by the load balancer). */
const albQuery = (event: EventShape) => {
  const parameters =
    event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}
  const pairs: string[] = []
  for (const [key, values] of Object.entries(parameters)) {
    for (const value of [values ?? []].flat()) pairs.push(`${key}=${value}`)
  }
  return pairs.join('&')
}

/** Path with the query string. */
const withQuery = (path = '/', query = '') =>
  query ? `${path}?${query}` : path

/**
 * Prepares the event for `@fastify/aws-lambda`.
 *
 * - The query string is passed as sent, with the path, when the event has
 *   it: the parameters decoded by API Gateway or by the library lose the
 *   plus signs (spaces) and the commas of the values (payload v2).
 * - Behind a load balancer, the client address is the last entry of
 *   `X-Forwarded-For`, appended by the load balancer.
 */
const prepare = (event: EventShape): EventShape => {
  const context = event.requestContext
  const raw = {
    ...event,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
  }

  if (event.version === '2.0') {
    return { ...raw, rawPath: withQuery(event.rawPath, event.rawQueryString) }
  }
  // API Gateway REST APIs only give the decoded parameters.
  if (context?.elb === undefined) return event

  const forwarded =
    event.multiValueHeaders?.['x-forwarded-for']?.at(-1) ??
    event.headers?.['x-forwarded-for']
  return {
    ...raw,
    path: withQuery(event.path, albQuery(event)),
    // Used as the remote address of the request (when defined).
    requestContext: {
      ...context,
      identity: { sourceIp: forwarded?.split(',').at(-1)?.trim() },
    },
  }
}

/** Answers `500 INTERNAL_ERROR` when the app cannot be created. */
const failureApp = () => {
  const app = Fastify()
  app.all('*', async (_request, reply) =>
    reply
      .code(500)
      .header('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify(toErrorBody(internalError())))
  )
  return app
}

/**
 * Creates the AWS Lambda handler of an app (`@fastify/aws-lambda`).
 *
 * The app is created by the factory at the first invocation (cold start),
 * then reused by the next invocations of the execution environment.
 * Invocations received meanwhile wait for the same app. When the factory
 * fails, the error is logged, the invocation gets a `500` error, and the
 * next invocation calls the factory again.
 *
 * Responses are sent once complete: streamed responses (`stream()`) are
 * buffered, and Server-Sent Events are not supported.
 *
 * @example
 * export const handler = createLambdaHandler(() =>
 *   createApp({ adapter: fastifyAdapter(), plugins: [authPlugin(auth)] })
 * )
 */
export const createLambdaHandler = (
  factory: () => LambdaApp | Promise<LambdaApp>,
  options: LambdaHandlerOptions = {}
): LambdaHandler => {
  assertKnownOptions('createLambdaHandler()', options, [
    'logger',
    'isContentTypeBinary',
  ] satisfies (keyof LambdaHandlerOptions)[])
  const logger = options.logger ?? createConsoleLogger()
  const isBinary = options.isContentTypeBinary ?? ((type) => !isTextType(type))

  const toHandler = (app: FastifyInstance): LambdaHandler => {
    const create = (albMultiValueHeaders: boolean) =>
      awsLambdaFastify(app, {
        // The instance is ready: it cannot be decorated anymore.
        decorateRequest: false,
        albMultiValueHeaders,
        enforceBase64: ({ headers }) => {
          const type = headers['content-type']
          const encoding = headers['content-encoding']
          return (
            (typeof type === 'string' && isBinary(type)) ||
            // Compressed (`@fastify/compress`).
            (typeof encoding === 'string' && encoding !== 'identity')
          )
        },
      }) as unknown as LambdaHandler
    const single = create(false)
    const multi = create(true)

    return async (event, context) => {
      const prepared = prepare(event as EventShape)
      if (
        prepared.requestContext?.elb === undefined ||
        !prepared.multiValueHeaders
      ) {
        return single(prepared, context)
      }
      // Load balancers with multi-value headers only read these ones.
      const result = await multi(prepared, context)
      delete result.headers
      return result
    }
  }

  let ready: Promise<LambdaHandler> | undefined
  let failure: LambdaHandler | undefined

  const init = async (): Promise<LambdaHandler> => {
    const app = await factory()
    const native: unknown = app?.native?.()
    if (typeof (native as Partial<FastifyInstance>)?.inject !== 'function') {
      throw new TypeError(
        'createLambdaHandler() expects an app created with fastifyAdapter() of @dotpress/adapter-fastify.'
      )
    }
    return toHandler(native as FastifyInstance)
  }

  return async (event, context) => {
    const current = (ready ??= init())
    let handler: LambdaHandler
    try {
      handler = await current
    } catch (error) {
      // Retried at the next invocation.
      if (ready === current) ready = undefined
      logger.error(
        error instanceof Error ? error : { error },
        'Failed to create the app'
      )
      failure ??= toHandler(failureApp())
      return failure(event, context)
    }
    return handler(event, context)
  }
}
