import { useState } from 'react'
import { loadIdentity } from '../lib/crypto/identity'
import { loadRecentRooms } from '../lib/recentRooms'
import { useAppStore } from '../stores/useAppStore'

/**
 * App boot (RF-01, §8.2): restores the persisted identity profile and the
 * recent-room names from `localStorage` into the in-memory stores, once per
 * mount, synchronously during the first render so a returning visitor never
 * flashes the onboarding screen. Messages/presence stay memory-only (D2).
 */
export function useAppBootstrap(): void {
  useState(() => {
    const app = useAppStore.getState()
    if (app.identity === null) {
      const persisted = loadIdentity()
      if (persisted !== null) {
        app.setIdentity({
          nickname: persisted.nickname,
          fingerprint: persisted.fingerprint,
          createdAt: persisted.createdAt,
        })
      }
    }
    if (app.recentRooms.length === 0) {
      const recent = loadRecentRooms()
      if (recent.length > 0) app.setRecentRooms(recent)
    }
    return true
  })
}
