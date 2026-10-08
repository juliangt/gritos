// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../index.html?raw'
import securityPolicy from '../SECURITY.md?raw'

/**
 * Release guard for issue #34 (the repo shipped v1.0.0 with no SECURITY.md
 * and no documented private disclosure path, so researchers had no way to
 * report issues responsibly). Keeps the security policy from silently
 * regressing:
 *
 *  1. the repo-root `SECURITY.md` exists and names GitHub's private
 *     vulnerability reporting as the channel,
 *  2. it declares a supported version line (v1.x), and
 *  3. it points at the authoritative threat model — the accepted trade-offs
 *     in `docs/spec.md` §9.5.
 *
 * The policy is read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk.
 */
describe('security policy (issue #34)', () => {
  it('ships SECURITY.md at the repo root', () => {
    expect(securityPolicy.length).toBeGreaterThan(0)
  })

  it('names GitHub private vulnerability reporting as the channel', () => {
    expect(securityPolicy).toContain('Report a vulnerability')
  })

  it('declares the supported version line (v1.x)', () => {
    expect(securityPolicy).toMatch(/## Supported Versions/i)
    expect(securityPolicy).toContain('v1.')
  })

  it('links the accepted trade-offs in docs/spec.md §9.5', () => {
    expect(securityPolicy).toContain('docs/spec.md §9.5')
    expect(securityPolicy).toContain('](docs/spec.md)')
  })
})

/**
 * Behavioral guard for the inline frame-bust bootstrap (issues #27 and #104
 * phase 3) — the anti-clickjacking half of the strict CSP story.
 *
 * tests/buildOutput.test.ts pins the built copy's presence and its sha256
 * allow-list in the CSP meta, but those are static checks: they cannot prove
 * the bust actually refuses a framed document. These tests execute the exact
 * source text of the bootstrap — extracted from index.html?raw, the same
 * bytes Vite ships — against a scripted window and the real jsdom document.
 *
 * Why a scripted window instead of the real jsdom one: `window.top` is an
 * unforgeable own property of jsdom's Window, so a framed window cannot be
 * simulated on the global. The bootstrap's only free variables are
 * window/document/localStorage, and `new Function` binds those as
 * parameters — the fake window decides framing, the real document records
 * what the warning built.
 *
 * Installed-PWA contexts (issue #104, phase 3): a standalone window is a
 * top-level browsing context like any tab, but a standalone page can be
 * embedded in a frame all the same. The bootstrap has no display-mode
 * escape hatch — it consults window identity alone and busts ALL framing —
 * pinned below both behaviorally and by the absence of any display-mode or
 * standalone token in its source.
 */

/** The inline (no src) script of index.html — the frame-bust + anti-flash bootstrap. */
const BOOTSTRAP = indexHtml.match(/<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''

/** A scripted window: `framed` decides the top/self identity the bootstrap checks. */
function makeWindow(options: { framed: boolean; darkQuery?: boolean }) {
  const win = {
    // Assigned right below — the bootstrap only compares their identity.
    top: {} as object,
    self: {} as object,
    stop: vi.fn(),
    matchMedia: vi.fn((query: string) => ({
      matches: options.darkQuery === true,
      media: query,
    })),
  }
  win.self = win
  win.top = options.framed ? ({} as object) : win
  return win
}

/** Runs the real bootstrap source text against the scripted window. */
function runBootstrap(win: ReturnType<typeof makeWindow>): void {
  new Function('window', 'document', 'localStorage', BOOTSTRAP)(win, document, window.localStorage)
}

describe('frame-bust bootstrap (issues #27, #104 phase 3)', () => {
  beforeEach(() => {
    expect(BOOTSTRAP, 'the extraction must have grabbed the real script').toContain(
      'window.top !== window.self',
    )
    localStorage.clear()
  })

  afterEach(() => {
    // The framed case destroys the document (head included) and the theme
    // cases toggle the root class: reset both so order never matters.
    document.documentElement.className = ''
    document.documentElement.innerHTML = '<head></head><body></body>'
  })

  it('busts framing regardless of any installed-PWA standalone context', () => {
    // The installed-PWA case (issue #104, phase 3): a standalone window
    // that got itself framed. darkQuery claims EVERY media query —
    // `display-mode: standalone` included — and framing still wins: the
    // bootstrap checks window identity, never display mode.
    const win = makeWindow({ framed: true, darkQuery: true })
    runBootstrap(win)

    expect(
      win.stop,
      'window.stop() must halt the parser before the bundle boots',
    ).toHaveBeenCalledTimes(1)
    // The document was replaced: the app head (CSP meta, hashed bootstrap,
    // entry bundle tag) is gone and the Spanish deny warning is all that
    // remains — the module bundle below never executes.
    expect(document.head).toBeNull()
    expect(document.querySelector('h1')?.textContent).toBe('gritos no puede ejecutarse en un marco')
    expect(document.querySelector('p')?.textContent).toContain(
      'no puede ejecutarse dentro de un marco o iframe',
    )
    // The anti-flash half never ran: the framed path returns before it.
    expect(win.matchMedia).not.toHaveBeenCalled()
  })

  it('has no display-mode escape hatch: it busts all framing', () => {
    // Static half of the PWA pin: no display-mode/standalone branch exists
    // that a future edit could use to weaken the bust for "installed"
    // contexts — the only framing check is the window-identity one.
    expect(BOOTSTRAP).not.toMatch(/display-mode|standalone/i)
    expect(BOOTSTRAP).toMatch(/window\.top !== window\.self/)
  })

  it('boots a top-level window — installed PWA or plain tab alike — with the stored theme', () => {
    localStorage.setItem('gritos:settings', JSON.stringify({ theme: 'dark' }))
    const win = makeWindow({ framed: false, darkQuery: false })
    expect(() => runBootstrap(win)).not.toThrow()

    expect(win.stop).not.toHaveBeenCalled()
    // The stored dark theme is applied before the bundle loads (anti-flash)
    // and the document is untouched — no deny warning replaced it.
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.head).not.toBeNull()
    expect(document.querySelector('h1')).toBeNull()
  })

  it('follows the OS scheme when no theme is stored', () => {
    const win = makeWindow({ framed: false, darkQuery: true })
    runBootstrap(win)

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(win.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
  })

  it('seeds light when the OS scheme is light and nothing is stored', () => {
    const win = makeWindow({ framed: false, darkQuery: false })
    runBootstrap(win)

    expect(win.stop).not.toHaveBeenCalled()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('falls back to light on unreadable stored settings', () => {
    localStorage.setItem('gritos:settings', '{bogus json')
    const win = makeWindow({ framed: false, darkQuery: true })
    expect(() => runBootstrap(win)).not.toThrow()

    expect(win.stop).not.toHaveBeenCalled()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
