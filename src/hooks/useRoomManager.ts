import { useCallback, useEffect } from 'react'
import {
  adoptSessionIdentity,
  ensureSessionIdentity,
  leaveRoom,
  reconnectAll,
  sendChat,
  sendTestChat,
  sendTyping,
  setNickname,
  joinRoom,
} from '../lib/p2p/roomManager'
import { createSessionIdentity, persistIdentity } from '../lib/crypto/identity'
import { useAppStore } from '../stores/useAppStore'

/**
 * UI-facing bridge to the RoomManager (plan §3: components never touch
 * WebSockets or Web Crypto directly — only stores and hooks).
 *
 * joinRoom resolves to null on success or to a human-readable error message
 * (e.g. the RF-02 cap rejection) so callers can show it inline.
 */
export interface RoomManagerApi {
  joinRoom: (name: string, password?: string) => Promise<string | null>
  /** Joins AND focuses the room (setActiveView clears its unread). */
  joinRoomFocused: (
    name: string,
    password?: string,
  ) => Promise<{ roomId: string | null; error: string | null }>
  leaveRoom: (roomId: string) => void
  sendChat: (roomId: string, text: string) => void
  sendTyping: (roomId: string, on: boolean) => void
  sendTestChat: (roomId: string, text: string) => void
  changeNickname: (nickname: string) => void
  reconnectAll: () => void
  /**
   * RF-01 entry point: creates the session identity for `nickname`,
   * persists the profile under `gritos:identity` and installs it in the
   * manager/store. Keypair JWK persistence itself lands in M3.
   */
  enterWithNickname: (nickname: string) => Promise<void>
}

export interface UseRoomManagerOptions {
  /**
   * Bootstraps an ephemeral session identity on mount. The onboarding
   * screen opts OUT: its identity (nickname + fresh keypair) is created on
   * 'Entrar' and must not be replaced by an anonymous ephemeral one.
   */
  ensureIdentity?: boolean
}

export function useRoomManager(options: UseRoomManagerOptions = {}): RoomManagerApi {
  const { ensureIdentity = true } = options
  // Bootstrap the ephemeral session identity once (idempotent in the manager).
  useEffect(() => {
    if (!ensureIdentity) return
    void ensureSessionIdentity().catch(() => {
      // No Web Crypto (non-secure context): the panel shows no identity and
      // joins are rejected by the manager until one exists.
    })
  }, [ensureIdentity])

  const join = useCallback(async (name: string, password?: string) => {
    try {
      await joinRoom(name, password)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Error desconocido'
    }
  }, [])

  const joinFocused = useCallback(async (name: string, password?: string) => {
    try {
      const connection = await joinRoom(name, password)
      useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
      return { roomId: connection.roomId, error: null }
    } catch (error) {
      return {
        roomId: null,
        error: error instanceof Error ? error.message : 'Error desconocido',
      }
    }
  }, [])

  const leave = useCallback((roomId: string) => {
    void leaveRoom(roomId)
  }, [])

  const chat = useCallback((roomId: string, text: string) => {
    sendChat(roomId, text)
  }, [])

  const typing = useCallback((roomId: string, on: boolean) => {
    sendTyping(roomId, on)
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

  const enterWithNickname = useCallback(async (nickname: string) => {
    const session = await createSessionIdentity(nickname)
    persistIdentity({
      nickname,
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
    })
    adoptSessionIdentity(session)
  }, [])

  return {
    joinRoom: join,
    joinRoomFocused: joinFocused,
    leaveRoom: leave,
    sendChat: chat,
    sendTyping: typing,
    sendTestChat: testChat,
    changeNickname: changeNickname,
    reconnectAll: reconnect,
    enterWithNickname,
  }
}
