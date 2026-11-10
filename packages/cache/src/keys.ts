/**
 * Serializes a value to a key: the same for equal values, whatever the
 * order of the properties of objects.
 */
export const keyOf = (name: string, value: unknown): string => {
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
            `${name}: cannot build a key from a circular value.`
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
      `${name}: cannot build a key from ${describe(item)}; add a key option that returns a string.`
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
