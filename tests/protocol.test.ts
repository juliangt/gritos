import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_AGE_MS,
  MAX_PAYLOAD_BYTES,
  MAX_PLAINTEXT_LENGTH,
  MAX_RECEIPT_BATCH,
  PROTOCOL_VERSION,
  createEnvelope,
  filterDmForSelf,
  isOversized,
  isWithinFreshnessWindow,
  markSeen,
  parseEnvelope,
  shouldProcess,
  validateReceipt,
  type Envelope,
} from '../src/lib/p2p/protocol'

function validChat(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: '11111111-1111-4111-8111-111111111111',
    ts: 1_760_000_000_000,
    from: 'peer-a',
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola mundo',
    ...overrides,
  }
}

describe('parseEnvelope (spec §7.2/§7.3)', () => {
  it('accepts and normalizes a valid chat envelope, dropping unknown fields', () => {
    const parsed = parseEnvelope({
      ...validChat(),
      unexpected: 'ignored per §7.3',
    })
    expect(parsed).toEqual(validChat())
    expect(Object.keys(parsed as object)).not.toContain('unexpected')
  })

  it('ignores silently anything with v ≠ 1', () => {
    expect(parseEnvelope(validChat({ v: 0 }))).toBeNull()
    expect(parseEnvelope(validChat({ v: 2 }))).toBeNull()
    expect(parseEnvelope(validChat({ v: '1' as unknown as number }))).toBeNull()
    expect(parseEnvelope(validChat({ v: null as unknown as number }))).toBeNull()
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('rejects bad ids', () => {
    expect(parseEnvelope(validChat({ id: '' }))).toBeNull()
    expect(parseEnvelope({ ...validChat(), id: undefined })).toBeNull()
    expect(parseEnvelope(validChat({ id: 42 as unknown as string }))).toBeNull()
  })

  it('rejects bad timestamps', () => {
    expect(parseEnvelope(validChat({ ts: 'x' as unknown as number }))).toBeNull()
    expect(parseEnvelope(validChat({ ts: Number.NaN }))).toBeNull()
    expect(parseEnvelope(validChat({ ts: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(parseEnvelope({ ...validChat(), ts: undefined })).toBeNull()
  })

  it('rejects bad from/nick', () => {
    expect(parseEnvelope(validChat({ from: '' }))).toBeNull()
    expect(parseEnvelope({ ...validChat(), from: undefined })).toBeNull()
    expect(parseEnvelope(validChat({ nick: 7 as unknown as string }))).toBeNull()
    // Empty nick is a valid (if weird) string.
    expect(parseEnvelope(validChat({ nick: '' }))?.nick).toBe('')
  })

  it('rejects unknown kinds and enforces to iff kind dm', () => {
    expect(
      parseEnvelope(validChat({ kind: 'system' as unknown as 'chat' })),
    ).toBeNull()

    const dm = { ...validChat(), kind: 'dm' as const, to: 'peer-b', body: 'secret' }
    expect(parseEnvelope(dm)).toEqual(dm)

    expect(parseEnvelope({ ...dm, to: undefined })).toBeNull()
    expect(parseEnvelope({ ...dm, to: '' })).toBeNull()
  })

  it('drops the to field from chat envelopes (broadcast semantics)', () => {
    const parsed = parseEnvelope(validChat({ to: 'peer-b' }))
    expect(parsed).toEqual(validChat())
    expect(parsed?.to).toBeUndefined()
  })

  it('enforces the 4000-char plaintext cap, ciphertext exempt', () => {
    expect(parseEnvelope(validChat({ body: 'a'.repeat(4000) }))?.body).toHaveLength(
      4000,
    )
    expect(parseEnvelope(validChat({ body: 'a'.repeat(MAX_PLAINTEXT_LENGTH + 1) }))).toBeNull()

    // With enc the body is base64(IV ‖ ct) — only the 64 KB payload cap applies.
    const longCipher = validChat({ enc: true, iv: 'AAAA', body: 'a'.repeat(90_000) })
    expect(parseEnvelope(longCipher)).not.toBeNull()
  })

  it('validates enc and iv shapes', () => {
    expect(parseEnvelope(validChat({ enc: 'no' as unknown as boolean }))).toBeNull()
    expect(parseEnvelope(validChat({ iv: 5 as unknown as string }))).toBeNull()
    // Missing enc/iv default to false/null.
    const bare = validChat()
    delete (bare as Partial<Envelope>).enc
    delete (bare as Partial<Envelope>).iv
    expect(parseEnvelope(bare)).toEqual(validChat())
  })

  it('rejects non-object payloads', () => {
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope('chat')).toBeNull()
    expect(parseEnvelope(42)).toBeNull()
    expect(parseEnvelope([validChat()])).toBeNull()
    expect(parseEnvelope(undefined)).toBeNull()
  })
})

describe('createEnvelope', () => {
  it('builds a valid envelope with fresh id/timestamp', () => {
    const before = Date.now()
    const envelope = createEnvelope({
      from: 'self-id',
      nick: 'yo',
      kind: 'chat',
      body: 'prueba',
    })
    const after = Date.now()
    expect(parseEnvelope(envelope)).toEqual(envelope)
    expect(envelope.v).toBe(1)
    expect(envelope.ts).toBeGreaterThanOrEqual(before)
    expect(envelope.ts).toBeLessThanOrEqual(after)
    expect(envelope.enc).toBe(false)
    expect(envelope.iv).toBeNull()
    expect(envelope.to).toBeUndefined()
  })

  it('keeps fresh ids across calls (dedup key)', () => {
    const a = createEnvelope({ from: 'x', nick: 'n', kind: 'chat', body: '1' })
    const b = createEnvelope({ from: 'x', nick: 'n', kind: 'chat', body: '2' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('dedup helpers (spec §7.3)', () => {
  it('markSeen records the id once', () => {
    const seen = new Set<string>()
    expect(markSeen(seen, 'id-1')).toBe(true)
    expect(markSeen(seen, 'id-1')).toBe(false)
    expect(markSeen(seen, 'id-2')).toBe(true)
    expect(seen.has('id-1')).toBe(true)
  })

  it('shouldProcess gates in-window envelopes through the seen set', () => {
    const seen = new Set<string>()
    // Issue #19 — must be fresh: shouldProcess now also enforces the
    // freshness window (tested in its own suite below).
    const envelope = validChat({ ts: Date.now() })
    expect(shouldProcess(envelope, seen)).toBe(true)
    expect(shouldProcess(envelope, seen)).toBe(false) // full-mesh duplicate
    expect(seen.size).toBe(1)
  })
})

describe('freshness window (issue #19: replay protection)', () => {
  const NOW = 1_800_000_000_000

  it('pins the window constants: 5 min past, 90 s future', () => {
    expect(MAX_ENVELOPE_AGE_MS).toBe(300_000)
    expect(MAX_CLOCK_SKEW_MS).toBe(90_000)
  })

  it('accepts timestamps up to the window edges around the clock', () => {
    expect(isWithinFreshnessWindow(NOW, NOW)).toBe(true)
    expect(isWithinFreshnessWindow(NOW - MAX_ENVELOPE_AGE_MS, NOW)).toBe(true)
    expect(isWithinFreshnessWindow(NOW + MAX_CLOCK_SKEW_MS, NOW)).toBe(true)
  })

  it('rejects stale and over-skewed future timestamps', () => {
    expect(isWithinFreshnessWindow(NOW - MAX_ENVELOPE_AGE_MS - 1, NOW)).toBe(false)
    expect(isWithinFreshnessWindow(NOW + MAX_CLOCK_SKEW_MS + 1, NOW)).toBe(false)
    expect(isWithinFreshnessWindow(0, NOW)).toBe(false)
  })

  describe('shouldProcess gating (fake clock)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('still accepts and dedups in-window envelopes', () => {
      const seen = new Set<string>()
      const envelope = validChat({ ts: NOW - 1_000 })
      expect(shouldProcess(envelope, seen)).toBe(true)
      expect(shouldProcess(envelope, seen)).toBe(false)
      expect(seen.size).toBe(1)
    })

    it('discards stale envelopes without consuming the dedup id', () => {
      const seen = new Set<string>()
      const stale = validChat({ ts: NOW - MAX_ENVELOPE_AGE_MS - 1 })
      expect(shouldProcess(stale, seen)).toBe(false)
      // Zero side effects: freshness runs BEFORE markSeen, so a later
      // in-window copy of the same id is not blocked by the rejected one.
      expect(seen.size).toBe(0)
      expect(shouldProcess({ ...stale, ts: NOW }, seen)).toBe(true)
    })

    it('discards future-dated envelopes beyond the skew tolerance', () => {
      const seen = new Set<string>()
      const future = validChat({ ts: NOW + MAX_CLOCK_SKEW_MS + 1 })
      expect(shouldProcess(future, seen)).toBe(false)
      expect(seen.size).toBe(0)
    })

    it('keeps boundary envelopes just inside both edges', () => {
      expect(shouldProcess(validChat({ ts: NOW - MAX_ENVELOPE_AGE_MS }), new Set())).toBe(true)
      expect(
        shouldProcess(validChat({ id: '22222222-2222-4222-8222-222222222222', ts: NOW + MAX_CLOCK_SKEW_MS }), new Set()),
      ).toBe(true)
    })
  })
})

describe('isOversized (spec §7.3: 64 KB binary cap)', () => {
  it('discards only payloads above 64 KB', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(64 * 1024)
    expect(isOversized(MAX_PAYLOAD_BYTES)).toBe(false)
    expect(isOversized(MAX_PAYLOAD_BYTES + 1)).toBe(true)
    expect(isOversized(0)).toBe(false)
  })
})

describe('filterDmForSelf (spec §7.3: no relay)', () => {
  const dmForMe = { ...validChat(), kind: 'dm' as const, to: 'self-id' }
  const dmForOther = { ...validChat(), kind: 'dm' as const, to: 'peer-b' }

  it('keeps dms addressed to us', () => {
    expect(filterDmForSelf(dmForMe, 'self-id')).toEqual(dmForMe)
  })

  it('discards foreign dms', () => {
    expect(filterDmForSelf(dmForOther, 'self-id')).toBeNull()
  })

  it('discards envelopes without a to field (chat)', () => {
    expect(filterDmForSelf(validChat(), 'self-id')).toBeNull()
  })
})

describe('validateReceipt (spec §7.1: batch ≤ 50)', () => {
  it('accepts batches up to 50 non-empty string ids', () => {
    expect(validateReceipt({ ids: ['a'] })).toBe(true)
    const fifty = { ids: Array.from({ length: MAX_RECEIPT_BATCH }, (_, i) => `id-${i}`) }
    expect(validateReceipt(fifty)).toBe(true)
  })

  it('rejects oversized, empty or malformed batches', () => {
    const fiftyOne = { ids: Array.from({ length: MAX_RECEIPT_BATCH + 1 }, (_, i) => `id-${i}`) }
    expect(validateReceipt(fiftyOne)).toBe(false)
    expect(validateReceipt({ ids: [] })).toBe(false)
    expect(validateReceipt({ ids: ['a', 42] })).toBe(false)
    expect(validateReceipt({ ids: ['a', ''] })).toBe(false)
    expect(validateReceipt({})).toBe(false)
    expect(validateReceipt({ ids: 'a' })).toBe(false)
    expect(validateReceipt(null)).toBe(false)
    expect(validateReceipt('ids')).toBe(false)
  })
})
