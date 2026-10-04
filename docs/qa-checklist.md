# Gritos — Manual QA checklist

Cumulative checklist per milestone (plan.md §6.2/§7). **Each milestone appends
its rows to the table below.** Execute with at least 2 browser tabs (two peer
pairs); plan.md §7 items marked "2 navegadores" need two different browsers.
Fill in Pass/Fail and the browser used during manual execution.

| # | Action | Expected | Pass/Fail | Browser |
|---|--------|----------|-----------|---------|
| M1-1 | Open the app in 2 tabs, join the same room via the debug panel in both | Within ~15 s each tab lists the other peer with nickname, fingerprint and latency dot; room status shows "Canal P2P establecido · 1 pares" in both | | |
| M1-2 | Observe the status text right after joining, before any peer appears | Header shows "Buscando pares en la red torrent…" until the first peer joins | | |
| M1-3 | Send a test chat from tab A ("Enviar chat de prueba") | Tab B shows the message in its room feed with the author's nickname; tab B answers with a directed receipt (message shows ✓✓ in tab A) | | |
| M1-4 | Latency dots between the two tabs | Both peers show 🟢 (<150 ms) on localhost with a latency value in ms; dots recover after throttling a tab | | |
| M1-5 | Open a 3rd tab and join the same room | Each of the 3 tabs lists 2 peers, each with nickname and fingerprint | | |
| M1-6 | Close one tab abruptly (kill the tab) | The remaining tabs drop that peer from the list in <10 s and the count updates ("· N pares") | | |
| M1-7 | Set `maxActiveRooms` to 4 and try to join a 5th room | Rejection message "Límite de salas activas alcanzado (4)" shown inline; still 4 active rooms | | |
| M1-8 | Change the nickname in the identity field while peers are connected | Connected peers update the nickname without reconnecting (presence re-announce) | | |
| M1-9 | Leave a room with "Abandonar" in one tab | The peer disappears from the other tab's list; the room vanishes from the local panel | | |
| M1-10 | Join a room with a password in 2 tabs (same password) | Both tabs find each other (roomId derives from name+password) and exchange presence | | |
| M2-1 | First visit: open the app with an empty localStorage | Onboarding screen shows the "gritos" logo, "Tu apodo" field, "sorpréndeme" and "Entrar →"; no chat shell | | |
| M2-2 | Click "sorpréndeme" several times | Each click fills a valid es-ES nickname (sustantivo-adjetivo, e.g. "zorro-bravo") and never repeats the previous one | | |
| M2-3 | Enter an invalid nickname ("a" or "no!!!") and press Entrar | Inline error "Usa entre 2 y 24 caracteres…" appears under the field; no error modal; identity not created | | |
| M2-4 | Press Entrar with the field empty | A random valid nickname is generated; identity persists under `gritos:identity`; #lobby auto-joins and its header shows "Buscando pares en la red torrent…" | | |
| M2-5 | Reload the page | Onboarding is skipped; the chat shell appears directly with the persisted nickname | | |
| M2-6 | Two-tab conversation in #lobby: send "hola **mundo** y *cursiva* y `código`" plus a link | Receiver renders bold/italic/code and the link (http/https only); authors show stable hash colors and HH:MM timestamps | | |
| M2-7 | Paste `<script>alert(1)</script>` and `[x](javascript:alert(1))` and send | Everything renders as inert literal text: no script element, no anchor, no dialog | | |
| M2-8 | Tab B includes "@<tabA-nick>" in a message (also in different case) | The mention is highlighted for the receiver; a non-matching "@word" stays plain text | | |
| M2-9 | Tab B types without sending | Tab A shows "luna-cauta está escribiendo…"; with 2 peers typing "N personas están escribiendo…"; the line disappears 4 s after they stop | | |
| M2-10 | Tab A sends a message to tab B | Tab A shows ✓ dimmed; after tab B auto-receipts (~300 ms batch) it flips to ✓✓ | | |
| M2-11 | Send a message while the room is still "Buscando pares…" | The composer shows "En cola hasta conectar…"; the message flushes automatically once the first peer joins | | |
| M2-12 | Open 2 more rooms from Sugeridas, then switch views between the 3 rooms | Connections stay alive (no re-search on the previously connected rooms); messages arriving in background rooms raise unread badges; opening a room clears its badge | | |
| M2-13 | With a message waiting in a background room, check the sidebar badge count | The badge accumulates per room and shows the exact count; click navigates and clears it | | |
| M2-14 | Toggle the sidebar with the ☰ button and with Ctrl/Cmd+B | The sidebar collapses/expands; the collapsed state survives a reload (`gritos:ui`); at ≤768 px it opens as an overlay drawer with backdrop | | |
| M2-15 | Join a room via [+ Unirse] typing "Mi Sala" (mixed case + space) | Live preview shows "#mi-sala"; the join targets the normalized name; invalid input shows "Solo minúsculas, números, guiones y guion bajo (1–32 caracteres)" | | |
| M2-16 | With the room cap reached, try joining one more room from the popover | Inline error "Límite de salas activas alcanzado (N)"; no extra room opens | | |
| M2-17 | Check the Pares section with two tabs using the same nickname | Duplicate nicknames display with the peerId suffix ("nick·a3f1"); latency dots show 🟢/🟡/🔴/⚪ per RTT | | |
| M2-18 | Peer context menu on a peer | "Mensaje directo" is disabled (M3 stub); "Copiar fingerprint" copies to the clipboard when a fingerprint was received | | |
| M2-19 | Switch theme (Claro/Oscuro via `gritos:settings` until M5) | The theme switches live without reload; feed colors, author colors and badges stay readable | | |
| M2-20 | Keep the two tabs talking past 500 messages in one room | The feed keeps the newest 500 and shows the "— mensajes anteriores descartados —" separator at the top | | |
| M2-21 | Scroll up in a busy room and wait for new messages | No forced auto-scroll; a floating "↓ N mensajes nuevos" button appears, jumps to the bottom and clears on click | | |
| M2-22 | Open the app with `?debug` | The M1 debug panel renders below the chat shell; without the flag it stays hidden | | |
| M3-1 | Reload the app with an M2 `gritos:identity` (profile only, no JWKs) | Onboarding is skipped; the record is migrated in place: nickname preserved, a real ECDH keypair is bound and `pubJwk`/`privJwk` appear under `gritos:identity` | | |
| M3-2 | Reload the app again after entering (identity with JWKs) | The same keypair is restored: the fingerprint shown matches the pre-reload one; no onboarding | | |
| M3-3 | Peer menu (click a peer in Pares) | Menu shows "Mensaje directo" (enabled) and "Copiar fingerprint"; it closes on Esc, on an outside click and after any action | | |
| M3-4 | Choose "Mensaje directo" | The DM view opens: header shows the peer nickname, its fingerprint in 8 groups of 4 hex chars (128 bits), the notice "Compáralo con tu interlocutor para verificar su identidad" and the "1 par" state; the feed, typing bar and composer are the room components | | |
| M3-5 | E2EE DM between 2 tabs sharing #lobby: send messages both ways | Both tabs decrypt and show the messages; own messages show ✓ then ✓✓ after the peer's receipt | | |
| M3-6 | Third tab in the same room inspects the `dm` envelope in DevTools (WebRTC data / payload) | The `body` is base64 ciphertext (no plaintext); the third tab shows no DM content anywhere in its UI | | |
| M3-7 | Compare the fingerprint in the header on both ends of the DM | Both ends show the identical 8×4 (128-bit) fingerprint for the same peer | | |
| M3-8 | Tab B types in the DM while tab A watches | A shows "zorro-bravo está escribiendo…" in the DM view only; it disappears 4 s after B stops; the shared room's typing line is unaffected | | |
| M3-9 | With tab A in another view (or another room), tab B sends a DM | A's sidebar "Mensajes directos" section shows the channel with an unread badge; opening it clears the badge and shows the history | | |
| M3-10 | Close tab B entirely (peer leaves the last shared room) | Tab A's DM header and composer switch to "El par se ha desconectado"; the composer (textarea + Enviar) is disabled; the history remains visible in memory | | |
| M3-11 | While disconnected, try to type/send in the DM | Input and button are blocked; sending is impossible until the peer re-joins a shared room (then the header returns to "1 par") | | |
| M3-12 | With the tab hidden (background) and permission already granted, receive a DM | An OS notification "gritos — DM de <nick>" with body "<nick>: <text>" appears; clicking it focuses the tab and opens that DM view (no permission prompt is ever shown in M3) | | |
| M3-13 | Send a DM of more than 4000 characters | The composer counter appears from 3800 and sending stays blocked above 4000; nothing is sent | | |
| M4-1 | Open the join popover in 2 tabs, tick "sala cifrada", join the same room with the same password | Both fields appear with the hint "Quien no tenga la contraseña no encontrará esta sala."; both tabs find each other: status "Canal P2P establecido · 1 pares", the other peer listed with nickname and fingerprint | | |
| M4-2 | With both tabs connected, inspect a sent room message in DevTools (Network/WS or WebRTC inspector) | The `chat` envelope shows `enc: true`, a base64 `iv` and an illegible base64 `body` — the plaintext is nowhere in the payload; the receiving tab shows the normal message | | |
| M4-3 | Join the same room name WITHOUT the password (or with a wrong one) in a third tab | The room stays "Buscando pares en la red torrent…" (it never sees the other peers); after the ~15 s heuristic it shows "No se ha encontrado la sala #nombre con esa contraseña" | | |
| M4-4 | Check the header and the sidebar entry of the password room in both tabs | Both show the room as "#nombre 🔒"; public rooms show no lock | | |
| M4-5 | Reload one of the connected password-room tabs | The room is gone from Activas (nothing persisted): rejoining demands the password again (Recientes only keeps the name); the empty password toggle shows "Escribe una contraseña para la sala cifrada" | | |
| M4-6 | Search `localStorage` for the room password | No `gritos:*` key contains the password or any room key material (only settings/identity/room names/UI) | | |
| M5-1 | Click the ⚙ gear in the room (or DM) header | The settings modal opens: title "Ajustes", the nickname field on top and the three tabs "Red", "Privacidad", "Apariencia"; Tab cycles inside the modal, Esc / ✕ / backdrop click close it and focus returns to the gear | | |
| M5-2 | Toggle "Auto-unirse a #lobby al iniciar" in Red | The change persists instantly: `gritos:settings` shows `autoJoinLobby:false`; after a reload the app no longer auto-joins #lobby | | |
| M5-3 | In Red, "Añadir tracker" and type `http://bad` | Inline error "Las URLs de tracker deben empezar por wss://"; nothing is saved while invalid; typing a `wss://` URL saves it to `gritos:settings` and the error clears | | |
| M5-4 | Remove every tracker row | The hint "Lista vacía: se usan los trackers por defecto de Trystero." appears and Trystero defaults are used again on reconnect | | |
| M5-5 | Add an ICE server: keep STUN, type `stun:stun.example:19302`; then switch the row to TURN and fill usuario/contraseña | STUN saves as `{urls}`; the TURN row shows usuario + contraseña fields and saves `{urls, username, credential}`; a non `stun:`/`turn:` value shows the inline scheme error | | |
| M5-6 | Set "Límite de salas activas" to 9, then to 0 and blur | 9 shows "El límite de salas activas debe estar entre 1 y 6." and is not saved; 0 clamps to 1 on blur and persists | | |
| M5-7 | Change trackers/ICE, then click "Reconectar todo" with rooms active | Every room is left and re-joined; DevTools → Network shows the custom tracker URL used for the new connections (the note "Los cambios de red se aplican al reconectar las salas." stays visible) | | |
| M5-8 | In Privacidad with permission unrequested, look at "Notificaciones de escritorio" | Toggle disabled with "Permiso no solicitado."; click "Permitir notificaciones" → browser prompt; on grant the line becomes "Permiso concedido." and the toggle enables | | |
| M5-9 | Deny the notification permission in the browser, reopen settings | Line "Permiso denegado. Actívalo desde la configuración del navegador."; toggle and request button stay disabled | | |
| M5-10 | Click "Regenerar identidad" | Dialog warns "Se generará un nuevo par de claves: tu fingerprint cambiará y los canales DM con tus pares dejarán de coincidir. ¿Continuar?"; on Confirm the fingerprint changes everywhere, `gritos:identity` holds the new JWK pair and the connected peer sees the re-announced presence + keys | | |
| M5-11 | Cancel the regeneration dialog | Identity unchanged (fingerprint identical before/after), dialog closes, no keys re-sent | | |
| M5-12 | Change "Tu apodo" at the top of the modal to an invalid value ("a") and blur | Inline error "Usa entre 2 y 24 caracteres: letras, números, espacios, guiones y guion bajo."; identity untouched | | |
| M5-13 | Change "Tu apodo" to a valid nickname and blur | Store, header and `gritos:identity` update; connected peers see the new nickname without any reconnect (presence re-announce); the nickname survives a reload | | |
| M5-14 | Toggle "Colapsar barra lateral al iniciar" in Apariencia and reload | `gritos:ui` records `{sidebarCollapsed:true}`; after the reload the sidebar starts collapsed; theme radios Claro/Oscuro/Sistema switch the theme live without reload | | |
| M5-15 | Hide the tab (notifications on, permission granted) and receive a room message mentioning `@<own-nickname>` | OS notification "gritos — mención en #<sala>" with body "<nick>: <text>"; a message WITHOUT the mention (also wrong case/boundary variants) never notifies; visible tab or toggle off never notifies | | |
| M5-16 | Click the mention notification | The tab focuses and the app navigates to the origin room (DM notification navigates to the DM view) | | |
| M5-17 | Hide the tab and receive a DM while notifications are on | Notification "gritos — DM de <nick>" with body "<nick>: <text>"; with the toggle off or permission denied nothing fires | | |
| M5-18 | Click "Borrar todo y salir" twice (both confirmations, red buttons) | First dialog: "Se borrarán apodo, claves, ajustes y todo rastro local. ¿Continuar?"; second confirmation; on the final confirm all WebRTC connections abort, `localStorage` ends with NO `gritos:*` keys and the app reloads into the clean onboarding | | |
| M5-19 | Cancel the panic dialog at either step | Nothing is deleted: identity, settings and rooms remain intact | | |
| M5-20 | After exercising settings, identity, rooms and UI, inspect Application → Local Storage | Exactly the four keys `gritos:settings`, `gritos:identity`, `gritos:rooms`, `gritos:ui`; no message content, password or DM key material anywhere | | |
| M5-21 | Reconnect a password room after changing network settings ("Reconectar todo") | The room re-joins with the new config and chat stays encrypted end-to-end (payload still `enc:true`, illegible in DevTools) | | |
| M6-1 | Open the app with and without the `?debug` query flag | With the flag the M1 debug panel renders below the shell; without it nothing debug-related renders; no debug code paths run in normal use | | |
| M6-2 | Enter a fresh room (empty feed), with no DM channels and with `Recientes` empty | Discrete Spanish empty states: feed "Comparte el nombre de la sala para que otros se unan."; "Aún no hay mensajes directos…" under Mensajes directos; "Sin salas recientes todavía." under Recientes; Pares keeps "Sin pares aún. Comparte el nombre de la sala…" | | |
| M6-3 | Tab through onboarding → shell → sidebar → composer with the keyboard only | Every interactive element shows a visible accent focus ring (`:focus-visible`); sidebar order follows the visual order; the ✕ leave button becomes visible when keyboard-focused | | |
| M6-4 | Inspect the feed and sidebar sections (DevTools → Elements, or with a screen reader) | Feed container is `role="log"` with `aria-live="polite"`; Activas/Sugeridas/Recientes/Pares/DMs render as semantic lists (`ul`/`li`) | | |
| M6-5 | Open and dismiss each floating surface: settings modal, confirm dialogs, join popover, peer menu, mobile drawer | Every one closes with Esc (modals also on backdrop/✕ and restore focus to the opener); the join popover dismisses on Esc | | |
| M6-6 | Check muted/accent text in BOTH themes (light `#6f6a65`, dark `#a8a29e` tokens) | Muted text ≥ 4.5:1 (light ≈ 5.1:1 on bg/surface, dark ≈ 6.9:1); accent error text ≥ 4.5:1 in both themes | | |
| M6-7 | At a ≤768 px viewport (e.g. 375×667): open/close the drawer, send a message, open a DM | Sidebar is an overlay drawer with backdrop (backdrop click, Esc, room selection close it); composer fully usable; header compact with ☰ and ⚙ reachable | | |
| M6-8 | Busy room (~15 peers, long history): watch rendering while messages append | Only the new message row re-renders (MessageItem memoized with stable props; no per-row store subscriptions); interaction stays smooth | | |
| M6-9 | `npm run build && npm run preview`, open the page and watch the console | CSP meta present; ZERO CSP violations reported; the anti-flash theme script still applies the persisted theme (hash-pinned inline script); title "gritos — chat p2p sin servidor" and `color-scheme` meta present (verified in Chromium 143 headless: 0 console messages, 0 violations) | | |
| M6-10 | Force the tracker-error state (block wss:// traffic / offline after join) in any active room | Non-blocking banner at the top of the chat area: "Sin acceso a trackers — revisa tu conexión o configura trackers alternativos" with "Abrir ajustes" (opens Ajustes on the Red tab) and a ✕ dismiss; the banner returns when ANOTHER room errors or the same room errors again after recovering | | |
| M6-11 | Run the whole M6 full pass below against the PRODUCTION build served by `npm run preview` | Everything below behaves identically on the bundle in `dist/` | | |

## M6 full pass — master checklist (plan §7)

Consolidated acceptance checklist for v1.0.0. Execute in ≥2 tabs (two peer
pairs); where noted, in 2 different browsers (e.g. Chrome + Firefox). Items
not executed automatically are left unchecked for the release manager.

| # | Check | Pass/Fail | Browser(s) |
|---|-------|-----------|------------|
| 1 | First visit → onboarding → auto-join `#lobby` (with and without `autoJoinLobby`) | | |
| 2 | 2 tabs in `#lobby`: mutual presence, latency dots, `connected` status | | |
| 3 | Message with the full Markdown subset + mention renders correctly on the receiver | | |
| 4 | Typing indicator visible; expires after 4 s | | |
| 5 | Receipts ✓ → ✓✓ | | |
| 6 | Scroll: long history, auto-scroll only near bottom, "N mensajes nuevos" button | | |
| 7 | 3 simultaneous active rooms (cap 4): cross-room messages, per-room unread, view switching without reconnects | | |
| 8 | Joining a 5th room is rejected with the exact cap message | | |
| 9 | E2EE DM between 2 tabs; a third tab cannot decrypt | | |
| 10 | Fingerprint identical on both ends of the DM | | |
| 11 | Password room: 2 clients join, ciphertext illegible in DevTools, third client cannot find the room | | |
| 12 | Reload in a password room asks for the password again | | |
| 13 | Custom trackers visible on reconnect (DevTools → Network); custom STUN applied (about:webrtc / chrome://webrtc-internals) | | |
| 14 | Mention and DM notifications with hidden tab; click focuses and navigates to the origin | | |
| 15 | Light/dark/system theme switches live, no flash on load | | |
| 16 | Panic button empties `localStorage` and lands on the clean onboarding | | |
| 17 | Regenerating the identity changes the fingerprint and re-announces it | | |
| 18 | Abrupt tab close: the rest mark it disconnected in <10 s | | |
| 19 | Mobile (viewport ≤768 px): drawer, message sending, DM | | |
| 20 | `npm run build` + `preview`: all of the above against the production bundle | | |
