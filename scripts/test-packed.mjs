// Tests the packages as they would be published: packs them (pnpm pack),
// installs the tarballs in a new project with npm, and checks them from a
// consumer's point of view. Nothing is published. Run after `pnpm build`.
//
// - tarballs: only dist/, README.md, LICENSE and package.json; no
//   `workspace:` range left;
// - without the optional peer dependencies: the main entries load, and the
//   other entries load or fail naming the missing peer;
// - with them: every entry loads with import and with require();
// - types: every entry type-checks with the node16 and bundler resolutions,
//   with the TypeScript of the repository and with the oldest supported one;
// - built-in modules imported with the node: prefix;
// - binaries, and a request through each adapter (one @dotpress/core).
//
// KEEP_PACKED=1 keeps the temporary project.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'dotpress-packed-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')
mkdirSync(tarballs)
mkdirSync(app)

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`  ✗ ${message}`)
}
const ok = (message) => console.log(`  ✓ ${message}`)
const step = (title) => console.log(`\n${title}`)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}
const runOrThrow = (command, args, options) => {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`
    )
  }
  return result
}

// pnpm as started by `pnpm test:packed`, or from the PATH.
const pnpmPath = process.env.npm_execpath ?? 'pnpm'
const pnpm = (args, options) =>
  /\.[cm]?js$/.test(pnpmPath)
    ? runOrThrow(process.execPath, [pnpmPath, ...args], options)
    : runOrThrow(pnpmPath, args, options)

// Release-age policy: only versions published more than a day ago.
const before = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const npmInstall = (packages) =>
  runOrThrow(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `--before=${before}`,
      ...packages,
    ],
    { cwd: app }
  )

// 1. Pack every package.
step('Packing')
const packages = []
for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const pkgDir = join(root, 'packages', dir)
  const existing = new Set(readdirSync(tarballs))
  pnpm(['pack', '--pack-destination', tarballs], { cwd: pkgDir })
  const file = readdirSync(tarballs).find((name) => !existing.has(name))
  const tarball = join(tarballs, file)
  const manifest = JSON.parse(
    runOrThrow('tar', ['-xzOf', tarball, 'package/package.json']).stdout
  )
  const files = runOrThrow('tar', ['-tzf', tarball])
    .stdout.split('\n')
    .filter(Boolean)
  packages.push({ dir, tarball, manifest, files })
  ok(
    `${manifest.name}: ${files.length} files, ${(statSync(tarball).size / 1024).toFixed(1)} kB`
  )
}

// 2. Content of the tarballs.
step('Tarballs')
for (const { manifest, files } of packages) {
  const unexpected = files.filter(
    (file) =>
      !/^package\/(package\.json|README\.md|LICENSE|dist\/.+)$/.test(file)
  )
  if (unexpected.length > 0) {
    fail(`${manifest.name}: unexpected files ${unexpected.join(', ')}`)
  }
  for (const required of ['package/README.md', 'package/LICENSE']) {
    if (!files.includes(required)) fail(`${manifest.name}: no ${required}`)
  }
  const ranges = ['dependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((field) => Object.entries(manifest[field] ?? {}))
    .filter(([, range]) => range.startsWith('workspace:'))
  if (ranges.length > 0) {
    fail(`${manifest.name}: workspace ranges left (${ranges.join(', ')})`)
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith('@dotpress/') && range !== `^${manifest.version}`) {
      fail(
        `${manifest.name}: peer ${name}@${range}, expected ^${manifest.version}`
      )
    }
  }
  if (!failures.some((message) => message.startsWith(`${manifest.name}:`))) {
    ok(`${manifest.name}`)
  }
}

// Entries (`@dotpress/cache/redis`…), and the peers to install.
const entries = packages.flatMap(({ manifest }) =>
  Object.keys(manifest.exports).map((key) => ({
    pkg: manifest,
    specifier: key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`,
  }))
)
const ownNames = new Set(packages.map(({ manifest }) => manifest.name))
const peers = (optional) => {
  const wanted = new Map()
  for (const { manifest } of packages) {
    for (const [name, range] of Object.entries(
      manifest.peerDependencies ?? {}
    )) {
      const isOptional = manifest.peerDependenciesMeta?.[name]?.optional
      if (!ownNames.has(name) && Boolean(isOptional) === optional) {
        wanted.set(name, range)
      }
    }
  }
  return [...wanted].map(([name, range]) => `${name}@${range}`)
}

// 3. Install the tarballs and the required peers only.
step('Installing the tarballs, without the optional peer dependencies')
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'packed-app', private: true, type: 'module' })
)
npmInstall([...packages.map(({ tarball }) => tarball), ...peers(false)])
ok(`installed (${peers(false).join(', ')})`)

step('Built-in modules imported with the node: prefix')
// Deno and Cloudflare Workers (nodejs_als) need the prefix.
const builtins = new Set(builtinModules.filter((name) => !name.startsWith('_')))
for (const { manifest, files } of packages) {
  const bare = new Set()
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(
      join(app, 'node_modules', manifest.name, file.slice('package/'.length)),
      'utf8'
    )
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g
    )) {
      if (builtins.has(specifier)) bare.add(specifier)
    }
  }
  if (bare.size > 0)
    fail(`${manifest.name}: ${[...bare].join(', ')} without node:`)
  else ok(manifest.name)
}

/** Loads every entry in a child process: { specifier: error or null }. */
const load = (mode) => {
  const script =
    mode === 'import'
      ? `const results = {}
for (const specifier of ${JSON.stringify(entries.map((entry) => entry.specifier))}) {
  try {
    const module = await import(specifier)
    results[specifier] = Object.keys(module).length > 0 ? null : 'no exports'
  } catch (error) {
    results[specifier] = String(error.message).split('\\n')[0].replace(/ imported from .*/, '')
  }
}
console.log(JSON.stringify(results))`
      : `const results = {}
for (const specifier of ${JSON.stringify(entries.map((entry) => entry.specifier))}) {
  try {
    const module = require(specifier)
    results[specifier] = Object.keys(module).length > 0 ? null : 'no exports'
  } catch (error) {
    results[specifier] = String(error.message).split('\\n')[0].replace(/ imported from .*/, '')
  }
}
console.log(JSON.stringify(results))`
  const file = join(app, mode === 'import' ? 'load.mjs' : 'load.cjs')
  writeFileSync(file, script)
  const output = runOrThrow(process.execPath, [file], { cwd: app }).stdout
  return JSON.parse(output.trim().split('\n').at(-1))
}

const optionalPeersOf = (pkg) =>
  Object.keys(pkg.peerDependenciesMeta ?? {}).filter(
    (name) => pkg.peerDependenciesMeta[name].optional && !ownNames.has(name)
  )
const withoutPeers = load('import')
for (const { pkg, specifier } of entries) {
  const error = withoutPeers[specifier]
  if (error === null) {
    ok(`${specifier}`)
  } else if (specifier === pkg.name) {
    fail(`${specifier} needs an optional peer dependency: ${error}`)
  } else if (optionalPeersOf(pkg).some((name) => error.includes(`'${name}'`))) {
    ok(`${specifier}: ${error}`)
  } else {
    fail(`${specifier}: ${error}`)
  }
}

// 4. With every optional peer dependency.
step('Installing the optional peer dependencies')
// The oldest TypeScript supported, as documented in Installation: Zod 4
// needs 5.5.
const OLDEST_TYPESCRIPT = '~5.5.4'
// The latest major, which `npm install -D typescript` installs. The
// tooling of the repository stays on 6 (typescript-eslint).
const LATEST_TYPESCRIPT = '^7.0.2'
const tools = [
  `typescript@${rootPkg.devDependencies.typescript}`,
  `typescript-oldest@npm:typescript@${OLDEST_TYPESCRIPT}`,
  `typescript-latest@npm:typescript@${LATEST_TYPESCRIPT}`,
  `@types/node@${rootPkg.devDependencies['@types/node']}`,
  'esbuild@^0.28.0',
]
npmInstall([...peers(true), ...tools])
ok(`installed (${peers(true).join(', ')})`)

for (const mode of ['import', 'require']) {
  step(`Loading every entry with ${mode}`)
  const results = load(mode)
  for (const { specifier } of entries) {
    if (results[specifier] === null) ok(specifier)
    else fail(`${mode}("${specifier}"): ${results[specifier]}`)
  }
}

// 5. Types, as a TypeScript project of the consumer would resolve them.
const compilers = [
  { name: 'typescript', target: 'es2023' },
  // TypeScript 5.5 knows no es2023 target.
  { name: 'typescript-oldest', target: 'es2022' },
  { name: 'typescript-latest', target: 'es2023' },
]
const checks = compilers.flatMap((compiler) =>
  ['node16', 'bundler'].map((resolution) => ({ ...compiler, resolution }))
)
for (const { name, target, resolution } of checks) {
  const version = JSON.parse(
    readFileSync(join(app, 'node_modules', name, 'package.json'), 'utf8')
  ).version
  step(
    `Type-checking every entry (TypeScript ${version}, moduleResolution: ${resolution})`
  )
  const dir = join(app, `types-${name}-${resolution}`)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: resolution === 'node16' ? 'node16' : 'esnext',
        moduleResolution: resolution,
        target: target,
        lib: [target],
        types: ['node'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['entries.ts'],
    })
  )
  writeFileSync(
    join(dir, 'entries.ts'),
    entries
      .map(
        ({ specifier }, index) => `import * as m${index} from '${specifier}'`
      )
      .join('\n') +
      `\nexport const entries = [${entries.map((_, index) => `m${index}`).join(', ')}]\n`
  )
  const result = run(
    process.execPath,
    [join(app, 'node_modules', name, 'bin/tsc'), '-p', dir],
    { cwd: app }
  )
  // Errors in our declarations or in the consumer file: the declarations of
  // other packages are theirs (resend needs React types, pg-boss @types/pg).
  const errors = `${result.stdout}${result.stderr}`
    .split('\n')
    .filter((line) => /error TS\d+/.test(line))
  const ours = errors.filter(
    (line) =>
      !line.startsWith('node_modules/') ||
      line.startsWith('node_modules/@dotpress/')
  )
  const label = `tsc ${version} (${resolution})`
  if (ours.length > 0) fail(`${label}:\n${ours.join('\n')}`)
  else if (result.status !== 0 && errors.length === 0) {
    fail(`${label}: ${result.stdout}${result.stderr}`)
  } else {
    ok(
      `${entries.length} entries` +
        (errors.length > 0
          ? ` (${errors.length} errors in the declarations of other packages ignored)`
          : '')
    )
  }
}

// 6. Binaries and requests, through the installed packages.
step('Binaries')
writeFileSync(
  join(app, 'api.mjs'),
  `import { createApp, defineRoute } from '@dotpress/core'
import { honoAdapter } from '@dotpress/adapter-hono'
import { z } from 'zod'

defineRoute({
  path: '/hello',
  schema: { query: z.object({ name: z.string() }) },
  handler: ({ query }) => ({ hello: query.name }),
})

export default () => createApp({ adapter: honoAdapter() })
`
)
const openapi = run(
  join(app, 'node_modules/.bin/dotpress-openapi'),
  ['api.mjs', '--title', 'Packed', '--api-version', '1.0.0'],
  { cwd: app }
)
try {
  const document = JSON.parse(openapi.stdout)
  if (openapi.status === 0 && document.paths?.['/hello']?.get) {
    ok(`dotpress-openapi (OpenAPI ${document.openapi})`)
  } else {
    fail(`dotpress-openapi: ${openapi.stderr || openapi.stdout}`)
  }
} catch {
  fail(`dotpress-openapi: ${openapi.stderr || openapi.stdout}`)
}
const events = run(join(app, 'node_modules/.bin/dotpress-events'), ['--help'], {
  cwd: app,
})
if (events.status === 0 && events.stdout.includes('Usage: dotpress-events')) {
  ok('dotpress-events --help')
} else {
  fail(`dotpress-events --help: ${events.stderr || events.stdout}`)
}

step('Requests through each adapter')
writeFileSync(
  join(app, 'requests.mjs'),
  `import { createApp, createRouter } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { honoAdapter } from '@dotpress/adapter-hono/node'

for (const [name, adapter] of [
  ['express', expressAdapter()],
  ['fastify', fastifyAdapter()],
  ['hono', honoAdapter()],
]) {
  const router = createRouter()
  router.defineRoute({ path: '/ping', handler: () => ({ adapter: name }) })
  const app = await createApp({ adapter, routers: [router] })
  await app.listen(0, '127.0.0.1')
  const { port } = adapter.server().address()
  const body = await (await fetch(\`http://127.0.0.1:\${port}/ping\`)).json()
  await app.close()
  if (body.adapter !== name) throw new Error(\`\${name}: \${JSON.stringify(body)}\`)
  console.log(name)
}
`
)
const requests = run(process.execPath, ['requests.mjs'], { cwd: app })
if (requests.status === 0) {
  ok(requests.stdout.trim().split('\n').join(', '))
} else {
  fail(`requests: ${requests.stderr || requests.stdout}`)
}

// 7. Size of a minimal Lambda, bundled (for information).
step('Bundle of a minimal Hono Lambda (esbuild, minified)')
writeFileSync(
  join(app, 'lambda.mjs'),
  `import { createApp } from '@dotpress/core'
import { honoAdapter } from '@dotpress/adapter-hono'
import { createLambdaHandler } from '@dotpress/adapter-hono/lambda'

export const handler = createLambdaHandler(() =>
  createApp({ adapter: honoAdapter() })
)
`
)
const bundle = run(
  join(app, 'node_modules/.bin/esbuild'),
  [
    'lambda.mjs',
    '--bundle',
    '--minify',
    '--platform=node',
    '--format=esm',
    '--outfile=lambda.bundle.mjs',
  ],
  { cwd: app }
)
if (bundle.status === 0) {
  const size = statSync(join(app, 'lambda.bundle.mjs')).size
  ok(`${(size / 1024).toFixed(1)} kB (Zod, Hono and @dotpress/core included)`)
} else {
  fail(`esbuild: ${bundle.stderr}`)
}

if (process.env.KEEP_PACKED) console.log(`\nProject kept in ${work}`)
else rmSync(work, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s).`)
  process.exitCode = 1
} else {
  console.log('\nAll packed packages work.')
}
