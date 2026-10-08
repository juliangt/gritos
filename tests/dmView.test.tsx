// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatLayout } from '../src/components/chat/ChatLayout'
import * as manager from '../src/lib/p2p/roomManager'
import { TTL_SELECT_LABEL } from '../src/components/settings/messages'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type Identity,
  type Message,
  type Room,
} from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * M3 UI (RF-04/§10.1): the DM view reuses the chat shell — feed, typing
 * bar, composer — under a fingerprint header with the exact TOFU notice,
 * the unread-cleared DmList entry in the sidebar and the hard-blocked
 * composer once the peer leaves every shared room.
 */

const { sendDm, sendDmTyping, openDm } = vi.hoisted(() => ({
  sendDm: vi.fn(async () => true),
  sendDmTyping: vi.fn(),
  openDm: vi.fn((peerId: string) => manager.openDmChannel(peerId)),
}))

vi.mock('../src/hooks/useRoomManager', () => ({
  useRoomManager: () => ({
    joinRoom: vi.fn(async () => null),
    joinRoomFocused: vi.fn(async () => ({ roomId: null, error: null })),
    leaveRoom: vi.fn(),
    sendChat: vi.fn(),
    sendTyping: vi.fn(),
    sendDm,
    sendDmTyping,
    openDm,
    changeNickname: vi.fn(),
    reconnectAll: vi.fn(),
    enterWithNickname: vi.fn(async () => {}),
  }),
}))

const IDENTITY: Identity = {
  nickname: 'luna-cauta',
  fingerprint: 'B31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

function dmMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'dm-1',
    roomId: 'dm:peer-9',
    authorId: 'peer-9',
    authorNick: 'zorro-bravo',
    text: 'hola en secreto',
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'user',
    ...overrides,
  }
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-lobby',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers: [
      {
        id: 'peer-9',
        nickname: 'zorro-bravo',
        fingerprint: 'A31F 09BC 77D2 4E5A',
        latencyMs: 30,
        degraded: false,
      },
    ],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  installFakeTrystero()
  const store = useAppStore.getState()
  store.setIdentity(IDENTITY)
  store.upsertRoom(room())
  store.ensureDmChannel('peer-9', 'zorro-bravo', 'A31F 09BC 77D2 4E5A')
  // The peer shares the seeded room, so the channel is available.
  store.setDmAvailable('peer-9', true)
  // One decrypted DM already sits on the channel.
  store.appendDmMessage('peer-9', dmMessage())
  store.setActiveView({ kind: 'dm', peerId: 'peer-9' })
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  useAppStore.setState({ ...INITIAL_APP_STATE })
  sendDm.mockClear()
  sendDmTyping.mockClear()
  openDm.mockClear()
})

describe('DM view (RF-04)', () => {
  it('renders the fingerprint header with the exact verification notice', () => {
    render(<ChatLayout />)
    expect(screen.getByRole('heading', { level: 1, name: 'zorro-bravo' })).toBeInTheDocument()
    expect(screen.getByText(/A31F 09BC 77D2 4E5A/)).toBeInTheDocument()
    expect(
      screen.getByText('Compáralo con tu interlocutor para verificar su identidad'),
    ).toBeInTheDocument()
    // Issue #22 — a clean channel shows no TOFU divergence warning.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Available: the header mirrors the room peer count.
    expect(screen.getByText('1 par')).toBeInTheDocument()
    expect(screen.queryByText('El par se ha desconectado')).not.toBeInTheDocument()
  })

  it('warns in the header when the peer key changed (issue #22, TOFU)', () => {
    useAppStore.getState().setDmKeyChanged('peer-9', true)
    render(<ChatLayout />)

    // The visible warning with the reinstallation/impersonation explanation.
    expect(
      screen.getByText('⚠ El fingerprint cambió desde tu última verificación'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'El par puede haber reinstalado la app o podría tratarse de una suplantación',
    )
    // The pinned first-seen fingerprint stays displayed (never rotated away).
    expect(screen.getByText(/A31F 09BC 77D2 4E5A/)).toBeInTheDocument()
    // Advisory only: the conversation keeps working.
    expect(screen.getByLabelText('Escribe un mensaje')).toBeEnabled()
  })

  it('reuses the room feed and composer: messages render with receipts', () => {
    const store = useAppStore.getState()
    store.appendDmMessage('peer-9', {
      id: 'dm-2',
      roomId: 'dm:peer-9',
      authorId: 'self',
      authorNick: IDENTITY.nickname,
      text: 'respuesta propia',
      ts: Date.now(),
      encrypted: false,
      status: 'sent',
      kind: 'user',
    })
    render(<ChatLayout />)

    const feed = screen.getByLabelText('Mensajes directos con zorro-bravo')
    expect(feed.textContent).toContain('hola en secreto')
    expect(feed.textContent).toContain('respuesta propia')
    expect(screen.getByLabelText('enviado, pendiente de recepción')).toHaveTextContent('✓')
    const textarea = screen.getByLabelText('Escribe un mensaje')
    expect(textarea).toBeEnabled()
    // The composer enables sending as soon as there is text.
    fireEvent.change(textarea, { target: { value: 'texto' } })
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled()
  })

  it('sends DMs and typing through the manager bridge', () => {
    render(<ChatLayout />)
    const textarea = screen.getByLabelText('Escribe un mensaje')
    fireEvent.change(textarea, { target: { value: 'hola dm' } })
    expect(sendDmTyping).toHaveBeenCalledWith('peer-9', true)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'hola dm')
    expect(sendDmTyping).toHaveBeenCalledWith('peer-9', false)
    expect(textarea).toHaveValue('')
  })

  // Issue #96 — the TTL selector lives in the shared composer, so the DM
  // view offers it too and threads the pick into sendDm.
  it('sends the picked ttl with the DM through the manager bridge', () => {
    render(<ChatLayout />)
    fireEvent.change(screen.getByRole('combobox', { name: TTL_SELECT_LABEL }), {
      target: { value: '30' },
    })
    const textarea = screen.getByLabelText('Escribe un mensaje')
    fireEvent.change(textarea, { target: { value: 'hola fugaz' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'hola fugaz', 30)
  })

  it('blocks the composer with the exact text once the peer disconnects', () => {
    useAppStore.getState().setDmAvailable('peer-9', false)
    render(<ChatLayout />)

    // Header status and composer status share the exact RF-04 wording.
    expect(screen.getAllByText('El par se ha desconectado')).toHaveLength(2)
    expect(screen.getByLabelText('Escribe un mensaje')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()

    // The sidebar channel entry keeps the history with a disconnected marker.
    expect(screen.getByLabelText('par desconectado')).toBeInTheDocument()
  })

  // Issue #93 (spec §12.1): a connected peer running a legacy build (no
  // session-ephemeral announce) gets its own honest composer state — the
  // history stays readable, sending is hard-blocked with a hint.
  it('blocks the composer with the legacy hint when the peer is a legacy build', () => {
    useAppStore.getState().setDmLegacyPeer('peer-9', true)
    render(<ChatLayout />)

    // The peer is still connected: header shows the normal peer count and
    // no disconnected marker anywhere.
    expect(screen.getByText('1 par')).toBeInTheDocument()
    expect(screen.queryByText('El par se ha desconectado')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('par desconectado')).not.toBeInTheDocument()

    // The composer is hard-blocked with the exact legacy hint.
    expect(
      screen.getByText('Este par usa una versión anterior sin DM cifrado por sesión'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Escribe un mensaje')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
  })

  it('keeps the composer enabled for a v2-capable peer (legacyPeer false)', () => {
    // Default channel state from beforeEach: legacyPeer is false.
    render(<ChatLayout />)
    expect(
      screen.queryByText('Este par usa una versión anterior sin DM cifrado por sesión'),
    ).not.toBeInTheDocument()
    const textarea = screen.getByLabelText('Escribe un mensaje')
    expect(textarea).toBeEnabled()
    fireEvent.change(textarea, { target: { value: 'texto' } })
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled()
  })

  it('opens the DM view from the peer menu (§10.1)', () => {
    // Start in the room view.
    useAppStore.getState().setActiveView({ kind: 'room', id: 'room-lobby' })
    render(<ChatLayout />)

    // The peer entry and the sidebar DM channel share the nickname; the
    // Pares section renders first in the sidebar DOM.
    fireEvent.click(screen.getAllByText('zorro-bravo')[0]?.closest('button') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mensaje directo' }))

    expect(openDm).toHaveBeenCalledWith('peer-9')
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-9' })
    expect(screen.getByRole('heading', { level: 1, name: 'zorro-bravo' })).toBeInTheDocument()
  })

  it('shows the DM channels section with unread badges in the sidebar (RF-04)', () => {
    const store = useAppStore.getState()
    store.ensureDmChannel('peer-2', 'luna-clara', null)
    store.appendDmMessage(
      'peer-2',
      dmMessage({ id: 'dm-9', roomId: 'dm:peer-2', authorId: 'peer-2', authorNick: 'luna-clara' }),
    )
    render(<ChatLayout />)

    const section = screen.getByRole('region', { name: 'Mensajes directos' })
    expect(section.textContent).toContain('luna-clara')
    expect(screen.getByLabelText('1 sin leer')).toBeInTheDocument()

    // Clicking navigates and clears the badge.
    fireEvent.click(screen.getByText('luna-clara'))
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-2' })
    expect(useAppStore.getState().dms['peer-2']?.unread).toBe(0)
  })
})
