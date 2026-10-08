import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import { SLASH_COMMANDS } from '../src/lib/slashCommands'

/**
 * Release guard for issue #99 (slash commands in the composer) — the docs
 * phase of the issue. Pins the documentation to the shipped behavior:
 *
 *  1. the README's keyboard-features bullet documents the eight English
 *     verbs (the issue-#112 rename), the never-send guarantee for unknown
 *     verbs, the `\/` escape hatch, the honest /me rendering asymmetry and
 *     /help,
 *  2. spec §10.7 documents the client-only command surface: the verb table,
 *     the escape hatch, the unknown-verb guarantee, the ARIA combobox
 *     autocomplete, the /me local-flag asymmetry, the /room password-popover
 *     arming and the memory-only /clear clear,
 *  3. the manual QA matrix ships in `docs/qa-checklist.md` (QA-99-1..12),
 *     and
 *  4. the docs stay in lockstep with the SLASH_COMMANDS table — every verb
 *     in the parser table (the source the /help overlay renders from) is
 *     documented with its usage in the spec entry and named in the README
 *     bullet, so adding a command without documenting it fails here.
 *
 * All three files are read through vite's `?raw` transform (no `node:fs` —
 * the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk.
 */

describe('slash commands documentation (issue #99)', () => {
  it('documents the feature under a README keyboard-features bullet', () => {
    expect(readme).toContain('**Slash commands (issue #99)**')
    expect(readme).toContain('keyboard-first command line')
    expect(readme).toContain('never sent')
    expect(readme).toContain('`\\/hola`')
    expect(readme).toContain('while peers see plain text')
    expect(readme).toContain('`/help`')
  })

  it('documents every verb in the spec §10.7 entry, in lockstep with the parser table', () => {
    expect(spec).toContain('### 10.7 Comandos de barra (issue #99)')
    for (const def of SLASH_COMMANDS) {
      expect(spec).toContain(def.usage)
      expect(readme).toContain(`/${def.verb}`)
    }
  })

  it('pins the unknown-verb guarantee and the backslash escape hatch in the spec', () => {
    expect(spec).toContain('Verbo desconocido jamás se envía')
    expect(spec).toContain('Unknown command — /help')
    expect(spec).toContain('\\/hola` envía «/hola»')
  })

  it('pins the ARIA combobox autocomplete pattern in the spec', () => {
    expect(spec).toContain('patrón ARIA combobox')
    expect(spec).toContain('aria-activedescendant')
    expect(spec).toContain('el foco no abandona jamás el textarea')
  })

  it('pins the /me asymmetry, /room popover arming and memory-only /clear in the spec', () => {
    expect(spec).toContain('los pares ven texto plano')
    expect(spec).toContain('arma la oferta de contraseña')
    expect(spec).toContain('los pares conservan su historial')
  })

  it('ships the manual slash-command matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #99 — slash commands')
    expect(qaChecklist.match(/QA-99-\d+/g) ?? []).toHaveLength(12)
    for (let n = 1; n <= 12; n += 1) {
      expect(qaChecklist).toContain(`QA-99-${n}`)
    }
  })
})
