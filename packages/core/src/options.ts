/**
 * Throws a `TypeError` for a key of `options` that is not in `known`: a
 * misspelled option would otherwise be ignored without a word.
 */
export const assertKnownOptions = (
  label: string,
  options: object,
  known: ReadonlySet<string>,
  prefix = ''
): void => {
  for (const key of Object.keys(options)) {
    if (!known.has(key)) {
      throw new TypeError(`${label}: unknown option "${prefix}${key}".`)
    }
  }
}
