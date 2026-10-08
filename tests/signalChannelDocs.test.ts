import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import spec from '../docs/spec.md?raw'

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

  it('flips the §12.5 status to implemented with the shipped homes', () => {
    expect(spec).toContain('**Estado: implementado (issue #105).**')
    expect(spec).toContain('el gestor del enjambre en `lib/p2p/signalChannel.ts`')
    expect(spec).toContain('la interfaz `DmTransport` en `lib/p2p/dmTransport.ts`')
    expect(spec).toContain('la entrada «+ contacto» de `DmList`')
    expect(spec).toContain('«Mi contacto»')
    expect(spec).toContain('«Contacto por huella»')
  })

  it('pins the four ambiguities the implementation resolved', () => {
    // (1) fp-keyed channels in the SAME dms slice with the additive marker.
    expect(spec).toContain(
      'la MISMA porción `dms` del store (8.1) con la huella canónica como clave y el marcador aditivo `global: true`',
    )
    expect(spec).toContain('peerIds Trystero de ~46 caracteres contra 32 hex')
    // (2) pins only for OPENED channels: presence never writes gritos:tofu —
    // the swarm cannot become a persisted stranger directory.
    expect(spec).toContain('los pins TOFU (8.2) solo se escriben al ABRIR canal')
    expect(spec).toContain('la presencia sola jamás toca `gritos:tofu`')
    // (3) non-blocking consent cards (a status strip, never a modal).
    expect(spec).toContain('las tarjetas de consentimiento son NO bloqueantes')
    // (4) the onKnockResolved seam limitation: resolves once per acked
    // knock, after the channel opens; unanswered knocks never resolve.
    expect(spec).toContain('la costura `onKnockResolved` resuelve UNA vez por golpe con acuse')
    expect(spec).toContain('sin timeout de cable')
  })

  it('documents the three signal actions as §7.1 rows scoped to the signal swarm', () => {
    expect(spec).toContain(
      'Las tres acciones del canal global de señal (issue #105: `whoami`, `knock`, `knock-ack`) se listan aquí por completitud',
    )
    expect(spec).toContain(
      'enjambre de señal global (12.5), no los de sala: difusión al conectar y al cambiar apodo',
    )
    expect(spec).toContain(
      'dirigido al par destino DENTRO del enjambre de señal global (`target`; 12.5)',
    )
    expect(spec).toContain('dirigido de vuelta al golpeador (`target`; 12.5)')
    // The rows carry the caps and the mute gate.
    expect(spec).toContain('puerta de silenciado ANTES de parsear')
    expect(spec).toContain('tope de `KNOCK_RATE_CAP = 5` golpes RECIBIDOS por par y minuto')
  })

  it('pins the §8.1 state model: globalDm, the global? marker, memory-only swarm state', () => {
    expect(spec).toContain('globalDm: boolean // issue #105')
    expect(spec).toContain('global?: boolean // issue #105')
    expect(spec).toContain(
      'key: peerId (canales de sala) | huella canónica (canales globales, 12.5 — namespaces disjuntos)',
    )
    expect(spec).toContain(
      'Canal global de señal (issue #105, 12.5): los canales respaldados por él viven en ESTA porción `dms`',
    )
    expect(spec).toContain('el invariante de las cinco claves `gritos:*` (8.2) queda intacto')
    expect(spec).toContain(
      'los pins TOFU de los pares con canal ABIERTO (8.2, bajo su huella canónica',
    )
  })

  it('marks §12 roadmap item 3 implemented and un-stales item 8', () => {
    expect(spec).toContain(
      '3. Canal global de DMs (sala de señalización dedicada) para DMs sin sala compartida (issue #105; nota de diseño en 12.5): **implementado**',
    )
    expect(spec).toContain('canal claveado por huella y marcado «(global)» en DmList')
    expect(spec).toContain(
      'complementario del ítem 3 (canal global de señalización), ya implementado este también',
    )
    // §11 limitation 7 names both softening paths.
    expect(spec).toContain('salvo dos caminos deliberados')
  })

  it('adds the README feature bullet with the disclosed exposure and (global) marker', () => {
    expect(readme).toContain('Global DMs by fingerprint knock (issue #105, opt-in)')
    expect(readme).toContain('"Canal global de DM" (Ajustes → Privacidad, **off by default**')
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
    expect(qaChecklist).toContain('the global channel shows its «(global)» marker')
  })
})
