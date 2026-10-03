import { useAppStore, type Room } from '../stores/useAppStore'

/**
 * Subscribes to a single room slice of the app store. The RoomManager (M1)
 * is what populates these rooms; this hook only exposes the state to the UI.
 */
export function useRoom(roomId: string | null): Room | null {
  return useAppStore((state) =>
    roomId === null ? null : (state.rooms[roomId] ?? null),
  )
}
