// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Sidebar } from '../src/components/sidebar/Sidebar'
import { ChatLayout } from '../src/components/chat/ChatLayout'
import { SlashHelpModal } from '../src/components/chat/SlashHelpModal'
import { MessageItem } from '../src/components/chat/MessageItem'
import { resetManagerForTests, setJoinRoomFactory } from '../src/lib/p2p/roomManager'
import { SLASH_HELP_ESCAPE_HINT, SLASH_HELP_LABEL } from '../src/components/settings/messages'
import {
  CLEAR_FEED_DIALOG_BODY,
  CLEAR_FEED_DIALOG_TITLE,
} from '../src/components/settings/messages'
import { SLASH_COMMANDS } from '../src/lib/slashCommands'
import { useAppStore, type Message, type Peer, type Room } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { useUiStore } from '../src/stores/useUiStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #99 Phase 2 — the UI endpoints of the executor seams: the /help
 * overlay, the sidebar popover prefill (/room password flow), the /clear
 * confirmation and the italic /me rendering convention.
 */

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  useSettingsStore.getState().setSettings({ autoJoinLobby: false })
  // The fake transport guards any accidental join from the mounted layout;
  // these tests drive the stores directly, so the handle stays unused.
  installFakeTrystero()
  useUiStore.setState({
    joinPopoverName: null,
    helpOpen: false,
    clearFeedOpen: false,
    recoveryRoom: null,
  })
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  setJoinRoomFactory(null)
  vi.useRealTimers()
})

function peer(id: string, nickname: string): Peer {
  return { id, nickname, fingerprint: null, latencyMs: null, degraded: false }
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
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
    ...overrides,
  }
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    roomId: 'room-lobby',
    authorId: 'self',
    authorNick: 'zorro-bravo',
    text: 'hola',
    ts: Date.now(),
    encrypted: false,
    status: 'sent',
    kind: 'user',
    ...overrides,
  }
}

describe('SlashHelpModal (/help overlay)', () => {
  it('lists every command straight from the parser table plus the escape hatch', () => {
    render(<SlashHelpModal open onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: SLASH_HELP_LABEL })
    for (const command of SLASH_COMMANDS) {
      expect(within(dialog).getByText(command.usage)).toBeInTheDocument()
      expect(within(dialog).getByText(command.help)).toBeInTheDocument()
    }
    expect(within(dialog).getByText(SLASH_HELP_ESCAPE_HINT)).toBeInTheDocument()
  })

  it('renders nothing while closed', () => {
    render(<SlashHelpModal open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Esc closes it through the Modal focus trap', () => {
    const onClose = vi.fn()
    render(<SlashHelpModal open onClose={onClose} />)
    // The trap listens on document (capture phase).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ChatLayout shows the overlay when the executor flips the ui-store seam', () => {
    render(<ChatLayout />)
    expect(screen.queryByRole('dialog', { name: SLASH_HELP_LABEL })).not.toBeInTheDocument()

    act(() => {
      useUiStore.getState().openHelp()
    })
    expect(screen.getByRole('dialog', { name: SLASH_HELP_LABEL })).toBeInTheDocument()
    expect(screen.getByText('/nick <name>')).toBeInTheDocument()

    act(() => {
      useUiStore.getState().closeHelp()
    })
    expect(screen.queryByRole('dialog', { name: SLASH_HELP_LABEL })).not.toBeInTheDocument()
  })
})

describe('Sidebar join-popover prefill (/room password flow seam)', () => {
  it('opens the popover prefilled when the executor flips the ui-store seam', () => {
    render(<Sidebar />)
    expect(screen.queryByLabelText('Nombre de la sala')).not.toBeInTheDocument()

    act(() => {
      useUiStore.getState().openJoinPopover('sala-secreta')
    })
    expect(screen.getByLabelText('Nombre de la sala')).toHaveValue('sala-secreta')

    // Dismissing clears the seam: the popover closes for the store too.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(useUiStore.getState().joinPopoverName).toBeNull()
    expect(screen.queryByLabelText('Nombre de la sala')).not.toBeInTheDocument()
  })

  it('the manual [+ Unirse] toggle and the seam share one popover', () => {
    useUiStore.getState().openJoinPopover('desde-comando')
    render(<Sidebar />)
    // Toggling the button keeps the form open (the seam still holds the name)
    // and dismissing from the form clears both sources.
    fireEvent.click(screen.getByRole('button', { name: '[+ Unirse]' }))
    expect(screen.getByLabelText('Nombre de la sala')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(useUiStore.getState().joinPopoverName).toBeNull()
    expect(screen.queryByLabelText('Nombre de la sala')).not.toBeInTheDocument()
  })
})

describe('/me rendering convention (MessageItem)', () => {
  it('renders an isAction row as the italic «*nick acción*» line, no Markdown pass', () => {
    render(
      <MessageItem
        message={userMessage({ text: 'se estira **despacio**', isAction: true })}
        peers={[]}
        mentionCandidates={[]}
        ownNickname="zorro-bravo"
      />,
    )
    expect(screen.getByText('*zorro-bravo se estira **despacio***').tagName).toBe('EM')
  })

  it('a peer action row uses the disambiguated nickname', () => {
    render(
      <MessageItem
        message={userMessage({
          authorId: 'peer-1',
          authorNick: 'luna-cauta',
          text: 'asiente',
          isAction: true,
        })}
        peers={[peer('peer-1', 'luna-cauta')]}
        mentionCandidates={[]}
        ownNickname="zorro-bravo"
      />,
    )
    expect(screen.getByText('*luna-cauta asiente*').tagName).toBe('EM')
  })

  it('a plain message keeps the Markdown rendering (no isAction flag)', () => {
    render(
      <MessageItem
        message={userMessage({ text: '**negrita**' })}
        peers={[]}
        mentionCandidates={[]}
        ownNickname="zorro-bravo"
      />,
    )
    expect(screen.getByText('negrita').tagName).toBe('STRONG')
  })
})

describe('/clear confirmation (ChatLayout + ConfirmDialog)', () => {
  function seedRoomWithHistory() {
    const store = useAppStore.getState()
    store.setActiveView({ kind: 'room', id: 'room-lobby' })
    store.upsertRoom(room({ messages: [userMessage()], fifoTrimmed: true }))
  }

  it('only an explicit confirm wipes the local feed', () => {
    seedRoomWithHistory()
    render(<ChatLayout />)
    expect(screen.getByText('hola')).toBeInTheDocument()

    act(() => {
      useUiStore.getState().requestClearFeed()
    })
    expect(screen.getByRole('dialog', { name: CLEAR_FEED_DIALOG_TITLE })).toBeInTheDocument()
    expect(screen.getByText(CLEAR_FEED_DIALOG_BODY)).toBeInTheDocument()

    // Cancel: untouched.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))
    expect(useAppStore.getState().rooms['room-lobby']?.messages).toHaveLength(1)

    // Confirm: the feed view empties, the room and its latched facts stay.
    act(() => {
      useUiStore.getState().requestClearFeed()
    })
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    const stored = useAppStore.getState().rooms['room-lobby']
    expect(stored?.messages).toEqual([])
    expect(stored?.fifoTrimmed).toBe(true)
    expect(useUiStore.getState().clearFeedOpen).toBe(false)
  })
})

describe('/room password recovery (ChatLayout)', () => {
  it('offers the prefilled join form once the armed room exhausts the heuristic', () => {
    const store = useAppStore.getState()
    store.setActiveView({ kind: 'room', id: 'room-secreta' })
    store.upsertRoom(room({ id: 'room-secreta', name: 'secreta', status: 'error' }))
    // What the executor's /room success armed.
    useUiStore.getState().armPasswordRecovery('secreta')

    render(<ChatLayout />)
    const recovery = screen.getByRole('region', { name: 'Unirse con contraseña' })
    expect(within(recovery).getByLabelText('Nombre de la sala')).toHaveValue('secreta')

    // Dismissing retires the offer and clears the ui-store seam.
    fireEvent.click(within(recovery).getByRole('button', { name: 'Cancelar' }))
    expect(useUiStore.getState().recoveryRoom).toBeNull()
    expect(screen.queryByRole('region', { name: 'Unirse con contraseña' })).not.toBeInTheDocument()
  })

  it('does not offer the form for other rooms', () => {
    const store = useAppStore.getState()
    store.setActiveView({ kind: 'room', id: 'room-lobby' })
    store.upsertRoom(room({ id: 'room-secreta', name: 'secreta', status: 'error' }))
    store.upsertRoom(room())
    useUiStore.getState().armPasswordRecovery('secreta')

    render(<ChatLayout />)
    expect(screen.queryByRole('region', { name: 'Unirse con contraseña' })).not.toBeInTheDocument()
  })
})
