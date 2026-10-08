import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import {
  FILE_CHUNK_PAYLOAD_BYTES,
  FILE_CREDIT_WINDOW,
  FILE_MIME_MAX_LENGTH,
  FILE_NAME_MAX_LENGTH,
  FILE_OFFER_RATE_CAP,
  FILE_STALL_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_TRANSFERS_PER_PEER,
} from '../src/lib/p2p/fileTransfer'
import {
  FILE_ENC_STATE_CLEAR,
  FILE_ENC_WARNING_PUBLIC,
  FILE_REFUSAL_TEXT,
} from '../src/components/settings/messages'

/**
 * Release guard for issue #103 (P2P file and image transfer over data
 * channels). Started in phase 1 (the §12.4 design note that is the BINDING
 * CONTRACT for the later phases — crypto, engine `lib/p2p/fileTransfer.ts`,
 * UI, docs) and extended in phase 5 (docs + QA), it pins:
 *
 *  1. the §12.4 subsection heading exists and the §12 roadmap item
 *     references it,
 *  2. the implemented-status lead (what shipped: engine, crypto, UI — and
 *     the four interpretation points the engine resolved: room/DM key
 *     disambiguation by GCM auth, file-end-on-last-dispatch, sliding-window
 *     acks, gap-chunk drops),
 *  3. the exact binary framing byte layout of `file-chunk`
 *     (`[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]`),
 *  4. the 20 MB receiver hard cap constant name (`MAX_FILE_BYTES`),
 *  5. the no-broadcast non-goal (directed 1:1 only — mesh amplification
 *     rejected),
 *  6. the credit window constant (`FILE_CREDIT_WINDOW = 8`) with the
 *     `file-ack {id, nextSeq, grant}` action,
 *  7. the seal-then-frame encryption decision and the memory-only store
 *     representation (`fileOffers` map, not a feed message),
 *  8. the §7.1 action table rows for the five file actions, in lockstep
 *     with the shipped engine constants,
 *  9. the §8.1 memory-only store note (the `fileOffers` map lives in the
 *     engine, NOT in `AppState`; no new `localStorage` key) and the §11
 *     RAM limitation,
 * 10. the §12 roadmap item 1 marked implemented,
 * 11. the README feature bullet plus its Limits entry, and
 * 12. the manual QA matrix in `docs/qa-checklist.md` (QA-103-1..10).
 *
 * The markdown is read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk.
 */

describe('file transfer documentation (issue #103, phases 1 + 5)', () => {
  it('adds the §12.4 design note and its §12 roadmap reference', () => {
    expect(spec).toContain(
      '### 12.4 Nota de diseño: transferencia P2P de archivos por DataChannel (issue #103)',
    )
    expect(spec).toContain('nota de diseño en 12.4')
  })

  it('leads §12.4 with the implemented status: what shipped, and the four points the engine resolved', () => {
    expect(spec).toContain('**Estado: implementado (issue #103).**')
    expect(spec).not.toContain('pendiente de implementación')
    // What shipped, where (engine, crypto, UI).
    expect(spec).toContain(
      'el motor —encuadre, ventana de crédito, topes, máquina de estados— vive en `lib/p2p/fileTransfer.ts`',
    )
    expect(spec).toContain('el sellado binario de chunks en `lib/crypto/chunkCipher.ts`')
    expect(spec).toContain('el puente `useFileTransfers`')
    // Ambiguity 1: the wire cannot say which key sealed a chunk — GCM auth picks.
    expect(spec).toContain('la AUTENTICACIÓN GCM elige')
    // Ambiguity 2: file-end rides the last DISPATCH, not the ack barrier.
    expect(spec).toContain('justo tras DESPACHAR el último chunk')
    // Ambiguity 3: sliding window — every ack re-grants the FULL window.
    expect(spec).toContain('re-otorgan la ventana COMPLETA')
    // Ambiguity 4: gap chunks are dropped (contiguous discipline).
    expect(spec).toContain('un chunk con hueco se DESCARTA')
    // The §12.2 bridge: the note below is the approved design the code followed.
    expect(spec).toContain(
      'Lo que sigue es la nota de diseño aprobada que la implementación siguió.',
    )
  })

  it('pins the exact file-chunk binary framing byte layout', () => {
    expect(spec).toContain('[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]')
    expect(spec).toContain(
      `FILE_CHUNK_PAYLOAD_BYTES = ${Math.floor(FILE_CHUNK_PAYLOAD_BYTES / 1000)} ${
        FILE_CHUNK_PAYLOAD_BYTES % 1000
      }`,
    )
    expect(spec).toContain('los primeros 8 bytes del SHA-256 del `id` del meta')
  })

  it('pins the 20 MB receiver hard cap constant name', () => {
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024)
    expect(spec).toContain('MAX_FILE_BYTES = 20 × 1024 × 1024')
    expect(spec).toContain('tope duro del RECEPTOR')
  })

  it('pins the no-broadcast non-goal (directed 1:1, mesh amplification rejected)', () => {
    expect(spec).toContain('Ninguna transferencia se difunde a la sala')
    expect(spec).toContain('dirigida 1:1 por par que acepta, jamás broadcast')
  })

  it('pins the credit window and the file-ack flow-control action', () => {
    expect(spec).toContain(`FILE_CREDIT_WINDOW = ${FILE_CREDIT_WINDOW}`)
    expect(spec).toContain('`file-ack {id, nextSeq, grant}`')
    expect(spec).toContain(`FILE_STALL_TIMEOUT_MS = ${FILE_STALL_TIMEOUT_MS / 1000}_000`)
  })

  it('pins the seal-then-frame encryption decision and the no-extra-salt rule', () => {
    expect(spec).toContain('sellar antes de encuadrar (seal-then-frame)')
    expect(spec).toContain('Sin sal adicional')
  })

  it('pins the memory-only store representation: fileOffers map, never a feed message', () => {
    expect(spec).toContain('mapa `fileOffers`, no fila del feed')
    expect(spec).toContain('TTL (issue #96): NO aplica a los archivos')
  })

  it('documents the five file actions in the §7.1 table, in lockstep with the engine constants', () => {
    // The five rows, in §12.4's registration order (after `hist`, before `ping`).
    expect(spec).toContain('| `file-meta`')
    expect(spec).toContain('| `file-chunk`')
    expect(spec).toContain('| `file-ack`')
    expect(spec).toContain('| `file-end`')
    expect(spec).toContain('| `file-abort`')
    // Wire shapes.
    expect(spec).toContain('`{id, name, size, mime, chunks, enc}` (JSON)')
    expect(spec).toContain(
      '`Uint8Array` binario: `[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]`',
    )
    expect(spec).toContain('`{id, nextSeq, grant}` (JSON diminuto)')
    expect(spec).toContain('| `{id}` (JSON)')
    // parseFileMeta bounds, from the shipped constants.
    expect(spec).toContain('1..20 MB (`MAX_FILE_BYTES`)')
    expect(spec).toContain(`${FILE_NAME_MAX_LENGTH} (\`FILE_NAME_MAX_LENGTH\`)`)
    expect(spec).toContain(`${FILE_MIME_MAX_LENGTH} caracteres (\`FILE_MIME_MAX_LENGTH\``)
    expect(spec).toContain('`enc` booleano REQUERIDO sin default')
    expect(spec).toContain('`ceil(size / FILE_CHUNK_PAYLOAD_BYTES)`')
    // Caps and budgets.
    expect(spec).toContain(`FILE_OFFER_RATE_CAP = ${FILE_OFFER_RATE_CAP}`)
    expect(spec).toContain(`\`FILE_OFFER_RATE_CAP\` ofertas por par y minuto`)
    expect(spec).toContain(`\`MAX_TRANSFERS_PER_PEER\` transferencias concurrentes por par`)
    expect(spec).toContain('`grant` (0..`FILE_CREDIT_WINDOW`)')
    // Directed 1:1 only, mute gate first, consent before bytes.
    expect(spec).toContain('transferencia dirigida 1:1')
    expect(spec).toContain('jamás broadcast, 12.4')
    expect(spec).toContain('Puerta de silenciado (issue #95) antes de cualquier parseo')
    expect(spec).toContain('Antes de la aceptación no fluye ni un byte')
    expect(spec).toContain('ES la aceptación de la oferta')
  })

  it('documents the §8.1 store note: the fileOffers map lives in the engine, no new storage key', () => {
    expect(spec).toContain(
      '**Transferencias de archivos (issue #103, 12.4): el mapa `fileOffers` NO vive en `AppState`.**',
    )
    expect(spec).toContain('`fileOffers: Record<string, FileTransferRecord>`')
    expect(spec).toContain('(`getFileTransfers`)')
    expect(spec).toContain('(`revokeTransferUrl`)')
    expect(spec).toContain('la tarjeta ES el aviso')
    expect(spec).toContain('**No estrena clave de persistencia** (8.2)')
    expect(spec).toContain('el invariante de las cinco claves `gritos:*` queda intacto')
    expect(spec).toContain('`abortAllFileTransfers`')
    expect(spec).toContain('`abortAllOnIdentityRegeneration`')
    expect(spec).toContain('Recargar lo pierde todo')
  })

  it('carries the §11 RAM limitation: 20 MB blobs, the concurrency cap as mitigation, nothing persisted', () => {
    expect(spec).toContain('9. **Transferencias de archivos en RAM (issue #103, 12.4)**')
    expect(spec).toContain('hasta 20 MB por archivo')
    expect(spec).toContain(`\`MAX_TRANSFERS_PER_PEER = ${MAX_TRANSFERS_PER_PEER}\``)
    expect(spec).toContain('60 MB por par y dirección')
    expect(spec).toContain('las object URLs se revocan')
    expect(spec).toContain('la falla, sin reanudación')
  })

  it('marks roadmap item 1 implemented', () => {
    expect(spec).toContain('nota de diseño en 12.4): **implementado**')
    expect(spec).toContain('el primer `file-ack` con la ventana de crédito ES la aceptación')
    expect(spec).toContain('queda como trabajo futuro el meta sellado y la compresión')
  })

  it('documents the feature under a README bullet with consent-first, the cap and memory-only', () => {
    expect(readme).toContain('**P2P file and image transfer (issue #103)**')
    expect(readme).toContain('"Adjuntar" button offers a file')
    expect(readme).toContain('≤ 20 MB')
    expect(readme).toContain('must be accepted before a single byte flows')
    expect(readme).toContain('no auto-download, ever')
    expect(readme).toContain('public rooms are DTLS-only')
    expect(readme).toContain('explicit pre-send warning')
    expect(readme).toContain('Memory-only end to end')
    expect(readme).toContain('nothing touches `localStorage`/IndexedDB')
    expect(readme).toContain('a reload loses everything')
    expect(readme).toContain('reconnect mid-transfer fails the transfer with no resume')
  })

  it('adds the RAM limitation to the README Limits section', () => {
    expect(readme).toContain('9. **File transfers live in RAM (issue #103):**')
    expect(readme).toContain('up to 20 MB per file')
    expect(readme).toContain(`${MAX_TRANSFERS_PER_PEER} concurrent transfers per peer (both sides)`)
    expect(readme).toContain('Nothing is persisted: a reload loses every transfer')
  })

  it('ships the manual file-transfer matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #103 — file transfer')
    expect(qaChecklist.match(/QA-103-\d+/g) ?? []).toHaveLength(10)
    for (let n = 1; n <= 10; n += 1) {
      expect(qaChecklist).toContain(`QA-103-${n}`)
    }
    // The consent card and dialog encryption states are pinned to the exact UI strings.
    expect(qaChecklist).toContain(FILE_ENC_WARNING_PUBLIC)
    expect(qaChecklist).toContain(FILE_ENC_STATE_CLEAR)
    expect(qaChecklist).toContain(FILE_REFUSAL_TEXT['concurrency-cap'])
  })
})
