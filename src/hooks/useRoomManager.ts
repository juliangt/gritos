import { useCallback, useEffect } from 'react'
import {
  ensureSessionIdentity,
  leaveRoom,
  reconnectAll,
  sendTestChat,
  setNickname,
  joinRoom,
} from '../lib/p2p/roomManager'

/**
 * UI-facing bridge to the RoomManager (plan §3: components never touch
 * WebSockets or crypto directly — only stores and hooks). The temporary M1
 * debug panel reads state via the app store and mutates connections only
 * through these callbacks.
 *
 * joinRoom resolves to null on success or to a human-readable error message
 * (e.g. the RF-02 cap rejection) so the panel can show it inline.
 */
export interface RoomManagerApi {
  joinRoom: (name: string, password?: string) => Promise<string | null>
  leaveRoom: (roomId: string) => void
  sendTestChat: (roomId: string, text: string) => void
  changeNickname: (nickname: string) => void
  reconnectAll: () => void
}

export function useRoomManager(): RoomManagerApi {
  // Bootstrap the ephemeral session identity once (idempotent in the manager).
  useEffect(() => {
    void ensureSessionIdentity().catch(() => {
      // No Web Crypto (non-secure context): the panel shows no identity and
      // joins are rejected by the manager until one exists.
    })
  }, [])

  const join = useCallback(async (name: string, password?: string) => {
    try {
      await joinRoom(name, password)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Error desconocido'
    }
  }, [])

  const leave = useCallback((roomId: string) => {
    void leaveRoom(roomId)
  }, [])

  const testChat = useCallback((roomId: string, text: string) => {
    sendTestChat(roomId, text)
  }, [])

  const changeNickname = useCallback((nickname: string) => {
    setNickname(nickname)
  }, [])

  const reconnect = useCallback(() => {
    void reconnectAll()
  }, [])

  return {
    joinRoom: join,
    leaveRoom: leave,
    sendTestChat: testChat,
    changeNickname: changeNickname,
    reconnectAll: reconnect,
  }
}
