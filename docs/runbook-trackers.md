# Gritos — Runbook: "No tracker access"

|                |                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Audience**   | App users (one page)                                                                                                              |
| **Symptom**    | Non-blocking banner "No tracker access — check your connection or configure alternative trackers" with the "Open settings" button |
| **References** | docs/security.md "Public relay notice" · `docs/qa-checklist.md` M6-10 · issues #51/#132                                                      |

---

## What it means

The browser failed to reach **any** discovery relay (the public Nostr servers that introduce peers to each other by exchanging the initial SDP _handshake_ over NIP-01). Consequences:

- Rooms that are **already connected keep working**: messages travel over direct WebRTC channels, not through the relays.
- **New peers** cannot be discovered: a room left searching never finds anyone, and once a ~15 s expiry finds no tracker socket open it shows the error banner below.

The notice is not a blind timer: the heuristic behind it re-arms every ~15 s while a room searches, and each expiry consults the live tracker sockets (issue #125). It fires only when an expiry finds **no tracker socket open** — a real outage, not a quiet room. An empty room over healthy relays is signaling, not breakage: it stays on "Searching for peers on Nostr relays…" (the re-armed check still catches a network that drops later, within ~15 s of the drop) and the header adds the subtle hint "Still waiting for peers — the room may be empty" instead of the error. It degrades gracefully: it never blocks the app nor disconnects anyone.

## First checks

1. **General connectivity**: does another tab load? Do you have WiFi or mobile data?
2. **Firewall or corporate/school network**: relays speak `wss://` (encrypted WebSocket, port 443). Some networks filter WebSockets or any domain outside their proxy. Try another network (e.g. mobile data).
3. **VPN or ISP**: some providers, VPNs or parental filters block WebSocket traffic in general or known Nostr relay domains. Try disabling the VPN or switching nodes.

## Health check: is a relay alive?

Any relay can be probed by hand with [wscat](https://github.com/websockets/wscat) (`npm install -g wscat`, or run it once with `npx wscat`):

```
wscat -c wss://<relay>
```

Once connected, send the Nostr NIP-01 subscription frame:

```
["REQ", "test", {"kinds": [1], "limit": 1}]
```

A healthy relay answers with at least an `["EOSE", "test"]` frame — the requested events themselves are optional (a quiet relay may have nothing to send), but the EOSE closes the subscription and proves the relay speaks NIP-01. No answer, an error frame or an immediately closed socket means that relay is not usable for signaling right now: try another one from the default list (docs/security.md, "Public relay notice") or configure your own.

## Self-help: alternative relays

1. Open **Settings → Network** (or press "Open settings" on the banner itself).
2. Under "Add tracker", add one or more working `wss://` relay URLs (your own if you have them; only URLs starting with `wss://` are accepted).
3. Press **Reconnect all**: network changes are not applied until the active rooms reconnect.
4. If you leave the list **empty**, Trystero's default relays are used again (the ones embedded in each release; they are listed in docs/security.md, section "Public relay notice").

## What you cannot fix yourself

- The default list **ships inside the release**: if the embedded relays cease to exist, no local configuration resurrects them. Open an issue in the repository — the Dependabot PR that bumps `@trystero-p2p/nostr` is the natural checkpoint to review and renew the list.
- There is no hidden "backup" relay: without reachable relays there is no discovery. The app endures it (the heuristic and the banner degrade gracefully) and the already-connected peers are not lost because of it.

## The zero-infrastructure path: DM via manual invite

Without trackers there is no discovery, but a 1:1 DM is still possible: the manual invite wizard — "+ invite" in the direct-messages section, or the shortcut on the banner itself ("or connect without trackers") — establishes a direct channel by exchanging two invite blobs copy/paste with the other person, over whatever channel you already share (email, another messenger…). It is signaling with literally zero infrastructure: neither trackers nor a server take part in the handshake, and the encryption and the fingerprint verification are the same as in any DM (spec §12.2).

## Reminder

The real P2P traffic (messages, DMs, presence) **never passes through the relays**: only the initial discovery and the SDP exchange do. With the room already connected you can keep chatting even if every relay falls at once.
