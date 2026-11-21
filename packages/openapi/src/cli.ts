import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { Plugin, RouteInfo } from '@dotpress/core'
import { generateOpenApi } from './generate.js'
import type { InfoObject, OpenApiDocument } from './types.js'

/** Inputs and outputs of the command, injected for tests. */
export interface CliIo {
  readonly cwd: string
  stdout(text: string): void | Promise<void>
  stderr(text: string): void | Promise<void>
}

const TYPESCRIPT_HINT =
  'TypeScript modules require Node.js 22.18 or later, with erasable syntax and relative imports ending in .ts. Otherwise, point to the compiled module, or run the command with NODE_OPTIONS="--import tsx".'

export const USAGE = `Usage: dotpress-openapi <module> [options]

Writes the OpenAPI document of a Dotpress app, without starting a server.
<module> creates the app, like the entry point of the server or of AWS
Lambda, or exports it, or exports a function creating it. With
openapiPlugin(), its document is used as is.

Options:
  --export <name>        Export to use, when the module does not create one app
                         (default: "default", or the only exported app or function)
  --out <file>           Output file (default: standard output)
  --title <title>        Title, without openapiPlugin() (default: package.json name)
  --api-version <v>      Version, without openapiPlugin() (default: package.json version)
  -h, --help             Shows this help

${TYPESCRIPT_HINT}
`

interface AppLike {
  readonly routes: readonly RouteInfo[]
  readonly plugins?: readonly Plugin[]
  readonly publicBasePath?: string
  close?(): Promise<void>
}

class CliError extends Error {}

const isApp = (value: unknown): value is AppLike =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as AppLike).routes)

/**
 * Key of the document mode of `@dotpress/core` (`document-mode.ts`): while
 * it is set, the apps created are recorded, `app.listen()` starts no server,
 * and the factories of `createLambdaHandler()` are called right away.
 */
const DOCUMENT_MODE_KEY = Symbol.for('dotpress.core.documentMode')

interface DocumentMode {
  readonly apps: unknown[]
  readonly pending: Promise<unknown>[]
}

/**
 * Runs `load` in document mode. What the module prints on the standard
 * output (`Listening on…`) goes to the standard error: the standard output
 * is the document.
 */
const inDocumentMode = async <T>(
  mode: DocumentMode,
  load: () => Promise<T>
): Promise<T> => {
  const global = globalThis as Record<symbol, unknown>
  const previous = global[DOCUMENT_MODE_KEY]
  const write = process.stdout.write
  global[DOCUMENT_MODE_KEY] = mode
  process.stdout.write = process.stderr.write.bind(
    process.stderr
  ) as typeof write
  try {
    return await load()
  } finally {
    process.stdout.write = write
    global[DOCUMENT_MODE_KEY] = previous
  }
}

/**
 * The adapter given to an exported factory: it mounts nothing. It is also
 * its own `adapter` option, for factories taking `{ adapter }` as well as
 * those taking the adapter itself.
 */
const documentAdapter = () => {
  const adapter = {
    name: 'dotpress-openapi',
    mount: () => {},
    native: () => undefined,
  }
  return Object.assign(adapter, { adapter })
}

/** The exports that can be the app: apps and functions. */
const candidatesOf = (module: Record<string, unknown>) =>
  Object.keys(module)
    .filter((name) => typeof module[name] === 'function' || isApp(module[name]))
    .sort()

/**
 * The app of the module: the one it creates, or its export (an app, or a
 * factory called with an adapter that mounts nothing).
 */
const loadApp = async (
  modulePath: string,
  exportName: string | undefined,
  cwd: string,
  mode: DocumentMode
): Promise<AppLike> => {
  const file = resolve(cwd, modulePath)
  if (!existsSync(file)) throw new CliError(`Module not found: ${file}`)

  return inDocumentMode(mode, async () => {
    let module: Record<string, unknown>
    try {
      module = (await import(pathToFileURL(file).href)) as Record<
        string,
        unknown
      >
    } catch (error) {
      const hint = /\.[cm]?ts$/.test(file) ? `\n${TYPESCRIPT_HINT}` : ''
      throw new CliError(
        `Cannot load ${file}: ${error instanceof Error ? error.message : String(error)}${hint}`,
        { cause: error }
      )
    }
    await Promise.all(mode.pending)

    const fromExport = async (name: string): Promise<AppLike> => {
      const exported = module[name]
      const app: unknown =
        typeof exported === 'function'
          ? await (exported as (adapter: unknown) => unknown)(documentAdapter())
          : exported
      if (!isApp(app)) {
        throw new CliError(
          `The "${name}" export of ${modulePath} is not a Dotpress app: export the result of createApp(), or a function returning it.`
        )
      }
      return app
    }

    const exports = Object.keys(module).sort().join(', ') || 'none'
    if (exportName !== undefined) {
      if (!(exportName in module)) {
        throw new CliError(
          `${modulePath} has no "${exportName}" export (exports: ${exports}).`
        )
      }
      return fromExport(exportName)
    }

    const created = mode.apps.filter(isApp)
    if (created.length === 1) return created[0]!
    if (created.length > 1) {
      throw new CliError(
        `${modulePath} creates ${created.length} apps: export the one to document, and choose it with --export.`
      )
    }

    if ('default' in module) return fromExport('default')
    const candidates = candidatesOf(module)
    if (candidates.length === 1) return fromExport(candidates[0]!)
    throw new CliError(
      candidates.length === 0
        ? `${modulePath} creates no Dotpress app, and exports none (exports: ${exports}). Point to the module that creates the app, like the entry point of the server.`
        : `${modulePath} creates no Dotpress app, and exports several apps or functions (${candidates.join(', ')}): choose one with --export.`
    )
  })
}

/** `info` from the options, or from the package.json of the directory. */
const resolveInfo = async (
  cwd: string,
  title: string | undefined,
  version: string | undefined
): Promise<InfoObject> => {
  let pkg: { name?: unknown; version?: unknown } = {}
  if (title === undefined || version === undefined) {
    try {
      pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'))
    } catch {
      // No package.json: the options are required.
    }
  }

  const info = {
    title: title ?? (typeof pkg.name === 'string' ? pkg.name : undefined),
    version:
      version ?? (typeof pkg.version === 'string' ? pkg.version : undefined),
  }
  if (!info.title || !info.version) {
    throw new CliError(
      'Without openapiPlugin(), the document needs --title and --api-version, or a package.json with a name and a version in the current directory.'
    )
  }
  return info as InfoObject
}

const documentOf = async (
  app: AppLike,
  options: { title?: string; version?: string },
  io: CliIo
): Promise<OpenApiDocument> => {
  const plugin = app.plugins?.find(
    (item): item is Plugin & { getDocument(): OpenApiDocument } =>
      item.name === 'openapi' &&
      typeof (item as { getDocument?: unknown }).getDocument === 'function'
  )
  if (plugin) {
    if (options.title !== undefined || options.version !== undefined) {
      await io.stderr(
        'Warning: --title and --api-version are ignored, the document of openapiPlugin() is used.\n'
      )
    }
    return plugin.getDocument()
  }

  const warnings: string[] = []
  const document = generateOpenApi(app, {
    info: await resolveInfo(io.cwd, options.title, options.version),
    onWarning: (message) => warnings.push(message),
  })
  for (const warning of warnings) await io.stderr(`Warning: ${warning}\n`)
  return document
}

/**
 * Runs the `dotpress-openapi` command, and returns its exit code.
 */
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
        export: { type: 'string' },
        out: { type: 'string' },
        title: { type: 'string' },
        'api-version': { type: 'string' },
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
  if (positionals.length !== 1) {
    await io.stderr(USAGE)
    return 1
  }

  const mode: DocumentMode = { apps: [], pending: [] }
  try {
    let document: OpenApiDocument
    try {
      const app = await loadApp(positionals[0]!, values.export, io.cwd, mode)
      if (!mode.apps.includes(app)) mode.apps.push(app)
      document = await documentOf(
        app,
        { title: values.title, version: values['api-version'] },
        io
      )
    } finally {
      // Every app created by the module, last created first.
      for (const app of mode.apps.filter(isApp).reverse()) await app.close?.()
    }

    const json = `${JSON.stringify(document, null, 2)}\n`
    if (values.out === undefined) {
      await io.stdout(json)
    } else {
      const file = resolve(io.cwd, values.out)
      await writeFile(file, json)
      const count = Object.keys(document.paths).length
      await io.stderr(
        `OpenAPI document written to ${file} (${count} ${count === 1 ? 'path' : 'paths'}).\n`
      )
    }
    return 0
  } catch (error) {
    const message =
      error instanceof CliError
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error)
    await io.stderr(`dotpress-openapi: ${message}\n`)
    return 1
  }
}
