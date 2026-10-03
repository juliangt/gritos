// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../src/App'

describe('App shell (M0)', () => {
  it('renders the app name and the M2 onboarding note', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'gritos' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/onboarding/i)).toBeInTheDocument()
  })

  it('renders inside a theme-aware root', () => {
    const { container } = render(<App />)
    // jsdom matchMedia stub reports light; the resolved theme must be light.
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(container.firstElementChild).toHaveClass('bg-bg', 'text-text')
  })
})
