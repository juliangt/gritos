// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatLayout } from '../src/components/chat/ChatLayout'
import * as manager from '../src/lib/p2p/roomManager'
import * as files from '../src/lib/p2p/fileTransfer'
import type { FileMeta } from '../src/lib/p2p/fileTransfer'
import { INITIAL_APP_STATE, useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import {
  FILE_ACCEPT_BUTTON,
  FILE_ATTACH_LABEL,
  FILE_CANCEL_BUTTON,
  FILE_DECLINE_BUTTON,
  FILE_DIALOG_LABEL,
  FILE_DISMISS_BUTTON,
  FILE_DONE_TEXT,
  FILE_DOWNLOAD_BUTTON,
  FILE_ENC_NOTICE_DM,
  FILE_ENC_NOTICE_ROOM,
  FILE_ENC_WARNING_PUBLIC,
  FILE_NO_PEERS_TEXT,
  FILE_OFFER_PENDING_TEXT,
  FILE_PICK_LABEL,
  FILE_PROGRESS_LABEL,
  FILE_RECIPIENT_LABEL,
  FILE_SEND_BUTTON,
  FILE_UNKNOWN_MIME_TEXT,
  fileCardLabel,
  fileFailureText,
  fileOfferText,
  fileRecipientDmText,
  fileRefusalText,
} from '../src/components/settings/messages'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
  type SendRecord,
} from './fakeTrystero'

/**
 * Issue #103 phase 4 — the file-transfer UI driven against the REAL engine
 * over the fake Trystero pair (the fileTransfer.test.ts harness, one floor
 * up): the manager + engine play the local endpoint behind ChatLayout/
 * ChatInput and the suite plays peer A over the fake room's action records.
 * Full consent flows run end to end — pre-send dialog, offer → accept →
 * progress → done card, decline, cancels both ways, dismissal revocation —
 * plus the memory-only invariant: nothing ever reaches localStorage.
 */

const NICK = 'zorro-bravo'
const PUBLIC_ROOM = 'lobby'
const PASSWORD = 'piedra-papel'
const SECRET_ROOM = 'secreta'

const IDENTITY: Identity = {
  nickname: 'luna-cauta',
  fingerprint: 'B31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

let fake: ReturnType<typeof installFakeTrystero>
let A: FakeRemotePeer

// ---------------------------------------------------------------------------
// URL.createObjectURL/revokeObjectURL stubs (jsdom has none): a registry the
// assertions can read, and the revocation log the dismissal test checks.
// ---------------------------------------------------------------------------

const blobRegistry = new Map<string, Blob>()
const revokedUrls: string[] = []
let objectUrlCounter = 0
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(async () => {
  fake = installFakeTrystero()
  A = await makeFakeRemotePeer('peer-a')
  revokedUrls.length = 0
  blobRegistry.clear()
  objectUrlCounter = 0
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob): string => {
      objectUrlCounter += 1
      const url = `blob:fake-${objectUrlCounter}`
      blobRegistry.set(url, blob)
      return url
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string): void => {
      revokedUrls.push(url)
      blobRegistry.delete(url)
    },
  })

  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  // Keep ChatLayout's auto-join out of the way: every test joins explicitly.
  useSettingsStore.getState().setSettings({ autoJoinLobby: false })
  files.resetFileTransfersForTests()
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useAppStore.getState().setIdentity(IDENTITY)
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  files.resetFileTransfersForTests()
  if (originalCreate !== undefined) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  if (originalRevoke !== undefined) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Lets the async fingerprint/crypto tails settle (real timers). */
function flushCrypto(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function lastRoom(): FakeTrysteroRoom {
  const room = fake.rooms[fake.rooms.length - 1]
  if (room === undefined) throw new Error('no fake room joined')
  return room
}

async function joinRoomWithA(
  name: string,
  password?: string,
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name, password)
  const room = lastRoom()
  await fakePeerJoins(room, A, { nick: NICK })
  await flushCrypto()
  useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
  return { roomId: connection.roomId, room }
}

/** The §12.4 frame prefix: first 8 bytes of SHA-256(meta id). */
function fileIdOf(metaId: string) {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(metaId))
    .then((digest) => new Uint8Array(digest).slice(0, 8))
}

function makeFrame(fileId: Uint8Array, seq: number, payload: Uint8Array) {
  const frame = new Uint8Array(12 + payload.length)
  frame.set(fileId, 0)
  new DataView(frame.buffer).setUint32(8, seq, false)
  frame.set(payload, 12)
  return frame
}

/** Fills a Uint8Array with a deterministic pseudo-random pattern. */
function patternBytes(length: number) {
  const bytes = new Uint8Array(length)
  let state = 0x9e3779b9
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    bytes[i] = state & 0xff
  }
  return bytes
}

/** Offers a file from peer A into the manager (the receiver path begins). */
function offerFromA(room: FakeTrysteroRoom, overrides: Partial<FileMeta> = {}): FileMeta {
  const size = overrides.size ?? 500
  const meta: FileMeta = {
    id: crypto.randomUUID(),
    name: 'captura.png',
    size,
    mime: 'image/png',
    chunks: Math.ceil(size / files.FILE_CHUNK_PAYLOAD_BYTES),
    enc: false,
    ...overrides,
  }
  act(() => {
    room.receive('file-meta', meta, A.id)
  })
  return meta
}

function acksOf(room: FakeTrysteroRoom): SendRecord[] {
  return room.action('file-ack').sends
}

function abortsOf(room: FakeTrysteroRoom): SendRecord[] {
  return room.action('file-abort').sends
}

function cardOf(fileName: string): HTMLElement {
  const card = screen.getByLabelText(fileCardLabel(fileName, NICK))
  expect(card).toBeInTheDocument()
  return card
}

async function chooseFile(file: File): Promise<void> {
  const input = screen.getByLabelText(FILE_PICK_LABEL) as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

// ---------------------------------------------------------------------------
// Pre-send dialog
// ---------------------------------------------------------------------------

describe('pre-send dialog (issue #103 phase 4)', () => {
  it('opens from the attachment button with the picker and a disabled send', async () => {
    await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)

    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    expect(screen.getByRole('dialog', { name: FILE_DIALOG_LABEL })).toBeInTheDocument()
    expect(screen.getByLabelText(FILE_PICK_LABEL)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: FILE_SEND_BUTTON })).toBeDisabled()
  })

  it('shows the file meta after picking and the public-room DTLS warning', async () => {
    await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))

    await chooseFile(new File([patternBytes(700)], 'foto.png', { type: 'image/png' }))

    expect(screen.getByText('700 B')).toBeInTheDocument()
    expect(screen.getByText('image/png')).toBeInTheDocument()
    expect(screen.getByText(FILE_ENC_WARNING_PUBLIC)).toBeInTheDocument()
    // A mime-less file shows the honest placeholder.
    await chooseFile(new File([patternBytes(10)], 'sin-tipo.bin'))
    expect(screen.getByText(FILE_UNKNOWN_MIME_TEXT)).toBeInTheDocument()
    // Recipient scope: the room's connected peers only.
    expect(screen.getByRole('combobox', { name: FILE_RECIPIENT_LABEL })).toBeEnabled()
  })

  it('a password room announces the room-key notice instead of the warning', async () => {
    await joinRoomWithA(SECRET_ROOM, PASSWORD)
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))

    expect(screen.getByText(FILE_ENC_NOTICE_ROOM)).toBeInTheDocument()
    expect(screen.queryByText(FILE_ENC_WARNING_PUBLIC)).not.toBeInTheDocument()
  })

  it('with no connected peers there is no recipient and sending is gated', async () => {
    const connection = await manager.joinRoom(PUBLIC_ROOM)
    useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))

    expect(screen.getByText(FILE_NO_PEERS_TEXT)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: FILE_RECIPIENT_LABEL })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: FILE_SEND_BUTTON })).toBeDisabled()
  })

  it('send drives the real engine: file-meta on the wire, dialog closed, sender card', async () => {
    const { roomId, room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    await chooseFile(new File([patternBytes(700)], 'foto.png', { type: 'image/png' }))
    fireEvent.click(screen.getByRole('button', { name: FILE_SEND_BUTTON }))

    await waitFor(() => expect(room.action('file-meta').sends).toHaveLength(1))
    const send = room.lastSend('file-meta')
    expect(send.options).toEqual({ target: A.id })
    const meta = send.data as FileMeta
    expect(meta.name).toBe('foto.png')
    expect(meta.size).toBe(700)
    expect(meta.enc).toBe(false) // public room → the warned DTLS-only mode
    expect(meta.chunks).toBe(1)
    expect(screen.queryByRole('dialog', { name: FILE_DIALOG_LABEL })).not.toBeInTheDocument()

    // The sender's own card: pending consent, no download, cancellable.
    const card = cardOf('foto.png')
    expect(within(card).getByText(FILE_OFFER_PENDING_TEXT)).toBeInTheDocument()
    expect(files.getFileTransfers()[`${A.id}:${meta.id}`]?.direction).toBe('send')
    expect(useAppStore.getState().rooms[roomId]).toBeDefined()
  })

  it('surfaces a local refusal inline and sends nothing (20 MB cap)', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    await chooseFile(new File([new ArrayBuffer(files.MAX_FILE_BYTES + 1)], 'grande.bin'))
    fireEvent.click(screen.getByRole('button', { name: FILE_SEND_BUTTON }))

    expect(await screen.findByText(fileRefusalText('file-too-big'))).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: FILE_DIALOG_LABEL })).toBeInTheDocument()
    expect(room.action('file-meta').sends).toHaveLength(0)
  })

  it('Cancel closes without sending anything', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    await chooseFile(new File([patternBytes(10)], 'a.txt'))
    fireEvent.click(screen.getByRole('button', { name: FILE_CANCEL_BUTTON }))

    expect(screen.queryByRole('dialog', { name: FILE_DIALOG_LABEL })).not.toBeInTheDocument()
    expect(room.action('file-meta').sends).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Receiver — consent before any byte, progress, done card, dismissal
// ---------------------------------------------------------------------------

describe('receiver consent flow (real engine, issue #103 phase 4)', () => {
  it('offer card renders and NOTHING flows until Accept; then image inline', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)

    const bytes = patternBytes(500)
    const meta = offerFromA(room, { name: 'captura.png', mime: 'image/png', size: bytes.length })

    // The consent card, before any byte: sender nick, meta, encryption line.
    const card = cardOf('captura.png')
    expect(within(card).getByText(fileOfferText(NICK))).toBeInTheDocument()
    expect(within(card).getByText('500 B')).toBeInTheDocument()
    expect(within(card).getByText('image/png')).toBeInTheDocument()
    expect(within(card).getByText('No E2E encryption — DTLS only.')).toBeInTheDocument()
    // Not even a byte of control flows for an offer (§12.4).
    expect(acksOf(room)).toHaveLength(0)
    expect(room.action('file-chunk').sends).toHaveLength(0)

    fireEvent.click(within(card).getByRole('button', { name: FILE_ACCEPT_BUTTON }))
    await waitFor(() => expect(acksOf(room)).toHaveLength(1))
    expect(acksOf(room)[0]?.data).toEqual({ id: meta.id, nextSeq: 1, grant: 8 })

    // The suite streams the single chunk; the card completes with the image.
    const fileId = await fileIdOf(meta.id)
    act(() => {
      room.receive('file-chunk', makeFrame(fileId, 1, bytes), A.id)
    })
    const url = await waitFor(() => {
      const record = files.getFileTransferRecord(`${A.id}:${meta.id}`)
      expect(record?.state).toBe('done')
      return record?.url as string
    })

    const doneCard = cardOf('captura.png')
    expect(within(doneCard).getByText(FILE_DONE_TEXT)).toBeInTheDocument()
    const image = within(doneCard).getByRole('img')
    expect(image).toHaveAttribute('alt', 'captura.png')
    expect(image.getAttribute('src')).toMatch(/^blob:/)
    expect(within(doneCard).queryByRole('link')).not.toBeInTheDocument()

    // Dismissal revokes the object URL and retires the card (§12.4).
    fireEvent.click(within(doneCard).getByRole('button', { name: FILE_DISMISS_BUTTON }))
    expect(revokedUrls).toContain(url)
    await waitFor(() =>
      expect(screen.queryByLabelText(fileCardLabel('captura.png', NICK))).not.toBeInTheDocument(),
    )
    expect(files.getFileTransferRecord(`${A.id}:${meta.id}`)).toBeUndefined()
  })

  it('a done non-image offers the download anchor with the sanitized name', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)

    const bytes = patternBytes(700)
    const meta = offerFromA(room, { name: 'notas.txt', mime: 'text/plain', size: bytes.length })
    const card = cardOf('notas.txt')
    fireEvent.click(within(card).getByRole('button', { name: FILE_ACCEPT_BUTTON }))
    await waitFor(() => expect(acksOf(room)).toHaveLength(1))

    const fileId = await fileIdOf(meta.id)
    act(() => {
      room.receive('file-chunk', makeFrame(fileId, 1, bytes), A.id)
    })
    const url = await waitFor(() => {
      const record = files.getFileTransferRecord(`${A.id}:${meta.id}`)
      expect(record?.state).toBe('done')
      return record?.url as string
    })

    const doneCard = cardOf('notas.txt')
    expect(within(doneCard).queryByRole('img')).not.toBeInTheDocument()
    const link = within(doneCard).getByRole('link', { name: FILE_DOWNLOAD_BUTTON })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('download', 'notas.txt')
  })

  it('Decline refuses before any byte: explicit file-abort, honest card', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)

    const meta = offerFromA(room, { name: 'intruso.bin', mime: '', size: 10 })
    const card = cardOf('intruso.bin')
    fireEvent.click(within(card).getByRole('button', { name: FILE_DECLINE_BUTTON }))

    await waitFor(() => expect(abortsOf(room)).toHaveLength(1))
    expect(abortsOf(room)[0]?.data).toEqual({ id: meta.id })
    expect(abortsOf(room)[0]?.options).toEqual({ target: A.id })
    expect(room.action('file-chunk').sends).toHaveLength(0)
    expect(acksOf(room)).toHaveLength(0)

    const rejectedCard = cardOf('intruso.bin')
    expect(within(rejectedCard).getByText('Declined')).toBeInTheDocument()
    fireEvent.click(within(rejectedCard).getByRole('button', { name: FILE_DISMISS_BUTTON }))
    await waitFor(() =>
      expect(screen.queryByLabelText(fileCardLabel('intruso.bin', NICK))).not.toBeInTheDocument(),
    )
  })

  it('progress updates from real chunk events and Cancel works receiver-side', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)

    const chunks = 3
    const bytes = patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 2 + 500)
    const meta = offerFromA(room, {
      name: 'grande.bin',
      mime: 'application/octet-stream',
      size: bytes.length,
      chunks,
    })
    const card = cardOf('grande.bin')
    fireEvent.click(within(card).getByRole('button', { name: FILE_ACCEPT_BUTTON }))
    await waitFor(() => expect(acksOf(room)).toHaveLength(1))

    const fileId = await fileIdOf(meta.id)
    act(() => {
      room.receive(
        'file-chunk',
        makeFrame(fileId, 1, bytes.slice(0, files.FILE_CHUNK_PAYLOAD_BYTES)),
        A.id,
      )
    })
    await waitFor(() => {
      const bar = within(cardOf('grande.bin')).getByRole('progressbar', {
        name: FILE_PROGRESS_LABEL,
      })
      expect(bar).toHaveAttribute('aria-valuemin', '0')
      expect(bar).toHaveAttribute('aria-valuemax', String(chunks))
      expect(bar).toHaveAttribute('aria-valuenow', '1')
    })
    expect(within(cardOf('grande.bin')).getByText('Receiving… 1/3')).toBeInTheDocument()

    // Receiver cancel mid-transfer: file-abort to the sender, honest card.
    fireEvent.click(within(cardOf('grande.bin')).getByRole('button', { name: FILE_CANCEL_BUTTON }))
    await waitFor(() => expect(abortsOf(room)).toHaveLength(1))
    expect(abortsOf(room)[0]?.data).toEqual({ id: meta.id })
    const cancelled = cardOf('grande.bin')
    expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument()
    expect(within(cancelled).queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Sender — pending card, progress, cancel, rejection, failure
// ---------------------------------------------------------------------------

describe('sender flow (real engine, issue #103 phase 4)', () => {
  async function sendFromDialog(room: FakeTrysteroRoom, file: File): Promise<FileMeta> {
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    await chooseFile(file)
    fireEvent.click(screen.getByRole('button', { name: FILE_SEND_BUTTON }))
    await waitFor(() => expect(room.action('file-meta').sends).toHaveLength(1))
    return room.lastSend('file-meta').data as FileMeta
  }

  it('progress advances with the peer acks and sender cancel sends file-abort', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    const chunks = 20
    const meta = await sendFromDialog(
      room,
      new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * chunks)], 'grande.bin'),
    )
    expect(meta.chunks).toBe(chunks)

    // Peer A accepts; the first window flows (8 chunks in flight).
    act(() => {
      room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    })
    await waitFor(() => expect(room.action('file-chunk').sends).toHaveLength(8))
    await waitFor(() => {
      const bar = within(cardOf('grande.bin')).getByRole('progressbar')
      expect(bar).toHaveAttribute('aria-valuemax', String(chunks))
    })

    // A data ack advances the contiguous mark: 8/20 on the card.
    act(() => {
      room.receive('file-ack', { id: meta.id, nextSeq: 9, grant: 8 }, A.id)
    })
    await waitFor(() => {
      expect(within(cardOf('grande.bin')).getByText('Sending… 8/20')).toBeInTheDocument()
    })

    fireEvent.click(within(cardOf('grande.bin')).getByRole('button', { name: FILE_CANCEL_BUTTON }))
    await waitFor(() => expect(abortsOf(room)).toHaveLength(1))
    expect(abortsOf(room)[0]?.data).toEqual({ id: meta.id })
    expect(within(cardOf('grande.bin')).getByText('Cancelled')).toBeInTheDocument()
  })

  it('a peer rejection during the offer shows Declined', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    const meta = await sendFromDialog(room, new File([patternBytes(10)], 'rechazado.bin'))
    act(() => {
      room.receive('file-abort', { id: meta.id }, A.id)
    })
    await waitFor(() =>
      expect(within(cardOf('rechazado.bin')).getByText('Declined')).toBeInTheDocument(),
    )
  })

  it('a mid-transfer peer drop shows the honest failure text', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    const meta = await sendFromDialog(
      room,
      new File([patternBytes(files.FILE_CHUNK_PAYLOAD_BYTES * 20)], 'caida.bin'),
    )
    act(() => {
      room.receive('file-ack', { id: meta.id, nextSeq: 1, grant: 8 }, A.id)
    })
    await waitFor(() => expect(room.action('file-chunk').sends).toHaveLength(8))
    act(() => {
      room.peerLeave(A.id)
    })
    // The leave also removes the peer from the store: the card keeps the
    // record and falls back to the raw peerId in its label/nick line.
    await waitFor(() =>
      expect(
        within(screen.getByLabelText(fileCardLabel('caida.bin', null))).getByText(
          fileFailureText('peer-drop'),
        ),
      ).toBeInTheDocument(),
    )
  })
})

// ---------------------------------------------------------------------------
// DM mode — fixed recipient, DM-key notice, sealed meta, DM-view scoping
// ---------------------------------------------------------------------------

describe('DM file dialog (issue #103 phase 4)', () => {
  async function joinRoomAndDmWithA(): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
    const joined = await joinRoomWithA(PUBLIC_ROOM)
    useAppStore.getState().ensureDmChannel(A.id, NICK, A.fingerprint)
    useAppStore.getState().setDmAvailable(A.id, true)
    act(() => {
      useAppStore.getState().setActiveView({ kind: 'dm', peerId: A.id })
    })
    return joined
  }

  it('fixes the recipient, announces the DM key and seals the offer', async () => {
    const { room } = await joinRoomAndDmWithA()
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))

    expect(screen.getByText(fileRecipientDmText(NICK))).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: FILE_RECIPIENT_LABEL })).not.toBeInTheDocument()
    expect(screen.getByText(FILE_ENC_NOTICE_DM)).toBeInTheDocument()

    await chooseFile(new File([patternBytes(700)], 'secreto.bin'))
    fireEvent.click(screen.getByRole('button', { name: FILE_SEND_BUTTON }))

    await waitFor(() => expect(room.action('file-meta').sends).toHaveLength(1))
    const meta = room.lastSend('file-meta').data as FileMeta
    expect(meta.enc).toBe(true) // DM transfers are ALWAYS sealed (§12.4)
    expect(meta.name).toBe('secreto.bin')
    expect(screen.queryByRole('dialog', { name: FILE_DIALOG_LABEL })).not.toBeInTheDocument()
    expect(screen.getByLabelText(fileCardLabel('secreto.bin', NICK))).toBeInTheDocument()
  })

  it('a DM-kind send stays out of the room view', async () => {
    const { roomId } = await joinRoomAndDmWithA()
    const room = lastRoom()
    render(<ChatLayout />)
    fireEvent.click(screen.getByRole('button', { name: FILE_ATTACH_LABEL }))
    await chooseFile(new File([patternBytes(700)], 'secreto.bin'))
    fireEvent.click(screen.getByRole('button', { name: FILE_SEND_BUTTON }))
    await waitFor(() => expect(room.action('file-meta').sends).toHaveLength(1))
    expect(screen.getByLabelText(fileCardLabel('secreto.bin', NICK))).toBeInTheDocument()

    // Back to the room: the DM-kind transfer must NOT render there.
    act(() => {
      useAppStore.getState().setActiveView({ kind: 'room', id: roomId })
    })
    expect(screen.queryByLabelText(fileCardLabel('secreto.bin', NICK))).not.toBeInTheDocument()
    expect(screen.queryByLabelText('File transfers')).not.toBeInTheDocument()
  })

  it('manual (trackerless) channels offer no attachment: no file host there', () => {
    useAppStore.setState({
      manualDms: {
        'manual:abc': {
          peerId: 'manual:abc',
          peerNick: 'peer-manual',
          peerFingerprint: null,
          messages: [],
          unread: 0,
          expiredCount: 0,
          available: true,
          typing: {},
          keyChanged: false,
          legacyPeer: false,
          manual: true,
        },
      },
    })
    useAppStore.getState().setActiveView({ kind: 'dm', peerId: 'manual:abc' })
    render(<ChatLayout />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: FILE_ATTACH_LABEL })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Memory-only invariant — no file flow ever touches localStorage (§12.4)
// ---------------------------------------------------------------------------

describe('persistence invariant (issue #103 phase 4)', () => {
  it('a full receive-accept-done-dismiss flow leaves localStorage untouched', async () => {
    const { room } = await joinRoomWithA(PUBLIC_ROOM)
    render(<ChatLayout />)
    const keysBefore = Object.keys(localStorage).sort()

    const bytes = patternBytes(700)
    const meta = offerFromA(room, { name: 'efimero.txt', mime: 'text/plain', size: bytes.length })
    const card = cardOf('efimero.txt')
    fireEvent.click(within(card).getByRole('button', { name: FILE_ACCEPT_BUTTON }))
    await waitFor(() => expect(acksOf(room)).toHaveLength(1))
    const fileId = await fileIdOf(meta.id)
    act(() => {
      room.receive('file-chunk', makeFrame(fileId, 1, bytes), A.id)
    })
    await waitFor(() =>
      expect(within(cardOf('efimero.txt')).getByText(FILE_DONE_TEXT)).toBeInTheDocument(),
    )
    fireEvent.click(
      within(cardOf('efimero.txt')).getByRole('button', { name: FILE_DISMISS_BUTTON }),
    )
    await tick()

    expect(Object.keys(localStorage).sort()).toEqual(keysBefore)
    expect(blobRegistry.size).toBe(0)
  })
})
