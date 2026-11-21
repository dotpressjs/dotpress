// Document mode: a tool that documents an app (`dotpress-openapi`) imports
// the module that creates it, such as the entry point of the server. While
// the mode is on, the apps created are recorded, `app.listen()` starts no
// server, and the factories of lazy entry points (AWS Lambda) are called
// right away.
//
// The tool turns the mode on with a global, shared by every copy of
// `@dotpress/core` loaded in the process. Its key and shape are a contract
// between the core and `@dotpress/openapi`, tested on both sides.

/** Key of the global set by the tool. */
export const DOCUMENT_MODE_KEY = Symbol.for('dotpress.core.documentMode')

/** The global set by the tool. */
export interface DocumentMode {
  /** The apps created while the mode is on. */
  readonly apps: unknown[]
  /** The factories called by `registerLazyApp()`, to wait for. */
  readonly pending: Promise<unknown>[]
}

/** The document mode, when a tool is documenting the app. */
export const documentMode = (): DocumentMode | undefined => {
  const mode = (globalThis as Record<symbol, unknown>)[DOCUMENT_MODE_KEY]
  return typeof mode === 'object' &&
    mode !== null &&
    Array.isArray((mode as DocumentMode).apps) &&
    Array.isArray((mode as DocumentMode).pending)
    ? (mode as DocumentMode)
    : undefined
}

/**
 * Declares the factory of an app created later, at the first request: the
 * handler of AWS Lambda. When a tool documents the app (`dotpress-openapi`),
 * the factory is called right away, so that the app exists once the module
 * is imported. Otherwise, does nothing.
 */
export const registerLazyApp = (factory: () => unknown): void => {
  const mode = documentMode()
  if (!mode) return
  const created = Promise.resolve().then(factory)
  // Awaited by the tool, which reports the failure.
  created.catch(() => {})
  mode.pending.push(created)
}
