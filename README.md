# gritos

**Serverless P2P chat that runs entirely in your browser: no server, no accounts, ephemeral by design.** Messages travel directly between browsers over WebRTC data channels — peers find each other through public BitTorrent trackers — and disappear when the tab closes.

> The UI language is **English** — hardcoded English-first per issue #112 (a deliberate clean break for v1; an i18n layer is explicitly deferred and may be revisited later). This README and the rest of the docs are in English to match.

**What it looks like:** a compact two-pane chat — a collapsible sidebar with your active rooms, suggested rooms, recent rooms, direct messages and the peers of the current room (nickname + latency dot); the main pane shows the room header with live connection status ("Searching for peers on the torrent network…" → "P2P channel established · N peers"), a flat message feed with per-author stable colors and Markdown rendering, typing indicators, ✓/✓✓ receipts, and an auto-growing composer. Light/dark/system theme, keyboard-first, mobile drawer layout.

## Features

- **Public rooms** — join by name (`#lobby`, `#general`…), multiple simultaneous rooms (cap 1–6), per-room unread badges, leave/rejoin without losing other connections.
- **Password-protected rooms** — the room name only hashes to the same discovery id for people with the same password; room chat is AES-GCM encrypted on top of the transport, and the password never persists.
- **End-to-end encrypted direct messages** — session-ephemeral ECDH P-256 key agreement + AES-256-GCM per peer, with session-scoped forward secrecy: the ephemeral key never persists, so recorded DM history becomes undecryptable when the tab closes (issue #93). The 128-bit identity fingerprint (8 groups of 4 hex chars, issue #23) is unchanged and both sides can compare it out-of-band (TOFU verification).
- **Trackerless DMs via manual invite (issue #97)** — when trackers are unreachable (or no shared room exists), two peers can still establish a direct DM with zero infrastructure: the invite wizard exchanges two copy/paste blobs — SDP plus public keys and fingerprint, nothing else — and the resulting 1:1 channel speaks the same E2EE DM protocol (session-ephemeral key agreement, TOFU fingerprint comparison surfaced before the first message, ✓/✓✓ receipts, typing). No tracker, no server, and nothing persisted beyond the fingerprint pin.
- **Global DMs by fingerprint knock (issue #105, opt-in)** — two peers with no shared room can open an E2EE DM through a dedicated, well-known signaling swarm: both sides first flip "Global DM channel" (Settings → Privacy, **off by default** — joining exposes your IP, fingerprint and nickname to every opted-in peer, so it is a visible privacy decision, and turning it off leaves the swarm at once, disconnecting its channels). "My contact" shares your fingerprint (copyable, plus a QR `#contact=` deep link), "Contact by fingerprint" knocks the other peer by fingerprint, and the arrival is a non-blocking consent card: Accept opens the channel on both ends, Decline forgets the sender (per-session state — no contact store), Mute rejects and adds the persistent mute. The swarm itself carries only presence (nickname + fingerprint, capped at 100 LRU, never a browsable directory), rate-capped knocks (5/min/peer, optional ≤ 140-char note) and key announces — never conversation content: the resulting DM rides the same session-ephemeral E2EE protocol (issue #93) and shows the "(global)" marker in the sidebar.
- **Self-destructing messages (issue #96)** — the composer can attach a per-message TTL (30 s / 5 min / 1 h) to room chats and DMs: every peer independently removes the message from its feed when the receiver-clock expiry is due (1 s sweep), leaving a local "— N expired messages —" separator. Additive on the wire (no version bump): older builds ignore the field and keep the message for the session. Nothing is stored either way — expiry is enforced in memory by each peer.
- **Emoji reactions (issue #98)** — a fixed whitelist of seven reactions (👍 ❤️ 😂 😮 😢 🎉 👎) on any room or DM message: hovering a message (long-press on touch) opens the quick-pick bar, aggregated chips with counts render under the bubble, your own reaction is highlighted with a tooltip listing the reactors, and clicking a chip toggles yours off. Reactions are cosmetic control-plane traffic (spec §9.5, the same unauthenticated class as ✓✓ receipts and typing): every peer derives its counts locally from whitelisted, batch-capped (≤50 ids), rate-capped (≤30 payloads per peer per minute) and content-deduplicated payloads; DM reactions are directed at the recipient, so the rest of the room never sees them; they never raise notifications or unread badges; and nothing is persisted — the counts live in memory with the message they decorate and a reload loses them. Builds without the feature ignore the whole action silently (mixed-build spike documented in spec §12.3).
- **Slash commands (issue #99)** — a keyboard-first command line in the composer: typing `/` opens an inline autocomplete popup (ARIA combobox pattern — `↑`/`↓` to move, `Enter` to pick, `Esc` to dismiss, focus never leaves the textarea) over eight English verbs (issue #112): `/nick` (rename under the onboarding rules, presence re-announced), `/room` (join a room, cap-checked, with the password popover armed only if the name-only join finds no peers), `/dm` (open an E2EE DM with a peer by nickname), `/me` (send an action), `/rooms`, `/clear` (memory-only local clear, confirmation first), `/leave` and `/help` (in-app help). An unknown verb is **never sent** — you get a local "Unknown command — /help" line instead — and `\/hello` is the documented escape hatch that sends the literal `/hello`. `/me` is a rendering convention, not a wire change: the message travels as a normal chat envelope, so the author sees the italic "_nick action_" line while peers see plain text — an honest asymmetry of the no-protocol-change design.
- **QR invite codes (issue #100)** — the room header's "QR" button renders the invite link as a scannable QR code, so a second device joins by pointing its stock camera at the screen instead of typing the room name. The code encodes exactly the link the share button copies — origin + `#room=<name>` — and therefore never the password: joining a password room still prompts for it (RF-05). The symbol is painted a fixed near-black-on-white with its quiet zone in light AND dark themes (scannability trumps theme), the link text sits below the canvas as a copyable fallback, and "Download PNG" exports a high-resolution image. The popover states the caveat ("The QR links to this same installation."): the deep link only works across devices of the same deployment — same origin and `VITE_TRYSTERO_APP_ID` namespace (issue #90) — a QR from another install joins nothing.
- **Opt-in history gossip (issue #102)** — a late joiner can ask the room for its recent history with one explicit tap (an inline "Ask the room for the latest messages? [Ask] [No]" card on an empty feed — never automatic, rate-limited), and peers who opted in via "Share my recent history with late joiners" (Settings → Privacy, off by default) answer by re-sending at most the last 50 chat messages of their in-memory feed — never DMs, never system lines, never already-expired rows. Recovered rows render under a "— messages recovered from peers —" separator, slightly dimmed, ordered oldest → newest by author timestamp, and are capped at 50 per join session. The replay path bypasses only the 5-minute freshness window (the ±90 s future-skew check stays), re-validates every envelope shape, dedups in both directions (a later live resend of the same id never duplicates a row) and has zero arrival side effects: recovered rows never raise unread badges, never notify and never receipt (✓✓ means live delivery). Password rooms keep confidentiality for free: bodies travel re-sealed with the room key, so only peers sharing the same password can read them. Nothing is persisted anywhere — gossip can only ever share what a live tab holds, and it dies with the tabs. Trust note: a gossiping peer can forge history just like live chat (spec §9.5's unauthenticated control plane); the separator labels provenance, not veracity.
- **P2P file and image transfer (issue #103)** — the composer's "Attach" button offers a file (≤ 20 MB) to one connected peer at a time, directed 1:1: nothing is ever broadcast to the room, and the receiver's consent card (name, size, encryption state, Accept/Decline) must be accepted before a single byte flows — no auto-download, ever. Chunks inherit the conversation's confidentiality: AES-GCM-sealed with the password room's key or the E2EE DM key; public rooms are DTLS-only, disclosed by an explicit pre-send warning and mirrored on the consent card. Transfers show live progress and are cancellable from both sides; received images render inline and other files get a download button. Memory-only end to end: blobs live as revocable object URLs (revoked on dismissal, abort, panic and identity regeneration), nothing touches `localStorage`/IndexedDB, a reload loses everything, and a reconnect mid-transfer fails the transfer with no resume (the sender re-offers).
- **Installable PWA with an offline shell (issue #104)** — a web manifest with 192/512 and maskable icons makes gritos installable: it launches in a standalone window with its own icon on Android/desktop Chrome and Edge (iOS Safari allows add-to-home-screen, but its PWA support is partial — see [Deployment](#deployment-static-hosting)). A small hand-rolled service worker precaches the exact hashed build — shell document, manifest, static assets and icons — so an installed or previously visited app boots with **no network**, always showing the honest connection state: gritos can start offline but not connect, because P2P chat still needs WebRTC and the trackers. A new deploy is never applied behind the user's back: the new worker waits, a corner toast ("New version available" — [Reload]) offers the swap on the next visit, and reloading activates it while the old cache is cleaned up. The toast is the update flow's only path — there is no push and no background sync; the whole mechanism is local and same-origin. Every URL (scope, `start_url`, `sw.js` registration) is relative, so installs work on GitHub Pages project sites and any subpath.
- **Markdown subset** — bold, italic, inline code, links (http/https only), rendered by a home-grown safe renderer; raw HTML, script injection and `javascript:` URLs are escaped. Mentions highlight and can raise desktop notifications.
- **Presence & latency** — live peer list with 🟢/🟡/🔴/⚪ RTT dots, typing indicators, join/leave system lines, ✓/✓✓ receipts.
- **Privacy controls** — mute by identity fingerprint (a local-only list inside `gritos:settings`: no server, no reports; it hides the peer's room messages, DMs, typing indicators and join/leave lines while receipts and latency pings keep flowing, follows the fingerprint across nickname changes, and is wiped by the panic button), panic button (wipe everything and reload, including the IndexedDB key vault), identity regeneration, recent-rooms toggle, notification toggle; only five `gritos:*` keys ever touch `localStorage` (plus the small IndexedDB vault that wraps the private key), and messages/typing/passwords are never persisted.
- **Connection transparency** — exact status text for searching / connecting / connected / tracker-error states, plus a non-blocking banner with a shortcut to network settings when trackers are unreachable.

## How it works

- **Discovery:** [Trystero](https://github.com/tinychat/trystero) (torrent strategy, pinned exact version) uses public WebTorrent trackers over WebSocket (`wss:`) only to introduce peers and exchange SDP. Application traffic never touches a tracker — it flows over direct WebRTC data channels (DTLS-encrypted by the browser).
- **Security model:** room chat rides on WebRTC's DTLS transport; password rooms and DMs add payload encryption with the native Web Crypto API (PBKDF2-SHA-256 600k iterations for room keys; for DMs, session-ephemeral ECDH P-256 with a dual-salt HKDF binding the identity and session fingerprints — info `gritos/dm/v2` — and AES-256-GCM over `v: 2` DM envelopes, issue #93: the ephemeral private key exists only for the app session, so captured DM traffic stops being decryptable once it ends). Peers on older builds show an explicit unavailable state in the DM composer instead of silently losing messages; mixed-version DM envelopes are dropped until builds converge. Trackerless manual DMs (issue #97) reuse exactly this machinery: the copy/paste invite blobs carry only public keys, the fingerprint and the SDP — never message data — and their authenticity is not guaranteed by the transport, so the out-of-band fingerprint comparison stays the trust anchor (the wizard warns that an invitation may contain network information); manual-peer TOFU pins ride the same `gritos:tofu` map under reserved `manual:` keys (no sixth `localStorage` key, same panic wipe). The opt-in global DM channel (issue #105) widens the exposure honestly rather than hiding it: joining the swarm makes your IP, identity fingerprint and nickname visible to every opted-in peer — the default-off toggle is the documented mitigation (spec §9.5) — a knock reveals the knocker's interest in the target fingerprint, and the swarm never carries message content, only presence, knocks and key announces, with the resulting DM encrypted exactly as above. The private key is **encrypted at rest** (issue #24): it is AES-GCM-wrapped with a non-extractable key held in IndexedDB, so `gritos:identity` never contains plaintext key material — where IndexedDB is unavailable the app degrades to the old plaintext-at-rest behavior rather than breaking. Room passwords and all message content stay memory-only. The bundle ships a strict CSP (`script-src 'self'` + a hash for the inline frame-bust/theme bootstrap snippet); embedding the app in a frame is refused in-page by that bootstrap script, since a `<meta>` CSP cannot deliver `frame-ancestors` (issue #27). The offline service worker (issue #104) is same-origin by construction: it precaches and serves only the app's own shell assets, cross-origin traffic (the `wss:` trackers first of all) passes through untouched and is never cached, and it adds no push channel — notifications remain tab-scoped (spec §11.5). There is no server, so there is no server-side trust to audit. Being direct P2P also means room peers can see your IP address (inherent to WebRTC; disclosed in the onboarding and the Privacy tab). Residual risk, stated plainly: a fully compromised same-origin context (malicious extension with host permissions, malware on the device) can still reach both stores and abuse the key — the wrapping only raises the bar against naive `localStorage` dumps. Finally, the v1 control plane is unauthenticated by design (issue #36, accepted in the spec threat model, §9.5): any peer can forge delivery receipts (✓✓), typing indicators, join/leave system lines and latency pongs, or flood chat to spam unread badges and mention notifications — inherent to a trustless mesh; v1 ships only cosmetic caps (per-peer system-line rate limit, implausible-RTT discard/clamp) plus a user-facing local mute by fingerprint (issue #95: hides an abusive peer's room chat, DMs, typing and system lines; local-only, wiped by the panic button; a peer can still evade it by rotating their identity key, which the TOFU pin surfaces).
- **Supply chain:** dependency versions are exact-pinned and `npm audit --audit-level=high` gates CI against the lockfile, with a scheduled weekly re-run (`.github/workflows/audit.yml`) and Dependabot opening weekly update PRs for npm and GitHub Actions. Because pins are exact, every upstream release of the transport library `@trystero-p2p/torrent` surfaces as its own reviewable Dependabot PR — that is the release tracking. The newest dependency, the QR encoder behind the invite codes (issue #100), is the same deal in miniature: `qrcode-generator@2.0.4`, MIT, zero transitive dependencies, consumed only for its matrix output (no runtime network).
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
│   └── nickname.ts English 'noun-adjective' generator
├── stores/         useAppStore (AppState §8.1), useSettingsStore, useUiStore
├── hooks/          useRoom · useLatency · useTheme · useNotifications · …
├── styles/         Tailwind 4 entry + AA-audited theme tokens (light/dark)
└── tests/          Vitest suites (node env; jsdom per file when DOM is needed)
```

Architecture rules: Trystero may only be imported from `lib/p2p/roomManager.ts`; components touch neither Web Crypto nor WebSockets directly (stores and hooks only); everything cryptographic lives in `lib/crypto/` and is testable without a network.

## Deployment (static hosting)

The build output is a plain static site: serve `dist/` over **HTTPS** from any file host. Web Crypto and WebRTC require a secure context, so plain HTTP (other than `localhost`) will not work.

The build uses a **relative base** (`base: './'` in `vite.config.ts`): all asset URLs in `dist/index.html` are relative, so the same build works at the root of a domain, on a GitHub Pages project site (`https://<user>.github.io/<repo>/`), under a Netlify subpath, or in any nginx `location` — no per-host reconfiguration needed.

**Service worker / offline shell (issue #104).** `npm run build` also emits `sw.js` with a content-hashed precache of that exact build (a tiny Vite plugin injects the file list and the `gritos-shell-v…` cache version at build time). Served from `./sw.js`, its scope covers subpath deployments; the shell — document, manifest, icons and hashed assets — is answered cache-first, while anything cross-origin (the `wss:` tracker sockets first among them) passes through untouched and is never cached. On a new deploy the updated worker installs and **waits**; on the visitor's next visit a local toast ("New version available") offers "Reload", whose reload activates the new version and deletes the previous caches. There is no `skipWaiting` and no silent swap: an open session keeps running the version it loaded until the user reloads. `npm run dev` stays SW-free (the worker is production-only, mirroring the dev-only CSP strip). Service workers share the HTTPS requirement of the secure context — they simply do not register over plain HTTP. **iOS Safari caveat:** add-to-home-screen works, but iOS has no install prompt and other PWA gaps (occasional service-worker quirks), so treat iOS as best-effort/partial support.

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
- **Frame-busting is built in (issue #27):** the inline bootstrap script in `index.html` detects when the page runs inside a frame and refuses to boot — it replaces the document with a warning ("For security, this app cannot run inside a frame or iframe. Open it in its own tab to continue.") instead of starting the app. This in-page fallback is what keeps header-less hosts such as GitHub Pages usable, because browsers ignore `frame-ancestors` in a `<meta>` CSP (the only CSP delivery GitHub Pages supports).
- **Recommended host headers** (self-hosters can do better than the in-page fallback — defense in depth):
  - `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) — forbids embedding at the HTTP layer.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
- Single-page app with no routes: no rewrite rules are needed beyond serving `index.html` at `/`.

## Public trackers notice

Peer discovery relies on **public WebTorrent trackers** operated by third parties. Your browser contacts these trackers to find peers and exchange the initial connection handshake (SDP) for rooms you join; the **room name is hashed** before it is used for discovery, so the tracker sees an opaque id — but trackers can observe your IP address, the timing of joins, and those opaque room ids. If all public trackers are unreachable, existing connections keep working but no new peers can be discovered (the app surfaces this state and lets you configure alternative trackers and your own STUN/TURN servers in Settings → Network). If this threat model does not suit you, run your own tracker and set it in the network settings.

**The effective default list** (issue #51): with the default settings (`trackers: []`) the app passes no tracker list to Trystero, so the trackers baked into the pinned library release are the ones actually in effect. For `@trystero-p2p/torrent@0.25.4` that is exactly these five:

- `wss://open.ftorrent.com`
- `wss://tracker.webtorrent.dev`
- `wss://tracker.openwebtorrent.com`
- `wss://tracker.btorrent.xyz`
- `wss://tracker.files.fm:7073/announce`

We deliberately **do not ship a curated replacement list**: the dependency is exact-pinned, so this list is deterministic per release and cannot drift underneath you; anything we curated would be the same class of third-party community trackers — duplicated upstream maintenance, just as free to silently rot; and upstream's defaults are the set the library is tested against. Every library bump surfaces as its own reviewable Dependabot PR, which is the natural checkpoint to re-verify the list above (re-derive it from `defaultRelayUrls` in `node_modules/@trystero-p2p/torrent/dist/index.mjs`). If these trackers decay, the tracker-error banner and the [tracker runbook](docs/runbook-trackers.md) cover the recovery path: add your own `wss://` trackers in Settings → Network (an empty list restores these defaults).

## Limitations (spec §11, summarized)

1. **Full mesh:** optimal up to ~15 peers per room; beyond ~20 the mesh degrades (active rooms multiply the effect). Room (≤6) and message (500/room, FIFO) caps bound memory/CPU.
2. **Public trackers:** if they all go down, no new peers can be discovered (already-connected peers keep chatting). Alternative trackers are user-configurable.
3. **Symmetric NAT / corporate firewalls:** direct P2P may fail without a TURN server; you can configure your own STUN/TURN, but no TURN is provided.
4. **Background tabs:** deep-backgrounded tabs get throttled timers (latency dots degrade); they recover on focus.
5. **No server:** history is not kept for late joiners by default — the opt-in history gossip (issue #102) softens exactly that case: at most the last 50 in-memory messages, only when the joiner explicitly asks AND a peer has consented, with nothing persisted. Still no offline delivery and no real push (notifications only fire while a tab is open, even hidden).
6. **Multiple tabs of the same browser:** each tab is a distinct peer; you will see your own nickname duplicated with a suffix.
7. **DMs usually need a shared room:** peer discovery is tracker-based, so arbitrary DMs need a setup step — two deliberate, non-automatic paths soften it: the manual invite wizard (issue #97) is the deliberate zero-infrastructure exception (a copy/paste blob exchange), and the opt-in global channel (issue #105) is the second, where both peers flip "Global DM channel" on and can then knock each other by fingerprint across the shared signaling swarm (off by default; exposure disclosed in [How it works](#how-it-works)).
8. **No global message ordering, nicknames are not unique:** accepted trade-offs for v1.
9. **File transfers live in RAM (issue #103):** up to 20 MB per file and 3 concurrent transfers per peer (both sides) — several at once can strain low-end devices; the size cap and the concurrency limit are the mitigations. Nothing is persisted: a reload loses every transfer (blob, URL, offer and progress), object URLs are revoked on dismissal, abort, panic and identity regeneration, and a reconnect mid-transfer fails it with no resume.

## Documentation

- [Functional and technical specification](docs/spec.md) — requirements, protocol, crypto design, state model, UX.
- [Development plan](docs/plan.md) — milestones M0–M6, QA strategy, risks.
- [Manual QA checklist](docs/qa-checklist.md) — cumulative per-milestone checklist and the M6 full pass.
- [Tracker runbook](docs/runbook-trackers.md) — one-page user guide for the "No tracker access" state.

## Status

**v1.0.0** — feature-complete (milestones M0–M6): P2P multi-room core, onboarding and chat UI, E2EE DMs, password rooms, settings/notifications/privacy, polish and release QA.

## License

Gritos is released under the [MIT License](LICENSE).
