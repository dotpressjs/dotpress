// Sets the npm dist-tags of the versions just published (Release workflow,
// after `changeset publish`), whatever tag changesets chose:
//
// - prerelease mode (.changeset/pre.json), package without stable version:
//   `latest` is the new version, and no prerelease tag remains;
// - prerelease mode, package with a stable version: `latest` is kept, and
//   the tag of the mode (`alpha`, `beta`, `rc`) is the new version;
// - stable release: `latest` is the new version, and the prerelease tags of
//   older versions are removed.
//
// The registry takes a moment to list a version just published, and npm may
// hold a new version in staging for several minutes (10 for
// @dotpress/testing@2.0.0-beta.0) before listing it: the script waits for
// it (20 minutes at most for the whole run), then fails if it is still
// missing. Publishing it again does not help: npm answers 409 "Cannot
// publish over previously staged version". Once the version is listed, run
// the dist-tags job of the Release workflow.
//
// npm authenticates with trusted publishing in CI (npm 11.21 or later, with
// "Allow npm dist-tag" on the trusted publisher), or with the npmrc of the
// environment (release dry run). DRY_RUN=1 only prints the changes.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const dryRun = Boolean(process.env.DRY_RUN)

const npm = (args) =>
  execFileSync('npm', args, { cwd: root, encoding: 'utf8' }).trim()

// One deadline for all the packages: a run never waits more than 20 minutes.
const WAIT_MINUTES = 20
const deadline = Date.now() + WAIT_MINUTES * 60_000
const RETRY_DELAY = 30_000
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The versions and dist-tags of a package, once `version` is listed. */
const viewPublished = (name, version) => {
  for (;;) {
    let reason = 'not listed yet'
    try {
      const info = JSON.parse(
        npm([
          'view',
          name,
          'versions',
          'dist-tags',
          '--json',
          '--prefer-online',
        ])
      )
      const versions = [].concat(info.versions ?? [])
      if (versions.includes(version)) {
        return { versions, tags: info['dist-tags'] ?? {} }
      }
    } catch (error) {
      // A package published for the first time can answer 404 for a while.
      reason = (error.stderr || error.message).trim().split('\n')[0]
    }
    if (Date.now() + RETRY_DELAY > deadline) return undefined
    console.log(
      `${name}@${version}: ${reason} (npm may stage a new version for several minutes), waiting`
    )
    sleep(RETRY_DELAY)
  }
}

/** [major, minor, patch] of a version, and whether it is a prerelease. */
const parse = (version) => {
  const [core, pre] = version.split('+')[0].split(/-(.*)/s)
  return { core: core.split('.').map(Number), prerelease: pre !== undefined }
}
const compareCore = (a, b) =>
  a.core.reduce((result, part, index) => result || part - b.core[index], 0)

const pre = existsSync(join(root, '.changeset/pre.json'))
  ? JSON.parse(readFileSync(join(root, '.changeset/pre.json'), 'utf8'))
  : undefined
const preTag = pre?.mode === 'pre' ? pre.tag : undefined

let failed = false
for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const file = join(root, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const {
    name,
    version,
    private: isPrivate,
  } = JSON.parse(readFileSync(file, 'utf8'))
  if (isPrivate) continue

  const published = viewPublished(name, version)
  if (!published) {
    failed = true
    console.error(
      `${name}@${version}: not listed by the registry after ${WAIT_MINUTES} minutes, skipped. Do not publish it again (npm answers 409 while it stages a version): once it is listed, run the dist-tags job of the Release workflow.`
    )
    continue
  }
  const { versions, tags } = published
  const hasStable = versions.some((value) => !parse(value).prerelease)

  const add = {}
  const remove = []
  if (preTag && !hasStable) {
    add.latest = version
    for (const [tag, value] of Object.entries(tags)) {
      if (tag !== 'latest' && parse(value).prerelease) remove.push(tag)
    }
  } else if (preTag) {
    add[preTag] = version
  } else {
    add.latest = version
    for (const [tag, value] of Object.entries(tags)) {
      const tagged = parse(value)
      if (
        tag !== 'latest' &&
        tagged.prerelease &&
        compareCore(tagged, parse(version)) <= 0
      ) {
        remove.push(tag)
      }
    }
  }

  const changes = [
    ...Object.entries(add)
      .filter(([tag, value]) => tags[tag] !== value)
      .map(([tag, value]) => ['add', `${name}@${value}`, tag]),
    ...remove.map((tag) => ['rm', name, tag]),
  ]
  if (changes.length === 0) {
    console.log(`${name}@${version}: ${JSON.stringify(tags)}`)
    continue
  }
  for (const change of changes) {
    console.log(`${name}@${version}: npm dist-tag ${change.join(' ')}`)
    if (dryRun) continue
    try {
      npm(['dist-tag', ...change])
    } catch (error) {
      // After a stable release, an old prerelease tag left behind is only
      // cosmetic: a package without "Allow npm dist-tag" keeps it.
      const cosmetic = !preTag && change[0] === 'rm'
      if (!cosmetic) failed = true
      console.error(
        `  ${cosmetic ? 'warning' : 'failed'}: ${error.stderr || error.message}`
      )
    }
  }
}

if (failed) process.exitCode = 1
