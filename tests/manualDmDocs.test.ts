import { describe, expect, it } from 'vitest'
import spec from '../docs/spec.md?raw'

/**
 * Release guard for issue #97 (trackerless DMs: manual peer connection via
 * copy/paste signaling) — the design-note phase of the issue. Pins spec
 * §12.2 to the decisions the later phases (engine, UI, integration) must
 * implement without re-deciding:
 *
 *  1. the §12.2 subsection heading exists and the §12 roadmap references it,
 *  2. the architecture rule: `RTCPeerConnection` may only appear in
 *     `lib/p2p/manualPeer.ts` (mirror of the roomManager/Trystero rule),
 *  3. the no-relay non-goal: manual peers never relay into room meshes,
 *  4. the fingerprint-keyed TOFU decision: pins ride the same flat
 *     `gritos:tofu` map under the reserved `manual:` prefix (five-key
 *     invariant of §8.2 intact, same panic wipe),
 *  5. the exact Spanish SDP privacy warning the future UI must reuse
 *     verbatim (it will move to settings/messages.ts in the UI phase).
 *
 * The spec is read through vite's `?raw` transform (no `node:fs` — the
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
