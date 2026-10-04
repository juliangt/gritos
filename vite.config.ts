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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stripCspMetaInDev()],
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
  },
})
