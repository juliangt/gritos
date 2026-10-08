// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { JoinRoomPopover } from '../src/components/sidebar/JoinRoomPopover'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { RoomList } from '../src/components/sidebar/RoomList'
import { useAppStore, type Message, type Room } from '../src/stores/useAppStore'
import { deriveRoomId } from '../src/lib/crypto/hashes'
import {
  ENCRYPTED_MESSAGE_PLACEHOLDER,
  EMPTY_ROOM_PASSWORD_TEXT,
  ENCRYPTED_ROOM_HINT,
} from '../src/lib/rooms'
import { resetManagerForTests, setJoinRoomFactory } from '../src/lib/p2p/roomManager'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * M4 UI (RF-05): the join popover's 'sala cifrada' toggle and password
 * field, the not-found status text in the room header, the 🔒 indicators
 * and the encrypted-placeholder feed rendering.
 */

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

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-x',
    name: 'x',
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

describe('JoinRoomPopover — sala cifrada toggle (RF-05)', () => {
  it('hides the password field until the toggle is on, then shows it with the exact hint', () => {
    render(<JoinRoomPopover onJoined={vi.fn()} />)

    expect(screen.queryByLabelText('Contraseña de la sala')).not.toBeInTheDocument()
    expect(screen.queryByText(ENCRYPTED_ROOM_HINT)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('sala cifrada'))
    expect(screen.getByLabelText('Contraseña de la sala')).toBeEnabled()
    expect(screen.getByText(ENCRYPTED_ROOM_HINT)).toHaveTextContent(
      'Quien no tenga la contraseña no encontrará esta sala.',
    )

    fireEvent.click(screen.getByLabelText('sala cifrada'))
    expect(screen.queryByLabelText('Contraseña de la sala')).not.toBeInTheDocument()
  })

  it('requires a non-empty password when the toggle is on (inline Spanish error)', () => {
    render(<JoinRoomPopover onJoined={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Nombre de la sala'), {
      target: { value: 'secreta' },
    })
    fireEvent.click(screen.getByLabelText('sala cifrada'))
    fireEvent.submit(screen.getByRole('form', { name: 'Unirse por nombre' }))

    expect(screen.getByRole('alert')).toHaveTextContent(EMPTY_ROOM_PASSWORD_TEXT)
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
  })

  it('joins with the password: the manager receives it and the room is marked hasPassword', async () => {
    const onJoined = vi.fn()
    render(<JoinRoomPopover onJoined={onJoined} />)

    fireEvent.change(screen.getByLabelText('Nombre de la sala'), {
      target: { value: 'Mi Sala' },
    })
    fireEvent.click(screen.getByLabelText('sala cifrada'))
    fireEvent.change(screen.getByLabelText('Contraseña de la sala'), {
      target: { value: 'clave-secreta' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Unirse por nombre' }))

    const expectedRoomId = await deriveRoomId('mi-sala', 'clave-secreta')
    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
      expect(fake.configs[0]?.roomId).toBe(expectedRoomId)
      expect(onJoined).toHaveBeenCalledWith(expectedRoomId)
    })
    expect(useAppStore.getState().rooms[expectedRoomId]?.hasPassword).toBe(true)
  })

  it('joins without a password when the toggle stays off (public room)', async () => {
    const onJoined = vi.fn()
    render(<JoinRoomPopover onJoined={onJoined} />)

    fireEvent.change(screen.getByLabelText('Nombre de la sala'), {
      target: { value: 'publica' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Unirse por nombre' }))

    const expectedRoomId = await deriveRoomId('publica')
    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
      expect(fake.configs[0]?.roomId).toBe(expectedRoomId)
      expect(onJoined).toHaveBeenCalledWith(expectedRoomId)
    })
    expect(useAppStore.getState().rooms[expectedRoomId]?.hasPassword).toBe(false)
  })
})

describe('🔒 indicators and not-found status (RF-05)', () => {
  it('ChatHeader shows 🔒 next to the room name when hasPassword', () => {
    render(
      <ChatHeader
        room={room({ id: 'room-x', name: 'secreta', hasPassword: true })}
        onToggleSidebar={vi.fn()}
      />,
    )
    expect(screen.getByRole('img', { name: 'sala cifrada' })).toHaveTextContent('🔒')
    expect(screen.getByText(/#secreta/)).toBeInTheDocument()
  })

  it('ChatHeader keeps the plain name for public rooms', () => {
    render(<ChatHeader room={room({ id: 'room-x', name: 'lobby' })} onToggleSidebar={vi.fn()} />)
    expect(screen.queryByRole('img', { name: 'sala cifrada' })).not.toBeInTheDocument()
  })

  it('a password room that exhausts the heuristic shows the single not-found message', () => {
    render(
      <ChatHeader
        room={room({ id: 'room-x', name: 'secreta', hasPassword: true, status: 'error' })}
        onToggleSidebar={vi.fn()}
      />,
    )
    expect(
      screen.getByText('No se ha encontrado la sala #secreta con esa contraseña'),
    ).toBeInTheDocument()
  })

  it('a public room in error keeps the exact §10.3 tracker text', () => {
    render(
      <ChatHeader
        room={room({ id: 'room-x', name: 'lobby', status: 'error' })}
        onToggleSidebar={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        'Sin acceso a trackers — revisa tu conexión o configura trackers alternativos',
      ),
    ).toBeInTheDocument()
  })

  it('RoomList marks password rooms with 🔒 in the sidebar', () => {
    render(
      <RoomList
        rooms={[room({ id: 'room-x', name: 'secreta', hasPassword: true })]}
        recentRooms={[]}
        showRecents={false}
        activeRoomId={null}
        onOpenRoom={vi.fn()}
        onLeaveRoom={vi.fn()}
        onJoinByName={vi.fn()}
      />,
    )
    expect(screen.getByRole('img', { name: 'sala cifrada' })).toHaveTextContent('🔒')
  })
})

describe('encrypted placeholder rendering (RF-05)', () => {
  it('renders the placeholder message in the feed', () => {
    const placeholder: Message = {
      id: 'm1',
      roomId: 'room-x',
      authorId: 'peer-a',
      authorNick: 'zorro-bravo',
      text: ENCRYPTED_MESSAGE_PLACEHOLDER,
      ts: Date.now(),
      encrypted: true,
      status: 'delivered',
      kind: 'user',
    }
    render(
      <MessageFeed
        messages={[placeholder]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="Mensajes de la sala"
      />,
    )
    expect(screen.getByText(ENCRYPTED_MESSAGE_PLACEHOLDER)).toBeInTheDocument()
  })
})
