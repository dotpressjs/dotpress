/**
 * Subset of the OpenAPI 3.1 types used by the generated documents. Schemas
 * are JSON Schema 2020-12 objects.
 */

export type JsonSchema = Record<string, unknown>

export interface ContactObject {
  name?: string
  url?: string
  email?: string
}

export interface LicenseObject {
  name: string
  identifier?: string
  url?: string
}

export interface InfoObject {
  title: string
  version: string
  summary?: string
  description?: string
  termsOfService?: string
  contact?: ContactObject
  license?: LicenseObject
}

export interface ServerObject {
  url: string
  description?: string
  variables?: Record<
    string,
    { default: string; enum?: string[]; description?: string }
  >
}

export interface ExternalDocumentationObject {
  url: string
  description?: string
}

export interface TagObject {
  name: string
  description?: string
  externalDocs?: ExternalDocumentationObject
}

export type SecuritySchemeObject =
  | {
      type: 'http'
      scheme: string
      bearerFormat?: string
      description?: string
    }
  | {
      type: 'apiKey'
      name: string
      in: 'query' | 'header' | 'cookie'
      description?: string
    }
  | {
      type: 'oauth2'
      flows: Record<string, unknown>
      description?: string
    }
  | {
      type: 'openIdConnect'
      openIdConnectUrl: string
      description?: string
    }
  | { type: 'mutualTLS'; description?: string }

export type SecurityRequirementObject = Record<string, string[]>

export interface ReferenceObject {
  $ref: string
}

export interface ParameterObject {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  deprecated?: boolean
  schema: JsonSchema
}

export interface MediaTypeObject {
  schema?: JsonSchema
}

export interface RequestBodyObject {
  required?: boolean
  content: Record<string, MediaTypeObject>
}

export interface ResponseObject {
  description: string
  content?: Record<string, MediaTypeObject>
}

export interface OperationObject {
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  deprecated?: boolean
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  responses: Record<string, ResponseObject | ReferenceObject>
  security?: SecurityRequirementObject[]
}

export type PathItemObject = Partial<
  Record<
    'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch',
    OperationObject
  >
>

export interface ComponentsObject {
  schemas?: Record<string, JsonSchema>
  responses?: Record<string, ResponseObject>
  securitySchemes?: Record<string, SecuritySchemeObject>
}

export interface OpenApiDocument {
  openapi: string
  info: InfoObject
  servers?: ServerObject[]
  paths: Record<string, PathItemObject>
  components?: ComponentsObject
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
}
