import {
  createConsoleLogger,
  internalError,
  toErrorBody,
  type App,
  type Logger,
} from '@dotpress/core'
import { handle } from '@hono/aws-lambda'
import { Hono } from 'hono'
import type { HonoApplication } from './index.js'
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

/** App of the factory, created with `honoAdapter()`. */
export type LambdaApp = Pick<App<HonoApplication>, 'native'>

/** Answers `500 INTERNAL_ERROR` when the app cannot be created. */
const failureApp = () =>
  new Hono().all(
    '*',
    () =>
      new Response(JSON.stringify(toErrorBody(internalError())), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
  )

/**
 * Creates the AWS Lambda handler of an app (`@hono/aws-lambda`).
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
 *   createApp({ adapter: honoAdapter(), plugins: [authPlugin(auth)] })
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
  const toHandler = (app: HonoApplication) =>
    handle(app as unknown as Hono, {
      isContentTypeBinary: options.isContentTypeBinary,
    }) as unknown as LambdaHandler

  let ready: Promise<LambdaHandler> | undefined
  let failure: LambdaHandler | undefined

  const init = async (): Promise<LambdaHandler> => {
    const app = await factory()
    const native: unknown = app?.native?.()
    if (typeof (native as Partial<HonoApplication>)?.fetch !== 'function') {
      throw new TypeError(
        'createLambdaHandler() expects an app created with honoAdapter() of @dotpress/adapter-hono.'
      )
    }
    return toHandler(native as HonoApplication)
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
      failure ??= toHandler(failureApp() as unknown as HonoApplication)
      return failure(event, context)
    }
    return handler(event, context)
  }
}
