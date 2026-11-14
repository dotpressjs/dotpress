# @dotpress/events

## 2.0.0-alpha.4

### Minor Changes

- [#14](https://github.com/dotpressjs/dotpress/pull/14) [`bf496ad`](https://github.com/dotpressjs/dotpress/commit/bf496ad1f51a875c07502f9075c04ad536c5d338) Thanks [@renoguyon](https://github.com/renoguyon)! - `emit()` accepts an `emissionId` option: the message ids derive from it, so emitting again with the same `emissionId` gives the same ids, and listeners can ignore the duplicates. `EventEmitError#retry()` sends again only the messages that failed, with the same ids, delay and metadata; a new failure throws a new `EventEmitError` whose `sent` adds up the attempts. `createFakeEventBus()` records the given `emissionId`.

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#13](https://github.com/dotpressjs/dotpress/pull/13) [`a79013c`](https://github.com/dotpressjs/dotpress/commit/a79013cb57792ac4df83d76b28c72279b04e12fe) Thanks [@renoguyon](https://github.com/renoguyon)! - Faster Pub/Sub publishing of large messages: base64 encoding uses `Uint8Array#toBase64` when the runtime has it, and encodes by chunks otherwise. A message of several megabytes took about a second of CPU, blocking the event loop.

- [#7](https://github.com/dotpressjs/dotpress/pull/7) [`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: each package describes itself with an example, and links to its pages on the documentation site, dotpress.dev, which holds the guides and the reference.
- Updated dependencies [[`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b)]:
  - @dotpress/core@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- [#2](https://github.com/dotpressjs/dotpress/pull/2) [`5128817`](https://github.com/dotpressjs/dotpress/commit/5128817d0975df4797b31a0b4c4edf4c55c4cb56) Thanks [@renoguyon](https://github.com/renoguyon)! - `dotpress-events work`: Ctrl+C stops the worker after the messages in progress, also through `npm run`, `pnpm run` and `--watch`, which relay the signal: the repeats of a signal within one second are the same stop request, and a signal sent again a second later or more exits at once. With `--watch`, a signal sent to the command only (`kill`, the stop button of an IDE) now stops the worker, instead of leaving it running.
- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
- Updated dependencies [[`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4)]:
  - @dotpress/core@2.0.0-alpha.1
