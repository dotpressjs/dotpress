import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { EventsLogger } from './logger.js'
import { startWorker } from './start-worker.js'
import type { Source } from './transport.js'
import type { Worker } from './worker.js'

/** What the module of `dotpress-events work` exports. */
export interface WorkerEntry {
  worker: Worker
  source: Source
  logger?: EventsLogger | undefined
}

/** Inputs and outputs of the command, injected for tests. */
export interface CliIo {
  readonly cwd: string
  stdout(text: string): void | Promise<void>
  stderr(text: string): void | Promise<void>
  /** Aborted on SIGINT / SIGTERM: stops the worker. */
  readonly signal: AbortSignal
  /** Runs the command again under `node --watch`; returns its exit code. */
  watch(args: readonly string[]): Promise<number>
}

const TYPESCRIPT_HINT =
  'TypeScript modules require Node.js 22.18 or later, with erasable syntax and relative imports ending in .ts. Otherwise, point to the compiled module, or run the command with NODE_OPTIONS="--import tsx".'

export const USAGE = `Usage: dotpress-events work <module> [options]

Runs a worker until stopped (Ctrl+C): reads the messages of a queue and
runs their listeners. <module> exports { worker, source } (and optionally
a logger), or a function returning it:

  export default {
    worker: createWorker({ listeners: [sendWelcomeMail] }),
    source: createSqsSource({ queueUrl }),
  }

Ctrl+C or SIGTERM stops the worker after the messages in progress; once
more, a second later or more, exits at once.

Options:
  --export <name>   Export of the module (default: "default")
  --watch           Restarts the worker when a loaded file changes
  -h, --help        Shows this help

${TYPESCRIPT_HINT}
`

/**
 * Delay, in milliseconds, during which a repeated signal is the same stop
 * request. One Ctrl+C can reach the worker several times within a few
 * milliseconds: the terminal sends it to every process of the group, and
 * `npm run`, `pnpm run` and `node --watch` relay the signals they receive.
 */
export const SIGNAL_REPEAT_DELAY = 1000

/**
 * Reaction to SIGINT and SIGTERM: the first signal stops the worker after
 * the messages in progress; another one, at least `SIGNAL_REPEAT_DELAY`
 * later, exits at once (code 130).
 */
export const createStopHandler = (options: {
  stop: () => void
  exit: (code: number) => void
  now?: () => number
}) => {
  const now = options.now ?? Date.now
  let firstAt: number | undefined
  return (): void => {
    const time = now()
    if (firstAt === undefined) {
      firstAt = time
      options.stop()
    } else if (time - firstAt >= SIGNAL_REPEAT_DELAY) {
      options.exit(130)
    }
  }
}

class CliError extends Error {}

const isEntry = (value: unknown): value is WorkerEntry =>
  typeof (value as WorkerEntry | null)?.worker?.handle === 'function' &&
  typeof (value as WorkerEntry).source?.consume === 'function'

const loadEntry = async (
  modulePath: string,
  exportName: string,
  cwd: string
): Promise<WorkerEntry> => {
  const file = resolve(cwd, modulePath)
  if (!existsSync(file)) throw new CliError(`Module not found: ${file}`)

  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  } catch (error) {
    const hint = /\.[cm]?ts$/.test(file) ? `\n${TYPESCRIPT_HINT}` : ''
    throw new CliError(
      `Cannot load ${file}: ${error instanceof Error ? error.message : String(error)}${hint}`,
      { cause: error }
    )
  }
  if (!(exportName in module)) {
    throw new CliError(
      `${modulePath} has no "${exportName}" export (exports: ${Object.keys(module).sort().join(', ') || 'none'}). Choose one with --export.`
    )
  }
  const exported = module[exportName]
  const entry: unknown =
    typeof exported === 'function'
      ? await (exported as () => unknown)()
      : exported
  if (!isEntry(entry)) {
    throw new CliError(
      `The "${exportName}" export of ${modulePath} must be { worker, source }: a worker created by createWorker() and the source of a transport, or a function returning them.`
    )
  }
  return entry
}

/** Logger writing JSON lines to the standard error. */
const stderrLogger = (io: CliIo): EventsLogger => {
  const write =
    (level: string) =>
    (data: object, message: string): void =>
      void io.stderr(
        `${JSON.stringify({ level, time: new Date().toISOString(), message, ...data })}\n`
      )
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  }
}

/** Runs the `dotpress-events` command, and returns its exit code. */
export const main = async (
  args: readonly string[],
  io: CliIo
): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        export: { type: 'string', default: 'default' },
        watch: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    await io.stderr(`${(error as Error).message}\n\n${USAGE}`)
    return 1
  }

  const { values, positionals } = parsed
  if (values.help) {
    await io.stdout(USAGE)
    return 0
  }
  const [command, modulePath, ...rest] = positionals
  if (command !== 'work' || modulePath === undefined || rest.length > 0) {
    await io.stderr(USAGE)
    return 1
  }
  if (values.watch) {
    return io.watch(args.filter((arg) => arg !== '--watch'))
  }

  try {
    const entry = await loadEntry(modulePath, values.export, io.cwd)
    const running = startWorker(entry.worker, entry.source, {
      logger: entry.logger ?? stderrLogger(io),
      signal: io.signal,
    })
    await running.done
    return 0
  } catch (error) {
    await io.stderr(
      `${error instanceof CliError ? error.message : `Worker failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`}\n`
    )
    return 1
  }
}
