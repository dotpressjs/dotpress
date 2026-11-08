import { createFetchTarget, type ConformanceTarget } from './conformance.js'

/**
 * Lambda event formats: API Gateway REST API (payload v1), HTTP API and
 * Function URLs (payload v2), Application Load Balancer (with multi-value
 * headers, required for repeated query keys and several cookies).
 */
export type LambdaEventFormat = 'v1' | 'v2' | 'alb'

export interface LambdaTargetOptions {
  format: LambdaEventFormat
  /** Stops the application. */
  close: () => Promise<void>
  /** Client IP address of the events. Defaults to `127.0.0.1`. */
  sourceIp?: string
}

/** Lambda handler under test (`createLambdaHandler()` of an adapter). */
export type LambdaTestHandler = (
  event: never,
  context: never
) => Promise<unknown>

interface LambdaResult {
  statusCode: number
  headers?: Record<string, string | string[]>
  multiValueHeaders?: Record<string, string[]>
  cookies?: string[]
  body?: string
  isBase64Encoded?: boolean
}

const CHUNK = 0x8000

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

const decodeBase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

const TEXT_TYPES =
  /^\s*(text\/|application\/(json|x-www-form-urlencoded)\b|[^;]*\+json\b)/i

/** Body of the event: text when possible, else base64, like API Gateway. */
const eventBody = (bytes: Uint8Array, contentType: string | null) => {
  if (bytes.byteLength === 0) return { body: null, isBase64Encoded: false }
  if (contentType && TEXT_TYPES.test(contentType)) {
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { body, isBase64Encoded: false }
    } catch {
      // Invalid UTF-8: sent in base64.
    }
  }
  return { body: encodeBase64(bytes), isBase64Encoded: true }
}

/** Query parameters as sent (ALB does not decode them). */
const rawQuery = (search: string) => {
  const result: Record<string, string[]> = {}
  for (const pair of search.slice(1).split('&')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    const key = index === -1 ? pair : pair.slice(0, index)
    const value = index === -1 ? '' : pair.slice(index + 1)
    ;(result[key] ??= []).push(value)
  }
  return result
}

const lastValues = (values: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, list]) => [key, list.at(-1)!])
  )

const ACCOUNT = '123456789012'

/** Creates the Lambda event of a request. */
export const toLambdaEvent = async (
  request: Request,
  format: LambdaEventFormat,
  sourceIp = '127.0.0.1'
): Promise<Record<string, unknown>> => {
  const url = new URL(request.url)
  const headers: Record<string, string> = { host: url.host }
  for (const [name, value] of request.headers) headers[name] = value
  const { body, isBase64Encoded } = eventBody(
    new Uint8Array(await request.arrayBuffer()),
    request.headers.get('content-type')
  )
  const requestId = crypto.randomUUID()
  const userAgent = headers['user-agent'] ?? ''

  if (format === 'v2') {
    const { cookie, ...rest } = headers
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      ...(cookie ? { cookies: cookie.split(/;\s*/) } : {}),
      headers: rest,
      requestContext: {
        accountId: ACCOUNT,
        apiId: 'api',
        domainName: url.host,
        domainPrefix: url.hostname.split('.')[0],
        http: {
          method: request.method,
          path: url.pathname,
          protocol: 'HTTP/1.1',
          sourceIp,
          userAgent,
        },
        requestId,
        routeKey: '$default',
        stage: '$default',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
      ...(body === null ? {} : { body }),
      isBase64Encoded,
    }
  }

  const query: Record<string, string[]> = {}
  for (const [key, value] of url.searchParams) (query[key] ??= []).push(value)
  const multiValueHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, [value]])
  )

  if (format === 'alb') {
    return {
      requestContext: {
        elb: {
          targetGroupArn: `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:targetgroup/dotpress/0123456789abcdef`,
        },
      },
      httpMethod: request.method,
      path: url.pathname,
      multiValueQueryStringParameters: rawQuery(url.search),
      // The load balancer appends the client address.
      multiValueHeaders: {
        ...multiValueHeaders,
        'x-forwarded-for': [
          headers['x-forwarded-for']
            ? `${headers['x-forwarded-for']}, ${sourceIp}`
            : sourceIp,
        ],
        'x-forwarded-proto': [url.protocol.slice(0, -1)],
      },
      body: body ?? '',
      isBase64Encoded,
    }
  }

  const hasQuery = Object.keys(query).length > 0
  return {
    resource: '/{proxy+}',
    path: url.pathname,
    httpMethod: request.method,
    headers,
    multiValueHeaders,
    queryStringParameters: hasQuery ? lastValues(query) : null,
    multiValueQueryStringParameters: hasQuery ? query : null,
    pathParameters: { proxy: url.pathname.slice(1) },
    stageVariables: null,
    requestContext: {
      accountId: ACCOUNT,
      apiId: 'api',
      domainName: url.host,
      httpMethod: request.method,
      identity: { sourceIp, userAgent },
      path: url.pathname,
      protocol: 'HTTP/1.1',
      requestId,
      requestTimeEpoch: Date.now(),
      resourcePath: '/{proxy+}',
      stage: '$default',
    },
    body,
    isBase64Encoded,
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** Converts the result of a Lambda handler into a Web response. */
export const fromLambdaResult = (result: unknown): Response => {
  const { statusCode, headers, multiValueHeaders, cookies, body, ...rest } =
    result as LambdaResult

  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(headers ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      responseHeaders.append(name, item)
    }
  }
  for (const [name, values] of Object.entries(multiValueHeaders ?? {})) {
    for (const value of values) responseHeaders.append(name, value)
  }
  for (const cookie of cookies ?? []) {
    responseHeaders.append('set-cookie', cookie)
  }

  const content =
    !body || NULL_BODY_STATUSES.has(statusCode)
      ? null
      : rest.isBase64Encoded
        ? decodeBase64(body)
        : body

  return new Response(content as BodyInit | null, {
    status: statusCode,
    headers: responseHeaders,
  })
}

const lambdaContext = () => ({
  awsRequestId: crypto.randomUUID(),
  functionName: 'dotpress-test',
  functionVersion: '$LATEST',
  invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:dotpress-test`,
  memoryLimitInMB: '128',
  logGroupName: '/aws/lambda/dotpress-test',
  logStreamName: 'test',
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 30_000,
})

/**
 * Target for AWS Lambda handlers: each request is sent as a simulated
 * event of the given format, and the result converted back. A failed
 * invocation gets a `502` response, like API Gateway.
 */
export const createLambdaTarget = (
  handler: LambdaTestHandler,
  options: LambdaTargetOptions
): ConformanceTarget => {
  const invoke = handler as unknown as (
    event: unknown,
    context: unknown
  ) => Promise<unknown>

  return createFetchTarget(async (request) => {
    const event = await toLambdaEvent(request, options.format, options.sourceIp)
    let result: unknown
    try {
      result = await invoke(event, lambdaContext())
    } catch {
      return Response.json(
        { message: 'Internal server error' },
        { status: 502 }
      )
    }
    return fromLambdaResult(result)
  }, options.close)
}
