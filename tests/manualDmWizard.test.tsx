// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatLayout } from '../src/components/chat/ChatLayout'
import { NetworkErrorBanner } from '../src/components/chat/NetworkErrorBanner'
import { Sidebar } from '../src/components/sidebar/Sidebar'
import { ManualDmWizard } from '../src/components/dm/ManualDmWizard'
import { ManualPeerEngine, setPeerConnectionFactory } from '../src/lib/p2p/manualPeer'
import { resetManualDmForTests } from '../src/lib/p2p/manualDmManager'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { createSessionIdentity, type SessionIdentity } from '../src/lib/crypto/identity'
import { generateEphemeralSession, type EphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import { canonicalFingerprint, clearDmKeyCache } from '../src/lib/crypto/dm'
import { INITIAL_APP_STATE, useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'
import {
  connectPair,
  createFakePeerPair,
  installFakePeerConnectionFactory,
  type FakePeerPair,
  type FakeRTCPeerConnection,
} from './fakeManualPeer'
import {
  MANUAL_BLOB_ERROR_TEXT,
  MANUAL_DM_BANNER_SHORTCUT,
  MANUAL_DM_COPY_BUTTON,
  MANUAL_DM_COPIED_FEEDBACK,
  MANUAL_DM_GENERATE_ANSWER_BUTTON,
  MANUAL_DM_INVITE_BLOB_LABEL,
  MANUAL_DM_INVITE_ENTRY,
  MANUAL_DM_NETWORK_WARNING,
  MANUAL_DM_PASTE_ANSWER_LABEL,
  MANUAL_DM_PASTE_INVITE_LABEL,
  MANUAL_DM_PROGRESS_CONNECTED,
  MANUAL_DM_PROGRESS_ESTABLISHING,
  MANUAL_DM_ROLE_ANSWER_BUTTON,
  MANUAL_DM_ROLE_INVITE_BUTTON,
  MANUAL_DM_WIZARD_LABEL,
} from '../src/components/settings/messages'

/**
 * Phase 3 UI of issue #97 (spec §12.2): the trackerless manual DM wizard —
 * entry points (sidebar «+ invitación», tracker-error banner shortcut), both
 * roles over the REAL engine and the fake PC pair (integration style), bad
 * paste retry, cancellation with dispose, the focus trap, and the connected
 * channel rendered by the standard DM view (DmHeader, «(sin sala)»).
 */

let sessionB: SessionIdentity
let ephB: EphemeralSession

beforeEach(async () => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  clearDmKeyCache()
  installFakeTrystero()
  sessionB = await createSessionIdentity('zorro-b')
  ephB = await generateEphemeralSession()
})

afterEach(async () => {
  cleanup()
  resetManualDmForTests()
  resetManagerForTests()
  setPeerConnectionFactory(null)
  useAppStore.setState({ ...INITIAL_APP_STATE })
  localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** One event-loop turn via MessageChannel (manualPeer.test pattern). */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * One real event-loop turn that lets starved Web Crypto completions
 * interleave — MessageChannel ticks alone burn thousands of iterations in
 * microseconds without the hash landing under a full parallel suite.
 */
function yieldRealTurn(): Promise<void> {
  // Off globalThis: the DOM lib does not declare setImmediate.
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => void }).setImmediate
  if (typeof immediate === 'function') {
    return new Promise((resolve) => immediate(resolve))
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function untilParked(getPc: () => FakeRTCPeerConnection): Promise<void> {
  // Cheap turns first (crypto usually lands within a few event-loop turns),
  // then real-turn yields bounded by a 5 s wall-clock deadline: under the
  // full parallel suite the Web Crypto threadpool is starved across workers
  // and short tick loops give up before the hash lands.
  for (let i = 0; i < 20; i += 1) {
    await tick()
    if (getPc().localDescription !== null) return
  }
  const deadline = Date.now() + 5_000
  for (;;) {
    await yieldRealTurn()
    if (getPc().localDescription !== null) return
    if (Date.now() >= deadline) {
      throw new Error('fake pc never reached setLocalDescription')
    }
  }
}

function manualKey(): string {
  return `manual:${canonicalFingerprint(sessionB.identity.fingerprint)}`
}

/** Harness with real open/close state so Esc/Esc-cancel paths are honest. */
function WizardHarness(props: { onClose?: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <ManualDmWizard
      open={open}
      onClose={() => {
        props.onClose?.()
        setOpen(false)
      }}
    />
  )
}

/** Reads the blob out of the readonly textarea once it is rendered. */
async function waitForBlob(label: string): Promise<string> {
  let blob = ''
  await waitFor(() => {
    const textarea = screen.getByLabelText(label) as HTMLTextAreaElement
    expect(textarea.value.length).toBeGreaterThan(0)
    blob = textarea.value
  })
  return blob
}

/** Role A through the wizard: returns the invite blob once it is shown. */
async function createInviteThroughWizard(
  pair: FakePeerPair,
  onClose?: () => void,
): Promise<string> {
  render(<WizardHarness onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_ROLE_INVITE_BUTTON }))
  await untilParked(() => pair.pcA)
  pair.pcA.completeGathering()
  return waitForBlob(MANUAL_DM_INVITE_BLOB_LABEL)
}

/** Remote peer (role B) over the second fake PC; resolves the answer blob. */
async function answerAsPeer(
  pair: FakePeerPair,
  inviteBlob: string,
  callbacks?: ConstructorParameters<typeof ManualPeerEngine>[0]['callbacks'],
): Promise<{ engine: ManualPeerEngine; answerBlob: string }> {
  const engine = new ManualPeerEngine({
    role: 'answer',
    session: sessionB,
    ephemeral: ephB,
    callbacks,
  })
  const answering = engine.acceptInvite(inviteBlob)
  await untilParked(() => pair.pcB)
  pair.pcB.completeGathering()
  return { engine, answerBlob: await answering }
}

function seedManualChannel(available: boolean): string {
  const key = manualKey()
  const store = useAppStore.getState()
  store.ensureManualDmChannel(key, 'zorro-b', sessionB.identity.fingerprint)
  store.setManualDmAvailable(key, available)
  store.setActiveView({ kind: 'dm', peerId: key })
  return key
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return writeText
}

describe('manual DM wizard (issue #97, spec §12.2)', () => {
  it('opens from the sidebar «+ invitación» entry', () => {
    const onOpenManualDm = vi.fn()
    render(<Sidebar onOpenManualDm={onOpenManualDm} />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_INVITE_ENTRY }))
    expect(onOpenManualDm).toHaveBeenCalledTimes(1)
  })

  it('opens from the tracker-error banner shortcut', () => {
    const onOpenManualDm = vi.fn()
    useAppStore.getState().upsertRoom({
      id: 'room-lobby',
      name: 'lobby',
      hasPassword: false,
      status: 'error',
      peers: [],
      messages: [],
      typing: {},
      unread: 0,
      fifoTrimmed: false,
      expiredCount: 0,
    })
    render(<NetworkErrorBanner onOpenManualDm={onOpenManualDm} />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_BANNER_SHORTCUT }))
    expect(onOpenManualDm).toHaveBeenCalledTimes(1)
  })

  it('both entries render the same wizard through the layout', () => {
    useAppStore.getState().setIdentity({
      nickname: 'luna-cauta',
      fingerprint: 'B31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })
    useAppStore.getState().upsertRoom({
      id: 'room-err',
      name: 'err',
      hasPassword: false,
      status: 'error',
      peers: [],
      messages: [],
      typing: {},
      unread: 0,
      fifoTrimmed: false,
      expiredCount: 0,
    })
    render(<ChatLayout />)

    // Sidebar entry.
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_INVITE_ENTRY }))
    expect(screen.getByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).not.toBeInTheDocument()

    // Banner shortcut opens the SAME dialog.
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_BANNER_SHORTCUT }))
    expect(screen.getByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).toBeInTheDocument()
  })

  it('role A happy path over the fake pair: blob, copy, warning, answer, connect', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const writeText = stubClipboard()

    render(<WizardHarness />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_ROLE_INVITE_BUTTON }))
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    const inviteBlob = await waitForBlob(MANUAL_DM_INVITE_BLOB_LABEL)

    // The exact §12.2 warning accompanies the copyable blob.
    expect(screen.getByText(MANUAL_DM_NETWORK_WARNING)).toBeInTheDocument()

    // Copy with brief feedback, routed through the clipboard.
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_COPY_BUTTON }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(inviteBlob)
    })
    expect(await screen.findByText(MANUAL_DM_COPIED_FEEDBACK)).toBeInTheDocument()

    // The peer answers; the wizard pastes it and connects.
    const { answerBlob } = await answerAsPeer(pair, inviteBlob)
    fireEvent.change(screen.getByLabelText(MANUAL_DM_PASTE_ANSWER_LABEL), {
      target: { value: answerBlob },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect(await screen.findByText(MANUAL_DM_PROGRESS_ESTABLISHING)).toBeInTheDocument()

    connectPair(pair)

    // Connection-status vocabulary at connect (§12.2 contract), then the
    // wizard closes itself into the standard DM view.
    expect(await screen.findByText(MANUAL_DM_PROGRESS_CONNECTED)).toBeInTheDocument()
    const key = manualKey()
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: key })
    })
    const channel = useAppStore.getState().manualDms[key]
    expect(channel?.available).toBe(true)
    expect(channel?.peerNick).toBe('zorro-b')
    // The TOFU pin is written on first connect.
    const pins = JSON.parse(localStorage.getItem('gritos:tofu') ?? '{}') as Record<string, string>
    expect(pins[key]).toBe(sessionB.identity.fingerprint)
    // …and the wizard is gone.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).not.toBeInTheDocument()
    })
  })

  it('role B happy path: paste invite → answer blob with warning → connected', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    render(<WizardHarness />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_ROLE_ANSWER_BUTTON }))

    // The remote side (role A) creates the invite over the first queued PC.
    const sessionA = await createSessionIdentity('zorro-a')
    const ephA = await generateEphemeralSession()
    const engineA = new ManualPeerEngine({ role: 'invite', session: sessionA, ephemeral: ephA })
    const inviting = engineA.createInvite()
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    const inviteBlob = await inviting

    fireEvent.change(screen.getByLabelText(MANUAL_DM_PASTE_INVITE_LABEL), {
      target: { value: inviteBlob },
    })
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_GENERATE_ANSWER_BUTTON }))
    await untilParked(() => pair.pcB)
    pair.pcB.completeGathering()
    const answerBlob = await waitForBlob(MANUAL_DM_INVITE_BLOB_LABEL)
    // The warning shows here too: the answer blob is also shown to copy.
    expect(screen.getByText(MANUAL_DM_NETWORK_WARNING)).toBeInTheDocument()

    await engineA.acceptAnswer(answerBlob)
    connectPair(pair)

    const key = `manual:${canonicalFingerprint(sessionA.identity.fingerprint)}`
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: key })
    })
    expect(useAppStore.getState().manualDms[key]?.peerNick).toBe('zorro-a')
  })

  it('a bad paste shows the inline error and keeps the wizard open (retryable)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    render(<WizardHarness />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_ROLE_ANSWER_BUTTON }))

    fireEvent.change(screen.getByLabelText(MANUAL_DM_PASTE_INVITE_LABEL), {
      target: { value: 'esto no es un blob' },
    })
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_GENERATE_ANSWER_BUTTON }))
    expect(await screen.findByRole('alert')).toHaveTextContent(MANUAL_BLOB_ERROR_TEXT.encoding)
    // The wizard stays open: the paste can be corrected and retried.
    expect(screen.getByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).toBeInTheDocument()

    // A valid invite recovers in place — no restart needed.
    const sessionA = await createSessionIdentity('zorro-a')
    const ephA = await generateEphemeralSession()
    const engineA = new ManualPeerEngine({ role: 'invite', session: sessionA, ephemeral: ephA })
    const inviting = engineA.createInvite()
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    const inviteBlob = await inviting

    fireEvent.change(screen.getByLabelText(MANUAL_DM_PASTE_INVITE_LABEL), {
      target: { value: inviteBlob },
    })
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_GENERATE_ANSWER_BUTTON }))
    await untilParked(() => pair.pcB)
    pair.pcB.completeGathering()
    const answerBlob = await waitForBlob(MANUAL_DM_INVITE_BLOB_LABEL)
    expect(answerBlob.length).toBeGreaterThan(0)
  })

  it('cancel from the waiting state disposes the engine and closes with no traces', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const onClose = vi.fn()
    await createInviteThroughWizard(pair, onClose)

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).not.toBeInTheDocument()
    // The engine transport was closed (dispose), and nothing landed in the
    // store: pre-connect cancel leaves zero traces (§12.2).
    expect(pair.pcA.closed).toBe(true)
    expect(useAppStore.getState().manualDms).toEqual({})
  })

  it('traps the focus inside the wizard and closes with Esc (cancel)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const onClose = vi.fn()
    render(<WizardHarness onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })

    // Initial focus lands inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Tab cycles inside; the Cancelar button is the last focusable.
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    expect(focusables.length).toBeGreaterThan(1)
    focusables[focusables.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(focusables[0])

    // Esc cancels (dispose + close), like the Cancelar button.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).not.toBeInTheDocument()
    })
  })

  it('a connected manual channel renders the standard DM view with (sin sala)', () => {
    stubClipboard()
    useAppStore.getState().setIdentity({
      nickname: 'luna-cauta',
      fingerprint: 'B31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })
    const key = seedManualChannel(true)

    render(<ChatLayout />)

    // DmHeader works unchanged: nick, fingerprint and the TOFU notice before
    // the first message.
    expect(screen.getByRole('heading', { level: 1, name: 'zorro-b' })).toBeInTheDocument()
    expect(screen.getByText(sessionB.identity.fingerprint)).toBeInTheDocument()
    expect(
      screen.getByText('Compáralo con tu interlocutor para verificar su identidad'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 par')).toBeInTheDocument()

    // The DmList entry carries the manual marker.
    const section = screen.getByRole('region', { name: 'Mensajes directos' })
    expect(section.textContent).toContain('zorro-b')
    expect(within(section).getByText('(sin sala)')).toBeInTheDocument()

    // The composer is live for a connected manual channel.
    expect(screen.getByLabelText('Escribe un mensaje')).toBeEnabled()
    expect(key.startsWith('manual:')).toBe(true)
  })

  it('a disconnected manual channel mirrors the room disconnected state', () => {
    useAppStore.getState().setIdentity({
      nickname: 'luna-cauta',
      fingerprint: 'B31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })
    seedManualChannel(false)

    render(<ChatLayout />)

    // Exact RF-04 wording in the header and the composer, disabled input.
    expect(screen.getAllByText('El par se ha desconectado')).toHaveLength(2)
    expect(screen.getByLabelText('Escribe un mensaje')).toBeDisabled()
    // The sidebar entry keeps the disconnected marker next to «(sin sala)».
    expect(screen.getByLabelText('par desconectado')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Mensajes directos' })).getByText('(sin sala)'),
    ).toBeInTheDocument()
  })

  it('sends from the composer over the connected manual channel and typing round-trips', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    useAppStore.getState().setIdentity({
      nickname: 'luna-cauta',
      fingerprint: 'B31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })

    // The peer side observes dm/typing frames like a real second client.
    const received: string[] = []
    const typingSeen: boolean[] = []

    // Connect through the wizard first (the real path); then use the layout.
    render(<WizardHarness />)
    fireEvent.click(screen.getByRole('button', { name: MANUAL_DM_ROLE_INVITE_BUTTON }))
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    const inviteBlob = await waitForBlob(MANUAL_DM_INVITE_BLOB_LABEL)
    const { engine: peerEngine, answerBlob } = await answerAsPeer(pair, inviteBlob, {
      onDmMessage: (_envelope, text) => {
        received.push(text)
      },
      onTyping: (on) => {
        typingSeen.push(on)
      },
    })
    fireEvent.change(screen.getByLabelText(MANUAL_DM_PASTE_ANSWER_LABEL), {
      target: { value: answerBlob },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    // The paste must LAND before the pair connects: the establishing status
    // only appears once acceptAnswer applied (state answer-pasted), so the
    // data channels below open into a machine that can go `connected` —
    // a channel opening during `invite-ready` is ignored (fake-PC artifact:
    // real WebRTC cannot open before the SDP exchange completes).
    expect(await screen.findByText(MANUAL_DM_PROGRESS_ESTABLISHING)).toBeInTheDocument()
    connectPair(pair)
    const key = manualKey()
    await waitFor(() => {
      expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: key })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: MANUAL_DM_WIZARD_LABEL })).not.toBeInTheDocument()
    })

    // The composer routes through the manual manager: the send lands in the
    // feed AND reaches the peer over the manual channel.
    render(<ChatLayout />)
    const textarea = screen.getByLabelText('Escribe un mensaje')
    fireEvent.change(textarea, { target: { value: 'hola sin trackers' } })
    // Composing raises the typing flag on the peer side.
    await waitFor(() => {
      expect(typingSeen).toContain(true)
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByLabelText('Mensajes directos con zorro-b').textContent).toContain(
        'hola sin trackers',
      )
    })
    await waitFor(() => {
      expect(received).toContain('hola sin trackers')
    })

    // The peer's typing flag lights the shared TypingBar with the DmHeader
    // nickname (room-DM typing semantics, §7.1).
    peerEngine.sendTyping(true)
    await waitFor(() => {
      expect(screen.getByText('zorro-b está escribiendo…')).toBeInTheDocument()
    })
  })
})
