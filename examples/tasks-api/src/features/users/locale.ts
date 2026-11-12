/**
 * The best of the supported locales for an `Accept-Language` header
 * (`fr-CA,fr;q=0.9,en;q=0.8`): exact tags first, then base languages, by
 * decreasing quality. Undefined when none is supported.
 */
export const negotiateLocale = <L extends string>(
  header: string | undefined,
  supported: readonly L[]
): L | undefined => {
  const requested = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='))
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1, index }
    })
    .filter(({ tag, q }) => tag !== '' && tag !== '*' && q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)

  const lower = supported.map((locale) => locale.toLowerCase())
  for (const { tag } of requested) {
    const exact = lower.indexOf(tag)
    if (exact !== -1) return supported[exact]
    const base = lower.indexOf(tag.split('-')[0]!)
    if (base !== -1) return supported[base]
  }
  return undefined
}
