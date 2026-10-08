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
- Privacidad: regeneración de identidad y _panic button_.
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
- Cap de memoria: se retienen como máximo los últimos **500 mensajes por sala** (descarte FIFO, avisando en el feed con un separador "— mensajes anteriores descartados —").
- Reloj: cada mensaje muestra hora local `HH:MM` a partir de `ts` del autor.

### RF-04 · Mensajes directos (DM) con E2EE

Conversación privada 1:1 con cualquier par con el que se comparta al menos una sala activa.

**Aceptación**

- Desde la lista de pares de una sala, clic en un par → "Mensaje directo". Se abre la conversación DM (vista tipo sala, encabezado con el apodo del otro y su _fingerprint_).
- Todos los mensajes DM viajan cifrados E2EE (sección 9.2); nadie más —ni otros pares de la sala compartida— puede descifrarlos.
- El encabezado del DM muestra el fingerprint del par (formato de sección 9.1) con el aviso "Compáralo con tu interlocutor para verificar su identidad".
- Los DMs heredan Markdown, typing, receipts, scroll inteligente y cap de 500 mensajes.
- Badge de no leídos por DM; los DM no leídos se notifican (RF-09) cuando la pestaña está oculta.
- Un DM deja de poder enviar mensajes si el par abandona todas las salas compartidas: estado "El par se ha desconectado" y el historial del DM permanece visible en memoria hasta recargar.
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
- Entrada/salida de pares se refleja en el feed con líneas de sistema discretas ("— luna-cauta se ha unido —").

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

| Acción (`makeAction`) | Alcance                                         | Payload                                                               | Uso                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence`            | broadcast (al conectar y al cambiar apodo)      | `{nick: string, fp: string}`                                          | Anuncio de apodo y fingerprint.                                                                                                                                                                                                                                                                                                   |
| `keys`                | broadcast (al conectar)                         | `Uint8Array` (clave pública ECDH P-256 cruda, 65 B)                   | Anuncio de la clave de identidad: fingerprint visible en la UI, ancla TOFU (8.2) y una de las dos parejas de fingerprints de la sal DM v2 (9.2).                                                                                                                                                                                  |
| `ephkeys`             | dirigido (al conectar y al regenerar identidad) | `Uint8Array` (clave pública efímera de sesión ECDH P-256 cruda, 65 B) | Anuncio de la clave efímera de sesión para la derivación DM v2 (issue #93; 9.2, 12.1). Vive solo en memoria, jamás se persiste y no se fija por TOFU: `gritos:tofu` sigue anclando solo fingerprints de identidad (8.2). Un par conectado sin este anuncio es un build v1 (12.1).                                                 |
| `chat`                | broadcast                                       | `Envelope` JSON                                                       | Mensaje de sala (plano o cifrado por contraseña).                                                                                                                                                                                                                                                                                 |
| `dm`                  | dirigido al destinatario (`target`, issue #18)  | `Envelope` JSON (`kind:'dm'`, siempre cifrado)                        | Mensaje directo E2EE entre A↔B: el sobre cifrado solo llega al destinatario — el resto de la malla de la sala no lo captura, evitando el perfilado por metadatos (quién escribe a quién, volumen, tiempos). El filtro local del `to` en el receptor (7.3) queda como defensa en profundidad ante pares antiguos que aún difunden. |
| `typing`              | broadcast                                       | `{on: boolean}`                                                       | Indicador de escritura.                                                                                                                                                                                                                                                                                                           |
| `receipt`             | dirigido al autor                               | `{ids: string[]}`                                                     | Acuse de recibo (batch, máx. 50 ids).                                                                                                                                                                                                                                                                                             |
| `ping`                | dirigido por par                                | `{t: number}`                                                         | Marca temporal del emisor.                                                                                                                                                                                                                                                                                                        |
| `pong`                | dirigido                                        | `{t: number}`                                                         | Eco del `t` recibido → RTT = ahora − t.                                                                                                                                                                                                                                                                                           |

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
}
```

### 7.3 Reglas del protocolo

- **Deduplicación**: todo mensaje con `id` ya visto se descarta (los receipts batch y la malla completa pueden duplicar).
- **Orden**: se muestra por orden de llegada; dentro de una ventana de 2 s se ordena por `ts`. No hay orden global consensuado (sin servidor) — documentado como limitación aceptable para chat informal.
- **Tamaño**: cuerpo ≤4000 caracteres en claro; payloads binarios >64 KB se descartan por seguridad.
- **Desconexión**: `onPeerLeave` limpia presencia y typing del par en esa sala; sus DMs quedan en modo "par desconectado".
- **Compatibilidad y versionado**: los campos desconocidos del Envelope se ignoran; `v` es discriminatorio por `kind` — `chat` exige `v: 1` y `dm` exige `v: 2` (issue #93) — y cualquier otro valor se descarta en silencio. En salas con builds mezclados, un par v1 descarta en silencio los `dm` v2 y un par nuevo los `dm` v1, en ambas direcciones, hasta que las builds convergen (12.1).
- **Silencio**: jamás se retransmite un mensaje recibido a terceros (no hay relay en v1; el `to` de un `dm` ajeno se ignora y se descarta).

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
}

interface DmChannel {
  peerId: string
  peerNick: string
  messages: Message[] // cap 500 FIFO
  unread: number
  available: boolean // false si no comparte ninguna sala
}

interface AppState {
  identity: Identity | null
  rooms: Record<string, Room> // key: room.id
  activeView: { kind: 'room'; id: string } | { kind: 'dm'; peerId: string } | null
  dms: Record<string, DmChannel> // key: peerId
  recentRooms: string[] // solo nombres
}
```

### 8.2 Claves de `localStorage` (única persistencia de v1)

| Clave             | Contenido                                                                                                                                  | Se borra con panic |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `gritos:settings` | `Settings` (JSON)                                                                                                                          | ✅                 |
| `gritos:identity` | `{nickname, fingerprint, createdAt, pubJwk, priv}` (JSON) — `priv` es un sobre cifrado (issue #24), nunca la JWK privada en claro          | ✅                 |
| `gritos:rooms`    | `{recent: string[]}` — solo nombres si `rememberRooms`; nunca nombres de salas con contraseña (issue #31: el alta las excluye y las purga) | ✅                 |
| `gritos:ui`       | `{sidebarCollapsed: boolean}`                                                                                                              | ✅                 |
| `gritos:tofu`     | `{peerId: fingerprint}` — primera huella vista por par; detecta la rotación de claves (issue #22, TOFU)                                    | ✅                 |

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

1. Cada par genera un par ECDH P-256 **efímero por sesión de la app** al arrancar (y lo regenera con la identidad): vive solo en memoria, jamás se persiste —ni `localStorage` ni el almacén IndexedDB— y lo borra el panic button (RF-08). Su clave pública cruda (65 B) se anuncia con la acción dirigida `ephkeys` al conectar y tras regenerar identidad (7.1).
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
- Plano de control sin autenticar (issue #36): las señales ajenas al contenido del chat —confirmaciones `receipt` (los ✓✓), «escribiendo…» (`typing`), líneas de sistema «se ha unido / ha salido» y ecos `pong` de latencia— viajan sin autenticación de mensaje, de modo que cualquier par puede forjarlas (marcar entregados mensajes ajenos, fingir que escribe, emitir líneas de sistema con apodos arbitrarios —que además desplazan historial real por el FIFO de 500 mensajes— o inflar los puntos de latencia) o inundar el chat para saturar insignias de no leídos y notificaciones de mención. Es inherente a la malla sin confianza de v1 —misma raíz que la suplantación de apodo, más arriba—; la mitigación de v1 es cosmética: tope de líneas de sistema por par y minuto, y descarte de RTT negativos y acotado de RTT absurdos en el eco `pong`.
- Compromiso del dispositivo o del origen (XSS): la clave privada se guarda cifrada en reposo (issue #24), pero un script del propio origen tiene acceso a `localStorage` **y** a IndexedDB, por lo que un contexto totalmente comprometido sigue pudiendo usar la clave (suplantar al usuario). Mitigación: la envoltura eleva el listón frente a volcados ingenuos de `localStorage` (extensiones con permisos de lectura, acceso físico al disco); contra el compromiso del propio origen no hay defensa local. El renderer Markdown propio con tests de XSS y la superficie mínima de dependencias siguen siendo la primera barrera.
- Metadatos: los pares conectados ven tu IP (naturaleza de WebRTC); usar TURN mitiga parcialmente.
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
  - Sección _Pares_ de la vista activa: apodo, punto de latencia, clic → menú (Mensaje directo / Copiar fingerprint).
- **Área principal**: encabezado (nombre con `#`, 🔒 si aplica, estado, nº de pares, ajustes), feed, barra de entrada.
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
- Separadores de sistema discretos para uniones/salidas y para el cap FIFO.
- Entrada: textarea auto-creciente (máx. 6 líneas), contador de caracteres a partir de 3800/4000, ayuda contextual de Markdown (`**negrita** · *cursiva* · \`código\``).
- Los mensajes propios se alinean a la derecha con `✓`/`✓✓` atenuado.

### 10.5 Notificaciones

- Título: "gritos — mención en #general" o "gritos — DM de luna-cauta".
- Cuerpo: "zorro-bravo: hola @ti…". Clic → foco + apertura de la vista origen.

### 10.6 Temas

- Tailwind con estrategia `class` (`dark` en `<html>`); `system` observa `prefers-color-scheme` en vivo.
- Transición de tema suave (150 ms); sin flash al cargar (script inline mínimo que aplica la clase antes del bundle).

## 11. Limitaciones conocidas (visibles o documentadas en la UI)

1. **Full mesh**: óptimo 6–15 pares por sala; a partir de ~20 la malla degrada (más salas activas multiplican el efecto). El cap de salas (≤6) y el de mensajes (500) mitigan memoria/CPU.
2. **Dependencia de trackers públicos**: si todos caen, no se descubren pares nuevos (los ya conectados siguen). Ajuste de trackers alternativos disponible (RF-07).
3. **NAT simétrica / firewalls corporativos**: sin TURN el P2P directo puede fallar. Se ofrece configuración de STUN/TURN propia; sin TURN garantizado, la conexión no se promete.
4. **Pestaña activa**: en segundo plano profundo el navegador ralentiza timers (pings degradados); al volver al frente se recuperan.
5. **Sin servidor**: sin historial para quien entra tarde (D2), sin entrega a pares desconectados, sin push real (las notificaciones solo ocurren con la pestaña abierta, aunque oculta).
6. **Pestañas múltiples del mismo navegador**: cada pestaña es un par distinto; funciona, pero se verá el propio apodo duplicado con sufijo.
7. **DMs solo entre pares con sala compartida**: no existe canal global de señalización para DMs arbitrarios (fase 2).
8. **Orden de mensajes no global** (7.3) y **apodos no únicos** (RF-06): aceptados para v1.

## 12. Roadmap de fase 2 (fuera de v1, priorizable)

1. Transferencia P2P de archivos/imágenes por DataChannel (chunking, backpressure, progreso, reconstrucción).
2. Sincronización de historial entre pares (_gossip_) opt-in: retransmisión de últimos N mensajes a nuevos participantes.
3. Canal global de DMs (sala de señalización dedicada) para DMs sin sala compartida.
4. Salas masivas: topología de retransmisión o SFU.
5. PWA (service worker, iconos, offline shell).
6. i18n y mensajes editables/borrables.
7. Secrecía hacia delante en DMs (issue #25; nota de diseño en 12.1): **el mínimo está implementado** (issue #93) — claves DM efímeras por sesión (9.2); queda como trabajo futuro la solución completa: _prekeys_ + _double ratchet_ (fase B del issue).

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
