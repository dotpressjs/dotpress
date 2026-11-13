# Authentication

A private notes API with `@dotpress/auth`, on Express:

- sign-up, login, and the access token in the `Authorization` header, for mobile apps and other services;
- cookie sessions for browsers: both tokens in `httpOnly` cookies, protected against cross-site request forgery;
- refresh token rotation, with the session revoked when a used refresh token comes back;
- logout of the current device or of every device, and a password change that logs out every device;
- routes for authenticated users (`requireAuth`), and for admins (`requireRole('admin')`);
- the OpenAPI document and the Scalar page, with the guarded routes marked as secured.

Source: [`examples/auth`](https://github.com/dotpressjs/dotpress/tree/main/examples/auth).

## Run it

```sh
npx degit dotpressjs/dotpress/examples/auth my-api
cd my-api
npm install
ADMIN_PASSWORD='choose a long passphrase' npm run dev
```

Without `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, a temporary key pair is generated at startup: tokens stop working at each restart. `ADMIN_PASSWORD` creates an `admin` account.

```sh
curl -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct horse battery staple"}'
curl -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct horse battery staple"}'
# { "accessToken": "…", "refreshToken": "…", "expiresIn": 900, … }
curl localhost:3000/notes -H 'authorization: Bearer <accessToken>'
```

`http://localhost:3000/docs` lists every route: log in there, then paste the access token in the Authorize dialog.

## The service

`createAuth()` with the keys, the issuer and the data provider. The type of `ctx.user` is declared here, once:

```ts file="<root>/../examples/auth/src/auth.ts"
```

The data provider (`src/store.ts`) keeps the users and the refresh tokens in memory: replace it with your database, as in the [SQL data provider](/auth/data-provider#an-sql-data-provider) of the Tasks API.

## The app

```ts file="<root>/../examples/auth/src/app.ts"
```

## The routes

Sign-up validates the password length for bcrypt, a password change revokes every session, and each user only sees their own notes:

```ts file="<root>/../examples/auth/src/routes.ts"
```

## Body or cookies

The client chooses at login:

| Login body | Tokens | Next requests |
| --- | --- | --- |
| `{ username, password }` | in the response body | `Authorization: Bearer <accessToken>`; `POST /auth/refresh` with both tokens in the body |
| `{ username, password, mode: 'cookie' }` | in `httpOnly` cookies, never in the body | the browser sends the cookies; `POST /auth/restore` when the page loads |

In cookie mode, the API accepts the cookies from its own origin only. A front-end served from another origin must be allowed by the `cors` option of the app, with `credentials: true`.

## Before production

- Give the key pair in `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, from the secrets of your platform, and the URL of the API in `JWT_ISSUER`.
- Replace the in-memory stores with your database, and give the login throttle a [shared store](/auth/passwords#a-shared-store) when you run several instances.
- Go through the [security checklist](/auth/security).

## Learn more

- [Authentication](/auth/)
- [Sessions and tokens](/auth/sessions)
- [Cookie mode and CSRF](/auth/cookies)
- [Protecting routes](/auth/protecting-routes)
