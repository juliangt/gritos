import { describe, expect, it } from 'vitest'
import {
  disambiguatedNickname,
  generateNickname,
  isValidNickname,
  normalizeNickname,
  NICKNAME_ADJECTIVES,
  NICKNAME_ERROR_TEXT,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  NICKNAME_NOUNS,
  sanitizeRemoteNick,
} from '../src/lib/nickname'

/** Generated shape: lowercase sustantivo-adjetivo, es charset, one hyphen. */
const GENERATED_PATTERN = /^[a-záéíóúñü]+-[a-záéíóúñü]+$/

describe('generateNickname (RF-01)', () => {
  it('produces valid sustantivo-adjetivo nicknames', () => {
    for (let i = 0; i < 200; i += 1) {
      const nickname = generateNickname()
      expect(nickname).toMatch(GENERATED_PATTERN)
      expect(isValidNickname(nickname)).toBe(true)
    }
  })

  it('never repeats the immediately previous draw', () => {
    let previous = generateNickname()
    for (let i = 0; i < 300; i += 1) {
      const next = generateNickname()
      expect(next).not.toBe(previous)
      previous = next
    }
  })

  it('draws from curated ~60-entry lists with the es charset', () => {
    expect(NICKNAME_NOUNS.length).toBeGreaterThanOrEqual(60)
    expect(NICKNAME_ADJECTIVES.length).toBeGreaterThanOrEqual(60)
    for (const word of [...NICKNAME_NOUNS, ...NICKNAME_ADJECTIVES]) {
      expect(word).toMatch(/^[a-záéíóúñü]+$/)
    }
  })

  it('combines at least a thousand distinct nicknames', () => {
    const distinct = new Set<string>()
    for (const noun of NICKNAME_NOUNS) {
      for (const adjective of NICKNAME_ADJECTIVES) {
        distinct.add(`${noun}-${adjective}`)
      }
    }
    expect(distinct.size).toBeGreaterThan(1000)
  })
})

describe('isValidNickname (RF-01: 2–24, letters/numbers/space/hyphen/underscore)', () => {
  it('accepts the length boundaries: 2 ok, 1 no, 25 no', () => {
    expect(isValidNickname('ab')).toBe(true) // 2
    expect(isValidNickname('a')).toBe(false) // 1
    expect(isValidNickname('a'.repeat(25))).toBe(false) // 25
    expect(isValidNickname('a'.repeat(NICKNAME_MAX_LENGTH))).toBe(true)
  })

  it('accepts the allowed charset', () => {
    expect(isValidNickname('zorro-bravo')).toBe(true)
    expect(isValidNickname('luna cauta')).toBe(true)
    expect(isValidNickname('torre_9')).toBe(true)
    expect(isValidNickname('bufón-si')).toBe(true) // accents allowed
    expect(isValidNickname('NIÑO-99')).toBe(true) // case-insensitive charset
  })

  it('rejects forbidden characters and empty input', () => {
    expect(isValidNickname('')).toBe(false)
    expect(isValidNickname('   ')).toBe(false)
    expect(isValidNickname('zorro!')).toBe(false)
    expect(isValidNickname('zorro.bravo')).toBe(false)
    expect(isValidNickname('zorro@bravo')).toBe(false)
    expect(isValidNickname('ñandú🐦')).toBe(false)
  })

  it('validates the normalized form: trims and collapses spaces', () => {
    expect(isValidNickname('  zorro   bravo ')).toBe(true)
    // After collapsing, '  a  ' normalizes to 'a' (length 1 → invalid).
    expect(isValidNickname('  a  ')).toBe(false)
    expect(normalizeNickname('  zorro   bravo ')).toBe('zorro bravo')
    expect(normalizeNickname('   ')).toBe('')
  })

  it('keeps the constants consistent with the spec', () => {
    expect(NICKNAME_MIN_LENGTH).toBe(2)
    expect(NICKNAME_MAX_LENGTH).toBe(24)
    expect(NICKNAME_ERROR_TEXT).toContain('2 to 24')
  })
})

describe('sanitizeRemoteNick (issue #28: boundary sanitizer for remote nicks)', () => {
  it('strips Cc control characters (\\x00-\\x1f, \\x7f-\\x9f)', () => {
    expect(sanitizeRemoteNick('zo\rro\tbravo\n')).toBe('zorobravo')
    expect(sanitizeRemoteNick('lu\x00na\x1f-ca\x7futa')).toBe('luna-cauta')
  })

  it('strips zero-width and bidi-override invisibles', () => {
    expect(sanitizeRemoteNick('zo\u200bro\u200dbo')).toBe('zorobo')
    expect(sanitizeRemoteNick('luna\u202ecauta')).toBe('lunacauta')
    expect(sanitizeRemoteNick('pon\u00adga\u2060me')).toBe('pongame')
  })

  it('trims surrounding whitespace after stripping', () => {
    expect(sanitizeRemoteNick('  luna-cauta  ')).toBe('luna-cauta')
    expect(sanitizeRemoteNick('\u0000 zorro \u0000')).toBe('zorro')
  })

  it('caps the length at NICKNAME_MAX_LENGTH instead of rejecting', () => {
    const oversized = 'a'.repeat(NICKNAME_MAX_LENGTH * 10)
    const sanitized = sanitizeRemoteNick(oversized)
    expect(sanitized).toHaveLength(NICKNAME_MAX_LENGTH)
    expect(oversized.startsWith(sanitized as string)).toBe(true)
  })

  it('returns null when nothing legible remains', () => {
    expect(sanitizeRemoteNick('')).toBeNull()
    expect(sanitizeRemoteNick('   ')).toBeNull()
    expect(sanitizeRemoteNick('\u0000\u001f\u200b\u202e\u00ad')).toBeNull()
  })

  it('does not enforce the local charset: other scripts pass through', () => {
    expect(sanitizeRemoteNick(' EventEmitter ')).toBe('EventEmitter')
    expect(sanitizeRemoteNick('漢字テスト')).toBe('漢字テスト')
    expect(sanitizeRemoteNick('Ñandú grande')).toBe('Ñandú grande')
  })
})

describe('disambiguatedNickname (RF-06 duplicates)', () => {
  const peers = [
    { id: 'peer-aaaa3f1', nickname: 'zorro-bravo' },
    { id: 'peer-bbbb9c2', nickname: 'zorro-bravo' },
    { id: 'peer-cccc111', nickname: 'luna-cauta' },
  ]

  it('suffices duplicates with a short peerId suffix', () => {
    expect(disambiguatedNickname('zorro-bravo', 'peer-aaaa3f1', peers)).toBe('zorro-bravo·a3f1')
    expect(disambiguatedNickname('zorro-bravo', 'peer-bbbb9c2', peers)).toBe('zorro-bravo·b9c2')
  })

  it('leaves unique nicknames untouched', () => {
    expect(disambiguatedNickname('luna-cauta', 'peer-cccc111', peers)).toBe('luna-cauta')
  })

  it('uses the last 4 chars of the peerId as the suffix', () => {
    const duplicated = [
      { id: 'abcdef1234', nickname: 'x' },
      { id: 'zzzz9876', nickname: 'x' },
    ]
    expect(disambiguatedNickname('x', 'abcdef1234', duplicated)).toBe('x·1234')
  })
})
