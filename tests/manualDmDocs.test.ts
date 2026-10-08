import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import runbook from '../docs/runbook-trackers.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #97 (trackerless DMs: manual peer connection via
 * copy/paste signaling) — the design note and its phase-4 documentation.
 * Pins spec §12.2 to the decisions the later phases (engine, UI,
 * integration) implemented without re-deciding, plus the shipped status and
 * the cross-references:
 *
 *  1. the §12.2 subsection heading exists and the §12 roadmap references it
 *     (now marked implemented),
 *  2. the architecture rule: `RTCPeerConnection` may only appear in
 *     `lib/p2p/manualPeer.ts` (mirror of the roomManager/Trystero rule),
 *  3. the no-relay non-goal: manual peers never relay into room meshes,
 *  4. the fingerprint-keyed TOFU decision: pins ride the same flat
 *     `gritos:tofu` map under the reserved `manual:` prefix (five-key
 *     invariant of §8.2 intact, same panic wipe),
 *  5. the exact Spanish SDP privacy warning the UI reuses verbatim,
 *  6. the phase-4 status flip: §12.2 leads with the implemented state and
 *     names the shipped surfaces (engine, manager, RF-07 seam),
 *  7. the §9.2 / §8.2 one-line cross-references (ephemeral keys ride the
 *     invite blob; `manual:` pins share the same key and wipe),
 *  8. the README feature bullet + softened limitation 7 + security-model
 *     clause, and the runbook's zero-infrastructure pointer,
 *  9. the manual QA-97 matrix in `docs/qa-checklist.md`.
 *
 * All files are read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk.
 */

describe('manual DM design note documentation (issue #97)', () => {
  it('adds the §12.2 design note and its §12 roadmap entry', () => {
    expect(spec).toContain(
      '### 12.2 Nota de diseño: DMs sin trackers — conexión manual de pares (issue #97)',
    )
    expect(spec).toContain('nota de diseño en 12.2')
  })

  it('pins the RTCPeerConnection architecture rule (mirror of the roomManager rule)', () => {
    expect(spec).toContain('`RTCPeerConnection` solo puede aparecer en `lib/p2p/manualPeer.ts`')
  })

  it('pins the no-relay non-goal for manual peers', () => {
    expect(spec).toContain('Ningún par manual actúa de relé')
  })

  it('pins the fingerprint-keyed TOFU decision under the same gritos:tofu key', () => {
    expect(spec).toContain('prefijo reservado `manual:`')
  })

  it('pins the exact Spanish SDP privacy warning for the future UI', () => {
    expect(spec).toContain('La invitación puede contener información de tu red')
  })
})

describe('manual DM phase-4 documentation (issue #97)', () => {
  it('flips the §12.2 status to implemented and names the shipped surfaces', () => {
    expect(spec).toContain('**Estado: implementado (issue #97).**')
    expect(spec).not.toContain('pendiente de implementación (issue #97)')
    expect(spec).toContain('`lib/p2p/manualDmManager.ts`')
    expect(spec).toContain('`onSessionIdentityRegenerated`')
    expect(spec).toContain('`abortAllManualDms`')
  })

  it('marks the §12 roadmap entry implemented (mirroring the #93 entry)', () => {
    expect(spec).toContain(
      '8. DMs sin sala compartida por conexión manual de pares (issue #97; nota de diseño en 12.2): **implementado**',
    )
  })

  it('cross-references the manual path from §9.2 (the ephemeral rides the blob)', () => {
    expect(spec).toContain('no tienen anuncio `ephkeys`')
    expect(spec).toContain('su efímera viaja dentro del blob de invitación')
  })

  it('cross-references the reserved manual: keys from §8.2 (same key, same wipe)', () => {
    expect(spec).toContain(
      'comparten `gritos:tofu` bajo el prefijo reservado `manual:<huella-canónica>`',
    )
  })

  it('README: features bullet for the trackerless manual DM', () => {
    expect(readme).toContain('**Trackerless DMs via manual invite (issue #97)**')
    expect(readme).toContain('zero infrastructure')
    expect(readme).toContain('TOFU fingerprint comparison surfaced before the first message')
  })

  it('README: limitation 7 softened with the manual-path caveat', () => {
    expect(readme).toContain('7. **DMs usually need a shared room:**')
    expect(readme).toContain(
      'the manual invite wizard (issue #97) is the deliberate zero-infrastructure exception',
    )
  })

  it('README: security-model clause on the blobs and their manual: pins', () => {
    expect(readme).toContain('never message data')
    expect(readme).toContain('reserved `manual:` keys')
  })

  it('runbook: the zero-infrastructure path when trackers are unreachable', () => {
    expect(runbook).toContain('## El camino sin infraestructura: DM por invitación manual')
    expect(runbook).toContain('o conéctate sin trackers')
    expect(runbook).toContain('(spec §12.2)')
  })

  it('ships the manual QA-97 matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #97 — trackerless manual DMs')
    for (let n = 1; n <= 7; n += 1) {
      expect(qaChecklist).toContain(`QA-97-${n}`)
    }
  })
})
