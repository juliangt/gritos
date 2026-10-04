// jsdom does not implement window.matchMedia; provide a minimal stub so the
// theme hook can subscribe to prefers-color-scheme in DOM tests.
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
