import { create } from 'zustand'

/**
 * Base state types — spec.md §8.1.
 *
 * Everything here lives in memory only. The sole persistence surface of v1
 * is the `gritos:*` keys in `localStorage` (spec §8.2); messages, presence,
 * typing and passwords are never persisted. M1 adds the actions that the
 * RoomManager (lib/p2p) uses to wire P2P events into this state.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

export interface Settings {
  /** Join #lobby automatically on start. Default: true */
  autoJoinLobby: boolean
  /** Empty list = Trystero defaults; a non-empty list replaces them (RF-07). */
  trackers: string[]
  /** Empty list = Trystero defaults; supports stun: and turn: with credentials. */
  iceServers: RTCIceServer[]
  /** Simultaneous active rooms, 1..6. Default: 4 (RF-02). */
  maxActiveRooms: number
  /** Default: 'system', synced live with prefers-color-scheme (RF-10). */
  theme: ThemeChoice
  /** Desktop notifications; additionally requires browser permission. Default: false. */
  notifications: boolean
  /** Remember recent room names (names only, never content). Default: true. */
  rememberRooms: boolean
}

export interface Identity {
  nickname: string
  /** SHA-256 of the raw public key → hex, 4 groups of 4 (spec §9.1). */
  fingerprint: string
  createdAt: number
}

export interface Peer {
  /** Trystero peerId (stable per session). */
  id: string
  nickname: string
  /** Set once their `keys` action has been received. */
  fingerprint: string | null
  /** Last known RTT in ms. */
  latencyMs: number | null
  /** 3 consecutive pings without response (RF-06). */
  degraded: boolean
}

export type MessageStatus = 'sent' | 'delivered'

/**
 * M2 additive extension (spec §8.1 field names preserved): 'system' marks
 * the discrete join/leave and FIFO-cap separator lines (RF-03/RF-06).
 * Absent kind is treated as 'user'.
 */
export type MessageKind = 'user' | 'system'

export interface Message {
  id: string
  /** Room id, or `dm:<peerId>` for direct messages. */
  roomId: string
  /** Author peerId, 'self' for our own messages, 'system' for feed lines. */
  authorId: string
  authorNick: string
  text: string
  ts: number
  /** Received encrypted with the room password (RF-05). */
  encrypted: boolean
  /** Only meaningful for our own messages (RF-03 receipts). */
  status: MessageStatus
  kind?: MessageKind
}

export type RoomStatus = 'searching' | 'connected' | 'error'

export interface Room {
  /** Derived hash — spec §9.4. */
  id: string
  /** Normalized name, without '#'. */
  name: string
  hasPassword: boolean
  status: RoomStatus
  /** Peers of THIS room only. */
  peers: Peer[]
  /** Hard cap of 500 messages, FIFO discard (RF-03). */
  messages: Message[]
  /** peerId → timestamp of the last typing signal (expires after 4 s). */
  typing: Record<string, number>
  unread: number
  /** True once the FIFO cap has trimmed this room's history (RF-03). */
  fifoTrimmed: boolean
}

export interface DmChannel {
  peerId: string
  peerNick: string
  /** Hard cap of 500 messages, FIFO discard (RF-04). */
  messages: Message[]
  unread: number
  /** false once no active room is shared with the peer anymore. */
  available: boolean
}

export type ActiveView = { kind: 'room'; id: string } | { kind: 'dm'; peerId: string }

export interface AppState {
  identity: Identity | null
  /** Key: Room.id. */
  rooms: Record<string, Room>
  activeView: ActiveView | null
  /** Key: peerId. */
  dms: Record<string, DmChannel>
  /** Room names only, never content. */
  recentRooms: string[]
}

export const INITIAL_APP_STATE: AppState = {
  identity: null,
  rooms: {},
  activeView: null,
  dms: {},
  recentRooms: [],
}

/** RF-03 — memory cap: at most the last 500 messages per room. */
export const MESSAGE_CAP = 500

/** Pure FIFO-cap append used by the store action (testable in isolation). */
export function appendMessageCapped(
  messages: Message[],
  message: Message,
  cap: number = MESSAGE_CAP,
): Message[] {
  const next = [...messages, message]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * spec §10.3 — exact connection status header texts, including the
 * best-effort transition state (searching with peers already discovered but
 * no DataChannel yet): "Conectando (N pares encontrados)…".
 */
export function connectionStatusText(status: RoomStatus, peerCount: number): string {
  switch (status) {
    case 'searching':
      return peerCount > 0
        ? `Conectando (${peerCount} pares encontrados)…`
        : 'Buscando pares en la red torrent…'
    case 'connected':
      return `Canal P2P establecido · ${peerCount} pares`
    case 'error':
      return 'Sin acceso a trackers — revisa tu conexión o configura trackers alternativos'
  }
}

/** RF-06 — latency dot: 🟢 <150 ms, 🟡 150–400 ms, 🔴 >400 ms, ⚪ sin datos/degradado. */
export function latencyDot(latencyMs: number | null, degraded: boolean): string {
  if (degraded || latencyMs === null) return '⚪'
  if (latencyMs < 150) return '🟢'
  if (latencyMs <= 400) return '🟡'
  return '🔴'
}

/**
 * Actions used by the RoomManager to feed P2P events into the state.
 * All updates are immutable; actions targeting an unknown room no-op so
 * a leave/join race can never corrupt the state.
 */
export interface AppActions {
  setIdentity: (identity: Identity) => void
  setNickname: (nickname: string) => void
  upsertRoom: (room: Room) => void
  removeRoom: (roomId: string) => void
  setRoomStatus: (roomId: string, status: RoomStatus) => void
  addPeer: (roomId: string, peer: Peer) => void
  updatePeer: (roomId: string, peerId: string, patch: Partial<Peer>) => void
  removePeer: (roomId: string, peerId: string) => void
  appendMessage: (roomId: string, message: Message) => void
  markMessagesDelivered: (roomId: string, ids: string[]) => void
  /** ts = null clears the peer's typing entry. */
  setTyping: (roomId: string, peerId: string, ts: number | null) => void
  /**
   * M2 — switches the focused view without touching any room connection
   * (RF-02); opening a room clears its unread badge.
   */
  setActiveView: (view: ActiveView | null) => void
  /** M2 — recent room names, most-recent-first (RF-02, §8.2). */
  setRecentRooms: (recent: string[]) => void
}

export const useAppStore = create<AppState & AppActions>()((set) => ({
  ...INITIAL_APP_STATE,

  setIdentity: (identity) => set({ identity }),

  setNickname: (nickname) =>
    set((state) => ({
      identity: state.identity === null ? null : { ...state.identity, nickname },
    })),

  upsertRoom: (room) => set((state) => ({ rooms: { ...state.rooms, [room.id]: room } })),

  removeRoom: (roomId) =>
    set((state) => {
      if (!(roomId in state.rooms)) return state
      const rooms = { ...state.rooms }
      delete rooms[roomId]
      return { rooms }
    }),

  setRoomStatus: (roomId, status) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room || room.status === status) return state
      return {
        rooms: { ...state.rooms, [roomId]: { ...room, status } },
      }
    }),

  addPeer: (roomId, peer) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const peers = [...room.peers.filter((p) => p.id !== peer.id), peer]
      return { rooms: { ...state.rooms, [roomId]: { ...room, peers } } }
    }),

  updatePeer: (roomId, peerId, patch) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      let changed = false
      const peers = room.peers.map((peer) => {
        if (peer.id !== peerId) return peer
        changed = true
        return { ...peer, ...patch }
      })
      return changed ? { rooms: { ...state.rooms, [roomId]: { ...room, peers } } } : state
    }),

  removePeer: (roomId, peerId) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const peers = room.peers.filter((peer) => peer.id !== peerId)
      if (peers.length === room.peers.length) return state
      return { rooms: { ...state.rooms, [roomId]: { ...room, peers } } }
    }),

  appendMessage: (roomId, message) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const messages = appendMessageCapped(room.messages, message)
      const fifoTrimmed = room.fifoTrimmed || messages.length < room.messages.length + 1
      // RF-02 — messages arriving in non-focused rooms increment the unread
      // badge; own messages and system lines never do.
      const isActiveView = state.activeView?.kind === 'room' && state.activeView.id === roomId
      const countsAsUnread =
        message.authorId !== 'self' && message.kind !== 'system' && !isActiveView
      return {
        rooms: {
          ...state.rooms,
          [roomId]: {
            ...room,
            messages,
            fifoTrimmed,
            unread: countsAsUnread ? room.unread + 1 : room.unread,
          },
        },
      }
    }),

  markMessagesDelivered: (roomId, ids) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const idSet = new Set(ids)
      let changed = false
      const messages = room.messages.map((message) => {
        if (message.authorId !== 'self' || !idSet.has(message.id)) return message
        if (message.status === 'delivered') return message
        changed = true
        return { ...message, status: 'delivered' as const }
      })
      return changed ? { rooms: { ...state.rooms, [roomId]: { ...room, messages } } } : state
    }),

  setTyping: (roomId, peerId, ts) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      if (ts === null && !(peerId in room.typing)) return state
      const typing = { ...room.typing }
      if (ts === null) delete typing[peerId]
      else typing[peerId] = ts
      return { rooms: { ...state.rooms, [roomId]: { ...room, typing } } }
    }),

  setActiveView: (view) =>
    set((state) => {
      if (view === null) return { activeView: null }
      // Opening a room clears its unread badge (RF-02).
      if (view.kind === 'room') {
        const room = state.rooms[view.id]
        if (room !== undefined && room.unread > 0) {
          return {
            activeView: view,
            rooms: {
              ...state.rooms,
              [view.id]: { ...room, unread: 0 },
            },
          }
        }
      }
      return { activeView: view }
    }),

  setRecentRooms: (recent) => set({ recentRooms: recent }),
}))
