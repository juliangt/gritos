import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import spec from '../docs/spec.md?raw'
import { DM_DISCONNECTED_TEXT } from '../src/lib/feed'

/**
 * Release guard for issue #105 (global DM signaling channel: fingerprint
 * knocks without a shared room) — pins the §12.5 design note as the BINDING
 * CONTRACT that phases 2–4 implemented, mirroring the §12.2/§12.4 precedent:
 *
 *  1. the §12.5 subsection heading exists, is marked IMPLEMENTED, and the
 *     §12 roadmap item 3 carries its shipped summary,
 *  2. the single home of the constants and the well-known swarm name
 *     (`SIGNAL_ROOM_NAME = '_gritos/senal/v1'` → deriveSignalRoomId()),
 *     with the #90 appId-namespace citation,
 *  3. the three signal actions and their exact envelopes (knock directed,
 *     no content field beyond the optional ≤140 note; whoami; knock-ack
 *     with the acknowledged fingerprint) — documented both in §12.5 and as
 *     §7.1 table rows scoped to the signal swarm,
 *  4. the caps the spec fixes: presence 100 LRU, 5 knocks/min/peer,
 *  5. the lifecycle contract: Settings.globalDm default false riding
 *     gritos:settings, and teardown of ALL in-memory swarm state plus any
 *     DM channel backed by the swarm on toggle-off,
 *  6. the DmTransport abstraction (one interface, room-backed and
 *     signal-backed feed the same DmChannel slice, v2 key derivation
 *     unchanged),
 *  7. the §9.5 addition (joining exposes IP + fingerprint + nickname to
 *     every opted-in peer; default-off is the mitigation; knocks reveal the
 *     knocker's interest),
 *  8. the phase 3 contact flow: `#contacto=<fp>` deep link (same
 *     discipline as `#sala=`), the exact consent card, rejected senders not
 *     remembered, the mute gate before parsing, and the «(global)» DmList
 *     marker,
 *  9. mixed-version: the swarm is unreachable for old builds (they never
 *     join); unknown actions resolve per the §12.3 spike,
 * 10. the §8.1 state model: Settings.globalDm, the additive DmChannel
 *     `global?` marker, the fp-keyed `dms` key space and the memory-only
 *     presence/knock state (five-key invariant intact),
 * 11. the phase 4 user docs: the README feature bullet + softened
 *     limitation 7 + security-model disclosure, and the QA-105 manual
 *     matrix in docs/qa-checklist.md.
 *
 * The docs are read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so assertions run against the
 * exact bytes on disk.
 */

describe('global signal channel design note (issue #105)', () => {
  it('adds the §12.5 design note and its §12 roadmap reference', () => {
    expect(spec).toContain(
      '### 12.5 Design note: global signaling channel — fingerprint knocks (issue #105)',
    )
    expect(spec).toContain('design note in 12.5')
  })

  it('pins the single home of the constants and the well-known swarm name', () => {
    expect(spec).toContain('`lib/p2p/signalChannelConstants.ts`')
    expect(spec).toContain("SIGNAL_ROOM_NAME = '_gritos/senal/v1'")
    expect(spec).toContain('deriveSignalRoomId()')
    expect(spec).toContain('deriveRoomId(SIGNAL_ROOM_NAME)')
  })

  it('cites the #90 appId namespace as the swarm scoping', () => {
    expect(spec).toContain('`VITE_TRYSTERO_APP_ID` (issue #90; 9.4)')
  })

  it('pins the three signal actions with their exact envelopes', () => {
    expect(spec).toContain("`knock {type:'knock', from:{fp, nick}, note?}`")
    expect(spec).toContain('`knock-ack {accept, fp}`')
    expect(spec).toContain('`whoami {nick, fp}`')
    expect(spec).toContain('No content field')
    expect(spec).toContain('`keys` / `ephkeys`')
  })

  it('pins the payload validation contract (parseReact/parseHistReq discipline)', () => {
    expect(spec).toContain('`parseKnock`')
    expect(spec).toContain('`parseWhoami`')
    expect(spec).toContain('`parseKnockAck`')
    expect(spec).toContain('discards the ENTIRE payload silently')
    expect(spec).toContain('NOTE_MAX_LENGTH')
  })

  it('pins the caps: presence 100 LRU and 5 knocks per peer per minute', () => {
    expect(spec).toContain('MAX_SIGNAL_PRESENCE = 100')
    expect(spec).toContain('KNOCK_RATE_CAP = 5')
    expect(spec).toContain('LRU eviction')
  })

  it('pins the default-off lifecycle bound to Settings.globalDm', () => {
    expect(spec).toContain('`Settings.globalDm: boolean`')
    expect(spec).toContain('**default false**')
    expect(spec).toContain('`gritos:settings`')
  })

  it('pins the teardown contract: leaving destroys swarm state and signal-backed DMs', () => {
    expect(spec).toContain('any DM channel backed by it')
    expect(spec).toContain(`"${DM_DISCONNECTED_TEXT}"`)
  })

  it('pins the DmTransport abstraction (one interface, same DmChannel slice)', () => {
    expect(spec).toContain('DmTransport')
    expect(spec).toContain('feed the SAME `DmChannel` slice')
    expect(spec).toContain('the v2 derivation UNCHANGED (9.2)')
  })

  it('pins the §9.5 addition: exposure, default-off mitigation, knock interest', () => {
    expect(spec).toContain('Global signaling channel exposure (issue #105, 12.5)')
    expect(spec).toContain('every opt-in peer sees your IP')
    expect(spec).toContain('off by default')
    expect(spec).toContain("reveals the knocker's interest")
  })

  it('pins the #contacto deep-link parameter and its parse rules', () => {
    expect(spec).toContain('`#contacto=<fp>`')
    expect(spec).toContain('SAME discipline as `#sala=`')
    expect(spec).toContain('does not canonicalize to 32 hex does not route')
  })

  it('pins the exact consent card of the contact flow', () => {
    expect(spec).toContain('"@nick wants to open a DM with you — [Accept] [Decline] [Mute]"')
  })

  it('pins rejected senders not remembered and the mute gate before parsing', () => {
    expect(spec).toContain('does not remember the rejected sender')
    expect(spec).toContain('is discarded before parsing')
  })

  it('pins the (global) DmList marker next to the manual (sin sala) precedent', () => {
    expect(spec).toContain('"(global)"')
    expect(spec).toContain('"(no room)"')
  })

  it('pins the mixed-version stance: old peers never join; §12.3 spike applies', () => {
    expect(spec).toContain('never joins')
    expect(spec).toContain("the 12.3 spike's conclusion")
  })

  it('flips the §12.5 status to implemented with the shipped homes', () => {
    expect(spec).toContain('**Status: implemented (issue #105).**')
    expect(spec).toContain('the swarm manager in `lib/p2p/signalChannel.ts`')
    expect(spec).toContain('the `DmTransport` interface in `lib/p2p/dmTransport.ts`')
    expect(spec).toContain('the "+ contact" entry of `DmList`')
    expect(spec).toContain('"My contact"')
    expect(spec).toContain('"Contact by fingerprint"')
  })

  it('pins the four ambiguities the implementation resolved', () => {
    // (1) fp-keyed channels in the SAME dms slice with the additive marker.
    expect(spec).toContain(
      'the SAME `dms` slice of the store (8.1) keyed by the canonical fingerprint with the additive `global: true` marker',
    )
    expect(spec).toContain('Trystero peerIds of ~46 characters versus 32 hex')
    // (2) pins only for OPENED channels: presence never writes gritos:tofu —
    // the swarm cannot become a persisted stranger directory.
    expect(spec).toContain('the TOFU pins (8.2) are only written when a channel is OPENED')
    expect(spec).toContain('presence alone never touches `gritos:tofu`')
    // (3) non-blocking consent cards (a status strip, never a modal).
    expect(spec).toContain('the consent cards are NON-blocking')
    // (4) the onKnockResolved seam limitation: resolves once per acked
    // knock, after the channel opens; unanswered knocks never resolve.
    expect(spec).toContain('the `onKnockResolved` seam resolves ONCE per acknowledged knock')
    expect(spec).toContain('no wire timeout')
  })

  it('documents the three signal actions as §7.1 rows scoped to the signal swarm', () => {
    expect(spec).toContain(
      'The three actions of the global signal channel (issue #105: `whoami`, `knock`, `knock-ack`) are listed here for completeness',
    )
    expect(spec).toContain(
      'the global signal swarm (12.5), not the room ones: broadcast on connect and on nickname change',
    )
    expect(spec).toContain(
      'directed at the destination peer INSIDE the global signal swarm (`target`; 12.5)',
    )
    expect(spec).toContain('directed back at the knocker (`target`; 12.5)')
    // The rows carry the caps and the mute gate.
    expect(spec).toContain('mute gate BEFORE parsing')
    expect(spec).toContain('a cap of `KNOCK_RATE_CAP = 5` RECEIVED knocks per peer per minute')
  })

  it('pins the §8.1 state model: globalDm, the global? marker, memory-only swarm state', () => {
    expect(spec).toContain('globalDm: boolean // issue #105')
    expect(spec).toContain('global?: boolean // issue #105')
    expect(spec).toContain(
      'key: peerId (room channels) | canonical fingerprint (global channels, 12.5 — disjoint namespaces)',
    )
    expect(spec).toContain(
      'Global signal channel (issue #105, 12.5): the channels backed by it live in THIS `dms` slice',
    )
    expect(spec).toContain('the five-`gritos:*`-keys invariant (8.2) stays intact')
    expect(spec).toContain(
      'the TOFU pins of the peers with an OPEN channel (8.2, under their canonical fingerprint',
    )
  })

  it('marks §12 roadmap item 3 implemented and un-stales item 8', () => {
    expect(spec).toContain(
      '3. Global DM channel (a dedicated signaling room) for DMs with no shared room (issue #105; design note in 12.5): **implemented**',
    )
    expect(spec).toContain('a fingerprint-keyed channel marked "(global)" in DmList')
    expect(spec).toContain(
      'complementary to item 3 (the global signaling channel), also already implemented',
    )
    // §11 limitation 7 names both softening paths.
    expect(spec).toContain('except for two deliberate paths')
  })

  it('adds the README feature bullet with the disclosed exposure and (global) marker', () => {
    expect(readme).toContain('Global DMs by fingerprint knock (issue #105, opt-in)')
    expect(readme).toContain('"Global DM channel" (Settings → Privacy, **off by default**')
    expect(readme).toContain(
      'joining exposes your IP, fingerprint and nickname to every opted-in peer',
    )
    expect(readme).toContain('shows the "(global)" marker in the sidebar')
    expect(readme).toContain('never a browsable directory')
  })

  it('softens README limitation 7 with the second path', () => {
    expect(readme).toContain('two deliberate, non-automatic paths soften it')
    expect(readme).toContain('the opt-in global channel (issue #105)')
    expect(readme).toContain('knock each other by fingerprint across the shared signaling swarm')
  })

  it('discloses the swarm exposure in the README security model', () => {
    expect(readme).toContain(
      'The opt-in global DM channel (issue #105) widens the exposure honestly',
    )
    expect(readme).toContain("a knock reveals the knocker's interest in the target fingerprint")
    expect(readme).toContain(
      'the swarm never carries message content, only presence, knocks and key announces',
    )
  })

  it('ships the QA-105 manual matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #105 — global DM signaling')
    for (let i = 1; i <= 10; i += 1) {
      expect(qaChecklist).toContain(`| QA-105-${i} `)
    }
    // Toggle off (default) → no signal connection.
    expect(qaChecklist).toContain('No connection attempt toward the signal swarm')
    // Knock + accept with no shared room → E2EE DM.
    expect(qaChecklist).toContain(
      'although the tabs share no room — the channel rides the global swarm',
    )
    // Presence exposes only nick + fp.
    expect(qaChecklist).toContain(
      'Presence exposes exactly the nickname and the canonical 32-hex fingerprint',
    )
    // Knock spam rate-capped; mute silences knockers before parsing.
    expect(qaChecklist).toContain('per-peer cap of 5 knocks/min')
    expect(qaChecklist).toContain("a muted sender's knock drops BEFORE any parsing or budget")
    // Reject not remembered (per-session).
    expect(qaChecklist).toContain('FORGOT the sender — no contact store, no persistent block')
    // Toggle off → swarm left + channels disconnected; panic wipes.
    expect(qaChecklist).toContain('A leaves the swarm at once')
    expect(qaChecklist).toContain('the settings reset tears the swarm down')
    // Room DMs unaffected; the (global) DmList marker.
    expect(qaChecklist).toContain('room discovery and room DMs unaffected')
    expect(qaChecklist).toContain('the global channel shows its "(global)" marker')
  })
})
