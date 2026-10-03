import type { RoomStatus } from '../../stores/useAppStore'

/**
 * The single Trystero surface of the app (plan.md §3 architecture rules:
 * only this module may import trystero). The real multi-room core lands
 * in M1; this file deliberately does NOT import trystero yet so M0 keeps
 * a dependency-light, fully buildable foundation.
 */

/** spec §9.4 — constant Trystero appId. */
export const APP_ID = 'gritos-app-v1'

export interface JoinRoomOptions {
  /** Normalized room name, without '#' (RF-02). */
  name: string
  /** When present, the roomId is derived from it: hidden room (RF-05). */
  password?: string
}

export interface RoomConnection {
  roomId: string
  name: string
  hasPassword: boolean
  status: RoomStatus
  peerIds: string[]
}

/** Joins (or re-uses) a room connection, honoring the maxActiveRooms cap. */
export function joinRoom(_options: JoinRoomOptions): RoomConnection {
  throw new Error('not implemented: P2P core lands in M1 (plan §4)')
}

/** Closes the room's mesh and frees its resources (RF-02). */
export function leaveRoom(_roomId: string): void {
  throw new Error('not implemented: P2P core lands in M1 (plan §4)')
}

/** Re-joins every active room applying the current network settings (RF-07). */
export function reconnectAll(): void {
  throw new Error('not implemented: P2P core lands in M1 (plan §4)')
}
