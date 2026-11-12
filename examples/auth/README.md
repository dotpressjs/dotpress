# Dotpress authentication

A private notes API with [Dotpress](https://dotpress.dev) and `@dotpress/auth`, on [Express](https://expressjs.com):

- sign-up, login, and the access token in the `Authorization` header (mobile apps, other services);
- cookie sessions for browsers: both tokens in `httpOnly` cookies, protected against cross-site request forgery;
- refresh token rotation, with the session revoked when a used refresh token comes back;
- logout of the current device or of every device, effective at once;
- password change, which logs out every device;
- routes for authenticated users (`requireAuth`), and for admins (`requireRole('admin')`);
- the OpenAPI document and the Scalar page, with the guarded routes marked as secured.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/auth my-api
cd my-api
npm install
ADMIN_PASSWORD='choose a long passphrase' npm run dev
```

Without `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, a temporary key pair is generated at startup: the tokens stop working at each restart. `ADMIN_PASSWORD` creates an `admin` account (`ADMIN_USERNAME` changes its name).

```sh
curl -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct horse battery staple"}'
curl -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct horse battery staple"}'
# { "accessToken": "…", "refreshToken": "…", "expiresIn": 900, … }
curl localhost:3000/notes -H 'authorization: Bearer <accessToken>'
```

`http://localhost:3000/docs` lists every route: log in there, then paste the access token in the Authorize dialog. `npm test` runs the tests, `npm run typecheck` checks the types.

## Deploy

| Variable | Content |
| --- | --- |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | RSA key pair, PEM encoded (PKCS#8 and SPKI). Required when `NODE_ENV` is `production`. Line breaks may be escaped (`\n`). |
| `JWT_ISSUER` | URL of the API, written in the tokens and checked on every request. One value per environment. |
| `PORT` | Defaults to `3000`. |

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

Keep the private key in the secrets of your platform, never in the repository.

The users, the refresh tokens and the notes are kept in memory, and the login throttle counts the attempts in memory: they are lost at restart, and not shared between instances. Replace `src/store.ts` and `src/notes.ts` with your database, and give the login throttle a shared store when you run several instances.

## Body or cookies

The client chooses at login:

| Login body | Tokens | Next requests |
| --- | --- | --- |
| `{ username, password }` | in the response body | `Authorization: Bearer <accessToken>`; `POST /auth/refresh` with both tokens in the body |
| `{ username, password, mode: 'cookie' }` | in `httpOnly` cookies, never in the body | the browser sends the cookies; `POST /auth/restore` when the page loads |

In cookie mode, the API accepts the cookies from its own origin only. A front-end served from another origin must be allowed by the `cors` option of the app, with `credentials: true`.

## Files

| File | Content |
| --- | --- |
| `src/auth.ts` | The authentication service (`createAuth()`), and the type of `ctx.user` |
| `src/store.ts` | The users and the refresh tokens (`DataProvider`), to replace with your database |
| `src/routes.ts` | Sign-up and password change, the notes of the user, the admin routes |
| `src/notes.ts` | The notes, to replace with your database |
| `src/keys.ts` | The key pair, from the environment |
| `src/app.ts` | The app, with the auth and OpenAPI plugins |
| `src/server.ts` | The Express server |
| `test/tokens.test.ts` | Body mode: login, refresh, rotation, logout, brute force protection |
| `test/cookies.test.ts` | Cookie mode: cookies, cross-site requests, restore, logout |
| `test/users.test.ts` | Sign-up, password change, notes of each user, roles, OpenAPI |
| `test/keys.test.ts` | The key pair |
| `test/server.test.ts` | Tests over HTTP, on Express |

The [authentication guide](https://dotpress.dev) covers the other settings: client applications, key rotation, session timeouts, public keys for other services.
