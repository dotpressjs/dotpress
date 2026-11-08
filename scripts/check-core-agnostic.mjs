// Checks that the published runtime-agnostic packages only depend on what
// they declare: no HTTP server, no Node.js types or modules. Run after
// `pnpm build`.
import { readFile } from 'node:fs/promises'

const PACKAGES = {
  core: new Set(['zod']),
  openapi: new Set(['zod', '@dotpress/core']),
}
const FORBIDDEN_DEPENDENCIES =
  /^(express|hono|fastify|@hono\/|@fastify\/|@types\/(express|node)$)/

let failed = false

for (const [name, allowedImports] of Object.entries(PACKAGES)) {
  const root = new URL(`../packages/${name}/`, import.meta.url)
  const errors = []

  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

  if (Object.keys(pkg.dependencies ?? {}).length > 0) {
    errors.push(`dependencies must be empty: ${Object.keys(pkg.dependencies)}`)
  }

  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
    if (!allowedImports.has(dependency)) {
      errors.push(`unexpected peer dependency "${dependency}"`)
    }
  }

  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const dependency of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_DEPENDENCIES.test(dependency)) {
        errors.push(`forbidden ${field} entry "${dependency}"`)
      }
    }
  }

  for (const file of ['dist/index.js', 'dist/index.d.ts']) {
    const source = await readFile(new URL(file, root), 'utf8')
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
    ].map((match) => match[1])

    for (const specifier of new Set(specifiers)) {
      if (!allowedImports.has(specifier)) {
        errors.push(`${file} imports "${specifier}"`)
      }
    }
  }

  if (errors.length > 0) {
    failed = true
    console.error(`@dotpress/${name} is not runtime-agnostic:`)
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log(
      `@dotpress/${name} only depends on ${[...allowedImports].join(', ')}.`
    )
  }
}

if (failed) process.exit(1)
