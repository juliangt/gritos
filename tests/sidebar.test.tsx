// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Sidebar } from '../src/components/sidebar/Sidebar'
import { joinRoom, resetManagerForTests, setJoinRoomFactory } from '../src/lib/p2p/roomManager'
import { useAppStore, type Peer, type Room } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

// Real timers: vitest fake timers swallow Node's webcrypto under jsdom and
// several flows here create identities/join rooms.
let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  setJoinRoomFactory(null)
  vi.useRealTimers()
})

function peer(id: string, nickname: string, latencyMs: number | null = 42): Peer {
  return { id, nickname, fingerprint: null, latencyMs, degraded: false }
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-lobby',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers: [],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    ...overrides,
  }
}

function seedStore() {
  const store = useAppStore.getState()
  // Focus first: setActiveView clears the unread of the target room.
  store.setActiveView({ kind: 'room', id: 'room-lobby' })
  store.upsertRoom(
    room({
      unread: 2,
      peers: [peer('peer-aaaa3f1', 'luna-cauta'), peer('peer-bbbb9c2', 'luna-cauta')],
    }),
  )
  store.upsertRoom(room({ id: 'room-dev', name: 'dev', status: 'searching', hasPassword: true }))
  store.setRecentRooms(['antigua', 'dev'])
}

describe('Sidebar (spec §10.1, RF-02, RF-06)', () => {
  it('renders Activas with unread badges, status dots and the lock placeholder', () => {
    seedStore()
    render(<Sidebar />)

    expect(screen.getByText('#lobby')).toBeInTheDocument()
    expect(screen.getByLabelText('2 sin leer')).toBeInTheDocument()
    expect(screen.getByLabelText('conectado')).toBeInTheDocument()
    expect(screen.getByText('#dev')).toBeInTheDocument()
    expect(screen.getByText('🔒')).toBeInTheDocument() // lock on dev
  })

  it('hides suggested rooms that are already active and shows the rest', () => {
    seedStore()
    render(<Sidebar />)
    const suggested = screen.getByRole('region', { name: 'Salas sugeridas' })
    expect(suggested.textContent).not.toContain('#lobby')
    expect(suggested.textContent).not.toContain('#dev')
    expect(suggested.textContent).toContain('#general')
    expect(suggested.textContent).toContain('#random')
  })

  it('renders Recientes only when rememberRooms is on, minus active rooms', () => {
    seedStore()
    const { rerender } = render(<Sidebar />)
    const recientes = screen.getByRole('region', { name: 'Salas recientes' })
    expect(recientes.textContent).toContain('#antigua')
    expect(recientes.textContent).not.toContain('#dev') // already active

    useSettingsStore.getState().setSettings({ rememberRooms: false })
    rerender(<Sidebar />)
    expect(screen.queryByRole('region', { name: 'Salas recientes' })).not.toBeInTheDocument()
  })

  it('lists the peers of the active view with latency dots and dedup suffixes', () => {
    seedStore()
    render(<Sidebar />)
    const pares = screen.getByRole('region', { name: 'Pares' })
    expect(pares.textContent).toContain('🟢')
    expect(pares.textContent).toContain('luna-cauta·a3f1')
    expect(pares.textContent).toContain('luna-cauta·b9c2')
  })

  it('shows a searching status dot for a disconnected room', () => {
    seedStore()
    render(<Sidebar />)
    expect(screen.getByLabelText('buscando pares')).toBeInTheDocument()
  })

  it('opens the join popover with live normalization preview and the password behind the toggle', async () => {
    seedStore()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '[+ Unirse]' }))

    const nameField = screen.getByLabelText('Nombre de la sala')
    fireEvent.change(nameField, { target: { value: 'Mi Sala' } })
    expect(screen.getByText(/Se unirá a/)).toBeInTheDocument()
    expect(screen.getByText('#mi-sala')).toBeInTheDocument()
    // M4 (RF-05): the password field only exists once 'sala cifrada' is on.
    expect(screen.queryByLabelText('Contraseña de la sala')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'sala cifrada' }))
    expect(screen.getByLabelText('Contraseña de la sala')).toBeEnabled()
    expect(
      screen.getByText('Quien no tenga la contraseña no encontrará esta sala.'),
    ).toBeInTheDocument()

    // Invalid names get the exact inline error, no network call.
    fireEvent.change(nameField, { target: { value: '!!' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Unirse por nombre' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Solo minúsculas, números, guiones y guion bajo (1–32 caracteres)',
    )
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
  })

  it('rejects joining over the cap with the exact message (RF-02)', async () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 2 })
    await joinRoom('lobby')
    await joinRoom('dev')
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: '[+ Unirse]' }))
    fireEvent.change(screen.getByLabelText('Nombre de la sala'), {
      target: { value: 'tercera' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Unirse por nombre' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Límite de salas activas alcanzado (2)',
    )
    expect(Object.keys(useAppStore.getState().rooms)).toHaveLength(2)
  })

  it('clicking a suggested room joins and focuses it', async () => {
    seedStore()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '#general' }))

    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    })
    const state = useAppStore.getState()
    const joined = Object.values(state.rooms).find((roomEntry) => roomEntry.name === 'general')
    expect(joined).toBeDefined()
    expect(state.activeView).toEqual({ kind: 'room', id: joined?.id })
  })

  it('offers leaving an active room (RF-02)', async () => {
    const connection = await joinRoom('dev')
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Abandonar dev' }))

    await waitFor(() => {
      expect(useAppStore.getState().rooms[connection.roomId]).toBeUndefined()
    })
  })

  it('peer menu opens the M3 DM view: Mensaje directo focuses the channel (RF-04)', () => {
    seedStore()
    render(<Sidebar />)
    // The peer button carries the latency dot in its accessible name; find
    // it by its visible text.
    fireEvent.click(screen.getByText('luna-cauta·a3f1').closest('button') as HTMLElement)
    const menu = screen.getByRole('menu', { name: 'Acciones para luna-cauta·a3f1' })
    expect(menu).toBeInTheDocument()
    const directMessage = screen.getByRole('menuitem', { name: 'Mensaje directo' })
    expect(directMessage).toBeEnabled()
    // Without a received fingerprint there is nothing to copy yet.
    expect(screen.getByRole('menuitem', { name: 'Copiar fingerprint' })).toBeDisabled()

    fireEvent.click(directMessage)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-aaaa3f1' })
    // The menu closed after the action.
    expect(screen.queryByRole('menu', { name: 'Acciones para luna-cauta·a3f1' })).not.toBeInTheDocument()
  })

  it('peer menu closes on Escape (§10.1)', () => {
    seedStore()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('luna-cauta·a3f1').closest('button') as HTMLElement)
    expect(screen.getByRole('menu', { name: 'Acciones para luna-cauta·a3f1' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('lists open DM channels with unread badges and clears on open (RF-04)', () => {
    seedStore()
    const store = useAppStore.getState()
    store.ensureDmChannel('peer-aaaa3f1', 'luna-cauta', 'A31F 09BC 77D2 4E5A')
    store.setDmAvailable('peer-aaaa3f1', true)
    store.ensureDmChannel('peer-bbbb9c2', 'zorro-bravo', 'B31F 09BC 77D2 4E5A')
    store.appendDmMessage('peer-bbbb9c2', {
      id: 'dm-1',
      roomId: 'dm:peer-bbbb9c2',
      authorId: 'peer-bbbb9c2',
      authorNick: 'zorro-bravo',
      text: 'psst',
      ts: Date.now(),
      encrypted: false,
      status: 'delivered',
      kind: 'user',
    })
    render(<Sidebar />)

    const section = screen.getByRole('region', { name: 'Mensajes directos' })
    expect(section.textContent).toContain('luna-cauta')
    expect(section.textContent).toContain('zorro-bravo')
    expect(screen.getByLabelText('1 sin leer')).toBeInTheDocument()
    expect(screen.getByLabelText('par desconectado')).toBeInTheDocument() // unavailable channel

    fireEvent.click(screen.getByText('zorro-bravo'))
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-bbbb9c2' })
    expect(useAppStore.getState().dms['peer-bbbb9c2']?.unread).toBe(0)
  })
})
