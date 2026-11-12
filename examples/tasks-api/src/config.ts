import { z } from 'zod'

// Every setting of the app, from the environment, checked at startup: a
// missing or invalid variable stops the process with an explicit message,
// instead of failing later on a request.
const Env = z.object({
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
  /**
   * Redis: the queue of the events (BullMQ) and a shared cache. Without
   * it, the listeners run in the API process, and the cache lives in
   * memory.
   */
  REDIS_URL: z.url().optional(),
  /** Name of the BullMQ queue, shared by the API and the worker. */
  EVENTS_QUEUE: z.string().min(1).default('tasks-api-events'),
  /** SMTP server of the emails. Without it, they are printed. */
  SMTP_URL: z.url().optional(),
  MAIL_FROM: z.string().min(1).default('Tasks <noreply@example.com>'),
})

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

/**
 * Checks the variables a process needs in production: the API and the
 * worker do not need the same ones.
 */
export const requireInProduction = (
  config: Config,
  names: readonly (keyof Config & Uppercase<string>)[]
) => {
  const missing = names.filter((name) => !config[name])
  if (config.production && missing.length > 0) {
    throw new Error(`Required in production: ${missing.join(', ')}.`)
  }
}
