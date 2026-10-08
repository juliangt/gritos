import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
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
 *  1. the README's feature bullet documents the two-sided consent (the
 *     request card plus the Privacidad toggle, off by default), the 50-cap,
 *     the separator with its dimmed provenance rows, the replay guarantees
 *     (freshness bypass only, dedup both directions, zero arrival side
 *     effects), the password-room re-seal and the trust note,
 *  2. README limitation 5 is softened with exactly that opt-in caveat,
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
  it('documents the feature under a README bullet with the two-sided consent', () => {
    expect(readme).toContain('**Opt-in history gossip (issue #102)**')
    expect(readme).toContain(HISTORY_ASK_TEXT)
    expect(readme).toContain(SHARE_HISTORY_LABEL)
    expect(readme).toContain('off by default')
    expect(readme).toContain('at most the last 50 chat messages')
    expect(readme).toContain(RECOVERED_SEPARATOR_TEXT)
    expect(readme).toContain('slightly dimmed')
    expect(readme).toContain('capped at 50 per join session')
  })

  it('pins the README replay guarantees: bypass-only, dedup, zero side effects, re-seal, trust note', () => {
    expect(readme).toContain('bypasses only the 5-minute freshness window')
    expect(readme).toContain('±90 s future-skew check stays')
    expect(readme).toContain('dedups in both directions')
    expect(readme).toContain('never duplicates a row')
    expect(readme).toContain('zero arrival side effects')
    expect(readme).toContain('never notify and never receipt')
    expect(readme).toContain('re-sealed with the room key')
    expect(readme).toContain('same password')
    expect(readme).toContain('Nothing is persisted anywhere')
    expect(readme).toContain('labels provenance, not veracity')
  })

  it('softens README limitation 5 with the opt-in caveat', () => {
    expect(readme).toContain('5. **No server:** history is not kept for late joiners by default')
    expect(readme).toContain('opt-in history gossip (issue #102) softens exactly that case')
    expect(readme).toContain('only when the joiner explicitly asks AND a peer has consented')
    expect(readme).toContain('with nothing persisted')
  })

  it('documents hist-req and hist in the spec §7.1 table, in lockstep with the protocol constants', () => {
    expect(spec).toContain('| `hist-req`')
    expect(spec).toContain('| `hist` ')
    expect(spec).toContain('`{n: number}`')
    expect(spec).toContain('`{batch: Envelope[]}`')
    // Ask-side bounds: n ≤ 50, 1 req/min, parked-until-peer-join.
    expect(spec).toContain(`1..${MAX_HISTORY_REQUEST} (\`MAX_HISTORY_REQUEST\`)`)
    expect(spec).toContain(`${HISTORY_REQ_RATE_CAP} petición/minuto`)
    expect(spec).toContain('se ESTACIONA y sale con la primera unión de par')
    // Receive bounds: 6 batches/min → ≤ 120 msgs/min/peer.
    expect(spec).toContain(`${HISTORY_RATE_CAP} lotes por par y minuto`)
    expect(spec).toContain(`≤ ${HISTORY_RATE_CAP * MAX_HISTORY_BATCH} mensajes/min/par`)
    // Chunking: ≤ 20 envelopes AND ≤ 48 KiB measured per batch.
    expect(spec).toContain(`1–${MAX_HISTORY_BATCH} sobres`)
    expect(spec).toContain(`≤ ${MAX_HISTORY_BATCH_BYTES / 1024} KiB`)
    expect(spec).toContain('`chunkHistBatches`')
    expect(spec).toContain('re-sella los cuerpos con la clave de la sala')
    expect(spec).toContain('Cero efectos de transporte')
  })

  it('pins the §7.3 replay rules: bypass only, shape re-validation, dedup, silence, caps', () => {
    expect(spec).toContain('Chisme de historial opt-in (issue #102)')
    expect(spec).toContain('la validación de forma es completa (`parseEnvelope`')
    // Freshness: the AGE window is bypassed, the future-skew check stays.
    expect(spec).toContain('bypass deliberado')
    expect(spec).toContain('sesgo de futuro de ±90 s se conserva')
    expect(spec).toContain('`isWithinFutureSkew`')
    // Dedup both directions; zero arrival side effects.
    expect(spec).toContain('La deduplicación vale en ambas direcciones')
    expect(spec).toContain('Cero efectos de llegada')
    expect(spec).toContain('el ✓✓ significa entrega en vivo')
    // Recipient cap, arrival order, muted-author fail-open.
    expect(spec).toContain(`${MAX_RECOVERED_PER_JOIN} recuperados por sesión de unión`)
    expect(spec).toContain('NO aplica a lo reenviado')
    expect(spec).toContain('falla en abierto')
    // TTL on the receiver clock; no resurrection.
    expect(spec).toContain('`expiresAt = Date.now() + ttl·1000`')
    expect(spec).toContain('no resucita jamás por chisme')
    // Password rooms: ciphertext never lands as text; keyless drop.
    expect(spec).toContain('el ciphertext crudo jamás aterriza como texto')
  })

  it('labels provenance with the exact separator and cross-references the §9.5 trust note', () => {
    expect(RECOVERED_SEPARATOR_TEXT).toBe('— mensajes recuperados de pares —')
    expect(spec).toContain(`«${RECOVERED_SEPARATOR_TEXT}»`)
    expect(spec).toContain('mismo nivel de confianza que el chat en vivo')
    expect(spec).toContain('(9.5, plano de control sin autenticar)')
    expect(spec).toContain('Nada se persiste')
    expect(spec).toContain('el botón de pánico (RF-08) no necesita nada especial')
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
      'retransmisión de últimos N mensajes a nuevos participantes (issue #102): **implementado**',
    )
    expect(spec).toContain('el chisme de historial opt-in reenvía')
    expect(spec).toContain('etiqueta la procedencia, no la veracidad')
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
