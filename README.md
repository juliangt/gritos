# gritos

**Serverless P2P chat that runs entirely in your browser: no server, no accounts, ephemeral by design.** Messages travel directly between browsers over WebRTC data channels — peers find each other through public BitTorrent trackers — and disappear when the tab closes.

> The UI language is **Spanish by design** (a product decision; i18n is out of scope for v1). This README is in English.

**What it looks like:** a compact two-pane chat — a collapsible sidebar with your active rooms, suggested rooms, recent rooms, direct messages and the peers of the current room (nickname + latency dot); the main pane shows the room header with live connection status ("Buscando pares en la red torrent…" → "Canal P2P establecido · N pares"), a flat message feed with per-author stable colors and Markdown rendering, typing indicators, ✓/✓✓ receipts, and an auto-growing composer. Light/dark/system theme, keyboard-first, mobile drawer layout.

## Features

- **Public rooms** — join by name (`#lobby`, `#general`…), multiple simultaneous rooms (cap 1–6), per-room unread badges, leave/rejoin without losing other connections.
- **Password-protected rooms** — the room name only hashes to the same discovery id for people with the same password; room chat is AES-GCM encrypted on top of the transport, and the password never persists.
- **End-to-end encrypted direct messages** — session-ephemeral ECDH P-256 key agreement + AES-256-GCM per peer, with session-scoped forward secrecy: the ephemeral key never persists, so recorded DM history becomes undecryptable when the tab closes (issue #93). The 128-bit identity fingerprint (8 groups of 4 hex chars, issue #23) is unchanged and both sides can compare it out-of-band (TOFU verification).
- **Markdown subset** — bold, italic, inline code, links (http/https only), rendered by a home-grown safe renderer; raw HTML, script injection and `javascript:` URLs are escaped. Mentions highlight and can raise desktop notifications.
- **Presence & latency** — live peer list with 🟢/🟡/🔴/⚪ RTT dots, typing indicators, join/leave system lines, ✓/✓✓ receipts.
- **Privacy controls** — mute by identity fingerprint (a local-only list inside `gritos:settings`: no server, no reports; it hides the peer's room messages, DMs, typing indicators and join/leave lines while receipts and latency pings keep flowing, follows the fingerprint across nickname changes, and is wiped by the panic button), panic button (wipe everything and reload, including the IndexedDB key vault), identity regeneration, recent-rooms toggle, notification toggle; only five `gritos:*` keys ever touch `localStorage` (plus the small IndexedDB vault that wraps the private key), and messages/typing/passwords are never persisted.
- **Connection transparency** — exact status text for searching / connecting / connected / tracker-error states, plus a non-blocking banner with a shortcut to network settings when trackers are unreachable.

## How it works

- **Discovery:** [Trystero](https://github.com/tinychat/trystero) (torrent strategy, pinned exact version) uses public WebTorrent trackers over WebSocket (`wss:`) only to introduce peers and exchange SDP. Application traffic never touches a tracker — it flows over direct WebRTC data channels (DTLS-encrypted by the browser).
- **Security model:** room chat rides on WebRTC's DTLS transport; password rooms and DMs add payload encryption with the native Web Crypto API (PBKDF2-SHA-256 600k iterations for room keys; for DMs, session-ephemeral ECDH P-256 with a dual-salt HKDF binding the identity and session fingerprints — info `gritos/dm/v2` — and AES-256-GCM over `v: 2` DM envelopes, issue #93: the ephemeral private key exists only for the app session, so captured DM traffic stops being decryptable once it ends). Peers on older builds show an explicit unavailable state in the DM composer instead of silently losing messages; mixed-version DM envelopes are dropped until builds converge. The private key is **encrypted at rest** (issue #24): it is AES-GCM-wrapped with a non-extractable key held in IndexedDB, so `gritos:identity` never contains plaintext key material — where IndexedDB is unavailable the app degrades to the old plaintext-at-rest behavior rather than breaking. Room passwords and all message content stay memory-only. The bundle ships a strict CSP (`script-src 'self'` + a hash for the inline frame-bust/theme bootstrap snippet); embedding the app in a frame is refused in-page by that bootstrap script, since a `<meta>` CSP cannot deliver `frame-ancestors` (issue #27). There is no server, so there is no server-side trust to audit. Being direct P2P also means room peers can see your IP address (inherent to WebRTC; disclosed in the onboarding and the Privacidad tab). Residual risk, stated plainly: a fully compromised same-origin context (malicious extension with host permissions, malware on the device) can still reach both stores and abuse the key — the wrapping only raises the bar against naive `localStorage` dumps. Finally, the v1 control plane is unauthenticated by design (issue #36, accepted in the spec threat model, §9.5): any peer can forge delivery receipts (✓✓), typing indicators, join/leave system lines and latency pongs, or flood chat to spam unread badges and mention notifications — inherent to a trustless mesh; v1 ships only cosmetic caps (per-peer system-line rate limit, implausible-RTT discard/clamp) plus a user-facing local mute by fingerprint (issue #95: hides an abusive peer's room chat, DMs, typing and system lines; local-only, wiped by the panic button; a peer can still evade it by rotating their identity key, which the TOFU pin surfaces).
- **Supply chain:** dependency versions are exact-pinned and `npm audit --audit-level=high` gates CI against the lockfile, with a scheduled weekly re-run (`.github/workflows/audit.yml`) and Dependabot opening weekly update PRs for npm and GitHub Actions. Because pins are exact, every upstream release of the transport library `@trystero-p2p/torrent` surfaces as its own reviewable Dependabot PR — that is the release tracking.
- **Limits of the model:** see [Limitations](#limitations).

## Quickstart

```bash
npm install
npm run dev      # start the dev server
```

Open two browser tabs, pick a nickname, and you are two peers.

Copy the environment template first (`cp .env.example .env`) — the app refuses to join rooms without `VITE_TRYSTERO_APP_ID` (see [Configuration](#configuration)).

```bash
npm run build    # type-check and emit the static bundle to dist/
npm run preview  # serve the production build locally
```

Requires Node.js ≥ 22 and npm ≥ 11. Browsers must support Web Crypto, WebRTC and (optionally) notifications — i.e. any evergreen browser over **HTTPS or localhost** (secure context).

## Scripts

| Script            | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `npm run dev`     | Vite dev server with hot reload (CSP meta stripped — see note below) |
| `npm run build`   | `tsc -b` (strict type-check) + `vite build` → `dist/`                |
| `npm run preview` | Serves the production build from `dist/`                             |
| `npm test`        | Runs the Vitest suite (`vitest run`)                                 |
| `npm run lint`    | ESLint (flat config, typescript-eslint + react plugins)              |
| `npm run format`  | Prettier over the repository                                         |

> The strict CSP `<meta>` in `index.html` targets the **production** build. Vite's dev server injects its own inline HMR preamble that a hash-pinned `script-src` cannot allow, so a tiny dev-only Vite plugin (`stripCspMetaInDev` in `vite.config.ts`) removes the meta while serving in dev. `vite build` output keeps it untouched.

## Configuration

| Variable               | Default in `.env.example`                         | What it does                                                              |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `VITE_TRYSTERO_APP_ID` | `bebf21e4-20ea-4626-9e88-f450626b6b8e/gritos-dev` | Trystero **appId** — the peer-discovery namespace (issue #90, spec §9.4). |

The appId is the namespace Trystero uses to introduce peers: **only builds sharing the same appId can discover each other.** Copies of the app built with different appIds are fully isolated swarms. Set it in a `.env` file (`.env*` is git-ignored; `.env.example` is the committed template) or in your host's build environment:

```bash
cp .env.example .env   # then edit .env
npm run build
```

Two things to know:

- **Build-time only.** Vite statically inlines `import.meta.env.*` during `vite build`, so the value is baked into the bundle and changing it requires a rebuild. It is not runtime configuration, and nothing environment-specific is fetched over HTTP at runtime.
- **A build without the variable refuses to join.** Rather than silently falling back to a shared default (which would quietly fork the swarm with no visible signal), any join attempt fails immediately with a clear error naming the variable (`src/lib/p2p/appId.ts`).

The value shipped in `.env.example` is the development namespace used by the project's own dev builds.

## Architecture

Gritos is a 100 % client-side static bundle: React 19 + TypeScript (strict) for the UI, Zustand for in-memory state, Tailwind CSS 4 for styling, and Trystero for decentralized WebRTC signaling. All cryptography uses the native Web Crypto API (no hand-rolled primitives, no crypto dependencies), and the only persisted data are settings, the local keypair (private key encrypted at rest), recent room names (password-room names are never stored, issue #31) and UI state under the five `gritos:*` keys in `localStorage` plus a small IndexedDB vault holding the wrapping key.

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
- **Frame-busting is built in (issue #27):** the inline bootstrap script in `index.html` detects when the page runs inside a frame and refuses to boot — it replaces the document with a warning ("Esta app no puede ejecutarse dentro de un marco o iframe…") instead of starting the app. This in-page fallback is what keeps header-less hosts such as GitHub Pages usable, because browsers ignore `frame-ancestors` in a `<meta>` CSP (the only CSP delivery GitHub Pages supports).
- **Recommended host headers** (self-hosters can do better than the in-page fallback — defense in depth):
  - `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) — forbids embedding at the HTTP layer.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
- Single-page app with no routes: no rewrite rules are needed beyond serving `index.html` at `/`.

## Public trackers notice

Peer discovery relies on **public WebTorrent trackers** operated by third parties. Your browser contacts these trackers to find peers and exchange the initial connection handshake (SDP) for rooms you join; the **room name is hashed** before it is used for discovery, so the tracker sees an opaque id — but trackers can observe your IP address, the timing of joins, and those opaque room ids. If all public trackers are unreachable, existing connections keep working but no new peers can be discovered (the app surfaces this state and lets you configure alternative trackers and your own STUN/TURN servers in Ajustes → Red). If this threat model does not suit you, run your own tracker and set it in the network settings.

**The effective default list** (issue #51): with the default settings (`trackers: []`) the app passes no tracker list to Trystero, so the trackers baked into the pinned library release are the ones actually in effect. For `@trystero-p2p/torrent@0.25.4` that is exactly these five:

- `wss://open.ftorrent.com`
- `wss://tracker.webtorrent.dev`
- `wss://tracker.openwebtorrent.com`
- `wss://tracker.btorrent.xyz`
- `wss://tracker.files.fm:7073/announce`

We deliberately **do not ship a curated replacement list**: the dependency is exact-pinned, so this list is deterministic per release and cannot drift underneath you; anything we curated would be the same class of third-party community trackers — duplicated upstream maintenance, just as free to silently rot; and upstream's defaults are the set the library is tested against. Every library bump surfaces as its own reviewable Dependabot PR, which is the natural checkpoint to re-verify the list above (re-derive it from `defaultRelayUrls` in `node_modules/@trystero-p2p/torrent/dist/index.mjs`). If these trackers decay, the tracker-error banner and the [tracker runbook](docs/runbook-trackers.md) cover the recovery path: add your own `wss://` trackers in Ajustes → Red (an empty list restores these defaults).

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
- [Tracker runbook](docs/runbook-trackers.md) — one-page user guide for the "Sin acceso a trackers" state.

## Status

**v1.0.0** — feature-complete (milestones M0–M6): P2P multi-room core, onboarding and chat UI, E2EE DMs, password rooms, settings/notifications/privacy, polish and release QA.

## License

Gritos is released under the [MIT License](LICENSE).
