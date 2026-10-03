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
