// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { ChatLayout } from '../src/components/chat/ChatLayout'
import { PrivacyTab } from '../src/components/settings/PrivacyTab'
import * as manager from '../src/lib/p2p/roomManager'
import {
  getPendingKnocks,
  isSignalChannelJoined,
  resetSignalChannelForTests,
  setGlobalDmEnabled,
} from '../src/lib/p2p/signalChannel'
import { deriveSignalRoomId } from '../src/lib/p2p/signalChannelConstants'
import {
  canonicalFingerprint,
  clearDmKeyCache,
  decryptDm,
  deriveDmKeyV2,
  encryptDm,
} from '../src/lib/crypto/dm'
import { computeFingerprint } from '../src/lib/crypto/identity'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type DmChannel,
  type Identity,
  type Message,
} from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { useUiStore } from '../src/stores/useUiStore'
import { QR_ONSCREEN_MODULE_PX, qrContactPngFilename, qrPixelSize } from '../src/lib/qrCanvas'
import { buildContactLink } from '../src/lib/shareLinks'
import { buildQrMatrix, type QrMatrix } from '../src/lib/qr'
import { createEnvelope, DM_PROTOCOL_VERSION, type Envelope } from '../src/lib/p2p/protocol'
import {
  CONTACT_COPIED_FEEDBACK,
  CONTACT_COPY_BUTTON,
  CONTACT_DIALOG_LABEL,
  CONTACT_DOWNLOAD_BUTTON,
  CONTACT_ENTRY,
  CONTACT_FP_LABEL,
  CONTACT_KNOCK_ENTRY_BUTTON,
  CONTACT_KNOCK_NOTE_LABEL,
  CONTACT_KNOCK_PASTE_LABEL,
  CONTACT_KNOCK_REJECTED_TEXT,
  CONTACT_KNOCK_SEND_BUTTON,
  CONTACT_KNOCK_WAITING_TEXT,
  CONTACT_QR_CANVAS_LABEL,
  CONTACT_QR_SAME_INSTALL_NOTE,
  GLOBAL_DM_TOGGLE_HINT,
  GLOBAL_DM_TOGGLE_LABEL,
  KNOCK_ACCEPT_BUTTON,
  KNOCK_CARDS_REGION_LABEL,
  KNOCK_MUTE_BUTTON,
  KNOCK_NOTE_PREFIX,
  KNOCK_REJECT_BUTTON,
  knockCardLabel,
  knockConsentText,
} from '../src/components/settings/messages'
import {
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'

/**
 * Issue #105 phase 3 (spec §12.5) — the contact flow UI over the REAL
 * signal-channel manager and the fake transport: the Privacidad toggle
 * joins/leaves the swarm, «My contact» shares the fingerprint (copy + QR +
 * PNG + caveat), «Contact by fingerprint» knocks out and lands in the DM view
 * on the accept ack (one E2EE round trip through the manager), the inbound
 * consent card accepts/rejects/mutes, the note is capped at input, the
 * `#contacto=` deep link prefills the flow, and toggling off mid-flow hides
 * the entries and clears the open states.
 */

let fake: ReturnType<typeof installFakeTrystero>
let SIGNAL_ID: string

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A 0F1E 2D3C 4B5A 6978',
  createdAt: 1_700_000_000_000,
}

beforeEach(async () => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  clearDmKeyCache()
  SIGNAL_ID = await deriveSignalRoomId()
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetSignalChannelForTests()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  useUiStore.setState({ sidebarCollapsed: false })
  localStorage.clear()
  window.history.pushState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Lets the async fingerprint/decrypt tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return sleep(120)
}

/** Polls `cond` with real sleeps (Web Crypto completions must land). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error(`timeout: ${what}`)
}

/** The canonical (compact) form of a raw fingerprint. */
function canon(fp: string): string {
  return canonicalFingerprint(fp)
}

/** The fake room instance of the signal swarm (the last one joined). */
function signalRoom(): FakeTrysteroRoom {
  for (let i = fake.configs.length - 1; i >= 0; i -= 1) {
    if (fake.configs[i]?.roomId === SIGNAL_ID) return fake.rooms[i] as FakeTrysteroRoom
  }
  throw new Error('signal swarm never joined')
}

/** The canonical fingerprint of the manager's own session identity. */
function ownFingerprint(): string {
  const identity = manager.getSessionIdentity()
  if (identity === null) throw new Error('no session identity')
  return canonicalFingerprint(identity.identity.fingerprint)
}

/** Enables the setting (the subscription joins) and waits for the swarm. */
async function enableSwarm(): Promise<FakeTrysteroRoom> {
  // act() so a mounted tree re-renders synchronously (React 18 defers
  // external-store updates outside events).
  act(() => {
    setGlobalDmEnabled(true)
  })
  await until(() => isSignalChannelJoined(), 'signal swarm never joined')
  await flushCrypto()
  return signalRoom()
}

/**
 * Introduces a v2-capable remote peer into the signal swarm exactly like a
 * real build: peer join (the manager answers with its directed whoami/
 * keys/ephkeys burst) + the peer's own whoami/keys/ephkeys announces.
 */
async function signalPeerJoins(
  room: FakeTrysteroRoom,
  peer: FakeRemotePeer,
  nick = 'zorro-b',
): Promise<void> {
  room.peerJoin(peer.id)
  room.receive('whoami', { nick, fp: peer.fingerprint }, peer.id)
  room.receive('keys', peer.rawPublicKey, peer.id)
  room.receive('ephkeys', peer.ephRawKey, peer.id)
  await flushCrypto()
}

/** Renders the chat shell with a session identity and a quiet lobby setting. */
function renderLayout(): void {
  useSettingsStore.getState().setSettings({ autoJoinLobby: false })
  useAppStore.getState().setIdentity(IDENTITY)
  render(<ChatLayout />)
}

/** Opens the contact dialog through the sidebar entry and picks a screen. */
function openContactFlow(pick: 'share' | 'knock'): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: CONTACT_ENTRY }))
  const dialog = screen.getByRole('dialog', { name: CONTACT_DIALOG_LABEL })
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: pick === 'share' ? 'My contact' : CONTACT_KNOCK_ENTRY_BUTTON,
    }),
  )
  return dialog
}

/** The pasted-fingerprint textarea of the open knock screen. */
function pasteField(): HTMLTextAreaElement {
  return screen.getByLabelText(CONTACT_KNOCK_PASTE_LABEL) as HTMLTextAreaElement
}

/** Knocks `peer` from the open dialog (with an optional note) → waiting. */
function knockFromDialog(peer: FakeRemotePeer, note?: string): void {
  fireEvent.change(pasteField(), { target: { value: peer.fingerprint } })
  if (note !== undefined) {
    fireEvent.change(screen.getByLabelText(CONTACT_KNOCK_NOTE_LABEL), {
      target: { value: note },
    })
  }
  fireEvent.click(screen.getByRole('button', { name: CONTACT_KNOCK_SEND_BUTTON }))
  expect(screen.getByText(CONTACT_KNOCK_WAITING_TEXT)).toBeInTheDocument()
}

// ---------------------------------------------------------------------------
// Canvas stubs (the qrShare.test recorder — jsdom has no 2D context)
// ---------------------------------------------------------------------------

/** Minimal 2D context recorder: fillStyle history + every fillRect. */
class RecordingContext {
  readonly fillStyles: string[] = []
  readonly rects: Array<{ x: number; y: number; w: number; h: number }> = []
  private current = ''

  get fillStyle(): string {
    return this.current
  }

  set fillStyle(value: string) {
    this.current = value
    this.fillStyles.push(value)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h })
  }
}

const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>()

function installCanvasStub(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let context = contexts.get(this)
    if (context === undefined) {
      context = new RecordingContext()
      contexts.set(this, context)
    }
    return context as unknown as CanvasRenderingContext2D
  })
}

function countDark(matrix: QrMatrix): number {
  let count = 0
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (matrix.isDark(row, col)) count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Toggle in Privacidad
// ---------------------------------------------------------------------------

describe('PrivacyTab globalDm toggle (spec §12.5)', () => {
  it('renders off by default with the honest §9.5 exposure hint', () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<PrivacyTab />)

    const toggle = screen.getByRole('checkbox', { name: GLOBAL_DM_TOGGLE_LABEL })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(GLOBAL_DM_TOGGLE_HINT)).toBeInTheDocument()
    expect(useSettingsStore.getState().settings.globalDm).toBe(false)
  })

  it('flipping it on joins the signal swarm; off again leaves it', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<PrivacyTab />)

    const toggle = screen.getByRole('checkbox', { name: GLOBAL_DM_TOGGLE_LABEL })
    fireEvent.click(toggle)
    await until(() => isSignalChannelJoined(), 'swarm never joined')
    // The join went through the injectable factory for the derived id.
    expect(fake.configs.some((entry) => entry.roomId === SIGNAL_ID)).toBe(true)
    expect(useSettingsStore.getState().settings.globalDm).toBe(true)

    fireEvent.click(toggle)
    await until(() => !isSignalChannelJoined(), 'swarm never left')
    expect(signalRoom().leave).toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.globalDm).toBe(false)
  })

  it('the «+ contact» sidebar entry exists only while the toggle is on', () => {
    useAppStore.getState().setIdentity(IDENTITY)
    renderLayout()
    expect(screen.queryByRole('button', { name: CONTACT_ENTRY })).not.toBeInTheDocument()

    act(() => {
      setGlobalDmEnabled(true)
    })
    expect(screen.getByRole('button', { name: CONTACT_ENTRY })).toBeInTheDocument()

    act(() => {
      setGlobalDmEnabled(false)
    })
    expect(screen.queryByRole('button', { name: CONTACT_ENTRY })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// «My contact» — fingerprint share (copy + QR + PNG + caveat)
// ---------------------------------------------------------------------------

describe('My contact (share your fingerprint)', () => {
  beforeEach(() => {
    // The «+ contact» entry (and the whole flow) exists only while the
    // global-DM opt-in is on.
    act(() => {
      setGlobalDmEnabled(true)
    })
    installCanvasStub()
  })

  it('shows the fingerprint, the contact QR (painted), the link and the same-install caveat', () => {
    renderLayout()
    openContactFlow('share')

    // The fingerprint in the display form, copyable.
    const fpField = screen.getByLabelText(CONTACT_FP_LABEL) as HTMLTextAreaElement
    expect(fpField.value).toBe(IDENTITY.fingerprint)

    // The QR encodes exactly buildContactLink's output, painted module-exact.
    const link = buildContactLink(IDENTITY.fingerprint)
    const matrix = buildQrMatrix(link)
    const canvas = screen.getByRole('img', { name: CONTACT_QR_CANVAS_LABEL }) as HTMLCanvasElement
    expect(canvas.width).toBe(qrPixelSize(matrix.moduleCount, QR_ONSCREEN_MODULE_PX))
    expect(canvas.height).toBe(canvas.width)
    const context = contexts.get(canvas)
    expect(context?.rects).toHaveLength(1 + countDark(matrix))

    // The link text as the selectable fallback, and the honest caveat.
    expect(screen.getByText(link)).toBeInTheDocument()
    expect(screen.getByText(CONTACT_QR_SAME_INSTALL_NOTE)).toBeInTheDocument()
  })

  it('copies the fingerprint through the clipboard (stubbed) with feedback', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderLayout()
    openContactFlow('share')
    fireEvent.click(screen.getByRole('button', { name: CONTACT_COPY_BUTTON }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(IDENTITY.fingerprint))
    expect(await screen.findByText(CONTACT_COPIED_FEEDBACK)).toBeInTheDocument()
  })

  it('downloads the QR as a PNG named gritos-contact.png (stubs)', () => {
    const toBlobCanvases: HTMLCanvasElement[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      toBlobCanvases.push(this)
      callback(new Blob(['png-bytes'], { type: 'image/png' }))
    })
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => 'blob:qr-contact-test',
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })

    renderLayout()
    openContactFlow('share')
    fireEvent.click(screen.getByRole('button', { name: CONTACT_DOWNLOAD_BUTTON }))

    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe(qrContactPngFilename())
  })
})

// ---------------------------------------------------------------------------
// «Contact by fingerprint» — knock out, accept, E2EE round trip
// ---------------------------------------------------------------------------

describe('Contact by fingerprint (knock out)', () => {
  it('happy path: knock → peer accepts → both land in the (global) DM view and messages flow', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    openContactFlow('knock')
    knockFromDialog(peer, 'hola, soy zorro-bravo')

    // The knock left through the swarm, directed, with the note.
    const knockSend = room.action('knock').sends[0]
    expect(knockSend?.options).toEqual({ target: peer.id })
    expect(knockSend?.data).toMatchObject({
      type: 'knock',
      from: { fp: ownFingerprint() },
      note: 'hola, soy zorro-bravo',
    })
    // No channel before consent.
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()

    // The peer accepts: its knock-ack(true) echoes OUR fingerprint.
    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    await flushCrypto()

    // The dialog landed us in the DM view; the «(global)» channel exists.
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({
        kind: 'dm',
        peerId: canon(peer.fingerprint),
      })
    })
    expect(screen.queryByRole('dialog', { name: CONTACT_DIALOG_LABEL })).not.toBeInTheDocument()
    const channel = useAppStore.getState().dms[canon(peer.fingerprint)]
    expect(channel?.global).toBe(true)
    expect(channel?.available).toBe(true)
    expect(screen.getByRole('heading', { name: 'zorro-b' })).toBeInTheDocument()
    const dmSection = within(screen.getByRole('region', { name: 'Direct messages' }))
    expect(dmSection.getByText('(global)')).toBeInTheDocument()

    // One E2EE round trip through the real manager — B's sealed message:
    const myEphSends = room.action('ephkeys').sends
    const myEphRaw = myEphSends[0]?.data as Uint8Array
    const sharedKey = await deriveDmKeyV2(
      peer.ephKeypair.privateKey,
      myEphRaw,
      peer.fingerprint,
      ownFingerprint(),
      peer.ephFingerprint,
      canon(await computeFingerprint(myEphRaw)),
    )
    const sealed = await encryptDm(sharedKey, 'hola señal')
    room.receive(
      'dm',
      createEnvelope({
        from: peer.id,
        nick: 'zorro-b',
        kind: 'dm',
        to: manager.getSelfPeerId(),
        enc: true,
        iv: sealed.iv,
        body: sealed.payload,
        v: DM_PROTOCOL_VERSION,
      }),
      peer.id,
    )
    await flushCrypto()
    await waitFor(() => {
      expect(channelMessages(canon(peer.fingerprint)).some((m) => m.text === 'hola señal')).toBe(
        true,
      )
    })

    // …and our answer through the composer (routed by the `global` flag).
    const textarea = screen.getByLabelText('Write a message')
    fireEvent.change(textarea, { target: { value: 'hola de vuelta' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Message' }))

    await waitFor(() => {
      const sends = room.action('dm').sends
      expect(sends.some((send) => (send.data as Envelope).to === peer.id)).toBe(true)
    })
    const envelope = room.lastSend('dm').data as Envelope
    expect(envelope.v).toBe(DM_PROTOCOL_VERSION)
    const opened = await decryptDm(sharedKey, { iv: envelope.iv ?? '', payload: envelope.body })
    expect(opened).toBe('hola de vuelta')
    expect(channelMessages(canon(peer.fingerprint)).some((m) => m.text === 'hola de vuelta')).toBe(
      true,
    )
  }, 20_000)

  it('reject path: the ack(false) leaves the sender in the inline «rechazado» state', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    openContactFlow('knock')
    knockFromDialog(peer)

    room.receive('knock-ack', { accept: false, fp: ownFingerprint() }, peer.id)
    await flushCrypto()

    expect(await screen.findByText(CONTACT_KNOCK_REJECTED_TEXT)).toBeInTheDocument()
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()
  })

  it('a pasted value that is not a fingerprint shows the inline error and sends nothing', async () => {
    const room = await enableSwarm()
    renderLayout()

    openContactFlow('knock')
    fireEvent.change(pasteField(), { target: { value: 'esto no es una huella' } })
    fireEvent.click(screen.getByRole('button', { name: CONTACT_KNOCK_SEND_BUTTON }))

    expect(screen.getByRole('alert')).toHaveTextContent(/not a valid fingerprint/)
    expect(room.action('knock').sends).toHaveLength(0)
  })

  it('an unknown (absent) fingerprint surfaces the typed manager error', async () => {
    await enableSwarm()
    renderLayout()

    openContactFlow('knock')
    fireEvent.change(pasteField(), { target: { value: 'A31F09BC77D24E5A0F1E2D3C4B5A6978' } })
    fireEvent.click(screen.getByRole('button', { name: CONTACT_KNOCK_SEND_BUTTON }))

    expect(screen.getByRole('alert')).toHaveTextContent(/not present on the global channel/)
  })

  it('the note is capped at 140 characters at the input', async () => {
    await enableSwarm()
    renderLayout()

    openContactFlow('knock')
    const note = screen.getByLabelText(CONTACT_KNOCK_NOTE_LABEL) as HTMLTextAreaElement
    fireEvent.change(note, { target: { value: 'x'.repeat(150) } })
    expect(note.value).toHaveLength(140)
    expect(screen.getByText('140/140')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Inbound consent card
// ---------------------------------------------------------------------------

describe('inbound knock consent card', () => {
  /** A knock arriving from `peer` (with an optional note). */
  function knockArrives(
    room: FakeTrysteroRoom,
    peer: FakeRemotePeer,
    note?: string,
    nick = 'zorro-b',
  ): void {
    room.receive(
      'knock',
      {
        type: 'knock',
        from: { fp: peer.fingerprint, nick },
        ...(note !== undefined ? { note } : {}),
      },
      peer.id,
    )
  }

  it('accept: ack(true) directed, the (global) channel opens and the DM view focuses', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    knockArrives(room, peer, 'somos amigos del otro bara')

    const card = await screen.findByRole('status', { name: knockCardLabel('zorro-b') })
    expect(within(card).getByText(knockConsentText('zorro-b'))).toBeInTheDocument()
    expect(
      within(card).getByText(`${KNOCK_NOTE_PREFIX}somos amigos del otro bara`),
    ).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: KNOCK_ACCEPT_BUTTON }))

    const ack = room.action('knock-ack').sends[0]
    expect(ack?.options).toEqual({ target: peer.id })
    expect(ack?.data).toEqual({ accept: true, fp: canon(peer.fingerprint) })
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({
        kind: 'dm',
        peerId: canon(peer.fingerprint),
      })
    })
    expect(screen.getByRole('heading', { name: 'zorro-b' })).toBeInTheDocument()
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.global).toBe(true)
    expect(
      screen.queryByRole('status', { name: knockCardLabel('zorro-b') }),
    ).not.toBeInTheDocument()
  })

  it('reject: ack(false), no channel, the card is gone and nobody is remembered', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    knockArrives(room, peer)
    const card = await screen.findByRole('status', { name: knockCardLabel('zorro-b') })
    fireEvent.click(within(card).getByRole('button', { name: KNOCK_REJECT_BUTTON }))

    const ack = room.action('knock-ack').sends[0]
    expect(ack?.data).toEqual({ accept: false, fp: canon(peer.fingerprint) })
    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: knockCardLabel('zorro-b') }),
      ).not.toBeInTheDocument()
    })
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
  })

  it('silenciar: reject + mute — future knocks from that fingerprint never show a card', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    knockArrives(room, peer)
    const card = await screen.findByRole('status', { name: knockCardLabel('zorro-b') })
    fireEvent.click(within(card).getByRole('button', { name: KNOCK_MUTE_BUTTON }))

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([
        canon(peer.fingerprint),
      ])
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: knockCardLabel('zorro-b') }),
      ).not.toBeInTheDocument()
    })

    // A future knock from the muted fingerprint is dropped by the manager's
    // mute gate before any card could appear.
    knockArrives(room, peer, 'otra vez')
    await flushCrypto()
    expect(
      screen.queryByRole('status', { name: knockCardLabel('zorro-b') }),
    ).not.toBeInTheDocument()
    expect(getPendingKnocks()).toEqual([])
    // Only the first ack exists: the second knock never answered.
    expect(room.action('knock-ack').sends).toHaveLength(1)
  })

  it('knocks from several senders queue as one card per sender', async () => {
    const room = await enableSwarm()
    const peerB = await makeFakeRemotePeer('peer-b')
    const peerC = await makeFakeRemotePeer('peer-c')
    await signalPeerJoins(room, peerB)
    await signalPeerJoins(room, peerC, 'luna-c')
    renderLayout()

    knockArrives(room, peerB)
    knockArrives(room, peerC, undefined, 'luna-c')

    expect(
      await screen.findByRole('status', { name: knockCardLabel('zorro-b') }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status', { name: knockCardLabel('luna-c') })).toBeInTheDocument()
    const region = screen.getByRole('region', { name: KNOCK_CARDS_REGION_LABEL })
    expect(within(region).getAllByRole('status')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Deep link `#contacto=<fp>`
// ---------------------------------------------------------------------------

describe('#contacto deep link', () => {
  it('a valid fingerprint opens the flow prefilled and consumes the hash', async () => {
    const peer = await makeFakeRemotePeer('peer-b')
    window.history.pushState({}, '', `/#contacto=${encodeURIComponent(peer.fingerprint)}`)
    renderLayout()

    const dialog = screen.getByRole('dialog', { name: CONTACT_DIALOG_LABEL })
    expect(within(dialog).getByLabelText(CONTACT_KNOCK_PASTE_LABEL)).toHaveValue(
      canon(peer.fingerprint),
    )
    expect(window.location.hash).toBe('')
  })

  it('junk is ignored at log level: no dialog, hash consumed', () => {
    window.history.pushState({}, '', '/#contacto=no-es-huella')
    renderLayout()

    expect(screen.queryByRole('dialog', { name: CONTACT_DIALOG_LABEL })).not.toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Toggle off mid-flow
// ---------------------------------------------------------------------------

describe('toggle off mid-flow', () => {
  it('open consent cards clear when the channel turns off', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    renderLayout()

    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )
    expect(
      await screen.findByRole('status', { name: knockCardLabel('zorro-b') }),
    ).toBeInTheDocument()

    act(() => {
      setGlobalDmEnabled(false)
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: knockCardLabel('zorro-b') }),
      ).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('region', { name: KNOCK_CARDS_REGION_LABEL })).not.toBeInTheDocument()
  })

  it('an open contact dialog closes and the entry hides', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    renderLayout()

    openContactFlow('knock')
    knockFromDialog(peer)
    expect(screen.getByRole('dialog', { name: CONTACT_DIALOG_LABEL })).toBeInTheDocument()

    act(() => {
      setGlobalDmEnabled(false)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: CONTACT_DIALOG_LABEL })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: CONTACT_ENTRY })).not.toBeInTheDocument()
  })
})

/** The messages of one DM channel (helper keeping the assertions readable). */
function channelMessages(peerKey: string): Message[] {
  return (useAppStore.getState().dms[peerKey] as DmChannel | undefined)?.messages ?? []
}
