import { z } from 'zod'

// Every setting of the app, from the environment, checked at startup: a
// missing or invalid variable stops the process with an explicit message,
// instead of failing later on a request.
const Env = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    /** SQLite database file, created when missing. */
    DATABASE_PATH: z.string().min(1).default('data/tasks.db'),
    /** Public URL of the API, written in the tokens (`iss`). */
    PUBLIC_URL: z.url().optional(),
    /** RSA key pair (PEM); generated in `data/` in development. */
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    JWT_PUBLIC_KEY: z.string().min(1).optional(),
    /** Redis: shared cache. Without it, the cache lives in memory. */
    REDIS_URL: z.url().optional(),
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY && env.PUBLIC_URL),
    {
      message:
        'JWT_PRIVATE_KEY, JWT_PUBLIC_KEY and PUBLIC_URL are required in production',
    }
  )

export type Config = ReturnType<typeof loadConfig>

/** Reads the configuration, or throws an error listing the problems. */
export const loadConfig = (
  env: Record<string, string | undefined> = process.env
) => {
  const result = Env.safeParse(env)
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`)
  }
  const config = result.data
  return {
    ...config,
    production: config.NODE_ENV === 'production',
    publicUrl: config.PUBLIC_URL ?? `http://localhost:${config.PORT}`,
  }
}
