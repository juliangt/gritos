# Limitations

The known trade-offs of the model (spec §11, summarized).

1. **Full mesh:** optimal up to ~15 peers per room; beyond ~20 the mesh degrades (active rooms multiply the effect). Room (≤6) and message (500/room, FIFO) caps bound memory/CPU.
2. **Public trackers:** if they all go down, no new peers can be discovered (already-connected peers keep chatting). Alternative trackers are user-configurable.
3. **Symmetric NAT / corporate firewalls:** direct P2P may fail without a TURN server; you can configure your own STUN/TURN, but no TURN is provided.
4. **Background tabs:** deep-backgrounded tabs get throttled timers (latency dots degrade); they recover on focus.
5. **No server:** history is not kept for late joiners by default — the opt-in history gossip (issue #102) softens exactly that case: at most the last 50 in-memory messages, only when the joiner explicitly asks AND a peer has consented, with nothing persisted. Still no offline delivery and no real push (notifications only fire while a tab is open, even hidden).
6. **Multiple tabs of the same browser:** each tab is a distinct peer; you will see your own nickname duplicated with a suffix.
7. **DMs usually need a shared room:** peer discovery is tracker-based, so arbitrary DMs need a setup step — two deliberate, non-automatic paths soften it: the manual invite wizard (issue #97) is the deliberate zero-infrastructure exception (a copy/paste blob exchange), and the opt-in global channel (issue #105) is the second, where both peers flip "Global DM channel" on and can then knock each other by fingerprint across the shared signaling swarm (off by default; exposure disclosed in the [security model](security.md)).
8. **No global message ordering, nicknames are not unique:** accepted trade-offs for v1.
9. **File transfers live in RAM (issue #103):** up to 20 MB per file and 3 concurrent transfers per peer (both sides) — several at once can strain low-end devices; the size cap and the concurrency limit are the mitigations. Nothing is persisted: a reload loses every transfer (blob, URL, offer and progress), object URLs are revoked on dismissal, abort, panic and identity regeneration, and a reconnect mid-transfer fails it with no resume.
