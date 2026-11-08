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

/** HTML page of the Scalar API Reference. */
export const renderScalarPage = (
  documentUrl: string,
  title: string,
  options: ScalarOptions
) => {
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${escapeHtml(cdnUrl)}"${integrity ? ` integrity="${escapeHtml(integrity)}" crossorigin="anonymous"` : ''}></script>
    <script>
      Scalar.createApiReference('#app', ${scriptJson(configuration)})
    </script>
  </body>
</html>
`
}
