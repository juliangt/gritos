import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import * as files from '../src/lib/p2p/fileTransfer'
import type { FileMeta, SendFileOutcome } from '../src/lib/p2p/fileTransfer'
import { useAppStore } from '../src/stores/useAppStore'
import { clearDmKeyCache, deriveDmKeyV2 } from '../src/lib/crypto/dm'
import { computeFingerprint } from '../src/lib/crypto/identity'
import { openChunk, sealChunk } from '../src/lib/crypto/chunkCipher'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'
import { panicWipe } from '../src/lib/panic'

/**
 * Issue #103 phase 3 (spec §12.4) — the file-transfer engine, driven end to
 * end over the fake Trystero pair: the manager under test plays ONE endpoint
 * (receiver in the `deliverFileFromA` helper, sender in `driveManagerSender`)
 * and the suite plays the counterparty peer A over the fake room's action
 * records/injections — real AES-GCM sealing both ways (room key, DM key v2
 * and cleartext), so the byte-exact assembly assertions go through the real
 * `sealChunk`/`openChunk` path.
 */

const PASSWORD = 'piedra-papel'
const SECRET_ROOM = 'secreta'
const PUBLIC_ROOM = 'lobby'

let fake: ReturnType<typeof installFakeTrystero>
let A: FakeRemotePeer

// ---------------------------------------------------------------------------
// URL.createObjectURL/revokeObjectURL: Node 22 has the real ones, but the
// only way back from a URL is fetch (blob: URLs are undici-unsupported), so
// the stubs keep a registry the assertions can read the Blob back from.
// ---------------------------------------------------------------------------

const blobRegistry = new Map<string, Blob>()
const revokedUrls: string[] = []
let objectUrlCounter = 0
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(async () => {
  fake = installFakeTrystero()
  clearDmKeyCache()
  A = await makeFakeRemotePeer('peer-a')
  revokedUrls.length = 0
  blobRegistry.clear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob): string => {
      objectUrlCounter += 1
      const url = `blob:fake-${objectUrlCounter}`
      blobRegistry.set(url, blob)
      return url
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string): void => {
      revokedUrls.push(url)
      blobRegistry.delete(url)
    },
  })
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  if (originalCreate !== undefined) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  if (originalRevoke !== undefined) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
})

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Lets the async fingerprint/crypto tails settle (real timers). */
function flushCrypto(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function lastRoom(): FakeTrysteroRoom {
  const room = fake.rooms[fake.rooms.length - 1]
  if (room === undefined) throw new Error('no fake room joined')
  return room
}

async function joinPasswordRoomWithA(): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(SECRET_ROOM, PASSWORD)
  const room = lastRoom()
  await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
  await flushCrypto()
  return { roomId: connection.roomId, room }
}

async function joinPublicRoomWithA(
  options: { openDm?: boolean } = {},
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(PUBLIC_ROOM)
  const room = lastRoom()
  await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
  await flushCrypto()
  // DM channels open on demand only (open/send/receive, RF-04).
  if (options.openDm === true) manager.openDmChannel(A.id)
  return { roomId: connection.roomId, room }
}

/** The §12.4 frame prefix: first 8 bytes of SHA-256(meta id). */
function fileIdOf(metaId: string) {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(metaId))
    .then((digest) => new Uint8Array(digest).slice(0, 8))
}

function makeFrame(fileId: Uint8Array, seq: number, payload: Uint8Array) {
  const frame = new Uint8Array(12 + payload.length)
  frame.set(fileId, 0)
  new DataView(frame.buffer).setUint32(8, seq, false)
  frame.set(payload, 12)
  return frame
}

function concat(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length)
  let equal = actual.length === expected.length
  for (let i = 0; equal && i < actual.length; i += 1) {
    equal = actual[i] === expected[i]
  }
  expect(equal).toBe(true)
}

function chunkSendsOf(room: FakeTrysteroRoom): { data: unknown }[] {
  return room.action('file-chunk').sends
}

function ackSendsOf(room: FakeTrysteroRoom): { data: unknown }[] {
  return room.action('file-ack').sends
}

/** Fills a Uint8Array with a deterministic pseudo-random pattern. */
function patternBytes(length: number) {
  const bytes = new Uint8Array(length)
  let state = 0x9e3779b9
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    bytes[i] = state & 0xff
  }
  return bytes
}

interface DeliverOptions {
  roomId: string
  room: FakeTrysteroRoom
  bytes: Uint8Array<ArrayBuffer>
  /** Sealing key the SUITE uses (the manager opens with its own resolution). */
  sealKey: CryptoKey | null
  name?: string
  mime?: string
  autoAccept?: boolean
}

/**
 * Full receiver-side round trip: the suite offers `bytes` to the manager as
 * peer A, the manager consents and assembles. Returns the minted URL's
 * bytes, the wire meta and the transfer key.
 */
async function deliverFileFromA(options: DeliverOptions): Promise<{
  assembled: Uint8Array
  url: string
  meta: FileMeta
  transferKey: string
  fileId: Uint8Array
}> {
  const { room, bytes, sealKey } = options
  const id = crypto.randomUUID()
  const chunks = Math.ceil(bytes.length / files.FILE_CHUNK_PAYLOAD_BYTES)
  const meta: FileMeta = {
    id,
    name: options.name ?? 'notas.txt',
    size: bytes.length,
    mime: options.mime ?? 'text/plain',
    chunks,
    enc: sealKey !== null,
  }
  const transferKey = files.transferKeyOf(A.id, id)
  const offered = new Promise<FileMeta>((resolve) => {
    const unsubscribe = files.onFileOffer((_rid, peerId, offeredMeta) => {
      if (peerId === A.id && offeredMeta.id === id) {
        unsubscribe()
        resolve(offeredMeta)
      }
    })
  })

  room.receive('file-meta', meta, A.id)
  const offeredMeta = await offered
  expect(offeredMeta).toEqual(meta)
  const record = files.getFileTransferRecord(transferKey)
  expect(record?.state).toBe('offer')
  expect(record?.transferred).toBe(0)
  // §12.4 — before acceptance not a single byte of control flows either:
  // there is no ack for an offer.
  const acksForThisTransfer = (): { data: unknown }[] =>
    ackSendsOf(room).filter((send) => (send.data as { id: string }).id === id)
  expect(acksForThisTransfer()).toHaveLength(0)

  const doneUrl = new Promise<string | null>((resolve) => {
    const unsubscribe = files.onFileDone((_rid, peerId, doneMeta, url) => {
      if (peerId === A.id && doneMeta.id === id) {
        unsubscribe()
        resolve(url)
      }
    })
  })

  const fileId = await fileIdOf(id)
  if (options.autoAccept !== false) {
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    expect(acksForThisTransfer()[0]?.data).toEqual({ id, nextSeq: 1, grant: 8 })

    for (let seq = 1; seq <= chunks; seq += 1) {
      const plain = bytes.slice(
        (seq - 1) * files.FILE_CHUNK_PAYLOAD_BYTES,
        seq * files.FILE_CHUNK_PAYLOAD_BYTES,
      )
      const payload = sealKey !== null ? await sealChunk(sealKey, plain) : plain
      room.receive('file-chunk', makeFrame(fileId, seq, payload), A.id)
      await tick()
    }

    const url = await doneUrl
    expect(url).not.toBeNull()
    // §12.4 — the final ack: {id, nextSeq: chunks + 1, grant: 0}.
    expect(acksForThisTransfer()[acksForThisTransfer().length - 1]?.data).toEqual({
      id,
      nextSeq: chunks + 1,
      grant: 0,
    })
    const doneRecord = files.getFileTransferRecord(transferKey)
    expect(doneRecord?.state).toBe('done')
    expect(doneRecord?.transferred).toBe(chunks)
    const blob = blobRegistry.get(url as string)
    expect(blob).toBeDefined()
    const assembled = new Uint8Array(await (blob as Blob).arrayBuffer())
    expectBytesEqual(assembled, bytes)
    return { assembled, url: url as string, meta, transferKey, fileId }
  }
  return { assembled: new Uint8Array(0), url: '', meta, transferKey, fileId }
}

interface DriveOptions {
  roomId: string
  room: FakeTrysteroRoom
  bytes: Uint8Array<ArrayBuffer>
  kind: 'room' | 'dm'
  /** A-side opening key (null = expect cleartext chunks). */
  aSideKey: CryptoKey | null
  name?: string
  mime?: string
}

/**
 * Full sender-side round trip: the manager offers and streams, the suite
 * plays the accepting peer (credit-window discipline included) and
 * reassembles the file from the wire chunks.
 */
async function driveManagerSender(
  options: DriveOptions,
): Promise<Extract<SendFileOutcome, { ok: true }>> {
  const { room, roomId, bytes, kind, aSideKey } = options
  const file = new File([bytes], options.name ?? 'archivo.bin', { type: options.mime ?? '' })
  const outcome = await files.sendFileTransfer(roomId, A.id, file, kind)
  if (!outcome.ok) throw new Error(`sendFileTransfer refused: ${outcome.reason}`)
  const meta = room.lastSend('file-meta').data as FileMeta
  expect(meta.id).toBe(outcome.id)
  expect(meta.size).toBe(bytes.length)
  expect(meta.chunks).toBe(Math.ceil(bytes.length / files.FILE_CHUNK_PAYLOAD_BYTES))
  expect(meta.enc).toBe(aSideKey !== null)
  expect(files.getFileTransferRecord(outcome.key)?.state).toBe('offer')

  // Peer A accepts: the first ack IS the acceptance (§12.4).
  room.receive('file-ack', { id: outcome.id, nextSeq: 1, grant: 8 }, A.id)

  const chunks = meta.chunks
  const parts: Uint8Array[] = []
  let received = 0
  while (received < chunks) {
    const target = Math.min(received + 8, chunks)
    // The sender never holds more than FILE_CREDIT_WINDOW unacked chunks:
    // exactly `target` sends exist at this point, no overshoot.
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(target))
    for (let seq = received + 1; seq <= target; seq += 1) {
      const frame = chunkSendsOf(room)[seq - 1]?.data as Uint8Array
      expect(new DataView(frame.buffer).getUint32(8, false)).toBe(seq)
      const payload = frame.subarray(12)
      const plain = aSideKey !== null ? await openChunk(aSideKey, payload) : new Uint8Array(payload)
      parts.push(plain)
    }
    received = target
    if (received < chunks) {
      room.receive('file-ack', { id: outcome.id, nextSeq: received + 1, grant: 8 }, A.id)
    }
  }

  // file-end rides right after the last dispatched chunk (§12.4).
  const endSends = room.action('file-end').sends
  expect(endSends).toHaveLength(1)
  expect(endSends[0]?.data).toEqual({ id: outcome.id })

  // Completion requires the final ack: settled must still be pending.
  const stillPending = await Promise.race([
    outcome.settled.then(() => 'done'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
  ])
  expect(stillPending).toBe('pending')

  room.receive('file-ack', { id: outcome.id, nextSeq: chunks + 1, grant: 0 }, A.id)
  await expect(outcome.settled).resolves.toBe('done')
  expectBytesEqual(concat(parts), bytes)

  const record = files.getFileTransferRecord(outcome.key)
  expect(record?.state).toBe('done')
  expect(record?.transferred).toBe(chunks)
  expect(record?.url).toBeNull() // senders mint no URL
  return outcome
}

/** The suite's own A-side derivation of the v2 DM key (uncached). */
async function deriveASideDmKey(room: FakeTrysteroRoom): Promise<CryptoKey> {
  const myRaw = room.action('keys').sends[0]?.data as Uint8Array
  const myEphRaw = room.action('ephkeys').sends[0]?.data as Uint8Array
  return deriveDmKeyV2(
    A.ephKeypair.privateKey,
    myEphRaw,
    A.fingerprint,
    await computeFingerprint(myRaw),
    A.ephFingerprint,
    await computeFingerprint(myEphRaw),
  )
}

// ---------------------------------------------------------------------------
// parseFileMeta — the §12.4 validation contract
// ---------------------------------------------------------------------------

describe('parseFileMeta (§12.4 contract)', () => {
  const base = {
    id: crypto.randomUUID(),
    size: files.FILE_CHUNK_PAYLOAD_BYTES + 5,
    mime: 'text/plain',
    enc: false,
  }

  it('accepts a valid meta and recomputes chunks from size', () => {
    const meta = files.parseFileMeta({ ...base, name: 'informe.pdf', chunks: 2 })
    expect(meta).toEqual({
      id: base.id,
      name: 'informe.pdf',
      size: base.size,
      mime: 'text/plain',
      chunks: 2,
      enc: false,
    })
  })

  it('rejects a chunks count that drifts from ceil(size / slice)', () => {
    expect(files.parseFileMeta({ ...base, name: 'a.txt', chunks: 1 })).toBeNull()
    expect(files.parseFileMeta({ ...base, name: 'a.txt', chunks: 3 })).toBeNull()
    expect(files.parseFileMeta({ ...base, name: 'a.txt', chunks: 1.5 })).toBeNull()
  })

  it('sanitizes the name with the issue #28 class and the 120-char cap', () => {
    const dirty = `in\u0000for\u200bme${'x'.repeat(150)}.txt`
    const meta = files.parseFileMeta({ ...base, name: dirty, chunks: 2 })
    // The cap slices the sanitized tail: 120 chars, extension and all cut.
    expect(meta?.name).toBe(`informe${'x'.repeat(113)}`)
    expect(meta?.name.length).toBe(files.FILE_NAME_MAX_LENGTH)
  })

  it('rejects a name with nothing legible left (the name is the consent card)', () => {
    expect(files.parseFileMeta({ ...base, name: '\u0000\u200b\u00ad', chunks: 2 })).toBeNull()
    expect(files.parseFileMeta({ ...base, name: '', chunks: 2 })).toBeNull()
  })

  it('rejects out-of-bounds sizes', () => {
    expect(files.parseFileMeta({ ...base, name: 'a', size: 0, chunks: 0 })).toBeNull()
    expect(files.parseFileMeta({ ...base, name: 'a', size: -5, chunks: 0 })).toBeNull()
    expect(
      files.parseFileMeta({ ...base, name: 'a', size: files.MAX_FILE_BYTES + 1, chunks: 1284 }),
    ).toBeNull()
    expect(files.parseFileMeta({ ...base, name: 'a', size: 1.5, chunks: 1 })).toBeNull()
  })

  it('caps the mime at 100 clean characters and allows the empty mime', () => {
    expect(files.parseFileMeta({ ...base, name: 'a', mime: '', chunks: 2 })).not.toBeNull()
    const longMime = 'x'.repeat(101)
    expect(files.parseFileMeta({ ...base, name: 'a', mime: longMime, chunks: 2 })).toBeNull()
    const dirtyMime = 'text/pl\u0000ain'
    const meta = files.parseFileMeta({ ...base, name: 'a', mime: dirtyMime, chunks: 2 })
    expect(meta?.mime).toBe('text/plain')
  })

  it('requires enc as a boolean with no default', () => {
    const { enc: _omitted, ...withoutEnc } = base
    expect(files.parseFileMeta(withoutEnc)).toBeNull()
    expect(files.parseFileMeta({ ...base, name: 'a', chunks: 2, enc: 'yes' })).toBeNull()
  })

  it('rejects non-object payloads and empty ids', () => {
    expect(files.parseFileMeta(null)).toBeNull()
    expect(files.parseFileMeta('meta')).toBeNull()
    expect(files.parseFileMeta([])).toBeNull()
    expect(files.parseFileMeta({ ...base, id: '', name: 'a', chunks: 2 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Sender — local validation and caps before anything hits the wire
// ---------------------------------------------------------------------------

describe('sendFileTransfer — local refusals (nothing on the wire)', () => {
  it('refuses an unknown room, a disconnected room and a foreign peer', async () => {
    const { roomId } = await joinPublicRoomWithA({ openDm: true })
    const file = new File([patternBytes(10)], 'a.txt')
    expect(await files.sendFileTransfer('sala-fantasma', A.id, file, 'room')).toEqual({
      ok: false,
      reason: 'unknown-room',
    })
    expect(await files.sendFileTransfer(roomId, 'peer-fantasma', file, 'room')).toEqual({
      ok: false,
      reason: 'peer-not-in-room',
    })
  })

  it('refuses files over the 20 MB cap and empty files', async () => {
    const { roomId } = await joinPublicRoomWithA({ openDm: true })
    const big = new File([patternBytes(files.MAX_FILE_BYTES + 1)], 'grande.bin')
    expect(await files.sendFileTransfer(roomId, A.id, big, 'room')).toEqual({
      ok: false,
      reason: 'file-too-big',
    })
    const empty = new File([new Uint8Array(0)], 'vacio.bin')
    expect(await files.sendFileTransfer(roomId, A.id, empty, 'room')).toEqual({
      ok: false,
      reason: 'invalid-file',
    })
    expect(fake.rooms[0]?.action('file-meta').sends).toHaveLength(0)
  })

  it('refuses a DM transfer when the DM key is unavailable (never cleartext)', async () => {
    const { roomId } = await joinPublicRoomWithA({ openDm: false })
    const file = new File([patternBytes(10)], 'a.txt')
    // No openDmChannel: the channel is unavailable, resolveTransferKey → null.
    expect(await files.sendFileTransfer(roomId, A.id, file, 'dm')).toEqual({
      ok: false,
      reason: 'dm-key-unavailable',
    })
    expect(fake.rooms[0]?.action('file-meta').sends).toHaveLength(0)
  })

  it('refuses the 4th concurrent transfer per peer (both sides share the cap)', async () => {
    const { roomId } = await joinPublicRoomWithA({ openDm: true })
    const make = (name: string) => new File([patternBytes(10)], name)
    for (let i = 0; i < files.MAX_TRANSFERS_PER_PEER; i += 1) {
      const outcome = await files.sendFileTransfer(roomId, A.id, make(`f${i}.bin`), 'dm')
      expect(outcome.ok).toBe(true)
    }
    expect(await files.sendFileTransfer(roomId, A.id, make('f3.bin'), 'dm')).toEqual({
      ok: false,
      reason: 'concurrency-cap',
    })
  })

  it('sanitizes the outgoing name and mime on the wire, and refuses unusable names', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const dirty = new File([patternBytes(10)], '  in\u0000vis\u200bible.txt  ', {
      type: 'text/pl\u0000ain',
    })
    const outcome = await files.sendFileTransfer(roomId, A.id, dirty, 'dm')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    expect(meta.name).toBe('invisible.txt')
    // The 100-char mime cap trims the sender's own oversized value too.
    expect(meta.mime.length).toBeLessThanOrEqual(files.FILE_MIME_MAX_LENGTH)
    expect(meta.mime).not.toContain('\u0000')

    const unusable = new File([patternBytes(10)], '\u0000\u200b\u00ad')
    expect(await files.sendFileTransfer(roomId, A.id, unusable, 'dm')).toEqual({
      ok: false,
      reason: 'name-required',
    })

    const longMime = new File([patternBytes(10)], 'a.txt', { type: 'x'.repeat(150) })
    const capped = await files.sendFileTransfer(roomId, A.id, longMime, 'dm')
    if (!capped.ok) throw new Error('refused')
    const cappedMeta = room.lastSend('file-meta').data as FileMeta
    expect(cappedMeta.mime).toHaveLength(files.FILE_MIME_MAX_LENGTH)
  })
})

// ---------------------------------------------------------------------------
// Receiver — offer validation, caps, rate
// ---------------------------------------------------------------------------

describe('receiver — offers, caps and rate', () => {
  it('creates the offer record and fires onFileOffer; nothing flows before accept', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const bytes = patternBytes(700) // single chunk
    const id = crypto.randomUUID()
    const meta: FileMeta = {
      id,
      name: 'foto.png',
      size: bytes.length,
      mime: 'image/png',
      chunks: 1,
      enc: false,
    }
    const offered: FileMeta[] = []
    files.onFileOffer((rid, peerId, m) => {
      expect(rid).toBe(roomId)
      expect(peerId).toBe(A.id)
      offered.push(m)
    })
    room.receive('file-meta', meta, A.id)
    await flushCrypto()
    expect(offered).toHaveLength(1)
    const key = files.transferKeyOf(A.id, id)
    expect(files.getFileTransfers()[key]?.state).toBe('offer')
    expect(ackSendsOf(room)).toHaveLength(0)
    expect(chunkSendsOf(room)).toHaveLength(0)
  })

  it('drops invalid metas whole and silently (size, chunks drift, name, mime, enc)', async () => {
    const { room } = await joinPublicRoomWithA()
    const id = crypto.randomUUID()
    const offers: unknown[] = []
    files.onFileOffer((_, __, meta) => offers.push(meta))
    const over: FileMeta = {
      id,
      name: 'grande.bin',
      size: files.MAX_FILE_BYTES + 1,
      mime: '',
      chunks: 1284,
      enc: false,
    }
    room.receive('file-meta', over, A.id)
    room.receive('file-meta', { ...over, size: 100, chunks: 9 }, A.id)
    room.receive('file-meta', { ...over, size: 100, chunks: 1, name: '\u0000' }, A.id)
    room.receive('file-meta', { ...over, size: 100, chunks: 1, mime: 'x'.repeat(101) }, A.id)
    room.receive('file-meta', { ...over, size: 100, chunks: 1, enc: undefined }, A.id)
    await flushCrypto()
    expect(offers).toHaveLength(0)
    expect(Object.keys(files.getFileTransfers())).toHaveLength(0)
    // Not even a rejection: invalid metas are dropped whole (§7.3).
    expect(room.action('file-abort').sends).toHaveLength(0)
  })

  it('answers the 4th concurrent offer per peer with an explicit file-abort', async () => {
    const { room } = await joinPublicRoomWithA()
    const ids: string[] = []
    for (let i = 0; i < files.MAX_TRANSFERS_PER_PEER; i += 1) {
      const id = crypto.randomUUID()
      ids.push(id)
      room.receive(
        'file-meta',
        { id, name: `f${i}.bin`, size: 10, mime: '', chunks: 1, enc: false },
        A.id,
      )
    }
    await flushCrypto()
    expect(Object.keys(files.getFileTransfers())).toHaveLength(3)
    const fourth = crypto.randomUUID()
    room.receive(
      'file-meta',
      { id: fourth, name: 'f3.bin', size: 10, mime: '', chunks: 1, enc: false },
      A.id,
    )
    await flushCrypto()
    expect(Object.keys(files.getFileTransfers())).toHaveLength(3)
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: fourth }, options: { target: A.id } },
    ])
  })

  it('caps incoming offers at 5 per peer per minute, discarding the excess silently', async () => {
    const { room } = await joinPublicRoomWithA()
    vi.useFakeTimers()
    try {
      const offered: string[] = []
      // Each offer is declined on the spot so it frees its concurrency slot
      // (the 3-per-peer cap would otherwise mask the rate cap).
      const unsubscribe = files.onFileOffer((_rid, _peerId, meta) => {
        offered.push(meta.id)
        expect(files.declineFileTransfer(files.transferKeyOf(A.id, meta.id))).toBe(true)
      })
      const receive = (id: string): void => {
        room.receive(
          'file-meta',
          { id, name: 'f.bin', size: 10, mime: '', chunks: 1, enc: false },
          A.id,
        )
      }
      for (let i = 0; i < files.FILE_OFFER_RATE_CAP; i += 1) receive(crypto.randomUUID())
      await vi.advanceTimersByTimeAsync(0)
      expect(offered).toHaveLength(files.FILE_OFFER_RATE_CAP)
      // The two beyond the cap are dropped SILENTLY: the only file-aborts
      // on the wire are the explicit declines of the accepted ones.
      const abortIds = room
        .action('file-abort')
        .sends.map((send) => (send.data as { id: string }).id)
      expect(abortIds).toEqual(offered)
      receive(crypto.randomUUID())
      await vi.advanceTimersByTimeAsync(0)
      expect(offered).toHaveLength(files.FILE_OFFER_RATE_CAP)
      // The window rolls: past it the peer may offer again.
      await vi.advanceTimersByTimeAsync(files.FILE_OFFER_RATE_WINDOW_MS + 1)
      receive(crypto.randomUUID())
      await vi.advanceTimersByTimeAsync(0)
      expect(offered).toHaveLength(files.FILE_OFFER_RATE_CAP + 1)
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sanitizes the incoming name at the boundary (control chars, length)', async () => {
    const { room } = await joinPublicRoomWithA()
    const id = crypto.randomUUID()
    room.receive(
      'file-meta',
      {
        id,
        name: `  in\u0000vis\u200bible${'y'.repeat(150)}.bin`,
        size: 10,
        mime: '',
        chunks: 1,
        enc: false,
      },
      A.id,
    )
    await flushCrypto()
    const record = files.getFileTransferRecord(files.transferKeyOf(A.id, id))
    expect(record?.meta.name).toBe(`invisible${'y'.repeat(111)}`)
    expect(record?.meta.name.length).toBe(files.FILE_NAME_MAX_LENGTH)
  })
})

// ---------------------------------------------------------------------------
// Happy paths — byte-exact end to end through the real seal/open paths
// ---------------------------------------------------------------------------

describe('happy paths (§12.4, byte-exact end to end)', () => {
  it('receiver assembles a sealed password-room file byte-exactly and mints the URL', async () => {
    const { roomId, room } = await joinPasswordRoomWithA()
    const key = await manager.resolveTransferKey({ kind: 'room', roomId })
    if (key === null) throw new Error('no room key')
    // 2.5 chunks: covers full slices AND the exact-tail last chunk.
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 2 + 500)
    const { url, meta, transferKey } = await deliverFileFromA({ roomId, room, bytes, sealKey: key })
    expect(meta.enc).toBe(true)
    expect(url).toMatch(/^blob:/)
    expect(files.getFileTransferRecord(transferKey)?.url).toBe(url)
    expect(revokedUrls).not.toContain(url)
  })

  it('receiver assembles a cleartext public-room file byte-exactly (enc=false)', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 7)
    const { meta } = await deliverFileFromA({ roomId, room, bytes, sealKey: null })
    expect(meta.enc).toBe(false)
  })

  it('receiver assembles a sealed DM file with its own v2 key derivation', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const aSideKey = await deriveASideDmKey(room)
    const bytes = patternBytes(700)
    const { meta } = await deliverFileFromA({ roomId, room, bytes, sealKey: aSideKey })
    expect(meta.enc).toBe(true)
  })

  it('sender streams a sealed password-room file; A reassembles it byte-exactly', async () => {
    const { roomId, room } = await joinPasswordRoomWithA()
    const key = await manager.resolveTransferKey({ kind: 'room', roomId })
    if (key === null) throw new Error('no room key')
    await driveManagerSender({
      roomId,
      room,
      bytes: patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 11),
      kind: 'room',
      aSideKey: key,
      name: 'informe.pdf',
      mime: 'application/pdf',
    })
  })

  it('sender streams a cleartext public-room file; A reassembles it byte-exactly', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    await driveManagerSender({
      roomId,
      room,
      bytes: patternBytes(999),
      kind: 'room',
      aSideKey: null,
    })
  })

  it('sender streams a sealed DM file; A opens it with her own derivation', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const aSideKey = await deriveASideDmKey(room)
    await driveManagerSender({
      roomId,
      room,
      bytes: patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 2),
      kind: 'dm',
      aSideKey,
    })
  })

  it('fires progress seams and the caller callback on both ends', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const progress: number[] = []
    const unsubscribe = files.onFileProgress((rid, peerId, id, transferred, total) => {
      expect(rid).toBe(roomId)
      expect(peerId).toBe(A.id)
      expect(typeof id).toBe('string')
      progress.push(transferred / total)
    })
    const onProgress = vi.fn()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 2 + 3)
    const file = new File([bytes], 'a.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'room', onProgress)
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(meta.chunks))
    for (let seq = 1; seq <= meta.chunks; seq += 1) {
      const frame = chunkSendsOf(room)[seq - 1]?.data as Uint8Array
      room.receive('file-chunk', frame, A.id)
    }
    await tick()
    room.receive('file-ack', { id: meta.id, nextSeq: meta.chunks + 1, grant: 0 }, A.id)
    await expect(outcome.settled).resolves.toBe('done')
    unsubscribe()
    expect(progress[progress.length - 1]).toBe(1)
    expect(onProgress).toHaveBeenLastCalledWith(meta.chunks, meta.chunks)
  })
})

// ---------------------------------------------------------------------------
// Credit window — the receiver plans the memory, the sender obeys
// ---------------------------------------------------------------------------

describe('credit window (§12.4)', () => {
  it('never exceeds 8 unacked chunks in flight and acks in contiguous order', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const chunks = 20
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * chunks)
    const file = new File([bytes], 'grande.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'room')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    expect(meta.chunks).toBe(chunks)
    room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(8))
    // Without further acks the sender stays parked at exactly 8.
    await tick()
    await tick()
    expect(chunkSendsOf(room).length).toBe(8)

    const seqs: number[] = []
    let received = 0
    while (received < chunks) {
      const target = Math.min(received + 8, chunks)
      for (let seq = received + 1; seq <= target; seq += 1) {
        const frame = chunkSendsOf(room)[seq - 1]?.data as Uint8Array
        seqs.push(new DataView(frame.buffer).getUint32(8, false))
      }
      received = target
      if (received < chunks) {
        room.receive('file-ack', { id: meta.id, nextSeq: received + 1, grant: 8 }, A.id)
        await vi.waitFor(() =>
          expect(chunkSendsOf(room).length).toBe(Math.min(received + 8, chunks)),
        )
      }
    }
    expect(seqs).toEqual(Array.from({ length: chunks }, (_, i) => i + 1))
    room.receive('file-ack', { id: meta.id, nextSeq: chunks + 1, grant: 0 }, A.id)
    await expect(outcome.settled).resolves.toBe('done')
  })

  it('the receiver acks on window exhaustion and completes with the final grant-0 ack', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const chunks = 17
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * chunks)
    const { transferKey } = await deliverFileFromA({
      roomId,
      room,
      bytes,
      sealKey: null,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    const ackPayload = ackSendsOf(room)[0]?.data as { id: string; nextSeq: number; grant: number }
    const id = ackPayload.id
    const ackPairs = (): [number, number][] =>
      ackSendsOf(room).map((send) => {
        const payload = send.data as { nextSeq: number; grant: number }
        return [payload.nextSeq, payload.grant]
      })
    expect(ackPairs()).toEqual([[1, 8]])
    const fileId = await fileIdOf(id)
    for (let seq = 1; seq <= chunks; seq += 1) {
      const start = (seq - 1) * files.FILE_CHUNK_PAYLOAD_BYTES
      const plain = bytes.slice(start, start + files.FILE_CHUNK_PAYLOAD_BYTES)
      room.receive('file-chunk', makeFrame(fileId, seq, plain), A.id)
      await tick()
    }
    // 1 (accept) + window acks at 8 and 16 + the final ack.
    expect(ackPairs()).toEqual([
      [1, 8],
      [9, 8],
      [17, 8],
      [chunks + 1, 0],
    ])
  })
})

// ---------------------------------------------------------------------------
// Framing — garbage dies without corrupting the transfer or its siblings
// ---------------------------------------------------------------------------

describe('framing (§12.4)', () => {
  interface Offered {
    id: string
    transferKey: string
    fileId: Uint8Array
  }

  async function offerAndAccept(room: FakeTrysteroRoom, size: number): Promise<Offered> {
    const id = crypto.randomUUID()
    const meta: FileMeta = {
      id,
      name: `${id.slice(0, 6)}.bin`,
      size,
      mime: '',
      chunks: Math.ceil(size / files.FILE_CHUNK_PAYLOAD_BYTES),
      enc: false,
    }
    room.receive('file-meta', meta, A.id)
    await flushCrypto()
    const transferKey = files.transferKeyOf(A.id, id)
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    return { id, transferKey, fileId: await fileIdOf(id) }
  }

  it('drops chunks with a foreign fileId prefix without touching the transfer', async () => {
    const { room } = await joinPublicRoomWithA()
    const offered = await offerAndAccept(room, 100)
    const stranger = await fileIdOf(crypto.randomUUID())
    room.receive('file-chunk', makeFrame(stranger, 1, patternBytes(100)), A.id)
    await tick()
    expect(files.getFileTransferRecord(offered.transferKey)?.state).toBe('transferring')
    expect(ackSendsOf(room)).toHaveLength(1) // only the acceptance ack
  })

  it('drops duplicate and out-of-range seqs; the stream keeps flowing', async () => {
    const { room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 10)
    const offered = await offerAndAccept(room, bytes.length)
    const plain1 = bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)
    room.receive('file-chunk', makeFrame(offered.fileId, 1, plain1), A.id)
    room.receive('file-chunk', makeFrame(offered.fileId, 1, plain1), A.id) // duplicate
    room.receive('file-chunk', makeFrame(offered.fileId, 99, plain1), A.id) // > chunks (2)
    room.receive('file-chunk', makeFrame(offered.fileId, 0, plain1), A.id) // < 1
    const plain2 = bytes.slice(files.FILE_CHUNK_PAYLOAD_BYTES)
    room.receive('file-chunk', makeFrame(offered.fileId, 2, plain2), A.id)
    await tick()
    const record = files.getFileTransferRecord(offered.transferKey)
    expect(record?.state).toBe('done')
    expect(record?.transferred).toBe(2)
  })

  it('aborts at the first byte that would exceed size (per-seq length discipline)', async () => {
    const { room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 10)
    const offered = await offerAndAccept(room, bytes.length)
    const oversized = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 1)
    room.receive('file-chunk', makeFrame(offered.fileId, 1, oversized), A.id)
    await tick()
    const record = files.getFileTransferRecord(offered.transferKey)
    expect(record?.state).toBe('failed')
    expect(record?.failureReason).toBe('size-limit')
    // The sender is told so it does not stall out.
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: offered.id }, options: { target: A.id } },
    ])
  })

  it('fails the whole transfer on a GCM open failure without hurting a sibling transfer', async () => {
    const { roomId, room } = await joinPasswordRoomWithA()
    const key = await manager.resolveTransferKey({ kind: 'room', roomId })
    if (key === null) throw new Error('no room key')
    // Two concurrent sealed transfers from the same peer.
    const first = await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(50),
      sealKey: key,
      autoAccept: false,
    })
    const second = await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(60),
      sealKey: key,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(first.transferKey)).resolves.toBe(true)
    await expect(files.acceptFileTransfer(second.transferKey)).resolves.toBe(true)
    // Tampered chunk for the FIRST transfer (flip a ciphertext byte).
    const sealed = await sealChunk(key, patternBytes(50))
    const tampered = Uint8Array.from(sealed)
    tampered[tampered.length - 1] ^= 0xff
    room.receive('file-chunk', makeFrame(first.fileId, 1, tampered), A.id)
    await tick()
    expect(files.getFileTransferRecord(first.transferKey)?.state).toBe('failed')
    expect(files.getFileTransferRecord(first.transferKey)?.failureReason).toBe('crypto')
    // The sibling streams on untouched.
    room.receive(
      'file-chunk',
      makeFrame(second.fileId, 1, await sealChunk(key, patternBytes(60))),
      A.id,
    )
    await tick()
    expect(files.getFileTransferRecord(second.transferKey)?.state).toBe('done')
  })

  it('ignores frames that are too short, too big or not binary at all', async () => {
    const { room } = await joinPublicRoomWithA()
    const offered = await offerAndAccept(room, 100)
    room.receive('file-chunk', new Uint8Array(8), A.id) // header only
    room.receive('file-chunk', 'not binary', A.id)
    room.receive(
      'file-chunk',
      makeFrame(offered.fileId, 1, patternBytes(files.FILE_CHUNK_SEALED_MAX_BYTES + 1)),
      A.id,
    )
    await tick()
    expect(files.getFileTransferRecord(offered.transferKey)?.state).toBe('transferring')
  })
})

// ---------------------------------------------------------------------------
// Abort / decline / cancel
// ---------------------------------------------------------------------------

describe('abort, decline and cancel (§12.4)', () => {
  it('receiver decline: record rejected + explicit file-abort to the sender', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const { transferKey, meta } = await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(10),
      sealKey: null,
      autoAccept: false,
    })
    expect(files.declineFileTransfer(transferKey)).toBe(true)
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('rejected')
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: meta.id }, options: { target: A.id } },
    ])
    expect(files.declineFileTransfer(transferKey)).toBe(false) // terminal already
  })

  it('sender sees an offer rejection when the peer aborts during offer', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const file = new File([patternBytes(10)], 'a.txt')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'dm')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    room.receive('file-abort', { id: meta.id }, A.id)
    await expect(outcome.settled).resolves.toBe('rejected')
    expect(files.getFileTransferRecord(outcome.key)?.state).toBe('rejected')
  })

  it('sender cancel mid-transfer: aborted + file-abort to the receiver', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const file = new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 20)], 'grande.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'dm')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(8))
    expect(files.cancelFileTransfer(outcome.key)).toBe(true)
    await expect(outcome.settled).resolves.toBe('aborted')
    expect(files.getFileTransferRecord(outcome.key)?.state).toBe('aborted')
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: meta.id }, options: { target: A.id } },
    ])
    // The pump stops dead: no chunk 9.
    await tick()
    expect(chunkSendsOf(room).length).toBe(8)
  })

  it('receiver cancel mid-transfer discards the partial accumulation', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 5)
    const { transferKey, meta, fileId } = await deliverFileFromA({
      roomId,
      room,
      bytes,
      sealKey: null,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    room.receive(
      'file-chunk',
      makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
      A.id,
    )
    await tick()
    expect(files.getFileTransferRecord(transferKey)?.transferred).toBe(1)
    expect(files.cancelFileTransfer(transferKey)).toBe(true)
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('aborted')
    expect(record?.url).toBeNull()
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: meta.id }, options: { target: A.id } },
    ])
    // A late chunk for the dead transfer is dropped (no session).
    room.receive(
      'file-chunk',
      makeFrame(fileId, 2, bytes.slice(files.FILE_CHUNK_PAYLOAD_BYTES)),
      A.id,
    )
    await tick()
    expect(record?.state).toBe('aborted')
  })

  it('receiver abort mid-transfer turns the sender aborted (not failed)', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const file = new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 20)], 'grande.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'dm')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(8))
    room.receive('file-abort', { id: meta.id }, A.id)
    await expect(outcome.settled).resolves.toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// Stall — 30 s without progress fails both ends
// ---------------------------------------------------------------------------

describe('stall timeouts (§12.4)', () => {
  it('sender: 30 s without acks → failed, peer notified', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    vi.useFakeTimers()
    try {
      const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 12)
      const file = new File([bytes], 'grande.bin')
      const outcome = await files.sendFileTransfer(roomId, A.id, file, 'room')
      if (!outcome.ok) throw new Error('refused')
      const meta = room.lastSend('file-meta').data as FileMeta
      room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
      await vi.advanceTimersByTimeAsync(0) // pump drains the first window
      expect(chunkSendsOf(room).length).toBe(8)
      const failed: string[] = []
      files.onFileFailed((_rid, _peerId, id, reason) => failed.push(`${id}:${reason}`))
      await vi.advanceTimersByTimeAsync(files.FILE_STALL_TIMEOUT_MS - 1)
      // Not yet: the transfer is still within its 30 s window.
      expect(files.getFileTransferRecord(outcome.key)?.state).toBe('transferring')
      await vi.advanceTimersByTimeAsync(1)
      await expect(outcome.settled).resolves.toBe('failed')
      expect(failed).toEqual([`${meta.id}:stall`])
      expect(room.action('file-abort').sends).toEqual([
        { data: { id: meta.id }, options: { target: A.id } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('receiver: 30 s without chunks → failed, partials released, peer notified', async () => {
    const { room } = await joinPublicRoomWithA()
    vi.useFakeTimers()
    try {
      const bytes = patternBytes(100)
      const id = crypto.randomUUID()
      const meta: FileMeta = {
        id,
        name: 'lento.bin',
        size: bytes.length,
        mime: '',
        chunks: 1,
        enc: false,
      }
      room.receive('file-meta', meta, A.id)
      await vi.advanceTimersByTimeAsync(0)
      const transferKey = files.transferKeyOf(A.id, id)
      await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
      expect(ackSendsOf(room)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(files.FILE_STALL_TIMEOUT_MS)
      const record = files.getFileTransferRecord(transferKey)
      expect(record?.state).toBe('failed')
      expect(record?.failureReason).toBe('stall')
      expect(room.action('file-abort').sends).toEqual([
        { data: { id: meta.id }, options: { target: A.id } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('progress resets the stall: a slow but moving transfer survives', async () => {
    const { room } = await joinPublicRoomWithA()
    vi.useFakeTimers()
    try {
      const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 5)
      const id = crypto.randomUUID()
      const meta: FileMeta = {
        id,
        name: 'lento.bin',
        size: bytes.length,
        mime: '',
        chunks: 2,
        enc: false,
      }
      room.receive('file-meta', meta, A.id)
      await vi.advanceTimersByTimeAsync(0)
      const transferKey = files.transferKeyOf(A.id, id)
      await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
      const fileId = await fileIdOf(id)
      // 20 s in: no chunk yet — still inside the window (armed at accept).
      await vi.advanceTimersByTimeAsync(20_000)
      expect(files.getFileTransferRecord(transferKey)?.state).toBe('transferring')
      // Chunk 1 arrives at t=20 s: progress re-arms the 30 s window —
      // without the reset the accept-era timer would fire at t=30 s.
      room.receive(
        'file-chunk',
        makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
        A.id,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(files.getFileTransferRecord(transferKey)?.state).toBe('transferring')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(files.getFileTransferRecord(transferKey)?.state).toBe('transferring')
      room.receive(
        'file-chunk',
        makeFrame(fileId, 2, bytes.slice(files.FILE_CHUNK_PAYLOAD_BYTES)),
        A.id,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(files.getFileTransferRecord(transferKey)?.state).toBe('done')
      // And no stall ever fires afterwards.
      await vi.advanceTimersByTimeAsync(files.FILE_STALL_TIMEOUT_MS)
      expect(files.getFileTransferRecord(transferKey)?.state).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('file-end with missing chunks fails fast instead of waiting out the stall', async () => {
    const { room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 10)
    const id = crypto.randomUUID()
    const meta: FileMeta = {
      id,
      name: 'hueco.bin',
      size: bytes.length,
      mime: '',
      chunks: 2,
      enc: false,
    }
    room.receive('file-meta', meta, A.id)
    await flushCrypto()
    const transferKey = files.transferKeyOf(A.id, id)
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    const fileId = await fileIdOf(id)
    // Only chunk 1 arrives; the sender closes claiming it is done.
    room.receive(
      'file-chunk',
      makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
      A.id,
    )
    await tick()
    room.receive('file-end', { id }, A.id)
    await tick()
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('failed')
    expect(record?.failureReason).toBe('completeness')
  })
})

// ---------------------------------------------------------------------------
// Reconnect — a mid-transfer drop fails the transfer, no resume
// ---------------------------------------------------------------------------

describe('reconnect (§12.4: failure, no resume)', () => {
  it('peer leave mid-transfer fails the sender-side transfer', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const file = new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 20)], 'grande.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'dm')
    if (!outcome.ok) throw new Error('refused')
    const meta = room.lastSend('file-meta').data as FileMeta
    room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    await vi.waitFor(() => expect(chunkSendsOf(room).length).toBe(8))
    room.peerLeave(A.id)
    await expect(outcome.settled).resolves.toBe('failed')
    const record = files.getFileTransferRecord(outcome.key)
    expect(record?.state).toBe('failed')
    expect(record?.failureReason).toBe('peer-drop')
  })

  it('peer leave mid-transfer fails the receiver-side transfer and drops partials', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 5)
    const { transferKey, fileId } = await deliverFileFromA({
      roomId,
      room,
      bytes,
      sealKey: null,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    room.receive(
      'file-chunk',
      makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
      A.id,
    )
    await tick()
    room.peerLeave(A.id)
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('failed')
    expect(record?.failureReason).toBe('peer-drop')
    expect(record?.url).toBeNull()
  })

  it('a rejoin does not resume: the failed record stays and late chunks drop', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 5)
    const { transferKey, fileId } = await deliverFileFromA({
      roomId,
      room,
      bytes,
      sealKey: null,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    room.peerLeave(A.id)
    expect(files.getFileTransferRecord(transferKey)?.state).toBe('failed')
    // A "reconnects" — but the transfer is gone for good.
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushCrypto()
    room.receive(
      'file-chunk',
      makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
      A.id,
    )
    await tick()
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('failed')
    expect(record?.transferred).toBe(0)
  })

  it('leaving the room fails its transfers with room-gone and frees the host', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const { transferKey } = await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(10),
      sealKey: null,
      autoAccept: false,
    })
    await manager.leaveRoom(roomId)
    expect(files.getFileTransferRecord(transferKey)?.state).toBe('failed')
    expect(files.getFileTransferRecord(transferKey)?.failureReason).toBe('room-gone')
    // The host is gone: a fresh offer to the dead room refuses locally.
    const file = new File([patternBytes(10)], 'a.txt')
    expect(await files.sendFileTransfer(roomId, A.id, file, 'room')).toEqual({
      ok: false,
      reason: 'unknown-room',
    })
  })
})

// ---------------------------------------------------------------------------
// Mute (issue #95 × §12.4) — muted peers get no file traffic at all
// ---------------------------------------------------------------------------

describe('mute gates (§12.4)', () => {
  it('a muted sender’s meta is dropped before any parse or effect', async () => {
    const { room } = await joinPublicRoomWithA()
    expect(manager.muteFromUi(A.fingerprint, 'zorro-bravo')).toBe(true)
    const offers: unknown[] = []
    files.onFileOffer((_, __, meta) => offers.push(meta))
    room.receive(
      'file-meta',
      { id: crypto.randomUUID(), name: 'x.bin', size: 10, mime: '', chunks: 1, enc: false },
      A.id,
    )
    await flushCrypto()
    expect(offers).toHaveLength(0)
    expect(Object.keys(files.getFileTransfers())).toHaveLength(0)
  })

  it('muting a peer mid-transfer aborts its active transfers with a file-abort', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const { transferKey, meta } = await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES + 5),
      sealKey: null,
      autoAccept: false,
    })
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    expect(manager.muteFromUi(A.fingerprint, 'zorro-bravo')).toBe(true)
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('aborted')
    expect(room.action('file-abort').sends).toEqual([
      { data: { id: meta.id }, options: { target: A.id } },
    ])
  })
})

// ---------------------------------------------------------------------------
// Completeness — the cleartext sum must be EXACTLY size
// ---------------------------------------------------------------------------

describe('completeness (§12.4)', () => {
  it('a byte-sum mismatch fails the transfer instead of minting a wrong blob', async () => {
    const { room } = await joinPublicRoomWithA()
    const id = crypto.randomUUID()
    const meta: FileMeta = { id, name: 'corto.bin', size: 100, mime: '', chunks: 1, enc: false }
    room.receive('file-meta', meta, A.id)
    await flushCrypto()
    const transferKey = files.transferKeyOf(A.id, id)
    await expect(files.acceptFileTransfer(transferKey)).resolves.toBe(true)
    const fileId = await fileIdOf(id)
    room.receive('file-chunk', makeFrame(fileId, 1, patternBytes(50)), A.id)
    await tick()
    const record = files.getFileTransferRecord(transferKey)
    expect(record?.state).toBe('failed')
    expect(record?.failureReason).toBe('completeness')
    expect(record?.url).toBeNull()
    expect(blobRegistry.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Panic + identity regeneration — nothing survives either stroke
// ---------------------------------------------------------------------------

describe('panic and identity regeneration', () => {
  it('panicWipe aborts everything and revokes every URL', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    const done = await deliverFileFromA({ roomId, room, bytes: patternBytes(10), sealKey: null })
    await deliverFileFromA({
      roomId,
      room,
      bytes: patternBytes(10),
      sealKey: null,
      autoAccept: false,
    })
    expect(files.getFileTransfers()[done.transferKey]?.url).toBe(done.url)
    panicWipe({ reload: false })
    expect(files.getFileTransfers()).toEqual({})
    expect(revokedUrls).toContain(done.url)
    expect(blobRegistry.size).toBe(0)
  })

  it('identity regeneration fails actives, revokes done URLs and empties the map', async () => {
    const { roomId, room } = await joinPublicRoomWithA({ openDm: true })
    const done = await deliverFileFromA({ roomId, room, bytes: patternBytes(10), sealKey: null })
    const file = new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 12)], 'grande.bin')
    const outcome = await files.sendFileTransfer(roomId, A.id, file, 'dm')
    if (!outcome.ok) throw new Error('refused')
    await manager.regenerateSessionIdentity()
    await expect(outcome.settled).resolves.toBe('failed')
    expect(files.getFileTransfers()).toEqual({})
    expect(revokedUrls).toContain(done.url)
  })

  it('resetManagerForTests leaves no records, hosts or listeners behind', async () => {
    const { roomId, room } = await joinPublicRoomWithA()
    await deliverFileFromA({ roomId, room, bytes: patternBytes(10), sealKey: null })
    manager.resetManagerForTests()
    expect(files.getFileTransfers()).toEqual({})
    expect(useAppStore.getState().rooms).toEqual({})
  })
})
