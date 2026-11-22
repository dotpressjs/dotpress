# Versioning and compatibility

From 2.0, the packages follow [semantic versioning](https://semver.org): a minor version never breaks code written for an earlier one of the same major. They are released together, with the same version number.

## What a minor version may change

- **New exports, and new optional options.** An option added to a function or a type is optional, with a default that keeps the previous behavior.
- **New members of the unions you test.** Code that switches on one of these unions keeps a `default` branch, or ignores the values it does not know:

  | Union | Package |
  | --- | --- |
  | `HttpMethod`, `LogLevel` | `@dotpress/core` |
  | `AuthErrorCode`, `AuthRouteErrorCode`, `LoginErrorType` | `@dotpress/auth` |
  | `DeadReason`, `RetryReason`, `HandleResult['status']` | `@dotpress/events` |
  | `StoreOperation`, `CacheAccess['type']`, `CacheAccess['reason']` | `@dotpress/cache` |
  | `MailFormat` | `@dotpress/mailer` |

- **New optional members of the contracts you implement**: `HttpAdapter`, `DataProvider`, `RateLimitStore`, `Transport`, `Source`, `CacheStore`, `MailProvider`. An implementation written for an earlier minor keeps working.
- **New optional fields** of the objects Dotpress returns, like the OpenAPI document.
- **Error messages.** They are written for people: test the error class, its `code` or its `status`, not its message.

## What only a major version changes

- Removing or renaming an export, an option or a member.
- Changing the type of an option or of a returned value, or the meaning of a default.
- Adding a required member to a contract you implement.
- Dropping a supported version of Node.js (22.12 and later) or of TypeScript (5.5 and later, with `strict`).

## How it is checked

Each entry point of a package has an API report, committed with the code: a change of the public API shows in the pull request that makes it, and is released with a changeset of the matching level. See [CONTRIBUTING.md](https://github.com/dotpressjs/dotpress/blob/main/CONTRIBUTING.md#public-api).

## Prereleases

Until 2.0, the prereleases may still break the API from one to the next: each one lists its breaking changes in the changelog of the packages. Since the beta (`2.0.0-beta.N`), the API is complete, and changes only from feedback.
