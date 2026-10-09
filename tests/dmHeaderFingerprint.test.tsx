// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DmHeader } from '../src/components/dm/DmHeader'
import type { DmChannel } from '../src/stores/useAppStore'

/**
 * Issue #122 regression: the DM header must render the peer fingerprint in
 * the SAME spaced 8×4 form for every transport. The room and manual paths
 * store the spaced display string while the signal path stores the canonical
 * 32-hex one; before the fix the header printed whichever spelling it got,
 * so two private chats side by side showed the format differently.
 */

const SPACED = 'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678'

function channel(peerFingerprint: string | null): DmChannel {
  return {
    peerId: 'peer-a',
    peerNick: 'zorro-b',
    peerFingerprint,
    messages: [],
    unread: 0,
    expiredCount: 0,
    available: true,
    typing: {},
    keyChanged: false,
    legacyPeer: false,
  }
}

afterEach(() => {
  cleanup()
})

describe('DmHeader fingerprint normalization (issue #122)', () => {
  it('renders a canonical-form fingerprint as the spaced 8×4 groups', () => {
    render(<DmHeader channel={channel('a31f09bc77d24e5a51c0ffee12345678')} onToggleSidebar={() => {}} />)
    expect(screen.getByText(SPACED)).toBeInTheDocument()
  })

  it('renders a display-form fingerprint unchanged (single shared format)', () => {
    render(<DmHeader channel={channel(SPACED)} onToggleSidebar={() => {}} />)
    expect(screen.getByText(SPACED)).toBeInTheDocument()
  })

  it('keeps the em-dash placeholder when no fingerprint is known', () => {
    render(<DmHeader channel={channel(null)} onToggleSidebar={() => {}} />)
    expect(screen.getByText('— — —')).toBeInTheDocument()
  })
})
