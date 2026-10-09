import { describe, expect, it } from 'vitest'
import { en, type TranslationKey } from '../src/i18n/en'
import { es } from '../src/i18n/es'

/**
 * Issue #119 phase 4 — the Spanish review gate. The native-quality pass
 * over ./es is the deliverable; this suite pins what must never drift:
 *
 *  1. the load-bearing PRIVACY DISCLOSURES verbatim (P2P/IP exposure, the
 *     TURN storage notes, the panic final confirmation, the TOFU
 *     key-change warning, the file-encryption warnings) — a mistranslated
 *     disclosure is a privacy problem, so these are exact-text pins, not
 *     prose checks,
 *  2. the GLOSSARY invariants from the es.ts header (tracker stays the
 *     loanword, room is always «sala», knock is «solicitud de contacto»,
 *     opt-in is «activación voluntaria»), with a dictionary-wide ban on
 *     the rejected mistranslations,
 *  3. the FROZEN fragments ((no room)/(global), the 'gritos — ' prefix,
 *     the 'zorro-bravo' example) and the per-key `{placeholder}` token
 *     set — Spanish may reflow word order, never lose or retokenize a
 *     placeholder,
 *  4. register consistency: tuteo everywhere, no vosotros forms.
 *
 * The en↔es key parity and the runtime call-time liveness stay pinned by
 * tests/i18nCopy.test.ts; this file only judges the Spanish side.
 */

const keys = Object.keys(en) as TranslationKey[]

/** Every `{name}` token of a template, in order (duplicates included). */
function tokens(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
}

/** The en keys whose English copy mentions `room`/`rooms` as a word. */
const roomKeys = keys.filter((key) => /\brooms?\b/i.test(en[key]))
/** The spec-frozen literals/tokens that keep the English word in Spanish too. */
const frozenRoomKeys = new Set<TranslationKey>([
  'wizard.noRoomMarker', // the spec-frozen '(no room)' DmList marker
  'notifications.mentionTitle', // '#{room}' is a placeholder token, not prose
])

describe('placeholder tokens survive the Spanish reflow', () => {
  it('every es value carries exactly the {tokens} of its en template', () => {
    for (const key of keys) {
      expect(tokens(es[key]), `token drift on ${key}`).toEqual(tokens(en[key]))
    }
  })
})

describe('load-bearing privacy disclosures (verbatim es pins)', () => {
  it('pins the P2P/IP exposure disclosures (#35)', () => {
    expect(es['settings.p2pDisclosure']).toBe(
      'Las conexiones son P2P: quien comparta una sala contigo puede ver tu dirección IP.',
    )
    expect(es['settings.p2pIpExposureNote']).toBe(
      'Las conexiones son P2P por diseño: quien comparta una sala contigo puede ver tu dirección IP, y configurar TURN no la oculta a los pares (el navegador sigue anunciando tu dirección pública). Los operadores de trackers ven metadatos de conexión con menos detalle: tu IP, identificadores opacos e instantes de conexión.',
    )
  })

  it('pins the TURN credential storage notes (#30) and the quoted toggle self-consistency', () => {
    expect(es['settings.turnCredentialStorageHint']).toBe(
      'Las credenciales TURN se guardan sin cifrar en este navegador.',
    )
    expect(es['settings.turnCredentialMemoryHint']).toBe(
      'Las credenciales TURN se mantienen solo en memoria y se pierden al cerrar la pestaña.',
    )
    // The at-rest note quotes the Network-tab toggle verbatim: the quote
    // must track the label key, or the pointer misleads.
    expect(es['settings.turnCredentialAtRestNote']).toContain(
      `«${es['settings.rememberTurnCredentialsLabel']}»`,
    )
    expect(es['settings.turnCredentialAtRestNote']).toBe(
      'Las credenciales TURN se guardan sin cifrar en este navegador. Se configuran en la pestaña Red; desactiva allí «Recordar las credenciales TURN en este navegador» para que solo permanezcan en la memoria de la sesión.',
    )
  })

  it('pins the panic-wipe copy and its final confirmation (RF-08)', () => {
    expect(es['panic.buttonLabel']).toBe('Borrarlo todo y salir')
    expect(es['panic.lastResortNote']).toBe(
      'Último recurso: borra el apodo, las claves, los ajustes y cualquier rastro local en este navegador.',
    )
    expect(es['panic.finalDialogBody']).toBe(
      'Esta acción es definitiva: se cerrarán todas las conexiones y la aplicación se recargará para empezar de cero.',
    )
  })

  it('pins the TOFU fingerprint-change warning (#22)', () => {
    expect(es['dm.keyChangedWarning']).toBe('⚠ La huella cambió desde tu última verificación')
    expect(es['dm.keyChangedHint']).toBe(
      'El par puede haber reinstalado la aplicación o podría tratarse de una suplantación: verifica su identidad por otro canal antes de volver a confiar en él.',
    )
  })

  it('pins the file-encryption honesty lines (#103, §12.4)', () => {
    expect(es['files.encWarningPublic']).toBe(
      'Sala pública: sin cifrado E2E — solo DTLS. El contenido no viaja cifrado de extremo a extremo.',
    )
    expect(es['files.encStateClear']).toBe('Sin cifrado E2E — solo DTLS.')
    expect(es['files.refusalDmKeyUnavailable']).toBe(
      'Sin clave DM disponible: el archivo nunca viaja sin cifrar.',
    )
  })

  it('pins the global-swarm exposure disclosure (#105, §12.5)', () => {
    expect(es['contact.toggleHint']).toBe(
      'Activación voluntaria: al activarlo entras en un enjambre público y bien conocido donde cada par con la opción activada puede ver tu IP, tu huella y tu apodo, y solicitarte contacto por huella para abrir un DM contigo. Desactivado por defecto; desactivarlo abandona el enjambre al instante y cierra sus canales. Las entradas «+ contacto» de la barra lateral solo aparecen mientras el canal está activo.',
    )
  })
})

describe('glossary invariants (es.ts header, enforced)', () => {
  it('never translates tracker: the loanword stays, «rastreador» is banned', () => {
    const trackerKeys = keys.filter((key) => en[key].toLowerCase().includes('tracker'))
    expect(trackerKeys.length).toBeGreaterThanOrEqual(10)
    for (const key of trackerKeys) {
      expect(es[key].toLowerCase()).toContain('tracker')
    }
    for (const key of keys) {
      expect(es[key].toLowerCase()).not.toContain('rastreador')
      expect(es[key].toLowerCase()).not.toContain('seguidor')
    }
  })

  it('renders room as «sala» everywhere (never «habitación»/«canal»)', () => {
    for (const key of roomKeys) {
      if (frozenRoomKeys.has(key)) continue
      expect(es[key].toLowerCase(), `room glossary miss on ${key}`).toContain('sala')
    }
    for (const key of keys) {
      expect(es[key].toLowerCase()).not.toContain('habitación')
    }
  })

  it('renders knock as «solicitud de contacto» and opt-in as «activación voluntaria»', () => {
    for (const key of keys) {
      if (en[key].toLowerCase().includes('knock')) {
        // Noun «solicitud» or verb «solicitar» — both glossary-sanctioned.
        expect(es[key], `knock glossary miss on ${key}`).toMatch(/[Ss]olicit/)
      }
    }
    expect(es['contact.globalMarkerTitle']).toContain('activación voluntaria')
    expect(es['contact.toggleHint']).toMatch(/^Activación voluntaria:/)
  })

  it('keeps the app Settings modal as «Ajustes» (with the settings-path arrows intact)', () => {
    expect(es['common.settings']).toBe('Ajustes')
    expect(es['contact.knockErrorSignalOff']).toBe(
      'El canal global está desactivado: actívalo en Ajustes → Privacidad.',
    )
    expect(es['settings.muteDmDialogBody']).toContain('Ajustes → Privacidad')
  })
})

describe('frozen fragments stay verbatim in Spanish', () => {
  it('keeps the spec-frozen DmList markers', () => {
    expect(es['wizard.noRoomMarker']).toBe(en['wizard.noRoomMarker'])
    expect(es['wizard.noRoomMarker']).toBe('(no room)')
    expect(es['contact.globalMarker']).toBe(en['contact.globalMarker'])
    expect(es['contact.globalMarker']).toBe('(global)')
  })

  it('keeps the gritos — notification prefix and the brand lowercase', () => {
    expect(es['notifications.dmTitle']).toMatch(/^gritos — /)
    expect(es['notifications.mentionTitle']).toMatch(/^gritos — /)
    expect(es['chat.shareTitle']).toMatch(/^Sala #\{name\} en gritos$/)
  })

  it('keeps the zorro-bravo nickname example and the /rooms #name pieces', () => {
    expect(es['onboarding.nicknamePlaceholder']).toContain('zorro-bravo')
    expect(es['slash.roomUnreadOne']).toBe('#{name} ({count} sin leer)')
    expect(es['chat.roomFeedLabel']).toBe('Mensajes en #{name}')
  })

  it('keeps the usage-line prefix translated but injects English grammar', () => {
    expect(es['slash.usageLine']).toBe('Uso: {usage}')
  })
})

describe('register: tuteo everywhere', () => {
  it('has no vosotros forms in any Spanish string', () => {
    const vosotros = /\b(vosotros|vosotras|vuestro|vuestros|vuestra|vuestras|os)\b/i
    for (const key of keys) {
      expect(es[key], `vosotros form on ${key}`).not.toMatch(vosotros)
    }
  })
})
