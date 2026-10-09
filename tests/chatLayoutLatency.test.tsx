// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { ChatLayout } from '../src/components/chat/ChatLayout'

// act() is used only to wrap the store-mutating leaveRoom call.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import * as manager from '../src/lib/p2p/roomManager'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * RF-06 regression (validation audit): the ping/pong loop measures latency
 * — per peer and room: must run its own 5 s loop, not just
 * the focused one, so background rooms keep fresh latency data and the
 * degraded ⚪ marking works there too.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  useSettingsStore.getState().setSettings({ autoJoinLobby: false })
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.useRealTimers()
})

function pingTargets(room: FakeTrysteroRoom): (string | string[] | null | undefined)[] {
  return room.action('ping').sends.map((send) => send.options?.target)
}

describe('per-room latency loops (RF-06)', () => {
  it('pings the peers of every active room, including non-focused ones', async () => {
    await manager.joinRoom('lobby')
    await manager.joinRoom('dev')
    const lobby = fake.rooms[0] as FakeTrysteroRoom
    const dev = fake.rooms[1] as FakeTrysteroRoom
    lobby.peerJoin('peer-a')
    dev.peerJoin('peer-b')

    // No focused view: before the fix the only loop was bound to the active
    // room, so nothing would ever ping here.
    render(<ChatLayout />)

    // Nothing before the first cadence tick.
    await vi.advanceTimersByTimeAsync(0)
    expect(pingTargets(lobby)).toEqual([])
    expect(pingTargets(dev)).toEqual([])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(pingTargets(lobby)).toContain('peer-a')
    expect(pingTargets(dev)).toContain('peer-b')
  })

  it('stops pinging a room after it is left', async () => {
    const connection = await manager.joinRoom('lobby')
    const lobby = fake.rooms[0] as FakeTrysteroRoom
    lobby.peerJoin('peer-a')
    render(<ChatLayout />)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(pingTargets(lobby)).toContain('peer-a')

    const sendsBefore = pingTargets(lobby).length
    await act(async () => {
      await manager.leaveRoom(connection.roomId)
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pingTargets(lobby).length).toBe(sendsBefore)
  })
})
