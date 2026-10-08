import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #98 (emoji reactions) — the docs phase of the
 * issue. Pins the documentation to the shipped behavior:
 *
 *  1. the README's feature bullet documents the whitelist, the aggregated
 *     chips, the cosmetic control-plane class, the directed DM semantics and
 *     the nothing-persisted guarantee,
 *  2. spec §7.1 adds the `react` action row (payload shape with the optional
 *     `to`, batch cap 1–50, 7-emoji whitelist, 30-payloads/min/peer rate
 *     cap, content-keyed dedup, broadcast vs directed semantics, cosmetic
 *     class) between `receipt` and `ping`, mirroring the code order,
 *  3. spec §8.1 grows the state shape: `Message.reactions` with the ≤7-key
 *     and ≤50-peerIds caps, the refuse-not-evict discipline and the
 *     emptied-key normalization,
 *  4. spec §9.5 folds reactions into the unauthenticated control-plane
 *     bullet: forgeable like receipts/typing, bounded by caps, mute-gated
 *     (issue #95 parity),
 *  5. spec §12.3 records the mixed-build spike (source analysis of
 *     `@trystero-p2p/core` 0.25.4: name-padded wire chunks, unregistered
 *     names parked — old builds ignore `react` safely; the issue's receipt
 *     fallback is unneeded), and
 *  6. the manual QA-98 matrix ships in `docs/qa-checklist.md`.
 *
 * All three files are read through vite's `?raw` transform (no `node:fs` —
 * the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk.
 */

describe('emoji reactions documentation (issue #98)', () => {
  it('documents the reactions under a README feature bullet', () => {
    expect(readme).toContain('**Emoji reactions (issue #98)**')
    // The fixed whitelist of seven, as shipped in REACT_EMOJIS.
    expect(readme).toContain('seven reactions (👍 ❤️ 😂 😮 😢 🎉 👎)')
    // Cosmetic control plane: unauthenticated traffic, capped, never persisted.
    expect(readme).toContain('cosmetic control-plane traffic')
    expect(readme).toContain('≤50 ids')
    expect(readme).toContain('≤30 payloads per peer per minute')
    // Directed DM reactions and the no-side-effects/no-persistence guarantees.
    expect(readme).toContain('directed at the recipient')
    expect(readme).toContain('never raise notifications or unread badges')
    expect(readme).toContain('nothing is persisted')
  })

  it('adds the react action to the §7.1 table, between receipt and ping', () => {
    expect(spec).toContain('Reacción emoji (issue #98)')
    // Payload shape: batched ids, whitelisted emo, toggle, optional directed to.
    expect(spec).toContain('`{ids: string[], emo: string, on: boolean, to?: string}`')
    // Batch cap mirrors the receipt discipline.
    expect(spec).toContain('lote de 1–50 ids de mensaje (mismo molde que `receipt`)')
    // The whitelist is pinned by its exact seven emojis.
    expect(spec).toContain('lista blanca fija (👍 ❤️ 😂 😮 😢 🎉 👎)')
    // Broadcast vs directed `to` semantics.
    expect(spec).toContain('Sin `to` es difusión a toda la sala')
    expect(spec).toContain('el resto de la sala no la ve')
    expect(spec).toContain('jamás la retransmite (7.3)')
    // Receive-path caps: rate cap and content-keyed dedup.
    expect(spec).toContain('tope de 30 payloads por par y minuto')
    expect(spec).toContain('deduplicación por contenido')
    // Cosmetic class: no notifications, no unread, no persistence.
    expect(spec).toContain('Jamás notifica, marca no leídos ni persiste')
    // Row order mirrors the code: receipt, then react, then ping.
    expect(spec.indexOf('Acuse de recibo (batch, máx. 50 ids).')).toBeLessThan(
      spec.indexOf('Reacción emoji (issue #98)'),
    )
    expect(spec.indexOf('Reacción emoji (issue #98)')).toBeLessThan(spec.indexOf('| `ping`'))
  })

  it('grows the spec §8.1 state shape: Message.reactions with caps and normalization', () => {
    expect(spec).toContain('reactions?: Partial<Record<ReactEmoji, string[]>>')
    // ≤7 keys (the whole whitelist) and ≤50 peerIds per emoji, refuse-not-evict.
    expect(spec).toContain('Tope de 7 claves')
    expect(spec).toContain('el 51.º se rechaza, jamás se expulsa')
    // Emptied keys normalize away: no ghost state after an unreact.
    expect(spec).toContain('el mapa vacío vuelve a undefined')
    // Cosmetic class: memory-only, dies with its message row.
    expect(spec).toContain('Clase cosmética (9.5): solo memoria')
  })

  it('folds reactions into the §9.5 unauthenticated control-plane note', () => {
    // Forgeable, same class as receipts/typing/system lines/pongs.
    expect(spec).toContain('reacciones emoji (`react`, issue #98)')
    expect(spec).toContain('hinchar los conteos de reacciones de mensajes ajenos')
    // Bounded by the shipped caps.
    expect(spec).toContain(
      'lista blanca de 7 emojis, lote ≤50 ids, tope de 30 payloads por par y minuto',
    )
    // Mute gates them (issue #95 parity).
    expect(spec).toContain('las líneas de sistema y las reacciones (issue #98) del par silenciado')
  })

  it('records the mixed-build spike in spec §12.3 with the fallback verdict', () => {
    expect(spec).toContain('### 12.3 Nota: spike mixed-build de la acción `react` (issue #98)')
    // Source analysis of the pinned transport.
    expect(spec).toContain('`@trystero-p2p/core` 0.25.4')
    expect(spec).toContain('action-wire.mjs')
    // Actions route by name: chunks embed the zero-padded 32-byte action name.
    expect(spec).toContain('relleno a cero hasta 32 bytes')
    // Unregistered names are reassembled then parked: old builds ignore react.
    expect(spec).toContain('`pendingActionPayloads`')
    expect(spec).toContain('un build antiguo ignora el tráfico `react` en silencio')
    // The issue's feared receipt-channel fallback is unneeded.
    expect(spec).toContain('dirigir las reacciones por el canal `receipt` — se descarta')
  })

  it('ships the manual reactions matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #98 — emoji reactions')
    for (let n = 1; n <= 7; n += 1) {
      expect(qaChecklist).toContain(`QA-98-${n}`)
    }
    // The old-build interop row is marked appropriately when no old build runs.
    expect(qaChecklist).toContain('covered-by-analysis')
  })
})
