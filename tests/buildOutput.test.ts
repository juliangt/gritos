import { beforeAll, describe, expect, it } from 'vitest'
import { build, resolveConfig } from 'vite'
import config from '../vite.config'
import robotsTxt from '../public/robots.txt?raw'

/**
 * Regression guards for production-build issues:
 *
 * - Issue #37 (blocker): production build shipped without any Tailwind
 *   utilities. `@tailwindcss/vite` was installed but never registered in
 *   vite.config.ts, so Vite's CSS pipeline inlined the `tailwindcss` entry
 *   verbatim: the bundle kept the literal `@tailwind utilities;` directive
 *   instead of the generated utilities.
 * - Issue #40: the build shipped root-absolute asset URLs (`/assets/…`,
 *   `/favicon.svg`), which 404 on GitHub Pages project sites served under
 *   `/<repo>/`. The config now sets `base: './'` so the same build works on
 *   GitHub Pages, Netlify and nginx subpaths alike.
 * - Issue #27: the inline bootstrap script (frame-bust + anti-flash) must
 *   ship intact and stay allow-listed in the CSP meta by its sha256 hash.
 * - Issue #49: public-site basics must ship — robots.txt with the deliberate
 *   allow-all policy, og:/twitter: share meta with a relative og:image, a
 *   theme-color per color scheme and PNG/apple-touch icon fallback links.
 * - Issue #26: the CSP ships hardened — cleartext `ws:` is gone from
 *   connect-src (only `wss:` trackers), `form-action 'self'` and
 *   `upgrade-insecure-requests` are set, and the referrer policy meta is
 *   present.
 * - Issue #32: the M1 debug panel is gated behind `import.meta.env.DEV` in
 *   App.tsx, so the production bundle must not contain any of it — the
 *   panel's raw join/nickname paths widen the malformed-input surface
 *   peers must tolerate. Only its absence from the emitted JS is checked
 *   here (a dev build is not produced in this suite).
 *
 * Cheap checks keep all of these from shipping again:
 *  1. the shared vite config registers the Tailwind plugin and resolves a
 *     relative base,
 *  2. a real production build emits expanded utilities (no raw directive)
 *     and a fully relative index.html,
 *  3. the built index.html keeps the frame-bust and a CSP hash that matches
 *     the actual inline script text (computed here, so any edit to the
 *     script that forgets to refresh the hash fails CI),
 *  4. the built index.html keeps the share/theme-color/icon metas of
 *     issue #49, and public/robots.txt keeps its policy (read via `?raw`
 *     against the exact bytes on disk, as in license.test.ts).
 *
 * The build runs with `write: false`: the CSS and HTML are asserted from the
 * in-memory rollup output (byte-for-byte what `vite build` writes to
 * dist/), so the test leaves no build artifacts behind. Public assets
 * (robots.txt, the icons) are copied verbatim by Vite and are not part of
 * the rollup output; robots.txt is asserted from disk below and the icons
 * are covered by the link hrefs in the HTML.
 */
function collectPluginNames(plugins: readonly unknown[]): string[] {
  const names: string[] = []
  for (const plugin of plugins) {
    if (plugin == null) continue
    if (Array.isArray(plugin)) {
      names.push(...collectPluginNames(plugin))
    } else if (typeof (plugin as { name?: unknown }).name === 'string') {
      names.push((plugin as { name: string }).name)
    }
  }
  return names
}

function emittedAssets(
  result: Awaited<ReturnType<typeof build>>,
): { fileName: string; source: string }[] {
  // A plain build resolves to RolldownOutput(s); the watcher variant of the
  // union only appears with `watch: true`, which this build never sets.
  const bundles = Array.isArray(result) ? result : 'output' in result ? [result] : []
  return bundles
    .flatMap((bundle) => bundle.output)
    .flatMap((asset) =>
      asset.type === 'asset'
        ? [
            {
              fileName: asset.fileName,
              source:
                typeof asset.source === 'string'
                  ? asset.source
                  : new TextDecoder().decode(asset.source),
            },
          ]
        : [],
    )
}

/** Concatenates the CSS assets of a finished production build. */
function emittedCss(result: Awaited<ReturnType<typeof build>>): string {
  const css = emittedAssets(result).filter((asset) => asset.fileName.endsWith('.css'))
  expect(css.length, 'the production build must emit at least one CSS asset').toBeGreaterThan(0)
  return css.map((asset) => asset.source).join('\n')
}

/** Concatenates the JS chunks of a finished production build. */
function emittedJs(result: Awaited<ReturnType<typeof build>>): string {
  // Unlike CSS/HTML (emitted as `asset` entries), JS comes out as rollup
  // `chunk` entries whose source lives in `code`.
  const js = Array.isArray(result) ? result : 'output' in result ? [result] : []
  const chunks = js
    .flatMap((bundle) => bundle.output)
    .filter((entry) => entry.type === 'chunk')
    .map((chunk) => chunk.code)
  expect(chunks.length, 'the production build must emit at least one JS chunk').toBeGreaterThan(0)
  return chunks.join('\n')
}

/** The transformed index.html of a finished production build. */
function emittedHtml(result: Awaited<ReturnType<typeof build>>): string {
  const html = emittedAssets(result).find((asset) => asset.fileName === 'index.html')
  if (html == null) {
    throw new Error('the production build must emit an index.html asset')
  }
  return html.source
}

/** The inline (no src) scripts of a built index.html, raw text between the tags. */
function emittedInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  )
}

/** The CSP `sha256-…` source expression of `text` (base64 digest), as used in the meta. */
async function cspSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(digest)))
}

/** The full `<meta …>` tag whose `property` attribute is `property`, if any. */
function metaByProperty(html: string, property: string): string | undefined {
  return html.match(new RegExp(`<meta[^>]*property="${property}"[^>]*>`))?.[0]
}

/** The full `<meta …>` tag whose `name` attribute is `name`, if any. */
function metaByName(html: string, name: string): string | undefined {
  return html.match(new RegExp(`<meta[^>]*name="${name}"[^>]*>`))?.[0]
}

/** The policy text of the CSP meta tag of a built index.html. */
function cspPolicy(html: string): string {
  const meta = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0]
  expect(meta, 'the built index.html must keep the CSP meta').toBeDefined()
  return meta?.match(/content="([^"]+)"/)?.[1] ?? ''
}

/**
 * Vitest workers run this file under Node, but the app tsconfig ships no
 * Node types (`types: []`), so the one field needed below is declared here
 * instead of adding @types/node to the whole project.
 */
const nodeProcess = (globalThis as unknown as {
  process?: { env: Record<string, string | undefined> }
}).process

describe('production build output (issues #37, #40, #27, #49, #26, #32)', () => {
  it('registers the Tailwind Vite plugin', () => {
    const names = collectPluginNames(config.plugins ?? [])
    expect(
      names.some((name) => name.startsWith('@tailwindcss/vite')),
      'the shared vite config must register @tailwindcss/vite',
    ).toBe(true)
  })

  it('resolves a relative base (./) for subpath hosting (issue #40)', async () => {
    const resolved = await resolveConfig({ ...config, configFile: false }, 'build', 'production')
    expect(
      resolved.base,
      'the build must use a relative base so assets resolve under any subpath',
    ).toBe('./')
  })

  // Shared by the output assertions below: one production build, in memory.
  let result: Awaited<ReturnType<typeof build>>
  beforeAll(async () => {
    // Vitest runs its workers with NODE_ENV=test, which would make the
    // in-memory build resolve `import.meta.env.DEV` to `true` (dev JSX
    // transform, dev branches kept). The CLI `vite build` always runs with
    // NODE_ENV=production; pin it around the build so this suite exercises
    // the real production pipeline (issue #32 depends on it), and restore
    // it so Vitest's own assumptions stay untouched.
    const previousNodeEnv = nodeProcess?.env.NODE_ENV
    if (nodeProcess != null) nodeProcess.env.NODE_ENV = 'production'
    try {
      result = await build({
        ...config,
        // Build with exactly the imported config object (no merge with the
        // on-disk vite.config.ts), exercising the same pipeline as
        // `npm run build` minus the disk write.
        configFile: false,
        mode: 'production',
        logLevel: 'silent',
        build: { ...config.build, write: false },
      })
    } finally {
      if (nodeProcess != null) nodeProcess.env.NODE_ENV = previousNodeEnv
    }
  }, 120_000)

  it('emits expanded Tailwind utilities instead of the raw @tailwind directive', () => {
    const css = emittedCss(result)
    expect(css).toContain('.min-h-screen')
    expect(css).not.toContain('@tailwind utilities;')
  })

  it('emits relative (not root-absolute) asset URLs in index.html (issue #40)', () => {
    const html = emittedHtml(result)
    expect(html).toMatch(/\b(src|href)="\.\/assets\//)
    expect(html, 'root-absolute /assets/ URLs 404 under a subpath (GitHub Pages)').not.toMatch(
      /["']\/assets\//,
    )
  })

  it('references the favicon with a relative URL in index.html (issue #40)', () => {
    const html = emittedHtml(result)
    const linkTag = html.match(/<link[^>]*rel="icon"[^>]*>/)?.[0]
    expect(linkTag, 'the built index.html must keep the SVG favicon link').toBeDefined()
    const href = linkTag?.match(/href=["']([^"']+)["']/)?.[1]
    expect(href).toBeDefined()
    expect(href?.startsWith('/'), 'a root-absolute /favicon.svg 404s under a subpath').toBe(false)
    expect(href?.endsWith('favicon.svg')).toBe(true)
  })

  it('ships the frame-bust in the built index.html (issue #27)', () => {
    const html = emittedHtml(result)
    const inline = emittedInlineScripts(html)
    expect(inline, 'the bootstrap is the only inline script of the built page').toHaveLength(1)
    expect(inline[0], 'the bootstrap must refuse to run when the page is framed').toContain(
      'window.top !== window.self',
    )
    expect(inline[0], 'the framed page must show the Spanish deny warning').toContain(
      'no puede ejecutarse dentro de un marco o iframe',
    )
  })

  it('allow-lists the inline bootstrap by the hash of its exact text (issue #27)', async () => {
    const html = emittedHtml(result)
    const inline = emittedInlineScripts(html)
    expect(inline, 'the bootstrap is the only inline script of the built page').toHaveLength(1)
    // The meta hashes the exact raw text between <script> and </script> as
    // served, so digest that very text: an edit to the bootstrap that
    // forgets to refresh the hash would be blocked by the CSP in production.
    const hash = await cspSha256(inline[0])
    const meta = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/)?.[0]
    expect(meta, 'the built index.html must keep the CSP meta').toBeDefined()
    expect(meta).toContain(hash)
  })

  it('ships the hardened CSP and referrer policy (issue #26)', () => {
    const html = emittedHtml(result)
    const policy = cspPolicy(html)
    // Cleartext ws: is gone; only wss: remains (trackers are wss: and the
    // settings validation never accepted anything else). Assert against a
    // standalone token, not a substring: guard the token with whitespace so
    // a future `ws-whatever:` cannot sneak the match back in.
    expect(policy).toContain("connect-src 'self' wss:")
    expect(policy, 'cleartext ws: must not appear as a standalone token').not.toMatch(
      /(^|\s)ws:(\s|$)/,
    )
    expect(policy).toContain("form-action 'self'")
    expect(policy).toContain('upgrade-insecure-requests')
    // Outbound links already use rel="noopener noreferrer"; the meta closes
    // every other referrer path.
    expect(metaByName(html, 'referrer')).toMatch(/content="no-referrer"/)
  })

  it('ships og: share meta with a relative image (issue #49)', () => {
    const html = emittedHtml(result)
    expect(metaByProperty(html, 'og:type')).toMatch(/content="website"/)
    expect(metaByProperty(html, 'og:site_name')).toMatch(/content="gritos"/)
    const title = metaByProperty(html, 'og:title')
    expect(title, 'og:title must be present').toBeDefined()
    expect(title).toMatch(/content="gritos/)
    const description = metaByProperty(html, 'og:description')
    expect(description, 'og:description must be present').toBeDefined()
    expect(description).toContain('chat P2P sin servidor')
    const image = metaByProperty(html, 'og:image')
    expect(image, 'og:image must be present').toBeDefined()
    expect(image).toContain('content="./apple-touch-icon.png"')
    expect(image, 'a root-absolute og:image 404s under a subpath (GitHub Pages)').not.toContain(
      'content="/',
    )
  })

  it('ships the twitter:card meta (issue #49)', () => {
    const html = emittedHtml(result)
    expect(metaByName(html, 'twitter:card')).toMatch(/content="summary"/)
  })

  it('declares a theme-color for each color scheme (issue #49)', () => {
    const html = emittedHtml(result)
    expect(
      [...html.matchAll(/<meta[^>]*name="theme-color"[^>]*>/g)],
      'exactly one theme-color meta per scheme',
    ).toHaveLength(2)
    const light = html.match(
      /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"[^>]*>/,
    )?.[0]
    const dark = html.match(
      /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"[^>]*>/,
    )?.[0]
    expect(light, 'a light-scheme theme-color must be present').toBeDefined()
    expect(dark, 'a dark-scheme theme-color must be present').toBeDefined()
    // The colors must match the theme tokens in src/styles/index.css.
    expect(light).toContain('content="#fafaf9"')
    expect(dark).toContain('content="#0c0a09"')
  })

  it('links the PNG favicon and apple-touch-icon fallbacks relatively (issue #49)', () => {
    const html = emittedHtml(result)
    const png = html.match(/<link[^>]*rel="icon"[^>]*type="image\/png"[^>]*>/)?.[0]
    expect(png, 'a 32px PNG favicon fallback must be linked').toBeDefined()
    expect(png).toContain('href="./favicon-32.png"')
    const apple = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*>/)?.[0]
    expect(apple, 'an apple-touch-icon must be linked').toBeDefined()
    expect(apple).toContain('href="./apple-touch-icon.png"')
  })

  it('eliminates the ?debug panel from the emitted JS (issue #32)', () => {
    const js = emittedJs(result)
    // Sanity first: the chunks are the real app code, not an empty shell.
    expect(js).toContain('Comparte el nombre de la sala para que otros se unan.')
    // Unique DebugPanel strings: App.tsx gates the panel behind
    // `import.meta.env.DEV`, so tree-shaking must drop the module entirely
    // (absent code cannot render, which is stronger than a hidden flag).
    expect(js, 'the debug panel must not ship to production (issue #32)').not.toContain(
      'Panel de depuración',
    )
    expect(js, 'the debug panel test-chat button must not ship').not.toContain(
      'Enviar chat de prueba',
    )
  })
})

describe('robots.txt (issue #49)', () => {
  it('ships the deliberate allow-all policy from public/', () => {
    expect(robotsTxt).toMatch(/^User-agent: \*$/m)
    expect(robotsTxt).toMatch(/^Allow: \/$/m)
    expect(robotsTxt, 'nothing is disallowed: room names live only in URL fragments').not.toMatch(
      /^Disallow:/m,
    )
  })
})
