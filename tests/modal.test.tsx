// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ConfirmDialog } from '../src/components/common/ConfirmDialog'
import { Modal } from '../src/components/common/Modal'

/**
 * M5 modal primitives (RNF-05): focus trap (Tab cycles inside), Esc closes,
 * backdrop click closes, focus restored to the opener, and stacked modals
 * close topmost-first.
 */

function Harness(props: { open: boolean; onClose: () => void }) {
  return (
    <div>
      <button type="button" onClick={() => props.onClose()}>
        abrir
      </button>
      <Modal open={props.open} onClose={props.onClose} label="prueba">
        <button type="button">primero</button>
        <button type="button">segundo</button>
      </Modal>
    </div>
  )
}

afterEach(() => {
  cleanup()
})

describe('Modal (RNF-05)', () => {
  it('renders role="dialog" with aria-modal and the accessible label', () => {
    render(<Modal open onClose={() => {}} label="Ajustes">
      <button type="button">x</button>
    </Modal>)
    expect(screen.getByRole('dialog', { name: 'Ajustes' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Ajustes' })).toHaveAttribute('aria-modal', 'true')
  })

  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} label="Ajustes">
      <button type="button">x</button>
    </Modal>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('moves the initial focus inside and traps Tab cycling', () => {
    render(<Harness open onClose={() => {}} />)
    const first = screen.getByText('primero')
    const second = screen.getByText('segundo')
    // Initial focus lands on the first focusable element.
    expect(document.activeElement).toBe(first)

    // Tab on the last element wraps to the first.
    second.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // Shift+Tab on the first element wraps to the last.
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(second)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Other keys never close.
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop clicks but not on clicks inside the panel', () => {
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} />)
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(backdrop, { target: backdrop })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(screen.getByText('primero'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the opener element on close', () => {
    const { rerender } = render(<Harness open={false} onClose={() => {}} />)
    const opener = screen.getByText('abrir')
    opener.focus()
    rerender(<Harness open onClose={() => {}} />)
    expect(document.activeElement).not.toBe(opener)
    rerender(<Harness open={false} onClose={() => {}} />)
    expect(document.activeElement).toBe(opener)
  })

  it('restores focus when the modal unmounts while open', () => {
    // The opener lives in a container that survives the modal's unmount.
    const openerRender = render(
      <button type="button" onClick={() => {}}>
        abrir externo
      </button>,
    )
    const opener = openerRender.getByText('abrir externo')
    opener.focus()
    const modalRender = render(
      <Modal open onClose={() => {}} label="prueba">
        <button type="button">dentro</button>
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByText('dentro'))
    modalRender.unmount()
    expect(document.activeElement).toBe(opener)
    openerRender.unmount()
  })

  it('stacked modals: Esc closes only the topmost', () => {
    function Stack() {
      const [outer, setOuter] = useState(true)
      const [inner, setInner] = useState(true)
      return (
        <div>
          <Modal open={outer} onClose={() => setOuter(false)} label="exterior">
            <Modal open={inner} onClose={() => setInner(false)} label="interior">
              <button type="button">interior-boton</button>
            </Modal>
            <button type="button">exterior-boton</button>
          </Modal>
        </div>
      )
    }
    render(<Stack />)
    expect(screen.getByRole('dialog', { name: 'exterior' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'interior' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'interior' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'exterior' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'exterior' })).not.toBeInTheDocument()
  })
})

describe('ConfirmDialog (RF-07/RF-08)', () => {
  it('shows title and body, and confirms/cancels through the buttons', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Regenerar identidad"
        body="¿Continuar?"
        confirmLabel="Regenerar"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Regenerar identidad' })).toBeInTheDocument()
    expect(screen.getByText('¿Continuar?')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Regenerar'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Cancelar'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('marks the confirm button as the red destructive action when danger', () => {
    render(
      <ConfirmDialog
        open
        title="Borrar todo y salir"
        body="¿Continuar?"
        confirmLabel="Borrar todo"
        danger
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    const confirm = screen.getByTestId('confirm-dialog-confirm')
    expect(confirm).toHaveClass('bg-red-600')
    // Focus starts on the safe Cancel button.
    expect(document.activeElement).toBe(screen.getByText('Cancelar'))
  })
})
