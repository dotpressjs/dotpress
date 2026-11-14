# Options and durations

Every Dotpress function that takes options follows the same rules.

## Unknown options are rejected

A misspelled option would otherwise be ignored without a word: `middleware` instead of `middlewares`, and a route runs without its authentication. Dotpress throws a `TypeError` that names the option instead, when the app starts:

```ts
defineRoute({ path: '/admin', middleware: [requireAuth], handler })
// TypeError: Route "/admin": unknown option "middleware".
```

This applies to `createApp()`, the routes (their `schema` and `meta` too), the error helpers, the console logger, the adapters and their Lambda handlers, OpenAPI, the test helpers, and the auth, mailer, events and cache services. TypeScript reports most of these mistakes first; the check catches the others, in JavaScript or with an object built at runtime.

## Durations

An option typed `Duration` takes a number of **seconds**, fractions allowed, or a string with a unit:

| Value | Duration |
| --- | --- |
| `30`, `'30s'` | 30 seconds |
| `0.5`, `'500ms'` | half a second |
| `'10m'` | 10 minutes |
| `'1h'` | 1 hour |
| `'7d'` | 7 days |

The units are `ms`, `s`, `m`, `h` and `d`, with no space and no combination (`'1h30m'` is refused). Negative numbers are refused too.

The `Duration` type and `parseDuration()`, which converts a duration to milliseconds, are exported by `@dotpress/core`, for the options of your own code:

```ts
import { parseDuration, type Duration } from '@dotpress/core'

const timeout = (value: Duration) => parseDuration(value, 'options.timeout')

timeout(1.5) // 1500
timeout('10m') // 600000
timeout('soon') // TypeError: options.timeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.
```
