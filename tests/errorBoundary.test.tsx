// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../src/components/common/ErrorBoundary'

/**
 * Top-level error boundary (issue #38): a render crash swaps the tree for a
 * Spanish fallback with a working reload action, and a healthy tree passes
 * through untouched. console.error is muted because React logs the
 * intentional crashes in these tests.
 */

function Child({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('test crash')
  return <p>Sala general</p>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ErrorBoundary', () => {
  it('renders the fallback UI instead of the app when a child throws during render', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Child shouldThrow />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('Sala general')).not.toBeInTheDocument()
    // The crash is reported to console.error for diagnosability.
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('reloads the page when the fallback Recargar button is clicked', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // jsdom forbids redefining location.reload, so swap the global like
    // panic.test.ts does.
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    render(
      <ErrorBoundary>
        <Child shouldThrow />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('renders a healthy tree unchanged inside the boundary', () => {
    render(
      <ErrorBoundary>
        <Child shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Sala general')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
