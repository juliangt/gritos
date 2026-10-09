import { describe, expect, it } from 'vitest'
import features from '../docs/features.md?raw'
import limitations from '../docs/limitations.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import {
  MAX_HISTORY_BATCH,
  MAX_HISTORY_BATCH_BYTES,
  MAX_HISTORY_REQUEST,
} from '../src/lib/p2p/protocol'
import {
  HISTORY_RATE_CAP,
  HISTORY_REQ_RATE_CAP,
  MAX_RECOVERED_PER_JOIN,
} from '../src/lib/p2p/roomManager'
import { RECOVERED_SEPARATOR_TEXT } from '../src/lib/feed'
import { HISTORY_ASK_TEXT, SHARE_HISTORY_LABEL } from '../src/components/settings/messages'

/**
 * Release guard for issue #102 (opt-in history gossip: late joiners request
 * recent messages from peers) — the docs phase of the issue. Pins the
 * documentation to the shipped behavior:
 *
 *  1. the features reference bullet documents the two-sided consent (the
 *     request card plus the Privacidad toggle, off by default), the 50-cap,
 *     the separator with its dimmed provenance rows, the replay guarantees
 *     (freshness bypass only, dedup both directions, zero arrival side
 *     effects), the password-room re-seal and the trust note,
 *  2. limitations reference item 5 is softened with exactly that opt-in caveat,
 *  3. spec §7.1 documents the `hist-req`/`hist` actions in lockstep with the
 *     shipped protocol constants (n ≤ 50, batches of ≤ 20 envelopes ≤ 48 KiB,
 *     1 req/min ask budget, 6 batches/min receive budget),
 *  4. spec §7.3 carries the replay rules (shape re-validation, the freshness
 *     AGE bypass with the future-skew check kept, dedup both directions,
 *     zero side effects, the 50/join recipient cap, no 2 s window, the
 *     muted-author gate failing open, receiver-clock TTL, the separator as
 *     honest provenance labeling with the §9.5 trust cross-ref, and nothing
 *     persisted),
 *  5. spec §8.1 grows the state shape (`Settings.shareHistory`,
 *     `Message.recovered`, `Room.recoveredCount`/`historyAskDismissed`),
 *  6. spec §12 marks roadmap item 2 implemented and §9.5 folds forged
 *     history into the unauthenticated control plane, and
 *  7. the manual QA matrix ships in `docs/qa-checklist.md` (QA-102-1..11).
 *
 * The markdown files are read through vite's `?raw` transform (no `node:fs`
 * — the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk; the separator is pinned to the constant
 * the feed actually renders.
 */

describe('history gossip documentation (issue #102)', () => {
  it('documents the feature under a features-reference bullet with the two-sided consent', () => {
    expect(features).toContain('**Opt-in history gossip (issue #102)**')
    expect(features).toContain(HISTORY_ASK_TEXT)
    expect(features).toContain(SHARE_HISTORY_LABEL)
    expect(features).toContain('off by default')
    expect(features).toContain('at most the last 50 chat messages')
    expect(features).toContain(RECOVERED_SEPARATOR_TEXT)
    expect(features).toContain('slightly dimmed')
    expect(features).toContain('capped at 50 per join session')
  })

  it('pins the features-reference replay guarantees: bypass-only, dedup, zero side effects, re-seal, trust note', () => {
    expect(features).toContain('bypasses only the 5-minute freshness window')
    expect(features).toContain('±90 s future-skew check stays')
    expect(features).toContain('dedups in both directions')
    expect(features).toContain('never duplicates a row')
    expect(features).toContain('zero arrival side effects')
    expect(features).toContain('never notify and never receipt')
    expect(features).toContain('re-sealed with the room key')
    expect(features).toContain('same password')
    expect(features).toContain('Nothing is persisted anywhere')
    expect(features).toContain('labels provenance, not veracity')
  })

  it('softens limitations-reference item 5 with the opt-in caveat', () => {
    expect(limitations).toContain(
      '5. **No server:** history is not kept for late joiners by default',
    )
    expect(limitations).toContain('opt-in history gossip (issue #102) softens exactly that case')
    expect(limitations).toContain('only when the joiner explicitly asks AND a peer has consented')
    expect(limitations).toContain('with nothing persisted')
  })

  it('documents hist-req and hist in the spec §7.1 table, in lockstep with the protocol constants', () => {
    expect(spec).toContain('| `hist-req`')
    expect(spec).toContain('| `hist` ')
    expect(spec).toContain('`{n: number}`')
    expect(spec).toContain('`{batch: Envelope[]}`')
    // Ask-side bounds: n ≤ 50, 1 req/min, parked-until-peer-join.
    expect(spec).toContain(`1..${MAX_HISTORY_REQUEST} (\`MAX_HISTORY_REQUEST\`)`)
    expect(spec).toContain(`${HISTORY_REQ_RATE_CAP} request/minute`)
    expect(spec).toContain('is PARKED and leaves with the first peer join')
    // Receive bounds: 6 batches/min → ≤ 120 msgs/min/peer.
    expect(spec).toContain(`${HISTORY_RATE_CAP} batches per peer per minute`)
    expect(spec).toContain(`≤ ${HISTORY_RATE_CAP * MAX_HISTORY_BATCH} messages/min/peer`)
    // Chunking: ≤ 20 envelopes AND ≤ 48 KiB measured per batch.
    expect(spec).toContain(`1–${MAX_HISTORY_BATCH} \`chat\` envelopes`)
    expect(spec).toContain(`≤ ${MAX_HISTORY_BATCH_BYTES / 1024} KiB`)
    expect(spec).toContain('`chunkHistBatches`')
    expect(spec).toContain('re-seals the bodies with the room key')
    expect(spec).toContain('Zero transport effects')
  })

  it('pins the §7.3 replay rules: bypass only, shape re-validation, dedup, silence, caps', () => {
    expect(spec).toContain('Opt-in history gossip (issue #102)')
    expect(spec).toContain('the shape validation is complete (`parseEnvelope`')
    // Freshness: the AGE window is bypassed, the future-skew check stays.
    expect(spec).toContain('deliberate bypass')
    expect(spec).toContain('the ±90 s future skew is kept')
    expect(spec).toContain('`isWithinFutureSkew`')
    // Dedup both directions; zero arrival side effects.
    expect(spec).toContain('Deduplication holds in both directions')
    expect(spec).toContain('Zero arrival effects')
    expect(spec).toContain('✓✓ means live delivery')
    // Recipient cap, arrival order, muted-author fail-open.
    expect(spec).toContain(`${MAX_RECOVERED_PER_JOIN} recovered per join session`)
    expect(spec).toContain('does NOT apply to replayed rows')
    expect(spec).toContain('fails open')
    // TTL on the receiver clock; no resurrection.
    expect(spec).toContain('`expiresAt = Date.now() + ttl·1000`')
    expect(spec).toContain('never resurrects through gossip')
    // Password rooms: ciphertext never lands as text; keyless drop.
    expect(spec).toContain('the raw ciphertext never lands as text')
  })

  it('labels provenance with the exact separator and cross-references the §9.5 trust note', () => {
    expect(RECOVERED_SEPARATOR_TEXT).toBe('— messages recovered from peers —')
    expect(spec).toContain(`"${RECOVERED_SEPARATOR_TEXT}"`)
    expect(spec).toContain('same level of trust as live chat')
    expect(spec).toContain('(9.5, unauthenticated control plane)')
    expect(spec).toContain('Nothing is persisted')
    expect(spec).toContain('the panic button (RF-08) needs nothing special')
  })

  it('grows the spec §8.1 state shape with the consent flag and the recovered fields', () => {
    expect(spec).toContain('shareHistory: boolean')
    expect(spec).toContain('recovered?: boolean')
    expect(spec).toContain('recoveredCount: number')
    expect(spec).toContain('historyAskDismissed: boolean')
    expect(spec).toContain('Default: false')
    expect(spec).toContain(SHARE_HISTORY_LABEL)
  })

  it('marks roadmap item 2 implemented and folds forged history into the §9.5 control plane', () => {
    expect(spec).toContain(
      'relay of the last N messages to late joiners (issue #102): **implemented**',
    )
    expect(spec).toContain('the opt-in history gossip relays')
    expect(spec).toContain('labels provenance, not veracity')
  })

  it('ships the manual history-gossip matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #102 — history gossip')
    expect(qaChecklist.match(/QA-102-\d+/g) ?? []).toHaveLength(11)
    for (let n = 1; n <= 11; n += 1) {
      expect(qaChecklist).toContain(`QA-102-${n}`)
    }
    expect(qaChecklist).toContain(RECOVERED_SEPARATOR_TEXT)
    expect(qaChecklist).toContain(HISTORY_ASK_TEXT)
    expect(qaChecklist).toContain(SHARE_HISTORY_LABEL)
  })
})
