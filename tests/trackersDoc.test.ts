import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import runbook from '../docs/runbook-trackers.md?raw'

/**
 * Release guard for issue #51 (the app's first-run discovery depends entirely
 * on the trackers baked into the pinned `@trystero-p2p/torrent`, yet the
 * effective default list was neither documented nor covered by a runbook).
 * Keeps both from silently regressing:
 *
 *  1. the README's "Public trackers notice" section documents the effective
 *     default tracker list (the five `wss://` URLs in Trystero 0.25.4's
 *     `defaultRelayUrls`), and
 *  2. `docs/runbook-trackers.md` exists and names the tracker-error banner.
 *
 * Both files are read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk. Note the README list is deliberately NOT kept in
 * sync by this test with `node_modules` — the tracked source of truth is the
 * documentation; re-verify the list against `defaultRelayUrls` in
 * `@trystero-p2p/torrent/dist/index.mjs` on every Dependabot bump.
 */
const issueDefaultTrackers = [
  'wss://open.ftorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce'
]

describe('tracker documentation (issue #51)', () => {
  it('documents the tracker defaults under the README public trackers notice', () => {
    expect(readme).toContain('## Public trackers notice')
    expect(
      issueDefaultTrackers.filter(url => readme.includes(url))
    ).not.toHaveLength(0)
  })

  it('lists all five effective default trackers in effect', () => {
    for (const url of issueDefaultTrackers) {
      expect(readme).toContain(url)
    }
  })

  it('ships the tracker runbook at docs/runbook-trackers.md', () => {
    expect(runbook.length).toBeGreaterThan(0)
  })

  it('runbook names the tracker-error banner', () => {
    expect(runbook).toContain('Sin acceso a trackers')
  })
})
