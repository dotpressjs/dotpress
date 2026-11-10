import { vi } from 'vitest'
import {
  createMemoryStore,
  type CacheLogger,
  type CacheStore,
} from '../src/index.js'

/** A logger recording its calls. */
export const createLogger = () => {
  const entries: { level: string; data: object; message: string }[] = []
  const log =
    (level: string) =>
    (data: object, message: string): void =>
      void entries.push({ level, data, message })
  const logger: CacheLogger & { entries: typeof entries } = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    entries,
  }
  return logger
}

/** A memory store whose calls are spied, and can be made to fail. */
export const createSpyStore = (overrides: Partial<CacheStore> = {}) => {
  const memory = createMemoryStore()
  const store = {
    name: 'spy',
    get: vi.fn((key: string) => memory.get(key)),
    set: vi.fn((key: string, value: string, ttl: number) =>
      memory.set(key, value, ttl)
    ),
    delete: vi.fn((key: string) => memory.delete(key)),
    memory,
  }
  Object.assign(store, overrides)
  return store
}

/** Stored entry of a key, parsed. */
export const storedOf = async (store: CacheStore, key: string) => {
  const text = await store.get(key)
  return text === undefined ? undefined : (JSON.parse(text) as object)
}
