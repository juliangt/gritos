<div align="center">

# 📣 gritos

### Serverless P2P chat that runs entirely in your browser

**No server. No accounts. No trace.**
Messages travel browser-to-browser over WebRTC data channels — peers find each
other through public BitTorrent trackers — and disappear when the tab closes.

[![Stable release](https://img.shields.io/github/v/tag/juliangt/gritos?label=stable&sort=semver)](https://github.com/juliangt/gritos/releases)
[![License: MIT](https://img.shields.io/github/license/juliangt/gritos)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Zustand](https://img.shields.io/badge/Zustand-5-fa8072)](https://github.com/pmndrs/zustand)
[![WebRTC P2P](https://img.shields.io/badge/P2P-Trystero_·_WebRTC-F55D5D)](https://github.com/tinychat/trystero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5_22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-21c05d)](https://github.com/juliangt/gritos/issues)

[Quickstart](#quickstart) · [Features](#features) · [How it works](#how-it-works) · [Deploy](#deployment) · [Docs](#documentation)

</div>

## Why gritos?

Every mainstream chat needs a server that sees everything: accounts, history, metadata. **Gritos needs none of it** — the static bundle is the whole app, and the peers _are_ the network.

- 🛰️ **Zero infrastructure** — host a static bundle anywhere; discovery rides public trackers, conversation flows browser-to-browser.
- 🔒 **Encrypted where it matters** — DTLS transport, plus Web Crypto payload encryption for password rooms and direct messages, with session-ephemeral DM keys.
- 💨 **Ephemeral by design** — messages exist only in RAM. Nothing to leak, sell or subpoena.
- 🕵️ **No accounts** — identity is a locally generated keypair plus a nickname; your 128-bit fingerprint is your name.
- 📲 **Installable** — a PWA that launches in its own window, boots its shell offline, and reports its connection status honestly.

## Features

A keyboard-first, two-pane chat: multiple rooms with live presence, Markdown, typing indicators, ✓/✓✓ receipts, light/dark themes, mobile drawer layout.

**Rooms**

- **Public rooms** — join by name (`#lobby`, `#general`…), up to 6 simultaneous, unread badges, leave/rejoin without dropping other connections.
- **Password-protected rooms** — the name only hashes to the same discovery id for peers sharing the password; chat is AES-GCM encrypted on top of the transport, and the password never persists.
- **QR invites** — scan-to-join links that encode exactly the share link and never the password.
- **Markdown & mentions** — a safe subset (bold, italic, code, http/https links); raw HTML is escaped. Mentions can raise desktop notifications.
- **Presence** — live peer list with 🟢/🟡/🔴/⚪ latency dots, typing indicators, join/leave lines, ✓/✓✓ receipts.

**Direct messages**

- **E2EE DMs** — session-ephemeral ECDH P-256 + AES-256-GCM per peer; both sides can compare fingerprints out-of-band (TOFU).
- **Trackerless DMs** — no tracker reachable? Exchange two copy/paste invite blobs and still get the same E2EE 1:1 channel, with zero infrastructure.
- **Global DMs (opt-in, off by default)** — knock a peer by fingerprint over a dedicated signaling swarm; consent cards, muting, and no contact store.

**Ephemeral & consent**

- **Self-destructing messages** — per-message TTLs of 30 s / 5 min / 1 h, enforced in memory by every peer.
- **Opt-in history gossip** — a late joiner may ask the room for its last 50 messages; peers answer only if they opted in; nothing is persisted.
- **P2P file & image transfer** — up to 20 MB per file, consent-first (no auto-download ever), E2EE whenever the conversation is, inline images.

**Input & polish**

- **Slash commands** — `/nick` `/room` `/dm` `/me` `/rooms` `/clear` `/leave` `/help`, with inline autocomplete; unknown verbs are never sent.
- **Emoji reactions** — seven whitelisted reactions aggregated under the bubble; cosmetic, never persisted.
- **Privacy controls** — mute by fingerprint, panic wipe, identity regeneration; only five `gritos:*` keys ever touch `localStorage`.
- **Installable PWA** — offline app shell, exact connection states, explicit "new version available" toast.

Every guarantee, cap and edge case is spelled out in the **[feature reference](docs/features.md)**.

## How it works

1. **Discover** — [Trystero](https://github.com/tinychat/trystero) (torrent strategy, exact-pinned) introduces peers through public WebTorrent trackers over `wss:`. Only the handshake touches a tracker — the room name is hashed to an opaque id first.
2. **Connect** — application traffic flows over direct WebRTC data channels, DTLS-encrypted by the browser. Each room is a full mesh, comfortable up to ~15 peers.
3. **Encrypt** — password rooms derive keys with PBKDF2-SHA-256 (600k iterations); DMs use session-ephemeral ECDH P-256 + AES-256-GCM, so recorded DM history becomes undecryptable when the session ends.
4. **Persist (almost) nothing** — room passwords and all message content stay memory-only. The whole on-disk footprint is five `gritos:*` settings keys in `localStorage` plus an IndexedDB vault wrapping the private key, encrypted at rest.

Deep dives: [architecture](docs/architecture.md) · [security model](docs/security.md) · [public trackers notice](docs/security.md#public-trackers-notice) · [limitations](docs/limitations.md)

## Quickstart

```bash
npm install
cp .env.example .env   # required: VITE_TRYSTERO_APP_ID — see Configuration
npm run dev            # start the dev server
```

Open two browser tabs, pick a nickname, and you are two peers.

```bash
npm run build    # type-check and emit the static bundle to dist/
npm run preview  # serve the production build locally
npm test         # run the Vitest suite
```

Requires Node.js ≥ 22.13 and npm ≥ 11. Browsers must support Web Crypto, WebRTC and (optionally) notifications — i.e. any evergreen browser over **HTTPS or localhost** (secure context).

| Script            | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `npm run dev`     | Vite dev server with hot reload (CSP meta stripped in dev) |
| `npm run build`   | `tsc -b` (strict type-check) + `vite build` → `dist/`      |
| `npm run preview` | Serves the production build from `dist/`                   |
| `npm test`        | Runs the Vitest suite (`vitest run`)                       |
| `npm run lint`    | ESLint (flat config, typescript-eslint + react plugins)    |
| `npm run format`  | Prettier over the repository                               |

## Configuration

| Variable               | Default in `.env.example`                         | What it does                                                              |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `VITE_TRYSTERO_APP_ID` | `bebf21e4-20ea-4626-9e88-f450626b6b8e/gritos-dev` | Trystero **appId** — the peer-discovery namespace (issue #90, spec §9.4). |

The appId is the namespace Trystero uses to introduce peers: **only builds sharing the same appId can discover each other** — different appIds are fully isolated swarms. Set it in `.env` (git-ignored; `.env.example` is the committed template) or in your host's build environment. It is build-time only: Vite inlines it during `vite build`, and a build without it refuses to join rooms with a clear error rather than silently forking the swarm.

## Deployment

The build is a plain static site: serve `dist/` over **HTTPS** from any host — GitHub Pages, Netlify, nginx, you name it. The relative base means the same build works at a domain root or a project subpath; a service worker ships an offline shell and the strict CSP ships inside `index.html`.

Host recipes, recommended security headers and the iOS caveat: **[docs/deployment.md](docs/deployment.md)**.

## Limitations

The model trades server conveniences for independence:

- Full mesh: comfortable to ~15 peers per room, degrading beyond ~20.
- Discovery needs public trackers (your own can be configured); symmetric NAT may need your own TURN server.
- No offline delivery, no push, no global message ordering; nicknames are not unique.

The full list, with the reasoning behind each trade-off: **[docs/limitations.md](docs/limitations.md)**.

## Documentation

- [Feature reference](docs/features.md) — every feature with its guarantees.
- [Architecture](docs/architecture.md) — discovery, stack and module layout.
- [Security model](docs/security.md) — encryption, threat-model notes, supply chain and the public trackers notice. Vulnerability reporting: [SECURITY.md](SECURITY.md).
- [Deployment](docs/deployment.md) — static hosting recipes.
- [Limitations](docs/limitations.md) — the accepted trade-offs.
- [Specification](docs/spec.md) · [Development plan](docs/plan.md) · [QA checklist](docs/qa-checklist.md) · [Tracker runbook](docs/runbook-trackers.md)

## License

Gritos is released under the [MIT License](LICENSE).
