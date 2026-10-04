import { beforeAll, describe, expect, it } from 'vitest'
import { build, resolveConfig } from 'vite'
import config from '../vite.config'

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
 *
 * Cheap checks keep all three from shipping again:
 *  1. the shared vite config registers the Tailwind plugin and resolves a
 *     relative base,
 *  2. a real production build emits expanded utilities (no raw directive)
 *     and a fully relative index.html,
 *  3. the built index.html keeps the frame-bust and a CSP hash that matches
 *     the actual inline script text (computed here, so any edit to the
 *     script that forgets to refresh the hash fails CI).
 *
 * The build runs with `write: false`: the CSS and HTML are asserted from the
 * in-memory rollup output (byte-for-byte what `vite build` writes to
 * dist/), so the test leaves no build artifacts behind.
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

describe('production build output (issues #37, #40, #27)', () => {
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
})
