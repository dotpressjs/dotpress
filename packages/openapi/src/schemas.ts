import * as z from 'zod'
import type { JsonSchema } from './types.js'

/** Side of a schema: what the client sends, or what the API returns. */
export type SchemaSide = 'input' | 'output'

type Schema = z.core.$ZodType

const COMPONENTS = '#/components/schemas/'
/** Marks references to the input variant until names are final. */
const INPUT_MARK = '@input'

/** Zod types without JSON representation, documented as any value. */
const UNREPRESENTABLE = new Set([
  'bigint',
  'symbol',
  'void',
  'map',
  'set',
  'transform',
  'nan',
  'custom',
  'function',
  'promise',
])

interface Definition {
  readonly schema: JsonSchema
  readonly json: string
}

/** Copies a JSON value, replacing the `$ref` strings. */
export const mapRefs = <T>(value: T, map: (ref: string) => string): T => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => mapRefs(item, map)) as T
  }
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string'
        ? map(item)
        : mapRefs(item, map),
    ])
  ) as T
}

const hasRootRef = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasRootRef)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) =>
    key === '$ref' ? item === '#' : hasRootRef(item)
  )
}

/**
 * Converts Zod schemas to JSON Schema, and collects the schemas with an
 * identifier (`.meta({ id })`) as reusable components.
 */
export const createSchemaCollector = (warn: (message: string) => void) => {
  const definitions = new Map<string, Partial<Record<SchemaSide, Definition>>>()
  let anonymous = 0

  const convert = (
    schema: Schema,
    side: SchemaSide,
    where: string
  ): JsonSchema => {
    const unrepresentable = new Set<string>()
    const result = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: side,
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
      override: ({ zodSchema, jsonSchema }) => {
        const { type } = zodSchema._zod.def
        // Dates are sent as ISO 8601 strings in JSON.
        if (type === 'date') {
          jsonSchema.type = 'string'
          jsonSchema.format = 'date-time'
        } else if (UNREPRESENTABLE.has(type)) {
          unrepresentable.add(type)
        }
      },
    }) as JsonSchema

    if (unrepresentable.size > 0) {
      warn(
        `${where}: ${[...unrepresentable].sort().join(', ')} cannot be represented in JSON Schema, documented as any value.`
      )
    }
    if (hasRootRef(result)) {
      throw new Error(
        `${where}: recursive schema without identifier. Name it with .meta({ id: 'Name' }).`
      )
    }

    const { $defs = {}, ...root } = result
    delete root.$schema
    const names = new Map<string, string>()
    for (const name of Object.keys($defs as JsonSchema)) {
      // Zod names recursive schemas without identifier `__schema0`.
      names.set(name, name.startsWith('__') ? `Schema${++anonymous}` : name)
    }
    const toComponent = (ref: string) => {
      if (!ref.startsWith('#/$defs/')) return ref
      const name = ref.slice('#/$defs/'.length)
      return `${COMPONENTS}${names.get(name) ?? name}${side === 'input' ? INPUT_MARK : ''}`
    }

    for (const [name, definition] of Object.entries($defs as JsonSchema)) {
      const id = names.get(name) ?? name
      const mapped = mapRefs(definition as JsonSchema, toComponent)
      const json = JSON.stringify(mapped)
      const variants = definitions.get(id) ?? {}
      const existing = variants[side]
      if (existing && existing.json !== json) {
        throw new Error(
          `Two different schemas use the identifier "${id}" (${where}).`
        )
      }
      variants[side] = { schema: mapped, json }
      definitions.set(id, variants)
    }

    return mapRefs(root, toComponent)
  }

  /** Schema of a component reference, before the names are final. */
  const resolve = (schema: JsonSchema): JsonSchema => {
    const ref = schema.$ref
    if (typeof ref !== 'string' || !ref.startsWith(COMPONENTS)) return schema
    const name = ref.slice(COMPONENTS.length)
    const input = name.endsWith(INPUT_MARK)
    const id = input ? name.slice(0, -INPUT_MARK.length) : name
    return definitions.get(id)?.[input ? 'input' : 'output']?.schema ?? schema
  }

  /**
   * Final component schemas, and the function giving the final form of a
   * value referencing them. A schema whose input and output differ (for
   * instance `additionalProperties: false` or defaults) gets an `Input`
   * variant: `Member` and `MemberInput`.
   */
  const finalize = (reserved: readonly string[]) => {
    const unmark = (json: string) => json.replaceAll(INPUT_MARK, '')
    const split = new Set<string>()
    for (const [id, { input, output }] of definitions) {
      if (input && output && unmark(input.json) !== unmark(output.json)) {
        split.add(id)
      }
    }
    // A schema referencing a split schema differs too.
    let changed = true
    while (changed) {
      changed = false
      for (const [id, { input, output }] of definitions) {
        if (split.has(id) || !input || !output) continue
        if (
          [...split].some((other) =>
            input.json.includes(`${COMPONENTS}${other}${INPUT_MARK}"`)
          )
        ) {
          split.add(id)
          changed = true
        }
      }
    }

    const finalName = (name: string) => {
      if (!name.endsWith(INPUT_MARK)) return name
      const id = name.slice(0, -INPUT_MARK.length)
      return split.has(id) ? `${id}Input` : id
    }
    const finalRefs = <T>(value: T): T =>
      mapRefs(value, (ref) =>
        ref.startsWith(COMPONENTS)
          ? `${COMPONENTS}${finalName(ref.slice(COMPONENTS.length))}`
          : ref
      )

    const schemas: Record<string, JsonSchema> = {}
    const add = (name: string, schema: JsonSchema) => {
      if (name in schemas || reserved.includes(name)) {
        throw new Error(
          `The schema identifier "${name}" is used twice (or is reserved by @dotpress/openapi).`
        )
      }
      schemas[name] = finalRefs(schema)
    }
    for (const [id, { input, output }] of definitions) {
      if (output) add(id, output.schema)
      if (input && (!output || split.has(id))) {
        add(output ? `${id}Input` : id, input.schema)
      }
    }

    return { schemas, finalRefs }
  }

  return { convert, resolve, finalize }
}
