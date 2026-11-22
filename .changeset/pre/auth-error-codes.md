---
'@dotpress/auth': minor
---

**Breaking (prerelease):** the errors of the authentication routes carry their code in the `error` field, with a sentence in `message`, like every error of Dotpress. Before, the code was in `message`, and `error` held the generic code of the status.

```json
{ "status": 401, "error": "EXPIRED_REFRESH_TOKEN", "message": "The session has expired. Log in again." }
```

Clients test `error` (or the status) instead of `message`. The codes are typed by the new `AuthRouteErrorCode` export: `INVALID_LOGIN`, `TOO_MANY_LOGIN_ATTEMPTS`, `NO_TOKENS_PROVIDED`, `INVALID_REFRESH_TOKEN`, `EXPIRED_REFRESH_TOKEN`, `COOKIES_NOT_ENABLED`, `ACCESS_TOKEN_NOT_IN_COOKIE`, `NO_REFRESH_TOKEN`, `NO_ACCESS_TOKEN` and `CROSS_ORIGIN_REQUEST`.
