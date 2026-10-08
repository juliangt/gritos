import { beforeEach, describe, expect, it } from 'vitest'
import {
  INITIAL_APP_STATE,
  MAX_REACTIONS_PER_EMOJI,
  applyReactionsToMessages,
  appendMessageCapped,
  connectionStatusText,
  latencyDot,
  partitionExpired,
  toggleMessageReaction,
  useAppStore,
  type Message,
  type Room,
} from '../src/stores/useAppStore'
import { REACT_EMOJIS } from '../src/lib/p2p/protocol'
import { INVALID_ROOM_NAME_TEXT, SUGGESTED_ROOMS } from '../src/lib/rooms'
import {
  FIFO_SEPARATOR_TEXT,
  expiredSeparatorText,
  formatTimeHHMM,
  joinSystemLine,
  leaveSystemLine,
  newMessagesButtonText,
  shouldAutoScroll,
  typingStatusText,
} from '../src/lib/feed'

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers: [],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    ...overrides,
  }
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    roomId: 'room-1',
    authorId: 'peer-1',
    authorNick: 'luna-cauta',
    text: 'hola',
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'user',
    ...overrides,
  }
}

describe('unread + view switching (RF-02)', () => {
  beforeEach(() => {
    // The store is module-global; start every test pristine.
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  it('increments unread in non-active rooms only for peer messages', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.appendMessage('room-1', userMessage())
    expect(useAppStore.getState().rooms['room-1']?.unread).toBe(1)

    // Own messages and system lines never count.
    useAppStore.getState().appendMessage('room-1', userMessage({ id: 'm2', authorId: 'self' }))
    useAppStore
      .getState()
      .appendMessage('room-1', userMessage({ id: 'm3', authorId: 'system', kind: 'system' }))
    expect(useAppStore.getState().rooms['room-1']?.unread).toBe(1)
  })

  it('does not increment unread for the focused room', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.setActiveView({ kind: 'room', id: 'room-1' })
    store.appendMessage('room-1', userMessage())
    expect(useAppStore.getState().rooms['room-1']?.unread).toBe(0)
  })

  it('clears unread when the room becomes the active view', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom({ unread: 3 }))
    store.setActiveView({ kind: 'room', id: 'room-1' })
    expect(useAppStore.getState().rooms['room-1']?.unread).toBe(0)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: 'room-1' })
  })

  it('switching views never drops rooms or connections state (RF-02)', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom({ id: 'r1', name: 'lobby' }))
    store.upsertRoom(makeRoom({ id: 'r2', name: 'dev', unread: 2 }))
    store.setActiveView({ kind: 'room', id: 'r1' })
    store.setActiveView({ kind: 'room', id: 'r2' })

    const state = useAppStore.getState()
    expect(Object.keys(state.rooms)).toEqual(['r1', 'r2'])
    expect(state.rooms.r2?.unread).toBe(0)
    expect(state.rooms.r1?.unread).toBe(0)
  })
})

describe('FIFO cap + separator flag (RF-03)', () => {
  beforeEach(() => {
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  it('appendMessageCapped keeps the last 500 in order', () => {
    const messages = Array.from({ length: 505 }, (_, i) => userMessage({ id: `m${i}` }))
    let acc: Message[] = []
    for (const message of messages) acc = appendMessageCapped(acc, message)
    expect(acc).toHaveLength(500)
    expect(acc[0]?.id).toBe('m5')
  })

  it('flags fifoTrimmed on the room once the cap trims', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.setActiveView({ kind: 'room', id: 'room-1' })
    for (let i = 0; i < 500; i += 1) {
      store.appendMessage('room-1', userMessage({ id: `m${i}` }))
    }
    expect(useAppStore.getState().rooms['room-1']?.fifoTrimmed).toBe(false)

    store.appendMessage('room-1', userMessage({ id: 'm500' }))
    const room = useAppStore.getState().rooms['room-1']
    expect(room?.messages).toHaveLength(500)
    expect(room?.fifoTrimmed).toBe(true)
    expect(FIFO_SEPARATOR_TEXT).toBe('— mensajes anteriores descartados —')
  })
})

describe('TTL expiry sweep (issue #96)', () => {
  // A fixed receiver clock: every expiresAt below is expressed against T0.
  const T0 = 1_760_000_000_000

  beforeEach(() => {
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  it('sweeps only messages whose expiresAt is due, across room and DM feeds in one pass', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.ensureDmChannel('peer-1', 'luna-cauta', null)
    store.setActiveView({ kind: 'room', id: 'room-1' })
    store.appendMessage('room-1', userMessage({ id: 'expired-room', expiresAt: T0 }))
    store.appendMessage('room-1', userMessage({ id: 'fresh', expiresAt: T0 + 1_000 }))
    store.appendMessage('room-1', userMessage({ id: 'session-lived' }))
    store.appendDmMessage(
      'peer-1',
      userMessage({ id: 'expired-dm', roomId: 'dm:peer-1', authorId: 'peer-1', expiresAt: T0 }),
    )

    const removed = useAppStore.getState().sweepExpiredMessages(T0)
    expect(removed).toEqual(['expired-room', 'expired-dm'])
    const room = useAppStore.getState().rooms['room-1']
    expect(room?.messages.map((message) => message.id)).toEqual(['fresh', 'session-lived'])
    expect(room?.expiredCount).toBe(1)
    const channel = useAppStore.getState().dms['peer-1']
    expect(channel?.messages).toHaveLength(0)
    expect(channel?.expiredCount).toBe(1)
  })

  it('treats expiry as inclusive (expiresAt == now is due) and keeps feed order', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.appendMessage('room-1', userMessage({ id: 'a', expiresAt: T0 }))
    store.appendMessage('room-1', userMessage({ id: 'b', expiresAt: T0 + 1 }))
    expect(useAppStore.getState().sweepExpiredMessages(T0)).toEqual(['a'])
    expect(useAppStore.getState().rooms['room-1']?.messages.map((m) => m.id)).toEqual(['b'])
  })

  it('accumulates expiredCount across sweeps for the feed lifetime (FIFO-flag semantics)', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.appendMessage('room-1', userMessage({ id: 'a', expiresAt: T0 }))
    useAppStore.getState().sweepExpiredMessages(T0)
    store.appendMessage('room-1', userMessage({ id: 'b', expiresAt: T0 }))
    store.appendMessage('room-1', userMessage({ id: 'c', expiresAt: T0 }))
    useAppStore.getState().sweepExpiredMessages(T0)
    // Never resets while the feed lives — the separator count only grows.
    expect(useAppStore.getState().rooms['room-1']?.expiredCount).toBe(3)
  })

  it('is a guarded write: a sweep with nothing due leaves the state untouched', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom({ unread: 2 }))
    store.appendMessage('room-1', userMessage({ id: 'session-lived' }))
    const before = useAppStore.getState().rooms['room-1']

    expect(useAppStore.getState().sweepExpiredMessages(T0)).toEqual([])
    expect(useAppStore.getState().rooms['room-1']).toBe(before)
  })

  it('frees FIFO slots before the 500 cap matters (no double-trim weirdness)', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.appendMessage('room-1', userMessage({ id: 'doomed', expiresAt: T0 }))
    expect(useAppStore.getState().sweepExpiredMessages(T0)).toEqual(['doomed'])

    // Refill from the swept feed: the cap trims exactly when it should.
    for (let i = 0; i < 500; i += 1) {
      store.appendMessage('room-1', userMessage({ id: `m${i}` }))
    }
    let room = useAppStore.getState().rooms['room-1']
    expect(room?.messages).toHaveLength(500)
    expect(room?.fifoTrimmed).toBe(false)

    store.appendMessage('room-1', userMessage({ id: 'm500' }))
    room = useAppStore.getState().rooms['room-1']
    expect(room?.messages).toHaveLength(500)
    expect(room?.messages[0]?.id).toBe('m1')
    expect(room?.fifoTrimmed).toBe(true)
  })

  it('keeps fifoTrimmed latched after expiry shrinks a trimmed feed', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    for (let i = 0; i < 501; i += 1) {
      store.appendMessage('room-1', userMessage({ id: `m${i}` }))
    }
    // The two TTL appends ride a full feed: each trims one session-lived row.
    store.appendMessage('room-1', userMessage({ id: 'x1', expiresAt: T0 }))
    store.appendMessage('room-1', userMessage({ id: 'x2', expiresAt: T0 }))

    expect(useAppStore.getState().sweepExpiredMessages(T0)).toEqual(['x1', 'x2'])
    const room = useAppStore.getState().rooms['room-1']
    expect(room?.messages).toHaveLength(498)
    // The trim flag never un-latches: history was already lost once.
    expect(room?.fifoTrimmed).toBe(true)

    store.appendMessage('room-1', userMessage({ id: 'tail' }))
    expect(useAppStore.getState().rooms['room-1']?.messages.at(-1)?.id).toBe('tail')
  })

  it('never revokes delivered receipts: removal is feed-state only', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.setActiveView({ kind: 'room', id: 'room-1' })
    store.appendMessage(
      'room-1',
      userMessage({ id: 'mine', authorId: 'self', status: 'delivered' }),
    )
    store.appendMessage('room-1', userMessage({ id: 'theirs', expiresAt: T0 }))

    useAppStore.getState().sweepExpiredMessages(T0)
    const own = useAppStore.getState().rooms['room-1']?.messages[0]
    expect(own?.id).toBe('mine')
    expect(own?.status).toBe('delivered')

    // A receipt for an id the sweep already removed: no crash, no change.
    expect(() => useAppStore.getState().markMessagesDelivered('room-1', ['theirs'])).not.toThrow()
    expect(useAppStore.getState().rooms['room-1']?.messages[0]?.status).toBe('delivered')
  })

  it('does not retro-decrement unread (same no-retro rule as mention notifications)', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom({ unread: 1 }))
    store.appendMessage('room-1', userMessage({ id: 'theirs', expiresAt: T0 }))

    useAppStore.getState().sweepExpiredMessages(T0)
    // The badge counts arrivals, not current rows: expiry is not a read.
    expect(useAppStore.getState().rooms['room-1']?.unread).toBe(2)
  })

  it('partitionExpired is inclusive at the boundary and keeps the kept-prefix order', () => {
    const messages = [
      userMessage({ id: 'a' }),
      userMessage({ id: 'b', expiresAt: T0 + 5 }),
      userMessage({ id: 'c' }),
      userMessage({ id: 'd', expiresAt: T0 }),
    ]
    // now == expiresAt is due; session-lived rows ('a', 'c') are never swept.
    const { kept, expired } = partitionExpired(messages, T0 + 5)
    expect(kept.map((message) => message.id)).toEqual(['a', 'c'])
    expect(expired.map((message) => message.id)).toEqual(['b', 'd'])
  })
})

describe('reaction state (issue #98 phase 2)', () => {
  beforeEach(() => {
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  it('toggleMessageReaction adds, is idempotent, removes and cleans empty state', () => {
    const base = userMessage({ id: 'm1' })
    const added = toggleMessageReaction(base, '👍', 'peer-1', true)
    expect(added.reactions).toEqual({ '👍': ['peer-1'] })

    // Re-adding (a broadcast echo, a full-mesh duplicate) must not double-add.
    expect(toggleMessageReaction(added, '👍', 'peer-1', true)).toBe(added)

    const removed = toggleMessageReaction(added, '👍', 'peer-1', false)
    expect(removed.reactions).toBeUndefined() // empty map → no ghost state

    // Removing an absent reactor is a no-op (same object, guarded write).
    expect(toggleMessageReaction(removed, '👍', 'peer-1', false)).toBe(removed)
    // ...and removal from a message without any reactions at all.
    expect(toggleMessageReaction(base, '👍', 'peer-1', false)).toBe(base)
  })

  it('keeps several emojis per message and removes only the toggled one', () => {
    let message = userMessage({ id: 'm1' })
    for (const emo of ['👍', '🎉']) {
      message = toggleMessageReaction(message, emo, 'peer-1', true)
    }
    expect(message.reactions).toEqual({ '👍': ['peer-1'], '🎉': ['peer-1'] })
    const removed = toggleMessageReaction(message, '👍', 'peer-1', false)
    expect(removed.reactions).toEqual({ '🎉': ['peer-1'] })
  })

  it('refuses non-whitelist emoji (the whitelist is the single emoji gate)', () => {
    const base = userMessage({ id: 'm1' })
    expect(toggleMessageReaction(base, '🚀', 'peer-1', true)).toBe(base)
  })

  it('refuses the 51st peerId on one emoji (cap, never evict)', () => {
    let message = userMessage({ id: 'm1' })
    for (let i = 0; i < MAX_REACTIONS_PER_EMOJI; i += 1) {
      message = toggleMessageReaction(message, '👍', `peer-${i}`, true)
    }
    const full = message
    expect(full.reactions?.['👍']).toHaveLength(MAX_REACTIONS_PER_EMOJI)
    expect(toggleMessageReaction(full, '👍', 'one-too-many', true)).toBe(full)
    // An existing reactor can still toggle off at the cap.
    expect(toggleMessageReaction(full, '👍', 'peer-0', false).reactions?.['👍']).toHaveLength(
      MAX_REACTIONS_PER_EMOJI - 1,
    )
  })

  it('refuses a new emoji key once the whole whitelist is in use', () => {
    // The wire cannot produce this state (parseReact only admits the same
    // REACT_EMOJIS the cap counts): it models hand-made or legacy seeds with
    // a non-whitelist key occupying a slot, so the reactions map is built
    // directly.
    const seededKeys = ['🚀', ...REACT_EMOJIS.slice(0, REACT_EMOJIS.length - 1)]
    const message = userMessage({
      id: 'm1',
      reactions: Object.fromEntries(seededKeys.map((emo) => [emo, ['peer-1']])),
    })
    expect(Object.keys(message.reactions ?? {})).toHaveLength(REACT_EMOJIS.length)
    const lastWhitelistEmoji = REACT_EMOJIS[REACT_EMOJIS.length - 1]
    expect(toggleMessageReaction(message, lastWhitelistEmoji, 'peer-2', true)).toBe(message)
    // An emoji already keyed stays toggleable at the full whitelist.
    expect(
      toggleMessageReaction(message, REACT_EMOJIS[0], 'peer-2', true).reactions?.[REACT_EMOJIS[0]],
    ).toEqual(['peer-1', 'peer-2'])
  })

  it('applyReactionsToMessages applies the known ids of a batch and drops unknown ones', () => {
    const messages = [userMessage({ id: 'm1' }), userMessage({ id: 'm2' })]
    const next = applyReactionsToMessages(messages, ['m1', 'ghost'], '👍', 'peer-1', true)
    expect(next?.[0]?.reactions).toEqual({ '👍': ['peer-1'] })
    expect(next?.[1]?.reactions).toBeUndefined()
  })

  it('applyReactionsToMessages returns null when nothing matched (guarded write)', () => {
    const messages = [userMessage({ id: 'm1' })]
    expect(applyReactionsToMessages(messages, ['ghost'], '👍', 'peer-1', true)).toBeNull()
    expect(applyReactionsToMessages(messages, [], '👍', 'peer-1', true)).toBeNull()
    // Idempotent re-apply: no change, null, same array object preserved.
    const applied = applyReactionsToMessages(messages, ['m1'], '👍', 'peer-1', true)
    expect(applyReactionsToMessages(applied ?? messages, ['m1'], '👍', 'peer-1', true)).toBeNull()
    expect((applied ?? messages)[0]?.reactions).toEqual({ '👍': ['peer-1'] })
  })

  it('store actions mutate only their slice and never touch unread or status', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom({ unread: 2 }))
    store.ensureDmChannel('peer-1', 'luna-cauta', null)
    store.appendMessage('room-1', userMessage({ id: 'room-msg' }))
    store.appendDmMessage(
      'peer-1',
      userMessage({ id: 'dm-msg', roomId: 'dm:peer-1', authorId: 'peer-1' }),
    )
    // An own 'sent' row must keep its status through every reaction write.
    store.appendMessage('room-1', userMessage({ id: 'own', authorId: 'self', status: 'sent' }))

    useAppStore
      .getState()
      .applyMessageReactions('room-1', ['room-msg', 'dm-msg'], '👍', 'peer-1', true)
    useAppStore
      .getState()
      .applyDmMessageReactions('peer-1', ['dm-msg', 'room-msg'], '❤️', 'peer-1', true)

    const room = useAppStore.getState().rooms['room-1']
    expect(room?.messages.find((m) => m.id === 'room-msg')?.reactions).toEqual({
      '👍': ['peer-1'],
    })
    expect(room?.messages.find((m) => m.id === 'own')?.status).toBe('sent')
    // unread: 2 seeded + 1 peer arrival; the reaction adds nothing.
    expect(room?.unread).toBe(3)
    const channel = useAppStore.getState().dms['peer-1']
    expect(channel?.messages.find((m) => m.id === 'dm-msg')?.reactions).toEqual({
      '❤️': ['peer-1'],
    })
    // The room batch's 'dm-msg' id must NOT have leaked into the dm slice.
    expect(channel?.messages.find((m) => m.id === 'dm-msg')?.reactions?.['👍']).toBeUndefined()
    // The peer's DM kept its arrival unread badge: reactions never touch it.
    expect(channel?.unread).toBe(1)
  })
})

describe('arrival order + 2 s ts-window (spec §7.3)', () => {
  const T0 = 1_760_000_000_000

  it('orders received messages by ts inside the 2 s window', () => {
    const a = userMessage({ id: 'a', ts: T0 })
    const b = userMessage({ id: 'b', ts: T0 + 1_500 })
    let acc = appendMessageCapped([], a)
    acc = appendMessageCapped(acc, b) // arrival order while no inversion
    expect(acc.map((message) => message.id)).toEqual(['a', 'b'])

    // A straggler authored between them but arriving last lands by ts.
    acc = appendMessageCapped(acc, userMessage({ id: 'late', ts: T0 + 200 }))
    expect(acc.map((message) => message.id)).toEqual(['a', 'late', 'b'])
  })

  it('keeps pure arrival order beyond the 2 s window', () => {
    let acc = appendMessageCapped([], userMessage({ id: 'a', ts: T0 }))
    acc = appendMessageCapped(acc, userMessage({ id: 'late', ts: T0 - 2_500 }))
    expect(acc.map((message) => message.id)).toEqual(['a', 'late'])
  })

  it('own echoes and system lines stay at the tail (barriers)', () => {
    let acc = appendMessageCapped([], userMessage({ id: 'a', ts: T0 + 1_000 }))
    acc = appendMessageCapped(acc, userMessage({ id: 'own', authorId: 'self', ts: T0 + 1_100 }))
    // Older than everything, but it must not cross the own message.
    acc = appendMessageCapped(acc, userMessage({ id: 'late', ts: T0 }))
    expect(acc.map((message) => message.id)).toEqual(['a', 'own', 'late'])

    const system = userMessage({ id: 'sys', authorId: 'system', kind: 'system', ts: T0 + 1_200 })
    acc = appendMessageCapped(acc, system)
    acc = appendMessageCapped(acc, userMessage({ id: 'late2', ts: T0 + 100 }))
    expect(acc.map((message) => message.id)).toEqual(['a', 'own', 'late', 'sys', 'late2'])
  })
})

describe('connection status texts (spec §10.3 exact)', () => {
  it('uses the exact spec strings', () => {
    expect(connectionStatusText('searching', 0)).toBe('Buscando pares en la red torrent…')
    expect(connectionStatusText('searching', 3)).toBe('Conectando (3 pares encontrados)…')
    expect(connectionStatusText('connected', 5)).toBe('Canal P2P establecido · 5 pares')
    expect(connectionStatusText('error', 0)).toBe(
      'Sin acceso a trackers — revisa tu conexión o configura trackers alternativos',
    )
  })
})

describe('latency dot (RF-06)', () => {
  it('follows the 🟢🟡🔴⚪ scale', () => {
    expect(latencyDot(null, false)).toBe('⚪')
    expect(latencyDot(200, true)).toBe('⚪')
    expect(latencyDot(20, false)).toBe('🟢')
    expect(latencyDot(149, false)).toBe('🟢')
    expect(latencyDot(150, false)).toBe('🟡')
    expect(latencyDot(400, false)).toBe('🟡')
    expect(latencyDot(401, false)).toBe('🔴')
  })
})

describe('room-name normalization (RF-02)', () => {
  it('normalizes names per the manager rules', async () => {
    const { normalizeRoomName } = await import('../src/lib/p2p/roomManager')
    expect(normalizeRoomName('  Mi Sala  ')).toBe('mi-sala')
    expect(normalizeRoomName('UPPER')).toBe('upper')
    expect(normalizeRoomName('a_b-c9')).toBe('a_b-c9')
    expect(normalizeRoomName('')).toBeNull()
    expect(normalizeRoomName('con espacios dobles')).toBe('con-espacios-dobles')
    expect(normalizeRoomName('mal nombre!')).toBeNull()
    expect(normalizeRoomName('ñ')).toBeNull() // outside [a-z0-9_-]
    expect(normalizeRoomName('a'.repeat(32))).toBe('a'.repeat(32))
    expect(normalizeRoomName('a'.repeat(33))).toBeNull()
    expect(INVALID_ROOM_NAME_TEXT).toBe(
      'Solo minúsculas, números, guiones y guion bajo (1–32 caracteres)',
    )
    expect(SUGGESTED_ROOMS).toEqual(['lobby', 'general', 'dev', 'random'])
  })
})

describe('feed presentation helpers', () => {
  it('decides smart scroll at ≤150 px (RF-03)', () => {
    expect(shouldAutoScroll(0)).toBe(true)
    expect(shouldAutoScroll(150)).toBe(true)
    expect(shouldAutoScroll(151)).toBe(false)
    expect(shouldAutoScroll(4000)).toBe(false)
  })

  it('formats HH:MM in local time', () => {
    // Local-date constructor → deterministic against local formatting.
    expect(formatTimeHHMM(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
    expect(formatTimeHHMM(new Date(2026, 5, 15, 23, 59).getTime())).toBe('23:59')
  })

  it('builds the system lines (RF-06)', () => {
    expect(joinSystemLine('luna-cauta')).toBe('— luna-cauta se ha unido —')
    expect(leaveSystemLine('luna-cauta')).toBe('— luna-cauta ha salido —')
  })

  it('builds the typing line (RF-03)', () => {
    expect(typingStatusText([])).toBeNull()
    expect(typingStatusText(['luna-cauta'])).toBe('luna-cauta está escribiendo…')
    expect(typingStatusText(['a', 'b'])).toBe('2 personas están escribiendo…')
    expect(typingStatusText(['a', 'b', 'c'])).toBe('3 personas están escribiendo…')
  })

  it('builds the new-messages button label (RF-03)', () => {
    expect(newMessagesButtonText(1)).toBe('↓ 1 mensaje nuevo')
    expect(newMessagesButtonText(7)).toBe('↓ 7 mensajes nuevos')
  })

  it('builds the expiry separator line (issue #96, FIFO-separator wording)', () => {
    expect(expiredSeparatorText(1)).toBe('— 1 mensaje expirado —')
    expect(expiredSeparatorText(3)).toBe('— 3 mensajes expirados —')
  })
})
