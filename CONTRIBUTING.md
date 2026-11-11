# Contributing to Dotpress

Thanks for your interest in Dotpress! Bug reports, ideas and pull requests are welcome.

- Please follow the [code of conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately, as described in the [security policy](SECURITY.md), never in public issues.
- For a large change or a new feature, open an issue first, so that we can agree on the design before you write the code.

## Setup

Requirements:

- Node.js 22.18 or later for the tooling (the packages themselves run on Node.js 22.12 or later);
- pnpm 12, the version of the `packageManager` field of `package.json`: `corepack enable` on Node.js 22 and 24, otherwise `npm install --global pnpm@12`;
- Docker, for the integration tests (optional).

```sh
git clone https://github.com/dotpressjs/dotpress.git
cd dotpress
pnpm install
pnpm build   # required before testing: packages consume each other's builds
pnpm test
```

## Repository

| Path | Content |
|---|---|
| `packages/*` | The published packages, each with its README, sources (`src/`) and tests (`test/`) |
| `scripts/` | Checks of the repository (see below) |
| `.changeset/` | Pending changesets and the configuration of the releases |
| `.github/workflows/` | CI (`ci.yml`) and releases (`release.yml`) |

## Checks

The CI runs all of them on Node.js 22, 24 and 26; run the relevant ones before opening a pull request.

```sh
pnpm lint             # ESLint and Prettier (pnpm lint:fix, pnpm format)
pnpm typecheck
pnpm test             # every package; or pnpm --filter @dotpress/core test
pnpm check:core       # core, openapi and the main entries stay runtime-agnostic
pnpm check:packages   # manifests, publint and Are the Types Wrong? (after the build)
pnpm test:packed      # installs the packed packages in a new project, and checks them as a consumer
pnpm release:dry-run  # replays the release on a local Verdaccio registry (CI; needs a clean working tree)
```

### Integration tests

The tests of the event transports and of the cache stores run against real services when they are available, and are skipped otherwise. [serverless-redis-http](https://github.com/hiett/serverless-redis-http) serves the Upstash REST API in front of Redis.

```sh
docker run -d --rm -p 6379:6379 redis:7-alpine
docker run -d --rm -p 6380:6379 valkey/valkey:8-alpine
docker run -d --rm -p 8079:80 -e SRH_MODE=env -e SRH_TOKEN=test-token -e SRH_CONNECTION_STRING=redis://host.docker.internal:6379 hiett/serverless-redis-http:latest
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=events postgres:18-alpine
REDIS_URL=redis://localhost:6379 VALKEY_URL=redis://localhost:6380 UPSTASH_URL=http://localhost:8079 UPSTASH_TOKEN=test-token \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/events pnpm test
```

The Google Pub/Sub tests also run against its emulator (a large image, not run by the CI); push deliveries reach the test server through `host.docker.internal` (set `PUBSUB_PUSH_HOST` otherwise):

```sh
docker run -d --rm -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=test-project
PUBSUB_EMULATOR_HOST=localhost:8085 pnpm test
```

The Azure Service Bus tests run against its emulator, with the queues of `packages/events/test/fixtures/azure-service-bus-emulator.json` (the emulator needs a SQL container; not run by the CI):

```sh
docker network create service-bus
docker run -d --rm --name sqledge --network service-bus -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Dotpress-Test-1' mcr.microsoft.com/azure-sql-edge:latest
docker run -d --rm --network service-bus -p 5672:5672 -p 5300:5300 \
  -v "$PWD/packages/events/test/fixtures/azure-service-bus-emulator.json:/ServiceBus_Emulator/ConfigFiles/Config.json" \
  -e SQL_SERVER=sqledge -e MSSQL_SA_PASSWORD='Dotpress-Test-1' -e ACCEPT_EULA=Y \
  mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
SERVICE_BUS_CONNECTION='Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;' pnpm test
```

## Making a change

1. Create a branch from `main`.
2. Write the code and its tests. A test should fail without your change.
3. Update the README of the package when the behavior or the API changes.
4. Add a changeset if users will see the change (below).
5. Open a pull request, and fill in its checklist.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(cache): add the Upstash store`, `fix(adapters): …`, `docs: …`, `test: …`, `ci: …`, `chore: …`.

### Changesets

A changeset describes a change for the users of the packages: its line goes to their changelogs, and its level decides the next version. Add one for every change that users will see; tests, CI, internal refactoring and repository documentation need none.

```sh
pnpm changeset
```

It asks for the packages and the level, and writes a file to commit with your change:

```md
---
'@dotpress/core': minor
---

Add the `timeout` option to `defineRoute()`.
```

| Level | When | Example |
|---|---|---|
| `patch` | A bug fix, without API change | 2.0.0 → 2.0.1 |
| `minor` | A backward-compatible addition: option, store, export | 2.0.0 → 2.1.0 |
| `major` | A change that breaks existing code: renamed option, changed signature or default, removed export | 2.0.0 → 3.0.0 |

Write the summary for users, in English: what changes for them, and what to do for a `major` change. All the `@dotpress/*` packages share one version: the highest level of the pending changesets applies to all of them.

Until 2.0.0 (alpha, beta and release candidates), every release is a prerelease (`2.0.0-alpha.N`…), and breaking changes are still possible: mark them `major` all the same, so that the changelog of 2.0.0 lists them.

## Conventions

- **English** everywhere: code, comments, error messages, documentation, commits.
- **ES modules only**, without top-level `await` in published code, so that CommonJS projects can `require()` the packages.
- **Runtime-agnostic packages**: `core`, `auth`, `openapi`, `mailer`, `events` and `cache` use Web-standard APIs only, apart from their Node.js entries (servers, clients, commands). ESLint and `pnpm check:core` enforce it. Node.js built-in modules are imported with the `node:` prefix.
- **Options are checked** when they are given, with explicit errors naming the function: `createCloudflareKvStore(): cacheTtl must be at least 30 seconds.` Unknown options are refused.
- **Generic examples**: tests, READMEs and examples use neutral names (`user.created`, `example.com`), never real companies or projects.
- **No new dependency** without discussing it first: prefer the APIs of the platform, and optional peer dependencies for integrations.

## Releases (maintainers)

Releases are automated by [Changesets](https://changesets.dev) and the Release workflow (`.github/workflows/release.yml`), which runs after a successful CI run on `main`:

1. While changesets are pending, it opens or updates a **Version Packages** pull request: the next versions and the changelogs.
2. Merging that pull request publishes the packages to npm, with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm token, with provenance), and creates the git tags and the GitHub releases.

Review the Version Packages pull request before merging it: the version in its title is the one that will be published. GitHub does not run the CI on it (it is opened by the workflow): the packages are only published once the CI passes on `main` after the merge.

### Prereleases

The repository is in prerelease mode (`.changeset/pre.json`) until 2.0.0:

```sh
pnpm changeset pre exit        # the next Version Packages pull request releases 2.0.0
pnpm changeset pre enter beta  # after an exit: 2.0.0-beta.N
```

In prerelease mode, the packages without stable version have their prereleases under the `latest` dist-tag, and the others under the prerelease tag: `@dotpress/auth`, whose `latest` is the 1.x, gets its prereleases under `alpha`, `beta` or `rc`. After a stable release, `latest` is the new version and older prerelease tags are removed.

The Release workflow sets these dist-tags after publishing (`scripts/sync-dist-tags.mjs`), whatever tag Changesets chose: the trusted publisher of each package without stable version must allow it (**Allow npm dist-tag** in the package settings on npmjs.com, including for a new package). Without it, a package with a stable version only keeps an old prerelease tag after a stable release. The release dry run of the CI checks them on a local registry, seeded with the versions published on npm.
