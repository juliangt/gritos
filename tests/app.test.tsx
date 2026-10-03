// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import App from '../src/App'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'

describe('App shell (M1 debug panel)', () => {
  afterEach(() => {
    cleanup()
    resetManagerForTests()
  })

  it('renders the app name and the M1 debug panel', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'gritos' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('form', { name: 'unirse a sala' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unirse' })).toBeInTheDocument()
  })

  it('renders inside a theme-aware root', () => {
    const { container } = render(<App />)
    // jsdom matchMedia stub reports light; the resolved theme must be light.
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(container.firstElementChild).toHaveClass('bg-bg', 'text-text')
  })
})
