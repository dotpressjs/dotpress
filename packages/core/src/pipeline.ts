import * as z from 'zod'
import type { CompiledRoute, RouteInfo } from './adapter.js'
import type { Middleware, RequestContext, ResponseFilter } from './context.js'
import {
  HttpError,
  isHttpError,
  methodNotAllowedError,
  routeNotFoundError,
  toErrorBody,
  validationError,
  type ValidationIssue,
} from './errors.js'
import type {
  NormalizedRequest,
  NormalizedResponse,
  ResponseHeaders,
} from './http.js'
import type { Logger } from './logger.js'
import type { RouteMatcher } from './matcher.js'
import {
  getDeclaredContextKeys,
  type BaseContextKey,
  type RequestHook,
  type ResponseEvent,
  type ResponseHook,
} from './plugins.js'
import { getPathParamNames } from './path.js'
import { createRequest, type MutableRequest } from './request.js'
import {
  createResponseState,
  mergeHeaders,
  type ResponseState,
} from './response.js'
import { isResponseResult, type RawResult, type ResultInit } from './results.js'
import type { RouteRecord } from './routes.js'
import type { RouteSchema, Schema } from './schema.js'
import {
  SSE_HEARTBEAT,
  createResponseStream,
  encodeChunk,
  encodeSseMessage,
  openStreamSource,
} from './streaming.js'

/**
 * Hook called with unexpected errors (anything but an `HttpError`).
 * `ctx` is undefined when the error happened outside a route.
 */
export type ErrorHook = (
  error: unknown,
  ctx: RequestContext | undefined
) => void | Promise<void>

export interface PipelineConfig {
  readonly logger: Logger
  readonly exposeErrors: boolean
  readonly generateRequestId: (request: NormalizedRequest) => string
  readonly onError: ErrorHook | undefined
  readonly middlewares: readonly Middleware[]
  readonly responseFilters: readonly ResponseFilter[]
  /** Context keys provided by plugins (`decorateContext()`). */
  readonly contextFactories: ReadonlyMap<
    string,
    (ctx: RequestContext) => unknown
  >
  readonly requestHooks: readonly RequestHook[]
  readonly responseHooks: readonly ResponseHook[]
}

/**
 * Defines the context keys provided by plugins, and guards declared keys of
 * plugins that are not installed.
 */
const decorateContext = (ctx: RequestContext, config: PipelineConfig) => {
  for (const [key, factory] of config.contextFactories) {
    let state: { value: unknown } | undefined
    Object.defineProperty(ctx, key, {
      configurable: true,
      enumerable: true,
      get: () => (state ??= { value: factory(ctx) }).value,
      set: (value: unknown) => {
        state = { value }
      },
    })
  }

  for (const [key, pluginName] of getDeclaredContextKeys()) {
    if (config.contextFactories.has(key)) continue
    Object.defineProperty(ctx, key, {
      configurable: true,
      enumerable: false,
      get: () => {
        throw new Error(
          `"ctx.${key}" is used, but the "${pluginName}" plugin is not installed in createApp().`
        )
      },
      // Middlewares may still set the key themselves.
      set: (value: unknown) => {
        Object.defineProperty(ctx, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        })
      },
    })
  }
}

/**
 * Runs the response hooks. A failing hook is logged and ignored.
 */
const applyResponseHooks = async (
  config: PipelineConfig,
  logger: Logger,
  event: ResponseEvent
): Promise<NormalizedResponse> => {
  let response = event.response

  for (const hook of config.responseHooks) {
    try {
      const replacement = await hook({ ...event, response })
      if (replacement) response = replacement
    } catch (error) {
      logger.error(
        error instanceof Error ? error : { error },
        'onResponse hook failed'
      )
    }
  }

  return response
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'
const REQUEST_ID_HEADER = 'x-request-id'
const VALIDATED_SOURCES = ['params', 'query', 'body', 'files'] as const

/**
 * Raised when a handler result does not match the route response schema.
 */
class ResponseValidationError extends Error {
  constructor(
    readonly issues: {
      path: (string | number)[]
      code: string
      message: string
    }[]
  ) {
    super('Response validation failed')
    this.name = 'ResponseValidationError'
  }
}

const isNeverSchema = (schema: Schema | undefined) =>
  schema?._zod.def.type === 'never'

const toPath = (path: readonly PropertyKey[]): (string | number)[] =>
  path.map((key) => (typeof key === 'symbol' ? key.toString() : key))

export const resolveSchema = (route: RouteRecord): RouteSchema => {
  const resolved =
    typeof route.schema === 'function' ? route.schema(z) : route.schema

  if (resolved === undefined) {
    return {}
  }

  if (typeof resolved !== 'object' || resolved === null) {
    throw new TypeError(`Invalid schema for route "${route.path}".`)
  }

  for (const key of ['params', 'query', 'body', 'files', 'response'] as const) {
    const schema = resolved[key]
    if (schema !== undefined && !(schema instanceof z.core.$ZodType)) {
      throw new TypeError(
        `Invalid "${key}" schema for route "${route.path}": expected a Zod 4 schema.`
      )
    }
  }

  return resolved
}

const jsonResponse = (
  status: number,
  data: unknown,
  headers?: ResponseHeaders
): NormalizedResponse => {
  const body = JSON.stringify(data)

  // `JSON.stringify` returns undefined for undefined, functions and symbols.
  if (body === undefined) {
    return {
      status: 204,
      headers: mergeHeaders(headers),
      body: null,
      kind: 'empty',
    }
  }

  return {
    status,
    headers: mergeHeaders(headers, { 'content-type': JSON_CONTENT_TYPE }),
    body,
    kind: 'json',
  }
}

const errorToResponse = (
  error: HttpError,
  headers?: ResponseHeaders
): NormalizedResponse => jsonResponse(error.status, toErrorBody(error), headers)

const withRequestId = (
  response: NormalizedResponse,
  requestId: string
): NormalizedResponse => ({
  ...response,
  headers: { ...response.headers, [REQUEST_ID_HEADER]: requestId },
})

/**
 * Shared error handling, used inside routes and by the runtime.
 */
export const createErrorHandler = (config: PipelineConfig) => {
  const internalErrorResponse = (error: unknown): NormalizedResponse => {
    let data: Record<string, unknown> | undefined

    if (config.exposeErrors) {
      data =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { value: String(error) }

      if (error instanceof ResponseValidationError) {
        data.issues = error.issues
      }
    }

    return errorToResponse(
      new HttpError(500, 'INTERNAL_ERROR', 'Internal Server Error', data)
    )
  }

  /**
   * Logs an unexpected error and calls the `onError` hook. Never rejects.
   */
  const report = async (
    error: unknown,
    logger: Logger,
    ctx: RequestContext | undefined,
    message = 'Unhandled error while processing request'
  ): Promise<void> => {
    logger.error(error instanceof Error ? error : { error }, message)

    if (config.onError) {
      try {
        await config.onError(error, ctx)
      } catch (hookError) {
        logger.error(
          hookError instanceof Error ? hookError : { error: hookError },
          'onError hook failed'
        )
      }
    }
  }

  /**
   * Converts a thrown or returned error into a response. `headers` are the
   * headers set by the request, kept for `HttpError` only.
   */
  const handle = async (
    error: unknown,
    logger: Logger,
    ctx: RequestContext | undefined,
    headers?: ResponseHeaders
  ): Promise<NormalizedResponse> => {
    if (isHttpError(error)) {
      return errorToResponse(error, headers)
    }

    await report(error, logger, ctx)
    return internalErrorResponse(error)
  }

  return { handle, report }
}

/**
 * Compiles a route into a `CompiledRoute`: resolves its schema once and
 * builds the request pipeline.
 */
export const compileRoute = (
  route: RouteRecord,
  routerFilters: readonly ResponseFilter[],
  config: PipelineConfig
): CompiledRoute => {
  const schema = resolveSchema(route)
  const middlewares: readonly (Middleware | RequestHook)[] = [
    ...config.requestHooks,
    ...config.middlewares,
    ...route.middlewares,
  ]
  const filters = [...config.responseFilters, ...routerFilters]
  const { handle: handleError, report: reportError } =
    createErrorHandler(config)

  const definition: RouteInfo = Object.freeze({
    method: route.method,
    path: route.path,
    pathParams: Object.freeze(getPathParamNames(route.path)),
    schema: Object.freeze({ ...schema }),
    meta: Object.freeze({ ...route.meta }),
    status: route.status,
    rawBody: route.rawBody,
    bodyLimit: route.bodyLimit,
  })

  const validateRequest = async (
    req: MutableRequest
  ): Promise<HttpError | undefined> => {
    const issues: ValidationIssue[] = []

    for (const source of VALIDATED_SOURCES) {
      const sourceSchema = schema[source]
      if (!sourceSchema) continue

      const result = await z.safeParseAsync(sourceSchema, req[source])

      if (result.success) {
        req[source] = result.data as never
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            source,
            path: toPath(issue.path),
            code: issue.code,
            message: issue.message,
          })
        }
      }
    }

    return issues.length > 0 ? validationError(issues) : undefined
  }

  const toJsonResponse = async (
    ctx: RequestContext,
    state: ResponseState,
    data: unknown,
    init: ResultInit
  ): Promise<NormalizedResponse> => {
    let output = data

    if (schema.response) {
      const result = await z.safeParseAsync(schema.response, data)
      if (!result.success) {
        throw new ResponseValidationError(
          result.error.issues.map((issue) => ({
            path: toPath(issue.path),
            code: issue.code,
            message: issue.message,
          }))
        )
      }
      output = result.data
    }

    for (const filter of filters) {
      output = await filter(ctx, output)
    }

    const status = init.status ?? state.statusCode ?? route.status ?? 200
    const responseHeaders = mergeHeaders(state.toHeaders(), init.headers)

    return jsonResponse(status, output, responseHeaders)
  }

  const toStreamBody = (
    ctx: RequestContext,
    result: Extract<RawResult, { kind: 'stream' | 'sse' }>
  ): ReadableStream<Uint8Array> => {
    const { signal } = ctx.req
    const onError = (error: unknown) =>
      void reportError(
        error,
        ctx.logger,
        ctx,
        'Error while streaming the response'
      )

    if (result.kind === 'stream') {
      return createResponseStream(openStreamSource(result.source, { signal }), {
        signal,
        encode: encodeChunk,
        onError,
      })
    }

    return createResponseStream(openStreamSource(result.source, { signal }), {
      signal,
      encode: (message) => encodeChunk(encodeSseMessage(message)),
      heartbeat:
        result.heartbeat === false
          ? undefined
          : { interval: result.heartbeat, chunk: SSE_HEARTBEAT },
      onError,
    })
  }

  const toRawResponse = (
    ctx: RequestContext,
    state: ResponseState,
    result: RawResult
  ): NormalizedResponse => {
    const headers = mergeHeaders(state.toHeaders(), result.init.headers)
    const status = result.init.status ?? state.statusCode

    switch (result.kind) {
      case 'text':
        return {
          status: status ?? route.status ?? 200,
          headers: mergeHeaders({ 'content-type': TEXT_CONTENT_TYPE }, headers),
          body: result.body,
          kind: 'text',
        }
      case 'stream':
      case 'sse':
        return {
          status: status ?? route.status ?? 200,
          headers,
          body: toStreamBody(ctx, result),
          kind: 'stream',
        }
      case 'file':
        return {
          status: status ?? route.status ?? 200,
          headers,
          body: result.body,
          kind: result.kind,
        }
      case 'redirect':
        return {
          status: result.init.status ?? 302,
          headers: mergeHeaders(headers, { location: result.location }),
          body: null,
          kind: 'redirect',
        }
      case 'empty':
        return {
          status: status ?? 204,
          headers,
          body: null,
          kind: 'empty',
        }
    }
  }

  const toResponse = async (
    ctx: RequestContext,
    state: ResponseState,
    result: unknown
  ): Promise<NormalizedResponse> => {
    if (isHttpError(result)) {
      return errorToResponse(result, state.toHeaders())
    }

    if (isResponseResult(result)) {
      return result.kind === 'json'
        ? toJsonResponse(ctx, state, result.data, result.init)
        : toRawResponse(ctx, state, result)
    }

    if (result === undefined) {
      return {
        status: state.statusCode ?? route.status ?? 204,
        headers: state.toHeaders(),
        body: null,
        kind: 'empty',
      }
    }

    if (isNeverSchema(schema.response)) {
      throw new ResponseValidationError([
        {
          path: [],
          code: 'invalid_type',
          message:
            'The route response schema is never, but the handler returned a value',
        },
      ])
    }

    return toJsonResponse(ctx, state, result, {})
  }

  const run = async (
    request: NormalizedRequest,
    requestId: string,
    logger: Logger,
    setContext: (ctx: RequestContext) => void
  ): Promise<NormalizedResponse> => {
    let ctx: RequestContext | undefined
    const state = createResponseState()

    try {
      const req = createRequest(request, { rawBody: route.rawBody })
      // Keys added through module augmentation are provided by plugins
      // (`decorateContext()`) or set by middlewares.
      const created = {
        req,
        res: state,
        requestId,
        logger,
        raw: request.raw,
      } satisfies Pick<
        RequestContext,
        BaseContextKey
      > as unknown as RequestContext
      ctx = created
      decorateContext(created, config)
      setContext(created)

      for (const middleware of middlewares) {
        const output = await middleware(created)

        if (output === undefined) continue

        if (isHttpError(output) || isResponseResult(output)) {
          return withRequestId(
            await toResponse(created, state, output),
            requestId
          )
        }

        throw new TypeError(
          'A middleware must return nothing, an HttpError or a response helper result.'
        )
      }

      const invalid = await validateRequest(req)
      if (invalid) {
        return withRequestId(
          errorToResponse(invalid, state.toHeaders()),
          requestId
        )
      }

      const result = await route.handler(
        created as Parameters<RouteRecord['handler']>[0]
      )

      return withRequestId(await toResponse(created, state, result), requestId)
    } catch (error) {
      const headers = isHttpError(error) ? state.toHeaders() : undefined
      return withRequestId(
        await handleError(error, logger, ctx, headers),
        requestId
      )
    }
  }

  const execute = async (
    request: NormalizedRequest
  ): Promise<NormalizedResponse> => {
    const startedAt = performance.now()
    let requestId: string
    let logger = config.logger
    let ctx: RequestContext | undefined
    let response: NormalizedResponse

    try {
      requestId = config.generateRequestId(request)
      logger = config.logger.child({ requestId })
      response = await run(request, requestId, logger, (created) => {
        ctx = created
      })
    } catch (error) {
      requestId = crypto.randomUUID()
      response = withRequestId(
        await handleError(error, logger, undefined),
        requestId
      )
    }

    return applyResponseHooks(config, logger, {
      request,
      response,
      requestId,
      ctx,
      route: definition,
      duration: performance.now() - startedAt,
    })
  }

  return Object.freeze({
    method: route.method,
    path: route.path,
    definition,
    execute,
  })
}

/**
 * Builds the runtime given to adapters.
 */
export const createRuntime = (
  config: PipelineConfig,
  matcher: RouteMatcher
) => {
  const { handle: handleError } = createErrorHandler(config)

  const requestIdFor = (request: NormalizedRequest | undefined) => {
    if (!request) return crypto.randomUUID()
    try {
      return config.generateRequestId(request)
    } catch {
      return crypto.randomUUID()
    }
  }

  const finish = (
    request: NormalizedRequest | undefined,
    requestId: string,
    response: NormalizedResponse,
    startedAt: number
  ) =>
    request
      ? applyResponseHooks(config, config.logger.child({ requestId }), {
          request,
          response,
          requestId,
          ctx: undefined,
          route: undefined,
          duration: performance.now() - startedAt,
        })
      : response

  return Object.freeze({
    logger: config.logger,
    handleNotFound: async (request: NormalizedRequest) => {
      const startedAt = performance.now()
      const requestId = requestIdFor(request)
      const allowed = matcher.allowedMethods(request.path)
      const response =
        allowed.length > 0
          ? errorToResponse(methodNotAllowedError(), {
              allow: allowed.map((method) => method.toUpperCase()).join(', '),
            })
          : errorToResponse(routeNotFoundError())

      return finish(
        request,
        requestId,
        withRequestId(response, requestId),
        startedAt
      )
    },
    handleError: async (error: unknown, request?: NormalizedRequest) => {
      const startedAt = performance.now()
      const requestId = requestIdFor(request)
      const logger = config.logger.child({ requestId })
      return finish(
        request,
        requestId,
        withRequestId(await handleError(error, logger, undefined), requestId),
        startedAt
      )
    },
  })
}
