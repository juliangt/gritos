# Gritos — Especificación funcional y técnica (v1)

|                              |                                                                   |
| ---------------------------- | ----------------------------------------------------------------- |
| **Estado**                   | Borrador v1.0 — aprobado para desarrollo                          |
| **Fecha**                    | 2026-10-03                                                        |
| **Fuentes**                  | `docs/wishlist.md` + decisiones de producto cerradas con el autor |
| **Documento complementario** | `docs/plan.md` (plan de desarrollo por milestones)                |

---

## 1. Visión y resumen

**Gritos** es una aplicación de chat descentralizado que funciona íntegramente en el navegador, **sin backend propio ni cuentas de usuario**. La señalización WebRTC se resuelve mediante trackers públicos de BitTorrent (a través de **Trystero**, estrategia _torrent_); una vez establecido el canal de datos, los mensajes viajan directos entre navegadores (topología _full mesh_) cifrados por DTLS, con capas E2EE adicionales para los mensajes directos (1 a 1) y para las salas protegidas con contraseña.

Principios rectores:

1. **Sin servidor**: todo el código es cliente; el despliegue es un bundle estático.
2. **Sin cuentas ni registro**: la identidad es un apodo + un par de claves generado localmente.
3. **Efímero por defecto**: los mensajes existen solo en memoria; al recargar, desaparecen.
4. **Mínima superficie de datos persistidos**: en `localStorage` únicamente quedan ajustes e identidad criptográfica.
5. **UI minimalista, rápida y limpia**: una sola columna de conversación, sidebar colapsable, cero ornamentos.

## 2. Decisiones de producto cerradas

| #   | Decisión                                         | Elección                                               | Consecuencia principal                                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Topología de salas                               | **Múltiples salas simultáneas desde v1**               | Cada sala activa mantiene su propia malla WebRTC; se aplica un límite configurable de salas activas (por defecto 4, máximo 6).  |
| D2  | Historial de mensajes                            | **Solo en memoria**                                    | Nada de mensajes se persiste; sin IndexedDB; sin sincronización _gossip_ entre pares. Quien entra tarde no ve mensajes previos. |
| D3  | Contenido de v1                                  | **Solo texto / Markdown**                              | Sin transferencia de archivos o imágenes (fase 2).                                                                              |
| D4  | Cifrado adicional                                | **DMs 1:1 con E2EE + salas con contraseña compartida** | ECDH P-256 + AES-GCM en DMs; PBKDF2 + AES-GCM en salas con contraseña.                                                          |
| D5  | Capacidad por sala (derivada de la arquitectura) | Grupos pequeños                                        | Full mesh: óptimo 6–15 pares por sala; degradación aceptable hasta ~20.                                                         |

> **Nota sobre D2**: la decisión "solo en memoria" aplica al **contenido** (mensajes, typing, presencia). Los **ajustes** y la **identidad criptográfica** sí persisten en `localStorage` (sección 8.2) porque son necesarios para la experiencia (tema, trackers, apodo estable) y forman parte de la sección 5 del wishlist. El _panic button_ (RF-08) borra absolutamente todo.

## 3. Alcance

### 3.1 En alcance (v1)

- Onboarding con apodo (manual o autogenerado) y auto-unión a `#lobby`.
- Salas: predefinidas (`#lobby`, `#general`, `#dev`, `#random`), unirse por nombre libre, múltiples salas simultáneas, abandonar sala.
- Salas con contraseña compartida (roomId derivado de la contraseña → existencia oculta en el tracker).
- Mensajería de texto en tiempo real con Markdown básico seguro, indicadores de escritura, acuses de recibo y menciones.
- Mensajes directos 1:1 cifrados E2EE entre pares que comparten al menos una sala.
- Presencia con estado de conexión e indicador de latencia por par.
- Ajustes: trackers personalizados, STUN/TURN personalizados, auto-join, tema, notificaciones de escritorio, límite de salas activas.
- Privacidad: silencio local de pares por fingerprint (issue #95), regeneración de identidad y _panic button_.
- Tema claro / oscuro / sistema.
- Despliegue como sitio estático.

### 3.2 Fuera de alcance (v1)

- Transferencia de archivos e imágenes P2P.
- Sincronización de historial entre pares (_gossip / state sync_) y persistencia local de mensajes.
- Salas masivas (>20 pares) o topologías de retransmisión (SFU).
- Mensajes editables o borrables, respuestas anidadas (_threads_), reacciones.
- TURN propio gestionado por el proyecto (solo configuración de TURN externo por el usuario).
- PWA / funcionamiento offline, i18n (la UI es en español), aplicaciones nativas.

## 4. Requisitos funcionales

Cada requisito incluye criterios de aceptación verificables. Los prefijos `RF-xx` se usan como referencia en el plan de desarrollo.

### RF-01 · Onboarding

El usuario entra a la URL y, si no existe identidad local, se le presenta una pantalla centrada con el nombre de la app, un campo de apodo y un botón "sorpréndeme" que autogenera un apodo amigable en español (formato `adjetivo-sustantivo`, p. ej. `zorro-bravo`, `luna-cauta`).

**Aceptación**

- El apodo admite 2–24 caracteres (`letras, números, espacio, guiones, guion bajo`); se recorta y normaliza el exceso de espacios.
- Con el campo vacío, "Entrar" genera un apodo aleatorio válido.
- Tras entrar, si `autoJoinLobby` está activo (por defecto sí) se une automáticamente a `#lobby`.
- La identidad (apodo + claves) queda en `localStorage`; en visitas posteriores no se vuelve a preguntar.
- Se puede cambiar el apodo en cualquier momento desde ajustes; el cambio se anuncia a los pares conectados.

### RF-02 · Salas

El usuario puede estar conectado a **varias salas a la vez**. Unirse a una sala no existe como acción de servidor: es suscribirse a un identificador común en el tracker.

**Aceptación**

- Salas sugeridas visibles: `#lobby`, `#general`, `#dev`, `#random`; un clic une (si hay hueco).
- Unirse por nombre libre: normalización `trim + minúsculas + espacios→'-'`, solo `[a-z0-9_-]`, longitud 1–32. Nombre inválido → mensaje de error en línea, sin modal de error.
- Límite de salas activas simultáneas: configurable (1–6, por defecto 4). Intento por encima del límite → aviso "Límite de salas activas alcanzado (N)".
- Alcanzado el límite, la UI ofrece abandonar una sala activa para unirse a la nueva.
- Cada sala activa muestra su propio estado de conexión (sección 10.3) y contador de pares.
- "Abandonar sala" cierra su conexión (libera la malla) y la elimina de la lista; opcionalmente se registra en "recientes".
- Lista de salas recientes (solo nombres, nunca contenido) si `rememberRooms` está activo; clic reúne a la sala. Los nombres de salas con contraseña no se registran y una entrada previa se purga al unirse con contraseña (issue #31).
- Un cambio de sala activa no interrumpe las demás conexiones; los mensajes de salas no activas incrementan su badge de no leídos.

### RF-03 · Mensajería de sala

Envío y recepción de texto en tiempo real en la sala activa.

**Aceptación**

- Entrada multilínea: `Enter` envía, `Shift+Enter` salto de línea; el campo crece hasta 6 líneas.
- Longitud máxima del mensaje: 4000 caracteres; la UI lo indica y bloquea el envío por encima.
- Render de Markdown **limitado y seguro**: `**negrita**`, `*cursiva*`, `` `código` ``, bloques ` ` ```, `[texto](https://…)` solo con esquemas `http`/`https`, saltos de línea. **Sin HTML crudo** (se escapa todo) y sin imágenes/vídeos (D3).
- Menciones: el texto `@apodo` resaltado si coincide (sin distinción de mayúsculas, con límite de palabra) con el apodo propio o de pares presentes.
- Indicadores de escritura: al teclear se emite `typing` con _throttle_ de 1 s; el estado expira a los 4 s. Se muestra "N personas están escribiendo…" bajo el feed.
- Acuses de recibo: cada mensaje propio muestra `✓` (enviado) y `✓✓` cuando **al menos un par** confirma recepción. En salas de un solo ocupante solo se ve `✓`.
- Scroll inteligente: auto-scroll solo si el usuario está a ≤150 px del fondo; en caso contrario, botón flotante "↓ N mensajes nuevos" que salta al final y limpia el contador.
- Cap de memoria: se retienen como máximo los últimos **500 mensajes por sala** (descarte FIFO, avisando en el feed con un separador "— earlier messages discarded —").
- Reloj: cada mensaje muestra hora local `HH:MM` a partir de `ts` del autor.

### RF-04 · Mensajes directos (DM) con E2EE

Conversación privada 1:1 con cualquier par con el que se comparta al menos una sala activa.

**Aceptación**

- Desde la lista de pares de una sala, clic en un par → "Mensaje directo". Se abre la conversación DM (vista tipo sala, encabezado con el apodo del otro y su _fingerprint_).
- Todos los mensajes DM viajan cifrados E2EE (sección 9.2); nadie más —ni otros pares de la sala compartida— puede descifrarlos.
- El encabezado del DM muestra el fingerprint del par (formato de sección 9.1) con el aviso "Compáralo con tu interlocutor para verificar su identidad".
- Los DMs heredan Markdown, typing, receipts, scroll inteligente y cap de 500 mensajes.
- Badge de no leídos por DM; los DM no leídos se notifican (RF-09) cuando la pestaña está oculta.
- Un DM deja de poder enviar mensajes si el par abandona todas las salas compartidas: estado "The peer has disconnected" y el historial del DM permanece visible en memoria hasta recargar.
- Limitación documentada y visible en UI: no hay DM con pares que no compartan sala (no existe un canal global; ver 11).

### RF-05 · Salas con contraseña compartida

Sala cuyo contenido se cifra con una clave derivada de una contraseña y cuya **existencia misma queda oculta** en el tracker.

**Aceptación**

- Al unirse/crear una sala, un campo opcional "Contraseña (sala cifrada)". Si se informa, la sala se marca con 🔒 en sidebar y encabezado.
- El `roomId` anunciado al tracker se deriva de `hash(appId + nombre + contraseña)` (sección 9.4): quien no conoce la contraseña **no puede descubrir ni entrar** a la sala — no es que no pueda leer, es que no la encuentra.
- Todos los mensajes de la sala viajan cifrados con AES-GCM-256 derivado de la contraseña (PBKDF2). La contraseña vive solo en memoria de sesión; **nunca se persiste**.
- Si un par consiguiera entrar sin clave (escenario teórico de derivación colisionante), vería únicamente el placeholder "🔒 mensaje cifrado" — nunca texto plano.
- Error de contraseña = error de sala inexistente: mismo mensaje "No se ha encontrado la sala #nombre con esa contraseña" (no se filtra cuál de los dos falló).
- Al recargar la página, las salas con contraseña deben re-unirse re-introduciendo la contraseña.

### RF-06 · Presencia y latencia

**Aceptación**

- Por cada sala, lista de pares conectados con apodo y punto de color de latencia: 🟢 <150 ms, 🟡 150–400 ms, 🔴 >400 ms, ⚪ sin datos (todavía sin respuesta o degradado).
- Medición: `ping`/`pong` cada 5 s por par y sala; 3 fallos consecutivos → estado degradado ⚪ hasta recuperar respuesta.
- Al conectar un par: se anuncian apodo, fingerprint y clave pública (acción `presence` + `keys`).
- Apodos duplicados en la misma sala se muestran con sufijo corto del peerId (`zorro-bravo·a3f1`) para desambiguar.
- Entrada/salida de pares se refleja en el feed con líneas de sistema discretas ("— luna-cauta joined —").

### RF-07 · Ajustes

Modal con tres pestañas. Todos los cambios se guardan en `localStorage` al instante.

**Red**

- Auto-unirse a `#lobby` al iniciar (on/off, por defecto on).
- Trackers personalizados (lista editable de URLs `wss://`). Si la lista está vacía se usan los de defecto de Trystero; si el usuario define lista, **sustituye** a los de defecto.
- Servidores ICE (STUN/TURN) personalizados (lista editable `stun:host:port` / `turn:host:port` con usuario y contraseña para TURN). Lista vacía = configuración por defecto de Trystero.
- Límite de salas activas (1–6, por defecto 4).
- Nota en la pestaña: "Los cambios de red se aplican al reconectar las salas", con botón "Reconectar todo".

**Privacidad**

- Notificaciones de escritorio (on/off + botón "Permitir notificaciones" que solicita el permiso).
- Recordar salas recientes (on/off, por defecto on).
- Regenerar identidad criptográfica (con confirmación y aviso de que el fingerprint cambia y las claves DM dejan de coincidir).
- Pares silenciados (issue #95): lista local de pares silenciados por fingerprint, con botón para dejar de silenciar; el apodo se muestra solo si el silencio data de la sesión actual.
- _Panic button_: "Borrar todo y salir" (ver RF-08).

**Apariencia**

- Tema: Claro / Oscuro / Sistema (por defecto Sistema).
- Colapsado inicial del sidebar (recordado).

### RF-08 · Panic button

**Aceptación**

- Botón en Ajustes → Privacidad con confirmación explícita ("Se borrarán apodo, claves, ajustes y todo rastro local. ¿Continuar?").
- Al confirmar: limpia **todas** las claves `gritos:*` de `localStorage`, aborta todas las conexiones WebRTC, vacía el estado en memoria y recarga la aplicación.
- Tras la recarga, la app aparece como primera visita (onboarding limpio).

### RF-09 · Notificaciones de escritorio

**Aceptación**

- Vía Web Notifications API, solo si el permiso fue concedido y el ajuste está activo.
- Se notifica únicamente: (a) mención `@mipesudo` en cualquier sala, (b) mensaje DM entrante — siempre y cuando `document.hidden === true`.
- La notificación muestra autor y sala/DM; el texto del cuerpo se muestra en claro (decisión de UX: la notificación es local al dispositivo del receptor).
- Clic en la notificación enfoca la pestaña y abre la sala o DM correspondiente.
- Sin permiso concedido, el ajuste queda deshabilitado con explicación de cómo activarlo.

### RF-10 · Temas

**Aceptación**

- Claro, Oscuro y Sistema (sincronía en vivo con `prefers-color-scheme`).
- Conmutación sin recargar la página ni perder estado; respeta contraste AA mínimo.

## 5. Requisitos no funcionales

| ID     | Categoría               | Requisito                                                                                                                                                                                                                        |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RNF-01 | Privacidad de datos     | Ningún contenido de mensaje, contraseña de sala, clave privada de pares o metadato de conversación sale del dispositivo hacia `localStorage` o externos. Las únicas escrituras persistentes son las de la sección 8.2.           |
| RNF-02 | Seguridad criptográfica | Todo lo cifrado usa exclusivamente Web Crypto (subtle). AES-GCM-256 con IV aleatorio de 96 bits por mensaje; ECDH P-256 + HKDF-SHA256 en DMs; PBKDF2-SHA256 ≥600 000 iteraciones en salas. Sin criptografía implementada a mano. |
| RNF-03 | Rendimiento             | Interacción <100 ms percibida en envío de mensaje; la malla soporta 15 pares por sala con mensajes de 4 KB sin pérdida perceptible; memoria acotada por los caps de mensajes (500/sala) y salas (≤6).                            |
| RNF-04 | Compatibilidad          | Últimas versiones estables de Chrome, Edge, Firefox y Safari (móvil incluido). Requiere contexto seguro (`https://` o `localhost`) para Web Crypto, WebRTC y notificaciones.                                                     |
| RNF-05 | Accesibilidad           | Navegación completa por teclado; feed con `aria-live="polite"`; modales con foco atrapado y cierre con `Esc`; contraste AA; sidebar usable como _drawer_ en móvil.                                                               |
| RNF-06 | Desplegabilidad         | El build de producción es 100 % estático (`dist/`); funciona en cualquier hosting de ficheros (GitHub Pages, Netlify, nginx local). Sin variables de entorno ni servicios externos obligatorios.                                 |
| RNF-07 | Trazabilidad de red     | Todos los estados de conexión son visibles para el usuario (nunca un "silencio" indistinguible de un fallo).                                                                                                                     |

## 6. Arquitectura

### 6.1 Diagrama general

```
┌──────────────────────────── Navegador A ────────────────────────────┐
│                                                                     │
│  UI (React + Tailwind)                                              │
│    │ useAppStore / useSettingsStore (Zustand)                       │
│    ▼                                                                │
│  RoomManager (lib/p2p)  ── una instancia Trystero por sala activa   │
│    │ joinRoom / makeAction / onPeerJoin / onPeerLeave / leave       │
│    ▼                                                                │
│  CryptoLayer (lib/crypto)  ── identidad, claves DM, clave de sala   │
│    ▼                                                                │
│  WebRTC DataChannels (DTLS) ════════════════════════╗               │
└─────────────────────────────────────────────────────╫───────────────┘
                                                      ║ (P2P directo,
┌───────────────────── Trackers BitTorrent (wss://) ──╫── señalización
│  handshake SDP inicial (offers/answers)             ║   únicamente)
└─────────────────────────────────────────────────────╫───────────────┘
                                                      ║
┌──────────────────────────── Navegador B ────────────╫───────────────┐
│  misma arquitectura  ═══════════════════════════════╝               │
└─────────────────────────────────────────────────────────────────────┘
```

Los trackers solo intervienen en el _discovery_ e intercambio SDP inicial. El tráfico de la aplicación nunca pasa por ellos.

### 6.2 Stack tecnológico

| Capa               | Tecnología                                      | Justificación                                                                                                                                           |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework UI       | React 18+ / Vite 6+ / TypeScript 5              | Compila a estáticos puros; tipado robusto para el protocolo. Versiones exactas fijadas en `package.json` al scaffold (M0).                              |
| Estilos            | Tailwind CSS                                    | Diseño utilitario, sin runtime, temas oscuro/claro nativos.                                                                                             |
| P2P / señalización | Trystero (`trystero/torrent`)                   | Señalización descentralizada sobre trackers públicos WebTorrent; abstrae WebRTC DataChannels. **Versión fijada exacta** — la API es estable pero joven. |
| Estado global      | Zustand                                         | Ligero, sin boilerplate, desacopla eventos de red de la UI.                                                                                             |
| Criptografía       | Web Crypto API (nativa)                         | ECDH, HKDF, PBKDF2, AES-GCM sin dependencias.                                                                                                           |
| Persistencia       | `localStorage` (ajustes e identidad únicamente) | Decisión D2: no hay IndexedDB en v1.                                                                                                                    |
| Tests              | Vitest + Testing Library                        | Unidades para cripto, Markdown y derivaciones.                                                                                                          |
| Markdown           | Renderizador propio de subset (React)           | Sin `marked`/`DOMPurify`: el subset es pequeño y evita dependencias y superficie de XSS de terceros.                                                    |

### 6.3 Flujo de conexión de una sala

1. El usuario elige sala (y contraseña opcional). Se calcula `roomId = hash(appId + nombre [+ contraseña])` (9.4).
2. `joinRoom(config, roomId)` con `config = {appId, trackers?, rtcConfig?}`.
3. Trystero abre WebSockets a los trackers y anuncia su peerId en el hash del roomId.
4. Otro cliente con el mismo roomId recibe la lista de pares; intercambian ofertas/respuestas SDP **a través del tracker**.
5. Se establece DataChannel directo (DTLS). `onPeerJoin(peerId)` dispara en ambos.
6. Al unirse un par: envío inmediato de `presence` (apodo, fingerprint) y `keys` (clave pública ECDH). Arranca el bucle `ping/pong`.
7. Los trackers dejan de ser necesarios mientras la pestaña viva; si caen, los pares ya conectados siguen comunicando (solo se pierde la capacidad de descubrir nuevos pares).

### 6.4 Flujo de un mensaje de sala (sin contraseña)

1. Autor escribe → `Envelope{kind:'chat'}` → `sendChat(envelope)` broadcast a los pares de la sala.
2. Cada receptor: valida `v`, deduplica por `id`, descifra si `enc`, añade al store, hace scroll inteligente si procede, emite `receipt` dirigido al autor.
3. El autor marca `✓✓` con el primer `receipt` recibido.
4. Con contraseña: `body` = base64(IV ‖ ciphertext AES-GCM) y `enc: true`; idéntico en lo demás.

### 6.5 Gestión multi-sala

- `RoomManager` mantiene un `Map<roomId, RoomConnection>`; cada `RoomConnection` encapsula su instancia Trystero, sus acciones registradas y su bucle de ping.
- Unirse/abandonar es independiente por sala; el cap de salas activas se valida en el manager antes de llamar a `joinRoom`.
- Los pares se identifican por peerId global (Trystero); el mismo peerId en dos salas es el mismo par — la lista de "pares" de la UI agrega por sala y el DM usa el primer canal compartido disponible.

## 7. Protocolo de aplicación

### 7.1 Acciones Trystero (por sala)

Las tres acciones del canal global de señal (issue #105: `whoami`, `knock`, `knock-ack`) se listan aquí por completitud del cable Trystero, pero NO viven en los enjambres de sala: su superficie es el enjambre dedicado de 12.5, que solo el gestor de señal une (su hogar único es `lib/p2p/signalChannelConstants.ts`, deliberadamente fuera del protocolo de sala de §7).

| Acción (`makeAction`) | Alcance                                                                                  | Payload                                                                   | Uso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence`            | broadcast (al conectar y al cambiar apodo)                                               | `{nick: string, fp: string}`                                              | Anuncio de apodo y fingerprint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `keys`                | broadcast (al conectar)                                                                  | `Uint8Array` (clave pública ECDH P-256 cruda, 65 B)                       | Anuncio de la clave de identidad: fingerprint visible en la UI, ancla TOFU (8.2) y una de las dos parejas de fingerprints de la sal DM v2 (9.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ephkeys`             | dirigido (al conectar y al regenerar identidad)                                          | `Uint8Array` (clave pública efímera de sesión ECDH P-256 cruda, 65 B)     | Anuncio de la clave efímera de sesión para la derivación DM v2 (issue #93; 9.2, 12.1). Vive solo en memoria, jamás se persiste y no se fija por TOFU: `gritos:tofu` sigue anclando solo fingerprints de identidad (8.2). Un par conectado sin este anuncio es un build v1 (12.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `chat`                | broadcast                                                                                | `Envelope` JSON                                                           | Mensaje de sala (plano o cifrado por contraseña).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dm`                  | dirigido al destinatario (`target`, issue #18)                                           | `Envelope` JSON (`kind:'dm'`, siempre cifrado)                            | Mensaje directo E2EE entre A↔B: el sobre cifrado solo llega al destinatario — el resto de la malla de la sala no lo captura, evitando el perfilado por metadatos (quién escribe a quién, volumen, tiempos). El filtro local del `to` en el receptor (7.3) queda como defensa en profundidad ante pares antiguos que aún difunden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `typing`              | broadcast                                                                                | `{on: boolean}`                                                           | Indicador de escritura.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `receipt`             | dirigido al autor                                                                        | `{ids: string[]}`                                                         | Acuse de recibo (batch, máx. 50 ids).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `react`               | broadcast, o dirigido al destinatario (`to`)                                             | `{ids: string[], emo: string, on: boolean, to?: string}`                  | Reacción emoji (issue #98): lote de 1–50 ids de mensaje (mismo molde que `receipt`), `emo` de la lista blanca fija (👍 ❤️ 😂 😮 😢 🎉 👎) y `on` alterna (true = reaccionar, false = retirar). Sin `to` es difusión a toda la sala — cada par mantiene sus conteos locales. Con `to` es una reacción de DM dirigida al destinatario: viaja por el enjambre de la sala apuntado al par (como `dm`/`receipt`) de modo que el resto de la sala no la ve; el receptor descarta la dirigida a otro par y jamás la retransmite (7.3). Recepción acotada (clase cosmética, 9.5): el payload inválido se descarta entero y en silencio, tope de 30 payloads por par y minuto, deduplicación por contenido en el `BoundedSeenIds` por conexión — la clave es el propio payload, no un id de sobre, de modo que la repetición idéntica cae y el toggle inverso pasa —, y los ids desconocidos o ya evacuados (FIFO/TTL) se sueltan en silencio al aplicar el estado. Jamás notifica, marca no leídos ni persiste. Mixed-build: los pares antiguos ignoran la acción entera sin disturbar las demás (spike en 12.3).                                                                                                                                                                                                      |
| `hist-req`            | broadcast (solo bajo petición explícita del usuario)                                     | `{n: number}`                                                             | Chisme de historial opt-in (issue #102): el recién llegado pide expresamente los últimos `n` mensajes de chat de la sala — la tarjeta «Ask the room for the latest messages?» de un solo toque, 10.4 — con `n` entero en 1..50 (`MAX_HISTORY_REQUEST`); cualquier otra forma o valor se descarta en silencio (7.3). Doble presupuesto de 1 petición/minuto: el propio de quien pregunta, por sala (un toque con la sala aún buscando pares se ESTACIONA y sale con la primera unión de par, 10.3) y el del receptor por par (la petición de un par silenciado no llega ni al parseo). La acción jamás responde por sí sola: honrarla es decisión del consentimiento del receptor (8.1, `shareHistory`, por defecto silencio).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `hist`                | broadcast                                                                                | `{batch: Envelope[]}`                                                     | Chisme de historial (issue #102): un lote de 1–20 sobres `chat` re-validados con `parseEnvelope` — jamás DMs (ámbito de sala) ni líneas de sistema. El emisor trocea por tamaño MEDIDO: ≤ 20 sobres y ≤ 48 KiB de JSON codificado por lote (`chunkHistBatches`), margen bajo el tope de 64 KB de 7.3, y en salas con contraseña re-sella los cuerpos con la clave de la sala (IVs nuevos): solo quien conoce la contraseña puede leer lo reenviado. Recepción (reglas de repetición, 7.3): silencio local del compartidor antes de parsear, el lote entero se tira ante cualquier violación, tope de 6 lotes por par y minuto (≤ 120 mensajes/min/par) y deduplicación por id en el `BoundedSeenIds` de la conexión — un reenvío EN VIVO posterior del mismo id cae también. Cero efectos de transporte: nada de no leídos, menciones, acuses (✓✓ significa entrega EN VIVO) ni typing.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `file-meta`           | dirigido al par destinatario (`target`, como `dm`/`receipt` — jamás broadcast, 12.4)     | `{id, name, size, mime, chunks, enc}` (JSON)                              | Oferta de archivo (issue #103, 12.4): transferencia dirigida 1:1 — solo el par que ACEPTA recibe bytes; un «archivo para la sala» son N transferencias independientes. Validación `parseFileMeta` (12.4): `id` no vacío; `name` saneado con la disciplina del apodo remoto (issue #28) y tope propio de 120 (`FILE_NAME_MAX_LENGTH`) — si no queda nada legible el meta entero es inválido: el nombre ES la tarjeta de consentimiento; `size` entero en 1..20 MB (`MAX_FILE_BYTES`); `chunks` EXACTO — `ceil(size / FILE_CHUNK_PAYLOAD_BYTES)` — lo RECALCULA el receptor desde `size` y descarta la deriva; `mime` display-only de ≤ 100 caracteres (`FILE_MIME_MAX_LENGTH`, el vacío es legítimo); `enc` booleano REQUERIDO sin default (gobierna la ruta criptográfica de cada chunk). Antes de la aceptación no fluye ni un byte. Puerta de silenciado (issue #95) antes de cualquier parseo — vale para LAS CINCO acciones de archivo; tope de `FILE_OFFER_RATE_CAP` ofertas por par y minuto (el exceso se descarta en silencio) y `MAX_TRANSFERS_PER_PEER` transferencias concurrentes por par en AMBOS lados — la cuarta oferta entrante se responde con `file-abort` explícito («el par está ocupado»). Cero efectos de llegada: la tarjeta ES el aviso (sin no leídos, sin notificación, sin acuse). |
| `file-chunk`          | dirigido al par receptor (`target`)                                                      | `Uint8Array` binario: `[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]` | Datos del archivo (12.4). `fileId` = los primeros 8 bytes del SHA-256 del `id` del meta; `seq` uint32 big-endian basado en 1 (`1..chunks`); el payload viaja con ≤ 16 KiB POST-sellado — la rebanada de texto claro es `FILE_CHUNK_PAYLOAD_BYTES = 16 356` en AMBOS modos (sellada crece 28 B fijos de IV+etiqueta GCM) y el frame completo queda ≤ 16 396 B, bajo el tope de 64 KB de 7.3. El receptor solo casa el prefijo contra SUS transferencias en `transferring` de ESE par (12.4): chunk de transferencia desconocida, fuera de rango, repetido, con hueco (disciplina contigua) o sin crédito otorgado → descarte silencioso; el primer byte que empujaría el acumulado más allá de `size` aborta EN EL ACTO. Ventana de crédito `FILE_CREDIT_WINDOW = 8` chunks sin acuse como máximo en vuelo (misma puerta de silenciado del `file-meta`).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `file-ack`            | dirigido al emisor (`target`)                                                            | `{id, nextSeq, grant}` (JSON diminuto)                                    | Crédito del receptor (12.4): `nextSeq` es la siguiente secuencia esperada (todo lo anterior llegó contiguo) y `grant` (0..`FILE_CREDIT_WINDOW`) son créditos nuevos — el receptor re-otorga la ventana completa en cada acuse. El PRIMER `file-ack {id, nextSeq: 1, grant: 8}` ES la aceptación de la oferta (no existe acción de «aceptar» aparte) y arranca el flujo; el acuse final `{id, nextSeq: chunks + 1, grant: 0}` completa al emisor. Un chunk queda acusado cuando un acuse anuncia `nextSeq > seq`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `file-end`            | dirigido al par receptor (`target`)                                                      | `{id}` (JSON)                                                             | Cierre del EMISOR («último chunk despachado», 12.4): se envía justo tras despachar el último chunk — es la señal de «último despachado», no una barrera de acuses (el acuse final es la que completa al emisor). El receptor lo usa para fallar rápido si le falta algún chunk, en vez de esperar el stall de 30 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `file-abort`          | dirigido al par (`target`)                                                               | `{id}` (JSON)                                                             | Cancelación de cualquiera de las partes o rechazo de la oferta (12.4): declinar la oferta, cancelar a mitad de transferencia (el receptor libera lo acumulado en el acto), la cancelación local con `file-abort` al otro lado y el rechazo explícito por cap de concurrencia. En el extremo que recibe, un `file-abort` sobre una oferta en `offer` se ve como `rejected`; después, como `aborted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `whoami`              | enjambre de señal global (12.5), no los de sala: difusión al conectar y al cambiar apodo | `{nick, fp}` (JSON)                                                       | Presencia del canal global (issue #105, 12.5): el molde de `presence` sobre el enjambre de señal, con las mismas reglas de forma — `fp` canónico y `nick` legible (`parseWhoami`; violación → descarte ENTERO y silencioso, 7.3) — y los mismos re-anuncios no periódicos (solo conexión y cambio de apodo). La lista acota `MAX_SIGNAL_PRESENCE = 100` entradas con expulsión LRU — estado del motor, jamás un listado navegable en la UI: el único camino de descubrimiento es el golpe por huella. Única exposición: apodo y huella (9.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `knock`               | dirigido al par destino DENTRO del enjambre de señal global (`target`; 12.5)             | `{type:'knock', from:{fp, nick}, note?}` (JSON)                           | La puerta (issue #105, 12.5): golpear por huella a un par opt-in sin sala compartida. Sin campo de contenido: la nota opcional de ≤ 140 caracteres (`NOTE_MAX_LENGTH`) es TODO lo que un golpe puede decir. Recepción en orden: puerta de silenciado ANTES de parsear (issue #95 — doble: contra la huella derivada de las claves anunciadas y contra la huella declarada del golpe; el exceso de ingenio solo silencia al propio spoofer), tope de `KNOCK_RATE_CAP = 5` golpes RECIBIDOS por par y minuto (el exceso se descarta en silencio, misma clase que `FILE_OFFER_RATE_CAP` en 12.4) y validación `parseKnock` — cualquier violación descarta el payload ENTERO (7.3). El golpe además DECLARA el `fp` del golpeador (orientativo, como el de `presence`): el ancla cripto sigue siendo la resolución por claves (9.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `knock-ack`           | dirigido de vuelta al golpeador (`target`; 12.5)                                         | `{accept, fp}` (JSON)                                                     | La respuesta (issue #105, 12.5): `accept` es un booleano REQUERIDO sin default — el consentimiento que abre (o niega) el canal signal-backed en AMBOS lados — y `fp` es la huella canónica del golpe acusado (la del golpeador, eco del `from.fp` recibido): el golpeador puede esperar varios acks y casa el suyo por huella. Un ack que no casa con un golpe propio pendiente se descarta en la capa del gestor (12.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ping`                | dirigido por par                                                                         | `{t: number}`                                                             | Marca temporal del emisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pong`                | dirigido                                                                                 | `{t: number}`                                                             | Eco del `t` recibido → RTT = ahora − t.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 7.2 Sobre de mensaje (`Envelope`)

```jsonc
{
  "v": 1, // versión por kind: chat y plano de control exigen v=1, dm exige v=2 (issue #93); otro valor → ignorar silenciosamente (7.3)
  "id": "uuid-v4", // crypto.randomUUID() — deduplicación
  "ts": 1760000000000, // Date.now() del autor
  "from": "peerId-trystero",
  "nick": "zorro-bravo", // apodo del autor en el momento del envío
  "kind": "chat", // "chat" | "dm"
  "to": "peerId", // solo en kind:"dm"
  "enc": false, // true si body es base64(IV ‖ ct)
  "iv": null, // base64 de 12 B cuando enc
  "body": "hola mundo", // texto plano | base64(ciphertext) | máx. 4000 car. en claro
  "ttl": 300, // opcional (issue #96): caducidad en segundos enteros, 30–3600 inclusive; ausente = el mensaje vive toda la sesión (7.3)
}
```

**El campo `ttl` (issue #96)** es aditivo y **no estrena versión**: `v` sigue siendo por `kind` — `chat` v:1, `dm` v:2 (issue #93) — y un sobre con `ttl` viaja exactamente con la versión que le corresponde por su `kind`. La degradación con builds mezclados es la ya documentada en 7.3 para campos desconocidos: un build antiguo ignora el campo en silencio y **conserva el mensaje toda la sesión** (nunca falla al parsearlo). Un `ttl` presente pero inválido (0, negativo, fuera de rango, no entero, no numérico) invalida el **sobre entero**, que se descarta como cualquier otra violación de campo — jamás solo el campo, para que un mensaje no degrade silenciosamente a una vida distinta de la que pidió el autor.

### 7.3 Reglas del protocolo

- **Deduplicación**: todo mensaje con `id` ya visto se descarta (los receipts batch y la malla completa pueden duplicar).
- **Orden**: se muestra por orden de llegada; dentro de una ventana de 2 s se ordena por `ts`. No hay orden global consensuado (sin servidor) — documentado como limitación aceptable para chat informal.
- **Tamaño**: cuerpo ≤4000 caracteres en claro; payloads binarios >64 KB se descartan por seguridad.
- **Desconexión**: `onPeerLeave` limpia presencia y typing del par en esa sala; sus DMs quedan en modo "par desconectado".
- **Compatibilidad y versionado**: los campos desconocidos del Envelope se ignoran; `v` es discriminatorio por `kind` — `chat` exige `v: 1` y `dm` exige `v: 2` (issue #93) — y cualquier otro valor se descarta en silencio. En salas con builds mezclados, un par v1 descarta en silencio los `dm` v2 y un par nuevo los `dm` v1, en ambas direcciones, hasta que las builds convergen (12.1). El `ttl` (issue #96, 7.2) es el ejemplo canónico de campo aditivo: un build antiguo lo ignora y conserva el mensaje toda la sesión — la caducidad es cortesía de cada receptor, nunca una garantía del emisor.
- **Caducidad por mensaje (issue #96)**: un sobre con `ttl` (7.2) caduca **en el reloj del receptor**: al añadirlo al feed, cada par calcula `expiresAt = receivedAt + ttl·1000`, donde `receivedAt` es el `Date.now()` local de ese instante — el `ts` del autor solo se tolera con un sesgo de ±90 s y **jamás se usa para expirar**. Un barrido de 1 s (un único temporizador por sesión, sobre todas las salas y DMs; el scan queda acotado por el cap FIFO de 500 por feed) retira el mensaje vencido — inclusivo: `expiresAt ≤ now` — y sin `ttl` el mensaje vive toda la sesión (el cap FIFO sigue siendo la única evacuación; un mensaje expirado **libera su hueco** antes de que el cap importe). El retiro deja un separador local "— N expired messages —" (espejo del de FIFO), solo en memoria y acumulativo por feed mientras viva. Dos garantías del barrido: **no resurrección** — los ids retirados pasan a un conjunto acotado de expirados, de modo que una repetición del sobre cuya entrada de dedup ya fue evacuada se descarta antes de cualquier efecto (sin feed, sin acuse, sin mención) — y **no retrotoque** — los acuses ya entregados no se revocan, y los no leídos y las notificaciones (menciones y DMs, RF-09) disparadas en la recepción no se deshacen: la caducidad solo muta el feed.
- **Chisme de historial opt-in (issue #102)**: un par que entra tarde puede pedir el historial reciente (7.1, `hist-req` — un toque explícito, jamás automático, presupuestado a 1/min por sala) y solo los pares que dieron su consentimiento (`shareHistory`, 8.1, por defecto **false**) responden reenviando como `hist` (7.1) como máximo los últimos 50 mensajes de chat de su feed en memoria — jamás líneas de sistema, placeholders cifrados o filas ya expiradas, y **nunca DMs** (ámbito de sala). Reglas de la repetición (_replay_) en el receptor: la validación de forma es completa (`parseEnvelope`: puerta `chat` v:1, formas, topes de cuerpo, validez del `ttl`) y la ÚNICA regla de frescura que se relaja es la ventana de antigüedad de 5 minutos (issue #19) — bypass deliberado, que es el punto del chisme: lo recuperado es más viejo de 5 minutos por definición —; el sesgo de futuro de ±90 s se conserva por sobre (`isWithinFutureSkew`), porque una marca a futuro lejano seguiría «fresca» —y arriba del bloque recuperado— durante horas. La deduplicación vale en ambas direcciones: los ids de un lote se marcan vistos al recibirlos, de modo que un reenvío EN VIVO posterior del mismo id cae (y un id recibido en vivo antes hace caer su copia reenviada). Cero efectos de llegada: ni no leídos, ni notificación de mención, ni acuse (el ✓✓ significa entrega en vivo), ni typing. Tope de recepción: a lo sumo 50 recuperados por sesión de unión y sala (`MAX_RECOVERED_PER_JOIN`); el exceso de los lotes siguientes se suelta en silencio. Orden: la ventana de 2 s (regla de Orden, arriba) NO aplica a lo reenviado — un lote repite historial cuyo `ts` del autor está lejos de cualquier ventana de llegada, y reordenar por `ts` barajearía el bloque —: las filas se adjuntan en orden de lote (el del cable), el mismo orden antiguo→nuevo en que el compartidor cortó su porción. Puerta de autor silenciado (issue #95, paridad en el momento de adjuntar): la huella del AUTOR del sobre reenviado —su `from`, no la del compartidor— se resuelve entre las claves anunciadas a ESTA conexión y un autor silenciado se descarta; si sus claves nunca aterrizaron aquí, falla en abierto como la ruta en vivo (arriba). `ttl` en la recuperación: `expiresAt = Date.now() + ttl·1000` en el reloj del RECEPTOR al adjuntar — jamás derivado del `ts` del autor, para no resucitar un zombi — y un id ya barrido por la caducidad (issue #96) no resucita jamás por chisme. Salas con contraseña: los sobres `enc` se abren con la clave de la sala (fila en claro) o quedan como el placeholder «🔒 mensaje cifrado» si no abren — el ciphertext crudo jamás aterriza como texto, y un sobre `enc` que llega a una sala sin clave se descarta. Procedencia y confianza: las filas recuperadas se renderizan ligeramente atenuadas bajo el separador «— messages recovered from peers —», que etiqueta la procedencia con honestidad — un par chismoso puede FORJAR historial (mensajes viejos falsos) al mismo nivel de confianza que el chat en vivo (9.5, plano de control sin autenticar). Nada se persiste: el conjunto compartido muere con las pestañas que lo sostienen, igual que los mensajes — el botón de pánico (RF-08) no necesita nada especial.
- **Silencio**: jamás se retransmite un mensaje recibido a terceros (no hay relay en v1; el `to` de un `dm` ajeno se ignora y se descarta).
- **Silenciado local (issue #95)**: la lista `mutedFingerprints` (8.1) filtra las rutas de recepción por el fingerprint de identidad del par —el derivado de sus claves anunciadas (9.1), no el `fp` auto-declarado del anuncio `presence`—. De un par silenciado se descartan: el `chat` de sala, antes de parsear, deduplicar, añadir al feed, valorar menciones (y su notificación, RF-09) o encolar el acuse; el `dm` dirigido, antes de cualquier trabajo (sin canal nuevo, sin hueco de dedup, sin descifrado); los indicadores `typing` (sala y DM); y las líneas de sistema de unión/salida —el par queda «sin anunciar»: levantado el silencio, su siguiente `presence` revela la línea diferida—. De ese mismo par se siguen procesando `receipt` y `ping/pong` (los ✓✓ y los puntos de latencia siguen honestos) y los anuncios `keys`/`ephkeys` con su pin TOFU (8.2). Carrera: un sobre que llega antes del anuncio de claves del autor se procesa (_fail-open_; el anuncio aterriza en la misma ráfaga de unión, 6.3).

## 8. Modelo de estado y datos

### 8.1 Estado en memoria (Zustand)

```ts
interface Settings {
  autoJoinLobby: boolean // default: true
  trackers: string[] // [] = defaults de Trystero; si hay lista, sustituye
  iceServers: RTCIceServer[] // [] = default; soporta stun: y turn: con credenciales
  maxActiveRooms: number // 1..6, default: 4
  theme: 'light' | 'dark' | 'system' // default: 'system'
  notifications: boolean // default: false (requiere además permiso del navegador)
  rememberRooms: boolean // default: true
  mutedFingerprints: string[] // issue #95 — pares silenciados, por fingerprint en forma canónica (9.2: sin espacios, mayúsculas); default: []. Tope de 100: la 101.ª se rechaza y una lista sobre el tope hallada al cargar se descarta entera (nunca se recorta). Vive dentro de gritos:settings (8.2), de modo que el panic button la borra
  shareHistory: boolean // issue #102 — chisme de historial opt-in (el interruptor «Share my recent history with late joiners» de Ajustes → Privacidad): solo en true una petición `hist-req` explícita (7.1) puede responderse con como máximo los últimos 50 mensajes de chat de esa sala en memoria (jamás DMs ni líneas de sistema, 7.3). Default: false — el silencio por defecto. Vive dentro de gritos:settings (8.2), de modo que el panic button lo borra
  globalDm: boolean // issue #105 — canal global de DMs opt-in (12.5): unir el enjambre de señal bien conocido y admitir golpes por huella (el interruptor «Canal global de DM» de Ajustes → Privacidad). Default: false — apagado; unirse expone IP, huella y apodo ante el enjambre (9.5), así que activarlo es una decisión de privacidad visible, jamás silenciosa. Vive dentro de gritos:settings (8.2), de modo que el panic button lo borra; apagarlo deja el enjambre EN EL ACTO y destruye su estado en memoria y sus canales (12.5)
}

interface Identity {
  nickname: string
  fingerprint: string // hex, ver 9.1
  createdAt: number
  // claves: CryptoKey en memoria; JWK (pública y privada) persistidas en localStorage
}

interface Peer {
  id: string // peerId Trystero (estable por sesión)
  nickname: string
  fingerprint: string | null // tras recibir 'keys'
  latencyMs: number | null // último RTT conocido
  degraded: boolean // 3 pings sin respuesta
}

interface Message {
  id: string
  roomId: string // id de sala | `dm:<peerId>`
  authorId: string // peerId | 'self'
  authorNick: string
  text: string
  ts: number
  encrypted: boolean // se recibió cifrado (contraseña de sala)
  status: 'sent' | 'delivered' // solo aplica a mensajes propios
  expiresAt?: number // issue #96 — instante de caducidad en el reloj del receptor (receivedAt + ttl·1000, 7.3); sin ttl = vive toda la sesión
  reactions?: Partial<Record<ReactEmoji, string[]>> // issue #98 — reacciones emoji agregadas: peerIds por emoji de la lista blanca fija (7.1). Tope de 7 claves —toda la lista blanca: el tráfico honrado jamás alcanza más— y de 50 peerIds por emoji: el 51.º se rechaza, jamás se expulsa (misma disciplina refuse-not-evict que los receipts). Una clave que se vacía se elimina y el mapa vacío vuelve a undefined: sin estado fantasma tras retirar la reacción. Clase cosmética (9.5): solo memoria — muere con su fila (cap FIFO o barrido TTL, 7.3) y jamás notifica, marca no leídos ni persiste
  recovered?: boolean // issue #102 — procedencia: la fila entró por la recuperación del chisme de historial opt-in (7.3), no por llegada en vivo. Se renderiza ligeramente atenuada bajo el separador «— messages recovered from peers —» (10.4); puramente presentacional: las filas recuperadas jamás marcan no leídos, notifican ni acusan (el ✓✓ significa entrega en vivo)
}

interface Room {
  id: string // hash derivado (9.4)
  name: string // normalizado, sin '#'
  hasPassword: boolean
  status: 'searching' | 'connected' | 'error'
  peers: Peer[] // pares de ESTA sala
  messages: Message[] // cap 500 FIFO
  typing: Record<string, number> // peerId → ts última señal typing
  unread: number
  expiredCount: number // issue #96 — mensajes TTL retirados por el barrido de este feed; alimenta el separador local (espejo del FIFO, 7.3)
  recoveredCount: number // issue #102 — filas de chat que este feed aceptó por la recuperación del chisme de historial opt-in (alimenta el separador local «— messages recovered from peers —», 7.3). Misma semántica retenida que `expiredCount`: por feed, nunca decrece (el FIFO o la caducidad pueden retirar filas después — el separador registra lo que ya pasó) y un leave/rejoin empieza en 0
  historyAskDismissed: boolean // issue #102 — despido de la tarjeta de petición de historial por cualquiera de sus dos botones (10.4); solo memoria, por unión: la fila se recrea en cada unión, de modo que la oferta vuelve en la siguiente (el presupuesto de petición de 7.1 acota los envíos reales)
}

interface DmChannel {
  peerId: string
  peerNick: string
  messages: Message[] // cap 500 FIFO
  unread: number
  expiredCount: number // issue #96 — mismo acumulador de expirados que Room, para el separador del canal DM
  available: boolean // false si no comparte ninguna sala
  global?: boolean // issue #105 — marcador aditivo, true SOLO en los canales respaldados por el enjambre de señal (clave: huella canónica, 12.5): DmList muestra el «(global)» para ellos, hermano del «(sin sala)» manual. Los canales de sala jamás lo fijan
}

interface AppState {
  identity: Identity | null
  rooms: Record<string, Room> // key: room.id
  activeView: { kind: 'room'; id: string } | { kind: 'dm'; peerId: string } | null
  dms: Record<string, DmChannel> // key: peerId (canales de sala) | huella canónica (canales globales, 12.5 — namespaces disjuntos)
  recentRooms: string[] // solo nombres
}
```

**Transferencias de archivos (issue #103, 12.4): el mapa `fileOffers` NO vive en `AppState`.** La representación decidida en 12.4 — `fileOffers: Record<string, FileTransferRecord>` con clave `${peerId}:${meta.id}`, en memoria solo, jamás una fila del feed — vive en el MOTOR (`lib/p2p/fileTransfer.ts`): el store queda intacto y la UI la lee por snapshot (`getFileTransfers`) más las costuras de eventos (`onFileOffer`/`onFileProgress`/…), de modo que el cap FIFO de 500 y el barrido TTL gobiernan MENSAJES y jamás revocan una URL ni expulsan un archivo a mitad de vista — la tarjeta vive y muere con su registro del mapa, y el despido explícito (`revokeTransferUrl`) es quien revoca la URL. Cero efectos de llegada: ninguna acción de archivo marca no leídos, notifica, acusa ni menciona (silencio de 7.3) — la tarjeta ES el aviso. **No estrena clave de persistencia** (8.2): el invariante de las cinco claves `gritos:*` queda intacto — el pánico (RF-08) no necesita borrado adicional porque `abortAllFileTransfers` revoca cada URL y vacía los mapas en la misma pasada (misma costura que los DMs manuales, 12.2), y regenerar identidad (RF-07) hace lo propio con `abortAllOnIdentityRegeneration`. Recargar lo pierde todo: blobs, URLs, ofertas y progreso son efímeros por diseño.

**Canal global de señal (issue #105, 12.5): los canales respaldados por él viven en ESTA porción `dms`, y el resto de su estado NO vive en `AppState`.** La clave del canal es la huella de identidad canónica — la dirección del producto (9.1) — y el marcador aditivo `global: true` alimenta el «(global)» de DmList; no colisiona con las claves de sala porque los peerIds Trystero y las huellas de 32 hex son namespaces disjuntos. Todo lo demás del canal es estado del MOTOR en memoria (`lib/p2p/signalChannel.ts`): la presencia LRU de 100, los golpes entrantes y pendientes, los presupuestos de golpe y los acks en vuelo — jamás filas de `AppState` ni claves nuevas: el invariante de las cinco claves `gritos:*` (8.2) queda intacto, y apagar `globalDm` o el pánico (RF-08) destruyen enjambre y estado en la misma pasada, sin código de borrado adicional. El único rastro persistido posible son los pins TOFU de los pares con canal ABIERTO (8.2, bajo su huella canónica en `gritos:tofu`): la presencia sola jamás escribe pins — el enjambre no puede dejar un directorio de extraños persistido. Recargar lo pierde todo menos esos pins: los canales globales son por sesión, como los de sala y los manuales.

### 8.2 Claves de `localStorage` (única persistencia de v1)

| Clave             | Contenido                                                                                                                                  | Se borra con panic |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `gritos:settings` | `Settings` (JSON), incluida la lista de silenciados (issue #95)                                                                            | ✅                 |
| `gritos:identity` | `{nickname, fingerprint, createdAt, pubJwk, priv}` (JSON) — `priv` es un sobre cifrado (issue #24), nunca la JWK privada en claro          | ✅                 |
| `gritos:rooms`    | `{recent: string[]}` — solo nombres si `rememberRooms`; nunca nombres de salas con contraseña (issue #31: el alta las excluye y las purga) | ✅                 |
| `gritos:ui`       | `{sidebarCollapsed: boolean}`                                                                                                              | ✅                 |
| `gritos:tofu`     | `{peerId: fingerprint}` — primera huella vista por par; detecta la rotación de claves (issue #22, TOFU)                                    | ✅                 |

La lista de silenciados (issue #95) no estrena clave: viaja en el campo `mutedFingerprints` de `gritos:settings` (8.1), de modo que el invariante de exactamente cinco claves `gritos:*` queda intacto y el _panic button_ (RF-08) la borra sin código adicional. Los pines de los pares manuales de #97 (12.2) tampoco estrenan clave: comparten `gritos:tofu` bajo el prefijo reservado `manual:<huella-canónica>` — la misma clave, el mismo borrado de pánico.

Además de `localStorage`, desde la issue #24 existe un pequeño almacén en **IndexedDB** (base de datos `gritos`, almacén `keys`, registro `identity-wrap`): la clave AES-GCM-256 **no exportable** que envuelve la JWK privada. Se borra con panic. Sin IndexedDB (o si falla al abrir), el sobre degrada a `{v:0, plain}` — texto en claro, comportamiento idéntico al previo a #24.

**No se persiste jamás**: mensajes, contraseñas de sala, nombres de salas con contraseña (issue #31), claves DM derivadas, presencia, latencias, peerIds — ni la JWK privada sin envolver (issue #24: `gritos:identity` guarda `priv = {v:1, iv, ct}` cifrado con AES-GCM; los registros previos con `privJwk` en claro se migran al sobre en cuanto se restauran).

## 9. Diseño criptográfico

Todo con Web Crypto (`crypto.subtle`). Ninguna primitiva implementada a mano.

### 9.1 Identidad

- Par de claves **ECDH P-256** generado localmente en el primer arranque (o al regenerar identidad).
- Clave pública exportada en crudo (65 B) para el intercambio; JWK pública persistida en claro y **JWK privada cifrada en reposo** (issue #24): envuelta con AES-GCM mediante una clave no exportable guardada en IndexedDB — distinto almacén que `localStorage`, de modo que un volcado de este último ya no basta para robar la identidad. Sin IndexedDB el sobre degrada a texto en claro (compromiso asumido: mismo origen, sin servidor; ver modelo de amenazas).
- **Fingerprint** = SHA-256(clave pública cruda) → hex, primeros 16 bytes (128 bits) en 8 grupos: `A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678`. Sirve para verificación manual de identidad en DMs (TOFU). Issue #23: 128 bits elevan el coste de una colisión de cumpleaños de ~2³² a ~2⁶⁴ pruebas. La ampliación es solo de presentación: la clave ECDH y las identidades persistidas no cambian (el fingerprint se recalcula desde la clave al restaurar).

### 9.2 Clave DM (1:1)

La derivación vigente es la **v2** (issue #93; nota de diseño en 12.1): el secreto DM procede de un ECDH **efímero de sesión**, no de las claves de identidad de larga vida.

1. Cada par genera un par ECDH P-256 **efímero por sesión de la app** al arrancar (y lo regenera con la identidad): vive solo en memoria, jamás se persiste —ni `localStorage` ni el almacén IndexedDB— y lo borra el panic button (RF-08). Su clave pública cruda (65 B) se anuncia con la acción dirigida `ephkeys` al conectar y tras regenerar identidad (7.1). Los canales DM manuales de #97 (12.2) no tienen anuncio `ephkeys` —no hay enjambre donde colgarlo—: su efímera viaja dentro del blob de invitación y la derivación es exactamente la de esta sección.
2. El anuncio se guarda junto a su fingerprint **sin pin TOFU**: solo el fingerprint de identidad queda anclado en `gritos:tofu` (8.2) y solo la identidad se muestra para verificación manual (9.1, RF-04). Una clave efímera sustituida no deriva la misma clave DM: el dual-salt del punto 4 hace que el GCM falle a la vista.
3. Para enviar o recibir, cada extremo computa `secreto = ECDH(miPrivEfímera, suPubEfímera)` → 256 bits.
4. `claveDM = HKDF-SHA256(secreto, salt = SHA-256(los cuatro fingerprints canónicos ordenados ascendente: identidad y efímero de ambos extremos), info = "gritos/dm/v2", 32 B)` → clave AES-GCM-256 **no exportable** (_dual-salt_: al entrar ambas parejas de fingerprints en la sal, el enlace identidad→efímero queda atado sin firmas; ver 12.1). Los `fp` son los de 9.1 en forma canónica (sin espacios, mayúsculas); cada extremo calcula los suyos desde las claves crudas anunciadas.
5. Cada mensaje DM: IV aleatorio de 12 B; se transmite `base64(IV ‖ AES-GCM(texto))` en un sobre `dm` con `v: 2` (7.2).
6. La clave vive solo en memoria, en una caché por sesión y por par (clave: los fingerprints ordenados); no se persiste. Al cerrar la sesión desaparece la clave privada efímera y lo grabado deja de ser descifrable (12.1).

**Formato legacy v1 (ya no se envía ni se acepta).** La derivación estático-estático original —ECDH entre claves de identidad, salt = SHA-256(fpA ‖ fpB ordenados), `info = "gritos/dm/v1"`, sobre `dm` con `v: 1`— permanece en el código solo como referencia del formato antiguo. La regla del parser es final: `chat` exige `v: 1` y `dm` exige `v: 2` (7.3). En salas con builds mezclados los sobres que no se abren se descartan en silencio en ambas direcciones; el par nuevo ve además un estado explícito de par legado —compositor deshabilitado: «Este par usa una versión anterior sin DM cifrado por sesión»— en lugar de una pérdida silenciosa de mensajes. No hay migración de claves: canales y claves DM viven solo en memoria (la ampliación a 128 bits del fingerprint, issue #23, ya cambió la sal de forma deliberada y uniforme en v1).

### 9.3 Clave de sala con contraseña

1. `sal = SHA-256("gritos/room-salt/v1/" + nombreNormalizado)` — determinista y público (no es secreto; evita tablas arcoíris por sala).
2. `claveSala = PBKDF2-SHA256(contraseña, sal, 600 000 iter, 32 B)` → AES-GCM-256.
3. Cifrado idéntico al DM: IV de 12 B por mensaje, `base64(IV ‖ ct)`.
4. La contraseña solo existe en memoria durante la sesión; al recargar hay que re-introducirla.

### 9.4 Derivación de `roomId`

- Sala pública: `roomId = hex(SHA-256("gritos/room/v1/" + nombre))[0..31]`
- Sala con contraseña: `roomId = hex(SHA-256("gritos/room/v1/" + nombre + "\u0000" + contraseña))[0..31]`

La derivación con contraseña hace que la sala sea **indescubrible** en el tracker sin la contraseña (decisión D4). El `appId` de Trystero ya no es una constante de código: se toma del entorno de compilación `VITE_TRYSTERO_APP_ID` (issue #90, plantilla en `.env.example`, resolución en `lib/p2p/appId.ts`). El valor se hornea en tiempo de build y, si falta, unir a salas falla de forma inmediata en lugar de recurrir a un valor por defecto silencioso (un fallback compartido separaría el enjambre sin aviso).

### 9.5 Modelo de amenazas

**Cubierto**

- Observadores pasivos de red (ISP, trackers): ven DTLS y, en salas cifradas y DMs, solo ciphertext.
- Operadores de trackers públicos: solo ven hashes de roomId, peerIds y SDP; en salas con contraseña ni siquiera el hash existe para quien no conoce la contraseña.
- Pares maliciosos dentro de una sala con contraseña: no pueden descifrar la sala ni los DMs ajenos.

**No cubierto (documentado, aceptado)**

- Suplantación de apodo: cualquier par puede usar el apodo de otro; la defensa es comparar fingerprints en DMs (TOFU — _trust on first use_), sin base de identidad persistente global.
- Plano de control sin autenticar (issue #36): las señales ajenas al contenido del chat —confirmaciones `receipt` (los ✓✓), «escribiendo…» (`typing`), líneas de sistema «joined / left», ecos `pong` de latencia y reacciones emoji (`react`, issue #98)— viajan sin autenticación de mensaje, de modo que cualquier par puede forjarlas (marcar entregados mensajes ajenos, fingir que escribe, emitir líneas de sistema con apodos arbitrarios —que además desplazan historial real por el FIFO de 500 mensajes—, inflar los puntos de latencia o hinchar los conteos de reacciones de mensajes ajenos —issue #98: el conteo mostrado es la suma local de payloads sin autenticar— o forjar (o sesgar) el historial que el chisme de historial opt-in reenvía —issue #102: mismo nivel de confianza que el chat en vivo; el separador «— messages recovered from peers —» etiqueta la procedencia, no la veracidad (7.3)—) o inundar el chat para saturar insignias de no leídos y notificaciones de mención. Es inherente a la malla sin confianza de v1 —misma raíz que la suplantación de apodo, más arriba—; la mitigación de v1 es cosmética: tope de líneas de sistema por par y minuto, descarte de RTT negativos y acotado de RTT absurdos en el eco `pong` — y para las reacciones (issue #98) lista blanca de 7 emojis, lote ≤50 ids, tope de 30 payloads por par y minuto y topes de estado de 50 reacciones por emoji (el 51.º par se rechaza, jamás se expulsa). La issue #95 añade la primera mitigación a pedido del usuario —silenciar pares por fingerprint: la lista local de 8.1/8.2 (semántica exacta en 7.3) oculta el chat de sala, los DM, la escritura, las líneas de sistema y las reacciones (issue #98) del par silenciado—. Límites aceptados, coherentes con la malla sin confianza: rotar la clave de identidad elude la lista (el pin TOFU, 8.2, hace visible la rotación con su aviso de clave cambiada) y la ventana de carrera hasta que aterrizan las claves anunciadas del par falla en abierto (7.3).
- Compromiso del dispositivo o del origen (XSS): la clave privada se guarda cifrada en reposo (issue #24), pero un script del propio origen tiene acceso a `localStorage` **y** a IndexedDB, por lo que un contexto totalmente comprometido sigue pudiendo usar la clave (suplantar al usuario). Mitigación: la envoltura eleva el listón frente a volcados ingenuos de `localStorage` (extensiones con permisos de lectura, acceso físico al disco); contra el compromiso del propio origen no hay defensa local. El renderer Markdown propio con tests de XSS y la superficie mínima de dependencias siguen siendo la primera barrera.
- Metadatos: los pares conectados ven tu IP (naturaleza de WebRTC); usar TURN mitiga parcialmente.
- Exposición del canal global de señalización (issue #105, 12.5): quien activa los DMs globales se une a un enjambre público y bien conocido —todos los builds con el ajuste activo comparten sala—, de modo que **cada par opt-in ve tu IP** (misma naturaleza de WebRTC que el punto anterior), **tu huella de identidad y tu apodo**. La mitigación documentada es el propio interruptor: `Settings.globalDm` está **desactivado por defecto** y unirse es una decisión de privacidad visible del usuario, jamás un comportamiento silencioso; los topes de 12.5 (presencia LRU de 100, 5 golpes por par y minuto) y la lista de silenciados (issue #95) acotan el abuso. Un golpe revela además el interés del golpeador en el golpeado — inherente al mecanismo: dirigir un `knock` ES declarar que se busca a esa huella; el campo de nota es opcional y de ≤ 140 caracteres.
- Avances criptoanalíticos / contraseña de sala débil: PBKDF2 eleva el coste, pero una contraseña trivial es comprometible por fuerza bruta offline por quien conozca el nombre de sala. En los DMs, el riesgo _harvest now, decrypt later_ (issue #25) queda **mitigado a alcance de sesión** con la derivación v2 (issue #93; 9.2): al cerrar la sesión desaparece la clave privada efímera y lo grabado deja de ser descifrable. Riesgo residual, a secas: capturar el tráfico **durante** una sesión activa y comprometer después el dispositivo expone esa sesión —y habilita la suplantación de identidad hasta la alerta de rotación TOFU (8.2)—. Los pares v1, y lo grabado en v1 antes de la migración, siguen bajo la exposición estático-estático original (12.1).

## 10. UX/UI

Estética: minimalista, rápida, limpia. Densidad de información moderada, tipografía sans del sistema, monoespaciada para código.

### 10.1 Layout

```
┌──────────────┬──────────────────────────────────────────┐
│ SIDEBAR      │ #general 🔒              🟢 5 pares  ⚙    │
│ (colapsable) ├──────────────────────────────────────────┤
│ ACTIVAS      │  feed de mensajes                        │
│  #lobby  ②   │  ┌ zorro-bravo · 12:04                   │
│  #general    │  │ hola **mundo**                         │
│ SUGERIDAS    │  └ ✓✓                                    │
│  #dev        │  ┌ luna-cauta · 12:05                    │
│  #random     │  │ `code` _test_                          │
│ RECIENTES    │  …                                       │
│ [+ Unirse]   │  — luna-cauta está escribiendo… —         │
│ PARES        ├──────────────────────────────────────────┤
│  ● luna-cauta│  [ mensaje (Markdown)… ]        [Enviar] │
└──────────────┴──────────────────────────────────────────┘
```

- **Sidebar colapsable** (botón y atajo `Ctrl/Cmd+B`; en móvil es un _drawer_).
  - Sección _Activas_: salas conectadas con badge de no leídos y punto de estado.
  - Sección _Sugeridas_ y _Recientes_ (si `rememberRooms`).
  - Botón **[+ Unirse]**: popover con nombre (y contraseña opcional).
  - Sección _Pares_ de la vista activa: apodo, punto de latencia, clic → menú (Mensaje directo / Copiar fingerprint / Silenciar).
- **Área principal**: encabezado (nombre con `#`, 🔒 si aplica, estado, nº de pares, compartir y QR de invitación (sección 10.8), ajustes), feed, barra de entrada.
- **Modal de ajustes** con las pestañas Red / Privacidad / Apariencia (RF-07).

### 10.2 Onboarding (primera visita)

Pantalla centrada sobre fondo del tema: logotipo tipográfico "gritos", campo "Tu apodo", botón secundario "sorpréndeme", botón primario "Entrar →". Texto de una línea: "Sin servidor, sin cuentas: tus mensajes viajan directos entre navegadores y desaparecen al recargar."

### 10.3 Estados de conexión (textos exactos)

| Estado      | Texto en encabezado                                                            | Detalle                                                      |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `searching` | "Buscando pares en la red torrent…"                                            | Unido al tracker, 0 pares aún.                               |
| transición  | "Conectando (N pares encontrados)…"                                            | Best-effort: entre handshake y `onPeerJoin` (2–6 s típicos). |
| `connected` | "Canal P2P establecido · N pares"                                              | Al menos 1 DataChannel activo.                               |
| `error`     | "Sin acceso a trackers — revisa tu conexión o configura trackers alternativos" | Heurística: sin conexión a ningún tracker tras 15 s.         |

El _discovery_ en trackers públicos tarda típicamente 2–6 s; la UI debe comunicarlo con sutileza (indicador animado, sin bloquear la entrada de texto — el envío queda en cola local hasta conectar).

### 10.4 Feed y entrada

- Burbujas planas (sin cajas por mensaje): autor en color estable derivado de `hash(peerId)` → hue, hora `HH:MM`, cuerpo Markdown.
- Separadores de sistema discretos para uniones/salidas, para el cap FIFO y para los silencios locales (issue #95: «@nick was muted»).
- Entrada: textarea auto-creciente (máx. 6 líneas), contador de caracteres a partir de 3800/4000, ayuda contextual de Markdown (`**negrita** · *cursiva* · \`código\``).
- Los mensajes propios se alinean a la derecha con `✓`/`✓✓` atenuado.

### 10.5 Notificaciones

- Título: "gritos — mención en #general" o "gritos — DM de luna-cauta".
- Cuerpo: "zorro-bravo: hola @ti…". Clic → foco + apertura de la vista origen.

### 10.6 Temas

- Tailwind con estrategia `class` (`dark` en `<html>`); `system` observa `prefers-color-scheme` en vivo.
- Transición de tema suave (150 ms); sin flash al cargar (script inline mínimo que aplica la clase antes del bundle).

### 10.7 Comandos de barra (issue #99)

Función 100 % cliente: sin cambio de protocolo alguno (la sección 7 queda intacta). El compositor interpreta la entrada que empieza por `/` + verbo; los verbos son ingleses y solo en minúsculas (decisión de producto: se documentan, no se localizan), con aridad estricta — un argumento en un comando sin argumentos es un error, nunca se ignora en silencio. Toda la retroalimentación son líneas de sistema locales (el patrón de las líneas de silencio de #95): jamás viajan por la red.

| Comando        | Semántica                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/nick <name>` | Renombra con las reglas de RF-01 (mismas validaciones que el onboarding) y re-anuncia `presence` en todas las salas activas; el color de autor sigue derivado del peerId.                                                                                                                                                                                            |
| `/room <name>` | Unión enfocada por la misma ruta del popover «+ Unirse» (normalización RF-02); el rechazo por cap imprime el aviso exacto de RF-02 (corrección #87). En caso de éxito **arma la oferta de contraseña**: si la sala queda sin pares (estado `error`), aparece el popover prellenado de esa sala — el flujo de contraseña se dispara solo cuando de verdad hace falta. |
| `/dm <nick>`   | Resuelve entre los pares de la sala activa (coincidencia exacta sin distinción de mayúsculas; el propio usuario nunca es candidato). Coincidencia única → abre el DM; ambigüedad o inexistencia → línea local de error, jamás una adivinanza.                                                                                                                        |
| `/me <action>` | Envía un sobre `chat` normal (el wire no cambia) con una **bandera local de render**: el autor ve «_apodo acción_» en cursiva; los pares ven texto plano — asimetría documentada de la convención de render sin cambio de protocolo.                                                                                                                                 |
| `/rooms`       | Línea local con las salas activas y sus contadores de no leídos.                                                                                                                                                                                                                                                                                                     |
| `/clear`       | Vacía el feed local de la sala activa tras confirmación: solo memoria — la conexión no se cierra y los pares conservan su historial.                                                                                                                                                                                                                                 |
| `/leave`       | Abandona la sala activa por la misma ruta del menú de la barra lateral (solo la sala enfocada; las demás conexiones siguen).                                                                                                                                                                                                                                         |
| `/help`        | Superposición local con esta tabla de comandos.                                                                                                                                                                                                                                                                                                                      |

Garantías transversales:

- **Verbo desconocido jamás se envía**: `/foo …` produce solo la línea local «Unknown command — /help» — ningún texto literal con `/` alcanza la red por accidente. Para enviar un mensaje que empiece por `/` existe el escape documentado en `/help`: `\/hola` envía «/hola» (la barra invertida se elimina al enviar).
- **Autocompletado por teclado (RNF-05)**: al teclear `/` el compositor abre un popup de candidatos con el patrón ARIA combobox — el textarea es `role="combobox"`, la lista `role="listbox"` con `aria-activedescendant`, opciones nunca focusables: el foco no abandona jamás el textarea; `↑ ↓ Enter Esc` gobiernan la lista, y un verbo sin candidatos no abre popup.
- **Todo comando es operable solo con teclado**, de la apertura del popup a la ejecución.

### 10.8 Compartir sala y código QR (issues #41 y #100)

El botón «⤴» del encabezado comparte el enlace profundo de la sala — `origen + ruta + #sala=<nombre>` (construido por `buildRoomLink`, consumido por el enrutado `#sala=` del onboarding y de `ChatLayout`) — vía `navigator.share` con respaldo de portapapeles («Enlace copiado»). El enlace lleva **solo el nombre, jamás la contraseña** (RF-05).

El botón «QR» (issue #100) abre un popover que codifica **exactamente ese mismo enlace** en un código QR: escanearlo con la cámara nativa de otro dispositivo aterriza en el flujo de unión con el nombre prellenado. El QR **nunca contiene la contraseña** — en una sala cifrada el enlace solo abre el flujo de unión y el alta sigue pidiéndola (RF-05). La superficie de escaneo es **fija**: módulos casi negros sobre blanco con su zona de silencio, en claro Y en oscuro — la escaneabilidad manda sobre el tema (los tokens AA garantizan contraste a ojos humanos, no a decodificadores). «Download PNG» exporta el mismo símbolo en alta resolución (`gritos-room-<nombre>.png`), con el enlace en texto copiable debajo como respaldo. Límite documentado en el propio popover («The QR links to this same installation.»): el enlace solo sirve dentro de esta misma instalación — mismo origen y mismo `VITE_TRYSTERO_APP_ID` (issue #90); un QR de otra instalación no une a nada.

### 10.9 Instalación PWA y flujo de actualización (issue #104)

**Estado: implementado (issue #104).** La app es instalable (manifest `standalone` con iconos 192/512 y variantes maskable, todo en URLs relativas — `start_url`/`scope: './'`, registro de `./sw.js` — para que la instalación funcione igual en subrutas, incluidas las páginas de proyecto de GitHub Pages) y arranca sin red: un service worker mínimo y artesano (`public/sw.js`) precachea el shell exacto de cada build — el documento, el manifest, los estáticos y los assets hasheados, lista y nombre de caché `gritos-shell-v<digest>` inyectados en build por un plugin de Vite — y lo sirve cache-first. El alcance del worker es solo el shell y solo mismo-origen: el tráfico cross-origin (los `wss:` de los trackers, primero de todos) pasa de largo y jamás se cachea; sin push, sin background sync, sin canal nuevo alguno. El shell offline es **honesto** (10.3): sin red la app arranca y muestra su estado de conexión real — el P2P sigue necesitando conectividad.

**Flujo de actualización.** El worker jamás llama `skipWaiting()`: una versión nueva instala y **espera** mientras esta página aún ejecuta la vieja. El registro (`lib/pwa/registerSw.ts`) detecta al trabajador en espera — ya esperando al resolver el registro, o un `updatefound` cuyo install alcanza `installed` con la página aún controlada por un worker anterior (`controller != null`; en un primer install no hay nada que actualizar) — y el toast de la esquina, «Nueva versión disponible — [Recargar]» (`role="status"`, estado local del componente, sin persistencia), ofrece el recambio. «Recargar» hace `location.reload()`: el viejo cliente se despide, el worker en espera se activa y la limpieza de activación borra las cachés `gritos-shell-v*` anteriores. Descartar el toast vale solo por la sesión (un worker NUEVO en espera avisa de nuevo — la regla por-ocurrencia del banner de red); no hay `controllerchange` a la escucha a propósito: el recambio es la recarga explícita del usuario, jamás automática — una conversación en vivo no pierde sus conexiones por un deploy. iOS queda en soporte parcial documentado (11.10): sin prompt de instalación, peculiaridades de SW ocasionales. `vite dev` sigue sin worker (misma filosofía de `stripCspMetaInDev`): solo los builds de producción registran, solo en contexto seguro, y un fallo de registro nunca es fatal.

## 11. Limitaciones conocidas (visibles o documentadas en la UI)

1. **Full mesh**: óptimo 6–15 pares por sala; a partir de ~20 la malla degrada (más salas activas multiplican el efecto). El cap de salas (≤6) y el de mensajes (500) mitigan memoria/CPU.
2. **Dependencia de trackers públicos**: si todos caen, no se descubren pares nuevos (los ya conectados siguen). Ajuste de trackers alternativos disponible (RF-07).
3. **NAT simétrica / firewalls corporativos**: sin TURN el P2P directo puede fallar. Se ofrece configuración de STUN/TURN propia; sin TURN garantizado, la conexión no se promete.
4. **Pestaña activa**: en segundo plano profundo el navegador ralentiza timers (pings degradados); al volver al frente se recuperan.
5. **Sin servidor**: sin historial para quien entra tarde (D2), sin entrega a pares desconectados, sin push real (las notificaciones solo ocurren con la pestaña abierta, aunque oculta).
6. **Pestañas múltiples del mismo navegador**: cada pestaña es un par distinto; funciona, pero se verá el propio apodo duplicado con sufijo.
7. **DMs solo entre pares con sala compartida, salvo dos caminos deliberados**: el descubrimiento es por trackers, así que un DM arbitrario exige sala compartida — lo ablandan la conexión manual de pares (issue #97; 12.2, infraestructura cero) y el canal global de señalización opt-in (issue #105; 12.5, requiere que AMBOS lados activen `Settings.globalDm`); ninguno es un camino automático ni silencioso.
8. **Orden de mensajes no global** (7.3) y **apodos no únicos** (RF-06): aceptados para v1.
9. **Transferencias de archivos en RAM (issue #103, 12.4)**: los archivos recibidos viven como blobs en memoria (hasta 20 MB por archivo; con `MAX_TRANSFERS_PER_PEER = 3` transferencias concurrentes por par en ambos lados, el peor caso ronda 60 MB por par y dirección) — varias a la vez puede apretar a dispositivos modestos, y el tope de 20 MB más el cap de 3 por par son la mitigación. Nada se persiste jamás: recargar lo pierde todo, y las object URLs se revocan al descartar la tarjeta, al abortar o fallar, con el pánico (RF-08) y al regenerar identidad. Reconexión a mitad de transferencia: la falla, sin reanudación — el usuario vuelve a ofertar.
10. **Soporte PWA parcial en iOS (issue #104, 10.9)**: Safari permite añadir gritos a la pantalla de inicio, pero no hay prompt de instalación y el soporte de service workers/standalone tiene lagunas — la instalación y el shell offline son best-effort ahí; Android/Chrome y escritorio Chromium son la plataforma de referencia.

## 12. Roadmap de fase 2 (fuera de v1, priorizable)

1. Transferencia P2P de archivos/imágenes por DataChannel (chunking, backpressure, progreso, reconstrucción; issue #103; nota de diseño en 12.4): **implementado** — transferencia dirigida 1:1 con consentimiento del receptor antes de cualquier byte (el primer `file-ack` con la ventana de crédito ES la aceptación, 7.1), chunks sellados con la clave de la conversación (sala con contraseña o DM v2; sala pública = solo DTLS, con aviso previo al envío y el estado en la tarjeta), ventana de crédito de 8 chunks con stall de 30 s, tope de 20 MB y de 3 transferencias concurrentes por par, todo solo en memoria (8.1); queda como trabajo futuro el meta sellado y la compresión — exigirían una v2 del protocolo de archivos (12.4).
2. Sincronización de historial entre pares (_gossip_) opt-in: retransmisión de últimos N mensajes a nuevos participantes (issue #102): **implementado** — petición explícita (`hist-req`) más consentimiento en ambos extremos (8.1), hasta 50 mensajes bajo el separador «— messages recovered from peers —» (7.3) y sin persistencia alguna; queda como trabajo futuro el endurecido opcional: sobres firmados en su creación (la línea de firmas esbozada en 12.1).
3. Canal global de DMs (sala de señalización dedicada) para DMs sin sala compartida (issue #105; nota de diseño en 12.5): **implementado** — enjambre dedicado y bien conocido (`SIGNAL_ROOM_NAME = '_gritos/senal/v1'`, solo builds con el mismo appId, 9.4) estrictamente atado al ajuste opt-in `Settings.globalDm` (8.1, default false): presencia `whoami {nick, fp}` con LRU de 100, golpes `knock` por huella (dirigidos, sin campo de contenido más la nota de ≤ 140, 5 por par y minuto, puerta de silenciado antes de parsear) y `knock-ack {accept}` de consentimiento; un golpe aceptado abre en AMBOS lados un DM E2EE respaldado por el mismo enjambre — derivación v2 sin cambios (9.2) tras la costura `DmTransport`, canal claveado por huella y marcado «(global)» en DmList —; apagar el ajuste deja el enjambre EN EL ACTO y pasa sus canales a «The peer has disconnected» (RF-04); el canal transporta golpes y claves, jamás contenido, y no es directorio de presencia — su único rastro persistido son los pins TOFU de contactos con canal abierto (8.2).
4. Salas masivas: topología de retransmisión o SFU.
5. PWA (service worker, iconos, offline shell; issue #104): **implementado** — manifest + iconos con instalación standalone segura en subrutas, shell offline precacheado bajo una caché `gritos-shell-v<digest>` versionada por contenido, y flujo de actualización con toast local («Nueva versión disponible — [Recargar]», 10.9) sobre un worker que jamás llama `skipWaiting()`; lo offline es SOLO el shell — el P2P sigue necesitando red (10.3) y no hay push (11.5) —; iOS queda en soporte parcial documentado (11.10).
6. i18n y mensajes editables/borrables.
7. Secrecía hacia delante en DMs (issue #25; nota de diseño en 12.1): **el mínimo está implementado** (issue #93) — claves DM efímeras por sesión (9.2); queda como trabajo futuro la solución completa: _prekeys_ + _double ratchet_ (fase B del issue).
8. DMs sin sala compartida por conexión manual de pares (issue #97; nota de diseño en 12.2): **implementado** — señalización copiar/pegar con infraestructura literalmente cero; complementario del ítem 3 (canal global de señalización), ya implementado este también.

### 12.1 Nota de diseño: secrecía hacia delante en DMs (issue #25)

**Estado: el mínimo viable está implementado (issue #93).** La derivación v2 de 9.2 está en producción, con tres desviaciones deliberadas sobre lo esbozado aquí:

1. **La clave efímera viaja en una acción dirigida dedicada, `ephkeys` (7.1), y no dentro del payload de `keys`.** Un anuncio compuesto habría obligado a los pares v1 a descartar el conjunto —también las claves de identidad—, rompiendo su vista TOFU en salas mezcladas.
2. **La degradación en versiones mezcladas no es solo silenciosa.** El descarte silencioso de sobres sigue (7.3), pero el par nuevo marca al par v1 sin anuncio `ephkeys` como legado y deshabilita el compositor con el aviso «Este par usa una versión anterior sin DM cifrado por sesión», en vez de dejarle escribir a un buzón que nadie abrirá.
3. **El enlace identidad→efímero usa la doble sal** (ambas parejas de fingerprints en la sal de HKDF, 9.2): la opción de firmar la clave efímera con la de identidad no hizo falta.

**Amenaza — _harvest now, decrypt later_.** El envío del `dm` ya es **dirigido al destinatario** (7.1; issue #18, implementada), de modo que los demás miembros de la sala dejaron de capturar los sobres cifrados. Antes de la migración, la superficie de grabación residual quedaba en los extremos de la conversación: la clave DM se derivaba de un ECDH **estático-estático** P-256 (9.2) entre claves de identidad de larga vida, así que bastaba un único compromiso posterior de una clave privada (acceso al dispositivo, volcado de `localStorage`/IndexedDB, avance criptoanalítico) para descifrar **todo el historial grabado** de esa pareja de pares. 9.5 lo recoge como riesgo aceptado de v1; esta nota fijó la migración, ya materializada.

**Mínimo viable: secrecía por sesión.** Derivar la clave DM de un par ECDH **efímero por sesión de la app**, anunciado a los pares de cada sala (implementado como la acción dedicada `ephkeys`; desviación 1 del Estado): el ECDH de 9.2 deja de usar la clave privada de identidad y pasa a usar material efímero de sesión. La clave de identidad de larga vida y su fingerprint siguen siendo el ancla TOFU: se muestran en la lista de pares y en la cabecera del DM para la verificación manual (RF-04, 9.1). Consecuencias a documentar:

- El pin `gritos:tofu` (8.2, issue #22) debe seguir fijando el fingerprint de **identidad**, nunca el de la clave efímera (que cambia en cada sesión y rompería el pin al reiniciar).
- Cada par debe enlazar identidad → clave efímera sin abrir la puerta a suplantación: la clave efímera viaja firmada por la clave de identidad, o la sal de 9.2 se deriva de ambos pares de fingerprints (identidad y efímero), de modo que una clave efímera sustituida no derive la misma clave (implementado: la segunda opción —dual-salt—; desviación 3 del Estado).
- La ventana de exposición se reduce de "vida completa de la identidad" a "una sesión": lo grabado deja de ser descifrable al cerrar la pestaña; lo capturado antes de la migración sigue expuesto.

**Solución completa (fuera del alcance de v1).** _Prekeys_ anunciadas por par y establecimiento tipo X3DH con _double ratchet_ por conversación (secrecía hacia delante y recuperación post-compromiso, estilo Signal). Exige canal de anuncio de prekeys y estado de ratchet por conversación; el envío dirigido sobre el que cobra sentido ya está implementado (7.1, issue #18). Es la fase B del issue #93 y sigue siendo trabajo futuro.

**Disciplina de migración.** El formato v1 queda fijado por contrato como legado: derivación con `info = 'gritos/dm/v1'` sobre la sal de fingerprints ordenados (9.2) y sobre DM `{iv, payload}` (7.2). Cualquier cambio en las entradas de derivación (par de claves, sal, info) o en el formato wire debe **incrementar un marcador de versión** y estar controlado por tests, de forma que pares viejos y nuevos nunca deriven silenciosamente claves distintas de los mismos sobres. La migración v2 materializó exactamente ese marcador: `DM_KEY_INFO_V2 = 'gritos/dm/v2'` y Envelope `v: 2`, ambos fijados por tests guard (`DM_KEY_INFO` conserva `'gritos/dm/v1'` como constante del formato legado, que ya no se envía ni se acepta). En salas con versiones mezcladas los sobres que no se abren se descartan en silencio (7.3) —y el par nuevo muestra además el estado explícito de par legado (desviación 2 del Estado)— hasta que las builds convergen.

### 12.2 Nota de diseño: DMs sin trackers — conexión manual de pares (issue #97)

**Estado: implementado (issue #97).** Lo esbozado aquí está en producción sin desviaciones sobre lo decidido: el motor (blobs, máquinas de estado, marcos `{"action", "payload"}`, deduplicación) vive en `lib/p2p/manualPeer.ts` —la única superficie `RTCPeerConnection`—, el gestor de cara a la UI en `lib/p2p/manualDmManager.ts` (el espejo del roomManager para la ruta manual: alimenta la porción `manualDms` del store, 8.1, y fija los pines TOFU bajo el prefijo reservado `manual:` de 8.2) y el asistente cubre los dos roles con las cadenas en `settings/messages.ts`. Las dos invalidaciones de la nota son costura: el RF-07 (regenerar identidad) destruye los flujos pendientes y mata los canales vivos vía el suscriptor `onSessionIdentityRegenerated` que instala el gestor manual, y el pánico (RF-08) los aborta en la misma pasada (`abortAllManualDms`). Lo que sigue es la nota de diseño aprobada que la implementación siguió. Un canal 1:1 directo (WebRTC DataChannel) establecido intercambiando a mano dos blobs de invitación —copiar/pegar hoy, QR opcional después—: la señalización no necesita trackers ni servidor alguno, el único camino de descubrimiento con infraestructura literalmente cero (11.2, 11.7). Todo lo demás se reutiliza intacto: derivación DM v2 (9.2), sobres `dm` v:2 (7.2), receipts y typing (7.1), TOFU (8.2) y el estado `DmChannel` (8.1). Los pares manuales no comparten enjambre alguno: lo que en salas hace Trystero aquí lo hace el pegado humano. Alcance estricto: un DM 1:1.

**Sobre de invitación (blob).** Cada rol emite un único blob autocontenido, JSON → base64 estándar (decodificado tolerando los espacios y saltos que el portapapeles añada):

```jsonc
{
  "v": 1, // versión del formato del blob — ajena a la `v` de los sobres (7.2)
  "role": "invite", // "invite" (ofrece) | "answer" (responde)
  "nick": "zorro-bravo", // orientativo, jamás verificado: la identidad es el fingerprint (9.1)
  "fp": "A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678", // fingerprint de identidad (9.1)
  "idKey": "<base64>", // clave pública de identidad cruda, 65 B (9.1)
  "ephKey": "<base64>", // clave pública efímera de sesión cruda, 65 B (9.2)
  "sdp": { "type": "offer", "sdp": "v=0…" }, // localDescription de la RTCPeerConnection
}
```

Un SDP crudo ronda 2–4 KB; con las dos claves y el embalaje JSON → base64 el blob queda en ≈3–6 KB — cómodo para pegar por cualquier canal. **ICE sin trickle**: el blob solo se emite cuando la recogida de candidatos termina (`icegatheringstate === 'complete'`, con una guardia de 5 s que emite con lo reunido si algún candidato tarda) — tras el pegado no existe canal de señalización al que mandar candidatos tardíos, así que el blob debe llevarlos todos. El receptor valida antes de tocar la red: `v` conocida, `role` coherente con el `type` del SDP (`invite`⇔`offer`, `answer`⇔`answer`), claves de exactamente 65 B y **huella recalculada desde la clave cruda** — un blob cuya `fp` no coincida con SHA-256(`idKey`) se rechaza como corrupto o manipulado; una `ephKey` ausente o malformada invalida el blob entero. No existe la degradación a par legado de 12.1: la capacidad v2 de #93 se anuncia dentro del blob, no en una acción posterior.

**Acuerdo de claves: la derivación 9.2 v2, sin cambios.** Cada blob transporta AMBAS claves públicas de su autor (identidad + efímera de sesión), de modo que al completarse el intercambio cada extremo conoce las cuatro huellas y la efímera cruda del otro, y deriva exactamente como 9.2 punto 4 — ECDH efímero-efímero, `claveDM = HKDF-SHA256(secreto, salt = SHA-256(las cuatro huellas canónicas ordenadas), info = "gritos/dm/v2")` — con el mismo dual-salt que ata identidad→efímera: una efímera sustituida en el blob hace que el GCM falle a la vista (12.1, desviación 3). Decisión cerrada: las efímeras viajan **dentro del blob**, no por el canal de datos antes del primer payload — no hay enjambre compartido donde colgar un `ephkeys` (7.1), el protocolo queda cerrado en dos pegados sin fase previa en claro sobre el canal, y la superficie de confianza no crece: el canal por el que se pegan los blobs ya se presupone digno para la comparación de huellas que hace el usuario, y el dual-salt neutraliza una efímera sustituida. La disciplina TOFU de 9.2 queda intacta: solo la huella de identidad se fija y se muestra; la efímera jamás.

**TOFU por fingerprint (sin peerId).** El par manual no tiene peerId Trystero y `gritos:tofu` es `{peerId: huella}` (8.2): el pin viaja en la MISMA clave, en el mapa plano, bajo el prefijo reservado `manual:` + huella canónica — `manual:<huella-canónica>` → huella en forma de pantalla, el mismo convenio de valor que los pines de sala. No estrena clave de `localStorage` (invariante de las cinco, 8.2), lo borra el mismo pánico sin código nuevo (RF-08), conserva el formato `string→string` (cualquier lectura-modificación-escritura lo preserva) y hereda tal cual el _first-write-wins_ y la regla de prefijo de #23. Persistirlo compra lo que en salas era imposible: la identidad (9.1) sobrevive a la recarga —al revés que el peerId—, de modo que una invitación posterior de la misma identidad es reconocible («ya has conversado con esta identidad»): la primera vez que el TOFU reconoce a un par entre sesiones. Una identidad regenerada produce otra entrada; el pin anterior se conserva (valor público, misma política que en salas).

**Notas de seguridad.** El SDP puede contener direcciones de red: los navegadores enmascaran hoy los candidatos host en nombres mDNS (`*.local`), pero los candidatos srflx siguen publicando IP:puerto pública — por eso el asistente mostrará, antes de copiar cada blob, el aviso exacto «La invitación puede contener información de tu red» (la fase de UI lo trasladará a `settings/messages.ts`). La autenticidad del blob **no** la garantiza el transporte: quien controle el canal por el que se pegan los blobs puede sustituir las claves — el ancla de confianza es la comparación de huellas fuera de banda, exactamente el límite TOFU de 9.5, y la UI la exigirá antes del primer mensaje. El blob jamás contiene datos de mensaje: solo claves públicas, huella y SDP.

**Regla de arquitectura.** Espejo exacto de la regla roomManager: los componentes jamás tocan WebRTC — `RTCPeerConnection` solo puede aparecer en `lib/p2p/manualPeer.ts`, igual que Trystero solo puede importarse en `lib/p2p/roomManager.ts` — y el resto del código consume el motor por su API y el store (8.1).

**No-goals.** **Ningún par manual actúa de relé**: no se puentea hacia mallas de sala y la regla de silencio de 7.3 sigue plena (un mensaje recibido jamás se retransmite); sin enjambres manuales multipar — el alcance es estrictamente el DM 1:1. El canal no persiste nada (como los DM de hoy) y no sustituye al ítem 3 del roadmap: soluciones complementarias a la misma limitación 11.7.

**Máquinas de estado y reconexión.** Rol A (crea la invitación): `idle → invite-ready` (blob emitido al completar la recogida ICE) `→ answer-pasted` (respuesta validada y huella comparada) `→ connected`. Rol B (responde): `idle → invite-pasted → answer-ready → connected`. Las esperas puestas en el humano (que el otro pegue) no tienen timeout de reloj — solo cancelación explícita, que cierra la `RTCPeerConnection` y vacía el estado pendiente; las esperas de máquina sí lo tienen: recogida ICE con la guardia de 5 s y establecimiento con los 15 s de la heurística de 10.3, que al vencer muestran error visible y permiten reintentar (RNF-07). Una respuesta cuya huella difiera de la esperada por el canal pendiente se rechaza con error explícito: jamás abre un canal nuevo en silencio. Caída de la conexión (`iceconnectionstate` failed/closed o DataChannel cerrado): el canal pasa al estado «The peer has disconnected» de RF-04 (`available: false`, historial en memoria hasta recargar); reconectar exige un intercambio nuevo de blobs —la conexión vieja no se reutiliza y los blobs son de un solo uso— y retoma el MISMO canal, clave por la huella, con historial intacto. Regenerar identidad (RF-07) o el pánico (RF-08) destruye invitaciones y respuestas pendientes: es todo estado efímero, no hay nada persistido que limpiar; el canal vivo muere con sus claves y el pin `manual:` de la identidad anterior se conserva.

**Reutilización del cable.** El DataChannel habla la misma semántica `dm` de 7.1: sobres v:2 sellados por 9.2, ✓/✓✓ vía `receipt` por lotes ≤50 con el mismo debounce, `typing` `{on, dm: true}` (todo typing del canal manual es de DM), límite de 4000 caracteres y `ttl` opcional (#96) intactos. Encuadre mínimo decidido: **frames de texto JSON, un mensaje por frame, `{"action": "dm" | "typing" | "receipt", "payload": …}`** — el sustituto del enrutado de acciones de Trystero —, con cada payload validado por las reglas ya existentes (`parseEnvelope` para `dm`, `validateReceipt` para receipts). La ruta manual deduplica con su propio `BoundedSeenIds` (mismo cap) y la ventana de frescura de #19, como las rutas de sala (7.3). Sin chunking ni payloads binarios: un `dm` sellado de 4000 caracteres ronda los 5,4 KB, muy por debajo del tope de 64 KB de 7.3 — no hay chunking que decidir; `presence`, `keys`, `ephkeys` y `ping`/`pong` no existen en esta ruta — las claves viajan en el blob y la latencia no se mide en DMs.

**Contrato de UI (solo a nivel de contrato; detalles en la fase 3).** Entrada: «+ invitación» en la sección DM del sidebar y atajo en el banner de error de trackers; asistente con los dos roles (crear → copiar blob → el otro responde → pegar respuesta → conectar); al conectar se aterriza en la vista DM estándar con `DmHeader` mostrando fingerprint y aviso TOFU antes del primer mensaje, y los canales manuales se listan en `DmList` con el marcador «(sin sala)». Las cadenas vivirán en `settings/messages.ts`, con el focus-trap del asistente (`useFocusTrap`).

### 12.3 Nota: spike mixed-build de la acción `react` (issue #98)

**Estado: resuelto por análisis de fuente; el fallback temido no hace falta.** Antes de registrar `react` (7.1) se analizó el código de `@trystero-p2p/core` 0.25.4 (`node_modules/@trystero-p2p/core/dist/action-wire.mjs`) y se concluyó que una acción extra en los builds nuevos es inofensiva para los pares antiguos de la misma sala. Primero, el enrutado va POR NOMBRE, no por índice negociado: cada chunk de la wire incrusta el propio nombre de la acción, relleno a cero hasta 32 bytes en el offset 0, y no existe handshake alguno que asigne nombres a ids por conexión — un nombre nuevo no puede desplazar la codificación que un par antiguo parsea para sus acciones existentes (cada mensaje se autodescribe). Segundo, en recepción un nombre ausente del registro local se reensambla igualmente pero queda estacionado en `pendingActionPayloads` sin disparar handler ni lanzar error: un build antiguo ignora el tráfico `react` en silencio y sus acciones siguen enroutando intactas (las acciones internas de Trystero usan el prefijo `@_`, sin colisión posible con `react`). Residual aceptado: ese búfer de payloads no reclamados crece sin tope en el par antiguo (diseño propio de Trystero) — el tope de envío de 30 payloads por par y minuto y el tamaño cosmético del payload mantienen insignificante la contribución de builds honestos. Conclusión operada: `react` se registró como acción propia (7.1) y el fallback de la issue — dirigir las reacciones por el canal `receipt` — se descarta.

### 12.4 Nota de diseño: transferencia P2P de archivos por DataChannel (issue #103)

**Estado: implementado (issue #103).** Lo esbozado aquí está en producción: el motor —encuadre, ventana de crédito, topes, máquina de estados— vive en `lib/p2p/fileTransfer.ts`, el sellado binario de chunks en `lib/crypto/chunkCipher.ts` (`sealChunk`/`openChunk`, fase 2) y la UI (fase 4) en el diálogo de pre-envío del compositor, el puente `useFileTransfers` y la franja de tarjetas de consentimiento/progreso bajo el feed; el roomManager registra las cinco acciones y aplica la puerta de silenciado (issue #95) antes de cualquier parseo. Los cuatro puntos que la nota dejaba a la interpretación del motor quedaron así: el cable no distingue un chunk de sala con contraseña de uno de DM, así que el receptor prueba la clave de la sala y después la DM y la AUTENTICACIÓN GCM elige —ambas jamás autentican el mismo chunk; la ganadora se fija para el stream entero—; `file-end` sale justo tras DESPACHAR el último chunk (es la señal de «último despachado», no una barrera de acuses: el acuse final `nextSeq = chunks + 1` es el que completa al emisor); la ventana desliza por acuses que re-otorgan la ventana COMPLETA cuando el receptor agota la concedida (no un crédito por chunk); y un chunk con hueco se DESCARTA —disciplina contigua (`seq === contiguousNext`): repetidos, fuera de rango y huecos caen, y un stream roto muere por el stall de 30 s o por el fail-fast del `file-end`—. Lo que sigue es la nota de diseño aprobada que la implementación siguió. El transporte ya existe (los data channels de Trystero, 6.3) y la cripto es reutilizable (9.2, 9.3), de modo que un archivo hereda la confidencialidad de la conversación en que se envía en lugar de fiarse solo del DTLS. Alcance estricto de la v1: transferencia **dirigida 1:1** — el emisor ofrece el archivo a cada par por separado y solo quien ACEPTA recibe bytes; un «archivo para la sala» son N transferencias independientes, una por par que consiente. La difusión a toda la malla queda rechazada por partida doble: entregaría bytes a pares sin consentimiento y multiplicaría el tráfico por el tamaño de la sala (amplificación de malla) — los pares que declinan pagarían ancho de banda ajeno. Cada transferencia lleva su propia tarjeta de consentimiento, su ventana de crédito y su cancelación.

**Acciones nuevas (7.1).** Cinco acciones propias, todas dirigidas al par (`{target}`, como `dm`/`receipt` — la dirección es disciplina del EMISOR: Trystero no distingue en recepción un envío dirigido de una difusión, así que el receptor valida además cada payload contra SUS transferencias activas de ESE par y descarta entero y en silencio (7.3) el tráfico que no corresponda a una transferencia conocida):

- `file-meta {id, name, size, mime, chunks, enc}` — JSON: la oferta. Antes de la aceptación no fluye ni un byte.
- `file-chunk` — binario (`Uint8Array`): los datos, con el encuadre exacto de abajo.
- `file-ack {id, nextSeq, grant}` — JSON diminuto: el crédito del receptor (ventana de crédito, abajo). Es acción NUEVA, no una sobrecarga de `file-end`: mezclar control de flujo con cierre haría que el estado terminal dependiera de un campo opcional.
- `file-end {id}` — JSON: cierre del EMISOR («último chunk despachado»); el receptor lo usa para fallar rápido si le falta alguno, en vez de esperar el stall.
- `file-abort {id}` — JSON: cancelación de cualquiera de las partes o rechazo de la oferta.

Registro: las cinco se registran juntas en el bloque de acciones de `createConnection` (roomManager), tras `hist` y antes de `ping`/`pong`, en el orden `file-meta` → `file-chunk` → `file-ack` → `file-end` → `file-abort` (orden de lectura: oferta, datos, crédito, cierre). El orden NO es load-bearing: por el análisis de 12.3 las acciones enrutan por nombre y un build antiguo deja estacionados los payloads de nombres no registrados sin disparar handler — degradación silenciosa con builds mezclados, sin fallback.

**Contrato de validación de `file-meta` (`parseFileMeta`).** Cualquier violación descarta el payload ENTERO (7.3, disciplina receipt/react):

- `id` — string no vacío; clave de la transferencia en ambos extremos (el emisor usa `crypto.randomUUID()`; el receptor no exige formato UUID, solo no vacío).
- `name` — saneado con la disciplina del apodo remoto del issue #28 (fuera los mismos caracteres de control e invisibles, trim), con tope propio de 120 caracteres (`FILE_NAME_MAX_LENGTH`) — un nombre de archivo legítimo es más largo que un apodo. Si tras sanear no queda nada legible, el meta entero es inválido: el nombre ES la tarjeta de consentimiento y no tiene línea de respaldo.
- `size` — entero en 1..`MAX_FILE_BYTES` (20 MB). No entero, 0, negativo o sobre el tope → inválido.
- `chunks` — entero y EXACTO: `chunks = ceil(size / FILE_CHUNK_PAYLOAD_BYTES)`. La cuenta no la gobierna el emisor: el receptor la recalcula desde `size` y descarta el meta si difiere — cierra la puerta a «declaro pequeño, envío grande» y a su inverso.
- `mime` — string de ≤ 100 caracteres (`FILE_MIME_MAX_LENGTH`) sin caracteres de control ni invisibles (la misma clase del #28); el vacío es legítimo (un `File` sin tipo conocido llega con mime `''`). Jamás se confía en él: es display-only — ni la validación ni la seguridad dependen del mime declarado (el renderizado de imágenes de la fase 4 lo usa como pista de presentación, nunca como permiso).
- `enc` — booleano REQUERIDO, sin default: gobierna la ruta criptográfica de cada chunk; ausente o no booleano → inválido.

Tope de ofertas: `FILE_OFFER_RATE_CAP = 5` `file-meta` por par y minuto; el exceso se descarta en silencio (misma clase de mitigación que las reacciones en 9.5: la tarjeta cuesta atención, no memoria).

**Encuadre binario de `file-chunk`.** Frame exacto: `[8 B fileId ‖ uint32 BE seq ‖ payload ≤ 16 384 B]` — total ≤ 16 KiB + 12 bytes de cabecera (16 396 B), cómodamente bajo el tope de 64 KB de `MAX_PAYLOAD_BYTES` (7.3) incluso tras el encuadre de transporte de Trystero (nombre de acción relleno a 32 B más cabeceras por chunk de ~16 KiB: ~48 B más por chunk, 12.3).

- `fileId` — prefijo de 8 bytes = **los primeros 8 bytes del SHA-256 del `id` del meta** (UTF-8). El UUID v4 de 36 caracteres no cabe en 8 bytes y truncar la CADENA a 8 dejaría ~32 bits útiles (hex); el hash truncado reparte 64 bits uniformes. Con ≤ 3 transferencias concurrentes por par (ambos lados), el cumpleaños sobre ~6 identificadores en juego da p(colisión) ≈ 8×10⁻¹⁹ — despreciable por diseño, y el receptor además solo casa el prefijo contra sus transferencias activas de ese par.
- `seq` — uint32 big-endian, basado en 1: `1..chunks` (el último chunk lleva `size mod FILE_CHUNK_PAYLOAD_BYTES`, que jamás es 0: con `size` múltiplo exacto el último chunk va lleno). Fuera de rango o repetido → chunk descartado.
- `payload` — rebanada del archivo. La rebanada de TEXTO CLARO es `FILE_CHUNK_PAYLOAD_BYTES = 16 356` (16 KiB − 28 B de IV+etiqueta GCM) en AMBOS modos, de modo que `chunks` no depende del modo y el payload sellado cabe exacto en 16 KiB: en claro viaja tal cual (≤ 16 356 B) y sellado crece 28 B fijos (12 de IV + 16 de etiqueta) → ≤ 16 384 B. Un texto claro desunselado que exceda la rebanada invalida el stream; al completar los `chunks` chunks, la suma de texto claro debe ser EXACTAMENTE `size` — cualquier desviación → `failed`.

**Ventana de crédito (control de flujo receptor → emisor).** `FILE_CREDIT_WINDOW = 8` chunks sin acuse como máximo en vuelo. El receptor otorga la primera ventana al ACEPTAR — no hay acción de «aceptar» aparte: el primer `file-ack {id, nextSeq: 1, grant: 8}` ES la aceptación y arranca el flujo. En cada acuse, `nextSeq` es la siguiente secuencia esperada (todo lo anterior llegó contiguo) y `grant` son créditos nuevos (0..FILE_CREDIT_WINDOW; el receptor concede la ventana completa en cada acuse). Invariante del emisor: enviados sin acusar ≤ FILE_CREDIT_WINDOW; un chunk queda acusado cuando un `file-ack` anuncia `nextSeq > seq`. Cierre: al reunir los `chunks` chunks, el receptor emite el acuse final `{id, nextSeq: chunks + 1, grant: 0}` y el emisor pasa a `done` con él. Anti-bloqueo: `FILE_STALL_TIMEOUT_MS = 30_000` sin progreso ALGUNO (chunk nuevo en el receptor, acuse en el emisor) en `transferring` → `failed` en ambos extremos y liberación inmediata de lo acumulado. La oferta en sí no tiene timeout de cable: muere por decline explícito (`file-abort`), por caída del par o con la sesión (todo en memoria). Un chunk que exceda el crédito otorgado se DESCARTA — la ventana es el plan de memoria del receptor; un emisor honrado jamás lo hace y un violador sistemático agota el stall de 30 s. Chunks de transferencias desconocidas o no en `transferring` → descarte silencioso.

**Cifrado: sellar antes de encuadrar (seal-then-frame).** `meta.enc = true` (salas con contraseña: clave de sala de 9.3; DMs: clave DM v2 de 9.2) → el payload de CADA chunk viaja sellado con AES-GCM ANTES del encuadre: el tope de 16 KiB aplica POST-sellado (aritmética de arriba) y el frame queda fijo sea cual sea el modo. Formato binario del sellado: exactamente el de 9.3 paso 3 / 9.2 paso 4 sin la capa base64 — `bytes(IV ‖ ct)` con IV aleatorio de 12 B por chunk y etiqueta GCM de 16 B (la fase 2 añade las variantes binarias `sealChunk`/`openChunk`; las helpers actuales son string→base64 y no se reutilizan tal cual para no inflar el ~34% del base64 en binario). **Sin sal adicional**: las claves ya están atadas a la conversación (9.3: derivadas de contraseña+nombre; 9.2: dual-salt de las cuatro huellas) — reutilizarlas tal cual hereda sus garantías, y el IV aleatorio por chunk no necesita contador: con ≤ 1 283 chunks por transferencia (20 MB / 16 356) y ≤ 3 transferencias por par, la probabilidad de choque de un IV de 96 bits es del mismo orden despreciable que la de los mensajes de chat. Los metadatos del offer (`name`, `size`, `mime`) viajan en claro en `file-meta` — misma exposición que los apodos de `presence`; solo quien tenga la clave lee el CONTENIDO. Sellarse exigiría una v2 del protocolo de archivos: trabajo futuro. Salas públicas: `enc = false` → solo DTLS, con aviso explícito previo al envío (fase 4) y una tarjeta de consentimiento que muestra el estado: «cifrado con la clave de la sala» / «cifrado E2E con la clave DM» / «sin cifrado E2E — solo DTLS».

**Máquina de estados y reconexión.** Canónica por transferencia: `offer → accepted → transferring → done | aborted | failed`, con `rejected` como rama inmediata de la oferta. Las transiciones las dispara cada rol:

- Emisor: `offer` (meta enviado; espera el primer `file-ack` o un `file-abort`) → `accepted` (llega el primer acuse: consentimiento confirmado) → `transferring` (crédito activo, salen chunks; en la práctica el mismo instante) → `done` (acuse final `nextSeq = chunks + 1`) | `aborted` (`file-abort` del receptor — el rechazo de la oferta se ve aquí como `rejected` — o cancelación local, ambos con `file-abort` al otro lado) | `failed` (stall de 30 s, caída del par).
- Receptor: `offer` (tarjeta visible; NINGÚN byte fluye) → `rejected` (declinar: `file-abort` y liberar) | `accepted` (toque en aceptar) → `transferring` (sale el primer `file-ack` con la ventana) → `done` (chunks completos, suma exacta, Blob y object URL) | `aborted` (cancelación local o `file-abort` del emisor) | `failed` (chunk que excedería `size`, frame inválido, fallo GCM, stall de 30 s, caída del par).

Reconexión a mitad de transferencia: **falla la transferencia, sin reanudación** — offsets, ventanas y acumuladores viven en memoria por conexión, y reanudar exigiría estado persistido, contrario a la efimeridad total del producto. Documentado como limitación (la fase de docs lo lleva a §11 y README): el usuario vuelve a ofertar.

**Topes.** `MAX_FILE_BYTES = 20 × 1024 × 1024` (20 MB) — tope duro del RECEPTOR: un meta sobre el tope es inválido y un chunk cuyo texto claro empujaría el acumulado más allá de `size` aborta la transferencia EN EL PRIMER byte que excede, sin esperar el resto del chunk. `MAX_TRANSFERS_PER_PEER = 3` transferencias concurrentes por par, en AMBOS lados — la cuarta oferta simultánea de un mismo par se responde con `file-abort` (rechazo explícito, para que la UI del emisor diga «el par está ocupado» en vez de un silencio). Payload de chunk: 16 KiB post-sellado (16 356 B de claro). Nombre saneado y acotado a ≤ 120 caracteres. Presupuesto peor caso: 3 × 20 MB = 60 MB de RAM por par y dirección — el número que la QA ajustará.

**El spike de throughput de la issue se cierra aquí por aritmética de encuadre.** Los chunks viajan por LOS MISMOS data channels que el chat (estrategia torrent de Trystero) y cada `file-chunk` es una acción binaria propia de ≤ 16 396 B — independiente del cap de 64 KB de las acciones de chat, sin interacción de encuadre con los lotes `hist`. Cota conservadora: canales WebRTC fiables y ordenados; incluso a 200 KB/s un archivo de 20 MB completa en ~100 s (a 1 MB/s, ~20 s), y la ventana K=8 (~128 KiB de claro en vuelo) limita la presión de memoria, no el techo de velocidad. La fase 3 abre con la medición EN VIVO que pide la issue; si midiera lento, el margen del encuadre permite subir el payload hasta ~48 KiB cambiando SOLO constantes (el frame sigue cabiendo de sobra bajo los 64 KB) — contingencia anotada, sin re-decisión del diseño.

**Memoria y revocación: solo RAM.** El receptor acumula chunks en un array en memoria → `new Blob(partes)` al completar → `URL.createObjectURL`; el emisor jamás carga el archivo entero (`File.slice()` por chunk, fase 3). La URL se revoca (`revokeObjectURL`) al descartar la tarjeta `done`, al abortar o fallar (con lo acumulado parcial), con el pánico (RF-08) y al regenerar identidad (misma costura que los DMs manuales, 12.2); recargar lo pierde todo. Nada toca `localStorage` ni IndexedDB: el invariante de las cinco claves `gritos:*` (8.2) queda intacto — sin clave nueva, el pánico no necesita código adicional de borrado.

**Interacciones.**

- Silenciado (issue #95): las CINCO acciones de archivo de un par silenciado se descartan antes de cualquier parseo o efecto (misma puerta que `chat`/`dm`/`typing`: son contenido). Silenciar a un par con transferencia activa la aborta en el acto en local (con `file-abort` al otro lado): el contenido de un silenciado deja de acumularse de inmediato.
- TTL (issue #96): NO aplica a los archivos — no son filas del feed.
- Representación en el store (8.1): **mapa `fileOffers`, no fila del feed.** `fileOffers: Record<string, FileTransferRecord>`, con clave `${peerId}:${meta.id}` (el peerId de la contraparte evita que dos pares que eligen el mismo id colisionen), en memoria solo, jamás persistido. La decisión: el FIFO de 500 y el barrido TTL gobiernan MENSAJES y jamás deben revocar una URL ni expulsar un archivo a mitad de vista — la tarjeta de oferta/progreso/resultado vive y muere con su registro del mapa (oferta → done/rejected/aborted/failed → despido explícito del usuario). La fase 4 renderiza la tarjeta desde el mapa (posición en el feed y detalle visual son suyos) y, si añade filas de contexto al feed, serán display-only: la propiedad del blob, de la URL y de su revocación es SIEMPRE del mapa. Cero efectos de llegada: ninguna acción de archivo marca no leídos, notifica, acusa ni menciona (silencio de 7.3) — la tarjeta ES el aviso.

**No-goals.** **Ninguna transferencia se difunde a la sala** — dirigida 1:1 por par que acepta, jamás broadcast (consentimiento + amplificación). Sin reanudación (reconexión = `failed`). Sin directorios: un archivo plano por transferencia. Sin miniaturas: las imágenes se renderizan del blob recibido, solo tras completarse. Sin persistencia de nada (ni metadatos). Sin compresión y sin meta sellado (trabajo futuro, exigiría v2 del protocolo de archivos).

### 12.5 Nota de diseño: canal global de señalización — golpes por huella (issue #105)

**Estado: implementado (issue #105).** Lo esbozado aquí está en producción: las constantes y los validadores de payload viven en `lib/p2p/signalChannelConstants.ts` —su único hogar, junto a ningún otro módulo—, el gestor del enjambre en `lib/p2p/signalChannel.ts` (unión/salida atada a `Settings.globalDm` por suscripción al store de ajustes — el pánico RF-08 la recorre al resetear —, presencia LRU, presupuesto de golpes, puertas de silenciado y el transporte `dm`/`typing`/`receipt`), la interfaz `DmTransport` en `lib/p2p/dmTransport.ts` — los DOS respaldos, sala y señal, tras la misma superficie mínima — y el flujo de contacto (fase 3) en la entrada «+ contacto» de `DmList`: «Mi contacto» (huella copiable más QR `#contacto=<fp>`, maquinaria de #100) y «Contacto por huella» (pegar huella → golpe → espera cancelable), con las tarjetas de consentimiento bajo el área de chat. Los cuatro puntos que la nota dejaba a la interpretación de las fases quedaron así: los canales signal-backed viven en la MISMA porción `dms` del store (8.1) con la huella canónica como clave y el marcador aditivo `global: true` — el «(global)» hermano del «(sin sala)» manual —, y no colisionan con los de sala porque las claves son namespaces disjuntos (peerIds Trystero de ~46 caracteres contra 32 hex); los pins TOFU (8.2) solo se escriben al ABRIR canal — aceptar, enviar o recibir un `dm` —: la presencia sola jamás toca `gritos:tofu`, de modo que un barrido del enjambre no puede dejar un directorio de extraños persistido (la restricción de no-directorio vale también en disco); las tarjetas de consentimiento son NO bloqueantes — una franja `role="status"` bajo el área de chat, una por golpeador distinto (el último gana), jamás un modal que un spammer pueda abrir —; y la costura `onKnockResolved` resuelve UNA vez por golpe con acuse, DESPUÉS de abrir el canal — un golpe sin acuse (el par se fue, el ack se perdió) jamás resuelve: el diálogo de espera queda cancelable, sin timeout de cable (limitación documentada de la costura) —. Lo que sigue es la nota de diseño aprobada que la implementación siguió. La restricción de producto que manda sobre todo lo demás: el canal es tonto — existe solo para que dos huellas se encuentren cuando AMBOS lados optaron, transporta golpes y claves, jamás contenido de conversación, y **no** constituye un directorio global de presencia.

**El enjambre de señalización (fase 2).** Sala derivada como cualquier otra (9.4) a partir de UNA constante, `SIGNAL_ROOM_NAME = '_gritos/senal/v1'`, definida en un único lugar (`lib/p2p/signalChannelConstants.ts`): `deriveSignalRoomId()` = `deriveRoomId(SIGNAL_ROOM_NAME)`, con la misma asincronía del hash. Solo lo ven los builds que compartan `VITE_TRYSTERO_APP_ID` (issue #90; 9.4): el appId es el espacio de descubrimiento, así que forks y auto-alojamientos tienen canales globales disjuntos sin código nuevo. El nombre es inalcanzable por la UI de salas — el juego de caracteres de RF-02 (`[a-z0-9_-]`) excluye la `/`—: nadie entra al canal por el popover de unión, solo el gestor de señal lo une. La degradación mixed-build no aplica por construcción: un build sin el ajuste (o anterior a #105) jamás se une — no hay par antiguo DENTRO del enjambre, y una acción desconocida entre pares del canal se resuelve con la conclusión del spike de 12.3 (el payload queda estacionado sin handler, sin error).

**Acciones del enjambre (contrato de la fase 2).** Tres propias, más las dos de claves que reutilizan el molde de sala tal cual:

- `whoami {nick, fp}` — difusión al conectar y al cambiar apodo: la presencia del canal (el molde de `presence`, 7.1).
- `knock {type:'knock', from:{fp, nick}, note?}` — **dirigido** al par destino: la puerta. Sin campo de contenido: la nota opcional de ≤ 140 caracteres (`NOTE_MAX_LENGTH`) es TODO lo que un golpe puede decir.
- `knock-ack {accept, fp}` — **dirigido** de vuelta al golpeador: `accept` es el consentimiento y `fp` es la huella del golpe que se acusa (la del golpeador, eco del `from.fp` recibido) — el golpeador puede estar esperando varios acks y casa el suyo por huella.
- `keys` / `ephkeys` — anuncio como en sala (7.1): la resolución de claves del DM respaldado por señal es EXACTAMENTE la derivación v2 de 9.2, con la efímera anunciada EN el enjambre de señal; el ancla TOFU sigue siendo la huella de identidad (8.2) y el `fp` autodeclarado de `whoami`/`knock` es orientativo, igual que el de `presence` en sala.

**Contrato de validación (disciplina `parseReact`/`parseHistReq`; 12.4).** Cualquier violación descarta el payload ENTERO y en silencio (7.3) — jamás solo el campo:

- `parseKnock` — objeto plano con `type` EXACTO `'knock'`; `from` objeto con `fp` en forma canónica (la regla de la issue #95: `canonicalFingerprint` → exactamente 32 hex; se guarda normalizado) y `nick` que sobreviva íntegro el saneamiento del apodo remoto (issue #28): si no queda nada legible el golpe entero es inválido — el apodo ES la tarjeta de consentimiento, sin línea de respaldo (misma razón que el `name` de `file-meta`); `note`, cuando existe, es un string de ≤ 140 caracteres EN BRUTO (el exceso es entrada hostil: el honrado jamás rellena) saneado con la misma clase #28 — una nota que queda vacía tras sanear se trata como ausente (el campo es opcional y carece de semántica de protocolo).
- `parseWhoami` — `{nick, fp}` con las mismas reglas de `fp` canónico y `nick` legible; la lista de presencia no tiene fila de respaldo por peerId (no es el listado de una sala: es el estado mínimo para resolver golpes y claves).
- `parseKnockAck` — `{accept, fp}`: `accept` booleano REQUERIDO sin default (gobierna la apertura del canal) y `fp` canónico — el del golpe acusado; un ack que no casa con un golpe propio pendiente se descarta en la capa del gestor (fase 2).

**Topes (la fase 2 los implementa).** `MAX_SIGNAL_PRESENCE = 100` entradas de presencia con expulsión LRU — la 101.ª evapora la más vieja vista; es estado del motor, jamás un listado navegable en la UI: el único camino de descubrimiento es el golpe por huella. `KNOCK_RATE_CAP = 5` golpes RECIBIDOS por par y minuto; el exceso se descarta en silencio (misma clase de mitigación que `FILE_OFFER_RATE_CAP` en 12.4). Los re-anuncios de presencia no son periódicos: solo conexión y cambio de apodo, como `presence` en sala (7.1) — un par ruidoso no encuentra acción para serlo.

**Ciclo de vida ligado al ajuste.** Unirse y salir están estrictamente atados a `Settings.globalDm: boolean` — **default false** —, que vive dentro de `gritos:settings` (8.2: sin séptima clave; el pánico RF-08 lo borra como el resto del ajuste). El toggle entra en Ajustes → Privacidad (fase 2). Apagarlo deja el enjambre EN EL ACTO (`leave`) y destruye TODO el estado del canal en memoria — presencia, presupuesto de golpes, acks pendientes — y cualquier canal DM respaldado por él (misma costura que `abortAllManualDms` en 12.2; los canales afectados pasan a «The peer has disconnected», RF-04). Encenderlo vuelve a unir y re-anunciar. Ninguno de los dos estados toca persistencia alguna: el canal global no añade NADA a `localStorage` (invariante de las cinco claves, 8.2).

**DmTransport (refactor de la fase 2).** Una interfaz mínima de la que cuelgan los DOS respaldos posibles de un `DmChannel` (8.1) — el enjambre de sala (hoy) y el de señal (nuevo) —, de modo que la UI y el store ignoren la diferencia: `sendDm(envelope)` (el sobre `dm` v:2 sellado de 9.2, dirigido), `sendTyping(on)` y `sendReceipts(ids)` (7.1 tal cual), `available` (el estado «par desconectado» de RF-04) y la resolución de claves — la derivación v2 SIN cambios (9.2): identidad y efímera anunciadas en el enjambre que respalda el canal, dual-salt y TOFU intactos. Los canales signal-backed se dirigen por HUELLA — el peerId del enjambre es efímero por sesión y la huella es LA dirección del producto (9.1), precedente del keying `manual:<huella>` de 12.2 — y alimentan la MISMA porción `DmChannel` del store: en `DmList` llevan el marcador «(global)» (hermano del «(sin sala)» de 12.2) mediante un booleano aditivo al estilo de `manual?`.

**Flujo de contacto (contrato de la fase 3).** Dos entradas:

- **«Mi contacto»** comparte TU huella: copia al portapapeles desde ya, y QR por la maquinaria de #100 (10.8) con un parámetro de hash nuevo, `#contacto=<fp>` — MISMA disciplina que `#sala=`: `#` inicial opcional, decodificación percentual tolerada, y el valor es la huella en forma canónica (32 hex; los espacios de la forma de pantalla se toleran y se canonicalizan con la regla de la issue #95) —, jamás apodo ni contraseña; un valor que no canonicalice a 32 hex no enruta. Como todo enlace de la app, solo sirve dentro de esta misma instalación (mismo origen y mismo appId, 10.8).
- **«Contacto por huella»**: pegar una huella → buscarla en la presencia del canal → `knock` → tarjeta de consentimiento en el destino: «@nick quiere abrir un DM contigo — [Aceptar] [Rechazar] [Silenciar]». Aceptar responde `knock-ack {accept: true}` y AMBOS lados abren el canal signal-backed. Rechazar responde `accept: false` y **no recuerda al rechazado** — sin almacén de contactos: estado por sesión, coherente con la efimeridad (D2); la lista de silenciados (issue #95) SÍ persiste y silencia al golpeador (puerta de 12.4: el knock de un par silenciado se descarta antes de parsear). «Silenciar» hace ambas cosas a la vez: `accept: false` más el mute persistente.

**§9.5 (honestidad del modelo de amenazas).** Recogido EN 9.5: unirse al canal global expone IP, huella y apodo ante cada par opt-in; el default-off es la mitigación documentada, y un golpe revela el interés del golpeador — inherente.

**No-goals.** El canal jamás lleva contenido — ni un «hola» disimulado en `note`: la conversación solo existe tras el consentimiento, dentro del DM E2EE. Sin directorio navegable de pares globales en la UI. Sin cuentas, emails ni usernames: la única dirección es la huella (9.1). Sin sharding en v1: un solo enjambre; si la popularidad lo impone, N salas de señal elegidas por hash de huella es el trabajo futuro esbozado en la issue.

---

## Apéndice A · Glosario

| Término                     | Definición                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Tracker**                 | Servidor WebSocket público del ecosistema WebTorrent que facilita el _discovery_ y el intercambio SDP inicial. |
| **roomId**                  | Hash derivado que identifica una sala ante los trackers (9.4).                                                 |
| **peerId**                  | Identificador aleatorio que Trystero asigna a cada cliente por sesión.                                         |
| **fingerprint**             | Hash corto de la clave pública de un par; verificación manual de identidad (TOFU).                             |
| **Clave efímera de sesión** | Par ECDH P-256 vivo solo durante la sesión de la app, en memoria; base de la derivación DM v2 (9.2, 12.1).     |
| **Full mesh**               | Topología donde cada cliente mantiene DataChannel directo con todos los demás pares de la sala.                |
| **E2EE**                    | Cifrado de extremo a extremo aplicado sobre el payload, además del DTLS del transporte.                        |
| **Panic button**            | Borrado total e inmediato de identidad, ajustes y rastro local (RF-08).                                        |
