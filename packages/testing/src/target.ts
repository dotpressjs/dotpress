import { toRequest } from './request.js'

/**
 * Running application under test.
 */
export interface TestTarget {
  /** Sends a request to the application. `path` includes the query. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Stops the application. */
  close(): Promise<void>
}

export interface TargetOptions {
  /** Stops the application. Defaults to doing nothing. */
  close?: () => Promise<void>
}

const OPTIONS = ['close'] satisfies (keyof TargetOptions)[]

/** Checks the options of a target, and returns its `close()`. */
export const closeOf = (
  label: string,
  options: TargetOptions,
  known: readonly string[] = OPTIONS
): (() => Promise<void>) => {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: options must be an object.`)
  }
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  return options.close ?? (async () => {})
}

/**
 * Target for adapters listening on an HTTP port.
 */
export const createHttpTarget = (
  baseUrl: string,
  options: TargetOptions = {}
): TestTarget => ({
  fetch: (path, init) => fetch(new URL(path, baseUrl), init),
  close: closeOf('createHttpTarget()', options),
})

/**
 * Target for adapters handling Web requests in memory (`fetch()` of the
 * adapter, serverless handlers). `path` is relative to `http://localhost`.
 */
export const createFetchTarget = (
  handle: (request: Request) => Promise<Response>,
  options: TargetOptions = {}
): TestTarget => ({
  fetch: async (path, init) => handle(await toRequest(path, init)),
  close: closeOf('createFetchTarget()', options),
})
