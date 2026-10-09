import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../../i18n/index'

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Top-level error boundary (issue #38): without it, a render-time exception
 * anywhere unmounts the whole tree to a blank page with no recovery path.
 * The fallback relies on the `--gritos-*` tokens from src/styles/index.css
 * (theme-aware via the `dark` class on <html>) and plain inline styles, so
 * it renders correctly while the app tree is dead — no stores, no context.
 *
 * Issue #119 — the fallback copy resolves through the i18n dictionary via
 * plain `t` (phase 4: the phase-3 census's one missed surface). A class
 * component cannot call the `useT` hook, so there is no live subscription:
 * `t` reads the current locale snapshot at render time, and that is enough
 * — while crashed nothing re-renders on a locale switch, and the crash
 * screen's only way out is the reload, which re-mounts everything in the
 * chosen locale anyway.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled render error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            alignItems: 'center',
            backgroundColor: 'var(--gritos-bg)',
            color: 'var(--gritos-text)',
            display: 'flex',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '1.5rem',
          }}
        >
          <div style={{ maxWidth: '24rem', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
              {t('errors.crashTitle')}
            </h1>
            <p
              style={{
                color: 'var(--gritos-text-muted)',
                lineHeight: 1.5,
                margin: '0.5rem 0 0',
              }}
            >
              {t('errors.crashBody')}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                backgroundColor: 'var(--gritos-accent)',
                border: 'none',
                borderRadius: '0.375rem',
                color: 'var(--gritos-accent-text)',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
                margin: '1rem 0 0',
                padding: '0.5rem 1rem',
              }}
            >
              {t('errors.crashReload')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
