// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatInput } from '../src/components/chat/ChatInput'
import { DM_DISCONNECTED_TEXT, DM_LEGACY_PEER_TEXT, TYPING_SIGNAL_THROTTLE_MS } from '../src/lib/feed'
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
