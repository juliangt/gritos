# gritos

**Serverless P2P chat that runs entirely in your browser: no server, no accounts, ephemeral by design.** Messages travel directly between browsers over WebRTC data channels — peers find each other through public BitTorrent trackers — and disappear when the tab closes.

> The UI language is **Spanish by design** (a product decision; i18n is out of scope for v1). This README is in English.

**What it looks like:** a compact two-pane chat — a collapsible sidebar with your active rooms, suggested rooms, recent rooms, direct messages and the peers of the current room (nickname + latency dot); the main pane shows the room header with live connection status ("Buscando pares en la red torrent…" → "Canal P2P establecido · N pares"), a flat message feed with per-author stable colors and Markdown rendering, typing indicators, ✓/✓✓ receipts, and an auto-growing composer. Light/dark/system theme, keyboard-first, mobile drawer layout.

## Features

- **Public rooms** — join by name (`#lobby`, `#general`…), multiple simultaneous rooms (cap 1–6), per-room unread badges, leave/rejoin without losing other connections.
- **Password-protected rooms** — the room name only hashes to the same discovery id for people with the same password; room chat is AES-GCM encrypted on top of the transport, and the password never persists.
- **End-to-end encrypted direct messages** — ECDH P-256 key agreement + AES-256-GCM per peer, with a 4×4 fingerprint both sides can compare out-of-band (TOFU verification).
- **Markdown subset** — bold, italic, inline code, links (http/https only), rendered by a home-grown safe renderer; raw HTML, script injection and `javascript:` URLs are escaped. Mentions highlight and can raise desktop notifications.
- **Presence & latency** — live peer list with 🟢/🟡/🔴/⚪ RTT dots, typing indicators, join/leave system lines, ✓/✓✓ receipts.
- **Privacy controls** — panic button (wipe everything and reload), identity regeneration, recent-rooms toggle, notification toggle; only four `gritos:*` keys ever touch `localStorage`, and messages/typing/passwords are never persisted.
- **Connection transparency** — exact status text for searching / connecting / connected / tracker-error states, plus a non-blocking banner with a shortcut to network settings when trackers are unreachable.

## How it works

- **Discovery:** [Trystero](https://github.com/tinychat/trystero) (torrent strategy, pinned exact version) uses public WebTorrent trackers over WebSocket (`wss:`) only to introduce peers and exchange SDP. Application traffic never touches a tracker — it flows over direct WebRTC data channels (DTLS-encrypted by the browser).
- **Security model:** room chat rides on WebRTC's DTLS transport; password rooms and DMs add payload encryption with the native Web Crypto API (PBKDF2-SHA-256 600k iterations for room keys; ECDH + HKDF + AES-GCM for DMs). The local keypair persists as JWK under `gritos:identity`; room passwords and all message content stay memory-only. The bundle ships a strict CSP (`script-src 'self'` + a hash for the theme bootstrap snippet); there is no server, so there is no server-side trust to audit.
- **Limits of the model:** see [Limitations](#limitations).

## Quickstart

```bash
npm install
npm run dev      # start the dev server
```

Open two browser tabs, pick a nickname, and you are two peers.

```bash
npm run build    # type-check and emit the static bundle to dist/
npm run preview  # serve the production build locally
```

Requires Node.js ≥ 22 and npm ≥ 11. Browsers must support Web Crypto, WebRTC and (optionally) notifications — i.e. any evergreen browser over **HTTPS or localhost** (secure context).

## Scripts

| Script            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Vite dev server with hot reload (CSP meta stripped — see note below) |
| `npm run build`   | `tsc -b` (strict type-check) + `vite build` → `dist/`     |
| `npm run preview` | Serves the production build from `dist/`                  |
| `npm test`        | Runs the Vitest suite (`vitest run`)                      |
| `npm run lint`    | ESLint (flat config, typescript-eslint + react plugins)   |
| `npm run format`  | Prettier over the repository                                              |

> The strict CSP `<meta>` in `index.html` targets the **production** build. Vite's dev server injects its own inline HMR preamble that a hash-pinned `script-src` cannot allow, so a tiny dev-only Vite plugin (`stripCspMetaInDev` in `vite.config.ts`) removes the meta while serving in dev. `vite build` output keeps it untouched.

## Architecture

Gritos is a 100 % client-side static bundle: React 19 + TypeScript (strict) for the UI, Zustand for in-memory state, Tailwind CSS 4 for styling, and Trystero for decentralized WebRTC signaling. All cryptography uses the native Web Crypto API (no hand-rolled primitives, no crypto dependencies), and the only persisted data are settings, the local keypair, recent room names and UI state under the four `gritos:*` keys in `localStorage`.

```
src/
├── components/     onboarding · sidebar · chat · dm · settings · common · debug (?debug only)
├── lib/
│   ├── p2p/        roomManager (sole Trystero surface), protocol (Envelope §7)
│   ├── crypto/     identity, dm (E2EE), roomKey (PBKDF2), hashes (roomId)
│   ├── markdown/   safe Markdown-subset renderer (no raw HTML)
│   └── nickname.ts es-ES 'adjetivo-sustantivo' generator
├── stores/         useAppStore (AppState §8.1), useSettingsStore, useUiStore
├── hooks/          useRoom · useLatency · useTheme · useNotifications · …
├── styles/         Tailwind 4 entry + AA-audited theme tokens (light/dark)
└── tests/          Vitest suites (node env; jsdom per file when DOM is needed)
```

Architecture rules: Trystero may only be imported from `lib/p2p/roomManager.ts`; components touch neither Web Crypto nor WebSockets directly (stores and hooks only); everything cryptographic lives in `lib/crypto/` and is testable without a network.

## Deployment (static hosting)

The build output is a plain static site: serve `dist/` over **HTTPS** from any file host. Web Crypto and WebRTC require a secure context, so plain HTTP (other than `localhost`) will not work.

The build uses a **relative base** (`base: './'` in `vite.config.ts`): all asset URLs in `dist/index.html` are relative, so the same build works at the root of a domain, on a GitHub Pages project site (`https://<user>.github.io/<repo>/`), under a Netlify subpath, or in any nginx `location` — no per-host reconfiguration needed.

**GitHub Pages**

```bash
npm run build
# publish dist/ (e.g. via Actions with actions/upload-pages-artifact +
# actions/deploy-pages, or push dist/ to a gh-pages branch)
```

**Netlify**

```bash
npm run build
# Build command: npm run build — Publish directory: dist
```

**nginx (or any web server)**

```bash
npm run build
# serve the dist/ directory over TLS, e.g.:
#   root /srv/gritos/dist;
#   index index.html;
```

Notes:

- **HTTPS is mandatory** for Web Crypto/WebRTC on non-localhost origins.
- **Frame-busting:** browsers ignore `frame-ancestors` in a `<meta>` CSP, so serve a `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) **HTTP header** at the host to forbid embedding.
- Single-page app with no routes: no rewrite rules are needed beyond serving `index.html` at `/`.

## Public trackers notice

Peer discovery relies on **public WebTorrent trackers** operated by third parties. Your browser contacts these trackers to find peers and exchange the initial connection handshake (SDP) for rooms you join; the **room name is hashed** before it is used for discovery, so the tracker sees an opaque id — but trackers can observe your IP address, the timing of joins, and those opaque room ids. If all public trackers are unreachable, existing connections keep working but no new peers can be discovered (the app surfaces this state and lets you configure alternative trackers and your own STUN/TURN servers in Ajustes → Red). If this threat model does not suit you, run your own tracker and set it in the network settings.

## Limitations (spec §11, summarized)

1. **Full mesh:** optimal up to ~15 peers per room; beyond ~20 the mesh degrades (active rooms multiply the effect). Room (≤6) and message (500/room, FIFO) caps bound memory/CPU.
2. **Public trackers:** if they all go down, no new peers can be discovered (already-connected peers keep chatting). Alternative trackers are user-configurable.
3. **Symmetric NAT / corporate firewalls:** direct P2P may fail without a TURN server; you can configure your own STUN/TURN, but no TURN is provided.
4. **Background tabs:** deep-backgrounded tabs get throttled timers (latency dots degrade); they recover on focus.
5. **No server:** no history for late joiners, no offline delivery, no real push (notifications only fire while a tab is open, even hidden).
6. **Multiple tabs of the same browser:** each tab is a distinct peer; you will see your own nickname duplicated with a suffix.
7. **DMs need a shared room:** there is no global signaling channel for arbitrary DMs.
8. **No global message ordering, nicknames are not unique:** accepted trade-offs for v1.

## Documentation

- [Functional and technical specification](docs/spec.md) — requirements, protocol, crypto design, state model, UX.
- [Development plan](docs/plan.md) — milestones M0–M6, QA strategy, risks.
- [Manual QA checklist](docs/qa-checklist.md) — cumulative per-milestone checklist and the M6 full pass.

## Status

**v1.0.0** — feature-complete (milestones M0–M6): P2P multi-room core, onboarding and chat UI, E2EE DMs, password rooms, settings/notifications/privacy, polish and release QA.

## License

Gritos is released under the [MIT License](LICENSE).
