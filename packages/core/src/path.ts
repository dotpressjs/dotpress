/** Object type without any property. */
export type EmptyObject = Record<never, never>

/** Flattens an intersection into a single object type. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

type ParamNames<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Param}/${infer Tail}`
    ? Param | ParamNames<`/${Tail}`>
    : Rest
  : never

/**
 * Path parameters inferred from a route path.
 *
 * @example PathParams<'/orgs/:orgId/members/:id'> // { orgId: string; id: string }
 */
export type PathParams<P extends string> = string extends P
  ? Record<string, string>
  : Simplify<{ [K in ParamNames<P>]: string }>

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const FORBIDDEN_STATIC_CHARS = /[:*?(){}]/

/**
 * Validates and normalizes a route path: leading slash, no trailing slash,
 * no duplicate slashes. Only `:param` segments are supported.
 */
export const normalizePath = (path: string): string => {
  if (!path.startsWith('/')) {
    throw new TypeError(`Route path must start with "/": "${path}"`)
  }

  const segments = path.split('/').filter((segment) => segment !== '')

  for (const segment of segments) {
    if (segment.startsWith(':')) {
      if (!PARAM_NAME.test(segment.slice(1))) {
        throw new TypeError(
          `Invalid path parameter "${segment}" in "${path}". Parameter names must match ${PARAM_NAME}.`
        )
      }
    } else if (FORBIDDEN_STATIC_CHARS.test(segment)) {
      throw new TypeError(
        `Unsupported path syntax "${segment}" in "${path}". Only static segments and ":param" segments are supported.`
      )
    }
  }

  return `/${segments.join('/')}`
}

/**
 * Joins a group prefix and a route path.
 */
export const joinPaths = (prefix: string, path: string): string => {
  if (prefix === '' || prefix === '/') {
    return normalizePath(path)
  }

  return normalizePath(`${normalizePath(prefix)}/${normalizePath(path)}`)
}

/**
 * Validates and normalizes a base path option (`basePath`,
 * `publicBasePath`). Returns an empty string for `/`, which means no
 * prefix.
 */
export const normalizeBasePath = (value: unknown, option: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new TypeError(
      `Invalid ${option}: expected a path starting with "/", received ${JSON.stringify(value)}.`
    )
  }

  const path = normalizePath(value)

  if (getPathParamNames(path).length > 0) {
    throw new TypeError(
      `Invalid ${option} "${value}": a base path cannot contain parameters.`
    )
  }

  return path === '/' ? '' : path
}

/**
 * Prefixes a path with a normalized base path. The path may contain a query
 * string or a fragment.
 */
export const prefixPath = (basePath: string, path: string): string => {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(
      `publicPath() expects a path starting with "/", received ${JSON.stringify(path)}.`
    )
  }

  if (basePath === '') return path
  return path === '/' ? basePath : `${basePath}${path}`
}

/**
 * Names of the parameters declared in a path.
 */
export const getPathParamNames = (path: string): string[] =>
  path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))

/**
 * Key identifying a route regardless of its parameter names, used to detect
 * conflicting definitions (`/users/:id` and `/users/:userId`).
 */
export const routeKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.replace(/\/:[^/]+/g, '/:')}`
