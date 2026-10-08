import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Dev-only (M6): the strict CSP meta in index.html targets the production
 * build. Vite's dev server injects an inline HMR preamble module that a
 * hash-pinned `script-src` can never allow-list, so the meta is removed
 * while serving in dev — `vite build` output keeps it untouched.
 */
function stripCspMetaInDev(): Plugin {
  return {
    name: 'strip-csp-meta-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/, '')
    },
  }
}

/**
 * Static public/ assets the offline app shell precaches (issue #104,
 * phase 2), enumerated explicitly. If public/ gains a shell-relevant file
 * it must be added here — tests/buildOutput.test.ts asserts this list
 * matches the served files of dist/ exactly, so an omission fails CI.
 */
const SW_PUBLIC_ASSETS = [
  './manifest.webmanifest',
  './favicon.svg',
  './favicon-32.png',
  './apple-touch-icon.png',
  './robots.txt',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
]

/**
 * Issue #104 (phase 2): injects the offline shell into public/sw.js.
 * public/sw.js ships with two placeholders; this plugin rewrites them into
 * the emitted dist/sw.js (the public/ source is never mutated):
 *
 *   - `__GRITOS_CACHE_VERSION__` becomes `gritos-shell-v` plus a sha256
 *     digest over everything the worker serves (the precache list, the
 *     built index.html and the static public assets), so any build whose
 *     served content changed gets a fresh cache and the activate handler
 *     deletes the stale ones;
 *   - the `'__GRITOS_PRECACHE_URLS__'` string becomes the JSON array of
 *     this build's shell URLs: './', './index.html', SW_PUBLIC_ASSETS and
 *     the hashed build outputs.
 *
 * Emitted from generateBundle (order 'post', so every other plugin's
 * emission is already part of the bundle it scans): Vite copies public/
 * into the out dir at renderStart, which runs before generateBundle, so
 * this emission overwrites the verbatim copy with the injected one. Builds
 * only — the dev server stays SW-free (stripCspMetaInDev's philosophy in
 * reverse).
 */
function gritosSwManifest(): Plugin {
  let publicDir = ''
  return {
    name: 'gritos-sw-manifest',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        if (!publicDir) return
        const swSource = await readFile(`${publicDir}/sw.js`, 'utf8')
        const buildAssets = Object.values(bundle)
          .map((entry) => entry.fileName)
          .filter((name) => name !== 'index.html' && !name.endsWith('.map'))
        const urls = [
          './',
          './index.html',
          ...SW_PUBLIC_ASSETS,
          ...buildAssets.map((name) => `./${name}`),
        ].sort()
        const digest = createHash('sha256')
        digest.update(swSource)
        digest.update(JSON.stringify(urls))
        const index = Object.values(bundle).find((entry) => entry.fileName === 'index.html')
        if (index?.type === 'asset') digest.update(index.source)
        for (const asset of SW_PUBLIC_ASSETS) {
          digest.update(await readFile(`${publicDir}/${asset.slice(2)}`))
        }
        const version = `gritos-shell-v${digest.digest('hex').slice(0, 12)}`
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: swSource
            .replace('__GRITOS_CACHE_VERSION__', version)
            .replace(`'__GRITOS_PRECACHE_URLS__'`, JSON.stringify(urls)),
        })
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stripCspMetaInDev(), gritosSwManifest()],
  // Relative base (issue #40): the README recommends GitHub Pages, where a
  // project site is served under /<repo>/. A relative base emits asset URLs
  // that resolve on GitHub Pages, Netlify and nginx subpaths alike.
  base: './',
  build: {
    // Vite 8 defaults to the lightningcss minifier, which warns
    // ("Unknown at-rule") about Tailwind 4's @theme/@tailwind at-rules.
    // esbuild keeps the build output warning-free.
    cssMinify: 'esbuild',
  },
  test: {
    // Node by default (Node 22 ships Web Crypto globally, ready for the
    // crypto suites); DOM tests opt in per file with
    // `// @vitest-environment jsdom`.
    environment: 'node',
    // Issue #90 — roomManager resolves the Trystero appId from
    // `import.meta.env.VITE_TRYSTERO_APP_ID` (src/lib/p2p/appId.ts). The
    // suite runs against this fixture value, and roomManager tests assert
    // it is the one forwarded to the joinRoom config.
    env: { VITE_TRYSTERO_APP_ID: 'gritos-app-v1' },
  },
})
