import { useMemo } from 'react'
import type { Peer } from '../stores/useAppStore'
import { useAppStore } from '../stores/useAppStore'

/**
 * Mention candidates for a room (RF-03): the user's own nickname plus the
 * nicknames of the peers currently present. Empty nicknames are dropped.
 */
export function useMentionCandidates(peers: readonly Peer[]): readonly string[] {
  const ownNickname = useAppStore((state) => state.identity?.nickname ?? '')
  return useMemo(
    () => [ownNickname, ...peers.map((peer) => peer.nickname)].filter((nick) => nick !== ''),
    [ownNickname, peers],
  )
}
