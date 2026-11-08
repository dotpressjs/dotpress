import type * as z from 'zod'

/**
 * Any Zod 4 schema (classic or mini).
 */
export type Schema = z.core.$ZodType

/**
 * Validation schemas of a route.
 */
export interface RouteSchema {
  /** Path parameters. Without schema, they are inferred from the path. */
  params?: Schema
  query?: Schema
  body?: Schema
  /**
   * Uploaded files (`multipart/form-data`), as an object schema of
   * `z.file()` (or `z.array(z.file())` for repeated fields).
   */
  files?: Schema
  /**
   * Response body. Returned values are parsed with this schema (unknown keys
   * are stripped by object schemas) before being sent.
   */
  response?: Schema
}

/**
 * Route schemas, as an object or as a factory receiving `z`.
 */
export type SchemaDefinition<S extends RouteSchema> = S | ((zod: typeof z) => S)

/**
 * Output type of a schema property, or a fallback when it is not defined.
 */
export type SchemaOutput<S, K extends keyof RouteSchema, Fallback> = S extends {
  [P in K]: infer T extends Schema
}
  ? z.output<T>
  : Fallback

/**
 * Input type of a schema property, or a fallback when it is not defined.
 */
export type SchemaInput<S, K extends keyof RouteSchema, Fallback> = S extends {
  [P in K]: infer T extends Schema
}
  ? z.input<T>
  : Fallback
