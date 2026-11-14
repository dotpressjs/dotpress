/**
 * Throws a `TypeError` for a key of `options` that is not in `known`: a
 * misspelled option would otherwise be ignored without a word.
 */
export const assertKnownOptions = (
  label: string,
  options: object,
  known: readonly string[],
  prefix = ''
): void => {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: options must be an object.`)
  }
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new TypeError(`${label}: unknown option "${prefix}${key}".`)
    }
  }
}
