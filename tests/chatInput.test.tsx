// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatInput } from '../src/components/chat/ChatInput'
import {
  DM_DISCONNECTED_TEXT,
  DM_LEGACY_PEER_TEXT,
  TYPING_SIGNAL_THROTTLE_MS,
} from '../src/lib/feed'
import {
  SIN_EXPIRY_LABEL,
  TTL_1H_LABEL,
  TTL_30S_LABEL,
  TTL_5M_LABEL,
  TTL_SELECT_LABEL,
} from '../src/components/settings/messages'
import type { Room } from '../src/stores/useAppStore'

const { sendChat, sendTyping, sendDm, sendDmTyping } = vi.hoisted(() => ({
  sendChat: vi.fn(),
  sendTyping: vi.fn(),
  sendDm: vi.fn(async () => true),
  sendDmTyping: vi.fn(),
}))

vi.mock('../src/hooks/useRoomManager', () => ({
  // Stable references: the component's cleanup effects depend on them.
  useRoomManager: () => ({ sendChat, sendTyping, sendDm, sendDmTyping }),
}))

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers: [],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sendChat.mockClear()
  sendTyping.mockClear()
  sendDm.mockClear()
  sendDmTyping.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const textarea = () => screen.getByLabelText('Escribe un mensaje') as HTMLTextAreaElement

describe('ChatInput (RF-03)', () => {
  it('sends on Enter and clears the field', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'hola mundo' } })
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: false })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'hola mundo')
    expect(textarea().value).toBe('')
  })

  it('inserts a newline on Shift+Enter without sending', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'línea 1' } })
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
    expect(sendChat).not.toHaveBeenCalled()

    fireEvent.change(textarea(), { target: { value: 'línea 1\nlínea 2' } })
    expect(textarea().value).toBe('línea 1\nlínea 2')
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('also sends via the Enviar button', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'por botón' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(sendChat).toHaveBeenCalledWith('room-1', 'por botón')
  })

  it('blocks sending above 4000 chars and shows the counter', () => {
    render(<ChatInput room={makeRoom()} />)
    const long = 'a'.repeat(4001)
    fireEvent.change(textarea(), { target: { value: long } })
    expect(screen.getByText('4001/4000')).toBeInTheDocument()
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(sendChat).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
  })

  it('shows the counter from 3800 chars onward only', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'a'.repeat(3799) } })
    expect(screen.queryByText('3799/4000')).not.toBeInTheDocument()
    fireEvent.change(textarea(), { target: { value: 'a'.repeat(3800) } })
    expect(screen.getByText('3800/4000')).toBeInTheDocument()
  })

  it('ignores empty/whitespace-only sends', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '   ' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('throttles typing signals to 1/s and stops after idle', async () => {
    render(<ChatInput room={makeRoom()} />)

    fireEvent.change(textarea(), { target: { value: 'a' } })
    expect(sendTyping).toHaveBeenCalledWith('room-1', true)
    expect(sendTyping).toHaveBeenCalledTimes(1)

    // Rapid keystrokes inside the window: no extra signal.
    fireEvent.change(textarea(), { target: { value: 'ab' } })
    fireEvent.change(textarea(), { target: { value: 'abc' } })
    expect(sendTyping).toHaveBeenCalledTimes(1)

    // After the 1 s window the next keystroke signals again.
    vi.advanceTimersByTime(TYPING_SIGNAL_THROTTLE_MS)
    fireEvent.change(textarea(), { target: { value: 'abcd' } })
    expect(sendTyping).toHaveBeenCalledTimes(2)
    expect(sendTyping).toHaveBeenLastCalledWith('room-1', true)

    // 2 s idle → stop signal, exactly once.
    sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendTyping).toHaveBeenCalledTimes(1)
    expect(sendTyping).toHaveBeenCalledWith('room-1', false)
  })

  it('stops the typing signal on send and on blur', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'hola' } })
    expect(sendTyping).toHaveBeenCalledWith('room-1', true)

    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendTyping).toHaveBeenCalledWith('room-1', false)

    // Compose again, then blur: another stop, no duplicates.
    fireEvent.change(textarea(), { target: { value: 'otra' } })
    fireEvent.blur(textarea())
    const stops = sendTyping.mock.calls.filter((call) => call[1] === false)
    expect(stops).toHaveLength(2)
  })

  it('shows the queue hint while the room is searching/error (§10.3)', () => {
    const { rerender } = render(<ChatInput room={makeRoom({ status: 'searching' })} />)
    expect(screen.getByText('En cola hasta conectar…')).toBeInTheDocument()

    rerender(<ChatInput room={makeRoom({ status: 'error' })} />)
    expect(screen.getByText('En cola hasta conectar…')).toBeInTheDocument()

    rerender(<ChatInput room={makeRoom({ status: 'connected' })} />)
    expect(screen.queryByText('En cola hasta conectar…')).not.toBeInTheDocument()
  })

  it('sends while disconnected too (the manager queues it)', () => {
    render(<ChatInput room={makeRoom({ status: 'searching' })} />)
    fireEvent.change(textarea(), { target: { value: 'en cola' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'en cola')
  })
})

// ---------------------------------------------------------------------------
// DM composer states (RF-04 + issue #93, spec §12.1): the same mechanism
// that hard-blocks a disconnected peer blocks a legacy one (a v1 build
// without a session-ephemeral `ephkeys` announce) with its own hint.
// ---------------------------------------------------------------------------

describe('ChatInput DM composer (RF-04, issue #93)', () => {
  it('sends a DM through the manager bridge when the peer is available', () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    fireEvent.change(textarea(), { target: { value: 'hola dm' } })
    expect(sendDmTyping).toHaveBeenCalledWith('peer-9', true)
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'hola dm')
    expect(textarea()).toBeEnabled()
    expect(screen.queryByText(DM_DISCONNECTED_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText(DM_LEGACY_PEER_TEXT)).not.toBeInTheDocument()
  })

  it('blocks the composer with the legacy-peer hint (issue #93)', () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true, legacyPeer: true }} />)

    expect(textarea()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
    expect(screen.getByText(DM_LEGACY_PEER_TEXT)).toBeInTheDocument()
    // The peer IS connected: the disconnected text must not appear too.
    expect(screen.queryByText(DM_DISCONNECTED_TEXT)).not.toBeInTheDocument()

    // Even a submit attempt (Enter) never reaches the manager.
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendDm).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Issue #96 — per-message TTL selector: a memory-only combobox offered in
// both room and DM modes. 'Sin caducidad' (the default) omits the ttl
// argument entirely; the picks map to whole seconds (30/300/3600) on the
// sendChat/sendDm seam. The selection survives consecutive sends until
// changed and resets on remount (never persisted).
// ---------------------------------------------------------------------------

const ttlSelect = () => screen.getByRole('combobox', { name: TTL_SELECT_LABEL })

function pickTtl(value: string): void {
  fireEvent.change(ttlSelect(), { target: { value } })
}

describe('ChatInput TTL selector (issue #96)', () => {
  it('renders with an accessible name and the Sin caducidad default in room mode', () => {
    render(<ChatInput room={makeRoom()} />)
    expect(ttlSelect()).toHaveValue('')
    expect(within(ttlSelect()).getByRole('option', { name: SIN_EXPIRY_LABEL })).toHaveValue('')
    expect(within(ttlSelect()).getByRole('option', { name: TTL_30S_LABEL })).toHaveValue('30')
    expect(within(ttlSelect()).getByRole('option', { name: TTL_5M_LABEL })).toHaveValue('300')
    expect(within(ttlSelect()).getByRole('option', { name: TTL_1H_LABEL })).toHaveValue('3600')
  })

  it('renders with an accessible name in DM mode too', () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    expect(ttlSelect()).toHaveValue('')
  })

  it.each([
    [TTL_30S_LABEL, '30', 30],
    [TTL_5M_LABEL, '300', 300],
    [TTL_1H_LABEL, '3600', 3600],
  ])('picking %s sends ttl %i through sendChat', (_label, raw, ttl) => {
    render(<ChatInput room={makeRoom()} />)
    pickTtl(raw)
    fireEvent.change(textarea(), { target: { value: 'expírame' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'expírame', ttl)
  })

  it('sends a DM with the picked ttl through sendDm', () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    pickTtl('30')
    fireEvent.change(textarea(), { target: { value: 'hola dm' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'hola dm', 30)
  })

  it('Sin caducidad keeps the two-argument call (no ttl reaches the envelope)', () => {
    const room = render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'sin ttl' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(sendChat.mock.calls[0]).toHaveLength(2)
    room.unmount()

    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    fireEvent.change(textarea(), { target: { value: 'dm sin ttl' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledTimes(1)
    expect(sendDm.mock.calls[0]).toHaveLength(2)
  })

  it('keeps the selection across consecutive sends until changed', () => {
    render(<ChatInput room={makeRoom()} />)
    pickTtl('300')
    fireEvent.change(textarea(), { target: { value: 'uno' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    fireEvent.change(textarea(), { target: { value: 'dos' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenNthCalledWith(1, 'room-1', 'uno', 300)
    expect(sendChat).toHaveBeenNthCalledWith(2, 'room-1', 'dos', 300)
  })

  it('resets to Sin caducidad on remount (memory-only state)', () => {
    const first = render(<ChatInput room={makeRoom()} />)
    pickTtl('30')
    fireEvent.change(textarea(), { target: { value: 'primera sesión' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'primera sesión', 30)
    first.unmount()

    sendChat.mockClear() // Judge only the second mount's calls.
    render(<ChatInput room={makeRoom()} />)
    expect(ttlSelect()).toHaveValue('')
    fireEvent.change(textarea(), { target: { value: 'segunda sesión' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat.mock.calls[0]).toHaveLength(2)
  })

  it('is enabled and operable in both modes, hard-blocked with a blocked DM', () => {
    // Native select: jsdom cannot drive the option popup, so change events
    // stand in for the arrow-key selection a keyboard user makes.
    const roomView = render(<ChatInput room={makeRoom()} />)
    expect(ttlSelect()).toBeEnabled()
    pickTtl('3600')
    expect(ttlSelect()).toHaveValue('3600')
    roomView.unmount()

    render(<ChatInput dm={{ peerId: 'peer-9', available: true, legacyPeer: true }} />)
    expect(ttlSelect()).toBeDisabled()
  })
})
