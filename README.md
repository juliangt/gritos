# gritos

Serverless P2P chat that runs entirely in the browser: **no backend, no accounts, ephemeral by design**. Messages travel directly between browsers over WebRTC data channels — peers find each other through public BitTorrent trackers ([Trystero](https://github.com/tinychat/trystero), torrent strategy) — and disappear on reload. End-to-end encryption layers cover 1:1 direct messages (ECDH + AES-GCM) and password-protected rooms (PBKDF2 + AES-GCM).

> The UI language is **Spanish by design** (product decision, not an oversight — i18n is out of scope for v1).

## Prerequisites

- Node.js ≥ 22 and npm ≥ 11
- A modern evergreen browser. Web Crypto, WebRTC and notifications require a secure context (`https://` or `localhost`).

## Quickstart

```bash
npm install
npm run dev      # start the dev server
```

```bash
npm run build    # type-check and emit the static bundle to dist/
npm run preview  # serve the production build locally
```

## Scripts

| Script            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Vite dev server with hot reload                           |
| `npm run build`   | `tsc -b` (strict type-check) + `vite build` → `dist/`     |
| `npm run preview` | Serves the production build from `dist/`                  |
| `npm test`        | Runs the Vitest suite (`vitest run`)                      |
| `npm run lint`    | ESLint (flat config, typescript-eslint + react plugins)   |
| `npm run format`  | Prettier over the repository                              |

## Architecture

Gritos is a 100 % client-side static bundle: React + TypeScript for the UI, Zustand for in-memory state, Tailwind CSS 4 for styling, and Trystero for decentralized WebRTC signaling. Trackers only broker the initial peer discovery and SDP exchange; application traffic never touches them. All cryptography uses the native Web Crypto API (no hand-rolled primitives, no crypto dependencies), and the only persisted data are settings and the local keypair under the `gritos:*` keys in `localStorage` — messages, presence and room passwords are memory-only.

```
src/
├── components/     onboarding · sidebar · chat · dm · settings · common
├── lib/
│   ├── p2p/        roomManager (sole Trystero surface), protocol (Envelope §7)
│   ├── crypto/     identity, dm (E2EE), roomKey (PBKDF2), hashes (roomId)
│   ├── markdown/   safe Markdown-subset renderer (no raw HTML)
│   └── nickname.ts es-ES 'adjetivo-sustantivo' generator
├── stores/         useAppStore (AppState §8.1), useSettingsStore (persistence §8.2)
├── hooks/          useRoom · useLatency · useTheme · useNotifications
├── styles/         Tailwind 4 entry + theme tokens (light/dark/system)
└── tests/          Vitest suites (node env; jsdom per file when DOM is needed)
```

Architecture rules: Trystero may only be imported from `lib/p2p/roomManager.ts`; components touch neither Web Crypto nor WebSockets directly (stores and hooks only); everything cryptographic lives in `lib/crypto/` and is testable without a network.

## Documentation

- [Functional and technical specification](docs/spec.md) — requirements, protocol, crypto design, state model, UX.
- [Development plan](docs/plan.md) — milestones M0–M6, QA strategy, risks.

## Status

Milestone **M0 — setup and foundations**: toolchain, base state types, typed module stubs, theme foundation with anti-flash, smoke tests and CI. The app renders an empty themed shell; onboarding and chat UI arrive in M2.
