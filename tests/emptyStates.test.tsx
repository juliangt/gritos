// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { Sidebar } from '../src/components/sidebar/Sidebar'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import {
  EMPTY_DM_FEED_TEXT,
  EMPTY_DM_LIST_TEXT,
  EMPTY_RECENTS_TEXT,
  EMPTY_ROOM_FEED_TEXT,
} from '../src/lib/feed'
import { useAppStore, type Identity, type Message } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

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
  vi.useRealTimers()
})

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

function userMessage(text: string): Message {
  return {
    id: `m-${text}`,
    roomId: 'room',
    authorId: 'peer-1',
    authorNick: 'luna-cauta',
    text,
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'user',
  }
}

describe('M6 empty states (Spanish, discrete)', () => {
  it('MessageFeed shows the room invitation only while empty', () => {
    const { rerender } = render(
      <MessageFeed messages={[]} peers={[]} fifoTrimmed={false} ariaLabel="Mensajes" />,
    )
    // Default: without an explicit empty text nothing extra renders.
    expect(screen.queryByText(EMPTY_ROOM_FEED_TEXT)).not.toBeInTheDocument()

    rerender(
      <MessageFeed
        messages={[]}
        peers={[]}
        fifoTrimmed={false}
        ariaLabel="Mensajes"
        emptyStateText={EMPTY_ROOM_FEED_TEXT}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_ROOM_FEED_TEXT)

    rerender(
      <MessageFeed
        messages={[userMessage('hola')]}
        peers={[]}
        fifoTrimmed={false}
        ariaLabel="Mensajes"
        emptyStateText={EMPTY_ROOM_FEED_TEXT}
      />,
    )
    expect(screen.queryByText(EMPTY_ROOM_FEED_TEXT)).not.toBeInTheDocument()
  })

  it('room feed shows the exact invitation text until the first message lands', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    // #lobby auto-joins and focuses (default settings).
    await waitFor(() => {
      expect(useAppStore.getState().activeView).not.toBeNull()
    })
    expect(screen.getByText(EMPTY_ROOM_FEED_TEXT)).toBeInTheDocument()

    useAppStore.setState((state) => {
      const roomId = (state.activeView as { kind: 'room'; id: string }).id
      const room = state.rooms[roomId]
      return {
        rooms: {
          ...state.rooms,
          [roomId]: { ...room, messages: [userMessage('hola')] },
        },
      }
    })
    await waitFor(() => {
      expect(screen.queryByText(EMPTY_ROOM_FEED_TEXT)).not.toBeInTheDocument()
    })
  })

  it('DM feed shows its own empty line for a fresh channel', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)
    await waitFor(() => {
      expect(useAppStore.getState().activeView).not.toBeNull()
    })

    const store = useAppStore.getState()
    store.ensureDmChannel('peer-1', 'luna-cauta', 'A31F 09BC 77D2 4E5A')
    store.setDmAvailable('peer-1', true)
    store.setActiveView({ kind: 'dm', peerId: 'peer-1' })

    expect(await screen.findByText(EMPTY_DM_FEED_TEXT)).toBeInTheDocument()
    expect(screen.queryByText(EMPTY_ROOM_FEED_TEXT)).not.toBeInTheDocument()
  })

  it('sidebar DM section keeps its header with an empty state and lists channels later', async () => {
    render(<Sidebar />)
    const section = screen.getByRole('region', { name: 'Mensajes directos' })
    expect(section.textContent).toContain(EMPTY_DM_LIST_TEXT)

    useAppStore.getState().ensureDmChannel('peer-1', 'luna-cauta', 'A31F 09BC 77D2 4E5A')
    useAppStore.getState().setDmAvailable('peer-1', true)
    await waitFor(() => {
      expect(screen.queryByText(EMPTY_DM_LIST_TEXT)).not.toBeInTheDocument()
    })
    expect(section.textContent).toContain('luna-cauta')
  })

  it('Recientes shows an empty state with rememberRooms on and nothing remembered', async () => {
    useAppStore.getState().setRecentRooms([])
    render(<Sidebar />)
    expect(screen.getByRole('region', { name: 'Salas recientes' })).toHaveTextContent(
      EMPTY_RECENTS_TEXT,
    )

    // Off → the whole section disappears (RF-02).
    useSettingsStore.getState().setSettings({ rememberRooms: false })
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Salas recientes' })).not.toBeInTheDocument()
    })
  })
})
