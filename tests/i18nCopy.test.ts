import { afterEach, describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en'
import { es } from '../src/i18n/es'
import { getLocale, setLocale, t, tPlural } from '../src/i18n/index'
import { connectionStatusText } from '../src/stores/useAppStore'
import {
  NETWORK_ERROR_BANNER_TEXT,
  roomStatusText,
} from '../src/lib/rooms'
import {
  activeRoomsLine,
  dmAmbiguousLine,
  dmFeedLabel,
  dmPeerNotFoundLine,
  expiredSeparatorText,
  joinSystemLine,
  muteSystemLine,
  newMessagesButtonText,
  nicknameChangedLine,
  typingStatusText,
  unmuteSystemLine,
} from '../src/lib/feed'
import { dmNotificationTitle, mentionNotificationTitle, notificationBody } from '../src/lib/notifications'
import {
  fileCardLabel,
  fileFailureText,
  fileOfferText,
  fileRecipientDmText,
  fileRefusalText,
  knockErrorText,
  manualBlobErrorText,
} from '../src/components/settings/messages'
import { SLASH_COMMANDS, slashUsageText } from '../src/lib/slashCommands'

/**
 * Issue #119 phase 2 — the copy-migration contract. The centralized copy of
 * settings/messages.ts, lib/feed.ts, lib/rooms.ts, lib/notifications.ts,
 * lib/nickname.ts and the §10.3 status templates moved into `src/i18n/en.ts`
 * (first-pass Spanish in ./es, compile-pinned by `Translations`). This suite
 * proves, per migrated surface:
 *
 *  1. the migrated builders resolve the EXACT legacy strings under 'en'
 *     (spot-checking the load-bearing ones — the §10.3 trio, the RNF-07
 *     banner, the §10.5 notification formats, the refusal/failure/knock
 *     reason maps and the slash help rows through their getters), so the
 *     docs pins (qrDocs, fileTransferDocs, historyGossipDocs,
 *     signalChannelDocs) keep their frozen wordings,
 *  2. the builders are CALL-TIME live: a sample resolves differently after
 *     `setLocale('es')` and back — no boot-frozen strings on builder paths,
 *  3. the runtime concatenations render through their single templates
 *     (`slash.usageLine`, `slash.errorWithUsage`, the /rooms line).
 *
 * The en↔es key-set equality is asserted too: `tsc -b` enforces it at
 * compile time; making it visible here keeps a runtime guard for suites
 * that never typecheck the dictionaries.
 */

afterEach(() => {
  // Every test reads the 'en' side; restore it explicitly (the lazy boot
  // resolves 'en' in Node anyway — no localStorage, no es* navigator).
  setLocale('en')
})

describe('dictionary parity and seed shape', () => {
  it('mirrors every en key in es (compile contract, made visible)', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
  })

  it('migrated the copy at scale (the dictionaries are no longer the seed)', () => {
    expect(Object.keys(en).length).toBeGreaterThan(200)
  })
})

describe('migrated builders resolve the exact legacy strings (en)', () => {
  it('keeps the §10.3 connection-status texts, plural pair included', () => {
    expect(connectionStatusText('searching', 0)).toBe('Searching for peers on the torrent network…')
    expect(connectionStatusText('searching', 3)).toBe('Connecting (3 peers found)…')
    expect(connectionStatusText('connected', 5)).toBe('P2P channel established · 5 peers')
    expect(connectionStatusText('error', 0)).toBe(en['chat.networkErrorBanner'])
    // The count-based templates are …One/…Other pairs: English gains the
    // singular grammar at count 1 (matching the seeded common.peerCount).
    expect(connectionStatusText('connected', 1)).toBe('P2P channel established · 1 peer')
    expect(connectionStatusText('searching', 1)).toBe('Connecting (1 peer found)…')
    expect(tPlural('chat.connectedStatus', 1)).toBe(t('chat.connectedStatusOne', { count: 1 }))
  })

  it('keeps the RNF-07 banner wording identical through the rooms shim and the key', () => {
    expect(NETWORK_ERROR_BANNER_TEXT).toBe('No tracker access — check your connection or configure alternative trackers')
    expect(NETWORK_ERROR_BANNER_TEXT).toBe(t('chat.networkErrorBanner'))
  })

  it('keeps the password-room not-found status line', () => {
    expect(
      roomStatusText({ hasPassword: true, status: 'error', name: 'lobby', peers: [] }),
    ).toBe('Room #lobby not found with that password')
    expect(
      roomStatusText({ hasPassword: true, status: 'error', name: 'lobby', peers: [] }),
    ).toBe(t('errors.roomNotFound', { name: 'lobby' }))
  })

  it('keeps the feed system lines, separators and empty states', () => {
    expect(joinSystemLine('luna-cauta')).toBe('— luna-cauta joined —')
    expect(t('feed.leaveLine', { nickname: 'luna-cauta' })).toBe('— luna-cauta left —')
    expect(muteSystemLine('zorro-bravo')).toBe('@zorro-bravo was muted')
    expect(unmuteSystemLine('zorro-bravo')).toBe('@zorro-bravo is no longer muted')
    expect(expiredSeparatorText(1)).toBe('— 1 expired message —')
    expect(expiredSeparatorText(3)).toBe('— 3 expired messages —')
    expect(tPlural('feed.newMessages', 1)).toBe('↓ 1 new message')
    expect(newMessagesButtonText(7)).toBe('↓ 7 new messages')
    expect(typingStatusText(['luna-cauta'])).toBe('luna-cauta is typing…')
    expect(typingStatusText(['a', 'b'])).toBe('2 people are typing…')
    expect(t('feed.recoveredSeparator')).toBe('— messages recovered from peers —')
    expect(t('feed.fifoSeparator')).toBe('— earlier messages discarded —')
  })

  it('keeps the §10.5 notification title/body formats', () => {
    expect(dmNotificationTitle('luna-cauta')).toBe('gritos — DM from luna-cauta')
    expect(mentionNotificationTitle('general')).toBe('gritos — mention in #general')
    expect(notificationBody('zorro-bravo', 'hola @ti…')).toBe('zorro-bravo: hola @ti…')
  })

  it('keeps the file-refusal, failure and blob/knock error entries', () => {
    expect(fileRefusalText('unknown-room')).toBe('The room is no longer connected: the file cannot be sent.')
    expect(fileRefusalText('file-too-big')).toBe('The file exceeds the 20 MB limit.')
    expect(fileRefusalText('concurrency-cap')).toBe(
      'The recipient already has 3 transfers in progress: wait for one to finish.',
    )
    expect(fileRefusalText('dm-key-unavailable')).toBe('No DM key available: the file never travels unencrypted.')
    expect(fileFailureText('peer-drop')).toBe('Failed: the peer has disconnected.')
    expect(fileFailureText('crypto')).toBe('Failed: the content could not be decrypted.')
    expect(manualBlobErrorText('encoding')).toBe('The pasted text is not a valid invitation.')
    expect(manualBlobErrorText('fingerprint')).toBe(
      'The fingerprint does not match the key: the invitation is corrupt or tampered with.',
    )
    expect(knockErrorText('signal-off')).toBe('The global channel is disabled: enable it in Settings → Privacy.')
    expect(knockErrorText('peer-not-present')).toBe(
      'That fingerprint is not present on the global channel right now.',
    )
  })

  it('keeps the file-card builders', () => {
    expect(fileCardLabel('notes.txt', null)).toBe('Transfer of notes.txt')
    expect(fileCardLabel('notes.txt', 'zorro-bravo')).toBe('Transfer of notes.txt with zorro-bravo')
    expect(fileOfferText('zorro-bravo')).toBe('zorro-bravo wants to send you a file:')
    expect(fileRecipientDmText('zorro-bravo')).toBe('Recipient: zorro-bravo')
  })

  it('resolves every slash help row live through its getter', () => {
    expect(SLASH_COMMANDS.length).toBe(8)
    for (const def of SLASH_COMMANDS) {
      expect(def.help).toBe(t(`slash.${def.verb}Help` as keyof typeof en))
      expect(def.help).not.toHaveLength(0)
    }
    // Spot-check the exact legacy wording through the getter.
    expect(SLASH_COMMANDS[0]?.help).toBe(
      'Changes your nickname (2–24 characters: letters, numbers, spaces, hyphens and underscores).',
    )
    // usage/verb stay literal English (protocol grammar) in both locales.
    expect(SLASH_COMMANDS[0]?.usage).toBe('/nick <name>')
  })

  it('keeps the slash feedback lines', () => {
    expect(nicknameChangedLine('luna-cauta')).toBe('Nickname changed to "luna-cauta"')
    expect(dmPeerNotFoundLine('fantasma')).toBe('Nobody among your peers is named "fantasma".')
    expect(dmAmbiguousLine('luna-cauta')).toBe(
      'Several peers are named "luna-cauta": open the conversation from the peer list.',
    )
    expect(dmFeedLabel('zorro-bravo')).toBe('Direct messages with zorro-bravo')
  })
})

describe('builders are call-time live (no boot-frozen strings)', () => {
  it('a builder sample flips with the locale and back', () => {
    expect(getLocale()).toBe('en')
    expect(joinSystemLine('luna-cauta')).toBe('— luna-cauta joined —')
    setLocale('es')
    expect(getLocale()).toBe('es')
    expect(joinSystemLine('luna-cauta')).toBe('— luna-cauta se ha unido —')
    expect(dmNotificationTitle('luna-cauta')).toBe('gritos — DM de luna-cauta')
    expect(fileRefusalText('file-too-big')).toBe('El archivo supera el límite de 20 MB.')
    expect(SLASH_COMMANDS[0]?.help).toBe(
      'Cambia tu apodo (2–24 caracteres: letras, números, espacios, guiones y guiones bajos).',
    )
    setLocale('en')
    expect(joinSystemLine('luna-cauta')).toBe('— luna-cauta joined —')
  })

  it('resolves the es dictionary placeholders exactly like en', () => {
    setLocale('es')
    expect(tPlural('common.peerCount', 1)).toBe('1 par')
    expect(tPlural('common.peerCount', 5)).toBe('5 pares')
    expect(t('errors.roomNotFound', { name: 'lobby' })).toBe('No se encontró la sala #lobby con esa contraseña')
    setLocale('en')
  })
})

describe('runtime concatenations render through single templates', () => {
  it('renders slashUsageText through slash.usageLine with the usage injected', () => {
    expect(t('slash.usageLine')).toBe('Usage: {usage}')
    expect(slashUsageText('nick')).toBe('Usage: /nick <name>')
    expect(slashUsageText('leave')).toBe('Usage: /leave')
    // The injected usage stays English grammar under es; only the prefix
    // translates.
    setLocale('es')
    expect(slashUsageText('nick')).toBe('Uso: /nick <name>')
    setLocale('en')
  })

  it('renders the /rooms line through one template with joined room pieces', () => {
    expect(activeRoomsLine([])).toBe('No active rooms.')
    expect(t('slash.activeRooms', { rooms: '#' })).toBe('Active rooms: #')
    expect(activeRoomsLine([{ name: 'lobby', unread: 0 }])).toBe('Active rooms: #lobby')
    expect(activeRoomsLine([{ name: 'lobby', unread: 2 }, { name: 'dev', unread: 0 }])).toBe(
      'Active rooms: #lobby (2 unread), #dev',
    )
    setLocale('es')
    expect(activeRoomsLine([{ name: 'lobby', unread: 2 }])).toBe('Salas activas: #lobby (2 sin leer)')
    setLocale('en')
  })

  it('renders the validation-error + usage line through slash.errorWithUsage', () => {
    expect(t('slash.errorWithUsage', { error: 'E', usage: 'U' })).toBe('E U')
    // The executor composes it from the owning libs' keys + the usage line.
    expect(t('slash.errorWithUsage', { error: t('errors.nicknameInvalid'), usage: slashUsageText('nick') })).toBe(
      `${t('errors.nicknameInvalid')} Usage: /nick <name>`,
    )
  })
})
