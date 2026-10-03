// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { deriveRoomId } from '../src/lib/crypto/hashes'
import { installFakeTrystero } from './fakeTrystero'

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  vi.useRealTimers()
})

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

describe('App routing (M2: onboarding | chat shell)', () => {
  it('shows the onboarding screen on a first visit (RF-01)', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'gritos' })).toBeInTheDocument()
    expect(screen.getByLabelText('Tu apodo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'sorpréndeme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entrar →' })).toBeInTheDocument()
    // The spec one-liner, exactly as in §10.2.
    expect(
      screen.getByText(
        'Sin servidor, sin cuentas: tus mensajes viajan directos entre navegadores y desaparecen al recargar.',
      ),
    ).toBeInTheDocument()
    // No chat shell yet.
    expect(screen.queryByRole('button', { name: 'Ajustes' })).not.toBeInTheDocument()
  })

  it('skips onboarding when the store already holds an identity', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    expect(screen.queryByLabelText('Tu apodo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ajustes' })).toBeInTheDocument()

    // RF-01/RF-07 — auto-join #lobby with autoJoinLobby on (default).
    const lobbyRoomId = await deriveRoomId('lobby')
    await waitFor(() => {
      expect(useAppStore.getState().rooms[lobbyRoomId]).toBeDefined()
    })
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: lobbyRoomId })
    expect(useAppStore.getState().rooms[lobbyRoomId]?.name).toBe('lobby')
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
  })

  it('restores the persisted identity profile from gritos:identity (§8.2)', async () => {
    localStorage.setItem('gritos:identity', JSON.stringify(IDENTITY))
    render(<App />)

    // Onboarding skipped; the chat shell shows up directly.
    await waitFor(() => {
      expect(useAppStore.getState().identity?.nickname).toBe('zorro-bravo')
    })
    expect(screen.queryByLabelText('Tu apodo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ajustes' })).toBeInTheDocument()
  })

  it('does not auto-join when autoJoinLobby is off (RF-01 acceptance)', async () => {
    const { useSettingsStore } = await import('../src/stores/useSettingsStore')
    useSettingsStore.getState().setSettings({ autoJoinLobby: false })
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeView).toBeNull()
  })

  it('shows the M1 debug panel only behind the ?debug flag', async () => {
    useAppStore.getState().setIdentity(IDENTITY)

    const { unmount } = render(<App />)
    expect(screen.queryByRole('form', { name: 'unirse a sala' })).not.toBeInTheDocument()
    unmount()

    window.history.pushState({}, '', '/?debug')
    render(<App />)
    expect(screen.getByRole('form', { name: 'unirse a sala' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unirse' })).toBeInTheDocument()
  })
})
