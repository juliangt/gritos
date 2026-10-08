/**
 * Issue #90 — the Trystero appId (§9.4) comes from the build environment
 * instead of a source literal: the appId is the peer-discovery namespace,
 * so each deployment (dev, forks, self-hosts) can isolate its swarm without
 * editing code. Set it in `.env` (see `.env.example`) or in the host's build
 * environment; Vite bakes `import.meta.env.VITE_TRYSTERO_APP_ID` into the
 * bundle at build time, so changing the value requires a rebuild.
 *
 * A missing or blank value is a hard error, never a silent fallback: peers
 * built with different appIds cannot find each other, so a quiet default
 * would fork the swarm with no visible signal. Resolution happens per join
 * (not at module load) so a misconfigured build surfaces the failure through
 * the normal join-error path instead of a blank page.
 */

export class MissingAppIdError extends Error {
  constructor() {
    super(
      'VITE_TRYSTERO_APP_ID is not defined: copy .env.example to .env (or set the variable in the build environment) and rebuild.',
    )
    this.name = 'MissingAppIdError'
  }
}

/** The subset of `import.meta.env` this module reads (kept narrow for tests). */
type Env = { readonly VITE_TRYSTERO_APP_ID?: string }

/** §9.4 — resolve the configured Trystero appId, failing fast when absent. */
export function resolveTrysteroAppId(env: Env = import.meta.env): string {
  const appId = env.VITE_TRYSTERO_APP_ID
  if (typeof appId !== 'string' || appId.trim() === '') throw new MissingAppIdError()
  return appId.trim()
}
