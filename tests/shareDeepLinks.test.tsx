// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { joinRoom, resetManagerForTests, setJoinRoomFactory } from '../src/lib/p2p/roomManager'
import { deriveRoomId } from '../src/lib/crypto/hashes'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #41 — '#sala=<name>' deep links end to end: a returning visitor
 * lands in the linked room (hash consumed), a first visit carries the room
 * through onboarding, failures degrade to the current behavior, and a link
 * to a password room ends in the regular password join flow — never in the
 * URL or localStorage.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  setJoinRoomFactory(null)
  window.history.pushState({}, '', '/')
  vi.useRealTimers()
})

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

describe('deep links — chat shell (existing identity)', () => {
  it('lands in the linked room, focuses it and consumes the hash', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=test')
    render(<App />)

    const linkedRoomId = await deriveRoomId('test')
    await waitFor(() => {
      expect(useAppStore.getState().rooms[linkedRoomId]).toBeDefined()
    })
    // The linked room is the destination even though the lobby auto-join
    // also ran (default settings).
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: linkedRoomId })
    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalledTimes(2) // lobby + link
    })
    // The header shows the linked room; the hash is gone (a reload would
    // not re-trigger the join).
    expect(screen.getByRole('heading', { name: '#test' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })

  it('joins only the linked room when autoJoinLobby is off', async () => {
    useSettingsStore.getState().setSettings({ autoJoinLobby: false })
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=mi-sala')
    render(<App />)

    const linkedRoomId = await deriveRoomId('mi-sala')
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: linkedRoomId })
    })
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('')
  })

  it('degrades to the current behavior on an invalid linked name', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=!!nope!!')
    render(<App />)

    const lobbyRoomId = await deriveRoomId('lobby')
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: lobbyRoomId })
    })
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1) // lobby only
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })

  it('degrades gracefully when the linked join hits the room cap', async () => {
    // The manager checks the cap BEFORE the join dedup, so a full cap fails
    // every boot join (lobby re-join included): nothing may crash and the
    // shell must stay usable.
    useSettingsStore.getState().setSettings({ maxActiveRooms: 1 })
    await joinRoom('lobby') // takes the only slot before the app mounts
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=otra')
    render(<App />)

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(useAppStore.getState().activeView).toBeNull()
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '[+ Join]' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })
})

describe('deep links — onboarding carry-through', () => {
  it('lands a first visit in the linked room after the nickname', async () => {
    window.history.pushState({}, '', '/#sala=pueblo-libre')
    render(<App />)

    // The onboarding screen announces the linked room.
    expect(screen.getByText('#pueblo-libre')).toBeInTheDocument()
    expect(screen.getByText(/from the shared link\./)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Your nickname'), {
      target: { value: 'zorro-bravo' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'enter' }))

    await waitFor(() => {
      expect(useAppStore.getState().identity?.nickname).toBe('zorro-bravo')
    })
    const linkedRoomId = await deriveRoomId('pueblo-libre')
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: linkedRoomId })
    })
    expect(window.location.hash).toBe('')
  })

  it('carries the link through onboarding even with autoJoinLobby off', async () => {
    useSettingsStore.getState().setSettings({ autoJoinLobby: false })
    window.history.pushState({}, '', '/#sala=duo')
    render(<App />)

    fireEvent.change(screen.getByLabelText('Your nickname'), {
      target: { value: 'zorro-bravo' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'enter' }))

    const linkedRoomId = await deriveRoomId('duo')
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: linkedRoomId })
    })
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('')
  })
})

describe('deep links — password rooms (RF-05)', () => {
  it('offers the prefilled password join form once the link cannot find peers', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=secreta')
    render(<App />)

    // The no-password join lands in the public namespace, which can never
    // find the password room's peers.
    const publicRoomId = await deriveRoomId('secreta')
    await waitFor(() => {
      expect(useAppStore.getState().rooms[publicRoomId]).toBeDefined()
    })
    expect(window.location.hash).toBe('')

    // Exhaust the not-found heuristic.
    useAppStore.getState().setRoomStatus(publicRoomId, 'error')

    // The existing password-room join flow appears, prefilled with the
    // linked name; the URL carries no password ever.
    const recovery = await screen.findByRole('region', { name: 'Join with password' })
    expect(within(recovery).getByLabelText('Room name')).toHaveValue('secreta')

    fireEvent.click(within(recovery).getByLabelText('encrypted room'))
    fireEvent.change(within(recovery).getByLabelText('Room password'), {
      target: { value: 'clave-secreta' },
    })
    fireEvent.submit(within(recovery).getByRole('form', { name: 'Join by name' }))

    const passwordRoomId = await deriveRoomId('secreta', 'clave-secreta')
    await waitFor(() => {
      expect(fake.configs.some((entry) => entry.roomId === passwordRoomId)).toBe(true)
      expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: passwordRoomId })
    })
    expect(useAppStore.getState().rooms[passwordRoomId]?.hasPassword).toBe(true)

    // The password never leaks into the URL or localStorage.
    expect(window.location.hash).not.toContain('clave-secreta')
    for (const key of Object.keys(localStorage)) {
      expect(localStorage.getItem(key)).not.toContain('clave-secreta')
    }
  })

  it('the recovery form can be dismissed', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    window.history.pushState({}, '', '/#sala=secreta')
    render(<App />)

    const publicRoomId = await deriveRoomId('secreta')
    await waitFor(() => {
      expect(useAppStore.getState().rooms[publicRoomId]).toBeDefined()
    })
    useAppStore.getState().setRoomStatus(publicRoomId, 'error')

    await screen.findByRole('region', { name: 'Join with password' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Join with password' })).not.toBeInTheDocument()
    })
  })
})
