// @vitest-environment jsdom
import './dom-setup'
import { describe, expect, it } from 'vitest'
import { ROOM_HASH_PARAM, buildRoomLink, clearRoomHash, parseRoomHash } from '../src/lib/shareLinks'

/**
 * Issue #41 — room deep links: the hash carries only the (RF-02 normalized)
 * room name; anything else (foreign hash, junk, password-ish params) parses
 * to null. The builder composes origin + path + '#sala=<encoded>'.
 */

describe('parseRoomHash', () => {
  it('parses a valid linked room name', () => {
    expect(parseRoomHash('#sala=mi-sala')).toBe('mi-sala')
    expect(parseRoomHash('#sala=lobby')).toBe('lobby')
  })

  it('accepts the raw hash without the leading # (defensive)', () => {
    expect(parseRoomHash('sala=dev')).toBe('dev')
  })

  it('applies the join normalization: encoded spaces and casing', () => {
    expect(parseRoomHash('#sala=mi%20sala')).toBe('mi-sala')
    expect(parseRoomHash('#sala=Mi%20Sala')).toBe('mi-sala')
    expect(parseRoomHash('#sala=MI-SALA')).toBe('mi-sala')
  })

  it('returns null for an empty or missing hash', () => {
    expect(parseRoomHash('')).toBeNull()
    expect(parseRoomHash(null)).toBeNull()
    expect(parseRoomHash(undefined)).toBeNull()
    expect(parseRoomHash('#')).toBeNull()
  })

  it('returns null for a foreign hash parameter', () => {
    expect(parseRoomHash('#otro=valor')).toBeNull()
    expect(parseRoomHash('#salon=x')).toBeNull()
  })

  it('returns null for an empty room value', () => {
    expect(parseRoomHash('#sala=')).toBeNull()
  })

  it('returns null for a name that fails the join validation rules', () => {
    expect(parseRoomHash('#sala=!!')).toBeNull()
    expect(parseRoomHash('#sala=mi.sala')).toBeNull()
    expect(parseRoomHash(`#sala=${'a'.repeat(33)}`)).toBeNull()
  })

  it('rejects password-ish junk smuggled into the hash', () => {
    // Unencoded separator: the decoded name fails the pattern.
    expect(parseRoomHash('#sala=abc&password=x')).toBeNull()
    // Encoded separator: same outcome.
    expect(parseRoomHash('#sala=abc%26password=x')).toBeNull()
    expect(parseRoomHash('#sala=abc%23contrasena')).toBeNull()
  })

  it('returns null on malformed percent-encoding instead of throwing', () => {
    expect(parseRoomHash('#sala=%E0%A4%A')).toBeNull()
  })
})

describe('buildRoomLink', () => {
  it('composes origin + pathname + #sala=<name>', () => {
    expect(buildRoomLink('mi-sala')).toBe(
      `${window.location.origin}${window.location.pathname}#sala=mi-sala`,
    )
  })

  it('encodes the name (the hash is always a valid single parameter)', () => {
    expect(buildRoomLink('mi sala')).toContain('#sala=mi%20sala')
    expect(buildRoomLink('dev')).toContain('#sala=dev')
  })

  it('round-trips through the parser', () => {
    for (const name of ['lobby', 'mi-sala', 'dev', 'random_1']) {
      const link = buildRoomLink(name)
      expect(link.startsWith(window.location.origin)).toBe(true)
      expect(parseRoomHash(new URL(link).hash)).toBe(name)
    }
  })

  it('never includes the password in the signature', () => {
    expect(ROOM_HASH_PARAM).toBe('sala=')
    expect(buildRoomLink('secreta')).not.toContain('password')
  })
})

describe('clearRoomHash', () => {
  it('removes the hash while keeping path and search (?debug survives)', () => {
    window.history.pushState({}, '', '/?debug')
    window.history.pushState({}, '', '/?debug#sala=mi-sala')

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
