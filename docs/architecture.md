# Architecture

How gritos is built: the discovery path, the stack and the module layout. The security model lives in [security.md](security.md); the deployment guide in [deployment.md](deployment.md).

## Discovery

[Trystero](https://github.com/tinychat/trystero) (torrent strategy, pinned exact version) uses public WebTorrent trackers over WebSocket (`wss:`) only to introduce peers and exchange SDP. Application traffic never touches a tracker — it flows over direct WebRTC data channels (DTLS-encrypted by the browser).

## Stack

Gritos is a 100 % client-side static bundle: React 19 + TypeScript (strict) for the UI, Zustand for in-memory state, Tailwind CSS 4 for styling, and Trystero for decentralized WebRTC signaling. All cryptography uses the native Web Crypto API (no hand-rolled primitives, no crypto dependencies), and the only persisted data are settings, the local keypair (private key encrypted at rest), recent room names (password-room names are never stored, issue #31) and UI state under the five `gritos:*` keys in `localStorage` plus a small IndexedDB vault holding the wrapping key.

## Source layout

```
src/
├── components/     onboarding · sidebar · chat · dm · settings · common · debug (?debug only)
├── lib/
│   ├── p2p/        roomManager (sole Trystero surface), protocol (Envelope §7)
│   ├── crypto/     identity, keyVault (at-rest wrapping), dm (E2EE), roomKey (PBKDF2), hashes (roomId)
│   ├── markdown/   safe Markdown-subset renderer (no raw HTML)
│   └── nickname.ts es-ES 'adjetivo-sustantivo' generator
├── stores/         useAppStore (AppState §8.1), useSettingsStore, useUiStore
├── hooks/          useRoom · useLatency · useTheme · useNotifications · …
├── styles/         Tailwind 4 entry + AA-audited theme tokens (light/dark)
└── tests/          Vitest suites (node env; jsdom per file when DOM is needed)
```

## Rules

- Trystero may only be imported from `src/lib/p2p/roomManager.ts`.
- Components touch neither Web Crypto nor WebSockets directly (stores and hooks only).
- Everything cryptographic lives in `src/lib/crypto/` and is testable without a network.
