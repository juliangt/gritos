// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsModal } from '../src/components/settings/SettingsModal'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import * as manager from '../src/lib/p2p/roomManager'
import {
  ICE_ERROR_TEXT,
  MAX_ROOMS_ERROR_TEXT,
  P2P_IP_EXPOSURE_NOTE,
  SHARE_HISTORY_HINT,
  SHARE_HISTORY_LABEL,
  TRACKER_ERROR_TEXT,
  TURN_CREDENTIAL_MEMORY_HINT,
  TURN_CREDENTIAL_STORAGE_HINT,
} from '../src/components/settings/messages'
import { NICKNAME_ERROR_TEXT } from '../src/lib/nickname'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { useUiStore } from '../src/stores/useUiStore'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * M5 (RF-07/RF-08/RF-10): the settings modal with the Network / Privacy /
 * Appearance tabs — exact English control wording, instant persistence to
 * the stores, inline validation errors, the permission flow, identity
 * regeneration, the panic double confirmation and the nickname change with
 * persistence + presence re-announce.
 */

let fake: ReturnType<typeof installFakeTrystero>

class FakeNotification {
  static permission = 'default'
  static requestPermission = vi.fn(async () => 'granted')
}

function stubNotification(permission: string): void {
  FakeNotification.permission = permission
  // The browser flips its static permission when the user answers the prompt.
  FakeNotification.requestPermission = vi.fn(async () => {
    FakeNotification.permission = 'granted'
    return 'granted'
  })
  vi.stubGlobal('Notification', FakeNotification)
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  useUiStore.setState({ sidebarCollapsed: false })
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function renderModal(): void {
  render(<SettingsModal open onClose={() => {}} />)
}

function openTab(label: string): void {
  fireEvent.click(screen.getByRole('tab', { name: label }))
}

function rawSettings(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as Record<string, unknown>
}

describe('SettingsModal shell (RF-07, RNF-05)', () => {
  it('opens from the header gear and shows the three tabs', () => {
    render(<ChatHeader room={null} onToggleSidebar={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Network' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Privacy' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('closes on the ✕ button, Escape and the backdrop', () => {
    const onClose = vi.fn()
    render(<SettingsModal open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    fireEvent.mouseDown(dialog.parentElement as HTMLElement, { target: dialog.parentElement })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('switching tabs shows each tab panel', () => {
    renderModal()
    expect(screen.getByText('Auto-join #lobby on start')).toBeInTheDocument()

    openTab('Privacy')
    expect(screen.getByText('Desktop notifications')).toBeInTheDocument()

    openTab('Appearance')
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()

    openTab('Network')
    expect(screen.getByText('Auto-join #lobby on start')).toBeInTheDocument()
  })
})

describe('Red tab (RF-07)', () => {
  it('persists autoJoinLobby instantly to the store and gritos:settings', () => {
    renderModal()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-join #lobby on start' }))
    expect(useSettingsStore.getState().settings.autoJoinLobby).toBe(false)
    expect(rawSettings().autoJoinLobby).toBe(false)
  })

  it('shows the defaults hint and validates the wss:// scheme on trackers', () => {
    renderModal()
    expect(
      screen.getByText('Empty list: Trystero’s default trackers are used.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add tracker' }))
    const input = screen.getByLabelText('Tracker 1')
    fireEvent.change(input, { target: { value: 'http://no' } })
    expect(screen.getByRole('alert')).toHaveTextContent(TRACKER_ERROR_TEXT)
    expect(useSettingsStore.getState().settings.trackers).toEqual([])

    fireEvent.change(input, { target: { value: 'wss://tracker.example:443' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().settings.trackers).toEqual(['wss://tracker.example:443'])
    expect(rawSettings().trackers).toEqual(['wss://tracker.example:443'])
  })

  it('removes tracker rows and the list returns to defaults (empty)', () => {
    useSettingsStore.getState().setSettings({ trackers: ['wss://uno.ejemplo'] })
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Remove tracker 1' }))
    expect(useSettingsStore.getState().settings.trackers).toEqual([])
    expect(
      screen.getByText('Empty list: Trystero’s default trackers are used.'),
    ).toBeInTheDocument()
  })

  it('adds STUN and TURN ICE servers with credentials', () => {
    renderModal()
    expect(
      screen.getByText('Empty list: Trystero’s default ICE configuration is used.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add ICE server' }))
    fireEvent.change(screen.getByLabelText('ICE server URL 1'), {
      target: { value: 'stun:stun.ejemplo:19302' },
    })
    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'stun:stun.ejemplo:19302' },
    ])

    fireEvent.change(screen.getByLabelText('ICE server type 1'), {
      target: { value: 'turn' },
    })
    expect(screen.getByLabelText('TURN username 1')).toBeInTheDocument()
    expect(screen.getByLabelText('TURN password 1')).toBeInTheDocument()
    // Issue #30: the persistent-storage disclosure sits next to the fields.
    expect(screen.getByText(TURN_CREDENTIAL_STORAGE_HINT)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('TURN username 1'), { target: { value: 'ana' } })
    fireEvent.change(screen.getByLabelText('TURN password 1'), { target: { value: 'secreta' } })
    fireEvent.change(screen.getByLabelText('ICE server URL 1'), {
      target: { value: 'turn:turn.ejemplo:3478' },
    })

    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'turn:turn.ejemplo:3478', username: 'ana', credential: 'secreta' },
    ])
  })

  it('keeps typed TURN credentials memory-only when remembering is off (issue #30)', () => {
    useSettingsStore.getState().setSettings({ rememberTurnCredentials: false })
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Add ICE server' }))
    fireEvent.change(screen.getByLabelText('ICE server type 1'), {
      target: { value: 'turn' },
    })
    fireEvent.change(screen.getByLabelText('ICE server URL 1'), {
      target: { value: 'turn:turn.ejemplo:3478' },
    })
    fireEvent.change(screen.getByLabelText('TURN username 1'), { target: { value: 'ana' } })
    fireEvent.change(screen.getByLabelText('TURN password 1'), { target: { value: 'secreta' } })

    // The credential lives in the store for the session...
    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'turn:turn.ejemplo:3478', username: 'ana', credential: 'secreta' },
    ])
    // ...but never reaches the persisted JSON.
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY) as string
    expect(raw).not.toContain('"credential"')
  })

  it('remembers TURN credentials by default and goes memory-only when unchecked (issue #30)', () => {
    renderModal()
    const toggle = screen.getByRole('checkbox', {
      name: 'Remember TURN credentials in this browser',
    })
    expect(toggle).toBeChecked()
    expect(useSettingsStore.getState().settings.rememberTurnCredentials).toBe(true)

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.rememberTurnCredentials).toBe(false)
    expect(screen.getByText(TURN_CREDENTIAL_MEMORY_HINT)).toBeInTheDocument()
    expect(rawSettings().rememberTurnCredentials).toBe(false)

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.rememberTurnCredentials).toBe(true)
    expect(screen.queryByText(TURN_CREDENTIAL_MEMORY_HINT)).not.toBeInTheDocument()
  })

  it('rejects a wrong ICE scheme with the inline error and keeps the store clean', () => {
    useSettingsStore.getState().setSettings({ iceServers: [{ urls: 'stun:ok.ejemplo' }] })
    renderModal()

    fireEvent.change(screen.getByLabelText('ICE server URL 1'), {
      target: { value: 'http:' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent(ICE_ERROR_TEXT)
    // The last valid value stays in the store; the invalid draft does not.
    expect(useSettingsStore.getState().settings.iceServers).toEqual([{ urls: 'stun:ok.ejemplo' }])
  })

  it('clamps the room limit to 1–6 and reports out-of-range values', () => {
    renderModal()
    const input = screen.getByLabelText('Active room limit')

    fireEvent.change(input, { target: { value: '9' } })
    expect(screen.getByRole('alert')).toHaveTextContent(MAX_ROOMS_ERROR_TEXT)
    expect(useSettingsStore.getState().settings.maxActiveRooms).toBe(4)

    fireEvent.change(input, { target: { value: '2' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().settings.maxActiveRooms).toBe(2)

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).toHaveValue(1)
    expect(useSettingsStore.getState().settings.maxActiveRooms).toBe(1)
  })

  it('Reconnect all re-joins every active room with the new settings', async () => {
    await manager.joinRoom('lobby')
    const firstRoom = fake.rooms[0]
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)

    useSettingsStore.getState().setSettings({ trackers: ['wss://nuevo.ejemplo'] })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect all' }))

    await waitFor(() => expect(fake.joinRoomFn).toHaveBeenCalledTimes(2))
    expect(firstRoom.leave).toHaveBeenCalledTimes(1)
    expect(fake.configs[1]?.config).toEqual({
      appId: 'gritos-app-v1',
      relayConfig: { urls: ['wss://nuevo.ejemplo'] },
    })
  })
})

describe('Privacy tab (RF-07/RF-08)', () => {
  it('shows the permission states and enables the toggle only when granted', async () => {
    stubNotification('default')
    const { unmount } = render(<SettingsModal open onClose={() => {}} />)
    openTab('Privacy')

    const toggle = screen.getByRole('checkbox', { name: 'Desktop notifications' })
    expect(toggle).toBeDisabled()
    expect(screen.getByText('Permission not requested.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow notifications' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }))
    await waitFor(() => expect(screen.getByText('Permission granted.')).toBeInTheDocument())
    expect(toggle).toBeEnabled()
    unmount()

    // Denied: the explanatory line, toggle disabled, button disabled.
    stubNotification('denied')
    render(<SettingsModal open onClose={() => {}} />)
    openTab('Privacy')
    expect(
      screen.getByText('Permission denied. Enable it from the browser settings.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Desktop notifications' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Allow notifications' })).toBeDisabled()
  })

  it('toggles desktop notifications only behind a granted permission', () => {
    stubNotification('granted')
    renderModal()
    openTab('Privacy')

    const toggle = screen.getByRole('checkbox', { name: 'Desktop notifications' })
    expect(toggle).toBeEnabled()
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.notifications).toBe(true)
    expect(rawSettings().notifications).toBe(true)
  })

  it('persists rememberRooms', () => {
    renderModal()
    openTab('Privacy')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember recent rooms' }))
    expect(useSettingsStore.getState().settings.rememberRooms).toBe(false)
    expect(rawSettings().rememberRooms).toBe(false)
  })

  it('renders the history-gossip consent off by default with its disclosure (issue #102)', () => {
    renderModal()
    openTab('Privacy')

    // The exact issue string, with the explanatory hint next to it.
    expect(screen.getByText(SHARE_HISTORY_LABEL)).toBeInTheDocument()
    expect(screen.getByText(SHARE_HISTORY_HINT)).toBeInTheDocument()

    // Default silence, and flipping the toggle writes the store and the
    // persisted `gritos:settings` record instantly.
    const toggle = screen.getByRole('checkbox', { name: SHARE_HISTORY_LABEL })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.shareHistory).toBe(true)
    expect(rawSettings().shareHistory).toBe(true)

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.shareHistory).toBe(false)
    expect(rawSettings().shareHistory).toBe(false)
  })

  it('discloses that TURN credentials are stored unencrypted (issue #30)', () => {
    renderModal()
    openTab('Privacy')
    expect(screen.getByText(/stored unencrypted in this browser/)).toBeInTheDocument()
    expect(screen.getByText(/Remember TURN credentials in this browser/)).toBeInTheDocument()
  })

  it('discloses the P2P IP exposure to room peers (issue #35)', () => {
    renderModal()
    openTab('Privacy')
    expect(screen.getByText(P2P_IP_EXPOSURE_NOTE)).toBeInTheDocument()
  })

  it('Regenerate identity confirms with the exact warning and swaps the keypair', async () => {
    stubNotification('granted')
    // A real session with a persisted identity (like after onboarding).
    const { createSessionIdentity, exportIdentityJwks, persistIdentity } =
      await import('../src/lib/crypto/identity')
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    await persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })
    await manager.joinRoom('lobby')
    fake.rooms[0].peerJoin('peer-1')
    // The peer announces its raw key so the manager learns a target for the
    // post-regeneration `keys` re-announce.
    fake.rooms[0].receive('keys', new Uint8Array(65).fill(5), 'peer-1')
    const presenceBefore = fake.rooms[0].action('presence').sends.length
    const keysBefore = fake.rooms[0].action('keys').sends.length
    const fingerprintBefore = useAppStore.getState().identity?.fingerprint

    renderModal()
    openTab('Privacy')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate identity' }))

    // The exact RF-07 warning, inside a dialog.
    expect(
      screen.getByText(
        'A new key pair will be generated: your fingerprint will change and the DM channels with your peers will stop matching. Continue?',
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() =>
      expect(useAppStore.getState().identity?.fingerprint).not.toBe(fingerprintBefore),
    )

    // Persisted under gritos:identity and re-announced to the connected peer.
    const persisted = JSON.parse(localStorage.getItem('gritos:identity') as string) as {
      fingerprint: string
      nickname: string
    }
    expect(persisted.fingerprint).toBe(useAppStore.getState().identity?.fingerprint)
    expect(persisted.nickname).toBe('zorro-bravo')
    expect(fake.rooms[0].action('presence').sends.length).toBeGreaterThan(presenceBefore)
    // The `keys` re-announce happens after an awaited ephemeral-keygen inside
    // regenerateSessionIdentity, so it can land after the fingerprint swap
    // this test already waited for — wait for it explicitly.
    await waitFor(() => expect(fake.rooms[0].action('keys').sends.length).toBe(keysBefore + 1))
    // The dialog is gone afterwards.
    expect(screen.queryByRole('dialog', { name: 'Regenerate identity' })).not.toBeInTheDocument()
  })

  it('the panic button asks twice and wipes everything on the final confirm', async () => {
    stubNotification('granted')
    vi.stubGlobal('location', { reload: vi.fn() })
    useSettingsStore.getState().setSettings({ theme: 'dark' })
    localStorage.setItem('gritos:identity', '{"nickname":"zorro-bravo"}')
    localStorage.setItem('other-app:data', 'keep-me')

    renderModal()
    openTab('Privacy')
    fireEvent.click(screen.getByRole('button', { name: 'Wipe everything and leave' }))

    // First confirmation, exact RF-08 text, red confirm.
    expect(
      screen.getByText('Nickname, keys, settings and every local trace will be wiped. Continue?'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    // Second confirmation before anything is destroyed.
    expect(
      screen.getByText(
        'This action is definitive: every connection will be closed and the app will reload to start from scratch.',
      ),
    ).toBeInTheDocument()
    expect(localStorage.getItem('gritos:identity')).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    expect(Object.keys(localStorage).filter((key) => key.startsWith('gritos:'))).toEqual([])
    expect(localStorage.getItem('other-app:data')).toBe('keep-me')
    expect(useSettingsStore.getState().settings.theme).toBe('system')
    expect(useAppStore.getState().identity).toBeNull()
  })

  it('the panic button does nothing while the dialog is cancelled', () => {
    stubNotification('default')
    localStorage.setItem('gritos:identity', '{"nickname":"zorro-bravo"}')
    renderModal()
    openTab('Privacy')
    fireEvent.click(screen.getByRole('button', { name: 'Wipe everything and leave' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(localStorage.getItem('gritos:identity')).not.toBeNull()
  })
})

describe('Privacy mute list (issue #95)', () => {
  const PEER_FP = 'A31F 09BC 77D2 4E5A 0F1E 2D3C 4B5A 6978'
  const CANONICAL_FP = 'A31F09BC77D24E5A0F1E2D3C4B5A6978'
  const OTHER_FP = 'B31F09BC77D24E5A0F1E2D3C4B5A6978'

  it('shows the empty state until a peer is muted', () => {
    renderModal()
    openTab('Privacy')
    expect(screen.getByText('You have not muted any peer.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Unmute/ })).not.toBeInTheDocument()
  })

  it('lists muted peers with nickname and truncated fingerprint, and unmutes per row', () => {
    expect(useSettingsStore.getState().muteFingerprint(PEER_FP, 'luna-cauta')).toBe(true)
    // A second entry written straight into the persisted list bypasses the
    // memory-only nickname map (like a record rehydrated after a reload):
    // its row degrades to the truncated fingerprint.
    useSettingsStore.getState().setSettings({ mutedFingerprints: [CANONICAL_FP, OTHER_FP] })
    renderModal()
    openTab('Privacy')

    expect(screen.getByRole('heading', { name: 'Muted peers' })).toBeInTheDocument()
    expect(screen.getByText('luna-cauta')).toBeInTheDocument()
    expect(screen.getByText('A31F 09BC…')).toBeInTheDocument()
    expect(screen.getByText('B31F 09BC…')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Unmute @luna-cauta' }))
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([OTHER_FP])
    expect(screen.queryByText('A31F 09BC…')).not.toBeInTheDocument()

    // The nickname-less row's button is identified by its fingerprint.
    fireEvent.click(screen.getByRole('button', { name: 'Unmute B31F 09BC…' }))
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
    expect(screen.getByText('You have not muted any peer.')).toBeInTheDocument()
  })

  it('unmuting from the list appends the local system line to the active room (issue #95)', async () => {
    const connection = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
    expect(useSettingsStore.getState().muteFingerprint(PEER_FP, 'luna-cauta')).toBe(true)

    renderModal()
    openTab('Privacy')
    fireEvent.click(screen.getByRole('button', { name: 'Unmute @luna-cauta' }))

    const messages = useAppStore.getState().rooms[connection.roomId]?.messages ?? []
    expect(
      messages.some((m) => m.kind === 'system' && m.text === '@luna-cauta is no longer muted'),
    ).toBe(true)
  })
})

describe('Appearance tab (RF-07/RF-10)', () => {
  it('the theme radio group drives the settings store (single source of truth)', () => {
    renderModal()
    openTab('Appearance')

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(useSettingsStore.getState().settings.theme).toBe('dark')
    expect(rawSettings().theme).toBe('dark')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(useSettingsStore.getState().settings.theme).toBe('light')
  })

  it('the sidebar collapse toggle binds to gritos:ui', () => {
    renderModal()
    openTab('Appearance')

    const toggle = screen.getByRole('checkbox', { name: 'Collapse sidebar on start' })
    fireEvent.click(toggle)
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    expect(JSON.parse(localStorage.getItem('gritos:ui') as string)).toEqual({
      sidebarCollapsed: true,
    })
  })
})

describe('nickname change from the modal (RF-01/RF-07)', () => {
  it('applies on blur: store + gritos:identity + presence re-announce', async () => {
    const { createSessionIdentity, exportIdentityJwks, persistIdentity } =
      await import('../src/lib/crypto/identity')
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    await persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })
    await manager.joinRoom('lobby')
    fake.rooms[0].peerJoin('peer-1')
    const presenceBefore = fake.rooms[0].action('presence').sends.length

    renderModal()
    const input = screen.getByLabelText('Your nickname')
    expect(input).toHaveValue('zorro-bravo')

    fireEvent.change(input, { target: { value: 'luna-cauta' } })
    fireEvent.blur(input)

    expect(useAppStore.getState().identity?.nickname).toBe('luna-cauta')
    // Issue #24: persistIdentity is async now — the re-persist keeps the
    // stored envelope but still lands a microtask after the blur, so the
    // storage read waits for it.
    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem('gritos:identity') as string) as {
        nickname: string
      }
      expect(persisted.nickname).toBe('luna-cauta')
    })
    const lastPresence = fake.rooms[0].action('presence').sends.at(-1)
    expect(lastPresence?.data).toMatchObject({ nick: 'luna-cauta' })
    expect(lastPresence?.options).toBeUndefined() // broadcast to every peer
    expect(fake.rooms[0].action('presence').sends.length).toBe(presenceBefore + 1)
  })

  it('rejects invalid nicknames with the RF-01 inline error', () => {
    renderModal()
    const input = screen.getByLabelText('Your nickname')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.blur(input)

    expect(screen.getByRole('alert')).toHaveTextContent(NICKNAME_ERROR_TEXT)
    expect(useAppStore.getState().identity?.nickname).not.toBe('a')
  })
})
