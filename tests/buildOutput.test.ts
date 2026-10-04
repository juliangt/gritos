import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import config from '../vite.config'

/**
 * Regression guard for issue #37 (blocker: production build shipped without
 * any Tailwind utilities). `@tailwindcss/vite` was installed but never
 * registered in vite.config.ts, so Vite's CSS pipeline inlined the
 * `tailwindcss` entry verbatim: the bundle kept the literal
 * `@tailwind utilities;` directive instead of the generated utilities.
 *
 * Two cheap checks keep that from shipping again:
 *  1. the shared vite config actually registers the Tailwind plugin, and
 *  2. a real production build emits expanded utilities (no raw directive).
 *
 * The build runs with `write: false`: the CSS is asserted from the in-memory
 * rollup output (byte-for-byte what `vite build` writes to dist/assets/*.css),
 * so the test leaves no build artifacts behind.
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

/** Concatenates the CSS assets of a finished production build. */
function emittedCss(result: Awaited<ReturnType<typeof build>>): string {
  // A plain build resolves to RolldownOutput(s); the watcher variant of the
  // union only appears with `watch: true`, which this build never sets.
  const bundles = Array.isArray(result) ? result : 'output' in result ? [result] : []
  const assets = bundles
    .flatMap((bundle) => bundle.output)
    .flatMap((asset) => (asset.type === 'asset' && asset.fileName.endsWith('.css') ? [asset] : []))
  expect(assets.length, 'the production build must emit at least one CSS asset').toBeGreaterThan(0)
  return assets
    .map((asset) =>
      typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source),
    )
    .join('\n')
}

describe('production build output (issue #37)', () => {
  it('registers the Tailwind Vite plugin', () => {
    const names = collectPluginNames(config.plugins ?? [])
    expect(
      names.some((name) => name.startsWith('@tailwindcss/vite')),
      'the shared vite config must register @tailwindcss/vite',
    ).toBe(true)
  })

  it('emits expanded Tailwind utilities instead of the raw @tailwind directive', async () => {
    const result = await build({
      ...config,
      // Build with exactly the imported config object (no merge with the
      // on-disk vite.config.ts), exercising the same pipeline as
      // `npm run build` minus the disk write.
      configFile: false,
      mode: 'production',
      logLevel: 'silent',
      build: { ...config.build, write: false },
    })
    const css = emittedCss(result)
    expect(css).toContain('.min-h-screen')
    expect(css).not.toContain('@tailwind utilities;')
  }, 120_000)
})
