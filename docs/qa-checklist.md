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
