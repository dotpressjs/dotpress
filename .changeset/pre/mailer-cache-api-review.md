---
'@dotpress/mailer': minor
'@dotpress/cache': minor
---

API review of the mailer and the cache, before the beta. Breaking changes:

- `mailer.withLogger(logger)` and `cache.withLogger(logger)` become `withContext({ logger })`, like the event bus.
- `MailerLogger` has the methods of the other loggers: `info`, `warn` and `error`, and optionally `debug`. A logger with `info` only is rejected.
- The attachments given to `send()` and `sendMessage()` are typed `MailAttachmentInput`; providers receive the validated `MailAttachment`.
- The `Source` type of the mailer is renamed `TemplateSource` (`Source` is a worker source in `@dotpress/events`). `DataOf` and `DataOption` are no longer exported.
- `createNodemailerProvider(transporter, { name })` takes its name as an option.
- The `onEvent` option of `createCache()` is renamed `onAccess`, and `CacheEvent` `CacheAccess`.
- `MemoScope` is exported by `@dotpress/cache` (still by `@dotpress/cache/plugin`): `@dotpress/cache/als` no longer depends on the plugin entry.
