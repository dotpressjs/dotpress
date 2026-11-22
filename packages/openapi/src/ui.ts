/** Pinned Scalar API Reference build, with its Subresource Integrity hash. */
export const SCALAR_CDN_URL =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js'
const SCALAR_INTEGRITY =
  'sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q'

/**
 * Defaults keeping the page free of third-party services and promotion:
 * no telemetry, no AI agent or MCP integration, no developer toolbar, no
 * link to the Scalar API client, system fonts instead of fonts.scalar.com,
 * and no "Powered by Scalar" link.
 */
export const SCALAR_NEUTRAL_CONFIGURATION: Readonly<Record<string, unknown>> =
  Object.freeze({
    telemetry: false,
    agent: Object.freeze({ disabled: true }),
    mcp: Object.freeze({ disabled: true }),
    showDeveloperTools: 'never',
    hideClientButton: true,
    withDefaultFonts: false,
    customCss: 'a[href*="utm_source=powered-by"] { display: none; }',
  })

export interface ScalarOptions {
  /** Path of the page. Defaults to `/docs`. */
  path?: string
  /** Page title. Defaults to `info.title`. */
  title?: string
  /**
   * URL of the Scalar script, for instance to host it yourself. Defaults
   * to a pinned version on jsDelivr, checked with Subresource Integrity.
   */
  cdnUrl?: string
  /** Subresource Integrity hash of `cdnUrl`. */
  integrity?: string
  /**
   * Scalar configuration (theme, layout…), see
   * https://guides.scalar.com/scalar/scalar-api-references/configuration.
   * Merged over `SCALAR_NEUTRAL_CONFIGURATION`; `customCss` is appended to
   * the neutral one. `url` is set to the document.
   */
  configuration?: Record<string, unknown>
  /**
   * The Content Security Policy of the page. By default, the page allows
   * the Scalar script, its own inline script (by hash) and requests to the
   * document and its servers, and nothing else: it replaces a policy set
   * for the whole app, such as the one of `helmet()`, that would block it.
   * Extra sources are added to the directives, like
   * `{ 'img-src': ['https://cdn.example.com'] }`. `false` sets no policy.
   */
  contentSecurityPolicy?: Readonly<Record<string, readonly string[]>> | false
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!
  )

/** JSON safe to embed in a `<script>` element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

/** HTML page of the Scalar API Reference, and its inline script. */
export const renderScalarPage = (
  documentUrl: string,
  title: string,
  options: ScalarOptions
): { html: string; script: string } => {
  const cdnUrl = options.cdnUrl ?? SCALAR_CDN_URL
  const integrity =
    options.integrity ?? (options.cdnUrl ? undefined : SCALAR_INTEGRITY)
  const { customCss, ...custom } = options.configuration ?? {}
  const configuration = {
    ...SCALAR_NEUTRAL_CONFIGURATION,
    ...custom,
    customCss: [SCALAR_NEUTRAL_CONFIGURATION.customCss, customCss]
      .filter((css) => typeof css === 'string' && css !== '')
      .join('\n'),
    url: documentUrl,
  }
  const script = `
      Scalar.createApiReference('#app', ${scriptJson(configuration)})
    `

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${escapeHtml(cdnUrl)}"${integrity ? ` integrity="${escapeHtml(integrity)}" crossorigin="anonymous"` : ''}></script>
    <script>${script}</script>
  </body>
</html>
`
  return { html, script }
}

/** The origin of an absolute URL, or `'self'` for a path. */
const sourceOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return "'self'"
  }
}

/** Base64 SHA-256 hash, with Web Crypto: Node.js and other runtimes. */
const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  )
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The Content Security Policy of the page: the Scalar script and the
 * inline script, requests to the document and to the `servers` (Try it).
 */
export const scalarContentSecurityPolicy = async (
  script: string,
  options: ScalarOptions & { servers?: readonly string[] }
): Promise<string> => {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': [
      sourceOf(options.cdnUrl ?? SCALAR_CDN_URL),
      `'sha256-${await sha256(script)}'`,
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...(options.servers ?? []).map(sourceOf)],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  for (const [name, sources] of Object.entries(
    options.contentSecurityPolicy || {}
  )) {
    directives[name] = [...(directives[name] ?? []), ...sources]
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`)
    .join('; ')
}
