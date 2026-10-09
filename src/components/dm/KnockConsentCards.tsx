import { useEffect, useState } from 'react'
import { acceptKnock, getPendingKnocks, onKnock, rejectKnock } from '../../lib/p2p/signalChannel'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  KNOCK_ACCEPT_BUTTON,
  KNOCK_CARDS_REGION_LABEL,
  KNOCK_MUTE_BUTTON,
  KNOCK_NOTE_PREFIX,
  KNOCK_REJECT_BUTTON,
  knockCardLabel,
  knockConsentText,
} from '../settings/messages'

/**
 * Issue #105 phase 3 (spec §12.5) — the inbound-knock consent cards: one
 * non-blocking card per sender, rendered at the top of the chat area so the
 * request is answerable wherever the user is (the issue's "@nick wants to
 * open a DM with you — [Accept] [Decline] [Mute]"). Inline cards
 * rather than a Modal on purpose: knocks are session-only, may queue (one
 * card per DISTINCT sender fingerprint, stacked; the manager already
 * collapses re-knocks from the same sender to the latest), and must never
 * trap the user inside a dialog a spammer can open — the manager's rate cap
 * (5/min/peer) and the mute gate are the spam mitigation, the card stays a
 * status region (role="status", politely announced), not a focus trap.
 *
 * Actions: [Accept] answers knock-ack(true) and opens the DM view (the
 * manager opens the «(global)» channel on both sides' convention); [Decline]
 * answers knock-ack(false) and forgets the sender (per-session state, no
 * contact store); [Mute] rejects AND persists the fingerprint into the
 * issue #95 mute list, whose gate drops every future knock from that sender
 * before any parse — the card simply never appears again.
 *
 * Cards render ONLY while `Settings.globalDm` is on: flipping it off tears
 * the swarm down (the manager drops every inbound knock) and this clears the
 * displayed cards in the same breath.
 */

/** One displayed knock (the manager's validated, mute-gated payload). */
interface CardKnock {
  readonly fp: string
  readonly nick: string
  readonly note?: string
}

export function KnockConsentCards() {
  const globalDm = useSettingsStore((state) => state.settings.globalDm)
  // Seeded ONCE at mount from the manager's pending map (covers knocks that
  // landed before the mount). ChatLayout keys this component by the opt-in,
  // so an off→on flip remounts it against the freshly emptied manager state
  // instead of resurfacing stale cards.
  const [knocks, setKnocks] = useState<CardKnock[]>(() =>
    useSettingsStore.getState().settings.globalDm ? getPendingKnocks() : [],
  )

  // Live subscription while the channel is on: the manager's validated,
  // mute-gated listener is the only state writer from here on.
  useEffect(() => {
    if (!globalDm) return
    return onKnock((knock) => {
      // Latest-wins per sender, matching the manager's inboundKnocks map.
      setKnocks((current) => [...current.filter((entry) => entry.fp !== knock.fp), knock])
    })
  }, [globalDm])

  if (!globalDm || knocks.length === 0) return null

  const resolve = (fp: string) => {
    setKnocks((current) => current.filter((entry) => entry.fp !== fp))
  }

  return (
    <section
      aria-label={KNOCK_CARDS_REGION_LABEL}
      className="flex flex-col gap-2 border-b border-border bg-surface px-3 py-2"
    >
      {knocks.map((knock) => (
        <div
          key={knock.fp}
          role="status"
          aria-label={knockCardLabel(knock.nick)}
          className="flex flex-col gap-2 rounded-md border border-border bg-bg p-3"
        >
          <p className="text-sm font-medium">{knockConsentText(knock.nick)}</p>
          {knock.note !== undefined && (
            <p className="break-words text-xs text-muted">
              {KNOCK_NOTE_PREFIX}
              {knock.note}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                acceptKnock(knock.fp)
                // Land the accepted contact straight into their DM view.
                useAppStore.getState().setActiveView({ kind: 'dm', peerId: knock.fp })
                resolve(knock.fp)
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:opacity-90"
            >
              {KNOCK_ACCEPT_BUTTON}
            </button>
            <button
              type="button"
              onClick={() => {
                rejectKnock(knock.fp)
                resolve(knock.fp)
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:border-accent"
            >
              {KNOCK_REJECT_BUTTON}
            </button>
            <button
              type="button"
              onClick={() => {
                // Reject AND mute: the persistent issue #95 list silences
                // every future knock (and DM) from this fingerprint.
                rejectKnock(knock.fp)
                useSettingsStore.getState().muteFingerprint(knock.fp, knock.nick)
                resolve(knock.fp)
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:border-accent"
            >
              {KNOCK_MUTE_BUTTON}
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}
