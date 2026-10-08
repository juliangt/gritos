// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import {
  EXPIRY_SWEEP_INTERVAL_MS,
  createExpirySweepEngine,
  useExpirySweep,
} from '../src/hooks/useExpirySweep'
import { INITIAL_APP_STATE, useAppStore, type Message, type Room } from '../src/stores/useAppStore'

/**
 * Issue #96 — the expiry sweep timer. The engine is a plain object with an
 * injectable clock (the useLatency tick pattern); the hook wires it to one
 * session-wide 1 s interval and is tested with fake timers.
 */

const T0 = 1_760_000_000_000

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

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    roomId: 'room-1',
    authorId: 'peer-1',
    authorNick: 'luna-cauta',
    text: 'hola',
    ts: T0,
    encrypted: false,
    status: 'delivered',
    kind: 'user',
    ...overrides,
  }
}

/** Rooms + a DM channel, each holding one message expiring at T0 + 500 ms. */
function seedFeeds(): void {
  const store = useAppStore.getState()
  store.upsertRoom(makeRoom())
  store.ensureDmChannel('peer-1', 'luna-cauta', null)
  store.appendMessage('room-1', userMessage({ id: 'room-msg', expiresAt: T0 + 500 }))
  store.appendDmMessage(
    'peer-1',
    userMessage({ id: 'dm-msg', roomId: 'dm:peer-1', authorId: 'peer-1', expiresAt: T0 + 500 }),
  )
}

function feedIds(): { room: string[]; dm: string[] } {
  const state = useAppStore.getState()
  return {
    room: (state.rooms['room-1']?.messages ?? []).map((message) => message.id),
    dm: (state.dms['peer-1']?.messages ?? []).map((message) => message.id),
  }
}

describe('expiry sweep engine (issue #96)', () => {
  beforeEach(() => {
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  it('sweeps every room and DM feed at the injected clock', () => {
    seedFeeds()
    let clock = T0
    const engine = createExpirySweepEngine({ now: () => clock })

    engine.tick() // not due yet
    expect(feedIds()).toEqual({ room: ['room-msg'], dm: ['dm-msg'] })

    clock = T0 + 500
    engine.tick()
    expect(feedIds()).toEqual({ room: [], dm: [] })
    expect(useAppStore.getState().rooms['room-1']?.expiredCount).toBe(1)
    expect(useAppStore.getState().dms['peer-1']?.expiredCount).toBe(1)
  })

  it('is a no-op on feeds without expiring messages', () => {
    const store = useAppStore.getState()
    store.upsertRoom(makeRoom())
    store.appendMessage('room-1', userMessage({ id: 'session-lived' }))
    const before = useAppStore.getState().rooms['room-1']

    createExpirySweepEngine({ now: () => T0 }).tick()
    expect(useAppStore.getState().rooms['room-1']).toBe(before)
  })
})

describe('useExpirySweep hook (issue #96)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState({ ...INITIAL_APP_STATE })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it(`sweeps on every ${EXPIRY_SWEEP_INTERVAL_MS} ms tick and stops after unmount`, async () => {
    vi.setSystemTime(T0)
    seedFeeds() // both messages due at T0 + 500
    const { unmount } = renderHook(() => useExpirySweep())

    // First tick fires at exactly 1 s: before it, nothing has run.
    await vi.advanceTimersByTimeAsync(EXPIRY_SWEEP_INTERVAL_MS - 1)
    expect(feedIds()).toEqual({ room: ['room-msg'], dm: ['dm-msg'] })

    await vi.advanceTimersByTimeAsync(1)
    expect(feedIds()).toEqual({ room: [], dm: [] })

    // Unmount frees the interval: later expiries stay in the feed.
    unmount()
    useAppStore
      .getState()
      .appendMessage('room-1', userMessage({ id: 'late', expiresAt: Date.now() }))
    await vi.advanceTimersByTimeAsync(EXPIRY_SWEEP_INTERVAL_MS * 5)
    expect(feedIds().room).toEqual(['late'])
  })
})
