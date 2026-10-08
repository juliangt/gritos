/**
 * Registers the offline app-shell service worker (issue #104, phase 2).
 *
 * Production builds only: the dev server stays SW-free — `vite dev`
 * regenerates assets on every save (hashed names churn), so precaching it
 * would fight HMR, and the production-oriented head of index.html is
 * already stripped in dev (see stripCspMetaInDev in vite.config.ts for the
 * same philosophy).
 *
 * Secure contexts only: `navigator.serviceWorker` is absent on insecure
 * origins anyway, and the explicit `window.isSecureContext` gate mirrors
 * the app's other secure-context checks (issue #43) — the P2P stack
 * already requires a secure context, so the worker never has a job to do
 * without one.
 *
 * './sw.js' resolves against the page URL (relative base, issue #40), so
 * the registration — and with it the worker's scope — covers subpath
 * deployments such as GitHub Pages project sites without configuration.
 *
 * Registration failure is never fatal: the worker is a progressive
 * enhancement and the online app must keep working, so a rejection is
 * logged at most and swallowed. The env parameter is injectable for tests
 * (same shape as resolveTrysteroAppId, issue #90).
 */

/** The subset of `import.meta.env` this module reads (kept narrow for tests). */
type Env = { readonly PROD?: boolean }

export function registerServiceWorker(env: Env = import.meta.env): void {
  if (env.PROD !== true) return
  if (!window.isSecureContext) return
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
    // A missed offline enhancement is not warning-worthy, hence info —
    // the repo-wide no-console rule allows only warn/error, so this is the
    // one deliberate exception.
    // eslint-disable-next-line no-console
    console.info('[gritos] service worker no disponible:', error)
  })
}
