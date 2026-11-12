# Security checklist

`@dotpress/auth` is secure by default: rotating refresh tokens, short-lived access tokens, throttled logins, `httpOnly` cookies protected against CSRF. Some decisions remain yours. Check this list before going to production.

## Keys and tokens

- [ ] The private key is stored in a secret manager, never in the repository or an image. [Keys](./keys#store-them)
- [ ] Each environment has its own key pair, and its own `issuer`. [Keys](./keys#store-them)
- [ ] The keys are rotated on a schedule, and you know how to rotate them after a leak. [Rotation](./keys#rotate-them)
- [ ] `accessTokenTTL` stays short: 15 minutes by default. [Access tokens](./sessions#access-tokens)
- [ ] The username is not written in the tokens, unless needed (`usernameClaim`). [Access tokens](./sessions#access-tokens)

## Browsers

- [ ] Browser applications use the cookie mode with `accessTokenInCookie`: no token is readable by the JavaScript of the page. [Cookie mode](./cookies)
- [ ] The API is served over HTTPS only, and the cookies stay `secure`. [Cookies](./cookies#the-cookies)
- [ ] CORS lists the trusted origins explicitly, without `'*'` or a function accepting any origin. [CORS](/routing/http-options#cors)
- [ ] No `GET` route changes data: they are not checked against cross-site requests. [CSRF](./cookies#protection-against-cross-site-request-forgery)
- [ ] Mobile applications keep their tokens in the secure storage of the platform (Keychain, Keystore), never in plain files.

## Sessions

- [ ] Every session is revoked when a password is changed or reset, and when an account is disabled. [Password change](./sessions#revoke-every-session-after-a-password-change)
- [ ] `findUserById()` returns `undefined` for deleted, disabled and banned accounts. [Data provider](./data-provider#the-methods)
- [ ] Privileged applications (backoffice) have an absolute session timeout. [Session lifetimes](./sessions#session-lifetimes)
- [ ] Sensitive applications reject the tokens of a revoked session at once, with `isSessionRevoked`. [Revocation](./sessions#immediate-revocation)
- [ ] `onRefreshTokenReuse` raises an alert: a reused refresh token means a stolen session. [Rotation](./sessions#refresh-token-rotation)

## Passwords and logins

- [ ] Passwords are long (12 characters or more), without composition rules, and checked against known leaks. [Rules](./passwords#choosing-the-rules)
- [ ] The schemas of sign-up and password change reject passwords over 72 bytes (`isPasswordTooLong`). [72-byte limit](./passwords#the-72-byte-limit)
- [ ] The bcrypt cost (`passwordHashRounds`) is measured on your servers, and matches your stored hashes. [Hashing](./passwords#hashing)
- [ ] With several instances, the login throttle uses a shared store. [Shared store](./passwords#a-shared-store)
- [ ] Behind a proxy, the server trusts the proxy headers, so that each client has its own IP address. [Proxy](./passwords#brute-force-protection)
- [ ] Sign-up and password reset answer the same way whether the account exists or not. [Enumeration](./passwords#account-enumeration)

## Authorization

- [ ] Every route reading or changing a resource checks that the user may access **this** resource, not only that a user is logged in. [Authorization](./protecting-routes#authentication-is-not-authorization)
- [ ] Response schemas list the returned fields: password hashes and internal fields never reach the client. [Validation](/routing/validation#validating-the-response)
- [ ] The routes of a backoffice require its client and a role (`requireClient()`, `requireRole()`). [Clients](./clients)

## The app

- [ ] `exposeErrors` is disabled in production. [Errors](/routing/errors#details-in-development)
- [ ] Unexpected errors are reported (`onError`), and login failures are logged (`onLoginFailed`). [Login events](./passwords#login-events)
- [ ] Dependencies are kept up to date, and the security advisories of Dotpress are followed: see the [security policy](https://github.com/dotpressjs/dotpress/security/policy).
