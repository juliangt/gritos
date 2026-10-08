// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { deriveRoomId } from '../src/lib/crypto/hashes'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  // Some routing tests flip settings in the module-global store (e.g.
  // autoJoinLobby: false); start every test from the defaults again.
  useSettingsStore.getState().resetSettings()
  window.history.pushState({}, '', '/')
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
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
    expect(screen.getByLabelText('Your nickname')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'surprise me' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter →' })).toBeInTheDocument()
    // The spec one-liner, exactly as in §10.2.
    expect(
      screen.getByText(
        'No server, no accounts: your messages travel directly between browsers and disappear on reload.',
      ),
    ).toBeInTheDocument()
    // No chat shell yet.
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('skips onboarding when the store already holds an identity', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    expect(screen.queryByLabelText('Your nickname')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()

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
    expect(screen.queryByLabelText('Your nickname')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    // Drain the auto-join started by this mount BEFORE the next test
    // reinstalls the fake: a pending doJoinRoom continuation would
    // otherwise land in the following test's joinRoomFn (race flake).
    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalled()
    })
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
    expect(screen.queryByRole('form', { name: 'join a room' })).not.toBeInTheDocument()
    unmount()

    window.history.pushState({}, '', '/?debug')
    render(<App />)
    expect(screen.getByRole('form', { name: 'join a room' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the inline history-request card over the real chat
// shell: it is offered exactly while the active room's feed holds no chat
// rows (join lines don't count) and not dismissed this join; [Ask]
// dispatches one broadcast hist-req {n: 50} through the manager and either
// button dismisses (per-join, memory-only). Nothing is ever asked
// automatically.
// ---------------------------------------------------------------------------

const ASK_TEXT = 'Ask the room for the latest messages?'

describe('Issue #102 phase 3 — history request card (integration)', () => {
  async function renderLobby(): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)
    const lobbyRoomId = await deriveRoomId('lobby')
    await waitFor(() => {
      expect(useAppStore.getState().rooms[lobbyRoomId]).toBeDefined()
    })
    // Auto-join continuations from earlier mounts can land in this test's
    // fake (the documented drain race): the LIVE lobby connection is bound
    // to the LAST fake room created for that roomId, never rooms[0] blindly.
    const index = fake.configs.map((entry) => entry.roomId).lastIndexOf(lobbyRoomId)
    const room = fake.rooms[index]
    expect(room).toBeDefined()
    return { roomId: lobbyRoomId, room }
  }

  it('offers the ask on an empty-feed join; [Ask] sends hist-req {n: 50} once and dismisses', async () => {
    const { roomId, room } = await renderLobby()
    expect(screen.getByText(ASK_TEXT)).toBeInTheDocument()

    // The ask only dispatches once the room has a DataChannel (§10.3); a
    // tap while still searching parks it instead of dropping it.
    room.peerJoin('peer-1')
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => {
      expect(room.action('hist-req').sends).toHaveLength(1)
    })
    expect(room.action('hist-req').sends[0]?.data).toEqual({ n: 50 })
    expect(room.action('hist-req').sends[0]?.options).toBeUndefined() // broadcast

    // One tap, one ask: the card is gone for this join and nothing else is
    // sent automatically.
    expect(screen.queryByText(ASK_TEXT)).not.toBeInTheDocument()
    expect(useAppStore.getState().rooms[roomId]?.historyAskDismissed).toBe(true)
  })

  it('parks a [Ask] tapped while the room is still searching and flushes it on the first peer', async () => {
    const { room } = await renderLobby()
    expect(useAppStore.getState().activeView?.kind).toBe('room')

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(room.action('hist-req').sends).toHaveLength(0) // parked, not lost

    room.peerJoin('peer-1')
    await waitFor(() => {
      expect(room.action('hist-req').sends).toHaveLength(1)
    })
    expect(room.action('hist-req').sends[0]?.data).toEqual({ n: 50 })
  })

  it('[No] dismisses per room: a fresh empty room offers again, the dismissed one stays quiet', async () => {
    const { roomId: lobbyRoomId } = await renderLobby()
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.queryByText(ASK_TEXT)).not.toBeInTheDocument()

    // Another empty room joined later gets its own offer (per-room state).
    const dev = await manager.joinRoom('dev')
    act(() => {
      useAppStore.getState().setActiveView({ kind: 'room', id: dev.roomId })
    })
    expect(screen.getByText(ASK_TEXT)).toBeInTheDocument()

    // Back to the lobby: still dismissed for this join session.
    act(() => {
      useAppStore.getState().setActiveView({ kind: 'room', id: lobbyRoomId })
    })
    expect(screen.queryByText(ASK_TEXT)).not.toBeInTheDocument()
  })

  it('never offers once the feed holds a chat message', async () => {
    const { roomId: lobbyRoomId } = await renderLobby()
    act(() => {
      useAppStore.getState().appendMessage(lobbyRoomId, {
        id: 'live-1',
        roomId: lobbyRoomId,
        authorId: 'peer-1',
        authorNick: 'luna-cauta',
        text: 'hola desde el Live',
        ts: Date.now(),
        encrypted: false,
        status: 'delivered',
        kind: 'user',
      })
    })
    expect(screen.queryByText(ASK_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument()
  })
})
