// Checks that the published @dotpress/core package only depends on Zod:
// no HTTP server, no Node.js types or modules. Run after `pnpm build`.
import { readFile } from 'node:fs/promises'

const ALLOWED_IMPORTS = new Set(['zod'])
const FORBIDDEN_DEPENDENCIES =
  /^(express|hono|fastify|@hono\/|@fastify\/|@types\/(express|node)$)/

const root = new URL('../packages/core/', import.meta.url)
const errors = []

const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  errors.push(`dependencies must be empty: ${Object.keys(pkg.dependencies)}`)
}

for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  if (!ALLOWED_IMPORTS.has(name)) {
    errors.push(`unexpected peer dependency "${name}"`)
  }
}

for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (FORBIDDEN_DEPENDENCIES.test(name)) {
      errors.push(`forbidden ${field} entry "${name}"`)
    }
  }
}

for (const file of ['dist/index.js', 'dist/index.d.ts']) {
  const source = await readFile(new URL(file, root), 'utf8')
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
  ].map((match) => match[1])

  for (const specifier of new Set(specifiers)) {
    if (!ALLOWED_IMPORTS.has(specifier)) {
      errors.push(`${file} imports "${specifier}"`)
    }
  }
}

if (errors.length > 0) {
  console.error('@dotpress/core is not runtime-agnostic:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('@dotpress/core only depends on Zod.')
