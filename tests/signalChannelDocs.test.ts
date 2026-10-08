import { describe, expect, it } from 'vitest'
import spec from '../docs/spec.md?raw'

/**
 * Release guard for issue #105 phase 1 (global DM signaling channel:
 * fingerprint knocks without a shared room) — pins the §12.5 design note as
 * the BINDING CONTRACT of phases 2–4, mirroring the §12.2/§12.4 precedent:
 *
 *  1. the §12.5 subsection heading exists and the §12 roadmap item 3
 *     references it,
 *  2. the single home of the constants and the well-known swarm name
 *     (`SIGNAL_ROOM_NAME = '_gritos/senal/v1'` → deriveSignalRoomId()),
 *     with the #90 appId-namespace citation,
 *  3. the three signal actions and their exact envelopes (knock directed,
 *     no content field beyond the optional ≤140 note; whoami; knock-ack
 *     with the acknowledged fingerprint),
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
 *     join); unknown actions resolve per the §12.3 spike.
 *
 * The spec is read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so assertions run against the
 * exact bytes on disk.
 */

describe('global signal channel design note (issue #105)', () => {
  it('adds the §12.5 design note and its §12 roadmap reference', () => {
    expect(spec).toContain(
      '### 12.5 Nota de diseño: canal global de señalización — golpes por huella (issue #105)',
    )
    expect(spec).toContain('nota de diseño en 12.5')
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
    expect(spec).toContain('Sin campo de contenido')
    expect(spec).toContain('`keys` / `ephkeys`')
  })

  it('pins the payload validation contract (parseReact/parseHistReq discipline)', () => {
    expect(spec).toContain('`parseKnock`')
    expect(spec).toContain('`parseWhoami`')
    expect(spec).toContain('`parseKnockAck`')
    expect(spec).toContain('descarta el payload ENTERO y en silencio')
    expect(spec).toContain('NOTE_MAX_LENGTH')
  })

  it('pins the caps: presence 100 LRU and 5 knocks per peer per minute', () => {
    expect(spec).toContain('MAX_SIGNAL_PRESENCE = 100')
    expect(spec).toContain('KNOCK_RATE_CAP = 5')
    expect(spec).toContain('expulsión LRU')
  })

  it('pins the default-off lifecycle bound to Settings.globalDm', () => {
    expect(spec).toContain('`Settings.globalDm: boolean`')
    expect(spec).toContain('**default false**')
    expect(spec).toContain('`gritos:settings`')
  })

  it('pins the teardown contract: leaving destroys swarm state and signal-backed DMs', () => {
    expect(spec).toContain('cualquier canal DM respaldado por él')
    expect(spec).toContain('«El par se ha desconectado»')
  })

  it('pins the DmTransport abstraction (one interface, same DmChannel slice)', () => {
    expect(spec).toContain('DmTransport')
    expect(spec).toContain('alimentan la MISMA porción `DmChannel`')
    expect(spec).toContain('derivación v2 SIN cambios (9.2)')
  })

  it('pins the §9.5 addition: exposure, default-off mitigation, knock interest', () => {
    expect(spec).toContain('Exposición del canal global de señalización (issue #105, 12.5)')
    expect(spec).toContain('cada par opt-in ve tu IP')
    expect(spec).toContain('desactivado por defecto')
    expect(spec).toContain('revela además el interés del golpeador')
  })

  it('pins the #contacto deep-link parameter and its parse rules', () => {
    expect(spec).toContain('`#contacto=<fp>`')
    expect(spec).toContain('MISMA disciplina que `#sala=`')
    expect(spec).toContain('no canonicalice a 32 hex no enruta')
  })

  it('pins the exact consent card of the contact flow', () => {
    expect(spec).toContain('«@nick quiere abrir un DM contigo — [Aceptar] [Rechazar] [Silenciar]»')
  })

  it('pins rejected senders not remembered and the mute gate before parsing', () => {
    expect(spec).toContain('no recuerda al rechazado')
    expect(spec).toContain('se descarta antes de parsear')
  })

  it('pins the (global) DmList marker next to the manual (sin sala) precedent', () => {
    expect(spec).toContain('«(global)»')
    expect(spec).toContain('«(sin sala)»')
  })

  it('pins the mixed-version stance: old peers never join; §12.3 spike applies', () => {
    expect(spec).toContain('jamás se une')
    expect(spec).toContain('spike de 12.3')
  })
})
