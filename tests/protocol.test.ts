import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NICKNAME_MAX_LENGTH } from '../src/lib/nickname'
import {
  BoundedSeenIds,
  DM_PROTOCOL_VERSION,
  MAX_CLOCK_SKEW_MS,
  MAX_ENCRYPTED_BODY_CHARS,
  MAX_ENVELOPE_AGE_MS,
  MAX_HISTORY_BATCH,
  MAX_HISTORY_BATCH_BYTES,
  MAX_HISTORY_REQUEST,
  MAX_MESSAGE_TTL_S,
  MAX_PAYLOAD_BYTES,
  MAX_PLAINTEXT_LENGTH,
  MAX_REACT_BATCH,
  MAX_RECEIPT_BATCH,
  MIN_MESSAGE_TTL_S,
  PROTOCOL_VERSION,
  REACT_EMOJIS,
  SEEN_IDS_CAP,
  chunkHistBatches,
  createEnvelope,
  filterDmForSelf,
  isOversized,
  isWithinFreshnessWindow,
  isWithinFutureSkew,
  markSeen,
  parseEnvelope,
  parseHistBatch,
  parseHistReq,
  parseReact,
  reactSeenKey,
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

  it('ignores silently versions outside {1, 2} and malformed v values', () => {
    expect(parseEnvelope(validChat({ v: 0 }))).toBeNull()
    expect(parseEnvelope(validChat({ v: '1' as unknown as number }))).toBeNull()
    expect(parseEnvelope(validChat({ v: null as unknown as number }))).toBeNull()
    expect(PROTOCOL_VERSION).toBe(1)
    expect(DM_PROTOCOL_VERSION).toBe(2)
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

  it('sanitizes an oversized remote nick instead of trusting it (issue #28)', () => {
    const oversized = validChat({ nick: 'x'.repeat(4000) })
    const parsed = parseEnvelope(oversized)
    expect(parsed).not.toBeNull()
    expect(parsed?.body).toBe('hola mundo') // body accepted untouched
    expect(parsed?.nick).toHaveLength(24)
    expect(NICKNAME_MAX_LENGTH).toBe(24)
  })

  it('strips control and invisible characters from a remote nick (issue #28)', () => {
    const parsed = parseEnvelope(validChat({ nick: 'lu\x00na\u200b-\u202eca\x1futa' }))
    expect(parsed?.nick).toBe('luna-cauta')
  })

  it('keeps the empty-nick convention when nothing legible remains (issue #28)', () => {
    // The caller falls back to the peerId-prefix display for ''.
    expect(parseEnvelope(validChat({ nick: '\u0000\u200b\u202e' }))?.nick).toBe('')
  })

  it('rejects unknown kinds and enforces to iff kind dm', () => {
    expect(parseEnvelope(validChat({ kind: 'system' as unknown as 'chat' }))).toBeNull()

    // Since phase 4 (issue #93) a dm must carry v2.
    const dm = {
      ...validChat(),
      v: DM_PROTOCOL_VERSION,
      kind: 'dm' as const,
      to: 'peer-b',
      body: 'secret',
    }
    expect(parseEnvelope(dm)).toEqual(dm)

    expect(parseEnvelope({ ...dm, to: undefined })).toBeNull()
    expect(parseEnvelope({ ...dm, to: '' })).toBeNull()
  })

  it('drops the to field from chat envelopes (broadcast semantics)', () => {
    const parsed = parseEnvelope(validChat({ to: 'peer-b' }))
    expect(parsed).toEqual(validChat())
    expect(parsed?.to).toBeUndefined()
  })

  it('enforces the 4000-char plaintext cap on unencrypted bodies', () => {
    expect(parseEnvelope(validChat({ body: 'a'.repeat(4000) }))?.body).toHaveLength(4000)
    expect(parseEnvelope(validChat({ body: 'a'.repeat(MAX_PLAINTEXT_LENGTH + 1) }))).toBeNull()
  })

  it('enforces the encrypted-body cap before any decode (issue #21)', () => {
    // 128x-style headroom over the honest worst case: a 4000-char plaintext
    // of 1-byte chars seals to 4028 B (IV + ct + tag) → 5372 base64 chars.
    expect(MAX_ENCRYPTED_BODY_CHARS).toBe(16_384)
    expect(Math.ceil((MAX_PLAINTEXT_LENGTH + 16 + 12) / 3) * 4).toBeLessThan(
      MAX_ENCRYPTED_BODY_CHARS,
    )

    // Up to the cap the ciphertext body is exempt from the plaintext cap.
    const atCap = validChat({ enc: true, iv: 'AAAA', body: 'a'.repeat(MAX_ENCRYPTED_BODY_CHARS) })
    expect(parseEnvelope(atCap)).not.toBeNull()
    expect(parseEnvelope({ ...atCap, body: 'a'.repeat(MAX_ENCRYPTED_BODY_CHARS + 1) })).toBeNull()

    // A transport-sized body (e.g. 100 KB) is discarded with zero decode
    // work — the rejection happens before atob could ever run.
    const atobSpy = vi.spyOn(globalThis, 'atob')
    try {
      const bomb = validChat({ enc: true, iv: 'AAAA', body: 'a'.repeat(100_000) })
      expect(parseEnvelope(bomb)).toBeNull()
      expect(atobSpy).not.toHaveBeenCalled()
    } finally {
      atobSpy.mockRestore()
    }
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

describe('per-action envelope versions (issue #93, spec §12.1 — final rule)', () => {
  it('accepts a v1 chat and rejects a v2 chat (v2 is dm-only)', () => {
    expect(parseEnvelope(validChat())?.v).toBe(1)
    expect(parseEnvelope(validChat({ v: DM_PROTOCOL_VERSION }))).toBeNull()
  })

  it('rejects a v1 dm (v2-only since phase 4) and accepts a v2 dm', () => {
    const dmV1 = { ...validChat(), kind: 'dm' as const, to: 'peer-b', body: 'legacy' }
    const dmV2 = { ...dmV1, v: DM_PROTOCOL_VERSION, id: '22222222-2222-4222-8222-222222222222' }
    // Final rule (issue #93 phase 4, spec §12.1): DMs are sealed with
    // session-ephemeral keys only v2 peers announce (`ephkeys`), so a v1 dm
    // is dropped silently — the accepted mixed-version degradation, the
    // mirror image of v1 peers dropping our v2 dms.
    expect(parseEnvelope(dmV1)).toBeNull()
    expect(parseEnvelope(dmV2)).toEqual(dmV2)
    expect(parseEnvelope(dmV2)?.v).toBe(2)
  })

  it('rejects a v3 dm (silence per §7.3)', () => {
    const dmV3 = { ...validChat(), kind: 'dm' as const, to: 'peer-b', v: 3 }
    expect(parseEnvelope(dmV3)).toBeNull()
  })

  it('the normalized envelope preserves the ACTUAL accepted version', () => {
    const dmV2 = { ...validChat(), kind: 'dm' as const, to: 'peer-b', v: 2 }
    expect(parseEnvelope(dmV2)?.v).toBe(2)
    expect(parseEnvelope(validChat({ v: 1 }))?.v).toBe(1)
  })

  it('createEnvelope defaults to v1 and passes an explicit v through', () => {
    const legacy = createEnvelope({ from: 'x', nick: 'n', kind: 'dm', to: 'p', body: 'b' })
    expect(legacy.v).toBe(PROTOCOL_VERSION)

    const v2 = createEnvelope({
      from: 'x',
      nick: 'n',
      kind: 'dm',
      to: 'p',
      body: 'b',
      v: DM_PROTOCOL_VERSION,
    })
    expect(v2.v).toBe(DM_PROTOCOL_VERSION)
    expect(parseEnvelope(v2)).toEqual(v2)
  })
})

describe('message TTL (issue #96: additive field, NO version bump)', () => {
  function dmV2(overrides: Partial<Envelope> = {}): Envelope {
    return {
      ...validChat(),
      v: DM_PROTOCOL_VERSION,
      kind: 'dm',
      to: 'peer-b',
      body: 'secreto',
      ...overrides,
    }
  }

  it('keeps an envelope without ttl untouched (session-lived default)', () => {
    const parsed = parseEnvelope(validChat())
    expect(parsed?.ttl).toBeUndefined()
    // "Absent stays absent": the field never enters the normalized copy.
    expect(Object.keys(parsed as object)).not.toContain('ttl')
  })

  it('accepts and preserves integer ttls inside the inclusive bounds', () => {
    expect(MIN_MESSAGE_TTL_S).toBe(30)
    expect(MAX_MESSAGE_TTL_S).toBe(3600)
    expect(parseEnvelope(validChat({ ttl: MIN_MESSAGE_TTL_S }))?.ttl).toBe(30)
    expect(parseEnvelope(validChat({ ttl: 300 }))?.ttl).toBe(300)
    expect(parseEnvelope(validChat({ ttl: MAX_MESSAGE_TTL_S }))?.ttl).toBe(3600)

    // A valid ttl survives the normalized copy (only known fields), like
    // every other known field.
    const parsed = parseEnvelope({ ...validChat({ ttl: 45 }), unexpected: 'x' })
    expect(parsed).toEqual(validChat({ ttl: 45 }))
    expect(Object.keys(parsed as object)).not.toContain('unexpected')
  })

  it('drops the WHOLE envelope on an out-of-range, non-integer or non-number ttl', () => {
    expect(parseEnvelope(validChat({ ttl: 0 }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: -30 }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: MIN_MESSAGE_TTL_S - 1 }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: MAX_MESSAGE_TTL_S + 1 }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: 30.5 }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: Number.NaN }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: '30' as unknown as number }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: null as unknown as number }))).toBeNull()
    expect(parseEnvelope(validChat({ ttl: true as unknown as number }))).toBeNull()
  })

  it('test guard — TTL messages ship at the CURRENT per-kind version', () => {
    // No v bump: a ttl-bearing chat is v1 and a ttl-bearing dm is v2. Old
    // builds drop the unknown field silently and keep the message for the
    // session — the documented mixed-version degradation (§7.3).
    expect(parseEnvelope(validChat({ ttl: 30 }))?.v).toBe(PROTOCOL_VERSION)
    const dm = parseEnvelope(dmV2({ ttl: 60 }))
    expect(dm?.v).toBe(DM_PROTOCOL_VERSION)
    expect(dm?.ttl).toBe(60)
  })

  it('mixed-version simulation — old-shape parse keeps working, new-shape keeps ttl', () => {
    // An OLD build's envelope object (no ttl field): the current parser
    // accepts it exactly as before, no ttl in the copy.
    const parsedOld = parseEnvelope(validChat())
    expect(parsedOld).toEqual(validChat())
    expect(parsedOld?.ttl).toBeUndefined()

    // The same message from a NEW build: ttl survives and `v` stays
    // per-kind (1 for chat).
    const newShape = validChat({ ttl: 300 })
    const parsedNew = parseEnvelope(newShape)
    expect(parsedNew).toEqual(newShape)
    expect(parsedNew?.v).toBe(1)
  })

  it('createEnvelope leaves ttl off unless asked, and round-trips it when set', () => {
    const plain = createEnvelope({ from: 'x', nick: 'n', kind: 'chat', body: 'b' })
    // Default wire form byte-identical to pre-TTL builds: no ttl key.
    expect(Object.keys(plain)).not.toContain('ttl')

    const timed = createEnvelope({ from: 'x', nick: 'n', kind: 'chat', body: 'b', ttl: 120 })
    expect(timed.ttl).toBe(120)
    expect(parseEnvelope(timed)).toEqual(timed)
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

describe('BoundedSeenIds (issue #20: bounded dedup window)', () => {
  it('pins the cap constant at 10 000 entries', () => {
    expect(SEEN_IDS_CAP).toBe(10_000)
    expect(new BoundedSeenIds().cap).toBe(SEEN_IDS_CAP)
  })

  it('dedups like a Set while below the cap', () => {
    const seen = new BoundedSeenIds()
    expect(markSeen(seen, 'id-1')).toBe(true)
    expect(markSeen(seen, 'id-1')).toBe(false)
    expect(markSeen(seen, 'id-2')).toBe(true)
    expect(seen.has('id-1')).toBe(true)
    expect(seen.size).toBe(2)
    seen.clear()
    expect(seen.has('id-1')).toBe(false)
    expect(seen.size).toBe(0)
  })

  it('evicts the OLDEST entry first (FIFO) beyond the cap', () => {
    const seen = new BoundedSeenIds(4)
    for (let i = 0; i < 6; i += 1) {
      expect(markSeen(seen, `id-${i}`)).toBe(true)
    }
    expect(seen.size).toBe(4)
    expect(seen.has('id-0')).toBe(false) // evicted first
    expect(seen.has('id-1')).toBe(false)
    expect(seen.has('id-2')).toBe(true) // oldest survivor
    expect(seen.has('id-5')).toBe(true) // newest retained

    // Accepted semantics of a bounded window: a re-seen evicted id is
    // treated as unseen again (it may surface once more); the freshness
    // window (issue #19) still bounds any replay to 5 minutes.
    expect(markSeen(seen, 'id-0')).toBe(true)
    expect(seen.size).toBe(4)
    expect(seen.has('id-0')).toBe(true)
    expect(seen.has('id-2')).toBe(false) // now the oldest, evicted by id-0
  })

  it('keeps the default-cap set bounded: 10 001 unique ids stay at 10 000', () => {
    const seen = new BoundedSeenIds()
    for (let i = 0; i < SEEN_IDS_CAP + 1; i += 1) {
      markSeen(seen, `id-${i}`)
    }
    expect(seen.size).toBe(SEEN_IDS_CAP)
    expect(seen.has('id-0')).toBe(false)
    expect(seen.has('id-1')).toBe(true)
    expect(seen.has(`id-${SEEN_IDS_CAP}`)).toBe(true)
  })

  it('survives a 50k unique-id flood through shouldProcess within the cap', () => {
    const seen = new BoundedSeenIds()
    let allProcessed = true
    let maxSize = 0
    for (let i = 0; i < 50_000; i += 1) {
      if (!shouldProcess(validChat({ id: `flood-${i}`, ts: Date.now() }), seen)) {
        allProcessed = false
      }
      if (seen.size > maxSize) maxSize = seen.size
    }
    expect(allProcessed).toBe(true)
    expect(maxSize).toBeLessThanOrEqual(SEEN_IDS_CAP)
    expect(seen.size).toBe(SEEN_IDS_CAP)
    expect(seen.has('flood-0')).toBe(false)
    expect(seen.has('flood-49999')).toBe(true)
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
        shouldProcess(
          validChat({ id: '22222222-2222-4222-8222-222222222222', ts: NOW + MAX_CLOCK_SKEW_MS }),
          new Set(),
        ),
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

// ---------------------------------------------------------------------------
// Issue #98 — emoji reactions (phase 1): whitelist, payload validation,
// replay dedup key
// ---------------------------------------------------------------------------

function reactPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ids: ['m-1'], emo: '👍', on: true, ...overrides }
}

describe('REACT_EMOJIS (issue #98: the canonical whitelist)', () => {
  it('is exactly the seven proposed emoji', () => {
    expect([...REACT_EMOJIS]).toEqual(['👍', '❤️', '😂', '😮', '😢', '🎉', '👎'])
  })
})

describe('parseReact (issue #98, spec §7.1/§9.5: cosmetic class, drop-whole)', () => {
  it('accepts and normalizes a valid payload', () => {
    expect(parseReact(reactPayload())).toEqual({ ids: ['m-1'], emo: '👍', on: true })
  })

  it('accepts every whitelisted emoji', () => {
    for (const emo of REACT_EMOJIS) {
      expect(parseReact(reactPayload({ emo }))).toEqual({ ids: ['m-1'], emo, on: true })
    }
  })

  it('drops a non-whitelisted or non-string emo whole', () => {
    expect(parseReact(reactPayload({ emo: '🚀' }))).toBeNull()
    expect(parseReact(reactPayload({ emo: 'like' }))).toBeNull()
    expect(parseReact(reactPayload({ emo: '' }))).toBeNull()
    expect(parseReact(reactPayload({ emo: 7 }))).toBeNull()
    expect(parseReact(reactPayload({ emo: undefined }))).toBeNull()
  })

  it('requires on to be a boolean', () => {
    expect(parseReact(reactPayload({ on: false }))).toEqual({ ids: ['m-1'], emo: '👍', on: false })
    expect(parseReact(reactPayload({ on: 'true' }))).toBeNull()
    expect(parseReact(reactPayload({ on: 1 }))).toBeNull()
    expect(parseReact(reactPayload({ on: null }))).toBeNull()
    expect(parseReact(reactPayload({ on: undefined }))).toBeNull()
  })

  it('accepts batches of 1..MAX_REACT_BATCH non-empty string ids', () => {
    const fifty = Array.from({ length: MAX_REACT_BATCH }, (_, i) => `id-${i}`)
    expect(parseReact(reactPayload({ ids: fifty }))?.ids).toEqual(fifty)
  })

  it('drops oversized, empty or malformed id batches whole', () => {
    const fiftyOne = Array.from({ length: MAX_REACT_BATCH + 1 }, (_, i) => `id-${i}`)
    expect(parseReact(reactPayload({ ids: fiftyOne }))).toBeNull()
    expect(parseReact(reactPayload({ ids: [] }))).toBeNull()
    expect(parseReact(reactPayload({ ids: 'm-1' }))).toBeNull()
    expect(parseReact(reactPayload({ ids: ['m-1', 42] }))).toBeNull()
    expect(parseReact(reactPayload({ ids: ['m-1', ''] }))).toBeNull()
    expect(parseReact(reactPayload({ ids: null }))).toBeNull()
  })

  it('dedups ids keeping first-occurrence order', () => {
    expect(parseReact(reactPayload({ ids: ['b', 'a', 'b', 'c', 'a'] }))?.ids).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('keeps a valid directed `to` and drops a malformed one whole', () => {
    expect(parseReact(reactPayload({ to: 'peer-9' }))).toEqual({
      ids: ['m-1'],
      emo: '👍',
      on: true,
      to: 'peer-9',
    })
    expect(parseReact(reactPayload({ to: '' }))).toBeNull()
    expect(parseReact(reactPayload({ to: 42 }))).toBeNull()
    expect(parseReact(reactPayload({ to: null }))).toBeNull()
  })

  it('drops non-object payloads', () => {
    expect(parseReact(null)).toBeNull()
    expect(parseReact('react')).toBeNull()
    expect(parseReact(['m-1'])).toBeNull()
  })
})

describe('reactSeenKey (issue #98: content-keyed replay dedup)', () => {
  it('keys identical payloads identically', () => {
    const first = reactSeenKey(parseReact(reactPayload())!)
    const second = reactSeenKey(parseReact(reactPayload())!)
    expect(first).toBe(second)
  })

  it('keys directed payloads apart from broadcasts with the same ids', () => {
    const broadcast = reactSeenKey(parseReact(reactPayload())!)
    const directed = reactSeenKey(parseReact(reactPayload({ to: 'peer-9' }))!)
    expect(directed).not.toBe(broadcast)
  })

  it('keys the inverse toggle apart so toggles survive dedup', () => {
    const on = reactSeenKey(parseReact(reactPayload({ on: true }))!)
    const off = reactSeenKey(parseReact(reactPayload({ on: false }))!)
    expect(off).not.toBe(on)
  })

  it('keys different emo or id sets apart', () => {
    const base = reactSeenKey(parseReact(reactPayload())!)
    expect(reactSeenKey(parseReact(reactPayload({ emo: '🎉' }))!)).not.toBe(base)
    expect(reactSeenKey(parseReact(reactPayload({ ids: ['m-2'] }))!)).not.toBe(base)
    expect(reactSeenKey(parseReact(reactPayload({ ids: ['m-1', 'm-2'] }))!)).not.toBe(base)
  })

  it('never collides with the envelope-id namespace of the shared seen set', () => {
    expect(reactSeenKey(parseReact(reactPayload())!)).toMatch(/^react:/)
  })
})

// ---------------------------------------------------------------------------
// Issue #102 — history gossip (phase 1): request validation, batch
// validation, the replay-path skew bound and the sender-side chunking math.
// ---------------------------------------------------------------------------

describe('history gossip bounds (issue #102, §7.1)', () => {
  it('pins the constants: 50 per request/share, 20 per batch, 48 KiB margin', () => {
    expect(MAX_HISTORY_REQUEST).toBe(50)
    expect(MAX_HISTORY_BATCH).toBe(20)
    expect(MAX_HISTORY_BATCH_BYTES).toBe(48 * 1024)
    // The margin is real: an at-margin batch can never trip the 64 KB
    // transport discard after chunk reassembly.
    expect(MAX_HISTORY_BATCH_BYTES).toBeLessThan(MAX_PAYLOAD_BYTES)
    // The count cap alone cannot guarantee the fit: 20 envelopes of the
    // honest maximum (4000-char body + envelope overhead) exceed 64 KB —
    // hence the measured-size rule.
    const fat = validChat({ body: 'a'.repeat(MAX_PLAINTEXT_LENGTH) })
    expect(
      JSON.stringify({ batch: Array.from({ length: MAX_HISTORY_BATCH }, () => fat) }).length,
    ).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })
})

describe('parseHistReq (issue #102, §7.1)', () => {
  it('accepts integer n within [1, 50]', () => {
    expect(parseHistReq({ n: 1 })).toEqual({ n: 1 })
    expect(parseHistReq({ n: 25 })).toEqual({ n: 25 })
    expect(parseHistReq({ n: MAX_HISTORY_REQUEST })).toEqual({ n: MAX_HISTORY_REQUEST })
  })

  it('drops out-of-bounds, fractional and malformed n silently', () => {
    expect(parseHistReq({ n: 0 })).toBeNull()
    expect(parseHistReq({ n: -1 })).toBeNull()
    expect(parseHistReq({ n: MAX_HISTORY_REQUEST + 1 })).toBeNull()
    expect(parseHistReq({ n: 2.5 })).toBeNull()
    expect(parseHistReq({ n: Number.NaN })).toBeNull()
    expect(parseHistReq({ n: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseHistReq({ n: '5' })).toBeNull()
    expect(parseHistReq({ n: null })).toBeNull()
    expect(parseHistReq({})).toBeNull()
    expect(parseHistReq({ n: 5, unexpected: 'ignored-but-valid-n' })).toEqual({ n: 5 })
  })

  it('drops non-object payloads', () => {
    expect(parseHistReq(null)).toBeNull()
    expect(parseHistReq('50')).toBeNull()
    expect(parseHistReq(50)).toBeNull()
    expect(parseHistReq([50])).toBeNull()
    expect(parseHistReq(undefined)).toBeNull()
  })
})

describe('parseHistBatch (issue #102, §7.1: shape checks kept, chat-only)', () => {
  it('accepts and normalizes a valid batch (unknown fields dropped)', () => {
    const parsed = parseHistBatch({
      batch: [{ ...validChat(), unexpected: 'ignored per §7.3' }, validChat({ id: 'id-2' })],
    })
    expect(parsed).toEqual([validChat(), validChat({ id: 'id-2' })])
  })

  it('accepts a single-envelope batch at both count edges', () => {
    expect(parseHistBatch({ batch: [validChat()] })).toEqual([validChat()])
    const twenty = Array.from({ length: MAX_HISTORY_BATCH }, (_, i) => validChat({ id: `id-${i}` }))
    expect(parseHistBatch({ batch: twenty })).toEqual(twenty)
  })

  it('drops empty and over-cap batches whole', () => {
    expect(parseHistBatch({ batch: [] })).toBeNull()
    expect(
      parseHistBatch({
        batch: Array.from({ length: MAX_HISTORY_BATCH + 1 }, (_, i) =>
          validChat({ id: `id-${i}` }),
        ),
      }),
    ).toBeNull()
    expect(parseHistBatch({ batch: 'chat' })).toBeNull()
    expect(parseHistBatch({})).toBeNull()
  })

  it('drops the WHOLE batch when one envelope fails parseEnvelope', () => {
    const good = validChat({ id: 'id-good' })
    expect(parseHistBatch({ batch: [good, validChat({ id: '' })] })).toBeNull()
    expect(parseHistBatch({ batch: [good, { ...good, v: 3 }] })).toBeNull()
    expect(parseHistBatch({ batch: [good, { ...good, ts: Number.NaN }] })).toBeNull()
    expect(parseHistBatch({ batch: [good, null] })).toBeNull()
  })

  it('drops the WHOLE batch on a non-chat envelope — DMs are never gossiped', () => {
    const good = validChat({ id: 'id-good' })
    const dmV2 = {
      ...validChat(),
      id: 'id-dm',
      v: DM_PROTOCOL_VERSION,
      kind: 'dm' as const,
      to: 'peer-b',
    }
    // A structurally valid dm is still a protocol violation in a batch.
    expect(parseHistBatch({ batch: [good, dmV2] })).toBeNull()
    // A v2 chat is dropped by parseEnvelope's per-kind gate anyway.
    expect(parseHistBatch({ batch: [good, { ...good, v: DM_PROTOCOL_VERSION }] })).toBeNull()
  })

  it('drops non-object payloads', () => {
    expect(parseHistBatch(null)).toBeNull()
    expect(parseHistBatch('batch')).toBeNull()
    expect(parseHistBatch([validChat()])).toBeNull()
    expect(parseHistBatch(undefined)).toBeNull()
  })
})

describe('isWithinFutureSkew (issue #102: the freshness bound the replay path keeps)', () => {
  const NOW = 1_800_000_000_000

  it('admits up to MAX_CLOCK_SKEW_MS into the future, rejects beyond', () => {
    expect(isWithinFutureSkew(NOW, NOW)).toBe(true)
    expect(isWithinFutureSkew(NOW + MAX_CLOCK_SKEW_MS, NOW)).toBe(true)
    expect(isWithinFutureSkew(NOW + MAX_CLOCK_SKEW_MS + 1, NOW)).toBe(false)
  })

  it('has NO age bound — day-old timestamps pass, unlike the live window', () => {
    expect(isWithinFutureSkew(NOW - MAX_ENVELOPE_AGE_MS - 1, NOW)).toBe(true)
    expect(isWithinFutureSkew(NOW - 24 * 60 * 60 * 1000, NOW)).toBe(true)
    // The contrast that justifies the separate helper: the live path drops
    // the same stamps.
    expect(isWithinFreshnessWindow(NOW - MAX_ENVELOPE_AGE_MS - 1, NOW)).toBe(false)
  })
})

describe('chunkHistBatches (issue #102: sender-side size-margin chunking)', () => {
  function encodedBytes(batch: Envelope[]): number {
    return new TextEncoder().encode(JSON.stringify({ batch })).byteLength
  }

  it('splits 50 small envelopes by count: 20 / 20 / 10, in order', () => {
    const fifty = Array.from({ length: MAX_HISTORY_REQUEST }, (_, i) =>
      validChat({ id: `id-${i}` }),
    )
    const batches = chunkHistBatches(fifty)
    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 10])
    expect(batches.flat()).toEqual(fifty)
    for (const batch of batches) {
      expect(encodedBytes(batch)).toBeLessThanOrEqual(MAX_HISTORY_BATCH_BYTES)
    }
  })

  it('chunks by encoded size before the count cap when bodies are fat', () => {
    // 13 envelopes of the 4000-char maximum: ~53 KB total, so a single
    // count-batch of 13 would be over the margin — size must split first.
    const fat = Array.from({ length: 13 }, (_, i) =>
      validChat({ id: `id-${i}`, body: 'a'.repeat(MAX_PLAINTEXT_LENGTH) }),
    )
    const batches = chunkHistBatches(fat)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(fat)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_HISTORY_BATCH)
      expect(encodedBytes(batch)).toBeLessThanOrEqual(MAX_HISTORY_BATCH_BYTES)
      // Honest max bodies can never exceed the margin one envelope at a
      // time, so every batch is non-empty.
      expect(batch.length).toBeGreaterThan(0)
    }
  })

  it('drops an envelope whose own encoding exceeds the margin (defense)', () => {
    // Unreachable for parseEnvelope-valid input (body caps), pinned as
    // defense against future cap drift.
    const fat = validChat({ id: 'id-fat', body: 'a'.repeat(50_000) })
    const small = validChat({ id: 'id-small' })
    const batches = chunkHistBatches([fat, small])
    expect(batches).toEqual([[small]])
  })

  it('returns no batches for empty input', () => {
    expect(chunkHistBatches([])).toEqual([])
  })
})
