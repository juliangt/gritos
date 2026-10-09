# Gritos — Development plan (v1)

|                             |                                                                          |
| --------------------------- | ------------------------------------------------------------------------ |
| **Status**                  | Draft v1.0 — approved                                                    |
| **Date**                    | 2026-10-03                                                               |
| **Reference specification** | `docs/spec.md` (the `RF-xx` / `RNF-xx` IDs cited here are defined there) |
| **Original source**         | `docs/wishlist.md` + closed decisions D1–D5 (spec, section 2)            |

---

## 1. Executive summary

Development of **Gritos**, a serverless P2P chat (React + Vite + TypeScript + Tailwind + Zustand + Trystero/torrent), organized into **7 sequential milestones (M0–M6)**, each with a demonstrable deliverable, concrete tasks and verifiable completion criteria. Every milestone ends in a _"partially shippable"_ state: the app boots and the features already built work end to end.

Cross-cutting rule: **nothing is marked as done without manual verification in ≥2 browser tabs** (two tabs = two real peers), plus unit tests where applicable.

## 2. Pre-requisites and deliverables

**Pre-requisites**: Node.js LTS (≥20) and npm (or pnpm). An evergreen browser with DevTools. There is no external infrastructure to provision.

**Final deliverable**: a static build in `dist/` deployable to any file host (RNF-06), plus this repository with tests and documentation.

**Global Definition of Done** (applies to every milestone):

- `npm run build` passes with no errors or TS warnings.
- `npm run lint` clean; `npm test` green.
- The milestone's manual checklist executed and annotated (template in section 7).
- No debug `console.log` in production code (network logs live behind the `debug` flag).

## 3. Target folder structure

```
gritos/
├── docs/                      # spec.md, plan.md, wishlist.md
├── index.html                 # includes the anti-flash theme script and the CSP meta (M6)
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx
│   ├── App.tsx                # view routing: onboarding | app
│   ├── components/
│   │   ├── onboarding/        # OnboardingScreen, NicknameInput
│   │   ├── sidebar/           # Sidebar, RoomList, PeerList, JoinRoomPopover
│   │   ├── chat/              # ChatHeader, MessageFeed, MessageItem, ChatInput,
│   │   │                      # TypingBar, NewMessagesButton
│   │   ├── dm/                # DmHeader (fingerprint), (reuses chat components)
│   │   ├── settings/          # SettingsModal, NetworkTab, PrivacyTab, AppearanceTab
│   │   └── common/            # Modal, Badge, StatusDot, Icon, ConfirmDialog
│   ├── lib/
│   │   ├── p2p/
│   │   │   ├── roomManager.ts # Map<roomId, RoomConnection>; the only Trystero surface
│   │   │   └── protocol.ts    # Envelope types, actions, validation/dedup
│   │   ├── crypto/
│   │   │   ├── identity.ts    # ECDH keypair, fingerprint, JWK persistence
│   │   │   ├── dm.ts          # ECDH + HKDF + AES-GCM per peer
│   │   │   ├── roomKey.ts     # PBKDF2 + deterministic salt + AES-GCM
│   │   │   └── hashes.ts      # SHA-256/uuid/roomId (spec 9.4)
│   │   ├── markdown/
│   │   │   └── render.tsx     # safe subset renderer (RF-03)
│   │   └── nickname.ts        # noun-adjective generator (en)
│   ├── stores/
│   │   ├── useAppStore.ts     # the spec's AppState (8.1)
│   │   └── useSettingsStore.ts
│   ├── hooks/
│   │   ├── useRoom.ts         # subscription to the active room
│   │   ├── useLatency.ts      # ping/pong loop
│   │   ├── useTheme.ts        # light/dark/system + anti-flash
│   │   └── useNotifications.ts
│   └── styles/index.css       # Tailwind + theme tokens
├── tests/
│   ├── crypto.test.ts         # vectors and roundtrips (section 6)
│   ├── markdown.test.tsx      # XSS attacks and the subset
│   ├── protocol.test.ts       # dedup, v validation, size
│   └── nickname.test.ts
├── .gitignore
├── package.json
├── tsconfig.json
└── vite.config.ts
```

**Code architecture rules**

- Trystero is imported **only** from `lib/p2p/roomManager.ts` (isolates API changes — risk R4).
- Components touch neither Web Crypto nor WebSockets: only stores and hooks.
- Everything cryptographic lives in `lib/crypto/` and is testable without a network.

## 4. Milestones

### M0 · Setup and foundations — _S complexity_

**Goal**: a living repository with the full toolchain and an empty app rendering.

- [ ] `npm create vite@latest . -- --template react-ts` (at the root, respecting `docs/`).
- [ ] Dependencies: `trystero` (pin the **exact version**, no `^`), `zustand`, `tailwindcss` (+ the Vite plugin if Tailwind 4 is used) — **zero further runtime dependencies** (no `uuid` → `crypto.randomUUID()`; no `marked`/`dompurify` → own renderer; no `idb` → D2 removes it).
- [ ] Dev deps: `vitest`, `@testing-library/react`, `jsdom`, `eslint` (+ `typescript-eslint`, `eslint-plugin-react-hooks`), `prettier`.
- [ ] Scripts: `dev`, `build`, `preview`, `test`, `lint`, `format`.
- [ ] `git init`, `.gitignore` (node_modules, dist, .env, .DS_Store), initial commit.
- [ ] The folder structure of section 3 (empty but with the modules created and exporting typed stubs).
- [ ] The spec's base types (8.1) in `stores/` and `lib/p2p/protocol.ts`.
- [ ] Minimal README: what Gritos is, how to run it, a link to `docs/spec.md`.

**Done when**: `dev` serves the empty app with the theme working, `build` + `lint` + `test` (with a smoke test) pass, and there is an initial commit.

### M1 · Multi-room P2P core — _L complexity_

**Goal**: real connectivity between tabs with no chat UI. This is the highest-technical-risk milestone; it is attacked first to unlock everything else.

Covers (spec): 6.3, 6.5, 7 (the full protocol), 9.4, RF-06 partial.

- [ ] `hashes.ts`: `deriveRoomId(name, password?)` per 9.4, with tests.
- [ ] `roomManager.ts`:
  - [ ] `joinRoom(name, password?)` / `leaveRoom(roomId)` / `reconnectAll()`; the `maxActiveRooms` cap validated before joining.
  - [ ] Per room: registration of the `presence`, `keys`, `chat`, `dm`, `typing`, `receipt`, `ping`, `pong` actions (7.1).
  - [ ] Events → Zustand store updates (peers, room status, typing decay).
  - [ ] `appId = 'gritos-app-v1'`; `config` with trackers/ICE from settings.
  - [ ] `error` state heuristic (15 s with no tracker connection) and `searching`→`connected`.
- [ ] `protocol.ts`: `Envelope` parse/validation (v, sizes, ids), per-room dedup, tests.
- [ ] `useLatency`: ping every 5 s per peer, timeout and a `degraded` mark after 3 failures.
- [ ] Temporary debug view (removed in M6): a panel showing per-room status, peers, latencies and a button that sends a test `chat` — enough to verify without UI.
- [ ] Nickname changes re-announced (`presence`).

**Done when**: in 2 tabs joined to `#lobby` both panels show the other peer with nickname, fingerprint and latency <X ms; in 3 tabs each sees 2 peers; closing one tab makes the others mark the leave in <10 s; joining a 5th room with cap 4 is rejected.

### M2 · Onboarding and chat UI — _L complexity_

**Goal**: the nuclear public-room chat experience, complete. The first milestone _demonstrable to third parties_.

Covers (spec): RF-01, RF-02 (no password), RF-03, RF-06 (peer UI), 10.1–10.4, 10.6, RNF-05 partial.

- [ ] `OnboardingScreen` (RF-01): input + "surprise me" (`nickname.ts` with English wordlists, tests), basic identity persistence (no keys yet — they arrive in M3).
- [ ] Layout: collapsible sidebar (`Ctrl/Cmd+B`, mobile drawer), header, feed, input (10.1).
- [ ] Sidebar: Active (unread badge + status), Suggested (`#lobby #general #dev #random`), Recent (`rememberRooms`), a `[+ Join]` popover with name validation (RF-02), a Peers section with latency dots.
- [ ] `ChatInput`: Enter/Shift+Enter, auto-resize to 6 lines, the 4000 limit with counter, `typing` throttle, a local queue while `searching`.
- [ ] `MessageFeed` + `MessageItem`: own Markdown rendering (`markdown/render.tsx` with XSS tests: `<script>`, `onerror=`, `javascript:` in links), highlighted mentions, author color by peerId hash, `HH:MM` time, system color for joins/leaves, the FIFO separator at 500.
- [ ] `typing` with 4 s expiry and the "N people are typing…" line.
- [ ] Batched `receipt` (≤50 ids) and `✓`/`✓✓` on own messages.
- [ ] Smart scroll (auto only at ≤150 px from the bottom, a "↓ N new messages" button).
- [ ] `useTheme` light/dark/system + the inline anti-flash script in `index.html` (10.6).
- [ ] Connection states with the spec's exact texts (10.3).
- [ ] View switching between active rooms without dropping connections.

**Done when**: two tabs converse with Markdown, mentions and typing visible; receipts flip to ✓✓; unreads accumulate and clear on open; the theme switches live; the M2 checklist of section 7 signed.

### M3 · DMs with E2EE — _M complexity_

**Goal**: 1:1 direct messages encrypted end to end between peers with a shared room.

Covers (spec): RF-04, 9.1, 9.2, 10.1 (peer menu).

- [ ] `identity.ts` complete: an ECDH P-256 keypair on first boot, JWK export/import in `localStorage`, fingerprint (8×4 hex format, 128 bits — issue #23), regeneration.
- [ ] `keys`/`presence` are already sent in M1; here they are consumed: `dm.ts` derives the `dmKey` (ECDH → HKDF-SHA256 with the sorted per-pair salt) with tests that both ends derive the same key.
- [ ] The `dm` action with `to`; unrelated recipients discard (unit test of the filtering).
- [ ] AES-GCM 256 encryption, a 12 B IV per message, `base64(IV‖ct)`, rejection of tampered ciphertext (tamper test → invalid GCM tag).
- [ ] UI: peer menu → "Direct message"; a DM view reusing feed/input; header with nickname + fingerprint + verification notice; unread badge; the "peer disconnected" state when shared rooms are lost.
- [ ] Basic incoming-DM notification with the tab hidden (permission + toggle arrive formally in M5; here the technical path).

**Done when**: an E2EE DM flows between 2 tabs; a third tab in the same room **cannot** decrypt (verified in a unit test decrypting with the wrong key and by payload inspection in DevTools); the fingerprint shown at both ends matches.

### M4 · Password rooms — _M complexity_

**Goal**: encrypted rooms whose existence depends on the password.

Covers (spec): RF-05, 9.3, 9.4 (the password path).

- [ ] `roomKey.ts`: PBKDF2-SHA256 600,000 iterations, a deterministic per-name salt, AES-GCM — roundtrip and cost tests (the test uses the real API; it is measured at <1 s on desktop).
- [ ] `joinRoom` extension with a password: roomId derivation, the `hasPassword` mark, the password **in session memory only**.
- [ ] `JoinRoomPopover`: an optional password field with an "encrypted room" toggle and a one-line explanation ("Whoever lacks the password will not find this room").
- [ ] `chat` encryption in password rooms; the "🔒 encrypted message" placeholder in the (theoretical) no-key reception case.
- [ ] 🔒 in header and sidebar; rejoining after a reload demanding the password again; the single message "Room #name not found with that password" (it does not distinguish a nonexistent room from a wrong password).
- [ ] On identity regeneration or panic: no behavior change in rooms (the room key belongs to the room, not the identity) — tested.

**Done when**: 2 tabs with the same password converse encrypted (payload illegible in DevTools); a third tab without the password does not discover the room (it stays `searching` and receives the error message when the heuristic expires); the reload demands re-entering the password.

### M5 · Settings and privacy — _M complexity_

**Goal**: the complete modal, notifications and data hygiene.

Covers (spec): RF-07, RF-08, RF-09, RF-10 (appearance settings), 8.2.

- [ ] `SettingsModal` with tabs and trapped focus (`Esc` closes).
- [ ] **Network**: `autoJoinLobby`, tracker editing (`wss://` validation, empty list = defaults), ICE servers (`stun:`/`turn:` + credentials, validated JSON), `maxActiveRooms` 1–6, the "applies on reconnect" note + the **Reconnect all** button (uses M1's `reconnectAll()`).
- [ ] **Privacy**: the notifications toggle + permission request with states (granted/denied/not requested), `rememberRooms`, **Regenerate identity** (confirmation warning about the fingerprint change), **Panic button** (double confirmation, wipes `gritos:*`, aborts connections, reloads).
- [ ] **Appearance**: theme (already implemented in M2, wired here), the sidebar's initial state.
- [ ] `useNotifications` complete: an `@nickname` mention and DMs with `document.hidden`, click → focus + navigation to the originating view (RF-09).
- [ ] Nickname change from settings with a re-announce to peers.
- [ ] 8.2 verification: `localStorage` inspection — only the 4 `gritos:*` keys and no sensitive content.

**Done when**: every setting persists and applies after reload; custom trackers are visible in DevTools → Network on reconnect; the panic button leaves `localStorage` empty and returns to onboarding; a mention with the tab hidden fires a notification and its click navigates to the origin.

### M6 · Polish, QA and release — _M complexity_

**Goal**: production quality and deployment.

Covers (spec): RNF-03, RNF-05, RNF-06, RNF-07, 11 (limitations visible where appropriate).

- [ ] Remove M1's debug view (or keep it behind the `?debug` flag).
- [ ] Designed empty states: empty room ("Share the room name so others can join"), no DMs, no recents.
- [ ] Accessibility: visible focus, the feed's `aria-live`, list roles, `Esc` in every modal/popover, AA contrast audited, sidebar keyboard navigation.
- [ ] Real responsive behavior (≤768 px): sidebar drawer, usable input on mobile.
- [ ] Performance: measured with 15 simulated peers (multiple tabs / browsers) and rooms at the cap; re-render trimming (fine Zustand selectors, memoized messages).
- [ ] `index.html`: hardened CSP meta (`script-src 'self'`; validate the interaction with WebSockets/WebRTC in each browser), `color-scheme`, title/description.
- [ ] Network-error handling in the UI: a non-blocking banner for the tracker `error` state with a shortcut to Settings → Network.
- [ ] The full QA checklist (section 7) in 2 different browsers (e.g. Chrome + Firefox).
- [ ] Final README: screenshot, static-deployment guide (any file host, HTTPS required — RNF-04), limitations (spec §11), the public-trackers notice.
- [ ] Tag `v1.0.0`.

**Done when**: the production build deployed to a static host works end to end between two machines/networks (or two browsers on different networks if there is no second machine), the full checklist green.

## 5. Dependencies between milestones

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6
        │              │
        │              └── M4 depends on M3 only in crypto detail (roomKey is
        │                  independent, but shares encryption infrastructure)
        └── M2 depends on M1 (roomManager + protocol). M5 depends on M2 (layout/modal)
            and M3 (identity regeneration). M6 depends on everything.
```

Strict recommended order; M3 and M4 **may** be swapped if validating the encrypted rooms before the DMs is preferred.

## 6. Testing strategy

### 6.1 Unit (Vitest, run at every milestone)

| Module            | Minimum cases                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto/hashes`   | deterministic roomId with/without password; stable salt; non-repeating uuid.                                                                                                |
| `crypto/dm`       | both ends derive the same key; encrypt/decrypt roundtrip; tampered ciphertext fails (GCM tag); a message >4000 B rejected.                                                  |
| `crypto/roomKey`  | same password → same key on different clients; roundtrip; different passwords → different keys.                                                                             |
| `crypto/identity` | generation → stable fingerprint; regeneration → different fingerprint; persistence/reload restores the pair.                                                                |
| `markdown/render` | the full subset renders; `<script>`, `<img onerror>`, `[x](javascript:…)`, HTML attributes and entities are escaped; links http/https only; correct length and line breaks. |
| `p2p/protocol`    | dedup by id; `v≠1` ignored; payloads >64 KB discarded; a `dm` with a foreign `to` filtered; receipt batches ≤50.                                                            |
| `nickname`        | valid format, no immediate repetition, correct charset.                                                                                                               |

### 6.2 Manual multi-tab (template per milestone)

Each milestone appends rows to a cumulative checklist in `docs/qa-checklist.md` (created in M1). Format: action → expected → pass/fail → browser. Execution uses at least 2 tabs (and, where noted, 2 browsers or 2 machines to validate different NATs).

### 6.3 Optional (non-blocking)

- E2E Playwright with two browser contexts automating M2's happy path. Only if the project calls for it; the manual checklist is v1's source of truth.

## 7. Master QA checklist (completed in M6)

1. First visit → onboarding → auto-join `#lobby` (with and without `autoJoinLobby`).
2. 2 tabs in `#lobby`: mutual presence, latency, `connected` status.
3. A message with the full Markdown subset + a mention → correct render on the receiver.
4. Typing visible and expiring after 4 s.
5. Receipts ✓→✓✓.
6. Scroll: long history, auto-scroll, the "N new" button.
7. 3 simultaneous active rooms (cap 4): cross-room messages, per-room unread, view switching without loss.
8. A 5th-room attempt → rejected with a message.
9. E2EE DM between 2 tabs; a third tab cannot decrypt.
10. The fingerprint identical at both ends of the DM.
11. Password room: 2 clients join, ciphertext illegible in DevTools, a third client cannot find the room.
12. Reload in a password room → the password asked again.
13. Settings: custom trackers visible on reconnect; custom STUN applied (see ICE in `about:webrtc` / `chrome://webrtc-internals`).
14. Mention and DM notifications with the tab hidden; click navigates to the origin.
15. Light/dark/system theme with no flash on load.
16. Panic button → empty `localStorage` + clean onboarding.
17. Regenerate identity → the fingerprint changes and is re-announced.
18. Abrupt tab close → the rest mark it disconnected <10 s.
19. Mobile (viewport ≤768 px): drawer, message sending, DM.
20. `npm run build` + `preview`: all of the above against the production bundle.

## 8. Risks and mitigations

| #   | Risk                                                            | Prob.  | Impact   | Mitigation                                                                                                                                       |
| --- | --------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Public trackers down or saturated (the app "finds nobody")      | Medium | High     | A backup tracker list in `roomManager`; custom-trackers setting from M5; the `error` state with an in-UI guide (10.3); documented in the README. |
| R2  | Symmetric NAT/firewall blocks direct P2P                        | Medium | High     | A public STUN by default (included in Trystero); user-configurable TURN (RF-07); documented limitation (spec §11.3).                             |
| R3  | Connection duplication with several rooms (resources/CPU)       | Medium | Medium   | The room cap (4 by default, max 6); throttling-tolerant ping; measurement in M6 with 15 peers.                                                   |
| R4  | API changes in Trystero                                         | Low    | Medium   | Exact pinned version; the only import surface in `roomManager.ts` (section 3).                                                                   |
| R5  | XSS through Markdown compromises the `localStorage` private key | Low    | Critical | Own subset renderer with no raw HTML + an XSS test suite + CSP in `index.html` + zero third-party rendering deps.                                |
| R6  | Timer throttling in a hidden tab breaks latency/presence        | High   | Low      | Tolerant ping (5 s + 3 failures → degraded ⚪, not disconnected); recovery on focus.                                                             |
| R7  | Nickname impersonation (no global identity)                     | Medium | Medium   | Fingerprint visible in DMs + the verification notice (TOFU); documented limitation (spec §9.5).                                                  |
| R8  | Slow discovery (2–6 s) perceived as a failure                   | High   | Low      | Exact status texts (10.3), an animated indicator, input not blocked with a local queue.                                                          |

## 9. Indicative estimation

Relative complexity: **S** = 1–2 days, **M** = 3–5 days, **L** = 1–2 weeks (reference: one person with average experience in the stack, full time; adjust ×2–×3 for part-time).

| Milestone               | Complexity | Indicative cumulative |
| ----------------------- | ---------- | --------------------- |
| M0 Setup                | S          | 0.5 weeks             |
| M1 P2P core             | L          | 2 weeks               |
| M2 Onboarding + chat    | L          | 3.5 weeks             |
| M3 E2EE DMs             | M          | 4.5 weeks             |
| M4 Password rooms       | M          | 5 weeks               |
| M5 Settings and privacy | M          | 5.5 weeks             |
| M6 Polish and release   | M          | 6–7 weeks             |

**Demonstrable milestones**: end of M2 = public chat-in-rooms demo; end of M4 = full privacy demo (E2EE + hidden rooms); end of M6 = deployable v1.0.0.
