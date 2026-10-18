import { describe, expect, it } from 'vitest'
import { defaultRelayUrls } from '@trystero-p2p/nostr'
import security from '../docs/security.md?raw'
import runbook from '../docs/runbook-trackers.md?raw'

/**
 * Release guard for issues #51/#132 (the app's first-run discovery depends
 * entirely on the Nostr relays baked into the pinned `@trystero-p2p/nostr`,
 * yet the effective default list was neither documented nor covered by a
 * runbook). Keeps both from silently regressing:
 *
 *  1. the security reference's "Public relay notice" section documents the
 *     effective default relay list (the `wss://` URLs in Trystero 0.25.4's
 *     `defaultRelayUrls`), and
 *  2. `docs/runbook-trackers.md` exists and names the tracker-error banner.
 *
 * Both files are read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk. Drift guard: the library's `defaultRelayUrls` is
 * imported directly (the roomManager.test.ts pattern), so a dependency bump
 * that changes the relay list fails this suite until the documentation
 * catches up — the Dependabot PR is the checkpoint to re-derive the list
 * from `defaultRelayUrls` in `@trystero-p2p/nostr/dist/index.mjs`.
 */
const issueDefaultRelays = [
  'wss://basspistol.org',
  'wss://bucket.coracle.social',
  'wss://chorus.pjv.me',
  'wss://koru.bitcointxoko.org',
  'wss://nos.lol',
  'wss://nostr-01.uid.ovh',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-relay.corb.net',
  'wss://nostr.data.haus',
  'wss://nostr.islandarea.net',
  'wss://nostr.sathoarder.com',
  'wss://nostr.tegila.com.br',
  'wss://nostr.vulpem.com',
  'wss://purplerelay.com',
  'wss://relay-can.zombi.cloudrodion.com',
  'wss://relay-rpi.edufeed.org',
  'wss://relay.agorist.space',
  'wss://relay.artio.inf.unibe.ch',
  'wss://relay.mostr.pub',
  'wss://relay.mostro.network',
  'wss://relay.sigit.io',
  'wss://relay02.lnfi.network',
  'wss://schnorr.me',
  'wss://social.amanah.eblessing.co',
  'wss://staging.yabu.me',
  'wss://strfry.shock.network',
  'wss://top.testrelay.top',
  'wss://yabu.me/v2',
]

describe('tracker documentation (issues #51/#132)', () => {
  it('documents the relay defaults under the security reference "Public relay notice" section', () => {
    expect(security).toContain('## Public relay notice')
    expect(issueDefaultRelays.filter((url) => security.includes(url))).not.toHaveLength(0)
  })

  it('lists every effective default relay in effect', () => {
    for (const url of issueDefaultRelays) {
      expect(security).toContain(url)
    }
  })

  it('keeps the documented list in lockstep with the library defaults (drift guard)', () => {
    // A Dependabot bump that adds, removes or reorders the library's relays
    // must surface here AND in the docs: the static list above matches the
    // imported `defaultRelayUrls` exactly, and every library default is
    // documented in the security reference.
    expect(issueDefaultRelays).toEqual(defaultRelayUrls)
    for (const url of defaultRelayUrls) {
      expect(security).toContain(url)
    }
  })

  it('documents no relay URLs beyond the library defaults (reverse drift)', () => {
    // Scoped to the defaults bullet list — the only place security.md
    // enumerates relay URLs as `- `wss://…`` lines — so a hand-added URL
    // cannot masquerade as a library default.
    const documented = [...security.matchAll(/^- `(wss:\/\/[^`]+)`$/gm)].map(
      (match) => match[1],
    )
    expect(documented.length).toBeGreaterThan(0)
    for (const url of documented) {
      expect(defaultRelayUrls).toContain(url)
    }
    expect(documented).toHaveLength(defaultRelayUrls.length)
  })

  it('ships the tracker runbook at docs/runbook-trackers.md', () => {
    expect(runbook.length).toBeGreaterThan(0)
  })

  it('runbook names the tracker-error banner', () => {
    expect(runbook).toContain('No tracker access')
  })

  it('runbook pins the socket-check mechanism behind the notice (issue #125)', () => {
    // The banner fires only when an expiry finds NO open relay socket; the
    // empty-room and re-arm halves of that contract are both pinned, and the
    // pre-#125 "no peers and no signals" wording stays dead.
    expect(runbook).toContain('each expiry consults the live tracker sockets (issue #125)')
    expect(runbook).toContain('no tracker socket open')
    expect(runbook).toContain('Still waiting for peers — the room may be empty')
    expect(runbook).toContain('re-arms every ~15 s')
    expect(runbook).not.toContain('no peers and no signals')
  })

  it('runbook quotes the current searching status and points at the relay notice', () => {
    expect(runbook).toContain('Searching for peers on Nostr relays…')
    expect(runbook).toContain('Public relay notice')
    expect(runbook).not.toContain('Searching for peers on the torrent network')
  })
})
