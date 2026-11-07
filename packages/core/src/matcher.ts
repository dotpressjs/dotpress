import type { CompiledRoute } from './adapter.js'
import type { HttpMethod } from './http.js'

export interface RouteMatch {
  readonly route: CompiledRoute
  /** Decoded path parameters. */
  readonly params: Record<string, string>
}

export interface RouteMatcher {
  /**
   * Finds the route handling a request. `path` is the URL pathname, still
   * percent-encoded.
   */
  match(method: string, path: string): RouteMatch | undefined
  /**
   * Methods accepted by a path (`HEAD` included when `GET` is), in a stable
   * order. Empty when no route matches the path.
   */
  allowedMethods(path: string): HttpMethod[]
}

/** Order of the methods listed in `Allow` headers. */
const ALLOW_ORDER: readonly HttpMethod[] = [
  'get',
  'head',
  'post',
  'put',
  'patch',
  'delete',
  'options',
]

interface Terminal {
  readonly route: CompiledRoute
  /** Position and name of each path parameter. */
  readonly params: readonly (readonly [index: number, name: string])[]
}

interface Node {
  readonly children: Map<string, Node>
  param: Node | undefined
  terminal: Terminal | undefined
}

const createNode = (): Node => ({
  children: new Map(),
  param: undefined,
  terminal: undefined,
})

const splitPath = (path: string): string[] =>
  path.split('/').filter((segment) => segment !== '')

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Invalid percent-encoding: keep the raw segment.
    return segment
  }
}

const find = (
  node: Node,
  segments: readonly string[],
  index: number
): Terminal | undefined => {
  if (index === segments.length) {
    return node.terminal
  }

  // Static segments take priority over parameters.
  const child = node.children.get(segments[index]!)
  const fromStatic = child && find(child, segments, index + 1)
  if (fromStatic) return fromStatic

  return node.param && find(node.param, segments, index + 1)
}

/**
 * Builds the reference route matcher. Adapters may rely on their native
 * router instead, as long as they follow the same rules:
 *
 * - matching is case-sensitive;
 * - trailing and duplicate slashes are ignored;
 * - static segments take priority over parameters, whatever the
 *   declaration order;
 * - path segments are percent-decoded before matching, so parameters hold
 *   decoded values;
 * - `HEAD` requests fall back on the `GET` route when no `HEAD` route is
 *   defined;
 * - other methods only match routes declared with that method.
 */
export const createRouteMatcher = (
  routes: readonly CompiledRoute[]
): RouteMatcher => {
  const trees = new Map<string, Node>()

  for (const route of routes) {
    let tree = trees.get(route.method)
    if (!tree) {
      tree = createNode()
      trees.set(route.method, tree)
    }

    const params: [number, string][] = []
    let node = tree

    for (const [index, segment] of splitPath(route.path).entries()) {
      if (segment.startsWith(':')) {
        params.push([index, segment.slice(1)])
        node.param ??= createNode()
        node = node.param
      } else {
        const key = decodeSegment(segment)
        let child = node.children.get(key)
        if (!child) {
          child = createNode()
          node.children.set(key, child)
        }
        node = child
      }
    }

    if (node.terminal) {
      throw new Error(
        `Route conflict: "${route.method.toUpperCase()} ${route.path}" is already defined as "${node.terminal.route.method.toUpperCase()} ${node.terminal.route.path}".`
      )
    }

    node.terminal = { route, params }
  }

  const lookup = (method: string, segments: readonly string[]) => {
    const tree = trees.get(method)
    return tree && find(tree, segments, 0)
  }

  return {
    match(method, path) {
      const normalizedMethod = method.toLowerCase()
      const segments = splitPath(path).map(decodeSegment)

      const terminal =
        lookup(normalizedMethod, segments) ??
        (normalizedMethod === 'head' ? lookup('get', segments) : undefined)

      if (!terminal) return undefined

      return {
        route: terminal.route,
        params: Object.fromEntries(
          terminal.params.map(([index, name]) => [name, segments[index]!])
        ),
      }
    },

    allowedMethods(path) {
      const segments = splitPath(path).map(decodeSegment)
      const accepted = new Set<HttpMethod>()

      for (const method of ALLOW_ORDER) {
        if (lookup(method, segments)) accepted.add(method)
      }
      if (accepted.has('get')) accepted.add('head')

      return ALLOW_ORDER.filter((method) => accepted.has(method))
    },
  }
}
