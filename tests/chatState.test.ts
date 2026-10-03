import { beforeEach, describe, expect, it } from 'vitest'
import {
  INITIAL_APP_STATE,
  appendMessageCapped,
  connectionStatusText,
  latencyDot,
  useAppStore,
  type Message,
  type Room,
} from '../src/stores/useAppStore'
import { INVALID_ROOM_NAME_TEXT, SUGGESTED_ROOMS } from '../src/lib/rooms'
import {
  FIFO_SEPARATOR_TEXT,
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
})
