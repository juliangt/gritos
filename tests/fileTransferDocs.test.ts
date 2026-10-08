import { describe, expect, it } from 'vitest'
import spec from '../docs/spec.md?raw'

/**
 * Release guard for issue #103, phase 1 (framing design — spec note first):
 * pins the §12.4 design note that is the BINDING CONTRACT for the later
 * phases (crypto, engine `lib/p2p/fileTransfer.ts`, UI, docs), so no phase
 * re-decides what is written here. Following the manualDmDocs.test.ts
 * pattern (issue #97), it pins:
 *
 *  1. the §12.4 subsection heading exists and the §12 roadmap item
 *     references it,
 *  2. the approved-status lead (spec note first — nothing implemented yet),
 *  3. the exact binary framing byte layout of `file-chunk`
 *     (`[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]`),
 *  4. the 20 MB receiver hard cap constant name (`MAX_FILE_BYTES`),
 *  5. the no-broadcast non-goal (directed 1:1 only — mesh amplification
 *     rejected),
 *  6. the credit window constant (`FILE_CREDIT_WINDOW = 8`) with the
 *     `file-ack {id, nextSeq, grant}` action,
 *
 * plus the seal-then-frame encryption decision and the memory-only store
 * representation (`fileOffers` map, not a feed message). The markdown is
 * read through vite's `?raw` transform (no `node:fs` — the project
 * deliberately ships no Node types), so the assertions run against the
 * exact bytes on disk.
 */

describe('file transfer design note documentation (issue #103, phase 1)', () => {
  it('adds the §12.4 design note and its §12 roadmap reference', () => {
    expect(spec).toContain(
      '### 12.4 Nota de diseño: transferencia P2P de archivos por DataChannel (issue #103)',
    )
    expect(spec).toContain('nota de diseño en 12.4')
  })

  it('leads with the approved-note status: binding contract, nothing implemented yet', () => {
    expect(spec).toContain(
      '**Estado: nota de diseño aprobada — contrato vinculante de las fases 2–5 del issue (cripto, motor `lib/p2p/fileTransfer.ts`, UI, docs); pendiente de implementación.**',
    )
  })

  it('pins the exact file-chunk binary framing byte layout', () => {
    expect(spec).toContain('[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]')
    expect(spec).toContain('FILE_CHUNK_PAYLOAD_BYTES = 16 356')
    expect(spec).toContain('los primeros 8 bytes del SHA-256 del `id` del meta')
  })

  it('pins the 20 MB receiver hard cap constant name', () => {
    expect(spec).toContain('MAX_FILE_BYTES = 20 × 1024 × 1024')
    expect(spec).toContain('tope duro del RECEPTOR')
  })

  it('pins the no-broadcast non-goal (directed 1:1, mesh amplification rejected)', () => {
    expect(spec).toContain('Ninguna transferencia se difunde a la sala')
    expect(spec).toContain('dirigida 1:1 por par que acepta, jamás broadcast')
  })

  it('pins the credit window and the file-ack flow-control action', () => {
    expect(spec).toContain('FILE_CREDIT_WINDOW = 8')
    expect(spec).toContain('`file-ack {id, nextSeq, grant}`')
    expect(spec).toContain('FILE_STALL_TIMEOUT_MS = 30_000')
  })

  it('pins the seal-then-frame encryption decision and the no-extra-salt rule', () => {
    expect(spec).toContain('sellar antes de encuadrar (seal-then-frame)')
    expect(spec).toContain('Sin sal adicional')
  })

  it('pins the memory-only store representation: fileOffers map, never a feed message', () => {
    expect(spec).toContain('mapa `fileOffers`, no fila del feed')
    expect(spec).toContain('TTL (issue #96): NO aplica a los archivos')
  })
})
