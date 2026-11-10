// Checks that the published runtime-agnostic packages (or entries) only
// depend on what they declare: no HTTP server, no Node.js types or modules.
// Run after `pnpm build`.
import { readFile } from 'node:fs/promises'

const PACKAGES = {
  core: { imports: new Set(['zod']) },
  openapi: { imports: new Set(['zod', '@dotpress/core']) },
  // Main entry only: the `node` entry is the Node.js server.
  'adapter-hono': {
    imports: new Set(['hono', '@dotpress/core']),
    entryOnly: true,
  },
  // Main entry only: the stores of Node.js clients have their own entries.
  cache: { imports: new Set(), entryOnly: true },
}
const FORBIDDEN_DEPENDENCIES =
  /^(express|hono|fastify|@hono\/|@fastify\/|@types\/(express|node)$)/

let failed = false

/** Imports of a bundle file, following its relative imports (chunks). */
const importsOf = async (root, file, seen = new Set()) => {
  if (seen.has(file)) return []
  seen.add(file)

  const source = await readFile(new URL(file, root), 'utf8')
  const imports = []
  for (const [, specifier] of source.matchAll(
    /(?:from|import)\s*\(?\s*["']([^"']+)["']/g
  )) {
    if (specifier.startsWith('./')) {
      const chunk = new URL(specifier, new URL(file, root)).href.slice(
        root.href.length
      )
      imports.push(...(await importsOf(root, chunk, seen)))
    } else {
      imports.push({ file, specifier })
    }
  }
  return imports
}

for (const [name, { imports: allowedImports, entryOnly }] of Object.entries(
  PACKAGES
)) {
  const root = new URL(`../packages/${name}/`, import.meta.url)
  const errors = []

  if (!entryOnly) {
    const pkg = JSON.parse(
      await readFile(new URL('package.json', root), 'utf8')
    )

    if (Object.keys(pkg.dependencies ?? {}).length > 0) {
      errors.push(
        `dependencies must be empty: ${Object.keys(pkg.dependencies)}`
      )
    }

    for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
      if (!allowedImports.has(dependency)) {
        errors.push(`unexpected peer dependency "${dependency}"`)
      }
    }

    for (const field of [
      'dependencies',
      'peerDependencies',
      'devDependencies',
    ]) {
      for (const dependency of Object.keys(pkg[field] ?? {})) {
        if (FORBIDDEN_DEPENDENCIES.test(dependency)) {
          errors.push(`forbidden ${field} entry "${dependency}"`)
        }
      }
    }
  }

  for (const entry of ['dist/index.js', 'dist/index.d.ts']) {
    const found = new Set()
    for (const { file, specifier } of await importsOf(root, entry)) {
      const key = `${file} imports "${specifier}"`
      if (!allowedImports.has(specifier) && !found.has(key)) {
        found.add(key)
        errors.push(key)
      }
    }
  }

  if (errors.length > 0) {
    failed = true
    console.error(
      `@dotpress/${name}${entryOnly ? ' (main entry)' : ''} is not runtime-agnostic:`
    )
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log(
      `@dotpress/${name}${entryOnly ? ' (main entry)' : ''} ${allowedImports.size === 0 ? 'has no dependency' : `only depends on ${[...allowedImports].join(', ')}`}.`
    )
  }
}

if (failed) process.exit(1)
