import { describe, expect, it } from 'vitest'
import { deriveRoomId } from '../src/lib/crypto/hashes'
import {
  KNOCK_RATE_CAP,
  MAX_SIGNAL_PRESENCE,
  NOTE_MAX_LENGTH,
  SIGNAL_ROOM_NAME,
  deriveSignalRoomId,
  parseKnock,
  parseKnockAck,
  parseWhoami,
} from '../src/lib/p2p/signalChannelConstants'

/**
 * Issue #105 phase 1 (spec §12.5) — the signal-channel constants and the
 * pure payload validators that later phases must consume unchanged:
 *
 *  1. the well-known swarm name and its derived roomId (deterministic,
 *     room-shaped, and distinct from every joinable room id),
 *  2. the cap constants the spec pins (presence 100 LRU, 5 knocks/min/peer,
 *     notes ≤ 140),
 *  3. the parseKnock / parseWhoami / parseKnockAck matrices — the
 *     parseReact/parseHistReq discipline (§12.4): any violation drops the
 *     WHOLE payload, canonical fingerprints and sanitized nicks only.
 */

const FP = 'A31F09BC77D24E5A51C0FFEE12345678'
const FP_SPACED = 'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678'
const FP_LOWER = 'a31f09bc77d24e5a51c0ffee12345678'

describe('signal channel constants (spec §12.5)', () => {
  it('pins the well-known swarm name literally', () => {
    expect(SIGNAL_ROOM_NAME).toBe('_gritos/senal/v1')
    // '/' is outside the RF-02 join charset ([a-z0-9_-]): the name can
    // never be typed into the join popover — only the manager joins it.
    expect(SIGNAL_ROOM_NAME).toContain('/')
  })

  it('pins the cap constants the spec documents', () => {
    expect(NOTE_MAX_LENGTH).toBe(140)
    expect(MAX_SIGNAL_PRESENCE).toBe(100)
    expect(KNOCK_RATE_CAP).toBe(5)
  })
})

describe('deriveSignalRoomId (spec §9.4/§12.5)', () => {
  it('derives a room-shaped id (32 lowercase hex chars)', async () => {
    const id = await deriveSignalRoomId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic and equals the derivation from the constant', async () => {
    const [a, b, viaConstant] = await Promise.all([
      deriveSignalRoomId(),
      deriveSignalRoomId(),
      deriveRoomId(SIGNAL_ROOM_NAME),
    ])
    expect(a).toBe(b)
    expect(a).toBe(viaConstant)
  })

  it('differs from the id of any joinable room (name or password derivation)', async () => {
    const signalId = await deriveSignalRoomId()
    const names = ['lobby', 'general', 'dev', 'random', 'mi-sala', 'test', 'senal', 'gritos']
    const roomIds = await Promise.all([
      ...names.map((name) => deriveRoomId(name)),
      deriveRoomId('_gritos/senal/v1', 'password'),
      deriveRoomId('lobby', 'lobby'),
    ])
    for (const roomId of roomIds) {
      expect(roomId).not.toBe(signalId)
    }
  })
})

describe('parseKnock (spec §12.5)', () => {
  const validKnock = () => ({
    type: 'knock',
    from: { fp: FP_SPACED, nick: 'luna-cauta' },
  })

  it('accepts a valid knock and canonicalizes the fingerprint', () => {
    expect(parseKnock(validKnock())).toEqual({
      type: 'knock',
      from: { fp: FP, nick: 'luna-cauta' },
    })
  })

  it('accepts a lowercase fingerprint and uppercases it (canonical form)', () => {
    const parsed = parseKnock({ ...validKnock(), from: { fp: FP_LOWER, nick: 'luna' } })
    expect(parsed?.from.fp).toBe(FP)
  })

  it('accepts an optional note within the cap', () => {
    const parsed = parseKnock({ ...validKnock(), note: 'hola, somos del club' })
    expect(parsed?.note).toBe('hola, somos del club')
    const atCap = parseKnock({ ...validKnock(), note: 'a'.repeat(NOTE_MAX_LENGTH) })
    expect(atCap?.note).toBe('a'.repeat(NOTE_MAX_LENGTH))
  })

  it('drops unknown extra fields (normalized copy)', () => {
    const parsed = parseKnock({ ...validKnock(), content: 'smuggled', extra: 1 })
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed as object)).not.toContain('content')
    expect(Object.keys(parsed as object)).not.toContain('extra')
  })

  it('rejects a missing or wrong type discriminator', () => {
    expect(parseKnock({ from: { fp: FP, nick: 'luna' } })).toBeNull()
    expect(parseKnock({ ...validKnock(), type: 'knoc' })).toBeNull()
    expect(parseKnock({ ...validKnock(), type: 7 })).toBeNull()
  })

  it('rejects a missing or malformed from object', () => {
    expect(parseKnock({ type: 'knock' })).toBeNull()
    expect(parseKnock({ type: 'knock', from: 'luna' })).toBeNull()
    expect(parseKnock({ type: 'knock', from: null })).toBeNull()
  })

  it('rejects malformed fingerprints (short, non-hex, wrong type)', () => {
    expect(parseKnock({ type: 'knock', from: { fp: 'A31F', nick: 'luna' } })).toBeNull()
    expect(
      parseKnock({ type: 'knock', from: { fp: `${FP.slice(0, 31)}G`, nick: 'luna' } }),
    ).toBeNull()
    expect(parseKnock({ type: 'knock', from: { fp: 42, nick: 'luna' } })).toBeNull()
  })

  it('rejects a nick that sanitizes to nothing legible (it IS the consent card)', () => {
    expect(parseKnock({ type: 'knock', from: { fp: FP, nick: '' } })).toBeNull()
    expect(parseKnock({ type: 'knock', from: { fp: FP, nick: '\u200b\u00ad' } })).toBeNull()
    expect(parseKnock({ type: 'knock', from: { fp: FP } })).toBeNull()
    expect(parseKnock({ type: 'knock', from: { fp: FP, nick: 42 } })).toBeNull()
  })

  it('sanitizes the nick at the boundary (issue #28 class, capped)', () => {
    const parsed = parseKnock({ type: 'knock', from: { fp: FP, nick: ' luna\u200b-cauta ' } })
    expect(parsed?.from.nick).toBe('luna-cauta')
    const capped = parseKnock({ type: 'knock', from: { fp: FP, nick: 'n'.repeat(99) } })
    expect(capped?.from.nick).toBe('n'.repeat(24))
  })

  it('rejects an oversize note whole (never truncates)', () => {
    const parsed = parseKnock({ ...validKnock(), note: 'a'.repeat(NOTE_MAX_LENGTH + 1) })
    expect(parsed).toBeNull()
  })

  it('rejects a non-string note', () => {
    expect(parseKnock({ ...validKnock(), note: 42 })).toBeNull()
    expect(parseKnock({ ...validKnock(), note: null })).toBeNull()
  })

  it('treats a note sanitizing to empty as absent', () => {
    const parsed = parseKnock({ ...validKnock(), note: ' \u200b ' })
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('note')
  })

  it('strips control/invisible characters from the note (issue #28 class)', () => {
    const parsed = parseKnock({ ...validKnock(), note: 'hola\u0000 mundo' })
    expect(parsed?.note).toBe('hola mundo')
  })

  it('rejects non-object payloads', () => {
    expect(parseKnock(null)).toBeNull()
    expect(parseKnock('knock')).toBeNull()
    expect(parseKnock([validKnock()])).toBeNull()
  })
})

describe('parseWhoami (spec §12.5)', () => {
  it('accepts a valid presence payload and canonicalizes it', () => {
    expect(parseWhoami({ nick: 'zorro-bravo', fp: FP_SPACED })).toEqual({
      nick: 'zorro-bravo',
      fp: FP,
    })
  })

  it('drops unknown extra fields', () => {
    const parsed = parseWhoami({ nick: 'zorro', fp: FP, status: 'busy' })
    expect(parsed).toEqual({ nick: 'zorro', fp: FP })
  })

  it('rejects malformed fingerprints', () => {
    expect(parseWhoami({ nick: 'zorro', fp: 'nope' })).toBeNull()
    expect(parseWhoami({ nick: 'zorro' })).toBeNull()
  })

  it('rejects a nick that sanitizes to nothing (no peerId-prefix fallback rows)', () => {
    expect(parseWhoami({ nick: '', fp: FP })).toBeNull()
    expect(parseWhoami({ nick: '\u202e', fp: FP })).toBeNull()
    expect(parseWhoami({ fp: FP })).toBeNull()
  })

  it('rejects non-object payloads', () => {
    expect(parseWhoami(null)).toBeNull()
    expect(parseWhoami('whoami')).toBeNull()
  })
})

describe('parseKnockAck (spec §12.5)', () => {
  it('accepts accept:true with the acknowledged knocker fingerprint', () => {
    expect(parseKnockAck({ accept: true, fp: FP_SPACED })).toEqual({ accept: true, fp: FP })
  })

  it('accepts accept:false (a rejection is still a valid ack)', () => {
    expect(parseKnockAck({ accept: false, fp: FP_LOWER })).toEqual({ accept: false, fp: FP })
  })

  it('rejects a missing or non-boolean accept (no default)', () => {
    expect(parseKnockAck({ fp: FP })).toBeNull()
    expect(parseKnockAck({ accept: 'true', fp: FP })).toBeNull()
    expect(parseKnockAck({ accept: 1, fp: FP })).toBeNull()
  })

  it('rejects a malformed or missing acknowledged fingerprint', () => {
    expect(parseKnockAck({ accept: true })).toBeNull()
    expect(parseKnockAck({ accept: true, fp: '1234' })).toBeNull()
  })

  it('rejects non-object payloads', () => {
    expect(parseKnockAck(null)).toBeNull()
    expect(parseKnockAck([true, FP])).toBeNull()
  })
})
