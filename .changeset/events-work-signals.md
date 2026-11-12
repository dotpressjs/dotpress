---
'@dotpress/events': patch
---

`dotpress-events work`: Ctrl+C stops the worker after the messages in progress, also through `npm run`, `pnpm run` and `--watch`, which relay the signal: the repeats of a signal within one second are the same stop request, and a signal sent again a second later or more exits at once. With `--watch`, a signal sent to the command only (`kill`, the stop button of an IDE) now stops the worker, instead of leaving it running.
