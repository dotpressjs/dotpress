// `@dotpress/core/adapter`: what HTTP adapters need, besides the
// `HttpAdapter`, `NormalizedRequest` and `NormalizedResponse` types of the
// main entry. Applications do not need it.

export type { CompiledRoute, DotpressRuntime } from './adapter.js'

export {
  DEFAULT_BODY_LIMIT,
  parseQueryString,
  parseRequestBody,
  type ParsedBody,
} from './body.js'

export {
  malformedBodyError,
  payloadTooLargeError,
  unsupportedMediaTypeError,
} from './errors.js'

export {
  createRouteMatcher,
  type RouteMatch,
  type RouteMatcher,
} from './matcher.js'

export {
  fromWebRequest,
  readRequestBody,
  toWebResponse,
  type RequestBody,
  type WebRequestOptions,
} from './web.js'
