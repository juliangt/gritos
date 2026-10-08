// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import { buildQrMatrix, type QrMatrix } from '../src/lib/qr'
import {
  QR_DARK_COLOR,
  QR_EXPORT_MIN_PX,
  QR_LIGHT_COLOR,
  QR_ONSCREEN_MODULE_PX,
  qrExportModulePx,
  qrPngFilename,
  qrPixelSize,
} from '../src/lib/qrCanvas'
import { buildRoomLink } from '../src/lib/shareLinks'
import type { Room } from '../src/stores/useAppStore'
import {
  QR_BUTTON_LABEL,
  QR_DIALOG_LABEL,
  QR_DOWNLOAD_BUTTON,
  QR_SAME_INSTALL_NOTE,
  qrCanvasLabel,
} from '../src/components/settings/messages'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #100 (Phase 2) — the QR invite popover behind the header's 'QR'
 * button: it renders the exact share link (buildRoomLink output, never the
 * password — RF-05) as a canvas QR plus the link fallback, the same-install
 * note and the PNG download. jsdom ships no real canvas, so the 2D context
 * is stubbed with a minimal fillRect/fillStyle recorder: that keeps the
 * painting assertions non-visual but exact (module count, colors, geometry),
 * and the download path is exercised by stubbing toBlob + the object URL
 * (same spirit as the navigator.share/clipboard stubs in shareButton.test).
 */

beforeEach(() => {
  localStorage.clear()
  installFakeTrystero()
  installCanvasStub()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreUrlStubs()
})

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-x',
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

// ---------------------------------------------------------------------------
// Canvas stubs
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

/** Every canvas (in-popover and export) records its paints instead. */
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

// jsdom has no URL.createObjectURL/revokeObjectURL; capture the original
// descriptors so the afterEach restore works either way.
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

function restoreUrlStubs(): void {
  for (const [name, descriptor] of [
    ['createObjectURL', originalCreateObjectURL],
    ['revokeObjectURL', originalRevokeObjectURL],
  ] as const) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(URL, name)
    } else {
      Object.defineProperty(URL, name, descriptor)
    }
  }
}

/** Counts dark modules row-major over the full N x N grid (qr.test helper). */
function countDark(matrix: QrMatrix): number {
  let count = 0
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (matrix.isDark(row, col)) count++
    }
  }
  return count
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function openQrPopover(roomOverrides: Partial<Room> = {}): HTMLElement {
  render(<ChatHeader room={room(roomOverrides)} onToggleSidebar={vi.fn()} />)
  const opener = screen.getByRole('button', { name: QR_BUTTON_LABEL })
  opener.focus()
  fireEvent.click(opener)
  return screen.getByRole('dialog', { name: QR_DIALOG_LABEL })
}

describe('ChatHeader QR popover (issue #100, Phase 2)', () => {
  it('opens with the named canvas, the share link and the same-install note', () => {
    const dialog = openQrPopover({ name: 'lobby' })

    expect(within(dialog).getByRole('img', { name: qrCanvasLabel('lobby') })).toBeInTheDocument()
    expect(within(dialog).getByText(buildRoomLink('lobby'))).toBeInTheDocument()
    expect(within(dialog).getByText(QR_SAME_INSTALL_NOTE)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: QR_DOWNLOAD_BUTTON })).toBeInTheDocument()
  })

  it('offers no QR affordance without an active room', () => {
    render(<ChatHeader room={null} onToggleSidebar={vi.fn()} />)
    expect(screen.queryByRole('button', { name: QR_BUTTON_LABEL })).not.toBeInTheDocument()
  })

  it('paints exactly the buildQrMatrix dark modules over a white quiet zone', () => {
    const dialog = openQrPopover({ name: 'lobby' })
    const canvas = within(dialog).getByRole('img', {
      name: qrCanvasLabel('lobby'),
    }) as HTMLCanvasElement

    const matrix = buildQrMatrix(buildRoomLink('lobby'))
    expect(canvas.width).toBe(qrPixelSize(matrix.moduleCount, QR_ONSCREEN_MODULE_PX))
    expect(canvas.height).toBe(canvas.width)

    const context = contexts.get(canvas)
    expect(context).toBeDefined()
    // White background first, then the fixed dark color: exactly two
    // fillStyle assignments in both themes (see lib/qrCanvas docblock).
    expect(context?.fillStyles).toEqual([QR_LIGHT_COLOR, QR_DARK_COLOR])
    // One background rect + one rect per dark module — the recorded paint
    // count matches the encoder's dark count (non-visual fidelity check).
    expect(context?.rects).toHaveLength(1 + countDark(matrix))
    const [background, ...modules] = context?.rects ?? []
    expect(background).toEqual({ x: 0, y: 0, w: canvas.width, h: canvas.height })
    for (const rect of modules) {
      expect(rect.w).toBe(QR_ONSCREEN_MODULE_PX)
      expect(rect.h).toBe(QR_ONSCREEN_MODULE_PX)
    }
  })

  it('scales the canvas with long room names (no fixed size)', () => {
    const longName = 'x'.repeat(32)
    const dialog = openQrPopover({ name: longName })
    const canvas = within(dialog).getByRole('img', {
      name: qrCanvasLabel(longName),
    }) as HTMLCanvasElement

    const matrix = buildQrMatrix(buildRoomLink(longName))
    expect(matrix.moduleCount).toBeGreaterThan(buildQrMatrix(buildRoomLink('lobby')).moduleCount)
    expect(canvas.width).toBe(qrPixelSize(matrix.moduleCount, QR_ONSCREEN_MODULE_PX))
    expect(contexts.get(canvas)?.rects).toHaveLength(1 + countDark(matrix))
  })

  it('never encodes a password-room secret: the link text and the painted matrix carry only the room name', () => {
    // The Room model has no password field at all — only the hasPassword
    // flag — so a leak could only ride the link string. Assert the exact
    // buildRoomLink output is shown and that the painted matrix is the one
    // for exactly that text (size + dark-module count).
    const dialog = openQrPopover({ name: 'secreta', hasPassword: true })

    const link = buildRoomLink('secreta')
    expect(link).toContain('#sala=secreta')
    expect(within(dialog).getByText(link)).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('password')

    const canvas = within(dialog).getByRole('img', {
      name: qrCanvasLabel('secreta'),
    }) as HTMLCanvasElement
    const matrix = buildQrMatrix(link)
    expect(canvas.width).toBe(qrPixelSize(matrix.moduleCount, QR_ONSCREEN_MODULE_PX))
    expect(contexts.get(canvas)?.rects).toHaveLength(1 + countDark(matrix))
  })

  it('downloads a PNG named gritos-sala-<name> with the export size floor', () => {
    const toBlobCanvases: HTMLCanvasElement[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      toBlobCanvases.push(this)
      callback(new Blob(['png-bytes'], { type: 'image/png' }))
    })
    const createdUrl = 'blob:qr-png-test'
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => createdUrl,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    })
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })

    const dialog = openQrPopover({ name: 'lobby' })
    fireEvent.click(within(dialog).getByRole('button', { name: QR_DOWNLOAD_BUTTON }))

    // The exported canvas is scaled from the matrix moduleCount: >= 8 px per
    // module and floored at QR_EXPORT_MIN_PX.
    const matrix = buildQrMatrix(buildRoomLink('lobby'))
    const exportCanvas = toBlobCanvases[0]
    expect(exportCanvas).toBeDefined()
    const expectedSize = qrPixelSize(matrix.moduleCount, qrExportModulePx(matrix.moduleCount))
    expect(exportCanvas?.width).toBe(expectedSize)
    expect(expectedSize).toBeGreaterThanOrEqual(QR_EXPORT_MIN_PX)
    expect(exportCanvas?.height).toBe(exportCanvas?.width)

    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe(qrPngFilename('lobby'))
    expect(clicked[0]?.href).toBe(createdUrl)
    expect(revokeObjectURL).toHaveBeenCalledWith(createdUrl)
  })

  it('export sizing grows with the matrix and never drops below 512px', () => {
    const short = buildQrMatrix(buildRoomLink('lobby'))
    const long = buildQrMatrix(buildRoomLink('x'.repeat(32)))
    expect(long.moduleCount).toBeGreaterThan(short.moduleCount)

    for (const matrix of [short, long]) {
      const modulePx = qrExportModulePx(matrix.moduleCount)
      expect(modulePx).toBeGreaterThanOrEqual(8)
      expect(qrPixelSize(matrix.moduleCount, modulePx)).toBeGreaterThanOrEqual(QR_EXPORT_MIN_PX)
    }
  })

  it('moves the initial focus inside and traps Tab within the dialog', () => {
    const dialog = openQrPopover({ name: 'lobby' })
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    expect(focusables.length).toBeGreaterThan(0)
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Tab on the last focusable wraps to the first.
    focusables[focusables.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])

    // Shift+Tab on the first focusable wraps to the last.
    focusables[0].focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])
  })

  it('closes on Esc and returns focus to the QR button', () => {
    render(<ChatHeader room={room({ name: 'lobby' })} onToggleSidebar={vi.fn()} />)
    const opener = screen.getByRole('button', { name: QR_BUTTON_LABEL })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: QR_DIALOG_LABEL })).toBeInTheDocument()

    // Modal's shared focus trap listens on document (capture) — same target
    // as modal.test.tsx.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: QR_DIALOG_LABEL })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('closes on an outside (backdrop) click', () => {
    const dialog = openQrPopover({ name: 'lobby' })

    // The backdrop is the overlay wrapping the dialog panel (Modal).
    const backdrop = dialog.parentElement as HTMLElement
    fireEvent.mouseDown(backdrop, { target: backdrop })
    expect(screen.queryByRole('dialog', { name: QR_DIALOG_LABEL })).not.toBeInTheDocument()
  })
})
