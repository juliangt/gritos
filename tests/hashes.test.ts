import { describe, expect, it } from 'vitest'
import {
  ROOM_HASH_PREFIX,
  ROOM_ID_LENGTH,
  deriveRoomId,
  newMessageId,
  sha256Hex,
} from '../src/lib/crypto/hashes'

/**
 * Test vectors computed once from the spec §9.4 formula and verified
 * independently (shasum -a 256):
 *   roomId = hex(SHA-256('gritos/room/v1/' + name [+ NUL + password]))[0..31]
 */
const ROOM_ID_LENGTH_OK = /^[0-9a-f]{32}$/

describe('deriveRoomId (spec §9.4)', () => {
  it('matches the hardcoded spec vectors', async () => {
    await expect(deriveRoomId('lobby')).resolves.toBe(
      'fc069e4f5294ed227989c780ef61697c',
    )
    await expect(deriveRoomId('lobby', 'secret')).resolves.toBe(
      'da9f56e0867b6c3c0ef85dee61a03060',
    )
    await expect(deriveRoomId('test-room')).resolves.toBe(
      'a406c56047e9d2f57b705da5f2e1d0f1',
    )
  })

  it('is deterministic with and without password', async () => {
    await expect(deriveRoomId('general')).resolves.toBe(
      await deriveRoomId('general'),
    )
    await expect(deriveRoomId('general', 'pw')).resolves.toBe(
      await deriveRoomId('general', 'pw'),
    )
  })

  it('changes the id when a password is present', async () => {
    const plain = await deriveRoomId('lobby')
    const withPassword = await deriveRoomId('lobby', 'secret')
    expect(withPassword).not.toBe(plain)
    // Even an empty password goes through the NUL-separated path.
    expect(await deriveRoomId('lobby', '')).not.toBe(plain)
    expect(await deriveRoomId('lobby', 'a')).not.toBe(
      await deriveRoomId('lobby', 'b'),
    )
  })

  it('keeps the salt/format stable: 32 lowercase hex chars', async () => {
    const id = await deriveRoomId('random')
    expect(id).toMatch(ROOM_ID_LENGTH_OK)
    expect(id).toHaveLength(ROOM_ID_LENGTH)
    expect(ROOM_HASH_PREFIX).toBe('gritos/room/v1/')
  })

  it('has no collisions between similar names', async () => {
    const ids = await Promise.all(
      ['lobby', 'lobbi', 'Lobby', ' lobby', 'lobby ', 'lobb', 'lobbyy'].map(
        (name) => deriveRoomId(name),
      ),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches a manual SHA-256 reference computation', async () => {
    const id = await deriveRoomId('dev')
    // node: printf 'gritos/room/v1/dev' | shasum -a 256 → 06f96c86...
    expect(id).toBe('06f96c86b8149a94cba7fcb3f621965f')
  })

  it('separates name and password with a NUL byte (no ambiguity)', async () => {
    // 'lobby\u0000secret' must differ from a hypothetical name 'lobbysecret'
    // and from name 'lobby' + password '' vs name 'lobby' + password 'x'.
    const a = await deriveRoomId('lobby', 'secret')
    const b = await deriveRoomId('lobbysecret')
    expect(a).not.toBe(b)
    expect(await deriveRoomId('lobby', '')).not.toBe(await deriveRoomId('lobby', 'x'))
    // Vector for the empty-name room, pinned for format stability.
    await expect(deriveRoomId('')).resolves.toBe(
      'fffbb52e8ae1720976d80f77211a3992',
    )
  })
})

describe('sha256Hex', () => {
  it('hashes strings to lowercase hex (FIPS vectors)', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes bytes identically to the equivalent string', async () => {
    const bytes = new TextEncoder().encode('gritos')
    await expect(sha256Hex(bytes)).resolves.toBe(await sha256Hex('gritos'))
  })
})

describe('newMessageId (spec §7.2)', () => {
  it('generates unique uuids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newMessageId()))
    expect(ids.size).toBe(1000)
    expect(newMessageId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
