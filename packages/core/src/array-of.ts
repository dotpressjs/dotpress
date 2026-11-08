import * as z from 'zod'
import type { Schema } from './schema.js'

const toArray = (value: unknown) =>
  value === undefined || Array.isArray(value) ? value : [value]

type ArrayOf<T extends Schema> = T extends z.core.$ZodArray
  ? z.ZodPipe<z.ZodTransform<unknown, unknown>, T>
  : z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodArray<T>>

/**
 * Validates a field that may be sent once or several times (query string,
 * form fields, files): a single value is wrapped in an array before
 * validation, so the handler always receives an array.
 *
 * Pass an element schema, or an array schema to add array constraints.
 * Missing values stay `undefined`: chain `.optional()` or `.default([])`.
 *
 * @example
 * schema: (z) => ({
 *   query: z.object({ tag: arrayOf(z.string()).default([]) }),
 *   files: z.object({ photos: arrayOf(z.array(z.file().mime(['image/png'])).max(5)) }),
 * })
 */
export const arrayOf = <T extends Schema>(schema: T): ArrayOf<T> => {
  // `def.type` also identifies Zod mini arrays, unlike `instanceof`.
  const array =
    schema._zod.def.type === 'array'
      ? schema
      : z.array(schema as unknown as z.ZodType)

  return z.preprocess(toArray, array) as unknown as ArrayOf<T>
}
