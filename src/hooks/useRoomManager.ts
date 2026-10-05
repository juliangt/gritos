import { useCallback, useEffect } from 'react'
import {
  adoptSessionIdentity,
  ensureSessionIdentity,
  leaveRoom,
  openDmChannel,
  reconnectAll,
  regenerateSessionIdentity,
  sendChat,
  sendDm,
  sendDmTyping,
  sendTyping,
  setNickname,
  joinRoom,
} from '../lib/p2p/roomManager'
import {
  createSessionIdentity,
  exportIdentityJwks,
  persistIdentity,
} from '../lib/crypto/identity'
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
  /** M3 (RF-04) — encrypts and broadcasts a DM; null when it cannot send. */
  sendDm: (peerId: string, text: string) => Promise<boolean>
  /** M3 — directed DM typing signal. */
  sendDmTyping: (peerId: string, on: boolean) => void
  /** M3 — opens the DM channel with a peer and focuses it. */
  openDm: (peerId: string) => boolean
  changeNickname: (nickname: string) => void
  reconnectAll: () => void
  /**
   * M5 (RF-07) — regenerates the cryptographic identity (new fingerprint),
   * persists it and re-announces presence + keys. No-op without a session.
   */
  regenerateIdentity: () => Promise<void>
  /**
   * RF-01 entry point: creates the session identity for `nickname`,
   * persists it — profile plus the §8.2 JWK pair since M3 — under
   * `gritos:identity` and installs it in the manager/store.
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

  const dm = useCallback(
    (peerId: string, text: string) => sendDm(peerId, text).then((envelope) => envelope !== null),
    [],
  )

  const dmTyping = useCallback((peerId: string, on: boolean) => {
    sendDmTyping(peerId, on)
  }, [])

  const openDm = useCallback((peerId: string) => openDmChannel(peerId), [])

  const changeNickname = useCallback((nickname: string) => {
    setNickname(nickname)
  }, [])

  const reconnect = useCallback(() => {
    void reconnectAll()
  }, [])

  const regenerate = useCallback(async () => {
    await regenerateSessionIdentity()
  }, [])

  const enterWithNickname = useCallback(async (nickname: string) => {
    const session = await createSessionIdentity(nickname)
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    // Awaited on purpose (issue #24: the write wraps the private key): once
    // the identity shows up in the store, `gritos:identity` is already on
    // disk for the next reload.
    await persistIdentity({
      nickname,
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })
    adoptSessionIdentity(session)
  }, [])

  return {
    joinRoom: join,
    joinRoomFocused: joinFocused,
    leaveRoom: leave,
    sendChat: chat,
    sendTyping: typing,
    sendDm: dm,
    sendDmTyping: dmTyping,
    openDm,
    changeNickname: changeNickname,
    reconnectAll: reconnect,
    regenerateIdentity: regenerate,
    enterWithNickname,
  }
}
