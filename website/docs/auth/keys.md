# Keys and rotation

Access tokens are signed with an RSA private key (RS256), and verified with its public key. Whoever holds the private key can sign tokens for any user: protect it like your database password, and rotate it.

## Generate a key pair

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem # PKCS#8
openssl pkey -in private.pem -pubout -out public.pem # SPKI
```

`@dotpress/auth` expects PEM keys in the PKCS#8 (`BEGIN PRIVATE KEY`) and SPKI (`BEGIN PUBLIC KEY`) formats. `createApp()` fails when the public key does not match the private key, and explains how to convert PKCS#1 keys (`BEGIN RSA PRIVATE KEY`):

```sh
openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem
openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem
```

## Store them

- Keep the private key in a secret manager (AWS Secrets Manager, Vault, the secrets of your platform), given to the app as an environment variable. Never in the repository, never in a container image.
- Use **one key pair per environment**: a token of staging must not open production. The `issuer` setting, checked on every request, adds a second barrier: one value per environment and application.
- Platforms that store a PEM in one line escape its line breaks: restore them with `value.replaceAll('\\n', '\n')`.
- In development, a key pair can be generated at startup (`generateKeyPairSync()` of `node:crypto`), as the [Auth example](/examples/auth) does: the tokens then stop working at each restart.

## Rotate them

Rotate the signing keys on a schedule, every few months for instance, and at once after a suspected leak. A scheduled rotation logs nobody out: the old public key keeps verifying the tokens it signed, while the new private key signs the new ones.

```ts
keys: {
  secretKey: env.JWT_PRIVATE_KEY, // the new pair
  publicKey: env.JWT_PUBLIC_KEY,
  additionalPublicKeys: [env.JWT_PREVIOUS_PUBLIC_KEY], // the old public key
}
```

| Step | Configuration |
| --- | --- |
| 1. Announce the new key, when several instances deploy one after the other | old pair active, new public key in `additionalPublicKeys` |
| 2. Switch | new pair active, old public key in `additionalPublicKeys` |
| 3. After `session.idleTimeout` (14 days by default) | remove the old public key |

Keep the old public key for the inactivity timeout of the sessions, not only for the lifetime of the access tokens: a refresh verifies the signature of the expired access token, so a client that was inactive for a week still presents a token of the old key.

Each token carries a `kid` header, the thumbprint of its public key (RFC 7638), or `keys.kid`: the right key is picked among the configured ones only. Tokens without `kid`, issued by Dotpress 1, are tried with every configured key.

### After a compromise

Configure the new pair alone, without `additionalPublicKeys`: every token of the old key, including the forged ones, is rejected at once. Every user logs in again; that is the price of a leaked key.

## Publish the public keys

Other services can verify the tokens of your API themselves:

```ts
authPlugin(auth, { jwks: true }) // GET /.well-known/jwks.json, cached 5 minutes
```

They follow the rotations through the key set, for instance with `createRemoteJWKSet()` of [jose](https://github.com/panva/jose). They must check the issuer, the audience and the `at+jwt` type, like Dotpress does. `auth.getJwks()` returns the same key set.
