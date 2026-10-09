// jsdom does not implement window.matchMedia; provide a minimal stub so the
// theme hook can subscribe to prefers-color-scheme in DOM tests.
import { configure } from '@testing-library/react'
// Issue #119 — pin the resolved locale to English for every DOM suite: the
// i18n runtime resolves its boot locale from the persisted `language`
// setting at module load, and a suite that seeds `gritos:settings` (or a
// future es* navigator stub) must never shift the exact-text assertions.
// The i18n suite itself switches locales deliberately — per-file module
// isolation keeps that safe, and its afterEach restores 'auto'.
import { setLocale } from '../src/i18n/index'

setLocale('en')

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom (30.x) does not implement window.isSecureContext either; default to
// the browser-realistic `true` (every jsdom test URL counts as secure) so
// the insecure-context banner stays out of unrelated suites. Configurable
// on purpose: tests pin it to `false` via Object.defineProperty (issue #43).
if (typeof window !== 'undefined' && typeof window.isSecureContext === 'undefined') {
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  })
}

// Testing Library's waitFor default (1 s) is too tight for a full parallel
// suite: the crypto-heavy files (identity, DM, manual peers — issue #97)
// starve the Web Crypto threadpool across workers and real-time waits
// stretch, so timing-sensitive assertions flaked under load (e.g. the
// shareDeepLinks onboarding landing). 4 s only matters on the failure path.
if (typeof window !== 'undefined') {
  configure({ asyncUtilTimeout: 4_000 })
}
