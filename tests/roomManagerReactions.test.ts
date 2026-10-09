import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { MESSAGE_CAP, useAppStore, type DmChannel } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { MIN_MESSAGE_TTL_S, type Envelope } from '../src/lib/p2p/protocol'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'

/**
 * Issue #98 phase 2 — reaction STATE on top of the phase-1 `react` action:
 * the seam→store wiring routes broadcast payloads to the room slice and
 * directed ones to the DM slice (keyed by the sender), unknown/FIFO-evicted
 * ids drop silently, the optimistic local toggle composes with sendReact
 * without duplicates, reactions stay cosmetic (no unread, receipts,
 * notifications) and die with the message row on the TTL sweep.
 */

let fake: ReturnType<typeof installFakeTrystero>
let A: FakeRemotePeer

beforeEach(async () => {
  // Real timers: the mute test below waits for the keys → fingerprint
  // WebCrypto tail, which vitest fake timers do not pump.
  fake = installFakeTrystero()
  A = await makeFakeRemotePeer('peer-a')
})

afterEach(() => {
  // Also restores the default (empty) settings store and re-installs the
  // module-load seam→store wiring (asserted explicitly below).
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
})

/** Lets the keys handler's async computeFingerprint tail settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

async function join(name = 'lobby'): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name)
  return { roomId: connection.roomId, room: fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom }
}

async function joinWithPeer(name = 'lobby'): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const joined = await join(name)
  await fakePeerJoins(joined.room, A)
  return joined
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

function dmChannel(peerId: string): DmChannel {
  const channel = useAppStore.getState().dms[peerId]
  if (channel === undefined) throw new Error(`dm channel ${peerId} not in store`)
  return channel
}

function chatEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: A.id,
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola',
    ...overrides,
  }
}

/** Seeds one peer message into the room feed without wire/receipt noise. */
function seedRoomMessage(roomId: string, id: string): void {
  useAppStore.getState().appendMessage(roomId, {
    id,
    roomId,
    authorId: A.id,
    authorNick: 'zorro-bravo',
    text: 'hola',
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'user',
  })
}

/** Seeds one peer message into A's DM channel (key = sender peerId). */
function seedDmMessage(id: string): void {
  const store = useAppStore.getState()
  store.ensureDmChannel(A.id, 'zorro-bravo', null)
  store.appendDmMessage(A.id, {
    id,
    roomId: `dm:${A.id}`,
    authorId: A.id,
    authorNick: 'zorro-bravo',
    text: 'psst',
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'user',
  })
}

describe('issue #98 phase 2 — inbound reactions land in the right slice', () => {
  it('a broadcast reaction mutates ONLY the room slice', async () => {
    const { roomId, room } = await joinWithPeer()
    seedRoomMessage(roomId, 'm-1')

    room.receive('react', { ids: ['m-1'], emo: '🎉', on: true }, A.id)

    // peerJoin's system line shares the feed; look the target up by id.
    expect(storedRoom(roomId).messages.find((m) => m.id === 'm-1')?.reactions).toEqual({
      '🎉': [A.id],
    })
    expect(Object.keys(useAppStore.getState().dms)).toHaveLength(0)
  })

  it('a directed reaction mutates ONLY the dm slice (keyed by the sender)', async () => {
    const { roomId, room } = await joinWithPeer()
    seedDmMessage('dm-1')

    room.receive('react', { ids: ['dm-1'], emo: '❤️', on: true, to: manager.getSelfPeerId() }, A.id)

    expect(dmChannel(A.id).messages[0]?.reactions).toEqual({ '❤️': [A.id] })
    // The room feed only holds peerJoin's system line: no reaction leaked.
    expect(storedRoom(roomId).messages.some((m) => m.kind === 'user')).toBe(false)
  })

  it('toggles on and off from the wire; re-adding stays idempotent', async () => {
    const { roomId, room } = await joinWithPeer()
    seedRoomMessage(roomId, 'm-1')
    const target = () => storedRoom(roomId).messages.find((m) => m.id === 'm-1')

    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)
    expect(target()?.reactions).toEqual({ '👍': [A.id] })

    // A different batch that repeats the same toggle (full-mesh duplicate
    // with a companion id) must not double-add.
    room.receive('react', { ids: ['m-1', 'm-2'], emo: '👍', on: true }, A.id)
    expect(target()?.reactions).toEqual({ '👍': [A.id] })

    room.receive('react', { ids: ['m-1'], emo: '👍', on: false }, A.id)
    expect(target()?.reactions).toBeUndefined()

    // Unreacting again (different batch shape so dedup lets it through) is a
    // silent no-op.
    room.receive('react', { ids: ['m-1', 'm-2'], emo: '👍', on: false }, A.id)
    expect(target()?.reactions).toBeUndefined()
  })

  it('drops reactions to unknown or FIFO-evicted ids silently', async () => {
    const { roomId, room } = await joinWithPeer()

    // Unknown id: nothing to attach to, no crash, no state change.
    const idsBefore = storedRoom(roomId).messages.map((m) => m.id)
    expect(() => room.receive('react', { ids: ['ghost'], emo: '👍', on: true }, A.id)).not.toThrow()
    expect(storedRoom(roomId).messages.map((m) => m.id)).toEqual(idsBefore)

    // FIFO-evicted id: seed MESSAGE_CAP + 1 rows, the first rolls off.
    for (let i = 0; i <= MESSAGE_CAP; i += 1) {
      seedRoomMessage(roomId, `m-${i}`)
    }
    expect(storedRoom(roomId).messages).toHaveLength(MESSAGE_CAP)
    expect(storedRoom(roomId).messages.map((m) => m.id)).not.toContain('m-0')

    room.receive('react', { ids: ['m-0', 'm-1'], emo: '👍', on: true }, A.id)
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(MESSAGE_CAP) // no resurrection
    expect(messages.find((m) => m.id === 'm-0')).toBeUndefined() // evicted id dropped
    expect(messages.find((m) => m.id === 'm-1')?.reactions).toEqual({ '👍': [A.id] }) // survivor
    expect(messages.find((m) => m.id === 'm-2')?.reactions).toBeUndefined() // batch companion
  })

  it("drops a muted peer's reactions at the receive path (issue #95 parity)", async () => {
    const { roomId, room } = await joinWithPeer()
    await flushMicrotasks() // keys → fingerprint tail must settle first
    seedRoomMessage(roomId, 'm-1')
    expect(useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')).toBe(true)

    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)

    expect(storedRoom(roomId).messages.find((m) => m.id === 'm-1')?.reactions).toBeUndefined()
  })
})

describe('issue #98 phase 2 — optimistic local toggle (toggleReaction)', () => {
  it('applies the local peerId immediately, sends a broadcast, and echoes cannot double-add', async () => {
    const { roomId, room } = await joinWithPeer()
    const own = manager.sendChat(roomId, 'mine')
    expect(own).not.toBeNull()

    expect(manager.toggleReaction(roomId, own?.id ?? '', '👍')).toBe(true)

    const message = storedRoom(roomId).messages.find((m) => m.id === own?.id)
    expect(message?.reactions).toEqual({ '👍': [manager.getSelfPeerId()] })
    const send = room.lastSend('react')
    expect(send.data).toEqual({ ids: [own?.id], emo: '👍', on: true })
    expect(send.options).toBeUndefined()

    // Simulated echo of the own broadcast (a relay is forbidden, but the
    // state must be safe even if one ever surfaces): still exactly one entry.
    room.receive('react', { ids: [own?.id], emo: '👍', on: true }, manager.getSelfPeerId())
    expect(storedRoom(roomId).messages.find((m) => m.id === own?.id)?.reactions).toEqual({
      '👍': [manager.getSelfPeerId()],
    })

    // Toggling again removes locally and sends the inverse payload.
    expect(manager.toggleReaction(roomId, own?.id ?? '', '👍')).toBe(true)
    expect(storedRoom(roomId).messages.find((m) => m.id === own?.id)?.reactions).toBeUndefined()
    expect(room.lastSend('react').data).toEqual({ ids: [own?.id], emo: '👍', on: false })
  })

  it('lists the own peerId once on an own sent message (send + toggle compose)', async () => {
    const { roomId } = await joinWithPeer()
    const own = manager.sendChat(roomId, 'self-reaction')

    manager.toggleReaction(roomId, own?.id ?? '', '🎉')

    const message = storedRoom(roomId).messages.find((m) => m.id === own?.id)
    expect(message?.authorId).toBe('self')
    expect(message?.reactions).toEqual({ '🎉': [manager.getSelfPeerId()] })
  })

  it('directs DM toggles at the peer and mutates only the dm slice', async () => {
    const { roomId, room } = await joinWithPeer()
    seedDmMessage('dm-1')

    expect(manager.toggleReaction(roomId, 'dm-1', '❤️', A.id)).toBe(true)

    expect(dmChannel(A.id).messages[0]?.reactions).toEqual({ '❤️': [manager.getSelfPeerId()] })
    const send = room.lastSend('react')
    expect(send.data).toEqual({ ids: ['dm-1'], emo: '❤️', on: true, to: A.id })
    expect(send.options).toEqual({ target: A.id })
    expect(storedRoom(roomId).messages.some((m) => m.kind === 'user')).toBe(false)
  })

  it('refuses non-whitelist emoji and unknown ids without sending or changing state', async () => {
    const { roomId, room } = await joinWithPeer()
    seedRoomMessage(roomId, 'm-1')

    expect(manager.toggleReaction(roomId, 'm-1', '🚀')).toBe(false)
    expect(manager.toggleReaction(roomId, 'ghost', '👍')).toBe(false)
    expect(room.action('react').sends).toHaveLength(0)
    expect(storedRoom(roomId).messages[0]?.reactions).toBeUndefined()
  })

  it('survives resetManagerForTests: the seam→store wiring is re-installed', async () => {
    const first = await joinWithPeer()
    seedRoomMessage(first.roomId, 'm-1')
    first.room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)
    expect(storedRoom(first.roomId).messages.find((m) => m.id === 'm-1')?.reactions).toEqual({
      '👍': [A.id],
    })

    manager.resetManagerForTests()

    const second = await joinWithPeer()
    seedRoomMessage(second.roomId, 'm-2')
    second.room.receive('react', { ids: ['m-2'], emo: '👍', on: true }, A.id)
    expect(storedRoom(second.roomId).messages.find((m) => m.id === 'm-2')?.reactions).toEqual({
      '👍': [A.id],
    })
  })
})

describe('issue #98 phase 2 — cosmetic class + expiry interplay', () => {
  it('reactions never touch unread badges, receipts, system lines or notification seams', async () => {
    const { roomId, room } = await joinWithPeer()
    seedRoomMessage(roomId, 'm-1')
    seedDmMessage('dm-1')
    const dmReceived: unknown[] = []
    const mentions: unknown[] = []
    manager.onDmReceived(() => dmReceived.push(1))
    manager.onMentionReceived(() => mentions.push(1))
    // Non-focused room + channel: the seed messages counted as unread.
    expect(storedRoom(roomId).unread).toBe(1)
    expect(dmChannel(A.id).unread).toBe(1)
    const systemLines = storedRoom(roomId).messages.filter((m) => m.kind === 'system').length

    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)
    room.receive('react', { ids: ['dm-1'], emo: '❤️', on: true, to: manager.getSelfPeerId() }, A.id)

    expect(storedRoom(roomId).unread).toBe(1)
    expect(dmChannel(A.id).unread).toBe(1)
    // No receipt was queued by either reaction and no system line was added.
    expect(room.action('receipt').sends).toHaveLength(0)
    expect(storedRoom(roomId).messages.filter((m) => m.kind === 'system').length).toBe(systemLines)
    expect(dmReceived).toHaveLength(0)
    expect(mentions).toHaveLength(0)
  })

  it('a TTL sweep removes the row with its reactions; a late reaction leaves no ghost', async () => {
    const { roomId, room } = await joinWithPeer()
    const doomedEnvelope = chatEnvelope({ ttl: MIN_MESSAGE_TTL_S, body: 'fugaz' })
    room.receive('chat', doomedEnvelope, A.id)
    const doomed = doomedEnvelope.id
    room.receive('react', { ids: [doomed], emo: '🎉', on: true }, A.id)
    expect(storedRoom(roomId).messages.find((m) => m.id === doomed)?.reactions).toEqual({
      '🎉': [A.id],
    })

    expect(manager.pruneExpiredMessages(Date.now() + MIN_MESSAGE_TTL_S * 1_000)).toEqual([doomed])
    // Reactions died with the row: only peerJoin's system line remains.
    expect(storedRoom(roomId).messages.some((m) => m.id === doomed)).toBe(false)
    expect(storedRoom(roomId).messages.some((m) => m.kind === 'user')).toBe(false)
    expect(storedRoom(roomId).expiredCount).toBe(1)

    // A reaction for the expired id (batch reshaped so dedup lets it through):
    // no crash, no resurrection, no ghost state.
    expect(() =>
      room.receive('react', { ids: [doomed, 'also-ghost'], emo: '🎉', on: true }, A.id),
    ).not.toThrow()
    expect(storedRoom(roomId).messages.some((m) => m.kind === 'user')).toBe(false)
    expect(storedRoom(roomId).expiredCount).toBe(1)
  })

  it('aggregate counts derive from the same payloads on every peer (no extra sync)', async () => {
    const { roomId, room } = await joinWithPeer()
    seedRoomMessage(roomId, 'm-1')
    seedRoomMessage(roomId, 'm-2')

    // The fake models ONE local connection, so byte-identical content from
    // two peers would collapse in its shared dedup window; real peers each
    // ride their own channel with a separate per-connection BoundedSeenIds
    // (phase 1), so honest same-message toggles from different senders all
    // process. Distinct payloads aggregate: every peer deriving counts from
    // them gets the same totals, with no sync beyond the payloads.
    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)
    room.receive('react', { ids: ['m-1', 'm-2'], emo: '👍', on: true }, 'peer-b')

    const feed = storedRoom(roomId).messages
    expect(feed.find((m) => m.id === 'm-1')?.reactions).toEqual({ '👍': [A.id, 'peer-b'] })
    expect(feed.find((m) => m.id === 'm-2')?.reactions).toEqual({ '👍': ['peer-b'] })
  })
})

describe('issue #98 — toggleReaction guard rails', () => {
  it('ignores toggleReaction calls for an unknown room', async () => {
    expect(manager.toggleReaction('nope', 'm-1', '👍')).toBe(false)
  })
})
