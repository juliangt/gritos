import { describe, expect, it } from 'vitest'
import features from '../docs/features.md?raw'
import deployment from '../docs/deployment.md?raw'
import security from '../docs/security.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #104 (PWA: manifest, service worker, offline app
 * shell + update toast) — the docs phase of the issue. Pins the
 * documentation to the shipped behavior:
 *
 *  1. the features reference bullet documents the installable shell with its
 *     honest limits (offline = shell only, P2P still needs connectivity)
 *     and the update toast,
 *  2. the deployment guide documents the SW behavior (build-time
 *     precache, waiting worker + toast, no silent swap, dev stays SW-free,
 *     HTTPS, iOS partial support),
 *  3. the security reference keeps the worker's promise visible:
 *     same-origin caching only, no push — notifications stay tab-scoped,
 *  4. spec §10.9 records the phase-4 status (installability, offline shell,
 *     the update flow and its decision: the worker never skipWaiting()s —
 *     the toast's [Recargar] reload is the only swap), §12 marks the
 *     roadmap item implemented and §11 grows the iOS-partial limitation,
 *  5. the manual install/offline/update matrix ships in
 *     `docs/qa-checklist.md` (QA-104-1..8).
 *
 * All three files are read through vite's `?raw` transform (no `node:fs` —
 * the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk (the ttlDocs.test.ts pattern).
 */

describe('PWA shell documentation (issue #104)', () => {
  it('documents the installable offline shell under a features-reference bullet, honestly', () => {
    expect(features).toContain('**Installable PWA with an offline shell (issue #104)**')
    // Honest scope: the shell boots offline; the P2P layer does not.
    expect(features).toContain('boots with **no network**')
    expect(features).toContain('P2P chat still needs WebRTC and the trackers')
    // The update toast, with its exact wording, never a silent swap.
    expect(features).toContain('New version available')
    expect(features).toContain('the new worker waits')
    // Subpath installs stay part of the promise.
    expect(features).toContain('GitHub Pages project sites and any subpath')
  })

  it('documents the service worker in the deployment guide', () => {
    expect(deployment).toContain('## Service worker / offline shell (issue #104)')
    expect(deployment).toContain('content-hashed precache of that exact build')
    expect(deployment).toContain('installs and **waits**')
    expect(deployment).toContain('There is no `skipWaiting` and no silent swap')
    expect(deployment).toContain('`npm run dev` stays SW-free')
    expect(deployment).toContain('Service workers share the HTTPS requirement')
    // iOS partial support, named as such.
    expect(deployment).toContain('iOS Safari caveat')
    expect(deployment).toContain('best-effort/partial support')
  })

  it('keeps the security model honest: same-origin worker, no push', () => {
    expect(security).toContain(
      'The offline service worker (issue #104) is same-origin by construction',
    )
    expect(security).toContain(
      'cross-origin traffic (the `wss:` trackers first of all) passes through untouched',
    )
    expect(security).toContain('adds no push channel — notifications remain tab-scoped')
  })

  it('records the phase-4 status in spec §10.9 with the skipWaiting decision', () => {
    expect(spec).toContain('### 10.9 PWA installation and update flow (issue #104)')
    expect(spec).toContain('**Status: implemented (issue #104).**')
    // The decision: waiting is the update flow's whole mechanism.
    expect(spec).toContain('The worker never calls `skipWaiting()`')
    // The issue's exact toast wording, role and session-only dismiss.
    expect(spec).toContain('"New version available — [Reload]"')
    expect(spec).toContain('role="status"')
    expect(spec).toContain('Dismissing the toast lasts only for the session')
    // No auto-swap: no controllerchange listener, on purpose.
    expect(spec).toContain('there is deliberately no `controllerchange` listener')
    // The offline shell stays honest and same-origin only.
    expect(spec).toContain('The offline shell is **honest**')
    expect(spec).toContain('is never cached')
    // Notifications stay tab-scoped — the SW adds no push.
    expect(spec).toContain('no push, no background sync')
  })

  it('marks the roadmap item implemented and grows the iOS limitation (spec §12, §11.10)', () => {
    expect(spec).toContain(
      'PWA (service worker, icons, offline shell; issue #104): **implemented**',
    )
    expect(spec).toContain('offline is the SHELL ONLY')
    expect(spec).toContain('10. **Partial PWA support on iOS (issue #104, 10.9)**')
  })

  it('ships the install/offline/update manual matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #104 — PWA install / offline / update matrix')
    for (let n = 1; n <= 8; n += 1) {
      expect(qaChecklist).toContain(`QA-104-${n}`)
    }
    // The CI note mirrors the issue: manual-only CI, the matrix runs locally.
    expect(qaChecklist).toContain('CI remains manual-only per `AGENTS.md`')
  })
})
