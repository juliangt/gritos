// @vitest-environment jsdom
import './dom-setup'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_HASH_PARAM,
  ROOM_HASH_PARAM,
  buildContactLink,
  buildRoomLink,
  clearRoomHash,
  parseContactHash,
  parseRoomHash,
} from '../src/lib/shareLinks'

/**
 * Issue #41 — room deep links: the hash carries only the (RF-02 normalized)
 * room name; anything else (foreign hash, junk, password-ish params) parses
 * to null. The builder composes origin + path + '#room=<encoded>'.
 *
 * Issue #105 (spec §12.5) — contact deep links: the same discipline with
 * `#contact=<fp>`; the value must canonicalize to exactly 32 hex chars
 * (issue #95 rule — spaced display forms accepted) and only the CANONICAL
 * form routes. English hash params per issue #121.
 */

describe('parseRoomHash', () => {
  it('parses a valid linked room name', () => {
    expect(parseRoomHash('#room=my-room')).toBe('my-room')
    expect(parseRoomHash('#room=lobby')).toBe('lobby')
  })

  it('accepts the raw hash without the leading # (defensive)', () => {
    expect(parseRoomHash('room=dev')).toBe('dev')
  })

  it('applies the join normalization: encoded spaces and casing', () => {
    expect(parseRoomHash('#room=my%20room')).toBe('my-room')
    expect(parseRoomHash('#room=My%20Room')).toBe('my-room')
    expect(parseRoomHash('#room=MY-ROOM')).toBe('my-room')
  })

  it('returns null for an empty or missing hash', () => {
    expect(parseRoomHash('')).toBeNull()
    expect(parseRoomHash(null)).toBeNull()
    expect(parseRoomHash(undefined)).toBeNull()
    expect(parseRoomHash('#')).toBeNull()
  })

  it('returns null for a foreign hash parameter', () => {
    expect(parseRoomHash('#other=value')).toBeNull()
    expect(parseRoomHash('#rooms=x')).toBeNull()
  })

  it('returns null for an empty room value', () => {
    expect(parseRoomHash('#room=')).toBeNull()
  })

  it('returns null for a name that fails the join validation rules', () => {
    expect(parseRoomHash('#room=!!')).toBeNull()
    expect(parseRoomHash('#room=my.room')).toBeNull()
    expect(parseRoomHash(`#room=${'a'.repeat(33)}`)).toBeNull()
  })

  it('rejects password-ish junk smuggled into the hash', () => {
    // Unencoded separator: the decoded name fails the pattern.
    expect(parseRoomHash('#room=abc&password=x')).toBeNull()
    // Encoded separator: same outcome.
    expect(parseRoomHash('#room=abc%26password=x')).toBeNull()
    expect(parseRoomHash('#room=abc%23password')).toBeNull()
  })

  it('returns null on malformed percent-encoding instead of throwing', () => {
    expect(parseRoomHash('#room=%E0%A4%A')).toBeNull()
  })
})

describe('buildRoomLink', () => {
  it('composes origin + pathname + #room=<name>', () => {
    expect(buildRoomLink('my-room')).toBe(
      `${window.location.origin}${window.location.pathname}#room=my-room`,
    )
  })

  it('encodes the name (the hash is always a valid single parameter)', () => {
    expect(buildRoomLink('my room')).toContain('#room=my%20room')
    expect(buildRoomLink('dev')).toContain('#room=dev')
  })

  it('round-trips through the parser', () => {
    for (const name of ['lobby', 'my-room', 'dev', 'random_1']) {
      const link = buildRoomLink(name)
      expect(link.startsWith(window.location.origin)).toBe(true)
      expect(parseRoomHash(new URL(link).hash)).toBe(name)
    }
  })

  it('never includes the password in the signature', () => {
    expect(ROOM_HASH_PARAM).toBe('room=')
    expect(buildRoomLink('secret')).not.toContain('password')
  })
})

describe('clearRoomHash', () => {
  it('removes the hash while keeping path and search (?debug survives)', () => {
    window.history.pushState({}, '', '/?debug')
    window.history.pushState({}, '', '/?debug#room=my-room')

    clearRoomHash()

    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?debug')

    window.history.pushState({}, '', '/')
  })

  it('is a no-op without a hash', () => {
    window.history.pushState({}, '', '/')
    clearRoomHash()
    expect(window.location.hash).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Issue #105 phase 3 — `#contact=<fp>`
// ---------------------------------------------------------------------------

const DISPLAY_FP = 'A31F 09BC 77D2 4E5A 0F1E 2D3C 4B5A 6978'
const CANONICAL_FP = 'A31F09BC77D24E5A0F1E2D3C4B5A6978'

describe('parseContactHash (issue #105, spec §12.5)', () => {
  it('parses a canonical fingerprint, canonicalizing display forms', () => {
    expect(parseContactHash(`#contact=${CANONICAL_FP}`)).toBe(CANONICAL_FP)
    expect(parseContactHash(`#contact=${encodeURIComponent(DISPLAY_FP)}`)).toBe(CANONICAL_FP)
    // Lowercase hex and raw (unencoded) spaces are tolerated too.
    expect(parseContactHash('#contact=a31f09bc77d24e5a0f1e2d3c4b5a6978')).toBe(CANONICAL_FP)
    expect(parseContactHash(`contact=${DISPLAY_FP}`)).toBe(CANONICAL_FP)
  })

  it('returns null for an empty or missing hash', () => {
    expect(parseContactHash('')).toBeNull()
    expect(parseContactHash(null)).toBeNull()
    expect(parseContactHash(undefined)).toBeNull()
    expect(parseContactHash('#contact=')).toBeNull()
  })

  it('returns null for a foreign hash parameter', () => {
    expect(parseContactHash('#room=lobby')).toBeNull()
    expect(parseContactHash('#contacts=abc')).toBeNull()
  })

  it('returns null for a value that does not canonicalize to 32 hex', () => {
    expect(parseContactHash('#contact=nope')).toBeNull()
    expect(parseContactHash('#contact=A31F09BC77D24E5A')).toBeNull() // 16 hex
    expect(parseContactHash('#contact=zz1F09BC77D24E5A0F1E2D3C4B5A6978')).toBeNull()
    expect(parseContactHash(`#contact=${'A'.repeat(33)}`)).toBeNull()
  })

  it('returns null on malformed percent-encoding instead of throwing', () => {
    expect(parseContactHash('#contact=%E0%A4%A')).toBeNull()
  })
})

describe('buildContactLink (issue #105, spec §12.5)', () => {
  it('composes origin + pathname + #contact=<canonical fp>', () => {
    expect(buildContactLink(DISPLAY_FP)).toBe(
      `${window.location.origin}${window.location.pathname}#contact=${CANONICAL_FP}`,
    )
  })

  it('round-trips through the parser and never leaks the spaced form', () => {
    const link = buildContactLink(DISPLAY_FP)
    expect(link).not.toContain(' ')
    expect(parseContactHash(new URL(link).hash)).toBe(CANONICAL_FP)
    expect(CONTACT_HASH_PARAM).toBe('contact=')
  })
})
