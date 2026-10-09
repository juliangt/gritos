# Gritos — Runbook: "No tracker access"

|                |                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Audience**   | App users (one page)                                                                                                              |
| **Symptom**    | Non-blocking banner "No tracker access — check your connection or configure alternative trackers" with the "Open settings" button |
| **References** | docs/security.md "Public trackers notice" · `docs/qa-checklist.md` M6-10 · issue #51                                                        |

---

## What it means

The browser failed to reach **any** discovery tracker (the public servers that introduce peers to each other by exchanging the initial SDP _handshake_). Consequences:

- Rooms that are **already connected keep working**: messages travel over direct WebRTC channels, not through the trackers.
- **New peers** cannot be discovered: a freshly opened room stays on "Searching for peers on the torrent network…" indefinitely.

The notice is fired by a heuristic (an active room with no peers and no signals for ~15 s), not by an exact network diagnosis: it can appear without a real failure and be slow to appear if the network drops mid-way. It degrades gracefully: it never blocks the app nor disconnects anyone.

## First checks

1. **General connectivity**: does another tab load? Do you have WiFi or mobile data?
2. **Firewall or corporate/school network**: trackers speak `wss://` (encrypted WebSocket, port 443). Some networks filter WebSockets or any domain outside their proxy. Try another network (e.g. mobile data).
3. **VPN or ISP**: some providers, VPNs or parental filters block _torrent_ traffic in general, WebSocket trackers included. Try disabling the VPN or switching nodes.

## Self-help: alternative trackers

1. Open **Settings → Network** (or press "Open settings" on the banner itself).
2. Under "Add tracker", add one or more working `wss://` URLs (your own if you have them; only URLs starting with `wss://` are accepted).
3. Press **Reconnect all**: network changes are not applied until the active rooms reconnect.
4. If you leave the list **empty**, Trystero's default trackers are used again (the five embedded in each release; they are listed in docs/security.md, section "Public trackers notice").

## What you cannot fix yourself

- The default list **ships inside the release**: if the embedded trackers cease to exist, no local configuration resurrects them. Open an issue in the repository — the Dependabot PR that bumps `@trystero-p2p/torrent` is the natural checkpoint to review and renew the list.
- There is no hidden "backup" tracker: without reachable trackers there is no discovery. The app endures it (the heuristic and the banner degrade gracefully) and the already-connected peers are not lost because of it.

## The zero-infrastructure path: DM via manual invite

Without trackers there is no discovery, but a 1:1 DM is still possible: the manual invite wizard — "+ invite" in the direct-messages section, or the shortcut on the banner itself ("or connect without trackers") — establishes a direct channel by exchanging two invite blobs copy/paste with the other person, over whatever channel you already share (email, another messenger…). It is signaling with literally zero infrastructure: neither trackers nor a server take part in the handshake, and the encryption and the fingerprint verification are the same as in any DM (spec §12.2).

## Reminder

The real P2P traffic (messages, DMs, presence) **never passes through the trackers**: only the initial discovery and the SDP exchange do. With the room already connected you can keep chatting even if every tracker falls at once.
