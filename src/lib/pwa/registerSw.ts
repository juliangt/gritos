/**
 * Registers the offline app-shell service worker (issue #104, phases 2+4).
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
 *
 * Update flow (phase 4): the worker never calls skipWaiting(), so a newly
 * deployed version installs and then WAITS while this page still runs the
 * old one. Watching for that waiting worker — a worker already waiting at
 * registration time, or an `updatefound` install reaching the `installed`
 * state — fires the one callback subscribed via onUpdateReady(); the
 * App-level update toast owns the «Recargar» action, whose
 * location.reload() dismisses the old client and lets the waiting worker
 * activate (activate-time cleanup runs behind it). No `controllerchange`
 * listener on purpose: the swap is the user's explicit reload, never an
 * automatic one — a chat session must not lose its live connections under
 * it mid-conversation. Everything below takes minimal structural types so
 * tests can drive the flow with EventTarget stubs (the
 * insecureContext.test.tsx pattern).
 */

/** The subset of `import.meta.env` this module reads (kept narrow for tests). */
type Env = { readonly PROD?: boolean }

/** The slice of a `ServiceWorker` this module touches. */
interface SwWorkerLike {
  state: string
  addEventListener(type: 'statechange', listener: () => void): void
}

/** The slice of a `ServiceWorkerRegistration` this module touches. */
interface SwRegistrationLike {
  installing: SwWorkerLike | null
  waiting: SwWorkerLike | null
  addEventListener(type: 'updatefound', listener: () => void): void
}

/** The slice of `navigator.serviceWorker` this module touches. */
interface SwContainerLike {
  controller: SwWorkerLike | null
  waiting: SwWorkerLike | null
  register(scriptUrl: string): Promise<SwRegistrationLike>
}

// The update-ready callback plus the remember-me for one edge: the
// registration in main.tsx races the first React effect, so a waiting
// worker detected before anyone subscribed is delivered on subscribe
// instead of lost. At most one flag, never a queue — a second detection
// while one is pending is the same «new version available» fact.
let updateListener: (() => void) | null = null
let updatePending = false

/**
 * Subscribes the callback fired when a waiting worker exists (a new
 * version is ready behind this page). Returns the unsubscribe function;
 * subscribing after a detection delivers it immediately, so a late toast
 * mount never misses the update.
 */
export function onUpdateReady(callback: () => void): () => void {
  updateListener = callback
  if (updatePending) {
    updatePending = false
    callback()
  }
  return () => {
    if (updateListener === callback) updateListener = null
  }
}

function notifyUpdateReady(): void {
  if (updateListener != null) {
    updateListener()
  } else {
    updatePending = true
  }
}

export function registerServiceWorker(env: Env = import.meta.env): void {
  if (env.PROD !== true) return
  if (!window.isSecureContext) return
  // Through `unknown` on purpose: lib.dom's ServiceWorkerContainer and the
  // minimal structural view below are compatible in every member this
  // module touches, but not comparable enough for a direct assertion.
  const container = (navigator as unknown as { serviceWorker?: SwContainerLike }).serviceWorker
  if (container == null) return
  container
    .register('./sw.js')
    .then((registration) => watchForUpdates(container, registration))
    .catch((error: unknown) => {
      // A missed offline enhancement is not warning-worthy, hence info —
      // the repo-wide no-console rule allows only warn/error, so this is the
      // one deliberate exception.
      // eslint-disable-next-line no-console
      console.info('[gritos] service worker no disponible:', error)
    })
}

/**
 * Wires the waiting-worker detection onto a resolved registration: an
 * already-waiting worker fires the toast straight away, and every future
 * `updatefound` install fires it when it reaches `installed` while an
 * older worker still controls this page (`controller != null` — the
 * standard update guard: on a FIRST install the worker passes through
 * `installed` momentarily on its way to activating with nothing left
 * waiting, and there is no old version to update anyway).
 */
function watchForUpdates(container: SwContainerLike, registration: SwRegistrationLike): void {
  if (registration.waiting != null) {
    notifyUpdateReady()
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (installing == null) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && container.controller != null) {
        notifyUpdateReady()
      }
    })
  })
}
