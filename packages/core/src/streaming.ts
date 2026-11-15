/**
 * Chunk accepted by streamed responses. Strings are encoded as UTF-8.
 */
export type StreamChunk = string | Uint8Array

/**
 * Argument given to stream source functions.
 */
export interface StreamSourceContext {
  /** Aborted when the client disconnects (same signal as `ctx.req.signal`). */
  readonly signal: AbortSignal
}

/**
 * Source of a streamed response:
 * - a `ReadableStream`
 * - an iterable or async iterable (an array, a generator…)
 * - a function returning an iterable, called when the response starts
 *   (typically an async generator function)
 */
export type StreamSource<T> =
  | ReadableStream<T>
  | AsyncIterable<T>
  | Iterable<T>
  | ((context: StreamSourceContext) => AsyncIterable<T> | Iterable<T>)

interface SourceIterator<T> {
  next(): Promise<IteratorResult<T>>
  return(reason?: unknown): Promise<unknown>
}

const hasMethod = (value: unknown, key: PropertyKey): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<PropertyKey, unknown>)[key] === 'function'

/**
 * Opens a stream source. Source functions are called here, so errors they
 * throw synchronously surface before the response starts.
 */
export const openStreamSource = <T>(
  source: StreamSource<T>,
  context: StreamSourceContext
): SourceIterator<T> => {
  if (source instanceof ReadableStream) {
    const reader = (source as ReadableStream<T>).getReader()
    return {
      next: () => reader.read() as Promise<IteratorResult<T>>,
      return: (reason) => reader.cancel(reason),
    }
  }

  const iterable = typeof source === 'function' ? source(context) : source

  if (hasMethod(iterable, Symbol.asyncIterator)) {
    const iterator = (iterable as AsyncIterable<T>)[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: async () => iterator.return?.(),
    }
  }

  if (hasMethod(iterable, Symbol.iterator)) {
    const iterator = (iterable as Iterable<T>)[Symbol.iterator]()
    return {
      next: async () => iterator.next(),
      return: async () => iterator.return?.(),
    }
  }

  throw new TypeError(
    'stream(): expected a ReadableStream, an iterable, an async iterable or a function returning one.'
  )
}

export interface ResponseStreamOptions<T> {
  readonly signal: AbortSignal
  readonly encode: (value: T) => Uint8Array
  /** Chunk written periodically while the stream is open. */
  readonly heartbeat?: { readonly interval: number; readonly chunk: Uint8Array }
  /** Called when the source fails after the response has started. */
  readonly onError: (error: unknown) => void
}

/**
 * Turns a source iterator into the body of a normalized response.
 *
 * - The source is pulled on demand (backpressure).
 * - When `signal` aborts, the stream closes and the source is released.
 * - When the consumer cancels the stream, the source is released.
 * - When the source fails, `onError` is called and the stream errors, so
 *   the adapter can abort the connection instead of ending it cleanly.
 */
export const createResponseStream = <T>(
  iterator: SourceIterator<T>,
  options: ResponseStreamOptions<T>
): ReadableStream<Uint8Array> => {
  const { signal, encode, heartbeat, onError } = options
  let finished = false
  let timer: ReturnType<typeof setInterval> | undefined
  let streamController: ReadableStreamDefaultController<Uint8Array>

  // Releasing the source is not awaited: a generator suspended on an await
  // only settles `return()` once that await resolves.
  const release = (reason?: unknown) => {
    iterator.return(reason).catch(() => {})
  }

  const finish = (): boolean => {
    if (finished) return false
    finished = true
    if (timer !== undefined) clearInterval(timer)
    signal.removeEventListener('abort', onAbort)
    return true
  }

  function onAbort() {
    if (!finish()) return
    release(signal.reason)
    try {
      streamController.close()
    } catch {
      // Already closed or errored by the consumer.
    }
  }

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller

        if (signal.aborted) {
          onAbort()
          return
        }

        signal.addEventListener('abort', onAbort, { once: true })

        if (heartbeat) {
          timer = setInterval(() => {
            if (!finished) controller.enqueue(heartbeat.chunk)
          }, heartbeat.interval)
        }
      },
      async pull(controller) {
        try {
          const result = await iterator.next()
          if (finished) return

          if (result.done) {
            finish()
            controller.close()
            return
          }

          controller.enqueue(encode(result.value))
        } catch (error) {
          if (!finish()) return
          release()
          onError(error)
          controller.error(error)
        }
      },
      cancel(reason) {
        if (finish()) release(reason)
      },
    },
    { highWaterMark: 0 }
  )
}

const encoder = new TextEncoder()

export const encodeChunk = (chunk: StreamChunk): Uint8Array => {
  if (typeof chunk === 'string') return encoder.encode(chunk)
  if (chunk instanceof Uint8Array) return chunk
  throw new TypeError('Stream chunks must be strings or Uint8Array instances.')
}

/**
 * Server-Sent Event. At least one field is required.
 */
export interface SseEvent {
  /** Event payload. Strings are sent as is, other values as JSON. */
  data?: unknown
  /** Event type (`message` on the client when omitted). */
  event?: string
  /** Event identifier, sent back by the client as `Last-Event-ID`. */
  id?: string | number
  /** Reconnection delay for the client, in milliseconds. */
  retry?: number
  /** Comment line, ignored by clients. */
  comment?: string
}

/**
 * Value yielded by an SSE source: an event, or a string sent as `data`.
 */
export type SseMessage = SseEvent | string

const LINE_BREAK = /\r\n|\r|\n/

const assertSingleLine = (field: string, value: string) => {
  if (LINE_BREAK.test(value) || value.includes('\0')) {
    throw new TypeError(
      `Invalid SSE "${field}" field: it must not contain line breaks or NUL characters.`
    )
  }
}

/**
 * Serializes a message in the `text/event-stream` format.
 */
export const encodeSseMessage = (message: SseMessage): string => {
  const event: SseEvent =
    typeof message === 'string' ? { data: message } : message

  if (typeof event !== 'object' || event === null) {
    throw new TypeError('SSE messages must be strings or event objects.')
  }

  const lines: string[] = []

  if (event.comment !== undefined) {
    for (const line of event.comment.split(LINE_BREAK)) {
      lines.push(`: ${line}`)
    }
  }

  if (event.event !== undefined) {
    assertSingleLine('event', event.event)
    lines.push(`event: ${event.event}`)
  }

  if (event.id !== undefined) {
    const id = String(event.id)
    assertSingleLine('id', id)
    lines.push(`id: ${id}`)
  }

  if (event.retry !== undefined) {
    if (!Number.isInteger(event.retry) || event.retry < 0) {
      throw new TypeError(
        'Invalid SSE "retry" field: expected a non-negative integer.'
      )
    }
    lines.push(`retry: ${event.retry}`)
  }

  if (event.data !== undefined) {
    const data =
      typeof event.data === 'string' ? event.data : JSON.stringify(event.data)

    if (data === undefined) {
      throw new TypeError('Invalid SSE "data" field: not serializable.')
    }

    for (const line of data.split(LINE_BREAK)) {
      lines.push(`data: ${line}`)
    }
  }

  if (lines.length === 0) {
    throw new TypeError('An SSE event must have at least one field.')
  }

  return `${lines.join('\n')}\n\n`
}

export const SSE_HEARTBEAT = encoder.encode(':\n\n')
