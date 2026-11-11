// Release dry run: replays the release of the Release workflow on a local
// Verdaccio registry (scripts/verdaccio.yaml), never on npm.
//
// 1. Seeds the local registry with the versions of the @dotpress/* dist-tags
//    published on npm (read only).
// 2. Versions the pending changesets, builds, packs and publishes like the
//    workflow (changeset pack, then publish --from-pack-dir).
// 3. Checks the result: every version published without `workspace:`
//    ranges, and the dist-tags. In prerelease mode, a package with a stable
//    version keeps its `latest` tag and gets the prerelease tag; the others
//    are published to `latest`, and no other tag may point elsewhere (a
//    prerelease tag left behind).
//
// It changes the working tree (versions, changelogs): it runs in CI, or in
// a clean checkout. GITHUB_TOKEN is needed to version changesets (links of
// the changelogs).
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const NPM = 'https://registry.npmjs.org/'
const registry = (
  process.env.DRY_RUN_REGISTRY ?? 'http://localhost:4873/'
).replace(/\/?$/, '/')
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(registry)) {
  throw new Error(`The dry run publishes to a local registry only: ${registry}`)
}

const root = new URL('../', import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), 'dotpress-release-'))

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`
    )
  }
  return result
}

if (run('git', ['status', '--porcelain']).stdout.trim() !== '') {
  throw new Error(
    'The dry run changes the working tree: commit or stash first.'
  )
}

// npm and pnpm only see the local registry, without the user's npmrc.
// A new user each time: the registry may come from a previous dry run.
const name = `dry-run-${Date.now()}`
const user = await fetch(`${registry}-/user/org.couchdb.user:${name}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, password: `${name}-password` }),
})
const { token } = await user.json()
if (!token) throw new Error(`No token from ${registry}: ${user.status}`)
const npmrc = join(work, 'npmrc')
const host = registry.replace(/^http:/, '')
writeFileSync(npmrc, `registry=${registry}\n${host}:_authToken=${token}\n`)
const env = {
  ...process.env,
  NPM_CONFIG_USERCONFIG: npmrc,
  npm_config_userconfig: npmrc,
  NPM_CONFIG_REGISTRY: registry,
  npm_config_registry: registry,
}
const local = (command, args, options) =>
  run(command, args, { env, ...options })

// pnpm as started by `pnpm release:dry-run`, or from the PATH.
const pnpmPath = process.env.npm_execpath ?? 'pnpm'
const pnpm = (args, options) =>
  /\.[cm]?js$/.test(pnpmPath)
    ? local(process.execPath, [pnpmPath, ...args], options)
    : local(pnpmPath, args, options)

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir, 'package.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => !pkg.private)
  .map((pkg) => pkg.name)

const view = (spec, field, from) => {
  const result = run(
    'npm',
    ['view', spec, ...(field ? [field] : []), '--json', '--registry', from],
    { allowFailure: true, env: from === NPM ? process.env : env }
  )
  return result.status === 0 && result.stdout.trim()
    ? JSON.parse(result.stdout)
    : undefined
}

// 1. Seed: the versions of the dist-tags published on npm.
console.log(`Seeding ${registry} from npm`)
const seeded = new Map()
for (const name of packages) {
  const tags = view(name, 'dist-tags', NPM)
  if (!tags) {
    console.log(`  ${name}: not on npm`)
    continue
  }
  const versions = [].concat(view(name, 'versions', NPM) ?? [])
  seeded.set(name, { tags, hasStable: versions.some((v) => !v.includes('-')) })
  // `latest` first: the registry gives it to the first version published.
  const ordered = Object.entries(tags).sort(([a], [b]) =>
    a === 'latest' ? -1 : b === 'latest' ? 1 : 0
  )
  const published = new Set()
  for (const [tag, version] of ordered) {
    // Already there (a previous dry run on the same registry): tag only.
    if (
      published.has(version) ||
      view(`${name}@${version}`, 'version', registry)
    ) {
      local('npm', ['dist-tag', 'add', `${name}@${version}`, tag])
      published.add(version)
      continue
    }
    const packDir = join(work, 'seed')
    mkdirSync(packDir, { recursive: true })
    const file = run('npm', ['pack', `${name}@${version}`, '--registry', NPM], {
      cwd: packDir,
    })
      .stdout.trim()
      .split('\n')
      .at(-1)
    local('npm', ['publish', join(packDir, file), '--tag', tag])
    published.add(version)
  }
  console.log(`  ${name}: ${JSON.stringify(tags)}`)
}

// 2. Version, build, pack and publish, like the Release workflow.
const changesets = readdirSync(join(root, '.changeset')).filter(
  (file) => file.endsWith('.md') && file !== 'README.md'
)
if (changesets.length > 0) {
  console.log(`\nVersioning ${changesets.length} changeset(s)`)
  pnpm(['changeset', 'version'])
}
console.log('\nBuilding, packing and publishing')
pnpm(['build'])
const packDir = join(work, 'pack')
pnpm(['changeset', 'pack', '--out-dir', packDir])
const publish = pnpm([
  'changeset',
  'publish',
  '--from-pack-dir',
  packDir,
  '--no-git-tag',
])
console.log(
  stripVTControlCharacters(publish.stdout)
    .split('\n')
    .filter((line) => /@dotpress\/|latest|published/i.test(line))
    .map((line) => `  ${line.trim()}`)
    .join('\n')
)

// 3. Checks.
console.log('\nChecking the local registry')
const pre = existsSync(join(root, '.changeset/pre.json'))
  ? JSON.parse(readFileSync(join(root, '.changeset/pre.json'), 'utf8'))
  : undefined
const preTag = pre?.mode === 'pre' ? pre.tag : undefined
const failures = []
for (const name of packages) {
  const dir = name.replace('@dotpress/', '')
  const version = JSON.parse(
    readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')
  ).version
  const errors = []
  const manifest = view(`${name}@${version}`, '', registry)
  if (!manifest) {
    errors.push(`${version} is not published`)
  } else {
    const ranges = ['dependencies', 'peerDependencies']
      .flatMap((field) => Object.values(manifest[field] ?? {}))
      .filter((range) => range.startsWith('workspace:'))
    if (ranges.length > 0) errors.push(`workspace ranges: ${ranges.join(', ')}`)
  }
  const tags = view(name, 'dist-tags', registry) ?? {}
  const before = seeded.get(name)
  const expected = {}
  if (preTag && before?.hasStable) {
    expected.latest = before.tags.latest
    expected[preTag] = version
  } else {
    expected.latest = version
  }
  for (const [tag, value] of Object.entries(tags)) {
    if (!(tag in expected) && value !== version && !before?.hasStable) {
      errors.push(`dist-tag ${tag} still points to ${value}`)
    }
  }
  for (const [tag, value] of Object.entries(expected)) {
    if (tags[tag] !== value) {
      errors.push(`dist-tag ${tag} is ${tags[tag]}, expected ${value}`)
    }
  }
  if (errors.length > 0) {
    failures.push(name)
    console.error(`  ✗ ${name}@${version}: ${errors.join('; ')}`)
  } else {
    console.log(`  ✓ ${name}@${version} ${JSON.stringify(tags)}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) would be released wrongly.`)
  process.exitCode = 1
} else {
  console.log('\nThe release would publish as expected.')
}
