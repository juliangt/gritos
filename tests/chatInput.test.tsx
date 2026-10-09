// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatInput } from '../src/components/chat/ChatInput'
import {
  DM_DISCONNECTED_TEXT,
  DM_LEGACY_PEER_TEXT,
  UNKNOWN_COMMAND_HINT,
  TYPING_SIGNAL_THROTTLE_MS,
} from '../src/lib/feed'
import { NICKNAME_ERROR_TEXT } from '../src/lib/nickname'
import { SLASH_COMMANDS } from '../src/lib/slashCommands'
import {
  SIN_EXPIRY_LABEL,
  SLASH_POPUP_LABEL,
  TTL_1H_LABEL,
  TTL_30S_LABEL,
  TTL_5M_LABEL,
  TTL_SELECT_LABEL,
} from '../src/components/settings/messages'
import { useUiStore } from '../src/stores/useUiStore'
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
    recoveredCount: 0,
    historyAskDismissed: false,
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

const textarea = () => screen.getByLabelText('Write a message') as HTMLTextAreaElement

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
    fireEvent.change(textarea(), { target: { value: 'line 1' } })
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
    expect(sendChat).not.toHaveBeenCalled()

    fireEvent.change(textarea(), { target: { value: 'line 1\nline 2' } })
    expect(textarea().value).toBe('line 1\nline 2')
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('also sends via the Send button', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: 'via button' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendChat).toHaveBeenCalledWith('room-1', 'via button')
  })

  it('blocks sending above 4000 chars and shows the counter', () => {
    render(<ChatInput room={makeRoom()} />)
    const long = 'a'.repeat(4001)
    fireEvent.change(textarea(), { target: { value: long } })
    expect(screen.getByText('4001/4000')).toBeInTheDocument()
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sendChat).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
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
    expect(screen.getByText('Queued until connected…')).toBeInTheDocument()

    rerender(<ChatInput room={makeRoom({ status: 'error' })} />)
    expect(screen.getByText('Queued until connected…')).toBeInTheDocument()

    rerender(<ChatInput room={makeRoom({ status: 'connected' })} />)
    expect(screen.queryByText('Queued until connected…')).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
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
// both room and DM modes. 'No expiry' (the default) omits the ttl
// argument entirely; the picks map to whole seconds (30/300/3600) on the
// sendChat/sendDm seam. The selection survives consecutive sends until
// changed and resets on remount (never persisted).
// ---------------------------------------------------------------------------

const ttlSelect = () => screen.getByRole('combobox', { name: TTL_SELECT_LABEL })

function pickTtl(value: string): void {
  fireEvent.change(ttlSelect(), { target: { value } })
}

describe('ChatInput TTL selector (issue #96)', () => {
  it('renders with an accessible name and the No expiry default in room mode', () => {
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
    fireEvent.change(textarea(), { target: { value: 'send me' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'send me', ttl)
  })

  it('sends a DM with the picked ttl through sendDm', () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    pickTtl('30')
    fireEvent.change(textarea(), { target: { value: 'hola dm' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'hola dm', 30)
  })

  it('No expiry keeps the two-argument call (no ttl reaches the envelope)', () => {
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

  it('resets to No expiry on remount (memory-only state)', () => {
    const first = render(<ChatInput room={makeRoom()} />)
    pickTtl('30')
    fireEvent.change(textarea(), { target: { value: 'first session' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(sendChat).toHaveBeenCalledWith('room-1', 'first session', 30)
    first.unmount()

    sendChat.mockClear() // Judge only the second mount's calls.
    render(<ChatInput room={makeRoom()} />)
    expect(ttlSelect()).toHaveValue('')
    fireEvent.change(textarea(), { target: { value: 'second session' } })
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

// ---------------------------------------------------------------------------
// Issue #99 Phase 3 — slash commands in the composer. The popup is a plain
// listbox driven by the textarea (ARIA combobox pattern): the options are
// never focusable, so the focus stays on the input through every
// interaction. Submitting runs parseSlashCommand + executeSlashCommand: the
// executor's send-chat directives (/me, the '\/' escape hatch) come back
// through the same mode-aware send path (sendChat with isAction in a room,
// sendDm in a DM), unknown verbs and parse errors show the inline hint and
// send nothing. These tests use real timers: the executor is async (the
// directive resolves a microtask after Enter), and the useUiStore is reset
// because real commands flip its seams (/help, /clear).
// ---------------------------------------------------------------------------

const slashListbox = () => screen.getByRole('listbox', { name: SLASH_POPUP_LABEL })

/** Flushes the executor's async directive after a submit/selection. */
const flushExecutor = () => act(async () => {})

describe('ChatInput slash popup (issue #99 Phase 3)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useUiStore.setState({
      joinPopoverName: null,
      helpOpen: false,
      clearFeedOpen: false,
      recoveryRoom: null,
    })
  })

  it('opens on a bare "/" listing every command with listbox semantics', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/' } })

    const listbox = slashListbox()
    expect(textarea()).toHaveAttribute('aria-expanded', 'true')
    expect(textarea()).toHaveAttribute('aria-controls', listbox.id)
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(SLASH_COMMANDS.length)
    // The first option starts active and is announced by the textarea.
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(textarea()).toHaveAttribute('aria-activedescendant', options[0]?.id)
    // Each option's ACCESSIBLE NAME carries its usage line (function
    // matcher: the accname is usage + help; asymmetric matchers do not
    // work as ByRole name matchers under vitest).
    for (const command of SLASH_COMMANDS) {
      expect(
        within(listbox).getByRole('option', {
          name: (accessibleName) => accessibleName.includes(command.usage),
        }),
      ).toBeInTheDocument()
    }
  })

  it('filters by verb prefix ("/n" → /nick, "/h" → /help)', () => {
    render(<ChatInput room={makeRoom()} />)

    fireEvent.change(textarea(), { target: { value: '/n' } })
    expect(within(slashListbox()).getAllByRole('option')).toHaveLength(1)
    expect(within(slashListbox()).getByRole('option', { name: /\/nick/ })).toBeInTheDocument()

    fireEvent.change(textarea(), { target: { value: '/h' } })
    expect(within(slashListbox()).getAllByRole('option')).toHaveLength(1)
    expect(within(slashListbox()).getByRole('option', { name: /\/help/ })).toBeInTheDocument()
  })

  it('never opens for the escape hatch or once arguments begin', () => {
    render(<ChatInput room={makeRoom()} />)

    fireEvent.change(textarea(), { target: { value: '\\/hola' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(textarea()).toHaveAttribute('aria-expanded', 'false')

    fireEvent.change(textarea(), { target: { value: '/me se estira' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // A verb with no prefix match closes the popup entirely ('/x').
    fireEvent.change(textarea(), { target: { value: '/x' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Esc, keeps the text, and typing again re-opens it', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/n' } })
    expect(slashListbox()).toBeInTheDocument()

    fireEvent.keyDown(textarea(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(textarea()).toHaveValue('/n')
    expect(textarea()).toHaveAttribute('aria-expanded', 'false')

    // Esc is dismissal, not destruction: the next keystroke re-opens.
    fireEvent.change(textarea(), { target: { value: '/r' } })
    expect(slashListbox()).toBeInTheDocument()
  })

  it('moves the active option with the arrows, wrapping at both ends', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/' } })
    const options = within(slashListbox()).getAllByRole('option')

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    expect(textarea()).toHaveAttribute('aria-activedescendant', options[1]?.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(textarea()).toHaveAttribute(
      'aria-activedescendant',
      options[SLASH_COMMANDS.length - 1]?.id,
    )
  })

  it('Enter on a zero-arg candidate executes it at once and clears the input', async () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/h' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(textarea()).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await flushExecutor()
    expect(useUiStore.getState().helpOpen).toBe(true)
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('Enter on an argument candidate fills "/nick " with the caret at the end', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/ni' } })
    textarea().focus()
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(textarea()).toHaveValue('/nick ')
    expect(textarea().selectionStart).toBe('/nick '.length)
    expect(textarea().selectionStart).toBe(textarea().selectionEnd)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(textarea()).toHaveFocus()
  })

  it('Tab also selects the active candidate', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/ni' } })
    fireEvent.keyDown(textarea(), { key: 'Tab' })

    expect(textarea()).toHaveValue('/nick ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('a mouse click selects without moving the focus away from the input', async () => {
    render(<ChatInput room={makeRoom()} />)
    textarea().focus()
    fireEvent.change(textarea(), { target: { value: '/' } })
    fireEvent.click(within(slashListbox()).getByRole('option', { name: /\/help/ }))

    expect(textarea()).toHaveValue('')
    await flushExecutor()
    expect(useUiStore.getState().helpOpen).toBe(true)
    expect(textarea()).toHaveFocus()
  })

  it('the focus stays on the textarea through navigation and dismissal', () => {
    render(<ChatInput room={makeRoom()} />)
    textarea().focus()
    fireEvent.change(textarea(), { target: { value: '/' } })
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    fireEvent.keyDown(textarea(), { key: 'Escape' })

    expect(textarea()).toHaveFocus()
  })
})

describe('ChatInput slash submit (issue #99 Phase 3)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useUiStore.setState({
      joinPopoverName: null,
      helpOpen: false,
      clearFeedOpen: false,
      recoveryRoom: null,
    })
  })

  it('an unknown verb shows the exact inline hint, sends nothing, keeps the text', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/foo bar' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_COMMAND_HINT)
    expect(sendChat).not.toHaveBeenCalled()
    expect(textarea()).toHaveValue('/foo bar')
  })

  it('a parse-level error hints inline with the owning wording', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/nick x!' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(screen.getByRole('status')).toHaveTextContent(
      `${NICKNAME_ERROR_TEXT} Usage: /nick <name>`,
    )
    expect(sendChat).not.toHaveBeenCalled()
    expect(textarea()).toHaveValue('/nick x!')
  })

  it('the hint clears on the next edit', () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/foo' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(screen.getByRole('status')).toBeInTheDocument()

    fireEvent.change(textarea(), { target: { value: '/foo hola' } })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('the escape hatch sends the literal text as chat, without a popup', async () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '\\/hola' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    await flushExecutor()
    expect(sendChat).toHaveBeenCalledWith('room-1', '/hola')
    expect(textarea()).toHaveValue('')
  })

  it('/me in a room routes the directive through sendChat with isAction', async () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/me se estira' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    await flushExecutor()
    expect(sendChat).toHaveBeenCalledWith('room-1', 'se estira', undefined, { isAction: true })
    expect(textarea()).toHaveValue('')
  })

  it('/me in a DM routes the directive through sendDm (the composer owns the mode)', async () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    fireEvent.change(textarea(), { target: { value: '/me asiente' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    await flushExecutor()
    expect(sendDm).toHaveBeenCalledWith('peer-9', 'asiente')
    expect(sendChat).not.toHaveBeenCalled()
    expect(textarea()).toHaveValue('')
  })

  it('a typed zero-arg command executes, clears and never sends', async () => {
    render(<ChatInput room={makeRoom()} />)
    fireEvent.change(textarea(), { target: { value: '/rooms' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    await flushExecutor()
    expect(sendChat).not.toHaveBeenCalled()
    expect(textarea()).toHaveValue('')
  })

  it('room-scoped commands in a DM run the executor naturally (no send, no crash)', async () => {
    render(<ChatInput dm={{ peerId: 'peer-9', available: true }} />)
    fireEvent.change(textarea(), { target: { value: '/leave' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    await flushExecutor()
    expect(sendDm).not.toHaveBeenCalled()
    expect(sendChat).not.toHaveBeenCalled()
    expect(textarea()).toHaveValue('')
  })
})
