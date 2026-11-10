import { MemoBatchError } from './errors.js'

/** Options shared by every memo. */
interface BaseMemoOptions {
  /**
   * Name of the memo, used in errors: letters, digits, `.`, `_`, `:` and
   * `-`.
   */
  name: string
}

/** Options of a memo that loads one value at a time. */
export interface LoadMemoOptions<
  A extends readonly unknown[],
  T,
> extends BaseMemoOptions {
  /** Loads the value of the arguments. */
  load: (...args: A) => T | Promise<T>
  /**
   * Key of the arguments. Defaults to the arguments themselves: strings,
   * numbers, booleans, `null`, `undefined`, bigints, dates, arrays and
   * plain objects.
   */
  key?: ((...args: A) => unknown) | undefined
  batch?: never
}

/** Options of a memo that loads the values of several keys at once. */
export interface BatchMemoOptions<K, R> extends BaseMemoOptions {
  /**
   * Loads the values of the keys requested in the same tick, without
   * duplicates. Returns their values in the order of the keys (an `Error`
   * fails its key only), or a `Map` by key (a missing key gives
   * `undefined`).
   */
  batch: (keys: readonly K[]) => R | Promise<R>
  /** Key of a requested key, for keys that are objects. */
  key?: ((key: K) => unknown) | undefined
  /** Keys per call of `batch`. Defaults to no limit. */
  maxBatchSize?: number | undefined
  /**
   * Schedules a batch. Defaults to a timer (`setTimeout(run, 0)`): the
   * batch receives every key requested before it.
   */
  schedule?: ((run: () => void) => void) | undefined
  load?: never
}

declare const memoTypes: unique symbol

/** A memoized loader, created by `defineMemo()`. */
export interface MemoDefinition<A extends readonly unknown[], T> {
  readonly name: string
  /** Types only. */
  readonly [memoTypes]?: { args: A; value: T }
}

/** Memoized values of a unit of work: a request, a message, a job. */
export interface Memo {
  /**
   * Loads the value of the arguments once per memo: later calls, and
   * calls made while it loads, share the result. Failures are shared by
   * the calls in progress, not kept.
   */
  <A extends readonly unknown[], T>(
    memo: MemoDefinition<A, T>,
    ...args: A
  ): Promise<T>
  /** Sets the value of the arguments, after an update for instance. */
  set<A extends readonly unknown[], T>(
    memo: MemoDefinition<A, T>,
    ...argsAndValue: [...A, T]
  ): void
  /** Forgets the value of the arguments: the next call loads it again. */
  delete<A extends readonly unknown[], T>(
    memo: MemoDefinition<A, T>,
    ...args: A
  ): void
  /** Forgets the values of a memo, or of every memo. */
  clear<A extends readonly unknown[], T>(memo?: MemoDefinition<A, T>): void
}

type Config =
  | {
      kind: 'load'
      name: string
      load: (...args: readonly unknown[]) => unknown
      key: ((...args: readonly unknown[]) => unknown) | undefined
    }
  | {
      kind: 'batch'
      name: string
      batch: (keys: readonly unknown[]) => unknown
      key: ((key: unknown) => unknown) | undefined
      maxBatchSize: number
      schedule: (run: () => void) => void
    }

const configs = new WeakMap<object, Config>()

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPTIONS = {
  load: new Set(['name', 'load', 'key']),
  batch: new Set(['name', 'batch', 'key', 'maxBatchSize', 'schedule']),
}

/**
 * Defines a memoized loader: `memo(loadUser, id)` loads a user once per
 * memo (request, message, job), and calls made while it loads share the
 * same load (single flight). With `batch`, the keys requested in the same
 * tick are loaded in one call.
 *
 * ```ts
 * const loadUser = defineMemo({
 *   name: 'user',
 *   load: (id: string) => db.users.findById(id),
 * })
 *
 * const loadOrder = defineMemo({
 *   name: 'order',
 *   batch: (ids: readonly string[]) => db.orders.findManyById(ids), // a Map by id
 * })
 * ```
 */
export function defineMemo<K, T>(
  options: BatchMemoOptions<K, ReadonlyMap<K, T>>
): MemoDefinition<[key: K], T | undefined>
export function defineMemo<K, T>(
  options: BatchMemoOptions<K, readonly (T | Error)[]>
): MemoDefinition<[key: K], T>
export function defineMemo<A extends readonly unknown[], T>(
  options: LoadMemoOptions<A, T>
): MemoDefinition<A, T>
export function defineMemo(options: unknown): { readonly name: string } {
  const label = 'defineMemo()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  const values = options as Record<string, unknown>
  const { name } = values
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `${label}: name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.`
    )
  }
  const named = `defineMemo("${name}")`
  const kind = values.batch === undefined ? 'load' : 'batch'
  if (kind === 'batch' && values.load !== undefined) {
    throw new TypeError(`${named}: set load or batch, not both.`)
  }
  for (const key of Object.keys(values)) {
    if (!OPTIONS[kind].has(key)) {
      throw new TypeError(`${named}: unknown option "${key}".`)
    }
  }
  const { key } = values
  if (key !== undefined && typeof key !== 'function') {
    throw new TypeError(`${named}: key must be a function.`)
  }

  let config: Config
  if (kind === 'load') {
    if (typeof values.load !== 'function') {
      throw new TypeError(`${named}: load or batch must be a function.`)
    }
    config = {
      kind,
      name,
      load: values.load as (...args: readonly unknown[]) => unknown,
      key: key as ((...args: readonly unknown[]) => unknown) | undefined,
    }
  } else {
    const {
      batch,
      maxBatchSize = Infinity,
      schedule = defaultSchedule,
    } = values
    if (typeof batch !== 'function') {
      throw new TypeError(`${named}: batch must be a function.`)
    }
    if (
      maxBatchSize !== Infinity &&
      (!Number.isInteger(maxBatchSize) || (maxBatchSize as number) < 1)
    ) {
      throw new TypeError(`${named}: maxBatchSize must be a positive integer.`)
    }
    if (typeof schedule !== 'function') {
      throw new TypeError(`${named}: schedule must be a function.`)
    }
    config = {
      kind,
      name,
      batch: batch as (keys: readonly unknown[]) => unknown,
      key: key as ((key: unknown) => unknown) | undefined,
      maxBatchSize: maxBatchSize as number,
      schedule: schedule as (run: () => void) => void,
    }
  }

  const memo = Object.freeze({ name })
  configs.set(memo, config)
  return memo
}

const defaultSchedule = (run: () => void) => {
  setTimeout(run, 0)
}

/**
 * Serializes a value to a key: the same for equal values, whatever the
 * order of the properties of objects.
 */
const keyOf = (name: string, value: unknown): string => {
  const seen = new Set<object>()
  const serialize = (item: unknown): string => {
    switch (typeof item) {
      case 'string':
        return JSON.stringify(item)
      case 'number':
      case 'boolean':
        return String(item)
      case 'bigint':
        return `${item}n`
      case 'undefined':
        return 'undefined'
    }
    if (item === null) return 'null'
    if (item instanceof Date) return `Date(${item.getTime()})`
    if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item) as unknown
      const plain = prototype === Object.prototype || prototype === null
      if (Array.isArray(item) || plain) {
        if (seen.has(item)) {
          throw new TypeError(
            `Memo "${name}": cannot build a key from a circular value.`
          )
        }
        seen.add(item)
        const serialized = Array.isArray(item)
          ? `[${item.map(serialize).join(',')}]`
          : `{${Object.keys(item)
              .filter(
                (key) => (item as Record<string, unknown>)[key] !== undefined
              )
              .sort()
              .map(
                (key) =>
                  `${JSON.stringify(key)}:${serialize((item as Record<string, unknown>)[key])}`
              )
              .join(',')}}`
        seen.delete(item)
        return serialized
      }
    }
    throw new TypeError(
      `Memo "${name}": cannot build a key from ${describe(item)}; add a key option that returns a string.`
    )
  }
  return serialize(value)
}

const describe = (value: unknown) =>
  typeof value === 'function'
    ? 'a function'
    : typeof value === 'symbol'
      ? 'a symbol'
      : `an instance of ${(value as object).constructor?.name ?? 'an unknown class'}`

interface Deferred {
  key: unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/**
 * Creates a memo: one per request, message or job. Plugins provide
 * `ctx.memo`; create one yourself elsewhere.
 *
 * ```ts
 * const memo = createMemo()
 * const [ada, grace] = await Promise.all([memo(loadUser, '1'), memo(loadUser, '2')])
 * ```
 */
export const createMemo = (): Memo => {
  const values = new Map<Config, Map<string, Promise<unknown>>>()
  const queues = new Map<Config, Deferred[]>()

  const configOf = (label: string, memo: unknown) => {
    const config =
      typeof memo === 'object' && memo !== null ? configs.get(memo) : undefined
    if (!config) {
      throw new TypeError(`${label}: expected a memo created by defineMemo().`)
    }
    return config
  }

  const keyFor = (config: Config, args: readonly unknown[]) =>
    config.kind === 'load'
      ? keyOf(config.name, config.key ? config.key(...args) : args)
      : keyOf(config.name, config.key ? config.key(args[0]) : args[0])

  const valuesOf = (config: Config) => {
    let map = values.get(config)
    if (!map) {
      map = new Map()
      values.set(config, map)
    }
    return map
  }

  /** Runs the queued keys of a batch memo, in calls of maxBatchSize. */
  const runBatch = (config: Extract<Config, { kind: 'batch' }>) => {
    const queue = queues.get(config) ?? []
    queues.delete(config)
    for (let start = 0; start < queue.length; start += config.maxBatchSize) {
      const chunk = queue.slice(start, start + config.maxBatchSize)
      void (async () => {
        let result: unknown
        try {
          result = await config.batch(chunk.map(({ key }) => key))
        } catch (error) {
          for (const { reject } of chunk) reject(error)
          return
        }
        if (Array.isArray(result)) {
          if (result.length !== chunk.length) {
            const error = new MemoBatchError(
              config.name,
              `batch() returned ${result.length} values for ${chunk.length} keys: return one value per key, in the order of the keys, or a Map.`
            )
            for (const { reject } of chunk) reject(error)
            return
          }
          chunk.forEach(({ resolve, reject }, index) => {
            const value: unknown = result[index]
            if (value instanceof Error) reject(value)
            else resolve(value)
          })
        } else if (result instanceof Map) {
          for (const { key, resolve } of chunk) resolve(result.get(key))
        } else {
          const error = new MemoBatchError(
            config.name,
            'batch() must return an array of values, in the order of the keys, or a Map.'
          )
          for (const { reject } of chunk) reject(error)
        }
      })()
    }
  }

  const loadOf = (config: Config, args: readonly unknown[]) => {
    if (config.kind === 'load') {
      return (async () => config.load(...args))()
    }
    return new Promise<unknown>((resolve, reject) => {
      let queue = queues.get(config)
      if (!queue) {
        queue = []
        queues.set(config, queue)
        config.schedule(() => runBatch(config))
      }
      queue.push({ key: args[0], resolve, reject })
    })
  }

  const memo = (<A extends readonly unknown[], T>(
    definition: MemoDefinition<A, T>,
    ...args: A
  ): Promise<T> => {
    const config = configOf('memo()', definition)
    const map = valuesOf(config)
    const key = keyFor(config, args)
    const known = map.get(key)
    if (known) return known as Promise<T>

    const loading = loadOf(config, args)
    map.set(key, loading)
    // Failures are not kept: the next call loads again.
    loading.catch(() => {
      if (map.get(key) === loading) map.delete(key)
    })
    return loading as Promise<T>
  }) as Memo

  memo.set = (definition, ...argsAndValue) => {
    const config = configOf('memo.set()', definition)
    const args = argsAndValue.slice(0, -1)
    valuesOf(config).set(
      keyFor(config, args),
      Promise.resolve(argsAndValue.at(-1))
    )
  }
  memo.delete = (definition, ...args) => {
    const config = configOf('memo.delete()', definition)
    valuesOf(config).delete(keyFor(config, args))
  }
  memo.clear = (definition) => {
    if (definition === undefined) {
      values.clear()
      return
    }
    values.delete(configOf('memo.clear()', definition))
  }
  return Object.freeze(memo)
}
