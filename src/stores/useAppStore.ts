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
  /**
   * Keep TURN credentials in this browser's storage (issue #30). When false
   * they stay in memory for the session only: the persisted `gritos:settings`
   * JSON drops them, so a reload requires re-entering them. Default: true.
   */
  rememberTurnCredentials: boolean
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
  /**
   * Set once their `keys` action has been received. Issue #22 (TOFU): when
   * the peer's live key diverges from the pinned first-seen fingerprint
   * (`gritos:tofu`), this holds the pinned value — the authoritative
   * displayed identity.
   */
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
  /**
   * M3 additive field (spec §8.1 field names preserved): fingerprint derived
   * from the peer's `keys` action — the crypto-trusted value shown in the
   * DM header for TOFU verification.
   */
  peerFingerprint: string | null
  /** Hard cap of 500 messages, FIFO discard (RF-04). */
  messages: Message[]
  unread: number
  /** false once no active room is shared with the peer anymore. */
  available: boolean
  /**
   * M3 additive field: peerId → timestamp of the last DM typing signal
   * (RF-04: DMs inherit typing); expires after 4 s like room typing.
   */
  typing: Record<string, number>
  /**
   * Issue #22 (TOFU): true while the peer's live fingerprint differs from
   * the pinned first-seen one (`gritos:tofu`). Advisory only — messages
   * keep flowing; the header warns and `peerFingerprint` stays pinned.
   */
  keyChanged: boolean
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

/**
 * spec §7.3 — order: messages are shown in arrival order, but inside a 2 s
 * window they are ordered by `ts`. A received message only walks back over
 * recent USER messages; own echoes and local system lines stay at the tail
 * (the user typed them there) and act as barriers.
 */
export const ARRIVAL_ORDER_WINDOW_MS = 2_000

/**
 * Pure FIFO-cap append used by the store action (testable in isolation).
 * Implements the §7.3 order rule: plain append for own/system messages,
 * ts-ordered insertion inside ARRIVAL_ORDER_WINDOW_MS for received ones.
 */
export function appendMessageCapped(
  messages: Message[],
  message: Message,
  cap: number = MESSAGE_CAP,
): Message[] {
  let index = messages.length
  if (message.authorId !== 'self' && message.kind !== 'system') {
    while (index > 0) {
      const previous = messages[index - 1] as Message
      if (
        previous.kind !== 'user' ||
        previous.authorId === 'self' ||
        !(
          message.ts < previous.ts &&
          previous.ts - message.ts <= ARRIVAL_ORDER_WINDOW_MS
        )
      ) {
        break
      }
      index -= 1
    }
  }
  const next = [...messages.slice(0, index), message, ...messages.slice(index)]
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
   * (RF-02); opening a room or a DM clears its unread badge (RF-04).
   */
  setActiveView: (view: ActiveView | null) => void
  /** M2 — recent room names, most-recent-first (RF-02, §8.2). */
  setRecentRooms: (recent: string[]) => void
  /**
   * M3 — creates the DM channel for `peerId` when missing (RF-04); an
   * existing channel only gets its fingerprint refreshed when a non-null
   * one is provided (nickname history is kept).
   */
  ensureDmChannel: (peerId: string, peerNick: string, peerFingerprint: string | null) => void
  /** M3 — appends to `dms[peerId]` with the 500-message cap (RF-04). */
  appendDmMessage: (peerId: string, message: Message) => void
  /** M3 — flips own DM messages to 'delivered' on the peer's receipt. */
  markDmMessagesDelivered: (peerId: string, ids: string[]) => void
  /** M3 — recomputes `available` after peer/room changes (RF-04). */
  setDmAvailable: (peerId: string, available: boolean) => void
  /** M3 — DM typing signal (ts = null clears); expires after 4 s. */
  setDmTyping: (peerId: string, ts: number | null) => void
  /**
   * Issue #22 — flips the channel's TOFU divergence flag. While true, the
   * pinned fingerprint is authoritative for display: `ensureDmChannel`
   * never overwrites it with the live one.
   */
  setDmKeyChanged: (peerId: string, keyChanged: boolean) => void
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
      // Opening a room clears its unread badge (RF-02); opening a DM does
      // the same for its channel (RF-04).
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
      if (view.kind === 'dm') {
        const channel = state.dms[view.peerId]
        if (channel !== undefined && channel.unread > 0) {
          return {
            activeView: view,
            dms: {
              ...state.dms,
              [view.peerId]: { ...channel, unread: 0 },
            },
          }
        }
      }
      return { activeView: view }
    }),

  setRecentRooms: (recent) => set({ recentRooms: recent }),

  ensureDmChannel: (peerId, peerNick, peerFingerprint) =>
    set((state) => {
      const existing = state.dms[peerId]
      if (existing === undefined) {
        return {
          dms: {
            ...state.dms,
            [peerId]: {
              peerId,
              peerNick,
              peerFingerprint,
              messages: [],
              unread: 0,
              available: false,
              typing: {},
              keyChanged: false,
            },
          },
        }
      }
      // Issue #22 (TOFU): a flagged channel keeps its pinned fingerprint —
      // a rotated live value never silently overwrites the verified one.
      if (existing.keyChanged) return state
      if (peerFingerprint !== null && existing.peerFingerprint !== peerFingerprint) {
        return {
          dms: { ...state.dms, [peerId]: { ...existing, peerFingerprint } },
        }
      }
      return state
    }),

  appendDmMessage: (peerId, message) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      const messages = appendMessageCapped(channel.messages, message)
      // RF-04 — peer messages in non-focused DMs increment the unread badge;
      // own messages never do.
      const isActiveView =
        state.activeView?.kind === 'dm' && state.activeView.peerId === peerId
      const countsAsUnread = message.authorId !== 'self' && message.kind !== 'system' && !isActiveView
      return {
        dms: {
          ...state.dms,
          [peerId]: {
            ...channel,
            messages,
            unread: countsAsUnread ? channel.unread + 1 : channel.unread,
          },
        },
      }
    }),

  markDmMessagesDelivered: (peerId, ids) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      const idSet = new Set(ids)
      let changed = false
      const messages = channel.messages.map((message) => {
        if (message.authorId !== 'self' || !idSet.has(message.id)) return message
        if (message.status === 'delivered') return message
        changed = true
        return { ...message, status: 'delivered' as const }
      })
      return changed ? { dms: { ...state.dms, [peerId]: { ...channel, messages } } } : state
    }),

  setDmAvailable: (peerId, available) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined || channel.available === available) return state
      // true→false keeps the history in memory (RF-04) — only the flag flips.
      return { dms: { ...state.dms, [peerId]: { ...channel, available } } }
    }),

  setDmTyping: (peerId, ts) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      if (ts === null && !(peerId in channel.typing)) return state
      const typing = { ...channel.typing }
      if (ts === null) delete typing[peerId]
      else typing[peerId] = ts
      return { dms: { ...state.dms, [peerId]: { ...channel, typing } } }
    }),

  setDmKeyChanged: (peerId, keyChanged) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined || channel.keyChanged === keyChanged) return state
      return { dms: { ...state.dms, [peerId]: { ...channel, keyChanged } } }
    }),
}))
