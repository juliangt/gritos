// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useNotifications } from '../src/hooks/useNotifications'
import * as manager from '../src/lib/p2p/roomManager'
import { computeFingerprint } from '../src/lib/crypto/identity'
import { deriveDmKeyV2, encryptDm, clearDmKeyCache } from '../src/lib/crypto/dm'
import { createEnvelope, DM_PROTOCOL_VERSION, type Envelope } from '../src/lib/p2p/protocol'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { fakePeerJoins, installFakeTrystero, makeFakeRemotePeer } from './fakeTrystero'

/**
 * M5 end-to-end (RF-09): the useNotifications hook turns the two manager
 * seams into OS notifications behind the full gate — permission granted,
 * settings toggle on, tab hidden — with the exact §10.5 titles and the
 * click → window.focus() + origin-view navigation. The Notification API and
 * document.hidden are stubbed; the messages travel through the real
 * (fake-transport) manager receive paths.
 */

class FakeNotification {
  static permission = 'granted'
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  title: string
  options?: { body?: string }
  close = vi.fn()

  constructor(title: string, options?: { body?: string }) {
    this.title = title
    this.options = options
    FakeNotification.instances.push(this)
  }
}

let fake: ReturnType<typeof installFakeTrystero>

function stubEnvironment(overrides: { hidden: boolean; permission: string }): void {
  Object.defineProperty(document, 'hidden', { value: overrides.hidden, configurable: true })
  FakeNotification.permission = overrides.permission
  FakeNotification.instances = []
  vi.stubGlobal('Notification', FakeNotification)
}

/** Lets the async decrypt/store tails (ECDH → HKDF → AES-GCM) settle. */
function flushCrypto(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

function chatEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: 'peer-1',
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola',
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  useSettingsStore.getState().setSettings({ notifications: true })
  clearDmKeyCache()
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

describe('useNotifications (RF-09 end to end)', () => {
  it('a hidden-tab mention notifies with the exact title; click navigates to the room', async () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    renderHook(() => useNotifications())

    const connection = await manager.joinRoom('general')
    const room = fake.rooms[fake.rooms.length - 1]
    room.peerJoin('peer-1')

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    room.receive('chat', chatEnvelope({ body: `hola @${ownNick}` }), 'peer-1')
    await flushCrypto()

    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — mención en #general')
    expect(FakeNotification.instances[0]?.options?.body).toBe(`zorro-bravo: hola @${ownNick}`)

    FakeNotification.instances[0]?.onclick?.()
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: connection.roomId })
  })

  it('a non-mention, a visible tab, a denied permission and the toggle off never notify', async () => {
    const ownNick = manager.getSessionIdentity()?.identity.nickname
    stubEnvironment({ hidden: true, permission: 'granted' })
    renderHook(() => useNotifications())

    const connection = await manager.joinRoom('general')
    const room = fake.rooms[fake.rooms.length - 1]
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ body: 'sin mención' }), 'peer-1')
    if (ownNick !== undefined) {
      room.receive('chat', chatEnvelope({ body: `x@${ownNick}` }), 'peer-1')
    }
    await flushCrypto()
    expect(FakeNotification.instances).toHaveLength(0)

    // Visible tab: nothing.
    stubEnvironment({ hidden: false, permission: 'granted' })
    if (ownNick !== undefined) {
      room.receive('chat', chatEnvelope({ body: `hola @${ownNick}` }), 'peer-1')
    }
    await flushCrypto()
    expect(FakeNotification.instances).toHaveLength(0)

    // Denied permission: nothing.
    stubEnvironment({ hidden: true, permission: 'denied' })
    if (ownNick !== undefined) {
      room.receive('chat', chatEnvelope({ body: `hola @${ownNick}` }), 'peer-1')
    }
    await flushCrypto()
    expect(FakeNotification.instances).toHaveLength(0)

    // Settings toggle off: nothing.
    stubEnvironment({ hidden: true, permission: 'granted' })
    useSettingsStore.getState().setSettings({ notifications: false })
    if (ownNick !== undefined) {
      room.receive('chat', chatEnvelope({ body: `hola @${ownNick}` }), 'peer-1')
    }
    await flushCrypto()
    expect(FakeNotification.instances).toHaveLength(0)
    expect(useAppStore.getState().rooms[connection.roomId]?.unread).toBeGreaterThan(0)
  })

  it('a hidden-tab incoming DM notifies; click navigates to the DM view', async () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    renderHook(() => useNotifications())

    // Remote peer A — a v2-capable peer (identity + ephemeral announces) —
    // shares #lobby with the manager (issue #93, spec §12.1).
    const a = await makeFakeRemotePeer('peer-a')

    const connection = await manager.joinRoom('lobby')
    const room = fake.rooms[fake.rooms.length - 1]
    await fakePeerJoins(room, a, { nick: 'luna-cauta' })
    await flushCrypto()

    // A seals the DM against the manager's announced EPHEMERAL key with the
    // v2 derivation (both fingerprint pairs in the salt).
    const mineEph = room.action('ephkeys').sends[0]?.data as Uint8Array
    const dmKey = await deriveDmKeyV2(
      a.ephKeypair.privateKey,
      mineEph,
      a.fingerprint,
      manager.getSessionIdentity()?.identity.fingerprint as string,
      a.ephFingerprint,
      await computeFingerprint(mineEph),
    )
    const sealed = await encryptDm(dmKey, '¿me ves?')
    room.receive(
      'dm',
      createEnvelope({
        from: 'peer-a',
        nick: 'luna-cauta',
        kind: 'dm',
        to: manager.getSelfPeerId(),
        enc: true,
        iv: sealed.iv,
        body: sealed.payload,
        v: DM_PROTOCOL_VERSION,
      }),
      'peer-a',
    )
    await flushCrypto()

    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — DM de luna-cauta')
    expect(FakeNotification.instances[0]?.options?.body).toBe('luna-cauta: ¿me ves?')

    FakeNotification.instances[0]?.onclick?.()
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-a' })
    void connection
  })
})

describe('TTL expiry vs notifications (issue #96 Phase 4)', () => {
  it('a mention in a TTL message notifies at receive; the sweep never retracts it', async () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    renderHook(() => useNotifications())

    const connection = await manager.joinRoom('general')
    const room = fake.rooms[fake.rooms.length - 1]
    room.peerJoin('peer-1')

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    room.receive('chat', chatEnvelope({ body: `hola @${ownNick}`, ttl: 30 }), 'peer-1')
    await flushCrypto()

    // The mention notification fired at receive time, off the store append.
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — mención en #general')

    // The expiry sweep removes ONLY the feed row; the raised notification is
    // a fire-and-forget OS surface — no code path closes or re-raises it.
    expect(useAppStore.getState().rooms[connection.roomId]?.messages).toHaveLength(1)
    manager.pruneExpiredMessages(Date.now() + 31_000)
    const stored = useAppStore.getState().rooms[connection.roomId]
    expect(stored?.messages).toHaveLength(0)
    expect(stored?.expiredCount).toBe(1)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — mención en #general')
    expect(FakeNotification.instances[0]?.close).not.toHaveBeenCalled()
  })
})
