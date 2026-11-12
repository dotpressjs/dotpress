# @dotpress/events

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
