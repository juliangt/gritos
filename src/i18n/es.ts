import type { Translations } from './en'

/**
 * Issue #119 — Spanish dictionary, compile-pinned to the English keys:
 * `Translations = Record<TranslationKey, string>` makes a missing or extra
 * key a `tsc -b` error, so the two dictionaries can never drift apart.
 * Phase 4 is the native-quality review of the phase-2/3 first pass: every
 * key below was re-read for meaning, gender/number agreement and natural
 * word order — `{placeholder}` tokens move to where Spanish puts them,
 * never mirroring the English position (the token set per key is enforced
 * by tests/i18nSpanish.test.ts).
 *
 * GLOSSARY — each concept renders ONE way, everywhere (never two synonyms
 * for the same idea; the load-bearing rows are enforced by
 * tests/i18nSpanish.test.ts):
 *
 *   tracker        «tracker»        loanword, standard in this domain — never «rastreador»
 *   peer           «par»            masculine; plural «pares»
 *   room           «sala»           never «habitación»/«canal»
 *   DM             «DM»             masculine loanword in tight/technical copy («abrir un
 *                                   DM», «clave DM»); full surface names spell
 *                                   «mensaje(s) directo(s)»
 *   fingerprint    «huella»         feminine
 *   knock          «solicitud de contacto»   the verb: «solicitar el contacto»
 *   opt-in         «activación voluntaria»   never the weaker «opcional»
 *   feed           «historial»      or «mensajes» contextually; the noun "feed" never renders
 *   nickname       «apodo»
 *   sidebar        «barra lateral»
 *   unread         «sin leer»       the badge; as a counted noun: «mensajes sin leer»
 *   Settings       «Ajustes»        the app's modal (→ Ajustes → Privacidad); generic
 *                                   configuration (the browser's, the ICE one) is «configuración»
 *   remove         «quitar»         distinct from dismiss «descartar» and wipe/delete «borrar»
 *   share          «compartir»
 *   join           «unirse»
 *   reload         «recargar»
 *   swarm          «enjambre»
 *   expiry/TTL     «caducidad»      expired: «caducado»
 *   E2E            «E2E»            terse card states (mirroring en); prose notices spell
 *                                   «de extremo a extremo» — the same mix as en
 *   transfer       «transferencia»  feminine — the card status participles agree with it
 *                                   («Completada», «Rechazada», «Cancelada»)
 *
 * Register: tuteo (informal tú) everywhere, no vosotros forms. System lines
 * keep the perfect aspect consistently («se ha unido», «ha sido
 * silenciado»); imperative help lines address the user in tú
 * («Únete a una sala…»), never mixing in a third-person command voice.
 *
 * Privacy/legal nuance over literalness (the issue's explicit gate): the
 * P2P/IP disclosure, the TURN storage notes, the 'stored unencrypted'
 * honesty lines, the panic-wipe copy, the identity-regeneration
 * consequences, the knock/consent wording, the file-transfer warnings and
 * the TOFU fingerprint-change warning translate the MEANING and its weight
 * — a mistranslated disclosure is a privacy problem. The load-bearing ones
 * are pinned verbatim by tests/i18nSpanish.test.ts.
 *
 * Frozen fragments stay verbatim in both locales: the `{usage}` grammar
 * ('/nick <name>'), the spec-frozen '(no room)' and '(global)' markers, the
 * 'gritos — ' notification prefix, the 'zorro-bravo' nickname example and
 * the '#name' pieces of /rooms output.
 */
export const es: Translations = {
  // -------------------------------------------------------------------------
  // common — shared verbs/labels reused across surfaces.
  // -------------------------------------------------------------------------

  'common.cancel': 'Cancelar',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.copiedWith': 'Copiado {what}',
  'common.peerCountOne': '{count} par',
  'common.peerCountOther': '{count} pares',
  'common.unreadCountOne': '{count} sin leer',
  'common.unreadCountOther': '{count} sin leer',

  'common.continue': 'Continuar',
  'common.join': 'Unirse',
  'common.send': 'Enviar',
  'common.settings': 'Ajustes',
  'common.dismissNotice': 'Descartar el aviso',
  'common.encryptedRoomAria': 'sala cifrada',
  'common.encryptedRoomTitle': 'Sala protegida con contraseña',
  'common.yourNickname': 'Tu apodo',

  'common.mute': 'Silenciar',
  'common.unmute': 'Dejar de silenciar',
  'common.accept': 'Aceptar',
  'common.decline': 'Rechazar',

  'common.ttlSelectLabel': 'Caducidad del mensaje',
  'common.noExpiryLabel': 'Sin caducidad',
  'common.ttl30Seconds': '30 segundos',
  'common.ttl5Minutes': '5 minutos',
  'common.ttl1Hour': '1 hora',

  'common.reactionAdd': 'Reaccionar',
  'common.reactionBar': 'Reacciones rápidas',
  'common.reactionsRow': 'Reacciones',
  'common.reactQuickPick': 'Reaccionar con {emo}',

  'common.updateAvailable': 'Nueva versión disponible',
  'common.updateReload': 'Recargar',
  'common.updateToastDismiss': 'Descartar el aviso',
  'common.updateToastLabel': 'Nueva versión de la aplicación',

  // -------------------------------------------------------------------------
  // settings — the settings modal: Network-tab validation (RF-07), the
  // TURN/P2P storage & exposure disclosures (#30/#35), the mute list (#95),
  // the history-gossip consent (#102) and the join-form texts (RF-02/RF-05).
  // -------------------------------------------------------------------------

  'settings.trackerError': 'Las URLs de los trackers deben empezar por wss://',
  'settings.iceError': 'Los servidores ICE deben empezar por stun: o turn:',
  'settings.maxRoomsError': 'El límite de salas activas debe estar entre 1 y 6.',

  'settings.emptyTrackersHint': 'Lista vacía: se usan los trackers predeterminados de Trystero.',
  'settings.emptyIceHint': 'Lista vacía: se usa la configuración ICE predeterminada de Trystero.',
  'settings.reconnectNote': 'Los cambios de red se aplican cuando las salas se reconectan.',

  'settings.turnCredentialStorageHint':
    'Las credenciales TURN se guardan sin cifrar en este navegador.',
  'settings.turnCredentialMemoryHint':
    'Las credenciales TURN se mantienen solo en memoria y se pierden al cerrar la pestaña.',
  'settings.turnCredentialAtRestNote':
    'Las credenciales TURN se guardan sin cifrar en este navegador. Se configuran en la pestaña Red; desactiva allí «Recordar las credenciales TURN en este navegador» para que solo permanezcan en la memoria de la sesión.',

  'settings.p2pDisclosure':
    'Las conexiones son P2P: quien comparta una sala contigo puede ver tu dirección IP.',
  'settings.p2pIpExposureNote':
    'Las conexiones son P2P por diseño: quien comparta una sala contigo puede ver tu dirección IP, y configurar TURN no la oculta a los pares (el navegador sigue anunciando tu dirección pública). Los operadores de trackers ven metadatos de conexión con menos detalle: tu IP, identificadores opacos e instantes de conexión.',

  'settings.muteAuthorAction': 'Silenciar a @{nickname}',
  'settings.muteDmDialogTitle': 'Silenciar al par',
  'settings.muteDmDialogBody':
    'Tienes una conversación directa abierta con este par: al silenciarlo, dejarán de llegarte sus mensajes de sala y sus mensajes directos se ignorarán. Puedes deshacerlo en Ajustes → Privacidad. ¿Continuar?',

  'settings.mutedPeersHeading': 'Pares silenciados',
  'settings.mutedPeersHint':
    'Estos pares no pueden enviarte mensajes de sala ni mensajes directos. El apodo solo se muestra si los silenciaste en esta sesión.',
  'settings.emptyMutedPeers': 'No has silenciado a ningún par.',
  'settings.unmutePeerAction': 'Dejar de silenciar a {identifier}',

  'settings.shareHistoryLabel': 'Compartir mi historial reciente con quienes lleguen tarde',
  'settings.shareHistoryHint':
    'Solo si lo activas, quien se una tarde a una sala y lo pida explícitamente puede recibir hasta los últimos 50 mensajes de chat que esta pestaña mantiene en memoria. Nada se guarda ni se envía sin una petición; en las salas con contraseña, los cuerpos viajan re-sellados con la clave de la sala, de modo que solo alguien que la conozca pueda leerlos.',

  'settings.historyAskLabel': 'Pedir mensajes recientes',
  'settings.historyAskText': '¿Pedir a la sala los últimos mensajes?',
  'settings.historyAskConfirm': 'Pedir',
  'settings.historyAskDismiss': 'No',

  'settings.invalidRoomName':
    'Solo letras minúsculas, números, guiones y guiones bajos (1–32 caracteres)',
  'settings.encryptedRoomHint':
    'Quien no tenga la contraseña no encontrará esta sala. Su nombre nunca se guarda en este navegador.',
  'settings.emptyRoomPassword': 'Escribe una contraseña para la sala cifrada',

  // Phase 3 — the inline literals of the modal itself and its three tabs. The
  // modal label/heading render the shared `common.settings` wording.

  'settings.closeAria': 'Cerrar los ajustes',
  'settings.changeNicknameLabel': 'Cambiar el apodo',
  'settings.saveNickname': 'Guardar el apodo',
  'settings.sectionsAria': 'Secciones de ajustes',
  'settings.tabNetwork': 'Red',
  'settings.tabPrivacy': 'Privacidad',
  'settings.tabAppearance': 'Apariencia',

  'settings.notificationsLabel': 'Notificaciones de escritorio',
  'settings.allowNotifications': 'Permitir notificaciones',
  'settings.permissionGranted': 'Permiso concedido.',
  'settings.permissionDefault': 'Permiso no solicitado.',
  'settings.permissionDenied': 'Permiso denegado. Actívalo en la configuración del navegador.',
  'settings.permissionUnsupported': 'Tu navegador no admite notificaciones.',
  'settings.rememberRoomsLabel': 'Recordar las salas recientes',

  'settings.identityKeyAtRestNote':
    'Tu clave privada se guarda cifrada en este navegador: la clave que la descifra vive en IndexedDB y nada viaja por la red. Aun así, si algo compromete por completo este origen (una extensión maliciosa, malware en tu equipo) podría usar esa clave para suplantarte.',
  'settings.regenerateHint':
    'Genera un nuevo par de claves ECDH: tu huella cambiará para todos tus pares.',
  'settings.regenerateIdentity': 'Regenerar la identidad',
  'settings.regenerateDialogBody':
    'Se generará un nuevo par de claves: tu huella cambiará y los canales DM con tus pares dejarán de coincidir. ¿Continuar?',
  'settings.regenerateConfirm': 'Regenerar',

  'settings.autoJoinLobbyLabel': 'Unirse a #lobby automáticamente al iniciar',
  'settings.customTrackersHeading': 'Trackers personalizados',
  'settings.addTracker': 'Añadir tracker',
  'settings.trackerRowLabel': 'Tracker {index}',
  'settings.removeTrackerRowLabel': 'Quitar el tracker {index}',
  'settings.removeTrackerTitle': 'Quitar el tracker',

  'settings.iceServersHeading': 'Servidores ICE (STUN/TURN)',
  'settings.stunOption': 'STUN',
  'settings.turnOption': 'TURN',
  'settings.addIceServer': 'Añadir servidor ICE',
  'settings.iceTypeRowLabel': 'Tipo de servidor ICE {index}',
  'settings.iceUrlRowLabel': 'URL del servidor ICE {index}',
  'settings.removeIceRowLabel': 'Quitar el servidor ICE {index}',
  'settings.removeIceTitle': 'Quitar el servidor ICE',
  'settings.turnUsernameLabel': 'Nombre de usuario TURN {index}',
  'settings.turnPasswordLabel': 'Contraseña TURN {index}',
  'settings.turnUsernamePlaceholder': 'usuario',
  'settings.turnPasswordPlaceholder': 'contraseña',
  'settings.rememberTurnCredentialsLabel': 'Recordar las credenciales TURN en este navegador',

  'settings.maxActiveRoomsLabel': 'Límite de salas activas',
  'settings.reconnectAll': 'Reconectar todo',

  'settings.themeLabel': 'Tema',
  'settings.themeLight': 'Claro',
  'settings.themeDark': 'Oscuro',
  'settings.themeSystem': 'Sistema',
  'settings.collapseSidebarLabel': 'Contraer la barra lateral al iniciar',

  // Issue #119 — the UI-language picker: only the label and the 'Auto'
  // option translate; 'English'/'Español' are literal endonyms in both
  // locales (they always render in their own language).
  'settings.languageLabel': 'Idioma',
  'settings.languageAuto': 'Automático',

  // -------------------------------------------------------------------------
  // chat — the chat header/composer: the §10.3 connection-status templates,
  // the network banners (RNF-07, #43, #125) and the password-room not-found
  // status (§10.3/RF-05).
  // -------------------------------------------------------------------------

  'chat.searchingStatus': 'Buscando pares en la red torrent…',
  'chat.connectingStatusOne': 'Conectando ({count} par encontrado)…',
  'chat.connectingStatusOther': 'Conectando ({count} pares encontrados)…',
  'chat.connectedStatusOne': 'Canal P2P establecido · {count} par',
  'chat.connectedStatusOther': 'Canal P2P establecido · {count} pares',

  'chat.networkErrorBanner':
    'Sin acceso a trackers — revisa tu conexión o configura trackers alternativos',

  'chat.peerlessHint': 'Aún esperando pares — la sala puede estar vacía',

  'chat.insecureContextBanner':
    'No se pudo conectar — WebRTC y el cifrado requieren HTTPS o localhost (contexto no seguro). Consulta el README para servir la aplicación por HTTPS.',

  // Phase 3 — the header/composer inline chrome.

  'chat.toggleSidebarAria': 'Mostrar u ocultar la barra lateral',
  'chat.toggleSidebarTitle': 'Mostrar u ocultar la barra lateral (Ctrl/Cmd+B)',

  'chat.shareRoomAria': 'Compartir la sala',
  'chat.shareTitle': 'Sala #{name} en gritos',
  'chat.linkCopied': 'Enlace copiado',

  'chat.statusSearching': 'buscando pares',
  'chat.statusConnected': 'conectado',
  'chat.statusError': 'sin acceso a trackers',

  'chat.composerLabel': 'Mensaje',
  'chat.messageAria': 'Escribe un mensaje',
  'chat.messagePlaceholder': 'Mensaje (Markdown)…',
  'chat.markdownHint': '**negrita** · *cursiva* · `código`',
  'chat.queuedHint': 'En cola hasta conectarse…',

  'chat.joinWithPasswordLabel': 'Unirse con contraseña',
  'chat.passwordJoinPrompt': 'Si la sala tiene contraseña, únete con ella:',

  'chat.roomFeedLabel': 'Mensajes en #{name}',

  'chat.noActiveRoomHint':
    'No hay ninguna sala activa. Únete a una desde la barra lateral (pulsa Ctrl/Cmd+B para mostrarla).',
  'chat.sidebarDrawerLabel': 'Barra lateral',

  'chat.networkStatusAria': 'Estado de la red',
  'chat.openSettings': 'Abrir los ajustes',

  'chat.receiptDelivered': 'entregado',
  'chat.receiptPending': 'enviado, pendiente de acuse',

  // -------------------------------------------------------------------------
  // feed — system lines, separators and empty states (RF-03/RF-06, §10.4).
  // Local-only lines (mute, separators) never travel over the wire. System
  // lines keep the perfect aspect («se ha unido») across the surface.
  // -------------------------------------------------------------------------

  'feed.fifoSeparator': '— mensajes anteriores descartados —',
  'feed.expiredSeparatorOne': '— {count} mensaje caducado —',
  'feed.expiredSeparatorOther': '— {count} mensajes caducados —',
  'feed.recoveredSeparator': '— mensajes recuperados de los pares —',

  'feed.emptyRoom': 'Comparte el nombre de la sala para que otros se unan.',
  'feed.emptyDm': 'Aún no hay mensajes. Escribe el primero.',
  'feed.emptyDmList':
    'Aún no hay mensajes directos. Abre el menú de un par para iniciar una conversación cifrada.',
  'feed.emptyRecents': 'Aún no hay salas recientes.',

  'feed.joinLine': '— {nickname} se ha unido —',
  'feed.leaveLine': '— {nickname} ha salido —',

  'feed.muteLine': '@{nickname} ha sido silenciado',
  'feed.unmuteLine': '@{nickname} ya no está silenciado',

  'feed.typingOne': '{nickname} está escribiendo…',
  'feed.typingOther': '{count} personas están escribiendo…',

  'feed.newMessagesOne': '↓ {count} mensaje nuevo',
  'feed.newMessagesOther': '↓ {count} mensajes nuevos',

  'feed.encryptedPlaceholder': '🔒 mensaje cifrado',

  // -------------------------------------------------------------------------
  // dm — direct-message surfaces (RF-04, TOFU/#22, legacy peer #93).
  // -------------------------------------------------------------------------

  'dm.peerDisconnected': 'El par se ha desconectado',
  'dm.legacyPeer': 'Este par usa una versión anterior sin DMs cifrados por sesión',
  'dm.verifyNotice': 'Compárala con tu contacto para verificar su identidad',
  'dm.keyChangedWarning': '⚠ La huella cambió desde tu última verificación',
  'dm.keyChangedHint':
    'El par puede haber reinstalado la aplicación o podría tratarse de una suplantación: verifica su identidad por otro canal antes de volver a confiar en él.',
  'dm.feedLabel': 'Mensajes directos con {peerNick}',

  // Phase 3 — the peer menu (PeerList) and the DmList disconnected chrome.
  // The ⚠ rotation line reuses `dm.keyChangedWarning`.

  'dm.directMessageAction': 'Mensaje directo',
  'dm.copyFingerprint': 'Copiar la huella',
  'dm.fingerprintCopied': 'Huella copiada.',
  'dm.peerDisconnectedHistory': 'El par se ha desconectado — el historial permanece',

  // -------------------------------------------------------------------------
  // sidebar — the sidebar sections (RF-02/RF-06, §10.1): room lists, the
  // peers section, the DM list and the join-by-name form. Phase 3 namespace.
  // -------------------------------------------------------------------------

  'sidebar.joinEntry': '[+ Unirse]',

  'sidebar.activeRoomsLabel': 'Salas activas',
  'sidebar.activeHeading': 'Activas',
  'sidebar.emptyActive': 'Aún no hay salas activas.',
  'sidebar.suggestedRoomsLabel': 'Salas sugeridas',
  'sidebar.suggestedHeading': 'Sugeridas',
  'sidebar.recentRoomsLabel': 'Salas recientes',
  'sidebar.recentHeading': 'Recientes',
  'sidebar.leaveRoom': 'Abandonar {name}',

  'sidebar.peersSectionLabel': 'Pares',
  'sidebar.peerCountOne': 'Par ({count})',
  'sidebar.peerCountOther': 'Pares ({count})',
  'sidebar.emptyPeers': 'Aún no hay pares. Comparte el nombre de la sala para que otros se unan.',
  'sidebar.latencyAria': 'latencia',
  'sidebar.fingerprintChangedAria': 'huella cambiada',
  'sidebar.peerActionsLabel': 'Acciones para {nickname}',
  'sidebar.peerDisconnectedAria': 'par desconectado',

  'sidebar.dmSectionLabel': 'Mensajes directos',

  'sidebar.joinByNameLabel': 'Unirse por nombre',
  'sidebar.roomNameAria': 'Nombre de la sala',
  'sidebar.roomNamePlaceholder': 'nombre-sala',
  'sidebar.joinPreview': 'Te unirás a',
  'sidebar.encryptedRoomText': '🔒 sala cifrada',
  'sidebar.roomPasswordAria': 'Contraseña de la sala',
  'sidebar.roomPasswordPlaceholder': 'Contraseña de la sala',

  // -------------------------------------------------------------------------
  // slash — slash-command docs and local feedback/error lines (issue #99).
  // Feedback lines are local-only (never sent over the wire). The help lines
  // address the user in tú; the `{usage}` strings («/nick <name>») stay
  // English grammar in both locales: they are the parser's protocol-shaped
  // grammar tokens, not prose.
  // -------------------------------------------------------------------------

  'slash.helpLabel': 'Comandos de barra',
  'slash.helpTitle': 'Comandos',
  'slash.helpEscapeHint':
    'Para enviar un texto que empiece por "/", antepón una barra invertida: \\/hola envía "/hola".',

  'slash.clearDialogTitle': 'Borrar el historial local',
  'slash.clearDialogBody':
    'Los mensajes de esta sala se borrarán solo de tu navegador. La conexión no se cierra y tus pares conservan su historial. ¿Continuar?',
  'slash.clearDialogConfirm': 'Borrar',

  'slash.popupLabel': 'Sugerencias de comandos',

  'slash.unknownCommand': 'Comando desconocido — /help',
  'slash.noActiveRoom': 'No hay ninguna sala activa.',

  'slash.nicknameChanged': 'Apodo cambiado a "{nickname}"',

  'slash.activeRooms': 'Salas activas: {rooms}',
  'slash.roomUnreadOne': '#{name} ({count} sin leer)',
  'slash.roomUnreadOther': '#{name} ({count} sin leer)',
  'slash.noActiveRooms': 'No hay salas activas.',

  'slash.dmPeerNotFound': 'Nadie entre tus pares se llama "{nickname}".',
  'slash.dmAmbiguous':
    'Varios pares se llaman "{nickname}": abre la conversación desde la lista de pares.',

  'slash.usageLine': 'Uso: {usage}',
  'slash.errorWithUsage': '{error} {usage}',

  'slash.nickHelp':
    'Cambia tu apodo (2–24 caracteres: letras, números, espacios, guiones y guiones bajos).',
  'slash.roomHelp': 'Únete a una sala por su nombre (se normaliza a minúsculas con guiones).',
  'slash.dmHelp': 'Abre una conversación directa cifrada con un par.',
  'slash.meHelp': 'Envía una acción: se muestra en cursiva como "* apodo acción".',
  'slash.roomsHelp': 'Lista las salas activas y el número de mensajes sin leer de cada una.',
  'slash.clearHelp': 'Borra el historial local de esta sala (solo tu navegador).',
  'slash.leaveHelp': 'Abandona la sala activa.',
  'slash.helpHelp': 'Muestra esta lista de comandos.',

  // -------------------------------------------------------------------------
  // files — P2P file transfer UI (issue #103, §12.4).
  // -------------------------------------------------------------------------

  'files.attachLabel': 'Adjuntar un archivo',
  'files.attachButton': 'Adjuntar',
  'files.dialogLabel': 'Enviar un archivo',
  'files.pickLabel': 'Elige un archivo…',
  'files.recipientLabel': 'Destinatario',
  'files.recipientDm': 'Destinatario: {peerNick}',

  'files.encNoticeRoom':
    'Se cifrará con la clave de la sala: solo alguien con la contraseña podrá leerlo.',
  'files.encNoticeDm': 'Se cifrará de extremo a extremo con la clave DM de esta conversación.',
  'files.encWarningPublic':
    'Sala pública: sin cifrado E2E — solo DTLS. El contenido no viaja cifrado de extremo a extremo.',

  'files.encStateSealed': 'Cifrado de extremo a extremo.',
  'files.encStateClear': 'Sin cifrado E2E — solo DTLS.',

  'files.sendButton': 'Enviar archivo',

  'files.noPeers': 'Sin pares conectados: no hay destinatario para la oferta.',
  'files.unknownMime': 'tipo desconocido',

  'files.refusalUnknownRoom': 'La sala ya no está conectada: no se puede enviar el archivo.',
  'files.refusalNotConnected': 'Sin conexión: no se pudo enviar la oferta.',
  'files.refusalPeerNotInRoom': 'El destinatario no está conectado a la sala.',
  'files.refusalInvalidFile': 'El archivo no es válido.',
  'files.refusalFileTooBig': 'El archivo supera el límite de 20 MB.',
  'files.refusalNameRequired': 'El nombre del archivo no es válido.',
  'files.refusalConcurrencyCap':
    'El destinatario ya tiene 3 transferencias en curso: espera a que termine una.',
  'files.refusalDmKeyUnavailable': 'Sin clave DM disponible: el archivo nunca viaja sin cifrar.',
  'files.refusalKeyResolutionFailed':
    'No se pudo resolver la clave de cifrado: no se envió nada.',

  'files.cardsRegionLabel': 'Transferencias de archivos',
  'files.cardLabel': 'Transferencia de {fileName}',
  'files.cardLabelWithPeer': 'Transferencia de {fileName} con {peerNick}',

  'files.offerText': '{peerNick} quiere enviarte un archivo:',
  'files.offerPending': 'Oferta enviada: esperando a que el par la acepte.',

  'files.progressSending': 'Enviando…',
  'files.progressReceiving': 'Recibiendo…',
  'files.progressLabel': 'Progreso de la transferencia',

  // The terminal states agree with «transferencia» (the card's subject).
  'files.done': 'Completada',
  'files.rejected': 'Rechazada',
  'files.aborted': 'Cancelada',

  'files.failureStall': 'Falló: la transferencia se estancó.',
  'files.failurePeerDrop': 'Falló: el par se ha desconectado.',
  'files.failureRoomGone': 'Falló: la sala se ha cerrado.',
  'files.failureSizeLimit': 'Falló: el archivo supera el tamaño permitido.',
  'files.failureBadFrame': 'Falló: se recibieron datos corruptos.',
  'files.failureCrypto': 'Falló: el contenido no se pudo descifrar.',
  'files.failureCompleteness': 'Falló: el archivo llegó incompleto.',
  'files.failureIdentityRegenerated': 'Falló: la identidad de la sesión se ha regenerado.',

  'files.downloadButton': 'Descargar',
  'files.dismissButton': 'Descartar',

  // -------------------------------------------------------------------------
  // qr — the QR invite (issue #100). The QR encodes exactly buildRoomLink's
  // output (the room name only, never the password — RF-05).
  // -------------------------------------------------------------------------

  'qr.buttonLabel': 'Código QR de la sala',
  'qr.dialogLabel': 'Código QR de la sala',
  'qr.canvasLabel': 'Código QR con el enlace de la sala {roomName}',
  'qr.downloadButton': 'Descargar PNG',
  'qr.sameInstallNote': 'El QR enlaza a esta misma instalación.',

  // -------------------------------------------------------------------------
  // wizard — the trackerless manual-DM wizard (issue #97, §12.2). The
  // «(no room)» marker is spec-frozen (stays literal English in both locales).
  // -------------------------------------------------------------------------

  'wizard.inviteEntry': '+ invitación',
  'wizard.inviteEntryTitle':
    'Inicia una conversación directa sin trackers intercambiando invitaciones',
  'wizard.bannerShortcut': 'o conéctate sin trackers',
  'wizard.noRoomMarker': '(no room)',
  'wizard.noRoomTitle': 'Conversación creada manualmente mediante invitación, sin sala',

  'wizard.label': 'Conexión manual sin trackers',
  'wizard.intro':
    'Crea una conversación directa sin trackers: intercambias dos invitaciones por cualquier canal (correo, otra mensajería) y la conexión es directa entre los dos.',
  'wizard.roleInviteButton': 'Crear invitación',
  'wizard.roleAnswerButton': 'Responder invitación',

  'wizard.networkWarning': 'La invitación puede contener información sobre tu red',

  'wizard.inviteBlobLabel': 'Tu invitación: cópiala y envíala a tu contacto',
  'wizard.pasteInviteLabel': 'Pega aquí la invitación que te enviaron',
  'wizard.generateAnswerButton': 'Generar respuesta',
  'wizard.pasteAnswerLabel': 'Pega aquí la respuesta de tu contacto',
  'wizard.connectButton': 'Conectar',

  'wizard.progressGenerating': 'Generando invitación…',
  'wizard.progressEstablishing': 'Estableciendo canal P2P…',
  'wizard.progressConnected': 'Canal P2P establecido',
  'wizard.retryButton': 'Empezar de nuevo',

  'wizard.blobErrorEncoding': 'El texto pegado no es una invitación válida.',
  'wizard.blobErrorVersion': 'La invitación usa una versión de formato desconocida.',
  'wizard.blobErrorRole': 'El texto pegado no es del tipo esperado (invitación o respuesta).',
  'wizard.blobErrorKeys': 'La invitación contiene claves no válidas.',
  'wizard.blobErrorFingerprint':
    'La huella no coincide con la clave: la invitación está corrupta o ha sido manipulada.',
  'wizard.blobErrorSdp': 'La invitación contiene una descripción de conexión no válida.',

  'wizard.peerErrorBadBlob': 'El texto pegado no es una respuesta válida para esta invitación.',
  'wizard.peerErrorFingerprintMismatch': 'La huella de la respuesta no coincide con la esperada.',
  'wizard.peerErrorConnectTimeout': 'La conexión no se estableció a tiempo. Inténtalo de nuevo.',
  'wizard.peerErrorIllegalTransition': 'El asistente ya no está en el estado esperado. Empieza de nuevo.',
  'wizard.peerErrorNotConnected': 'El canal no está conectado.',
  'wizard.peerErrorTooLong': 'El mensaje supera el límite de 4000 caracteres.',

  // -------------------------------------------------------------------------
  // contact — the global-DM contact flow (issue #105, §12.5). The «(global)»
  // marker is spec-frozen; «knock» renders as «solicitud de contacto» and
  // «opt-in» as «activación voluntaria» (see the glossary above).
  // -------------------------------------------------------------------------

  'contact.toggleLabel': 'Canal DM global',
  'contact.toggleHint':
    'Activación voluntaria: al activarlo entras en un enjambre público y bien conocido donde cada par con la opción activada puede ver tu IP, tu huella y tu apodo, y solicitarte contacto por huella para abrir un DM contigo. Desactivado por defecto; desactivarlo abandona el enjambre al instante y cierra sus canales. Las entradas «+ contacto» de la barra lateral solo aparecen mientras el canal está activo.',

  'contact.entry': '+ contacto',
  'contact.entryTitle':
    'Comparte tu huella («Mi contacto») o solicita el contacto de otro par mediante su huella («Contacto por huella»)',

  'contact.globalMarker': '(global)',
  'contact.globalMarkerTitle':
    'Conversación directa abierta por huella a través del canal global (activación voluntaria)',

  'contact.dialogLabel': 'Contacto por huella',
  'contact.intro':
    'El canal global conecta dos huellas sin sala compartida: ambas partes deben tenerlo activado en Ajustes → Privacidad. No transporta mensajes: solo solicitudes de contacto, y la conversación empieza cuando la otra parte acepta.',

  'contact.shareButton': 'Mi contacto',
  'contact.knockEntryButton': 'Contacto por huella',

  'contact.fpLabel': 'Tu huella de identidad: cópiala y envíala a tu contacto',
  'contact.qrCanvasLabel': 'Código QR con tu enlace de contacto',

  'contact.knockIntro':
    'Pega la huella de tu contacto: si está presente en el canal global, recibirá tu solicitud y decidirá si la acepta. Mientras esperas, puedes añadir una nota opcional.',
  'contact.knockPasteLabel': 'Pega aquí la huella de tu contacto',
  'contact.knockNoteLabel': 'Nota opcional para tu solicitud',
  'contact.noteCounter': '{length}/140',
  'contact.knockSendButton': 'Enviar solicitud',
  'contact.knockWaiting': 'Solicitud enviada: esperando una respuesta…',
  'contact.knockRejected': 'Rechazada: el par no ha aceptado tu solicitud de contacto.',
  'contact.fpInvalid':
    'Eso no es una huella válida: debe constar de 8 grupos de 4 caracteres hexadecimales.',

  'contact.knockErrorSignalOff':
    'El canal global está desactivado: actívalo en Ajustes → Privacidad.',
  'contact.knockErrorPeerNotPresent': 'Esa huella no está presente en el canal global ahora mismo.',
  'contact.knockErrorInvalid': 'La solicitud no es válida: revisa la huella y la nota.',

  'contact.backButton': 'Atrás',

  'contact.knockConsent': '@{nick} quiere abrir un DM contigo',
  'contact.knockCardLabel': 'Solicitud de contacto de @{nick}',
  'contact.knockCardsRegionLabel': 'Solicitudes de contacto',
  'contact.knockNotePrefix': 'Nota: ',

  'contact.noIdentity': 'No hay identidad en esta sesión.',

  // -------------------------------------------------------------------------
  // panic — the panic-button flow (RF-08, Privacy tab). The double
  // confirmation order is the component's, not this dictionary's.
  // -------------------------------------------------------------------------

  'panic.buttonLabel': 'Borrarlo todo y salir',
  'panic.lastResortNote':
    'Último recurso: borra el apodo, las claves, los ajustes y cualquier rastro local en este navegador.',
  'panic.dialogBody':
    'Se borrarán el apodo, las claves, los ajustes y cualquier rastro local. ¿Continuar?',
  'panic.finalDialogBody':
    'Esta acción es definitiva: se cerrarán todas las conexiones y la aplicación se recargará para empezar de cero.',

  // -------------------------------------------------------------------------
  // onboarding — first-visit onboarding (RF-01, §10.2). The «zorro-bravo»
  // example in the placeholder is DATA (an English-wordlist pair, like
  // anything generateNickname may produce) — only the surrounding label
  // translates.
  // -------------------------------------------------------------------------

  'onboarding.tagline':
    'Sin servidores ni cuentas: tus mensajes viajan directamente entre navegadores y desaparecen al recargar.',
  'onboarding.formAria': 'entrar',
  'onboarding.nicknamePlaceholder': 'p. ej. zorro-bravo',
  'onboarding.surpriseButton': 'sorpréndeme',
  'onboarding.enterButton': 'Entrar →',
  'onboarding.lobbyHint':
    'Te unirás a #lobby automáticamente; desde la barra lateral puedes unirte a otras salas.',
  'onboarding.linkedRoomPrefix': 'Te unirás a la sala',
  'onboarding.linkedRoomSuffix': 'del enlace compartido.',
  'onboarding.insecureContextError': 'No se pudo crear la identidad local (contexto no seguro).',

  // -------------------------------------------------------------------------
  // notifications — desktop notifications (§10.5/RF-09). The 'gritos — '
  // title prefix stays literal in both locales (the app name is the brand).
  // -------------------------------------------------------------------------

  'notifications.dmTitle': 'gritos — DM de {nick}',
  'notifications.mentionTitle': 'gritos — mención en #{room}',
  'notifications.body': '{nick}: {text}',

  // -------------------------------------------------------------------------
  // errors — generic error lines, the engine-thrown UI rejections and the
  // top-level crash fallback (ErrorBoundary, issue #38). The boundary is a
  // class component, so it consumes these through plain `t` — no `useT`
  // subscription is possible there; the crash screen re-mounts on reload
  // anyway, picking up the current locale fresh.
  // -------------------------------------------------------------------------

  'errors.unknown': 'Error desconocido',

  /** RF-01 — inline validation message for an invalid nickname. */
  'errors.nicknameInvalid':
    'Usa de 2 a 24 caracteres: letras, números, espacios, guiones y guiones bajos.',

  'errors.crashTitle': 'Algo salió mal',
  'errors.crashBody': 'Se produjo un error inesperado. Recarga la página para empezar de cero.',
  'errors.crashReload': 'Recargar',

  'errors.roomLimitReached': 'Límite de salas activas alcanzado ({count})',
  'errors.roomNameInvalid': 'Nombre de sala no válido: "{name}"',
  'errors.invalidNickname': 'Apodo no válido: "{nickname}"',
  'errors.roomNotFound': 'No se encontró la sala #{name} con esa contraseña',
}
