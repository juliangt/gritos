import { useCallback, useEffect, useState } from 'react'
import {
  acceptFileTransfer,
  cancelFileTransfer,
  declineFileTransfer,
  getFileTransfers,
  onFileAbort,
  onFileDone,
  onFileFailed,
  onFileOffer,
  onFileProgress,
  revokeTransferUrl,
  sendFileTransfer,
  type FileTransferRecord,
  type SendFileOutcome,
} from '../lib/p2p/fileTransfer'
import { sendDmFileTransfer } from '../lib/p2p/roomManager'

/**
 * Issue #103 phase 4 — the React bridge to the file-transfer engine's §12.4
 * state, mirroring the listener-hook precedents (useLatency's onPong): the
 * hook subscribes the engine seams at mount and re-renders from fresh
 * `getFileTransfers()` snapshots. The engine's module map stays the ONLY
 * owner of the records, the blobs and their URLs (§12.4: the FIFO cap and
 * the TTL sweep govern messages and never touch a transfer); this hook is
 * memory-only view state — no store, no persistence, everything dies with
 * the tab.
 *
 * The sync is MODULE-wide on purpose: several hook instances are alive at
 * once (the cards area in ChatLayout AND the pre-send dialog in ChatInput)
 * and several state changes fire NO engine seam — an outgoing offer is
 * created silently by `sendFileTransfer`, an accept flips the record before
 * the first chunk, a dismissal revokes quietly — so every mutation and every
 * seam notifies ALL instances and each renders the honest state at once.
 * The per-chunk progress storm coalesces through requestAnimationFrame;
 * structural events sync immediately.
 *
 * Scope of a card (the engine record carries roomId + peerId but not the
 * conversation kind — the wire cannot distinguish a password-room transfer
 * from a DM transfer, §12.4): outgoing transfers sent in DM kind are
 * remembered in a module-level key set (pruned on every sync; keys embed a
 * UUID, so entries cannot collide across sessions) so the room view can
 * hide them; everything else renders wherever its roomId (room view) or
 * peerId (DM view) matches. Only one view is active at a time, so a
 * transfer never renders twice.
 */

/** Transfer keys sent through sendDmFile — hidden from room-view scoping. */
const dmKindKeys = new Set<string>()

/** Per-instance notify callbacks — every mutation fans out to all of them. */
const subscribers = new Set<() => void>()

let rafPending = false

function pruneDmKindKeys(): void {
  const live = getFileTransfers()
  for (const key of dmKindKeys) {
    if (live[key] === undefined) dmKindKeys.delete(key)
  }
}

function syncAll(): void {
  pruneDmKindKeys()
  for (const notify of subscribers) notify()
}

/** Coalesced sync for the per-chunk progress storm. */
function syncCoalesced(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    syncAll()
  })
}

export interface UseFileTransfersApi {
  /** Snapshot of every live transfer record, keyed `${peerId}:${meta.id}`. */
  transfers: Record<string, FileTransferRecord>
  /** Records visible in a room view: its swarm, minus DM-kind sends. */
  visibleInRoom(roomId: string): FileTransferRecord[]
  /** Records visible in a DM view: everything with that peer. */
  visibleWithPeer(peerId: string): FileTransferRecord[]
  /** Room-mode send (public room → DTLS-only, password room → room key). */
  sendRoomFile(roomId: string, peerId: string, file: File): Promise<SendFileOutcome>
  /** DM-mode send: always sealed with the DM key, riding the shared room. */
  sendDmFile(peerId: string, file: File): Promise<SendFileOutcome>
  /** Receiver consent — grants the first credit window (bytes may flow). */
  accept(key: string): void
  /** Receiver decline — refuses the offer before any byte (§12.4). */
  decline(key: string): void
  /** Local cancel, either role, any active state (file-abort to the peer). */
  cancel(key: string): void
  /** Card dismissal of a terminal record; revokes its URL (§12.4). */
  dismiss(key: string): void
}

export function useFileTransfers(): UseFileTransfersApi {
  const [transfers, setTransfers] = useState<Record<string, FileTransferRecord>>(getFileTransfers)

  useEffect(() => {
    const notify = () => setTransfers(getFileTransfers())
    subscribers.add(notify)
    notify() // catch up with records created before this mount
    const unsubscribers = [
      onFileOffer(syncAll),
      onFileProgress(syncCoalesced),
      onFileDone(syncAll),
      onFileAbort(syncAll),
      onFileFailed(syncAll),
    ]
    return () => {
      subscribers.delete(notify)
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  const sendRoomFile = useCallback(async (roomId: string, peerId: string, file: File) => {
    const outcome = await sendFileTransfer(roomId, peerId, file, 'room')
    syncAll()
    return outcome
  }, [])

  const sendDmFile = useCallback(async (peerId: string, file: File) => {
    const outcome = await sendDmFileTransfer(peerId, file)
    if (outcome.ok) dmKindKeys.add(outcome.key)
    syncAll()
    return outcome
  }, [])

  // acceptFileTransfer flips the record synchronously before its internal
  // await, so the immediate syncAll already renders the transferring card.
  const accept = useCallback((key: string) => {
    void acceptFileTransfer(key).then(syncAll, syncAll)
    syncAll()
  }, [])

  const decline = useCallback((key: string) => {
    declineFileTransfer(key)
    syncAll()
  }, [])

  const cancel = useCallback((key: string) => {
    cancelFileTransfer(key)
    syncAll()
  }, [])

  const dismiss = useCallback((key: string) => {
    revokeTransferUrl(key)
    syncAll()
  }, [])

  const visibleInRoom = useCallback(
    (roomId: string) =>
      Object.values(transfers).filter(
        (record) => record.roomId === roomId && !dmKindKeys.has(record.key),
      ),
    [transfers],
  )

  const visibleWithPeer = useCallback(
    (peerId: string) => Object.values(transfers).filter((record) => record.peerId === peerId),
    [transfers],
  )

  return {
    transfers,
    visibleInRoom,
    visibleWithPeer,
    sendRoomFile,
    sendDmFile,
    accept,
    decline,
    cancel,
    dismiss,
  }
}
