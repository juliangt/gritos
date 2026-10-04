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
  TRACKER_ERROR_TEXT,
} from '../src/components/settings/messages'
import { NICKNAME_ERROR_TEXT } from '../src/lib/nickname'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { useUiStore } from '../src/stores/useUiStore'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * M5 (RF-07/RF-08/RF-10): the settings modal with the Red / Privacidad /
 * Apariencia tabs — exact Spanish control wording, instant persistence to
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
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }))

    expect(screen.getByRole('dialog', { name: 'Ajustes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Red' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Privacidad' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Apariencia' })).toBeInTheDocument()
  })

  it('closes on the ✕ button, Escape and the backdrop', () => {
    const onClose = vi.fn()
    render(<SettingsModal open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ajustes' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    const dialog = screen.getByRole('dialog', { name: 'Ajustes' })
    fireEvent.mouseDown(dialog.parentElement as HTMLElement, { target: dialog.parentElement })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('switching tabs shows each tab panel', () => {
    renderModal()
    expect(screen.getByText('Auto-unirse a #lobby al iniciar')).toBeInTheDocument()

    openTab('Privacidad')
    expect(screen.getByText('Notificaciones de escritorio')).toBeInTheDocument()

    openTab('Apariencia')
    expect(screen.getByRole('radio', { name: 'Sistema' })).toBeChecked()

    openTab('Red')
    expect(screen.getByText('Auto-unirse a #lobby al iniciar')).toBeInTheDocument()
  })
})

describe('Red tab (RF-07)', () => {
  it('persists autoJoinLobby instantly to the store and gritos:settings', () => {
    renderModal()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-unirse a #lobby al iniciar' }))
    expect(useSettingsStore.getState().settings.autoJoinLobby).toBe(false)
    expect(rawSettings().autoJoinLobby).toBe(false)
  })

  it('shows the defaults hint and validates the wss:// scheme on trackers', () => {
    renderModal()
    expect(
      screen.getByText('Lista vacía: se usan los trackers por defecto de Trystero.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Añadir tracker' }))
    const input = screen.getByLabelText('Tracker 1')
    fireEvent.change(input, { target: { value: 'http://no' } })
    expect(screen.getByRole('alert')).toHaveTextContent(TRACKER_ERROR_TEXT)
    expect(useSettingsStore.getState().settings.trackers).toEqual([])

    fireEvent.change(input, { target: { value: 'wss://tracker.ejemplo:443' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().settings.trackers).toEqual(['wss://tracker.ejemplo:443'])
    expect(rawSettings().trackers).toEqual(['wss://tracker.ejemplo:443'])
  })

  it('removes tracker rows and the list returns to defaults (empty)', () => {
    useSettingsStore.getState().setSettings({ trackers: ['wss://uno.ejemplo'] })
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar tracker 1' }))
    expect(useSettingsStore.getState().settings.trackers).toEqual([])
    expect(
      screen.getByText('Lista vacía: se usan los trackers por defecto de Trystero.'),
    ).toBeInTheDocument()
  })

  it('adds STUN and TURN ICE servers with credentials', () => {
    renderModal()
    expect(
      screen.getByText('Lista vacía: se usa la configuración ICE por defecto de Trystero.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Añadir servidor ICE' }))
    fireEvent.change(screen.getByLabelText('URL del servidor ICE 1'), {
      target: { value: 'stun:stun.ejemplo:19302' },
    })
    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'stun:stun.ejemplo:19302' },
    ])

    fireEvent.change(screen.getByLabelText('Tipo de servidor ICE 1'), {
      target: { value: 'turn' },
    })
    expect(screen.getByLabelText('Usuario TURN 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Contraseña TURN 1')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Usuario TURN 1'), { target: { value: 'ana' } })
    fireEvent.change(screen.getByLabelText('Contraseña TURN 1'), { target: { value: 'secreta' } })
    fireEvent.change(screen.getByLabelText('URL del servidor ICE 1'), {
      target: { value: 'turn:turn.ejemplo:3478' },
    })

    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'turn:turn.ejemplo:3478', username: 'ana', credential: 'secreta' },
    ])
  })

  it('rejects a wrong ICE scheme with the inline error and keeps the store clean', () => {
    useSettingsStore.getState().setSettings({ iceServers: [{ urls: 'stun:ok.ejemplo' }] })
    renderModal()

    fireEvent.change(screen.getByLabelText('URL del servidor ICE 1'), {
      target: { value: 'http:' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent(ICE_ERROR_TEXT)
    // The last valid value stays in the store; the invalid draft does not.
    expect(useSettingsStore.getState().settings.iceServers).toEqual([{ urls: 'stun:ok.ejemplo' }])
  })

  it('clamps the room limit to 1–6 and reports out-of-range values', () => {
    renderModal()
    const input = screen.getByLabelText('Límite de salas activas')

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

  it('Reconectar todo re-joins every active room with the new settings', async () => {
    await manager.joinRoom('lobby')
    const firstRoom = fake.rooms[0]
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)

    useSettingsStore.getState().setSettings({ trackers: ['wss://nuevo.ejemplo'] })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Reconectar todo' }))

    await waitFor(() => expect(fake.joinRoomFn).toHaveBeenCalledTimes(2))
    expect(firstRoom.leave).toHaveBeenCalledTimes(1)
    expect(fake.configs[1]?.config).toEqual({
      appId: 'gritos-app-v1',
      relayConfig: { urls: ['wss://nuevo.ejemplo'] },
    })
  })
})

describe('Privacidad tab (RF-07/RF-08)', () => {
  it('shows the permission states and enables the toggle only when granted', async () => {
    stubNotification('default')
    const { unmount } = render(<SettingsModal open onClose={() => {}} />)
    openTab('Privacidad')

    const toggle = screen.getByRole('checkbox', { name: 'Notificaciones de escritorio' })
    expect(toggle).toBeDisabled()
    expect(screen.getByText('Permiso no solicitado.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Permitir notificaciones' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Permitir notificaciones' }))
    await waitFor(() => expect(screen.getByText('Permiso concedido.')).toBeInTheDocument())
    expect(toggle).toBeEnabled()
    unmount()

    // Denied: the explanatory line, toggle disabled, button disabled.
    stubNotification('denied')
    render(<SettingsModal open onClose={() => {}} />)
    openTab('Privacidad')
    expect(
      screen.getByText('Permiso denegado. Actívalo desde la configuración del navegador.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Notificaciones de escritorio' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Permitir notificaciones' })).toBeDisabled()
  })

  it('toggles desktop notifications only behind a granted permission', () => {
    stubNotification('granted')
    renderModal()
    openTab('Privacidad')

    const toggle = screen.getByRole('checkbox', { name: 'Notificaciones de escritorio' })
    expect(toggle).toBeEnabled()
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.notifications).toBe(true)
    expect(rawSettings().notifications).toBe(true)
  })

  it('persists rememberRooms', () => {
    renderModal()
    openTab('Privacidad')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Recordar salas recientes' }))
    expect(useSettingsStore.getState().settings.rememberRooms).toBe(false)
    expect(rawSettings().rememberRooms).toBe(false)
  })

  it('Regenerar identidad confirms with the exact warning and swaps the keypair', async () => {
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
    openTab('Privacidad')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerar identidad' }))

    // The exact RF-07 warning, inside a dialog.
    expect(
      screen.getByText(
        'Se generará un nuevo par de claves: tu fingerprint cambiará y los canales DM con tus pares dejarán de coincidir. ¿Continuar?',
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
    expect(fake.rooms[0].action('keys').sends.length).toBe(keysBefore + 1)
    // The dialog is gone afterwards.
    expect(screen.queryByRole('dialog', { name: 'Regenerar identidad' })).not.toBeInTheDocument()
  })

  it('the panic button asks twice and wipes everything on the final confirm', async () => {
    stubNotification('granted')
    vi.stubGlobal('location', { reload: vi.fn() })
    useSettingsStore.getState().setSettings({ theme: 'dark' })
    localStorage.setItem('gritos:identity', '{"nickname":"zorro-bravo"}')
    localStorage.setItem('other-app:data', 'keep-me')

    renderModal()
    openTab('Privacidad')
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo y salir' }))

    // First confirmation, exact RF-08 text, red confirm.
    expect(
      screen.getByText('Se borrarán apodo, claves, ajustes y todo rastro local. ¿Continuar?'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    // Second confirmation before anything is destroyed.
    expect(
      screen.getByText(
        'Esta acción es definitiva: se cerrarán todas las conexiones y la aplicación se recargará para empezar de cero.',
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
    openTab('Privacidad')
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo y salir' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(localStorage.getItem('gritos:identity')).not.toBeNull()
  })
})

describe('Apariencia tab (RF-07/RF-10)', () => {
  it('the theme radio group drives the settings store (single source of truth)', () => {
    renderModal()
    openTab('Apariencia')

    expect(screen.getByRole('radio', { name: 'Sistema' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Oscuro' }))
    expect(useSettingsStore.getState().settings.theme).toBe('dark')
    expect(rawSettings().theme).toBe('dark')

    fireEvent.click(screen.getByRole('radio', { name: 'Claro' }))
    expect(useSettingsStore.getState().settings.theme).toBe('light')
  })

  it('the sidebar collapse toggle binds to gritos:ui', () => {
    renderModal()
    openTab('Apariencia')

    const toggle = screen.getByRole('checkbox', { name: 'Colapsar barra lateral al iniciar' })
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
    const input = screen.getByLabelText('Tu apodo')
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
    const input = screen.getByLabelText('Tu apodo')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.blur(input)

    expect(screen.getByRole('alert')).toHaveTextContent(NICKNAME_ERROR_TEXT)
    expect(useAppStore.getState().identity?.nickname).not.toBe('a')
  })
})
