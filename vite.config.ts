import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
