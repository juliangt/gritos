import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import {
  createSlashExecutorContext,
  executeSlashCommand,
  slashErrorLine,
  type SlashDirective,
  type SlashExecutorContext,
} from '../src/lib/slashExecutor'
import { parseSlashCommand } from '../src/lib/slashCommands'
import { useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { useUiStore } from '../src/stores/useUiStore'
import { INVALID_ROOM_NAME_TEXT } from '../src/lib/rooms'
import { NICKNAME_ERROR_TEXT } from '../src/lib/nickname'
import {
  NO_ACTIVE_ROOM_TEXT,
  UNKNOWN_COMMAND_HINT,
  activeRoomsLine,
  dmAmbiguousLine,
  dmPeerNotFoundLine,
  nicknameChangedLine,
} from '../src/lib/feed'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #99 Phase 2 — the slash-command executor: pure dispatch against a
 * fake context (per-command effects), then the REAL context factory against
 * the stores + manager with the fake Trystero transport (end-to-end: /nick
 * re-announce, /sala cap/recovery, /dm focus, /salir, /limpiar, /me echo).
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeTrystero()
  useUiStore.setState({
    joinPopoverName: null,
    helpOpen: false,
    clearFeedOpen: false,
    recoveryRoom: null,
  })
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.useRealTimers()
})

function flushMicrotasks(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0).then(() => undefined)
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

/** A context of vi.fn() seams; every test asserts exactly what was touched. */
function makeCtx(overrides: Partial<SlashExecutorContext> = {}): SlashExecutorContext {
  return {
    appendSystemLine: vi.fn(),
    setNickname: vi.fn(),
    joinRoomFocused: vi.fn(async () => ({ roomId: 'room-1', error: null })),
    armPasswordRecovery: vi.fn(),
    activePeers: vi.fn(() => []),
    openDmChannel: vi.fn(() => true),
    activeRooms: vi.fn(() => []),
    activeRoom: vi.fn(() => null),
    requestClearConfirmation: vi.fn(),
    leaveRoom: vi.fn(),
    openHelp: vi.fn(),
    ...overrides,
  }
}

/** Parses + executes in one step: the composer's exact Phase-3 call shape. */
async function run(input: string, ctx: SlashExecutorContext): Promise<SlashDirective> {
  const parsed = parseSlashCommand(input)
  expect(parsed).not.toBeNull()
  return executeSlashCommand(parsed as NonNullable<typeof parsed>, ctx)
}

describe('dispatch against a fake context', () => {
  it('literal escape: returns the text to send and touches no seam', async () => {
    const ctx = makeCtx()
    expect(await run('\\/hola', ctx)).toEqual({ type: 'send-chat', text: '/hola' })
    expect(ctx.appendSystemLine).not.toHaveBeenCalled()
    expect(ctx.setNickname).not.toHaveBeenCalled()
  })

  it('unknown verb: prints the /ayuda hint and never produces a send', async () => {
    const ctx = makeCtx()
    expect(await run('/foo bar baz', ctx)).toEqual({ type: 'none' })
    expect(ctx.appendSystemLine).toHaveBeenCalledTimes(1)
    expect(ctx.appendSystemLine).toHaveBeenCalledWith(UNKNOWN_COMMAND_HINT)
  })

  it('parse errors: usage and validation wording, never a send', async () => {
    const cases: Array<[string, string]> = [
      ['/nick', 'Uso: /nick <nombre>'],
      ['/salir 1', 'Uso: /salir'],
      ['/me', 'Uso: /me <acción>'],
      ['/nick x!', `${NICKNAME_ERROR_TEXT} Uso: /nick <nombre>`],
      ['/sala mal nombre!', `${INVALID_ROOM_NAME_TEXT} Uso: /sala <nombre>`],
      ['/salas extra', 'Uso: /salas'],
    ]
    for (const [input, line] of cases) {
      const ctx = makeCtx()
      expect(await run(input, ctx)).toEqual({ type: 'none' })
      expect(ctx.appendSystemLine).toHaveBeenCalledWith(line)
    }
  })

  it('/me: a send directive carrying the action and the local italic marker', async () => {
    const ctx = makeCtx()
    expect(await run('/me se pone a bailar', ctx)).toEqual({
      type: 'send-chat',
      text: 'se pone a bailar',
      isAction: true,
    })
    expect(ctx.appendSystemLine).not.toHaveBeenCalled()
  })

  it('/nick: renames through the manager seam and confirms with a line', async () => {
    const ctx = makeCtx()
    expect(await run('/nick luna-cauta', ctx)).toEqual({ type: 'none' })
    expect(ctx.setNickname).toHaveBeenCalledWith('luna-cauta')
    expect(ctx.appendSystemLine).toHaveBeenCalledWith(nicknameChangedLine('luna-cauta'))
  })

  it('/nick: a manager rejection surfaces its message, without the success line', async () => {
    // The parser accepts 'luna-cauta' (same RF-01 rules), so the throw can
    // only come from the manager seam — the defense-in-depth path.
    const ctx = makeCtx({
      setNickname: vi.fn(() => {
        throw new manager.NicknameError('luna-cauta')
      }),
    })
    await run('/nick luna-cauta', ctx)
    expect(ctx.appendSystemLine).toHaveBeenCalledTimes(1)
    expect(ctx.appendSystemLine).toHaveBeenCalledWith('Apodo no válido: «luna-cauta»')
  })

  it('/sala: a rejected join prints the manager error verbatim (the #87 cap message)', async () => {
    const ctx = makeCtx({
      joinRoomFocused: vi.fn(async () => ({
        roomId: null,
        error: 'Límite de salas activas alcanzado (4)',
      })),
    })
    await run('/sala dev', ctx)
    expect(ctx.joinRoomFocused).toHaveBeenCalledWith('dev')
    expect(ctx.appendSystemLine).toHaveBeenCalledWith('Límite de salas activas alcanzado (4)')
    expect(ctx.armPasswordRecovery).not.toHaveBeenCalled()
  })

  it('/sala: a successful join arms the password-recovery offer (popover flow)', async () => {
    const ctx = makeCtx()
    await run('/sala mi-sala', ctx)
    expect(ctx.armPasswordRecovery).toHaveBeenCalledWith('mi-sala')
    expect(ctx.appendSystemLine).not.toHaveBeenCalled()
  })

  it('/dm: unique match opens the channel, matching case-insensitively', async () => {
    const ctx = makeCtx({
      activePeers: vi.fn(() => [{ id: 'peer-1', nickname: 'luna-cauta' }]),
    })
    await run('/dm LUNA-CAUTA', ctx)
    expect(ctx.openDmChannel).toHaveBeenCalledWith('peer-1')
    expect(ctx.appendSystemLine).not.toHaveBeenCalled()
  })

  it('/dm: unknown nickname and ambiguity each print their error line', async () => {
    const notFound = makeCtx({ activePeers: vi.fn(() => []) })
    await run('/dm fantasma', notFound)
    expect(notFound.openDmChannel).not.toHaveBeenCalled()
    expect(notFound.appendSystemLine).toHaveBeenCalledWith(dmPeerNotFoundLine('fantasma'))

    const ambiguous = makeCtx({
      activePeers: vi.fn(() => [
        { id: 'peer-1', nickname: 'luna-cauta' },
        { id: 'peer-2', nickname: 'luna-cauta' },
      ]),
    })
    await run('/dm luna-cauta', ambiguous)
    expect(ambiguous.openDmChannel).not.toHaveBeenCalled()
    expect(ambiguous.appendSystemLine).toHaveBeenCalledWith(dmAmbiguousLine('luna-cauta'))
  })

  it('/dm: a channel that fails to open (peer gone) reads as not found', async () => {
    const ctx = makeCtx({
      activePeers: vi.fn(() => [{ id: 'peer-1', nickname: 'luna-cauta' }]),
      openDmChannel: vi.fn(() => false),
    })
    await run('/dm luna-cauta', ctx)
    expect(ctx.appendSystemLine).toHaveBeenCalledWith(dmPeerNotFoundLine('luna-cauta'))
  })

  it('/salas: prints the active-rooms line built from the store read', async () => {
    const rooms = [
      { id: 'r1', name: 'lobby', unread: 2 },
      { id: 'r2', name: 'dev', unread: 0 },
    ]
    const ctx = makeCtx({ activeRooms: vi.fn(() => rooms) })
    await run('/salas', ctx)
    expect(ctx.appendSystemLine).toHaveBeenCalledWith(activeRoomsLine(rooms))
    expect(ctx.appendSystemLine).toHaveBeenCalledWith('Salas activas: #lobby (2 sin leer), #dev')
  })

  it('/limpiar: opens the confirmation for the active room, errors without one', async () => {
    const idle = makeCtx({ activeRoom: vi.fn(() => null) })
    await run('/limpiar', idle)
    expect(idle.requestClearConfirmation).not.toHaveBeenCalled()
    expect(idle.appendSystemLine).toHaveBeenCalledWith(NO_ACTIVE_ROOM_TEXT)

    const focused = makeCtx({ activeRoom: vi.fn(() => ({ id: 'r1', name: 'lobby' })) })
    await run('/limpiar', focused)
    expect(focused.requestClearConfirmation).toHaveBeenCalledTimes(1)
    expect(focused.leaveRoom).not.toHaveBeenCalled()
    expect(focused.appendSystemLine).not.toHaveBeenCalled()
  })

  it('/salir: leaves the active room through the manager seam, errors without one', async () => {
    const idle = makeCtx({ activeRoom: vi.fn(() => null) })
    await run('/salir', idle)
    expect(idle.leaveRoom).not.toHaveBeenCalled()
    expect(idle.appendSystemLine).toHaveBeenCalledWith(NO_ACTIVE_ROOM_TEXT)

    const focused = makeCtx({ activeRoom: vi.fn(() => ({ id: 'r1', name: 'lobby' })) })
    await run('/salir', focused)
    expect(focused.leaveRoom).toHaveBeenCalledWith('r1')
    expect(focused.appendSystemLine).not.toHaveBeenCalled()
  })

  it('/ayuda: flips the help-overlay seam', async () => {
    const ctx = makeCtx()
    await run('/ayuda', ctx)
    expect(ctx.openHelp).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Real context (stores + manager + fake transport): the wiring
// `createSlashExecutorContext` installs, end to end.
// ---------------------------------------------------------------------------

describe('createSlashExecutorContext', () => {
  it('/nick renames, persists and re-announces presence on every active room', async () => {
    const lobby = await manager.joinRoom('lobby')
    const dev = await manager.joinRoom('dev')
    fake.rooms[0]?.peerJoin('peer-1')
    fake.rooms[1]?.peerJoin('peer-2')
    await flushMicrotasks()
    const lobbySends = fake.rooms[0]!.action('presence').sends.length
    const devSends = fake.rooms[1]!.action('presence').sends.length

    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const ctx = createSlashExecutorContext()
    await run('/nick nuevo-apodo', ctx)
    await flushMicrotasks()

    expect(useAppStore.getState().identity?.nickname).toBe('nuevo-apodo')
    const lobbyBroadcast = fake.rooms[0]!.lastSend('presence')
    expect(lobbyBroadcast.data).toMatchObject({ nick: 'nuevo-apodo' })
    expect(fake.rooms[0]!.action('presence').sends).toHaveLength(lobbySends + 1)
    expect(fake.rooms[1]!.action('presence').sends).toHaveLength(devSends + 1)
    expect(storedRoom(lobby.roomId).messages.at(-1)?.text).toBe(nicknameChangedLine('nuevo-apodo'))
    expect(storedRoom(lobby.roomId).messages.at(-1)?.kind).toBe('system')
    expect(manager.getRoomConnection(dev.roomId)).toBeDefined()
  })

  it('/sala at the cap prints the #87 cap message and joins nothing', async () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 1 })
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const ctx = createSlashExecutorContext()
    await run('/sala dev', ctx)
    await flushMicrotasks()

    expect(manager.getActiveRoomCount()).toBe(1)
    expect(useUiStore.getState().recoveryRoom).toBeNull()
    expect(storedRoom(lobby.roomId).messages.at(-1)?.text).toBe(
      'Límite de salas activas alcanzado (1)',
    )
  })

  it('/sala focuses the joined room and arms its password-recovery offer', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const ctx = createSlashExecutorContext()
    await run('/sala Mi Sala', ctx)
    await flushMicrotasks()

    const joined = Object.values(useAppStore.getState().rooms).find(
      (room) => room.name === 'mi-sala',
    )
    expect(joined).toBeDefined()
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: joined!.id })
    expect(useUiStore.getState().recoveryRoom).toBe('mi-sala')
  })

  it('/salas lists every active room with unread counts in the focused feed', async () => {
    const lobby = await manager.joinRoom('lobby')
    const dev = await manager.joinRoom('dev')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    useAppStore.getState().appendMessage(dev.roomId, {
      id: 'm1',
      roomId: dev.roomId,
      authorId: 'peer-1',
      authorNick: 'par',
      text: 'hola',
      ts: Date.now(),
      encrypted: false,
      status: 'delivered',
      kind: 'user',
    })

    const ctx = createSlashExecutorContext()
    await run('/salas', ctx)
    const feed = storedRoom(lobby.roomId).messages
    expect(feed.at(-1)?.kind).toBe('system')
    expect(feed.at(-1)?.text).toBe('Salas activas: #lobby, #dev (1 sin leer)')
  })

  it('/dm resolves a peer by nickname and focuses the DM view', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    fake.rooms[0]?.peerJoin('peer-abcdef12')
    fake.rooms[0]?.receive('presence', { nick: 'luna-cauta', fp: 'x' }, 'peer-abcdef12')
    await flushMicrotasks()

    const ctx = createSlashExecutorContext()
    await run('/dm luna-cauta', ctx)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-abcdef12' })
    expect(useAppStore.getState().dms['peer-abcdef12']?.peerNick).toBe('luna-cauta')
  })

  it('/dm without a matching peer prints the not-found line and changes nothing', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const viewBefore = useAppStore.getState().activeView

    const ctx = createSlashExecutorContext()
    await run('/dm fantasma', ctx)
    expect(useAppStore.getState().activeView).toEqual(viewBefore)
    expect(storedRoom(lobby.roomId).messages.at(-1)?.text).toBe(dmPeerNotFoundLine('fantasma'))
  })

  it('/me: the directive flows into sendChat as a LOCAL italic echo, wire-clean', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    fake.rooms[0]?.peerJoin('peer-1')
    await flushMicrotasks()

    const ctx = createSlashExecutorContext()
    const directive = await run('/me se estira', ctx)
    expect(directive).toEqual({ type: 'send-chat', text: 'se estira', isAction: true })

    // What the Phase-3 composer does with the directive: the normal chat
    // send path, with the isAction marker forwarded.
    const envelope = manager.sendChat(lobby.roomId, 'se estira', undefined, {
      isAction: true,
    })
    expect(envelope).not.toBeNull()
    expect(envelope).not.toHaveProperty('isAction') // wire form untouched
    const own = storedRoom(lobby.roomId).messages.at(-1)
    expect(own).toMatchObject({ authorId: 'self', text: 'se estira', isAction: true })

    // The receive path rebuilds messages through parseEnvelope, which drops
    // unknown fields: a peer's copy of the same message is never flagged.
    fake.rooms[0]?.receive(
      'chat',
      {
        v: 1,
        id: 'x1',
        ts: Date.now(),
        from: 'peer-1',
        nick: 'par',
        kind: 'chat',
        enc: false,
        iv: null,
        body: 'se estira',
      },
      'peer-1',
    )
    const theirs = storedRoom(lobby.roomId).messages.filter(
      (message) => message.authorId === 'peer-1',
    )
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.isAction).toBeUndefined()
  })

  it('/salir leaves the active room through the same path as the sidebar menu', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const ctx = createSlashExecutorContext()
    await run('/salir', ctx)
    await flushMicrotasks()

    expect(manager.getActiveRoomCount()).toBe(0)
    expect(useAppStore.getState().rooms[lobby.roomId]).toBeUndefined()
  })

  it('/salir without an active room prints the local error line', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    const ctx = createSlashExecutorContext()
    // No focused view: the line has nowhere to land, but nothing crashes
    // and nothing is left behind either.
    useAppStore.getState().setActiveView(null)
    await run('/salir', ctx)
    await flushMicrotasks()
    expect(manager.getRoomConnection(lobby.roomId)).toBeDefined()
  })

  it('/limpiar opens the confirmation; the dialog wipe clears only the local view', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    useAppStore.getState().appendMessage(lobby.roomId, {
      id: 'm1',
      roomId: lobby.roomId,
      authorId: 'peer-1',
      authorNick: 'par',
      text: 'hola',
      ts: Date.now(),
      encrypted: false,
      status: 'delivered',
      kind: 'user',
    })
    // Latch the FIFO fact: the separator must survive the wipe.
    useAppStore.getState().upsertRoom({ ...storedRoom(lobby.roomId), fifoTrimmed: true })

    const ctx = createSlashExecutorContext()
    await run('/limpiar', ctx)
    expect(useUiStore.getState().clearFeedOpen).toBe(true)

    // What the ConfirmDialog's confirm button does (ChatLayout wiring).
    useAppStore.getState().clearRoomFeed(lobby.roomId)
    const room = storedRoom(lobby.roomId)
    expect(room.messages).toEqual([])
    expect(room.fifoTrimmed).toBe(true)
    expect(manager.getRoomConnection(lobby.roomId)).toBeDefined() // not a leave
  })

  it('unknown verbs land as a local line and never reach the wire', async () => {
    const lobby = await manager.joinRoom('lobby')
    useAppStore.getState().setActiveView({ kind: 'room', id: lobby.roomId })
    fake.rooms[0]?.peerJoin('peer-1')
    await flushMicrotasks()

    const ctx = createSlashExecutorContext()
    expect(await run('/noexiste hola', ctx)).toEqual({ type: 'none' })
    expect(storedRoom(lobby.roomId).messages.at(-1)?.text).toBe(UNKNOWN_COMMAND_HINT)
    expect(fake.rooms[0]!.action('chat').sends).toHaveLength(0)
  })
})

describe('slashErrorLine', () => {
  it('reuses the owning libs for validation wording', () => {
    const parsed = parseSlashCommand('/nick x!')
    expect(parsed).toMatchObject({ kind: 'error', error: 'invalid-nick' })
    expect(slashErrorLine(parsed as Extract<NonNullable<typeof parsed>, { kind: 'error' }>)).toBe(
      `${NICKNAME_ERROR_TEXT} Uso: /nick <nombre>`,
    )
  })
})
