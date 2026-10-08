import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #104 (PWA: manifest, service worker, offline app
 * shell + update toast) — the docs phase of the issue. Pins the
 * documentation to the shipped behavior:
 *
 *  1. the README's feature bullet documents the installable shell with its
 *     honest limits (offline = shell only, P2P still needs connectivity)
 *     and the update toast,
 *  2. the README deployment section documents the SW behavior (build-time
 *     precache, waiting worker + toast, no silent swap, dev stays SW-free,
 *     HTTPS, iOS partial support),
 *  3. the README security model keeps the worker's promise visible:
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
  it('documents the installable offline shell under a README feature bullet, honestly', () => {
    expect(readme).toContain('**Installable PWA with an offline shell (issue #104)**')
    // Honest scope: the shell boots offline; the P2P layer does not.
    expect(readme).toContain('boots with **no network**')
    expect(readme).toContain('P2P chat still needs WebRTC and the trackers')
    // The update toast, with its exact wording, never a silent swap.
    expect(readme).toContain('Nueva versión disponible')
    expect(readme).toContain('the new worker waits')
    // Subpath installs stay part of the promise.
    expect(readme).toContain('GitHub Pages project sites and any subpath')
  })

  it('documents the service worker in the README deployment section', () => {
    expect(readme).toContain('**Service worker / offline shell (issue #104).**')
    expect(readme).toContain('content-hashed precache of that exact build')
    expect(readme).toContain('installs and **waits**')
    expect(readme).toContain('There is no `skipWaiting` and no silent swap')
    expect(readme).toContain('`npm run dev` stays SW-free')
    expect(readme).toContain('Service workers share the HTTPS requirement')
    // iOS partial support, named as such.
    expect(readme).toContain('iOS Safari caveat')
    expect(readme).toContain('best-effort/partial support')
  })

  it('keeps the security model honest: same-origin worker, no push', () => {
    expect(readme).toContain(
      'The offline service worker (issue #104) is same-origin by construction',
    )
    expect(readme).toContain(
      'cross-origin traffic (the `wss:` trackers first of all) passes through untouched',
    )
    expect(readme).toContain('adds no push channel — notifications remain tab-scoped')
  })

  it('records the phase-4 status in spec §10.9 with the skipWaiting decision', () => {
    expect(spec).toContain('### 10.9 Instalación PWA y flujo de actualización (issue #104)')
    expect(spec).toContain('**Estado: implementado (issue #104).**')
    // The decision: waiting is the update flow's whole mechanism.
    expect(spec).toContain('El worker jamás llama `skipWaiting()`')
    // The issue's exact toast wording, role and session-only dismiss.
    expect(spec).toContain('«Nueva versión disponible — [Recargar]»')
    expect(spec).toContain('role="status"')
    expect(spec).toContain('Descartar el toast vale solo por la sesión')
    // No auto-swap: no controllerchange listener, on purpose.
    expect(spec).toContain('no hay `controllerchange` a la escucha a propósito')
    // The offline shell stays honest and same-origin only.
    expect(spec).toContain('El shell offline es **honesto**')
    expect(spec).toContain('jamás se cachea')
    // Notifications stay tab-scoped — the SW adds no push.
    expect(spec).toContain('sin push, sin background sync')
  })

  it('marks the roadmap item implemented and grows the iOS limitation (spec §12, §11.10)', () => {
    expect(spec).toContain(
      'PWA (service worker, iconos, offline shell; issue #104): **implementado**',
    )
    expect(spec).toContain('lo offline es SOLO el shell')
    expect(spec).toContain('10. **Soporte PWA parcial en iOS (issue #104, 10.9)**')
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
