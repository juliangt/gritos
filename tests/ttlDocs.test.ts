import { describe, expect, it } from 'vitest'
import features from '../docs/features.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #96 (self-destructing messages: optional
 * per-message TTL) — the docs phase of the issue. Pins the documentation to
 * the shipped behavior:
 *
 *  1. the features reference bullet documents the TTL under the ephemerality
 *     story with the additive-wire degradation,
 *  2. spec §7.2 documents the optional `ttl` field (units, inclusive bounds,
 *     absent = session-lived, invalid = whole envelope dropped) and keeps
 *     `v` per-kind with no bump — old builds ignore the field and keep the
 *     message for the session,
 *  3. spec §7.3 carries the enforcement rule (receiver-clock `expiresAt`,
 *     1 s sweep, separator, no-resurrection guard, receipts/unread/
 *     notifications not retro-touched, FIFO slot-freeing),
 *  4. spec §8.1 grows the state shape: `Message.expiresAt?` plus the
 *     `expiredCount` separator counters on `Room` and `DmChannel`, and
 *  5. the manual TTL matrix ships in `docs/qa-checklist.md`.
 *
 * All three files are read through vite's `?raw` transform (no `node:fs` —
 * the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk.
 */

describe('self-destructing messages documentation (issue #96)', () => {
  it('documents the TTL under a features-reference bullet with the degradation', () => {
    expect(features).toContain('**Self-destructing messages (issue #96)**')
    expect(features).toContain('30 s / 5 min / 1 h')
    expect(features).toContain('receiver-clock expiry')
    expect(features).toContain('older builds ignore the field and keep the message for the session')
  })

  it('documents the ttl field and its bounds in spec §7.2', () => {
    expect(spec).toContain('"ttl": 300')
    expect(spec).toContain('30–3600 inclusive')
    expect(spec).toContain('absent = the message lives for the whole session')
    // An invalid ttl drops the WHOLE envelope, never just the field.
    expect(spec).toContain('invalidates the **whole envelope**')
  })

  it('keeps the envelope version per-kind with no bump for ttl', () => {
    expect(spec).toContain('introduces no new version')
    expect(spec).toContain(
      'ignores the field silently and **keeps the message for the whole session**',
    )
  })

  it('pins the §7.3 enforcement rule: receiver clock, sweep, separator, guards', () => {
    expect(spec).toContain('Per-message expiry (issue #96)')
    expect(spec).toContain('expiresAt = receivedAt + ttl·1000')
    expect(spec).toContain('is never used to expire')
    expect(spec).toContain('— N expired messages —')
    // No resurrection: bounded expired-ids guard on the receive paths.
    expect(spec).toContain('no resurrection')
    // Receipts, unread and notifications are never retro-touched.
    expect(spec).toContain('no retro-touch')
    // Expired messages free FIFO slots before the 500 cap.
    expect(spec).toContain('frees its slot')
  })

  it('grows the spec §8.1 state shape: Message.expiresAt? and both expiredCount counters', () => {
    expect(spec).toContain('expiresAt?: number')
    expect(spec.match(/expiredCount: number/g) ?? []).toHaveLength(2)
  })

  it('ships the manual TTL matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #96 — self-destructing messages (TTL)')
    for (let n = 1; n <= 7; n += 1) {
      expect(qaChecklist).toContain(`QA-96-${n}`)
    }
  })
})
