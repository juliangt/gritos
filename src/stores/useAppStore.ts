import { create } from 'zustand'

/**
 * Base state types — spec.md §8.1.
 *
 * Everything here lives in memory only. The sole persistence surface of v1
 * is the `gritos:*` keys in `localStorage` (spec §8.2); messages, presence,
 * typing and passwords are never persisted.
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

export interface Message {
  id: string
  /** Room id, or `dm:<peerId>` for direct messages. */
  roomId: string
  /** Author peerId, or 'self' for our own messages. */
  authorId: string
  authorNick: string
  text: string
  ts: number
  /** Received encrypted with the room password (RF-05). */
  encrypted: boolean
  /** Only meaningful for our own messages (RF-03 receipts). */
  status: MessageStatus
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

export type ActiveView =
  | { kind: 'room'; id: string }
  | { kind: 'dm'; peerId: string }

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

/**
 * Ephemeral, memory-only app state. Actions are added by later milestones
 * (M1 wires the P2P events into it); M0 only establishes the typed shape.
 */
export const useAppStore = create<AppState>()(() => ({ ...INITIAL_APP_STATE }))
